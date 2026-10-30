import { describe, expect, it } from 'vitest';
import { Constants, PACKAGE_NAME } from './index';
import type { Enums, Tables } from './index';

describe('@gaapp/shared', () => {
  it('読み込める', () => {
    expect(PACKAGE_NAME).toBe('@gaapp/shared');
  });
});

describe('生成された型（database.types.ts）', () => {
  it('列挙型は 02_data.md の値と並び順が同じ', () => {
    expect(Constants.public.Enums).toEqual({
      alloc_origin: ['auto', 'manual'],
      app_role: ['admin', 'staff', 'viewer'],
      consent_status: ['not_asked', 'asked', 'accepted', 'declined'],
      delivery_kind: ['furniture', 'tent', 'weight', 'side_curtain'],
      delivery_status: ['pending', 'done', 'problem'],
      festival_day: ['day_minus2', 'day_minus1', 'day1', 'day2'],
      group_category: ['stall', 'department', 'company', 'rest_area'],
      room_kind: ['room', 'gym', 'outdoor', 'other'],
      rule_kind: ['substitute', 'source_restrict', 'fixed_request', 'keep'],
      year_status: ['preparing', 'requesting', 'allocating', 'confirmed', 'closed'],
    });
  });

  it('行の型が使える（型のテスト。コンパイルが通ればよい）', () => {
    const status: Enums<'year_status'> = 'allocating';
    const year: Pick<Tables<'years'>, 'status' | 'allocation_version'> = { status, allocation_version: 0 };
    expect(year.status).toBe('allocating');
  });
});
