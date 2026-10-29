// 解けないときの診断（03「解けないときの扱い」、設計 9 章）
import { giKey, type AllocateInput, type Cause, type Item, type Rule, type Shortage } from '@gaapp/shared';
import type { Ctx } from './context';
import { rjKey } from './context';
import { buildModel, type Model } from './model';
import type { Prepared } from './prepare';
import { allowedSources, substituteOptions } from './rules';
import { runSolver, type LpSolver } from './solve';

export type Diagnosis = { shortages: Shortage[]; causes: Cause[] };

export const INFEASIBLE_MESSAGE = '解けません';
export const COMBINATION_MESSAGE = '複数の条件の組み合わせが原因です';

/** 試すのは source_restrict・keep・fixed_request（代替ルールは外しても解けるようにならない。K-26） */
type Detail = Cause['details'][number];

/** 全体の実行として調べる（x̂ は上限つきの複製で、解けるかどうかに関係しない） */
const asFull = (input: AllocateInput): AllocateInput => ({ ...input, mode: 'full', previousRows: [] });

/** 外したルールで前処理 1〜7 からやり直し、前処理で止まらず、前処理 7 の不足も出ず、HiGHS が Optimal を返したら解けた */
function solvesWithout(input: AllocateInput, solver: LpSolver, code: string): boolean {
  const m = buildModel(input, { disabledRuleCodes: [code] });
  if (m.stage === 'empty') return true;
  if (m.stage !== 'ready') return false;
  return runSolver(solver, m.lp, m.names).status === 'optimal';
}

/** 団体 g・申請品目 i の候補の品目 J(g,i) と運び元の制限の下での、S′ の合計と対象の場所 */
function supplyOf(ctx: Ctx, prepared: Prepared, groupId: string, item: Item): { supply: number; roomIds: string[] } {
  const g = ctx.groupById.get(groupId)!;
  const allowed = allowedSources(ctx, g, item);
  const js = substituteOptions(ctx, g, item).map((o) => o.j);
  const rooms = ctx.rooms.filter((r) => allowed === null || allowed.has(r.id));
  let supply = 0;
  for (const r of rooms) for (const j of js) supply += prepared.supply.get(rjKey(r.id, j)) ?? 0;
  return { supply, roomIds: rooms.map((r) => r.id) };
}

/** 1. 申請品目ごとの、品目全体の不足（需要の合計 ΣD′ と、候補の品目の在庫の合計 ΣS′） */
function itemShortages(ctx: Ctx, prepared: Prepared): Shortage[] {
  const out: Shortage[] = [];
  for (const it of ctx.items) {
    let demand = 0;
    const js = new Set<string>();
    for (const g of ctx.groups) {
      const d = prepared.demand.get(giKey(g.id, it.id)) ?? 0;
      if (d <= 0) continue;
      demand += d;
      for (const o of substituteOptions(ctx, g, it)) js.add(o.j);
    }
    if (demand === 0) continue;
    let supply = 0;
    for (const j of js) for (const r of ctx.rooms) supply += prepared.supply.get(rjKey(r.id, j)) ?? 0;
    if (demand > supply) out.push({ requestedItemId: it.id, groupId: null, demand, supply });
  }
  return out;
}

/** 運び元の制限の対象（団体・申請品目）ごとの需要 D′ と、指定した場所の在庫合計 */
function restrictDetails(ctx: Ctx, prepared: Prepared, rule: Extract<Rule, { kind: 'source_restrict' }>): Detail[] {
  const out: Detail[] = [];
  for (const code of rule.params.items) {
    const itemId = ctx.itemIdByCode.get(code);
    if (itemId === undefined) continue;
    const demand = prepared.demand.get(giKey(rule.params.group, itemId)) ?? 0;
    if (demand <= 0) continue;
    const { supply, roomIds } = supplyOf(ctx, prepared, rule.params.group, ctx.itemById.get(itemId)!);
    out.push({ groupId: rule.params.group, itemIds: [itemId], roomIds, demand, supply });
  }
  return out;
}

function causeOf(ctx: Ctx, prepared: Prepared, rule: Exclude<Rule, { kind: 'substitute' }>): Cause {
  const gName = ctx.groupById.get(rule.params.group)?.name ?? '';
  if (rule.kind === 'source_restrict') {
    const all = restrictDetails(ctx, prepared, rule);
    const short = all.filter((d) => d.supply! < d.demand!);
    return {
      ruleCode: rule.code,
      message: `ルール ${rule.code}（運び元の制限：${gName}）を外すと解けます`,
      details: short.length > 0 ? short : all,
    };
  }
  if (rule.kind === 'fixed_request') {
    const itemId = ctx.itemIdByCode.get(rule.params.item)!;
    const { supply, roomIds } = supplyOf(ctx, prepared, rule.params.group, ctx.itemById.get(itemId)!);
    return {
      ruleCode: rule.code,
      message: `ルール ${rule.code}（固定の申請：${gName}の${ctx.itemById.get(itemId)!.name} ${rule.params.count}台）を外すと解けます`,
      details: [{ groupId: rule.params.group, itemIds: [itemId], roomIds, demand: rule.params.count, supply }],
    };
  }
  // keep
  const roomId = rule.params.room;
  const details: Detail[] = [];
  for (const it of ctx.items) {
    const n = rule.params.items[it.code];
    if (n === undefined) continue;
    details.push({ groupId: rule.params.group, itemIds: [it.id], roomIds: [roomId], demand: n, supply: ctx.stock.get(rjKey(roomId, it.id)) ?? 0 });
  }
  return {
    ruleCode: rule.code,
    message: `ルール ${rule.code}（残す：${gName}）を外すと解けます`,
    details,
  };
}

/** 3. 運び元の制限の対象ごとの需要とその場所の在庫合計（(団体・申請品目) ごとに1つ。制限が重なるときは共通部分） */
function combinationCause(ctx: Ctx, prepared: Prepared): Cause {
  const seen = new Set<string>();
  const details: Detail[] = [];
  for (const rule of ctx.rules) {
    if (rule.kind !== 'source_restrict') continue;
    for (const d of restrictDetails(ctx, prepared, rule)) {
      const k = giKey(d.groupId!, d.itemIds![0]!);
      if (seen.has(k)) continue;
      seen.add(k);
      details.push(d);
    }
  }
  return { ruleCode: null, message: COMBINATION_MESSAGE, details };
}

/**
 * @param found 前処理7で見つけた団体つきの不足（LP が Infeasible のときは []）
 * @returns shortages は品目全体の不足 → found（団体つき）の順。解き直しは同じ solver で続けて行う
 */
export function diagnose(input: AllocateInput, solver: LpSolver, found: readonly Shortage[]): Diagnosis {
  const full = asFull(input);
  const base: Model = buildModel(full);
  if (base.stage === 'invalid_input' || base.stage === 'precheck') return { shortages: [...found], causes: [] };
  const { ctx, prepared } = base;

  const itemWide = itemShortages(ctx, prepared);
  const shortages = [...itemWide, ...found];

  const causes: Cause[] = [];
  for (const rule of ctx.rules) {
    if (rule.kind === 'substitute') continue;
    if (solvesWithout(full, solver, rule.code)) causes.push(causeOf(ctx, prepared, rule));
  }
  if (causes.length === 0 && itemWide.length === 0) causes.push(combinationCause(ctx, prepared));
  return { shortages, causes };
}
