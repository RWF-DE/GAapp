// テント等の貸し出し（/lending・/lending/records・申請のテント等のタブ）の読み取りと書き込み（T21・D-57。04「テント等の貸し出し」、
// notes/T21.md「画面の約束」2・9）。
// - 読む：/lending は備品（全部の列）・団体・割り当て・確定の印と、総務には申請・記録も（閲覧のみは読まない。RLS でも読めない）。
//   受け渡し・返却と申請のタブの読み取りは lib/modules/lending/queries.ts（先読みにも使う軽いモジュール。ここから出し直す）。
// - 書く：備品・申請・記録は画面から直接（RLS）、割り当てと確定は RPC。
//   - 備品：登録は画面が作った id で insert（送り直しは 23505）、編集・削除は読んだときの updated_at の文字列のまま条件に入れる
//     （updateWithLock・deleteChecked）。応答が届かない・止められたときは (B1)（runLendingItemSave・runLendingItemDelete）。
//   - 申請・記録：(A)（送る前にその団体の行を読み直して decideLendingRequestSave・decideLendingRecordSave で決める）。団体の全部の行の upsert。
//   - 割り当て：save_lending_assignments（行ごとの updatedAt）。応答が届かない・conflict のときは送った組を読み直して決める（(B1)）。
//   - 確定・解除：set_lending_confirmed。応答が届かなければ確定の印を読み直して決める。
// 版（allocation_version）・スナップショットは使わない（振り分けの入力でない）。
import type { Tables } from '@gaapp/shared';
import { queryOptions, type QueryClient, type QueryKey } from '@tanstack/react-query';
import { deleteChecked } from '@/lib/db/delete-checked';
import { fetchAll, type PageResult } from '@/lib/db/fetch-all';
import { updateWithLock } from '@/lib/db/update-with-lock';
import { classifyError, isUnknownOutcome, toAppError } from '@/lib/errors';
import { cellKey, sortLendingGroups, sortLendingItems, type LendingCountRow } from '@/lib/modules/lending/counts';
import {
  fetchLendingGroups,
  LENDING_RECORD_SELECT,
  LENDING_REQUEST_ROW_SELECT,
  type LendingGroup,
  type LendingRecordRow,
  type LendingRequestRow,
} from '@/lib/modules/lending/queries';
import { queryKeys } from '@/lib/query';
import { callRpc } from '@/lib/rpc';
import type { LendingAssignmentChange, SaveLendingAssignmentsResult } from '@/lib/rpc/payloads';
import { recordNoteOf, sameLendingItemWrite, type LendingItemWrite } from '@/lib/schemas/lending';
import { getSupabase, type AppSupabaseClient } from '@/lib/supabase/client';
import { decideAbsoluteSave, type AbsoluteSaveDecision } from './absolute-save';
import { isLockRejection, settleLockedWrite } from './locked-save';

export * from '@/lib/modules/lending/queries';

type Res = { data: unknown; error: unknown; status?: number };

function rowsOf<T>(res: Res): T[] {
  if (res.error) throw toAppError(res.error, res.status);
  return (res.data ?? []) as T[];
}

// ---------------------------------------------------------------- 備品と割り当て /lending の読み取り

/** 備品の列（全部の列。updated_at は編集・削除の楽観ロック） */
export const LENDING_ITEM_COLUMNS = 'id, year_id, name, unit, stock, requestable_categories, sort_order, updated_at';
export type LendingItemRow = Pick<
  Tables<'lending_items'>,
  'id' | 'year_id' | 'name' | 'unit' | 'stock' | 'requestable_categories' | 'sort_order' | 'updated_at'
>;
/** 割り当ての行（updated_at は save_lending_assignments の updatedAt） */
export type LendingAssignmentRow = Pick<Tables<'lending_assignments'>, 'group_id' | 'lending_item_id' | 'count' | 'updated_at'>;
/** /lending の記録の列（CSV のメモ。書いた人は読まない） */
export type LendingBoardRecord = Pick<Tables<'lending_records'>, 'group_id' | 'lending_item_id' | 'lent_count' | 'returned_count' | 'damaged_count' | 'note'>;

export interface LendingBoardData {
  /** 備品の並び */
  items: LendingItemRow[];
  /** 団体の並び */
  groups: LendingGroup[];
  assignments: LendingAssignmentRow[];
  /** 申請（総務だけ。閲覧のみは null） */
  requests: LendingCountRow[] | null;
  /** 記録（総務だけ。閲覧のみは null） */
  records: LendingBoardRecord[] | null;
  /** 割り当ての確定の日時（確定前は null） */
  confirmedAt: string | null;
  loadedAt: string;
}

function readYearPairs<T>(client: AppSupabaseClient, table: 'lending_requests' | 'lending_assignments' | 'lending_records', select: string, yearId: string) {
  return fetchAll<T>(
    (from, to) =>
      client.from(table).select(select).eq('year_id', yearId).order('group_id').order('lending_item_id').range(from, to) as unknown as PromiseLike<
        PageResult<T>
      >,
  );
}

/** /lending を読む（どれも並行に。閲覧のみ〔soumu が偽〕は申請と記録を読まない） */
export async function fetchLendingBoard(yearId: string, soumu: boolean, client: AppSupabaseClient = getSupabase()): Promise<LendingBoardData> {
  const [items, groups, assignments, ly, requests, records] = await Promise.all([
    client.from('lending_items').select(LENDING_ITEM_COLUMNS).eq('year_id', yearId).order('sort_order').order('id'),
    fetchLendingGroups(yearId, client),
    readYearPairs<LendingAssignmentRow>(client, 'lending_assignments', 'group_id, lending_item_id, count, updated_at', yearId),
    client.from('lending_years').select('year_id, confirmed_at').eq('year_id', yearId).maybeSingle(),
    soumu ? readYearPairs<LendingCountRow>(client, 'lending_requests', 'group_id, lending_item_id, count', yearId) : null,
    soumu
      ? readYearPairs<LendingBoardRecord>(client, 'lending_records', 'group_id, lending_item_id, lent_count, returned_count, damaged_count, note', yearId)
      : null,
  ]);
  if (ly.error) throw toAppError(ly.error, ly.status);
  return {
    items: sortLendingItems(rowsOf<LendingItemRow>(items)),
    groups: sortLendingGroups(groups),
    assignments,
    requests,
    records,
    confirmedAt: (ly.data as { confirmed_at: string | null } | null)?.confirmed_at ?? null,
    loadedAt: new Date().toISOString(),
  };
}

/** /lending のクエリ（キーは `['year', yearId, 'lending', 'board', 'soumu' | 'viewer']`） */
export function lendingBoardOptions(yearId: string, soumu: boolean) {
  return queryOptions({
    queryKey: queryKeys.yearPart(yearId, 'lending', 'board', soumu ? 'soumu' : 'viewer'),
    queryFn: () => fetchLendingBoard(yearId, soumu),
  });
}

/** 書いた後に読み直すキー：テント等の画面（`['year', y, 'lending']`）とダッシュボード（`['year', y, 'portal', 'lending']`） */
export function lendingInvalidateKeys(yearId: string): QueryKey[] {
  return [queryKeys.yearPart(yearId, 'lending'), queryKeys.yearPart(yearId, 'portal', 'lending')];
}

/** 書いた後に、テント等の画面とダッシュボードを読み直す（待たない） */
export function invalidateLending(queryClient: QueryClient, yearId: string): void {
  for (const queryKey of lendingInvalidateKeys(yearId)) void queryClient.invalidateQueries({ queryKey });
}

// ---------------------------------------------------------------- 備品の書き込み

/**
 * 登録の id（uuid v4）。ダイアログを開いたときに作り、閉じるまで（もう一度の送信と下書きを含めて）同じ id を使う（(B1)：送り直しは
 * 主キーの重複〔23505〕で止まる）。crypto.randomUUID のないとき（安全でない接続）は getRandomValues で作る。
 */
export function newLendingId(): string {
  const c = globalThis.crypto;
  if (typeof c.randomUUID === 'function') return c.randomUUID();
  const b = c.getRandomValues(new Uint8Array(16));
  b[6] = (b[6]! & 0x0f) | 0x40;
  b[8] = (b[8]! & 0x3f) | 0x80;
  const h = [...b].map((x) => x.toString(16).padStart(2, '0')).join('');
  return `${h.slice(0, 8)}-${h.slice(8, 12)}-${h.slice(12, 16)}-${h.slice(16, 20)}-${h.slice(20)}`;
}

/** 行を一覧の形にそろえる（updateWithLock・deleteChecked は全部の列を返す） */
export function toLendingItemRow(row: LendingItemRow): LendingItemRow {
  return {
    id: row.id,
    year_id: row.year_id,
    name: row.name,
    unit: row.unit,
    stock: row.stock,
    requestable_categories: row.requestable_categories,
    sort_order: row.sort_order,
    updated_at: row.updated_at,
  };
}

/**
 * 登録（1件でも前年度からの読み込みでも、1回の insert）。画面が作った id で入れ、行を返させる。送り直しは主キーの重複（23505）、
 * 同じ名前は unique (year_id, name) の 23505 で止まる。書けなければ 42501。失敗したら AppError を投げる。
 */
export async function insertLendingItems(
  yearId: string,
  rows: readonly (LendingItemWrite & { id: string })[],
  client: AppSupabaseClient = getSupabase(),
): Promise<LendingItemRow[]> {
  const res = await client
    .from('lending_items')
    .insert(rows.map((r) => ({ ...r, year_id: yearId })))
    .select(LENDING_ITEM_COLUMNS);
  return sortLendingItems(rowsOf<LendingItemRow>(res));
}

/** 編集：読んだときの updated_at を条件に入れて全部の欄を置き換える（0 行は explainZeroRows の AppError） */
export async function updateLendingItem(
  row: Pick<LendingItemRow, 'id' | 'updated_at'>,
  w: LendingItemWrite,
  client: AppSupabaseClient = getSupabase(),
): Promise<LendingItemRow> {
  return toLendingItemRow((await updateWithLock(client, 'lending_items', { id: row.id }, row.updated_at, { ...w })) as LendingItemRow);
}

/** 削除：読んだときの updated_at を条件に入れて delete し、消えた行を受け取る（0 行は explainZeroRows の AppError） */
export async function deleteLendingItem(row: Pick<LendingItemRow, 'id' | 'updated_at'>, client: AppSupabaseClient = getSupabase()): Promise<LendingItemRow> {
  return toLendingItemRow((await deleteChecked(client, 'lending_items', { id: row.id }, row.updated_at)) as LendingItemRow);
}

/** その備品を1行読む（(B1) の読み直し）。なければ null */
export async function readLendingItem(id: string, client: AppSupabaseClient = getSupabase()): Promise<LendingItemRow | null> {
  const res = await client.from('lending_items').select(LENDING_ITEM_COLUMNS).eq('id', id).maybeSingle();
  if (res.error) throw toAppError(res.error, res.status);
  return (res.data as LendingItemRow | null) ?? null;
}

/** 前年度の備品（previous_year_lending_items。部門長以上。前年度がなければ 0 行） */
export type PreviousLendingItem = LendingItemWrite;

export async function previousYearLendingItems(yearId: string, client: AppSupabaseClient = getSupabase()): Promise<PreviousLendingItem[]> {
  const rows = await callRpc('previous_year_lending_items', { p_year_id: yearId }, client);
  return (rows ?? []).map((r) => ({ name: r.name, unit: r.unit, stock: r.stock, requestable_categories: r.requestable_categories, sort_order: r.sort_order }));
}

/** 前年度の備品のクエリ（キーは `['year', yearId, 'lending', 'previous-items']`。備品が 0 件の部門長以上だけ読む） */
export function previousYearLendingItemsOptions(yearId: string) {
  return queryOptions({
    queryKey: queryKeys.yearPart(yearId, 'lending', 'previous-items'),
    queryFn: () => previousYearLendingItems(yearId),
  });
}

/** 401 の扱い（lib/auth/guarded.ts の useAuthErrorHandler） */
export type AuthErrorHandler = (e: unknown) => Promise<'retry' | 'signedOut' | 'other'>;

async function sendWithAuth<T>(send: () => Promise<T>, onAuthError: AuthErrorHandler): Promise<{ ok: true; value: T } | { ok: false; error: unknown }> {
  try {
    return { ok: true, value: await send() };
  } catch (e) {
    if ((await onAuthError(e)) !== 'retry') return { ok: false, error: e };
  }
  try {
    return { ok: true, value: await send() };
  } catch (e) {
    return { ok: false, error: e };
  }
}

/** 備品の登録・保存の結果 */
export type LendingItemSaveResult =
  /** 保存できた。before は、応答が届かなかった・止められたが、読み直すと送った値になっていた */
  | { type: 'saved'; row: LendingItemRow; before: boolean }
  /** ほかの人が先に変えた（読み直した行を入力の元にして入力を残す。登録は、その備品の編集に切り替える） */
  | { type: 'conflict'; row: LendingItemRow }
  /** 登録：同じ名前の備品がある（23505 で、id の行がない） */
  | { type: 'duplicate'; error: unknown }
  /** 保存：備品が消えていた */
  | { type: 'missing' }
  /** 応答が届かず保存できたか分からない（入力を残し、もう一度押せる） */
  | { type: 'unknown' }
  /** 保存：止められた後に読み直せなかった */
  | { type: 'unread' }
  /** そのほかの失敗（forbidden・在庫の守りの invalid_state・CHECK など） */
  | { type: 'failed'; error: unknown };

export interface LendingItemSaveRequest {
  /** 保存のときの入力の元の版（読んだときの updated_at）。登録は null */
  baseVersion: string | null;
  write: LendingItemWrite;
  send: () => Promise<LendingItemRow>;
  /** その備品（登録はダイアログの id）を1行読む */
  reread: () => Promise<LendingItemRow | null>;
}

/**
 * 備品の登録・保存（2.6 の (B1)。締切と予定の runEventSave と同じ決め方）。応答が届かなかったか止められた（23505・conflict・not_found）
 * なら、その備品を読み直して決める。登録の 23505 で id の行がなければ、同じ名前の別の行（duplicate）。
 */
export async function runLendingItemSave(req: LendingItemSaveRequest, onAuthError: AuthErrorHandler): Promise<LendingItemSaveResult> {
  const sent = await sendWithAuth(req.send, onAuthError);
  if (sent.ok) return { type: 'saved', row: sent.value, before: false };
  const error = sent.error;
  const unknown = isUnknownOutcome(error);
  if (!unknown && !isLockRejection(error)) return { type: 'failed', error };

  const read: { row: LendingItemRow | null } = { row: null };
  const outcome = await settleLockedWrite<LendingItemRow>({
    reread: async () => {
      read.row = await req.reread();
      return read.row;
    },
    matches: (row) => sameLendingItemWrite(row, req.write),
    baseVersion: req.baseVersion,
    versionOf: (row) => row.updated_at,
  });
  if (outcome === 'saved' && read.row) return { type: 'saved', row: read.row, before: true };
  if (req.baseVersion === null) {
    if (outcome === 'changed' && read.row) return { type: 'conflict', row: read.row };
    // 行がない：23505 なら同じ名前の別の行。応答が届かなかった・読み直せなかったなら分からない（もう一度押すと同じ id で送る）
    if (!unknown && outcome === 'not-saved' && classifyError(error).code === '23505') return { type: 'duplicate', error };
    return { type: 'unknown' };
  }
  if (unknown && (outcome === 'not-saved' || outcome === 'unread')) return { type: 'unknown' };
  if (outcome === 'unread') return { type: 'unread' };
  return read.row ? { type: 'conflict', row: read.row } : { type: 'missing' };
}

/** 備品の削除の結果 */
export type LendingItemDeleteResult =
  | { type: 'deleted'; before: boolean }
  | { type: 'changed' }
  | { type: 'unknown' }
  | { type: 'failed'; error: unknown };

/**
 * 備品の削除（(B1)）。deleteChecked の not_found はもうない（deleted・before）、conflict は版が違う（changed）、ほかは failed（23503 は
 * 申請・割り当て・記録がある）。応答が届かなければ読み直す：ない → deleted、版が違う → changed、同じ・読み直せない → unknown。
 */
export async function runLendingItemDelete(
  req: { send: () => Promise<unknown>; reread: () => Promise<LendingItemRow | null>; baseVersion: string },
  onAuthError: AuthErrorHandler,
): Promise<LendingItemDeleteResult> {
  const sent = await sendWithAuth(req.send, onAuthError);
  if (sent.ok) return { type: 'deleted', before: false };
  const error = sent.error;
  if (!isUnknownOutcome(error)) {
    const kind = classifyError(error).kind;
    if (kind === 'not_found') return { type: 'deleted', before: true };
    if (kind === 'conflict') return { type: 'changed' };
    return { type: 'failed', error };
  }
  let row: LendingItemRow | null;
  try {
    row = await req.reread();
  } catch {
    return { type: 'unknown' };
  }
  if (!row) return { type: 'deleted', before: false };
  return row.updated_at !== req.baseVersion ? { type: 'changed' } : { type: 'unknown' };
}

// ---------------------------------------------------------------- 割り当て（save_lending_assignments）

/**
 * 割り当ての未保存の変更（1つのセル）。count が null は行を消して未入力に戻す。base は入力を始めたときの行の updated_at（行がなければ
 * null）で、save_lending_assignments の updatedAt に送る（裏の読み直しで進めない。ほかの人が先に変えていれば DB が conflict で止める。
 * conflict で読み直したときだけ、読み直した版に進めて入力を残す）
 */
export interface AssignmentEdit {
  count: number | null;
  base: string | null;
}

/** 未保存の変更（セルのキー → 変更） */
export type AssignmentEditMap = ReadonlyMap<string, AssignmentEdit>;

/** DB の今の行と同じ値か（null は行がない、数なら行の数が同じ） */
function sameAsRow(count: number | null, row: LendingAssignmentRow | undefined): boolean {
  return count === null ? !row : row?.count === count;
}

/**
 * 未保存の変更から送る形を作る（今の DB と同じ値のセルは送らない）。updatedAt は入力を始めたときの版（base）。並びはセルのキーの順。
 */
export function assignmentChanges(edits: AssignmentEditMap, assignments: readonly LendingAssignmentRow[]): LendingAssignmentChange[] {
  const rows = new Map(assignments.map((a) => [cellKey(a.group_id, a.lending_item_id), a]));
  const out: LendingAssignmentChange[] = [];
  for (const [key, e] of [...edits].sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0))) {
    if (sameAsRow(e.count, rows.get(key))) continue;
    const [groupId = '', itemId = ''] = key.split(':');
    out.push({ groupId, itemId, count: e.count, updatedAt: e.base });
  }
  return out;
}

/** 未保存の変更のうち、今の DB と同じ値になったもの（保存の後・読み直した後）を外した新しい Map */
export function pruneAssignmentEdits(edits: AssignmentEditMap, assignments: readonly LendingAssignmentRow[]): Map<string, AssignmentEdit> {
  const rows = new Map(assignments.map((a) => [cellKey(a.group_id, a.lending_item_id), a]));
  return new Map([...edits].filter(([key, e]) => !sameAsRow(e.count, rows.get(key))));
}

/** 読み直した組（keys）の変更の版を、読み直した行の updated_at（行がなければ null）に進めた新しい Map（入力は残す。conflict の後） */
export function rebaseAssignmentEdits(edits: AssignmentEditMap, keys: readonly string[], fresh: readonly LendingAssignmentRow[]): Map<string, AssignmentEdit> {
  const rows = new Map(fresh.map((a) => [cellKey(a.group_id, a.lending_item_id), a]));
  const wanted = new Set(keys);
  return new Map([...edits].map(([key, e]) => [key, wanted.has(key) ? { count: e.count, base: rows.get(key)?.updated_at ?? null } : e]));
}

/** 組のキーの行を fresh（読み直した行。ない組は行を消す）に置き換えた新しい一覧 */
export function replaceAssignmentRows(
  assignments: readonly LendingAssignmentRow[],
  keys: readonly string[],
  fresh: readonly LendingAssignmentRow[],
): LendingAssignmentRow[] {
  const replaced = new Set(keys);
  const keep = assignments.filter((a) => !replaced.has(cellKey(a.group_id, a.lending_item_id)));
  const add = fresh.filter((a) => replaced.has(cellKey(a.group_id, a.lending_item_id)));
  return [...keep, ...add];
}

/** 保存の返り値（changes の順）を一覧に当てる（count が null は行を消す） */
export function applyAssignmentResult(assignments: readonly LendingAssignmentRow[], result: SaveLendingAssignmentsResult): LendingAssignmentRow[] {
  const fresh = result.flatMap((r) =>
    r.count === null || r.updatedAt === null ? [] : [{ group_id: r.groupId, lending_item_id: r.itemId, count: r.count, updated_at: r.updatedAt }],
  );
  return replaceAssignmentRows(
    assignments,
    result.map((r) => cellKey(r.groupId, r.itemId)),
    fresh,
  );
}

/** 読み直した行が送った変更と同じか（count が null は行がない、数なら行の数が同じ） */
export function sameAssignmentInput(fresh: readonly LendingAssignmentRow[], changes: readonly LendingAssignmentChange[]): boolean {
  const rows = new Map(fresh.map((a) => [cellKey(a.group_id, a.lending_item_id), a]));
  return changes.every((c) => {
    const row = rows.get(cellKey(c.groupId, c.itemId));
    return c.count === null ? !row : row?.count === c.count;
  });
}

/** 送った変更のどれかの行が、送った版（updatedAt）から変わったか（行ができた・消えた・updated_at が違う） */
export function assignmentRowsChanged(fresh: readonly LendingAssignmentRow[], changes: readonly LendingAssignmentChange[]): boolean {
  const rows = new Map(fresh.map((a) => [cellKey(a.group_id, a.lending_item_id), a]));
  return changes.some((c) => {
    const row = rows.get(cellKey(c.groupId, c.itemId));
    // 行がない：送った版があれば消えた。行がある：送った版がなければできた、あれば版を比べる（DB と同じくミリ秒まで）
    if (!row) return c.updatedAt !== null;
    if (c.updatedAt === null) return true;
    return row.updated_at !== c.updatedAt && Date.parse(row.updated_at) !== Date.parse(c.updatedAt);
  });
}

/** 割り当てを1回で保存する（save_lending_assignments。全部か何も） */
export async function saveLendingAssignments(
  yearId: string,
  changes: readonly LendingAssignmentChange[],
  client: AppSupabaseClient = getSupabase(),
): Promise<SaveLendingAssignmentsResult> {
  return callRpc('save_lending_assignments', { p_year_id: yearId, p_changes: [...changes] }, client);
}

/** 送った組の割り当ての行を読み直す（(B1)。団体と備品で絞ってから組に当てる） */
export async function readAssignmentRows(
  yearId: string,
  pairs: readonly { groupId: string; itemId: string }[],
  client: AppSupabaseClient = getSupabase(),
): Promise<LendingAssignmentRow[]> {
  if (pairs.length === 0) return [];
  const groups = [...new Set(pairs.map((p) => p.groupId))].sort();
  const items = [...new Set(pairs.map((p) => p.itemId))].sort();
  const wanted = new Set(pairs.map((p) => cellKey(p.groupId, p.itemId)));
  const rows = await fetchAll<LendingAssignmentRow>(
    (from, to) =>
      client
        .from('lending_assignments')
        .select('group_id, lending_item_id, count, updated_at')
        .eq('year_id', yearId)
        .in('group_id', groups)
        .in('lending_item_id', items)
        .order('group_id')
        .order('lending_item_id')
        .range(from, to) as unknown as PromiseLike<PageResult<LendingAssignmentRow>>,
  );
  return rows.filter((r) => wanted.has(cellKey(r.group_id, r.lending_item_id)));
}

// ---------------------------------------------------------------- 確定（set_lending_confirmed）

/** 確定・解除（set_lending_confirmed。解除は理由が要る） */
export async function setLendingConfirmed(
  yearId: string,
  confirmed: boolean,
  reason: string | null,
  client: AppSupabaseClient = getSupabase(),
): Promise<Tables<'lending_years'>> {
  return callRpc('set_lending_confirmed', { p_year_id: yearId, p_confirmed: confirmed, ...(reason ? { p_reason: reason } : {}) }, client);
}

/** 確定の印を読み直す（(B1)。確定の日時。行がない・解除の後は null） */
export async function readLendingConfirmedAt(yearId: string, client: AppSupabaseClient = getSupabase()): Promise<string | null> {
  const res = await client.from('lending_years').select('year_id, confirmed_at').eq('year_id', yearId).maybeSingle();
  if (res.error) throw toAppError(res.error, res.status);
  return (res.data as { confirmed_at: string | null } | null)?.confirmed_at ?? null;
}

// ---------------------------------------------------------------- 申請（(A)）

/** 送る申請の行（申請できる備品の全部。0 を含む） */
export interface LendingRequestWrite {
  group_id: string;
  lending_item_id: string;
  year_id: string;
  count: number;
}

/** 申請を保存する（団体の全部の行の upsert。書いた人と日時は DB が入れる）。書けなければ 42501 */
export async function saveLendingRequests(rows: readonly LendingRequestWrite[], client: AppSupabaseClient = getSupabase()): Promise<LendingRequestRow[]> {
  const res = await client
    .from('lending_requests')
    .upsert([...rows], { onConflict: 'group_id,lending_item_id' })
    .select(LENDING_REQUEST_ROW_SELECT);
  return rowsOf<LendingRequestRow>(res);
}

/**
 * 申請の送る前の読み直しで決める（2.6 の (A)。decideAbsoluteSave）。備品ごとに、入力（counts）・入力の元（base の行。なければ 0）・
 * 読み直した値（fresh の行。なければ 0）。行の変化は updated_at（行の有無を含む）、ほかの人かは updated_by（null は自分でない）で見る。
 */
export function decideLendingRequestSave(input: {
  itemIds: readonly string[];
  counts: Readonly<Record<string, number>>;
  base: readonly LendingRequestRow[];
  fresh: readonly LendingRequestRow[];
  userId: string;
}): AbsoluteSaveDecision {
  const base = new Map(input.base.map((r) => [r.lending_item_id, r]));
  const fresh = new Map(input.fresh.map((r) => [r.lending_item_id, r]));
  return decideAbsoluteSave(
    input.itemIds.map((id) => {
      const b = base.get(id);
      const f = fresh.get(id);
      return {
        input: input.counts[id] ?? 0,
        base: b?.count ?? 0,
        fresh: f?.count ?? 0,
        changed: (b?.updated_at ?? null) !== (f?.updated_at ?? null),
        byOther: !!f && f.updated_by !== input.userId,
      };
    }),
  );
}

/** 入力の元から変わった申請の備品（ほかの人の変更。上書きの確かめに「前 → 今」で出す） */
export function changedLendingRequests(
  itemIds: readonly string[],
  base: readonly LendingRequestRow[],
  fresh: readonly LendingRequestRow[],
): { itemId: string; from: number; to: number }[] {
  const b = new Map(base.map((r) => [r.lending_item_id, r]));
  const f = new Map(fresh.map((r) => [r.lending_item_id, r]));
  return itemIds.flatMap((id) => {
    const x = b.get(id);
    const y = f.get(id);
    return (x?.updated_at ?? null) !== (y?.updated_at ?? null) && (x?.count ?? 0) !== (y?.count ?? 0) ? [{ itemId: id, from: x?.count ?? 0, to: y?.count ?? 0 }] : [];
  });
}

// ---------------------------------------------------------------- 受け渡し・返却の記録（(A)）

/** 1つの備品の記録の値（送る形。メモは前後の空白を除いて空なら null） */
export interface LendingRecordWriteValues {
  lent_count: number;
  returned_count: number;
  damaged_count: number;
  note: string | null;
}

/** 送る記録の行（その団体の欄に出した備品の全部。0 を含む） */
export type LendingRecordWrite = LendingRecordWriteValues & { group_id: string; lending_item_id: string; year_id: string };

/** 記録を保存する（その団体の行の upsert。書いた人と日時は DB が入れる）。書けなければ 42501 */
export async function saveLendingRecords(rows: readonly LendingRecordWrite[], client: AppSupabaseClient = getSupabase()): Promise<LendingRecordRow[]> {
  const res = await client
    .from('lending_records')
    .upsert(
      rows.map((r) => ({ ...r, note: recordNoteOf(r.note) })),
      { onConflict: 'group_id,lending_item_id' },
    )
    .select(LENDING_RECORD_SELECT);
  return rowsOf<LendingRecordRow>(res);
}

/** 行の値（行がなければ 0 とメモなし） */
export function recordValuesOf(row: Pick<LendingRecordRow, 'lent_count' | 'returned_count' | 'damaged_count' | 'note'> | undefined): LendingRecordWriteValues {
  return {
    lent_count: row?.lent_count ?? 0,
    returned_count: row?.returned_count ?? 0,
    damaged_count: row?.damaged_count ?? 0,
    note: recordNoteOf(row?.note),
  };
}

/** 2つの記録の値が同じか（メモは null と空をそろえる） */
export function sameRecordValues(a: LendingRecordWriteValues, b: LendingRecordWriteValues): boolean {
  return (
    a.lent_count === b.lent_count &&
    a.returned_count === b.returned_count &&
    a.damaged_count === b.damaged_count &&
    recordNoteOf(a.note) === recordNoteOf(b.note)
  );
}

/**
 * 記録の送る前の読み直しで決める（2.6 の (A)。在庫入力と同じ形）。備品ごとに、入力（values）・入力の元（base の行）・読み直した値
 * （fresh の行）。行の変化は updated_at（行の有無を含む）、ほかの人かは updated_by（null は自分でない）で見る。
 */
export function decideLendingRecordSave(input: {
  itemIds: readonly string[];
  values: Readonly<Record<string, LendingRecordWriteValues>>;
  base: readonly LendingRecordRow[];
  fresh: readonly LendingRecordRow[];
  userId: string;
}): AbsoluteSaveDecision {
  const base = new Map(input.base.map((r) => [r.lending_item_id, r]));
  const fresh = new Map(input.fresh.map((r) => [r.lending_item_id, r]));
  return decideAbsoluteSave(
    input.itemIds.map((id) => {
      const b = base.get(id);
      const f = fresh.get(id);
      return {
        input: input.values[id] ?? recordValuesOf(undefined),
        base: recordValuesOf(b),
        fresh: recordValuesOf(f),
        changed: (b?.updated_at ?? null) !== (f?.updated_at ?? null),
        byOther: !!f && f.updated_by !== input.userId,
      };
    }),
    sameRecordValues,
  );
}
