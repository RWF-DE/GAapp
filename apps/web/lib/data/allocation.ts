// 振り分け画面の読み書き（画面の設計 3.9。T13）。
import type { AllocateMode, AllocationRow } from '@gaapp/shared';
import { callRpc } from '@/lib/rpc';
import type { AllocationChange, SaveAllocationRowsResult, SaveAutoAllocationsResult } from '@/lib/rpc/payloads';
import type { AllocationDbRow } from '@/lib/db/types';

/**
 * 自動振り分けの結果を保存する（save_auto_allocations）。p_base_version は入力を組み立てたスナップショットの版。
 * 計算の間にほかの人が振り分け・了承・在庫・申請・ルールなどを変えていれば conflict（自動でやり直さない）。
 */
export function saveAutoAllocations(args: {
  yearId: string;
  rows: readonly AllocationRow[];
  mode: AllocateMode;
  baseVersion: number;
}): Promise<SaveAutoAllocationsResult> {
  return callRpc('save_auto_allocations', {
    p_year_id: args.yearId,
    p_rows: args.rows.map((r) => ({ ...r })),
    p_mode: args.mode,
    p_base_version: args.baseVersion,
  });
}

/**
 * 行の手での変更を保存する（save_allocation_rows。理由は必須、1〜1000 件、update・delete は updatedAt の楽観ロック）。
 * 全部か何も保存しないか。通れば必ず版が上がる（応答が届かなかったときは版で確かめる。lib/allocation/row-save.ts）。
 */
export function saveAllocationRows(args: { yearId: string; changes: AllocationChange[]; reason: string }): Promise<SaveAllocationRowsResult> {
  return callRpc('save_allocation_rows', { p_year_id: args.yearId, p_changes: args.changes, p_reason: args.reason });
}

const rowKey = (r: Pick<AllocationRow, 'sourceRoomId' | 'groupId' | 'itemId' | 'requestedItemId' | 'isKeep'>) =>
  [r.sourceRoomId, r.groupId, r.itemId, r.requestedItemId, r.isKeep ? 'k' : '-'].join('|');

/**
 * 保存されたか分からないとき（応答が届かなかった）の突き合わせ：読み直した DB の自動の行（origin = auto かつ未固定）が、
 * 送った行と同じ（運び元・団体・品目・申請品目・残すごとの数の合計が一致）なら保存されていた。
 * save_auto_allocations は全部か何もないかなので、一致すれば保存されていた、違えば保存されていない（ほかの人の変更で版が進んだ）。
 */
export function autoRowsMatch(dbRows: readonly AllocationDbRow[], sent: readonly AllocationRow[]): boolean {
  const sum = (entries: Iterable<[string, number]>) => {
    const m = new Map<string, number>();
    for (const [k, n] of entries) m.set(k, (m.get(k) ?? 0) + n);
    return m;
  };
  const a = sum(
    dbRows
      .filter((r) => r.origin === 'auto' && !r.pinned)
      .map((r): [string, number] => [
        rowKey({ sourceRoomId: r.source_room_id, groupId: r.group_id, itemId: r.item_id, requestedItemId: r.requested_item_id, isKeep: r.is_keep }),
        r.count,
      ]),
  );
  const b = sum(sent.map((r): [string, number] => [rowKey(r), r.count]));
  if (a.size !== b.size) return false;
  for (const [k, n] of a) if (b.get(k) !== n) return false;
  return true;
}
