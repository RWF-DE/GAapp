// ダッシュボード（/）に出す機能の一覧（D-52）。各機能の portal.ts を import するのはここだけ（components/portal が読む）。
// 機能のチケット（T17〜T21）は、自分のプロバイダを最後に1行足す（並びは registry.ts の MODULES と同じにする。registry.test.ts）。
import { calendarPortalProvider } from './calendar/portal';
import { furniturePortalProvider } from './furniture/portal';
import { noticesPortalProvider } from './notices/portal';
import type { PortalProvider } from './portal';
// シフト・作業（T20。D-56）
import { shiftsPortalProvider } from './shifts/portal';

export const PORTAL_PROVIDERS: readonly PortalProvider[] = [
  furniturePortalProvider,
  noticesPortalProvider,
  calendarPortalProvider,
  // シフト・作業（T20。D-56）
  shiftsPortalProvider,
];
