import type { Metadata, Viewport } from 'next';
import { Providers } from '@/components/layout/providers';
import './globals.css';

export const metadata: Metadata = {
  title: '電波祭 総務 机椅子管理',
};

export const viewport: Viewport = {
  width: 'device-width',
  initialScale: 1,
};

// QueryClientProvider・AuthProvider・未保存の入力の守り・Toaster は Providers（クライアントの部品）に置く（T09a）
export default function RootLayout({ children }: { children: React.ReactNode }) {
  return (
    <html lang="ja">
      <body>
        <Providers>{children}</Providers>
      </body>
    </html>
  );
}
