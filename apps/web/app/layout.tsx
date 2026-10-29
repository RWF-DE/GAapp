import type { Metadata, Viewport } from 'next';
import { preconnect } from 'react-dom';
import { Providers } from '@/components/layout/providers';
import { SUPABASE_URL } from '@/lib/env';
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
  // Supabase への接続（DNS・TCP・TLS）を、JS を読み終えて最初の問い合わせを送るより前に始める（T14。4G の速さ。notes/T14.md）。
  // supabase-js の fetch は Cookie を送らない CORS なので crossOrigin は anonymous（接続の組が合わないと使われない）
  if (SUPABASE_URL) preconnect(SUPABASE_URL, { crossOrigin: 'anonymous' });
  return (
    <html lang="ja">
      <body>
        <Providers>{children}</Providers>
      </body>
    </html>
  );
}
