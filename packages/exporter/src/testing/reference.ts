// fixtures の reference/allocations.csv を ExportRow にする（allocator は使わない）
import {
  fixtureIndex,
  fixturePath,
  readFixtureDir,
  readReferenceDir,
  toYearData,
  type FixtureData,
  type FixtureReference,
} from '@gaapp/shared/testing';
import type { YearData } from '@gaapp/shared';
import type { ExportRow } from '../types';

export type ReferenceCase = { fx: FixtureData; data: YearData; rows: ExportRow[]; reference: FixtureReference };

export function loadReferenceCase(...dir: string[]): ReferenceCase {
  const d = fixturePath(...dir);
  const fx = readFixtureDir(d);
  const reference = readReferenceDir(d);
  if (!reference) throw new Error(`${d}/reference がありません`);
  const ix = fixtureIndex(fx);
  const data = toYearData(fx);
  const rows: ExportRow[] = reference.allocations.map((a) => {
    const g = fx.groups.find((x) => x.name === a.group)!;
    return {
      sourceRoomId: ix.roomId(a.source),
      groupId: ix.groupId(a.group),
      itemId: ix.itemId(a.item),
      requestedItemId: ix.itemId(a.requestedItem),
      count: a.count,
      // 運び元 = 団体の使用場所のとき、残す行
      isKeep: g.location === a.source,
      note: a.note,
    };
  });
  return { fx, data, rows, reference };
}
