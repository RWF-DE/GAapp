-- 0018_lending.sql（T21 の前半。2026-11-01。D-57）：テント等の貸し出し（lending_items・lending_requests・lending_assignments・
-- lending_records・lending_years）の表・トリガー・RLS・RPC
-- テント等の貸し出しは総務アプリの機能の1つ（機能の id は lending。D-51・D-52）。総務が持つテント・重し・三方幕などを年度ごとに
-- 備品として登録し（lending_items）、団体の申請（lending_requests）をもとに部門長以上が割り当て（lending_assignments）、割り当てを
-- 確定して（lending_years）店長・副店長と閲覧のみに見せ、当日の受け渡しと返却を総務が記録する（lending_records）。
-- 机椅子の表（items・stocks・requests・allocations）とは別の表にする（D-57）：振り分け（allocate）の入力・検証コード・R8 の Excel・
-- 年度データの JSON・版（allocation_version）・机椅子の確定中の守り（lock_year_guard）・在庫入力には入らない。机椅子のフェーズ2の
-- slots・deliveries も変えない（テント等の数と受け渡し・返却の記録は、この5表だけに持つ）。
-- 書き込みの道（02「設計上の決めごと」）：
--   備品・申請・記録：画面から直接（RLS。理由の要らない1つの表の書き込みなので RPC にしない。監査の理由は null）。申請と記録は
--     団体ごとの upsert で、削除はしない（0 にして残す。delete の権限も与えない）
--   割り当て：RPC save_lending_assignments だけ（行ごとの楽観ロックと全部か何もの保存。理由「テント等の割り当て」）
--   割り当ての確定（印）：RPC set_lending_confirmed だけ（確定の条件の確かめ。確定は理由「テント等の割り当ての確定」、解除は理由が必須）
-- 段（D-48）：備品・割り当て・確定は部門長以上（admin・head・deputy_head。can_lead）、申請は机椅子の申請と同じ（can_write_requests：
-- 店長・副店長は受付期間内、部門長以上は準備中と締切前）、記録は総務（admin・head・deputy_head・staff。下の can_record_lending）。
-- 終了（closed）の年度は5表とも読むだけ（RLS と RPC の invalid_state。SQL Editor〔postgres〕からは書ける。お知らせ・締切と予定と同じ）。
-- 振り分けの入力でないので版を増やさず、机椅子の確定中・終了の守りも付けない（机椅子が確定中の年度も書ける）。年度の複製
-- （create_year_from）は写さない（画面の「前年度から読み込む」〔previous_year_lending_items〕で備品だけを写す）。
-- 番号はリードが割り当てた 0018。並行の T19（0016）・T20（0017）の物は使わず、どの順に流しても通る（使うのは 0015 までの物だけ）。
-- 足すだけで、今の表・関数・ポリシーは変えない。今の画面は lending_* を読まないので、流しても何も変わらない。
-- 画面（/lending・/lending/records・/request のテント等のタブ・ダッシュボード）は T21 の後半。

------------------------------------------------------------------------
-- 表
------------------------------------------------------------------------
-- 列挙型は足さない（申請できる区分は今の group_category）。
-- どの表も created_at・updated_at（set_timestamps）と監査（tg_audit。D-11）を持つ。年度・団体・備品の列は作った後に変えられない
-- （check_immutable。D-16）。数は 0〜10000、名前は 100 字、メモは 2000 字まで（D-09）。

-- 貸し出す備品（年度ごと。数だけで、個体の番号は持たない。在庫は年度ごとの総数で、部屋ごとに数えない）。
-- 名前と単位は前後の空白を除いた形（notices_title_check・events_title_check と同じ式。除く空白は JavaScript の String.prototype.trim が
-- 除く 25 文字：タブ・LF・垂直タブ・改ページ・CR・半角の空白・U+00A0・U+1680・U+2000〜U+200A・U+2028・U+2029・U+202F・U+205F・
-- 全角の空白〔U+3000〕・U+FEFF）。書き込みを RPC にしないので DB では除かず、前後に空白のある値と空白だけの値を拒む（23514。
-- unique (year_id, name) が「テント」と「テント 」を別の名前にしないため。画面は zod の trim を通してから送る）。名前は 1〜100 字、
-- 単位は 1〜10 字（既定「個」）。
-- 申請できる区分（requestable_categories）は既定が模擬店・部門（企業・休憩所は申請せず、部門長以上が割り当てに直接入れる）。
-- 区分は4つなので 4 個まで（大きな配列を入れさせない。重複と null の要素は止めない：区分の判定〔= any〕に害がなく、画面は送らない）。
-- unique (id, year_id) は申請・割り当て・記録の複合外部キーの参照先（備品が行と同じ年度であることを保証する。groups と同じ）
create table public.lending_items (
  id uuid primary key default gen_random_uuid(),
  year_id uuid not null references public.years on delete cascade,
  name text not null,
  unit text not null default '個',
  stock integer not null,
  requestable_categories public.group_category[] not null default '{stall,department}',
  sort_order integer not null default 0,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  constraint lending_items_name_check check (name <> ''
    and name = btrim(name, E'\t\n\u000b\f\r \u00a0\u1680\u2000\u2001\u2002\u2003\u2004\u2005\u2006\u2007\u2008\u2009\u200a\u2028\u2029\u202f\u205f\u3000\ufeff')
    and length(name) <= 100),
  constraint lending_items_unit_check check (unit <> ''
    and unit = btrim(unit, E'\t\n\u000b\f\r \u00a0\u1680\u2000\u2001\u2002\u2003\u2004\u2005\u2006\u2007\u2008\u2009\u200a\u2028\u2029\u202f\u205f\u3000\ufeff')
    and length(unit) <= 10),
  constraint lending_items_stock_check check (stock between 0 and 10000),
  constraint lending_items_categories_check check (cardinality(requestable_categories) <= 4),
  constraint lending_items_year_id_name_key unique (year_id, name),
  constraint lending_items_id_year_id_key unique (id, year_id)
);

-- 申請・割り当て・記録の共通の形：主キーは (group_id, lending_item_id)（団体×備品で1行）。year_id は書く人（画面・RPC）が団体の年度を
-- 入れ、複合外部キーが団体と備品が行と同じ年度であることを保証する（違えば 23503）。外部キーの on delete：
--   団体へ cascade：団体を消すと、その団体の行も消える（団体を消せるのは管理者で、机椅子の確定中・終了の年度では消せない）
--   備品へ restrict：申請・割り当て・記録のある備品は消せない（23503。画面は「申請・割り当て・記録のある備品は削除できません」）
--   年度へも cascade（判断したことの 1）：年度を消したときの連鎖（団体の削除と備品の削除）は years の after トリガーで順に処理され、
--     その順はトリガーの名前（OID）で決まる。子の行が団体からの連鎖だけで消えると、先に動いた備品の削除の restrict の確かめが、まだ
--     消えていない子の行を見て止まりうる。years から直接 cascade で消えれば、restrict の確かめ（連鎖の次の回に動く）より先に必ず
--     消えるので、年度の削除が順によらず通る
--   書いた人（updated_by）へ set null
-- updated_by はトリガー set_actor が auth.uid() を入れる（クライアントの値は使わない。seed・SQL Editor では入れた値のまま。D-10）。
-- 索引：主キーが団体からの連鎖と団体ごとの読み取りを、(lending_item_id, year_id) が備品の restrict の確かめを、year_id が年度ごとの
-- 読み取り（ダッシュボード・/lending）と年度からの連鎖を受け持つ

-- テント等の申請（団体×備品の数。0 は「借りない」。備考は持たない。受付期間は机椅子の申請と同じ）
create table public.lending_requests (
  group_id uuid not null,
  lending_item_id uuid not null,
  year_id uuid not null references public.years on delete cascade,
  count integer not null,
  updated_by uuid references auth.users on delete set null,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  primary key (group_id, lending_item_id),
  constraint lending_requests_count_check check (count between 0 and 10000),
  constraint lending_requests_group_fkey foreign key (group_id, year_id)
    references public.groups (id, year_id) on delete cascade,
  constraint lending_requests_item_fkey foreign key (lending_item_id, year_id)
    references public.lending_items (id, year_id) on delete restrict
);
create index lending_requests_year_id_idx on public.lending_requests (year_id);
create index lending_requests_item_idx on public.lending_requests (lending_item_id, year_id);

-- 割り当て（団体に貸す数。部門長以上が決める。0 は「貸さない」と決めたこと、行がなければ未入力）。RPC だけで書く。
-- どの区分の団体にも入れられ（申請できる区分は見ない）、在庫を超えても入れられる（確定で止める）
create table public.lending_assignments (
  group_id uuid not null,
  lending_item_id uuid not null,
  year_id uuid not null references public.years on delete cascade,
  count integer not null,
  updated_by uuid references auth.users on delete set null,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  primary key (group_id, lending_item_id),
  constraint lending_assignments_count_check check (count between 0 and 10000),
  constraint lending_assignments_group_fkey foreign key (group_id, year_id)
    references public.groups (id, year_id) on delete cascade,
  constraint lending_assignments_item_fkey foreign key (lending_item_id, year_id)
    references public.lending_items (id, year_id) on delete restrict
);
create index lending_assignments_year_id_idx on public.lending_assignments (year_id);
create index lending_assignments_item_idx on public.lending_assignments (lending_item_id, year_id);

-- 受け渡し・返却の記録（団体×備品。渡した数・返った数・そのうちの破損の数とメモ）。0 ≤ 破損 ≤ 返った ≤ 渡した ≤ 10000。
-- 割り当てより多く渡すことも記録できる（事実の記録は止めない。画面が確かめる）。メモは任意（空なら画面が null にする。D-33）
create table public.lending_records (
  group_id uuid not null,
  lending_item_id uuid not null,
  year_id uuid not null references public.years on delete cascade,
  lent_count integer not null default 0,
  returned_count integer not null default 0,
  damaged_count integer not null default 0,
  note text,
  updated_by uuid references auth.users on delete set null,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  primary key (group_id, lending_item_id),
  constraint lending_records_counts_check check (damaged_count >= 0 and damaged_count <= returned_count
    and returned_count <= lent_count and lent_count <= 10000),
  constraint lending_records_note_check check (length(note) <= 2000),
  constraint lending_records_group_fkey foreign key (group_id, year_id)
    references public.groups (id, year_id) on delete cascade,
  constraint lending_records_item_fkey foreign key (lending_item_id, year_id)
    references public.lending_items (id, year_id) on delete restrict
);
create index lending_records_year_id_idx on public.lending_records (year_id);
create index lending_records_item_idx on public.lending_records (lending_item_id, year_id);

-- 割り当ての確定（年度ごとに1行まで。行がないか confirmed_at が null なら確定前）。RPC だけで書く。
-- 解除しても行は消さず、confirmed_at・confirmed_by を null にする（判断したことの 4。履歴では同じ行の変更として、理由つきで並ぶ）。
-- 年度の状態（years.status の confirmed。机椅子の確定）とは別のもの。confirmed_by は confirmed_at があるときだけ持てる
create table public.lending_years (
  year_id uuid primary key references public.years on delete cascade,
  confirmed_at timestamptz,
  confirmed_by uuid references auth.users on delete set null,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  constraint lending_years_confirmed_check check (confirmed_at is not null or confirmed_by is null)
);

alter table public.lending_items enable row level security;
alter table public.lending_requests enable row level security;
alter table public.lending_assignments enable row level security;
alter table public.lending_records enable row level security;
alter table public.lending_years enable row level security;

------------------------------------------------------------------------
-- 年度ごとのロック
------------------------------------------------------------------------
-- 割り当ての保存（save_lending_assignments）・確定と解除（set_lending_confirmed）・確定中の在庫の守り（guard_stock）を、年度ごとの
-- 勧告的ロック（排他。int4 の鍵2つ。トランザクションの終わりまで持つ）で順に処理する。確定の確かめ（在庫超過・未入力）と、割り当ての
-- 保存・在庫を減らす書き込みが重なって、確定中に割り当て合計が在庫を超える状態を作らないため。年度が違えば待たない。
-- years の行はロックしない（lock_year・lock_year_guard も for share・for update も使わない）：机椅子の版・確定の RPC・在庫の保存・
-- 提出の lock_year_guard とぶつけず、長い振り分けの保存の後ろでテント等の書き込みを待たせないため（0013 の lock_year_member と同じ
-- 考え）。申請と記録の直接の書き込みはロックを取らない（記録は確定の条件に入らない。申請は未入力の確かめに入るが、確定できるのは
-- 締切の後で、そのときはだれも申請を直接書けない〔can_write_requests〕。締切を延ばして確定の後に申請が変わっても、割り当ては変わらない）。
-- 表を読まないので SECURITY DEFINER にしない。誰にも execute を与えない（DEFINER の RPC とトリガーの中からだけ呼ぶ）。VOLATILE
-- （既定のまま）：呼ぶ側はロックを取る文と、その後に読む文を分ける（READ COMMITTED では、ロックを待った後の文が新しいスナップショットで
-- 待っている間に確定した行を読む）。
-- デッドロックにならない順：備品の行 → この勧告的ロック → 割り当て・確定の行。在庫の守り（guard_stock）は BEFORE のトリガーなので、
-- 備品の行のロックを持ったままこのロックを待つ。画面の備品の編集は名前（unique (year_id, name) の列）も書き直すことがあり、そのときの
-- 行のロックは FOR UPDATE になって、外部キーの確かめの FOR KEY SHARE ともぶつかる。そこで save_lending_assignments は、このロックの
-- 前にその年度の備品の行を FOR KEY SHARE で取っておく（割り当ての insert の外部キーの確かめで、このロックを持ったまま備品の行を
-- 待たない）。set_lending_confirmed は備品の行を読むだけ（ロックを取らない）なので、待たない
create function private.lock_lending_year(p_year_id uuid)
returns void language sql set search_path = '' as $$
  select pg_advisory_xact_lock(hashtext('gaapp.lending'), hashtext(p_year_id::text))
$$;

------------------------------------------------------------------------
-- トリガー
------------------------------------------------------------------------
-- BEFORE ROW のトリガーは名前の順に動く：check_immutable（年度・団体・備品の付け替えを invalid_input で止める）→ check_requestable
-- （申請）・guard_stock（備品）→ set_actor → set_timestamps。版の増分（bump_version_*）と、机椅子の確定中・終了の守り
-- （lock_year_guard）は付けない（振り分けの入力でない。終了の年度の読み取り専用は、下の書き込みのポリシーと RPC が守る）。

-- 日時（0002 の共通の関数）
create trigger set_timestamps before insert or update on public.lending_items
  for each row execute function private.tg_set_timestamps();
create trigger set_timestamps before insert or update on public.lending_requests
  for each row execute function private.tg_set_timestamps();
create trigger set_timestamps before insert or update on public.lending_assignments
  for each row execute function private.tg_set_timestamps();
create trigger set_timestamps before insert or update on public.lending_records
  for each row execute function private.tg_set_timestamps();
create trigger set_timestamps before insert or update on public.lending_years
  for each row execute function private.tg_set_timestamps();

-- 監査（D-11。0002 の tg_audit。year_id は行から、group_id は申請・割り当て・記録の団体〔備品・確定の印は null〕。理由は、直接の
-- 書き込み〔備品・申請・記録〕は null、割り当ては「テント等の割り当て」、確定は「テント等の割り当ての確定」、解除は入れた理由）
create trigger audit after insert or update or delete on public.lending_items
  for each row execute function private.tg_audit('id');
create trigger audit after insert or update or delete on public.lending_requests
  for each row execute function private.tg_audit('group_id,lending_item_id');
create trigger audit after insert or update or delete on public.lending_assignments
  for each row execute function private.tg_audit('group_id,lending_item_id');
create trigger audit after insert or update or delete on public.lending_records
  for each row execute function private.tg_audit('group_id,lending_item_id');
create trigger audit after insert or update or delete on public.lending_years
  for each row execute function private.tg_audit('year_id');

-- 年度・団体・備品の付け替えを止める（D-16。0002 の tg_immutable_columns〔0004 で DEFINER〕。invalid_input）。申請・割り当て・記録は
-- 鍵の列が全部変えられないので、行は足すか消すだけ（upsert で同じ値を書き直すのは通る。値で比べる）
create trigger check_immutable before update of year_id on public.lending_items
  for each row execute function private.tg_immutable_columns('year_id');
create trigger check_immutable before update of group_id, lending_item_id, year_id on public.lending_requests
  for each row execute function private.tg_immutable_columns('group_id', 'lending_item_id', 'year_id');
create trigger check_immutable before update of group_id, lending_item_id, year_id on public.lending_assignments
  for each row execute function private.tg_immutable_columns('group_id', 'lending_item_id', 'year_id');
create trigger check_immutable before update of group_id, lending_item_id, year_id on public.lending_records
  for each row execute function private.tg_immutable_columns('group_id', 'lending_item_id', 'year_id');
create trigger check_immutable before update of year_id on public.lending_years
  for each row execute function private.tg_immutable_columns('year_id');

-- 書いた人：ログインしている人の書き込み（RPC の中も）では DB が auth.uid() を入れる（クライアントの値は使わない）。seed・SQL Editor
-- （auth.uid() が null）では入れた値のまま（D-10。0014・0015 の set_actor と同じ中身で、created_by はない）。関数は表ごとの名前にする
-- （T18 の判断の 4：表ごとに変えるときに、ほかの表を巻き込まない）。直接の書き込みでは authenticated で動くが、auth.uid() を読むだけで
-- private.fail を呼ばないので INVOKER でよい（トリガー関数の実行は execute の権限を見ない）
create function private.tg_lending_requests_set_actor()
returns trigger language plpgsql set search_path = '' as $$
begin
  if auth.uid() is not null then
    new.updated_by := auth.uid();
  end if;
  return new;
end $$;
create trigger set_actor before insert or update on public.lending_requests
  for each row execute function private.tg_lending_requests_set_actor();

create function private.tg_lending_assignments_set_actor()
returns trigger language plpgsql set search_path = '' as $$
begin
  if auth.uid() is not null then
    new.updated_by := auth.uid();
  end if;
  return new;
end $$;
create trigger set_actor before insert or update on public.lending_assignments
  for each row execute function private.tg_lending_assignments_set_actor();

create function private.tg_lending_records_set_actor()
returns trigger language plpgsql set search_path = '' as $$
begin
  if auth.uid() is not null then
    new.updated_by := auth.uid();
  end if;
  return new;
end $$;
create trigger set_actor before insert or update on public.lending_records
  for each row execute function private.tg_lending_records_set_actor();

-- 申請できる区分：数が1以上なのに、団体の区分が備品の requestable_categories にないと invalid_input（field: lending_item_id、
-- reason: not_requestable）。他の表を参照する CHECK は使わない決まりなので、トリガーで確かめる。机椅子の check_requestable（E006）と
-- 違って例外の品目はない。0 は通す（「借りない」。区分で申請できなくなった備品を 0 に直せる）。
-- 最初に、書いている人がこの表に書けるかをポリシー（lending_requests_insert・lending_requests_update）と同じ条件で確かめ、書けない人
-- （anon・authenticated で、ポリシーが拒否する人）には区分を確かめずに new を返して、拒否を RLS に任せる（判断したことの 8。書けない人に
-- 備品の区分を漏らさず、011 の権限表のセルは 42501 になる。0004 の守りのトリガーと同じ決まり）。postgres（RLS を通らない）は確かめる。
-- 団体・備品は行の年度で引き、見つからなければ（ない・年度が違う）外部キーのエラー（23503）に任せる。
-- 団体と備品の区分を RLS を通さずに読み、private.fail を呼ぶので SECURITY DEFINER
create function private.tg_lending_requests_check_requestable()
returns trigger language plpgsql security definer set search_path = '' as $$
declare
  v_category public.group_category;
  v_categories public.group_category[];
begin
  if private.rls_applies() and not private.can_write_requests(new.group_id) then
    return new;
  end if;
  if new.count is null or new.count <= 0 then        -- null・負の数は NOT NULL・CHECK の制約に任せる
    return new;
  end if;
  select g.category into v_category from public.groups g where g.id = new.group_id and g.year_id = new.year_id;
  select li.requestable_categories into v_categories from public.lending_items li
  where li.id = new.lending_item_id and li.year_id = new.year_id;
  if v_category is null or v_categories is null then
    return new;
  end if;
  if v_category = any (v_categories) then
    return new;
  end if;
  perform private.fail('invalid_input', jsonb_build_object('field', 'lending_item_id', 'reason', 'not_requestable',
    'group_id', new.group_id, 'lending_item_id', new.lending_item_id));
  return null;
end $$;
create trigger check_requestable before insert or update of group_id, lending_item_id, count on public.lending_requests
  for each row execute function private.tg_lending_requests_check_requestable();

-- 確定中の在庫の守り：割り当ての確定中（lending_years の confirmed_at が null でない）は、在庫をその備品の割り当て合計より少なく
-- できない（invalid_state。detail は reason: confirmed と備品・割り当て合計・新しい在庫。画面は「割り当ての確定中は、在庫を割り当ての
-- 合計（N）より少なくできません」）。確定は在庫超過のないときだけなので、確定の後に在庫を減らす書き込みだけを見ればよい。
-- 最初に書けるか（lending_items_update と同じ can_lead）を確かめ、書けない人には何もしない（ロックを取らずに拒否を RLS に任せる）。
-- 在庫を減らすときだけ年度の勧告的ロックを取ってから確定の印を読む（set_lending_confirmed の在庫超過の確かめと順にする。増やす・
-- 変えないときはロックも確かめもしない）。割り当て合計より少なくするときは、確定を解除して割り当てを直してから減らす。
-- 確定の印と割り当てを RLS を通さずに読み、private.fail を呼ぶので SECURITY DEFINER
create function private.tg_lending_items_guard_stock()
returns trigger language plpgsql security definer set search_path = '' as $$
declare v_assigned bigint;
begin
  if private.rls_applies() and not private.can_lead(old.year_id) then
    return new;
  end if;
  if new.stock is null or new.stock >= old.stock then      -- null は NOT NULL の制約に任せる
    return new;
  end if;
  perform private.lock_lending_year(old.year_id);
  if exists (select 1 from public.lending_years ly where ly.year_id = old.year_id and ly.confirmed_at is not null) then
    select coalesce(sum(a.count), 0) into v_assigned from public.lending_assignments a
    where a.lending_item_id = old.id and a.year_id = old.year_id;
    if new.stock < v_assigned then
      perform private.fail('invalid_state', jsonb_build_object('reason', 'confirmed', 'lending_item_id', old.id,
        'assigned', v_assigned, 'stock', new.stock));
    end if;
  end if;
  return new;
end $$;
create trigger guard_stock before update of stock on public.lending_items
  for each row execute function private.tg_lending_items_guard_stock();

------------------------------------------------------------------------
-- 読み取り（RLS）
------------------------------------------------------------------------
-- select のポリシーは D-47 の形（呼んだ人の年度・団体の集合を問い合わせごとに1回だけ作り、行の列を判定関数に渡さない）。集合の関数は
-- 0010 の my_role_year_ids・my_group_ids、0014 の my_group_year_ids と、下の lending_confirmed_year_ids。
-- 読み取りは年度の状態によらない（終了の年度も読める）。「その年度」は行の年度、「確定後」はその年度の割り当てを確定している
-- （lending_years の confirmed_at が null でない）とき。RLS は列を隠せないので、読める行の在庫・updated_by・confirmed_by（uuid）は
-- 店長・副店長と閲覧のみにも見える（判断したことの 11。名前〔profiles〕は can_see_profile で読めない。画面は出さない）。

-- 呼んだ人がロールか団体代表を持つ年度のうち、割り当てを確定したもの（集合の関数。0010 と同じく SECURITY DEFINER・
-- search_path = ''・STABLE で、呼んだ人〔auth.uid()〕についてだけ答え、利用者の引数を取らない）。割り当てのポリシーから
-- lending_years を読むので、RLS を通らない DEFINER の関数で読む（ポリシーの中で RLS のある表を読み合わない）。execute は authenticated だけ
create function private.lending_confirmed_year_ids()
returns setof uuid language sql stable security definer set search_path = '' as $$
  select ly.year_id from public.lending_years ly
  where ly.confirmed_at is not null
    and (ly.year_id in (select yr.year_id from public.year_roles yr where yr.user_id = (select auth.uid()))
         or ly.year_id in (select g.year_id from public.group_members gm join public.groups g on g.id = gm.group_id
                           where gm.user_id = (select auth.uid())))
$$;

-- 備品と確定の印：総務と閲覧のみはその年度、店長・副店長は代表である年度（申請のタブで備品を出し、確定を知るため）
create policy lending_items_select on public.lending_items for select to authenticated
  using (year_id in (select private.my_role_year_ids('{admin,head,deputy_head,staff,viewer}'))
         or year_id in (select private.my_group_year_ids()));
create policy lending_years_select on public.lending_years for select to authenticated
  using (year_id in (select private.my_role_year_ids('{admin,head,deputy_head,staff,viewer}'))
         or year_id in (select private.my_group_year_ids()));

-- 申請と記録：総務はその年度の全部、店長・副店長は自団体の行。閲覧のみは読めない（D-57。確定後の割り当てと備品だけを見せる）
create policy lending_requests_select on public.lending_requests for select to authenticated
  using (year_id in (select private.my_role_year_ids('{admin,head,deputy_head,staff}'))
         or group_id in (select private.my_group_ids()));
create policy lending_records_select on public.lending_records for select to authenticated
  using (year_id in (select private.my_role_year_ids('{admin,head,deputy_head,staff}'))
         or group_id in (select private.my_group_ids()));

-- 割り当て：総務はその年度の全部（確定の前も）。閲覧のみはその年度の、店長・副店長は自団体の、どちらも確定後だけ（机椅子の確定後の
-- 振り分け表と同じ考え。Q1・D-39）。解除すると、また見えなくなる
create policy lending_assignments_select on public.lending_assignments for select to authenticated
  using (year_id in (select private.my_role_year_ids('{admin,head,deputy_head,staff}'))
         or (year_id in (select private.lending_confirmed_year_ids())
             and (year_id in (select private.my_role_year_ids('{viewer}'))
                  or group_id in (select private.my_group_ids()))));

------------------------------------------------------------------------
-- 書き込み（RLS。直接）
------------------------------------------------------------------------
-- 書き込みのポリシーは行ごとの形のまま（D-47。書き込む数行にしか判定関数を呼ばない）。update は using と with check に同じ述語を
-- 書く（年度・団体・備品は check_immutable で変えられない）。書けない人の insert（upsert を含む）は 42501、update はエラーにならず
-- 0 行（画面は読み直して分ける）。申請と記録には delete のポリシーも権限もない（0 にして残す。判断したことの 9。団体・年度の削除の
-- 連鎖では消える）。割り当てと確定の印には書き込みのポリシーも権限もない（RPC だけ）。

-- 記録を書ける：その年度の総務（admin・head・deputy_head・staff）で、年度が closed でない（0003 の判定関数と同じく SECURITY DEFINER・
-- search_path = ''・STABLE で、呼んだ人についてだけ答える。execute は authenticated だけ）。確定の前でも書ける（当日の事実の記録を
-- 止めない。D-57）
create function private.can_record_lending(p_year_id uuid)
returns boolean language sql stable security definer set search_path = '' as $$
  select exists (
    select 1 from public.year_roles yr join public.years y on y.id = yr.year_id
    where yr.year_id = p_year_id and yr.user_id = (select auth.uid())
      and yr.role in ('admin', 'head', 'deputy_head', 'staff') and y.status <> 'closed')
$$;

-- 備品：その年度の部門長以上で、年度が closed でない（0013 の can_lead。events・room_years と同じ）
create policy lending_items_insert on public.lending_items for insert to authenticated
  with check (private.can_lead(year_id));
create policy lending_items_update on public.lending_items for update to authenticated
  using (private.can_lead(year_id)) with check (private.can_lead(year_id));
create policy lending_items_delete on public.lending_items for delete to authenticated
  using (private.can_lead(year_id));

-- 申請：机椅子の申請と同じ（0013 の can_write_requests：店長・副店長は自団体で受付期間内、部門長以上は準備中と締切前）
create policy lending_requests_insert on public.lending_requests for insert to authenticated
  with check (private.can_write_requests(group_id));
create policy lending_requests_update on public.lending_requests for update to authenticated
  using (private.can_write_requests(group_id)) with check (private.can_write_requests(group_id));

-- 記録：その年度の総務で、年度が closed でない
create policy lending_records_insert on public.lending_records for insert to authenticated
  with check (private.can_record_lending(year_id));
create policy lending_records_update on public.lending_records for update to authenticated
  using (private.can_record_lending(year_id)) with check (private.can_record_lending(year_id));

------------------------------------------------------------------------
-- 書き込み（RPC）
------------------------------------------------------------------------
-- どれも SECURITY DEFINER・search_path = ''。最初にその年度の部門長以上かを確かめる（年度がない・p_year_id が null も forbidden）。
-- エラーは今のコードだけを使う（新しいコードは足さない）。関数の中で起きた 22xxx・CHECK 違反・外部キーの違反は invalid_input などに
-- 読み替え、生の SQLSTATE を返さない（D-19）。

-- save_lending_assignments：テント等の割り当てを1回で保存する（全部か何も。どこかで止まれば全体を取り消す）。
-- p_changes：1〜1000 件の配列。1件は { "groupId": uuid, "itemId": uuid, "count": 0〜10000 の整数 | null, "updatedAt": 日時の文字列 | null }
-- （4つのキーを見る。ほかのキーは見ない）。count が null なら行を消す（未入力に戻す。判断したことの 5）。updatedAt は、行があれば
-- 読んだときの updated_at の文字列（受け取ったまま）、なければ null。
-- エラーの順番（029 の pgTAP はこの順で確かめる）：
--   1. forbidden：その年度の部門長以上でない。勧告的ロックの前に確かめ、取った後にもう一度確かめる（待っている間に外されたとき）
--   2. invalid_state：年度が終了（detail { status: 'closed' }）→ 割り当ての確定中（{ reason: 'confirmed' }）
--   3. invalid_input：p_changes が配列でない・0 件・1000 件を超える（{ field: 'changes' }）→ 要素の形が違う（{ field: 'changes',
--      reason: 'shape' }：オブジェクトでない、groupId・itemId が uuid の文字列でない、count のキーがないか 0〜10000 の整数・null で
--      ない、updatedAt のキーがないかオフセットつきの ISO 8601 の日時の文字列〔'now'・'infinity' などの特別な値と、セッションの
--      タイムゾーンで読まれる値を通さない。update_requests_after_deadline の submittedAt と同じ〕・null でない）→ 同じ団体・備品が
--      2回（{ field: 'changes', reason: 'duplicate' }）→ その年度にない団体（{ field: 'groupId', reason: 'not_in_year', group_id }。
--      changes の順で最初の1つ）→ その年度にない備品（{ field: 'itemId', reason: 'not_in_year', lending_item_id }）
--   4. conflict：changes の順に行を for update で読み、行があるのに updatedAt が null、行がないのに updatedAt がある、updatedAt が
--      行の updated_at とミリ秒までで違う（date_trunc('milliseconds', …)）のどれか（detail { group_id, lending_item_id }。最初の1つ）
--   5. 理由「テント等の割り当て」を置き、changes の順に書く：count が数なら insert か update（同じ数でも書く。updated_at が進み、
--      ほかの人が読んだ版は conflict になる）、null なら delete（行がなく updatedAt も null なら何もしない）
-- 在庫を超えても保存できる（確定で止める）。区分で申請できない団体（企業・休憩所など）にも入れられる。
-- 例外の読み替え：確かめた後に団体・備品が消えた外部キーの違反は invalid_input（{ field: 'changes', reason: 'not_in_year' }）、
-- 行が同時に足された一意の違反（postgres の直接の書き込みとだけ起きうる）は conflict、ほかの 22xxx・CHECK 違反は invalid_input
-- （{ field: 'changes' }）。
-- 返り値：changes の順の配列 [{ "groupId", "itemId", "count", "updatedAt" }]（消した行・何もしなかった行は count と updatedAt が
-- null。updatedAt は行の updated_at の文字列）。画面は返った updatedAt を次の保存の版にする。応答が届かなければ、行を読み直して入力と
-- 同じなら保存されていたとする（04 の (B1)。行は団体と備品が主キーなので、送り直しても二重にならない）
create function public.save_lending_assignments(p_year_id uuid, p_changes jsonb)
returns jsonb language plpgsql security definer set search_path = '' as $$
declare
  v_status public.year_status;
  v_n integer;
  v_groups uuid[];
  v_items uuid[];
  v_counts integer[];
  v_versions timestamptz[];
  v_exists boolean[] := '{}';
  v_row public.lending_assignments;
  v_bad uuid;
  v_group_id uuid;                                   -- 書いている行（例外の読み替えで使う）
  v_item_id uuid;
  v_out jsonb := '[]';
begin
  -- 1. 段（ロックの前と後）。ロックの前に、その年度の備品の行を FOR KEY SHARE で取る（上の「年度ごとのロック」のデッドロックに
  --    ならない順。在庫の更新〔FOR NO KEY UPDATE〕とはぶつからず、名前も書き直す編集〔FOR UPDATE〕と備品の削除はこの保存の後に回る）
  perform private.assert_role(p_year_id, '{admin,head,deputy_head}');
  perform 1 from public.lending_items li where li.year_id = p_year_id order by li.id for key share;
  perform private.lock_lending_year(p_year_id);
  perform private.assert_role(p_year_id, '{admin,head,deputy_head}');

  -- 2. 状態（年度の行はロックしない）
  select y.status into v_status from public.years y where y.id = p_year_id;
  if v_status = 'closed' then
    perform private.fail('invalid_state', jsonb_build_object('status', 'closed'));
  end if;
  if exists (select 1 from public.lending_years ly where ly.year_id = p_year_id and ly.confirmed_at is not null) then
    perform private.fail('invalid_state', jsonb_build_object('reason', 'confirmed'));
  end if;

  -- 3. 入力：数 → 形 → 重複 → 年度
  if p_changes is null or jsonb_typeof(p_changes) <> 'array' or jsonb_array_length(p_changes) not between 1 and 1000 then
    perform private.fail('invalid_input', jsonb_build_object('field', 'changes'));
  end if;
  v_n := jsonb_array_length(p_changes);
  -- 形は先にキーの型と日時の書き方を見て、変換（uuid・整数・日時）は1つの文で行う（要素ごとに副トランザクションを作らない）
  if exists (select 1 from jsonb_array_elements(p_changes) as e(v)
             where jsonb_typeof(e.v) <> 'object'
                or jsonb_typeof(e.v -> 'groupId') is distinct from 'string'
                or jsonb_typeof(e.v -> 'itemId') is distinct from 'string'
                or coalesce(jsonb_typeof(e.v -> 'count'), '') not in ('number', 'null')
                or coalesce(jsonb_typeof(e.v -> 'updatedAt'), '') not in ('string', 'null')
                or (jsonb_typeof(e.v -> 'updatedAt') = 'string' and (e.v ->> 'updatedAt')
                    !~ '^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}(:\d{2}(\.\d+)?)?(Z|[+-]\d{2}(:?\d{2})?)$')) then
    perform private.fail('invalid_input', jsonb_build_object('field', 'changes', 'reason', 'shape'));
  end if;
  begin
    select array_agg((e.v ->> 'groupId')::uuid order by e.ord), array_agg((e.v ->> 'itemId')::uuid order by e.ord),
           array_agg((e.v ->> 'count')::integer order by e.ord), array_agg((e.v ->> 'updatedAt')::timestamptz order by e.ord)
    into v_groups, v_items, v_counts, v_versions
    from jsonb_array_elements(p_changes) with ordinality as e(v, ord);
  exception when data_exception then                 -- 22xxx（uuid・整数〔小数・指数・範囲外〕・日時〔ない日付〕の形の誤り）
    perform private.fail('invalid_input', jsonb_build_object('field', 'changes', 'reason', 'shape'));
  end;
  if exists (select 1 from unnest(v_counts) as t(n) where t.n not between 0 and 10000) then
    perform private.fail('invalid_input', jsonb_build_object('field', 'changes', 'reason', 'shape'));
  end if;
  if (select count(distinct (t.group_id, t.item_id)) from unnest(v_groups, v_items) as t(group_id, item_id)) <> v_n then
    perform private.fail('invalid_input', jsonb_build_object('field', 'changes', 'reason', 'duplicate'));
  end if;
  select t.group_id into v_bad from unnest(v_groups) with ordinality as t(group_id, ord)
  where not exists (select 1 from public.groups g where g.id = t.group_id and g.year_id = p_year_id)
  order by t.ord limit 1;
  if v_bad is not null then
    perform private.fail('invalid_input', jsonb_build_object('field', 'groupId', 'reason', 'not_in_year', 'group_id', v_bad));
  end if;
  select t.item_id into v_bad from unnest(v_items) with ordinality as t(item_id, ord)
  where not exists (select 1 from public.lending_items li where li.id = t.item_id and li.year_id = p_year_id)
  order by t.ord limit 1;
  if v_bad is not null then
    perform private.fail('invalid_input', jsonb_build_object('field', 'itemId', 'reason', 'not_in_year', 'lending_item_id', v_bad));
  end if;

  -- 4. 楽観ロック（changes の順に行をロックして比べる。どれかが違えば何も書かない）
  for i in 1 .. v_n loop
    select * into v_row from public.lending_assignments a
    where a.group_id = v_groups[i] and a.lending_item_id = v_items[i]
    for update;
    v_exists := v_exists || found;
    if (v_exists[i] and (v_versions[i] is null
                         or date_trunc('milliseconds', v_row.updated_at) <> date_trunc('milliseconds', v_versions[i])))
       or (not v_exists[i] and v_versions[i] is not null) then
      perform private.fail('conflict', jsonb_build_object('group_id', v_groups[i], 'lending_item_id', v_items[i]));
    end if;
  end loop;

  -- 5. 理由を置いて、changes の順に書く
  perform private.set_reason('テント等の割り当て');
  for i in 1 .. v_n loop
    v_group_id := v_groups[i];
    v_item_id := v_items[i];
    if v_counts[i] is null then
      if v_exists[i] then
        delete from public.lending_assignments a where a.group_id = v_group_id and a.lending_item_id = v_item_id;
      end if;
      v_out := v_out || jsonb_build_object('groupId', v_group_id, 'itemId', v_item_id, 'count', null, 'updatedAt', null);
    else
      if v_exists[i] then
        update public.lending_assignments a set count = v_counts[i]
        where a.group_id = v_group_id and a.lending_item_id = v_item_id
        returning * into v_row;
      else
        insert into public.lending_assignments (group_id, lending_item_id, year_id, count)
        values (v_group_id, v_item_id, p_year_id, v_counts[i])
        returning * into v_row;
      end if;
      v_out := v_out || jsonb_build_object('groupId', v_row.group_id, 'itemId', v_row.lending_item_id,
                                           'count', v_row.count, 'updatedAt', v_row.updated_at);
    end if;
  end loop;
  return v_out;
exception
  when foreign_key_violation then                    -- 確かめた後に団体・備品が消えた（管理者の団体の削除などと重なった）
    perform private.fail('invalid_input', jsonb_build_object('field', 'changes', 'reason', 'not_in_year'));
  when unique_violation then                         -- 確かめた後に同じ行が足された（RPC どうしは勧告的ロックで順になる）
    perform private.fail('conflict', jsonb_build_object('group_id', v_group_id, 'lending_item_id', v_item_id));
  when data_exception or check_violation then        -- 上で確かめきれなかった形の誤り（22xxx）と CHECK 違反（23514）
    perform private.fail('invalid_input', jsonb_build_object('field', 'changes'));
end $$;

-- set_lending_confirmed：テント等の割り当てを確定する（p_confirmed が true）か、確定を解除する（false）。年度の状態（years.status）は
-- 変えない。確定すると、店長・副店長（自団体）と閲覧のみに割り当てが見える（上の lending_assignments_select）。
-- エラーの順番（029 の pgTAP はこの順で確かめる）：
--   1. forbidden：その年度の部門長以上でない。勧告的ロックの前と後に確かめる
--   2. invalid_state：年度が終了（{ status: 'closed' }）
--   3. invalid_input：p_confirmed が null（{ field: 'confirmed' }）
--   4. invalid_state：今と同じ状態（{ reason: 'unchanged', confirmed: 今の状態 }。確定中の確定・確定前の解除。画面は読み直す）
--   5. 解除だけ：理由が空なら reason_required、500 字を超えれば invalid_input（{ field: 'reason' }。private.set_reason の確かめ）
--   6. 確定だけ：締切の前（{ reason: 'before_deadline' }）→ 在庫超過（{ reason: 'over_stock', lending_item_ids }）→ 未入力
--      （{ reason: 'unassigned', lending_item_ids }）。lending_item_ids は該当する備品の id を備品の並び（sort_order → 名前〔コード
--      ポイントの順。packages/shared の compareStrings と同じ〕→ id）で
--   7. 書く：確定は lending_years の行を作るか直して confirmed_at = now()・confirmed_by = auth.uid()（理由は決まった文「テント等の
--      割り当ての確定」。p_reason は使わない。判断したことの 10）。解除は confirmed_at・confirmed_by を null にする（行は残す。理由は
--      p_reason）
-- 締切の後（判断したことの 6）：年度が受付中で締切（request_close_at）があって now() 以降、または振り分け中・確定。準備中は締切の
-- 日時を過ぎていても前（受付を始めていない）。終了は 2 の invalid_state。机椅子の「締切後」と同じ読み方。
-- 在庫超過：備品ごとの割り当て合計 > 在庫（未入力の組は数えない。判断したことの 7）。未入力：申請の数が1以上なのに、その団体・
-- 備品の割り当ての行がない組（0 の割り当ては「貸さない」と決めたので未入力でない）。
-- 返り値は lending_years の行（解除の後は confirmed_at が null）。応答が届かなければ、画面は確定の印を読み直して、頼んだ状態に
-- なっていれば成功と同じに扱う（04 の (B1)）
create function public.set_lending_confirmed(p_year_id uuid, p_confirmed boolean, p_reason text default null)
returns public.lending_years language plpgsql security definer set search_path = '' as $$
declare
  v_year public.years;
  v_row public.lending_years;
  v_confirmed boolean;
  v_ids jsonb;
begin
  -- 1. 段（ロックの前と後）
  perform private.assert_role(p_year_id, '{admin,head,deputy_head}');
  perform private.lock_lending_year(p_year_id);
  perform private.assert_role(p_year_id, '{admin,head,deputy_head}');

  -- 2. 状態（年度の行はロックしない）
  select * into v_year from public.years y where y.id = p_year_id;
  if not found then
    perform private.fail('forbidden');               -- 待っている間に年度ごと消えた（ロールも消えている）
  end if;
  if v_year.status = 'closed' then
    perform private.fail('invalid_state', jsonb_build_object('status', 'closed'));
  end if;

  -- 3. 入力
  if p_confirmed is null then
    perform private.fail('invalid_input', jsonb_build_object('field', 'confirmed'));
  end if;

  -- 4. 今と同じ状態
  select * into v_row from public.lending_years ly where ly.year_id = p_year_id for update;
  v_confirmed := found and v_row.confirmed_at is not null;
  if p_confirmed = v_confirmed then
    perform private.fail('invalid_state', jsonb_build_object('reason', 'unchanged', 'confirmed', v_confirmed));
  end if;

  -- 5. 解除
  if not p_confirmed then
    perform private.set_reason(p_reason, true);
    update public.lending_years ly set confirmed_at = null, confirmed_by = null
    where ly.year_id = p_year_id
    returning * into v_row;
    return v_row;
  end if;

  -- 6. 確定の条件：締切の後 → 在庫超過 → 未入力
  if not (v_year.status in ('allocating', 'confirmed')
          or (v_year.status = 'requesting' and v_year.request_close_at is not null and now() >= v_year.request_close_at)) then
    perform private.fail('invalid_state', jsonb_build_object('reason', 'before_deadline'));
  end if;
  select jsonb_agg(li.id order by li.sort_order, li.name collate "C", li.id) into v_ids
  from public.lending_items li
  where li.year_id = p_year_id
    and li.stock < (select coalesce(sum(a.count), 0) from public.lending_assignments a
                    where a.lending_item_id = li.id and a.year_id = p_year_id);
  if v_ids is not null then
    perform private.fail('invalid_state', jsonb_build_object('reason', 'over_stock', 'lending_item_ids', v_ids));
  end if;
  select jsonb_agg(li.id order by li.sort_order, li.name collate "C", li.id) into v_ids
  from public.lending_items li
  where li.year_id = p_year_id
    and exists (select 1 from public.lending_requests r
                where r.lending_item_id = li.id and r.year_id = p_year_id and r.count >= 1
                  and not exists (select 1 from public.lending_assignments a
                                  where a.group_id = r.group_id and a.lending_item_id = r.lending_item_id));
  if v_ids is not null then
    perform private.fail('invalid_state', jsonb_build_object('reason', 'unassigned', 'lending_item_ids', v_ids));
  end if;

  -- 7. 確定
  perform private.set_reason('テント等の割り当ての確定');
  insert into public.lending_years (year_id, confirmed_at, confirmed_by)
  values (p_year_id, now(), auth.uid())
  on conflict (year_id) do update set confirmed_at = excluded.confirmed_at, confirmed_by = excluded.confirmed_by
  returning * into v_row;
  return v_row;
end $$;

-- previous_year_lending_items：前年度（年度の prev_year_id。複製元）のテント等の備品（名前・単位・在庫・申請できる区分・並び）を、
-- 並び → 名前（コードポイントの順）→ id の順に返す。読み取りだけ（画面の「前年度から読み込む」が確かめのダイアログに出し、画面が
-- 作った id で1回の insert で入れる。判断したことの 13）。呼べるのは、その年度の部門長以上（でなければ forbidden）。前年度がなければ
-- 0 行。年度の状態によらない（previous_year_stocks・previous_year_requests と同じ。前年度のロールは要らない）
create function public.previous_year_lending_items(p_year_id uuid)
returns table (name text, unit text, stock integer, requestable_categories public.group_category[], sort_order integer)
language plpgsql stable security definer set search_path = '' as $$
begin
  perform private.assert_role(p_year_id, '{admin,head,deputy_head}');
  return query
    select li.name, li.unit, li.stock, li.requestable_categories, li.sort_order
    from public.years y join public.lending_items li on li.year_id = y.prev_year_id
    where y.id = p_year_id
    order by li.sort_order, li.name collate "C", li.id;
end $$;

------------------------------------------------------------------------
-- 権限
------------------------------------------------------------------------
-- 表：5表とも、先に Supabase の既定の権限（public スキーマの新しい表に anon・authenticated の全部）を外してから、authenticated に
-- select（02 の権限表）。書き込みの権限は、直接書く表だけ：備品に insert・update・delete、申請と記録に insert・update（削除はしない）。
-- 割り当てと確定の印は select だけ（RPC でだけ書く表）。truncate・references・trigger は与えない。anon と PUBLIC には何も与えない
revoke all on table public.lending_items, public.lending_requests, public.lending_assignments, public.lending_records,
  public.lending_years from public, anon, authenticated;
grant select on table public.lending_items, public.lending_requests, public.lending_assignments, public.lending_records,
  public.lending_years to authenticated;
grant insert, update, delete on table public.lending_items to authenticated;
grant insert, update on table public.lending_requests, public.lending_records to authenticated;

-- ポリシーが呼ぶ判定と集合の関数は authenticated だけが実行できる（0003・0010 と同じ）。年度ごとのロックとトリガー関数は誰も実行
-- できない（DEFINER の RPC とトリガーの中からだけ呼ぶ）
revoke all on function private.can_record_lending(uuid), private.lending_confirmed_year_ids() from public, anon;
grant execute on function private.can_record_lending(uuid), private.lending_confirmed_year_ids() to authenticated;
revoke all on function private.lock_lending_year(uuid), private.tg_lending_items_guard_stock(),
  private.tg_lending_requests_check_requestable(), private.tg_lending_requests_set_actor(),
  private.tg_lending_assignments_set_actor(), private.tg_lending_records_set_actor()
  from public, anon, authenticated;
revoke all on all functions in schema private from public;

-- RPC は 0005 と同じ繰り返しで、authenticated だけが実行できる
do $$
declare f text;
begin
  foreach f in array array[
    'public.save_lending_assignments(uuid, jsonb)',
    'public.set_lending_confirmed(uuid, boolean, text)',
    'public.previous_year_lending_items(uuid)'] loop
    execute format('revoke all on function %s from public, anon', f);
    execute format('grant execute on function %s to authenticated', f);
  end loop;
end $$;
