# YC 年度の作成で団体を複製しない（D-59）

ブランチ feat/year-no-group-copy（main a51cfae から）。ユーザーの決定（2026-11-04）「団体は引き継がない」。

## 決めたこと
- `create_year_from` は groups を複製しない。ルールは複製し、団体を参照するもの（`params.group` が文字列、または `params.groups` が空でない配列）だけ無効にして memo に「{前年度} から複製したとき、団体は複製しないので無効にした」を足す（元の memo があれば ` / ` でつなぐ。すでに無効でも足す）。params の団体 id は付け替えず前年度のまま（ルール画面では「（見つからない団体）」と出る）。団体を参照しないルールは enabled も memo もそのまま。
- 影響を調べたもの：休憩所の前年の数（previous_year_requests）は団体名で引くので、同じ名前で入れ直した団体にだけ初期値が出る。previous_year_documents・copy_previous_documents・previous_year_lending_items・previous_year_stocks は団体を使わない。団体が 0 件のときの案内（申請・ダッシュボード）は今ある。
- マイグレーション 0020_year_no_group_copy.sql（create or replace。権限は 010_grants が変わらないことを確かめる）。private.remap_group_ids は使わなくなったが残した。

## コマンドと結果
- 失敗を先に確かめた：`supabase test db supabase/tests/020_rpc_years.test.sql`（0020 なし）→ 5 件失敗（93・96〜99）。
- `supabase db reset` → `supabase test db`：Files=19, Tests=15708, PASS（020 は plan 117 → 122）。
- `pnpm lint`・`pnpm typecheck`：エラーなし。`pnpm test`：181 ファイル、2705 passed・2 todo。`pnpm build`：成功。`pnpm check:emails`：OK（1255 ファイル）。
- `pnpm check:types`：database.types.ts は DB と一致（型の変更なし。gen:types は不要）。
- `E2E_PORT=3410 pnpm e2e`：chromium 212 passed。serial は year-create の 1 件が、確かめの SQL の NULL の扱い（テストの誤り）で失敗 → 直して `playwright test --project=serial e2e/serial/year-create.spec.ts` で 9 passed（setup を含む）。ほかの serial 15 件は最初の回で通った。
