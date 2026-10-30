// 係数（03「目的関数」、設計 6.2）。辞書式の優先順位（代替 → 前回を保つ台数 → 距離 → 休憩所への不可椅子 → 残す）を
// 入力の大きさから決めた整数の倍率で必ず守る
import type { AllocateInput } from '@gaapp/shared';
import type { Candidate, DemandRow } from './candidates';

export type Weights = {
  /** LP の需要の行の数 */
  K: number;
  /** p = 1 の変数を持つ需要の行の数 */
  P: number;
  dMax: number;
  A: number;
  B: number;
  U: number;
  mu: number;
  W: number;
};

export class ScaleError extends Error {}

export function computeWeights(
  vars: readonly Candidate[],
  demandRows: readonly DemandRow[],
  mode: AllocateInput['mode'],
): { weights: Weights; coef: number[] } {
  const K = demandRows.length;
  const P = demandRows.filter((row) => row.vars.some((n) => vars[n]!.p === 1)).length;
  const dMax = vars.reduce((a, v) => Math.max(a, v.d), 1);
  const B = K + 1;
  const A = B * P + K + 1;
  const U = A * dMax + B + 1;
  const mu = mode === 'minimal_change' ? K * U + 1 : 0;
  const W = K * (U + mu) + 1;
  const coef = vars.map((v) => W * v.cSub + A * v.d + v.e - B * v.p - (v.hat ? mu : 0));
  // 規模の確認：最大の係数 × 需要の合計が 2^53 を超えたら、整数の比べ方が崩れうるので止める
  const maxCoef = coef.reduce((a, c) => Math.max(a, Math.abs(c)), 0);
  const units = demandRows.reduce((a, row) => a + row.demand, 0);
  for (const x of [B, A, U, mu, W, maxCoef, maxCoef * units]) {
    if (!Number.isSafeInteger(x)) {
      throw new ScaleError(`係数が大きすぎます（最大の係数 ${maxCoef} × 需要の合計 ${units} が 2^53 を超える）`);
    }
  }
  return { weights: { K, P, dMax, A, B, U, mu, W }, coef };
}
