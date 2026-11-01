// テント等の貸し出しがダッシュボード（/）に出すもの（T21・D-52・D-57。04「テント等の貸し出し」の「ダッシュボードに出すもの」、
// notes/T21.md「画面の約束」7）。
// - 欄：要対応と機能ごとのカードだけ（締切と予定・お知らせの欄は作らない。申請の締切は机椅子の「机椅子の申請の締切」と同じ時刻）。
// - 総務：summary.ts の軽い読み取り（確定の印・備品・申請・割り当て・記録）。数え方は counts.ts（/lending と同じ関数）。
// - 店長・副店長：代表する団体の割り当て（確定後だけ RLS が返す）と記録。要対応だけ（カードは出さない）。
// - 閲覧のみ：読まない（年度の行だけで作るカード）。
// lendingPortal(raw, ctx) は純粋関数：raw が null なら年度の行だけで決まる分（fromYear）、raw があればその種類の全部（fromYear の分を
// 含む）。時計を読まない（ctx.now だけ）。行き先はどれも canOpen で確かめ、開けない要対応は作らない。終了の年度では要対応を作らない
// （書けないので、押しても何もできない。判断したことの 12）。lib/data と画面の部品を import しない。
import { isLead, isSoumu } from '@/lib/auth/roles';
import { formatShortDateTime } from '@/lib/datetime';
import { canOpen } from '@/lib/navigation';
import { moduleLabel, portalQueryOptions, type ModuleCardModel, type PortalContext, type PortalProvider, type PortalSection, type TodoItem } from '../portal';
import type { ModuleId } from '../registry';
import {
  festivalDay2Started,
  festivalOver,
  lendingGroupCounts,
  lendingSummaryLine,
  lendingTotals,
  requestsClosed,
  unresolvedOverStockItemIds,
  type LendingItemKey,
} from './counts';
import { lendingRepOptions, lendingSoumuOptions, type LendingRepRaw, type LendingSoumuRaw } from './summary';

const MODULE_ID: ModuleId = 'lending';

/** 読んだ行（種類つき）。総務は loadLendingSoumu、店長・副店長は loadLendingRep の結果。閲覧のみは読まない */
export type LendingRaw = ({ kind: 'soumu' } & LendingSoumuRaw) | ({ kind: 'rep' } & LendingRepRaw);

/** カードのリンクの文字 */
export const LENDING_CARD_LINK = '備品と割り当てへ';
/** 閲覧のみのカードの文（何も読まない） */
export const LENDING_VIEWER_CARD_TEXT = '割り当てが確定すると、ここから見られます';
/** 総務のカード：備品がまだない */
export const LENDING_NO_ITEMS_CARD_TEXT = '貸し出す備品がまだ登録されていません';
/** 部門長以上の要対応：準備中で備品がない */
export const LENDING_NO_ITEMS_TODO = 'テント等の貸し出す備品と在庫を登録してください';
/** 部門長以上の要対応：締切の後・確定前で、直していない在庫超過がない */
export const LENDING_CONFIRM_TODO = 'テント等の割り当てを確かめて「確定」を押してください';

/** 今の立場で開ける行き先か（開けなければ null） */
const linkFor = (ctx: PortalContext, href: string): string | null => (canOpen(href, ctx.audiences, ctx.year.status) ? href : null);

/** 要対応を作る。終了の年度と、行き先を今の立場で開けないものは作らない */
function todoBuilder(ctx: PortalContext) {
  const todos: TodoItem[] = [];
  const add = (t: Omit<TodoItem, 'moduleId'>) => {
    if (ctx.year.status !== 'closed' && canOpen(t.href, ctx.audiences, ctx.year.status)) todos.push({ ...t, moduleId: MODULE_ID });
  };
  return { todos, add };
}

/** 総務の数（カードと要対応。/lending と同じ数え方） */
function soumuCounts(raw: LendingSoumuRaw) {
  const totals = lendingTotals(raw.items, raw.requests, raw.assignments, raw.records);
  const unresolved = new Set(unresolvedOverStockItemIds(totals));
  return {
    totals,
    unresolved: totals.filter((t) => unresolved.has(t.itemId)),
    groups: lendingGroupCounts(raw.requests, raw.assignments, raw.records),
  };
}

/** 総務のカード */
function soumuCard(raw: LendingSoumuRaw, ctx: PortalContext): ModuleCardModel {
  const base = { moduleId: MODULE_ID, title: moduleLabel(MODULE_ID), href: linkFor(ctx, '/lending'), linkLabel: LENDING_CARD_LINK };
  if (raw.items.length === 0) return { ...base, lines: [LENDING_NO_ITEMS_CARD_TEXT] };
  const c = soumuCounts(raw);
  const over = c.unresolved.length;
  const lines = [
    raw.confirmedAt ? `割り当て：確定（${formatShortDateTime(raw.confirmedAt)}）` : over > 0 ? `割り当て：確定前（在庫を超える備品 ${over}）` : '割り当て：確定前',
    `申請 ${c.groups.requested} 団体・割り当て ${c.groups.assigned} 団体`,
  ];
  if (raw.confirmedAt) {
    const lent = `渡した ${c.groups.lent}／${c.groups.assigned} 団体`;
    // 未返却は2日目から（それより前は貸し出し中なので数えない。判断したことの 20）
    lines.push(festivalDay2Started(ctx.year, ctx.now) ? `${lent}・未返却 ${c.groups.unreturned} 団体` : lent);
  }
  return { ...base, lines };
}

/** 総務の要対応（段は roles.ts） */
function soumuTodos(raw: LendingSoumuRaw, ctx: PortalContext): TodoItem[] {
  const { todos, add } = todoBuilder(ctx);
  const y = ctx.year;
  const c = soumuCounts(raw);
  if (isLead(ctx.role)) {
    if (y.status === 'preparing' && raw.items.length === 0) {
      add({ id: 'lending:lead:no-items', title: LENDING_NO_ITEMS_TODO, severity: 'normal', href: '/lending' });
    }
    if (requestsClosed(y, ctx.now) && !raw.confirmedAt && raw.items.length > 0) {
      const names = new Map(raw.items.map((i) => [i.id, i.name]));
      for (const t of c.unresolved) {
        add({
          id: `lending:lead:over-stock:${t.itemId}`,
          title: `テント等が在庫を超えています：${names.get(t.itemId) ?? ''}（申請 ${t.requested}・割り当て ${t.assigned}／在庫 ${t.stock}）`,
          severity: 'urgent',
          href: '/lending',
        });
      }
      if (c.unresolved.length === 0) add({ id: 'lending:lead:confirm', title: LENDING_CONFIRM_TODO, severity: 'normal', href: '/lending' });
    }
  }
  const unreturned = c.groups.unreturned;
  if (isSoumu(ctx.role) && festivalDay2Started(y, ctx.now) && unreturned > 0) {
    add({
      id: 'lending:soumu:unreturned',
      title: `テント等の未返却 ${unreturned} 団体`,
      count: unreturned,
      severity: festivalOver(y, ctx.now) ? 'urgent' : 'normal',
      href: '/lending/records?filter=unreturned',
    });
  }
  return todos;
}

/** 埋め込んだ備品の並べ方の列（備品が読めなければ id を名前の代わりにしない。並びの最後） */
function repItemKey(row: { lending_item_id: string; item: { name: string; sort_order: number } | null }): LendingItemKey {
  return { id: row.lending_item_id, name: row.item?.name ?? '', sort_order: row.item?.sort_order ?? Number.MAX_SAFE_INTEGER };
}

/** 店長・副店長の要対応（代表する団体ごと。立場の一覧の順） */
function repTodos(raw: LendingRepRaw, ctx: PortalContext): TodoItem[] {
  const { todos, add } = todoBuilder(ctx);
  const day2 = festivalDay2Started(ctx.year, ctx.now);
  for (const g of ctx.groups) {
    const href = `/request?group=${g.id}&tab=lending`;
    const assigned = raw.assignments.filter((a) => a.group_id === g.id && a.count > 0 && a.item);
    const records = raw.records.filter((r) => r.group_id === g.id);
    if (assigned.length > 0 && !records.some((r) => r.lent_count > 0)) {
      const count = new Map(assigned.map((a) => [a.lending_item_id, a.count]));
      const summary = lendingSummaryLine(assigned.map(repItemKey), (id) => count.get(id) ?? 0);
      add({ id: `lending:rep:${g.id}:assigned`, title: `${g.name}：テント等の割り当てが決まりました（${summary}）`, severity: 'info', href });
    }
    const out = records.filter((r) => r.lent_count > r.returned_count && r.item);
    if (day2 && out.length > 0) {
      const left = new Map(out.map((r) => [r.lending_item_id, r.lent_count - r.returned_count]));
      const summary = lendingSummaryLine(out.map(repItemKey), (id) => left.get(id) ?? 0);
      add({
        id: `lending:rep:${g.id}:unreturned`,
        title: `${g.name}：テント等を返してください（${summary}）`,
        severity: festivalOver(ctx.year, ctx.now) ? 'urgent' : 'normal',
        href,
      });
    }
  }
  return todos;
}

/** 閲覧のみのカード（年度の行だけ。何も読まない） */
function viewerCard(ctx: PortalContext): ModuleCardModel {
  return { moduleId: MODULE_ID, title: moduleLabel(MODULE_ID), lines: [LENDING_VIEWER_CARD_TEXT], href: linkFor(ctx, '/lending'), linkLabel: LENDING_CARD_LINK };
}

const EMPTY: PortalSection = { card: null, todos: [], dated: [] };

/**
 * テント等の貸し出しがその種類（ctx.kind）に出すもの。raw が null なら年度の行だけで決まる分（閲覧のみのカード）、raw があれば
 * その種類の全部。raw の種類は ctx.kind と同じにする（違えば例外）。純粋関数（時計は ctx.now だけ）。
 */
export function lendingPortal(raw: LendingRaw | null, ctx: PortalContext): PortalSection {
  if (raw && raw.kind !== ctx.kind) throw new Error(`lendingPortal：読んだ行（${raw.kind}）と立場の種類（${ctx.kind}）が違います`);
  switch (ctx.kind) {
    case 'soumu':
      return raw?.kind === 'soumu' ? { card: soumuCard(raw, ctx), todos: soumuTodos(raw, ctx), dated: [] } : EMPTY;
    case 'viewer':
      return { card: viewerCard(ctx), todos: [], dated: [] };
    case 'rep':
      return raw?.kind === 'rep' ? { card: null, todos: repTodos(raw, ctx), dated: [] } : EMPTY;
  }
}

/**
 * テント等の貸し出しのプロバイダ（providers.ts の PORTAL_PROVIDERS の最後）。総務は lendingSoumuOptions、店長・副店長は
 * lendingRepOptions（代表する団体の順）に select を足して読む。閲覧のみは読まない（options は null。カードは fromYear）。
 * 読み取りの結果を使う欄は要対応とカード（締切と予定・お知らせの欄には何も出さない）。
 */
export const lendingPortalProvider: PortalProvider = {
  moduleId: MODULE_ID,
  kinds: ['soumu', 'viewer', 'rep'],
  fromYear: (ctx) => lendingPortal(null, ctx),
  query: {
    widgets: ['todos', 'cards'],
    options: (ctx) => {
      switch (ctx.kind) {
        case 'soumu':
          return portalQueryOptions(lendingSoumuOptions(ctx.year.id), (raw) => lendingPortal({ kind: 'soumu', ...raw }, ctx));
        case 'rep':
          return portalQueryOptions(
            lendingRepOptions(
              ctx.year.id,
              ctx.groups.map((g) => g.id),
            ),
            (raw) => lendingPortal({ kind: 'rep', ...raw }, ctx),
          );
        case 'viewer':
          return null;
      }
    },
  },
};
