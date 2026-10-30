// DB の行 → YearData・StoredAllocationRow（画面の設計 2.7、D-33。T09a）。純粋関数。
// E2E（Node）からも読むので、`@/` の別名を使わず、相対の import とパッケージの import だけにする。
import { createContext } from '@gaapp/allocator';
import {
  consentSchema,
  distanceOverrideSchema,
  groupSchema,
  itemSchema,
  requestRowSchema,
  roomSchema,
  ruleSchema,
  stockRowSchema,
  type InputError,
  type Rule,
  type StoredAllocationRow,
  type YearData,
} from '@gaapp/shared';
import type { z } from 'zod';
import type { AllocationDbRow, YearTables } from '../db/types';

/** 空文字と空白だけの文字列を null にそろえる（D-33。SQL・seed・前の版で入った空文字も読めるように） */
export function blankToNull(s: string | null | undefined): string | null {
  if (s === null || s === undefined) return null;
  return s.trim() === '' ? null : s;
}

export interface ToYearDataResult {
  data: YearData;
  /** 入力の誤り（ruleCode のあるものはルールのコードつき）。1件でもあれば自動振り分けと確定を押せなくする（2.7） */
  problems: InputError[];
  /** 偽なら validate を呼ばない（ruleCode のない参照の誤りが残っている。「検証できません」と problems を出す） */
  validatable: boolean;
}

/** toYearData が読む表（スナップショットの一部。allocations は使わない） */
export type YearDataSource = Pick<
  YearTables,
  'items' | 'rooms' | 'roomYears' | 'groups' | 'submissions' | 'stocks' | 'requests' | 'rules' | 'consents' | 'distanceOverrides'
>;

/** zod の最初の誤りの場所（例：`building`） */
const fieldOf = (e: z.ZodError) => e.issues[0]?.path.map(String).join('.') || '値';

/**
 * DB の行を YearData にする（2.7 の表）。並べ替えはしない（allocate・validate・exporter が自分で並べる）。
 * - 任意の文字列（rooms.building・groups.display_name）は空文字・空白だけを null にそろえる。
 * - shared の yearDataSchema に合わない行は入れずに problems に出す（allocate の invalid_input より先に、どこが悪いかを示す）。
 * - rules は enabled のものだけ。ruleSchema に合わないルールは入れずに problems（ruleCode つき）。
 * - 距離の上書きで建物が空の行は入れずに problems。
 * - 最後に allocator の createContext で参照を確かめる。ruleCode のある誤り（参照の切れたルール・ルールどうしの重なり）は
 *   そのルールを外して problems に入れ、もう一度確かめる。ruleCode のない誤りは problems に入れて validatable を偽にする。
 *
 * @example
 * const { data, problems, validatable } = toYearData(snapshot);
 * const issues = validatable ? validate(data, toStoredRows(snapshot).rows) : [];
 */
export function toYearData(s: YearDataSource): ToYearDataResult {
  const problems: InputError[] = [];

  const items: YearData['items'] = [];
  s.items.forEach((row, k) => {
    const r = itemSchema.safeParse({
      id: row.id,
      code: row.code,
      name: row.name,
      requestableCategories: row.requestable_categories,
      sortOrder: row.sort_order,
    });
    if (r.success) items.push(r.data);
    else problems.push({ path: `items.${k}`, message: `品目 ${row.name} の ${fieldOf(r.error)} が正しくありません` });
  });

  const usable = new Map(s.roomYears.map((ry) => [ry.room_id, ry.usable]));
  const rooms: YearData['rooms'] = [];
  s.rooms.forEach((row, k) => {
    const r = roomSchema.safeParse({
      id: row.id,
      name: row.name,
      kind: row.kind,
      building: blankToNull(row.building),
      floor: row.floor,
      extraCost: row.extra_cost,
      isStorage: row.is_storage,
      usable: usable.get(row.id) ?? true,
      sortOrder: row.sort_order,
    });
    if (r.success) rooms.push(r.data);
    else problems.push({ path: `rooms.${k}`, message: `場所 ${row.name} の ${fieldOf(r.error)} が正しくありません` });
  });

  const submittedAt = new Map(s.submissions.map((x) => [x.group_id, x.submitted_at]));
  const groups: YearData['groups'] = [];
  s.groups.forEach((row, k) => {
    const r = groupSchema.safeParse({
      id: row.id,
      name: row.name,
      displayName: blankToNull(row.display_name),
      category: row.category,
      locationRoomId: row.location_room_id,
      sortOrder: row.sort_order,
      submittedAt: submittedAt.get(row.id) ?? null,
    });
    if (r.success) groups.push(r.data);
    else problems.push({ path: `groups.${k}`, message: `団体 ${row.name} の ${fieldOf(r.error)} が正しくありません` });
  });

  const stocks: YearData['stocks'] = [];
  s.stocks.forEach((row, k) => {
    const r = stockRowSchema.safeParse({ roomId: row.room_id, itemId: row.item_id, count: row.count });
    if (r.success) stocks.push(r.data);
    else problems.push({ path: `stocks.${k}`, message: `在庫の ${fieldOf(r.error)} が正しくありません` });
  });

  const requests: YearData['requests'] = [];
  s.requests.forEach((row, k) => {
    const r = requestRowSchema.safeParse({ groupId: row.group_id, itemId: row.item_id, count: row.count });
    if (r.success) requests.push(r.data);
    else problems.push({ path: `requests.${k}`, message: `申請の ${fieldOf(r.error)} が正しくありません` });
  });

  let rules: Rule[] = [];
  for (const row of s.rules) {
    if (!row.enabled) continue;
    const r = ruleSchema.safeParse({ id: row.id, code: row.code, kind: row.kind, params: row.params });
    if (r.success) rules.push(r.data);
    else
      problems.push({
        path: `rules.${row.code}`,
        message: `ルール ${row.code} の設定が壊れています（ルール画面で直してください）`,
        ruleCode: row.code,
      });
  }

  const consents: YearData['consents'] = [];
  s.consents.forEach((row, k) => {
    const r = consentSchema.safeParse({
      groupId: row.group_id,
      fromItemId: row.from_item_id,
      toItemId: row.to_item_id,
      status: row.status,
      count: row.count,
    });
    if (r.success) consents.push(r.data);
    else problems.push({ path: `consents.${k}`, message: `了承の ${fieldOf(r.error)} が正しくありません` });
  });

  const distanceOverrides: YearData['distanceOverrides'] = [];
  s.distanceOverrides.forEach((row, k) => {
    const a = blankToNull(row.building_a);
    const b = blankToNull(row.building_b);
    if (a === null || b === null) {
      problems.push({
        path: `distanceOverrides.${k}`,
        message: `距離の上書き（${row.building_a.trim() || '（空）'}・${row.building_b.trim() || '（空）'}）の建物が空です`,
      });
      return;
    }
    const r = distanceOverrideSchema.safeParse({ buildingA: a, buildingB: b, cost: row.cost });
    if (r.success) distanceOverrides.push(r.data);
    else problems.push({ path: `distanceOverrides.${k}`, message: `距離の上書き（${a}・${b}）の ${fieldOf(r.error)} が正しくありません` });
  });

  // 参照の確かめ：validate（allocator）は createContext の inputErrors で例外を投げるので、先に同じ呼び方で確かめる
  const base = { items, rooms, groups, stocks, requests, consents, distanceOverrides };
  let validatable = true;
  for (;;) {
    const c = createContext({ ...base, rules, mode: 'full', fixedRows: [], previousRows: [] });
    if (c.ok) break;
    const broken = new Set(c.inputErrors.flatMap((e) => (e.ruleCode !== undefined ? [e.ruleCode] : [])));
    if (broken.size > 0) {
      for (const e of c.inputErrors) {
        if (e.ruleCode === undefined) continue;
        problems.push({
          path: e.path,
          message: `ルール ${e.ruleCode}：${e.message}（ルール画面で直すか無効にしてください）`,
          ruleCode: e.ruleCode,
        });
      }
      rules = rules.filter((r) => !broken.has(r.code));
      continue; // 壊れたルールを外せば、ほかの検証は回せる
    }
    problems.push(...c.inputErrors);
    validatable = false;
    break;
  }

  return { data: { ...base, rules }, problems, validatable };
}

export interface StoredRows {
  rows: StoredAllocationRow[];
  /** 行の id → updated_at（受け取った文字列のまま。save_allocation_rows の楽観ロックに渡す） */
  updatedAt: Map<string, string>;
}

/** allocations の行 → StoredAllocationRow（updated_at は別の Map に持つ。2.7） */
export function toStoredRows(s: { allocations: readonly AllocationDbRow[] }): StoredRows {
  const updatedAt = new Map<string, string>();
  const rows = s.allocations.map((a) => {
    updatedAt.set(a.id, a.updated_at);
    const row: StoredAllocationRow = {
      id: a.id,
      sourceRoomId: a.source_room_id,
      groupId: a.group_id,
      itemId: a.item_id,
      requestedItemId: a.requested_item_id,
      count: a.count,
      isKeep: a.is_keep,
      origin: a.origin,
      pinned: a.pinned,
      note: a.note,
    };
    return row;
  });
  return { rows, updatedAt };
}
