// シフト・作業の段の判定（04「シフト表」「作業一覧」・「共通レイアウト」の段の表、notes/T20.md「画面の約束」1。T20・D-56）。
// 純粋な関数。段は lib/auth/roles.ts の一覧（DB の段と同じ：部門長以上＝admin・head・deputy_head、総務＝それと staff）から作る。
// 画面の出し分けは見た目だけで、データは RLS と RPC が守る（5表の書き込みのポリシーは private.can_lead：その年度の部門長以上で、
// 年度が終了でない。作業の状態は set_task_status：その年度の総務で、担当者か部門長以上、終了でない）。画面は DB より広く出さない。
import type { YearStatus } from '@/lib/auth/membership';
import { isLead, isSoumu, type AppRole } from '@/lib/auth/roles';

type MaybeRole = AppRole | null | undefined;
type MaybeStatus = YearStatus | null | undefined;

const open = (status: MaybeStatus): boolean => !!status && status !== 'closed';

/** 時間枠・持ち場・ます・割り当てを足す・直す・消せるか（部門長以上で、年度が終了していない。DB の private.can_lead と同じ） */
export function canEditShifts(role: MaybeRole, status: MaybeStatus): boolean {
  return isLead(role) && open(status);
}

/** 作業を足す・直す・消す・担当者を決められるか（部門長以上で、年度が終了していない。DB の private.can_lead と同じ） */
export function canEditTasks(role: MaybeRole, status: MaybeStatus): boolean {
  return isLead(role) && open(status);
}

/**
 * その作業の状態を変えられるか（set_task_status の段）：総務で、年度が終了しておらず、部門長以上か、担当者が自分。
 * 担当者のいない作業は部門長以上だけ。userId が分からなければ担当者として扱わない。
 */
export function canSetTaskStatus(
  role: MaybeRole,
  status: MaybeStatus,
  task: { assignee_id: string | null },
  userId: string | null | undefined,
): boolean {
  if (!isSoumu(role) || !open(status)) return false;
  return isLead(role) || (!!userId && task.assignee_id === userId);
}

/**
 * 割り当て・担当者のロールを見分けるか（部門長以上。year_roles をその年度の全部読めるので、閲覧のみに変わった人に
 * 「総務でない人」「担当者が総務でない」と出し、ますの数に入れない。総務部門員はほかの人のロールを読めないので分けない）
 */
export function seesMemberRoles(role: MaybeRole): boolean {
  return isLead(role);
}

/** 終了した年度の帯（総務に。/shifts・/tasks） */
export const CLOSED_SHIFTS = '終了した年度のため、シフトと作業は読むだけです';
