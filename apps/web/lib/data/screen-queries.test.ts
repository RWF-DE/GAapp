// 画面を開くときに最初に読むもの（D-45）：先読みの決め方・使用場所の名前の埋め込み・年度の行のキャッシュを使う /my の読み込み
import { QueryClient } from '@tanstack/react-query';
import { describe, expect, it } from 'vitest';
import type { AppSupabaseClient } from '@/lib/supabase/client';
import { queryKeys, STALE_TIME_MS } from '@/lib/query';
import { parseRoomParam } from '@/lib/schemas/stock';
import {
  EARLY_FETCH_PATHS,
  fetchRepRequest,
  freshYearRow,
  loadMyData,
  planMyPrefetch,
  planRequestPrefetch,
  planStockPrefetch,
  SCREEN_PREFETCH,
} from './screen-queries';
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
function fakeClient(rows: Record<string, unknown>, gates: Record<string, Promise<void>> = {}) {
  const log: { table: string; select: string }[] = [];
  const client = {
    from: (table: string) => {
      const entry = { table, select: '' };
      log.push(entry);
      const res = () =>
        (gates[table] ?? Promise.resolve()).then(() => ({ data: rows[table] ?? (table === 'request_submissions' ? null : []), error: null, status: 200 }));
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

describe('先送りしてよい画面（EARLY_FETCH_PATHS）', () => {
  it('版を使わない画面（先読みの表と同じ /stock・/request・/my）だけで、振り分けに関わる画面（版を先に読む。D-33）は入らない', () => {
    expect([...EARLY_FETCH_PATHS].sort()).toEqual(['/my', '/request', '/stock']);
    expect(EARLY_FETCH_PATHS).toEqual(Object.keys(SCREEN_PREFETCH));
    for (const p of ['/', '/allocation', '/swaps']) {
      expect(EARLY_FETCH_PATHS).not.toContain(p);
      expect(Object.keys(SCREEN_PREFETCH)).not.toContain(p);
    }
  });
});

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
  const tables = (log: { table: string }[]) => log.map((l) => l.table);

  it('キャッシュに新しい年度の行があっても、年度の行はほかの表と並行に読み直す。確定前なら振り分けの行は読まない', async () => {
    const qc = new QueryClient();
    seedYearRows(qc, [yearRow('requesting')], Date.now());
    const { client, log } = fakeClient({ years: yearRow('requesting'), groups: { id: G1 } });
    const d = await loadMyData(Y, G1, client, qc);
    expect(tables(log)).toContain('years');
    expect(tables(log)).not.toContain('allocations');
    expect(d.year.status).toBe('requesting');
    expect(d.allocations).toBeNull();
  });

  it('キャッシュの年度が確定なら、振り分けの行を年度の行の応答を待たずに読み始め、読み直した年度も確定なら使う（往復は増えない）', async () => {
    const qc = new QueryClient();
    seedYearRows(qc, [yearRow('confirmed')], Date.now());
    let open!: () => void;
    const yearGate = new Promise<void>((r) => (open = r));
    const { client, log } = fakeClient({ years: yearRow('confirmed'), groups: { id: G1 }, allocations: [{ id: 'a1' }] }, { years: yearGate });
    const p = loadMyData(Y, G1, client, qc);
    await Promise.resolve();
    expect(tables(log)).toContain('years');
    expect(tables(log)).toContain('allocations');
    open();
    const d = await p;
    expect(tables(log).filter((t) => t === 'allocations')).toHaveLength(1);
    expect(d.allocations).toEqual([{ id: 'a1' }]);
  });

  it('キャッシュの年度が確定でも、読み直した年度の行が確定前なら、先に読んだ振り分けの行は捨てて null（year も読み直した行）', async () => {
    // 確定・終了の後、キャッシュの 30 秒以内に確定前へ戻されたとき。振り分けの行は RLS で 0 行になるので「振り分けがない」と取り違えない
    for (const now of ['allocating', 'requesting', 'preparing']) {
      const qc = new QueryClient();
      seedYearRows(qc, [yearRow('confirmed')], Date.now());
      const { client } = fakeClient({ years: yearRow(now), groups: { id: G1 }, allocations: [] });
      const d = await loadMyData(Y, G1, client, qc);
      expect(d.year.status, now).toBe(now);
      expect(d.allocations, now).toBeNull();
    }
  });

  it('キャッシュの年度が確定前でも、読み直した年度の行が確定・終了なら、その後で振り分けの行を読む', async () => {
    for (const now of ['confirmed', 'closed']) {
      const qc = new QueryClient();
      seedYearRows(qc, [yearRow('allocating')], Date.now());
      const { client, log } = fakeClient({ years: yearRow(now), groups: { id: G1 }, allocations: [{ id: 'a1' }] });
      const d = await loadMyData(Y, G1, client, qc);
      expect(d.year.status, now).toBe(now);
      expect(tables(log).filter((t) => t === 'allocations'), now).toHaveLength(1);
      expect(tables(log).indexOf('allocations'), now).toBeGreaterThan(tables(log).indexOf('years'));
      expect(d.allocations, now).toEqual([{ id: 'a1' }]);
    }
  });

  it('キャッシュの年度が確定前で、読み直した年度の行も確定前なら、振り分けの行は読まない', async () => {
    const qc = new QueryClient();
    seedYearRows(qc, [yearRow('allocating')], Date.now());
    const { client, log } = fakeClient({ years: yearRow('allocating'), groups: { id: G1 }, allocations: [{ id: 'a1' }] });
    const d = await loadMyData(Y, G1, client, qc);
    expect(tables(log)).not.toContain('allocations');
    expect(d.allocations).toBeNull();
  });

  it('読み直した年度の行で、読み始める前のキャッシュの行を上書きする（確定のキャッシュの行が、読み直した確定前の行になる）', async () => {
    const qc = new QueryClient();
    seedYearRows(qc, [yearRow('confirmed')], Date.now());
    const { client } = fakeClient({ years: yearRow('allocating'), groups: { id: G1 } });
    await loadMyData(Y, G1, client, qc);
    expect(qc.getQueryData<{ status: string }>(queryKeys.yearRow(Y))?.status).toBe('allocating');
    expect(freshYearRow(qc, Y)?.status).toBe('allocating');
  });

  it('無効にされた・古い年度の行は使わない（振り分けの行は年度の行の後に読む）', async () => {
    const qc = new QueryClient();
    seedYearRows(qc, [yearRow('requesting')], Date.now());
    await qc.invalidateQueries({ queryKey: queryKeys.year(Y), refetchType: 'none' });
    expect(freshYearRow(qc, Y)).toBeNull();
    const old = new QueryClient();
    seedYearRows(old, [yearRow('requesting')], Date.now() - STALE_TIME_MS - 1);
    expect(freshYearRow(old, Y)).toBeNull();
    const { client, log } = fakeClient({ years: yearRow('confirmed'), groups: { id: G1 }, allocations: [{ id: 'a1' }] });
    const d = await loadMyData(Y, G1, client, qc);
    expect(tables(log)).toContain('years');
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
