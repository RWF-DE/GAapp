import { describe, expect, it } from 'vitest';
import { AppError } from '@/lib/errors';
import { fetchAll } from './fetch-all';

describe('fetchAll', () => {
  it('pageSize ごとに range で読み、短いページで終わる', async () => {
    const all = Array.from({ length: 7 }, (_, i) => i);
    const ranges: [number, number][] = [];
    const rows = await fetchAll(async (from, to) => {
      ranges.push([from, to]);
      return { data: all.slice(from, to + 1), error: null };
    }, 3);
    expect(rows).toEqual(all);
    expect(ranges).toEqual([
      [0, 2],
      [3, 5],
      [6, 8],
    ]);
  });

  it('ちょうど割り切れるときは、空のページを読んで終わる', async () => {
    const all = [1, 2, 3, 4];
    let calls = 0;
    const rows = await fetchAll(async (from, to) => {
      calls += 1;
      return { data: all.slice(from, to + 1), error: null };
    }, 2);
    expect(rows).toEqual(all);
    expect(calls).toBe(3);
  });

  it('失敗したら AppError を投げる（status も渡す）', async () => {
    const p = fetchAll(async () => ({ data: null, error: { code: 'PGRST303', message: 'JWT expired' }, status: 401 }));
    await expect(p).rejects.toBeInstanceOf(AppError);
    await expect(p).rejects.toMatchObject({ info: { kind: 'auth', status: 401 } });
  });
});
