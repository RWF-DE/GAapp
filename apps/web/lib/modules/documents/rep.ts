// 自団体の提出物（/document。スマホ）のカードの組み立て（04「自団体の提出物」、notes/T19.md「パート B・C の約束」5。T19・D-55）。
// 純粋な関数（時計は now だけ）。カードは締切の早い順（同じなら題名 → id）、ファイルは提出物ごとに created_at → id の順に番号を付ける。
// 差し戻しの理由・前回の差し戻しの理由・承認のメモは、状態で出し分ける（書いたとおりの文字は画面が出す）。
import { compareStrings } from '@gaapp/shared';
import { numberFiles, type NumberedFile } from './files';
import { statusOf, type DocumentStatus } from './labels';
import { documentMarks, type DocumentMarks } from './marks';
import type { DocumentFileRow, RepDocumentsData, RepDocumentStatusRow } from './reads';

// 団体の選び方は先読み（ルートのレイアウト）と同じ関数を使う（軽いモジュール reads.ts に置き、ここから同じ名前で出し直す）
export { pickDocumentGroup } from './reads';

/** カード1枚 */
export interface RepDocumentCard {
  /** 提出の状況の行（v_document_status） */
  doc: RepDocumentStatusRow;
  status: DocumentStatus;
  marks: DocumentMarks;
  /** その提出物のファイル（番号つき。created_at → id の順） */
  files: NumberedFile<DocumentFileRow>[];
  /** 差し戻しの理由（差し戻しのときだけ） */
  returnNote: string | null;
  /** 前回の差し戻しの理由（提出済みで、前に差し戻されていたとき） */
  previousReturnNote: string | null;
  /** 承認のメモ（承認のときだけ。紙などで受け取った承認のメモも） */
  approvalNote: string | null;
  /** 提出・取り消しに渡す版（v_document_status の updated_at。行のない提出は null） */
  baseVersion: string | null;
}

const timeOrInf = (iso: string) => {
  const t = Date.parse(iso);
  return Number.isNaN(t) ? Number.POSITIVE_INFINITY : t;
};

/**
 * カードを組み立てる（04「自団体の提出物」）：締切の早い順（同じなら題名 → id）。ファイルは提出物ごとに番号を付ける。
 *
 * @example
 * const cards = buildRepDocumentCards(data, now);
 */
export function buildRepDocumentCards(data: Pick<RepDocumentsData, 'statuses' | 'files'>, now: number): RepDocumentCard[] {
  const filesByDoc = new Map<string, DocumentFileRow[]>();
  for (const f of data.files) {
    const list = filesByDoc.get(f.document_id) ?? [];
    list.push(f);
    filesByDoc.set(f.document_id, list);
  }
  return [...data.statuses]
    .sort(
      (a, b) => timeOrInf(a.deadline) - timeOrInf(b.deadline) || compareStrings(a.title, b.title) || compareStrings(a.document_id, b.document_id),
    )
    .map((doc) => {
      const status = statusOf(doc.status);
      const note = doc.review_note && doc.review_note.trim() !== '' ? doc.review_note : null;
      return {
        doc,
        status,
        marks: documentMarks(doc, now),
        files: numberFiles(filesByDoc.get(doc.document_id) ?? []),
        returnNote: status === 'returned' ? note : null,
        previousReturnNote: status === 'submitted' ? note : null,
        approvalNote: status === 'approved' ? note : null,
        baseVersion: doc.updated_at ?? null,
      };
    });
}

/** `?document=` のカード（その団体のカードにない・形の違う値なら null） */
export function highlightedCard(cards: readonly RepDocumentCard[], param: string | null | undefined): RepDocumentCard | null {
  const v = param?.trim().toLowerCase() ?? '';
  return v === '' ? null : (cards.find((c) => c.doc.document_id === v) ?? null);
}
