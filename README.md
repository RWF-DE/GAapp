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

GitHub Pages と保護ブランチ（ブランチ保護ルール）は、**公開リポジトリか、有料プラン（Team 以上）でないと private リポジトリでは使えない**。無料の組織で private のままだと、次の 1・3 はできない（`deploy.yml` を作っても公開されない）。Environments（環境の secrets・Required reviewers・Deployment branches）も使えないので、**`migrate.yml` は使わない**（DB の資格情報をリポジトリ全体の secrets に置かず、5 のマイグレーション適用は管理者が手元から `supabase db push` で行う）。公開にするかどうかは管理者が決める。公開にする前に、個人情報（メールアドレス、学生・企業の個人名、R8 の元データ）が履歴を含めて入っていないことを確かめる。

private のままでも Actions は動くが、無料プランは月 2,000 分の上限がある。ci.yml は pnpm のキャッシュと DB だけの起動で、無駄な時間を減らしてある。

### 1. GitHub Pages の有効化

Settings → Pages → Build and deployment → Source を **GitHub Actions** にする。以後、main への push で `deploy.yml` が公開する。URL は `https://rwf-de.github.io/GAapp/`。

### 2. Actions の変数と secrets

| 種類 | 名前 | 置き場所 | 用途 |
| --- | --- | --- | --- |
| 変数 | `NEXT_PUBLIC_SUPABASE_URL` | Settings → Secrets and variables → Actions → Variables | ビルドに埋め込む接続先 |
| 変数 | `NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY` | 同上 | 公開してよい publishable キー。secret（service_role）キーは入れない |
| 変数（任意） | `NEXT_PUBLIC_GOOGLE_HD_HINT` | 同上 | Google のアカウント選択を学校のドメインに絞るヒント（4） |
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

### 4. ログイン（Google Cloud と Supabase Auth）

ログインは Supabase Auth の Google プロバイダーで、ブラウザの PKCE フロー（サーバーなし）。学校のドメイン以外と Google 以外のプロバイダーは、DB の Before User Created フック（`private.hook_before_user_created`、supabase/migrations/0007_auth.sql）が拒否する。次をこの順で行う。

1. **学校のドメインを決める（D-04）**：0007_auth.sql の `c_domain`（今は仮の `school.example`）を学校の Google Workspace のドメインにする。本番に 0007 を適用する前なら 0007 のその1行を直す。適用した後なら、同じ関数を `create or replace` する新しいマイグレーションを足す（適用済みのファイルは書き換えない）。pgTAP（030_auth）と e2e/auth-hook.spec.ts のドメインも合わせる。
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

GitHub Actions の変数に `NEXT_PUBLIC_GOOGLE_HD_HINT`（学校のドメイン）を足すと、Google のアカウント選択が学校のアカウントに絞られる（任意。見た目だけで、拒否はフックが行う）。

### 5. 本番 DB への適用

マイグレーションを含む PR をマージしたあと、Actions → Migrate production DB → Run workflow で、**ブランチに `main` を選んで**手動実行する（2 の設定が済んでいる場合だけ。private（無料）で Environments が使えないときは、管理者が main のチェックアウトから `supabase link` → `supabase db push` を手元で実行する）。

### 6. 最初の年度と最初の管理者（D-01）

最初の年度と admin だけは、オーナーが SQL Editor で作る。以後の年度は、最新の年度の admin がアプリの create_year_from で作る。

1. オーナーが本番のアプリに学校の Google アカウントで1回ログインする（auth.users と profiles ができる。招待がないので「総務から招待されていません」と出る）。
2. 管理画面の SQL Editor で年度を1行入れる：`insert into public.years (label, festival_start) values ('R9', '2027-10-16') returning id;`
3. 同じく、自分を admin にする：`insert into public.year_roles (year_id, user_id, role) select '<年度の id>', id, 'admin' from auth.users where email = '<自分のメール>';`（メールはこの SQL にだけ書き、どこにも保存しない）
4. アプリを開き直す。ほかの総務・団体代表は、アプリの招待（invite）で足す。招待された人は、初めてログインしたときにロールが付く。
5. 最新の年度の admin が誰も残っていない（全員卒業して外した）ときは、3 と同じ SQL で、最新の年度に次の担当者を admin として足してから create_year_from を使う。

SQL Editor は postgres で動くので RLS を通らず、監査の user_id は null になる。

## R8 の fixtures を作る（R8 の元データが届いたら。ユーザーの PC で実行する）

fixtures/r8 は、元データから決まるものを `scripts/build-r8-fixtures.ts` が作り、元データにないものは手で書いてコミットする（分け方は fixtures/r8/README.md の雛形 [scripts/r8/fixtures-readme.template.md](scripts/r8/fixtures-readme.template.md) と、設計書の 3.8）。元データ（Google フォームの回答・Excel・PDF）はリポジトリに入れない。

1. リポジトリの外の非公開フォルダ（例 `~/r8-source`）に、次の UTF-8 の CSV を置く（Excel は「CSV UTF-8」で書き出す）。メールアドレスなどが入っていてよい（読まずに捨てる）。

   | ファイル | 中身 |
   | --- | --- |
   | forms/stall.csv・forms/department.csv | 模擬店・部門フォームの回答（スプレッドシートの書き出し） |
   | forms/company.csv・forms/company_map.csv | 企業フォームの回答（あれば）。company_map.csv は列 `row,group`（company.csv の行番号と団体名） |
   | stock.csv | 机椅子数えの最終値。1 列目が場所名、ほかは品目の列（机(木)・不可机・椅子(木)・…） |
   | allocation.csv | 振り分け表の行。列 `品目,運び元,使用用途,数,備考` |
   | allocation_totals.csv | 振り分け表の団体別集計。1 列目が使用用途、ほかは品目の列 |
   | anonymize.csv | （団体名に個人名があるときだけ）列 `source_name,fixture_name` |

2. 手で書くファイルを `fixtures/r8/` に置く：`meta.json`・`rooms.csv`・`rules.json`・`distance_overrides.csv`・`manual/`（`groups.csv`・`adjustments.csv`・`reference_skip.csv`・`settings.json`）。列は設計書 3.2・3.8。サンプルは [fixtures/r8-build-sample/fixture](fixtures/r8-build-sample/fixture)。
3. 実行する：

   ```bash
   R8_SOURCE_DIR=~/r8-source pnpm build:r8-fixtures
   ```

   `R8_SOURCE_DIR` がないと、必要なファイルを示して終わる（終了コード 2）。対応しない名前や行があると、**値を出さず行番号と見出しだけ**を示して失敗する（終了コード 1）。フォームのタイムスタンプ以外の列は読まない。画面に出る「比較から除いた団体」「申請と手作業が違う組」などは、fixtures/r8/README.md に書き写す。
4. 生成した fixtures に個人情報がないことを確かめる：

   ```bash
   pnpm check:emails      # 追跡ファイルにメールアドレスがないこと
   pnpm test              # fixtures/ の全ファイルにメールがないこと、fixtures の読み込み（知らない列は失敗）
   grep -rn '@' fixtures/r8 || echo '@ なし'
   git diff --stat fixtures/r8   # 備考・氏名・学籍番号・電話の列がないこと。団体名に個人名がないか目で確かめる
   ```

   団体名に個人名（研究室名の教員名など）が残っていないかは、機械では確かめられない。groups.csv の name・aliases と reference/ を一度読んでからコミットする。

## 個人情報

このリポジトリは公開前提。メールアドレスや個人名を、コード・fixtures・ログ・コミットに入れない（テスト用は `example.test` などの予約ドメインだけ）。CI の `pnpm check:emails` が、追跡ファイルに予約ドメイン以外のメールアドレスがあると失敗する。R8 の元データは `R8_SOURCE_DIR` の非公開フォルダから読む。
