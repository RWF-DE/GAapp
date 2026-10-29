# spikes/highs — T00 スパイク（highs-js で R8 規模の輸送問題を解く）

本体（pnpm workspace、`apps/*`・`packages/*`）からは参照しない。pnpm workspace にも含めない。**npm と、このフォルダ専用の package-lock.json** で単独で動く（`next-export/` も別の package.json と lockfile）。結果と考察は [notes/T00.md](../../notes/T00.md)。

## 必要なもの

- Node 22、npm
- ブラウザの計測：Playwright 1.63.0 の Chromium（`PLAYWRIGHT_BROWSERS_PATH` に入っているもの。`playwright install` はしない）
- ポート 5199（計測用の静的サーバーが使う）

## 再現手順

```sh
cd spikes/highs
npm ci                      # highs 1.15.4、tsx、vite、playwright 1.63.0（すべて exact 固定）
npm run typecheck           # tsc（型だけ）

npm run bench:node          # Node で測る → results/node.txt, node.json
npm run bench:p02           # P-02（コストの整数化）の比較 → results/p02.txt, p02.json

npm run build               # highs.wasm を browser/public/ に置いて vite build（base=/GAapp/）→ dist/
npm run bench:browser       # dist を /GAapp/ の下で配信し、Chromium で測る → results/browser.txt, browser.json
                            #  ※ bench:node を先に実行しておく（解のハッシュを Node と比べるため）

(cd next-export && npm ci)  # Next.js 16（output: 'export'、basePath: /GAapp）の静的書き出しでの wasm の読み込み
npm run build:next          # public/highs.wasm を置いて next build → next-export/out/
npm run bench:next          # → results/next.txt, next.json
```

`results/*.txt` はそのままの出力。時間は同じ計算機で他の作業が動いていると揺れる（数十％）。

## ファイル

| パス | 内容 |
| --- | --- |
| `src/gen.ts` | シード固定のダミーデータ（保管場所40・団体55・品目9、R8 の在庫・需要の合計に合わせる）。解けない版・並べ替え版も作る |
| `src/lp.ts` | 03 の定式化どおりに CPLEX LP 形式の文字列を作る（前処理、変数名 x1…、x̂・μ、元のコスト／整数化コスト）。解く関数 `solveModel` |
| `src/analyze.ts` | 結果の独立した検証（E001〜E005 相当）、W107 の数え方、距離の合計、行の差分 |
| `src/serve.ts` | GitHub Pages に似せた静的サーバー（`/GAapp/` の下、gzip、`max-age=600`、wasm は `application/wasm`） |
| `bench-node.ts` / `bench-p02.ts` / `bench-browser.ts` / `bench-next.ts` | 計測スクリプト |
| `browser/` | 最小の Vite ページ。`worker.ts`（Web Worker）の中で `loadHighs` と解くことを行い、`window.__result` に結果を置く |
| `next-export/` | Next.js の最小アプリ。wasm の置き方（`public/highs.wasm` ＋ `locateFile` ＋ basePath）の確認用 |
| `scripts/copy-wasm.mjs` | `node_modules/highs/build/highs.wasm` を `browser/public/` に写す |
