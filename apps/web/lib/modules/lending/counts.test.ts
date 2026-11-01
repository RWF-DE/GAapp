// テント等の貸し出しの数え方（T21・D-57。notes/T21.md「画面の約束」3）：並べ方、備品ごとの合計と残り、3つの在庫超過、未入力、
// 「申請どおりに入れる」、確定の押せない理由の順、締切の後の読み方、記録の状態の4つと2日目・祭の後の境目（Asia/Tokyo の 0 時の前後。
// 端末のタイムゾーンによらない）、要約の文、ダッシュボードの団体の数。
import { describe, expect, it } from 'vitest';
import type { YearRow } from '@/lib/db/types';
import {
  cellKey,
  compareLendingGroups,
  confirmBlockers,
  countMap,
  festivalDay2Started,
  festivalOver,
  fillRequested,
  lendingGroupCounts,
  lendingSummaryLine,
  lendingTotals,
  outstandingGroupIds,
  overStockItemIds,
  recordState,
  requestOverStockItemIds,
  requestsClosed,
  sortLendingGroups,
  sortLendingItems,
  unassignedPairs,
  unresolvedOverStockItemIds,
} from './counts';

const TENT = { id: 'i-tent', name: 'テント', unit: '張', stock: 3, sort_order: 1 };
const WEIGHT = { id: 'i-weight', name: '重し', unit: '個', stock: 20, sort_order: 2 };
const CURTAIN = { id: 'i-curtain', name: '三方幕', unit: '枚', stock: 2, sort_order: 3 };
const ITEMS = [CURTAIN, TENT, WEIGHT];

const req = (g: string, i: string, count: number) => ({ group_id: g, lending_item_id: i, count });
const rec = (g: string, i: string, lent: number, returned: number, damaged = 0) => ({
  group_id: g,
  lending_item_id: i,
  lent_count: lent,
  returned_count: returned,
  damaged_count: damaged,
});

/** 1日目 2026-10-17（Asia/Tokyo） */
const YEAR = { festival_start: '2026-10-17' } satisfies Pick<YearRow, 'festival_start'>;
const tokyo = (s: string) => Date.parse(`${s}+09:00`);

describe('T21 並べ方', () => {
  it('備品：並び → 名前（コードポイントの順。大文字が先）→ id', () => {
    const rows = [
      { id: 'b', name: 'T-a', sort_order: 1 },
      { id: 'a', name: 'T-a', sort_order: 1 },
      { id: 'c', name: 'T-B', sort_order: 1 },
      { id: 'd', name: 'あ', sort_order: 0 },
    ];
    expect(sortLendingItems(rows).map((r) => r.id)).toEqual(['d', 'c', 'a', 'b']);
    // 元の配列は変えない
    expect(rows.map((r) => r.id)).toEqual(['b', 'a', 'c', 'd']);
  });

  it('団体：区分（模擬店 → 部門 → 企業 → 休憩所）→ 並び → 名前 → id', () => {
    const groups = [
      { id: 'r', name: '休憩所A', category: 'rest_area' as const, sort_order: 0 },
      { id: 'c', name: '企業A', category: 'company' as const, sort_order: 0 },
      { id: 'd2', name: '部門B', category: 'department' as const, sort_order: 1 },
      { id: 'd1', name: '部門A', category: 'department' as const, sort_order: 1 },
      { id: 's', name: '模擬店Z', category: 'stall' as const, sort_order: 9 },
    ];
    expect(sortLendingGroups(groups).map((g) => g.id)).toEqual(['s', 'd1', 'd2', 'c', 'r']);
    expect(compareLendingGroups(groups[3]!, groups[2]!)).toBeLessThan(0);
  });
});

describe('T21 備品ごとの合計（lendingTotals）', () => {
  // G1・G2 がテントを 2 ずつ（申請合計 4 > 在庫 3）、G1 だけ割り当て 2。G2 のテントは未入力
  const requests = [req('g1', TENT.id, 2), req('g2', TENT.id, 2), req('g1', WEIGHT.id, 8), req('g1', CURTAIN.id, 1), req('g3', WEIGHT.id, 0)];
  const assignments = [req('g1', TENT.id, 2), req('g1', WEIGHT.id, 8), req('g3', WEIGHT.id, 0)];
  const records = [rec('g1', TENT.id, 2, 1), rec('g1', WEIGHT.id, 8, 8, 1)];

  it('申請合計・割り当て合計・未入力の組の申請・渡した・返った・破損・残り（備品の並び）', () => {
    const t = lendingTotals(ITEMS, requests, assignments, records);
    expect(t.map((x) => x.itemId)).toEqual([TENT.id, WEIGHT.id, CURTAIN.id]);
    expect(t[0]).toEqual({ itemId: TENT.id, stock: 3, requested: 4, assigned: 2, unassignedRequested: 2, lent: 2, returned: 1, damaged: 0, remaining: 1 });
    // 申請 0 の組（g3 の重し）と、行があって 0 の割り当ては未入力に数えない
    expect(t[1]).toMatchObject({ requested: 8, assigned: 8, unassignedRequested: 0, lent: 8, returned: 8, damaged: 1, remaining: 12 });
    expect(t[2]).toMatchObject({ requested: 1, assigned: 0, unassignedRequested: 1, remaining: 2 });
  });

  it('備品にない行は数えない。割り当てが在庫を超えれば残りは負', () => {
    const t = lendingTotals([TENT], [req('g1', 'gone', 5)], [req('g1', TENT.id, 5)], [rec('g1', 'gone', 1, 0)]);
    expect(t).toEqual([{ itemId: TENT.id, stock: 3, requested: 0, assigned: 5, unassignedRequested: 0, lent: 0, returned: 0, damaged: 0, remaining: -2 }]);
  });

  it('3つの在庫超過：割り当て合計 > 在庫（確定を止める）、割り当て合計＋未入力の申請 > 在庫（ダッシュボード）、申請合計 > 在庫（/lending の印）', () => {
    const t = lendingTotals(ITEMS, requests, assignments, records);
    expect(overStockItemIds(t)).toEqual([]);
    // テント：割り当て 2 ＋ 未入力 2 = 4 > 3
    expect(unresolvedOverStockItemIds(t)).toEqual([TENT.id]);
    expect(requestOverStockItemIds(t)).toEqual([TENT.id]);
    // 在庫ちょうどは超えていない
    const exact = lendingTotals([TENT], [req('g1', TENT.id, 3)], [req('g1', TENT.id, 3)], []);
    expect(overStockItemIds(exact)).toEqual([]);
    expect(unresolvedOverStockItemIds(exact)).toEqual([]);
    expect(requestOverStockItemIds(exact)).toEqual([]);
    const over = lendingTotals([TENT], [req('g1', TENT.id, 1)], [req('g1', TENT.id, 4)], []);
    expect(overStockItemIds(over)).toEqual([TENT.id]);
    expect(unresolvedOverStockItemIds(over)).toEqual([TENT.id]);
    expect(requestOverStockItemIds(over)).toEqual([]);
  });

  it('未入力の組：申請が1以上で割り当ての行がない（行があれば 0 でも入力済み）', () => {
    expect(unassignedPairs(requests, assignments)).toEqual([
      { groupId: 'g2', itemId: TENT.id, count: 2 },
      { groupId: 'g1', itemId: CURTAIN.id, count: 1 },
    ]);
    expect(unassignedPairs([req('g1', TENT.id, 2)], [req('g1', TENT.id, 0)])).toEqual([]);
  });

  it('countMap：組のキー → 数', () => {
    expect(countMap(assignments).get(cellKey('g1', TENT.id))).toBe(2);
    expect(countMap(assignments).get(cellKey('g2', TENT.id))).toBeUndefined();
  });
});

describe('T21 締切の後と確定の押せない理由', () => {
  const close = '2026-10-05T08:00:00Z';
  const y = (status: YearRow['status'], request_close_at: string | null = close) => ({ status, request_close_at });

  it('requestsClosed：受付中で締切を過ぎた（ちょうどを含む）・振り分け中・確定。準備中は締切の日時によらず前、終了と締切のない受付中は偽', () => {
    expect(requestsClosed(y('requesting'), Date.parse(close) - 1)).toBe(false);
    expect(requestsClosed(y('requesting'), Date.parse(close))).toBe(true);
    expect(requestsClosed(y('requesting', null), Date.parse(close) + 1)).toBe(false);
    expect(requestsClosed(y('preparing'), Date.parse(close) + 1)).toBe(false);
    expect(requestsClosed(y('allocating', null), 0)).toBe(true);
    expect(requestsClosed(y('confirmed', null), 0)).toBe(true);
    expect(requestsClosed(y('closed'), Date.parse(close) + 1)).toBe(false);
  });

  it('押せない理由の順：締切の前 → 在庫超過 → 未入力（備品ごとの団体の数。備品の並び）→ 保存していない変更', () => {
    const totals = lendingTotals(ITEMS, [req('g1', TENT.id, 2), req('g2', TENT.id, 2), req('g3', CURTAIN.id, 1)], [req('g1', WEIGHT.id, 21)], []);
    const unassigned = unassignedPairs([req('g1', TENT.id, 2), req('g2', TENT.id, 2), req('g3', CURTAIN.id, 1)], [req('g1', WEIGHT.id, 21)]);
    expect(confirmBlockers({ year: y('requesting'), now: Date.parse(close) - 1, totals, unassigned, unsaved: 2 })).toEqual([
      { kind: 'before_deadline' },
      { kind: 'over_stock', itemIds: [WEIGHT.id] },
      {
        kind: 'unassigned',
        items: [
          { itemId: TENT.id, groups: 2 },
          { itemId: CURTAIN.id, groups: 1 },
        ],
      },
      { kind: 'unsaved', count: 2 },
    ]);
    const ok = lendingTotals(ITEMS, [req('g1', TENT.id, 2)], [req('g1', TENT.id, 2)], []);
    expect(confirmBlockers({ year: y('allocating'), now: 0, totals: ok, unassigned: [], unsaved: 0 })).toEqual([]);
  });
});

describe('T21 申請どおりに入れる（fillRequested）', () => {
  const requests = [req('g1', TENT.id, 2), req('g2', TENT.id, 1), req('g3', TENT.id, 0), req('g4', TENT.id, 3), req('g1', WEIGHT.id, 5)];
  const assignments = [req('g4', TENT.id, 1)];

  it('割り当ての行がなく未保存の変更もないセルのうち、申請が1以上のものに申請の数を入れる（その備品だけ）', () => {
    expect(fillRequested(TENT.id, requests, assignments, new Set([cellKey('g2', TENT.id)]))).toEqual([{ groupId: 'g1', itemId: TENT.id, count: 2 }]);
  });

  it('割り当てのあるセル・申請 0・ほかの備品・年度にない団体は入れない', () => {
    expect(fillRequested(TENT.id, requests, assignments, new Set(), new Set(['g2', 'g4']))).toEqual([{ groupId: 'g2', itemId: TENT.id, count: 1 }]);
    expect(fillRequested(WEIGHT.id, requests, [req('g1', WEIGHT.id, 0)], new Set())).toEqual([]);
  });
});

describe('T21 受け渡し・返却の状態と2日目・祭の後（Asia/Tokyo）', () => {
  const beforeDay2 = tokyo('2026-10-17T23:59:59.999');
  const day2 = tokyo('2026-10-18T00:00:00');
  const over = tokyo('2026-10-19T00:00:00');

  it('2日目は1日目の翌日の 0 時、祭の後は2日後の 0 時から（ちょうどを含む）。1日目が読めなければ偽', () => {
    expect(festivalDay2Started(YEAR, beforeDay2)).toBe(false);
    expect(festivalDay2Started(YEAR, day2)).toBe(true);
    expect(festivalOver(YEAR, over - 1)).toBe(false);
    expect(festivalOver(YEAR, over)).toBe(true);
    expect(festivalDay2Started({ festival_start: 'x' }, over)).toBe(false);
    expect(festivalOver({ festival_start: '' }, over)).toBe(false);
    // UTC の日付ではなく Asia/Tokyo（2026-10-17T15:00Z は Tokyo の 10/18 0 時）
    expect(festivalDay2Started(YEAR, Date.parse('2026-10-17T15:00:00Z'))).toBe(true);
    expect(festivalDay2Started(YEAR, Date.parse('2026-10-17T14:59:59Z'))).toBe(false);
  });

  it('渡す前（記録なし・渡した数がすべて 0）、貸し出し中（2日目の前）、未返却（2日目から）、返却済み', () => {
    expect(recordState([], YEAR, day2)).toBe('before');
    expect(recordState([rec('g', 'a', 0, 0)], YEAR, day2)).toBe('before');
    expect(recordState([rec('g', 'a', 2, 1)], YEAR, beforeDay2)).toBe('lent');
    expect(recordState([rec('g', 'a', 2, 1)], YEAR, day2)).toBe('unreturned');
    expect(recordState([rec('g', 'a', 2, 2), rec('g', 'b', 0, 0)], YEAR, day2)).toBe('returned');
    expect(recordState([rec('g', 'a', 2, 2), rec('g', 'b', 1, 0)], YEAR, day2)).toBe('unreturned');
  });

  it('渡した数 > 返った数の備品がある団体', () => {
    expect([...outstandingGroupIds([rec('g1', 'a', 2, 1), rec('g2', 'a', 1, 1), rec('g3', 'a', 0, 0)])]).toEqual(['g1']);
  });
});

describe('T21 要約の文と団体の数', () => {
  it('「テント 2・重し 8」（数が1以上の備品を備品の並びで。0 は出さない。なければ空）', () => {
    const counts = new Map([
      [WEIGHT.id, 8],
      [TENT.id, 2],
      [CURTAIN.id, 0],
    ]);
    expect(lendingSummaryLine(ITEMS, (id) => counts.get(id) ?? 0)).toBe('テント 2・重し 8');
    expect(lendingSummaryLine(ITEMS, () => 0)).toBe('');
  });

  it('申請の団体・割り当ての団体（M）・そのうち渡した団体（N）・未返却の団体（K。割り当てによらない）', () => {
    const c = lendingGroupCounts(
      [req('g1', TENT.id, 2), req('g2', TENT.id, 0), req('g3', WEIGHT.id, 1)],
      [req('g1', TENT.id, 2), req('g2', TENT.id, 0), req('g4', WEIGHT.id, 1)],
      [rec('g1', TENT.id, 2, 1), rec('g5', WEIGHT.id, 1, 0), rec('g4', WEIGHT.id, 0, 0)],
    );
    expect(c).toEqual({ requested: 2, assigned: 2, lent: 1, unreturned: 2 });
  });
});
