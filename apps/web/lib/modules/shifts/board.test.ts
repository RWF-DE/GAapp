// シフト表の組み立て（04「シフト表」「シフト表の印刷」、notes/T20.md「画面の約束」4・6。T20）：日の分け方（Asia/Tokyo の日付の境目・0 時を
// またぐ枠は開始の日）、日の名前（祭の日・年の違い）、既定の日、列の並び（sort_order → 名前 → id、部門員はますのある持ち場だけ）、ますの
// 状態（none・ok・short・over・必要人数 0）と数（総務でない人を数えない〔部門長以上〕・数える〔部門員〕）、合計、読み上げの名前、足りない
// ます（これからの時間枠だけ）、人を選ぶ一覧（入っている・ほかのますに入っている・選べる、この日の枠の数）、人ごとのまとめ、1日分の時間枠
// （区切り・最後の枠を切る・24:00・96 の上限）、重なり、書いた後のキャッシュ、時刻の出し方。
import { describe, expect, it } from 'vitest';
import {
  boardWithAssignment,
  boardWithNeed,
  boardWithoutAssignment,
  boardWithoutNeed,
  buildShiftTable,
  cellAriaLabel,
  cellCountText,
  cellDiffText,
  chunk,
  compareDuties,
  DAY_PLAN_MAX,
  defaultShiftDay,
  dutyUsage,
  isShortCell,
  memberChoices,
  otherCellsOfSlot,
  overlappingSlots,
  peopleOfDay,
  pickShiftDay,
  shiftDays,
  slotAssignmentCount,
  slotLabelLookup,
  slotsOfDayPlan,
  slotsOverlap,
  totalText,
  type BoardDuty,
  type BoardSlot,
  type ShiftBoard,
} from './board';
import { festivalDayName, isSlotNow, isSlotPast, isSlotUpcoming, shiftDayLabel, slotDayOf, slotTimeLabel } from './time';

const uuid = (n: number) => `00000000-0000-4000-8000-${String(n).padStart(12, '0')}`;
const D_RECEPTION = uuid(1);
const D_CARRY = uuid(2);
const D_SPARE = uuid(3);
const S1 = uuid(11);
const S2 = uuid(12);
const S3 = uuid(13);
const U_ME = uuid(21);
const U_A = uuid(22);
const U_B = uuid(23);
const U_VIEWER = uuid(24);
const T = '2027-10-01T00:00:00.000001+00:00';

const duty = (id: string, name: string, sort_order: number, place: string | null = null): BoardDuty => ({ id, name, place, note: null, sort_order, updated_at: T });
const slot = (id: string, starts_at: string, ends_at: string, needs: BoardSlot['shift_needs'] = []): BoardSlot => ({ id, starts_at, ends_at, updated_at: T, shift_needs: needs });
const need = (duty_id: string, required_count: number, users: string[] = []) => ({
  duty_id,
  required_count,
  updated_at: T,
  shift_assignments: users.map((user_id) => ({ user_id, updated_at: T })),
});

/** 1日目 10/16。10/15（前日）に 09:00〜10:00 と 10:00〜11:00、10/18 に 1 枠 */
const FESTIVAL = '2027-10-16';
const board = (): ShiftBoard => ({
  duties: [duty(D_CARRY, '運搬', 2), duty(D_RECEPTION, '受付', 1, '正門'), duty(D_SPARE, '予備', 2)],
  slots: [
    slot(S2, '2027-10-15T01:00:00Z', '2027-10-15T02:00:00Z', [need(D_RECEPTION, 1, [U_A, U_B])]),
    slot(S1, '2027-10-15T00:00:00Z', '2027-10-15T01:00:00Z', [need(D_RECEPTION, 3, [U_ME, U_A]), need(D_CARRY, 0, [U_B])]),
    slot(S3, '2027-10-18T00:00:00Z', '2027-10-18T01:00:00Z', [need(D_CARRY, 1, [U_VIEWER])]),
  ],
});
const names = new Map([
  [U_ME, '部門員C'],
  [U_A, '部門員A'],
  [U_B, '部門員B'],
]);
/** 2027-10-14 12:00（Asia/Tokyo） */
const NOW = Date.parse('2027-10-14T03:00:00Z');

describe('T20 時刻と日（time.ts）', () => {
  it('時間枠の時刻：同じ日は「09:00〜10:00」、次の日なら「23:00〜翌 01:00」、ちょうど次の日の 0 時なら「23:00〜24:00」', () => {
    expect(slotTimeLabel({ starts_at: '2027-10-15T00:00:00Z', ends_at: '2027-10-15T01:00:00Z' })).toBe('09:00〜10:00');
    expect(slotTimeLabel({ starts_at: '2027-10-15T14:00:00Z', ends_at: '2027-10-15T16:00:00Z' })).toBe('23:00〜翌 01:00');
    expect(slotTimeLabel({ starts_at: '2027-10-15T14:00:00Z', ends_at: '2027-10-15T15:00:00Z' })).toBe('23:00〜24:00');
    expect(slotTimeLabel({ starts_at: 'x', ends_at: 'y' })).toBe('');
  });

  it('日は開始の Asia/Tokyo の日付（UTC 15:00 が境目。0 時をまたぐ枠は開始の日）', () => {
    expect(slotDayOf({ starts_at: '2027-10-14T14:59:59.999Z' })).toBe('2027-10-14');
    expect(slotDayOf({ starts_at: '2027-10-14T15:00:00Z' })).toBe('2027-10-15');
  });

  it('今・終わった・これから（始まり ≤ 今 < 終わり。終わりちょうどは終わった側）', () => {
    const s = { starts_at: '2027-10-14T03:00:00Z', ends_at: '2027-10-14T04:00:00Z' };
    expect(isSlotNow(s, NOW)).toBe(true);
    expect(isSlotNow(s, Date.parse(s.ends_at))).toBe(false);
    expect(isSlotPast(s, Date.parse(s.ends_at))).toBe(true);
    expect(isSlotUpcoming(s, Date.parse(s.ends_at) - 1)).toBe(true);
    expect(isSlotUpcoming(s, Date.parse(s.ends_at))).toBe(false);
  });

  it('祭の日の名前（前々日・前日・1日目・2日目。ほかは null）と日のタブの名前（年が違えば年も）', () => {
    expect(['2027-10-14', '2027-10-15', '2027-10-16', '2027-10-17', '2027-10-18'].map((d) => festivalDayName(d, FESTIVAL))).toEqual([
      '前々日',
      '前日',
      '1日目',
      '2日目',
      null,
    ]);
    expect(shiftDayLabel('2027-10-15', FESTIVAL, NOW)).toBe('前日（10/15）');
    expect(shiftDayLabel('2027-10-18', FESTIVAL, NOW)).toBe('10/18（月）');
    const in2026 = Date.parse('2026-12-31T03:00:00Z');
    expect(shiftDayLabel('2027-10-15', FESTIVAL, in2026)).toBe('前日（2027/10/15）');
    expect(shiftDayLabel('2027-10-18', FESTIVAL, in2026)).toBe('2027/10/18（月）');
  });
});

describe('T20 日のタブ（shiftDays・defaultShiftDay・pickShiftDay）', () => {
  it('時間枠のある日を早い順に（同じ日は1つ）', () => {
    expect(shiftDays(board().slots, FESTIVAL, NOW)).toEqual([
      { date: '2027-10-15', label: '前日（10/15）' },
      { date: '2027-10-18', label: '10/18（月）' },
    ]);
  });

  it('既定：今日に時間枠があれば今日、なければ今日より後で最初の日、それもなければ最後の日。日がなければ null', () => {
    const days = [{ date: '2027-10-15' }, { date: '2027-10-18' }];
    expect(defaultShiftDay(days, Date.parse('2027-10-15T05:00:00Z'))).toBe('2027-10-15');
    expect(defaultShiftDay(days, NOW)).toBe('2027-10-15');
    expect(defaultShiftDay(days, Date.parse('2027-10-16T05:00:00Z'))).toBe('2027-10-18');
    expect(defaultShiftDay(days, Date.parse('2027-10-20T05:00:00Z'))).toBe('2027-10-18');
    expect(defaultShiftDay([], NOW)).toBeNull();
  });

  it('?day= は時間枠のある日ならそれ、ない日・形の違う値・なしなら既定', () => {
    const days = [{ date: '2027-10-15' }, { date: '2027-10-18' }];
    expect(pickShiftDay(days, '2027-10-18', NOW)).toBe('2027-10-18');
    expect(pickShiftDay(days, ' 2027-10-18 ', NOW)).toBe('2027-10-18');
    for (const v of ['2027-10-17', 'x', '', null, undefined]) expect(pickShiftDay(days, v, NOW)).toBe('2027-10-15');
  });
});

describe('T20 表（buildShiftTable）', () => {
  const opts = { allDuties: true, roles: null, names, userId: U_ME } as const;

  it('行はその日の時間枠（開始の順）、列は部門長以上は持ち場の全部（sort_order → 名前 → id）、部門員はその日にますのある持ち場だけ', () => {
    const t = buildShiftTable(board(), '2027-10-15', opts);
    expect(t.rows.map((r) => [r.slot.id, r.label])).toEqual([
      [S1, '09:00〜10:00'],
      [S2, '10:00〜11:00'],
    ]);
    expect(t.columns.map((c) => c.name)).toEqual(['受付', '運搬', '予備']);
    expect(buildShiftTable(board(), '2027-10-15', { ...opts, allDuties: false }).columns.map((c) => c.name)).toEqual(['受付', '運搬']);
    expect(compareDuties(duty('b', 'あ', 1), duty('a', 'あ', 1))).toBeGreaterThan(0);
  });

  it('ますの状態と文：足りない「2/3 あと1人」、そろう、多い「+1」、必要人数 0 は「1人」、ますのない所は「—」', () => {
    const t = buildShiftTable(board(), '2027-10-15', opts);
    const [s1, s2] = t.rows;
    const short = s1!.cells[0]!;
    expect([short.state, cellCountText(short), cellDiffText(short)]).toEqual(['short', '2/3', 'あと1人']);
    expect(cellAriaLabel(short, s1!.label)).toBe('09:00〜10:00 受付 2/3 人、あと1人');
    const zero = s1!.cells[1]!;
    expect([zero.state, cellCountText(zero), cellDiffText(zero)]).toEqual(['ok', '1人', '']);
    expect(cellAriaLabel(zero, s1!.label)).toBe('09:00〜10:00 運搬 1人');
    const over = s2!.cells[0]!;
    expect([over.state, cellCountText(over), cellDiffText(over)]).toEqual(['over', '2/1', '+1']);
    const none = s2!.cells[1]!;
    expect([none.state, cellCountText(none), cellAriaLabel(none, s2!.label)]).toEqual(['none', '—', '10:00〜11:00 運搬 ますなし']);
  });

  it('ますの人は表示名の順（名前のない人は後）。自分に me', () => {
    const t = buildShiftTable(board(), '2027-10-15', opts);
    expect(t.rows[0]!.cells[0]!.members.map((m) => [m.name, m.me])).toEqual([
      ['部門員A', false],
      ['部門員C', true],
    ]);
    const unknown = buildShiftTable(board(), '2027-10-18', opts).rows[0]!.cells[1]!;
    expect(unknown.members.map((m) => m.name)).toEqual([null]);
  });

  it('合計：行の終わりと列の下（必要人数 0 のますは数だけを足す）', () => {
    const t = buildShiftTable(board(), '2027-10-15', opts);
    expect(t.rows.map((r) => totalText(r.total))).toEqual(['3/3', '2/1']);
    expect(t.columnTotals.map(totalText)).toEqual(['4/4', '1人', '0人']);
  });

  it('部門長以上（ロールが分かる）は閲覧のみに変わった人を数えない（総務でない人）。部門員（ロールなし）は数える', () => {
    const roles = new Map([[U_VIEWER, 'viewer' as const]]);
    const lead = buildShiftTable(board(), '2027-10-18', { ...opts, roles }).rows[0]!.cells[1]!;
    expect([lead.count, lead.state, lead.members[0]!.soumu]).toEqual([0, 'short', false]);
    const staff = buildShiftTable(board(), '2027-10-18', { ...opts, allDuties: false }).rows[0]!.cells[0]!;
    expect([staff.count, staff.state, staff.members[0]!.soumu]).toEqual([1, 'ok', true]);
  });

  it('足りないます（?filter=short）：これからの時間枠（終わりが今より後）で、必要人数が 1 以上で数が少ないものだけ', () => {
    const t = buildShiftTable(board(), '2027-10-15', opts);
    const short = t.rows[0]!.cells[0]!;
    expect(isShortCell(short, NOW)).toBe(true);
    expect(isShortCell(short, Date.parse('2027-10-15T01:00:00Z'))).toBe(false);
    expect(isShortCell(t.rows[0]!.cells[1]!, NOW)).toBe(false);
    expect(isShortCell(t.rows[1]!.cells[1]!, NOW)).toBe(false);
  });
});

describe('T20 人を選ぶ一覧（memberChoices）・移す先・人ごと', () => {
  const members = [
    { user_id: U_ME, role: 'staff' as const },
    { user_id: U_A, role: 'head' as const },
    { user_id: U_B, role: 'staff' as const },
    { user_id: U_VIEWER, role: 'viewer' as const },
  ];

  it('総務を表示名の順に：このますにいる人は in、同じ時間枠のほかのますにいる人は busy（持ち場の名前）、ほかは free。この日の枠の数', () => {
    const list = memberChoices(board(), members, names, S1, D_RECEPTION);
    expect(list.map((c) => [c.name, c.state, c.dutyName, c.dayCount])).toEqual([
      ['部門員A', 'in', '受付', 2],
      ['部門員B', 'busy', '運搬', 2],
      ['部門員C', 'in', '受付', 1],
    ]);
    // 閲覧のみの人は選べる人に入らない
    expect(list.map((c) => c.userId)).not.toContain(U_VIEWER);
    expect(memberChoices(board(), members, names, uuid(99), D_RECEPTION)).toEqual([]);
  });

  it('このますにいる総務でない人（閲覧のみに変わった人）は in で soumu が偽（外すだけ）', () => {
    const list = memberChoices(board(), members, names, S3, D_CARRY);
    const viewer = list.find((c) => c.userId === U_VIEWER)!;
    expect([viewer.state, viewer.soumu, viewer.role]).toEqual(['in', false, 'viewer']);
    expect(list.filter((c) => c.state === 'free').map((c) => c.name)).toEqual(['部門員A', '部門員B', '部門員C']);
  });

  it('移す先は同じ時間枠のほかのます（持ち場の並び）', () => {
    expect(otherCellsOfSlot(board(), S1, D_RECEPTION).map((d) => d.name)).toEqual(['運搬']);
    expect(otherCellsOfSlot(board(), S2, D_RECEPTION)).toEqual([]);
  });

  it('人ごと（印刷）：その日に割り当てのある人を表示名の順に、人の中は開始の順', () => {
    const people = peopleOfDay(board(), '2027-10-15', names);
    expect(people.map((p) => [p.name, p.items.map((i) => `${i.label} ${i.duty?.name}`)])).toEqual([
      ['部門員A', ['09:00〜10:00 受付', '10:00〜11:00 受付']],
      ['部門員B', ['09:00〜10:00 運搬', '10:00〜11:00 受付']],
      ['部門員C', ['09:00〜10:00 受付']],
    ]);
  });

  it('n ずつに分ける（印刷の表は持ち場を 8 ずつ）', () => {
    expect(chunk([1, 2, 3, 4, 5], 2)).toEqual([[1, 2], [3, 4], [5]]);
    expect(chunk([], 8)).toEqual([]);
  });
});

describe('T20 1日分の時間枠（slotsOfDayPlan）と重なり', () => {
  it('始まりから区切りごとに作り、最後の枠は終わりで切る（`+09:00`）', () => {
    expect(slotsOfDayPlan({ date: '2027-10-15', start: '09:00', end: '11:30', stepMinutes: 60 })).toEqual({
      ok: true,
      slots: [
        { starts_at: '2027-10-15T09:00:00+09:00', ends_at: '2027-10-15T10:00:00+09:00' },
        { starts_at: '2027-10-15T10:00:00+09:00', ends_at: '2027-10-15T11:00:00+09:00' },
        { starts_at: '2027-10-15T11:00:00+09:00', ends_at: '2027-10-15T11:30:00+09:00' },
      ],
    });
  });

  it('終わりは 24:00 まで（次の日の 0 時）。15 分の区切りで 1 日は 96 枠（上限ちょうど）', () => {
    const plan = slotsOfDayPlan({ date: '2027-10-15', start: '23:00', end: '24:00', stepMinutes: 30 });
    expect(plan).toEqual({
      ok: true,
      slots: [
        { starts_at: '2027-10-15T23:00:00+09:00', ends_at: '2027-10-15T23:30:00+09:00' },
        { starts_at: '2027-10-15T23:30:00+09:00', ends_at: '2027-10-16T00:00:00+09:00' },
      ],
    });
    const full = slotsOfDayPlan({ date: '2027-10-15', start: '00:00', end: '24:00', stepMinutes: 15 });
    expect(full.ok && full.slots.length).toBe(DAY_PLAN_MAX);
  });

  it('終わりが始まり以前は order、形が違えば invalid（日付・時刻・区切り）', () => {
    expect(slotsOfDayPlan({ date: '2027-10-15', start: '10:00', end: '10:00', stepMinutes: 60 })).toEqual({ ok: false, reason: 'order' });
    expect(slotsOfDayPlan({ date: '2027-10-15', start: '24:00', end: '24:00', stepMinutes: 60 })).toEqual({ ok: false, reason: 'invalid' });
    expect(slotsOfDayPlan({ date: '2027-02-30', start: '09:00', end: '10:00', stepMinutes: 60 })).toEqual({ ok: false, reason: 'invalid' });
    expect(slotsOfDayPlan({ date: '2027-10-15', start: '09:00', end: '10:00', stepMinutes: 0 })).toEqual({ ok: false, reason: 'invalid' });
  });

  it('重なり：[開始, 終わり) の重なり（隣り合う枠は重ならない）。今ある時間枠のうち計画と重なるもの', () => {
    const a = { starts_at: '2027-10-15T09:00:00+09:00', ends_at: '2027-10-15T10:00:00+09:00' };
    const b = { starts_at: '2027-10-15T10:00:00+09:00', ends_at: '2027-10-15T11:00:00+09:00' };
    const c = { starts_at: '2027-10-15T09:30:00+09:00', ends_at: '2027-10-15T10:30:00+09:00' };
    expect(slotsOverlap(a, b)).toBe(false);
    expect(slotsOverlap(a, c)).toBe(true);
    expect(overlappingSlots([c], board().slots).map((s) => s.id)).toEqual([S1, S2]);
    expect(overlappingSlots([c], board().slots, S1).map((s) => s.id)).toEqual([S2]);
    expect(overlappingSlots([{ starts_at: '2027-10-15T11:00:00+09:00', ends_at: '2027-10-15T12:00:00+09:00' }], board().slots)).toEqual([]);
  });
});

describe('T20 書いた後のキャッシュ・削除の確かめの数', () => {
  it('割り当てを入れる（同じ時間枠のほかのますから移る）・外す。元の表は変えない', () => {
    const b = board();
    const moved = boardWithAssignment(b, { slot_id: S1, duty_id: D_CARRY, user_id: U_A, updated_at: 'v2' });
    const s1 = moved.slots.find((s) => s.id === S1)!;
    expect(s1.shift_needs.map((n) => [n.duty_id, n.shift_assignments.map((a) => a.user_id)])).toEqual([
      [D_RECEPTION, [U_ME]],
      [D_CARRY, [U_B, U_A]],
    ]);
    expect(b.slots.find((s) => s.id === S1)!.shift_needs[0]!.shift_assignments).toHaveLength(2);
    const removed = boardWithoutAssignment(b, S1, U_ME);
    expect(removed.slots.find((s) => s.id === S1)!.shift_needs[0]!.shift_assignments.map((a) => a.user_id)).toEqual([U_A]);
  });

  it('ますを作る・必要人数を変える・外す', () => {
    const b = board();
    const created = boardWithNeed(b, { slot_id: S2, duty_id: D_CARRY, required_count: 2, updated_at: 'v2' });
    expect(created.slots.find((s) => s.id === S2)!.shift_needs.map((n) => [n.duty_id, n.required_count])).toEqual([
      [D_RECEPTION, 1],
      [D_CARRY, 2],
    ]);
    const changed = boardWithNeed(b, { slot_id: S1, duty_id: D_RECEPTION, required_count: 5, updated_at: 'v2' });
    expect(changed.slots.find((s) => s.id === S1)!.shift_needs[0]).toMatchObject({ required_count: 5, updated_at: 'v2' });
    expect(changed.slots.find((s) => s.id === S1)!.shift_needs[0]!.shift_assignments).toHaveLength(2);
    expect(boardWithoutNeed(b, S1, D_RECEPTION).slots.find((s) => s.id === S1)!.shift_needs.map((n) => n.duty_id)).toEqual([D_CARRY]);
  });

  it('削除の確かめの数：時間枠の割り当ての人数、持ち場のますと割り当ての人数。overlap の文言の時刻', () => {
    expect(slotAssignmentCount(board().slots.find((s) => s.id === S1)!)).toBe(3);
    expect(dutyUsage(board(), D_RECEPTION)).toEqual({ needs: 2, assignments: 4 });
    expect(dutyUsage(board(), D_SPARE)).toEqual({ needs: 0, assignments: 0 });
    expect(slotLabelLookup(board())(S2)).toBe('10:00〜11:00');
    expect(slotLabelLookup(board())(uuid(99))).toBeUndefined();
    expect(slotLabelLookup(undefined)(S2)).toBeUndefined();
  });
});
