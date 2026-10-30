// allocate() の全体の流れ（設計 4 章）
import type { AllocateFailureReason, AllocateInput, AllocateResult, AllocateStats, Cause, InputError, Issue, Shortage } from '@gaapp/shared';
import { diagnose, DIAGNOSE_PENDING_MESSAGE } from './diagnose';
import { buildModel, type BuildModelOptions, type Model } from './model';
import { toRows } from './rows';
import { runSolver, type LpSolver } from './solve';

const now = () => performance.now();

export const FAILURE_MESSAGES: Record<AllocateFailureReason, string> = {
  invalid_input: '入力に誤りがあります',
  precheck: '振り分けの前に直すものがあります',
  infeasible: DIAGNOSE_PENDING_MESSAGE,
  solver_error: '計算できませんでした',
};

function statsOf(m: Model, buildMs: number, solveMs = 0, solverStatus = ''): Partial<AllocateStats> {
  if (m.stage === 'invalid_input') return { buildMs };
  const base: Partial<AllocateStats> = { excludedRequests: m.prepared.excluded.length, buildMs, solveMs, solverStatus };
  if (m.stage === 'precheck') return base;
  const vars = m.cands.vars;
  Object.assign(base, {
    variables: vars.length,
    hatVariables: vars.filter((v) => v.hat).length,
    supplyRows: m.cands.supplyRows.length,
    demandRows: m.cands.demandRows.length,
    demandUnits: m.cands.demandRows.reduce((a, r) => a + r.demand, 0),
  });
  if (m.stage === 'empty') Object.assign(base, { dMax: 0, weights: { W: 0, mu: 0, A: 0, B: 0 }, lpChars: 0 });
  if (m.stage === 'ready') {
    Object.assign(base, {
      dMax: m.weights.dMax,
      weights: { W: m.weights.W, mu: m.weights.mu, A: m.weights.A, B: m.weights.B },
      lpChars: m.lp.length,
    });
  }
  return base;
}

function fail(
  reason: AllocateFailureReason,
  t0: number,
  extra: { message?: string; inputErrors?: InputError[]; issues?: Issue[]; shortages?: Shortage[]; causes?: Cause[]; stats?: Partial<AllocateStats> },
): AllocateResult {
  return {
    ok: false,
    reason,
    message: extra.message ?? FAILURE_MESSAGES[reason],
    inputErrors: extra.inputErrors ?? [],
    issues: extra.issues ?? [],
    shortages: extra.shortages ?? [],
    causes: extra.causes ?? [],
    elapsedMs: now() - t0,
    ...(extra.stats ? { stats: extra.stats } : {}),
  };
}

/**
 * 振り分けを計算する（同期）。solver は highs の読み込んだインスタンス（呼ぶ側が渡す）。
 * rows は固定行を含まず、残すの行を含む。
 */
export function allocate(input: AllocateInput, solver: LpSolver, opts: BuildModelOptions = {}): AllocateResult {
  const t0 = now();
  let m: Model;
  try {
    m = buildModel(input, opts);
  } catch (err) {
    return fail('solver_error', t0, { message: `計算の準備中に予期しないエラーが起きました（${String(err)}）` });
  }
  const buildMs = now() - t0;
  switch (m.stage) {
    case 'invalid_input':
      return fail('invalid_input', t0, { inputErrors: m.inputErrors, stats: statsOf(m, buildMs) });
    case 'precheck':
      return fail('precheck', t0, { issues: m.prepared.issues, stats: statsOf(m, buildMs) });
    case 'shortage': {
      const d = diagnose(m.ctx.input, solver, m.cands.shortages);
      return fail('infeasible', t0, { shortages: d.shortages, causes: d.causes, stats: statsOf(m, buildMs) });
    }
    case 'scale_error':
      return fail('solver_error', t0, { message: m.message, stats: statsOf(m, buildMs) });
    case 'empty':
      return {
        ok: true,
        rows: toRows(m.ctx, [], [], m.prepared.keepRows),
        objective: 0,
        elapsedMs: now() - t0,
        stats: statsOf(m, buildMs, 0, 'not_called') as AllocateStats,
      };
    case 'ready':
      break;
  }
  const t1 = now();
  const out = runSolver(solver, m.lp, m.names);
  const solveMs = now() - t1;
  if (out.status === 'infeasible') {
    const d = diagnose(m.ctx.input, solver, []);
    return fail('infeasible', t0, {
      shortages: d.shortages,
      causes: d.causes,
      stats: statsOf(m, buildMs, solveMs, out.solverStatus),
    });
  }
  if (out.status === 'error') {
    return fail('solver_error', t0, { message: out.message, stats: statsOf(m, buildMs, solveMs, out.solverStatus) });
  }
  // 自己検算（バグの検出）：需要の行ごとに D′ と等しく、在庫の行ごとに S′ 以下、x̂ は上限以下
  const v = out.values;
  const bad =
    m.cands.demandRows.find((row) => row.vars.reduce((a, n) => a + v[n]!, 0) !== row.demand)?.key ??
    m.cands.supplyRows.find((row) => row.vars.reduce((a, n) => a + v[n]!, 0) > row.supply)?.key ??
    (m.cands.vars.some((c, n) => c.ub !== null && v[n]! > c.ub) ? 'x̂ の上限' : undefined);
  if (bad !== undefined) {
    return fail('solver_error', t0, {
      message: `計算結果の検算が合いません（${bad}）`,
      stats: statsOf(m, buildMs, solveMs, out.solverStatus),
    });
  }
  return {
    ok: true,
    rows: toRows(m.ctx, m.cands.vars, v, m.prepared.keepRows),
    objective: out.objective,
    elapsedMs: now() - t0,
    stats: statsOf(m, buildMs, solveMs, out.solverStatus) as AllocateStats,
  };
}
