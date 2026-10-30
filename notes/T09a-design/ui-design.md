# 画面の設計（T09〜T14：apps/web）

作成：2026-10-29。対象：フェーズ1の画面（T09 マスタ設定・ダッシュボード、T10 在庫入力・一覧、T11 申請・申請一覧・CSV 取り込み、T12 ルール、T13 振り分け・キャスター机交換・自団体、T14 履歴・通しの E2E・README）と、それらの前に入れる共通基盤（新しいチケット T09a）。

読んだもの：T04 のブランチ（feat/T04-auth）の SPEC.md・CLAUDE.md・docs/requirements/00〜05・docs/prompts/T09〜T14・notes/decisions.md（D-01〜D-19）・notes/T02〜T04.md・supabase/migrations（0003〜0006 の RPC とエラー）・apps/web（T04 の土台）。T06〜T08 と T05 のブランチの 03・04（ロジック側の差分）・notes（D-20〜D-30、T05〜T08.md）・notes/T06-design/logic-design.md（4・13・14 章）・packages/shared・allocator・exporter・importer の公開の型。T00 の notes/T00.md（wasm の読み込み）。DB 設計 db-design.md（5・6・11 章）。T03 のブランチの今の先頭 bd6aef0（T04 がまだ載っていない c96155d・bd42552・f7b1b01：1日目の範囲、本人のメールの判定 private.verified_email・my_verified_email、Google の identity は email_verified が真のときだけ信じる、ローカルの Confirm email、本番の Auth で必ず守る設定）と、その前に入った remove_role・距離の値の範囲・取り込みの submittedAt（2.9 にまとめた）。T03 は積み直されていて、初版が前提にした 2c0f4d9・1c3a0ce は c96155d・bd42552 に書き直された（docs の差は 05 のチケット表の「状態」の列だけ）。T04（今は T03 の古い 1ef50c5 の上）は後で T03 の上に積み直すので、この設計は「T03 の今の先頭 → T04 → T05〜T08」を積んだ状態を前提にする。

実験：scratchpad/ui-lab で T04 に T07・T08・T05 のブランチをマージした clone を作り、Next.js 16.4.2 の静的書き出し（basePath=/GAapp、Turbopack）で Worker・wasm・validate・Excel 出力・表・QR・ダイアログ・フォームを実際に動かした（10 章）。Supabase は起動していない（RLS・RPC の挙動は T03・T04 が PostgREST で確かめたものに従う）。

本文は推奨案で書いた。業務の意味を変える判断は 9 章（ユーザーに確認すること）に残した。決定事項の案は 11 章（D-31〜D-38）。要件定義への差分案は同じフォルダの spec-changes-ui.md。批評（第2版）と、実装者の目で見た抜け（第3版）を受けて直したところは、末尾の「改訂の記録」に番号ごとにまとめた。

## 0. 要点

- **共通基盤を T09a として先に入れる。** UI 部品（shadcn/ui の手置き）、データの読み書きの層（版を先に読むスナップショット、楽観ロックつきの直接の更新・削除、エラーの分類と日本語）、年度の切り替え（K-19）、TanStack Query、未保存の入力の守り（アプリの中の移動の確認と下書き）、全画面のルートの仮置き（準備中のページ）とナビゲーション、テストの土台（jsdom・Playwright のシナリオの年度と年度をまたぐ表の準備）、使う依存の追加を1つの PR にする。T09a は T04・T05・T07・T08 がマージされてから始める（exporter・importer・validate の関数と型を使うため）。その後は T09〜T13 が自分のルートのディレクトリだけを触り、同じファイルを2つのブランチで作らない（8 章）。
- **データ**：読み取りと理由の要らない書き込みは supabase-js で直接（RLS）、理由が要る・複数の表の書き込みは RPC。振り分けに関わる画面（/、/allocation、/swaps）は `years.allocation_version` を最初に読み、残りを並行に読む「スナップショット」を1つの関数で作る。直接の更新・削除は結果の行を受け取り、0 行なら読み直して「他の人が変更しました（消しました）」か「権限・状態が変わった」かを分ける（RLS で拒否された削除はエラーにならず 0 行で返るため）。書き込みのボタンは送信中に押せなくする。通信の失敗の後は、数を絶対値で書く書き込み（在庫・申請）は「分からない」状態を持たず、保存のたびに送る前に読み直して決める。楽観ロックの更新と一意のキーの insert（マスタ・ルール・今年の使用）も確かめる状態を持たず、その場で1回読み直して決め、決められなければふつうに送り直す（前の送信が通っていれば DB が conflict・23505 で止める）。冪等の鍵のない振り分けの行の保存は版で確かめてから送り直す（2.6）。エラーは1つの関数で分類し、日本語の文言と「読み直すか・入力を残すか」を決める（2 章）。
- **振り分けの計算**：振り分け画面を開いたとき（admin で振り分け中のときだけ）に Worker を作り、Worker の中で highs を1回だけ読み込んで使い回す。読み込みの失敗は覚えず、次の実行で読み直す。wasm は `require.resolve('highs/runtime')` から public にコピーする（highs の package.json は exports で公開されていない。実験で確認）。ui-lab で R8 規模の合成データの allocate は 284 ms（初回）、validate は主スレッドで 34 ms、Excel 出力は ExcelJS の遅延読み込み 161 ms＋作成 77 ms で、ブラウザで作った xlsx を LibreOffice で再計算してエラー0・「在庫超過」「要確認」0 だった（4・10 章）。
- **画面**：04 の項目を全部、表示・操作・状態（読み込み中・空・権限なし・年度の状態）・端末・URL で書いた（3 章、付録 A に 04 との対応表）。振り分け画面の手での編集は「未保存の変更」として画面に溜め、理由をつけて save_allocation_rows で1回に送る。検証は未保存の変更を当てた行で主スレッドで回す。
- **テスト**：部品と純粋関数は Vitest（jsdom＋Testing Library。ファイルごとに環境を指定）。E2E はローカルの Supabase に、ローカル専用の補助（pg）でテストごとの「シナリオの年度」を作り、ブラウザの sessionStorage で年度を固定して並行に流す。年度をまたぐ表（場所・距離の上書き）は、並行のテストより前の setup で1回だけ入れ、シナリオは年度の表だけを作る（年度をまたぐ表に書くと、振り分け中のすべての年度の版が上がるため）。年度の作成と年度をまたぐ表を変えるテストは、並行のテストの後に別のコマンドで流す serial に分ける（7 章）。画面の受け入れ（総務で確認）と 4G での表示の速さは、手での確かめ方と記録の仕方を決めた（7.6・7.7）。
- **T03 の今の先頭への合わせ**：remove_role、1日目の範囲（2000-01-01〜2200-12-31）、本人のメールの判定（invite の applied が false でも「アカウントがない」とは言わない。Google の identity の email_verified が偽のときも false。E2E は確かめたユーザーと確かめていないユーザーを作る）、ローカルの Confirm email、本番の Auth で必ず守る設定（T14 の README の確かめ）、距離の範囲、取り込みの submittedAt を画面に入れた（2.9）。エラーは T03 の migrations の `private.fail` の呼び出しをすべて拾い、details の形ごとに文言を決めた（2.5。details のないものも）。
- **差分案**：spec-changes-ui.md に、00・03・04（画面の節すべてと共通の節）・05・CLAUDE.md・SPEC.md・docs/prompts（T09a の新規と T09〜T14・README）・decisions.md（D-31〜D-38）の変更前・変更後と、当てるチケットを書いた。変更前は「T03 の最新 → T04 → T05〜T08」を積んだ文。
- **確認事項**：振り分け表を staff・viewer に見せるか、CSV 取り込みでアプリで提出済みの団体を上書きするか、確定前の Excel 出力、団体代表が了承の回答を変えられるか（9 章）。

## 1. apps/web の構成

### 1.1 ルートと route group

静的書き出し（`output: 'export'`、`trailingSlash: true`）なので動的セグメントは使わず、id はクエリ文字列で渡す。ログインが要る画面はすべて `app/(app)/` の下に置き、T04 の共通レイアウト（AppShell）の中で表示する。route group はこれ以上増やさない（立場の出し分けは各ページの `RequireAudience` で行い、レイアウトを分けない）。

| パス | ファイル | 立場（ナビ・表示） | 端末 | クエリ | チケット |
| --- | --- | --- | --- | --- | --- |
| /login・/auth/callback | app/(auth)/… | 全員 | 両方 | next | T04（済） |
| / | app/(app)/page.tsx | admin・staff はダッシュボード、rep・viewer はホーム | PC（ホームはスマホも） | — | T09 |
| /settings | app/(app)/settings/page.tsx | admin | PC | tab | T09 |
| /stock | app/(app)/stock/page.tsx | admin・staff | スマホ | room | T10 |
| /stocks | app/(app)/stocks/page.tsx | admin・staff | PC | — | T10 |
| /stocks/qr | app/(app)/stocks/qr/page.tsx | admin・staff | PC（印刷） | rooms | T10 |
| /request | app/(app)/request/page.tsx | rep | スマホ | group | T11 |
| /requests | app/(app)/requests/page.tsx | admin・staff（staff は読み取り） | PC | category・filter | T11 |
| /rules | app/(app)/rules/page.tsx | admin | PC | code | T12 |
| /allocation | app/(app)/allocation/page.tsx | admin（Q1 の推奨：staff は読み取り、viewer は確定後に読み取り） | PC | view・tab・row・group | T13 |
| /swaps | app/(app)/swaps/page.tsx | admin | PC | — | T13 |
| /my | app/(app)/my/page.tsx | rep | スマホ | group | T13 |
| /history | app/(app)/history/page.tsx | admin | PC | table・group・from・to・user | T14 |

- クエリの値は各ページで zod で確かめる（uuid・列挙・日付）。合わない値は無視して既定にする（例外にしない）。
- 全ページの雛形（「この画面は準備中です（T10）」と出すだけのページ）を T09a が作り、ナビゲーションの項目をすべて `ready: true` にする。各チケットは自分のページのファイルを中身に置き換えるだけで、lib/navigation.ts を触らない（隣り合う行の変更でマージが衝突するため）。
- 1つのパスの中の切り替え（設定のタブ、振り分けの品目タブ、取り込みのダイアログなど）はルートにせず、クエリかコンポーネントの状態で持つ。
- 画面の中から別の画面へのリンク（ダッシュボードから /swaps、検証の一覧から /rules など）は、行き先の立場（`audiencesFor(href)`）と今の立場を比べる `canOpen(href)`（lib/navigation.ts。T09a）で出し分ける。開けない立場には、リンクにせず文字（件数・ルールのコードと文）だけを出す（押すと権限なしの画面に飛ばさない）。共通の部品 `AppLink`（1.4）が、この判定と未保存の変更の確認をまとめて行う。

### 1.2 ディレクトリ

```
apps/web/
├─ app/
│  ├─ layout.tsx                  ルート（AuthProvider に QueryClientProvider と Toaster を足す。T09a）
│  ├─ (auth)/login, auth/callback T04
│  └─ (app)/
│     ├─ layout.tsx               AppShell（T04）
│     ├─ page.tsx                 ダッシュボード／ホーム（T09）
│     └─ settings/ stock/ stocks/ stocks/qr/ request/ requests/ rules/ allocation/ swaps/ my/ history/   各 page.tsx
├─ components/
│  ├─ ui/                         shadcn/ui の部品（手で置く。T09a）
│  ├─ common/                     アプリ共通の部品（T09a）
│  ├─ layout/ auth/ states.tsx    T04（T09a が少し足す）
│  └─ dashboard/ settings/ stock/ requests/ rules/ allocation/ swaps/ my/ history/   画面ごと（各チケット）
├─ lib/
│  ├─ supabase/ auth/ env.ts navigation.ts utils.ts   T04（auth と navigation は T09a が足す）
│  ├─ db/                         fetchAll・updateWithLock・deleteChecked・型の別名（T09a）
│  ├─ rpc/                        RPC の呼び出しと、jsonb の引数・返り値の zod（T09a）
│  ├─ errors.ts                   エラーの分類と日本語（T09a。@/ の別名を使わず相対の import だけにする。E2E からも読むため）
│  ├─ drafts.ts                   未保存の入力の下書き（localStorage。T09a）
│  ├─ data/                       画面のデータの読み書き。year.ts・snapshot.ts・year-data.ts・room-years.ts・swaps.ts・export.ts（T09a）、画面ごとのファイル（各チケット）
│  ├─ allocation/                 振り分け画面の純粋関数と Worker の呼び出し（T13）
│  ├─ datetime.ts labels.ts download.ts csv-file.ts query.ts   （T09a）
│  └─ schemas/                    common.ts（uuid・年度名・1日目・日時・理由・メール・任意の文字列の共通の zod。T09a）と、画面の入力の zod（画面ごと。各チケット）
├─ workers/allocate.worker.ts     T13
├─ app/icon.png・apple-icon.png・manifest.ts   T14（PWA。1.9）
└─ public/highs.wasm              predev・prebuild でコピー（git に入れない。T09a）
e2e/
├─ support/                       db.ts（シナリオの年度・使い捨てのユーザー）・datasets.ts（small・infeasible の中身）・auth.ts（ログインの保存）・year.ts（年度の固定）・shots.ts（T09a）
├─ setup/                         global.setup.ts（年度をまたぐ表を1回だけ入れる）・auth.setup.ts（storageState）（T09a）
├─ *.spec.ts                      並行に流すもの（チケットごとのファイル）
├─ serial/*.spec.ts               年度の作成・年度をまたぐ表・通しの流れ（並行のテストの後に別のコマンドで順に流す）
├─ fixtures/                      E2E 専用の入力（通しの流れの取り込みの CSV など。個人情報なし。T14）
├─ full-flow/                     通しの流れのデータの事前の確かめ（Vitest。T14）
├─ basepath/                      basePath（/GAapp）で書き出したもののスモーク（T14）
├─ perf.spec.ts                   4G での表示の速さ（CI では流さない。T14）
├─ manual/                        手での確かめに使う年度を作るだけのスクリプト（CI では流さない。T14）
└─ shots/<チケット>.shots.ts       スクリーンショット（CI では流さない）
scripts/copy-highs-wasm.mjs・e2e.mjs   T09a（e2e.mjs は 7.2 の順に Playwright を2回呼ぶ）
```

画面ごとのコンポーネントは `components/<画面>/`、データの関数は `lib/data/<画面>.ts`、入力の zod は `lib/schemas/<画面>.ts` に置く。ページのファイル（page.tsx）は、`<Suspense>` と `<RequireAudience>` で包んで画面のコンポーネントを置くだけにする。

### 1.3 T04 の土台の使い方と、足すもの

| 土台（T04） | 使い方 | T09a が足すもの |
| --- | --- | --- |
| AppShell（components/layout/app-shell.tsx） | すべての画面を包む。ログインしていなければ /login へ、未招待なら「総務から招待されていません」だけ | ヘッダーに年度の切り替え（年度が2つ以上あるときだけ。1.3.1）。切り替えを出すときも、今の年度の「R8・申請受付中」の文字は今までどおり `data-testid="current-year"` の要素に置く（T04 の e2e/auth.spec.ts が確かめている。選択の部品は別の testid）。最新でない年度を開いているときは帯で知らせる。印刷のときヘッダーとナビを隠す（`print:hidden`）。 |
| RequireAudience | 各ページで `allow={audiencesFor('/stocks')}` のように使う。読み込み中は LoadingState、立場が合わなければ ForbiddenState | `audiencesFor(href)`・`canOpen(href, audiences)`（lib/navigation.ts の NAV_ITEMS から引く。ナビ・ページの守り・画面の中のリンクを1か所で決める） |
| states.tsx（LoadingState・EmptyState・ForbiddenState・ErrorState） | 3状態と失敗の表示 | `QueryState`（クエリの状態からどれを出すかを決める部品）、`ReadOnlyNotice`（年度の状態で読み取り専用のときの帯） |
| lib/navigation.ts | ナビの項目と立場 | 全項目を `ready: true`（雛形のページを置く）。/allocation の立場を Q1 の推奨にする（e2e/auth.spec.ts の部員・閲覧のみの期待値も直す） |
| lib/auth/membership.ts | 今の年度と立場 | 選んだ年度（1.3.1）、自分の年度の一覧、`isLatestYear`、`latestWritableYear`、`adminOfOpenYear`（年度をまたぐ表を書けるか。D-01） |
| AuthProvider | ログイン状態と立場 | `setYear(id)`（画面からは UnsavedChangesGuard を通した `useGuardedSetYear()` だけで呼ぶ。1.4）。**立場の読み直しは裏で行う**：T04 の AuthProvider は reloadMembership で loadKey が変わると membership を 'loading' に戻し、AppShell がページ全体を LoadingState に置き換える（画面のコンポーネントが外れ、未保存の変更・フォームの入力・開いているダイアログと理由の入力が消える）。T09a は、同じ user_id の読み直し（reloadKey だけが変わる）では前の membership を `status: 'ready'` のまま出し続け、`isRefreshing: true` だけを足す（読み終えたら新しい値に差し替える。読み直しの失敗は前の値を残して toast で知らせ、ErrorState に置き換えない）。'loading' に戻すのは初回の読み込みと user_id が変わったときだけで、AppShell が LoadingState・ErrorState でページを置き換えるのもそのときだけにする。読み直した結果、開いている年度のロールがなくなった・立場が変わったときは、RequireAudience が権限なしに切り替える（書けないので、入力は下書きに残して戻せるようにする）。Vitest で「reloadMembership の間に子が外れない（子の状態が残る）」「初回は LoadingState」「読み直しの失敗で前の立場が残る」を確かめる。ログアウトは `signOut({ scope: 'local' })`（その端末のセッションだけを終える。既定の global は同じ人のほかの端末・タブのセッションも消すので、共用 PC で抜けたときに本人のスマホまで抜けてしまう。E2E の storageState も壊れる。7.2）。**ログアウトの3つの場合を分ける**（D-33）：(a) 手動のログアウト（ヘッダーのボタン）は、未保存の入力があれば UnsavedChangesGuard で「保存していない入力があります。ログアウトすると下書きも消えます」と確かめ、やめなければ React Query のキャッシュ・その人の下書き（lib/drafts.ts）・選んだ年度を消してから signOut する（共用 PC で前の人のデータを残さない）。(b) 401 などで強制的に signOut するとき（2.5 の auth）は、確かめず、下書きを消さない（キーに user_id が入っているので別の人には戻す表示が出ない。同じ人がログインし直せば戻せる）。キャッシュと選んだ年度は消す。(c) 前と違う user_id でログインしたとき（利用者の切り替え）は、キャッシュを消し、自分以外の user_id の下書きを消す（(b) で残った前の人の下書きを共用 PC に残さない）。ほかのタブで手動のログアウトをして、このタブに SIGNED_OUT が届いたときは (b) と同じに扱う（このタブでは確かめられない） |
| lib/supabase/client.ts | publishable キーのクライアント1つ | 変えない |
| app/(auth)/login/page.tsx | ログイン | アプリ内ブラウザ（LINE・Instagram・Facebook などの userAgent）を見分けたら、Google のボタンの上に「LINE などのアプリの中では Google でログインできません。Safari か Chrome で開いてください」と URL のコピーのボタンを出す（Google は埋め込みのブラウザでの OAuth を disallowed_useragent で拒否する。部屋の QR を LINE のカメラで読んだときなど。見分けは目安で、ボタンは隠さない） |

#### 1.3.1 今の年度の決め方（K-19 の決定案。D-31）

- 既定は今までどおり「ロールか団体代表の行がある年度のうち1日目が最も遅いもの」（以下「最新の年度」）。
- 年度が2つ以上ある人には、ヘッダーに年度の選択を出す（「R9（準備中）」「R8（終了）」の順。1日目の新しい順）。選んだ年度は **sessionStorage**（タブごと。キーは `gaapp:year:<user_id>`）に置き、そのタブの中で画面を移っても使う。新しいタブ・ブラウザを閉じた後・部屋の QR から開いたとき（カメラのアプリは新しいタブで開く）は、既定の最新の年度で開く。localStorage には残さない（一度前年度を見ただけで、次の日の在庫入力や申請が前年度で開くのを避ける）。その年度のロールも団体代表もなくなっていれば既定に戻す。読み書きは try/catch で包み、読めなければ既定を使う。
- 最新でない年度を開いているときは、ヘッダーの下に「最新でない年度（R8・終了）を表示しています ［最新の年度（R9）に切り替える］」と出す。
- **書き込む画面の守り**：在庫入力（/stock）・申請（/request）・自団体（/my の了承）は、開いている年度が最新の年度でないとき、画面の上部に大きなボタン「最新の年度（R9）に切り替える」を出し、保存・提出・回答の前に「最新でない年度（R8・確定中）に保存します。よろしいですか」と確かめる（確定中の旧年度に、管理者が増やす数え直しを書けてしまうため）。終了した年度は今までどおり読み取り専用。
- 年度は URL に入れない（QR の URL を年度によらず同じにするため。在庫入力は開いている年度に書き、QR から開けば最新の年度になる）。E2E は sessionStorage に年度を入れて固定する（7.2。`addInitScript` で入れるので、ページを移っても同じタブの中で残る）。
- 立場（ナビ・RequireAudience）は選んだ年度での立場で決める。React Query のキーには年度の id を入れるので、切り替えると別のキャッシュになる。
- **年度の切り替えも未保存の入力を守る**：setYear は画面の移動ではないので AppLink・useGuardedRouter の守りを通らず、そのままでは未保存の入力のまま別の年度のデータに切り替わる。ヘッダーの年度の選択、最新でない年度の帯と書き込む画面の「最新の年度に切り替える」、年度の作成の後の切り替え（3.2）は、すべて `useGuardedSetYear()`（lib/auth。T09a）を使い、未保存の入力があれば「保存していない入力があります。年度を切り替えますか（入力は下書きに残ります）」と確かめる。やめれば選択を元に戻す。ESLint で、components/layout と lib/auth の外から setYear を直接呼ぶことを止める。立場の読み直しで今の年度が既定に戻るとき（ロールがなくなった）は確かめられないので、そのまま移る（入力は年度ごとの下書きに残る）。

### 1.4 共通の部品

**UI 部品（components/ui/。T09a）**：shadcn/ui の new-york（v4・Tailwind 4）のソースを手で置く。ui.shadcn.com はこの環境から届かないが、GitHub の raw（`https://raw.githubusercontent.com/shadcn-ui/ui/<コミット>/apps/v4/registry/new-york-v4/ui/<名前>.tsx`）は届く（確認済み。2026-10-29 の main は `96da9cc7`）。取ってきたら import を書き換える（`"cn"` → `@/lib/utils`、`@/registry/new-york-v4/ui/…` → `@/components/ui/…`）。ファイルの先頭に元のコミットを書く（MIT）。sonner の部品は next-themes を外す（テーマの切り替えはしない）。T04 の Button は asChild がないので、上流の版（radix-ui の Slot つき）に置き換えてよい（見た目は同じ）。

置くもの：button（置き換え）・input（T04）・label・textarea・select・checkbox・switch・radio-group・dialog・alert-dialog・sheet・tabs・table・badge・card・separator・skeleton・tooltip・popover・dropdown-menu・command（cmdk）・sonner・form（react-hook-form）・scroll-area・toggle-group。

**アプリ共通の部品（components/common/。T09a）**

| 部品 | 中身 |
| --- | --- |
| DataTable | TanStack Table v8 の薄い包み。並べ替え、見出しの固定（sticky）、行の id を `data-row-id` に出す（検証の一覧から行へ飛ぶため）、行のハイライト、空のときの EmptyState。表の中だけを横にスクロールさせ、ページは横にスクロールさせない |
| CountStepper | ＋－ボタンと数字の入力（整数。`min`・`max` を渡す。既定は 0〜10000。`inputMode="numeric"`、フォーカスで全選択、長押しはしない）。在庫入力・申請は min 0、振り分けの行は min 1（allocations.count の CHECK は 1〜10000。0 にしたいときは「削除」を案内する） |
| ReasonDialog | 理由の入力（必須かどうかを渡す。1〜500 字。DB の set_reason と同じ上限）。よく使う理由のボタン（「数え直し」「団体の希望」など、呼ぶ側が渡す）。送信中は確定のボタンを押せなくする |
| ConfirmDialog | 確認（破壊的な操作は赤いボタン）。送信中は確定のボタンを押せなくする |
| ErrorBanner | 分類したエラー（2.5）の文言と、「読み直す」「もう一度」のボタン |
| TokyoTime | 日時を Asia/Tokyo で表示（`2026/10/05 18:01`）。title に秒まで |
| YearStatusBadge | 年度の状態（準備中…終了）の印 |
| YearStatusActions | 年度の状態の遷移のボタンと理由のダイアログ、確定の流れ（2.2・3.1）。ダッシュボード（T09）と振り分け画面（T13）が使うので T09a に置く |
| EntitySelect | 団体・場所・品目を名前で選ぶ（cmdk の Combobox。区分や保管場所で絞れる） |
| UnsavedChangesGuard | 未保存の変更があるときの守り。(1) アプリの中のリンク：`AppLink`（next/link の包み）の `onNavigate` で確かめ、やめたら `e.preventDefault()` で止める（Next 16.4.2 で止まることを批評の実験で確認）。ナビ（AppNav）・PageHeader・画面の中のリンクはすべて AppLink を使う。(2) コードからの移動：`useGuardedRouter()`（lib/navigation.ts）の push・replace だけを使い、ESLint で `useRouter` の直接の push・replace を止める。(2b) ログアウト：手動のログアウト（ヘッダーのボタン）は (1) と同じく確かめ、やめなければ下書きを消してからログアウトする。401 などで強制的に signOut して /login へ移るときは、確かめず、下書きを残して移る（1.3 の AuthProvider の (a)〜(c)）。(2c) 年度の切り替え：`useGuardedSetYear()` で (1) と同じく確かめる（1.3.1。入力は年度ごとの下書きに残る）。(3) タブを閉じる・再読み込み・別のサイト：beforeunload。(4) ブラウザの戻る・進む、iOS Safari のタブの破棄、別のアプリへの切り替え：止められない（App Router にはルートの変化のイベントがなく、iOS は beforeunload をほとんど出さない）ので、下の「下書き」で戻せるようにする。部品のテスト：未保存の入力があるとき、手動のログアウトは確かめ、やめればログアウトせず下書きも残る・続ければ下書きが消える。強制の signOut では確かめず下書きが残る。年度の選択を変えると確かめ、やめれば選択が元に戻る |
| 下書き（lib/drafts.ts） | 未保存の入力を localStorage に置く（キー `gaapp:draft:<user_id>:<year_id>:<画面>:<部屋・団体など>`。入力のたびに 500 ms まとめて書く。24 時間で捨てる）。画面を開いたときに下書きがあれば「保存していない入力があります（hh:mm）［戻す］［捨てる］」を出す。保存に成功したら消す。消すのは、手動のログアウトで確かめた後（その人の下書きをすべて）と、前と違う user_id でログインしたとき（自分以外の下書き）だけ。401 などでの強制の signOut では消さない（同じ人がログインし直せば戻せる。キーに user_id が入っているので、別の人には出ない）。関数は `clearDraftsOf(userId)`・`clearDraftsExcept(userId)`。読み書きは try/catch で包み、使えなければ下書きなしで動く。在庫入力（部屋ごと）・申請（団体ごと）・申請一覧のセル・振り分けの未保存の変更で使う（振り分けは戻すときに rebasePending で当て直す）。CLAUDE.md の「送っていない下書き」の使い方で、保存の代わりにはしない |
| AppLink | next/link の包み。`canOpen(href)` が偽なら文字だけを出し、未保存の変更があれば移る前に確かめる |
| PageHeader | 画面の題名、年度の状態、最終読み込み日時と「読み直す」 |
| StaleBanner | 版の見張り（2.6）で、ほかの人の変更に気づいたときの帯 |

**送信中の決まり**：書き込みのボタン（保存・提出・確定・了承・取り込みなど）は、送信している間（useMutation の isPending）押せなくし、「保存中…」と出す。ReasonDialog・ConfirmDialog の確定のボタンも同じ。二重押しで同じ insert を2回送らないため（2.6）。

### 1.5 データの読み書きの層

| ファイル（T09a） | 中身 |
| --- | --- |
| lib/db/fetch-all.ts | `fetchAll(query, pageSize = 1000)`：主キーの順に `.range()` で分けて全部読む（Supabase の max_rows = 1000 を超えうる表のため） |
| lib/db/update-with-lock.ts | `updateWithLock(table, match, updatedAt, patch)`（2.3） |
| lib/db/delete-checked.ts | `deleteChecked(table, match, updatedAt?)`：`delete().match(主キー).select()` で消えた行を受け取り、0 行なら読み直して not_found・conflict・forbidden に分ける（2.3） |
| lib/data/room-years.ts | `setRoomUsable(yearId, roomId, updatedAt, usable, note)`：今年の使用（room_years）の書き込み。updatedAt は読み込んだときの updated_at（行がなければ null）で、行があれば updateWithLock、なければ insert（23505 は conflict）。黙って上書きしない（2.3）。マスタ設定（T09）と振り分け画面の部屋の見出し（T13）で使う。`fixedRowsFrom(rows, roomId)`：その部屋からの固定・手動の行（使用不可にする前に直すもの。3.9） |
| lib/db/types.ts | `Tables<'groups'>` などの別名、列のリスト（select の文字列を1か所に） |
| lib/rpc/index.ts | `callRpc(name, args)`：supabase-js の rpc を呼び、エラーなら AppError を投げる。jsonb の返り値は zod で確かめる（save_auto_allocations・save_allocation_rows・invite） |
| lib/rpc/payloads.ts | jsonb の引数の型と zod（AllocationRow の配列、save_allocation_rows の changes、申請の rows、update_year の patch、p_submission） |
| lib/errors.ts | `classifyError(e)` と `messageFor(kind, ctx)`（2.5）。`isUnknownOutcome(e, status?)`（保存できたか分からない失敗か）と `unknownOutcomeMessage(verb?)`（2.6） |
| lib/data/absolute-save.ts | `decideAbsoluteSave(entries, equals?)`：数を絶対値で書く書き込みの、送る前の読み直しの判定（'saved'・'conflict'・'send'。2.6 の (A)） |
| lib/data/locked-save.ts | `settleLockedWrite({ reread, matches, baseVersion, versionOf })`：楽観ロックの更新・一意のキーの insert で、応答が届かなかったとき・止められたときに対象の行を読み直して決める（'saved'・'changed'・'not-saved'・'unread'）。`isLockRejection(e)`：conflict・not_found（23505 を含む）か（2.6 の (B1)） |
| lib/data/year.ts | 年度の行を読む（状態・版・受付期間） |
| lib/data/snapshot.ts | `loadSnapshot(yearId, part)`：版を先に読み、残りを並行に読む（2.2） |
| lib/data/year-data.ts | DB の行 → YearData（2.7。純粋関数） |
| lib/data/validation.ts | `useValidation(snapshot, extraRows?)`：validate を主スレッドで回す（未保存の変更があるときは 150 ms まとめて）。toYearData の validatable が偽なら validate を呼ばない。validate が例外を投げたら（あるいは validatable が偽なら）「検証できません」と toYearData の problems の一覧を出す（2.7） |
| lib/data/version-watch.ts | `useVersionWatch(yearId, version)`（2.6） |
| lib/datetime.ts | Asia/Tokyo の表示と、日時の入力（`datetime-local`）の変換（2.8） |
| lib/labels.ts | 列挙の日本語（状態・区分・場所の種類・了承・ルールの種別・自動／手動・監査の表名と操作） |
| lib/download.ts | Uint8Array・文字列をファイルとして保存（Blob と a 要素） |
| lib/csv-file.ts | CSV ファイルの文字コードを決めて読む（UTF-8 → だめなら Shift_JIS。5 章） |
| lib/query.ts | QueryClient の既定値、クエリのキーの作り方 |

画面ごとの読み書き（`lib/data/stocks.ts`・`requests.ts`・`settings.ts`・`rules.ts`・`allocation.ts`・`swaps.ts`・`my.ts`・`history.ts`・`year-export.ts`）は各チケットが作る。

### 1.6 フォームと検証

- 入力の確かめは zod（shared と同じ 4.6.7）。DB の上限（数 10000、自由記述 2000 字、名前 100 字、理由 500 字、別名 20 個・1000 字、距離 0〜20、代替の重さ 0〜10、年度名 50 字、1日目 2000-01-01〜2200-12-31、メール 254 字）は shared の定数（MAX_COUNT・MAX_DISTANCE_COST など）を使い、画面で数字を書き直さない。shared にない上限（年度名・1日目・理由・メール）は lib/schemas/common.ts（T09a）に1回だけ書き、DB の CHECK・RPC と同じ値であることをコメントで示す（1日目の範囲は years の CHECK `years_festival_start_check`。D-18）。
- **任意の文字列は、空なら null にそろえる**：lib/schemas/common.ts の `optionalText(max)`（前後の空白を除き、空なら null にする transform）を、場所の建物・団体の表示名・各表の備考とメモ・使用不可の理由に使う。DB は空文字を許す（CHECK は長さの上限だけ）が、shared の roomSchema.building・groupSchema.displayName は `z.string().min(1).nullable()` なので、空文字を保存すると toYearData の結果を allocate が invalid_input で拒む。必須の名前（場所名・団体名・建物の組）は前後の空白を除いて1字以上。
- ダイアログとフォーム（設定の各表の追加・編集、招待、年度、ルール、理由）は react-hook-form＋`@hookform/resolvers/zod`。型は `useForm<z.input<S>, unknown, z.output<S>>`。
- 表の中の入力（在庫の＋－、申請一覧のセル、振り分けの行）は react-hook-form を使わず、画面の状態（変更の一覧）とセルごとの zod で確かめる。
- 共有のスキーマを使う：団体名は shared の groupNameSchema と checkGroupNames（年度の全団体で重複を見る）、ルールは ruleRowSchema と checkRuleRefs、日時（取り込みの提出日時）は `z.iso.datetime({ offset: true })`。
- RPC のトップレベルの型つきの引数（uuid・enum・date・integer）は送る前に zod で確かめる（形が違うと PostgREST が 22P02 などを返すため）。

### 1.7 状態の持ち方

| 種類 | 持ち方 |
| --- | --- |
| サーバーのデータ | TanStack Query。既定は `staleTime: 30s`、`refetchOnWindowFocus: false`（編集中の画面を勝手に書き換えない）、再試行は通信の失敗だけ1回（P0001・42501 などは再試行しない）。キーは `['year', yearId, …]` と `['rooms']`・`['items']`・`['distance']`。書き込みの後は関係するキーを invalidate する。振り分けのスナップショットは `staleTime: Infinity` で、読み直しは明示的に行う |
| 画面の場所 | URL のクエリ（タブ、品目、団体、行、絞り込み）。再読み込みと共有で同じ画面に戻れる |
| 編集中の値 | コンポーネントの状態（未保存の変更の一覧）。React Query のキャッシュに混ぜない。写しを下書き（localStorage。1.4）に置く |
| 選んだ年度 | sessionStorage（タブごと。1.3.1。try/catch で包む） |
| 立場 | AuthProvider（T04） |

グローバルの状態管理のライブラリ（Zustand など）は入れない。

### 1.8 ライブラリと版

すべて exact で書き、pnpm の `minimumReleaseAge: 10080`（7日）を守る（2026-10-29 の時点で7日より前に出た版）。T09a が T09〜T14 で使う依存をまとめて足し、後のチケットは package.json と pnpm-lock.yaml を触らない（並行するブランチで lockfile が衝突するため）。

| パッケージ | 版（公開日） | 用途 | メモ |
| --- | --- | --- | --- |
| radix-ui | 1.8.1（2026-10-12） | shadcn/ui の部品の土台 | 実験で Dialog が動いた |
| @tanstack/react-table | 8.21.3（2025-04-14） | 表 | v9（2026-08 に安定版）は API が変わり（features の登録・store）、shadcn の例も v8 なので v8 に固定する。React 19.3 で動いた |
| @tanstack/react-query | 5.104.5（2026-10-19） | サーバーのデータ | 5.105.0 は7日未満 |
| react-hook-form | 7.90.0（2026-10-11） | フォーム | 7.91.0 は7日未満 |
| @hookform/resolvers | 5.9.2（2026-10-17） | zod 4 をフォームに | 6.0 系は出たばかりの大きな版なので 5 系にする |
| zod | 4.6.7（2026-10-12） | 入力の確かめ | shared と同じ版 |
| sonner | 2.0.8（2026-08-09） | 通知（toast） | |
| cmdk | 1.1.1（2025-03-14） | 名前で選ぶ部品 | |
| uqr | 0.1.3（2026-04-03） | QR（SVG の文字列を作る。依存なし） | 実験で静的書き出しで動いた |
| highs | 1.15.4 | Worker の中だけ | allocator の devDependencies と shared の HIGHS_VERSION と同じ（shared のテストが版の一致を確かめる） |
| lucide-react・next・react・supabase-js・tailwind | T04 のまま | | |
| （dev）jsdom | 30.1.3（2026-10-15） | 部品のテスト | |
| （dev）@testing-library/react・user-event・dom | 16.3.3・14.6.8・10.4.2 | 部品のテスト | 実験で Vitest 5.0.5・React 19.3.1 で動いた |
| （dev、ルート）pg・@types/pg | 8.23.1・8.23.1 | E2E のシナリオの年度（ローカルの DB だけ） | 7.2 |
| （dev、ルート）@gaapp/shared・@gaapp/allocator | workspace:* | E2E の補助が合成データを読み（shared/testing）、通しの流れで最小変更を判定する（allocator/testing） | 7.2・7.3。allocator の package.json の exports に `"./testing"`（src/testing の d08.ts・getHighs.ts を出す index）を足す（ロジックは変えない） |

ESLint（T09a が足す。apps/web）：
- `highs` は apps/web/workers/ の外から import しない。
- `@gaapp/exporter` は静的に import しない（使う所で `await import('@gaapp/exporter')`。ExcelJS 約 0.9 MB を最初の読み込みに入れない）。テストは例外。
- `no-console`（`warn`・`error` だけ許す）。CSV の中身・申請の中身・メールをログに出さない。

### 1.9 静的書き出しで守ること

- `useSearchParams` を使うコンポーネントは、ページで `<Suspense fallback={<LoadingState />}>` に包む（包まないと `next build` が「useSearchParams() should be wrapped in a suspense boundary」で失敗する。実験で確認）。
- `window`・`location`・`localStorage`・`Worker` はプリレンダーの間はないので、useEffect かイベントの中だけで使う（実験で、描画中に `location` を読むとビルドが失敗した）。
- リンクは `next/link`（AppLink）の `href="/stock?room=…"`（basePath と末尾のスラッシュは Next.js が付ける）。public のファイル（highs.wasm）、QR に入れる絶対 URL、マニフェストの JSON の中の start_url・scope・icons の src は自分で basePath を付ける（`BASE_PATH` を lib/env.ts から）。
- アイコンは Next のファイルの規約（app/icon.png・app/apple-icon.png）で置く。metadata の icons に文字列で書くと basePath が付かず、GitHub Pages で 404 になる（批評の実験。ファイルの規約なら `<link rel="icon" href="/GAapp/icon.png?…">` と付くことを ui-lab で確かめた。10 章）。
- Route Handler・Server Action・middleware・`[id]` は使わない。

## 2. データの読み書き

### 2.1 立場と RLS で見えるもの

画面は「RLS で読めない表を読みに行かない」ようにし、読めない結果（0 行）を「データがない」と取り違えない。年度の状態で書けなくなるときは、送る前に読み取り専用にする（送って拒否されても、2.5 のとおり読み直して読み取り専用に切り替える）。

| 画面 | admin | staff | 団体代表（rep） | viewer |
| --- | --- | --- | --- | --- |
| / | ダッシュボード（すべて読める。状態の遷移） | ダッシュボード（読み取り。遷移のボタンなし） | ホーム（自団体の申請の状況・了承の依頼・確定後のリンク） | ホーム（確定後なら振り分け表へのリンク） |
| /settings | 読み書き（closed は「外す」・招待の取り消し・新しい年度の作成〔create_year_from。複製元が終了していてもよい〕だけ） | — | — | — |
| /stock・/stocks | 読み書き（closed 以外。確定中は在庫超過になる値を書けない） | preparing・requesting は読み書き、ほかは読み取り | — | — |
| /request | （兼ねていれば rep として） | （同左） | 自団体だけ。受付期間内に提出 | — |
| /requests | 読み書き（締切前は直接、締切後は RPC） | 読み取り | — | — |
| /rules | 読み書き（confirmed・closed は memo だけ。confirmed は DB では書けるが、画面で止める。3.8） | （RLS は読めるがナビに出さない） | — | — |
| /allocation | 読み書き（振り分け中） | Q1：読み取り（在庫・余り・検証も読める） | — | Q1：確定後の行だけ（在庫・余り・検証なし。stocks・requests を RLS で読めないため） |
| /swaps | 読み書き（振り分け中） | — | — | — |
| /my | — | — | 自団体：申請と了承の依頼、確定後の振り分け | — |
| /history | 読める（その年度。年度をまたぐ3表は開いている年度の admin） | — | — | — |

画面ごとに読むもの・書くもの：

| 画面 | 読む（順） | 書く |
| --- | --- | --- |
| /（ダッシュボード） | 年度の行（版）→ スナップショット（full） | set_year_status |
| /（ホーム） | membership（T04）、rep：自団体の request_submissions・substitution_consents | — |
| /settings 年度 | 自分の年度（years） | update_year、create_year_from |
| /settings 場所 | rooms、room_years（年度） | rooms と room_years を直接 |
| /settings 品目 | items | items を直接 |
| /settings 団体 | groups（年度）、rooms | groups を直接（追加・変更・削除・CSV の upsert） |
| /settings 距離 | distance_overrides、rooms（建物の一覧） | distance_overrides を直接 |
| /settings ユーザー | year_roles・group_members（年度の団体）・invitations（年度）・profiles | invite、set_role、remove_role、revoke_invitation、remove_group_member |
| /settings 書き出し | 年度の行 → 年度の全データ（無効なルール・備考・別名を含む） | —（ファイルを作るだけ） |
| /stock | 年度の行、rooms、room_years、items、stocks（年度・部屋）、profiles（数えた人）、RPC previous_year_stocks（読み取り。admin・staff）、（admin で振り分け中・確定中）v_remaining（部屋） | stocks を直接（upsert） |
| /stocks・/stocks/qr | 年度の行、rooms、room_years、items、stocks（年度）、RPC previous_year_stocks | — |
| /request | 年度の行、groups（自団体）、items、rooms（使用場所の名前）、requests・request_submissions（自団体） | submit_requests |
| /requests | 年度の行、groups、items、requests（`groups!inner(year_id)` で年度に絞る）、request_submissions、（admin）previous_year_requests | 締切前：requests を直接（楽観ロック）、提出の記録は submit_requests か request_submissions を直接。締切後と取り込み：update_requests_after_deadline |
| /rules | 年度の行、rules（年度・無効を含む）、items、rooms、groups | rules を直接 |
| /allocation・/swaps | 年度の行（版）→ スナップショット | save_auto_allocations、save_allocation_rows、set_year_status、set_consent、room_years を直接（部屋の見出しの「使用不可にする」。3.9） |
| /my | 年度の行、groups（自団体）、items、rooms、requests・request_submissions・substitution_consents（自団体）、allocations（自団体。確定後だけ行が返る） | set_consent（了承・拒否） |
| /history | audit_logs（年度）、groups（年度）、rooms、items、profiles | — |

### 2.2 版を先に読む（スナップショット）

振り分けの入力と結果に関わる画面（ダッシュボード、振り分け、キャスター机交換）は、`loadSnapshot(yearId, part)` で読む。

1. `years` の行（id・label・status・allocation_version・auto_allocated_at・festival_start・request_open_at・request_close_at・prev_year_id）を読み、**これが返ってから** 2 を始める。先に読んだ版 v の後に読んだデータは、v の時点かそれより新しい。途中で何かが変われば版は v より進むので、v を渡した保存・確定は conflict になり、取りこぼさない。
2. 残りを並行に読む。part = `full`（admin・staff）：items、rooms、room_years、groups、request_submissions、stocks、requests、rules（年度の全部）、substitution_consents、distance_overrides、allocations。part = `public`（viewer）：items、rooms、room_years、groups、allocations。requests と substitution_consents と request_submissions は `groups!inner(year_id)` で年度に絞る。行の多い表（stocks・requests・allocations）は fetchAll で読む。
3. 返す形：`Snapshot = { year, version, loadedAt, …各表の DB の行 }`。DB の行のまま持ち、画面ごとに 2.7 の変換を当てる（updated_at などの編集に要る列を失わないため）。

- テスト：偽のクライアントで「years の応答の前にほかの問い合わせを出さない」ことを確かめる（lib/data/snapshot.test.ts）。
- 版を引数に取る RPC は save_auto_allocations（p_base_version）と set_year_status の確定（p_base_version）だけ。save_allocation_rows・set_consent は版を取らないが、返り値・読み直しで版を合わせる（3.9・3.10）。
- 振り分けに関わらない画面（在庫・申請・設定・ルール・履歴）も、最初に年度の行を読む（状態で書けるかを決めるため）。版は使わない。

### 2.3 直接の書き込み

- 理由の要らない書き込み（在庫、締切前の申請一覧のセル、マスタ、ルール、使用不可の設定）は `supabase.from(…).insert/update/upsert/delete` で行う（使用不可の設定は upsert でなく setRoomUsable。下）。
- 既存の行の更新は `updateWithLock` を使う：`update(patch).match(主キー).eq('updated_at', 受け取った文字列).select().maybeSingle()`。updated_at は受け取った文字列をそのまま返す（Date に通すとマイクロ秒が落ちて一致しない）。0 行なら、その行の updated_at を読み直して分ける：行がない → not_found、updated_at が違う → conflict、同じ → 権限か状態が変わった（締切・年度の状態・ロール）→ forbidden として扱い、年度の行と立場を読み直す。
- **削除も 0 行を確かめる**：RLS の USING で拒否された delete はエラーにならず、0 行で成功する（groups・rules・room_years は can_admin で closed では偽、rooms・distance_overrides は is_admin_of_open_year。団体のトリガー tg_groups_before_write も、RLS の対象で can_admin が偽なら old を返すだけでエラーにしない）。そのため削除は `deleteChecked`（`delete().match(主キー).select()`。updated_at を持っていれば `.eq('updated_at', …)` も）で消えた行を受け取り、0 行なら updateWithLock と同じく読み直して、行がない → not_found（「すでに消えていました」として一覧を読み直す）、updated_at が違う → conflict、同じ → forbidden（年度の行と立場を読み直す）に分ける。「削除しました」は消えた行が返ったときだけ出す。
- 楽観ロックを必須にするのは requests（02 の決めごと）。マスタ・ルール・場所の状態も同じ helper で更新し、黙って上書きしない。
- 場所の今年の使用（room_years）は upsert しない（ほかの人の変更を黙って上書きするため）。`setRoomUsable(yearId, roomId, 読み込んだときの updated_at〔行がなければ null〕, usable, note)`（lib/data/room-years.ts）で、行があれば updateWithLock（0 行は上と同じく not_found・conflict・forbidden に分ける）、行がなければ insert（23505 はほかの人が先に足したので conflict）。conflict・not_found なら room_years を読み直して「ほかの人が変えました」と知らせ、入力は残す。
- 在庫（stocks）は部屋の全品目を1回の upsert で書く（3.3。保存の直前に読み直して、ほかの人の保存を確かめる）。
- insert の重複（23505）は「同じものがすでにあります（ほかの人が先に足した可能性）」として読み直す。updateWithLock の conflict・not_found と insert の 23505、応答が届かなかったときは、一意のキー・主キーで行を読み直し、入力と同じなら「保存されていました」とする（2.6 の (B1)。settleLockedWrite）。
- 数えた人・日時（counted_by・counted_at）、更新した人（updated_by）は送らない（DB が入れる。D-10）。提出日時（submitted_at）も値としては送らない。例外は、締切前に管理者が「提出済みにする」直接の upsert（3.6）だけで、`{ group_id, submitted_at: 今の時刻の ISO }` を送る（トリガー tg_submissions_set_actor は、送られた submitted_at が null でないときだけ now() に置き換えるので、何かの値を送らないと提出済みにならない。送った値は使われない）。note は送らず、今の備考を消さない。

### 2.4 RPC の呼び方と返り値

- 引数は `p_` つきの名前で渡す（`callRpc('save_auto_allocations', { p_year_id, p_rows, p_mode, p_base_version })`）。jsonb の引数は lib/rpc/payloads.ts の zod で作ってから送る（振り分けの行は AllocationRow と同じ camelCase）。
- 件数の上限：save_auto_allocations の rows は 10000 行まで、save_allocation_rows の changes は 1〜1000 件、申請の rows は 100 行まで。超えるときは画面で止める（振り分けの変更は 1000 件ごとに分けず、1000 件を超えたら「変更が多すぎます。保存してから続けてください」）。
- jsonb の返り値は zod で確かめる：save_auto_allocations は `{ allocation_version, deleted, updated, inserted }`、save_allocation_rows は `{ allocation_version_before, allocation_version, rows: ({ op: 'insert'|'update', row: allocations の行 } | { op: 'delete', id })[] }`、invite は `{ invitation_ids, applied }`。合わなければ「予期しない応答」として読み直す。

### 2.5 エラーの分類と日本語

`classifyError(e)` は supabase-js のエラー（`{ code, message, details, hint }`）と通信の失敗を、次の種類に分ける。details は JSON の文字列か空文字なので、安全に parse する（失敗したら null）。

| 条件 | 種類 | 文言（例） | 画面の動き |
| --- | --- | --- | --- |
| code P0001・message `forbidden`、code 42501 | forbidden | 権限がありません。立場が変わった可能性があります | 立場（membership）と年度の行を読み直す |
| P0001 `not_found` | not_found | 対象が見つかりません（ほかの人が消した可能性があります） | 読み直す |
| P0001 `invalid_state` | state | details で分ける：`{status}` →「年度が「{状態}」のため、この操作はできません」、`{reason:'last_admin'}` →「最後の管理者は外せません」、`{reason:'not_latest'}` →「最新の年度からだけ新しい年度を作れます」、`{reason:'used'}` →「使用済みの招待は取り消せません」、`{reason:'no_rows'}` →「置き換えの行がないので依頼できません」、`{field:'request_close_at'}` →「受付開始の前に、締切を未来の日時で入れてください」、`{status, code:'E001'|'E002', room_id, …}`（確定中の守り。在庫を振り分けの合計より減らす・振り分けのある部屋を使用不可にする）→「確定中は、在庫超過や使用不可の部屋からの振り分けになる変更はできません。確定を解除してから直してください」（部屋と品目の名前を添える） | 年度の行を読み直し、読み取り専用に切り替える |
| P0001 `conflict` | conflict | 「他の人が先に変更しました。読み直しました」。details で分ける：`{field:'label'}` →「同じ年度名があります」、`{field:'role', current}` →「この人はすでに「{ロール}」です。ロールの変更はメンバーの一覧から」、`{asked, current}` →「依頼した台数（{asked}）より置き換えが増えています（{current}）。依頼し直してください」 | 読み直す（振り分けの未保存の変更は 3.9 のとおり当て直す）。入力は残す |
| P0001 `invalid_input` | input | 入力の形が違います（{field}） | 入力を残す |
| P0001 `reason_required` | reason | 理由を入力してください | 理由の欄に出す |
| P0001 `E001`・`E002`・`E005`・`E006` | issue | E001「在庫を超えます（{部屋}の{品目}：振り分け{n}、在庫{m}）」、E002「使用不可の部屋（{部屋}）からは振り分けられません」、E005「残すと使用場所が合いません（{団体}）」、E006「{団体}は{品目}を申請できません」。details は1件の object（save_allocation_rows の E002 `{room_id}`、トリガーの E005 `{group_id, source_room_id}`・E006 `{group_id, item_id}`）か、配列（set_year_status の確定と save_auto_allocations：`private.confirm_issues` の `{code, room_id, item_id, allocated, stock}`・`{code, allocation_id, room_id}`・`{code, allocation_id, group_id}`、save_auto_allocations の保存前の `{code, ord, room_id\|group_id}`）。classifyError は両方を配列にそろえる | details の id を名前にして一覧で出す（allocation_id は 3.9 の行へのリンク）。読み直す |
| code が 22 で始まる | input | 入力の形が違います | 入力を残す（送る前の zod の漏れなので、テストで潰す） |
| 23505 | conflict | 同じものがすでにあります | 読み直す |
| 23503 | blocked | ほかのデータから使われているので削除できません | そのまま |
| 23514 | input | 入力が範囲を超えています（例：同じ建物どうしの距離） | 入力を残す |
| 40P01 | deadlock | ほかの人の保存と重なりました。もう一度保存してください | 入力を残す。自動で再送しない |
| code が PGRST301・PGRST302・PGRST303（JWT が読めない・ない・期限切れなど）か、HTTP の status が 401 | auth | ログインし直してください | まず `supabase.auth.refreshSession()` を1回試し、成功したら同じ要求を1回だけ送り直す。だめなら下書きを残して（消さない。1.3 の (b)）`signOut({ scope: 'local' })` でその端末のセッションを消し、/login?next=… へ移る（セッションを消さずに移ると、T04 の /login が「ログイン済みなら戻り先へ」とすぐ戻し、戻った画面がまた 401 を受けて行き来が止まらないため）。classifyError には supabase-js の応答の status も渡す |
| fetch の失敗（code なし、TypeError） | network | 通信できませんでした。電波の良い所でもう一度 | 入力を残す。読み取りは1回だけ再試行。書き込みは自動で再送せず、2.6 の「通信の失敗の後の書き込み」に従う |
| それ以外 | unknown | 予期しないエラーが起きました（コード：{code}） | 入力を残す |

- HTTP 500 を一律に扱わず code で分ける（40P01 は HTTP 500 で来る）。
- 文言にメールアドレス・CSV の中身を入れない。details に団体・部屋・品目の id があれば、画面が持っている名前に置き換える（名前がなければ出さない）。
- lib/errors.test.ts で、上の表の行と下の details の行を1つずつ確かめる（PGRST303 と status 401 の行を含む）。
- **本物の DB の応答でも確かめる**（e2e/errors.spec.ts。T09a）：手で作ったエラーの object だけだと、T03・T04 で details の形が変わってもテストが通ってしまう。ブラウザを使わず、Node から supabase-js（publishable キーとテストユーザーのログイン）で代表的な RPC の失敗を起こし、その応答を classifyError と messageFor に通して、種類と文言が既定の「入力の形が違います」「この操作はできません」に落ちていないことを確かめる。対象：remove_role の last_admin、update_year の festival_start、update_requests_after_deadline の submittedAt、save_auto_allocations の版の conflict、set_year_status（確定）の E001 の配列、create_year_from の details のない invalid_input、set_consent の details のない invalid_state（団体代表が依頼の前に答える）、署名を壊したトークンでの PGRST301（期限切れの PGRST303 は、E2E で署名の鍵を使わないため lib/errors.test.ts の固定の応答〔PostgREST v16.5 の `401 {"code":"PGRST303","message":"JWT expired"}`〕で確かめる）。details の形が変わればこのテストが落ちる。lib/errors.ts は E2E からも読むので、@/ の別名を使わず相対の import だけにする。

**details の形と文言（上の表に書いていないもの。T03 の migrations の `private.fail` の呼び出しをすべて拾った）**

| message | details | 出る所 | 文言 | 画面の動き |
| --- | --- | --- | --- | --- |
| invalid_state | `{from, to}` | set_year_status の図にない遷移 | 「{from}から{to}には進められません。読み直しました」 | 年度の行を読み直す（ほかの人が先に進めた） |
| invalid_state | `{status:'closed', reason:'memo_only'}` | 終了した年度のルールの更新（guard_rules） | 「終了した年度のルールは、メモだけ直せます」 | 入力を残し、メモ以外の欄を無効にする |
| invalid_state | `{reason:'confirmed'}` | 確定中・終了の振り分けの行（allocations のトリガー） | 「確定中は振り分けを変えられません。確定を解除してから」 | 年度の行を読み直し、読み取り専用にする |
| invalid_state | `{status, group_id}` | 確定中の団体の削除・使用場所や区分の変更 | 「確定中は団体の削除・使用場所・区分の変更はできません」 | 入力を残す |
| invalid_state | `{status, code:'E001'\|'E002', room_id, …}` | 確定中の在庫・使用不可の変更（確定中の守り） | 上の表の「確定中の守り」と同じ。部屋と品目の名前を添える | 入力を残す |
| invalid_state | `{status:'requesting'}` | submit_requests（DB の時計で締切を過ぎた・受付開始の前） | 年度の状態が変わっていなければ（読み直しても requesting のまま）、「締切を過ぎました（または受付の前です）。端末の時計がずれている可能性があります」。状態が変わっていれば上の表の文言 | 年度の行を読み直す。状態が requesting のままなら「DB が受付期間の外と判断した」印を画面に持ち（3.5・3.6） |
| invalid_state | なし | set_consent（団体代表が、依頼の前・未依頼の行に答えた） | 「まだ依頼されていないので回答できません。読み直しました」 | 了承の行を読み直す |
| invalid_input | なし | create_year_from（年度名が空、1日目が複製元の1日目より後でない） | 「年度名を入れ、1日目は今の年度（{複製元の1日目}）より後の日付にしてください」 | 年度名と1日目の欄に出す（画面の zod で先に止めるので、起きるのは複製元の1日目を読み直す前など） |
| invalid_input | なし | set_consent（品目が同じ・ない、備考が 2000 字を超える） | 「入力の形が違います」 | 入力を残す（zod で先に止める） |
| invalid_input | `{field:'festival_start'}` | update_year・create_year_from | 「1日目は、前の年度より後・次の年度より前で、2000年1月1日〜2200年12月31日の日付にしてください」 | 1日目の欄に出す |
| invalid_input | `{field:'request_close_at'}` | update_year（受付中に締切を消した） | 「申請の受付中は締切を空にできません」 | 締切の欄に出す |
| invalid_input | `{field:'label'\|'patch'\|'role'\|'email'\|'note'\|'reason'\|'mode'\|'group_id'\|'groupId'\|'op'\|'changes'\|'rows'\|'submission'}` | 各 RPC | 「入力の形が違います（{欄の日本語名}）」。email は「メールアドレスの形が違います」、reason は「理由は 500 字までです」 | 該当の欄に出す（欄がなければ ErrorBanner） |
| invalid_input | `{field:'submittedAt'}` | 取り込み（update_requests_after_deadline） | 「フォームのタイムスタンプが読めないか、未来の日時です（{団体}）」 | その団体を失敗にして続ける（5.1） |
| invalid_input | `{rows:[…]}`・`{duplicates:[…]}` | save_auto_allocations | 「計算結果の行に誤りがあります（{n}行）。ページを再読み込みしてもう一度実行してください」（allocate の結果を作り替えていなければ起きない。起きたらバグ） | 保存しない。読み直す |
| invalid_input | `{reason:'duplicate_id'}` | save_allocation_rows | 「同じ行への変更が重なっています」（pending.ts が1行1変更にまとめるので起きない。起きたらバグ） | 入力を残す |
| invalid_input | `{column, reason:'immutable'}` | year_id などの付け替え | 「この項目は変えられません（{列}）」 | 入力を残す |
| invalid_input | 送った change そのもの | save_allocation_rows の共通の検査 | 「入力の形が違います（数は 1〜10000、運び元・品目を選んでください）」 | その変更に印をつけ、入力を残す |
| not_found | `{field:'user_id'}` | set_role（アカウントが消えた） | 「この人のアカウントが見つかりません」 | メンバーの表を読み直す |
| conflict | `{item_id}` | update_requests_after_deadline | 「{団体}の{品目}は、ほかの人が先に変えました。読み直しました」 | その団体の行を読み直し、変えたセルの値は残して印をつける |
| conflict | `{id}` | save_allocation_rows | 3.9 の rebasePending | 3.9 |
| conflict | `{allocation_version}` | save_auto_allocations・set_year_status（確定） | 3.9・3.1 の文言 | 3.9・3.1 |
| forbidden | なし | revoke_invitation（見つからないときも） | 「取り消せませんでした。読み直しました」（有無を漏らさない DB に合わせ、「見つからない」とは言わない） | 招待の表を読み直す |

- 文言は lib/errors.ts の `messageFor(kind, ctx)` に置き、details の field・reason の日本語名は lib/labels.ts の表を使う。表にない field・reason は「入力の形が違います」「この操作はできません」にする（新しい RPC が増えても落ちない）。

### 2.6 読み直しの決まり

- 自分の書き込みが成功したら、関係するクエリを invalidate する（在庫の部屋、申請の表、スナップショットなど）。年度の状態の遷移の後は `['year', yearId]` の下を全部と、立場（ヘッダーの状態の表示）を読み直す。
- conflict・not_found：その画面のデータを読み直し、知らせる（toast）。入力中の値は残す。
- state・forbidden：年度の行と立場を読み直し、読み取り専用や権限なしに切り替える。立場の読み直しは裏で行い、画面を外さない（1.3 の AuthProvider。読み直しの間も前の立場で表示し、入力・開いているダイアログ・理由の入力を残す）。
- deadlock：読み直さない。入力を残して「もう一度」（40P01 は何も保存されていない）。
- **通信の失敗の後の書き込み**（応答が届かず、保存されたか分からない）：自動では再送しない。書き込みの種類で (A)・(B1)・(B2) の3つに分ける（D-42 の案）。
  - 「保存できたか分からない」の範囲は、**通信の失敗とタイムアウトだけ**：network（fetch の失敗・中止・status 0）と、コードのない応答のうち status が null・408・5xx のもの（ゲートウェイのタイムアウトなど。PostgREST の応答が届いていない。lib/rpc の unexpected_response もここ）。判定は `isUnknownOutcome(e, status?)`（lib/errors.ts。T09a。どの画面もこれを使う）。
  - DB・PostgREST から**コードつきで返った失敗**（57014 の文のタイムアウト、XX000、PGRST000、知らない P0001 など）は、classifyError の kind が unknown でも**届いた失敗**として扱う（1リクエスト＝1トランザクションなので何も保存されていない）。ふつうの失敗の文言（「予期しないエラーが起きました（コード：…）」）を出し、入力を残す。確かめずに送り直してよい。コードのない 4xx（408 を除く）も PostgREST の前で断られた届いた失敗。
  - **(A) 数を絶対値で書く書き込み**：在庫の upsert（3.3。T10）、申請の submit_requests（3.5）、申請一覧のセル（締切前の直接の更新・insert）、代理入力（submit_requests・update_requests_after_deadline）、締切後の修正（update_requests_after_deadline）、提出済みにする（request_submissions の upsert・`p_submission`）（3.6。T11）。同じ内容を2回送っても結果は同じなので、「分からない」状態を持たず、保存のたびに読み直して決める。
    1. 応答が届かず保存できたか分からないとき（isUnknownOutcome）は、入力をそのまま残し、`unknownOutcomeMessage()`（「保存できたか分かりません。もう一度「保存」を押すと、確かめてから送ります」。申請は verb に「提出」）を出す。保存のボタンはそのまま押せる（送信中だけ押せない。1.4 の送信中の決まり）。押せないボタン・「確かめる」のボタンは作らない。確かめるためだけの状態（未確定の印、送った値の控え、下書きの中の送信の記録、シートを閉じた後の残り物など）は持たない。
    2. 保存は**毎回、送る前に今の DB の行を読み直す**（在庫は部屋の stocks、申請は団体の requests と request_submissions、申請一覧のセルはその行）。読み直した値が入力と同じなら送らずに「保存されていました」で終える（入力の元〔base〕を読み直した行にし、下書きを消す）。ただし、読み直した行のどれも入力の元から変わっていない（updated_at・counted_at・submitted_at と行の有無が同じ）ときは、誰も保存していないので送る（同じ数での数え直し〔F1-5〕・同じ内容での再提出を飛ばさないため）。
    3. 読み直した行に入力の元からの変更があり、その変更が**自分以外の人のもの**なら、ほかの人の保存のダイアログ（「{名前}さんが {時刻} に保存しています」とその値と自分の値を並べ、「上書きする」「読み直す」）を出す。自分以外の判定：在庫は counted_by が自分でない、提出の記録は updated_by が自分でない（どちらも null は自分でないとする）、申請の行（requests は書いた人を持たない）は値が入力の元とも入力とも違う。自分の書いたもの（前に送って応答が届かなかった保存など）は、ほかの人の変更として扱わない。「上書きする」は読み直した行を入力の元にして送る。
    4. それ以外は、入力の元を読み直した行にして送る（updateWithLock・update_requests_after_deadline に渡す updated_at も読み直した行のもの。行がなくなっていれば insert、行ができていれば更新）。読み直しが通信できないとき（isUnknownOutcome）は送らず、入力を残して 1 と同じ知らせを出す。読み直しがほかの理由で失敗したときは 2.5 の表のとおり。
    5. 下書き（1.4）はこれまでどおり入力を守る（画面を離れても戻せる）。下書きを戻した後の保存も 2〜4 で決まる（下書きに送信の記録は入れない）。
    - 判定は `decideAbsoluteSave(entries, equals?)`（lib/data/absolute-save.ts。T09a）：比べるもの（在庫は品目ごと、申請は品目ごと＋提出の記録、申請一覧はセルごと）について `{ input, base, fresh, changed（行の記録が変わったか）, byOther? }` を渡すと 'saved'・'conflict'・'send' を返す。byOther を省くと値で決める（申請の行）。
    - 理由：書き込みが絶対値なので、同じ内容を2回送っても結果は同じ。「分からない」状態を持ち回すと、読み直し・開き直し・下書き・裏の読み直しの組み合わせごとに分岐が増え、レビューのたびに新しい穴が見つかった。
  - **(B1) 送り直しても DB が二重の書き込みを止める書き込み**：楽観ロックの更新（updateWithLock：マスタ〔団体・場所・品目・距離〕・ルール・setRoomUsable の更新）と、一意のキーがある insert（団体〔year_id, name〕・ルール〔year_id, code〕・場所〔name〕・品目〔code〕・距離〔building_a, building_b〕・行のなかった room_years〔year_id, room_id〕）。(A) と同じく、確かめる状態を持たない。
    1. 応答が届かず保存できたか分からないとき（isUnknownOutcome）は、その場で1回だけ対象の行（更新は主キー、insert は一意のキー）を読み直して `settleLockedWrite` で決める。saved（読み直した行の書いた列が入力と同じ）→ 成功と同じに扱う（「保存されていました」と知らせ、閉じて関係するクエリを読み直す）。changed（入力と違い、行の版が入力の元から進んだ・行ができた・なくなった）→ 3 の conflict の扱い。not-saved（行の版が入力の元のまま）・unread（読み直せない）→ 入力を残して `unknownOutcomeMessage()`（「保存できたか分かりません。もう一度「保存」を押すと、確かめてから送ります」）を出す。
    2. 「確かめる」のボタン、押せなくした保存のボタン、未確定の印・送った値の控え・閉じた後の残り物など、確かめるためだけの状態は持たない。保存のボタンは押せるまま（送信中だけ押せない。1.4 の送信中の決まり）。次の保存はふつうに送る（版は今持っている入力の元のもの）。前の送信が後から通っていれば、DB が conflict（updated_at が進んでいる）か 23505 で止めるので、何も上書きされない。
    3. conflict・not_found・23505（classifyError の kind が conflict か not_found。`isLockRejection(e)`）のときは、対象の行（更新は id などの主キー、insert は一意のキー）を読み直して settleLockedWrite で決める。saved → 「保存されていました」（成功と同じ）。changed・not-saved → 今までの conflict の扱い（「ほかの人が変えました」などの今の文言。読み直した行を入力の元にして入力を残す。insert の 23505 は今の「同じ…があります」）。unread → 入力を残し、読み直せなかったことを知らせる（「読み直しました」とは言わない。読み直すボタンを出す）。次の保存はまた同じ道を通る。
    4. 自分の前の送信（値が今の入力と違う）が後から通った場合は、ほかの人の変更に見える。これは受け入れる（上書きするかは利用者が決める。(A) の申請の行と同じ）。
    - 判定は `settleLockedWrite({ reread, matches, baseVersion, versionOf })`（lib/data/locked-save.ts。T09a）：reread は対象の行を1行読む（なければ null）。reread が投げたら 'unread'、行があり matches(row) なら 'saved'、行の版（行がなければ null）が baseVersion と同じなら 'not-saved'、それ以外は 'changed'。baseVersion は入力の元の updated_at（insert は null）。forbidden（lock_unchanged など）は 2.5 の表のとおり（年度の行と立場を読み直す）で、ここには来ない。
    - 理由：送り直しても DB が二重の書き込みを止めるので、確かめてから送り直す必要がない。確かめる状態を持つと、開き直し・閉じる・読み直しの失敗の組み合わせごとに分岐が増え、T09・T12・T13 のレビューで同じ種類の指摘（自分の保存をほかの人の変更と言う、確かめる状態の抜け道）が続いた。
  - **(B2) 送り直すと二重になりうる書き込みと、ほかの RPC**：「分からない」ときは、もう一度押す前に、保存されたかを読み直して確かめる（今までどおり）。
    - save_allocation_rows：3.9 の「保存されたか分からないとき」（版を読み直し、進んでいれば突き合わせる）。insert には冪等の鍵がないので、確かめずに再送すると同じ行が二重にできる。
    - save_auto_allocations・set_year_status（確定）：版を渡しているので、先の送信が通っていれば再送は conflict になる。再送の前に版を読み直し、進んでいれば読み直して知らせる。
    - set_consent：同じ値で何度送っても結果は同じ。読み直してから送る。
    - 読み直しも通信できないときは、入力を残して「保存できたか確かめられません。通信が戻ったら『確かめる』を押してください」と出し、確かめるまで送り直しを押せなくする（save_allocation_rows では未保存の変更を変える操作も押せなくする。3.9。(B2) だけ。(A)・(B1) では使わない）。
- データの多い画面（ダッシュボード、在庫一覧、申請一覧、振り分け、キャスター机交換、履歴）は、PageHeader に「最終読み込み hh:mm」と「読み直す」を出す。
- **版の見張り**（`useVersionWatch`。ダッシュボード・振り分け・キャスター机交換）：年度の行の allocation_version だけを 60 秒ごとと、ウィンドウにフォーカスが戻ったときに読み、持っている版より新しければ StaleBanner（「ほかの人が振り分けの入力を変えました。読み直す」）を出す。自動では読み直さない（編集中の変更を消さないため）。計算中・保存中は止める。

### 2.7 DB の行から YearData・AllocateInput・YearExport へ

`toYearData(snapshot)`（lib/data/year-data.ts。T09a）は `{ data: YearData, problems: InputError[], validatable: boolean }` を返す純粋関数にする（validatable は下の「参照の確かめ」）。

| YearData | DB |
| --- | --- |
| items | `{ id, code, name, requestableCategories: requestable_categories, sortOrder: sort_order }` |
| rooms | `{ id, name, kind, building: 空白だけ・空なら null, floor, extraCost: extra_cost, isStorage: is_storage, usable: room_years の行の usable（行がなければ true）, sortOrder }` |
| groups | `{ id, name, displayName: 空白だけ・空なら null, category, locationRoomId: location_room_id, sortOrder, submittedAt: request_submissions.submitted_at（なければ null。PostgREST の ISO 文字列のまま） }` |
| stocks・requests | 年度の行をそのまま `{ roomId, itemId, count }`・`{ groupId, itemId, count }` |
| rules | enabled のものだけ。`ruleSchema.safeParse({ id, code, kind, params })`。失敗したルールは入れずに problems に「ルール {code} の設定が壊れています（ルール画面で直してください）」を入れる |
| consents | `{ groupId, fromItemId: from_item_id, toItemId: to_item_id, status, count }` |
| distanceOverrides | `{ buildingA: building_a, buildingB: building_b, cost }`。建物が空白だけ・空の行は入れずに problems に「距離の上書き（{建物A}・{建物B}）の建物が空です」 |

- **参照の確かめ（createContext を先に呼ぶ）**：validate（allocator）は、中で contextFor が createContext の inputErrors を受け取ると例外を投げる（T07.md「画面は allocate の後に呼ぶ」）。団体や場所（年度をまたぐ表）を消すと、rules.params の group・room・rooms の uuid は残る（jsonb なので外部キーがない）ので、source_restrict・fixed_request・keep のルールの参照が切れ、ruleSchema の形の確かめだけでは problems が 0 件のまま validate が例外になる（ダッシュボードと振り分けに中身のない「検証できません」だけが出る）。そこで toYearData は、上の表で作った YearData に `createContext({ ...data, mode: 'full', fixedRows: [], previousRows: [] })`（allocator の公開の関数。validate の contextFor と同じ呼び方）を当てる。inputErrors のうち ruleCode のあるもの（参照の切れたルール・ルールどうしの重なりなど）は、そのルールを data.rules から外し、problems に `{ path, message, ruleCode }`（「ルール {code}：{message}（ルール画面で直すか無効にしてください）」）を入れて、もう一度 createContext を当てる（壊れたルールを外せば、ほかの検証は回せる）。ruleCode のないもの（id の重複など）は problems にそのまま入れ、`validatable: false` を返す（useValidation は validate を呼ばず、「検証できません」と problems の一覧を出す）。toYearData の返り値は `{ data, problems, validatable }`。useValidation は念のため validate の例外も捕まえるが、そのときも problems を出す。Vitest：「参照の切れたルール（消した団体を指す keep・場所を指す source_restrict）→ そのルールが data.rules から外れ、problems に ruleCode が入り、validate が例外を投げない」。
- 並べ替えはしない（allocate・validate・exporter が自分で並べる。03）。
- 空文字は null にそろえる（1.6。画面の入力は空を null にして保存するが、SQL・seed・前の版で入った空文字も読めるように）。そろえた後も shared の yearDataSchema に合わない行（名前が空など）は、その行を入れずに problems に「場所 {名前} の {項目} が正しくありません」の形で出す（allocate の invalid_input で止まるより先に、どこが悪いかを示す）。Vitest で、建物・表示名が '' と空白だけの場合を確かめる。
- problems が1件でもあれば、振り分け画面は自動振り分けと**確定**を押せなくし、「入力に誤りがあります」の一覧で出す（allocate に渡して invalid_input にするより先に、どのルールかを示せる。ruleCode のあるものは、admin には /rules?code= へのリンク、ほかの立場にはコードと文だけ。1.1 の canOpen）。壊れたルールは validate にも渡らないので、そのまま確定するとルール違反（E004 など）を確かめずに確定できてしまうため、確定も止める（YearStatusActions の条件。3.1）。ダッシュボードの検証のカードにも problems の件数と一覧を出す。
- 振り分けの行：`toStoredRows(snapshot)` は allocations を `StoredAllocationRow`（id・sourceRoomId・groupId・itemId・requestedItemId・count・isKeep・origin・pinned・note）にし、updated_at は別の Map（id → 文字列）に持つ。
- `buildAllocateInput(snapshot, mode)`（T13）：fixedRows ＝ pinned か origin = manual の行、previousRows ＝ mode が minimal_change のとき origin = auto かつ未固定の行（StoredAllocationRow から AllocationRow の列だけ）、full では []。
- `toYearExport(…)`（T09。書き出し）：exporter の YearExport の形。無効なルールも含め、memo・aliases・is_food・提出の note・了承の note を持つ。ルールの params が壊れていても（ruleSchema に合わなくても）、そのルールを省かず書き出しも止めず、DB の params をそのまま入れる（exporter の exportYearJson は params を検証せずにそのまま書く。型は ExportRule に unknown を通して合わせ、その所にコメントを書く）。書き出した後に「設定の壊れたルール N 件（{コード}）をそのまま書き出しました。ルール画面で直してください」と出す（年度末のバックアップから黙ってルールが欠けることも、壊れたルール1件でバックアップができないこともないように）。

### 2.8 日時

- 表示：`Intl.DateTimeFormat('ja-JP', { timeZone: 'Asia/Tokyo', … })`。端末のタイムゾーンによらない。
- 入力：受付期間は `<input type="datetime-local">` の値を Asia/Tokyo とみなし、`YYYY-MM-DDTHH:mm:00+09:00` にして送る（Asia/Tokyo は夏時間がないので +09:00 で固定してよい）。表示に戻すときも同じ関数。1日目（festival_start）は date のまま。
- 履歴の期間の絞り込みは、日付を Asia/Tokyo の 0 時（`YYYY-MM-DDT00:00:00+09:00`）にして gte・lt で送る。
- テスト（lib/datetime.test.ts）：端末を UTC にしても同じ表示になること、日付の境目。

### 2.9 T03 の最新の変更と画面

T04 は T03 の古い 1ef50c5（今の T03 の 9bddea3 に当たる）の上にあり、その後 T03 に入った変更（c96155d・bd42552・f7b1b01。今の先頭は bd6aef0）をまだ持たない。初版が前提にした 2c0f4d9・1c3a0ce は、T03 の積み直しで c96155d・bd42552 に書き直された（docs の差は 05 のチケット表の「状態」の列だけで、画面に関わる中身は同じ）。T04 を積み直した後の DB を前提に、画面は次のように合わせる。

| T03 の変更 | 画面での扱い | 節 |
| --- | --- | --- |
| remove_role（ロールを外す。終了した年度でも。最後の admin は外せない。ロールがなければ not_found）と、set_role の role 必須 | ユーザーのタブで「ロールを変える」（set_role。closed では出さない）と「外す」（remove_role。closed でも出す）を分ける。last_admin は 2.5 の文言 | 3.2 |
| update_year・create_year_from の1日目の範囲（2000-01-01〜2200-12-31。years の CHECK、invalid_input の festival_start） | date の入力欄の min・max と zod で先に止め、返ってきたら欄に出す | 1.6・2.5・3.2 |
| 本人のメールの判定（private.verified_email・my_verified_email。invite・accept_my_invitations・invitations_select） | invite の applied が false でも「アカウントがない」とは言わない。自分あての招待は画面で読まない（T04 の accept_my_invitations の件数だけ）。E2E は createUser で確かめたユーザーと確かめていないユーザーを作る | 3.2・7.2 |
| ローカルの Confirm email を有効にした（enable_confirmations = true。bd42552） | E2E で画面からのサインアップ・メールの変更を使わない | 7.2 |
| Google の identity は identity_data の email_verified が真のときだけ信じる。本番の Auth で必ず守る設定（Google だけでログイン〔Email・Phone・匿名は無効〕、Confirm email と Secure email change は有効、Allow manual linking は無効。D-17a。f7b1b01） | invite の applied が false になる場合に「Google の email_verified が偽」も加わるが、文言は今のまま（「この人が学校の Google アカウントでログインしたときに付きます」。アカウントがないとは言わない）。createUser は email の identity（email_verified: true）で作るので変わらない。本番の設定は、T04 を積み直すときに README の「必ず守る設定」（7）に Allow manual linking を足す（notes/T03.md の申し送り）。T14 は README の運用の節からそこへリンクし、7月の再開の手順に「Auth の設定が変わっていないことを確かめる」を入れる | 3.2・7.2・8.2（T14） |
| 距離の値の範囲（rooms.extra_cost・distance_overrides.cost は 0〜20。CHECK） | 入力欄の min・max と shared の MAX_DISTANCE_COST。直接の書き込みで 23514 が返ったら「入力が範囲を超えています」 | 2.5・3.2 |
| 取り込みの submittedAt（update_requests_after_deadline の p_submission。オフセットつきの ISO、未来は不可、admin だけ） | 取り込みは締切の前後によらずこの RPC で送り、フォームのタイムスタンプを渡す。未来・形の誤りは invalid_input の submittedAt | 5.1 |
| update_requests_after_deadline・save_allocation_rows の楽観ロックは updated_at をミリ秒に切って比べる | 受け取った文字列をそのまま返す（2.3 のとおり。切らなくてよい） | 2.3 |

## 3. 画面ごとの仕様

各画面に共通：読み込み中は LoadingState（表は Skeleton）、権限なしは ForbiddenState（RequireAudience）、読み込みの失敗は ErrorState（2.5 の文言と「もう一度読み込む」）、データが空のときは EmptyState に「次に何をするか」とリンクを添える。年度の状態で書けないときは ReadOnlyNotice（「年度が確定中のため編集できません」など）を出し、入力欄を無効にする。

### 3.1 ホーム・ダッシュボード /（T09）

**admin・staff：ダッシュボード（PC）**

- 表示（カードを並べる）：
  - 年度の状態（YearStatusBadge）、受付期間（開始・締切。Asia/Tokyo）、最後に自動振り分けを保存した日時（auto_allocated_at）。
  - 申請：提出した団体の数／団体の数（区分ごとの内訳も）。未提出の団体の名前（5件まで、続きは /requests?filter=unsubmitted へ）。
  - 在庫：在庫を数えた保管場所の数／保管場所の数（使用不可の部屋を除く。数えた＝その年度の stocks の行が1つ以上ある）。まだ数えていない場所（W104 と同じ。5件まで、/stock?room=… へのリンク）。
  - 検証：年度が allocating・confirmed のとき、validate の error・warning・info の件数と、多いコードの上位（「E003 2件」など）。/allocation へのリンク。preparing・requesting のときは「振り分け前（検証は振り分け中から）」と出す（行がないと E003 がすべての申請に出て意味がないため）。
  - キャスター机交換の了承状況：了承が要る代替（needsConsent のルール）の置き換えがある団体の数を、未依頼・依頼済み・了承・拒否と「依頼し直しが要る」（依頼した台数・了承した台数より今の台数が多い。W102）、「拒否したので最小変更での再実行が要る」（拒否で置き換えが残っている）に分けて出す。admin には /swaps へのリンク（AppLink）。staff は /swaps を開けないので、件数だけを出す（1.1 の canOpen）。
  - 入力の誤り：toYearData の problems（壊れたルール・参照の切れたルール・空の建物など。2.7）が1件でもあれば、検証のカードの上に件数と一覧を出す（ruleCode のあるものはルールのコードを添え、admin には /rules?code= へのリンク、ほかはマスタ設定へのリンク）。validatable が偽のときは、検証のカードに件数の代わりに「検証できません（入力の誤りを直してください）」を出す。
  - **立場の一覧**（ダッシュボードとホームの両方）：T04 のホームと同じ「あなたの立場」の要素を残す。`data-testid="home-roles"` の `<ul>`（開いている年度のロールの日本語名と「{団体名} の団体代表」を1行ずつ。ほかの文字を入れない）と、`data-testid="home-year"`（「R8（申請受付中）」）。T04 の e2e/auth.spec.ts が home-roles の文字を `toHaveText` で確かめていて、auth.spec は T09a が持ち T09 は触らない（8.2）ので、T09 がこのページを置き換えても同じ testid と同じ文字を保つ。ダッシュボードでは上の端に小さく置いてよい（見た目は変えてよいが、testid の要素の文字は変えない）。
- 年度の状態を進める（admin だけ。YearStatusActions。staff には出さない）：

| 今の状態 | ボタン | 前提・確認 | 理由 |
| --- | --- | --- | --- |
| preparing | 受付開始 | 締切が未来で入っていること。入っていなければボタンを無効にし、「先に受付期間を入れてください」と /settings?tab=years へのリンク | 任意 |
| requesting | 締切（振り分けを始める） | 締切前なら「締切の前ですが、団体代表は申請を変えられなくなります」と確かめる | 任意 |
| allocating | 確定 | 下の「確定の流れ」 | 必須 |
| confirmed | 確定を解除 | 「団体への公開も止まります」と確かめる | 必須 |
| confirmed | 終了 | 「終了すると読み取り専用になり、戻せません。先に年度データと振り分け表を書き出してください」と書き出しのボタンを並べる | 任意 |
| closed | なし | — | — |

- **確定の流れ**（ダッシュボードと振り分け画面で同じ部品。D-18）：
  1. 画面を開いたとき、スナップショット（版 v を先に読む）を読み、toYearData → validate を v で回す（useValidation）。
  2. 「確定」は、状態が allocating・error が0件・入力の problems が0件・検証した版が v・振り分け画面に未保存の変更がない、のときだけ押せる。押せないときは理由を出す（「error が2件あります」「ルール S05 の設定が壊れています」）。StaleBanner が出ているときも押せなくし、先に読み直してもらう。DB の確定の検査（confirm_issues）は E001・E002・E005 だけでルール違反を見ないので、壊れたルールのまま確定させないのは画面の役目。
  3. ダイアログで理由（必須、500 字まで）を入れる。warning があれば件数と上位を出し、「warning を確認しました」のチェックを入れてから押せる。
  4. `set_year_status(p_year_id, 'confirmed', p_reason, p_base_version = v)`。
  5. 成功：toast「確定しました」、年度の下のクエリと立場を読み直す。
  6. conflict：ダイアログを閉じ、スナップショットを読み直して検証し直し、結果を出してから「確定の前に入力が変わったので、検証をやり直しました。結果を確かめてから、もう一度『確定』を押してください」と出す（自動で再送しない）。
  7. E001・E002・E005：details の一覧を名前にして出し、読み直す。reason_required：理由の欄に出す。
- 状態：読み込み中（カードごとに Skeleton）、年度がない（AppShell が未招待を出すので来ない）。
- 端末：PC。スマホではカードを縦に並べるだけ（ボタンも使える）。

**rep・viewer：ホーム（スマホ・PC）**

- rep：自分の団体ごとのカード（団体名、申請の状況「提出済み（10/5 18:01）」「未提出」、締切、/request へのボタン。了承の依頼があれば「キャスター机への交換の依頼があります」と /my へのボタン。確定後は「振り分けが決まりました」と /my へのボタン）。
- viewer：確定・終了なら「振り分け表を見る」（/allocation。Q1）。それ以外は「振り分けが確定すると、ここから見られます」。
- 兼ねている人（staff と rep など）：ダッシュボードの上に rep のカードを出す。
- rep・viewer のホームにも、上の「立場の一覧」（home-roles・home-year）を出す（T04 の auth.spec が団体代表・閲覧のみで確かめている）。

### 3.2 マスタ設定 /settings（T09）

admin だけ（RequireAudience）。タブ（`?tab=years|rooms|items|groups|distance|users|export`、既定は years）。closed の年度では、ユーザーの「外す」・招待の取り消し・新しい年度の作成（create_year_from。複製元が終了していてもよい。年度末に R8 を終了してから翌年 R9 を作る普通の流れのため）以外はすべて読み取り専用。削除はすべて deleteChecked（2.3）で行い、0 行なら「削除しました」と出さない。任意の文字列（建物・表示名・備考・メモ・使用不可の理由）は空なら null にして保存する（1.6）。団体・場所・品目・距離・今年の使用の更新（updateWithLock・setRoomUsable）と追加（insert）で、応答が届かなかったとき・conflict・not_found・23505 のときは 2.6 の (B1)（settleLockedWrite で決める。「確かめる」のボタンや押せなくした保存のボタンは作らない）。

**年度（years）**

- 今の年度：年度名・1日目・受付開始・締切・状態。編集は update_year（変えたキーだけを patch に入れる。理由は任意）。受付開始 < 締切を画面で確かめ、requesting の間は締切を空にできない（入力欄を必須にする）。1日目は `<input type="date" min="2000-01-01" max="2200-12-31">` と lib/schemas/common.ts の zod で範囲を先に確かめる（years の CHECK と同じ。D-18）。「前年度より後、次の年度より前」は画面では確かめきれない（次の年度を読めないことがある）ので、invalid_input（field: festival_start）が返ったら 2.5 の文言を1日目の欄に出す。closed の年度は update_year が受け付けないので、欄をすべて読み取り専用にする。
- 新しい年度を作る：開いている年度が自分の見える年度の中で最新で、自分がその年度の admin のときだけ出す（年度の状態は問わない。closed も含む）。年度名（前後の空白を除いて1〜50 字）と1日目（開いている年度の festival_start より後で、2000-01-01〜2200-12-31）を入れて create_year_from（複製元は開いている年度に固定。p_festival_start は date 型の引数なので、形の違う値は PostgREST が 22007・22008 で返す）。年度名が空でないこと・1日目が複製元の1日目より後であること・範囲は、画面が持っている複製元の1日目を使って zod で先に確かめる（create_year_from は前の2つを details のない invalid_input で返すので、返ってきたら年度名と1日目の欄に 2.5 の文言を出す。範囲外は invalid_input の festival_start）。複製されるもの（団体・ルール・使用不可の設定）とされないもの（在庫・申請・振り分け・了承・ほかの人のロール・招待）を画面に書く。付け替えられなかったルールは無効になり memo に理由が入るので、作った後に「無効になったルール N 件」を出して /rules へのリンクを出す。成功したら立場を読み直し、新しい年度に切り替える（1.3.1）。作った後のルールの読み込み（数え直し）だけが失敗したときも、年度は作れているので同じように扱い（フォームを空にして切り替える）、件数の代わりに「無効になったルールの数を確かめられませんでした。ルール画面で確かめてください」を出す（押し直すと同じ年度名の conflict になるため、失敗とは言わない）。not_latest の invalid_state は「最新の年度からだけ作れます」。

**場所（rooms）**

- 表（DataTable）：名前・別名・種類・建物・階・保管場所か・追加コスト（0〜20）・並び順・今年の使用（使用可／使用不可と、使用不可の理由のメモ）。行の追加・編集（シート）・削除。
- rooms は年度をまたぐ表（開いている年度のどれかの admin が書ける。D-01）。編集のボタンは `adminOfOpenYear` で出す。「場所の変更はすべての年度に効きます」と書く。
- 今年の使用（room_years）は年度ごと。保存は `setRoomUsable`（2.3。読み込んだときの updated_at を渡し、upsert で黙って上書きしない）。確定中に、振り分けのある部屋を使用不可にすると invalid_state（確定中の守り）になる。振り分け中に使用不可にするときは、その部屋からの固定・手動の行があれば、ここでは押せなくして振り分け画面の部屋の見出しへ案内する（3.9 の「使用不可にする順番」。使用不可にした後では、その行の固定を外す保存が E002 で拒否されるため）。
- 削除は、在庫・振り分け・団体の使用場所・どれかの年度の今年の使用（room_years）から使われていると 23503 になる（「使われている場所は削除できません」）。**ルールからの参照**：ルールの params（source_restrict の rooms、keep の room）は jsonb で外部キーがなく、場所を消しても参照が残って、そのルールが参照の切れたルールになる（2.7）。場所は全年度で共有なので、削除の確認のダイアログは開くたびに years と自分の year_roles を読み直し、**終了していない年度のうちルールを読める年度（admin・staff。rules の RLS）すべて**のルールを1回で読む（T09 の lib/data/settings.ts の fetchOpenYearRules・openYearsForRoomRefs・roomRefsAcrossYears。表示中の年度だけでは足りない）。どれかの年度に、その場所を参照する**有効な**ルールがあれば「削除する」を押せなくし、コードと内容の文を出して「先にルール画面でこのルールを無効にするか、参照を直してください」と添える（表示中の年度のルールは /rules?code= へのリンク、ほかの年度はコードと年度名だけで「その年度を開いて直してください」）。無効のルールの参照は削除を止めず、「無効のルール N 件の参照が切れます（有効にする前に直してください）」と添える。**ルールを読めない終了していない年度（団体代表・閲覧のみの年度）があるとき、またはルールの読み込みに失敗した・読み直している間は、消せない**（年度名を出し、「削除は、終了していないすべての年度のルールを読める管理者が行ってください」）。終了した年度のルールは見ない（参照が切れても振り分けに使わない）。参照が切れたら、その年度のダッシュボードと振り分け画面の「入力の誤り」に出る（2.7）。
  - **DB での強制は申し送り**（今は画面の確かめだけ）：ロールのない終了していない年度（years を読めないので画面に出てこない）のルールは画面から見えず、確かめと削除の間にほかの人がルールを足すこともある。rules.params の room・rooms は jsonb で外部キーがないので、DB で守るなら rooms の before delete のトリガー（SECURITY DEFINER）で「終了していない年度の有効なルールの params.room・params.rooms がその場所を指していれば invalid_state（details に年度とルールのコード）」にする（groups の削除の params.group・groups も同じ。団体は年度ごとなので同じ年度だけ）。DB のチケットで決める（notes/T09.md の「DB への申し送り」）。
- 開いている年度の admin でなくなった（年度がすべて終了した）ときは 0 行で返るので、deleteChecked で forbidden として扱う。
- 建物は空欄なら null（1.6）。建物が null の部屋は、距離の表（03）で「別の建物」として扱われる（屋外は種類で決まる）ので、建物の中の部屋は建物を入れるよう入力欄に書く。

**品目（items）**

- 表：コード（作った後は変えられない。ルールがコードで参照するため）・表示名・フォームでの表記（別名）・申請できる区分（区分ごとのチェック）・並び順。追加と編集。削除は出さない（使われていれば消せず、フェーズ1で消す用途がない）。
- 「品目の変更はすべての年度と、Excel の様式・振り分け画面のタブに効きます」と書く。

**団体（groups）**

- 表：団体名・表示名（企画名）・別名・区分・飲食か・使用場所（場所を選ぶ。校内に分散なら空）・並び順・代表者の数。追加・編集・削除。
- 保存の前に groupNameSchema と、年度の全団体（編集後）に checkGroupNames を当て、入力欄の下に出す（Excel の SUMIF に使えない名前を止める。D-27）。表示名は空欄なら null（1.6）。
- 削除は「申請・振り分け・団体代表・招待も消えます」と確かめる。その団体を参照する有効なルール（source_restrict・fixed_request・keep の params.group。`rulesReferencing(rules, { groupId })`）があれば、確認のダイアログにそのコードと内容の文を出し、「先にルール画面でこのルールを無効にしてください」と /rules?code= へのリンクを出して、削除のボタンを押せなくする（消すと jsonb の参照だけが残り、validate が例外になるため。2.7）。無効のルールの参照は削除を止めず、件数を添える。確定中の削除と使用場所・区分の変更は invalid_state（確定中の守り）。ほかの admin が年度を終了した後・ロールを外された後の削除は 0 行で返る（RLS とトリガー tg_groups_before_write はエラーにしない）ので、deleteChecked で forbidden として年度の行と立場を読み直す。
- CSV 取り込み（「団体を CSV で取り込む」）：見出しは `団体名,表示名,区分,飲食,使用場所,別名,並び順`。区分は「模擬店・部門・企業・休憩所」、飲食は「はい・いいえ」、使用場所は場所の名前か別名（空は校内に分散）、別名は「|」区切り、並び順は整数（空なら行の順×10）。importer の `parseCsvLoose` で読み、行ごとに zod で確かめ、プレビュー（追加・変更・変わらない・エラーの件数と行）を出してから、`(year_id, name)` での upsert 1回で保存する（全部か何もしないか）。削除はしない。文字コードは 5.1 と同じ。

**距離（distance）**

- 建物どうしの距離の上書きの表（建物A・建物B・コスト 0〜20）。建物は rooms の building の一覧から選ぶ（自由入力もできる。前後の空白を除いて1字以上）。DB が建物の組の向きをそろえるので、画面は並べ替えない（D-15）。同じ組は 23505（「その組はすでにあります」）、同じ建物どうしは 23514。
- 場所ごとの追加コストは場所のタブで直す（ここでは一覧だけ出し、場所のタブへのリンク）。
- 「距離を変えると、次の自動振り分けから効きます」と書く。

**ユーザー（users）**

- メンバーの表：表示名（profiles。読めなければ「名前を表示できません」）・ロール・代表する団体。ロールの変更（set_role。closed では出さない）、ロールを外す（remove_role。closed でも出す。最後の admin は invalid_state の last_admin）、団体代表を外す（remove_group_member。closed でも出す）。理由は任意。
- 招待の表：メール・ロールか団体・状態（未使用／使用済み）。未使用の招待の取り消し（revoke_invitation。closed でも出す）。
- 招待する：メール（前後の空白を除き小文字にして送る。254 字まで。形が違えば invalid_input の email）・立場（総務管理者・総務部員・閲覧のみ・団体代表）・団体（団体代表のとき）。invite の返り値 applied で文言を分ける：true は「この人はすでにアカウントがあるので、その場でロールを付けました」、false は「招待しました。この人が学校の Google アカウントでログインしたときに付きます」。false は、まだアカウントがないときのほか、アカウントはあるが今のメールを本人のものと確かめられないとき（DB の `private.verified_email`。メールの変更の途中、Google の identity の email_verified が偽など。D-17a）にも返るので、「アカウントがありません」とは言わない。conflict（field: role）は「すでに別のロールがあります」。closed では招待を出さない。
- メールは admin の画面にしか出さず、ログ・toast の文言に入れない。

**書き出し（export）**

- 「年度データ（JSON）」：年度の全データを読み（無効なルール・memo・別名・飲食か・提出の note・了承の note・振り分けの id・origin・pinned を含む）、toYearExport → `exportYearJson` → `{年度}_年度データ.json` を保存。メールアドレスは含めない（exporter が伏せる）。
- 「振り分け表（Excel）」：振り分け画面の出力（3.9）と同じ関数を呼ぶ。
- 「年度末のバックアップに使う。総務の共有ドライブに保存する」と書く（README の手順へのリンク）。

### 3.3 在庫入力 /stock?room=…（T10）

admin・staff。スマホ（390px）で使う。

- **room がないとき（場所を選ぶ）**：保管場所（is_storage）の一覧を並び順で。建物ごとに見出し、名前で絞る入力欄、各行に「数えた（10/5 18:01・山田）」か「まだ」、使用不可の印。行を押すと `/stock?room=<id>`。部屋に貼った QR を読んでも同じ URL に来る。保管場所がなければ EmptyState（admin には「マスタ設定の場所で『保管場所』にしてください」とリンク）。
- **room があるとき（入力）**：
  - 表示：場所名、使用不可なら先頭に「今年は使用不可」（その理由のメモも）、前回入力した人と日時（その部屋の stocks の counted_at が最も新しい行の counted_by の表示名と日時。読めなければ「名前を表示できません」）、品目ごとの行（品目名、CountStepper、前年の数）。前年の数は previous_year_stocks（年度ごとに1回読み、部屋で絞る）。前年度がなければ列を出さない。
  - 操作：＋－と数字の入力、「保存」（画面の下に固定）。保存は部屋の全品目（0 を含む）を1回の upsert（`onConflict: year_id,room_id,item_id`、送るのは year_id・room_id・item_id・count だけ）。全品目を書くので、同じ数でも「数え直した」記録（counted_by・counted_at）が残る（F1-5）。
  - ほかの人の保存と通信の失敗：2.6 の (A)。保存のたびに、送る前にその部屋の stocks を読み直す。全品目が入力と同じで、入力の元（読み込んだとき）から行が変わっていれば送らずに「保存されていました」。入力の元から変わった行の counted_by が自分でなければ、「{名前}さんが {時刻} に保存しています」とその数と自分の数を並べ、「上書きする」「読み直す」を選んでもらう。それ以外は読み直した行を入力の元にして送る（どの行も変わっていなければ、同じ数でも送って数え直しの記録を残す）。応答が届かなければ入力を残して「保存できたか分かりません。もう一度「保存」を押すと、確かめてから送ります」。
  - 保存の後：toast「保存しました」と、「次の部屋へ」（並び順で次の、まだ数えていない保管場所）。
  - 入力の途中で離れるときは UnsavedChangesGuard。入力は部屋ごとの下書き（1.4）に置き、カメラで次の QR を読んだ・別のアプリへ行った・タブが捨てられた後に開き直しても「保存していない入力があります（hh:mm）［戻す］［捨てる］」で戻せる。
  - **開いている年度が最新でないとき**（1.3.1）：画面の上部に「最新の年度（R9）に切り替える」を大きく出し、保存の前に「最新でない年度（R8・確定中）に保存します」と確かめる。部屋の QR から開けば最新の年度になる（年度の選択はタブごと）。
  - room の id が保管場所の一覧にない（別の年度・消した部屋・形が違う）ときは「この場所は見つかりません」と一覧へのリンク。
- **状態**：

| 年度 | staff | admin |
| --- | --- | --- |
| preparing・requesting | 入力できる | 入力できる |
| allocating | 読み取り専用（「振り分けが始まったので、在庫は総務管理者だけが直せます」） | 入力できる。保存の前に、振り分けの合計（v_remaining の allocated）より少なくなる品目があれば「振り分けの合計（n台）より少なくなります。保存すると振り分けに在庫超過（E001）が出ます。振り分け画面で直してください」と確かめる |
| confirmed | 読み取り専用 | 入力できるが、振り分けの合計より少なくなる品目があれば保存できない（「確定中は振り分けの合計より少なくできません。確定を解除してから」。DB の守りと同じ条件を先に確かめる） |
| closed | 読み取り専用 | 読み取り専用 |

  - 使用不可の部屋も数えられる（入力欄はそのまま）。
- 端末：スマホを基本にする（ボタンは 44px 以上、`inputMode="numeric"`）。PC でも同じ画面。

### 3.4 在庫一覧 /stocks と QR /stocks/qr（T10）

admin・staff。PC。

- 表（保管場所 × 品目）：各セルに今年の数と前年との差（「12（+2）」。前年度の数は previous_year_stocks）、行と列の合計。使用不可の部屋は灰色にして「使用不可」の印（合計の行は「使用不可を除く」と「全部」の2つ）。部屋の名前は /stock?room=… へのリンク。
- まだ数えていない場所（W104 と同じ。保管場所のうち今年の stocks の行がない場所、使用不可を除く）を表の上に一覧で出す。
- 「QR を印刷」：/stocks/qr へ。
- **/stocks/qr**：保管場所を選ぶ（既定は全部。`?rooms=<id>,<id>` で絞れる）→ 印刷用のカード（A4 に 2列×4段。場所名を大きく、建物・階、QR、URL の文字、「在庫入力（電波祭 総務）」、「スマホのカメラで読み、Safari か Chrome で開いてください（LINE などのアプリの中で開くと Google でログインできません）」）。「印刷」で `window.print()`。印刷のときは AppShell のヘッダーとナビを隠す。
- QR の URL は `${location.origin}${BASE_PATH}/stock/?room=<room_id>`（末尾のスラッシュを付け、リダイレクトを挟まない）。URL を作る関数は lib/data/stocks.ts に置き、basePath ありとなしでテストする。QR は uqr の renderSVG（文字列を作る。部屋の id は秘密ではなく、開くにはログインが要る）。
- 状態：保管場所がない（EmptyState）、在庫が1件もない（表は出し、すべて「まだ」）。

### 3.5 申請 /request（T11）

rep。スマホ。

- 団体：自分が代表する団体が2つ以上なら、上で切り替える（`?group=<id>`。membership の団体にない id は無視して最初の団体）。
- 表示：団体名、使用場所の名前（なければ「校内に分散」）、締切日時（Asia/Tokyo。残りの日数）、その団体の区分で申請できる品目だけの入力欄（items.requestable_categories に区分がある品目。初期値は今の申請の数、なければ 0。企業以外には長机(3人掛)が出ない）、備考（「数には影響しません」と書く。2000 字まで）、提出の状況（「提出済み（10/5 18:01）」「未提出」）。
- **出していない品目に DB の行があるとき**：区分で申請できない品目でも、DB に 0 でない行があれば（企業以外の長机(3人掛)は D-05 で許され、取り込みや前の版・総務の入力で残りうる。合成データの模擬店06 は 2）、入力欄の下に読み取り専用の行として出す（「長机(3人掛) 2台（長机(2人掛)として扱います。変えるときは総務へ）」。長机(3人掛)以外は「{品目} {n}台（この区分では申請できない品目です。総務へ）」）。submit_requests は送った品目しか書かないので、団体代表には直せないまま需要に残ることを隠さない。読み替えた先の品目の初期値には足さない（足すと、提出のたびに数が二重になる）。
- 操作：「提出」→ 確認のダイアログ（0 でない品目の一覧。全部 0 なら「すべて 0 です。何も借りない申請として提出しますか」）→ `submit_requests(p_group_id, p_rows = 表示した入力欄の品目すべての { itemId, count }, p_note)`。数は 0〜10000 の整数（zod）。提出のたびに、送る前にその団体の requests と request_submissions を読み直す（2.6 の (A)）：すべての品目と提出の記録が入力と同じで、入力の元から変わっていれば送らずに「提出されていました」。提出の記録の updated_by が自分でない変更か、申請の行の値が入力の元とも入力とも違う変更があれば、「{時刻} にほかの代表者（または総務）が変えています。上書きしますか」と確かめる。応答が届かなければ入力を残して `unknownOutcomeMessage('提出')`。成功したら「提出しました（日時）」。締切前なら何度でも直して再提出できる（「修正して再提出」）。送信中はボタンを押せなくする。
- 入力は団体ごとの下書き（1.4）に置き、UnsavedChangesGuard を付ける（団体代表がスマホで別のアプリへ行っても戻せる）。開いている年度が最新でないときは、在庫入力と同じく切り替えのボタンと提出の前の確認を出す（1.3.1）。
- 状態：

| 条件 | 表示 |
| --- | --- |
| requesting・受付開始前（request_open_at が未来） | 「受付は {日時} からです」。入力欄は無効 |
| requesting・受付期間内 | 入力できる |
| requesting・締切後、allocating 以降 | 読み取り専用。「締切を過ぎました。変更は総務へ」 |
| preparing | 「受付の前です」。入力欄は無効 |
| 提出が invalid_state で失敗 | 年度の行を読み直す。状態が変わっていれば上の表示に切り替える。状態が requesting のまま（端末の時計がずれていて、DB は受付期間の外と判断した）なら、「DB が受付期間の外と判断した」印をその画面の状態に持ち、その間は読み取り専用にして「締切を過ぎました（または受付の前です）。端末の時計がずれている可能性があります。変更は総務へ」と出す（年度の行を読み直しても表示が変わらず、同じ失敗を繰り返さないため）。印は年度の行を読み直して状態が変わったとき・画面を開き直したときに消す |

- 申請できない品目（E006）はこの画面では入力欄に出さない（DB のトリガーでも止まる）。
- 端末：スマホ（品目ごとに CountStepper を縦に並べ、「提出」を下に固定）。

### 3.6 申請一覧 /requests（T11）

admin（読み書き）・staff（読み取り）。PC。

- 表示：団体 × 品目の表（行は団体の並び順、列は品目の並び順）。区分の絞り込み（`?category=`）、「未提出だけ」「備考ありだけ」（`?filter=unsubmitted|noted`）。その団体の区分で申請できない品目のセルは「—」。ただし DB に 0 でない行があれば、その数を灰色で出して印をつける（企業以外の長机(3人掛)は「長机(2人掛)として扱う」、ほかは「申請できない品目（E006）」。管理者はそのセルを 0 にできる）。提出の列（提出日時か「未提出」）、備考がある団体に印（押すと備考を出す）。品目ごとの合計の行。未提出の団体の一覧（表の上。件数と名前）。
- 締切の表示：「締切 10/5 23:59（あと3日）」か「締切後（変更には理由が要ります）」。
- **セルの直接の編集**（admin）：セルを押して数を入れると「未保存の変更」になる（印をつける）。「保存（N件）」で送る。
  - 締切前（preparing、requesting で締切前）：セルごとに直接の更新（行があれば updateWithLock、なければ insert）。セルごとの成否を出す（conflict のセルは読み直した値に戻して印をつける）。forbidden（RLS で 0 行。年度を読み直しても requesting のまま）なら、DB が締切後と判断した（端末の時計のずれ）として「DB が締切後と判断した」印を持ち、画面を締切後の書き方（理由と update_requests_after_deadline）に切り替えて、未保存のセルはそのまま残す（同じ直接の更新を繰り返さない。3.5 と同じ印）。
  - 締切後（requesting で締切後、allocating）：理由のダイアログ（必須）→ 団体ごとに `update_requests_after_deadline(p_group_id, p_rows = 変えたセルの { itemId, count, updatedAt（行があるとき） }, p_reason)`。conflict の団体は読み直す。
  - confirmed・closed：読み取り専用（「確定を解除してから」）。
- **代理入力**（企業・休憩所など。admin）：団体の行の「代理入力」→ シート（/request と同じ入力の部品）。休憩所で今年の申請がまだないときは「前年の数を入れる」（previous_year_requests を団体名で引く）。
  - 締切前：「提出」は submit_requests（申請と提出を1回で）。
  - 締切後：update_requests_after_deadline に `p_submission: { submitted: true, note }` を付ける（理由は必須）。
- **提出済みにする**（admin）：締切前は request_submissions を直接 upsert（`{ group_id, submitted_at: 今の時刻の ISO }`。トリガーは送られた submitted_at が null でないときだけ now() に置き換えるので、値を送らないと提出済みにならない。送った値は使われない。note は送らず今の備考を残す。2.3 の例外）、締切後は update_requests_after_deadline の `p_submission: { submitted: true }`（rows は空の配列）。未提出に戻す操作は出さない（D-19）。
- **通信の失敗と、ほかの人の変更**：セルの保存・代理入力・締切後の修正・提出済みにするは、どれも 2.6 の (A)。送る前に団体の行（requests・request_submissions）を読み直し、セルは「値が入力の元とも入力とも違う」、提出の記録は「updated_by が自分でない」をほかの人の変更とする。送るときは読み直した行の updated_at を使う（行ができていれば insert ではなく更新、消えていれば insert）。応答が届かなかったセル・団体は入力（未保存の印）を残して「保存できたか分かりません。もう一度「保存」を押すと、確かめてから送ります」と出す（「送っていない」「保存できなかった」のセルとは文言を分ける）。
- 編集したセルは下書き（1.4）に置き、UnsavedChangesGuard を付ける。
- 「Googleフォームの回答を取り込む」（admin。confirmed・closed では出さない）：5 章のダイアログ。
- 状態：団体がない（EmptyState とマスタ設定へのリンク）、申請が1件もない（表は出す）。
- 端末：PC（表は横にスクロール、団体名の列を固定）。

### 3.7 CSV 取り込み

5 章に書く（申請一覧から開くダイアログ。団体の CSV は 3.2）。

### 3.8 ルール /rules（T12）

admin。PC。

- 一覧：コード・種別（代替・運び元の制限・固定の申請・残す）・内容の文（`describeRule(rule, 名前の表)`。例「設営の机(木)は 1-1・1-2・1-3・2-1・2-2・2-3 からだけ出す」）・有効（Switch）・メモ。`?code=S05` でその行を開いて目立たせる（振り分け画面の原因のリンクから来る）。
- 追加・編集（シート。種別ごとのフォーム）：
  - 代替：元の品目・先の品目（品目を選ぶ）・区分（チェック）・重さ（0〜10）・屋内だけ・了承が要る・優先する区分（選んだ区分の中から）。
  - 運び元の制限：団体（選ぶ）・申請品目（複数）・場所（保管場所から複数）。
  - 固定の申請：団体・品目（その団体の区分で申請できる品目だけ）・数（1〜10000）。
  - 残す：団体・場所（既定は団体の使用場所。使用場所でなければ E005 として止める）・品目と数（複数）。
  - 団体・場所は名前で選び id で保存、品目はコードで保存（03）。
- 保存の前：`ruleRowSchema` で形を、`checkRuleRefs(draft, { items, rooms, groups, rules: 自分以外の有効なルール })` で参照と重なりを確かめ、エラーを path で入力欄の下に出す。コードの重複は 23505（「同じコードのルールがあります」）。保存は rules を直接（insert・updateWithLock）。応答が届かなかったとき・conflict・not_found・23505 のときは 2.6 の (B1)（シートの保存も、一覧の有効・無効の切り替えも。insert は (year_id, code)、更新は id で読み直す）。
- 有効にするとき：同じく checkRuleRefs で重なりを確かめてから更新する。
- 一覧を開いたとき、有効なルールに checkRuleRefs（自分以外の有効なルールと、今の団体・場所・品目）を当て、参照の切れたもの（団体や場所を消した後など。2.7）に「参照が切れています（{団体／場所}が見つかりません）」の印を出す（ダッシュボード・振り分け画面の「入力の誤り」から `?code=` で来たときに、どこを直すかが分かるように）。
- **削除は出さない**（04・00 の「ルールの追加・有効化・メモ」に削除はない）。使わなくなったルールは無効にし、理由をメモに書く。無効のルールも年度をまたいで引き継がれる（F1-8。create_year_from が無効のまま複製する）ので、消すと次の年度に残らない。
- ひな形（S01〜S04・S07 は品目と区分だけなので1回で入る。S05・S06・S08 は団体・場所を選んでもらう）：「R8 の初期ルールから追加」で、まだないコードだけを開いたフォームに入れる。
- allocating の間は「ルールを変えると、振り分け画面で再実行が要ります」と出す（版が上がる）。
- **confirmed（確定中）はメモだけ編集できる**（「確定を解除してから変えてください」の帯）。DB の RLS は確定中も追加・更新・削除を許し、版も allocating のときしか上がらないので、確定中にルールを変えると、公開中の振り分けに E004 などの error が黙って生じる。画面でこれを止める。closed もメモだけ（DB のトリガー guard_rules と同じ）。
- 状態：ルールがない（EmptyState と「R8 の初期ルールから追加」）。

### 3.9 振り分け /allocation（T13。中心の画面）

admin は読み書き（振り分け中）。staff・viewer は Q1 の推奨で読み取り。PC。

**読み込み**：スナップショット（版を先に読む。2.2）→ toYearData・toStoredRows・useValidation。viewer は part = public で、行と名前だけを出す（在庫・余り・検証・団体別の申請数は出さない）。

**上部**：「自動振り分け」「最小変更で再実行」「確定」（または「確定を解除」）「Excel出力」のボタン、年度の状態、最終実行日時（auto_allocated_at）、最終読み込みと「読み直す」、StaleBanner。

| ボタン | 押せるとき |
| --- | --- |
| 自動振り分け | admin・allocating・未保存の変更がない・入力の problems がない・計算エンジンの読み込みが終わった（読み込み中は「計算エンジンを読み込み中」と出して待つ） |
| 最小変更で再実行 | 同上、かつ自動の行が1行以上ある |
| 確定 | 3.1 の確定の流れと同じ（YearStatusActions） |
| 確定を解除 | admin・confirmed。理由必須 |
| Excel出力 | admin（Q1 で staff も）・未保存の変更がない。Q3 |

**左：品目別（`?view=item&tab=<品目コード>`、既定）**

- タブは R8 のシートと同じ並び：机(木)（机(木)と不可机）・椅子(木)（椅子(木)と不可椅子）・キャスター机・椅子(青)・長机(3人掛)・長机(2人掛)・教卓。これ以外の品目（フェーズ3で足したもの）は後ろに品目の並び順で1つずつ。並びは exporter と同じであることを Vitest で確かめる（exporter の buildAllocationSheets のシート名と比べる。画面は exporter を静的に import しない）。
- 各タブ：運び元（保管場所の並び順）ごとのまとまり。まとまりの見出しに部屋名・在庫・使用不可の印。admin で allocating のときは、見出しのメニューに「今年は使用不可にする」「使用可に戻す」（理由のメモつき。`setRoomUsable`。1.5）を置く（使用不可にして最小変更で再実行する流れを、マスタ設定へ移らずにこの画面で終えるため。05 の画面の受け入れの「5分以内」。7.6）。応答が届かなかったとき・conflict・not_found・23505 のときは 2.6 の (B1)（(year_id, room_id) で room_years を読み直し、usable と note で比べる。「確かめる」のボタンや未確定の印は持たない）。save_allocation_rows の (B2) とは別の扱い。
- **使用不可にする順番（固定・手動の行を先に直す）**：save_allocation_rows（0006）は、update のたびに共通の検査で「変えた後の運び元（v_new.source_room_id）が使用不可なら E002」を確かめる。変える中身が固定（pinned）だけでも、備考・数だけでも同じで、使用不可の部屋の行に送れるのは「運び元を使用可の部屋に変える」update と delete（共通の検査の前に continue する）だけになる。そのため、部屋を使用不可にした**後**で固定を外そうとすると、必ず E002 で全体が拒否される。また手動の行（origin = manual）は固定を外しても fixedRows に残る（buildAllocateInput。2.7）ので、外しても precheck の E002 は消えない（注：T13 で確かめると、allocate の precheck の E002 は残すのルールの部屋だけで、固定・手動の行の E002 では止めず、保存の後の検証の E002〔error〕として出て確定を止める〔03・D-25〕。「precheck の E002 は消えない」は「検証の E002 が消えず確定できない」と読む。notes/T13.md の T13-7）。そこで「今年は使用不可にする」は次の順にする：
  1. 押すと、まずダイアログに、その部屋からの固定・手動の行（pinned か origin = manual。その年度の全品目のタブにまたがる）を一覧にする（団体・品目・数・自動／手動・固定）。行ごとの操作は、固定の自動の行（了承で固定した行など）に「固定を外す」（次の最小変更で動かせるようになる）・「運び元を変える」・「削除」、手動の行に「運び元を変える」・「削除」（手動の行は固定を外しても動かないので「固定を外す」は出さない）。
  2. 操作は未保存の変更に入る。まだ使用可なので、この時点の保存は E002 にならない。一覧が空になり、未保存の変更が保存されるまで、ダイアログの「使用不可にする」を押せなくする（「先に一覧の行を直して保存してください」）。未保存の変更がほかにも残っているときも押せない（使用不可の設定は room_years の直接の書き込みで版が上がり、スナップショットを読み直すため。2.6）。
  3. 一覧が空で未保存の変更がなければ、理由のメモを入れて使用不可にし、スナップショットを読み直す。「最小変更で再実行」を目立たせる。
  - マスタ設定の場所のタブ（3.2）から allocating の年度で使用不可にするときも、その年度の allocations（その部屋の行）を読んで `fixedRowsFrom(rows, roomId)`（lib/data/room-years.ts。T09a）で同じ一覧の件数を出し、1件以上なら「振り分け画面の部屋の見出しから使用不可にしてください」と振り分け画面（その部屋のまとまり）へのリンクを出して、ここでは押せなくする（設定の画面には未保存の変更の仕組みがないため）。
  - すでに使用不可の部屋に固定・手動の行があるとき（ほかの画面・ほかの人が先に使用不可にした、R8 の取り込みなど）は、その行の操作を「運び元を変える」「削除」だけにし、数・備考・固定のボタンを無効にして「使用不可の部屋の行は、運び元を変えるか削除してください（固定を外すには、先に部屋を使用可に戻します）」と出す。見出しの「使用可に戻す」→ 固定を外して保存 → もう一度「使用不可にする」の道もある。
  - Vitest：`allowedRowOps(row, usableByRoom)`（lib/allocation/pending.ts。使用不可の部屋の行は sourceRoomId の変更と delete だけ）と、使用不可にする前の一覧（固定の自動の行と手動の行で出す操作が違う）。E2E（t13）：使用不可の部屋の固定の行は画面に「固定を外す」が出ないこと、API（Node の supabase-js、管理者のテストユーザー）で save_allocation_rows に固定を外す update（`{ op: 'update', id, updatedAt, pinned: false }`）を送ると E002 で全体が拒否され、運び元を変える update と delete は通ること、上の順（先に直して保存 → 使用不可 → 最小変更）で precheck に E002 が出ないこと（注：T13-7。固定・手動の行の E002 は precheck に出ないので、E2E は失敗のパネルも検証の E002 も出ないことを見る）。
- 各タブの行の列：運び先（使用場所の名前。残すの行は「残す」）、団体、品目（2品目のタブだけ）、申請品目（品目と違うときだけ「机(木)の代わり」）、数、備考、自動／手動、固定（ピンのボタン）、操作（削除）。（注：T13 で、申請品目は列にせず品目のセル〔品目の列がなければ団体のセル〕の2行目にたたみ、表の中の数の入力を詰め、検証の一覧は 1280px〔xl〕から右・それ未満は表の下にした。PC の 1280px で2品目のタブの「固定・操作」の列が部屋のまとまりからはみ出したため。notes/T13.md）まとまりの最後に余りの行（在庫 − その部屋のその品目の行の合計。使用不可の部屋は「使用不可（在庫 n）」で余りに数えない）。余りがマイナスなら赤で E001 の印。
- 行に `data-row-id`（DataTable）。`?row=<id>` で開くと、その行のタブを開いてスクロールし、目立たせる。

**左：団体別（`?view=group&group=<id>`）**

- 団体ごと（並び順）に、申請品目ごとの需要（buildDemand の D。前処理1・2の後：企業以外の長机(3人掛)は長机(2人掛)に、未提出の設営は固定の数に）、振り分け数（申請品目ごとの行の合計。行の申請品目にも rewriteRowRequestedItem の読み替えを当てる）、差（不足は赤＝E003、多いは黄＝W101）、内訳（運ぶ品目ごと：「机(木) 10・不可机 2」と運び元）。

**右：検証の一覧**

- useValidation の結果を error → warning → info の順（validate の並びのまま）。種類ごとの件数を見出しに、コードで絞れる。
- 1件を押すと、`issueTarget(issue, snapshot, audiences)`（lib/allocation/issue-target.ts。純粋関数）で行き先を決める：refs.rowIds があればその行（品目タブ）、roomId と itemId があればそのタブの部屋のまとまり、groupId だけなら団体別のその団体、ruleCode があれば、admin には /rules?code=…（別のタブではなく同じタブで移動。未保存の変更があれば UnsavedChangesGuard）、admin 以外（Q1 の staff）にはリンクにせず、ルールのコードと内容の文（describeRule。ルールは staff も RLS で読める）を項目の下に開いて見せる（/rules は admin だけなので、移ると権限なしになる。1.1 の canOpen）。
- 検証は主スレッドで回す（R8 規模で 34 ms。実験）。未保存の変更があるときは、変更を当てた行で 150 ms まとめて回す。validate が例外を投げたら「検証できません：入力に誤りがあります」と problems を出す。

**行の操作（admin・allocating）**

- 数の変更（セルの CountStepper。min 1・max 10000。0 にしたいときは「削除してください」と出して削除のボタンへ案内する。save_allocation_rows は count が 0 以下の変更が1件でもあると全体を invalid_input にするため）、運び元の変更（その品目の在庫がある使用可の保管場所から、余りを添えて選ぶ）、備考（ポップオーバー。2000 字まで。自動の行のときは「備考を書くと、この行は手動の行になり、次の自動振り分け・最小変更で変わらなくなります」と出す。DB の save_allocation_rows は備考の変更もデータの変更に数え、origin を manual にするため）、固定・固定の解除（ピン）、削除（確認）、行の追加（シート：団体 → 申請品目（その団体の需要がある品目を先に）→ 品目（申請品目と、ルールでその団体に許される代替先。allocator の contextFor と substituteOptions で出す。ほかの品目は「ルール外（E004 になります）」と添える）→ 運び元（余りを添える）→ 数（既定は max(1, min(その団体・申請品目の不足, 余り))。不足がない・余りがないときは 1 にして「この団体の {申請品目} は不足していません」「この部屋の余りはありません」と添える）→ 固定するか）。
- 変更はすぐに送らず「未保存の変更」（lib/allocation/pending.ts。純粋関数）に溜める：

```ts
type PendingChange =
  | { op: 'insert'; tempId: string; sourceRoomId: string; groupId: string; itemId: string;
      requestedItemId: string; count: number; pinned: boolean; note: string | null }
  | { op: 'update'; id: string; updatedAt: string;
      patch: Partial<{ sourceRoomId: string; itemId: string; requestedItemId: string; count: number; note: string | null; pinned: boolean }> }
  | { op: 'delete'; id: string; updatedAt: string };
// applyPending(rows, pending)：画面と検証に使う行。データ（運び元・品目・申請品目・数・備考）を変えた行は origin = manual、
//   固定だけなら origin は変えない（DB の save_allocation_rows の v_data_changed と同じ。備考だけの変更も manual）
// toRpcChanges(pending)：save_allocation_rows の p_changes（camelCase。update・delete は id と updatedAt）
// rebasePending(pending, 新しい行と updated_at)：読み直した後に当て直す。相手の行が消えた・updated_at が変わった変更は外して一覧で返す
// reconcileAfterUnknown(pending, 前の行, 読み直した行)：保存されたか分からないとき（下）に、変更が反映済みかを判定する
```

- pending の zod（lib/allocation/pending.ts）で、count が 1〜10000 の整数、note が 2000 字までであることを確かめる。Vitest：applyPending で備考だけを変えた自動の行が manual になること、count 0 を拒むこと。
- 画面の下に「未保存の変更 N 件［取り消す］［保存…］」。保存は ReasonDialog（必須。よく使う理由のボタン：「団体の希望」「在庫の数え直し」「固定」「運び元の調整」）→ `save_allocation_rows(p_year_id, p_changes, p_reason)`（1000 件まで）。送信中は保存のボタンと ReasonDialog の確定のボタンを押せなくする。未保存の変更は下書き（1.4）にも置き、戻るボタンやタブの破棄の後に開き直したら、読み直した行に rebasePending で当て直して「保存していない変更 N 件を戻しました（当て直せなかったもの M 件）」と出す。
- **保存されたか分からないとき**（isUnknownOutcome。通信の失敗とタイムアウトだけ。2.6 の (B2)）：insert には冪等の鍵がないので、そのまま送り直すと同じ行が二重にできる。送り直しを押せなくし、次の順に確かめる。(1) years.allocation_version を読み直す。読めなければ「保存できたか確かめられません。通信が戻ったら『確かめる』を押してください」。確かめるまでは、保存に加えて、未保存の変更を変える操作（行の編集・行の追加・部屋の使用の切り替え・検証の一覧の行の操作・「取り消す」「元に戻す」・下書きを戻す）も押せなくし、「保存されたかを確かめるまで、編集できません。「確かめる」を押してください」と出す（「確かめる」は送った時点の変更で判定して未保存の変更を置き換えるので、待っている間の編集が知らせなく消えたり、取り消した変更が戻ったりしないように）。(2) 持っている版と同じなら保存されていない（save_allocation_rows は行を必ず変えるので、通れば版が上がる）ので、同じ変更をそのまま送り直してよい。(3) 版が進んでいればスナップショットを読み直し、`reconcileAfterUnknown` で突き合わせる：update は行の updated_at が変わり、値が自分の変更と同じ、delete は行がない、insert は前のスナップショットになかった行のうち（運び元・団体・品目・申請品目・数・備考・固定）が同じもの（1つの行は1つの insert にだけ当てる）。save_allocation_rows は全部か何も保存しないかなので、すべてが反映済みなら「保存されていました」として未保存の変更を空にする。どれも反映されていなければ、ほかの人の変更で版が進んだだけなので、rebasePending で当て直して送り直してもらう。一部だけが当たるときは決めきれないので、反映済みに見える変更と残りを並べて出し、管理者に残すものを選んでもらう。Vitest で3つの場合を確かめる。
  - insert に画面が作る id（uuid）を渡して DB の主キーにすれば、送り直しを冪等にできるが、RPC と 02・04 の変更になる（T03 の領分。今は上の突き合わせで足りる）。必要になれば T03・T04 の積み直しの後に別のチケットで相談する。
- 返り値：`allocation_version_before` が持っている版と同じなら、返った行でスナップショットの行を置き換え（delete は消す）、版を `allocation_version` にする。違えば（その間にほかの人が何か変えた）スナップショットを読み直す。
- conflict（details の id）：スナップショットを読み直し、rebasePending で当て直す。外れた変更は「次の変更は、ほかの人の変更とぶつかったので外しました」と一覧で出す。E002（使用不可の部屋）・invalid_input：入力を残して文言を出す。invalid_state（確定された・状態が変わった）：読み直して読み取り専用にする。
- 確定中・closed は編集できない（「確定後は編集できません。確定を解除してから」）。

**自動振り分け・最小変更で再実行**

1. 確認：「自動の行 N 件を置き換えます。固定・手動の行は残ります」（N は origin = auto かつ未固定の行の数）。最小変更は「前回の自動の行をできるだけ変えずに計算し直します。固定・手動の行は残ります」。
2. 画面をロックする（全面のオーバーレイ。進み具合：①計算エンジンの読み込み（初回だけ）②読み直しと入力の組み立て ③計算 ④保存 ⑤読み直しと検証。経過秒数）。「中止」は段階ごとに扱いを分ける：
   - ①・③（Worker の中）：10 秒を過ぎたら「中止」を出す。押すと Worker を terminate して作り直す（engine.cancel()）。DB には何も書いていない。
   - ②（読み直し）：10 秒を過ぎたら「中止」を出す。押すとクエリの結果を捨てて終わる（読み取りだけなので DB は変わらない）。
   - ④（save_auto_allocations を送った後）：中止を出さない。送った RPC は止められずコミットされうるので、「保存中…」と出して結果を待つ（Worker を止めても保存は止まらない。遅い回線では②と④だけで 10 秒を超えうる。T00 の測定で Slow 4G 相当は wasm の読み込みだけで約 6 秒）。応答が届かなければ 2.6 の「通信の失敗の後の書き込み」（版を読み直し、進んでいれば読み直して「保存されていました」か「ほかの人の変更」かを知らせる）。
   - ⑤：中止を出さない。保存は通っているので、読み直しだけが失敗したときも保存の結果（件数）は残し、「保存しました（追加 i・変更 u・削除 d）。読み直せなかったので「読み直す」を押してください」と「読み直す」のボタンを出す（読み込みの失敗の ErrorBanner だけにしない。読み直せるまで、前のスナップショットで数えた保存の後の error は出さない）。
   - 中止の後は必ず年度の版を読み直し、進んでいればスナップショットを読み直す。
3. スナップショットを版から読み直し（実行の直前に新しくする）、`buildAllocateInput(snapshot, mode)`。problems があれば止める。
4. Worker で allocate（4 章）。
5. `ok: false`：振り分けを書き換えず、reason ごとに見出しを変えて出す（パネル）：
   - invalid_input「入力に誤りがあります」：inputErrors の message とルールのコード（/rules?code= へのリンク）。
   - precheck「振り分けの前に直すものがあります」：issues（E001・E002・E005）。押すと該当の行（rowIds）かルール（ruleCode。admin だけ）へ。（注：T13-7。allocate の precheck の E002 は残すのルールの部屋が使用不可のときだけで、ルールを直す。使用不可の部屋からの固定・手動の行は precheck では止めず、保存の後の検証の E002〔error〕として出て確定を止める〔03・D-25〕。次の文の操作は、検証の一覧のその E002 の項目に添える。04 も合わせた）E002（使用不可の部屋からの固定・手動の行）には「運び元を変える」「行を削除」の操作を項目の横に出す（未保存の変更に入れ、保存してからもう一度実行してもらう）。「固定を外す」は出さない：部屋がすでに使用不可なので、save_allocation_rows の共通の検査が固定だけの update も E002 で拒否し、手動の行は固定を外しても fixedRows に残って precheck の E002 が消えないため（delete は共通の検査の前に通る。上の「使用不可にする順番」）。固定を外して最小変更に任せたいときは「部屋を使用可に戻す」（見出しのメニューへ移動）を添え、戻して固定を外して保存してから使用不可にし直す道を示す。ふつうは使用不可にする前の一覧で直すので、ここに来るのはほかの人・マスタ設定で先に使用不可にされたときなど。
   - infeasible「解けません」：まず shortages の品目全体の行（groupId が null：「{品目}が {demand − supply} 台足りません（需要 {demand}、使える在庫 {supply}）」）、次に団体ごとの行（「{団体}の{品目}：需要 {demand}、使える在庫 {supply}」）。次に causes：ruleCode があれば「原因のルール {code}：{message}」と details（「{団体}の{品目}：需要 241、{部屋の名前を「・」でつなぐ} の在庫合計 235」）。ruleCode が null の「代替を含めても在庫が足りません」は details の1件を「{itemIds の品目名を「・」でつなぐ}：需要 {demand}、在庫 {supply}」と出す（品目ごとの不足の行には混ぜない）。「複数の条件の組み合わせが原因」は details を対象ごとに並べる。最後に「ルールを変えるか、申請や固定行を直すかを決めてください」。
   - solver_error「計算できませんでした」：message（読み込みの失敗なら「通信を確かめて、もう一度実行してください。続くならページを再読み込みしてください」）。
6. `ok: true`：stats.excludedRequests が1以上なら結果の上に「申請できない品目の申請 N 件を除いて計算しました（検証の E006 を見てください）」。`save_auto_allocations(p_year_id, p_rows = result.rows, p_mode, p_base_version = 3 の版)`。
   - 成功：toast「保存しました（追加 i・変更 u・削除 d、計算 0.28 秒）」、スナップショットを読み直して検証する。
   - 保存の前には validate を回さない（ロジック設計 14 章の T13 は「保存の前に `validate(input, [...fixedRows, ...rows])`」と書いたが、次の理由でやめる）：allocate は自分の作る行に error を出さない（D-25）、固定・手動の行の error は保存を止めない（validate が示すだけ）、E001・E002・E005 は save_auto_allocations が DB の中で確かめて全体を取り消す。保存の後に DB の行（id つき）で検証すれば、検証の一覧から行へ移動できる（未保存の行は id がない）。保存して読み直した結果に error があれば、検証の一覧の上に「自動振り分けの後に error が N 件あります（固定・手動の行が原因）」と出す。
   - conflict：「計算している間に、ほかの人が振り分け・了承・在庫・申請・ルールなどを変えました。読み直しました。もう一度実行してください」（自動でやり直さない）。
   - E001・E002・E005：details の一覧を出して読み直す。invalid_state：読み直して読み取り専用にする。
7. 計算の時間（result.elapsedMs）を結果に出し（`data-testid="allocate-elapsed"`）、`performance.measure('allocate')` に残す（D-21 の確認。E2E で 2 秒以内を確かめる）。

**確定・確定を解除**：3.1 と同じ部品。確定後は編集のボタンを隠し「確定中（{日時}）。直すときは確定を解除してください」。（注：T13-2。years に確定の日時の列がなく〔auto_allocated_at だけ〕、確定の時刻の audit_logs は admin しか読めないので、日時は出さず「確定中です。直すときは「確定を解除」してください。」にした。04 も合わせた）

**Excel出力**：`const ex = await import('@gaapp/exporter')` → `ex.exportAllocationXlsx({ yearLabel, data, rows: 全行（note つき） })` → `allocationXlsxFileName(label)` で保存。団体名が SUMIF に使えない例外は「団体名「…」は Excel の集計に使えません。マスタ設定で名前を変えてから出力してください」。確定前の扱いは Q3。

**状態**：振り分けの行が1つもない（「まだ自動振り分けをしていません」と自動振り分けのボタン）、preparing・requesting（「締切の後に振り分けます」。ボタンは無効、ダッシュボードへのリンク）、viewer で確定前（「確定後に表示されます」）。

**計算エンジンの読み込み**：admin で allocating のときだけ、画面を開いたら Worker を作って読み込みを始める（4 章）。staff・viewer と、allocating 以外では読み込まない。

### 3.10 キャスター机交換 /swaps（T13）

admin。PC。スナップショット（版を先に読む）。

- 対象：了承が要る代替ルール（needsConsent。R8 は S07）の（団体、元の品目、先の品目）で、今の置き換え台数 n（requestedItemId = 元、itemId = 先の行の合計。固定・手動・自動を問わない）が1以上のもの、または了承の行があるもの。
- 表：団体・企画名（表示名）・使用場所・今の置き換え台数・依頼した台数（count）・状況（未依頼・依頼済み・了承・拒否）・備考・操作・注意。（注：T13 で「備考」は「団体へのコメント」にした。note は団体代表の /my に「コメント：」として出るので、総務の内部のメモには使えない。操作のダイアログの欄も同じ名前と説明にする。notes/T13.md の T13-19）
- 操作（allocating のときだけ）：
  - 「依頼済みにする」：`set_consent(group, from, to, 'asked', note)`。その時点の n が count に入る（行がなければ invalid_state の no_rows）。
  - 「了承」「拒否」（総務が代わりに記録）：`set_consent(…, 'accepted' | 'declined')`。了承でその団体の置き換えの行が固定され、拒否で固定が外れる。了承で conflict（asked・current）なら「依頼した台数より増えています。依頼し直してください」。
  - 「未依頼に戻す」：`set_consent(…, 'not_asked')`。状況が「依頼済み」か「拒否」のときだけ出す。「了承」のときは出さない：set_consent の not_asked は行の固定を変えない（固定するのは accepted、外すのは declined だけ）ので、了承から未依頼に戻しても了承で固定した置き換えの行は固定のまま残り、再実行で動かない（W102 が出るだけ）。了承を取り消すときは「拒否」を記録する（固定が外れる）か、振り分け画面で行の固定を外す（3.9）。
- 注意の列：依頼済みで n > count →「依頼の後に増えました。依頼し直してください」。了承で n > count →「了承の後に増えました（W102）。依頼し直してください」。拒否で n > 0 →「拒否されています。振り分け画面で『最小変更で再実行』が要ります」（振り分け画面へのリンク）。
- 各操作の後はスナップショットを読み直す（了承で行の固定が変わり、版が上がるため）。
- 「交換依頼一覧（Excel）」：`exportSwapsXlsx({ yearLabel, data, rows })` → `swapsXlsxFileName(label)`。
- 状態：対象がない（「キャスター机への置き換えはありません」）、allocating 以外は読み取り。

### 3.11 自団体の振り分け /my（T13）

rep。スマホ。団体の切り替えは /request と同じ（`?group=`）。

- 確定前（preparing〜allocating）：「振り分け作業中」と、自団体の申請の内容（品目と数、提出日時、備考）。了承の依頼（substitution_consents の status が asked・accepted・declined の行）があれば、「机(木) {count} 台をキャスター机に交換してほしいという依頼があります」と、まだ答えていなければ「了承する」「了承しない」（理由などの欄は任意。`set_consent(group, from, to, 'accepted' | 'declined', note)`）。答えた後は「了承しました（{日時}）」を出す。回答を変えられるかは Q4（推奨：確定まで「回答を変える」を出す）。依頼した台数より増えていて conflict なら「総務が依頼し直すのを待ってください」。
- 確定後（confirmed・closed）：品目ごとの数と運び元（「机(木) 12台：1-1 から 8台、1-2 から 4台」）。代替は「机(木)の代わりにキャスター机 6台（2-3 から）」。残すは「使用場所にあるものを使う（残す）」。
- フェーズ2：受け取り時刻（今は出さない）。
- 了承・拒否のボタンは送信中は押せなくする。開いている年度が最新でないときは、回答の前に「最新でない年度（R8）に回答します」と確かめる（1.3.1）。
- 状態：allocations は確定後にしか RLS で返らないので、確定前は読みに行かない。

### 3.12 履歴 /history（T14）

admin。PC。

- 絞り込み（URL に入れる）：表（複数。日本語の名前：申請・提出・在庫・振り分け・了承・ルール・年度・ロール・団体・団体代表・場所の状態・場所・品目・距離）、団体、期間（from・to。Asia/Tokyo の日付）、した人（その年度のメンバーの表示名から）。場所・品目・距離（年度をまたぐ表）を選んだときは year_id が null の行も含める（RLS で開いている年度の admin だけに返る）。or の1つの問い合わせ（`or(year_id.eq.{年度},year_id.is.null)`）にはせず、年度の表は `year_id = 年度`、年度をまたぐ表は `year_id is null` の2つの問い合わせで、それぞれ 51 件ずつ読み、`at desc, id desc` で合わせて先頭の 50 件を出す（51 件目があれば続きがある。or の1つだと索引の順で読めず遅い。D-43）。団体で絞るときは年度をまたぐ表の問い合わせを作らない。
- 表：日時・操作（追加・変更・削除）・表・対象（団体・部屋・品目の名前。消えた団体は before・after の name から）・変更（before と after の差。created_at・updated_at は除く。「count：3 → 5」）・理由・した人（profiles の表示名。読めなければ「名前を表示できません」、user_id が null なら「SQL・seed（アプリの外）」）。
- 読み方：`audit_logs` を `at desc, id desc` で 50 件ずつ（上の2つの問い合わせを合わせる。合わせる並びは at をマイクロ秒まで比べる）。続きは「さらに読み込む」（最後の行の at と id より前：`or(at.lt.{at},and(at.eq.{at},id.lt.{id}))` と `at <= {at}`。D-43）。件数は数えない（count: 'exact' は重い）。
- 差の作り方は純粋関数 `diffAudit(before, after)`（lib/data/history.ts。テストあり）。
- 状態：履歴がない（「この条件の変更はありません」）。

## 4. Worker と wasm（T00・ロジック設計 4 章）

### 4.1 wasm の置き方

- `scripts/copy-highs-wasm.mjs`（T09a）：apps/web から `createRequire` で `require.resolve('highs/runtime')`（highs の exports の `"./runtime"` が build/highs.wasm を指す）を引き、`apps/web/public/highs.wasm` にコピーする。`highs/package.json` は exports で公開されていないので、`require.resolve('highs/package.json')` は ERR_PACKAGE_PATH_NOT_EXPORTED で失敗する（実験で確認。04 の「node_modules/highs/build/highs.wasm をコピー」はこの方法で引く）。スクリプトはリポジトリの位置を `import.meta.url` から決める（pnpm は apps/web をカレントにして predev・prebuild を流すため）。
- apps/web/package.json に `"predev"` と `"prebuild"` の両方で `node ../../scripts/copy-highs-wasm.mjs`。`apps/web/public/highs.wasm` を .gitignore に足す。`pnpm build:e2e`（scripts/build-e2e.mjs）も next build を通るので prebuild が効くことを確かめる。
- out/ には public の highs.wasm と、Turbopack が出す `_next/static/media/highs.<hash>.wasm` の2つが入る（3.5 MB ずつ）。ブラウザが取るのは locateFile の1つだけ（実験で確認）。

### 4.2 Worker の作り方と使い回し

- `apps/web/workers/allocate.worker.ts`（T13）：

```ts
/// <reference lib="webworker" />
import loadHighs from 'highs';
import { allocate, type LpSolver } from '@gaapp/allocator';
import { HIGHS_VERSION, type AllocateInput } from '@gaapp/shared';
import { BASE_PATH } from '@/lib/env';
import { highsWasmUrl } from '@/lib/allocation/wasm-url';   // `${origin}${basePath}/highs.wasm?v=…&r=…`（Vitest あり）

let solver: Promise<LpSolver> | null = null;
let attempt = 0;
const getSolver = () => {
  solver ??= loadHighs({                             // オプションのオブジェクトは呼ぶたびに新しく作る（T00）
    locateFile: (f: string) =>
      f.endsWith('.wasm') ? highsWasmUrl(self.location.origin, BASE_PATH, HIGHS_VERSION, attempt) : f,
  }).catch((err: unknown) => { solver = null; attempt += 1; throw err; }) as Promise<LpSolver>;   // 失敗を残さない
  return solver;
};
type Req = { id: number; type: 'warmup' } | { id: number; type: 'allocate'; input: AllocateInput };
self.onmessage = async (e: MessageEvent<Req>) => {
  const { id } = e.data;
  const t0 = performance.now();
  let s: LpSolver;
  try { s = await getSolver(); }
  catch (err) { postMessage({ id, type: 'load-error', message: String(err) }); return; }
  const loadMs = performance.now() - t0;
  if (e.data.type === 'warmup') { postMessage({ id, type: 'ready', loadMs }); return; }
  postMessage({ id, type: 'progress', phase: 'solving' });
  try { postMessage({ id, type: 'result', loadMs, result: allocate(e.data.input, s) }); }
  catch (err) { postMessage({ id, type: 'error', message: String(err) }); }
};
```

- 読み直しのとき URL に `&r=<回数>` を付ける（GitHub Pages の 404 がキャッシュされても取り直すため）。同じ Worker の中で、失敗の後にもう一度 loadHighs を呼ぶと読み込める（実験で確認：わざと 404 にして失敗 → ファイルを戻して warmup → 182 ms で読み込めた）。
- `lib/allocation/engine.ts`（T13）：Worker を1つだけ持つ（モジュールの変数。`new Worker(new URL('../../workers/allocate.worker.ts', import.meta.url))` はこのファイルにだけ書く。Turbopack が Worker のチャンクを分け、`new Worker` を実行するまで取得しない）。

```ts
type EngineState = 'idle' | 'loading' | 'ready' | 'failed';
interface AllocatorEngine {
  state(): EngineState; subscribe(fn: () => void): () => void;   // 画面の表示用（useSyncExternalStore）
  warmup(): Promise<{ loadMs: number }>;                       // 読み込みを始める。済んでいればすぐ返る
  run(input: AllocateInput): Promise<{ result: AllocateResult; loadMs: number; wallMs: number }>;
  cancel(): void;                                              // Worker を terminate して、次の run で作り直す
}
export function getAllocatorEngine(): AllocatorEngine;
```

- 要求ごとに番号を付け、応答を番号で引く（Map）。load-error は `{ ok: false, reason: 'solver_error', message: '計算エンジン（highs）を読み込めませんでした。…' }` にそろえ、error（allocate の例外）は「計算中に予期しないエラーが起きました」にする（どちらも画面は solver_error の見出し）。`worker.onerror`（チャンクの取得の失敗。デプロイの直後に古いページで起きうる）は「ページを再読み込みしてください」を足して、Worker を捨てる。
- 使い回し：SPA の中で振り分け画面を離れて戻っても同じ Worker を使う（読み込み済みなら即座に使える）。ログアウトで terminate する。
- 振り分け画面を開いたとき、admin で allocating なら `warmup()` を呼び、上部に「計算エンジンを読み込み中（初回だけ。約 1.2 MB）」と出す。staff・viewer、allocating 以外では Worker を作らない。

### 4.3 読み込みの失敗・進み具合・2秒の基準

- 失敗：自動振り分けのパネルに solver_error として出す。「もう一度実行」で run を呼ぶと読み直す。
- 進み具合：3.9 のロックのオーバーレイ（Worker の progress と画面の段階を合わせる）。計算は同期なので途中の割合は出さず、経過秒数を出す。10 秒で「中止」を出すのは、Worker の中の段階（読み込み・計算）と読み直しの段階だけ（3.9 の手順2。保存を送った後は中止できない）。
- wasm の URL は `highsWasmUrl(origin, basePath, version, attempt)`（lib/allocation/wasm-url.ts。T13）で作り、Worker と Vitest（basePath ありとなし）で同じ関数を使う。basePath つきの書き出しで Worker が wasm を取れることは、T14 の basePath のスモーク（7.2）で確かめる。
- 2秒の基準（D-21）：allocate の中で測った `result.elapsedMs`（wasm の初回の読み込みを含まない）で判定する。画面に出し、E2E（T13・T14）で 2000 未満を確かめる。読み込みの時間（loadMs と `performance.getEntriesByName(…highs.wasm…)`）は別に記録する（notes に書く）。ui-lab の実測：合成データ r8like で読み込み 208 ms（localhost）、allocate 284 ms（初回）、往復 286 ms。
- validate・exporter は Worker に入れない（validate は 34 ms、Excel は 77 ms で、主スレッドで十分。実験）。

## 5. CSV 取り込み（T11）と importer のつなぎ

### 5.1 流れ（申請一覧の「Googleフォームの回答を取り込む」。admin、preparing〜allocating）

1. **種類とファイル**：模擬店・部門・企業を選び、CSV を選ぶ。`lib/csv-file.ts` で `file.arrayBuffer()` を UTF-8（fatal）で読み、だめなら Shift_JIS で読む（Excel で保存し直した CSV のため）。どちらでも読めなければ「文字コードが読めません（UTF-8 か Shift_JIS の CSV にしてください）」。BOM は importer が許す。
2. **読み取り**：`parseFormCsv(kind, text, items)`。`ImportFormatError`（見出しが合わない・引用符が閉じていない）はその message を出す（元の値を含まない）。
3. **団体への対応**：その種類の区分の団体だけを渡す（模擬店のフォーム → stall、部門 → department、企業 → company）。`resolveResponses(parsed, groups, items, manual)`。manual（行番号 → 団体 id）は画面の状態で、選び直すたびに resolveResponses を呼び直す（純粋関数で速い）。
4. **プレビュー**：
   - 件数：回答 N、対応した M、対応しない U、取り込まない R（理由ごと：列のずれ・数が読めない・日時が読めない・空の行）、古い回答 S、読まなかった列（見出しだけ）。
   - 対応しない行（unmatched）：行番号・フォームの団体名（企業は空）・タイムスタンプ・数の要約（「机(木)4・椅子(木)8」）・団体を選ぶ（EntitySelect。区分で絞る）か「取り込まない」。企業のフォームは全部の行がここに来る。マスタにない団体は「先にマスタ設定で団体を作ってください」とリンク。
   - 古い回答（superseded）：団体ごとに、使う行と使わない行（行番号とタイムスタンプ）を出す（04「古いものは画面に出して確認させる」）。
   - 取り込まない行（rejected）：行番号と理由だけ（中身は持たない）。
   - 団体ごとの結果：団体・フォームのタイムスタンプ・品目ごとの数（CSV）と今の DB の数（違うセルに印）・DB の提出日時・備考の有無・「上書きする／取り込まない」（既定は Q2）。読み替え（企業以外の長机(3人掛) → 長机(2人掛)）が起きた団体には「長机(3人掛)を長机(2人掛)に読み替えました」。
   - 申請できない品目（不可机など。resolveResponses は読み替え先のない申請をそのまま残す）は送らず、「申請できない品目のため取り込みません」と団体ごとに出す（送ると DB のトリガーが E006 でその団体の全部を拒否するため）。
5. **保存**：「取り込む（K 団体）」→ 理由（既定「Googleフォームの回答の取り込み（模擬店）」。編集できる。理由は audit_logs に残り続け、ファイル名には人の名前が入りうるので、ファイル名は入れない〔T11 で変えた〕）→ 団体ごとに順に `update_requests_after_deadline(p_group_id, p_rows, p_reason, p_submission)`：
   - p_rows：その団体の区分で申請できる品目と、DB に行がある品目のすべてについて `{ itemId, count（CSV になければ 0）, updatedAt（DB に行があるとき） }`。フォームの回答は申請の全体なので、CSV にない品目は 0 にする。
   - p_submission：`{ submittedAt: フォームのタイムスタンプ（resolveResponses の submissions。+09:00 の ISO）, note }`。DB が提出済みにし、submitted_at をその日時にする（D-19・D-29。admin の RPC だけが日時を渡せる）。
   - 状態が preparing・requesting（締切前も）・allocating ならこの RPC で書ける（締切の前後で書き方を分けない。提出日時を残すため）。
   - 団体ごとに成否を出す（conflict：「取り込みの前に、ほかの人がこの団体の申請を変えました。読み直してからもう一度」、invalid_input（submittedAt が未来など）：その文言）。全部終わったら申請一覧を読み直す。
6. **後始末**：ダイアログを閉じたら、ファイルの中身と結果を状態から消す。中身はログに出さず、どこにも保存しない（ESLint の no-console と、レビューで確かめる）。メールアドレスは importer がどの列にあっても捨てる（04）。

### 5.2 テスト

- Vitest（jsdom）：取り込みの部品に fixtures/importer-samples の CSV（予約ドメインのメール入り）を渡し、対応しない行・古い回答・取り込まない行が出ること、画面のどこにもメールの文字列が出ないこと、送る p_rows に CSV にない品目の 0 が入ること、申請できない品目が送られないこと。
- E2E（e2e/t11-import.spec.ts）：`createScenario({ dataset: 'small', extraGroups: [{ name: '模擬店甲', category: 'stall' }, { name: '模擬店乙', category: 'stall' }, { name: '模擬店丙', category: 'stall' }] })` で importer-samples の団体名に合う団体を作り（「存在しない団体」と、名前がメールの行は合わない）、stall.csv を取り込む → 対応しない行を手で選ぶ → 取り込む → requests と submitted_at（フォームのタイムスタンプ）が入ったことを SQL で確かめる。合成データ r8like の年度では取り込まない（需要が変わって、ほかのテストの前提を崩すため。通しの流れの取り込みは 7.3 の専用の CSV）。

## 6. QR・ダッシュボードの集計・履歴の検索・年度データの書き出し

- **QR**（T10）：3.4。URL の作り方は `stockUrl(roomId)`（lib/data/stocks.ts）にまとめ、`${location.origin}${BASE_PATH}/stock/?room=${roomId}`。uqr の `renderSVG(url, { border: 2 })` の文字列を dangerouslySetInnerHTML で出す（uqr が作る SVG だけ。利用者の文字列を入れない）。テスト：URL の関数（basePath あり・なし）と、カードの数。
- **ダッシュボードの集計**（T09）：`summarizeDashboard(snapshot, issues)`（lib/data/dashboard.ts。純粋関数）が 3.1 の数をすべて返す（提出・在庫・検証・了承）。了承の集計は /swaps と同じ `swapRows(snapshot)`（lib/data/swaps.ts）を使うので、T09a が swapRows を置き、T13 の /swaps はそれを使う（同じ数え方を2か所に書かない）。テストは合成データのスナップショット（fixtures から作った DB の行）で行う。
- **履歴の検索**（T14）：3.12。
- **年度データの書き出し**（T09）：3.2 の書き出し。toYearExport → exportYearJson（同期で文字列を返す）→ download。壊れたルールもそのまま書き出す（2.7）。Excel は 3.9 と同じ関数（lib/data/export.ts の `downloadAllocationXlsx(snapshot)`。T09 と T13 の両方が使うので T09a が置く。exporter の exportAllocationXlsx・allocationXlsxFileName は T08 にしかないので、T09a は T08 のマージの後に始める。8.1）。exporter は動的 import。

## 7. テスト

### 7.1 Vitest（部品と純粋関数）

- 環境：既定は node のまま（T04 の renderToStaticMarkup のテストを変えない）。DOM が要るファイルだけ先頭に `// @vitest-environment jsdom` を書き、`@testing-library/react` と `user-event` を使う（実験で Vitest 5.0.5・jsdom 30.1.3・React 19.3.1 の組み合わせが動いた）。Supabase は呼ばず、`useAuth` や lib/data の関数を vi.mock で差し替える。
- 純粋関数は必ずテストする：toYearData（建物・表示名の '' と空白だけ、壊れたルール、空の建物の距離の上書き）・toStoredRows・buildAllocateInput・toYearExport（壊れたルールをそのまま書き出す。合成データの fixtures を DB の行の形にしたもの → YearData が shared/testing の toYearData と同じになる）、loadSnapshot の読む順、updateWithLock・deleteChecked の分け方、classifyError・messageFor（2.5 の表の行ごと。PGRST303・status 401・details のない invalid_input・invalid_state を含む）、datetime、canOpen、issueTarget（立場ごと）、pending（applyPending〔備考だけの変更で manual〕・toRpcChanges・rebasePending・reconcileAfterUnknown〔全部・なし・一部〕・allowedRowOps〔使用不可の部屋の行は運び元の変更と削除だけ。固定を外すは出さない〕）、使用不可にする前の一覧（固定の自動の行と手動の行で出す操作が違う。3.9）、下書き（lib/drafts.ts。期限・手動のログアウトで消える・強制の signOut では残る・別の user_id でログインすると他人の下書きが消える・localStorage が使えないとき）、toYearData の参照の確かめ（参照の切れたルール → problems に ruleCode、validate が例外を投げない。2.7）、rulesReferencing（団体・場所の削除の確認）、AuthProvider（reloadMembership の間に子が外れない・初回は LoadingState。1.3）、optionalText、品目タブの並び（exporter と同じ）、summarizeDashboard、swapRows、describeRule、diffAudit、stockUrl・highsWasmUrl（basePath ありとなし）、CSV の文字コードの判定、取り込みの p_rows の作り方。
- 部品のテスト（チケットごとに主なもの）：CountStepper（min・max）、ReasonDialog（必須・500 字・送信中は押せない）、YearStatusActions（押せる条件。problems があると確定できない）、AppLink（開けない立場では文字だけ・未保存の変更があれば確かめる）、UnsavedChangesGuard とログアウト・年度の切り替え（手動のログアウトは確かめてから下書きを消す、強制の signOut は確かめず下書きを残す、年度の選択は確かめ、やめれば元に戻る。1.4）、在庫入力の読み取り専用の切り替えと最新でない年度の確認、申請フォーム（区分で品目が出る・出ない、出していない品目の読み取り専用の行、DB が締切後と判断した印）、取り込みのプレビュー、振り分けの ok: false のパネル（reason ごと）、検証の一覧のクリック（staff ではルールへのリンクにならない）、未保存の変更のバー、自動振り分けのロック（中止は計算の段階でだけ出る。engine を偽物にして fake timers で進める）、/my の確定前・後。
- CI の check ジョブの時間：今の `pnpm test` は約 35 秒（allocator が大半）。画面のテストを足しても +20 秒程度に収める（jsdom はファイルごとに約 0.5 秒）。

### 7.2 Playwright（ローカルの Supabase とテストユーザー）

**ログインの保存**

- T04 の loginAs を使う。速くするため、setup のプロジェクト（`e2e/setup/auth.setup.ts`）で seed の admin・staff・viewer・rep に1回ずつログインして storageState（`e2e/.auth/<user>.json`。git に入れない）を保存し、各テストは `test.use({ storageState })` で使う（supabase-js のセッションは localStorage にあるので storageState に入る）。
- **ログアウトとの干渉**：supabase-js の `signOut()` の既定は `scope: 'global'` で、同じ人のすべてのセッションを終える。批評の実験（staff で2回ログインし、片方で /auth/v1/logout）では、もう片方の /auth/v1/user が 403 session_not_found、refresh が 400 refresh_token_not_found になった（REST はアクセストークンの1時間のあいだ通る）。そのため、並行に流れるログアウトのテスト（T04 の auth.spec の staff・outsider）が、storageState の同じ人のセッションを不定に壊す。次の2つで防ぐ：(a) アプリのログアウトを `signOut({ scope: 'local' })` にする（1.3。その端末のセッションだけを終える。共用 PC で抜ける意味にも合う）。(b) T09a 以降にログアウトを試すテストは、createUser の使い捨てのユーザーか、画面からログインし直したセッション（storageState を使わない）で行う。T09a は T04 の auth.spec の期待値（Q1 のナビ）を直すときに、ログアウトのテストが (a) で通ることを確かめる。

**年度をまたぐ表の準備**（`e2e/setup/global.setup.ts`。T09a）

- rooms・items・distance_overrides は年度をまたぐ表で、どの年度のシナリオも同じ行を見る。しかも、これらに行を足すと、文の単位のトリガー tg_bump_allocation_version が振り分け中の**すべての**年度の allocation_version を上げる（批評の実験：振り分け中の年度があるときに rooms に新しい行を入れると版が 0→1、distance_overrides に入れると 1→2。すでにある名前の on conflict do nothing〔0 行〕では変わらない）。シナリオごとに入れると、並行のテストの保存・確定が無関係に conflict になり、場所の属性と距離の上書きも全年度で共有なので、どのシナリオが先に走ったかで計算・W104・ダッシュボードの数が変わる。
- そこで、年度をまたぐ行は、並行のテストを始める前の setup（`db-setup` のプロジェクト。auth-setup の前）で**1回だけ**入れる：
  - 全データセット（small・合成データ r8like。infeasible は r8like の場所を使う）の場所を、名前で `insert … on conflict (name) do nothing` し、読み直して属性（kind・building・floor・is_storage・extra_cost）がデータセットと同じかを確かめる。違えば、どの場所のどの属性かを出して止める（黙って別の属性のまま進めない）。R8 の本データを seed に入れる PR（T05 の次の PR。r8like と同じ部屋名〔1-1・MER・第一セミナーなど〕を持つ）で属性が食い違えば、ここで止まるので、その PR で r8like を R8 にそろえて作り直すか、合成データの場所の名前を変える（T05 への申し送り）。**注（D-40）**：今は R8 の本データは seed に入らず、合成データ r8like で代用する（fixtures/r8 と seed の R8 のデータの区間は作らない）。この食い違いは起きないので、T05 への申し送りは要らなくなった。R8 の本データを使うことになったら、そのときにここの扱いに戻る。
  - r8like の距離の上書き（distance_overrides.csv：体育館・教室棟A 3、教室棟A・教室棟B 2）も入れる（合成データと同じ距離で解くため）。同じ組があってコストが違えば止める。E2E の DB の上では seed の R8 の年度にも効くが、E2E で seed の R8 を振り分けるテストはない（fixtures/r8 が入ったら、R8 の距離の上書きと食い違わないかをここで確かめる）。
  - 品目は seed の品目を code で引く。データセットが使う code がなければ止める。
  - 入れた後に、この時点の年度をまたぐ表（場所の一覧）を `e2e/.cache/global-rooms.json` に書く。並行のテストの間は誰も年度をまたぐ表を変えないので、この一覧は chromium のプロジェクトの間は変わらない。
- 年度をまたぐ表を変えるテスト（場所・品目・距離の編集）は serial（下）でだけ流す。serial は chromium とは別のコマンドで後に流すので、並行のテストの版を進めない。
- **serial で年度をまたぐ表を変えるときの決まり**：同じ serial の通しの流れ（full-flow）の計算と、次の実行の db-setup の属性の確かめ（違えば止まる）が、前のテストの残り物で揺れないように、データセット（small・r8like）と seed の場所・品目・距離の上書きは変えない。テストの中で、テスト専用の名前の行を作って変え、最後に消す：場所は `E2E-serial-<テストの id の先頭8字>`（建物も `E2E-serial-棟<…>`）、品目は code `e2e_serial_<id の先頭8字>`（items の code の CHECK `^[a-z][a-z0-9_]*$` に合う形）、距離の上書きはテスト専用の建物どうしの組。消すのは `afterEach`（失敗しても流れる）で、pg で直接消す（品目は画面に削除がないため。場所は room_years から参照されていると 23503 になるので、先にその場所の room_years の行を消す）。テストの中では、テスト用の場所を作った後に createScenario を呼ばない（呼ぶと、その年度の room_years がその場所を「使わない場所」として参照する）。消し忘れは次の実行の db-setup が消す（上）。

**シナリオの年度**（`e2e/support/db.ts`。T09a）

ローカルの DB（`supabase status` の DB_URL。127.0.0.1・localhost 以外なら例外にして止める）に `pg` で postgres としてつなぎ、テストごとに年度を作る。**年度の表だけに書く**（years・room_years・groups・request_submissions・requests・stocks・rules・substitution_consents・allocations・year_roles・group_members）。rooms・items・distance_overrides には書かず、場所は名前で、品目は code で DB から id を引く。

```ts
createScenario({
  status?: YearStatus;                    // 既定 requesting（受付期間は開いている）
  requestWindow?: 'open' | 'closed' | 'not-yet';
  dataset?: 'empty' | 'small' | 'synthetic' | 'synthetic-infeasible-s05';   // 中身は下の表
  rules?: 'dataset' | 'none';             // 既定 dataset。none はルールを入れない（T12 で S01〜S08 を画面から入れる）
  allocations?: 'none' | 'reference';     // reference は r8like の reference/allocations.csv を auto の行として入れる
  extraGroups?: { name: string; category: GroupCategory; locationRoomName?: string; aliases?: string[] }[];   // 取り込みのテストの団体（模擬店甲など）
  prevYear?: { dataset: 'small' | 'synthetic'; status?: YearStatus };       // 前年度を作って prev_year_id でつなぐ（前年の数・前年との差・休憩所の前年の数）
  usable?: Record<string, boolean>;       // 場所の名前 → 今年の使用（合成データの第一セミナーを使用可にして始めるなど）
  roles?: { admin?: boolean; staff?: boolean; viewer?: boolean };   // seed のテストユーザーに、この年度のロールを付ける
  repGroup?: string;                      // seed の団体代表（rep）を、この年度のこの団体の代表にする
  grants?: { userId: string; role: 'admin' | 'staff' | 'viewer' }[];   // createUser のユーザーに、この年度のロールを付ける
  festivalStart?: 'before-seed' | 'latest';   // 既定 before-seed（2001 年台）。latest は seed の R8 より後（2199 年台。下）
  keep?: boolean;                         // cleanup しない（手での確かめに使う年度。7.6。年度名は MANUAL- で始める）
}): Promise<{ yearId; label; prevYearId?: string; ids: { groups; rooms; items; rules }; cleanup(): Promise<void> }>
```

| dataset | 場所（名前） | 団体・申請・在庫・ルール |
| --- | --- | --- |
| empty | なし | なし（年度だけ） |
| small | `E2E倉庫A`・`E2E倉庫B`（保管場所、建物 E2E棟 の1階・2階）、`E2E教室1`・`E2E教室2`（使用場所、E2E棟）、`E2E屋外`（outdoor の保管場所） | 団体 `E2E模擬店1`（stall、E2E教室1）・`E2E部門1`（department、E2E教室2）・`E2E企業1`（company、場所なし）。在庫は机(木)・椅子(木)・キャスター机・長机(2人掛)を倉庫ごとに 10・20・4・4（E2E屋外 は椅子(木) 10 だけ）、長机(3人掛) は E2E倉庫A に 2。申請は団体ごとに机(木) 3・椅子(木) 6・長机(2人掛) 1（企業は長机(3人掛) 1）。ルールは代替1件（机(木) → キャスター机、模擬店だけ、了承が要る。/swaps と了承の確かめに使う）。解けて、余りがある小さな入力で、計算・画面の確かめに使う。e2e/support/datasets.ts に書き、e2e-support の Vitest で allocate が ok になることを確かめる（個人情報なし） |
| synthetic | fixtures/synthetic/r8like の場所（56 か所。名前のまま） | r8like の団体・申請・在庫・了承・ルール（rules: 'dataset' のとき）。提出日時は fixtures の値 |
| synthetic-infeasible-s05 | synthetic と同じ | synthetic の設営の机(木)の申請を、S05 の運び元（1-1〜2-3）の机(木)の在庫合計より 10 多くする（ほかは同じ）。解けず、causes に S05 が出る（T07 の diagnose のテストと同じ作り方） |

- 年度名は `E2E-<テストの id の先頭8字>`、1日目は 2001 年の日付（前年度は 2000 年）にする（seed の R8 より前にして、既定の「今の年度」を R8 のままにする。年度名は一意）。
- **最新の年度のシナリオ（`festivalStart: 'latest'`。serial でだけ使う）**：create_year_from の not_latest は、見える年度だけでなく**全年度**で「複製元より1日目が後（か同じ）の年度、複製元を prev_year_id にする年度がない」ことを確かめる（0005）。2001 年のシナリオの年度は seed の R8（2026-10-17）より前なので、シナリオの年度から新しい年度を作ると必ず not_latest になる。そこで年度の作成のテストは、1日目を R8 より後にしたシナリオの年度（2199-01-01＋テストの順の日数。前年度を付けるなら 2198 年）から作り、新しい年度の1日目は 2200 年の日付（1日目の上限 2200-12-31 以内）にする。この年度は全年度の中で最新になるので、(1) chromium（並行）では使わない（使うと、ほかのテストの「最新の年度」が変わる。createScenario は serial のプロジェクトの外で latest を呼ぶと例外にする）。(2) seed のユーザー（roles・repGroup）にはロールを付けない（付けると、その間 seed のユーザーの既定の年度が変わる。createScenario は latest で roles・repGroup を渡すと例外にする）。ロールは `grants` で createUser のユーザーに付け、そのユーザーでログインする。(3) cleanup で、作った新しい年度も一緒に消す（`cleanup()` は prev_year_id でこの年度につながる年度も消す）。seed の R8 から年度を作るテストは置かない（R8 の年度の行に prev_year_id でつながる年度ができ、消し忘れると seed の R8 の admin の既定の年度も変わるため）。
- **前の実行の残り物を消す**：db-setup は、最初に、前の実行が途中で止まって残ったもの（年度名が `E2E-` で始まる年度と、それに prev_year_id でつながる年度。serial のテスト用の名前〔下〕の場所・品目・距離の上書き。createUser のユーザー〔`e2e-` で始まる `@example.test`〕）を消してから、年度をまたぐ表を入れる（ローカルの DB だけ。年度は allocating に戻してから消す）。手での確かめの年度（keep。7.6）は年度名を `MANUAL-` で始め、消さない。
- **データセットにない場所は、その年度では使用不可にする**：シナリオの年度の room_years に、データセットにない場所（seed のテスト用保管場所1・2、ほかのデータセットの場所）を `usable = false`、note「E2E：このシナリオでは使わない」で入れる。これで W104・ダッシュボードの「数えた保管場所 n／m」・在庫一覧の合計・振り分けの運び元が、そのシナリオの場所だけになる（在庫入力の場所の一覧には「使用不可」の印つきで出るので、一覧を確かめるテストはデータセットの名前で絞る）。
- 団体・ルールはシナリオごとに新しい id にし、ルールの params の団体 id と場所 id を付け替える（UUIDv5 のままだと並行のシナリオで主キーがぶつかる。場所は名前で DB から引いた id にする）。
- **reference の行の is_keep**：reference/allocations.csv には isKeep の列がない。入れるときは `is_keep = (運び元 = その団体の location_room_id)`（allocator の rows.ts と同じ定義。save_allocation_rows も同じ式で決める）にする。そのまま false で入れると、学科展示（使用場所は第一多目的室）の残すの行（desk・第一多目的室・18）が E005 になり、確定・/my の確定後・確定中の Excel のテストの前提（error 0）が崩れる。T09a の Vitest（下の e2e-support）で「reference を入れた年度の行を YearData にして validate すると error 0」を確かめる。
- 作るときは、年度を allocating（受付期間つき）で作ってデータと振り分けの行を入れてから、最後に status を目的の状態にする（確定中・終了の年度には、確定中の守りのトリガーが allocations・stocks などの書き込みを止める。postgres でつないでもトリガーは動く）。年度の表への書き込みは、その年度の版だけを上げる（ほかのテストに効かない）。受付期間の「開いている・閉じた・まだ」は request_open_at・request_close_at を now() からずらして作る。
- cleanup は年度を allocating に戻してから削除する（確定中の守りが連鎖削除を止めるため）。前年度も消す。
- **テストユーザーとロール**：seed の admin・staff・viewer には、`roles` でシナリオの年度にだけロールを付け、seed の rep は `repGroup` でシナリオの年度の団体の代表にする（cleanup で年度ごと消える）。seed の R8 の年度のロールと、未招待の outsider には触れない。ロール・招待・団体代表を変えるテスト（invite・set_role・remove_role・remove_group_member）は、seed のユーザーではなく createUser の使い捨てのユーザーで行う。シナリオの年度ができている間、seed のユーザーは年度を2つ以上持つのでヘッダーに年度の選択が出るが、既定の年度は R8 のまま（シナリオは 2000〜2001 年）で、`current-year` の文字も変わらない（1.3）ので、並行に流れる T04 の e2e/auth.spec.ts は揺れない。
- ブラウザでは `pinYear(page, userId, yearId)`（`addInitScript` で sessionStorage の `gaapp:year:<user_id>` を入れる）で、そのシナリオの年度を開く。
- これは E2E のためのローカル専用の補助で、アプリとビルドには入らない（publishable キー以外の鍵も使わない。DB には DB_URL でつなぐ）。D-36。
- **使い捨てのユーザー**：`createUser({ verified?: boolean })`（db.ts）は、seed と同じ形で auth.users（email_confirmed_at・パスワードは `extensions.crypt`）と auth.identities（provider email、identity_data に `email_verified: true`）を入れ、`e2e-<用途>-<id の先頭>@example.test` のユーザーを作る（`e2e-` で始めて seed のユーザーと分ける。db-setup が残り物を見分けるため）。cleanup で消す。手での確かめのユーザー（7.6）は `manual-` で始め、db-setup は消さない。`verified: false`（email の identity の email_verified を付けない）で、invite の applied が false になること、そのユーザーのホームが「総務から招待されていません」のままであることを確かめる（D-17a。T03 の 021 と同じ条件を画面から）。
- ローカルの Supabase は Confirm email が有効（T03 の bd42552。`enable_confirmations = true`）なので、E2E は画面からのサインアップやメールの変更を使わない（確認のメールを Mailpit から拾う手順を持たない。CI の supabase start は mailpit を起動しない）。ユーザーは seed か createUser で作り、テスト用ログイン（T04）で入る。
- **期待値の決め方**：数を確かめるテストは、そのシナリオのデータセット（とシナリオで変えたもの）から期待値を作る。年度をまたぐ表の全体（場所の数など）を当てにするときは、setup が書いた global-rooms.json から作り、数を書き込まない。
- **遅い表示を確かめるとき**：r8like の計算は約 0.3 秒、読み直しと保存を含めても1秒ほどで終わるので、ロックのオーバーレイや読み込み中の表示は Playwright が見る前に消えうる。E2E とスクリーンショットでは `page.route('**/rest/v1/rpc/save_auto_allocations', …)`（読み込み中なら該当の `/rest/v1/<表>`）で応答を止め、表示を確かめてから `route.continue()` で流す。10 秒の「中止」は E2E ではなく Vitest（engine を偽物にして fake timers で進める）で確かめる。

**e2e-support の Vitest**（T09a）：ルートの vitest.config.ts の projects に `{ name: 'e2e-support', include: ['e2e/**/*.test.ts'] }` を足す。createScenario の行の作り方（DB につながない純粋な部分。ルールの付け替え・is_keep・データセットにない場所の room_years）と、reference の validate が error 0 になることを確かめる。通しの流れのデータの事前の確かめ（7.3）もここに置く。

**プロジェクト**（playwright.config.ts。T09a）

- `db-setup`：年度をまたぐ表の準備（上）。`auth-setup`：storageState（db-setup に依存）。
- `chromium`（fullyParallel。auth-setup に依存）：シナリオの年度で閉じたテスト。CI は workers 2。
- `serial`（`e2e/serial/`。workers 1。auth-setup に依存し、chromium には依存させない）：年度の作成（`festivalStart: 'latest'` のシナリオの年度から複製して、後で消す。準備中など終了していない年度からと、終了した年度からの2つ。上の「最新の年度のシナリオ」）、年度をまたぐ表（場所・品目・距離）の編集（テスト専用の名前の行だけ。上の決まり）、通しの流れ（T14）。
- `basepath`（T14 が足す。下の「basePath のスモーク」）。
- `shots`・`manual`・`perf`：それぞれ環境変数（`E2E_SHOTS`・`E2E_MANUAL`・`E2E_PERF`）があるときだけ config の projects に入れる（CI では流さない）。shots の testMatch は `'**/*.shots.ts'`（既定の testMatch は *.shots.ts に当たらないので、ほかのプロジェクトは拾わない）。manual は `e2e/manual/`、perf は `e2e/perf.spec.ts` だけを拾い、chromium・serial の testIgnore にこの2つを入れる。
- **`pnpm e2e` は Playwright を2回呼ぶ**（`scripts/e2e.mjs`。T09a）：`playwright test --project=chromium`（setup は依存で走る）の後に、結果によらず `playwright test --project=serial` を流し、どちらかが失敗していれば失敗で終わる。serial を chromium の dependencies にすると、chromium のテストが1件落ちただけで serial（通しの流れ・年度の作成）がスキップされ、T14 の受け入れの結果が CI に残らないため。レポートは回ごとに別のフォルダに出し、CI は両方を成果物に残す。
- `pnpm e2e:shots` は `E2E_SHOTS=1 playwright test --project=shots`。`--grep <チケットID>` はテストの名前で絞るので、テストの名前はチケット ID で始める（`test('T10 在庫入力（390px）', …)`。7.4）。
- **basePath のスモーク**（`e2e/basepath/smoke.spec.ts`。T14）：E2E の本体は basePath なし（`build:e2e` は `NEXT_PUBLIC_BASE_PATH=''`）で流れるので、本番の basePath（/GAapp）で壊れやすいもの（Worker が locateFile で作る wasm の URL、Worker のチャンクの URL、QR の絶対 URL、マニフェスト・アイコン、末尾のスラッシュ）を CI で一度も通さない。そこで `pnpm build:e2e -- --base-path /GAapp`（scripts/build-e2e.mjs に引数を足し、書き出しを `apps/web/out-basepath/GAapp/` に移す）で作ったものを、別のポート（3101）で `apps/web/out-basepath` を根に配り、admin で /GAapp/allocation/（振り分け中のシナリオの年度）を開いて計算エンジンの読み込みが終わり、`/GAapp/highs.wasm?v=…` のリクエストが 200 であること、/GAapp/stocks/qr/ の QR の URL が `http://localhost:3101/GAapp/stock/?room=` で始まること、マニフェストとアイコンが 200 であることを確かめる。CI では basePath つきのビルドを先に作ってから、ふつうの build:e2e を作る（+1 分ほど）。

**チケットごとの E2E**（ファイルをチケットごとに分け、ほかのチケットのファイルを触らない）

| チケット | ファイル | 確かめること |
| --- | --- | --- |
| T09a | e2e/foundation.spec.ts、e2e/errors.spec.ts | 5人のナビ（全画面が ready）、直接 URL を開いたときの権限なし（団体代表が /settings など）、年度の切り替え（シナリオの年度を選ぶと表示が変わり、同じタブの再読み込みでも残り、新しいタブでは最新の年度で開く）、見え方（団体代表は API を直接呼んでもほかの団体の申請が 0 行、未招待は全表 0 行で RPC は forbidden。7.6 の4）、エラーの分類を本物の DB の応答で（2.5） |
| T09 | e2e/t09-dashboard.spec.ts、e2e/t09-settings.spec.ts、e2e/serial/year-create.spec.ts | 状態の遷移（受付開始に締切が要る、締切、確定の conflict：2つの画面で開き、片方で在庫を変えてからもう片方で確定 → 検証のやり直しが出て、もう一度押すと確定。壊れたルールがあると確定を押せない）、団体（CSV の取り込みと checkGroupNames、表示名を空にすると null）・招待（createUser の確かめたユーザーで applied: true、確かめていないユーザーと新しいメールで applied: false）・ロール（createUser のユーザーで remove_role、最後の admin は外せない、closed でも外せる）、1日目の範囲外（2201-01-01）と複製元より前の1日目で欄にエラー、年度の作成で団体とルールが付け替わる、終了した年度から新しい年度を作れる（serial。どちらも `festivalStart: 'latest'` のシナリオの年度と grants の createUser の admin で。新しい年度の1日目は 2200 年）、場所・団体の削除の確認に、参照している有効なルールのコードが出て削除を押せない（2.7・3.2）、ダッシュボードとホームに T04 の home-roles・home-year が残る（auth.spec が通る）、終了した年度で削除を押しても「削除しました」と出ない |
| T10 | e2e/t10-stock.spec.ts | 390px で＋－と数字を入れて保存すると数えた人と日時が出る、allocating で staff は読み取り、使用不可の印、前年度（prevYear）があると前年の数と前年との差が出る、下書きから戻せる（入力 → 別のページ → 戻る）、最新でない年度で保存の前に確かめる、QR のページのカードと URL |
| T11 | e2e/t11-request.spec.ts、t11-requests.spec.ts、t11-import.spec.ts | 提出と再提出、締切後の読み取り（受付期間を SQL で過去に）、企業以外に長机(3人掛)の欄がなく、DB に長机(3人掛)があれば読み取り専用の行が出る、締切後の理由つきの修正で audit_logs に理由、休憩所の代理入力で前年の数を入れる（prevYear）、取り込み（5.2） |
| T12 | e2e/t12-rules.spec.ts | `rules: 'none'` の synthetic の年度で S01〜S08 を画面から入れ、保存した params が合成データの rules.json（id を付け替えたもの）と同じ、確定中はメモだけ直せる、削除のボタンがない |
| T13 | e2e/t13-allocation.spec.ts、t13-swaps.spec.ts、t13-my.spec.ts | 自動振り分け → error 0 → 確定 → Excel のダウンロード、計算中のロック（page.route で保存を止めて確かめる）、解けない入力（synthetic-infeasible-s05）で不足と S05 が出る、2つの画面での行の conflict、保存されたか分からないとき（page.route で save_allocation_rows を `route.fetch()` でサーバーに届けてから `route.abort()` で応答を落とす）に送り直しの前に確かめ、行が二重にならない、使用不可の部屋の固定の行（シナリオの年度に SQL で入れる）：画面に「固定を外す」が出ず、API で固定を外す update を送ると E002 で全体が拒否され、運び元の変更と削除は通る。部屋の見出しの「使用不可にする」は、固定・手動の行を先に直して保存するまで押せず、その順で使用不可にして最小変更で再実行すると precheck に E002 が出ない（3.9）、拒否 → 最小変更でその団体の置き換えが消える、未依頼に戻すは了承の行に出ない、/my の確定前・後、計算時間 2 秒以内、staff は読み取りで検証の一覧からルールへのリンクがない |
| T14 | e2e/serial/full-flow.spec.ts、e2e/t14-history.spec.ts、e2e/basepath/smoke.spec.ts、e2e/perf.spec.ts（CI では流さない） | 7.3 の通しの流れ、履歴の絞り込み、basePath のスモーク、4G での表示の速さ（7.7） |

### 7.3 SPEC の E2E 手順（T14）

SPEC の手順を、今のデータと仕様に合わせて次の形にする（差分案 6）。通しの流れで入力を変えるところ（3・4）は、**需要を増やさない**ように決める。合成データ r8like は余りが小さい（長机は使える在庫 110〔2人掛 102＋3人掛 8。第一セミナーは使用不可〕に需要 106、MER に長机(2人掛) 3）ので、取り込みや提出で需要が1〜2台増えると、5 の「error 0」や 7 の最小変更が解けなくなったり、D-08 の「補える」つながりが崩れたりする。

1. `supabase start` → `supabase db reset`（seed：品目・テスト用の場所・R8 の年度・テストユーザー。R8 の本データは入らない。D-40 で合成データ r8like で代用する）。
2. `pnpm build:e2e` → `pnpm e2e`（CI と同じ）。手で確かめるときは `pnpm dev` で同じ順に操作する。
3. 通しのテストは、合成データ（fixtures/synthetic/r8like。fixtures/r8 が入ったらそちら）で受付中のシナリオの年度を作る（`roles: { admin: true, staff: true }`、`repGroup: <団体A>`）。管理者で開き、在庫一覧で在庫が入っていること（第一セミナーは使用不可）を確かめ、部員（390px）で1部屋（1-1）を**同じ数のまま**数え直して保存する（数えた人と日時が変わることを確かめる。在庫は変えない）。
4. 団体代表で団体 A の申請を開き、**今の数のまま**再提出する（提出日時が変わる。需要は変えない）。管理者が申請一覧で、通しの流れ専用の CSV `e2e/fixtures/full-flow-stall.csv`（T14 が作る。模擬店のフォームの形。メールは予約ドメインだけで個人情報なし）を取り込む。中身：
   - 団体 B・C（r8like の模擬店のうち、ルール S05・S06・S08 と了承の行のない団体。T14 が選んで notes/T14.md に書く）の回答。数はどの品目もその団体の今の申請以下（少なくとも1品目は減らす）、タイムスタンプは 2026-10-0x（r8like の提出日時 2026-07-01 より新しいので、Q2 の既定で上書きされる）。
   - マスタにない名前（「模擬店B（旧）」の形）で、団体 B の回答より新しい行を1つ。対応しない行として出るので、手で団体 B に対応させる（B の回答はこちらになる。数は同じく B の今の申請以下）。
   - 団体 C の古い回答を1つ（古い回答として出る）。
   - 団体 A は CSV に入れない（団体代表の提出を上書きしない）。
   需要は増えないので、5・7 は合成データのまま解ける。この入力（3・4 の後の YearData）で、allocate の full が ok、`checkMinimalChange(input, MER)` が ok で、補えるつながりで「前回の M 以外の行が減ったもの・無関係な行が変わったもの・M の行を含まないつながりの変化」が 0 であることを、**E2E より先に Vitest**（e2e/full-flow/data.test.ts。e2e-support のプロジェクト）で確かめておく（データの選び方の誤りを E2E の失敗と取り違えないため）。
5. ダッシュボードで「締切」→ 振り分け画面で「自動振り分け」（計算 2 秒以内）→ 検証パネルの error が0件 → 「確定」（理由。warning があれば確認のチェック）。
6. 「Excel出力」でダウンロードした xlsx を、packages/exporter/tools/recalc.py（LibreOffice の headless）で再計算し、数式エラーと「在庫超過」「要確認」が0件であることを確かめる。
7. 「確定を解除」→ そのときの DB から AllocateInput を組み立てて控える（MER は使用可。組み立ては apps/web/lib/data/year-data.ts と同じ関数。errors.ts と同じく相対の import だけにして E2E から読む）→ 振り分け画面の部屋の見出しで MER の「今年は使用不可にする」を押す（3.9 の「使用不可にする順番」。5 の行は save_auto_allocations の自動の行で固定がなく、シナリオの了承の行は SQL で入れていて行を固定しないので、MER からの固定・手動の行の一覧は空のはず。空でなければテストを止めて行を出す）→ 使用不可にする →「最小変更で再実行」。確かめ方は D-08 の判定と同じにする：控えた入力で `checkMinimalChange(input, MER の id, getHighs())`（`@gaapp/allocator/testing`。1.8）を Node で流し、(a) その before が 5 で保存した自動の行と同じ（sumByKey が一致）、(b) その after が画面の最小変更で保存された自動の行と同じ（allocate は決定的なので、同じ入力なら同じ結果）、(c) 判定の decreased・unrelatedChanged・untouchedChanged が空であることを確かめる。補えないつながりの変わった行の数（changedInBad）・増えた行・新しい行・補える／補えないつながりの数は、テストの出力（testInfo の annotations）と notes/T14.md に記録する。補えるつながりがどれかはデータで決まる（T06 の記録：r8like で MER を使用不可にすると、補えるつながり 3・補えない 1〔机(木)の系列〕）ので、「椅子(木)・椅子(青)・長机は変わらない」と品目で決め打ちしない。
8. 年度の作成と複製は別のテスト（T09 の serial）で確かめる（通しの流れで作ると在庫が複製されず、3 が成り立たないため）。

### 7.4 スクリーンショット

- `e2e/support/shots.ts`（T09a）の `shoot(page, ticket, name)` が `notes/<チケット>/<name>.png` に保存する。PC は 1280×800、スマホは 390×844。
- 各チケットは `e2e/shots/<チケット>.shots.ts` を書き、`pnpm e2e:shots --grep <チケット>` で撮る（CI では流さない。shots のプロジェクトは `E2E_SHOTS=1` のときだけ config に入る）。テストの名前はチケット ID で始める（`--grep` はファイル名ではなくテストの名前で絞るため）。撮るもの：各画面の PC（スマホの画面はスマホも）、読み込み中・空・権限なし、主なダイアログ、振り分けの ok: false のパネル、ロックのオーバーレイ、確定後。読み込み中とロックのオーバーレイは、`page.route` で応答を止めてから撮る（7.2）。
- T04 のように一時的な画面を作って撮ったときは、撮った後に消す。

### 7.5 CI の時間

| ジョブ | 今 | 画面を足した後の見込み | 対策 |
| --- | --- | --- | --- |
| check（lint・typecheck・test・build） | 数分 | +1 分（部品のテスト、ページが増えた build） | ページはクライアントだけなので build は大きく延びない |
| db（pgTAP） | 変わらない | 変わらない | — |
| e2e | 起動 1〜2 分＋build 1 分＋Playwright の取得 1 分＋テスト | テスト 3〜4 分（workers 2、storageState でログインを省く）＋basePath つきのビルドとスモーク 1〜2 分（T14）＋LibreOffice の取得 1〜2 分（T14） | timeout-minutes を 25 にする。LibreOffice は通しの流れの xlsx の再計算のためだけに入れる（T08 の recalc ジョブは exporter に変更があるときだけ動くので、画面の変更では動かない）。shots と perf は CI で流さない |
| recalc（T08） | 条件つき | 変わらない | — |

### 7.6 画面の受け入れ（総務で確認。手で確かめる。T14）

05 の「画面の受け入れ（総務で確認）」の4項目は、自動のテストだけでは確かめきれない（人がスマホで操作する時間、説明なしで使えるか）。T14 で次のとおり確かめ、notes/T14.md に記録する。

- **環境**：総務の PC で `supabase start` → `supabase db reset` → `pnpm build:e2e -- --supabase-url http://<PC の LAN の IP>:54321`（T14 が scripts/build-e2e.mjs に引数を足す。今の build-e2e.mjs は localSupabaseEnv() で URL を 127.0.0.1 に上書きするため）→ `apps/web/out` を LAN に配る（`serve -l tcp://0.0.0.0:3100 apps/web/out`）。同じ Wi-Fi のスマホから `http://<PC の IP>:3100/` を開き、テスト用ログインで入る（Google ログインは使わない。本番のデータに触れない）。手順の細部（ファイアウォール、IP の調べ方）は notes/T14.md に書く。
- **データ**：`E2E_MANUAL=1 pnpm exec playwright test --project=manual`（`keep: true` のシナリオの年度を作るだけのスクリプト。CI では流さない）で、合成データ（fixtures/r8 が入ればそちら）の年度を作り、確かめる人ごとに createUser のユーザー（団体代表・部員・管理者）を作って、ログインの情報を画面に出す（パスワードはローカル専用）。
- **記録の欄**（notes/T14.md の表）：日付、端末（機種・OS・ブラウザ）、ビルド（コミット）、データ（合成データ／R8）、確かめた人（役割だけ。名前は書かない）、計った区間、結果（秒・できたか）、詰まった所。

| 05 の項目 | 確かめ方 | 合格 |
| --- | --- | --- |
| 部員がスマホで1部屋の在庫を1分以内で入力できる | 印刷した QR のカード（/stocks/qr）を部屋に見立てて3枚。ログイン済みのスマホで、カメラで QR を読んでから「保存しました」が出るまでを計る（9品目すべてを数えた数に直す）。3部屋とも記録する | 3部屋とも 60 秒以内 |
| 団体代表が説明なしで申請を提出できる（総務以外の2人以上で試す） | 総務以外の2人以上に、団体代表のユーザーと「団体の申請の紙」（品目と数）だけを渡し、説明なしで /request から提出してもらう。手を貸したか、迷った所、かかった時間を記録する | 2人以上が手を貸さずに提出できる |
| 管理者が第一セミナーを使用不可にして最小変更で再実行し、出力までを5分以内で終えられる | シナリオの年度は `usable: { 第一セミナー: true }` で作り、管理者が先に自動振り分けをして確定しておく。計る区間は、ダッシュボードで「確定を解除」を押してから、振り分け画面の部屋の見出しで第一セミナーの「今年は使用不可にする」を押し、出てきた一覧の固定・手動の行（了承で固定した行など）を先に直して（固定の自動の行は「固定を外す」、手動の行は「運び元を変える」か「削除」）理由をつけて保存し、それから使用不可にして（3.9 の「使用不可にする順番」）、「最小変更で再実行」→ error 0 を確かめ →「確定」→「Excel出力」のファイルが保存されるまで。一覧の行を直す時間も区間に含める。手での確かめの年度では、少なくとも1回は第一セミナーに了承で固定した行がある状態で計る（manual のスクリプトで、了承の行と、第一セミナーからの固定の置き換えの行を入れておく） | 5 分以内 |
| 団体代表は他の団体の申請を見られない。招待されていない人は何も見られない（API を直接呼んでも） | 自動：pgTAP の 011_rls_matrix（T03 で済み）と、e2e/foundation.spec.ts（T09a。団体代表の API の直接の呼び出しでほかの団体の requests・request_submissions・allocations が 0 行、未招待は全表 0 行・RPC は forbidden、画面は権限なし）。手では、団体代表のユーザーで /requests を開いて権限なしになること、/request?group=<ほかの団体の id> が自団体に戻ることを見る | 自動のテストが通り、手で見ても漏れない |

- 満たせなかった項目は、T14 の出力の「受け入れ基準で満たせなかった項目」に、記録と直す案を添えて書く（05 のチェックボックスは埋めない）。

### 7.7 4G での表示の速さ（00「性能と可用性」。T14）

- 00 の「画面はスマホの 4G でも 2 秒以内に開く」を、スマホで使う3画面（/stock?room=…、/request、/my）で確かめる。`e2e/perf.spec.ts`（`pnpm e2e:perf`。CI では流さない。CI の機械の速さで結果がぶれるため）：Chromium の CDP で回線を T00 と同じ Fast 4G 相当（下り 9 Mbps・遅延 170 ms）に絞り、CPU を 4 倍遅くして、キャッシュなしの新しいコンテキスト（storageState でログイン済み）で `page.goto` から画面の主な内容（場所名と最初の品目の入力欄、団体名と提出のボタンなど）が見えるまでを3回計り、中央値を notes/T14.md に記録する。2 秒を超えたら原因（JS の量・読む表の数・Supabase の往復）を調べて直すか、満たせなかった項目に書く。
- **最初に読む JS の量**：`scripts/first-load-js.mjs`（T09a）が、書き出した out/ の各ページの HTML が読む script の gzip の大きさの合計を表にする。T09a は雛形の時点の値を notes/T09a.md に記録し、T14 は /stock・/request・/my がその 1.5 倍以内であること、ExcelJS（exporter）と highs のチャンクがこの3画面の最初の読み込みに入っていないことを確かめる。
- 振り分けの計算の「2 秒以内」（D-21）は別に、result.elapsedMs で確かめる（4.3）。

## 8. チケットの分担と順番

### 8.1 T09a（画面の共通基盤）を足す

T09〜T13 は同じ部品（表・ダイアログ・理由の入力・エラーの文言・スナップショット・確定の流れ）と、同じファイル（lib/navigation.ts、app/layout.tsx、apps/web/package.json、pnpm-lock.yaml、playwright.config.ts、e2e/support）を使う。どれかのチケットに入れると、並行する他のチケットが同じファイルを作るか、待つことになる。そこで新しいチケット T09a に分け、T09〜T13 の前にマージする（K-17 と P-03 の続き。1チケット＝1ブランチ＝1PR は守る）。

**T09a の範囲**（見積もり M、opus・high、計画モード）

1. UI 部品（1.4。shadcn/ui の手置き）と共通の部品（components/common/。AppLink・下書き・送信中の決まりを含む）。
2. app/layout.tsx に QueryClientProvider・Toaster。ログアウトを `signOut({ scope: 'local' })` にし、手動のログアウト・強制の signOut・利用者の切り替えで消すものを分ける（1.3 の (a)〜(c)。手動は未保存の入力を確かめてから下書きを消し、強制では下書きを残す）。**立場の読み直しを裏で行う**（AuthProvider は同じ user_id の reloadMembership で 'loading' に戻さず、前の membership を ready のまま出して isRefreshing を足す。AppShell が LoadingState・ErrorState でページを置き換えるのは初回の読み込みと user_id が変わったときだけ。1.3）。Vitest で「reloadMembership の間に子が外れない」。
3. 年度の切り替え（1.3.1。sessionStorage。membership・AuthProvider・AppShell。`current-year` の testid は保つ。切り替えは `useGuardedSetYear()` で未保存の入力を確かめる）と最新でない年度の帯、書き込む画面で使う「最新の年度に切り替える」の部品、印刷で隠す class。
4. 全画面の雛形のページ（1.1）とナビの `ready: true`・`audiencesFor`・`canOpen`・`useGuardedRouter`、ログインの画面のアプリ内ブラウザの案内（1.3）。e2e/auth.spec.ts の期待値を合わせる。
5. データの層（1.5。fetchAll・updateWithLock・deleteChecked・callRpc と payload の zod・errors・drafts・year・snapshot・year-data〔createContext で参照を確かめ、参照の切れたルールを problems に入れる。2.7〕・room-years〔setRoomUsable と fixedRowsFrom。3.9〕・validation・version-watch・datetime・labels・download・csv-file・query・schemas/common の optionalText）と、共通で使う純粋関数（swapRows、downloadAllocationXlsx）と YearStatusActions（確定の流れ。problems があれば確定できない）。errors.ts と year-data.ts は E2E からも読むので相対の import だけにする。
6. T09〜T14 の依存をまとめて追加（1.8。ルートの devDependencies の @gaapp/shared・@gaapp/allocator と、allocator の exports の `./testing` を含む）、copy-highs-wasm.mjs と predev・prebuild、.gitignore（apps/web/public/highs.wasm・e2e/.auth・e2e/.cache・apps/web/out-basepath）、ESLint の規則（useRouter の直接の push・replace の禁止を足す）、scripts/first-load-js.mjs。
7. テストの土台：Vitest の jsdom と e2e-support のプロジェクト、e2e/setup（db-setup・auth-setup）、e2e/support（db・datasets・auth・year・shots）、playwright.config.ts のプロジェクト（7.2）、scripts/e2e.mjs（chromium と serial を別に流す）、scripts/local-supabase-env.mjs に DB_URL、`pnpm e2e:shots`。
8. 共通部分の Vitest、e2e/foundation.spec.ts・e2e/errors.spec.ts、スクリーンショット（雛形・年度の切り替え・3状態・エラーの帯）、最初に読む JS の量の記録（7.7）。
9. 決定事項の案（D-31〜D-38）を notes/decisions.md に「提案」として入れる（T09a は T09〜T13 より先にマージするので、decisions.md と 05 のチケット表の T09a の行はこの PR で直してよい。D-32）。
10. この設計書を notes/T09a-design/ui-design.md としてコミットし（T06 の notes/T06-design/ と同じ扱い）、差分案 spec-changes-ui.md の「当てるチケット」が T09a のもの（00・04 の共通の節・05・CLAUDE.md・docs/prompts・decisions.md）を当てる。各画面の節（04 の 3-4〜3-15、03 の 2-1、SPEC の 6-1）は、その画面のチケットが当てる。

前提：T04（T03 の今の先頭〔bd6aef0。c96155d・bd42552・f7b1b01 を含む〕の上に積み直してマージ済み。supabase/types の生成し直しを含む）、T05（importer の parseCsvLoose・parseFormCsv・resolveResponses。T09 の団体の CSV と T11 が使う）、T07（shared の型と validate。T06 を含む）、T08（exporter の exportAllocationXlsx・allocationXlsxFileName・exportYearJson・YearExport。T09a の downloadAllocationXlsx と T09 の書き出しが使う）。今の main の packages/exporter・importer は PACKAGE_NAME だけの空の部品なので、T05・T08 より先に T09a を始めると、実装も型チェックも通らない。後のチケットは package.json を触らない決まり（D-32）なので、後から補う道もない。T09a は DB を変えない（migrations・seed・pgTAP に触れない）。

### 8.2 各チケットが持つファイル

| チケット | 持つファイル（作る・中身を書く） | 使うだけ |
| --- | --- | --- |
| T09a | 8.1 のすべて | — |
| T09 | app/(app)/page.tsx（T04 のホームを置き換える。`data-testid="home-roles"`・`home-year` の要素と文字は保つ。3.1 の「立場の一覧」。e2e/auth.spec.ts は T09a が持ち、T09 は触らない）、app/(app)/settings/page.tsx、components/dashboard/・settings/、lib/data/dashboard.ts・settings.ts（rulesReferencing を含む）・year-export.ts、lib/schemas/settings.ts、e2e/t09-*.spec.ts・e2e/serial/year-create.spec.ts、e2e/shots/T09.shots.ts、notes/T09.md・notes/T09/ | T09a の部品・データの層・YearStatusActions・downloadAllocationXlsx |
| T10 | app/(app)/stock/・stocks/・stocks/qr/、components/stock/、lib/data/stocks.ts、lib/schemas/stock.ts、e2e/t10-*、shots、notes/T10 | 同上 |
| T11 | app/(app)/request/・requests/、components/requests/（取り込みを含む）、lib/data/requests.ts・import.ts、lib/schemas/requests.ts、e2e/t11-*、shots、notes/T11 | 同上と importer |
| T12 | app/(app)/rules/、components/rules/、lib/data/rules.ts（describeRule を含む）、e2e/t12-*、shots、notes/T12 | 同上と shared の ruleRowSchema・checkRuleRefs |
| T13 | app/(app)/allocation/・swaps/・my/、components/allocation/・swaps/・my/、lib/allocation/（engine・issue-target・pending〔allowedRowOps を含む〕・tabs・group-view）、lib/data/allocation.ts・my.ts、workers/allocate.worker.ts、e2e/t13-*、shots、notes/T13 | 同上と allocator・exporter |
| T14 | app/(app)/history/、components/history/、lib/data/history.ts、e2e/serial/full-flow.spec.ts・e2e/full-flow/・e2e/fixtures/full-flow-stall.csv・e2e/t14-*・e2e/basepath/・e2e/perf.spec.ts・e2e/manual/、scripts/build-e2e.mjs の basePath の引数、playwright.config.ts の basepath・manual・perf のプロジェクト（T09a が置いた枠に足す）、README.md（・docs/runbook.md。本番の Auth で必ず守る設定〔D-17a〕へのリンクと、7月の再開で確かめる手順）、PWA のマニフェストとアイコン（D-38。app/manifest.ts・app/icon.png・app/apple-icon.png）、ci.yml の e2e ジョブ（basePath のビルド・LibreOffice・timeout）、05 の受け入れ基準のチェック（7.6・7.7 の記録） | すべて |

- docs/requirements の 04 は、各チケットが自分の画面の節だけを直す（違う節なので衝突しにくい）。05 のチケット表の「状態」の列と notes/decisions.md は、並行するブランチで隣り合う行を変えて衝突するので、各チケットの PR では触らず、新しい決定は notes/<チケット>.md に書く。T14 のマージの後にまとめて反映する（T14 の依頼文に書いた。D-32）。
- T09a の部品に足りないものが見つかったら、そのチケットの中で components/<画面>/ に置き、2つ目の画面が要るときに common/ へ移す（移すのは後のチケット）。

### 8.3 順番と並行

```
T04 ─┐
T05 ─┤
T07 ─┼─ T09a ─┬─ T09（設定・ダッシュボード）──────────┐
T08 ─┘        ├─ T10（在庫）                           │
              ├─ T11（申請・取り込み）                  ├─ T14（履歴・通しの E2E・README）
              ├─ T12（ルール）                          │
              └─ T13（振り分け・交換・自団体）          ┘
```

- T09a は T04・T05・T07・T08 がすべてマージされてから始める（T06 は T07 に含まれる）。T09a の前提がそろえば、T09〜T13 の前提（T05・T07・T08 の関数と型）も T09a を通してそろう。
- T09a の後は T09〜T13 を並行に進められる（それぞれが自分のディレクトリだけを持つ）。2人なら「T09・T10・T12」と「T11・T13」、3人なら「T09・T12」「T10・T11」「T13」。
- いちばん長い道は T09a（M）→ T13（L）→ T14（M）。T13 を最初に始める。
- T14 は T09〜T13 がすべてマージされてから始める。

### 8.4 依頼文（docs/prompts）の直すところ

差分案 7 に全文を書いた。要点：T09a.md を新しく作る。T09.md は共通のレイアウト・今の年度（T09a で決めた）と依存を外し、ダッシュボードの確定の流れ・設定の各タブ・書き出しを足す。T10〜T13 は「T09a の部品とデータの層を使う」「自分のディレクトリだけを触る」「E2E はシナリオの年度で」を足し、画面ごとの要点（T10：保存のしかたと QR、T11：取り込みの保存と提出日時、T12：ruleRowSchema・checkRuleRefs とひな形、T13：Worker・未保存の変更・版の扱い・読み取りの立場）を足す。T14 は通しの流れの手順（7.3）、画面の受け入れと 4G の確かめ方（7.6・7.7）、basePath のスモーク、CI の LibreOffice、PWA のマニフェスト、README の本番の Auth の設定を足す。T09〜T14 の完了基準の「seed の年度とテストユーザーのロールを変えない」は、「seed の R8 の年度のロールと未招待のユーザーは変えない（シナリオの年度にだけロールを付けてよい）」に直す（D-36）。README の順番の表に T09a を入れ、T13 のモデルを opus・high にする（並行の扱いと版の扱いが多い）。

## 9. ユーザーに確認すること（本文は推奨案で書いた）

| # | 内容 | 推奨 | 他の案 |
| --- | --- | --- | --- |
| Q1 | 振り分け表（/allocation）を、管理者のほかに誰に見せるか。00 のロールの表は「staff：振り分けの閲覧」「viewer：確定後の振り分け表の閲覧」、画面一覧は「振り分け：管理者」で食い違っている。RLS は staff にいつでも、viewer に確定後だけ allocations を読ませている | staff は読み取り専用でいつでも（在庫・余り・検証つき。Excel 出力も）。viewer は確定後だけ行の一覧（在庫・余り・検証・Excel なし。RLS で在庫と申請を読めないため） | admin だけ（画面一覧のとおり。staff・viewer には Excel を渡す）／staff だけ足す |
| Q2 | Googleフォームの回答の取り込みで、アプリですでに提出している団体を上書きするか | 取り込みのプレビューで団体ごとに DB と CSV を並べ、既定は「CSV のタイムスタンプが DB の提出日時より新しい団体だけ上書き」。管理者が団体ごとに選び直せる | いつも CSV で上書き／アプリで提出済みの団体は取り込まない |
| Q3 | 確定前（振り分け中）に Excel を出してよいか | 出せる。ただしファイル名を `{年度}_椅子机振り分け_部門員共有用_確定前.xlsx` にし、出す前に「確定前の振り分けです」と確かめる（共有用と取り違えないため。03 のファイル名に注記を足す） | 確定後だけ出せる／確定前もファイル名を変えない |
| Q4 | 団体代表が、キャスター机の交換に答えた後で回答を変えられるか（RPC は確定まで了承・拒否を何度でも記録できる） | 確定まで「回答を変える」を出す。変えたら総務の /swaps とダッシュボードに出る（拒否なら最小変更での再実行が要る） | 一度答えたら変えられない（変えるときは総務に連絡し、総務が記録する） |

## 10. 実験の記録（ui-lab）

場所：scratchpad/ui-lab/repo（T04 に T07・T08・T05 のブランチをマージした clone。リポジトリは変えていない）。

| 確かめたこと | 結果 |
| --- | --- |
| ブランチのマージ | docs・notes・package.json・packages/shared/src/index.ts・index.test.ts・pnpm-lock.yaml・ci.yml・README.md がぶつかった。コードは両方を残せば通る（shared の index.ts は database.types の export と model などの export を並べる。index.test.ts は PACKAGE_NAME の import が重なるので1つにする）。`pnpm typecheck` が通った |
| Worker（`new Worker(new URL('../../workers/allocate.worker.ts', import.meta.url))`）から `@gaapp/allocator`・`@gaapp/shared`（zod を含む）・highs を import し、静的書き出し（basePath=/GAapp、Turbopack）で動くか | 動いた。Worker と highs のチャンク（99 KB）は別に分かれた |
| wasm の場所 | locateFile の `/GAapp/highs.wasm?v=1.15.4` だけを取得した。out には public の分と `_next/static/media/highs.<hash>.wasm` の2つが入る |
| wasm のコピー | `require.resolve('highs/package.json')` は ERR_PACKAGE_PATH_NOT_EXPORTED。`require.resolve('highs/runtime')` で build/highs.wasm を引けた |
| 合成データ r8like の allocate（Chromium headless、localhost） | 読み込み 208 ms（warmup 284 ms）、allocate 284 ms（初回）、往復 286 ms、266 行、ok |
| validate（主スレッド） | 34 ms。W102・W103・W105・I201 だけ（error 0） |
| Excel（`await import('@gaapp/exporter')`） | ExcelJS のチャンク（941 KB）は別に分かれ、取得 161 ms、作成 77 ms、36 KB。ダウンロードした xlsx を tools/recalc.py で再計算して、数式エラー 0・「在庫超過」「要確認」0 |
| next dev（Turbopack）での同じ流れ | 動いた（predev のコピーが要る） |
| wasm が 404 のとき | loadHighs が `RuntimeError: Aborted(CompileError: … expected magic word …)` で reject し、Worker から load-error が返った。ファイルを戻して同じ Worker で warmup すると 182 ms で読めた |
| useSearchParams を Suspense なしで使う | `next build` が失敗した（missing-suspense-with-csr-bailout）。Suspense で包むと動き、クエリを読めた |
| 描画中に location を読む | プリレンダーで `ReferenceError: location is not defined`。useEffect に移すと動いた |
| radix-ui 1.8.1 の Dialog、react-hook-form 7.90.0＋@hookform/resolvers 5.9.2＋zod 4.6.7、sonner 2.0.8、@tanstack/react-query 5.104.5、@tanstack/react-table 8.21.3、uqr 0.1.3 | どれも静的書き出しで動いた（理由が空なら「理由を入力してください」、入れると toast） |
| Vitest 5.0.5＋jsdom 30.1.3＋@testing-library/react 16.3.3＋user-event 14.6.8 | `// @vitest-environment jsdom` のファイルで、＋－と数字の入力のテストが通った |
| zod の `z.iso.datetime({ offset: true })` と PostgREST の日時 | `2026-10-29T03:00:00.123456+00:00` を受け付けた（toYearData で submitted_at をそのまま渡せる） |
| shadcn/ui のソース | ui.shadcn.com は 403、raw.githubusercontent.com は 200。v4 の new-york は `radix-ui` をまとめて import する |
| アイコンとマニフェストの basePath（改訂で追加） | `app/icon.png`・`app/apple-icon.png`（ファイルの規約）と `app/manifest.ts`（force-static）を置き、NEXT_PUBLIC_BASE_PATH=/GAapp で next build した。out/index.html は `<link rel="icon" href="/GAapp/icon.png?…">`・`<link rel="apple-touch-icon" href="/GAapp/apple-icon.png?…">`・`<link rel="manifest" href="/GAapp/manifest.webmanifest">` で basePath が付いた。マニフェストの JSON の中（start_url・scope・icons の src）は書いた文字列のままなので、BASE_PATH を自分で付ける（批評の実験では metadata.icons に文字列で書くと basePath が付かなかった）。試したファイルは消した |

**批評の実験で確かめられたこと**（この設計の判断の根拠に使った。ui-lab の別の clone で、ポートを 58xxx にずらした Supabase と、一時のコンテナの PostgREST で行われた）：
- rooms・distance_overrides に新しい行を入れると、振り分け中のすべての年度の allocation_version が上がる（0→1→2）。on conflict do nothing で 0 行なら上がらない（7.2）。
- 同じ人の2つのセッションの片方で /auth/v1/logout（既定の global）を呼ぶと、もう片方の /auth/v1/user は 403 session_not_found、refresh は 400 refresh_token_not_found（REST は通る）（1.3・7.2）。
- PostgREST v16.5 は期限切れの JWT に `401 {"code":"PGRST303","message":"JWT expired"}`、署名違いに `401 {"code":"PGRST301"}` を返す（2.5）。
- App Router で beforeunload を登録しても、`page.goBack()` は確認なしで戻る。next/link の `onNavigate` で `preventDefault()` すると移動が止まる（1.4）。

試していないこと：Supabase に対する画面の動き（RLS・RPC は T03・T04 の PostgREST の確認と、上の批評の実験に従う）、回線を絞った読み込み（T00 の測定に従う。T14 で 7.7 のとおり測る）、GitHub Pages の 404 のキャッシュ（`&r=` で避ける）、iOS・Android の実機（ホーム画面に追加したときのログイン。D-38）、LINE などのアプリ内ブラウザでの Google のログイン（Google の方針からの推定。3.4）。

## 11. 決定事項の案（notes/decisions.md に足す。番号は D-31 から）

- **D-31 今の年度と年度の切り替え（K-19）**：既定は「ロールか団体代表のある年度のうち1日目が最も遅いもの」。年度が2つ以上ある人はヘッダーで切り替え、選んだ年度は sessionStorage（タブごと）に覚える（新しいタブ・QR から開いたときは最新の年度）。年度は URL に入れない。最新でない年度は帯で知らせ、在庫入力・申請・了承の回答では「最新の年度に切り替える」を大きく出し、保存の前に確かめる。チケット：T09a。
- **D-32 画面の共通基盤のチケット T09a**：8.1 の範囲を T09〜T13 の前に入れる。前提は T04・T05・T07・T08（exporter・importer・validate の関数と型を使う）。依存の追加・ナビ・雛形のページ・テストの土台も T09a。各チケットは自分のディレクトリだけを持ち、05 の状態の列と decisions.md はマージの後にまとめて直す。チケット：T09a〜T14。
- **D-33 データの読み書きの層**：TanStack Query、版を先に読むスナップショット（ダッシュボード・振り分け・交換）、直接の更新と削除は結果の行を受け取る（更新は updated_at つき。0 行なら読み直して conflict・not_found・権限を分ける。RLS で拒否された削除も 0 行で成功するため）、エラーの分類と日本語は lib/errors.ts の1か所（PGRST301〜303・401 はセッションを確かめてから /login へ）、版の見張りは知らせるだけで自動で読み直さない。書き込みのボタンは送信中は押せず、通信の失敗の後は保存されたかを読み直してから送り直す。未保存の入力は、アプリの中の移動と年度の切り替えの確認（AppLink・useGuardedRouter・useGuardedSetYear）と下書き（localStorage）で守る（戻るボタンは止められないため）。下書きは、手動のログアウト（未保存の入力があれば確かめてから）でその人の分を消し、401 などでの強制の signOut では消さず、別の user_id でログインしたときに他人の分を消す。立場の読み直し（forbidden・state・確定の後）は裏で行い、画面を外さない（初回と利用者の切り替えのときだけ読み込み中に置き換える）。任意の文字列は空なら null にする。toYearData は createContext で参照を確かめ、参照の切れたルールを外して problems（ruleCode つき）に入れる（確定も止まる）。団体・場所の削除の確認で、参照している有効なルールを出して止める。チケット：T09a（削除の確認は T09）。
- **D-34 振り分けの Worker と手での編集**：Worker は1つだけ作って使い回し、admin で振り分け中のときだけ画面を開いたら読み込む。読み込みの失敗は覚えず、読み直しの URL に回数を付ける。wasm は `highs/runtime` から public にコピーする。validate と Excel は主スレッド。自動振り分けの「中止」は計算と読み直しの段階だけで、保存を送った後は中止しない。手での編集は未保存の変更として溜め、理由をつけて1回で保存する（備考だけの変更も手動の行になる。数は 1 以上）。保存されたか分からないときは版で確かめ、進んでいれば突き合わせてから送り直す（insert の二重を防ぐ）。使用不可の部屋の行には、運び元の変更と削除だけを出す（save_allocation_rows は使用不可の部屋の行の update を、固定だけでも E002 で拒否するため）。部屋を使用不可にするときは、先にその部屋からの固定・手動の行を一覧にして直して保存してもらい、その後で使用不可にする（precheck の E002 には「固定を外す」を出さない）。チケット：T13（コピーは T09a）。
- **D-35 CSV 取り込みの保存**：取り込みは締切の前後によらず update_requests_after_deadline（提出日時を残す）で団体ごとに送り、CSV にない品目は 0、申請できない品目は送らない。上書きの既定は Q2 の答えで決める。チケット：T11。
- **D-36 E2E のデータ**：E2E はローカルの DB に pg でつなぐ（DB_URL がローカルでなければ止める。アプリとビルドには入らない）。年度をまたぐ表（全データセットの場所と距離の上書き）は、並行のテストより前の setup で1回だけ名前で入れ、属性が違えば止める。テストごとのシナリオの年度は年度の表だけに書き、データセットにない場所はその年度で使用不可にする。seed の admin・staff・viewer・rep には、シナリオの年度にだけロール・団体代表を付けてよい（R8 の年度のロールと未招待の outsider は変えない。ロール・招待を変えるテストは使い捨てのユーザー）。開く年度は sessionStorage で固定する。`pnpm e2e` は並行のテストと serial（年度の作成・年度をまたぐ表の変更・通しの流れ）を別に流し、片方が落ちてももう片方を流す。年度の作成は、1日目を seed の R8 より後（2199 年台。新しい年度は 2200 年）にしたシナリオの年度から、createUser の admin で行う（create_year_from の not_latest は全年度で最新かを見るため。seed の R8 からは作らない）。serial で年度をまたぐ表を変えるテストは、テスト専用の名前の行だけを作って変え、最後に消す（データセットと seed の行は変えない）。db-setup は前の実行の残り物（E2E- の年度、テスト用の行、e2e- のユーザー）を先に消す。アプリのログアウトは local。チケット：T09a・T14。
- **D-37 画面のライブラリ**：1.8 の表の版（exact、7日）。TanStack Table は v8、@hookform/resolvers は 5 系。shadcn/ui は GitHub の raw からコミットを決めて手で置く。ExcelJS（exporter）は動的 import。チケット：T09a。
- **D-38 PWA（K-20）**：フェーズ1はホーム画面に追加できるマニフェストとアイコンだけ。`display: "browser"`（ホーム画面から Safari・Chrome で開く）にする。standalone は、iOS のホーム画面のアプリが Safari と別の保存場所を持ち、Google の OAuth（PKCE。code_verifier は localStorage）の行き来でセッションが残らないおそれがあるので、iOS Safari と Android Chrome の実機で「standalone で Google ログイン → /auth/callback/ → セッションが残る」を確かめられたときだけ切り替える（確かめた端末を notes に残す）。アイコンは Next のファイルの規約（app/icon.png・app/apple-icon.png）で置き、マニフェストの JSON の start_url・scope・icons には basePath を付ける。Service Worker は入れない（デプロイの後に古いチャンク・wasm を返す危険があるため。オフラインの運搬リストが要るフェーズ2で検討）。チケット：T14。
- **D-42 の案 絶対値の書き込みの通信の失敗の扱い**（T09a の notes に書いた案。notes/decisions.md へは T14 がまとめて入れる）：2.6 の (A)・(B1)・(B2)。

## 付録 A：04 の画面仕様との対応

| 04 の項目 | この設計 |
| --- | --- |
| 前書き（静的書き出し、クエリ、shadcn/ui・TanStack Table、3状態、未招待） | 1.1・1.4・1.9・3 の冒頭。未招待は T04 |
| 共通レイアウト（戻り先、accept_my_invitations、今の年度、未招待、ヘッダー、ナビ、3状態） | T04 のまま＋1.3（年度の切り替え、最新でない帯、印刷） |
| ログイン | T04 のまま＋アプリ内ブラウザの案内（1.3） |
| ダッシュボード：状態、提出数、在庫の数、検証の件数、了承の状況、状態の遷移（理由、必須）、確定の版、受付開始の前提 | 3.1 |
| 在庫入力：場所名・前回・品目の行（数・前年）、＋－と数字・保存（DB が数えた人）、一覧か QR、allocating 以降の部員は読み取り、管理者の数え直しと検証、確定中は合計より少なくできない、終了は読み取り、使用不可の表示 | 3.3 |
| 在庫一覧：表、前年との差、まだ数えていない場所、QR の印刷 | 3.4・6 |
| 申請：団体名・使用場所・締切・区分の品目だけ（初期値0）・備考（数に影響しない）、submit_requests、締切前の修正、E006、上限、締切後の読み取り（変更は総務へ）、団体の切り替え | 3.5 |
| 申請一覧：表・区分の絞り込み・未提出・備考の印、セルの編集（締切後は理由と RPC）、代理入力、取り込み | 3.6・5 |
| 振り分け：上部のボタンと状態と最終実行、品目タブ（R8 の並び）と運び元ごとの表と余り、検証（並びとクリック）、品目別・団体別（需要と差）、版を先に読む、行の操作（manual の規則、RPC、読み直し、allocation_version_before）、自動振り分け（確認、Worker、ロック、ok: false の reason ごとの出し方、版、他の人の変更）、E006 を除いた知らせ、確定（error 0、理由、版）、確定後は編集不可、確定の解除（理由） | 3.9・4 |
| キャスター机交換：台数と状況、依頼済みの台数、依頼し直し、W102、了承で固定、拒否と再実行、交換依頼一覧 | 3.10 |
| 自団体：確定前の表示と了承の回答、確定後の数と運び元、代替の表示、フェーズ2 | 3.11 |
| マスタ設定：年度の作成（最新・作った人が admin）、受付期間、場所・品目・団体（CSV）、距離、ユーザー（招待・ロール・外す・取り消し・団体代表を外す、closed の扱い）、書き出し | 3.2 |
| ルール：種別ごとのフォーム、有効・無効、メモ | 3.8 |
| 履歴：表・団体・日時で絞る、管理者のみ | 3.12 |
| CSV取り込み：3種類、模擬店の2列、名前と別名、手で対応、企業は手で選ぶ、最新を使い古いものを見せる、列のずれ、別名で品目、長机の読み替えと合算、提出日時、メールを捨てる | 5（読み取りの細部は importer） |
| DB関数とブラウザ側の処理：直接と RPC の分け方、RPC の表、ブラウザの関数、エラーの形と 22 で始まるもの、updated_at の文字列、camelCase、40P01、wasm の読み込み | 2.3〜2.6・4 |
| 05「画面の受け入れ（総務で確認）」の4項目 | 7.6 |
| 05「受け入れ基準」の通しの流れ（最小変更・LibreOffice の再計算・2秒） | 7.3・4.3 |
| 00「性能と可用性」の「スマホの 4G でも 2 秒以内に開く」 | 7.7 |

## 改訂の記録

### 2026-10-29 第2版（批評 1〜58 を受けて）

批評の番号ごとに、採ったか・どう直したか・どこを直したかを書く。high と med はすべて採った（一部は別の直し方を選んだ。理由を添えた）。差分案（spec-changes-ui.md）も同じ内容に合わせた。

| 批評 | 重さ | 扱い | 直したこと | 節 |
| --- | --- | --- | --- | --- |
| 1・31 T09a の前提が足りない | med | 採用 | T09a の前提を T04・T05・T07・T08 にした（downloadAllocationXlsx は T08、団体の CSV は T05 の関数を使うため）。「マージ済みならそれも」を外し、README の並行の欄から T05〜T08 を外した。downloadAllocationXlsx を T13 に移す案は採らない（T09 の書き出しも T08 の exportYearJson を使うので、どのみち T08 を待つ） | 0・6・8.1・8.3、差分案 4-4・7-1・7-2 |
| 2 空文字と shared の nullable | med | 採用 | 任意の文字列は空なら null（optionalText）。toYearData でも '' を null にそろえ、合わない行は problems に出す。Vitest | 1.6・2.7・3.2・7.1 |
| 3・16・30・40・53 シナリオが年度をまたぐ表に書く | med | 採用 | 年度をまたぐ表（全データセットの場所と距離の上書き）は setup（db-setup）で1回だけ名前で入れ、属性が違えば止める。createScenario は年度の表だけに書き、場所の id は名前で引く。データセットにない場所はその年度で使用不可にする（W104・ダッシュボードの数がシナリオの場所だけになる）。R8 の本データの seed と名前が重なったときの扱いを書いた（注：D-40 で R8 の本データは seed に入らず、合成データで代用するので、今は重ならない。T05 への申し送りは要らなくなった）。期待値はデータセットか global-rooms.json から作る | 7.2・D-36、差分案 4-2・8 |
| 4・52 seed のユーザーのロールと D-36・依頼文の食い違い | med | 採用（設計の側にそろえた） | seed の admin・staff・viewer・rep には、シナリオの年度にだけロール・団体代表を付けてよい。R8 のロールと outsider は変えない。ロール・招待を変えるテストは createUser。年度の選択が出ても `current-year` の testid の文字を保ち、T04 の auth.spec が揺れないようにした。依頼文の「seed の年度とテストユーザーのロールを変えない」を直した。「シナリオのロールは使い捨てのユーザーだけに付ける」案は、storageState を立場ごとに作り直すことになり遅くなるので採らない | 1.3・7.2・D-36、差分案 7-3〜7-8・8 |
| 5・32・43 通しの流れの取り込みと最小変更の確かめ方 | med・low | 採用 | 3・4 で需要を増やさない（数え直しと再提出は同じ数、取り込みは専用の CSV で団体 B・C の数を今の申請以下に）。データの選び方を E2E の前に Vitest で確かめる。7 は allocator の checkMinimalChange（`@gaapp/allocator/testing` を exports に足す）で D-08 と同じ判定にし、品目で決め打ちしない | 1.8・7.3、差分案 6-1・7-8 |
| 6・39 画面の受け入れ（総務で確認）がない | med・low | 採用 | 7.6 を足した（環境・データ・記録の欄・4項目の確かめ方と合格の条件）。5分の流れの詰まりどころ（固定行の E002）に、振り分け画面の部屋の見出しの「使用不可にする」と precheck の「固定を外す」で答えた。T14 の完了基準に足した | 3.9・7.6・付録 A、差分案 7-8 |
| 7・35 「未依頼に戻す」と固定 | low | 採用（出す条件を絞った） | 依頼済み・拒否のときだけ出し、了承のときは出さない。「固定も外す」を同時に送る案は、set_consent と save_allocation_rows の2回に分かれて途中で失敗しうるので採らない | 3.10、差分案 3-10 |
| 8・22 備考だけの変更も manual | low | 採用 | applyPending は備考の変更も manual。ポップオーバーで知らせる。Vitest | 3.9 |
| 9 ルールの削除 | low | 採用（削除を出さない） | 無効にしてメモを書く。無効のルールも次の年度に引き継がれる | 3.8、差分案 3-13 |
| 10 壊れたルールの書き出し | low | 採用 | 省かず止めず、params をそのまま書き出して件数を知らせる | 2.7・6 |
| 11 提出済みにする直接の upsert | low | 採用 | 2.3 に例外（submitted_at に今の時刻を送る。note は送らない）を書いた | 2.3・3.6 |
| 12・27・51 覚えた年度で QR の在庫入力が古い年度に書く | low・med・med | 採用 | 選んだ年度は sessionStorage（タブごと）。QR・新しいタブは最新の年度。書き込む画面は最新でないとき切り替えのボタンと保存の前の確認。「localStorage のまま新しい年度ができたら既定に戻す」案は、前年度を見た翌日の在庫入力を防げないので採らない | 1.3.1・3.3・3.5・3.11・D-31、差分案 3-3・3-5・3-7 |
| 13・18 staff から admin だけの画面へのリンク | low | 採用 | canOpen と AppLink で出し分け。staff には /swaps の件数だけ、ルールはコードと文だけ | 1.1・1.4・3.1・3.9、差分案 3-4・3-9 |
| 14 4G で2秒の測り方 | low | 採用 | 7.7 を足した（Fast 4G と CPU 4倍で3画面を3回、notes に記録。最初に読む JS の量は T09a の値の 1.5 倍以内）。絶対の上限の数は、雛形の値がまだないので決めない | 7.7 |
| 15 終了した年度から新しい年度を作れない | high | 採用 | closed の例外に create_year_from を足し、作成のボタンの条件を「最新の年度の admin（状態は問わない）」にした。serial に終了した年度から複製するケースを足した | 2.1・3.2・7.2、差分案 3-12 |
| 17 削除の 0 行 | med | 採用 | deleteChecked（消えた行を受け取り、0 行なら not_found・conflict・forbidden に分ける）。テスト | 1.5・2.3・3.2 |
| 19 締切の判断が端末の時計 | low | 採用 | DB が受付期間の外と判断した印を持ち、/request は読み取り専用、/requests は締切後の書き方に切り替える | 2.5・3.5・3.6、差分案 3-7・3-8 |
| 20 壊れたルールのまま確定できる | low | 採用 | problems があれば確定も押せない。ダッシュボードにも出す | 2.7・3.1、差分案 3-4 |
| 21・33 振り分けの数の 0 | low | 採用 | CountStepper に min。振り分けは min 1、0 は削除を案内。行の追加の既定は1以上。pending の zod | 1.4・3.9 |
| 23・34 create_year_from の details のない invalid_input | low | 採用 | 画面の zod で年度名と「複製元の1日目より後」を先に確かめ、返ってきたら2つの欄に出す。2.5 の表に行を足した | 2.5・3.2 |
| 24・50 PGRST303 と /login との行き来 | low・med | 採用 | auth は PGRST301〜303 か status 401。refreshSession を1回試し、だめなら下書きを残して signOut（local）してから /login へ | 2.5、差分案 3-17 |
| 25・38・58 T03 の前提のコミット | low | 採用 | 前提を今の先頭 bd6aef0（c96155d・bd42552・f7b1b01）に直した。古いハッシュは書き直されたもので、docs の差は 05 の状態の列だけ。f7b1b01 の行を 2.9 に足し、T14 の README の確かめ（本番の Auth の設定）を足した | 冒頭・0・2.9・8.1・8.2、差分案 0・7-8 |
| 26 通信の失敗の後の insert の二重 | high | 採用（(1)(2)。(3) は今は採らない） | 送信中は押せない決まり。保存されたか分からないときは版を読み直し、進んでいれば reconcileAfterUnknown で突き合わせてから送り直す（save_allocation_rows は全部か何もないかで、通れば必ず版が上がる）。ほかの書き込みも 2.6 に書いた。insert に画面の id を渡す RPC の変更は、T03 の領分で、突き合わせで足りるので今は採らず、必要になれば別のチケットで相談する | 1.4・2.6・3.9・D-33・D-34、差分案 3-9・3-17 |
| 28・49 未保存の入力の守り | med | 採用 | AppLink の onNavigate・useGuardedRouter（ESLint で直接の push を止める）・beforeunload。戻るボタン・タブの破棄・アプリの切り替えは下書き（localStorage。ログアウトで消す）で戻せるようにした。/request・/requests にも付けた。history に番兵を積む案は、App Router の履歴と食い違いやすいので採らない | 1.4・1.7・3.3・3.5・3.6・3.9・D-33、差分案 3-3・3-5・3-7・3-8・3-9 |
| 29 保存の段階の「中止」 | med | 採用 | 中止は Worker の段階と読み直しだけ。保存を送った後は「保存中…」で待つ。中止の後は版を読み直す | 3.9・4.3・D-34、差分案 3-9 |
| 36 確定中のルールの変更 | low | 採用 | 確定中はメモだけ（画面で止める） | 2.1・3.8、差分案 3-13 |
| 37 出していない品目の DB の行 | low | 採用 | /request に読み取り専用の行、/requests のセルに灰色の数。読み替え先の初期値には足さない | 3.5・3.6、差分案 3-7・3-8 |
| 41 createScenario の引数が足りない | med | 採用 | rules・extraGroups・prevYear・usable・keep を足し、small と synthetic-infeasible-s05 の中身を決めた。T10・T11 の完了基準に前年の数を足した | 7.2、差分案 7-4・7-5 |
| 42 reference の is_keep | med | 採用 | is_keep = 運び元 = 使用場所。reference の validate が error 0 になる Vitest | 7.2 |
| 44 ログアウトが storageState を壊す | low | 採用（両方） | アプリの signOut を local にし、ログアウトを試すテストは storageState を使わない | 1.3・7.2 |
| 45 serial のスキップと shots | low | 採用 | `pnpm e2e` を2回の呼び出しにする scripts/e2e.mjs。shots・manual・perf は環境変数のときだけ。テストの名前はチケット ID で始める | 7.2・7.4、差分案 4-2 |
| 46・56 basePath を CI で通さない | low | 採用 | T14 に basePath のスモーク（/GAapp の下に配り、wasm・QR・マニフェスト・アイコン）。wasm の URL の関数を切り出して Vitest | 4.2・4.3・7.2、差分案 4-2・7-8 |
| 47 速すぎてロックが見えない | low | 採用 | page.route で応答を止めて確かめる。10 秒の中止は Vitest | 7.2・7.4 |
| 48 エラーの文言を本物の DB で | low | 採用 | e2e/errors.spec.ts（Node から RPC の失敗を起こして classifyError に通す） | 2.5・7.2 |
| 54 PWA の standalone と OAuth | med | 採用 | 既定を display: browser にし、standalone は実機で確かめられたときだけ。T14 の完了基準に足した | D-38、差分案 1-2・7-8・8 |
| 55 アイコンの basePath | low | 採用 | ファイルの規約（app/icon.png など）で置く。ui-lab で basePath が付くことを確かめた | 1.9・10・D-38 |
| 57 アプリ内ブラウザ | low | 採用 | QR のカードの文言と、/login での案内 | 1.3・3.4、差分案 3-6・3-18 |

ほかに直したこと：Q1 の推奨で部員が振り分け画面を開くので、ナビの部員の期待値も T09a で直す（1.3）。7.5 の e2e ジョブの timeout を 25 分にした（basePath のビルドが増えるため）。

### 2026-10-29 第3版（実装者の目で見た抜け 1〜6 を受けて）

T04 の migrations（0005 の create_year_from、0006 の save_allocation_rows）、apps/web（auth-provider.tsx・app-shell.tsx・app/(app)/page.tsx）、e2e/auth.spec.ts と、T07 の allocator（validate・contextFor・createContext）を読み直して確かめた。6件とも採った。差分案（spec-changes-ui.md）も同じ内容に合わせた。

| 抜け | 重さ | 扱い | 直したこと | 節 |
| --- | --- | --- | --- | --- |
| 1 使用不可にした後の「固定を外す」が E002 | high | 採用（指摘の直し方のとおり） | save_allocation_rows は update のたびに変えた後の運び元が使用不可なら E002 にする（固定だけ・備考だけでも。delete は共通の検査の前に continue するので通る）ことを確かめた。手動の行は固定を外しても fixedRows に残る。部屋の見出しの「使用不可にする」は、先にその部屋からの固定・手動の行を一覧にし、固定の自動の行は「固定を外す」「運び元を変える」「削除」、手動の行は「運び元を変える」「削除」で直して保存してから使用不可にする順にした（一覧が空で未保存の変更がないまで押せない）。マスタ設定からは、固定・手動の行があれば振り分け画面へ案内する。precheck の E002 は「運び元を変える」「行を削除」と「部屋を使用可に戻す」への移動にし、「固定を外す」を出さない。すでに使用不可の部屋の行は運び元の変更と削除だけ（allowedRowOps）。Vitest と E2E（t13：画面に出ない・API で E002・正しい順なら precheck に出ない）を足した。7.6 の5分の流れと 7.3 の手順7も同じ順に直した | 1.5・3.2・3.9・7.1・7.2・7.3・7.6・8.1・8.2・D-34、差分案 3-9・3-12・6-1・7-2・7-7・8 |
| 2 立場の読み直しで画面が外れる | med | 採用 | 同じ user_id の reloadMembership では前の membership を ready のまま出し、isRefreshing を足す。読み直しの失敗は前の値を残して toast。AppShell が LoadingState・ErrorState に置き換えるのは初回と user_id が変わったときだけ。T09a の範囲に入れ、Vitest で「reloadMembership の間に子が外れない」を確かめる | 1.3・2.6・7.1・8.1・D-33、差分案 3-3・7-2・8 |
| 3 ログアウトと下書き・年度の切り替えの守り | med | 採用 | ログアウトを (a) 手動（未保存の入力があれば確かめてから、その人の下書きを消す）、(b) 401 などの強制の signOut・ほかのタブのログアウト（確かめず、下書きを消さない。キーに user_id があるので別の人には出ない）、(c) 別の user_id でのログイン（他人の下書きを消す）に分けた。年度の切り替えは useGuardedSetYear で確かめる（ESLint で setYear の直接の呼び出しを止める）。部品のテストを足した | 1.3・1.3.1・1.4・2.5・7.1・8.1・D-33、差分案 3-3・7-2・8 |
| 4 参照の切れたルールで validate が例外 | med | 採用 | toYearData が createContext を当て、ruleCode のある inputErrors はそのルールを外して problems に入れ（ほかの検証は回る。確定は止まる）、ruleCode のないものは validatable: false にする。ダッシュボード・振り分けの「入力の誤り」にルールのコードとリンク、ルール画面の一覧に「参照が切れています」の印。団体・場所の削除の確認で、参照している有効なルールのコードを出して削除を押せなくした（無効のルールは件数だけ添えて止めない）。指摘は「先に無効にするよう案内する」だったが、確定中・終了の年度以外では無効にするのに手間がかからず、消してから気づくと validate が止まるので、案内に加えて押せなくした。場所はほかの年度のルールを読めないことがあるので確かめきれないことを書いた。Vitest を足した。あわせて、room_years から参照されている場所も削除が 23503 になることを 3.2 に書いた | 1.5・2.7・3.1・3.2・3.8・7.1・7.2・8.1・8.2・D-33、差分案 3-4・3-9・3-12・7-2・7-3・8 |
| 5 T09 がホームを置き換えると auth.spec の home-roles が消える | med | 採用（testid を残す方） | ダッシュボードとホームの両方に「立場の一覧」（`data-testid="home-roles"` の ul と `home-year`。T04 と同じ文字）を残すと 3.1 に書き、8.2 の T09 の行と T09 の依頼文・E2E に足した。auth.spec を T09a のうちにヘッダーの要素で確かめる形に直す案は、T04 のテストの意味を変えるので採らない | 3.1・7.2・8.2、差分案 3-4・7-3 |
| 6 serial の年度の作成が not_latest になる・年度をまたぐ表の残り物 | med | 採用 | create_year_from の not_latest が全年度を見ることを 0005 で確かめた。createScenario に `festivalStart: 'latest'`（2199 年台。新しい年度は 2200 年）と、createUser のユーザーにロールを付ける `grants` を足した。latest は serial でだけ使い、seed のユーザーにロールを付けない（付けると既定の年度が変わる）。seed の R8 からは作らない。serial で年度をまたぐ表を変えるテストは、テスト専用の名前の行だけを作って変え、afterEach で pg で消す（データセット・seed の行は変えない）。db-setup は前の実行の残り物（E2E- の年度、テスト用の行、e2e- のユーザー）を先に消す（手での確かめは MANUAL-・manual- で残す） | 7.2・D-36、差分案 4-2・7-3・8 |

### 2026-10-29 2.6 (B) の改訂

- 2.6 の (B) を (B1)（楽観ロックの更新と一意のキーの insert。確かめる状態を持たず、応答が届かなかったとき・conflict・not_found・23505 のときに行を読み直して settleLockedWrite で決める）と (B2)（save_allocation_rows・save_auto_allocations・set_year_status・set_consent。今までどおり確かめてから送り直す）に分けた。あわせて 0 章・1.5・3.2・3.8・3.9・11 章を直した（T09・T12・T13 のレビューで同じ種類の指摘が続いたため。notes/T09a.md の 12）。
