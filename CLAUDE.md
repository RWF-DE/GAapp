# 電波祭 総務アプリ

熊本高専の電波祭で、総務部門の仕事を1つにまとめる Web アプリ（画面の名前は「電波祭 総務」）。仕事は「機能」ごとに足していき、最初の機能は「机椅子」（机・椅子などの備品を団体に振り分ける）。トップはダッシュボード（D-51）。サーバーを持たない構成（Next.js の静的書き出し＋Supabase）で、振り分けの計算と Excel 出力は使う人のブラウザで行う。

## 最初に読むもの
- 仕様の入口：[SPEC.md](SPEC.md)
- 要件定義（正）：docs/requirements/
  - 00_overview.md：全体像・スコープ（機能の一覧）・機能要件・技術構成・未決事項
  - 01_rules.md：用語集（コード上の英語名）・机椅子の業務ルール（S01〜S08）
  - 02_data.md：DDL・RLS の権限表・状態遷移
  - 03_allocation.md：振り分けの定式化・検証コード・Excel 出力仕様
  - 04_screens_api.md：画面仕様・CSV 取り込み・DB 関数・ブラウザ側の処理
  - 05_development.md：リポジトリ構成・CI・チケット T00〜T21・受け入れ基準
- チケットごとの依頼文：docs/prompts/（使い方は docs/prompts/README.md）
- 作業中の設計判断の記録：notes/<チケットID>.md、決定事項は notes/decisions.md

## 進め方のルール
- 仕様は docs/requirements が正。曖昧・矛盾しているときは推測で実装せず、質問する。
- 仕様を変えるときは、先に docs/requirements を直す（実装と同じ PR に含める）。
- 1チケット＝1ブランチ＝1PR。ブランチ名は `feat/<チケットID>-<内容>`、コミットは Conventional Commits。main に直接 push しない。
- 見積もり L のチケットは計画モードで始め、計画を確認してから実装する。
- 完了と言う前に lint・型チェック・テストを実行し、コマンドと結果を報告する。バグ修正は、再現する失敗テストを先に書く。
- UI を変えたら実際に起動して確認し、スクリーンショットを notes/<チケットID>/ に残す。
- 実装が終わったら reviewer サブエージェントでレビューする。認証・RLS・RPC・入力処理に触れたら security-reviewer にも回す。
- 同じ指摘を2回受けたら手を止めて、やり方を見直す。
- 画面のチケット（T09〜T14）は、自分の画面のディレクトリと 04 の自分の画面の節だけを直す。共通の部品・依存（package.json）・ナビゲーション・テストの土台は T09a が持つ。05 のチケット表の「状態」と notes/decisions.md は画面のチケットの PR では直さない（D-32）。
- 機能のチケット（T17〜T21）は、自分の機能のディレクトリ、04 の自分の節、ナビゲーションの自分の見出しの行、機能の登録とダッシュボードの一覧の自分の1行だけを直し、共有の一覧（pgTAP の 010・011、00 の機能と画面の一覧、01 の用語集）には行を足すだけにする（05「チケット分割」。D-52）。

## コマンド
- 依存関係：`pnpm install`
- 開発サーバー：`pnpm dev`（http://localhost:3100）
- ローカル DB：`supabase start` → `supabase db reset`（マイグレーションと seed）。終わったら `supabase stop --no-backup`。Docker のデーモンが止まっていれば先に `dockerd` を起動する
- Storage：提出物（T19）の画面と E2E はファイルを Supabase Storage に上げるので、storage-api が要る。`supabase start -x …` で減らして起動するときも storage-api は外さない（imgproxy は外してよい。README の「ローカルの Supabase」の一行）。pgTAP は storage-api なしで流れる（storage のスキーマは DB の中にある）
- チェック：`pnpm lint`、`pnpm typecheck`、`pnpm test`、`supabase test db`（DB だけなら `supabase db start`）、`pnpm e2e`（先にローカルの Supabase を起動（`supabase start`。seed のテストユーザーを使う）して `pnpm build:e2e`。3100 番が使われていれば `E2E_PORT=3101 pnpm e2e`）、`pnpm check:emails`
- E2E：`pnpm e2e` は scripts/e2e.mjs が Playwright を2回呼ぶ（並行の chromium〔setup の db-setup・auth-setup は依存で走る〕の後に、結果によらず serial〔年度の作成・年度をまたぐ表の変更・通しの流れ〕を流し、どちらかが落ちれば失敗。レポートは回ごとに別のフォルダ）。1つだけ流すときは `pnpm exec playwright test --project=chromium e2e/<ファイル>`。スクリーンショットは `pnpm e2e:shots --grep <チケットID>`（`E2E_SHOTS=1` で shots のプロジェクトだけを流し、notes/<チケットID>/ に保存する。CI では流さない。テストの名前はチケット ID で始める）
- 最初に読む JS の量：`pnpm build` の後に `node scripts/first-load-js.mjs`（apps/web/out の各ページが読む script の gzip の合計）
- 型の生成：`pnpm gen:types`（`supabase gen types` の出力を packages/shared/src/database.types.ts に書く。DB の変更後に実行）、一致の確認は `pnpm check:types`
- ビルド：`pnpm build`（apps/web/out に静的書き出し。GitHub Pages 用は `NEXT_PUBLIC_BASE_PATH=/GAapp pnpm build`）。`pnpm dev`・`pnpm build` の前に apps/web の predev・prebuild が highs の wasm を apps/web/public/highs.wasm にコピーする（git に入れない）
- spikes/ は workspace・lint・typecheck・test の対象外

## 設計上の約束（破らない）
- サーバーを持たない。Next.js は `output: 'export'`。Route Handler・Server Action・middleware・動的セグメント（`[id]`）は使わず、id はクエリ文字列で渡す。
- アプリが使う Supabase の鍵は publishable キーだけ。secret（旧 service_role）キーをアプリやビルドに入れない。
- 全テーブルで RLS を有効にする。理由が要る書き込みと、複数の表をまとめて変える書き込みは DB 関数（RPC。SECURITY DEFINER、`search_path = ''`、最初にロールを確認）で行う。
- ダッシュボード（/）は機能ごとの軽い読み取りだけにする。版・振り分けの行・検証・スナップショットを読まず、それらを読む部品を / の JS に入れない（D-51・D-52）。
- 振り分けは `packages/allocator` の DB に依存しない純粋関数。輸送問題（LP）として highs-js の単体法で解く。0/1 変数や、時間で打ち切った解は使わない。入力は sort_order → 名前 → id の順に並べてから組み立てる。
- コードの識別子は 01_rules.md の用語集の英語名にそろえる。画面の文言は日本語。
- 日時は timestamptz で保存し、画面では Asia/Tokyo で表示する。

## 個人情報（公開リポジトリ）
- メールアドレスや、学生・企業の個人名を、コード・fixtures・ログ・コミット・PR に入れない。
- R8 の元データ（Google フォームの回答、Excel、PDF）はリポジトリに入れない。リポジトリの外の非公開フォルダ（環境変数 `R8_SOURCE_DIR`）から読み、個人情報を除いた fixtures だけをコミットする。
- .env ファイルはコミットしない。

## 落とし穴（要件レビューで見つかったもの）
- PostgREST は1リクエスト＝1トランザクション。`set_config('app.reason', …, true)` は、書き込みと同じ RPC の中で呼ぶ。
- ビューは `with (security_invoker = true)` にしないと RLS を素通りする。
- 他の表を参照する CHECK 制約は使わない（トリガーで確かめる）。
- ポリシーの中で同じ表を読むと再帰する。権限の判定は private スキーマの SECURITY DEFINER 関数で行う。
- RLS は列を制限できない。列単位の更新制限は RPC で実現する。
- CPLEX LP 形式の変数名に UUID は使えない（`-` や数字始まりは不可）。連番の名前と対応表を使う。
- highs-js の wasm は静的ファイルとして公開し、locateFile で URL を渡す。振り分け画面でだけ読み込む。
- ExcelJS は数式を計算しない。数式と一緒に計算済みの値も書き、fullCalcOnLoad を設定する。
- GitHub Pages は `組織名.github.io/リポジトリ名/` で公開されるので、Next.js の basePath と Supabase Auth のリダイレクト URL を合わせる。
- Google ログインは CI で通せない。E2E はローカル Supabase のメール＋パスワードのテストユーザーで行い、本番ではメールログインを無効にする。
- 静的書き出しでは、`useSearchParams` を使う部品をページで `<Suspense>` に包む（包まないと `next build` が失敗する）。`window`・`location`・`localStorage`・`Worker` はプリレンダーの間はないので、useEffect かイベントの中だけで使う。
- highs の wasm は `require.resolve('highs/runtime')` で引いてコピーする（`highs/package.json` は exports にないので引けない）。public のファイルと QR の絶対 URL には basePath を自分で付ける。
- E2E は画面からサインアップやメールの変更をしない（ローカルも Confirm email が有効）。ユーザーは seed か e2e/support の createUser で作る。
- RLS で拒否された update・delete はエラーにならず 0 行で成功する。直接の更新と削除は `.select()` で変わった行を受け取り、0 行を成功として扱わない。
- 年度をまたぐ表（rooms・items・distance_overrides）に行を足すと、振り分け中のすべての年度の allocation_version が上がる。E2E では並行のテストの前に1回だけ入れ、テストの途中で変えない。
- アイコンは Next のファイルの規約（app/icon.png など）で置く（metadata に文字列で書くと basePath が付かない）。マニフェストの JSON の中の URL には basePath を自分で付ける。
- Storage の物（storage.objects の行）は SQL では消せない（storage.protect_delete。`set local storage.allow_delete_query = 'true'` がなければ 42501。E2E の片付けだけがこれを立てる）。消すのは Storage API（画面の remove）。DB の行を消すと「どの提出にも属さないファイル」が残るので、画面が消す。年度・団体・提出物を SQL で消さない。
- 提出物のファイルを上げられるのは、DB が予約した path（reserve_document_file の object_path）だけ（storage.objects の insert のポリシー）。update のポリシーはないので、上書き・移動・upsert はできない（upload は `upsert: false`）。path に日本語や個人名を入れない。
- 署名つき URL（createSignedUrl）は押したときに 60 秒だけ作り、キャッシュ・下書き・ログに残さない（その間は URL を知る誰でも開ける）。
