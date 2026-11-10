// 品目の画像を送る・外す（04「在庫入力」の「新しく登録」・「写真を足す」、「マスタ設定」の品目のタブ。T23・D-61。02「品目の画像」）。
// 順番：写真を作り直す（image.ts。長い辺 1024px・WebP、作れなければ JPEG）→ reserve_item_image（image_id は画面が作る uuid。
// DB が path を作る）→ 返った object_path へ Storage API で upload（`upsert: false`。上書きしない。409 は「もう届いていた」として成功）
// → set_item_image（行の画像にし、前の画像の path が返る）→ 前の物を Storage API の remove で消す（SQL では消せない。消せなくても
// どの行にも使われていない物として残るだけなので、失敗は知らせない）。set の前に失敗したら、上げた自分の物を remove で片付ける。
// 外すのは set_item_image(…, null) → 前の物を remove。
// このファイルは写真を選んだ後に画面が動的 import で読む（`await import('@/lib/item-images/upload')`。最初に読む JS に入れない）。
// 署名つき URL・path は返すだけで、ログ・下書きに残さない。元のファイル名は Storage へ送らない（送る Blob は作り直した物）。
import { AppError, classifyError, toAppError } from '@/lib/errors';
import { ITEM_IMAGES_BUCKET, type ItemImageKind } from '@/lib/data/item-images';
import { callRpc } from '@/lib/rpc';
import { getSupabase, type AppSupabaseClient } from '@/lib/supabase/client';
import {
  BROWSER_ITEM_IMAGE_ENV,
  ItemImageDecodeError,
  ItemImageTooLargeError,
  prepareItemImage,
  type ItemImageContentType,
  type ItemImageEnv,
} from './image';
import { itemImageMessageFor } from './messages';

/** Storage の操作で使う最小の形（supabase-js の storage.from(bucket)。テストの偽物もこの形を満たす） */
export interface ItemImageBucketApi {
  upload(path: string, body: Blob, options: { contentType: string; upsert: boolean }): Promise<{ data: unknown; error: unknown }>;
  remove(paths: string[]): Promise<{ data: unknown[] | null; error: unknown }>;
  list(folder: string, options?: { limit?: number }): Promise<{ data: { name: string }[] | null; error: unknown }>;
}

function bucket(client: AppSupabaseClient): ItemImageBucketApi {
  return (client as unknown as { storage: { from(id: string): ItemImageBucketApi } }).storage.from(ITEM_IMAGES_BUCKET);
}

const isRecord = (v: unknown): v is Record<string, unknown> => typeof v === 'object' && v !== null && !Array.isArray(v);

/** Storage の本文の statusCode と code（Storage のエラーでなければ null） */
function storageCodes(e: unknown): { statusCode: string; code: string } | null {
  if (!isRecord(e) || !('__isStorageError' in e)) return null;
  return {
    statusCode: typeof e.statusCode === 'string' || typeof e.statusCode === 'number' ? String(e.statusCode) : '',
    code: typeof e.code === 'string' ? e.code : '',
  };
}

/** upload の「もう届いていた」（本文の statusCode が "409" か、code が KeyAlreadyExists・Duplicate。HTTP の status〔400〕ではない） */
export function isItemImageAlreadyUploaded(e: unknown): boolean {
  const c = storageCodes(e);
  return !!c && (c.statusCode === '409' || c.code === 'KeyAlreadyExists' || c.code === 'Duplicate');
}

function storageError(kind: 'forbidden' | 'input' | 'unknown', reason: string, status: number | null): AppError {
  return new AppError({ kind, code: null, reason, details: null, issues: [], status });
}

/**
 * Storage API のエラーを AppError にする（本文の statusCode と code で分ける）：403 → item_image_denied、413 → item_image_too_large、
 * 415 → item_image_mime、通信の失敗（fetch の TypeError・中止。StorageUnknownError に包まれたもの）→ network、ほか → item_image_failed。
 */
export function toItemImageStorageError(e: unknown): AppError {
  if (e instanceof AppError) return e;
  const c = storageCodes(e);
  if (!c) return toAppError(e);
  if (isRecord(e) && e.name === 'StorageUnknownError') {
    const original = e.originalError;
    if (original instanceof TypeError || (original instanceof Error && original.name === 'AbortError')) return toAppError(original);
    return storageError('unknown', 'item_image_failed', null);
  }
  const numeric = Number(c.statusCode);
  const status = Number.isInteger(numeric) && numeric >= 100 && numeric <= 599 ? numeric : null;
  if (c.statusCode === '403' || c.code === 'AccessDenied') return storageError('forbidden', 'item_image_denied', status);
  if (c.statusCode === '413' || c.code === 'EntityTooLarge') return storageError('input', 'item_image_too_large', status);
  if (c.statusCode === '415' || c.code === 'InvalidMimeType') return storageError('input', 'item_image_mime', status);
  return storageError('unknown', 'item_image_failed', status);
}

/** どの段で失敗したか（文言の文脈） */
export type ItemImageStep = 'prepare' | 'reserve' | 'upload' | 'set' | 'remove';

/** 画像を送る・外すの失敗（cause は元のエラー。message は画面に出す文言） */
export class ItemImageError extends Error {
  override name = 'ItemImageError';
  readonly step: ItemImageStep;
  override readonly cause: unknown;
  constructor(step: ItemImageStep, cause: unknown) {
    super(itemImageErrorMessage(step, cause));
    this.step = step;
    this.cause = cause;
  }
}

/** 失敗の文言（作り直しは image.ts の文言、RPC・Storage は messages.ts の品目の画像の文言） */
export function itemImageErrorMessage(step: ItemImageStep, cause: unknown): string {
  if (cause instanceof ItemImageDecodeError || cause instanceof ItemImageTooLargeError) return cause.message;
  if (step === 'reserve') return itemImageMessageFor(cause, 'reserve_item_image');
  if (step === 'set' || step === 'remove') return itemImageMessageFor(cause, 'set_item_image');
  return itemImageMessageFor(cause, null);
}

/** 送った結果（path は行の今の画像。previousRemoved は前の物を消せたか〔前がなければ true〕） */
export interface AttachedItemImage {
  path: string;
  previous: string | null;
  previousRemoved: boolean;
}

/** 道具（テストで差し替える） */
export interface ItemImageDeps {
  client?: AppSupabaseClient;
  env?: ItemImageEnv;
  /** image_id を作る（既定は crypto.randomUUID） */
  newId?: () => string;
  /**
   * 送り直しで使う image_id（ダイアログが開いている間、同じ対象・同じ写真なら同じ id。04「品目の画像の共通の部品」・(B1)）。
   * 渡せば newId は呼ばない。同じ id なら reserve は同じ予約、upload の2回目は 409（届いていた）、set は同じ前の path を返す
   */
  imageId?: string;
}

/** 予約の invalid_state の reason が too_many_reservations か */
function isTooManyReservations(e: unknown): boolean {
  const c = classifyError(e);
  return c.kind === 'state' && isRecord(c.details) && c.details.reason === 'too_many_reservations';
}

/** 予約の invalid_state の reason が too_many_orphans か */
function isTooManyOrphans(e: unknown): boolean {
  const c = classifyError(e);
  return c.kind === 'state' && isRecord(c.details) && c.details.reason === 'too_many_orphans';
}

/**
 * 自分の、期限の切れた使っていない予約の物を Storage から消す（too_many_reservations のとき。行の画像にしていない物は上限に数えられ、
 * 消せば数えない。0022 の reserve_item_image）。予約の表は自分の行だけ読める。消せなくても投げない
 */
async function removeMyStaleUploads(client: AppSupabaseClient): Promise<void> {
  try {
    const res = await client
      .from('item_image_uploads')
      .select('object_path')
      .is('used_at', null)
      .lt('expires_at', new Date().toISOString())
      .limit(100);
    if (res.error) return;
    const paths = ((res.data ?? []) as { object_path: string }[]).map((r) => r.object_path).filter((p) => typeof p === 'string' && p !== '');
    if (paths.length > 0) await bucket(client).remove(paths);
  } catch {
    // 片付けられなくても、予約し直しの結果（too_many_reservations の文言）を出すだけ
  }
}

/**
 * 消した行（備品の削除など）のフォルダ `items/{id}/`・`count-items/{id}/` の物を一覧して remove する（行の画像と、送り直しの残りの物。
 * 02「品目の画像」）。消せたら true。失敗しても投げない（どの行にも使われていない物として残るだけ）
 */
export async function removeItemImageFolder(kind: ItemImageKind, targetId: string, deps: Pick<ItemImageDeps, 'client'> = {}): Promise<boolean> {
  const client = deps.client ?? getSupabase();
  const folder = `${kind === 'item' ? 'items' : 'count-items'}/${targetId}`;
  try {
    const listed = await bucket(client).list(folder, { limit: 100 });
    if (listed.error) return false;
    const paths = (listed.data ?? []).map((o) => o.name).filter((n) => typeof n === 'string' && n !== '').map((n) => `${folder}/${n}`);
    if (paths.length === 0) return true;
    const res = await bucket(client).remove(paths);
    return !res.error;
  } catch {
    return false;
  }
}

/**
 * その対象のフォルダの、行の画像以外の物（替えた後の前の画像の残りなど）を remove する（too_many_orphans のとき。0022）。行の画像は
 * 読み直した image_path を除き、自分の生きた予約の物も除く。ほかの人の生きた予約の物は delete のポリシーが消させない。失敗しても投げない
 */
async function removeItemImageOrphans(kind: ItemImageKind, targetId: string, client: AppSupabaseClient): Promise<void> {
  const folder = `${kind === 'item' ? 'items' : 'count-items'}/${targetId}`;
  try {
    const table = kind === 'item' ? 'items' : 'count_items';
    const [row, mine, listed] = await Promise.all([
      client.from(table).select('image_path').eq('id', targetId).maybeSingle(),
      client.from('item_image_uploads').select('object_path').is('used_at', null).gt('expires_at', new Date().toISOString()).limit(100),
      bucket(client).list(folder, { limit: 100 }),
    ]);
    if (row.error || mine.error || listed.error) return;
    const keep = new Set<string>();
    const current = (row.data as { image_path: string | null } | null)?.image_path;
    if (current) keep.add(current);
    for (const r of (mine.data ?? []) as { object_path: string }[]) keep.add(r.object_path);
    const paths = (listed.data ?? []).map((o) => o.name).filter((n) => typeof n === 'string' && n !== '').map((n) => `${folder}/${n}`).filter((p) => !keep.has(p));
    if (paths.length > 0) await bucket(client).remove(paths);
  } catch {
    // 片付けられなくても、予約し直しの結果（too_many_orphans の文言）を出すだけ
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
 * 写真を作り直して、その行（items か count_items）の画像にする。失敗は ItemImageError（step と文言）を投げる。
 *
 * @example
 * const { attachItemImage } = await import('@/lib/item-images/upload');
 * await attachItemImage('count_item', countItemId, file);
 */
export async function attachItemImage(kind: ItemImageKind, targetId: string, file: Blob, deps: ItemImageDeps = {}): Promise<AttachedItemImage> {
  const client = deps.client ?? getSupabase();
  let prepared: { blob: Blob; contentType: ItemImageContentType };
  try {
    prepared = await prepareItemImage(file, deps.env ?? BROWSER_ITEM_IMAGE_ENV);
  } catch (e) {
    throw new ItemImageError('prepare', e);
  }
  const imageId = deps.imageId ?? (deps.newId ?? (() => crypto.randomUUID()))();
  const reserve = () =>
    callRpc('reserve_item_image', { p_kind: kind, p_target_id: targetId, p_image_id: imageId, p_content_type: prepared.contentType }, client);
  let objectPath: string;
  let alreadyUsed: boolean;
  let expired: boolean;
  try {
    let row: Awaited<ReturnType<typeof reserve>>;
    try {
      row = await reserve();
    } catch (e) {
      if (isTooManyReservations(e)) {
        // 上限：自分の期限の切れた残りの物を片付けてから、1回だけ予約し直す
        await removeMyStaleUploads(client);
        row = await reserve();
      } else if (isTooManyOrphans(e)) {
        // 上限：その対象のフォルダの、行の画像以外の残りの物を片付けてから、1回だけ予約し直す
        await removeItemImageOrphans(kind, targetId, client);
        row = await reserve();
      } else {
        throw e;
      }
    }
    objectPath = row.object_path;
    alreadyUsed = row.used_at != null;
    expired = !alreadyUsed && row.expires_at != null && new Date(row.expires_at).getTime() <= Date.now();
  } catch (e) {
    throw new ItemImageError('reserve', e);
  }
  // 使用済みの予約（set の応答が届かず、同じ id で送り直した）：物はもう行の画像になっている。上げずに set を呼ぶ（上げるとトリガーが used で
  // 止める）。set は、行の画像がまだその物なら前の path を返し、もう別の物なら invalid_state（used）。
  // 送る物は contentType の新しい Blob（storage-js は part の形を Blob の type にする。File の名前は送らない）
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
      // 期限が切れた予約に物が先に届いていた（reserve は物があれば延ばさず、upload は expired で 403）：set は期限を見ないので試す。
      // 試して失敗したら upload の拒否の文言を出す
      if (expired && e instanceof AppError && e.info.reason === 'item_image_denied') {
        try {
          const previous = (await callRpc('set_item_image', { p_kind: kind, p_target_id: targetId, p_image_id: imageId }, client)) ?? null;
          const previousRemoved = previous === objectPath ? true : await removeQuietly(client, previous);
          return { path: objectPath, previous, previousRemoved };
        } catch {
          // 下で upload の失敗を投げる
        }
      }
      throw new ItemImageError('upload', e);
    }
  }
  let previous: string | null;
  try {
    previous = (await callRpc('set_item_image', { p_kind: kind, p_target_id: targetId, p_image_id: imageId }, client)) ?? null;
  } catch (e) {
    // 行の画像にできなかった：上げた自分の物を片付ける（どの行にも使われていない物なので消せる。消せなくても残るだけ）。使用済みの物は消さない
    if (!alreadyUsed) await removeQuietly(client, objectPath);
    throw new ItemImageError('set', e);
  }
  const previousRemoved = previous === objectPath ? true : await removeQuietly(client, previous);
  return { path: objectPath, previous, previousRemoved };
}

/**
 * その行の画像を外す（set_item_image(…, null) → 前の物を remove）。前の path（なければ null）を返す。失敗は ItemImageError。
 */
export async function detachItemImage(kind: ItemImageKind, targetId: string, deps: Pick<ItemImageDeps, 'client'> = {}): Promise<string | null> {
  const client = deps.client ?? getSupabase();
  let previous: string | null;
  try {
    previous = (await callRpc('set_item_image', { p_kind: kind, p_target_id: targetId, p_image_id: null }, client)) ?? null;
  } catch (e) {
    throw new ItemImageError('set', e);
  }
  await removeQuietly(client, previous);
  return previous;
}
