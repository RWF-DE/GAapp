import type { Audience, YearStatus } from '@/lib/auth/membership';
import { APP_ROLES, isAdmin, isLead, LEAD_ROLES, SOUMU_ROLES, type AppRole } from '@/lib/auth/roles';
import { MODULES, type ModuleId } from '@/lib/modules/registry';

// 画面のルートと立場（画面の設計 1.1・1.3。T09a）。ナビ・ページの守り（RequireAudience）・画面の中のリンク（AppLink）を、
// この表1か所で決める。各チケットは自分のページのファイルを中身に置き換えるだけで、このファイルを触らない（8.2）。
// 動きのある部分（useGuardedRouter・useCanOpen）は lib/navigation/ に置く（このファイルは純粋な関数だけ）。
// 立場はロールの段（lib/auth/roles.ts。D-48・D-50）から作り、画面ごとにロールを並べ直さない（04「共通レイアウト」の表）。
// ナビは見出し（NAV_SECTIONS：ホーム → 機能〔lib/modules/registry.ts の MODULES の順〕→ 共通）ごとにまとめる（T16。D-51・D-52）。
// 機能のチケット（T17〜T21）は、自分の見出しの行（section がその機能の id のルート）を ROUTES の自分の見出しの所に足す
// （見出しは MODULES に1行足せば増える。05「チケット分割」）。

/** ナビの見出し：ホーム・機能ごと（ModuleId）・共通（マスタ設定・履歴） */
export type NavSectionId = 'home' | ModuleId | 'common';

/** ナビの見出し（並びは表示の順。機能の見出しは MODULES の label。T16） */
export const NAV_SECTIONS: readonly { id: NavSectionId; heading: string }[] = [
  { id: 'home', heading: 'ホーム' },
  ...MODULES.map((m) => ({ id: m.id, heading: m.label })),
  { id: 'common', heading: '共通' },
];

export interface RouteDef {
  href: string;
  label: string;
  /** ナビの見出し（NAV_SECTIONS の id。ROUTES は見出しの順にまとめて並べる） */
  section: NavSectionId;
  /** 開ける立場（04「共通レイアウト」の表。部門長以上＝LEAD_ROLES、総務＝SOUMU_ROLES、団体＝rep） */
  audiences: readonly Audience[];
  /** audiences のうち、振り分けが決まった（確定・終了の）年度でだけ開ける立場（Q1：viewer の振り分け表。D-39） */
  finalOnly?: readonly Audience[];
  /** finalOnly の立場だけを持つ人が、確定前に開いたときに「権限がありません」に添える説明 */
  finalOnlyNote?: string;
  /** ナビに出すか（/stocks/qr は在庫一覧から開く） */
  nav: boolean;
  /** 中身を作るチケット（雛形のページの「準備中（T10）」に出す） */
  ticket: string;
}

export interface NavItem {
  href: string;
  label: string;
  /** ナビの見出し */
  section: NavSectionId;
  audiences: readonly Audience[];
  finalOnly?: readonly Audience[];
  /** 画面ができているか。T09a で全画面に雛形のページを置いたので、すべて true */
  ready: boolean;
}

/** どの立場でも（5つのロールと団体代表） */
const ALL: readonly Audience[] = [...APP_ROLES, 'rep'];
/** 部門長以上（管理者・総務部門長・総務副部門長） */
const LEAD: readonly Audience[] = LEAD_ROLES;
/** 総務（部門長以上と総務部門員） */
const SOUMU: readonly Audience[] = SOUMU_ROLES;
/** 団体代表（店長・副店長） */
const REP: readonly Audience[] = ['rep'];

/** 閲覧のみが確定前に振り分けを開いたときの説明（04「共通レイアウト」。T13-1） */
export const ALLOCATION_BEFORE_FINAL_NOTE = '振り分けは確定後に表示されます。';

// 00_overview.md「画面一覧」のフェーズ1の画面。順番はナビゲーションの並びで、見出し（section）ごとにひと続きにし、
// 見出しは NAV_SECTIONS の順に並べる（navItemsFor の平らな一覧と、見出しごとの表示を同じ並びにする。T16）。
export const ROUTES: readonly RouteDef[] = [
  // ホーム（ダッシュボード。D-51）
  { href: '/', label: 'ホーム', section: 'home', audiences: ALL, nav: true, ticket: 'T16' },
  // 机椅子（furniture）
  { href: '/furniture', label: '机椅子の状況', section: 'furniture', audiences: SOUMU, nav: true, ticket: 'T16' },
  { href: '/stock', label: '在庫入力', section: 'furniture', audiences: SOUMU, nav: true, ticket: 'T10' },
  { href: '/stocks', label: '在庫一覧', section: 'furniture', audiences: SOUMU, nav: true, ticket: 'T10' },
  { href: '/stocks/qr', label: '部屋の QR の印刷', section: 'furniture', audiences: SOUMU, nav: false, ticket: 'T10' },
  { href: '/requests', label: '申請一覧', section: 'furniture', audiences: SOUMU, nav: true, ticket: 'T11' },
  { href: '/rules', label: 'ルール', section: 'furniture', audiences: LEAD, nav: true, ticket: 'T12' },
  // Q1（D-39）：総務部門員はいつでも読み取り専用、viewer は確定後だけ
  {
    href: '/allocation',
    label: '振り分け',
    section: 'furniture',
    audiences: [...SOUMU, 'viewer'],
    finalOnly: ['viewer'],
    finalOnlyNote: ALLOCATION_BEFORE_FINAL_NOTE,
    nav: true,
    ticket: 'T13',
  },
  { href: '/swaps', label: 'キャスター机交換', section: 'furniture', audiences: LEAD, nav: true, ticket: 'T13' },
  { href: '/request', label: '申請', section: 'furniture', audiences: REP, nav: true, ticket: 'T11' },
  { href: '/my', label: '自団体の振り分け', section: 'furniture', audiences: REP, nav: true, ticket: 'T13' },
  // お知らせ（notices。T17・D-53）：招待されている全員（総務・閲覧のみ・店長・副店長）。項目は見出し（お知らせ）と同じ言葉を
  // 縦に並べないよう「お知らせ一覧」（notes/T17.md の後半の判断したことの 1）
  { href: '/notices', label: 'お知らせ一覧', section: 'notices', audiences: ALL, nav: true, ticket: 'T17' },
  // 共通（部門長・副部門長はマスタ設定の一部のタブだけ。settingsTabsFor）
  { href: '/settings', label: 'マスタ設定', section: 'common', audiences: LEAD, nav: true, ticket: 'T09' },
  { href: '/history', label: '履歴', section: 'common', audiences: LEAD, nav: true, ticket: 'T14' },
];

export const NAV_ITEMS: readonly NavItem[] = ROUTES.filter((r) => r.nav).map(({ href, label, section, audiences, finalOnly }) => ({
  href,
  label,
  section,
  audiences,
  ...(finalOnly ? { finalOnly } : {}),
  ready: true,
}));

/** パスだけにする（クエリ・ハッシュ・末尾の / を外す） */
export function normalizePath(href: string): string {
  const path = href.split(/[?#]/, 1)[0] ?? '';
  return path.replace(/\/+$/, '') || '/';
}

/** そのパスのルート（表にないパスは undefined） */
export function routeFor(href: string): RouteDef | undefined {
  const p = normalizePath(href);
  return ROUTES.find((r) => r.href === p);
}

const isFinal = (s: YearStatus | null | undefined) => s === 'confirmed' || s === 'closed';

function allowed(item: Pick<RouteDef, 'audiences' | 'finalOnly'>, yearStatus: YearStatus | null | undefined): Audience[] {
  return item.audiences.filter((a) => !item.finalOnly?.includes(a) || isFinal(yearStatus));
}

/**
 * そのページを開ける立場（年度の状態で変わるものは yearStatus で決める。分からなければ finalOnly の立場を除く）。
 * 表にないパスは空（RequireAudience に渡すと誰も開けない）。
 *
 * @example
 * <RequireAudience allow={audiencesFor('/stocks')}>…</RequireAudience>
 */
export function audiencesFor(href: string, yearStatus?: YearStatus | null): Audience[] {
  const r = routeFor(href);
  return r ? allowed(r, yearStatus) : [];
}

// ---- マスタ設定のタブ（D-50。canOpen が `/settings?tab=…` を見るので、データの層ではなくここに置く） ----

/** マスタ設定のタブ（`?tab=`。並びはタブの並び） */
export const SETTINGS_TABS = ['years', 'rooms', 'items', 'groups', 'distance', 'users', 'export'] as const;
export type SettingsTab = (typeof SETTINGS_TABS)[number];

/** 総務部門長・総務副部門長のタブ：年度（受付期間だけ変えられる）・場所（今年の使用だけ）・ユーザー（総務部門員と店長・副店長） */
const LEAD_SETTINGS_TABS: readonly SettingsTab[] = ['years', 'rooms', 'users'];

/**
 * そのロールで開けるマスタ設定のタブ（並びはタブの並び。最初のものが、開けないタブ・知らない値の `?tab=` の行き先）。
 * 管理者はすべて、総務部門長・総務副部門長は年度・場所・ユーザーだけ、ほかは何もない（マスタ設定を開けない）。
 *
 * @example
 * settingsTabsFor('head') // ['years', 'rooms', 'users']
 */
export function settingsTabsFor(role: AppRole | null | undefined): readonly SettingsTab[] {
  if (isAdmin(role)) return SETTINGS_TABS;
  if (isLead(role)) return LEAD_SETTINGS_TABS;
  return [];
}

/** `/settings?tab=X` の X（パスがマスタ設定でないか、tab がない・空なら null。知らない値もそのまま返す） */
function settingsTabParam(href: string): string | null {
  if (normalizePath(href) !== '/settings') return null;
  const noHash = href.split('#', 1)[0] ?? '';
  const q = noHash.indexOf('?');
  return (q < 0 ? null : new URLSearchParams(noHash.slice(q + 1)).get('tab')) || null;
}

/**
 * 今の立場でそのページを開けるか（画面の中のリンクを出し分ける。1.1）。
 * 表にないパス（/login など）は判定しないので真。マスタ設定のタブへのリンク（`/settings?tab=X`）は、立場のどれかで
 * X のタブを開けるときだけ真（D-50。部門長・副部門長に団体・品目・距離・書き出しのタブへのリンクを出さない。
 * tab のない /settings と、ページの守り〔RequireAudience・audiencesFor〕はパスだけを見る）。
 */
export function canOpen(href: string, audiences: readonly Audience[], yearStatus?: YearStatus | null): boolean {
  const r = routeFor(href);
  if (!r) return true;
  if (!allowed(r, yearStatus).some((a) => audiences.includes(a))) return false;
  const tab = settingsTabParam(href);
  return tab === null || audiences.some((a) => a !== 'rep' && (settingsTabsFor(a) as readonly string[]).includes(tab));
}

/**
 * 確定前の年度のために開けないとき（finalOnly の立場では開けるが、年度がまだ確定・終了でない）の説明（04「共通レイアウト」：
 * 閲覧のみが確定前に振り分けを開いたときは「振り分けは確定後に表示されます」を添える）。ほかは null（ほかの立場で開ける・
 * 年度の状態によらず開けない・表にないパス）。
 */
export function finalOnlyNoteFor(href: string, audiences: readonly Audience[], yearStatus?: YearStatus | null): string | null {
  const r = routeFor(href);
  if (!r?.finalOnly || !r.finalOnlyNote || isFinal(yearStatus)) return null;
  if (allowed(r, yearStatus).some((a) => audiences.includes(a))) return null;
  return r.finalOnly.some((a) => audiences.includes(a)) ? r.finalOnlyNote : null;
}

/** その人に見せるナビゲーションの項目（立場のどれかが合うもの。平らな一覧で、並びは見出しの順） */
export function navItemsFor(
  audiences: readonly Audience[],
  yearStatus?: YearStatus | null,
  items: readonly NavItem[] = NAV_ITEMS,
): NavItem[] {
  return items.filter((item) => allowed(item, yearStatus).some((a) => audiences.includes(a)));
}

/** ナビの見出しと、その下の項目 */
export interface NavSection {
  id: NavSectionId;
  heading: string;
  items: NavItem[];
}

/**
 * その人に見せるナビゲーションを見出しごとに（NAV_SECTIONS の順。項目のない見出しは除く。T16。04「共通レイアウト」）。
 * 項目は navItemsFor と同じもの（見出しごとの items を順につなぐと navItemsFor と同じ並び）。
 *
 * @example
 * navSectionsFor(['staff']).map((s) => s.heading) // ['ホーム', '机椅子', 'お知らせ']
 */
export function navSectionsFor(
  audiences: readonly Audience[],
  yearStatus?: YearStatus | null,
  items: readonly NavItem[] = NAV_ITEMS,
): NavSection[] {
  const mine = navItemsFor(audiences, yearStatus, items);
  return NAV_SECTIONS.map((s) => ({ ...s, items: mine.filter((i) => i.section === s.id) })).filter((s) => s.items.length > 0);
}

/** 今のパスがその項目に当たるか（trailingSlash とクエリは無視する） */
export function isActivePath(pathname: string, href: string): boolean {
  return normalizePath(pathname) === normalizePath(href);
}
