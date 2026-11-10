// 品目の画像の読み取り（04「品目の画像の共通の部品」。T23・D-61）。
// - 行の画像の path：items・count_items の id と image_path だけを読む（画面の品目の読み込み〔COLUMNS.items〕には足さない。
//   items はスナップショット〔年度のデータ〕の中身なので、画像の列で振り分けの入力を変えないため）。キーは `['item-images', 'paths', kind]`
//   （年度をまたぐ表なので年度のキーの下に置かない。画像を変えた画面が invalidateItemImagePaths で読み直す）。
// - 署名つき URL：一覧の path をまとめて createSignedUrls で1回に作る（有効 10 分。path ごとに呼ばない）。URL は TanStack Query の
//   メモリーのキャッシュにだけ持つ（下書き・ログ・localStorage・画面の URL に入れない。キャッシュは保存しない）。
//   10 分を過ぎて読み込みに失敗したら作り直す（useItemImageUrls の reportError）。
// 書き込み（予約・上げる・行の画像にする・前の物を消す）は lib/item-images/upload.ts（写真を選んだ後に動的 import する）。
// このファイルは在庫入力・申請・マスタ設定が読む。ダッシュボード（/）からは読まない（D-51）。
import { queryOptions, useQuery, type QueryClient } from '@tanstack/react-query';
import { useCallback, useMemo } from 'react';
import { toAppError } from '@/lib/errors';
import { queryKeys } from '@/lib/query';
import { getSupabase, type AppSupabaseClient } from '@/lib/supabase/client';

/** Storage の bucket（非公開。0022） */
export const ITEM_IMAGES_BUCKET = 'item-images';
/** 署名つき URL の有効（秒）。D-61：中身が机・椅子などの写真で、一覧で何枚も出すため、提出物の 60 秒より長い 10 分 */
export const ITEM_IMAGE_SIGNED_URL_SECONDS = 600;
/** 作り直す目安（ミリ秒）。有効の 10 分より少し前（読み込みに失敗したとき、これより古い URL なら作り直す） */
export const ITEM_IMAGE_URL_REFRESH_MS = 9 * 60 * 1000;

/** 画像を持つ行の種類（RPC の kind） */
export type ItemImageKind = 'item' | 'count_item';

const TABLE_OF = { item: 'items', count_item: 'count_items' } as const;

/** 行の id → 画像の path（画像のない行は入れない） */
export type ItemImagePaths = ReadonlyMap<string, string>;

/** 行の画像の path を読む（id と image_path だけ。画像のない行は入れない） */
export async function fetchItemImagePaths(kind: ItemImageKind, client: AppSupabaseClient = getSupabase()): Promise<ItemImagePaths> {
  const res = await client.from(TABLE_OF[kind]).select('id, image_path').order('id');
  if (res.error) throw toAppError(res.error, res.status);
  const m = new Map<string, string>();
  for (const r of (res.data ?? []) as { id: string; image_path?: string | null }[]) {
    if (typeof r.image_path === 'string' && r.image_path !== '') m.set(r.id, r.image_path);
  }
  return m;
}

export const itemImageKeys = {
  all: () => ['item-images'] as const,
  paths: (kind: ItemImageKind) => ['item-images', 'paths', kind] as const,
  urls: (paths: readonly string[]) => ['item-images', 'urls', ...paths] as const,
};

export function itemImagePathsOptions(kind: ItemImageKind) {
  return queryOptions({ queryKey: itemImageKeys.paths(kind), queryFn: () => fetchItemImagePaths(kind) });
}

/** その行の今の画像の path を DB から読む（なければ null。在庫入力の「新しく登録」で、既にある物の画像を確かめる。04） */
export async function fetchItemImagePath(kind: ItemImageKind, id: string, client: AppSupabaseClient = getSupabase()): Promise<string | null> {
  const res = await client.from(TABLE_OF[kind]).select('image_path').eq('id', id).maybeSingle();
  if (res.error) throw toAppError(res.error, res.status);
  const p = (res.data as { image_path?: string | null } | null)?.image_path;
  return typeof p === 'string' && p !== '' ? p : null;
}

/** 行の一覧のキー（品目：['items', …]〔マスタ設定の settingsKeys.items も〕、備品：['count_items', …]〔settingsKeys.countItems〕） */
const ROWS_KEY_OF = { item: queryKeys.items(), count_item: ['count_items'] } as const;

/**
 * 画像を変えた後に、その種類の path と行の一覧を読み直す。set_item_image は行を update するので updated_at が進む。古い updated_at の
 * ままだと、マスタ設定の「編集」「削除」（楽観ロック）が自分の操作なのに conflict で止まる（2026-11-10 のレビュー）。在庫入力の名前の
 * 一覧（年度ごとの stock-master。品目と備品の行を持つ）も読み直す
 */
export function invalidateItemImagePaths(queryClient: QueryClient, kind: ItemImageKind): Promise<void> {
  return Promise.all([
    queryClient.invalidateQueries({ queryKey: itemImageKeys.paths(kind) }),
    queryClient.invalidateQueries({ queryKey: ROWS_KEY_OF[kind] }),
    queryClient.invalidateQueries({ predicate: (q) => q.queryKey[0] === 'year' && q.queryKey[2] === 'stock-master' }),
  ]).then(() => undefined);
}

/** Storage の操作で使う最小の形（storage.from(bucket)。テストの偽物もこの形を満たす） */
interface SignBucketApi {
  createSignedUrls(
    paths: string[],
    expiresIn: number,
  ): Promise<{ data: { path: string | null; signedUrl: string | null; error: string | null }[] | null; error: unknown }>;
}

/**
 * path の署名つき URL をまとめて作る（createSignedUrls を1回。有効 10 分）。作れなかった path は入れない（画面は頭文字のカード）。
 * 全体が失敗したら AppError を投げる。
 */
export async function signItemImagePaths(paths: readonly string[], client: AppSupabaseClient = getSupabase()): Promise<ReadonlyMap<string, string>> {
  const out = new Map<string, string>();
  if (paths.length === 0) return out;
  const bucket = (client as unknown as { storage: { from(id: string): SignBucketApi } }).storage.from(ITEM_IMAGES_BUCKET);
  let res: Awaited<ReturnType<SignBucketApi['createSignedUrls']>>;
  try {
    res = await bucket.createSignedUrls([...paths], ITEM_IMAGE_SIGNED_URL_SECONDS);
  } catch (e) {
    throw toAppError(e);
  }
  if (res.error) throw toAppError(res.error);
  for (const r of res.data ?? []) {
    if (r.path && r.signedUrl && !r.error) out.set(r.path, r.signedUrl);
  }
  return out;
}

/** 一覧の画像の URL（useItemImageUrls の返り値。ItemImage に渡す） */
export interface ItemImageUrls {
  /** path → 署名つき URL（作れなかった path は入らない） */
  urls: ReadonlyMap<string, string>;
  /** まだ作っている（画像のある行は読み込み中の枠を出す） */
  pending: boolean;
  /** 読み込みに失敗した。URL が古ければ（9 分より前に作った）作り直す。作り直すなら true */
  reportError: () => boolean;
}

const NO_URLS: ReadonlyMap<string, string> = new Map();

/**
 * 一覧の画像の署名つき URL をまとめて作る（path を並べて重なりを除き、createSignedUrls を1回。キーは path の並び）。
 * URL はメモリーのキャッシュにだけ持ち（9 分で古くなり、10 分で捨てる）、窓に戻ったときには作り直さない。
 *
 * @example
 * const images = useItemImageUrls(rows.map((r) => paths.get(r.id)));
 * <ItemImage name={r.name} path={paths.get(r.id)} images={images} />
 */
export function useItemImageUrls(paths: readonly (string | null | undefined)[]): ItemImageUrls {
  const joined = [...new Set(paths.filter((p): p is string => typeof p === 'string' && p !== ''))].sort().join('\n');
  const list = useMemo(() => (joined === '' ? [] : joined.split('\n')), [joined]);
  const q = useQuery({
    queryKey: itemImageKeys.urls(list),
    queryFn: () => signItemImagePaths(list),
    enabled: list.length > 0,
    staleTime: ITEM_IMAGE_URL_REFRESH_MS,
    gcTime: ITEM_IMAGE_SIGNED_URL_SECONDS * 1000,
    refetchOnWindowFocus: false,
    refetchOnReconnect: false,
    retry: 1,
  });
  const { dataUpdatedAt, refetch, isFetching } = q;
  const reportError = useCallback(() => {
    if (isFetching || dataUpdatedAt === 0 || Date.now() - dataUpdatedAt < ITEM_IMAGE_URL_REFRESH_MS) return false;
    void refetch();
    return true;
  }, [dataUpdatedAt, isFetching, refetch]);
  const urls = q.data ?? NO_URLS;
  const pending = list.length > 0 && q.isPending;
  return useMemo(() => ({ urls, pending, reportError }), [urls, pending, reportError]);
}

/** 送る・外すの結果（失敗なら画面に出す文言） */
export type ItemImageWriteResult = { ok: true } | { ok: false; message: string };

/** 送る部品を読めなかった（通信が切れた） */
const LOAD_FAILED_MESSAGE = '通信できませんでした。電波の良い所でもう一度';

async function loadUpload() {
  return import('@/lib/item-images/upload');
}

/**
 * 写真をその行の画像にする（送る部品は押したときに動的 import で読む）。終わったら（失敗でも）その種類の path と行の一覧を読み直す。
 * opts.imageId は送り直しの id（ダイアログが保つ。04「品目の画像の共通の部品」）。
 *
 * @example
 * const r = await sendItemImage(queryClient, 'count_item', id, file);
 * if (!r.ok) setError(r.message);
 */
export async function sendItemImage(
  queryClient: QueryClient,
  kind: ItemImageKind,
  targetId: string,
  file: Blob,
  opts: { imageId?: string } = {},
): Promise<ItemImageWriteResult> {
  let mod: Awaited<ReturnType<typeof loadUpload>>;
  try {
    mod = await loadUpload();
  } catch {
    return { ok: false, message: LOAD_FAILED_MESSAGE };
  }
  try {
    await mod.attachItemImage(kind, targetId, file, opts.imageId ? { imageId: opts.imageId } : {});
    return { ok: true };
  } catch (e) {
    return { ok: false, message: e instanceof mod.ItemImageError ? e.message : mod.itemImageErrorMessage('set', e) };
  } finally {
    void invalidateItemImagePaths(queryClient, kind);
  }
}

/** その行の画像を外す（set_item_image(…, null) → 前の物を消す）。終わったら（失敗でも）その種類の path を読み直す */
export async function removeItemImage(queryClient: QueryClient, kind: ItemImageKind, targetId: string): Promise<ItemImageWriteResult> {
  let mod: Awaited<ReturnType<typeof loadUpload>>;
  try {
    mod = await loadUpload();
  } catch {
    return { ok: false, message: LOAD_FAILED_MESSAGE };
  }
  try {
    await mod.detachItemImage(kind, targetId);
    return { ok: true };
  } catch (e) {
    return { ok: false, message: e instanceof mod.ItemImageError ? e.message : mod.itemImageErrorMessage('set', e) };
  } finally {
    void invalidateItemImagePaths(queryClient, kind);
  }
}

/**
 * 消した行（マスタ設定の備品の削除）のフォルダの物を Storage から片付ける（送る部品を動的 import。失敗しても投げない・知らせない。
 * 02「品目の画像」）
 */
export async function removeDeletedItemImages(kind: ItemImageKind, targetId: string): Promise<void> {
  try {
    const mod = await loadUpload();
    await mod.removeItemImageFolder(kind, targetId);
  } catch {
    // どの行にも使われていない物として残るだけ
  }
}
