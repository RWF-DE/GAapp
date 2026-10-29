# 電波祭 総務 机椅子管理アプリ

熊本高専の電波祭で、総務部門が机・椅子などの備品を団体に振り分けるための Web アプリ。Next.js の静的書き出しと Supabase で動かし、振り分けの計算と Excel 出力は管理者のブラウザで行う。仕様は [SPEC.md](SPEC.md) と `docs/requirements/` を見る。

## 開発の始め方

必要なもの：Node 22、pnpm 10（`corepack enable` で `packageManager` の版が入る）、Docker（ローカルの Supabase 用）。

```bash
pnpm install
pnpm dev            # http://localhost:3100
pnpm lint
pnpm typecheck
pnpm test           # Vitest（packages/* と apps/web と scripts）
pnpm build          # apps/web/out に静的ファイルを出す
pnpm e2e            # Playwright。先に pnpm build が必要
pnpm check:emails   # 追跡ファイルにメールアドレスが入っていないか
```

Playwright のブラウザは初回だけ `pnpm exec playwright install chromium` で入れる。

### ローカルの Supabase

```bash
supabase start        # 全部起動（Docker が必要）
supabase db reset     # マイグレーションと seed を流す
supabase test db      # pgTAP
supabase stop --no-backup
```

マイグレーションを変えたら、`supabase db reset` のあとに `pnpm gen:types` を実行して packages/shared/src/database.types.ts を作り直す。`pnpm check:types` は生成し直した型とコミット済みの型を比べるので、DB を起動した状態で、CI と同じ版の supabase CLI（2.122.0）で実行する（版が違うと出力がずれる）。

Claude Code のクラウドのセッションなど、Docker のデーモンが止まっている環境では、先に `dockerd` を起動してから `supabase start` する（`docker info` が失敗したら `nohup dockerd > /tmp/dockerd.log 2>&1 &`）。手元の PC では Docker Desktop などを起動しておく。ローカルの Supabase は同時に1つしか動かせない。

### basePath

GitHub Pages では `https://<組織>.github.io/<リポジトリ名>/` で公開されるため、ビルド時に環境変数 `NEXT_PUBLIC_BASE_PATH`（例：`/GAapp`）を渡す。未設定なら空（ローカル・E2E）。`deploy.yml` はリポジトリ名から自動で作る。

```bash
NEXT_PUBLIC_BASE_PATH=/GAapp pnpm build   # Pages と同じ形で確かめる
```

## 構成

```
GAapp/
├─ apps/web/            Next.js（App Router、output: 'export'）
├─ packages/            allocator / exporter / importer / shared（TS のソースをそのまま公開。ビルドしない）
├─ supabase/            config.toml、migrations、tests（pgTAP）、seed.sql
├─ e2e/                 Playwright
├─ scripts/             check-emails など
├─ spikes/              調査用の使い捨てコード（workspace の対象外）
└─ .github/workflows/   ci.yml、deploy.yml、migrate.yml
```

## 手作業が要る設定（管理者）

### 0. リポジトリの公開範囲

GitHub Pages と保護ブランチ（ブランチ保護ルール）は、**公開リポジトリか、有料プラン（Team 以上）でないと private リポジトリでは使えない**。無料の組織で private のままだと、次の 1・3 はできない（`deploy.yml` を作っても公開されない）。Environments（環境の secrets・Required reviewers・Deployment branches）も使えないので、**`migrate.yml` は使わない**（DB の資格情報をリポジトリ全体の secrets に置かず、5 のマイグレーション適用は管理者が手元から `supabase db push` で行う）。公開にするかどうかは管理者が決める。公開にする前に、個人情報（メールアドレス、学生・企業の個人名、R8 の元データ）が履歴を含めて入っていないことを確かめる。

private のままでも Actions は動くが、無料プランは月 2,000 分の上限がある。ci.yml は pnpm のキャッシュと DB だけの起動で、無駄な時間を減らしてある。

### 1. GitHub Pages の有効化

Settings → Pages → Build and deployment → Source を **GitHub Actions** にする。以後、main への push で `deploy.yml` が公開する。URL は `https://rwf-de.github.io/GAapp/`。

### 2. Actions の変数と secrets

| 種類 | 名前 | 置き場所 | 用途 |
| --- | --- | --- | --- |
| 変数 | `NEXT_PUBLIC_SUPABASE_URL` | Settings → Secrets and variables → Actions → Variables | ビルドに埋め込む接続先 |
| 変数 | `NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY` | 同上 | 公開してよい publishable キー。secret（service_role）キーは入れない |
| 変数 | `SUPABASE_PROJECT_REF` | Environments → production → Variables | migrate.yml が使う |
| secret | `SUPABASE_ACCESS_TOKEN`、`SUPABASE_DB_PASSWORD` | Environments → production → Secrets | migrate.yml が本番 DB にマイグレーションを適用するときだけ |

Settings → Environments で `production` を作り、次の 2 つを**必須**で設定する。`github-pages` は初回の deploy で自動で作られる。

- Deployment branches and tags を **Selected branches and tags** にして、`main` だけを許可する。これがないと、`workflow_dispatch` で未マージの feat ブランチを選んで Run workflow を押すだけで、そのブランチの `migrate.yml` と未レビューのマイグレーションが本番 DB に適用できてしまう（ワークフローはブランチ側のものが使われるため、`migrate.yml` 内の `if:` は防御にならない）。
- Required reviewers を付ける（実行前に承認が要る）。承認するときは、対象が `main` であることを確かめる。

`SUPABASE_ACCESS_TOKEN` と `SUPABASE_DB_PASSWORD` は、リポジトリ全体の secrets（Settings → Secrets and variables → Actions → Repository secrets）には**置かない**。どのブランチのワークフローからでも読み出せてしまう。

### 3. 保護ブランチ

Settings → Branches（または Rulesets）で main に次を設定する。

- Require a pull request before merging（承認 1 人）
- Require status checks to pass：`lint / typecheck / test / build`、`supabase test db`、`e2e (Playwright)`、`メールアドレスのチェック`（ジョブ名は ci.yml の `name`）
- main への直接 push を禁止

### 4. Supabase Auth のリダイレクト URL

本番の Supabase の Authentication → URL Configuration に `https://rwf-de.github.io/GAapp/` を登録する（T04 で使う）。

### 5. 本番 DB への適用

マイグレーションを含む PR をマージしたあと、Actions → Migrate production DB → Run workflow で、**ブランチに `main` を選んで**手動実行する（2 の設定が済んでいる場合だけ。private（無料）で Environments が使えないときは、管理者が main のチェックアウトから `supabase link` → `supabase db push` を手元で実行する）。

## 個人情報

このリポジトリは公開前提。メールアドレスや個人名を、コード・fixtures・ログ・コミットに入れない（テスト用は `example.test` などの予約ドメインだけ）。CI の `pnpm check:emails` が、追跡ファイルに予約ドメイン以外のメールアドレスがあると失敗する。R8 の元データは `R8_SOURCE_DIR` の非公開フォルダから読む。
