# FU4 ナビの見出しと項目の見分け

## 何を・なぜ
左のメニュー（PC の左とスマホのメニューは同じ AppNav）で、見出しが小さい灰色の字で項目と同じ左端にあり、無効の項目に見えた。
- 2つ目からの見出しの上に区切り線（border-sidebar-border）と余白を足した
- 見出しは text-xs font-semibold tracking-wide・前景色（灰色にしない）
- 項目は左の余白を pl-5 にして、見出し（px-3）より一段下げた。選んでいる項目の見た目は変えない
- マークアップ（role="group"・h2・id・data-nav-section・`<li>` は項目だけ）は変えない。E2E の navLabels はそのまま通る
- 仕様：04「共通レイアウト」に1行足した。クラス名を見るだけのテストは意味が薄いので足していない（既存の app-shell.test.tsx と E2E の T16 が構造を確かめる）

## スクリーンショット
- notes/FU4/nav-headings-pc.png、notes/FU4/nav-headings-mobile.png（`pnpm e2e:shots --grep T16` の nav-grouped-* を写した。notes/T16 は変えていない）

## コマンド
pnpm lint / typecheck / test / build / check:emails、node scripts/first-load-js.mjs、
`pnpm exec playwright test --project=chromium e2e/foundation.spec.ts e2e/t16-portal.spec.ts`（E2E_PORT=3101）。結果は PR に書く。
