// 定数（01_rules.md の用語集・品目表、02_data.md の列挙型と同じ値）

/** 既知の品目コード（01 の品目表の並び）。品目は DB で増やせるので、型の上では品目コードを string で持つ */
export const ITEM_CODES = [
  'desk',
  'desk_ng',
  'chair',
  'chair_ng',
  'caster_desk',
  'blue_chair',
  'long_desk_3',
  'long_desk_2',
  'lectern',
] as const;
export type KnownItemCode = (typeof ITEM_CODES)[number];

/** 品目コードの形（DB の items.code と同じ） */
export const ITEM_CODE_PATTERN = /^[a-z][a-z0-9_]*$/;

export const GROUP_CATEGORIES = ['stall', 'department', 'company', 'rest_area'] as const;
export type GroupCategory = (typeof GROUP_CATEGORIES)[number];

export const ROOM_KINDS = ['room', 'gym', 'outdoor', 'other'] as const;
export type RoomKind = (typeof ROOM_KINDS)[number];

export const CONSENT_STATUSES = ['not_asked', 'asked', 'accepted', 'declined'] as const;
export type ConsentStatus = (typeof CONSENT_STATUSES)[number];

export const RULE_KINDS = ['substitute', 'source_restrict', 'fixed_request', 'keep'] as const;
export type RuleKind = (typeof RULE_KINDS)[number];

export const ALLOC_ORIGINS = ['auto', 'manual'] as const;
export type AllocOrigin = (typeof ALLOC_ORIGINS)[number];

export const ALLOCATE_MODES = ['full', 'minimal_change'] as const;
export type AllocateMode = (typeof ALLOCATE_MODES)[number];

/** 申請できない区分の申請を読み替える品目（S03・D-05）。これ以外の申請できない品目は E006 */
export const REQUEST_REWRITES: Readonly<Record<string, string>> = { long_desk_3: 'long_desk_2' };

/** highs-js の版。packages/allocator の devDependencies（と apps/web の dependencies）と一致させる */
export const HIGHS_VERSION = '1.15.4';

/** 数の上限（DB の CHECK と同じ） */
export const MAX_COUNT = 10000;
/** 距離の追加コストと上書きのコストの上限（D-28） */
export const MAX_DISTANCE_COST = 20;
/** 代替の重さの上限 */
export const MAX_SUBSTITUTE_COST = 10;

const ALL_CATEGORIES: GroupCategory[] = ['stall', 'department', 'company', 'rest_area'];

export type InitialItem = {
  code: KnownItemCode;
  name: string;
  aliases: string[];
  requestableCategories: GroupCategory[];
  sortOrder: number;
};

/** 01 の「品目」表（初期値）。fixtures の品目と、T02 の seed の品目はこれと同じにする */
export const INITIAL_ITEMS: readonly InitialItem[] = [
  { code: 'desk', name: '机(木)', aliases: ['机(木)'], requestableCategories: ALL_CATEGORIES, sortOrder: 1 },
  { code: 'desk_ng', name: '不可机', aliases: [], requestableCategories: [], sortOrder: 2 },
  { code: 'chair', name: '椅子(木)', aliases: ['椅子(木)'], requestableCategories: ALL_CATEGORIES, sortOrder: 3 },
  { code: 'chair_ng', name: '不可椅子', aliases: [], requestableCategories: [], sortOrder: 4 },
  { code: 'caster_desk', name: 'キャスター机', aliases: ['机(キャスター有)'], requestableCategories: ALL_CATEGORIES, sortOrder: 5 },
  { code: 'blue_chair', name: '椅子(青)', aliases: ['椅子(青)'], requestableCategories: ALL_CATEGORIES, sortOrder: 6 },
  { code: 'long_desk_3', name: '長机(3人掛)', aliases: ['長机(三席用)'], requestableCategories: ['company'], sortOrder: 7 },
  { code: 'long_desk_2', name: '長机(2人掛)', aliases: ['長机(二席用)'], requestableCategories: ALL_CATEGORIES, sortOrder: 8 },
  { code: 'lectern', name: '教卓', aliases: ['教卓'], requestableCategories: ALL_CATEGORIES, sortOrder: 9 },
];
