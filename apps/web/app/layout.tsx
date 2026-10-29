import type { Metadata } from 'next';
import './globals.css';

export const metadata: Metadata = {
  title: '電波祭 総務 机椅子管理',
};

export default function RootLayout({ children }: { children: React.ReactNode }) {
  return (
    <html lang="ja">
      <body>{children}</body>
    </html>
  );
}
