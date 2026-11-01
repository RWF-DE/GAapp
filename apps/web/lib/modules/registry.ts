// 機能の登録（D-52。04「ダッシュボード」、notes/T16.md「固めた約束」3）。総務アプリの機能（01 の用語集の module）を並べる。
// データだけを置き、import をしない（lib/navigation.ts が見出しを作るのに読むので、ナビの JS を増やさない）。
// - id：英字の小文字（01 の用語集の英語名）。ModuleId になり、ナビの見出しの id・ダッシュボードのクエリのキー・要対応の id の頭に使う
// - label：ナビの見出しと、ダッシュボードのカード・要対応の機能の名前
// - homeHref：機能の入口の画面（ROUTES にあり、section がその id のルート）
// 並びは、ナビの見出しとダッシュボードのカードの並び。機能のチケット（T17〜T21）は最後に1行足す（D-52。05「チケット分割」）。

export const MODULES = [
  { id: 'furniture', label: '机椅子', homeHref: '/furniture' },
  // お知らせ（T17。D-53）。入口は「お知らせ一覧」（/notices。招待されている全員）
  { id: 'notices', label: 'お知らせ', homeHref: '/notices' },
  // 締切と予定（T18。D-54）。入口は「締切と予定の一覧」（/calendar。招待されている全員。見出しと同じ言葉を縦に並べないよう「の一覧」）
  { id: 'calendar', label: '締切と予定', homeHref: '/calendar' },
] as const satisfies readonly {
  id: string;
  label: string;
  homeHref: string;
}[];

/** 機能の id（'furniture' | 'notices' | 'calendar'） */
export type ModuleId = (typeof MODULES)[number]['id'];

export interface ModuleDef {
  id: ModuleId;
  label: string;
  homeHref: string;
}
