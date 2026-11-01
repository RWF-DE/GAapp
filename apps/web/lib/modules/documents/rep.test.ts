// 自団体の提出物（/document）のカード（04「自団体の提出物」。T19）：締切の早い順・ファイルの番号・状態ごとの理由とメモ・提出の版・
// `?document=` のカード・団体の選び方（/request と同じ。先読みと同じ関数）。
import { describe, expect, it } from 'vitest';
import type { DocumentFileRow, RepDocumentStatusRow } from './reads';
import { buildRepDocumentCards, highlightedCard, pickDocumentGroup } from './rep';

const uuid = (n: number) => `00000000-0000-4000-8000-${String(n).padStart(12, '0')}`;
const G = uuid(10);
const NOW = Date.parse('2026-10-06T00:00:00Z');

const row = (n: number, over: Partial<RepDocumentStatusRow>): RepDocumentStatusRow => ({
  document_id: uuid(n),
  group_id: G,
  title: `書類${n}`,
  description: null,
  deadline: '2026-10-20T08:00:00Z',
  requires_file: true,
  status: 'not_submitted',
  submitted_at: null,
  proxy: false,
  late: false,
  reviewed_at: null,
  review_note: null,
  updated_at: null,
  ...over,
});
const file = (id: string, n: number, created_at: string): DocumentFileRow => ({
  id,
  document_id: uuid(n),
  group_id: G,
  object_path: `y/${G}/${uuid(n)}/${id}.pdf`,
  content_type: 'application/pdf',
  size: 100,
  created_at,
  uploaded: true,
  stored_size: 100,
});

describe('T19 buildRepDocumentCards', () => {
  it('締切の早い順（同じなら題名 → id）。ファイルは提出物ごとに created_at → id の順に番号', () => {
    const cards = buildRepDocumentCards(
      {
        statuses: [row(3, { title: 'B', deadline: '2026-10-20T08:00:00Z' }), row(1, { title: 'A', deadline: '2026-10-20T08:00:00Z' }), row(2, { deadline: '2026-10-05T08:00:00Z' })],
        files: [file('f-b', 1, '2026-10-02T00:00:00Z'), file('f-a', 1, '2026-10-01T00:00:00Z'), file('f-c', 2, '2026-10-01T00:00:00Z')],
      },
      NOW,
    );
    expect(cards.map((c) => c.doc.document_id)).toEqual([uuid(2), uuid(1), uuid(3)]);
    expect(cards[1]!.files.map((f) => [f.n, f.file.id])).toEqual([
      [1, 'f-a'],
      [2, 'f-b'],
    ]);
    expect(cards[0]!.files.map((f) => f.file.id)).toEqual(['f-c']);
    expect(cards[2]!.files).toEqual([]);
    // 締切を過ぎた未提出には締切を過ぎた印
    expect(cards[0]!.marks.overdue).toBe(true);
  });

  it('差し戻しは理由、提出済みは前回の差し戻しの理由、承認はメモ。行のない提出は版が null', () => {
    const [returned, submitted, approved, fresh] = buildRepDocumentCards(
      {
        statuses: [
          row(1, { status: 'returned', review_note: '印鑑がありません', reviewed_at: '2026-10-04T00:00:00Z', updated_at: 'v1', deadline: '2026-10-07T00:00:00Z' }),
          row(2, { status: 'submitted', review_note: '前の理由', submitted_at: '2026-10-05T00:00:00Z', updated_at: 'v2', deadline: '2026-10-08T00:00:00Z' }),
          row(3, { status: 'approved', review_note: '10/3 に紙で受け取りました', reviewed_at: '2026-10-03T00:00:00Z', updated_at: 'v3', deadline: '2026-10-09T00:00:00Z' }),
          row(4, { deadline: '2026-10-10T00:00:00Z' }),
        ],
        files: [],
      },
      NOW,
    );
    expect(returned).toMatchObject({ status: 'returned', returnNote: '印鑑がありません', previousReturnNote: null, approvalNote: null, baseVersion: 'v1' });
    expect(submitted).toMatchObject({ status: 'submitted', returnNote: null, previousReturnNote: '前の理由', approvalNote: null, baseVersion: 'v2' });
    expect(approved).toMatchObject({ status: 'approved', approvalNote: '10/3 に紙で受け取りました', marks: { paper: true } });
    expect(fresh).toMatchObject({ status: 'not_submitted', returnNote: null, previousReturnNote: null, approvalNote: null, baseVersion: null });
    // 空白だけの理由は出さない
    const [blank] = buildRepDocumentCards({ statuses: [row(5, { status: 'returned', review_note: '  ' })], files: [] }, NOW);
    expect(blank!.returnNote).toBeNull();
  });

  it('`?document=` はその団体のカードだけ（ない・形の違う値は null。大文字も読む）', () => {
    const cards = buildRepDocumentCards({ statuses: [row(1, {}), row(2, {})], files: [] }, NOW);
    expect(highlightedCard(cards, uuid(2))?.doc.document_id).toBe(uuid(2));
    expect(highlightedCard(cards, uuid(2).toUpperCase())?.doc.document_id).toBe(uuid(2));
    expect(highlightedCard(cards, uuid(9))).toBeNull();
    expect(highlightedCard(cards, '')).toBeNull();
    expect(highlightedCard(cards, null)).toBeNull();
  });

  it('pickDocumentGroup：`?group=` が自分の団体ならそれ、なければ最初の団体、団体がなければ null', () => {
    const groups = [{ id: 'g1' }, { id: 'g2' }];
    expect(pickDocumentGroup(groups, 'g2')).toEqual({ id: 'g2' });
    expect(pickDocumentGroup(groups, 'other')).toEqual({ id: 'g1' });
    expect(pickDocumentGroup(groups, null)).toEqual({ id: 'g1' });
    expect(pickDocumentGroup([], 'g1')).toBeNull();
  });
});
