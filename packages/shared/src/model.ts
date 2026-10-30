// 入力と結果の型と zod スキーマ（03「入力と出力」、設計 2.2・2.4）
import { z } from 'zod';
import {
  ALLOC_ORIGINS,
  ALLOCATE_MODES,
  CONSENT_STATUSES,
  GROUP_CATEGORIES,
  ITEM_CODE_PATTERN,
  MAX_COUNT,
  MAX_DISTANCE_COST,
  ROOM_KINDS,
} from './constants';
import { ruleSchema } from './rules';

const id = z.uuid();
const name = z.string().min(1);
const count0 = z.number().int().min(0).max(MAX_COUNT);
const count1 = z.number().int().min(1).max(MAX_COUNT);
const distanceCost = z.number().int().min(0).max(MAX_DISTANCE_COST);
const sortOrder = z.number().int();

export const itemSchema = z.strictObject({
  id,
  code: z.string().regex(ITEM_CODE_PATTERN),
  name,
  requestableCategories: z.array(z.enum(GROUP_CATEGORIES)),
  sortOrder,
});
export type Item = z.output<typeof itemSchema>;

export const roomSchema = z.strictObject({
  id,
  name,
  kind: z.enum(ROOM_KINDS),
  building: name.nullable(),
  /** 階。null は1階として扱う（体育館など） */
  floor: z.number().int().nullable(),
  /** 運び出しにくい部屋の追加コスト（0〜20 の整数。D-28） */
  extraCost: distanceCost,
  isStorage: z.boolean(),
  /** その年度の状態（room_years）。行がない場所は true */
  usable: z.boolean(),
  sortOrder,
});
export type Room = z.output<typeof roomSchema>;

export const groupSchema = z.strictObject({
  id,
  name,
  displayName: name.nullable(),
  category: z.enum(GROUP_CATEGORIES),
  locationRoomId: id.nullable(),
  sortOrder,
  /** request_submissions.submitted_at（ISO、オフセットつき）。未提出は null（D-07・W105） */
  submittedAt: z.iso.datetime({ offset: true }).nullable(),
});
export type Group = z.output<typeof groupSchema>;

/** 数えた場所の行（0 も渡す）。同じ場所・品目の行は1つだけ */
export const stockRowSchema = z.strictObject({ roomId: id, itemId: id, count: count0 });
export type StockRow = z.output<typeof stockRowSchema>;

/** DB の requests のまま（前処理の前）。同じ団体・品目の行は足す */
export const requestRowSchema = z.strictObject({ groupId: id, itemId: id, count: count0 });
export type RequestRow = z.output<typeof requestRowSchema>;

export const consentSchema = z.strictObject({
  groupId: id,
  fromItemId: id,
  toItemId: id,
  status: z.enum(CONSENT_STATUSES),
  /** 依頼したとき（asked）の置き換え台数。W102 で使う */
  count: count0.nullable(),
});
export type Consent = z.output<typeof consentSchema>;

export const distanceOverrideSchema = z.strictObject({ buildingA: name, buildingB: name, cost: distanceCost });
export type DistanceOverride = z.output<typeof distanceOverrideSchema>;

export const yearDataShape = {
  items: z.array(itemSchema),
  rooms: z.array(roomSchema),
  groups: z.array(groupSchema),
  stocks: z.array(stockRowSchema),
  requests: z.array(requestRowSchema),
  /** enabled のものだけ */
  rules: z.array(ruleSchema),
  consents: z.array(consentSchema),
  distanceOverrides: z.array(distanceOverrideSchema),
};
export const yearDataSchema = z.strictObject(yearDataShape);
/** 年度のデータ。validate・exporter はこれと rows を受け取る */
export type YearData = z.output<typeof yearDataSchema>;

export const allocationRowSchema = z.strictObject({
  sourceRoomId: id,
  groupId: id,
  /** 実際に運ぶ品目 */
  itemId: id,
  /** 申請品目（前処理1の読み替えの後） */
  requestedItemId: id,
  count: count1,
  /** 運び元 = 団体の使用場所 */
  isKeep: z.boolean(),
});
export type AllocationRow = z.output<typeof allocationRowSchema>;

export const storedAllocationRowSchema = z.strictObject({
  ...allocationRowSchema.shape,
  id,
  origin: z.enum(ALLOC_ORIGINS),
  pinned: z.boolean(),
  note: z.string().nullable(),
});
export type StoredAllocationRow = z.output<typeof storedAllocationRowSchema>;

export const allocateInputSchema = z.strictObject({
  ...yearDataShape,
  mode: z.enum(ALLOCATE_MODES),
  /** pinned = true または origin = 'manual' の行（keep を手で固定した行を含む） */
  fixedRows: z.array(storedAllocationRowSchema),
  /** minimal_change のとき：origin = 'auto' かつ未固定の行（keep の行を含む）。full では [] */
  previousRows: z.array(allocationRowSchema),
});
export type AllocateInput = z.output<typeof allocateInputSchema>;

// ---- 結果 ----

export type InputError = { path: string; message: string; ruleCode?: string };

export type Shortage = {
  requestedItemId: string;
  /** null は品目全体（T07） */
  groupId: string | null;
  demand: number;
  supply: number;
};

export type Cause = {
  ruleCode: string | null;
  message: string;
  details: { groupId?: string; itemIds?: string[]; roomIds?: string[]; demand?: number; supply?: number }[];
};

export type IssueCode =
  | 'E001'
  | 'E002'
  | 'E003'
  | 'E004'
  | 'E005'
  | 'E006'
  | 'W101'
  | 'W102'
  | 'W103'
  | 'W104'
  | 'W105'
  | 'W106'
  | 'W107'
  | 'I201';

export type Issue = {
  code: IssueCode;
  severity: 'error' | 'warning' | 'info';
  message: string;
  refs: {
    roomId?: string;
    groupId?: string;
    itemId?: string;
    requestedItemId?: string;
    ruleCode?: string;
    rowIds?: string[];
  };
};

export type AllocateStats = {
  variables: number;
  hatVariables: number;
  supplyRows: number;
  demandRows: number;
  demandUnits: number;
  dMax: number;
  weights: { W: number; mu: number; A: number; B: number };
  /** 申請できない品目（E006）として需要から除いた申請の行の数 */
  excludedRequests: number;
  lpChars: number;
  buildMs: number;
  solveMs: number;
  solverStatus: string;
};

export type AllocateFailureReason = 'invalid_input' | 'precheck' | 'infeasible' | 'solver_error';

export type AllocateResult =
  | { ok: true; rows: AllocationRow[]; objective: number; elapsedMs: number; stats: AllocateStats }
  | {
      ok: false;
      reason: AllocateFailureReason;
      /** 画面の見出し（日本語） */
      message: string;
      inputErrors: InputError[];
      issues: Issue[];
      shortages: Shortage[];
      causes: Cause[];
      elapsedMs: number;
      stats?: Partial<AllocateStats>;
    };
