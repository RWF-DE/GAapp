// 画面を開くときに最初に読むもの（/stock?room=・/request・/my。画面の設計 2.1・2.2、D-45。T14 で lib/data/stocks.ts・requests.ts・
// my.ts から移した。各モジュールは同じ名前で re-export する）と、ダッシュボード（/）の欄が読むもの（T16。lib/modules の机椅子の
// クエリと、T17 でお知らせの新着〔lib/modules/notices/latest.ts〕を使う。数え方や要対応・欄の組み立て〔lib/modules/*/portal.ts〕は
// ルートのレイアウトの JS に入れない）。
// ページを開いたときの先読み（lib/boot/early-load.ts）はルートのレイアウト（Providers）から始まり、画面の部品のモジュールは
// 立場が届いて画面を描くまで読まれない。そこで、先読みに要るクエリ（キーと読み方）と、URL と覚えた id から読むものを決める
// 関数（planStockPrefetch など）と表（SCREEN_PREFETCH）をこの軽いモジュールに置き、Providers から読む。
// 画面のフック（useStockMaster など）も同じクエリの設定（stockMasterOptions など）を使うので、先読みしたキャッシュをそのまま使う。
import { queryOptions, type QueryClient } from '@tanstack/react-query';
import { isSoumu } from '@/lib/auth/roles';
import type { PrefetchEntry, RoutePrefetchContext, RoutePrefetcher } from '@/lib/boot/early-load';
import { fetchAll } from '@/lib/db/fetch-all';
import {
  COLUMNS,
  type AllocationDbRow,
  type ConsentDbRow,
  type GroupRow,
  type ItemRow,
  type RequestDbRow,
  type RoomRow,
  type RoomYearRow,
  type StockDbRow,
  type SubmissionRow,
  type YearRow,
} from '@/lib/db/types';
import { appError, toAppError } from '@/lib/errors';
import { furnitureRepOptions } from '@/lib/modules/furniture/rep';
import { furnitureSoumuOptions } from '@/lib/modules/furniture/soumu';
import { noticesLatestOptions } from '@/lib/modules/notices/latest';
import { queryKeys, STALE_TIME_MS } from '@/lib/query';
import { getSupabase, type AppSupabaseClient } from '@/lib/supabase/client';
import { fetchYear, isAllocationFinal, seedYearRows } from './year';

// ---------------------------------------------------------------- 在庫入力 /stock（T10）

/** URL の room の形（UUID。zod の uuid と同じく版 1〜8・variant 8〜b と、nil・max） */
const UUID_PARAM =
  /^(?:[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}|00000000-0000-0000-0000-000000000000|ffffffff-ffff-ffff-ffff-ffffffffffff)$/;

/** sort_order → 名前 → id の順（CLAUDE.md の約束。場所・品目の並び） */
export function compareByOrder(a: { sort_order: number; name: string; id: string }, b: { sort_order: number; name: string; id: string }): number {
  return a.sort_order - b.sort_order || a.name.localeCompare(b.name, 'ja') || a.id.localeCompare(b.id);
}

export function sortByOrder<T extends { sort_order: number; name: string; id: string }>(rows: readonly T[]): T[] {
  return [...rows].sort(compareByOrder);
}

// ---- 読む ----

export interface StockMaster {
  rooms: RoomRow[];
  items: ItemRow[];
  roomYears: RoomYearRow[];
}

/** 場所・品目（年度をまたぐ表）と、その年度の使用（room_years） */
export async function fetchStockMaster(yearId: string, client: AppSupabaseClient = getSupabase()): Promise<StockMaster> {
  const [rooms, items, roomYears] = await Promise.all([
    fetchAll<RoomRow>((from, to) =>
      client.from('rooms').select(COLUMNS.rooms).order('id').range(from, to) as unknown as PromiseLike<{ data: RoomRow[] | null; error: unknown; status?: number }>,
    ),
    fetchAll<ItemRow>((from, to) =>
      client.from('items').select(COLUMNS.items).order('id').range(from, to) as unknown as PromiseLike<{ data: ItemRow[] | null; error: unknown; status?: number }>,
    ),
    fetchAll<RoomYearRow>((from, to) =>
      client
        .from('room_years')
        .select(COLUMNS.room_years)
        .eq('year_id', yearId)
        .order('room_id')
        .range(from, to) as unknown as PromiseLike<{ data: RoomYearRow[] | null; error: unknown; status?: number }>,
    ),
  ]);
  return { rooms: sortByOrder(rooms), items: sortByOrder(items), roomYears };
}

/** その部屋の今年の在庫の行（品目の順） */
export async function fetchRoomStocks(yearId: string, roomId: string, client: AppSupabaseClient = getSupabase()): Promise<StockDbRow[]> {
  const res = await client.from('stocks').select(COLUMNS.stocks).eq('year_id', yearId).eq('room_id', roomId).order('item_id');
  if (res.error) throw toAppError(res.error, res.status);
  return (res.data ?? []) as unknown as StockDbRow[];
}

/** 今年の在庫の行すべて（在庫一覧・場所の一覧の「数えた」） */
export async function fetchYearStocks(yearId: string, client: AppSupabaseClient = getSupabase()): Promise<StockDbRow[]> {
  return fetchAll<StockDbRow>((from, to) =>
    client
      .from('stocks')
      .select(COLUMNS.stocks)
      .eq('year_id', yearId)
      .order('room_id')
      .order('item_id')
      .range(from, to) as unknown as PromiseLike<{ data: StockDbRow[] | null; error: unknown; status?: number }>,
  );
}

/** 場所・品目・その年度の使用のクエリの設定 */
export function stockMasterOptions(yearId: string | null | undefined) {
  return queryOptions({
    queryKey: queryKeys.yearPart(yearId ?? '', 'stock-master'),
    queryFn: () => fetchStockMaster(yearId!),
    enabled: !!yearId,
  });
}

/** その部屋の今年の在庫のクエリの設定 */
export function roomStocksOptions(yearId: string | null | undefined, roomId: string | null | undefined) {
  return queryOptions({
    queryKey: queryKeys.yearPart(yearId ?? '', 'stocks', 'room', roomId ?? ''),
    queryFn: () => fetchRoomStocks(yearId!, roomId!),
    enabled: !!yearId && !!roomId,
  });
}

/** 今年の在庫すべてのクエリの設定 */
export function yearStocksOptions(yearId: string | null | undefined) {
  return queryOptions({
    queryKey: queryKeys.yearPart(yearId ?? '', 'stocks', 'all'),
    queryFn: () => fetchYearStocks(yearId!),
    enabled: !!yearId,
  });
}

/**
 * /stock の先読み（D-45。lib/boot/early-load.ts）：場所・品目・その年度の使用と、`?room=` があればその部屋の在庫、
 * なければ（保管場所の一覧）年度の在庫。形の違う room は読まない（画面が「見つかりません」を出す）。
 */
export function planStockPrefetch(ctx: RoutePrefetchContext): PrefetchEntry[] {
  const raw = ctx.params.get('room');
  const list: PrefetchEntry[] = [{ options: stockMasterOptions(ctx.yearId) }];
  if (raw === null || raw.trim() === '') list.push({ options: yearStocksOptions(ctx.yearId) });
  else {
    // lib/schemas/stock.ts の parseRoomParam と同じ形（前後の空白を外し、小文字の UUID）。zod をルートの JS に入れないために正規表現で見る
    const v = raw.trim().toLowerCase();
    const roomId = UUID_PARAM.test(v) ? v : null;
    if (roomId) list.push({ options: roomStocksOptions(ctx.yearId, roomId) });
  }
  return list;
}

// ---------------------------------------------------------------- 申請 /request（T11）

/** 団体代表の申請の画面のデータ（自団体だけ） */
export interface RepRequestData {
  group: GroupRow;
  items: ItemRow[];
  /** 使用場所の名前（なければ null＝校内に分散） */
  locationName: string | null;
  requests: RequestDbRow[];
  /** 提出の記録（updated_by も読む。裏で届いた行の知らせで、自分の提出をほかの人の変更にしないため） */
  submission: SubmissionState | null;
  loadedAt: string;
}

/**
 * 自団体の申請を読む（RLS で自団体だけ。団体が読めなければ not_found）。使用場所の名前は groups に rooms を埋め込んで
 * 同じ往復で読む（D-45。前は団体を読んでから rooms をもう1回読んでいた。rooms の RLS は埋め込みにも効く）。
 */
export async function fetchRepRequest(groupId: string, client: AppSupabaseClient = getSupabase()): Promise<RepRequestData> {
  const [g, i, r, s] = await Promise.all([
    client.from('groups').select(`${COLUMNS.groups}, location_room:rooms!location_room_id(name)`).eq('id', groupId).maybeSingle(),
    client.from('items').select(COLUMNS.items).order('sort_order').order('id'),
    client.from('requests').select(COLUMNS.requests).eq('group_id', groupId).order('item_id'),
    client.from('request_submissions').select(SUBMISSION_STATE_COLUMNS).eq('group_id', groupId).maybeSingle(),
  ]);
  for (const res of [g, i, r, s]) if (res.error) throw toAppError(res.error, res.status);
  const row = g.data as unknown as (GroupRow & { location_room?: { name: string } | null }) | null;
  if (!row) throw appError('not_found', 'group_missing', { groupId });
  const { location_room: room, ...group } = row;
  const locationName = group.location_room_id ? (room?.name ?? null) : null;
  return {
    group,
    items: (i.data ?? []) as unknown as ItemRow[],
    locationName,
    requests: (r.data ?? []) as unknown as RequestDbRow[],
    submission: (s.data ?? null) as unknown as SubmissionState | null,
    loadedAt: new Date().toISOString(),
  };
}

/**
 * 提出の記録（updated_by で自分の書き込みかを見分ける）。画面のクエリ・申請一覧の表・送る前の読み直しはどれも updated_by を読む
 * （SUBMISSION_STATE_COLUMNS）。updated_by のない記録（キーがない）は、書いた人が分からないものとして扱う。
 */
export type SubmissionState = SubmissionRow & { updated_by?: string | null };

/**
 * 提出の記録を読む列（COLUMNS.request_submissions に updated_by を足したもの。COLUMNS は T09a のファイルなので、T11 の select で足す。
 * notes/T11.md の「T09a への申し送り」）
 */
export const SUBMISSION_STATE_COLUMNS = `${COLUMNS.request_submissions}, updated_by`;

/** 自団体の申請のクエリの設定（キーは `['year', yearId, 'request', groupId]`） */
export function repRequestOptions(yearId: string | null | undefined, groupId: string | null) {
  return queryOptions({
    queryKey: queryKeys.yearPart(yearId ?? '', 'request', groupId ?? ''),
    queryFn: () => fetchRepRequest(groupId!),
    enabled: !!yearId && !!groupId,
  });
}

/**
 * /request の先読み（D-45）：`?group=` が覚えた団体にあればその団体、なければ最初の団体（RequestScreen と同じ選び方）。
 * 覚えた団体がなければ読まない。
 */
export function planRequestPrefetch(ctx: RoutePrefetchContext): PrefetchEntry[] {
  const wanted = ctx.params.get('group');
  const groupId = ctx.groupIds.find((g) => g === wanted) ?? ctx.groupIds[0];
  return groupId ? [{ groupId, options: repRequestOptions(ctx.yearId, groupId) }] : [];
}

// ---------------------------------------------------------------- 自団体の振り分け /my（T13）
// 読む順（D-45。前は年度の行を読み終えてから残りを読んでいた）：
// - 年度の行は毎回読み直し、団体・品目・場所・申請・提出・了承と並行に読む。画面に出す year と、振り分けの行を使うかは、
//   この読み直した年度の行の状態で決める（キャッシュの行は最大 30 秒前で、その間に確定 ⇄ 確定前と変わりうる）。
// - キャッシュに新しい年度の行があり（立場と一緒に読んだもの。無効にされていない・30 秒以内）確定・終了なら、振り分けの行も
//   並行に読み始める（往復を増やさないため）。読み直した年度の行が確定前なら、その振り分けの行は捨てて null にする。
// - キャッシュの行がない・確定前で、読み直した年度の行が確定・終了なら、振り分けの行をその後に読む。
// 確定前は振り分けの行を使わない（T13。確定前は RLS で 0 行になるのを「振り分けがない」と取り違えない）。確定前と分かっていれば
// 読みに行かない。

export interface MyData {
  year: YearRow;
  group: GroupRow;
  items: ItemRow[];
  rooms: RoomRow[];
  requests: RequestDbRow[];
  submission: SubmissionRow | null;
  consents: ConsentDbRow[];
  /** 確定・終了のときだけ読む（確定前は null。RLS で 0 行になるのを「振り分けがない」と取り違えない） */
  allocations: AllocationDbRow[] | null;
  loadedAt: string;
}

type Res = { data: unknown; error: unknown; status?: number };
function rowsOf<T>(res: Res): T[] {
  if (res.error) throw toAppError(res.error, res.status);
  return (res.data ?? []) as T[];
}

/** キャッシュにある新しい年度の行（なければ・無効にされた・古ければ null） */
export function freshYearRow(queryClient: QueryClient, yearId: string, now: number = Date.now()): YearRow | null {
  const st = queryClient.getQueryState<YearRow>(queryKeys.yearRow(yearId));
  if (!st?.data || st.isInvalidated || now - st.dataUpdatedAt >= STALE_TIME_MS) return null;
  return st.data;
}

/**
 * 自団体のデータを読む（年度の行を読み直してほかの表と並行に読み、振り分けの行は読み直した年度の状態で使うかを決める。上の決まり）。
 * queryClient を渡すと、キャッシュの新しい年度の行で振り分けの行を先に読み始めるかを決め、読み直した年度の行をキャッシュに入れる。
 */
export async function loadMyData(
  yearId: string,
  groupId: string,
  client: AppSupabaseClient = getSupabase(),
  queryClient?: QueryClient,
): Promise<MyData> {
  const readAllocations = () =>
    client.from('allocations').select(COLUMNS.allocations).eq('year_id', yearId).eq('group_id', groupId).order('id');
  const known = queryClient ? freshYearRow(queryClient, yearId) : null;
  const startedAt = Date.now();
  const [year, g, i, r, rq, sub, co, early] = await Promise.all([
    fetchYear(yearId, client),
    client.from('groups').select(COLUMNS.groups).eq('id', groupId).eq('year_id', yearId).maybeSingle(),
    client.from('items').select(COLUMNS.items).order('sort_order').order('id'),
    client.from('rooms').select(COLUMNS.rooms).order('sort_order').order('id'),
    client.from('requests').select(COLUMNS.requests).eq('group_id', groupId).order('item_id'),
    client.from('request_submissions').select(COLUMNS.request_submissions).eq('group_id', groupId).maybeSingle(),
    client
      .from('substitution_consents')
      .select(COLUMNS.substitution_consents)
      .eq('group_id', groupId)
      .order('from_item_id')
      .order('to_item_id'),
    known && isAllocationFinal(known.status) ? readAllocations() : null,
  ]);
  // 年度の行の応答が先送り（ページを開いたときに送ったもの）なら、実際に読んだのは startedAt より前（seedYearRows の説明）
  if (queryClient) seedYearRows(queryClient, [year], startedAt);
  // 使うかは読み直した年度の行で決める（キャッシュの行が確定で読み直した行が確定前なら、先に読んだ振り分けの行は捨てる）
  const a: Res | null = isAllocationFinal(year.status) ? (early ?? (await readAllocations())) : null;
  if (g.error) throw toAppError(g.error, g.status);
  if (!g.data) throw appError('not_found', 'group_missing', { groupId });
  if (sub.error) throw toAppError(sub.error, sub.status);
  return {
    year,
    group: g.data as unknown as GroupRow,
    items: rowsOf<ItemRow>(i),
    rooms: rowsOf<RoomRow>(r),
    requests: rowsOf<RequestDbRow>(rq),
    submission: (sub.data ?? null) as SubmissionRow | null,
    consents: rowsOf<ConsentDbRow>(co),
    allocations: a ? rowsOf<AllocationDbRow>(a) : null,
    loadedAt: new Date().toISOString(),
  };
}

/** 自団体のデータのクエリの設定（キーは `['year', yearId, 'my', groupId]`） */
export function myDataOptions(yearId: string | null | undefined, groupId: string | null | undefined) {
  return queryOptions({
    queryKey: queryKeys.yearPart(yearId ?? '', 'my', groupId ?? ''),
    queryFn: ({ client }) => loadMyData(yearId!, groupId!, undefined, client),
    enabled: !!yearId && !!groupId,
  });
}

/** /my の先読み（D-45）：`?group=` が覚えた団体にあればその団体、なければ最初の団体（MyScreen の pickMyGroup と同じ） */
export function planMyPrefetch(ctx: RoutePrefetchContext): PrefetchEntry[] {
  const group = pickMyGroup(
    ctx.groupIds.map((id) => ({ id })),
    ctx.params.get('group'),
  );
  return group ? [{ groupId: group.id, options: myDataOptions(ctx.yearId, group.id) }] : [];
}

/** 団体の選び方（`?group=` が自分の団体ならそれ、なければ最初の団体）。団体がなければ null */
export function pickMyGroup<T extends { id: string }>(groups: readonly T[], param: string | null | undefined): T | null {
  return groups.find((g) => g.id === param) ?? groups[0] ?? null;
}

// ---------------------------------------------------------------- ダッシュボード /（T16）

const sameIds = (a: readonly string[], b: readonly string[]) => a.length === b.length && a.every((id, k) => id === b[k]);

/**
 * / の先読み（D-45・D-51。04「ダッシュボード」の読むもの）：立場の種類ごとに、ダッシュボードの欄が読むクエリと同じもの。
 * - 総務（ロールが総務）：机椅子の軽い読み取り（6つの表。furnitureSoumuOptions。要対応とカードが同じキーを読む）と、
 *   総務内のお知らせの新着（noticesLatestOptions の soumu。総務内のお知らせの欄と同じキー。T17）
 * - 閲覧のみ（ロールが閲覧のみ）：団体あてのお知らせの新着（noticesLatestOptions の viewer。お知らせの欄と同じキー。T17）
 * - 団体代表（その年度で代表を務める団体がある）：自団体の提出と了承（furnitureRepOptions。代表する団体の欄と要対応が同じキーを読む）と、
 *   ロールが閲覧のみでなければ団体あてのお知らせの新着（noticesLatestOptions の rep。閲覧のみも務める人は閲覧のみとして1回だけ読む）
 * 版・振り分けの行・ルール・スナップショットは読まない（/ は版を使わないので、記録・先送りもしてよい。D-33）。
 * 立場が届いて、総務・閲覧のみでなくなった・代表する団体が変わったときは使わない（usable。settleEarlyLoad が消す）。
 *
 * @example
 * planHomePrefetch({ yearId, groupIds: [], role: 'staff', params }) // 机椅子の総務の読み取りと、総務内のお知らせの新着
 */
export function planHomePrefetch(ctx: RoutePrefetchContext): PrefetchEntry[] {
  const list: PrefetchEntry[] = [];
  if (isSoumu(ctx.role)) {
    list.push({ options: furnitureSoumuOptions(ctx.yearId), usable: (m) => isSoumu(m.role) });
    list.push({ options: noticesLatestOptions(ctx.yearId, 'soumu'), usable: (m) => isSoumu(m.role) });
  }
  if (ctx.role === 'viewer') list.push({ options: noticesLatestOptions(ctx.yearId, 'viewer'), usable: (m) => m.role === 'viewer' });
  if (ctx.groupIds.length > 0) {
    const ids = [...ctx.groupIds];
    list.push({ options: furnitureRepOptions(ctx.yearId, ids), usable: (m) => sameIds(m.groups.map((g) => g.id), ids) });
    if (ctx.role !== 'viewer') {
      list.push({
        options: noticesLatestOptions(ctx.yearId, 'rep', ids),
        usable: (m) => m.role !== 'viewer' && sameIds(m.groups.map((g) => g.id), ids),
      });
    }
  }
  return list;
}

// ---------------------------------------------------------------- 先読みの表

/** 画面のパス（basePath と末尾の / を外したもの）→ 先読みするものの決め方（Providers が startEarlyLoad に渡す） */
export const SCREEN_PREFETCH: Readonly<Record<string, RoutePrefetcher>> = {
  '/': planHomePrefetch,
  '/stock': planStockPrefetch,
  '/request': planRequestPrefetch,
  '/my': planMyPrefetch,
};

/**
 * 開いたときのリクエストを覚え、次に開いたときに <head> の script が JS より先に送ってよい画面のパス（lib/boot/early-fetch.ts。
 * 許可リスト）。版を使わない画面（先読みの表と同じ。/・/stock・/request・/my）だけで、振り分けに関わる画面（/furniture・
 * /allocation・/swaps）は入れない（スナップショット〔lib/data/snapshot.ts〕は年度の行〔版〕を読み終えてから残りを読む。D-33）。
 * ダッシュボード（/）は版・振り分けの行を読まないので、T16 で入れた（団体代表の / を 4G で 2 秒以内に開くため。D-45・D-51）
 */
export const EARLY_FETCH_PATHS: readonly string[] = Object.freeze(Object.keys(SCREEN_PREFETCH));
