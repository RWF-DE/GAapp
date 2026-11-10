// 品目の画像の失敗の文言（T23・D-61。04「在庫入力」の「新しく登録」・「マスタ設定」の品目のタブ・「DB関数」の reserve_item_image・
// set_item_image）。lib/errors.ts には置かない：errors.ts はダッシュボード（/）の最初に読む JS に入るので、画像の文言は写真を送るとき
// （lib/item-images/upload.ts。動的 import）だけが読むこのファイルに置く（D-51。/ の JS を増やさない）。
import { classifyError, messageFor, type ClassifiedError } from '@/lib/errors';
import { labelOf } from '@/lib/labels';

/** 品目の画像の RPC の invalid_state の reason */
export const ITEM_IMAGE_STATE_MESSAGES: Readonly<Record<string, string>> = {
  too_many_reservations: '送っている途中の写真が多すぎます（1人 10 枚まで）。1 時間ほど待ってから、もう一度送ってください',
  too_many_orphans: '前の写真の残りが片付きません。少し待ってから、もう一度送ってください',
  storage_full: '画像の置き場がいっぱいです（上限 100 MB）。管理者に知らせてください',
  not_uploaded: '写真が届いていませんでした。もう一度送ってください',
  used: 'ほかの人が先に画像を変えました。読み直しました',
};
/** 品目の画像の RPC の invalid_input（キーは `field` か `field:reason`） */
export const ITEM_IMAGE_INPUT_MESSAGES: Readonly<Record<string, string>> = {
  content_type: 'WebP か JPEG の写真にしてください',
  'image_id:in_use': '写真の番号が重なりました。もう一度送ってください',
  'image_id:not_reserved': '写真の予約が見つかりません。もう一度送ってください',
};
/** 品目の画像の RPC の not_found（物が消えた） */
export const ITEM_IMAGE_MISSING_MESSAGE = 'この物は見つかりません（ほかの人が削除した可能性があります）。読み直しました';
/**
 * 品目の画像の Storage API のエラー（upload.ts の toItemImageStorageError が本文の statusCode・code で分けた AppError の reason。
 * 提出物の STORAGE_ERROR_MESSAGES とは上限・形が違うので分ける）
 */
export const ITEM_IMAGE_STORAGE_MESSAGES: Readonly<Record<string, string>> = {
  item_image_denied: '写真を送れませんでした。立場が変わったか、予約の期限（1 時間）が切れた可能性があります。もう一度送ってください',
  item_image_too_large: '写真は1枚 1 MB までです',
  item_image_mime: 'WebP か JPEG の写真にしてください',
  item_image_failed: '画像の置き場で問題が起きました。少し待ってから、もう一度',
};

const isRecord = (v: unknown): v is Record<string, unknown> => typeof v === 'object' && v !== null && !Array.isArray(v);

/** 品目の画像の RPC の文言（当てはまらなければ null。forbidden・通信などは messageFor の今の文言） */
function rpcMessage(e: ClassifiedError): string | null {
  const d = isRecord(e.details) ? e.details : null;
  if (e.kind === 'not_found') return ITEM_IMAGE_MISSING_MESSAGE;
  if (e.kind === 'state' && d && typeof d.reason === 'string') return labelOf(ITEM_IMAGE_STATE_MESSAGES, d.reason) || null;
  if (e.kind === 'input' && d && typeof d.field === 'string') {
    const key = typeof d.reason === 'string' ? `${d.field}:${d.reason}` : d.field;
    return labelOf(ITEM_IMAGE_INPUT_MESSAGES, key) || labelOf(ITEM_IMAGE_INPUT_MESSAGES, d.field) || null;
  }
  return null;
}

/**
 * 品目の画像の失敗の文言。Storage API のエラー（item_image_*）、RPC（reserve_item_image・set_item_image）の invalid_state・
 * invalid_input・not_found はこのファイルの文言、ほか（forbidden・通信・ログイン）は messageFor の文言。
 */
export function itemImageMessageFor(cause: unknown, rpc: 'reserve_item_image' | 'set_item_image' | null): string {
  const c = classifyError(cause);
  const storage = labelOf(ITEM_IMAGE_STORAGE_MESSAGES, c.reason);
  if (storage) return storage;
  if (rpc) {
    const m = rpcMessage(c);
    if (m) return m;
    return messageFor(c, { rpc });
  }
  return messageFor(c);
}
