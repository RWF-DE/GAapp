// テント等の貸し出しの読み書き（T21。notes/T21.md「画面の約束」2・9）：/lending の読み取り（閲覧のみは申請・記録を読まない）、申請の
// テント等のタブの読み取りと、タブを出すかの読み取り（割り当ては年度の確定の印があるときだけ数える。記録は確定の前でも）、
// 割り当ての未保存の変更と送る形（count null・updatedAt）・返り値の当て方・読み直しの決め方、(A) の決め方（申請・記録。保存されていた・
// ほかの人・自分の書いたもの）、備品の (B1)（登録の 23505・応答なし・conflict・消えていた・削除）、upsert の形、RPC の zod。
import { describe, expect, it, vi } from 'vitest';
import { AppError, appError } from '@/lib/errors';
import { lendingAssignmentChangesPayload, RPC_ARGS } from '@/lib/rpc/payloads';
import { createFakeSupabase, opArgs, type FakeCall } from '@/lib/testing/fake-supabase';
import {
  applyAssignmentResult,
  assignmentChanges,
  assignmentRowsChanged,
  changedLendingRequests,
  decideLendingRecordSave,
  decideLendingRequestSave,
  fetchLendingBoard,
  fetchLendingRequestItems,
  fetchLendingRequestTab,
  LENDING_REQUEST_ITEMS_SELECT,
  LENDING_REQUEST_TAB_SELECT,
  lendingBoardOptions,
  lendingInvalidateKeys,
  pruneAssignmentEdits,
  readAssignmentRows,
  rebaseAssignmentEdits,
  replaceAssignmentRows,
  runLendingItemDelete,
  runLendingItemSave,
  sameAssignmentInput,
  saveLendingRecords,
  saveLendingRequests,
  type LendingAssignmentRow,
  type LendingItemRow,
} from './lending';

const Y = '00000000-0000-4000-8000-000000000001';
const G1 = '00000000-0000-4000-8000-000000000011';
const G2 = '00000000-0000-4000-8000-000000000012';
const TENT = '00000000-0000-4000-8000-000000000101';
const WEIGHT = '00000000-0000-4000-8000-000000000102';
const V1 = '2026-10-01T00:00:00.123456+00:00';
const V2 = '2026-10-02T00:00:00.654321+00:00';
const ME = 'u-me';

const row = (g: string, i: string, count: number, updated_at = V1): LendingAssignmentRow => ({ group_id: g, lending_item_id: i, count, updated_at });
const noAuth = async () => 'other' as const;
const network = () => new TypeError('Failed to fetch');

describe('T21 /lending の読み取り', () => {
  it('総務：備品・団体（使用場所の名前と種類）・割り当て・確定の印・申請・記録を並行に。閲覧のみは申請と記録を読まない', async () => {
    const calls: FakeCall[] = [];
    const { client } = createFakeSupabase((call) => {
      calls.push(call);
      if (call.table === 'lending_years') return { data: { year_id: Y, confirmed_at: '2026-10-12T08:00:00Z' } };
      if (call.table === 'groups') return { data: [{ id: G1, name: 'A', category: 'stall', sort_order: 0, location_room_id: 'r1', location_room: { name: '1-1', kind: 'outdoor' } }] };
      return { data: [] };
    });
    const soumu = await fetchLendingBoard(Y, true, client);
    expect(calls.map((c) => c.table).sort()).toEqual(['groups', 'lending_assignments', 'lending_items', 'lending_records', 'lending_requests', 'lending_years']);
    expect(soumu.confirmedAt).toBe('2026-10-12T08:00:00Z');
    expect(soumu.groups[0]).toMatchObject({ id: G1, location: { name: '1-1', kind: 'outdoor' } });
    expect(soumu.requests).toEqual([]);
    calls.length = 0;
    const viewer = await fetchLendingBoard(Y, false, client);
    expect(calls.map((c) => c.table).sort()).toEqual(['groups', 'lending_assignments', 'lending_items', 'lending_years']);
    expect(viewer.requests).toBeNull();
    expect(viewer.records).toBeNull();
    expect(lendingBoardOptions(Y, true).queryKey).toEqual(['year', Y, 'lending', 'board', 'soumu']);
    expect(lendingBoardOptions(Y, false).queryKey).toEqual(['year', Y, 'lending', 'board', 'viewer']);
    expect(lendingInvalidateKeys(Y)).toEqual([
      ['year', Y, 'lending'],
      ['year', Y, 'portal', 'lending'],
    ]);
  });
});

describe('T21 申請のテント等のタブの読み取り（レビューの T21-R1）', () => {
  it('団体に申請・割り当て・記録と年度の確定の印を埋め込んで1本（団体と年度で絞る）。備品の id の順。埋め込みが配列で返っても読む', async () => {
    const calls: FakeCall[] = [];
    const { client } = createFakeSupabase((call) => {
      calls.push(call);
      return {
        data: {
          id: G1,
          lending_requests: [
            { group_id: G1, lending_item_id: WEIGHT, count: 4, updated_by: ME, updated_at: V1 },
            { group_id: G1, lending_item_id: TENT, count: 2, updated_by: ME, updated_at: V2 },
          ],
          lending_assignments: [{ group_id: G1, lending_item_id: TENT, count: 1 }],
          lending_records: [{ group_id: G1, lending_item_id: TENT, lent_count: 1, returned_count: 0, damaged_count: 0 }],
          years: [{ lending_years: [{ confirmed_at: '2026-10-12T08:00:00Z' }] }],
        },
      };
    });
    const tab = await fetchLendingRequestTab(Y, G1, client);
    expect(calls).toHaveLength(1);
    expect(calls[0]!.table).toBe('groups');
    expect(opArgs(calls[0]!, 'select')[0]![0]).toBe(LENDING_REQUEST_TAB_SELECT);
    expect(opArgs(calls[0]!, 'eq')).toEqual([
      ['id', G1],
      ['year_id', Y],
    ]);
    expect(tab.requests.map((r) => r.lending_item_id)).toEqual([TENT, WEIGHT].sort());
    expect(tab.confirmedAt).toBe('2026-10-12T08:00:00Z');
    expect(tab.assignments).toEqual([{ group_id: G1, lending_item_id: TENT, count: 1 }]);
    expect(tab.records).toEqual([{ group_id: G1, lending_item_id: TENT, lent_count: 1, returned_count: 0, damaged_count: 0 }]);
  });

  it('確定の印の行がない（確定前）・団体が読めないときは空。読めなければ AppError', async () => {
    const before = createFakeSupabase(() => ({ data: { id: G1, lending_requests: [], lending_assignments: [], lending_records: [], years: { lending_years: null } } }));
    expect(await fetchLendingRequestTab(Y, G1, before.client)).toMatchObject({ requests: [], confirmedAt: null, assignments: [], records: [] });
    const none = createFakeSupabase(() => ({ data: null }));
    expect(await fetchLendingRequestTab(Y, G1, none.client)).toMatchObject({ requests: [], confirmedAt: null, assignments: [], records: [] });
    const failed = createFakeSupabase(() => ({ error: { code: 'XX000', message: 'boom' }, status: 500 }));
    await expect(fetchLendingRequestTab(Y, G1, failed.client)).rejects.toBeInstanceOf(AppError);
  });
});

describe('T21 申請のテント等のタブを出すかの読み取り（2026-11-01 のリードの決定・タブの直しのレビューの T21-R6）', () => {
  const ITEM = { id: TENT, name: 'テント', unit: '張', requestable_categories: ['stall'], sort_order: 1 };
  const CONFIRMED = '2026-10-12T08:00:00Z';
  /** 備品1つ（その団体の割り当て・記録の埋め込みと、年度の確定の印 years を返す）を読む */
  const read = async (embeds: { assigned: boolean; lent: boolean; years: unknown }) => {
    const calls: FakeCall[] = [];
    const { client } = createFakeSupabase((call) => {
      calls.push(call);
      return {
        data: [
          {
            ...ITEM,
            lending_assignments: embeds.assigned ? [{ lending_item_id: TENT }] : [],
            lending_records: embeds.lent ? [{ lending_item_id: TENT }] : [],
            years: embeds.years,
          },
        ],
      };
    });
    const items = await fetchLendingRequestItems(Y, G1, client);
    expect(calls).toHaveLength(1);
    expect(opArgs(calls[0]!, 'select')[0]![0]).toBe(LENDING_REQUEST_ITEMS_SELECT);
    return items;
  };

  it('割り当ては年度の確定の印があるときだけ数える（管理者が団体の代表を兼ねると確定前の割り当ても RLS が返す）。確定の印はオブジェクトでも配列でも読み、埋め込みは返す備品に残さない', async () => {
    // 確定前（確定の印の行がない・解除して confirmed_at が null・年度が読めない）
    for (const years of [{ lending_years: null }, { lending_years: { confirmed_at: null } }, null, [{ lending_years: [] }]]) {
      expect(await read({ assigned: true, lent: false, years }), JSON.stringify(years)).toEqual([{ ...ITEM, assigned: false, lent: false }]);
    }
    // 確定後
    for (const years of [{ lending_years: { confirmed_at: CONFIRMED } }, [{ lending_years: [{ confirmed_at: CONFIRMED }] }]]) {
      expect(await read({ assigned: true, lent: false, years }), JSON.stringify(years)).toEqual([{ ...ITEM, assigned: true, lent: false }]);
    }
  });

  it('記録（渡した数が1以上）は確定の前でも数える', async () => {
    expect(await read({ assigned: false, lent: true, years: { lending_years: null } })).toEqual([{ ...ITEM, assigned: false, lent: true }]);
    expect(await read({ assigned: true, lent: true, years: { lending_years: { confirmed_at: CONFIRMED } } })).toEqual([{ ...ITEM, assigned: true, lent: true }]);
  });
});

describe('T21 割り当ての未保存の変更と送る形', () => {
  const rows = [row(G1, TENT, 2), row(G2, TENT, 0, V2)];

  it('今の DB と同じ値は送らない。updatedAt は入力を始めたときの版（裏の読み直しで進めない）、null は行を消す（行がなければ送らない）', () => {
    const edits = new Map([
      [`${G1}:${TENT}`, { count: 2, base: V1 }],
      [`${G2}:${TENT}`, { count: null, base: V1 }],
      [`${G1}:${WEIGHT}`, { count: 5, base: null }],
      [`${G2}:${WEIGHT}`, { count: null, base: null }],
    ]);
    // G2 のテントは入力を始めた後にほかの人が V2 にした：送る版は入力を始めたときの V1（DB が conflict で止める）
    expect(assignmentChanges(edits, rows)).toEqual([
      { groupId: G1, itemId: WEIGHT, count: 5, updatedAt: null },
      { groupId: G2, itemId: TENT, count: null, updatedAt: V1 },
    ]);
    expect([...pruneAssignmentEdits(edits, rows)]).toEqual([
      [`${G2}:${TENT}`, { count: null, base: V1 }],
      [`${G1}:${WEIGHT}`, { count: 5, base: null }],
    ]);
    // conflict で読み直した組だけ、版を読み直した行に進める（入力は残す）
    expect([...rebaseAssignmentEdits(edits, [`${G2}:${TENT}`, `${G1}:${WEIGHT}`], [row(G2, TENT, 0, V2)])]).toEqual([
      [`${G1}:${TENT}`, { count: 2, base: V1 }],
      [`${G2}:${TENT}`, { count: null, base: V2 }],
      [`${G1}:${WEIGHT}`, { count: 5, base: null }],
      [`${G2}:${WEIGHT}`, { count: null, base: null }],
    ]);
  });

  it('返り値を一覧に当てる（count が null は行を消す。updatedAt は返った版）。組の行を読み直した行に置き換える', () => {
    const next = applyAssignmentResult(rows, [
      { groupId: G1, itemId: TENT, count: 3, updatedAt: V2 },
      { groupId: G2, itemId: TENT, count: null, updatedAt: null },
    ]);
    expect(next).toEqual([row(G1, TENT, 3, V2)]);
    expect(replaceAssignmentRows(rows, [`${G2}:${TENT}`], [])).toEqual([row(G1, TENT, 2)]);
  });

  it('読み直した行が送った変更と同じか・送った版から変わったか（ミリ秒までで比べる）', () => {
    const changes = [
      { groupId: G1, itemId: TENT, count: 2, updatedAt: V1 },
      { groupId: G2, itemId: TENT, count: null, updatedAt: V2 },
    ];
    expect(sameAssignmentInput([row(G1, TENT, 2)], changes)).toBe(true);
    expect(sameAssignmentInput(rows, changes)).toBe(false);
    expect(assignmentRowsChanged(rows, changes)).toBe(false);
    // マイクロ秒だけ違う版は同じ（DB もミリ秒までで比べる）
    expect(assignmentRowsChanged([row(G1, TENT, 2, '2026-10-01T00:00:00.123999+00:00'), rows[1]!], changes)).toBe(false);
    expect(assignmentRowsChanged([row(G1, TENT, 2, V2), rows[1]!], changes)).toBe(true);
    // 行が消えた・できた
    expect(assignmentRowsChanged([row(G1, TENT, 2)], changes)).toBe(true);
    expect(assignmentRowsChanged([row(G1, WEIGHT, 1)], [{ groupId: G1, itemId: WEIGHT, count: 1, updatedAt: null }])).toBe(true);
  });

  it('送った組の行を読み直す（年度・団体・備品で絞り、組に当てる）。組がなければ読まない', async () => {
    const calls: FakeCall[] = [];
    const { client } = createFakeSupabase((call) => {
      calls.push(call);
      return { data: [row(G1, TENT, 1), row(G1, WEIGHT, 4), row(G2, TENT, 7)] };
    });
    const fresh = await readAssignmentRows(
      Y,
      [
        { groupId: G1, itemId: TENT },
        { groupId: G2, itemId: TENT },
      ],
      client,
    );
    expect(fresh).toEqual([row(G1, TENT, 1), row(G2, TENT, 7)]);
    expect(opArgs(calls[0]!, 'eq')).toContainEqual(['year_id', Y]);
    expect(opArgs(calls[0]!, 'in')).toEqual([
      ['group_id', [G1, G2]],
      ['lending_item_id', [TENT]],
    ]);
    expect(await readAssignmentRows(Y, [], client)).toEqual([]);
    expect(calls).toHaveLength(1);
  });

  it('save_lending_assignments の zod：1〜1000 件、同じ団体・備品は1つだけ、count は 0〜10000 か null、4つのキーだけ', () => {
    const ok = { groupId: G1, itemId: TENT, count: 1, updatedAt: null };
    expect(lendingAssignmentChangesPayload.safeParse([ok]).success).toBe(true);
    expect(lendingAssignmentChangesPayload.safeParse([{ ...ok, count: null, updatedAt: V1 }]).success).toBe(true);
    expect(lendingAssignmentChangesPayload.safeParse([]).success).toBe(false);
    expect(lendingAssignmentChangesPayload.safeParse([ok, { ...ok, count: 2 }]).success).toBe(false);
    expect(lendingAssignmentChangesPayload.safeParse([{ ...ok, count: 10001 }]).success).toBe(false);
    expect(lendingAssignmentChangesPayload.safeParse([{ ...ok, extra: 1 }]).success).toBe(false);
    expect(lendingAssignmentChangesPayload.safeParse(Array.from({ length: 1001 }, (_, k) => ({ ...ok, groupId: `00000000-0000-4000-8000-${String(k).padStart(12, '0')}` }))).success).toBe(false);
    expect(RPC_ARGS.set_lending_confirmed.safeParse({ p_year_id: Y, p_confirmed: false, p_reason: '  直す ' }).data).toEqual({ p_year_id: Y, p_confirmed: false, p_reason: '直す' });
    expect(RPC_ARGS.previous_year_lending_items.safeParse({ p_year_id: 'x' }).success).toBe(false);
  });
});

describe('T21 (A) の決め方', () => {
  const req = (i: string, count: number, updated_at: string, updated_by: string | null) => ({ group_id: G1, lending_item_id: i, count, updated_at, updated_by });

  it('申請：読み直した値が入力と同じで行が変わっていれば保存されていた。ほかの人の変更があれば上書きの確かめ。自分の書いたものは数えない', () => {
    const base = [req(TENT, 1, V1, ME)];
    const itemIds = [TENT, WEIGHT];
    // 前の保存が通っていた（入力と同じ。書いた人は自分）
    expect(decideLendingRequestSave({ itemIds, counts: { [TENT]: 2, [WEIGHT]: 0 }, base, fresh: [req(TENT, 2, V2, ME), req(WEIGHT, 0, V2, ME)], userId: ME })).toBe('saved');
    // ほかの人が変えた
    expect(decideLendingRequestSave({ itemIds, counts: { [TENT]: 3 }, base, fresh: [req(TENT, 2, V2, 'other')], userId: ME })).toBe('conflict');
    // 誰も変えていない
    expect(decideLendingRequestSave({ itemIds, counts: { [TENT]: 3 }, base, fresh: base, userId: ME })).toBe('send');
    // 自分の前の保存（入力と違う）が通っていた：ほかの人ではないので送る
    expect(decideLendingRequestSave({ itemIds, counts: { [TENT]: 3 }, base, fresh: [req(TENT, 2, V2, ME)], userId: ME })).toBe('send');
    // 書いた人が分からない（seed）はほかの人
    expect(decideLendingRequestSave({ itemIds, counts: { [TENT]: 3 }, base: [], fresh: [req(TENT, 2, V2, null)], userId: ME })).toBe('conflict');
    expect(changedLendingRequests(itemIds, base, [req(TENT, 2, V2, 'other'), req(WEIGHT, 0, V2, 'other')])).toEqual([{ itemId: TENT, from: 1, to: 2 }]);
  });

  it('記録：渡した・返った・破損・メモ（null と空をそろえる）を比べる', () => {
    const r = (lent: number, returned: number, damaged: number, note: string | null, updated_at: string, updated_by: string | null) => ({
      group_id: G1,
      lending_item_id: TENT,
      lent_count: lent,
      returned_count: returned,
      damaged_count: damaged,
      note,
      updated_at,
      updated_by,
    });
    const values = { [TENT]: { lent_count: 2, returned_count: 1, damaged_count: 1, note: '破れ' } };
    const base = [r(2, 0, 0, null, V1, ME)];
    expect(decideLendingRecordSave({ itemIds: [TENT], values, base, fresh: [r(2, 1, 1, ' 破れ ', V2, ME)], userId: ME })).toBe('saved');
    expect(decideLendingRecordSave({ itemIds: [TENT], values, base, fresh: [r(2, 2, 0, null, V2, 'other')], userId: ME })).toBe('conflict');
    expect(decideLendingRecordSave({ itemIds: [TENT], values, base, fresh: base, userId: ME })).toBe('send');
    // 記録のない備品は 0 とメモなし
    expect(decideLendingRecordSave({ itemIds: [TENT], values: { [TENT]: { lent_count: 0, returned_count: 0, damaged_count: 0, note: '' } }, base: [], fresh: [], userId: ME })).toBe('send');
  });

  it('申請と記録は団体の行の upsert（団体と備品が衝突のキー）。記録のメモは前後の空白を除き、空なら null', async () => {
    const calls: FakeCall[] = [];
    const { client } = createFakeSupabase((call) => {
      calls.push(call);
      return { data: [] };
    });
    await saveLendingRequests([{ group_id: G1, lending_item_id: TENT, year_id: Y, count: 2 }], client);
    await saveLendingRecords([{ group_id: G1, lending_item_id: TENT, year_id: Y, lent_count: 1, returned_count: 0, damaged_count: 0, note: '  ' }], client);
    expect(calls.map((c) => c.table)).toEqual(['lending_requests', 'lending_records']);
    expect(opArgs(calls[0]!, 'upsert')[0]).toEqual([[{ group_id: G1, lending_item_id: TENT, year_id: Y, count: 2 }], { onConflict: 'group_id,lending_item_id' }]);
    expect(opArgs(calls[1]!, 'upsert')[0]![0]).toEqual([{ group_id: G1, lending_item_id: TENT, year_id: Y, lent_count: 1, returned_count: 0, damaged_count: 0, note: null }]);
  });
});

describe('T21 備品の (B1)', () => {
  const W = { name: 'テント', unit: '張', stock: 3, requestable_categories: ['stall' as const], sort_order: 1 };
  const item = (over: Partial<LendingItemRow> = {}): LendingItemRow => ({ id: TENT, year_id: Y, ...W, updated_at: V1, ...over });
  const dup = () => new AppError({ kind: 'conflict', code: '23505', reason: null, details: null, issues: [], status: 409 });

  it('登録：送れたら saved。23505 で id の行が入力と同じなら登録されていた、id の行がなければ同じ名前（duplicate）', async () => {
    expect(await runLendingItemSave({ baseVersion: null, write: W, send: async () => item(), reread: async () => null }, noAuth)).toEqual({
      type: 'saved',
      row: item(),
      before: false,
    });
    const send = vi.fn(async () => {
      throw dup();
    });
    expect(await runLendingItemSave({ baseVersion: null, write: W, send, reread: async () => item() }, noAuth)).toEqual({ type: 'saved', row: item(), before: true });
    expect(await runLendingItemSave({ baseVersion: null, write: W, send, reread: async () => null }, noAuth)).toMatchObject({ type: 'duplicate' });
    // id の行が入力と違う（ほかの人が直した）：その備品の編集に切り替える
    expect(await runLendingItemSave({ baseVersion: null, write: W, send, reread: async () => item({ stock: 9, updated_at: V2 }) }, noAuth)).toEqual({
      type: 'conflict',
      row: item({ stock: 9, updated_at: V2 }),
    });
  });

  it('登録：応答が届かず行がない・読み直せないときは分からない（もう一度押すと同じ id で送る）', async () => {
    const send = async () => {
      throw network();
    };
    expect(await runLendingItemSave({ baseVersion: null, write: W, send, reread: async () => null }, noAuth)).toEqual({ type: 'unknown' });
    expect(
      await runLendingItemSave(
        {
          baseVersion: null,
          write: W,
          send,
          reread: async () => {
            throw network();
          },
        },
        noAuth,
      ),
    ).toEqual({ type: 'unknown' });
  });

  it('保存：conflict は読み直した行で conflict、消えていれば missing、止められた後に読み直せなければ unread。forbidden は failed', async () => {
    const conflict = async () => {
      throw appError('conflict', 'lock_conflict');
    };
    expect(await runLendingItemSave({ baseVersion: V1, write: { ...W, stock: 4 }, send: conflict, reread: async () => item({ updated_at: V2 }) }, noAuth)).toEqual({
      type: 'conflict',
      row: item({ updated_at: V2 }),
    });
    expect(await runLendingItemSave({ baseVersion: V1, write: { ...W, stock: 4 }, send: conflict, reread: async () => null }, noAuth)).toEqual({ type: 'missing' });
    expect(
      await runLendingItemSave(
        {
          baseVersion: V1,
          write: { ...W, stock: 4 },
          send: conflict,
          reread: async () => {
            throw network();
          },
        },
        noAuth,
      ),
    ).toEqual({ type: 'unread' });
    const forbidden = appError('forbidden', 'lock_unchanged');
    expect(
      await runLendingItemSave(
        {
          baseVersion: V1,
          write: W,
          send: async () => {
            throw forbidden;
          },
          reread: async () => item(),
        },
        noAuth,
      ),
    ).toEqual({ type: 'failed', error: forbidden });
  });

  it('削除：not_found は削除されていた、conflict は版が違う、23503 は failed。応答が届かなければ読み直す', async () => {
    const del = (e: unknown) => async () => {
      throw e;
    };
    expect(await runLendingItemDelete({ send: async () => item(), reread: async () => null, baseVersion: V1 }, noAuth)).toEqual({ type: 'deleted', before: false });
    expect(await runLendingItemDelete({ send: del(appError('not_found', 'lock_missing')), reread: async () => null, baseVersion: V1 }, noAuth)).toEqual({
      type: 'deleted',
      before: true,
    });
    expect(await runLendingItemDelete({ send: del(appError('conflict', 'lock_conflict')), reread: async () => null, baseVersion: V1 }, noAuth)).toEqual({ type: 'changed' });
    const blocked = new AppError({ kind: 'blocked', code: '23503', reason: null, details: null, issues: [], status: 409 });
    expect(await runLendingItemDelete({ send: del(blocked), reread: async () => null, baseVersion: V1 }, noAuth)).toEqual({ type: 'failed', error: blocked });
    expect(await runLendingItemDelete({ send: del(network()), reread: async () => null, baseVersion: V1 }, noAuth)).toEqual({ type: 'deleted', before: false });
    expect(await runLendingItemDelete({ send: del(network()), reread: async () => item({ updated_at: V2 }), baseVersion: V1 }, noAuth)).toEqual({ type: 'changed' });
    expect(await runLendingItemDelete({ send: del(network()), reread: async () => item(), baseVersion: V1 }, noAuth)).toEqual({ type: 'unknown' });
  });

  it('401：セッションを更新できたら1回だけ送り直す', async () => {
    let n = 0;
    const send = async () => {
      n++;
      if (n === 1) throw { code: 'PGRST303', message: 'JWT expired' };
      return item();
    };
    expect(await runLendingItemSave({ baseVersion: null, write: W, send, reread: async () => null }, async () => 'retry')).toMatchObject({ type: 'saved', before: false });
    expect(n).toBe(2);
  });
});
