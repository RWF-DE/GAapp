// 申請のテント等のパネル（lending-request-panel.tsx）の JS を読む（T21・D-57。04「申請の「テント等」のタブ」、notes/T21.md「画面の約束」6）。
// /request の最初に読む JS には入れない（動的 import なので、静的な import のグラフに入らない。import-graph.test.ts）。
// パネルを出す部品（request-tabs.tsx の LendingPanelSlot）と、`?tab=lending` で開いたときの読み始め（立場が届いて RequestTabs を
// 描くとき。タブを出すかを決める読み取りを待たない。レビューの T21-R1）が同じ Promise を使う（チャンクを2回読みに行かない）。
// これより前には始められない：AppShell は立場が届くまでページを描かず、ルートのレイアウト（先読みの表）から読み始めると、
// Turbopack がパネルをどのページの最初に読む JS にも入れた（notes/T21.md の「レビューで直したこと」）。
// 読めなかったとき（通信が切れたなど）は覚えた Promise を捨て、次に呼んだときに読み直す（先の読み始めの失敗で、タブを開いたときの
// 読み込みを止めない）。読み終えたものは覚えておき、描くときにそのまま使う（loadedLendingRequestPanel）。

export type LendingRequestPanelModule = typeof import('./lending-request-panel');

let loading: Promise<LendingRequestPanelModule> | null = null;
let loaded: LendingRequestPanelModule | null = null;

/** テント等のパネルの JS を読む（1回だけ。読み込み中・読み終えた後は同じ Promise を返す） */
export function loadLendingRequestPanel(): Promise<LendingRequestPanelModule> {
  loading ??= import('./lending-request-panel').then(
    (m) => {
      loaded = m;
      return m;
    },
    (e: unknown) => {
      loading = null;
      throw e;
    },
  );
  return loading;
}

/** 読み終えたパネルの JS（まだなら null）。読み終えていれば、描くときにそのまま使う（読み込み中を挟まない） */
export function loadedLendingRequestPanel(): LendingRequestPanelModule | null {
  return loaded;
}
