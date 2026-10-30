// テスト用の入口（`@gaapp/allocator/testing`）。Node のテストと E2E の補助（e2e/）から使う。
// D-08 の最小変更の判定（checkMinimalChange）と、Node で highs を1回だけ読み込む getHighs を出す。
// アプリ（apps/web）からは import しない（highs を Worker の外で読み込まないため。ESLint で止める）
export * from './d08';
export * from './getHighs';
