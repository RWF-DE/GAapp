// 総務の机椅子の軽い読み取り（ダッシュボード〔/〕の机椅子。D-52。04「机椅子の状況」の「ダッシュボードに出すもの」）。
// 6つの表を並行に読み、版（years）・振り分けの行・ルール・申請の行・検証・スナップショットは読まない。T16 で portal.ts から分けた：
// / の先読み（lib/data/screen-queries.ts の planHomePrefetch。ルートのレイアウトが読む）がこのクエリだけを使うので、数え方
// （counts.ts）・要対応の組み立て（portal.ts）・ナビゲーションの表をルートのレイアウトの JS に入れない（団体代表の rep.ts と同じ形）。
// lib/data を import しない。
import { queryOptions } from '@tanstack/react-query';
import { fetchAll } from '@/lib/db/fetch-all';
import type { ConsentDbRow, GroupRow, RoomRow, RoomYearRow, SubmissionRow } from '@/lib/db/types';
import { toAppError } from '@/lib/errors';
import { getSupabase, type AppSupabaseClient } from '@/lib/supabase/client';
import { portalQueryKey } from '../query-key';

/** 総務の読み取りの結果（04「ダッシュボードに出すもの」の6つの表。join の列は外してある） */
export interface FurnitureSoumuRaw {
  groups: Pick<GroupRow, 'id' | 'name' | 'category' | 'sort_order'>[];
  submissions: Pick<SubmissionRow, 'group_id' | 'submitted_at'>[];
  rooms: Pick<RoomRow, 'id' | 'name' | 'is_storage' | 'sort_order'>[];
  roomYears: Pick<RoomYearRow, 'room_id' | 'usable'>[];
  /** 在庫の行の room_id（重なりを除いたもの。行は場所×品目） */
  stockRoomIds: string[];
  consents: Pick<ConsentDbRow, 'group_id' | 'status'>[];
}

/** 総務の読み取りの select（版・振り分けの行・ルール・申請の行・品目・距離は読まない） */
export const FURNITURE_SOUMU_SELECT = {
  groups: 'id, name, category, sort_order',
  request_submissions: 'group_id, submitted_at, groups!inner(year_id)',
  rooms: 'id, name, is_storage, sort_order',
  room_years: 'room_id, usable',
  stocks: 'room_id',
  substitution_consents: 'group_id, status, groups!inner(year_id)',
} as const;

function rowsOf<T>(res: { data: T[] | null; error: unknown; status?: number }): T[] {
  if (res.error) throw toAppError(res.error, res.status);
  return res.data ?? [];
}

/**
 * 総務の机椅子のダッシュボードの行を読む（どれも今の RLS で総務が読めるもの）。6つを並行に読み、年度の行（版）を待たない。
 * 提出と了承は `groups!inner(year_id)` で年度に絞る。在庫の行（場所×品目）は fetchAll で読む。
 */
export async function loadFurnitureSoumu(yearId: string, client: AppSupabaseClient = getSupabase()): Promise<FurnitureSoumuRaw> {
  const S = FURNITURE_SOUMU_SELECT;
  const [groups, submissions, rooms, roomYears, stocks, consents] = await Promise.all([
    client.from('groups').select(S.groups).eq('year_id', yearId).order('sort_order').order('id'),
    client.from('request_submissions').select(S.request_submissions).eq('groups.year_id', yearId).order('group_id'),
    client.from('rooms').select(S.rooms).order('sort_order').order('id'),
    client.from('room_years').select(S.room_years).eq('year_id', yearId).order('room_id'),
    fetchAll((from, to) => client.from('stocks').select(S.stocks).eq('year_id', yearId).order('room_id').order('item_id').range(from, to)),
    fetchAll((from, to) =>
      client
        .from('substitution_consents')
        .select(S.substitution_consents)
        .eq('groups.year_id', yearId)
        .order('group_id')
        .order('from_item_id')
        .order('to_item_id')
        .range(from, to),
    ),
  ]);
  return {
    groups: rowsOf(groups).map(({ id, name, category, sort_order }) => ({ id, name, category, sort_order })),
    submissions: rowsOf(submissions).map(({ group_id, submitted_at }) => ({ group_id, submitted_at })),
    rooms: rowsOf(rooms).map(({ id, name, is_storage, sort_order }) => ({ id, name, is_storage, sort_order })),
    roomYears: rowsOf(roomYears).map(({ room_id, usable }) => ({ room_id, usable })),
    stockRoomIds: [...new Set(stocks.map((s) => s.room_id))],
    consents: consents.map(({ group_id, status }) => ({ group_id, status })),
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
