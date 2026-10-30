import { describe, expect, it } from 'vitest';
import { parseCategoryParam, parseFilterParam, parseGroupParam, requestFormSchema } from './requests';

const ID = '11111111-1111-4111-8111-111111111111';

describe('申請のクエリ（合わない値は無視して既定にする）', () => {
  it('group は uuid だけ', () => {
    expect(parseGroupParam(ID)).toBe(ID);
    expect(parseGroupParam('abc')).toBeNull();
    expect(parseGroupParam(null)).toBeNull();
  });
  it('category は区分だけ、filter は unsubmitted・noted だけ', () => {
    expect(parseCategoryParam('rest_area')).toBe('rest_area');
    expect(parseCategoryParam('food')).toBeNull();
    expect(parseFilterParam('noted')).toBe('noted');
    expect(parseFilterParam('all')).toBeNull();
    expect(parseFilterParam(undefined)).toBeNull();
  });
});

describe('requestFormSchema', () => {
  it('数は 0〜10000 の整数、備考は前後の空白を除き空なら null、2000 字まで', () => {
    expect(requestFormSchema.parse({ counts: { [ID]: 0 }, note: '  ' })).toEqual({ counts: { [ID]: 0 }, note: null });
    expect(requestFormSchema.parse({ counts: { [ID]: 10000 }, note: ' 電源 ' }).note).toBe('電源');
    expect(requestFormSchema.safeParse({ counts: { [ID]: 10001 }, note: null }).success).toBe(false);
    expect(requestFormSchema.safeParse({ counts: { [ID]: -1 }, note: null }).success).toBe(false);
    expect(requestFormSchema.safeParse({ counts: { [ID]: 1.5 }, note: null }).success).toBe(false);
    expect(requestFormSchema.safeParse({ counts: { x: 1 }, note: null }).success).toBe(false);
    expect(requestFormSchema.safeParse({ counts: {}, note: 'あ'.repeat(2001) }).success).toBe(false);
  });
});
