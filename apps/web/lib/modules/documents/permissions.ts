// 提出物の段と、状態ごとに出す操作（04「提出物」の段ごとの出し分け、notes/T19.md「パート B・C の約束」1。T19・D-55）。
// 純粋な関数。段は lib/auth/roles.ts の一覧（DB の段と同じ：部門長以上＝admin・head・deputy_head、総務＝それと staff）から作る。
// 画面は DB より広く出さず、段ができることを隠さない（出し分けは見た目だけで、データは RLS・RPC・Storage のポリシーとトリガーが守る）：
// - documents の書き込み（RLS の can_lead）：その年度の部門長以上で、年度が終了でない
// - 提出とファイルの RPC：店長・副店長は未提出・差し戻しのときファイルを外す・「提出した」、提出済みのとき取り消す（ファイルを足すのは
//   T24〔D-62〕で止めた。addFile はいつも偽）。
//   部門長以上は承認でなければファイルを足す・外す（代理）、未提出・差し戻しのとき代わりに提出・紙での承認、提出済みのとき承認・取り消し、
//   提出済み・承認・差し戻しのとき差し戻し（承認の取り消し・理由の書き直しを兼ねる）。届いていない予約は状態によらず外せる。
// - ファイルを開ける（documents_objects_select・document_files_select）：部門長以上と、その団体の店長・副店長（総務部門員は開けない。Q4）
// - 年度のファイルの削除（delete_year_document_files）：その年度の管理者で、年度が終了
// 終了した年度は読むだけ（例外は管理者のファイルの削除だけ）。
import type { YearStatus } from '@/lib/auth/membership';
import { isAdmin, isLead, isSoumu, type AppRole } from '@/lib/auth/roles';
import type { DocumentStatus } from './labels';

type MaybeRole = AppRole | null | undefined;
type MaybeStatus = YearStatus | null | undefined;

/** 提出状況の段：部門長以上（lead）・総務部門員（staff）。総務でなければ null（閲覧のみには出さない。Q5） */
export type DocumentsTier = 'lead' | 'staff';

/** その人の提出状況の段（部門長以上 → 'lead'、総務部門員 → 'staff'、ほか → null） */
export function documentsTier(role: MaybeRole): DocumentsTier | null {
  if (isLead(role)) return 'lead';
  return isSoumu(role) ? 'staff' : null;
}

/** 年度が書ける状態か（終了でない。準備中〜確定中のどれでも書ける。提出物は振り分けの守りを持たない） */
function writableYear(status: MaybeStatus): boolean {
  return !!status && status !== 'closed';
}

/**
 * 提出物の設定・承認・差し戻し・紙での承認・代理・前年度から写すを出すか（部門長以上で、年度が終了でない。DB の private.can_lead と
 * RPC の段と同じ）
 */
export function canManageDocuments(role: MaybeRole, status: MaybeStatus): boolean {
  return isLead(role) && writableYear(status);
}

/** 提出状況でファイルを出すか（部門長以上だけ。総務部門員は状況だけ。Q4。終了した年度も開ける） */
export function seesDocumentFiles(role: MaybeRole): boolean {
  return isLead(role);
}

/** 「この年度のファイルをすべて削除」を出すか（管理者で、年度が終了。Q3） */
export function canDeleteYearFiles(role: MaybeRole, status: MaybeStatus): boolean {
  return isAdmin(role) && status === 'closed';
}

/** 店長・副店長の操作（/document。管理者が店長・副店長を兼ねていても、この画面ではこの決まりだけを出す） */
export interface RepDocumentActions {
  /** 「ファイルを追加」 */
  addFile: boolean;
  /** 届いたファイルの「外す」 */
  removeFile: boolean;
  /** 届いていないファイル（予約だけ）の「外す」（提出の状態によらない。DB と同じ） */
  removePending: boolean;
  /** 「提出した」 */
  submit: boolean;
  /** 「提出を取り消す」 */
  withdraw: boolean;
}

const isOpen = (s: DocumentStatus) => s === 'not_submitted' || s === 'returned';

/**
 * 店長・副店長に出す操作（04「自団体の提出物」）：未提出・差し戻しの間は T24 の前のファイルを外す・「提出した」（足すのは T24 で止めた）、提出済みの間は取り消しだけ、
 * 承認には何も出さない。届いていないファイルはいつでも外せる。終了した年度（と年度の状態が分からないとき）は何も出さない。
 *
 * @example
 * repDocumentActions('submitted', 'requesting') // { addFile: false, removeFile: false, removePending: true, submit: false, withdraw: true }
 */
export function repDocumentActions(status: DocumentStatus, yearStatus: MaybeStatus): RepDocumentActions {
  const w = writableYear(yearStatus);
  return {
    addFile: false, // T24（D-62）：ファイルを足すのは止めた（提出物はドライブ・フォームに出す。reserve_document_file は uploads_disabled）
    removeFile: w && isOpen(status),
    removePending: w,
    submit: w && isOpen(status),
    withdraw: w && status === 'submitted',
  };
}

/** 差し戻しのボタンの種類：提出済み → 差し戻す、承認 → 承認を取り消して差し戻す、差し戻し → 理由を書き直す */
export type ReturnKind = 'return' | 'unapprove' | 'rewrite';

/** ボタンの名前（ダイアログの見出しも同じ。04「提出状況」のセルのシート） */
export const RETURN_KIND_LABELS: Readonly<Record<ReturnKind, string>> = {
  return: '差し戻す',
  unapprove: '承認を取り消して差し戻す',
  rewrite: '理由を書き直す',
};

/** 部門長以上の操作（/documents のセルのシート。canManageDocuments が真の人だけに出す） */
export interface LeadDocumentActions {
  /** 代理の「ファイルを追加」 */
  addFile: boolean;
  /** 代理の、届いたファイルの「外す」 */
  removeFile: boolean;
  /** 届いていないファイルの「外す」（状態によらない） */
  removePending: boolean;
  /** 「承認する」（提出済み） */
  approve: boolean;
  /** 差し戻しのボタン（出さなければ null） */
  returnKind: ReturnKind | null;
  /** 「紙などで受け取ったとして承認する」（未提出・差し戻し） */
  paper: boolean;
  /** 「代わりに提出する」（未提出・差し戻し） */
  submit: boolean;
  /** 「提出を取り消す」（提出済み） */
  withdraw: boolean;
}

const RETURN_KINDS: Readonly<Record<DocumentStatus, ReturnKind | null>> = {
  not_submitted: null,
  submitted: 'return',
  approved: 'unapprove',
  returned: 'rewrite',
};

/**
 * 部門長以上に出す操作（今の状態で押せるものだけ。04「提出状況」のセルのシート）。終了した年度（と年度の状態が分からないとき）は
 * 何も出さない。段（部門長以上か）は呼ぶ側が canManageDocuments で決める。
 *
 * @example
 * leadDocumentActions('approved', 'allocating').returnKind // 'unapprove'
 */
export function leadDocumentActions(status: DocumentStatus, yearStatus: MaybeStatus): LeadDocumentActions {
  const w = writableYear(yearStatus);
  const notApproved = status !== 'approved';
  return {
    addFile: false, // T24（D-62）：代理でもファイルを足すのは止めた
    removeFile: w && notApproved,
    removePending: w,
    approve: w && status === 'submitted',
    returnKind: w ? RETURN_KINDS[status] : null,
    paper: w && isOpen(status),
    submit: w && isOpen(status),
    withdraw: w && status === 'submitted',
  };
}
