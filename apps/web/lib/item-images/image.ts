// 品目の画像の作り直し（04「在庫入力」の「新しく登録」・「マスタ設定」の品目のタブ。T23・D-61）：長い辺を 1024px までに縮め
// （小さい写真は大きくしない）、向き（EXIF の Orientation）を当ててから、品質 0.8 の WebP に描き直す。WebP を作れない端末
// （canvas が WebP を作れず別の形で返す）は品質 0.8 の JPEG にする。canvas で描き直すので、位置情報などの EXIF は残らない。
// 作り直した物が 1 MiB（bucket item-images の上限）を超えれば ItemImageTooLargeError。読めなければ ItemImageDecodeError。
// このファイルは写真を送るとき（lib/item-images/upload.ts）だけが読む。upload.ts は画面が写真を選んだ後に動的 import で読む
// （在庫入力・申請・マスタ設定の最初に読む JS に入れない）。createImageBitmap（使えなければ img 要素）と canvas（OffscreenCanvas、
// なければ canvas 要素）は、呼んだときの処理の中だけで使う（プリレンダーの間はない）。テストは ItemImageEnv を偽にする。

/** 長い辺の上限（px） */
export const ITEM_IMAGE_MAX_SIDE = 1024;
/** WebP・JPEG の品質 */
export const ITEM_IMAGE_QUALITY = 0.8;
/** 1 枚の上限（bucket item-images の file_size_limit。1 MiB） */
export const ITEM_IMAGE_MAX_BYTES = 1_048_576;

/** 上げる形（bucket item-images が許す形。予約の content_type） */
export type ItemImageContentType = 'image/webp' | 'image/jpeg';

/** 写真を読めない・作り直せない */
export const ITEM_IMAGE_DECODE_MESSAGE = '写真を読み込めませんでした。別の写真を選んでください';
/** 作り直しても 1 MiB を超える */
export const ITEM_IMAGE_TOO_LARGE_MESSAGE = '写真が大きすぎます。別の写真を選んでください';

export class ItemImageDecodeError extends Error {
  override name = 'ItemImageDecodeError';
  constructor() {
    super(ITEM_IMAGE_DECODE_MESSAGE);
  }
}

export class ItemImageTooLargeError extends Error {
  override name = 'ItemImageTooLargeError';
  constructor() {
    super(ITEM_IMAGE_TOO_LARGE_MESSAGE);
  }
}

/**
 * 縮めた大きさ（長い辺を max までに。小さい写真はそのまま。どちらの辺も 1px 以上）。幅・高さが正の数でなければ ItemImageDecodeError。
 *
 * @example
 * itemImageSize(4032, 3024) // { width: 1024, height: 768 }
 */
export function itemImageSize(width: number, height: number, max: number = ITEM_IMAGE_MAX_SIDE): { width: number; height: number } {
  if (!(width > 0) || !(height > 0) || !Number.isFinite(width) || !Number.isFinite(height)) throw new ItemImageDecodeError();
  const long = Math.max(width, height);
  if (long <= max) return { width: Math.round(width), height: Math.round(height) };
  const k = max / long;
  return { width: Math.max(1, Math.round(width * k)), height: Math.max(1, Math.round(height * k)) };
}

/** 読んだ写真（向きを当てた後の大きさ） */
export interface DecodedItemImage {
  width: number;
  height: number;
  source: CanvasImageSource;
  /** 使い終わったら呼ぶ（ImageBitmap を閉じる・object URL を外す） */
  close(): void;
}

/** 写真を読む・描き直す道具（テストで差し替える） */
export interface ItemImageEnv {
  decode(blob: Blob): Promise<DecodedItemImage>;
  /** width × height に type で描き直した物（作れなければ null。作れない形を頼むと、ブラウザは PNG などで返すことがある） */
  encode(image: DecodedItemImage, width: number, height: number, type: ItemImageContentType, quality: number): Promise<Blob | null>;
}

async function decodeInBrowser(blob: Blob): Promise<DecodedItemImage> {
  if (typeof createImageBitmap === 'function') {
    try {
      const bmp = await createImageBitmap(blob, { imageOrientation: 'from-image' });
      return { width: bmp.width, height: bmp.height, source: bmp, close: () => bmp.close() };
    } catch {
      // 読めない形・古いブラウザ：img 要素で読む
    }
  }
  const url = URL.createObjectURL(blob);
  try {
    const img = new Image();
    img.decoding = 'async';
    img.src = url;
    await img.decode();
    // img 要素は EXIF の向きを当てて描く（CSS の image-orientation の既定は from-image）
    return { width: img.naturalWidth, height: img.naturalHeight, source: img, close: () => URL.revokeObjectURL(url) };
  } catch (e) {
    URL.revokeObjectURL(url);
    throw e;
  }
}

async function encodeInBrowser(
  image: DecodedItemImage,
  width: number,
  height: number,
  type: ItemImageContentType,
  quality: number,
): Promise<Blob | null> {
  if (typeof OffscreenCanvas !== 'undefined') {
    const canvas = new OffscreenCanvas(width, height);
    const ctx = canvas.getContext('2d');
    if (!ctx) return null;
    ctx.drawImage(image.source, 0, 0, width, height);
    return canvas.convertToBlob({ type, quality });
  }
  const canvas = document.createElement('canvas');
  canvas.width = width;
  canvas.height = height;
  const ctx = canvas.getContext('2d');
  if (!ctx) return null;
  ctx.drawImage(image.source, 0, 0, width, height);
  return new Promise((resolve) => canvas.toBlob(resolve, type, quality));
}

/** ブラウザの道具（createImageBitmap・canvas） */
export const BROWSER_ITEM_IMAGE_ENV: ItemImageEnv = { decode: decodeInBrowser, encode: encodeInBrowser };

/** 作り直した画像（予約の content_type と、送る Blob） */
export interface PreparedItemImage {
  blob: Blob;
  contentType: ItemImageContentType;
}

async function tryEncode(env: ItemImageEnv, image: DecodedItemImage, w: number, h: number, type: ItemImageContentType): Promise<Blob | null> {
  try {
    const out = await env.encode(image, w, h, type, ITEM_IMAGE_QUALITY);
    // 頼んだ形でなければ作れなかった（WebP を作れないブラウザは PNG で返す）
    return out && out.size > 0 && out.type === type ? out : null;
  } catch {
    return null;
  }
}

/**
 * 写真を品目の画像にする（長い辺 1024px まで・向きを当てる・品質 0.8 の WebP、作れなければ JPEG。EXIF は残らない）。
 * 読めない・どちらの形にも描き直せないときは ItemImageDecodeError、1 MiB を超えれば ItemImageTooLargeError。
 *
 * @example
 * const { blob, contentType } = await prepareItemImage(file); // reserve_item_image の content_type は contentType
 */
export async function prepareItemImage(file: Blob, env: ItemImageEnv = BROWSER_ITEM_IMAGE_ENV): Promise<PreparedItemImage> {
  let image: DecodedItemImage;
  try {
    image = await env.decode(file);
  } catch {
    throw new ItemImageDecodeError();
  }
  try {
    const { width, height } = itemImageSize(image.width, image.height);
    for (const type of ['image/webp', 'image/jpeg'] as const) {
      const blob = await tryEncode(env, image, width, height, type);
      if (!blob) continue;
      if (blob.size > ITEM_IMAGE_MAX_BYTES) throw new ItemImageTooLargeError();
      return { blob, contentType: type };
    }
    throw new ItemImageDecodeError();
  } finally {
    image.close();
  }
}
