# 画面とAPI

## 画面仕様

画面は[概要](00_overview.md)の画面一覧に対応する。Next.js の静的書き出し（output: 'export'）で作るため、id をパスに埋め込む動的な URL は使わず、クエリ文字列で渡す（/stock?room=…）。UI 部品は shadcn/ui、表は TanStack Table。すべての画面で、読み込み中・データが空・権限なしの3状態を表示する。招待されていない人がログインすると「総務から招待されていません」だけを表示する。

### ダッシュボード /（PC）

- 年度のステータス、申請の提出数／団体数、在庫を数えた保管場所の数／保管場所の数、検証の error・warning の件数、キャスター机交換の了承状況
- 年度の状態を進めるボタン（管理者のみ、理由の入力欄つき）

### 在庫入力 /stock?room=…（スマホ）

- 表示：場所名、前回入力者と日時、品目ごとの行（品目名、数、前年の数）
- 操作：＋－ボタンと数字入力、「保存」。保存時に counted_by・counted_at を更新
- 場所の選び方：一覧から選ぶか、部屋に貼った QR（/stock?room=… の URL）を読む
- 状態：年度が allocating 以降なら部員は読み取り専用。管理者は数え直しを入力でき、入力すると検証をやり直す。使用不可の部屋は先頭に「今年は使用不可」と表示する（数えることはできる）

### 在庫一覧 /stocks（PC）

- 保管場所×品目の表、前年との差、まだ数えていない場所（W104）、部屋に貼る QR の印刷

### 申請 /request（スマホ）

- 表示：団体名、使用場所、締切日時、その団体の区分で申請できる品目だけの入力欄（初期値0）、備考欄（数には影響しないと明記）
- 操作：「提出」で全品目と備考を保存し、submitted_at を記録。締切前なら何度でも修正できる
- 状態：締切後は読み取り専用で「変更は総務へ」と表示。複数団体の代表なら団体を切り替える

### 申請一覧 /requests（PC）

- 表示：団体×品目の表、区分フィルタ、未提出団体の一覧、備考がある団体に印
- 操作：セルを直接編集（締切後は理由の入力を必須にして RPC で保存）、企業・休憩所の代理入力、Googleフォーム回答の取り込み（下の「CSV取り込み」）

### 振り分け /allocation（PC、中心の画面）

- 上部：「自動振り分け」「最小変更で再実行」「確定」「Excel出力」ボタン、年度ステータス、最終実行日時
- 左：品目タブ（R8 のシートと同じ並び）。各タブは運び元ごとにまとめた表（運び先、団体、数、備考、自動／手動、固定）＋場所ごとの余り
- 右：検証結果（error → warning → info の順）。クリックで該当行に移動
- 切替：「品目別」と「団体別」の表示。団体別では需要（前処理1・2を当てた後の申請。企業以外の長机(3人掛)は長机(2人掛)に、未提出の設営は固定の数に。D-05・D-07）と振り分け数（申請品目ベース）を並べて差を表示
- 行の操作：追加・数の変更・運び元の変更・削除・固定。手で変えた行は origin = manual。保存は RPC で、他の人が先に変えていたら読み直す
- 「自動振り分け」：実行前に「自動の行 N 件を置き換えます。固定・手動の行は残ります」と確認。計算は Web Worker で行い、その間は画面をロック。結果が ok: false のときは振り分けを書き換えず、reason ごとに見出しを変えて出す
  - invalid_input：「入力に誤りがあります」。inputErrors（項目とルールのコード）の一覧
  - precheck：「振り分けの前に直すものがあります」。issues（E001・E002・E005）の一覧。クリックで該当の行・ルールへ移動
  - infeasible：「解けません」。shortages（品目全体の不足 → 団体ごとの不足。groupId が null の行は品目全体）と causes（原因のルールと、需要・在庫合計）の一覧。「代替を含めても在庫が足りません」の cause は、代替先を共有する申請品目の組の不足を details の1件（itemIds の品目名を並べ、需要・在庫は組の合計）で出す。品目ごとの不足の行には混ぜない
  - solver_error：「計算できませんでした」。message（計算エンジンの読み込みの失敗か、計算中のエラーか）
- 申請できない品目の申請（E006）を除いて計算したときは、結果の上に「申請できない品目の申請 N 件を除いて計算しました」と出し、検証の E006 を示す
- 「確定」：error 0 件のときだけ押せる。確定後は編集不可。「確定を解除」は理由入力必須

### キャスター机交換 /swaps（PC）

- 置き換えが入った団体ごとに、置き換え台数と了承状況（未依頼・依頼済み・了承・拒否）を表示・更新する
- 「了承」にするとその団体の置き換え行が固定される。「拒否」にするとその団体を置き換えの対象から外し、「最小変更で再実行」が必要なことを表示する
- 交換依頼一覧（Excel）を出力する

### 自団体の振り分け /my（スマホ）

- 確定前：「振り分け作業中」と申請内容だけ表示。キャスター机への交換を依頼されていれば「了承する」「了承しない」ボタン（回答は RPC で記録）
- 確定後：品目ごとの数と運び元。代替があれば「机(木)の代わりにキャスター机」のように表示
- フェーズ2：受け取り時刻

### マスタ設定 /settings（PC）

- 年度：作成（前年度からの複製を含む）、申請の受付期間
- 場所・品目・団体：表で追加・編集。団体は CSV 取り込み可
- 距離：建物間の距離の上書き、場所ごとの追加コスト
- ユーザー：招待（メール・ロール・団体）、ロールの変更、招待の取り消し
- データの書き出し：年度データ（JSON）と振り分け表（Excel）。年度末のバックアップに使う

### ルール /rules（PC）

- 種別ごとのフォーム（団体・場所・品目は選択式）、有効／無効、メモ

### 履歴 /history（PC、管理者のみ）

- audit_logs を表・団体・日時で絞り込んで表示

### CSV取り込み（申請一覧・マスタ設定から）

- 取り込めるのは模擬店・部門・企業の3種類の Googleフォームの回答。種類ごとに列の対応表を持つ
- 模擬店フォームの団体名は「飲食模擬店を運営しますか？」の答えで2つの列に分かれるので、空でない方を使う。groups.name と aliases で対応付け、合わなかった行は一覧で示して手で対応させる
- 企業フォームは団体名が入っていない（R8 ではすべて「オプション 1」）ので、取り込み時に手で団体を選ぶ
- 同じ団体の回答が複数あるときは、タイムスタンプが一番新しいものを使い、古いものは画面に出して確認させる
- 列がずれている行（見出しのない列に値がある行）は取り込まず、一覧で示す
- 品目の列名はフォームでの表記（items.aliases）で品目に対応させる。企業以外の長机(3人掛)は長机(2人掛)に読み替える（S03）。読み替えた後は団体・品目ごとに合計して1行にする（長机(3人掛)と長机(2人掛)の両方を申請した回答で、同じ品目の行が2つにならないように）
- フォームのタイムスタンプを、その団体の提出日時（request_submissions.submitted_at）として保存する（Excel の団体別集計の「申請順」に使う）。取り込みは管理者だけの RPC で行い、DB はそのときだけ渡した日時を保つ（団体代表の提出は今までどおり DB の時刻）
- メールアドレスは、どの列にあっても（見出しのない列も含めて）パターンで見つけて捨て、保存もログ出力もしない

## DB関数とブラウザ側の処理

サーバーを持たないので、Route Handler と Server Action は使わない。読み取りと、理由の要らない書き込み（在庫入力、締切前の申請、マスタの編集）は、画面から Supabase クライアントで直接行い、RLS で守る。理由が要る書き込みと、複数の表をまとめて変える書き込みは DB 関数（RPC）で行う。重い計算とファイルの作成は管理者のブラウザで行う。

**DB関数（RPC）**

| 名前 | 呼べる人 | 動作 |
| --- | --- | --- |
| set_year_status(year_id, to, reason) | admin | 状態遷移の図に合わない遷移はエラー。confirmed へは E001・E002・E005 がないときだけ |
| create_year_from(prev_year_id, label, festival_start) | admin | 年度を作り、団体・ルール・場所の状態を複製してルールの団体 id を付け替える |
| save_auto_allocations(year_id, rows, mode) | admin | auto かつ未固定の行を入れ替え、在庫超過があれば全体を取り消す。確定中はエラー |
| save_allocation_rows(year_id, changes, reason) | admin | 行の追加・変更・削除・固定。origin = manual で保存。各行の updated_at で楽観ロック。確定中はエラー |
| update_requests_after_deadline(group_id, rows, reason) | admin | 締切後の申請修正 |
| set_consent(group_id, from_item, to_item, status, note) | admin、その団体の代表 | 了承なら該当の置き換え行を pinned にし、拒否なら pinned を外す |
| invite(year_id, email, role, group_id) | admin | 招待を作る。すでにアカウントがあればその場でロールを付ける |
| check_delivery(delivery_id, status, problem_note, returned) | admin、staff | 運搬の状態を更新（フェーズ2） |

**ブラウザ側の処理**

| 名前 | 置き場所 | 動作 |
| --- | --- | --- |
| allocate(input, solver) | packages/allocator | 振り分けの計算（Web Worker で実行。solver は Worker の中で1回だけ読み込んだ highs のインスタンス） |
| validate(data, rows) | packages/allocator | 検証コードの一覧を返す（data は年度のデータ、rows はその年度の全行） |
| exportAllocationXlsx({ yearLabel, data, rows }) | packages/exporter | R8 様式の Excel（data は年度のデータ、rows はその年度の全行。余り・計は exporter が計算する） |
| exportSwapsXlsx({ yearLabel, data, rows }) | packages/exporter | キャスター机交換依頼一覧（了承が要る代替の行と了承の状況） |
| exportYearJson(yearExport) | packages/exporter | 年度データの書き出し（バックアップ。メールアドレスは含めない） |
| parseFormCsv(kind, csv, items) | packages/importer | Googleフォーム回答の読み取り（品目の列は items の aliases で対応。メールアドレスを捨てる） |
| resolveResponses(parsed, groups, items, manual) | packages/importer | 読み取った回答を団体に対応させ、申請（読み替えの後、団体・品目ごとに1行）と提出（フォームのタイムスタンプ）を作る。合わない行・古い回答を返す |

- RPC は SECURITY DEFINER にして `search_path = ''` を設定し、関数の最初でロールを確かめる。入力はブラウザで zod、DB では関数の中でもう一度確かめる
- エラーは `raise exception` で返し、message にコード（forbidden、invalid_state、conflict、検証コードなど）を入れる。画面で日本語に直して表示する
- highs-js の wasm は振り分け画面を開いたときだけ読み込む（その画面のコンポーネントで `new Worker(new URL('…worker.ts', import.meta.url))` を作り、Worker の中で highs を読み込む）。wasm は node_modules/highs/build/highs.wasm を `apps/web/public/highs.wasm` にコピーして静的ファイルとして公開し（git には入れず .gitignore に書く）、locateFile で basePath を付けた URL（`${origin}${basePath}/highs.wasm?v=<highs の版>`）を渡す。コピーは apps/web の predev と prebuild の両方で行う（`pnpm dev` でも 404 にならないように）。basePath を付け忘れると GitHub Pages で 404 になり、`CompileError: expected magic word` で落ちる。読み込みに失敗したら、次の実行で読み直す（失敗を覚えたままにしない）。`next build --webpack` は highs.mjs の `node:module` で失敗するので使わない
