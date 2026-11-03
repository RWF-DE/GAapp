// 4G での表示の速さ（00「性能と可用性」の「画面はスマホの 4G でも 2 秒以内に開く」。画面の設計 7.7。T14）。
// pnpm e2e:perf（E2E_PERF=1。CI では流さない。機械の速さで結果がぶれるため）。pnpm build:e2e の書き出し（apps/web/out）を使う。
// スマホで使う画面（/stock?room=…・/request・/my と、T16 で足した団体代表の /〔ダッシュボード。代表する団体のカードが出るまで〕）を、
// T20 で足した総務部門員の /〔机椅子とシフト・作業のカードが出るまで〕・/shift〔自分の枠と同じますの人の名前〕・/tasks〔作業と担当者の名前〕も、
// Chromium の CDP で回線を Fast 4G 相当（下り 9 Mbps・上り 1.5 Mbps・
// 遅延 170 ms。T00 と同じ）に絞り、CPU を 4 倍遅くして、キャッシュなしの新しいコンテキスト（storageState でログイン済み）で
// page.goto から画面の主な内容が見えるまでを3回ずつ計る。中央値と内訳を annotations・console・test-results/perf/perf.json に出し、
// notes/T14.md に写す。2 秒を超えても失敗にはしない（記録して原因を調べる。設計 7.7）。
//
// 配り方は2つ計る：
// - http1：E2E と同じ静的サーバー（serve。HTTP/1.1）。ブラウザは1つのホストに6本までしかつながないので、20 本ほどのチャンクが
//   列に並ぶ（本番より遅く出る）。
// - h2：この spec が立てる HTTP/2 の静的サーバー（TLS の自己署名。gzip）。本番の GitHub Pages と同じく1本の接続で多重化する。
//   ポートは E2E_PERF_H2_PORT（既定 3102）。openssl がなければ飛ばす。
// どちらも Supabase（ローカル。HTTP/1.1）への往復は同じ。本番の DNS・TCP・TLS の初回の往復はどちらにも入っていない。
// PERF_CPU_RATE で CPU の倍率を変えられる（原因を分けるとき。記録は既定の 4 倍で取る）。
// PERF_TRACE=1 で Supabase へのリクエストの並び（失敗したリクエストも）、PERF_TRACE=all で静的ファイルも並べて出す（1回目）。
// PERF_DEBUG=1 でページの console も並べる。
// 開き方は2つ計る（D-45）：
// - first：初めて開いた（先読みのために覚えた id〔localStorage の gaapp:prefetch:<user_id>〕がない）。
// - again：前に開いたことがある（同じ画面を一度開いて覚えた id とリクエストを、計る前のコンテキストの localStorage に入れる。
//   HTTP のキャッシュは使わない）。<head> の script が JS より先に Supabase へ送り、立場の読み込みと同時に画面のデータも読む。
// / は T16 で先読み・記録・先送りの表に入れた（D-45・D-51）ので、again では / も覚えたリクエストを <head> の script が先に送る。
// PERF_VISIT=first・again で片方だけ、PERF_ONLY=stock・request・my・home（カンマ区切り。名前は下の ALL_TARGETS の id）で画面を絞れる
// （原因を調べるとき）。
// データはシナリオの年度（合成データ r8like。受付中。部員と団体代表〔模擬店10〕のロール）。
// T19 で、団体代表の自団体の提出物（/document。スマホ。PERF_ONLY の document）を足した。その年度に提出物6つ（模擬店・部門・企業が対象。
// 飲食だけのものを含む）と、模擬店・部門の提出の状況（承認・承認待ち・差し戻し）を入れ、模擬店10 には PDF を2つ上げて計る（どの団体代表の
// / も提出物の読み取りが中身のある形になる）。Storage の物は計った後に Storage API で消す（cleanupDocumentsScenario）。
// T21 で、テント等の貸し出しのスマホの画面（部員の /lending/records と、団体代表の /request?tab=lending）を足した（PERF_ONLY の
// records・request-lending）。その年度に、模擬店・部門の申請・割り当て（確定）と、模擬店の半分の受け渡しの記録を入れて計る
// （どの団体代表の画面もテント等の読み取りが中身のある形になる）。
//
// FU3（T19〜T21 の後の片付けの PR B の計測の土台。notes/FU3.md の「計画」2.4、D-45・D-58）：
// - 総務部門長の /（部門長以上の読み取り）と、管理者で団体代表の /（管理者で、模擬店11 の店長も務める人。総務の欄に、お知らせと代表する
//   団体の欄も出る）を足した（PERF_ONLY の head-home・admin-home）。シナリオの年度に部門長と管理者のロールと、管理者の模擬店11 を足した。
// - ダッシュボード（総務部門員・総務部門長・管理者で団体代表の /）は、D-58 の枠の印（ヘッダー・立場の一覧・見出しと、その人に出す欄すべての
//   枠〔欄の見出しと、中身か読み込み中〕が見えた。frame）の時刻も、今までの印（全部の欄がそろった。そろう）と並べて出す。2 秒は枠の印で、
//   そろうは 3 秒の目安で見る（D-58）。管理者で団体代表の / は、代表する団体のカードが見えた時刻（card）も出す。団体代表の / は今の印
//   （代表する団体のカード）のまま。
// - PERF_AB=<書き出しのフォルダ>：2つの書き出しを交互に開いて比べる。PERF_AB のフォルダを A（ふつうは main の apps/web/out）、この checkout の
//   apps/web/out を B として、マス（配り方 × 開き方 × 画面）ごとに A と B を1回ずつ開いて1組にし、組の順を1組ごとに入れ替える（A → B、
//   B → A、…。support/perf.ts の pairOrder）。同じ組の2回には機械の負荷の揺れが同じように乗るので、組ごとの差（B − A。負なら B が速い）の
//   中央値と四分位で比べる（機械の速さが日によって 0.5 秒ほど違っても比べられる。2026-11-03 の基準の計測）。A の http1 は
//   playwright.config.ts が serve で E2E_PERF_AB_PORT（既定 3103）に、HTTP/2 はこの spec が E2E_PERF_AB_H2_PORT（既定 3104）に配る（B と同じ
//   作り。B は今までどおり E2E_PORT の serve と E2E_PERF_H2_PORT）。again の覚えたリクエストは、書き出しごとに覚え直す。
// - PERF_RUNS で1マスの回数を変えられる（既定 3。PERF_AB のときは組の数で、既定 12）。
// - 負荷（1 分の load average）：計り始める前に PERF_LOAD_WAIT（既定 1.0。0 なら待たない）を下回るまで待ち（最長 PERF_LOAD_WAIT_MAX 秒。
//   既定 600）、1回ごとと 5 秒ごとに読んで、最大が PERF_LOAD_MARK（既定 2.5）を超えたマスに印を付ける（perf.json の loadMax・loadOver）。
// - Playwright のトレースは perf のプロジェクトでは取らない（playwright.config.ts。全部のコンテキストを記録して、計る機械の負荷を上げて
//   いた）。PERF_TRACE（リクエストの並び）はそのまま使える。
// - 1回が止まったり失敗したり（30 秒待っても印が出ないなど）しても、その回を perf.json の errors に残して次へ進む（同じ書き出しがそのマスで
//   2回続けて失敗したら、そのマスの残りを飛ばす）。perf.json はマスを計り終えるたびに書き直す（止まっても、それまでの値が残る。done が偽なら
//   途中まで）。最後に、失敗した回があればテストを失敗にする（値は残したまま）。
import { execFileSync } from 'node:child_process';
import { existsSync, mkdirSync, readFileSync, statSync, writeFileSync } from 'node:fs';
import http2 from 'node:http2';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { gzipSync } from 'node:zlib';
import { expect, test, type Browser, type Page } from '@playwright/test';
import { storageStateFor, type StoredUser } from './support/auth';
import { createScenario, type Scenario } from './support/db';
import {
  apiToken,
  cleanupDocumentsScenario,
  insertDocuments,
  insertSubmissions,
  makePdf,
  tokyoDeadline,
  uploadFileAs,
  type SubmissionInput,
} from './support/documents';
import { confirmLending, insertLendingAssignments, insertLendingItems, insertLendingRecords, insertLendingRequests } from './support/lending';
import { orderEffects, pairedDiffs, pairOrder, poolDiffs, quantile, signed, summarize, type Build, type CellDiff, type Summary } from './support/perf';
import { insertShiftVolume } from './support/shifts';
import { MOBILE } from './support/shots';
import { SEED_USER_IDS } from './support/users';
import { pinYear } from './support/year';

/** 比べる書き出し（PERF_AB）のフォルダ。空なら交互にしない（この checkout の書き出しだけを計る） */
const AB_OUT = process.env.PERF_AB ? path.resolve(process.env.PERF_AB) : '';
/** 1マスの回数（PERF_AB のときは組の数） */
const RUNS = Number(process.env.PERF_RUNS ?? (AB_OUT ? 12 : 3));
const LIMIT_MS = 2000;
/** 全部の欄がそろうまでの目安（D-58。総務部門員・総務部門長・管理者で団体代表の /） */
const SETTLED_LIMIT_MS = 3000;
/** Fast 4G 相当（T00 と同じ）。throughput は bytes/秒 */
const FAST_4G = { offline: false, latency: 170, downloadThroughput: (9 * 1000 * 1000) / 8, uploadThroughput: (1.5 * 1000 * 1000) / 8 };
/** CPU を遅くする倍率（既定 4。原因を分けるときだけ PERF_CPU_RATE=1 などで変える） */
const CPU_RATE = Number(process.env.PERF_CPU_RATE ?? 4);
const REP_GROUP = '模擬店10';
/** 管理者が店長を務める団体（管理者で団体代表の /。FU3） */
const ADMIN_GROUP = '模擬店11';
const ROOM = '1-1';
const OUT_DIR = fileURLToPath(new URL('../apps/web/out/', import.meta.url));
/** E2E の serve（B の http1。playwright.config.ts の webServer と同じポート） */
const PORT = Number(process.env.E2E_PORT ?? 3100);
const H2_PORT = Number(process.env.E2E_PERF_H2_PORT ?? 3102);
/** A の http1（playwright.config.ts が PERF_AB のときだけ serve で配る）と HTTP/2 */
const AB_PORT = Number(process.env.E2E_PERF_AB_PORT ?? 3103);
const AB_H2_PORT = Number(process.env.E2E_PERF_AB_H2_PORT ?? 3104);
/** 計り始める前に、1 分の load average がこれを下回るまで待つ（0 なら待たない）。最長 LOAD_WAIT_MAX_S 秒 */
const LOAD_WAIT = Number(process.env.PERF_LOAD_WAIT ?? 1.0);
const LOAD_WAIT_MAX_S = Number(process.env.PERF_LOAD_WAIT_MAX ?? 600);
/** 計っている間の 1 分の load average の最大がこれを超えたマスに印を付ける */
const LOAD_MARK = Number(process.env.PERF_LOAD_MARK ?? 2.5);

/** ダッシュボード（/）の欄（PortalWidget の section の testid。代表する団体の欄は testid がないので rep） */
type Widget = 'portal-todos' | 'portal-dated' | 'portal-soumu-notices' | 'portal-notices' | 'rep' | 'portal-cards';
/** 総務（総務部門員・部門長以上）に出す欄（04「ダッシュボード」の欄と立場の表。components/portal/use-portal.ts の WIDGET_KINDS） */
const SOUMU_WIDGETS: readonly Widget[] = ['portal-todos', 'portal-dated', 'portal-soumu-notices', 'portal-cards'];
/** 総務で店長・副店長も務める人に出す欄（お知らせと代表する団体が加わる） */
const SOUMU_REP_WIDGETS: readonly Widget[] = ['portal-todos', 'portal-dated', 'portal-soumu-notices', 'portal-notices', 'rep', 'portal-cards'];

/** 主な印（shown）のほかに時刻を取る印 */
interface Mark {
  id: 'frame' | 'card';
  /** 出すときの名前 */
  label: string;
  /** ページの中で調べる関数（shown と同じ形） */
  shown: string;
  /** 2 秒などの上限（ms。超えたら ※ を付ける）。null は記録だけ */
  limit: number | null;
}

interface Target {
  /** PERF_ONLY で選ぶ名前 */
  id:
    | 'stock' | 'request' | 'my' | 'home'
    // 提出物（T19）：団体代表の /document
    | 'document'
    // シフト・作業（T20）：総務部門員の /・/shift・/tasks
    | 'soumu-home' | 'shift' | 'tasks'
    // テント等の貸し出し（T21）：部員の /lending/records・団体代表の /request?tab=lending
    | 'records' | 'request-lending'
    // FU3（D-58）：総務部門長の /・管理者で団体代表の /
    | 'head-home' | 'admin-home';
  name: string;
  user: StoredUser;
  /**
   * 開いたときのリクエストを覚える画面か（先読みの表〔lib/data/screen-queries.ts の EARLY_FETCH_PATHS〕にある画面）。
   * 偽なら again の準備で、覚えたリクエスト（`…:requests`）を待たない（今はどの対象も表にある。/ は T16 で入れた）
   */
  records: boolean;
  url: (s: Scenario) => string;
  /** 画面の主な内容が見えた（読み込みが終わった）ことの印（Playwright で確かめる） */
  ready: (page: Page) => Promise<void>;
  /**
   * 同じ印をページの中で確かめる関数（引数は { room, group, widgets }）。毎フレーム（requestAnimationFrame）調べて、最初に真になった
   * performance.now()（ナビゲーションの始まりから）を表示までの時間にする（D-45。expect の再試行の間隔〔100・250・500・1000 ms〕で
   * 測ると、見えてから気づくまでに最大 0.5 秒ほど遅れて出るため）。
   */
  shown: string;
  /** shown の名前と上限（既定は「表示」・2 秒。総務・部門長・管理者で団体代表の / は「そろう」・3 秒の目安。D-58） */
  label?: string;
  limit?: number;
  /** 印の関数に渡す団体（既定は REP_GROUP） */
  group?: string;
  /** ダッシュボードの、その人に出す欄（枠の印と、計った後の欄の並びの確かめに使う） */
  widgets?: readonly Widget[];
  /** ほかの印（枠・代表する団体のカード） */
  marks?: readonly Mark[];
}

/** ページの中の DOM を調べる関数の文字列（ルートの tsconfig は DOM の型を持たないので、文字列で渡す） */
const SHOWN = {
  stock: `(a) => {
    const name = document.querySelector('[data-testid="stock-room-name"]');
    const input = document.querySelector('input[aria-label="机(木)の数"]');
    return !!name && name.textContent.trim() === a.room && !!input && /^\\d+$/.test(input.value);
  }`,
  request: `(a) => {
    const name = document.querySelector('[data-testid="request-group-name"]');
    const button = [...document.querySelectorAll('button')].some((b) => b.textContent.includes('提出') && b.offsetParent !== null);
    return !!name && name.textContent.trim() === a.group && button;
  }`,
  my: `(a) => {
    const g = document.querySelector('[data-testid="my-group"]');
    const p = document.querySelector('[data-testid="my-in-progress"]');
    return !!g && g.textContent.includes(a.group) && !!p && p.textContent.includes('振り分け作業中');
  }`,
  home: `(a) => {
    const card = [...document.querySelectorAll('[data-testid="rep-card"]')].find((c) => c.getAttribute('data-group') === a.group);
    return !!card && card.offsetParent !== null;
  }`,
  // T19：自団体の提出物の団体名と、提出物のカード（最初の1枚）が出た
  document: `(a) => {
    const name = document.querySelector('[data-testid="document-group-name"]');
    const card = document.querySelector('[data-testid="document-card"]');
    return !!name && name.textContent.trim() === a.group && !!card && card.offsetParent !== null;
  }`,
  // シフト・作業（T20）：総務部門員の / は机椅子とシフト・作業のカードが出て、欄の読み込み中がない。/shift は自分の枠が出て、同じますの人の
  // 名前が読めている（表示名を並行に読むので、名前が届くまでを入れる）。/tasks は進み具合と作業が出て、担当者の名前が読めている
  soumuHome: `() => {
    const f = document.querySelector('[data-testid="module-card"][data-module="furniture"]');
    const s = document.querySelector('[data-testid="module-card"][data-module="shifts"]');
    return !!f && !!s && f.offsetParent !== null && s.offsetParent !== null && !document.querySelector('[data-testid="portal-loading"]');
  }`,
  shift: `() => {
    const items = document.querySelectorAll('[data-testid="my-shift-item"]');
    return items.length > 0 && [...document.querySelectorAll('[data-testid="my-shift-mates"]')].every((m) => !m.textContent.includes('名前を表示できません'));
  }`,
  tasks: `() => {
    const items = document.querySelectorAll('[data-testid="tasks-item"]');
    return items.length > 0 && !!document.querySelector('[data-testid="tasks-progress"]') &&
      [...document.querySelectorAll('[data-testid="tasks-item-assignee"]')].every((x) => !x.textContent.includes('名前を表示できません'));
  }`,
  // T21：受け渡し・返却の一覧に、団体代表の団体（割り当てのある団体）が出た
  records: `(a) => {
    const row = [...document.querySelectorAll('[data-testid="records-group"]')].find((r) => r.textContent.includes(a.group));
    return !!row && row.offsetParent !== null;
  }`,
  // T21：テント等のタブのパネル（団体名と、申請できる備品の ＋－）が出た
  requestLending: `(a) => {
    const panel = document.querySelector('[data-testid="lending-request"]');
    const item = document.querySelector('[data-testid="lending-request-item"]');
    return !!panel && panel.offsetParent !== null && panel.textContent.includes(a.group) && !!item;
  }`,
  // FU3（D-58）：管理者で団体代表の / のそろう。総務の / のそろうに、代表する団体のカード（a.group）が見えて、その欄の読み込み中がないことを足す
  adminHome: `(a) => {
    const f = document.querySelector('[data-testid="module-card"][data-module="furniture"]');
    const s = document.querySelector('[data-testid="module-card"][data-module="shifts"]');
    const card = [...document.querySelectorAll('[data-testid="rep-card"]')].find((c) => c.getAttribute('data-group') === a.group);
    return !!f && !!s && !!card && f.offsetParent !== null && s.offsetParent !== null && card.offsetParent !== null &&
      !document.querySelector('[data-testid="portal-loading"]') && !document.querySelector('[data-testid="rep-home-loading"]');
  }`,
  // FU3（D-58）の枠の印：ヘッダー（アプリの名前）・立場の一覧（今の年度と、立場が1つ以上）・見出し（h1）と、a.widgets の欄すべての枠
  // （欄の section が見えて、見出しの h2 と、その後に中身か読み込み中の骨組みがある）。代表する団体の欄は testid がないので、中の
  // rep-home・rep-home-loading から section をたどる。欄の中身がそろったかは見ない（それは shown）
  frame: `(a) => {
    const vis = (el) => !!el && el.offsetParent !== null;
    const year = document.querySelector('[data-testid="home-year"]');
    const roles = document.querySelector('[data-testid="home-roles"]');
    if (!vis(document.querySelector('header [data-testid="app-name"]')) || !vis(document.querySelector('main h1'))) return false;
    if (!vis(year) || year.textContent.trim() === '' || !vis(roles) || roles.children.length === 0) return false;
    return a.widgets.every((w) => {
      const inner = w === 'rep' ? document.querySelector('[data-testid="rep-home"], [data-testid="rep-home-loading"]') : null;
      const s = w === 'rep' ? (inner ? inner.closest('section') : null) : document.querySelector('main section[data-testid="' + w + '"]');
      const h = s ? s.querySelector(':scope > h2') : null;
      return vis(s) && !!h && h.textContent.trim() !== '' && s.children.length >= 2;
    });
  }`,
};

/** ダッシュボードに出ている欄（section の testid と、代表する団体の欄は rep）。計った後に、その人に出す欄と同じかを確かめる */
const WIDGETS_IN_PAGE = `(() => [
  ...[...document.querySelectorAll('main section[data-testid^="portal-"]')].map((s) => s.getAttribute('data-testid')),
  ...(document.querySelector('[data-testid="rep-home"], [data-testid="rep-home-loading"]') ? ['rep'] : []),
])()`;

/** D-58 の枠の印（2 秒） */
const FRAME: Mark = { id: 'frame', label: '枠', shown: SHOWN.frame, limit: LIMIT_MS };
/** 代表する団体のカード（管理者で団体代表の /。記録だけ。D-58 では「そろう」の中で見る） */
const CARD: Mark = { id: 'card', label: 'カード', shown: SHOWN.home, limit: null };

/** 総務部門員・総務部門長の / の Playwright の印（机椅子とシフト・作業のカード） */
async function soumuHomeReady(page: Page): Promise<void> {
  await expect(page.locator('[data-testid="module-card"][data-module="shifts"]')).toBeVisible({ timeout: 30_000 });
  await expect(page.locator('[data-testid="module-card"][data-module="furniture"]')).toBeVisible({ timeout: 30_000 });
}

const ALL_TARGETS: Target[] = [
  {
    id: 'stock',
    name: '/stock?room=（部員）',
    user: 'staff',
    records: true,
    url: (s) => `/stock/?room=${s.ids.rooms[ROOM]}`,
    ready: async (page) => {
      await expect(page.getByTestId('stock-room-name')).toHaveText(ROOM, { timeout: 30_000 });
      await expect(page.getByRole('textbox', { name: '机(木)の数' })).toHaveValue(/^\d+$/, { timeout: 30_000 });
    },
    shown: SHOWN.stock,
  },
  {
    id: 'request',
    name: '/request（団体代表）',
    user: 'rep',
    records: true,
    url: () => '/request/',
    ready: async (page) => {
      await expect(page.getByTestId('request-group-name')).toHaveText(REP_GROUP, { timeout: 30_000 });
      await expect(page.getByRole('button', { name: /提出/ }).first()).toBeVisible({ timeout: 30_000 });
    },
    shown: SHOWN.request,
  },
  {
    id: 'my',
    name: '/my（団体代表）',
    user: 'rep',
    records: true,
    url: () => '/my/',
    ready: async (page) => {
      await expect(page.getByTestId('my-group')).toContainText(REP_GROUP, { timeout: 30_000 });
      await expect(page.getByTestId('my-in-progress')).toContainText('振り分け作業中', { timeout: 30_000 });
    },
    shown: SHOWN.my,
  },
  // ダッシュボード（T16。D-51）：団体代表の /。表示の印は代表する団体のカード（模擬店10）が見えたこと（D-58 でもこのまま）。
  // 先読み・先送りの表にある（D-45）
  {
    id: 'home',
    name: '/（団体代表）',
    user: 'rep',
    records: true,
    url: () => '/',
    ready: async (page) => {
      await expect(page.locator(`[data-testid="rep-card"][data-group="${REP_GROUP}"]`)).toBeVisible({ timeout: 30_000 });
    },
    shown: SHOWN.home,
    label: 'カード',
  },
  // 提出物（T19。D-55）：団体代表の自団体の提出物（スマホ。先読み・記録・先送りの表にある。D-45）。表示の印は団体名とカード
  {
    id: 'document',
    name: '/document（団体代表）',
    user: 'rep',
    records: true,
    url: () => '/document/',
    ready: async (page) => {
      await expect(page.getByTestId('document-group-name')).toHaveText(REP_GROUP, { timeout: 30_000 });
      await expect(page.getByTestId('document-card').first()).toBeVisible({ timeout: 30_000 });
    },
    shown: SHOWN.document,
  },
  // シフト・作業（T20。D-56）：総務部門員の /（机椅子とシフト・作業のカード）・/shift・/tasks。どれも先読み・先送りの表にある（D-45）。
  // データは insertShiftVolume（1年の量の見込み。部門員 100 人・時間枠 50・ます 250・割り当て 800・作業 200）。
  // 総務部門員の / の印は、D-58 で「そろう」（3 秒の目安）になり、2 秒は枠の印（frame）で見る（FU3）
  {
    id: 'soumu-home',
    name: '/（総務部門員）',
    user: 'staff',
    records: true,
    url: () => '/',
    ready: soumuHomeReady,
    shown: SHOWN.soumuHome,
    label: 'そろう',
    limit: SETTLED_LIMIT_MS,
    widgets: SOUMU_WIDGETS,
    marks: [FRAME],
  },
  {
    id: 'shift',
    name: '/shift（総務部門員）',
    user: 'staff',
    records: true,
    url: () => '/shift/',
    ready: async (page) => {
      await expect(page.getByTestId('my-shift-item').first()).toBeVisible({ timeout: 30_000 });
      await expect(page.getByTestId('my-shift-mates').filter({ hasText: '名前を表示できません' })).toHaveCount(0, { timeout: 30_000 });
    },
    shown: SHOWN.shift,
  },
  {
    id: 'tasks',
    name: '/tasks（総務部門員）',
    user: 'staff',
    records: true,
    url: () => '/tasks/',
    ready: async (page) => {
      await expect(page.getByTestId('tasks-item').first()).toBeVisible({ timeout: 30_000 });
      await expect(page.getByTestId('tasks-progress')).toBeVisible({ timeout: 30_000 });
    },
    shown: SHOWN.tasks,
  },
  // テント等の貸し出し（T21）：部員の受け渡し・返却（スマホ。先読み・記録・先送りの表にある）。表示の印は一覧に模擬店10 が出たこと
  {
    id: 'records',
    name: '/lending/records（部員）',
    user: 'staff',
    records: true,
    url: () => '/lending/records/',
    ready: async (page) => {
      await expect(page.getByTestId('records-group').filter({ hasText: REP_GROUP })).toBeVisible({ timeout: 30_000 });
    },
    shown: SHOWN.records,
  },
  // テント等の貸し出し（T21）：団体代表の申請のテント等のタブ（`?tab=lending` で開く。/request は先読み・記録・先送りの表にある）
  {
    id: 'request-lending',
    name: '/request?tab=lending（団体代表）',
    user: 'rep',
    records: true,
    url: () => '/request/?tab=lending',
    ready: async (page) => {
      await expect(page.getByTestId('lending-request')).toContainText(REP_GROUP, { timeout: 30_000 });
      await expect(page.getByTestId('lending-request-item').first()).toBeVisible({ timeout: 30_000 });
    },
    shown: SHOWN.requestLending,
  },
  // FU3（D-58）：総務部門長の /（部門長以上の読み取り。先送りの記録が上限〔24 本〕ちょうどになる）。印は総務部門員の / と同じ
  {
    id: 'head-home',
    name: '/（総務部門長）',
    user: 'head',
    records: true,
    url: () => '/',
    ready: soumuHomeReady,
    shown: SHOWN.soumuHome,
    label: 'そろう',
    limit: SETTLED_LIMIT_MS,
    widgets: SOUMU_WIDGETS,
    marks: [FRAME],
  },
  // FU3（D-58）：管理者で団体代表の /（管理者で、模擬店11 の店長も務める人。総務の欄に、お知らせと代表する団体の欄が加わり、先送りの記録の
  // 上限〔24 本〕を超える）。そろうは総務の / の印に代表する団体のカードを足したもの。代表する団体のカードが見えた時刻（card）も出す
  {
    id: 'admin-home',
    name: '/（管理者で団体代表）',
    user: 'admin',
    group: ADMIN_GROUP,
    records: true,
    url: () => '/',
    ready: async (page) => {
      await soumuHomeReady(page);
      await expect(page.locator(`[data-testid="rep-card"][data-group="${ADMIN_GROUP}"]`)).toBeVisible({ timeout: 30_000 });
    },
    shown: SHOWN.adminHome,
    label: 'そろう',
    limit: SETTLED_LIMIT_MS,
    widgets: SOUMU_REP_WIDGETS,
    marks: [FRAME, CARD],
  },
];

/**
 * 提出物（T19）の行：提出物6つ（締切は今日の前後。模擬店・部門・企業が対象、飲食だけのもの・ファイルの要らないものを含む）と、模擬店・
 * 部門の提出の状況（並びの順に承認・承認待ち・差し戻し・未提出）。模擬店10（団体代表）には「出店計画書」に PDF を2つ上げる（API。画面と
 * 同じ予約 → Storage）
 */
async function seedDocuments(s: Scenario): Promise<void> {
  const H = SEED_USER_IDS.head;
  const docs = await insertDocuments(s.yearId, [
    { title: '電気使用届', deadline: tokyoDeadline(-2), categories: ['stall', 'department', 'company'], createdBy: H },
    { title: '食品の取り扱い届', deadline: tokyoDeadline(3), categories: ['stall'], foodOnly: true, createdBy: H },
    { title: '出店計画書', deadline: tokyoDeadline(6), categories: ['stall', 'department'], createdBy: H },
    { title: '火気の使用届', deadline: tokyoDeadline(9), categories: ['stall'], createdBy: H },
    { title: '企業ブースの配置図', deadline: tokyoDeadline(12, '12:00'), categories: ['company', 'rest_area'], requiresFile: false, createdBy: H },
    { title: '片付けの報告', deadline: tokyoDeadline(20), categories: ['stall', 'department', 'company', 'rest_area'], requiresFile: false, createdBy: H },
  ]);
  const plan = docs[2];
  const names = Object.keys(s.ids.groups).sort().filter((n) => n !== REP_GROUP && (n.startsWith('模擬店') || n.startsWith('部門')));
  const ago = (h: number) => new Date(Date.now() - h * 60 * 60 * 1000).toISOString();
  const rows = names.flatMap((n, k): SubmissionInput[] => {
    const groupId = s.ids.groups[n]!;
    switch (k % 4) {
      case 0:
        return [{ documentId: plan, groupId, status: 'approved', submittedAt: ago(30), reviewedAt: ago(20), reviewedBy: H }];
      case 1:
        return [{ documentId: plan, groupId, status: 'submitted', submittedAt: ago(5) }];
      case 2:
        return [{ documentId: plan, groupId, status: 'returned', submittedAt: ago(40), reviewedAt: ago(10), reviewedBy: H, reviewNote: '配置図に出入口がありません' }];
      default:
        return [];
    }
  });
  await insertSubmissions(s.yearId, rows);
  const repToken = await apiToken('rep');
  const groupId = s.ids.groups[REP_GROUP]!;
  for (const label of ['E2E T19 perf one', 'E2E T19 perf two']) await uploadFileAs(repToken, { documentId: plan, groupId, body: makePdf(label) });
}

/**
 * テント等の貸し出し（T21）の行：備品3つ（テント・重し・三方幕〔模擬店だけ〕）、模擬店と部門の申請と同じ数の割り当て（確定）、
 * 模擬店の半分（並びの奇数）の受け渡しの記録（テントを渡して、まだ返っていない）
 */
async function seedLending(s: Scenario): Promise<void> {
  const [tent, weight, curtain] = await insertLendingItems(s.yearId, [
    { name: 'テント', unit: '張', stock: 60 },
    { name: '重し', stock: 240 },
    { name: '三方幕', unit: '枚', stock: 50, categories: ['stall'] },
  ]);
  const names = Object.keys(s.ids.groups).sort();
  const stalls = names.filter((n) => n.startsWith('模擬店'));
  const departments = names.filter((n) => n.startsWith('部門'));
  const counts = [
    ...stalls.flatMap((n) => [
      { groupId: s.ids.groups[n]!, itemId: tent, count: 1 },
      { groupId: s.ids.groups[n]!, itemId: weight, count: 4 },
      { groupId: s.ids.groups[n]!, itemId: curtain, count: 1 },
    ]),
    ...departments.map((n) => ({ groupId: s.ids.groups[n]!, itemId: tent, count: 1 })),
  ];
  await insertLendingRequests(s.yearId, counts);
  await insertLendingAssignments(s.yearId, counts);
  await insertLendingRecords(
    s.yearId,
    stalls.filter((_, k) => k % 2 === 0).map((n) => ({ groupId: s.ids.groups[n]!, itemId: tent, lent: 1 })),
  );
  await confirmLending(s.yearId, null);
}

/** 先読みのために覚えた id の localStorage のキー（apps/web/lib/boot/early-load.ts の PREFETCH_HINT_PREFIX と同じ） */
const PREFETCH_HINT_PREFIX = 'gaapp:prefetch:';
type Visit = 'first' | 'again';
const VISITS: Visit[] = process.env.PERF_VISIT === 'first' || process.env.PERF_VISIT === 'again' ? [process.env.PERF_VISIT] : ['first', 'again'];

const ONLY = (process.env.PERF_ONLY ?? '').split(',').map((x) => x.trim()).filter(Boolean);
const TARGETS = ONLY.length > 0 ? ALL_TARGETS.filter((t) => ONLY.includes(t.id)) : ALL_TARGETS;
/** シフト・作業の1年の量（insertShiftVolume）を入れる画面（総務のダッシュボードもシフト・作業の欄を読む） */
const SHIFT_TARGETS: readonly Target['id'][] = ['soumu-home', 'head-home', 'admin-home', 'shift', 'tasks'];
/** 計る書き出し（PERF_AB のときは A と B） */
const BUILDS: readonly Build[] = AB_OUT ? ['a', 'b'] : ['b'];

interface Run {
  /** ナビゲーションの始まりから、画面の主な内容が見えた最初のフレームまで（ms。ページの中の performance.now()。marks.shown と同じ） */
  ms: number;
  /** 印ごとの時刻（shown と、ダッシュボードの frame・管理者で団体代表の / の card。ms） */
  marks: Record<string, number>;
  /** 前の測り方（page.goto の前から Playwright の expect が通るまで。再試行の間隔のぶん遅く出る。比べるために残す） */
  expectMs: number;
  /** ナビゲーションの DOMContentLoaded（ms） */
  dcl: number;
  /** 同じ origin の script の数と転送量（KB。圧縮後） */
  scripts: number;
  scriptKB: number;
  /** 最後の script の応答が終わった時刻（goto からの ms） */
  lastScriptMs: number;
  /** Supabase へのリクエストの数（auth・rest。CORS の preflight を除く） */
  supabase: number;
  /** 開き始めたときの 1 分の load average */
  load: number;
  /** リクエストの始まりと終わり（goto からの ms。1回目だけ perf.json に残す。何が直列に待っているかを見るため） */
  waterfall: string[];
}

// ---------------------------------------------------------------- 負荷（1 分の load average）

const load1 = () => Math.round(os.loadavg()[0]! * 100) / 100;
/** 計っている間の最大（5 秒ごとと、1回ごとに読む）。cell はマスごとに読み直す */
const loadMax = { all: 0, cell: 0 };
function noteLoad(): number {
  const v = load1();
  loadMax.all = Math.max(loadMax.all, v);
  loadMax.cell = Math.max(loadMax.cell, v);
  return v;
}

/** 計り始める前に、1 分の load average が LOAD_WAIT を下回るまで待つ（最長 LOAD_WAIT_MAX_S 秒） */
async function waitForQuiet(): Promise<{ threshold: number; waitedS: number; start: number; timedOut: boolean }> {
  const t0 = Date.now();
  while (LOAD_WAIT > 0 && load1() >= LOAD_WAIT && Date.now() - t0 < LOAD_WAIT_MAX_S * 1000) await new Promise((r) => setTimeout(r, 5000));
  const start = load1();
  return { threshold: LOAD_WAIT, waitedS: Math.round((Date.now() - t0) / 1000), start, timedOut: LOAD_WAIT > 0 && start >= LOAD_WAIT };
}

// ---------------------------------------------------------------- HTTP/2 の静的サーバー（h2 の配り方）

const TYPES: Record<string, string> = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.json': 'application/json',
  '.txt': 'text/plain; charset=utf-8',
  '.webmanifest': 'application/manifest+json',
  '.png': 'image/png',
  '.svg': 'image/svg+xml',
  '.ico': 'image/x-icon',
  '.wasm': 'application/wasm',
  '.woff2': 'font/woff2',
};

/** 自己署名の証明書（localhost）。openssl がなければ null */
function selfSignedCert(dir: string): { key: Buffer; cert: Buffer } | null {
  mkdirSync(dir, { recursive: true });
  const key = path.join(dir, 'key.pem');
  const cert = path.join(dir, 'cert.pem');
  try {
    execFileSync(
      'openssl',
      ['req', '-x509', '-newkey', 'rsa:2048', '-nodes', '-keyout', key, '-out', cert, '-days', '1', '-subj', '/CN=localhost', '-addext', 'subjectAltName=DNS:localhost'],
      { stdio: 'ignore' },
    );
  } catch {
    return null;
  }
  return { key: readFileSync(key), cert: readFileSync(cert) };
}

/**
 * 書き出し（root）を HTTP/2 で配る（末尾の / は index.html。テキストは gzip。GitHub Pages に近い形）。PERF_AB のときは A と B を同じ作りで
 * 別のポートに配る
 */
async function startH2(tls: { key: Buffer; cert: Buffer }, root: string, port: number): Promise<{ origin: string; close: () => Promise<void> }> {
  const base = root.endsWith(path.sep) ? root : root + path.sep;
  const gz = new Map<string, Buffer>();
  const server = http2.createSecureServer({ ...tls, allowHTTP1: true }, (req, res) => {
    const pathname = decodeURIComponent(new URL(req.url ?? '/', 'https://localhost').pathname);
    let file = path.join(base, pathname);
    if (!file.startsWith(base)) {
      res.writeHead(400).end();
      return;
    }
    if (existsSync(file) && statSync(file).isDirectory()) file = path.join(file, 'index.html');
    let status = 200;
    if (!existsSync(file)) {
      status = 404;
      file = path.join(base, '404.html');
    }
    const ext = path.extname(file);
    const type = TYPES[ext] ?? 'application/octet-stream';
    let body: Buffer = readFileSync(file);
    const headers: Record<string, string> = { 'content-type': type, 'cache-control': 'no-cache' };
    if (/^(text|application\/(json|manifest))/.test(type) && /\bgzip\b/.test(String(req.headers['accept-encoding'] ?? ''))) {
      if (!gz.has(file)) gz.set(file, gzipSync(body));
      body = gz.get(file)!;
      headers['content-encoding'] = 'gzip';
    }
    res.writeHead(status, headers).end(body);
  });
  await new Promise<void>((resolve, reject) => {
    server.once('error', reject);
    server.listen(port, 'localhost', resolve);
  });
  return { origin: `https://localhost:${port}`, close: () => new Promise((r) => server.close(() => r())) };
}

/**
 * storageState（ログインのセッション）。先読みのために覚えた id は外す（ログインの準備で画面を開いたときに覚えたもの。
 * 計る開き方は first・again で決める）。localStorage は計る書き出しの origin に移す（Supabase のセッションは origin ごとの
 * localStorage にある。cookie は使わない）。
 */
function storageStateAt(user: StoredUser, origin: string) {
  const state = JSON.parse(readFileSync(storageStateFor(user), 'utf8')) as {
    cookies: unknown[];
    origins: { origin: string; localStorage: { name: string; value: string }[] }[];
  };
  return {
    cookies: [],
    origins: state.origins.map((o) => ({
      ...o,
      origin,
      localStorage: o.localStorage.filter((e) => !e.name.startsWith(PREFETCH_HINT_PREFIX)),
    })),
  };
}

// ---------------------------------------------------------------- 測る

function contextOptions(t: Target, origin: string) {
  return {
    storageState: storageStateAt(t.user, origin) as never,
    viewport: MOBILE,
    isMobile: true,
    hasTouch: true,
    baseURL: origin,
    ignoreHTTPSErrors: true,
  };
}

/** 一度（絞らずに）開いて、アプリが覚えた先読みの id（localStorage）を取り出す */
async function learnHints(browser: Browser, s: Scenario, t: Target, origin: string): Promise<[string, string][]> {
  const context = await browser.newContext(contextOptions(t, origin));
  try {
    const page = await context.newPage();
    await pinYear(page, SEED_USER_IDS[t.user], s.yearId);
    await page.goto(t.url(s), { waitUntil: 'commit' });
    await t.ready(page);
    // 開いたときのリクエスト（<head> の script が先に送るもの）は、立場が届いてから少し後に覚える。覚えない画面（records が偽）は、
    // 先読みの id（`gaapp:prefetch:<user_id>`）だけを待つ
    await page.waitForFunction(
      ({ prefix, records }) => {
        const ls = (globalThis as unknown as { localStorage: Storage }).localStorage;
        for (let i = 0; i < ls.length; i++) {
          const k = ls.key(i);
          if (k?.startsWith(prefix) && (!records || k.endsWith(':requests'))) return true;
        }
        return false;
      },
      { prefix: PREFETCH_HINT_PREFIX, records: t.records },
      { timeout: 15_000 },
    );
    const hints = await page.evaluate((prefix) => {
      const ls = (globalThis as unknown as { localStorage: Storage }).localStorage;
      const out: [string, string][] = [];
      for (let i = 0; i < ls.length; i++) {
        const k = ls.key(i);
        if (k?.startsWith(prefix)) out.push([k, ls.getItem(k) ?? '']);
      }
      return out;
    }, PREFETCH_HINT_PREFIX);
    expect(hints.length, '開いた後に先読みの id を覚えている').toBeGreaterThan(0);
    return hints;
  } finally {
    await context.close();
  }
}

/** その画面で時刻を取る印の名前（shown と、ほかの印） */
const markIds = (t: Target) => ['shown', ...(t.marks ?? []).map((m) => m.id)];

async function measure(browser: Browser, s: Scenario, t: Target, origin: string, hints: [string, string][] = []): Promise<Run> {
  const context = await browser.newContext(contextOptions(t, origin));
  try {
    const page = await context.newPage();
    await pinYear(page, SEED_USER_IDS[t.user], s.yearId);
    if (hints.length > 0) {
      await page.addInitScript((entries) => {
        const ls = (globalThis as unknown as { localStorage: Storage }).localStorage;
        for (const [k, v] of entries) ls.setItem(k, v);
      }, hints);
    }
    const cdp = await context.newCDPSession(page);
    await cdp.send('Network.enable');
    await cdp.send('Network.setCacheDisabled', { cacheDisabled: true });
    await cdp.send('Network.emulateNetworkConditions', FAST_4G);
    await cdp.send('Emulation.setCPUThrottlingRate', { rate: CPU_RATE });
    let supabase = 0;
    let start = 0;
    let lastScriptMs = 0;
    const waterfall: { at: number; line: string }[] = [];
    const isSupabase = (url: string) => /\/(rest|auth)\/v1\//.test(url);
    const traceAll = process.env.PERF_TRACE === 'all';
    page.on('request', (r) => {
      if (isSupabase(r.url())) supabase++;
    });
    page.on('requestfinished', (r) => {
      const t = r.timing();
      const begin = Math.round(t.startTime - start);
      const end = Math.round(t.startTime + t.responseEnd - start);
      if (r.resourceType() === 'script') lastScriptMs = Math.max(lastScriptMs, end);
      if (!isSupabase(r.url()) && !traceAll) return;
      const u = new URL(r.url());
      waterfall.push({ at: begin, line: `${begin}〜${end} ${r.method()} ${u.pathname.replace(/^\/(rest|auth)\/v1\//, '')}${traceAll ? u.search.slice(0, 60) : ''}` });
    });
    page.on('requestfailed', (r) => {
      if (!isSupabase(r.url())) return;
      const at = Date.now() - start;
      waterfall.push({ at, line: `${at}〜 失敗（${r.failure()?.errorText ?? '?'}） ${r.method()} ${new URL(r.url()).pathname.replace(/^\/(rest|auth)\/v1\//, '')}` });
    });
    if (process.env.PERF_DEBUG) page.on('console', (m) => waterfall.push({ at: Date.now() - start, line: `console ${m.text()}` }));
    // 印が真になった最初のフレームの時刻を、ページの中で記録する（読み込みの前から毎フレーム、まだ真になっていない印だけを調べる）。
    // 時刻はフレームごとに1つ（調べ始める前の performance.now()）。同じフレームで真になった印は同じ時刻にする（印ごとに調べた後で
    // 時計を読むと、CPU 4 倍では後に調べた印が数 ms 遅く出て、枠の印がそろうより後になることがあった）
    const ids = markIds(t);
    const fns = Object.fromEntries([['shown', t.shown], ...(t.marks ?? []).map((m) => [m.id, m.shown])]) as Record<string, string>;
    await page.addInitScript(
      ([marks, arg]) => {
        const g = globalThis as unknown as { __perfMarks?: Record<string, number>; requestAnimationFrame(cb: () => void): void; performance: { now(): number } };
        const at: Record<string, number> = {};
        g.__perfMarks = at;
        const pending = new Map(Object.entries(marks).map(([k, f]) => [k, (0, eval)(f) as (a: unknown) => boolean]));
        const tick = () => {
          const now = g.performance.now();
          for (const [k, check] of [...pending]) {
            try {
              if (check(arg)) {
                at[k] = now;
                pending.delete(k);
              }
            } catch {
              // まだ DOM がない
            }
          }
          if (pending.size > 0) g.requestAnimationFrame(tick);
        };
        g.requestAnimationFrame(tick);
      },
      [fns, { room: ROOM, group: t.group ?? REP_GROUP, widgets: t.widgets ?? [] }] as const,
    );
    const load = noteLoad();
    start = Date.now();
    await page.goto(t.url(s), { waitUntil: 'commit' });
    await t.ready(page);
    const expectMs = Date.now() - start;
    try {
      await page.waitForFunction(
        (want) => {
          const m = (globalThis as unknown as { __perfMarks?: Record<string, number> }).__perfMarks;
          return !!m && want.every((k) => typeof m[k] === 'number');
        },
        ids,
        { timeout: 30_000 },
      );
    } catch (e) {
      const got = await page.evaluate(() => (globalThis as unknown as { __perfMarks?: Record<string, number> }).__perfMarks ?? {});
      // 枠の印が真にならないのは、出る欄が変わったときが多い（その人に出す欄を直す）ので、出ている欄も添える
      const widgets = t.widgets ? `。出ている欄：${((await page.evaluate(WIDGETS_IN_PAGE)) as string[]).join('・')}` : '';
      throw new Error(`印が真にならない（${ids.filter((k) => typeof got[k] !== 'number').join('・')}${widgets}）：${String(e).split('\n')[0]}`, { cause: e });
    }
    const at = await page.evaluate(() => (globalThis as unknown as { __perfMarks: Record<string, number> }).__perfMarks);
    const marks = Object.fromEntries(ids.map((k) => [k, Math.round(at[k]!)]));
    // ダッシュボード：出ている欄が、その人に出す欄（枠の印で待った欄）と同じか（欄が増減したら枠の印を直す）
    if (t.widgets) {
      const found = (await page.evaluate(WIDGETS_IN_PAGE)) as string[];
      expect([...found].sort(), `${t.name} の欄（枠の印で待つ欄と同じか）`).toEqual([...t.widgets].sort());
    }
    // ルートの tsconfig は DOM の型を持たないので、使う形だけを書く
    const nav = await page.evaluate(() => {
      type Entry = { name: string; initiatorType?: string; transferSize?: number; domContentLoadedEventEnd?: number };
      const g = globalThis as unknown as { performance: { getEntriesByType(t: string): Entry[] }; location: { origin: string } };
      const n = g.performance.getEntriesByType('navigation')[0];
      const scripts = g.performance
        .getEntriesByType('resource')
        .filter((e) => e.initiatorType === 'script' && new URL(e.name).origin === g.location.origin);
      return { dcl: n?.domContentLoadedEventEnd ?? 0, scripts: scripts.length, scriptBytes: scripts.reduce((sum, e) => sum + (e.transferSize ?? 0), 0) };
    });
    return {
      ms: marks.shown!,
      marks,
      expectMs,
      dcl: Math.round(nav.dcl),
      scripts: nav.scripts,
      scriptKB: Math.round((nav.scriptBytes / 1024) * 10) / 10,
      lastScriptMs,
      supabase,
      load,
      waterfall: waterfall.sort((a, b) => a.at - b.at).map((w) => w.line),
    };
  } finally {
    await context.close();
  }
}

const median = (xs: number[]) => quantile(xs, 0.5);
const show = (v: number | null) => (v === null ? '—' : String(v));

// ---------------------------------------------------------------- 集計と perf.json

/**
 * 1つの書き出しの、1マスの回（失敗した回は除く。run は何回目〔PERF_AB のときは何組目〕か。0 から。1回目だけ waterfall を残す）と、
 * 印ごとの中央値・四分位
 */
function buildResult(t: Target, runs: readonly (Run | null | undefined)[]) {
  const ok = runs.flatMap((r, run) => (r ? [{ ...r, run }] : []));
  return {
    runs: ok.map((r, i) => (i === 0 ? r : { ...r, waterfall: [] })),
    medianMs: median(ok.map((r) => r.ms)),
    marks: Object.fromEntries(markIds(t).map((id) => [id, summarize(ok.map((r) => r.marks[id]!))])) as Record<string, Summary>,
  };
}

interface CellError {
  server: string;
  visit: Visit;
  page: string;
  /** a・b（PERF_AB のとき）。b はこの checkout の書き出し */
  build: Build;
  /** 何回目（組）か。-1 は again の準備（覚えたリクエストを取る） */
  run: number;
  message: string;
}

interface Server {
  name: 'http1' | 'h2';
  /** 書き出しごとの origin */
  origins: Partial<Record<Build, string>>;
}

test('T14 4G での表示の速さ：スマホの画面とダッシュボード（T16〜T21・FU3）を Fast 4G と CPU 4 倍で計る（PERF_AB で main と交互に）', async ({ browser }, testInfo) => {
  if (AB_OUT) expect(existsSync(path.join(AB_OUT, 'index.html')), `PERF_AB（${AB_OUT}）に書き出し（index.html）がある`).toBe(true);
  const tls = selfSignedCert(path.join(testInfo.outputDir, 'tls'));
  if (!tls) testInfo.annotations.push({ type: '4G の速さ', description: 'openssl がないので h2（HTTP/2）の配り方を飛ばした' });
  // 時間の上限：準備と負荷の待ちに加えて、1回 25 秒（ふだんは 4〜5 秒。止まった回は 60 秒ほど）× 回の数
  const loads = (tls ? 2 : 1) * VISITS.length * TARGETS.length * BUILDS.length * (RUNS + (VISITS.includes('again') ? 1 : 0));
  test.setTimeout(10 * 60_000 + LOAD_WAIT_MAX_S * 1000 + loads * 25_000);
  const h2: Partial<Record<Build, Awaited<ReturnType<typeof startH2>>>> = {};
  const s = await createScenario({
    dataset: 'synthetic',
    status: 'requesting',
    roles: { staff: true, head: true, admin: true },
    repGroup: REP_GROUP,
    groupMembers: [{ group: ADMIN_GROUP, userId: SEED_USER_IDS.admin }],
  });
  let shifts: Awaited<ReturnType<typeof insertShiftVolume>> | null = null;
  const startedAt = new Date().toISOString();
  const results: Record<string, unknown>[] = [];
  const errors: CellError[] = [];
  let quiet: Awaited<ReturnType<typeof waitForQuiet>> | null = null;
  let done = false;
  const out = path.join(testInfo.project.outputDir, 'perf.json');
  mkdirSync(path.dirname(out), { recursive: true });
  const body = () =>
    JSON.stringify(
      {
        at: new Date().toISOString(),
        startedAt,
        done,
        network: FAST_4G,
        cpuRate: CPU_RATE,
        runs: RUNS,
        ab: AB_OUT ? { a: AB_OUT, b: OUT_DIR, ports: { http1: { a: AB_PORT, b: PORT }, h2: { a: AB_H2_PORT, b: H2_PORT } }, diff: 'b - a' } : null,
        load: { ...quiet, max: loadMax.all, mark: LOAD_MARK, over: loadMax.all > LOAD_MARK },
        // PERF_AB：画面ごと・印ごとに、計り終えたマスの対の差を合わせたもの（採る基準を画面で見るとき。マスごとは results の diff）
        pooled: AB_OUT ? poolDiffs(results as unknown as CellDiff[]) : null,
        results,
        errors,
      },
      null,
      2,
    );
  const write = () => writeFileSync(out, body());
  let sampler: ReturnType<typeof setInterval> | undefined;
  try {
    if (tls) {
      h2.b = await startH2(tls, OUT_DIR, H2_PORT);
      if (AB_OUT) h2.a = await startH2(tls, AB_OUT, AB_H2_PORT);
    }
    // シフト・作業（T20）：総務のダッシュボード・/shift・/tasks を計るときだけ、1年の量の見込みのシフト・作業を入れる
    if (TARGETS.some((t) => SHIFT_TARGETS.includes(t.id))) shifts = await insertShiftVolume(s.yearId, SEED_USER_IDS.staff);
    await seedDocuments(s);
    await seedLending(s);
    quiet = await waitForQuiet();
    // 計っている間の最大は、ここから（準備の DB への書き込みの負荷は入れない）
    loadMax.all = quiet.start;
    sampler = setInterval(noteLoad, 5000);
    const startLine =
      `[負荷] 計り始めの 1 分の load average ${quiet.start}（${quiet.threshold > 0 ? `${quiet.threshold} を下回るまで ${quiet.waitedS} 秒待った` : '待たない'}` +
      `${quiet.timedOut ? '。下回らないまま始めた' : ''}）`;
    console.log(startLine);
    testInfo.annotations.push({ type: '4G の速さ', description: startLine });
    write();
    const servers: Server[] = [
      { name: 'http1', origins: { b: `http://localhost:${PORT}`, ...(AB_OUT ? { a: `http://localhost:${AB_PORT}` } : {}) } },
      ...(h2.b ? [{ name: 'h2' as const, origins: { b: h2.b.origin, ...(h2.a ? { a: h2.a.origin } : {}) } }] : []),
    ];
    for (const server of servers) {
      for (const visit of VISITS) {
        for (const t of TARGETS) {
          const label = `${server.name}・${visit}`;
          loadMax.cell = load1();
          const fail = (build: Build, run: number, e: unknown) => {
            const message = String(e instanceof Error ? e.message : e)
              .replace(/\s*\n\s*/g, ' / ')
              .slice(0, 400);
            errors.push({ server: server.name, visit, page: t.name, build, run, message });
            console.log(`[${label}] ${t.name}（${build.toUpperCase()}${run < 0 ? '・again の準備' : `・${run + 1} 回目`}）が止まった・失敗した：${message}`);
          };
          const runs: Record<Build, (Run | null)[]> = { a: [], b: [] };
          const hints: Partial<Record<Build, [string, string][]>> = {};
          let skipped = 0;
          for (const b of BUILDS) {
            if (skipped > 0) break;
            try {
              hints[b] = visit === 'again' ? await learnHints(browser, s, t, server.origins[b]!) : [];
            } catch (e) {
              fail(b, -1, e);
              skipped = RUNS;
            }
          }
          // 同じ書き出しがこのマスで2回続けて失敗したら、残りを飛ばす（止まりが続くと 1 回 60 秒ほどかかるため）
          const streak: Record<Build, number> = { a: 0, b: 0 };
          for (let i = 0; i < RUNS && skipped === 0; i++) {
            for (const b of AB_OUT ? pairOrder(i) : (['b'] as const)) {
              try {
                runs[b][i] = await measure(browser, s, t, server.origins[b]!, hints[b]);
                streak[b] = 0;
              } catch (e) {
                runs[b][i] = null;
                streak[b]++;
                fail(b, i, e);
              }
            }
            if (streak.a >= 2 || streak.b >= 2) skipped = RUNS - i - 1;
          }
          noteLoad();
          const B = buildResult(t, runs.b);
          const loadPart = { loadMax: loadMax.cell, loadOver: loadMax.cell > LOAD_MARK };
          const flag = (v: number | null, limit: number | null) => (v !== null && limit !== null && v > limit ? ` ※${limit / 1000} 秒を超えた` : '');
          const primary = { label: t.label ?? '表示', limit: t.limit ?? LIMIT_MS };
          const extra = t.marks ?? [];
          if (process.env.PERF_TRACE) {
            for (const b of BUILDS) {
              const first = runs[b].find((r): r is Run => !!r);
              if (first) console.log(`[${label}] ${t.name}${AB_OUT ? `（${b.toUpperCase()}）` : ''} の1回目：\n  ${first.waterfall.join('\n  ')}`);
            }
          }
          let line: string;
          if (!AB_OUT) {
            const ok = runs.b.filter((r): r is Run => !!r);
            results.push({ server: server.name, visit, page: t.name, id: t.id, ...B, ...loadPart, skipped });
            const r0 = ok[0];
            line =
              `[${label}] ${t.name}：${primary.label}の中央値 ${show(B.medianMs)} ms（${ok.map((r) => r.ms).join('・')} ms）` +
              extra.map((m) => `、${m.label}の中央値 ${show(B.marks[m.id]!.median)} ms（${ok.map((r) => r.marks[m.id]).join('・')} ms）${flag(B.marks[m.id]!.median, m.limit)}`).join('') +
              `。前の測り方〔expect〕の中央値 ${show(median(ok.map((r) => r.expectMs)))} ms、` +
              `DOMContentLoaded ${ok.map((r) => r.dcl).join('・')} ms、最後の script ${ok.map((r) => r.lastScriptMs).join('・')} ms、` +
              `script ${r0?.scripts ?? '—'} 本 ${r0?.scriptKB ?? '—'} KB、Supabase ${ok.map((r) => r.supabase).join('・')} 回、負荷 ${ok.map((r) => r.load).join('・')}` +
              `${flag(B.medianMs, primary.limit)}${loadPart.loadOver ? ` ※負荷の最大 ${loadPart.loadMax}` : ''}`;
          } else {
            const A = buildResult(t, runs.a);
            const pick = (rs: (Run | null)[], id: string) => rs.map((r) => r?.marks[id]);
            const diff = Object.fromEntries(
              markIds(t).map((id) => {
                const values = pairedDiffs(pick(runs.a, id), pick(runs.b, id));
                return [id, { ...summarize(values), values }];
              }),
            ) as Record<string, Summary & { values: number[] }>;
            const order = orderEffects(pick(runs.a, 'shown'), pick(runs.b, 'shown'));
            results.push({ server: server.name, visit, page: t.name, id: t.id, ...B, a: A, pairs: diff.shown!.n, diff, orderEffect: { ...summarize(order), values: order }, ...loadPart, skipped });
            const d = (id: string, name: string) =>
              `${name} ${signed(diff[id]!.median)} ms（四分位 ${signed(diff[id]!.q1)}〜${signed(diff[id]!.q3)}）`;
            line =
              `[${label}] ${t.name}：B − A ${d('shown', primary.label)}${extra.map((m) => `、${d(m.id, m.label)}`).join('')}、${diff.shown!.n} 組。` +
              `${primary.label}の中央値 A ${show(A.medianMs)}・B ${show(B.medianMs)} ms${flag(B.medianMs, primary.limit)}` +
              extra.map((m) => `、${m.label} A ${show(A.marks[m.id]!.median)}・B ${show(B.marks[m.id]!.median)} ms${flag(B.marks[m.id]!.median, m.limit)}`).join('') +
              `、後 − 先 ${signed(summarize(order).median)} ms、負荷の最大 ${loadPart.loadMax}${loadPart.loadOver ? ' ※' : ''}`;
          }
          if (skipped > 0) line += `（止まり・失敗が続いたので残り ${skipped} 回を飛ばした）`;
          testInfo.annotations.push({ type: '4G の速さ', description: line });
          console.log(line);
          write();
        }
      }
    }
    if (AB_OUT) {
      for (const p of poolDiffs(results as unknown as CellDiff[])) {
        const label = p.mark === 'shown' ? (TARGETS.find((t) => t.name === p.page)?.label ?? '表示') : (FRAME.id === p.mark ? FRAME.label : CARD.label);
        const pooledLine =
          `[B − A・全部のマス] ${p.page} ${label}：中央値 ${signed(p.median)} ms（四分位 ${signed(p.q1)}〜${signed(p.q3)}）、${p.n} 組、` +
          `${p.cells} マスのうち中央値が負 ${p.cellsNegative}`;
        testInfo.annotations.push({ type: '4G の速さ', description: pooledLine });
        console.log(pooledLine);
      }
    }
    done = true;
  } finally {
    if (sampler) clearInterval(sampler);
    write();
    await cleanupDocumentsScenario(s);
    await shifts?.cleanup();
    await h2.b?.close();
    await h2.a?.close();
  }
  await testInfo.attach('perf.json', { body: body(), contentType: 'application/json' });
  expect(errors, '止まった・失敗した回（perf.json の errors。値はそれまでの分も残っている）').toEqual([]);
  expect(results.length).toBeGreaterThanOrEqual(TARGETS.length * VISITS.length);
});
