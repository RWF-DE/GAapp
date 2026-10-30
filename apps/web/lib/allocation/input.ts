// スナップショット → AllocateInput（画面の設計 2.7 の buildAllocateInput。T13）。純粋関数。
// 並べ替えはしない（allocate・validate・exporter が自分で並べる。03）。
import type { AllocateInput, AllocateMode, AllocationRow, InputError, StoredAllocationRow } from '@gaapp/shared';
import { toStoredRows, toYearData, type YearDataSource } from '@/lib/data/year-data';
import type { AllocationDbRow } from '@/lib/db/types';

export interface BuiltInput {
  input: AllocateInput;
  /** toYearData の problems（1件でもあれば計算しない） */
  problems: InputError[];
}

/** 固定・手動の行（pinned か origin = manual）。自動振り分けで残る行 */
export const isFixedRow = (r: Pick<StoredAllocationRow, 'pinned' | 'origin'>) => r.pinned || r.origin === 'manual';

/** 自動振り分けで置き換わる行（origin = auto かつ未固定）。確認の「自動の行 N 件」 */
export const isReplaceableRow = (r: Pick<StoredAllocationRow, 'pinned' | 'origin'>) => !isFixedRow(r);

const toAllocationRow = (r: StoredAllocationRow): AllocationRow => ({
  sourceRoomId: r.sourceRoomId,
  groupId: r.groupId,
  itemId: r.itemId,
  requestedItemId: r.requestedItemId,
  count: r.count,
  isKeep: r.isKeep,
});

/**
 * fixedRows ＝ pinned か origin = manual の行、previousRows ＝ mode が minimal_change のとき origin = auto かつ未固定の行
 * （AllocationRow の列だけ）、full では []。
 */
export function buildAllocateInput(
  snapshot: YearDataSource & { allocations: readonly AllocationDbRow[] },
  mode: AllocateMode,
): BuiltInput {
  const { data, problems } = toYearData(snapshot);
  const { rows } = toStoredRows(snapshot);
  return {
    input: {
      ...data,
      mode,
      fixedRows: rows.filter(isFixedRow),
      previousRows: mode === 'minimal_change' ? rows.filter(isReplaceableRow).map(toAllocationRow) : [],
    },
    problems,
  };
}
