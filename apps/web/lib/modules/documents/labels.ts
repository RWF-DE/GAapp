// 提出物の表示名（02 の列挙型 document_status の表示名と、画面ごとの言い方。T19・D-55。04「提出物」の呼び方・状態の印）。
// 提出状況（/documents）・自団体の提出物（/document）・ダッシュボードの欄・履歴・CSV が読む。lib/labels.ts に置かないのは、
// lib/labels.ts がどの画面の最初に読む JS にも丸ごと入るため（締切と予定の lib/modules/calendar/labels.ts と同じ）。履歴の表の名前
// （AUDIT_TABLE_LABELS の documents など）だけは共有の一覧に足す。
// import は型だけ（ダッシュボードのプロバイダ・lib/data/history.ts から読む）。
import type { Enums } from '@gaapp/shared';

/** 提出の状態（document_status） */
export type DocumentStatus = Enums<'document_status'>;

/** 状態の一覧（02 の列挙の並び：未提出・提出済み・差し戻し・承認） */
export const DOCUMENT_STATUSES: readonly DocumentStatus[] = ['not_submitted', 'submitted', 'returned', 'approved'];

/** 02 の表示名（履歴・ほかの言い方の元） */
export const DOCUMENT_STATUS_LABELS: Readonly<Record<DocumentStatus, string>> = {
  not_submitted: '未提出',
  submitted: '提出済み',
  returned: '差し戻し',
  approved: '承認',
};

/** 総務の画面と CSV の言い方（提出済みを「承認待ち」と呼ぶ） */
export const SOUMU_STATUS_LABELS: Readonly<Record<DocumentStatus, string>> = {
  ...DOCUMENT_STATUS_LABELS,
  submitted: '承認待ち',
};

/** 店長・副店長の画面の言い方（提出済みは「提出済み（総務の確認待ち）」） */
export const REP_STATUS_LABELS: Readonly<Record<DocumentStatus, string>> = {
  ...DOCUMENT_STATUS_LABELS,
  submitted: '提出済み（総務の確認待ち）',
};

/** 提出状況の絞り込み（`?status=`。all は「すべて」、overdue は未提出・差し戻しのまま締切を過ぎた） */
export type DocumentFilter = 'all' | DocumentStatus | 'overdue';

/** 絞り込みの並び（04「提出状況」：すべて・未提出・承認待ち・差し戻し・承認・締切を過ぎた） */
export const DOCUMENT_FILTERS: readonly DocumentFilter[] = ['all', 'not_submitted', 'submitted', 'returned', 'approved', 'overdue'];

/** 絞り込みの表示名 */
export const DOCUMENT_FILTER_LABELS: Readonly<Record<DocumentFilter, string>> = {
  all: 'すべて',
  not_submitted: '未提出',
  submitted: '承認待ち',
  returned: '差し戻し',
  approved: '承認',
  overdue: '締切を過ぎた',
};

/** 状態のほかの印（04「提出物」の状態の印。色だけで表さず、この文字を出す） */
export const DOCUMENT_MARK_LABELS = {
  /** 締切の後に「提出した」を押した（v_document_status の late。Q6） */
  late: '締切の後',
  /** 部門長以上が代わりに提出した（proxy） */
  proxy: '代理',
  /** 未提出・差し戻しから承認した（承認で submitted_at がない。Q9） */
  paper: '紙',
  /** 未提出・差し戻しのまま締切を過ぎた（締切ちょうどは過ぎた側） */
  overdue: '締切を過ぎた',
} as const;

/** 店長・副店長の画面の印の言い方（代理・紙） */
export const REP_MARK_TEXTS = {
  proxy: '総務が代わりに提出しました',
  paper: '紙などで受け取りました',
} as const;

/** ファイルの形（document_files.content_type の CHECK と bucket の allowed_mime_types の3つ。Q1） */
export type DocumentContentType = 'application/pdf' | 'image/jpeg' | 'image/png';

/** 形の一覧（ファイルの選びの accept と同じ並び） */
export const DOCUMENT_CONTENT_TYPES: readonly DocumentContentType[] = ['application/pdf', 'image/jpeg', 'image/png'];

/** 形の表示名（「ファイル 1（PDF・1.2 MB・10/5 17:00）」） */
export const CONTENT_TYPE_LABELS: Readonly<Record<DocumentContentType, string>> = {
  'application/pdf': 'PDF',
  'image/jpeg': 'JPEG',
  'image/png': 'PNG',
};

/** 形の拡張子（path と保存の名前。DB の document_files_object_path_check と同じ） */
export const CONTENT_TYPE_EXT: Readonly<Record<DocumentContentType, 'pdf' | 'jpg' | 'png'>> = {
  'application/pdf': 'pdf',
  'image/jpeg': 'jpg',
  'image/png': 'png',
};

/** 3つの形のどれかか */
export function isDocumentContentType(v: unknown): v is DocumentContentType {
  return typeof v === 'string' && (DOCUMENT_CONTENT_TYPES as readonly string[]).includes(v);
}

/** 状態の値か（v_document_status の status は型では null を許すので、読んだ値を確かめる） */
export function isDocumentStatus(v: unknown): v is DocumentStatus {
  return typeof v === 'string' && (DOCUMENT_STATUSES as readonly string[]).includes(v);
}

/** 読んだ状態（null・知らない値は未提出。v_document_status は行のない提出を未提出として出す） */
export function statusOf(v: unknown): DocumentStatus {
  return isDocumentStatus(v) ? v : 'not_submitted';
}
