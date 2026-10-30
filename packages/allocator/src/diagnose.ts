// 解けないときの診断（設計 9 章）。T06 は形と呼び出しだけを決め、中身（品目全体の不足、ルールを外した解き直し）は T07 が埋める
import type { AllocateInput, Cause, Shortage } from '@gaapp/shared';
import type { LpSolver } from './solve';

export type Diagnosis = { shortages: Shortage[]; causes: Cause[] };

export const DIAGNOSE_PENDING_MESSAGE = '解けません（不足の内訳は未実装）';

/**
 * @param found 前処理7で見つけた団体つきの不足（LP が Infeasible のときは []）
 */
export function diagnose(_input: AllocateInput, _solver: LpSolver, found: readonly Shortage[]): Diagnosis {
  void _input;
  void _solver;
  return { shortages: [...found], causes: [] };
}
