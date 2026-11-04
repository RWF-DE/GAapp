// 自団体の提出物（/document。スマホ）のカードの組み立て（04「自団体の提出物」、notes/T19.md「パート B・C の約束」5。T19・D-55）。
// 純粋な関数（時計は now だけ）。カードは締切の早い順（同じなら題名 → id）、ファイルは提出物ごとに created_at → id の順に番号を付ける。
// 差し戻しの理由・前回の差し戻しの理由・承認のメモは、状態で出し分ける（書いたとおりの文字は画面が出す）。
// 並べ方は @gaapp/shared の部分の入口（order）から読む（入口〔@gaapp/shared〕は zod とルールの形まで読むので、/document の最初に読む JS に
// 入れない。FU3 の PR B の案 5）。
import { compareStrings } from '@gaapp/shared/order';
import { tokyoDate, tokyoToday } from '@/lib/datetime';
import { daysBetween, formatShortDateTimeWeekday } from '@/lib/datetime-weekday';
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

/** 締切を過ぎたときの相対の言い方（「締切と予定」の DATED_OVERDUE と同じ文字） */
export const DEADLINE_OVERDUE_TEXT = '締切を過ぎました';

/**
 * 締切の文（04「自団体の提出物」：「締切 10/5（月）17:00」。年は now の Asia/Tokyo の年と違うときだけ付ける）。読めない締切は「締切 —」。
 *
 * @example
 * deadlineText('2026-10-05T08:00:00Z', Date.parse('2026-10-01T00:00:00Z')) // '締切 10/5（月）17:00'
 */
export function deadlineText(deadline: string, now: number): string {
  const year = Number(tokyoToday(new Date(now)).slice(0, 4));
  return `締切 ${formatShortDateTimeWeekday(deadline, year) || '—'}`;
}

/**
 * 締切の相対の言い方（04「自団体の提出物」。「締切と予定」の日付の出し方〔lib/modules/portal.ts の datedRelative の締切〕と同じ決め方）：
 * 締切ちょうどからは「締切を過ぎました」、でなければ Asia/Tokyo の暦の日付の差で「今日」「明日」「あと N 日」。読めない締切は空文字。
 * lib/modules/portal.ts（並べ方・まとめ方）を /document の最初に読む JS に入れないため、ここに同じ決め方を置く（テストで比べる）。
 */
export function deadlineRelative(deadline: string, now: number): string {
  const t = Date.parse(deadline);
  if (Number.isNaN(t)) return '';
  if (t <= now) return DEADLINE_OVERDUE_TEXT;
  const n = daysBetween(tokyoToday(new Date(now)), tokyoDate(deadline));
  if (n === null) return '';
  if (n <= 0) return '今日';
  return n === 1 ? '明日' : `あと ${n} 日`;
}

/** `?document=` のカード（その団体のカードにない・形の違う値なら null） */
export function highlightedCard(cards: readonly RepDocumentCard[], param: string | null | undefined): RepDocumentCard | null {
  const v = param?.trim().toLowerCase() ?? '';
  return v === '' ? null : (cards.find((c) => c.doc.document_id === v) ?? null);
}
