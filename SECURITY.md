# セキュリティ

## 脆弱性の知らせ方

脆弱性を見つけたら、**公開の issue・PR・ディスカッションには書かず**、GitHub の Private vulnerability reporting で知らせてください（このリポジトリの Security タブ → Report a vulnerability）。内容は管理者だけが見られます。

書いてほしいこと：

- どこに（ファイル・画面・DB 関数など）どんな問題があるか
- 再現の手順（本物の利用者のデータや個人情報は書かず、ローカルの Supabase のテストユーザーや予約済みのドメインで）
- 考えられる影響

## 対象

- このリポジトリのコード（`apps/web`・`packages/*`・`supabase/` のマイグレーション・RLS・DB 関数・`.github/workflows/`）
- 公開しているアプリ（GitHub Pages）と、アプリが使う Supabase の設定（README の手順どおりに設定したもの）

Google・Supabase・GitHub など、外部のサービスそのものの脆弱性は、それぞれの窓口に知らせてください。

## 連絡の流れ

1. 管理者（電波祭の総務の担当）が受け取り、内容を確かめて返事をする。
2. 直すまでの間は非公開のまま扱う。修正は通常の PR で入れ、本番に反映する。
3. 反映した後に、必要なら GitHub の Security Advisory として公開する。

学生が運営しているため、返事に数日かかることがあります。
