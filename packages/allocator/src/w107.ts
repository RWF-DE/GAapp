// W107 の判定（03「検証コード一覧」、D-20、設計 12.4）。T07 が Issue にする
import type { AllocationRow, YearData } from '@gaapp/shared';
import { createContext, rewriteRowRequestedItem, type Ctx } from './context';
import { distance } from './distance';
import { canUse } from './rules';

export type W107Finding = {
  /** 自室の品目を外へ出しつつ、他から受け取っている団体 */
  groupId: string;
  /** 使用場所 L */
  roomId: string;
  /** 品目 j */
  itemId: string;
  /** g が受け取っている L 以外の運び元 */
  receivedFrom: string[];
  /** L から j を受け取っている（使用場所が L でない）団体 */
  sentTo: string[];
  /**
   * 入れ替え（g が L の j を使い、h が r の j を使う）がルール上でき、入れ替えても距離の合計が増えない組が
   * 1つでもある（D-20 の W107）。false のものは T00 の定義でだけ数える（S05 などで入れ替えられない）
   */
  swappable: boolean;
};

/** YearData の部分から判定用の Ctx を作る（並べ替えと索引。入力が不正なら例外） */
export function contextFor(data: YearData): Ctx {
  const c = createContext({
    items: data.items,
    rooms: data.rooms,
    groups: data.groups,
    stocks: data.stocks,
    requests: data.requests,
    rules: data.rules,
    consents: data.consents,
    distanceOverrides: data.distanceOverrides,
    mode: 'full',
    fixedRows: [],
    previousRows: [],
  });
  if (!c.ok) throw new Error(`入力が不正です：${c.inputErrors.map((e) => `${e.path} ${e.message}`).join('; ')}`);
  return c.ctx;
}

/**
 * rows はその年度の全行（固定・手動・自動・残す）。申請品目は前処理1と同じ読み替えをしてから比べる。
 * 同じ部屋を使う別の団体へ渡す分は「外へ出ている」に数えない（D-23）。
 */
export function findW107(data: YearData, allRows: readonly AllocationRow[], ctxIn?: Ctx): W107Finding[] {
  const ctx = ctxIn ?? contextFor(data);
  const rows = allRows.map((r) => rewriteRowRequestedItem(r, ctx));
  const out: W107Finding[] = [];
  for (const g of ctx.groups) {
    const L = g.locationRoomId;
    if (L === null) continue;
    const Lroom = ctx.roomById.get(L)!;
    const recv = rows.filter((r) => r.groupId === g.id && r.sourceRoomId !== L);
    const outs = rows.filter((r) => r.sourceRoomId === L && ctx.groupById.get(r.groupId)!.locationRoomId !== L);
    for (const it of ctx.items) {
      const rj = recv.filter((r) => r.itemId === it.id);
      const oj = outs.filter((r) => r.itemId === it.id);
      if (rj.length === 0 || oj.length === 0) continue;
      let swappable = false;
      for (const a of rj) {
        const aSrc = ctx.roomById.get(a.sourceRoomId)!;
        if (!canUse(ctx, g, ctx.itemById.get(a.requestedItemId)!, it.id, L)) continue;
        for (const b of oj) {
          const h = ctx.groupById.get(b.groupId)!;
          if (!canUse(ctx, h, ctx.itemById.get(b.requestedItemId)!, it.id, a.sourceRoomId)) continue;
          const hL = h.locationRoomId === null ? null : ctx.roomById.get(h.locationRoomId)!;
          const swapped = distance(aSrc, hL, ctx.overrides);
          const current = distance(aSrc, Lroom, ctx.overrides) + distance(Lroom, hL, ctx.overrides);
          if (swapped <= current) {
            swappable = true;
            break;
          }
        }
        if (swappable) break;
      }
      out.push({
        groupId: g.id,
        roomId: L,
        itemId: it.id,
        receivedFrom: [...new Set(rj.map((r) => r.sourceRoomId))],
        sentTo: [...new Set(oj.map((r) => r.groupId))],
        swappable,
      });
    }
  }
  return out;
}
