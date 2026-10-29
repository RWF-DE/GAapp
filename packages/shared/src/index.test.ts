import { readFileSync } from 'node:fs';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import { Constants, HIGHS_VERSION, INITIAL_ITEMS, ITEM_CODES, PACKAGE_NAME } from './index';
import type { Database, Enums, Tables } from './index';
import { repoRoot } from './testing';

describe('@gaapp/shared', () => {
  it('読み込める', () => {
    expect(PACKAGE_NAME).toBe('@gaapp/shared');
  });

  it('INITIAL_ITEMS は 01 の品目表の9件と並び', () => {
    expect(INITIAL_ITEMS.map((i) => i.code)).toEqual([...ITEM_CODES]);
    expect(INITIAL_ITEMS.map((i) => i.sortOrder)).toEqual([1, 2, 3, 4, 5, 6, 7, 8, 9]);
    expect(INITIAL_ITEMS.filter((i) => i.requestableCategories.length === 0).map((i) => i.code)).toEqual(['desk_ng', 'chair_ng']);
    expect(INITIAL_ITEMS.find((i) => i.code === 'long_desk_3')!.requestableCategories).toEqual(['company']);
  });

  it('HIGHS_VERSION が highs を使う package.json の版と一致する', () => {
    const files = ['package.json', 'packages/allocator/package.json', 'apps/web/package.json'];
    let found = 0;
    for (const f of files) {
      const j = JSON.parse(readFileSync(path.join(repoRoot(), f), 'utf8')) as Record<string, Record<string, string> | undefined>;
      for (const k of ['dependencies', 'devDependencies'] as const) {
        const v = j[k]?.highs;
        if (v !== undefined) {
          expect(v, `${f} ${k}`).toBe(HIGHS_VERSION);
          found++;
        }
      }
    }
    expect(found).toBeGreaterThanOrEqual(2);
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
