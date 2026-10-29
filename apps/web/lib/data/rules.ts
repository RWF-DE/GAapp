// ルール（/rules）の読み書きと、フォームの値・確かめ・内容の文（画面の設計 3.8。T12）。
// 確かめは packages/shared の ruleRowSchema（形）と checkRuleRefs（参照と、ほかの有効なルールとの重なり）。
// 団体・場所は id、品目はコードで保存する（03「ルールの params と扱い」）。
import { useQuery } from '@tanstack/react-query';
import {
  checkRuleRefs,
  compareBySortOrder,
  compareRules,
  fixedRequestParams,
  GROUP_CATEGORIES,
  keepParams,
  MAX_COUNT,
  MAX_SUBSTITUTE_COST,
  ruleRowSchema,
  ruleSchema,
  sortedBy,
  sourceRestrictParams,
  substituteParams,
  type GroupCategory,
  type Json,
  type Rule,
  type RuleCheckContext,
  type RuleDraft,
  type RuleKind,
  type RuleRow,
} from '@gaapp/shared';
import { fetchAll } from '@/lib/db/fetch-all';
import { updateWithLock } from '@/lib/db/update-with-lock';
import { COLUMNS, type GroupRow, type ItemRow, type RoomRow, type RoomYearRow, type RuleDbRow, type YearRow } from '@/lib/db/types';
import { appError, toAppError } from '@/lib/errors';
import { CATEGORY_LABELS } from '@/lib/labels';
import { queryKeys } from '@/lib/query';
import { NOTE_MAX, optionalText } from '@/lib/schemas/common';
import { getSupabase, type AppSupabaseClient } from '@/lib/supabase/client';
import { fetchYear } from './year';

// ---------------------------------------------------------------------------------------------
// 読む

/** ルール画面のデータ（年度の行・その年度のルール〔無効を含む〕・品目・場所・その年度の団体・その年度の場所の使用） */
export interface RulesData {
  year: YearRow;
  /** code → id の順 */
  rules: RuleDbRow[];
  /** sort_order → 名前 → id の順 */
  items: ItemRow[];
  rooms: RoomRow[];
  groups: GroupRow[];
  /** その年度の room_years（行がない場所は使用可） */
  roomYears: RoomYearRow[];
}

const bySortOrder = <T extends { sort_order: number; name: string; id: string }>(rows: readonly T[]): T[] =>
  sortedBy(rows, (a, b) => compareBySortOrder({ sortOrder: a.sort_order, name: a.name, id: a.id }, { sortOrder: b.sort_order, name: b.name, id: b.id }));

/** ルール画面のデータを読む（年度の行と表を並行に） */
export async function fetchRulesData(yearId: string, client: AppSupabaseClient = getSupabase()): Promise<RulesData> {
  const [year, rules, items, rooms, groups, roomYears] = await Promise.all([
    fetchYear(yearId, client),
    fetchAll((from, to) => client.from('rules').select(COLUMNS.rules).eq('year_id', yearId).order('id').range(from, to)),
    fetchAll((from, to) => client.from('items').select(COLUMNS.items).order('id').range(from, to)),
    fetchAll((from, to) => client.from('rooms').select(COLUMNS.rooms).order('id').range(from, to)),
    fetchAll((from, to) => client.from('groups').select(COLUMNS.groups).eq('year_id', yearId).order('id').range(from, to)),
    fetchAll((from, to) => client.from('room_years').select(COLUMNS.room_years).eq('year_id', yearId).order('room_id').range(from, to)),
  ]);
  return {
    year,
    rules: sortedBy(rules as unknown as RuleDbRow[], compareRules),
    items: bySortOrder(items as unknown as ItemRow[]),
    rooms: bySortOrder(rooms as unknown as RoomRow[]),
    groups: bySortOrder(groups as unknown as GroupRow[]),
    roomYears: roomYears as unknown as RoomYearRow[],
  };
}

/** ルール画面のクエリ（キーは `['year', yearId, 'rules']`） */
export function useRulesData(yearId: string | null | undefined) {
  return useQuery({
    queryKey: rulesQueryKey(yearId ?? ''),
    queryFn: () => fetchRulesData(yearId!),
    enabled: !!yearId,
  });
}

export const rulesQueryKey = (yearId: string) => queryKeys.yearPart(yearId, 'rules');

// ---------------------------------------------------------------------------------------------
// 書く（rules への直接の書き込み。2.3）

/** 保存する列（year_id・id・updated_at は除く） */
export type RuleWrite = Pick<RuleDbRow, 'code' | 'kind' | 'params' | 'enabled' | 'memo'>;

/**
 * 確かめた行を、保存する列にする。代替の indoorOnly・needsConsent は、偽（既定）なら書かない
 * （スキーマが既定を足した形でなく、03 の例・合成データの rules.json と同じ形で保存する）。
 */
export function toRuleWrite(row: RuleRow): RuleWrite {
  let params: unknown = row.params;
  if (row.kind === 'substitute') {
    const { indoorOnly, needsConsent, ...rest } = row.params;
    params = { ...rest, ...(indoorOnly ? { indoorOnly } : {}), ...(needsConsent ? { needsConsent } : {}) };
  }
  return { code: row.code, kind: row.kind, params: params as NonNullable<Json>, enabled: row.enabled, memo: row.memo };
}

/** ルールを足す。コードの重複は 23505（conflict） */
export async function insertRule(yearId: string, row: RuleWrite, client: AppSupabaseClient = getSupabase()): Promise<RuleDbRow> {
  const res = await client
    .from('rules')
    .insert({ year_id: yearId, ...row })
    .select(COLUMNS.rules)
    .maybeSingle();
  if (res.error) throw toAppError(res.error, res.status);
  if (!res.data) throw appError('forbidden', 'lock_unchanged', { table: 'rules' });
  return res.data as unknown as RuleDbRow;
}

/** ルールを直す（updated_at で楽観ロック）。0 行は not_found・conflict・forbidden */
export async function updateRule(
  rule: Pick<RuleDbRow, 'id' | 'updated_at'>,
  patch: Partial<RuleWrite>,
  client: AppSupabaseClient = getSupabase(),
): Promise<RuleDbRow> {
  const row = await updateWithLock(client, 'rules', { id: rule.id }, rule.updated_at, patch);
  return row as unknown as RuleDbRow;
}

/** 年度のコードのルールを読む（通信の失敗の後に、保存されていたかを確かめる。2.6） */
export async function findRuleByCode(yearId: string, code: string, client: AppSupabaseClient = getSupabase()): Promise<RuleDbRow | null> {
  const res = await client.from('rules').select(COLUMNS.rules).eq('year_id', yearId).eq('code', code).maybeSingle();
  if (res.error) throw toAppError(res.error, res.status);
  return (res.data as unknown as RuleDbRow | null) ?? null;
}

/** id のルールを読む（通信の失敗の後の確かめ） */
export async function findRuleById(id: string, client: AppSupabaseClient = getSupabase()): Promise<RuleDbRow | null> {
  const res = await client.from('rules').select(COLUMNS.rules).eq('id', id).maybeSingle();
  if (res.error) throw toAppError(res.error, res.status);
  return (res.data as unknown as RuleDbRow | null) ?? null;
}

/** 保存した行が、送った値と同じか（通信の失敗の後の確かめ。params は JSON として比べる） */
export function sameRuleWrite(saved: RuleWrite, sent: Partial<RuleWrite>): boolean {
  return (Object.keys(sent) as (keyof RuleWrite)[]).every((k) => canonicalJson(saved[k]) === canonicalJson(sent[k]));
}

/** キーの順によらない JSON の文字列（jsonb はキーの順を保たない） */
export function canonicalJson(v: unknown): string {
  if (Array.isArray(v)) return `[${v.map(canonicalJson).join(',')}]`;
  if (v && typeof v === 'object') {
    const o = v as Record<string, unknown>;
    return `{${Object.keys(o)
      .filter((k) => o[k] !== undefined)
      .sort()
      .map((k) => `${JSON.stringify(k)}:${canonicalJson(o[k])}`)
      .join(',')}}`;
  }
  return JSON.stringify(v ?? null);
}

// ---------------------------------------------------------------------------------------------
// 年度の状態と書けるもの

/**
 * 年度の状態で直せるもの（3.8）。確定中（confirmed）と終了（closed）はメモだけ（確定中は DB が書き込みを許すが、画面で止める。
 * 終了は DB のトリガー guard_rules と同じ）。そのほかは全部。
 */
export function ruleEditMode(status: YearRow['status']): 'full' | 'memo' {
  return status === 'confirmed' || status === 'closed' ? 'memo' : 'full';
}

// ---------------------------------------------------------------------------------------------
// 確かめ

/** DB の行を shared の Rule にする（形が合わなければ null） */
export function parseRule(row: Pick<RuleDbRow, 'id' | 'code' | 'kind' | 'params'>): Rule | null {
  const r = ruleSchema.safeParse({ id: row.id, code: row.code, kind: row.kind, params: row.params });
  return r.success ? r.data : null;
}

/** checkRuleRefs に渡す団体・場所・品目（今の年度の団体と、年度をまたぐ場所・品目） */
export function ruleCheckBase(data: Pick<RulesData, 'items' | 'rooms' | 'groups'>): Omit<RuleCheckContext, 'rules'> {
  return {
    items: data.items.map((i) => ({ code: i.code, requestableCategories: i.requestable_categories })),
    rooms: data.rooms.map((r) => ({ id: r.id })),
    groups: data.groups.map((g) => ({ id: g.id, category: g.category, locationRoomId: g.location_room_id })),
  };
}

/** 自分以外の有効なルール（形の合わないものは除く）。新規なら excludeId は null */
export function otherEnabledRules(rules: readonly RuleDbRow[], excludeId: string | null): Rule[] {
  return rules.filter((r) => r.enabled && r.id !== excludeId).flatMap((r) => parseRule(r) ?? []);
}

/** 今年使用不可の場所の id（room_years.usable = false。行がない場所は使用可） */
export function unusableRoomIds(data: Pick<RulesData, 'roomYears'>): Set<string> {
  return new Set(data.roomYears.filter((ry) => !ry.usable).map((ry) => ry.room_id));
}

/**
 * 「残す」の場所が今年使用不可のときの知らせ（allocate の前処理が E002 で止める。03 の前処理 3）。
 * 保存は止めない（場所の使用はマスタ設定で年度ごとに変えるもので、使用可に戻せば直る。メモだけ直す・無効にするのも止めない）。
 */
export function keepUnusableMessage(roomName: string): string {
  return `${roomName}は今年使用不可です。このままでは振り分けが止まります（E002）。マスタ設定で使用可にするか、場所を選び直してください`;
}

/** 「残す」のルールの場所が今年使用不可なら、その知らせ（ほかの種別・使用可の場所なら null） */
export function keepUnusableWarning(
  rule: { kind: string; params: unknown },
  data: Pick<RulesData, 'rooms' | 'roomYears'>,
  unusable: ReadonlySet<string> = unusableRoomIds(data),
): string | null {
  if (rule.kind !== 'keep' || !isRecord(rule.params)) return null;
  const room = str(rule.params.room);
  if (!room || !unusable.has(room)) return null;
  return keepUnusableMessage(data.rooms.find((r) => r.id === room)?.name ?? '（見つからない場所）');
}

/**
 * shared の checkRuleRefs の文言の品目のコード（「desk」・（desk→desk_ng）・（desk・chair）など）を、品目の名前にする。
 * 品目の一覧にないコード（「品目「x」がありません」）はコードのまま。コードの重複（path が code）の文言はルールのコードなので直さない。
 */
export function ruleRefMessage(e: { path: string; message: string }, names: Pick<RuleNames, 'item'>): string {
  if (e.path === 'code') return e.message;
  return e.message.replace(/(?<=[「（→・])([a-z][a-z0-9_]*)(?=[」）→・])/g, (c) => names.item(c) ?? c);
}

/**
 * 「残す」のフォームで団体を選び直したときの場所。場所が空か、前の団体の使用場所のままなら、新しい団体の使用場所にする
 * （新しい団体に使用場所がなければ空）。手で選んだ場所（前の団体の使用場所でない場所）は替えない。
 */
export function keepRoomAfterGroupChange(
  keep: Pick<RuleFormValues['keep'], 'group' | 'room'>,
  nextGroup: string | null,
  groups: readonly Pick<GroupRow, 'id' | 'location_room_id'>[],
): string | null {
  const location = (id: string | null) => groups.find((g) => g.id === id)?.location_room_id ?? null;
  const prevLocation = location(keep.group);
  if (keep.room === null || (prevLocation !== null && keep.room === prevLocation)) return location(nextGroup);
  return keep.room;
}

/** 欄の path（`code`・`params.group`・`params.rooms.3` など）→ 文言の一覧 */
export type RuleFieldErrors = Record<string, string[]>;

function addError(errors: RuleFieldErrors, path: string, message: string) {
  const list = (errors[path] ??= []);
  if (!list.includes(message)) list.push(message);
}

/** path の下（同じ path か、`path.` で始まるもの）の文言 */
export function errorsUnder(errors: RuleFieldErrors, path: string, opts: { exact?: boolean } = {}): string[] {
  const out: string[] = [];
  for (const [p, list] of Object.entries(errors)) {
    if (p === path || (!opts.exact && p.startsWith(`${path}.`))) for (const m of list) if (!out.includes(m)) out.push(m);
  }
  return out;
}

const hasJapanese = (s: string) => /[぀-ヿ一-鿿]/.test(s);

/** zod の形の誤りを、欄ごとの日本語にする（shared のスキーマの既定の文言は英語のため） */
function shapeMessage(kind: RuleKind, path: string, message: string): string {
  const [head, key] = path.split('.');
  if (head === 'code') return 'コードを入れてください（50 字まで）';
  if (head === 'memo') return `メモは ${NOTE_MAX} 字までです`;
  if (head !== 'params') return hasJapanese(message) ? message : '入力が正しくありません';
  switch (key) {
    case 'from':
      return '代替元の品目を選んでください';
    case 'to':
      return hasJapanese(message) ? message : '代替先の品目を選んでください';
    case 'categories':
      return '区分を1つ以上選んでください';
    case 'cost':
      return `重さは 0〜${MAX_SUBSTITUTE_COST} の整数にしてください`;
    case 'preferCategory':
      return '優先する区分は、選んだ区分の中から選んでください';
    case 'group':
      return '団体を選んでください';
    case 'room':
      return '場所を選んでください';
    case 'rooms':
      return '場所を1つ以上選んでください';
    case 'item':
      return '品目を選んでください';
    case 'items':
      if (kind === 'keep') return path.split('.').length > 2 ? `数は 1〜${MAX_COUNT} の整数にしてください` : '残す品目と数を入れてください';
      return '品目を1つ以上選んでください';
    case 'count':
      return `数は 1〜${MAX_COUNT} の整数にしてください`;
    default:
      return hasJapanese(message) ? message : '入力が正しくありません';
  }
}

// ---------------------------------------------------------------------------------------------
// フォームの値

/** フォームの値（種別ごとの欄。数は入力の文字のまま持つ） */
export interface RuleFormValues {
  kind: RuleKind;
  code: string;
  memo: string;
  enabled: boolean;
  substitute: {
    from: string | null;
    to: string | null;
    categories: GroupCategory[];
    cost: string;
    indoorOnly: boolean;
    needsConsent: boolean;
    preferCategory: GroupCategory | null;
  };
  sourceRestrict: { group: string | null; items: string[]; rooms: string[] };
  fixedRequest: { group: string | null; item: string | null; count: string };
  /** items は品目コード → 数（入力の文字。空は残さない） */
  keep: { group: string | null; room: string | null; items: Record<string, string> };
}

export function emptyRuleForm(kind: RuleKind): RuleFormValues {
  return {
    kind,
    code: '',
    memo: '',
    enabled: true,
    substitute: { from: null, to: null, categories: [], cost: '0', indoorOnly: false, needsConsent: false, preferCategory: null },
    sourceRestrict: { group: null, items: [], rooms: [] },
    fixedRequest: { group: null, item: null, count: '' },
    keep: { group: null, room: null, items: {} },
  };
}

const str = (v: unknown): string | null => (typeof v === 'string' ? v : null);
const strArray = (v: unknown): string[] => (Array.isArray(v) ? v.filter((x): x is string => typeof x === 'string') : []);
const numText = (v: unknown): string => (typeof v === 'number' && Number.isFinite(v) ? String(v) : '');
const isRecord = (v: unknown): v is Record<string, unknown> => typeof v === 'object' && v !== null && !Array.isArray(v);
const isCategory = (v: unknown): v is GroupCategory => typeof v === 'string' && (GROUP_CATEGORIES as readonly string[]).includes(v);

/** 保存してあるルール（params が壊れていても読める所だけ）をフォームの値にする */
export function ruleToForm(rule: Pick<RuleDbRow, 'code' | 'kind' | 'params' | 'enabled' | 'memo'>): RuleFormValues {
  const f = emptyRuleForm(rule.kind);
  f.code = rule.code;
  f.memo = rule.memo ?? '';
  f.enabled = rule.enabled;
  const p = isRecord(rule.params) ? rule.params : {};
  switch (rule.kind) {
    case 'substitute':
      f.substitute = {
        from: str(p.from),
        to: str(p.to),
        categories: strArray(p.categories).filter(isCategory),
        cost: numText(p.cost),
        indoorOnly: p.indoorOnly === true,
        needsConsent: p.needsConsent === true,
        preferCategory: isCategory(p.preferCategory) ? p.preferCategory : null,
      };
      break;
    case 'source_restrict':
      f.sourceRestrict = { group: str(p.group), items: strArray(p.items), rooms: strArray(p.rooms) };
      break;
    case 'fixed_request':
      f.fixedRequest = { group: str(p.group), item: str(p.item), count: numText(p.count) };
      break;
    case 'keep':
      f.keep = {
        group: str(p.group),
        room: str(p.room),
        items: Object.fromEntries(Object.entries(isRecord(p.items) ? p.items : {}).map(([k, v]) => [k, numText(v)])),
      };
      break;
  }
  return f;
}

/** 数の入力の文字を数にする（空・数でないものは NaN にして、スキーマに止めてもらう） */
function toNumber(text: string): number {
  const t = text.trim();
  if (t === '' || !/^-?\d+(\.\d+)?$/.test(t.normalize('NFKC'))) return Number.NaN;
  return Number(t.normalize('NFKC'));
}

/** フォームの値を、ruleRowSchema に渡す形にする（確かめる前。形の誤りはスキーマが見つける） */
export function formToCandidate(f: RuleFormValues): unknown {
  const base = { code: f.code.trim(), kind: f.kind, enabled: f.enabled, memo: optionalText(NOTE_MAX).safeParse(f.memo).data ?? null };
  switch (f.kind) {
    case 'substitute': {
      const s = f.substitute;
      return {
        ...base,
        params: {
          from: s.from ?? '',
          to: s.to ?? '',
          // 区分は選んだ順（チェックを付けた順）のまま
          categories: [...s.categories],
          cost: toNumber(s.cost),
          ...(s.indoorOnly ? { indoorOnly: true } : {}),
          ...(s.needsConsent ? { needsConsent: true } : {}),
          ...(s.preferCategory ? { preferCategory: s.preferCategory } : {}),
        },
      };
    }
    case 'source_restrict': {
      const s = f.sourceRestrict;
      return { ...base, params: { group: s.group ?? '', items: [...s.items], rooms: [...s.rooms] } };
    }
    case 'fixed_request': {
      const s = f.fixedRequest;
      return { ...base, params: { group: s.group ?? '', item: s.item ?? '', count: toNumber(s.count) } };
    }
    case 'keep': {
      const s = f.keep;
      const items: Record<string, number> = {};
      for (const [code, text] of Object.entries(s.items)) if (text.trim() !== '') items[code] = toNumber(text);
      return { ...base, params: { group: s.group ?? '', room: s.room ?? '', items } };
    }
  }
}

/**
 * 保存する params を、画面の並び（品目・場所の sort_order）にそろえる。
 * source_restrict の items・rooms と keep の items は、選んだ順でなく品目・場所の並びにする（同じ内容なら同じ params になる）。
 */
export function normalizeRuleRow(row: RuleRow, data: Pick<RulesData, 'items' | 'rooms'>): RuleRow {
  const itemOrder = new Map(data.items.map((i, k) => [i.code, k]));
  const roomOrder = new Map(data.rooms.map((r, k) => [r.id, k]));
  const byItem = (a: string, b: string) => (itemOrder.get(a) ?? Infinity) - (itemOrder.get(b) ?? Infinity) || (a < b ? -1 : a > b ? 1 : 0);
  const byRoom = (a: string, b: string) => (roomOrder.get(a) ?? Infinity) - (roomOrder.get(b) ?? Infinity) || (a < b ? -1 : a > b ? 1 : 0);
  switch (row.kind) {
    case 'source_restrict':
      return { ...row, params: { ...row.params, items: sortedBy(row.params.items, byItem), rooms: sortedBy(row.params.rooms, byRoom) } };
    case 'keep': {
      const items = Object.fromEntries(sortedBy(Object.keys(row.params.items), byItem).map((k) => [k, row.params.items[k]!]));
      return { ...row, params: { ...row.params, items } };
    }
    default:
      return row;
  }
}

export interface RuleCheckResult {
  /** 保存してよい行（errors が空のときだけ） */
  row: RuleRow | null;
  errors: RuleFieldErrors;
  /** 保存は止めない知らせ（「残す」の場所が今年使用不可など） */
  warnings: RuleFieldErrors;
}

/**
 * 保存の前の確かめ（3.8）：ruleRowSchema で形、checkRuleRefs（自分以外の有効なルール）で参照と重なり、コードの重複（無効のルールも含む）。
 * 無効のまま保存するルールは、重なりを見ない（参照だけ見る）。
 */
export function checkRuleForm(f: RuleFormValues, data: RulesData, editingId: string | null): RuleCheckResult {
  const errors: RuleFieldErrors = {};
  const warnings = ruleFormWarnings(f, data);
  if (f.memo.trim().length > NOTE_MAX) addError(errors, 'memo', `メモは ${NOTE_MAX} 字までです`);
  const parsed = ruleRowSchema.safeParse(formToCandidate(f));
  if (!parsed.success) {
    for (const issue of parsed.error.issues) {
      const path = issue.path.map(String).join('.') || 'params';
      addError(errors, path, shapeMessage(f.kind, path, issue.message));
    }
    return { row: null, errors, warnings };
  }
  const row = normalizeRuleRow(parsed.data, data);
  const code = row.code.trim();
  if (data.rules.some((r) => r.id !== editingId && r.code.trim() === code)) addError(errors, 'code', '同じコードのルールがあります');
  const draft = { code: row.code, kind: row.kind, params: row.params } as RuleDraft;
  const rules = row.enabled ? otherEnabledRules(data.rules, editingId) : [];
  const names = ruleNamesOf(data);
  for (const e of checkRuleRefs(draft, { ...ruleCheckBase(data), rules })) {
    addError(errors, e.path, e.path === 'code' ? '同じコードのルールがあります' : ruleRefMessage(e, names));
  }
  return Object.keys(errors).length > 0 ? { row: null, errors, warnings } : { row, errors, warnings };
}

/** フォームの知らせ（保存は止めない）。「残す」の場所が今年使用不可なら場所の欄に出す */
export function ruleFormWarnings(f: RuleFormValues, data: Pick<RulesData, 'rooms' | 'roomYears'>): RuleFieldErrors {
  const out: RuleFieldErrors = {};
  if (f.kind === 'keep') {
    const m = keepUnusableWarning({ kind: 'keep', params: { room: f.keep.room } }, data);
    if (m) addError(out, 'params.room', m);
  }
  return out;
}

/** 有効にする前の確かめ（3.8）。保存してあるルールを、自分以外の有効なルールと今の団体・場所・品目に当てる */
export function checkEnable(rule: RuleDbRow, data: RulesData): string[] {
  const r = parseRule(rule);
  if (!r) return ['設定が壊れています。編集して直してください'];
  const { id: _id, ...draft } = r;
  void _id;
  const names = ruleNamesOf(data);
  return checkRuleRefs(draft as RuleDraft, { ...ruleCheckBase(data), rules: otherEnabledRules(data.rules, rule.id) }).map((e) =>
    ruleRefMessage(e, names),
  );
}

/** 一覧の印（有効なルールの参照の切れ・重なり・壊れた設定。3.8・2.7） */
export interface RuleProblem {
  label: string;
  messages: string[];
}

const MISSING: { test: (m: string) => boolean; what: string }[] = [
  { test: (m) => m === '団体がありません', what: '団体' },
  { test: (m) => m === '場所がありません', what: '場所' },
  { test: (m) => /^品目「.*」がありません$/.test(m), what: '品目' },
];

/**
 * 有効なルールの問題（id → 印）。無効のルールは見ない。
 * 「残す」の場所が今年使用不可（allocate の前処理が E002 で止める）も印にする。
 */
export function ruleProblems(data: RulesData): Map<string, RuleProblem> {
  const out = new Map<string, RuleProblem>();
  const base = ruleCheckBase(data);
  const names = ruleNamesOf(data);
  const unusable = unusableRoomIds(data);
  for (const row of data.rules) {
    if (!row.enabled) continue;
    const r = parseRule(row);
    if (!r) {
      out.set(row.id, { label: '設定が壊れています', messages: ['設定の形が正しくありません。編集して直すか、無効にしてください'] });
      continue;
    }
    const { id: _id, ...draft } = r;
    void _id;
    const messages = checkRuleRefs(draft as RuleDraft, { ...base, rules: otherEnabledRules(data.rules, row.id) }).map((e) => ruleRefMessage(e, names));
    const unusableMessage = keepUnusableWarning(r, data, unusable);
    if (unusableMessage) messages.push(unusableMessage);
    if (messages.length === 0) continue;
    const missing = MISSING.filter((x) => messages.some(x.test)).map((x) => x.what);
    out.set(row.id, {
      label:
        missing.length > 0
          ? `参照が切れています（${missing.join('・')}が見つかりません）`
          : unusableMessage && messages.length === 1
            ? '使用不可の場所です'
            : '要確認',
      messages: [...new Set(messages)],
    });
  }
  return out;
}

// ---------------------------------------------------------------------------------------------
// 内容の文

/** id・コード → 名前（見つからなければ undefined） */
export interface RuleNames {
  item: (code: string) => string | undefined;
  group: (id: string) => string | undefined;
  room: (id: string) => string | undefined;
}

export function ruleNamesOf(data: Pick<RulesData, 'items' | 'rooms' | 'groups'>): RuleNames {
  const items = new Map(data.items.map((i) => [i.code, i.name]));
  const rooms = new Map(data.rooms.map((r) => [r.id, r.name]));
  const groups = new Map(data.groups.map((g) => [g.id, g.name]));
  return { item: (c) => items.get(c), group: (id) => groups.get(id), room: (id) => rooms.get(id) };
}

/**
 * ルールの内容の文（一覧に出す。3.8）。例「設営の机(木)は 1-1・1-2・1-3・2-1・2-2・2-3 からだけ出す」。
 * 代替は、重さ 0 なら「不可机は机(木)と同じに扱う（模擬店）」（01 の規則4）、重さ 1 以上なら「模擬店の机(木)が足りなければキャスター机で代える（重さ 3、…）」。
 * 団体・場所が見つからなければ「（見つからない団体）」、品目が見つからなければコードを出す。params の形が合わなければ「設定が壊れています」。
 */
export function describeRule(rule: { kind: string; params: unknown }, names: RuleNames): string {
  const item = (c: string) => names.item(c) ?? c;
  const group = (id: string) => names.group(id) ?? '（見つからない団体）';
  const room = (id: string) => names.room(id) ?? '（見つからない場所）';
  const BROKEN = '設定が壊れています';
  switch (rule.kind) {
    case 'substitute': {
      const r = substituteParams.safeParse(rule.params);
      if (!r.success) return BROKEN;
      const p = r.data;
      const who = p.categories.map((c) => CATEGORY_LABELS[c]).join('・');
      const extras = [
        ...(p.indoorOnly ? ['屋内の団体だけ'] : []),
        ...(p.needsConsent ? ['了承が要る'] : []),
        ...(p.preferCategory ? [`同じ距離なら${CATEGORY_LABELS[p.preferCategory]}を先に`] : []),
      ];
      // 重さ 0 は「足りないときだけ使う代替」でなく、その区分では元の品目と同じに扱う（01 の規則4。S01・S02 の不可机・不可椅子）
      if (p.cost === 0) return `${item(p.to)}は${item(p.from)}と同じに扱う（${[who, ...extras].join('、')}）`;
      return `${who}の${item(p.from)}が足りなければ${item(p.to)}で代える（${[`重さ ${p.cost}`, ...extras].join('、')}）`;
    }
    case 'source_restrict': {
      const r = sourceRestrictParams.safeParse(rule.params);
      if (!r.success) return BROKEN;
      const p = r.data;
      return `${group(p.group)}の${p.items.map(item).join('・')}は ${p.rooms.map(room).join('・')} からだけ出す`;
    }
    case 'fixed_request': {
      const r = fixedRequestParams.safeParse(rule.params);
      if (!r.success) return BROKEN;
      const p = r.data;
      return `${group(p.group)}が未提出なら、${item(p.item)}を ${p.count} 台申請したものとする`;
    }
    case 'keep': {
      const r = keepParams.safeParse(rule.params);
      if (!r.success) return BROKEN;
      const p = r.data;
      const list = Object.entries(p.items)
        .map(([c, n]) => `${item(c)} ${n}`)
        .join('・');
      return `${group(p.group)}は${room(p.room)}の ${list} を残す`;
    }
    default:
      return BROKEN;
  }
}

// ---------------------------------------------------------------------------------------------
// R8 の初期ルール（ひな形。3.8）

export interface RuleTemplate {
  code: string;
  kind: RuleKind;
  memo: string;
  /** フォームの初期値（団体・場所は空。選んでもらう） */
  form: (f: RuleFormValues) => RuleFormValues;
  /** 団体・場所を選んでもらうか */
  needsChoice: boolean;
}

/**
 * R8 の初期ルール（01 の S01〜S08 のうちルールにするもの。S03 は読み替えで、ルールではない）。
 * 品目・区分・数とメモは合成データの fixtures/synthetic/r8like/rules.json と同じ。品目と区分だけのもの（S01・S02・S04・S07）は
 * そのまま保存でき、団体・場所の要る S05・S06・S08 は団体・場所を選んでもらう（年度ごとに id が違うため、名前で決め打ちしない）。
 */
export const R8_RULE_TEMPLATES: readonly RuleTemplate[] = [
  {
    code: 'S01',
    kind: 'substitute',
    memo: '不可机は模擬店の机(木)の代わりにだけ使う',
    needsChoice: false,
    form: (f) => ({ ...f, substitute: { ...f.substitute, from: 'desk', to: 'desk_ng', categories: ['stall'], cost: '0' } }),
  },
  {
    code: 'S02',
    kind: 'substitute',
    memo: '不可椅子は休憩所・模擬店の椅子(木)の代わり。同じ距離なら休憩所',
    needsChoice: false,
    form: (f) => ({
      ...f,
      substitute: { ...f.substitute, from: 'chair', to: 'chair_ng', categories: ['rest_area', 'stall'], cost: '0', preferCategory: 'rest_area' },
    }),
  },
  {
    code: 'S04',
    kind: 'substitute',
    memo: '企業の長机(3人掛)が足りなければ長机(2人掛)',
    needsChoice: false,
    form: (f) => ({ ...f, substitute: { ...f.substitute, from: 'long_desk_3', to: 'long_desk_2', categories: ['company'], cost: '1' } }),
  },
  {
    code: 'S05',
    kind: 'source_restrict',
    memo: '設営の机(木)は 1-1〜2-3 から',
    needsChoice: true,
    form: (f) => ({ ...f, sourceRestrict: { ...f.sourceRestrict, items: ['desk'] } }),
  },
  {
    code: 'S06',
    kind: 'fixed_request',
    memo: '設営の机(木)は241台（未提出のとき）',
    needsChoice: true,
    form: (f) => ({ ...f, fixedRequest: { ...f.fixedRequest, item: 'desk', count: '241' } }),
  },
  {
    code: 'S07',
    kind: 'substitute',
    memo: '屋内の模擬店の机(木)をキャスター机に（了承が要る）',
    needsChoice: false,
    form: (f) => ({
      ...f,
      substitute: { ...f.substitute, from: 'desk', to: 'caster_desk', categories: ['stall'], cost: '3', indoorOnly: true, needsConsent: true },
    }),
  },
  {
    code: 'S08',
    kind: 'keep',
    memo: '学科展示は第一多目的室の机12・椅子4を残す',
    needsChoice: true,
    form: (f) => ({ ...f, keep: { ...f.keep, items: { desk: '12', chair: '4' } } }),
  },
];

/** ひな形のフォームの値 */
export function templateToForm(t: RuleTemplate): RuleFormValues {
  const f = t.form(emptyRuleForm(t.kind));
  return { ...f, code: t.code, memo: t.memo };
}

/** まだないコードのひな形（無効のルールも「ある」とする） */
export function missingTemplates(rules: readonly Pick<RuleDbRow, 'code'>[]): RuleTemplate[] {
  const have = new Set(rules.map((r) => r.code.trim()));
  return R8_RULE_TEMPLATES.filter((t) => !have.has(t.code));
}

/** `?code=` の値（1〜50 字。合わなければ null） */
export function parseCodeParam(v: string | null): string | null {
  const t = (v ?? '').trim();
  return t.length >= 1 && t.length <= 50 ? t : null;
}
