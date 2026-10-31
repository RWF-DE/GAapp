// 締切と予定の段の判定（04「締切と予定」・「共通レイアウト」の段の表、notes/T18.md「後半（画面）の約束」7。T18・D-54）。
// 純粋な関数。段は lib/auth/roles.ts の一覧（DB の段と同じ：部門長以上＝admin・head・deputy_head、総務＝それと staff）から作る。
// 画面の出し分けは見た目だけで、データは RLS が守る（events の書き込みのポリシーは private.can_lead：その年度の部門長以上で、年度が
// 終了でない。読み取りは総務が全部、閲覧のみ・店長・副店長は対象が団体・全員のもの）。
import type { YearStatus } from '@/lib/auth/membership';
import { isLead, isSoumu, type AppRole } from '@/lib/auth/roles';

/** 締切と予定を登録・編集・削除できるか（部門長以上で、年度が終了していない。DB の private.can_lead と同じ） */
export function canWriteEvents(role: AppRole | null | undefined, status: YearStatus | null | undefined): boolean {
  return isLead(role) && !!status && status !== 'closed';
}

/**
 * 対象の印（総務・団体・全員）と、種類・対象の絞り込みを出すか（総務だけ。閲覧のみ・店長・副店長が読めるのは団体・全員だけで、
 * v1 では読む人が同じなので出さない。後半の判断したことの 9）
 */
export function seesEventAudience(role: AppRole | null | undefined): boolean {
  return isSoumu(role);
}
