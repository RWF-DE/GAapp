// 現状復帰の写真の失敗の文言（T25・D-63。04「現状復帰の写真」のエラー）。lib/errors.ts には置かない：errors.ts はダッシュボード（/）の
// 最初に読む JS に入るので、写真の文言は /room-photos の画面と、写真を送るとき（lib/room-photos/upload.ts。動的 import）だけが読む
// このファイルに置く（D-51・D-52。/ の JS を増やさない）。
import { classifyError, messageFor } from '@/lib/errors';
import { labelOf } from '@/lib/labels';
import { ITEM_IMAGE_STORAGE_MESSAGES } from '@/lib/item-images/messages';
import { ROOM_PHOTO_MEMO_MESSAGE } from '@/lib/schemas/room-photos';

/** 片付けて1回やり直しても上限のまま（too_many_reservations・too_many_orphans） */
export const ROOM_PHOTO_RETRY_LATER_MESSAGE = '送れませんでした。しばらくしてからもう一度送ってください';
/** 終了した年度（invalid_state の detail が status: closed） */
export const ROOM_PHOTO_CLOSED_MESSAGE = '終了した年度のため、写真は見るだけです';
/** 更新・削除で写真がない（読み直す） */
export const ROOM_PHOTO_GONE_MESSAGE = 'ほかの人が消しました';

/** 写真の RPC の invalid_state の reason */
export const ROOM_PHOTO_STATE_MESSAGES: Readonly<Record<string, string>> = {
  too_many_photos: 'この部屋の写真は 6 枚までです。足すときは先に消してください',
  storage_full: '写真の置き場がいっぱいです。管理者に相談してください',
  too_many_reservations: ROOM_PHOTO_RETRY_LATER_MESSAGE,
  too_many_orphans: ROOM_PHOTO_RETRY_LATER_MESSAGE,
  not_uploaded: '写真がまだ届いていません。もう一度「送る」を押してください',
  used: 'この写真はもう消されています。写真を選び直してください',
};
/** 写真の RPC の invalid_input（キーは `field` か `field:reason`） */
export const ROOM_PHOTO_INPUT_MESSAGES: Readonly<Record<string, string>> = {
  memo: ROOM_PHOTO_MEMO_MESSAGE,
  content_type: 'WebP か JPEG の写真にしてください',
  sort_order: '並びを変えられませんでした。読み直してください',
  'photo_id:in_use': '写真の番号が重なりました。写真を選び直してください',
  'photo_id:not_reserved': '写真の予約が見つかりません。もう一度「送る」を押してください',
};

/** どの操作の失敗か（forbidden の文言を分ける） */
export type RoomPhotoOp = 'add' | 'edit';

const isRecord = (v: unknown): v is Record<string, unknown> => typeof v === 'object' && v !== null && !Array.isArray(v);

/**
 * 現状復帰の写真の失敗の文言。Storage API のエラー（item_image_*。品目の画像と同じ分け方）、RPC の invalid_state・invalid_input・
 * not_found・forbidden はこのファイルの文言、ほか（通信・ログイン）は messageFor の文言。
 *
 * @example
 * roomPhotoMessageFor(e, 'add') // 'この部屋の写真は 6 枚までです。足すときは先に消してください'
 */
export function roomPhotoMessageFor(cause: unknown, op: RoomPhotoOp): string {
  const c = classifyError(cause);
  const storage = labelOf(ITEM_IMAGE_STORAGE_MESSAGES, c.reason);
  if (storage) return storage;
  const d = isRecord(c.details) ? c.details : null;
  if (c.kind === 'state' && d) {
    if (d.status === 'closed') return ROOM_PHOTO_CLOSED_MESSAGE;
    if (typeof d.reason === 'string') {
      const m = labelOf(ROOM_PHOTO_STATE_MESSAGES, d.reason);
      if (m) return m;
    }
  }
  if (c.kind === 'input' && d && typeof d.field === 'string') {
    const key = typeof d.reason === 'string' ? `${d.field}:${d.reason}` : d.field;
    const m = labelOf(ROOM_PHOTO_INPUT_MESSAGES, key) || labelOf(ROOM_PHOTO_INPUT_MESSAGES, d.field);
    if (m) return m;
  }
  if (c.kind === 'not_found') return ROOM_PHOTO_GONE_MESSAGE;
  if (c.kind === 'forbidden') return op === 'add' ? '写真を足す権限がありません' : 'この写真を直す権限がありません';
  return messageFor(c);
}

/** 立場を読み直すべき失敗か（forbidden・終了した年度。04：読み直して立場を出し直す） */
export function roomPhotoNeedsMembershipReload(cause: unknown): boolean {
  const c = classifyError(cause);
  if (c.kind === 'forbidden' && c.reason !== 'item_image_denied') return true;
  return c.kind === 'state' && isRecord(c.details) && c.details.status === 'closed';
}

/** 写真の行がなくなっていた（更新・削除の not_found。読み直す） */
export function isRoomPhotoGone(cause: unknown): boolean {
  return classifyError(cause).kind === 'not_found';
}
