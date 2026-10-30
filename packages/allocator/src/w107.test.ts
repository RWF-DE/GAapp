import { describe, expect, it } from 'vitest';
import type { AllocationRow } from '@gaapp/shared';
import { FixtureBuilder, RULES } from '@gaapp/shared/testing';
import { allocate } from './allocate';
import { getHighs } from './testing/getHighs';
import { findW107 } from './w107';

const permutations = <T>(a: T[]): T[][] => (a.length <= 1 ? [a] : a.flatMap((x, k) => permutations([...a.slice(0, k), ...a.slice(k + 1)]).map((p) => [x, ...p])));

describe('findW107（D-20、設計 12.4）', () => {
  it('K-12 の最小例（同点）：並び順 12 通りすべてで W107 が 0', async () => {
    const solver = await getHighs();
    let n = 0;
    for (const p of permutations([1, 2, 3])) {
      for (const q of [[1, 2], [2, 1]]) {
        const b = new FixtureBuilder('k12')
          .room('A', { building: 'X', floor: 1, sortOrder: p[0] })
          .room('B', { building: 'X', floor: 2, sortOrder: p[1] })
          .room('O', { kind: 'outdoor', sortOrder: p[2] })
          .group('g', 'department', 'A', { sortOrder: q[0] })
          .group('h', 'department', 'O', { sortOrder: q[1] })
          .stock('A', { desk: 5 })
          .stock('B', { desk: 5 })
          .request('g', { desk: 5 })
          .request('h', { desk: 5 });
        const res = allocate(b.input(), solver);
        if (!res.ok) throw new Error(res.reason);
        expect(findW107(b.yearData(), res.rows)).toEqual([]);
        n++;
      }
    }
    expect(n).toBe(12);
  });

  const row = (ix: ReturnType<FixtureBuilder['ids']>, r: string, g: string, j = 'desk', i = j, count = 1): AllocationRow => ({
    sourceRoomId: ix.roomId(r), groupId: ix.groupId(g), itemId: ix.itemId(j), requestedItemId: ix.itemId(i), count, isKeep: false });

  it('同じ部屋を使う別の団体へ渡すのは「外へ出る」に数えない（D-23）', () => {
    const b = new FixtureBuilder('w').room('L').room('R').group('g', 'stall', 'L').group('g2', 'stall', 'L');
    const ix = b.ids();
    expect(findW107(b.yearData(), [row(ix, 'L', 'g2'), row(ix, 'R', 'g')])).toEqual([]);
  });

  it('S05 で入れ替えられないものは数えない（設営側・S05 の部屋を使う団体側）。T00 の定義では数える', () => {
    const b = new FixtureBuilder('w')
      .room('体育館', { kind: 'gym', building: '体育館' })
      .room('1-1', { building: 'A' })
      .room('Q', { building: 'A' })
      .group('設営', 'department', '体育館')
      .group('h', 'stall', 'Q')
      .group('模擬店', 'stall', '1-1')
      .rule(RULES.restrict('S05', '設営', ['desk'], ['1-1']));
    const ix = b.ids();
    // 設営側：体育館の机が h へ出て、設営は 1-1 から受け取る
    const a = findW107(b.yearData(), [row(ix, '体育館', 'h'), row(ix, '1-1', '設営')]);
    expect(a.map((f) => [ix.groupName.get(f.groupId), f.swappable])).toEqual([['設営', false]]);
    // S05 の部屋を使う団体側：1-1 の机が設営へ出て、模擬店は Q から受け取る
    const c = findW107(b.yearData(), [row(ix, '1-1', '設営'), row(ix, 'Q', '模擬店')]);
    expect(c.map((f) => [ix.groupName.get(f.groupId), f.swappable])).toEqual([['模擬店', false]]);
    // S05 がなければ入れ替えられる
    const free = new FixtureBuilder('w').room('体育館', { kind: 'gym', building: '体育館' }).room('1-1', { building: 'A' }).room('Q', { building: 'A' })
      .group('設営', 'department', '体育館').group('h', 'stall', 'Q').group('模擬店', 'stall', '1-1');
    expect(findW107(free.yearData(), [row(ix, '体育館', 'h'), row(ix, '1-1', '設営')]).map((f) => f.swappable)).toEqual([true]);
  });

  it('入れ替えると距離の合計が増えるものは数えない（上書き X–Y ＝ 1・Y–Z ＝ 1）。上書きがなければ数える', async () => {
    const mk = (ov: boolean) => {
      const b = new FixtureBuilder('w')
        .room('r', { building: 'X' })
        .room('L', { building: 'Y' })
        .room('H', { building: 'Z' })
        .group('g', 'department', 'L')
        .group('h', 'department', 'H')
        .stock('r', { desk: 1 })
        .stock('L', { desk: 1 })
        .request('g', { desk: 1 })
        .request('h', { desk: 1 });
      return ov ? b.override('X', 'Y', 1).override('Y', 'Z', 1) : b;
    };
    const b = mk(true);
    const ix = b.ids();
    const res = allocate(b.input(), await getHighs());
    if (!res.ok) throw new Error(res.reason);
    expect(res.rows.map((r) => `${ix.roomName.get(r.sourceRoomId)}->${ix.groupName.get(r.groupId)}`).sort()).toEqual(['L->h', 'r->g']);
    expect(findW107(b.yearData(), res.rows).map((f) => f.swappable)).toEqual([false]);
    expect(findW107(mk(false).yearData(), res.rows).map((f) => f.swappable)).toEqual([true]);
  });

  it('申請品目は読み替えてから判定する（企業以外の長机(3人掛)の行）', () => {
    const b = new FixtureBuilder('w').room('L').room('R', { building: 'A' }).group('g', 'stall', 'L').group('h', 'stall', 'R');
    const ix = b.ids();
    const f = findW107(b.yearData(), [row(ix, 'L', 'h', 'long_desk_2', 'long_desk_3'), row(ix, 'R', 'g', 'long_desk_2', 'long_desk_3')]);
    // g（L）も h（R）も、自室の長机(2人掛)を外へ出しつつ他から受け取っている
    expect(f.map((x) => x.swappable)).toEqual([true, true]);
  });
});
