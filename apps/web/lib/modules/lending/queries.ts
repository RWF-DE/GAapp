// 申請（/request）のテント等のタブと、受け渡し・返却（/lending/records）が読むもの（T21・D-57。04「テント等の貸し出し」、notes/T21.md
// 「画面の約束」2）。読み取りとキーだけの軽いモジュール：画面を開いたときの先読み（lib/data/screen-queries.ts の planRequestPrefetch・
// planLendingRecordsPrefetch。ルートのレイアウトが読む）からも使うので、数え方・画面の部品・lib/data・zod を実行時に import しない。
// どれも要る列だけを並行に読む。版（allocation_version）は使わない（振り分けの入力でない）。
import type { Tables } from '@gaapp/shared';
import { queryOptions } from '@tanstack/react-query';
import { fetchAll, type PageResult } from '@/lib/db/fetch-all';
import { toAppError } from '@/lib/errors';
import { queryKeys } from '@/lib/query';
import { getSupabase, type AppSupabaseClient } from '@/lib/supabase/client';

type Res = { data: unknown; error: unknown; status?: number };

function rowsOf<T>(res: Res): T[] {
  if (res.error) throw toAppError(res.error, res.status);
  return (res.data ?? []) as T[];
}

/** 確定の印の確定の日時（行がない・解除の後は null） */
function confirmedAtOf(res: Res): string | null {
  if (res.error) throw toAppError(res.error, res.status);
  return (res.data as { confirmed_at: string | null } | null)?.confirmed_at ?? null;
}

// ---------------------------------------------------------------- 申請のテント等のタブ

/**
 * タブを出すかを決める備品の列（申請できる区分を含む）と、その団体の割り当て・記録の埋め込み（備品の id だけ。2026-11-01 のリードの
 * 決定：申請できる備品がなくても、割り当てか渡した記録があればタブを出す）。埋め込みの列に count を選ばない（PostgREST の件数の数え方と
 * 取り違えないため。数は絞り〔count > 0・lent_count > 0〕にだけ使う）
 */
export const LENDING_REQUEST_ITEMS_SELECT =
  'id, name, unit, requestable_categories, sort_order, lending_assignments(lending_item_id), lending_records(lending_item_id)';
export type LendingRequestItem = Pick<Tables<'lending_items'>, 'id' | 'name' | 'unit' | 'requestable_categories' | 'sort_order'> & {
  /** その団体にこの備品の割り当て（数が1以上）があり、読める（店長・副店長は確定後だけ RLS が返す） */
  assigned: boolean;
  /** その団体にこの備品を渡した記録（渡した数が1以上）がある */
  lent: boolean;
};

type RequestItemRow = Omit<LendingRequestItem, 'assigned' | 'lent'> & {
  lending_assignments?: unknown[] | null;
  lending_records?: unknown[] | null;
};

/**
 * 年度の備品と、その団体に割り当て・渡した記録があるか（タブを出すか・タブの欄。1本で読む。店長・副店長は代表である年度の備品と、
 * 自団体の記録・確定後の割り当てを RLS で読める）。埋め込みの絞りは埋め込みの行だけを絞る（備品はどれも返る）
 */
export async function fetchLendingRequestItems(yearId: string, groupId: string, client: AppSupabaseClient = getSupabase()): Promise<LendingRequestItem[]> {
  const res = await client
    .from('lending_items')
    .select(LENDING_REQUEST_ITEMS_SELECT)
    .eq('year_id', yearId)
    .eq('lending_assignments.group_id', groupId)
    .gt('lending_assignments.count', 0)
    .eq('lending_records.group_id', groupId)
    .gt('lending_records.lent_count', 0)
    .order('sort_order')
    .order('id');
  return rowsOf<RequestItemRow>(res).map(({ lending_assignments: a, lending_records: r, ...item }) => ({
    ...item,
    assigned: (a?.length ?? 0) > 0,
    lent: (r?.length ?? 0) > 0,
  }));
}

/**
 * 備品のクエリ（キーは `['year', yearId, 'lending', 'request-items', groupId]`。その団体の割り当て・記録を埋め込むので団体ごと）。
 * 申請の画面の読み込みと並行に読む
 */
export function lendingRequestItemsOptions(yearId: string, groupId: string) {
  return queryOptions({
    queryKey: queryKeys.yearPart(yearId, 'lending', 'request-items', groupId),
    queryFn: () => fetchLendingRequestItems(yearId, groupId),
  });
}

/** 申請の行の列（(A) の読み直しで、書いた人と更新日時を比べる） */
export const LENDING_REQUEST_ROW_SELECT = 'group_id, lending_item_id, count, updated_by, updated_at';
export type LendingRequestRow = Pick<Tables<'lending_requests'>, 'group_id' | 'lending_item_id' | 'count' | 'updated_by' | 'updated_at'>;

/** 割り当ての数（団体×備品） */
export type LendingAssignmentCount = Pick<Tables<'lending_assignments'>, 'group_id' | 'lending_item_id' | 'count'>;

/** タブの記録の列（渡した・返った・破損） */
export type LendingRecordCount = Pick<Tables<'lending_records'>, 'group_id' | 'lending_item_id' | 'lent_count' | 'returned_count' | 'damaged_count'>;

/** テント等のタブのデータ（その団体の分だけ） */
export interface LendingRequestTabData {
  requests: LendingRequestRow[];
  /** 割り当ての確定の日時（確定前は null） */
  confirmedAt: string | null;
  /** 割り当て（確定前は RLS が 0 行を返す） */
  assignments: LendingAssignmentCount[];
  records: LendingRecordCount[];
  loadedAt: string;
}

/** その団体の申請を読む（(A) の送る前の読み直し。RLS で自団体〔と総務〕だけ） */
export async function readGroupLendingRequests(groupId: string, client: AppSupabaseClient = getSupabase()): Promise<LendingRequestRow[]> {
  const res = await client.from('lending_requests').select(LENDING_REQUEST_ROW_SELECT).eq('group_id', groupId).order('lending_item_id');
  return rowsOf<LendingRequestRow>(res);
}

/**
 * テント等のタブの読み取りの select（その団体〔groups〕に、申請・割り当て・記録と、年度〔years〕の確定の印を埋め込んで1本で読む。
 * 埋め込みにも RLS が効く：割り当ては確定後だけ、申請と記録は自団体だけ。レビューの T21-R1：前は4本を並行に読み、/request の
 * 机・椅子の読み取りと合わせて Supabase への同時のリクエストが9本になり、HTTP/1.1 の6本の上限で3本が後ろに並んでいた）
 */
export const LENDING_REQUEST_TAB_SELECT =
  'id, lending_requests(group_id, lending_item_id, count, updated_by, updated_at), lending_assignments(group_id, lending_item_id, count), lending_records(group_id, lending_item_id, lent_count, returned_count, damaged_count), years(lending_years(confirmed_at))';

type One<T> = T | T[] | null | undefined;
const oneOf = <T>(v: One<T>): T | null => (Array.isArray(v) ? (v[0] ?? null) : (v ?? null));
const byItem = <T extends { lending_item_id: string }>(rows: readonly T[] | null | undefined): T[] =>
  [...(rows ?? [])].sort((a, b) => (a.lending_item_id < b.lending_item_id ? -1 : a.lending_item_id > b.lending_item_id ? 1 : 0));

type RequestTabGroupRow = {
  id: string;
  lending_requests?: LendingRequestRow[] | null;
  lending_assignments?: LendingAssignmentCount[] | null;
  lending_records?: LendingRecordCount[] | null;
  years?: One<{ lending_years?: One<{ confirmed_at: string | null }> }>;
};

/**
 * テント等のタブを読む（その団体の申請・確定の印・割り当て・記録を、団体に埋め込んで1本で。判断したことの 21：記録は確定の前でも
 * 出すので、割り当て〔確定前は 0 行〕と記録をいつも読む）。団体が読めなければ、どれも空として返す
 */
export async function fetchLendingRequestTab(yearId: string, groupId: string, client: AppSupabaseClient = getSupabase()): Promise<LendingRequestTabData> {
  const res = await client.from('groups').select(LENDING_REQUEST_TAB_SELECT).eq('id', groupId).eq('year_id', yearId).maybeSingle();
  if (res.error) throw toAppError(res.error, res.status);
  const g = res.data as RequestTabGroupRow | null;
  return {
    requests: byItem(g?.lending_requests),
    confirmedAt: oneOf(oneOf(g?.years)?.lending_years)?.confirmed_at ?? null,
    assignments: byItem(g?.lending_assignments),
    records: byItem(g?.lending_records),
    loadedAt: new Date().toISOString(),
  };
}

/** テント等のタブのクエリ（キーは `['year', yearId, 'lending', 'request', groupId]`） */
export function lendingRequestTabOptions(yearId: string, groupId: string) {
  return queryOptions({
    queryKey: queryKeys.yearPart(yearId, 'lending', 'request', groupId),
    queryFn: () => fetchLendingRequestTab(yearId, groupId),
  });
}

// ---------------------------------------------------------------- 受け渡し・返却 /lending/records

/** 団体の列（名前・表示名・別名・区分・並び・使用場所の名前と種類） */
export const LENDING_GROUP_SELECT =
  'id, name, display_name, aliases, category, sort_order, location_room_id, location_room:rooms!location_room_id(name, kind)';

/** 団体（使用場所の名前と種類つき。使用場所がない・読めなければ location は null） */
export interface LendingGroup extends Pick<Tables<'groups'>, 'id' | 'name' | 'display_name' | 'aliases' | 'category' | 'sort_order' | 'location_room_id'> {
  location: Pick<Tables<'rooms'>, 'name' | 'kind'> | null;
}

type GroupWithRoom = Omit<LendingGroup, 'location'> & {
  location_room?: Pick<Tables<'rooms'>, 'name' | 'kind'> | Pick<Tables<'rooms'>, 'name' | 'kind'>[] | null;
};

/** 年度の団体を読む（使用場所の名前と種類を埋め込む。並べ方は画面〔counts.ts の団体の並び〕） */
export async function fetchLendingGroups(yearId: string, client: AppSupabaseClient = getSupabase()): Promise<LendingGroup[]> {
  const rows = await fetchAll<GroupWithRoom>(
    (from, to) =>
      client.from('groups').select(LENDING_GROUP_SELECT).eq('year_id', yearId).order('id').range(from, to) as unknown as PromiseLike<
        PageResult<GroupWithRoom>
      >,
  );
  return rows.map(({ location_room: room, ...g }) => {
    const r = Array.isArray(room) ? room[0] : room;
    return { ...g, location: g.location_room_id && r ? { name: r.name, kind: r.kind } : null };
  });
}

/** 記録の列（受け渡し・返却の画面と (A) の読み直し） */
export const LENDING_RECORD_SELECT = 'group_id, lending_item_id, lent_count, returned_count, damaged_count, note, updated_by, updated_at';
export type LendingRecordRow = Pick<
  Tables<'lending_records'>,
  'group_id' | 'lending_item_id' | 'lent_count' | 'returned_count' | 'damaged_count' | 'note' | 'updated_by' | 'updated_at'
>;

/** 受け渡し・返却の備品の列 */
export type LendingRecordsItem = Pick<Tables<'lending_items'>, 'id' | 'name' | 'unit' | 'sort_order'>;

export interface LendingRecordsData {
  items: LendingRecordsItem[];
  groups: LendingGroup[];
  assignments: LendingAssignmentCount[];
  records: LendingRecordRow[];
  /** 割り当ての確定の日時（確定前は null） */
  confirmedAt: string | null;
  loadedAt: string;
}

/** 団体×備品の表を年度で絞って全部読む */
function readYearPairs<T>(client: AppSupabaseClient, table: 'lending_assignments' | 'lending_records', select: string, yearId: string) {
  return fetchAll<T>(
    (from, to) =>
      client.from(table).select(select).eq('year_id', yearId).order('group_id').order('lending_item_id').range(from, to) as unknown as PromiseLike<
        PageResult<T>
      >,
  );
}

/** 受け渡し・返却の画面を読む（備品・団体・割り当て・記録・確定の印を並行に、要る列だけ） */
export async function fetchLendingRecords(yearId: string, client: AppSupabaseClient = getSupabase()): Promise<LendingRecordsData> {
  const [items, groups, assignments, records, ly] = await Promise.all([
    client.from('lending_items').select('id, name, unit, sort_order').eq('year_id', yearId).order('sort_order').order('id'),
    fetchLendingGroups(yearId, client),
    readYearPairs<LendingAssignmentCount>(client, 'lending_assignments', 'group_id, lending_item_id, count', yearId),
    readYearPairs<LendingRecordRow>(client, 'lending_records', LENDING_RECORD_SELECT, yearId),
    client.from('lending_years').select('year_id, confirmed_at').eq('year_id', yearId).maybeSingle(),
  ]);
  return {
    items: rowsOf<LendingRecordsItem>(items),
    groups,
    assignments,
    records,
    confirmedAt: confirmedAtOf(ly),
    loadedAt: new Date().toISOString(),
  };
}

/** 受け渡し・返却のクエリ（キーは `['year', yearId, 'lending', 'records']`） */
export function lendingRecordsOptions(yearId: string) {
  return queryOptions({
    queryKey: queryKeys.yearPart(yearId, 'lending', 'records'),
    queryFn: () => fetchLendingRecords(yearId),
  });
}

/** その団体の記録を読む（(A) の送る前の読み直し） */
export async function readGroupRecords(yearId: string, groupId: string, client: AppSupabaseClient = getSupabase()): Promise<LendingRecordRow[]> {
  const res = await client
    .from('lending_records')
    .select(LENDING_RECORD_SELECT)
    .eq('year_id', yearId)
    .eq('group_id', groupId)
    .order('lending_item_id');
  return rowsOf<LendingRecordRow>(res);
}
