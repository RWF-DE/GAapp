import type { StoredAllocationRow } from '@gaapp/shared';
import { fixturePath, readFixtureDir } from '@gaapp/shared/testing';
import { describe, expect, it } from 'vitest';
import { toYearData } from '@/lib/data/year-data';
import { fixtureSnapshot } from '@/lib/testing/fixture-rows';
import { defaultCount, itemOptions, requestedOptions, sourceOptions } from './row-options';
import { buildViewModel, roomItemKey } from './view-model';

const fx = readFixtureDir(fixturePath('synthetic', 'r8like'));
const snap = fixtureSnapshot(fx);
const vm = buildViewModel(snap);
const { data } = toYearData(snap);
const desk = vm.items.find((i) => i.code === 'desk')!;
const caster = vm.items.find((i) => i.code === 'caster_desk')!;

describe('sourceOptions', () => {
  const withDesk = vm.rooms.filter((r) => r.usable && (vm.stock.get(roomItemKey(r.id, desk.id)) ?? 0) > 0);
  const first = withDesk[0]!;

  it('その品目の在庫がある使用可の場所だけ（場所の並び順）、余りは行の合計を引く', () => {
    const row: StoredAllocationRow = {
      id: 'x',
      sourceRoomId: first.id,
      groupId: vm.groups[0]!.id,
      itemId: desk.id,
      requestedItemId: desk.id,
      count: 2,
      isKeep: false,
      origin: 'auto',
      pinned: false,
      note: null,
    };
    const opts = sourceOptions(vm, [row], desk.id);
    expect(opts.map((o) => o.roomId)).toEqual(withDesk.map((r) => r.id));
    expect(opts[0]!.surplus).toBe((vm.stock.get(roomItemKey(first.id, desk.id)) ?? 0) - 2);
    expect(sourceOptions(vm, [row], desk.id, first.id).some((o) => o.roomId === first.id)).toBe(false);
  });

  it('使用不可の部屋は出さない', () => {
    const unusable = vm.rooms.filter((r) => !r.usable).map((r) => r.id);
    expect(unusable.length).toBeGreaterThan(0); // r8like は第一セミナーが使用不可
    for (const item of vm.items) expect(sourceOptions(vm, [], item.id).some((o) => unusable.includes(o.roomId))).toBe(false);
  });
});

describe('requestedOptions・itemOptions', () => {
  const stall = vm.groups.find((g) => g.category === 'stall' && data.requests.some((r) => r.groupId === g.id && r.itemId === desk.id && r.count > 0))!;

  it('申請品目は需要がある品目を先に', () => {
    const opts = requestedOptions(vm, data, [], stall.id);
    const firstZero = opts.findIndex((o) => o.demand === 0);
    expect(opts.slice(0, firstZero).every((o) => o.demand > 0)).toBe(true);
    expect(opts.find((o) => o.item.id === desk.id)!.demand).toBeGreaterThan(0);
  });

  it('品目は申請品目と代替ルールの先を許し、ほかはルール外', () => {
    const opts = itemOptions(vm, data, stall.id, desk.id);
    expect(opts[0]).toMatchObject({ item: { id: desk.id }, allowed: true, ruleCode: null });
    const c = opts.find((o) => o.item.id === caster.id)!;
    expect(c.allowed).toBe(true); // r8like の S07（机(木) → キャスター机、模擬店）
    expect(c.ruleCode).not.toBeNull();
    expect(opts.filter((o) => !o.allowed).length).toBeGreaterThan(0);
    // 入力がないときは申請品目だけ
    expect(itemOptions(vm, null, stall.id, desk.id).filter((o) => o.allowed).map((o) => o.item.id)).toEqual([desk.id]);
  });
});

describe('defaultCount', () => {
  it('max(1, min(不足, 余り))。不足・余りがなければ 1 と添え書き', () => {
    expect(defaultCount({ shortage: 5, surplus: 3, requestedName: '机(木)' })).toEqual({ count: 3, hints: [] });
    expect(defaultCount({ shortage: 0, surplus: 3, requestedName: '机(木)' })).toEqual({ count: 1, hints: ['この団体の机(木)は不足していません'] });
    expect(defaultCount({ shortage: 2, surplus: 0, requestedName: '机(木)' }).hints).toEqual(['この部屋の余りはありません']);
  });
});
