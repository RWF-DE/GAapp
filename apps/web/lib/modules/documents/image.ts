// 写真（JPEG）の作り直し（04「提出物」のファイルの扱い、Q1。T19・D-55）：長い辺を 2500px までに縮め（小さい写真は大きくしない）、
// 向き（EXIF の Orientation）を当ててから、品質 0.85 の JPEG にする（canvas で描き直すので、位置情報などの EXIF は残らない）。
// 読めなければ ImageDecodeError（文言は「写真を読み込めませんでした。別の写真を選んでください」）。PDF・PNG は作り直さない。
// このファイルは、ファイルを選んだときに動的 import で読む（`await import('@/lib/modules/documents/image')`。/document と /documents の
// 最初に読む JS に入れない）。createImageBitmap（使えなければ img 要素）と canvas（OffscreenCanvas、なければ canvas 要素）は、
// 呼んだときの処理の中だけで使う（プリレンダーの間はない）。テストは ImageEnv を偽にして、縮める大きさと形を確かめる。
import { IMAGE_DECODE_MESSAGE } from './files';

/** 長い辺の上限（px） */
export const IMAGE_MAX_SIDE = 2500;
/** JPEG の品質 */
export const JPEG_QUALITY = 0.85;

/** 写真を読めない・作り直せない */
export class ImageDecodeError extends Error {
  override name = 'ImageDecodeError';
  constructor() {
    super(IMAGE_DECODE_MESSAGE);
  }
}

/**
 * 縮めた大きさ（長い辺を max までに。小さい写真はそのまま。どちらの辺も 1px 以上）。幅・高さが正の数でなければ ImageDecodeError。
 *
 * @example
 * scaledSize(4032, 3024) // { width: 2500, height: 1875 }
 */
export function scaledSize(width: number, height: number, max: number = IMAGE_MAX_SIDE): { width: number; height: number } {
  if (!(width > 0) || !(height > 0) || !Number.isFinite(width) || !Number.isFinite(height)) throw new ImageDecodeError();
  const long = Math.max(width, height);
  if (long <= max) return { width: Math.round(width), height: Math.round(height) };
  const k = max / long;
  return { width: Math.max(1, Math.round(width * k)), height: Math.max(1, Math.round(height * k)) };
}

/** 読んだ写真（向きを当てた後の大きさ） */
export interface DecodedImage {
  width: number;
  height: number;
  source: CanvasImageSource;
  /** 使い終わったら呼ぶ（ImageBitmap を閉じる・object URL を外す） */
  close(): void;
}

/** 写真を読む・JPEG に描き直す道具（テストで差し替える） */
export interface ImageEnv {
  decode(blob: Blob): Promise<DecodedImage>;
  /** width × height に描き直した JPEG（作れなければ null） */
  encode(image: DecodedImage, width: number, height: number, quality: number): Promise<Blob | null>;
}

async function decodeInBrowser(blob: Blob): Promise<DecodedImage> {
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

async function encodeInBrowser(image: DecodedImage, width: number, height: number, quality: number): Promise<Blob | null> {
  if (typeof OffscreenCanvas !== 'undefined') {
    const canvas = new OffscreenCanvas(width, height);
    const ctx = canvas.getContext('2d');
    if (!ctx) return null;
    ctx.drawImage(image.source, 0, 0, width, height);
    return canvas.convertToBlob({ type: 'image/jpeg', quality });
  }
  const canvas = document.createElement('canvas');
  canvas.width = width;
  canvas.height = height;
  const ctx = canvas.getContext('2d');
  if (!ctx) return null;
  ctx.drawImage(image.source, 0, 0, width, height);
  return new Promise((resolve) => canvas.toBlob(resolve, 'image/jpeg', quality));
}

/** ブラウザの道具（createImageBitmap・canvas） */
export const BROWSER_IMAGE_ENV: ImageEnv = { decode: decodeInBrowser, encode: encodeInBrowser };

/**
 * JPEG を作り直す（長い辺 2500px まで・向きを当てる・品質 0.85。EXIF は残らない）。読めない・描き直せない・JPEG にならない
 * （canvas が JPEG を作れず別の形で返した）ときは ImageDecodeError。
 *
 * @example
 * const { reencodeJpeg } = await import('@/lib/modules/documents/image');
 * const blob = await reencodeJpeg(file); // 予約の size は blob.size
 */
export async function reencodeJpeg(file: Blob, env: ImageEnv = BROWSER_IMAGE_ENV): Promise<Blob> {
  let image: DecodedImage;
  try {
    image = await env.decode(file);
  } catch {
    throw new ImageDecodeError();
  }
  try {
    const { width, height } = scaledSize(image.width, image.height);
    let out: Blob | null;
    try {
      out = await env.encode(image, width, height, JPEG_QUALITY);
    } catch {
      out = null;
    }
    if (!out || out.size === 0 || out.type !== 'image/jpeg') throw new ImageDecodeError();
    return out;
  } finally {
    image.close();
  }
}
