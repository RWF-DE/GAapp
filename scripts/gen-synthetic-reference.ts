// 合成データの reference/（設計 3.6）：r8like を full で allocate し（highs 1.15.4）、rows を名前の形で
// reference/allocations.csv に、団体・品目ごとの合計を reference/group_totals.csv に書く。note は空（自動の備考は exporter が付ける）。
// 使い方：pnpm gen:synthetic-reference（再生成した結果がコミット済みと一致することは scripts/gen-synthetic.test.ts が確かめる）
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import loadHighs from 'highs';
import { allocate, type LpSolver } from '@gaapp/allocator';
import {
  emptyCounts,
  fixtureIndex,
  readFixtureDir,
  toAllocateInput,
  writeReferenceDir,
  type FixtureReference,
  type ItemCounts,
} from '@gaapp/shared/testing';
import { SYNTHETIC_DIR } from './gen-synthetic-fixtures';

export function buildSyntheticReference(solver: LpSolver, dir = SYNTHETIC_DIR): FixtureReference {
  const fx = readFixtureDir(dir);
  const ix = fixtureIndex(fx);
  const res = allocate(toAllocateInput(fx), solver);
  if (!res.ok) throw new Error(`合成データが解けません（${res.reason}）：${res.message}`);
  const allocations = res.rows.map((r) => ({
    item: ix.itemCode.get(r.itemId)!,
    source: ix.roomName.get(r.sourceRoomId)!,
    group: ix.groupName.get(r.groupId)!,
    requestedItem: ix.itemCode.get(r.requestedItemId)!,
    count: r.count,
    note: null,
  }));
  const totals = new Map<string, ItemCounts>(fx.groups.map((g) => [g.name, emptyCounts()]));
  for (const a of allocations) totals.get(a.group)![a.item as keyof ItemCounts] += a.count;
  const groups = fx.groups.slice().sort((a, b) => a.sortOrder - b.sortOrder);
  return { allocations, groupTotals: groups.map((g) => ({ group: g.name, counts: totals.get(g.name)! })) };
}

export async function main(): Promise<void> {
  const ref = buildSyntheticReference(await loadHighs());
  writeReferenceDir(SYNTHETIC_DIR, ref);
  console.log(`wrote ${path.join(SYNTHETIC_DIR, 'reference')}（${ref.allocations.length} 行）`);
}

if (process.argv[1] && pathToFileURL(path.resolve(process.argv[1])).href === import.meta.url) await main();
