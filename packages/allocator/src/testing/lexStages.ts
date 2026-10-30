// 段ごとに LP を解く辞書式の検算（設計 12.1）。①Σc_sub の最小 → ②Σx̂ の最大 → ③Σd の最小 → ④Σp の最大 → ⑤Σe の最小。
// 前の段の値を制約に入れて次の段を解く。係数が大きいときの HiGHS の許容誤差の確認にもなる
import type { AllocationRow } from '@gaapp/shared';
import type { Candidate } from '../candidates';
import { rgijKey } from '../context';
import type { Model } from '../model';
import { varName } from '../lp';
import { HIGHS_OPTIONS, type LpSolver } from '../solve';

type Ready = Extract<Model, { stage: 'ready' }>;

export const LEVELS: ((v: Candidate) => number)[] = [
  (v) => v.cSub,
  (v) => (v.hat ? -1 : 0),
  (v) => v.d,
  (v) => -v.p,
  (v) => v.e,
];

export function solveLexStages(m: Ready, solver: LpSolver): number[] {
  const lines = m.lp.trimEnd().split('\n');
  const st = lines.indexOf('Subject To');
  const bi = lines.indexOf('Bounds') >= 0 ? lines.indexOf('Bounds') : lines.indexOf('End');
  const cons = lines.slice(st + 1, bi);
  const tail = lines.slice(bi);
  const extra: string[] = [];
  const res: number[] = [];
  LEVELS.forEach((f, k) => {
    const terms = m.cands.vars.map((v, n) => [f(v), varName(n)] as const).filter(([c]) => c !== 0);
    if (terms.length === 0) {
      res.push(0);
      return;
    }
    const expr = terms.map(([c, n]) => `${c < 0 ? '-' : '+'} ${Math.abs(c)} ${n}`).join(' ');
    const lp = ['Minimize', ` obj: ${expr}`, 'Subject To', ...cons, ...extra, ...tail].join('\n') + '\n';
    const r = solver.solve(lp, { ...HIGHS_OPTIONS });
    if (r.Status !== 'Optimal') throw new Error(`段 ${k + 1} が ${r.Status}`);
    const val = Math.round(r.ObjectiveValue);
    res.push(val);
    extra.push(` l${k + 1}: ${expr} <= ${val}`);
  });
  return res;
}

/**
 * allocate の rows（残すの行を含む）から5段の値を計算する。残すの行を引いた LP の部分の数を (r,g,i,j) ごとに求め、
 * 候補の d・e・p・c_sub を掛ける。②は x̂ を上限まで先に使う（x̂ は同じキーの x より必ず安い）として min(数, 上限)。
 */
export function lexValuesOfRows(m: Ready, rows: readonly AllocationRow[]): number[] {
  const count = new Map<string, number>();
  for (const r of rows) {
    const k = rgijKey(r.sourceRoomId, r.groupId, r.requestedItemId, r.itemId);
    count.set(k, (count.get(k) ?? 0) + r.count);
  }
  for (const r of m.prepared.keepRows) {
    const k = rgijKey(r.sourceRoomId, r.groupId, r.requestedItemId, r.itemId);
    count.set(k, (count.get(k) ?? 0) - r.count);
  }
  const res = [0, 0, 0, 0, 0];
  const seen = new Set<string>();
  for (const v of m.cands.vars) {
    const k = rgijKey(v.r, v.g, v.i, v.j);
    const c = count.get(k) ?? 0;
    if (v.hat) {
      res[1]! -= Math.min(c, v.ub!);
      continue;
    }
    if (seen.has(k)) throw new Error(`同じキーの x が2つあります ${k}`);
    seen.add(k);
    res[0]! += v.cSub * c;
    res[2]! += v.d * c;
    res[3]! -= v.p * c;
    res[4]! += v.e * c;
  }
  for (const [k, c] of count) if (c !== 0 && !seen.has(k)) throw new Error(`候補にない行 ${k}`);
  return res;
}
