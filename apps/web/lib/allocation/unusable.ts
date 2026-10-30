// 部屋を「今年は使用不可にする」前の一覧と、押せるかの判定（画面の設計 3.9 の「使用不可にする順番」。T13 の段 2）。純粋関数。
// save_allocation_rows は使用不可の部屋の行の update を、固定だけの変更でも E002 で拒否し、手動の行は固定を外しても
// fixedRows に残る（再実行で動かない）。そこで、使用不可にする前に、その部屋からの固定・手動の行（全品目）を一覧にして
// 直して保存してもらい、一覧が空で未保存の変更がないときだけ使用不可にする。
// 行の選び方と操作は T09a の fixedRowsFrom・opsBeforeUnusable（lib/data/room-years.ts）を使う。
import type { StoredAllocationRow } from '@gaapp/shared';
import { fixedRowsFrom, opsBeforeUnusable, type FixedRowOp } from '@/lib/data/room-years';

export interface UnusableCheckItem {
  row: StoredAllocationRow;
  /** 固定の自動の行は 固定を外す・運び元を変える・削除。手動の行は 運び元を変える・削除（固定を外しても動かないため） */
  ops: FixedRowOp[];
}

export const FIXED_ROW_OP_LABELS: Record<FixedRowOp, string> = {
  unpin: '固定を外す',
  change_source: '運び元を変える',
  delete: '削除',
};

/**
 * その部屋からの固定・手動の行の一覧（未保存の変更を当てた行で作る。直した行は一覧から消える）。
 * 並びは渡した行の順のまま（呼ぶ側が品目・団体の順に並べる）。
 */
export function unusableChecklist(rows: readonly StoredAllocationRow[], roomId: string): UnusableCheckItem[] {
  return fixedRowsFrom(rows, roomId).map((row) => ({ row, ops: opsBeforeUnusable(row) }));
}

export const BLOCK_FIX_ROWS = '先に一覧の行を直して保存してください';
export const BLOCK_PENDING = '保存していない変更があります。先に保存するか取り消してください（使用不可にすると振り分けを読み直すため）';

/**
 * 「使用不可にする」を押せないときの理由（押せるなら null）。一覧が空で、未保存の変更がないときだけ押せる。
 */
export function unusableBlocker(args: { checklist: readonly UnusableCheckItem[]; pendingCount: number }): string | null {
  if (args.checklist.length > 0) return BLOCK_FIX_ROWS;
  if (args.pendingCount > 0) return BLOCK_PENDING;
  return null;
}
