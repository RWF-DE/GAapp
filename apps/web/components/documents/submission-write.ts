// 提出した・取り消す・承認・差し戻し・紙での承認の送信と、応答が届かなかったとき・止められたときの決め方（04「提出物」の書き込みの決まり、
// 画面の設計 2.6 の (B1)、notes/T19.md「パート B・C の約束」3・6。T19・D-55）。/document（店長・副店長）と /documents のシート
// （部門長以上）が使う。画面は結果の種類で出し方を決める（確かめるためだけの状態は持たない。もう一度の送信は、読み直した版でふつうに送る）。
// - 送れた → done。
// - 応答が届かなかった（isUnknownOutcome）→ その提出を1回読み直して settleSubmissionOutcome で決める：押した操作の後の状態なら done
//   （before。「提出されていました」など）、版が送ったときと同じなら unknown（「提出できたか分かりません。もう一度…」）、違えば rejected
//   （ほかの人が先に変えた。conflict の文言）。読み直せなければ unknown。
// - 止められた（invalid_state の not_editable・conflict・not_found）→ 読み直す（画面の一覧）。前に「分からない」で終わった同じ操作の
//   もう一度で、読み直した状態が押した操作の後の状態なら done（before。前の送信が通っていた可能性があるので、ほかの人がしたとは言わない）。
//   ほかは rejected（エラーの文言。「…読み直しました」）。読み直せなければ unread（「…読み直せませんでした」と「読み直す」）。
// - そのほか（forbidden・status: closed・no_file・not_uploaded・入力の誤り・deadlock など）→ failed（画面は effectOf のとおりに読み直す）。
// 401 は1回だけセッションを更新して送り直す（ほかの画面と同じ）。
import type { DocumentSubmissionRow } from '@/lib/data/documents';
import { appError, classifyError, isUnknownOutcome } from '@/lib/errors';
import { settleSubmissionOutcome, type ReadSubmission, type SubmissionAction } from '@/lib/modules/documents/outcome';

export type { SubmissionAction } from '@/lib/modules/documents/outcome';

/** 401 の扱い（lib/auth/guarded.ts の useAuthErrorHandler） */
export type AuthErrorHandler = (e: unknown) => Promise<'retry' | 'signedOut' | 'other'>;

/** 操作ごとの RPC の名前（エラーの文言の MessageContext の rpc） */
export const SUBMISSION_RPCS: Readonly<Record<SubmissionAction, string>> = {
  submit: 'submit_document',
  withdraw: 'withdraw_document',
  approve: 'approve_document',
  paper: 'approve_document',
  return: 'return_document',
};

/** 応答が届かなかった・止められたが、読み直すと押した操作の後の状態だった（成功と同じに扱う。04 の書き込みの決まり） */
export const SUBMISSION_DONE_BEFORE: Readonly<Record<SubmissionAction, string>> = {
  submit: '提出されていました',
  withdraw: '取り消されていました',
  approve: '承認されていました',
  paper: '承認されていました',
  return: '差し戻されていました',
};

/** 応答が届かず、できたか分からない（版は読んだときのまま・読み直せなかった）。押すボタンの名前で言う */
export const SUBMISSION_UNKNOWN: Readonly<Record<SubmissionAction, string>> = {
  submit: '提出できたか分かりません。もう一度「提出した」を押すと、確かめてから送ります',
  withdraw: '取り消せたか分かりません。もう一度「提出を取り消す」を押すと、確かめてから送ります',
  approve: '承認できたか分かりません。もう一度「承認する」を押すと、確かめてから送ります',
  paper: '承認できたか分かりません。もう一度「承認する」を押すと、確かめてから送ります',
  return: '差し戻せたか分かりません。もう一度「差し戻す」を押すと、確かめてから送ります',
};

/** 止められた後に読み直せなかった（04「エラーの文言」の後の注。締切と予定・お知らせと同じ） */
export const REREAD_FAILED_NOTICE = 'ほかの人が先に変えた可能性がありますが、読み直せませんでした。「読み直す」を押してから、もう一度押してください';
/** 「読み直す」でもまた読み直せなかった */
export const REREAD_AGAIN_FAILED_MESSAGE = 'まだ読み直せませんでした。通信を確かめてから、もう一度「読み直す」を押してください（入力は残してあります）';

/** 送信の結果 */
export type SubmissionWriteResult =
  /** できた。row は RPC の返り値（before のときは null）。before は、応答が届かなかった・止められたが、読み直すと押した操作の後だった */
  | { type: 'done'; row: DocumentSubmissionRow | null; before: boolean }
  /** 応答が届かず、できたか分からない（SUBMISSION_UNKNOWN。もう一度押すと、読み直した版で送る） */
  | { type: 'unknown' }
  /** 止められて読み直した（not_editable・conflict・not_found と、応答が届かなかった後に版が進んでいた）。error の文言を出す */
  | { type: 'rejected'; error: unknown }
  /** 止められた後に読み直せなかった（REREAD_FAILED_NOTICE と「読み直す」） */
  | { type: 'unread'; error: unknown }
  /** そのほかの失敗（effectOf のとおり） */
  | { type: 'failed'; error: unknown };

export interface SubmissionWriteRequest {
  action: SubmissionAction;
  /** 送った版（読んだときの v_document_status の updated_at。行がなければ null） */
  base: string | null;
  /** 差し戻しの理由（読み直した提出の理由と比べる） */
  note?: string | null;
  /** 前に同じ提出の同じ操作が「分からない」で終わった（そのもう一度） */
  afterUnknown: boolean;
  /** 送る（失敗したら投げる） */
  send: () => Promise<DocumentSubmissionRow>;
  /** その提出を読み直す（画面の読み取りを読み直して、その行を返す。対象でない・消えたなら null。読めなければ投げる） */
  reread: () => Promise<ReadSubmission | null>;
}

/** 送る。401 なら1回だけセッションを更新して送り直す */
export async function sendWithAuth<T>(send: () => Promise<T>, onAuthError: AuthErrorHandler): Promise<{ ok: true; value: T } | { ok: false; error: unknown }> {
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

const isRecord = (v: unknown): v is Record<string, unknown> => typeof v === 'object' && v !== null && !Array.isArray(v);

/** invalid_state の not_editable（同じ操作が重なった・成功した後の送り直し。details の status は今の状態） */
export function isNotEditable(e: unknown): boolean {
  const c = classifyError(e);
  return c.kind === 'state' && isRecord(c.details) && c.details.reason === 'not_editable';
}

/** 読み直して決める止められ方（not_editable・conflict・not_found） */
function isRejection(e: unknown): boolean {
  const kind = classifyError(e).kind;
  return isNotEditable(e) || kind === 'conflict' || kind === 'not_found';
}

/**
 * 提出の書き込み（2.6 の (B1)。04「提出物」の書き込みの決まり）。上の決め方で結果を返す。
 *
 * @example
 * const r = await runSubmissionWrite({ action: 'submit', base: card.baseVersion, afterUnknown, send: () => submitDocument(d, g, base),
 *   reread }, onAuthError);
 */
export async function runSubmissionWrite(req: SubmissionWriteRequest, onAuthError: AuthErrorHandler): Promise<SubmissionWriteResult> {
  const sent = await sendWithAuth(req.send, onAuthError);
  if (sent.ok) return { type: 'done', row: sent.value, before: false };
  const error = sent.error;
  const unknown = isUnknownOutcome(error);
  if (!unknown && !isRejection(error)) return { type: 'failed', error };

  let reread: ReadSubmission | null;
  try {
    reread = await req.reread();
  } catch {
    return unknown ? { type: 'unknown' } : { type: 'unread', error };
  }
  const outcome = settleSubmissionOutcome(req.action, req.base, reread, req.note);
  if (unknown) {
    if (outcome === 'done') return { type: 'done', row: null, before: true };
    if (outcome === 'unknown') return { type: 'unknown' };
    // 応答が届かなかった間に、ほかの人が先に変えた（conflict と同じ文言。読み直してある）
    return { type: 'rejected', error: appError('conflict', 'lock_conflict', null) };
  }
  // 前の「分からない」の送信が通っていた（同じ操作のもう一度が not_editable・conflict で止まり、今は押した操作の後の状態）
  if (req.afterUnknown && outcome === 'done' && classifyError(error).kind !== 'not_found') return { type: 'done', row: null, before: true };
  return { type: 'rejected', error };
}
