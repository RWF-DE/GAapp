// シフト表の書き込みの送信と、応答が届かなかったとき・止められたときの決め方（画面の設計 2.6 の (A)・(B1)・(B2)。04「シフト表」の
// 送る値と書き込みの道・エラーと読み直し、notes/T20.md「画面の約束」3・9。T20）。画面（ダイアログ）は結果の種類で出し方を決める。
// - (A) 必要人数：数の絶対値の upsert。保存のたびに送る前にそのますを読み直し、同じ数なら送らずに「保存されていました」。
// - (B1) 持ち場・時間枠（画面が作った id の insert・updated_at の楽観ロックの update・delete）、ますを外す、割り当てる（主キー (slot_id,
//   user_id) の insert）・外す・移す：応答が届かなかったその場と、DB に止められたとき（23505・conflict・not_found）に、対象を1回読み直して
//   決める。確かめるためだけの状態は持たない。持ち場の 23505 は、同じ id の持ち場がなければ名前の重複。割り当ての 23505 は、読み直して
//   入れようとしたますにいれば割り当てられていた、ほかのますにいれば「ほかの持ち場で入っています」。
// - (B2) 1日分（add_shift_slots。冪等の鍵がない）：応答が届かなければ、その日の時間枠を読み直し、送った時刻の時間枠が全部あれば作られていた。
//   読み直せなければ「確かめる」まで送り直さない。
// 401 は1回だけセッションを更新して送り直す（ほかの画面と同じ）。
import { isLockRejection, settleLockedWrite } from '@/lib/data/locked-save';
import type { AssignmentRow, NeedRow } from '@/lib/data/shifts';
import { classifyError, isUnknownOutcome } from '@/lib/errors';
import type { PlannedSlot } from '@/lib/modules/shifts/board';

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

const isDuplicate = (e: unknown) => classifyError(e).code === '23505';

// ---------------------------------------------------------------- 持ち場・時間枠（(B1)）

/** 持ち場・時間枠の足す・直すの結果 */
export type RowSaveResult<Row> =
  /** 保存できた。before は、応答が届かなかった・止められたが、読み直すと送った値になっていた */
  | { type: 'saved'; row: Row; before: boolean }
  /** ほかの人が先に変えた（読み直した今の行を入力の元にして入力を残す） */
  | { type: 'conflict'; row: Row }
  /** 直す：消えていた */
  | { type: 'missing' }
  /** 持ち場：同じ名前の持ち場がある（23505 で、同じ id の行がない・直すとき） */
  | { type: 'duplicate' }
  /** 応答が届かず保存できたか分からない。入力を残し、もう一度押せる */
  | { type: 'unknown' }
  /** 止められた後に読み直せなかった（「読み直しました」とは言わない） */
  | { type: 'unread' }
  /** そのほかの失敗（forbidden・overlap・CHECK など。effectOf のとおり） */
  | { type: 'failed'; error: unknown };

export interface RowSaveRequest<Row> {
  /** 直すときの入力の元の版（読んだときの updated_at）。足すときは null */
  baseVersion: string | null;
  /** 読み直した行が送った値と同じか */
  matches: (row: Row) => boolean;
  send: () => Promise<Row>;
  /** その行（足すときはダイアログで作った id）を1行読む（なければ null。失敗したら投げる） */
  reread: () => Promise<Row | null>;
  /** 23505 を名前の重複として扱うか（持ち場。時間枠は id のほかに一意のキーがない） */
  uniqueName?: boolean;
}

/**
 * 持ち場・時間枠の足す・直す（2.6 の (B1)）。締切と予定の runEventSave と同じ決め方に、持ち場の名前の重複（23505）を足したもの：
 * 直すときの 23505 は名前の重複（duplicate）。足すときの 23505 は読み直し、同じ id の行がなければ名前の重複（uniqueName のとき）。
 */
export async function runRowSave<Row extends { updated_at: string }>(req: RowSaveRequest<Row>, onAuthError: AuthErrorHandler): Promise<RowSaveResult<Row>> {
  const sent = await sendWithAuth(req.send, onAuthError);
  if (sent.ok) return { type: 'saved', row: sent.value, before: false };
  const error = sent.error;
  if (req.uniqueName && req.baseVersion !== null && isDuplicate(error)) return { type: 'duplicate' };
  const unknown = isUnknownOutcome(error);
  if (!unknown && !isLockRejection(error)) return { type: 'failed', error };

  const read: { row: Row | null } = { row: null };
  const outcome = await settleLockedWrite<Row>({
    reread: async () => {
      read.row = await req.reread();
      return read.row;
    },
    matches: req.matches,
    baseVersion: req.baseVersion,
    versionOf: (row) => row.updated_at,
  });
  if (outcome === 'saved' && read.row) return { type: 'saved', row: read.row, before: true };
  if (req.baseVersion === null) {
    if (outcome === 'changed' && read.row) return { type: 'conflict', row: read.row };
    // 足すときの 23505 で同じ id の行がない：持ち場なら名前の重複（時間枠は起きない）
    if (req.uniqueName && !unknown && isDuplicate(error) && outcome === 'not-saved') return { type: 'duplicate' };
    return { type: 'unknown' };
  }
  if (unknown && (outcome === 'not-saved' || outcome === 'unread')) return { type: 'unknown' };
  if (outcome === 'unread') return { type: 'unread' };
  return read.row ? { type: 'conflict', row: read.row } : { type: 'missing' };
}

// ---------------------------------------------------------------- 消す（(B1)）

/** 消すの結果（持ち場・時間枠・ます・割り当て） */
export type RowDeleteResult =
  /** 消えた。before は、止められた（not_found）が読み直すともうなかった */
  | { type: 'deleted'; before: boolean }
  /** 版が違った（ほかの人が先に変えた） */
  | { type: 'changed' }
  /** 応答が届かず、消せたか分からない */
  | { type: 'unknown' }
  | { type: 'failed'; error: unknown };

/** 消す（2.6 の (B1)。締切と予定の runEventDelete と同じ） */
export async function runRowDelete(
  req: { send: () => Promise<unknown>; reread: () => Promise<{ updated_at: string } | null>; baseVersion: string },
  onAuthError: AuthErrorHandler,
): Promise<RowDeleteResult> {
  const sent = await sendWithAuth(req.send, onAuthError);
  if (sent.ok) return { type: 'deleted', before: false };
  const error = sent.error;
  if (!isUnknownOutcome(error)) {
    const kind = classifyError(error).kind;
    if (kind === 'not_found') return { type: 'deleted', before: true };
    if (kind === 'conflict') return { type: 'changed' };
    return { type: 'failed', error };
  }
  let row: { updated_at: string } | null;
  try {
    row = await req.reread();
  } catch {
    return { type: 'unknown' };
  }
  if (!row) return { type: 'deleted', before: false };
  return row.updated_at !== req.baseVersion ? { type: 'changed' } : { type: 'unknown' };
}

// ---------------------------------------------------------------- 必要人数（(A)）

/** 必要人数の保存の結果 */
export type NeedSaveResult =
  /** 保存した（before は、読み直すと同じ数だった：送らずに「保存されていました」） */
  | { type: 'saved'; row: NeedRow; before: boolean }
  /** 読み直し・送信の応答が届かなかった（入力を残し、もう一度押すと読み直してから送る） */
  | { type: 'unknown' }
  | { type: 'failed'; error: unknown };

/**
 * 必要人数（2.6 の (A)）：送る前にそのますを読み直し、同じ数なら送らずに saved（before）。違えば（ますがなければ作る）upsert を送る。
 * 読み直し・送信が届かなければ unknown（自動では送り直さない）。
 */
export async function runNeedSave(
  req: { count: number; reread: () => Promise<NeedRow | null>; send: () => Promise<NeedRow> },
  onAuthError: AuthErrorHandler,
): Promise<NeedSaveResult> {
  const fresh = await sendWithAuth(req.reread, onAuthError);
  if (!fresh.ok) return isUnknownOutcome(fresh.error) ? { type: 'unknown' } : { type: 'failed', error: fresh.error };
  if (fresh.value && fresh.value.required_count === req.count) return { type: 'saved', row: fresh.value, before: true };
  const sent = await sendWithAuth(req.send, onAuthError);
  if (sent.ok) return { type: 'saved', row: sent.value, before: false };
  return isUnknownOutcome(sent.error) ? { type: 'unknown' } : { type: 'failed', error: sent.error };
}

// ---------------------------------------------------------------- 割り当て（(B1)）

/** 割り当てる・移すの結果 */
export type AssignResult =
  /** 入れた・移した（before は、読み直すと入れようとしたますにいた） */
  | { type: 'saved'; row: AssignmentRow; before: boolean }
  /** その時間枠のほかのますに入っている（「この人は同じ時間枠に、ほかの持ち場で入っています」） */
  | { type: 'busy'; row: AssignmentRow }
  /** 移す：割り当てが消えていた・版が違った（読み直して決める） */
  | { type: 'changed'; row: AssignmentRow | null }
  /** 応答が届かず、入れられたか分からない */
  | { type: 'unknown' }
  | { type: 'failed'; error: unknown };

/**
 * 割り当てる（主キー (slot_id, user_id) の insert。2.6 の (B1)）：23505 と応答が届かなかったときは、その人のその時間枠の割り当てを読み直し、
 * 入れようとしたますにいれば saved（before）、ほかのますにいれば busy、いなければ unknown（23505 の後にいないのは、間に外された）。
 */
export async function runAssign(
  req: { dutyId: string; send: () => Promise<AssignmentRow>; reread: () => Promise<AssignmentRow | null> },
  onAuthError: AuthErrorHandler,
): Promise<AssignResult> {
  const sent = await sendWithAuth(req.send, onAuthError);
  if (sent.ok) return { type: 'saved', row: sent.value, before: false };
  const error = sent.error;
  if (!isUnknownOutcome(error) && !isDuplicate(error)) return { type: 'failed', error };
  let row: AssignmentRow | null;
  try {
    row = await req.reread();
  } catch {
    return { type: 'unknown' };
  }
  if (!row) return { type: 'unknown' };
  return row.duty_id === req.dutyId ? { type: 'saved', row, before: true } : { type: 'busy', row };
}

/**
 * ほかの持ち場へ移す（updated_at を条件に入れた duty_id の update。2.6 の (B1)）：止められた（conflict・not_found）・応答が届かなかったときは
 * 読み直し、移す先のますにいれば saved（before）、読み直した行の版が元のままで応答が届かなかったなら unknown、ほかは changed（読み直した行。
 * 消えていれば null）。
 */
export async function runMove(
  req: { dutyId: string; baseVersion: string; send: () => Promise<AssignmentRow>; reread: () => Promise<AssignmentRow | null> },
  onAuthError: AuthErrorHandler,
): Promise<AssignResult> {
  const sent = await sendWithAuth(req.send, onAuthError);
  if (sent.ok) return { type: 'saved', row: sent.value, before: false };
  const error = sent.error;
  const unknown = isUnknownOutcome(error);
  if (!unknown && !isLockRejection(error)) return { type: 'failed', error };
  let row: AssignmentRow | null;
  try {
    row = await req.reread();
  } catch {
    return { type: 'unknown' };
  }
  if (row && row.duty_id === req.dutyId) return { type: 'saved', row, before: true };
  if (unknown && row && row.updated_at === req.baseVersion) return { type: 'unknown' };
  return { type: 'changed', row };
}

// ---------------------------------------------------------------- 1日分（(B2)）

/** 1日分の結果 */
export type AddDayResult =
  /** 作った（before は、応答が届かなかったが読み直すと送った時刻の時間枠が全部あった） */
  | { type: 'created'; count: number; before: boolean }
  /** 応答が届かず、読み直すと送った時刻の時間枠が1つもない（作られていない。もう一度「作る」を押せる） */
  | { type: 'not-created' }
  /** 応答が届かず、読み直せなかった（「確かめる」まで送り直さない） */
  | { type: 'unverified' }
  /** 読み直すと一部だけある（ほかの人が同じ時刻を作った。読み直して表を確かめてもらう） */
  | { type: 'partial' }
  | { type: 'failed'; error: unknown };

const sameInstant = (a: string, b: string) => {
  const ta = Date.parse(a);
  const tb = Date.parse(b);
  return !Number.isNaN(ta) && ta === tb;
};

/** 読み直したその日の時間枠に、送った時刻の時間枠がいくつあるか（(B2) の確かめ） */
export function countPlannedIn(planned: readonly PlannedSlot[], existing: readonly PlannedSlot[]): number {
  return planned.filter((p) => existing.some((e) => sameInstant(e.starts_at, p.starts_at) && sameInstant(e.ends_at, p.ends_at))).length;
}

/** (B2) の確かめ：その日の時間枠を読み直し、送った時刻の時間枠が全部あれば created、1つもなければ not-created、一部なら partial */
export async function verifyAddDay(planned: readonly PlannedSlot[], rereadDay: () => Promise<PlannedSlot[]>): Promise<AddDayResult> {
  let existing: PlannedSlot[];
  try {
    existing = await rereadDay();
  } catch {
    return { type: 'unverified' };
  }
  const n = countPlannedIn(planned, existing);
  if (n === planned.length) return { type: 'created', count: n, before: true };
  return n === 0 ? { type: 'not-created' } : { type: 'partial' };
}

/** 1日分を作る（add_shift_slots。2.6 の (B2)）。応答が届かなければ verifyAddDay で確かめる */
export async function runAddDay(
  req: { planned: readonly PlannedSlot[]; send: () => Promise<unknown[]>; rereadDay: () => Promise<PlannedSlot[]> },
  onAuthError: AuthErrorHandler,
): Promise<AddDayResult> {
  const sent = await sendWithAuth(req.send, onAuthError);
  if (sent.ok) return { type: 'created', count: sent.value.length, before: false };
  if (!isUnknownOutcome(sent.error)) return { type: 'failed', error: sent.error };
  return verifyAddDay(req.planned, req.rereadDay);
}
