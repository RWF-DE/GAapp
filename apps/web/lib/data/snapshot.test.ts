import { describe, expect, it } from 'vitest';
import { AppError } from '@/lib/errors';
import { createFakeSupabase, opArgs, type FakeCall } from '@/lib/testing/fake-supabase';
import { loadSnapshot } from './snapshot';

const Y = '11111111-1111-4111-8111-111111111111';
const G = '22222222-2222-4222-8222-222222222222';
const I = '33333333-3333-4333-8333-333333333333';
const yearRow = {
  id: Y,
  label: 'R8',
  status: 'allocating',
  allocation_version: 7,
  auto_allocated_at: null,
  festival_start: '2026-10-17',
  request_open_at: null,
  request_close_at: null,
  prev_year_id: null,
  updated_at: 't',
};
const flush = () => new Promise((r) => setTimeout(r, 0));

function gated(rows: (call: FakeCall) => unknown[] = () => []) {
  let release!: () => void;
  const gate = new Promise<void>((r) => (release = r));
  const fake = createFakeSupabase(async (call) => {
    if (call.table === 'years') {
      await gate;
      return { data: yearRow };
    }
    return { data: rows(call) };
  });
  return { ...fake, release };
}

describe('loadSnapshot の読む順', () => {
  it('years の応答の前にほかの問い合わせを出さない（版を先に読む）', async () => {
    const { client, issued, release } = gated();
    const p = loadSnapshot(Y, 'full', client);
    await flush();
    await flush();
    expect(issued.map((c) => c.table)).toEqual(['years']);
    release();
    const s = await p;
    expect(issued[0]!.table).toBe('years');
    expect(issued.slice(1).map((c) => c.table).sort()).toEqual(
      [
        'allocations',
        'distance_overrides',
        'groups',
        'items',
        'request_submissions',
        'requests',
        'room_years',
        'rooms',
        'rules',
        'stocks',
        'substitution_consents',
      ].sort(),
    );
    expect(s.version).toBe(7);
    expect(s.year.label).toBe('R8');
    expect(s.part).toBe('full');
  });

  it('public（viewer）は場所・品目・団体・振り分けだけを読む', async () => {
    const { client, issued, release } = gated();
    release();
    const s = await loadSnapshot(Y, 'public', client);
    expect(issued.slice(1).map((c) => c.table).sort()).toEqual(['allocations', 'groups', 'items', 'room_years', 'rooms']);
    expect(s.stocks).toEqual([]);
    expect(s.rules).toEqual([]);
  });

  it('年度の表は年度で絞る（requests・提出・了承は groups!inner で）。行の多い表は range で読む', async () => {
    const { client, issued, release } = gated((call) =>
      call.table === 'requests' ? [{ group_id: G, item_id: I, count: 2, updated_at: 't', groups: { year_id: Y } }] : [],
    );
    release();
    const s = await loadSnapshot(Y, 'full', client);
    const call = (t: string) => issued.find((c) => c.table === t)!;
    expect(String(opArgs(call('requests'), 'select')[0]![0])).toContain('groups!inner(year_id)');
    expect(opArgs(call('requests'), 'eq')).toEqual([['groups.year_id', Y]]);
    expect(opArgs(call('request_submissions'), 'eq')).toEqual([['groups.year_id', Y]]);
    expect(opArgs(call('substitution_consents'), 'eq')).toEqual([['groups.year_id', Y]]);
    for (const t of ['stocks', 'allocations', 'groups', 'rules', 'room_years']) expect(opArgs(call(t), 'eq')).toEqual([['year_id', Y]]);
    for (const t of ['stocks', 'requests', 'allocations']) expect(opArgs(call(t), 'range')).toEqual([[0, 999]]);
    // join の列は外す
    expect(s.requests).toEqual([{ group_id: G, item_id: I, count: 2, updated_at: 't' }]);
  });

  it('年度が読めなければ not_found で、ほかを読まない', async () => {
    const { client, issued } = createFakeSupabase(() => ({ data: null }));
    await expect(loadSnapshot(Y, 'full', client)).rejects.toBeInstanceOf(AppError);
    expect(issued.map((c) => c.table)).toEqual(['years']);
  });

  it('どれかの表で失敗したら分類して投げる', async () => {
    const fake = createFakeSupabase((call) =>
      call.table === 'years' ? { data: yearRow } : call.table === 'rules' ? { error: { code: '42501', message: 'denied' }, status: 403 } : { data: [] },
    );
    await expect(loadSnapshot(Y, 'full', fake.client)).rejects.toMatchObject({ info: { kind: 'forbidden' } });
  });
});
