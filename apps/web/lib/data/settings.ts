// マスタ設定（/settings）のデータの読み書き（画面の設計 2.1・2.3・3.2。T09）。
// 読む：年度の行・rooms・room_years・items・groups・distance_overrides・rules（参照の確かめ）・メンバー（year_roles・group_members・
// invitations・profiles）。書く：rooms・room_years・items・groups・distance_overrides は直接（RLS の範囲）、年度・招待・ロールは RPC。
// 削除はすべて deleteChecked（0 行なら「削除しました」と出さない。2.3）。
import { checkGroupNames, type GroupCategory, type Json, type RuleKind, type TablesInsert, type TablesUpdate } from '@gaapp/shared';
import { fetchAll } from '@/lib/db/fetch-all';
import { deleteChecked } from '@/lib/db/delete-checked';
import {
  COLUMNS,
  type DistanceOverrideRow,
  type GroupRow,
  type ItemRow,
  type RoomRow,
  type RoomYearRow,
  type RuleDbRow,
  type YearRow,
} from '@/lib/db/types';
import { updateWithLock } from '@/lib/db/update-with-lock';
import { AppError, appError, isUnknownOutcome, toAppError } from '@/lib/errors';
import { isLockRejection, settleLockedWrite } from '@/lib/data/locked-save';
import { RULE_KIND_LABELS } from '@/lib/labels';
import { callRpc } from '@/lib/rpc';
import type { AppRole, YearSummary } from '@/lib/auth/membership';
import type { GroupCsvRow } from '@/lib/schemas/settings';
import { nameKey } from '@/lib/schemas/settings';
import { getSupabase, type AppSupabaseClient } from '@/lib/supabase/client';

// ---- タブ ----

export const SETTINGS_TABS = ['years', 'rooms', 'items', 'groups', 'distance', 'users', 'export'] as const;
export type SettingsTab = (typeof SETTINGS_TABS)[number];

export const SETTINGS_TAB_LABELS: Record<SettingsTab, string> = {
  years: '年度',
  rooms: '場所',
  items: '品目',
  groups: '団体',
  distance: '距離',
  users: 'ユーザー',
  export: '書き出し',
};

/** クエリの tab（合わない値は既定の years。1.1） */
export function parseSettingsTab(v: string | null | undefined): SettingsTab {
  return (SETTINGS_TABS as readonly string[]).includes(v ?? '') ? (v as SettingsTab) : 'years';
}

// ---- 並び（sort_order → 名前 → id。CLAUDE.md の約束） ----

const cmp = (a: string, b: string) => (a < b ? -1 : a > b ? 1 : 0);
export function bySortOrder<T extends { sort_order: number; name: string; id: string }>(a: T, b: T): number {
  return a.sort_order - b.sort_order || a.name.localeCompare(b.name, 'ja') || cmp(a.id, b.id);
}

// ---- ルールの参照（団体・場所の削除の前。2.7・3.2） ----

/** 参照を探すルールの行（DB の行。params は壊れていてもよい） */
export type RuleRefSource = Pick<RuleDbRow, 'id' | 'code' | 'kind' | 'params' | 'enabled'>;

export interface RuleRef {
  id: string;
  code: string;
  kind: RuleKind;
  enabled: boolean;
  /** 内容の文（「運び元の制限：この場所を運び元に含む」など） */
  summary: string;
}

export interface RuleRefs {
  /** 参照している有効なルール（あれば削除を押せなくする） */
  enabled: RuleRef[];
  /** 参照している無効なルール（削除は止めず、件数を添える） */
  disabled: RuleRef[];
}

const asRecord = (v: Json | unknown): Record<string, unknown> | null =>
  typeof v === 'object' && v !== null && !Array.isArray(v) ? (v as Record<string, unknown>) : null;
const strings = (v: unknown): string[] => (Array.isArray(v) ? v.filter((x): x is string => typeof x === 'string') : []);

/** その団体を参照する所（params.group と、DB の付け替えも見る params.groups） */
function refersGroup(params: Record<string, unknown>, groupId: string): boolean {
  return params.group === groupId || strings(params.groups).includes(groupId);
}

/** その場所を参照する所（source_restrict の rooms、keep の room） */
function refersRoom(params: Record<string, unknown>, roomId: string): boolean {
  return params.room === roomId || strings(params.rooms).includes(roomId);
}

function summaryOf(kind: RuleKind, target: 'group' | 'room', params: Record<string, unknown>): string {
  const label = RULE_KIND_LABELS[kind] ?? kind;
  if (target === 'group') {
    if (kind === 'fixed_request' && typeof params.item === 'string') return `${label}：この団体の ${params.item} を固定`;
    if (kind === 'keep') return `${label}：この団体の使用場所の備品を残す`;
    if (kind === 'source_restrict') return `${label}：この団体の運び元を制限`;
    return `${label}：この団体を対象にする`;
  }
  if (kind === 'keep') return `${label}：この場所の備品を残す`;
  if (kind === 'source_restrict') return `${label}：この場所を運び元に含む`;
  return `${label}：この場所を参照する`;
}

/**
 * 団体か場所を参照するルール（rules.params の group・groups・room・rooms。jsonb で外部キーがないので、消すと参照の切れたルールが残り
 * validate が例外になる。2.7）。有効と無効に分け、コードの順に返す。params が壊れていても読める所だけで判定する。純粋関数。
 *
 * @example
 * const refs = rulesReferencing(rules, { groupId: g.id });
 * const blocked = refs.enabled.length > 0;   // 削除のボタンを押せなくする
 */
export function rulesReferencing(
  rules: readonly RuleRefSource[],
  target: { groupId: string } | { roomId: string },
): RuleRefs {
  const out: RuleRefs = { enabled: [], disabled: [] };
  const sorted = [...rules].sort((a, b) => cmp(a.code, b.code) || cmp(a.id, b.id));
  for (const r of sorted) {
    const params = asRecord(r.params);
    if (!params) continue;
    const isGroup = 'groupId' in target;
    const hit = isGroup ? refersGroup(params, target.groupId) : refersRoom(params, target.roomId);
    if (!hit) continue;
    const ref: RuleRef = { id: r.id, code: r.code, kind: r.kind, enabled: r.enabled, summary: summaryOf(r.kind, isGroup ? 'group' : 'room', params) };
    (r.enabled ? out.enabled : out.disabled).push(ref);
  }
  return out;
}

// ---- 場所の削除の前：終了していない年度のルール（2.7・3.2） ----

/**
 * 場所（全年度で共有）を参照するルールを探す年度。終了していない年度のうち、ルールを読める年度（その年度の admin・staff。
 * rules の RLS）と、読めない年度（団体代表・閲覧のみ）に分ける。1日目の新しい順。ロールも団体代表もない年度は years を読めないので
 * ここに出てこない（画面では確かめられない。DB での強制は notes/T09.md の申し送り）。純粋関数。
 */
export function openYearsForRoomRefs(
  years: readonly YearSummary[],
  roles: readonly { year_id: string; role: AppRole }[],
): { readable: YearSummary[]; unreadable: YearSummary[] } {
  const canRead = new Set(roles.filter((r) => r.role === 'admin' || r.role === 'staff').map((r) => r.year_id));
  const open = years
    .filter((y) => y.status !== 'closed')
    .sort((a, b) => cmp(b.festival_start, a.festival_start) || cmp(b.label, a.label) || cmp(b.id, a.id));
  return { readable: open.filter((y) => canRead.has(y.id)), unreadable: open.filter((y) => !canRead.has(y.id)) };
}

export interface RoomRuleRefs {
  /** 参照しているルールがある年度だけ（年度の順） */
  byYear: { year: YearSummary; refs: RuleRefs }[];
  /** 参照している有効なルールの数（すべての年度。1以上なら削除を押せない） */
  enabledCount: number;
  /** ルールを読めなかった終了していない年度（削除の前に知らせる） */
  unreadable: YearSummary[];
}

/** 終了していない年度のルールから、その場所を参照するものを年度ごとに探す（rulesReferencing を年度ごとに）。純粋関数 */
export function roomRefsAcrossYears(
  rules: readonly (RuleRefSource & { year_id: string })[],
  scope: { readable: readonly YearSummary[]; unreadable: readonly YearSummary[] },
  roomId: string,
): RoomRuleRefs {
  const byYear = scope.readable.flatMap((year) => {
    const refs = rulesReferencing(
      rules.filter((r) => r.year_id === year.id),
      { roomId },
    );
    return refs.enabled.length + refs.disabled.length > 0 ? [{ year, refs }] : [];
  });
  return {
    byYear,
    enabledCount: byYear.reduce((n, y) => n + y.refs.enabled.length, 0),
    unreadable: [...scope.unreadable],
  };
}

/**
 * 終了していない年度のうち読める年度のルールを読む（場所の削除の前）。年度と自分のロールを読み直してから（開いた後に年度が
 * 作られた・終了した・ロールが変わったときも、その時点の年度で確かめる）、読める年度のルールを1回で読む。
 */
export async function fetchOpenYearRules(
  userId: string,
  client: AppSupabaseClient = getSupabase(),
): Promise<{ scope: { readable: YearSummary[]; unreadable: YearSummary[] }; rules: RuleDbRow[] }> {
  const [years, roles] = await Promise.all([
    client.from('years').select('id, label, status, festival_start'),
    client.from('year_roles').select('year_id, role').eq('user_id', userId),
  ]);
  if (years.error) throw toAppError(years.error, years.status);
  if (roles.error) throw toAppError(roles.error, roles.status);
  const scope = openYearsForRoomRefs((years.data ?? []) as YearSummary[], roles.data ?? []);
  if (scope.readable.length === 0) return { scope, rules: [] };
  const ids = scope.readable.map((y) => y.id);
  const rules = await fetchAll((from, to) =>
    client.from('rules').select(COLUMNS.rules).in('year_id', ids).order('id').range(from, to),
  );
  return { scope, rules: rules as unknown as RuleDbRow[] };
}

/**
 * 削除の確かめに使える読み込みの結果。読み直し中（前の結果）と、読み直しの失敗（isError でも前の data が残る）では使わない
 * （一度読めた後に開き直して読み直しが失敗したとき、古いルールで削除を押せてしまうため）。純粋関数。
 */
export function freshDataOf<T>(q: { data: T | undefined; isFetching: boolean; isError: boolean }): T | null {
  return q.data !== undefined && !q.isFetching && !q.isError ? q.data : null;
}

// ---- 終了した年度の「年度を開く」の行き先（GlobalReadOnlyNote） ----

/** 自分の年度のロール（year_roles。自分の行だけ） */
export async function fetchMyYearRoles(
  userId: string,
  client: AppSupabaseClient = getSupabase(),
): Promise<{ year_id: string; role: AppRole }[]> {
  const res = await client.from('year_roles').select('year_id, role').eq('user_id', userId);
  if (res.error) throw toAppError(res.error, res.status);
  return (res.data ?? []) as { year_id: string; role: AppRole }[];
}

/**
 * 終了した年度で、場所・品目・距離を直しに行く年度：自分の年度（years。Membership.years）のうち、自分が admin で終了していない
 * 最新の年度（1日目の新しい順。同じなら年度名・id の逆順）。部員・閲覧のみ・団体代表だけの年度は開いても直せないので選ばない。
 * なければ null（ボタンを出さない）。純粋関数。
 */
export function latestAdminOpenYear(
  years: readonly YearSummary[],
  roles: readonly { year_id: string; role: AppRole }[],
): YearSummary | null {
  const admin = new Set(roles.filter((r) => r.role === 'admin').map((r) => r.year_id));
  const open = years
    .filter((y) => y.status !== 'closed' && admin.has(y.id))
    .sort((a, b) => cmp(b.festival_start, a.festival_start) || cmp(b.label, a.label) || cmp(b.id, a.id));
  return open[0] ?? null;
}

// ---- 年度 ----

/** 年度の変更の patch（変えたキーだけ。日時は同じ時刻なら変えていない扱い） */
export function yearPatch(
  year: Pick<YearRow, 'label' | 'festival_start' | 'request_open_at' | 'request_close_at'>,
  next: { label: string; festival_start: string; request_open_at: string | null; request_close_at: string | null },
): Partial<typeof next> {
  const sameTime = (a: string | null, b: string | null) =>
    a === null || b === null ? a === b : Date.parse(a) === Date.parse(b);
  const patch: Partial<typeof next> = {};
  if (next.label !== year.label) patch.label = next.label;
  if (next.festival_start !== year.festival_start) patch.festival_start = next.festival_start;
  if (!sameTime(next.request_open_at, year.request_open_at)) patch.request_open_at = next.request_open_at;
  if (!sameTime(next.request_close_at, year.request_close_at)) patch.request_close_at = next.request_close_at;
  return patch;
}

/**
 * 新しい年度を作る（create_year_from。複製元は開いている年度）。作った後に、複製元で有効だったのに新しい年度で無効になったルール
 * （付け替えられなかったもの。memo に理由が入る）を数える。
 */
export async function createYearFrom(
  prev: Pick<YearRow, 'id'>,
  label: string,
  festivalStart: string,
  client: AppSupabaseClient = getSupabase(),
): Promise<{ year: YearRow; disabledRuleCodes: string[] }> {
  const created = await callRpc('create_year_from', { p_prev_year_id: prev.id, p_label: label, p_festival_start: festivalStart }, client);
  const year = created as unknown as YearRow;
  const [before, after] = await Promise.all([
    client.from('rules').select('code, enabled').eq('year_id', prev.id),
    client.from('rules').select('code, enabled').eq('year_id', year.id),
  ]);
  if (before.error) throw toAppError(before.error, before.status);
  if (after.error) throw toAppError(after.error, after.status);
  const wasEnabled = new Set((before.data ?? []).filter((r) => r.enabled).map((r) => r.code));
  const disabledRuleCodes = (after.data ?? [])
    .filter((r) => !r.enabled && wasEnabled.has(r.code))
    .map((r) => r.code)
    .sort(cmp);
  return { year, disabledRuleCodes };
}

// ---- 読む ----

export async function fetchRooms(client: AppSupabaseClient = getSupabase()): Promise<RoomRow[]> {
  const res = await client.from('rooms').select(COLUMNS.rooms).order('sort_order').order('id');
  if (res.error) throw toAppError(res.error, res.status);
  return ((res.data ?? []) as unknown as RoomRow[]).sort(bySortOrder);
}

export async function fetchRoomYears(yearId: string, client: AppSupabaseClient = getSupabase()): Promise<RoomYearRow[]> {
  const res = await client.from('room_years').select(COLUMNS.room_years).eq('year_id', yearId).order('room_id');
  if (res.error) throw toAppError(res.error, res.status);
  return (res.data ?? []) as unknown as RoomYearRow[];
}

export async function fetchItems(client: AppSupabaseClient = getSupabase()): Promise<ItemRow[]> {
  const res = await client.from('items').select(COLUMNS.items).order('sort_order').order('id');
  if (res.error) throw toAppError(res.error, res.status);
  return ((res.data ?? []) as unknown as ItemRow[]).sort(
    (a, b) => a.sort_order - b.sort_order || a.name.localeCompare(b.name, 'ja') || cmp(a.id, b.id),
  );
}

export async function fetchGroups(yearId: string, client: AppSupabaseClient = getSupabase()): Promise<GroupRow[]> {
  const res = await client.from('groups').select(COLUMNS.groups).eq('year_id', yearId).order('sort_order').order('id');
  if (res.error) throw toAppError(res.error, res.status);
  return ((res.data ?? []) as unknown as GroupRow[]).sort(bySortOrder);
}

export async function fetchDistanceOverrides(client: AppSupabaseClient = getSupabase()): Promise<DistanceOverrideRow[]> {
  const res = await client.from('distance_overrides').select(COLUMNS.distance_overrides).order('building_a').order('building_b');
  if (res.error) throw toAppError(res.error, res.status);
  return (res.data ?? []) as unknown as DistanceOverrideRow[];
}

/** 年度のルール（無効を含む。団体・場所の削除の前の参照の確かめに使う） */
export async function fetchRules(yearId: string, client: AppSupabaseClient = getSupabase()): Promise<RuleDbRow[]> {
  const res = await client.from('rules').select(COLUMNS.rules).eq('year_id', yearId).order('code').order('id');
  if (res.error) throw toAppError(res.error, res.status);
  return (res.data ?? []) as unknown as RuleDbRow[];
}

/** 振り分けの行の運び元（使用不可にする前の確かめ。3.2・3.9）：場所ごとの全行の数と、固定・手動の行の数 */
export interface AllocationSources {
  all: Map<string, number>;
  fixed: Map<string, number>;
}

export async function fetchAllocationSources(yearId: string, client: AppSupabaseClient = getSupabase()): Promise<AllocationSources> {
  const rows = await fetchAll((from, to) =>
    client.from('allocations').select('id, source_room_id, origin, pinned').eq('year_id', yearId).order('id').range(from, to),
  );
  const all = new Map<string, number>();
  const fixed = new Map<string, number>();
  for (const r of rows) {
    all.set(r.source_room_id, (all.get(r.source_room_id) ?? 0) + 1);
    if (r.pinned || r.origin === 'manual') fixed.set(r.source_room_id, (fixed.get(r.source_room_id) ?? 0) + 1);
  }
  return { all, fixed };
}

// ---- メンバー（ユーザーのタブ） ----

export interface MemberRow {
  userId: string;
  /** profiles の表示名。読めなければ null（「名前を表示できません」） */
  displayName: string | null;
  role: AppRole | null;
  roleUpdatedAt: string | null;
  /** 代表する団体（この年度） */
  groups: { id: string; name: string }[];
}

export interface InvitationRow {
  id: string;
  email: string;
  role: AppRole | null;
  groupId: string | null;
  usedAt: string | null;
  createdAt: string;
}

export interface Members {
  members: MemberRow[];
  invitations: InvitationRow[];
  /** 団体ごとの代表者の数 */
  repCount: Map<string, number>;
}

const ROLE_ORDER: Record<AppRole, number> = { admin: 0, staff: 1, viewer: 2 };

/** 年度のメンバー（ロールと団体代表）と招待を読む（admin だけが全部を読める） */
export async function fetchMembers(yearId: string, client: AppSupabaseClient = getSupabase()): Promise<Members> {
  const [roles, reps, invs] = await Promise.all([
    client.from('year_roles').select('user_id, role, updated_at').eq('year_id', yearId).order('user_id'),
    client
      .from('group_members')
      .select('group_id, user_id, groups!inner(year_id, name)')
      .eq('groups.year_id', yearId)
      .order('group_id')
      .order('user_id'),
    client
      .from('invitations')
      .select('id, email, role, group_id, used_at, created_at')
      .eq('year_id', yearId)
      .order('created_at')
      .order('id'),
  ]);
  for (const r of [roles, reps, invs]) if (r.error) throw toAppError(r.error, r.status);
  const repRows = (reps.data ?? []) as unknown as { group_id: string; user_id: string; groups: { name: string } }[];
  const userIds = [...new Set([...(roles.data ?? []).map((r) => r.user_id), ...repRows.map((r) => r.user_id)])];
  const names = new Map<string, string>();
  if (userIds.length > 0) {
    const prof = await client.from('profiles').select('user_id, display_name').in('user_id', userIds);
    if (prof.error) throw toAppError(prof.error, prof.status);
    for (const p of prof.data ?? []) names.set(p.user_id, p.display_name);
  }
  const byUser = new Map<string, MemberRow>();
  const memberOf = (userId: string): MemberRow => {
    let m = byUser.get(userId);
    if (!m) {
      m = { userId, displayName: names.get(userId) ?? null, role: null, roleUpdatedAt: null, groups: [] };
      byUser.set(userId, m);
    }
    return m;
  };
  for (const r of roles.data ?? []) {
    const m = memberOf(r.user_id);
    m.role = r.role;
    m.roleUpdatedAt = r.updated_at;
  }
  const repCount = new Map<string, number>();
  for (const r of repRows) {
    memberOf(r.user_id).groups.push({ id: r.group_id, name: r.groups.name });
    repCount.set(r.group_id, (repCount.get(r.group_id) ?? 0) + 1);
  }
  const members = [...byUser.values()].sort(
    (a, b) =>
      (a.role ? ROLE_ORDER[a.role] : 9) - (b.role ? ROLE_ORDER[b.role] : 9) ||
      (a.displayName ?? '￿').localeCompare(b.displayName ?? '￿', 'ja') ||
      cmp(a.userId, b.userId),
  );
  for (const m of members) m.groups.sort((a, b) => a.name.localeCompare(b.name, 'ja') || cmp(a.id, b.id));
  const invitations = (invs.data ?? []).map((i) => ({
    id: i.id,
    email: i.email,
    role: i.role,
    groupId: i.group_id,
    usedAt: i.used_at,
    createdAt: i.created_at,
  }));
  return { members, invitations, repCount };
}

// ---- 書く（直接。RLS の範囲） ----

async function insertOne<T>(
  client: AppSupabaseClient,
  table: 'rooms' | 'items' | 'groups' | 'distance_overrides',
  values: unknown,
  columns: string,
): Promise<T> {
  const c = client as unknown as {
    from(t: string): { insert(v: unknown): { select(c: string): { maybeSingle(): PromiseLike<{ data: unknown; error: unknown; status?: number }> } } };
  };
  const res = await c.from(table).insert(values).select(columns).maybeSingle();
  if (res.error) throw toAppError(res.error, res.status);
  // RLS の with check で拒否された insert は 42501 になる。行が返らないのは読めない（権限が変わった）とき
  if (!res.data) throw appError('forbidden', 'lock_unchanged', { table });
  return res.data as T;
}

export type RoomValues = Omit<TablesInsert<'rooms'>, 'id' | 'created_at' | 'updated_at'>;
export type ItemValues = Omit<TablesInsert<'items'>, 'id' | 'created_at' | 'updated_at'>;
export type GroupValues = Omit<TablesInsert<'groups'>, 'id' | 'year_id' | 'created_at' | 'updated_at'>;

export const insertRoom = (v: RoomValues, client: AppSupabaseClient = getSupabase()) =>
  insertOne<RoomRow>(client, 'rooms', v, COLUMNS.rooms);
export const updateRoom = (row: Pick<RoomRow, 'id' | 'updated_at'>, patch: TablesUpdate<'rooms'>, client: AppSupabaseClient = getSupabase()) =>
  updateWithLock(client, 'rooms', { id: row.id }, row.updated_at, patch);
export const deleteRoom = (row: Pick<RoomRow, 'id' | 'updated_at'>, client: AppSupabaseClient = getSupabase()) =>
  deleteChecked(client, 'rooms', { id: row.id }, row.updated_at);

export const insertItem = (v: ItemValues, client: AppSupabaseClient = getSupabase()) =>
  insertOne<ItemRow>(client, 'items', v, COLUMNS.items);
export const updateItem = (row: Pick<ItemRow, 'id' | 'updated_at'>, patch: TablesUpdate<'items'>, client: AppSupabaseClient = getSupabase()) =>
  updateWithLock(client, 'items', { id: row.id }, row.updated_at, patch);

export const insertGroup = (yearId: string, v: GroupValues, client: AppSupabaseClient = getSupabase()) =>
  insertOne<GroupRow>(client, 'groups', { ...v, year_id: yearId }, COLUMNS.groups);
export const updateGroup = (row: Pick<GroupRow, 'id' | 'updated_at'>, patch: TablesUpdate<'groups'>, client: AppSupabaseClient = getSupabase()) =>
  updateWithLock(client, 'groups', { id: row.id }, row.updated_at, patch);
export const deleteGroup = (row: Pick<GroupRow, 'id' | 'updated_at'>, client: AppSupabaseClient = getSupabase()) =>
  deleteChecked(client, 'groups', { id: row.id }, row.updated_at);

export const insertDistance = (v: { building_a: string; building_b: string; cost: number }, client: AppSupabaseClient = getSupabase()) =>
  insertOne<DistanceOverrideRow>(client, 'distance_overrides', v, COLUMNS.distance_overrides);
export const updateDistance = (row: DistanceOverrideRow, cost: number, client: AppSupabaseClient = getSupabase()) =>
  updateWithLock(client, 'distance_overrides', { building_a: row.building_a, building_b: row.building_b }, row.updated_at, { cost });
export const deleteDistance = (row: DistanceOverrideRow, client: AppSupabaseClient = getSupabase()) =>
  deleteChecked(client, 'distance_overrides', { building_a: row.building_a, building_b: row.building_b }, row.updated_at);

// ---- 楽観ロックの更新・一意のキーの insert の読み直し（2.6 の (B1)） ----
// 応答が届かなかったとき（isUnknownOutcome）と、conflict・not_found・23505（isLockRejection）のときに、対象の行
// （更新は主キー、insert は一意のキー）を1回読み直し、settleLockedWrite（lib/data/locked-save.ts。T09a）で決める。
// 確かめるためだけの状態は持たない（次の保存はふつうに送る。前の送信が通っていれば DB が conflict・23505 で止める）。

/** 1行を読む（なければ null。失敗は AppError で投げる） */
async function readOne<T>(
  client: AppSupabaseClient,
  table: 'rooms' | 'items' | 'groups' | 'distance_overrides',
  columns: string,
  match: Record<string, string>,
): Promise<T | null> {
  const c = client as unknown as {
    from(t: string): {
      select(c: string): { match(m: Record<string, string>): { maybeSingle(): PromiseLike<{ data: unknown; error: unknown; status?: number }> } };
    };
  };
  const res = await c.from(table).select(columns).match(match).maybeSingle();
  if (res.error) throw toAppError(res.error, res.status);
  return (res.data as T | null) ?? null;
}

/** 場所を id で読む（更新の読み直し） */
export const readRoom = (id: string, client: AppSupabaseClient = getSupabase()) =>
  readOne<RoomRow>(client, 'rooms', COLUMNS.rooms, { id });
/** 場所を一意のキー（name）で読む（insert の読み直し） */
export const readRoomByName = (name: string, client: AppSupabaseClient = getSupabase()) =>
  readOne<RoomRow>(client, 'rooms', COLUMNS.rooms, { name });
/** 品目を id で読む */
export const readItem = (id: string, client: AppSupabaseClient = getSupabase()) =>
  readOne<ItemRow>(client, 'items', COLUMNS.items, { id });
/** 品目を一意のキー（code）で読む */
export const readItemByCode = (code: string, client: AppSupabaseClient = getSupabase()) =>
  readOne<ItemRow>(client, 'items', COLUMNS.items, { code });
/** 団体を id で読む */
export const readGroup = (id: string, client: AppSupabaseClient = getSupabase()) =>
  readOne<GroupRow>(client, 'groups', COLUMNS.groups, { id });
/** 団体を一意のキー（year_id, name）で読む */
export const readGroupByName = (yearId: string, name: string, client: AppSupabaseClient = getSupabase()) =>
  readOne<GroupRow>(client, 'groups', COLUMNS.groups, { year_id: yearId, name });

/** 2つの文字列を C の照合順序（コードポイントの順。UTF-8 のバイト順と同じ）で比べる */
function codePointCompare(a: string, b: string): number {
  const x = Array.from(a, (ch) => ch.codePointAt(0)!);
  const y = Array.from(b, (ch) => ch.codePointAt(0)!);
  for (let k = 0; k < Math.min(x.length, y.length); k += 1) if (x[k] !== y[k]) return x[k]! - y[k]!;
  return x.length - y.length;
}

/**
 * 建物の組を DB と同じ向きにする（トリガー normalize_pair：C の照合順序で小さい方を building_a に。D-15）。
 * insert の読み直しは、この向きの主キーで読む。純粋関数。
 */
export function distancePair(a: string, b: string): { building_a: string; building_b: string } {
  return codePointCompare(a, b) <= 0 ? { building_a: a, building_b: b } : { building_a: b, building_b: a };
}

/** 距離の上書きを建物の組で読む（向きは distancePair でそろえる。更新・insert の読み直し） */
export const readDistance = (a: string, b: string, client: AppSupabaseClient = getSupabase()) =>
  readOne<DistanceOverrideRow>(client, 'distance_overrides', COLUMNS.distance_overrides, distancePair(a, b));

function sameValue(a: unknown, b: unknown): boolean {
  if (Array.isArray(a) || Array.isArray(b)) {
    return Array.isArray(a) && Array.isArray(b) && a.length === b.length && a.every((x, k) => sameValue(x, b[k]));
  }
  // 送らなかった（undefined）と null は同じ（DB では null）
  return (a ?? null) === (b ?? null);
}

/**
 * 読み直した行の、書いた列（written のキー）が書いた値と同じか（settleLockedWrite の matches）。
 * written は送った値そのもの（フォームの zod で前後の空白を除き、空なら null にした後の値。DB はそのまま保存する）なので、
 * 書いたときと同じ正規化で比べることになる。配列（別名・申請できる区分）は順も含めて比べる。undefined の列は書いていない
 * ので比べない。純粋関数。
 */
export function matchesWritten(row: object, written: object): boolean {
  const r = row as Record<string, unknown>;
  return Object.entries(written).every(([k, v]) => v === undefined || sameValue(r[k], v));
}

/** runLockedWrite の結果 */
export type LockedWriteResult<Row> =
  /** 保存できた（earlier：応答が届かなかった・止められたが、読み直すと入力のとおりだった＝「保存されていました」） */
  | { kind: 'done'; earlier: boolean }
  /**
   * 今までの conflict の扱い（読み直した行を入力の元にして入力を残す）。row は読み直した行（なくなっていれば null）、
   * conflict は文言に使うエラー（止められたときはそのエラー、応答が届かなかったときは作ったもの）
   */
  | { kind: 'changed'; row: Row | null; conflict: AppError }
  /** 応答が届かず、保存されたか決められない（入力を残して unknownOutcomeMessage()） */
  | { kind: 'unknown'; error: unknown }
  /** 止められたが、読み直せなかった（入力を残し、「読み直せませんでした」と読み直すボタン） */
  | { kind: 'unread'; error: unknown }
  /** それ以外の失敗（forbidden・input など。2.5 の表のとおり） */
  | { kind: 'failed'; error: unknown };

export interface LockedWriteCall<Row extends { updated_at: string }> {
  /** 書き込み（updateWithLock・insert・setRoomUsable） */
  write: () => Promise<unknown>;
  /** 対象の行を1行読む（更新は主キー、insert は一意のキー。なければ null。失敗は投げる） */
  reread: () => Promise<Row | null>;
  /** 読み直した行の書いた列が入力と同じか */
  matches: (row: Row) => boolean;
  /** 入力の元の updated_at（insert は null） */
  baseVersion: string | null;
  /**
   * 一意のキーの insert か（応答が届かず、読み直すと別の値の行ができていたときの文言を 23505 の「同じものがすでにあります」に
   * する）。偽なら更新の文言（「他の人が先に変更しました」、行がなくなっていれば「すでに消えていました」）
   */
  insert?: boolean;
}

/**
 * 楽観ロックの更新・一意のキーの insert を送り、失敗したら 2.6 の (B1) で決める。
 * 1. 成功 → done。
 * 2. isUnknownOutcome でも isLockRejection でもない失敗 → failed。
 * 3. 対象の行を読み直して settleLockedWrite：saved → done（earlier）。応答が届かなかった後の not-saved・unread → unknown。
 *    止められた後の unread → unread。それ以外（changed と、止められた後の not-saved）→ changed。
 * 画面の状態には触らない（呼ぶ側が文言・入力の元の付け替え・閉じるを決める）。
 */
export async function runLockedWrite<Row extends { updated_at: string }>(call: LockedWriteCall<Row>): Promise<LockedWriteResult<Row>> {
  try {
    await call.write();
    return { kind: 'done', earlier: false };
  } catch (e) {
    const unknown = isUnknownOutcome(e);
    if (!unknown && !isLockRejection(e)) return { kind: 'failed', error: e };
    let fresh: Row | null = null;
    const outcome = await settleLockedWrite<Row>({
      reread: async () => (fresh = await call.reread()),
      matches: call.matches,
      baseVersion: call.baseVersion,
      versionOf: (row) => row.updated_at,
    });
    if (outcome === 'saved') return { kind: 'done', earlier: true };
    if (unknown && (outcome === 'not-saved' || outcome === 'unread')) return { kind: 'unknown', error: e };
    if (outcome === 'unread') return { kind: 'unread', error: e };
    const row = fresh as Row | null;
    let conflict: AppError;
    if (!unknown) conflict = toAppError(e);
    else if (row === null) conflict = appError('not_found', 'lock_missing');
    else if (call.insert) conflict = new AppError({ kind: 'conflict', code: '23505', reason: null, details: null, issues: [], status: null });
    else conflict = appError('conflict', 'lock_conflict');
    return { kind: 'changed', row, conflict };
  }
}

// ---- 団体の CSV の取り込み（3.2） ----

export type GroupImportAction = 'add' | 'change' | 'same';

export interface GroupImportLine {
  row: GroupCsvRow;
  action: GroupImportAction;
  /** 変える既存の団体（change・same） */
  existing: GroupRow | null;
  /** 変わる項目の日本語名（change のとき） */
  changes: string[];
}

export interface GroupImportPlan {
  lines: GroupImportLine[];
  counts: Record<GroupImportAction, number>;
  /** 取り込んだ後の年度の全団体に checkGroupNames を当てた誤り（団体名つき）。あれば保存しない */
  nameErrors: string[];
}

const sameArray = (a: readonly string[], b: readonly string[]) => a.length === b.length && a.every((x, k) => x === b[k]);

/**
 * CSV の行を、年度の今の団体と突き合わせる（団体名が同じ団体を変える。なければ足す。削除はしない）。
 * 取り込んだ後の全団体に checkGroupNames を当てる（大文字・小文字だけが違う名前を止める。D-27）。純粋関数。
 */
export function planGroupImport(rows: readonly GroupCsvRow[], groups: readonly GroupRow[]): GroupImportPlan {
  const byName = new Map(groups.map((g) => [g.name, g] as const));
  const counts: Record<GroupImportAction, number> = { add: 0, change: 0, same: 0 };
  const lines: GroupImportLine[] = rows.map((row) => {
    const existing = byName.get(row.name) ?? null;
    if (!existing) {
      counts.add += 1;
      return { row, action: 'add', existing: null, changes: [] };
    }
    const changes: string[] = [];
    if ((existing.display_name?.trim() || null) !== row.display_name) changes.push('表示名');
    if (existing.category !== row.category) changes.push('区分');
    if (existing.is_food !== row.is_food) changes.push('飲食');
    if (existing.location_room_id !== row.location_room_id) changes.push('使用場所');
    if (!sameArray(existing.aliases, row.aliases)) changes.push('別名');
    if (existing.sort_order !== row.sort_order) changes.push('並び順');
    const action: GroupImportAction = changes.length > 0 ? 'change' : 'same';
    counts[action] += 1;
    return { row, action, existing, changes };
  });
  const after = [
    ...groups.map((g) => ({ name: g.name })),
    ...lines.filter((l) => l.action === 'add').map((l) => ({ name: l.row.name })),
  ];
  const nameErrors = checkGroupNames(after).map((e) => e.message);
  return { lines, counts, nameErrors };
}

/** 取り込みの保存：足す・変える行だけを (year_id, name) で1回の upsert にする（全部か何もしないか） */
export async function saveGroupImport(
  yearId: string,
  plan: GroupImportPlan,
  client: AppSupabaseClient = getSupabase(),
): Promise<number> {
  const values: TablesInsert<'groups'>[] = plan.lines
    .filter((l) => l.action !== 'same')
    .map(({ row }) => ({
      year_id: yearId,
      name: row.name,
      display_name: row.display_name,
      category: row.category as GroupCategory,
      is_food: row.is_food,
      location_room_id: row.location_room_id,
      aliases: row.aliases,
      sort_order: row.sort_order,
    }));
  if (values.length === 0) return 0;
  const res = await client.from('groups').upsert(values, { onConflict: 'year_id,name' }).select('id');
  if (res.error) throw toAppError(res.error, res.status);
  // RLS で拒否された update は行を返さない（エラーにならない）。返った数が少なければ権限か状態が変わった
  if ((res.data ?? []).length !== values.length) throw appError('forbidden', 'lock_unchanged', { table: 'groups' });
  return values.length;
}

/** 名前の比べ方（CSV と同じ。重複の確かめに使う） */
export { nameKey };
