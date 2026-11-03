// 提出物の RPC の送る前の確かめに要る小さな zod（差し戻しの理由・承認のメモ。T19・D-55）。lib/rpc/payloads.ts（RPC_ARGS の
// approve_document・return_document）と lib/schemas/documents.ts（ダイアログの入力）が使う。RPC_ARGS は申請・自団体の振り分けなど
// ほかの画面の JS にも入るので、ここには小さなものだけを置き、ダイアログの入力の形（提出物の設定など）は lib/schemas/documents.ts に
// 置く（お知らせの notice-fields.ts と同じ分け方。ほかの画面の最初に読む JS を増やさない）。
// - 前後の空白は zod の trim（JavaScript の String.prototype.trim）で除く。DB の RPC が除く 25 文字と同じ。
// - 字数は文字（Unicode のコードポイント。`[...s].length`）で数え、DB の length と同じにする。
import { z } from 'zod';
import { charCount } from './notice-fields';

/** 差し戻しの理由・承認のメモの上限（document_submissions_review_note_check の `length(review_note) <= 1000`） */
export const REVIEW_NOTE_MAX = 1000;

/** 誤りの文言（04「提出状況」のセルのシートのダイアログ） */
export const REVIEW_NOTE_MESSAGES = {
  returnRequired: '差し戻しの理由を入れてください',
  returnTooLong: `理由は ${REVIEW_NOTE_MAX} 字までです`,
  paperRequired: '紙などで受け取ったときは、メモを入れてください',
  noteTooLong: `メモは ${REVIEW_NOTE_MAX} 字までです`,
} as const;

/**
 * 差し戻しの理由（必須。前後の空白を除いて 1〜1000 字）。RPC_ARGS の p_note（return_document。approve_document は nullable にして使う）。
 */
export const reviewNoteSchema = z
  .string()
  .trim()
  .refine((s) => s.length > 0, { message: REVIEW_NOTE_MESSAGES.returnRequired })
  .refine((s) => charCount(s) <= REVIEW_NOTE_MAX, { message: REVIEW_NOTE_MESSAGES.returnTooLong });

// 前後の空白を除いた理由・メモ（空なら null）。/document の最初に読む JS（(B1) の比べ方）も使うので、zod を読まない
// lib/modules/documents/review-note.ts に置き、ここから同じ名前で出し直す（FU3 の PR B の案 5）
export { normalizeReviewNote } from '@/lib/modules/documents/review-note';
