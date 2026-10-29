import { describe, expect, it } from 'vitest';
import { parseRoomParam, parseRoomsParam, stockCountSchema, stockCountsSchema, stockDraftSchema } from './stock';

const A = '22222222-2222-4222-8222-222222222222';
const B = '33333333-3333-4333-8333-333333333333';

describe('在庫の数', () => {
  it('0〜10000 の整数（stocks.count の CHECK）', () => {
    expect(stockCountSchema.safeParse(0).success).toBe(true);
    expect(stockCountSchema.safeParse(10000).success).toBe(true);
    expect(stockCountSchema.safeParse(-1).success).toBe(false);
    expect(stockCountSchema.safeParse(10001).success).toBe(false);
    expect(stockCountSchema.safeParse(1.5).success).toBe(false);
  });

  it('品目の id → 数。id の形が違えば落とす。下書きも同じ形でなければ捨てる', () => {
    expect(stockCountsSchema.safeParse({ [A]: 3 }).success).toBe(true);
    expect(stockCountsSchema.safeParse({ x: 3 }).success).toBe(false);
    expect(stockDraftSchema.safeParse({ counts: { [A]: 3 } }).success).toBe(true);
    expect(stockDraftSchema.safeParse({ counts: { [A]: -3 } }).success).toBe(false);
    expect(stockDraftSchema.safeParse('壊れた値').success).toBe(false);
  });
});

describe('クエリ', () => {
  it('room：uuid でなければ null（前後の空白と大文字は許す）', () => {
    expect(parseRoomParam(A)).toBe(A);
    expect(parseRoomParam(` ${A.toUpperCase()} `)).toBe(A);
    expect(parseRoomParam('1-1')).toBeNull();
    expect(parseRoomParam('')).toBeNull();
    expect(parseRoomParam(null)).toBeNull();
  });

  it('rooms：uuid の形のものだけを重複なく先の順で。1つもなければ null（既定の全部）', () => {
    expect(parseRoomsParam(`${B},${A},x,${B}`)).toEqual([B, A]);
    expect(parseRoomsParam('x,y')).toBeNull();
    expect(parseRoomsParam(null)).toBeNull();
  });
});
