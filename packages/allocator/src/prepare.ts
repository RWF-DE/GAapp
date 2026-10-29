// 前処理（03「定式化」の前処理1〜6、設計 5 章 P1〜P6）
import { buildDemand, giKey, type AllocationRow, type ExcludedRequest, type Issue } from '@gaapp/shared';
import { rgijKey, rjKey, type Ctx } from './context';

export type Prepared = {
  /** 需要 D（前処理1・2の後）。E003・W101 と画面の申請数はこれと比べる */
  demandBase: Map<string, number>;
  /** D′(g,i)：固定行と残すの行を引いた後（0 のキーは持たない） */
  demand: Map<string, number>;
  /** S′(r,j)：固定行と残すの行を引き、使用不可の部屋を 0 にした後（0 のキーは持たない） */
  supply: Map<string, number>;
  /** 残すの行（S08。is_keep、申請品目 = 品目） */
  keepRows: AllocationRow[];
  /** x̂ の上限（最小変更モード）：前回の行の合計 − 残すの行 */
  hatBound: Map<string, number>;
  /** precheck で止めるもの（E001、残すのルールの E002・E005） */
  issues: Issue[];
  /** 申請できない品目の申請（E006 の候補）。需要から除いた */
  excluded: ExcludedRequest[];
};

export function prepare(ctx: Ctx): Prepared {
  const issues: Issue[] = [];
  const add = (m: Map<string, number>, k: string, n: number) => m.set(k, (m.get(k) ?? 0) + n);

  // P1・P2 需要 D
  const { demand: demandBase, excluded } = buildDemand(ctx);

  // 固定行の (r,g,i,j) ごとの合計
  const fixedByKey = new Map<string, number>();
  for (const f of ctx.fixedRows) add(fixedByKey, rgijKey(f.sourceRoomId, f.groupId, f.requestedItemId, f.itemId), f.count);

  // P2（残す）。keep ルールを code の順、params.items を品目の並び順に見る。
  // 同じ（部屋・団体・品目）の keep の重なりと、source_restrict の外の部屋は P0（checkRuleRefs）で止めてある
  const keepRows: AllocationRow[] = [];
  const keepRuleOfKey = new Map<string, string>(); // (r,j) → 関わる keep のルールの code（E001 の refs）
  for (const rule of ctx.rules) {
    if (rule.kind !== 'keep') continue;
    const g = ctx.groupById.get(rule.params.group)!;
    const room = ctx.roomById.get(rule.params.room)!;
    let stop = false;
    if (g.locationRoomId !== room.id) {
      issues.push({
        code: 'E005',
        severity: 'error',
        message: `ルール ${rule.code}：「残す」の部屋（${room.name}）が ${g.name} の使用場所ではありません`,
        refs: { ruleCode: rule.code, groupId: g.id, roomId: room.id },
      });
      stop = true;
    }
    if (!room.usable) {
      issues.push({
        code: 'E002',
        severity: 'error',
        message: `ルール ${rule.code}：「残す」の部屋（${room.name}）は今年使えません`,
        refs: { ruleCode: rule.code, groupId: g.id, roomId: room.id },
      });
      stop = true;
    }
    if (stop) continue;
    for (const it of ctx.items) {
      const n = rule.params.items[it.code];
      if (n === undefined) continue;
      const f = fixedByKey.get(rgijKey(room.id, g.id, it.id, it.id)) ?? 0;
      if (n - f > 0) {
        keepRows.push({ sourceRoomId: room.id, groupId: g.id, itemId: it.id, requestedItemId: it.id, count: n - f, isKeep: true });
        if (!keepRuleOfKey.has(rjKey(room.id, it.id))) keepRuleOfKey.set(rjKey(room.id, it.id), rule.code);
      }
    }
  }

  // P4 差し引き
  const demand = new Map(demandBase);
  const supply = new Map(ctx.stock);
  const rowIdsOfKey = new Map<string, string[]>();
  for (const f of ctx.fixedRows) {
    add(demand, giKey(f.groupId, f.requestedItemId), -f.count);
    add(supply, rjKey(f.sourceRoomId, f.itemId), -f.count);
    const k = rjKey(f.sourceRoomId, f.itemId);
    rowIdsOfKey.set(k, [...(rowIdsOfKey.get(k) ?? []), f.id]);
  }
  for (const k of keepRows) {
    add(demand, giKey(k.groupId, k.requestedItemId), -k.count);
    add(supply, rjKey(k.sourceRoomId, k.itemId), -k.count);
  }
  for (const room of ctx.rooms) {
    for (const it of ctx.items) {
      const k = rjKey(room.id, it.id);
      const v = supply.get(k);
      if (v === undefined || v >= 0) continue;
      const ruleCode = keepRuleOfKey.get(k);
      const rowIds = rowIdsOfKey.get(k);
      issues.push({
        code: 'E001',
        severity: 'error',
        message: `${room.name}の${it.name}が、固定行と残すの行で在庫を ${-v} 台超えています`,
        refs: { roomId: room.id, itemId: it.id, ...(rowIds ? { rowIds } : {}), ...(ruleCode ? { ruleCode } : {}) },
      });
    }
  }
  for (const [k, v] of demand) if (v <= 0) demand.delete(k);
  // P3（使用不可の部屋は S′ = 0）。0 以下のキーは持たない
  for (const room of ctx.rooms) {
    if (room.usable) continue;
    for (const it of ctx.items) supply.delete(rjKey(room.id, it.id));
  }
  for (const [k, v] of supply) if (v <= 0) supply.delete(k);

  // P6 前回の行（minimal_change だけ）
  const hatBound = new Map<string, number>();
  if (ctx.mode === 'minimal_change') {
    for (const p of ctx.previousRows) add(hatBound, rgijKey(p.sourceRoomId, p.groupId, p.requestedItemId, p.itemId), p.count);
    for (const k of keepRows) add(hatBound, rgijKey(k.sourceRoomId, k.groupId, k.requestedItemId, k.itemId), -k.count);
    for (const [k, v] of hatBound) if (v <= 0) hatBound.delete(k);
  }

  return { demandBase, demand, supply, keepRows, hatBound, issues, excluded };
}
