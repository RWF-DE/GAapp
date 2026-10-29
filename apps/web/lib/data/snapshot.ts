// 振り分けのスナップショット（画面の設計 2.2、D-33。T09a）。ダッシュボード・振り分け・キャスター机交換は、年度の行（版）を
// 読み終えてから残りを並行に読む。版 v の後に読んだデータは v の時点かそれより新しいので、v を渡した保存・確定は、途中の変更を
// conflict として取りこぼさない。
import { useQuery } from '@tanstack/react-query';
import { toAppError } from '@/lib/errors';
import { fetchAll } from '@/lib/db/fetch-all';
import {
  COLUMNS,
  type AllocationDbRow,
  type ConsentDbRow,
  type DistanceOverrideRow,
  type GroupRow,
  type ItemRow,
  type RequestDbRow,
  type RoomRow,
  type RoomYearRow,
  type RuleDbRow,
  type StockDbRow,
  type SubmissionRow,
  type YearRow,
  type YearTables,
} from '@/lib/db/types';
import { queryKeys } from '@/lib/query';
import { getSupabase, type AppSupabaseClient } from '@/lib/supabase/client';
import { fetchYear } from './year';

/** full：admin・staff（在庫・申請・ルール・了承も読む）。public：viewer（RLS で読める行と名前だけ） */
export type SnapshotPart = 'full' | 'public';

export interface Snapshot extends YearTables {
  part: SnapshotPart;
  year: YearRow;
  /** 先に読んだ版（year.allocation_version）。保存・確定にはこれを渡す */
  version: number;
  /** 読み終えた日時（ISO。PageHeader の「最終読み込み」） */
  loadedAt: string;
}

type Res<T> = { data: T[] | null; error: unknown; status?: number };

function rowsOf<T>(res: Res<unknown>): T[] {
  if (res.error) throw toAppError(res.error, res.status);
  return (res.data ?? []) as T[];
}

/** 年度で絞るために groups を inner join した行から、join の列を外す */
const dropJoin = <T>(rows: readonly Record<string, unknown>[]): T[] =>
  rows.map((r) => {
    const { groups: _groups, ...rest } = r;
    void _groups;
    return rest as T;
  });

/**
 * スナップショットを読む。
 * 1. years の行を読み、これが返ってから 2 を始める。
 * 2. 残りを並行に読む。requests・request_submissions・substitution_consents は `groups!inner(year_id)` で年度に絞る。
 *    行の多い表（stocks・requests・allocations）は fetchAll で読む。
 * 3. DB の行のまま返す（updated_at などの編集に要る列を失わない）。画面ごとに toYearData・toStoredRows を当てる。
 */
export async function loadSnapshot(yearId: string, part: SnapshotPart, client: AppSupabaseClient = getSupabase()): Promise<Snapshot> {
  const year = await fetchYear(yearId, client);
  const db = client;

  const items = db.from('items').select(COLUMNS.items).order('sort_order').order('id');
  const rooms = db.from('rooms').select(COLUMNS.rooms).order('sort_order').order('id');
  const roomYears = db.from('room_years').select(COLUMNS.room_years).eq('year_id', yearId).order('room_id');
  const groups = db.from('groups').select(COLUMNS.groups).eq('year_id', yearId).order('sort_order').order('id');
  const allocations = fetchAll((from, to) =>
    db.from('allocations').select(COLUMNS.allocations).eq('year_id', yearId).order('id').range(from, to),
  );

  if (part === 'public') {
    const [i, r, ry, g, a] = await Promise.all([items, rooms, roomYears, groups, allocations]);
    return {
      part,
      year,
      version: year.allocation_version,
      loadedAt: new Date().toISOString(),
      items: rowsOf<ItemRow>(i),
      rooms: rowsOf<RoomRow>(r),
      roomYears: rowsOf<RoomYearRow>(ry),
      groups: rowsOf<GroupRow>(g),
      submissions: [],
      stocks: [],
      requests: [],
      rules: [],
      consents: [],
      distanceOverrides: [],
      allocations: a as unknown as AllocationDbRow[],
    };
  }

  const submissions = db
    .from('request_submissions')
    .select(`${COLUMNS.request_submissions}, groups!inner(year_id)`)
    .eq('groups.year_id', yearId)
    .order('group_id');
  const stocks = fetchAll((from, to) =>
    db.from('stocks').select(COLUMNS.stocks).eq('year_id', yearId).order('room_id').order('item_id').range(from, to),
  );
  const requests = fetchAll((from, to) =>
    db
      .from('requests')
      .select(`${COLUMNS.requests}, groups!inner(year_id)`)
      .eq('groups.year_id', yearId)
      .order('group_id')
      .order('item_id')
      .range(from, to),
  );
  const rules = db.from('rules').select(COLUMNS.rules).eq('year_id', yearId).order('code').order('id');
  const consents = db
    .from('substitution_consents')
    .select(`${COLUMNS.substitution_consents}, groups!inner(year_id)`)
    .eq('groups.year_id', yearId)
    .order('group_id')
    .order('from_item_id')
    .order('to_item_id');
  const distance = db.from('distance_overrides').select(COLUMNS.distance_overrides).order('building_a').order('building_b');

  const [i, r, ry, g, sub, st, rq, ru, co, di, a] = await Promise.all([
    items,
    rooms,
    roomYears,
    groups,
    submissions,
    stocks,
    requests,
    rules,
    consents,
    distance,
    allocations,
  ]);
  return {
    part,
    year,
    version: year.allocation_version,
    loadedAt: new Date().toISOString(),
    items: rowsOf<ItemRow>(i),
    rooms: rowsOf<RoomRow>(r),
    roomYears: rowsOf<RoomYearRow>(ry),
    groups: rowsOf<GroupRow>(g),
    submissions: dropJoin<SubmissionRow>(rowsOf<Record<string, unknown>>(sub)),
    stocks: st as unknown as StockDbRow[],
    requests: dropJoin<RequestDbRow>(rq as unknown as Record<string, unknown>[]),
    rules: rowsOf<RuleDbRow>(ru),
    consents: dropJoin<ConsentDbRow>(rowsOf<Record<string, unknown>>(co)),
    distanceOverrides: rowsOf<DistanceOverrideRow>(di),
    allocations: a as unknown as AllocationDbRow[],
  };
}

/**
 * スナップショットのクエリ（staleTime: Infinity。読み直しは refetch か invalidate で明示的に行う。1.7）。
 * 立場で part を決める：admin・staff は full、viewer は public（確定後だけ）。
 */
export function useSnapshot(yearId: string | null | undefined, part: SnapshotPart, enabled = true) {
  return useQuery({
    queryKey: queryKeys.snapshot(yearId ?? '', part),
    queryFn: () => loadSnapshot(yearId!, part),
    enabled: enabled && !!yearId,
    staleTime: Infinity,
  });
}
