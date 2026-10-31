// マスタ設定（/settings）の入力の zod と、団体の CSV の読み取り（画面の設計 3.2・1.6。T09）。
// 上限は DB の CHECK と同じ値を lib/schemas/common.ts と shared の定数から使い、ここで数字を書き直さない。
import { parseCsvLoose } from '@gaapp/importer';
import {
  GROUP_CATEGORIES,
  groupNameSchema,
  ITEM_CODE_PATTERN,
  MAX_DISTANCE_COST,
  ROOM_KINDS,
  type GroupCategory,
} from '@gaapp/shared';
import { z } from 'zod';
import { APP_ROLES, GROUP_ROLES, isGroupRole, type AppRole, type GroupRole, type InviteKind } from '@/lib/auth/roles';
import { fromDateTimeLocal } from '@/lib/datetime';
import { CATEGORY_LABELS } from '@/lib/labels';
import {
  aliasesSchema,
  BUILDING_MAX,
  emailSchema,
  festivalStartSchema,
  NAME_MAX,
  NOTE_MAX,
  optionalText,
  requiredText,
  uuidSchema,
  yearLabelSchema,
} from './common';

/** items.code の CHECK（`code ~ '^[a-z][a-z0-9_]*$' and length(code) <= 50`。0001） */
export const ITEM_CODE_MAX = 50;
/** rooms.floor は smallint。画面では地下5階〜99階までにする（それ以外の階は使わない） */
export const FLOOR_MIN = -5;
export const FLOOR_MAX = 99;
/** sort_order（integer）。画面では ±1,000,000 まで */
export const SORT_ORDER_MAX = 1_000_000;

/** 別名の入力欄の区切り（「|」。全角の「｜」も受ける）。CSV の別名の列と同じ */
export const ALIASES_SEPARATOR = '|';

/** 別名の入力欄（「1-1|一の一」）を配列にする。空のものは捨てる */
export function splitAliases(text: string | null | undefined): string[] {
  return (text ?? '')
    .split(/[|｜]/u)
    .map((s) => s.trim())
    .filter((s) => s !== '');
}

/** 配列を別名の入力欄の文字にする */
export function joinAliases(aliases: readonly string[] | null | undefined): string {
  return (aliases ?? []).join(ALIASES_SEPARATOR);
}

/** 別名の入力欄（文字）→ 確かめた配列 */
const aliasesText = z.string().transform(splitAliases).pipe(aliasesSchema);

/** 整数の入力欄（文字）。空は空のまま（呼ぶ側で必須か null かを決める） */
const intText = (min: number, max: number, label: string) =>
  z
    .string()
    .trim()
    .regex(/^-?\d+$/u, { message: `${label}は整数で入れてください` })
    .transform(Number)
    .pipe(z.number().int().min(min, { message: `${label}は ${min} 以上にしてください` }).max(max, { message: `${label}は ${max} 以下にしてください` }));

const sortOrderText = intText(-SORT_ORDER_MAX, SORT_ORDER_MAX, '並び順');

/** 任意の整数の入力欄（文字）。空は null */
const optionalIntText = (min: number, max: number, label: string) => {
  const inner = intText(min, max, label);
  return z.string().transform((v, ctx) => {
    if (v.trim() === '') return null;
    const r = inner.safeParse(v);
    if (r.success) return r.data;
    for (const issue of r.error.issues) ctx.addIssue({ code: 'custom', message: issue.message });
    return z.NEVER;
  });
};

// ---- 年度 ----

/**
 * 年度の変更（update_year）。受付期間は `datetime-local` の値（Asia/Tokyo とみなす）。
 * 受付開始 < 締切、requesting の間は締切を空にできない（3.2）。1日目の範囲は DB の CHECK と同じ（D-18）。
 */
export function yearEditSchema(status: string) {
  // 欄ごとの誤りをまとめて出すため、文字のまま受けて transform の中で確かめる（object の欄の誤りがあると transform が走らないため）
  return z
    .object({ label: z.string(), festival_start: z.string(), request_open_at: z.string(), request_close_at: z.string() })
    .transform((v, ctx) => {
      const issue = (path: string, message: string) => ctx.addIssue({ code: 'custom', path: [path], message });
      const label = yearLabelSchema.safeParse(v.label);
      if (!label.success) issue('label', label.error.issues[0]?.message ?? '年度名が正しくありません');
      const festival = festivalStartSchema.safeParse(v.festival_start);
      if (!festival.success) issue('festival_start', festival.error.issues[0]?.message ?? '日付が正しくありません');
      const open = fromDateTimeLocal(v.request_open_at);
      const close = fromDateTimeLocal(v.request_close_at);
      if (v.request_open_at.trim() !== '' && open === null) issue('request_open_at', '日時の形が正しくありません');
      if (v.request_close_at.trim() !== '' && close === null) issue('request_close_at', '日時の形が正しくありません');
      if (status === 'requesting' && close === null) issue('request_close_at', '申請の受付中は締切を空にできません');
      if (open && close && Date.parse(open) >= Date.parse(close)) issue('request_close_at', '締切は受付開始より後にしてください');
      if (!label.success || !festival.success) return z.NEVER;
      return { label: label.data, festival_start: festival.data, request_open_at: open, request_close_at: close };
    });
}
export type YearEditInput = z.input<ReturnType<typeof yearEditSchema>>;
export type YearEditOutput = z.output<ReturnType<typeof yearEditSchema>>;

/**
 * 新しい年度（create_year_from）。年度名は前後の空白を除いて1〜50 字、1日目は複製元の1日目より後で 2000-01-01〜2200-12-31。
 * DB は前の2つを details のない invalid_input で返すので、画面が持っている複製元の1日目で先に止める（3.2）。
 */
export function yearCreateSchema(prevFestivalStart: string) {
  return z.object({
    label: yearLabelSchema,
    festival_start: festivalStartSchema.refine((d) => d > prevFestivalStart, {
      message: `1日目は今の年度（${prevFestivalStart}）より後の日付にしてください`,
    }),
  });
}
export type YearCreateInput = z.input<ReturnType<typeof yearCreateSchema>>;

// ---- 場所 ----

export const roomFormSchema = z.object({
  name: requiredText(NAME_MAX),
  aliases: aliasesText,
  kind: z.enum(ROOM_KINDS),
  building: optionalText(BUILDING_MAX),
  /** 空は null（体育館・屋外など。1階として扱う） */
  floor: optionalIntText(FLOOR_MIN, FLOOR_MAX, '階'),
  is_storage: z.boolean(),
  extra_cost: intText(0, MAX_DISTANCE_COST, '追加コスト'),
  sort_order: sortOrderText,
});
export type RoomFormInput = z.input<typeof roomFormSchema>;
export type RoomFormOutput = z.output<typeof roomFormSchema>;

/** 今年の使用（room_years）。理由のメモは空なら null */
export const roomUsableSchema = z.object({ usable: z.boolean(), note: optionalText(NOTE_MAX) });

// ---- 品目 ----

export const itemCodeSchema = z
  .string()
  .trim()
  .min(1, { message: 'コードを入れてください' })
  .max(ITEM_CODE_MAX, { message: `${ITEM_CODE_MAX} 字までです` })
  .regex(ITEM_CODE_PATTERN, { message: '半角の英小文字で始め、英小文字・数字・_ だけにしてください' });

export const itemFormSchema = z.object({
  /** 作った後は変えない（ルールがコードで参照するため）。編集のときは送らない */
  code: itemCodeSchema,
  name: requiredText(NAME_MAX),
  aliases: aliasesText,
  requestable_categories: z.array(z.enum(GROUP_CATEGORIES)),
  sort_order: sortOrderText,
});
export type ItemFormInput = z.input<typeof itemFormSchema>;
export type ItemFormOutput = z.output<typeof itemFormSchema>;

// ---- 団体 ----

/** 団体名：Excel の集計に使える名前（D-27）で 100 字まで */
export const groupNameField = groupNameSchema.pipe(z.string().max(NAME_MAX, { message: `${NAME_MAX} 字までです` }));

export const groupFormSchema = z.object({
  name: groupNameField,
  display_name: optionalText(NAME_MAX),
  aliases: aliasesText,
  category: z.enum(GROUP_CATEGORIES),
  is_food: z.boolean(),
  /** 空（''）は校内に分散（null） */
  location_room_id: z.string().transform((v, ctx) => {
    if (v === '') return null;
    if (uuidSchema.safeParse(v).success) return v;
    ctx.addIssue({ code: 'custom', message: '使用場所を選び直してください' });
    return z.NEVER;
  }),
  sort_order: sortOrderText,
});
export type GroupFormInput = z.input<typeof groupFormSchema>;
export type GroupFormOutput = z.output<typeof groupFormSchema>;

// ---- 距離 ----

export const distanceFormSchema = z
  .object({
    building_a: requiredText(BUILDING_MAX),
    building_b: requiredText(BUILDING_MAX),
    cost: intText(0, MAX_DISTANCE_COST, 'コスト'),
  })
  .refine((v) => v.building_a !== v.building_b, { path: ['building_b'], message: '同じ建物どうしの距離は入れられません' });
export type DistanceFormInput = z.input<typeof distanceFormSchema>;
export type DistanceFormOutput = z.output<typeof distanceFormSchema>;

// ---- 招待 ----

export type { InviteKind };

/**
 * 招待の立場のすべて（1回に1つ。D-50）：ロール（app_role）と、団体代表の立場（group_role。団体を一緒に選ぶ）。値は DB の列挙の値の
 * まま（送る引数〔p_role・p_group_role〕と表示名の表〔ROLE_LABELS・GROUP_ROLE_LABELS〕を同じ値で引く）。並びは選択肢の並び。
 * その人が選べるのはこのうち段で決まるもの（lib/auth/roles.ts の inviteKindsFor。部門長・副部門長は総務部門員・店長・副店長）。
 */
export const INVITE_KINDS: readonly InviteKind[] = [...APP_ROLES, ...GROUP_ROLES];

/** 招待のフォームの入力（立場は選択肢の値。団体は店長・副店長のときだけ使う。空は未選択） */
export interface InviteFormInput {
  email: string;
  kind: string;
  group_id: string;
}

/**
 * 送る値：ロールの招待（role。団体なし）か、団体の招待（group_id と group_role。ロールなし）のどちらか1つ
 * （部門のロールと団体を一度に頼まない。D-49・D-50）。
 */
export type InviteFormOutput = { email: string } & (
  | { role: AppRole; group_id: null; group_role: null }
  | { role: null; group_id: string; group_role: GroupRole }
);

/**
 * 招待のフォーム（kinds はその人が選べる立場。inviteKindsFor）。kinds の外の立場は立場の欄に「立場を選び直してください」
 * （段が変わった後の古い選択など。DB の invite も段を守る）。店長・副店長は団体が要る。
 *
 * @example
 * inviteFormSchema(inviteKindsFor('head')).parse({ email: 'a@example.test', kind: 'deputy_manager', group_id: G })
 * // { email: 'a@example.test', role: null, group_id: G, group_role: 'deputy_manager' }
 */
export function inviteFormSchema(kinds: readonly InviteKind[]) {
  const allowed: readonly string[] = kinds;
  return z
    .object({
      email: emailSchema,
      kind: z.string().refine((k) => allowed.includes(k), { message: '立場を選び直してください' }),
      group_id: z.string(),
    })
    .transform((v, ctx): InviteFormOutput => {
      const kind = v.kind as InviteKind;
      if (!isGroupRole(kind)) return { email: v.email, role: kind, group_id: null, group_role: null };
      const g = uuidSchema.safeParse(v.group_id);
      if (!g.success) {
        ctx.addIssue({ code: 'custom', path: ['group_id'], message: '団体を選んでください' });
        return z.NEVER;
      }
      return { email: v.email, role: null, group_id: g.data, group_role: kind };
    });
}

// ---- 団体の CSV（3.2）----

/** 見出し（この順。余分な列は誤り） */
export const GROUP_CSV_HEADERS = ['団体名', '表示名', '区分', '飲食', '使用場所', '別名', '並び順'] as const;

const CATEGORY_BY_LABEL: ReadonlyMap<string, GroupCategory> = new Map(
  GROUP_CATEGORIES.map((c) => [CATEGORY_LABELS[c], c] as const),
);

/** 名前の比べ方（全角・半角〔NFKC〕・前後の空白・大文字小文字を無視する） */
export function nameKey(s: string): string {
  return s.normalize('NFKC').trim().toLowerCase();
}

/** CSV の1行を読んだもの（groups の列の形） */
export interface GroupCsvRow {
  /** CSV の行番号（見出しを1行目として数える） */
  line: number;
  name: string;
  display_name: string | null;
  category: GroupCategory;
  is_food: boolean;
  location_room_id: string | null;
  aliases: string[];
  sort_order: number;
}

export interface GroupCsvError {
  /** CSV の行番号（見出しは 1）。ファイル全体の誤りは 0 */
  line: number;
  message: string;
}

export interface GroupCsvResult {
  rows: GroupCsvRow[];
  errors: GroupCsvError[];
}

/** 場所の名前・別名から id を引く（使用場所の列） */
export interface RoomLookupSource {
  id: string;
  name: string;
  aliases: readonly string[];
}

function roomLookup(rooms: readonly RoomLookupSource[]): (text: string) => string | null | undefined {
  const byName = new Map<string, string>();
  const byAlias = new Map<string, string | null>(); // 2つの場所に同じ別名があれば null（決められない）
  for (const r of rooms) byName.set(nameKey(r.name), r.id);
  for (const r of rooms) {
    for (const a of r.aliases) {
      const k = nameKey(a);
      if (byName.has(k)) continue;
      byAlias.set(k, byAlias.has(k) && byAlias.get(k) !== r.id ? null : r.id);
    }
  }
  return (text) => {
    const k = nameKey(text);
    if (byName.has(k)) return byName.get(k)!;
    if (byAlias.has(k)) return byAlias.get(k) ?? undefined;
    return undefined;
  };
}

/**
 * 団体の CSV（見出し `団体名,表示名,区分,飲食,使用場所,別名,並び順`）を読む（3.2）。
 * - 区分は「模擬店・部門・企業・休憩所」、飲食は「はい・いいえ」（空はいいえ）、使用場所は場所の名前か別名（空は校内に分散）、
 *   別名は「|」区切り、並び順は整数（空なら行の順×10）。
 * - 行ごとに zod で確かめ、誤りは行番号と理由だけを返す（中身は返さない）。CSV の中の同じ団体名（大文字・小文字・全角・半角を
 *   無視して同じもの）も誤りにする。年度の全団体との checkGroupNames は、取り込んだ後の団体の一覧に呼ぶ側が当てる。
 * - ファイルの中身はどこにも保存しない（呼ぶ側も画面の状態にだけ持つ）。
 */
export function parseGroupsCsv(text: string, rooms: readonly RoomLookupSource[]): GroupCsvResult {
  let table: string[][];
  try {
    table = parseCsvLoose(text);
  } catch {
    return { rows: [], errors: [{ line: 0, message: 'CSV として読めません（引用符が閉じていないなど）' }] };
  }
  const nonEmpty = (r: string[]) => r.some((c) => c.trim() !== '');
  if (table.length === 0 || !nonEmpty(table[0]!)) {
    return { rows: [], errors: [{ line: 0, message: '空のファイルです' }] };
  }
  const header = table[0]!.map((h) => h.trim());
  while (header.length > GROUP_CSV_HEADERS.length && header[header.length - 1] === '') header.pop();
  if (header.length !== GROUP_CSV_HEADERS.length || header.some((h, k) => h !== GROUP_CSV_HEADERS[k])) {
    return {
      rows: [],
      errors: [{ line: 1, message: `見出しは「${GROUP_CSV_HEADERS.join(',')}」にしてください` }],
    };
  }

  const findRoom = roomLookup(rooms);
  const rows: GroupCsvRow[] = [];
  const errors: GroupCsvError[] = [];
  const seen = new Map<string, number>();
  table.slice(1).forEach((cells, k) => {
    const line = k + 2;
    if (!nonEmpty(cells)) return;
    if (cells.length > GROUP_CSV_HEADERS.length && cells.slice(GROUP_CSV_HEADERS.length).some((c) => c.trim() !== '')) {
      errors.push({ line, message: '見出しのない列に値があります' });
      return;
    }
    const [name = '', displayName = '', category = '', food = '', room = '', aliases = '', sortOrder = ''] = cells;
    const fail = (message: string) => errors.push({ line, message });

    const n = groupNameField.safeParse(name);
    if (!n.success) return fail(n.error.issues[0]?.message ?? '団体名が正しくありません');
    const dn = optionalText(NAME_MAX).safeParse(displayName);
    if (!dn.success) return fail(`表示名は ${NAME_MAX} 字までです`);
    const cat = CATEGORY_BY_LABEL.get(category.trim());
    if (!cat) return fail('区分は「模擬店」「部門」「企業」「休憩所」のどれかにしてください');
    const f = food.trim();
    if (f !== '' && f !== 'はい' && f !== 'いいえ') return fail('飲食は「はい」か「いいえ」にしてください');
    let location: string | null = null;
    if (room.trim() !== '') {
      const id = findRoom(room);
      if (id === undefined) return fail('使用場所が場所の名前・別名にありません');
      location = id;
    }
    const al = aliasesText.safeParse(aliases);
    if (!al.success) return fail(al.error.issues[0]?.message ?? '別名が正しくありません');
    let order = (k + 1) * 10;
    if (sortOrder.trim() !== '') {
      const so = sortOrderText.safeParse(sortOrder);
      if (!so.success) return fail(so.error.issues[0]?.message ?? '並び順が正しくありません');
      order = so.data;
    }
    const key = nameKey(n.data);
    const first = seen.get(key);
    if (first !== undefined) return fail(`団体名が ${first} 行目と同じです`);
    seen.set(key, line);
    rows.push({
      line,
      name: n.data,
      display_name: dn.data,
      category: cat,
      is_food: f === 'はい',
      location_room_id: location,
      aliases: al.data,
      sort_order: order,
    });
  });
  if (rows.length === 0 && errors.length === 0) errors.push({ line: 0, message: '団体の行がありません' });
  return { rows, errors };
}
