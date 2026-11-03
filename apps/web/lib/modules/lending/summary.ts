// ダッシュボード（/）のテント等の貸し出しが読むもの（T21・D-57。04「テント等の貸し出し」の「ダッシュボードに出すもの」、notes/T21.md
// 「画面の約束」2）。読み取りとキーだけの軽いモジュール：/ の先読み（lib/data/screen-queries.ts の planHomePrefetch。ルートの
// レイアウトが読む）からも使うので、数え方（counts.ts）・要対応とカードの組み立て（portal.ts）・ダッシュボードの型と関数
// （lib/modules/portal.ts）を実行時に import しない（机椅子の soumu.ts・rep.ts と同じ形）。
// - 総務：確定の印・備品・申請（数が1以上だけ）・割り当て・記録の要る列を、年度で絞って5本並行に読む（判断したことの 3）。
// - 店長・副店長：代表する団体に、割り当て（確定後だけ RLS が返す）と記録を、備品の名前・単位・並びとあわせて埋め込み、1本で読む
//   （団体代表の / の読み取りの数を増やさないよう、2本を1本にした。レビューの T21-R2）。年度の確定の印も埋め込み、割り当ては確定の印が
//   あるときだけ数える（団体の代表を兼ねた管理者には RLS が確定前の割り当ても返すため。タブの直しのレビューの T21-R6。前は確定の印を
//   読まなかった〔判断したことの 15〕）。
// - 閲覧のみ：読まない（年度の行だけで作るカード）。
import type { Tables } from '@gaapp/shared';
import { queryOptions } from '@tanstack/react-query';
import { fetchAll, type PageResult } from '@/lib/db/fetch-all';
import { toAppError } from '@/lib/errors';
import { getSupabase, type AppSupabaseClient } from '@/lib/supabase/client';
import { portalQueryKey } from '../query-key';

/** 総務の読み取りの select（どれも year_id で絞る。申請は count > 0 だけ） */
export const LENDING_SOUMU_SELECT = {
  lending_years: 'year_id, confirmed_at',
  lending_items: 'id, name, unit, stock, sort_order',
  lending_requests: 'group_id, lending_item_id, count',
  lending_assignments: 'group_id, lending_item_id, count',
  lending_records: 'group_id, lending_item_id, lent_count, returned_count',
} as const;

/** 総務の読み取りの結果 */
export interface LendingSoumuRaw {
  /** 割り当ての確定の日時（確定の印の行がないか、解除の後は null） */
  confirmedAt: string | null;
  items: Pick<Tables<'lending_items'>, 'id' | 'name' | 'unit' | 'stock' | 'sort_order'>[];
  /** 数が1以上の申請 */
  requests: Pick<Tables<'lending_requests'>, 'group_id' | 'lending_item_id' | 'count'>[];
  assignments: Pick<Tables<'lending_assignments'>, 'group_id' | 'lending_item_id' | 'count'>[];
  records: Pick<Tables<'lending_records'>, 'group_id' | 'lending_item_id' | 'lent_count' | 'returned_count'>[];
}

type Res = { data: unknown; error: unknown; status?: number };

function rowsOf<T>(res: Res): T[] {
  if (res.error) throw toAppError(res.error, res.status);
  return (res.data ?? []) as T[];
}

/** 団体×備品の表を年度で絞って全部読む（団体・備品の順。1000 行を超えても切れない） */
function readPairs<T>(client: AppSupabaseClient, table: 'lending_requests' | 'lending_assignments' | 'lending_records', select: string, yearId: string, positive = false) {
  return fetchAll<T>((from, to) => {
    let q = client.from(table).select(select).eq('year_id', yearId);
    if (positive) q = q.gt('count', 0);
    return q.order('group_id').order('lending_item_id').range(from, to) as unknown as PromiseLike<PageResult<T>>;
  });
}

/** 総務のダッシュボードの行を読む（5本を並行に。年度の行〔版〕を待たない）。読めなければ AppError を投げる */
export async function loadLendingSoumu(yearId: string, client: AppSupabaseClient = getSupabase()): Promise<LendingSoumuRaw> {
  const S = LENDING_SOUMU_SELECT;
  const [ly, items, requests, assignments, records] = await Promise.all([
    client.from('lending_years').select(S.lending_years).eq('year_id', yearId).maybeSingle(),
    client.from('lending_items').select(S.lending_items).eq('year_id', yearId).order('sort_order').order('id'),
    readPairs<LendingSoumuRaw['requests'][number]>(client, 'lending_requests', S.lending_requests, yearId, true),
    readPairs<LendingSoumuRaw['assignments'][number]>(client, 'lending_assignments', S.lending_assignments, yearId),
    readPairs<LendingSoumuRaw['records'][number]>(client, 'lending_records', S.lending_records, yearId),
  ]);
  if (ly.error) throw toAppError(ly.error, ly.status);
  const year = ly.data as { confirmed_at: string | null } | null;
  return {
    confirmedAt: year?.confirmed_at ?? null,
    items: rowsOf<LendingSoumuRaw['items'][number]>(items).map(({ id, name, unit, stock, sort_order }) => ({ id, name, unit, stock, sort_order })),
    requests: requests.map(({ group_id, lending_item_id, count }) => ({ group_id, lending_item_id, count })),
    assignments: assignments.map(({ group_id, lending_item_id, count }) => ({ group_id, lending_item_id, count })),
    records: records.map(({ group_id, lending_item_id, lent_count, returned_count }) => ({ group_id, lending_item_id, lent_count, returned_count })),
  };
}

/**
 * 総務のテント等のクエリ（キーは `['year', yearId, 'portal', 'lending', 'soumu']`）。ダッシュボードの欄（portal.ts の
 * lendingPortalProvider が select を足す）と、/ の先読み（planHomePrefetch）が同じキャッシュを読む。
 */
export function lendingSoumuOptions(yearId: string) {
  return queryOptions({
    queryKey: portalQueryKey(yearId, 'lending', 'soumu'),
    queryFn: () => loadLendingSoumu(yearId),
  });
}

/**
 * 店長・副店長の読み取りの select（代表する団体〔groups〕に、割り当てと記録と、それぞれの備品の名前・単位・並びと、年度〔years〕の
 * 確定の印を埋め込む。1本で読む）。埋め込みにも RLS が効く（割り当ては店長・副店長には確定後だけ、記録は自団体だけ。団体は自分が代表する
 * 団体だけ）。確定の印は、団体の代表を兼ねた管理者に RLS が返す確定前の割り当てを数えないため（タブの直しのレビューの T21-R6）
 */
export const LENDING_REP_SELECT =
  'id, lending_assignments(lending_item_id, count, lending_items(name, unit, sort_order)), lending_records(lending_item_id, lent_count, returned_count, lending_items(name, unit, sort_order)), years(lending_years(confirmed_at))';

/** 埋め込んだ備品（読めなければ null） */
export type LendingRepItem = Pick<Tables<'lending_items'>, 'name' | 'unit' | 'sort_order'>;

/**
 * 店長・副店長の読み取りの結果（割り当ては確定後のものだけ：店長・副店長には RLS が確定後だけ返し、団体の代表を兼ねた管理者の分は
 * 確定の印がなければ落とす。記録は確定の前でも。団体 → 備品の id の順）
 */
export interface LendingRepRaw {
  assignments: (Pick<Tables<'lending_assignments'>, 'group_id' | 'lending_item_id' | 'count'> & { item: LendingRepItem | null })[];
  records: (Pick<Tables<'lending_records'>, 'group_id' | 'lending_item_id' | 'lent_count' | 'returned_count'> & { item: LendingRepItem | null })[];
}

type EmbeddedItem = { lending_items?: LendingRepItem | LendingRepItem[] | null };
type One<T> = T | T[] | null | undefined;
const oneOf = <T>(v: One<T>): T | null => (Array.isArray(v) ? (v[0] ?? null) : (v ?? null));

type RepGroupRow = {
  id: string;
  lending_assignments?: (Pick<Tables<'lending_assignments'>, 'lending_item_id' | 'count'> & EmbeddedItem)[] | null;
  lending_records?: (Pick<Tables<'lending_records'>, 'lending_item_id' | 'lent_count' | 'returned_count'> & EmbeddedItem)[] | null;
  /** 年度に埋め込んだ確定の印（`years(lending_years(confirmed_at))`。多対一と一対一なのでオブジェクトだが、配列でも最初のものを読む） */
  years?: One<{ lending_years?: One<{ confirmed_at: string | null }> }>;
};

/**
 * その団体の年度の割り当てが確定しているか（確定の印の行がない・解除の後・年度が読めなければ偽。queries.ts の申請のタブの読み取りと
 * 同じ読み方。ここから queries.ts を import しない：/ のプロバイダの読み取りに、申請のタブ・受け渡し・返却の読み取りを入れない）
 */
const yearConfirmed = (g: RepGroupRow): boolean => !!oneOf(oneOf(g.years)?.lending_years)?.confirmed_at;

/** 埋め込みの備品（多対一なので object。配列で返ったときは最初のもの） */
function embeddedItem(v: LendingRepItem | LendingRepItem[] | null | undefined): LendingRepItem | null {
  const it = Array.isArray(v) ? v[0] : v;
  return it ? { name: it.name, unit: it.unit, sort_order: it.sort_order } : null;
}

const byGroupAndItem = (a: { group_id: string; lending_item_id: string }, b: { group_id: string; lending_item_id: string }) =>
  a.group_id < b.group_id ? -1 : a.group_id > b.group_id ? 1 : a.lending_item_id < b.lending_item_id ? -1 : a.lending_item_id > b.lending_item_id ? 1 : 0;

/**
 * 店長・副店長の行を読む（代表する団体の割り当てと記録と年度の確定の印を、団体に埋め込んで1本で）。割り当ては確定の印があるときだけ
 * 返す（確定前の割り当てで「割り当てが決まりました」を出さない）。団体がなければ読まない
 */
export async function loadLendingRep(groupIds: readonly string[], client: AppSupabaseClient = getSupabase()): Promise<LendingRepRaw> {
  if (groupIds.length === 0) return { assignments: [], records: [] };
  const res = await client
    .from('groups')
    .select(LENDING_REP_SELECT)
    .in('id', [...groupIds])
    .order('id');
  const groups = rowsOf<RepGroupRow>(res);
  return {
    assignments: groups
      .flatMap((g) =>
        (yearConfirmed(g) ? (g.lending_assignments ?? []) : []).map((x) => ({
          group_id: g.id,
          lending_item_id: x.lending_item_id,
          count: x.count,
          item: embeddedItem(x.lending_items),
        })),
      )
      .sort(byGroupAndItem),
    records: groups
      .flatMap((g) =>
        (g.lending_records ?? []).map((x) => ({
          group_id: g.id,
          lending_item_id: x.lending_item_id,
          lent_count: x.lent_count,
          returned_count: x.returned_count,
          item: embeddedItem(x.lending_items),
        })),
      )
      .sort(byGroupAndItem),
  };
}

/**
 * 店長・副店長のテント等のクエリ（キーは `['year', yearId, 'portal', 'lending', 'rep', ...groupIds]`。団体の id は立場の一覧の順）。
 * 代表する団体が変われば別のキャッシュになる。
 */
export function lendingRepOptions(yearId: string, groupIds: readonly string[]) {
  const ids = [...groupIds];
  return queryOptions({
    queryKey: portalQueryKey(yearId, 'lending', 'rep', ...ids),
    queryFn: () => loadLendingRep(ids),
  });
}
