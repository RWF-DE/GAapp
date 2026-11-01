# FU2 作業記録（T15〜T18 のマージの後の片付け）

ブランチ fix/after-t18-cleanup（main 0bf87a4 から。T15・T15b・T16・T17・T18 は PR #19〜#23 で main にマージ済み）。05 のチケット表のチケットではなく、T15〜T18 の記録に残った「残り」「確かめていないこと」のうち、リードが決めた範囲（1〜6）を1本のブランチで直す片付け。push と PR はまだ（リードの指示）。

**状態（2026-11-01）**：範囲の 1〜6 を5つのコミットで直し、最後にきれいな状態（`supabase db reset` の直後）から全部のチェックを流して、すべて通った（このコミット「test: 片付けの後のスクリーンショットと記録」。下の「コマンドと結果」）。T16 の 12 枚と T18 の 16 枚を撮り直して見た。AppLink の変更（開けないリンクを class のない文字に）が写るのは T18 の4枚だけで（T18 の回避と同じ見た目）、ほかのチケットの絵には写らないので撮り直していない（下の「AppLink の変更で絵が変わる撮影」）。残りは下の「確かめていないこと・残り」。

## 目的

T15〜T18 のマージ（PR #19〜#23）の後に残った次のものを、1本のブランチでまとめて直す。

- 文書の状態のずれ（05・00・D-47〜D-54・各記録の「作業中」「未マージ」）と、本番を使い始める前に流すマイグレーション（0009〜0015）の手順。
- 機能の名前のずれ（計画のときの「予定と締切」と、画面の「締切と予定」）と、ナビの見出しと項目に同じ「締切と予定」が縦に並ぶこと。
- 開けない立場に、押せない文字がリンクの見た目（下線・色）で出ること（共有の部品 AppLink）。
- お知らせのダイアログとルールのシートで、読み直しに失敗した後の「読み直す」が入力の元の版を進めず、次の保存がまた止められること（知らせの文と動きが合わない）。
- T18 で締切と予定の欄の選び方が変わって古くなった、T16 の撮影の期待値。

## 範囲と直したこと

| 範囲 | 直したこと | コミット | 細部の記録 |
| --- | --- | --- | --- |
| 1. マージの後の状態 | 05 のチケット表の T15・T15b・T16・T17・T18 を「完了」にした（マージした PR と、人に残るもの：本番 DB への 0009〜0015 の適用、総務部門長・総務副部門長の招待）。00 のお知らせ・締切と予定の行、D-47〜D-54 の状態（「実装した（マージ済み。PR #n）」）、notes/T15.md〜T18.md の冒頭の状態も直した。README の 5 に、本番を使い始める前に流す 0009〜0015 の一覧と順、流すときの注意（0013 の前に兼任の問い合わせ、書き込んでいる人がいないときに流す、role_overlap は直してから流し直す、55P03・40P01 はそのまま流し直す）と、流したファイルの確かめ方（supabase_migrations.schema_migrations）を書き、docs/runbook.md の 1.4 から指した | 58cfffc「docs: T15〜T18 のマージの後の状態と名前をそろえる」 | notes/T18.md「マージの後の直し」の 1・2 |
| 2. 機能の名前 | 「締切と予定」にそろえた（01 の機能の行、SPEC.md、04 の直接の書き込みの一覧と (B1) の行、D-51・D-54 の見出し）。02・0015・pgTAP と T18 の前半の記録は、表の項目を「予定と締切」と呼んだまま（notes/T18.md の判断の 1）。README と runbook には古い名前がなかった | 58cfffc（同じ） | 同上 |
| 3. ナビの項目と h1 | /calendar のナビの項目と画面の h1 を「締切と予定の一覧」にした（お知らせの「お知らせ一覧」と同じ形。ナビの見出し・機能の名前・ダッシュボードの欄は「締切と予定」のまま）。04・00・01・D-54 の注を先に直し、Vitest と E2E のナビの期待値（foundation・auth・support/roles・t15b・t16、support/calendar の openCalendar）を直した | bcc2770「fix(T18): ナビの項目と画面の題名を「締切と予定の一覧」にする」 | notes/T18.md の 3 |
| 4. T16 の撮影の期待値 | e2e/shots/T16.shots.ts の締切と予定の欄の件数を T18 の選び方（これからの 30 日と過ぎた締切を 8 件まで）に合わせた（シナリオは変えていない）。T16 と T18 の絵を撮り直した | 1843bf1「test(T16・T18): 撮影の締切と予定の件数を T18 の選び方にそろえ、スクリーンショットを撮り直す」と、このコミット（突き合わせ・撮り直し・この記録） | notes/T16.md「マージの後の直し」、下の「4. T16 の撮影の期待値の突き合わせ」 |
| 5. AppLink | 開けない立場（canOpen が偽）で fallback がなければ、class のない `<span>` の文字（下線・色のない、ただの文字）にした。先に落ちる Vitest を3件書いた。締切と予定の一覧の回避（`fallback={item.title}`）を外した。04「共通レイアウト」と画面の設計に「開けない立場には、リンクの見た目も付けない」を足した | 64c5a79「fix: 開けないリンクを、リンクの見た目のない文字にする」 | notes/T09a.md「マージの後の直し」、下の「AppLink の変更で絵が変わる撮影」 |
| 6. 読み直しに失敗した後の「読み直す」 | お知らせのダイアログ（rereadRejectedNoticeSave）とルールのシート（runRuleWrite の unread の結果の reread＝rereadRejectedRuleWrite）の「読み直す」を、T18 の rereadRejectedSave と同じ決め方にした：押したときの入力と同じなら「保存されていました」、変わっていれば conflict の知らせにして版を進める（次の1回の保存で上書きできる）、なくなっていれば「見つかりません」で「保存」を押せない、また読めなければ toast で知らせて版は進めない。読み直す間は欄・保存・閉じる・読み直すを止める。先に落ちるテストを書き（直す前に notices 4 件・rule-write 6 件・rule-form-sheet 5 件が落ちた）、04 の「お知らせ一覧」「ルール」と (B1) を先に直した | 09ec32b「fix(T17・T12): 読み直しに失敗した後の「読み直す」で、版を進めて読み直す」 | notes/T17.md・notes/T12.md「マージの後の直し」 |

## 4. T16 の撮影の期待値の突き合わせ

e2e/shots/T16.shots.ts の期待値（1843bf1）を、欄の選び方のコードとシナリオの日時に突き合わせた。

- 選び方：apps/web/lib/modules/portal.ts の upcomingDated（PORTAL_DATED_DAYS＝30、PORTAL_DATED_LIMIT＝8）。これからは「終わっていない（isDatedPast でない）もので、開始の日が今日〔Asia/Tokyo〕から 30 日後まで」、余った枠に過ぎた締切（kind が deadline で isDatedPast）を期限の新しい順に足す。過ぎた予定（event）は出さない。
- 机椅子の項目：apps/web/lib/modules/furniture/portal.ts。受付開始は予定（event）、申請の締切は締切（deadline）、祭の日（前々日・前日・1日目・2日目）は日付だけの予定。
- シナリオ：e2e/support/db.ts の requestWindow。closed は受付開始が 30 日前・申請の締切が昨日、open（既定）は受付開始が昨日・申請の締切が今＋30 日。1日目は撮るときだけ festivalIn で今日（Asia/Tokyo）から N 日後にする。

| テスト（絵） | シナリオ | 期待値 | 突き合わせ |
| --- | --- | --- | --- |
| 管理者（portal-admin-pc・portal-loading-pc。portal-widget-error-pc も同じ年度） | 受付中・受付期間が閉じた、1日目は 14 日後 | 5 件。申請の締切は「締切を過ぎました」 | 祭の4日（12〜15 日後）は 30 日の中。昨日の申請の締切は過ぎた締切で余りの枠に入る。30 日前の受付開始は過ぎた予定で出ない |
| 総務部門長（portal-head-pc） | 振り分け中・受付期間が閉じた、1日目は 2001 年 | 1 件（「締切を過ぎました」）。空の文は出ない | 祭の4日は過ぎた予定で出ない。前の期待値（空の文）は T16 の選び方のもの |
| 総務部門員（portal-staff-mobile） | 受付中、1日目は 40 日後 | 1 件（申請の締切） | 今＋30 日の申請の締切は、時刻が今と同じなので、撮る時刻によらず今日から 30 日後の日になって入る。祭の4日（38〜41 日後）は 30 日の外 |
| 閲覧のみ（portal-viewer-pc・portal-viewer-mobile） | 確定・受付期間が閉じた、1日目は 7 日後 | 5 件 | 祭の4日（5〜8 日後）と、昨日の申請の締切 |
| 団体代表（portal-rep-mobile・portal-rep-allocating-mobile） | 受付中・1日目は 40 日後／振り分け中・受付期間が閉じた・1日目は 14 日後 | 件数は確かめていない（前から） | 写るのは 1 件（申請の締切）と 5 件（過ぎた申請の締切と祭の4日）。撮り直した絵で見た |

どれも合っていた。撮影（下の「コマンドと結果」）もこの期待値のまま通った。

## AppLink の変更で絵が変わる撮影

AppLink の変更（64c5a79）で絵が変わるのは、撮るときに「開けない立場で、fallback を渡していない AppLink」が写っているものだけ（開けるときの形と、fallback を渡したときの形は変えていない）。className に下線・色だけでなく行のレイアウトを渡す使い方（portal の todo-list・notice-digests、stocks-screen など）や、Button の asChild で AppLink にボタンの class が渡る使い方（rep-home・module-cards・在庫の画面）もあり、そこで開けないことがあると、変更の後は形のない文字になる（今はどれも、開けるときだけ出すか、呼ぶ側が開けるかを確かめてから行き先を渡す）。notes/T09a.md の使っている所の表はコードを読んで確かめたものなので、撮影を全部流して、実際にどの絵に写るかも数えた。

- やり方（コミットしない一時的な印）：AppLink の「開けない・fallback なし」の `<span>` に印（`data-fu2-unopenable` に呼ぶ側の className、`data-fu2-href` に行き先）を付け、e2e/support/shots.ts の shoot が撮る直前に、その印の数・文字・画面に写るかを記録する形にした。ロックの中で `supabase db reset` → REST の待ち → `pnpm build:e2e` → `E2E_PORT=3360 pnpm e2e:shots`（全部のチケット）を流し、終わってから2つのファイルを `git checkout` で戻した。この回で撮った絵も git で戻した（印のある書き出しで撮ったもので、ほかのチケットの絵は年度の名前と日時だけが変わるため）。
- 結果：撮影 102 件（setup 6 件を含む）のうち 99 件が通り、3 件は設計どおり飛んだ（T09a の雛形のページ。各チケットの画面に置き換わったので test.skip。前に撮った絵のまま）。撮った絵は 262 枚（T09 46・T09a 8・T10 25・T11 34・T12 28・T13 50・T14 13・T15b 13・T16 12・T17 17・T18 16）。印が写っていたのは T18 の4枚だけ：
  - calendar-viewer-pc・calendar-viewer-mobile（閲覧のみ）：机椅子の申請の締切と祭の4日の題名（5つ）。
  - calendar-rep-pc・calendar-rep-mobile（店長）：祭の4日の題名（4つ。申請の締切は /request へのリンクのまま）。
  - どれも行き先は机椅子の入口（/furniture。calendar-list.tsx の moduleHref は、機能が行き先を決めない項目に機能の入口を使う）で、className は calendar-list.tsx の `underline underline-offset-2 hover:text-primary`。T18 では `fallback={item.title}` で同じ見た目（下線のない文字）にしていたので、絵の形は T18 のパート B の撮影と同じ。
- ほかのチケット（T09〜T17）の絵には「開けない・fallback なし」の AppLink は写っていないので、撮り直していない（notes/T09a.md の使っている所の表と同じ結論）。T16 のダッシュボードの締切と予定の欄（dated-list）は fallback（行の形の div）を渡しているので変わらない。

## コマンドと結果（2026-11-01）

共有のローカル Supabase に触れるものは db-lock.sh のロックの中で流し、どの回も `supabase db reset` から始めた（`E2E_PORT=3360`・`E2E_BASEPATH_PORT=3361`）。上の AppLink の数え方の回（00:40〜00:46 UTC）と、下の確かめの回（00:46〜00:55 UTC）の2回。DB に触れないものはロックの外で、その前に流した（00:37〜00:40 UTC）。コードは 1843bf1 のまま（このコミットで変えたのは notes/ だけ）。

| コマンド | 結果 |
| --- | --- |
| `pnpm lint` | 通った（エラー・警告なし） |
| `pnpm typecheck` | 通った（ルートと 5 つの workspace） |
| `pnpm test` | 142 ファイル・2,043 件が通った（todo 2 は前から） |
| `pnpm build` → `pnpm check:no-test-login` | 静的書き出しが通り、テスト用ログインは含まれていない |
| `pnpm check:emails` | 1,039 ファイルにメールアドレスはない（この記録を足した後にもう一度流した結果は下の最後の行） |
| `node scripts/first-load-js.mjs`（と `--json`） | gzip の合計：/ 337,204・/calendar/ 355,675・/notices/ 359,034・/stock/ 344,730・/request/ 339,499・/my/ 330,782・/login/ 282,676・/history/ 340,255 バイト（1843bf1 の記録〔notes/T18.md の「マージの後の直し」〕と同じ）。/stock・/request・/my は T14 の上限（394.8 KB）以内 |
| （ロック）`supabase db reset` | 0001〜0015 と seed（21 秒） |
| （ロック）`supabase test db` | 14 ファイル・8,767 件がすべて通った（T18 の最後と同じ。DB は変えていない） |
| （ロック）`pnpm check:types` | database.types.ts は DB と一致 |
| （ロック）`notify pgrst, 'reload schema'` と REST の待ち | 1 回目で、匿名の `POST /rest/v1/rpc/set_group_member_role`（名前つきの引数）が 401 |
| （ロック）`pnpm build:e2e -- --base-path /GAapp` → `pnpm build:e2e` | 通った（14 秒・14 秒） |
| （ロック）`REQUIRE_LIBREOFFICE=1 E2E_PORT=3360 pnpm e2e` | chromium 188 件（5.5 分。setup 6 件を含む）・serial 15 件（56.1 秒）がすべて通った（retry・flaky なし）。ナビの期待値を直した foundation・auth・t15b-roles・t16-portal と、openCalendar を使う t18-calendar を含む。お知らせ（t17-notices）とルール（t12-rules）の E2E も、直したダイアログとシートのまま通った（読み直しに失敗した後の「読み直す」そのものは Vitest で確かめている）。通しの流れの LibreOffice の再計算：シート 8、数式エラー 0・在庫超過 0・要確認 0 |
| （ロック）`E2E_PORT=3360 E2E_BASEPATH_PORT=3361 pnpm e2e:basepath` | 2 件が通った（db-setup と basePath のスモーク） |
| （ロック）`E2E_PORT=3360 pnpm e2e:shots --grep "T16 "` | 12 件（setup 6・T16 の撮影 6。33.3 秒）が通り、notes/T16/ の 12 枚を撮り直した |
| （ロック）`E2E_PORT=3360 pnpm e2e:shots --grep "T18 "` | 9 件（setup 6・T18 の撮影 3。38.0 秒）が通り、notes/T18/ の 16 枚を撮り直した（event-dialog-timed-mobile は前と同じ絵で、ファイルは変わらない） |
| （ロック）psql：後片付けの確かめ | 確かめの回の reset の直後と、2回のロックの回の終わり（E2E・撮影の後）で、years 1・groups 1・events 0・notices 0・auth.users 6・profiles 6・year_roles 4・group_members 1（シナリオの年度・項目・使い捨てのユーザーは残らない）。rooms は 4 → 65（E2E の db-setup が入れる年度をまたぐ表） |
| `pnpm check:emails`（この記録と撮り直した絵を git に入れた後。追跡するファイルを調べるので、add の後に流した） | 1,040 ファイルにメールアドレスはない（notes/FU2.md の分だけ増えた） |

## 撮り直したスクリーンショットと見たこと

notes/T16/ の 12 枚（どれも見た）：

- どの絵もナビの見出し「締切と予定」の下の項目が「締切と予定の一覧」。
- portal-admin-pc・portal-loading-pc・portal-widget-error-pc：締切と予定は、過ぎた申請の締切（締切の印・「10/31（土）09:54」・注意の色の「締切を過ぎました」・「>」）と祭の4日（11/13〜11/16、「あと 12 日」〜「あと 15 日」）の5件と「締切と予定の一覧へ」。読み込み中（要対応とカードの骨組み）と机椅子の失敗（要対応とカードの「もう一度」）の絵でも、締切と予定の欄は出たまま。
- portal-head-pc：締切と予定は過ぎた申請の締切の1件と「締切と予定の一覧へ」（空の文は出ない）。2001 年の年度なので「最新でない年度」の帯が出る。
- portal-staff-mobile：締切と予定は申請の締切（「12/1（火）09:55」「あと 30 日」）の1件。幅 390px ではみ出さない。
- portal-viewer-pc・portal-viewer-mobile：過ぎた申請の締切と祭の4日（5〜8 日後）の5件。閲覧のみはどの行も行き先がない（「>」の印がない。dated-list の fallback の行の形のまま）。
- portal-rep-mobile：申請の締切の1件（「>」つき。申請へ）。portal-rep-allocating-mobile：過ぎた申請の締切（「>」つき）と、行き先のない祭の4日の5件。
- nav-grouped-pc・nav-grouped-mobile・furniture-pc：崩れ・はみ出しはない（中身は前と同じで、年度の名前と日時だけが変わる）。

notes/T18/ の 16 枚（どれも見た）：

- 一覧の h1 は「締切と予定の一覧」（スマホでも1行に収まる）。ナビは見出し「締切と予定」の下に「締切と予定の一覧」（開いている画面として強調）。
- calendar-head-pc・calendar-head-mobile・calendar-staff-pc・calendar-staff-mobile・calendar-past-head-pc：機能の日付の題名（申請の締切・祭の4日、過去も表示では受付開始も）は下線つきのリンク。「締切・予定を登録」と「編集」「削除」は総務部門長だけ。
- calendar-viewer-pc・calendar-viewer-mobile：機能の日付の題名（申請の締切と祭の4日）は下線のない文字（AppLink の既定）。対象の印・絞り込み・書くためのものはない。
- calendar-rep-pc・calendar-rep-mobile：申請の締切だけが下線つきのリンク（申請へ）で、祭の4日は下線のない文字。
- calendar-closed-head-pc：終了した年度の帯と「終了した年度のため、締切と予定は読むだけです」、操作はない。
- portal-dated-head-pc：締切と予定の欄は 8 件（過ぎた締切1件と、30 日の中の7件。33 日後からの祭の日と 45 日後の項目は出ない）。portal-dated-rep-mobile：団体・全員の項目と申請の締切の4件。portal-dated-error-pc：欄の中だけに「締切と予定：通信できませんでした…」と「もう一度」が出て、机椅子の申請の締切は出たまま。
- event-dialog-allday-pc・event-dialog-timed-mobile・event-conflict-pc：ダイアログは前と同じ形（日時の入力欄は E2E の Chromium の言語の形）。
- どの絵も崩れ・はみ出しはない（シナリオの年度の名前と日時は撮るたびに変わる）。

## 確かめていないこと・残り

1. reviewer と security-reviewer：この片付けのブランチでは回していない（入力の処理〔お知らせ・ルールの「読み直す」〕と共有の部品〔AppLink〕に触れたので、CLAUDE.md の進め方では回す）。
2. push と PR（リードの指示でまだ）。本番 DB への 0009〜0015 の適用と、総務部門長・総務副部門長の招待は人の作業（README の 5）。
3. 4G の計測（`pnpm e2e:perf`）は流していない（読み取りは変えていない。最初に読む JS は 1843bf1 の記録と同じ）。
4. ルールの「無効にする」のダイアログと一覧の Switch の切り替えの「読み直す」は、一覧を読み直すまま（知らせの文と動きが合っているので変えていない。notes/T12.md の「マージの後の直し」）。
