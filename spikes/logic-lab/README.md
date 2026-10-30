# logic-lab：振り分けロジックの設計を確かめた実験

T06 の設計（[notes/T06-design/logic-design.md](../../notes/T06-design/logic-design.md)）を作るときに、T00 のダミーデータ（`src/gen.ts`）にこの設計の前処理・距離・変数・係数・W107 を実装して（`src/model2.ts`）、highs 1.15.4 で解いて確かめたスクリプト。設計書の 11 章（実験の結果）と 12.5（実験の持ち込み）の根拠になっている。

- 本体（packages/）からは参照しない。pnpm workspace・ESLint・tsc・Vitest の対象外（T00 の `spikes/highs/` と同じ扱い）。
- `src/model2.ts` は検算の参考で、allocate の実装として流用しない。T06 は必要なものを `packages/allocator/src/testing/` と `*.test.ts` に書き直した。
- `src/gen.ts`・`src/lp.ts`・`src/analyze.ts`・`src/rng.ts`・`src/types.ts` は T00 の `spikes/highs/src/` の写し（品目コード `chair_blue` は T00 のまま。正しくは `blue_chair`）。
- 入力の id は乱数か仮の文字列で、個人情報は含まない。

## 動かし方

```sh
cd spikes/logic-lab
npm ci
npx tsx <ファイル>
```

`rev3/d08oracle.ts` を import するスクリプト（`port/run.ts`、`rev3/cex.ts`、`tcheck/incex.ts`）は、d08oracle の本体の実行を止めるため、引数 `lib` を付ける（例：`npx tsx port/run.ts lib`）。型の確認は `npx tsc -p crit/tsconfig.json`（通る）と `npx tsc -p crit2/tsconfig.json`（TS2322 で失敗するのが期待どおり）。

## スクリプトと確かめたこと

| スクリプト | 確かめたこと（設計書の章） | T06 で移した先 |
| --- | --- | --- |
| `run.ts`・`run2.ts`〜`run5.ts`、`results-run.txt` | R8 規模（シード 20261029）で Optimal・変数 5,630・整数からのずれ 0・同じ入力で同じ rows・並べ替えて同じ LP。T00 の整数化との比較、30 通りの時間、最小変更（MER を使用不可）の変わった行（11 章） | notes/T06.md の比較 |
| `brute-lex-1200.ts`・`brute-unit.ts`・`brute.ts` | 小さな入力の全整数解を列挙した辞書式の最小と LP の解が一致（辞書式の μ：533 通りで不一致 0。1台ぶんの μ：シード 10・666・932 で不一致）（6.3・11 章） | `packages/allocator/src/weights.test.ts` の総当たり |
| `review/lex.ts`・`crit/lexseq.ts`・`review/lexcheck.ts` | 段ごとに LP を解いた5段の値と、重みつきで1回解いた解の値が一致（11 章） | `packages/allocator/src/testing/solveLexStages.ts` と `weights.test.ts` |
| `rev3/d08oracle.ts`・`tcheck/inc.ts`・`tcheck/inc2.ts`・`tcheck/inc3.ts`・`tcheck/incex.ts`・`review/d08.ts`・`crit/d08.ts`・`crit/meaning.ts` | D-08 の判定：候補のつながりごとに前回の M 以外の行を固定して解き、代替の重さが同じなら「補える」。補えるつながりでは前回の M 以外の行が減らず、増えるのは M から受け取っていた (g, i) の行だけ（6.3・12.3） | `packages/allocator/src/minimal-change.test.ts` |
| `review/cex-s05.ts`・`rev3/cex.ts` | S05 で運び元が限られると、品目全体に余りがあっても無関係な行が変わる反例が「補えない」に分かれる（6.3） | 同上（反例のテスト） |
| `rev3/s05diag.ts`・`rev3/dbg.ts` | S05 が原因の入力は前処理7で止まり、S05 を外すと解ける（9 章） | T07 の diagnose のテスト |
| `crit/keep.ts` | 残すの行を pinned にしても合計は 18 のまま（12.2） | `packages/allocator/src/invariants.test.ts` |
| `crit/types-check.ts`・`crit2/t1.ts`・`review2/t1.mjs`・`review2/zt.mjs` | LpSolver の型（`Columns: Record<string, unknown>` なら highs の `Highs` を代入できる）、zod 4 の uuid・datetime・record・strictObject の振る舞い（2 章） | `packages/allocator/src/solve.test.ts`、`packages/shared` のスキーマ |
| `tri.ts` | 距離の表（上書きなし）が三角不等式を満たす（92 部屋の全組 778,596 通りで違反 0）（6.1） | `packages/allocator/src/distance.test.ts` |
| `review/bigcost.ts` | 係数が大きいとき（最小変更モード）も整数の解が返る（6.2） | `weights.test.ts` |
| `port/gen.ts`・`port/run.ts`・`port/diff.ts` | 合成データの移し方（id を UUIDv5 にし、T00 で uuid(r) を呼んでいた場所は捨て読みして乱数の列を保つ。足す団体は r() を使わない）で、full・MER の最小変更の条件を満たす（3.6） | `packages/shared/src/testing/synthetic.ts` |
