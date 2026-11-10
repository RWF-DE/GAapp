// 品目の画像を送る・外す順番（04「在庫入力」の「新しく登録」・「マスタ設定」の品目のタブ。T23・D-61）：作り直す → reserve_item_image →
// upload（upsert: false。409 は届いていた）→ set_item_image → 前の物を remove。失敗した段と文言、set の失敗で上げた物を片付けること、
// 外す（set_item_image(…, null) → remove）。Supabase は偽のクライアント（rpc は lib/testing/fake-supabase、storage は下の偽物）。
import { describe, expect, it, vi } from 'vitest';
import { RPC_ARGS } from '@/lib/rpc/payloads';
import { createFakeSupabase, type FakeCall, type FakeResult } from '@/lib/testing/fake-supabase';
import type { AppSupabaseClient } from '@/lib/supabase/client';
import { ITEM_IMAGE_DECODE_MESSAGE, type ItemImageEnv } from './image';
import { attachItemImage, detachItemImage, ItemImageError, isItemImageAlreadyUploaded, removeItemImageFolder, toItemImageStorageError } from './upload';

const TARGET = '00000000-0000-4000-8000-000000000101';
const IMAGE = '00000000-0000-4000-8000-0000000000aa';
const PATH = `count-items/${TARGET}/${IMAGE}.webp`;
const OLD = `count-items/${TARGET}/00000000-0000-4000-8000-0000000000bb.webp`;

const env: ItemImageEnv = {
  decode: async () => ({ width: 2048, height: 1536, source: {} as CanvasImageSource, close: () => {} }),
  encode: async (_i, _w, _h, type) => new Blob(['img'], { type }),
};
const storageError = (statusCode: string, code: string) => ({ __isStorageError: true, name: 'StorageApiError', message: code, status: 400, statusCode, code });

function setup(
  opts: {
    rpc?: (c: FakeCall) => FakeResult | undefined;
    upload?: () => { data: unknown; error: unknown };
    remove?: () => { data: unknown[] | null; error: unknown };
    list?: (folder: string) => { data: { name: string }[] | null; error: unknown };
  } = {},
) {
  const log: string[] = [];
  const lists: string[] = [];
  const fake = createFakeSupabase((call) => {
    log.push(call.table);
    const o = opts.rpc?.(call);
    if (o) return o;
    if (call.table === 'rpc:reserve_item_image') return { data: { id: IMAGE, object_path: PATH } };
    if (call.table === 'rpc:set_item_image') return { data: OLD };
    throw new Error(call.table);
  });
  const uploads: { path: string; body: Blob; options: unknown }[] = [];
  const removes: string[][] = [];
  const bucketName = vi.fn();
  const client = {
    ...(fake.client as unknown as Record<string, unknown>),
    storage: {
      from: (b: string) => {
        bucketName(b);
        return {
          upload: async (path: string, body: Blob, options: unknown) => {
            log.push('upload');
            uploads.push({ path, body, options });
            return opts.upload?.() ?? { data: { path }, error: null };
          },
          remove: async (paths: string[]) => {
            log.push('remove');
            removes.push(paths);
            return opts.remove?.() ?? { data: paths.map((name) => ({ name })), error: null };
          },
          list: async (folder: string) => {
            log.push('list');
            lists.push(folder);
            return opts.list?.(folder) ?? { data: [], error: null };
          },
        };
      },
    },
  } as unknown as AppSupabaseClient;
  const args = (name: string) => fake.issued.filter((c) => c.table === `rpc:${name}`).map((c) => c.ops[0]?.args[0]);
  return { client, log, uploads, removes, lists, bucketName, args, issued: fake.issued };
}

describe('T23 attachItemImage（作り直す → 予約 → 上げる → 行の画像にする → 前の物を消す）', () => {
  it('順番と引数：WebP で予約し、DB が作った path へ upsert: false で上げ、前の画像を消す', async () => {
    const s = setup();
    const r = await attachItemImage('count_item', TARGET, new File(['x'], '写真.jpg', { type: 'image/jpeg' }), { client: s.client, env, newId: () => IMAGE });
    expect(s.log).toEqual(['rpc:reserve_item_image', 'upload', 'rpc:set_item_image', 'remove']);
    expect(s.args('reserve_item_image')).toEqual([{ p_kind: 'count_item', p_target_id: TARGET, p_image_id: IMAGE, p_content_type: 'image/webp' }]);
    expect(s.args('set_item_image')).toEqual([{ p_kind: 'count_item', p_target_id: TARGET, p_image_id: IMAGE }]);
    expect(s.bucketName).toHaveBeenCalledWith('item-images');
    expect(s.uploads).toHaveLength(1);
    expect(s.uploads[0]!.path).toBe(PATH);
    expect(s.uploads[0]!.options).toEqual({ contentType: 'image/webp', upsert: false });
    // 送るのは作り直した Blob（File の名前を送らない）
    expect(s.uploads[0]!.body).not.toBeInstanceOf(File);
    expect(s.uploads[0]!.body.type).toBe('image/webp');
    expect(s.removes).toEqual([[OLD]]);
    expect(r).toEqual({ path: PATH, previous: OLD, previousRemoved: true });
  });

  it('前の画像がなければ消さない。409（もう届いていた）は成功と同じ', async () => {
    const s = setup({ rpc: (c) => (c.table === 'rpc:set_item_image' ? { data: null } : undefined), upload: () => ({ data: null, error: storageError('409', 'Duplicate') }) });
    const r = await attachItemImage('item', TARGET, new Blob(['x']), { client: s.client, env, newId: () => IMAGE });
    expect(s.log).toEqual(['rpc:reserve_item_image', 'upload', 'rpc:set_item_image']);
    expect(r.previous).toBeNull();
    expect(r.previousRemoved).toBe(true);
  });

  it('前の物を消せなくても成功（使われていない物として残るだけ）', async () => {
    const s = setup({ remove: () => ({ data: null, error: storageError('403', 'AccessDenied') }) });
    const r = await attachItemImage('count_item', TARGET, new Blob(['x']), { client: s.client, env, newId: () => IMAGE });
    expect(r.previousRemoved).toBe(false);
  });

  it('作り直せなければ予約しない（step: prepare。文言は写真を読めない）', async () => {
    const s = setup();
    const broken: ItemImageEnv = { decode: async () => Promise.reject(new Error('x')), encode: async () => null };
    const e = await attachItemImage('count_item', TARGET, new Blob(['x']), { client: s.client, env: broken }).catch((x: unknown) => x);
    expect(e).toBeInstanceOf(ItemImageError);
    expect((e as ItemImageError).step).toBe('prepare');
    expect((e as ItemImageError).message).toBe(ITEM_IMAGE_DECODE_MESSAGE);
    expect(s.log).toEqual([]);
  });

  it('予約の invalid_state（storage_full）と not_found は品目の画像の文言で、上げない（too_many_reservations は下の「レビューで直したこと」）', async () => {
    for (const [details, message] of [
      [{ reason: 'storage_full' }, '画像の置き場がいっぱいです（上限 100 MB）。管理者に知らせてください'],
    ] as const) {
      const s = setup({
        rpc: (c) => (c.table === 'rpc:reserve_item_image' ? { error: { code: 'P0001', message: 'invalid_state', details: JSON.stringify(details) } } : undefined),
      });
      const e = (await attachItemImage('count_item', TARGET, new Blob(['x']), { client: s.client, env }).catch((x: unknown) => x)) as ItemImageError;
      expect(e.step).toBe('reserve');
      expect(e.message).toBe(message);
      expect(s.log).toEqual(['rpc:reserve_item_image']);
    }
    const s = setup({ rpc: (c) => (c.table === 'rpc:reserve_item_image' ? { error: { code: 'P0001', message: 'not_found', details: null } } : undefined) });
    const e = (await attachItemImage('count_item', TARGET, new Blob(['x']), { client: s.client, env }).catch((x: unknown) => x)) as ItemImageError;
    expect(e.message).toBe('この物は見つかりません（ほかの人が削除した可能性があります）。読み直しました');
  });

  it('上げるのが拒まれたら（403・413・415）行の画像にしない', async () => {
    for (const [code, name, message] of [
      ['403', 'AccessDenied', '写真を送れませんでした。立場が変わったか、予約の期限（1 時間）が切れた可能性があります。もう一度送ってください'],
      ['413', 'EntityTooLarge', '写真は1枚 1 MB までです'],
      ['415', 'InvalidMimeType', 'WebP か JPEG の写真にしてください'],
    ] as const) {
      const s = setup({ upload: () => ({ data: null, error: storageError(code, name) }) });
      const e = (await attachItemImage('item', TARGET, new Blob(['x']), { client: s.client, env }).catch((x: unknown) => x)) as ItemImageError;
      expect(e.step).toBe('upload');
      expect(e.message).toBe(message);
      expect(s.log).toEqual(['rpc:reserve_item_image', 'upload']);
    }
  });

  it('行の画像にできなければ（not_uploaded など）、上げた自分の物を消す', async () => {
    const s = setup({
      rpc: (c) =>
        c.table === 'rpc:set_item_image' ? { error: { code: 'P0001', message: 'invalid_state', details: JSON.stringify({ reason: 'not_uploaded' }) } } : undefined,
    });
    const e = (await attachItemImage('count_item', TARGET, new Blob(['x']), { client: s.client, env, newId: () => IMAGE }).catch((x: unknown) => x)) as ItemImageError;
    expect(e.step).toBe('set');
    expect(e.message).toBe('写真が届いていませんでした。もう一度送ってください');
    expect(s.removes).toEqual([[PATH]]);
  });
});

describe('T23 レビューで直したこと（送り直しの id・上限の片付け・削除した備品のフォルダ）', () => {
  it('deps.imageId を渡すと、その id で予約し直す（ダイアログの送り直し。newId は呼ばない）', async () => {
    const s = setup();
    const newId = vi.fn(() => 'x');
    await attachItemImage('count_item', TARGET, new Blob(['x']), { client: s.client, env, imageId: IMAGE, newId });
    expect(newId).not.toHaveBeenCalled();
    expect(s.args('reserve_item_image')[0]).toMatchObject({ p_image_id: IMAGE });
    expect(s.args('set_item_image')[0]).toMatchObject({ p_image_id: IMAGE });
  });

  it('too_many_reservations なら、自分の期限の切れた使っていない予約の物を消してから1回だけ予約し直す', async () => {
    let reserves = 0;
    const STALE = `count-items/${TARGET}/00000000-0000-4000-8000-0000000000cc.webp`;
    const s = setup({
      rpc: (c) => {
        if (c.table === 'rpc:reserve_item_image') {
          reserves += 1;
          if (reserves === 1) return { error: { code: 'P0001', message: 'invalid_state', details: JSON.stringify({ reason: 'too_many_reservations' }) } };
          return undefined;
        }
        if (c.table === 'item_image_uploads') return { data: [{ object_path: STALE }] };
        return undefined;
      },
    });
    await attachItemImage('count_item', TARGET, new Blob(['x']), { client: s.client, env, newId: () => IMAGE });
    expect(s.log).toEqual(['rpc:reserve_item_image', 'item_image_uploads', 'remove', 'rpc:reserve_item_image', 'upload', 'rpc:set_item_image', 'remove']);
    const read = s.issued.find((c) => c.table === 'item_image_uploads')!;
    expect(read.ops.map((o) => o.op)).toEqual(expect.arrayContaining(['select', 'is', 'lt']));
    expect(read.ops.find((o) => o.op === 'is')!.args).toEqual(['used_at', null]);
    expect(s.removes[0]).toEqual([STALE]);
  });

  it('片付けても上限なら、片付けは1回だけで too_many_reservations の文言', async () => {
    const s = setup({
      rpc: (c) => {
        if (c.table === 'rpc:reserve_item_image') return { error: { code: 'P0001', message: 'invalid_state', details: JSON.stringify({ reason: 'too_many_reservations' }) } };
        if (c.table === 'item_image_uploads') return { data: [] };
        return undefined;
      },
    });
    const e = (await attachItemImage('count_item', TARGET, new Blob(['x']), { client: s.client, env }).catch((x: unknown) => x)) as ItemImageError;
    expect(e.step).toBe('reserve');
    expect(e.message).toBe('送っている途中の写真が多すぎます（1人 10 枚まで）。1 時間ほど待ってから、もう一度送ってください');
    expect(s.log).toEqual(['rpc:reserve_item_image', 'item_image_uploads', 'rpc:reserve_item_image']);
  });

  it('R1：set の応答が切れた後の送り直し（予約が使用済み）は、上げずに set を呼び、返った前の物を消す', async () => {
    const s = setup({
      rpc: (c) =>
        c.table === 'rpc:reserve_item_image' ? { data: { id: IMAGE, object_path: PATH, used_at: '2026-11-10T01:00:00Z', expires_at: '2026-11-10T02:00:00Z' } } : undefined,
    });
    const r = await attachItemImage('count_item', TARGET, new Blob(['x']), { client: s.client, env, imageId: IMAGE });
    expect(s.log).toEqual(['rpc:reserve_item_image', 'rpc:set_item_image', 'remove']);
    expect(s.removes).toEqual([[OLD]]);
    expect(r).toMatchObject({ path: PATH, previous: OLD, previousRemoved: true });
  });

  it('R1：使用済みの予約で行の画像がもう別の物なら set が used で失敗し、その物は消さない', async () => {
    const s = setup({
      rpc: (c) => {
        if (c.table === 'rpc:reserve_item_image') return { data: { id: IMAGE, object_path: PATH, used_at: '2026-11-10T01:00:00Z' } };
        if (c.table === 'rpc:set_item_image') return { error: { code: 'P0001', message: 'invalid_state', details: JSON.stringify({ reason: 'used' }) } };
        return undefined;
      },
    });
    const e = (await attachItemImage('count_item', TARGET, new Blob(['x']), { client: s.client, env, imageId: IMAGE }).catch((x: unknown) => x)) as ItemImageError;
    expect(e.step).toBe('set');
    expect(s.uploads).toHaveLength(0);
    expect(s.removes).toHaveLength(0);
  });

  it('S2：too_many_orphans なら、そのフォルダの行の画像以外を消してから1回だけ予約し直す', async () => {
    let reserves = 0;
    const CURRENT = `count-items/${TARGET}/00000000-0000-4000-8000-0000000000dd.webp`;
    const A = '00000000-0000-4000-8000-0000000000e1.webp';
    const B = '00000000-0000-4000-8000-0000000000e2.webp';
    const s = setup({
      rpc: (c) => {
        if (c.table === 'rpc:reserve_item_image') {
          reserves += 1;
          if (reserves === 1) return { error: { code: 'P0001', message: 'invalid_state', details: JSON.stringify({ reason: 'too_many_orphans' }) } };
          return undefined;
        }
        if (c.table === 'count_items') return { data: { image_path: CURRENT } };
        if (c.table === 'item_image_uploads') return { data: [] };
        return undefined;
      },
      list: () => ({ data: [{ name: CURRENT.split('/')[2]! }, { name: A }, { name: B }], error: null }),
    });
    await attachItemImage('count_item', TARGET, new Blob(['x']), { client: s.client, env, newId: () => IMAGE });
    expect(s.lists).toEqual([`count-items/${TARGET}`]);
    expect(s.removes[0]).toEqual([`count-items/${TARGET}/${A}`, `count-items/${TARGET}/${B}`]);
    expect(reserves).toBe(2);
  });

  it('R2：期限が切れていて物は届いている予約は、upload が 403 でも set を試して成功する', async () => {
    const s = setup({
      rpc: (c) =>
        c.table === 'rpc:reserve_item_image' ? { data: { id: IMAGE, object_path: PATH, used_at: null, expires_at: '2000-01-01T00:00:00Z' } } : undefined,
      upload: () => ({ data: null, error: storageError('403', 'AccessDenied') }),
    });
    const r = await attachItemImage('count_item', TARGET, new Blob(['x']), { client: s.client, env, imageId: IMAGE });
    expect(s.log).toEqual(['rpc:reserve_item_image', 'upload', 'rpc:set_item_image', 'remove']);
    expect(r.path).toBe(PATH);
  });

  it('R2：期限切れで upload が 403、set も失敗したら、upload の拒否の文言を出す（自分の物を消さない）', async () => {
    const s = setup({
      rpc: (c) => {
        if (c.table === 'rpc:reserve_item_image') return { data: { id: IMAGE, object_path: PATH, used_at: null, expires_at: '2000-01-01T00:00:00Z' } };
        if (c.table === 'rpc:set_item_image') return { error: { code: 'P0001', message: 'invalid_state', details: JSON.stringify({ reason: 'not_uploaded' }) } };
        return undefined;
      },
      upload: () => ({ data: null, error: storageError('403', 'AccessDenied') }),
    });
    const e = (await attachItemImage('count_item', TARGET, new Blob(['x']), { client: s.client, env, imageId: IMAGE }).catch((x: unknown) => x)) as ItemImageError;
    expect(e.step).toBe('upload');
    expect(s.removes).toHaveLength(0);
  });

  it('R2：期限が切れていない予約の upload の 403 は、set を試さずそのまま失敗する', async () => {
    const s = setup({
      rpc: (c) =>
        c.table === 'rpc:reserve_item_image' ? { data: { id: IMAGE, object_path: PATH, used_at: null, expires_at: '2999-01-01T00:00:00Z' } } : undefined,
      upload: () => ({ data: null, error: storageError('403', 'AccessDenied') }),
    });
    const e = (await attachItemImage('count_item', TARGET, new Blob(['x']), { client: s.client, env, imageId: IMAGE }).catch((x: unknown) => x)) as ItemImageError;
    expect(e.step).toBe('upload');
    expect(s.log).toEqual(['rpc:reserve_item_image', 'upload']);
  });

  it('removeItemImageFolder：消した行のフォルダの物を一覧して remove する（失敗しても投げない）', async () => {
    const s = setup({ list: () => ({ data: [{ name: 'a.webp' }, { name: 'b.jpg' }], error: null }) });
    expect(await removeItemImageFolder('count_item', TARGET, { client: s.client })).toBe(true);
    expect(s.lists).toEqual([`count-items/${TARGET}`]);
    expect(s.removes).toEqual([[`count-items/${TARGET}/a.webp`, `count-items/${TARGET}/b.jpg`]]);
    const empty = setup();
    expect(await removeItemImageFolder('item', TARGET, { client: empty.client })).toBe(true);
    expect(empty.lists).toEqual([`items/${TARGET}`]);
    expect(empty.removes).toEqual([]);
    const broken = setup({ list: () => ({ data: null, error: new Error('x') }) });
    expect(await removeItemImageFolder('count_item', TARGET, { client: broken.client })).toBe(false);
  });
});

describe('T23 detachItemImage（set_item_image(…, null) → 前の物を消す）', () => {
  it('前の物を消して、その path を返す。前がなければ消さない', async () => {
    const s = setup();
    expect(await detachItemImage('item', TARGET, { client: s.client })).toBe(OLD);
    expect(s.args('set_item_image')).toEqual([{ p_kind: 'item', p_target_id: TARGET, p_image_id: null }]);
    expect(s.removes).toEqual([[OLD]]);
    const none = setup({ rpc: (c) => (c.table === 'rpc:set_item_image' ? { data: null } : undefined) });
    expect(await detachItemImage('item', TARGET, { client: none.client })).toBeNull();
    expect(none.removes).toEqual([]);
  });

  it('forbidden は今の文言（立場が変わった）', async () => {
    const s = setup({ rpc: () => ({ error: { code: 'P0001', message: 'forbidden', details: null } }) });
    const e = (await detachItemImage('item', TARGET, { client: s.client }).catch((x: unknown) => x)) as ItemImageError;
    expect(e.step).toBe('set');
    expect(e.message).toBe('権限がありません。立場が変わった可能性があります');
  });
});

describe('T23 Storage のエラーと RPC の引数', () => {
  it('409・KeyAlreadyExists・Duplicate は届いていた。通信の失敗は network', () => {
    expect(isItemImageAlreadyUploaded(storageError('409', 'x'))).toBe(true);
    expect(isItemImageAlreadyUploaded(storageError('400', 'KeyAlreadyExists'))).toBe(true);
    expect(isItemImageAlreadyUploaded(storageError('403', 'AccessDenied'))).toBe(false);
    expect(isItemImageAlreadyUploaded(new Error('x'))).toBe(false);
    const net = toItemImageStorageError({ __isStorageError: true, name: 'StorageUnknownError', originalError: new TypeError('Failed to fetch') });
    expect(net.info.kind).toBe('network');
    expect(toItemImageStorageError(storageError('500', 'InternalError')).info.reason).toBe('item_image_failed');
  });

  it('reserve_item_image・set_item_image の引数（kind・uuid・形。set の image_id は null で外す）', () => {
    const ok = { p_kind: 'item', p_target_id: TARGET, p_image_id: IMAGE, p_content_type: 'image/jpeg' };
    expect(RPC_ARGS.reserve_item_image.safeParse(ok).success).toBe(true);
    expect(RPC_ARGS.reserve_item_image.safeParse({ ...ok, p_content_type: 'image/png' }).success).toBe(false);
    expect(RPC_ARGS.reserve_item_image.safeParse({ ...ok, p_kind: 'room' }).success).toBe(false);
    expect(RPC_ARGS.reserve_item_image.safeParse({ ...ok, p_image_id: 'x' }).success).toBe(false);
    expect(RPC_ARGS.set_item_image.safeParse({ p_kind: 'count_item', p_target_id: TARGET, p_image_id: null }).success).toBe(true);
    expect(RPC_ARGS.set_item_image.safeParse({ p_kind: 'count_item', p_target_id: TARGET }).success).toBe(false);
  });
});
