// 在庫入力（/stock）・在庫一覧（/stocks）・QR の印刷（/stocks/qr）のデータの読み書き（画面の設計 2.1・2.3・3.3・3.4・6 章。T10）。
// 純粋な関数（並べ方・数え方・書けるか・振り分けの合計との比べ方・ほかの人の保存・表の集計・QR の URL）と、
// 読み書きの関数・React Query のフックを置く。純粋な関数は lib/data/stocks.test.ts で確かめる。
import { queryOptions, useQuery } from '@tanstack/react-query';
import { decideAbsoluteSave } from '@/lib/data/absolute-save';
import { fetchAll } from '@/lib/db/fetch-all';
import {
  COLUMNS,
  type CountItemRow,
  type CountStockDbRow,
  type ItemRow,
  type RoomRow,
  type RoomYearRow,
  type StockDbRow,
  type YearStatus,
} from '@/lib/db/types';
import { BASE_PATH } from '@/lib/env';
import { appError, toAppError } from '@/lib/errors';
import { ROOM_KIND_LABELS } from '@/lib/labels';
import { queryKeys } from '@/lib/query';
import { uuidSchema } from '@/lib/schemas/common';
import { callRpc } from '@/lib/rpc';
import { countItemIdOf, countKey, type StockBaseStamps, type StockCounts } from '@/lib/schemas/stock';
import { nameKey } from '@/lib/schemas/settings';
import { getSupabase, type AppSupabaseClient } from '@/lib/supabase/client';
import type { AppRole } from '@/lib/auth/membership';
import { isLead } from '@/lib/auth/roles';
import { fetchRoomStocks, roomStocksOptions, sortByOrder, stockMasterOptions, yearStocksOptions } from './screen-queries';

// ---- 並べ方・場所 ----

// 並べ方と、画面を開くときに読むもの（場所・品目・その年度の使用、部屋・年度の在庫）は lib/data/screen-queries.ts に置く
// （ページを開いたときの先読みで、ルートのレイアウトから読むため。D-45）。ここからも同じ名前で使える。
export {
  compareByOrder,
  fetchRoomStocks,
  fetchStockMaster,
  fetchYearStocks,
  planStockPrefetch,
  roomStocksOptions,
  sortByOrder,
  stockMasterOptions,
  yearStocksOptions,
  type StockMaster,
} from './screen-queries';

// ---- 備品（数えるだけ）の数の読み込み（T22・D-60） ----
// 在庫入力・在庫一覧だけが読むので、ルートのレイアウトから読む screen-queries.ts には置かない（/ の JS を増やさない。D-45・D-51）

/** その部屋の今年の備品（数えるだけ）の数の行（T22・D-60。行のない物は 0 として出す） */
export async function fetchRoomCountStocks(yearId: string, roomId: string, client: AppSupabaseClient = getSupabase()): Promise<CountStockDbRow[]> {
  const res = await client.from('count_stocks').select(COLUMNS.count_stocks).eq('year_id', yearId).eq('room_id', roomId).order('count_item_id');
  if (res.error) throw toAppError(res.error, res.status);
  return (res.data ?? []) as unknown as CountStockDbRow[];
}

/** 今年の備品（数えるだけ）の数の行すべて（在庫一覧の「備品（数えるだけ）」の表） */
export async function fetchYearCountStocks(yearId: string, client: AppSupabaseClient = getSupabase()): Promise<CountStockDbRow[]> {
  return fetchAll<CountStockDbRow>((from, to) =>
    client
      .from('count_stocks')
      .select(COLUMNS.count_stocks)
      .eq('year_id', yearId)
      .order('room_id')
      .order('count_item_id')
      .range(from, to) as unknown as PromiseLike<{ data: CountStockDbRow[] | null; error: unknown; status?: number }>,
  );
}

/** その部屋の今年の備品（数えるだけ）の数のクエリの設定（キーは在庫の 'stocks' の下。在庫の invalidate で一緒に読み直す） */
export function roomCountStocksOptions(yearId: string | null | undefined, roomId: string | null | undefined) {
  return queryOptions({
    queryKey: queryKeys.yearPart(yearId ?? '', 'stocks', 'count-room', roomId ?? ''),
    queryFn: () => fetchRoomCountStocks(yearId!, roomId!),
    enabled: !!yearId && !!roomId,
  });
}

/** 今年の備品（数えるだけ）の数すべてのクエリの設定 */
export function yearCountStocksOptions(yearId: string | null | undefined) {
  return queryOptions({
    queryKey: queryKeys.yearPart(yearId ?? '', 'stocks', 'count-all'),
    queryFn: () => fetchYearCountStocks(yearId!),
    enabled: !!yearId,
  });
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

/** 総務部門員が振り分け中に開いたときの文言（04「在庫入力」） */
export const STAFF_ALLOCATING_MESSAGE = '振り分けが始まったので、在庫は管理者・総務部門長・総務副部門長だけが直せます';

/**
 * 年度の状態とロールで、在庫を書けるか（RLS の can_write_stocks と同じ：部門長以上〔admin・head・deputy_head〕は closed 以外、
 * staff は preparing・requesting。D-48）。部門長以上は振り分け中なら振り分けの合計より少なくなるときに確かめ、確定中なら止める
 * （DB の確定中の守りと同じ条件）。
 */
export function stockAccess(status: YearStatus, role: AppRole | null): StockAccess {
  const ro = (readOnlyMessage: string | null): StockAccess => ({ writable: false, readOnlyMessage, shortfall: 'none' });
  if (isLead(role)) {
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

// ---- ほかの人の保存と、保存の前の読み直し（設計 2.6 の (A)・3.3） ----

export interface OtherSave {
  /** 入力の元の後に自分以外の人が変えた品目（数・数えた記録が変わった、行が増えた・消えた） */
  changedItemIds: string[];
  /** 変えた人と日時（その行のうち counted_at が最も新しいもの。なければ null） */
  by: CountedInfo | null;
}

/** 品目ごとの、入力の元（base）からの変化：読み直した行と、行の記録が変わったか・それが自分以外の人のものか */
function changesFrom(items: readonly Pick<ItemRow, 'id'>[], base: StockBaseStamps, latest: readonly StockDbRow[], userId: string) {
  const after = new Map(latest.map((r) => [r.item_id, r]));
  return items.map((i) => {
    const row = after.get(i.id);
    return {
      itemId: i.id,
      row,
      // updated_at は受け取った文字列のまま比べる。行が増えた・消えたのも変わったとする
      changed: (base[i.id] ?? null) !== (row?.updated_at ?? null),
      // 自分の書いたもの（前に送って応答が届かなかった保存など）は、ほかの人の変更として扱わない。
      // counted_by が null・行が消えた（この画面は消さない）は自分でないとする
      byOther: !row || row.counted_by !== userId,
    };
  });
}

/**
 * 入力の元（base。品目の id → updated_at）の後に、読み直した行（latest）で自分以外の人が変えた品目（部屋の全品目 items のうち）。
 * 変わった（updated_at が違う・行が増えた・消えた）品目のうち、counted_by が自分（userId）でないもの。なければ null。
 */
export function detectOtherSave(
  items: readonly Pick<ItemRow, 'id'>[],
  base: StockBaseStamps,
  latest: readonly StockDbRow[],
  userId: string,
): OtherSave | null {
  const others = changesFrom(items, base, latest, userId).filter((c) => c.changed && c.byOther);
  if (others.length === 0) return null;
  return { changedItemIds: others.map((c) => c.itemId), by: latestCounted(others.flatMap((c) => (c.row ? [c.row] : []))) };
}

export type StockSaveDecision = { kind: 'saved' } | { kind: 'send' } | { kind: 'conflict'; other: OtherSave };

/**
 * 保存の前に読み直した部屋の行（latest）で、送るか・保存されていたか・ほかの人の保存のダイアログを出すかを決める
 * （設計 2.6 の (A) の 2〜4。判定は T09a の decideAbsoluteSave）。input は送る数、base は入力の元の updated_at。
 * - saved：全品目で読み直した数が入力と同じで、どれかの行が入力の元から変わっている（前に送って応答が届かなかった保存が通っていた）
 * - conflict：入力の元から変わった行に、自分以外の人のものがある
 * - send：それ以外（どの行も変わっていなければ、同じ数でも送って数え直しの記録を残す。F1-5）
 */
export function decideStockSave(
  items: readonly Pick<ItemRow, 'id'>[],
  input: StockCounts,
  base: StockBaseStamps,
  latest: readonly StockDbRow[],
  userId: string,
): StockSaveDecision {
  const decision = decideAbsoluteSave<number | null>(
    // byOther を渡すので、base の値は判定に使われない（入力の元は updated_at で持つ）
    changesFrom(items, base, latest, userId).map((c) => ({
      input: input[c.itemId] ?? 0,
      base: null,
      fresh: c.row?.count ?? null,
      changed: c.changed,
      byOther: c.byOther,
    })),
  );
  if (decision !== 'conflict') return { kind: decision };
  return { kind: 'conflict', other: detectOtherSave(items, base, latest, userId)! };
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

/** 場所だけ（QR の印刷。年度によらない） */
export async function fetchRooms(client: AppSupabaseClient = getSupabase()): Promise<RoomRow[]> {
  const rooms = await fetchAll<RoomRow>((from, to) =>
    client.from('rooms').select(COLUMNS.rooms).order('id').range(from, to) as unknown as PromiseLike<{ data: RoomRow[] | null; error: unknown; status?: number }>,
  );
  return sortByOrder(rooms);
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

export interface StockMatrix<T extends { id: string } = ItemRow> {
  items: T[];
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
 * 合計の前年は、今年数えた部屋の前年の数の合計（前年の行がない部屋は 0 とみなす）。数えていない部屋は今年の合計に入らず（0）、
 * 前年の合計からも除く（今年と同じ部屋どうしで比べる）。数えた部屋が1つもなければ合計の差は出さない。
 * prev が null なら前年度がない（差を出さない）。
 */
export function buildStockMatrix<T extends { id: string } = ItemRow>(input: {
  storage: readonly StorageRoom[];
  items: readonly T[];
  stocks: readonly Pick<StockDbRow, 'room_id' | 'item_id' | 'count'>[];
  prev: readonly PreviousStockRow[] | null;
  /**
   * 数の行がなければ 0（備品〔数えるだけ〕の表。T22・D-60）。すべての部屋を数えたものとして扱い、今年・前年の行がない
   * セルを 0 にする（前年は前年度があるときだけ）
   */
  zeroWhenMissing?: boolean;
}): StockMatrix<T> {
  const hasPrev = input.prev !== null;
  const zero = input.zeroWhenMissing === true;
  const now = new Map(input.stocks.map((r) => [`${r.room_id}:${r.item_id}`, r.count]));
  const prev = previousCountMap(input.prev ?? []);
  const countedRooms = new Set(input.stocks.map((r) => r.room_id));
  const rows: MatrixRow[] = input.storage.map((s) => {
    const counted = zero || countedRooms.has(s.room.id);
    const cells: Record<string, MatrixCell> = {};
    let total = 0;
    let prevTotal = 0;
    let anyPrev = false;
    for (const i of input.items) {
      const k = `${s.room.id}:${i.id}`;
      const c = counted ? (now.get(k) ?? (zero ? 0 : null)) : null;
      const p = hasPrev ? (prev.get(k) ?? (zero ? 0 : null)) : null;
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
    const picked = rows.filter(pick);
    // 前年は今年数えた部屋だけを足す（数えている途中に、まだの部屋の前年の数で差が小さく出ないように）。
    // 数えた部屋がなければ比べるものがないので差を出さない
    const comparable = hasPrev && picked.some((r) => r.counted);
    const cells: Record<string, MatrixCell> = {};
    let all = 0;
    let allPrev = 0;
    for (const i of input.items) {
      let sum = 0;
      let sumPrev = 0;
      for (const r of picked) {
        sum += r.cells[i.id]?.count ?? 0;
        if (r.counted) sumPrev += r.cells[i.id]?.prev ?? 0;
      }
      cells[i.id] = cell(sum, comparable ? sumPrev : null);
      all += sum;
      allPrev += sumPrev;
    }
    return { cells, total: cell(all, comparable ? allPrev : null) };
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

// ---- 備品（数えるだけ。T22・D-60。04「在庫入力」「在庫一覧」の備品〔数えるだけ〕） ----
// 在庫入力では、同じ部屋の在庫（stocks）と数（count_stocks）をまとめて1つの入力として扱う。行のキーは、品目は品目の id、
// 備品（数えるだけ）は `c:<count_item_id>`（lib/schemas/stock.ts の countKey）。数の行は在庫の行と同じ形（item_id にキー）に
// 写して、countsFromRows・decideStockSave・detectOtherSave・latestCounted をそのまま使う。

/** 在庫入力の1行（品目か備品〔数えるだけ〕。id は行のキー） */
export interface StockLine {
  id: string;
  name: string;
}

/** 数の行を、在庫の行の形（item_id に `c:` のキー）に写す */
export function countRowAsStock(r: CountStockDbRow): StockDbRow {
  return {
    year_id: r.year_id,
    room_id: r.room_id,
    item_id: countKey(r.count_item_id),
    count: r.count,
    counted_at: r.counted_at,
    counted_by: r.counted_by,
    updated_at: r.updated_at,
  };
}

/** 部屋の在庫の行と数の行を1つの並びにする（在庫が先） */
export function mergeRoomRows(stocks: readonly StockDbRow[], counts: readonly CountStockDbRow[]): StockDbRow[] {
  return [...stocks, ...counts.map(countRowAsStock)];
}

/** mergeRoomRows の逆（在庫の行と数の行に分ける） */
export function splitRoomRows(rows: readonly StockDbRow[]): { stocks: StockDbRow[]; counts: CountStockDbRow[] } {
  const stocks: StockDbRow[] = [];
  const counts: CountStockDbRow[] = [];
  for (const r of rows) {
    const ci = countItemIdOf(r.item_id);
    if (ci === null) stocks.push(r);
    else
      counts.push({
        year_id: r.year_id,
        room_id: r.room_id,
        count_item_id: ci,
        count: r.count,
        counted_at: r.counted_at,
        counted_by: r.counted_by,
        updated_at: r.updated_at,
      });
  }
  return { stocks, counts };
}

/**
 * 在庫入力に出す備品（数えるだけ）（04「在庫入力」）：最初から出す物（always_shown。並び順）と、「その他」（この部屋に今年の
 * 数の行がある物と、この画面で足した物。並び → 名前 → id）。rows は在庫入力の行（mergeRoomRows の形。入力の元と届いた最新の行）。
 * added は足した物の id（一覧にない id は捨てる）。
 */
export function shownCountItems(
  countItems: readonly CountItemRow[],
  rows: readonly (readonly Pick<StockDbRow, 'item_id'>[] | null | undefined)[],
  added: readonly string[],
): { always: CountItemRow[]; others: CountItemRow[] } {
  const withRow = new Set<string>();
  for (const list of rows) for (const r of list ?? []) {
    const ci = countItemIdOf(r.item_id);
    if (ci !== null) withRow.add(ci);
  }
  const addedSet = new Set(added);
  const sorted = sortByOrder(countItems);
  return {
    always: sorted.filter((c) => c.always_shown),
    others: sorted.filter((c) => !c.always_shown && (withRow.has(c.id) || addedSet.has(c.id))),
  };
}

/** 「＋ その他を足す」の選択肢：最初から出す物と、もう出ている物を除き、名前で絞る（全角・半角と大文字小文字を無視した部分一致） */
export function addableCountItems(countItems: readonly CountItemRow[], shownIds: ReadonlySet<string>, filter: string): CountItemRow[] {
  const q = nameKey(filter);
  return sortByOrder(countItems).filter((c) => !c.always_shown && !shownIds.has(c.id) && (q === '' || nameKey(c.name).includes(q)));
}

/** 同じ名前（nameKey で同じ）の物（なければ null。DB の一意の索引と同じ比べ方） */
export function findCountItemByName(countItems: readonly CountItemRow[], name: string): CountItemRow | null {
  const k = nameKey(name);
  return countItems.find((c) => nameKey(c.name) === k) ?? null;
}

/** 部屋の数の upsert の行（出ている行を全部。0 を含む。counted_by・counted_at は DB が入れる） */
export function toCountUpsertRows(yearId: string, roomId: string, countItemIds: readonly string[], counts: StockCounts) {
  return countItemIds.map((id) => ({ year_id: yearId, room_id: roomId, count_item_id: id, count: counts[countKey(id)] ?? 0 }));
}

/**
 * 部屋の備品（数えるだけ）の数を1回の upsert で保存する（在庫の upsert の後に送る。04「在庫入力」）。保存した行を返す。
 * 出ている行がなければ送らない（空の並びを返す）。RLS で書けなければ 42501 のエラー（forbidden）。
 */
export async function saveRoomCountStocks(
  yearId: string,
  roomId: string,
  countItemIds: readonly string[],
  counts: StockCounts,
  client: AppSupabaseClient = getSupabase(),
): Promise<CountStockDbRow[]> {
  const rows = toCountUpsertRows(yearId, roomId, countItemIds, counts);
  if (rows.length === 0) return [];
  const res = await client.from('count_stocks').upsert(rows, { onConflict: 'year_id,room_id,count_item_id' }).select(COLUMNS.count_stocks);
  if (res.error) throw toAppError(res.error, res.status);
  const saved = (res.data ?? []) as unknown as CountStockDbRow[];
  if (saved.length !== rows.length) throw appError('forbidden', 'lock_unchanged', { table: 'count_stocks' });
  return saved;
}

/**
 * 在庫の保存は通り、続けて送った数の保存が失敗した（04「在庫入力」：在庫の保存は決まり、数は保存していない入力として残す）。
 * stocks は保存した在庫の行、cause は数の保存の失敗
 */
export class CountSaveError extends Error {
  constructor(
    readonly stocks: StockDbRow[],
    override readonly cause: unknown,
  ) {
    super('count_stocks の保存に失敗しました');
  }
}

/**
 * 部屋の在庫と数を保存する（在庫の upsert の後に数の upsert。2つのリクエスト）。在庫が失敗すれば数は送らずにその失敗を投げ、
 * 数が失敗すれば CountSaveError を投げる。保存した行を mergeRoomRows の形で返す。
 */
export async function saveRoomLines(
  yearId: string,
  roomId: string,
  items: readonly Pick<ItemRow, 'id'>[],
  countItemIds: readonly string[],
  counts: StockCounts,
  client: AppSupabaseClient = getSupabase(),
): Promise<StockDbRow[]> {
  const stocks = await saveRoomStocks(yearId, roomId, items, counts, client);
  let saved: CountStockDbRow[];
  try {
    saved = await saveRoomCountStocks(yearId, roomId, countItemIds, counts, client);
  } catch (e) {
    throw new CountSaveError(stocks, e);
  }
  return mergeRoomRows(stocks, saved);
}

/**
 * 在庫はもう保存されている（前に送って応答が届かなかった在庫の upsert が DB に入っていた）ときの保存：在庫は送り直さず、
 * 出ている数の行だけを upsert する（savedStocks は送る前に読み直した在庫の行）。数が失敗すれば CountSaveError（在庫は savedStocks）。
 * 在庫の結果が分からない間は数を送っていないので、在庫が自分の保存と分かったら数だけを送る（04「在庫入力」の備品〔数えるだけ〕）
 */
export async function saveRoomCountLines(
  yearId: string,
  roomId: string,
  savedStocks: readonly StockDbRow[],
  countItemIds: readonly string[],
  counts: StockCounts,
  client: AppSupabaseClient = getSupabase(),
): Promise<StockDbRow[]> {
  let saved: CountStockDbRow[];
  try {
    saved = await saveRoomCountStocks(yearId, roomId, countItemIds, counts, client);
  } catch (e) {
    throw new CountSaveError([...savedStocks], e);
  }
  return mergeRoomRows(savedStocks, saved);
}

/**
 * 在庫（品目の行）だけを見て、入力の在庫がもう保存されているか（decideStockSave を品目の行だけで決めて 'saved'）。
 * 在庫の upsert の応答が届かなかった後の「保存」で、在庫を送り直さず数だけを送るかを決める
 */
export function stocksAlreadySaved(
  items: readonly Pick<ItemRow, 'id'>[],
  input: StockCounts,
  base: StockBaseStamps,
  latest: readonly StockDbRow[],
  userId: string,
): boolean {
  return decideStockSave(items, input, base, splitRoomRows(latest).stocks, userId).kind === 'saved';
}

/** 保存の前の読み直し：部屋の在庫と数の行（mergeRoomRows の形） */
export async function fetchRoomLines(yearId: string, roomId: string, client: AppSupabaseClient = getSupabase()): Promise<StockDbRow[]> {
  const [stocks, counts] = await Promise.all([fetchRoomStocks(yearId, roomId, client), fetchRoomCountStocks(yearId, roomId, client)]);
  return mergeRoomRows(stocks, counts);
}

/**
 * 備品（数えるだけ）の名前を足して、その id を返す（RPC add_count_item。同じ名前があればその id。04「在庫入力」の「新しい名前で足す」）。
 * 名前は前後の空白を除いて送る（DB は除かずに拒む）。書けなければ forbidden、名前の誤りは invalid_input（field: name）
 */
export async function addCountItem(yearId: string, name: string, client: AppSupabaseClient = getSupabase()): Promise<string> {
  return callRpc('add_count_item', { p_year_id: yearId, p_name: name }, client);
}

export interface PreviousCountStockRow {
  room_id: string;
  count_item_id: string;
  count: number;
}

/** 前年度（複製元）の備品（数えるだけ）の数（RPC previous_year_count_stocks。総務。読み取りだけ。range で分けて読む） */
export async function fetchPreviousYearCountStocks(yearId: string, client: AppSupabaseClient = getSupabase()): Promise<PreviousCountStockRow[]> {
  const id = uuidSchema.safeParse(yearId);
  if (!id.success) throw appError('input', 'client_validation', { field: 'year_id' });
  return fetchAll<PreviousCountStockRow>((from, to) =>
    client
      .rpc('previous_year_count_stocks', { p_year_id: id.data })
      .order('room_id')
      .order('count_item_id')
      .range(from, to) as unknown as PromiseLike<{ data: PreviousCountStockRow[] | null; error: unknown; status?: number }>,
  );
}

/** 前年の数の引き方（在庫と数をまとめる。`${room_id}:${行のキー}` → 数） */
export function previousLineMap(stocks: readonly PreviousStockRow[], counts: readonly PreviousCountStockRow[]): Map<string, number> {
  const m = previousCountMap(stocks);
  for (const r of counts) m.set(`${r.room_id}:${countKey(r.count_item_id)}`, r.count);
  return m;
}

/**
 * 在庫一覧の「備品（数えるだけ）」の表（04「在庫一覧」）：保管場所 × 物。列は最初から出す物と、今年か前年に数がある物
 * （並び → 名前 → id）。セル・合計・前年との差は机椅子の表と同じ形で、数の行がなければ 0。prev が null なら前年度がない。
 */
export function buildCountMatrix(input: {
  storage: readonly StorageRoom[];
  countItems: readonly CountItemRow[];
  counts: readonly CountStockDbRow[];
  prev: readonly PreviousCountStockRow[] | null;
}): StockMatrix<CountItemRow> {
  const used = new Set([...input.counts.map((r) => r.count_item_id), ...(input.prev ?? []).map((r) => r.count_item_id)]);
  const items = sortByOrder(input.countItems).filter((c) => c.always_shown || used.has(c.id));
  return buildStockMatrix<CountItemRow>({
    storage: input.storage,
    items,
    stocks: input.counts.map((r) => ({ room_id: r.room_id, item_id: r.count_item_id, count: r.count })),
    prev: input.prev ? input.prev.map((r) => ({ room_id: r.room_id, item_id: r.count_item_id, count: r.count })) : null,
    zeroWhenMissing: true,
  });
}

// ---- フック ----

/** 場所・品目・その年度の使用 */
export function useStockMaster(yearId: string | null | undefined) {
  return useQuery(stockMasterOptions(yearId));
}

/** 場所だけ（QR の印刷） */
export function useRooms() {
  return useQuery({ queryKey: queryKeys.rooms(), queryFn: () => fetchRooms() });
}

/** その部屋の今年の在庫（キーは `['year', yearId, 'stocks', roomId]`。年度の stocks の invalidate で一緒に読み直す） */
export function useRoomStocks(yearId: string | null | undefined, roomId: string | null | undefined) {
  return useQuery(roomStocksOptions(yearId, roomId));
}

/** 今年の在庫すべて */
export function useYearStocks(yearId: string | null | undefined) {
  return useQuery(yearStocksOptions(yearId));
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

/** その部屋の今年の備品（数えるだけ）の数 */
export function useRoomCountStocks(yearId: string | null | undefined, roomId: string | null | undefined) {
  return useQuery(roomCountStocksOptions(yearId, roomId));
}

/** 今年の備品（数えるだけ）の数すべて */
export function useYearCountStocks(yearId: string | null | undefined) {
  return useQuery(yearCountStocksOptions(yearId));
}

/** 前年の備品（数えるだけ）の数（前年度がなければ読まない） */
export function usePreviousYearCountStocks(yearId: string | null | undefined, prevYearId: string | null | undefined) {
  return useQuery({
    queryKey: queryKeys.yearPart(yearId ?? '', 'previous-year-count-stocks'),
    queryFn: () => fetchPreviousYearCountStocks(yearId!),
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
