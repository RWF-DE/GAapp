-- 0021_count_items.sql（T22。2026-11-09。D-60）：備品（数えるだけ）の表（count_items・count_stocks）・トリガー・RLS・RPC
-- 机椅子の在庫入力で、9 品目（items）のほかに数だけを数える物（ゴミ箱・延長コード・扇風機・オレンジ椅子・白椅子など）。
-- count_items は年度をまたぐ名前の一覧（items と同じ扱い。翌年も同じ選択肢が出る。年度の作成〔create_year_from〕は変えない）、
-- count_stocks は年度×保管場所×物の数（在庫〔stocks〕と同じ人が、同じ年度の状態で書く。can_write_stocks）。
-- 数えるだけなので、申請・振り分け（allocate の入力）・検証コード・Excel・ダッシュボード・年度データの JSON には入らない。
-- 版（allocation_version）の増分（bump_version_*）と、確定中の守り（guard_confirmed）は付けない（振り分けに使わない）。
-- 書き込みの道（02「設計上の決めごと」の T22 の項）：
--   数：在庫入力から直接（RLS。count_stocks の upsert。理由の要らない1つの表の書き込みなので RPC にしない。監査の理由は null）
--   名前を足す：RPC add_count_item だけ（在庫を書ける人が使う。表の insert のポリシーは管理者だけ）
--   名前・最初から出す・並びを直す・消す：管理者がマスタ設定の品目のタブから直接（items と同じ is_admin_of_open_year）
-- 履歴：count_items の行は年度を持たないので、audit_logs_select の「年度のない行」の一覧に count_items を足す（作り直す。ほかの
-- 枝は 0013 のまま）。
-- 使うのは 0013 までの関数（can_write_stocks・assert_role・my_role_year_ids など）だけ。0014〜0020 とは独立。

------------------------------------------------------------------------
-- 表
------------------------------------------------------------------------
-- 名前の一覧（年度をまたぐ）。名前は前後の空白を除いた形（lending_items_name_check と同じ 25 文字の式）で 1〜50 字。DB では除かずに
-- 拒む（23514。画面は zod の trim を通してから送る。RPC は invalid_input）。always_shown は在庫入力のすべての場所に最初から行を出す物。
-- created_by は足した人（トリガー set_actor が auth.uid() を入れる。seed・SQL Editor では入れた値のまま。D-10）
create table public.count_items (
  id uuid primary key default gen_random_uuid(),
  name text not null,
  always_shown boolean not null default false,
  sort_order integer not null default 0,
  created_by uuid references auth.users on delete set null,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  constraint count_items_name_check check (name <> ''
    and name = btrim(name, E'\t\n\u000b\f\r                  　﻿')
    and length(name) <= 50)
);
-- 名前の重なり：NFKC にして小文字にした名前で1つ（画面の nameKey〔lib/schemas/settings.ts。NFKC・trim・小文字〕と同じ比べ方。
-- DB の名前は前後の空白がないので trim は要らない）。「ゴミ箱」と「ｺﾞﾐ箱」、「LAN」と「ｌａｎ」は同じ名前（23505）
create unique index count_items_name_key on public.count_items (lower(normalize(name, NFKC)));

-- 数（年度×保管場所×物）。counted_by・counted_at はトリガー set_counted が入れる（stocks と同じ。クライアントの値は使わない）。
-- 年度へは cascade（年度を消すと数も消える）、場所と物へは restrict（数のある場所・物は消せない。stocks と同じ）
create table public.count_stocks (
  year_id uuid not null references public.years on delete cascade,
  room_id uuid not null references public.rooms on delete restrict,
  count_item_id uuid not null references public.count_items on delete restrict,
  count integer not null,
  counted_by uuid references auth.users on delete set null,
  counted_at timestamptz,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  primary key (year_id, room_id, count_item_id),
  constraint count_stocks_count_check check (count between 0 and 10000)
);
-- 場所・物の restrict の確かめ（主キーの先頭は year_id なので、room_id・count_item_id だけでは引けない）
create index count_stocks_room_id_idx on public.count_stocks (room_id);
create index count_stocks_count_item_id_idx on public.count_stocks (count_item_id);

alter table public.count_items enable row level security;
alter table public.count_stocks enable row level security;

------------------------------------------------------------------------
-- トリガー
------------------------------------------------------------------------
-- BEFORE ROW は名前の順に動く：check_immutable（count_stocks の鍵の付け替えを invalid_input で止める）→ set_actor・set_counted →
-- set_timestamps。版の増分（bump_version_*）・確定中の守り（guard_confirmed）・終了の年度の守り（lock_year_guard）は付けない
-- （振り分けの入力でない。終了の年度の読み取り専用は、書き込みのポリシー〔can_write_stocks・is_admin_of_open_year〕と RPC が守る）。

-- 日時（0002 の共通の関数）
create trigger set_timestamps before insert or update on public.count_items
  for each row execute function private.tg_set_timestamps();
create trigger set_timestamps before insert or update on public.count_stocks
  for each row execute function private.tg_set_timestamps();

-- 監査（D-11。0002 の tg_audit。count_items は年度も団体も null、count_stocks は year_id を行から。理由は null〔直接の書き込み〕）
create trigger audit after insert or update or delete on public.count_items
  for each row execute function private.tg_audit('id');
create trigger audit after insert or update or delete on public.count_stocks
  for each row execute function private.tg_audit('year_id,room_id,count_item_id');

-- 年度・場所・物の付け替えを止める（D-16。0002 の tg_immutable_columns。invalid_input）。行は足すか消すだけ（upsert で同じ値を
-- 書き直すのは通る）
create trigger check_immutable before update of year_id, room_id, count_item_id on public.count_stocks
  for each row execute function private.tg_immutable_columns('year_id', 'room_id', 'count_item_id');

-- 足した人：ログインしている人の insert（RPC の中も）では DB が auth.uid() を入れ、update では元の値のまま（クライアントの値は使わない）。
-- seed・SQL Editor（auth.uid() が null）では入れた値のまま（D-10。0017 の tg_tasks_set_actor と同じ形で、updated_by はない）。
-- auth.uid() を読むだけなので INVOKER でよい
create function private.tg_count_items_set_actor()
returns trigger language plpgsql set search_path = '' as $$
begin
  if auth.uid() is not null then
    if tg_op = 'INSERT' then
      new.created_by := auth.uid();
    else
      new.created_by := old.created_by;
    end if;
  end if;
  return new;
end $$;
create trigger set_actor before insert or update on public.count_items
  for each row execute function private.tg_count_items_set_actor();

-- 数えた人・日時（0002 の tg_stocks_set_counted と同じ中身。表ごとの関数にする〔T18 の判断の 4〕）
create function private.tg_count_stocks_set_counted()
returns trigger language plpgsql set search_path = '' as $$
begin
  if auth.uid() is not null then
    new.counted_by := auth.uid();
    new.counted_at := now();
  end if;
  return new;
end $$;
create trigger set_counted before insert or update on public.count_stocks
  for each row execute function private.tg_count_stocks_set_counted();

------------------------------------------------------------------------
-- RLS
------------------------------------------------------------------------
-- 名前の一覧：どこかの年度のロールか団体代表がある人が読み、書くのは終了でない年度のどれかの管理者（items と同じ。0004）
create policy count_items_select on public.count_items for select to authenticated using (private.has_any_access());
create policy count_items_insert on public.count_items for insert to authenticated with check (private.is_admin_of_open_year());
create policy count_items_update on public.count_items for update to authenticated
  using (private.is_admin_of_open_year()) with check (private.is_admin_of_open_year());
create policy count_items_delete on public.count_items for delete to authenticated using (private.is_admin_of_open_year());

-- 数：読むのは stocks と同じ（総務。D-47 の形。0013 の stocks_select）、書くのは在庫と同じ（can_write_stocks。部門長以上は終了以外、
-- 部員は準備中・受付中）。update は using と with check に同じ述語（鍵の列は check_immutable で変えられない）
create policy count_stocks_select on public.count_stocks for select to authenticated
  using (year_id in (select private.my_role_year_ids('{admin,head,deputy_head,staff}')));
create policy count_stocks_insert on public.count_stocks for insert to authenticated
  with check (private.can_write_stocks(year_id));
create policy count_stocks_update on public.count_stocks for update to authenticated
  using (private.can_write_stocks(year_id)) with check (private.can_write_stocks(year_id));
create policy count_stocks_delete on public.count_stocks for delete to authenticated
  using (private.can_write_stocks(year_id));

-- 履歴：年度のない行は、年度をまたぐ3表に count_items を足した4表の分を、終了でない年度の管理者が読む（0013 の audit_logs_select の
-- 年度のない枝の一覧に count_items を足しただけ。年度のある枝は変えない）
drop policy audit_logs_select on public.audit_logs;
create policy audit_logs_select on public.audit_logs for select to authenticated
  using (case when year_id is null
              then table_name in ('rooms', 'items', 'distance_overrides', 'count_items') and (select private.is_admin_of_open_year())
              else year_id in (select private.my_role_year_ids('{admin,head,deputy_head}')) end);

------------------------------------------------------------------------
-- RPC
------------------------------------------------------------------------
-- add_count_item：備品（数えるだけ）の名前を足し、その id を返す。同じ名前（NFKC・小文字で同じ）があれば足さずにその id を返す。
-- 呼べるのは在庫を書ける人（can_write_stocks。部門長以上は終了でない年度、部員は準備中・受付中）。書けなければ forbidden（年度が
-- ない・p_year_id が null・終了の年度も）。名前が null・空・前後に空白（上の 25 文字）・51 字以上なら invalid_input（field: name）。
-- 新しい物は並びを今の最大＋1 にする（always_shown は false）。同時に同じ名前を足しても、一意の索引と on conflict do nothing で
-- 1行になり、どちらも同じ id を返す（待った側は先の行が確定してから読み直す）。名前の一覧は年度をまたぐので、年度は権限の判定にだけ使う。
-- 表を RLS を通さずに書く（insert のポリシーは管理者だけ）ので SECURITY DEFINER
create function public.add_count_item(p_year_id uuid, p_name text)
returns uuid language plpgsql security definer set search_path = '' as $$
declare v_id uuid;
begin
  if not private.can_write_stocks(p_year_id) then
    perform private.fail('forbidden');
  end if;
  if p_name is null or p_name = ''
     or p_name <> btrim(p_name, E'\t\n\u000b\f\r                  　﻿')
     or length(p_name) > 50 then
    perform private.fail('invalid_input', jsonb_build_object('field', 'name'));
  end if;
  select ci.id into v_id from public.count_items ci where lower(normalize(ci.name, NFKC)) = lower(normalize(p_name, NFKC));
  if v_id is not null then
    return v_id;
  end if;
  insert into public.count_items (name, sort_order)
  values (p_name, coalesce((select max(ci.sort_order) from public.count_items ci), 0) + 1)
  on conflict ((lower(normalize(name, NFKC)))) do nothing
  returning id into v_id;
  if v_id is null then
    select ci.id into v_id from public.count_items ci where lower(normalize(ci.name, NFKC)) = lower(normalize(p_name, NFKC));
  end if;
  return v_id;
exception
  when data_exception or check_violation then
    perform private.fail('invalid_input', jsonb_build_object('field', 'name'));
end $$;

-- previous_year_count_stocks：前年度（年度の prev_year_id。複製元）の備品（数えるだけ）の数を返す（読み取りだけ。在庫入力と在庫一覧の
-- 前年の数）。previous_year_stocks（0013）と同じ形：呼べるのはその年度の総務（でなければ forbidden）。前年度がなければ 0 行。
-- 年度の状態によらない（前年度のロールは要らない）
create function public.previous_year_count_stocks(p_year_id uuid)
returns table (room_id uuid, count_item_id uuid, count integer)
language plpgsql stable security definer set search_path = '' as $$
begin
  perform private.assert_role(p_year_id, '{admin,head,deputy_head,staff}');
  return query
    select cs.room_id, cs.count_item_id, cs.count
    from public.years y join public.count_stocks cs on cs.year_id = y.prev_year_id
    where y.id = p_year_id;
end $$;

------------------------------------------------------------------------
-- 最初から出す4つ（ユーザーの決め。D-60）
------------------------------------------------------------------------
-- ほかの選択肢（白椅子・台形机・掃除機など）は、本番の SQL Editor で入れるか、在庫入力の「その他」で足す
insert into public.count_items (name, always_shown, sort_order) values
  ('ゴミ箱', true, 1), ('延長コード', true, 2), ('扇風機', true, 3), ('オレンジ椅子', true, 4);

------------------------------------------------------------------------
-- 権限
------------------------------------------------------------------------
-- 表：先に Supabase の既定の権限（public スキーマの新しい表に anon・authenticated の全部）を外してから、authenticated に select と
-- insert・update・delete（どちらも画面から直接書く表。行はポリシーで絞る）。truncate・references・trigger は与えない。anon と PUBLIC
-- には何も与えない
revoke all on table public.count_items, public.count_stocks from public, anon, authenticated;
grant select, insert, update, delete on table public.count_items, public.count_stocks to authenticated;

-- トリガー関数は誰も実行できない（トリガーの実行は execute の権限を見ない）
revoke all on function private.tg_count_items_set_actor(), private.tg_count_stocks_set_counted() from public, anon, authenticated;
revoke all on all functions in schema private from public;

-- RPC は 0005 と同じ繰り返しで、authenticated だけが実行できる
do $$
declare f text;
begin
  foreach f in array array[
    'public.add_count_item(uuid, text)',
    'public.previous_year_count_stocks(uuid)'] loop
    execute format('revoke all on function %s from public, anon', f);
    execute format('grant execute on function %s to authenticated', f);
  end loop;
end $$;
