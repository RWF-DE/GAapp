import { describe, expect, it } from 'vitest';
import { FixtureBuilder, RULES } from '@gaapp/shared/testing';
import { buildModel } from './model';
import { shuffleInput } from './testing/shuffle';

const small = () =>
  new FixtureBuilder('lp')
    .room('X', { building: 'A', floor: 1 })
    .room('Y', { building: 'A', floor: 2 })
    .group('G1', 'stall', 'X')
    .stock('X', { desk: 1 })
    .stock('Y', { desk: 3 })
    .request('G1', { desk: 2 });

describe('writeLp（設計 8 章）', () => {
  it('小さな入力の LP の文字列', () => {
    const m = buildModel(small().input());
    expect(m.stage).toBe('ready');
    if (m.stage !== 'ready') return;
    expect(m.weights).toEqual({ K: 1, P: 0, dMax: 2, A: 2, B: 2, U: 7, mu: 0, W: 8 });
    expect(m.lp).toBe(
      ['Minimize', ' obj: + 0 x1 + 5 x2', 'Subject To', ' s1: + x1 <= 1', ' s2: + x2 <= 3', ' d1: + x1 + x2 = 2', 'End', ''].join('\n'),
    );
  });

  it('最小変更：x̂ は Bounds に上限、係数は − μ', () => {
    const b = small();
    const ix = b.ids();
    const prev = { sourceRoomId: ix.roomId('Y'), groupId: ix.groupId('G1'), itemId: ix.itemId('desk'), requestedItemId: ix.itemId('desk'), count: 2, isKeep: false };
    const m = buildModel(b.input({ mode: 'minimal_change', previousRows: [prev] }));
    if (m.stage !== 'ready') throw new Error(m.stage);
    // K=1, U=7 → μ = 8、W = 1·(7+8)+1 = 16
    expect(m.weights.mu).toBe(8);
    expect(m.lp).toContain(' obj: + 0 x1 + 5 x2 - 3 x3');
    expect(m.lp).toContain('Bounds\n x3 <= 2\nEnd\n');
    expect(m.lp).toContain(' s2: + x2 + x3 <= 3');
  });

  it('変数名は x1, x2, … の連番で、整数だけを書く', () => {
    const b = small().room('Z', { building: 'B' }).stock('Z', { desk_ng: 4 }).group('G2', 'rest_area', null).request('G2', { chair: 1 }).stock('Z', { chair_ng: 1, chair: 1 }).rule(RULES.S01(), RULES.S02());
    const m = buildModel(b.input());
    if (m.stage !== 'ready') throw new Error(m.stage);
    expect(m.names.every((n) => /^x[1-9][0-9]*$/.test(n))).toBe(true);
    expect(m.lp).not.toMatch(/\d\.\d/);
  });

  it('入力の並びを変えても同じ文字列', () => {
    const b = small().room('Z', { building: 'B' }).stock('Z', { desk: 2 }).group('G2', 'stall', 'Z').request('G2', { desk: 1 });
    const input = b.input();
    const lp = (buildModel(input) as { lp: string }).lp;
    for (let s = 1; s <= 5; s++) expect((buildModel(shuffleInput(input, s)) as { lp: string }).lp).toBe(lp);
  });

  it('同名・同じ sort_order の団体は id の順（UTF-16 のコード単位）', () => {
    const input = small().group('G2', 'stall', 'Y').request('G2', { desk: 1 }).input();
    const g2 = input.groups.find((g) => g.name === 'G2')!;
    const g1 = input.groups.find((g) => g.name === 'G1')!;
    const ids = ['00000000-0000-4000-8000-00000000000b', '00000000-0000-4000-8000-00000000000a'];
    const relabel = (id: string, to: string) => (x: string) => (x === id ? to : x);
    const swap = [relabel(g1.id, ids[0]!), relabel(g2.id, ids[1]!)];
    const fix = (x: string) => swap.reduce((a, f) => f(a), x);
    const same = {
      ...input,
      groups: input.groups.map((g) => ({ ...g, id: fix(g.id), name: 'G', sortOrder: 1 })),
      requests: input.requests.map((r) => ({ ...r, groupId: fix(r.groupId) })),
    };
    const m = buildModel(same);
    if (m.stage !== 'ready') throw new Error(m.stage);
    expect(m.cands.demandRows.map((r) => r.g)).toEqual([ids[1], ids[0]]);
  });
});
