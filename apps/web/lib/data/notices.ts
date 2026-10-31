// お知らせ一覧（/notices）の読み取りと書き込み（04「お知らせ一覧」、notes/T17.md「後半（画面）の約束」2・5。T17・D-53）。
// - 読む：開いている年度のお知らせ（宛先の団体の行を埋め込む）と団体を並行に読み、総務なら書いた人の表示名（profiles）も読む。
//   どれも RLS が返したものをそのまま使う（画面では宛先で絞らない。件数の上限なし）。
// - 書く：save_notice・delete_notice（lib/rpc の callRpc。送る前に zod で確かめる）。書いた後は一覧とダッシュボードの
//   お知らせの欄を読み直す（invalidateNotices）。出した・直したお知らせは、読み直す前に一覧のキャッシュに入れる（putNoticeInCache。
//   次に開いたダイアログの knownIds に入れ、同じ中身で続けて出したときに (B2) の確かめで前のものを取り違えない）。
// - 応答が届かなかったとき・止められたときの読み直し（2.6 の (B1)・(B2)）：readNotice（id で1行）・findCreatedNotice（自分が出した
//   最近のお知らせ）と、入力と同じかの比べ方 sameNoticeWrite。
// 版（allocation_version）は使わない（お知らせは振り分けの入力でない。D-53）。
import { compareBySortOrder, compareStrings, Constants, type Database, type Tables } from '@gaapp/shared';
import { queryOptions, useQuery, type QueryClient } from '@tanstack/react-query';
import { fetchAll, type PageResult } from '@/lib/db/fetch-all';
import type { GroupRow } from '@/lib/db/types';
import { toAppError } from '@/lib/errors';
import { queryKeys } from '@/lib/query';
import { callRpc } from '@/lib/rpc';
import { toSaveNoticeArgs, type NoticeWrite } from '@/lib/schemas/notices';
import { getSupabase, type AppSupabaseClient } from '@/lib/supabase/client';

/** お知らせの宛先（notice_audience） */
export type NoticeAudience = Database['public']['Enums']['notice_audience'];
/** 宛先の一覧（02 の列挙の並び：総務内・全団体・指定の団体） */
export const NOTICE_AUDIENCES: readonly NoticeAudience[] = Constants.public.Enums.notice_audience;

/** お知らせの列（notices の全部の列） */
type NoticeCols = 'id' | 'year_id' | 'audience' | 'title' | 'body' | 'pinned' | 'created_by' | 'created_at' | 'updated_by' | 'updated_at';

/** お知らせの行と、読めた宛先の団体の id（団体の並び。読めない団体の id は後ろに id の順） */
export interface NoticeRow extends Pick<Tables<'notices'>, NoticeCols> {
  groupIds: string[];
}

/** 団体（宛先の団体の名前と、ダイアログのチェックの一覧。並びは sort_order → 名前 → id） */
export type NoticeGroupOption = Pick<GroupRow, 'id' | 'name' | 'aliases' | 'category' | 'sort_order'>;

export interface NoticesData {
  /** sortNotices の順（ピン留め → 出した日時の新しい順 → id） */
  notices: NoticeRow[];
  /** RLS で読める団体（総務・閲覧のみはその年度の全部、店長・副店長は自団体） */
  groups: NoticeGroupOption[];
  /** created_by → 表示名（総務だけ読む。読めない人は入らない） */
  authors: ReadonlyMap<string, string>;
  /** 読み込んだ時刻（ISO） */
  loadedAt: string;
}

/** 一覧の select（宛先の団体の行は notice_groups を埋め込む。RLS で、店長・副店長には自団体の行だけが返る） */
export const NOTICES_SELECT =
  'id, year_id, audience, title, body, pinned, created_by, created_at, updated_by, updated_at, notice_groups(group_id)';
/** 団体の select（名前・別名・区分・並び） */
export const NOTICE_GROUPS_SELECT = 'id, name, aliases, category, sort_order';
/** (B2) の確かめで読む、自分が出した最近のお知らせの数 */
export const FIND_CREATED_LIMIT = 20;

/** DB から読んだ行（notice_groups を埋め込んだもの） */
type NoticeDbRow = Pick<Tables<'notices'>, NoticeCols> & { notice_groups?: { group_id: string }[] | null };

/** 団体の並び（sort_order → 名前 → id。CLAUDE.md の約束。packages/shared の比べ方） */
export function compareNoticeGroups(a: Pick<NoticeGroupOption, 'id' | 'name' | 'sort_order'>, b: Pick<NoticeGroupOption, 'id' | 'name' | 'sort_order'>): number {
  return compareBySortOrder({ id: a.id, name: a.name, sortOrder: a.sort_order }, { id: b.id, name: b.name, sortOrder: b.sort_order });
}

/** 団体の id → 並びの番号（groups は団体の並びにしたもの） */
export function groupOrderOf(groups: readonly Pick<NoticeGroupOption, 'id'>[]): ReadonlyMap<string, number> {
  return new Map(groups.map((g, k) => [g.id, k]));
}

/**
 * 宛先の団体の id を団体の並びにする（order にある id が先、読めない団体の id は後ろに id の順。重なりは除く）。
 * order がなければ id の順。
 */
export function orderGroupIds(ids: readonly string[], order: ReadonlyMap<string, number> | null = null): string[] {
  return [...new Set(ids)].sort((a, b) => {
    const ia = order?.get(a);
    const ib = order?.get(b);
    if (ia !== undefined && ib !== undefined) return ia - ib;
    if (ia !== undefined) return -1;
    if (ib !== undefined) return 1;
    return compareStrings(a, b);
  });
}

/** DB の行を NoticeRow にする（埋め込みの宛先の団体を groupIds に。並びは orderGroupIds） */
export function toNoticeRow(row: NoticeDbRow, order: ReadonlyMap<string, number> | null = null): NoticeRow {
  return {
    id: row.id,
    year_id: row.year_id,
    audience: row.audience,
    title: row.title,
    body: row.body,
    pinned: row.pinned,
    created_by: row.created_by,
    created_at: row.created_at,
    updated_by: row.updated_by,
    updated_at: row.updated_at,
    groupIds: orderGroupIds((row.notice_groups ?? []).map((g) => g.group_id), order),
  };
}

const timeOf = (iso: string): number => {
  const t = Date.parse(iso);
  return Number.isNaN(t) ? Number.NEGATIVE_INFINITY : t;
};

/**
 * お知らせの並び（04「お知らせ一覧」）：ピン留めのものを先に、その中と残りはそれぞれ出した日時（created_at）の新しい順、
 * 同じなら id の順。元の配列は変えない。
 */
export function sortNotices<T extends Pick<NoticeRow, 'id' | 'pinned' | 'created_at'>>(rows: readonly T[]): T[] {
  return [...rows].sort(
    (a, b) => Number(b.pinned) - Number(a.pinned) || timeOf(b.created_at) - timeOf(a.created_at) || compareStrings(a.id, b.id),
  );
}

/** 書いた人の表示名（profiles。RLS で読めない人は入らない。created_by の重なりと null を除き、0 人なら読まない） */
async function fetchNoticeAuthors(notices: readonly NoticeRow[], client: AppSupabaseClient): Promise<Map<string, string>> {
  const ids = [...new Set(notices.map((n) => n.created_by).filter((id): id is string => !!id))].sort();
  if (ids.length === 0) return new Map();
  const res = await client.from('profiles').select('user_id, display_name').in('user_id', ids);
  if (res.error) throw toAppError(res.error, res.status);
  return new Map((res.data ?? []).map((p) => [p.user_id, p.display_name]));
}

/**
 * 一覧を読む。お知らせ（宛先の団体の行つき。year_id で絞り、全部）と団体を並行に読み、withAuthors（総務）なら書いた人の
 * 表示名も読む（閲覧のみ・店長・副店長は profiles を読めないので読まない）。
 */
export async function fetchNotices(yearId: string, opts: { withAuthors: boolean }, client: AppSupabaseClient = getSupabase()): Promise<NoticesData> {
  const [rows, groups] = await Promise.all([
    fetchAll<NoticeDbRow>(
      (from, to) =>
        client
          .from('notices')
          .select(NOTICES_SELECT)
          .eq('year_id', yearId)
          .order('pinned', { ascending: false })
          .order('created_at', { ascending: false })
          .order('id')
          .range(from, to) as unknown as PromiseLike<PageResult<NoticeDbRow>>,
    ),
    fetchAll<NoticeGroupOption>(
      (from, to) =>
        client
          .from('groups')
          .select(NOTICE_GROUPS_SELECT)
          .eq('year_id', yearId)
          .order('sort_order')
          .order('id')
          .range(from, to) as unknown as PromiseLike<PageResult<NoticeGroupOption>>,
    ),
  ]);
  const sortedGroups = [...groups].sort(compareNoticeGroups);
  const order = groupOrderOf(sortedGroups);
  const notices = sortNotices(rows.map((r) => toNoticeRow(r, order)));
  const authors = opts.withAuthors ? await fetchNoticeAuthors(notices, client) : new Map<string, string>();
  return { notices, groups: sortedGroups, authors, loadedAt: new Date().toISOString() };
}

/** 一覧のクエリ（キーは `['year', yearId, 'notices', 'list', 'authors' | 'plain']`。総務は書いた人の名前つき） */
export function noticesOptions(yearId: string | null | undefined, withAuthors: boolean) {
  return queryOptions({
    queryKey: queryKeys.yearPart(yearId ?? '', 'notices', 'list', withAuthors ? 'authors' : 'plain'),
    queryFn: () => fetchNotices(yearId!, { withAuthors }),
    enabled: !!yearId,
  });
}

export function useNotices(yearId: string | null | undefined, withAuthors: boolean) {
  return useQuery(noticesOptions(yearId, withAuthors));
}

/** そのお知らせを1行読む（(B1) の読み直し）。なければ（消えた・読めない）null。宛先の団体は id の順 */
export async function readNotice(id: string, client: AppSupabaseClient = getSupabase()): Promise<NoticeRow | null> {
  const res = await client.from('notices').select(NOTICES_SELECT).eq('id', id).maybeSingle();
  if (res.error) throw toAppError(res.error, res.status);
  return res.data ? toNoticeRow(res.data as unknown as NoticeDbRow) : null;
}

/**
 * 読み直した行の中身が、送った入力と同じか（宛先・題名・本文〔null をそろえる〕・ピン留め・宛先の団体〔並べて比べる。
 * 指定の団体のときだけ〕）。(B1) の「保存されていました」と、編集で何も変えていないかの判定に使う。
 */
export function sameNoticeWrite(row: Pick<NoticeRow, 'audience' | 'title' | 'body' | 'pinned' | 'groupIds'>, w: NoticeWrite): boolean {
  if (row.audience !== w.audience || row.title !== w.title || (row.body ?? null) !== (w.body ?? null) || row.pinned !== w.pinned) return false;
  if (w.audience !== 'groups') return true;
  const a = [...new Set(row.groupIds)].sort(compareStrings);
  const b = [...new Set(w.groupIds)].sort(compareStrings);
  return a.length === b.length && a.every((id, k) => id === b[k]);
}

/**
 * 出したお知らせの応答が届かなかったときの確かめ（(B2)。04 の通信の失敗）：自分が出したその年度のお知らせを出した日時の新しい順に
 * FIND_CREATED_LIMIT 件読み、ダイアログを開いたときの一覧の id（knownIds）になく、中身が入力と同じものを返す（なければ null）。
 * 端末の時計はずれうるので、時刻では絞らない。読めなければ投げる。
 */
export async function findCreatedNotice(
  yearId: string,
  userId: string,
  w: NoticeWrite,
  knownIds: ReadonlySet<string>,
  client: AppSupabaseClient = getSupabase(),
): Promise<NoticeRow | null> {
  const res = await client
    .from('notices')
    .select(NOTICES_SELECT)
    .eq('year_id', yearId)
    .eq('created_by', userId)
    .order('created_at', { ascending: false })
    .order('id')
    .limit(FIND_CREATED_LIMIT);
  if (res.error) throw toAppError(res.error, res.status);
  const rows = ((res.data ?? []) as unknown as NoticeDbRow[]).map((r) => toNoticeRow(r));
  return rows.find((r) => !knownIds.has(r.id) && sameNoticeWrite(r, w)) ?? null;
}

/** save_notice の返り値（お知らせの行） */
export type SavedNotice = Pick<Tables<'notices'>, NoticeCols>;

/**
 * お知らせを出す（base が null）・直す（base は読んだときの id と updated_at の文字列）。全部の欄を送る（toSaveNoticeArgs）。
 * 失敗したら AppError を投げる（送る前の確かめに落ちたときは field つきの input）。
 */
export async function saveNotice(
  yearId: string,
  w: NoticeWrite,
  base: { id: string; updatedAt: string } | null,
  client?: AppSupabaseClient,
): Promise<SavedNotice> {
  return callRpc('save_notice', toSaveNoticeArgs(yearId, w, base), client);
}

/** お知らせを消す（読んだときの updated_at で楽観ロック） */
export async function deleteNotice(n: Pick<NoticeRow, 'id' | 'updated_at'>, client?: AppSupabaseClient): Promise<void> {
  await callRpc('delete_notice', { p_notice_id: n.id, p_base_updated_at: n.updated_at }, client);
}

/** 書いた後に読み直すキー：一覧（`['year', y, 'notices']`）とダッシュボードのお知らせの欄（`['year', y, 'portal', 'notices']`） */
export function noticeInvalidateKeys(yearId: string): readonly (readonly unknown[])[] {
  return [queryKeys.yearPart(yearId, 'notices'), queryKeys.yearPart(yearId, 'portal', 'notices')];
}

/** 書いた後に、一覧とダッシュボードのお知らせの欄を読み直す（待たない。画面は先にキャッシュを直している） */
export function invalidateNotices(queryClient: QueryClient, yearId: string): void {
  for (const queryKey of noticeInvalidateKeys(yearId)) void queryClient.invalidateQueries({ queryKey });
}

/**
 * 出した・直したお知らせ（save_notice の返り値と、送った宛先の団体）を一覧のキャッシュ（書いた人の名前つき・なしの両方）に入れる。
 * 読み直しの前に、一覧と次に開いたダイアログの knownIds に入れるため（(B2)）。キャッシュがなければ何もしない。
 */
export function putNoticeInCache(queryClient: QueryClient, yearId: string, row: SavedNotice, groupIds: readonly string[]): void {
  for (const withAuthors of [true, false]) {
    queryClient.setQueryData(noticesOptions(yearId, withAuthors).queryKey, (old) => {
      if (!old) return old;
      const next = toNoticeRow({ ...row, notice_groups: groupIds.map((group_id) => ({ group_id })) }, groupOrderOf(old.groups));
      return { ...old, notices: sortNotices([...old.notices.filter((n) => n.id !== next.id), next]) };
    });
  }
}

/** 消えたお知らせを一覧のキャッシュから外す（読み直しの前に一覧から消す） */
export function dropNoticeFromCache(queryClient: QueryClient, yearId: string, id: string): void {
  for (const withAuthors of [true, false]) {
    queryClient.setQueryData(noticesOptions(yearId, withAuthors).queryKey, (old) =>
      old ? { ...old, notices: old.notices.filter((n) => n.id !== id) } : old,
    );
  }
}
