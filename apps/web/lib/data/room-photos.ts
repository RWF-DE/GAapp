// 現状復帰の写真の読み取りと書き込みの入口（04「現状復帰の写真」。T25・D-63）。
// - 読む：場所（rooms。id・名前・別名・種類・建物・階・sort_order）と、room_photos_with_previous(year_id, room_id)（部屋を開いたときは
//   その部屋、一覧では null で全部の場所。数えるだけ）。キーは年度の下（`['year', yearId, 'room-photos', roomId | 'all']`）。
// - 署名つき URL は品目の画像と同じ useItemImageUrls（bucket room-photos。有効 10 分。メモリーにだけ持つ）。
// - 書き込み（予約・上げる・足す・直す・消す）は lib/room-photos/upload.ts を押したときに動的 import で読む。
// このファイルは /room-photos だけが読む。ダッシュボード（/）・在庫入力・振り分けの画面からは読まない（リンクだけ。D-51・D-52）。
import { queryOptions, type QueryClient } from '@tanstack/react-query';
import { toAppError } from '@/lib/errors';
import { callRpc } from '@/lib/rpc';
import { queryKeys } from '@/lib/query';
import { getSupabase, type AppSupabaseClient } from '@/lib/supabase/client';
import type { RoomRow } from '@/lib/db/types';
import { ROOM_PHOTO_SORT_MAX } from '@/lib/schemas/room-photos';
import type { RoomPhotoRow } from '@/lib/room-photos/upload';

export type { RoomPhotoRow };

/** Storage の bucket（0024。lib/room-photos/upload.ts の ROOM_PHOTOS_BUCKET と同じ。こちらは画面の最初の JS に入る） */
export const ROOM_PHOTOS_BUCKET_ID = 'room-photos';

/** 写真の画面で使う場所の列 */
export type PhotoRoom = Pick<RoomRow, 'id' | 'name' | 'aliases' | 'kind' | 'building' | 'floor' | 'sort_order'>;

export { roomPhotosPath } from '@/lib/room-photos/path';

export const roomPhotoKeys = {
  rooms: () => ['room-photos', 'rooms'] as const,
  /** 年度の写真（roomId が null なら全部の場所） */
  photos: (yearId: string, roomId: string | null) => queryKeys.yearPart(yearId, 'room-photos', roomId ?? 'all'),
  /** その年度の写真のキーすべて（書いた後に読み直す） */
  year: (yearId: string) => queryKeys.yearPart(yearId, 'room-photos'),
};

/** 場所（並びは sort_order → 名前 → id） */
export async function fetchPhotoRooms(client: AppSupabaseClient = getSupabase()): Promise<PhotoRoom[]> {
  const res = await client.from('rooms').select('id, name, aliases, kind, building, floor, sort_order').order('sort_order').order('name').order('id');
  if (res.error) throw toAppError(res.error, res.status);
  return sortRooms((res.data ?? []) as PhotoRoom[]);
}

const cmp = (a: string, b: string) => (a < b ? -1 : a > b ? 1 : 0);

/** 場所の並び（sort_order → 名前 → id。04） */
export function sortRooms<T extends Pick<PhotoRoom, 'sort_order' | 'name' | 'id'>>(rooms: readonly T[]): T[] {
  return [...rooms].sort((a, b) => a.sort_order - b.sort_order || a.name.localeCompare(b.name, 'ja') || cmp(a.id, b.id));
}

/** その年度と前の年度の写真（room_photos_with_previous。見られない人には 0 行） */
export async function fetchRoomPhotos(yearId: string, roomId: string | null, client: AppSupabaseClient = getSupabase()): Promise<RoomPhotoRow[]> {
  return ((await callRpc('room_photos_with_previous', { p_year_id: yearId, p_room_id: roomId }, client)) ?? []) as RoomPhotoRow[];
}

export function photoRoomsOptions() {
  return queryOptions({ queryKey: roomPhotoKeys.rooms(), queryFn: () => fetchPhotoRooms(), staleTime: 5 * 60_000 });
}

export function roomPhotosOptions(yearId: string, roomId: string | null) {
  return queryOptions({ queryKey: roomPhotoKeys.photos(yearId, roomId), queryFn: () => fetchRoomPhotos(yearId, roomId) });
}

/** 写真の並び（sort_order → created_at → id。04） */
export function sortPhotos<T extends Pick<RoomPhotoRow, 'sort_order' | 'created_at' | 'id'>>(rows: readonly T[]): T[] {
  return [...rows].sort((a, b) => a.sort_order - b.sort_order || cmp(a.created_at, b.created_at) || cmp(a.id, b.id));
}

/** 今年と前の年度の写真に分ける（どちらも並び順。前の年度がなければ previous は空） */
export function splitRoomPhotos(rows: readonly RoomPhotoRow[], yearId: string, prevYearId: string | null): { current: RoomPhotoRow[]; previous: RoomPhotoRow[] } {
  return {
    current: sortPhotos(rows.filter((r) => r.year_id === yearId)),
    previous: prevYearId ? sortPhotos(rows.filter((r) => r.year_id === prevYearId)) : [],
  };
}

/** 部屋ごとの枚数（今年・前年） */
export function countRoomPhotos(rows: readonly RoomPhotoRow[], yearId: string, prevYearId: string | null): Map<string, { current: number; previous: number }> {
  const m = new Map<string, { current: number; previous: number }>();
  for (const r of rows) {
    const isCurrent = r.year_id === yearId;
    if (!isCurrent && (!prevYearId || r.year_id !== prevYearId)) continue;
    const c = m.get(r.room_id) ?? { current: 0, previous: 0 };
    if (isCurrent) c.current++;
    else c.previous++;
    m.set(r.room_id, c);
  }
  return m;
}

/** 一覧の枚数の文字（「今年 2 枚・前年 3 枚」。0 枚は「まだ」。前の年度がなければ前年は出さない） */
export function photoCountLabel(c: { current: number; previous: number } | undefined, hasPrevious: boolean): string {
  const n = (k: number) => (k === 0 ? 'まだ' : `${k} 枚`);
  const current = `今年 ${n(c?.current ?? 0)}`;
  return hasPrevious ? `${current}・前年 ${n(c?.previous ?? 0)}` : current;
}

/**
 * 「前へ」「後ろへ」の並びの変更（隣の写真と sort_order を入れ替える。同じ値なら並びの全部を 0 から振り直す）。送る変更の一覧を返す
 * （動かせなければ空）。
 *
 * @example
 * movePhotoChanges(photos, id, -1) // [{ id, sortOrder: 0 }, { id: prev, sortOrder: 1 }]
 */
export function movePhotoChanges(photos: readonly RoomPhotoRow[], photoId: string, delta: -1 | 1): { id: string; sortOrder: number }[] {
  const list = sortPhotos(photos);
  const i = list.findIndex((p) => p.id === photoId);
  const j = i + delta;
  if (i < 0 || j < 0 || j >= list.length) return [];
  const a = list[i]!;
  const b = list[j]!;
  if (a.sort_order !== b.sort_order) {
    return [
      { id: a.id, sortOrder: b.sort_order },
      { id: b.id, sortOrder: a.sort_order },
    ];
  }
  const order = [...list];
  order[i] = b;
  order[j] = a;
  return order
    .map((p, k) => ({ id: p.id, sortOrder: Math.min(k, ROOM_PHOTO_SORT_MAX), before: p.sort_order }))
    .filter((x) => x.sortOrder !== x.before)
    .map(({ id, sortOrder }) => ({ id, sortOrder }));
}

/** 書いた後に、その年度の写真（全部の場所と各部屋）を読み直す */
export function invalidateRoomPhotos(queryClient: QueryClient, yearId: string): Promise<void> {
  return queryClient.invalidateQueries({ queryKey: roomPhotoKeys.year(yearId) });
}

/** 書き込みの結果（失敗なら画面に出す文言と、立場の読み直し・写真が消えていたか） */
export type RoomPhotoWriteResult = { ok: true } | { ok: false; message: string; reloadMembership: boolean; gone: boolean };

/** 送る部品を読めなかった（通信が切れた） */
const LOAD_FAILED_MESSAGE = '通信できませんでした。電波の良い所でもう一度';

async function loadWrite() {
  const [upload, messages] = await Promise.all([import('@/lib/room-photos/upload'), import('@/lib/room-photos/messages')]);
  return { ...upload, ...messages };
}

async function run(fn: (mod: Awaited<ReturnType<typeof loadWrite>>) => Promise<unknown>): Promise<RoomPhotoWriteResult> {
  let mod: Awaited<ReturnType<typeof loadWrite>>;
  try {
    mod = await loadWrite();
  } catch {
    return { ok: false, message: LOAD_FAILED_MESSAGE, reloadMembership: false, gone: false };
  }
  try {
    await fn(mod);
    return { ok: true };
  } catch (e) {
    const cause = e instanceof mod.RoomPhotoError ? e.cause : e;
    return {
      ok: false,
      message: e instanceof mod.RoomPhotoError ? e.message : mod.roomPhotoMessageFor(e, 'edit'),
      reloadMembership: mod.roomPhotoNeedsMembershipReload(cause),
      gone: mod.isRoomPhotoGone(cause),
    };
  }
}

/** 写真を足す（送る部品は押したときに動的 import。photoId は送り直しの id）。終わったら（失敗でも）写真を読み直す */
export async function sendRoomPhoto(
  queryClient: QueryClient,
  input: { yearId: string; roomId: string; file: Blob; memo: string; photoId: string },
): Promise<RoomPhotoWriteResult> {
  try {
    return await run((m) => m.addRoomPhoto(input.yearId, input.roomId, input.file, input.memo, { photoId: input.photoId }));
  } finally {
    void invalidateRoomPhotos(queryClient, input.yearId);
  }
}

/** メモを直す */
export async function saveRoomPhotoMemo(queryClient: QueryClient, yearId: string, photoId: string, memo: string): Promise<RoomPhotoWriteResult> {
  try {
    return await run((m) => m.updateRoomPhoto(photoId, { memo }));
  } finally {
    void invalidateRoomPhotos(queryClient, yearId);
  }
}

/** 並べ替える（movePhotoChanges の変更を順に送る。終わったら〔失敗でも〕読み直す） */
export async function moveRoomPhoto(
  queryClient: QueryClient,
  yearId: string,
  changes: readonly { id: string; sortOrder: number }[],
): Promise<RoomPhotoWriteResult> {
  try {
    return await run(async (m) => {
      for (const c of changes) await m.updateRoomPhoto(c.id, { sortOrder: c.sortOrder });
    });
  } finally {
    void invalidateRoomPhotos(queryClient, yearId);
  }
}

/** 消す（resend は送り直し。not_found なら消えていたものとして読んでいた path を消す） */
export async function removeRoomPhoto(
  queryClient: QueryClient,
  yearId: string,
  photo: Pick<RoomPhotoRow, 'id' | 'object_path'>,
  opts: { resend?: boolean } = {},
): Promise<RoomPhotoWriteResult> {
  try {
    return await run((m) => m.deleteRoomPhoto(photo.id, photo.object_path, { resend: !!opts.resend }));
  } finally {
    void invalidateRoomPhotos(queryClient, yearId);
  }
}
