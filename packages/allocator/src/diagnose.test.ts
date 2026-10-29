import { describe, expect, it } from 'vitest';
import type { AllocateInput } from '@gaapp/shared';
import { FixtureBuilder, RULES, makeInfeasibleS05, toAllocateInput } from '@gaapp/shared/testing';
import { allocate } from './allocate';
import { COMBINATION_MESSAGE, STOCK_SHORT_MESSAGE } from './diagnose';
import { loadSet } from './testing/fixtureSets';
import { getHighs } from './testing/getHighs';

const fail = (r: ReturnType<typeof allocate>) => {
  if (r.ok) throw new Error('解けてしまった');
  if (r.reason !== 'infeasible') throw new Error(`reason ${r.reason}`);
  return r;
};

describe('diagnose：小さな入力', () => {
  it('品目全体の不足：申請が在庫より多いと shortages に品目と不足数（groupId = null）が入る。ルールでは直らないので causes は空', async () => {
    const b = new FixtureBuilder('d').room('X').stock('X', { desk: 5 }).group('G', 'department', 'X').group('H', 'department', 'X').request('G', { desk: 4 }).request('H', { desk: 4 });
    const ix = b.ids();
    const r = fail(allocate(b.input(), await getHighs()));
    expect(r.shortages).toEqual([{ requestedItemId: ix.itemId('desk'), groupId: null, demand: 8, supply: 5 }]);
    expect(r.causes).toEqual([]);
    expect(r.message).toBe('解けません');
  });

  it('団体つきの不足（P7）も品目全体の不足の後ろに残る', async () => {
    const b = new FixtureBuilder('d').room('X').stock('X', { desk: 5 }).group('G', 'department', 'X').request('G', { desk: 8 });
    const ix = b.ids();
    const r = fail(allocate(b.input(), await getHighs()));
    expect(r.shortages).toEqual([
      { requestedItemId: ix.itemId('desk'), groupId: null, demand: 8, supply: 5 },
      { requestedItemId: ix.itemId('desk'), groupId: ix.groupId('G'), demand: 8, supply: 5 },
    ]);
  });

  it('S05（運び元の制限）が原因：P7 で止まる入力でも causes に S05 と、需要と在庫の内訳が入る', async () => {
    const b = new FixtureBuilder('d')
      .room('A').room('B').stock('A', { desk: 3 }).stock('B', { desk: 10 })
      .group('G', 'department', 'A').request('G', { desk: 5 })
      .rule(RULES.restrict('S05', 'G', ['desk'], ['A']));
    const ix = b.ids();
    const r = fail(allocate(b.input(), await getHighs()));
    expect(r.shortages).toEqual([{ requestedItemId: ix.itemId('desk'), groupId: ix.groupId('G'), demand: 5, supply: 3 }]);
    expect(r.causes).toEqual([
      expect.objectContaining({
        ruleCode: 'S05',
        details: [{ groupId: ix.groupId('G'), itemIds: [ix.itemId('desk')], roomIds: [ix.roomId('A')], demand: 5, supply: 3 }],
      }),
    ]);
  });

  it('S05 が原因で、HiGHS が Infeasible を返す入力（P7 では止まらない）でも S05 が入る', async () => {
    // G1・G2 とも A だけから受け取る。A は 6 台、需要は合わせて 8 台。各団体の需要は A の在庫以下
    const b = new FixtureBuilder('d')
      .room('A').room('B').stock('A', { desk: 6 }).stock('B', { desk: 10 })
      .group('G1', 'department', 'A').group('G2', 'department', 'A').request('G1', { desk: 4 }).request('G2', { desk: 4 })
      .rule(RULES.restrict('S05', 'G1', ['desk'], ['A']), RULES.restrict('S09', 'G2', ['desk'], ['A']));
    const r = fail(allocate(b.input(), await getHighs()));
    expect(r.shortages).toEqual([]);
    // 片方を外せば足りる。どちらを外しても解ける
    expect(r.causes.map((c) => c.ruleCode)).toEqual(['S05', 'S09']);
  });

  it('どのルールを外しても解けない入力では「複数の条件の組み合わせ」が返り、制限の対象ごとの内訳が並ぶ', async () => {
    const b = new FixtureBuilder('d')
      .room('A').room('B').room('C').stock('A', { desk: 3 }).stock('C', { desk: 3 }).stock('B', { desk: 100 })
      .group('G1', 'department', 'A').group('G2', 'department', 'C').request('G1', { desk: 4 }).request('G2', { desk: 4 })
      .rule(RULES.restrict('S05', 'G1', ['desk'], ['A']), RULES.restrict('S09', 'G2', ['desk'], ['C']));
    const ix = b.ids();
    const r = fail(allocate(b.input(), await getHighs()));
    expect(r.causes).toHaveLength(1);
    expect(r.causes[0]).toMatchObject({ ruleCode: null, message: COMBINATION_MESSAGE });
    expect(r.causes[0]!.details).toEqual([
      { groupId: ix.groupId('G1'), itemIds: [ix.itemId('desk')], roomIds: [ix.roomId('A')], demand: 4, supply: 3 },
      { groupId: ix.groupId('G2'), itemIds: [ix.itemId('desk')], roomIds: [ix.roomId('C')], demand: 4, supply: 3 },
    ]);
  });

  it('allocate に渡した disabledRuleCodes を診断でも外したままにする：外したルールは原因に出ず、外していない 2 つが原因になる', async () => {
    // G1〜G3 とも A だけから受け取る。A は 6 台、各団体の需要は 4 台。S10 を外しても、まだ G1 と G2 で 8 台あり解けない
    const b = new FixtureBuilder('d')
      .room('A').room('B').stock('A', { desk: 6 }).stock('B', { desk: 10 })
      .group('G1', 'department', 'A').group('G2', 'department', 'A').group('G3', 'department', 'A')
      .request('G1', { desk: 4 }).request('G2', { desk: 4 }).request('G3', { desk: 4 })
      .rule(RULES.restrict('S05', 'G1', ['desk'], ['A']), RULES.restrict('S09', 'G2', ['desk'], ['A']), RULES.restrict('S10', 'G3', ['desk'], ['A']));
    const solver = await getHighs();
    // 外さなければ、どれを 1 つ外しても解けないので組み合わせ
    expect(fail(allocate(b.input(), solver)).causes.map((c) => c.ruleCode)).toEqual([null]);
    const r = fail(allocate(b.input(), solver, { disabledRuleCodes: ['S10'] }));
    expect(r.causes.map((c) => c.ruleCode)).toEqual(['S05', 'S09']);
  });

  it('運び元の制限がなく、団体の候補が狭くて足りない：組み合わせとは言わず、団体つきの不足を shortages に示す', async () => {
    // 屋台 G1（机か不可机）が机 1、部門 G2（机だけ）が机 4。机 3・不可机 10 で、品目全体は足りるが G2 は 3 台しか取れない
    const b = new FixtureBuilder('d')
      .room('A').stock('A', { desk: 3, desk_ng: 10 })
      .group('G1', 'stall', 'A').group('G2', 'department', 'A').request('G1', { desk: 1 }).request('G2', { desk: 4 })
      .rule(RULES.S01());
    const ix = b.ids();
    const r = fail(allocate(b.input(), await getHighs()));
    expect(r.shortages).toEqual([{ requestedItemId: ix.itemId('desk'), groupId: ix.groupId('G2'), demand: 4, supply: 3 }]);
    expect(r.causes).toEqual([{ ruleCode: null, message: STOCK_SHORT_MESSAGE, details: [] }]);
    expect(r.causes.some((c) => c.message === COMBINATION_MESSAGE)).toBe(false);
  });

  it('運び元の制限がなく、代替先の在庫を 2 品目で分け合って足りない（LP だけが Infeasible）：共有する在庫の不足を shortages に示す', async () => {
    // 企業 C の長机(3人掛)は長机(2人掛)で代替できる（S04）。部門 D は長机(2人掛)だけ。長机(2人掛)は 5 台、需要は合わせて 6 台
    const b = new FixtureBuilder('d')
      .room('A').stock('A', { long_desk_2: 5 })
      .group('C', 'company', 'A').group('D', 'department', 'A').request('C', { long_desk_3: 3 }).request('D', { long_desk_2: 3 })
      .rule(RULES.S04());
    const ix = b.ids();
    const r = fail(allocate(b.input(), await getHighs()));
    expect(r.shortages).toEqual([
      { requestedItemId: ix.itemId('long_desk_3'), groupId: null, demand: 6, supply: 5 },
      { requestedItemId: ix.itemId('long_desk_2'), groupId: null, demand: 6, supply: 5 },
    ]);
    expect(r.causes).toEqual([{ ruleCode: null, message: STOCK_SHORT_MESSAGE, details: [] }]);
  });

  it('在庫そのものが足りないときは、どのルールでも解けず causes は空（組み合わせとは言わない）', async () => {
    const b = new FixtureBuilder('d').room('A').stock('A', { desk: 3 }).group('G', 'department', 'A').request('G', { desk: 9 }).rule(RULES.restrict('S05', 'G', ['desk'], ['A']));
    expect(fail(allocate(b.input(), await getHighs())).causes).toEqual([]);
  });

  it('fixed_request が原因：未提出の団体の固定の数を外すと解ける。品目全体の不足も出る（K-26）', async () => {
    const b = new FixtureBuilder('d').room('X').stock('X', { desk: 5 }).group('S', 'department', 'X', { submittedAt: null }).rule(RULES.fixed('S06', 'S', 'desk', 9));
    const ix = b.ids();
    const r = fail(allocate(b.input(), await getHighs()));
    expect(r.shortages[0]).toEqual({ requestedItemId: ix.itemId('desk'), groupId: null, demand: 9, supply: 5 });
    expect(r.causes).toEqual([expect.objectContaining({ ruleCode: 'S06', details: [expect.objectContaining({ demand: 9, supply: 5 })] })]);
  });

  it('keep が原因：申請より多く残すと他の団体の分が足りなくなる', async () => {
    const b = new FixtureBuilder('d').room('X').stock('X', { desk: 5 })
      .group('G', 'department', 'X').group('H', 'department', 'X').request('G', { desk: 3 }).request('H', { desk: 2 })
      .rule(RULES.keep('S08', 'G', 'X', { desk: 5 }));
    const ix = b.ids();
    const r = fail(allocate(b.input(), await getHighs()));
    expect(r.causes).toEqual([
      expect.objectContaining({ ruleCode: 'S08', details: [{ groupId: ix.groupId('G'), itemIds: [ix.itemId('desk')], roomIds: [ix.roomId('X')], demand: 5, supply: 5 }] }),
    ]);
  });

  it('最小変更モードの入力でも全体の実行として診断する', async () => {
    const b = new FixtureBuilder('d').room('A').room('B').stock('A', { desk: 3 }).stock('B', { desk: 10 }).group('G', 'department', 'A').request('G', { desk: 5 }).rule(RULES.restrict('S05', 'G', ['desk'], ['A']));
    const ix = b.ids();
    const input: AllocateInput = {
      ...b.input({ mode: 'minimal_change' }),
      previousRows: [{ sourceRoomId: ix.roomId('B'), groupId: ix.groupId('G'), itemId: ix.itemId('desk'), requestedItemId: ix.itemId('desk'), count: 5, isKeep: false }],
    };
    expect(fail(allocate(input, await getHighs())).causes.map((c) => c.ruleCode)).toEqual(['S05']);
  });
});

describe('diagnose：合成データ r8like', () => {
  const set = loadSet('r8like');
  const { fx, ix, input } = set;

  it('S05 が原因（設営 241、S05 の部屋の合計 235）：shortages に設営・机(木)、causes に S05。解き直しを含めて 2 秒未満', async () => {
    const solver = await getHighs();
    const inf = toAllocateInput(makeInfeasibleS05(fx));
    allocate(inf, solver); // JIT の暖機
    const r = fail(allocate(inf, solver));
    expect(r.shortages).toEqual([{ requestedItemId: ix.itemId('desk'), groupId: ix.groupId('設営'), demand: 241, supply: 235 }]);
    expect(r.causes.map((c) => c.ruleCode)).toEqual(['S05']);
    expect(r.causes[0]!.details).toEqual([expect.objectContaining({ groupId: ix.groupId('設営'), demand: 241, supply: 235 })]);
    expect(r.elapsedMs).toBeLessThan(2000);
  });

  it('申請を在庫より多くすると shortages に品目と不足数が入る。複数の団体で LP が Infeasible になる場合も 2 秒未満', async () => {
    const solver = await getHighs();
    const lectern = ix.itemId('lectern');
    const usable = new Set(input.rooms.filter((r) => r.usable).map((r) => r.id));
    const total = input.stocks.filter((s) => s.itemId === lectern && usable.has(s.roomId)).reduce((a, s) => a + s.count, 0);
    const [g1, g2] = input.groups.filter((g) => g.submittedAt !== null);
    const others = input.requests.filter((r) => r.itemId !== lectern);
    const r = fail(allocate({ ...input, requests: [...others, { groupId: g1!.id, itemId: lectern, count: total - 1 }, { groupId: g2!.id, itemId: lectern, count: total - 1 }] }, solver));
    expect(r.shortages).toEqual([{ requestedItemId: lectern, groupId: null, demand: 2 * total - 2, supply: total }]);
    expect(r.elapsedMs).toBeLessThan(2000);
    const r2 = fail(allocate({ ...input, requests: [...others, { groupId: g1!.id, itemId: lectern, count: total + 3 }] }, solver));
    expect(r2.shortages).toEqual([
      { requestedItemId: lectern, groupId: null, demand: total + 3, supply: total },
      { requestedItemId: lectern, groupId: g1!.id, demand: total + 3, supply: total },
    ]);
  });
});
