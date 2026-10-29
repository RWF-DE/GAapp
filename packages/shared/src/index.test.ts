import { describe, expect, it } from 'vitest';
import { Constants, PACKAGE_NAME } from './index';
import type { Database, Enums, Tables } from './index';

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

  it('RPC は 04_screens_api.md の DB 関数の表の 17 個（型のテスト）', () => {
    type Rpc = keyof Database['public']['Functions'];
    const rpcs = [
      'set_year_status',
      'update_year',
      'create_year_from',
      'invite',
      'set_role',
      'remove_role',
      'revoke_invitation',
      'remove_group_member',
      'accept_my_invitations',
      'save_auto_allocations',
      'save_allocation_rows',
      'set_consent',
      'submit_requests',
      'update_requests_after_deadline',
      'check_delivery',
      'previous_year_stocks',
      'previous_year_requests',
    ] as const satisfies readonly Rpc[];
    // 表にない RPC が DB にあれば、ここで型エラーになる
    const missing: Exclude<Rpc, (typeof rpcs)[number]>[] = [];
    expect(missing).toEqual([]);
    expect(new Set(rpcs).size).toBe(17);
    const args: Database['public']['Functions']['save_auto_allocations']['Args'] = {
      p_year_id: '00000000-0000-0000-0000-000000000000',
      p_rows: [],
      p_mode: 'full',
      p_base_version: 0,
    };
    expect(args.p_mode).toBe('full');
    // ロールを外すのは remove_role（set_role の role は必須で null を書けない）
    const removeArgs: Database['public']['Functions']['remove_role']['Args'] = {
      p_year_id: '00000000-0000-0000-0000-000000000000',
      p_user_id: '00000000-0000-0000-0000-000000000000',
    };
    expect(Object.keys(removeArgs)).toEqual(['p_year_id', 'p_user_id']);
  });
});
