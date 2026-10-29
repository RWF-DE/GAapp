// 振り分け表の中身（セルの値と数式）を作る。ExcelJS には依存しない純粋関数（設計 13.2、03「Excel出力仕様」）
import {
  checkGroupNames,
  compareBySortOrder,
  compareGroupsForReport,
  compareStrings,
  type Group,
  type GroupCategory,
  type Item,
  type Room,
  type YearData,
} from '@gaapp/shared';
import type { ExportRow, ReportInput } from './types';

export type FormulaCell = { formula: string; result: string | number };
export type Cell = string | number | null | FormulaCell;
export type SheetModel = {
  name: string;
  /** 1行目が見出し */
  rows: Cell[][];
  widths: number[];
};

export const KEEP_LABEL = '残す';
export const UNUSABLE_LABEL = '使用不可';
export const SURPLUS_LABEL = '余り';
export const TOTAL_LABEL = '(計)';
export const OVER_STOCK = '在庫超過';
export const NEEDS_CHECK = '要確認';

export const CATEGORY_LABELS: Record<GroupCategory, string> = {
  stall: '模擬店',
  department: '部門',
  company: '企業',
  rest_area: '休憩所',
};

/** R8 様式が使う品目（01 の初期の品目）。団体別集計の列の並びでもある */
const SUMMARY_CODES = [
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
type Code = (typeof SUMMARY_CODES)[number];

/** シートの並び。品目コードが2つのものは2列のシート（運ぶ品目と不可の品目） */
const SHEET_DEFS: readonly (readonly Code[])[] = [
  ['desk', 'desk_ng'],
  ['chair', 'chair_ng'],
  ['caster_desk'],
  ['blue_chair'],
  ['long_desk_3'],
  ['long_desk_2'],
  ['lectern'],
];

export const SUMMARY_SHEET_NAME = '団体別集計';
export const SWAPS_SHEET_NAME = 'キャスター机交換依頼一覧';

export function allocationXlsxFileName(yearLabel: string): string {
  return `${yearLabel}_椅子机振り分け_部門員共有用.xlsx`;
}
export function swapsXlsxFileName(yearLabel: string): string {
  return `${yearLabel}_キャスター机交換依頼一覧.xlsx`;
}
export function yearJsonFileName(yearLabel: string): string {
  return `${yearLabel}_年度データ.json`;
}

const colLetter = (i: number) => String.fromCharCode(65 + i);
const quoteSheet = (name: string) => `'${name.replaceAll("'", "''")}'`;

/** 出力の前の確認：SUMIF のキーにできない団体名があればファイルを作らない（K-21） */
export function assertGroupNames(groups: readonly { name: string }[]): void {
  const errors = checkGroupNames(groups);
  if (errors.length > 0) {
    throw new Error(
      `団体名を変えてから出力してください：${errors
        .map((e) => `「${groups[Number(/^groups\.(\d+)\./.exec(e.path)?.[1])]?.name ?? '?'}」${e.message}`)
        .join(' / ')}`,
    );
  }
}

type Line = {
  sourceRoomId: string;
  /** 運び先の表示（残す、または使用場所の名前） */
  dest: string;
  /** 運び先の並び（残す → -1、使用場所は sort_order） */
  destRank: number;
  group: Group;
  code: string;
  count: number;
  note: string;
};

type Context = {
  items: Map<Code, Item>;
  itemCodeById: Map<string, string>;
  rooms: Room[];
  roomById: Map<string, Room>;
  groupById: Map<string, Group>;
  stock: Map<string, number>;
  lines: Line[];
  /** 了承が要る代替（needsConsent）：`${fromId}|${toId}` → { from, to } */
  consentPairs: Map<string, { from: Item; to: Item }>;
};

const stockKey = (roomId: string, code: string) => `${roomId}|${code}`;

function buildContext(data: YearData, rows: readonly ExportRow[]): Context {
  const items = new Map<Code, Item>();
  const itemCodeById = new Map<string, string>();
  const itemById = new Map<string, Item>();
  for (const it of data.items) {
    itemCodeById.set(it.id, it.code);
    itemById.set(it.id, it);
  }
  for (const code of SUMMARY_CODES) {
    const it = data.items.find((i) => i.code === code);
    if (!it) throw new Error(`品目「${code}」がありません（振り分け表の様式に必要です）`);
    items.set(code, it);
  }
  const rooms = data.rooms.slice().sort(compareBySortOrder);
  const roomById = new Map(data.rooms.map((r) => [r.id, r]));
  const groupById = new Map(data.groups.map((g) => [g.id, g]));

  const stock = new Map<string, number>();
  for (const s of data.stocks) {
    const code = itemCodeById.get(s.itemId);
    if (!roomById.has(s.roomId)) throw new Error(`在庫の場所 ${s.roomId} が場所の一覧にありません`);
    if (code === undefined) throw new Error(`在庫の品目 ${s.itemId} が品目の一覧にありません`);
    stock.set(stockKey(s.roomId, code), (stock.get(stockKey(s.roomId, code)) ?? 0) + s.count);
  }

  const consentPairs = new Map<string, { from: Item; to: Item }>();
  for (const rule of data.rules) {
    if (rule.kind !== 'substitute' || !rule.params.needsConsent) continue;
    const from = data.items.find((i) => i.code === rule.params.from);
    const to = data.items.find((i) => i.code === rule.params.to);
    if (from && to) consentPairs.set(`${from.id}|${to.id}`, { from, to });
  }

  const lines: Line[] = rows.map((row, k) => {
    const code = itemCodeById.get(row.itemId);
    if (code === undefined) throw new Error(`振り分けの行 ${k + 1}：品目 ${row.itemId} が品目の一覧にありません`);
    if (!(SUMMARY_CODES as readonly string[]).includes(code)) {
      throw new Error(`振り分けの行 ${k + 1}：品目「${code}」は振り分け表の様式にありません`);
    }
    if (!roomById.has(row.sourceRoomId)) throw new Error(`振り分けの行 ${k + 1}：運び元の場所が場所の一覧にありません`);
    const group = groupById.get(row.groupId);
    if (!group) throw new Error(`振り分けの行 ${k + 1}：団体 ${row.groupId} が団体の一覧にありません`);
    let dest: string;
    let destRank: number;
    if (row.isKeep) {
      dest = KEEP_LABEL;
      destRank = -1;
    } else {
      // 使用場所のない団体（校内に分散するなど）は運び先を空にする
      const loc = group.locationRoomId === null ? undefined : roomById.get(group.locationRoomId);
      dest = loc?.name ?? '';
      destRank = loc?.sortOrder ?? Number.MAX_SAFE_INTEGER;
    }
    const manual = row.note?.trim() ?? '';
    let note = manual;
    if (note === '') {
      const pair = consentPairs.get(`${row.requestedItemId}|${row.itemId}`);
      if (pair) note = `${pair.to.name}に交換`;
    }
    return { sourceRoomId: row.sourceRoomId, dest, destRank, group, code, count: row.count, note };
  });

  return { items, itemCodeById, rooms, roomById, groupById, stock, lines, consentPairs };
}

type Aggregated = { sourceRoomId: string; dest: string; destRank: number; group: Group; counts: number[]; notes: string[] };

function aggregate(lines: readonly Line[], codes: readonly Code[]): Aggregated[] {
  const map = new Map<string, Aggregated>();
  for (const l of lines) {
    const j = codes.indexOf(l.code as Code);
    if (j < 0) continue;
    // 1列のシートでは備考が違う行は分ける。2列のシートは備考を「、」でつなぐ
    const key = [l.sourceRoomId, l.dest, l.group.id, codes.length === 1 ? l.note : ''].join('\u0000');
    let a = map.get(key);
    if (!a) {
      a = { sourceRoomId: l.sourceRoomId, dest: l.dest, destRank: l.destRank, group: l.group, counts: codes.map(() => 0), notes: [] };
      map.set(key, a);
    }
    a.counts[j]! += l.count;
    if (l.note !== '' && !a.notes.includes(l.note)) a.notes.push(l.note);
  }
  return [...map.values()].sort(
    (a, b) =>
      a.destRank - b.destRank ||
      compareStrings(a.dest, b.dest) ||
      compareGroupsForReport(a.group, b.group),
  );
}

type SheetResult = {
  sheet: SheetModel;
  /** 団体別集計の参照に使う：品目コード → { 値の列, 在庫の列 } */
  cols: Map<Code, { value: string; stock: string }>;
  stockTotal: number[];
  unusableTotal: number[];
};

function buildItemSheet(
  ctx: Context,
  codes: readonly Code[],
  yearLabel: string,
): SheetResult {
  const k = codes.length;
  const valueCols = codes.map((_, j) => colLetter(3 + j));
  const stockCols = codes.map((_, j) => colLetter(4 + k + j));
  const names = codes.map((c) => ctx.items.get(c)!.name);
  const sheetName = names[0]!;

  const header: Cell[] = ['運び元', '運び先', '使用用途', ...names, '備考'];
  header.push(`在庫(${yearLabel}数え)`);
  if (k === 2) header.push(`${names[1]}在庫(${yearLabel}数え)`);
  const rows: Cell[][] = [header];
  const stockTotal = codes.map(() => 0);
  const unusableTotal = codes.map(() => 0);

  const aggregated = aggregate(ctx.lines, codes);
  const bySource = new Map<string, Aggregated[]>();
  for (const a of aggregated) {
    const list = bySource.get(a.sourceRoomId) ?? [];
    list.push(a);
    bySource.set(a.sourceRoomId, list);
  }

  const width = 4 + 2 * k; // A,B,C + 値 k + 備考 + 在庫 k
  const blank = (): Cell[] => Array.from({ length: width }, () => null);

  for (const room of ctx.rooms) {
    const stock = codes.map((c) => ctx.stock.get(stockKey(room.id, c)) ?? 0);
    const entries = bySource.get(room.id) ?? [];
    if (stock.every((n) => n === 0) && entries.length === 0) continue;

    const body: { dest: string; use: string | null; counts: (number | null)[]; note: string }[] = [];
    if (!room.usable && stock.some((n) => n > 0)) {
      body.push({ dest: KEEP_LABEL, use: UNUSABLE_LABEL, counts: stock.map((n) => (n > 0 ? n : null)), note: '' });
      stock.forEach((n, j) => (unusableTotal[j]! += n));
    }
    for (const e of entries) {
      body.push({ dest: e.dest, use: e.group.name, counts: e.counts.map((n) => (n > 0 ? n : null)), note: e.notes.join('、') });
    }
    stock.forEach((n, j) => (stockTotal[j]! += n));

    const m = body.length;
    const a = rows.length + 1; // 最初の振り分け行（1始まり）
    const y = a + m; // 余り
    const t = y + 1; // 計
    body.forEach((b, i) => {
      const r = blank();
      if (i === 0) r[0] = room.name;
      r[1] = b.dest === '' ? null : b.dest;
      r[2] = b.use;
      b.counts.forEach((n, j) => (r[3 + j] = n));
      r[3 + k] = b.note === '' ? null : b.note;
      rows.push(r);
    });

    const sums = codes.map((_, j) => body.reduce((s, b) => s + (b.counts[j] ?? 0), 0));
    const surplus = stock.map((n, j) => n - sums[j]!);
    const totals = sums.map((s, j) => s + surplus[j]!);

    const surplusRow = blank();
    if (m === 0) surplusRow[0] = room.name;
    surplusRow[1] = SURPLUS_LABEL;
    codes.forEach((_, j) => {
      const v = valueCols[j]!;
      const f = m > 0 ? `${stockCols[j]}${t}-SUM(${v}${a}:${v}${y - 1})` : `${stockCols[j]}${t}`;
      surplusRow[3 + j] = { formula: f, result: surplus[j]! };
    });
    rows.push(surplusRow);

    const totalRow = blank();
    totalRow[2] = TOTAL_LABEL;
    codes.forEach((_, j) => {
      const v = valueCols[j]!;
      totalRow[3 + j] = { formula: `SUM(${v}${a}:${v}${y})`, result: totals[j]! };
      totalRow[4 + k + j] = stock[j]!;
    });
    const over = surplus.some((n) => n < 0);
    const same = totals.every((n, j) => n === stock[j]);
    const warn = over ? OVER_STOCK : same ? '' : NEEDS_CHECK;
    const formula =
      k === 1
        ? `IF(D${y}<0,"${OVER_STOCK}",IF(D${t}=F${t},"","${NEEDS_CHECK}"))`
        : `IF(OR(D${y}<0,E${y}<0),"${OVER_STOCK}",IF(AND(D${t}=G${t},E${t}=H${t}),"","${NEEDS_CHECK}"))`;
    totalRow[3 + k] = { formula, result: warn };
    rows.push(totalRow);
  }

  const widths = [16, 14, 22, ...Array.from({ length: k }, () => 12), 24, ...Array.from({ length: k }, () => 16)];
  const cols = new Map<Code, { value: string; stock: string }>();
  codes.forEach((c, j) => cols.set(c, { value: valueCols[j]!, stock: stockCols[j]! }));
  return { sheet: { name: sheetName, rows, widths }, cols, stockTotal, unusableTotal };
}

/** 振り分け表（R8 様式）の全シート：品目シート → 団体別集計 */
export function buildAllocationSheets(input: Pick<ReportInput, 'yearLabel' | 'data' | 'rows'>): SheetModel[] {
  const { data, yearLabel } = input;
  assertGroupNames(data.groups);
  const ctx = buildContext(data, input.rows);

  const sheets: SheetModel[] = [];
  const ref = new Map<Code, { sheet: string; value: string; stock: string; stockTotal: number; unusableTotal: number }>();
  for (const codes of SHEET_DEFS) {
    const r = buildItemSheet(ctx, codes, yearLabel);
    sheets.push(r.sheet);
    codes.forEach((c, j) => {
      const col = r.cols.get(c)!;
      ref.set(c, { sheet: r.sheet.name, value: col.value, stock: col.stock, stockTotal: r.stockTotal[j]!, unusableTotal: r.unusableTotal[j]! });
    });
  }

  // ---- 団体別集計 ----
  const names = SUMMARY_CODES.map((c) => ctx.items.get(c)!.name);
  const header: Cell[] = ['区分', '団体', ...names, '机計(木＋不可)'];
  const rows: Cell[][] = [header];
  const groups = data.groups.slice().sort(compareGroupsForReport);
  const used = SUMMARY_CODES.map(() => 0);
  const sumCount = (groupId: string, code: Code) =>
    ctx.lines.reduce((s, l) => (l.group.id === groupId && l.code === code ? s + l.count : s), 0);

  groups.forEach((g, i) => {
    const r = i + 2;
    const row: Cell[] = [CATEGORY_LABELS[g.category], g.name];
    SUMMARY_CODES.forEach((c, j) => {
      const d = ref.get(c)!;
      const q = quoteSheet(d.sheet);
      const n = sumCount(g.id, c);
      used[j]! += n;
      row.push({ formula: `SUMIF(${q}!$C:$C,$B${r},${q}!$${d.value}:$${d.value})`, result: n });
    });
    const desk = sumCount(g.id, 'desk') + sumCount(g.id, 'desk_ng');
    row.push({ formula: `C${r}+D${r}`, result: desk });
    rows.push(row);
  });

  const firstRow = 2;
  const lastRow = groups.length + 1;
  const usedRow = lastRow + 1;
  const stockRow = lastRow + 2;
  const unusableRow = lastRow + 3;
  const surplusRow = lastRow + 4;
  const usedCells: Cell[] = [null, '使用数 計'];
  const stockCells: Cell[] = [null, '在庫'];
  const unusableCells: Cell[] = [null, '使用不可（残す）'];
  const surplusCells: Cell[] = [null, SURPLUS_LABEL];
  SUMMARY_CODES.forEach((c, j) => {
    const d = ref.get(c)!;
    const q = quoteSheet(d.sheet);
    const col = colLetter(2 + j);
    usedCells.push({ formula: `SUM(${col}${firstRow}:${col}${lastRow})`, result: used[j]! });
    stockCells.push({ formula: `SUMIF(${q}!$C:$C,"${TOTAL_LABEL}",${q}!$${d.stock}:$${d.stock})`, result: d.stockTotal });
    unusableCells.push({ formula: `SUMIF(${q}!$C:$C,"${UNUSABLE_LABEL}",${q}!$${d.value}:$${d.value})`, result: d.unusableTotal });
    surplusCells.push({
      formula: `${col}${stockRow}-${col}${usedRow}-${col}${unusableRow}`,
      result: d.stockTotal - used[j]! - d.unusableTotal,
    });
  });
  const deskIdx = (code: Code) => SUMMARY_CODES.indexOf(code);
  const deskSum = (cells: Cell[], rowNo: number, pick: (j: number) => number) => {
    cells.push({ formula: `C${rowNo}+D${rowNo}`, result: pick(deskIdx('desk')) + pick(deskIdx('desk_ng')) });
  };
  deskSum(usedCells, usedRow, (j) => used[j]!);
  deskSum(stockCells, stockRow, (j) => ref.get(SUMMARY_CODES[j]!)!.stockTotal);
  deskSum(unusableCells, unusableRow, (j) => ref.get(SUMMARY_CODES[j]!)!.unusableTotal);
  deskSum(surplusCells, surplusRow, (j) => {
    const d = ref.get(SUMMARY_CODES[j]!)!;
    return d.stockTotal - used[j]! - d.unusableTotal;
  });
  rows.push(usedCells, stockCells, unusableCells, surplusCells);

  sheets.push({
    name: SUMMARY_SHEET_NAME,
    rows,
    widths: [10, 24, ...SUMMARY_CODES.map(() => 12), 16],
  });
  return sheets;
}

const CONSENT_LABELS = { not_asked: '未依頼', asked: '依頼済み（返事待ち）', accepted: '了承', declined: '了承なし（辞退）' } as const;

/** キャスター机交換依頼一覧：了承が要る代替（needsConsent）の行だけを団体ごとにまとめる */
export function buildSwapsSheet(input: Pick<ReportInput, 'data' | 'rows'>): SheetModel {
  const { data } = input;
  assertGroupNames(data.groups);
  const ctx = buildContext(data, input.rows);
  const roomName = (id: string | null) => (id === null ? '' : (ctx.roomById.get(id)?.name ?? ''));

  const header: Cell[] = ['団体', '企画名', '場所', '台数', '了承状況', '交換'];
  const rows: Cell[][] = [header];
  const out: { group: Group; n: number; status: string; label: string; pairIdx: number }[] = [];
  const pairs = [...ctx.consentPairs.entries()];
  pairs.forEach(([key, pair], pairIdx) => {
    const [fromId, toId] = key.split('|') as [string, string];
    const perGroup = new Map<string, number>();
    for (const r of input.rows) {
      if (r.requestedItemId === fromId && r.itemId === toId) perGroup.set(r.groupId, (perGroup.get(r.groupId) ?? 0) + r.count);
    }
    for (const [groupId, n] of perGroup) {
      const group = ctx.groupById.get(groupId);
      if (!group) throw new Error(`団体 ${groupId} が団体の一覧にありません`);
      const consent = data.consents.find((c) => c.groupId === groupId && c.fromItemId === fromId && c.toItemId === toId);
      let status: string = CONSENT_LABELS[consent?.status ?? 'not_asked'];
      if (consent?.status === 'accepted' && consent.count !== null && n > consent.count) {
        status = `了承（${consent.count}台。今は${n}台。依頼し直し）`;
      }
      out.push({ group, n, status, label: `${pair.from.name}→${pair.to.name}`, pairIdx });
    }
  });
  out.sort((a, b) => a.pairIdx - b.pairIdx || compareGroupsForReport(a.group, b.group));
  for (const o of out) {
    rows.push([o.group.name, o.group.displayName, roomName(o.group.locationRoomId), o.n, o.status, o.label]);
  }
  if (out.length > 0) {
    const total = out.reduce((s, o) => s + o.n, 0);
    rows.push(['合計', null, null, { formula: `SUM(D2:D${rows.length})`, result: total }, null, null]);
  }
  return { name: SWAPS_SHEET_NAME, rows, widths: [24, 24, 14, 8, 30, 24] };
}
