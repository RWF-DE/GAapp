# 電波祭 総務 机椅子管理アプリ

熊本高専の電波祭で、総務部門が机・椅子などの備品を団体に振り分けるための Web アプリ。サーバーを持たない構成（Next.js の静的書き出し＋Supabase）で、振り分けの計算と Excel 出力は管理者のブラウザで行う。

## 最初に読むもの
- 仕様の入口：[SPEC.md](SPEC.md)
- 要件定義（正）：docs/requirements/
  - 00_overview.md：全体像・スコープ・機能要件・技術構成・未決事項
  - 01_rules.md：用語集（コード上の英語名）・業務ルール（S01〜S08）
  - 02_data.md：DDL・RLS の権限表・状態遷移
  - 03_allocation.md：振り分けの定式化・検証コード・Excel 出力仕様
  - 04_screens_api.md：画面仕様・CSV 取り込み・DB 関数・ブラウザ側の処理
  - 05_development.md：リポジトリ構成・CI・チケット T00〜T14・受け入れ基準
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

## コマンド
- 依存関係：`pnpm install`
- 開発サーバー：`pnpm dev`（http://localhost:3100）
- ローカル DB：`supabase start` → `supabase db reset`（マイグレーションと seed）。終わったら `supabase stop --no-backup`。Docker のデーモンが止まっていれば先に `dockerd` を起動する
- チェック：`pnpm lint`、`pnpm typecheck`、`pnpm test`、`supabase test db`（DB だけなら `supabase db start`）、`pnpm e2e`（先に `pnpm build`）、`pnpm check:emails`
- 型の生成：`pnpm gen:types`（`supabase gen types` の出力を packages/shared/src/database.types.ts に書く。DB の変更後に実行）、一致の確認は `pnpm check:types`
- ビルド：`pnpm build`（apps/web/out に静的書き出し。GitHub Pages 用は `NEXT_PUBLIC_BASE_PATH=/GAapp pnpm build`）
- spikes/ は workspace・lint・typecheck・test の対象外

## 設計上の約束（破らない）
- サーバーを持たない。Next.js は `output: 'export'`。Route Handler・Server Action・middleware・動的セグメント（`[id]`）は使わず、id はクエリ文字列で渡す。
- アプリが使う Supabase の鍵は publishable キーだけ。secret（旧 service_role）キーをアプリやビルドに入れない。
- 全テーブルで RLS を有効にする。理由が要る書き込みと、複数の表をまとめて変える書き込みは DB 関数（RPC。SECURITY DEFINER、`search_path = ''`、最初にロールを確認）で行う。
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
