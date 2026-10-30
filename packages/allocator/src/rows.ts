// 結果の行（設計 10 章）
import type { AllocationRow } from '@gaapp/shared';
import type { Candidate } from './candidates';
import { rgijKey, type Ctx } from './context';

/** x と x̂ の値を (r,g,i,j) ごとに足し、残すの行を同じキーに足す。0 の行は出さない。並びは 品目 → 運び元 → 団体 → 申請品目 */
export function toRows(
  ctx: Pick<Ctx, 'groupById' | 'itemIndex' | 'roomIndex' | 'groupIndex'>,
  vars: readonly Candidate[],
  values: readonly number[],
  keepRows: readonly AllocationRow[],
): AllocationRow[] {
  const acc = new Map<string, AllocationRow>();
  const put = (r: string, g: string, i: string, j: string, n: number) => {
    if (n <= 0) return;
    const k = rgijKey(r, g, i, j);
    const cur = acc.get(k);
    if (cur) cur.count += n;
    else
      acc.set(k, {
        sourceRoomId: r,
        groupId: g,
        itemId: j,
        requestedItemId: i,
        count: n,
        isKeep: ctx.groupById.get(g)!.locationRoomId === r,
      });
  };
  vars.forEach((v, n) => put(v.r, v.g, v.i, v.j, values[n] ?? 0));
  for (const k of keepRows) put(k.sourceRoomId, k.groupId, k.requestedItemId, k.itemId, k.count);
  return [...acc.values()].sort(
    (a, b) =>
      ctx.itemIndex.get(a.itemId)! - ctx.itemIndex.get(b.itemId)! ||
      ctx.roomIndex.get(a.sourceRoomId)! - ctx.roomIndex.get(b.sourceRoomId)! ||
      ctx.groupIndex.get(a.groupId)! - ctx.groupIndex.get(b.groupId)! ||
      ctx.itemIndex.get(a.requestedItemId)! - ctx.itemIndex.get(b.requestedItemId)!,
  );
}
