import { describe, expect, it } from 'vitest';
import {
  aliasesSchema,
  emailSchema,
  festivalStartSchema,
  isoDateTimeSchema,
  optionalReasonSchema,
  optionalText,
  reasonSchema,
  requiredText,
  yearLabelSchema,
} from './common';

describe('optionalText', () => {
  const s = optionalText(5);
  it('空・空白だけ・null・undefined は null', () => {
    for (const v of ['', '   ', '\t\n', null, undefined]) expect(s.parse(v)).toBeNull();
  });
  it('前後の空白を除く', () => {
    expect(s.parse('  1号棟 ')).toBe('1号棟');
  });
  it('上限は除いた後の長さで見る', () => {
    expect(s.parse('  abcde  ')).toBe('abcde');
    const r = s.safeParse('abcdef');
    expect(r.success).toBe(false);
    expect(r.error?.issues[0]?.message).toBe('5 字までです');
  });
  it('optionalReasonSchema は 500 字まで', () => {
    expect(optionalReasonSchema.parse(' ')).toBeNull();
    expect(optionalReasonSchema.safeParse('a'.repeat(501)).success).toBe(false);
  });
});

describe('必須の文字列', () => {
  it('requiredText は前後の空白を除いて1字以上', () => {
    expect(requiredText(10).parse(' 1-1 ')).toBe('1-1');
    expect(requiredText(10).safeParse('  ').error?.issues[0]?.message).toBe('入力してください');
  });
  it('年度名は 50 字まで', () => {
    expect(yearLabelSchema.parse('R9')).toBe('R9');
    expect(yearLabelSchema.safeParse('a'.repeat(51)).success).toBe(false);
  });
  it('理由は 1〜500 字', () => {
    expect(reasonSchema.safeParse(' ').error?.issues[0]?.message).toBe('理由を入力してください');
    expect(reasonSchema.safeParse('a'.repeat(500)).success).toBe(true);
    expect(reasonSchema.safeParse('a'.repeat(501)).error?.issues[0]?.message).toBe('理由は 500 字までです');
  });
});

describe('1日目', () => {
  it('2000-01-01〜2200-12-31（DB の years_festival_start_check と同じ）', () => {
    expect(festivalStartSchema.safeParse('2000-01-01').success).toBe(true);
    expect(festivalStartSchema.safeParse('2200-12-31').success).toBe(true);
    expect(festivalStartSchema.safeParse('1999-12-31').success).toBe(false);
    expect(festivalStartSchema.safeParse('2201-01-01').success).toBe(false);
  });
  it('日付の形でなければ失敗', () => {
    expect(festivalStartSchema.safeParse('2026/10/17').success).toBe(false);
    expect(festivalStartSchema.safeParse('infinity').success).toBe(false);
  });
});

describe('メールアドレス', () => {
  it('前後の空白を除いて小文字にする', () => {
    expect(emailSchema.parse('  Someone@Example.TEST ')).toBe('someone@example.test');
  });
  it('形が違う・254 字を超えると失敗', () => {
    expect(emailSchema.safeParse('no-at-mark').success).toBe(false);
    expect(emailSchema.safeParse('a b@example.test').success).toBe(false);
    expect(emailSchema.safeParse(`${'a'.repeat(250)}@example.test`).success).toBe(false);
  });
});

describe('日時と別名', () => {
  it('オフセットつきの ISO だけ', () => {
    expect(isoDateTimeSchema.safeParse('2026-10-05T18:01:00+09:00').success).toBe(true);
    expect(isoDateTimeSchema.safeParse('2026-10-05T18:01:00').success).toBe(false);
  });
  it('別名は空を捨て、20 個・1000 字まで', () => {
    expect(aliasesSchema.parse([' 机 ', '', '  '])).toEqual(['机']);
    expect(aliasesSchema.safeParse(Array.from({ length: 21 }, (_, i) => `a${i}`)).success).toBe(false);
    expect(aliasesSchema.safeParse(['a'.repeat(1001)]).success).toBe(false);
  });
});
