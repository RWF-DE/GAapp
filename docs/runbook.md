# 運用の手順（総務の管理者・開発者）

毎年の運用で使う手順をまとめる。初めての設定（GitHub Pages・Actions の変数・ルールセット・ログイン・最初の年度と管理者）は [README の「手作業が要る設定」](../README.md#手作業が要る設定管理者) を見る。画面の仕様は [docs/requirements/04_screens_api.md](requirements/04_screens_api.md)、業務ルールは [01_rules.md](requirements/01_rules.md)。

本番の URL は `https://rwf-de.github.io/GAapp/`。

- [1. 7月の再開と年度の始め方](#1-7月の再開と年度の始め方)
- [2. ルールの変え方](#2-ルールの変え方)
- [3. 年度末の書き出し](#3-年度末の書き出し)
- [4. 障害時の対応](#4-障害時の対応)
- [5. オーナーの引き継ぎ](#5-オーナーの引き継ぎ)

## 1. 7月の再開と年度の始め方

Supabase の無料プランは、1週間ほど使われないと一時停止する（停止から1年以内なら管理画面から再開できる）。毎年7月、在庫数えと団体登録の前に、次の順で行う。

### 1.1 Supabase を再開する（Supabase の組織のオーナー）

1. [Supabase の管理画面](https://supabase.com/dashboard) で、組織のプロジェクトを開く。「Paused」なら **Restore project**（再開）を押し、状態が Healthy になるまで待つ（数分）。
2. 再開した後、アプリ（本番の URL）を開いてログインできることを確かめる。

### 1.2 設定が変わっていないことを確かめる（オーナー）

去年から1年たつと、管理画面の項目の名前や既定値が変わっていることがある。次がそのままかを、毎年必ず確かめる。

- **本番の Auth で必ず守る設定（D-17a）**：README の「4. ログイン」の 7（必ず守る Auth の設定）のとおり。
  - ログインは **Google だけ**。Authentication → Sign In / Providers で、**Email**・**Phone**・**匿名ログイン**（Allow anonymous sign-ins）・ほかの外部プロバイダーは**無効**。
  - Email の **Confirm email** と **Secure email change** は**有効**。
  - **Allow manual linking** は**無効**。
  - 「Allow new users to sign up」は有効のまま（Google で初めてログインした人の auth.users を作るため）。
  - Authentication → Auth Hooks の **Before User Created** が `private.hook_before_user_created` のまま有効。
  - Authentication → URL Configuration の Site URL が `https://rwf-de.github.io/GAapp/`、Redirect URLs に `https://rwf-de.github.io/GAapp/auth/callback/` がある。

  どれかが変わっていたら直してから使う。外れていると、ログイン済みの人が自分のメールを他人のアドレスに変えて、その人あての招待（管理者を含む）を受け取れるおそれがある。
- **学校のドメイン（D-04）**：`g.kumamoto-nct.ac.jp` のままか（学校がドメインを変えていないか）。変わっていたら、README の「4. ログイン」の 1 のとおり `private.school_domain()` を直す新しいマイグレーションを足す。Actions の変数 `NEXT_PUBLIC_GOOGLE_HD_HINT` も合わせる。
- **Google Cloud の OAuth クライアント**：プロジェクトのオーナーが2人以上いて、OAuth の同意画面が In production（External のとき）か Internal のまま。クライアントのシークレットを作り直したら、Supabase の Google プロバイダーにも入れ直す。
- **公開リポジトリの設定（D-41）**：README の「0. リポジトリの公開範囲」「2. Actions の変数と secrets」「3. 保護ブランチ」のとおり。ルールセット2つ（「main: PR と CI を必須」「main: 1 人の承認」）が Active、環境 `production`・`github-pages` の Deployment branches が main だけ、Secret scanning と Push protection が有効、Actions の Workflow permissions が読み取りだけ。
- **GitHub Pages**：Actions の Deploy のワークフローが最近成功しているか。1年動いていなければ、Actions → Deploy → Run workflow（ブランチ main）で一度公開し直す。

### 1.3 新しい年度を作る（最新の年度の管理者）

アプリのトップ（ダッシュボード）の「要対応」に、次の作業（受付期間を入れる・在庫を数えていない場所・締切を押す・書き出して終了 など）が立場ごとに出る（04「机椅子の状況」の「ダッシュボードに出すもの」）。年度の状態のボタン（受付開始・締切・確定・確定の解除・終了）は、メニューの「机椅子」→「机椅子の状況」（`/furniture/`）にある。

1. アプリに学校の Google アカウントでログインし、マスタ設定 → 年度 → 「新しい年度を作る」に、年度名（例 `R9`）と1日目を入れて作る。
   - 作れるのは、**最新の年度の管理者**だけ（前の年度が終了していてもよい）。管理者が全員卒業していて誰も作れないときは、README の「6. 最初の年度と最初の管理者」の 5（オーナーが SQL Editor で最新の年度に次の担当者を admin として足す）を行ってから作る。
   - 複製されるもの：団体・ルール・場所の今年の使用。複製されないもの：在庫・申請・振り分け・了承・ロール（作った人だけが管理者になる）・招待。ルールのうち、新しい年度の団体に付け替えられなかったものは無効になり、作った後に件数とコードが出る（ルール画面で直す。[2](#2-ルールの変え方)）。
2. マスタ設定 → 年度 で、受付期間（開始・締切）を入れる。
3. マスタ設定 → 場所 の「今年の使用」で、今年使えない部屋を使用不可にし、理由のメモを書く。場所・品目・距離はすべての年度に効く（今年の使用だけが年度ごと）。
4. マスタ設定 → 団体 で、今年の団体をそろえる（団体の CSV で取り込める。見出しは `団体名,表示名,区分,飲食,使用場所,別名,並び順`）。消えた団体は消す（その団体を参照する有効なルールがあれば、先にルールを無効にする）。
5. マスタ設定 → ユーザー で、総務の部員・閲覧のみの人・団体代表を招待する（学校のメールアドレス。団体代表は団体を選ぶ）。招待された人は、学校の Google アカウントで初めてログインしたときにロールが付く。去年のロールは引き継がれない。
6. 在庫数え：在庫一覧 → 「QR を印刷」（`/stocks/qr/`）で部屋に貼るカードを印刷する（URL は年度によらないので、去年のカードも使える）。部員はスマホのカメラで QR を読み、Safari か Chrome で開いて入力する（LINE などのアプリの中では Google でログインできない）。在庫一覧で未入力の部屋を確かめる。
7. 机椅子の状況（`/furniture/`）で「受付開始」を押す（締切が未来に入っていないと押せない）。団体代表は申請の画面から提出する。Google フォームでも受け付けたときは、申請一覧の「Googleフォームの回答を取り込む」で取り込む。

### 1.4 開発者が確かめること

- 依存の更新・マイグレーションの適用は、PR → CI → マージ → Actions の Migrate production DB（ブランチ main、承認つき）の順（README の 5）。本番 DB に直接 SQL を流さない（SQL Editor は年度の最初の管理者を足すときなどだけ）。
- 7月の前に、ローカルで `supabase start` → `supabase db reset` → `pnpm build:e2e` → `pnpm e2e` が通ることを確かめておく（1年で Supabase の CLI やイメージが変わっていることがある）。

## 2. ルールの変え方

ルール（代替・運び元の制限・固定の申請・残す。01_rules.md の S01〜S08）は、管理者がルール画面（`/rules/`）で年度ごとに変える。コードや DB を直す必要はない。

1. ルール画面で、追加（「ルールを追加」）・編集・有効／無効の切り替え・メモの記入をする。ルールは消さない。要らなくなったら**無効**にして、理由をメモに書く（無効のルールも次の年度に複製されるので、来年の担当者が理由を読める）。
2. 変えられるのは、準備中〜振り分け中の年度。**確定中はメモだけ**を書ける（変えるときは、机椅子の状況で「確定を解除」してから）。終了した年度は変えられない。
3. ルールを変えたら、振り分け画面で「最小変更で再実行」（今の振り分けをできるだけ変えない）か「自動振り分け」（全部やり直す）を押し、検証の error が 0 件になることを確かめてから確定する。ルールの変更だけでは振り分けは変わらない。
4. 一覧に「参照が切れています」の印があるルール（指している団体・場所が消えた）は、検証に使われず、確定も押せない。団体・場所を選び直すか、無効にする。
5. ルールの種類そのもの（今の4種類にない決まり）を足すときは、開発者が allocator（packages/allocator）と DB（ルールの params の形）と画面を直す。先に docs/requirements/01_rules.md・03_allocation.md を直し、PR にする（CLAUDE.md の進め方）。

ルールの履歴（誰がいつ何を変えたか）は、履歴の画面（`/history/?table=rules`）で見られる。

## 3. 年度末の書き出し

Supabase の無料プランには自動のバックアップがない。年度を終える前に、次を必ず行う。

### 3.1 管理者：アプリから書き出す

1. 机椅子の状況（`/furniture/`）で「終了」を押すと、確認のダイアログに **年度データ（JSON）** と **振り分け表（Excel）** の書き出しのボタンが出る。両方を押してダウンロードしてから終了する（終了すると読み取り専用になり、戻せない）。マスタ設定 → 書き出し からも、いつでも書き出せる。
   - 年度データ：`{年度}_年度データ.json`（団体・場所・品目・在庫・申請・ルール〔無効なものとメモを含む〕・振り分け・了承。メールアドレスは含めない）。
   - 振り分け表：`{年度}_椅子机振り分け_部門員共有用.xlsx`（確定前に出したものは名前に「確定前」が付く。確定版を残す）。
2. 2つのファイルを**総務の共有ドライブ**（学校の Google ドライブの共有フォルダ。個人のドライブに置かない）の年度のフォルダに保存する。GitHub（公開リポジトリ）には置かない。
3. 卒業する管理者は、終了の前後にマスタ設定 → ユーザー で自分のロールを外し、次の担当者が最新の年度の管理者になっていることを確かめる（[5](#5-オーナーの引き継ぎ)）。

### 3.2 開発者：DB 全体を保存する（`supabase db dump`）

アプリの書き出しは年度ごとの業務データだけなので、開発者は DB 全体も保存する。

> **データの dump は個人情報を含む**：`--data-only` の書き出し（下の `R9-data.sql`）には、`public.invitations` の**招待したメールアドレス（学生・企業の担当者）**、利用者の表示名、監査の記録（変更の前後の値と理由）がそのまま入る（アプリの年度データの JSON と違い、メールアドレスを除かない）。
>
> - 置き場所は**総務の共有ドライブの、権限を絞った非公開のフォルダ**（総務の管理者と開発者だけが見られるもの）。個人のドライブ・メール・チャットには置かない。
> - **公開リポジトリには入れない**。リポジトリの中のフォルダに書き出さない（`.gitignore` に当たるかどうかに頼らない。`git add -f`・別のクローン・エディタの同期で入ることがある）。下のとおりリポジトリの外（`~/gaapp-backup/`）に書き出す。
> - 共有ドライブに置いて開けることを確かめたら、**開発者の PC の手元のコピーを消す**（下の「手元のコピーを消す」）。

```bash
# 本番のプロジェクトにつなぐ（project ref と DB のパスワードは Supabase の管理画面。パスワードはファイルに書かない）
supabase link --project-ref <project-ref>
# ロール・スキーマ・データを別々に書き出す（リポジトリの外のフォルダに。リポジトリの中には書き出さない）
mkdir -p ~/gaapp-backup && chmod 700 ~/gaapp-backup
supabase db dump --linked -f ~/gaapp-backup/R9-roles.sql --role-only
supabase db dump --linked -f ~/gaapp-backup/R9-schema.sql
supabase db dump --linked -f ~/gaapp-backup/R9-data.sql --use-copy --data-only
```

手元のコピーを消す（共有ドライブの非公開のフォルダに 3 つのファイルを置き、そこから開けることを確かめた後）：

```bash
rm -f ~/gaapp-backup/R9-roles.sql ~/gaapp-backup/R9-schema.sql ~/gaapp-backup/R9-data.sql
rmdir ~/gaapp-backup   # 空なら消える。ほかのファイルが残っていたら中を確かめる
```

- ゴミ箱・ダウンロードのフォルダ・共有ドライブのアプリの同期の「オフラインで使用」に写しが残っていないかも確かめて消す（Google ドライブのデスクトップ版で上げたときは、PC 側の同期のフォルダの写しを「オンラインのみ」にするか消す）。
- 戻すために手元に持ってきたときも、戻し終わったら同じように消す。

戻すときは、新しいプロジェクト（か `supabase db reset` した空の DB）に、ロール → スキーマ → データの順で流す（Supabase の文書「Backup and restore using the CLI」）。auth のユーザーは戻らないので、利用者はもう一度 Google でログインし直す。

## 4. 障害時の対応

| 起きたこと | まず見る所 | 直し方 |
| --- | --- | --- |
| アプリの URL が 404・真っ白 | GitHub の Actions → Deploy の結果、Settings → Pages | Deploy が失敗していれば Run workflow（main）で公開し直す。Pages の Source が GitHub Actions のままか確かめる |
| 「通信できませんでした」が続く・ログインの後に何も出ない | Supabase の管理画面のプロジェクトの状態 | Paused なら Restore project（[1.1](#11-supabase-を再開するsupabase-の組織のオーナー)）。無料枠の上限（Usage）を超えていないか |
| ダッシュボードの欄の1つに「読み込めませんでした」が出る | 出た文言 | 「もう一度」を押す。続くなら上の「通信できませんでした」の行と同じ。ほかの欄と、メニューからの画面はそのまま使える（欄は機能ごとに別々に読む） |
| Google でログインできない | 出た文言、Supabase の Authentication → Logs | 「学校の Google アカウントでログインしてください」は個人のアカウント（正しい動き）。学校のアカウントでも出るならドメイン（D-04）。リダイレクトの誤りは URL Configuration と Google Cloud の Authorized redirect URIs（README の 4） |
| LINE などで QR を開くとログインできない | 開いたアプリ | Safari か Chrome で開き直す（アプリの中のブラウザは Google が止める） |
| 「総務から招待されていません」 | マスタ設定 → ユーザー の招待の一覧 | 招待したメールが学校のアドレスと同じか。最新の年度の管理者が誰もいなければ、README の 6 の 5 |
| 振り分けで「計算エンジンを読み込めませんでした」 | ブラウザの開発者ツールの Network（`highs.wasm` が 200 か） | 再読み込み。回線の良い所で開き直す。404 なら公開の basePath の誤り（Deploy をやり直す） |
| 自動振り分けが解けない（解けない理由のパネル） | パネルの理由（在庫が足りない品目・ルール） | 在庫の数え直し、使用不可の部屋を見直す、ルールを無効にする、申請を直す。手で行を足して保存もできる |
| 確定できない | 検証の error の一覧、「入力の誤り」 | error を直す（行をクリックすると該当の行へ飛ぶ）。参照の切れたルールは [2](#2-ルールの変え方) の 4 |
| 誤ってデータを変えた・消した | 履歴（`/history/`）で、いつ・誰が・何を変えたか（変更前の値） | 変更前の値を見て、画面から入れ直す。確定後なら「確定を解除」してから直して確定し直す |
| Excel の数が合わない・数式エラー | 開いたソフト（Excel・LibreOffice）、確定前のファイルか | 確定後に書き出し直す。Excel で開き直して再計算（数式は開いたときに計算される） |
| 祭りの当日に通信が切れる | — | 確定の後に書き出した振り分け表（Excel）を印刷して使う |
| DB を壊した・消した | 直前の書き出し（[3](#3-年度末の書き出し)） | `supabase db dump` のファイルから戻す（[3.2](#32-開発者db-全体を保存するsupabase-db-dump)）。年度の業務データは年度データ（JSON）で確かめられる |

困ったときに読む記録：画面の挙動は docs/requirements/04_screens_api.md、決めたことは notes/decisions.md、チケットごとの細部は notes/<チケットID>.md。

## 5. オーナーの引き継ぎ

GitHub・Supabase・Google Cloud はどれも個人ではなく組織の持ち物にし、**オーナーを常に2人以上**にする。卒業する人は、後輩をオーナーに足し、後輩がログインして操作できることを確かめてから抜ける（00「保守と引き継ぎ」）。学校の Google アカウントは卒業で使えなくなるので、学生のアカウントだけをオーナーにしない。

| 何を | どこで | 引き継ぐこと |
| --- | --- | --- |
| GitHub の組織（RWF-DE）とリポジトリ | Organization → People、リポジトリの Settings → Rules → Rulesets・Environments → production・Collaborators and teams | 後輩を Owner にする。ルールセットの迂回（Repository admin）と環境 `production` の Required reviewers に後輩を入れる。抜ける人は、Organization → People から外し（Owner も外れる）、環境 `production` の Required reviewers から外す。ルールセットの Bypass list に人やチームを名指しで入れていれば、そこからも外す。リポジトリの Collaborators and teams に個人で残っていれば外す |
| Actions の secrets | Environments → production → Secrets | `SUPABASE_ACCESS_TOKEN` は作った人の個人のトークンなので、**後輩のアカウントで作り直して入れ替え**、古いトークンを Supabase の Account → Access Tokens で消す。`SUPABASE_DB_PASSWORD` は下の Supabase の行で作り直した値に入れ替える |
| Supabase の組織とプロジェクト | Organization → Team、Project Settings → Database・API Keys | 後輩を Owner にする。抜ける人を外す。**引き継ぎのたびに DB のパスワードを作り直す**：Project Settings → Database → Reset database password で新しいパスワードを作り、Environments → production → Secrets の `SUPABASE_DB_PASSWORD` に入れ直す（[3.2](#32-開発者db-全体を保存するsupabase-db-dump) の `supabase link` で手で入れるので、抜ける人はパスワードを知っている。組織から外しても、postgres ロールで本番 DB に直接つなぐと RLS を通らずに全部の表〔招待のメールアドレスを含む〕を読み書きできる）。secret キー（`sb_secret_…`）を作ったことがあれば、Project Settings → API Keys で作り直して古いものを消す（アプリとビルドは publishable キーだけを使う） |
| Google Cloud のプロジェクト（OAuth クライアント） | IAM | 後輩を Owner にする。抜ける人を IAM から外す。OAuth クライアントのシークレットは Supabase にだけある（作り直したら Supabase に入れ直す） |
| アプリの管理者 | アプリのマスタ設定 → ユーザー | 最新の年度の管理者に後輩を入れる（招待）。卒業する人は自分のロールを外す。管理者がいなくなったら README の 6 の 5 |
| 総務の共有ドライブ | 学校の Google ドライブ | 年度データ・振り分け表・DB のダンプのフォルダの共有を後輩に移す |
| 最後に | 上の各行の画面 | **抜ける人の権限が残っていないことを確かめる**：GitHub の People・Required reviewers・Bypass list・Collaborators、Supabase の Team と Access Tokens、Google Cloud の IAM、アプリのユーザー、共有ドライブの共有に、抜ける人がいないこと。DB のパスワードを作り直した後に migrate.yml（Migrate production DB）が動くことは、次にマイグレーションを適用するときに確かめる |

引き継いだら、後輩が [1](#1-7月の再開と年度の始め方) を一度通しで読み、オーナーの画面にログインできることを確かめる。
