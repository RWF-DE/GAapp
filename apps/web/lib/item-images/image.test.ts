// 品目の画像の作り直し（04「在庫入力」の「新しく登録」。T23・D-61）：長い辺 1024px まで（小さい写真は大きくしない）・品質 0.8 の WebP、
// WebP を作れなければ JPEG。読めない・描き直せないときと 1 MiB を超えるときの誤り。canvas と createImageBitmap は偽の ItemImageEnv。
import { describe, expect, it, vi } from 'vitest';
import { staticImportGraph } from '@/lib/testing/import-graph';
import {
  ITEM_IMAGE_DECODE_MESSAGE,
  ITEM_IMAGE_MAX_BYTES,
  ITEM_IMAGE_MAX_SIDE,
  ITEM_IMAGE_QUALITY,
  ITEM_IMAGE_TOO_LARGE_MESSAGE,
  ROOM_PHOTO_MAX_SIDE,
  ItemImageDecodeError,
  ItemImageTooLargeError,
  itemImageSize,
  prepareItemImage,
  type ItemImageContentType,
  type ItemImageEnv,
} from './image';

/** 偽の道具：decode は決めた大きさの写真を返し、encode は頼まれた形・大きさ・品質を記録して out の物を返す */
function fakeEnv(width: number, height: number, out: (type: ItemImageContentType) => Blob | null = (type) => new Blob(['img'], { type })) {
  const encoded: { width: number; height: number; type: string; quality: number }[] = [];
  const close = vi.fn();
  const env: ItemImageEnv = {
    decode: async () => ({ width, height, source: {} as CanvasImageSource, close }),
    encode: async (_img, w, h, type, quality) => {
      encoded.push({ width: w, height: h, type, quality });
      return out(type);
    },
  };
  return { env, encoded, close };
}

describe('T23 itemImageSize（長い辺を 1024px までに。小さい写真はそのまま）', () => {
  it('横長・縦長・正方形・ちょうど 1024・小さい写真・細長い写真', () => {
    expect(ITEM_IMAGE_MAX_SIDE).toBe(1024);
    expect(itemImageSize(4032, 3024)).toEqual({ width: 1024, height: 768 });
    expect(itemImageSize(3024, 4032)).toEqual({ width: 768, height: 1024 });
    expect(itemImageSize(2000, 2000)).toEqual({ width: 1024, height: 1024 });
    expect(itemImageSize(1024, 500)).toEqual({ width: 1024, height: 500 });
    expect(itemImageSize(640, 480)).toEqual({ width: 640, height: 480 });
    expect(itemImageSize(100000, 10)).toEqual({ width: 1024, height: 1 });
  });

  it('幅・高さが正の数でなければ読めない写真', () => {
    for (const [w, h] of [
      [0, 10],
      [10, 0],
      [-1, 5],
      [Number.NaN, 5],
      [Number.POSITIVE_INFINITY, 5],
    ] as const) {
      expect(() => itemImageSize(w, h)).toThrow(ItemImageDecodeError);
    }
  });
});

describe('T23 prepareItemImage', () => {
  it('縮めた大きさ・品質 0.8 の WebP に描き直し、写真を閉じる', async () => {
    const { env, encoded, close } = fakeEnv(4032, 3024);
    const r = await prepareItemImage(new Blob(['x'], { type: 'image/jpeg' }), env);
    expect(r.contentType).toBe('image/webp');
    expect(r.blob.type).toBe('image/webp');
    expect(encoded).toEqual([{ width: 1024, height: 768, type: 'image/webp', quality: ITEM_IMAGE_QUALITY }]);
    expect(ITEM_IMAGE_QUALITY).toBe(0.8);
    expect(close).toHaveBeenCalledTimes(1);
  });

  it('小さい写真も同じ大きさで描き直す（EXIF を消すため、そのまま送らない）', async () => {
    const { env, encoded } = fakeEnv(320, 240);
    await prepareItemImage(new Blob(['x']), env);
    expect(encoded).toEqual([{ width: 320, height: 240, type: 'image/webp', quality: 0.8 }]);
  });

  it('WebP を作れない（PNG で返る・null・空・例外）ときは JPEG にする', async () => {
    for (const webp of [
      () => new Blob(['png'], { type: 'image/png' }),
      () => null,
      () => new Blob([], { type: 'image/webp' }),
      () => {
        throw new Error('canvas');
      },
    ]) {
      const { env, encoded } = fakeEnv(800, 600, (type) => (type === 'image/webp' ? webp() : new Blob(['jpg'], { type })));
      const r = await prepareItemImage(new Blob(['x']), env);
      expect(r.contentType).toBe('image/jpeg');
      expect(r.blob.type).toBe('image/jpeg');
      expect(encoded.map((e) => e.type)).toEqual(['image/webp', 'image/jpeg']);
    }
  });

  it('読めない・どちらの形にも描き直せないときは ItemImageDecodeError（読めたときは写真を閉じる）', async () => {
    const broken: ItemImageEnv = { decode: async () => Promise.reject(new Error('decode')), encode: async () => null };
    await expect(prepareItemImage(new Blob(['x']), broken)).rejects.toThrow(ITEM_IMAGE_DECODE_MESSAGE);
    const { env, close } = fakeEnv(100, 100, () => new Blob(['png'], { type: 'image/png' }));
    await expect(prepareItemImage(new Blob(['x']), env)).rejects.toBeInstanceOf(ItemImageDecodeError);
    expect(close).toHaveBeenCalledTimes(1);
    expect(new ItemImageDecodeError().message).toBe('写真を読み込めませんでした。別の写真を選んでください');
  });

  it('作り直しても 1 MiB を超えれば ItemImageTooLargeError（ちょうど 1 MiB は通す）', async () => {
    expect(ITEM_IMAGE_MAX_BYTES).toBe(1048576);
    const big = fakeEnv(1024, 1024, (type) => new Blob([new Uint8Array(ITEM_IMAGE_MAX_BYTES + 1)], { type }));
    await expect(prepareItemImage(new Blob(['x']), big.env)).rejects.toBeInstanceOf(ItemImageTooLargeError);
    expect(big.close).toHaveBeenCalledTimes(1);
    expect(new ItemImageTooLargeError().message).toBe(ITEM_IMAGE_TOO_LARGE_MESSAGE);
    const exact = fakeEnv(1024, 1024, (type) => new Blob([new Uint8Array(ITEM_IMAGE_MAX_BYTES)], { type }));
    await expect(prepareItemImage(new Blob(['x']), exact.env)).resolves.toMatchObject({ contentType: 'image/webp' });
  });

  it('image.ts はパッケージ・画面の部品を読まない（写真を送るときに動的 import する小さなモジュール）', () => {
    const g = staticImportGraph('lib/item-images/image.ts');
    expect(g.packages).toEqual([]);
    expect(g.files).toEqual(['lib/item-images/image.ts']);
  });
});

describe('T25 現状復帰の写真は長い辺 1600px（maxSide。品目の画像は 1024px のまま）', () => {
  it('maxSide を渡せばその大きさに縮め、渡さなければ 1024px', async () => {
    expect(ROOM_PHOTO_MAX_SIDE).toBe(1600);
    const room = fakeEnv(4032, 3024);
    await prepareItemImage(new Blob(['x']), room.env, { maxSide: ROOM_PHOTO_MAX_SIDE });
    expect(room.encoded[0]).toMatchObject({ width: 1600, height: 1200, type: 'image/webp', quality: 0.8 });
    const item = fakeEnv(4032, 3024);
    await prepareItemImage(new Blob(['x']), item.env);
    expect(item.encoded[0]).toMatchObject({ width: 1024, height: 768 });
    // 1600px より小さい写真はそのまま
    const small = fakeEnv(1280, 960);
    await prepareItemImage(new Blob(['x']), small.env, { maxSide: ROOM_PHOTO_MAX_SIDE });
    expect(small.encoded[0]).toMatchObject({ width: 1280, height: 960 });
  });
});

