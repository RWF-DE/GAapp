// 未保存の変更の文（外した変更・反映済みに見える変更の一覧。画面の設計 3.9。T13 の段 2）。純粋関数。
import type { StoredAllocationRow } from '@gaapp/shared';
import type { PendingChange, RowPatch } from './pending';
import type { ViewModel } from './view-model';

const UNKNOWN = '（不明）';

function target(vm: ViewModel, r: Pick<StoredAllocationRow, 'groupId' | 'itemId' | 'sourceRoomId' | 'count'>): string {
  const g = vm.groupById.get(r.groupId)?.name ?? UNKNOWN;
  const i = vm.itemById.get(r.itemId)?.name ?? UNKNOWN;
  const s = vm.roomById.get(r.sourceRoomId)?.name ?? UNKNOWN;
  return `${g}の${i}（${s}から ${r.count}）`;
}

function patchText(vm: ViewModel, row: StoredAllocationRow | undefined, p: RowPatch): string {
  const parts: string[] = [];
  if (p.count !== undefined) parts.push(`数 ${row?.count ?? '?'} → ${p.count}`);
  if (p.sourceRoomId !== undefined) parts.push(`運び元 → ${vm.roomById.get(p.sourceRoomId)?.name ?? UNKNOWN}`);
  if (p.itemId !== undefined) parts.push(`品目 → ${vm.itemById.get(p.itemId)?.name ?? UNKNOWN}`);
  if (p.requestedItemId !== undefined) parts.push(`申請品目 → ${vm.itemById.get(p.requestedItemId)?.name ?? UNKNOWN}`);
  if (p.note !== undefined) parts.push(p.note === null ? '備考を消す' : '備考を変える');
  if (p.pinned !== undefined) parts.push(p.pinned ? '固定する' : '固定を外す');
  return parts.join('・');
}

/**
 * 変更の1行の文。rowsById は変更の前の行（DB の行。消えた行は undefined）。
 * 例：「模擬店01の机(木)（1-1から 3）：数 3 → 5」「追加：模擬店01の机(木)（1-2から 2）」「削除：…」
 */
export function describeChange(vm: ViewModel, c: PendingChange, rowsById: ReadonlyMap<string, StoredAllocationRow>): string {
  if (c.op === 'insert') return `追加：${target(vm, c)}`;
  const row = rowsById.get(c.id);
  const what = row ? target(vm, row) : '（消えた行）';
  if (c.op === 'delete') return `削除：${what}`;
  return `${what}：${patchText(vm, row, c.patch)}`;
}
