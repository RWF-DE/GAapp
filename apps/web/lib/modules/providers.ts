// ダッシュボード（/）に出す機能の一覧（D-52）。各機能の portal.ts を import するのはここだけ（components/portal が読む）。
// 機能のチケット（T17〜T21）は、自分のプロバイダを最後に1行足す（並びは registry.ts の MODULES と同じにする。registry.test.ts）。
import { furniturePortalProvider } from './furniture/portal';
import type { PortalProvider } from './portal';

export const PORTAL_PROVIDERS: readonly PortalProvider[] = [furniturePortalProvider];
