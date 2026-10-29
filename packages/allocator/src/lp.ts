// CPLEX LP 形式の文字列（設計 8 章）。変数名は作った順の連番（x1、x2、…。x̂ も同じ通し番号）。整数だけを書き、折り返さない
import type { Candidates } from './candidates';

export const varName = (n: number) => `x${n + 1}`;

export function writeLp(cands: Candidates, coef: readonly number[]): string {
  const term = (c: number, n: number) => `${c < 0 ? '-' : '+'} ${Math.abs(c)} ${varName(n)}`;
  const lines: string[] = ['Minimize', ` obj: ${coef.map((c, n) => term(c, n)).join(' ')}`, 'Subject To'];
  cands.supplyRows.forEach((row, k) => {
    lines.push(` s${k + 1}: ${row.vars.map((n) => `+ ${varName(n)}`).join(' ')} <= ${row.supply}`);
  });
  cands.demandRows.forEach((row, k) => {
    lines.push(` d${k + 1}: ${row.vars.map((n) => `+ ${varName(n)}`).join(' ')} = ${row.demand}`);
  });
  const bounded = cands.vars.map((v, n) => [v, n] as const).filter(([v]) => v.ub !== null);
  if (bounded.length > 0) {
    lines.push('Bounds');
    for (const [v, n] of bounded) lines.push(` ${varName(n)} <= ${v.ub}`);
  }
  lines.push('End');
  return lines.join('\n') + '\n';
}
