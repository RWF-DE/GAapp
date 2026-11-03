// 自分のシフト（/shift）と作業一覧（/tasks）を開いたときに読むもの（04「自分のシフト」「作業一覧」の読むもの・「共通レイアウト」の
// シフト・作業の読み込み、notes/T20.md「画面の約束」2・11。T20・D-56）。読み取りとキーだけの軽いモジュール：先読み
// （lib/data/screen-queries.ts の SCREEN_PREFETCH。ルートのレイアウトが読む）からも使うので、書き込み・組み立て・zod・画面の部品を
// 読まない（お知らせの notices/latest.ts・締切と予定の calendar/dated.ts と同じ形）。画面（components/shifts・components/tasks）も
// 同じクエリの設定を使い、先読みしたキャッシュをそのまま使う。lib/data/shifts.ts・tasks.ts が同じ名前で出し直す。
// - 読める範囲は RLS が決める（5表はその年度の総務だけ。profiles は自分が総務である年度のメンバー。year_roles は部門長以上が年度の全部）。
// - 自分の user_id は queryFn の中でセッションから取る（キーに入れない。利用者が変わるとキャッシュを消す）。
// 版（allocation_version）は使わない（シフト・作業は振り分けの入力でない）。
import type { Enums } from '@gaapp/shared';
import { queryOptions } from '@tanstack/react-query';
import { fetchAll, type PageResult } from '@/lib/db/fetch-all';
import { appError, toAppError } from '@/lib/errors';
import { queryKeys } from '@/lib/query';
import { getSupabase, type AppSupabaseClient } from '@/lib/supabase/client';

// ---------------------------------------------------------------- 自分の user_id

/**
 * セッションの user_id（supabase-js の getSession。localStorage を読むだけで、期限が近ければ更新する）。ログインしていなければ
 * AppError（auth）を投げる。
 */
export async function sessionUserId(client: AppSupabaseClient = getSupabase()): Promise<string> {
  const { data, error } = await client.auth.getSession();
  const id = data.session?.user.id;
  if (error || !id) throw appError('auth', 'no_session');
  return id;
}

// ---------------------------------------------------------------- 自分のシフト /shift

/** 自分の割り当ての select（時間枠・持ち場〔名前・場所・説明〕・同じますの人を埋め込む） */
export const MY_SHIFTS_SELECT =
  'slot_id, duty_id, updated_at, shift_needs(required_count, shift_slots(id, starts_at, ends_at), shift_duties(id, name, place, note), shift_assignments(user_id))';

/** 自分の割り当ての1行 */
export interface MyShiftRow {
  slot_id: string;
  duty_id: string;
  updated_at: string;
  /** ます（外部キーの埋め込み。RLS で読めないときは null） */
  shift_needs: {
    required_count: number;
    shift_slots: { id: string; starts_at: string; ends_at: string } | null;
    shift_duties: { id: string; name: string; place: string | null; note: string | null } | null;
    /** 同じますの人（自分を含む） */
    shift_assignments: { user_id: string }[];
  } | null;
}

/** その年度の自分の割り当てを読む（year_id と user_id で絞る。年に数十件の見込みなので1回で読む） */
export async function loadMyShifts(yearId: string, client: AppSupabaseClient = getSupabase(), userId?: string): Promise<MyShiftRow[]> {
  const me = userId ?? (await sessionUserId(client));
  const res = await client.from('shift_assignments').select(MY_SHIFTS_SELECT).eq('year_id', yearId).eq('user_id', me).order('slot_id');
  if (res.error) throw toAppError(res.error, res.status);
  return (res.data ?? []) as unknown as MyShiftRow[];
}

/** 自分の割り当てのクエリ（キーは `['year', yearId, 'shifts', 'mine']`） */
export function myShiftsOptions(yearId: string | null | undefined) {
  return queryOptions({
    queryKey: queryKeys.yearPart(yearId ?? '', 'shifts', 'mine'),
    queryFn: () => loadMyShifts(yearId!),
    enabled: !!yearId,
  });
}

// ---------------------------------------------------------------- 表示名

/** 表示名の1行 */
export interface NameRow {
  user_id: string;
  display_name: string;
}

/**
 * 表示名を読む（profiles。RLS が返すもの全部：自分と、自分が総務である年度のメンバー。割り当て・作業と並行に読むため id で絞らない。
 * 年度に 100 人ほどの見込み。user_id の順に fetchAll）
 */
export async function loadSoumuNames(client: AppSupabaseClient = getSupabase()): Promise<NameRow[]> {
  return fetchAll<NameRow>(
    (from, to) =>
      client.from('profiles').select('user_id, display_name').order('user_id').range(from, to) as unknown as PromiseLike<PageResult<NameRow>>,
  );
}

/** 表示名のクエリ（キーは `['year', yearId, 'shifts', 'names']`。年度ごとに持つ〔年度を切り替えたら読み直す〕） */
export function soumuNamesOptions(yearId: string | null | undefined) {
  return queryOptions({
    queryKey: queryKeys.yearPart(yearId ?? '', 'shifts', 'names'),
    queryFn: () => loadSoumuNames(),
    enabled: !!yearId,
  });
}

// ---------------------------------------------------------------- ロールの一覧（部門長以上）

/** ロールの1行 */
export interface MemberRow {
  user_id: string;
  role: Enums<'app_role'>;
}

/** その年度のロールの一覧を読む（year_roles。部門長以上は年度の全部を読める。総務部門員には自分の行だけが返る） */
export async function loadShiftMembers(yearId: string, client: AppSupabaseClient = getSupabase()): Promise<MemberRow[]> {
  return fetchAll<MemberRow>(
    (from, to) =>
      client.from('year_roles').select('user_id, role').eq('year_id', yearId).order('user_id').range(from, to) as unknown as PromiseLike<
        PageResult<MemberRow>
      >,
  );
}

/** ロールの一覧のクエリ（キーは `['year', yearId, 'shifts', 'members']`。部門長以上だけが使う） */
export function shiftMembersOptions(yearId: string | null | undefined) {
  return queryOptions({
    queryKey: queryKeys.yearPart(yearId ?? '', 'shifts', 'members'),
    queryFn: () => loadShiftMembers(yearId!),
    enabled: !!yearId,
  });
}

// ---------------------------------------------------------------- 作業一覧 /tasks

/** 作業の一覧の select（04「作業一覧」の読むもの） */
export const TASKS_SELECT = 'id, title, note, assignee_id, due_at, status, created_by, updated_by, created_at, updated_at';

/** 作業の1行 */
export interface TaskRow {
  id: string;
  title: string;
  note: string | null;
  assignee_id: string | null;
  due_at: string | null;
  status: Enums<'task_status'>;
  created_by: string | null;
  updated_by: string | null;
  created_at: string;
  updated_at: string;
}

/** その年度の作業を全部読む（fetchAll。year_id で絞り、id の順。並べ方は画面〔lib/modules/shifts/tasks.ts の sortTasks〕） */
export async function loadTasks(yearId: string, client: AppSupabaseClient = getSupabase()): Promise<TaskRow[]> {
  return fetchAll<TaskRow>(
    (from, to) =>
      client.from('tasks').select(TASKS_SELECT).eq('year_id', yearId).order('id').range(from, to) as unknown as PromiseLike<PageResult<TaskRow>>,
  );
}

/** 作業の一覧のクエリ（キーは `['year', yearId, 'shifts', 'tasks']`） */
export function tasksOptions(yearId: string | null | undefined) {
  return queryOptions({
    queryKey: queryKeys.yearPart(yearId ?? '', 'shifts', 'tasks'),
    queryFn: () => loadTasks(yearId!),
    enabled: !!yearId,
  });
}
