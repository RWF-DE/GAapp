import { describe, expect, it } from 'vitest';
import { isStale } from './version-watch';

describe('isStale', () => {
  it('読んだ版が持っている版より新しいときだけ', () => {
    expect(isStale(8, 7)).toBe(true);
    expect(isStale(7, 7)).toBe(false);
    expect(isStale(6, 7)).toBe(false);
    expect(isStale(undefined, 7)).toBe(false);
    expect(isStale(8, null)).toBe(false);
  });
});
