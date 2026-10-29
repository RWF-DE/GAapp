# SPEC：電波祭 総務 机椅子管理アプリ（フェーズ1）

Claude Code 向けの仕様の入口。詳細は docs/requirements/ にあり、そちらが正。

## 目的
電波祭（熊本高専の文化祭）の机・椅子の振り分けを、在庫入力・申請・自動振り分け・検証・Excel 出力まで1つの Web アプリで行い、総務の手作業と確認の往復をなくす。R9（2027年10月）で本番運用する。フェーズ1（振り分け）を2027年4月までに作り、R8（2026年）の実データで検証してから本番で使うかを決める。

## 正とする文書
| ファイル | 内容 |
| --- | --- |
| docs/requirements/00_overview.md | 背景、ロール、スコープ、機能要件（F1-1〜F1-14、F2-1〜F2-5）、画面一覧、技術構成、未決事項 |
| docs/requirements/01_rules.md | 用語集（コード上の英語名）、品目、固定ルール、設定ルール S01〜S08、申請の扱い、年間の流れ |
| docs/requirements/02_data.md | 列挙型、DDL、設計上の決めごと、RLS の権限表、年度ステータスの状態遷移 |
| docs/requirements/03_allocation.md | allocate() の入出力の型、前処理、定式化（輸送問題）、距離コスト、解けないとき、検証コード、Excel 出力仕様 |
| docs/requirements/04_screens_api.md | 画面仕様、CSV 取り込み、DB 関数（RPC）、ブラウザ側の処理 |
| docs/requirements/05_development.md | リポジトリ構成、環境変数、CI、チケット T00〜T14、受け入れ基準と R8 テストデータ |

食い違ったときは 01〜05 を正とする（00 は要約）。それでも決まらないことは質問し、決まったことは notes/decisions.md に記録する。

## 関係するファイルとインターフェース
- 構成：05_development.md の「リポジトリ構成と環境変数」（apps/web、packages/allocator・exporter・importer・shared、supabase/、fixtures/r8）。
- 振り分け：`allocate(input: AllocateInput): AllocateResult`、`validate(input, rows): Issue[]`（型は 03_allocation.md）。
- DB：02_data.md の DDL。書き込みの RPC は 04_screens_api.md の表（set_year_status、update_year、create_year_from、invite、set_role、revoke_invitation、remove_group_member、accept_my_invitations、save_auto_allocations、save_allocation_rows、set_consent、submit_requests、update_requests_after_deadline、check_delivery）。読み取りの RPC は previous_year_stocks、previous_year_requests。
- 出力：exportAllocationXlsx・exportSwapsXlsx・exportYearJson。取り込み：parseFormCsv。

## やらないこと
- サーバー側の処理（Route Handler・Server Action・middleware）と、Vercel などサーバー付きのホスティング。
- アプリでの secret（旧 service_role）キーの使用。
- 0/1 変数を使う MILP、時間で打ち切った解の採用。
- 個人情報（メールアドレスなど）の保存とコミット。
- フェーズ2（配布スケジュール、運搬チェック）とフェーズ3の画面と処理。ただし DDL には含める（02_data.md のとおり）。
- テントや模擬店そのものの申請受付、総務以外の部門の業務。

## 受け入れ基準
05_development.md の「受け入れ基準と R8 テストデータ」をすべて満たすこと。要点：
- R8 の正規化した申請で ok: true になり、E001〜E006 が0件。全申請を代替込みで過不足なく満たす。
- S01〜S08 が成り立つ（設営の机241台は 1-1〜2-3 から、不可机は模擬店だけ、不可椅子は休憩所と模擬店だけ、長机(3人掛)は企業だけ、学科展示の残す）。
- キャスター机への置き換えは 103 台以下。椅子(青)134・教卓10・長机合計106 が R8 と一致。W107 が0件。
- 同じ入力で同じ結果。固定行・手動行が二重にならない。最小変更モードで無関係な行が変わらない。
- ブラウザで R8 入力の計算が2秒以内。出力した xlsx を再計算してエラー0件。
- 団体代表は他の団体のデータを、招待されていない人は何も読めない（pgTAP で確認）。

## E2E の検証手順（ローカル）
1. `supabase start` → `supabase db reset`（seed に品目・場所・R8 の団体と在庫が入る）
2. `pnpm dev` で起動し、テスト用の管理者でログインする
3. 年度を作り、在庫一覧で在庫が入っていることを確かめる（第一セミナーは使用不可）
4. 申請一覧で fixtures の申請を取り込む（またはテスト用の団体代表で1件提出する）
5. 振り分け画面で「自動振り分け」→ 検証パネルの error が0件 → 「確定」
6. 「Excel出力」で xlsx を保存し、LibreOffice（`soffice --headless`）で再計算して、数式エラーと「在庫超過」「要確認」が0件であることを確かめる
7. 「確定を解除」→ 別の部屋（例：MER）を使用不可にする →「最小変更で再実行」→ 変わった行が、その部屋から運んでいた分だけであることを確かめる

CI では同じ流れを Playwright（`pnpm e2e`）で実行する。
