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
import { decideAbsoluteSave, type AbsoluteSaveDecision, type AbsoluteSaveEntry } from '@/lib/data/absolute-save';
import { AppError, appError, classifyError, toAppError } from '@/lib/errors';
import { queryKeys } from '@/lib/query';
import { callRpc } from '@/lib/rpc';
import { getSupabase, type AppSupabaseClient } from '@/lib/supabase/client';
import type { RequestsFilter } from '@/lib/schemas/requests';
import { repRequestOptions, SUBMISSION_STATE_COLUMNS, type SubmissionState } from './screen-queries';

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

/**
 * 入力の元（base）を読み直した団体の申請と提出の記録にするときの入力（/request の送る前の読み直し・代理入力。設計 2.6 の (A)）。
 * 読み直した値と同じ入力だけを外し、ほかは残す（古い入力の元と同じ値でも、入れた数として残す。前に送って応答が届かなかった
 * 自分の保存の後に元の数へ戻した入力を、読み直した自分の古い値で置き換えないため）。備考も、読み直した備考と同じときだけ null にする。
 */
export function rebaseRequestInput(
  items: readonly ItemRow[],
  category: GroupCategory,
  fresh: GroupRequestState,
  input: { edits: Readonly<Record<string, number>>; note: string | null },
): { edits: Record<string, number>; note: string | null } {
  const current = new Map(buildRequestForm(items, category, fresh.requests).fields.map((f) => [f.item.id, f.current]));
  const edits = Object.fromEntries(Object.entries(input.edits).filter(([id, v]) => v !== current.get(id)));
  return { edits, note: input.note === (fresh.submission?.note ?? '') ? null : input.note };
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
  submission: SubmissionState | null;
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
  submissions: SubmissionState[];
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

/** 未保存のセル（セルの鍵 → 入れた数と基準）。下書きにもこの形で置く */
export type PendingCells = Readonly<Record<string, PendingCell>>;

/**
 * セルに数を入れる（最初の編集のときだけ入力の元〔基準〕を今の行から取る）。
 * 編集を始めていないセルに今の行と同じ数を入れたときだけ、未保存にしない。一度入れたセルは、入力の元と同じ数に戻しても
 * 未保存（value = baseCount）として残す：表が古いまま（前に送って応答が届かなかった保存の後に、読み直しも落ちたなど）だと、
 * 戻した数が DB の今の数と違っても画面からは分からないため（設計 2.6 の (A) の (1)。入力を黙って捨てない）。
 * DB の数と同じなら、表を当て直すとき（rebasePending）と保存のときに外れる。
 */
export function setPendingCell(
  pending: PendingCells,
  groupId: string,
  itemId: string,
  value: number,
  cell: Pick<MatrixCell, 'count' | 'updatedAt'>,
): PendingCells {
  const key = cellKey(groupId, itemId);
  const prev = pending[key];
  if (!prev && value === cell.count) return pending;
  return { ...pending, [key]: { value, baseCount: prev ? prev.baseCount : cell.count, baseUpdatedAt: prev ? prev.baseUpdatedAt : cell.updatedAt } };
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

/**
 * 読み直した表・戻した下書きに、未保存のセルを当て直す（3.6・設計 2.6 の (A)）。裏の読み直しでは入力を捨てない：
 * - なくなった団体・品目のセルと、DB の数が入れた数と同じになったセル（自分の保存が届いていた・同じ数になった）だけを外す。
 * - ほかのセルは、入れた数も入力の元（編集したときの行）も残す。行が入力の元から変わっていても戻さない
 *   （ほかの人の変更かどうかは、保存を押したときの読み直し〔judgePendingCells〕で決めて確かめる）。
 * 何も変わらなければ同じ pending を返す。
 */
export function rebasePending(pending: PendingCells, t: RequestsTables): PendingCells {
  const reqs = requestIndex(t);
  const groups = new Set(t.groups.map((g) => g.id));
  const items = new Set(t.items.map((i) => i.id));
  const next: Record<string, PendingCell> = {};
  let changed = false;
  for (const [key, cell] of Object.entries(pending)) {
    const [groupId, itemId] = key.split(':') as [string, string];
    if (!groups.has(groupId) || !items.has(itemId) || (reqs.get(key)?.count ?? 0) === cell.value) {
      changed = true;
      continue;
    }
    next[key] = cell;
  }
  return changed ? next : pending;
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

/** 送る前の読み直しで見つかった、編集した後に数が変わったセル（上書きするか読み直すかを確かめる） */
export interface CellConflict {
  key: string;
  groupId: string;
  itemId: string;
  /** 入力の元（編集したときの行）の数 */
  base: number;
  /** 読み直した数 */
  fresh: number;
  /** 入れた数 */
  value: number;
}

/**
 * 送る前に読み直した表で、未保存のセルをセルごとに決める（設計 2.6 の (A)。decideAbsoluteSave）。
 * saved：DB がすでに入れた数（前に送って応答が届かなかった保存が通っていた）。conflicts：入力の元から行が変わり、
 * 数が入力の元とも入れた数とも違う（ほかの人の変更とする）。ほかは送る。
 * セルの直接の更新は書いた人を残さない（requests に書いた人の列がなく、提出の記録も書かない）ので、値でしか決められない。
 * 応答が届かなかった自分の保存の後に入れ直したセルもここに出る（決まり (3) の「値で決める」を取る。notes/T11.md の決めたこと 33）。
 */
export function judgePendingCells(pending: PendingCells, t: Pick<RequestsTables, 'requests'>): { saved: string[]; conflicts: CellConflict[] } {
  const reqs = requestIndex(t);
  const saved: string[] = [];
  const conflicts: CellConflict[] = [];
  for (const [key, cell] of Object.entries(pending)) {
    const row = reqs.get(key);
    const fresh = row?.count ?? 0;
    const d = decideAbsoluteSave([
      { input: cell.value, base: cell.baseCount, fresh, changed: (row?.updated_at ?? null) !== cell.baseUpdatedAt },
    ]);
    if (d === 'saved') saved.push(key);
    if (d !== 'conflict') continue;
    const [groupId, itemId] = key.split(':') as [string, string];
    conflicts.push({ key, groupId, itemId, base: cell.baseCount, fresh, value: cell.value });
  }
  return { saved, conflicts: conflicts.sort((a, b) => compareStrings(a.key, b.key)) };
}

const isCount = (n: unknown): n is number => typeof n === 'number' && Number.isInteger(n) && n >= 0 && n <= MAX_COUNT;

/** 下書きから読んだ値を未保存のセルにする（形の違う値・範囲の外の数は捨てる。古い形の下書きを読んでも壊れない） */
export function normalizePending(value: unknown): PendingCells {
  const out: Record<string, PendingCell> = {};
  if (!value || typeof value !== 'object' || Array.isArray(value)) return out;
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

/** 申請一覧の保存の結果の文の頭（「N 件を保存しました。M 件は保存できませんでした。K 件は保存できたか分かりません（L 件は送っていません）」） */
export function saveSummary(
  unit: '件' | '団体',
  n: { saved: number; failed: number; uncertain: number; notSent: number },
): string {
  const sentences = [`${n.saved} ${unit}を保存しました`];
  if (n.failed > 0) sentences.push(`${n.failed} ${unit}は保存できませんでした`);
  if (n.uncertain > 0) sentences.push(`${n.uncertain} ${unit}は保存できたか分かりません`);
  return `${sentences.join('。')}${n.notSent > 0 ? `（${n.notSent} ${unit}は送っていません）` : ''}`;
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

// 自団体の申請の画面のデータ（fetchRepRequest）と提出の記録の型・列は lib/data/screen-queries.ts に置く（先読み。D-45）
export {
  fetchRepRequest,
  planRequestPrefetch,
  repRequestOptions,
  SUBMISSION_STATE_COLUMNS,
  type RepRequestData,
  type SubmissionState,
} from './screen-queries';

/** 提出の記録だけを読み直す（updated_by も読む。送る前の読み直し・「提出済みにする」・取り込み） */
export async function fetchSubmission(groupId: string, client: AppSupabaseClient = getSupabase()): Promise<SubmissionState | null> {
  const res = await client
    .from('request_submissions')
    .select(SUBMISSION_STATE_COLUMNS)
    .eq('group_id', groupId)
    .maybeSingle();
  if (res.error) throw toAppError(res.error, res.status);
  return (res.data ?? null) as unknown as SubmissionState | null;
}

/** 1団体の申請と提出の記録（送る前に読み直す。入力の元〔base〕にもこの形を使う） */
export interface GroupRequestState {
  requests: RequestDbRow[];
  submission: SubmissionState | null;
}

/** 1団体の申請と提出の記録を読み直す（申請・代理入力の送る前。2.6） */
export async function fetchGroupRequestState(groupId: string, client: AppSupabaseClient = getSupabase()): Promise<GroupRequestState> {
  const [r, submission] = await Promise.all([
    client.from('requests').select(COLUMNS.requests).eq('group_id', groupId).order('item_id'),
    fetchSubmission(groupId, client),
  ]);
  if (r.error) throw toAppError(r.error, r.status);
  const requests = ((r.data ?? []) as unknown as RequestDbRow[]).filter((x) => x.group_id === groupId);
  return { requests, submission };
}

/** 送る入力（入力欄の品目すべての数と、送る備考。締切後に備考を送らないときは入力の元の備考） */
export interface GroupSaveInput {
  counts: Readonly<Record<string, number>>;
  note: string | null;
}

const normalizedNote = (n: string | null | undefined): string | null => {
  const t = (n ?? '').trim();
  return t === '' ? null : t;
};

/**
 * 自分の提出が書いた時刻（ミリ秒）。読み直した提出の記録の updated_by が自分のときだけ、その updated_at を返す。
 * submit_requests と update_requests_after_deadline（p_submission つき）は、申請の行と提出の記録を1つのトランザクションで書く
 * （updated_at はどちらも now()＝トランザクションの開始の時刻）ので、この時刻に書かれた申請の行は自分の提出が書いたもの。
 */
function ownSubmitAt(fresh: GroupRequestState, userId: string): number | null {
  const s = fresh.submission;
  return s && s.updated_by === userId ? ms(s.updated_at) : null;
}

/** 読み直した申請の行が、自分の提出（ownSubmitAt）で書かれたものか */
const writtenByOwnSubmit = (row: Pick<RequestDbRow, 'updated_at'> | undefined, own: number | null): boolean =>
  own !== null && !!row && ms(row.updated_at) === own;

/**
 * 申請・代理入力の送る前の判定（設計 2.6 の (A)。decideAbsoluteSave に品目ごとと提出の記録を渡す）。
 * - 品目：数で比べ、行の updated_at（行の有無を含む）が入力の元から変わったかを見る。自分の提出で書かれた行（提出の記録の
 *   updated_by が自分で、行の updated_at がその記録の updated_at と同じ。前に送って応答が届かなかった提出など）は
 *   ほかの人の変更としない。ほかは requests が書いた人を持たないので、読み直した数が入力の元とも入力とも違えばほかの人の変更とする。
 * - 提出の記録：「提出済みか・備考」で比べ、updated_at が変わったかを見る。ほかの人の変更かは updated_by（自分でなければ。null も）。
 * 'saved' は DB がすでに入力と同じ（前に送って応答が届かなかった保存が通っていた）、'conflict' はほかの人の変更がある、'send' は送る。
 */
export function decideGroupSave(base: GroupRequestState, fresh: GroupRequestState, input: GroupSaveInput, userId: string): AbsoluteSaveDecision {
  const baseBy = new Map(base.requests.map((r) => [r.item_id, r]));
  const freshBy = new Map(fresh.requests.map((r) => [r.item_id, r]));
  const own = ownSubmitAt(fresh, userId);
  const entries: AbsoluteSaveEntry<number | string>[] = Object.entries(input.counts).map(([itemId, count]) => {
    const b = baseBy.get(itemId);
    const f = freshBy.get(itemId);
    const entry: AbsoluteSaveEntry<number | string> = {
      input: count,
      base: b?.count ?? 0,
      fresh: f?.count ?? 0,
      changed: ms(b?.updated_at ?? null) !== ms(f?.updated_at ?? null),
    };
    if (writtenByOwnSubmit(f, own)) entry.byOther = false;
    return entry;
  });
  const sub = (s: SubmissionState | null) => JSON.stringify([!!s?.submitted_at, normalizedNote(s?.note)]);
  const bs = base.submission;
  const fs = fresh.submission;
  entries.push({
    input: JSON.stringify([true, normalizedNote(input.note)]),
    base: sub(bs),
    fresh: sub(fs),
    changed: ms(bs?.updated_at ?? null) !== ms(fs?.updated_at ?? null),
    byOther: !!fs && fs.updated_by !== userId,
  });
  return decideAbsoluteSave(entries);
}

/** 入力の元から、ほかの人が変えたもの（ほかの人の保存のダイアログに出す。品目ごとの数・提出の記録） */
export interface GroupChanges {
  /**
   * 数が変わった品目（from は入力の元の数、to は読み直した数。行がなければ 0）。行が書き直されても数が同じ品目（ほかの人の
   * 初めての提出で count 0 の行が入った品目・同じ数での出し直し）は挙げない。自分の提出で書かれた行は除く。
   */
  items: { itemId: string; from: number; to: number }[];
  /** ほかの人（updated_by が自分でない）が提出の記録を書き直した（提出日時・備考、または updated_at だけ） */
  submission: boolean;
  /** submission のうち、提出日時が変わった */
  submittedAt: boolean;
  /** submission のうち、備考が変わった（前後の空白を除き、空は null として比べる） */
  note: boolean;
}

/**
 * 二つの団体の申請・提出の記録を比べる（base は入力の元、fresh は読み直したもの）。自分の書いたもの（提出の記録の updated_by が
 * 自分、その提出で書かれた申請の行）は挙げない（前に送って応答が届かなかった自分の提出を、ほかの人の提出として出さない）。
 */
export function stateChangesSince(base: GroupRequestState, fresh: GroupRequestState, userId: string): GroupChanges {
  const baseBy = new Map(base.requests.map((r) => [r.item_id, r]));
  const freshBy = new Map(fresh.requests.map((r) => [r.item_id, r]));
  const own = ownSubmitAt(fresh, userId);
  const ids = new Set<string>([...baseBy.keys(), ...freshBy.keys()]);
  const items: GroupChanges['items'] = [];
  for (const itemId of ids) {
    const was = baseBy.get(itemId);
    const now = freshBy.get(itemId);
    if (writtenByOwnSubmit(now, own)) continue;
    const from = was?.count ?? 0;
    const to = now?.count ?? 0;
    if (from !== to && ms(was?.updated_at ?? null) !== ms(now?.updated_at ?? null)) items.push({ itemId, from, to });
  }
  const a = base.submission;
  const b = fresh.submission;
  const submittedAt = ms(a?.submitted_at ?? null) !== ms(b?.submitted_at ?? null);
  const note = normalizedNote(a?.note) !== normalizedNote(b?.note);
  // 提出日時・備考が同じでも、記録が書き直されていれば（同じ内容での出し直しなど）変わったとする。自分が書き直したものは除く
  const rewritten = submittedAt || (a?.note ?? null) !== (b?.note ?? null) || ms(a?.updated_at ?? null) !== ms(b?.updated_at ?? null);
  const submission = rewritten && !(b && b.updated_by === userId);
  return { items, submission, submittedAt: submission && submittedAt, note: submission && note };
}

/** 提出の記録の変更を、知らせ・確かめのダイアログに出す名前にする（変わったものだけ。どちらも同じなら「提出の記録」） */
export function submissionChangeLabels(c: Pick<GroupChanges, 'submission' | 'submittedAt' | 'note'>): string[] {
  if (!c.submission) return [];
  const out: string[] = [];
  if (c.submittedAt) out.push('提出日時');
  if (c.note) out.push('備考');
  return out.length > 0 ? out : ['提出の記録'];
}

/**
 * 裏で届いた団体の申請と提出の記録（latest：画面のクエリ・表の行）にある、入力の元より新しいほかの人の変更（R1 の知らせに出す）。
 * stateChangesSince のうち、latest の方が新しいもの（入力の元になかった行・updated_at が入力の元より後の行、updated_at が後の
 * 提出の記録）だけを挙げる。届いた行が入力の元より古い（送る前に読み直した行を入力の元にした後に、表がまだ読み直されていない）
 * ときは挙げない。自分の書いたものは stateChangesSince と同じく挙げない。
 */
export function newerChangesSince(base: GroupRequestState, latest: GroupRequestState, userId: string): GroupChanges {
  // 届いた提出の記録に書いた人がない（updated_by のキーがない）ときは、自分の提出かもしれないので、その記録とその提出で
  // 書かれた行はほかの人の変更と言い切らない（自分の書いたものとして扱う）
  const ls = latest.submission;
  const known = ls && ls.updated_by === undefined ? { ...latest, submission: { ...ls, updated_by: userId } } : latest;
  const c = stateChangesSince(base, known, userId);
  const baseBy = new Map(base.requests.map((r) => [r.item_id, r]));
  const latestBy = new Map(latest.requests.map((r) => [r.item_id, r]));
  const newer = (was: string | null | undefined, now: string | null | undefined) => {
    const n = ms(now ?? null);
    if (n === null) return false;
    const w = ms(was ?? null);
    return w === null || n > w;
  };
  const submission = c.submission && newer(base.submission?.updated_at, latest.submission?.updated_at);
  return {
    items: c.items.filter((i) => newer(baseBy.get(i.itemId)?.updated_at, latestBy.get(i.itemId)?.updated_at)),
    submission,
    submittedAt: submission && c.submittedAt,
    note: submission && c.note,
  };
}

/** 知らせに出す変更があるか */
export const hasGroupChanges = (c: GroupChanges): boolean => c.items.length > 0 || c.submission;

/**
 * 知らせの「ほかの人の値を読み込む」：入力の元を届いた記録（latest）にし、ほかの人が数を変えた品目と（ほかの人が備考を変えていれば）
 * 備考は届いた値にする。ほかの入れた数と書き換えた備考は残す（rebaseRequestInput。ほかの人が変えていない品目・備考は入力の元と
 * 同じ値なので、意味は変わらない。数を変えずに行だけが書き直された品目・備考を変えない出し直しでも、入力は捨てない）。
 */
export function adoptGroupChanges(
  items: readonly ItemRow[],
  category: GroupCategory,
  latest: GroupRequestState,
  changes: GroupChanges,
  input: { edits: Readonly<Record<string, number>>; note: string | null },
): { edits: Record<string, number>; note: string | null } {
  const next = rebaseRequestInput(items, category, latest, input);
  for (const c of changes.items) delete next.edits[c.itemId];
  return { edits: next.edits, note: changes.note ? null : next.note };
}

/** 表の行を、読み直した団体の申請・提出の記録と同じ形にする（代理入力の入力の元） */
export function groupStateOf(row: Pick<MatrixRow, 'group' | 'cells' | 'submission'>): GroupRequestState {
  return {
    requests: Object.values(row.cells)
      .filter((c) => c.updatedAt !== null)
      .map((c) => ({ group_id: row.group.id, item_id: c.itemId, count: c.count, updated_at: c.updatedAt! })),
    submission: row.submission,
  };
}

/**
 * /request の下書き（団体ごと。1.4）：入れた数・書き換えた備考と、最初に編集したときの入力の元（申請の行と提出の記録）。
 * 戻した後の提出も、この入力の元と送る前に読み直した行を比べて決める（設計 2.6 の (A) の 5。離れている間のほかの人の変更を確かめる）。
 */
export interface RequestDraft {
  edits: Record<string, number>;
  note: string | null;
  base: GroupRequestState;
}

const isRecord = (v: unknown): v is Record<string, unknown> => !!v && typeof v === 'object' && !Array.isArray(v);
const isStrOrNull = (v: unknown): v is string | null => v === null || typeof v === 'string';

/** 下書きから読んだ値を /request の下書きにする（形が違う・入力の元がない古い形・ほかの団体の行なら null。戻せる下書きにしない） */
export function normalizeRequestDraft(value: unknown, groupId: string): RequestDraft | null {
  if (!isRecord(value) || !isRecord(value.edits) || !isStrOrNull(value.note ?? null) || !isRecord(value.base)) return null;
  const edits: Record<string, number> = {};
  for (const [id, n] of Object.entries(value.edits)) {
    if (!isCount(n)) return null;
    edits[id] = n;
  }
  const { requests, submission } = value.base;
  if (!Array.isArray(requests)) return null;
  const rows: RequestDbRow[] = [];
  for (const r of requests) {
    if (!isRecord(r) || r.group_id !== groupId || typeof r.item_id !== 'string' || !isCount(r.count) || typeof r.updated_at !== 'string') return null;
    rows.push({ group_id: groupId, item_id: r.item_id, count: r.count, updated_at: r.updated_at });
  }
  let sub: SubmissionState | null = null;
  if (submission != null) {
    const x = submission;
    if (!isRecord(x) || x.group_id !== groupId || !isStrOrNull(x.submitted_at) || !isStrOrNull(x.note) || typeof x.updated_at !== 'string') return null;
    if (!isStrOrNull(x.updated_by ?? null)) return null;
    sub = { group_id: groupId, submitted_at: x.submitted_at, note: x.note, updated_at: x.updated_at, updated_by: (x.updated_by as string | null | undefined) ?? null };
  }
  return { edits, note: (value.note as string | null | undefined) ?? null, base: { requests: rows, submission: sub } };
}

export function useRepRequest(yearId: string | null | undefined, groupId: string | null) {
  return useQuery(repRequestOptions(yearId, groupId));
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
    .select(`${SUBMISSION_STATE_COLUMNS}, groups!inner(year_id)`)
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
    submissions: dropJoin<SubmissionState>((s.data ?? []) as unknown as Record<string, unknown>[]),
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

/**
 * 締切後の代理入力：変えた品目と、提出済みにする（理由は必須）。備考は変えたときだけ送る（note が undefined なら送らない。
 * p_submission に note がなければ DB は今の備考を残すので、シートを開いた後にほかの人が変えた備考を上書きしない）。
 */
export async function submitAfterDeadline(
  groupId: string,
  rows: { itemId: string; count: number; updatedAt?: string }[],
  note: string | null | undefined,
  reason: string,
): Promise<void> {
  await callRpc('update_requests_after_deadline', {
    p_group_id: groupId,
    p_rows: rows,
    p_reason: reason,
    p_submission: note === undefined ? { submitted: true } : { submitted: true, note },
  });
}

/** 「提出済みにする」の結果。already は、すでに提出済みだった（書いていない） */
export interface MarkSubmittedResult {
  row: SubmissionRow;
  already: boolean;
}

/**
 * 締切前に「提出済みにする」（3.6・2.3 の例外）：request_submissions を直接書く。すでに提出済みの団体には書かない
 * （トリガーは submitted_at が変わると now() に置き換えるので、上書きすると最初の提出日時が今に変わってしまう）。
 * 先に提出の記録を読み、提出済みなら already で返す。記録がなければ insert、未提出の記録があれば submitted_at が空の行だけを
 * update する（submitted_at には今の時刻を送る。トリガーが now() に置き換える）。書く直前にほかの人が提出していれば
 * （0 行・一意の違反）読み直して already で返す。note は送らず、今の備考を消さない。RLS で拒否されたら forbidden。
 */
export async function markSubmittedDirect(groupId: string, client: AppSupabaseClient = getSupabase()): Promise<MarkSubmittedResult> {
  const current = await fetchSubmission(groupId, client);
  if (current?.submitted_at) return { row: current, already: true };
  const submittedAt = new Date().toISOString();
  const res = current
    ? await client
        .from('request_submissions')
        .update({ submitted_at: submittedAt })
        .eq('group_id', groupId)
        .is('submitted_at', null)
        .select(COLUMNS.request_submissions)
        .maybeSingle()
    : await client
        .from('request_submissions')
        .insert({ group_id: groupId, submitted_at: submittedAt })
        .select(COLUMNS.request_submissions)
        .maybeSingle();
  const raced = async (): Promise<MarkSubmittedResult | null> => {
    const fresh = await fetchSubmission(groupId, client);
    return fresh?.submitted_at ? { row: fresh, already: true } : null;
  };
  if (res.error) {
    const error = toAppError(res.error, res.status);
    if (error.info.code === '23505') {
      const r = await raced();
      if (r) return r;
    }
    throw error;
  }
  if (!res.data) {
    const r = await raced();
    if (r) return r;
    throw appError('forbidden', current ? 'update_hidden' : 'insert_hidden');
  }
  return { row: res.data as unknown as SubmissionRow, already: false };
}

/**
 * 締切後に「提出済みにする」：update_requests_after_deadline の p_submission（rows は空。理由は必須）。
 * 送る前に提出の記録を読み直し、すでに提出済みなら送らずにその記録を返す（送ったら null。応答が届かなかった後の押し直しも、
 * これで決まる。2.6）。
 */
export async function markSubmittedAfterDeadline(
  groupId: string,
  reason: string,
  client: AppSupabaseClient = getSupabase(),
): Promise<SubmissionState | null> {
  const current = await fetchSubmission(groupId, client);
  if (current?.submitted_at) return current;
  await callRpc('update_requests_after_deadline', {
    p_group_id: groupId,
    p_rows: [],
    p_reason: reason,
    p_submission: { submitted: true },
  });
  return null;
}
