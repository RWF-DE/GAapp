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
      // head・deputy_head は T15 の 0011 で admin の後に足した（D-48）
      app_role: ['admin', 'head', 'deputy_head', 'staff', 'viewer'],
      consent_status: ['not_asked', 'asked', 'accepted', 'declined'],
      delivery_kind: ['furniture', 'tent', 'weight', 'side_curtain'],
      delivery_status: ['pending', 'done', 'problem'],
      festival_day: ['day_minus2', 'day_minus1', 'day1', 'day2'],
      group_category: ['stall', 'department', 'company', 'rest_area'],
      // 店長・副店長（T15 の 0012）
      group_role: ['manager', 'deputy_manager'],
      // お知らせの宛先：総務内・全団体・指定の団体（T17 の 0014。D-53）
      notice_audience: ['soumu', 'all_groups', 'groups'],
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

  it('RPC は 04_screens_api.md の DB 関数の表の 20 個（型のテスト）', () => {
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
      'set_group_member_role',
      'accept_my_invitations',
      'save_auto_allocations',
      'save_allocation_rows',
      'set_consent',
      'submit_requests',
      'update_requests_after_deadline',
      'check_delivery',
      'previous_year_stocks',
      'previous_year_requests',
      // お知らせ（T17）
      'save_notice',
      'delete_notice',
    ] as const satisfies readonly Rpc[];
    // 表にない RPC が DB にあれば、ここで型エラーになる（Exclude が never でなければ型が false になり、true を入れられない）
    type Missing = Exclude<Rpc, (typeof rpcs)[number]>;
    const noneMissing: [Missing] extends [never] ? true : false = true;
    expect(noneMissing).toBe(true);
    expect(new Set(rpcs).size).toBe(20);
    // invite は T15 で p_group_role（省略可）を足した5引数の版だけ。今の画面の呼び方（ロールか団体のどちらか）も型が通る
    const inviteRole: Database['public']['Functions']['invite']['Args'] = {
      p_year_id: '00000000-0000-0000-0000-000000000000',
      p_email: 'someone@example.test',
      p_role: 'staff',
    };
    const inviteGroup: Database['public']['Functions']['invite']['Args'] = {
      p_year_id: '00000000-0000-0000-0000-000000000000',
      p_email: 'someone@example.test',
      p_group_id: '00000000-0000-0000-0000-000000000000',
      p_group_role: 'deputy_manager',
    };
    expect([inviteRole.p_role, inviteGroup.p_group_role]).toEqual(['staff', 'deputy_manager']);
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

  it('お知らせの RPC と表を画面から呼ぶ形で使える（T17。型のテスト）', () => {
    type Fns = Database['public']['Functions'];
    const Y = '00000000-0000-0000-0000-000000000001';
    const G = '00000000-0000-0000-0000-000000000002';
    const N = '00000000-0000-0000-0000-000000000003';
    // 作る：要るのは年度・宛先・題名だけ（本文・ピン留め・宛先の団体・お知らせ・版は省ける）
    const create: Fns['save_notice']['Args'] = { p_year_id: Y, p_audience: 'soumu', p_title: '題名' };
    // 直す：全部の欄を送り、読んだときの updated_at の文字列をそのまま版にする
    const edit: Fns['save_notice']['Args'] = {
      p_year_id: Y,
      p_audience: 'groups',
      p_title: '題名',
      p_body: '本文',
      p_pinned: false,
      p_group_ids: [G],
      p_notice_id: N,
      p_base_updated_at: '2026-10-31T12:34:56.789+00:00',
    };
    expect(Object.keys(create)).toEqual(['p_year_id', 'p_audience', 'p_title']);
    expect(edit.p_group_ids).toEqual([G]);
    // 返り値はお知らせの行（次の版の updated_at を持つ）。本文と書いた人・直した人は null になりうる
    const saved: Fns['save_notice']['Returns'] = {
      id: N,
      year_id: Y,
      audience: 'all_groups',
      title: '題名',
      body: null,
      pinned: true,
      created_by: null,
      updated_by: null,
      created_at: '2026-10-31T12:34:56.789+00:00',
      updated_at: '2026-10-31T12:34:56.789+00:00',
    };
    const row: Tables<'notices'> = saved;
    expect(row.updated_at).toBe(saved.updated_at);
    const del: Fns['delete_notice']['Args'] = { p_notice_id: N, p_base_updated_at: saved.updated_at };
    expect(Object.keys(del)).toEqual(['p_notice_id', 'p_base_updated_at']);
    const target: Pick<Tables<'notice_groups'>, 'notice_id' | 'group_id' | 'year_id'> = { notice_id: N, group_id: G, year_id: Y };
    const audiences: Enums<'notice_audience'>[] = ['soumu', 'all_groups', 'groups'];
    expect([target.group_id, audiences.length]).toEqual([G, 3]);
  });
});
