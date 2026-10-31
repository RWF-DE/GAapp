// お知らせの題名・本文・宛先の団体の上限と、題名の zod（T17・D-53）。lib/rpc/payloads.ts（RPC_ARGS の save_notice）と
// lib/schemas/notices.ts（ダイアログの入力）が使う。RPC_ARGS は申請・自団体の振り分けなどほかの画面の JS にも入るので、ここには
// 送る前の確かめに要る小さなものだけを置き、ダイアログの入力の形（noticeFormSchema など）は lib/schemas/notices.ts に置く
// （ほかの画面の最初に読む JS を増やさない）。
// - 題名は前後の空白を除いて 1〜100 字。除く空白は zod の trim（JavaScript の String.prototype.trim）で、DB の c_space と同じ 25 文字。
// - 字数は文字（Unicode のコードポイント。`[...s].length`）で数え、DB の length と同じにする（JavaScript の length は
//   絵文字などを 2 と数え、DB より狭くなる。notes/T17.md の後半の判断したことの 10）。
import { z } from 'zod';

/** 題名の上限（notices_title_check の `length(title) <= 100`） */
export const NOTICE_TITLE_MAX = 100;
/** 本文の上限（notices_body_check の `length(body) <= 4000`） */
export const NOTICE_BODY_MAX = 4000;
/** 宛先の団体の上限（save_notice の too_many） */
export const NOTICE_GROUPS_MAX = 1000;

/** 文字の数（Unicode のコードポイント。DB の length と同じ数え方） */
export function charCount(s: string): number {
  return [...s].length;
}

/** 題名（前後の空白を除いた後で 1〜100 字） */
export const noticeTitleSchema = z
  .string()
  .trim()
  .refine((s) => s.length > 0, { message: '題名を入れてください' })
  .refine((s) => charCount(s) <= NOTICE_TITLE_MAX, { message: `題名は ${NOTICE_TITLE_MAX} 字までです` });
