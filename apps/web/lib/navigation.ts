import type { Audience, YearStatus } from '@/lib/auth/membership';

// 画面のルートと立場（画面の設計 1.1・1.3。T09a）。ナビ・ページの守り（RequireAudience）・画面の中のリンク（AppLink）を、
// この表1か所で決める。各チケットは自分のページのファイルを中身に置き換えるだけで、このファイルを触らない（8.2）。
// 動きのある部分（useGuardedRouter・useCanOpen）は lib/navigation/ に置く（このファイルは純粋な関数だけ）。

export interface RouteDef {
  href: string;
  label: string;
  /** 開ける立場（00「画面一覧」のロール。総務＝admin・staff、団体＝rep） */
  audiences: readonly Audience[];
  /** audiences のうち、振り分けが決まった（確定・終了の）年度でだけ開ける立場（Q1：viewer の振り分け表。D-39） */
  finalOnly?: readonly Audience[];
  /** ナビに出すか（/stocks/qr は在庫一覧から開く） */
  nav: boolean;
  /** 中身を作るチケット（雛形のページの「準備中（T10）」に出す） */
  ticket: string;
}

export interface NavItem {
  href: string;
  label: string;
  audiences: readonly Audience[];
  finalOnly?: readonly Audience[];
  /** 画面ができているか。T09a で全画面に雛形のページを置いたので、すべて true */
  ready: boolean;
}

const ALL: readonly Audience[] = ['admin', 'staff', 'viewer', 'rep'];

// 00_overview.md「画面一覧」のフェーズ1の画面。順番はナビゲーションの並び。
export const ROUTES: readonly RouteDef[] = [
  { href: '/', label: 'ホーム', audiences: ALL, nav: true, ticket: 'T09' },
  { href: '/settings', label: 'マスタ設定', audiences: ['admin'], nav: true, ticket: 'T09' },
  { href: '/stock', label: '在庫入力', audiences: ['admin', 'staff'], nav: true, ticket: 'T10' },
  { href: '/stocks', label: '在庫一覧', audiences: ['admin', 'staff'], nav: true, ticket: 'T10' },
  { href: '/stocks/qr', label: '部屋の QR の印刷', audiences: ['admin', 'staff'], nav: false, ticket: 'T10' },
  { href: '/requests', label: '申請一覧', audiences: ['admin', 'staff'], nav: true, ticket: 'T11' },
  { href: '/rules', label: 'ルール', audiences: ['admin'], nav: true, ticket: 'T12' },
  // Q1（D-39）：staff はいつでも読み取り専用、viewer は確定後だけ
  { href: '/allocation', label: '振り分け', audiences: ['admin', 'staff', 'viewer'], finalOnly: ['viewer'], nav: true, ticket: 'T13' },
  { href: '/swaps', label: 'キャスター机交換', audiences: ['admin'], nav: true, ticket: 'T13' },
  { href: '/history', label: '履歴', audiences: ['admin'], nav: true, ticket: 'T14' },
  { href: '/request', label: '申請', audiences: ['rep'], nav: true, ticket: 'T11' },
  { href: '/my', label: '自団体の振り分け', audiences: ['rep'], nav: true, ticket: 'T13' },
];

export const NAV_ITEMS: readonly NavItem[] = ROUTES.filter((r) => r.nav).map(({ href, label, audiences, finalOnly }) => ({
  href,
  label,
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

/**
 * 今の立場でそのページを開けるか（画面の中のリンクを出し分ける。1.1）。
 * 表にないパス（/login など）は判定しないので真。
 */
export function canOpen(href: string, audiences: readonly Audience[], yearStatus?: YearStatus | null): boolean {
  const r = routeFor(href);
  if (!r) return true;
  return allowed(r, yearStatus).some((a) => audiences.includes(a));
}

/** その人に見せるナビゲーションの項目（立場のどれかが合うもの） */
export function navItemsFor(
  audiences: readonly Audience[],
  yearStatus?: YearStatus | null,
  items: readonly NavItem[] = NAV_ITEMS,
): NavItem[] {
  return items.filter((item) => allowed(item, yearStatus).some((a) => audiences.includes(a)));
}

/** 今のパスがその項目に当たるか（trailingSlash とクエリは無視する） */
export function isActivePath(pathname: string, href: string): boolean {
  return normalizePath(pathname) === normalizePath(href);
}
