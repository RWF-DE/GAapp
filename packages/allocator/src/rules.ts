// ルールの判定（設計 7 章）。変数の候補、validate の E004、W107 の入れ替えの判定で同じ関数を使う
import type { Group, Item } from '@gaapp/shared';
import { consentKey, type Ctx } from './context';

export type SubstituteOption = {
  /** 実際に運ぶ品目 */
  j: string;
  /** 代替の重さ（j = i なら 0） */
  cSub: number;
  /** 休憩所への不可椅子など、preferCategory に当たれば 1 */
  p: 0 | 1;
  ruleCode: string | null;
};

type RuleCtx = Pick<Ctx, 'rules' | 'items' | 'itemIdByCode' | 'itemIndex' | 'roomById' | 'consentStatus'>;

/**
 * 団体 g・申請品目 i の品目の候補 J(g,i)：j = i と、条件を満たす代替ルールの j。
 * 同じ j に当てはまるルールが2つ以上あれば、cost が小さいもの、同じなら code が先のもの。並びは j = i、次に品目の並び。
 */
export function substituteOptions(ctx: RuleCtx, g: Group, i: Item): SubstituteOption[] {
  const loc = g.locationRoomId === null ? null : (ctx.roomById.get(g.locationRoomId) ?? null);
  const best = new Map<string, SubstituteOption>();
  for (const s of ctx.rules) {
    if (s.kind !== 'substitute') continue;
    const p = s.params;
    if (p.from !== i.code || !p.categories.includes(g.category)) continue;
    if (p.indoorOnly && loc?.kind !== 'room') continue;
    const j = ctx.itemIdByCode.get(p.to);
    if (j === undefined || j === i.id) continue;
    if (p.needsConsent && ctx.consentStatus.get(consentKey(g.id, i.id, j)) === 'declined') continue;
    const cand: SubstituteOption = { j, cSub: p.cost, p: p.preferCategory === g.category ? 1 : 0, ruleCode: s.code };
    const cur = best.get(j);
    // ctx.rules は code の順なので、同じ cost なら先に見たもの（code が先）を残す
    if (!cur || cand.cSub < cur.cSub) best.set(j, cand);
  }
  const subs = [...best.values()].sort((a, b) => ctx.itemIndex.get(a.j)! - ctx.itemIndex.get(b.j)!);
  return [{ j: i.id, cSub: 0, p: 0, ruleCode: null }, ...subs];
}

/** 運び元の制限：(g, 申請品目 i) が対象の source_restrict の rooms の共通部分。対象でなければ null（D-22） */
export function allowedSources(ctx: Pick<Ctx, 'rules'>, g: Group, i: Item): Set<string> | null {
  let set = null as Set<string> | null;
  for (const s of ctx.rules) {
    if (s.kind !== 'source_restrict') continue;
    if (s.params.group !== g.id || !s.params.items.includes(i.code)) continue;
    const rs = new Set<string>(s.params.rooms);
    set = set === null ? rs : new Set([...set].filter((x: string) => rs.has(x)));
  }
  return set;
}

/** 団体 g が申請品目 i の分として、場所 r から品目 j を受け取れるか（使用不可・代替・了承・運び元の制限） */
export function canUse(ctx: RuleCtx, g: Group, i: Item, jId: string, roomId: string): boolean {
  const room = ctx.roomById.get(roomId);
  if (!room || !room.usable) return false;
  if (!substituteOptions(ctx, g, i).some((o) => o.j === jId)) return false;
  const allowed = allowedSources(ctx, g, i);
  return allowed === null || allowed.has(roomId);
}

/** (g, i, j) の代替の重さ。ルール上ありえない組なら undefined */
export function substituteCost(ctx: RuleCtx, g: Group, i: Item, jId: string): number | undefined {
  return substituteOptions(ctx, g, i).find((o) => o.j === jId)?.cSub;
}
