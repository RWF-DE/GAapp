import type { Audience } from '@/lib/auth/membership';

export interface NavItem {
  href: string;
  label: string;
  /** 見せる立場（00「画面一覧」のロール。総務＝admin・staff、団体＝rep） */
  audiences: readonly Audience[];
  /** 画面ができているか。できていない画面は「準備中」として、リンクにしない（各チケットで true にする） */
  ready: boolean;
}

// 00_overview.md「画面一覧」のフェーズ1の画面。順番はナビゲーションの並び。
export const NAV_ITEMS: readonly NavItem[] = [
  { href: '/', label: 'ホーム', audiences: ['admin', 'staff', 'viewer', 'rep'], ready: true },
  { href: '/settings', label: 'マスタ設定', audiences: ['admin'], ready: false }, // T09
  { href: '/stock', label: '在庫入力', audiences: ['admin', 'staff'], ready: false }, // T10
  { href: '/stocks', label: '在庫一覧', audiences: ['admin', 'staff'], ready: false }, // T10
  { href: '/requests', label: '申請一覧', audiences: ['admin', 'staff'], ready: false }, // T11
  { href: '/rules', label: 'ルール', audiences: ['admin'], ready: false }, // T12
  { href: '/allocation', label: '振り分け', audiences: ['admin'], ready: false }, // T13
  { href: '/swaps', label: 'キャスター机交換', audiences: ['admin'], ready: false }, // T13
  { href: '/history', label: '履歴', audiences: ['admin'], ready: false }, // T14
  { href: '/request', label: '申請', audiences: ['rep'], ready: false }, // T11
  { href: '/my', label: '自団体の振り分け', audiences: ['rep'], ready: false }, // T13
];

/** その人に見せるナビゲーションの項目（立場のどれかが合うもの） */
export function navItemsFor(audiences: readonly Audience[], items: readonly NavItem[] = NAV_ITEMS): NavItem[] {
  return items.filter((item) => item.audiences.some((a) => audiences.includes(a)));
}

/** 今のパスがその項目に当たるか（trailingSlash とクエリは無視する） */
export function isActivePath(pathname: string, href: string): boolean {
  const p = pathname.replace(/\/+$/, '') || '/';
  const h = href.replace(/\/+$/, '') || '/';
  return p === h;
}
