// 合成データ（r8like）の reference/allocations.csv から出力した xlsx を LibreOffice で再計算して確かめる（完了基準）。
// soffice と python3-uno がなければ飛ばす。REQUIRE_LIBREOFFICE=1 のときは、なければ失敗にする（CI）。
import { describe, expect, it } from 'vitest';
import { ITEM_CODES } from '@gaapp/shared';
import { buildAllocationSheets, exportAllocationXlsx } from './index';
import { countText, findErrors, libreOfficeAvailable, recalcWithLibreOffice } from './testing/recalc';
import { loadReferenceCase } from './testing/reference';
import { scenario } from './testing/scenario';

const available = libreOfficeAvailable();
if (process.env.REQUIRE_LIBREOFFICE === '1' && !available) throw new Error('REQUIRE_LIBREOFFICE=1 ですが LibreOffice (soffice + python3-uno) が使えません');

describe.skipIf(!available || process.env.SKIP_LIBREOFFICE === '1')('LibreOffice で再計算した振り分け表', () => {
  const c = loadReferenceCase('synthetic', 'r8like');
  const generatedAt = new Date('2026-10-29T00:00:00Z');

  it('数式エラー・在庫超過・要確認が0件、再計算の値が書いた値と一致、団体別集計が reference と一致する', async () => {
    const xlsx = await exportAllocationXlsx({ yearLabel: 'R8', data: c.data, rows: c.rows, generatedAt });
    const r = recalcWithLibreOffice(xlsx);
    expect(Object.keys(r)).toEqual(['机(木)', '椅子(木)', 'キャスター机', '椅子(青)', '長机(3人掛)', '長机(2人掛)', '教卓', '団体別集計']);
    expect(findErrors(r)).toEqual([]);
    // 書いた計算済みの値が、LibreOffice の再計算の値と全部一致する
    for (const sheet of buildAllocationSheets({ yearLabel: 'R8', data: c.data, rows: c.rows })) {
      sheet.rows.forEach((row, i) =>
        row.forEach((cell, j) => {
          if (cell !== null && typeof cell === 'object') {
            expect(r[sheet.name]![i]![j]?.v ?? '', `${sheet.name} R${i + 1}C${j + 1}`).toBe(cell.result);
          }
        }),
      );
    }
    expect(countText(r, '在庫超過')).toBe(0);
    expect(countText(r, '要確認')).toBe(0);

    // 団体別集計を reference/group_totals.csv と比べる
    const sum = r['団体別集計']!;
    const colOf = (code: string) => 2 + ITEM_CODES.indexOf(code as (typeof ITEM_CODES)[number]);
    const byName = new Map(sum.slice(1).map((row) => [row[1]?.v, row]));
    expect(c.reference.groupTotals.length).toBe(c.data.groups.length);
    for (const t of c.reference.groupTotals) {
      const row = byName.get(t.group);
      expect(row, t.group).toBeDefined();
      for (const code of ITEM_CODES) {
        expect(row![colOf(code)]?.v, `${t.group} ${code}`).toBe(t.counts[code]);
      }
    }
    // 末尾の4行：使用数 計・在庫・使用不可・余り
    const tail = sum.slice(-4).map((row) => row[1]?.v);
    expect(tail).toEqual(['使用数 計', '在庫', '使用不可（残す）', '余り']);
    const stockRow = sum.at(-3)!;
    const usedRow = sum.at(-4)!;
    const unusableRow = sum.at(-2)!;
    const surplusRow = sum.at(-1)!;
    for (const code of ITEM_CODES) {
      const j = colOf(code);
      const stock = c.fx.stocks.reduce((s, x) => s + x.counts[code], 0);
      const unusable = c.fx.stocks.reduce((s, x) => (c.fx.rooms.find((rm) => rm.name === x.room)!.usable ? s : s + x.counts[code]), 0);
      expect(stockRow[j]?.v, code).toBe(stock);
      expect(unusableRow[j]?.v, code).toBe(unusable);
      expect(surplusRow[j]?.v, code).toBe(stock - (usedRow[j]?.v as number) - unusable);
    }
  }, 120_000);

  it('LibreOffice の再計算が実際に効いている（書いた値を壊しても正しい値に直る）', async () => {
    const ExcelJS = (await import('exceljs')).default;
    const xlsx = await exportAllocationXlsx({ yearLabel: 'R8', data: c.data, rows: c.rows, generatedAt });
    const wb = new ExcelJS.Workbook();
    await wb.xlsx.load(xlsx as unknown as ArrayBuffer);
    const ws = wb.getWorksheet('団体別集計')!;
    // 値が0でない最初のセルの書いた値を壊す
    const cell = ws.getCell('E3'); // 2団体目のキャスター机以外のどれか。0 なら下のチェックで気づく
    const f = cell.value as { formula: string; result: number };
    expect(f.result).toBeGreaterThan(0);
    cell.value = { formula: f.formula, result: 99999 };
    const broken = new Uint8Array((await wb.xlsx.writeBuffer()) as ArrayBuffer);
    const r = recalcWithLibreOffice(broken);
    expect(r['団体別集計']![2]![4]?.v).toBe(f.result);
  }, 120_000);

  it('小さな入力（使用不可の部屋・2列でまとまる行・自動の備考）でもエラー0件。在庫超過は検出できる', async () => {
    const { data, rows } = scenario();
    const r = recalcWithLibreOffice(await exportAllocationXlsx({ yearLabel: 'R8', data, rows }));
    expect(findErrors(r)).toEqual([]);
    // 椅子(木)の C教室だけ在庫が足りない（-1）。LibreOffice の式が「在庫超過」を出す
    expect(countText(r, '在庫超過')).toBe(1);
    expect(countText(r, '要確認')).toBe(0);
    expect(r['机(木)']![4]![5]?.v).toBe('');
  }, 120_000);
});
