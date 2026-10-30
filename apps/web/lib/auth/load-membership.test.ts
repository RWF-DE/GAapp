// loadMembershipSource：accept_my_invitations と立場の読み取りを同時に送り、招待を受け入れたときだけ読み直す（T14。4G の速さ）
import { describe, expect, it } from 'vitest';
import type { AppSupabaseClient } from '@/lib/supabase/client';
import { loadMembershipSource } from './load-membership';

type Result = { data: unknown; error: { message: string } | null };

/** 表ごとの応答を、呼ばれた回数に応じて返す偽の Supabase（select・eq・maybeSingle の鎖は then で解ける） */
function fakeClient(opts: {
  accepted: Result | (() => Promise<Result>);
  tables: Record<string, Result[]>;
}) {
  const log: string[] = [];
  const reads: Record<string, number> = {};
  const selects: Record<string, string> = {};
  const query = (table: string) => {
    const result = () => {
      const n = (reads[table] = (reads[table] ?? 0) + 1);
      const list = opts.tables[table]!;
      log.push(`read:${table}`);
      return Promise.resolve(list[Math.min(n, list.length) - 1]!);
    };
    const chain: Record<string, unknown> = {};
    for (const m of ['eq', 'maybeSingle']) chain[m] = () => chain;
    chain.select = (cols: string) => {
      selects[table] = cols;
      return chain;
    };
    chain.then = (ok: (v: Result) => unknown, ng: (e: unknown) => unknown) => result().then(ok, ng);
    return chain;
  };
  const client = {
    from: (table: string) => query(table),
    rpc: (name: string) => {
      log.push(`rpc:${name}`);
      return typeof opts.accepted === 'function' ? opts.accepted() : Promise.resolve(opts.accepted);
    },
  } as unknown as AppSupabaseClient;
  return { client, log, reads, selects };
}

const ok = (data: unknown): Result => ({ data, error: null });
const tables = (yearRoles: Result[]) => ({
  profiles: [ok({ display_name: '部員' })],
  year_roles: yearRoles,
  group_members: [ok([])],
  years: [ok([{ id: 'y1', label: 'R8', status: 'requesting', festival_start: '2026-10-10' }])],
});

describe('loadMembershipSource', () => {
  it('受け入れた招待がなければ、同時に送った1回の読み取りを使う（読み直さない）', async () => {
    let release: (r: Result) => void = () => {};
    const { client, log, reads } = fakeClient({
      accepted: () => new Promise<Result>((r) => (release = r)),
      tables: tables([ok([{ year_id: 'y1', role: 'staff' }])]),
    });
    const p = loadMembershipSource(client, 'u1');
    // accept_my_invitations の応答を待たずに、4つの読み取りが出ている
    await Promise.resolve();
    expect(log).toEqual(['rpc:accept_my_invitations', 'read:profiles', 'read:year_roles', 'read:group_members', 'read:years']);
    release(ok(0));
    const src = await p;
    expect(src.roles).toEqual([{ year_id: 'y1', role: 'staff' }]);
    expect(src.displayName).toBe('部員');
    expect(reads).toEqual({ profiles: 1, year_roles: 1, group_members: 1, years: 1 });
  });

  it('年度は年度の行の列をすべて読み、yearRows に入れる（年度の行のキャッシュに入れる。D-45）', async () => {
    const row = { id: 'y1', label: 'R8', status: 'requesting', festival_start: '2026-10-10', allocation_version: 3, prev_year_id: null };
    const { client, selects } = fakeClient({ accepted: ok(0), tables: { ...tables([ok([])]), years: [ok([row])] } });
    const before = Date.now();
    const src = await loadMembershipSource(client, 'u1');
    expect(selects.years).toContain('allocation_version');
    expect(src.years).toEqual([{ id: 'y1', label: 'R8', status: 'requesting', festival_start: '2026-10-10' }]);
    expect(src.yearRows?.rows).toEqual([row]);
    expect(src.yearRows!.readStartedAt).toBeGreaterThanOrEqual(before);
  });

  it('招待を受け入れたら（返り値 > 0）、受け入れた後の立場を読み直す', async () => {
    const { client, reads } = fakeClient({
      accepted: ok(1),
      tables: tables([ok([]), ok([{ year_id: 'y1', role: 'admin' }])]),
    });
    const src = await loadMembershipSource(client, 'u1');
    expect(src.roles).toEqual([{ year_id: 'y1', role: 'admin' }]);
    expect(reads).toEqual({ profiles: 2, year_roles: 2, group_members: 2, years: 2 });
  });

  it('accept_my_invitations のエラーは投げる', async () => {
    const { client } = fakeClient({ accepted: { data: null, error: { message: 'boom' } }, tables: tables([ok([])]) });
    await expect(loadMembershipSource(client, 'u1')).rejects.toEqual({ message: 'boom' });
  });

  it('読み取りのエラーは投げる', async () => {
    const { client } = fakeClient({ accepted: ok(0), tables: tables([{ data: null, error: { message: 'denied' } }]) });
    await expect(loadMembershipSource(client, 'u1')).rejects.toEqual({ message: 'denied' });
  });
});
