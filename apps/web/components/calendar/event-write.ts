// 締切と予定の書き込みの送信と、応答が届かなかったとき・止められたときの決め方（画面の設計 2.6 の (B1)。04「締切と予定」のエラーと
// 読み直し、notes/T18.md「後半（画面）の約束」7。T18）。画面（ダイアログ・削除の確かめ）は結果の種類で出し方を決める。
// - 登録は画面が作った id で insert するので一意のキーのある insert、保存・削除は updated_at の楽観ロック。どちらも (B1)：応答が届かな
//   かったその場と、DB に止められたとき（登録の 23505、保存の conflict・not_found）に、その項目を1回読み直して決める。確かめるためだけの
//   状態は持たない（もう一度の送信は同じ id・同じ updated_at でふつうに送り、前の送信が通っていれば DB が止める）。
// - 権限か年度の状態が変わった（42501・lock_unchanged）は読み直さない（failed。画面が年度の行と立場を読み直す）。
// 401 は1回だけセッションを更新して送り直す（ほかの画面と同じ）。
import { sameEventWrite, type CalendarEventRow, type EventWrite } from '@/lib/data/calendar';
import { isLockRejection, settleLockedWrite } from '@/lib/data/locked-save';
import { classifyError, isUnknownOutcome } from '@/lib/errors';

/** 401 の扱い（lib/auth/guarded.ts の useAuthErrorHandler） */
export type AuthErrorHandler = (e: unknown) => Promise<'retry' | 'signedOut' | 'other'>;

/** 登録・保存の結果 */
export type EventSaveResult =
  /** 保存できた。before は、応答が届かなかった・止められたが、読み直すと送った値になっていた（登録されていた・保存されていた） */
  | { type: 'saved'; row: CalendarEventRow; before: boolean }
  /**
   * ほかの人が先に変えた（保存の conflict、登録の 23505 で読み直すと入力と違う）。row（読み直した今の行）を入力の元にして入力を残す
   * （登録は、その項目の編集に切り替える）
   */
  | { type: 'conflict'; row: CalendarEventRow }
  /** 保存：項目が消えていた（読み直してもない） */
  | { type: 'missing' }
  /** 応答が届かず保存できたか分からない（登録は、止められた後に行がない・読み直せないときも）。入力を残し、もう一度押せる */
  | { type: 'unknown' }
  /** 保存：止められた後に読み直せなかった（「読み直しました」とは言わない） */
  | { type: 'unread' }
  /** そのほかの失敗（forbidden・CHECK・deadlock・認証など。effectOf のとおり） */
  | { type: 'failed'; error: unknown };

export interface EventSaveRequest {
  /** 保存のときの入力の元の版（読んだときの updated_at の文字列）。登録は null */
  baseVersion: string | null;
  /** 送る値（読み直した行と sameEventWrite で比べる） */
  write: EventWrite;
  /** 送る（失敗したら投げる） */
  send: () => Promise<CalendarEventRow>;
  /** その項目（登録はダイアログで作った id）を1行読む（なければ null。失敗したら投げる） */
  reread: () => Promise<CalendarEventRow | null>;
}

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

/**
 * 登録・保存（2.6 の (B1)）。応答が届かなかった（isUnknownOutcome）か、止められた（isLockRejection：登録の 23505、保存の
 * conflict・not_found）なら、その項目を読み直して settleLockedWrite で決める：
 * - saved → saved（before）
 * - 登録：changed（行があり入力と違う）→ conflict。not-saved（行がない）・unread → unknown（もう一度押すと同じ id で送る）
 * - 保存：応答が届かなかった後の not-saved・unread → unknown、止められた後の unread → unread、ほか（changed と、止められた後の
 *   not-saved）→ 行があれば conflict、なければ missing
 * ほかの失敗（forbidden など）は failed。
 */
export async function runEventSave(req: EventSaveRequest, onAuthError: AuthErrorHandler): Promise<EventSaveResult> {
  const sent = await sendWithAuth(req.send, onAuthError);
  if (sent.ok) return { type: 'saved', row: sent.value, before: false };
  const error = sent.error;
  const unknown = isUnknownOutcome(error);
  if (!unknown && !isLockRejection(error)) return { type: 'failed', error };

  const read: { row: CalendarEventRow | null } = { row: null };
  const outcome = await settleLockedWrite<CalendarEventRow>({
    reread: async () => {
      read.row = await req.reread();
      return read.row;
    },
    matches: (row) => sameEventWrite(row, req.write),
    baseVersion: req.baseVersion,
    versionOf: (row) => row.updated_at,
  });
  if (outcome === 'saved' && read.row) return { type: 'saved', row: read.row, before: true };
  if (req.baseVersion === null) {
    return outcome === 'changed' && read.row ? { type: 'conflict', row: read.row } : { type: 'unknown' };
  }
  if (unknown && (outcome === 'not-saved' || outcome === 'unread')) return { type: 'unknown' };
  if (outcome === 'unread') return { type: 'unread' };
  return read.row ? { type: 'conflict', row: read.row } : { type: 'missing' };
}

/** 削除の結果 */
export type EventDeleteResult =
  /** 消えた。before は、止められた（not_found）が読み直すともうなかった（すでに削除されていた） */
  | { type: 'deleted'; before: boolean }
  /** 版が違った（ほかの人が先に変えた）。内容を確かめてから、もう一度削除してもらう */
  | { type: 'changed' }
  /** 応答が届かず、消せたか分からない（版は読んだときのまま・読み直せなかった） */
  | { type: 'unknown' }
  /** そのほかの失敗（forbidden〔版が同じ。権限か年度の状態が変わった〕・deadlock など。effectOf のとおり） */
  | { type: 'failed'; error: unknown };

export interface EventDeleteRequest {
  send: () => Promise<unknown>;
  /** その項目を1行読む（なければ null。失敗したら投げる） */
  reread: () => Promise<CalendarEventRow | null>;
  /** 読んだときの updated_at（送った版） */
  baseVersion: string;
}

/**
 * 削除（2.6 の (B1)）。deleteChecked は 0 行を読み直して分けるので、not_found（もうない）は deleted（before）、conflict（版が違う）は
 * changed、forbidden（版が同じ）は failed。応答が届かなかったときは読み直す：ない → deleted、版が違う → changed、版が同じ・読み直せない →
 * unknown（もう一度押すと同じ updated_at で送る）。
 */
export async function runEventDelete(req: EventDeleteRequest, onAuthError: AuthErrorHandler): Promise<EventDeleteResult> {
  const sent = await sendWithAuth(req.send, onAuthError);
  if (sent.ok) return { type: 'deleted', before: false };
  const error = sent.error;
  if (!isUnknownOutcome(error)) {
    const kind = classifyError(error).kind;
    if (kind === 'not_found') return { type: 'deleted', before: true };
    if (kind === 'conflict') return { type: 'changed' };
    return { type: 'failed', error };
  }
  let row: CalendarEventRow | null;
  try {
    row = await req.reread();
  } catch {
    return { type: 'unknown' };
  }
  if (!row) return { type: 'deleted', before: false };
  return row.updated_at !== req.baseVersion ? { type: 'changed' } : { type: 'unknown' };
}
