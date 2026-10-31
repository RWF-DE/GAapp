// SheetModel を xlsx にする。ExcelJS は数式を計算しないので、計算済みの値も書き、fullCalcOnLoad を設定する。
// ブラウザでも Node でも動く（Node の API は使わない）。色は付けない。
import ExcelJS from 'exceljs';
import type { SheetModel } from './report';

export async function writeWorkbook(sheets: readonly SheetModel[], generatedAt: Date = new Date()): Promise<Uint8Array> {
  const wb = new ExcelJS.Workbook();
  wb.creator = '電波祭 総務アプリ';
  wb.created = generatedAt;
  wb.modified = generatedAt;
  wb.calcProperties.fullCalcOnLoad = true;
  for (const sheet of sheets) {
    const ws = wb.addWorksheet(sheet.name, { views: [{ state: 'frozen', ySplit: 1 }] });
    sheet.widths.forEach((w, i) => (ws.getColumn(i + 1).width = w));
    sheet.rows.forEach((row, r) => {
      row.forEach((cell, c) => {
        if (cell === null) return;
        const target = ws.getCell(r + 1, c + 1);
        if (typeof cell === 'object') target.value = { formula: cell.formula, result: cell.result };
        else target.value = cell;
      });
    });
    ws.getRow(1).font = { bold: true };
  }
  const buf = await wb.xlsx.writeBuffer();
  return new Uint8Array(buf as ArrayBuffer);
}
