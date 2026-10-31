-- 0014_notices.sql（T17 の前半。2026-10-31。D-53）：お知らせ（notices）と宛先の団体（notice_groups）の表・RLS・RPC
-- お知らせは総務アプリの機能の1つ（D-51・D-52）。年度ごとに、宛先（notice_audience）を決めて出す：
--   soumu（総務内）     ：その年度の総務（管理者・総務部門長・総務副部門長・総務部門員）だけが読む
--   all_groups（全団体）：総務に加えて、その年度の閲覧のみと、その年度の団体の代表（店長・副店長）が読む
--   groups（指定の団体）：総務に加えて、その年度の閲覧のみと、notice_groups に並べた団体の代表が読む
--                         （団体の代表には、自分の団体の notice_groups の行だけを見せ、ほかにどの団体へ出したかは見せない）
-- 書き込みは RPC（save_notice・delete_notice）だけにする（表には insert・update・delete の権限を与えない）。理由（監査の reason）を
-- RPC の中で置くためと、お知らせと宛先の団体を1回で入れ替えるため（02「設計上の決めごと」の、複数の表をまとめて変える書き込み）。
-- 段（D-48）：総務内を書くのは総務、全団体・指定の団体を書くのとピン留めを付け外すのは部門長以上。直す・消すのは書いた人か
-- 部門長以上（どちらも、その年度の総務であることが先）。
-- 終了（closed）の年度は読み取り専用（RPC が invalid_state）。お知らせは振り分けの入力でないので、版（allocation_version）を
-- 増やさず、確定中の守りもない（確定中も書ける）。
-- 画面（/notices とダッシュボードの欄）は T17 の後半（T16 のマージの後）。

------------------------------------------------------------------------
-- 列挙型と表
------------------------------------------------------------------------
create type public.notice_audience as enum ('soumu', 'all_groups', 'groups');

-- 題名は前後の空白（全角の空白を含む）を除いて 1〜100 字。RPC が除いてから入れ、CHECK は除いた形であることを確かめる
-- （画面の zod の trim は全角の空白も除くので、DB も同じ文字をそろえて除く）。本文は任意（空白だけなら null）で 4000 字まで。
-- 書いた人・直した人（created_by・updated_by）と日時（created_at・updated_at）は DB が入れる（下の set_actor・set_timestamps）。
-- unique (id, year_id) は notice_groups の複合外部キーの参照先（お知らせと団体が同じ年度であることを保証する。groups と同じ）
create table public.notices (
  id uuid primary key default gen_random_uuid(),
  year_id uuid not null references public.years on delete cascade,
  audience public.notice_audience not null,
  title text not null,
  body text,
  pinned boolean not null default false,
  created_by uuid references auth.users on delete set null,
  updated_by uuid references auth.users on delete set null,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  constraint notices_title_check
    check (title <> '' and title = btrim(title, E' \t\n\r\u3000') and length(title) <= 100),
  constraint notices_body_check check (length(body) <= 4000),
  constraint notices_id_year_id_key unique (id, year_id)
);
create index notices_year_id_idx on public.notices (year_id, created_at desc);

-- 宛先の団体（宛先が groups のお知らせだけが持つ。下の check_audience・check_groups のトリガー）。
-- 複合外部キーで、お知らせと団体が同じ年度であることを保証する（allocations・invitations と同じ）。
-- お知らせを消すと行も消える。団体を消しても行が消えるだけで、お知らせは残る（宛先の団体が 0 になることがある。
-- 団体を消せるのは管理者で、確定中・終了の年度では消せない〔tg_groups_before_write〕）
create table public.notice_groups (
  notice_id uuid not null,
  year_id uuid not null,
  group_id uuid not null,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  primary key (notice_id, group_id),
  constraint notice_groups_notice_fkey foreign key (notice_id, year_id)
    references public.notices (id, year_id) on delete cascade,
  constraint notice_groups_group_fkey foreign key (group_id, year_id)
    references public.groups (id, year_id) on delete cascade
);
create index notice_groups_group_id_idx on public.notice_groups (group_id);

alter table public.notices enable row level security;
alter table public.notice_groups enable row level security;

------------------------------------------------------------------------
-- トリガー
------------------------------------------------------------------------
-- 日時（0002 の共通の関数）
create trigger set_timestamps before insert or update on public.notices
  for each row execute function private.tg_set_timestamps();
create trigger set_timestamps before insert or update on public.notice_groups
  for each row execute function private.tg_set_timestamps();

-- 監査（D-11。0002 の tg_audit。year_id は行から、notice_groups の group_id は宛先の団体）
create trigger audit after insert or update or delete on public.notices
  for each row execute function private.tg_audit('id');
create trigger audit after insert or update or delete on public.notice_groups
  for each row execute function private.tg_audit('notice_id,group_id');

-- 年度・お知らせ・団体の付け替えを止める（D-16。0002 の tg_immutable_columns。invalid_input）。notice_groups は鍵の列が全部
-- 変えられないので、行は足すか消すだけになる
create trigger check_immutable before update of year_id on public.notices
  for each row execute function private.tg_immutable_columns('year_id');
create trigger check_immutable before update of notice_id, year_id, group_id on public.notice_groups
  for each row execute function private.tg_immutable_columns('notice_id', 'year_id', 'group_id');

-- 書いた人・直した人：ログインしている人の書き込み（RPC の中も）では DB が auth.uid() を入れる（クライアントの値は使わない。
-- created_by は最初に書いた人のまま）。seed・SQL Editor（auth.uid() が null）では入れた値のまま（D-10 と同じ）
create function private.tg_notices_set_actor()
returns trigger language plpgsql set search_path = '' as $$
begin
  if auth.uid() is not null then
    if tg_op = 'INSERT' then
      new.created_by := auth.uid();
    else
      new.created_by := old.created_by;
    end if;
    new.updated_by := auth.uid();
  end if;
  return new;
end $$;
create trigger set_actor before insert or update on public.notices
  for each row execute function private.tg_notices_set_actor();

-- 宛先の団体の行は、宛先が groups のお知らせにだけ置ける（他の表を参照する CHECK は使わない決まりなので、トリガーで確かめる）。
-- RLS（閲覧のみと団体の代表が読む notice_groups の行）はこれを前提にする：行があるのは団体あてのお知らせだけ。
-- RPC は、宛先を groups から変えるときは先に行を消してからお知らせを直し、groups に変えるときはお知らせを直してから行を足す。
-- お知らせの行を for share で読むので、宛先を変える同時の書き込みとは順に処理される（RPC の中ではもうロックを持っている）
create function private.tg_notice_groups_check_audience()
returns trigger language plpgsql security definer set search_path = '' as $$
declare v_audience public.notice_audience;
begin
  select n.audience into v_audience from public.notices n
  where n.id = new.notice_id and n.year_id = new.year_id
  for share;
  if found and v_audience <> 'groups' then          -- お知らせがなければ外部キーのエラー（23503）に任せる
    perform private.fail('invalid_input', jsonb_build_object('field', 'group_ids', 'reason', 'not_allowed'));
  end if;
  return new;
end $$;
create trigger check_audience before insert on public.notice_groups
  for each row execute function private.tg_notice_groups_check_audience();

create function private.tg_notices_check_groups()
returns trigger language plpgsql security definer set search_path = '' as $$
begin
  if new.audience <> 'groups' and exists (select 1 from public.notice_groups ng where ng.notice_id = new.id) then
    perform private.fail('invalid_input', jsonb_build_object('field', 'group_ids', 'reason', 'not_allowed'));
  end if;
  return new;
end $$;
create trigger check_groups before update of audience on public.notices
  for each row execute function private.tg_notices_check_groups();

------------------------------------------------------------------------
-- 読み取り（RLS）
------------------------------------------------------------------------
-- select のポリシーは D-47 の形（呼んだ人の年度・団体・お知らせの集合を問い合わせごとに1回だけ作り、行ごとに判定関数を呼ばない）。
-- 足す集合の関数は 0010 と同じく SECURITY DEFINER・search_path = ''・STABLE で、呼んだ人（auth.uid()）についてだけ答える
-- （利用者の引数を取らない）。execute は authenticated だけ。notices のポリシーから notice_groups を読むので、RLS を通らない
-- DEFINER の関数で読む（ポリシーの中で RLS のある表を読み合うと再帰する）。

-- 自分が団体の代表（店長・副店長）である年度
create function private.my_group_year_ids()
returns setof uuid language sql stable security definer set search_path = '' as $$
  select g.year_id from public.group_members gm join public.groups g on g.id = gm.group_id
  where gm.user_id = (select auth.uid())
$$;

-- 自分が代表の団体を宛先の団体に含むお知らせ
create function private.my_group_notice_ids()
returns setof uuid language sql stable security definer set search_path = '' as $$
  select ng.notice_id from public.notice_groups ng join public.group_members gm on gm.group_id = ng.group_id
  where gm.user_id = (select auth.uid())
$$;

-- お知らせ：総務はその年度の全部。閲覧のみはその年度の団体あて（全団体・指定の団体。総務内は読めない）。
-- 団体の代表は、代表である年度の全団体あてと、自分の団体を宛先に含む指定の団体あて。ほかの人は何も読めない。
-- 団体あての枝は宛先を名前で並べる（宛先の種類を足しても、黙って閲覧のみ・団体の代表に見えないように）
create policy notices_select on public.notices for select to authenticated
  using (year_id in (select private.my_role_year_ids('{admin,head,deputy_head,staff}'))
         or (audience in ('all_groups', 'groups') and year_id in (select private.my_role_year_ids('{viewer}')))
         or (audience = 'all_groups' and year_id in (select private.my_group_year_ids()))
         or (audience = 'groups' and id in (select private.my_group_notice_ids())));

-- 宛先の団体：総務と閲覧のみはその年度の全部（行があるのは団体あてのお知らせだけ。上のトリガー）。団体の代表は自分の団体の行だけ
create policy notice_groups_select on public.notice_groups for select to authenticated
  using (year_id in (select private.my_role_year_ids('{admin,head,deputy_head,staff,viewer}'))
         or group_id in (select private.my_group_ids()));

------------------------------------------------------------------------
-- 書き込み（RPC）
------------------------------------------------------------------------
-- save_notice：お知らせを作る（p_notice_id が null）か直す（全部の欄を置き換え、宛先の団体は差分で入れ替える）。返り値はお知らせの行
-- （画面は返った updated_at を次の p_base_updated_at に使う）。
-- 引数の並び：既定値のある引数の後に既定値のない引数を置けないので、要る引数（年度・宛先・題名）を先に、任意の引数を後に置く
-- （PostgREST は名前つきで呼ぶので、並びは呼び方に関わらない）。
-- エラーの順番（pgTAP はこの順で確かめる。notes/T17.md）：
--   1. ロール（その年度の総務）と状態（終了でない）：forbidden・invalid_state（lock_year。年度がなくても forbidden）
--   2. 入力：invalid_input（field：audience・title・body・pinned・group_ids〔reason：required・not_allowed・too_many・invalid・
--      not_in_year〕・base_updated_at〔作るときは渡さない、直すときは要る〕）
--   3. 段：宛先が全団体・指定の団体で、部門長以上でない → forbidden
--   4. 直すとき：その年度にそのお知らせがない → not_found（呼んだ人はその年度の総務で、その年度のお知らせを全部読めるので、
--      有無を漏らさない。ほかの年度のお知らせも not_found）
--   5. 書いた人でも部門長以上でもない → forbidden
--   6. ピン留め：作るときに付ける、直すときに変える（付ける・外す）のは部門長以上だけ → forbidden（書いた人は、部門長以上が
--      付けたピン留めをそのままにして直せる）
--   7. 楽観ロック：p_base_updated_at がその行の updated_at と違う（ミリ秒までで比べる）→ conflict（detail は id）
--   8. 理由（作るときは「お知らせ」、直すときは「お知らせの更新」）を置いて書く
-- 作るときに冪等の鍵はない（応答が届かなかったら、一覧を読み直して確かめてから送り直す。04 の (B2)）
create function public.save_notice(
  p_year_id uuid,
  p_audience public.notice_audience,
  p_title text,
  p_body text default null,
  p_pinned boolean default false,
  p_group_ids uuid[] default '{}',
  p_notice_id uuid default null,
  p_base_updated_at timestamptz default null)
returns public.notices language plpgsql security definer set search_path = '' as $$
declare
  c_space constant text := E' \t\n\r\u3000';         -- 題名の前後から除く空白（notices_title_check と同じ文字）
  v_title text := btrim(p_title, c_space);
  v_body text := case when btrim(coalesce(p_body, ''), c_space) = '' then null else p_body end;
  v_group_ids uuid[] := coalesce(p_group_ids, '{}');
  v_is_lead boolean;
  v_old public.notices;
  v public.notices;
  v_constraint text;
begin
  perform private.lock_year(p_year_id, '{preparing,requesting,allocating,confirmed}', '{admin,head,deputy_head,staff}');

  if p_audience is null then
    perform private.fail('invalid_input', jsonb_build_object('field', 'audience'));
  end if;
  if v_title is null or v_title = '' or length(v_title) > 100 then
    perform private.fail('invalid_input', jsonb_build_object('field', 'title'));
  end if;
  if length(v_body) > 4000 then
    perform private.fail('invalid_input', jsonb_build_object('field', 'body'));
  end if;
  if p_pinned is null then
    perform private.fail('invalid_input', jsonb_build_object('field', 'pinned'));
  end if;
  if p_audience = 'groups' then
    -- 数を先に見る（大きな配列を unnest しない）。団体はその年度のものだけ、null と重複は受け付けない
    if cardinality(v_group_ids) = 0 then
      perform private.fail('invalid_input', jsonb_build_object('field', 'group_ids', 'reason', 'required'));
    end if;
    if cardinality(v_group_ids) > 1000 then
      perform private.fail('invalid_input', jsonb_build_object('field', 'group_ids', 'reason', 'too_many'));
    end if;
    if exists (select 1 from unnest(v_group_ids) as t(group_id) where t.group_id is null)
       or (select count(distinct t.group_id) from unnest(v_group_ids) as t(group_id)) <> cardinality(v_group_ids) then
      perform private.fail('invalid_input', jsonb_build_object('field', 'group_ids', 'reason', 'invalid'));
    end if;
    if exists (select 1 from unnest(v_group_ids) as t(group_id)
               where not exists (select 1 from public.groups g where g.id = t.group_id and g.year_id = p_year_id)) then
      perform private.fail('invalid_input', jsonb_build_object('field', 'group_ids', 'reason', 'not_in_year'));
    end if;
  elsif cardinality(v_group_ids) > 0 then
    perform private.fail('invalid_input', jsonb_build_object('field', 'group_ids', 'reason', 'not_allowed'));
  end if;
  if (p_notice_id is null) <> (p_base_updated_at is null) then
    perform private.fail('invalid_input', jsonb_build_object('field', 'base_updated_at'));
  end if;

  v_is_lead := private.has_any_role(p_year_id, '{admin,head,deputy_head}');
  if p_audience <> 'soumu' and not v_is_lead then
    perform private.fail('forbidden');
  end if;

  if p_notice_id is null then
    if p_pinned and not v_is_lead then
      perform private.fail('forbidden');
    end if;
    perform private.set_reason('お知らせ');
    insert into public.notices (year_id, audience, title, body, pinned)
    values (p_year_id, p_audience, v_title, v_body, p_pinned)
    returning * into v;
  else
    select * into v_old from public.notices n where n.id = p_notice_id and n.year_id = p_year_id for update;
    if not found then
      perform private.fail('not_found');
    end if;
    if v_old.created_by is distinct from auth.uid() and not v_is_lead then
      perform private.fail('forbidden');
    end if;
    if p_pinned <> v_old.pinned and not v_is_lead then
      perform private.fail('forbidden');
    end if;
    if date_trunc('milliseconds', v_old.updated_at) is distinct from date_trunc('milliseconds', p_base_updated_at) then
      perform private.fail('conflict', jsonb_build_object('id', v_old.id));
    end if;
    perform private.set_reason('お知らせの更新');
    -- 宛先から外す団体の行を先に消す（groups から宛先を変えるときは全部。check_groups のトリガーより先に）
    delete from public.notice_groups ng where ng.notice_id = v_old.id and not (ng.group_id = any (v_group_ids));
    -- 何も変わらなくても書く（updated_at が進み、ほかの人が読んだ版は conflict になる。お知らせと宛先の団体を1つの版で守る）
    update public.notices set audience = p_audience, title = v_title, body = v_body, pinned = p_pinned
    where id = v_old.id
    returning * into v;
  end if;
  -- 新しく宛先に足す団体（今ある行はそのまま。監査に変わらない団体の行を出さない）
  insert into public.notice_groups (notice_id, year_id, group_id)
  select v.id, p_year_id, t.group_id from unnest(v_group_ids) as t(group_id)
  on conflict (notice_id, group_id) do nothing;
  return v;
exception
  when foreign_key_violation then                    -- 確かめた後に団体が消えた（管理者の団体の削除と重なった）
    perform private.fail('invalid_input', jsonb_build_object('field', 'group_ids', 'reason', 'not_in_year'));
  when check_violation then
    get stacked diagnostics v_constraint = constraint_name;
    perform private.fail('invalid_input', jsonb_build_object('field',
      case v_constraint when 'notices_title_check' then 'title' when 'notices_body_check' then 'body' else 'notice' end));
  when data_exception then                           -- 22xxx（関数の中で起きた形の誤り。D-19）
    perform private.fail('invalid_input', jsonb_build_object('field', 'notice'));
end $$;

-- delete_notice：お知らせを消す（宛先の団体の行も消える）。
-- エラーの順番：
--   1. お知らせがない・その年度の総務でない → forbidden（有無を漏らさない。revoke_invitation と同じ）。終了の年度 → invalid_state
--   2. p_base_updated_at が null → invalid_input（field: base_updated_at）
--   3. 年度の行のロックを待つ間に消えた → not_found（呼んだ人はその年度の総務で、そのお知らせを読めた）
--   4. 書いた人でも部門長以上でもない → forbidden
--   5. 楽観ロック → conflict（detail は id）
--   6. 理由「お知らせの削除」を置いて消す
create function public.delete_notice(p_notice_id uuid, p_base_updated_at timestamptz)
returns void language plpgsql security definer set search_path = '' as $$
declare
  v_year_id uuid := (select n.year_id from public.notices n where n.id = p_notice_id);
  v_old public.notices;
begin
  perform private.lock_year(v_year_id, '{preparing,requesting,allocating,confirmed}', '{admin,head,deputy_head,staff}');
  if p_base_updated_at is null then
    perform private.fail('invalid_input', jsonb_build_object('field', 'base_updated_at'));
  end if;
  select * into v_old from public.notices n where n.id = p_notice_id for update;
  if not found then
    perform private.fail('not_found');
  end if;
  if v_old.created_by is distinct from auth.uid() and not private.has_any_role(v_year_id, '{admin,head,deputy_head}') then
    perform private.fail('forbidden');
  end if;
  if date_trunc('milliseconds', v_old.updated_at) is distinct from date_trunc('milliseconds', p_base_updated_at) then
    perform private.fail('conflict', jsonb_build_object('id', v_old.id));
  end if;
  perform private.set_reason('お知らせの削除');
  delete from public.notices where id = v_old.id;
end $$;

------------------------------------------------------------------------
-- 権限
------------------------------------------------------------------------
-- 表：authenticated には select だけ（書き込みは RPC だけ。02 の「RPC でだけ書く表」）。anon と PUBLIC には何も与えない
revoke all on table public.notices, public.notice_groups from public, anon, authenticated;
grant select on table public.notices, public.notice_groups to authenticated;

-- ポリシーが呼ぶ集合の関数は authenticated だけが実行できる（0010 と同じ）。トリガー関数は誰も実行できない
revoke all on function private.my_group_year_ids(), private.my_group_notice_ids() from public, anon;
grant execute on function private.my_group_year_ids(), private.my_group_notice_ids() to authenticated;
revoke all on function private.tg_notices_set_actor(), private.tg_notice_groups_check_audience(),
  private.tg_notices_check_groups() from public, anon, authenticated;
revoke all on all functions in schema private from public;

-- RPC は 0005 と同じ繰り返しで、authenticated だけが実行できる
do $$
declare f text;
begin
  foreach f in array array[
    'public.save_notice(uuid, public.notice_audience, text, text, boolean, uuid[], uuid, timestamptz)',
    'public.delete_notice(uuid, timestamptz)'] loop
    execute format('revoke all on function %s from public, anon', f);
    execute format('grant execute on function %s to authenticated', f);
  end loop;
end $$;
