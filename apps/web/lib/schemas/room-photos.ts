// 現状復帰の写真（T25・D-63）のメモと並びの zod。room_photos の CHECK（memo は 50 字まで・制御文字〔改行を含む〕なし、sort_order は
// 0〜1000。0024）と同じ上限。前後の空白は除いてから確かめる（04「現状復帰の写真」）。
import { z } from 'zod';

/** メモの上限（`char_length(memo) <= 50`。0024） */
export const ROOM_PHOTO_MEMO_MAX = 50;
/** 並びの上限（0〜1000。0024） */
export const ROOM_PHOTO_SORT_MAX = 1000;
/** 年度・場所ごとの写真の上限（0024 のトリガー） */
export const ROOM_PHOTO_LIMIT = 6;

/** メモの上限を超えた・改行などが入った */
export const ROOM_PHOTO_MEMO_MESSAGE = `メモは ${ROOM_PHOTO_MEMO_MAX} 字までです`;
export const ROOM_PHOTO_MEMO_CONTROL_MESSAGE = 'メモに改行は入れられません';

// eslint-disable-next-line no-control-regex
const CONTROL = /[\u0000-\u001f\u007f-\u009f]/;

/** メモ（前後の空白を除いて 0〜50 字。改行などの制御文字なし。DB の char_length と同じくコードポイントで数える） */
export const roomPhotoMemoSchema = z
  .string()
  .trim()
  .refine((s) => [...s].length <= ROOM_PHOTO_MEMO_MAX, { message: ROOM_PHOTO_MEMO_MESSAGE })
  .refine((s) => !CONTROL.test(s), { message: ROOM_PHOTO_MEMO_CONTROL_MESSAGE });

/** 並び（0〜1000 の整数） */
export const roomPhotoSortSchema = z.number().int().min(0).max(ROOM_PHOTO_SORT_MAX);
