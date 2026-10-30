// 画面を開くときに最初に読むもの（D-45）：先読みの決め方・使用場所の名前の埋め込み・年度の行のキャッシュを使う /my の読み込み
import { QueryClient } from '@tanstack/react-query';
import { describe, expect, it } from 'vitest';
import type { AppSupabaseClient } from '@/lib/supabase/client';
import { queryKeys, STALE_TIME_MS } from '@/lib/query';
import { parseRoomParam } from '@/lib/schemas/stock';
import { fetchRepRequest, freshYearRow, loadMyData, planMyPrefetch, planRequestPrefetch, planStockPrefetch } from './screen-queries';
import { seedYearRows } from './year';

const Y = '00000000-0000-4000-8000-0000000000a9';
const R = '11111111-2222-4333-8444-555555555555';
const G1 = '00000000-0000-4000-8000-0000000000b1';
const G2 = '00000000-0000-4000-8000-0000000000b2';

const ctx = (search: string, groupIds: string[] = []) => ({ yearId: Y, groupIds, params: new URLSearchParams(search) });
const keys = (list: { options: { queryKey: readonly unknown[] } }[]) => list.map((e) => e.options.queryKey);

describe('先読みの決め方（URL と覚えた id から）', () => {
  it('/stock：?room= があれば場所・品目とその部屋の在庫、なければ場所・品目と年度の在庫。形の違う room は読まない', () => {
    expect(keys(planStockPrefetch(ctx(`room=${R.toUpperCase()}`)))).toEqual([
      queryKeys.yearPart(Y, 'stock-master'),
      queryKeys.yearPart(Y, 'stocks', 'room', R),
    ]);
    expect(keys(planStockPrefetch(ctx('')))).toEqual([queryKeys.yearPart(Y, 'stock-master'), queryKeys.yearPart(Y, 'stocks', 'all')]);
    expect(keys(planStockPrefetch(ctx('room=nope')))).toEqual([queryKeys.yearPart(Y, 'stock-master')]);
    // 形の判定は lib/schemas/stock.ts の parseRoomParam と同じ
    for (const v of [R, ` ${R.toUpperCase()} `, 'nope', '00000000-0000-0000-0000-000000000000', 'FFFFFFFF-FFFF-FFFF-FFFF-FFFFFFFFFFFF', '11111111-2222-9333-8444-555555555555']) {
      const planned = planStockPrefetch(ctx(`room=${encodeURIComponent(v)}`)).length === 2;
      expect(planned, v).toBe(parseRoomParam(v) !== null);
    }
  });

  it('/request・/my：?group= が覚えた団体ならその団体、なければ最初の団体。団体がなければ読まない', () => {
    expect(planRequestPrefetch(ctx(`group=${G2}`, [G1, G2])).map((e) => e.groupId)).toEqual([G2]);
    expect(planRequestPrefetch(ctx('group=other', [G1, G2])).map((e) => e.groupId)).toEqual([G1]);
    expect(planRequestPrefetch(ctx('', []))).toEqual([]);
    expect(keys(planMyPrefetch(ctx(`group=${G2}`, [G1, G2])))).toEqual([queryKeys.yearPart(Y, 'my', G2)]);
    expect(planMyPrefetch(ctx('', []))).toEqual([]);
  });
});

/** 表ごとの応答を返し、読んだ表と select を記録する偽のクライアント */
function fakeClient(rows: Record<string, unknown>) {
  const log: { table: string; select: string }[] = [];
  const client = {
    from: (table: string) => {
      const entry = { table, select: '' };
      log.push(entry);
      const res = () => Promise.resolve({ data: rows[table] ?? (table === 'request_submissions' ? null : []), error: null, status: 200 });
      const b: Record<string, unknown> = {};
      b.select = (s: string) => {
        entry.select = s;
        return b;
      };
      for (const k of ['eq', 'order', 'range']) b[k] = () => b;
      b.maybeSingle = res;
      b.then = (ok: (v: unknown) => unknown, ng?: (e: unknown) => unknown) => res().then(ok, ng);
      return b;
    },
  } as unknown as AppSupabaseClient;
  return { client, log };
}

describe('fetchRepRequest', () => {
  it('使用場所の名前は groups に rooms を埋め込んで同じ往復で読み、団体の行からは外す', async () => {
    const { client, log } = fakeClient({ groups: { id: G1, name: '模擬店01', location_room_id: R, location_room: { name: '1-1' } } });
    const d = await fetchRepRequest(G1, client);
    expect(d.locationName).toBe('1-1');
    expect(d.group).toEqual({ id: G1, name: '模擬店01', location_room_id: R });
    expect(log.map((l) => l.table).sort()).toEqual(['groups', 'items', 'request_submissions', 'requests']);
    expect(log.find((l) => l.table === 'groups')!.select).toContain('location_room:rooms!location_room_id(name)');
  });

  it('使用場所がない・読めないときは null', async () => {
    const none = await fetchRepRequest(G1, fakeClient({ groups: { id: G1, location_room_id: null, location_room: null } }).client);
    expect(none.locationName).toBeNull();
    const hidden = await fetchRepRequest(G1, fakeClient({ groups: { id: G1, location_room_id: R, location_room: null } }).client);
    expect(hidden.locationName).toBeNull();
  });
});

describe('loadMyData と年度の行のキャッシュ', () => {
  const yearRow = (status: string) => ({ id: Y, label: 'R9', status, allocation_version: 1 }) as never;

  it('立場と一緒に読んだ新しい年度の行があれば、年度の行を読まず、確定前なら振り分けの行も読まない', async () => {
    const qc = new QueryClient();
    seedYearRows(qc, [yearRow('requesting')], Date.now());
    const { client, log } = fakeClient({ groups: { id: G1 } });
    const d = await loadMyData(Y, G1, client, qc);
    expect(log.map((l) => l.table)).not.toContain('years');
    expect(log.map((l) => l.table)).not.toContain('allocations');
    expect(d.year.status).toBe('requesting');
    expect(d.allocations).toBeNull();
  });

  it('キャッシュの年度が確定なら、振り分けの行を並行に読む', async () => {
    const qc = new QueryClient();
    seedYearRows(qc, [yearRow('confirmed')], Date.now());
    const { client, log } = fakeClient({ groups: { id: G1 }, allocations: [{ id: 'a1' }] });
    const d = await loadMyData(Y, G1, client, qc);
    expect(log.map((l) => l.table).filter((t) => t === 'allocations')).toHaveLength(1);
    expect(d.allocations).toEqual([{ id: 'a1' }]);
  });

  it('キャッシュの年度が確定前なら、振り分けの行は読まない（後で年度の行も読まない）', async () => {
    const qc = new QueryClient();
    seedYearRows(qc, [yearRow('allocating')], Date.now());
    const { client, log } = fakeClient({ groups: { id: G1 }, allocations: [{ id: 'a1' }] });
    const d = await loadMyData(Y, G1, client, qc);
    expect(log.map((l) => l.table)).not.toContain('allocations');
    expect(d.allocations).toBeNull();
  });

  it('無効にされた・古い年度の行は使わずに読む（状態の遷移の後の読み直しで、古い状態を使わない）', async () => {
    const qc = new QueryClient();
    seedYearRows(qc, [yearRow('requesting')], Date.now());
    await qc.invalidateQueries({ queryKey: queryKeys.year(Y), refetchType: 'none' });
    expect(freshYearRow(qc, Y)).toBeNull();
    const old = new QueryClient();
    seedYearRows(old, [yearRow('requesting')], Date.now() - STALE_TIME_MS - 1);
    expect(freshYearRow(old, Y)).toBeNull();
    const { client, log } = fakeClient({ years: yearRow('confirmed'), groups: { id: G1 }, allocations: [{ id: 'a1' }] });
    const d = await loadMyData(Y, G1, client, qc);
    expect(log.map((l) => l.table)).toContain('years');
    expect(d.year.status).toBe('confirmed');
    expect(d.allocations).toEqual([{ id: 'a1' }]);
  });
});

describe('seedYearRows', () => {
  it('読み始めた時刻より後に読んだ・書いたキャッシュは上書きしない', () => {
    const qc = new QueryClient();
    const t = Date.now();
    qc.setQueryData(queryKeys.yearRow(Y), { id: Y, status: 'allocating' }, { updatedAt: t + 10 });
    expect(seedYearRows(qc, [{ id: Y, status: 'requesting' } as never], t)).toBe(0);
    expect(qc.getQueryData(queryKeys.yearRow(Y))).toEqual({ id: Y, status: 'allocating' });
    expect(seedYearRows(qc, [{ id: Y, status: 'confirmed' } as never], t + 20)).toBe(1);
    expect(qc.getQueryData(queryKeys.yearRow(Y))).toEqual({ id: Y, status: 'confirmed' });
  });
});
