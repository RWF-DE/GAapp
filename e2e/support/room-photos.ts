// 現状復帰の写真（T25。D-63）の E2E・スクリーンショットが使う補助：API（publishable キーとアクセストークン。画面と同じ道）で予約 →
// Storage へ上げる → 写真の行にする、Storage API で物を一覧する・消す、テストの年度の片付け。
// e2e/t25-room-photos.spec.ts・e2e/shots/T25.shots.ts・e2e/setup/global.setup.ts。
// Storage の物（storage.objects の行）は SQL では消さない（`storage.allow_delete_query` を立てない）。消すのは Storage API の remove で、
// 消せるのは「その年度の総務で、年度が終了でなく、どの写真の行にも使われていない物」だけ（delete のポリシー）。片付けは提出物
// （removeDocumentObjects）と同じ形：写真の行と予約の行を SQL で消し（物はどの行にも使われていない物になる）、年度を終了でない状態に
// 戻してから、使い捨てのユーザーにその年度の管理者のロールを付けて Storage API で消す。年度を消す前に呼ぶ（年度を先に消すと、その年度の
// フォルダは誰の範囲にも入らず、Storage API で消せない）。テストの写真は makePhoto（canvas。実物の写真・個人名なし）で作る。
import { randomUUID } from 'node:crypto';
import { SUPABASE_PUBLISHABLE_KEY, SUPABASE_URL } from '../helpers';
import { createUser, sql, type Scenario } from './db';
import { apiRpc, apiToken, type ApiUser } from './documents';
import { likePrefix } from './like';

/** bucket の名前（0024 が作る非公開の bucket） */
export const ROOM_PHOTOS_BUCKET = 'room-photos';

const authHeaders = (token: string): Record<string, string> => ({ apikey: SUPABASE_PUBLISHABLE_KEY, Authorization: `Bearer ${token}` });

/**
 * API で写真を足す（画面と同じ道：reserve_room_photo → 返った path へ upload〔x-upsert: false〕→ add_room_photo）。写真の行の
 * id と path を返す。撮影の準備と、テストの前提（前の年度の写真など）を作るのに使う。
 */
export async function addRoomPhotoAs(
  user: ApiUser,
  o: { yearId: string; roomId: string; jpeg: Buffer; memo?: string },
): Promise<{ id: string; objectPath: string }> {
  const token = await apiToken(user);
  const id = randomUUID();
  const reserved = await apiRpc<{ object_path: string }>(token, 'reserve_room_photo', {
    p_year_id: o.yearId,
    p_room_id: o.roomId,
    p_photo_id: id,
    p_content_type: 'image/jpeg',
  });
  if (reserved.error || !reserved.data) throw new Error(`予約できません：${JSON.stringify(reserved.error)}`);
  const objectPath = reserved.data.object_path;
  const up = await fetch(`${SUPABASE_URL}/storage/v1/object/${ROOM_PHOTOS_BUCKET}/${objectPath}`, {
    method: 'POST',
    headers: { ...authHeaders(token), 'Content-Type': 'image/jpeg', 'x-upsert': 'false' },
    body: new Uint8Array(o.jpeg),
  });
  if (!up.ok) throw new Error(`上げられません（${up.status}）`);
  const added = await apiRpc(token, 'add_room_photo', { p_photo_id: id, p_memo: o.memo ?? '' });
  if (added.error) throw new Error(`写真の行にできません：${JSON.stringify(added.error)}`);
  return { id, objectPath };
}

/** その年度・場所の写真の行（並びの順。SQL で読むだけ） */
export async function roomPhotoRows(yearId: string, roomId: string): Promise<{ id: string; object_path: string; memo: string }[]> {
  return sql<{ id: string; object_path: string; memo: string }>(
    'select id, object_path, memo from public.room_photos where year_id = $1 and room_id = $2 order by sort_order, created_at, id',
    [yearId, roomId],
  );
}

/** bucket room-photos の、その path の物があるか（SQL で読むだけ） */
export async function roomPhotoObjectExists(objectPath: string): Promise<boolean> {
  const [r] = await sql<{ n: number }>('select count(*)::int as n from storage.objects where bucket_id = $1 and name = $2', [
    ROOM_PHOTOS_BUCKET,
    objectPath,
  ]);
  return (r?.n ?? 0) > 0;
}

/** 届いた物の metadata（形と大きさ。SQL で読むだけ。物がなければ null） */
export async function roomPhotoMetaOf(objectPath: string): Promise<{ mimetype: string; size: number } | null> {
  const [r] = await sql<{ mimetype: string; size: string }>(
    `select metadata ->> 'mimetype' as mimetype, metadata ->> 'size' as size from storage.objects where bucket_id = $1 and name = $2`,
    [ROOM_PHOTOS_BUCKET, objectPath],
  );
  return r ? { mimetype: r.mimetype, size: Number(r.size) } : null;
}

/**
 * Storage API でそのフォルダ（`<year_id>/<room_id>`）の物の path を一覧する（POST /storage/v1/object/list/room-photos。select の
 * ポリシーで、その年度〔か次の年度〕を見られる人だけが読める）。
 */
export async function storageListRoomPhotos(token: string, folder: string): Promise<string[]> {
  const res = await fetch(`${SUPABASE_URL}/storage/v1/object/list/${ROOM_PHOTOS_BUCKET}`, {
    method: 'POST',
    headers: { ...authHeaders(token), 'Content-Type': 'application/json' },
    body: JSON.stringify({ prefix: folder, limit: 100, offset: 0 }),
  });
  if (!res.ok) throw new Error(`Storage の一覧を読めません（${res.status}）`);
  const rows = (await res.json()) as { name: string; id: string | null }[];
  return rows.filter((r) => r.id !== null).map((r) => `${folder}/${r.name}`);
}

/** Storage API で消す（DELETE /storage/v1/object/room-photos。消せた物の path を返す） */
async function storageRemoveRoomPhotos(token: string, paths: readonly string[]): Promise<string[]> {
  const removed: string[] = [];
  for (let k = 0; k < paths.length; k += 100) {
    const res = await fetch(`${SUPABASE_URL}/storage/v1/object/${ROOM_PHOTOS_BUCKET}`, {
      method: 'DELETE',
      headers: { ...authHeaders(token), 'Content-Type': 'application/json' },
      body: JSON.stringify({ prefixes: paths.slice(k, k + 100) }),
    });
    if (!res.ok) throw new Error(`Storage の物を消せません（${res.status}）`);
    for (const o of ((await res.json()) as { name: string }[]) ?? []) removed.push(o.name);
  }
  return removed;
}

async function objectsOfYears(yearIds: readonly string[]): Promise<string[]> {
  return (
    await sql<{ name: string }>(`select name from storage.objects where bucket_id = $1 and split_part(name, '/', 1) = any($2::text[])`, [
      ROOM_PHOTOS_BUCKET,
      [...yearIds],
    ])
  ).map((r) => r.name);
}

/**
 * その年度のフォルダの写真の物を Storage API の remove で消し、消した数を返す（年度を消す前に呼ぶ）：
 * 1. 写真の行と予約の行（DB の行）を SQL で消す。物は「どの写真の行にも使われていない物」になる。
 * 2. 終了の年度は終了でない状態に戻す（delete のポリシーは終了の年度の物を消させない。年度はこの後に消す）。
 * 3. 使い捨てのユーザー（e2e-photo-cleanup-…@example.test）にその年度の管理者のロールを付け、publishable キーでログインして remove。
 *    ユーザーは最後に消す（ロールも連鎖で消える）。
 * 4. 残っていれば例外。
 */
export async function removeRoomPhotoObjects(yearIds: readonly string[]): Promise<number> {
  if (yearIds.length === 0) return 0;
  await sql('delete from public.room_photos where year_id = any($1::uuid[])', [yearIds]);
  await sql('delete from public.room_photo_uploads where year_id = any($1::uuid[])', [yearIds]);
  const names = await objectsOfYears(yearIds);
  if (names.length === 0) return 0;
  await sql(`update public.years set status = 'allocating' where id = any($1::uuid[]) and status = 'closed'`, [yearIds]);
  const u = await createUser({ purpose: 'photo-cleanup', name: 'E2E 片付け' });
  try {
    await sql(
      `insert into public.year_roles (year_id, user_id, role)
       select y.id, $2, 'admin' from public.years y where y.id = any($1::uuid[])
       on conflict (year_id, user_id) do nothing`,
      [yearIds, u.id],
    );
    await storageRemoveRoomPhotos(await apiToken({ email: u.email, password: u.password }), names);
  } finally {
    await u.cleanup();
  }
  const left = await objectsOfYears(yearIds);
  if (left.length > 0) throw new Error(`写真の物を ${left.length} 個消せませんでした（年度 ${yearIds.join('・')}）`);
  return names.length;
}

/** シナリオの年度（と前年度）の写真の物を Storage API で消してから、年度を消す */
export async function cleanupRoomPhotosScenario(s: Scenario): Promise<void> {
  try {
    await removeRoomPhotoObjects([s.yearId, ...(s.prevYearId ? [s.prevYearId] : [])]);
  } finally {
    await s.cleanup();
  }
}

/**
 * db-setup の掃除（前の実行の残り物）：年度名が E2E- で始まる年度のフォルダの写真の物を Storage API で消す（年度を消す
 * cleanupLeftovers の前に呼ぶ）。どの年度にも属さないフォルダの物（年度が先に消えた物）は Storage API では誰も消せないので、数だけを返す。
 */
export async function removeLeftoverRoomPhotoObjects(): Promise<{ removed: number; stray: number }> {
  const years = (await sql<{ id: string }>(`select id from public.years where label like $1 escape '\\'`, [likePrefix('E2E-')])).map((r) => r.id);
  const removed = await removeRoomPhotoObjects(years);
  const [stray] = await sql<{ n: number }>(
    `select count(*)::int as n from storage.objects o
      where o.bucket_id = $1 and not exists (select 1 from public.years y where y.id::text = split_part(o.name, '/', 1))`,
    [ROOM_PHOTOS_BUCKET],
  );
  return { removed, stray: stray?.n ?? 0 };
}
