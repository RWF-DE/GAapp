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
  extraRowNote,
  groupDeadlineRows,
  hasCountChanges,
  hasNoRequests,
  isOutsideFlagActive,
  isPastDeadline,
  judgeDirectFailure,
  judgeSubmitFailure,
  nonZeroSummary,
  outsideFlagOf,
  pendingChanges,
  previousCountsFor,
  normalizePending,
  rebaseKeysTo,
  rebasePending,
  samePending,
  remainingText,
  requestWindowOf,
  saveCellsDirect,
  saveGroupsAfterDeadline,
  setPendingCell,
  sortGroups,
  submittedByOthers,
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

  it('読み込んだ後にほかの代表者が提出したか', () => {
    expect(submittedByOthers(null, null)).toBe(false);
    expect(submittedByOthers(null, { submitted_at: T0 })).toBe(true);
    expect(submittedByOthers({ submitted_at: T0 }, { submitted_at: T0 })).toBe(false);
    expect(submittedByOthers({ submitted_at: T0 }, { submitted_at: T1 })).toBe(true);
    expect(submittedByOthers({ submitted_at: T1 }, { submitted_at: T0 })).toBe(false);
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

  it('未保存のセル：基準（最初に編集したときの行）の数と同じなら外す。変更の一覧は基準の updated_at を付け、申請できない品目は 0 だけ通す', () => {
    let p = setPendingCell({}, a.id, item('desk').id, 5, cellOfT(a, 'desk'));
    p = setPendingCell(p, b.id, item('chair').id, 2, cellOfT(b, 'chair'));
    p = setPendingCell(p, a.id, item('long_desk_3').id, 0, cellOfT(a, 'long_desk_3'));
    p = setPendingCell(p, b.id, item('long_desk_3').id, 1, cellOfT(b, 'long_desk_3'));
    expect(p[key(a, 'desk')]).toEqual({ value: 5, baseCount: 3, baseUpdatedAt: T0 });
    expect(p[key(b, 'chair')]).toEqual({ value: 2, baseCount: 0, baseUpdatedAt: null });
    // 2回目の編集は基準を変えない（今の行が変わっていても、最初に編集したときの行のまま）
    const later = { count: 4, updatedAt: T1 };
    expect(setPendingCell(p, a.id, item('desk').id, 6, later)[key(a, 'desk')]).toEqual({ value: 6, baseCount: 3, baseUpdatedAt: T0 });
    expect(setPendingCell(p, a.id, item('desk').id, 3, later)).not.toHaveProperty(key(a, 'desk'));
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

  it('当て直し：DB と同じになったセルは外し、基準から行が変わったセルは読み直した値に戻して conflicts に入れる', () => {
    let p = setPendingCell({}, a.id, item('desk').id, 5, cellOfT(a, 'desk'));
    p = setPendingCell(p, b.id, item('desk').id, 7, cellOfT(b, 'desk'));
    p = setPendingCell(p, b.id, item('chair').id, 2, cellOfT(b, 'chair'));
    p = setPendingCell(p, a.id, item('lectern').id, 1, cellOfT(a, 'lectern'));
    // 変わらなければ同じものを返す
    expect(rebasePending(p, tables).pending).toBe(p);
    // a の机：自分の数（5）になった → 外す。b の机：ほかの人が 9 にした → 戻して印。b の椅子：ほかの人が行を足した → 戻して印
    const after = {
      ...tables,
      requests: [req(a, 'desk', 5, T1), req(a, 'long_desk_3', 2), req(b, 'desk', 9, T1), req(b, 'chair', 3, T1), req(c, 'long_desk_3', 4)],
    };
    const r = rebasePending(p, after);
    expect(r.pending).toEqual({ [key(a, 'lectern')]: { value: 1, baseCount: 0, baseUpdatedAt: null } });
    expect(r.conflicts.sort()).toEqual([key(b, 'desk'), key(b, 'chair')].sort());
    // 行が消えた（not_found）も戻す
    const removed = { ...tables, requests: tables.requests.filter((x) => !(x.group_id === b.id && x.item_id === item('desk').id)) };
    expect(rebasePending(setPendingCell({}, b.id, item('desk').id, 7, cellOfT(b, 'desk')), removed).conflicts).toEqual([key(b, 'desk')]);
    // なくなった団体のセルは黙って外す
    expect(rebasePending(p, { ...tables, groups: [a, c, d] }).pending).not.toHaveProperty(key(b, 'desk'));
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
