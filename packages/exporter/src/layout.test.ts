// 様式のテスト（builder で作る小さな行。allocator は使わない）
import ExcelJS from 'exceljs';
import JSZip from 'jszip';
import { describe, expect, it } from 'vitest';
import { FixtureBuilder, toFixedRow } from '@gaapp/shared/testing';
import { scenario } from './testing/scenario';
import {
  allocationXlsxFileName,
  buildAllocationSheets,
  buildSwapsSheet,
  exportAllocationXlsx,
  exportSwapsXlsx,
  exportYearJson,
  type ExportRow,
  type SheetModel,
} from './index';

const sheet = (sheets: SheetModel[], name: string) => sheets.find((s) => s.name === name)!;
const val = (c: unknown) => (c !== null && typeof c === 'object' ? (c as { result: unknown }).result : c);
const text = (s: SheetModel) => s.rows.map((r) => r.map(val));

describe('品目シート', () => {
  const { data, rows } = scenario();
  const sheets = buildAllocationSheets({ yearLabel: 'R8', data, rows });

  it('シートの順', () => {
    expect(sheets.map((s) => s.name)).toEqual(['机(木)', '椅子(木)', 'キャスター机', '椅子(青)', '長机(3人掛)', '長机(2人掛)', '教卓', '団体別集計']);
    expect(allocationXlsxFileName('R8')).toBe('R8_椅子机振り分け_部門員共有用.xlsx');
  });

  it('机(木)：同じ（運び元・運び先・団体）の普通の行と不可の行が1行にまとまる。使用不可の部屋は「残す／使用不可」の1行', () => {
    const t = text(sheet(sheets, '机(木)'));
    expect(t[0]).toEqual(['運び元', '運び先', '使用用途', '机(木)', '不可机', '備考', '在庫(R8数え)', '不可机在庫(R8数え)']);
    // A教室：まとまった1行(3,2)＋焼きそば(2)＋余り＋計
    expect(t[1]).toEqual(['A教室', '外1', 'たこ焼き', 3, 2, null, null, null]);
    expect(t[2]).toEqual([null, '外2', '焼きそば', 2, null, null, null, null]);
    expect(t[3]).toEqual([null, '余り', null, 5, 2, null, null, null]);
    expect(t[4]).toEqual([null, null, '(計)', 10, 4, '', 10, 4]);
    // B教室：使用不可
    expect(t[5]).toEqual(['B教室', '残す', '使用不可', 7, 1, null, null, null]);
    expect(t[6]).toEqual([null, '余り', null, 0, 0, null, null, null]);
    expect(t[7]).toEqual([null, null, '(計)', 7, 1, '', 7, 1]);
    // C教室：残す行。不可机の在庫が無い部屋は E が空
    expect(t[8]).toEqual(['C教室', '残す', '室内店', 3, null, null, null, null]);
    expect(t[10]).toEqual([null, null, '(計)', 3, 0, '', 3, 0]);
    expect(t).toHaveLength(11);
  });

  it('数式：余り・計・警告', () => {
    const s = sheet(sheets, '机(木)');
    const f = (r: number, c: number) => (s.rows[r - 1]![c] as { formula: string }).formula;
    expect(f(4, 3)).toBe('G5-SUM(D2:D3)');
    expect(f(4, 4)).toBe('H5-SUM(E2:E3)');
    expect(f(5, 3)).toBe('SUM(D2:D4)');
    expect(f(5, 5)).toBe('IF(OR(D4<0,E4<0),"在庫超過",IF(AND(D5=G5,E5=H5),"","要確認"))');
  });

  it('1列のシート：備考の自動の文言（了承が要る代替）と余り・警告の数式', () => {
    const s = sheet(sheets, 'キャスター机');
    const t = text(s);
    expect(t[1]).toEqual(['C教室', '残す', '室内店', 3, 'キャスター机に交換', null]);
    expect(t[2]).toEqual([null, '余り', null, 1, null, null]);
    expect(t[3]).toEqual([null, null, '(計)', 4, '', 4]);
    expect((s.rows[2]![3] as { formula: string }).formula).toBe('F4-SUM(D2:D2)');
    expect((s.rows[3]![4] as { formula: string }).formula).toBe('IF(D3<0,"在庫超過",IF(D4=F4,"","要確認"))');
  });

  it('在庫が無くても振り分けのある場所は出す。手で書いた備考が優先。使用不可は不可椅子が無ければ空', () => {
    const t = text(sheet(sheets, '椅子(木)'));
    expect(t[3]).toEqual(['B教室', '残す', '使用不可', 2, null, null, null, null]);
    expect(t[6]).toEqual(['C教室', '外1', 'たこ焼き', 1, null, '手で書いた備考', null, null]);
    expect(t[7]).toEqual([null, '余り', null, -1, 0, null, null, null]);
    expect(t[8]).toEqual([null, null, '(計)', 0, 0, '在庫超過', 0, 0]);
  });

  it('振り分けの無い場所は余り行の A 列に場所名', () => {
    const t = text(sheet(sheets, '椅子(木)'));
    expect(t[1]).toEqual(['A教室', '余り', null, 5, 0, null, null, null]);
    expect(t[2]).toEqual([null, null, '(計)', 5, 0, '', 5, 0]);
  });

  it('在庫も振り分けも無い場所は出さない', () => {
    const t = text(sheet(sheets, '教卓'));
    expect(t).toHaveLength(1);
  });

  it('2行の備考は「、」でつなぐ（同じ文言は1回）', () => {
    const { b, ix, data } = scenario();
    const r = (item: string, note: string | null): ExportRow => ({
      sourceRoomId: ix.roomId('A教室'), groupId: ix.groupId('たこ焼き'), itemId: ix.itemId(item),
      requestedItemId: ix.itemId('desk'), count: 1, isKeep: false, note,
    });
    void b;
    const s = buildAllocationSheets({ yearLabel: 'R8', data, rows: [r('desk', '甲'), r('desk_ng', '乙'), r('desk', '甲')] });
    expect(text(sheet(s, '机(木)'))[1]).toEqual(['A教室', '外1', 'たこ焼き', 2, 1, '甲、乙', null, null]);
  });
});

describe('団体別集計', () => {
  const { data, rows } = scenario();
  const s = sheet(buildAllocationSheets({ yearLabel: 'R8', data, rows }), '団体別集計');
  it('見出し・並び・数式・末尾の4行', () => {
    const t = text(s);
    expect(t[0]).toEqual(['区分', '団体', '机(木)', '不可机', '椅子(木)', '不可椅子', 'キャスター机', '椅子(青)', '長机(3人掛)', '長机(2人掛)', '教卓', '机計(木＋不可)']);
    expect(t[1]).toEqual(['模擬店', 'たこ焼き', 3, 2, 1, 0, 0, 0, 0, 0, 0, 5]);
    expect(t[3]).toEqual(['模擬店', '室内店', 3, 0, 0, 0, 3, 0, 0, 0, 0, 3]);
    expect((s.rows[1]![2] as { formula: string }).formula).toBe("SUMIF('机(木)'!$C:$C,$B2,'机(木)'!$D:$D)");
    expect((s.rows[1]![3] as { formula: string }).formula).toBe("SUMIF('机(木)'!$C:$C,$B2,'机(木)'!$E:$E)");
    expect(t.slice(4).map((r) => r[1])).toEqual(['使用数 計', '在庫', '使用不可（残す）', '余り']);
    expect(t[4]!.slice(2)).toEqual([8, 2, 1, 0, 3, 0, 0, 0, 0, 10]);
    expect(t[5]!.slice(2)).toEqual([20, 5, 7, 0, 4, 0, 0, 0, 0, 25]);
    expect(t[6]!.slice(2)).toEqual([7, 1, 2, 0, 0, 0, 0, 0, 0, 8]);
    expect(t[7]!.slice(2)).toEqual([5, 2, 4, 0, 1, 0, 0, 0, 0, 7]);
    expect((s.rows[5]![2] as { formula: string }).formula).toBe("SUMIF('机(木)'!$C:$C,\"(計)\",'机(木)'!$G:$G)");
    expect((s.rows[6]![2] as { formula: string }).formula).toBe("SUMIF('机(木)'!$C:$C,\"使用不可\",'机(木)'!$D:$D)");
    expect((s.rows[7]![2] as { formula: string }).formula).toBe('C6-C5-C7');
  });
  it('団体の並び：区分 → 提出日時（未提出は最後）→ sort_order', () => {
    const b = new FixtureBuilder('R8').room('X', { sortOrder: 1 })
      .group('甲', 'department', 'X', { sortOrder: 1, submittedAt: null })
      .group('乙', 'department', 'X', { sortOrder: 2, submittedAt: '2026-07-01T12:00:00+09:00' })
      .group('丙', 'stall', 'X', { sortOrder: 3 })
      .group('丁', 'rest_area', 'X', { sortOrder: 0 })
      .group('戊', 'company', 'X', { sortOrder: 9 });
    const r = sheet(buildAllocationSheets({ yearLabel: 'R8', data: b.yearData(), rows: [] }), '団体別集計');
    expect(r.rows.slice(1, 6).map((x) => x[1])).toEqual(['丙', '乙', '甲', '戊', '丁']);
  });
});

describe('団体名の確認と出力', () => {
  it('SUMIF に使えない団体名があれば、ファイルを作らず例外（団体名を含む）', async () => {
    const b = new FixtureBuilder('R8').room('X').group('A*B', 'stall', 'X').group('se企画', 'stall', 'X').group('SE企画', 'stall', 'X');
    await expect(exportAllocationXlsx({ yearLabel: 'R8', data: b.yearData(), rows: [] })).rejects.toThrow(/A\*B/);
    await expect(exportAllocationXlsx({ yearLabel: 'R8', data: b.yearData(), rows: [] })).rejects.toThrow(/SE企画/);
  });

  it('xlsx に fullCalcOnLoad・数式・計算済みの値が入る', async () => {
    const { data, rows } = scenario();
    const bytes = await exportAllocationXlsx({ yearLabel: 'R8', data, rows, generatedAt: new Date('2026-10-29T00:00:00Z') });
    const zip = await JSZip.loadAsync(bytes);
    expect(await zip.file('xl/workbook.xml')!.async('string')).toMatch(/<calcPr[^>]*fullCalcOnLoad="1"/);
    const wb = new ExcelJS.Workbook();
    await wb.xlsx.load(bytes as unknown as ArrayBuffer);
    expect(wb.worksheets.map((w) => w.name)).toHaveLength(8);
    const c = wb.getWorksheet('机(木)')!.getCell('D4').value as { formula: string; result: number };
    expect(c.formula).toBe('G5-SUM(D2:D3)');
    expect(c.result).toBe(5);
  });

  it('同じ入力なら同じバイト列', async () => {
    const { data, rows } = scenario();
    const g = new Date('2026-10-29T00:00:00Z');
    const a = await exportAllocationXlsx({ yearLabel: 'R8', data, rows, generatedAt: g });
    const b = await exportAllocationXlsx({ yearLabel: 'R8', data, rows: [...rows], generatedAt: g });
    expect(Buffer.from(a).equals(Buffer.from(b))).toBe(true);
  });
});

describe('キャスター机交換依頼一覧', () => {
  it('了承が要る代替の行だけを団体ごとにまとめる（不可机は入れない）', async () => {
    const { data, rows } = scenario();
    const s = buildSwapsSheet({ data, rows });
    expect(text(s)).toEqual([
      ['団体', '企画名', '場所', '台数', '了承状況', '交換'],
      ['室内店', 'ミニ縁日', 'C教室', 3, '了承（2台。今は3台。依頼し直し）', '机(木)→キャスター机'],
      ['合計', null, null, 3, null, null],
    ]);
    const bytes = await exportSwapsXlsx({ yearLabel: 'R8', data, rows });
    expect(bytes.length).toBeGreaterThan(1000);
  });
});

describe('年度データ（JSON）', () => {
  it('メールアドレスを含めない（余計な項目は落とし、自由記述に混じったものは伏せる）', () => {
    const { data, rows } = scenario();
    const dirty = structuredClone(data) as unknown as { groups: Record<string, unknown>[] };
    dirty.groups[0]!.contactEmail = 'someone@example.test';
    const stored = [{ ...toFixedRow(rows[0]!, 1), note: '連絡は taro@example.test まで' }, ...rows.slice(1)];
    const json = exportYearJson({ yearLabel: 'R8', data: dirty as unknown as typeof data, rows: stored });
    expect(json).not.toMatch(/@/);
    expect(json).not.toContain('contactEmail');
    const doc = JSON.parse(json);
    expect(doc.schemaVersion).toBe(1);
    expect(doc.allocations).toHaveLength(rows.length);
    expect(doc.allocations[0]).toMatchObject({ origin: 'auto', pinned: true });
    expect(Object.keys(doc)).toEqual([
      'schemaVersion', 'yearLabel', 'items', 'rooms', 'groups', 'stocks', 'requests', 'rules', 'consents', 'distanceOverrides', 'allocations',
    ]);
  });
});
