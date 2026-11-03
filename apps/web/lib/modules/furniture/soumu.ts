// 総務の机椅子の軽い読み取り（ダッシュボード〔/〕の机椅子。D-52。04「机椅子の状況」の「ダッシュボードに出すもの」）。
// 6つの表を埋め込みの2本で並行に読み（FU3 の案 3。前は表ごとに6本）、版（years）・振り分けの行・ルール・申請の行・検証・スナップショットは
// 読まない。T16 で portal.ts から分けた：/ の先読み（lib/data/screen-queries.ts の planHomePrefetch。ルートのレイアウトが読む）がこの
// クエリだけを使うので、数え方（counts.ts）・要対応の組み立て（portal.ts）・ナビゲーションの表をルートのレイアウトの JS に入れない
// （団体代表の rep.ts と同じ形）。lib/data を import しない。
import { queryOptions } from '@tanstack/react-query';
import type { ConsentDbRow, GroupRow, RoomRow, RoomYearRow, SubmissionRow } from '@/lib/db/types';
import { toAppError } from '@/lib/errors';
import { getSupabase, type AppSupabaseClient } from '@/lib/supabase/client';
import { portalQueryKey } from '../query-key';

/**
 * 総務の読み取りの結果（04「ダッシュボードに出すもの」の6つの表。埋め込みから、表ごとに読んだときと同じ行・同じ並びに戻してある）。
 * groups・rooms は並びの順（sort_order → id）、submissions・consents は団体の id の順（了承は同じ団体の中で品目の組の順）、
 * roomYears・stockRoomIds は場所の id の順。
 */
export interface FurnitureSoumuRaw {
  groups: Pick<GroupRow, 'id' | 'name' | 'category' | 'sort_order'>[];
  submissions: Pick<SubmissionRow, 'group_id' | 'submitted_at'>[];
  rooms: Pick<RoomRow, 'id' | 'name' | 'is_storage' | 'sort_order'>[];
  roomYears: Pick<RoomYearRow, 'room_id' | 'usable'>[];
  /** 在庫の行がある場所の id（重なりを除いたもの。行は場所×品目） */
  stockRoomIds: string[];
  consents: Pick<ConsentDbRow, 'group_id' | 'status'>[];
}

/**
 * 総務の読み取りの select（2本。版・振り分けの行・ルール・申請の行・品目・距離は読まない）。
 * - groups：団体（年度で絞る）に、提出の記録（request_submissions。主キーが団体なので1行まで）と了承の行を埋め込む
 * - rooms：場所（年度をまたぐ表なので全部）に、今年の使用（room_years）と在庫の行（stocks。数えたかだけを見るので1行まで）を埋め込む。
 *   どちらも年度で絞る（埋め込みの絞り込みは場所の行を減らさない）
 * 埋め込みにもそれぞれの表の RLS が効く（読める行は表ごとに読んだときと同じ）
 */
export const FURNITURE_SOUMU_SELECT = {
  groups: 'id, name, category, sort_order, request_submissions(submitted_at), substitution_consents(status)',
  rooms: 'id, name, is_storage, sort_order, room_years(usable), stocks(room_id)',
} as const;

type Res = { data: unknown; error: unknown; status?: number };

function rowsOf<T>(res: Res): T[] {
  if (res.error) throw toAppError(res.error, res.status);
  return (res.data ?? []) as T[];
}

/** 埋め込み（一対一ならオブジェクトか null、一対多なら配列で返る）を配列にする */
type Embedded<T> = T | T[] | null | undefined;
const manyOf = <T>(v: Embedded<T>): T[] => (Array.isArray(v) ? v : v ? [v] : []);

/** uuid の文字列の比べ方（小文字の正規の形なので、文字の順が DB の uuid の順と同じ） */
const byId = (a: string, b: string): number => (a < b ? -1 : a > b ? 1 : 0);

interface GroupEmbedRow extends Pick<GroupRow, 'id' | 'name' | 'category' | 'sort_order'> {
  request_submissions?: Embedded<Pick<SubmissionRow, 'submitted_at'>>;
  substitution_consents?: Embedded<Pick<ConsentDbRow, 'status'>>;
}

interface RoomEmbedRow extends Pick<RoomRow, 'id' | 'name' | 'is_storage' | 'sort_order'> {
  room_years?: Embedded<Pick<RoomYearRow, 'usable'>>;
  stocks?: Embedded<{ room_id: string }>;
}

/**
 * 総務の机椅子のダッシュボードの行を読む（どれも今の RLS で総務が読めるもの）。2本を並行に読み、年度の行（版）を待たない。
 * 埋め込みの配列は件数（max_rows）で切られない。在庫の行は場所ごとに1行まで（limit）なので、場所×品目が多くても大きくならない。
 */
export async function loadFurnitureSoumu(yearId: string, client: AppSupabaseClient = getSupabase()): Promise<FurnitureSoumuRaw> {
  const S = FURNITURE_SOUMU_SELECT;
  const [g, r] = await Promise.all([
    client
      .from('groups')
      .select(S.groups)
      .eq('year_id', yearId)
      .order('sort_order')
      .order('id')
      .order('from_item_id', { referencedTable: 'substitution_consents' })
      .order('to_item_id', { referencedTable: 'substitution_consents' }),
    client
      .from('rooms')
      .select(S.rooms)
      .eq('room_years.year_id', yearId)
      .eq('stocks.year_id', yearId)
      .limit(1, { referencedTable: 'stocks' })
      .order('sort_order')
      .order('id'),
  ]);
  const groups = rowsOf<GroupEmbedRow>(g);
  const rooms = rowsOf<RoomEmbedRow>(r);
  // 表ごとに読んだときの並び（提出・了承は団体の id の順、今年の使用・在庫は場所の id の順）に戻す。sort は安定なので、了承は同じ団体の
  // 中で埋め込みの並び（品目の組の順）のまま
  return {
    groups: groups.map(({ id, name, category, sort_order }) => ({ id, name, category, sort_order })),
    submissions: groups
      .flatMap((x) => manyOf(x.request_submissions).map((s) => ({ group_id: x.id, submitted_at: s.submitted_at })))
      .sort((a, b) => byId(a.group_id, b.group_id)),
    rooms: rooms.map(({ id, name, is_storage, sort_order }) => ({ id, name, is_storage, sort_order })),
    roomYears: rooms
      .flatMap((x) => manyOf(x.room_years).map((y) => ({ room_id: x.id, usable: y.usable })))
      .sort((a, b) => byId(a.room_id, b.room_id)),
    stockRoomIds: rooms
      .filter((x) => manyOf(x.stocks).length > 0)
      .map((x) => x.id)
      .sort(byId),
    consents: groups
      .flatMap((x) => manyOf(x.substitution_consents).map((c) => ({ group_id: x.id, status: c.status })))
      .sort((a, b) => byId(a.group_id, b.group_id)),
  };
}

/**
 * 総務の机椅子のクエリ（キーは `['year', yearId, 'portal', 'furniture', 'soumu']`）。ダッシュボードの欄（portal.ts の
 * furniturePortalProvider が select を足す）と、/ の先読み（planHomePrefetch）が同じキャッシュを読む。
 */
export function furnitureSoumuOptions(yearId: string) {
  return queryOptions({
    queryKey: portalQueryKey(yearId, 'furniture', 'soumu'),
    queryFn: () => loadFurnitureSoumu(yearId),
  });
}
