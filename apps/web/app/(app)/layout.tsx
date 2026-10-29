import { AppShell } from '@/components/layout/app-shell';

// ログインが要る画面の共通レイアウト（ナビゲーション、ロールによる表示の切り替え、未招待の画面）
export default function AppLayout({ children }: { children: React.ReactNode }) {
  return <AppShell>{children}</AppShell>;
}
