// シフト表（/shifts）・印刷（/shifts/print）・自分のシフト（/shift）の読み取りと書き込み（04「シフト表」「自分のシフト」「シフト表の印刷」、
// notes/T20.md「画面の約束」2・3。T20・D-56）。
// - 読む：開いている年度の時間枠（ますと割り当てを埋め込む。開始・id の順）と持ち場を並行に読む（shiftBoardOptions）。表示名・ロールの一覧・
//   自分の割り当ては先読みにも使う軽いモジュール（lib/modules/shifts/reads.ts）にあり、ここから同じ名前で出し直す。RLS が返したものを
//   そのまま使う（5表はその年度の総務だけが読める）。
// - 書く：画面から直接（RLS。書けるのはその年度の部門長以上で、年度が終了でないとき）。持ち場・時間枠は画面が作った id で insert（送り直しは
//   主キーの重複〔23505〕で止まる）、直す・消すは読んだときの updated_at の文字列のまま条件に入れる（updateWithLock・deleteChecked。DB は
//   マイクロ秒まで完全一致で比べるので Date に通さない）。必要人数は数の絶対値の upsert（(A)）、割り当ては主キー (slot_id, user_id) の
//   insert と、updated_at を条件に入れた delete・update（(B1)）。1日分は RPC add_shift_slots（(B2)）。
// 版（allocation_version）は使わない（シフトは振り分けの入力でない。D-56）。
import type { QueryClient, QueryKey } from '@tanstack/react-query';
import { deleteChecked } from '@/lib/db/delete-checked';
import { updateWithLock } from '@/lib/db/update-with-lock';
import { tokyoStartOfDay, tokyoStartOfNextDay } from '@/lib/datetime';
import { toAppError } from '@/lib/errors';
import type { BoardDuty, BoardNeed, BoardSlot, PlannedSlot, ShiftBoard } from '@/lib/modules/shifts/board';
import { SHIFT_DUTIES_SELECT, shiftBoardOptions } from '@/lib/modules/shifts/board-read';
import { queryKeys } from '@/lib/query';
import { callRpc } from '@/lib/rpc';
import type { DutyWrite, SlotWrite } from '@/lib/schemas/shifts';
import { getSupabase, type AppSupabaseClient } from '@/lib/supabase/client';

// 先読みにも使う読み取り（lib/modules/shifts/reads.ts）を、画面から同じ名前で使えるように出し直す
export {
  loadMyShifts,
  loadShiftMembers,
  loadSoumuNames,
  myShiftsOptions,
  sessionUserId,
  shiftMembersOptions,
  soumuNamesOptions,
  type MemberRow,
  type MyShiftRow,
  type NameRow,
} from '@/lib/modules/shifts/reads';
export { loadShiftBoard, SHIFT_BOARD_REFETCH_MS, SHIFT_DUTIES_SELECT, SHIFT_SLOTS_SELECT, shiftBoardOptions } from '@/lib/modules/shifts/board-read';

// ---------------------------------------------------------------- 読む

/** 持ち場を1行読む（(B1) の読み直し）。なければ null */
export async function readDuty(id: string, client: AppSupabaseClient = getSupabase()): Promise<BoardDuty | null> {
  const res = await client.from('shift_duties').select(SHIFT_DUTIES_SELECT).eq('id', id).maybeSingle();
  if (res.error) throw toAppError(res.error, res.status);
  return (res.data as BoardDuty | null) ?? null;
}

/** 時間枠の1行（ますを埋め込まない） */
export type SlotRow = Pick<BoardSlot, 'id' | 'starts_at' | 'ends_at' | 'updated_at'>;
const SLOT_ROW_SELECT = 'id, starts_at, ends_at, updated_at';

/** 時間枠を1行読む（(B1) の読み直し）。なければ null */
export async function readSlot(id: string, client: AppSupabaseClient = getSupabase()): Promise<SlotRow | null> {
  const res = await client.from('shift_slots').select(SLOT_ROW_SELECT).eq('id', id).maybeSingle();
  if (res.error) throw toAppError(res.error, res.status);
  return (res.data as SlotRow | null) ?? null;
}

/** その日（Asia/Tokyo）に始まる時間枠を読む（1日分の (B2) の確かめ） */
export async function readSlotsOfDay(yearId: string, day: string, client: AppSupabaseClient = getSupabase()): Promise<SlotRow[]> {
  const res = await client
    .from('shift_slots')
    .select(SLOT_ROW_SELECT)
    .eq('year_id', yearId)
    .gte('starts_at', tokyoStartOfDay(day))
    .lt('starts_at', tokyoStartOfNextDay(day))
    .order('starts_at')
    .order('id');
  if (res.error) throw toAppError(res.error, res.status);
  return (res.data ?? []) as SlotRow[];
}

/** ますの1行 */
export type NeedRow = Pick<BoardNeed, 'duty_id' | 'required_count' | 'updated_at'> & { slot_id: string };
const NEED_ROW_SELECT = 'slot_id, duty_id, required_count, updated_at';

/** ますを1行読む（(A) の送る前の読み直し）。なければ null */
export async function readNeed(slotId: string, dutyId: string, client: AppSupabaseClient = getSupabase()): Promise<NeedRow | null> {
  const res = await client.from('shift_needs').select(NEED_ROW_SELECT).eq('slot_id', slotId).eq('duty_id', dutyId).maybeSingle();
  if (res.error) throw toAppError(res.error, res.status);
  return (res.data as NeedRow | null) ?? null;
}

/** 割り当ての1行 */
export interface AssignmentRow {
  slot_id: string;
  duty_id: string;
  user_id: string;
  updated_at: string;
}
const ASSIGNMENT_SELECT = 'slot_id, duty_id, user_id, updated_at';

/** その人のその時間枠の割り当てを読む（(B1) の読み直し。主キー (slot_id, user_id)）。なければ null */
export async function readAssignment(slotId: string, userId: string, client: AppSupabaseClient = getSupabase()): Promise<AssignmentRow | null> {
  const res = await client.from('shift_assignments').select(ASSIGNMENT_SELECT).eq('slot_id', slotId).eq('user_id', userId).maybeSingle();
  if (res.error) throw toAppError(res.error, res.status);
  return (res.data as AssignmentRow | null) ?? null;
}

// ---------------------------------------------------------------- 書く：持ち場

const toDuty = (r: BoardDuty): BoardDuty => ({
  id: r.id,
  name: r.name,
  place: r.place,
  note: r.note,
  sort_order: r.sort_order,
  updated_at: r.updated_at,
});

/** 持ち場を足す（画面が作った id。送り直しは 23505）。書けなければ 42501 */
export async function insertDuty(yearId: string, id: string, w: DutyWrite, client: AppSupabaseClient = getSupabase()): Promise<BoardDuty> {
  const res = await client
    .from('shift_duties')
    .insert({ id, year_id: yearId, ...w })
    .select(SHIFT_DUTIES_SELECT)
    .single();
  if (res.error) throw toAppError(res.error, res.status);
  return res.data as BoardDuty;
}

/** 持ち場を直す（読んだときの updated_at を条件に入れる。0 行は not_found・conflict・forbidden） */
export async function updateDuty(row: Pick<BoardDuty, 'id' | 'updated_at'>, w: DutyWrite, client: AppSupabaseClient = getSupabase()): Promise<BoardDuty> {
  return toDuty(await updateWithLock(client, 'shift_duties', { id: row.id }, row.updated_at, { ...w }));
}

/** 持ち場を消す（ますと割り当ても消える。読んだときの updated_at を条件に入れる） */
export async function deleteDuty(row: Pick<BoardDuty, 'id' | 'updated_at'>, client: AppSupabaseClient = getSupabase()): Promise<void> {
  await deleteChecked(client, 'shift_duties', { id: row.id }, row.updated_at);
}

// ---------------------------------------------------------------- 書く：時間枠

/** 時間枠を足す（画面が作った id。時刻は `+09:00`。重なれば invalid_input〔reason: overlap〕） */
export async function insertSlot(yearId: string, id: string, w: SlotWrite, client: AppSupabaseClient = getSupabase()): Promise<SlotRow> {
  const res = await client.from('shift_slots').insert({ id, year_id: yearId, ...w }).select(SLOT_ROW_SELECT).single();
  if (res.error) throw toAppError(res.error, res.status);
  return res.data as SlotRow;
}

/** 時間枠の時刻を直す（読んだときの updated_at を条件に入れる） */
export async function updateSlot(row: Pick<SlotRow, 'id' | 'updated_at'>, w: SlotWrite, client: AppSupabaseClient = getSupabase()): Promise<SlotRow> {
  const r = await updateWithLock(client, 'shift_slots', { id: row.id }, row.updated_at, { ...w });
  return { id: r.id, starts_at: r.starts_at, ends_at: r.ends_at, updated_at: r.updated_at };
}

/** 時間枠を消す（ますと割り当ても消える） */
export async function deleteSlot(row: Pick<SlotRow, 'id' | 'updated_at'>, client: AppSupabaseClient = getSupabase()): Promise<void> {
  await deleteChecked(client, 'shift_slots', { id: row.id }, row.updated_at);
}

/**
 * 1日分をまとめて作る（RPC add_shift_slots。時間枠と、そのすべてに同じ持ち場のます）。冪等の鍵がないので (B2)：応答が届かなければ、
 * その日の時間枠を読み直して確かめてから送り直す。返り値は作った時間枠（開始の早い順）。
 */
export async function addShiftSlots(
  yearId: string,
  slots: readonly PlannedSlot[],
  needs: readonly { duty_id: string; required_count: number }[],
  client: AppSupabaseClient = getSupabase(),
): Promise<SlotRow[]> {
  const rows = await callRpc('add_shift_slots', { p_year_id: yearId, p_slots: [...slots], p_needs: [...needs] }, client);
  return (rows ?? []).map((r) => ({ id: r.id, starts_at: r.starts_at, ends_at: r.ends_at, updated_at: r.updated_at }));
}

// ---------------------------------------------------------------- 書く：ます（必要人数）

/**
 * 必要人数を書く（数の絶対値の upsert。`slot_id, duty_id` の衝突で上書き。ますがなければ作る）。送る前の読み直しは画面（(A)）。
 */
export async function upsertNeed(
  yearId: string,
  slotId: string,
  dutyId: string,
  requiredCount: number,
  client: AppSupabaseClient = getSupabase(),
): Promise<NeedRow> {
  const res = await client
    .from('shift_needs')
    .upsert({ year_id: yearId, slot_id: slotId, duty_id: dutyId, required_count: requiredCount }, { onConflict: 'slot_id,duty_id' })
    .select(NEED_ROW_SELECT)
    .single();
  if (res.error) throw toAppError(res.error, res.status);
  return res.data as NeedRow;
}

/** ますを外す（割り当ても消える。読んだときの updated_at を条件に入れる） */
export async function deleteNeed(need: Pick<NeedRow, 'slot_id' | 'duty_id' | 'updated_at'>, client: AppSupabaseClient = getSupabase()): Promise<void> {
  await deleteChecked(client, 'shift_needs', { slot_id: need.slot_id, duty_id: need.duty_id }, need.updated_at);
}

// ---------------------------------------------------------------- 書く：割り当て

/** 割り当てる（主キー (slot_id, user_id)。その時間枠にもう入っていれば 23505、総務でなければ invalid_input〔not_soumu〕） */
export async function assign(
  yearId: string,
  slotId: string,
  dutyId: string,
  userId: string,
  client: AppSupabaseClient = getSupabase(),
): Promise<AssignmentRow> {
  const res = await client
    .from('shift_assignments')
    .insert({ year_id: yearId, slot_id: slotId, duty_id: dutyId, user_id: userId })
    .select(ASSIGNMENT_SELECT)
    .single();
  if (res.error) throw toAppError(res.error, res.status);
  return res.data as AssignmentRow;
}

/** 外す（読んだときの updated_at を条件に入れる） */
export async function unassign(a: Pick<AssignmentRow, 'slot_id' | 'user_id' | 'updated_at'>, client: AppSupabaseClient = getSupabase()): Promise<void> {
  await deleteChecked(client, 'shift_assignments', { slot_id: a.slot_id, user_id: a.user_id }, a.updated_at);
}

/** ほかの持ち場へ移す（割り当ての duty_id の update 1回。消してから足さない） */
export async function moveAssignment(
  a: Pick<AssignmentRow, 'slot_id' | 'user_id' | 'updated_at'>,
  dutyId: string,
  client: AppSupabaseClient = getSupabase(),
): Promise<AssignmentRow> {
  const r = await updateWithLock(client, 'shift_assignments', { slot_id: a.slot_id, user_id: a.user_id }, a.updated_at, { duty_id: dutyId });
  return { slot_id: r.slot_id, duty_id: r.duty_id, user_id: r.user_id, updated_at: r.updated_at };
}

// ---------------------------------------------------------------- 読み直し

/**
 * 書いた後に読み直すキー：シフト・作業の画面の全部（`['year', y, 'shifts']`）とダッシュボードのシフト・作業（`['year', y, 'portal', 'shifts']`。
 * /calendar の機能の日付も同じキー）
 */
export function shiftsInvalidateKeys(yearId: string): QueryKey[] {
  return [queryKeys.yearPart(yearId, 'shifts'), queryKeys.yearPart(yearId, 'portal', 'shifts')];
}

/** 書いた後に読み直す（待たない） */
export function invalidateShifts(queryClient: QueryClient, yearId: string): void {
  for (const queryKey of shiftsInvalidateKeys(yearId)) void queryClient.invalidateQueries({ queryKey });
}

/**
 * 画面が作る id（uuid v4）。ダイアログを開いたときに作り、閉じるまで（もう一度の送信と下書きを含めて）同じ id を使う（(B1)）。
 * crypto.randomUUID のないとき（安全でない接続）は getRandomValues で作る。
 */
export function newShiftId(): string {
  const c = globalThis.crypto;
  if (typeof c.randomUUID === 'function') return c.randomUUID();
  const b = c.getRandomValues(new Uint8Array(16));
  b[6] = (b[6]! & 0x0f) | 0x40;
  b[8] = (b[8]! & 0x3f) | 0x80;
  const h = [...b].map((x) => x.toString(16).padStart(2, '0')).join('');
  return `${h.slice(0, 8)}-${h.slice(8, 12)}-${h.slice(12, 16)}-${h.slice(16, 20)}-${h.slice(20)}`;
}

/** シフト表のキャッシュを直す（書いた結果を読み直しの前に表に出す。キャッシュがなければ何もしない） */
export function updateBoardCache(queryClient: QueryClient, yearId: string, fn: (board: ShiftBoard) => ShiftBoard): void {
  queryClient.setQueryData(shiftBoardOptions(yearId).queryKey, (old) => (old ? fn(old) : old));
}
