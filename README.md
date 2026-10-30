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

**公開する**（ユーザーの決定、2026-10-29）。公開の前に、全ブランチの履歴・PR・Actions を点検し、個人情報（メールアドレス、学生・企業の個人名）・秘密の鍵・R8 の元データはなかった。テストの仮のアドレスは予約済みのドメインに直したが、履歴には前の値が残る。公開の操作（Settings → General → Danger Zone → Change repository visibility）は管理者が GitHub の画面で行う。

公開リポジトリなので、無料の組織でも GitHub Pages（1）、Environments（環境の secrets・Required reviewers・Deployment branches。2）、ルールセット（3）が使え、本番 DB へのマイグレーションは `migrate.yml` で適用する（5）。GitHub が用意するランナーの Actions の分数も数えられない。公開した後も、個人情報と R8 の元データは入れない（「個人情報」の節）。

#### 公開した直後に設定するもの

- Settings → Code security（Advanced Security）で、次を有効にする。
  - **Secret scanning** と **Push protection**（鍵やトークンの push を止める）
  - **Private vulnerability reporting**（脆弱性を公開の issue ではなく非公開で受け取る。[SECURITY.md](SECURITY.md)）
  - **Dependabot alerts**。Dependabot の version updates（`.github/dependabot.yml`）は入れない（リリースから 7 日たたない版を入れない pnpm の `minimumReleaseAge` と合わないため）。
- Settings → Actions → General で、次にする。
  - Approval for running fork pull request workflows from contributors を **Require approval for all external contributors** にする（外の人の PR のワークフローは、管理者が承認してから動く）。
  - Workflow permissions を **Read repository contents and packages permissions** にし、**Allow GitHub Actions to create and approve pull requests** を外す。
- 2 の環境（`production`・`github-pages`）と 3 のルールセットを、まだなら設定する。

### 1. GitHub Pages の有効化

Settings → Pages → Build and deployment → Source を **GitHub Actions** にする。以後、main への push で `deploy.yml` が公開する。URL は `https://rwf-de.github.io/GAapp/`。

### 2. Actions の変数と secrets

| 種類 | 名前 | 置き場所 | 用途 |
| --- | --- | --- | --- |
| 変数 | `NEXT_PUBLIC_SUPABASE_URL` | Settings → Secrets and variables → Actions → Variables | ビルドに埋め込む接続先 |
| 変数 | `NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY` | 同上 | 公開してよい publishable キー。secret（service_role）キーは入れない |
| 変数（任意） | `NEXT_PUBLIC_GOOGLE_HD_HINT` | 同上 | 学校のドメイン `g.kumamoto-nct.ac.jp`（D-04）。Google のアカウント選択を学校のドメインに絞るヒント（T04 のログインで使う。見た目だけで、拒否は DB のフックが行う） |
| 変数 | `SUPABASE_PROJECT_REF` | Environments → production → Variables | migrate.yml が使う |
| secret | `SUPABASE_ACCESS_TOKEN`、`SUPABASE_DB_PASSWORD` | Environments → production → Secrets | migrate.yml が本番 DB にマイグレーションを適用するときだけ |

Settings → Environments で `production` を作り、次の 2 つを**必須**で設定する。

- Deployment branches and tags を **Selected branches and tags** にして、`main` だけを許可する。これがないと、`workflow_dispatch` で未マージの feat ブランチを選んで Run workflow を押すだけで、そのブランチの `migrate.yml` と未レビューのマイグレーションが本番 DB に適用できてしまう（ワークフローはブランチ側のものが使われるため、`migrate.yml` 内の `if:` は防御にならない）。
- Required reviewers を付ける（実行前に承認が要る）。承認するときは、対象が `main` であることを確かめる。

`github-pages`（1 で Source を GitHub Actions にしたときか、初回の deploy で作られる）も、Settings → Environments → github-pages の Deployment branches and tags を **Selected branches and tags** にして `main` だけを許可する。`deploy.yml` は `workflow_dispatch` でどのブランチからでも動かせるので、これがないと未マージのブランチを本番の Pages に出せてしまう。

`SUPABASE_ACCESS_TOKEN` と `SUPABASE_DB_PASSWORD` は、リポジトリ全体の secrets（Settings → Secrets and variables → Actions → Repository secrets）には**置かない**。どのブランチのワークフローからでも読み出せてしまう。

### 3. 保護ブランチ（ルールセット）

main を 2 つのルールセットで守る。迂回（Bypass list）はルールセットごとにしか効かないので、CI と PR は誰も迂回できないルールセットに、承認だけを管理者が迂回できるルールセットに分ける。

Settings → Rules → Rulesets → New ruleset → **New branch ruleset** で、次の 2 つを作る。どちらも Enforcement status を **Active**、Target branches → Add target → **Include default branch**（main）にする。

1. Ruleset name「**main: PR と CI を必須**」
   - Bypass list：**空のまま**（管理者も迂回できない）
   - **Restrict deletions**：オン
   - **Block force pushes**：オン
   - **Require a pull request before merging**：オン。Required approvals は **0**（承認は 2 つ目のルールセットで求める）
   - **Require status checks to pass**：オン。Add checks で `lint / typecheck / test / build`、`supabase test db`、`e2e (Playwright)`、`メールアドレスのチェック` を足す（ジョブ名は ci.yml の `name`。一度 CI が動いた後なら候補に出る。出所は GitHub Actions を選ぶ）。
     - `xlsx の再計算 (LibreOffice)` は、T08 が main に入ってから足す。それより前のブランチの ci.yml にはこのジョブがないので、先に足すとその PR はチェックを待ち続ける。
     - **Require branches to be up to date before merging は付けない**（積み上げの PR を、マージのたびに main に追いつかせなくてよいように）。
2. Ruleset name「**main: 1 人の承認**」
   - **Require a pull request before merging**：オン。Required approvals を **1**、**Dismiss stale pull request approvals when new commits are pushed** をオン（新しい push で承認を外す）
   - Bypass list：Add bypass → **Repository admin** を足し、**For pull requests only** にする。
     - 今は PR の作者が管理者本人だけで、GitHub では自分の PR を承認できない。管理者は PR の画面で、このルールセットの承認だけを迂回してマージする（Merge without waiting for requirements to be met (bypass rules)）。迂回はこのルールセットにしか効かないので、1 つ目の CI と PR は迂回できない。
     - ほかの人が加わったら、その人が承認する（迂回は使わない）。

### 4. Supabase Auth のリダイレクト URL

本番の Supabase の Authentication → URL Configuration に `https://rwf-de.github.io/GAapp/` を登録する（T04 で使う）。

### 5. 本番 DB への適用

マイグレーションを含む PR をマージしたあと、Actions → Migrate production DB → Run workflow で、**ブランチに `main` を選んで**手動実行する（先に 2 の環境 `production` を設定しておく。Required reviewers の承認の後に動く）。

## 個人情報

このリポジトリは公開する（0）。メールアドレスや個人名を、コード・fixtures・ログ・コミットに入れない（テスト用は `example.test` などの予約ドメインだけ）。CI の `pnpm check:emails` が、追跡ファイルに予約ドメイン以外のメールアドレスがあると失敗する。R8 の元データは `R8_SOURCE_DIR` の非公開フォルダから読む。
