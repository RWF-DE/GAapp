// exporter の入力（設計 13.2）。DB の行に近い形で、allocator には依存しない
import type { AllocationRow, YearData } from '@gaapp/shared';

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

export type YearExport = {
  yearLabel: string;
  data: YearData;
  rows: YearExportRow[];
  /** 書き出した日時（ISO）。省略すると書かない（同じ入力なら同じ出力にするため） */
  exportedAt?: string;
};
