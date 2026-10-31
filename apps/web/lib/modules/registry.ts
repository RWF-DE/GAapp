// 機能の登録（D-52。04「ダッシュボード」、notes/T16.md「固めた約束」3）。総務アプリの機能（01 の用語集の module）を並べる。
// データだけを置き、import をしない（lib/navigation.ts が見出しを作るのに読むので、ナビの JS を増やさない）。
// - id：英字の小文字（01 の用語集の英語名）。ModuleId になり、ナビの見出しの id・ダッシュボードのクエリのキー・要対応の id の頭に使う
// - label：ナビの見出しと、ダッシュボードのカード・要対応の機能の名前
// - homeHref：機能の入口の画面（ROUTES にあり、section がその id のルート）
// 並びは、ナビの見出しとダッシュボードのカードの並び。機能のチケット（T17〜T21）は最後に1行足す（D-52。05「チケット分割」）。

export const MODULES = [{ id: 'furniture', label: '机椅子', homeHref: '/furniture' }] as const satisfies readonly {
  id: string;
  label: string;
  homeHref: string;
}[];

/** 機能の id（今は 'furniture'） */
export type ModuleId = (typeof MODULES)[number]['id'];

export interface ModuleDef {
  id: ModuleId;
  label: string;
  homeHref: string;
}
