import type { MetadataRoute } from 'next';
import { BASE_PATH } from '@/lib/env';

// PWA のマニフェスト（D-38。T14）：ホーム画面に追加できるようにするだけ。ホーム画面からはブラウザ（Safari・Chrome）で開く
// （display: "browser"。standalone は iOS Safari と Android Chrome の実機で Google ログイン → /auth/callback/ → セッションが
// 残ることを確かめたときだけ切り替える）。Service Worker は入れない。
// 静的書き出しで manifest.webmanifest のファイルになる。<link rel="manifest"> の href には Next が basePath を付けるが、
// JSON の中の start_url・scope・icons の src は書いた文字列のままなので、BASE_PATH を自分で付ける。
// アイコンは Next のファイルの規約（app/icon.png・app/apple-icon.png。scripts/gen-icons.mjs で作る）。
// 名前は総務アプリ（D-51。T16）：name「電波祭 総務」、short_name「総務」（ホーム画面のアイコンの下に出る短い名前）。
export const dynamic = 'force-static';

export default function manifest(): MetadataRoute.Manifest {
  return {
    name: '電波祭 総務',
    short_name: '総務',
    description: '電波祭の総務部門の仕事をまとめるアプリ（机椅子の在庫・申請・振り分けなど）',
    lang: 'ja',
    start_url: `${BASE_PATH}/`,
    scope: `${BASE_PATH}/`,
    display: 'browser',
    background_color: '#ffffff',
    theme_color: '#1d4ed8',
    icons: [
      { src: `${BASE_PATH}/icon.png`, sizes: '512x512', type: 'image/png' },
      { src: `${BASE_PATH}/apple-icon.png`, sizes: '180x180', type: 'image/png' },
    ],
  };
}
