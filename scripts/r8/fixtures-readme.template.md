<!-- fixtures/r8/README.md の雛形。今は R8 の元データを使わず合成データで代用している（D-40）。R8 の元データを使うことになったら fixtures/r8/README.md にコピーして、<...> を埋める。個人名・メールアドレスは書かない -->
# fixtures/r8（R8 の実績データ）

## 出典

- 在庫：机椅子数えの最終値（<日付・版>）
- 申請：Google フォームの回答（模擬店・部門・企業）に importer（parseFormCsv・resolveResponses）を当て、manual/adjustments.csv の読み替え・追加を当てたもの
- reference/：R8 の最終の振り分け表（<日付・版>）
- 元データはリポジトリに入れていない。`R8_SOURCE_DIR` から `pnpm build:r8-fixtures` で作る（手順はルートの README）

## 手で書いたもの（根拠）

| ファイル | 根拠 |
| --- | --- |
| rooms.csv | building・floor・kind・is_storage・extra_cost・sort_order・usable・aliases の根拠。分からない部屋の仮の値：<一覧> |
| rules.json | 01_rules.md の S01〜S08 |
| distance_overrides.csv | <R8 で調整した距離。なければ見出しだけ> |
| manual/groups.csv | 団体の区分・使用場所・並び・提出のしかた（form・proxy・none） |
| manual/settings.json | proxySubmittedAt = <R8 の申請締切の日時。出典> |

## 読み替えの一覧（manual/adjustments.csv）

| 団体 | 品目 | 操作 | 数 | 理由 |
| --- | --- | --- | --- | --- |
| <SE企画> | キャスター机 | set | 6 | 長机(3人掛)の申請をキャスター机6に読み替え |
| <剣道部(非飲食)> | 机(木)・椅子(木) | add | 2・1 | R8 の追加 |
| 設営 | 机(木) | set | 241 | S06 |
| <四役・休憩所・企業> | | | | 代理入力 |

## 匿名化

団体名に個人名が入っていたものは仮名にした（<件数>件）。対応表は R8_SOURCE_DIR の中にだけあり、ここには書かない。備考・氏名・学籍番号・電話・メールの列は持たない（fixtures の読み込みは知らない列を失敗にする）。

## reference/ の注意

- 剣道部は 2 団体（剣道部(飲食)・剣道部(非飲食)）に分けた。申請より多い分は剣道部(非飲食)に付けた：<品目と数>
- 比較から除いた団体（集計シートの値と振り分け表の行の合計が違う）：<一覧>。group_totals.csv の団体数 = groups.csv の団体数 − <除いた数>
- 申請と手作業の requested_item の合計が違う組（失敗にしない）：<一覧>
- 振り分け表の「使用不可」「余り」「(計)」と reference_skip.csv の使用用途の行は入れていない
- 振り分け表の「残す」（S08）：使えない部屋の行は入れていない。使える部屋の行は、その部屋を使用場所（groups.csv の location）とする団体の行にした（運び元はその部屋）
- 備考は「キャスター机に交換」だけ（manual/settings.json の allowedNotes で足したもの：<一覧>）

## 在庫の合計（05_development.md「R8 の実績」の表と一致）

| 品目 | 在庫 |
| --- | --- |
| 机(木) | 506 |
| 不可机 | 41 |
| 椅子(木) | 493 |
| 不可椅子 | 40 |
| キャスター机 | 180 |
| 椅子(青) | 432 |
| 長机(3人掛) | 8 |
| 長机(2人掛) | 127 |
| 教卓 | 27 |
