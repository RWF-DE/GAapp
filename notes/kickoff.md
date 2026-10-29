# キックオフ：不明点・リスク・T00〜T04 の計画

作成：2026-10-28（docs/prompts/00_kickoff.md の依頼による。コードは書いていない）

読んだもの：SPEC.md、CLAUDE.md、docs/requirements/00〜05、docs/prompts/（README、00_kickoff、T00〜T14）、.claude/agents/。

## 要点

- 実装を止めるほどの矛盾はないが、T02〜T04 の前に決めないと作り直しになる点が7つある（下の「高」）。答えは notes/decisions.md に記録する。
- いちばん影響が大きいのは「年度をまたぐ表の管理者と、最初の管理者の作り方」（K-01）。DDL と RLS の形が変わる。
- 振り分けの定式化（二部グラフの輸送問題なので完全単模、W と μ の大小関係）は成り立っている。R8 の数字（N＝1,295、W≒65,000、キャスター机 103→97）も表どうしで合っている。ただし同点の解が残るので、W107 と決定性のためにコストの整数化を T06 で入れたい（K-12）。
- 運用面では、Supabase の一時停止からの再開期限（K-09）を、オーナーが管理画面で確かめる必要がある。

## 1. 不明点・矛盾・リスク

優先度：**高**＝T02〜T04 の形か受け入れ基準に効き、決めないと作り直しになる。**中**＝担当チケットの開始前（計画モード）に決めればよい。**低**＝気づいた点・実装時の注意。

### 高

**K-01 年度をまたぐ表の管理者と、最初の管理者の作り方**（→ D-01）
- 根拠：02_data.md「権限とRLS」（判定は `private.has_role(year_id, role)`、rooms・items・room_years・distance_overrides は admin が RW）、02_data.md「設計上の決めごと」（create_year_from は year_roles を複製しない）、04_screens_api.md「DB関数とブラウザ側の処理」、01_rules.md「年間の業務の流れ」1。
- 内容：rooms・items・distance_overrides は year_id を持たないので、`has_role(year_id, …)` では「どの年度の admin なら書けるか」が決まらない。create_year_from は year_roles を複製しないので、新しい年度を作った本人がその年度の admin にならず、招待（invite は admin のみ）もできなくなる。最初の年度と最初の admin を作る手段（RPC・画面・手順）がどこにもない。
- 影響：T02（DDL）、T03（RLS・RPC）、T09（年度の作成）。

**K-02 「残す」（S08）の行が二重になる**（→ D-06）
- 根拠：03_allocation.md「前処理」3（keep を固定行（is_keep、pinned）にする）、同「入力と出力」（fixedRows＝pinned または manual の行）、05_development.md「不変条件」（固定行・手動行が二重にならない）。
- 内容：keep の行を pinned で保存すると、次の実行で「fixedRows（DB の pinned 行）」と「keep ルールから作る行」の両方に入り、学科展示の机12が24になる。AllocationRow に pinned・origin がないので、allocate の結果の keep 行をどう保存するかも書かれていない。
- 影響：T06、T03（save_auto_allocations）。

**K-03 fixed_request（S06）の「申請がなければ」が判定できない**（→ D-07）
- 根拠：03_allocation.md「前処理」2、04_screens_api.md「申請 /request」（申請できる品目の入力欄を初期値0で出し、提出で全品目を保存）、05_development.md「不変条件」（設営の机(木)241台）。
- 内容：申請画面は全品目を保存するので、「申請していない」と「0台を申請した」の区別がつかない。設営が机0のまま提出すると需要が0になり、241台の受け入れ基準を満たせない。
- 影響：T06、T07（W106）。

**K-04 最小変更モードの受け入れ基準が、余りのない品目では満たせない**（→ D-08）
- 根拠：SPEC.md「E2E の検証手順」7、05_development.md「不変条件」（第一セミナー…変わった行の数をテストで記録する）、05_development.md「R8 の実績」（机(木)の余り0）、03_allocation.md「定式化」（x̂ と μ）。
- 内容：使用不可にした部屋から運んでいた品目に余りがなければ、ほかの団体の分を回すか代替を増やすしかなく、その部屋と無関係な行も変わる（R8 の机(木)は余り0）。SPEC の手順7は「その部屋から運んでいた分だけ」と厳密で、05 は「行数を記録」と緩く、食い違っている。「変わった行」の定義（行の id か、（運び元・団体・申請品目・品目）ごとの数か）もない。また R8 の fixtures では第一セミナーが最初から使用不可なので、05 のテストは「使用可として1回解く → 使用不可にする → 最小変更で解く」と手順を書く必要がある。
- 影響：T06、T14、受け入れ基準。

**K-05 個人情報の範囲があいまい（公開リポジトリ）**（→ D-03）
- 根拠：SPEC.md「やらないこと」（個人情報（メールアドレスなど）の保存とコミット）、02_data.md「テーブル定義」（invitations.email、profiles.display_name）、00_overview.md「権限とセキュリティ」（外部の個人情報は保存しない）、04_screens_api.md「CSV取り込み」（メールアドレスを捨てる）、CLAUDE.md「個人情報（公開リポジトリ）」。
- 内容：SPEC の書き方では、招待や auth.users のメールも「保存しない」と読めるが、実際は保存が要る。一方 importer が捨てるのはメールだけで、フォームの氏名・学籍番号・電話番号の列や、備考の自由記述に書かれた名前・連絡先は捨てる対象になっていない。備考を fixtures/r8 に入れると公開リポジトリに出る。団体名（研究室名に教員の名前が入るなど）も確認が要る。profiles.display_name には Google の氏名が入る。
- 影響：T04（profiles）、T05（importer・fixtures）。

**K-06 画面にある操作に対応する RPC がない**（→ P-01）
- 根拠：04_screens_api.md「マスタ設定 /settings」（申請の受付期間、ロールの変更、招待の取り消し）、02_data.md「権限とRLS」（years・year_roles・invitations は admin が R・RPC）、04_screens_api.md「DB関数（RPC）」の表。
- 内容：years・year_roles・group_members・invitations は RPC でしか書けないのに、年度の設定（受付期間など）の変更、ロールの変更・削除、招待の取り消し、団体代表の解除の RPC がない。set_consent では、substitution_consents.count（依頼したときの台数）を誰がいつ入れるかも書かれていない。
- 影響：T03 の範囲。

**K-07 save_auto_allocations の入力の確かめ方と、同時実行**（→ P-01）
- 根拠：03_allocation.md「入力と出力」（保存後に在庫超過を DB で確かめる）、02_data.md「設計上の決めごと」（楽観ロックは allocations と requests の行ごと）、04_screens_api.md「DB関数（RPC）」。
- 内容：(1) DB で確かめるのが在庫超過だけなので、別の年度の団体・部屋の id、使用不可の部屋（E002）、残すの不整合（E005）の行がブラウザから送られても入る。(2) 計算（Web Worker）の間に別の管理者が手動行を足すと、古い fixedRows で計算した結果を保存して、申請より多く割り当てる。在庫に余裕があれば DB では止まらない。
- 影響：T02（DDL に版の列を足す場合）、T03。

### 中

**K-08 長机(3人掛)の読み替え（前処理1）と E006 がぶつかる**（→ D-05）
- 根拠：01_rules.md「設定ルール」S03、03_allocation.md「前処理」1と「検証コード一覧」E006、04_screens_api.md「CSV取り込み」。
- 内容：企業以外の長机(3人掛)の申請を、前処理1は黙って長机(2人掛)に読み替え、E006 は error にする。同じ入力で両方が動くと、読み替えたのに確定できない。画面は入力欄を出さず、取り込みでも読み替えるので、DB に入るのは API を直接呼んだときだけ。RLS では品目の区分を確かめられないので、DB の入り口にも検査がない。

**K-09 Supabase 無料プランの一時停止と再開の期限**
- 根拠：00_overview.md「保守と引き継ぎ」（停止から1年以内なら再開できる。毎年7月に再開）。
- 内容：Web 検索では、公式の changelog に「停止から90日まで復元できる」、公式トラブルシューティングの現在のタイトルに「1年を超えて停止したプロジェクトの復元」と、両方が出てくる。1年に延びた可能性が高いが、このセッションからは supabase.com を開けず、原文を確かめていない。10月の祭のあと11月ごろ停止 → 翌7月に再開で約8か月になる。90日ならダッシュボードから再開できない。停止からの再開でデータを失ったという報告（GitHub の discussion）もある。
- 提案：オーナーが管理画面で現在の期限を確かめ、00 を直す。年度末の書き出し（JSON・Excel・`supabase db dump`）を必須の手順にし、新しいプロジェクトへ戻す手順を README に書いて一度試す。GitHub Actions の定期実行で起こしておく案は、公開リポジトリで60日間動きがないと定期ワークフローが止まるので、それだけに頼らない。

**K-10 テスト用ユーザーとドメイン制限フック**（→ D-02）
- 根拠：02_data.md「権限とRLS」（Before User Created フック、許可ドメインは定数）、05_development.md「ブランチ・レビュー・CI」4、docs/prompts/T04.md。
- 内容：E2E のメール＋パスワードのユーザーをフック経由で作るには、テスト用のドメインをフックの定数に入れる必要があり、それは本番にも入る。なお Before User Created フックは、検索した範囲では無料プランでも使える。

**K-11 Google Cloud の OAuth クライアントの持ち主**
- 根拠：00_overview.md「非機能要件と技術構成」（すべてのアカウントを組織の持ち物にする）、同「未決事項」。
- 内容：Google ログインには Google Cloud のプロジェクト（OAuth クライアント）が要るが、その持ち主が未決事項に入っていない。同意画面を「内部」にするには学校の Workspace の中にプロジェクトを作る必要があり、情報担当の協力が要る。「外部」なら個人の Google アカウントが持ち主になるので、オーナーを2人以上にして引き継ぐ必要がある。また「外部」は公開ステータスを「本番」にしないと、登録したテストユーザーしかログインできない。
- 提案：00 の未決事項に足し、情報担当への確認（1〜3年生のログイン）と一緒に聞く。

**K-12 同点の解が残り、W107 と δ の保証が弱い**（→ P-02）
- 根拠：03_allocation.md「目的関数」（δ＝−0.1、「距離の差（1 以上）より小さい」）、同「距離コスト」、01_rules.md「固定ルール」5、05_development.md「不変条件」（W107 が0件）。
- 内容：(1) 段階的な距離は三角不等式を満たさないことがあり、同点ができる。例：団体 g の部屋（1号棟1階）の机を屋外の h へ出し（3）、g は同じ建物の2階から受け取る（2）と合計5。g が自室の机を残し、h が2階から受け取る（5）も5で同点になる。どちらになるかは単体法の手順しだいで、W107 が出得る。(2) δ の合計は「休憩所の数 × 0.1」まで動くので、休憩所が10以上になると距離の差1を上回る。(3) S05 で 1-1〜2-3 の机を設営に回すと、その教室を使う団体が他から机を受け取る形になり得る（データしだいで W107 と両立しない）。
- 提案（T06 の計画で決める）：コストを整数にそろえる。例：d′ = 100·d ＋（運び元が使用場所でなければ 1）、休憩所への不可椅子は −10、W と μ もこの単位で計算し直す。自室以外への移動に 1 を足すので、同点なら「残す」が選ばれる。S05 が原因の W107 は理由を表示する（warning のままなので確定はできる）。

**K-13 前処理で見つけた E001 を返す型がない**
- 根拠：03_allocation.md「前処理」4（固定分が在庫を超えたら E001 で止める）、同「入力と出力」（ok: false は shortages と causes だけ）、同「解けないときの扱い」。
- 内容：前処理で E001 を見つけても AllocateResult で返せない。ok: false に `issues: Issue[]` を足すのが素直。T06 で型を決めて 03 を直す。

**K-14 最小変更モードの x̂ の作り方**
- 根拠：03_allocation.md「変数」「目的関数」。
- 内容：x̂ も x と同じく、ルールで禁止された組み合わせ（了承を拒否した団体への置き換え、S05、使用不可の部屋）には作らない、とは書かれていない。結果は (r,g,i,j) ごとに x と x̂ を足して1行にする、とも書かれていない。T06 で明記する。

**K-15 距離コストの関数が決まりきっていない**
- 根拠：03_allocation.md「距離コスト」、02_data.md「テーブル定義」（rooms）。
- 内容：運び元が屋外・その他（kind が outdoor・other）のとき、体育館の階（floor が null のとき）、団体の使用場所が体育館・その他のとき、distance_overrides の向き（(A,B) と (B,A)）、上書きが「別の建物」の4だけを置き換えるのか、が決まっていない。T06 で表にしてテストを書く。

**K-16 監査トリガーは SECURITY DEFINER にする必要がある**
- 根拠：02_data.md「設計上の決めごと」（audit_logs はトリガーで書く）、同「権限とRLS」（audit_logs は admin の R だけ）。
- 内容：部員が在庫を書くとトリガーが audit_logs に insert し、RLS で止まって在庫の保存も失敗する。トリガー関数を SECURITY DEFINER・`search_path = ''` にする（T02 の注意点）。

**K-17 共通レイアウトが T09 にあり、T10・T11 と並行すると衝突する**（→ P-03）
- 根拠：05_development.md「チケット分割」（T09〜T11 はどれも T04 の後で並行可）、docs/prompts/T09.md「範囲」（共通のレイアウト）、docs/prompts/README.md「順番と並行作業」。
- 内容：T10・T11 も同じナビゲーションと3状態（読み込み中・空・権限なし）の部品を使うので、T09 と並行すると同じファイルを触る。

**K-18 LibreOffice の headless は xlsx を開いても再計算しないことがある**
- 根拠：03_allocation.md「Excel出力仕様」の確認方法、docs/prompts/T08.md。
- 内容：LibreOffice は既定では、Excel 形式のファイルを開くと保存済みの値を使い、再計算しない設定になっている。fullCalcOnLoad が headless の変換で効くかは確かめる必要がある。マクロ（calculateAll）か UNO で再計算してから値を読むスクリプトを用意する。CI に LibreOffice を入れる時間（apt で数分）も見込む。

**K-19 「今の年度」の決め方がない**
- 根拠：00_overview.md「画面一覧」、04_screens_api.md「画面仕様」。
- 内容：年度は毎年増えるのに、画面がどの年度を開くか（終了していない最新の年度か、選択式か）が決まっていない。T09 の計画で決める。

### 低

- **K-20** PWA を作るチケットがない（00_overview.md「非機能要件と技術構成」にはある）。T14 に入れるか、別チケットにする。
- **K-21** 団体別集計の SUMIF は、団体名の `*` `?` `~` をワイルドカードとして扱う。団体名に半角の `?` や `*` があると集計がずれる（T08。`~` でエスケープするか、団体名で禁止する）。
- **K-22** 「ブラウザで2秒以内」に wasm の読み込みを含めるかが決まっていない（00「性能と可用性」、05「不変条件」）。T00 で両方を分けて測る。
- **K-23** highs-js で何度も解き直したときの安定性（診断では数回〜十数回解く）と、LP 形式の1行の長さの上限。T00 で、同じインスタンスで繰り返し解く場合と毎回作り直す場合を両方試す。
- **K-24** request_close_at が null のときの「締切前」の扱いと、キャスター机の了承待ち（W102）のまま確定してよいか（warning なので今の仕様では確定できる）。T03・T13 で確認する。
- **K-25** stocks の counted_by は部員が自由に書けるので、RLS の with check で `auth.uid()` と一致させる（T03）。
- **K-26** 解けないときの診断（「解けないときの扱い」2）で、fixed_request（S06）を外す対象にしていない。設営の241台が原因のときに causes に出ない（T07）。
- **K-27** 団体別集計の「区分の中は申請順」で、未提出（代理入力のみ）の団体の並びが決まっていない（T08。例：submitted_at → sort_order → 名前）。
- **K-28** GitHub Pages では `trailingSlash: true` と `images: { unoptimized: true }` を入れておくと、/stocks/ などの直リンクと next/image で困らない（T01）。
- **K-29** Claude Code のクラウドのセッションでは Docker の CLI はあるがデーモンが動いていなかった（このセッションで確認）。`supabase start` が要る T02 以降をクラウドで進めるなら、環境のセットアップで dockerd を起動できるかを T01 で確かめる。手元の PC でも Docker Desktop などが要る。

## 2. T00〜T04 の実装計画

順番：T00 と T01 を並行 → T02 → T03（T05 と並行可）→ T04。D-01〜D-08 と P-01 のうち DDL に効くものは、T02 の PR で先に docs/requirements を直す。

### T00 スパイク（spikes/highs/、sonnet / medium）

作るもの（この順）：
1. `spikes/highs/package.json`：highs を exact で固定。tsx、vite、playwright。
2. `gen.ts`：シード固定の乱数で、保管場所40・団体55・品目9のダミーを作る。在庫の合計は「R8 の実績」の在庫、需要の合計は振り分け計（N＝1,295）に合わせる。代替（S01・S02・S04・S07）、S05 相当の運び元の制限、keep 1件、了承を拒否した団体1つを入れる。在庫を減らして解けない版も作る。
3. `lp.ts`：03 の定式化どおりに CPLEX LP 形式の文字列を作る（変数名は x1…と対応表、長い行は折り返す）。最小変更モードの x̂ も作れるようにする。
4. `bench-node.ts`：Node で5回解き、時間の中央値、すべての変数で |x − round(x)| ≤ 1e-6、5回の解が同じこと（解のハッシュ）、入力を並べ替えてから並べ直すと同じ解になること、解けない版の status を確かめる。同じインスタンスで20回続けて解く場合と、毎回作り直す場合の時間と安定性も測る（K-23）。
5. `browser/`：最小の Vite ページ。highs.wasm を public/ に置き、locateFile で URL を渡す。Web Worker の中で解く。
6. `bench-browser.ts`：Playwright の Chromium で開き、wasm の読み込み時間と解く時間（5回の中央値）を分けて測る（K-22）。

検証：両方のスクリプトを実行し、notes/T00.md に表（環境、highs のバージョン、変数と制約の数、LP の文字数、時間の中央値、整数か、同一か）を書く。T06 への注意（インスタンスの使い回し、wasm の置き場所と basePath、time_limit の扱い）も書く。

### T01 雛形・CI・GitHub Pages（sonnet / medium）

作るもの（この順）：
1. ルート：`pnpm-workspace.yaml`、`package.json`（lint・typecheck・test・build・e2e のスクリプト、packageManager で pnpm を固定）、`.nvmrc`（Node 22）、`tsconfig.base.json`（strict）、`eslint.config.mjs`、Vitest の workspace 設定、`.gitignore`（.env*、out/、.next/、元データの誤コミットを防ぐため fixtures 以外の *.xlsx・*.pdf）。
2. `packages/allocator`・`exporter`・`importer`・`shared`：package.json、src/index.ts、空のテスト1つ。
3. `apps/web`：Next.js（App Router、`output: 'export'`、basePath は環境変数から、`trailingSlash: true`、`images.unoptimized`）、Tailwind、shadcn/ui の初期化、/login のプレースホルダーと空の /。
4. `supabase/`：`supabase init` の config.toml、tests/ に pgTAP の空テスト1つ。
5. `playwright.config.ts` と `e2e/` の空テスト（起動して / が開くだけ）。
6. `.github/workflows/`：ci.yml（PR で install --frozen-lockfile → lint → typecheck → test → build、別ジョブで supabase start → supabase test db）、deploy.yml（main への push で build → upload-pages-artifact → deploy-pages）、migrate.yml（workflow_dispatch で supabase link → db push）。
7. CI に、リポジトリ全体でメールアドレスのパターンを探すステップを足す（docs/ などの許可リストを除く）。T05 のテストより先に、公開リポジトリへの誤コミットを止めるため。
8. README（Pages の有効化、Actions の変数と secrets、保護ブランチ）と、CLAUDE.md の「コマンド」。

検証：`pnpm install`・`pnpm lint`・`pnpm typecheck`・`pnpm test`・`pnpm build` をローカルで実行し、apps/web/out ができてリンクに basePath が付いていることを確かめる。PR で CI が通ることを確かめる。

### T02 DDL・列挙型・ビュー・監査トリガー（sonnet / medium）

前提：D-01・D-05・P-01 のうち DDL に効く部分を、先に 02_data.md に反映する。

作るもの（この順）：
1. `supabase/migrations/0001_init.sql`：列挙型、テーブル（02 の DDL ＋ created_at・updated_at）、D-01・P-01 で足す列や表、updated_at のトリガー、v_remaining（security_invoker）、全テーブルで RLS を有効にする（ポリシーは T03。それまでは誰も読めない安全側）。
2. `0002_triggers.sql`：監査トリガー（SECURITY DEFINER、`search_path = ''`、`current_setting('app.reason', true)` と `auth.uid()`。K-16）、残すの整合（is_keep の行は運び元＝団体の使用場所）、年度の一致（allocations・rules・invitations などの year_id と groups.year_id が同じ）、D-05 で決めた申請できる品目の検査。
3. `seed.sql`：品目9件（並び順・aliases・requestable_categories）とテスト用の場所数件。
4. `supabase/tests/schema.test.sql`：表・列・制約があること、v_remaining が使用不可の部屋を除くこと、監査が理由つきで書かれること、残すのトリガーが不正な行を拒むこと、年度の不一致を拒むこと。
5. `packages/shared/src/database.types.ts`（`supabase gen types typescript --local`）。

検証：`supabase db reset`、`supabase test db`、`pnpm typecheck`。

### T03 RLS・権限の関数・RPC（opus / high、計画モード）

作るもの（この順）：
1. `0003_private.sql`：private スキーマ（API には公開しない。ポリシーから呼べるよう execute だけ与える）、has_role・is_group_member・D-01 の管理者判定・年度の状態を返す関数（すべて SECURITY DEFINER、`search_path = ''`）。
2. `0004_policies.sql`：権限表どおりのポリシー。`auth.uid()` は `(select auth.uid())` で書く。stocks の部員は年度の状態と `counted_by = auth.uid()` を with check で確かめる（K-25）。requests の団体代表は requesting・締切前・自団体。
3. `0005_rpc.sql`：04 の8つと P-01 で足すもの。最初にロール、次に年度の状態、入力（年度の一致・数・品目）を確かめ、`set_config('app.reason', …, true)` のあと書き込む。エラーは forbidden・invalid_state・conflict・E001 などのコード。execute は authenticated だけに与え、public・anon からは外す。
4. `supabase/tests/`：ユーザーを切り替える補助関数（`set local role authenticated` と `request.jwt.claims`）、権限表の全セルを表から生成するテスト（admin・staff・団体代表・viewer・未招待 × テーブル × 読み書き）、RPC ごとの正常系・forbidden・invalid_state・conflict、save_auto_allocations の在庫超過での取り消し。

検証：`supabase test db`、security-reviewer のレビュー。本番に適用した後、Supabase の Security Advisor でも確かめる。

### T04 Google ログイン・ドメイン制限・招待（opus / high、計画モード）

作るもの（この順）：
1. `0006_auth.sql`：Before User Created フック（hd クレーム → なければメールのドメイン。ドメインは D-04 の定数）。execute は supabase_auth_admin にだけ与える。auth.users への insert 後のトリガー（profiles を作り、未使用の招待から year_roles・group_members を作る。メールは lower で比べる）。
2. `supabase/config.toml`：フックの有効化と、ローカルのメールログイン（D-02 の方式）。
3. `seed.sql`：テストユーザー（管理者・部員・団体代表・未招待。D-02）。
4. `apps/web`：`lib/supabase/client.ts`（publishable キー、`flowType: 'pkce'`）、/login（Google ボタン。redirectTo は basePath 込み）、ログイン後に戻るページ、ログイン状態の保持、「総務から招待されていません」の画面、ローカルだけのテスト用ログインフォーム（環境変数で出す）。P-03 が通れば共通レイアウトもここで作る。
5. テスト：フック関数に JSON を渡して直接呼ぶ pgTAP（許可・拒否・hd あり・なし）、招待の受け入れ、未招待は何も読めないこと。Playwright で4人がログインできること。
6. README：Google Cloud の OAuth クライアント（K-11）、Supabase のリダイレクト URL（Pages の URL ＋ basePath とローカル）、フックの有効化、本番でのメールログインの無効化。

検証：`supabase test db`、`pnpm e2e`、security-reviewer のレビュー。

## 3. 決めてほしいこと

AskUserQuestion で次を質問し、答えを notes/decisions.md に記録した（2026-10-28）。D-05（前処理で読み替える）と D-07（未提出のときだけ固定数）は推奨と違う案になったので、それに伴うことも decisions.md に書いた。

| ID | 内容 | 関係する不明点 | 必要になるチケット |
| --- | --- | --- | --- |
| D-01 | 年度をまたぐ表の管理者と、最初の管理者の作り方 | K-01 | T02・T03 |
| D-02 | テストユーザーとドメイン制限フックの両立 | K-10 | T04 |
| D-03 | 個人情報の範囲と、importer で残す列 | K-05 | T04・T05 |
| D-04 | 学校の Google ドメイン | 00 の未決事項 | T04 |
| D-05 | 長机(3人掛)の読み替えと E006 | K-08 | T02・T06・T07 |
| D-06 | 「残す」の行の保存のしかた | K-02 | T03・T06 |
| D-07 | fixed_request の「申請がなければ」 | K-03 | T06・T07 |
| D-08 | 最小変更モードの受け入れ基準 | K-04 | T06・T14 |

質問しない提案（各チケットの計画モードで確認する。反対がなければ採用）：
- **P-01**（K-06・K-07）：RPC を足す（update_year、set_role、revoke_invitation、remove_group_member）。set_consent で status を asked にしたとき、その時点の置き換え台数を RPC が count に入れる。save_auto_allocations は年度の一致・E002・E005 も確かめる。years に allocation_version（整数）を持たせ、振り分けを変える RPC ごとに1増やし、save_auto_allocations は入力を作ったときの版と違えば conflict にする。
- **P-02**（K-12）：コストを整数にそろえ、自室以外への移動に1を足して同点を「残す」側に倒す。T06 の計画で値を決め、03 を直す。
- **P-03**（K-17）：共通レイアウト（ナビゲーション、ロールによる表示の切り替え、3状態）を T09 から T04 に移す。05 のチケット表と T04・T09 の依頼文を直す。
