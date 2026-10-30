// 決定性（設計 8 章）：空でない fixedRows・previousRows・consents・distanceOverrides を持つ入力の配列と keep の params.items の
// キーの順を、シード固定で20通り並べ替えて、LP の文字列と rows が完全に一致すること
import { beforeAll, describe, expect, it } from 'vitest';
import type { AllocateInput } from '@gaapp/shared';
import { toFixedRow } from '@gaapp/shared/testing';
import { allocate } from './allocate';
import { buildModel } from './model';
import { loadSet } from './testing/fixtureSets';
import { getHighs } from './testing/getHighs';
import { orderSignature, SHUFFLED_ARRAYS, shuffleInput } from './testing/shuffle';

describe('決定性：並べ替えても同じ', () => {
  const set = loadSet('r8like');
  const ix = set.ix;
  let input: AllocateInput;
  beforeAll(async () => {
    const solver = await getHighs();
    const full = allocate(set.input, solver);
    if (!full.ok) throw new Error(full.reason);
    // 固定行：MER 以外の行から5行おき（manual と pinned を混ぜる）と、残すの行を pinned にした行
    const keepRow = full.rows.find((r) => r.isKeep && r.groupId === ix.groupId('学科展示') && ix.itemCode.get(r.itemId) === 'chair')!;
    const picked = full.rows.filter((r, k) => k % 5 === 2 && r.sourceRoomId !== ix.roomId('MER') && r !== keepRow).slice(0, 8);
    const fixedRows = [
      ...picked.map((r, n) => toFixedRow(r, n, n % 2 === 0 ? { origin: 'manual', pinned: false, note: '手で直した' } : { pinned: true })),
      toFixedRow(keepRow, 99, { pinned: true }),
    ];
    const fixedSet = new Set([...picked, keepRow]);
    input = {
      ...set.input,
      rooms: set.input.rooms.map((r) => (r.name === 'MER' ? { ...r, usable: false } : r)),
      mode: 'minimal_change',
      fixedRows,
      previousRows: full.rows.filter((r) => !fixedSet.has(r)),
      // 結果に効く上書きを足す（教室棟B–体育館）
      distanceOverrides: [...set.input.distanceOverrides, { buildingA: '体育館', buildingB: '教室棟B', cost: 2 }],
    };
    expect(input.fixedRows.length).toBeGreaterThanOrEqual(5);
    expect(input.consents.filter((c) => c.status === 'declined').length).toBeGreaterThanOrEqual(1);
    expect(input.consents.length).toBeGreaterThanOrEqual(3);
    // 上書きが結果に効くこと
    const without = allocate({ ...input, distanceOverrides: set.input.distanceOverrides }, solver);
    const withIt = allocate(input, solver);
    expect(without.ok && withIt.ok).toBe(true);
    expect(without.ok && withIt.ok && JSON.stringify(without.rows) !== JSON.stringify(withIt.rows)).toBe(true);
  });

  it(
    '20 通りの並べ替えで LP の文字列と rows が一致し、各配列の並びが少なくとも1通りで実際に変わる',
    async () => {
      const solver = await getHighs();
      const m0 = buildModel(input);
      if (m0.stage !== 'ready') throw new Error(m0.stage);
      const r0 = allocate(input, solver);
      if (!r0.ok) throw new Error(r0.reason);
      const changed = new Set<string>();
      for (let seed = 1; seed <= 20; seed++) {
        const s = shuffleInput(input, seed);
        for (const k of [...SHUFFLED_ARRAYS, 'keepItems'] as const) if (orderSignature(s, k) !== orderSignature(input, k)) changed.add(k);
        const m = buildModel(s);
        expect(m.stage === 'ready' && m.lp === m0.lp, `seed ${seed}`).toBe(true);
        const r = allocate(s, solver);
        expect(r.ok && r.rows, `seed ${seed}`).toEqual(r0.rows);
      }
      expect([...changed].sort()).toEqual([...SHUFFLED_ARRAYS, 'keepItems'].sort());
    },
    60_000,
  );

  it('同じ入力で2回解いて rows が一致する', async () => {
    const solver = await getHighs();
    const a = allocate(input, solver);
    const b = allocate(input, solver);
    expect(a.ok && b.ok && a.rows).toEqual(b.ok && b.rows);
  });
});
