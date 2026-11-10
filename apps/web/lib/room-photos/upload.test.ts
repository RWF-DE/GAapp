// 現状復帰の写真を送る・直す・消す（04「現状復帰の写真」。T25・D-63）：作り直す（長い辺 1600px）→ reserve_room_photo → upload
// （bucket room-photos・upsert: false。409 は届いていた）→ add_room_photo。送り直し（同じ id・使用済みの予約・期限切れ）、上限の片付け
// （too_many_reservations・too_many_orphans）、失敗の文言、消す（delete_room_photo → remove。送り直しの not_found）。
import { describe, expect, it, vi } from 'vitest';
import { RPC_ARGS } from '@/lib/rpc/payloads';
import { createFakeSupabase, type FakeCall, type FakeResult } from '@/lib/testing/fake-supabase';
import type { AppSupabaseClient } from '@/lib/supabase/client';
import { ITEM_IMAGE_TOO_LARGE_MESSAGE, type ItemImageEnv } from '@/lib/item-images/image';
import { addRoomPhoto, deleteRoomPhoto, RoomPhotoError, roomPhotoFolder, updateRoomPhoto } from './upload';

const YEAR = '00000000-0000-4000-8000-000000000001';
const ROOM = '00000000-0000-4000-8000-000000000101';
const PHOTO = '00000000-0000-4000-8000-0000000000aa';
const PATH = `${YEAR}/${ROOM}/${PHOTO}.webp`;
const ROW = { id: PHOTO, year_id: YEAR, room_id: ROOM, object_path: PATH, memo: '黒板', sort_order: 0, created_at: 'x', created_by: null, updated_at: 'x' };
const FUTURE = '2999-01-01T00:00:00Z';
const PAST = '2000-01-01T00:00:00Z';

function envOf(width = 4032, height = 3024) {
  const sizes: { w: number; h: number }[] = [];
  const env: ItemImageEnv = {
    decode: async () => ({ width, height, source: {} as CanvasImageSource, close: () => {} }),
    encode: async (_i, w, h, type) => {
      sizes.push({ w, h });
      return new Blob(['img'], { type });
    },
  };
  return { env, sizes };
}
const storageError = (statusCode: string, code: string) => ({ __isStorageError: true, name: 'StorageApiError', message: code, status: 400, statusCode, code });
const p0001 = (message: string, details: unknown): FakeResult => ({ error: { code: 'P0001', message, details: JSON.stringify(details) } });

function setup(
  opts: {
    rpc?: (c: FakeCall) => FakeResult | undefined;
    upload?: () => { data: unknown; error: unknown };
    list?: (folder: string) => { data: { name: string }[] | null; error: unknown };
  } = {},
) {
  const log: string[] = [];
  const fake = createFakeSupabase((call) => {
    log.push(call.table);
    const o = opts.rpc?.(call);
    if (o) return o;
    if (call.table === 'rpc:reserve_room_photo') return { data: { id: PHOTO, object_path: PATH, used_at: null, expires_at: FUTURE } };
    // add は送ったメモの行を返す（新しい予約の add。0024。使用済みの予約で前の行が返る場合は、テストが rpc で差し替える）
    if (call.table === 'rpc:add_room_photo') return { data: { ...ROW, memo: (call.ops[0]?.args[0] as { p_memo: string }).p_memo } };
    if (call.table === 'rpc:update_room_photo') return { data: ROW };
    if (call.table === 'rpc:delete_room_photo') return { data: PATH };
    if (call.table === 'room_photo_uploads') return { data: [] };
    if (call.table === 'room_photos') return { data: [] };
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
            return { data: paths.map((name) => ({ name })), error: null };
          },
          list: async (folder: string) => {
            log.push('list');
            return opts.list?.(folder) ?? { data: [], error: null };
          },
        };
      },
    },
  } as unknown as AppSupabaseClient;
  const args = (name: string) => fake.issued.filter((c) => c.table === `rpc:${name}`).map((c) => c.ops[0]?.args[0]);
  return { client, log, uploads, removes, bucketName, args };
}

describe('T25 addRoomPhoto（作り直す → 予約 → 上げる → 写真の行にする）', () => {
  it('長い辺 1600px の WebP で予約し、DB が作った path へ bucket room-photos・upsert: false で上げ、メモを付けて足す', async () => {
    const s = setup();
    const { env, sizes } = envOf();
    const r = await addRoomPhoto(YEAR, ROOM, new File(['x'], '名前.jpg', { type: 'image/jpeg' }), '  黒板  ', { client: s.client, env, photoId: PHOTO });
    expect(sizes[0]).toEqual({ w: 1600, h: 1200 });
    expect(s.log).toEqual(['rpc:reserve_room_photo', 'upload', 'rpc:add_room_photo']);
    expect(s.args('reserve_room_photo')).toEqual([{ p_year_id: YEAR, p_room_id: ROOM, p_photo_id: PHOTO, p_content_type: 'image/webp' }]);
    // メモは前後の空白を除いて送る
    expect(s.args('add_room_photo')).toEqual([{ p_photo_id: PHOTO, p_memo: '黒板' }]);
    expect(s.bucketName).toHaveBeenCalledWith('room-photos');
    expect(s.bucketName).not.toHaveBeenCalledWith('item-images');
    expect(s.uploads[0]!.path).toBe(PATH);
    expect(s.uploads[0]!.options).toEqual({ contentType: 'image/webp', upsert: false });
    expect(s.uploads[0]!.body).not.toBeInstanceOf(File);
    expect(r).toEqual(ROW);
  });

  it('409（もう届いていた）は成功と同じ。予約が使用済み（送り直し）なら上げずに add だけ', async () => {
    const dup = setup({ upload: () => ({ data: null, error: storageError('409', 'Duplicate') }) });
    await addRoomPhoto(YEAR, ROOM, new Blob(['x']), '', { client: dup.client, env: envOf().env, photoId: PHOTO });
    expect(dup.log).toEqual(['rpc:reserve_room_photo', 'upload', 'rpc:add_room_photo']);
    const used = setup({
      rpc: (c) => (c.table === 'rpc:reserve_room_photo' ? { data: { id: PHOTO, object_path: PATH, used_at: '2026-11-10T00:00:00Z', expires_at: FUTURE } } : undefined),
    });
    await addRoomPhoto(YEAR, ROOM, new Blob(['x']), '黒板', { client: used.client, env: envOf().env, photoId: PHOTO });
    expect(used.log).toEqual(['rpc:reserve_room_photo', 'rpc:add_room_photo']);
  });

  it('送り直しの間にメモを直した（使用済みの予約で add が前のメモの行を返す）：update_room_photo で今のメモにする（T25 のレビュー）', async () => {
    // 使用済みの予約：add は前の送信の行（メモ「黒板」）を返し、メモは変えない（0024）
    const usedReserve = (c: FakeCall): FakeResult | undefined =>
      c.table === 'rpc:reserve_room_photo'
        ? { data: { id: PHOTO, object_path: PATH, used_at: '2026-11-10T00:00:00Z', expires_at: FUTURE } }
        : c.table === 'rpc:add_room_photo'
          ? { data: ROW }
          : undefined;
    const s = setup({
      rpc: (c) => usedReserve(c) ?? (c.table === 'rpc:update_room_photo' ? { data: { ...ROW, memo: '机は後ろ' } } : undefined),
    });
    const r = await addRoomPhoto(YEAR, ROOM, new Blob(['x']), ' 机は後ろ ', { client: s.client, env: envOf().env, photoId: PHOTO });
    expect(s.log).toEqual(['rpc:reserve_room_photo', 'rpc:add_room_photo', 'rpc:update_room_photo']);
    expect(s.args('update_room_photo')).toEqual([{ p_photo_id: PHOTO, p_memo: '机は後ろ', p_sort_order: null }]);
    expect(r.memo).toBe('机は後ろ');
    // メモを消した（空）ときも空にする
    const cleared = setup({ rpc: (c) => usedReserve(c) ?? (c.table === 'rpc:update_room_photo' ? { data: { ...ROW, memo: '' } } : undefined) });
    expect((await addRoomPhoto(YEAR, ROOM, new Blob(['x']), '', { client: cleared.client, env: envOf().env, photoId: PHOTO })).memo).toBe('');
    expect(cleared.args('update_room_photo')).toEqual([{ p_photo_id: PHOTO, p_memo: '', p_sort_order: null }]);
    // メモを直せなかった：写真は足してあるので、直せなかった文言（送り直せば同じ id でメモだけ直す）
    const ng = setup({ rpc: (c) => usedReserve(c) ?? (c.table === 'rpc:update_room_photo' ? { error: { message: 'Failed to fetch' } } : undefined) });
    const e = (await addRoomPhoto(YEAR, ROOM, new Blob(['x']), '机は後ろ', { client: ng.client, env: envOf().env, photoId: PHOTO }).catch((x: unknown) => x)) as RoomPhotoError;
    expect(e).toBeInstanceOf(RoomPhotoError);
    expect(e.step).toBe('update');
    expect(ng.removes).toEqual([]);
  });

  it('期限の切れた予約に物が先に届いていた（upload が 403）：add を試す。add も失敗なら upload の文言', async () => {
    const reserveExpired = (c: FakeCall) =>
      c.table === 'rpc:reserve_room_photo' ? { data: { id: PHOTO, object_path: PATH, used_at: null, expires_at: PAST } } : undefined;
    const ok = setup({ rpc: reserveExpired, upload: () => ({ data: null, error: storageError('403', 'AccessDenied') }) });
    expect(await addRoomPhoto(YEAR, ROOM, new Blob(['x']), '', { client: ok.client, env: envOf().env, photoId: PHOTO })).toEqual({ ...ROW, memo: '' });
    expect(ok.log).toEqual(['rpc:reserve_room_photo', 'upload', 'rpc:add_room_photo']);
    const ng = setup({
      rpc: (c) => reserveExpired(c) ?? (c.table === 'rpc:add_room_photo' ? p0001('invalid_state', { reason: 'not_uploaded' }) : undefined),
      upload: () => ({ data: null, error: storageError('403', 'AccessDenied') }),
    });
    const e = (await addRoomPhoto(YEAR, ROOM, new Blob(['x']), '', { client: ng.client, env: envOf().env, photoId: PHOTO }).catch((x: unknown) => x)) as RoomPhotoError;
    expect(e.step).toBe('upload');
    expect(e.message).toContain('写真を送れませんでした');
  });

  it('too_many_reservations：自分の期限の切れた予約の物を消してから1回だけ予約し直す', async () => {
    let n = 0;
    const s = setup({
      rpc: (c) => {
        if (c.table === 'rpc:reserve_room_photo' && n++ === 0) return p0001('invalid_state', { reason: 'too_many_reservations' });
        if (c.table === 'room_photo_uploads') return { data: [{ object_path: `${YEAR}/${ROOM}/old.webp` }] };
        return undefined;
      },
    });
    await addRoomPhoto(YEAR, ROOM, new Blob(['x']), '', { client: s.client, env: envOf().env, photoId: PHOTO });
    expect(s.log).toEqual(['rpc:reserve_room_photo', 'room_photo_uploads', 'remove', 'rpc:reserve_room_photo', 'upload', 'rpc:add_room_photo']);
    expect(s.removes[0]).toEqual([`${YEAR}/${ROOM}/old.webp`]);
  });

  it('too_many_orphans：その年度・部屋のフォルダの、写真の行でも自分の生きた予約でもない物だけを消してから1回だけ予約し直す。まだなら文言', async () => {
    const folder = roomPhotoFolder(YEAR, ROOM);
    const s = setup({
      rpc: (c) => {
        if (c.table === 'rpc:reserve_room_photo') return p0001('invalid_state', { reason: 'too_many_orphans' });
        if (c.table === 'room_photos') return { data: [{ object_path: `${folder}/keep.webp` }] };
        if (c.table === 'room_photo_uploads') return { data: [{ object_path: `${folder}/mine.webp` }] };
        return undefined;
      },
      list: () => ({ data: [{ name: 'keep.webp' }, { name: 'mine.webp' }, { name: 'orphan.webp' }], error: null }),
    });
    const e = (await addRoomPhoto(YEAR, ROOM, new Blob(['x']), '', { client: s.client, env: envOf().env, photoId: PHOTO }).catch((x: unknown) => x)) as RoomPhotoError;
    expect(s.removes).toEqual([[`${folder}/orphan.webp`]]);
    expect(s.args('reserve_room_photo')).toHaveLength(2);
    expect(e.step).toBe('reserve');
    expect(e.message).toBe('送れませんでした。しばらくしてからもう一度送ってください');
  });

  it('予約の失敗の文言（6 枚・置き場・終了した年度・権限）。上げない', async () => {
    for (const [r, message] of [
      [p0001('invalid_state', { reason: 'too_many_photos' }), 'この部屋の写真は 6 枚までです。足すときは先に消してください'],
      [p0001('invalid_state', { reason: 'storage_full' }), '写真の置き場がいっぱいです。管理者に相談してください'],
      [p0001('invalid_state', { status: 'closed' }), '終了した年度のため、写真は見るだけです'],
      [p0001('forbidden', null), '写真を足す権限がありません'],
    ] as const) {
      const s = setup({ rpc: (c) => (c.table === 'rpc:reserve_room_photo' ? r : undefined) });
      const e = (await addRoomPhoto(YEAR, ROOM, new Blob(['x']), '', { client: s.client, env: envOf().env, photoId: PHOTO }).catch((x: unknown) => x)) as RoomPhotoError;
      expect(e.message).toBe(message);
      expect(s.uploads).toEqual([]);
    }
  });

  it('add の失敗：上げた自分の物を片付け、文言（used・not_uploaded・memo）', async () => {
    for (const [r, message] of [
      [p0001('invalid_state', { reason: 'used' }), 'この写真はもう消されています。写真を選び直してください'],
      [p0001('invalid_state', { reason: 'not_uploaded' }), '写真がまだ届いていません。もう一度「送る」を押してください'],
      [p0001('invalid_input', { field: 'memo' }), 'メモは 50 字までです'],
    ] as const) {
      const s = setup({ rpc: (c) => (c.table === 'rpc:add_room_photo' ? r : undefined) });
      const e = (await addRoomPhoto(YEAR, ROOM, new Blob(['x']), '', { client: s.client, env: envOf().env, photoId: PHOTO }).catch((x: unknown) => x)) as RoomPhotoError;
      expect(e.step).toBe('add');
      expect(e.message).toBe(message);
      expect(s.removes).toEqual([[PATH]]);
    }
  });

  it('作り直して 1 MiB を超えれば「写真が大きすぎます」（予約しない）', async () => {
    const s = setup();
    const big: ItemImageEnv = {
      decode: async () => ({ width: 100, height: 100, source: {} as CanvasImageSource, close: () => {} }),
      encode: async (_i, _w, _h, type) => new Blob([new Uint8Array(1_048_577)], { type }),
    };
    const e = (await addRoomPhoto(YEAR, ROOM, new Blob(['x']), '', { client: s.client, env: big }).catch((x: unknown) => x)) as RoomPhotoError;
    expect(e.step).toBe('prepare');
    expect(e.message).toBe(ITEM_IMAGE_TOO_LARGE_MESSAGE);
    expect(s.log).toEqual([]);
  });

  it('51 字のメモ・改行のあるメモは送る前に止める（RPC の引数の確かめ）', () => {
    expect(RPC_ARGS.add_room_photo.safeParse({ p_photo_id: PHOTO, p_memo: 'あ'.repeat(50) }).success).toBe(true);
    expect(RPC_ARGS.add_room_photo.safeParse({ p_photo_id: PHOTO, p_memo: 'あ'.repeat(51) }).success).toBe(false);
    expect(RPC_ARGS.add_room_photo.safeParse({ p_photo_id: PHOTO, p_memo: '一行目\n二行目' }).success).toBe(false);
    expect(RPC_ARGS.update_room_photo.safeParse({ p_photo_id: PHOTO, p_memo: null, p_sort_order: 1001 }).success).toBe(false);
    expect(RPC_ARGS.room_photos_with_previous.safeParse({ p_year_id: YEAR, p_room_id: null }).success).toBe(true);
  });
});

describe('T25 updateRoomPhoto・deleteRoomPhoto', () => {
  it('メモだけ・並びだけを変える（ほかは null で送る）。not_found は「ほかの人が消しました」', async () => {
    const s = setup();
    await updateRoomPhoto(PHOTO, { memo: '机は後ろ' }, { client: s.client });
    await updateRoomPhoto(PHOTO, { sortOrder: 3 }, { client: s.client });
    expect(s.args('update_room_photo')).toEqual([
      { p_photo_id: PHOTO, p_memo: '机は後ろ', p_sort_order: null },
      { p_photo_id: PHOTO, p_memo: null, p_sort_order: 3 },
    ]);
    const gone = setup({ rpc: (c) => (c.table === 'rpc:update_room_photo' ? p0001('not_found', null) : undefined) });
    const e = (await updateRoomPhoto(PHOTO, { memo: 'x' }, { client: gone.client }).catch((x: unknown) => x)) as RoomPhotoError;
    expect(e.message).toBe('ほかの人が消しました');
  });

  it('消す：delete_room_photo の返した path を remove する。remove の失敗は知らせない', async () => {
    const s = setup();
    await deleteRoomPhoto(PHOTO, PATH, { client: s.client });
    expect(s.log).toEqual(['rpc:delete_room_photo', 'remove']);
    expect(s.removes).toEqual([[PATH]]);
  });

  it('送り直しの not_found：消えていたものとして、読んでいた path を remove する。送り直しでなければ失敗', async () => {
    const r = (c: FakeCall) => (c.table === 'rpc:delete_room_photo' ? p0001('not_found', null) : undefined);
    const resend = setup({ rpc: r });
    await deleteRoomPhoto(PHOTO, PATH, { client: resend.client, resend: true });
    expect(resend.removes).toEqual([[PATH]]);
    const first = setup({ rpc: r });
    const e = (await deleteRoomPhoto(PHOTO, PATH, { client: first.client }).catch((x: unknown) => x)) as RoomPhotoError;
    expect(e).toBeInstanceOf(RoomPhotoError);
    expect(e.message).toBe('ほかの人が消しました');
    expect(first.removes).toEqual([]);
  });
});
