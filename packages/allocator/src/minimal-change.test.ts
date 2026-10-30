// 最小変更モード（D-08、設計 12.3）
import { describe, expect, it } from 'vitest';
import { fixtureIndex, FixtureBuilder, generateSynthetic, RULES, toAllocateInput } from '@gaapp/shared/testing';
import { allocate } from './allocate';
import { buildModel } from './model';
import { checkMinimalChange, componentsOf, judgeD08 } from './testing/d08';
import { hasR8, loadSet } from './testing/fixtureSets';
import { getHighs } from './testing/getHighs';

const SLOW = 300_000;

describe.each([loadSet('r8like'), ...(hasR8() ? [loadSet('r8')] : [])])('D-08：$label（$minimalChangeRoom を使用不可に）', (set) => {
  it('解け、M から運んだ行と補えるつながりがあり、補えるつながりでは (a)・(b) が成り立つ', async () => {
    const M = set.ix.roomId(set.minimalChangeRoom);
    // R8 は M が最初から使用不可なので、使用可にしてから始める（05 のとおり逆にたどる）
    const input = { ...set.input, rooms: set.input.rooms.map((r) => (r.id === M ? { ...r, usable: true } : r)) };
    const r = checkMinimalChange(input, M, await getHighs());
    if (!r.ok) throw new Error(`解けない（${r.reason}）`);
    expect(r.fromM).toBeGreaterThanOrEqual(1);
    expect(r.good).toBeGreaterThanOrEqual(1);
    expect(r.decreased).toEqual([]);
    expect(r.unrelatedChanged).toEqual([]);
    expect(r.untouchedChanged).toEqual([]);
    console.info(
      `[${set.label}・${set.minimalChangeRoom}] M から運んだ行 ${r.fromM}、つながり ${r.comps}（補える ${r.good}・補えない ${r.bad}）、` +
        `補えるつながりで前回の行が増えた ${r.increased.length}・新しい行 ${r.appeared.length}、補えないつながりの変わった行 ${r.changedInBad}`,
    );
  });
});

describe('D-08：合成データ シード 100〜129 × MER・HI1・CI2（設計 12.3 手順8）', () => {
  it(
    'full が解ける ⇔ minimal_change が解ける。解ける組では違反 0',
    async () => {
      const solver = await getHighs();
      let solved = 0;
      let infeasible = 0;
      let good = 0;
      let increased = 0;
      let appeared = 0;
      let noneGood = 0;
      for (let seed = 100; seed < 130; seed++) {
        const fx = generateSynthetic(seed);
        const ix = fixtureIndex(fx);
        const input = toAllocateInput(fx);
        for (const name of ['MER', 'HI1', 'CI2']) {
          const M = ix.roomId(name);
          const fullUnusable = allocate({ ...input, rooms: input.rooms.map((r) => (r.id === M ? { ...r, usable: false } : r)) }, solver);
          const r = checkMinimalChange(input, M, solver);
          const where = `seed ${seed} ${name}`;
          if (!r.ok) {
            expect(r.fullOk, where).toBe(true);
            expect(r.reason, where).toBe('infeasible');
            expect(fullUnusable.ok, where).toBe(false);
            expect(!fullUnusable.ok && fullUnusable.reason, where).toBe('infeasible');
            infeasible++;
            continue;
          }
          expect(fullUnusable.ok, where).toBe(true);
          solved++;
          expect(r.decreased, where).toEqual([]);
          expect(r.unrelatedChanged, where).toEqual([]);
          expect(r.untouchedChanged, where).toEqual([]);
          good += r.good;
          increased += r.increased.length;
          appeared += r.appeared.length;
          if (r.good === 0) noneGood++;
        }
      }
      expect(infeasible).toBeGreaterThanOrEqual(1);
      expect(solved + infeasible).toBe(90);
      console.info(`[seeds 100-129 × MER・HI1・CI2] 解けた ${solved}・解けない ${infeasible}、補えるつながり ${good}、前回の行が増えた ${increased}・新しい行 ${appeared}、補えるつながりのない入力 ${noneGood}`);
    },
    SLOW,
  );
});

describe('D-08 の判定そのもの（設計 12.3 手順9、12.5 の表）', () => {
  it('反例（S05 で運び元が限られた団体）：つながりは「補えない」に分かれ、無関係な行 R2→A が変わる', async () => {
    const b = new FixtureBuilder('cex')
      .room('M', { building: 'A', floor: 2 })
      .room('R2', { building: 'A', floor: 1 })
      .room('R3', { building: 'C', floor: 1 })
      .room('X', { building: 'A', floor: 2 })
      .room('Y', { building: 'A', floor: 1 })
      .group('S', 'department', 'X')
      .group('A', 'department', 'Y')
      .stock('M', { desk: 1 })
      .stock('R2', { desk: 2 })
      .stock('R3', { desk: 5 })
      .request('S', { desk: 2 })
      .request('A', { desk: 1 })
      .rule(RULES.restrict('S05', 'S', ['desk'], ['M', 'R2']));
    const ix = b.ids();
    const r = checkMinimalChange(b.input(), ix.roomId('M'), await getHighs());
    if (!r.ok) throw new Error(r.reason);
    const show = (rows: typeof r.before) => rows.map((x) => `${ix.roomName.get(x.sourceRoomId)}->${ix.groupName.get(x.groupId)}:${x.count}`).sort();
    expect(show(r.before)).toEqual(['M->S:1', 'R2->A:1', 'R2->S:1']);
    expect(show(r.after)).toEqual(['R2->S:2', 'R3->A:1']);
    expect([r.comps, r.good, r.bad]).toEqual([1, 0, 1]);
    expect(r.changedInBad).toBe(4);
  });

  it('増える例：補えるつながりで、M から受け取っていた (g,i) の前回の行が増えても (b) を通り、無関係な行を変えると落ちる', async () => {
    const b = new FixtureBuilder('inc')
      .room('M', { building: 'A', floor: 2 })
      .room('R', { building: 'A', floor: 1 })
      .room('Q', { building: 'C', floor: 1 })
      .room('X', { building: 'A', floor: 2 })
      .room('Y', { building: 'C', floor: 1 })
      .group('S', 'department', 'X')
      .group('A', 'department', 'Y')
      .stock('M', { desk: 1 })
      .stock('R', { desk: 2 })
      .stock('Q', { desk: 1 })
      .request('S', { desk: 2 })
      .request('A', { desk: 1 });
    const ix = b.ids();
    const M = ix.roomId('M');
    const solver = await getHighs();
    const r = checkMinimalChange(b.input(), M, solver);
    if (!r.ok) throw new Error(r.reason);
    const show = (rows: typeof r.before) => rows.map((x) => `${ix.roomName.get(x.sourceRoomId)}->${ix.groupName.get(x.groupId)}:${x.count}`).sort();
    expect(show(r.before)).toEqual(['M->S:1', 'Q->A:1', 'R->S:1']);
    expect(show(r.after)).toEqual(['Q->A:1', 'R->S:2']);
    expect([r.comps, r.good]).toEqual([1, 1]);
    expect(r.increased).toHaveLength(1);
    expect(r.appeared).toEqual([]);
    expect(r.unrelatedChanged).toEqual([]);
    // 無関係な Q→A を 0 にした rows を判定に渡すと (b) が落ちる
    const input2 = { ...b.input(), rooms: b.input().rooms.map((x) => (x.id === M ? { ...x, usable: false } : x)), mode: 'minimal_change' as const, previousRows: r.before };
    const m2 = buildModel(input2);
    if (m2.stage !== 'ready') throw new Error(m2.stage);
    const comp = componentsOf(m2.cands.vars);
    const c = comp(ix.groupId('S'), ix.itemId('desk'));
    const broken = r.after.filter((x) => x.groupId !== ix.groupId('A'));
    const j = judgeD08({ before: r.before, after: broken, M, comp, targetComps: new Set([c]), goodComps: new Set([c]) });
    expect(j.unrelatedChanged).toHaveLength(1);
  });
});
