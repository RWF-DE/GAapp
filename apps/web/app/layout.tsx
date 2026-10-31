import type { Metadata, Viewport } from 'next';
import { preconnect } from 'react-dom';
import { Providers } from '@/components/layout/providers';
import { EARLY_POSTS, earlyFetchScript } from '@/lib/boot/early-fetch';
import { PREFETCH_HINT_PREFIX } from '@/lib/boot/early-load';
import { EARLY_FETCH_PATHS } from '@/lib/data/screen-queries';
import { BASE_PATH, SUPABASE_PUBLISHABLE_KEY, SUPABASE_URL } from '@/lib/env';
import { authStorageKey } from '@/lib/supabase/client';
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
  // 前に開いたときに覚えた Supabase への読み取りを、JS を読む前に送る（D-45。lib/boot/early-fetch.ts。JS が動き始めると
  // supabase-js が同じリクエストの応答を受け取る）。ログインしていない・覚えたものがない・トークンの期限が近いときは何もしない。
  // 送るのは版を使わない画面（EARLY_FETCH_PATHS）だけ（振り分けに関わる画面〔/furniture・/allocation・/swaps〕は版を読み終えてから
  // 残りを読むため。D-33。ダッシュボード〔/〕は版を使わないが T16 では入れない。D-51）
  const early =
    SUPABASE_URL && SUPABASE_PUBLISHABLE_KEY
      ? earlyFetchScript({ u: SUPABASE_URL, a: SUPABASE_PUBLISHABLE_KEY, k: authStorageKey(), p: PREFETCH_HINT_PREFIX, b: BASE_PATH, post: EARLY_POSTS, paths: EARLY_FETCH_PATHS })
      : null;
  return (
    <html lang="ja">
      {/*
        async の data: URL にする（インラインの script はその前のスタイルシートを読み終えるまで動かず、その間 HTML の読み取りも
        止まって、Chrome は <head> の中の優先度の低いリクエスト〔ページの JS のチャンク〕を後回しにする。async なら待たずに動く）
      */}
      <head>{early ? <script async src={`data:text/javascript;base64,${Buffer.from(early, 'utf8').toString('base64')}`} /> : null}</head>
      <body>
        <Providers>{children}</Providers>
      </body>
    </html>
  );
}
