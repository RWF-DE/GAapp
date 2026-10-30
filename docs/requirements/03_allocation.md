# 振り分けと検証

## 入力と出力

振り分けは DB に触れない純粋関数 `allocate(input): AllocateResult` として `packages/allocator` に置き、管理者のブラウザの Web Worker で実行する。画面は DB から入力を組み立てて呼び、結果を RPC `save_auto_allocations` で保存する。R8 のデータを JSON にして単体テストできる。

```ts
type AllocateInput = {
  items: { id: string; code: string; sortOrder: number }[];
  rooms: { id: string; name: string; kind: 'room' | 'gym' | 'outdoor' | 'other';
           building: string | null; floor: number | null; extraCost: number;
           usable: boolean; sortOrder: number }[];
  distanceOverrides: { buildingA: string; buildingB: string; cost: number }[];
  stocks: { roomId: string; itemId: string; count: number }[];
  groups: { id: string; name: string;
            category: 'stall' | 'department' | 'company' | 'rest_area';
            locationRoomId: string | null; sortOrder: number }[];
  requests: { groupId: string; itemId: string; count: number }[]; // 前処理の前の申請
  rules: Rule[];                    // enabled のものだけ
  consents: { groupId: string; fromItemId: string; toItemId: string;
              status: 'not_asked' | 'asked' | 'accepted' | 'declined';
              count: number | null }[];   // 依頼したときの置き換え台数（W102 で使う）
  fixedRows: AllocationRow[];       // 残す行：pinned = true または origin = 'manual'
  mode: 'full' | 'minimal_change';
  previousRows?: AllocationRow[];   // minimal_change のとき、前回の自動行
};

type AllocationRow = {
  sourceRoomId: string; groupId: string;
  itemId: string;                   // 実際に運ぶ品目
  requestedItemId: string;          // 申請した品目
  count: number; isKeep: boolean;
};

type AllocateResult =
  | { ok: true; rows: AllocationRow[]; objective: number; elapsedMs: number }
  | { ok: false; shortages: Shortage[]; causes: Cause[] };

type Shortage = { requestedItemId: string; demand: number; supply: number };
type Cause = { ruleCode: string | null; message: string };
```

- 入力の配列は、組み立てるときに sort_order → 名前 → id の順に並べる。並び順が変わると、同じ点数の解の中で別の解が選ばれるため
- 画面は DB から入力を読むとき、年度の版（years.allocation_version）をほかのデータより先に読む。版は、年度が allocating の間に入力（在庫・団体・申請・提出・ルール・了承・振り分け・場所の状態など）が変わるたびに増える
- 保存は RPC `save_auto_allocations(year_id, rows, mode, base_version)`。base_version は入力を組み立てたときに読んだ版で、違えば（計算中に入力や振り分けが変わっていれば）保存しない。1トランザクションで `origin = 'auto' AND NOT pinned` の行だけを、（運び元・団体・申請品目・品目）ごとの差分で入れ替える（同じ組み合わせの行は id を保ったまま数だけ変え、なくなった組み合わせは消し、新しい組み合わせは足す）。rows は同じ組み合わせを1行にまとめて渡す（x と x̂ は足す）。保存前に、団体がその年度のものか・使用不可の部屋からでないか（E002）・残すの運び元が使用場所か（E005）を、保存後に在庫超過（E001）を DB の中でも確かめ、だめなら全体を取り消す。is_keep は DB が「運び元＝団体の使用場所」で決め直す。ブラウザの計算結果をそのまま信用しない
- keep ルール（S08）の行も rows に含める。保存は origin = auto・is_keep = true・pinned = false で、自動実行のたびにルールから作り直す（D-06）。ルールを無効にすれば次の自動実行で消える
- 手で直した行（origin = manual）と固定した行（pinned）は消さず、すべて fixedRows として渡す。了承済みのキャスター机交換は、了承を記録した時点でその行を pinned にする

## 定式化

振り分けは輸送問題（線形計画）として解く。0/1 変数を使わないので R8 規模なら一瞬で解け、単体法で解けば整数の解が得られる。ソルバーは highs-js（HiGHS の WebAssembly 版）。以前の案にあった「運び元の数」の 0/1 変数は、最適解の証明に時間がかかり結果が毎回変わるため使わない（運び元が分かれすぎたときは W103 で知らせる）。

**前処理**

1. 長机(3人掛)を申請できない区分（企業以外）の申請は、長机(2人掛)に1対1で読み替える（S03。品目マスタの申請できる区分で判定）
2. fixed_request（S06）の団体・品目は、申請がなければその数を需要 D にする。申請があれば申請を使い、差を W106 で知らせる
3. keep（S08）の行をルールから作る（is_keep。保存は origin = auto・pinned = false。D-06）。固定行と同じように、需要と在庫から先に差し引き、結果の rows にも含める。管理者が固定した keep の行（fixedRows に入る）があれば、その団体・部屋・品目について、固定分を超える分だけを作る
4. 固定行（fixedRows）を差し引く。需要 D'(g,i) = max(0, D(g,i) − 固定分)、在庫 S'(r,j) = S(r,j) − 固定分。固定分が申請を超えたら W101、在庫を超えたら E001 で止める
5. 使用不可の部屋は S' = 0

**変数**

- x(r,g,i,j)：保管場所 r から団体 g へ、申請品目 i の分として品目 j を運ぶ数（0 以上）。j = i のほか、代替ルールが許す j だけ変数を作る
- ルールで禁止された組み合わせ（S05 の運び元の制限、代替の区分の制限、了承しなかった団体への置き換え）は、変数を作らない
- 最小変更モードでは、前回の自動行と同じ組み合わせに、上限＝前回の数の別の変数 x̂ を作る

**目的関数**

```latex
\min \sum \big( W\, c_{\mathrm{sub}}(g,i,j) + d(r,g) + \delta(g,j) \big)\, x(r,g,i,j) \; + \sum \big( W\, c_{\mathrm{sub}} + d(r,g) + \delta - \mu \big)\, \hat{x}(r,g,i,j)
```

- c_sub：代替の重さ。j = i なら 0。S01・S02（不可机・不可椅子）は 0（普通の机・椅子と同じ扱い）。S04（企業の長机3→2）は 1。S07（キャスター机）は 3
- W：代替の少なさを距離より必ず優先させる重み。W = 10 × d_max × N（d_max＝距離コストの最大値、N＝需要の合計）。R8 なら 10 × 5 × 1,295 ≒ 65,000
- d(r,g)：距離コスト（次の節）
- δ：不可椅子を同じ距離なら休憩所に先に回すための微小な差。休憩所への不可椅子は −0.1、それ以外は 0。距離の差（1 以上）より小さいので、距離が最優先になる
- μ：最小変更モードで前回と同じ割り当てを優先する割引。μ = d_max + 1。代替の重さ W よりは小さいので、代替を減らせるときはそちらを優先する

**制約**

```latex
\sum_{g,i} \big( x(r,g,i,j) + \hat{x}(r,g,i,j) \big) \le S'(r,j) \quad \forall r,j
```

```latex
\sum_{r,j} \big( x(r,g,i,j) + \hat{x}(r,g,i,j) \big) = D'(g,i) \quad \forall g,i
```

```latex
0 \le \hat{x}(r,g,i,j) \le \text{前回の数}
```

これは「保管場所×品目」から「団体×申請品目」への二部グラフ上の輸送問題なので、制約行列は完全単模である（変数の上限を足しても変わらない）。HiGHS の単体法（`solver: 'simplex'`）で解けば、最適解は整数で返る。念のため、各値を四捨五入して差が 1e-6 を超えたらエラーにする。

**決定性**

- 入力の並び順を固定し（「入力と出力」）、highs-js のバージョンを package.json で固定し、オプション（solver: simplex、random_seed: 0）を固定する。時間で打ち切らないので、同じ入力なら同じ解になる
- 安全のため time_limit を 30 秒にし、超えたら解を返さずエラーにする（途中の解は使わない）
- LP 形式の変数名に UUID は使えない（`-` や数字始まりは不可）ので、`x123` のような連番にして対応表を持つ
- highs-js を上げるときは、R8 の回帰テストで結果が変わらないか確かめる

**ルールの params と扱い**

| kind | params の例 | 扱い |
| --- | --- | --- |
| substitute | `{"from":"desk","to":"desk_ng","categories":["stall"],"cost":0}` | 条件を満たす団体にだけ j ≠ i の変数を作り、c_sub = cost（S01） |
| substitute | `{"from":"chair","to":"chair_ng","categories":["rest_area","stall"],"cost":0,"preferCategory":"rest_area"}` | preferCategory の団体には δ = −0.1（S02） |
| substitute | `{"from":"long_desk_3","to":"long_desk_2","categories":["company"],"cost":1}` | 企業の長机(3人掛)が足りないとき（S04） |
| substitute | `{"from":"desk","to":"caster_desk","categories":["stall"],"indoorOnly":true,"cost":3,"needsConsent":true}` | 使用場所の rooms.kind が room の団体だけ。了承が declined の団体には変数を作らない（S07） |
| source_restrict | `{"group":"<設営の id>","items":["desk"],"rooms":["<1-1 の id>","…"]}` | 対象の団体・品目は、指定した場所以外の変数を作らない（S05） |
| fixed_request | `{"group":"<設営の id>","item":"desk","count":241}` | 前処理 2（S06） |
| keep | `{"group":"<学科展示の id>","room":"<第一多目的室の id>","items":{"desk":12,"chair":4}}` | 前処理 3（S08） |

params は zod スキーマで検証してから保存する。団体と場所は画面で名前から選び、id で保存する。品目は年度をまたいでも変わらないコードで持つ。

is_keep は、運び元 r が団体の使用場所と同じ行に、保存するときに付ける。そのとき d(r,g) = 0 なので、自室の備品は自然にその団体が残して使う。それでも自室から同じ品目を外へ出しつつ運び込む結果になったら W107 で知らせる。

## 距離コスト

d(r,g) は保管場所 r と団体 g の使用場所の位置関係で決める段階値。正確な距離は測らない。値は R8 のデータで結果を見て調整する（[概要](00_overview.md) の未決事項）。

| 位置関係 | d |
| --- | --- |
| 同じ部屋（残す） | 0 |
| 同じ建物・同じ階 | 1 |
| 同じ建物・別の階 | 2 |
| 屋外の使用場所へ（建物の1階から） | 3 |
| 別の建物（体育館を含む） | 4 |
| 使用場所がない団体（校内分散の美化など）へ | 4 |
| 屋外の使用場所へ（2階以上から） | 5 |

- d に運び元の rooms.extra_cost を足す。運び出しにくい部屋（R8 で「4号棟より遠い」とされた CI5 など）に設定する
- 建物どうしの距離が表と合わないときは distance_overrides（建物A、建物B、コスト）で上書きする
- 体育館は rooms.kind = gym の1つの建物として扱う
- 屋内・屋外は団体の使用場所の rooms.kind だけで判断する（room なら屋内、outdoor なら屋外）
- d_max（W と μ の計算に使う）は、この表の最大値と distance_overrides の最大値の大きい方に、extra_cost の最大値を足したもの

## 解けないときの扱い

解けない（infeasible）ときは振り分けを書き換えず、「何が何台足りないか」と「どのルールが原因か」を返す。輸送問題なので、解き直しは1回あたり数十ミリ秒で済む。

1. 申請品目ごとに、需要の合計 ΣD' と、その品目に使える在庫の合計 ΣS'（代替先の品目を含む。固定分は前処理で引き済みなので、もう一度引かない）を比べ、需要の方が多い品目を shortages に入れる（例：「机(木)が12台足りません」）。代替先の品目が複数の申請品目で共有される場合もあるので、ここで空でも解けないことはある
2. 解けないのに shortages が空のときは、設定ルールを1つずつ外して解き直し、解けるようになったルールを causes に入れる。代替ルールは外すと選択肢が減るだけで解けるようにはならないので対象外で、運び元の制限（source_restrict）と残す（keep）だけを試す
3. どれを1つ外しても解けないときは、運び元の制限の対象ごとに「需要」と「その場所の在庫合計」を並べ、「複数の条件の組み合わせが原因」と表示する

画面では「設営の机(木)：需要241、1-1〜2-3 の在庫合計235」のように表示し、ルールを変えるか、申請や固定行を直すかは管理者が決める。固定行が在庫を超えている場合は、前処理の段階で E001 として該当の行を示す。

## 検証コード一覧

検証は `packages/allocator` の `validate(input, rows): Issue[]` で行い、自動実行後と手動修正のたびに画面で呼ぶ。error が1件でもあると「確定」ボタンを押せない。warning は確認した上で確定できる（W102 の了承待ちも含む）。E001・E002・E005 は、確定の RPC と自動振り分けの保存の RPC の中で DB 側でも確かめる（手での保存は E002・E005 だけを止め、E001 は途中の状態を保存できるよう止めない）。確定の RPC は、検証に使った版も確かめる。確定中は、E001・E002・E005 を作る直接の書き込みを DB のトリガーで止める。E006 は、申請を書くときに DB のトリガーでも止める（企業以外の長机(3人掛)は除く。D-05）。

| コード | 重さ | 条件 | 表示例 |
| --- | --- | --- | --- |
| E001 | error | 保管場所・品目ごとの振り分け合計 > 在庫 | HI3 の机(木) が 2 台在庫超過 |
| E002 | error | 使用不可の部屋からの振り分けがある | 第一セミナーは今年使えません |
| E003 | error | 団体・申請品目ごとの振り分け合計（代替を含む） < 申請 | 野球部の長机(2人掛) が 2 台不足 |
| E004 | error | ルール違反（代替の区分、運び元の制限、了承しなかった団体への置き換え） | 設営に不可机が割り当てられています（S01） |
| E005 | error | 残すの行で、運び元が団体の使用場所と違う | 「残す」は使用場所の部屋だけです |
| E006 | error | 申請できない区分の申請がある | 剣道部(飲食)は長机(3人掛)を申請できません |
| W101 | warning | 振り分け合計 > 申請 | 剣道部(飲食)の机(木) が申請より 2 台多い |
| W102 | warning | キャスター机への置き換えがあり、了承がまだ（了承の記録がない、または了承した台数（count）より今の置き換え台数が多い） | 2年2組：机(木)24 → キャスター机（了承待ち）、2年2組：了承は 20 台、今は 24 台（依頼し直し） |
| W103 | warning | 1団体・1品目の運び元が4か所以上 | SE技術の机(木) が 4 か所に分かれています |
| W104 | warning | 保管場所（is_storage）のうち、今年の在庫がひとつも数えられていない場所がある（使用不可の部屋は除く） | MER の在庫がまだ数えられていません |
| W105 | warning | 申請が未提出の団体がある（submitted_at が null） | 3団体が未提出 |
| W106 | warning | fixed_request と申請の数が違う | 設営：固定241、申請230 |
| W107 | warning | 団体の使用場所から同じ品目が外へ出ているのに、その団体が他の場所から受け取っている | CI3 の椅子(木)が外へ出ているのに、料理同好会が他の部屋から椅子(木)を受け取っています |
| I201 | info | 品目ごとの余り | 不可机 余り6（1-1：4、2-3：2） |

Issue の形：`{ code: string; severity: 'error' | 'warning' | 'info'; message: string; refs: { roomId?: string; groupId?: string; itemId?: string; ruleCode?: string } }`。画面では refs で該当行に飛べるようにする。

## Excel出力仕様

R8 の「R8 椅子机振り分け(部門員共有用).xlsx」と同じ様式で、ブラウザで作って出す。受け取った人が Excel で直しても合計が合うよう、合計・余り・警告は数式で書く。ExcelJS は数式を計算しないので、数式と一緒にアプリで計算した結果の値も書き、ブックに fullCalcOnLoad を設定する（プレビューで空欄にならないように）。色は付けない。

**ファイル名**：`{年度}_椅子机振り分け_部門員共有用.xlsx`

**シート構成**（この順）

1. 机(木)（机と不可机を2列で）
2. 椅子(木)（椅子と不可椅子を2列で）
3. キャスター机
4. 椅子(青)
5. 長机(3人掛)
6. 長机(2人掛)
7. 教卓
8. 団体別集計

**品目シート（1列のもの）**

| 列 | 見出し | 中身 |
| --- | --- | --- |
| A | 運び元 | 部屋のブロックの先頭行だけに部屋名 |
| B | 運び先 | 使用場所。残すは「残す」、使用不可は「残す」＋C列「使用不可」 |
| C | 使用用途 | 団体名（集計シートのSUMIFのキー） |
| D | 個数 | 数 |
| E | 備考 | 特記事項のみ（「キャスター机に交換」など）。計の行では警告式 |
| F | 在庫(R○数え) | 計の行だけに在庫数 |

各品目シートに出す保管場所は、その品目の在庫が1以上の場所と、その品目の振り分けがある場所。並びは rooms.sort_order。場所ごとのブロックは、振り分け行 → 余り行 → 計行の順。振り分けが無い場所も余り行と計行を出し、その場合は余り行の A 列に場所名を入れる。使用不可の場所は「運び先＝残す、使用用途＝使用不可」の1行に在庫の全数を入れる。例（簡略化したもので、R8 の実際の行とは違う。行17〜18が振り分け、行19が余り、行20が計）：

```csv
行,A,B,C,D,E,F
17,第二セミナー,外13,ハンドボール部,3,,
18,,外14,野球部,2,,
19,,余り,,=F20-SUM(D17:D18),,
20,,,(計),=SUM(D17:D19),"=IF(D19<0,""在庫超過"",IF(D20=F20,"""",""要確認""))",21
```

**品目シート（2列のもの：机(木)・椅子(木)）**

D＝机（椅子）、E＝不可机（不可椅子）、F＝備考、G・H＝在庫。同じ（運び元・運び先・団体）の机(木)の行と不可机の行は1行にまとめ、D と E に並べる（椅子も同じ）。余りは `=G{計}-SUM(D…)` と `=H{計}-SUM(E…)`、警告は `=IF(OR(D{余}<0,E{余}<0),"在庫超過",IF(AND(D{計}=G{計},E{計}=H{計}),"","要確認"))`。

**団体別集計**

- 列：区分、団体、机(木)、不可机、椅子(木)、不可椅子、キャスター机、椅子(青)、長机(3人掛)、長机(2人掛)、教卓、机計(木＋不可)
- 各セル：`=SUMIF('シート'!$C:$C,$B{行},'シート'!$D:$D)`（不可は E 列）
- 最後に4行：使用数 計（SUM）、在庫（`SUMIF(…,"(計)",在庫列)`）、使用不可（残す）（`SUMIF(…,"使用不可",…)`）、余り（在庫 − 使用数 − 使用不可）
- 団体の並び：模擬店 → 部門 → 企業 → 休憩所、区分の中は申請順

**その他の出力**

- キャスター机交換依頼一覧：机(木)→キャスター机の代替だけを団体ごとにまとめた表（団体・企画名・場所・台数・了承状況）。不可机や長机の代替は入れない
- 年度データ（JSON）：場所・品目・団体・在庫・申請・ルール・振り分け・了承をまとめて書き出す。年度末のバックアップに使う（メールアドレスは含めない）
- フェーズ2で配布スケジュール（屋外・屋内・部門・企業・その他・時間別）

**確認方法**：出力したファイルを LibreOffice の headless で再計算し、#REF! などのエラーが0件、「在庫超過」「要確認」が0件であることを CI のテストで確かめる。
