// 履歴（/history）のデータの読み書き（画面の設計 3.12、04「履歴」。T14）。
// - 絞り込み（表〔複数〕・団体・期間〔Asia/Tokyo の日付〕・した人）は URL のクエリ（table・group・from・to・user）に入れる。
// - audit_logs を at desc・id desc で 50 件ずつ読み、続きは最後の行の at と id より前（キーセット）。件数は数えない。
// - 年度をまたぐ表（場所・品目・距離）を選んだときは、year_id が null の行も含める（RLS で開いている年度の admin だけに返る。
//   部門長・副部門長には年度の記録だけが返る。D-48）。
// - 変更の列は純粋関数 diffAudit（created_at・updated_at は除く）。純粋な関数は lib/data/history.test.ts で確かめる。
import { useInfiniteQuery, useQuery, type InfiniteData } from '@tanstack/react-query';
import { fetchAll } from '@/lib/db/fetch-all';
import { toAppError } from '@/lib/errors';
import { formatDateTime, tokyoStartOfDay, tokyoStartOfNextDay } from '@/lib/datetime';
import {
  AUDIT_TABLE_LABELS,
  CATEGORY_LABELS,
  CONSENT_STATUS_LABELS,
  GROUP_ROLE_LABELS,
  NOTICE_AUDIENCE_LABELS,
  ORIGIN_LABELS,
  ROLE_LABELS,
  ROOM_KIND_LABELS,
  RULE_KIND_LABELS,
  YEAR_STATUS_LABELS,
  labelOf,
} from '@/lib/labels';
import { EVENT_AUDIENCE_LABELS, EVENT_KIND_LABELS } from '@/lib/modules/calendar/labels';
import { queryKeys } from '@/lib/query';
import { uuidSchema } from '@/lib/schemas/common';
import { getSupabase, type AppSupabaseClient } from '@/lib/supabase/client';

// ---- 表・定数 ----

/** 履歴の表（絞り込みの並び。画面の設計 3.12 の順） */
export const AUDIT_TABLES = [
  'requests',
  'request_submissions',
  'stocks',
  'allocations',
  'substitution_consents',
  'rules',
  'years',
  'year_roles',
  'groups',
  'group_members',
  'room_years',
  'rooms',
  'items',
  'distance_overrides',
  // お知らせ（T17。足すだけ）
  'notices',
  'notice_groups',
  // 締切と予定（T18。足すだけ）
  'events',
] as const;
export type AuditTable = (typeof AUDIT_TABLES)[number];

/** 年度をまたぐ表（year_id が null の行がある。02「audit_logs」） */
export const CROSS_YEAR_TABLES: readonly AuditTable[] = ['rooms', 'items', 'distance_overrides'];

/**
 * 表の選びの注（04「履歴」）。年度のない記録（場所・品目・距離）は、開いている年度の管理者にだけ RLS が返す（部門長・副部門長が
 * 選ぶと 0 件になるので、理由を出す。選択肢は残し、URL の table も読み替えない）。
 */
export function crossYearNote(adminOfOpenYear: boolean): string {
  return adminOfOpenYear
    ? '場所・品目・距離は年度をまたぐ表です（年度のない記録も出します）。'
    : '場所・品目・距離の記録（年度のない記録）は、開いている年度の管理者だけが見られます。';
}

/** 1回に読む件数 */
export const HISTORY_PAGE_SIZE = 50;

/** 変更の列に出さない列 */
export const DIFF_IGNORED_KEYS: readonly string[] = ['created_at', 'updated_at'];

/** した人が「アプリの外（SQL・seed）」の行を選ぶ値（URL の user=outside） */
export const OUTSIDE_USER = 'outside';

export const NAME_UNKNOWN = '名前を表示できません';
export const OUTSIDE_LABEL = 'SQL・seed（アプリの外）';

export const AUDIT_ACTIONS = { insert: '追加', update: '変更', delete: '削除' } as const;
export type AuditAction = keyof typeof AUDIT_ACTIONS;

export function isAuditTable(v: string): v is AuditTable {
  return (AUDIT_TABLES as readonly string[]).includes(v);
}

export function tableLabel(table: string): string {
  return labelOf(AUDIT_TABLE_LABELS, table, table);
}

// ---- 絞り込み（URL） ----

export interface HistoryFilter {
  /** 空なら全部の表（年度の行だけ） */
  tables: AuditTable[];
  groupId: string | null;
  /** Asia/Tokyo の日付（YYYY-MM-DD。その日を含む） */
  from: string | null;
  to: string | null;
  /** 利用者の id か OUTSIDE_USER */
  user: string | null;
}

export const EMPTY_FILTER: HistoryFilter = { tables: [], groupId: null, from: null, to: null, user: null };

interface ParamsLike {
  get(name: string): string | null;
}

/** 実在する日付の `YYYY-MM-DD` か */
export function isDateParam(v: string | null | undefined): v is string {
  if (!v || !/^\d{4}-\d{2}-\d{2}$/.test(v)) return false;
  const d = new Date(`${v}T00:00:00Z`);
  return !Number.isNaN(d.getTime()) && d.toISOString().slice(0, 10) === v;
}

/**
 * URL のクエリから絞り込みを読む。合わない値は無視して既定にする（画面の設計 1.2）。
 * table はカンマ区切り（知らない表は捨て、並びは AUDIT_TABLES の順にそろえる）。from が to より後なら入れ替える。
 */
export function parseHistoryParams(params: ParamsLike): HistoryFilter {
  const raw = (params.get('table') ?? '').split(',').map((s) => s.trim());
  const picked = new Set(raw.filter(isAuditTable));
  const tables = AUDIT_TABLES.filter((t) => picked.has(t));
  const group = params.get('group');
  const groupId = group && uuidSchema.safeParse(group).success ? group : null;
  let from = isDateParam(params.get('from')) ? params.get('from') : null;
  let to = isDateParam(params.get('to')) ? params.get('to') : null;
  if (from && to && from > to) [from, to] = [to, from];
  const u = params.get('user');
  const user = u === OUTSIDE_USER || (u && uuidSchema.safeParse(u).success) ? u : null;
  return { tables, groupId, from, to, user };
}

/** 絞り込み → `/history` の URL（条件のない項目は入れない） */
export function historyHref(f: HistoryFilter): string {
  const q = new URLSearchParams();
  if (f.tables.length > 0) q.set('table', f.tables.join(','));
  if (f.groupId) q.set('group', f.groupId);
  if (f.from) q.set('from', f.from);
  if (f.to) q.set('to', f.to);
  if (f.user) q.set('user', f.user);
  const s = q.toString();
  return s ? `/history?${s}` : '/history';
}

export function hasFilter(f: HistoryFilter): boolean {
  return f.tables.length > 0 || !!f.groupId || !!f.from || !!f.to || !!f.user;
}

/**
 * 変更が 0 件のときの説明（04「履歴」）。年度をまたぐ表（場所・品目・距離）だけを選んでいて、開いている年度の管理者でなければ
 * （総務部門長・総務副部門長）、年度のない記録を RLS が返さないので、見られない理由（crossYearNote）を先に出す。
 * ほかは、絞り込みがあれば変えるか消すよう促す（なければ undefined）。
 */
export function historyEmptyNote(f: HistoryFilter, adminOfOpenYear: boolean): string | undefined {
  const onlyCrossYear = f.tables.length > 0 && f.tables.every((t) => CROSS_YEAR_TABLES.includes(t));
  if (onlyCrossYear && !adminOfOpenYear) return `${crossYearNote(false)}絞り込みを変えるか、消してください。`;
  return hasFilter(f) ? '絞り込みを変えるか、消してください。' : undefined;
}

// ---- 問い合わせ ----

/** 続きの読み始め（最後の行の at と id） */
export interface HistoryCursor {
  at: string;
  id: number;
}

/** PostgREST の論理式の中の値（at の `+`・`:`・`.` をそのまま渡すため二重引用符で囲む） */
function quoted(v: string): string {
  return `"${v.replace(/\\/g, '\\\\').replace(/"/g, '\\"')}"`;
}

/** 問い合わせに付ける条件（PostgREST の演算子。テストで確かめるため、問い合わせを作る前の形で返す） */
export type HistoryCondition =
  | { op: 'eq'; column: string; value: string }
  | { op: 'is'; column: string; value: null }
  | { op: 'in'; column: string; values: string[] }
  | { op: 'gte' | 'lt' | 'lte'; column: string; value: string }
  | { op: 'or'; expr: string };

/**
 * 絞り込みと続きの読み始めから、audit_logs への問い合わせ（1つか2つ）の条件を作る。
 * - 年度の行：year_id = 年度。年度をまたぐ表（場所・品目・距離）の行は year_id が null なので、それらの表を選んだときは
 *   `year_id is null` の問い合わせを別に作る（`or(year_id.eq.{年度},year_id.is.null)` の1つにすると、索引で並べたまま読めず、
 *   当てはまる行を全部読んで RLS の関数を行ごとに呼んでから並べ替えるため遅い。10 万行で 183 ms。notes/T14.md）。
 *   年度をまたぐ表は団体を持たないので、団体で絞るときは作らない。
 * - 期間：from の 0 時以上、to の次の日の 0 時より前（Asia/Tokyo。画面の設計 2.8）。
 * - 続き：`at <= {at}` と `or(at.lt.{at},and(at.eq.{at},id.lt.{id}))`（at desc・id desc の並びで、最後の行より後ろ。
 *   `at <=` は索引の範囲に使わせるため。or だけだと先頭から読み飛ばすので、深いページほど遅くなる）。
 */
export function historyQueries(yearId: string, f: HistoryFilter, cursor: HistoryCursor | null = null): HistoryCondition[][] {
  const crossTables = f.tables.filter((t) => CROSS_YEAR_TABLES.includes(t));
  const yearTables = f.tables.filter((t) => !CROSS_YEAR_TABLES.includes(t));
  const common: HistoryCondition[] = [];
  if (f.groupId) common.push({ op: 'eq', column: 'group_id', value: f.groupId });
  if (f.from) common.push({ op: 'gte', column: 'at', value: tokyoStartOfDay(f.from) });
  if (f.to) common.push({ op: 'lt', column: 'at', value: tokyoStartOfNextDay(f.to) });
  if (f.user === OUTSIDE_USER) common.push({ op: 'is', column: 'user_id', value: null });
  else if (f.user) common.push({ op: 'eq', column: 'user_id', value: f.user });
  if (cursor) {
    const at = quoted(cursor.at);
    common.push({ op: 'lte', column: 'at', value: cursor.at });
    common.push({ op: 'or', expr: `at.lt.${at},and(at.eq.${at},id.lt.${cursor.id})` });
  }
  const tableCond = (tables: readonly AuditTable[]): HistoryCondition[] =>
    tables.length === 0 ? [] : tables.length === 1 ? [{ op: 'eq', column: 'table_name', value: tables[0]! }] : [{ op: 'in', column: 'table_name', values: [...tables] }];
  const out: HistoryCondition[][] = [];
  if (f.tables.length === 0 || yearTables.length > 0) {
    out.push([{ op: 'eq', column: 'year_id', value: yearId }, ...tableCond(yearTables), ...common]);
  }
  if (crossTables.length > 0 && !f.groupId) {
    out.push([{ op: 'is', column: 'year_id', value: null }, ...tableCond(crossTables), ...common]);
  }
  return out;
}

/** at（PostgREST の timestamptz の文字列）と id の並びのキー（マイクロ秒まで。Date はミリ秒までしか持たない） */
export function atMicros(at: string): number {
  const m = /^(.*T\d{2}:\d{2}:\d{2})(?:\.(\d+))?(Z|[+-]\d{2}(?::?\d{2})?)$/.exec(at);
  if (!m) return Date.parse(at) * 1000;
  let tz = m[3]!;
  if (tz !== 'Z') {
    const d = tz.replace(':', '');
    tz = `${d.slice(0, 3)}:${d.slice(3, 5) || '00'}`;
  }
  return Date.parse(`${m[1]}${tz}`) * 1000 + Number((m[2] ?? '').padEnd(6, '0').slice(0, 6));
}

/** at desc・id desc の並び */
export function compareHistoryRows(a: Pick<AuditLogRow, 'at' | 'id'>, b: Pick<AuditLogRow, 'at' | 'id'>): number {
  return atMicros(b.at) - atMicros(a.at) || b.id - a.id;
}

export interface AuditLogRow {
  id: number;
  table_name: string;
  row_pk: Record<string, unknown> | null;
  action: string;
  year_id: string | null;
  group_id: string | null;
  before: Record<string, unknown> | null;
  after: Record<string, unknown> | null;
  reason: string | null;
  user_id: string | null;
  at: string;
}

const AUDIT_COLS = 'id, table_name, row_pk, action, year_id, group_id, before, after, reason, user_id, at';

export interface HistoryPage {
  rows: AuditLogRow[];
  /** 続きがあれば、その読み始め */
  next: HistoryCursor | null;
}

// supabase-js の型付きのフィルタは列名の文字列を受け付けないので、条件を当てる所だけ緩い型にする
interface LooseFilter {
  eq(column: string, value: unknown): LooseFilter;
  is(column: string, value: null): LooseFilter;
  in(column: string, values: readonly unknown[]): LooseFilter;
  gte(column: string, value: unknown): LooseFilter;
  lt(column: string, value: unknown): LooseFilter;
  lte(column: string, value: unknown): LooseFilter;
  or(expr: string): LooseFilter;
  order(column: string, opts: { ascending: boolean }): LooseFilter;
  limit(n: number): PromiseLike<{ data: unknown[] | null; error: unknown; status?: number }>;
}

async function fetchRows(conds: readonly HistoryCondition[], client: AppSupabaseClient): Promise<AuditLogRow[]> {
  let q = client.from('audit_logs').select(AUDIT_COLS) as unknown as LooseFilter;
  for (const c of conds) {
    switch (c.op) {
      case 'eq':
        q = q.eq(c.column, c.value);
        break;
      case 'is':
        q = q.is(c.column, null);
        break;
      case 'in':
        q = q.in(c.column, c.values);
        break;
      case 'gte':
        q = q.gte(c.column, c.value);
        break;
      case 'lt':
        q = q.lt(c.column, c.value);
        break;
      case 'lte':
        q = q.lte(c.column, c.value);
        break;
      case 'or':
        q = q.or(c.expr);
        break;
    }
  }
  const res = await q.order('at', { ascending: false }).order('id', { ascending: false }).limit(HISTORY_PAGE_SIZE + 1);
  if (res.error) throw toAppError(res.error, res.status);
  return (res.data ?? []) as AuditLogRow[];
}

/**
 * 1ページを読む（問い合わせごとに 51 件読み、合わせて at desc・id desc に並べた先頭の 50 件。51 件目があれば続きがある。
 * 件数は数えない）。問い合わせが2つ（年度の行と年度のない行）でも、それぞれの先頭 51 件を合わせれば全体の先頭 51 件になる。
 */
export async function fetchHistoryPage(
  yearId: string,
  f: HistoryFilter,
  cursor: HistoryCursor | null,
  client: AppSupabaseClient = getSupabase(),
): Promise<HistoryPage> {
  const parts = await Promise.all(historyQueries(yearId, f, cursor).map((conds) => fetchRows(conds, client)));
  const all = parts.flat().sort(compareHistoryRows).slice(0, HISTORY_PAGE_SIZE + 1);
  const rows = all.slice(0, HISTORY_PAGE_SIZE);
  const last = rows[rows.length - 1];
  return { rows, next: all.length > HISTORY_PAGE_SIZE && last ? { at: last.at, id: last.id } : null };
}

// ---- 名前（対象・した人・絞り込みの選択肢） ----

export interface HistoryMember {
  userId: string;
  /** 読めなければ null */
  displayName: string | null;
}

export interface HistoryLookups {
  groups: Map<string, string>;
  rooms: Map<string, string>;
  items: Map<string, string>;
  /** 利用者の表示名（読めた人だけ） */
  users: Map<string, string>;
  /** 年度の名前（開いている年度。year_id・prev_year_id の表示） */
  years: Map<string, string>;
}

export interface HistoryOptions {
  /** 年度の団体（sort_order → 名前 → id） */
  groups: { id: string; name: string; category: string }[];
  /** 年度のメンバー（ロールと団体代表。名前の順。読めない人は最後） */
  members: HistoryMember[];
  rooms: Map<string, string>;
  items: Map<string, string>;
}

const cmp = (a: string, b: string) => (a < b ? -1 : a > b ? 1 : 0);

/** 絞り込みの選択肢と、対象の名前に使う団体・場所・品目・メンバーを読む */
export async function fetchHistoryOptions(yearId: string, client: AppSupabaseClient = getSupabase()): Promise<HistoryOptions> {
  const [groups, roles, reps, rooms, items] = await Promise.all([
    fetchAll((from, to) =>
      client.from('groups').select('id, name, category, sort_order').eq('year_id', yearId).order('id').range(from, to),
    ),
    fetchAll((from, to) => client.from('year_roles').select('user_id').eq('year_id', yearId).order('user_id').range(from, to)),
    fetchAll((from, to) =>
      client
        .from('group_members')
        .select('group_id, user_id, groups!inner(year_id)')
        .eq('groups.year_id', yearId)
        .order('group_id')
        .order('user_id')
        .range(from, to),
    ),
    fetchAll((from, to) => client.from('rooms').select('id, name').order('id').range(from, to)),
    fetchAll((from, to) => client.from('items').select('id, name').order('id').range(from, to)),
  ]);
  const userIds = [...new Set([...roles.map((r) => r.user_id), ...(reps as { user_id: string }[]).map((r) => r.user_id)])];
  const names = await fetchUserNames(userIds, client);
  const members = userIds
    .map((userId) => ({ userId, displayName: names.get(userId) ?? null }))
    .sort((a, b) => (a.displayName ?? '￿').localeCompare(b.displayName ?? '￿', 'ja') || cmp(a.userId, b.userId));
  const sortedGroups = [...groups]
    .sort((a, b) => a.sort_order - b.sort_order || a.name.localeCompare(b.name, 'ja') || cmp(a.id, b.id))
    .map((g) => ({ id: g.id, name: g.name, category: g.category as string }));
  return {
    groups: sortedGroups,
    members,
    rooms: new Map(rooms.map((r) => [r.id, r.name])),
    items: new Map(items.map((i) => [i.id, i.name])),
  };
}

/** 利用者の表示名（profiles。RLS で読めない人は入らない） */
export async function fetchUserNames(userIds: readonly string[], client: AppSupabaseClient = getSupabase()): Promise<Map<string, string>> {
  const ids = [...new Set(userIds)].filter((id) => uuidSchema.safeParse(id).success).sort();
  if (ids.length === 0) return new Map();
  const res = await client.from('profiles').select('user_id, display_name').in('user_id', ids);
  if (res.error) throw toAppError(res.error, res.status);
  return new Map((res.data ?? []).map((p) => [p.user_id, p.display_name]));
}

/**
 * 今の年度にない団体（消えた団体）の名前を、その団体の履歴（groups の行の before・after の name）から引く。
 * 新しい記録の名前を使う。見つからなければ入らない。
 */
export async function fetchDeletedGroupNames(
  yearId: string,
  groupIds: readonly string[],
  client: AppSupabaseClient = getSupabase(),
): Promise<Map<string, string>> {
  const ids = [...new Set(groupIds)].filter((id) => uuidSchema.safeParse(id).success).sort();
  if (ids.length === 0) return new Map();
  const res = await client
    .from('audit_logs')
    .select('group_id, before, after')
    .eq('year_id', yearId)
    .eq('table_name', 'groups')
    .in('group_id', ids)
    .order('at', { ascending: false })
    .order('id', { ascending: false });
  if (res.error) throw toAppError(res.error, res.status);
  const out = new Map<string, string>();
  for (const r of (res.data ?? []) as { group_id: string | null; before: unknown; after: unknown }[]) {
    if (!r.group_id || out.has(r.group_id)) continue;
    const name = nameIn(r.after) ?? nameIn(r.before);
    if (name) out.set(r.group_id, name);
  }
  return out;
}

function nameIn(v: unknown): string | null {
  if (!v || typeof v !== 'object') return null;
  const n = (v as Record<string, unknown>).name;
  return typeof n === 'string' && n.trim() ? n : null;
}

// ---- 差（変更の列） ----

export interface DiffEntry {
  key: string;
  /** 前の値（追加では undefined） */
  before: unknown;
  /** 後の値（削除では undefined） */
  after: unknown;
}

/** JSON の値が同じか（オブジェクトのキーの順によらない） */
function sameJson(a: unknown, b: unknown): boolean {
  if (a === b) return true;
  if (a === null || b === null || typeof a !== 'object' || typeof b !== 'object') return false;
  if (Array.isArray(a) !== Array.isArray(b)) return false;
  if (Array.isArray(a) && Array.isArray(b)) return a.length === b.length && a.every((x, i) => sameJson(x, b[i]));
  const ka = Object.keys(a as object);
  const kb = Object.keys(b as object);
  if (ka.length !== kb.length) return false;
  return ka.every((k) => Object.hasOwn(b as object, k) && sameJson((a as Record<string, unknown>)[k], (b as Record<string, unknown>)[k]));
}

function asRecord(v: unknown): Record<string, unknown> | null {
  return v && typeof v === 'object' && !Array.isArray(v) ? (v as Record<string, unknown>) : null;
}

/**
 * before と after の差（画面の設計 3.12）。値の違う列だけを、列名の順で返す。created_at・updated_at は除く。
 * 追加（before が null）は after の全部の列、削除（after が null）は before の全部の列。どちらにもない列は、ないほうを undefined にする。
 */
export function diffAudit(before: unknown, after: unknown): DiffEntry[] {
  const b = asRecord(before);
  const a = asRecord(after);
  const keys = new Set([...Object.keys(b ?? {}), ...Object.keys(a ?? {})]);
  const out: DiffEntry[] = [];
  for (const key of [...keys].sort(cmp)) {
    if (DIFF_IGNORED_KEYS.includes(key)) continue;
    const bv = b && Object.hasOwn(b, key) ? b[key] : undefined;
    const av = a && Object.hasOwn(a, key) ? a[key] : undefined;
    if (b && a && sameJson(bv, av)) continue;
    out.push({ key, before: b ? bv : undefined, after: a ? av : undefined });
  }
  return out;
}

const UUID_REF_KEYS: Readonly<Record<string, 'groups' | 'rooms' | 'items'>> = {
  group_id: 'groups',
  room_id: 'rooms',
  location_room_id: 'rooms',
  source_room_id: 'rooms',
  item_id: 'items',
  from_item_id: 'items',
  to_item_id: 'items',
  requested_item_id: 'items',
};

const ENUM_LABELS: Readonly<Record<string, Readonly<Record<string, string>>>> = {
  category: CATEGORY_LABELS,
  // ロール（year_roles.role）。団体代表の立場（group_members.role）は formatAuditValue で GROUP_ROLE_LABELS にする
  role: ROLE_LABELS,
  // 招待の立場（invitations.group_role。invitations は監査しないので今は出ない。T15b の守り）
  group_role: GROUP_ROLE_LABELS,
  origin: ORIGIN_LABELS,
  // お知らせの宛先（notices.audience。T17）
  audience: NOTICE_AUDIENCE_LABELS,
};

/** 値の表示（null は「なし」、真偽は「はい・いいえ」、参照は名前、日時は Asia/Tokyo、列挙は日本語） */
export function formatAuditValue(table: string, key: string, v: unknown, lookups?: Partial<HistoryLookups>): string {
  if (v === undefined) return '';
  if (v === null) return 'なし';
  if (typeof v === 'boolean') return v ? 'はい' : 'いいえ';
  if (typeof v === 'number') return String(v);
  if (typeof v === 'string') {
    const ref = UUID_REF_KEYS[key];
    if (ref) return lookups?.[ref]?.get(v) ?? v;
    if (key === 'year_id' || key === 'prev_year_id') return lookups?.years?.get(v) ?? v;
    if (key === 'user_id' || key === 'counted_by' || key === 'updated_by' || key === 'created_by') return lookups?.users?.get(v) ?? NAME_UNKNOWN;
    if (key === 'status') {
      if (table === 'years') return labelOf(YEAR_STATUS_LABELS, v, v);
      if (table === 'substitution_consents') return labelOf(CONSENT_STATUS_LABELS, v, v);
    }
    if (key === 'kind') {
      if (table === 'rules') return labelOf(RULE_KIND_LABELS, v, v);
      if (table === 'rooms') return labelOf(ROOM_KIND_LABELS, v, v);
      // 締切と予定の種類（events.kind。T18）
      if (table === 'events') return labelOf(EVENT_KIND_LABELS, v, v);
    }
    // 締切と予定の対象（events.audience。T18）。下の ENUM_LABELS の audience（お知らせの宛先）より先に表で分ける
    // （groups を「指定の団体」と出さない）
    if (key === 'audience' && table === 'events') return labelOf(EVENT_AUDIENCE_LABELS, v, v);
    // 団体代表の行の role は店長・副店長（group_role）。ほかの表（year_roles）の role はロールの表示名（下の ENUM_LABELS）
    if (key === 'role' && table === 'group_members') return labelOf(GROUP_ROLE_LABELS, v, v);
    const labels = ENUM_LABELS[key];
    if (labels) return labelOf(labels, v, v);
    if (/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}/.test(v)) return formatDateTime(v) || v;
    return v;
  }
  if (Array.isArray(v) && v.every((x) => typeof x === 'string' || typeof x === 'number')) return v.length === 0 ? '（空）' : v.join('、');
  return JSON.stringify(v);
}

/** 差の1行（「count：3 → 5」。追加は「count：5」、削除は「count：3（削除前）」） */
export function formatDiffEntry(table: string, d: DiffEntry, lookups?: Partial<HistoryLookups>): string {
  const bv = formatAuditValue(table, d.key, d.before, lookups);
  const av = formatAuditValue(table, d.key, d.after, lookups);
  if (d.before === undefined) return `${d.key}：${av}`;
  if (d.after === undefined) return `${d.key}：${bv}（削除前）`;
  return `${d.key}：${bv} → ${av}`;
}

/** 操作の日本語（追加・変更・削除） */
export function actionLabel(action: string): string {
  return Object.hasOwn(AUDIT_ACTIONS, action) ? AUDIT_ACTIONS[action as AuditAction] : action;
}

/** した人（user_id が null は SQL・seed、読めなければ「名前を表示できません」） */
export function actorLabel(userId: string | null, users: ReadonlyMap<string, string> | undefined): string {
  if (userId === null) return OUTSIDE_LABEL;
  return users?.get(userId) ?? NAME_UNKNOWN;
}

/**
 * 対象（団体・部屋・品目の名前など）。行の値（after、なければ before）と row_pk から引く。
 * 団体は今の年度の団体の名前、なければ（消えた団体）記録の中の名前（groups の行の name・消えた団体の名前の表）。
 */
export function auditTarget(row: Pick<AuditLogRow, 'table_name' | 'row_pk' | 'before' | 'after' | 'group_id'>, lookups: Partial<HistoryLookups>): string {
  const data: Record<string, unknown> = { ...(asRecord(row.row_pk) ?? {}), ...(asRecord(row.before) ?? {}), ...(asRecord(row.after) ?? {}) };
  const str = (k: string): string | null => (typeof data[k] === 'string' ? (data[k] as string) : null);
  const group = (id: string | null): string | null => (id ? (lookups.groups?.get(id) ?? null) : null);
  const room = (id: string | null): string | null => (id ? (lookups.rooms?.get(id) ?? '（消えた場所）') : null);
  const item = (id: string | null): string | null => (id ? (lookups.items?.get(id) ?? '（消えた品目）') : null);
  const user = (id: string | null): string | null => (id ? (lookups.users?.get(id) ?? NAME_UNKNOWN) : null);
  const groupName = (id: string | null) => group(id) ?? (id ? '（消えた団体）' : null);
  const parts: (string | null)[] = (() => {
    switch (row.table_name) {
      case 'groups':
        return [group(str('id')) ?? str('name')];
      case 'requests':
      case 'request_submissions':
        return [groupName(str('group_id')), item(str('item_id'))];
      case 'allocations':
        return [groupName(str('group_id')), item(str('item_id')), str('source_room_id') ? `運び元 ${room(str('source_room_id'))}` : null];
      case 'substitution_consents':
        return [groupName(str('group_id')), str('from_item_id') ? `${item(str('from_item_id'))} → ${item(str('to_item_id'))}` : null];
      case 'group_members':
        return [groupName(str('group_id')), user(str('user_id'))];
      case 'stocks':
        return [room(str('room_id')), item(str('item_id'))];
      case 'room_years':
        return [room(str('room_id'))];
      case 'rooms':
        return [lookups.rooms?.get(str('id') ?? '') ?? str('name')];
      case 'items':
        return [lookups.items?.get(str('id') ?? '') ?? str('name')];
      case 'distance_overrides':
        return [str('building_a') && str('building_b') ? `${str('building_a')}・${str('building_b')}` : null];
      case 'rules':
        return [str('code')];
      case 'years':
        return [str('label')];
      case 'year_roles':
        return [user(str('user_id'))];
      // お知らせ（T17）：題名。宛先の団体の行は団体の名前
      case 'notices':
        return [str('title')];
      case 'notice_groups':
        return [groupName(str('group_id'))];
      // 締切と予定（T18）：題名
      case 'events':
        return [str('title')];
      default:
        return [];
    }
  })();
  return parts.filter((p): p is string => !!p).join('・');
}

// ---- React Query ----

function filterKey(f: HistoryFilter): string {
  return historyHref(f);
}

/** 絞り込みの選択肢・名前（5 分は読み直さない。画面の「読み直す」で読み直す） */
export function useHistoryOptions(yearId: string) {
  return useQuery({
    queryKey: queryKeys.yearPart(yearId, 'history', 'options'),
    queryFn: () => fetchHistoryOptions(yearId),
    staleTime: 5 * 60_000,
  });
}

/** 履歴のページ（「さらに読み込む」で次のページ） */
export function useHistoryPages(yearId: string, f: HistoryFilter) {
  return useInfiniteQuery<HistoryPage, Error, InfiniteData<HistoryPage, HistoryCursor | null>, readonly unknown[], HistoryCursor | null>({
    queryKey: queryKeys.yearPart(yearId, 'history', 'pages', filterKey(f)),
    queryFn: ({ pageParam }) => fetchHistoryPage(yearId, f, pageParam),
    initialPageParam: null,
    getNextPageParam: (last) => last.next,
  });
}

/** ページに出る利用者の名前と、消えた団体の名前（メンバーで引けない人・今の年度にない団体だけ読む） */
export function useHistoryNames(yearId: string, rows: readonly AuditLogRow[], options: HistoryOptions | undefined) {
  const known = new Set(options?.members.filter((m) => m.displayName !== null).map((m) => m.userId) ?? []);
  const userIds = new Set<string>();
  const groupIds = new Set<string>();
  const currentGroups = new Set(options?.groups.map((g) => g.id) ?? []);
  for (const r of rows) {
    for (const v of [
      r.user_id,
      asRecord(r.after)?.user_id,
      asRecord(r.before)?.user_id,
      asRecord(r.after)?.counted_by,
      asRecord(r.before)?.counted_by,
      asRecord(r.after)?.updated_by,
      asRecord(r.before)?.updated_by,
      // お知らせの書いた人（notices.created_by。T17）
      asRecord(r.after)?.created_by,
      asRecord(r.before)?.created_by,
    ]) {
      if (typeof v === 'string' && !known.has(v)) userIds.add(v);
    }
    if (r.group_id && !currentGroups.has(r.group_id)) groupIds.add(r.group_id);
  }
  const users = [...userIds].sort();
  const groups = [...groupIds].sort();
  return useQuery({
    queryKey: queryKeys.yearPart(yearId, 'history', 'names', users.join(','), groups.join(',')),
    queryFn: async () => {
      const [u, g] = await Promise.all([fetchUserNames(users), fetchDeletedGroupNames(yearId, groups)]);
      return { users: u, groups: g };
    },
    enabled: !!options && (users.length > 0 || groups.length > 0),
    staleTime: 5 * 60_000,
  });
}
