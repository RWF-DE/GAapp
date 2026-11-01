// テント等の貸し出しの言葉（T21・D-57。04「テント等の貸し出し」、notes/T21.md「画面の約束」）。画面・ダッシュボード・CSV が同じ
// 言葉を使う。実行時の import をしない（型だけ。ダッシュボード〔/〕の JS に入っても軽いように）。
import type { GroupCategory } from '@gaapp/shared';

/** 受け渡し・返却の状態（01 の用語集。未返却は2日目から。それより前の同じ状態は貸し出し中。判断したことの 20） */
export type RecordState = 'before' | 'lent' | 'unreturned' | 'returned';

/** 状態の並び（受け渡し・返却の一覧のチップの並び） */
export const RECORD_STATES: readonly RecordState[] = ['before', 'lent', 'unreturned', 'returned'];

/** 状態の表示名（受け渡し・返却の一覧の印とチップ） */
export const RECORD_STATE_LABELS: Readonly<Record<RecordState, string>> = {
  before: '渡す前',
  lent: '貸し出し中',
  unreturned: '未返却',
  returned: '返却済み',
};

/** 申請できる区分の既定（備品の登録。DB の既定と同じ。模擬店・部門） */
export const DEFAULT_REQUESTABLE_CATEGORIES: readonly GroupCategory[] = ['stall', 'department'];

/** 単位の既定（DB の既定と同じ） */
export const DEFAULT_LENDING_UNIT = '個';

/** 終了した年度の帯（総務。3画面とも） */
export const LENDING_CLOSED_TEXT = '終了した年度のため、テント等の貸し出しは読むだけです';

/** 使用場所のない団体の場所（申請の画面と同じ言い方） */
export const NO_LOCATION_TEXT = '校内に分散';
