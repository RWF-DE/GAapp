# Claude Code での進め方

このフォルダには、Claude Code に渡す依頼文がチケットごとに入っている。各ファイルは「目的・前提・範囲・完了基準・出力」の5つで書いてあり、それだけで作業が完結するようにしてある。

## 準備（最初に1回）
1. GitHub に組織を作り、公開リポジトリを作る（オーナーは2人以上）。
2. このキットの中身をリポジトリのルートに置いてコミットする（CLAUDE.md、SPEC.md、docs/、.claude/、notes/）。
3. R8 の元データ（フォーム回答の xlsx 3種類、机・椅子数え、最終の振り分け表、配布スケジュール、総務スケジュールの PDF）は、リポジトリの外の非公開フォルダに置く（例：`../denpa-private/r8/`）。メールアドレスを含むので、絶対にコミットしない。そのフォルダのパスを環境変数 `R8_SOURCE_DIR` に入れる。（注：D-40〔2026-10-29〕により、今は R8 の元データを使わず、合成データ fixtures/synthetic/r8like で代用している。この手順は不要で、R8 の元データを使うことになったときのために仕組み〔scripts/build-r8-fixtures.ts〕だけを残している。）
4. リポジトリで `claude` を起動し、最初に 00_kickoff.md を渡す。

## 1チケットの進め方
1. 新しいセッションで始める（前のチケットが終わったら `/clear`）。
2. ファイルの先頭にある推奨のモデルと effort を、最初に `/model` と `/effort` で設定する。
3. 依頼文を貼るか、「@docs/prompts/T06.md の依頼を進めて」と書く。
4. 「計画モードで開始」とあるチケットは、Shift+Tab で計画モードにしてから渡し、計画を確認してから実装させる。
5. 終わったら reviewer サブエージェントか `/code-review high` でレビューする。T03・T04 は `/security-review` も使う。
6. 指摘を直したら PR を作る。CI が通ったらマージし、05_development.md のチケット表の状態を更新する。

## 順番と並行作業
| 順 | チケット | モデル / effort | 計画モード | 並行できるもの |
| --- | --- | --- | --- | --- |
| 0 | 00_kickoff（全体の計画と質問の洗い出し。コードは書かない） | opus / high | 開始時から | — |
| 1 | T00 highs-js のスパイク | sonnet / medium | — | T01 |
| 2 | T01 雛形・CI・GitHub Pages | sonnet / medium | — | T00 |
| 3 | T02 DDL | sonnet / medium | — | — |
| 4 | T03 RLS・RPC | opus / high | 開始時から | T05 |
| 5 | T04 ログイン・招待 | opus / high | 開始時から | T05 |
| 6 | T05 importer・R8 の fixtures | sonnet / medium | — | T03・T04 |
| 7 | T06 allocator | opus / high | 開始時から | T09〜T11 |
| 8 | T07 validate・診断 | sonnet / medium | — | T08、T09〜T11 |
| 9 | T08 exporter | sonnet / medium | — | T07、T09〜T11 |
| 10 | T09 マスタ設定・ダッシュボード | sonnet / medium | 開始時から | T06〜T08 |
| 11 | T10 在庫入力・在庫一覧 | sonnet / medium | — | T06〜T08 |
| 12 | T11 申請・申請一覧 | sonnet / medium | — | T06〜T08 |
| 13 | T12 ルール設定 | sonnet / medium | — | — |
| 14 | T13 振り分け・交換・自団体 | sonnet / medium | 開始時から | — |
| 15 | T14 履歴・通しの E2E・README | sonnet / medium | — | — |

並行して進めるときは worktree を使う（例：`claude -w t06`）。同じファイルを2つのセッションで同時に編集しない。

## よく使うコマンド
- `/goal <条件>`：条件を満たすまで作業を続けさせる（例：`/goal packages/allocator のテストがすべて通り、lint と型チェックがクリーン`）。
- `/code-review high`、`/security-review`：別の観点からのレビュー。
- `/compact <残したい内容>`：長くなったセッションを要約して続ける。
