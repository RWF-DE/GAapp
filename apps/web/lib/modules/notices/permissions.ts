// お知らせの段の判定（04「お知らせ一覧」・「共通レイアウト」の段の表、notes/T17.md「後半（画面）の約束」4。T17・D-53）。
// 純粋な関数。段は lib/auth/roles.ts の一覧（DB の段と同じ：部門長以上＝admin・head・deputy_head、総務＝それと staff）から作る。
// 画面の出し分けは見た目だけで、データは RLS と RPC（save_notice・delete_notice）が守る。画面は DB より狭く出してよい：
// 総務部門員の「編集」は、自分が書いた総務内のお知らせだけに出す（DB は、自分が書いた団体あてを総務内に変えて直すことも許すが、
// 総務部門員のダイアログは宛先を選べないので、保存で黙って総務内に変わってしまう。後半の判断したことの 5）。
import { Constants } from '@gaapp/shared';
import type { YearStatus } from '@/lib/auth/membership';
import { isLead, isSoumu, type AppRole } from '@/lib/auth/roles';
import type { NoticeAudience, NoticeRow } from '@/lib/data/notices';

/** 書く人の立場（ロール・開いている年度の状態・自分の user_id） */
export interface NoticeActor {
  role: AppRole | null;
  status: YearStatus;
  userId: string | null;
}

/** 出せる宛先（部門長以上：総務内・全団体・指定の団体、総務部門員：総務内だけ、ほか：なし） */
export function noticeAudiencesFor(role: AppRole | null): readonly NoticeAudience[] {
  if (isLead(role)) return Constants.public.Enums.notice_audience;
  if (isSoumu(role)) return ['soumu'];
  return [];
}

/** お知らせを書けるか（総務で、年度が終了していない。終了した年度は読むだけ） */
export function canWriteNotices(role: AppRole | null, status: YearStatus): boolean {
  return isSoumu(role) && status !== 'closed';
}

/** ピン留めを付け外しできるか（部門長以上） */
export function canPinNotices(role: AppRole | null): boolean {
  return isLead(role);
}

/**
 * 段で、そのお知らせを直せるか（年度の状態は見ない）：部門長以上はどれでも、総務部門員は自分が書いた総務内のお知らせだけ。
 * 編集のダイアログが、入力の元の行（conflict の後は読み直した行）を今の段で直せるかにも使う（宛先が総務内でなくなったら、
 * 総務部門員の保存で黙って総務内に戻さない。レビューの T17-R1）。
 */
export function canEditNoticeByTier(n: Pick<NoticeRow, 'created_by' | 'audience'>, me: Pick<NoticeActor, 'role' | 'userId'>): boolean {
  if (isLead(me.role)) return true;
  return isSoumu(me.role) && !!me.userId && n.created_by === me.userId && n.audience === 'soumu';
}

/** そのお知らせに「編集」を出すか（書けて〔総務で、終了でない〕、段で直せる：部門長以上はどれでも、総務部門員は自分が書いた総務内だけ） */
export function canEditNotice(n: Pick<NoticeRow, 'created_by' | 'audience'>, me: NoticeActor): boolean {
  return canWriteNotices(me.role, me.status) && canEditNoticeByTier(n, me);
}

/** そのお知らせに「削除」を出すか（部門長以上はどれでも、総務部門員は自分が書いたお知らせ） */
export function canDeleteNotice(n: Pick<NoticeRow, 'created_by'>, me: NoticeActor): boolean {
  if (!canWriteNotices(me.role, me.status)) return false;
  if (isLead(me.role)) return true;
  return !!me.userId && n.created_by === me.userId;
}
