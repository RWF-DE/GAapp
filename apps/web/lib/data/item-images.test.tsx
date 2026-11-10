// @vitest-environment jsdom
// 品目の画像の読み取り（04「品目の画像の共通の部品」。T23・D-61）：行の path（id と image_path だけ）、署名つき URL を
// createSignedUrls で1回にまとめる（10 分）、useItemImageUrls が path を並べて重なりを除き1回だけ呼ぶこと、作れなかった path、
// 9 分より古い URL の読み込みの失敗で作り直すこと。
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { act, renderHook, waitFor } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { createFakeSupabase, opArgs } from '@/lib/testing/fake-supabase';
import type { AppSupabaseClient } from '@/lib/supabase/client';

const sign = vi.hoisted(() => ({
  calls: [] as { bucket: string; paths: string[]; expiresIn: number }[],
  result: null as null | ((paths: string[]) => unknown),
}));
vi.mock('@/lib/supabase/client', () => ({
  getSupabase: () => ({
    storage: {
      from: (bucket: string) => ({
        createSignedUrls: async (paths: string[], expiresIn: number) => {
          sign.calls.push({ bucket, paths, expiresIn });
          return sign.result ? sign.result(paths) : { data: paths.map((p) => ({ path: p, signedUrl: `https://x/sign/${p}?t=${sign.calls.length}`, error: null })), error: null };
        },
      }),
    },
  }),
}));

const upload = vi.hoisted(() => ({
  attach: [] as { kind: string; id: string; imageId: string | undefined }[],
  detach: [] as { kind: string; id: string }[],
  folder: [] as { kind: string; id: string }[],
}));
vi.mock('@/lib/item-images/upload', () => {
  class ItemImageError extends Error {}
  return {
    ItemImageError,
    itemImageErrorMessage: () => 'x',
    attachItemImage: async (kind: string, id: string, _file: Blob, deps: { imageId?: string } = {}) => {
      upload.attach.push({ kind, id, imageId: deps.imageId });
      return { path: 'p', previous: null, previousRemoved: true };
    },
    detachItemImage: async (kind: string, id: string) => {
      upload.detach.push({ kind, id });
      return null;
    },
    removeItemImageFolder: async (kind: string, id: string) => {
      upload.folder.push({ kind, id });
      return true;
    },
  };
});

import {
  fetchItemImagePath,
  fetchItemImagePaths,
  removeDeletedItemImages,
  removeItemImage,
  sendItemImage,
  ITEM_IMAGE_SIGNED_URL_SECONDS,
  ITEM_IMAGE_URL_REFRESH_MS,
  signItemImagePaths,
  useItemImageUrls,
} from './item-images';

afterEach(() => {
  sign.calls = [];
  sign.result = null;
  vi.useRealTimers();
});

function wrapper() {
  const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  return function Wrapper({ children }: { children: React.ReactNode }) {
    return <QueryClientProvider client={qc}>{children}</QueryClientProvider>;
  };
}

describe('T23 fetchItemImagePaths', () => {
  it('id と image_path だけを読み、画像のない行は入れない', async () => {
    const fake = createFakeSupabase(() => ({ data: [{ id: 'a', image_path: 'items/a/1.webp' }, { id: 'b', image_path: null }] }));
    const m = await fetchItemImagePaths('item', fake.client);
    expect([...m]).toEqual([['a', 'items/a/1.webp']]);
    expect(fake.issued[0]!.table).toBe('items');
    expect(opArgs(fake.issued[0]!, 'select')).toEqual([['id, image_path']]);
    const c = createFakeSupabase(() => ({ data: [] }));
    await fetchItemImagePaths('count_item', c.client);
    expect(c.issued[0]!.table).toBe('count_items');
  });
});

describe('T23 signItemImagePaths', () => {
  it('bucket item-images の createSignedUrls を1回・600 秒で呼び、作れなかった path は入れない', async () => {
    sign.result = (paths) => ({ data: paths.map((p, i) => (i === 1 ? { path: p, signedUrl: null, error: 'not found' } : { path: p, signedUrl: `u:${p}`, error: null })), error: null });
    const m = await signItemImagePaths(['p1', 'p2', 'p3'], undefined as unknown as AppSupabaseClient);
    expect(sign.calls).toEqual([{ bucket: 'item-images', paths: ['p1', 'p2', 'p3'], expiresIn: 600 }]);
    expect(ITEM_IMAGE_SIGNED_URL_SECONDS).toBe(600);
    expect([...m]).toEqual([
      ['p1', 'u:p1'],
      ['p3', 'u:p3'],
    ]);
    expect((await signItemImagePaths([])).size).toBe(0);
    expect(sign.calls).toHaveLength(1);
  });
});

describe('T23 useItemImageUrls', () => {
  it('path を並べて重なり・空を除き、createSignedUrls を1回だけ呼ぶ。path がなければ呼ばない', async () => {
    const { result } = renderHook(() => useItemImageUrls(['b', null, 'a', undefined, 'b', '']), { wrapper: wrapper() });
    expect(result.current.pending).toBe(true);
    await waitFor(() => expect(result.current.pending).toBe(false));
    expect(sign.calls.map((c) => c.paths)).toEqual([['a', 'b']]);
    expect(result.current.urls.get('a')).toMatch(/^https:\/\/x\/sign\/a/);
    const none = renderHook(() => useItemImageUrls([null, undefined]), { wrapper: wrapper() });
    expect(none.result.current.pending).toBe(false);
    expect(none.result.current.urls.size).toBe(0);
    expect(sign.calls).toHaveLength(1);
  });

  it('読み込みの失敗：作ったばかりの URL は作り直さず、9 分より古ければ作り直す', async () => {
    const now = Date.now();
    const spy = vi.spyOn(Date, 'now').mockReturnValue(now);
    const { result } = renderHook(() => useItemImageUrls(['a']), { wrapper: wrapper() });
    await waitFor(() => expect(result.current.urls.size).toBe(1));
    expect(result.current.reportError()).toBe(false);
    expect(sign.calls).toHaveLength(1);
    spy.mockReturnValue(now + ITEM_IMAGE_URL_REFRESH_MS + 1);
    let again = false;
    act(() => {
      again = result.current.reportError();
    });
    expect(again).toBe(true);
    await waitFor(() => expect(sign.calls).toHaveLength(2));
    spy.mockRestore();
  });

  it('全体が失敗したら URL なし（画面は頭文字のカード）', async () => {
    sign.result = () => ({ data: null, error: { message: 'boom', statusCode: '500' } });
    const { result } = renderHook(() => useItemImageUrls(['a']), { wrapper: wrapper() });
    // 1回だけ送り直してから（retry: 1）失敗にする
    await waitFor(() => expect(result.current.pending).toBe(false), { timeout: 4000 });
    expect(result.current.urls.size).toBe(0);
    expect(sign.calls).toHaveLength(2);
  });
});

describe('T23 レビューで直したこと：送る・外すの後に行の一覧も読み直す（updated_at の楽観ロック）', () => {
  const keysOf = (qc: QueryClient) => {
    const spy = vi.spyOn(qc, 'invalidateQueries');
    return () => spy.mock.calls.map((c) => c[0]);
  };
  const matched = (qc: QueryClient, filters: unknown[]) => {
    const cache = qc.getQueryCache();
    return (key: readonly unknown[]) => filters.some((f) => cache.findAll(f as Parameters<typeof cache.findAll>[0]).some((q) => q.queryKey === key || JSON.stringify(q.queryKey) === JSON.stringify(key)));
  };
  const seed = (qc: QueryClient) => {
    for (const key of [
      ['item-images', 'paths', 'item'],
      ['item-images', 'paths', 'count_item'],
      ['items', 'settings'],
      ['count_items', 'settings'],
      ['year', 'Y1', 'stock-master'],
      ['year', 'Y1', 'stocks', 'room', 'R1'],
    ]) qc.setQueryData(key, 1);
  };

  it('count_item を送ったら、画像の path・備品の表・在庫入力の名前の一覧を読み直す（品目の表と在庫は読み直さない）。imageId を渡す', async () => {
    const qc = new QueryClient();
    seed(qc);
    const calls = keysOf(qc);
    const r = await sendItemImage(qc, 'count_item', 'C1', new Blob(['x']), { imageId: 'IMG' });
    expect(r).toEqual({ ok: true });
    expect(upload.attach.at(-1)).toEqual({ kind: 'count_item', id: 'C1', imageId: 'IMG' });
    const hit = matched(qc, calls());
    expect(hit(['item-images', 'paths', 'count_item'])).toBe(true);
    expect(hit(['count_items', 'settings'])).toBe(true);
    expect(hit(['year', 'Y1', 'stock-master'])).toBe(true);
    expect(hit(['items', 'settings'])).toBe(false);
    expect(hit(['year', 'Y1', 'stocks', 'room', 'R1'])).toBe(false);
  });

  it('item を外したら、画像の path・品目の表（settingsKeys.items）・在庫入力の名前の一覧を読み直す', async () => {
    const qc = new QueryClient();
    seed(qc);
    const calls = keysOf(qc);
    await removeItemImage(qc, 'item', 'I1');
    expect(upload.detach.at(-1)).toEqual({ kind: 'item', id: 'I1' });
    const hit = matched(qc, calls());
    expect(hit(['item-images', 'paths', 'item'])).toBe(true);
    expect(hit(['items', 'settings'])).toBe(true);
    expect(hit(['year', 'Y1', 'stock-master'])).toBe(true);
    expect(hit(['count_items', 'settings'])).toBe(false);
  });

  it('removeDeletedItemImages：消した行のフォルダを片付ける（投げない）', async () => {
    await removeDeletedItemImages('count_item', 'C9');
    expect(upload.folder.at(-1)).toEqual({ kind: 'count_item', id: 'C9' });
  });

  it('fetchItemImagePath：その行の image_path だけを読む（なければ null）', async () => {
    const fake = createFakeSupabase(() => ({ data: { image_path: 'count-items/C1/a.webp' } }));
    expect(await fetchItemImagePath('count_item', 'C1', fake.client as unknown as AppSupabaseClient)).toBe('count-items/C1/a.webp');
    const call = fake.issued[0]!;
    expect(call.table).toBe('count_items');
    expect(opArgs(call, 'select')).toEqual([['image_path']]);
    expect(opArgs(call, 'eq')).toEqual([['id', 'C1']]);
    const none = createFakeSupabase(() => ({ data: null }));
    expect(await fetchItemImagePath('item', 'I1', none.client as unknown as AppSupabaseClient)).toBeNull();
    expect(none.issued[0]!.table).toBe('items');
  });
});
