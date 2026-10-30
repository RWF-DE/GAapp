// highs の呼び出しと結果の確かめ（03「決定性」、設計 2.4・6.4）
/**
 * highs の `Highs` の部分の形。allocator は highs を import しない（呼ぶ側が読み込んで渡す）。
 * Columns の中身は実行時に確かめる（Infeasible の解の列は Primal を持たないので、型では絞らない）。
 */
export type LpSolver = {
  solve(
    problem: string,
    options?: Record<string, unknown>,
  ): { Status: string; ObjectiveValue: number; Columns: Record<string, unknown> };
};

/** HiGHS のオプション（固定）。呼ぶたびに新しいオブジェクトを渡す */
export const HIGHS_OPTIONS = Object.freeze({
  solver: 'simplex',
  random_seed: 0,
  time_limit: 30,
  output_flag: false,
} as const);

export const INFEASIBLE_STATUSES = ['Infeasible', 'Primal infeasible or unbounded'] as const;
/** 整数からのずれの許容 */
export const INTEGRALITY_TOLERANCE = 1e-6;

export type SolverOutcome =
  | { status: 'optimal'; values: number[]; objective: number; solverStatus: string }
  | { status: 'infeasible'; solverStatus: string }
  | { status: 'error'; message: string; solverStatus: string };

export function runSolver(solver: LpSolver, lp: string, names: readonly string[]): SolverOutcome {
  let res: ReturnType<LpSolver['solve']>;
  try {
    res = solver.solve(lp, { ...HIGHS_OPTIONS });
  } catch (err) {
    return { status: 'error', message: `計算エンジンでエラーが起きました（${String(err)}）`, solverStatus: 'exception' };
  }
  const status = String(res?.Status);
  if ((INFEASIBLE_STATUSES as readonly string[]).includes(status)) return { status: 'infeasible', solverStatus: status };
  if (status !== 'Optimal') {
    return { status: 'error', message: `計算エンジンが最適解を返しませんでした（状態：${status}）`, solverStatus: status };
  }
  const values: number[] = [];
  for (const name of names) {
    const col: unknown = res.Columns?.[name];
    const primal =
      typeof col === 'object' && col !== null && 'Primal' in col ? (col as { Primal: unknown }).Primal : undefined;
    if (typeof primal !== 'number' || !Number.isFinite(primal)) {
      return { status: 'error', message: `計算エンジンの結果に変数 ${name} の値がありません`, solverStatus: status };
    }
    const rounded = Math.round(primal);
    if (Math.abs(primal - rounded) > INTEGRALITY_TOLERANCE) {
      return { status: 'error', message: `計算エンジンの結果が整数ではありません（${name} = ${primal}）`, solverStatus: status };
    }
    if (rounded < 0) {
      return { status: 'error', message: `計算エンジンの結果が負です（${name} = ${primal}）`, solverStatus: status };
    }
    values.push(rounded);
  }
  return { status: 'optimal', values, objective: res.ObjectiveValue, solverStatus: status };
}
