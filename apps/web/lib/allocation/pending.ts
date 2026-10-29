// 振り分けの行の未保存の変更（画面の設計 3.9 の「行の操作」、D-34。T13 の段 2）。純粋関数。
// 行の編集はすぐに送らず、ここに溜めてから save_allocation_rows（理由が必須。楽観ロック）でまとめて送る。
// - applyPending：画面と検証に使う行。データ（運び元・品目・申請品目・数・備考）を変えた行は origin = manual、
//   固定だけなら origin は変えない（DB の save_allocation_rows の v_data_changed と同じ。備考だけの変更も manual）。
//   is_keep は DB と同じく「運び元 = 団体の使用場所」で決め直す。
// - editPending：1行1変更にまとめる（同じ行への update は1つに、元の値に戻した項目は外す。未保存の行の変更は insert に入れる）。
// - toRpcChanges：save_allocation_rows の p_changes（camelCase。update・delete は id と updatedAt）。
// - rebasePending：読み直した後に当て直す。相手の行が消えた・updated_at が変わった変更は外して一覧で返す。
// - reconcileAfterUnknown：保存されたか分からないとき（応答が届かなかった）に、変更が反映済みかを突き合わせる。
// - allowedRowOps：行ごとに出す操作（使用不可の部屋の行は運び元の変更と削除だけ。「固定を外す」は出さない）。
import { MAX_COUNT, type StoredAllocationRow } from '@gaapp/shared';
import { z } from 'zod';
import type { StoredRows } from '@/lib/data/year-data';
import type { AllocationChange } from '@/lib/rpc/payloads';
import { NOTE_MAX } from '@/lib/schemas/common';

/** 変えられる列（データの列と固定） */
export interface RowFields {
  sourceRoomId: string;
  itemId: string;
  requestedItemId: string;
  count: number;
  note: string | null;
  pinned: boolean;
}
export type RowPatch = Partial<RowFields>;

export type PendingChange =
  | ({ op: 'insert'; tempId: string; groupId: string } & RowFields)
  | { op: 'update'; id: string; updatedAt: string; patch: RowPatch }
  | { op: 'delete'; id: string; updatedAt: string };

/** 画面の操作（id は DB の行の id か、未保存の行の tempId） */
export type PendingEdit =
  | ({ op: 'insert'; groupId: string } & RowFields)
  | { op: 'update'; id: string; patch: RowPatch }
  | { op: 'delete'; id: string };

/** データの列（変えると origin = manual になる。DB の v_data_changed と同じ列） */
export const DATA_KEYS = ['sourceRoomId', 'itemId', 'requestedItemId', 'count', 'note'] as const satisfies readonly (keyof RowFields)[];
const PATCH_KEYS = [...DATA_KEYS, 'pinned'] as const satisfies readonly (keyof RowFields)[];

/** 未保存の行の id の頭（DB の id と見分ける） */
export const TEMP_ID_PREFIX = 'new-';
export const isTempId = (id: string) => id.startsWith(TEMP_ID_PREFIX);

/** save_allocation_rows の changes の上限（1000 件） */
export const MAX_CHANGES = 1000;

// ---- zod（数は 1〜10000 の整数、備考は 2000 字まで。下書きを読むときにも使う） ----

const uuid = z.uuid();
const countSchema = z.number().int().min(1, { message: '数は 1 以上です。0 にしたいときは行を削除してください' }).max(MAX_COUNT);
const noteSchema = z.string().max(NOTE_MAX, { message: `備考は ${NOTE_MAX} 字までです` }).nullable();
const fields = { sourceRoomId: uuid, itemId: uuid, requestedItemId: uuid, count: countSchema, note: noteSchema, pinned: z.boolean() };

export const pendingChangeSchema = z.discriminatedUnion('op', [
  z.strictObject({ op: z.literal('insert'), tempId: z.string().startsWith(TEMP_ID_PREFIX).max(80), groupId: uuid, ...fields }),
  z.strictObject({
    op: z.literal('update'),
    id: uuid,
    updatedAt: z.string().min(1),
    patch: z.strictObject({
      sourceRoomId: uuid.optional(),
      itemId: uuid.optional(),
      requestedItemId: uuid.optional(),
      count: countSchema.optional(),
      note: noteSchema.optional(),
      pinned: z.boolean().optional(),
    }),
  }),
  z.strictObject({ op: z.literal('delete'), id: uuid, updatedAt: z.string().min(1) }),
]);
export const pendingListSchema = z.array(pendingChangeSchema).max(MAX_CHANGES);

/** 数の確かめ（行のセル）。合わなければ文言 */
export function countError(n: number): string | null {
  const r = countSchema.safeParse(n);
  return r.success ? null : (r.error.issues[0]?.message ?? '数が正しくありません');
}

/** 備考の確かめ。前後の空白を除き、空なら null（合わなければ error） */
export function parseNote(text: string): { ok: true; note: string | null } | { ok: false; error: string } {
  const t = text.trim();
  const r = noteSchema.safeParse(t === '' ? null : t);
  return r.success ? { ok: true, note: r.data } : { ok: false, error: r.error.issues[0]?.message ?? '備考が正しくありません' };
}

// ---- 当てる ----

/** 団体の使用場所（is_keep を決める。分からない団体は undefined） */
export type LocationOf = (groupId: string) => string | null | undefined;

const keepOf = (sourceRoomId: string, groupId: string, row: Pick<StoredAllocationRow, 'isKeep'> | null, locationOf: LocationOf) => {
  const loc = locationOf(groupId);
  if (loc === undefined) return row?.isKeep ?? false;
  return loc !== null && loc === sourceRoomId;
};

/** 行に patch を当てた後の行（DB の save_allocation_rows の update と同じ決め方） */
export function patchRow(row: StoredAllocationRow, patch: RowPatch, locationOf: LocationOf): StoredAllocationRow {
  const next: StoredAllocationRow = { ...row };
  for (const k of PATCH_KEYS) {
    if (patch[k] !== undefined) (next as unknown as Record<string, unknown>)[k] = patch[k];
  }
  const dataChanged = DATA_KEYS.some((k) => next[k] !== row[k]);
  if (dataChanged) next.origin = 'manual';
  next.isKeep = keepOf(next.sourceRoomId, next.groupId, row, locationOf);
  return next;
}

/**
 * 未保存の変更を当てた行（画面と検証に使う）。insert の行の id は tempId。
 * データを変えた行は origin = manual（備考だけでも）。固定だけの変更は origin を変えない。
 */
export function applyPending(
  rows: readonly StoredAllocationRow[],
  pending: readonly PendingChange[],
  locationOf: LocationOf,
): StoredAllocationRow[] {
  if (pending.length === 0) return [...rows];
  const byId = new Map<string, PendingChange>();
  const inserts: StoredAllocationRow[] = [];
  for (const c of pending) {
    if (c.op === 'insert') {
      inserts.push({
        id: c.tempId,
        sourceRoomId: c.sourceRoomId,
        groupId: c.groupId,
        itemId: c.itemId,
        requestedItemId: c.requestedItemId,
        count: c.count,
        note: c.note,
        pinned: c.pinned,
        origin: 'manual',
        isKeep: keepOf(c.sourceRoomId, c.groupId, null, locationOf),
      });
    } else {
      byId.set(c.id, c);
    }
  }
  const out: StoredAllocationRow[] = [];
  for (const r of rows) {
    const c = byId.get(r.id);
    if (!c) out.push(r);
    else if (c.op === 'update') out.push(patchRow(r, c.patch, locationOf));
    // delete は外す
  }
  return [...out, ...inserts];
}

// ---- まとめる ----

/** patch から元の値と同じ項目を外す */
function prunePatch(row: StoredAllocationRow, patch: RowPatch): RowPatch {
  const out: RowPatch = {};
  for (const k of PATCH_KEYS) {
    const v = patch[k];
    if (v !== undefined && v !== row[k]) (out as Record<string, unknown>)[k] = v;
  }
  return out;
}

let tempSeq = 0;
/** 未保存の行の id（画面の中だけで使う。DB には送らない） */
export function newTempId(): string {
  tempSeq += 1;
  const rand = typeof crypto !== 'undefined' && 'randomUUID' in crypto ? crypto.randomUUID() : `${Date.now()}-${tempSeq}`;
  return `${TEMP_ID_PREFIX}${rand}`;
}

/**
 * 画面の操作を未保存の変更に入れる。1行1変更にまとめる（save_allocation_rows は同じ id の変更が2つあると全体を拒む）：
 * - 未保存の行（tempId）への update は insert に入れ、delete は insert ごと外す。
 * - DB の行への update は前の update と重ね、元の値と同じ項目は外す（何も残らなければ変更ごと外す）。delete は update を置き換える。
 * base は DB の行（スナップショット）と updated_at。DB にない id への操作は無視する。
 */
export function editPending(
  pending: readonly PendingChange[],
  edit: PendingEdit,
  base: StoredRows,
  tempId: () => string = newTempId,
): PendingChange[] {
  if (edit.op === 'insert') {
    const { op: _op, ...rest } = edit;
    return [...pending, { op: 'insert', tempId: tempId(), ...rest }];
  }
  if (isTempId(edit.id)) {
    const i = pending.findIndex((c) => c.op === 'insert' && c.tempId === edit.id);
    if (i < 0) return [...pending];
    if (edit.op === 'delete') return pending.filter((_, k) => k !== i);
    const cur = pending[i] as Extract<PendingChange, { op: 'insert' }>;
    const next = { ...cur };
    for (const k of PATCH_KEYS) {
      const v = edit.patch[k];
      if (v !== undefined) (next as Record<string, unknown>)[k] = v;
    }
    return pending.map((c, k) => (k === i ? next : c));
  }
  const row = base.rows.find((r) => r.id === edit.id);
  const updatedAt = base.updatedAt.get(edit.id);
  if (!row || updatedAt === undefined) return [...pending];
  const rest = pending.filter((c) => c.op === 'insert' || c.id !== edit.id);
  const prev = pending.find((c): c is Extract<PendingChange, { op: 'update' }> => c.op === 'update' && c.id === edit.id);
  if (edit.op === 'delete') return [...rest, { op: 'delete', id: edit.id, updatedAt }];
  if (pending.some((c) => c.op === 'delete' && c.id === edit.id)) return [...pending]; // 削除した行は変えない
  const patch = prunePatch(row, { ...(prev?.patch ?? {}), ...edit.patch });
  if (Object.keys(patch).length === 0) return rest;
  const change: PendingChange = { op: 'update', id: edit.id, updatedAt, patch };
  // 前の update と同じ場所に置く（一覧の並びを保つ）
  if (prev) return pending.map((c) => (c === prev ? change : c));
  return [...rest, change];
}

/** その行の変更を取り消す（未保存の行なら外す） */
export function revertRow(pending: readonly PendingChange[], id: string): PendingChange[] {
  return pending.filter((c) => (c.op === 'insert' ? c.tempId !== id : c.id !== id));
}

// ---- 送る ----

/** save_allocation_rows の p_changes（tempId は送らない。insert の id は DB が作る） */
export function toRpcChanges(pending: readonly PendingChange[]): AllocationChange[] {
  return pending.map((c): AllocationChange => {
    switch (c.op) {
      case 'insert':
        return {
          op: 'insert',
          sourceRoomId: c.sourceRoomId,
          groupId: c.groupId,
          itemId: c.itemId,
          requestedItemId: c.requestedItemId,
          count: c.count,
          pinned: c.pinned,
          note: c.note,
        };
      case 'update': {
        const out: Record<string, unknown> = { op: 'update', id: c.id, updatedAt: c.updatedAt };
        for (const k of PATCH_KEYS) if (c.patch[k] !== undefined) out[k] = c.patch[k];
        return out as AllocationChange;
      }
      case 'delete':
        return { op: 'delete', id: c.id, updatedAt: c.updatedAt };
    }
  });
}

// ---- 読み直した後 ----

/** updated_at が同じか（DB はミリ秒で比べる：date_trunc('milliseconds', …)） */
export function sameUpdatedAt(a: string | undefined, b: string | undefined): boolean {
  if (a === undefined || b === undefined) return false;
  if (a === b) return true;
  const ms = (s: string) => {
    // 小数第4位より下を落としてから読む（Date はミリ秒まで）
    const t = Date.parse(s.replace(/(\.\d{3})\d+/, '$1'));
    return Number.isNaN(t) ? null : t;
  };
  const x = ms(a);
  return x !== null && x === ms(b);
}

export type DroppedReason = 'gone' | 'changed';
export interface DroppedChange {
  change: PendingChange;
  reason: DroppedReason;
}

/**
 * 読み直した行に当て直す。update・delete は、相手の行が消えた（gone）か updated_at が変わった（changed）なら外して返す。
 * 当て直せた update は、今の値と同じ項目を外す（何も残らなければ外す）。insert はそのまま残す。
 */
export function rebasePending(pending: readonly PendingChange[], base: StoredRows): { pending: PendingChange[]; dropped: DroppedChange[] } {
  const byId = new Map(base.rows.map((r) => [r.id, r]));
  const kept: PendingChange[] = [];
  const dropped: DroppedChange[] = [];
  for (const c of pending) {
    if (c.op === 'insert') {
      kept.push(c);
      continue;
    }
    const row = byId.get(c.id);
    if (!row) {
      dropped.push({ change: c, reason: 'gone' });
      continue;
    }
    if (!sameUpdatedAt(base.updatedAt.get(c.id), c.updatedAt)) {
      dropped.push({ change: c, reason: 'changed' });
      continue;
    }
    if (c.op === 'update') {
      const patch = prunePatch(row, c.patch);
      if (Object.keys(patch).length > 0) kept.push({ ...c, patch });
      continue;
    }
    kept.push(c);
  }
  return { pending: kept, dropped };
}

const sameFields = (r: StoredAllocationRow, c: Extract<PendingChange, { op: 'insert' }>) =>
  r.sourceRoomId === c.sourceRoomId &&
  r.groupId === c.groupId &&
  r.itemId === c.itemId &&
  r.requestedItemId === c.requestedItemId &&
  r.count === c.count &&
  (r.note ?? null) === (c.note ?? null) &&
  r.pinned === c.pinned;

export interface ReconcileResult {
  /** all：すべて反映済み（保存されていた）。none：どれも反映されていない。partial：一部だけ（決めきれない） */
  status: 'all' | 'none' | 'partial';
  applied: PendingChange[];
  remaining: PendingChange[];
}

/**
 * 保存されたか分からないとき（版が進んでいた）の突き合わせ。save_allocation_rows は全部か何も保存しないかなので、
 * all なら保存されていた、none ならほかの人の変更で版が進んだだけ、partial は決めきれない。
 * - update：行があり、updated_at が送ったものと違い、patch の値がすべて今の値と同じ。
 * - delete：行がない。
 * - insert：前のスナップショットになかった行のうち、運び元・団体・品目・申請品目・数・備考・固定が同じもの（1行は1つの insert にだけ当てる）。
 */
export function reconcileAfterUnknown(pending: readonly PendingChange[], before: StoredRows, after: StoredRows): ReconcileResult {
  const beforeIds = new Set(before.rows.map((r) => r.id));
  const afterById = new Map(after.rows.map((r) => [r.id, r]));
  const fresh = after.rows.filter((r) => !beforeIds.has(r.id));
  const used = new Set<string>();
  const applied: PendingChange[] = [];
  const remaining: PendingChange[] = [];
  for (const c of pending) {
    let ok = false;
    if (c.op === 'delete') {
      ok = !afterById.has(c.id);
    } else if (c.op === 'update') {
      const r = afterById.get(c.id);
      ok =
        r !== undefined &&
        !sameUpdatedAt(after.updatedAt.get(c.id), c.updatedAt) &&
        PATCH_KEYS.every((k) => c.patch[k] === undefined || (r[k] ?? null) === (c.patch[k] ?? null));
    } else {
      const hit = fresh.find((r) => !used.has(r.id) && sameFields(r, c));
      if (hit) {
        used.add(hit.id);
        ok = true;
      }
    }
    (ok ? applied : remaining).push(c);
  }
  const status = remaining.length === 0 ? 'all' : applied.length === 0 ? 'none' : 'partial';
  return { status, applied, remaining };
}

// ---- 行ごとの操作 ----

export type RowOp = 'count' | 'change_source' | 'note' | 'pin' | 'unpin' | 'delete';

export const ROW_OP_LABELS: Record<RowOp, string> = {
  count: '数を変える',
  change_source: '運び元を変える',
  note: '備考',
  pin: '固定する',
  unpin: '固定を外す',
  delete: '削除',
};

/** 使用不可の部屋の行に添える文（3.9） */
export const UNUSABLE_ROW_NOTE = '使用不可の部屋の行は、運び元を変えるか削除してください（固定を外すには、先に部屋を使用可に戻します）';

/**
 * 行ごとに出す操作。使用不可の部屋の行は「運び元を変える」「削除」だけ（save_allocation_rows は使用不可の部屋の行の update を、
 * 固定だけ・備考だけでも E002 で拒否する。delete と、運び元を使用可の部屋に変える update だけが通る）。
 */
export function allowedRowOps(
  row: Pick<StoredAllocationRow, 'sourceRoomId' | 'pinned'>,
  usableByRoom: ReadonlyMap<string, boolean> | ((roomId: string) => boolean),
): RowOp[] {
  const usable = typeof usableByRoom === 'function' ? usableByRoom(row.sourceRoomId) : (usableByRoom.get(row.sourceRoomId) ?? true);
  if (!usable) return ['change_source', 'delete'];
  return ['count', 'change_source', 'note', row.pinned ? 'unpin' : 'pin', 'delete'];
}

// ---- 表示 ----

/** 変更の件数の内訳（「追加 1・変更 2・削除 1」） */
export function pendingSummary(pending: readonly PendingChange[]): { inserts: number; updates: number; deletes: number } {
  return {
    inserts: pending.filter((c) => c.op === 'insert').length,
    updates: pending.filter((c) => c.op === 'update').length,
    deletes: pending.filter((c) => c.op === 'delete').length,
  };
}

/** 変更が当たる行の id（insert は tempId） */
export const changeRowId = (c: PendingChange) => (c.op === 'insert' ? c.tempId : c.id);
