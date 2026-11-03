// ダッシュボード（/）のシフト・作業の読み取り（04「ダッシュボードに出すもの（シフト・作業）」の読むもの、notes/T20.md「画面の約束」10。
// T20・D-52・D-56）。読み取りとキーだけの軽いモジュール：/ の先読み（lib/data/screen-queries.ts の planHomePrefetch。ルートのレイアウトが
// 読む）からも使えるように、組み立て（lib/modules/shifts/portal.ts）とダッシュボードの型と関数（lib/modules/portal.ts）を実行時に import
// しない（お知らせの notices/latest.ts・締切と予定の calendar/dated.ts と同じ形。型だけの import はよい）。
// - 総務の全員：自分の割り当て（時間枠の開始・終わりと持ち場の名前）と、自分が担当の完了でない作業（題名・状態・締切）を、year_roles の
//   自分の行に埋め込んで1本で読む（割り当てと作業の両方が year_roles に外部キーを持つ）。
// - 部門長以上は加えて、その年度の時間枠ごとのます（必要人数と、割り当てた人とそのロール）と、作業の全部（状態・締切・担当者とそのロール）。
//   3本を並行に読む（総務部門員はほかの人のロールを読めないので、ロールを埋め込む読み取りは部門長以上だけ）。
// どれも年度の全部を読む（日付で絞らない。/ の記録・先送りの URL が日ごとに変わらないように。T18 と同じ）。自分の user_id はセッション
// から取る（PortalContext を変えない。キーに入れない）。
import type { Enums } from '@gaapp/shared';
import { queryOptions } from '@tanstack/react-query';
import { fetchAll, type PageResult } from '@/lib/db/fetch-all';
import { toAppError } from '@/lib/errors';
import { getSupabase, type AppSupabaseClient } from '@/lib/supabase/client';
import { portalQueryKey } from '../query-key';
import { sessionUserId } from './reads';

/** 読む段：部門長以上（lead）・総務部門員（staff） */
export type ShiftsTier = 'lead' | 'staff';

/** 総務の全員の読み取り（year_roles の自分の行に、割り当てと完了でない作業を埋め込む） */
export const SHIFTS_PORTAL_MINE_SELECT =
  'user_id, shift_assignments(slot_id, duty_id, shift_needs(shift_slots(starts_at, ends_at), shift_duties(name))), tasks(id, title, status, due_at)';
/** 部門長以上：時間枠ごとのます（必要人数と、割り当てた人のロール） */
export const SHIFTS_PORTAL_SLOTS_SELECT = 'id, starts_at, ends_at, shift_needs(duty_id, required_count, shift_assignments(user_id, year_roles(role)))';
/** 部門長以上：その年度の作業の全部（状態・締切・担当者とそのロール） */
export const SHIFTS_PORTAL_TASKS_SELECT = 'id, title, status, due_at, assignee_id, year_roles(role)';

type TaskStatus = Enums<'task_status'>;
type AppRole = Enums<'app_role'>;

/** 自分の割り当て（時間枠と持ち場の名前） */
export interface PortalMyAssignment {
  slot_id: string;
  duty_id: string;
  shift_needs: { shift_slots: { starts_at: string; ends_at: string } | null; shift_duties: { name: string } | null } | null;
}

/** 自分が担当の完了でない作業 */
export interface PortalMyTask {
  id: string;
  title: string;
  status: TaskStatus;
  due_at: string | null;
}

/** 部門長以上：時間枠ごとのます */
export interface PortalSlot {
  id: string;
  starts_at: string;
  ends_at: string;
  shift_needs: { duty_id: string; required_count: number; shift_assignments: { user_id: string; year_roles: { role: AppRole } | null }[] }[];
}

/** 部門長以上：作業 */
export interface PortalTask {
  id: string;
  title: string;
  status: TaskStatus;
  due_at: string | null;
  assignee_id: string | null;
  year_roles: { role: AppRole } | null;
}

/** 読んだ行（select の前。lib/modules/shifts/portal.ts の shiftsPortal が組み立てる） */
export interface ShiftsPortalRaw {
  tier: ShiftsTier;
  userId: string;
  /** 自分の割り当てと、自分が担当の完了でない作業（自分の year_roles の行がなければ空） */
  mine: { assignments: PortalMyAssignment[]; tasks: PortalMyTask[] };
  /** 部門長以上だけ（総務部門員は null） */
  slots: PortalSlot[] | null;
  /** 部門長以上だけ（総務部門員は null） */
  tasks: PortalTask[] | null;
}

interface MineRow {
  user_id: string;
  shift_assignments: PortalMyAssignment[] | null;
  tasks: PortalMyTask[] | null;
}

/** 総務の全員の読み取り（自分の year_roles の行。作業は完了でないものだけを埋め込む） */
async function loadMine(yearId: string, userId: string, client: AppSupabaseClient): Promise<ShiftsPortalRaw['mine']> {
  const res = await client
    .from('year_roles')
    .select(SHIFTS_PORTAL_MINE_SELECT)
    .eq('year_id', yearId)
    .eq('user_id', userId)
    .neq('tasks.status', 'done')
    .maybeSingle();
  if (res.error) throw toAppError(res.error, res.status);
  const row = res.data as unknown as MineRow | null;
  return { assignments: row?.shift_assignments ?? [], tasks: row?.tasks ?? [] };
}

/**
 * ダッシュボードのシフト・作業の読み取り（総務の全員は1本、部門長以上は3本を並行）。user_id を渡さなければセッションから取る。
 * 読めなければ AppError を投げる。
 */
export async function loadShiftsPortal(
  yearId: string,
  tier: ShiftsTier,
  client: AppSupabaseClient = getSupabase(),
  userId?: string,
): Promise<ShiftsPortalRaw> {
  const me = userId ?? (await sessionUserId(client));
  if (tier === 'staff') return { tier, userId: me, mine: await loadMine(yearId, me, client), slots: null, tasks: null };
  const [mine, slots, tasks] = await Promise.all([
    loadMine(yearId, me, client),
    fetchAll<PortalSlot>(
      (from, to) =>
        client
          .from('shift_slots')
          .select(SHIFTS_PORTAL_SLOTS_SELECT)
          .eq('year_id', yearId)
          .order('starts_at')
          .order('id')
          .range(from, to) as unknown as PromiseLike<PageResult<PortalSlot>>,
    ),
    fetchAll<PortalTask>(
      (from, to) =>
        client.from('tasks').select(SHIFTS_PORTAL_TASKS_SELECT).eq('year_id', yearId).order('id').range(from, to) as unknown as PromiseLike<
          PageResult<PortalTask>
        >,
    ),
  ]);
  return { tier, userId: me, mine, slots, tasks };
}

/**
 * ダッシュボードのクエリ（lib/modules/shifts/portal.ts の shiftsPortalProvider が select を足す。/ の先読み〔planHomePrefetch〕と
 * /calendar の機能の日付も同じキャッシュ）。キー：`portalQueryKey(yearId, 'shifts', 'soumu', tier)`。
 *
 * @example
 * shiftsPortalOptions(yearId, isLead(role) ? 'lead' : 'staff')
 */
export function shiftsPortalOptions(yearId: string, tier: ShiftsTier) {
  return queryOptions({
    queryKey: portalQueryKey(yearId, 'shifts', 'soumu', tier),
    queryFn: () => loadShiftsPortal(yearId, tier),
  });
}
