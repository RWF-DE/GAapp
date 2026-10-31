// @vitest-environment jsdom
// ページを開いたときの先読み（D-45）：覚える id・立場の読み込みの使い回し・先読みを使う／捨てる条件・ユーザーが変わったら消す
import { QueryClient } from '@tanstack/react-query';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { buildMembership, type MembershipSource } from '@/lib/auth/membership';
import type { AppSupabaseClient } from '@/lib/supabase/client';
import { EARLY_GLOBAL, earlyAwareFetch } from './early-fetch';
import {
  discardEarlyLoad,
  RECORD_SETTLE_MS,
  hintFromSource,
  hintKey,
  hintsOnSignIn,
  hintsOnSignOut,
  normalizePath,
  pickHintYear,
  prefetchOpenedScreen,
  readHint,
  resetEarlyLoadForTest,
  settleEarlyLoad,
  startEarlyLoad,
  takeEarlyMembership,
  writeHint,
  type RoutePrefetchContext,
} from './early-load';

const calls: string[] = [];
const loadMembershipSource = vi.fn(async (_c: unknown, userId: string) => {
  calls.push(`membership:${userId}`);
  return sources[userId]!;
});
vi.mock('@/lib/env', () => ({ SUPABASE_URL: 'https://db.example.test', SUPABASE_PUBLISHABLE_KEY: 'pk', BASE_PATH: '' }));
vi.mock('@/lib/auth/load-membership', () => ({ loadMembershipSource: (c: unknown, u: string) => loadMembershipSource(c, u) }));

const U1 = '00000000-0000-4000-8000-000000000001';
const U2 = '00000000-0000-4000-8000-000000000002';
const Y8 = '00000000-0000-4000-8000-0000000000a8';
const Y9 = '00000000-0000-4000-8000-0000000000a9';
const G1 = '00000000-0000-4000-8000-0000000000b1';
const G2 = '00000000-0000-4000-8000-0000000000b2';

const year = (id: string, label: string, festival: string) => ({ id, label, status: 'requesting' as const, festival_start: festival });
const sources: Record<string, MembershipSource> = {
  [U1]: {
    displayName: '代表',
    years: [year(Y9, 'R9', '2027-10-16'), year(Y8, 'R8', '2026-10-17')],
    roles: [],
    groups: [
      { id: G2, name: '模擬店02', year_id: Y9, role: 'manager' },
      { id: G1, name: '模擬店01', year_id: Y9, role: 'deputy_manager' },
      { id: G1.replace('b1', 'c1'), name: '模擬店01', year_id: Y8, role: 'manager' },
    ],
  },
  [U2]: { displayName: '部員', years: [year(Y9, 'R9', '2027-10-16')], roles: [{ year_id: Y9, role: 'staff' }], groups: [] },
};

/** getSession の呼び出しを記録する偽の supabase */
function fakeSupabase(userId: string | null) {
  return {
    auth: {
      getSession: vi.fn(async () => {
        calls.push('getSession');
        return { data: { session: userId ? { user: { id: userId } } : null } };
      }),
    },
  } as unknown as AppSupabaseClient;
}

/** /my の先読み：団体ごとのキー（読み方は呼ばれた順を記録するだけ） */
const routes = {
  '/my': (ctx: RoutePrefetchContext) => {
    const group = ctx.groupIds.find((g) => g === ctx.params.get('group')) ?? ctx.groupIds[0];
    return group
      ? [
          {
            groupId: group,
            options: {
              queryKey: ['year', ctx.yearId, 'my', group],
              queryFn: async () => {
                calls.push(`my:${ctx.yearId}:${group}`);
                return { group };
              },
            },
          },
        ]
      : [];
  },
};

const flush = async () => {
  for (let i = 0; i < 10; i++) await Promise.resolve();
};

beforeEach(() => {
  resetEarlyLoadForTest();
  calls.length = 0;
  loadMembershipSource.mockClear();
  window.localStorage.clear();
  window.sessionStorage.clear();
});
afterEach(() => resetEarlyLoadForTest());

describe('覚える id（gaapp:prefetch:<user_id>）', () => {
  it('自分の年度ごとに団体を立場と同じ並び（名前 → id）で覚え、最新の年度を覚える', () => {
    const hint = hintFromSource(sources[U1]!);
    expect(hint.latestYearId).toBe(Y9);
    expect(hint.years[Y9]).toEqual([G1, G2]);
    writeHint(U1, hint);
    expect(readHint(U1)).toEqual(hint);
  });

  it('形の違う値・id でない値は読まない', () => {
    window.localStorage.setItem(hintKey(U1), '{"latestYearId":"x","years":{}}');
    expect(readHint(U1)).toBeNull();
    window.localStorage.setItem(hintKey(U1), JSON.stringify({ latestYearId: Y9, years: { [Y9]: ['<script>'] } }));
    expect(readHint(U1)).toBeNull();
    window.localStorage.setItem(hintKey(U1), 'broken');
    expect(readHint(U1)).toBeNull();
  });

  it('下書きと同じ扱い：手動のログアウトでその人の分（覚えたリクエストも）を消し、強制では残し、別の人のログインで前の人の分を消す', () => {
    const put = () => {
      writeHint(U1, hintFromSource(sources[U1]!));
      window.localStorage.setItem(`${hintKey(U1)}:requests`, '{"paths":{}}');
      writeHint(U2, hintFromSource(sources[U2]!));
    };
    put();
    expect(hintsOnSignOut('forced', U1)).toBe(0);
    expect(readHint(U1)).not.toBeNull();
    expect(hintsOnSignOut('manual', U1)).toBe(2);
    expect(readHint(U1)).toBeNull();
    expect(window.localStorage.getItem(`${hintKey(U1)}:requests`)).toBeNull();
    expect(readHint(U2)).not.toBeNull();
    put();
    expect(hintsOnSignIn(U2)).toBe(2);
    expect(readHint(U1)).toBeNull();
    expect(readHint(U2)).not.toBeNull();
  });

  it('開く年度はそのタブで選んだ年度（覚えた年度にあれば）、なければ最新の年度。パスは basePath と末尾の / を外す', () => {
    const hint = hintFromSource(sources[U1]!);
    expect(pickHintYear(hint, Y8)).toBe(Y8);
    expect(pickHintYear(hint, 'other')).toBe(Y9);
    expect(pickHintYear(hint, null)).toBe(Y9);
    expect(normalizePath('/GAapp/my/', '/GAapp')).toBe('/my');
    expect(normalizePath('/GAapp/', '/GAapp')).toBe('/');
    expect(normalizePath('/stock/', '')).toBe('/stock');
  });
});

describe('ページを開いたときの読み込み', () => {
  const start = (userId: string | null, url = '/my/', qc = new QueryClient()) => {
    window.history.replaceState(null, '', url);
    startEarlyLoad(qc, { supabase: fakeSupabase(userId), routes });
    return qc;
  };

  it('覚えた id がなければ、立場だけを読み始め、AuthProvider はその結果を使う（2回目は読み直さない）', async () => {
    const qc = start(U1);
    const p = takeEarlyMembership(U1);
    expect(p).not.toBeNull();
    await expect(p).resolves.toBe(sources[U1]);
    expect(loadMembershipSource).toHaveBeenCalledTimes(1);
    expect(takeEarlyMembership(U1)).toBeNull(); // 1回だけ
    expect(qc.getQueryCache().getAll()).toHaveLength(0);
  });

  it('覚えた id があれば、立場の読み込みを先に送り、その後で開いた画面の団体のデータを読み始める（?group= が覚えた団体なら、その団体）', async () => {
    writeHint(U1, hintFromSource(sources[U1]!));
    const qc = start(U1, `/my/?group=${G2}`);
    await flush();
    expect(calls).toEqual(['getSession', `membership:${U1}`, 'getSession', `my:${Y9}:${G2}`]);
    expect(qc.getQueryData(['year', Y9, 'my', G2])).toEqual({ group: G2 });
  });

  it('立場が届いて同じ年度・団体なら先読みを残す', async () => {
    writeHint(U1, hintFromSource(sources[U1]!));
    const qc = start(U1);
    await flush();
    const m = buildMembership(sources[U1]!, null);
    expect(settleEarlyLoad(U1, m)).toEqual({ kept: 1, removed: 0 });
    expect(qc.getQueryData(['year', Y9, 'my', G1])).toEqual({ group: G1 });
    expect(settleEarlyLoad(U1, m)).toEqual({ kept: 0, removed: 0 }); // 2回目は何もしない
  });

  it('立場で開く年度が違えば（タブで別の年度を選んだ・ロールが変わった）、先読みを捨てる', async () => {
    writeHint(U1, hintFromSource(sources[U1]!));
    const qc = start(U1);
    await flush();
    const otherYear = buildMembership({ ...sources[U1]!, groups: sources[U1]!.groups.filter((g) => g.year_id === Y8) }, Y8);
    expect(settleEarlyLoad(U1, otherYear)).toEqual({ kept: 0, removed: 1 });
    expect(qc.getQueryData(['year', Y9, 'my', G1])).toBeUndefined();
  });

  it('その団体の代表でなくなっていれば捨てる（招待されていない場合も）', async () => {
    writeHint(U1, hintFromSource(sources[U1]!));
    const qc = start(U1);
    await flush();
    const m = buildMembership({ ...sources[U1]!, groups: [{ id: G2, name: '模擬店02', year_id: Y9, role: 'manager' }] }, null);
    expect(settleEarlyLoad(U1, m)).toEqual({ kept: 0, removed: 1 });
    expect(qc.getQueryData(['year', Y9, 'my', G1])).toBeUndefined();
  });

  it('AuthProvider のログインの人が違えば、先読みを捨てて、その人の立場を読み直す', async () => {
    writeHint(U1, hintFromSource(sources[U1]!));
    const qc = start(U1);
    await flush();
    await expect(takeEarlyMembership(U2)).resolves.toBe(sources[U2]);
    expect(loadMembershipSource).toHaveBeenLastCalledWith(expect.anything(), U2);
    expect(qc.getQueryData(['year', Y9, 'my', G1])).toBeUndefined();
  });

  it('ログアウトの状態になったら、先読みをすべて捨てる', async () => {
    writeHint(U1, hintFromSource(sources[U1]!));
    const qc = start(U1);
    await flush();
    expect(discardEarlyLoad()).toBe(1);
    expect(qc.getQueryCache().getAll()).toHaveLength(0);
  });

  it('ログインしていなければ何も読まず、後でログインした人の立場はふつうに読む', async () => {
    start(null);
    await flush();
    expect(loadMembershipSource).not.toHaveBeenCalled();
    await expect(takeEarlyMembership(U2)).resolves.toBe(sources[U2]);
  });

  it('立場が届いたとき（描画の前）に、立場の年度と団体で開いた画面のデータを読み始める', async () => {
    const qc = start(U1, '/my/');
    await flush();
    expect(prefetchOpenedScreen(buildMembership(sources[U1]!, null), window.location)).toBe(1);
    await flush();
    expect(qc.getQueryData(['year', Y9, 'my', G1])).toEqual({ group: G1 });
    window.history.replaceState(null, '', '/history/');
    expect(prefetchOpenedScreen(buildMembership(sources[U1]!, null), window.location)).toBe(0); // 先読みのない画面
  });
});

describe('開いたときのリクエストの記録（early-fetch.ts）を覚える時', () => {
  const start = (url = '/my/') => {
    window.history.replaceState(null, '', url);
    startEarlyLoad(new QueryClient(), { supabase: fakeSupabase(U1), routes });
  };
  const send = () => earlyAwareFetch('https://db.example.test/rest/v1/groups?select=id', { method: 'GET' });

  it('立場が届いて先読みが合っていれば、少し待ってからそのパスの分を覚える', async () => {
    vi.useFakeTimers();
    try {
      vi.stubGlobal('fetch', vi.fn(async () => new Response('[]')));
      start();
      await send();
      await vi.advanceTimersByTimeAsync(0);
      settleEarlyLoad(U1, buildMembership(sources[U1]!, null));
      expect(window.localStorage.getItem(`${hintKey(U1)}:requests`)).toBeNull();
      await vi.advanceTimersByTimeAsync(RECORD_SETTLE_MS);
      expect(JSON.parse(window.localStorage.getItem(`${hintKey(U1)}:requests`)!).paths['/my']).toHaveLength(1);
    } finally {
      vi.useRealTimers();
      vi.unstubAllGlobals();
    }
  });

  // 記録・先送りしないパス：振り分けに関わる画面（/furniture・/allocation・/swaps。版を先に読む）と、ダッシュボード（/。版は読まないが
  // T16 では表に入れない。D-51）
  it.each(['/', '/furniture/', '/allocation/', '/swaps/'])(
    '先読みの表にない画面（%s。振り分けに関わり版を先に読む画面と、T16 のダッシュボード）は記録しない（localStorage に残らない）',
    async (url) => {
      vi.useFakeTimers();
      try {
        vi.stubGlobal('fetch', vi.fn(async () => new Response('[]')));
        start(url);
        await earlyAwareFetch('https://db.example.test/rest/v1/years?select=id,allocation_version', { method: 'GET' });
        await earlyAwareFetch('https://db.example.test/rest/v1/allocations?select=*', { method: 'GET' });
        await vi.advanceTimersByTimeAsync(0);
        settleEarlyLoad(U1, buildMembership(sources[U1]!, null));
        await vi.advanceTimersByTimeAsync(RECORD_SETTLE_MS);
        expect(window.localStorage.getItem(`${hintKey(U1)}:requests`)).toBeNull();
      } finally {
        vi.useRealTimers();
        vi.unstubAllGlobals();
      }
    },
  );

  it('覚え終えたら、残りの先送りの応答を捨てる（後で移った画面に渡さない）', async () => {
    vi.useFakeTimers();
    try {
      vi.stubGlobal('fetch', vi.fn(async () => new Response('[]')));
      start();
      const w = window as unknown as Record<string, unknown>;
      w[EARLY_GLOBAL] = { t: 't', at: Date.now(), p: window.location.pathname, r: {} };
      await vi.advanceTimersByTimeAsync(0);
      settleEarlyLoad(U1, buildMembership(sources[U1]!, null));
      expect(w[EARLY_GLOBAL]).toBeDefined();
      await vi.advanceTimersByTimeAsync(RECORD_SETTLE_MS);
      expect(w[EARLY_GLOBAL]).toBeUndefined();
    } finally {
      vi.useRealTimers();
      vi.unstubAllGlobals();
    }
  });

  it('覚える前にログアウトしたら（discardEarlyLoad）覚えない', async () => {
    vi.useFakeTimers();
    try {
      vi.stubGlobal('fetch', vi.fn(async () => new Response('[]')));
      start();
      await send();
      await vi.advanceTimersByTimeAsync(0);
      settleEarlyLoad(U1, buildMembership(sources[U1]!, null));
      discardEarlyLoad();
      await vi.advanceTimersByTimeAsync(RECORD_SETTLE_MS);
      expect(window.localStorage.getItem(`${hintKey(U1)}:requests`)).toBeNull();
    } finally {
      vi.useRealTimers();
      vi.unstubAllGlobals();
    }
  });
});
