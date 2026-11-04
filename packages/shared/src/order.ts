// 並べ替え（03「入力と出力」・設計 8 章）。文字列は UTF-16 のコード単位で比べ、localeCompare は使わない
// （Node とブラウザで ICU が違うと順が変わるため）。
// 部分の入口 `@gaapp/shared/order`（package.json の exports）からも読める。ここには何も import しない（入口〔index.ts〕は zod と
// ルールの形まで読むので、並べ方だけが要る画面〔自団体の提出物 /document の最初に読む JS。FU3 の案 5〕はこちらから読む）。

export function compareStrings(a: string, b: string): number {
  return a < b ? -1 : a > b ? 1 : 0;
}

/** sort_order → 名前 → id。品目・場所・団体の並び */
export function compareBySortOrder<T extends { sortOrder: number; name: string; id: string }>(a: T, b: T): number {
  return a.sortOrder - b.sortOrder || compareStrings(a.name, b.name) || compareStrings(a.id, b.id);
}

/** ルールの並び：code → id */
export function compareRules<T extends { code: string; id: string }>(a: T, b: T): number {
  return compareStrings(a.code, b.code) || compareStrings(a.id, b.id);
}

/** 順序つきの配列を作る（元の配列は変えない） */
export function sortedBy<T>(items: readonly T[], cmp: (a: T, b: T) => number): T[] {
  return items.slice().sort(cmp);
}
