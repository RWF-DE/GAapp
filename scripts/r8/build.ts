// R8 の元データ（R8_SOURCE_DIR）から fixtures/r8 の生成ファイルを作る（設計 3.8）。
// 個人情報の扱い：ログ・例外には、元データの団体名・備考・メールなどの値を出さない。出してよいのは
// 行番号・列の見出し・fixtures の名前（匿名化の後・manual/ に書いた名前）・数だけ。
import { existsSync, readFileSync } from 'node:fs';
import path from 'node:path';
import { INITIAL_ITEMS, ITEM_CODES, RESERVED_GROUP_NAMES, type Item } from '@gaapp/shared';
import {
  formatFixtureFiles,
  formatReferenceFiles,
  parseFixtureFiles,
  fixtureIds,
  fixtureItems,
  referenceAllocationSchema,
  referenceGroupTotalSchema,
  emptyCounts,
  type FixtureData,
  type FixtureGroup,
  type FixtureReference,
  type ItemCounts,
  type ReferenceAllocation,
} from '@gaapp/shared/testing';
import { ImportFormatError, parseCsvLoose, parseFormCsv, resolveResponses, type FormKind, type ImportGroup } from '../../packages/importer/src/index';

/** メッセージに元データの値を入れない（行番号・見出し・fixtures の名前だけ） */
export class BuildError extends Error {}

export const SOURCE_FILES = {
  stall: 'forms/stall.csv',
  department: 'forms/department.csv',
  company: 'forms/company.csv',
  companyMap: 'forms/company_map.csv',
  stock: 'stock.csv',
  allocation: 'allocation.csv',
  allocationTotals: 'allocation_totals.csv',
  anonymize: 'anonymize.csv',
} as const;

export const MANUAL_COLUMNS = {
  groups: ['name', 'display_name', 'category', 'is_food', 'location', 'sort_order', 'aliases', 'submission'],
  adjustments: ['group', 'item', 'op', 'count', 'reason'],
  referenceSkip: ['use', 'reason'],
} as const;

/** 振り分け表の備考として許す文言（settings.json の allowedNotes で足せる） */
export const DEFAULT_ALLOWED_NOTES = ['キャスター机に交換'] as const;

export const USAGE = `R8 の元データが見つかりません。環境変数 R8_SOURCE_DIR に、リポジトリの外の非公開フォルダを指定してください。
そのフォルダに必要なファイル（すべて UTF-8 の CSV。Excel から「CSV UTF-8」で書き出す）：
  forms/stall.csv        模擬店フォームの回答（Googleフォームのスプレッドシートを書き出したもの）
  forms/department.csv   部門フォームの回答
  forms/company.csv      企業フォームの回答（なければ省略可。あれば forms/company_map.csv も必要）
  forms/company_map.csv  列：row, group（company.csv の行番号 → 団体名。見出しは 1 行目）
  stock.csv              机椅子数えの最終値。1 列目が場所名、あとは品目の列（机(木)・不可机・椅子(木)・…）
  allocation.csv         振り分け表の行。列：品目, 運び元, 使用用途, 数, 備考
  allocation_totals.csv  振り分け表の団体別集計。1 列目が使用用途、あとは品目の列
  anonymize.csv          （省略可）列：source_name, fixture_name（個人名を含む団体名の仮名への対応）
手で書いたファイル（fixtures/r8 の rooms.csv・rules.json・distance_overrides.csv・meta.json と manual/）も必要です。
実行：R8_SOURCE_DIR=<フォルダ> pnpm build:r8-fixtures    詳しくは fixtures/r8/README.md`;

// ---- 小さな道具 ----

const compact = (s: string) => s.normalize('NFKC').replace(/\s+/gu, '').toLowerCase();

type Table = { header: string[]; rows: { rowNumber: number; cells: Record<string, string> }[] };

function readText(file: string, label: string): string {
  if (!existsSync(file)) throw new BuildError(`${label} がありません`);
  return readFileSync(file, 'utf8');
}

/** 見出しのある CSV。完全に空の行は飛ばす。rowNumber は見出し＝1 のレコード番号 */
function readTable(file: string, label: string): Table {
  let records: string[][];
  try {
    records = parseCsvLoose(readText(file, label));
  } catch (e) {
    if (e instanceof ImportFormatError) throw new BuildError(`${label}: ${e.message}`);
    throw e;
  }
  const header = records[0]?.map((h) => h.trim());
  if (!header) throw new BuildError(`${label}: 見出しがありません`);
  const rows: Table['rows'] = [];
  records.slice(1).forEach((r, k) => {
    if (r.every((c) => c.trim() === '')) return;
    if (r.length > header.length && r.slice(header.length).some((c) => c.trim() !== ''))
      throw new BuildError(`${label}:${k + 2}: 見出しより多くの列があります`);
    rows.push({ rowNumber: k + 2, cells: Object.fromEntries(header.map((h, i) => [h, (r[i] ?? '').trim()])) });
  });
  return { header, rows };
}

function requireHeader(t: Table, expected: readonly string[], label: string): void {
  if (t.header.length !== expected.length || t.header.some((h, i) => h !== expected[i]))
    throw new BuildError(`${label}: 見出しが違います（期待：${expected.join(',')}）`);
}

function intCell(s: string, where: string): number {
  const n = s.normalize('NFKC').trim();
  if (n === '') return 0;
  if (!/^\d{1,9}$/.test(n)) throw new BuildError(`${where}: 数ではありません`);
  return Number(n);
}

function boolCell(s: string, where: string): boolean {
  if (s !== 'true' && s !== 'false') throw new BuildError(`${where}: true か false にしてください`);
  return s === 'true';
}

const itemLookup = (() => {
  const m = new Map<string, string>();
  for (const i of INITIAL_ITEMS) for (const k of [i.code, i.name, ...i.aliases]) m.set(compact(k), i.code);
  return (s: string) => m.get(compact(s));
})();

/** 品目の列の見出し → 品目コード。合わない見出しは失敗（見出しは質問文なので出してよい） */
function itemColumns(t: Table, firstCols: number, label: string): Map<string, string> {
  const out = new Map<string, string>();
  const seen = new Set<string>();
  for (const h of t.header.slice(firstCols)) {
    if (h === '') continue;
    const code = itemLookup(h);
    if (!code) throw new BuildError(`${label}: 品目として読めない列があります：${h}`);
    if (seen.has(code)) throw new BuildError(`${label}: 同じ品目の列が複数あります：${h}`);
    seen.add(code);
    out.set(h, code);
  }
  return out;
}

// ---- 手で書いたファイル（manual/） ----

type Submission = 'form' | 'proxy' | 'none';
type ManualGroup = Omit<FixtureGroup, 'submittedAt'> & { submission: Submission };
type Adjustment = { group: string; item: string; op: 'add' | 'set'; count: number };
type Settings = {
  proxySubmittedAt: string | null;
  splitGroups: Record<string, string[]>;
  allowedNotes: string[];
};

function readManual(dir: string) {
  const g = readTable(path.join(dir, 'groups.csv'), 'manual/groups.csv');
  requireHeader(g, MANUAL_COLUMNS.groups, 'manual/groups.csv');
  const groups: ManualGroup[] = g.rows.map(({ rowNumber, cells: c }) => {
    const at = `manual/groups.csv:${rowNumber}`;
    if (!(['stall', 'department', 'company', 'rest_area'] as const).includes(c.category as 'stall'))
      throw new BuildError(`${at}: category が違います`);
    if (!(['form', 'proxy', 'none'] as const).includes(c.submission as Submission))
      throw new BuildError(`${at}: submission は form・proxy・none のどれかです`);
    return {
      name: c.name!,
      displayName: c.display_name === '' ? null : c.display_name!,
      category: c.category as ManualGroup['category'],
      isFood: boolCell(c.is_food!, at),
      location: c.location === '' ? null : c.location!,
      sortOrder: intCell(c.sort_order!, at),
      aliases: c.aliases === '' ? [] : c.aliases!.split('|'),
      submission: c.submission as Submission,
    };
  });

  const a = readTable(path.join(dir, 'adjustments.csv'), 'manual/adjustments.csv');
  requireHeader(a, MANUAL_COLUMNS.adjustments, 'manual/adjustments.csv');
  const adjustments: Adjustment[] = a.rows.map(({ rowNumber, cells: c }) => {
    const at = `manual/adjustments.csv:${rowNumber}`;
    if (!(ITEM_CODES as readonly string[]).includes(c.item!)) throw new BuildError(`${at}: 品目コードが違います`);
    if (c.op !== 'add' && c.op !== 'set') throw new BuildError(`${at}: op は add か set です`);
    if (c.reason === '') throw new BuildError(`${at}: reason が空です`);
    return { group: c.group!, item: c.item!, op: c.op, count: intCell(c.count!, at) };
  });

  const s = readTable(path.join(dir, 'reference_skip.csv'), 'manual/reference_skip.csv');
  requireHeader(s, MANUAL_COLUMNS.referenceSkip, 'manual/reference_skip.csv');
  const referenceSkip = s.rows.map((r) => r.cells.use!);

  const raw: unknown = JSON.parse(readText(path.join(dir, 'settings.json'), 'manual/settings.json'));
  if (typeof raw !== 'object' || raw === null || Array.isArray(raw)) throw new BuildError('manual/settings.json: オブジェクトではありません');
  const o = raw as Record<string, unknown>;
  for (const k of Object.keys(o))
    if (!['proxySubmittedAt', 'splitGroups', 'allowedNotes'].includes(k)) throw new BuildError(`manual/settings.json: 知らないキー ${k}`);
  const proxy = o.proxySubmittedAt;
  if (proxy !== undefined && proxy !== null && (typeof proxy !== 'string' || Number.isNaN(Date.parse(proxy)) || !/[+-]\d{2}:\d{2}$|Z$/.test(proxy)))
    throw new BuildError('manual/settings.json: proxySubmittedAt は +09:00 つきの ISO 日時にしてください');
  const split = (o.splitGroups ?? {}) as Record<string, unknown>;
  const splitGroups: Record<string, string[]> = {};
  for (const [k, v] of Object.entries(split)) {
    if (!Array.isArray(v) || v.length < 2 || v.some((x) => typeof x !== 'string'))
      throw new BuildError('manual/settings.json: splitGroups は 団体名 → 2 つ以上の団体名の配列 です');
    splitGroups[k] = v as string[];
  }
  const allowedNotes = (o.allowedNotes ?? []) as unknown;
  if (!Array.isArray(allowedNotes) || allowedNotes.some((x) => typeof x !== 'string'))
    throw new BuildError('manual/settings.json: allowedNotes は文字列の配列です');
  const settings: Settings = {
    proxySubmittedAt: (proxy as string | null | undefined) ?? null,
    splitGroups,
    allowedNotes: [...DEFAULT_ALLOWED_NOTES, ...(allowedNotes as string[])],
  };
  return { groups, adjustments, referenceSkip, settings };
}

// ---- 本体 ----

export type BuildOptions = {
  sourceDir: string;
  /** 手で書いたファイルと、生成物の置き場（fixtures/r8） */
  outDir: string;
  /** 取り込めなかった行・団体に対応しなかった行があっても続ける */
  allowRejected?: boolean;
};

export type BuildReport = {
  formSuperseded: { form: FormKind; group: string; droppedRows: number }[];
  formWithoutResponse: string[];
  requestedItemDiffs: { group: string; item: string; requested: number; reference: number }[];
  splitExcess: { group: string; item: string; count: number }[];
  excludedFromTotals: string[];
  totalsCount: number;
  skippedFormRows: { form: FormKind; rowNumber: number; reason: string }[];
  /**
   * 同じ団体の、使う回答より新しい回答が取り込まない行になった団体（resolveResponses の newerRejected。--allow-rejected のときだけ）。
   * 一番新しい回答が読めないので取り込まず、submitted_at は空（formWithoutResponse には入れない）。group は匿名化した名前
   */
  formNewerRejected: { form: FormKind; group: string; rows: { rowNumber: number; reason: string }[] }[];
  /** 完全に空の行（Excel の書き出しの「,,,,」）。失敗にせず、件数だけ残す */
  emptyFormRows: { form: FormKind; count: number }[];
};

export type BuildResult = { files: Record<string, string>; report: BuildReport };

export function buildR8Fixtures(opts: BuildOptions): BuildResult {
  const { sourceDir, outDir } = opts;
  const src = (k: keyof typeof SOURCE_FILES) => path.join(sourceDir, SOURCE_FILES[k]);
  const manual = readManual(path.join(outDir, 'manual'));
  const { settings } = manual;
  const meta = JSON.parse(readText(path.join(outDir, 'meta.json'), 'meta.json')) as { yearLabel: string };
  const label = meta.yearLabel;

  // 団体
  const groupByName = new Map(manual.groups.map((g) => [g.name, g]));
  if (groupByName.size !== manual.groups.length) throw new BuildError('manual/groups.csv: 団体名が重複しています');
  const groupLookup = new Map<string, string>(); // 正規化した名前・別名 → 団体名
  for (const g of manual.groups)
    for (const n of [g.name, ...g.aliases]) {
      const k = compact(n);
      const prev = groupLookup.get(k);
      if (prev !== undefined && prev !== g.name) throw new BuildError(`manual/groups.csv: 名前・別名が 2 つの団体に当たります（${prev}・${g.name}）`);
      groupLookup.set(k, g.name);
    }
  for (const [k, parts] of Object.entries(settings.splitGroups)) {
    for (const p of parts) if (!groupByName.has(p)) throw new BuildError(`manual/settings.json: splitGroups の団体 ${p} が manual/groups.csv にありません`);
    if (groupLookup.has(compact(k))) throw new BuildError('manual/settings.json: splitGroups の元の名前が、manual/groups.csv の名前・別名と重なっています');
  }
  for (const g of manual.groups)
    if (g.submission === 'proxy' && settings.proxySubmittedAt === null)
      throw new BuildError('代理入力の団体があるので manual/settings.json の proxySubmittedAt が必要です');

  // 匿名化（元データの名前 → fixtures の名前）
  const anon = new Map<string, string>();
  if (existsSync(src('anonymize'))) {
    const t = readTable(src('anonymize'), 'anonymize.csv');
    requireHeader(t, ['source_name', 'fixture_name'], 'anonymize.csv');
    // 元の名前（個人名を含みうる）が手で書いたファイルにあると、生成する groups.csv などに出てしまう。
    // manual/ の名前の欄はすべてここで確かめる。値は出さず、anonymize.csv の行番号とファイル名・欄だけ示す
    const manualNames: { where: string; keys: Set<string> }[] = [
      { where: 'manual/groups.csv の name・aliases', keys: new Set(groupLookup.keys()) },
      { where: 'manual/groups.csv の display_name', keys: new Set(manual.groups.flatMap((g) => (g.displayName === null ? [] : [compact(g.displayName)]))) },
      { where: 'manual/reference_skip.csv の use', keys: new Set(manual.referenceSkip.map(compact)) },
      { where: 'manual/settings.json の splitGroups', keys: new Set(Object.keys(settings.splitGroups).map(compact)) },
    ];
    for (const r of t.rows) {
      const key = compact(r.cells.source_name!);
      const hit = manualNames.find((m) => m.keys.has(key));
      if (hit) throw new BuildError(`anonymize.csv:${r.rowNumber}: source_name が ${hit.where} に入っています（元の名前を fixtures に書かないでください）`);
      anon.set(key, r.cells.fixture_name!);
    }
  }
  const anonymize = (s: string) => anon.get(compact(s)) ?? s;

  // 場所
  const roomsTable = readTable(path.join(outDir, 'rooms.csv'), 'rooms.csv');
  const roomLookup = new Map<string, string>();
  for (const r of roomsTable.rows)
    for (const n of [r.cells.name!, ...(r.cells.aliases ? r.cells.aliases.split('|') : [])]) roomLookup.set(compact(n), r.cells.name!);
  const roomUsable = new Map(roomsTable.rows.map((r) => [r.cells.name!, boolCell(r.cells.usable!, `rooms.csv:${r.rowNumber}`)]));
  const roomOrder = new Map(roomsTable.rows.map((r, i) => [r.cells.name!, i]));

  const report: BuildReport = {
    formSuperseded: [],
    formWithoutResponse: [],
    requestedItemDiffs: [],
    splitExcess: [],
    excludedFromTotals: [],
    totalsCount: 0,
    skippedFormRows: [],
    formNewerRejected: [],
    emptyFormRows: [],
  };

  // ---- フォーム回答 → 申請（importer と同じ関数） ----
  const items: Item[] = fixtureItems();
  const itemDefs = INITIAL_ITEMS.map((i) => ({ code: i.code, aliases: i.aliases }));
  const gid = (name: string) => fixtureIds.group(label, name);
  const nameOfId = new Map(manual.groups.map((g) => [gid(g.name), g.name]));
  const submittedAt = new Map<string, string>();
  const requests = new Map<string, ItemCounts>(); // 団体名 → 数
  const countsOf = (name: string) => {
    let c = requests.get(name);
    if (!c) requests.set(name, (c = emptyCounts()));
    return c;
  };
  const codeOfId = new Map(items.map((i) => [i.id, i.code]));
  const fail = (form: FormKind, rowNumber: number, reason: string) => {
    if (!opts.allowRejected) throw new BuildError(`forms/${form}.csv:${rowNumber}: 取り込めない行です（${reason}）`);
    report.skippedFormRows.push({ form, rowNumber, reason });
  };

  const formKinds: { kind: FormKind; category: ManualGroup['category'] }[] = [
    { kind: 'stall', category: 'stall' },
    { kind: 'department', category: 'department' },
    { kind: 'company', category: 'company' },
  ];
  for (const { kind, category } of formKinds) {
    if (!existsSync(src(kind))) {
      if (kind !== 'company') throw new BuildError(`${SOURCE_FILES[kind]} がありません`);
      continue;
    }
    let parsed: ReturnType<typeof parseFormCsv>;
    try {
      parsed = parseFormCsv(kind, readFileSync(src(kind), 'utf8'), itemDefs);
    } catch (e) {
      // 見出しが合わないなど。メッセージには元データの値が入らない（ImportFormatError）ので、どのフォームの何が合わないかを示す
      if (e instanceof ImportFormatError) throw new BuildError(`${SOURCE_FILES[kind]}: ${e.message}`);
      throw e;
    }
    const empty = parsed.rejected.filter((r) => r.reason === 'empty').length;
    if (empty > 0) report.emptyFormRows.push({ form: kind, count: empty });
    for (const r of parsed.rejected) if (r.reason !== 'empty') fail(kind, r.rowNumber, r.reason);
    for (const r of parsed.responses) if (r.groupName !== null) r.groupName = anonymize(r.groupName);
    // 取り込まない行の団体名も同じ名前で団体に当てる（同じ団体の新しい回答が読めない団体は resolveResponses が newerRejected にし、取り込まない。下で扱う）
    for (const r of parsed.rejected) if (r.groupName !== null) r.groupName = anonymize(r.groupName);
    const manualMap: Record<number, string> = {};
    if (kind === 'company') {
      const t = readTable(src('companyMap'), SOURCE_FILES.companyMap);
      requireHeader(t, ['row', 'group'], SOURCE_FILES.companyMap);
      for (const r of t.rows) {
        const g = groupByName.get(r.cells.group!);
        if (!g) throw new BuildError(`${SOURCE_FILES.companyMap}:${r.rowNumber}: manual/groups.csv にない団体です`);
        manualMap[intCell(r.cells.row!, `${SOURCE_FILES.companyMap}:${r.rowNumber}`)] = gid(g.name);
      }
    }
    const importGroups: ImportGroup[] = manual.groups
      .filter((g) => g.category === category && g.submission === 'form')
      .map((g) => ({ id: gid(g.name), name: g.name, aliases: g.aliases, category: g.category }));
    const res = resolveResponses(parsed, importGroups, items, manualMap);
    for (const u of res.unmatched) fail(kind, u.rowNumber, '団体に対応しません');
    // 使う回答より新しい回答が取り込まない行の団体は、取り込まない行と同じ扱い（--allow-rejected でなければ止め、なら report に残す）
    for (const n of res.newerRejected) {
      const rows = n.rejectedRows.map((r) => ({ rowNumber: r.rowNumber, reason: r.reason }));
      if (!opts.allowRejected) {
        const first = rows[0]!;
        throw new BuildError(`forms/${kind}.csv:${first.rowNumber}: 同じ団体の新しい回答が取り込めない行です（${first.reason}）。この団体の回答は取り込めません`);
      }
      report.formNewerRejected.push({ form: kind, group: nameOfId.get(n.groupId)!, rows });
    }
    for (const s of res.superseded)
      report.formSuperseded.push({ form: kind, group: nameOfId.get(s.groupId)!, droppedRows: s.droppedRows.length });
    for (const s of res.submissions) submittedAt.set(nameOfId.get(s.groupId)!, s.submittedAt);
    for (const r of res.requests) countsOf(nameOfId.get(r.groupId)!)[codeOfId.get(r.itemId) as keyof ItemCounts] += r.count;
  }
  const newerRejectedGroups = new Set(report.formNewerRejected.map((n) => n.group));
  report.formWithoutResponse = manual.groups
    .filter((g) => g.submission === 'form' && !submittedAt.has(g.name) && !newerRejectedGroups.has(g.name))
    .map((g) => g.name);

  // ---- 手で決めた読み替え・追加・代理入力 ----
  for (const a of manual.adjustments) {
    const g = groupByName.get(a.group);
    if (!g) throw new BuildError('manual/adjustments.csv: manual/groups.csv にない団体があります');
    if (g.submission === 'none') throw new BuildError(`manual/adjustments.csv: 未提出の団体 ${g.name} には足せません`);
    const c = countsOf(g.name);
    const k = a.item as keyof ItemCounts;
    c[k] = a.op === 'set' ? a.count : c[k] + a.count;
  }

  const groups: FixtureGroup[] = manual.groups.map(({ submission, ...g }) => ({
    ...g,
    submittedAt: submission === 'form' ? (submittedAt.get(g.name) ?? null) : submission === 'proxy' ? settings.proxySubmittedAt : null,
  }));
  const orderedGroups = manual.groups.slice().sort((a, b) => a.sortOrder - b.sortOrder);
  const requestRows = orderedGroups
    .filter((g) => g.submission !== 'none')
    .map((g) => ({ group: g.name, counts: countsOf(g.name) }));

  // ---- 在庫 ----
  const st = readTable(src('stock'), SOURCE_FILES.stock);
  const stockCols = itemColumns(st, 1, SOURCE_FILES.stock);
  const stockBy = new Map<string, ItemCounts>();
  for (const r of st.rows) {
    const room = roomLookup.get(compact(r.cells[st.header[0]!]!));
    if (!room) throw new BuildError(`${SOURCE_FILES.stock}:${r.rowNumber}: rooms.csv の name・aliases に合わない場所です`);
    if (stockBy.has(room)) throw new BuildError(`${SOURCE_FILES.stock}:${r.rowNumber}: 同じ場所が複数行あります（${room}）`);
    const c = emptyCounts();
    for (const [h, code] of stockCols) c[code as keyof ItemCounts] = intCell(r.cells[h]!, `${SOURCE_FILES.stock}:${r.rowNumber}`);
    stockBy.set(room, c);
  }
  const stocks = [...stockBy].sort((a, b) => roomOrder.get(a[0])! - roomOrder.get(b[0])!).map(([room, counts]) => ({ room, counts }));

  // ---- reference ----
  const reference = buildReference();

  function buildReference(): FixtureReference {
    // 「残す」は団体名ではない。集計シートでは除き、振り分け表では運び元の部屋の団体の行にする（下）
    const keepKey = compact('残す');
    const skipKeys = new Set([...RESERVED_GROUP_NAMES, '合計', '計', ...manual.referenceSkip].map(compact));
    const splitKeys = new Map(Object.entries(settings.splitGroups).map(([k, v]) => [compact(k), v]));
    const resolveUse = (use: string): { skip: true } | { skip: false; group?: string; split?: string[] } => {
      const a = anonymize(use);
      if (skipKeys.has(compact(a))) return { skip: true };
      const split = splitKeys.get(compact(a));
      if (split) return { skip: false, split };
      const g = groupLookup.get(compact(a));
      return g ? { skip: false, group: g } : { skip: false };
    };
    const allowed = new Set(settings.allowedNotes.map(compact));

    type Row = { item: string; source: string; use: { group?: string; split?: string[] }; requestedItem: string; count: number; note: string | null; rowNumber: number };
    const t = readTable(src('allocation'), SOURCE_FILES.allocation);
    requireHeader(t, ['品目', '運び元', '使用用途', '数', '備考'], SOURCE_FILES.allocation);
    const rows: Row[] = [];
    for (const r of t.rows) {
      const at = `${SOURCE_FILES.allocation}:${r.rowNumber}`;
      const useRaw = r.cells['使用用途']!;
      let u: ReturnType<typeof resolveUse>;
      let keepSource: string | undefined;
      if (compact(useRaw) === keepKey) {
        // 「残す」（S08）：使えない部屋の行は除く。使える部屋の行は、その部屋を使用場所とする団体の行にする
        keepSource = roomLookup.get(compact(r.cells['運び元']!));
        if (!keepSource) throw new BuildError(`${at}: rooms.csv の name・aliases に合わない運び元です`);
        if (!roomUsable.get(keepSource)) continue;
        const owners = manual.groups.filter((g) => g.location === keepSource);
        if (owners.length !== 1)
          throw new BuildError(
            `${at}: 使用用途「残す」の運び元 ${keepSource} を使用場所とする団体が${owners.length === 0 ? 'ありません' : '複数あります'}（manual/groups.csv の location を確かめてください）`,
          );
        u = { skip: false, group: owners[0]!.name };
      } else u = resolveUse(useRaw);
      if (u.skip) continue;
      const item = itemLookup(r.cells['品目']!);
      if (!item) throw new BuildError(`${at}: 品目として読めません`);
      const count = intCell(r.cells['数']!, at);
      if (count === 0) continue;
      const source = keepSource ?? roomLookup.get(compact(r.cells['運び元']!));
      if (!source) throw new BuildError(`${at}: rooms.csv の name・aliases に合わない運び元です`);
      if (!u.group && !u.split) throw new BuildError(`${at}: 使用用途が団体に対応しません（manual/groups.csv の name・aliases か anonymize.csv に足してください）`);
      const noteRaw = r.cells['備考']!.normalize('NFKC').trim();
      if (noteRaw !== '' && !allowed.has(compact(noteRaw))) throw new BuildError(`${at}: 備考が許す文言にありません（settings.json の allowedNotes に足すか、備考を直してください）`);
      const note = noteRaw === '' ? null : (settings.allowedNotes.find((n) => compact(n) === compact(noteRaw)) ?? noteRaw);
      rows.push({ item, source, use: u, requestedItem: item, count, note, rowNumber: r.rowNumber });
    }

    // requested_item（S01〜S07。団体が決まっていれば決まる。剣道部は分けた後の団体の区分に依らず同じ規則）
    for (const r of rows) {
      if (r.item === 'desk_ng') r.requestedItem = 'desk';
      else if (r.item === 'chair_ng') r.requestedItem = 'chair';
      else if (r.item === 'caster_desk' && r.note === 'キャスター机に交換') r.requestedItem = 'desk';
    }
    // 企業の長机(2人掛) の一部は長机(3人掛)の申請（S04）
    const out: ReferenceAllocation[] = [];
    const allocatedLd3 = new Map<string, number>();
    for (const r of rows) if (r.use.group && r.item === 'long_desk_3') allocatedLd3.set(r.use.group, (allocatedLd3.get(r.use.group) ?? 0) + r.count);
    const ld3Left = new Map<string, number>();
    const pieces: { row: Row; count: number; requestedItem: string }[] = [];
    for (const r of rows) {
      if (r.use.group && groupByName.get(r.use.group)!.category === 'company' && r.item === 'long_desk_2') {
        const g = r.use.group;
        if (!ld3Left.has(g)) ld3Left.set(g, Math.max(0, (requests.get(g)?.long_desk_3 ?? 0) - (allocatedLd3.get(g) ?? 0)));
        const left = ld3Left.get(g)!;
        const as3 = Math.min(left, r.count);
        ld3Left.set(g, left - as3);
        if (as3 > 0) pieces.push({ row: r, count: as3, requestedItem: 'long_desk_3' });
        if (r.count - as3 > 0) pieces.push({ row: r, count: r.count - as3, requestedItem: 'long_desk_2' });
      } else pieces.push({ row: r, count: r.count, requestedItem: r.requestedItem });
    }
    // 分ける団体（剣道部）：requested_item ごとに、並び順（splitGroups の配列の順）に申請を満たすように、
    // 表の行の順に割り振る。申請より多い分は最後の団体に付ける
    const remaining = new Map<string, number>();
    const excess = new Map<string, number>();
    const splitMembers = new Set([...splitKeys.values()].flat());
    for (const p of pieces) {
      const base = { item: p.row.item, source: p.row.source, requestedItem: p.requestedItem, note: p.row.note };
      if (!p.row.use.split) {
        out.push({ ...base, group: p.row.use.group!, count: p.count });
        continue;
      }
      const parts = p.row.use.split;
      let left = p.count;
      parts.forEach((g, k) => {
        const ck = `${g}|${p.requestedItem}`;
        if (!remaining.has(ck)) remaining.set(ck, requests.get(g)?.[p.requestedItem as keyof ItemCounts] ?? 0);
        const room = remaining.get(ck)!;
        const isLast = k === parts.length - 1;
        const take = isLast ? left : Math.min(left, room);
        remaining.set(ck, Math.max(0, room - take));
        if (isLast && take > room) excess.set(ck, (excess.get(ck) ?? 0) + (take - room));
        if (take > 0) out.push({ ...base, group: g, count: take });
        left -= take;
      });
    }
    for (const [ck, count] of excess) {
      const [group, item] = ck.split('|') as [string, string];
      report.splitExcess.push({ group, item, count });
    }
    // 分けた後の合計が、振り分け表の行の合計と品目ごとに等しい
    const before = new Map<string, number>();
    const after = new Map<string, number>();
    for (const p of pieces) if (p.row.use.split) before.set(p.row.item, (before.get(p.row.item) ?? 0) + p.count);
    for (const a of out) if (splitMembers.has(a.group)) after.set(a.item, (after.get(a.item) ?? 0) + a.count);
    for (const [item, n] of before) if ((after.get(item) ?? 0) !== n) throw new BuildError(`分けた団体の合計が振り分け表の行と違います（${item}）`);

    // (団体, requested_item) ごとの合計が申請と違う組を報告する（失敗にしない）
    const sums = new Map<string, number>();
    for (const a of out) sums.set(`${a.group}|${a.requestedItem}`, (sums.get(`${a.group}|${a.requestedItem}`) ?? 0) + a.count);
    for (const g of orderedGroups) {
      for (const code of ITEM_CODES) {
        const requested = requests.get(g.name)?.[code] ?? 0;
        const referenceN = sums.get(`${g.name}|${code}`) ?? 0;
        if (requested !== referenceN) report.requestedItemDiffs.push({ group: g.name, item: code, requested, reference: referenceN });
      }
    }

    // 団体別集計
    const tt = readTable(src('allocationTotals'), SOURCE_FILES.allocationTotals);
    const tcols = itemColumns(tt, 1, SOURCE_FILES.allocationTotals);
    const sheet = new Map<string, ItemCounts>(); // 団体名 → 集計シートの値（分ける団体は、元の名前の行を団体名の組で持つ）
    const sheetSplit = new Map<string, ItemCounts>();
    for (const r of tt.rows) {
      const use = r.cells[tt.header[0]!]!;
      const u = resolveUse(use);
      if (u.skip) continue;
      const at = `${SOURCE_FILES.allocationTotals}:${r.rowNumber}`;
      if (!u.group && !u.split) throw new BuildError(`${at}: 使用用途が団体に対応しません`);
      const c = emptyCounts();
      for (const [h, code] of tcols) c[code as keyof ItemCounts] = intCell(r.cells[h]!, at);
      const key = u.split ? u.split.join('|') : u.group!;
      const target = u.split ? sheetSplit : sheet;
      const prev = target.get(key);
      if (prev) for (const code of ITEM_CODES) prev[code] += c[code];
      else target.set(key, c);
    }
    const allocSum = new Map<string, ItemCounts>(manual.groups.map((g) => [g.name, emptyCounts()]));
    for (const a of out) allocSum.get(a.group)![a.item as keyof ItemCounts] += a.count;
    const same = (a: ItemCounts, b: ItemCounts) => ITEM_CODES.every((c) => a[c] === b[c]);
    const excluded = new Set<string>();
    for (const g of manual.groups) {
      const inSplit = [...splitKeys.values()].some((parts) => parts.includes(g.name));
      if (inSplit) continue;
      if (!same(sheet.get(g.name) ?? emptyCounts(), allocSum.get(g.name)!)) excluded.add(g.name);
    }
    for (const parts of splitKeys.values()) {
      const total = emptyCounts();
      for (const p of parts) for (const c of ITEM_CODES) total[c] += allocSum.get(p)![c];
      if (!same(sheetSplit.get(parts.join('|')) ?? emptyCounts(), total)) for (const p of parts) excluded.add(p);
    }
    report.excludedFromTotals = orderedGroups.filter((g) => excluded.has(g.name)).map((g) => g.name);
    const groupTotals = orderedGroups
      .filter((g) => !excluded.has(g.name))
      .map((g) => ({ group: g.name, counts: allocSum.get(g.name)! }));
    report.totalsCount = groupTotals.length;
    return { allocations: out, groupTotals };
  }

  // ---- 組み立て・検証・書き出す中身 ----
  const read = (rel: string) => readText(path.join(outDir, rel), rel);
  const shell = {
    meta: read('meta.json'),
    rooms: read('rooms.csv'),
    distanceOverrides: read('distance_overrides.csv'),
    rules: read('rules.json'),
  };
  // rooms などは手で書いたまま。生成物と合わせて、読み込みと同じ確かめ（列・型・重複・団体名）を通す
  const data: FixtureData = parseFixtureFiles(
    {
      ...shell,
      groups: formatFixtureFiles({ ...emptyData(), groups })['groups.csv'],
      stocks: formatFixtureFiles({ ...emptyData(), stocks })['stocks.csv'],
      requests: formatFixtureFiles({ ...emptyData(), requests: requestRows })['requests.csv'],
      consents: formatFixtureFiles(emptyData())['consents.csv'],
      allocations: undefined,
      groupTotals: undefined,
    },
    outDir,
  );
  for (const g of data.groups) if (g.location !== null && !data.rooms.some((r) => r.name === g.location)) throw new BuildError(`groups: ${g.name} の使用場所が rooms.csv にありません`);
  const names = new Set(data.groups.map((g) => g.name));
  const roomNames = new Set(data.rooms.map((r) => r.name));
  for (const a of reference.allocations) {
    referenceAllocationSchema.parse(a);
    if (!names.has(a.group) || !roomNames.has(a.source)) throw new BuildError('reference/allocations.csv: 団体か運び元が fixtures にありません');
  }
  for (const g of reference.groupTotals) referenceGroupTotalSchema.parse(g);

  const fx = formatFixtureFiles(data);
  const files: Record<string, string> = {
    'groups.csv': fx['groups.csv']!,
    'stocks.csv': fx['stocks.csv']!,
    'requests.csv': fx['requests.csv']!,
    'consents.csv': fx['consents.csv']!,
    ...formatReferenceFiles(reference),
  };
  return { files, report };
}

function emptyData(): FixtureData {
  return { meta: { schemaVersion: 1, yearLabel: 'x', kind: 'r8' }, rooms: [], groups: [], stocks: [], requests: [], consents: [], distanceOverrides: [], rules: [] };
}

export function formatReport(r: BuildReport): string {
  const L: string[] = [];
  L.push(`団体別集計 group_totals.csv: ${r.totalsCount} 団体`);
  L.push(`比較から除いた団体（集計シートと振り分け表の行の合計が違う）: ${r.excludedFromTotals.length ? r.excludedFromTotals.join('、') : 'なし'}`);
  L.push(`フォームの回答がなかった団体（submitted_at は空）: ${r.formWithoutResponse.length ? r.formWithoutResponse.join('、') : 'なし'}`);
  L.push(`同じ団体の古い回答: ${r.formSuperseded.length ? r.formSuperseded.map((s) => `${s.group}(${s.form}・${s.droppedRows}件)`).join('、') : 'なし'}`);
  L.push(`申請より多く付けた分（分けた団体の最後の団体）: ${r.splitExcess.length ? r.splitExcess.map((s) => `${s.group} ${s.item} +${s.count}`).join('、') : 'なし'}`);
  L.push(`申請と手作業の requested_item が違う組: ${r.requestedItemDiffs.length} 組`);
  for (const d of r.requestedItemDiffs) L.push(`  ${d.group} ${d.item} 申請 ${d.requested} / 手作業 ${d.reference}`);
  if (r.emptyFormRows.length) L.push(`空の行（取り込まない）: ${r.emptyFormRows.map((e) => `${e.form}:${e.count}件`).join('、')}`);
  if (r.formNewerRejected.length)
    L.push(
      `新しい回答が取り込めない団体（取り込まず、submitted_at は空）: ${r.formNewerRejected
        .map((n) => `${n.group}(${n.form}・${n.rows.map((x) => `${x.rowNumber}行目 ${x.reason}`).join('・')})`)
        .join('、')}`,
    );
  if (r.skippedFormRows.length) L.push(`飛ばしたフォームの行: ${r.skippedFormRows.map((s) => `${s.form}:${s.rowNumber}(${s.reason})`).join('、')}`);
  return L.join('\n');
}
