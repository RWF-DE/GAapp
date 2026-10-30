// キャスター机交換 /swaps の書き込みと書き出し（画面の設計 3.10。T13）。
import { downloadFile, MIME } from '@/lib/download';
import { assertExportableGroupNames, toReportInput } from '@/lib/data/export';
import type { Snapshot } from '@/lib/data/snapshot';
import type { ConsentDbRow } from '@/lib/db/types';
import { callRpc } from '@/lib/rpc';
import type { SwapOp } from './swap-ops';

/**
 * 了承の状況を記録する（set_consent。管理者）。note は undefined なら送らない（DB は今の備考を残す）、空文字なら消す。
 * asked はその時点の置き換え台数を依頼した台数にし、accepted は置き換えの行を固定、declined は固定を外す。
 */
export async function setSwapConsent(args: {
  groupId: string;
  fromItemId: string;
  toItemId: string;
  status: SwapOp;
  note?: string;
}): Promise<ConsentDbRow> {
  const res = await callRpc('set_consent', {
    p_group_id: args.groupId,
    p_from_item: args.fromItemId,
    p_to_item: args.toItemId,
    p_status: args.status,
    ...(args.note !== undefined ? { p_note: args.note } : {}),
  });
  return res as unknown as ConsentDbRow;
}

/** 交換依頼一覧（Excel）。exporter（ExcelJS）は出すときに動的 import する */
export async function downloadSwapsXlsx(snapshot: Snapshot, opts: { generatedAt?: Date } = {}): Promise<{ fileName: string }> {
  assertExportableGroupNames(snapshot);
  const input = toReportInput(snapshot, opts.generatedAt);
  const ex = await import('@gaapp/exporter');
  const bytes = await ex.exportSwapsXlsx(input);
  const fileName = ex.swapsXlsxFileName(snapshot.year.label);
  downloadFile(bytes, fileName, MIME.xlsx);
  return { fileName };
}
