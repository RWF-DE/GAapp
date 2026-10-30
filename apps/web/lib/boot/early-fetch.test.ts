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
    expect(finishRecording(requestsKey(USER, PREFIX), true, storage)).toBe(true);
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
    window.localStorage.setItem(key, JSON.stringify({ paths: old }));
    window.history.replaceState(null, '', '/my/');
    startRecording('/my', window.location);
    await earlyAwareFetch(`${URL0}/rest/v1/groups?select=id`, { method: 'GET' });
    expect(finishRecording(key, false, window.localStorage)).toBe(false);
    expect(Object.keys(readRecorded(key, window.localStorage)!.paths)).toEqual(Object.keys(old));

    startRecording('/my', window.location);
    await earlyAwareFetch(`${URL0}/rest/v1/groups?select=id`, { method: 'GET' });
    expect(finishRecording(key, true, window.localStorage)).toBe(true);
    const paths = Object.keys(readRecorded(key, window.localStorage)!.paths);
    expect(paths[0]).toBe('/my');
    expect(paths).toHaveLength(MAX_PATHS);
  });
});

describe('先送りの応答の受け取り', () => {
  const setEarly = (r: Record<string, Promise<Response | null>>, at = Date.now()) => {
    win()[EARLY_GLOBAL] = { t: TOKEN, at, r };
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
  const config = { u: URL0, a: 'pk', k: 'sb-db-auth-token', p: PREFIX, b: '/GAapp', post: EARLY_POSTS };
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
    const state = win()[EARLY_GLOBAL] as { t: string; r: Record<string, unknown> };
    expect(state.t).toBe(TOKEN);
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
