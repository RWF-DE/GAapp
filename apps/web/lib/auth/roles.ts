// ロールの段（D-48・D-50。01 の用語集の「段」）。画面の出し分け（ナビゲーション・ページの守り・業務の操作・マスタ設定）は、
// ここのロールの一覧と関数から作り、画面ごとにロールの配列を書かない。DB の段（private.can_lead と、ロールの配列
// '{admin,head,deputy_head}'・'{admin,head,deputy_head,staff}'）と同じ一覧にする。画面の出し分けは見た目だけで、データは RLS と RPC が守る。
//
// - 管理者だけ（isAdmin）：マスタ（場所・品目・距離・団体）、年度の作成・終了・年度名と1日目、書き出し、admin・head・deputy_head・viewer の扱い
// - 部門長以上（lead。LEAD_ROLES・isLead）：admin・head・deputy_head。業務の決定（状態の遷移・振り分け・申請一覧の編集・ルールなど）
// - 総務（soumu。SOUMU_ROLES・isSoumu）：部門長以上と staff（在庫・申請一覧・振り分けを見る）
// - 閲覧のみ（viewer）と団体代表（店長・副店長。group_members の行）は段の外で、画面ごとに決める
//
// import は型だけにする（lib/labels.ts・lib/errors.ts が membership.ts 経由で読み、E2E〔Node〕からも読むので、`@/` の別名と
// 実行時の import を使わない。最初に読む JS も増やさない）。並びが列挙と同じことは roles.test.ts が Constants と比べて確かめる。
import type { Database } from '@gaapp/shared';

/** ロール（app_role。年度ごとに1人1つ） */
export type AppRole = Database['public']['Enums']['app_role'];
/** 団体代表の団体の中の立場（group_role。店長・副店長。権限は同じで表示名だけが違う） */
export type GroupRole = Database['public']['Enums']['group_role'];
/** 招待で選ぶ立場（1回に1つ）：ロールか、団体代表の立場（団体を一緒に選ぶ） */
export type InviteKind = AppRole | GroupRole;

/** ロールの一覧（列挙の順。02「列挙型」） */
export const APP_ROLES: readonly AppRole[] = ['admin', 'head', 'deputy_head', 'staff', 'viewer'];
/** 部門長以上（lead）：管理者・総務部門長・総務副部門長 */
export const LEAD_ROLES: readonly AppRole[] = ['admin', 'head', 'deputy_head'];
/** 総務（soumu）：部門長以上と総務部門員 */
export const SOUMU_ROLES: readonly AppRole[] = [...LEAD_ROLES, 'staff'];
/** 団体代表の立場の一覧（列挙の順。店長・副店長） */
export const GROUP_ROLES: readonly GroupRole[] = ['manager', 'deputy_manager'];

type MaybeRole = AppRole | null | undefined;

/** 管理者か（null・undefined〔ロールなし〕は偽） */
export function isAdmin(role: MaybeRole): boolean {
  return role === 'admin';
}

/** 部門長以上（管理者・総務部門長・総務副部門長）か */
export function isLead(role: MaybeRole): boolean {
  return !!role && LEAD_ROLES.includes(role);
}

/** 総務（部門長以上と総務部門員）か */
export function isSoumu(role: MaybeRole): boolean {
  return !!role && SOUMU_ROLES.includes(role);
}

/** 招待の立場のうち、団体代表の立場（店長・副店長。団体を一緒に選ぶ）か */
export function isGroupRole(kind: string | null | undefined): kind is GroupRole {
  return !!kind && (GROUP_ROLES as readonly string[]).includes(kind);
}

/**
 * その人が招待し、付け外しできるロール（DB の RPC の段。D-48・D-50）：管理者は5つすべて、総務部門長・総務副部門長は
 * 総務部門員だけ、ほかは何もない。ユーザーのタブの「ロールを外す」は、相手のロールがこの中にあるときに出す
 * （ロールの変更〔set_role〕は画面では管理者だけに出す。D-50）。
 *
 * @example
 * manageableRoles('head') // ['staff']
 */
export function manageableRoles(actor: MaybeRole): readonly AppRole[] {
  if (isAdmin(actor)) return APP_ROLES;
  if (isLead(actor)) return ['staff'];
  return [];
}

/**
 * 招待のフォームで選べる立場（1回に1つ）：manageableRoles に、部門長以上なら店長・副店長を足したもの。
 * 管理者は7つ（管理者・総務部門長・総務副部門長・総務部門員・閲覧のみ・店長・副店長）、総務部門長・総務副部門長は
 * 3つ（総務部門員・店長・副店長）、ほかは何もない。
 */
export function inviteKindsFor(actor: MaybeRole): readonly InviteKind[] {
  return isLead(actor) ? [...manageableRoles(actor), ...GROUP_ROLES] : [];
}

/**
 * その招待を取り消せるか（revoke_invitation の段）：ロールの招待は manageableRoles にそのロールがあるとき（管理者はすべて、
 * 総務部門長・総務副部門長は総務部門員の招待だけ）、団体の招待（店長・副店長。role が null）は部門長以上。
 * 部門長・副部門長には RLS がこの範囲の招待だけを返すので、画面に出る招待とそろう（ユーザーのタブの「取り消す」）。
 */
export function canRevokeInvitation(actor: MaybeRole, invitation: { role: AppRole | null }): boolean {
  return invitation.role ? manageableRoles(actor).includes(invitation.role) : isLead(actor);
}
