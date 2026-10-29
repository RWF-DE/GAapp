# 決定事項

仕様（docs/requirements）で決まっていなかったことと、食い違っていたことの決定を記録する。要件定義への反映は、CLAUDE.md のルールどおり、関係するチケットの PR で先に docs/requirements を直してから実装する。不明点の詳細（K-xx）は notes/kickoff.md にある。

## D-01 年度をまたぐ表の管理者と、最初の管理者（2026-10-28、K-01）

- **決定**：rooms・items・distance_overrides など年度を持たない表は、「状態が closed でない年度のどれかで admin」の人が編集できる。create_year_from は、呼んだ人を新しい年度の admin にする（year_roles に行を作る）。最初の年度と最初の admin は、オーナーが Supabase の SQL Editor で1回だけ作り、手順を README に書く。表は増やさない。
- **反映先**：02_data.md「権限とRLS」（判定の関数に `private.is_admin_of_any_open_year()` のようなものを足す。権限表の注記）、04_screens_api.md「DB関数（RPC）」の create_year_from。
- **チケット**：T02・T03（関数とテスト）、T09（年度の作成）、T14（README の「年度の始め方」）。
- **状態**：要件定義に反映済み（02「権限とRLS」は T03 の PR、02「設計上の決めごと」の複製は T02 の PR、04 の create_year_from は T03 の PR）。README の手順は T14。

## D-02 テストユーザーとドメイン制限フック（2026-10-28、K-10）

- **決定**：E2E・CI のメール＋パスワードのテストユーザー（管理者・部員・団体代表・未招待）は、supabase/seed.sql で auth.users に直接入れて作る（フックを通らない）。フックが許可するのは学校のドメインだけ。seed は本番に流さず（migrate.yml は `supabase db push` だけ）、本番ではメールログインを無効にする。テストユーザーのメールは予約済みのドメイン（例：`admin@example.test`）にし、実在の人のメールは使わない。
- **反映先**：02_data.md「権限とRLS」（ログインの箇条書き）、05_development.md「ブランチ・レビュー・CI」4。
- **チケット**：T04。
- **状態**：要件定義に未反映。

## D-03 個人情報の範囲と、importer で残す列（2026-10-28、K-05）

- **決定**：
  - DB に置いてよい個人情報は、アプリを使う人（総務・団体代表・閲覧のみ）のメール（invitations と auth.users）と表示名（profiles）だけ。企業など外部の人の個人情報は置かない。SPEC.md「やらないこと」の文言をこの意味に直す。
  - importer は、種類ごとの対応表にある列（団体名・品目・備考・タイムスタンプ）だけを読み、それ以外の列（氏名・学籍番号・電話番号・メールなど）は読まずに捨てる。メールのパターンでの除去（どの列でも）は今の仕様どおり残す。
  - fixtures/r8 には備考を入れない。団体名に個人名（研究室名の教員名など）が入っていないかを T05 で確かめる。
- **反映先**：SPEC.md「やらないこと」、04_screens_api.md「CSV取り込み」、05_development.md「fixtures/r8 の作り方」。
- **チケット**：T04（profiles の表示名）、T05（importer・fixtures）。
- **状態**：要件定義に未反映。

## D-04 学校の Google ドメイン（2026-10-28、00 の未決事項）

- **決定**：学生と教員は同じドメイン。フックの許可ドメインは1つの定数にする。
- **未決のまま**：ドメインの値はまだ受け取っていない。T04 の開始時に確認する（決まっていなければ仮の定数で進め、あとで1行直す）。1〜3年生が外部アプリにログインできるかは、引き続き情報担当への確認待ち。
- **反映先**：00_overview.md「未決事項」の1つ目（「教員と学生でドメインが違うか」を解決済みにする）、02_data.md「権限とRLS」。
- **チケット**：T04。
- **状態**：要件定義に未反映。

## D-05 長机(3人掛)の読み替えと E006（2026-10-28、K-08）

- **決定**：allocate の前処理1（企業以外の長机(3人掛)の申請を長机(2人掛)に1対1で読み替える）を残す。E006 は、長机(3人掛)以外の、申請できない区分の品目（不可机・不可椅子など）の申請だけを対象にする。DB の requests には長机(3人掛)のまま残ってよい。
- **これに伴うこと**：
  - 申請画面は今の仕様どおり、企業以外に長机(3人掛)の入力欄を出さない。CSV の取り込みも今の仕様どおり、取り込むときに長机(2人掛)に読み替える。DB に3人掛が入るのは、API を直接呼んだときと過去のデータだけ。
  - E003・W101（申請との差）と、振り分け画面の「団体別」の申請数は、前処理1を当てた後の申請と比べる。そうしないと、読み替えた団体で長机(3人掛)が不足・長机(2人掛)が過剰と出る。
  - DB のトリガーで申請できない品目を止めるかは T03 で決める。止める場合も、企業以外の長机(3人掛)は例外にする。
- **反映先**：03_allocation.md「前処理」1と「検証コード一覧」（E006 の条件、E003・W101 の比べる相手）、01_rules.md S03 の注記。
- **チケット**：T06・T07、T13（団体別の表示）。
- **状態**：要件定義に未反映。

## D-06 「残す」の行の保存のしかた（2026-10-28、K-02）

- **決定**：keep ルール（S08）の行は、自動実行のたびにルールから作り直す。保存は origin = auto・is_keep = true・pinned = false。前処理では固定行と同じように、需要と在庫から先に差し引く。ルールを無効にすれば、次の自動実行で消える。
- **これに伴うこと**：save_auto_allocations は「auto かつ未固定」の行を消して入れ直すので、keep の行もそこで入れ替わり、二重にならない。管理者が keep の行を手で固定した場合（pinned = true）は fixedRows として入るので、その団体・部屋・品目について、ルールからは固定分を超える分だけを作る。
- **反映先**：03_allocation.md「前処理」3、同「入力と出力」（結果の rows に keep の行を含めること）。
- **チケット**：T06、T03（save_auto_allocations）。
- **状態**：要件定義に反映済み（03「入力と出力」の保存の箇条書きと「前処理」3。T03 の PR）。

## D-07 fixed_request の「申請がなければ」（2026-10-28、K-03）

- **決定**：対象の団体の申請が未提出（request_submissions.submitted_at が null、または行がない）のときだけ、fixed_request の数を需要にする。提出済みなら、0 を含めて申請の数を使い、fixed_request と違えば W106 で知らせる。
- **これに伴うこと**：設営が机(木)を0のまま提出すると、需要は0になる（W106 が出る）。設営の申請は総務が代理入力するか、提出前に確認する運用にする。R8 の fixtures は設営の申請241を含むので、受け入れ基準のテストには影響しない。
- **反映先**：03_allocation.md「前処理」2、同「検証コード一覧」W106。
- **チケット**：T06・T07。
- **状態**：要件定義に未反映。

## D-08 最小変更モードの受け入れ基準（2026-10-28、K-04）

- **決定**：基準を条件つきに直す。「使用不可にした部屋から運んでいた品目に、ほかの場所の余りが足りるなら、その部屋と無関係な行は変わらない。足りないときは、変わった行の数を記録する」。「変わった行」は、（運び元・団体・申請品目・品目）ごとの数が変わったものと定義する（行の id は比べない）。
- **これに伴うこと**：05 の不変条件のテストは、第一セミナーを使用可にして1回解く → 使用不可にする → 最小変更で解く、の手順で行う（R8 の fixtures では第一セミナーが最初から使用不可のため）。SPEC の E2E 手順7（MER）も同じ基準にそろえる。
- **反映先**：SPEC.md「受け入れ基準」「E2E の検証手順」7、05_development.md「不変条件」。
- **チケット**：T06、T14。
- **状態**：要件定義に未反映。

## D-09 表の作りと入力の上限（2026-10-29、DB 設計）

- **決定**：全表（audit_logs を除く）の created_at・updated_at はトリガーが入れ、クライアントの値は使わない。年度の一致は、allocations・deliveries・invitations の複合外部キー `(group_id, year_id) → groups (id, year_id)` で保証する（トリガーにしない）。場所・品目への外部キーは restrict、年度・団体は cascade、記録のためのユーザー参照は set null。自由記述は 2000 字、名前は 100 字、数は 10000 までを CHECK で止める。
- **理由**：複合外部キーは、トリガーより確実でダンプからの復元でも壊れない。上限は、団体代表・部員が書ける列で無料プランの 500MB を使い切らせず、解けない申請や整数のあふれを防ぐため。
- **反映先**：02_data.md「テーブル定義」の前書きと DDL。
- **チケット**：T02。
- **状態**：要件定義に反映済み（T02 の PR）。

## D-10 DB が入れる値（2026-10-29、K-25）

- **決定**：stocks.counted_by・counted_at、request_submissions.updated_by・submitted_at は、ログインしている人（auth.uid() がある）の書き込みでトリガーが上書きする。画面から送らない。seed や SQL Editor（auth.uid() が null）では入れた値のまま。
- **理由**：他人の名前や過去の日時を書かせないため。
- **反映先**：02_data.md「設計上の決めごと」、04_screens_api.md「在庫入力」。
- **チケット**：T02、T10・T11。
- **状態**：要件定義に反映済み（T02 の PR）。

## D-11 監査ログのトリガー（2026-10-29、K-16）

- **決定**：対象は stocks・requests・request_submissions・rules・allocations・substitution_consents・years・year_roles に、room_years・groups・group_members・rooms・items・distance_overrides を足した14表。invitations（メール）と profiles（氏名）は個人情報を写さないので記録しない。トリガー関数は SECURITY DEFINER・`search_path = ''`（audit_logs には誰にも書き込みの権限を与えないため）。updated_at と版の列しか変わらない更新は書かない。year_id・group_id を列に持ち、団体の連鎖削除で消えた行にも、削除前のトリガーが置いた年度（`app.deleted_group_years`）を入れる。
- **理由**：部員の在庫入力で audit_logs への書き込みが失敗しないように。履歴を年度・団体で絞るため。年度の記録が null になると、別の年度の admin に見えてしまうため。
- **反映先**：02_data.md「設計上の決めごと」。
- **チケット**：T02、T03（audit_logs の読み取りのポリシー）。
- **状態**：要件定義に反映済み（T02 の PR）。

## D-12 振り分けの版 years.allocation_version（2026-10-29、P-01）

- **決定**：版は「振り分けの入力と結果の版」。年度が allocating の間に、allocate の入力になる表（stocks・room_years・groups・requests・request_submissions・rules・substitution_consents・allocations と、年度をまたぐ rooms・items・distance_overrides）が変わるたびに、文ごと（遷移表）のトリガーで1増やす。状態の遷移でも増える（T03）。allocating 以外の年度は増やさない。画面は版をほかのデータより先に読み、save_auto_allocations と確定に渡す。
- **理由**：計算・検証している間に入力が変わった結果を保存・確定しないため。受付中の大量の書き込みで年度の行を取り合わないため。
- **反映先**：02_data.md「設計上の決めごと」。
- **チケット**：T02、T03、T06・T13。
- **状態**：要件定義に反映済み（T02 の PR）。

## D-13 確定中・終了の守りとロック（2026-10-29）

- **決定**：confirmed・closed の年度では、確定済みのデータに E001・E002・E005 を作る直接の書き込み（団体の削除と使用場所・区分・年度の変更、振り分けのある部屋の使用不可化、振り分けの合計より少ない在庫）と、allocations の変更をトリガーで止める（invalid_state）。closed ではルールの memo 以外も変えられない。守りのトリガーは `private.lock_year_guard` で年度の行をロックしてから状態を読む。allocating は最初から `for no key update`、それ以外は `for share nowait`（取れなければ `for no key update` で待つ）。
- **理由**：確定後に RPC を通らない書き込みで error が生じるのを防ぐ。allocating で `for share` から引き上げると、管理者どうしの同時の書き込みがデッドロック（40P01）になる（設計時に再現済み）。
- **反映先**：02_data.md「設計上の決めごと」。
- **チケット**：T02、T03。
- **状態**：要件定義に反映済み（T02 の PR）。

## D-14 申請できない品目の止め方（2026-10-29、D-05 の DB 部分）

- **決定**：requests のトリガーで止める。count が1以上で、品目の requestable_categories に団体の区分がなければ E006。ただし code = long_desk_3 は例外（allocate の前処理で長机(2人掛)に読み替える）。count = 0 は通す。団体・品目が見つからなければ外部キーのエラー（23503）に任せる。
- **理由**：API を直接呼ぶ団体代表が不可机・不可椅子を申請できないようにするため。
- **反映先**：02_data.md「設計上の決めごと」。
- **チケット**：T02、T07。
- **状態**：要件定義に反映済み（T02 の PR）。

## D-15 呼ぶ側に順序を求めない正規化（2026-10-29）

- **決定**：distance_overrides の建物の組は、BEFORE トリガーが C の照合順序（コードポイント順）で小さい方を building_a に入れ替える。CHECK も同じ照合順序で `building_a < building_b`（同じ建物どうしは拒否）。rules.year_id は更新で変えられない。
- **理由**：DB の照合順序と JavaScript の並び順が違うと、画面が並べ替えて送っても CHECK で弾かれる。rules.year_id を移せると、ポリシーの with check に頼るだけでは、ルールを closed の年度へ移せてしまう。
- **反映先**：02_data.md DDL と「設計上の決めごと」。
- **チケット**：T02、T03・T09。
- **状態**：要件定義に反映済み（T02 の PR）。

## D-16 年度・団体の付け替えを止める（2026-10-29）

- **決定**：年度を持つ表の year_id（room_years・stocks・groups・year_roles・invitations・allocations・slots・deliveries）と、団体を主キーに含む表の group_id（group_members・request_submissions・requests・substitution_consents）は、更新で変えられない（BEFORE UPDATE のトリガー `check_immutable`、`invalid_input`）。rules.year_id は D-15 のとおり別のトリガー。allocations・deliveries・invitations の group_id は、複合外部キーで年度が固定されるので同じ年度の別の団体にだけ動かせる。anon・authenticated には public・private の表・シーケンス・関数の権限を与えない（シーケンスの revoke を足し、PUBLIC の execute も含めて pgTAP で棚卸しする）。
- **理由**：D-13 の確定中・closed の守りと D-12 の版の増分は、更新後の行の年度しか見ない。年度と団体を一緒に書き換えると複合外部キーも通るので、確定中の年度から振り分けを抜き出せた。old table と new table の両方を見る案より、列を固定するほうが単純で、年度をまたぐ書き換えの用途もない。
- **反映先**：02_data.md「設計上の決めごと」。
- **チケット**：T02、T03（RPC は year_id・group_id を更新しない）。
- **状態**：要件定義に反映済み（T02 の PR）。

## D-17 権限の範囲（2026-10-29、DB 設計・T03）

- **決定**：
  - closed の年度は読み取り専用。例外はルールの memo（admin。トリガーで memo 以外を止める）と、運搬・返却のチェック（RPC check_delivery、admin・staff）。01 の「年間の業務の流れ」9 はそのまま成り立つ。ロールと団体代表を外すこと（remove_role、remove_group_member）と未使用の招待の取り消し（revoke_invitation）も closed でできる（卒業した admin などの権限を残さないため）。ロールを付ける・変えるのは set_role（role は必須）、外すのは remove_role に分ける（外す操作を生成した型で表せるように。set_role の null は invalid_input）。
  - staff・団体代表・viewer は、自分の year_roles・group_members の行と、自分のメール（本人のものと確かめられる今のメール。D-17a）あての invitations を読める（02 の権限表の staff の「—」は書き漏れとみる）。招待は、どこかの年度のロールか団体代表がある間だけ読める。ロールと団体代表は兼ねられ、権限は足し合わせになる。
  - profiles は、自分と、自分が admin・staff である年度のメンバー（ロールか団体代表の行がある人）の分だけ読める。
  - 前年度の数は RPC で読む：previous_year_stocks（admin・staff）、previous_year_requests（admin。団体名と数だけ）。前年度にロールがなくても、今の年度のロールで複製元の数を読める。個人情報は含まない。
  - 招待は、メールを確認済みで削除されていないアカウントにだけ付ける（invite・accept_my_invitations。auth.users のトリガーは T04）。画面はログインのたびに accept_my_invitations を呼ぶ。「今のメールが本人のものと確かめられるアカウント」に狭めた（D-17a）。
  - 権限の判定関数は、ポリシーが呼ぶ 12 個だけにする（設計の 14 個から、使われていない private.year_role と private.is_request_open を消した）。authenticated に execute を与えるのはこの 12 個だけで、RPC の補助とトリガー関数には与えない。D-17a で invitations_select が呼ぶ private.my_verified_email を足して 13 個にした。
  - 権限表の全セル（20 の表・ビュー × 操作 × 年度の6つの状態 × 6 人）を pgTAP で確かめる。
  - 確定中・closed の守りのトリガー（room_years・stocks・groups）は、RLS の対象のロール（anon・authenticated）で書いているとき、最初にポリシーと同じ条件で「書けるか」を確かめ、書けなければ年度の行をロックせずに拒否を RLS に任せる（BEFORE ROW トリガーは with check より先に動くので、拒否される insert の繰り返しで admin の RPC を待たせられないように）。RLS の判定は変えない。
  - 変えられない列のトリガー（check_immutable）は SECURITY DEFINER にする（authenticated の書き込みでも 42501 でなく invalid_input を返す）。
- **理由**：どれも権限を狭めるか、読めるのが自分の行・数と団体名だけで、権限を広げる危険がない。closed を読み取り専用にしても、01 で closed に行う作業（メモ、返却）は残る。
- **反映先**：02_data.md「権限とRLS」（本文・権限表・表の下の説明・箇条書き）、04_screens_api.md「DB関数（RPC）」。
- **チケット**：T03、T04（トリガーでの招待の受け入れ）、T09（ユーザーの画面）、T10（前年の数）。
- **状態**：要件定義に反映済み（T03 の PR）。

## D-17a 招待を受け入れる「本人のメール」（2026-10-29、T03・T04、T03 の security の指摘）

- **決定**：
  - 招待を付ける（invite のその場の受け入れ・accept_my_invitations。T04 の auth のトリガーも同じ）のは、`private.verified_email(user_id)` が値を返すときだけ。条件は、削除されていない・email がある・email_confirmed_at がある・メールの変更の途中でない（email_change が空）、かつ auth.identities に auth.users.email と同じメール（小文字で比べる）の identity があり、それが Google の identity か、identity_data の email_verified が true（真偽値）の email の identity であること。招待のメールはこの値と比べる。
  - 自分あての招待の読み取り（ポリシー invitations_select）も同じ判定にする。JWT の email（auth.jwt() ->> 'email'）とは比べない。ポリシーは、自分の分だけを返す判定関数 `private.my_verified_email()` を呼ぶ（authenticated に execute を与える判定関数は 13 個になる）。`private.verified_email` は任意の user_id のメールを返すので、authenticated には execute を与えない。
- **理由**：auth.users.email_confirmed_at は最初の確認の時刻で、あとでメールアドレスを変えても null に戻らない。メールの変更に確認が要らない設定（や GoTrue の版の違い、SQL・管理 API での変更）だと、ログイン済みの人が自分の email を招待された人のアドレスに変えて、その人あての招待（admin を含む）を受け取れ、JWT の email もそのアドレスになるので、その人あての未使用の招待（年度・ロール）を読めた。identity_data は利用者が書き換えられない（user_metadata と違う）。Google の identity のメールは Google が持ち主を確かめたアドレスで、ログインのたびに Google の値で上書きされる。GoTrue は、受信箱で確かめたメールの変更のときだけ email の identity を新しいアドレスと email_verified: true に書き換える。メールの変更の途中を除くのは、確かめ終わる前の状態で判断しないため。T03 だけをマージしたときにも穴が残らないよう、T04 から T03 に移した（auth のトリガーと本番の Auth の設定は T04）。
- **反映先**：02_data.md「権限とRLS」（権限表の下の説明、招待の受け入れの箇条書き）、04_screens_api.md「DB関数（RPC）」の invite・accept_my_invitations。
- **チケット**：T03（verified_email・invite・accept_my_invitations・invitations_select）、T04（auth のトリガー、本番の Auth の設定、テストユーザーの identity）。
- **状態**：要件定義に反映済み（T03 の PR）。

## D-18 年度の複製と確定（2026-10-29、DB 設計・T03）

- **決定**：
  - create_year_from を呼べるのは、複製元の年度の admin だけ（複製元が closed でもよい）。複製元は最新の年度（それを複製元にした年度も、1日目が同じか後の年度もない）に限る。新しい年度の1日目は複製元より後。卒業する admin は年度を closed にする前後に remove_role で外す。update_year で1日目を変えるときも、複製元（prev_year_id）より後で、この年度を複製元にした年度より前でなければならない（invalid_input。崩すとどの年度も最新でなくなり、次の年度を作れなくなる）。最新の年度の admin が誰もいなければ、オーナーが SQL Editor で足す（D-01 の手順）。
  - 確定（set_year_status の confirmed）には理由と、検証に使った版（p_base_version）が要る。版が違えば conflict。確定の解除にも理由が要る。受付開始（requesting）には未来の締切が要る。状態の遷移のたびに版を増やす。
  - 画面（ダッシュボードの確定ボタン、振り分け画面）は、ほかのデータより先に years.allocation_version を読み、その版で検証し、確定のときにその版を渡す。conflict なら読み直して検証し直し、結果を見せてからもう一度押してもらう（自動で再送しない）。
  - 1日目（festival_start）は有限で現実的な範囲（2000-01-01〜2200-12-31）だけを受け付ける（years の CHECK `years_festival_start_check`。update_year・create_year_from は違反を invalid_input（field: festival_start）にする）。infinity や date の上限は、前後の年度との比較では止まらず、その年度を closed にすると、それより後の1日目がなくなって誰も次の年度を作れなくなる（毎年の流れが壊れ、画面の日付の表示も壊れる）ため。
  - W102 は今の仕様どおり warning のままで、確定を止めない。了承の後に置き換えが了承した台数より増えたら W102 として出す。DB は了承の状態を勝手に変えない。
- **理由**：古い年度やほかの年度の admin が、年度を作って権限を取り戻したり、ロールのない年度を複製して読んだりできないようにするため。検証していない振り分けや入力のまま確定しないため。
- **反映先**：02_data.md「年度ステータスの状態遷移」・years の DDL・「設計上の決めごと」（前年度の複製）、04_screens_api.md「ダッシュボード」「振り分け」「マスタ設定」「DB関数（RPC）」、03_allocation.md「検証コード一覧」。
- **チケット**：T03、T09・T13（画面）。
- **状態**：要件定義に反映済み（T03 の PR）。

## D-19 RPC の入力・エラー・提出（2026-10-29、T03）

- **決定**：
  - 申請の提出は RPC submit_requests（申請と提出を1トランザクションで書く）。D-07 は変えない。
  - update_requests_after_deadline の p_submission は `{ submitted: true, submittedAt, note }`（どれも省略可。ほかのキーは invalid_input）。submitted は true だけを受け付け、提出済みにする（最初の提出日時を保つ）。未提出には戻さない（`submitted: false` は invalid_input）。未提出に戻すと D-07 で需要が fixed_request に変わり、振り分けが変わるため。どうしても戻すときは、確定の前に SQL Editor で直す（記録は監査に残る）。
  - submittedAt（オフセットつきの ISO 8601 の日時。未来・特別な値は invalid_input）を渡すと、提出済みにして submitted_at をその値にする（提出済みでも置き換える）。CSV の取り込み（T11）でフォームのタイムスタンプを残し、K-27 の申請順をフォームの提出順にするため（ロジック設計の申し送り）。RPC はその書き込みの間だけ transaction-local の `app.keep_submitted_at` を立て、提出の記録のトリガーは値を now() に置き換えない。admin だけが呼べる RPC なので、団体代表は日時を偽れない。submit_requests と直接の書き込みは今までどおり now()。
  - RPC のトップレベルの型つきの引数（uuid・enum・date・integer）は PostgREST が関数の前に変換するので、形が違うと 22P02・22007 などがそのまま返る。画面は zod で先に確かめ、22 で始まる SQLSTATE は「入力の形が違う」として扱う。
  - RPC の中で起きた形の誤り（SQLSTATE のクラス 22）と CHECK 違反（23514）は、すべての書き込みの RPC で invalid_input に直す（save_auto_allocations・set_consent・submit_requests・update_requests_after_deadline・check_delivery に例外ブロックを足した。save_auto_allocations は数の上限 10000 も先に確かめる）。
  - revoke_invitation は、ロールを確かめてから招待の行をロックする（ロールのない人に行ロックを取らせない）。招待が見つからなければ forbidden（有無を漏らさない）。
  - update_year は、年度名（一意の列）を変えるときだけ別の文で書く。SET に年度名があると、値が同じでも行のロックが外部キーの確認（FOR KEY SHARE）とぶつかる強さになり、その年度を参照する行の insert（部員の在庫入力など）を update_year のコミットまで待たせ、デッドロックの元になる（ローカルの Supabase で再現して確かめた。notes/T03.md）。
  - rules.year_id の付け替えは、ポリシーの with check（更新後の行しか見ない）ではなく、T02 のトリガー guard_rules で止める（D-15）。T03 は pgTAP で、両方の年度の admin でも closed の年度へ移せないことを確かめる。
- **理由**：画面に生の SQLSTATE を返さず、エラーの扱いを message のコードだけで決められるようにするため。提出の状態を誤って戻して振り分けが変わるのを防ぐため。
- **反映先**：04_screens_api.md「DB関数（RPC）」の表と箇条書き。
- **チケット**：T03、T11（申請一覧・締切後の修正）。
- **状態**：要件定義に反映済み（T03 の PR）。

## D-19a 距離の値の範囲（2026-10-29、T03、ロジック設計の申し送り）

- **決定**：rooms.extra_cost と distance_overrides.cost は 0〜20 の整数にする（CHECK。T02 の「0 以上」を T03 のマイグレーションで狭める）。allocator の入力（rooms.extraCost・distanceOverrides.cost）の範囲と同じ。
- **理由**：DB に範囲外の値が入ると、allocate が invalid_input で止まり、振り分けが動かなくなるため。DB で先に止める。
- **反映先**：02_data.md の DDL（rooms・distance_overrides）。
- **チケット**：T03、T09（マスタ設定の入力）。
- **状態**：要件定義に反映済み（T03 の PR）。

## 提案（未確定。各チケットの計画モードで確認し、反対がなければ採用）

- **P-01**（K-06・K-07、T02・T03）：**採用**（T02・T03 で実装。02・03・04 に反映済み。年度の版は D-12）。RPC を足す（update_year、set_role・remove_role、revoke_invitation、remove_group_member）。set_consent で status を asked にしたとき、その時点の置き換え台数を RPC が count に入れる。save_auto_allocations は年度の一致・E002・E005 も確かめる。years に allocation_version（整数）を持たせ、振り分けを変える RPC ごとに1増やし、save_auto_allocations は入力を作ったときの版と違えば conflict にする。
- **P-02**（K-12、T06）：コストを整数にそろえ、使用場所以外からの移動に1を足して、同点なら「残す」が選ばれるようにする（例：d′ = 100·d ＋ 1、休憩所への不可椅子は −10、W と μ もこの単位で計算し直す）。
- **P-03**（K-17、T04・T09）：共通レイアウト（ナビゲーション、ロールによる表示の切り替え、読み込み中・空・権限なしの3状態）を T09 から T04 に移す。

## 引き続き未決（00_overview.md「未決事項」と、キックオフで見つけたもの）

- 1〜3年生（18歳未満の指定がある人）が外部アプリにログインできるか（情報担当に確認）。
- 学校のドメインの値（D-04）。
- Google Cloud の OAuth クライアントを、学校の Workspace の中に作れるか、誰の持ち物にするか（K-11。00 の未決事項に足す）。
- Supabase 無料プランの一時停止からの再開期限（90日か1年か）を管理画面で確かめる（K-09）。
- 学生会・教員の承認、GitHub と Supabase のオーナー、引き継ぐ後輩、申請の一本化、建物・階と距離の値、校内分散の団体の運び先（00 のとおり）。
