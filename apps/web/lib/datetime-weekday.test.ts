// 曜日つきの日付と暦の日付の差（lib/datetime-weekday.ts。04「締切と予定」の日付の出し方、notes/T18.md「後半（画面）の約束」2。T18）
import { afterEach, describe, expect, it } from 'vitest';
import { daysBetween, formatDayHeading, formatShortDateTimeWeekday, formatShortDateWeekday, weekdayOf } from './datetime-weekday';

const TZ = process.env.TZ;
afterEach(() => {
  process.env.TZ = TZ;
});

describe('T18 weekdayOf（曜日）', () => {
  it('暦の日付の曜日（範囲の端・閏日）', () => {
    expect(weekdayOf('2000-01-01')).toBe('土');
    expect(weekdayOf('2200-12-31')).toBe('水');
    expect(weekdayOf('2028-02-29')).toBe('火');
    expect(weekdayOf('2027-10-14')).toBe('木');
    expect(weekdayOf('2027-10-17')).toBe('日');
  });

  it('形が違う・ない日は空文字（2月30日・13月・時刻つき・0〜99 年）', () => {
    for (const v of ['', '2027-02-30', '2027-13-01', '2027-2-3', '2027-10-14T00:00:00Z', '0050-01-01', 'oops']) expect(weekdayOf(v), v).toBe('');
    expect(weekdayOf('2027-02-29')).toBe('');
  });
});

describe('T18 formatShortDateWeekday・formatDayHeading（日付と曜日）', () => {
  it('今年なら月日と曜日、違う年なら年も付ける。thisYear を渡さなければ年を付けない', () => {
    expect(formatShortDateWeekday('2027-10-16', 2027)).toBe('10/16（土）');
    expect(formatShortDateWeekday('2028-01-01', 2027)).toBe('2028/1/1（土）');
    expect(formatShortDateWeekday('2028-01-05')).toBe('1/5（水）');
    expect(formatDayHeading('2027-10-16', 2027)).toBe('10月16日（土）');
    expect(formatDayHeading('2028-01-05', 2027)).toBe('2028年1月5日（水）');
    expect(formatDayHeading('2027-12-31')).toBe('12月31日（金）');
  });

  it('形が違えば空文字', () => {
    expect(formatShortDateWeekday('2027-02-30', 2027)).toBe('');
    expect(formatShortDateWeekday('2027-10-16T00:00:00+09:00', 2027)).toBe('');
    expect(formatDayHeading('x')).toBe('');
  });
});

describe('T18 formatShortDateTimeWeekday（日時と曜日。Asia/Tokyo）', () => {
  it('UTC の値を Asia/Tokyo の日付・曜日・時刻で出す。年が違えば年も', () => {
    expect(formatShortDateTimeWeekday('2027-09-30T08:00:00Z', 2027)).toBe('9/30（木）17:00');
    expect(formatShortDateTimeWeekday('2028-01-05T00:00:00Z', 2027)).toBe('2028/1/5（水）09:00');
    expect(formatShortDateTimeWeekday(new Date('2027-10-14T04:00:00Z'), 2027)).toBe('10/14（木）13:00');
    expect(formatShortDateTimeWeekday('2027-10-14T13:00:00+09:00', 2027)).toBe('10/14（木）13:00');
  });

  it('日の境目：UTC の 14:59:59.999 は Asia/Tokyo の同じ日の 23:59、15:00 は次の日の 00:00（曜日も次の日）', () => {
    expect(formatShortDateTimeWeekday('2027-10-14T14:59:59.999Z', 2027)).toBe('10/14（木）23:59');
    expect(formatShortDateTimeWeekday('2027-10-14T15:00:00Z', 2027)).toBe('10/15（金）00:00');
    // 年の境目（UTC の 12/31 15:00 は Asia/Tokyo の 1/1）
    expect(formatShortDateTimeWeekday('2027-12-31T15:00:00Z', 2027)).toBe('2028/1/1（土）00:00');
  });

  it('読めない値・日付だけの値は空文字', () => {
    expect(formatShortDateTimeWeekday('oops', 2027)).toBe('');
    expect(formatShortDateTimeWeekday(new Date('oops'), 2027)).toBe('');
    expect(formatShortDateTimeWeekday('2027-10-14', 2027)).toBe('');
  });
});

describe('T18 daysBetween（暦の日付の差）', () => {
  it('to − from の日数。月・年・閏年をまたぐ、負、同じ日', () => {
    expect(daysBetween('2027-10-14', '2027-10-14')).toBe(0);
    expect(daysBetween('2027-10-14', '2027-10-16')).toBe(2);
    expect(daysBetween('2027-10-14', '2027-10-13')).toBe(-1);
    expect(daysBetween('2027-10-14', '2027-11-13')).toBe(30);
    expect(daysBetween('2027-10-14', '2028-01-01')).toBe(79);
    expect(daysBetween('2028-02-28', '2028-03-01')).toBe(2);
    expect(daysBetween('2027-02-28', '2027-03-01')).toBe(1);
    expect(daysBetween('2000-01-01', '2200-12-31')).toBe(73413);
  });

  it('形が違う・ない日は null', () => {
    expect(daysBetween('2027-10-14', '')).toBeNull();
    expect(daysBetween('2027-02-30', '2027-03-01')).toBeNull();
    expect(daysBetween('2027-10-14T00:00:00Z', '2027-10-15')).toBeNull();
  });
});

describe('T18 端末のタイムゾーンによらない（夏時間のある地域でも同じ）', () => {
  it.each(['UTC', 'America/Los_Angeles', 'Europe/London', 'Asia/Tokyo'])('TZ=%s', (tz) => {
    process.env.TZ = tz;
    expect(weekdayOf('2027-03-14')).toBe('日');
    expect(formatShortDateWeekday('2027-11-07', 2027)).toBe('11/7（日）');
    expect(formatShortDateTimeWeekday('2027-10-14T15:00:00Z', 2027)).toBe('10/15（金）00:00');
    // 夏時間の切り替わりの日（ロサンゼルスの 2027-03-14・2027-11-07）をまたいでも暦の差のまま
    expect(daysBetween('2027-03-13', '2027-03-15')).toBe(2);
    expect(daysBetween('2027-11-06', '2027-11-08')).toBe(2);
    expect(daysBetween('2027-03-27', '2027-03-29')).toBe(2);
  });
});
