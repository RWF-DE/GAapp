# 振り分けロジックの設計（T05〜T08・T12 のインターフェースと、T06 の実装設計）

作成：2026-10-29。改訂：2026-10-29（批評33件の反映）、同日の改訂2（実装者の目で見つかった抜け6件の反映）。どちらも末尾の「改訂の記録」と対応。対象：T05（fixtures の形式と importer の出力）、T06（allocate）、T07（validate と診断）、T08（exporter の入力）、T12（ルールの params）。T13（画面と Web Worker）は呼び出し方だけを書く。

読んだもの：SPEC.md、CLAUDE.md、docs/requirements/01〜05、docs/prompts/T05〜T08・T12・T13、notes/decisions.md（D-01〜D-08、P-01〜P-03）、notes/kickoff.md、T00 のスパイク（notes/T00.md、spikes/highs/src）、T01 の雛形（packages/*、vitest.config.ts、tsconfig）、DB 設計（同じフォルダの db-design.md）。

反映した決定：D-05、D-06、D-07、D-08、P-02（形を変えて採用。6 章）、K-13、K-14、K-15、K-21、K-26、K-27、T00「03 の直すべき点」1〜11。要件定義への反映案は同じフォルダの spec-changes-logic.md にある。

この設計のうち、コスト・前処理・変数・W107 の定義は、logic-lab（この設計のセッションの scratchpad）で T00 のダミーデータを使って実装し、highs 1.15.4 で解いて確かめた（11 章）。logic-lab は T06 の前に `spikes/logic-lab/` としてリポジトリに入れる（12.5。T06 の担当はそこから総当たり・段ごとの検算・D-08 の判定を移す）。テストの入力と期待値のうち、本文から推し量りにくいものは 12.5 に表で書いた。

## 0. 要点

- 依存の向きは shared ← allocator・exporter・importer ← apps/web。allocator は highs を import しない。highs のインスタンスは呼ぶ側が渡す（`allocate(input, solver)`）。Node のテストは `loadHighs()`、ブラウザは Web Worker の中で `loadHighs({ locateFile })` したものを渡す。
- 型と zod スキーマ（品目コード、ルールの params 4種、YearData・AllocateInput・AllocationRow・AllocateResult・Issue）は packages/shared に置く。fixtures の読み書きと合成データは Node 専用の `@gaapp/shared/testing` に分ける。
- fixtures は「名前で書いた CSV と JSON」。id は名前から UUIDv5 で決める。fixtures/r8（T05、本物を匿名化）と fixtures/synthetic/r8like（T00 の gen.ts を移植。合計を R8 にそろえる）を同じ形式にし、同じテストを両方に流す。
- AllocateInput に足すもの：items の name・requestableCategories、rooms の isStorage、groups の displayName・submittedAt（D-07・W105・K-27）、consents の count（DB 設計の P-01。W102）。AllocateResult の ok: false は reason と issues（K-13）・inputErrors を持つ1つの形にする。
- コストは整数で、優先順位（代替 → 前回を保つ台数 → 距離 → 休憩所への不可椅子 → 残す）を、入力の大きさから決めた倍率で「必ず」守る。P-02 の固定の倍率（100・−10）は休憩所が10を超えると崩れるので、倍率を需要の行数 K から決める形に変えた。R8 規模で最大の係数は 3.3×10⁸（最小変更モード）。整数で返り、時間は T00 と同じ（中央値 43 ms）。
- 最小変更の割引 μ は、距離より必ず強い（辞書式）値にする。1台ぶんの値（今の 03 の μ = d_max ＋ 1）では、前回の1台を手放して距離を縮める解が出ることを総当たりで確かめた。辞書式なら、D-08 の基準が次の形で成り立つ：「使用不可にした部屋 M から受け取っていた団体・申請品目の失った分を、前回のほかの行を変えずに、ルール上使える場所の余りから代替の重さを増やさずに補えるなら、前回の M 以外の行は減らず、増えるのは M から受け取っていた（団体・申請品目）の行だけで、M と無関係な行は変わらない」。品目全体の余りで判定すると、運び元の制限（S05）などで成り立たない（批評の反例。6.3・12.3）。
- W107 は「入れ替えがルール上でき、入れ替えても距離の合計が増えないのに起きている」ものに絞る（要確認。15 章）。この定義なら、全体の実行では距離の上書きがあっても最適解に W107 は出ない（12.4）。T00 のダミー30通りで、今の定義の16件（すべて S05 による）が0件になる。
- 解けないとき：T06 は「入力の不正」「前処理で止めるもの（固定行・残すが在庫を超える E001、残すのルールの部屋が使用不可 E002・使用場所でない E005）」「候補が足りない需要」「HiGHS が Optimal 以外」を返す。申請できない品目の申請（E006）と、固定行の E002・E004・E005 では止めず、validate が error として示す（5 章）。品目ごとの不足とルールを外した解き直し（causes）は T07 の diagnose が埋める。前処理 7 で止まった入力（S05 が原因の典型）でも、diagnose はルールを外して解き直す（9 章）。

## 1. packages の分担と依存の向き

```
packages/shared   ← packages/allocator
                  ← packages/exporter
                  ← packages/importer
apps/web → allocator・exporter・importer・shared、highs（Web Worker の中だけ）
```

| パッケージ | 中身 | 依存（すべて exact 固定） | 入れないもの |
| --- | --- | --- | --- |
| shared（`.`） | 定数（品目コード・区分など）、zod スキーマと型（2 章）、ルールの確認（checkRuleRefs）、団体名の確認（groupNameSchema・checkGroupNames。13.2）、需要の組み立て（buildDemand、rewriteRequestedItem）、団体の並び（compareGroupsForReport）、DB の行からの変換（fromDb）、`supabase gen types` の生成物（T02） | zod 4 | Node の API（fs・crypto）、ExcelJS、highs |
| shared（`./testing`、Node 専用） | fixtures の読み書き（3 章）、UUIDv5、合成データの生成、テスト用の入力の組み立て（builder） | node:fs、node:crypto | 本体のコードからの import（ESLint で止める） |
| allocator | allocate、diagnose（T07）、validate（T07）、W107 の判定、距離、LP の組み立て | shared。devDependencies に highs 1.15.4（テスト用） | highs の実行時の import（型も自前の LpSolver で持つ） |
| exporter | exportAllocationXlsx、exportSwapsXlsx、exportYearJson | shared、exceljs | allocator（余りなどの集計は自分で行う） |
| importer | parseFormCsv、resolveResponses | shared（CSV の読み取りは T05 で選ぶ） | allocator、exporter |
| apps/web | 画面、Web Worker、DB からの入力の組み立て | 上のすべてと highs 1.15.4 | — |

- 方向は ESLint の `no-restricted-imports` で止める：shared から他の packages、exporter・importer から allocator、packages から `@gaapp/shared/testing`、allocator から `highs`（`import type` も含めて）。
- 例外（テストのためのコード）：`packages/*/src/**/*.test.ts`、`packages/*/src/testing/**`、`scripts/**` は、`@gaapp/shared/testing` と `highs` を import してよい（allocator の testing/getHighs.ts・checkInvariants と solve.test.ts のため）。各パッケージの index.ts は testing/ を export しない（`exports` にも出さない。shared だけ `./testing` を Node 専用で出す）。exporter・importer から allocator への禁止には例外を作らない（T08 の合成データは、生成してコミットしたファイルを読む。3.6）。
- highs の版は allocator の devDependencies と apps/web の dependencies の2か所に書く。shared の `HIGHS_VERSION = '1.15.4'` と一致することを allocator のテストで確かめる（package.json を読む）。上げるときは3か所を同じ PR で変え、R8 と合成データの結果のハッシュが変わらないことを確かめる。
- T01 の雛形どおり、各パッケージは `exports: { ".": "./src/index.ts" }`（ビルドしない）。shared だけ `"./testing": "./src/testing/index.ts"` を足す。

## 2. packages/shared の型と zod スキーマ

### 2.1 定数

```ts
// packages/shared/src/constants.ts
export const ITEM_CODES = ['desk', 'desk_ng', 'chair', 'chair_ng', 'caster_desk',
  'blue_chair', 'long_desk_3', 'long_desk_2', 'lectern'] as const;     // 01 の並び。T00 の 'chair_blue' は誤り
export type KnownItemCode = (typeof ITEM_CODES)[number];
export const GROUP_CATEGORIES = ['stall', 'department', 'company', 'rest_area'] as const;
export const ROOM_KINDS = ['room', 'gym', 'outdoor', 'other'] as const;
export const CONSENT_STATUSES = ['not_asked', 'asked', 'accepted', 'declined'] as const;
export const RULE_KINDS = ['substitute', 'source_restrict', 'fixed_request', 'keep'] as const;
export const ALLOC_ORIGINS = ['auto', 'manual'] as const;
/** 申請できない区分の申請を読み替える品目（S03・D-05）。これ以外の申請できない品目は E006 */
export const REQUEST_REWRITES: Readonly<Record<string, string>> = { long_desk_3: 'long_desk_2' };
export const HIGHS_VERSION = '1.15.4';
/** 01 の「品目」表（初期値）。fixtures の品目と、T02 の seed の品目はこれと同じにする */
export const INITIAL_ITEMS: readonly { code: KnownItemCode; name: string; aliases: string[];
  requestableCategories: GroupCategory[]; sortOrder: number }[] = [
  { code: 'desk', name: '机(木)', aliases: ['机(木)'], requestableCategories: ['stall', 'department', 'company', 'rest_area'], sortOrder: 1 },
  // … 01 の表の順に9件。desk_ng・chair_ng は requestableCategories: []、long_desk_3 は ['company']
];
```

- 品目は DB では増やせる（フェーズ3）。型の上では品目コードを `string`（`^[a-z][a-z0-9_]*$`）で持ち、ITEM_CODES は既知の9種として並びと Excel の様式にだけ使う。ルールの params の品目コードが items にないときは allocate が invalid_input にする。
- 列挙の値は DB の enum と同じ。T02 の生成物（database.types.ts）の enum 型と一致することを、型のテスト（`expectTypeOf`）で確かめる。

### 2.2 入力の型

```ts
// packages/shared/src/model.ts（型は zod スキーマから z.infer で作る。ここでは形だけ示す）
export type Item = { id: string; code: string; name: string;
  requestableCategories: GroupCategory[]; sortOrder: number };
export type Room = { id: string; name: string; kind: RoomKind;
  building: string | null; floor: number | null; extraCost: number;
  isStorage: boolean; usable: boolean; sortOrder: number };            // usable は room_years から
export type Group = { id: string; name: string; displayName: string | null;
  category: GroupCategory; locationRoomId: string | null; sortOrder: number;
  submittedAt: string | null };                                       // request_submissions.submitted_at（ISO）
export type StockRow = { roomId: string; itemId: string; count: number };     // 数えた場所の行だけ。0 も渡す
export type RequestRow = { groupId: string; itemId: string; count: number };  // DB の requests のまま（前処理の前）
export type Consent = { groupId: string; fromItemId: string; toItemId: string; status: ConsentStatus;
  count: number | null };              // 依頼したとき（asked）の置き換え台数。DB の substitution_consents.count（P-01）。W102 で使う
export type DistanceOverride = { buildingA: string; buildingB: string; cost: number };   // cost は 0〜20 の整数

/** 年度のデータ。validate・exporter はこれと rows を受け取る */
export type YearData = {
  items: Item[]; rooms: Room[]; groups: Group[];
  stocks: StockRow[]; requests: RequestRow[];
  rules: Rule[];                       // enabled のものだけ（2.3）
  consents: Consent[]; distanceOverrides: DistanceOverride[];
};

export type AllocationRow = {
  sourceRoomId: string; groupId: string;
  itemId: string;                      // 実際に運ぶ品目
  requestedItemId: string;             // 申請品目（前処理1の読み替えの後）
  count: number;                       // 1 以上の整数
  isKeep: boolean;                     // 運び元 = 団体の使用場所
};
export type StoredAllocationRow = AllocationRow & {
  id: string; origin: 'auto' | 'manual'; pinned: boolean; note: string | null };

export type AllocateInput = YearData & {
  mode: 'full' | 'minimal_change';
  fixedRows: StoredAllocationRow[];    // pinned = true または origin = 'manual' の行（keep を手で固定した行を含む）
  previousRows: AllocationRow[];       // minimal_change のとき：origin = 'auto' かつ未固定の行（keep の行を含む）。full では []
};
```

- スキーマ：`allocateInputSchema`（strictObject。id は `z.uuid()`、数は 0 以上の整数（rows は 1 以上）、名前は空でない文字列、submittedAt は `z.iso.datetime({ offset: true })` か null）。allocate は最初に safeParse する（Worker の境界と、DB の jsonb から来る params を信用しない）。R8 規模で数 ms。
- 数の範囲は DB の CHECK とそろえる：stocks・requests・rows の count と consents の count は 0〜10000（rows は 1〜10000）。距離に効く `rooms.extraCost` と `distanceOverrides.cost` は `z.number().int().min(0).max(20)`。負の値は 6.3 の段の分け方を崩し（d が負になる）、小数は LP に小数を書かせ、大きすぎる値は係数を大きくして HiGHS の許容誤差に近づける。上限 20 は段階値（0〜5）に対して十分に大きい。DB の rooms.extra_cost・distance_overrides.cost は今は「0 以上」だけなので、同じ上限の CHECK を DB 設計に申し送る（16 章）。それまでは、範囲外の値は allocate が invalid_input（path つき）で止める。
- この範囲なら d_max ≤ 40（上書き 20 ＋ extra 20）で、R8 規模（K ≒ 170、P ＝ 2）の最小変更モード・c_sub ＝ 10 でも最大の係数は約 6×10⁹、× 需要の合計 1,295 で約 7.8×10¹² となり、2⁵³（約 9×10¹⁵）より十分に小さい。6.2 の規模の確認は念のために残す。係数が大きいときにも辞書式の最小が返ることは、段ごとに解く検算で確かめる（12.1 の weights.test.ts）。
- 並び順は入力の配列に依らない（8 章）。DB から読む側（T13）は並べなくてよいが、03 のとおり並べておいても害はない。
- StockRow は「数えた場所」の行をすべて渡す（0 の行も）。行がひとつもない保管場所が W104（まだ数えていない）になる。

### 2.3 ルールの params（T12 と T06 が共有する）

```ts
// packages/shared/src/rules.ts（zod 4）
const itemCode = z.string().regex(/^[a-z][a-z0-9_]*$/);
const category = z.enum(GROUP_CATEGORIES);
const uniq = <T>(a: T[]) => new Set(a).size === a.length;

export const substituteParams = z.strictObject({
  from: itemCode, to: itemCode,
  categories: z.array(category).min(1).refine(uniq),
  cost: z.number().int().min(0).max(10),          // c_sub。整数でないと 6 章の保証が崩れる
  indoorOnly: z.boolean().default(false),         // 使用場所の rooms.kind が room の団体だけ
  needsConsent: z.boolean().default(false),       // 了承が declined の団体には作らない
  preferCategory: category.optional(),            // 同じ距離なら、この区分に先に回す
}).refine((p) => p.from !== p.to, { path: ['to'] })
  .refine((p) => !p.preferCategory || p.categories.includes(p.preferCategory), { path: ['preferCategory'] });

export const sourceRestrictParams = z.strictObject({
  group: z.uuid(),
  items: z.array(itemCode).min(1).refine(uniq),   // 申請品目のコード（代替先を含めて制限する。7 章）
  rooms: z.array(z.uuid()).min(1).refine(uniq),
});
export const fixedRequestParams = z.strictObject({
  group: z.uuid(), item: itemCode, count: z.number().int().min(1).max(10000) });   // requests.count と同じ上限
export const keepParams = z.strictObject({
  group: z.uuid(), room: z.uuid(),
  items: z.record(itemCode, z.number().int().min(1).max(10000)).refine((o) => Object.keys(o).length > 0),
});

const ruleCode = z.string().trim().min(1).max(50);   // DB の rules.code（length(code) <= 50）と同じ
export const ruleSchema = z.discriminatedUnion('kind', [
  z.strictObject({ id: z.uuid(), code: ruleCode, kind: z.literal('substitute'), params: substituteParams }),
  z.strictObject({ id: z.uuid(), code: ruleCode, kind: z.literal('source_restrict'), params: sourceRestrictParams }),
  z.strictObject({ id: z.uuid(), code: ruleCode, kind: z.literal('fixed_request'), params: fixedRequestParams }),
  z.strictObject({ id: z.uuid(), code: ruleCode, kind: z.literal('keep'), params: keepParams }),
]);
export type Rule = z.output<typeof ruleSchema>;
/** 画面（T12）が保存する行。enabled と memo を足したもの */
export const ruleRowSchema = …;  // { code, kind, params, enabled, memo }
/** id のないルール（T12 の新規作成のフォーム）。Rule から id を除いたもの */
export type RuleDraft = Omit<Rule, 'id'>;
/** 参照と重なりを確かめる。T12 のフォーム（保存の前）と allocate の P0 の両方から呼ぶ */
export function checkRuleRefs(rule: RuleDraft, ctx: {
  items: Item[]; rooms: Room[]; groups: Group[];
  rules: Rule[];                       // 自分以外の有効なルール（編集中のルール自身は除く。新規なら全部）
}): RuleCheckError[];
export type RuleCheckError = InputError & { code?: 'E005' };   // E005 だけは allocate で precheck の Issue にする（5 章 P2）
```

- 保存は `z.output`（既定値を埋めた形）で行う。T12 は S01〜S08 を画面から登録し、fixtures/r8/rules.json を 3.4 の変換で id にしたものと `toEqual` で一致することを確かめる（T12 の完了基準。fixtures/r8 がなければ fixtures/synthetic/r8like/rules.json で代える。12.2）。
- strictObject なので、`indoorOnly` の綴り違いなどは保存前に止まる。DB の rules.params には `group` 以外の団体の参照（`groups` など）を置かない（DB 設計の create_year_from は `group` を付け替える）。
- checkRuleRefs が見ること：
  - 参照：group・room・rooms の id がその年度にあること、品目コードが items にあること。
  - 申請できる品目：fixed_request の item と keep の items の品目が、対象の団体の区分で申請できること（読み替えの元の品目（企業以外の長机(3人掛)）も不可。画面では読み替え先（長机(2人掛)）を選ぶよう案内する）。申請できない品目のまま需要や残すの行を作ると、S03 に反する変数（j ＝ i）や、どの申請にも当たらない行ができるため。
  - keep の room が団体の使用場所であること（違えば `code: 'E005'`）。
  - 重なり（ctx.rules と比べる）：fixed_request の（group, item）が他の fixed_request と重ならないこと、substitute の from→to が同じで区分が重なるルールが2つないこと、code が他のルールと重ならないこと（DB の unique (year_id, code) と同じ）。
- allocate の P0 は、enabled のルールを code 順に、自分以外のルールを ctx.rules にして呼ぶ（disabledRuleCodes のルールは除く）。T12 のフォームは保存の前に呼び、エラーを入力欄の下に出す。団体の区分や品目の申請できる区分を後から変えたときは、allocate の P0 で invalid_input（ruleCode つき）として見つかる。

### 2.4 結果と Issue

```ts
export type LpSolver = {               // allocator/src/solve.ts。highs の Highs がそのまま入る（型のテストで確かめる）
  solve(problem: string, options?: Record<string, unknown>): {
    Status: string; ObjectiveValue: number;
    Columns: Record<string, unknown> };   // 列の中身は実行時に確かめる（下の箇条書き）
};

export type AllocateResult =
  | { ok: true; rows: AllocationRow[]; objective: number; elapsedMs: number; stats: AllocateStats }
  | { ok: false; reason: 'invalid_input' | 'precheck' | 'infeasible' | 'solver_error';
      message: string;                 // 画面の見出し（日本語）
      inputErrors: InputError[];       // invalid_input のとき
      issues: Issue[];                 // precheck のとき（E001、残すのルールの E002・E005。K-13）
      shortages: Shortage[]; causes: Cause[];   // infeasible のとき
      elapsedMs: number; stats?: Partial<AllocateStats> };

export type AllocateStats = { variables: number; hatVariables: number; supplyRows: number;
  demandRows: number; demandUnits: number; dMax: number;
  weights: { W: number; mu: number; A: number; B: number };
  excludedRequests: number;            // 申請できない品目（E006）として需要から除いた申請の行の数（5 章 P1）
  lpChars: number; buildMs: number; solveMs: number; solverStatus: string };
export type InputError = { path: string; message: string; ruleCode?: string };
export type Shortage = { requestedItemId: string; groupId: string | null;  // null は品目全体（T07）
  demand: number; supply: number };
export type Cause = { ruleCode: string | null; message: string;
  details: { groupId?: string; itemIds?: string[]; roomIds?: string[]; demand?: number; supply?: number }[] };

export type IssueCode = 'E001' | 'E002' | 'E003' | 'E004' | 'E005' | 'E006'
  | 'W101' | 'W102' | 'W103' | 'W104' | 'W105' | 'W106' | 'W107' | 'I201';
export type Issue = { code: IssueCode; severity: 'error' | 'warning' | 'info'; message: string;
  refs: { roomId?: string; groupId?: string; itemId?: string; requestedItemId?: string;
          ruleCode?: string; rowIds?: string[] } };
```

- ok: false を1つの形にする（配列はどれも空でありうる）。画面は reason で見出しを変え、空でない一覧を出すだけでよい。
- message は allocator が日本語で作る。品目名が要るので items に name を足した。
- LpSolver の Columns を `{ Primal?: number }` の Record にすると、highs 1.15.4 の `Highs` を代入できない（Infeasible の解の列の型 HighsInfeasibleSolutionColumn は Primal を持たず、TS2322「has no properties in common」。logic-lab で tsc にかけて確かめた）。そのため `Record<string, unknown>` にし、runSolver が Optimal のときに各変数名について `typeof col === 'object' && col !== null && typeof col.Primal === 'number' && Number.isFinite(col.Primal)` を確かめる。満たさなければ solver_error（message に変数名）。

### 2.5 03 の型との差分

| 03 の型 | 変更 | 理由 |
| --- | --- | --- |
| items | name、requestableCategories を足す | 前処理1を品目マスタで判定（03）、E006、メッセージ |
| rooms | isStorage を足す | W104、Excel の保管場所 |
| groups | displayName、submittedAt を足す | D-07（未提出の判定）、W105、K-27（申請順）、交換依頼一覧の企画名 |
| rules | `Rule`（zod で検証した判別共用体。id を持つ） | params を型で扱う |
| consents | count（number \| null）を足す | DB の substitution_consents.count（P-01）。W102 の「了承した台数より多い置き換え」（DB 設計 6.5、spec-changes.md 3-3） |
| fixedRows | `StoredAllocationRow[]`（id・origin・pinned・note） | E001 などで該当の行を示す（refs.rowIds） |
| previousRows | 省略可 → 必須（full では []） | 分岐を減らす |
| allocate の引数 | `allocate(input, solver)` | highs を外から渡す（4 章） |
| AllocateResult の ok: true | stats を足す | notes/T06.md と画面の表示 |
| AllocateResult の ok: false | reason・message・inputErrors・issues を足す | K-13 |
| Shortage | groupId（null 可）を足す | 候補が足りない団体を示す |
| Cause | details を足す | 「設営の机(木)：需要241、1-1〜2-3 の在庫合計235」を組み立てる材料 |
| Issue.refs | requestedItemId・rowIds を足す | 代替の行と、該当の行への移動 |
| validate | `validate(data: YearData, rows: AllocationRow[])`（AllocateInput もそのまま渡せる） | 4・13 章 |

## 3. fixtures

### 3.1 置き場所

```
fixtures/
├─ r8/                       T05。手で書くもの（✎）と、scripts/build-r8-fixtures.ts が R8_SOURCE_DIR から作るもの（⚙）に分ける（3.8）
│   ├─ README.md             ✎ 出典、変換と読み替えの一覧、匿名化の方針（対応表そのものは書かない）、手で決めた値の根拠、reference から除いたもの
│   ├─ meta.json             ✎ { "schemaVersion": 1, "yearLabel": "R8", "kind": "r8" }
│   ├─ rooms.csv  rules.json  distance_overrides.csv     ✎
│   ├─ groups.csv  stocks.csv  requests.csv  consents.csv ⚙（groups.csv は manual/groups.csv に提出日時を足したもの）
│   ├─ manual/               ✎ build-r8-fixtures.ts の入力のうち、リポジトリに置けるもの（3.8）
│   │   ├─ groups.csv        団体の台帳（区分・使用場所・並び・提出のしかた）
│   │   ├─ adjustments.csv   R8 で決めた申請の読み替え・追加（05「fixtures/r8 の作り方」の例）
│   │   ├─ reference_skip.csv 振り分け表の、団体に当たらない使用用途（予備など）
│   │   └─ settings.json     代理入力の団体の提出日時など
│   └─ reference/            ⚙ R8 の手作業の振り分け（参考。T08 の出力テストと比較に使う。作り方は 3.8）
│       ├─ allocations.csv
│       └─ group_totals.csv
└─ synthetic/
    └─ r8like/               合成データ（scripts/gen-synthetic-fixtures.ts。シード 20261029）。fixtures/r8 と同じファイル
        └─ reference/        allocate の結果から生成する（allocations.csv・group_totals.csv。T06 の PR で足す。3.6）
```

- 形式は UTF-8・LF・見出しつきの CSV と JSON。.gitignore は fixtures/ の CSV を許している（T01）。readFixtureDir は 3.2 のファイルだけを読み、manual/ は読まない（manual/ は build-r8-fixtures.ts の入力。列は 3.8）。
- テストから fixtures を読むときは、パスを `import.meta.url` からリポジトリのルート（pnpm-workspace.yaml のあるディレクトリ）を求めて解決する（`@gaapp/shared/testing` の `repoRoot()`）。Vitest の projects（T01 の `packages/*`）では cwd がパッケージのディレクトリになるので、相対パスで読むと見つからずに静かにスキップされうるため。
- 読み込みは `readFixtureDir(dir): FixtureData`、書き出しは `writeFixtureDir(dir, data)`（`@gaapp/shared/testing`）。各行を zod の strictObject で検証し、知らない列があれば失敗にする（個人情報の列を足してしまうのを止める）。

### 3.2 各ファイルの列

| ファイル | 列 | 備考 |
| --- | --- | --- |
| rooms.csv | name, kind, building, floor, is_storage, extra_cost, sort_order, usable, aliases | usable はその年度の状態（room_years）。aliases は `\|` 区切り。屋外は building・floor が空 |
| groups.csv | name, display_name, category, is_food, location, sort_order, submitted_at, aliases | location は rooms.csv の name か空（校内分散）。submitted_at は ISO（+09:00）か空（未提出）。R8 での決め方は 3.8、合成データは 3.6 |
| stocks.csv | room, desk, desk_ng, chair, chair_ng, caster_desk, blue_chair, long_desk_3, long_desk_2, lectern | 1行＝数えた場所1つ（横持ち。机・椅子数えの表と同じ向き）。列は items のコード |
| requests.csv | group, （品目コードの列） | 正規化した申請（05「fixtures/r8 の作り方」の読み替えの後、代替の前） |
| consents.csv | group, from, to, status, count | R8 は見出しだけ（テストで拒否などを足す）。count は依頼したときの置き換え台数（空は null） |
| distance_overrides.csv | building_a, building_b, cost | building_a < building_b |
| rules.json | `[{ "code", "kind", "enabled", "memo", "params" }]` | params の団体・場所は名前で書く（`"group": "設営"`, `"rooms": ["1-1", …]`）。品目はコード |
| reference/allocations.csv | item, source, group, requested_item, count, note | R8 の振り分け表の行。使用不可の「残す」行は入れない。note は決まった文言（「キャスター机に交換」など）だけ。テストで許す文言の一覧と照合する。group は groups.csv の名前だけ（剣道部も2団体のどちらか。例外の名前は許さない）。requested_item の決め方は 3.8 |
| reference/group_totals.csv | group, （品目コードの列） | R8 の団体別集計（振り分け表の集計シートの値。剣道部は2団体に分けた値）。振り分け表の行の合計と集計シートの値が合わない団体は載せない（README に一覧。3.8）。合成データでは allocations.csv を団体・品目ごとに足したもの（Excel の SUMIF が出すべき値） |

### 3.3 id の付け方

- 決定的な UUIDv5。名前空間は `90d00e37-57c2-4d9a-8daa-d9d2ba50c836`（この設計で作った値。shared/testing の定数）。
- 名前：品目 `item:<code>`、場所 `room:<name>`、団体 `group:<label>:<name>`、ルール `rule:<label>:<code>`、固定行（テストで作るもの）`row:<連番>`。年度の id は fixtures では作らない（AllocateInput・YearData は年度の id を持たない。DB の R8 の年度は T04 の seed の固定の id。3.4）。
- 実装は node:crypto の sha1（RFC 4122 の v5）。DNS 名前空間と `www.example.com` から `2ed6657d-e927-568b-95e1-2665a8aea6a2` になることをテストする。
- 同じ名前は同じ id になるので、fixtures の中で団体名・場所名は重複させない（DB の unique と同じ）。T00 の gen.ts にあった「同名で id だけ違う団体」は、id で並べる段の確認なので、builder で作る単体テストに移す。

### 3.4 変換と seed（DB 設計の 1 章・2.3・8.3 にそろえる）

- 品目は fixtures に持たず、shared の INITIAL_ITEMS（Vitest での id は `item:<code>`）を使う。T02 の seed の品目も INITIAL_ITEMS と同じ内容にする（id は DB の既定の gen_random_uuid のまま。DB 設計 2.3）。
- `toYearData(fixture, { yearLabel })`：名前を 3.3 の id にし、rules.json の名前を id に置き換えて ruleSchema で検証する（失敗はテストの失敗）。返り値は YearData。`toAllocateInput(fixture, opts)` は mode・fixedRows・previousRows を足す。
- seed のファイルは DB 設計どおり `supabase/seed.sql` の1本で、上から T02（品目9件とテスト用の場所）→ T04（R8 の年度を固定の id `00000000-0000-4000-8000-0000000000a1` で作る、テスト団体・招待・ユーザー）→ T05（R8 の本データ）の順に並ぶ。
- T05 の部分は `scripts/build-seed-r8.ts` が fixtures/r8 から生成し、seed.sql の `-- BEGIN R8 DATA (generated by scripts/build-seed-r8.ts)` と `-- END R8 DATA` の間を書き換える（手で直さない）。中身：場所（id は 3.3。全年度共通の表なので `on conflict do nothing` は使わず、名前がテスト用の場所と重ならないことを生成時に確かめる）、R8 の年度（固定の id …a1。作り直さない）への room_years・団体・在庫・ルール（params は id）・申請・提出。品目は `(select id from public.items where code = 'desk')` のように code で引く。
- 生成し直した区間がコミット済みの seed.sql の区間と一致することを、scripts/ の Vitest で確かめる（ずれの検出）。
- その結果、DB と Vitest で同じになるのは場所・団体・ルールの id で、品目と年度の id は違う。品目は sort_order がすべて違うので、並び（8 章）も LP も id に依らず、DB から組み立てた入力と fixtures の入力は、品目の id を code で読み替えれば同じ結果になる。DB と fixtures の結果を比べるテスト（T13・T14）は、行を（場所名・団体名・品目コード・申請品目コード）で比べる。
- DB の R8 の年度には、T04 の「テスト団体」（未提出・申請なし）と、T02 のテスト用の場所（在庫なし）も入る。需要と在庫が0なので振り分けの結果は変わらないが、validate では W105（未提出）が1件、W104（数えていない保管場所）がテスト用の保管場所の数だけ増える。T13・T14 の E2E はこの分を見込む（error ではないので確定できる）。
- 画面（T13）が DB から入力を作るときは shared の `fromDb(rows): YearData`（snake_case → camelCase、room_years の結合〔行がない場所は usable ＝ true〕、request_submissions の submitted_at の結合、substitution_consents の count）を使う。

### 3.5 個人情報（D-03）

- fixtures に入れるのは 3.2 の列だけ。備考（request_submissions.note）・氏名・学籍番号・電話・メールの列はない。strictObject の検証で、列を足すとテストが落ちる。
- 団体名に個人名（研究室名の教員名など）があれば、T05 で仮名（「研究室A」）に置き換える。対応表は `R8_SOURCE_DIR` の中にだけ置き、README には方針だけを書く。
- テスト：fixtures/ と supabase/seed.sql にメールのパターンがないこと（T01 の check-emails と同じ規則。T04 のテストユーザーの `@example.test` のような予約ドメインは許す）、reference の note が許す文言だけであること。

### 3.6 合成データ（fixtures/synthetic/r8like）

- T00 の gen.ts・rng.ts（mulberry32）を `@gaapp/shared/testing/synthetic.ts` に移す。直すところ：品目コード `chair_blue` → `blue_chair`。id は rng ではなく 3.3 の UUIDv5（名前から）。返り値を FixtureData（名前の形）にする。同名の団体を作る仕掛けは外す。
- **乱数の列を T00 と同じに保つ**（11 章の実験の値を引き継ぐため）。T00 の `uuid(r)` は1回で r() を30回呼ぶので、id を UUIDv5 にしただけでは、その後の在庫の配分・申請の配分がすべて T00 と変わる。そこで、T00 で `uuid(r)` を呼んでいた場所（品目9・場所56・団体55の id）では、`uuid(r)` を呼んで値を捨て（捨て読み）、id は UUIDv5 で作る。足す団体（下）の id では r() を呼ばない。
- 合計は R8 にそろえる（T00 のまま）：在庫は 05 の表（使用不可の第一セミナーに キャスター机1・椅子(青)49・長机(2人掛)25・教卓2）。需要 N = 1,295（机 644 ＝ 机 506＋不可机 41＋置き換え 97、椅子 372、椅子(青) 134、キャスター机 29、教卓 10、長机(3人掛) 12〔企業以外の2は読み替え〕、長机(2人掛) 94）。
- 足すもの（R8 にありそうで T00 になかった形）。乱数の列を変えないように、T00 の申請をすべて作った後に、r() を使わずに足す。並び（sort_order）は休憩所2の後に続ける。
  - 「剣道部(飲食)」「剣道部(非飲食)」（模擬店。使用場所はどちらも 外16）：屋外の模擬店の最後の2つ（模擬店38・模擬店39）から、それぞれ机(木)2・椅子(木)2 を移す。
  - 「部門(校内分散)」（部門。使用場所なし）：部門09 から机(木)2・椅子(木)2 を移す。
  - 「未提出の団体」（模擬店。使用場所 外16。申請なし。fixed_request の対象ではない）。
  - 移すだけなので、品目ごとの需要の合計は変わらない。
- submitted_at：未提出の団体だけ空（W105 が1件）。ほかは `2026-07-01T12:00:00+09:00` に sort_order 分を足した時刻（r() を使わない）。設営も提出済みにする（申請の 241 を使い、D-07 の固定数は効かない。未提出のときの D-07 は builder の単体テストで確かめる）。
- 置き換え 97 と keep の 18 は、乱数の配分ではなく合計と固定値から決まる構造の値である（12.2 の期待値はこれに依る）：
  - 97 ＝ 机(木)系の需要 644 − 机(木) 506 − 不可机 41。机(木)はすべて使用可で、不可机（代替の重さ 0）は模擬店の机の需要（287）より少ないので使い切り、残りはキャスター机（重さ 3）にしか回せない。
  - 18 ＝ 学科展示の机の申請（固定値 18。残す 12 ＋ 追加 6）。第一多目的室の机は固定値 20 で、学科展示の自室なので距離 0。残りの 6 も自室から取り、keep の行と同じキーの1行になる。
- 移した後の確認（T06 の最初の作業。満たすまで 3.6 の生成器を直す）：新しい r8like を full で解いて ok: true・置き換え 97・keep の机 18 であること、MER を使用不可にした minimal_change が ok: true で、MER から運んだ前回の行が1行以上あり、12.3 の「補えるつながり」が1つ以上あること。満たさないときは、まず捨て読みの位置が T00 と同じかを確かめ（捨て読みだけで足す団体なしなら、在庫と申請の数は T00 と完全に一致する）、それでも満たさなければ、12.3 の対象の部屋 M を「前回 M から運んだ行があり、minimal_change で解け、補えるつながりがある」部屋から sort_order の順に選び直し、選んだ部屋を notes/T06.md に書く。T00 のデータでも、MER・HI1・CI2 の 90 通りのうち 18 通りは使用不可にすると解けないので、部屋の選び方で解けないことはありうる。
- logic-lab で上の移し方（port/gen.ts）を試した結果（highs 1.15.4）：

  | 生成のしかた | シード 20261029 の full | 置き換え・keep の机 | MER の minimal_change（つながり・補える・M から運んだ行） | シード 100〜129 × MER・HI1・CI2（解けた・補えるつながり・補えるつながりのない入力） |
  | --- | --- | --- | --- | --- |
  | T00 のまま | Optimal | 97・18 | Optimal（4・3・13） | 72/90・180・3 |
  | 捨て読み（足す団体なし） | Optimal。在庫・申請の数は T00 と一致し、rows も一致（シード 101・102 は同名の仕掛けを外した分だけ 13〜22 行違う） | 97・18 | Optimal（4・3・13） | 72/90・180・3 |
  | 捨て読み＋足す団体（採用） | Optimal | 97・18 | Optimal（4・3・16） | 72/90・179・3 |
  | 捨て読みなし＋足す団体 | Optimal。rows は T00 とほぼすべて違う | 97・18 | Optimal（3・2・10） | 71/90・182・2 |

  どの作り方でも条件は満たしたが、捨て読みなしでは 11 章の数が引き継げないので、捨て読みを採用する。
- `scripts/gen-synthetic-fixtures.ts` がシード 20261029 で fixtures/synthetic/r8like を書く。もう一度生成した結果がコミット済みのファイルと一致することを Vitest で確かめる。シード 100〜129 の30通りは、テストの中でその場で作る（ファイルにしない）。
- reference/（T06 の PR で足す）：`scripts/gen-synthetic-reference.ts` が r8like を full で allocate し（highs 1.15.4）、rows を名前の形で reference/allocations.csv に、団体・品目ごとの合計を reference/group_totals.csv に書く。note は空（T08 の自動の備考は exporter が付ける。13.2）。再生成した結果がコミット済みのファイルと一致することを、scripts/ の Vitest（T01 の vitest.config.ts の `scripts` プロジェクト。allocator と highs を import してよい）で確かめる。T08 のテストはこのファイルを読むだけで、allocator を import しない。

### 3.7 importer の出力（T05）

```ts
export type FormKind = 'stall' | 'department' | 'company';
export type ParsedFormResponse = {
  rowNumber: number;                   // CSV の行番号（見出し＝1）
  submittedAt: string;                 // タイムスタンプ（Asia/Tokyo として読み、ISO で返す）
  groupName: string | null;            // 模擬店は2列のうち空でない方。企業は null
  counts: Record<string, number>;      // 品目コード → 数（列名は items.aliases で対応）
  note: string | null;                 // 備考。アプリでは保存するが、fixtures には書かない
};
export type ParsedForm = {
  kind: FormKind;
  responses: ParsedFormResponse[];
  rejected: { rowNumber: number; reason: 'misaligned' | 'invalid_number' | 'empty' }[];   // 中身は持たない
  ignoredColumns: string[];            // 対応表にない列の見出し（中身は読まない。D-03）
};
export function parseFormCsv(kind: FormKind, csv: string,
  items: { code: string; aliases: string[] }[]): ParsedForm;

export function resolveResponses(parsed: ParsedForm,
  groups: { id: string; name: string; aliases: string[]; category: GroupCategory }[],
  items: Item[], manual: Record<number, string /* rowNumber → groupId（企業など） */>): {
  requests: RequestRow[];              // rewriteRequestedItem（S03）を当て、(groupId, itemId) ごとに合計した後。同じキーは1行
  submissions: { groupId: string; submittedAt: string; note: string | null }[];   // submittedAt はフォームのタイムスタンプ
  unmatched: { rowNumber: number; groupName: string | null }[];
  superseded: { groupId: string; keptRow: number; droppedRows: number[] }[];   // 同じ団体の古い回答
};
```

- メールアドレスは parseFormCsv の中で、どの列にあっても読まずに捨てる。戻り値・例外・ログのどこにも出さない（rejected も行番号と理由だけ）。
- 品目の読み替え（企業以外の長机(3人掛) → 長机(2人掛)）は shared の `rewriteRequestedItem(itemCode, category, items)` を使う。allocate の前処理1と同じ関数である。
- requests は、読み替えの後に (groupId, itemId) ごとに合計して1行にする。同じ団体が長机(3人掛)と長机(2人掛)の両方を申請していると、読み替えの後に (団体, 長机(2人掛)) が2つになり、requests の主キー (group_id, item_id) に insert できない（upsert でも「ON CONFLICT DO UPDATE command cannot affect row a second time」になる）ため。T05 のテストに、両方を申請した回答を足す。
- submittedAt の保存（K-27 の申請順のため）：DB 設計では、ログイン中の書き込みのとき tg_submissions_set_actor が submitted_at を now() に置き換え、submit_requests・update_requests_after_deadline も now() を入れる。このままでは T11 で取り込んだ団体はすべて取り込んだ時刻になり、Excel の団体別集計の「区分の中は申請順」がフォームの提出順にならない（seed は postgres で流れるので値が残り、Vitest・seed と本番とで並びが変わる）。そこで、取り込みではフォームのタイムスタンプを submitted_at として保存できるようにする：update_requests_after_deadline（admin だけが呼べる）の p_submission に `submittedAt`（ISO）を足し、RPC がそのときだけ transaction-local の設定（`set_config('app.keep_submitted_at', 'on', true)`）を立て、トリガーはそれが立っているときは値を置き換えない。団体代表の submit_requests と直接の書き込みは今までどおり now()。DB 設計への申し送り（16 章）。DB に入るまでは、取り込んだ団体の並びは「取り込んだ時刻 → sort_order → 名前 → id」になる（K-27 の申請順は満たさない）ことを T11 の notes に書く。

### 3.8 fixtures/r8 の作り方（T05。手で書くものと生成するもの）

R8 の元データ（フォーム回答・机椅子数え・最終の振り分け表）には、場所の建物・階・種類、団体の区分・使用場所・並び、ルールがない。そこで、元データにないものは手で書いてコミットし、元データから決まるものだけを scripts/build-r8-fixtures.ts が `R8_SOURCE_DIR` から作る。

| ファイル | 作り方 | 中身の出どころ |
| --- | --- | --- |
| rooms.csv | ✎ 手で書く | 机椅子数えの場所の一覧に、building・floor・kind・is_storage・extra_cost・sort_order・usable・aliases を足す。建物・階は 00 の未決事項（建物・階のデータ）なので、分からない部屋は仮の値にして README に根拠を書く。aliases は机椅子数えと振り分け表での表記ゆれ（場所名に個人情報はない） |
| rules.json | ✎ 手で書く | 01 の S01〜S08 を 3.2 の形で（団体・場所は名前） |
| distance_overrides.csv | ✎ 手で書く | 05 の段階値で足りなければ（R8 で調整したもの）。なければ見出しだけ |
| meta.json・README.md | ✎ 手で書く | 3.1 |
| manual/groups.csv | ✎ 手で書く | 列：name, display_name, category, is_food, location, sort_order, aliases, submission。name は匿名化した後の名前。aliases はフォームの表記ゆれのうち個人情報を含まないもの。submission は `form`（フォームで提出）・`proxy`（総務の代理入力：企業・休憩所・四役・設営など）・`none`（未提出）。剣道部は2行（剣道部(飲食)・剣道部(非飲食)） |
| manual/adjustments.csv | ✎ 手で書く | 列：group, item, op（`add`・`set`）, count, reason。R8 で決めた読み替え・追加と代理入力の数（05 の例：SE企画の長机(3人掛)→キャスター机6、剣道部の机2・椅子1の追加、設営241、四役・休憩所・企業の代理入力分）。reason は README の変換の一覧と同じ文言 |
| manual/reference_skip.csv | ✎ 手で書く | 列：use, reason。振り分け表の使用用途のうち団体に当たらないもの（予備など） |
| manual/settings.json | ✎ 手で書く | `{ "proxySubmittedAt": "<R8 の申請締切の日時（+09:00）>" }`。出典を README に書く |
| groups.csv | ⚙ 生成 | manual/groups.csv に submitted_at を足したもの（下の規則） |
| stocks.csv | ⚙ 生成 | 机椅子数えの最終値。場所名は rooms.csv の name・aliases で対応させ、合わない名前があれば失敗にする |
| requests.csv | ⚙ 生成 | フォーム回答を importer（parseFormCsv・resolveResponses）で読み、adjustments.csv を当てたもの。読み替え（rewriteRequestedItem）と (団体, 品目) ごとの合算は importer と同じ |
| consents.csv | ⚙ 生成 | R8 は見出しだけ |
| reference/allocations.csv・group_totals.csv | ⚙ 生成 | 最終の振り分け表（下の規則） |

匿名化：団体名に個人名（研究室名の教員名など）があれば、`R8_SOURCE_DIR/anonymize.csv`（列：source_name, fixture_name）で仮名にする。build-r8-fixtures.ts は、元データの団体名・使用用途に、まず anonymize.csv を当ててから manual/groups.csv の name・aliases で対応させる。対応しない名前があれば、その名前を出さずに行番号だけを示して失敗にする（個人名をログに出さない）。anonymize.csv はリポジトリに入れない。

提出日時（submitted_at）の規則：

- submission ＝ form：resolveResponses が残した回答（同じ団体の最後の回答）のタイムスタンプ。importer と同じ値なので、T11 で取り込んだ DB とそろう（DB の対応が入った後。3.7）。
- submission ＝ proxy：manual/settings.json の proxySubmittedAt（R8 の申請締切の日時）。空にしない理由：空にすると W105 が出続け、Excel の団体別集計で最後に回り（K-27）、設営は D-07 で申請ではなく S06 の固定数が需要になる（R8 では同じ 241 だが、代理入力した数を使うという R8 の実際と違う）。同じ日時の団体の並びは K-27 のとおり sort_order → 名前 → id。
- submission ＝ none：空（W105）。R8 で当てはまる団体があれば README に書く。
- フォームで提出した団体に adjustments.csv の追加（締切後の変更）があっても、submitted_at は変えない。

reference/allocations.csv の規則：

1. 振り分け表の各品目シートの行（品目・運び元・使用用途・数・備考）を読む。計・余りの行、使用不可の部屋の「残す」行、reference_skip.csv の使用用途の行は除く。
2. 使用用途を上の匿名化と対応で団体にする。振り分け表で1団体の「剣道部」は、manual/groups.csv の2団体の aliases のどちらにも入れず、手順4で分ける。
3. requested_item を次の順に決める（S01〜S07 のどれで置き換えた行かを、品目と備考から決める）：
   - 品目が desk_ng → desk（S01）。chair_ng → chair（S02）。
   - 品目が caster_desk で、備考が「キャスター机に交換」→ desk（S07）。備考がなければ caster_desk。
   - 品目が long_desk_2 で、団体が企業：その企業の長机(3人掛)の申請から、その企業への長机(3人掛)の行の合計を引いた数（0 未満は 0）までを、表の行の順に long_desk_3（S04）とし、残りを long_desk_2 にする（1行の途中で分かれるときは2行に分ける）。
   - それ以外は品目と同じ。
4. 剣道部：requests.csv の2団体の申請を、requested_item ごとに sort_order の順（剣道部(飲食) → 剣道部(非飲食)）に満たすように、表の行の順に割り振る（1行の途中で分かれるときは2行に分ける）。申請より多い分は剣道部(非飲食)に付け、README に書く。2団体の合計が振り分け表の剣道部の行の合計と品目ごとに等しいことを、生成のときに確かめる。
5. 確かめるもの（生成のときに失敗にする）：group・source・item が fixtures の名前とコードであること、note が許す文言だけであること（3.5）。確かめて README に書くもの（失敗にしない）：(団体, requested_item) ごとの合計が requests.csv の申請と違う組（R8 の手作業と申請の差。T08 の比較は品目ごとの団体別集計なので、requested_item の差は影響しない）。

reference/group_totals.csv の規則：振り分け表の団体別集計シートの値を、手順2の対応で団体にして書く。剣道部は、手順4で分けた行を2団体それぞれで足した値にする（集計シートの剣道部の値と、2団体の和が等しいことを確かめる）。集計シートの値と、allocations.csv をその団体・品目で足した値が違う団体（手で直した集計など）は group_totals.csv に載せず、README の「比較から除いた団体」に一覧で書く。T08 のテストは group_totals.csv に載っている団体だけを比べ、載っている団体の数が groups.csv の団体の数から README の除いた数を引いた数と等しいことも確かめる（静かに減らないように）。

テスト（T05）：build-r8-fixtures.ts を、R8_SOURCE_DIR の代わりに匿名化した小さなサンプル（scripts/ の下のテスト用データ）で流し、上の規則（剣道部の割り振り、企業の長机の requested_item、代理入力の submitted_at、対応しない名前で失敗し名前を出さないこと）を確かめる。本物の元データでの生成は手で実行し、生成物だけをコミットする。

## 4. allocate() のモジュール構成

```
packages/allocator/src/
├─ index.ts            allocate・diagnose・validate・prepare・buildModel・writeLp・distance・findW107・HIGHS_OPTIONS を export
├─ allocate.ts         全体の流れ
├─ context.ts          入力の検証・並べ替え・索引（Ctx）
├─ prepare.ts          前処理（5 章）
├─ rules.ts            代替の候補・運び元の制限・「この組み合わせを使えるか」（7 章。validate の E004・W107 でも使う）
├─ distance.ts         距離 d（6.1）
├─ candidates.ts       変数の候補と、候補が足りない需要（7 章）
├─ weights.ts          K・P・d_max から W・μ・A・B と係数（6.2）
├─ lp.ts               CPLEX LP 形式の文字列（8 章）
├─ solve.ts            LpSolver、HIGHS_OPTIONS、状態の判定と整数の確認
├─ rows.ts             結果の行（10 章）
├─ diagnose.ts         解けないときの診断（T06 は形と最小限、T07 が埋める）
├─ validate.ts         T07
├─ w107.ts             W107 の判定（T06 のテストで使い、T07 が Issue にする）
└─ testing/            テスト用：getHighs（ファイルごとに1回 loadHighs）、独立した検算 checkInvariants、段ごとに解く辞書式の検算 solveLexStages（12.1）。
                       index.ts からは export しない。ESLint の例外（1 章）で highs と @gaapp/shared/testing を import してよい
```

| 関数 | 入力 | 出力 |
| --- | --- | --- |
| `allocate(input, solver)` | AllocateInput、LpSolver | AllocateResult（同期。highs の solve は同期） |
| `createContext(input)` | AllocateInput（未検証） | `{ ok: true, ctx: Ctx } \| { ok: false, inputErrors }`。Ctx は並べ替えた items・rooms・groups・rules（code 順）と id → 実体・code → id の索引、上書きの表（無向の組 → cost） |
| `prepare(ctx, opts)` | Ctx、`{ disabledRuleCodes?: string[] }` | `Prepared = { demandBase: Map<gi, number>; demand: Map<gi, number>; supply: Map<rj, number>; keepRows: AllocationRow[]; hatBound: Map<rgij, number>; issues: Issue[] }` |
| `buildCandidates(ctx, prepared)` | Ctx、Prepared | `{ vars: Candidate[]; demandRows: { key: gi; vars: number[] }[]; supplyRows: { key: rj; vars: number[] }[]; shortages: Shortage[] }`。Candidate は `{ r, g, i, j, hat, ub, d, e, p, cSub }` |
| `computeWeights(cands, mode)` | 候補、mode | `{ K, P, dMax, A, B, U, mu, W }` と、候補ごとの整数の係数 |
| `buildModel(input, opts)` | AllocateInput、`{ disabledRuleCodes? }` | `{ ctx, prepared, cands, weights, lp: string, names: string[] }`（テストと diagnose が使う） |
| `writeLp(model)` | 候補・係数・需要・在庫 | LP の文字列 |
| `runSolver(solver, lp, names)` | LpSolver、LP、変数名 | `{ status: 'optimal', values: number[], objective } \| { status: 'infeasible' } \| { status: 'error', message, solverStatus }` |
| `toRows(ctx, cands, values, keepRows)` | — | AllocationRow[]（10 章） |
| `diagnose(input, solver, found)` | AllocateInput、LpSolver、P7 で見つけた団体つきの shortages（LP が Infeasible のときは []） | `{ shortages, causes }`（T07。9 章） |

流れ（allocate.ts）：

1. createContext。だめなら `ok: false, reason: 'invalid_input'`。
2. prepare。issues（E001、残すのルールの E002・E005）があれば `reason: 'precheck'`（LP は作らない）。
3. buildCandidates。shortages があれば diagnose を呼んで `reason: 'infeasible'`（LP は作らない）。需要の行が0なら、keepRows だけを rows にして ok: true（solver を呼ばない）。
4. computeWeights → writeLp → runSolver。infeasible なら diagnose を呼んで `reason: 'infeasible'`。error なら `reason: 'solver_error'`。
5. toRows。最後に自己検算（LP の部分の行の合計が、需要の行ごとに D′ と等しく、在庫の行ごとに S′ 以下）をして、合わなければ `solver_error`（バグの検出）。

highs の渡し方：

- allocator は highs を import しない。LpSolver（2.4）は highs の `Highs` の部分の形で、`const s: LpSolver = await loadHighs()` が型エラーにならないことを型のテストで確かめる。
- Node のテスト：`testing/getHighs.ts` が `loadHighs()` をファイルごとに1回だけ呼んで使い回す（Node では既定の場所から wasm を読む）。
- ブラウザ（T13）：Web Worker の中で1回だけ読み込み、使い回す（T00 の注意2）。

```ts
// apps/web/workers/allocate.worker.ts（T13。形だけ）
import loadHighs from 'highs';
import { allocate } from '@gaapp/allocator';
import { HIGHS_VERSION } from '@gaapp/shared';
const base = process.env.NEXT_PUBLIC_BASE_PATH ?? '';
let solver: Promise<LpSolver> | null = null;
const getSolver = () => {
  solver ??= loadHighs({                                  // オプションのオブジェクトは呼ぶたびに新しく作る（T00）
    locateFile: (f: string) => f.endsWith('.wasm') ? `${self.location.origin}${base}/highs.wasm?v=${HIGHS_VERSION}` : f,
  }).catch((err) => { solver = null; throw new SolverLoadError(err); });   // 失敗を残さない。次の実行で読み直す
  return solver;
};
const fail = (message: string) => ({ ok: false, reason: 'solver_error', message,
  inputErrors: [], issues: [], shortages: [], causes: [], elapsedMs: 0 });
self.onmessage = async (e: MessageEvent<{ input: AllocateInput }>) => {
  let s: LpSolver;
  try { s = await getSolver(); }
  catch (err) { postMessage(fail(`計算エンジン（highs）を読み込めませんでした。通信を確かめて、もう一度実行してください（${String(err)}）`)); return; }
  try { postMessage(allocate(e.data.input, s)); }
  catch (err) { postMessage(fail(`計算中に予期しないエラーが起きました（${String(err)}）`)); }
};
```

- 読み込みに失敗した Promise を `solver` に残すと、ページを読み直すまで毎回失敗するので、失敗したら null に戻す。読み込みの失敗と計算の失敗は message で分けて画面に出す（どちらも reason は solver_error）。
- `apps/web/public/highs.wasm` は node_modules/highs/build/highs.wasm からコピーする（git には入れない。T00 の結論）。コピーは apps/web の package.json の `predev` と `prebuild` の両方で行う（`node ../../scripts/copy-highs-wasm.mjs`）。prebuild だけだと `pnpm dev`（SPEC の E2E 手順2、総務の手元での確認）で wasm が 404 になり、自動振り分けが `CompileError: expected magic word` で失敗する。`apps/web/public/highs.wasm` を .gitignore に足す。Playwright（T01 の playwright.config.ts は out/ を serve）は build を通るので prebuild で足りる。`next build --webpack` は使わない。

## 5. 前処理の手順（prepare）

記号：g＝団体、i＝申請品目、j＝実際に運ぶ品目、r＝保管場所、L(g)＝g の使用場所（ないこともある）。キーは gi＝(g,i)、rj＝(r,j)、rgij＝(r,g,i,j)。走査はすべて Ctx の並び（8 章）で行う。

**P0 入力の確認**（createContext。失敗は invalid_input）

1. allocateInputSchema で検証する。
2. 参照：stocks・requests・consents・fixedRows・previousRows の id が items・rooms・groups にある。groups.locationRoomId が rooms にある。id の重複がない。consents の (g, from, to) が重複しない。
3. ルール：disabledRuleCodes を除き、各ルールに checkRuleRefs（2.3。ctx.rules は自分以外の有効なルール）。`code: 'E005'` のもの（keep の room が使用場所でない）は P2 の precheck として扱い、それ以外は invalid_input（ruleCode つき）。
4. 固定行・前回の行の申請品目：fixedRows と previousRows の requestedItemId に、P1 と同じ読み替え（rewriteRequestedItem。企業以外の長机(3人掛) → 長机(2人掛)）を当てて Ctx に入れる。DB の行は変えない。読み替えないと、手動の行（申請品目が長机(3人掛)）が D′(g, 長机(2人掛)) から引かれず、LP の行と二重に割り当てる。validate も同じ読み替えをしてから比べる。

止めるかどうかの方針：allocate が作る行（LP の行と keep の行）には error（E001〜E006）が出ないようにする。人が決めた固定行の error では止めず、validate が示す（error は確定を止めるので、そのまま確定されることはない）。止めるのは、LP そのものが意味を持たなくなるもの（固定行と keep の行で在庫が負になる E001）と、allocate が自分で error の行を作ってしまうもの（keep のルールの部屋が使用不可 E002・使用場所でない E005）だけである。

**P1 需要 D**（shared の buildDemand。validate・画面の「団体別」も同じ関数を使う）

1. requests を gi ごとに合計する（重複行は足す。count 0 は無視）。
2. 品目 i が g の区分で申請できない（items.requestableCategories に g.category がない）とき：REQUEST_REWRITES に i のコードがあり、読み替え先が申請できれば、その品目に読み替えて足す（S03・D-05。企業以外の長机(3人掛) → 長机(2人掛)）。読み替えられなければ、その申請を需要から除き、`excluded`（E006 の候補。refs: groupId, itemId）に入れる。allocate は止めない（stats.excludedRequests に数を入れる）。validate は同じ buildDemand の excluded から E006（error）を出すので、その申請を直すまで確定できない。
3. fixed_request（code 順）：対象の団体が未提出（submittedAt が null）なら、D(g, item) を params.count にする（requests の数は使わない）。提出済みなら何もしない（0 を含めて申請の数を使う。違えば validate の W106。D-07）。fixed_request の item は checkRuleRefs で申請できる品目に限っている（2.3）。
4. これを D とする（demandBase）。E003・W101 と画面の申請数はこの D と比べる。buildDemand の返り値は `{ demand: Map<gi, number>; excluded: { groupId; itemId; count }[] }`。

E006 を止めない理由：DB は申請の書き込みで E006 を止める（DB 設計。長机(3人掛)は例外）ので、新しく入る E006 は、品目の申請できる区分や団体の区分を後から変えた場合だけである。そのとき allocate を止めると、自動振り分けが一切動かなくなる。除いて解けば、管理者は振り分けの結果と E006 の一覧を同時に見て、申請を直してから再実行できる。

**P2 残す（keep。D-06）**

1. keep ルールを code 順、params.items を品目の並び順に見る（オブジェクトのキーの順に依らない）。
2. params.room が L(g) と違えば E005、params.room が使用不可なら E002（refs: ruleCode）。これは precheck で止める（allocate が error の行を作らないため）。
3. 同じキー (room, g, item, item) の固定行（P0 の読み替えの後）の合計 f を引き、`n − f > 0` なら、その数で keep の行を作る（is_keep、requestedItemId = itemId）。手で固定した keep の行（D-06）や手動の行と重なっても二重にならない。f が n を超えた分は固定行のまま残る（多ければ validate の W101）。
4. 団体の申請が keep より少なくても、keep の数をそのまま作る（S08 は数を決めている。多い分は W101）。keep の items は checkRuleRefs で申請できる品目に限っている（2.3）。

**P3 固定行の扱い**

1. 申請品目は P0 の 4 で読み替えてある。
2. 固定行では止めない：運び元が使用不可（E002）、is_keep と使用場所の不整合（E005）、ルール違反と、読み替えても申請できない申請品目（E004）、申請との差（W101）は validate が示す。了承済みで固定した置き換えの運び元を使用不可にした場合も、allocate は解き、validate の E002 がその行を示す。管理者は行を直してから（固定を外すか運び元を変える）もう一度実行する。
3. allocate は固定行の isKeep を使わない（結果の行の isKeep は 10 章の規則で決める）。

**P4 差し引き**

1. D′(g,i) = max(0, D(g,i) − 固定行と keep の行の (g, requestedItemId) の合計)。
2. S′(r,j) = S(r,j) − 固定行と keep の行の (r, itemId) の合計。負なら E001（refs: roomId, itemId, rowIds、keep が関わるなら ruleCode）。使用不可の部屋でも、在庫を超えていれば E001。
3. 使用不可の部屋は S′ を 0 にする（在庫の行は validate・exporter のために入力に残る）。

**P5 止めるか**：P2・P4 の issues（E001、keep のルールの E002・E005）が1つでもあれば `reason: 'precheck'`。

**P6 前回の行（minimal_change だけ）**

1. previousRows（P0 の読み替えの後）を rgij で合計し、P2 の keep の行の数を同じキーから引く（keep の行は毎回ルールから作るので x̂ にしない。D-06）。
2. 残りが正のキーを hatBound に入れる。x̂ を作るかは 7 章（x がないキーには作らない。K-14）。

**P7 候補のない需要**（buildCandidates）

1. D′ > 0 の gi で、変数が1つもないもの、または変数の運び元（rj の重複なし）の S′ の合計が D′ に足りないものを shortages（groupId つき、supply＝その合計）にする。
2. 1つでもあれば LP を作らない（変数のない行を落とすと HiGHS が Optimal を返し、その分が0になる。T00）。diagnose を呼び、この shortages を渡す。S05 が原因の典型の入力（S05 の部屋の机の合計 235 に対して設営の需要 241）は、LP まで届かずにここで止まる（logic-lab で T00 の makeInfeasibleS05 を組んで確かめた）。diagnose はこの場合もルールを外して解き直す（9 章）。
3. P7 は buildModel の中で行う。diagnose がルールを外して解き直すときも、外したルールで P1〜P7 をやり直す。

## 6. 距離とコスト

### 6.1 距離 d(r, g)（K-15 の穴を埋めた完全な定義）

上から順に、最初に当てはまるもの。階が null の部屋（体育館など）は1階として扱う。extra(r) は rooms.extra_cost。

| 順 | 条件 | d |
| --- | --- | --- |
| 1 | g の使用場所 L がない（校内分散） | 4 ＋ extra(r) |
| 2 | r ＝ L（残す） | 0（extra は足さない。足すと CI5 を使う団体が自室の在庫より他所を選びうる） |
| 3 | L が屋外（kind ＝ outdoor） | r が屋外か、r の階が1以下なら 3、2以上なら 5。＋ extra(r) |
| 4 | r が屋外で、L が屋外でない | L の階が1以下なら 3、2以上なら 5。＋ extra(r)（3 と対称） |
| 5 | r と L の building が同じ（どちらも null でない） | 階が同じなら 1、違えば 2。＋ extra(r) |
| 6 | それ以外（別の建物。building が null のものを含む） | distance_overrides に {r.building, L.building} の組（向きは問わない。どちらも null でないときだけ）があればその cost、なければ 4。＋ extra(r) |

- 上書きは 6 の「別の建物」の 4 だけを置き換える。同じ建物（5）と屋外（3・4）には効かない。DB は building_a < building_b で保存する（DB 設計）が、allocator は向きを問わずに引く。
- 体育館は kind ＝ gym、building ＝「体育館」の1部屋として登録する（03 のとおり）。building が null の gym は 6 で 4 になる（マスタの登録で building を入れる。T09 の入力チェック）。
- 表の値は 03 の段階値のまま。R8 で結果を見て調整する（00 の未決事項）。
- 上書きがなければ、この d は三角不等式 d(r,h) ≤ d(r,L) ＋ d(L,h) を満たす（logic-lab で、種類4・建物3〔null を含む〕・階5〔null を含む〕・extra 2通りの 92 部屋の全組 778,596 通りを確かめた）。W107 の議論（12.4）で使う。
- テスト（distance.test.ts）：6 行それぞれと、上書きの両方向、上書きが 5・3 に効かないこと、extra の有無、floor null、kind other を表で確かめる。

### 6.2 係数（整数）

各変数の1台あたりのコスト：

```
x(r,g,i,j)：  W·c_sub(g,i,j) ＋ A·d(r,g) ＋ e(r,g) − B·p(g,i,j)
x̂(r,g,i,j)：  上と同じ − μ
```

| 記号 | 意味 |
| --- | --- |
| c_sub | 代替の重さ。j ＝ i なら 0、それ以外は代替ルールの cost（整数 0〜10。S01・S02 は 0、S04 は 1、S07 は 3） |
| d | 6.1 の距離（整数） |
| e | 運び元が使用場所でなければ 1、使用場所なら 0（P-02 の「+1」。同じ距離なら残す方を選ぶ） |
| p | j が preferCategory つきの代替で、g の区分が preferCategory なら 1（S02 の休憩所への不可椅子）、それ以外 0 |
| K | LP の需要の行の数（D′ > 0 で変数がある gi） |
| P | そのうち、p ＝ 1 の変数を持つ行の数 |
| d_max | 変数の d の最大（1 未満なら 1） |
| B | K ＋ 1 |
| A | B·P ＋ K ＋ 1 |
| U | A·d_max ＋ B ＋ 1 |
| μ | minimal_change なら K·U ＋ 1、full なら 0（x̂ もない） |
| W | K·(U ＋ μ) ＋ 1 |

- 係数はすべて整数で、LP には整数だけを書く（`4.9` のような小数の表記ゆれがない）。
- 規模の確認：最大の係数 × N（需要の合計）が 2⁵³ を超えたら solver_error（R8 規模は 3.3×10⁸ × 1,295 ≒ 4×10¹¹ で、十分に小さい）。

### 6.3 優先順位が必ず守られる理由

求めるのは辞書式の最小：①代替の重さの合計 Σc_sub·x → ②（最小変更のとき）前回と同じ台数 Σx̂ の最大 → ③距離 Σd·x → ④休憩所への不可椅子 Σp·x の最大 → ⑤運び出す台数 Σe·x。

- 2つの実行可能解の差は、二部グラフ上の「単純な閉路」と「在庫の点から在庫の点への単純な道」に、向きをそろえて分解できる（輸送問題の流れの分解）。LP の最適解より辞書式で良い解があれば、その差の成分のうち少なくとも1つが辞書式で負になり、その成分の方向に少し動かすと（実行可能なまま）重みつきのコストも下がる…と言えるためには、「どの閉路・道についても、重みつきのコストの符号が辞書式の最初の0でない成分の符号と同じ」であればよい。
- 閉路・道は需要の点（gi）を高々 K 個通り、各点で「増える辺」と「減る辺」を1本ずつ持つ。1点あたりの変化は、e が −1〜1、p が −1〜1（p ＝ 1 の辺を持つ点は高々 P 個）、d が −d_max〜d_max、x̂ の使用が −1〜1 である。よって閉路全体で |Δe| ≤ K、|B·Δp ＋ Δe| ≤ B·P ＋ K、|A·Δd ＋ B·Δp ＋ Δe| ≤ K·U、|μ·Δx̂ ＋ …| ≤ K·(U ＋ μ)。
- B ＞ K、A ＞ B·P ＋ K、μ ＞ K·U、W ＞ K·(U ＋ μ) なので、上の段の差が1でもあれば、下の段の合計では覆せない。c_sub・d・e・p・x̂ の差はどれも整数なので、上の段の差は0か1以上である。
- P-02 の固定の倍率（100·d ＋ 1、休憩所 −10）では、休憩所の需要の行が10以上、または1つの閉路が100を超える需要の点を通ると、距離の段が崩れる（K-12 の (2)）。この設計は倍率を K・P から決めるので、休憩所の数や閉路の長さに依らない。T00 の W（10·d_max·N）は需要の合計 N で抑えていたが、閉路の点の数 K で抑えれば足り、R8 では N ＝ 1,295 に対し K ＝ 170 なので係数は小さくなる。
- 最小変更の μ を辞書式にした理由：μ ＝ d_max ＋ 1（1台ぶん）だと、前回の1台を手放す代わりに、ほかの何台かの距離を縮める解が選ばれうる（長い連鎖）。小さな入力の総当たりで実際に3例出た（11 章）。代わりに、前回の割り当てが遠くても保つ（それが最小変更の目的である）。
- 辞書式の μ で保証されること（D-08）：部屋 M を使用不可にしたとき、「前回の M 以外の行をすべて保ち、M から受け取っていた（団体・申請品目）の失った分を、その団体が使える（rules.ts の canUse を満たす）場所の余りから補い、代替の重さの合計が前回と同じ」解が1つでもあれば、①の最小値は前回と同じになる（在庫が減ったので前回より小さくはならない）。すると②で Σx̂ が最大の解、つまり前回の M 以外の行の数をすべて保つ（どの行も減らさない）解が選ばれる。x̂ の上限は前回の数なので、保つのは「前回の数以上」であって「前回と同じ数」ではない：M から受け取っていた (g, i) の失った分を、g がすでに受け取っている別の部屋 R から補うと、同じキーの x が足されて前回の行 (R, g, i, j) の数が増える（logic-lab の tcheck/inc2.ts：シード 100〜129 × MER・HI1・CI2 の補えるつながり 180 のうち 9 つで、前回の M 以外の行が1行ずつ増えた。どれも M から受け取っていた (g, i) の行）。一方、M と無関係な行（運び元が M でなく、M から受け取っていた（団体・申請品目）でもない行）は変わらない：そういう (g, i) は前回の行がすべて M 以外なので、どの行も減らず、行の合計は需要 D′(g, i) ＝ 前回の合計のままなので、どの行も増えず、新しいキーもできない。
- この条件は、品目全体の余り（M 以外の在庫 − 前回の使用）では判定できない。運び元の制限（S05）・代替の区分・indoorOnly・了承の拒否で、M から受け取っていた団体の使える場所が限られると、全体に余りがあっても、①を増やさずに補うには無関係な団体を押し出すしかないことがある。①が②より先なので、代替を増やすより押し出す解が選ばれる（どちらも正しい最適解である）。反例（logic-lab/review/cex-s05.ts）：部屋 M（A棟2階、机1）・R2（A棟1階、机2）・R3（C棟、机5）。設営 S（A棟2階）は S05 により運び元が {M, R2} だけ、団体 A（A棟1階）は机1。full の解は M→S 1、R2→S 1、R2→A 1。M を使用不可にした最小変更の解は R2→S 2、R3→A 1 で、M と無関係な行 R2→A が 1 から 0 に変わる。机の余りは全体で 5 ある。
- LP は「候補のつながり」（需要の行 gi と在庫の行 rj を変数で結んだ二部グラフの連結成分）ごとに独立に解けるので、上の条件はつながりごとに判定でき、条件を満たすつながりでは前回の M 以外の行が減らず、増えるのは M から受け取っていた (g, i) の行だけで、無関係な行は同じキーで同じ数のままである。R8 では、つながりはおおむね品目の系列（机(木)・不可机・キャスター机、椅子(木)・不可椅子、椅子(青)、長机、教卓）になる。12.3 はこの判定でテストする。
- 総当たりで確かめた（11 章）：小さな入力 533 通りで、LP の解の辞書式の値が、全整数解の辞書式の最小と一致した。

### 6.4 完全単模性と整数の解

- 制約は「在庫の行（rj）× 需要の行（gi）」の二部グラフの接続行列で、コストは制約行列に関係しないので、係数の変更（6.2）は完全単模性に影響しない。x̂ は x と同じ列の複製で、複製した列を足しても完全単模のまま。上限（x̂ ≤ 前回の数）・右辺（S′・D′）はすべて整数なので、すべての頂点が整数になる。
- HiGHS の単体法（presolve を含む）は基底解（頂点）を返す。念のため各値を四捨五入し、差が 1e-6 を超えたら solver_error にする（T00・logic-lab で実測のずれは常に0）。
- 時間で打ち切った解・0/1 変数は使わない（`Status === 'Optimal'` 以外はすべてエラー）。

### 6.5 R8 規模の値（T00 のダミー、シード 20261029）

| | full | minimal_change（MER を使用不可） |
| --- | --- | --- |
| K・P・d_max | 170・2・7 | 同じ程度 |
| A・B・U | 513・171・3,763 | 同じ |
| μ | 0 | 639,711 |
| W | 639,711 | 109,390,581 |
| 最大の係数 | 1,922,212 | 328,174,822 |
| 目的関数値 | 188,492,679 | — |

03 の「R8 なら W ≒ 65,000」は、この表の値に差し替える（spec-changes-logic.md）。

## 7. 変数を作る規則

需要の行 gi（D′ > 0）ごとに、次の順で候補を作る。

1. **品目の候補 J(g,i)**：j ＝ i（c_sub ＝ 0、p ＝ 0）と、次をすべて満たす代替ルール s の j ＝ s.to。
   - s.from が i のコード、g.category が s.categories に入っている。
   - s.indoorOnly なら L(g) があり、その kind が room（体育館・その他・屋外・使用場所なしは対象外）。
   - s.needsConsent なら、了承 (g, i, s.to) の status が declined でない（not_asked・asked・accepted は作る。accepted の行は set_consent が pinned にするので固定行として入る）。
   - c_sub ＝ s.cost、p ＝（s.preferCategory ＝ g.category なら 1）。
   - 同じ j に当てはまるルールが2つ以上あれば、cost が小さいもの、同じなら code が先のものを使う（2.3 で区分が重なるものは止めているので、通常は起きない）。
   - 並びは j の品目の並び順（ルールの code に依らない）。
2. **運び元の候補**：r を部屋の並び順に見て、S′(r,j) > 0 のものだけ。使用不可の部屋は S′ ＝ 0 なので入らない。
3. **運び元の制限**：source_restrict のうち、params.group ＝ g かつ i のコードが params.items に入っているものがあれば、r はその rooms に入っているものだけ（複数あれば共通部分）。制限は申請品目 i で判定し、代替先の j にも同じ制限がかかる（T00 と同じ。R8 の S05 は設営が部門なので代替がなく、どちらでも同じ。要確認：openQuestions）。
4. **x**：上を満たす (r, j) ごとに x(r,g,i,j) を1つ作る。
5. **x̂**（minimal_change）：x を作ったキー rgij に hatBound があれば、その直後に x̂(r,g,i,j)（上限＝hatBound）を作る。x を作らなかったキー（了承を拒否した団体への置き換え、制限で外れた運び元、使用不可の部屋、在庫が0の部屋、需要が0になった行）には作らない（K-14）。それらの前回の行は変わった行になる。
6. 在庫の行 rj は、変数が1つ以上あるものだけを書く。

- 変数名は作った順の連番（x1、x2、…。x̂ も同じ通し番号）。対応表は配列の添字。
- このルールの判定（`substituteOptions(ctx, g, i)`、`allowedSources(ctx, g, i)`、`canUse(ctx, g, i, j, r)`）は rules.ts に置き、validate の E004（ルール違反）と W107 の入れ替えの判定でも同じ関数を使う。

## 8. 決定性

- 並べ替え：items・rooms・groups は sortOrder → name → id。文字列の比較は UTF-16 のコード単位（`a < b`）で、`localeCompare` は使わない（Node とブラウザで ICU が違う）。ルールは code → id。
- stocks・requests・consents・fixedRows・previousRows は、入力の順ではなく、並べた部屋・団体・品目の順に索引から引いて使う。keep の params.items もオブジェクトのキーの順ではなく品目の並び順で見る。
- 変数の順：団体 → 申請品目 → 品目の候補（j ＝ i、次に品目の並び順）→ 部屋。x̂ は対応する x の直後。在庫の行は部屋 → 品目、需要の行は団体 → 品目の順に書く。
- LP の文字列には整数だけを書き、折り返さない（T00：5.9 万字の行も読める）。
- HIGHS_OPTIONS ＝ `{ solver: 'simplex', random_seed: 0, time_limit: 30, output_flag: false }`（presolve は既定）。highs は 1.15.4 を exact で固定。`loadHighs` に渡すオブジェクトは呼ぶたびに新しく作る。
- Date・Math.random・ロケールを使わない。elapsedMs と stats の時間は比べない。
- テスト：配列（items・rooms・groups・stocks・requests・rules・consents・fixedRows・previousRows・distanceOverrides）と keep の params.items のキーの順を、シード固定で20通り並べ替えて、LP の文字列と rows が完全に一致すること。同じ入力で2回解いて rows が一致すること。
- 並べ替える入力は、どの配列も2要素以上で空でないものにする（fixtures を full で解くだけでは fixedRows・previousRows が空で、R8 の consents も見出しだけなので、これらの順に依る誤りが見つからない）。r8like に次を足した入力を、testing の builder で作る：fixedRows（manual と pinned を混ぜ、keep の行を pinned にした行を含めて5行以上）、previousRows（MER を使用可にした full の rows。mode は minimal_change で MER を使用不可）、consents（declined を1件以上含めて3件以上）、distanceOverrides（2件以上。結果に効く組を含める）。
- 並べ替えが実際に順を変えたことも確かめる：各配列について、20通りのうち少なくとも1通りで、並べ替えた後の id の列が元と違うことを assert する（並べ替えの仕掛けが壊れて何も変えていないのに通るのを防ぐ）。

## 9. 解けないときの返し方（T06 と T07 の境目）

| 場面 | reason | 返すもの | 担当 |
| --- | --- | --- | --- |
| 入力の形・参照が不正（zod、知らない id、ルールの参照先がない） | invalid_input | inputErrors（path、message、ruleCode） | T06 |
| 前処理で止める（E001 固定行・keep が在庫を超える、E002 keep のルールの部屋が使用不可、E005 keep のルールの部屋が使用場所でない） | precheck | issues（refs に rowIds・ruleCode） | T06 |
| 候補が足りない需要（P7） | infeasible | shortages（groupId つき）＋ diagnose の結果 | T06（P7）、T07（diagnose） |
| HiGHS が Infeasible・Primal infeasible or unbounded | infeasible | diagnose の結果（shortages・causes） | T06（呼び出しの形）、T07（中身） |
| HiGHS がそれ以外（Time limit reached、Unbounded、Unknown など）、整数でない値、自己検算の不一致、例外 | solver_error | message（状態の文字列を含む） | T06 |

止めないもの（validate が error として示す）：申請できない品目の申請（E006。需要から除いて解く。5 章 P1）、固定行の運び元が使用不可（E002）・is_keep の不整合（E005）・ルール違反（E004）。

- T06 の diagnose は「受け取った shortages をそのまま返し、causes は空」でよい（形と呼び出しを先に決める）。そのとき message は「解けません（不足の内訳は未実装）」とする。
- T07 の diagnose（03「解けないときの扱い」）。入力は AllocateInput と、P7 で見つけた団体つきの shortages（found。LP が Infeasible のときは []）：
  1. 申請品目ごとに、需要の合計 ΣD′ と、その品目の候補になる品目 j の在庫 ΣS′ を比べた品目全体の不足（groupId ＝ null）を作る。
  2. 手順1の結果にかかわらず（品目全体の不足があっても、found〔P7 の団体つきの不足〕があっても）、設定ルールを1つずつ外して `buildModel(input, { disabledRuleCodes: [code] })` で解き直す。対象は source_restrict、keep、fixed_request（K-26）を code 順に。buildModel は外したルールで P1〜P7 をやり直す。「外すと解ける」とは、外した入力で precheck の issues が出ず、P7 の shortages も出ず、HiGHS が Optimal を返すこと。解けたルールを causes に入れ、details に元の入力でそのルールが関わる不足を書く（source_restrict なら、対象の団体・申請品目の需要 D′ と、指定した場所の S′ の合計。例：設営・机(木)・1-1〜2-3、需要 241、在庫合計 235。fixed_request なら固定の数と在庫、keep なら残す数）。品目全体の不足があっても試すのは、fixed_request（未提出の団体の固定の数）と keep（申請より多く残す分）は品目全体の需要と在庫を変えるので、外すと品目全体の不足が消えることがあるため（K-26 の「設営の241台が原因」）。今の 03 の「shortages が空のときだけ」から変える。R8 の対象のルールは3つ（S05・S06・S08）なので、解き直しは3回。
  3. どれを1つ外しても解けず、手順1の品目全体の不足も空なら、source_restrict の対象ごとに需要とその場所の在庫の合計を details に並べ、「複数の条件の組み合わせ」とする（ruleCode ＝ null）。品目全体の不足があってどのルールでも解けないときは、在庫そのものが足りないので causes は空のまま（shortages の「机(木)が12台足りません」で示す）。
  4. 返す shortages は、手順1の品目全体の不足と found を合わせたもの（品目全体 → 団体つきの順。画面は両方を出す）。
  5. 最小変更モードの入力でも、診断は full として行う（x̂ は上限つきの複製なので、解けるかどうかに関係しない）。
- 例：S05 が原因の典型の入力（T00 の makeInfeasibleS05：S05 の6部屋の机を合わせて 235 台、設営の需要 241）は P7 で止まり、found ＝［設営・机(木)・需要 241・供給 235］。机は品目全体では足りるので手順1は空、手順2で S05 を外すと解ける（logic-lab で、S05 だけが解ける・S06・S08 を外しても P7 で止まることを確かめた）。返り値は reason ＝ infeasible、shortages に設営・机(木)（supply 235）、causes に ruleCode ＝ S05。
- 解き直しは同じ solver で続けて呼ぶ（1回 40 ms 前後。メモリは増えない。T00）。R8 規模で 2 秒以内（T07 の完了基準）。

## 10. 結果の行

- x と x̂ の値を四捨五入して、rgij ごとに足す。0 の行は出さない。
- P2 の keep の行を同じキーに足す（keep の行と LP の自室の行が同じキーになることがある。DB の save_auto_allocations は同じキーの行を2つ受け付けないので、必ず1行にする）。
- isKeep ＝（運び元 ＝ 団体の使用場所）。keep ルールの行に限らない（03 のとおり。DB も同じ規則で決め直す）。
- requestedItemId は前処理1の読み替えの後の品目（企業以外が長机(3人掛)を申請していれば長机(2人掛)）。
- rows に固定行は含めない。保存（save_auto_allocations）は auto かつ未固定の行だけを入れ替える。画面で検証するときは `validate(input, [...input.fixedRows, ...result.rows])` と、固定行と足して渡す。
- 並びは 品目 j → 運び元 → 団体 → 申請品目（Excel のシートと同じ向き）。
- origin・pinned は持たない（保存で auto・pinned ＝ false になる）。

## 11. 実験の結果（logic-lab）

T00 のダミー（gen.ts）に、この設計の前処理・距離・変数・係数・W107 を実装して解いた（logic-lab の src/model2.ts、run*.ts、brute*.ts。リポジトリでは spikes/logic-lab/。12.5）。Node 22、highs 1.15.4。

| 項目 | 結果 |
| --- | --- |
| R8 規模（シード 20261029、full） | Optimal。変数 5,630、整数からのずれ 0。同じ入力で5回とも同じ rows。配列を並べ替えた5通りで LP の文字列が完全に一致 |
| T00 の整数化（100·d ＋ 1、−10）との比較（シード 100〜129） | 代替の重さの合計：30/30 一致。距離の合計：30/30 一致。違いは不可椅子（代替の重さ 0）の使い方だけ（1通りで2脚） |
| 置き換え・品目の合計 | キャスター机への置き換え 97、不可机 41、椅子(青) 134、教卓 10、長机 106（T00 と同じ）。独立の検算（E001〜E005 相当）は0件 |
| 解く時間（Node、30通り） | 中央値 42.7 ms、最大 49 ms（最初の1回だけ JIT で約 120 ms）。T00 と同じ |
| W107 | T00 の定義：30通りで16件（すべて設営。体育館の机が他の団体へ出て、設営は S05 の部屋から受け取る形）。入れ替えがルール上できるものに絞る定義：0件 |
| 最小変更（30通り × MER・HI1・CI2 を使用不可。うち18通りは使用不可にすると解けない） | 解けた72通りで、余りのある申請品目（机系以外）の無関係な行の変化は0件（辞書式の μ）。変わった行は机系の連鎖（置き換えが増える分）だけ。最大の係数 3.3×10⁸、整数からのずれ 0、時間は full と同じ |
| 距離の三角不等式（上書きなし） | 92 部屋の全組 778,596 通りで違反 0 |
| 総当たり（部屋2〜4・団体2〜3・品目5の小さな入力。全整数解を列挙） | 辞書式の μ：533 通りで不一致 0。1台ぶんの μ（今の 03）：3 通りで、前回の1台を手放して距離を縮める解になった |
| 改訂で足した確認（logic-lab/rev3・review・crit） | 下の4行 |
| D-08 の判定（12.3 の改訂版。つながりごとに前回の M 以外の行を固定して full で解き、代替の重さの合計が前回と同じなら「補える」） | シード 100〜129 × MER・HI1・CI2 と 20261029 × MER の 91 通りのうち解けた 73 通り：M の行を含むつながり 264（補える 183、補えない 81）。補えるつながりで、前回の M 以外の行が減ったもの 0 件、無関係な行が変わったもの（新しいキーを含む）0 件。前回の M 以外の行が増えたものは 9 件（シード 100〜129 の補えるつながり 180 のうち 9 つで1行ずつ。どれも M から受け取っていた (g, i) の行。20261029 × MER では 0 件。tcheck/inc2.ts。rev3/d08oracle.ts は減ったものしか数えていなかったので、改訂2で増えたものを数え直した）。M の行を含まないつながりの変化 0 件。補えるつながりが1つもない入力 3 通り。批評の反例（cex-s05）は「補えない」に分かれる。補える判定では、P7（候補のない需要）を不可能として扱うことが要る（model2 は候補のない需要を黙って落とすので、最初の試行では誤って「補える」と判定し、違反 681 件と出た） |
| S05 が原因の入力（T00 の makeInfeasibleS05） | ルールを外さないと P7 で止まる（設営・机、D′ 241、候補の S′ 235）。S05 を外すと Optimal、S06・S08 を外しても P7 で止まる |
| 段ごとの辞書式の検算（批評の lex.ts・lexseq.ts） | 合成データ 10 シードの full と、MER・HI1・CI2 を使用不可にした minimal_change の計 36 通り、別に 10 通りで、5 段の値が重みつきで1回解いた解と一致 |
| LpSolver の型（crit/types-check.ts） | Columns を `Record<string, { Primal?: number }>` にすると `const s: LpSolver = await loadHighs()` が TS2322。`Record<string, unknown>` で通る |

## 12. T06 のテスト計画

### 12.1 単体（builder で作る小さな入力）

| ファイル | 確かめること |
| --- | --- |
| distance.test.ts | 6.1 の表の各行、上書きの両方向、上書きが同じ建物・屋外に効かないこと、extra、floor null |
| weights.test.ts | B ＞ K、A ＞ B·P ＋ K、μ ＞ K·U、W ＞ K·(U ＋ μ)。係数が整数。規模の上限で solver_error。**総当たり**：シード固定の小さな入力を作り、全整数解を列挙した辞書式の最小と LP の解の辞書式の値が一致すること（spikes/logic-lab/brute-lex-1200.ts の生成器と列挙を移す。入力の作り方と期待値は 12.5 の表。CI では、列挙できた入力が 200 通りになるまでのシードに絞ってよい）。**段ごとの検算**（R8 規模。係数が大きいときの HiGHS の許容誤差の確認）：testing/solveLexStages が、同じ候補で目的を1段ずつにした LP を順に解き（①Σc_sub の最小 → ②Σx̂ の最大 → ③Σd の最小 → ④Σp の最大 → ⑤Σe の最小）、前の段の値を等式の制約に入れて次の段を解く。得た5段の値が、allocate の rows から計算した5段の値と一致すること。対象は r8like の full、r8like で MER を使用不可にした minimal_change、fixtures/r8 の full と第一セミナーの minimal_change（12.3 の手順1・2）。1回あたり数百 ms。highs を上げるときの回帰テストにもなる |
| prepare.test.ts | D-05（企業以外の長机(3人掛)が長机(2人掛)に、企業はそのまま、不可机の申請は需要から除かれ excluded に入り、allocate は止まらない）、D-07（未提出は固定数、提出済みの0は0、未提出で申請の行があっても固定数）、D-06（keep の行が作られる、手で固定した keep と重なると超える分だけ、keep が申請より多くても作る）、固定行の差し引き、固定行・前回の行の requestedItemId の読み替え（企業以外の長机(3人掛)の手動の行が D′(g, 長机(2人掛)) から引かれ、二重にならない）、E001（rowIds つき。使用不可の部屋でも在庫超過なら E001）、keep のルールの E002・E005（ruleCode つき）、固定行の運び元が使用不可でも止まらないこと、使用不可の部屋の在庫が使われないこと、disabledRuleCodes |
| rules.test.ts（shared） | checkRuleRefs：参照先がない、fixed_request・keep の品目が団体の区分で申請できない（企業以外の長机(3人掛)を含む）、keep の room が使用場所でない（code: 'E005'）、fixed_request の重なり・substitute の区分の重なり・code の重なり（ctx.rules と比べる）、id のない RuleDraft を受け取れる。zod：ruleCode は 50 字まで、count は 10000 まで、extraCost・distanceOverrides.cost は 0〜20 の整数（負・小数・21 は失敗） |
| candidates.test.ts | categories、indoorOnly（屋外・体育館・使用場所なしは対象外）、needsConsent（declined だけ外す）、preferCategory の p、同じ j に当てはまる代替が2つのとき cost が小さいもの・同じなら code が先、source_restrict の共通部分と代替先への適用、x̂ は x があるキーだけ・上限は前回 − keep、P7 の shortages（候補なし、候補の在庫の合計が足りない） |
| lp.test.ts | 小さな入力の LP の文字列のスナップショット、変数名の形（`^x[1-9][0-9]*$`）、並べ替えた入力で同じ文字列（8 章）、同名・同 sortOrder で id だけ違う団体の並び |
| solve.test.ts | 偽の LpSolver で：'Time limit reached'・'Unbounded'・'Unknown' → solver_error、'Infeasible'・'Primal infeasible or unbounded' → infeasible、0.5 が返る → solver_error、Columns に変数がない・Primal が数でない・NaN → solver_error、例外 → solver_error。型：`const s: LpSolver = await loadHighs()` が通ること（Columns は `Record<string, unknown>`。2.4） |
| rows.test.ts | x と x̂ の合算、keep の行との合算、isKeep、並び、0 の行が出ないこと |
| w107.test.ts | K-12 の最小例（同点。並び順12通りすべてで W107 ＝ 0）、同じ部屋を使う別の団体へ渡すのは数えない、S05 で入れ替えられないものは数えない（設営側・S05 の部屋を使う団体側の両方）、入れ替えると距離の合計が増えるもの（批評の例：上書き X–Y ＝ 1・Y–Z ＝ 1、X–Z は既定の 4）は数えない、同じ形で上書きがなければ数える |
| testing/checkInvariants.test.ts | 独立の検算そのもののテスト：入力は「固定行＋rows（keep の行を含む）」で、keep の行を足し直さない（T00 の analyze.ts の check は `[...rows, ...m.keepRows]` で keep を二重に数え、E003・W101 を誤って出していた。logic-lab の run.ts の「check issues new 3」）。keep の行を含む rows で E003・W101 が0になること、keep の行を抜くと E003 が出ること |

### 12.2 不変条件（05 のうち T06 の分）

`describe.each` で同じテストを次のデータに流す。

- 合成データ：fixtures/synthetic/r8like（ファイル）と、シード 100〜129（その場で生成。不変条件のうち数の一致を求めないものだけ）。
- 本物：fixtures/r8。

fixtures/r8 がないときの扱い（R8 の元データはまだ届いていないので、T06 が T05 の fixtures より先に入りうる）：

- パスは `repoRoot()`（3.1）から解決する。パッケージのディレクトリから相対で探さない。
- fixtures/r8/meta.json がないときは、R8 の describe を飛ばし、代わりに `it.todo('fixtures/r8 がないため、R8 の不変条件を実行していない')` を必ず出す（Vitest の出力に todo として残る）。
- CI の変数 `REQUIRE_R8_FIXTURES=1` があるときは、fixtures/r8 がなければ失敗にする。fixtures/r8 を足す PR（T05）で ci.yml に入れる。それ以後は、パスの誤りなどで静かに飛ばされることがない。
- fixtures/r8 がないまま T06 を終えるときは、notes/T06.md と PR に「R8 では未確認（合成データでだけ確認）」と書き、fixtures/r8 が入った PR で同じテストが通ることを確かめる。T12 の完了基準（rules.json との一致）も、それまでは fixtures/synthetic/r8like/rules.json で代える。

不変条件の期待値は、allocate と同じ関数（buildDemand など）から作らない。同じ関数から作ると、その関数が申請を落としたり D-05・D-07 を間違えたりしても通ってしまうため。

- 需要の期待値：テストの中で requests.csv を名前のまま読み、団体・品目ごとに足す。読み替え（企業以外の long_desk_3 → long_desk_2）と、未提出の団体の fixed_request（rules.json の S06：groups.csv の submitted_at が空なら params.count で置き換える）を、テストのコードに明示的に書く（shared の関数を呼ばない）。
- 在庫・ルールの期待値も、stocks.csv・rules.json から直接読む。
- 結果の検算（testing/checkInvariants）の入力は「固定行＋rows」で、rows は keep の行を含む。keep の行を足し直さない（12.1）。

| 05 の不変条件 | 確かめ方 |
| --- | --- |
| 解ける。E001〜E006 が0件 | ok: true。T06 の時点では testing/checkInvariants（LP と独立に書いた検算。T00 の analyze.ts の check を移し、keep の二重の加算を直したもの）で E001〜E006 相当を数える。T07 の後は validate でも数え、両方が0 |
| 団体・申請品目ごとに、振り分け合計が正規化した申請と等しい | 上の「需要の期待値」と、固定行＋rows の (g, requestedItemId) の合計が全キーで等しい（片方にしかないキーも0と比べる） |
| 設営の机(木)241台がすべて 1-1〜2-3 から（S05） | 設営・申請品目 desk の行の運び元が S05 の rooms に入っていて、合計 241 |
| 不可机は模擬店、不可椅子は休憩所と模擬店だけ（S01・S02） | itemId が desk_ng・chair_ng の行の団体の区分 |
| 長机(3人掛)は企業だけ（S03） | itemId が long_desk_3 の行の団体の区分 |
| キャスター机への置き換えが103台以下 | requested desk → caster_desk の合計。合成データは 97 と一致まで確かめる（回帰）。97 は合計から決まる構造の値（644 − 506 − 41。3.6）なので、合成データの作り方を変えても、合計を変えない限り 97 のまま |
| 椅子(青)134・教卓10・長机106 | itemId ごとの合計（固定行＋rows） |
| 学科展示の机12・椅子4が第一多目的室の残す（S08） | 該当キーの行が isKeep で、数が 12・4 以上（団体・部屋・品目は rules.json の S08 の params から引く） |
| W107 が0件 | findW107（入れ替えがルール上でき、入れ替えても距離が増えないものだけを数える定義。要確認）が0。あわせて T00 の定義の件数を記録する（S05 によるものだけであること） |
| 同じ入力で同じ結果。並べ替えても同じ | 8 章のテスト（空でない fixedRows・previousRows・consents・distanceOverrides を持つ入力で） |
| 固定行・手動行が二重にならない | rows から5行おきに選んだ行を fixedRows（manual と pinned を半分ずつ）にして解き直す。固定行＋新しい rows の (g,i) の合計が需要の期待値と等しく、(r,j) の合計が在庫以下。keep の行を pinned にした場合：S08 の (部屋, 団体, 品目) のキーの、固定行＋新しい rows の合計が、pinned にする前の rows の同じキーの数と等しい（合成データ・シード 20261029 では、学科展示は机を18台申請していて、第一多目的室の机が20台あるので、keep の 12 と LP の自室からの 6 が1行にまとまり 18 になる。logic-lab/crit/keep.ts。18 と 20 は生成器の固定値で、乱数に依らない。3.6・12.5）。keep の数を二重に足した数（合成データでは 30）にならない。期待値に 12 を書かない |
| 最小変更モードで無関係な行が変わらない（D-08） | 12.3 |
| 了承を拒否した団体に置き換えがない | 屋内の模擬店のうち置き換えがあった団体を declined にして minimal_change で解き直し、その団体の desk → caster_desk の行がない |
| 申請を在庫より多くすると ok: false で shortages | T06：P7 の形（候補の在庫が足りない団体。reason ＝ infeasible、shortages に groupId つき）と、LP が Infeasible のとき reason ＝ infeasible になるところまで。T07：品目全体の不足（机の申請を増やした入力で、shortages に groupId ＝ null の机(木)と不足数）と、S05 が原因の入力（r8like の S05 の部屋の机を合わせて 235 台にし、設営の需要は 241 のまま。T00 の makeInfeasibleS05 と同じ作り方）で、reason ＝ infeasible、shortages に設営・机(木)（demand 241、supply 235）、causes の ruleCode に S05 が入り、details が設営・机(木)・S05 の部屋・241・235 であること。どのルールを外しても解けない入力で「複数の条件の組み合わせ」（ruleCode ＝ null） |
| 計算時間 | Node で R8 入力の allocate（検証・前処理を含む）が 2 秒未満（CI の機械差を見込んだ上限）。時間は stats を notes/T06.md に書く。ブラウザの2秒は T13・T14 の Playwright で測る |

### 12.3 最小変更モードの確かめ方（D-08）

手順（R8 では第一セミナーが最初から使用不可なので、05 のとおり逆にたどる）：

1. 部屋 M（R8 は第一セミナー、合成データは MER）を使用可にして full で解き、rows を previousRows にする（keep の行を含めて渡す。D-06 で auto として保存されるため）。
2. M を使用不可にして minimal_change で解く。r8like＋MER と、R8＋第一セミナー（R8 は実際に振り分けられた）は、ok: true でなければテストを失敗にする（「解けなければ reason だけを確かめる」という分岐は置かない。実装の誤りで infeasible を返しても通ってしまうため）。r8like＋MER が解けることは、3.6 の移し方（乱数の捨て読み）で 11 章の実験と同じデータになることに依る。移した直後に 3.6 の「移した後の確認」をし、満たさなかったときに 3.6 のとおり M を選び直した場合は、MER をその部屋に読み替える。実装の誤りとデータの違いを分けるには、logic-lab の model2（spikes/logic-lab）に同じ r8like を入れて解き、full と minimal_change の ok・rows（名前の形）が allocate と一致するかを比べる（一致して解けなければデータの違い、一致しなければ実装の誤り）。
3. 「変わった行」＝（運び元・団体・申請品目・品目）ごとの数が前後で違うキー（D-08）。「無関係な行」＝運び元が M でなく、M から受け取っていた (g, i) でもないキー。
4. 「候補のつながり」を作る：手順2の buildModel の変数で、需要の行 gi と在庫の行 rj を結んだ二部グラフの連結成分（union-find。6.3）。M から運んでいた前回の行の (g, i) を含むつながりを、調べる対象にする。
5. つながり C ごとに「補える」かを判定する：M を使用不可にした入力に、前回の M 以外の行のうち (g, i) が C に入るものを固定行（pinned）として足し、full で allocate する。ok: true で、かつ C の代替の重さの合計（固定行＋新しい rows。c_sub は rules.ts で求める）が、前回の rows の C の代替の重さの合計と等しければ「補える」。ok: false（P7 の候補のない需要を含む）や、代替の重さが増えたものは「補えない」。品目全体の余りでは判定しない（運び元の制限などで成り立たないことがある。6.3 の反例）。
6. 補えるつながりでは、次の2つを assert する（6.3 により保証される）。
   - (a) 前回の M 以外の行が減らない：前回の rows のうち運び元が M でないキーごとに、after ≥ before。
   - (b) 増えてよいのは、M から受け取っていた (g, i) の行だけ：(g, i) が M から受け取っていたものでないキー（無関係な行）は、前後で同じキーがあって同じ数（前回にないキーが現れることも、なくなることもない）。M から受け取っていた (g, i) の M 以外のキーは、増える・新しく現れるのを許す（(a) により減らない）。
   - 「前回の M 以外の行がすべて同じ数」は assert しない。正しい実装でも成り立たない（6.3。logic-lab ではシード 100〜129 の補えるつながり 180 のうち 9 つで、M から受け取っていた (g, i) の前回の行が増えた）。増えた行の数は記録する。
   補えないつながりの変わった行の数は記録する（テストの出力と notes/T06.md。上限はかけない）。M の行を含まないつながりでは、変わった行が0であることを assert する。
7. テストが何も確かめずに通らないように、r8like＋MER と R8＋第一セミナーでは「前回 M から運んだ行が1行以上ある」「補えるつながりが1つ以上ある」を assert する（logic-lab では r8like＋MER のつながり4つのうち3つが補える。机の系列は置き換えが増えるので補えない。3.6 の移し方でも同じ。R8＋第一セミナーで補えるつながりがないときは、テストを落とし、notes/T06.md に理由を書いてユーザーに確認する）。
8. 解けなくなる入力は別のテストにする：シード 100〜129 と部屋 MER・HI1・CI2 の 90 通りで、M を使用不可にした入力を full で解いた結果と minimal_change の結果について、「full が ok: true ⇔ minimal_change が ok: true」を assert する（x̂ は上限つきの複製なので、解けるかどうかを変えない）。full でも解けない組では minimal_change が reason ＝ infeasible であること、そういう組が1つ以上あることも assert する（logic-lab では 90 通りのうち 18 通り）。解ける組では手順4〜6を流す（logic-lab では解けた 73 通りで違反 0）。
9. 反例の入力（6.3。S05 で運び元が限られた団体。入力と期待値は 12.5 の表）を builder で作り、そのつながりが「補えない」に分かれること、M と無関係な行 R2→A が変わることを確かめる（判定が甘くなっていないことの確認）。あわせて、(a)・(b) の判定そのものを確かめる小さな例（12.5 の「増える例」）で、M から受け取っていた (g, i) の前回の行が増えても (b) が通り、無関係な行の数を1つ変えた rows では (b) が落ちることを確かめる。

### 12.4 W107 と S05 の扱い

- T00 で見つかった W107 は、どれも S05 が原因である：(a) 設営の使用場所（体育館）の机が他の団体へ出て、設営は 1-1〜2-3 から受け取る（設営は体育館の机を使えない）。(b) 1-1〜2-3 を使う模擬店の部屋の机が設営へ出て、その模擬店は他から受け取る（設営は他の部屋から受け取れない。T00 の元の定式化で1件。この設計の30通りでは (a) だけだった）。どちらも入れ替えるとルール違反になるので、管理者が直せるものではない。
- 推奨：W107 を、次の両方を満たす組み合わせ（g が L 以外の r から受け取る j の行と、L から h へ出る j の行）が1つでもあるときだけ出す定義にする。
  1. 入れ替え（g が自室 L の j を使い、h が r の j を受け取る）が、ルール（rules.ts の canUse：代替の区分・了承・運び元の制限。r・L が使用不可でないこと）の上でできる。
  2. 入れ替えても距離の合計が増えない：d(r,h) ≤ d(r,g) ＋ d(L,h)（d(L,g) ＝ 0）。
- この定義なら、full モードの最適解に W107 は出ない（距離の上書きがあっても）。入れ替えても c_sub・p・x̂ は変わらず（g・h とも申請品目と品目は同じ）、距離は増えず、e は 2 から 1 に減るので、入れ替えた解の方が辞書式で真に良いからである。出るのは、最小変更モードで前回の行を保った場合と、手で決めた行（固定・手動）だけで、どちらも管理者が入れ替えで直せる warning になる。
- 2 の条件がないと、distance_overrides が三角不等式を崩すとき、最適解に直しようのない W107 が出る（批評の例：上書き X–Y ＝ 1・Y–Z ＝ 1、X–Z は既定の 4。g〔Y 棟の L〕と h〔Z 棟〕が机1台ずつ、在庫は L に1、r〔X 棟〕に1。最適解は g←r（1）、h←L（1）で合計 2、入れ替えると h←r（4）、g←L（0）で合計 4）。6.1 の表は上書きがなければ三角不等式を満たすので、上書きがなければ 2 は自動的に満たされる。
- これは受け入れ基準「W107 が0件」の意味に関わるのでユーザーに確認する（openQuestions）。決まるまで、T06 のテストは「新しい定義で0件」と「古い定義の件数がすべて S05 の対象（設営か、S05 の部屋を使う団体）であること」の両方を確かめる。

### 12.5 実験の持ち込みと、テストの入力・期待値

logic-lab はこの設計のセッションの scratchpad にあり、T06 を実装するセッション・worktree からは読めない。そこで次の2つを両方行う。

**(1) リポジトリに入れる**（T06 の前。この設計書と同じ PR、なければ T06 のブランチの最初のコミット）

- logic-lab を `spikes/logic-lab/` にコピーする（node_modules は除く）。T00 の spikes/highs と同じ扱い：独自の package.json（`highs` 1.15.4・`tsx` 4.23.15・`typescript` 7.0.2・`zod` 4.6.7 を exact）と npm の lockfile で動かし、pnpm workspace に入れない。ルートの ESLint は `spikes/**` を無視し、ルートの tsconfig も spikes/ を含めないので（T01）、lint・tsc・Vitest の対象外になる。README.md に、下の表の「スクリプト」と「確かめたこと」と実行のしかた（`npm ci && npx tsx <file>`。d08oracle を import するものは引数 `lib`）を書く。
- この設計書（logic-design.md）と差分案（spec-changes-logic.md）は `notes/T06-design/` に入れる（T06 の依頼文と notes/T06.md から参照する）。
- 本体のテストは spikes/ を import しない。T06 は必要なものを packages/allocator/src/testing/ と *.test.ts に書き直す（model2.ts は検算の参考で、allocate の実装として流用しない。T00 の lp.ts と同じ）。

| スクリプト（spikes/logic-lab/） | 確かめたこと（本文） | T06 で移す先 |
| --- | --- | --- |
| brute-lex-1200.ts・brute-unit.ts | 総当たりで辞書式の μ は不一致 0、1台ぶんの μ は 3 例（6.3・11 章） | weights.test.ts の総当たり（12.1） |
| review/lex.ts・crit/lexseq.ts | 段ごとの検算（11 章） | testing/solveLexStages と weights.test.ts |
| rev3/d08oracle.ts・tcheck/inc2.ts・tcheck/incex.ts | D-08 の判定、減らない・無関係な行は変わらない・増える行は M から受け取っていた (g, i) だけ（6.3・11 章） | minimal-change.test.ts（12.3） |
| review/cex-s05.ts・rev3/cex.ts | 6.3 の反例が「補えない」に分かれる | 同上（手順9） |
| rev3/s05diag.ts | S05 が原因の入力は P7 で止まり、S05 を外すと解ける（9 章） | T07 の diagnose のテスト |
| crit/keep.ts | keep を pinned にしても 18（12.2） | 不変条件の「固定行・手動行が二重にならない」 |
| crit/types-check.ts・crit2/t1.ts | LpSolver の型（2.4） | solve.test.ts の型のテスト |
| tri.ts | 距離の三角不等式（6.1） | distance.test.ts（性質のテストとして） |
| port/gen.ts・port/run.ts・port/diff.ts | 合成データの移し方（3.6） | shared/testing/synthetic.ts |
| run*.ts・results-run.txt | 11 章の表 | notes/T06.md の比較 |

**(2) テストの入力と期待値**（本文だけで builder の入力が書けるように。距離は 6.1、品目は机(木)だけ、規則は書いたものだけ）

| 名前 | 入力 | 期待値 |
| --- | --- | --- |
| 反例（6.3、12.3 手順9） | 場所（すべて kind ＝ room）：M（A棟2階、机1）、R2（A棟1階、机2）、R3（C棟1階、机5）、X（A棟2階、在庫なし）、Y（A棟1階、在庫なし）。団体：S（部門、使用場所 X、机の申請2）、A（部門、使用場所 Y、机の申請1）。ルール：source_restrict（S、desk、運び元 {M, R2}） | full：M→S 1、R2→S 1、R2→A 1。M を使用不可にした minimal_change：R2→S 2、R3→A 1。つながりは1つで「補えない」（前回の M 以外の行を固定すると S の需要1に候補の在庫がなく P7）。無関係な行 R2→A が 1 → 0 |
| 増える例（12.3 手順6・9） | 場所：M（A棟2階、机1）、R（A棟1階、机2）、Q（C棟1階、机1）、X（A棟2階）、Y（C棟1階）。団体：S（部門、使用場所 X、机2）、A（部門、使用場所 Y、机1）。ルールなし | full：M→S 1、R→S 1、Q→A 1。M を使用不可にした minimal_change：R→S 2、Q→A 1。つながりは1つで「補える」。変わった行は M→S（1 → 0）と R→S（1 → 2。M から受け取っていた (S, 机) なので (b) を通る）。無関係な Q→A は 1 のまま。Q→A を 0 にした rows を判定に渡すと (b) が落ちる |
| W107 と距離の上書き（12.1 w107.test.ts、12.4） | 場所：r（X棟1階、机1）、L（Y棟1階、机1）、H（Z棟1階）。団体：g（使用場所 L、机1）、h（使用場所 H、机1）。上書き X–Y ＝ 1、Y–Z ＝ 1（X–Z は既定の 4） | allocate の最適解は r→g 1、L→h 1（距離の合計 2）で、findW107 は 0。上書きを外して同じ rows（r→g、L→h）を findW107 に直接渡すと 1（入れ替えると 4 ＋ 0 ≦ 4 ＋ 4）。T00 の定義ではどちらも 1 |
| keep を pinned（12.2） | r8like（シード 20261029）。学科展示（使用場所 第一多目的室、机の申請 18・椅子 6）、第一多目的室の在庫 机20・椅子30（生成器の固定値）、S08 は机12・椅子4 | full の rows：第一多目的室→学科展示 机18（isKeep）、椅子6（isKeep）。机の行 18 を pinned の固定行にして解き直すと、同じキーの新しい rows は 0、固定行＋rows は 18（30 にならない） |
| 総当たり（12.1） | brute-lex-1200.ts の生成器：シード 1〜1200（mulberry32）、場所2〜4・団体2〜3・品目5（desk・desk_ng・chair・chair_ng・caster_desk）、ルール S01・S02・S07（了承なし）、偶数のシードは前回の行3つの minimal_change。変数が 14 を超える・候補のない需要がある入力は飛ばす | 列挙できたのは 533 通り（解けない 346、飛ばした 321）。辞書式の μ で不一致 0。1台ぶんの μ（d_max ＋ 1 相当）ではシード 10・666・932 で不一致（LP の5段の値 [0,0,0,0,0] に対し最小は [0,−1,4,−1,2] など。前回の1台を保てる解がある） |
| S05 が原因（9 章、T07） | r8like の S05 の6部屋の机を合わせて 235 台にし、減らした 45 台を S05 以外の机のある部屋の最初の行に足す（makeInfeasibleS05） | P7 で止まる：設営・机(木)、D′ 241、候補の S′ 235。S05 を外すと Optimal、S06・S08 を外しても P7 で止まる |

## 13. validate と exporter が受け取るもの

### 13.1 validate（T07）

```ts
export function validate(data: YearData, rows: AllocationRow[] | StoredAllocationRow[]): Issue[];
```

- data は allocate の入力と同じもの（AllocateInput をそのまま渡してよい。mode・fixedRows・previousRows は見ない）。rows はその年度の全行（固定・手動・自動・keep）。DB から読んだ行は id を持つので、refs.rowIds で行に移動できる。allocate の直後の未保存の行は id がない。
- 足りるかの確認：E001（stocks）、E002（rooms.usable）、E003・W101（buildDemand の D と比べる。D-05・D-07）、E004（rules.ts の canUse。代替の区分・了承の拒否・運び元の制限。加えて、読み替えた後の申請品目が団体の区分で申請できない行）、E005（groups.locationRoomId）、E006（buildDemand の excluded。items.requestableCategories で申請できない申請。長机(3人掛)は読み替えるので除く。D-05。allocate はこの申請を需要から除いて解くので、E003 とは重ならない）、W102（consents。下の箇条書き）、W103（rows）、W104（rooms.isStorage と stocks の行の有無）、W105（groups.submittedAt）、W106（fixed_request と requests。D-07 のとおり提出済みの団体で数が違うときだけ。未提出の団体は W105 で示す）、W107（findW107。12.4 の定義）、I201（stocks と rows）。すべて YearData と rows から計算できる。
- rows の requestedItemId には、allocate の P0 と同じ読み替え（rewriteRequestedItem）を当ててから比べる（DB に長机(3人掛)のまま残っている手動の行のため）。
- W102（DB 設計 6.5・spec-changes.md 3-3 に合わせる）：needsConsent の代替ルール（R8 は S07）の (from, to) について、団体ごとに置き換えの台数 n（requestedItemId ＝ from、itemId ＝ to の行の合計。固定・手動・自動を問わない）が1以上で、了承の status が accepted でない（記録がない・not_asked・asked）とき、または accepted でも count があって n ＞ count のとき（「了承は 20 台、今は 24 台。依頼し直し」）。declined で n ＞ 0 は E004（了承しなかった団体への置き換え）。
- 並び：error → warning → info、次にコード、次に refs の部屋・団体・品目の並び。

### 13.2 exporter（T08）

```ts
export type ExportRow = AllocationRow & { note?: string | null };
export function exportAllocationXlsx(input: {
  yearLabel: string;                   // ファイル名「{年度}_椅子机振り分け_部門員共有用.xlsx」と「在庫(R○数え)」
  data: YearData;                      // items（name）、rooms（name・usable・isStorage・sortOrder）、groups（name・category・submittedAt・sortOrder）、stocks
  rows: ExportRow[];                   // その年度の全行
}): Promise<Uint8Array>;
export function exportSwapsXlsx(input: { yearLabel: string; data: YearData; rows: ExportRow[] }): Promise<Uint8Array>;
export function exportYearJson(input: YearExport): string;   // DB の行に近い形（T08 で決める。メールは含めない）
```

- 部屋名・団体名・品目名は YearData にあるので、表示用の情報を別に渡す必要はない。足したのは groups.displayName（交換依頼一覧の企画名）と submittedAt（K-27）だけ。
- 余り・計・使用不可の数は exporter が rows と stocks から自分で計算する（allocator に依存しない）。
- 交換依頼一覧は、needsConsent の代替ルール（R8 は S07）の (from, to) に当たる行（requestedItemId ＝ from、itemId ＝ to）を団体ごとに集計し、consents の status を並べる。不可机・長机の代替は needsConsent でないので入らない。
- 団体別集計の並び（K-27）：区分（模擬店 → 部門 → 企業 → 休憩所）→ submittedAt（null は最後）→ sortOrder → name → id。shared の compareGroupsForReport を使う。取り込んだ団体の submittedAt がフォームのタイムスタンプになるかは DB の対応しだい（3.7・16 章）。
- SUMIF の条件の解釈（K-21）：団体別集計の SUMIF は、C 列（使用用途）を団体名で引く。条件の文字列は、`*` `?` `~` がワイルドカード、先頭の `=` `<` `>` が比較演算子として読まれ、英字の大文字・小文字を区別せずに一致する。また集計の4行は C 列の「(計)」「使用不可」をキーにする。そこで shared の `groupNameSchema` で次を止める（T09 のマスタ入力と T05 の fixtures の検証で使う。CSV の取り込みは登録済みの団体に対応させるだけで、団体を作らない）：
  - 半角の `*` `?` `~` を含む名前。
  - 先頭（前後の空白を除いた後）が半角の `=` `<` `>` の名前（例：「<未定>」）。
  - 予約語「(計)」「使用不可」「余り」「残す」と同じ名前（大文字・小文字・全角半角を区別せずに比べる。品目シートの B・C 列に書く語）。
  - 年度の中で、NFKC で正規化して小文字にした名前が他の団体と同じもの（例：「SE企画」と「se企画」。SUMIF では同じ団体として足される）。これは1つの名前では決まらないので、`checkGroupNames(groups): InputError[]` として、T09 の保存の前と T05 の fixtures の検証で呼ぶ。
  - exporter は念のため、当てはまる団体名があれば例外にし（message に団体名）、ファイルを作らない。画面（T13）は「団体名を変えてから出力してください」と出す。
- 備考の列（1列のシートは E、2列のシート〔机(木)・椅子(木)〕は F）：allocations.note があればそれを、なければ needsConsent の代替の行（requestedItemId ＝ from、itemId ＝ to）に「{to の品目名}に交換」を自動で入れる（R8 の「キャスター机に交換」。03「Excel出力仕様」の表の例と同じ文言）。2列のシートで1行にまとめた2つの行に備考があれば「、」でつなぐ（同じ文言は1回）。この自動の備考は 03 の差分（spec-changes-logic.md 1-14）に入れる。

## 14. 後のチケットへの申し送り

**共通基盤の担当**（T05 と T06 の両方が使うので、先に着手した方が入れ、もう一方はそれに乗る。同じファイルを2つの PR で作らない）

| 共通基盤 | 中身 | 使うチケット |
| --- | --- | --- |
| packages/shared の本体 | constants.ts（2.1）、model.ts（2.2・2.4 の型と zod スキーマ）、rules.ts（2.3。ruleSchema・checkRuleRefs）、buildDemand・rewriteRequestedItem（5 章 P1）、groupNameSchema・checkGroupNames（13.2） | T05（RequestRow・Item・rewriteRequestedItem・groupNameSchema）、T06〜T08、T12 |
| `@gaapp/shared/testing` | repoRoot・readFixtureDir・writeFixtureDir（3.1）、UUIDv5（3.3）、toYearData・toAllocateInput（3.4）、builder、synthetic.ts（3.6） | T05（fixtures/r8 の検証）、T06〜T08 |
| 合成データ | scripts/gen-synthetic-fixtures.ts と fixtures/synthetic/r8like（3.6。reference/ は除く） | T06〜T08、T12 |
| ESLint の方向の規則（1 章） | no-restricted-imports と例外 | すべて |

- 実際には、R8 の元データを待つ T05 より T06 が先に始まる見込みなので、T06 のブランチの最初のコミット群（共通基盤 → 合成データ → 3.6 の「移した後の確認」）で入れ、T06 の PR に含める。T05 の importer の PR が先に出るなら、その PR が shared の本体（少なくとも型・スキーマ・rewriteRequestedItem・groupNameSchema）と shared/testing の fixtures の入出力・UUIDv5 を入れ、T06 は残り（buildDemand、builder、synthetic、合成データ）を足す。
- 後から乗る側は、先に入った共通基盤を変えるとき、変えた理由を PR に書く（2つの PR で同時に変えて衝突しないように、先に入った方を main から取り込んでから作業する）。
- T06 は fixtures/r8 を待たない（12.2 のとおり、ない間は it.todo を出して合成データで確かめる）。05 のチケット表の T06 の前提を「T00、T05 の importer と共通基盤（fixtures/r8 は不要。共通基盤は先に着手した方が入れる）」に直す（spec-changes-logic.md 5-4）。

- T05：3 章の形式で fixtures/r8 を作る。手で書くファイル（rooms.csv・rules.json・distance_overrides.csv・manual/）と、build-r8-fixtures.ts が生成するファイル（groups.csv・stocks.csv・requests.csv・consents.csv・reference/）の分け方、代理入力の団体の submitted_at、reference の剣道部と requested_item の決め方は 3.8 のとおり。rooms.csv の building・floor は 00 の未決事項（建物・階のデータ）に当たるので、分からない部屋は README に書き、仮の値の根拠を残す。scripts/build-seed-r8.ts（seed.sql の R8 の区間を書き換える）と、生成し直しの一致テスト。R8 の年度は T04 の seed の固定の id（…a1）に足し、品目は code で引く（3.4）。resolveResponses の合算（3.7）と、両方の長机を申請した回答のテスト。groupNameSchema・checkGroupNames で fixtures の団体名を確かめる。fixtures/r8 を足す PR で ci.yml に `REQUIRE_R8_FIXTURES=1` を入れる（12.2）。R8 の元データが届く前に importer だけを入れる場合は、fixtures/r8 と REQUIRE_R8_FIXTURES は後の PR にする。
- T06：この設計のとおり。最初に spikes/logic-lab/ と notes/T06-design/ があることを確かめ（12.5）、共通基盤（上）がまだなければ入れ、合成データを移して 3.6 の「移した後の確認」をする。合成データの reference/（3.6）も T06 の PR で足す。notes/T06.md に、R8 と合成データの stats（変数・時間・係数）、置き換え台数、不可机・不可椅子の使用数、団体あたりの運び元の数（W103 の候補）、W107 の新旧の件数、最小変更の補える・補えないつながりと変わった行の数を書く。fixtures/r8 がないまま終えるときは「R8 では未確認」と書く。依頼文（docs/prompts/T06.md）の「δ（−0.1）」「μ ＝ d_max ＋ 1」は spec-changes-logic.md の 03 に合わせて読み替える。
- T07：diagnose の中身（9 章。P7 で止まった入力でもルールを外して解き直す）と validate（13.1。W102 の count、E004 の申請できない申請品目、E006 は buildDemand の excluded）。W107 は findW107 を Issue にする。checkInvariants と validate の結果が R8・合成データで一致することをテストする。S05 が原因の入力で causes に S05 が入るテスト（12.2）。
- T08：13.2。fixtures/r8/reference/allocations.csv と fixtures/synthetic/r8like/reference/allocations.csv を ExportRow にして出力し、LibreOffice で再計算して、団体別集計を各 reference/group_totals.csv と比べる（R8 は group_totals.csv に載っている団体だけ。載っている数が README の除いた数と合うことも確かめる。3.8）。exporter のテストは allocator を import しない。T08 を T06 より先に進めるときは、合成データの reference がまだないので、builder で作る小さな行（使用不可の部屋・2列のシートでまとまる行・自動の備考を含む）で様式のテストを書き、合成データの reference のテストは T06 の後に足す（fixtures/r8 があればそれで流す）。
- T09：団体の登録で groupNameSchema と checkGroupNames（13.2）、場所の extra_cost と距離の上書きの cost は 0〜20 の整数（2.2）。distance_overrides は building_a < building_b に並べ替えて保存する（DB 設計）。
- T11：CSV 取り込みの保存では、フォームのタイムスタンプを submitted_at に入れる（3.7。DB の対応が入るまでは取り込んだ時刻になることを notes に書く）。requests は resolveResponses の合算した行を送る。
- T12：2.3 の ruleRowSchema と checkRuleRefs（RuleDraft と ctx.rules）を使う。R8 の S01〜S08 を画面から入れた結果が fixtures/r8/rules.json（id に変換したもの）と一致すること。fixtures/r8 がなければ fixtures/synthetic/r8like/rules.json で代える。
- T13：4 章の Worker（読み込みの失敗を残さない）と、apps/web の predev・prebuild での wasm のコピー。保存の前に `validate(input, [...fixedRows, ...rows])`。ok: false は reason ごとに見出しを変えて出す：invalid_input は「入力に誤りがあります」と inputErrors（path・ruleCode）、precheck は「振り分けの前に直すものがあります」と issues（rowIds・ruleCode で該当の行・ルールへ移動）、infeasible は「解けません」と shortages（品目全体 → 団体つき）と causes（ルールと details）、solver_error は message。ok: true でも stats.excludedRequests が1以上なら「申請できない品目の申請 N 件を除いて計算しました（検証の E006 を見てください）」と出す。「団体別」の申請数は buildDemand の D。DB から作った入力では、テスト団体・テスト用の場所の分だけ W104・W105 が増える（3.4）。

## 15. ユーザーに確認すること（本文は推奨案で書いた）

| # | 内容 | 推奨 | 他の案 |
| --- | --- | --- | --- |
| 1 | W107 と S05（12.4）。S05 のために入れ替えられない「自室の机を外へ出して他から受け取る」形を W107 に数えるか | 入れ替えがルール上でき、入れ替えても距離の合計が増えないものだけを W107 にする（「W107 が0件」の基準はその定義で満たし、全体の実行では距離の上書きがあっても必ず0件になる） | 定義は今のままで、受け入れ基準だけ S05 の対象を除く／S05 に「使用場所の在庫は使ってよい」を足す（業務の変更） |
| 2 | 性能要件（K-22）。「2秒以内」に wasm の初回の読み込みを含めるか | 含めない（計算だけ。読み込みは進捗を出す） | 含める（Slow 4G 相当では満たせない。PWA のキャッシュなどが要る） |
| 3 | 運び元の制限（source_restrict）が代替先の品目にもかかるか（7 章） | かける（制限は申請品目で判定。R8 は影響なし） | 実際に運ぶ品目で判定する（例：設営に代替を許した年に、代替先はどこからでもよい） |

初版の4つ目（同じ部屋を使う2団体が、その部屋の在庫を取り合うとき、どちらに残すか）は、確認事項から外して設計で決めた：決めない（コストが同じなので結果は HiGHS 任せ。同じ入力なら同じ結果。W107 には数えない）。2団体の使用場所が同じなので、どちらの団体の名前で数えても、部屋から運び出す・部屋へ運び込む備品の数と距離は同じで、運搬の作業は変わらない。違うのは振り分け表の「使用用途」の名前だけなので、業務の判断が要らない。必要になったら、sort_order の段を足せる。

## 16. DB 設計との突き合わせ（DB 設計への申し送りを含む）

並行して作っている DB 設計（db-design.md・spec-changes.md）と、次のとおりそろえた。DB 設計の側で直してもらうものには「申し送り」と書いた。

| 項目 | この設計で決めたこと | DB 設計 |
| --- | --- | --- |
| consents の count | Consent に `count: number \| null` を足し、W102 で使う（2.2・13.1）。spec-changes-logic.md 1-2 の型に入れる | 6.5・spec-changes.md 3-1・3-3 と同じ |
| 前処理3（keep） | spec-changes-logic.md 1-4 の 3 が spec-changes.md 3-2 の内容をすべて含む。DB の差分が先に入るので、1-4 の「変更前」は 3-2 を当てた後の文になる | 3-2 |
| seed | seed.sql の1本。T02 → T04（R8 の年度 …a1）→ T05（R8 の本データ。生成した区間）の順。品目は code で引く（3.4） | 1 章・2.3・8.3 と同じ |
| ルールの code・数の上限 | ruleCode は 50 字まで、fixed_request・keep の数は 10000 まで（2.3） | rules.code ≤ 50、requests.count ≤ 10000 と同じ |
| 距離の値の範囲 | rooms.extraCost・distanceOverrides.cost は 0〜20 の整数（2.2） | 申し送り：rooms.extra_cost と distance_overrides.cost に `check (… between 0 and 20)` を足す（今は 0 以上だけ）。入るまでは allocate が invalid_input で止める |
| 取り込みの提出日時（K-27） | フォームのタイムスタンプを submitted_at に入れる（3.7） | 申し送り：update_requests_after_deadline の p_submission に submittedAt を足し、そのときだけ transaction-local の設定を立てて tg_submissions_set_actor が値を置き換えないようにする（admin だけが呼べる RPC なので、団体代表が日時を偽れない）。pgTAP に「admin の取り込みでは値が残る」「団体代表の submit_requests では now()」を足す |
| allocations の申請品目 | allocate・validate は requestedItemId を読み替えてから使う（5 章 P0） | DB は requested_item_id の区分を確かめない（save_allocation_rows も）。変えなくてよい（validate の E004 で示す） |

## 改訂の記録（2026-10-29）

批評（仕様・LP・テスト・結合の4観点、33件）の扱い。high と med はすべて採用した（一部は直し方を広げた・変えた）。low もすべて採用した。LP に関わるものは logic-lab（rev3/d08oracle.ts・rev3/cex.ts・rev3/s05diag.ts、crit2/t1.ts）で確かめた（11 章）。要件定義に効くものは spec-changes-logic.md にも反映した。

| # | 観点・重さ | 指摘 | 判定 | 反映した内容 |
| --- | --- | --- | --- | --- |
| 1 | spec・high | S05 が原因の典型の入力は P7 で止まり、diagnose の手順2（shortages が空なら解き直す）が動かず、causes に S05 が入らない | 採用（直し方を広げた） | 手順2を「手順1の結果にも P7 の不足にもよらず、ルールを1つずつ外して解き直す」にした（fixed_request・keep は品目全体の不足を消しうるので、品目全体の不足があっても試す。K-26）。「解けた」の条件（precheck・P7 が出ず、Optimal）を明記。P7 は buildModel の中で行う（5 章 P7、9 章）。T07 のテストに makeInfeasibleS05 相当の入力を足した（12.2）。logic-lab で S05 だけが解けることを確認。差分案 1-12 |
| 2 | spec・low | 係数が大きい最小変更モードで辞書式の最小が返ることをテストで確かめていない | 採用 | weights.test.ts に段ごとの検算（solveLexStages）を足した（12.1、4 章の testing/） |
| 3 | spec・low | 「足りない品目」T を品目全体の余りで決めているので、6.3 の保証が一般には成り立たない | 採用 | 8 と同じ |
| 4 | spec・low | 差分案と設計の細部の食い違い（ok: false の stats?、固定行の E005、同じ cost のときの code の順） | 採用 | 差分案 1-2 に stats?、1-5 に「同じ cost なら code の順」。固定行の E005 は 5 の決定で止めなくしたので、設計（P3）から外した |
| 5 | spec・low | precheck で止めるコード（E001・E002・E005・E006）が決定の表にも decisions.md にもない。E006 で止めると自動振り分けが動かなくなる | 採用（決定を変えた） | 方針を「allocate が作る行に error を出さない。人が決めた固定行の error では止めず validate が示す」とし、precheck は E001 と keep のルールの E002・E005 だけにした。E006 の申請は需要から除いて解き（stats.excludedRequests）、validate が E006 として示す。固定行の E002・E004・E005 でも止めない（5 章、9 章）。差分案の冒頭の表・1-3・1-4・1-12・7 章（decisions.md）。どちらでも error は確定を止め、業務の判断は変わらないので、ユーザーには確認しない |
| 6 | spec・low | 自動の備考が 03 にない・列の指定が誤り。SUMIF の比較演算子と予約語 | 採用 | 13.2 の備考の列（1列は E、2列は F）、差分案 1-14 に自動の備考を足した。groupNameSchema の禁止を広げた（33 と同じ） |
| 7 | spec・low | 04・05 にインターフェースの変更（exporter・importer の引数、解けないときの表示、seed の置き場所）が入っていない | 採用 | 差分案 4-1（reason ごとの表示）、4-2（表の行）、4-3（CSV 取り込み）、5-1（seed） |
| 8 | lp・med | D-08 の保証（余りが足りる品目では無関係な行は変わらない）は一般には成り立たない（反例 cex-s05） | 採用 | 6.3 に正しい条件（前回のほかの行を変えずに、使える場所の余りから代替の重さを増やさずに補えるとき）と反例を書いた。12.3 を「候補のつながりごとに、前回の M 以外の行を固定して解き、代替の重さが同じなら補える」判定に変えた。logic-lab/rev3 で、解けた 73 通りの補えるつながり 183 で違反 0、反例は補えないに分かれることを確認。03・05・SPEC の文言（差分案 1-6・5-3・6-2・6-3） |
| 9 | lp・med | diagnose の手順2の shortages が P7 のものを含むか不明 | 採用 | 1 と同じ |
| 10 | lp・med | W107 の新しい定義は、距離の上書きが三角不等式を崩すと最適解にも出る | 採用 | W107 の条件に「入れ替えても距離の合計が増えない（d(r,h) ≤ d(r,g) ＋ d(L,h)）」を足した。全体の実行では上書きがあっても0件になる（12.4）。w107.test.ts に批評の例。差分案 1-13・2-1、確認事項 1 の推奨 |
| 11 | lp・low | 読み替えと E006 が requests にしか当たらず、固定行・前回の行・fixed_request・keep で二重の割り当てや S03 違反が起きる | 採用 | P0 で固定行・前回の行の requestedItemId を読み替える。checkRuleRefs で fixed_request・keep の品目が団体の区分で申請できるか確かめる（2.3）。validate の E004 に「読み替えても申請できない申請品目の行」を足した（13.1） |
| 12 | lp・low | extraCost・distanceOverrides.cost を整数・0 以上に絞っていない | 採用（上限も足した） | 0〜20 の整数（2.2）。DB に同じ CHECK を申し送り（16 章） |
| 13 | tests・high | 1 と同じ | 採用 | 1 と同じ |
| 14 | tests・med | D-08 のテストに、infeasible なら通る分岐と、何も確かめずに通る場合がある | 採用 | 12.3：r8like＋MER と R8＋第一セミナーは ok: true を必須、「M から運んだ行が1行以上」「補えるつながりが1つ以上」を assert、解けない組は「full が解ける ⇔ minimal_change が解ける」を別のテストにした |
| 15 | tests・med | 不変条件の期待値に buildDemand を使うと同じ誤りを見逃す。checkInvariants が keep の行を二重に足す | 採用 | 12.2 で期待値を requests.csv・rules.json から直接作る（読み替えと未提出の fixed_request をテストに明示）。checkInvariants の入力を「固定行＋rows」にし、そのテストを足した（12.1） |
| 16 | tests・med | keep を pinned にしたときの期待値 12 が合成データでは誤り（18 になる） | 採用 | 12.2 の行を「pinned にする前と同じ数（合成データでは 18）。30 にならない」に直した。団体・部屋・品目は rules.json の S08 から引く |
| 17 | tests・med | 並べ替えのテストで fixedRows・previousRows・consents が空 | 採用 | 8 章：空でない配列を持つ入力で並べ替え、各配列で順が実際に変わったことを assert |
| 18 | tests・med | LpSolver の Columns の型では highs の Highs を代入できない | 採用 | `Record<string, unknown>` と実行時の確認（2.4）。tsc で TS2322 を再現し、直した型で通ることを確認 |
| 19 | tests・med | fixtures/r8 がないと静かにスキップされる | 採用 | repoRoot() でパスを解決（3.1）、it.todo を出す、REQUIRE_R8_FIXTURES で必須にする、notes/T06.md に「R8 では未確認」、T12 は合成データの rules.json で代える（12.2、14 章） |
| 20 | tests・med | T08 は T06 より先に進めうるのに、合成データを allocate した rows を使う。合成データに group_totals がない | 採用 | 合成データの reference/ を scripts で生成してコミットし、scripts の Vitest で一致を確かめる（3.1・3.6）。T08 は allocator を import しない。T06 より先なら builder の行で様式のテストを書く（14 章） |
| 21 | tests・low | 2 と同じ | 採用 | 2 と同じ |
| 22 | tests・low | ESLint の規則で testing/ と solve.test.ts の highs の import が止まる | 採用 | 例外に `packages/*/src/**/*.test.ts`・`packages/*/src/testing/**`・`scripts/**` を足し、testing/ を index.ts から export しない（1 章、4 章） |
| 23 | tests・low | 3・8 と同じ（source_restrict の団体） | 採用 | 8 と同じ |
| 24 | integration・high | consents の count が Consent 型にない。差分案 1-2 が DB 側 3-1 の count を消す。重なる箇所の一覧から 3-1・3-2 が漏れている | 採用 | Consent に count を足し（2.2・2.5・3.2）、W102 に count との比較（13.1）。差分案の冒頭の重なる箇所を4つにし、1-2 の型に count、1-4 の 3 が DB 3-2 を含むことを書いた。16 章 |
| 25 | integration・med | seed の分担と id が DB 設計と食い違う（年度の作り直しで unique にぶつかる、seed のファイル構成、品目の id、テスト団体・テスト用の場所） | 採用 | 3.3・3.4 を DB 設計に合わせた：seed.sql の1本、T05 の部分は生成した区間、R8 の年度は T04 の固定の id に足す、品目は code で引く、fixtures で年度の id を作らない。テスト団体・テスト用の場所の分の W104・W105 を T13・T14 で見込む。差分案 5-1 |
| 26 | integration・med | 取り込みの submittedAt を DB に保存する経路がなく、K-27 の申請順がフォームの提出順にならない | 採用（DB 設計への申し送り） | update_requests_after_deadline の p_submission に submittedAt を足し、admin の RPC からの値をトリガーが保つ案を決め（3.7・16 章）、入るまでの並びを書いた（13.2、14 章 T11）。差分案 4-3 |
| 27 | integration・low | 読み替えの後に requests の主キーが重複する | 採用 | resolveResponses は (groupId, itemId) で合計して1行にする。T05 のテスト（3.7） |
| 28 | integration・low | checkRuleRefs が id のない新規のルールと、他のルールとの重なりを扱えない | 採用 | `checkRuleRefs(rule: RuleDraft, ctx: { items, rooms, groups, rules })` にした（2.3） |
| 29 | integration・low | ruleCode と fixed_request の count の上限が DB と違う | 採用 | ruleCode は 50 字、count は 10000 まで（2.3） |
| 30 | integration・low | ESLint の例外と T08 の合成データ | 採用 | 20・22 と同じ |
| 31 | integration・low | `pnpm dev` で wasm が 404、Worker が読み込みの失敗を残す | 採用 | predev と prebuild でコピー、.gitignore、getSolver は失敗で null に戻し、読み込みの失敗を message で分ける（4 章）。差分案 4-2 |
| 32 | integration・low | importer・exporter の新しい引数が 04・SPEC に入っていない | 採用 | 差分案 4-2・6-1 |
| 33 | integration・low | groupNameSchema が SUMIF の比較演算子・大文字小文字・予約語を止めない | 採用 | 先頭の `=` `<` `>`、予約語、年度の中の NFKC・小文字での重複（checkGroupNames）を止める。exporter は例外（13.2）。差分案 1-14 |

確認事項（15 章）の変更：初版の4つ目（同じ部屋を使う2団体の取り合い）は、運搬の作業が変わらず業務の判断が要らないので、設計で決めて外した。1つ目（W107）の推奨に、距離の条件（10）を足した。

## 改訂の記録・改訂2（2026-10-29。実装者の目で見つかった抜け6件）

すべて埋めた。LP に関わる 1・6 は logic-lab（tcheck/inc2.ts・tcheck/incex.ts・port/）で確かめた。要件定義に効くものは spec-changes-logic.md にも反映した。

| # | 重さ | 抜け | 判定 | 反映した内容 |
| --- | --- | --- | --- | --- |
| 1 | high | 補えるつながりで「前回の M 以外の行がすべて変わらない」は成り立たない（M から受け取っていた (g, i) を、g がすでに受け取っている部屋から補うと、前回の行が増える）。d08oracle は減ったものしか数えていない。05 の文言も誤り | 採用 | 6.3 の保証を「前回の M 以外の行は減らない（前回の数以上）。増えるのは M から受け取っていた (g, i) の行だけ。無関係な行は同じキーで同じ数（新しいキーもない）」に直し、無関係な行が変わらない理由（減らず、合計が D′ のまま）を書いた。0 章も同じ。12.3 手順6を (a) 減らない・(b) 無関係な行は同じキーで同じ数 の2つの assert に分け、「すべて同じ数」は assert しないと明記。11 章を「減ったもの 0 件・無関係な行が変わったもの 0 件・増えたもの 9 件（どれも M から受け取っていた (g, i)）」に直した。tcheck/inc2.ts で、補えるつながり 180（＋20261029 の 3）のうち増えた 9 行がすべて M から受け取っていた (g, i) の行で、減った行・無関係な行の変化・無関係な新しいキーが 0 であることを確かめた。判定のテスト用に「増える例」（12.5）を作って確かめた。差分案 1-6・5-3・7 章の文言 |
| 2 | med | shared の本体・shared/testing・合成データの生成と fixtures を、どのチケットが作るかが決まっていない | 採用 | 14 章の冒頭に共通基盤の表と担当（先に着手した方が入れ、もう一方は乗る。見込みは T06 の最初のコミット群）を書いた。T06 は fixtures/r8 を待たない。05 のチケット表の T06 の前提を直す差分（差分案 5-4） |
| 3 | med | 根拠とテストの元が scratchpad の logic-lab にあり、T06 のセッションから読めない。反例の数などが本文から推し量れない | 採用（両方） | 12.5 を足した：logic-lab を spikes/logic-lab/（T00 の spikes/highs と同じ扱い。lint・tsc・Vitest の対象外）に、設計書と差分案を notes/T06-design/ に、T06 の前に入れる。スクリプトと本文の主張・移す先の対応表。反例・増える例・W107 の上書きの例・keep の 18・総当たりの生成器とシード（10・666・932）・S05 が原因の入力を、入力と期待値の表で書いた |
| 4 | med | R8 の手作業の振り分け表から reference を作る方法（剣道部が1団体、申請品目の列がない、group_totals の剣道部）が決まっていない | 採用 | 3.8 に規則を書いた：剣道部は2団体の申請を sort_order の順に満たすように表の行を割り振り（多い分は剣道部(非飲食)、2団体の和が表と一致することを確かめる）、例外の名前は許さない。requested_item は不可机→机、不可椅子→椅子、備考「キャスター机に交換」のキャスター机→机、企業の長机(2人掛)は長机(3人掛)の申請の不足分まで長机(3人掛)、ほかは品目と同じ。申請との差は README に書く（T08 の比較に効かない）。集計シートと行の合計が合わない団体は group_totals.csv に載せず README に一覧、T08 は載っている団体だけ比べ、数が合うことも確かめる。3.2・14 章 T08 |
| 5 | med | fixtures/r8 のどのファイルを生成し、どれを手で書くか、代理入力の団体の submitted_at が決まっていない | 採用 | 3.8 の表：rooms.csv・rules.json・distance_overrides.csv・meta.json・README と manual/（groups.csv〔区分・使用場所・並び・submission〕・adjustments.csv・reference_skip.csv・settings.json）は手で書く。groups.csv・stocks.csv・requests.csv・consents.csv・reference/ は生成。匿名化の対応表は R8_SOURCE_DIR/anonymize.csv（対応しない名前は名前を出さずに失敗）。submitted_at は、フォームは残した回答のタイムスタンプ、代理入力は R8 の申請締切の日時（空にすると W105 が残り、K-27 で最後に回り、設営は D-07 で固定数になるため）、未提出は空。3.1 の構成図、3.2 の groups.csv の行、差分案 5-2 |
| 6 | med | 合成データの移植（id を UUIDv5、団体を足す、同名の仕掛けを外す）で乱数の列が変わり、logic-lab の結果（MER で解ける、補えるつながり、W107）が保証されない。97・18 の根拠が書いていない | 採用 | 3.6 に「T00 で uuid(r) を呼んでいた場所は捨て読みして乱数の列を保つ」「足す団体は申請を作った後に r() を使わずに足し、申請は既存の団体から移す（合計は変えない）」「submitted_at も r() を使わない」と、移した後の確認（full・MER の minimal_change が ok: true、M から運んだ行と補えるつながりがある）、満たさないときの直し方（捨て読みの位置を確かめる → 対象の部屋を条件で選び直し notes に書く）を書いた。97（644 − 506 − 41）と 18（固定値の申請 18 と在庫 20）が構造の値であることを書いた。logic-lab の port/ で4通りの作り方を試した表を載せた（捨て読みなら在庫・申請は T00 と完全に一致し、シード 20261029 の rows も一致。採用した作り方で MER は 4 つのつながりのうち 3 つが補える）。12.3 手順2に、実装の誤りとデータの違いの見分け方（spikes/logic-lab の model2 で同じ入力を解いて比べる）を足した |
