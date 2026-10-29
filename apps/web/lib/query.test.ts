import { describe, expect, it } from 'vitest';
import { createQueryClient, queryKeys, shouldRetry, STALE_TIME_MS } from './query';

describe('query', () => {
  it('再試行は通信の失敗だけ1回', () => {
    const network = { code: '', message: 'TypeError: Failed to fetch' };
    expect(shouldRetry(0, network)).toBe(true);
    expect(shouldRetry(1, network)).toBe(false);
    expect(shouldRetry(0, new TypeError('fetch failed'))).toBe(true);
    expect(shouldRetry(0, { code: 'P0001', message: 'forbidden' })).toBe(false);
    expect(shouldRetry(0, { code: '42501', message: 'denied' })).toBe(false);
  });

  it('既定値：30 秒・フォーカスで読み直さない・書き込みは再送しない', () => {
    const qc = createQueryClient();
    const d = qc.getDefaultOptions();
    expect(d.queries?.staleTime).toBe(STALE_TIME_MS);
    expect(d.queries?.refetchOnWindowFocus).toBe(false);
    expect(d.mutations?.retry).toBe(false);
  });

  it('年度の表のキーは年度の下にある', () => {
    const y = 'y1';
    for (const k of [queryKeys.yearRow(y), queryKeys.yearVersion(y), queryKeys.snapshot(y, 'full'), queryKeys.yearPart(y, 'stocks', 'r1')]) {
      expect(k.slice(0, 2)).toEqual(queryKeys.year(y));
    }
    expect(queryKeys.rooms()).toEqual(['rooms']);
  });
});
