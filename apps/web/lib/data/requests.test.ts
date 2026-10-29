import { INITIAL_ITEMS } from '@gaapp/shared';
import { describe, expect, it, vi } from 'vitest';
import type { GroupRow, ItemRow, RequestDbRow, SubmissionRow, YearRow } from '@/lib/db/types';
import { AppError, appError } from '@/lib/errors';
import { createFakeSupabase, opArgs, type FakeCall } from '@/lib/testing/fake-supabase';
import {
  adminWriteMode,
  buildRequestForm,
  buildRequestMatrix,
  cellKey,
  columnTotals,
  decideGroupSave,
  extraRowNote,
  groupDeadlineRows,
  groupStateOf,
  hasCountChanges,
  saveSummary,
  hasNoRequests,
  isOutsideFlagActive,
  isPastDeadline,
  judgePendingCells,
  markSubmittedAfterDeadline,
  markSubmittedDirect,
  judgeDirectFailure,
  judgeSubmitFailure,
  nonZeroSummary,
  outsideFlagOf,
  pendingChanges,
  previousCountsFor,
  normalizePending,
  normalizeRequestDraft,
  rebaseKeysTo,
  rebasePending,
  rebaseRequestInput,
  samePending,
  remainingText,
  requestWindowOf,
  saveCellsDirect,
  saveGroupsAfterDeadline,
  setPendingCell,
  sortGroups,
  stateChangesSince,
  newerChangesSince,
  adoptGroupChanges,
  hasGroupChanges,
  submissionChangeLabels,
  toDeadlineRows,
  toSubmitRows,
  type RequestsTables,
} from './requests';

vi.mock('@/lib/rpc', () => ({ callRpc: vi.fn() }));
const { callRpc } = await import('@/lib/rpc');

const T0 = '2026-10-29T01:02:03.123456+00:00';
const T1 = '2026-10-29T01:02:04.654321+00:00';
const uuid = (n: number) => `00000000-0000-4000-8000-${String(n).padStart(12, '0')}`;

/** seed と同じ品目（id は決まった uuid） */
const ITEMS: ItemRow[] = INITIAL_ITEMS.map((i, n) => ({
  id: uuid(100 + n),
  code: i.code,
  name: i.name,
  aliases: [...i.aliases],
  requestable_categories: [...i.requestableCategories],
  sort_order: i.sortOrder,
  updated_at: T0,
}));
const item = (code: string) => ITEMS.find((i) => i.code === code)!;

const group = (n: number, name: string, category: GroupRow['category'], sort = n): GroupRow => ({
  id: uuid(n),
  year_id: uuid(1),
  name,
  display_name: null,
  aliases: [],
  category,
  is_food: false,
  location_room_id: null,
  sort_order: sort,
  updated_at: T0,
});
const req = (g: GroupRow, code: string, count: number, updated_at = T0): RequestDbRow => ({ group_id: g.id, item_id: item(code).id, count, updated_at });
const sub = (g: GroupRow, submitted_at: string | null, note: string | null = null): SubmissionRow => ({ group_id: g.id, submitted_at, note, updated_at: T0 });

const year = (o: Partial<YearRow>): Pick<YearRow, 'status' | 'request_open_at' | 'request_close_at'> => ({
  status: 'requesting',
  request_open_at: '2026-10-01T00:00:00+09:00',
  request_close_at: '2026-10-10T23:59:00+09:00',
  ...o,
});
const NOW = new Date('2026-10-05T12:00:00+09:00');

describe('buildRequestForm（申請の入力欄）', () => {
  it('区分で申請できる品目だけを並び順に出し、初期値は今の申請の数（なければ 0）。企業以外に長机(3人掛)の欄は出ない', () => {
    const stall = group(10, '模擬店A', 'stall');
    const m = buildRequestForm(ITEMS, 'stall', [req(stall, 'desk', 3), req(stall, 'chair', 0)]);
    expect(m.fields.map((f) => f.item.code)).toEqual(['desk', 'chair', 'caster_desk', 'blue_chair', 'long_desk_2', 'lectern']);
    expect(m.fields.find((f) => f.item.code === 'desk')).toMatchObject({ current: 3, updatedAt: T0 });
    expect(m.fields.find((f) => f.item.code === 'lectern')).toMatchObject({ current: 0, updatedAt: null });
    expect(m.extras).toEqual([]);
  });

  it('企業には長机(3人掛)の欄が出る', () => {
    const m = buildRequestForm(ITEMS, 'company', []);
    expect(m.fields.map((f) => f.item.code)).toContain('long_desk_3');
  });

  it('申請できない品目に 0 でない行があれば読み取り専用の行にし、読み替え先の初期値には足さない', () => {
    const stall = group(10, '模擬店06', 'stall');
    const m = buildRequestForm(ITEMS, 'stall', [req(stall, 'long_desk_3', 2), req(stall, 'long_desk_2', 1), req(stall, 'desk_ng', 1), req(stall, 'chair_ng', 0)]);
    expect(m.fields.map((f) => f.item.code)).not.toContain('long_desk_3');
    expect(m.fields.find((f) => f.item.code === 'long_desk_2')!.current).toBe(1);
    expect(m.extras.map((x) => [x.item.code, x.count, x.treatedAs?.code ?? null])).toEqual([
      ['desk_ng', 1, null],
      ['long_desk_3', 2, 'long_desk_2'],
    ]);
    expect(extraRowNote(m.extras[1]!)).toBe('長机(2人掛)として扱います。変えるときは総務へ');
    expect(extraRowNote(m.extras[0]!)).toBe('この区分では申請できない品目です。総務へ');
    expect(extraRowNote(m.extras[1]!, 'admin')).toBe('長机(2人掛)として扱います');
  });

  it('提出の rows は表示した入力欄の品目すべて。締切後の rows は変えた品目だけで、行があれば updatedAt を付ける', () => {
    const stall = group(10, '模擬店A', 'stall');
    const { fields } = buildRequestForm(ITEMS, 'stall', [req(stall, 'desk', 3), req(stall, 'long_desk_3', 2)]);
    const edits = { [item('desk').id]: 5, [item('chair').id]: 4, [item('lectern').id]: 0 };
    expect(toSubmitRows(fields, edits)).toEqual(fields.map((f) => ({ itemId: f.item.id, count: edits[f.item.id] ?? f.current })));
    expect(toSubmitRows(fields, edits).map((r) => r.itemId)).not.toContain(item('long_desk_3').id);
    expect(toDeadlineRows(fields, edits)).toEqual([
      { itemId: item('desk').id, count: 5, updatedAt: T0 },
      { itemId: item('chair').id, count: 4 },
    ]);
    expect(hasCountChanges(fields, edits)).toBe(true);
    expect(hasCountChanges(fields, { [item('desk').id]: 3 })).toBe(false);
    expect(nonZeroSummary(fields, edits)).toEqual([
      { name: '机(木)', count: 5 },
      { name: '椅子(木)', count: 4 },
    ]);
    expect(nonZeroSummary(fields, { [item('desk').id]: 0 })).toEqual([]);
  });
});

describe('受付期間（端末の時計）と DB が判断した印', () => {
  it('requestWindowOf：準備中・受付開始の前・受付期間内・締切後と振り分け中以降', () => {
    expect(requestWindowOf(year({ status: 'preparing' }), NOW)).toBe('preparing');
    expect(requestWindowOf(year({ request_open_at: '2026-10-06T00:00:00+09:00' }), NOW)).toBe('not_yet');
    expect(requestWindowOf(year({}), NOW)).toBe('open');
    expect(requestWindowOf(year({ request_open_at: null }), NOW)).toBe('open');
    expect(requestWindowOf(year({ request_close_at: '2026-10-05T12:00:00+09:00' }), NOW)).toBe('closed');
    expect(requestWindowOf(year({ request_close_at: null }), NOW)).toBe('closed');
    for (const s of ['allocating', 'confirmed', 'closed'] as const) expect(requestWindowOf(year({ status: s }), NOW)).toBe('closed');
  });

  it('adminWriteMode：締切前は直接、締切後と振り分け中は理由と RPC、確定中・終了は読み取り。印があれば締切後の書き方', () => {
    expect(adminWriteMode(year({ status: 'preparing', request_close_at: null }), NOW, false)).toBe('direct');
    expect(adminWriteMode(year({}), NOW, false)).toBe('direct');
    expect(adminWriteMode(year({ request_open_at: '2026-10-06T00:00:00+09:00' }), NOW, false)).toBe('direct');
    expect(adminWriteMode(year({}), NOW, true)).toBe('deadline');
    expect(adminWriteMode(year({ request_close_at: '2026-10-01T00:00:00+09:00' }), NOW, false)).toBe('deadline');
    expect(adminWriteMode(year({ status: 'allocating' }), NOW, false)).toBe('deadline');
    expect(adminWriteMode(year({ status: 'confirmed' }), NOW, true)).toBe('readonly');
    expect(adminWriteMode(year({ status: 'closed' }), NOW, false)).toBe('readonly');
    expect(isPastDeadline(year({ status: 'preparing' }), NOW)).toBe(false);
  });

  it('印は年度の状態と受付期間を鍵にし、状態か受付期間が変われば効かなくなる', () => {
    const y = year({});
    const flag = outsideFlagOf(y);
    expect(isOutsideFlagActive(flag, y)).toBe(true);
    expect(isOutsideFlagActive(null, y)).toBe(false);
    expect(isOutsideFlagActive(flag, { ...y, status: 'allocating' })).toBe(false);
    expect(isOutsideFlagActive(flag, { ...y, request_close_at: '2026-10-20T00:00:00+09:00' })).toBe(false);
  });

  it('提出の invalid_state は、読み直した年度が申請受付中のままなら印を立てる（端末の時計のずれ）。状態が変わっていれば立てない', () => {
    const e = { code: 'P0001', message: 'invalid_state', details: '{"status":"requesting"}' };
    expect(judgeSubmitFailure(e, year({}))).toEqual({ outside: true });
    expect(judgeSubmitFailure(e, year({ status: 'allocating' }))).toEqual({ outside: false });
    expect(judgeSubmitFailure(e, null)).toEqual({ outside: false });
    expect(judgeSubmitFailure({ code: 'P0001', message: 'forbidden', details: '' }, year({}))).toEqual({ outside: false });
  });

  it('直接の書き込みの forbidden（RLS で 0 行・42501）は、読み直した年度が申請受付中のままなら印を立てる', () => {
    expect(judgeDirectFailure(appError('forbidden', 'lock_unchanged'), year({}))).toEqual({ outside: true });
    expect(judgeDirectFailure({ code: '42501', message: 'new row violates row-level security policy' }, year({}))).toEqual({ outside: true });
    expect(judgeDirectFailure(appError('forbidden', 'lock_unchanged'), year({ status: 'allocating' }))).toEqual({ outside: false });
    expect(judgeDirectFailure(appError('conflict', 'lock_conflict'), year({}))).toEqual({ outside: false });
  });

  it('締切までの残り', () => {
    expect(remainingText('2026-10-08T12:00:00+09:00', NOW)).toBe('あと3日');
    expect(remainingText('2026-10-05T17:30:00+09:00', NOW)).toBe('あと6時間');
    expect(remainingText('2026-10-05T11:00:00+09:00', NOW)).toBeNull();
    expect(remainingText(null, NOW)).toBeNull();
  });

});

describe('rebaseRequestInput（入力の元を読み直した記録にするときの入力）', () => {
  const a = group(10, '模擬店A', 'stall');
  it('読み直した値と同じ入力だけを外し、前の入力の元と同じ値に戻した入力は残す。備考は読み直した備考と同じときだけ null', () => {
    // 前の入力の元は机 0。応答が届かなかった自分の提出で DB は机 1・備考「電源」。その後に机を 0 に戻し、椅子を 2 にした
    const fresh = { requests: [req(a, 'desk', 1, T1)], submission: { ...sub(a, T1, '電源'), updated_by: null } };
    const next = rebaseRequestInput(ITEMS, 'stall', fresh, { edits: { [item('desk').id]: 0, [item('chair').id]: 2, [item('lectern').id]: 0 }, note: '' });
    expect(next.edits).toEqual({ [item('desk').id]: 0, [item('chair').id]: 2 });
    expect(next.note).toBe('');
    expect(rebaseRequestInput(ITEMS, 'stall', fresh, { edits: { [item('desk').id]: 1 }, note: '電源' })).toEqual({ edits: {}, note: null });
    expect(rebaseRequestInput(ITEMS, 'stall', { requests: [], submission: null }, { edits: {}, note: '' })).toEqual({ edits: {}, note: null });
  });
});

describe('stateChangesSince（ほかの人の保存のダイアログに出す変更）', () => {
  const a = group(10, '模擬店A', 'stall');
  const row = buildRequestMatrix({ groups: [a], items: ITEMS, requests: [req(a, 'desk', 3), req(a, 'chair', 2)], submissions: [sub(a, T0, '電源')] }).rows[0]!;
  const base = groupStateOf(row);
  const ME = uuid(900);
  const OTHER = uuid(901);

  it('同じなら変更なし（時刻の書き方の違いは同じ時刻として扱う）', () => {
    const c = stateChangesSince(base, { requests: [req(a, 'desk', 3, '2026-10-29T10:02:03.123456+09:00'), req(a, 'chair', 2)], submission: sub(a, T0, '電源') }, ME);
    expect(c).toEqual({ items: [], submission: false, submittedAt: false, note: false });
  });

  it('updated_at が変わった・行が増えた・消えた品目と、提出の記録の変更（提出日時・備考・updated_at）を挙げる', () => {
    const c = stateChangesSince(base, { requests: [req(a, 'desk', 4, T1), req(a, 'lectern', 1, T1)], submission: sub(a, T0, '電源を2つ') }, ME);
    expect(c.items).toEqual(
      expect.arrayContaining([
        { itemId: item('desk').id, from: 3, to: 4 },
        { itemId: item('chair').id, from: 2, to: 0 },
        { itemId: item('lectern').id, from: 0, to: 1 },
      ]),
    );
    expect(c.items).toHaveLength(3);
    expect(c.submission).toBe(true);
    expect(stateChangesSince(base, { requests: [req(a, 'desk', 3), req(a, 'chair', 2)], submission: sub(a, T1, '電源') }, ME).submission).toBe(true);
    expect(stateChangesSince(base, { requests: [req(a, 'desk', 3), req(a, 'chair', 2)], submission: null }, ME).submission).toBe(true);
    // 同じ内容での出し直し（updated_at だけが進んだ）も変わったとする
    expect(stateChangesSince(base, { requests: [req(a, 'desk', 3), req(a, 'chair', 2)], submission: { ...sub(a, T0, '電源'), updated_at: T1 } }, ME).submission).toBe(true);
  });

  it('自分の書いたもの（提出の記録の updated_by が自分、その提出で書かれた申請の行）は挙げない', () => {
    // 前に送って応答が届かなかった自分の提出（机 3 → 5）が通り、その後にほかの人が椅子を 4 にした
    const mine = { ...sub(a, T1, '電源'), updated_at: T1, updated_by: ME };
    const T2 = '2026-10-29T01:02:05.111111+00:00';
    const c = stateChangesSince(base, { requests: [req(a, 'desk', 5, T1), req(a, 'chair', 4, T2)], submission: mine }, ME);
    expect(c).toEqual({ items: [{ itemId: item('chair').id, from: 2, to: 4 }], submission: false, submittedAt: false, note: false });
    // ほかの人の提出なら、提出の記録もその提出で書かれた行も挙げる
    const theirs = { ...mine, updated_by: OTHER };
    const d = stateChangesSince(base, { requests: [req(a, 'desk', 5, T1), req(a, 'chair', 4, T2)], submission: theirs }, ME);
    expect(d.submission).toBe(true);
    expect(d.items).toHaveLength(2);
  });
});

describe('newerChangesSince・adoptGroupChanges（裏で届いた行の知らせと「ほかの人の値を読み込む」。R1）', () => {
  const a = group(10, '模擬店A', 'stall');
  const ME = uuid(900);
  const OTHER = uuid(901);
  const T2 = '2026-10-29T01:02:05.111111+00:00';
  const base = { requests: [req(a, 'desk', 3, T1), req(a, 'chair', 2, T1)], submission: { ...sub(a, T1, '電源'), updated_at: T1, updated_by: OTHER } };

  it('入力の元より新しいほかの人の変更だけを挙げる（古い行・自分の提出で書かれた行は挙げない）', () => {
    // ほかの人が椅子を 4 にし、長机を足し、出し直した
    const later = { requests: [req(a, 'desk', 3, T1), req(a, 'chair', 4, T2), req(a, 'lectern', 1, T2)], submission: { ...sub(a, T2, '電源'), updated_at: T2, updated_by: OTHER } };
    const c = newerChangesSince(base, later, ME);
    expect(c.items).toEqual(expect.arrayContaining([{ itemId: item('chair').id, from: 2, to: 4 }, { itemId: item('lectern').id, from: 0, to: 1 }]));
    expect(c.items).toHaveLength(2);
    expect(c.submission).toBe(true);
    expect(hasGroupChanges(c)).toBe(true);
    // 届いた行が入力の元より古い（送る前に読み直した行を入力の元にした後、表がまだ古い）なら挙げない
    const older = { requests: [req(a, 'desk', 1, T0), req(a, 'chair', 2, T0)], submission: { ...sub(a, T0, null), updated_at: T0, updated_by: OTHER } };
    expect(hasGroupChanges(newerChangesSince(base, older, ME))).toBe(false);
    // 自分の提出（応答が届かなかったものが通っていた）で書かれた行と提出の記録は挙げない
    const mine = { requests: [req(a, 'desk', 5, T2), req(a, 'chair', 2, T2)], submission: { ...sub(a, T2, null), updated_at: T2, updated_by: ME } };
    expect(hasGroupChanges(newerChangesSince(base, mine, ME))).toBe(false);
  });

  it('「ほかの人の値を読み込む」：変わった品目と（提出の記録が変わっていれば）備考は届いた値にし、ほかの入れた数は残す', () => {
    const later = { requests: [req(a, 'desk', 3, T1), req(a, 'chair', 4, T2)], submission: base.submission };
    const changes = newerChangesSince(base, later, ME);
    // 椅子を 6・机を 5 に、備考を書き換えていた
    const next = adoptGroupChanges(ITEMS, 'stall', later, changes, { edits: { [item('chair').id]: 6, [item('desk').id]: 5 }, note: '電源2' });
    expect(next).toEqual({ edits: { [item('desk').id]: 5 }, note: '電源2' });
    const resub = { ...later, submission: { ...sub(a, T2, '電源なし'), updated_at: T2, updated_by: OTHER } };
    expect(adoptGroupChanges(ITEMS, 'stall', resub, newerChangesSince(base, resub, ME), { edits: {}, note: '電源2' }).note).toBeNull();
  });

  it('数が変わっていない品目は挙げない（ほかの人の初めての提出で count 0 の行が入っても、入れた数を残す）', () => {
    const none = { requests: [], submission: null };
    // ほかの人が椅子 3 だけで初めて提出した（全品目の行が updated_at T2 で入る）
    const first = {
      requests: [req(a, 'desk', 0, T2), req(a, 'chair', 3, T2), req(a, 'lectern', 0, T2)],
      submission: { ...sub(a, T2, null), updated_at: T2, updated_by: OTHER },
    };
    const c = newerChangesSince(none, first, ME);
    expect(c.items).toEqual([{ itemId: item('chair').id, from: 0, to: 3 }]);
    const next = adoptGroupChanges(ITEMS, 'stall', first, c, { edits: { [item('desk').id]: 2 }, note: null });
    expect(next.edits).toEqual({ [item('desk').id]: 2 });
  });

  it('備考が同じ出し直しでは、書き換えた備考を残す。知らせは提出日時と備考を分ける', () => {
    // ほかの人が椅子だけを変えて出し直した（備考「電源」は同じ。提出日時と updated_at は進む）
    const resub = { requests: [req(a, 'desk', 3, T1), req(a, 'chair', 4, T2)], submission: { ...sub(a, T2, '電源'), updated_at: T2, updated_by: OTHER } };
    const c = newerChangesSince(base, resub, ME);
    expect(c).toMatchObject({ submission: true, submittedAt: true, note: false });
    expect(submissionChangeLabels(c)).toEqual(['提出日時']);
    expect(adoptGroupChanges(ITEMS, 'stall', resub, c, { edits: {}, note: '電源と水道' }).note).toBe('電源と水道');
    // 備考だけが変わった・同じ内容での出し直し（updated_at だけ）
    const noteOnly = { ...resub, submission: { ...sub(a, T1, '電源なし'), updated_at: T2, updated_by: OTHER } };
    expect(submissionChangeLabels(newerChangesSince(base, noteOnly, ME))).toEqual(['備考']);
    const same = { ...resub, submission: { ...sub(a, T1, '電源'), updated_at: T2, updated_by: OTHER } };
    expect(submissionChangeLabels(newerChangesSince(base, same, ME))).toEqual(['提出の記録']);
    const both = { ...resub, submission: { ...sub(a, T2, '電源なし'), updated_at: T2, updated_by: OTHER } };
    expect(submissionChangeLabels(newerChangesSince(base, both, ME))).toEqual(['提出日時', '備考']);
  });

  it('届いた提出の記録に書いた人（updated_by）がなければ、ほかの人の変更と言い切らない（その記録と同じ時刻の行も挙げない）', () => {
    const none = { requests: [], submission: null };
    const T3 = '2026-10-29T01:02:06.111111+00:00';
    const unknownBy = { requests: [req(a, 'desk', 1, T2), req(a, 'chair', 4, T3)], submission: { ...sub(a, T2, null), updated_at: T2 } };
    const c = newerChangesSince(none, unknownBy, ME);
    expect(c.submission).toBe(false);
    expect(c.items).toEqual([{ itemId: item('chair').id, from: 0, to: 4 }]);
  });
});

describe('normalizeRequestDraft（/request の下書き。入力の元つき）', () => {
  const g = group(10, '模擬店A', 'stall');
  const base = { requests: [req(g, 'desk', 3, T0)], submission: { group_id: g.id, submitted_at: T0, note: '電源', updated_at: T0, updated_by: uuid(901) } };

  it('入れた数・備考・入力の元を読む（提出の記録の updated_by がなければ null）', () => {
    expect(normalizeRequestDraft({ edits: { [item('desk').id]: 5 }, note: null, base }, g.id)).toEqual({ edits: { [item('desk').id]: 5 }, note: null, base });
    const { updated_by: _u, ...noBy } = base.submission;
    void _u;
    expect(normalizeRequestDraft({ edits: {}, note: 'x', base: { requests: [], submission: noBy } }, g.id)?.base.submission?.updated_by).toBeNull();
    expect(normalizeRequestDraft({ edits: {}, note: null, base: { requests: [], submission: null } }, g.id)?.base).toEqual({ requests: [], submission: null });
  });

  it('入力の元のない古い形・形の違う値・ほかの団体の行は戻さない（null）', () => {
    expect(normalizeRequestDraft({ edits: { [item('desk').id]: 5 }, note: null }, g.id)).toBeNull();
    expect(normalizeRequestDraft({ edits: { [item('desk').id]: -1 }, note: null, base }, g.id)).toBeNull();
    expect(normalizeRequestDraft({ edits: {}, note: null, base }, uuid(11))).toBeNull();
    expect(normalizeRequestDraft({ edits: {}, note: null, base: { requests: [{ item_id: 'x' }], submission: null } }, g.id)).toBeNull();
    expect(normalizeRequestDraft(null, g.id)).toBeNull();
  });
});

describe('decideGroupSave（申請・代理入力の送る前の判定。2.6 の (A)）', () => {
  const g = group(10, '模擬店A', 'stall');
  const ME = uuid(900);
  const OTHER = uuid(901);
  const s = (updated_at: string, note: string | null, updated_by: string | null, submitted_at: string | null = T0) => ({
    group_id: g.id,
    submitted_at,
    note,
    updated_at,
    updated_by,
  });
  /** 入力の元：机 3・椅子なし、提出済み（備考「電源」） */
  const base = { requests: [req(g, 'desk', 3, T0)], submission: s(T0, '電源', OTHER) };
  /** 入力：机 3・椅子 2、備考「電源」 */
  const input = { counts: { [item('desk').id]: 3, [item('chair').id]: 2 }, note: '電源' };

  it('誰も変えていなければ送る（同じ内容での再提出も送る）', () => {
    expect(decideGroupSave(base, base, input, ME)).toBe('send');
    expect(decideGroupSave(base, base, { counts: { [item('desk').id]: 3 }, note: '電源' }, ME)).toBe('send');
  });

  it('前に送って応答が届かなかった保存が通っていた（DB が入力と同じ）なら saved（送らない）', () => {
    const fresh = { requests: [req(g, 'desk', 3, T1), req(g, 'chair', 2, T1)], submission: s(T1, '電源', ME, T1) };
    expect(decideGroupSave(base, fresh, input, ME)).toBe('saved');
  });

  it('自分の書いた提出の記録（updated_by が自分）はほかの人の変更として扱わない：DB が入力と違えば送る', () => {
    // 前に送った備考「電源を2つ」が通っていたが、その後に備考を「電源」に戻した
    const fresh = { requests: [req(g, 'desk', 3, T0)], submission: s(T1, '電源を2つ', ME, T1) };
    expect(decideGroupSave(base, fresh, { counts: { [item('desk').id]: 3 }, note: '電源' }, ME)).toBe('send');
  });

  it('提出の記録がほかの人に変えられていれば（updated_by が自分でない・null）conflict', () => {
    const fresh = { requests: [req(g, 'desk', 3, T0)], submission: s(T1, '電源', OTHER, T1) };
    expect(decideGroupSave(base, fresh, input, ME)).toBe('conflict');
    expect(decideGroupSave(base, { ...fresh, submission: s(T1, '電源', null, T1) }, input, ME)).toBe('conflict');
  });

  it('申請の行は、数が入力の元とも入力とも違えばほかの人の変更（conflict）。どちらかと同じなら送る', () => {
    const other = { requests: [req(g, 'desk', 5, T1)], submission: base.submission };
    expect(decideGroupSave(base, other, input, ME)).toBe('conflict');
    // 椅子を入力と同じ 2 にした行ができていた（ほかは誰も変えていない）→ 送る（机・提出の記録は入力と違うので saved ではない）
    const same = { requests: [req(g, 'desk', 3, T0), req(g, 'chair', 2, T1)], submission: s(T0, '電源', OTHER) };
    expect(decideGroupSave(base, same, { ...input, note: '電源を2つ' }, ME)).toBe('send');
  });

  it('応答が落ちる（DB には入っている）→ 入力を変える → 提出：自分の提出で書かれた行（updated_at が自分の提出の記録と同じ）はほかの人の変更にしない', () => {
    // 前に送った「机 5・椅子 2」が通っていた（提出の記録も行も同じトランザクションの時刻 T1）。その後に机を 7 に変えた
    const fresh = { requests: [req(g, 'desk', 5, T1), req(g, 'chair', 2, T1)], submission: s(T1, '電源', ME, T1) };
    const changedInput = { counts: { [item('desk').id]: 7, [item('chair').id]: 2 }, note: '電源' };
    expect(decideGroupSave(base, fresh, changedInput, ME)).toBe('send');
    // 同じ形でも、提出の記録を書いたのがほかの人なら、その提出で書かれた行もほかの人の変更（conflict）
    expect(decideGroupSave(base, { ...fresh, submission: s(T1, '電源', OTHER, T1) }, changedInput, ME)).toBe('conflict');
    // 自分の提出の後に、ほかの人が行だけを変えた（updated_at が自分の提出と違う）→ 値で決める（conflict）
    const T2 = '2026-10-29T01:02:05.111111+00:00';
    const later = { requests: [req(g, 'desk', 6, T2), req(g, 'chair', 2, T1)], submission: s(T1, '電源', ME, T1) };
    expect(decideGroupSave(base, later, changedInput, ME)).toBe('conflict');
  });
});

describe('申請一覧の表', () => {
  const a = group(10, '模擬店B', 'stall', 2);
  const b = group(11, '模擬店A', 'stall', 2);
  const c = group(12, '企業1', 'company', 1);
  const d = group(13, '休憩所1', 'rest_area', 3);
  const tables: RequestsTables = {
    groups: [a, b, c, d],
    items: ITEMS.slice().reverse(),
    requests: [req(a, 'desk', 3), req(a, 'long_desk_3', 2), req(b, 'desk', 1), req(c, 'long_desk_3', 4)],
    submissions: [sub(a, T0, '  '), sub(b, null, '電源がほしい'), sub(c, T1)],
  };

  it('行は団体の並び順（sort_order → 名前 → id）、列は品目の並び順。区分で申請できない品目のセルに印', () => {
    const m = buildRequestMatrix(tables);
    expect(m.rows.map((r) => r.group.name)).toEqual(['企業1', '模擬店A', '模擬店B', '休憩所1']);
    expect(m.items.map((i) => i.code)).toEqual(ITEMS.map((i) => i.code));
    const rowA = m.rows.find((r) => r.group.id === a.id)!;
    expect(rowA.cells[item('long_desk_3').id]).toEqual({ itemId: item('long_desk_3').id, count: 2, updatedAt: T0, requestable: false });
    expect(rowA.cells[item('desk').id]).toMatchObject({ count: 3, requestable: true });
    expect(rowA.cells[item('lectern').id]).toMatchObject({ count: 0, updatedAt: null });
    expect(rowA.note).toBeNull();
    expect(m.unsubmitted.map((g) => g.name)).toEqual(['模擬店A', '休憩所1']);
    expect(sortGroups([a, b]).map((g) => g.name)).toEqual(['模擬店A', '模擬店B']);
  });

  it('区分・未提出だけ・備考ありだけで絞る', () => {
    expect(buildRequestMatrix(tables, { category: 'stall' }).rows.map((r) => r.group.name)).toEqual(['模擬店A', '模擬店B']);
    expect(buildRequestMatrix(tables, { filter: 'unsubmitted' }).rows.map((r) => r.group.name)).toEqual(['模擬店A', '休憩所1']);
    expect(buildRequestMatrix(tables, { filter: 'noted' }).rows.map((r) => r.group.name)).toEqual(['模擬店A']);
    const m = buildRequestMatrix(tables, { category: 'company' });
    expect(m.groupCount).toBe(1);
    expect(m.unsubmitted).toEqual([]);
  });

  const cellOfT = (g: GroupRow, code: string, t: RequestsTables = tables) =>
    buildRequestMatrix(t).rows.find((r) => r.group.id === g.id)!.cells[item(code).id]!;
  const key = (g: GroupRow, code: string) => cellKey(g.id, item(code).id);

  it('未保存のセル：編集していないセルに今の数を入れても未保存にしない。一度入れたセルは基準の数に戻しても残す。変更の一覧は基準の updated_at を付け、申請できない品目は 0 だけ通す', () => {
    let p = setPendingCell({}, a.id, item('desk').id, 5, cellOfT(a, 'desk'));
    p = setPendingCell(p, b.id, item('chair').id, 2, cellOfT(b, 'chair'));
    p = setPendingCell(p, a.id, item('long_desk_3').id, 0, cellOfT(a, 'long_desk_3'));
    p = setPendingCell(p, b.id, item('long_desk_3').id, 1, cellOfT(b, 'long_desk_3'));
    expect(p[key(a, 'desk')]).toEqual({ value: 5, baseCount: 3, baseUpdatedAt: T0 });
    expect(p[key(b, 'chair')]).toEqual({ value: 2, baseCount: 0, baseUpdatedAt: null });
    // 2回目の編集は基準を変えない（今の行が変わっていても、最初に編集したときの行のまま）
    const later = { count: 4, updatedAt: T1 };
    expect(setPendingCell(p, a.id, item('desk').id, 6, later)[key(a, 'desk')]).toEqual({ value: 6, baseCount: 3, baseUpdatedAt: T0 });
    // 基準の数（3）に戻しても外さない（表が古いまま DB が変わっていることがある。DB と同じなら当て直しで外れる）
    expect(setPendingCell(p, a.id, item('desk').id, 3, later)[key(a, 'desk')]).toEqual({ value: 3, baseCount: 3, baseUpdatedAt: T0 });
    expect(setPendingCell(p, a.id, item('desk').id, 3, cellOfT(a, 'desk'))[key(a, 'desk')]).toEqual({ value: 3, baseCount: 3, baseUpdatedAt: T0 });
    expect(rebasePending(setPendingCell(p, a.id, item('desk').id, 3, cellOfT(a, 'desk')), tables)).not.toHaveProperty(key(a, 'desk'));
    // 編集していないセルに今の数を入れても未保存にしない
    expect(setPendingCell(p, b.id, item('desk').id, 1, cellOfT(b, 'desk'))).toBe(p);
    const changes = pendingChanges(p, tables);
    expect(changes).toEqual(
      [
        { groupId: a.id, itemId: item('desk').id, count: 5, updatedAt: T0 },
        { groupId: a.id, itemId: item('long_desk_3').id, count: 0, updatedAt: T0 },
        { groupId: b.id, itemId: item('chair').id, count: 2, updatedAt: null },
      ].sort((x, y) => (x.groupId + x.itemId < y.groupId + y.itemId ? -1 : 1)),
    );
    const byGroup = groupDeadlineRows(changes);
    expect(byGroup.get(a.id)).toEqual([
      { itemId: item('desk').id, count: 5, updatedAt: T0 },
      { itemId: item('long_desk_3').id, count: 0, updatedAt: T0 },
    ]);
    expect(byGroup.get(b.id)).toEqual([{ itemId: item('chair').id, count: 2 }]);
  });

  it('編集 → ほかの人の変更を読み直す → 保存：送る updatedAt は編集したときの行のもの（DB が conflict を返す）', () => {
    const p = setPendingCell({}, a.id, item('desk').id, 5, cellOfT(a, 'desk'));
    const after = { ...tables, requests: [req(a, 'desk', 4, T1), ...tables.requests.slice(1)] };
    expect(pendingChanges(p, after)).toEqual([{ groupId: a.id, itemId: item('desk').id, count: 5, updatedAt: T0 }]);
    // 行のなかったセルに、ほかの人が行を足した：updatedAt を付けずに送る（DB は行があれば conflict）
    const q = setPendingCell({}, b.id, item('chair').id, 2, cellOfT(b, 'chair'));
    const added = { ...tables, requests: [...tables.requests, req(b, 'chair', 7, T1)] };
    expect(pendingChanges(q, added)).toEqual([{ groupId: b.id, itemId: item('chair').id, count: 2, updatedAt: null }]);
  });

  it('当て直し：DB と同じになったセルとなくなった団体・品目のセルだけを外す。行が基準から変わっても入れた数と基準は残す（裏の読み直しで入力を捨てない）', () => {
    let p = setPendingCell({}, a.id, item('desk').id, 5, cellOfT(a, 'desk'));
    p = setPendingCell(p, b.id, item('desk').id, 7, cellOfT(b, 'desk'));
    p = setPendingCell(p, b.id, item('chair').id, 2, cellOfT(b, 'chair'));
    p = setPendingCell(p, a.id, item('lectern').id, 1, cellOfT(a, 'lectern'));
    // 変わらなければ同じものを返す
    expect(rebasePending(p, tables)).toBe(p);
    // a の机：自分の数（5）になった → 外す。b の机：9 になった・b の椅子：行ができた → 残す（保存のときに確かめる）
    const after = {
      ...tables,
      requests: [req(a, 'desk', 5, T1), req(a, 'long_desk_3', 2), req(b, 'desk', 9, T1), req(b, 'chair', 3, T1), req(c, 'long_desk_3', 4)],
    };
    expect(rebasePending(p, after)).toEqual({
      [key(a, 'lectern')]: { value: 1, baseCount: 0, baseUpdatedAt: null },
      [key(b, 'desk')]: { value: 7, baseCount: 1, baseUpdatedAt: T0 },
      [key(b, 'chair')]: { value: 2, baseCount: 0, baseUpdatedAt: null },
    });
    // 応答が落ちた自分の保存（5）の後に 7 へ入れ直したセル：裏の読み直しで 5 に戻さない
    const mine = setPendingCell({}, b.id, item('desk').id, 7, cellOfT(b, 'desk'));
    const lost = { ...tables, requests: tables.requests.map((x) => (x.group_id === b.id && x.item_id === item('desk').id ? req(b, 'desk', 5, T1) : x)) };
    expect(rebasePending(mine, lost)).toBe(mine);
    // なくなった団体のセルは黙って外す
    expect(rebasePending(p, { ...tables, groups: [a, c, d] })).not.toHaveProperty(key(b, 'desk'));
  });

  it('基準を今の行に付け替える（値は残す。同じ数になれば外す）', () => {
    const p = setPendingCell({}, a.id, item('desk').id, 5, cellOfT(a, 'desk'));
    const after = { ...tables, requests: [req(a, 'desk', 4, T1)] };
    expect(rebaseKeysTo(p, [key(a, 'desk')], after)).toEqual({ [key(a, 'desk')]: { value: 5, baseCount: 4, baseUpdatedAt: T1 } });
    expect(rebaseKeysTo(p, [key(a, 'desk')], { ...tables, requests: [req(a, 'desk', 5, T1)] })).toEqual({});
  });

  it('下書きの値：形の違うもの・範囲の外の数は捨てる。比べる', () => {
    const good = { value: 5, baseCount: 3, baseUpdatedAt: T0 };
    const p = normalizePending({
      [key(a, 'desk')]: good,
      [key(a, 'chair')]: 9,
      [key(b, 'desk')]: { value: -1, baseCount: 0, baseUpdatedAt: null },
      [key(b, 'chair')]: { value: 2, baseCount: 0 },
      nokey: good,
    });
    expect(p).toEqual({ [key(a, 'desk')]: good });
    expect(normalizePending(null)).toEqual({});
    expect(normalizePending([1])).toEqual({});
    expect(samePending(p, { [key(a, 'desk')]: { ...good } })).toBe(true);
    expect(samePending(p, { [key(a, 'desk')]: { ...good, baseUpdatedAt: T1 } })).toBe(false);
    expect(samePending({}, {})).toBe(true);
  });

  it('品目ごとの合計は、表示している行に未保存の値を当てた数', () => {
    const m = buildRequestMatrix(tables, { category: 'stall' });
    const totals = columnTotals(m, { [cellKey(b.id, item('desk').id)]: { value: 10, baseCount: 1, baseUpdatedAt: T0 } });
    expect(totals[item('desk').id]).toBe(13);
    expect(totals[item('long_desk_3').id]).toBe(2);
  });
});

describe('前年の数（休憩所の代理入力）', () => {
  it('同じ団体名の前年度の数を入力欄の品目に当て、ほかは 0。今年の区分で申請できない品目は入れない', () => {
    const { fields } = buildRequestForm(ITEMS, 'rest_area', []);
    const rows = [
      { group_name: '休憩所1', item_id: item('desk').id, count: 6 },
      { group_name: '休憩所1', item_id: item('long_desk_3').id, count: 2 },
      { group_name: '休憩所2', item_id: item('chair').id, count: 9 },
    ];
    const counts = previousCountsFor(rows, '休憩所1', fields);
    expect(counts[item('desk').id]).toBe(6);
    expect(counts[item('chair').id]).toBe(0);
    expect(counts).not.toHaveProperty(item('long_desk_3').id);
    expect(hasNoRequests([])).toBe(true);
    expect(hasNoRequests([{ count: 0 }])).toBe(true);
    expect(hasNoRequests([{ count: 1 }])).toBe(false);
  });
});

describe('saveCellsDirect（締切前のセルの直接の書き込み）', () => {
  const g = group(10, '模擬店A', 'stall');
  const upd = { groupId: g.id, itemId: item('desk').id, count: 5, updatedAt: T0 };
  const ins = { groupId: g.id, itemId: item('chair').id, count: 2, updatedAt: null };
  const ins2 = { groupId: g.id, itemId: item('lectern').id, count: 1, updatedAt: null };

  it('行があれば updated_at で楽観ロックして更新、なければ insert。セルごとの結果を返す', async () => {
    const { client, issued } = createFakeSupabase((call: FakeCall) => {
      if (call.ops.some((o) => o.op === 'update')) return { data: { ...req(g, 'desk', 5, T1) } };
      if (call.ops.some((o) => o.op === 'insert')) return { data: { ...req(g, 'chair', 2, T1) } };
      throw new Error('読み直さないはず');
    });
    const res = await saveCellsDirect([upd, ins], client);
    expect(res.map((r) => r.ok)).toEqual([true, true]);
    expect(opArgs(issued[0]!, 'match')).toEqual([[{ group_id: g.id, item_id: item('desk').id }]]);
    expect(opArgs(issued[0]!, 'eq')).toEqual([['updated_at', T0]]);
    expect(opArgs(issued[1]!, 'insert')).toEqual([[{ group_id: g.id, item_id: item('chair').id, count: 2 }]]);
  });

  it('forbidden（RLS で拒否）が出たら残りは送らない。conflict は続ける', async () => {
    let n = 0;
    const { client, issued } = createFakeSupabase((call: FakeCall) => {
      n++;
      if (call.ops.some((o) => o.op === 'update')) return { data: null };
      if (call.ops.some((o) => o.op === 'select') && !call.ops.some((o) => o.op === 'insert')) return { data: { updated_at: T1 } }; // conflict
      return { error: { code: '42501', message: 'new row violates row-level security policy for table "requests"' }, status: 403 };
    });
    const res = await saveCellsDirect([upd, ins, ins2], client);
    expect(res).toHaveLength(2);
    expect(res[0]!.ok === false && res[0]!.error.info.kind).toBe('conflict');
    expect(res[1]!.ok === false && res[1]!.error.info.kind).toBe('forbidden');
    expect(issued.filter((c) => c.ops.some((o) => o.op === 'insert'))).toHaveLength(1);
    expect(n).toBe(3);
  });
});

describe('saveGroupsAfterDeadline（締切後の団体ごとの保存）', () => {
  it('団体ごとに理由つきで update_requests_after_deadline を呼び、forbidden・state で止める', async () => {
    const rpc = vi.mocked(callRpc);
    rpc.mockReset();
    rpc
      .mockResolvedValueOnce(null as never)
      .mockRejectedValueOnce(new AppError({ kind: 'conflict', code: 'P0001', reason: 'conflict', details: { item_id: uuid(100) }, issues: [], status: 400 }))
      .mockRejectedValueOnce(new AppError({ kind: 'state', code: 'P0001', reason: 'invalid_state', details: { status: 'confirmed' }, issues: [], status: 400 }));
    const rows = new Map([
      [uuid(10), [{ itemId: uuid(100), count: 1, updatedAt: T0 }]],
      [uuid(11), [{ itemId: uuid(100), count: 2 }]],
      [uuid(12), [{ itemId: uuid(100), count: 3 }]],
      [uuid(13), [{ itemId: uuid(100), count: 4 }]],
    ]);
    const res = await saveGroupsAfterDeadline(rows, '団体の希望');
    expect(res.map((r) => [r.groupId, r.ok])).toEqual([
      [uuid(10), true],
      [uuid(11), false],
      [uuid(12), false],
    ]);
    expect(rpc).toHaveBeenCalledTimes(3);
    expect(rpc.mock.calls[0]).toEqual([
      'update_requests_after_deadline',
      { p_group_id: uuid(10), p_rows: [{ itemId: uuid(100), count: 1, updatedAt: T0 }], p_reason: '団体の希望' },
    ]);
  });
});

describe('saveSummary（申請一覧の保存の結果の文）', () => {
  it('「保存できなかった」と「保存できたか分からない」の両方があれば、句点で区切る', () => {
    expect(saveSummary('件', { saved: 2, failed: 1, uncertain: 2, notSent: 0 })).toBe(
      '2 件を保存しました。1 件は保存できませんでした。2 件は保存できたか分かりません',
    );
    expect(saveSummary('団体', { saved: 0, failed: 1, uncertain: 1, notSent: 2 })).toBe(
      '0 団体を保存しました。1 団体は保存できませんでした。1 団体は保存できたか分かりません（2 団体は送っていません）',
    );
  });
  it('片方だけ・どちらもないとき', () => {
    expect(saveSummary('件', { saved: 2, failed: 1, uncertain: 0, notSent: 0 })).toBe('2 件を保存しました。1 件は保存できませんでした');
    expect(saveSummary('件', { saved: 1, failed: 0, uncertain: 1, notSent: 0 })).toBe('1 件を保存しました。1 件は保存できたか分かりません');
    expect(saveSummary('件', { saved: 1, failed: 0, uncertain: 0, notSent: 3 })).toBe('1 件を保存しました（3 件は送っていません）');
  });
});

describe('markSubmittedDirect（締切前の「提出済みにする」）', () => {
  const g = group(10, '模擬店A', 'stall');

  it('すでに提出済みなら書かずに、その記録を返す（提出日時を今に変えない）', async () => {
    const { client, issued } = createFakeSupabase((call: FakeCall) => {
      if (call.ops.some((o) => ['insert', 'update', 'upsert'].includes(o.op))) throw new Error('書かないはず');
      return { data: sub(g, T0, '電源') };
    });
    const res = await markSubmittedDirect(g.id, client);
    expect(res).toEqual({ row: sub(g, T0, '電源'), already: true });
    expect(issued).toHaveLength(1);
  });

  it('記録がなければ insert、未提出の記録があれば submitted_at が空の行だけを update する', async () => {
    const calls: FakeCall[] = [];
    const none = createFakeSupabase((call: FakeCall) => {
      calls.push(call);
      if (call.ops.some((o) => o.op === 'insert')) return { data: sub(g, T1) };
      return { data: null };
    });
    expect(await markSubmittedDirect(g.id, none.client)).toEqual({ row: sub(g, T1), already: false });
    expect(calls.some((c) => c.ops.some((o) => o.op === 'upsert'))).toBe(false);

    const unsubmitted = createFakeSupabase((call: FakeCall) => {
      if (call.ops.some((o) => o.op === 'update')) {
        expect(opArgs(call, 'is')).toEqual([['submitted_at', null]]);
        return { data: sub(g, T1, 'メモ') };
      }
      return { data: sub(g, null, 'メモ') };
    });
    expect(await markSubmittedDirect(g.id, unsubmitted.client)).toEqual({ row: sub(g, T1, 'メモ'), already: false });
  });

  it('書く直前にほかの人が提出していれば（0 行・一意の違反）、読み直して already を返す', async () => {
    let reads = 0;
    const { client } = createFakeSupabase((call: FakeCall) => {
      if (call.ops.some((o) => o.op === 'insert')) return { error: { code: '23505', message: 'duplicate key' }, status: 409 };
      reads++;
      return { data: reads === 1 ? null : sub(g, T1) };
    });
    expect(await markSubmittedDirect(g.id, client)).toEqual({ row: sub(g, T1), already: true });
  });
});

describe('judgePendingCells（申請一覧の送る前の判定。2.6 の (A)）', () => {
  const g = group(10, '模擬店A', 'stall');
  const t = (requests: RequestDbRow[]) => ({ requests });
  const desk = cellKey(g.id, item('desk').id);
  const chair = cellKey(g.id, item('chair').id);
  const pending = {
    [desk]: { value: 5, baseCount: 3, baseUpdatedAt: T0 },
    [chair]: { value: 2, baseCount: 0, baseUpdatedAt: null },
  };

  it('誰も変えていなければどれも送る（saved・conflicts は空）', () => {
    expect(judgePendingCells(pending, t([req(g, 'desk', 3, T0)]))).toEqual({ saved: [], conflicts: [] });
  });

  it('DB がすでに入れた数（前に送って応答が届かなかった保存が通っていた）なら saved', () => {
    expect(judgePendingCells(pending, t([req(g, 'desk', 5, T1), req(g, 'chair', 2, T1)])).saved.sort()).toEqual([desk, chair].sort());
  });

  it('数が入力の元とも入れた数とも違えば conflicts（ほかの人の変更）。入力の元と同じ数への書き直しは送る', () => {
    const r = judgePendingCells(pending, t([req(g, 'desk', 4, T1), req(g, 'chair', 0, T1)]));
    expect(r.saved).toEqual([]);
    expect(r.conflicts).toEqual([{ key: desk, groupId: g.id, itemId: item('desk').id, base: 3, fresh: 4, value: 5 }]);
  });
});

describe('markSubmittedAfterDeadline（締切後の「提出済みにする」）', () => {
  const g = group(10, '模擬店A', 'stall');

  it('送る前に提出の記録を読み直し、すでに提出済みなら送らずにその記録を返す。未提出なら理由つきで送る', async () => {
    vi.mocked(callRpc).mockReset();
    const submitted = createFakeSupabase(() => ({ data: { ...sub(g, T0), updated_by: null } }));
    expect(await markSubmittedAfterDeadline(g.id, '紙で提出済み', submitted.client)).toEqual({ ...sub(g, T0), updated_by: null });
    expect(callRpc).not.toHaveBeenCalled();

    const none = createFakeSupabase(() => ({ data: { ...sub(g, null), updated_by: null } }));
    expect(await markSubmittedAfterDeadline(g.id, '紙で提出済み', none.client)).toBeNull();
    expect(callRpc).toHaveBeenCalledWith('update_requests_after_deadline', {
      p_group_id: g.id,
      p_rows: [],
      p_reason: '紙で提出済み',
      p_submission: { submitted: true },
    });
  });
});
