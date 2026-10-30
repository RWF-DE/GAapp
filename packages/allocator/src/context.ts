// 入力の確かめ・並べ替え・索引（設計 4 章 createContext、5 章 P0、8 章）
import {
  allocateInputSchema,
  checkRuleRefs,
  compareBySortOrder,
  compareRules,
  compareStrings,
  rewriteRequestedItem,
  type AllocateInput,
  type AllocationRow,
  type ConsentStatus,
  type Group,
  type InputError,
  type Item,
  type Room,
  type Rule,
  type StoredAllocationRow,
} from '@gaapp/shared';

export const rjKey = (roomId: string, itemId: string) => `${roomId}|${itemId}`;
export const rgijKey = (roomId: string, groupId: string, requestedItemId: string, itemId: string) =>
  `${roomId}|${groupId}|${requestedItemId}|${itemId}`;
export const consentKey = (groupId: string, fromItemId: string, toItemId: string) => `${groupId}|${fromItemId}|${toItemId}`;
export const pairKey = (a: string, b: string) => (a < b ? `${a}\u0000${b}` : `${b}\u0000${a}`);

export type Ctx = {
  mode: AllocateInput['mode'];
  /** 並べ替えた品目・場所・団体（sort_order → 名前 → id）、ルール（code → id。外したルールは除く） */
  items: Item[];
  rooms: Room[];
  groups: Group[];
  rules: Rule[];
  itemById: Map<string, Item>;
  roomById: Map<string, Room>;
  groupById: Map<string, Group>;
  itemIdByCode: Map<string, string>;
  itemIndex: Map<string, number>;
  roomIndex: Map<string, number>;
  groupIndex: Map<string, number>;
  /** 建物の無向の組 → 上書きのコスト */
  overrides: Map<string, number>;
  /** 在庫 S(r,j)（数えた行だけ） */
  stock: Map<string, number>;
  requests: AllocateInput['requests'];
  consentStatus: Map<string, ConsentStatus>;
  /** 固定行（申請品目は前処理0の4で読み替えた後）。並べた順 */
  fixedRows: StoredAllocationRow[];
  /** 前回の行（同上） */
  previousRows: AllocationRow[];
  /** 検証した入力（YearData として validate などに渡せる） */
  input: AllocateInput;
};

export type CreateContextOptions = { disabledRuleCodes?: readonly string[] };

function zodPath(path: readonly PropertyKey[]): string {
  return path.map(String).join('.');
}

/** 行の申請品目に前処理1と同じ読み替えを当てる（DB の行は変えない。設計 5 章 P0 の4） */
export function rewriteRowRequestedItem<T extends AllocationRow>(
  row: T,
  ctx: Pick<Ctx, 'itemById' | 'groupById' | 'itemIdByCode' | 'items'>,
): T {
  const item = ctx.itemById.get(row.requestedItemId);
  const group = ctx.groupById.get(row.groupId);
  if (!item || !group) return row;
  const code = rewriteRequestedItem(item.code, group.category, ctx.items);
  if (code === null || code === item.code) return row;
  return { ...row, requestedItemId: ctx.itemIdByCode.get(code)! };
}

export function createContext(
  raw: unknown,
  opts: CreateContextOptions = {},
): { ok: true; ctx: Ctx } | { ok: false; inputErrors: InputError[] } {
  const parsed = allocateInputSchema.safeParse(raw);
  if (!parsed.success) {
    return {
      ok: false,
      inputErrors: parsed.error.issues.map((i) => ({ path: zodPath(i.path), message: i.message })),
    };
  }
  const input = parsed.data;
  const errors: InputError[] = [];
  const err = (path: string, message: string, ruleCode?: string) =>
    errors.push(ruleCode === undefined ? { path, message } : { path, message, ruleCode });

  // id の重複
  const dupIds = (list: readonly { id: string }[], what: string) => {
    const seen = new Set<string>();
    list.forEach((x, k) => {
      if (seen.has(x.id)) err(`${what}.${k}.id`, 'id が重複しています');
      seen.add(x.id);
    });
  };
  dupIds(input.items, 'items');
  dupIds(input.rooms, 'rooms');
  dupIds(input.groups, 'groups');
  dupIds(input.rules, 'rules');
  dupIds(input.fixedRows, 'fixedRows');
  const codes = new Set<string>();
  input.items.forEach((x, k) => {
    if (codes.has(x.code)) err(`items.${k}.code`, '品目コードが重複しています');
    codes.add(x.code);
  });

  const items = input.items.slice().sort(compareBySortOrder);
  const rooms = input.rooms.slice().sort(compareBySortOrder);
  const groups = input.groups.slice().sort(compareBySortOrder);
  const itemById = new Map(items.map((x) => [x.id, x]));
  const roomById = new Map(rooms.map((x) => [x.id, x]));
  const groupById = new Map(groups.map((x) => [x.id, x]));
  const itemIdByCode = new Map(items.map((x) => [x.code, x.id]));

  // 参照
  const needItem = (path: string, id: string) => {
    if (!itemById.has(id)) err(path, '品目がありません');
  };
  const needRoom = (path: string, id: string) => {
    if (!roomById.has(id)) err(path, '場所がありません');
  };
  const needGroup = (path: string, id: string) => {
    if (!groupById.has(id)) err(path, '団体がありません');
  };
  input.groups.forEach((g, k) => {
    if (g.locationRoomId !== null) needRoom(`groups.${k}.locationRoomId`, g.locationRoomId);
  });
  const stockKeys = new Set<string>();
  input.stocks.forEach((s, k) => {
    needRoom(`stocks.${k}.roomId`, s.roomId);
    needItem(`stocks.${k}.itemId`, s.itemId);
    const key = rjKey(s.roomId, s.itemId);
    // 在庫は数えた場所・品目ごとに1行（DB の主キーと同じ）。2行あると二重に数えうるので止める
    if (stockKeys.has(key)) err(`stocks.${k}`, '同じ場所・品目の在庫の行が2つあります');
    stockKeys.add(key);
  });
  input.requests.forEach((r, k) => {
    needGroup(`requests.${k}.groupId`, r.groupId);
    needItem(`requests.${k}.itemId`, r.itemId);
  });
  const consentKeys = new Set<string>();
  input.consents.forEach((c, k) => {
    needGroup(`consents.${k}.groupId`, c.groupId);
    needItem(`consents.${k}.fromItemId`, c.fromItemId);
    needItem(`consents.${k}.toItemId`, c.toItemId);
    const key = consentKey(c.groupId, c.fromItemId, c.toItemId);
    if (consentKeys.has(key)) err(`consents.${k}`, '同じ団体・品目の了承が2つあります');
    consentKeys.add(key);
  });
  const rowRefs = (rows: readonly AllocationRow[], what: string) =>
    rows.forEach((r, k) => {
      needRoom(`${what}.${k}.sourceRoomId`, r.sourceRoomId);
      needGroup(`${what}.${k}.groupId`, r.groupId);
      needItem(`${what}.${k}.itemId`, r.itemId);
      needItem(`${what}.${k}.requestedItemId`, r.requestedItemId);
    });
  rowRefs(input.fixedRows, 'fixedRows');
  rowRefs(input.previousRows, 'previousRows');
  input.fixedRows.forEach((r, k) => {
    if (r.origin === 'auto' && !r.pinned) err(`fixedRows.${k}`, '固定行は pinned か origin = manual の行だけです');
  });
  if (input.mode === 'full' && input.previousRows.length > 0) {
    err('previousRows', '全体の実行（full）では前回の行を渡しません（最小変更のときだけ）');
  }
  const ovKeys = new Set<string>();
  input.distanceOverrides.forEach((o, k) => {
    if (o.buildingA === o.buildingB) err(`distanceOverrides.${k}`, '同じ建物どうしの上書きは使えません');
    const key = pairKey(o.buildingA, o.buildingB);
    if (ovKeys.has(key)) err(`distanceOverrides.${k}`, '同じ建物の組の上書きが2つあります');
    ovKeys.add(key);
  });

  // ルール（外したものを除き、code の順に。E005 は前処理2で precheck として扱う）
  const disabled = new Set(opts.disabledRuleCodes ?? []);
  const rules = input.rules.filter((r) => !disabled.has(r.code)).sort(compareRules);
  rules.forEach((rule) => {
    const others = rules.filter((r) => r !== rule);
    const { id: _id, ...draft } = rule;
    void _id;
    for (const e of checkRuleRefs(draft as never, { items, rooms, groups, rules: others })) {
      if (e.code === 'E005') continue;
      err(`rules.${rule.code}.${e.path}`, e.message, rule.code);
    }
  });

  if (errors.length > 0) return { ok: false, inputErrors: errors };

  const overrides = new Map(input.distanceOverrides.map((o) => [pairKey(o.buildingA, o.buildingB), o.cost]));
  const stock = new Map(input.stocks.map((s) => [rjKey(s.roomId, s.itemId), s.count]));
  const consentStatus = new Map(input.consents.map((c) => [consentKey(c.groupId, c.fromItemId, c.toItemId), c.status]));
  const itemIndex = new Map(items.map((x, k) => [x.id, k]));
  const roomIndex = new Map(rooms.map((x, k) => [x.id, k]));
  const groupIndex = new Map(groups.map((x, k) => [x.id, k]));
  const base = { itemById, groupById, itemIdByCode, items };
  const rowOrder = (a: AllocationRow, b: AllocationRow) =>
    roomIndex.get(a.sourceRoomId)! - roomIndex.get(b.sourceRoomId)! ||
    groupIndex.get(a.groupId)! - groupIndex.get(b.groupId)! ||
    itemIndex.get(a.requestedItemId)! - itemIndex.get(b.requestedItemId)! ||
    itemIndex.get(a.itemId)! - itemIndex.get(b.itemId)! ||
    a.count - b.count ||
    Number(a.isKeep) - Number(b.isKeep);
  const fixedRows = input.fixedRows
    .map((r) => rewriteRowRequestedItem(r, base))
    .sort((a, b) => rowOrder(a, b) || compareStrings(a.id, b.id));
  const previousRows = input.previousRows.map((r) => rewriteRowRequestedItem(r, base)).sort(rowOrder);

  return {
    ok: true,
    ctx: {
      mode: input.mode,
      items,
      rooms,
      groups,
      rules,
      itemById,
      roomById,
      groupById,
      itemIdByCode,
      itemIndex,
      roomIndex,
      groupIndex,
      overrides,
      stock,
      requests: input.requests,
      consentStatus,
      fixedRows,
      previousRows,
      input,
    },
  };
}
