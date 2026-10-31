// 振り分け表（Excel）の書き出し（画面の設計 3.9・6、D-39 の Q3。T09a）。机椅子の状況（/furniture。T09・T16）と振り分け画面（T13）が使う。
// @gaapp/exporter（ExcelJS 約 0.9 MB）は出力するときに動的 import する（最初の読み込みを重くしない。静的 import は ESLint で止める）。
import { checkGroupNames } from '@gaapp/shared';
import type { ReportInput } from '@gaapp/exporter';
import { downloadFile, MIME } from '@/lib/download';
import type { YearStatus } from '@/lib/db/types';
import type { Snapshot } from './snapshot';
import { isAllocationFinal } from './year';
import { toStoredRows, toYearData } from './year-data';

/** 出力の前に止めるとき（団体名が Excel の集計に、品目名がシート名に使えない）。message は画面にそのまま出せる日本語 */
export class ExportBlockedError extends Error {
  override name = 'ExportBlockedError';
}

/** 確定前（振り分け中など）か。確定前に出すときは、出す前に「確定前の振り分けです」と確かめる（Q3） */
export function isBeforeConfirm(status: YearStatus): boolean {
  return !isAllocationFinal(status);
}

/**
 * ファイル名（Q3）。確定・終了は exporter の allocationXlsxFileName と同じ `{年度}_椅子机振り分け_部門員共有用.xlsx`、
 * 確定前は `{年度}_椅子机振り分け_部門員共有用_確定前.xlsx`（共有用と取り違えないため）。
 * exporter を静的に読まないよう、ここで同じ形を作る（export.test.ts で exporter の関数と同じことを確かめる）。
 */
export function allocationExportFileName(yearLabel: string, status: YearStatus): string {
  const base = `${yearLabel}_椅子机振り分け_部門員共有用`;
  return isBeforeConfirm(status) ? `${base}_確定前.xlsx` : `${base}.xlsx`;
}

/** スナップショットから exporter の入力を作る（全行。手で書いた備考つき） */
export function toReportInput(snapshot: Snapshot, generatedAt?: Date): ReportInput {
  const { data } = toYearData(snapshot);
  const { rows } = toStoredRows(snapshot);
  return {
    yearLabel: snapshot.year.label,
    data,
    rows: rows.map((r) => ({
      sourceRoomId: r.sourceRoomId,
      groupId: r.groupId,
      itemId: r.itemId,
      requestedItemId: r.requestedItemId,
      count: r.count,
      isKeep: r.isKeep,
      note: r.note,
    })),
    ...(generatedAt ? { generatedAt } : {}),
  };
}

/** SUMIF に使えない団体名があれば、名前を添えて止める（exporter も同じ確かめで例外を投げるが、先に日本語で止める） */
export function assertExportableGroupNames(snapshot: Pick<Snapshot, 'groups'>): void {
  const errors = checkGroupNames(snapshot.groups);
  if (errors.length === 0) return;
  const names = [
    ...new Set(errors.map((e) => snapshot.groups[Number(/^groups\.(\d+)\./.exec(e.path)?.[1])]?.name).filter((n): n is string => !!n)),
  ];
  throw new ExportBlockedError(
    `団体名${names.map((n) => `「${n}」`).join('')}は Excel の集計に使えません。マスタ設定で名前を変えてから出力してください`,
  );
}

/**
 * 振り分け表を作って保存させる。part = full のスナップショット（在庫が要る）を渡す。
 * 確定前に出すときの確認（「確定前の振り分けです」）は呼ぶ側（画面）が先に行う（isBeforeConfirm）。
 * 未保存の変更があるときは出さない（画面がボタンを押せなくする）。
 *
 * @example
 * if (isBeforeConfirm(snapshot.year.status) && !(await confirm('確定前の振り分けです…'))) return;
 * const { fileName } = await downloadAllocationXlsx(snapshot);
 */
export async function downloadAllocationXlsx(snapshot: Snapshot, opts: { generatedAt?: Date } = {}): Promise<{ fileName: string }> {
  if (snapshot.part !== 'full') throw new ExportBlockedError('振り分け表を出力するには、在庫と申請を読める立場が要ります');
  assertExportableGroupNames(snapshot);
  const input = toReportInput(snapshot, opts.generatedAt);
  const ex = await import('@gaapp/exporter');
  let bytes: Uint8Array;
  try {
    bytes = await ex.exportAllocationXlsx(input);
  } catch (e) {
    // 品目名がシート名に使えないときなど、入力のせいで止めたときの日本語の文は、そのまま画面に出す（ふつうの失敗の文に置き換えない）
    if (e instanceof ex.ExportInputError) throw new ExportBlockedError(e.message, { cause: e });
    throw e;
  }
  const fileName = allocationExportFileName(snapshot.year.label, snapshot.year.status);
  downloadFile(bytes, fileName, MIME.xlsx);
  return { fileName };
}
