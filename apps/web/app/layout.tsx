import type { Metadata, Viewport } from 'next';
import { AuthProvider } from '@/lib/auth/auth-provider';
import './globals.css';

export const metadata: Metadata = {
  title: '電波祭 総務 机椅子管理',
};

export const viewport: Viewport = {
  width: 'device-width',
  initialScale: 1,
};

export default function RootLayout({ children }: { children: React.ReactNode }) {
  return (
    <html lang="ja">
      <body>
        <AuthProvider>{children}</AuthProvider>
      </body>
    </html>
  );
}
