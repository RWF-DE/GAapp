import { afterEach, describe, expect, it } from 'vitest';
import {
  addDays,
  formatDate,
  formatDateTime,
  formatDateTimeSeconds,
  formatShortDateTime,
  formatTime,
  fromDateTimeLocal,
  toDateTimeLocal,
  tokyoStartOfDay,
  tokyoStartOfNextDay,
  tokyoDate,
  tokyoToday,
} from './datetime';

const TZ = process.env.TZ;
afterEach(() => {
  process.env.TZ = TZ;
});

describe('表示（Asia/Tokyo）', () => {
  it('UTC の値を Asia/Tokyo で出す', () => {
    expect(formatDateTime('2026-10-05T09:01:09.123456+00:00')).toBe('2026/10/05 18:01');
    expect(formatDateTimeSeconds('2026-10-05T09:01:09Z')).toBe('2026/10/05 18:01:09');
    expect(formatShortDateTime('2026-10-05T09:01:00Z')).toBe('10/5 18:01');
    expect(formatTime('2026-10-05T09:01:00Z')).toBe('18:01');
  });

  it('端末のタイムゾーンによらない', () => {
    for (const tz of ['UTC', 'America/Los_Angeles', 'Asia/Tokyo']) {
      process.env.TZ = tz;
      expect(formatDateTime('2026-10-05T18:01:00+09:00')).toBe('2026/10/05 18:01');
      expect(toDateTimeLocal('2026-10-05T18:01:00+09:00')).toBe('2026-10-05T18:01');
    }
  });

  it('日付の境目：UTC で前の日でも Asia/Tokyo では次の日', () => {
    expect(formatDateTime('2026-10-04T15:00:00Z')).toBe('2026/10/05 00:00');
    expect(formatDateTime('2026-10-04T14:59:59Z')).toBe('2026/10/04 23:59');
    expect(formatDateTime('2026-12-31T15:30:00Z')).toBe('2027/01/01 00:30');
    expect(tokyoToday(new Date('2026-10-04T15:00:00Z'))).toBe('2026-10-05');
  });

  it('tokyoDate：日時の Asia/Tokyo の日付（YYYY-MM-DD はそのまま。読めなければ空文字）', () => {
    expect(tokyoDate(new Date('2026-10-04T15:00:00Z'))).toBe('2026-10-05');
    expect(tokyoDate('2026-10-04T14:59:59Z')).toBe('2026-10-04');
    expect(tokyoDate('2026-10-17')).toBe('2026-10-17');
    expect(tokyoDate('oops')).toBe('');
    expect(tokyoDate(new Date('oops'))).toBe('');
  });

  it('読めない値・null は空文字', () => {
    expect(formatDateTime(null)).toBe('');
    expect(formatDateTime('oops')).toBe('');
    expect(formatDate('2026-10-17')).toBe('2026/10/17');
    expect(formatDate('x')).toBe('');
  });
});

describe('入力（datetime-local）', () => {
  it('Asia/Tokyo とみなして +09:00 をつける', () => {
    expect(fromDateTimeLocal('2026-10-05T18:01')).toBe('2026-10-05T18:01:00+09:00');
    expect(fromDateTimeLocal('2026-10-05T18:01:30')).toBe('2026-10-05T18:01:30+09:00');
    expect(fromDateTimeLocal('')).toBeNull();
    expect(fromDateTimeLocal('2026-13-45T99:99')).toBeNull();
  });

  it('表示に戻すと同じ値になる', () => {
    const v = '2026-10-31T00:00';
    expect(toDateTimeLocal(fromDateTimeLocal(v))).toBe(v);
  });
});

describe('期間の絞り込み', () => {
  it('Asia/Tokyo の 0 時と次の日の 0 時', () => {
    expect(tokyoStartOfDay('2026-10-05')).toBe('2026-10-05T00:00:00+09:00');
    expect(tokyoStartOfNextDay('2026-10-31')).toBe('2026-11-01T00:00:00+09:00');
    expect(tokyoStartOfNextDay('2026-12-31')).toBe('2027-01-01T00:00:00+09:00');
    expect(() => tokyoStartOfDay('2026/10/05')).toThrow();
  });
});

describe('T16 addDays（日付の足し引き）', () => {
  it('月・年の境目と閏年', () => {
    expect(addDays('2026-10-17', -2)).toBe('2026-10-15');
    expect(addDays('2026-10-17', 1)).toBe('2026-10-18');
    expect(addDays('2027-03-01', -2)).toBe('2027-02-27');
    expect(addDays('2028-03-01', -1)).toBe('2028-02-29');
    expect(addDays('2027-01-01', -2)).toBe('2026-12-30');
    expect(addDays('2026-12-31', 1)).toBe('2027-01-01');
    expect(addDays('2026-10-17', 0)).toBe('2026-10-17');
  });

  it('端末のタイムゾーンによらない', () => {
    for (const tz of ['UTC', 'America/Los_Angeles', 'Asia/Tokyo', 'Pacific/Kiritimati']) {
      process.env.TZ = tz;
      expect(addDays('2027-01-01', -1)).toBe('2026-12-31');
    }
  });

  it('読めない日付・整数でない日数は空文字', () => {
    expect(addDays('', 1)).toBe('');
    expect(addDays('2026/10/17', 1)).toBe('');
    expect(addDays('2026-02-30', 1)).toBe('');
    expect(addDays('2026-10-17T00:00:00Z', 1)).toBe('');
    expect(addDays('2026-10-17', 0.5)).toBe('');
  });
});
