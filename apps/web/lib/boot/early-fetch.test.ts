// @vitest-environment jsdom
// HTML の中の script で Supabase への読み取りを先に送る（D-45）：記録・照らし合わせ・<head> の script の本体
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  EARLY_FETCH_SOURCE,
  EARLY_GLOBAL,
  EARLY_POSTS,
  EARLY_TTL_MS,
  earlyAwareFetch,
  earlyFetchScript,
  earlyPath,
  finishRecording,
  MAX_PATHS,
  MAX_RECORDED,
  readRecorded,
  requestKey,
  requestsKey,
  resetEarlyFetchForTest,
  significantHeaders,
  startRecording,
  takeEarlyResponse,
  templateOf,
  type RecordedRequest,
} from './early-fetch';

vi.mock('@/lib/env', () => ({ SUPABASE_URL: 'https://db.example.test', SUPABASE_PUBLISHABLE_KEY: 'pk', BASE_PATH: '' }));

const URL0 = 'https://db.example.test';
const ROOM = '11111111-2222-4333-8444-555555555555';
const USER = '00000000-0000-4000-8000-000000000002';
const TOKEN = 'token-1';
const PREFIX = 'gaapp:prefetch:';
/** 先送りしてよい画面（lib/data/screen-queries.ts の EARLY_FETCH_PATHS のうち T14 の3つと、T16 で足したダッシュボード〔/〕。D-45・D-51） */
const PATHS = ['/', '/stock', '/request', '/my'];
/** 記録・先送りしないパス：振り分けに関わる画面（/furniture・/allocation・/swaps。スナップショットで版を先に読む。D-33） */
const SNAPSHOT_PATHS = ['/furniture', '/allocation', '/swaps'];

const win = () => window as unknown as Record<string, unknown>;

beforeEach(() => {
  resetEarlyFetchForTest();
  window.localStorage.clear();
});
afterEach(() => {
  vi.unstubAllGlobals();
  resetEarlyFetchForTest();
});

describe('先送りの対象とキー', () => {
  it('Supabase の /rest/v1/ への GET と、決まった POST だけ（Auth・ほかの POST・ほかのホストは対象外）', () => {
    expect(earlyPath(`${URL0}/rest/v1/items?select=id`, 'GET')).toBe('/rest/v1/items?select=id');
    expect(earlyPath(`${URL0}/rest/v1/rpc/accept_my_invitations`, 'POST')).toBe('/rest/v1/rpc/accept_my_invitations');
    expect(earlyPath(`${URL0}/rest/v1/rpc/submit_requests`, 'POST')).toBeNull();
    expect(earlyPath(`${URL0}/rest/v1/stocks`, 'PATCH')).toBeNull();
    expect(earlyPath(`${URL0}/auth/v1/token?grant_type=refresh_token`, 'POST')).toBeNull();
    expect(earlyPath('https://evil.example/rest/v1/items', 'GET')).toBeNull();
    expect(earlyPath(`${URL0}/rest/v1/../auth/v1/user`, 'GET')).toBeNull();
  });

  it('応答を変えるヘッダーだけを小文字で取り出し、キーはヘッダーの名前の順', () => {
    const h = significantHeaders(new Headers({ Accept: 'application/json', Authorization: 'Bearer x', 'X-Client-Info': 'a', Prefer: 'count=exact' }));
    expect(h).toEqual({ accept: 'application/json', prefer: 'count=exact' });
    expect(requestKey('GET', '/rest/v1/a', { prefer: 'p', accept: 'a' })).toBe(requestKey('GET', '/rest/v1/a', { accept: 'a', prefer: 'p' }));
    expect(requestKey('POST', '/rest/v1/rpc/x', {}, '{}')).not.toBe(requestKey('POST', '/rest/v1/rpc/x', {}, ''));
  });

  it('ページのクエリの値（8 文字以上）を {{名前}} に置き換える', () => {
    const p = new URLSearchParams({ room: ROOM, x: 'short' });
    expect(templateOf(`/rest/v1/stocks?room_id=eq.${ROOM}&x=eq.short`, p)).toBe('/rest/v1/stocks?room_id=eq.{{room}}&x=eq.short');
  });
});

describe('記録', () => {
  const fetchOk = () => vi.fn(async () => new Response('[]', { status: 200 }));

  it('開いたときの GET と accept_my_invitations を覚え、部屋の id は置き換える。書き込み・別の画面へ移った後は覚えない', async () => {
    vi.stubGlobal('fetch', fetchOk());
    window.history.replaceState(null, '', `/stock/?room=${ROOM}`);
    startRecording('/stock', window.location);
    await earlyAwareFetch(`${URL0}/rest/v1/stocks?room_id=eq.${ROOM}`, { method: 'GET', headers: { Accept: 'application/json', Authorization: 'Bearer t' } });
    await earlyAwareFetch(`${URL0}/rest/v1/rpc/accept_my_invitations`, { method: 'POST', body: '{}', headers: { 'Content-Type': 'application/json' } });
    await earlyAwareFetch(`${URL0}/rest/v1/stocks`, { method: 'POST', body: '[]' });
    await earlyAwareFetch(`${URL0}/rest/v1/stocks?room_id=eq.${ROOM}`, { method: 'GET', headers: { Accept: 'application/json' } }); // 同じものは1回
    window.history.replaceState(null, '', '/stocks/');
    await earlyAwareFetch(`${URL0}/rest/v1/items?select=id`, { method: 'GET' });
    const storage = window.localStorage;
    expect(finishRecording(requestsKey(USER, PREFIX), true, storage, PATHS)).toBe(true);
    expect(readRecorded(requestsKey(USER, PREFIX), storage)?.paths['/stock']).toEqual<RecordedRequest[]>([
      { m: 'GET', u: '/rest/v1/stocks?room_id=eq.{{room}}', h: { accept: 'application/json' } },
      { m: 'POST', u: '/rest/v1/rpc/accept_my_invitations', h: { 'content-type': 'application/json' }, b: '{}' },
    ]);
  });

  it('先読みが違っていたとき（use が偽）は覚えない。ほかのパスの分は残し、新しいパスを先にして MAX_PATHS まで', async () => {
    vi.stubGlobal('fetch', fetchOk());
    const key = requestsKey(USER, PREFIX);
    const old: Record<string, RecordedRequest[]> = {};
    for (let i = 0; i < MAX_PATHS; i++) old[`/p${i}`] = [{ m: 'GET', u: `/rest/v1/t${i}`, h: {} }];
    // 先送りしてよい画面が MAX_PATHS より多いときの上限を確かめる（いまの許可リスト〔EARLY_FETCH_PATHS〕は 8 つ）
    const allowed = [...PATHS, ...Object.keys(old)];
    window.localStorage.setItem(key, JSON.stringify({ paths: old }));
    window.history.replaceState(null, '', '/my/');
    startRecording('/my', window.location);
    await earlyAwareFetch(`${URL0}/rest/v1/groups?select=id`, { method: 'GET' });
    expect(finishRecording(key, false, window.localStorage, allowed)).toBe(false);
    expect(Object.keys(readRecorded(key, window.localStorage)!.paths)).toEqual(Object.keys(old));

    startRecording('/my', window.location);
    await earlyAwareFetch(`${URL0}/rest/v1/groups?select=id`, { method: 'GET' });
    expect(finishRecording(key, true, window.localStorage, allowed)).toBe(true);
    const paths = Object.keys(readRecorded(key, window.localStorage)!.paths);
    expect(paths[0]).toBe('/my');
    expect(paths).toHaveLength(MAX_PATHS);
  });

  it('前に覚えた分のうち、先送りしてよい画面にないパス（許可リストの前に覚えた /allocation など）は、次に覚えるときに消す', async () => {
    vi.stubGlobal('fetch', fetchOk());
    const key = requestsKey(USER, PREFIX);
    const entry = (u: string): RecordedRequest[] => [{ m: 'GET', u, h: {} }];
    window.localStorage.setItem(
      key,
      JSON.stringify({
        paths: {
          '/allocation': entry('/rest/v1/allocations?select=*'),
          '/stock': entry('/rest/v1/stocks?select=*'),
          '/furniture': entry('/rest/v1/years?select=id,allocation_version'),
          '/swaps': entry('/rest/v1/swaps?select=*'),
        },
      }),
    );
    window.history.replaceState(null, '', '/my/');
    startRecording('/my', window.location);
    await earlyAwareFetch(`${URL0}/rest/v1/groups?select=id`, { method: 'GET' });
    expect(finishRecording(key, true, window.localStorage, PATHS)).toBe(true);
    const paths = readRecorded(key, window.localStorage)!.paths;
    expect(Object.keys(paths)).toEqual(['/my', '/stock']);
    expect(paths['/stock']).toEqual(entry('/rest/v1/stocks?select=*'));
  });

  it('T16 ダッシュボード（/）は先送りしてよい画面：開いたときの読み取りを / として覚え（basePath の / も同じ）、次に / を開くと送る', async () => {
    vi.stubGlobal('fetch', fetchOk());
    const key = requestsKey(USER, PREFIX);
    window.history.replaceState(null, '', '/');
    startRecording('/', window.location);
    await earlyAwareFetch(`${URL0}/rest/v1/request_submissions?select=*&group_id=in.(g1)`, { method: 'GET', headers: { Accept: 'application/json' } });
    await earlyAwareFetch(`${URL0}/rest/v1/substitution_consents?select=*&group_id=in.(g1)`, { method: 'GET' });
    expect(finishRecording(key, true, window.localStorage, PATHS)).toBe(true);
    expect(readRecorded(key, window.localStorage)?.paths['/']).toEqual<RecordedRequest[]>([
      { m: 'GET', u: '/rest/v1/request_submissions?select=*&group_id=in.(g1)', h: { accept: 'application/json' } },
      { m: 'GET', u: '/rest/v1/substitution_consents?select=*&group_id=in.(g1)', h: {} },
    ]);
  });

  it.each(SNAPSHOT_PATHS)('先送りしてよい画面にないパス（%s。版を先に読む画面）は覚えない', async (path) => {
    vi.stubGlobal('fetch', fetchOk());
    const key = requestsKey(USER, PREFIX);
    window.history.replaceState(null, '', path);
    startRecording(path, window.location);
    await earlyAwareFetch(`${URL0}/rest/v1/years?select=id,allocation_version&id=eq.${ROOM}`, { method: 'GET' });
    await earlyAwareFetch(`${URL0}/rest/v1/allocations?select=*`, { method: 'GET' });
    expect(finishRecording(key, true, window.localStorage, PATHS)).toBe(false);
    expect(window.localStorage.getItem(key)).toBeNull();
  });
});

describe('先送りの応答の受け取り', () => {
  const setEarly = (r: Record<string, Promise<Response | null>>, at = Date.now()) => {
    win()[EARLY_GLOBAL] = { t: TOKEN, at, p: window.location.pathname, r };
  };
  const auth = { Authorization: `Bearer ${TOKEN}`, Accept: 'application/json' };
  const key = requestKey('GET', '/rest/v1/items?select=id', { accept: 'application/json' });

  it('同じリクエスト・同じトークンなら送らずに先送りの応答を返す（1回だけ）', async () => {
    const real = vi.fn(async () => new Response('"real"'));
    vi.stubGlobal('fetch', real);
    setEarly({ [key]: Promise.resolve(new Response('"early"')) });
    const res = await earlyAwareFetch(`${URL0}/rest/v1/items?select=id`, { method: 'GET', headers: auth });
    expect(await res.json()).toBe('early');
    expect(real).not.toHaveBeenCalled();
    const again = await earlyAwareFetch(`${URL0}/rest/v1/items?select=id`, { method: 'GET', headers: auth });
    expect(await again.json()).toBe('real');
  });

  it('トークンが違う（更新された・別の人）・ヘッダーが違う・時間を過ぎたときは使わない', () => {
    setEarly({ [key]: Promise.resolve(new Response('1')) });
    expect(takeEarlyResponse(`${URL0}/rest/v1/items?select=id`, { headers: { ...auth, Authorization: 'Bearer other' } })).toBeNull();
    expect(takeEarlyResponse(`${URL0}/rest/v1/items?select=id`, { headers: { Authorization: `Bearer ${TOKEN}` } })).toBeNull();
    setEarly({ [key]: Promise.resolve(new Response('1')) }, Date.now() - EARLY_TTL_MS - 1);
    expect(takeEarlyResponse(`${URL0}/rest/v1/items?select=id`, { headers: auth })).toBeNull();
    expect(win()[EARLY_GLOBAL]).toBeUndefined();
  });

  it('書き込みを送ったら、残りの先送りの応答は使わない（古い読み取りを返さない）', () => {
    setEarly({ [key]: Promise.resolve(new Response('1')) });
    expect(takeEarlyResponse(`${URL0}/rest/v1/stocks`, { method: 'POST', headers: auth })).toBeNull();
    expect(takeEarlyResponse(`${URL0}/rest/v1/items?select=id`, { headers: auth })).toBeNull();
  });

  it('SPA の画面移動でパスが変わったら使わず、残りも捨てる（振り分けの画面の版の読み取りに、開いた画面の応答を渡さない）', () => {
    window.history.replaceState(null, '', `/stock/?room=${ROOM}`);
    const years = requestKey('GET', '/rest/v1/years?select=id,allocation_version', { accept: 'application/json' });
    setEarly({ [key]: Promise.resolve(new Response('1')), [years]: Promise.resolve(new Response('1')) });
    window.history.replaceState(null, '', '/stock'); // 末尾の / だけの違いは同じ画面
    expect(takeEarlyResponse(`${URL0}/rest/v1/items?select=id`, { headers: auth })).not.toBeNull();
    window.history.replaceState(null, '', '/');
    expect(takeEarlyResponse(`${URL0}/rest/v1/years?select=id,allocation_version`, { headers: auth })).toBeNull();
    expect(win()[EARLY_GLOBAL]).toBeUndefined();
  });

  it('先送りが失敗していた（null）ときは、ふつうに送る', async () => {
    const real = vi.fn(async () => new Response('"real"'));
    vi.stubGlobal('fetch', real);
    setEarly({ [key]: Promise.resolve(null) });
    const res = await earlyAwareFetch(`${URL0}/rest/v1/items?select=id`, { method: 'GET', headers: auth });
    expect(await res.json()).toBe('real');
    expect(real).toHaveBeenCalledTimes(1);
  });
});

describe('<head> の script（EARLY_FETCH_SOURCE）', () => {
  const config = { u: URL0, a: 'pk', k: 'sb-db-auth-token', p: PREFIX, b: '/GAapp', post: EARLY_POSTS, paths: PATHS };
  const run = () => (0, eval)(`(${EARLY_FETCH_SOURCE})`)(config);
  const session = (expiresInSec: number) =>
    window.localStorage.setItem(
      config.k,
      JSON.stringify({ access_token: TOKEN, expires_at: Math.floor(Date.now() / 1000) + expiresInSec, user: { id: USER } }),
    );
  const recorded: RecordedRequest[] = [
    { m: 'GET', u: '/rest/v1/profiles?select=display_name', h: { accept: 'application/json' } },
    { m: 'GET', u: '/rest/v1/stocks?room_id=eq.{{room}}', h: {} },
    { m: 'POST', u: '/rest/v1/rpc/accept_my_invitations', h: { 'content-type': 'application/json' }, b: '{}' },
    { m: 'POST', u: '/rest/v1/rpc/submit_requests', h: {}, b: '{}' }, // 決まった POST でない
    { m: 'GET', u: 'https://evil.example/x', h: {} }, // /rest/v1/ でない
    { m: 'GET', u: '/rest/v1/requests?group_id=eq.{{group}}', h: {} }, // ページに group がない
  ];

  it('覚えたリクエストを、ページのクエリを当てて送り、アプリと同じキーで置く（basePath を外したパスで引く）', async () => {
    const sent: { url: string; init: RequestInit }[] = [];
    vi.stubGlobal(
      'fetch',
      vi.fn(async (url: string, init: RequestInit) => {
        sent.push({ url, init });
        return new Response('[]');
      }),
    );
    session(3600);
    window.localStorage.setItem(`${PREFIX}${USER}:requests`, JSON.stringify({ paths: { '/stock': recorded } }));
    window.history.replaceState(null, '', `/GAapp/stock/?room=${ROOM}`);
    run();
    expect(sent.map((s) => `${s.init.method} ${s.url}`)).toEqual([
      `GET ${URL0}/rest/v1/profiles?select=display_name`,
      `GET ${URL0}/rest/v1/stocks?room_id=eq.${ROOM}`,
      `POST ${URL0}/rest/v1/rpc/accept_my_invitations`,
    ]);
    expect(sent[0]!.init.headers).toMatchObject({ apikey: 'pk', authorization: `Bearer ${TOKEN}`, accept: 'application/json' });
    const state = win()[EARLY_GLOBAL] as { t: string; p: string; r: Record<string, unknown> };
    expect(state.t).toBe(TOKEN);
    expect(state.p).toBe('/GAapp/stock/');
    expect(Object.keys(state.r).sort()).toEqual(
      [
        requestKey('GET', '/rest/v1/profiles?select=display_name', { accept: 'application/json' }),
        requestKey('GET', `/rest/v1/stocks?room_id=eq.${ROOM}`, {}),
        requestKey('POST', '/rest/v1/rpc/accept_my_invitations', { 'content-type': 'application/json' }, '{}'),
      ].sort(),
    );
    // アプリ（supabase-js）の同じリクエストが受け取れる
    const hit = takeEarlyResponse(`${URL0}/rest/v1/stocks?room_id=eq.${ROOM}`, { method: 'GET', headers: { Authorization: `Bearer ${TOKEN}` } });
    expect(hit).not.toBeNull();
  });

  it('ログインしていない・トークンの期限が近い・覚えたものがないときは何も送らない', () => {
    const f = vi.fn();
    vi.stubGlobal('fetch', f);
    window.history.replaceState(null, '', '/stock/');
    run();
    session(10);
    window.localStorage.setItem(`${PREFIX}${USER}:requests`, JSON.stringify({ paths: { '/stock': recorded } }));
    run();
    session(3600);
    window.localStorage.removeItem(`${PREFIX}${USER}:requests`);
    run();
    window.localStorage.setItem(`${PREFIX}${USER}:requests`, '{broken');
    run();
    expect(f).not.toHaveBeenCalled();
    expect(win()[EARLY_GLOBAL]).toBeUndefined();
  });

  it.each(SNAPSHOT_PATHS)('覚えたものが localStorage にあっても、先送りしてよい画面にないパス（%s）では何も送らない', (path) => {
    const f = vi.fn(async () => new Response('[]'));
    vi.stubGlobal('fetch', f);
    session(3600);
    const snapshot: RecordedRequest[] = [
      { m: 'GET', u: '/rest/v1/years?select=id,allocation_version', h: { accept: 'application/vnd.pgrst.object+json' } },
      { m: 'GET', u: '/rest/v1/allocations?select=*', h: {} },
    ];
    window.localStorage.setItem(`${PREFIX}${USER}:requests`, JSON.stringify({ paths: { [path]: snapshot, '/stock': recorded } }));
    window.history.replaceState(null, '', `/GAapp${path}/`);
    run();
    (0, eval)(earlyFetchScript(config));
    expect(f).not.toHaveBeenCalled();
    expect(win()[EARLY_GLOBAL]).toBeUndefined();
    // 設定のリストがない（古い形）ときも送らない
    window.history.replaceState(null, '', `/GAapp/stock/?room=${ROOM}`);
    (0, eval)(`(${EARLY_FETCH_SOURCE})`)({ ...config, paths: undefined });
    expect(f).not.toHaveBeenCalled();
  });

  it('T16 ダッシュボード（/GAapp/ と /GAapp）では、/ として覚えたものを送る（ほかのパスの分は送らない）', () => {
    const f = vi.fn(async () => new Response('[]'));
    vi.stubGlobal('fetch', f);
    session(3600);
    const home: RecordedRequest[] = [
      { m: 'POST', u: '/rest/v1/rpc/accept_my_invitations', h: { 'content-type': 'application/json' }, b: '{}' },
      { m: 'GET', u: '/rest/v1/request_submissions?select=*&group_id=in.(g1)', h: {} },
    ];
    window.localStorage.setItem(`${PREFIX}${USER}:requests`, JSON.stringify({ paths: { '/': home, '/stock': recorded } }));
    for (const url of ['/GAapp/', '/GAapp']) {
      f.mockClear();
      window.history.replaceState(null, '', url);
      run();
      expect(f.mock.calls.map((c) => (c as unknown[])[0]), url).toEqual([`${URL0}/rest/v1/rpc/accept_my_invitations`, `${URL0}/rest/v1/request_submissions?select=*&group_id=in.(g1)`]);
    }
  });

  it('earlyFetchScript（改行を詰めた本体と設定）も同じように動く', () => {
    const f = vi.fn(async () => new Response('[]'));
    vi.stubGlobal('fetch', f);
    session(3600);
    window.localStorage.setItem(`${PREFIX}${USER}:requests`, JSON.stringify({ paths: { '/stock': recorded } }));
    window.history.replaceState(null, '', `/GAapp/stock/?room=${ROOM}`);
    (0, eval)(earlyFetchScript(config));
    expect(f).toHaveBeenCalledTimes(3);
  });

  it('earlyFetchScript は設定を埋め込み、</script> を閉じられない形にする', () => {
    const s = earlyFetchScript({ ...config, b: '</script><script>alert(1)</script>' });
    expect(s).not.toContain('</script>');
    expect(s.startsWith('(function (c)')).toBe(true);
  });
});

describe('覚える数の上限（MAX_RECORDED。FU3 の案 2）', () => {
  const config = { u: URL0, a: 'pk', k: 'sb-db-auth-token', p: PREFIX, b: '/GAapp', post: EARLY_POSTS, paths: PATHS };
  const run = () => (0, eval)(`(${EARLY_FETCH_SOURCE})`)(config);
  const session = () =>
    window.localStorage.setItem(config.k, JSON.stringify({ access_token: TOKEN, expires_at: Math.floor(Date.now() / 1000) + 3600, user: { id: USER } }));
  /** 別々の読み取り n 本（覚えた順に並ぶ） */
  const reads = (n: number) => Array.from({ length: n }, (_, i) => `/rest/v1/t${String(i).padStart(2, '0')}?select=id`);
  /**
   * 管理者で店長・副店長も務める人の / は、FU3 の案 3（総務の机椅子とテント等の読み取りをまとめる。今は 21 本）の前は、開いたときに
   * 29 本を送っていた（立場の5本〔accept_my_invitations を含む〕とダッシュボードの 24 本。FU3 の計測）。上限が 24 本だった間は後の5本
   * （シフト・作業の3本と、代表する団体の提出物・テント等の2本）を覚えず、2回目も <head> の script が先に送らなかった。前の上限（24 本）を
   * 超える数の確かめとして、この 29 本のまま確かめる
   */
  const ADMIN_REP_HOME = 29;

  it('前の上限（24 本）を超える 29 本（案 3 の前の管理者で団体代表の /）をすべて覚え、次に開いたときに <head> の script が 29 本とも先に送り、アプリは送らずに受け取る', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => new Response('[]')));
    const key = requestsKey(USER, PREFIX);
    const gets = reads(ADMIN_REP_HOME - 1);
    window.history.replaceState(null, '', '/GAapp/');
    startRecording('/', window.location);
    await earlyAwareFetch(`${URL0}/rest/v1/rpc/accept_my_invitations`, { method: 'POST', body: '{}', headers: { 'Content-Type': 'application/json' } });
    for (const u of gets) await earlyAwareFetch(`${URL0}${u}`, { method: 'GET', headers: { Accept: 'application/json' } });
    expect(finishRecording(key, true, window.localStorage, PATHS)).toBe(true);
    const list = readRecorded(key, window.localStorage)?.paths['/'] ?? [];
    expect(list).toHaveLength(ADMIN_REP_HOME);
    expect(list.at(-1)).toEqual<RecordedRequest>({ m: 'GET', u: gets.at(-1)!, h: { accept: 'application/json' } });

    // 次に開いたとき：<head> の script が覚えた 29 本をすべて送る
    const sent: string[] = [];
    vi.stubGlobal(
      'fetch',
      vi.fn(async (url: string) => {
        sent.push(url);
        return new Response('"early"');
      }),
    );
    session();
    run();
    expect(sent).toEqual([`${URL0}/rest/v1/rpc/accept_my_invitations`, ...gets.map((u) => `${URL0}${u}`)]);
    expect(Object.keys((win()[EARLY_GLOBAL] as { r: Record<string, unknown> }).r)).toHaveLength(ADMIN_REP_HOME);

    // アプリ（supabase-js）が送る 29 本目（前は覚えなかった分）も、送らずに先送りの応答を受け取る
    const app = vi.fn(async () => new Response('"app"'));
    vi.stubGlobal('fetch', app);
    const res = await earlyAwareFetch(`${URL0}${gets.at(-1)!}`, { method: 'GET', headers: { Authorization: `Bearer ${TOKEN}`, Accept: 'application/json' } });
    expect(await res.json()).toBe('early');
    expect(app).not.toHaveBeenCalled();
  });

  it('覚えるのは1つのパスで MAX_RECORDED 本まで。localStorage にそれより多く入っていても、<head> の script は MAX_RECORDED 本までしか送らない', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => new Response('[]')));
    const key = requestsKey(USER, PREFIX);
    window.history.replaceState(null, '', '/GAapp/');
    startRecording('/', window.location);
    for (const u of reads(MAX_RECORDED + 5)) await earlyAwareFetch(`${URL0}${u}`, { method: 'GET' });
    expect(finishRecording(key, true, window.localStorage, PATHS)).toBe(true);
    expect(readRecorded(key, window.localStorage)?.paths['/']?.map((e) => e.u)).toEqual(reads(MAX_RECORDED));

    const f = vi.fn(async () => new Response('[]'));
    vi.stubGlobal('fetch', f);
    session();
    const tooMany: RecordedRequest[] = reads(MAX_RECORDED + 12).map((u) => ({ m: 'GET', u, h: {} }));
    window.localStorage.setItem(key, JSON.stringify({ paths: { '/': tooMany } }));
    run();
    expect(f).toHaveBeenCalledTimes(MAX_RECORDED);
    // HTML に入る形（earlyFetchScript）も同じ数
    f.mockClear();
    (0, eval)(earlyFetchScript(config));
    expect(f).toHaveBeenCalledTimes(MAX_RECORDED);
  });
});
