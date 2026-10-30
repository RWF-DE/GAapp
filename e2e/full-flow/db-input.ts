// 通しの流れ（e2e/serial/full-flow.spec.ts）で、そのときの DB から AllocateInput を組み立てる（画面の設計 7.3 の手順 7）。
// 組み立てはアプリと同じ関数（apps/web/lib/data/year-data.ts の toYearData・toStoredRows）を相対の import で使う。
// 読む列はアプリのスナップショットと同じ（apps/web/lib/db/types.ts の COLUMNS）。行は to_jsonb で、PostgREST と同じ JSON の形で読む。
import type { AllocateInput, InputError, StoredAllocationRow } from '@gaapp/shared';
import { toStoredRows, toYearData } from '../../apps/web/lib/data/year-data';
import { COLUMNS, type YearTables } from '../../apps/web/lib/db/types';
import { sql } from '../support/db';

async function rows<T>(select: string, params: unknown[] = []): Promise<T[]> {
  const r = await sql<{ j: T }>(`select to_jsonb(x) as j from (${select}) x`, params);
  return r.map((x) => x.j);
}

const inYear = 'group_id in (select id from public.groups where year_id = $1)';

/** その年度のスナップショット（アプリの loadSnapshot と同じ表・列・並び） */
export async function readYearTables(yearId: string): Promise<YearTables> {
  const [items, rooms, roomYears, groups, submissions, stocks, requests, rules, consents, distanceOverrides, allocations] = await Promise.all([
    rows<YearTables['items'][number]>(`select ${COLUMNS.items} from public.items order by sort_order, id`),
    rows<YearTables['rooms'][number]>(`select ${COLUMNS.rooms} from public.rooms order by sort_order, id`),
    rows<YearTables['roomYears'][number]>(`select ${COLUMNS.room_years} from public.room_years where year_id = $1 order by room_id`, [yearId]),
    rows<YearTables['groups'][number]>(`select ${COLUMNS.groups} from public.groups where year_id = $1 order by sort_order, id`, [yearId]),
    rows<YearTables['submissions'][number]>(
      `select ${COLUMNS.request_submissions} from public.request_submissions where ${inYear} order by group_id`,
      [yearId],
    ),
    rows<YearTables['stocks'][number]>(`select ${COLUMNS.stocks} from public.stocks where year_id = $1 order by room_id, item_id`, [yearId]),
    rows<YearTables['requests'][number]>(`select ${COLUMNS.requests} from public.requests where ${inYear} order by group_id, item_id`, [yearId]),
    rows<YearTables['rules'][number]>(`select ${COLUMNS.rules} from public.rules where year_id = $1 order by code, id`, [yearId]),
    rows<YearTables['consents'][number]>(
      `select ${COLUMNS.substitution_consents} from public.substitution_consents where ${inYear} order by group_id, from_item_id, to_item_id`,
      [yearId],
    ),
    rows<YearTables['distanceOverrides'][number]>(`select ${COLUMNS.distance_overrides} from public.distance_overrides order by building_a, building_b`),
    rows<YearTables['allocations'][number]>(`select ${COLUMNS.allocations} from public.allocations where year_id = $1 order by id`, [yearId]),
  ]);
  return { items, rooms, roomYears, groups, submissions, stocks, requests, rules, consents, distanceOverrides, allocations };
}

export interface DbInput {
  /** mode full。fixedRows は固定・手動の行（pinned か origin = manual）、previousRows は空 */
  input: AllocateInput;
  problems: InputError[];
  /** その年度の振り分けの行（全部） */
  stored: StoredAllocationRow[];
}

/** 今の DB から、全体の実行（full）の AllocateInput を組み立てる（apps/web/lib/allocation/input.ts の buildAllocateInput と同じ分け方） */
export async function readAllocateInput(yearId: string): Promise<DbInput> {
  const t = await readYearTables(yearId);
  const { data, problems } = toYearData(t);
  const { rows: stored } = toStoredRows(t);
  return {
    input: { ...data, mode: 'full', fixedRows: stored.filter((r) => r.pinned || r.origin === 'manual'), previousRows: [] },
    problems,
    stored,
  };
}
