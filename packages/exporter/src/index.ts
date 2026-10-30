export const PACKAGE_NAME = '@gaapp/exporter';

import { buildAllocationSheets, buildSwapsSheet } from './report';
import type { ReportInput } from './types';
import { writeWorkbook } from './xlsx';

export type {
  ExportConsent,
  ExportGroup,
  ExportItem,
  ExportRoom,
  ExportRow,
  ExportRule,
  ExportSubmission,
  ReportInput,
  YearExport,
  YearExportRow,
} from './types';
export type { Cell, FormulaCell, SheetModel } from './report';
export {
  allocationXlsxFileName,
  swapsXlsxFileName,
  yearJsonFileName,
  buildAllocationSheets,
  buildSwapsSheet,
  CATEGORY_LABELS,
  KEEP_LABEL,
  UNUSABLE_LABEL,
  SURPLUS_LABEL,
  TOTAL_LABEL,
  OVER_STOCK,
  NEEDS_CHECK,
  SUMMARY_SHEET_NAME,
  SWAPS_SHEET_NAME,
  ExportInputError,
} from './report';
export { exportYearJson } from './json';

/** R8 様式の振り分け表（ファイル名は allocationXlsxFileName）。団体名が SUMIF に、品目名がシート名に使えないときは ExportInputError */
export async function exportAllocationXlsx(input: ReportInput): Promise<Uint8Array> {
  return writeWorkbook(buildAllocationSheets(input), input.generatedAt);
}

/** キャスター机交換依頼一覧（ファイル名は swapsXlsxFileName） */
export async function exportSwapsXlsx(input: ReportInput): Promise<Uint8Array> {
  return writeWorkbook([buildSwapsSheet(input)], input.generatedAt);
}
