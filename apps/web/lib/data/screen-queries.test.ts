// 画面を開くときに最初に読むもの（D-45）：先読みの決め方・使用場所の名前の埋め込み・年度の行のキャッシュを使う /my の読み込み。
// T16：ダッシュボード（/）の先読み（planHomePrefetch。欄が読むクエリと同じキー。版・スナップショットを読まない）と、
// ルートのレイアウトの JS に机椅子の数え方・スナップショット・検証を入れないこと
import { QueryClient } from '@tanstack/react-query';
import { describe, expect, it } from 'vitest';
import type { AppRole, GroupSummary, Membership } from '@/lib/auth/membership';
import type { YearRow } from '@/lib/db/types';
import { furnitureRepOptions } from '@/lib/modules/furniture/rep';
import { furnitureSoumuOptions } from '@/lib/modules/furniture/soumu';
import { noticesLatestOptions } from '@/lib/modules/notices/latest';
import { PORTAL_WIDGETS, portalContextsOf, portalWidgetQuery } from '@/lib/modules/portal';
import { PORTAL_PROVIDERS } from '@/lib/modules/providers';
import type { AppSupabaseClient } from '@/lib/supabase/client';
import { queryKeys, STALE_TIME_MS } from '@/lib/query';
import { parseRoomParam } from '@/lib/schemas/stock';
import { staticImportGraph } from '@/lib/testing/import-graph';
import {
  EARLY_FETCH_PATHS,
  fetchRepRequest,
  freshYearRow,
  loadMyData,
  planHomePrefetch,
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

const ctx = (search: string, groupIds: string[] = [], role: AppRole | null = null) => ({ yearId: Y, groupIds, role, params: new URLSearchParams(search) });
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
  it('版を使わない画面（先読みの表と同じ /・/stock・/request・/my）だけで、振り分けに関わる画面（版を先に読む。D-33）は入らない', () => {
    // T16：ダッシュボード（/）は版・振り分けの行を読まないので入れた（団体代表の / を 4G で 2 秒以内に開くため。D-45・D-51）
    expect([...EARLY_FETCH_PATHS].sort()).toEqual(['/', '/my', '/request', '/stock']);
    expect(EARLY_FETCH_PATHS).toEqual(Object.keys(SCREEN_PREFETCH));
    expect(SCREEN_PREFETCH['/']).toBe(planHomePrefetch);
    // 振り分けに関わる画面（スナップショットで版を先に読む：机椅子の状況・振り分け・キャスター机交換）
    for (const p of ['/furniture', '/allocation', '/swaps']) {
      expect(EARLY_FETCH_PATHS).not.toContain(p);
      expect(Object.keys(SCREEN_PREFETCH)).not.toContain(p);
    }
  });
});

// ---------------------------------------------------------------- ダッシュボード /（T16）

describe('T16 / の先読み（planHomePrefetch）', () => {
  const G1g: GroupSummary = { id: G1, name: '模擬店01', year_id: Y, role: 'manager' };
  const G2g: GroupSummary = { id: G2, name: '模擬店02', year_id: Y, role: 'deputy_manager' };
  const member = (role: AppRole | null, groups: GroupSummary[] = []): Membership => {
    const year = { id: Y, label: 'R8', status: 'requesting' as const, festival_start: '2026-10-17' };
    return { displayName: null, year, role, groups, years: [year], latestYear: year, adminOfOpenYear: role === 'admin' };
  };
  const yearRow = { id: Y, label: 'R8', status: 'requesting', allocation_version: 3, festival_start: '2026-10-17' } as unknown as YearRow;
  /** その立場のダッシュボードの欄（要対応・締切と予定・カード）が並べるクエリのキー（重なりを除く） */
  const widgetKeys = (m: Membership) => {
    const out = new Map<string, readonly unknown[]>();
    for (const c of portalContextsOf(m, yearRow, 0)) {
      for (const p of PORTAL_PROVIDERS) {
        if (!p.kinds.includes(c.kind)) continue;
        for (const w of PORTAL_WIDGETS) {
          const q = portalWidgetQuery(p, c, w);
          if (q) out.set(JSON.stringify(q.queryKey), q.queryKey);
        }
      }
    }
    return [...out.values()];
  };
  const home = (m: Membership) => planHomePrefetch(ctx('', m.groups.map((g) => g.id), m.role));

  it.each(['admin', 'head', 'deputy_head', 'staff'] as const)(
    '総務（%s）：机椅子の軽い読み取り（要対応とカードと同じキー）と、T17 総務内のお知らせの新着（総務内のお知らせの欄と同じキー）',
    (role) => {
      expect(keys(home(member(role)))).toEqual([furnitureSoumuOptions(Y).queryKey, noticesLatestOptions(Y, 'soumu').queryKey]);
    },
  );

  it('T17 閲覧のみ：団体あてのお知らせの新着だけ（年度の行のほかに。お知らせの欄と同じキー）。ロールも団体もなければ読まない', () => {
    expect(keys(home(member('viewer')))).toEqual([noticesLatestOptions(Y, 'viewer').queryKey]);
    expect(home(member(null))).toEqual([]);
  });

  it('店長・副店長：自団体の提出と了承（代表する団体の欄と要対応と同じキー。団体は立場の一覧の順）と、T17 団体あてのお知らせの新着。兼ねた人は両方', () => {
    expect(keys(home(member(null, [G1g, G2g])))).toEqual([furnitureRepOptions(Y, [G1, G2]).queryKey, noticesLatestOptions(Y, 'rep', [G1, G2]).queryKey]);
    expect(keys(home(member('admin', [G1g])))).toEqual([
      furnitureSoumuOptions(Y).queryKey,
      noticesLatestOptions(Y, 'soumu').queryKey,
      furnitureRepOptions(Y, [G1]).queryKey,
      noticesLatestOptions(Y, 'rep', [G1]).queryKey,
    ]);
    // 閲覧のみで店長も務める人は、お知らせを閲覧のみとして1回だけ読む（団体あてで、読める範囲も同じ）
    expect(keys(home(member('viewer', [G1g])))).toEqual([noticesLatestOptions(Y, 'viewer').queryKey, furnitureRepOptions(Y, [G1]).queryKey]);
  });

  it('先読みするキーは、同じ立場のダッシュボードの欄が並べるクエリのキーと同じ（同じキャッシュを読み、余分に読まない）', () => {
    const cases = [member('admin'), member('staff'), member('viewer'), member(null, [G1g]), member('admin', [G1g, G2g]), member('viewer', [G2g])];
    for (const m of cases) {
      expect(keys(home(m)), `${m.role}・${m.groups.length}`).toEqual(widgetKeys(m));
    }
  });

  it('版・振り分けの行・ルール・スナップショットのキーは先読みしない（キーはどれも ["year", 年度, "portal", "furniture" か "notices", …]）', () => {
    for (const m of [member('admin', [G1g]), member('staff'), member('viewer', [G2g]), member(null, [G1g, G2g])]) {
      for (const key of keys(home(m))) {
        expect(key.slice(0, 3)).toEqual(['year', Y, 'portal']);
        expect(['furniture', 'notices']).toContain(key[3]);
      }
    }
  });

  it('立場が届いて、総務でなくなった・代表する団体が変わったら使わない（usable が偽。settleEarlyLoad が消す）', () => {
    const [soumu] = home(member('staff'));
    expect(soumu!.usable!(member('staff'))).toBe(true);
    expect(soumu!.usable!(member('head'))).toBe(true);
    expect(soumu!.usable!(member('viewer'))).toBe(false);
    expect(soumu!.usable!(member(null, [G1g]))).toBe(false);
    const [rep] = home(member(null, [G1g, G2g]));
    expect(rep!.usable!(member(null, [G1g, G2g]))).toBe(true);
    expect(rep!.usable!(member(null, [G1g]))).toBe(false);
    expect(rep!.usable!(member(null, [G2g, G1g]))).toBe(false);
  });

  it('T17 お知らせの新着の usable：総務内は総務のまま、閲覧のみはロールが閲覧のみのまま、団体代表はロールが閲覧のみでなく団体の並びが同じ', () => {
    const [, soumuNotices] = home(member('staff'));
    expect(soumuNotices!.options.queryKey).toEqual(noticesLatestOptions(Y, 'soumu').queryKey);
    expect(soumuNotices!.usable!(member('admin'))).toBe(true);
    expect(soumuNotices!.usable!(member('viewer'))).toBe(false);
    const [viewerNotices] = home(member('viewer'));
    expect(viewerNotices!.usable!(member('viewer'))).toBe(true);
    expect(viewerNotices!.usable!(member('viewer', [G1g]))).toBe(true);
    expect(viewerNotices!.usable!(member('staff'))).toBe(false);
    expect(viewerNotices!.usable!(member(null, [G1g]))).toBe(false);
    const [, repNotices] = home(member(null, [G1g, G2g]));
    expect(repNotices!.options.queryKey).toEqual(noticesLatestOptions(Y, 'rep', [G1, G2]).queryKey);
    expect(repNotices!.usable!(member(null, [G1g, G2g]))).toBe(true);
    expect(repNotices!.usable!(member('admin', [G1g, G2g]))).toBe(true);
    // 閲覧のみになった人は閲覧のみとして読む（団体代表の新着は使わない）
    expect(repNotices!.usable!(member('viewer', [G1g, G2g]))).toBe(false);
    expect(repNotices!.usable!(member(null, [G1g]))).toBe(false);
  });
});

describe('T16 ルートのレイアウトの JS（Providers が先読みの表を読む）', () => {
  it('先読みの表からたどれるファイルに、机椅子の数え方・要対応の組み立て・ナビゲーション・スナップショット・検証がない', () => {
    // components/layout/providers.tsx はどのページでも最初に読む。/ の先読みが使うのは机椅子のクエリ（soumu.ts・rep.ts）と
    // そのキー（query-key.ts）だけ
    const g = staticImportGraph('components/layout/providers.tsx');
    expect(g.files).toContain('lib/data/screen-queries.ts');
    expect(g.files).toContain('lib/modules/furniture/soumu.ts');
    expect(g.files).toContain('lib/modules/furniture/rep.ts');
    // T17：お知らせの新着の読み取り（latest.ts）だけ。欄の組み立て・一覧の読み取り・入力の zod は入れない
    expect(g.files).toContain('lib/modules/notices/latest.ts');
    const heavy = [
      'lib/modules/notices/portal.ts',
      'lib/data/notices.ts',
      'lib/schemas/notices.ts',
      'lib/modules/furniture/portal.ts',
      'lib/modules/furniture/counts.ts',
      'lib/modules/providers.ts',
      'lib/modules/portal.ts',
      'lib/navigation.ts',
      'lib/data/dashboard.ts',
      'lib/data/snapshot.ts',
      'lib/data/validation.ts',
      'lib/data/swaps.ts',
    ];
    expect(g.files.filter((f) => heavy.includes(f))).toEqual([]);
    expect(g.packages.filter((p) => /^(@gaapp\/|highs|exceljs)/.test(p))).toEqual([]);
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
