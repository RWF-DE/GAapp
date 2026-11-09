// 備品（数えるだけ。T22・D-60）の純粋な関数と読み書き（lib/data/stocks.ts の備品〔数えるだけ〕の節）。
import { describe, expect, it } from 'vitest';
import type { CountItemRow, CountStockDbRow, RoomRow, StockDbRow } from '@/lib/db/types';
import { COUNT_ITEM_DUPLICATE_MESSAGE, COUNT_ITEM_IN_USE_MESSAGE, COUNT_ITEM_NAME_MESSAGE, classifyError, messageFor, toAppError } from '@/lib/errors';
import { RPC_ARGS } from '@/lib/rpc/payloads';
import { stockCountsSchema, stockDraftSchema } from '@/lib/schemas/stock';
import { countItemFormSchema } from '@/lib/schemas/settings';
import { createFakeSupabase, opArgs } from '@/lib/testing/fake-supabase';
import {
  addableCountItems,
  addCountItem,
  buildCountMatrix,
  CountSaveError,
  fetchPreviousYearCountStocks,
  fetchRoomLines,
  findCountItemByName,
  formatCell,
  mergeRoomRows,
  previousLineMap,
  saveRoomLines,
  shownCountItems,
  splitRoomRows,
  storageRooms,
  toCountUpsertRows,
} from './stocks';

const Y = '11111111-1111-4111-8111-111111111111';
const id = (n: number) => `00000000-0000-4000-8000-${String(n).padStart(12, '0')}`;
const R1 = id(1);
const R2 = id(2);
const DESK = id(101);
const ci = (n: number, name: string, always: boolean, sort = n): CountItemRow => ({ id: id(200 + n), name, always_shown: always, sort_order: sort, updated_at: 't' });
const TRASH = ci(1, 'ゴミ箱', true);
const CORD = ci(2, '延長コード', true);
const WHITE = ci(5, '白椅子', false);
const VACUUM = ci(6, '掃除機', false);
const LAN = ci(7, 'LANケーブル', false);
const ITEMS = [VACUUM, WHITE, CORD, TRASH, LAN];

const stockRow = (count: number): StockDbRow => ({ year_id: Y, room_id: R1, item_id: DESK, count, counted_at: 'a', counted_by: null, updated_at: 'u' });
const countRow = (c: CountItemRow, count: number, room = R1): CountStockDbRow => ({
  year_id: Y,
  room_id: room,
  count_item_id: c.id,
  count,
  counted_at: 'a',
  counted_by: null,
  updated_at: `u-${c.id}`,
});
const room = (n: number): RoomRow => ({
  id: id(n),
  name: `倉庫${n}`,
  aliases: [],
  kind: 'room',
  building: 'E2E棟',
  floor: 1,
  extra_cost: 0,
  is_storage: true,
  sort_order: n,
  updated_at: 't',
});

describe('在庫と数の行をまとめる（行のキーは品目の id と c:<id>）', () => {
  it('mergeRoomRows と splitRoomRows は逆の関係（在庫が先、数は item_id に c: のキー）', () => {
    const merged = mergeRoomRows([stockRow(3)], [countRow(TRASH, 4)]);
    expect(merged.map((r) => r.item_id)).toEqual([DESK, `c:${TRASH.id}`]);
    expect(merged[1]).toMatchObject({ count: 4, updated_at: `u-${TRASH.id}` });
    expect(splitRoomRows(merged)).toEqual({ stocks: [stockRow(3)], counts: [countRow(TRASH, 4)] });
  });

  it('入力と下書きの形は c: のキーも受ける（形の違うキーは拒む）', () => {
    expect(stockCountsSchema.safeParse({ [DESK]: 1, [`c:${TRASH.id}`]: 2 }).success).toBe(true);
    expect(stockCountsSchema.safeParse({ 'c:x': 2 }).success).toBe(false);
    expect(stockCountsSchema.safeParse({ [`d:${TRASH.id}`]: 2 }).success).toBe(false);
    expect(stockDraftSchema.safeParse({ counts: { [`c:${TRASH.id}`]: 0 }, base: { [`c:${TRASH.id}`]: 'u' } }).success).toBe(true);
  });
});

describe('出す行と足す選択肢', () => {
  it('最初から出す物は並び順で全部、「その他」は行がある物と足した物だけ（並び → 名前 → id）', () => {
    const rows = mergeRoomRows([], [countRow(WHITE, 1)]);
    const shown = shownCountItems(ITEMS, [rows, null], [VACUUM.id, 'unknown']);
    expect(shown.always.map((c) => c.name)).toEqual(['ゴミ箱', '延長コード']);
    expect(shown.others.map((c) => c.name)).toEqual(['白椅子', '掃除機']);
    // 行も足した物もなければ「その他」は空
    expect(shownCountItems(ITEMS, [], []).others).toEqual([]);
  });

  it('選択肢は最初から出す物ともう出ている物を除き、名前で絞る（全角・半角と大文字小文字を無視した部分一致）', () => {
    expect(addableCountItems(ITEMS, new Set([WHITE.id]), '').map((c) => c.name)).toEqual(['掃除機', 'LANケーブル']);
    expect(addableCountItems(ITEMS, new Set(), 'ｌａｎ').map((c) => c.name)).toEqual(['LANケーブル']);
    expect(addableCountItems(ITEMS, new Set(), 'ゴミ')).toEqual([]);
  });

  it('同じ名前は NFKC・前後の空白・大文字小文字を無視して探す', () => {
    expect(findCountItemByName(ITEMS, ' ｌａｎケーブル ')?.id).toBe(LAN.id);
    expect(findCountItemByName(ITEMS, 'ｺﾞﾐ箱')?.id).toBe(TRASH.id);
    expect(findCountItemByName(ITEMS, '台形机')).toBeNull();
  });
});

describe('保存（在庫の後に数）', () => {
  it('数の upsert の行は出ている行を全部（入力にない物は 0）', () => {
    expect(toCountUpsertRows(Y, R1, [TRASH.id, WHITE.id], { [`c:${TRASH.id}`]: 2 })).toEqual([
      { year_id: Y, room_id: R1, count_item_id: TRASH.id, count: 2 },
      { year_id: Y, room_id: R1, count_item_id: WHITE.id, count: 0 },
    ]);
  });

  it('在庫が通れば数を onConflict の3つの鍵で upsert し、まとめた行を返す', async () => {
    const { client, issued } = createFakeSupabase((call) => {
      if (call.table === 'stocks') return { data: [stockRow(3)] };
      return { data: [countRow(TRASH, 2)] };
    });
    const rows = await saveRoomLines(Y, R1, [{ id: DESK }], [TRASH.id], { [DESK]: 3, [`c:${TRASH.id}`]: 2 }, client);
    expect(rows.map((r) => r.item_id)).toEqual([DESK, `c:${TRASH.id}`]);
    const up = issued.find((c) => c.table === 'count_stocks')!;
    expect(opArgs(up, 'upsert')[0]).toEqual([[{ year_id: Y, room_id: R1, count_item_id: TRASH.id, count: 2 }], { onConflict: 'year_id,room_id,count_item_id' }]);
  });

  it('在庫が失敗すれば数は送らない。数だけ失敗すれば CountSaveError（保存した在庫の行と原因）', async () => {
    const stockFail = createFakeSupabase(() => ({ error: { code: '42501', message: 'denied' }, status: 403 }));
    await expect(saveRoomLines(Y, R1, [{ id: DESK }], [TRASH.id], {}, stockFail.client)).rejects.toMatchObject({ info: { kind: 'forbidden' } });
    expect(stockFail.issued.filter((c) => c.table === 'count_stocks')).toHaveLength(0);

    const countFail = createFakeSupabase((call) =>
      call.table === 'stocks' ? { data: [stockRow(3)] } : { error: { code: '42501', message: 'denied' }, status: 403 },
    );
    const e = await saveRoomLines(Y, R1, [{ id: DESK }], [TRASH.id], {}, countFail.client).catch((x: unknown) => x);
    expect(e).toBeInstanceOf(CountSaveError);
    expect((e as CountSaveError).stocks).toEqual([stockRow(3)]);
    expect(classifyError((e as CountSaveError).cause).kind).toBe('forbidden');
  });

  it('出ている数の行がなければ数は送らない', async () => {
    const { client, issued } = createFakeSupabase(() => ({ data: [stockRow(3)] }));
    await expect(saveRoomLines(Y, R1, [{ id: DESK }], [], {}, client)).resolves.toEqual([stockRow(3)]);
    expect(issued.filter((c) => c.table === 'count_stocks')).toHaveLength(0);
  });

  it('保存の前の読み直しは、部屋の在庫と数を両方読んでまとめる', async () => {
    const { client, issued } = createFakeSupabase((call) => (call.table === 'stocks' ? { data: [stockRow(3)] } : { data: [countRow(TRASH, 1)] }));
    expect((await fetchRoomLines(Y, R1, client)).map((r) => r.item_id)).toEqual([DESK, `c:${TRASH.id}`]);
    const cs = issued.find((c) => c.table === 'count_stocks')!;
    expect(opArgs(cs, 'eq')).toEqual([
      ['year_id', Y],
      ['room_id', R1],
    ]);
  });
});

describe('RPC（add_count_item・previous_year_count_stocks）', () => {
  it('名前は前後の空白を除いて送る。空・51 字以上は送る前に止める（field: name）', async () => {
    const { client, issued } = createFakeSupabase(() => ({ data: TRASH.id }));
    await expect(addCountItem(Y, '  ゴミ箱 ', client)).resolves.toBe(TRASH.id);
    expect(opArgs(issued[0]!, 'rpc')[0]).toEqual([{ p_year_id: Y, p_name: 'ゴミ箱' }]);
    await expect(addCountItem(Y, '   ', client)).rejects.toMatchObject({ info: { kind: 'input', details: { field: 'name' } } });
    expect(RPC_ARGS.add_count_item.safeParse({ p_year_id: Y, p_name: 'あ'.repeat(50) }).success).toBe(true);
    expect(RPC_ARGS.add_count_item.safeParse({ p_year_id: Y, p_name: 'あ'.repeat(51) }).success).toBe(false);
    expect(RPC_ARGS.previous_year_count_stocks.safeParse({ p_year_id: 'x' }).success).toBe(false);
  });

  it('前年の数は range で分けて読み、在庫の前年と同じ引き方（部屋:行のキー）にまとめる', async () => {
    const { client, issued } = createFakeSupabase(() => ({ data: [{ room_id: R1, count_item_id: TRASH.id, count: 5 }] }));
    const prev = await fetchPreviousYearCountStocks(Y, client);
    expect(issued[0]!.table).toBe('rpc:previous_year_count_stocks');
    const m = previousLineMap([{ room_id: R1, item_id: DESK, count: 8 }], prev);
    expect(m.get(`${R1}:${DESK}`)).toBe(8);
    expect(m.get(`${R1}:c:${TRASH.id}`)).toBe(5);
    await expect(fetchPreviousYearCountStocks('x', client)).rejects.toMatchObject({ info: { kind: 'input' } });
  });
});

describe('在庫一覧の「備品（数えるだけ）」の表', () => {
  it('列は最初から出す物と今年か前年に数がある物。数の行がなければ 0、前年との差は前年度があるときだけ', () => {
    const storage = storageRooms([room(1), room(2)], [{ year_id: Y, room_id: R2, usable: false, note: '工事', updated_at: 't' }]);
    const m = buildCountMatrix({
      storage,
      countItems: ITEMS,
      counts: [countRow(TRASH, 3), countRow(WHITE, 2, R2)],
      prev: [{ room_id: R1, count_item_id: VACUUM.id, count: 1 }],
    });
    expect(m.items.map((c) => c.name)).toEqual(['ゴミ箱', '延長コード', '白椅子', '掃除機']);
    const [a, b] = m.rows;
    expect(formatCell(a!.cells[TRASH.id]!, a!.counted)).toBe('3（+3）');
    expect(formatCell(a!.cells[CORD.id]!, a!.counted)).toBe('0（±0）');
    expect(formatCell(a!.cells[VACUUM.id]!, a!.counted)).toBe('0（−1）');
    expect(formatCell(b!.cells[WHITE.id]!, b!.counted)).toBe('2（+2）');
    // 合計：使用不可（倉庫2）を除くと白椅子は 0、全部なら 2
    expect(m.usableTotals.cells[WHITE.id]!.count).toBe(0);
    expect(m.allTotals.cells[WHITE.id]!.count).toBe(2);
    expect(m.allTotals.total.count).toBe(5);

    const noPrev = buildCountMatrix({ storage, countItems: ITEMS, counts: [], prev: null });
    expect(noPrev.items.map((c) => c.name)).toEqual(['ゴミ箱', '延長コード']);
    expect(formatCell(noPrev.rows[0]!.cells[TRASH.id]!, noPrev.rows[0]!.counted)).toBe('0');
    expect(noPrev.hasPrev).toBe(false);
  });
});

describe('マスタ設定の入力と文言', () => {
  it('名前は前後の空白を除いて 1〜50 字、並びは整数', () => {
    expect(countItemFormSchema.safeParse({ name: ' 白椅子 ', always_shown: false, sort_order: '3' }).data).toEqual({
      name: '白椅子',
      always_shown: false,
      sort_order: 3,
    });
    expect(countItemFormSchema.safeParse({ name: '', always_shown: false, sort_order: '3' }).success).toBe(false);
    expect(countItemFormSchema.safeParse({ name: 'x'.repeat(51), always_shown: false, sort_order: '3' }).success).toBe(false);
    expect(countItemFormSchema.safeParse({ name: 'x', always_shown: true, sort_order: '1.5' }).success).toBe(false);
  });

  it('23505 は同じ名前、23503 は数の入った物、add_count_item の invalid_input（name）は名前の文言', () => {
    const ctx = { table: 'count_items' };
    expect(messageFor(classifyError(toAppError({ code: '23505', message: 'dup' }, 409)), ctx)).toBe(COUNT_ITEM_DUPLICATE_MESSAGE);
    expect(messageFor(classifyError(toAppError({ code: '23503', message: 'fk' }, 409)), ctx)).toBe(COUNT_ITEM_IN_USE_MESSAGE);
    expect(messageFor(classifyError(toAppError({ code: '23514', message: 'check' }, 400)), ctx)).toBe(COUNT_ITEM_NAME_MESSAGE);
    const invalid = toAppError({ code: 'P0001', message: 'invalid_input', details: '{"field":"name"}', hint: null }, 400);
    expect(messageFor(classifyError(invalid), { rpc: 'add_count_item' })).toBe(COUNT_ITEM_NAME_MESSAGE);
    // ほかの表の 23503 は今の文言のまま
    expect(messageFor(classifyError(toAppError({ code: '23503', message: 'fk' }, 409)))).toBe('ほかのデータから使われているので削除できません');
  });
});
