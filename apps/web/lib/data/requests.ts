// 申請（/request）・申請一覧（/requests）のデータの読み書き（画面の設計 2.1・2.3・3.5・3.6。T11）。
// 純粋関数（並べ方・入力欄の組み立て・受付期間の判断・申請一覧の表・未保存のセル）と、DB の読み書きを置く。
// 締切前の申請一覧のセルは直接（updated_at で楽観ロック）、提出は submit_requests、締切後は update_requests_after_deadline。
import { compareBySortOrder, compareStrings, MAX_COUNT, REQUEST_REWRITES, type GroupCategory } from '@gaapp/shared';
import { useQuery } from '@tanstack/react-query';
import { fetchAll } from '@/lib/db/fetch-all';
import { updateWithLock } from '@/lib/db/update-with-lock';
import {
  COLUMNS,
  type GroupRow,
  type ItemRow,
  type RequestDbRow,
  type SubmissionRow,
  type YearRow,
  type YearStatus,
} from '@/lib/db/types';
import { AppError, appError, classifyError, toAppError } from '@/lib/errors';
import { queryKeys } from '@/lib/query';
import { callRpc } from '@/lib/rpc';
import { getSupabase, type AppSupabaseClient } from '@/lib/supabase/client';
import type { RequestsFilter } from '@/lib/schemas/requests';

// ---------------------------------------------------------------- 並べ方・品目

const bySortOrder = <T extends { sort_order: number; name: string; id: string }>(a: T, b: T) =>
  compareBySortOrder({ sortOrder: a.sort_order, name: a.name, id: a.id }, { sortOrder: b.sort_order, name: b.name, id: b.id });

/** 品目を sort_order → 名前 → id の順に（元の配列は変えない） */
export function sortItems<T extends Pick<ItemRow, 'sort_order' | 'name' | 'id'>>(items: readonly T[]): T[] {
  return items.slice().sort(bySortOrder);
}

/** 団体を sort_order → 名前 → id の順に（申請一覧の行の並び） */
export function sortGroups<T extends Pick<GroupRow, 'sort_order' | 'name' | 'id'>>(groups: readonly T[]): T[] {
  return groups.slice().sort(bySortOrder);
}

/** その区分で申請できる品目か（items.requestable_categories に区分がある） */
export function isRequestable(item: Pick<ItemRow, 'requestable_categories'>, category: GroupCategory): boolean {
  return item.requestable_categories.includes(category);
}

/** 申請できない品目の読み替え先（企業以外の長机(3人掛) → 長机(2人掛)。S03・D-05）。なければ null */
export function rewriteTargetOf(item: Pick<ItemRow, 'code'>, items: readonly ItemRow[]): ItemRow | null {
  const code = REQUEST_REWRITES[item.code];
  return code ? (items.find((i) => i.code === code) ?? null) : null;
}

// ---------------------------------------------------------------- 申請の入力欄（/request と代理入力）

/** 入力欄の1品目（その団体の区分で申請できる品目） */
export interface RequestField {
  item: ItemRow;
  /** 今の申請の数（行がなければ 0） */
  current: number;
  /** 今の行の updated_at（行がなければ null。締切後の RPC の楽観ロックに渡す） */
  updatedAt: string | null;
}

/** 入力欄に出さない品目に残っている 0 でない申請（読み取り専用の行。3.5） */
export interface ExtraRequestRow {
  item: ItemRow;
  count: number;
  updatedAt: string;
  /** 読み替え先（企業以外の長机(3人掛) → 長机(2人掛)）。読み替えのない品目は null（E006） */
  treatedAs: ItemRow | null;
}

export interface RequestFormModel {
  fields: RequestField[];
  extras: ExtraRequestRow[];
}

/**
 * 入力欄を組み立てる。区分で申請できる品目だけを入力欄にし（初期値は今の申請の数、なければ 0）、
 * 申請できない品目に 0 でない行があれば読み取り専用の行にする。読み替え先の初期値には足さない（足すと提出のたびに二重になる）。
 */
export function buildRequestForm(
  items: readonly ItemRow[],
  category: GroupCategory,
  requests: readonly Pick<RequestDbRow, 'item_id' | 'count' | 'updated_at'>[],
): RequestFormModel {
  const byItem = new Map(requests.map((r) => [r.item_id, r]));
  const sorted = sortItems(items);
  const fields: RequestField[] = [];
  const extras: ExtraRequestRow[] = [];
  for (const item of sorted) {
    const row = byItem.get(item.id);
    if (isRequestable(item, category)) {
      fields.push({ item, current: row?.count ?? 0, updatedAt: row?.updated_at ?? null });
    } else if (row && row.count > 0) {
      extras.push({ item, count: row.count, updatedAt: row.updated_at, treatedAs: rewriteTargetOf(item, items) });
    }
  }
  return { fields, extras };
}

/** 読み取り専用の行の説明（「長机(2人掛)として扱います。変えるときは総務へ」など） */
export function extraRowNote(extra: Pick<ExtraRequestRow, 'treatedAs'>, audience: 'rep' | 'admin' = 'rep'): string {
  if (extra.treatedAs) {
    return audience === 'rep'
      ? `${extra.treatedAs.name}として扱います。変えるときは総務へ`
      : `${extra.treatedAs.name}として扱います`;
  }
  return audience === 'rep' ? 'この区分では申請できない品目です。総務へ' : '申請できない品目（E006）';
}

/** 入力の数（edits は変えた品目だけ。なければ今の数） */
export function countOf(field: RequestField, edits: Readonly<Record<string, number>>): number {
  return Object.hasOwn(edits, field.item.id) ? edits[field.item.id]! : field.current;
}

/** 変えた品目があるか（今の数と同じ値は変えていない扱い） */
export function hasCountChanges(fields: readonly RequestField[], edits: Readonly<Record<string, number>>): boolean {
  return fields.some((f) => countOf(f, edits) !== f.current);
}

/** submit_requests の p_rows：表示した入力欄の品目すべての { itemId, count } */
export function toSubmitRows(fields: readonly RequestField[], edits: Readonly<Record<string, number>>): { itemId: string; count: number }[] {
  return fields.map((f) => ({ itemId: f.item.id, count: countOf(f, edits) }));
}

/**
 * update_requests_after_deadline の p_rows（代理入力の締切後）：今の数から変えた品目だけ。
 * 行がある品目は updatedAt を付ける（楽観ロック）。新しい品目の行は付けない。
 */
export function toDeadlineRows(
  fields: readonly RequestField[],
  edits: Readonly<Record<string, number>>,
): { itemId: string; count: number; updatedAt?: string }[] {
  return fields
    .filter((f) => countOf(f, edits) !== f.current)
    .map((f) => ({ itemId: f.item.id, count: countOf(f, edits), ...(f.updatedAt ? { updatedAt: f.updatedAt } : {}) }));
}

/** 提出の確認に出す、0 でない品目の一覧（並びは入力欄と同じ） */
export function nonZeroSummary(fields: readonly RequestField[], edits: Readonly<Record<string, number>>): { name: string; count: number }[] {
  return fields.map((f) => ({ name: f.item.name, count: countOf(f, edits) })).filter((r) => r.count > 0);
}

// ---------------------------------------------------------------- 受付期間（端末の時計で判断し、DB に拒否されたら印で合わせる）

/**
 * 団体代表から見た受付期間（3.5 の状態の表）。
 * - preparing：準備中（受付の前）
 * - not_yet：申請受付中だが受付開始の前（request_open_at が未来）
 * - open：受付期間内
 * - closed：締切後（申請受付中で締切を過ぎた）と、振り分け中以降
 */
export type RequestWindow = 'preparing' | 'not_yet' | 'open' | 'closed';

type YearWindow = Pick<YearRow, 'status' | 'request_open_at' | 'request_close_at'>;

const ms = (iso: string | null): number | null => {
  if (!iso) return null;
  const t = new Date(iso).getTime();
  return Number.isNaN(t) ? null : t;
};

export function requestWindowOf(year: YearWindow, now: Date | number): RequestWindow {
  const t = typeof now === 'number' ? now : now.getTime();
  if (year.status === 'preparing') return 'preparing';
  if (year.status !== 'requesting') return 'closed';
  const open = ms(year.request_open_at);
  const close = ms(year.request_close_at);
  if (open !== null && t < open) return 'not_yet';
  // DB（private.can_write_requests）と同じく、締切がない・締切を過ぎたら書けない
  return close !== null && t < close ? 'open' : 'closed';
}

/** 締切が過ぎたか（申請一覧の書き方を決める。準備中は締切前として扱う） */
export function isPastDeadline(year: YearWindow, now: Date | number): boolean {
  const t = typeof now === 'number' ? now : now.getTime();
  if (year.status === 'preparing') return false;
  if (year.status !== 'requesting') return true;
  const close = ms(year.request_close_at);
  return close === null || t >= close;
}

/**
 * 「DB が受付期間の外と判断した」印（端末の時計がずれているとき。3.5・3.6）。
 * 年度の状態と受付期間を鍵にして持ち、年度の行を読み直して状態（か受付期間）が変わったら効かなくなる。画面を開き直すと消える。
 */
export type OutsideFlag = string;

export function outsideFlagOf(year: YearWindow): OutsideFlag {
  return `${year.status}|${year.request_open_at ?? ''}|${year.request_close_at ?? ''}`;
}

export function isOutsideFlagActive(flag: OutsideFlag | null, year: YearWindow): boolean {
  return flag !== null && flag === outsideFlagOf(year);
}

/**
 * 提出（submit_requests）の失敗を読み直した年度で判断する（2.5 の details の表）。
 * invalid_state で、読み直した年度が申請受付中のまま → DB が受付期間の外と判断した（端末の時計のずれ）。印を立てる。
 */
export function judgeSubmitFailure(error: unknown, reloaded: YearWindow | null): { outside: boolean } {
  const c = classifyError(error);
  if (c.kind !== 'state') return { outside: false };
  return { outside: reloaded?.status === 'requesting' };
}

/**
 * 申請一覧の直接の書き込みの失敗を判断する（3.6）。forbidden（RLS で 0 行・42501）で、読み直した年度が申請受付中のまま →
 * DB が締切後と判断した（端末の時計のずれ）。締切後の書き方（理由と update_requests_after_deadline）に切り替える。
 */
export function judgeDirectFailure(error: unknown, reloaded: YearWindow | null): { outside: boolean } {
  const c = classifyError(error);
  if (c.kind !== 'forbidden') return { outside: false };
  return { outside: reloaded?.status === 'requesting' };
}

/** 申請一覧での管理者の書き方：direct（締切前。直接）・deadline（締切後。理由と RPC）・readonly（確定中・終了） */
export type AdminWriteMode = 'direct' | 'deadline' | 'readonly';

export function adminWriteMode(year: YearWindow, now: Date | number, outside: boolean): AdminWriteMode {
  if (year.status === 'confirmed' || year.status === 'closed') return 'readonly';
  if (year.status === 'allocating') return 'deadline';
  if (year.status === 'requesting' && outside) return 'deadline';
  return isPastDeadline(year, now) ? 'deadline' : 'direct';
}

const DAY = 24 * 60 * 60 * 1000;
const HOUR = 60 * 60 * 1000;

/** 締切までの残り（「あと3日」「あと5時間」）。過ぎていれば null */
export function remainingText(closeAt: string | null, now: Date | number): string | null {
  const close = ms(closeAt);
  if (close === null) return null;
  const t = typeof now === 'number' ? now : now.getTime();
  const left = close - t;
  if (left <= 0) return null;
  if (left < DAY) return `あと${Math.max(1, Math.ceil(left / HOUR))}時間`;
  return `あと${Math.floor(left / DAY)}日`;
}

/** 状態の表示に使う年度の状態（ほかのファイルから型を引くため） */
export type { YearStatus };

// ---------------------------------------------------------------- 申請一覧の表（/requests）

/** 表の1セル */
export interface MatrixCell {
  itemId: string;
  /** DB の数（行がなければ 0） */
  count: number;
  /** DB の行の updated_at（行がなければ null） */
  updatedAt: string | null;
  /** その団体の区分で申請できる品目か */
  requestable: boolean;
}

export interface MatrixRow {
  group: GroupRow;
  cells: Record<string, MatrixCell>;
  submission: SubmissionRow | null;
  /** 提出済みか（submitted_at がある） */
  submitted: boolean;
  /** 備考（空白だけなら null） */
  note: string | null;
}

export interface RequestMatrix {
  /** 列（品目の並び順） */
  items: ItemRow[];
  /** 行（団体の並び順。区分と絞り込みを当てた後） */
  rows: MatrixRow[];
  /** 区分で絞った団体のうち、未提出の団体（表の上の一覧） */
  unsubmitted: GroupRow[];
  /** 区分で絞った団体の数 */
  groupCount: number;
}

export interface RequestsTables {
  groups: GroupRow[];
  items: ItemRow[];
  requests: RequestDbRow[];
  submissions: SubmissionRow[];
}

/** 申請一覧の表を作る（行は団体の並び順、列は品目の並び順。区分 → 未提出だけ・備考ありだけの順に絞る） */
export function buildRequestMatrix(
  t: RequestsTables,
  opts: { category?: GroupCategory | null; filter?: RequestsFilter | null } = {},
): RequestMatrix {
  const items = sortItems(t.items);
  const reqs = new Map<string, RequestDbRow>();
  for (const r of t.requests) reqs.set(cellKey(r.group_id, r.item_id), r);
  const subs = new Map(t.submissions.map((s) => [s.group_id, s]));
  const groups = sortGroups(t.groups).filter((g) => !opts.category || g.category === opts.category);
  const all: MatrixRow[] = groups.map((group) => {
    const cells: Record<string, MatrixCell> = {};
    for (const item of items) {
      const r = reqs.get(cellKey(group.id, item.id));
      cells[item.id] = {
        itemId: item.id,
        count: r?.count ?? 0,
        updatedAt: r?.updated_at ?? null,
        requestable: isRequestable(item, group.category),
      };
    }
    const submission = subs.get(group.id) ?? null;
    const note = submission?.note?.trim() ? submission.note : null;
    return { group, cells, submission, submitted: !!submission?.submitted_at, note };
  });
  const rows = all.filter((r) => {
    if (opts.filter === 'unsubmitted') return !r.submitted;
    if (opts.filter === 'noted') return r.note !== null;
    return true;
  });
  return { items, rows, unsubmitted: all.filter((r) => !r.submitted).map((r) => r.group), groupCount: all.length };
}

/** セルの鍵（団体 id と品目 id） */
export function cellKey(groupId: string, itemId: string): string {
  return `${groupId}:${itemId}`;
}

/**
 * 未保存のセル1つ。入れた数と、最初に編集したときの DB の行（基準）を持つ。
 * 保存の楽観ロックには基準の updated_at を送る（表を読み直した後も、編集したときの行を基準にする。2.3）。
 */
export interface PendingCell {
  /** 入れた数 */
  value: number;
  /** 最初に編集したときの DB の数（行がなければ 0） */
  baseCount: number;
  /** 最初に編集したときの DB の行の updated_at（行がなければ null） */
  baseUpdatedAt: string | null;
}

/** 未保存のセル（セルの鍵 → 入れた数と基準）。基準の数と同じ値は持たない。下書きにもこの形で置く */
export type PendingCells = Readonly<Record<string, PendingCell>>;

/** セルに数を入れる（最初の編集のときだけ基準を今の行から取る。基準の数と同じなら未保存から外す） */
export function setPendingCell(
  pending: PendingCells,
  groupId: string,
  itemId: string,
  value: number,
  cell: Pick<MatrixCell, 'count' | 'updatedAt'>,
): PendingCells {
  const key = cellKey(groupId, itemId);
  const prev = pending[key];
  const baseCount = prev ? prev.baseCount : cell.count;
  const baseUpdatedAt = prev ? prev.baseUpdatedAt : cell.updatedAt;
  const next = { ...pending };
  if (value === baseCount) delete next[key];
  else next[key] = { value, baseCount, baseUpdatedAt };
  return next;
}

/** 表示する数（未保存の値があればそれ） */
export function shownCount(pending: PendingCells, row: MatrixRow, itemId: string): number {
  const key = cellKey(row.group.id, itemId);
  return Object.hasOwn(pending, key) ? pending[key]!.value : (row.cells[itemId]?.count ?? 0);
}

/** 未保存のセルの変更（読み直した後の DB の数と同じになったものは除く） */
export interface CellChange {
  groupId: string;
  itemId: string;
  count: number;
  /** 最初に編集したときの DB の行の updated_at（行がなければ null）。楽観ロックに送る */
  updatedAt: string | null;
}

const requestIndex = (t: Pick<RequestsTables, 'requests'>) => {
  const reqs = new Map<string, RequestDbRow>();
  for (const r of t.requests) reqs.set(cellKey(r.group_id, r.item_id), r);
  return reqs;
};

/**
 * 未保存のセルを、今の DB の行と突き合わせて変更の一覧にする（DB にない団体・品目と、DB の数と同じになったものは捨てる）。
 * updatedAt は今の行ではなく、編集したときの行（基準）のもの。読み直しの後にほかの人が変えていれば DB が conflict を返す。
 * 申請一覧の全団体（絞り込みの前）の行を渡す。
 */
export function pendingChanges(pending: PendingCells, t: RequestsTables): CellChange[] {
  const reqs = requestIndex(t);
  const groups = new Map(t.groups.map((g) => [g.id, g]));
  const items = new Map(t.items.map((i) => [i.id, i]));
  const out: CellChange[] = [];
  for (const [key, cell] of Object.entries(pending)) {
    const [groupId, itemId] = key.split(':') as [string, string];
    const g = groups.get(groupId);
    const item = items.get(itemId);
    if (!g || !item) continue;
    const row = reqs.get(key);
    if ((row?.count ?? 0) === cell.value) continue;
    // 申請できない品目は 0 にすることだけを許す（DB のトリガーも 0 でない値を E006 で止める）
    if (!isRequestable(item, g.category) && cell.value !== 0) continue;
    out.push({ groupId, itemId, count: cell.value, updatedAt: cell.baseUpdatedAt });
  }
  return out.sort((a, b) => compareStrings(a.groupId, b.groupId) || compareStrings(a.itemId, b.itemId));
}

/** 当て直しの結果：残す未保存のセルと、ほかの人が先に変えたので読み直した値に戻したセルの鍵 */
export interface RebaseResult {
  pending: PendingCells;
  conflicts: string[];
}

/**
 * 読み直した表・戻した下書きに、未保存のセルを当て直す（3.6）。
 * - なくなった団体・品目のセルと、DB の数と同じになったセル（自分の保存が届いていた・ほかの人が同じ数にした）は外す。
 * - 編集したときの行（基準）から DB の行が変わったセル（updated_at が違う・行ができた・行が消えた）は、読み直した値に戻し
 *   （未保存から外し）、conflicts に入れる（画面が印をつける）。黙って上書きしないため。
 * 何も変わらなければ同じ pending を返す。
 */
export function rebasePending(pending: PendingCells, t: RequestsTables): RebaseResult {
  const reqs = requestIndex(t);
  const groups = new Set(t.groups.map((g) => g.id));
  const items = new Set(t.items.map((i) => i.id));
  const next: Record<string, PendingCell> = {};
  const conflicts: string[] = [];
  let changed = false;
  for (const [key, cell] of Object.entries(pending)) {
    const [groupId, itemId] = key.split(':') as [string, string];
    const row = reqs.get(key);
    const count = row?.count ?? 0;
    if (!groups.has(groupId) || !items.has(itemId) || count === cell.value) {
      changed = true;
      continue;
    }
    if ((row?.updated_at ?? null) !== cell.baseUpdatedAt) {
      changed = true;
      conflicts.push(key);
      continue;
    }
    next[key] = cell;
  }
  return changed ? { pending: next, conflicts } : { pending, conflicts };
}

/**
 * 基準を今の行に付け替える（値は残す）。締切後の保存の conflict（2.5：変えたセルの値は残して印をつけ、次の保存は新しい
 * updated_at で送る）と、自分が保存したセルにその後で入れた値に使う。行の数と同じになったセルは外す。
 */
export function rebaseKeysTo(pending: PendingCells, keys: Iterable<string>, t: RequestsTables): PendingCells {
  const reqs = requestIndex(t);
  const next: Record<string, PendingCell> = { ...pending };
  for (const key of keys) {
    const cell = next[key];
    if (!cell) continue;
    const row = reqs.get(key);
    const baseCount = row?.count ?? 0;
    if (baseCount === cell.value) delete next[key];
    else next[key] = { value: cell.value, baseCount, baseUpdatedAt: row?.updated_at ?? null };
  }
  return next;
}

/** 下書きから読んだ値を未保存のセルにする（形の違う値・範囲の外の数は捨てる。古い形の下書きを読んでも壊れない） */
export function normalizePending(value: unknown): PendingCells {
  const out: Record<string, PendingCell> = {};
  if (!value || typeof value !== 'object' || Array.isArray(value)) return out;
  const isCount = (n: unknown): n is number => typeof n === 'number' && Number.isInteger(n) && n >= 0 && n <= MAX_COUNT;
  for (const [key, raw] of Object.entries(value as Record<string, unknown>)) {
    if (!/^[^:]+:[^:]+$/.test(key) || !raw || typeof raw !== 'object') continue;
    const c = raw as Record<string, unknown>;
    const base = c.baseUpdatedAt;
    if (!isCount(c.value) || !isCount(c.baseCount) || !(base === null || typeof base === 'string')) continue;
    out[key] = { value: c.value, baseCount: c.baseCount, baseUpdatedAt: base };
  }
  return out;
}

/** 二つの未保存のセルが同じか（下書きを書き直すかどうか） */
export function samePending(a: PendingCells, b: PendingCells): boolean {
  if (a === b) return true;
  const ka = Object.keys(a);
  if (ka.length !== Object.keys(b).length) return false;
  return ka.every((k) => {
    const x = a[k]!;
    const y = b[k];
    return !!y && x.value === y.value && x.baseCount === y.baseCount && x.baseUpdatedAt === y.baseUpdatedAt;
  });
}

/** 品目ごとの合計（表示している行の、未保存の値を当てた数） */
export function columnTotals(matrix: RequestMatrix, pending: PendingCells): Record<string, number> {
  const totals: Record<string, number> = {};
  for (const item of matrix.items) {
    totals[item.id] = matrix.rows.reduce((s, r) => s + shownCount(pending, r, item.id), 0);
  }
  return totals;
}

/** 締切後の保存：団体ごとの p_rows（行がある品目は updatedAt を付ける） */
export function groupDeadlineRows(changes: readonly CellChange[]): Map<string, { itemId: string; count: number; updatedAt?: string }[]> {
  const out = new Map<string, { itemId: string; count: number; updatedAt?: string }[]>();
  for (const c of changes) {
    const list = out.get(c.groupId) ?? [];
    list.push({ itemId: c.itemId, count: c.count, ...(c.updatedAt ? { updatedAt: c.updatedAt } : {}) });
    out.set(c.groupId, list);
  }
  return out;
}

// ---------------------------------------------------------------- 前年の数（休憩所の代理入力）

export interface PreviousYearRequest {
  group_name: string;
  item_id: string;
  count: number;
}

/**
 * 前年度の申請（previous_year_requests。団体名つき）から、その団体名の数を入力欄の品目に当てる。
 * 入力欄にない品目（今年の区分で申請できない品目）は入れない。前年に行がない品目は 0。
 */
export function previousCountsFor(rows: readonly PreviousYearRequest[], groupName: string, fields: readonly RequestField[]): Record<string, number> {
  const mine = new Map(rows.filter((r) => r.group_name === groupName).map((r) => [r.item_id, r.count]));
  const out: Record<string, number> = {};
  for (const f of fields) out[f.item.id] = mine.get(f.item.id) ?? 0;
  return out;
}

/** 前年の団体名の行があるか */
export function hasPreviousFor(rows: readonly PreviousYearRequest[], groupName: string): boolean {
  return rows.some((r) => r.group_name === groupName);
}

/** 今年の申請がまだない（0 でない行がない）か。休憩所の「前年の数を入れる」を出す条件 */
export function hasNoRequests(requests: readonly Pick<RequestDbRow, 'count'>[]): boolean {
  return requests.every((r) => r.count === 0);
}

// ---------------------------------------------------------------- 読む

/** 団体代表の申請の画面のデータ（自団体だけ） */
export interface RepRequestData {
  group: GroupRow;
  items: ItemRow[];
  /** 使用場所の名前（なければ null＝校内に分散） */
  locationName: string | null;
  requests: RequestDbRow[];
  submission: SubmissionRow | null;
  loadedAt: string;
}

/** 自団体の申請を読む（RLS で自団体だけ。団体が読めなければ not_found） */
export async function fetchRepRequest(groupId: string, client: AppSupabaseClient = getSupabase()): Promise<RepRequestData> {
  const [g, i, r, s] = await Promise.all([
    client.from('groups').select(COLUMNS.groups).eq('id', groupId).maybeSingle(),
    client.from('items').select(COLUMNS.items).order('sort_order').order('id'),
    client.from('requests').select(COLUMNS.requests).eq('group_id', groupId).order('item_id'),
    client.from('request_submissions').select(COLUMNS.request_submissions).eq('group_id', groupId).maybeSingle(),
  ]);
  for (const res of [g, i, r, s]) if (res.error) throw toAppError(res.error, res.status);
  const group = g.data as unknown as GroupRow | null;
  if (!group) throw appError('not_found', 'group_missing', { groupId });
  let locationName: string | null = null;
  if (group.location_room_id) {
    const room = await client.from('rooms').select('id, name').eq('id', group.location_room_id).maybeSingle();
    if (room.error) throw toAppError(room.error, room.status);
    locationName = room.data?.name ?? null;
  }
  return {
    group,
    items: (i.data ?? []) as unknown as ItemRow[],
    locationName,
    requests: (r.data ?? []) as unknown as RequestDbRow[],
    submission: (s.data ?? null) as unknown as SubmissionRow | null,
    loadedAt: new Date().toISOString(),
  };
}

/** 提出の記録だけを読み直す（提出の直前に、ほかの代表者の提出を確かめる） */
export async function fetchSubmission(groupId: string, client: AppSupabaseClient = getSupabase()): Promise<SubmissionRow | null> {
  const res = await client.from('request_submissions').select(COLUMNS.request_submissions).eq('group_id', groupId).maybeSingle();
  if (res.error) throw toAppError(res.error, res.status);
  return (res.data ?? null) as unknown as SubmissionRow | null;
}

/** 読み込んだ後にほかの代表者が提出したか（submitted_at が読み込んだときより新しい） */
export function submittedByOthers(loaded: Pick<SubmissionRow, 'submitted_at'> | null, fresh: Pick<SubmissionRow, 'submitted_at'> | null): boolean {
  const a = ms(loaded?.submitted_at ?? null);
  const b = ms(fresh?.submitted_at ?? null);
  return b !== null && (a === null || b > a);
}

/** 1団体の申請と提出の記録（代理入力の提出の直前に読み直す） */
export interface GroupRequestState {
  requests: RequestDbRow[];
  submission: SubmissionRow | null;
}

/** 1団体の申請と提出の記録を読み直す（代理入力の締切前の提出の直前。submit_requests は楽観ロックを取らないので、送る前に確かめる） */
export async function fetchGroupRequestState(groupId: string, client: AppSupabaseClient = getSupabase()): Promise<GroupRequestState> {
  const [r, submission] = await Promise.all([
    client.from('requests').select(COLUMNS.requests).eq('group_id', groupId).order('item_id'),
    fetchSubmission(groupId, client),
  ]);
  if (r.error) throw toAppError(r.error, r.status);
  const requests = ((r.data ?? []) as unknown as RequestDbRow[]).filter((x) => x.group_id === groupId);
  return { requests, submission };
}

/** 読み込んだ表の行から、ほかの人が変えたもの（品目ごとの数・提出の記録） */
export interface GroupChanges {
  /** updated_at が変わった（行が増えた・消えたを含む）品目。from は読み込んだときの数、to は読み直した数 */
  items: { itemId: string; from: number; to: number }[];
  /** 提出日時か備考が変わった */
  submission: boolean;
}

/** 表の行（読み込んだとき）と読み直した団体の申請・提出の記録を比べる（updated_at・submitted_at・備考） */
export function groupChangesSince(row: Pick<MatrixRow, 'cells' | 'submission'>, fresh: GroupRequestState): GroupChanges {
  const freshBy = new Map(fresh.requests.map((r) => [r.item_id, r]));
  const ids = new Set<string>([...Object.values(row.cells).filter((c) => c.updatedAt !== null).map((c) => c.itemId), ...freshBy.keys()]);
  const items: GroupChanges['items'] = [];
  for (const itemId of ids) {
    const cell = row.cells[itemId];
    const now = freshBy.get(itemId);
    if (ms(cell?.updatedAt ?? null) !== ms(now?.updated_at ?? null)) items.push({ itemId, from: cell?.count ?? 0, to: now?.count ?? 0 });
  }
  const a = row.submission;
  const b = fresh.submission;
  const submission = ms(a?.submitted_at ?? null) !== ms(b?.submitted_at ?? null) || (a?.note ?? null) !== (b?.note ?? null);
  return { items, submission };
}

/** ほかの人の変更があるか */
export function hasGroupChanges(c: GroupChanges): boolean {
  return c.items.length > 0 || c.submission;
}

export function useRepRequest(yearId: string | null | undefined, groupId: string | null) {
  return useQuery({
    queryKey: queryKeys.yearPart(yearId ?? '', 'request', groupId ?? ''),
    queryFn: () => fetchRepRequest(groupId!),
    enabled: !!yearId && !!groupId,
  });
}

/** 年度で絞るために groups を inner join した行から、join の列を外す */
const dropJoin = <T>(rows: readonly Record<string, unknown>[]): T[] =>
  rows.map((r) => {
    const { groups: _groups, ...rest } = r;
    void _groups;
    return rest as T;
  });

/** 申請一覧の表を読む（団体・品目・申請・提出。申請と提出は `groups!inner(year_id)` で年度に絞る） */
export async function fetchRequestsTables(yearId: string, client: AppSupabaseClient = getSupabase()): Promise<RequestsTables & { loadedAt: string }> {
  const groups = client.from('groups').select(COLUMNS.groups).eq('year_id', yearId).order('sort_order').order('id');
  const items = client.from('items').select(COLUMNS.items).order('sort_order').order('id');
  const submissions = client
    .from('request_submissions')
    .select(`${COLUMNS.request_submissions}, groups!inner(year_id)`)
    .eq('groups.year_id', yearId)
    .order('group_id');
  const requests = fetchAll((from, to) =>
    client
      .from('requests')
      .select(`${COLUMNS.requests}, groups!inner(year_id)`)
      .eq('groups.year_id', yearId)
      .order('group_id')
      .order('item_id')
      .range(from, to),
  );
  const [g, i, s, r] = await Promise.all([groups, items, submissions, requests]);
  for (const res of [g, i, s]) if (res.error) throw toAppError(res.error, res.status);
  return {
    groups: (g.data ?? []) as unknown as GroupRow[],
    items: (i.data ?? []) as unknown as ItemRow[],
    submissions: dropJoin<SubmissionRow>((s.data ?? []) as unknown as Record<string, unknown>[]),
    requests: dropJoin<RequestDbRow>(r as unknown as Record<string, unknown>[]),
    loadedAt: new Date().toISOString(),
  };
}

export function useRequestsTables(yearId: string | null | undefined) {
  return useQuery({
    queryKey: queryKeys.yearPart(yearId ?? '', 'requests'),
    queryFn: () => fetchRequestsTables(yearId!),
    enabled: !!yearId,
  });
}

/** 前年度の申請（admin。休憩所の代理入力の「前年の数を入れる」） */
export async function fetchPreviousYearRequests(yearId: string): Promise<PreviousYearRequest[]> {
  const rows = await callRpc('previous_year_requests', { p_year_id: yearId });
  return (rows ?? []) as PreviousYearRequest[];
}

// ---------------------------------------------------------------- 書く

/** セルごとの結果。失敗は AppError（conflict・not_found・forbidden・issue など） */
export type CellResult = { change: CellChange; ok: true } | { change: CellChange; ok: false; error: AppError };

/**
 * 締切前の申請一覧のセルを直接書く（3.6）。行があれば updateWithLock（updated_at で楽観ロック）、なければ insert。
 * セルごとに順に送り、結果を返す。forbidden（RLS で拒否＝締切・権限が変わった）が出たら、残りは送らずに止める
 * （同じ直接の書き込みを繰り返さない。呼ぶ側が年度を読み直して書き方を決める）。止めたセルは結果に入らない。
 */
export async function saveCellsDirect(changes: readonly CellChange[], client: AppSupabaseClient = getSupabase()): Promise<CellResult[]> {
  const out: CellResult[] = [];
  for (const change of changes) {
    try {
      if (change.updatedAt) {
        await updateWithLock(client, 'requests', { group_id: change.groupId, item_id: change.itemId }, change.updatedAt, {
          count: change.count,
        });
      } else {
        const res = await client
          .from('requests')
          .insert({ group_id: change.groupId, item_id: change.itemId, count: change.count })
          .select(COLUMNS.requests)
          .maybeSingle();
        if (res.error) throw toAppError(res.error, res.status);
        if (!res.data) throw appError('forbidden', 'insert_hidden');
      }
      out.push({ change, ok: true });
    } catch (e) {
      const error = toAppError(e);
      out.push({ change, ok: false, error });
      if (error.info.kind === 'forbidden') break;
    }
  }
  return out;
}

/** 団体ごとの結果 */
export type GroupResult = { groupId: string; ok: true } | { groupId: string; ok: false; error: AppError };

/**
 * 締切後の申請一覧の保存（3.6）：団体ごとに update_requests_after_deadline（理由は必須）。順に送り、団体ごとの結果を返す。
 * forbidden・state（権限・年度の状態が変わった）が出たら、残りは送らずに止める。
 */
export async function saveGroupsAfterDeadline(
  rowsByGroup: ReadonlyMap<string, { itemId: string; count: number; updatedAt?: string }[]>,
  reason: string,
): Promise<GroupResult[]> {
  const out: GroupResult[] = [];
  for (const [groupId, rows] of rowsByGroup) {
    try {
      await callRpc('update_requests_after_deadline', { p_group_id: groupId, p_rows: rows, p_reason: reason });
      out.push({ groupId, ok: true });
    } catch (e) {
      const error = toAppError(e);
      out.push({ groupId, ok: false, error });
      if (error.info.kind === 'forbidden' || error.info.kind === 'state') break;
    }
  }
  return out;
}

/** 団体代表と、締切前の代理入力の提出（申請と提出を1回で。3.5・3.6） */
export async function submitRequests(groupId: string, rows: { itemId: string; count: number }[], note: string | null): Promise<SubmissionRow> {
  const res = await callRpc('submit_requests', { p_group_id: groupId, p_rows: rows, p_note: note });
  return res as unknown as SubmissionRow;
}

/** 締切後の代理入力：変えた品目と、提出済みにする・備考（理由は必須） */
export async function submitAfterDeadline(
  groupId: string,
  rows: { itemId: string; count: number; updatedAt?: string }[],
  note: string | null,
  reason: string,
): Promise<void> {
  await callRpc('update_requests_after_deadline', {
    p_group_id: groupId,
    p_rows: rows,
    p_reason: reason,
    p_submission: { submitted: true, note },
  });
}

/**
 * 締切前に「提出済みにする」（3.6・2.3 の例外）：request_submissions を直接 upsert する。submitted_at に今の時刻を送る
 * （トリガーは送られた値が null でないときだけ now() に置き換えるので、値を送らないと提出済みにならない。送った値は使われない）。
 * note は送らず、今の備考を消さない。RLS で拒否されたら forbidden。
 */
export async function markSubmittedDirect(groupId: string, client: AppSupabaseClient = getSupabase()): Promise<SubmissionRow> {
  const res = await client
    .from('request_submissions')
    .upsert({ group_id: groupId, submitted_at: new Date().toISOString() }, { onConflict: 'group_id' })
    .select(COLUMNS.request_submissions)
    .maybeSingle();
  if (res.error) throw toAppError(res.error, res.status);
  if (!res.data) throw appError('forbidden', 'upsert_hidden');
  return res.data as unknown as SubmissionRow;
}

/** 締切後に「提出済みにする」：update_requests_after_deadline の p_submission（rows は空。理由は必須） */
export async function markSubmittedAfterDeadline(groupId: string, reason: string): Promise<void> {
  await callRpc('update_requests_after_deadline', {
    p_group_id: groupId,
    p_rows: [],
    p_reason: reason,
    p_submission: { submitted: true },
  });
}
