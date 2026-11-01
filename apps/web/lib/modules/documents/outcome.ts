// 提出・取り消し・承認・差し戻しの、応答が届かなかったとき・止められたときの決め方（04「提出物」の書き込みの決まり、画面の設計 2.6 の (B1)、
// notes/T19.md「パート B・C の約束」3。T19・D-55）。純粋な関数。
// 送ったら、その提出を1回読み直して（lib/data/documents.ts の readSubmission）ここで決める：
// - 読み直した提出が押した操作の後の状態（提出した → 提出済み、取り消し → 未提出、承認・紙での承認 → 承認、差し戻し → 差し戻しで理由が同じ）
//   なら 'done'（「提出されていました」など。成功と同じに扱う）
// - 版（updated_at をミリ秒で比べる。DB の date_trunc('milliseconds') と同じ。行がなければ null）が読んだときと同じなら 'unknown'
//   （「提出できたか分かりません。もう一度「提出した」を押すと、確かめてから送ります」。入力の理由・メモは残す）
// - ほかは 'changed'（ほかの人が先に変えた。conflict と同じ扱い）
// 読み直せなかったときは画面が決める（止められた後なら「読み直せませんでした」と「読み直す」）。
import { normalizeReviewNote } from '@/lib/schemas/document-fields';
import { statusOf, type DocumentStatus } from './labels';

/** 提出の操作（paper は未提出・差し戻しからの紙などでの承認） */
export type SubmissionAction = 'submit' | 'withdraw' | 'approve' | 'paper' | 'return';

/** 操作の後の状態 */
export const AFTER_STATUS: Readonly<Record<SubmissionAction, DocumentStatus>> = {
  submit: 'submitted',
  withdraw: 'not_submitted',
  approve: 'approved',
  paper: 'approved',
  return: 'returned',
};

/** 決め方の結果 */
export type SubmissionOutcome = 'done' | 'unknown' | 'changed';

/** 読み直した提出（v_document_status の行。対象でない・消えたなら null） */
export interface ReadSubmission {
  status: DocumentStatus | null;
  updated_at: string | null;
  review_note: string | null;
}

/** 版が同じか（ミリ秒まで。どちらも null なら同じ。読めない値は文字列で比べる） */
export function sameVersion(a: string | null | undefined, b: string | null | undefined): boolean {
  if (a === null || a === undefined || b === null || b === undefined) return (a ?? null) === (b ?? null);
  const ta = Date.parse(a);
  const tb = Date.parse(b);
  if (Number.isNaN(ta) || Number.isNaN(tb)) return a === b;
  return ta === tb;
}

/**
 * 応答が届かなかった・止められた（invalid_state の not_editable・conflict）後に読み直した提出から決める。
 * base は送った版（読んだときの updated_at。行がなければ null）、note は差し戻しの理由（前後の空白を除いて比べる）。
 *
 * @example
 * settleSubmissionOutcome('submit', card.baseVersion, await readSubmission(docId, groupId)) // 'done' なら「提出されていました」
 */
export function settleSubmissionOutcome(
  action: SubmissionAction,
  base: string | null,
  reread: ReadSubmission | null,
  note?: string | null,
): SubmissionOutcome {
  if (reread && statusOf(reread.status) === AFTER_STATUS[action]) {
    if (action !== 'return' || normalizeReviewNote(reread.review_note) === normalizeReviewNote(note)) return 'done';
  }
  return sameVersion(reread?.updated_at ?? null, base) ? 'unknown' : 'changed';
}
