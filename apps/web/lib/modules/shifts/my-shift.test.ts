// 自分のシフト（/shift）の組み立て（04「自分のシフト」、notes/T20.md「画面の約束」5。T20）：今・次の印（始まりちょうどは今、終わりちょうどは
// 終わった）、日の並び（今日 → これから → 終わった日は新しい順）、日の見出し・祭の日・今日と明日、同じますの人（自分を除く・表示名の順・
// 名前のない人）、読めない行を出さない。
import { describe, expect, it } from 'vitest';
import { buildMyShiftDays } from './my-shift';
import type { MyShiftRow } from './reads';

const uuid = (n: number) => `00000000-0000-4000-8000-${String(n).padStart(12, '0')}`;
const ME = uuid(1);
const A = uuid(2);
const B = uuid(3);
const C = uuid(4);
const names = new Map([
  [ME, '部門員C'],
  [A, '部門員A'],
  [B, '部門員B'],
]);
const FESTIVAL = '2027-10-16';

const row = (n: number, starts_at: string, ends_at: string, duty: string, mates: string[] = [], place: string | null = null, note: string | null = null): MyShiftRow => ({
  slot_id: uuid(100 + n),
  duty_id: uuid(200 + n),
  updated_at: 't',
  shift_needs: {
    required_count: 2,
    shift_slots: { id: uuid(100 + n), starts_at, ends_at },
    shift_duties: { id: uuid(200 + n), name: duty, place, note },
    shift_assignments: [ME, ...mates].map((user_id) => ({ user_id })),
  },
});

/** 今：2027-10-15（金・前日）10:00 Asia/Tokyo */
const NOW = Date.parse('2027-10-15T01:00:00Z');

const rows = (): MyShiftRow[] => [
  row(1, '2027-10-15T00:00:00Z', '2027-10-15T01:00:00Z', '受付'), // 今日 09:00〜10:00（終わりちょうど＝終わった）
  row(2, '2027-10-15T01:00:00Z', '2027-10-15T02:00:00Z', '運搬', [B, A, C], '正門', '台車を使う\n2人で'), // 今日 10:00〜11:00（今）
  row(3, '2027-10-15T05:00:00Z', '2027-10-15T06:00:00Z', '見回り'), // 今日 14:00（次）
  row(4, '2027-10-16T00:00:00Z', '2027-10-16T01:00:00Z', '受付'), // 明日（1日目）
  row(5, '2027-10-13T00:00:00Z', '2027-10-13T01:00:00Z', '設営'), // 終わった日（10/13）
  row(6, '2027-10-14T00:00:00Z', '2027-10-14T01:00:00Z', '設営'), // 終わった日（10/14・前々日）
  row(7, '2027-10-20T00:00:00Z', '2027-10-20T01:00:00Z', '片付け'),
];

describe('T20 自分のシフト（buildMyShiftDays）', () => {
  it('日の並び：今日 → これからの日（早い順）→ 終わった日（新しい順）。日の中は開始の順', () => {
    const days = buildMyShiftDays(rows(), names, ME, NOW, FESTIVAL);
    expect(days.map((d) => [d.date, d.past])).toEqual([
      ['2027-10-15', false],
      ['2027-10-16', false],
      ['2027-10-20', false],
      ['2027-10-14', true],
      ['2027-10-13', true],
    ]);
    expect(days[0]!.items.map((i) => i.time)).toEqual(['09:00〜10:00', '10:00〜11:00', '14:00〜15:00']);
  });

  it('見出し・祭の日・今日と明日', () => {
    const days = buildMyShiftDays(rows(), names, ME, NOW, FESTIVAL);
    expect(days.map((d) => [d.heading, d.festival, d.relative])).toEqual([
      ['10月15日（金）', '前日', '今日'],
      ['10月16日（土）', '1日目', '明日'],
      ['10月20日（水）', null, null],
      ['10月14日（木）', '前々日', null],
      ['10月13日（水）', null, null],
    ]);
  });

  it('今の枠（始まり ≤ 今 < 終わり）に今、これからの最初の枠に次（終わりちょうどの枠は今でない）', () => {
    const today = buildMyShiftDays(rows(), names, ME, NOW, FESTIVAL)[0]!.items;
    expect(today.map((i) => [i.dutyName, i.isNow, i.isNext])).toEqual([
      ['受付', false, false],
      ['運搬', true, false],
      ['見回り', false, true],
    ]);
    // 始まりちょうどは今
    const at = buildMyShiftDays(rows(), names, ME, Date.parse('2027-10-15T05:00:00Z'), FESTIVAL)[0]!.items;
    expect(at.map((i) => [i.dutyName, i.isNow, i.isNext])).toEqual([
      ['受付', false, false],
      ['運搬', false, false],
      ['見回り', true, false],
    ]);
    // 次はほかの日にもまたがって最初の1つだけ
    expect(buildMyShiftDays(rows(), names, ME, Date.parse('2027-10-15T05:30:00Z'), FESTIVAL).flatMap((d) => d.items.filter((i) => i.isNext).map((i) => i.dutyName))).toEqual(['受付']);
  });

  it('同じますの人：自分を除き、表示名の順（名前のない人は後で null）。場所と説明', () => {
    const item = buildMyShiftDays(rows(), names, ME, NOW, FESTIVAL)[0]!.items[1]!;
    expect(item.mates.map((m) => m.name)).toEqual(['部門員A', '部門員B', null]);
    expect([item.place, item.note]).toEqual(['正門', '台車を使う\n2人で']);
  });

  it('時間枠・持ち場が読めない行は出さない。割り当てがなければ空', () => {
    const broken: MyShiftRow = { ...row(9, '2027-10-15T00:00:00Z', '2027-10-15T01:00:00Z', 'x'), shift_needs: null };
    expect(buildMyShiftDays([broken], names, ME, NOW, FESTIVAL)).toEqual([]);
    expect(buildMyShiftDays([], names, ME, NOW, FESTIVAL)).toEqual([]);
  });
});
