import loadHighs from 'highs';
export type LpSolver = {
  solve(problem: string, options?: Record<string, unknown>): {
    Status: string; ObjectiveValue: number; Columns: Record<string, unknown> };
};
const s: LpSolver = await loadHighs();
console.log(typeof s);
