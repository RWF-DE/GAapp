// 画面を開くまでの先読み（D-45、画面の設計 2.2。T14）。
// スマホの 4G では、JS を読み終えてから Supabase へ「立場 → 年度のデータ → 画面のデータ」と順に往復すると 2 秒を超える。
// そこで、ページを開いたら（Providers の最初の描画で startEarlyLoad）すぐに、
//   1. 立場の読み込み（loadMembershipSource）を始め、AuthProvider が takeEarlyMembership でその結果を使う。
//   2. 前に開いた年度（と、その年度で代表を務める団体）の id を localStorage（`gaapp:prefetch:<user_id>`）から読み、
//      開いた画面（routes に渡した /stock・/request・/my。lib/data/screen-queries.ts の SCREEN_PREFETCH）のデータを
//      React Query のキャッシュに読み始める。画面の部品のモジュールは立場が届いて画面を描くまで読まれないので、先読みの
//      決め方はルートのレイアウトから読める軽いモジュールに置く。
// 立場が届いたら settleEarlyLoad で、開く年度・団体が同じ先読みだけを残し、違うものは消す（使わない）。
// 画面に出すのは今までどおり立場で開けると決まった後だけ（RequireAudience）。読める範囲は RLS が守る。
// 覚えた id は下書きと同じ扱い（設計 1.4）：手動のログアウトでその人の分、別の user_id でログインしたら自分以外の分を消す。
import type { FetchQueryOptions, QueryClient, QueryKey } from '@tanstack/react-query';
import { loadMembershipSource } from '@/lib/auth/load-membership';
import { myYears, type Membership, type MembershipSource } from '@/lib/auth/membership';
import { readSelectedYear } from '@/lib/auth/selected-year';
import { BASE_PATH } from '@/lib/env';
import { dropEarlyResponses, finishRecording, requestsKey, startRecording, stopRecording } from './early-fetch';
import { getSupabase, supabaseConfigError, type AppSupabaseClient } from '@/lib/supabase/client';

// ---- 覚えた id（ヒント） ----

export const PREFETCH_HINT_PREFIX = 'gaapp:prefetch:';

/** 覚える id：自分の年度ごとの団体代表の団体（立場と同じ並び）と、最新の年度 */
export interface PrefetchHint {
  latestYearId: string | null;
  /** 年度の id → その年度で代表を務める団体の id（名前 → id の順。立場の groups と同じ） */
  years: Record<string, string[]>;
}

export type HintStorage = Pick<Storage, 'getItem' | 'setItem' | 'removeItem' | 'key' | 'length'>;

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const MAX_YEARS = 50;
const MAX_GROUPS = 50;

function localStore(): HintStorage | null {
  try {
    return typeof window === 'undefined' ? null : window.localStorage;
  } catch {
    return null;
  }
}

export function hintKey(userId: string): string {
  return `${PREFETCH_HINT_PREFIX}${userId}`;
}

/** 立場の元から覚える id を作る（年度は myYears の順。団体は buildMembership と同じ並び） */
export function hintFromSource(source: MembershipSource): PrefetchHint {
  const years = myYears(source);
  const out: Record<string, string[]> = {};
  for (const y of years) {
    out[y.id] = source.groups
      .filter((g) => g.year_id === y.id)
      .sort((a, b) => a.name.localeCompare(b.name, 'ja') || a.id.localeCompare(b.id))
      .map((g) => g.id);
  }
  return { latestYearId: years[0]?.id ?? null, years: out };
}

/** 覚えた id を読む（形が違う・読めなければ null） */
export function readHint(userId: string, storage: HintStorage | null = localStore()): PrefetchHint | null {
  try {
    const raw = storage?.getItem(hintKey(userId));
    if (!raw) return null;
    const v = JSON.parse(raw) as unknown;
    if (!v || typeof v !== 'object') return null;
    const { latestYearId, years } = v as { latestYearId?: unknown; years?: unknown };
    if (latestYearId !== null && (typeof latestYearId !== 'string' || !UUID.test(latestYearId))) return null;
    if (!years || typeof years !== 'object' || Array.isArray(years)) return null;
    const entries = Object.entries(years as Record<string, unknown>);
    if (entries.length > MAX_YEARS) return null;
    const out: Record<string, string[]> = {};
    for (const [id, groups] of entries) {
      if (!UUID.test(id) || !Array.isArray(groups) || groups.length > MAX_GROUPS) return null;
      if (!groups.every((g): g is string => typeof g === 'string' && UUID.test(g))) return null;
      out[id] = groups;
    }
    return { latestYearId, years: out };
  } catch {
    return null;
  }
}

/** 覚える（書けなくても例外にしない） */
export function writeHint(userId: string, hint: PrefetchHint, storage: HintStorage | null = localStore()): void {
  try {
    storage?.setItem(hintKey(userId), JSON.stringify(hint));
  } catch {
    // 使えない Storage では覚えない（先読みしないだけ）
  }
}

function removeHints(storage: HintStorage | null, pick: (userId: string) => boolean): number {
  if (!storage) return 0;
  try {
    const keys: string[] = [];
    for (let i = 0; i < storage.length; i++) {
      const k = storage.key(i);
      // `gaapp:prefetch:<user_id>`（id）と `gaapp:prefetch:<user_id>:requests`（覚えたリクエスト。early-fetch.ts）
      if (k?.startsWith(PREFETCH_HINT_PREFIX) && pick(k.slice(PREFETCH_HINT_PREFIX.length).split(':')[0] ?? '')) keys.push(k);
    }
    for (const k of keys) storage.removeItem(k);
    return keys.length;
  } catch {
    return 0;
  }
}

/** ログアウトのとき（下書きと同じ。手動ならその人の分を消し、強制〔401・ほかのタブ〕なら残す）。消した数 */
export function hintsOnSignOut(kind: 'manual' | 'forced', userId: string | null, storage: HintStorage | null = localStore()): number {
  if (kind !== 'manual' || !userId) return 0;
  return removeHints(storage, (u) => u === userId);
}

/** ログインしたとき（user_id が決まったとき）：自分以外の分を消す。消した数 */
export function hintsOnSignIn(userId: string, storage: HintStorage | null = localStore()): number {
  return removeHints(storage, (u) => u !== userId);
}

/** 先読みする年度：そのタブで選んだ年度が覚えた年度にあればそれ、なければ覚えた最新の年度（buildMembership と同じ決め方） */
export function pickHintYear(hint: PrefetchHint, selectedYearId: string | null): string | null {
  if (selectedYearId && hint.years[selectedYearId]) return selectedYearId;
  return hint.latestYearId && hint.years[hint.latestYearId] ? hint.latestYearId : null;
}

// ---- 画面ごとの先読み ----

/** 先読みするクエリ（groupId があれば、その団体を開くときだけ使う） */
export interface PrefetchEntry {
  groupId?: string;
  // eslint-disable-next-line @typescript-eslint/no-explicit-any -- 画面ごとに型の違うクエリを並べる
  options: FetchQueryOptions<any, any, any, any>;
}

export interface RoutePrefetchContext {
  yearId: string;
  /** その年度で代表を務める団体（覚えた順） */
  groupIds: readonly string[];
  /** URL のクエリ（room・group） */
  params: URLSearchParams;
}

export type RoutePrefetcher = (ctx: RoutePrefetchContext) => PrefetchEntry[];

/** パスから basePath と末尾の / を外す（`/GAapp/stock/` → `/stock`） */
export function normalizePath(pathname: string, basePath: string = BASE_PATH): string {
  const b = basePath.replace(/\/+$/, '');
  let p = b && (pathname === b || pathname.startsWith(`${b}/`)) ? pathname.slice(b.length) : pathname;
  p = p.replace(/\/+$/, '');
  return p === '' ? '/' : p;
}

// ---- ページを開いたときの読み込み ----

interface EarlyEntry {
  yearId: string;
  groupId?: string;
  key: QueryKey;
}

interface Early {
  queryClient: QueryClient;
  supabase: AppSupabaseClient;
  storage: HintStorage | null;
  routes: Readonly<Record<string, RoutePrefetcher>>;
  /** getSession の後に決まる（ログインしていなければ null） */
  ready: Promise<{ userId: string; membership: Promise<MembershipSource> } | null>;
  userId: string | null;
  /** takeEarlyMembership で使った */
  taken: boolean;
  /** settleEarlyLoad・discardEarlyLoad の後（もう先読みしない） */
  settled: boolean;
  entries: EarlyEntry[];
}

let early: Early | null = null;

export interface StartEarlyLoadOptions {
  /** 画面のパス（normalizePath の形）→ 先読みするものの決め方 */
  routes?: Readonly<Record<string, RoutePrefetcher>>;
  supabase?: AppSupabaseClient;
  location?: Pick<Location, 'pathname' | 'search'>;
  storage?: HintStorage | null;
  selectedYear?: (userId: string) => string | null;
}

/**
 * ページを開いたときに1回だけ呼ぶ（Providers）。ログインしていれば立場の読み込みを始め、覚えた id があれば画面のデータも
 * 読み始める。プリレンダー（window がない）と設定の付け忘れでは何もしない。
 */
export function startEarlyLoad(queryClient: QueryClient, opts: StartEarlyLoadOptions = {}): void {
  if (early || typeof window === 'undefined' || (!opts.supabase && supabaseConfigError())) return;
  const supabase = opts.supabase ?? getSupabase();
  const location = opts.location ?? window.location;
  const storage = opts.storage === undefined ? localStore() : opts.storage;
  const selectedYear = opts.selectedYear ?? ((u: string) => readSelectedYear(u));
  const e: Early = {
    queryClient,
    supabase,
    storage,
    routes: opts.routes ?? {},
    ready: Promise.resolve(null),
    userId: null,
    taken: false,
    settled: false,
    entries: [],
  };
  early = e;
  // ページを開いたときに送るリクエストを覚え始める（次に開いたときに <head> の script が先に送る。early-fetch.ts）
  startRecording(normalizePath(location.pathname), location);
  e.ready = supabase.auth.getSession().then(
    ({ data }) => {
      const userId = data.session?.user.id ?? null;
      if (!userId || e.settled) return null;
      e.userId = userId;
      const membership = loadMembershipSource(supabase, userId);
      membership.catch(() => undefined); // 失敗は使う側（AuthProvider）が受け取る
      const hint = readHint(userId, storage);
      const yearId = hint ? pickHintYear(hint, selectedYear(userId)) : null;
      const prefetcher = e.routes[normalizePath(location.pathname)];
      if (hint && yearId && prefetcher) {
        const ctx = { yearId, groupIds: hint.years[yearId] ?? [], params: new URLSearchParams(location.search) };
        // 立場の読み込みのリクエストを先に送らせる。ブラウザは HTTP/1.1 では1つのホストへ同時に6本までなので、先読みが先に
        // 並ぶと立場の読み込み（画面を出す前に要る）が後ろで待つ。supabase-js は送る前に getSession を待ち、その順は
        // 呼んだ順なので、もう1回 getSession を待ってから先読みを始めれば、立場の読み込みが先に送られる
        void supabase.auth.getSession().then(
          () => prefetch(e, prefetcher, ctx),
          () => undefined,
        );
      }
      return { userId, membership };
    },
    () => null,
  );
}

function prefetch(e: Early, prefetcher: RoutePrefetcher, ctx: RoutePrefetchContext): void {
  if (e.settled) return;
  let list: PrefetchEntry[];
  try {
    list = prefetcher(ctx);
  } catch {
    return;
  }
  for (const entry of list) {
    e.entries.push({ yearId: ctx.yearId, groupId: entry.groupId, key: entry.options.queryKey });
    void e.queryClient.prefetchQuery(entry.options);
  }
}

/**
 * AuthProvider の最初の立場の読み込みで使う。ページを開いたときに始めた読み込みがあればその結果（ログインしている人が違えば
 * 先読みを捨てて読み直す）、なければ null（ふつうに読む）。1回だけ使える。
 */
export function takeEarlyMembership(userId: string): Promise<MembershipSource> | null {
  const e = early;
  if (!e || e.taken) return null;
  e.taken = true;
  return e.ready.then((r) => {
    if (r && r.userId === userId) return r.membership;
    discard(e);
    return loadMembershipSource(e.supabase, userId);
  });
}

/**
 * 立場が届いたら呼ぶ。先読みのうち、同じ利用者で、開く年度（と団体）が同じものだけを残し、ほかはキャッシュから消す。
 * 残した数と消した数を返す。2回目からは何もしない。
 */
export function settleEarlyLoad(userId: string, membership: Membership): { kept: number; removed: number } {
  const e = early;
  if (!e || e.settled) return { kept: 0, removed: 0 };
  e.settled = true;
  let kept = 0;
  let removed = 0;
  for (const entry of e.entries) {
    const same =
      e.userId === userId &&
      membership.year?.id === entry.yearId &&
      (entry.groupId === undefined || membership.groups.some((g) => g.id === entry.groupId));
    if (same) kept++;
    else {
      e.queryClient.removeQueries({ queryKey: entry.key, exact: true });
      removed++;
    }
  }
  e.entries = [];
  // 開いた画面が描いた後のリクエスト（前年の数など）も入るように、少し待ってから覚える。先読みが違っていた（年度・団体が
  // 変わった）ときは覚えない
  const storage = e.storage;
  const use = removed === 0 && e.userId === userId;
  setTimeout(() => finishRecording(requestsKey(userId, PREFETCH_HINT_PREFIX), use, storage), RECORD_SETTLE_MS);
  return { kept, removed };
}

/** 立場が届いてから、覚えるリクエストを集める時間 */
export const RECORD_SETTLE_MS = 2000;

/**
 * 立場が届いたとき（最初の読み込み。描画の前）に、開く画面のデータを読み始める（覚えた id がなかった・違ったときに、描画を
 * 待たずに読み始めるため。立場で決まった年度・団体なので、後で消すことはない）。覚えた id の先読みと同じクエリは
 * React Query がまとめる（読み直さない）。startEarlyLoad の前（テストなど）は何もしない。読み始めた数を返す。
 */
export function prefetchOpenedScreen(membership: Membership, location: Pick<Location, 'pathname' | 'search'> = window.location): number {
  const e = early;
  if (!e || !membership.year) return 0;
  const prefetcher = e.routes[normalizePath(location.pathname)];
  if (!prefetcher) return 0;
  let list: PrefetchEntry[];
  try {
    list = prefetcher({ yearId: membership.year.id, groupIds: membership.groups.map((g) => g.id), params: new URLSearchParams(location.search) });
  } catch {
    return 0;
  }
  for (const entry of list) void e.queryClient.prefetchQuery(entry.options);
  return list.length;
}

/** ログアウトの状態になった・利用者が違うとき：先読みをすべて消す */
export function discardEarlyLoad(): number {
  return early ? discard(early) : 0;
}

function discard(e: Early): number {
  e.settled = true;
  e.taken = true;
  stopRecording();
  dropEarlyResponses();
  const n = e.entries.length;
  for (const entry of e.entries) e.queryClient.removeQueries({ queryKey: entry.key, exact: true });
  e.entries = [];
  return n;
}

/** テストだけで使う：ページを開き直したことにする */
export function resetEarlyLoadForTest(): void {
  early = null;
}
