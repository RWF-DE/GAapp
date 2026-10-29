// exporter の入力（設計 13.2）。DB の行に近い形で、allocator には依存しない
import type { AllocationRow, Consent, DistanceOverride, Group, Item, RequestRow, Room, Rule, StockRow, YearData } from '@gaapp/shared';

/** 振り分けの1行。note は allocations.note（手で書いた備考）。なければ exporter が自動の備考を付ける */
export type ExportRow = AllocationRow & { note?: string | null };

export type ReportInput = {
  /** 年度のラベル（例：R8）。ファイル名と「在庫(R8数え)」の見出しに使う */
  yearLabel: string;
  /** items（name）、rooms（name・usable・sortOrder）、groups（name・displayName・category・submittedAt・sortOrder・locationRoomId）、stocks、rules、consents */
  data: YearData;
  /** その年度の全行（固定・手動・自動・keep） */
  rows: ExportRow[];
  /** ブックの作成日時（省略すると現在）。テストで同じ出力にしたいときに渡す */
  generatedAt?: Date;
};

/** 年度データ（JSON）に載せる振り分けの行。DB から読んだ行は id・origin・pinned を持つ */
export type YearExportRow = ExportRow & { id?: string; origin?: 'auto' | 'manual'; pinned?: boolean };

/** 年度データの品目。DB の items の行に近い形（aliases はフォームでの表記） */
export type ExportItem = Item & { aliases: string[] };
export type ExportRoom = Room & { aliases: string[] };
/** groups の行。提出日時は request_submissions の行（submissions）に持つ */
export type ExportGroup = Omit<Group, 'submittedAt'> & { aliases: string[]; isFood: boolean };
/** request_submissions の行 */
export type ExportSubmission = { groupId: string; submittedAt: string | null; note: string | null };
/** rules の行。無効（enabled = false）のルールも含め、メモも持つ（F1-8：年度をまたいで引き継ぐため） */
export type ExportRule = Rule & { enabled: boolean; memo: string | null };
export type ExportConsent = Consent & { note: string | null };

/**
 * 年度データ（JSON）の入力。DB の行に近い形で、振り分けの計算に使う YearData より多く持つ
 * （無効なルール・メモ・別名・食品か・申請の備考・了承の備考）。メールアドレスに当たる項目は型にも持たない。
 */
export type YearExport = {
  yearLabel: string;
  items: ExportItem[];
  rooms: ExportRoom[];
  groups: ExportGroup[];
  stocks: StockRow[];
  requests: RequestRow[];
  submissions: ExportSubmission[];
  rules: ExportRule[];
  consents: ExportConsent[];
  distanceOverrides: DistanceOverride[];
  rows: YearExportRow[];
  /** 書き出した日時（ISO）。省略すると書かない（同じ入力なら同じ出力にするため） */
  exportedAt?: string;
};
