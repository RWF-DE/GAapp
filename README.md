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
pnpm build          # apps/web/out に静的ファイルを出す（本番と同じ。テスト用ログインは入らない）
pnpm build:e2e      # E2E 用のビルド（ローカルの Supabase に向け、テスト用ログインを入れる）
pnpm e2e            # Playwright。先にローカルの Supabase の起動と pnpm build:e2e が必要
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

ログインに要るものだけを起動するなら（E2E・画面の確認はこれで足りる。CI の e2e も同じ）：

```bash
supabase start -x realtime,storage-api,imgproxy,mailpit,studio,edge-runtime,logflare,vector,supavisor,postgres-meta
```

### ログインとテストユーザー（ローカル）

本番のログインは学校の Google アカウントだけ（Supabase Auth の Google プロバイダー）。ローカルでは Google を使わず、`supabase/seed.sql` が auth.users に直接入れるテストユーザー（メール＋パスワード）でログインする。seed は本番に流さない。

| メール | パスワード | R8 での立場 |
| --- | --- | --- |
| `admin@example.test` | `password123` | 総務管理者 |
| `staff@example.test` | `password123` | 総務部員 |
| `rep@example.test` | `password123` | 「テスト団体」の団体代表 |
| `viewer@example.test` | `password123` | 閲覧のみ |
| `outsider@example.test` | `password123` | 未招待（「総務から招待されていません」） |

テスト用ログインのフォームは、`NEXT_PUBLIC_ENABLE_TEST_LOGIN=true` でビルド（または `pnpm dev`）し、かつ Supabase の URL が `127.0.0.1`・`localhost` のときだけ出る。本番のビルド（deploy.yml）には入らない（CI の `pnpm check:no-test-login` で確かめる）。`pnpm dev` で使うときは apps/web/.env.local に次を書く（`supabase status -o env` の値）：

```bash
NEXT_PUBLIC_SUPABASE_URL=http://127.0.0.1:54321
NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY=<supabase status の PUBLISHABLE_KEY>
NEXT_PUBLIC_ENABLE_TEST_LOGIN=true
```

E2E は `supabase start …` → `pnpm build:e2e` → `pnpm e2e`。3100 番を別のサーバーが使っているときは `E2E_PORT=3101 pnpm e2e`。

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
  - Fork pull request workflows from outside collaborators を **Require approval for all external contributors** にする（外の人の PR のワークフローは、管理者が承認してから動く）。
  - Workflow permissions を **Read repository contents and packages permissions** にし、**Allow GitHub Actions to create and approve pull requests** を外す。
- 2 の環境（`production`・`github-pages`）と 3 のルールセットを、まだなら設定する。

### 1. GitHub Pages の有効化

Settings → Pages → Build and deployment → Source を **GitHub Actions** にする。以後、main への push で `deploy.yml` が公開する。URL は `https://rwf-de.github.io/GAapp/`。

### 2. Actions の変数と secrets

| 種類 | 名前 | 置き場所 | 用途 |
| --- | --- | --- | --- |
| 変数 | `NEXT_PUBLIC_SUPABASE_URL` | Settings → Secrets and variables → Actions → Variables | ビルドに埋め込む接続先 |
| 変数 | `NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY` | 同上 | 公開してよい publishable キー。secret（service_role）キーは入れない |
| 変数（任意） | `NEXT_PUBLIC_GOOGLE_HD_HINT` | 同上 | 学校のドメイン `g.kumamoto-nct.ac.jp`（D-04）。Google のアカウント選択を学校のドメインに絞るヒント（4。見た目だけで、拒否は DB のフックが行う） |
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

### 4. ログイン（Google Cloud と Supabase Auth）

ログインは Supabase Auth の Google プロバイダーで、ブラウザの PKCE フロー（サーバーなし）。学校のドメイン以外と Google 以外のプロバイダーは、DB の Before User Created フック（`private.hook_before_user_created`、supabase/migrations/0007_auth.sql）が拒否する。次をこの順で行う。

1. **学校のドメイン（D-04）**：`g.kumamoto-nct.ac.jp`（教員と学生で同じ。2026-10-29 に決定）。0007_auth.sql の `private.school_domain()` の1か所に書いてあり、フックはそれを呼ぶ。変えるときは、本番に 0007 を適用する前なら 0007 のその関数の値を直す。適用した後なら、`private.school_domain()` を `create or replace` する新しいマイグレーションを足す（適用済みのファイルは書き換えない。権限は create or replace で変わらない）。pgTAP（030_auth）の「本番の値」のテストも合わせる（判定のテストは予約済みのドメインに置き換えて流すので、直さなくてよい）。実在のドメインのメールアドレスはテストや文書に書かない。
2. **Google Cloud の OAuth クライアント（K-11）**：組織の持ち物のプロジェクト（個人のアカウントに紐付けない。オーナーを2人以上）で、APIs & Services → OAuth consent screen を作る。
   - 学校の Workspace の中にプロジェクトを作れるなら、User type を **Internal** にする（学校のアカウントだけが使え、Google の審査が要らない）。
   - Workspace の外に作るなら **External** になる。Publishing status が **Testing** のままだと、登録したテストユーザー（100 人まで）しかログインできないので、**In production** に公開する（スコープは email・profile・openid だけで、機密性の高いスコープを使わないので、アプリの審査は原則要らない）。どちらの場合も、許可するアカウントはフックが学校のドメインに絞る。
   - 1〜3年生（18歳未満の指定がある人）が外部アプリにログインできるかは、学校の Workspace の管理者の設定による（00 の未決事項）。管理者に、このアプリ（OAuth クライアント ID）を「信頼できるアプリ」に入れてもらう。
   - Credentials → Create credentials → OAuth client ID（Web application）。Authorized JavaScript origins に `https://rwf-de.github.io`、Authorized redirect URIs に `https://<project-ref>.supabase.co/auth/v1/callback` を入れる。
3. **Supabase の Google プロバイダー**：Authentication → Sign In / Providers → Google を有効にし、2 のクライアント ID とシークレットを入れる（シークレットは Supabase にだけ置き、リポジトリや GitHub に置かない）。
4. **リダイレクト URL**：Authentication → URL Configuration の Site URL を `https://rwf-de.github.io/GAapp/`、Redirect URLs に `https://rwf-de.github.io/GAapp/auth/callback/` を足す（basePath 込み。ローカルの `http://127.0.0.1:3100/**` は supabase/config.toml にある）。
5. **フックの有効化**：Authentication → Auth Hooks → Add hook → Before User Created → Postgres を選び、スキーマ `private`、関数 `hook_before_user_created` を選ぶ。必要な権限（supabase_auth_admin の usage と execute）は 0007 で与えてあるので、管理画面が権限を足すか聞いてきても、ほかの関数には与えない。
6. **メールログインの無効化**：Authentication → Sign In / Providers → Email を無効にする（E2E のメール＋パスワードはローカルだけ）。フックはメールのサインアップも拒否するが、二重に止める。「Allow new users to sign up」は**有効のまま**にする（Google で初めてログインした人の auth.users を作るため。誰が使えるかは招待で決まる）。
7. **必ず守る Auth の設定（変えない）**：招待（admin を含む）は「今のメールが本人のもの」と確かめられるアカウントにだけ付く。次のどれかを外すと、ログイン済みの人が自分のメールを招待された人のアドレスに変えて、その招待を受け取れるおそれがある（D-17a）。
   - ログインは **Google だけ**。Email プロバイダーは無効（6）。Phone・匿名ログイン（Allow anonymous sign-ins）・ほかの外部プロバイダーも無効のまま。
   - Authentication → Sign In / Providers → Email の **Confirm email** と **Secure email change** は**有効のまま**にする（Email プロバイダーを無効にしても、メールの変更の確認にこの設定が使われる）。
   - Authentication → Sign In / Providers の **Allow manual linking** は**無効のまま**にする。有効だと、利用者が identity を足したり外したりできる。Confirm email も崩れていると、Google のユーザーがメールを変えて email の identity を作り、Google の identity を外して email だけのアカウントになり、「Google の identity のメールだけを見る」守りを抜けて他人の招待を取れる（D-17a）。無効なら Google の identity を外せないので、Confirm email が崩れても止まる。
   - DB の側でも、auth.users.email と同じメールの、email_verified が真の Google の identity（Google の identity があるアカウントは、これだけを見る）か、受信箱で確かめた（email_verified: true の）email の identity がなく、メールの変更の途中でもないアカウントには招待を付けない（`private.verified_email`、0005）。これは守りの二重化で、上の設定の代わりにはならない。
   - ローカルの supabase/config.toml も同じ考え方にしてある（`enable_confirmations = true`、`double_confirm_changes = true`、`enable_manual_linking = false`、`enable_anonymous_sign_ins = false`。Email プロバイダーはテストユーザーのパスワードログインのためだけに有効）。
8. 確かめる：学校のアカウントでログインして「総務から招待されていません」が出ること、個人の Google アカウントでは「学校の Google アカウントでログインしてください」と出てログインできないこと。

GitHub Actions の変数に `NEXT_PUBLIC_GOOGLE_HD_HINT`（学校のドメイン `g.kumamoto-nct.ac.jp`）を足すと、Google のアカウント選択が学校のアカウントに絞られる（任意。見た目だけで、拒否はフックが行う）。

### 5. 本番 DB への適用

マイグレーションを含む PR をマージしたあと、Actions → Migrate production DB → Run workflow で、**ブランチに `main` を選んで**手動実行する（先に 2 の環境 `production` を設定しておく。Required reviewers の承認の後に動く）。

### 6. 最初の年度と最初の管理者（D-01）

最初の年度と admin だけは、オーナーが SQL Editor で作る。以後の年度は、最新の年度の admin がアプリの create_year_from で作る。

1. オーナーが本番のアプリに学校の Google アカウントで1回ログインする（auth.users と profiles ができる。招待がないので「総務から招待されていません」と出る）。
2. 管理画面の SQL Editor で年度を1行入れる：`insert into public.years (label, festival_start) values ('R9', '2027-10-16') returning id;`
3. 同じく、自分を admin にする：`insert into public.year_roles (year_id, user_id, role) select '<年度の id>', id, 'admin' from auth.users where email = '<自分のメール>';`（メールはこの SQL にだけ書き、どこにも保存しない）
4. アプリを開き直す。ほかの総務・団体代表は、アプリの招待（invite）で足す。招待された人は、初めてログインしたときにロールが付く。
5. 最新の年度の admin が誰も残っていない（全員卒業して外した）ときは、3 と同じ SQL で、最新の年度に次の担当者を admin として足してから create_year_from を使う。

SQL Editor は postgres で動くので RLS を通らず、監査の user_id は null になる。

## 個人情報

このリポジトリは公開する（0）。メールアドレスや個人名を、コード・fixtures・ログ・コミットに入れない（テスト用は `example.test` などの予約ドメインだけ）。CI の `pnpm check:emails` が、追跡ファイルに予約ドメイン以外のメールアドレスがあると失敗する。R8 の元データは `R8_SOURCE_DIR` の非公開フォルダから読む。
