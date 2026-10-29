import { describe, expect, it } from 'vitest';
import { clearSelectedYear, readSelectedYear, selectedYearKey, writeSelectedYear, type YearStorage } from './selected-year';

const memory = (): YearStorage & { map: Map<string, string> } => {
  const map = new Map<string, string>();
  return {
    map,
    getItem: (k) => map.get(k) ?? null,
    setItem: (k, v) => void map.set(k, v),
    removeItem: (k) => void map.delete(k),
  };
};
const broken: YearStorage = {
  getItem: () => {
    throw new Error('SecurityError');
  },
  setItem: () => {
    throw new Error('QuotaExceededError');
  },
  removeItem: () => {
    throw new Error('SecurityError');
  },
};

describe('選んだ年度の保存（sessionStorage）', () => {
  it('キーは gaapp:year:<user_id>', () => {
    expect(selectedYearKey('u1')).toBe('gaapp:year:u1');
  });
  it('書いて読み、消す（利用者ごと）', () => {
    const s = memory();
    writeSelectedYear('u1', 'y8', s);
    expect(readSelectedYear('u1', s)).toBe('y8');
    expect(readSelectedYear('u2', s)).toBeNull();
    clearSelectedYear('u1', s);
    expect(s.map.size).toBe(0);
  });
  it('ストレージが使えなくても例外にしない（既定の年度で動く）', () => {
    expect(() => writeSelectedYear('u1', 'y8', broken)).not.toThrow();
    expect(readSelectedYear('u1', broken)).toBeNull();
    expect(() => clearSelectedYear('u1', broken)).not.toThrow();
    expect(readSelectedYear('u1', null)).toBeNull();
  });
});
