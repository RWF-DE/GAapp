// 写真の作り直し（04「ファイルの扱い」、Q1。T19）：長い辺 2500px まで（小さい写真は大きくしない）・品質 0.85 の JPEG。読めない・描き直せない・
// JPEG にならないときは「写真を読み込めませんでした。別の写真を選んでください」。canvas と createImageBitmap は偽の ImageEnv で置き換える。
import { describe, expect, it, vi } from 'vitest';
import { staticImportGraph } from '@/lib/testing/import-graph';
import { IMAGE_DECODE_MESSAGE } from './files';
import { IMAGE_MAX_SIDE, ImageDecodeError, JPEG_QUALITY, reencodeJpeg, scaledSize, type DecodedImage, type ImageEnv } from './image';

/** 偽の道具：decode は決めた大きさの写真を返し、encode は描いた大きさと品質を記録して JPEG を返す */
function fakeEnv(width: number, height: number, out: (w: number, h: number) => Blob | null = () => new Blob(['jpeg'], { type: 'image/jpeg' })) {
  const encoded: { width: number; height: number; quality: number }[] = [];
  const close = vi.fn();
  const env: ImageEnv = {
    decode: async () => ({ width, height, source: {} as CanvasImageSource, close }) satisfies DecodedImage,
    encode: async (_img, w, h, quality) => {
      encoded.push({ width: w, height: h, quality });
      return out(w, h);
    },
  };
  return { env, encoded, close };
}

describe('T19 scaledSize（長い辺を 2500px までに。小さい写真はそのまま）', () => {
  it('横長・縦長・正方形・ちょうど 2500・小さい写真', () => {
    expect(IMAGE_MAX_SIDE).toBe(2500);
    expect(scaledSize(4032, 3024)).toEqual({ width: 2500, height: 1875 });
    expect(scaledSize(3024, 4032)).toEqual({ width: 1875, height: 2500 });
    expect(scaledSize(5000, 5000)).toEqual({ width: 2500, height: 2500 });
    expect(scaledSize(2500, 1000)).toEqual({ width: 2500, height: 1000 });
    expect(scaledSize(800, 600)).toEqual({ width: 800, height: 600 });
    // とても細長い写真でも 1px より小さくしない
    expect(scaledSize(100000, 10)).toEqual({ width: 2500, height: 1 });
  });

  it('幅・高さが正の数でなければ読めない写真', () => {
    for (const [w, h] of [
      [0, 10],
      [10, 0],
      [-1, 5],
      [Number.NaN, 5],
      [Number.POSITIVE_INFINITY, 5],
    ] as const) {
      expect(() => scaledSize(w, h)).toThrow(ImageDecodeError);
    }
  });
});

describe('T19 reencodeJpeg', () => {
  it('縮めた大きさ・品質 0.85 で JPEG に描き直し、写真を閉じる', async () => {
    const { env, encoded, close } = fakeEnv(4032, 3024);
    const blob = await reencodeJpeg(new Blob(['x'], { type: 'image/jpeg' }), env);
    expect(blob.type).toBe('image/jpeg');
    expect(encoded).toEqual([{ width: 2500, height: 1875, quality: JPEG_QUALITY }]);
    expect(JPEG_QUALITY).toBe(0.85);
    expect(close).toHaveBeenCalledTimes(1);
  });

  it('小さい写真は同じ大きさで描き直す（EXIF を消すため、そのまま送らない）', async () => {
    const { env, encoded } = fakeEnv(640, 480);
    await reencodeJpeg(new Blob(['x']), env);
    expect(encoded).toEqual([{ width: 640, height: 480, quality: 0.85 }]);
  });

  it('読めない・描き直せない（null・空・JPEG でない・例外）ときは ImageDecodeError（文言は 04 のとおり）。読めたときは写真を閉じる', async () => {
    const broken: ImageEnv = { decode: async () => Promise.reject(new Error('decode')), encode: async () => null };
    await expect(reencodeJpeg(new Blob(['x']), broken)).rejects.toThrow(IMAGE_DECODE_MESSAGE);
    for (const out of [() => null, () => new Blob([], { type: 'image/jpeg' }), () => new Blob(['png'], { type: 'image/png' })]) {
      const { env, close } = fakeEnv(100, 100, out);
      await expect(reencodeJpeg(new Blob(['x']), env)).rejects.toBeInstanceOf(ImageDecodeError);
      expect(close).toHaveBeenCalledTimes(1);
    }
    const throwing = fakeEnv(100, 100);
    throwing.env.encode = async () => Promise.reject(new Error('canvas'));
    await expect(reencodeJpeg(new Blob(['x']), throwing.env)).rejects.toBeInstanceOf(ImageDecodeError);
    expect(throwing.close).toHaveBeenCalledTimes(1);
    expect(new ImageDecodeError().message).toBe('写真を読み込めませんでした。別の写真を選んでください');
  });

  it('image.ts は React・Supabase・画面の部品を読まない（ファイルを選んだときに動的 import する小さなモジュール）', () => {
    const g = staticImportGraph('lib/modules/documents/image.ts');
    expect(g.packages).toEqual([]);
    expect(g.files.filter((f) => f.startsWith('lib/data/') || f.startsWith('components/') || f.startsWith('app/'))).toEqual([]);
  });
});
