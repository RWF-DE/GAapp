// 現状復帰の写真を送る・消す（04「現状復帰の写真」。T25・D-63。02「現状復帰の写真の権限」）。品目の画像（lib/item-images/upload.ts）と
// 同じ流れを、bucket room-photos と長い辺 1600px で行う：
// 写真を作り直す（lib/item-images/image.ts。長い辺 1600px・WebP、作れなければ JPEG。EXIF は残らない）→ reserve_room_photo
// （photo_id は画面が作る uuid。DB が path を作る）→ 返った object_path へ Storage API で upload（`upsert: false`。409 は「もう届いて
// いた」として成功）→ add_room_photo（写真の行にする）。add の前に失敗したら、上げた自分の物を remove で片付ける。
// 送り直し（B1）：ダイアログが開いている間は同じ photo_id を渡す。予約が使用済みなら upload せず add_room_photo だけを呼ぶ（行がまだ
// あればその行が返る）。期限が切れて物が先に届いていた予約は、upload が 403 になるので add_room_photo を試す。
// 上限：too_many_reservations は自分の期限の切れた予約の物を、too_many_orphans はその年度・部屋のフォルダの、写真の行でも自分の生きた
// 予約でもない物を remove してから、1回だけ予約し直す。
// 消すのは delete_room_photo → 返った path を remove（失敗しても知らせない。次の too_many_orphans の片付けで消える）。
// このファイルは「送る」「消す」を押したときに画面が動的 import で読む（/room-photos の最初に読む JS に入れない）。
// 署名つき URL・path は返すだけで、ログ・下書きに残さない。元のファイル名は Storage へ送らない（送る Blob は作り直した物）。
import { AppError, classifyError } from '@/lib/errors';
import { BROWSER_ITEM_IMAGE_ENV, ItemImageDecodeError, ItemImageTooLargeError, prepareItemImage, ROOM_PHOTO_MAX_SIDE, type ItemImageContentType, type ItemImageEnv } from '@/lib/item-images/image';
import { isItemImageAlreadyUploaded, storageBucket, toItemImageStorageError, type ItemImageBucketApi } from '@/lib/item-images/upload';
import { callRpc } from '@/lib/rpc';
import { getSupabase, type AppSupabaseClient } from '@/lib/supabase/client';
import { roomPhotoMessageFor, type RoomPhotoOp } from './messages';

/** Storage の bucket（非公開。0024） */
export const ROOM_PHOTOS_BUCKET = 'room-photos';

/** 写真の行（room_photos。RPC の返り値） */
export interface RoomPhotoRow {
  id: string;
  year_id: string;
  room_id: string;
  object_path: string;
  memo: string;
  sort_order: number;
  created_at: string;
  created_by: string | null;
  updated_at: string;
}

function bucket(client: AppSupabaseClient): ItemImageBucketApi {
  return storageBucket(client, ROOM_PHOTOS_BUCKET);
}

/** どの段で失敗したか */
export type RoomPhotoStep = 'prepare' | 'reserve' | 'upload' | 'add' | 'update' | 'delete';

/** 写真の操作の失敗（cause は元のエラー。message は画面に出す文言） */
export class RoomPhotoError extends Error {
  override name = 'RoomPhotoError';
  readonly step: RoomPhotoStep;
  override readonly cause: unknown;
  constructor(step: RoomPhotoStep, cause: unknown) {
    super(roomPhotoErrorMessage(step, cause));
    this.step = step;
    this.cause = cause;
  }
}

/** 失敗の文言（作り直しは image.ts の文言〔「写真が大きすぎます」など〕、RPC・Storage は messages.ts の写真の文言） */
export function roomPhotoErrorMessage(step: RoomPhotoStep, cause: unknown): string {
  if (cause instanceof ItemImageDecodeError || cause instanceof ItemImageTooLargeError) return cause.message;
  const op: RoomPhotoOp = step === 'update' || step === 'delete' ? 'edit' : 'add';
  return roomPhotoMessageFor(cause, op);
}

/** 道具（テストで差し替える） */
export interface RoomPhotoDeps {
  client?: AppSupabaseClient;
  env?: ItemImageEnv;
  /** photo_id を作る（既定は crypto.randomUUID） */
  newId?: () => string;
  /** 送り直しで使う photo_id（ダイアログが開いている間、同じ部屋・同じ写真なら同じ id。B1）。渡せば newId は呼ばない */
  photoId?: string;
}

const isRecord = (v: unknown): v is Record<string, unknown> => typeof v === 'object' && v !== null && !Array.isArray(v);

function stateReason(e: unknown): string | null {
  const c = classifyError(e);
  return c.kind === 'state' && isRecord(c.details) && typeof c.details.reason === 'string' ? c.details.reason : null;
}

/** 写真のフォルダ（`{year_id}/{room_id}`。0024 の object_path の形） */
export function roomPhotoFolder(yearId: string, roomId: string): string {
  return `${yearId}/${roomId}`;
}

/** 自分の、期限の切れた使っていない予約の物を Storage から消す（too_many_reservations のとき）。消せなくても投げない */
async function removeMyStaleUploads(client: AppSupabaseClient): Promise<void> {
  try {
    const res = await client
      .from('room_photo_uploads')
      .select('object_path')
      .is('used_at', null)
      .lt('expires_at', new Date().toISOString())
      .limit(100);
    if (res.error) return;
    const paths = ((res.data ?? []) as { object_path: string }[]).map((r) => r.object_path).filter((p) => typeof p === 'string' && p !== '');
    if (paths.length > 0) await bucket(client).remove(paths);
  } catch {
    // 片付けられなくても、予約し直しの結果（文言）を出すだけ
  }
}

/**
 * その年度・部屋のフォルダの、写真の行でも自分の生きた予約でもない物を remove する（too_many_orphans のとき）。ほかの人の生きた予約の
 * 物は delete のポリシーが消させない。失敗しても投げない
 */
async function removeRoomPhotoOrphans(yearId: string, roomId: string, client: AppSupabaseClient): Promise<void> {
  const folder = roomPhotoFolder(yearId, roomId);
  try {
    const [rows, mine, listed] = await Promise.all([
      client.from('room_photos').select('object_path').eq('year_id', yearId).eq('room_id', roomId).limit(100),
      client.from('room_photo_uploads').select('object_path').is('used_at', null).gt('expires_at', new Date().toISOString()).limit(100),
      bucket(client).list(folder, { limit: 100 }),
    ]);
    if (rows.error || mine.error || listed.error) return;
    const keep = new Set<string>();
    for (const r of [...((rows.data ?? []) as { object_path: string }[]), ...((mine.data ?? []) as { object_path: string }[])]) keep.add(r.object_path);
    const paths = (listed.data ?? [])
      .map((o) => o.name)
      .filter((n) => typeof n === 'string' && n !== '')
      .map((n) => `${folder}/${n}`)
      .filter((p) => !keep.has(p));
    if (paths.length > 0) await bucket(client).remove(paths);
  } catch {
    // 片付けられなくても、予約し直しの結果（文言）を出すだけ
  }
}

async function removeQuietly(client: AppSupabaseClient, path: string | null): Promise<boolean> {
  if (!path) return true;
  try {
    const res = await bucket(client).remove([path]);
    return !res.error;
  } catch {
    return false;
  }
}

/**
 * 写真を作り直して、その年度・部屋の写真にする（メモは送る前に前後の空白を除く）。足した行を返す。失敗は RoomPhotoError を投げる。
 *
 * @example
 * const { addRoomPhoto } = await import('@/lib/room-photos/upload');
 * await addRoomPhoto(yearId, roomId, file, 'メモ', { photoId });
 */
export async function addRoomPhoto(yearId: string, roomId: string, file: Blob, memo: string, deps: RoomPhotoDeps = {}): Promise<RoomPhotoRow> {
  const client = deps.client ?? getSupabase();
  let prepared: { blob: Blob; contentType: ItemImageContentType };
  try {
    prepared = await prepareItemImage(file, deps.env ?? BROWSER_ITEM_IMAGE_ENV, { maxSide: ROOM_PHOTO_MAX_SIDE });
  } catch (e) {
    throw new RoomPhotoError('prepare', e);
  }
  const photoId = deps.photoId ?? (deps.newId ?? (() => crypto.randomUUID()))();
  const reserve = () =>
    callRpc('reserve_room_photo', { p_year_id: yearId, p_room_id: roomId, p_photo_id: photoId, p_content_type: prepared.contentType }, client);
  const add = async () => (await callRpc('add_room_photo', { p_photo_id: photoId, p_memo: memo }, client)) as RoomPhotoRow;
  // 使用済みの予約の add は前の行を返し、メモは変えない（0024）。送り直しの間にメモを直していたら update_room_photo で今のメモにする
  // （直したメモを黙って捨てない。T25 のレビュー）。失敗は RoomPhotoError('update')。写真は足してあるので物は消さない
  const sentMemo = memo.trim();
  const withMemo = async (row: RoomPhotoRow): Promise<RoomPhotoRow> =>
    (row.memo ?? '') === sentMemo ? row : updateRoomPhoto(photoId, { memo: sentMemo }, { client });
  let objectPath: string;
  let alreadyUsed: boolean;
  let expired: boolean;
  try {
    let row: Awaited<ReturnType<typeof reserve>>;
    try {
      row = await reserve();
    } catch (e) {
      const reason = stateReason(e);
      if (reason === 'too_many_reservations') {
        await removeMyStaleUploads(client);
        row = await reserve();
      } else if (reason === 'too_many_orphans') {
        await removeRoomPhotoOrphans(yearId, roomId, client);
        row = await reserve();
      } else {
        throw e;
      }
    }
    objectPath = row.object_path;
    alreadyUsed = row.used_at != null;
    expired = !alreadyUsed && row.expires_at != null && new Date(row.expires_at).getTime() <= Date.now();
  } catch (e) {
    throw new RoomPhotoError('reserve', e);
  }
  // 使用済みの予約（add の応答が届かず、同じ id で送り直した）：物はもう写真になっている。上げずに add を呼ぶ（行がまだあればその行が
  // 返り、消した後なら invalid_state〔used〕）
  if (!alreadyUsed) {
    const body = new Blob([prepared.blob], { type: prepared.contentType });
    try {
      let res: { data: unknown; error: unknown };
      try {
        res = await bucket(client).upload(objectPath, body, { contentType: prepared.contentType, upsert: false });
      } catch (e) {
        throw toItemImageStorageError(e);
      }
      if (res.error && !isItemImageAlreadyUploaded(res.error)) throw toItemImageStorageError(res.error);
    } catch (e) {
      // 期限が切れた予約に物が先に届いていた（upload は expired で 403）：add は期限を見ないので試す。失敗したら upload の文言を出す
      if (expired && e instanceof AppError && e.info.reason === 'item_image_denied') {
        let row: RoomPhotoRow | null = null;
        try {
          row = await add();
        } catch {
          // 下で upload の失敗を投げる
        }
        if (row) return withMemo(row);
      }
      throw new RoomPhotoError('upload', e);
    }
  }
  let added: RoomPhotoRow;
  try {
    added = await add();
  } catch (e) {
    // 写真にできなかった：上げた自分の物を片付ける（どの写真にも使われていない物なので消せる。消せなくても残るだけ）。使用済みの物は消さない
    if (!alreadyUsed) await removeQuietly(client, objectPath);
    throw new RoomPhotoError('add', e);
  }
  return withMemo(added);
}

/** メモと並びを変える（null は変えない）。変えた行を返す。失敗は RoomPhotoError */
export async function updateRoomPhoto(
  photoId: string,
  change: { memo?: string | null; sortOrder?: number | null },
  deps: Pick<RoomPhotoDeps, 'client'> = {},
): Promise<RoomPhotoRow> {
  const client = deps.client ?? getSupabase();
  try {
    return (await callRpc(
      'update_room_photo',
      { p_photo_id: photoId, p_memo: change.memo ?? null, p_sort_order: change.sortOrder ?? null },
      client,
    )) as RoomPhotoRow;
  } catch (e) {
    throw new RoomPhotoError('update', e);
  }
}

/**
 * 写真を消す（delete_room_photo → 返った path を remove。remove の失敗は知らせない）。送り直しが not_found なら（前の送信で消えていた）
 * knownPath（読んでいた行の object_path）を remove して、消えたものとして返す（B1）。失敗は RoomPhotoError。
 */
export async function deleteRoomPhoto(photoId: string, knownPath: string | null, deps: Pick<RoomPhotoDeps, 'client'> & { resend?: boolean } = {}): Promise<void> {
  const client = deps.client ?? getSupabase();
  let path: string | null;
  try {
    path = (await callRpc('delete_room_photo', { p_photo_id: photoId }, client)) ?? null;
  } catch (e) {
    if (deps.resend && classifyError(e).kind === 'not_found') {
      await removeQuietly(client, knownPath);
      return;
    }
    throw new RoomPhotoError('delete', e);
  }
  await removeQuietly(client, path);
}
