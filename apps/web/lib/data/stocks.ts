// 在庫入力（/stock）・在庫一覧（/stocks）・QR の印刷（/stocks/qr）のデータの読み書き（画面の設計 2.1・2.3・3.3・3.4・6 章。T10）。
// 純粋な関数（並べ方・数え方・書けるか・振り分けの合計との比べ方・ほかの人の保存・表の集計・QR の URL）と、
// 読み書きの関数・React Query のフックを置く。純粋な関数は lib/data/stocks.test.ts で確かめる。
import { useQuery } from '@tanstack/react-query';
import { fetchAll } from '@/lib/db/fetch-all';
import { COLUMNS, type ItemRow, type RoomRow, type RoomYearRow, type StockDbRow, type YearStatus } from '@/lib/db/types';
import { BASE_PATH } from '@/lib/env';
import { appError, toAppError } from '@/lib/errors';
import { ROOM_KIND_LABELS } from '@/lib/labels';
import { queryKeys } from '@/lib/query';
import { uuidSchema } from '@/lib/schemas/common';
import type { StockCounts } from '@/lib/schemas/stock';
import { getSupabase, type AppSupabaseClient } from '@/lib/supabase/client';
import type { AppRole } from '@/lib/auth/membership';

// ---- 並べ方・場所 ----

/** sort_order → 名前 → id の順（CLAUDE.md の約束。場所・品目の並び） */
export function compareByOrder(a: { sort_order: number; name: string; id: string }, b: { sort_order: number; name: string; id: string }): number {
  return a.sort_order - b.sort_order || a.name.localeCompare(b.name, 'ja') || a.id.localeCompare(b.id);
}

export function sortByOrder<T extends { sort_order: number; name: string; id: string }>(rows: readonly T[]): T[] {
  return [...rows].sort(compareByOrder);
}

/** 保管場所と、その年度の使用（room_years の行がなければ使用可） */
export interface StorageRoom {
  room: RoomRow;
  usable: boolean;
  /** 使用不可の理由のメモ（room_years.note） */
  note: string | null;
}

/** 保管場所（is_storage）を並び順で。使用不可の部屋も含める（数えることはできる。04「在庫入力」） */
export function storageRooms(rooms: readonly RoomRow[], roomYears: readonly RoomYearRow[]): StorageRoom[] {
  const ry = new Map(roomYears.map((r) => [r.room_id, r]));
  return sortByOrder(rooms.filter((r) => r.is_storage)).map((room) => {
    const y = ry.get(room.id);
    const usable = y ? y.usable : true;
    const note = y?.note?.trim() ? y.note.trim() : null;
    return { room, usable, note: usable ? null : note };
  });
}

/** 一覧の見出しにする建物（建物がなければ場所の種類。屋外など） */
export function buildingOf(room: Pick<RoomRow, 'building' | 'kind'>): string {
  const b = room.building?.trim();
  return b ? b : ROOM_KIND_LABELS[room.kind];
}

/** 建物・階の表示（「E2E棟 2階」「屋外」） */
export function placeOf(room: Pick<RoomRow, 'building' | 'kind' | 'floor'>): string {
  const b = buildingOf(room);
  return room.floor === null || room.floor === undefined ? b : `${b} ${room.floor}階`;
}

/** 建物ごとに分ける（見出しの順は並び順で最初に出た順。中の並びはそのまま） */
export function groupByBuilding<T extends { room: Pick<RoomRow, 'building' | 'kind'> }>(list: readonly T[]): { building: string; rooms: T[] }[] {
  const out: { building: string; rooms: T[] }[] = [];
  const index = new Map<string, number>();
  for (const x of list) {
    const b = buildingOf(x.room);
    let i = index.get(b);
    if (i === undefined) {
      i = out.length;
      index.set(b, i);
      out.push({ building: b, rooms: [] });
    }
    out[i]!.rooms.push(x);
  }
  return out;
}

// ---- 数・数えた記録 ----

/** 品目の id → 数（行のない品目は 0） */
export function countsFromRows(items: readonly Pick<ItemRow, 'id'>[], rows: readonly Pick<StockDbRow, 'item_id' | 'count'>[]): StockCounts {
  const byItem = new Map(rows.map((r) => [r.item_id, r.count]));
  return Object.fromEntries(items.map((i) => [i.id, byItem.get(i.id) ?? 0]));
}

/** 2つの数が品目ごとに同じか（items の品目だけを比べ、ないものは 0） */
export function sameCounts(items: readonly Pick<ItemRow, 'id'>[], a: StockCounts, b: StockCounts): boolean {
  return items.every((i) => (a[i.id] ?? 0) === (b[i.id] ?? 0));
}

/** 最後に数えた記録（counted_at が最も新しい行の人と日時）。数えた行がなければ null */
export interface CountedInfo {
  countedAt: string;
  countedBy: string | null;
}

export function latestCounted(rows: readonly Pick<StockDbRow, 'counted_at' | 'counted_by'>[]): CountedInfo | null {
  let best: CountedInfo | null = null;
  let bestMs = -Infinity;
  for (const r of rows) {
    if (!r.counted_at) continue;
    const ms = Date.parse(r.counted_at);
    if (Number.isNaN(ms) || ms <= bestMs) continue;
    bestMs = ms;
    best = { countedAt: r.counted_at, countedBy: r.counted_by };
  }
  return best;
}

/** 部屋ごとの最後に数えた記録（今年の stocks の行がある部屋＝数えた部屋） */
export function countedByRoom(rows: readonly StockDbRow[]): Map<string, CountedInfo | null> {
  const byRoom = new Map<string, StockDbRow[]>();
  for (const r of rows) {
    const list = byRoom.get(r.room_id);
    if (list) list.push(r);
    else byRoom.set(r.room_id, [r]);
  }
  return new Map([...byRoom].map(([room, list]) => [room, latestCounted(list)]));
}

/**
 * まだ数えていない保管場所（W104 と同じ：今年の stocks の行がない保管場所。使用不可を除く）。並び順のまま。
 */
export function uncountedRooms(list: readonly StorageRoom[], countedRoomIds: ReadonlySet<string>): StorageRoom[] {
  return list.filter((s) => s.usable && !countedRoomIds.has(s.room.id));
}

/**
 * 保存の後の「次の部屋へ」：並び順で今の部屋より後の、まだ数えていない保管場所（使用不可を除く）。
 * 後になければ前から探す。今の部屋は除く。なければ null。
 */
export function nextUncountedRoom(list: readonly StorageRoom[], countedRoomIds: ReadonlySet<string>, currentRoomId: string): StorageRoom | null {
  const candidates = uncountedRooms(list, countedRoomIds);
  const pos = list.findIndex((s) => s.room.id === currentRoomId);
  const after = candidates.find((s) => s.room.id !== currentRoomId && list.indexOf(s) > pos);
  return after ?? candidates.find((s) => s.room.id !== currentRoomId) ?? null;
}

// ---- 書けるか（設計 3.3 の表） ----

/** 振り分けの合計より少なくなる品目の扱い：none（見ない）・confirm（保存の前に確かめる）・block（保存できない） */
export type ShortfallMode = 'none' | 'confirm' | 'block';

export interface StockAccess {
  writable: boolean;
  /** 読み取り専用のときの帯の文言（null は ReadOnlyNotice の既定〔状態の文言〕） */
  readOnlyMessage: string | null;
  shortfall: ShortfallMode;
}

/** 部員が振り分け中に開いたときの文言（04「在庫入力」） */
export const STAFF_ALLOCATING_MESSAGE = '振り分けが始まったので、在庫は総務管理者だけが直せます';

/**
 * 年度の状態とロールで、在庫を書けるか（RLS の can_write_stocks と同じ：admin は closed 以外、staff は preparing・requesting）。
 * 管理者は振り分け中なら振り分けの合計より少なくなるときに確かめ、確定中なら止める（DB の確定中の守りと同じ条件）。
 */
export function stockAccess(status: YearStatus, role: AppRole | null): StockAccess {
  const ro = (readOnlyMessage: string | null): StockAccess => ({ writable: false, readOnlyMessage, shortfall: 'none' });
  if (role === 'admin') {
    switch (status) {
      case 'preparing':
      case 'requesting':
        return { writable: true, readOnlyMessage: null, shortfall: 'none' };
      case 'allocating':
        return { writable: true, readOnlyMessage: null, shortfall: 'confirm' };
      case 'confirmed':
        return { writable: true, readOnlyMessage: null, shortfall: 'block' };
      case 'closed':
        return ro(null);
    }
  }
  if (role === 'staff') {
    if (status === 'preparing' || status === 'requesting') return { writable: true, readOnlyMessage: null, shortfall: 'none' };
    if (status === 'allocating') return ro(STAFF_ALLOCATING_MESSAGE);
    return ro(null);
  }
  return ro('この年度の在庫を直す権限がありません');
}

/** 振り分けの合計より少なくなる品目 */
export interface Shortfall {
  itemId: string;
  itemName: string;
  count: number;
  allocated: number;
}

/** 入れた数が、その部屋から振り分けた合計より少なくなる品目（並びは items の順） */
export function shortfalls(items: readonly Pick<ItemRow, 'id' | 'name'>[], counts: StockCounts, allocated: ReadonlyMap<string, number>): Shortfall[] {
  const out: Shortfall[] = [];
  for (const i of items) {
    const a = allocated.get(i.id) ?? 0;
    const c = counts[i.id] ?? 0;
    if (c < a) out.push({ itemId: i.id, itemName: i.name, count: c, allocated: a });
  }
  return out;
}

/** 振り分けの合計の文言（3.3 の表）。振り分け中は確かめ、確定中は止める */
export function shortfallMessage(mode: Exclude<ShortfallMode, 'none'>, list: readonly Shortfall[]): string {
  const what = list.map((s) => `${s.itemName}：入力 ${s.count}、振り分けの合計 ${s.allocated}台`).join('、');
  return mode === 'confirm'
    ? `振り分けの合計より少なくなります（${what}）。保存すると振り分けに在庫超過（E001）が出ます。振り分け画面で直してください`
    : `確定中は振り分けの合計より少なくできません（${what}）。確定を解除してから直してください`;
}

// ---- ほかの人の保存（設計 3.3） ----

export interface OtherSave {
  /** 読み込んだ後に変わった品目（数・数えた記録が変わった、行が増えた・消えた） */
  changedItemIds: string[];
  /** 変えた人と日時（変わった行のうち counted_at が最も新しいもの。なければ null） */
  by: CountedInfo | null;
}

/**
 * 読み込んだときの行（loaded）と保存の直前に読み直した行（latest）を比べる。updated_at（受け取った文字列のまま）が
 * 違う・行が増えた・消えた品目があれば、ほかの人が保存している。なければ null。
 */
export function detectOtherSave(loaded: readonly Pick<StockDbRow, 'item_id' | 'updated_at'>[], latest: readonly StockDbRow[]): OtherSave | null {
  const before = new Map(loaded.map((r) => [r.item_id, r]));
  const after = new Map(latest.map((r) => [r.item_id, r]));
  const changed: string[] = [];
  const changedRows: StockDbRow[] = [];
  for (const [id, r] of after) {
    const b = before.get(id);
    if (!b || b.updated_at !== r.updated_at) {
      changed.push(id);
      changedRows.push(r);
    }
  }
  for (const id of before.keys()) if (!after.has(id)) changed.push(id);
  if (changed.length === 0) return null;
  return { changedItemIds: changed, by: latestCounted(changedRows) };
}

// ---- 保存 ----

/** 部屋の全品目（0 を含む）の upsert の行。year_id・room_id・item_id・count だけ（counted_by・counted_at は DB が入れる。D-10） */
export function toUpsertRows(yearId: string, roomId: string, items: readonly Pick<ItemRow, 'id'>[], counts: StockCounts) {
  return items.map((i) => ({ year_id: yearId, room_id: roomId, item_id: i.id, count: counts[i.id] ?? 0 }));
}

/**
 * 部屋の全品目を1回の upsert で保存する（設計 2.3・3.3。同じ数でも数え直した記録が残る）。保存した行を返す。
 * RLS で書けなければ 42501 のエラー（forbidden）、確定中に振り分けの合計より少なくすると invalid_state（E001）になる。
 */
export async function saveRoomStocks(
  yearId: string,
  roomId: string,
  items: readonly Pick<ItemRow, 'id'>[],
  counts: StockCounts,
  client: AppSupabaseClient = getSupabase(),
): Promise<StockDbRow[]> {
  const rows = toUpsertRows(yearId, roomId, items, counts);
  const res = await client.from('stocks').upsert(rows, { onConflict: 'year_id,room_id,item_id' }).select(COLUMNS.stocks);
  if (res.error) throw toAppError(res.error, res.status);
  const saved = (res.data ?? []) as unknown as StockDbRow[];
  // 書けなかった行が黙って落ちることはない（upsert の RLS の拒否はエラーになる）が、念のため数を確かめる
  if (saved.length !== rows.length) throw appError('forbidden', 'lock_unchanged', { table: 'stocks' });
  return saved;
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

/** 場所だけ（QR の印刷。年度によらない） */
export async function fetchRooms(client: AppSupabaseClient = getSupabase()): Promise<RoomRow[]> {
  const rooms = await fetchAll<RoomRow>((from, to) =>
    client.from('rooms').select(COLUMNS.rooms).order('id').range(from, to) as unknown as PromiseLike<{ data: RoomRow[] | null; error: unknown; status?: number }>,
  );
  return sortByOrder(rooms);
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

export interface PreviousStockRow {
  room_id: string;
  item_id: string;
  count: number;
}

/**
 * 前年度（複製元）の在庫の数（RPC previous_year_stocks。admin・staff。読み取りだけ）。年度ごとに1回読み、画面で部屋に絞る。
 * RPC の結果も PostgREST の max_rows（1000）で切れうるので、range で分けて読む。
 */
export async function fetchPreviousYearStocks(yearId: string, client: AppSupabaseClient = getSupabase()): Promise<PreviousStockRow[]> {
  const id = uuidSchema.safeParse(yearId);
  if (!id.success) throw appError('input', 'client_validation', { field: 'year_id' });
  return fetchAll<PreviousStockRow>((from, to) =>
    client
      .rpc('previous_year_stocks', { p_year_id: id.data })
      .order('room_id')
      .order('item_id')
      .range(from, to) as unknown as PromiseLike<{ data: PreviousStockRow[] | null; error: unknown; status?: number }>,
  );
}

/** 前年の数の引き方（`${room_id}:${item_id}` → 数） */
export function previousCountMap(rows: readonly PreviousStockRow[]): Map<string, number> {
  return new Map(rows.map((r) => [`${r.room_id}:${r.item_id}`, r.count]));
}

/**
 * その部屋から振り分けた合計（品目ごと）。DB の確定中の守り（tg_stocks_guard）と同じく allocations を数える
 * （v_remaining は使用不可の部屋と在庫の行のない品目を含まないので使わない）。admin が振り分け中・確定中に保存する前だけ読む。
 */
export async function fetchRoomAllocated(yearId: string, roomId: string, client: AppSupabaseClient = getSupabase()): Promise<Map<string, number>> {
  const rows = await fetchAll<{ id: string; item_id: string; count: number }>((from, to) =>
    client
      .from('allocations')
      .select('id, item_id, count')
      .eq('year_id', yearId)
      .eq('source_room_id', roomId)
      .order('id')
      .range(from, to) as unknown as PromiseLike<{ data: { id: string; item_id: string; count: number }[] | null; error: unknown; status?: number }>,
  );
  const out = new Map<string, number>();
  for (const r of rows) out.set(r.item_id, (out.get(r.item_id) ?? 0) + r.count);
  return out;
}

/**
 * 数えた人の表示名（profiles。RLS で、自分と、自分が admin・staff の年度にロールのある人だけ読める）。
 * 読めない人は Map に入らない（画面は「名前を表示できません」）。
 */
export async function fetchProfileNames(userIds: readonly string[], client: AppSupabaseClient = getSupabase()): Promise<Map<string, string>> {
  const ids = [...new Set(userIds)].filter((id) => uuidSchema.safeParse(id).success).sort();
  if (ids.length === 0) return new Map();
  const res = await client.from('profiles').select('user_id, display_name').in('user_id', ids);
  if (res.error) throw toAppError(res.error, res.status);
  return new Map((res.data ?? []).map((p) => [p.user_id, p.display_name]));
}

// ---- 表（在庫一覧） ----

export interface MatrixCell {
  /** 今年の数（行がなければ null。数えていない部屋は null） */
  count: number | null;
  /** 前年の数（前年度がない・前年の行がなければ null） */
  prev: number | null;
  /** 前年との差（今年と前年の両方があるときだけ） */
  diff: number | null;
}

export interface MatrixRow {
  storage: StorageRoom;
  /** 今年の stocks の行がある（数えた） */
  counted: boolean;
  cells: Record<string, MatrixCell>;
  total: MatrixCell;
}

export interface MatrixTotals {
  cells: Record<string, MatrixCell>;
  total: MatrixCell;
}

export interface StockMatrix {
  items: ItemRow[];
  rows: MatrixRow[];
  /** 合計（使用不可を除く） */
  usableTotals: MatrixTotals;
  /** 合計（全部） */
  allTotals: MatrixTotals;
  /** 前年度があるか（列に差を出すか） */
  hasPrev: boolean;
}

const cell = (count: number | null, prev: number | null): MatrixCell => ({
  count,
  prev,
  diff: count !== null && prev !== null ? count - prev : null,
});

/**
 * 保管場所 × 品目の表（設計 3.4）。各セルは今年の数と前年との差、行と列の合計。合計は「使用不可を除く」と「全部」。
 * 合計の前年は、同じ部屋の前年の数の合計（前年の行がない部屋は 0 とみなす）。数えていない部屋は今年の合計に入らない（0）。
 * prev が null なら前年度がない（差を出さない）。
 */
export function buildStockMatrix(input: {
  storage: readonly StorageRoom[];
  items: readonly ItemRow[];
  stocks: readonly StockDbRow[];
  prev: readonly PreviousStockRow[] | null;
}): StockMatrix {
  const hasPrev = input.prev !== null;
  const now = new Map(input.stocks.map((r) => [`${r.room_id}:${r.item_id}`, r.count]));
  const prev = previousCountMap(input.prev ?? []);
  const countedRooms = new Set(input.stocks.map((r) => r.room_id));
  const rows: MatrixRow[] = input.storage.map((s) => {
    const counted = countedRooms.has(s.room.id);
    const cells: Record<string, MatrixCell> = {};
    let total = 0;
    let prevTotal = 0;
    let anyPrev = false;
    for (const i of input.items) {
      const k = `${s.room.id}:${i.id}`;
      const c = counted ? (now.get(k) ?? null) : null;
      const p = hasPrev ? (prev.get(k) ?? null) : null;
      cells[i.id] = cell(c, p);
      total += c ?? 0;
      if (p !== null) {
        prevTotal += p;
        anyPrev = true;
      }
    }
    return { storage: s, counted, cells, total: cell(counted ? total : null, hasPrev && anyPrev ? prevTotal : null) };
  });
  const totals = (pick: (r: MatrixRow) => boolean): MatrixTotals => {
    const cells: Record<string, MatrixCell> = {};
    let all = 0;
    let allPrev = 0;
    for (const i of input.items) {
      let sum = 0;
      let sumPrev = 0;
      for (const r of rows) {
        if (!pick(r)) continue;
        sum += r.cells[i.id]?.count ?? 0;
        sumPrev += r.cells[i.id]?.prev ?? 0;
      }
      cells[i.id] = cell(sum, hasPrev ? sumPrev : null);
      all += sum;
      allPrev += sumPrev;
    }
    return { cells, total: cell(all, hasPrev ? allPrev : null) };
  };
  return {
    items: [...input.items],
    rows,
    usableTotals: totals((r) => r.storage.usable),
    allTotals: totals(() => true),
    hasPrev,
  };
}

/** 前年との差の表示（+2・−1・±0） */
export function formatDiff(diff: number): string {
  if (diff > 0) return `+${diff}`;
  if (diff < 0) return `−${Math.abs(diff)}`;
  return '±0';
}

/** セルの文字（「12（+2）」。数えていなければ「まだ」、行がなければ「—」） */
export function formatCell(c: MatrixCell, counted: boolean): string {
  if (!counted) return 'まだ';
  if (c.count === null) return '—';
  return c.diff === null ? String(c.count) : `${c.count}（${formatDiff(c.diff)}）`;
}

// ---- QR の URL（設計 3.4・6 章） ----

/** アプリの中のリンク（AppLink に渡す。basePath と末尾の / は Next.js が付ける） */
export function stockPath(roomId: string): string {
  return `/stock?room=${encodeURIComponent(roomId)}`;
}

/**
 * 部屋に貼る QR の URL：`${origin}${basePath}/stock/?room=<room_id>`（末尾のスラッシュを付けてリダイレクトを挟まない。
 * 年度を入れない。D-31）。origin は `location.origin`（描画の中で読まず、呼ぶ側がブラウザで渡す）。
 */
export function stockUrl(roomId: string, origin: string, basePath: string = BASE_PATH): string {
  const o = origin.replace(/\/+$/, '');
  const b = basePath.trim().replace(/\/+$/, '');
  const prefix = b === '' ? '' : b.startsWith('/') ? b : `/${b}`;
  return `${o}${prefix}/stock/?room=${encodeURIComponent(roomId)}`;
}

// ---- フック ----

/** 場所・品目・その年度の使用 */
export function useStockMaster(yearId: string | null | undefined) {
  return useQuery({
    queryKey: queryKeys.yearPart(yearId ?? '', 'stock-master'),
    queryFn: () => fetchStockMaster(yearId!),
    enabled: !!yearId,
  });
}

/** 場所だけ（QR の印刷） */
export function useRooms() {
  return useQuery({ queryKey: queryKeys.rooms(), queryFn: () => fetchRooms() });
}

/** その部屋の今年の在庫（キーは `['year', yearId, 'stocks', roomId]`。年度の stocks の invalidate で一緒に読み直す） */
export function useRoomStocks(yearId: string | null | undefined, roomId: string | null | undefined) {
  return useQuery({
    queryKey: queryKeys.yearPart(yearId ?? '', 'stocks', 'room', roomId ?? ''),
    queryFn: () => fetchRoomStocks(yearId!, roomId!),
    enabled: !!yearId && !!roomId,
  });
}

/** 今年の在庫すべて */
export function useYearStocks(yearId: string | null | undefined) {
  return useQuery({
    queryKey: queryKeys.yearPart(yearId ?? '', 'stocks', 'all'),
    queryFn: () => fetchYearStocks(yearId!),
    enabled: !!yearId,
  });
}

/** 前年の数（前年度がなければ読まない） */
export function usePreviousYearStocks(yearId: string | null | undefined, prevYearId: string | null | undefined) {
  return useQuery({
    queryKey: queryKeys.yearPart(yearId ?? '', 'previous-year-stocks'),
    queryFn: () => fetchPreviousYearStocks(yearId!),
    enabled: !!yearId && !!prevYearId,
    staleTime: 5 * 60_000,
  });
}

/** 数えた人の表示名 */
export function useProfileNames(yearId: string | null | undefined, userIds: readonly (string | null)[]) {
  const ids = [...new Set(userIds.filter((x): x is string => !!x))].sort();
  return useQuery({
    queryKey: queryKeys.yearPart(yearId ?? '', 'profiles', ids.join(',')),
    queryFn: () => fetchProfileNames(ids),
    enabled: !!yearId && ids.length > 0,
  });
}

/** その部屋から振り分けた合計（管理者が振り分け中・確定中のときだけ。品目ごとの表示と保存の前の確かめ） */
export function useRoomAllocated(yearId: string | null | undefined, roomId: string | null | undefined, enabled: boolean) {
  return useQuery({
    queryKey: queryKeys.yearPart(yearId ?? '', 'allocated', roomId ?? ''),
    queryFn: () => fetchRoomAllocated(yearId!, roomId!),
    enabled: enabled && !!yearId && !!roomId,
  });
}

/** 在庫の書き込みの後に読み直すキー（その年度の在庫と、振り分けのスナップショット〔版が上がる〕） */
export function stockInvalidationKeys(yearId: string) {
  return [queryKeys.yearPart(yearId, 'stocks'), queryKeys.yearPart(yearId, 'allocated'), queryKeys.snapshot(yearId, 'full'), queryKeys.yearVersion(yearId)];
}
