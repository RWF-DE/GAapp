import { expect, test, type Browser, type Page } from '@playwright/test';
import { navLabels } from './helpers';
import { storageStateFor, type StoredUser } from './support/auth';
import { daysFrom, relativeDays, requestCloseOf, shortDate, tokyoToday } from './support/calendar';
import { createScenario, createUser, sql, type Scenario } from './support/db';
import { SMALL } from './support/datasets';
import { LEAD_NAV, loginWith } from './support/roles';
import { MOBILE, PC } from './support/shots';
import { SEED_USER_IDS } from './support/users';
import { pinYear } from './support/year';

// T16 ダッシュボード（/）と机椅子の状況（/furniture）（04「共通レイアウト」「ダッシュボード」「机椅子の状況」、D-51・D-52、
// notes/T16.md の E2E の 1〜10）。シナリオの年度（2001 年）で閉じる。1日目が過去なので、祭の日（前々日〜2日目）の締切と予定は
// 出ない（Vitest の lib/modules/furniture/portal.test.ts で確かめる）。シナリオの年度の1日目を未来に動かさない（seed の利用者の
// 既定の年度が変わり、並行のテストが崩れる。D-36）。締切と予定の欄の日付の曜日・相対の言い方と、予定と締切の項目（T18）は
// e2e/t18-calendar.spec.ts でも確かめる。
// 期待値の文言は 04 の「ダッシュボードに出すもの」の表のとおりに書く（アプリの定数から引かない）。

const todosWidget = (page: Page) => page.getByTestId('portal-todos');
const datedWidget = (page: Page) => page.getByTestId('portal-dated');
const cardsWidget = (page: Page) => page.getByTestId('portal-cards');
const todo = (page: Page, id: string) => page.locator(`[data-testid="portal-todo"][data-id="${id}"]`);
const datedItem = (page: Page, id: string) => page.locator(`[data-testid="portal-dated-item"][data-id="${id}"]`);
const furnitureCard = (page: Page) => page.locator('[data-testid="module-card"][data-module="furniture"]');
const repCard = (page: Page, group: string) => page.locator(`[data-testid="rep-card"][data-group="${group}"]`);

/** 要対応の id（出ている順） */
function todoIds(page: Page): Promise<string[]> {
  return todosWidget(page)
    .getByTestId('portal-todo')
    .evaluateAll((els) => els.map((e) => e.getAttribute('data-id') ?? ''));
}

/**
 * ダッシュボード（/）を開き、欄の読み込みが終わるのを待つ（h1 は総務に「ダッシュボード」、閲覧のみ・店長・副店長に「ホーム」）。
 * 欄は年度の行がそろうと同じ描画で読み込み中（portal-loading）を出すので、締切と予定の欄が見えた後に読み込み中が消えれば終わり
 */
async function openPortal(page: Page, h1: 'ダッシュボード' | 'ホーム'): Promise<void> {
  await page.goto('/');
  await expect(page.getByRole('heading', { level: 1, name: h1 })).toBeVisible();
  await expect(datedWidget(page)).toBeVisible();
  await expect(page.getByTestId('portal-loading')).toHaveCount(0);
  await expect(page.getByTestId('rep-home-loading')).toHaveCount(0);
}

/** 先読みのために覚えた id の localStorage のキーの頭（apps/web/lib/boot/early-load.ts の PREFETCH_HINT_PREFIX と同じ） */
const PREFETCH_HINT_PREFIX = 'gaapp:prefetch:';

/**
 * 前にこの年度を開いたことにする（先読みのために覚えた id：年度・その年度のロールと代表する団体。D-45。goto の前に呼ぶ）。
 * storageState の id は ログインの準備で開いた seed の年度のもので、シナリオの年度を pinYear で開くと、覚えた最新の年度
 * （seed の年度）を先に読んでしまう。ふだんの利用者は開いた年度を覚えているので、その形にそろえる。
 */
async function rememberYear(page: Page, userId: string, yearId: string, opts: { role?: string; groupIds?: string[] } = {}): Promise<void> {
  const hint = { latestYearId: yearId, years: { [yearId]: opts.groupIds ?? [] }, roles: opts.role ? { [yearId]: opts.role } : {} };
  await page.addInitScript(
    ([key, value]) => {
      try {
        globalThis.localStorage.setItem(key, value);
      } catch {
        // localStorage が使えなければ覚えない（先読みしないだけ）
      }
    },
    [`${PREFETCH_HINT_PREFIX}${userId}`, JSON.stringify(hint)] as const,
  );
}

/** 開いたときに覚えた、そのパスの読み取り（`gaapp:prefetch:<user_id>:requests`。立場が届いて 2 秒後に覚える）を待って返す */
async function recordedRequests(page: Page, userId: string, path: string): Promise<{ m: string; u: string }[]> {
  const key = `${PREFETCH_HINT_PREFIX}${userId}:requests`;
  await page.waitForFunction(
    ([k, p]) => {
      const v = JSON.parse(globalThis.localStorage.getItem(k) ?? 'null') as { paths?: Record<string, unknown> } | null;
      return !!v?.paths && Array.isArray(v.paths[p]);
    },
    [key, path] as const,
    { timeout: 15_000 },
  );
  return page.evaluate(
    ([k, p]) => (JSON.parse(globalThis.localStorage.getItem(k)!) as { paths: Record<string, { m: string; u: string }[]> }).paths[p]!,
    [key, path] as const,
  );
}

/** 別のブラウザのコンテキストで、その利用者がシナリオの年度を開くページ */
async function openAs(browser: Browser, user: StoredUser, s: Scenario): Promise<Page> {
  const context = await browser.newContext({ storageState: storageStateFor(user), viewport: PC });
  const page = await context.newPage();
  await pinYear(page, SEED_USER_IDS[user], s.yearId);
  return page;
}

/** 締切の短い表示（「11/30 17:05」。Asia/Tokyo。04 の「締切 10/5 17:00」の形を DB で作る） */
async function closeLabel(yearId: string): Promise<string> {
  const [r] = await sql<{ t: string }>(
    `select to_char(request_close_at at time zone 'Asia/Tokyo', 'FMMM/FMDD HH24:MI') as t from public.years where id = $1`,
    [yearId],
  );
  return r!.t;
}

/** キャスター机交換の了承の行（机(木) → キャスター机）を1つ入れる */
async function insertConsent(groupId: string, status: 'not_asked' | 'asked' | 'accepted' | 'declined'): Promise<void> {
  await sql(
    `insert into public.substitution_consents (group_id, from_item_id, to_item_id, status, count)
     select $1, f.id, t.id, $2::public.consent_status, 2 from public.items f, public.items t where f.code = 'desk' and t.code = 'caster_desk'
     on conflict (group_id, from_item_id, to_item_id) do update set status = excluded.status`,
    [groupId, status],
  );
}

// ---------------------------------------------------------------- Supabase への読み取り

interface RestRequest {
  /** /rest/v1/ の後ろ（表の名前か `rpc/<関数>`） */
  table: string;
  /** select（なければ null） */
  select: string | null;
  method: string;
  /**
   * アプリ（supabase-js。x-client-info のヘッダーがある）が送ったか。偽なら <head> の script が JS より先に送った読み取り
   * （覚えた読み取りの先送り。lib/boot/early-fetch.ts。D-45）
   */
  app: boolean;
}

/** ページが Supabase の /rest/v1/ に送ったリクエスト（CORS の preflight を除く）を集める。goto の前に呼ぶ */
function watchRest(page: Page): RestRequest[] {
  const out: RestRequest[] = [];
  page.on('request', (r) => {
    const u = new URL(r.url());
    const m = /\/rest\/v1\/(.+)$/.exec(u.pathname);
    if (!m || r.method() === 'OPTIONS') return;
    out.push({ table: m[1]!, select: u.searchParams.get('select'), method: r.method(), app: 'x-client-info' in r.headers() });
  });
  return out;
}

/** 立場の読み込み（lib/auth/load-membership.ts）。年度の行（years）は立場と一緒に読む（D-45） */
const MEMBERSHIP_READS = ['rpc/accept_my_invitations', 'profiles', 'year_roles', 'group_members', 'years'];

/**
 * ダッシュボードのお知らせの欄の新着（T17。04「お知らせ一覧」の「ダッシュボードに出すもの」：id・宛先・題名・ピン留め・出した日時だけ。
 * 総務は総務内、閲覧のみ・店長・副店長は団体あて。宛先と年度で絞り、5件）
 */
const NOTICES_LATEST_READ = 'notices?select=id,audience,title,pinned,created_at';

/**
 * ダッシュボードの締切と予定の欄の予定と締切の項目（T18。04「締切と予定」の「ダッシュボードに出すもの」：id・種類・題名・開始・終わり・
 * 終日だけ。対象・メモ・書いた人は読まない。年度で絞り、全部。1人1回）
 */
const EVENTS_DATED_READ = 'events?select=id,kind,title,starts_at,ends_at,all_day';

/** 机椅子の申請の締切の、締切と予定の欄の日付（曜日つき。「12/1（火）17:05」。T18）と相対の言い方（「あと 30 日」） */
async function closeDated(yearId: string): Promise<{ when: string; relative: string }> {
  const today = tokyoToday();
  const c = await requestCloseOf(yearId);
  return { when: `${shortDate(c.date, Number(today.slice(0, 4)))}${c.time}`, relative: relativeDays(daysFrom(today, c.date)) };
}

/** 版だけの読み取り（版の見張り・スナップショットの最初。years?select=allocation_version） */
const isVersionRead = (r: RestRequest) => r.table === 'years' && r.select === 'allocation_version';

/** 立場の読み込みのほかのリクエスト（`{メソッド} {表}?select={select}`） */
function readsBeyondMembership(reads: readonly RestRequest[]): string[] {
  return reads.filter((r) => !MEMBERSHIP_READS.includes(r.table)).map((r) => `${r.method} ${r.table}?select=${r.select ?? ''}`);
}

// ---------------------------------------------------------------- 総務

test.describe('T16 ダッシュボード（管理者）', () => {
  test.use({ storageState: storageStateFor('admin') });

  test('T16 管理者：要対応・締切と予定・机椅子のカードが出て、カードから机椅子の状況を開ける', async ({ page }) => {
    const s = await createScenario({ status: 'requesting', dataset: 'small', roles: { admin: true } });
    try {
      // 模擬店1 を未提出に、倉庫B を数えていないことにする
      await sql('delete from public.request_submissions where group_id = $1', [s.ids.groups[SMALL.groups.stall]]);
      await sql('delete from public.stocks where year_id = $1 and room_id = $2', [s.yearId, s.ids.rooms[SMALL.rooms.storageB]]);
      const close = await closeLabel(s.yearId);
      await pinYear(page, SEED_USER_IDS.admin, s.yearId);
      await openPortal(page, 'ダッシュボード');
      await expect(page.getByTestId('home-year')).toHaveText(`${s.label}（申請受付中）`);
      await expect(page.getByTestId('home-roles')).toHaveText('管理者');

      // 要対応：総務の分（締切の前なので、部門長以上の分はない）。同じふつうなら期日のあるものが先
      expect(await todoIds(page)).toEqual(['furniture:soumu:unsubmitted', 'furniture:soumu:uncounted']);
      const unsubmitted = todo(page, 'furniture:soumu:unsubmitted');
      await expect(unsubmitted).toHaveAttribute('data-severity', 'normal');
      await expect(unsubmitted).toHaveAttribute('data-module', 'furniture');
      await expect(unsubmitted).toContainText('机椅子');
      await expect(unsubmitted).toContainText('未提出 1 団体');
      await expect(unsubmitted.getByTestId('portal-todo-due')).toHaveText(`締切 ${close}`);
      await expect(unsubmitted.getByRole('link')).toHaveAttribute('href', /\/requests\/?\?filter=unsubmitted$/);
      const uncounted = todo(page, 'furniture:soumu:uncounted');
      await expect(uncounted).toContainText('在庫を数えていない保管場所 1 か所');
      await expect(uncounted).not.toContainText('締切');
      await expect(uncounted.getByRole('link')).toHaveAttribute('href', /\/stocks\/?$/);

      // 締切と予定：これからの締切だけ（受付開始と祭の日〔2001 年〕は過ぎている。予定と締切の項目〔T18〕はない）。日付は曜日つきで、
      // 相対の言い方（T18）。申請一覧へのリンク。欄の下に「締切と予定の一覧へ」（T18）
      await expect(datedWidget(page).getByTestId('portal-dated-item')).toHaveCount(1);
      const closeItem = datedItem(page, 'furniture:request-close');
      const dated = await closeDated(s.yearId);
      await expect(closeItem).toHaveAttribute('data-kind', 'deadline');
      await expect(closeItem.getByTestId('portal-dated-when')).toHaveText(dated.when);
      await expect(closeItem.getByTestId('portal-dated-relative')).toHaveText(dated.relative);
      await expect(closeItem).toContainText('締切');
      await expect(closeItem).toContainText('机椅子の申請の締切');
      await expect(closeItem.getByRole('link')).toHaveAttribute('href', /\/requests\/?$/);
      await expect(datedWidget(page).getByTestId('portal-dated-link')).toHaveAttribute('href', /\/calendar\/?$/);

      // 機能ごとの状況：机椅子のカード（数え方は机椅子の状況と同じ）から机椅子の状況へ
      const card = furnitureCard(page);
      await expect(card.getByRole('heading', { level: 3, name: '机椅子' })).toBeVisible();
      await expect(card.getByRole('listitem')).toHaveText([`申請受付中（締切 ${close}）`, '申請 2／3 団体が提出', '在庫 2／3 か所を数えた']);
      await card.getByRole('link', { name: '机椅子の状況へ' }).click();
      await expect(page).toHaveURL(/\/furniture\/$/);
      await expect(page.getByRole('heading', { level: 1, name: '机椅子の状況' })).toBeVisible();
      await expect(page.getByTestId('dashboard-year')).toBeVisible();
      await expect(page.getByTestId('dashboard-submissions')).toContainText('2 ／ 3団体');
      await expect(page.getByTestId('dashboard-stocks')).toContainText('2 ／ 3か所');
    } finally {
      await s.cleanup();
    }
  });

  test('T16 管理者：確定中で祭が終わっていれば「祭が終わりました…」の要対応が出て、机椅子の状況の「終了」へ。総務部門長には出ない', async ({
    page,
    browser,
  }) => {
    const s = await createScenario({ status: 'confirmed', dataset: 'small', roles: { admin: true, head: true } });
    const head = await openAs(browser, 'head', s);
    try {
      await pinYear(page, SEED_USER_IDS.admin, s.yearId);
      await openPortal(page, 'ダッシュボード');
      expect(await todoIds(page)).toEqual(['furniture:admin:close-year']);
      const close = todo(page, 'furniture:admin:close-year');
      await expect(close).toHaveAttribute('data-severity', 'normal');
      await expect(close).toContainText('祭が終わりました。年度データと振り分け表を書き出して、年度を終了してください');
      await expect(furnitureCard(page).getByRole('listitem').first()).toHaveText('確定');

      // 終了は管理者だけ（D-48）。総務部門長には出ない
      await openPortal(head, 'ダッシュボード');
      await expect(head.getByTestId('portal-todos-empty')).toHaveText('今やることはありません');

      await close.getByRole('link').click();
      await expect(page).toHaveURL(/\/furniture\/$/);
      await expect(page.getByTestId('year-status-actions').getByRole('button', { name: '終了' })).toBeVisible();
    } finally {
      await head.context().close();
      await s.cleanup();
    }
  });

  test('T16 総務の / は版・振り分けの行・ルールを読まない（机椅子の6つの表と、T17 のお知らせの新着と、T18 の予定と締切の項目を1回ずつ。在庫は room_id だけ）。先読みと、2回目の先送りでも1回ずつ', async ({
    page,
  }) => {
    const s = await createScenario({ status: 'requesting', dataset: 'small', roles: { admin: true } });
    // 机椅子の6つの表と、総務内のお知らせの新着（T17。本文・宛先の団体・書いた人は読まない）と、予定と締切の項目（T18。対象・メモ・
    // 書いた人は読まない）。並びは sort の順
    const FURNITURE_READS = [
      `GET ${EVENTS_DATED_READ}`,
      'GET groups?select=id,name,category,sort_order',
      `GET ${NOTICES_LATEST_READ}`,
      'GET request_submissions?select=group_id,submitted_at,groups!inner(year_id)',
      'GET room_years?select=room_id,usable',
      'GET rooms?select=id,name,is_storage,sort_order',
      'GET stocks?select=room_id',
      'GET substitution_consents?select=group_id,status,groups!inner(year_id)',
    ];
    try {
      // 前にこの年度を管理者として開いた（覚えたロールで、立場の読み込みと同時に机椅子の読み取りを始める。D-45）
      await rememberYear(page, SEED_USER_IDS.admin, s.yearId, { role: 'admin' });
      const reads = watchRest(page);
      await pinYear(page, SEED_USER_IDS.admin, s.yearId);
      await openPortal(page, 'ダッシュボード');
      await expect(furnitureCard(page)).toBeVisible();
      await page.waitForLoadState('networkidle');
      expect(reads.some((r) => r.table === 'year_roles'), '立場の読み込みを見ている').toBe(true);
      // 先読みと、要対応・カード・総務内のお知らせ・締切と予定の欄が同じ読み込み（キー）を使うので、表ごとに1回（締切と予定の欄の
      // 机椅子の日付は年度の行だけで決まり、予定と締切の項目〔T18〕だけを読む）
      expect(readsBeyondMembership(reads).sort()).toEqual(FURNITURE_READS);
      expect(reads.filter(isVersionRead), '版だけの読み取り').toEqual([]);

      // / は先送りしてよい画面（T16。D-45・D-51）：開いたときの読み取りを覚える。覚えたものに版・振り分けの行・ルールはない
      const recorded = await recordedRequests(page, SEED_USER_IDS.admin, '/');
      const recordedTables = recorded.map((r) => /^\/rest\/v1\/([^?]+)/.exec(r.u)?.[1] ?? r.u);
      for (const t of ['events', 'groups', 'notices', 'request_submissions', 'room_years', 'rooms', 'stocks', 'substitution_consents']) expect(recordedTables).toContain(t);
      expect(recordedTables.filter((t) => ['allocations', 'rules', 'requests', 'items', 'distance_overrides'].includes(t))).toEqual([]);
      expect(recorded.filter((r) => r.u.includes('select=allocation_version'))).toEqual([]);

      // 2回目：<head> の script が覚えた読み取りを JS より先に送り、アプリは同じリクエストならその応答を使う（送らない）。JS が
      // ブラウザのキャッシュからすぐに動くと、script より先にアプリが送ることがある（どちらの順でも中身は正しい。速さは e2e:perf で
      // 計る）ので、アプリの読み取りは表ごとに1回まで、script は覚えた読み取りだけ、合わせて8つの表がそろい、版を読まないことを見る
      reads.length = 0;
      await openPortal(page, 'ダッシュボード');
      await expect(furnitureCard(page)).toBeVisible();
      await page.waitForLoadState('networkidle');
      const byApp = readsBeyondMembership(reads.filter((r) => r.app));
      const early = readsBeyondMembership(reads.filter((r) => !r.app));
      expect(early.length, '<head> の script が覚えた読み取りを送った').toBeGreaterThan(0);
      expect(new Set(byApp).size, 'アプリの読み取りは表ごとに1回まで').toBe(byApp.length);
      expect(new Set(early).size, '<head> の script の読み取りは表ごとに1回まで').toBe(early.length);
      for (const r of early) expect(FURNITURE_READS).toContain(r);
      expect([...new Set([...byApp, ...early])].sort()).toEqual(FURNITURE_READS);
      expect(reads.filter(isVersionRead), '版だけの読み取り').toEqual([]);
    } finally {
      await s.cleanup();
    }
  });

  test('T16 欄の失敗：机椅子の読み込みが通信で失敗すると、要対応とカードに失敗と「もう一度」が出て、ほかの欄と年度だけの要対応は出る。もう一度で直る', async ({
    page,
  }) => {
    test.setTimeout(120_000);
    const s = await createScenario({ status: 'requesting', requestWindow: 'closed', dataset: 'small', roles: { admin: true } });
    const route = '**/rest/v1/request_submissions*';
    try {
      await sql('delete from public.request_submissions where group_id = $1', [s.ids.groups[SMALL.groups.stall]]);
      // 机椅子の総務の読み取り（6つの表）のうち、提出の記録を通信の失敗にする
      await page.route(route, (r) => r.abort());
      await pinYear(page, SEED_USER_IDS.admin, s.yearId);
      await page.goto('/');
      await expect(page.getByRole('heading', { level: 1, name: 'ダッシュボード' })).toBeVisible();
      // 年度の行だけで決まる要対応（締切を過ぎた）は、机椅子の読み込みを待たずに出る
      await expect(todo(page, 'furniture:lead:close-requests')).toBeVisible();

      // 失敗は supabase-js（3回）と TanStack Query（1回）が読み直した後に出る（15 秒ほど）
      const todoError = todosWidget(page).getByTestId('portal-module-error');
      await expect(todoError).toBeVisible({ timeout: 45_000 });
      await expect(todoError).toHaveAttribute('data-module', 'furniture');
      await expect(todoError).toContainText('机椅子：通信できませんでした。電波の良い所でもう一度');
      await expect(todoError.getByRole('button', { name: 'もう一度' })).toBeVisible();
      const cardError = cardsWidget(page).getByTestId('portal-module-error');
      await expect(cardError).toContainText('通信できませんでした');
      await expect(cardError.getByRole('button', { name: 'もう一度' })).toBeVisible();
      // カードの欄は、すぐ上の見出し「机椅子」と重ねないよう「机椅子：」を見た目では出さない（読み上げでは読む）。要対応の欄では出す
      await expect(cardsWidget(page).getByRole('heading', { level: 3, name: '机椅子' })).toBeVisible();
      await expect(cardError.getByTestId('portal-module-error-label')).toHaveClass(/\bsr-only\b/);
      await expect(todoError.getByTestId('portal-module-error-label')).toBeVisible();
      await expect(cardError.getByRole('link', { name: '机椅子の状況へ' })).toHaveAttribute('href', /\/furniture\/?$/);
      await expect(furnitureCard(page)).toHaveCount(0);

      // ほかは出したまま：立場の一覧・締切と予定の欄・年度だけの要対応。欄ごとの例外の表示にはならない。締切と予定は年度の行だけで
      // 決まるので、机椅子の失敗も読み込み中も出さない（決定 7）
      await expect(page.getByTestId('home-year')).toHaveText(`${s.label}（申請受付中）`);
      await expect(page.getByTestId('home-roles')).toHaveText('管理者');
      await expect(datedWidget(page).getByRole('heading', { level: 2, name: '締切と予定' })).toBeVisible();
      await expect(datedWidget(page).getByTestId('portal-module-error')).toHaveCount(0);
      await expect(datedWidget(page).getByTestId('portal-loading')).toHaveCount(0);
      await expect(page.getByTestId('portal-module-error')).toHaveCount(2);
      expect(await todoIds(page)).toEqual(['furniture:lead:close-requests']);
      await expect(todo(page, 'furniture:lead:close-requests')).toHaveAttribute('data-severity', 'urgent');
      const close = await closeLabel(s.yearId);
      await expect(todo(page, 'furniture:lead:close-requests').getByTestId('portal-todo-due')).toHaveText(`締切 ${close} を過ぎました`);
      await expect(page.getByTestId('portal-widget-error')).toHaveCount(0);

      // 通信が戻って要対応の「もう一度」を押すと、未提出の要対応とカードが出る（2つの欄は同じ読み込みなので、どちらの失敗も消える）
      await page.unroute(route);
      await todoError.getByRole('button', { name: 'もう一度' }).click();
      await expect(todo(page, 'furniture:soumu:unsubmitted')).toBeVisible();
      await expect(furnitureCard(page)).toBeVisible();
      await expect(page.getByTestId('portal-module-error')).toHaveCount(0);
      expect(await todoIds(page)).toEqual(['furniture:lead:close-requests', 'furniture:soumu:unsubmitted']);
      await expect(furnitureCard(page).getByRole('listitem')).toHaveText(['申請受付中（締切を過ぎました）', '申請 2／3 団体が提出', '在庫 3／3 か所を数えた']);
    } finally {
      await page.unroute(route).catch(() => undefined);
      await s.cleanup();
    }
  });
});

test('T16 部門長以上の要対応：受付期間が空・受付開始（過ぎたら急ぎ）・締切を過ぎた（急ぎ）・自動振り分けをしていない・了承の依頼中・確定が総務部門長に出て、総務部門員には出ない', async ({
  browser,
}) => {
  const s = await createScenario({ status: 'preparing', dataset: 'small', roles: { head: true, staff: true } });
  const head = await openAs(browser, 'head', s);
  const staff = await openAs(browser, 'staff', s);
  try {
    // 準備中で受付期間が空 → マスタ設定の年度へ
    await sql('update public.years set request_open_at = null, request_close_at = null where id = $1', [s.yearId]);
    await openPortal(head, 'ダッシュボード');
    expect(await todoIds(head)).toEqual(['furniture:lead:request-window']);
    const requestWindow = todo(head, 'furniture:lead:request-window');
    await expect(requestWindow).toContainText('申請の受付期間を入れてください（受付開始には未来の締切が要ります）');
    await expect(requestWindow.getByRole('link')).toHaveAttribute('href', /\/settings\/?\?tab=years$/);
    await openPortal(staff, 'ダッシュボード');
    await expect(staff.getByTestId('portal-todos-empty')).toHaveText('今やることはありません');

    // 準備中で受付期間が入った（受付開始の前）→ 受付開始（ふつう。期日なし）。机椅子の状況の「受付開始」へ（レビューの T16-UX-01）
    await sql(
      `update public.years set request_open_at = now() + interval '1 day', request_close_at = now() + interval '30 days' where id = $1`,
      [s.yearId],
    );
    await openPortal(head, 'ダッシュボード');
    expect(await todoIds(head)).toEqual(['furniture:lead:open-requests']);
    const openTodo = todo(head, 'furniture:lead:open-requests');
    await expect(openTodo).toHaveAttribute('data-severity', 'normal');
    await expect(openTodo).toContainText('受付期間が入りました。準備ができたら「受付開始」を押してください');
    await expect(openTodo.getByTestId('portal-todo-due')).toHaveCount(0);
    await expect(openTodo.getByRole('link')).toHaveAttribute('href', /\/furniture\/?$/);
    // 受付開始の日時を過ぎた → 急ぎ。押すと机椅子の状況で「受付開始」を押せる
    await sql(`update public.years set request_open_at = now() - interval '1 hour' where id = $1`, [s.yearId]);
    await openPortal(head, 'ダッシュボード');
    expect(await todoIds(head)).toEqual(['furniture:lead:open-requests']);
    await expect(openTodo).toHaveAttribute('data-severity', 'urgent');
    await expect(openTodo).toContainText('受付開始の日時を過ぎました。「受付開始」を押してください');
    await openTodo.getByRole('link').click();
    await expect(head).toHaveURL(/\/furniture\/$/);
    await expect(head.getByRole('heading', { level: 1, name: '机椅子の状況' })).toBeVisible();
    await expect(head.getByTestId('year-status-actions').getByRole('button', { name: '受付開始' })).toBeEnabled({ timeout: 15_000 });
    await openPortal(staff, 'ダッシュボード');
    await expect(staff.getByTestId('portal-todos-empty')).toBeVisible();

    // 受付中で締切を過ぎた → 急ぎ（期日は締切）。机椅子の状況の「締切（振り分けを始める）」へ
    await sql(
      `update public.years set status = 'requesting', request_open_at = now() - interval '30 days', request_close_at = now() - interval '1 day'
       where id = $1`,
      [s.yearId],
    );
    const close = await closeLabel(s.yearId);
    await openPortal(head, 'ダッシュボード');
    expect(await todoIds(head)).toEqual(['furniture:lead:close-requests']);
    const closeTodo = todo(head, 'furniture:lead:close-requests');
    await expect(closeTodo).toHaveAttribute('data-severity', 'urgent');
    await expect(closeTodo).toContainText('急ぎ');
    await expect(closeTodo).toContainText('申請の締切を過ぎました。「締切（振り分けを始める）」を押してください');
    await expect(closeTodo.getByTestId('portal-todo-due')).toHaveText(`締切 ${close} を過ぎました`);
    await expect(closeTodo.getByRole('link')).toHaveAttribute('href', /\/furniture\/?$/);
    await openPortal(staff, 'ダッシュボード');
    await expect(staff.getByTestId('portal-todos-empty')).toBeVisible();

    // 振り分け中：自動振り分けをしていない（auto_allocated_at が空）・了承の依頼中 1 団体
    await sql(`update public.years set status = 'allocating' where id = $1`, [s.yearId]);
    await insertConsent(s.ids.groups[SMALL.groups.stall]!, 'asked');
    await openPortal(head, 'ダッシュボード');
    expect(await todoIds(head)).toEqual(['furniture:lead:auto-allocate', 'furniture:lead:consents-asked']);
    await expect(todo(head, 'furniture:lead:auto-allocate')).toContainText('自動振り分けをしてください');
    await expect(todo(head, 'furniture:lead:auto-allocate').getByRole('link')).toHaveAttribute('href', /\/allocation\/?$/);
    const asked = todo(head, 'furniture:lead:consents-asked');
    await expect(asked).toContainText('キャスター机交換の了承の依頼中 1 団体');
    await expect(asked.getByRole('link')).toHaveAttribute('href', /\/swaps\/?$/);
    await expect(furnitureCard(head).getByRole('listitem').last()).toHaveText('了承の依頼中 1 団体');
    await openPortal(staff, 'ダッシュボード');
    await expect(staff.getByTestId('portal-todos-empty')).toBeVisible();
    // 総務部門員のカードにも了承の数は出る（キャスター机交換は開けないので、要対応にはしない）
    await expect(furnitureCard(staff).getByRole('listitem').last()).toHaveText('了承の依頼中 1 団体');

    // 自動振り分けを保存し、了承の依頼に答えが来た（依頼中・未依頼がない）→ 交換の画面で了承を確かめてから確定（レビューの T16-UX-01・2 回目）
    await sql(`update public.years set auto_allocated_at = now() where id = $1`, [s.yearId]);
    await insertConsent(s.ids.groups[SMALL.groups.stall]!, 'accepted');
    await openPortal(head, 'ダッシュボード');
    expect(await todoIds(head)).toEqual(['furniture:lead:confirm']);
    const confirmTodo = todo(head, 'furniture:lead:confirm');
    await expect(confirmTodo).toHaveAttribute('data-severity', 'normal');
    await expect(confirmTodo).toContainText('キャスター机交換の了承を確かめてから、検証の error を 0 件にして「確定」を押してください');
    await expect(confirmTodo.getByRole('link')).toHaveAttribute('href', /\/swaps\/?$/);
    await openPortal(staff, 'ダッシュボード');
    await expect(staff.getByTestId('portal-todos-empty')).toBeVisible();
  } finally {
    await head.context().close();
    await staff.context().close();
    await s.cleanup();
  }
});

// ---------------------------------------------------------------- 閲覧のみ・団体代表

test.describe('T16 ホーム（閲覧のみ）', () => {
  test.use({ storageState: storageStateFor('viewer') });

  test('T16 閲覧のみ：h1「ホーム」、要対応の欄がなく、机椅子のカードと締切と予定とお知らせ（T17）だけ。年度の行と立場のほかには、お知らせの新着と予定と締切の項目（T18）だけを読む', async ({
    page,
  }) => {
    const s = await createScenario({ status: 'allocating', dataset: 'small', roles: { viewer: true } });
    try {
      // 前にこの年度を閲覧のみとして開いた（覚えたロールが閲覧のみなら、/ で読むのは団体あてのお知らせの新着〔T17〕と予定と締切の
      // 項目〔T18〕だけ）
      await rememberYear(page, SEED_USER_IDS.viewer, s.yearId, { role: 'viewer' });
      const reads = watchRest(page);
      await pinYear(page, SEED_USER_IDS.viewer, s.yearId);
      await openPortal(page, 'ホーム');
      await expect(page.getByTestId('home-roles')).toHaveText('閲覧のみ');
      await expect(todosWidget(page)).toHaveCount(0);
      await expect(page.getByTestId('rep-card')).toHaveCount(0);
      // お知らせ（T17）：団体あての欄だけ（総務内のお知らせの欄はない）
      await expect(page.getByTestId('portal-notices').getByTestId('portal-notices-empty')).toHaveText('お知らせはありません');
      await expect(page.getByTestId('portal-soumu-notices')).toHaveCount(0);
      const card = furnitureCard(page);
      await expect(card.getByRole('listitem')).toHaveText(['振り分けが確定すると、ここから見られます']);
      await expect(card.getByRole('link')).toHaveCount(0);
      // 締切と予定（申請一覧も申請も開けないのでリンクにしない）
      const closeItem = datedItem(page, 'furniture:request-close');
      await expect(closeItem).toContainText('机椅子の申請の締切');
      await expect(closeItem.getByRole('link')).toHaveCount(0);

      await page.waitForLoadState('networkidle');
      expect(reads.some((r) => r.table === 'year_roles'), '立場の読み込みを見ている').toBe(true);
      expect(readsBeyondMembership(reads).sort(), '立場の読み込みのほかの読み取り').toEqual([`GET ${EVENTS_DATED_READ}`, `GET ${NOTICES_LATEST_READ}`]);
      expect(reads.filter(isVersionRead), '版だけの読み取り').toEqual([]);

      // 確定すると振り分け表へ
      await sql("update public.years set status = 'confirmed' where id = $1", [s.yearId]);
      await openPortal(page, 'ホーム');
      await expect(card.getByRole('listitem')).toHaveText(['振り分けが決まりました']);
      await card.getByRole('link', { name: '振り分け表を見る' }).click();
      await expect(page).toHaveURL(/\/allocation\/$/);
      await expect(page.getByRole('heading', { level: 1, name: '振り分け' })).toBeVisible();
    } finally {
      await s.cleanup();
    }
  });
});

test.describe('T16 ホーム（団体代表）', () => {
  test.use({ storageState: storageStateFor('rep') });

  test('T16 団体代表：要対応（未提出・交換の依頼・確定）・締切と予定・代表する団体のカード。在庫・振り分けの行・ルール・版を読まない（T17 のお知らせの新着と T18 の予定と締切の項目は読む）', async ({
    page,
  }) => {
    const s = await createScenario({ status: 'requesting', dataset: 'small', repGroup: SMALL.groups.stall });
    try {
      const gid = s.ids.groups[SMALL.groups.stall]!;
      await sql('delete from public.request_submissions where group_id = $1', [gid]);
      await insertConsent(gid, 'asked');
      const close = await closeLabel(s.yearId);
      // 前にこの年度を店長として開いた（覚えた団体で、立場の読み込みと同時に自団体の提出と了承を読み始める。D-45）
      await rememberYear(page, SEED_USER_IDS.rep, s.yearId, { groupIds: [gid] });
      const reads = watchRest(page);
      await pinYear(page, SEED_USER_IDS.rep, s.yearId);
      await openPortal(page, 'ホーム');
      await expect(page.getByTestId('home-roles')).toHaveText(`${SMALL.groups.stall} の店長`);
      await expect(cardsWidget(page)).toHaveCount(0);

      // 要対応：自団体の未提出（期日は締切）と交換の依頼
      expect(await todoIds(page)).toEqual([`furniture:rep:${gid}:unsubmitted`, `furniture:rep:${gid}:consent`]);
      const unsubmitted = todo(page, `furniture:rep:${gid}:unsubmitted`);
      await expect(unsubmitted).toHaveAttribute('data-severity', 'normal');
      await expect(unsubmitted).toContainText(`${SMALL.groups.stall}：申請が未提出です`);
      await expect(unsubmitted.getByTestId('portal-todo-due')).toHaveText(`締切 ${close}`);
      await expect(unsubmitted.getByRole('link')).toHaveAttribute('href', new RegExp(`/request/?\\?group=${gid}$`));
      const consent = todo(page, `furniture:rep:${gid}:consent`);
      await expect(consent).toContainText(`${SMALL.groups.stall}：キャスター机への交換の依頼に答えてください`);
      await expect(consent.getByRole('link')).toHaveAttribute('href', new RegExp(`/my/?\\?group=${gid}$`));

      // 締切と予定（申請の画面へ）と、代表する団体のカード（T16 より前のホームと同じ）
      await expect(datedItem(page, 'furniture:request-close').getByRole('link')).toHaveAttribute('href', /\/request\/?$/);
      const card = repCard(page, SMALL.groups.stall);
      await expect(card.getByTestId('rep-submission')).toHaveText('未提出');
      await expect(card.getByTestId('rep-consent-asked')).toContainText('キャスター机への交換の依頼があります');

      // 読むのは立場と、自団体の提出と了承と、お知らせの新着（T17）と予定と締切の項目（T18）だけ（先読み・代表する団体のカード・
      // 要対応・お知らせ・締切と予定の欄が同じ読み込みを使うので、1回ずつ）
      await page.waitForLoadState('networkidle');
      expect(reads.some((r) => r.table === 'year_roles'), '立場の読み込みを見ている').toBe(true);
      expect(readsBeyondMembership(reads).map((r) => r.split('?')[0]).sort()).toEqual([
        'GET events',
        'GET notices',
        'GET request_submissions',
        'GET substitution_consents',
      ]);
      expect(readsBeyondMembership(reads)).toContain(`GET ${NOTICES_LATEST_READ}`);
      expect(readsBeyondMembership(reads)).toContain(`GET ${EVENTS_DATED_READ}`);
      expect(reads.filter(isVersionRead), '版だけの読み取り').toEqual([]);

      // 締切まで 24 時間を切ると、未提出は急ぎ
      await sql("update public.years set request_close_at = now() + interval '2 hours' where id = $1", [s.yearId]);
      await openPortal(page, 'ホーム');
      await expect(unsubmitted).toHaveAttribute('data-severity', 'urgent');
      await expect(unsubmitted).toContainText('急ぎ');
      expect(await todoIds(page)).toEqual([`furniture:rep:${gid}:unsubmitted`, `furniture:rep:${gid}:consent`]);

      // 確定：振り分けが決まりました（参考。機能の「お知らせ」と取り違えないよう「お知らせ」と書かない）。未提出と交換の依頼は出ない
      await sql("update public.years set status = 'confirmed' where id = $1", [s.yearId]);
      await openPortal(page, 'ホーム');
      expect(await todoIds(page)).toEqual([`furniture:rep:${gid}:final`]);
      const final = todo(page, `furniture:rep:${gid}:final`);
      await expect(final).toHaveAttribute('data-severity', 'info');
      await expect(final).toContainText('参考');
      await expect(final).not.toContainText('お知らせ');
      await expect(final).toContainText(`${SMALL.groups.stall}：振り分けが決まりました`);
      await expect(final.getByRole('link')).toHaveAttribute('href', new RegExp(`/my/?\\?group=${gid}$`));
      await expect(card.getByTestId('rep-final')).toContainText('振り分けが決まりました');
    } finally {
      await s.cleanup();
    }
  });
});

// 部門のロール（総務部門長・副部門長・部門員）は同じ年度の店長・副店長を兼ねられない（D-49）ので、兼ねられる管理者で確かめる
// （使い捨てのユーザー。D-36。T16 より前は t09-dashboard.spec.ts の「団体代表のカードがダッシュボードの上に出る」）
test('T16 管理者で店長も務める人：ダッシュボードに代表する団体のカードと自団体の要対応が出る。机椅子の状況には出ない', async ({ page }) => {
  const u = await createUser({ purpose: 'adminrep' });
  const s = await createScenario({
    status: 'requesting',
    dataset: 'small',
    grants: [{ userId: u.id, role: 'admin' }],
    groupMembers: [{ userId: u.id, group: SMALL.groups.department }],
  });
  try {
    const gid = s.ids.groups[SMALL.groups.department]!;
    await sql('delete from public.request_submissions where group_id = $1', [gid]);
    await loginWith(page, u);
    await openPortal(page, 'ダッシュボード');
    await expect(page.getByTestId('home-roles')).toHaveText(`管理者${SMALL.groups.department} の店長`);
    // 要対応は1つの欄に（総務の未提出と、自団体の未提出。同じ期日なら総務 → 団体代表の順）
    expect(await todoIds(page)).toEqual(['furniture:soumu:unsubmitted', `furniture:rep:${gid}:unsubmitted`]);
    await expect(todo(page, `furniture:rep:${gid}:unsubmitted`)).toContainText(`${SMALL.groups.department}：申請が未提出です`);
    // 代表する団体のカードは、要対応・締切と予定の後、機能ごとの状況の前
    const card = repCard(page, SMALL.groups.department);
    await expect(card.getByTestId('rep-submission')).toHaveText('未提出');
    await expect(furnitureCard(page)).toBeVisible();
    const top = async (l: ReturnType<Page['locator']>) => (await l.boundingBox())!.y;
    expect(await top(card)).toBeGreaterThan(await top(todosWidget(page)));
    expect(await top(card)).toBeLessThan(await top(furnitureCard(page)));

    // 机椅子の状況には、立場の一覧と代表する団体のカードを出さない
    await page.goto('/furniture/');
    await expect(page.getByRole('heading', { level: 1, name: '机椅子の状況' })).toBeVisible();
    await expect(page.getByTestId('dashboard-year')).toBeVisible();
    await expect(page.getByTestId('rep-card')).toHaveCount(0);
    await expect(page.getByTestId('home-roles')).toHaveCount(0);
  } finally {
    await s.cleanup();
    await u.cleanup();
  }
});

// ---------------------------------------------------------------- ナビ・名前

test.describe('T16 ナビの見出し（管理者・PC）', () => {
  test.use({ storageState: storageStateFor('admin'), viewport: PC });

  test('T16 ナビ（PC）：見出し「机椅子」「お知らせ」（T17）「締切と予定」（T18）「共通」の中に項目が並び（「ホーム」の見出しは見た目では出さない）、机椅子の状況を開くと aria-current', async ({
    page,
  }) => {
    await page.goto('/');
    const nav = page.getByRole('navigation', { name: 'メインメニュー' });
    await expect(nav).toBeVisible();
    const home = nav.getByRole('group', { name: 'ホーム' });
    await expect(home.getByRole('heading', { level: 2, name: 'ホーム' })).toHaveClass(/\bsr-only\b/);
    await expect(home.getByRole('link')).toHaveText(['ホーム']);
    await expect(home.getByRole('link', { name: 'ホーム' })).toHaveAttribute('aria-current', 'page');
    const furniture = nav.getByRole('group', { name: '机椅子' });
    await expect(furniture.getByRole('heading', { level: 2, name: '机椅子' })).toBeVisible();
    await expect(furniture.getByRole('link')).toHaveText(['机椅子の状況', '在庫入力', '在庫一覧', '申請一覧', 'ルール', '振り分け', 'キャスター机交換']);
    // お知らせ（T17）：機能の登録の順で、机椅子の後・共通の前
    const notices = nav.getByRole('group', { name: 'お知らせ' });
    await expect(notices.getByRole('heading', { level: 2, name: 'お知らせ' })).toBeVisible();
    await expect(notices.getByRole('link')).toHaveText(['お知らせ一覧']);
    // 締切と予定（T18）：お知らせの後・共通の前。項目は「締切と予定の一覧」（見出しと同じ言葉を縦に並べない。お知らせと同じ形。D-54）
    const calendar = nav.getByRole('group', { name: '締切と予定' });
    await expect(calendar.getByRole('heading', { level: 2, name: '締切と予定' })).toBeVisible();
    await expect(calendar.getByRole('link')).toHaveText(['締切と予定の一覧']);
    await expect(nav.getByRole('group')).toHaveCount(5);
    const common = nav.getByRole('group', { name: '共通' });
    await expect(common.getByRole('heading', { level: 2, name: '共通' })).toBeVisible();
    await expect(common.getByRole('link')).toHaveText(['マスタ設定', '履歴']);
    // 見出しを除いた項目の平らな一覧（E2E の navLabels）は見出しの順
    expect(await navLabels(page)).toEqual(LEAD_NAV);

    await furniture.getByRole('link', { name: '机椅子の状況' }).click();
    await expect(page).toHaveURL(/\/furniture\/$/);
    await expect(page.getByRole('heading', { level: 1, name: '机椅子の状況' })).toBeVisible();
    await expect(furniture.getByRole('link', { name: '机椅子の状況' })).toHaveAttribute('aria-current', 'page');
    await expect(nav.locator('[aria-current="page"]')).toHaveCount(1);
  });
});

test.describe('T16 ナビの見出し（総務部門員・スマホ）', () => {
  test.use({ storageState: storageStateFor('staff'), viewport: MOBILE });

  test('T16 ナビ（スマホ）：メニューの見出しは「机椅子」「お知らせ」（T17）「締切と予定」（T18）まで（共通はない）。机椅子の状況を開くとメニューが閉じ、開き直すと aria-current', async ({
    page,
  }) => {
    await page.goto('/');
    await expect(page.getByRole('heading', { level: 1, name: 'ダッシュボード' })).toBeVisible();
    await expect(page.getByRole('navigation')).toHaveCount(0);
    const open = page.getByRole('button', { name: 'メニューを開く' });
    await open.click();
    const menu = page.locator('#app-mobile-nav');
    const nav = menu.getByRole('navigation', { name: 'メインメニュー' });
    await expect(nav.getByRole('group')).toHaveCount(4);
    await expect(nav.getByRole('group', { name: 'ホーム' }).getByRole('link')).toHaveText(['ホーム']);
    const furniture = nav.getByRole('group', { name: '机椅子' });
    await expect(furniture.getByRole('link')).toHaveText(['机椅子の状況', '在庫入力', '在庫一覧', '申請一覧', '振り分け']);
    await expect(nav.getByRole('group', { name: 'お知らせ' }).getByRole('link')).toHaveText(['お知らせ一覧']);
    await expect(nav.getByRole('group', { name: '締切と予定' }).getByRole('link')).toHaveText(['締切と予定の一覧']);
    await expect(nav.getByRole('group', { name: '共通' })).toHaveCount(0);
    expect(await page.evaluate<number>('document.documentElement.scrollWidth')).toBeLessThanOrEqual(MOBILE.width);

    await furniture.getByRole('link', { name: '机椅子の状況' }).click();
    await expect(page).toHaveURL(/\/furniture\/$/);
    await expect(menu).toHaveCount(0);
    await expect(page.getByRole('heading', { level: 1, name: '机椅子の状況' })).toBeVisible();
    await open.click();
    await expect(furniture.getByRole('link', { name: '机椅子の状況' })).toHaveAttribute('aria-current', 'page');
    await expect(nav.locator('[aria-current="page"]')).toHaveCount(1);
  });
});

test('T16 名前：ログイン・ヘッダー・ページの title は「電波祭 総務」（スマホのヘッダーは「総務」）、マニフェストの name・short_name・description', async ({
  page,
  browser,
  request,
}) => {
  await page.goto('/login/');
  await expect(page.getByRole('heading', { level: 1, name: 'ログイン' })).toBeVisible();
  await expect(page.getByText('電波祭 総務', { exact: true })).toBeVisible();
  await expect(page).toHaveTitle('電波祭 総務');

  const ctx = await browser.newContext({ storageState: storageStateFor('admin'), viewport: PC });
  try {
    const app = await ctx.newPage();
    await app.goto('/');
    await expect(app.getByTestId('current-year')).toBeVisible();
    await expect(app.getByTestId('app-name')).toHaveText('電波祭 総務');
    await expect(app).toHaveTitle('電波祭 総務');
    await app.setViewportSize(MOBILE);
    await expect.poll(() => app.getByTestId('app-name').innerText()).toBe('総務');

    // マニフェスト（<link rel="manifest"> の先）
    const href = await app.locator('link[rel="manifest"]').getAttribute('href');
    expect(href).toBeTruthy();
    const res = await request.get(href!);
    expect(res.status()).toBe(200);
    const manifest = (await res.json()) as { name: string; short_name: string; description: string };
    expect(manifest.name).toBe('電波祭 総務');
    expect(manifest.short_name).toBe('総務');
    expect(manifest.description).toBe('電波祭の総務部門の仕事をまとめるアプリ（机椅子の在庫・申請・振り分けなど）');
  } finally {
    await ctx.close();
  }
});
