// DB の行の型の別名と、select の列のリスト（画面の設計 1.5。T09a）。
// lib/data/year-data.ts（E2E からも読む）がここの型を使うので、`@/` の別名を使わず、パッケージの import だけにする。
import type { Database, Tables } from '@gaapp/shared';

export type TableName = keyof Database['public']['Tables'];
export type Row<T extends TableName> = Tables<T>;
export type YearStatus = Database['public']['Enums']['year_status'];

const YEAR_COLS = [
  'id',
  'label',
  'status',
  'allocation_version',
  'auto_allocated_at',
  'festival_start',
  'request_open_at',
  'request_close_at',
  'prev_year_id',
  'updated_at',
] as const satisfies readonly (keyof Tables<'years'>)[];
const ITEM_COLS = ['id', 'code', 'name', 'aliases', 'requestable_categories', 'sort_order', 'updated_at'] as const satisfies readonly (keyof Tables<'items'>)[];
const ROOM_COLS = [
  'id',
  'name',
  'aliases',
  'kind',
  'building',
  'floor',
  'extra_cost',
  'is_storage',
  'sort_order',
  'updated_at',
] as const satisfies readonly (keyof Tables<'rooms'>)[];
const ROOM_YEAR_COLS = ['year_id', 'room_id', 'usable', 'note', 'updated_at'] as const satisfies readonly (keyof Tables<'room_years'>)[];
const GROUP_COLS = [
  'id',
  'year_id',
  'name',
  'display_name',
  'aliases',
  'category',
  'is_food',
  'location_room_id',
  'sort_order',
  'updated_at',
] as const satisfies readonly (keyof Tables<'groups'>)[];
const SUBMISSION_COLS = ['group_id', 'submitted_at', 'note', 'updated_at'] as const satisfies readonly (keyof Tables<'request_submissions'>)[];
const STOCK_COLS = ['year_id', 'room_id', 'item_id', 'count', 'counted_at', 'counted_by', 'updated_at'] as const satisfies readonly (keyof Tables<'stocks'>)[];
const REQUEST_COLS = ['group_id', 'item_id', 'count', 'updated_at'] as const satisfies readonly (keyof Tables<'requests'>)[];
const RULE_COLS = ['id', 'year_id', 'code', 'kind', 'params', 'enabled', 'memo', 'updated_at'] as const satisfies readonly (keyof Tables<'rules'>)[];
const CONSENT_COLS = [
  'group_id',
  'from_item_id',
  'to_item_id',
  'status',
  'count',
  'note',
  'updated_at',
] as const satisfies readonly (keyof Tables<'substitution_consents'>)[];
const DISTANCE_COLS = ['building_a', 'building_b', 'cost', 'updated_at'] as const satisfies readonly (keyof Tables<'distance_overrides'>)[];
const ALLOCATION_COLS = [
  'id',
  'year_id',
  'source_room_id',
  'group_id',
  'item_id',
  'requested_item_id',
  'count',
  'is_keep',
  'origin',
  'pinned',
  'note',
  'updated_at',
] as const satisfies readonly (keyof Tables<'allocations'>)[];

/** select に渡す列の文字列（読む列を1か所で決める） */
export const COLUMNS = {
  years: YEAR_COLS.join(', '),
  items: ITEM_COLS.join(', '),
  rooms: ROOM_COLS.join(', '),
  room_years: ROOM_YEAR_COLS.join(', '),
  groups: GROUP_COLS.join(', '),
  request_submissions: SUBMISSION_COLS.join(', '),
  stocks: STOCK_COLS.join(', '),
  requests: REQUEST_COLS.join(', '),
  rules: RULE_COLS.join(', '),
  substitution_consents: CONSENT_COLS.join(', '),
  distance_overrides: DISTANCE_COLS.join(', '),
  allocations: ALLOCATION_COLS.join(', '),
} as const;

export type YearRow = Pick<Tables<'years'>, (typeof YEAR_COLS)[number]>;
export type ItemRow = Pick<Tables<'items'>, (typeof ITEM_COLS)[number]>;
export type RoomRow = Pick<Tables<'rooms'>, (typeof ROOM_COLS)[number]>;
export type RoomYearRow = Pick<Tables<'room_years'>, (typeof ROOM_YEAR_COLS)[number]>;
export type GroupRow = Pick<Tables<'groups'>, (typeof GROUP_COLS)[number]>;
export type SubmissionRow = Pick<Tables<'request_submissions'>, (typeof SUBMISSION_COLS)[number]>;
export type StockDbRow = Pick<Tables<'stocks'>, (typeof STOCK_COLS)[number]>;
export type RequestDbRow = Pick<Tables<'requests'>, (typeof REQUEST_COLS)[number]>;
export type RuleDbRow = Pick<Tables<'rules'>, (typeof RULE_COLS)[number]>;
export type ConsentDbRow = Pick<Tables<'substitution_consents'>, (typeof CONSENT_COLS)[number]>;
export type DistanceOverrideRow = Pick<Tables<'distance_overrides'>, (typeof DISTANCE_COLS)[number]>;
export type AllocationDbRow = Pick<Tables<'allocations'>, (typeof ALLOCATION_COLS)[number]>;

/**
 * 年度のデータの DB の行（スナップショットの中身。2.2）。toYearData・toStoredRows・swapRows はこの形を受け取る。
 * part = public（viewer）のときは、submissions・stocks・requests・rules・consents・distanceOverrides が空。
 */
export interface YearTables {
  items: ItemRow[];
  rooms: RoomRow[];
  roomYears: RoomYearRow[];
  groups: GroupRow[];
  submissions: SubmissionRow[];
  stocks: StockDbRow[];
  requests: RequestDbRow[];
  rules: RuleDbRow[];
  consents: ConsentDbRow[];
  distanceOverrides: DistanceOverrideRow[];
  allocations: AllocationDbRow[];
}

/** 主キー（updateWithLock・deleteChecked の match に渡す列） */
export const PRIMARY_KEYS = {
  years: ['id'],
  items: ['id'],
  rooms: ['id'],
  room_years: ['year_id', 'room_id'],
  groups: ['id'],
  request_submissions: ['group_id'],
  stocks: ['year_id', 'room_id', 'item_id'],
  requests: ['group_id', 'item_id'],
  rules: ['id'],
  substitution_consents: ['group_id', 'from_item_id', 'to_item_id'],
  distance_overrides: ['building_a', 'building_b'],
  allocations: ['id'],
} as const satisfies Partial<Record<TableName, readonly string[]>>;
