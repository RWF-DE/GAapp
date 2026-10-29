import { describe, expect, it } from 'vitest';
import type { AllocateInput } from '@gaapp/shared';
import { FixtureBuilder, RULES } from '@gaapp/shared/testing';
import { allocate } from './allocate';
import type { LpSolver } from './solve';
import { getHighs } from './testing/getHighs';

const base = () =>
  new FixtureBuilder('alloc')
    .room('X', { building: 'A' })
    .room('Y', { building: 'B' })
    .group('G', 'stall', 'X')
    .group('H', 'stall', 'Y')
    .stock('X', { desk: 4 })
    .request('G', { desk: 3 });

describe('allocate：ok: false の形（設計 9 章、D-25）', () => {
  it('invalid_input：zod の誤り（path つき）', async () => {
    const input = base().input();
    const res = allocate({ ...input, rooms: input.rooms.map((r) => ({ ...r, extraCost: 21 })) }, await getHighs());
    expect(res).toMatchObject({ ok: false, reason: 'invalid_input', message: '入力に誤りがあります' });
    expect(!res.ok && res.inputErrors.map((e) => e.path)).toEqual(['rooms.0.extraCost', 'rooms.1.extraCost']);
    const noKey = allocate({ ...input, extra: 1 } as AllocateInput, await getHighs());
    expect(noKey).toMatchObject({ ok: false, reason: 'invalid_input' });
  });

  it('invalid_input：知らない id、同じ場所・品目の在庫の行が2つ、full で前回の行がある、ルールの参照先がない', async () => {
    const solver = await getHighs();
    const b = base();
    const ix = b.ids();
    const input = b.input();
    const unknown = '00000000-0000-4000-8000-000000000099';
    const paths = (x: unknown) => {
      const r = allocate(x as AllocateInput, solver);
      return !r.ok && r.reason === 'invalid_input' ? r.inputErrors.map((e) => e.path) : r;
    };
    expect(paths({ ...input, requests: [...input.requests, { groupId: unknown, itemId: ix.itemId('desk'), count: 1 }] })).toEqual([
      `requests.${input.requests.length}.groupId`,
    ]);
    expect(paths({ ...input, stocks: [...input.stocks, input.stocks[0]!] })).toEqual([`stocks.${input.stocks.length}`]);
    const prev = { sourceRoomId: ix.roomId('X'), groupId: ix.groupId('G'), itemId: ix.itemId('desk'), requestedItemId: ix.itemId('desk'), count: 1, isKeep: true };
    expect(paths({ ...input, previousRows: [prev] })).toEqual(['previousRows']);
    const withRule = b.rule(RULES.fixed('S06', 'G', 'desk', 2)).input();
    const r = allocate({ ...withRule, rules: withRule.rules.map((x) => (x.kind === 'fixed_request' ? { ...x, params: { ...x.params, group: unknown } } : x)) }, solver);
    expect(r).toMatchObject({ ok: false, reason: 'invalid_input', inputErrors: [{ path: 'rules.S06.params.group', ruleCode: 'S06' }] });
  });

  it('infeasible（前処理7）：候補の在庫が足りない団体を shortages に入れ、LP を作らない', async () => {
    let called = 0;
    const solver: LpSolver = { solve: (...a) => (called++, (globalThis as unknown as { _h: LpSolver })._h.solve(...a)) };
    (globalThis as unknown as { _h: LpSolver })._h = await getHighs();
    const b = base().request('H', { lectern: 2 });
    const ix = b.ids();
    const res = allocate(b.input(), solver);
    expect(res).toMatchObject({
      ok: false,
      reason: 'infeasible',
      message: '解けません',
      shortages: [
        { requestedItemId: ix.itemId('lectern'), groupId: null, demand: 2, supply: 0 },
        { requestedItemId: ix.itemId('lectern'), groupId: ix.groupId('H'), demand: 2, supply: 0 },
      ],
      causes: [],
    });
    expect(called).toBe(0);
  });

  it('infeasible（HiGHS が Infeasible）：1つずつの需要には候補が足りるが、合わせると足りない', async () => {
    const b = base().request('H', { desk: 3 });
    const res = allocate(b.input(), await getHighs());
    // 品目全体では 6 台の需要に在庫 4 台（団体ごとの不足はない）
    expect(res).toMatchObject({ ok: false, reason: 'infeasible', shortages: [{ groupId: null, demand: 6, supply: 4 }], causes: [], stats: { solverStatus: 'Infeasible' } });
  });

  it('solver_error：Optimal 以外・自己検算の不一致', () => {
    const input = base().input();
    const s = (res: unknown): LpSolver => ({ solve: () => res as ReturnType<LpSolver['solve']> });
    expect(allocate(input, s({ Status: 'Time limit reached', ObjectiveValue: 0, Columns: {} }))).toMatchObject({
      ok: false, reason: 'solver_error', message: expect.stringContaining('Time limit reached') });
    // 需要 3 に対して 0 を返す（整数・Optimal だが需要の行が合わない）
    expect(allocate(input, s({ Status: 'Optimal', ObjectiveValue: 0, Columns: { x1: { Primal: 0 } } }))).toMatchObject({
      ok: false, reason: 'solver_error', message: expect.stringContaining('検算') });
  });

  it('需要がなければ solver を呼ばずに残すの行だけを返す', () => {
    const b = new FixtureBuilder('alloc').room('X').group('G', 'department', 'X').stock('X', { desk: 4 }).rule(RULES.keep('S08', 'G', 'X', { desk: 2 }));
    const solver: LpSolver = { solve: () => { throw new Error('呼ばない'); } };
    const res = allocate(b.input(), solver);
    expect(res).toMatchObject({ ok: true, objective: 0, rows: [{ count: 2, isKeep: true }], stats: { solverStatus: 'not_called' } });
  });

  it('ok: true の stats', async () => {
    const res = allocate(base().input(), await getHighs());
    expect(res).toMatchObject({ ok: true, stats: { variables: 1, hatVariables: 0, demandRows: 1, supplyRows: 1, demandUnits: 3, solverStatus: 'Optimal', excludedRequests: 0 } });
  });
});
