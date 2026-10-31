import { describe, expect, it } from 'vitest';
import { AppError } from '@/lib/errors';
import { createFakeSupabase, opArgs } from '@/lib/testing/fake-supabase';
import { furnitureRepOptions, loadRepHome } from './rep';

const Y = '11111111-1111-4111-8111-111111111111';

describe('T16 furnitureRepOptions（団体代表の机椅子のクエリ）', () => {
  it("キーは ['year', yearId, 'portal', 'furniture', 'rep', ...groupIds]（代表する団体の欄と要対応が同じキャッシュを読む）", () => {
    expect(furnitureRepOptions(Y, ['g1', 'g2']).queryKey).toEqual(['year', Y, 'portal', 'furniture', 'rep', 'g1', 'g2']);
    // 代表する団体が変われば別のキャッシュ
    expect(furnitureRepOptions(Y, ['g1']).queryKey).not.toEqual(furnitureRepOptions(Y, ['g1', 'g2']).queryKey);
  });
});

describe('T16 loadRepHome（団体代表の読み取り）', () => {
  it('自団体の提出と了承だけを読む（版・在庫・振り分けの行・ルールは読まない）。団体がなければ何も読まない', async () => {
    const { client, issued } = createFakeSupabase((call) =>
      call.table === 'request_submissions'
        ? { data: [{ group_id: 'g1', submitted_at: '2026-10-01T00:00:00Z', note: null, updated_at: 't' }] }
        : { data: [{ group_id: 'g2', from_item_id: 'a', to_item_id: 'b', status: 'asked', count: 1, note: null, updated_at: 't' }] },
    );
    expect(await loadRepHome([], client)).toEqual({ submissions: [], consents: [] });
    expect(issued).toEqual([]);

    const rows = await loadRepHome(['g1', 'g2'], client);
    expect(issued.map((c) => c.table).sort()).toEqual(['request_submissions', 'substitution_consents']);
    for (const c of issued) expect(opArgs(c, 'in')).toEqual([['group_id', ['g1', 'g2']]]);
    expect(rows.submissions.map((s) => s.group_id)).toEqual(['g1']);
    expect(rows.consents.map((c) => c.status)).toEqual(['asked']);
  });

  it('読み取りの失敗は AppError', async () => {
    const { client } = createFakeSupabase(() => ({ error: { code: '42501', message: 'denied' }, status: 403 }));
    await expect(loadRepHome(['g1'], client)).rejects.toBeInstanceOf(AppError);
  });
});
