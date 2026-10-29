import { fixtureIndex, fixturePath, readFixtureDir } from '@gaapp/shared/testing';
import { describe, expect, it } from 'vitest';
import { FIXTURE_UPDATED_AT, fixtureToTables } from '@/lib/testing/fixture-rows';
import type { AllocationDbRow, YearTables } from '@/lib/db/types';
import { swapAttention, swapRows } from './swaps';

const fx = readFixtureDir(fixturePath('synthetic', 'r8like'));
const ix = fixtureIndex(fx);
const desk = ix.itemId('desk');
const caster = ix.itemId('caster_desk');
const room = ix.roomId('1-1');
let n = 0;
const alloc = (group: string, requested: string, item: string, count: number, extra: Partial<AllocationDbRow> = {}): AllocationDbRow => ({
  id: `00000000-0000-4000-8000-${String(++n).padStart(12, '0')}`,
  year_id: 'y',
  source_room_id: room,
  group_id: ix.groupId(group),
  item_id: item,
  requested_item_id: requested,
  count,
  is_keep: false,
  origin: 'auto',
  pinned: false,
  note: null,
  updated_at: FIXTURE_UPDATED_AT,
  ...extra,
});

function tables(allocations: AllocationDbRow[], consents?: YearTables['consents']): YearTables {
  const t = fixtureToTables(fx);
  return { ...t, allocations, ...(consents ? { consents } : {}) };
}

describe('swapRows', () => {
  it('了承が要る代替（S07：机(木)→キャスター机）の置き換え台数を、固定・手動・自動を問わず団体ごとに足す', () => {
    const t = tables(
      [
        alloc('模擬店10', desk, caster, 2),
        alloc('模擬店10', desk, caster, 3, { origin: 'manual', pinned: true }),
        alloc('模擬店10', desk, desk, 5), // 置き換えでない行
      ],
      [],
    );
    const rows = swapRows(t);
    expect(rows).toEqual([
      {
        groupId: ix.groupId('模擬店10'),
        fromItemId: desk,
        toItemId: caster,
        current: 5,
        status: 'not_asked',
        asked: null,
        note: null,
        updatedAt: null,
        ruleCodes: ['S07'],
        attention: null,
      },
    ]);
  });

  it('了承の行があれば、置き換えが 0 でも出す（状況・依頼した台数・備考）', () => {
    const t = tables([]);
    const rows = swapRows(t);
    expect(rows).toHaveLength(fx.consents.length);
    const declined = rows.find((r) => r.groupId === ix.groupId('模擬店04'))!;
    expect(declined).toMatchObject({ status: 'declined', current: 0, attention: null });
  });

  it('注意：依頼の後に増えた・了承の後に増えた（W102）・拒否されたのに残る', () => {
    const consents: YearTables['consents'] = [
      { group_id: ix.groupId('模擬店01'), from_item_id: desk, to_item_id: caster, status: 'asked', count: 2, note: null, updated_at: 't' },
      { group_id: ix.groupId('模擬店02'), from_item_id: desk, to_item_id: caster, status: 'accepted', count: 2, note: '了承', updated_at: 't' },
      { group_id: ix.groupId('模擬店03'), from_item_id: desk, to_item_id: caster, status: 'declined', count: 2, note: null, updated_at: 't' },
      { group_id: ix.groupId('模擬店05'), from_item_id: desk, to_item_id: caster, status: 'accepted', count: 3, note: null, updated_at: 't' },
    ];
    const t = tables(
      [alloc('模擬店01', desk, caster, 3), alloc('模擬店02', desk, caster, 3), alloc('模擬店03', desk, caster, 1), alloc('模擬店05', desk, caster, 3)],
      consents,
    );
    const by = new Map(swapRows(t).map((r) => [r.groupId, r]));
    expect(by.get(ix.groupId('模擬店01'))!.attention).toBe('reask');
    expect(by.get(ix.groupId('模擬店02'))!.attention).toBe('w102');
    expect(by.get(ix.groupId('模擬店02'))!.note).toBe('了承');
    expect(by.get(ix.groupId('模擬店03'))!.attention).toBe('rerun');
    expect(by.get(ix.groupId('模擬店05'))!.attention).toBeNull();
  });

  it('並びは団体の並び順（sort_order → 名前 → id）', () => {
    const t = tables([alloc('模擬店12', desk, caster, 1), alloc('模擬店02', desk, caster, 1)], []);
    const order = swapRows(t).map((r) => r.groupId);
    const gs = fx.groups.filter((g) => ['模擬店02', '模擬店12'].includes(g.name)).sort((a, b) => a.sortOrder - b.sortOrder);
    expect(order).toEqual(gs.map((g) => ix.groupId(g.name)));
  });

  it('無効にした・壊れた代替ルールの組は数えない（了承の行は出す）', () => {
    const t = tables([alloc('模擬店10', desk, caster, 2)], []);
    t.rules = t.rules.map((r) => (r.code === 'S07' ? { ...r, enabled: false } : r));
    expect(swapRows(t)).toEqual([]);
  });

  it('swapAttention：依頼した台数のない了承は増えたと見なさない（validate の W102 と同じ）', () => {
    expect(swapAttention('accepted', 5, null)).toBeNull();
    expect(swapAttention('asked', 5, 5)).toBeNull();
    expect(swapAttention('declined', 0, 3)).toBeNull();
    expect(swapAttention('not_asked', 9, null)).toBeNull();
  });
});
