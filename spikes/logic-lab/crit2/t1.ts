import loadHighs from 'highs';
export type LpSolverBad = {
  solve(problem: string, options?: Record<string, unknown>): {
    Status: string; ObjectiveValue: number; Columns: Record<string, { Primal?: number }> };
};
const s: LpSolverBad = await loadHighs();
console.log(typeof s);
