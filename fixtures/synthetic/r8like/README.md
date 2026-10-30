# fixtures/synthetic/r8like（合成データ）

R8 と在庫・需要の合計が同じ合成データ。`pnpm gen:synthetic`（scripts/gen-synthetic-fixtures.ts、シード 20261029）で生成する。手で直さない（生成し直した結果がコミット済みのファイルと一致することを scripts/gen-synthetic.test.ts が確かめる）。

- 作り方：T00 のダミー（spikes/highs/src/gen.ts）を `packages/shared/src/testing/synthetic.ts` に移したもの。乱数の列は T00 と同じ（id を作っていた場所は捨て読み）なので、在庫と申請の数は T00 と一致する。足した団体（剣道部(飲食)・剣道部(非飲食)・部門(校内分散)・未提出の団体）は、既存の団体から申請を移しただけで、品目ごとの需要の合計は変わらない。設計は notes/T06-design/logic-design.md の 3.6。
- 合計：在庫は 05 の「R8 の実績」の在庫（使用不可の第一セミナーを含む）。需要は 1,295（机(木) 644・椅子(木) 372・椅子(青) 134・キャスター机 29・教卓 10・長机 106）。
- 列と形式：notes/T06-design/logic-design.md の 3.2（packages/shared/src/testing/fixtures.ts の zod スキーマで確かめる）。場所・団体・ルールの id は名前から UUIDv5（`room:<name>`、`group:r8like:<name>`、`rule:r8like:<code>`、品目は `item:<code>`）。
- requests.csv の意味：fixtures/r8 と同じく「DB の requests に入る申請（取り込みの後・代替の前）」。取り込み（importer）は企業以外の長机(3人掛)を長机(2人掛)に読み替えて保存するが、DB には長机(3人掛)のまま残っていてもよい（D-05）。合成データでは前処理の読み替え（S03）を通すため、模擬店06 の長机(3人掛) 2 を読み替えの前のまま置いている。テストの需要の期待値は、どちらの場合も読み替えを明示的に当てて作る（同じ値になる）。
- 了承（consents.csv）：屋内の模擬店25団体の机(木)→キャスター机。模擬店04 だけ拒否（declined）、模擬店01〜08（04 を除く）が了承（accepted）、ほかは not_asked。
- 提出日時：未提出の団体だけ空（W105 が1件）。ほかは 2026-07-01T12:00:00+09:00 に sort_order 分を足した時刻。設営も提出済み（申請の 241 を使い、S06 の固定数は効かない）。
- 個人情報は含まない（団体名・場所名は仮のもの）。
- reference/：full で allocate した結果（allocations.csv）と、団体・品目ごとの合計（group_totals.csv）。`pnpm gen:synthetic-reference` で生成する。note は空（T08 の自動の備考は exporter が付ける）。
