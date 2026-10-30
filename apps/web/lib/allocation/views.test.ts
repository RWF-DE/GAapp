import type { AllocationDbRow } from '@/lib/db/types';
import { fixturePath, readFixtureDir } from '@gaapp/shared/testing';
import { describe, expect, it } from 'vitest';
import { autoRowsMatch } from '@/lib/data/allocation';
import { toStoredRows, toYearData } from '@/lib/data/year-data';
import { FIXTURE_UPDATED_AT, fixtureSnapshot } from '@/lib/testing/fixture-rows';
import { groupViews } from './group-view';
import { buildAllocateInput } from './input';
import { itemTabBlocks, KEEP_DEST, roomHasBlock, roomTabFor } from './item-view';
import { itemTabs } from './tabs';
import { buildViewModel } from './view-model';

const fx = readFixtureDir(fixturePath('synthetic', 'r8like'));
const base = fixtureSnapshot(fx);
const item = (code: string) => base.items.find((i) => i.code === code)!;
const storage = base.rooms.filter((r) => r.is_storage);
const group = base.groups.find((g) => g.category === 'stall' && g.location_room_id)!;

let n = 0;
function row(p: Partial<AllocationDbRow>): AllocationDbRow {
  n += 1;
  return {
    id: `00000000-0000-4000-8000-${String(n).padStart(12, '0')}`,
    year_id: base.year.id,
    source_room_id: storage[0]!.id,
    group_id: group.id,
    item_id: item('desk').id,
    requested_item_id: item('desk').id,
    count: 3,
    is_keep: false,
    origin: 'auto',
    pinned: false,
    note: null,
    updated_at: FIXTURE_UPDATED_AT,
    ...p,
  };
}

const rows = [
  row({ count: 4 }),
  row({ origin: 'manual', item_id: item('desk_ng').id, count: 2 }),
  row({ pinned: true, source_room_id: storage[1]!.id, count: 5 }),
  row({ item_id: item('caster_desk').id, count: 6 }), // 机(木)の代わりのキャスター机（自動）
];
const snap = fixtureSnapshot(fx, { tables: { allocations: rows } });

describe('buildAllocateInput', () => {
  it('fixedRows は固定か手動の行、full では previousRows は空', () => {
    const { input, problems } = buildAllocateInput(snap, 'full');
    expect(problems).toEqual([]);
    expect(input.mode).toBe('full');
    expect(input.fixedRows.map((r) => r.id)).toEqual([rows[1]!.id, rows[2]!.id]);
    expect(input.previousRows).toEqual([]);
  });

  it('minimal_change では、自動かつ未固定の行を AllocationRow の列だけで previousRows に入れる', () => {
    const { input } = buildAllocateInput(snap, 'minimal_change');
    expect(input.previousRows).toEqual([
      { sourceRoomId: storage[0]!.id, groupId: group.id, itemId: item('desk').id, requestedItemId: item('desk').id, count: 4, isKeep: false },
      { sourceRoomId: storage[0]!.id, groupId: group.id, itemId: item('caster_desk').id, requestedItemId: item('desk').id, count: 6, isKeep: false },
    ]);
  });
});

describe('itemTabBlocks', () => {
  const vm = buildViewModel(snap);
  const tabs = itemTabs(toYearData(snap).data.items);
  const desk = tabs.find((t) => t.key === 'desk')!;

  it('運び元ごとのまとまりに、在庫・合計・余り（在庫 − 合計）を出す', () => {
    const blocks = itemTabBlocks(vm, toStoredRows(snap).rows, desk);
    const b0 = blocks.find((b) => b.room.id === storage[0]!.id)!;
    expect(b0.rows.map((r) => r.row.count)).toEqual([4, 2]);
    const deskCell = b0.cells[0]!;
    expect(deskCell.allocated).toBe(4);
    expect(deskCell.surplus).toBe((deskCell.stock ?? 0) - 4);
    expect(b0.cells[1]!.allocated).toBe(2);
    // キャスター机の行は机(木)のタブに出ない
    expect(blocks.flatMap((b) => b.rows).some((r) => r.row.itemId === item('caster_desk').id)).toBe(false);
  });

  it('申請品目が品目と違う行は「〜の代わり」の名前を持つ', () => {
    const caster = tabs.find((t) => t.key === 'caster_desk')!;
    const v = itemTabBlocks(vm, toStoredRows(snap).rows, caster).flatMap((b) => b.rows)[0]!;
    expect(v.requestedName).toBe(item('desk').name);
  });

  it('使用不可の部屋は余りを数えない（null）', () => {
    const unusable = { ...snap, roomYears: [{ year_id: snap.year.id, room_id: storage[0]!.id, usable: false, note: null, updated_at: FIXTURE_UPDATED_AT }] };
    const b0 = itemTabBlocks(buildViewModel(unusable), toStoredRows(snap).rows, desk).find((b) => b.room.id === storage[0]!.id)!;
    expect(b0.room.usable).toBe(false);
    expect(b0.cells[0]!.surplus).toBeNull();
  });

  it('残すの行は「残す」で先頭', () => {
    const keepRows = [row({ source_room_id: group.location_room_id!, is_keep: true, count: 1 }), row({ source_room_id: group.location_room_id!, count: 1, group_id: base.groups[1]!.id })];
    const s = fixtureSnapshot(fx, { tables: { allocations: keepRows } });
    const block = itemTabBlocks(buildViewModel(s), toStoredRows(s).rows, desk).find((b) => b.room.id === group.location_room_id)!;
    expect(block.rows[0]!.dest).toBe(KEEP_DEST);
  });

  it('viewer（public）は在庫を読めないので、在庫と余りは null で、行のある部屋だけ', () => {
    const pub = { ...snap, part: 'public' as const, stocks: [] };
    const blocks = itemTabBlocks(buildViewModel(pub), toStoredRows(pub).rows, desk);
    expect(blocks.map((b) => b.room.id).sort()).toEqual([storage[0]!.id, storage[1]!.id].sort());
    expect(blocks[0]!.cells[0]!.stock).toBeNull();
    expect(blocks[0]!.cells[0]!.surplus).toBeNull();
  });
});

describe('roomTabFor（部屋の見出しへ移るときのタブ）', () => {
  const mer = base.rooms.find((r) => r.name === 'MER')!;
  const vm = buildViewModel(snap);
  const stored = toStoredRows(snap).rows;
  const tabs = itemTabs(toYearData(snap).data.items);

  it('roomHasBlock は itemTabBlocks がその部屋のまとまりを出すかと同じ', () => {
    for (const t of tabs) {
      for (const r of base.rooms) {
        expect(roomHasBlock(vm, stored, t, r.id), `${t.key} ${r.name}`).toBe(itemTabBlocks(vm, stored, t).some((b) => b.room.id === r.id));
      }
    }
  });

  it('望んだタブにその部屋のまとまりがあればそのタブ。なければ（行も在庫もない）まとまりのある最初のタブ', () => {
    // MER は教卓の在庫も行もない（合成データ）。机(木)・椅子(木)には在庫がある
    expect(roomHasBlock(vm, stored, tabs.find((t) => t.key === 'lectern')!, mer.id)).toBe(false);
    expect(roomTabFor(vm, stored, tabs, mer.id, 'lectern')).toBe('desk');
    expect(roomTabFor(vm, stored, tabs, mer.id, 'chair')).toBe('chair');
    expect(roomTabFor(vm, stored, tabs, mer.id, null)).toBe('desk');
    expect(roomTabFor(vm, stored, tabs, mer.id, 'unknown_tab')).toBe('desk');
  });

  it('在庫がなくても、その部屋からの行があるタブにはまとまりがある', () => {
    const s = fixtureSnapshot(fx, {
      tables: { allocations: [row({ source_room_id: mer.id, item_id: item('lectern').id, requested_item_id: item('lectern').id, count: 1 })] },
    });
    expect(roomTabFor(buildViewModel(s), toStoredRows(s).rows, tabs, mer.id, 'lectern')).toBe('lectern');
  });

  it('どのタブにもまとまりがなければ、望んだタブ（なければ null）', () => {
    const pvm = buildViewModel({ ...snap, part: 'public' as const, stocks: [] });
    expect(roomTabFor(pvm, [], tabs, mer.id, 'chair')).toBe('chair');
    expect(roomTabFor(pvm, [], tabs, mer.id, null)).toBeNull();
  });
});

describe('groupViews', () => {
  it('申請品目ごとの需要・振り分け数・差、内訳（運ぶ品目と運び元）', () => {
    const y = toYearData(snap);
    const views = groupViews(buildViewModel(snap), y.data, toStoredRows(snap).rows);
    const g = views.find((v) => v.group.id === group.id)!;
    const deskLine = g.lines.find((l) => l.requestedItemId === item('desk').id)!;
    expect(deskLine.allocated).toBe(4 + 2 + 5 + 6); // 不可机・キャスター机の行も申請品目は机(木)
    expect(deskLine.diff).toBe(deskLine.allocated - deskLine.demand);
    expect(deskLine.breakdown.map((b) => [b.itemName, b.count])).toEqual([
      [item('desk').name, 9],
      [item('desk_ng').name, 2],
      [item('caster_desk').name, 6],
    ]);
  });
});

describe('autoRowsMatch', () => {
  const sent = toStoredRows(snap).rows.filter((r) => r.origin === 'auto' && !r.pinned).map(({ sourceRoomId, groupId, itemId, requestedItemId, count, isKeep }) => ({ sourceRoomId, groupId, itemId, requestedItemId, count, isKeep }));
  it('DB の自動の行が送った行と同じなら保存されていた', () => {
    expect(autoRowsMatch(rows, sent)).toBe(true);
  });
  it('数が違えば保存されていない', () => {
    expect(autoRowsMatch(rows, sent.map((r, k) => (k === 0 ? { ...r, count: r.count + 1 } : r)))).toBe(false);
    expect(autoRowsMatch(rows, sent.slice(1))).toBe(false);
  });
});
