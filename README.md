# 電波祭 総務アプリ

熊本高専の電波祭で、総務部門の仕事をまとめる Web アプリ（画面の名前は「電波祭 総務」）。仕事は機能ごとに足していき、最初の機能は、机・椅子などの備品を団体に振り分ける「机椅子」。トップはダッシュボード（要対応の一覧・締切と予定・機能ごとのカード）。Next.js の静的書き出しと Supabase で動かし、振り分けの計算と Excel 出力は使う人のブラウザで行う。仕様は [SPEC.md](SPEC.md) と `docs/requirements/` を見る。

毎年の運用（7月の再開と年度の始め方・ルールの変え方・年度末の書き出し・障害時の対応・オーナーの引き継ぎ）は [docs/runbook.md](docs/runbook.md) にまとめた。

## 開発の始め方

必要なもの：Node 22、pnpm 10（`corepack enable` で `packageManager` の版が入る）、Docker（ローカルの Supabase 用）。

上から順に流せば、何もない状態（clone した直後）から通るように並べてある。DB が要らないもの → ローカルの Supabase → DB が要るもの（画面・E2E）の順。

```bash
pnpm install
pnpm exec playwright install chromium   # 初回だけ（E2E のブラウザ）

# DB が要らないもの
pnpm lint
pnpm typecheck
pnpm test           # Vitest（packages/* と apps/web と scripts と e2e/support の純粋な部分）
pnpm build          # apps/web/out に静的ファイルを出す（本番と同じ。テスト用ログインは入らない）
pnpm check:no-test-login   # out にテスト用ログインが入っていないか（CI の check と同じ）
pnpm check:emails   # 追跡ファイルにメールアドレスが入っていないか
```

`pnpm build:e2e` は同じ apps/web/out を E2E 用のビルドで上書きするので、`pnpm check:no-test-login` は `pnpm build` の直後に流す（`pnpm build:e2e` の後に流すと、テスト用ログインが入っているので落ちる）。

### ローカルの Supabase

画面（`pnpm dev`）・E2E（`pnpm build:e2e`・`pnpm e2e`）・pgTAP の前に起動する（`pnpm build:e2e` は起動中の Supabase の URL とキーを読むので、止まっていると失敗する）。

```bash
supabase start        # 全部起動（Docker が必要）。初回はマイグレーションと seed も流れる
supabase db reset     # マイグレーションと seed を流し直す（マイグレーションを変えた後・データを初期に戻すとき）
supabase test db      # pgTAP。E2E などでデータが残った DB では、supabase db reset してから流す（表全体の件数を数えるテストが落ちる）

# DB が要るもの（Supabase を起動したまま）
pnpm dev              # http://localhost:3100（先に下の「ログインとテストユーザー」の apps/web/.env.local を作る）
pnpm build:e2e        # E2E 用のビルド（ローカルの Supabase に向け、テスト用ログインを入れる）
pnpm e2e              # Playwright（chromium の後に serial）。pnpm build:e2e の後に流す

supabase stop --no-backup   # 終わったら止める
```

マイグレーションを変えたら、`supabase db reset` のあとに `pnpm gen:types` を実行して packages/shared/src/database.types.ts を作り直す。`pnpm check:types` は生成し直した型とコミット済みの型を比べるので、DB を起動した状態で、CI と同じ版の supabase CLI（2.122.0）で実行する（版が違うと出力がずれる）。

ログインとファイルの置き場（Storage）に要るものだけを起動するなら（E2E・画面の確認はこれで足りる。CI の e2e も同じ）。提出物（T19）の画面と E2E はファイルを Supabase Storage に上げるので、storage-api は外さない（画像の変換の imgproxy は使わないので外す）：

```bash
supabase start -x realtime,imgproxy,mailpit,studio,edge-runtime,logflare,vector,supavisor,postgres-meta
```

pgTAP（`supabase test db`）だけなら、DB だけを起動すればよい（`supabase db start`。storage-api がなくても、storage のスキーマは DB の中にあり、提出物の Storage のポリシーも SQL で確かめる）。

Storage について（提出物。T19。D-55）：Storage の物（storage.objects の行）は SQL では消せない（`storage.allow_delete_query` を立てない delete は 42501。消すのは Storage API〔画面の remove〕）。DB の行を消すと、その物は「どの提出にも属さないファイル」として残り、画面が消す。年度・団体・提出物を SQL Editor で消さない（残った物を誰も消せなくなることがある）。bucket documents の物を置く・書き換えるのは、ロールによらずトリガー documents_objects_guard が DB の予約と提出の状態で確かめる（SQL Editor の postgres や service_role でも、予約のない path・承認や終了の後・上書きは 42501。テストの準備で予約の外の物を置くときは、pgTAP の tests.put_object のように `set local session_replication_role = replica` の間に置く。これを設定できるのは postgres だけ）。ローカルの Storage のファイルの中身は `supabase stop --no-backup` で消える。

### ログインとテストユーザー（ローカル）

本番のログインは学校の Google アカウントだけ（Supabase Auth の Google プロバイダー）。ローカルでは Google を使わず、`supabase/seed.sql` が auth.users に直接入れるテストユーザー（メール＋パスワード）でログインする。seed は本番に流さない。

| メール | パスワード | R8 での立場 |
| --- | --- | --- |
| `admin@example.test` | `password123` | 管理者 |
| `head@example.test` | `password123` | 総務部門長 |
| `staff@example.test` | `password123` | 総務部門員 |
| `rep@example.test` | `password123` | 「テスト団体」の店長 |
| `viewer@example.test` | `password123` | 閲覧のみ |
| `outsider@example.test` | `password123` | 未招待（「総務から招待されていません」） |

総務副部門長（deputy_head）のテストユーザーは seed にない（権限は総務部門長と同じ）。E2E はテストごとに使い捨てのユーザーに付ける（D-36）。

テスト用ログインのフォームは、`NEXT_PUBLIC_ENABLE_TEST_LOGIN=true` でビルド（または `pnpm dev`）し、かつ Supabase の URL が `127.0.0.1`・`localhost` のときだけ出る。本番のビルド（deploy.yml）には入らない（CI の `pnpm check:no-test-login` で確かめる）。`pnpm dev` で使うときは apps/web/.env.local に次を書く（`supabase status -o env` の値）：

```bash
NEXT_PUBLIC_SUPABASE_URL=http://127.0.0.1:54321
NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY=<supabase status の PUBLISHABLE_KEY>
NEXT_PUBLIC_ENABLE_TEST_LOGIN=true
```

E2E は `supabase start …` → `pnpm build:e2e` → `pnpm e2e`。3100 番を別のサーバーが使っているときは `E2E_PORT=3110 pnpm e2e`。

CI では流さない E2E（環境変数のときだけ playwright.config.ts に入るプロジェクト。どれも `pnpm build:e2e` の後に流す）：

```bash
pnpm e2e:shots --grep "T14 "   # スクリーンショット（notes/<チケット>/。--grep はチケット ID と空白で絞る）
pnpm e2e:perf                   # 4G での表示の速さ（/stock・/request・/my・団体代表の /。PERF_ONLY=home などで絞る。結果は test-results/perf/）
pnpm e2e:manual                 # 手での確かめ（画面の受け入れ）の年度とユーザーを作り、ログインの情報を出す。片付けは MANUAL_CLEANUP=1
```

`pnpm build:e2e` の引数（`pnpm build:e2e -- --base-path /GAapp` のように渡す）：`--base-path /GAapp` は basePath つきで書き出して apps/web/out-basepath/GAapp/ に置く（下の「basePath」）。`--supabase-url http://<PC の LAN の IP>:54321` はアプリが呼ぶ Supabase の URL を変える（総務の PC から同じ Wi-Fi のスマホに配って試すとき。手順は notes/T14.md の「LAN で配る手順」）。ただし、今はテスト用ログインのフォームが Supabase の URL が 127.0.0.1・localhost のときだけ出るので、LAN の IP で書き出すとスマホにフォームが出ない（扱いは未決。notes/T14.md）。

**LAN で配るときの注意**：`supabase start` は API の 54321 だけでなく Postgres の 54322（既定のパスワード）なども `0.0.0.0` で待ち受け、ローカルの secret キー・JWT の秘密・seed のテストユーザーのパスワードは公開されている既定の値（同じネットワークの誰でも RLS を通らずに読み書きできる）。信頼できるネットワーク（総務の部屋の閉じた Wi-Fi など）だけで行い、ファイアウォールで 54321 と配る静的サーバーの port 以外を閉じ（Linux の Docker は ufw を素通りする）、終わったら `supabase stop` する。本番の DB・本番の鍵は使わない。詳しくは notes/T14.md の「LAN で配る手順」の注意。

Claude Code のクラウドのセッションなど、Docker のデーモンが止まっている環境では、先に `dockerd` を起動してから `supabase start` する（`docker info` が失敗したら `nohup dockerd > /tmp/dockerd.log 2>&1 &`）。手元の PC では Docker Desktop などを起動しておく。ローカルの Supabase は同時に1つしか動かせない。

### basePath

GitHub Pages では `https://<組織>.github.io/<リポジトリ名>/` で公開されるため、ビルド時に環境変数 `NEXT_PUBLIC_BASE_PATH`（例：`/GAapp`）を渡す。未設定なら空（ローカル・E2E）。`deploy.yml` はリポジトリ名から自動で作る。

```bash
NEXT_PUBLIC_BASE_PATH=/GAapp pnpm build   # Pages と同じ形で確かめる
```

E2E の本体は basePath なしで流れるので、basePath で壊れやすいもの（計算エンジンの wasm の URL・QR の URL・マニフェストとアイコン）は basePath のスモークで確かめる（CI の e2e ジョブでも流す）。basePath のビルドは apps/web/out を移すので、ふつうの `pnpm build:e2e` はその後に作る。

```bash
pnpm build:e2e -- --base-path /GAapp   # apps/web/out-basepath/GAapp/
pnpm build:e2e                         # apps/web/out（スモークでも 3100 番に配るので要る）
pnpm e2e:basepath                      # 3101 番に apps/web/out-basepath を配って確かめる（E2E_BASEPATH_PORT で変えられる）
```

PWA（D-38）：ホーム画面に追加できるマニフェスト（apps/web/app/manifest.ts。`display: "browser"` で、ホーム画面からは Safari・Chrome で開く）とアイコン（apps/web/app/icon.png・apple-icon.png。絵を変えたら `node scripts/gen-icons.mjs` で作り直す）。Service Worker は入れていない。

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

マイグレーションを含む PR をマージしたあと、Actions → Migrate production DB → Run workflow で、**ブランチに `main` を選んで**手動実行する（先に 2 の環境 `production` を設定しておく。Required reviewers の承認の後に動く）。Migrate production DB（`supabase db push`）は、本番 DB にまだ流していないマイグレーションを、番号の順に全部流す。CLI はファイルごとに1つのトランザクションで流すので、途中のファイルで止まると、そのファイルの変更は何も残らず、それより前のファイルは流れたまま残る（もう一度流すと、止まったファイルから続く）。本番 DB に流したファイルは、管理画面の SQL Editor で `select version from supabase_migrations.schema_migrations order by version;` を流すと分かる（`0008` のようなファイルの番号が並ぶ）。

#### 本番を使い始める前に流すもの（0009〜0016）

main には T15〜T18（PR #19〜#23）が入り、GitHub Pages の画面（deploy.yml が main へのマージのたびに出す）は 0015 までのマイグレーションがあることを前提にしている。本番 DB に流していないファイルが残っていると、それを使う画面（招待とロールの段・お知らせ・締切と予定など）が失敗を出す。本番を使い始める前に（誰かがアプリで書き込む前に）、下の手順で Migrate production DB を流し、次の8つを流し終えておく（本番 DB が 0008 までなら、1回の実行でこの順に流れる）。0016（提出物の DB と Storage。T19 のパート A）は画面（パート B）より先に main に入るので、流しても今の画面は変わらない。

| ファイル | 中身 | 流すときの注意 |
| --- | --- | --- |
| 0009_apply_invitations_keep_conflict.sql | 招待の受け入れの直し（別のロールを持つ人へのロールの招待を使用済みにしない。remove_role で本人あての未使用のロールの招待も取り消す。T03 のマージの後の直し） | — |
| 0010_rls_select_once.sql | 行が多くなりうる表の select のポリシーを、判定関数を行ごとに呼ばない形にする（意味は変えない。T14。D-47） | — |
| 0011_app_role_lead.sql | app_role に head（総務部門長）・deputy_head（総務副部門長）を足すだけ（T15。D-48） | 下の「0011〜0013 の注意」 |
| 0012_group_role.sql | 団体代表の立場（店長・副店長）の型と列を足すだけ（T15） | 同上 |
| 0013_role_overlap_lead_tier.sql | 兼任の禁止・3つの段・新しい招待と受け入れ（T15。D-48・D-49。動きを変えるものはすべてここ） | 同上。流す前に兼任の問い合わせ |
| 0014_notices.sql | お知らせ（T17。D-53）の型・表・RLS・RPC。足すだけ | 0013 で止まると、0014・0015 も流れない |
| 0015_events.sql | 締切と予定の項目（T18。D-54）の型・表・RLS。足すだけ | 0014 の関数を使うので、0014 の後 |
| 0016_documents.sql | 提出物（T19。D-55）の型・表・RLS・RPC と、Storage の bucket documents・storage.objects のポリシー3つとトリガー1つ。足すだけ | 下の「0016 の注意」。0014 の関数を使うので、0014 の後 |

流す手順：

1. 流す前に、管理画面の SQL Editor で下の「兼任を探す問い合わせ」を流し、行がないことを確かめる（行があれば、先にアプリで直す）。
2. アプリで書き込んでいる人がいないとき（振り分けの保存・招待・在庫の入力などをしていないとき）に、Migrate production DB を流す。
3. 止まったら、ログのエラーを見る。止まったファイルの変更は何も残らないので、直すものを直してから、もう一度 Migrate production DB を流せば、止まったファイルから続く。
   - `role_overlap: …`（0013 の最初の文）：兼任を探す問い合わせで探して直してから流し直す。
   - lock timeout（SQLSTATE 55P03）・デッドロック（40P01）：直すものはない。そのまま流し直す。
4. 流し終えたら、上の `supabase_migrations.schema_migrations` の問い合わせで 0016 まで並ぶことを確かめ、下の「0016 の注意」の確かめの問い合わせを流し、管理者が総務部門長・総務副部門長を招待する（下の「総務部門長・総務副部門長の付け方」）。

#### 0011〜0013（T15 のロールの見直し。D-48・D-49）の注意

- 0011 は app_role に head（総務部門長）・deputy_head（総務副部門長）を足すだけ（足した値は同じトランザクションの中では使えないので、ファイルを分けてある）。0012 は団体代表の立場（店長・副店長）の型と列を足すだけ。動きを変えるもの（兼任の禁止・3つの段・新しい招待と受け入れ）は、すべて 0013 の1つのトランザクションに入っている。0013 で止まっている間は、0013〜0015 を前提にした画面（招待・ロールの段・お知らせ・締切と予定）が失敗を出すので、直してすぐに流し直す。
- 流すのは、アプリで書き込んでいる人がいないとき（振り分けの保存・招待・在庫の入力などをしていないとき）にする。0012・0013 は最初に invitations・group_members（と year_roles）をロックし、0013 はその後でポリシーを作り直す 14 の表を順にロックする。同時の書き込みとぶつかると、ロックを 5 秒待ったところ（lock timeout、SQLSTATE 55P03）か、デッドロック（40P01）で止まることがある。止まったファイルの変更は何も残らないので、直すものはなく、もう一度 Migrate production DB を流せば止まったファイルから続く。同時に動いていたアプリの操作が「ほかの人の保存と重なりました」などで失敗したときは、その操作をやり直す。
- 0013 は、同じ年度で部員（staff）のロールと団体代表を兼ねている人がいると、最初の文で `role_overlap: …` で止まる（0013 の変更は何も残らない。先に流れた 0011・0012 は残るが、足すだけなので DB に害はなく、流し直すと 0013 から続く）。流す前に、管理画面の SQL Editor で次の問い合わせ（兼任を探す問い合わせ）を流して探す（結果のメールは SQL Editor の画面で見るだけにし、どこにも保存しない。`role::text` で比べるので、0011 の前でも後でも流せる）：

  ```sql
  select y.label, u.email, yr.role, g.name as group_name
  from public.year_roles yr
  join public.years y on y.id = yr.year_id
  join public.groups g on g.year_id = yr.year_id
  join public.group_members gm on gm.group_id = g.id and gm.user_id = yr.user_id
  join auth.users u on u.id = yr.user_id
  where yr.role::text in ('staff', 'head', 'deputy_head')
  order by y.festival_start, u.email, g.name;
  ```

  行があれば、その年度の管理者がアプリのマスタ設定 → ユーザーで直す（団体代表を外すか、ロールを閲覧のみに変えるか外す。管理者のロールなら団体代表を兼ねられる）。0 行になったら、もう一度 Migrate production DB を流す。
- 止めないもの：同じ年度・同じメールに、未使用の部員のロールの招待と、未使用の団体代表の招待の両方があるもの。ログインのときに先に作った方（同じ時刻ならロールの招待）だけが付き、もう片方は未使用のまま残る（管理者の画面に見える）。前もって片方を取り消すなら、次で探す：

  ```sql
  select y.label, r.email
  from public.invitations r
  join public.invitations g on g.year_id = r.year_id and g.email = r.email
                           and g.group_id is not null and g.used_at is null
  join public.years y on y.id = r.year_id
  where r.role::text in ('staff', 'head', 'deputy_head') and r.used_at is null
  order by y.festival_start, r.email;
  ```

- 総務部門長・総務副部門長は、0011〜0013 を流した後に付ける（流す前の DB はこの2つのロールを知らない）。ロールの画面（T15b。PR #20）はもう本番に出ている。今までの admin・staff・viewer・団体代表は、そのまま使える（表示は管理者・総務部門員・閲覧のみ・「{団体} の店長」になる）。
- 総務部門長・総務副部門長の付け方：その年度の管理者が、アプリのマスタ設定 → ユーザー の「招待する」で、メールアドレスを入れて立場に「総務部門長」か「総務副部門長」を選んで招待する（1回に1つの立場。すでにアカウントがあり、今のメールを本人のものと確かめられれば、その場で付く。ほかは、その人が学校の Google アカウントでログインしたときに付く）。年度の作成（create_year_from）で新しい年度に付くロールは作った人の管理者だけなので、**新しい年度を作るたびに招待し直す**（D-48。docs/runbook.md の 1.3）。総務部門員・店長・副店長は、管理者のほか総務部門長・総務副部門長も招待できる。総務部門長・総務副部門長・総務部門員は、同じ年度の店長・副店長を兼ねられない（管理者と閲覧のみは兼ねられる。D-49）。その年度の店長・副店長を総務部門長などに招待すると、立場の欄に兼任のエラーが出るので、先にメンバーの一覧で「代表を外す」か、別の人を招待する。

#### 0016（提出物。T19。D-55）の注意

- 0016 は型・表・関数・ポリシーを足すだけで、今の表と関数は変えない。最後の Storage の部分で、storage.buckets に bucket `documents` の行（非公開・1ファイル 10 MiB・PDF・JPEG・PNG）を入れ、storage.objects に bucket documents の物だけに効くポリシー3つ（documents_objects_select・documents_objects_insert・documents_objects_delete）と、書き込みを DB の予約と提出の状態で確かめるトリガー documents_objects_guard を作る（RLS を通らない Storage API の書き込み〔署名つきアップロードなど〕も止める。notes/T19.md の「レビューで直したこと」）。storage の表の持ち主は supabase_storage_admin で、Migrate production DB は postgres で流す。ローカル（supabase/postgres 17.11・CLI 2.122.0）では postgres でどれも作れたが、本番で権限のエラー（42501。permission denied・must be owner of table objects など）で止まることがある。止まると 0016 の変更は何も残らない（0015 までは残る。提出物の画面はまだないので、ほかの画面はそのまま使える）。
- 流し終えたら、管理画面の SQL Editor で次を流し、Storage の部分が入ったことを確かめる（最後の4行は取り消すトランザクションで、service_role の書き込み〔署名つきアップロードと同じロール〕もトリガーが止めることを見る。何も残らない）：

  ```sql
  select id, public, file_size_limit, allowed_mime_types from storage.buckets where id = 'documents';
  -- 1 行：documents | false | 10485760 | {application/pdf,image/jpeg,image/png}
  select policyname, cmd, roles from pg_policies where schemaname = 'storage' and tablename = 'objects' order by policyname;
  -- 3 行：documents_objects_delete | DELETE | {authenticated}、documents_objects_insert | INSERT | {authenticated}、documents_objects_select | SELECT | {authenticated}
  select tgname, tgenabled from pg_trigger where tgrelid = 'storage.objects'::regclass and tgname = 'documents_objects_guard';
  -- 1 行：documents_objects_guard | O
  begin;
  set local role service_role;
  insert into storage.objects (bucket_id, name) values ('documents', 'check/not-reserved.pdf');
  rollback;
  -- ERROR: forbidden（42501。DETAIL は {"reason": "not_reserved"}）になれば、トリガーが効いている
  ```

- 止まったときの手順：
  1. ログのエラーから、止まった文を控える（`insert into storage.buckets`・`create policy … on storage.objects`・`create trigger documents_objects_guard`）。どの文が通らないかは、SQL Editor で 0016 の全部を `begin;` と `rollback;` で囲んで流すと分かる（Storage の部分は 0016 の前半の表と関数を使うので、全部を流す。最後が rollback なので何も残らない）。
  2. bucket の行かポリシーが通らないとき：手で入れる。bucket は管理画面の Storage → New bucket で作る（名前 `documents`、Public bucket はオフ、Restrict file upload size は 10 MB〔10485760 バイト〕、Allowed MIME types は `application/pdf`・`image/jpeg`・`image/png`）。ポリシーは Storage → Policies の bucket documents で New policy → For full customization を選び、0016 の3つの `create policy` と同じ名前・操作（SELECT・INSERT・DELETE）・対象のロール（authenticated）・式で作る。入れた後に上の確かめの問い合わせを流し、0016 から手で入れた文を除く PR を出してから（除いたことを notes/T19.md に書く）、Migrate production DB を流し直す。
  3. トリガーが通らないとき（postgres が storage.objects にトリガーを作れない）：トリガーのないまま 0016 を流さない（署名つきアップロードの URL を取っておくと、承認の後のファイルを差し替えられる。T19-SEC-1）。代わりの守りを入れる PR を出してから流す：authenticated から storage.objects の update の権限を外して upsert の署名つき URL を作れなくし（`revoke update on storage.objects from authenticated`）、提出・承認のときに各物の版（storage.objects の version）を document_files に控えて、違えば v_document_files と承認で見つける（notes/T19.md の判断したことの 29）。
  4. lock timeout（55P03）・デッドロック（40P01）：直すものはない。そのまま流し直す。

### 6. 最初の年度と最初の管理者（D-01）

最初の年度と admin だけは、オーナーが SQL Editor で作る。以後の年度は、最新の年度の admin がアプリの create_year_from で作る。

1. オーナーが本番のアプリに学校の Google アカウントで1回ログインする（auth.users と profiles ができる。招待がないので「総務から招待されていません」と出る）。
2. 管理画面の SQL Editor で年度を1行入れる：`insert into public.years (label, festival_start) values ('R9', '2027-10-16') returning id;`
3. 同じく、自分を admin にする：`insert into public.year_roles (year_id, user_id, role) select '<年度の id>', id, 'admin' from auth.users where email = '<自分のメール>';`（メールはこの SQL にだけ書き、どこにも保存しない）
4. アプリを開き直す。ほかの人（総務部門長・総務副部門長・総務部門員・閲覧のみ・店長・副店長）は、アプリの招待（invite）で足す。招待された人は、初めてログインしたときにロールが付く。
5. 最新の年度の admin が誰も残っていない（全員卒業して外した）ときは、3 と同じ SQL で、最新の年度に次の担当者を admin として足してから create_year_from を使う。

SQL Editor は postgres で動くので RLS を通らず、監査の user_id は null になる。

## R8 の fixtures を作る（R8 の元データを使うことになったら。ユーザーの PC で実行する）

今は R8 の元データを使わず、合成データ fixtures/synthetic/r8like で代用している（D-40）。fixtures/r8 と seed の R8 の区間は作っていない。R8 の元データを使うことになったときのために、次の仕組みを残してある（fixtures/r8 があれば、R8 の不変条件と再計算のテストが自動でそちらにも流れる。入れたら CI に `REQUIRE_R8_FIXTURES=1` を足す）。

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

このリポジトリは公開する（0）。メールアドレスや個人名を、コード・fixtures・ログ・コミットに入れない（テスト用は `example.test` などの予約ドメインだけ）。CI の `pnpm check:emails` が、追跡ファイルに予約ドメイン以外のメールアドレスがあると失敗する。R8 の元データは `R8_SOURCE_DIR` の非公開フォルダから読む。
