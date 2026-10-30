// 検証の一覧の1件を押したときの行き先（画面の設計 3.9 の「右：検証の一覧」。T13）。純粋関数。
// - 行き先：refs.rowIds があればその行（品目タブ）、roomId と itemId があればそのタブの部屋のまとまり、groupId があれば
//   団体別のその団体、roomId だけなら部屋のまとまり（今のタブ）、itemId だけならそのタブ。
// - ルール（ruleCode）：ルール画面を開ける立場（admin）には /rules?code=…（同じタブで移動）、開けない立場（Q1 の staff）には
//   リンクにせず、ルールのコードと内容の文を項目の下に開いて見せる（/rules は admin だけ。canOpen）。
import type { Issue } from '@gaapp/shared';
import type { Audience, YearStatus } from '@/lib/auth/membership';
import { canOpen } from '@/lib/navigation';

export type IssueDestination =
  | { kind: 'row'; rowId: string; tab: string | null }
  | { kind: 'room'; roomId: string; tab: string | null }
  | { kind: 'group'; groupId: string }
  | { kind: 'tab'; tab: string }
  | { kind: 'none' };

export interface IssueTarget {
  destination: IssueDestination;
  /** ruleCode があるとき。href は開ける立場だけ（null ならコードと内容の文を出す） */
  rule: { code: string; href: string | null } | null;
}

export interface IssueTargetIndex {
  /** 行の id → 品目の id（いまの画面の行。ない行は行き先にしない） */
  rowItem: ReadonlyMap<string, string>;
  /** 品目の id → タブの key */
  tabByItem: ReadonlyMap<string, string>;
}

/** ルール画面へのリンク（code はクエリに入れる） */
export const ruleHref = (code: string) => `/rules?code=${encodeURIComponent(code)}`;

/**
 * @example
 * const t = issueTarget(issue, { rowItem, tabByItem }, ['staff'], 'allocating');
 * t.rule // { code: 'S05', href: null }（staff はルール画面を開けない）
 */
export function issueTarget(
  issue: Pick<Issue, 'refs'>,
  index: IssueTargetIndex,
  audiences: readonly Audience[],
  yearStatus?: YearStatus | null,
): IssueTarget {
  const { refs } = issue;
  const rule = refs.ruleCode
    ? { code: refs.ruleCode, href: canOpen(ruleHref(refs.ruleCode), audiences, yearStatus) ? ruleHref(refs.ruleCode) : null }
    : null;
  const tabOf = (itemId: string | undefined) => (itemId ? (index.tabByItem.get(itemId) ?? null) : null);

  const rowId = refs.rowIds?.find((id) => index.rowItem.has(id));
  if (rowId) return { destination: { kind: 'row', rowId, tab: tabOf(index.rowItem.get(rowId)) }, rule };
  if (refs.roomId && refs.itemId) return { destination: { kind: 'room', roomId: refs.roomId, tab: tabOf(refs.itemId) }, rule };
  if (refs.groupId) return { destination: { kind: 'group', groupId: refs.groupId }, rule };
  if (refs.roomId) return { destination: { kind: 'room', roomId: refs.roomId, tab: null }, rule };
  const tab = tabOf(refs.itemId);
  if (tab) return { destination: { kind: 'tab', tab }, rule };
  return { destination: { kind: 'none' }, rule };
}
