// 係数（設計 6.2・6.3、12.1）：不等式、規模の上限、総当たり、段ごとの検算
import { describe, expect, it } from 'vitest';
import type { AllocateInput } from '@gaapp/shared';
import { allocate } from './allocate';
import type { Candidate, DemandRow } from './candidates';
import { writeLp } from './lp';
import { buildModel, type Model } from './model';
import { runSolver } from './solve';
import { bruteForceLexMin, bruteInput, lexKey, lexLess } from './testing/brute';
import { hasR8, loadSet } from './testing/fixtureSets';
import { getHighs } from './testing/getHighs';
import { lexValuesOfRows, solveLexStages } from './testing/lexStages';
import { computeWeights, ScaleError } from './weights';

type Ready = Extract<Model, { stage: 'ready' }>;
const ready = (input: AllocateInput): Ready => {
  const m = buildModel(input);
  if (m.stage !== 'ready') throw new Error(m.stage);
  return m;
};
const unusable = (input: AllocateInput, roomId: string): AllocateInput => ({
  ...input,
  rooms: input.rooms.map((r) => (r.id === roomId ? { ...r, usable: false } : r)),
});

describe('computeWeights', () => {
  it('B > K、A > B·P + K、μ > K·U、W > K·(U + μ)。係数は整数', async () => {
    const set = loadSet('r8like');
    const full = allocate(set.input, await getHighs());
    if (!full.ok) throw new Error(full.reason);
    const mer = set.ix.roomId('MER');
    for (const m of [ready(set.input), ready({ ...unusable(set.input, mer), mode: 'minimal_change', previousRows: full.rows })]) {
      const { K, P, A, B, U, mu, W, dMax } = m.weights;
      expect(B).toBeGreaterThan(K);
      expect(A).toBeGreaterThan(B * P + K);
      expect(U).toBeGreaterThan(A * dMax + B);
      if (m.ctx.mode === 'minimal_change') expect(mu).toBeGreaterThan(K * U);
      else expect(mu).toBe(0);
      expect(W).toBeGreaterThan(K * (U + mu));
      expect(m.coef.every(Number.isSafeInteger)).toBe(true);
    }
  });

  it('規模の上限：最大の係数 × 需要の合計が 2^53 を超えたら ScaleError（buildModel は scale_error、allocate は solver_error）', () => {
    const K = 200_000;
    const vars: Candidate[] = Array.from({ length: K }, (_, n) => ({ r: 'r', g: `g${n}`, i: 'i', j: 'j', hat: n === 0, ub: n === 0 ? 1 : null, d: 40, e: 1, p: 0, cSub: 10 }));
    const rows: DemandRow[] = vars.map((v, n) => ({ key: v.g, g: v.g, i: 'i', demand: 10_000, vars: [n] }));
    expect(() => computeWeights(vars, rows, 'minimal_change')).toThrow(ScaleError);
    expect(() => computeWeights(vars.slice(0, 10), rows.slice(0, 10), 'minimal_change')).not.toThrow();
  });
});

describe('総当たり：LP の解の辞書式の値が、全整数解の辞書式の最小と一致する（設計 6.3・12.5）', () => {
  it(
    'シード 1 から、列挙できた入力が 200 通りになるまで（full と minimal_change）',
    async () => {
      const solver = await getHighs();
      let checked = 0;
      let mc = 0;
      let skipped = 0;
      let infeasible = 0;
      for (let seed = 1; checked < 200 && seed <= 1200; seed++) {
        const m = buildModel(bruteInput(seed));
        if (m.stage === 'shortage' || m.stage === 'empty') {
          skipped++;
          continue;
        }
        if (m.stage !== 'ready') throw new Error(`seed ${seed}: ${m.stage}`);
        if (m.cands.vars.length > 14) {
          skipped++;
          continue;
        }
        const best = bruteForceLexMin(m.cands);
        const out = runSolver(solver, m.lp, m.names);
        if (best === null) {
          expect(out.status, `seed ${seed}`).toBe('infeasible');
          infeasible++;
          continue;
        }
        expect(out.status, `seed ${seed}`).toBe('optimal');
        if (out.status !== 'optimal') continue;
        expect(lexKey(m.cands.vars, out.values), `seed ${seed}`).toEqual(best);
        checked++;
        if (m.ctx.mode === 'minimal_change') mc++;
      }
      expect(checked).toBe(200);
      expect(mc).toBeGreaterThan(50);
      console.info(`[総当たり] 一致 ${checked}（うち最小変更 ${mc}）、解けない ${infeasible}、飛ばした ${skipped}`);
    },
    120_000,
  );

  it('1台ぶんの μ（d_max ＋ 1 相当）では、シード 10・666・932 で前回の1台を手放す解になる（辞書式の μ にした理由）', async () => {
    const solver = await getHighs();
    for (const seed of [10, 666, 932]) {
      const m = ready(bruteInput(seed));
      const best = bruteForceLexMin(m.cands)!;
      const { K, A, B, U, dMax } = m.weights;
      const mu = A * dMax + B + 2;
      const W = K * (U + mu) + 1;
      const coef = m.cands.vars.map((v) => W * v.cSub + A * v.d + v.e - B * v.p - (v.hat ? mu : 0));
      const out = runSolver(solver, writeLp(m.cands, coef), m.names);
      if (out.status !== 'optimal') throw new Error(out.status);
      const unit = lexKey(m.cands.vars, out.values);
      expect(lexLess(best, unit), `seed ${seed}`).toBe(true);
      // 辞書式の μ（allocate の係数）なら一致する
      const lex = runSolver(solver, m.lp, m.names);
      expect(lex.status === 'optimal' && lexKey(m.cands.vars, lex.values), `seed ${seed}`).toEqual(best);
    }
  });
});

describe('段ごとの検算（R8 規模。係数が大きいときの HiGHS の許容誤差の確認）', () => {
  const sets = [loadSet('r8like'), ...(hasR8() ? [loadSet('r8')] : [])];
  it.each(sets)(
    '$label：full と、$minimalChangeRoom を使用不可にした minimal_change',
    async (set) => {
      const solver = await getHighs();
      const M = set.ix.roomId(set.minimalChangeRoom);
      const base = { ...set.input, rooms: set.input.rooms.map((r) => (r.id === M ? { ...r, usable: true } : r)) };
      const full = allocate(base, solver);
      if (!full.ok) throw new Error(full.reason);
      const mFull = ready(base);
      expect(lexValuesOfRows(mFull, full.rows)).toEqual(solveLexStages(mFull, solver));
      const mcInput: AllocateInput = { ...unusable(base, M), mode: 'minimal_change', previousRows: full.rows };
      const mc = allocate(mcInput, solver);
      if (!mc.ok) throw new Error(mc.reason);
      const mMc = ready(mcInput);
      const staged = solveLexStages(mMc, solver);
      expect(lexValuesOfRows(mMc, mc.rows)).toEqual(staged);
      expect(staged[1]).toBeLessThan(0);
      console.info(`[${set.label}] 段の値 full ${JSON.stringify(lexValuesOfRows(mFull, full.rows))}、minimal_change ${JSON.stringify(staged)}、最大の係数 ${Math.max(...mMc.coef.map(Math.abs))}`);
    },
    60_000,
  );
});
