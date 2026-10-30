import { describe, expect, expectTypeOf, it } from 'vitest';
import loadHighs from 'highs';
import { runSolver, type LpSolver } from './solve';

const fake = (res: unknown | (() => unknown)): LpSolver => ({
  solve: () => (typeof res === 'function' ? (res as () => unknown)() : res) as ReturnType<LpSolver['solve']>,
});
const ok = (cols: Record<string, unknown>) => ({ Status: 'Optimal', ObjectiveValue: 0, Columns: cols });

describe('runSolver（03「決定性」）', () => {
  it.each(['Time limit reached', 'Unbounded', 'Unknown', 'Model error'])('%s → error', (s) => {
    expect(runSolver(fake({ Status: s, ObjectiveValue: 0, Columns: {} }), '', ['x1']).status).toBe('error');
  });
  it.each(['Infeasible', 'Primal infeasible or unbounded'])('%s → infeasible', (s) => {
    expect(runSolver(fake({ Status: s, ObjectiveValue: 0, Columns: {} }), '', ['x1']).status).toBe('infeasible');
  });
  it('整数でない値・列がない・Primal が数でない・NaN・負 → error', () => {
    expect(runSolver(fake(ok({ x1: { Primal: 0.5 } })), '', ['x1']).status).toBe('error');
    expect(runSolver(fake(ok({})), '', ['x1']).status).toBe('error');
    expect(runSolver(fake(ok({ x1: { Primal: '1' } })), '', ['x1']).status).toBe('error');
    expect(runSolver(fake(ok({ x1: { Primal: Number.NaN } })), '', ['x1']).status).toBe('error');
    expect(runSolver(fake(ok({ x1: null })), '', ['x1']).status).toBe('error');
    expect(runSolver(fake(ok({ x1: { Primal: -1 } })), '', ['x1']).status).toBe('error');
  });
  it('例外 → error', () => {
    const r = runSolver(fake(() => { throw new Error('boom'); }), '', ['x1']);
    expect(r).toMatchObject({ status: 'error', message: expect.stringContaining('boom') });
  });
  it('1e-6 以内のずれは丸める', () => {
    expect(runSolver(fake(ok({ x1: { Primal: 2.0000000001 }, x2: { Primal: 0 } })), '', ['x1', 'x2'])).toMatchObject({
      status: 'optimal',
      values: [2, 0],
    });
  });
  it('オプションは呼ぶたびに新しいオブジェクト', () => {
    const seen: unknown[] = [];
    const s: LpSolver = { solve: (_p, o) => (seen.push(o), ok({})) };
    runSolver(s, '', []);
    runSolver(s, '', []);
    expect(seen[0]).not.toBe(seen[1]);
    expect(seen[0]).toEqual({ solver: 'simplex', random_seed: 0, time_limit: 30, output_flag: false });
  });
  it('型：highs の Highs を LpSolver に代入できる（Columns は Record<string, unknown>）', async () => {
    const s: LpSolver = await loadHighs();
    expectTypeOf(s).toExtend<LpSolver>();
    const r = runSolver(s, 'Minimize\n obj: + 1 x1\nSubject To\n c1: + x1 >= 2\nEnd\n', ['x1']);
    expect(r).toMatchObject({ status: 'optimal', values: [2] });
  });
});
