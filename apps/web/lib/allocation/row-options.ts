// 行の操作の選択肢（画面の設計 3.9 の「行の操作」。T13 の段 2）。純粋関数。
// - 運び元の変更：その品目の在庫がある使用可の場所から、余りを添えて選ぶ。
// - 行の追加：団体 → 申請品目（その団体の需要がある品目を先に）→ 品目（申請品目と、ルールでその団体に許される代替先。
//   ほかの品目は「ルール外（E004 になります）」と添える）→ 運び元（余りを添える）→ 数（既定は max(1, min(不足, 余り))）。
import { contextFor, substituteOptions } from '@gaapp/allocator';
import { buildDemand, giKey, type StoredAllocationRow, type YearData } from '@gaapp/shared';
import { roomItemKey, type ItemInfo, type ViewModel } from './view-model';

export interface SourceOption {
  roomId: string;
  name: string;
  stock: number;
  /** 在庫 − その部屋のその品目の行の合計（未保存の変更を当てた行で数える） */
  surplus: number;
}

/** その品目の在庫がある使用可の場所（場所の並び順）。exclude は今の運び元 */
export function sourceOptions(vm: ViewModel, rows: readonly StoredAllocationRow[], itemId: string, exclude?: string): SourceOption[] {
  const used = new Map<string, number>();
  for (const r of rows) if (r.itemId === itemId) used.set(r.sourceRoomId, (used.get(r.sourceRoomId) ?? 0) + r.count);
  return vm.rooms
    .filter((room) => room.usable && room.id !== exclude && (vm.stock.get(roomItemKey(room.id, itemId)) ?? 0) > 0)
    .map((room) => {
      const stock = vm.stock.get(roomItemKey(room.id, itemId)) ?? 0;
      return { roomId: room.id, name: room.name, stock, surplus: stock - (used.get(room.id) ?? 0) };
    });
}

/** 運び元の選択肢の文（「1-1（余り 3）」） */
export const sourceLabel = (o: SourceOption) => `${o.name}（余り ${o.surplus}）`;

export interface RequestedOption {
  item: ItemInfo;
  /** その団体のその申請品目の需要（buildDemand の D） */
  demand: number;
  /** 振り分け済みの数（申請品目ごと。読み替えはしない） */
  allocated: number;
}

type DemandSource = Pick<YearData, 'items' | 'groups' | 'requests' | 'rules'>;

/** 申請品目の選択肢：需要がある品目を先に（品目の並び順）、次にほかの品目 */
export function requestedOptions(vm: ViewModel, data: DemandSource, rows: readonly StoredAllocationRow[], groupId: string): RequestedOption[] {
  const { demand } = buildDemand(data);
  const allocated = new Map<string, number>();
  for (const r of rows) if (r.groupId === groupId) allocated.set(r.requestedItemId, (allocated.get(r.requestedItemId) ?? 0) + r.count);
  const all = vm.items.map((item) => ({ item, demand: demand.get(giKey(groupId, item.id)) ?? 0, allocated: allocated.get(item.id) ?? 0 }));
  return [...all.filter((o) => o.demand > 0), ...all.filter((o) => o.demand === 0)];
}

export interface ItemOption {
  item: ItemInfo;
  /** ルールでその団体に許される（申請品目そのものか、代替ルールの先） */
  allowed: boolean;
  /** 代替のルールのコード（申請品目そのものなら null） */
  ruleCode: string | null;
}

/** 品目の選択肢：申請品目と許される代替先を先に、ほかの品目は allowed: false（「ルール外（E004 になります）」） */
export function itemOptions(vm: ViewModel, data: YearData | null, groupId: string, requestedItemId: string): ItemOption[] {
  const allowed = new Map<string, string | null>([[requestedItemId, null]]);
  if (data) {
    try {
      const ctx = contextFor(data);
      const g = ctx.groupById.get(groupId);
      const i = ctx.itemById.get(requestedItemId);
      if (g && i) for (const o of substituteOptions(ctx, g, i)) allowed.set(o.j, o.ruleCode);
    } catch {
      // 入力に誤りがあるとき（検証できない）は申請品目だけを許す
    }
  }
  const opts = vm.items.map((item) => ({ item, allowed: allowed.has(item.id), ruleCode: allowed.get(item.id) ?? null }));
  return [...opts.filter((o) => o.allowed), ...opts.filter((o) => !o.allowed)];
}

export const OUT_OF_RULE = 'ルール外（E004 になります）';

/**
 * 追加する行の数の既定：max(1, min(その団体・申請品目の不足, 余り))。不足がない・余りがないときは 1 にして添え書きを返す。
 */
export function defaultCount(args: { shortage: number; surplus: number | null; requestedName: string }): { count: number; hints: string[] } {
  const hints: string[] = [];
  if (args.shortage <= 0) hints.push(`この団体の${args.requestedName}は不足していません`);
  if (args.surplus !== null && args.surplus <= 0) hints.push('この部屋の余りはありません');
  if (hints.length > 0) return { count: 1, hints };
  const n = args.surplus === null ? args.shortage : Math.min(args.shortage, args.surplus);
  return { count: Math.max(1, n), hints };
}
