// HTML の中の小さな script で、Supabase への読み込みを JS より先に送る（D-45、画面の設計 2.2。T14）。
//
// スマホの 4G・遅い CPU では、ページの JS（約 330 KB）を読んで動かし始めるまでに 1 秒ほどかかり、Supabase への最初の
// リクエストはその後になる。そこで、
//   1. 記録：ページを開いたときにアプリが Supabase に送った読み取り（GET の /rest/v1/ と、引数のない accept_my_invitations）を、
//      版を使わない画面（/stock・/request・/my。lib/data/screen-queries.ts の EARLY_FETCH_PATHS。許可リスト）のパスごとに localStorage の `gaapp:prefetch:<user_id>:requests` に覚える（URL・応答を変えるヘッダーだけ。
//      トークンは覚えない）。URL の中のページのクエリ（room・group など）の値は {{room}} のように置き換えて覚える
//      （別の部屋の QR から開いても使えるように）。
//   2. 先送り：次にそのパスを開いたとき、<head> の script（earlyFetchScript）が、localStorage のセッションのトークン（期限内の
//      ときだけ）で同じリクエストを送り、応答の Promise を window.__gaappEarly に置く。
//   3. 受け取り：supabase-js の fetch（earlyAwareFetch）が、同じリクエスト（メソッド・URL・応答を変えるヘッダー・本文、
//      同じトークン）を送ろうとしたら、送らずに先送りの応答を返す（1つの応答は1回だけ使う）。
// 先送りの応答は、ページを開いてから EARLY_TTL_MS の間と、書き込み（先送りできるもの以外のリクエスト）を送るまでと、
// 開いた画面にいる間（SPA の画面移動でパスが変われば捨てる）だけ使う。
// 振り分けに関わる画面（/furniture・/allocation・/swaps。T16 より前は / も）は記録も先送りもしない。スナップショット（lib/data/snapshot.ts）は
// 年度の行（版）を読み終えてから残りを読む決まり（D-33）で、先送りすると版とデータが同時に読まれ、新しい版に古いデータを組み合わせてしまうため。
// ダッシュボード（/。T16）は版を使わないが、T16 では許可リストに入れない（団体代表の / の 4G の速さを計ってから決める。D-51）。
// 読める範囲は今までどおり RLS が決める（同じトークンで同じリクエストを送るだけ）。送り先は Supabase の URL の /rest/v1/ だけ。
// 覚えたものは先読みの id と同じ扱い（lib/boot/early-load.ts。手動のログアウトでその人の分、別の人のログインで前の人の分を消す）。
import { SUPABASE_URL } from '@/lib/env';

export const EARLY_GLOBAL = '__gaappEarly';
/** 先送りの応答を使う時間（ページを開いてから） */
export const EARLY_TTL_MS = 15_000;
/** 1つのパスで覚える数 */
export const MAX_RECORDED = 24;
/** 覚えるパスの数（新しいものから） */
export const MAX_PATHS = 8;
/** 応答を変えるヘッダー（これだけを覚え、照らし合わせる） */
export const SIGNIFICANT_HEADERS = ['accept', 'accept-profile', 'content-profile', 'content-type', 'prefer', 'range'] as const;
/** 先送りしてよい POST（引数のない、何度呼んでも同じ RPC） */
export const EARLY_POSTS = ['/rest/v1/rpc/accept_my_invitations'] as const;
/** 置き換えるページのクエリの名前と、値の長さの下限（短い値は URL のほかの部分と取り違えやすい） */
const PARAM_NAME = /^[a-z_]{1,20}$/;
const PARAM_MIN = 8;

export interface RecordedRequest {
  /** メソッド */
  m: 'GET' | 'POST';
  /** Supabase の URL より後ろ（`/rest/v1/…`。ページのクエリの値は {{名前}}） */
  u: string;
  /** 応答を変えるヘッダー（小文字の名前の順） */
  h: Record<string, string>;
  /** POST の本文 */
  b?: string;
}

export interface RecordedRequests {
  /** パス（basePath と末尾の / を外したもの）→ 開いたときのリクエスト。新しく覚えたパスが先 */
  paths: Record<string, RecordedRequest[]>;
}

/** 照らし合わせのキー（script と同じ作り方。ヘッダーは名前の順） */
export function requestKey(method: string, path: string, headers: Record<string, string>, body?: string): string {
  const h = Object.keys(headers)
    .sort()
    .map((k) => `${k}=${headers[k]}`)
    .join('&');
  return `${method} ${path} ${h} ${body ?? ''}`;
}

/** fetch の引数から、応答を変えるヘッダーだけを小文字の名前で取り出す */
export function significantHeaders(headers: HeadersInit | undefined): Record<string, string> {
  const out: Record<string, string> = {};
  if (!headers) return out;
  const h = new Headers(headers);
  for (const name of SIGNIFICANT_HEADERS) {
    const v = h.get(name);
    if (v !== null) out[name] = v;
  }
  return out;
}

/** 先送りの対象か（Supabase の /rest/v1/ への GET と、決まった POST）。対象なら Supabase の URL より後ろを返す */
export function earlyPath(url: string, method: string, supabaseUrl: string = SUPABASE_URL): string | null {
  if (!supabaseUrl || !url.startsWith(`${supabaseUrl}/rest/v1/`)) return null;
  const path = url.slice(supabaseUrl.length);
  if (path.includes('..') || path.includes('{{')) return null;
  if (method === 'GET') return path;
  if (method === 'POST' && (EARLY_POSTS as readonly string[]).includes(path)) return path;
  return null;
}

/** ページのクエリの値（長いものだけ）を {{名前}} に置き換える */
export function templateOf(path: string, params: URLSearchParams): string {
  let out = path;
  for (const [name, value] of params) {
    if (!PARAM_NAME.test(name) || value.length < PARAM_MIN) continue;
    out = out.split(encodeURIComponent(value)).join(`{{${name}}}`);
  }
  return out;
}

// ---------------------------------------------------------------- 記録

interface Recorder {
  path: string;
  pathname: string;
  params: URLSearchParams;
  list: RecordedRequest[];
  seen: Set<string>;
  done: boolean;
}

let recorder: Recorder | null = null;

/** ページを開いたときに始める（startEarlyLoad）。path は normalizePath の形 */
export function startRecording(path: string, location: Pick<Location, 'pathname' | 'search'>): void {
  recorder = { path, pathname: location.pathname, params: new URLSearchParams(location.search), list: [], seen: new Set(), done: false };
}

function record(url: string, method: string, headers: Record<string, string>, body: string | undefined, pathname: string): void {
  const r = recorder;
  if (!r || r.done) return;
  if (pathname !== r.pathname || r.list.length >= MAX_RECORDED) {
    r.done = true; // 別の画面へ移った・多すぎる：ここまで
    return;
  }
  const path = earlyPath(url, method);
  if (!path) return;
  const entry: RecordedRequest = { m: method as 'GET' | 'POST', u: templateOf(path, r.params), h: headers };
  if (method === 'POST') entry.b = body ?? '';
  const key = requestKey(entry.m, entry.u, entry.h, entry.b);
  if (r.seen.has(key)) return;
  r.seen.add(key);
  r.list.push(entry);
}

export type RequestsStorage = Pick<Storage, 'getItem' | 'setItem'>;

export function requestsKey(userId: string, prefix: string): string {
  return `${prefix}${userId}:requests`;
}

/** 覚えたリクエストを読む（形が違えば null） */
export function readRecorded(key: string, storage: RequestsStorage | null): RecordedRequests | null {
  try {
    const v = JSON.parse(storage?.getItem(key) ?? 'null') as unknown;
    if (!v || typeof v !== 'object' || !('paths' in v)) return null;
    const paths = (v as { paths: unknown }).paths;
    if (!paths || typeof paths !== 'object' || Array.isArray(paths)) return null;
    return { paths: paths as Record<string, RecordedRequest[]> };
  } catch {
    return null;
  }
}

/**
 * 記録を終えて、そのパスの分を覚える（ほかのパスの分は残す。新しいものから MAX_PATHS まで）。覚えたら true。
 * use が偽（先読みの年度・団体が違った・ログインの人が違った）なら覚えない（違う年度のリクエストを次に先送りしないため）。
 * allowedPaths（先送りしてよい画面のパス）にないパスも覚えない（振り分けに関わる画面。上の説明）。前に覚えた分のうち
 * allowedPaths にないもの（許可リストを入れる前に覚えた /allocation など）は、ここで消す（使わないものを残さない）。
 */
export function finishRecording(key: string, use: boolean, storage: RequestsStorage | null, allowedPaths: readonly string[]): boolean {
  const r = recorder;
  if (!r) return false;
  r.done = true;
  recorder = null;
  if (!use || r.list.length === 0 || !storage || !allowedPaths.includes(r.path)) return false;
  try {
    const prev = readRecorded(key, storage)?.paths ?? {};
    const paths: Record<string, RecordedRequest[]> = { [r.path]: r.list };
    for (const [p, list] of Object.entries(prev)) {
      if (p !== r.path && allowedPaths.includes(p) && Object.keys(paths).length < MAX_PATHS) paths[p] = list;
    }
    storage.setItem(key, JSON.stringify({ paths }));
    return true;
  } catch {
    return false;
  }
}

/** 記録をやめる（覚えない） */
export function stopRecording(): void {
  recorder = null;
}

// ---------------------------------------------------------------- 受け取り

interface EarlyState {
  /** 先送りに使ったトークン */
  t: string;
  /** 先送りした時刻（ms） */
  at: number;
  /** 先送りしたページの location.pathname（画面を移ったら使わない） */
  p: string;
  /** キー → 応答（失敗なら null） */
  r: Record<string, Promise<Response | null>>;
}

function earlyState(): EarlyState | null {
  if (typeof window === 'undefined') return null;
  const v = (window as unknown as Record<string, unknown>)[EARLY_GLOBAL] as EarlyState | undefined;
  return v && typeof v === 'object' && typeof v.t === 'string' && typeof v.p === 'string' && v.r && typeof v.r === 'object' ? v : null;
}

/** 残りの先送りの応答を捨てる（書き込みを送った・ログアウトの状態になった・記録を終えた・画面を移った） */
export function dropEarlyResponses(): void {
  if (typeof window === 'undefined') return;
  delete (window as unknown as Record<string, unknown>)[EARLY_GLOBAL];
}

const trimSlash = (p: string) => p.replace(/\/+$/, '');

/** 先送りの応答のうち、このリクエストと同じものを取り出す（1回だけ）。なければ null */
export function takeEarlyResponse(url: string, init: RequestInit | undefined, now: number = Date.now()): Promise<Response | null> | null {
  const s = earlyState();
  if (!s) return null;
  if (now - s.at > EARLY_TTL_MS || trimSlash(window.location.pathname) !== trimSlash(s.p)) {
    // 時間を過ぎた・SPA の画面移動で別の画面になった（別の画面〔振り分けに関わる画面など〕に、開いた画面の応答を渡さない）
    dropEarlyResponses();
    return null;
  }
  const method = (init?.method ?? 'GET').toUpperCase();
  const path = earlyPath(url, method);
  if (!path) {
    // /rest/v1/ への書き込み（先送りできないもの）を送るなら、その後に古い応答を使わないように残りを捨てる
    // （Auth〔/auth/v1/〕のトークンの更新などは、トークンが変われば照らし合わない）
    if (SUPABASE_URL && url.startsWith(`${SUPABASE_URL}/rest/v1/`)) dropEarlyResponses();
    return null;
  }
  const auth = new Headers(init?.headers).get('authorization');
  if (auth !== `Bearer ${s.t}`) return null;
  const body = method === 'POST' ? (typeof init?.body === 'string' ? init.body : '') : undefined;
  const key = requestKey(method, path, significantHeaders(init?.headers), body);
  const hit = s.r[key];
  if (!hit) return null;
  delete s.r[key];
  return hit;
}

/**
 * supabase-js に渡す fetch。ページを開いたときのリクエストを記録し、先送りの応答があればそれを返す（なければ・失敗して
 * いれば、ふつうに送る）。
 */
export function earlyAwareFetch(input: RequestInfo | URL, init?: RequestInit): Promise<Response> {
  const url = typeof input === 'string' ? input : input instanceof URL ? input.href : input.url;
  const method = (init?.method ?? (typeof input === 'object' && 'method' in input ? input.method : 'GET')).toUpperCase();
  if (recorder && !recorder.done && typeof window !== 'undefined') {
    record(url, method, significantHeaders(init?.headers), typeof init?.body === 'string' ? init.body : undefined, window.location.pathname);
  }
  const early = takeEarlyResponse(url, { ...init, method });
  if (!early) return fetch(input, init);
  return early.then((res) => res ?? fetch(input, init));
}

// ---------------------------------------------------------------- <head> の script

export interface EarlyScriptConfig {
  /** Supabase の URL */
  u: string;
  /** publishable キー */
  a: string;
  /** セッションの localStorage のキー */
  k: string;
  /** 覚えたリクエストのキーの頭（`gaapp:prefetch:`。後ろに `<user_id>:requests`） */
  p: string;
  /** basePath */
  b: string;
  /** 先送りしてよい POST */
  post: readonly string[];
  /** 先送りしてよい画面のパス（basePath と末尾の / を外したもの。許可リスト。振り分けに関わる画面は入れない） */
  paths: readonly string[];
}

/**
 * <head> に置く script の中身（earlyFetch の本体と設定）。JS を読む前に動くので、ほかのモジュールに頼らない。
 * 例外はすべて飲み込む（先送りできなくても、アプリがふつうに送る）。
 */
export function earlyFetchScript(c: EarlyScriptConfig): string {
  // 本体に // のコメントはないので、改行と字下げを詰めてよい（HTML に入る量を減らす）
  const body = EARLY_FETCH_SOURCE.replace(/\n\s*/g, ' ');
  return `(${body})(${JSON.stringify(c).replace(/</g, '\\u003c')})`;
}

/** script の本体（テストで直接動かす。requestKey と同じキーを作る） */
export const EARLY_FETCH_SOURCE = `function (c) {
  try {
    var s = JSON.parse(localStorage.getItem(c.k) || 'null');
    if (!s || typeof s.access_token !== 'string' || !s.user || typeof s.user.id !== 'string') return;
    if (!(typeof s.expires_at === 'number' && s.expires_at * 1000 > Date.now() + 30000)) return;
    var rec = JSON.parse(localStorage.getItem(c.p + s.user.id + ':requests') || 'null');
    var path = location.pathname;
    if (c.b && (path === c.b || path.indexOf(c.b + '/') === 0)) path = path.slice(c.b.length);
    path = path.replace(/\\/+$/, '') || '/';
    if (!Array.isArray(c.paths) || c.paths.indexOf(path) < 0) return;
    var list = rec && rec.paths && Object.prototype.hasOwnProperty.call(rec.paths, path) ? rec.paths[path] : null;
    if (!Array.isArray(list)) return;
    var q = new URLSearchParams(location.search);
    var out = {};
    for (var i = 0; i < list.length && i < 24; i++) {
      var e = list[i];
      if (!e || typeof e.u !== 'string' || e.u.indexOf('/rest/v1/') !== 0 || e.u.indexOf('..') >= 0) continue;
      if (!(e.m === 'GET' || (e.m === 'POST' && c.post.indexOf(e.u) >= 0))) continue;
      var ok = true;
      var u = e.u.replace(/\\{\\{([a-z_]{1,20})\\}\\}/g, function (_, n) {
        var v = q.get(n);
        if (!v) { ok = false; return ''; }
        return encodeURIComponent(v);
      });
      if (!ok || u.indexOf('{{') >= 0) continue;
      var hs = e.h && typeof e.h === 'object' ? e.h : {};
      var names = Object.keys(hs).sort();
      var h = {};
      var hk = [];
      for (var j = 0; j < names.length; j++) {
        var name = names[j];
        if (typeof hs[name] !== 'string' || ['accept', 'accept-profile', 'content-profile', 'content-type', 'prefer', 'range'].indexOf(name) < 0) continue;
        h[name] = hs[name];
        hk.push(name + '=' + hs[name]);
      }
      h.apikey = c.a;
      h.authorization = 'Bearer ' + s.access_token;
      var body = e.m === 'POST' ? (typeof e.b === 'string' ? e.b : '') : undefined;
      var key = e.m + ' ' + u + ' ' + hk.join('&') + ' ' + (body === undefined ? '' : body);
      if (out[key]) continue;
      out[key] = fetch(c.u + u, { method: e.m, headers: h, body: body, credentials: 'omit' }).catch(function () { return null; });
    }
    window.__gaappEarly = { t: s.access_token, at: Date.now(), p: location.pathname, r: out };
  } catch (err) {}
}`;

/** テストだけで使う */
export function resetEarlyFetchForTest(): void {
  recorder = null;
  dropEarlyResponses();
}
