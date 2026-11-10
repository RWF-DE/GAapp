// 品目の画像（T23。D-61）の E2E・スクリーンショットが使う補助：テストの中で写真の代わりの JPEG を作る、API（publishable キーと
// アクセストークン。画面と同じ道）で予約 → Storage へ上げる → 行の画像にする・外す、Storage API で物を一覧する・消す。
// e2e/t23-item-images.spec.ts・e2e/serial/t23-item-images.spec.ts・e2e/shots/T23.shots.ts・e2e/setup/global.setup.ts。
// Storage の物（storage.objects の行）は SQL では消さない（`storage.allow_delete_query` を立てない）。消すのは Storage API の remove で、
// 消せるのは「どの行の image_path にも使われていない物」だけ（delete のポリシー）。消すのは seed の管理者（R8 は受付中。終了でない年度の
// 管理者なので items・count-items の両方のフォルダの物を消せる）。行の画像を外すのは set_item_image(…, null)（items は画像だけの変更で
// 振り分けの版を上げない。SQL の update は auth.uid() がないので画像の守りは通るが、items の版を上げてしまうので使わない）。
// テストの写真はテストの中で canvas で作る（個人名・実物の写真なし。EXIF なし）。publishable キー以外の Supabase の鍵は使わない。
import { randomUUID } from 'node:crypto';
import type { Page } from '@playwright/test';
import { SUPABASE_PUBLISHABLE_KEY, SUPABASE_URL } from '../helpers';
import { sql } from './db';
import { apiRpc, apiToken, type ApiUser } from './documents';

/** bucket の名前（0022 が作る非公開の bucket） */
export const ITEM_IMAGES_BUCKET = 'item-images';

/** 画像の対象（reserve_item_image・set_item_image の p_kind） */
export type ItemImageKind = 'item' | 'count_item';

const authHeaders = (token: string): Record<string, string> => ({ apikey: SUPABASE_PUBLISHABLE_KEY, Authorization: `Bearer ${token}` });

/**
 * 写真の代わりの JPEG（ブラウザの canvas で描く。背景の色・図形・ASCII の文字。EXIF なし）。ページは何の画面でもよい。
 * ルートの tsconfig は DOM の型を持たないので、式は文字列で渡す。
 */
export async function makePhoto(page: Page, opts: { color?: string; label?: string; width?: number; height?: number } = {}): Promise<Buffer> {
  const color = opts.color ?? '#0f766e';
  const label = opts.label ?? 'E2E T23';
  if (!/^#[0-9a-f]{6}$/i.test(color)) throw new Error('makePhoto の color は #rrggbb にしてください');
  if (!/^[A-Za-z0-9 ._-]+$/.test(label)) throw new Error('makePhoto の label は ASCII の英数字にしてください');
  const w = Math.round(opts.width ?? 1600);
  const h = Math.round(opts.height ?? 1200);
  const dataUrl = await page.evaluate<string>(
    `(() => {
      const c = document.createElement('canvas');
      c.width = ${w};
      c.height = ${h};
      const g = c.getContext('2d');
      g.fillStyle = '#f5f5f4';
      g.fillRect(0, 0, ${w}, ${h});
      g.fillStyle = '${color}';
      g.fillRect(${Math.round(w * 0.2)}, ${Math.round(h * 0.25)}, ${Math.round(w * 0.6)}, ${Math.round(h * 0.5)});
      g.fillStyle = '#111827';
      g.font = '${Math.round(h / 10)}px sans-serif';
      g.fillText('${label}', ${Math.round(w * 0.22)}, ${Math.round(h * 0.18)});
      return c.toDataURL('image/jpeg', 0.9);
    })()`,
  );
  return Buffer.from(dataUrl.replace(/^data:image\/jpeg;base64,/, ''), 'base64');
}

/** 行の今の image_path（行がなければ例外） */
export async function imagePathOf(kind: ItemImageKind, id: string): Promise<string | null> {
  const table = kind === 'item' ? 'items' : 'count_items';
  const [r] = await sql<{ image_path: string | null }>(`select image_path from public.${table} where id = $1`, [id]);
  if (!r) throw new Error(`${table} に ${id} がありません`);
  return r.image_path;
}

/** 届いた物の metadata（形と大きさ。SQL で読むだけ。物がなければ null） */
export async function objectMetaOf(objectPath: string): Promise<{ mimetype: string; size: number } | null> {
  const [r] = await sql<{ mimetype: string; size: string }>(
    `select metadata ->> 'mimetype' as mimetype, metadata ->> 'size' as size from storage.objects where bucket_id = $1 and name = $2`,
    [ITEM_IMAGES_BUCKET, objectPath],
  );
  return r ? { mimetype: r.mimetype, size: Number(r.size) } : null;
}

/**
 * Storage API でそのフォルダ（`items/<id>` か `count-items/<id>`）の物の path を一覧する（POST /storage/v1/object/list/item-images。
 * select のポリシーで、ロールか団体の所属があれば読める）。
 */
export async function storageListFolder(token: string, folder: string): Promise<string[]> {
  const res = await fetch(`${SUPABASE_URL}/storage/v1/object/list/${ITEM_IMAGES_BUCKET}`, {
    method: 'POST',
    headers: { ...authHeaders(token), 'Content-Type': 'application/json' },
    body: JSON.stringify({ prefix: folder, limit: 100, offset: 0 }),
  });
  if (!res.ok) throw new Error(`Storage の一覧を読めません（${res.status}）`);
  const rows = (await res.json()) as { name: string; id: string | null }[];
  // フォルダの段（id が null）は除く
  return rows.filter((r) => r.id !== null).map((r) => `${folder}/${r.name}`);
}

/** その行のフォルダ（`items/<id>`・`count-items/<id>`） */
export const folderOf = (kind: ItemImageKind, id: string): string => `${kind === 'item' ? 'items' : 'count-items'}/${id}`;

/** Storage API で消す（DELETE /storage/v1/object/item-images。消せた物の path を返す。消せるのはどの行にも使われていない物だけ） */
export async function storageRemoveItemImages(token: string, paths: readonly string[]): Promise<string[]> {
  if (paths.length === 0) return [];
  const removed: string[] = [];
  for (let k = 0; k < paths.length; k += 100) {
    const res = await fetch(`${SUPABASE_URL}/storage/v1/object/${ITEM_IMAGES_BUCKET}`, {
      method: 'DELETE',
      headers: { ...authHeaders(token), 'Content-Type': 'application/json' },
      body: JSON.stringify({ prefixes: paths.slice(k, k + 100) }),
    });
    if (!res.ok) throw new Error(`Storage の物を消せません（${res.status}）`);
    for (const o of ((await res.json()) as { name: string }[]) ?? []) removed.push(o.name);
  }
  return removed;
}

/**
 * API で画像を付ける（画面と同じ道：reserve_item_image → 返った path へ upload〔x-upsert: false〕→ set_item_image）。今の path を返す。
 * 前の画像があれば、その物を Storage API で消す（画面と同じ）。撮影の準備と、テストの前提を作るのに使う。
 */
export async function attachImageAs(user: ApiUser, kind: ItemImageKind, targetId: string, jpeg: Buffer): Promise<string> {
  const token = await apiToken(user);
  const imageId = randomUUID();
  const reserved = await apiRpc<{ object_path: string }>(token, 'reserve_item_image', {
    p_kind: kind,
    p_target_id: targetId,
    p_image_id: imageId,
    p_content_type: 'image/jpeg',
  });
  if (reserved.error || !reserved.data) throw new Error(`予約できません：${JSON.stringify(reserved.error)}`);
  const objectPath = reserved.data.object_path;
  const up = await fetch(`${SUPABASE_URL}/storage/v1/object/${ITEM_IMAGES_BUCKET}/${objectPath}`, {
    method: 'POST',
    headers: { ...authHeaders(token), 'Content-Type': 'image/jpeg', 'x-upsert': 'false' },
    body: new Uint8Array(jpeg),
  });
  if (!up.ok) throw new Error(`上げられません（${up.status}）`);
  const set = await apiRpc<string | null>(token, 'set_item_image', { p_kind: kind, p_target_id: targetId, p_image_id: imageId });
  if (set.error) throw new Error(`行の画像にできません：${JSON.stringify(set.error)}`);
  if (set.data) await storageRemoveItemImages(token, [set.data]);
  return objectPath;
}

/**
 * 行の画像を外し（set_item_image(…, null)。管理者）、そのフォルダの物をすべて Storage API で消す（テストの片付け）。
 * 外した後に残った物があれば例外。
 */
export async function clearImageOf(kind: ItemImageKind, id: string): Promise<void> {
  const token = await apiToken('admin');
  if ((await imagePathOf(kind, id)) !== null) {
    const r = await apiRpc(token, 'set_item_image', { p_kind: kind, p_target_id: id, p_image_id: null });
    if (r.error) throw new Error(`画像を外せません：${JSON.stringify(r.error)}`);
  }
  const folder = folderOf(kind, id);
  await storageRemoveItemImages(token, await storageListFolder(token, folder));
  const left = await storageListFolder(token, folder);
  if (left.length > 0) throw new Error(`Storage の物を ${left.length} 個消せませんでした（${folder}）`);
}

/**
 * 消した行（count_items を消した後など）のフォルダの物を Storage API で消す（どの行にも使われていない物になっているので消せる）。
 */
export async function removeFolderObjects(kind: ItemImageKind, id: string): Promise<void> {
  const token = await apiToken('admin');
  await storageRemoveItemImages(token, await storageListFolder(token, folderOf(kind, id)));
}

/**
 * db-setup の掃除（前の実行の残り物）：E2E- で始まる備品（数えるだけ）の画像を外し（その行は cleanupLeftovers が消す。count_items の
 * 画像は振り分けの版に効かないので、ここは SQL で外してよい。auth.uid() のない書き込みは画像の守りを通る）、bucket item-images の
 * どの行にも使われていない物を Storage API で消す。消した数を返す。
 */
export async function removeLeftoverItemImages(): Promise<number> {
  await sql(`update public.count_items set image_path = null where name like 'E2E-%' and image_path is not null`);
  const orphans = (
    await sql<{ name: string }>(
      `select o.name from storage.objects o
        where o.bucket_id = $1
          and not exists (select 1 from public.items i where i.image_path = o.name)
          and not exists (select 1 from public.count_items c where c.image_path = o.name)`,
      [ITEM_IMAGES_BUCKET],
    )
  ).map((r) => r.name);
  if (orphans.length === 0) return 0;
  return (await storageRemoveItemImages(await apiToken('admin'), orphans)).length;
}
