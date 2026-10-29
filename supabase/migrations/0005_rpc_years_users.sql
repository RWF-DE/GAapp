-- 0005_rpc_years_users.sql（T03）：年度・招待・ロールの RPC

------------------------------------------------------------------------
-- 確定の前の確認（E001・E002・E005）
------------------------------------------------------------------------
create function private.confirm_issues(p_year_id uuid)
returns jsonb language sql stable security definer set search_path = '' as $$
  select jsonb_agg(x.issue order by x.ord)
  from (
    select 1 as ord, jsonb_build_object('code', 'E001', 'room_id', a.source_room_id, 'item_id', a.item_id,
             'allocated', sum(a.count), 'stock', coalesce(max(s.count), 0)) as issue
    from public.allocations a
    left join public.stocks s on s.year_id = a.year_id and s.room_id = a.source_room_id and s.item_id = a.item_id
    where a.year_id = p_year_id
    group by a.source_room_id, a.item_id
    having sum(a.count) > coalesce(max(s.count), 0)
    union all
    select 2, jsonb_build_object('code', 'E002', 'allocation_id', a.id, 'room_id', a.source_room_id)
    from public.allocations a
    join public.room_years ry on ry.year_id = a.year_id and ry.room_id = a.source_room_id
    where a.year_id = p_year_id and not ry.usable
    union all
    select 3, jsonb_build_object('code', 'E005', 'allocation_id', a.id, 'group_id', a.group_id)
    from public.allocations a
    join public.groups g on g.id = a.group_id
    where a.year_id = p_year_id and a.is_keep and a.source_room_id is distinct from g.location_room_id
  ) x
$$;

------------------------------------------------------------------------
-- set_year_status
------------------------------------------------------------------------
create function public.set_year_status(p_year_id uuid, p_to public.year_status, p_reason text default null,
                                       p_base_version integer default null)
returns public.years language plpgsql security definer set search_path = '' as $$
declare
  v public.years;
  v_issues jsonb;
begin
  v := private.lock_year(p_year_id, '{preparing,requesting,allocating,confirmed,closed}', '{admin}');
  if not ((v.status::text, p_to::text) in (('preparing', 'requesting'), ('requesting', 'allocating'),
          ('allocating', 'confirmed'), ('confirmed', 'allocating'), ('confirmed', 'closed'))) then
    perform private.fail('invalid_state', jsonb_build_object('from', v.status, 'to', p_to));
  end if;
  -- 理由は確定と確定の解除で必須（02「設計上の決めごと」）
  perform private.set_reason(p_reason, p_to = 'confirmed' or (v.status = 'confirmed' and p_to = 'allocating'));
  if p_to = 'requesting' and (v.request_close_at is null or v.request_close_at <= now()) then
    perform private.fail('invalid_state', jsonb_build_object('field', 'request_close_at'));
  end if;
  if p_to = 'confirmed' then
    -- 確定ボタンを押した人が検証した版と同じか（同時に振り分けや入力が変わっていれば conflict）
    if p_base_version is distinct from v.allocation_version then
      perform private.fail('conflict', jsonb_build_object('allocation_version', v.allocation_version));
    end if;
    v_issues := private.confirm_issues(p_year_id);
    if v_issues is not null then
      perform private.fail(v_issues -> 0 ->> 'code', v_issues);
    end if;
  end if;
  -- 遷移のたびに版を増やす（遷移の前に読んだ入力で保存・確定させない）
  update public.years set status = p_to, allocation_version = allocation_version + 1
  where id = p_year_id returning * into v;
  return v;
end $$;

------------------------------------------------------------------------
-- update_year（P-01）
------------------------------------------------------------------------
-- 1日目は有限で現実的な範囲だけ（D-18）。infinity や date の上限を入れて closed にすると、それより後の1日目がなくなり、
-- 誰も次の年度を作れなくなる（前後の年度との比較では止まらない）。画面の日付の表示も壊れる。
-- update_year・create_year_from はこの CHECK の違反を invalid_input（field = festival_start）に直す
alter table public.years add constraint years_festival_start_check
  check (festival_start between date '2000-01-01' and date '2200-12-31');

create function public.update_year(p_year_id uuid, p_patch jsonb, p_reason text default null)
returns public.years language plpgsql security definer set search_path = '' as $$
declare
  v public.years;
  k text;
  v_constraint text;
begin
  v := private.lock_year(p_year_id, '{preparing,requesting,allocating,confirmed}', '{admin}');
  if p_patch is null or jsonb_typeof(p_patch) <> 'object' then
    perform private.fail('invalid_input', jsonb_build_object('field', 'patch'));
  end if;
  for k in select jsonb_object_keys(p_patch) loop
    if k not in ('label', 'festival_start', 'request_open_at', 'request_close_at') then
      perform private.fail('invalid_input', jsonb_build_object('field', k));
    end if;
  end loop;
  perform private.set_reason(p_reason);
  begin
    update public.years set
      festival_start   = case when p_patch ? 'festival_start' then (p_patch ->> 'festival_start')::date else festival_start end,
      request_open_at  = case when p_patch ? 'request_open_at' then (p_patch ->> 'request_open_at')::timestamptz else request_open_at end,
      request_close_at = case when p_patch ? 'request_close_at' then (p_patch ->> 'request_close_at')::timestamptz else request_close_at end
    where id = p_year_id
    returning * into v;
    -- label（一意の列）は、変えるときだけ別の文で書く。SET に label があると、値が同じでも行のロックが
    -- 外部キーの確認（FOR KEY SHARE）とぶつかる強さになり、その年度を参照する行の insert（在庫など）を待たせる
    if p_patch ? 'label' and btrim(p_patch ->> 'label') is distinct from v.label then
      update public.years set label = btrim(p_patch ->> 'label') where id = p_year_id returning * into v;
    end if;
  exception
    when unique_violation then perform private.fail('conflict', jsonb_build_object('field', 'label'));
    when check_violation then
      get stacked diagnostics v_constraint = constraint_name;
      perform private.fail('invalid_input', jsonb_build_object('field',
        case when v_constraint = 'years_festival_start_check' then 'festival_start' else 'patch' end));
    when data_exception or not_null_violation then      -- 22xxx（範囲外の日付 22008 を含む）
      perform private.fail('invalid_input', jsonb_build_object('field', 'patch'));
  end;
  if v.status = 'requesting' and v.request_close_at is null then
    perform private.fail('invalid_input', jsonb_build_object('field', 'request_close_at'));
  end if;
  -- 1日目は、複製元（prev_year_id）より後で、この年度を複製元にした年度より前（create_year_from の前提と「最新の年度」の
  -- 判定を崩さない。崩すと、どの年度も最新でなくなり次の年度を作れなくなる）
  if p_patch ? 'festival_start'
     and (exists (select 1 from public.years p where p.id = v.prev_year_id and p.festival_start >= v.festival_start)
          or exists (select 1 from public.years n where n.prev_year_id = v.id and n.festival_start <= v.festival_start)) then
    perform private.fail('invalid_input', jsonb_build_object('field', 'festival_start'));
  end if;
  return v;
end $$;

------------------------------------------------------------------------
-- create_year_from（D-01）
------------------------------------------------------------------------
create function private.remap_group_ids(p_params jsonb, p_map jsonb, out params jsonb, out missing boolean)
language plpgsql immutable set search_path = '' as $$
declare g text;
begin
  params := p_params;
  missing := false;
  if jsonb_typeof(p_params -> 'group') = 'string' then
    if p_map ? (p_params ->> 'group') then
      params := jsonb_set(params, '{group}', p_map -> (p_params ->> 'group'));
    else
      missing := true;
    end if;
  end if;
  if jsonb_typeof(p_params -> 'groups') = 'array' then
    for g in select jsonb_array_elements_text(p_params -> 'groups') loop
      if not p_map ? g then missing := true; end if;
    end loop;
    params := jsonb_set(params, '{groups}',
      (select coalesce(jsonb_agg(coalesce(p_map -> e, to_jsonb(e)) order by o), '[]'::jsonb)
       from jsonb_array_elements_text(p_params -> 'groups') with ordinality as t(e, o)));
  end if;
end $$;

create function public.create_year_from(p_prev_year_id uuid, p_label text, p_festival_start date)
returns public.years language plpgsql security definer set search_path = '' as $$
declare
  v_prev public.years;
  v_new  public.years;
  v_map  jsonb;
  r      record;
  v_remap record;
  v_constraint text;
begin
  -- 呼べるのは複製元の年度の admin だけ（複製元が closed でもよい）。複製元は最新の年度でなければならない（D-01）
  if (select auth.uid()) is null or not private.has_role(p_prev_year_id, 'admin') then
    perform private.fail('forbidden');
  end if;
  -- 複製元の行をロックして、同じ年度からの同時の複製を順に処理する（2回目は下の「最新か」で止まる）
  select * into v_prev from public.years where id = p_prev_year_id for no key update;
  if not found or not private.has_role(p_prev_year_id, 'admin') then
    perform private.fail('forbidden');
  end if;
  if exists (select 1 from public.years y
             where y.id <> p_prev_year_id
               and (y.prev_year_id = p_prev_year_id or y.festival_start >= v_prev.festival_start)) then
    perform private.fail('invalid_state', jsonb_build_object('reason', 'not_latest'));
  end if;
  if nullif(btrim(p_label), '') is null or p_festival_start is null or p_festival_start <= v_prev.festival_start then
    perform private.fail('invalid_input');
  end if;
  perform private.set_reason(format('%s から複製', v_prev.label));
  begin
    insert into public.years (label, festival_start, prev_year_id)
    values (btrim(p_label), p_festival_start, p_prev_year_id) returning * into v_new;
  exception
    when unique_violation then perform private.fail('conflict', jsonb_build_object('field', 'label'));
    when check_violation then                -- 年度名の長さか、1日目の範囲（years_festival_start_check）
      get stacked diagnostics v_constraint = constraint_name;
      perform private.fail('invalid_input', jsonb_build_object('field',
        case when v_constraint = 'years_festival_start_check' then 'festival_start' else 'label' end));
  end;
  insert into public.year_roles (year_id, user_id, role) values (v_new.id, auth.uid(), 'admin');
  insert into public.room_years (year_id, room_id, usable, note)
    select v_new.id, ry.room_id, ry.usable, ry.note from public.room_years ry where ry.year_id = p_prev_year_id;

  with ins as (
    insert into public.groups (year_id, name, display_name, aliases, category, is_food, location_room_id, sort_order)
    select v_new.id, g.name, g.display_name, g.aliases, g.category, g.is_food, g.location_room_id, g.sort_order
    from public.groups g where g.year_id = p_prev_year_id
    returning id, name)
  select coalesce(jsonb_object_agg(old.id::text, ins.id), '{}'::jsonb) into v_map
  from ins join public.groups old on old.year_id = p_prev_year_id and old.name = ins.name;

  for r in select * from public.rules where year_id = p_prev_year_id order by code loop
    v_remap := private.remap_group_ids(r.params, v_map);
    insert into public.rules (year_id, code, kind, params, enabled, memo)
    values (v_new.id, r.code, r.kind, v_remap.params,
            r.enabled and not v_remap.missing,
            case when v_remap.missing
                 then concat_ws(' / ', r.memo, format('%s から複製したとき、対象の団体が見つからなかったため無効にした', v_prev.label))
                 else r.memo end);
  end loop;
  return v_new;
end $$;

------------------------------------------------------------------------
-- 招待とロール
------------------------------------------------------------------------
-- 本人のものと確かめられる今のメール（小文字）。確かめられなければ null。招待を付けるかどうかはこれで決める（D-17a）。
-- auth.users.email_confirmed_at は最初の確認の時刻で、あとで email を変えても null に戻らないので、それだけでは足りない。
-- 次をすべて満たすときだけ返す：
-- - 削除されていない・email がある・email_confirmed_at がある
-- - メールの変更の途中でない（email_change が空）
-- - auth.identities に、今の email と同じメールの、Google の identity（Google が持ち主を確かめたアドレス）か、
--   email_verified が true の email の identity（GoTrue は受信箱で確かめた変更のときだけ、email の identity を新しいアドレスと
--   email_verified: true に書き換える）がある。identity_data は利用者が書き換えられない（user_metadata と違う）
create function private.verified_email(p_user_id uuid)
returns text language sql stable security definer set search_path = '' as $$
  select lower(u.email)
  from auth.users u
  where u.id = p_user_id
    and u.deleted_at is null
    and u.email is not null
    and u.email_confirmed_at is not null
    and coalesce(u.email_change, '') = ''
    and exists (
      select 1 from auth.identities i
      where i.user_id = u.id
        and lower(i.identity_data ->> 'email') = lower(u.email)
        and (i.provider = 'google'
             or (i.provider = 'email' and jsonb_typeof(i.identity_data -> 'email_verified') = 'boolean'
                 and (i.identity_data ->> 'email_verified')::boolean)))
$$;

create function private.apply_invitations(p_user_id uuid, p_email text)
returns integer language plpgsql security definer set search_path = '' as $$
declare
  inv record;
  v_n integer := 0;
begin
  for inv in
    select i.id, i.year_id, i.role, i.group_id
    from public.invitations i join public.years y on y.id = i.year_id
    where i.email = lower(btrim(p_email)) and i.used_at is null and y.status <> 'closed'
    order by i.created_at
    for update of i
  loop
    if inv.role is not null then
      insert into public.year_roles (year_id, user_id, role) values (inv.year_id, p_user_id, inv.role)
      on conflict (year_id, user_id) do nothing;
    else
      insert into public.group_members (group_id, user_id) values (inv.group_id, p_user_id)
      on conflict (group_id, user_id) do nothing;
    end if;
    update public.invitations set used_at = now() where id = inv.id;
    v_n := v_n + 1;
  end loop;
  return v_n;
end $$;

create function public.invite(p_year_id uuid, p_email text, p_role public.app_role default null, p_group_id uuid default null)
returns jsonb language plpgsql security definer set search_path = '' as $$
declare
  v_email text := lower(btrim(p_email));
  v_user uuid;
  v_current public.app_role;
  v_ids uuid[] := '{}';
  v_id uuid;
  v_applied integer := 0;
begin
  perform private.lock_year(p_year_id, '{preparing,requesting,allocating,confirmed}', '{admin}');
  if p_role is null and p_group_id is null then
    perform private.fail('invalid_input', jsonb_build_object('field', 'role'));
  end if;
  if v_email is null or v_email !~ '^[^@[:space:]]+@[^@[:space:]]+$' or length(v_email) > 254 then
    perform private.fail('invalid_input', jsonb_build_object('field', 'email'));
  end if;
  if p_group_id is not null
     and not exists (select 1 from public.groups g where g.id = p_group_id and g.year_id = p_year_id) then
    perform private.fail('invalid_input', jsonb_build_object('field', 'group_id'));
  end if;
  -- その場で付けるのは、今のメールが本人のものと確かめられるアカウントだけ（未確認のアカウントや、
  -- email を他人のアドレスに変えたアカウントに招待を取らせない。private.verified_email、D-17a）
  select u.id into v_user from auth.users u
  where lower(u.email) = v_email and private.verified_email(u.id) = v_email;
  if v_user is not null and p_role is not null then
    select yr.role into v_current from public.year_roles yr where yr.year_id = p_year_id and yr.user_id = v_user;
    if v_current is not null and v_current <> p_role then
      perform private.fail('conflict', jsonb_build_object('field', 'role', 'current', v_current));
    end if;
  end if;
  perform private.set_reason('招待');
  if p_role is not null then
    insert into public.invitations (year_id, email, role) values (p_year_id, v_email, p_role)
    on conflict (year_id, email) where role is not null and used_at is null
    do update set role = excluded.role
    returning id into v_id;
    v_ids := v_ids || v_id;
  end if;
  if p_group_id is not null then
    insert into public.invitations (year_id, email, group_id) values (p_year_id, v_email, p_group_id)
    on conflict (year_id, email, group_id) where group_id is not null and used_at is null
    do update set updated_at = now()
    returning id into v_id;
    v_ids := v_ids || v_id;
  end if;
  if v_user is not null then
    v_applied := private.apply_invitations(v_user, v_email);
  end if;
  return jsonb_build_object('invitation_ids', to_jsonb(v_ids), 'applied', v_applied > 0);
end $$;

create function public.set_role(p_year_id uuid, p_user_id uuid, p_role public.app_role, p_reason text default null)
returns void language plpgsql security definer set search_path = '' as $$
begin
  perform private.lock_year(p_year_id, '{preparing,requesting,allocating,confirmed}', '{admin}');
  if p_role is null then                           -- 外すのは remove_role
    perform private.fail('invalid_input', jsonb_build_object('field', 'role'));
  end if;
  if not exists (select 1 from auth.users u where u.id = p_user_id) then
    perform private.fail('not_found', jsonb_build_object('field', 'user_id'));
  end if;
  if p_role <> 'admin'
     and exists (select 1 from public.year_roles where year_id = p_year_id and user_id = p_user_id and role = 'admin')
     and not exists (select 1 from public.year_roles where year_id = p_year_id and role = 'admin' and user_id <> p_user_id) then
    perform private.fail('invalid_state', jsonb_build_object('reason', 'last_admin'));
  end if;
  perform private.set_reason(p_reason);
  insert into public.year_roles (year_id, user_id, role) values (p_year_id, p_user_id, p_role)
  on conflict (year_id, user_id) do update set role = excluded.role;
end $$;

-- ロールを外す。closed の年度でもできる（卒業した admin を外して、権限を残さないため）。最後の admin は外せない
create function public.remove_role(p_year_id uuid, p_user_id uuid, p_reason text default null)
returns void language plpgsql security definer set search_path = '' as $$
begin
  perform private.lock_year(p_year_id, '{preparing,requesting,allocating,confirmed,closed}', '{admin}');
  if exists (select 1 from public.year_roles where year_id = p_year_id and user_id = p_user_id and role = 'admin')
     and not exists (select 1 from public.year_roles where year_id = p_year_id and role = 'admin' and user_id <> p_user_id) then
    perform private.fail('invalid_state', jsonb_build_object('reason', 'last_admin'));
  end if;
  perform private.set_reason(p_reason);
  delete from public.year_roles where year_id = p_year_id and user_id = p_user_id;
  if not found then perform private.fail('not_found'); end if;
end $$;

create function public.revoke_invitation(p_invitation_id uuid)
returns void language plpgsql security definer set search_path = '' as $$
declare v public.invitations;
begin
  -- ロールを確かめてからロックする（ロールのない人に行ロックを取らせない）。見つからなければ year_id が null で forbidden
  -- （有無を漏らさない）。closed の年度でも取り消せる（年度の状態は見ない。使用済みでない招待を残さないため）
  perform private.assert_role((select i.year_id from public.invitations i where i.id = p_invitation_id), '{admin}');
  select * into v from public.invitations where id = p_invitation_id for update;
  if not found then perform private.fail('not_found'); end if;
  if v.used_at is not null then
    perform private.fail('invalid_state', jsonb_build_object('reason', 'used'));
  end if;
  delete from public.invitations where id = p_invitation_id;
end $$;

create function public.remove_group_member(p_group_id uuid, p_user_id uuid, p_reason text default null)
returns void language plpgsql security definer set search_path = '' as $$
declare v_year_id uuid := private.group_year_id(p_group_id);
begin
  perform private.lock_year(v_year_id, '{preparing,requesting,allocating,confirmed,closed}', '{admin}');
  perform private.set_reason(p_reason);
  delete from public.group_members where group_id = p_group_id and user_id = p_user_id;
  if not found then perform private.fail('not_found'); end if;
end $$;

-- ログインのたびに画面が呼ぶ：自分のメール（本人のものと確かめられるとき。private.verified_email）あての未使用の招待を受け入れる。
-- invite と初回ログインが同時に起きて、どちらからも招待が見えなかったときの取りこぼしを拾う
create function public.accept_my_invitations()
returns integer language plpgsql security definer set search_path = '' as $$
declare
  v_uid uuid := (select auth.uid());
  v_email text := private.verified_email((select auth.uid()));
begin
  if v_uid is null or v_email is null then return 0; end if;
  perform private.set_reason('招待の受け入れ');
  return private.apply_invitations(v_uid, v_email);
end $$;

------------------------------------------------------------------------
-- 自分あての招待の読み取り（D-17a）
------------------------------------------------------------------------
-- 呼んだ人の、本人のものと確かめられる今のメール（ポリシー invitations_select が呼ぶ判定関数）。
-- private.verified_email は任意の user_id のメールを返すので authenticated には与えず、自分の分だけを返すこれを与える
create function private.my_verified_email()
returns text language sql stable security definer set search_path = '' as $$
  select private.verified_email((select auth.uid()))
$$;

-- JWT の email（auth.jwt() ->> 'email'）とは比べない。JWT の email は auth.users.email の写しで、email を他人のアドレスに
-- 変えた（email_confirmed_at は最初の確認のまま残る）状態では、その人あての未使用の招待（年度・ロール）を読めてしまうため。
-- 招待を受け入れる条件（invite・accept_my_invitations）と同じ private.verified_email で決める
create policy invitations_select on public.invitations for select to authenticated
  using ((email = (select private.my_verified_email()) and private.has_any_access())
         or private.has_role(year_id, 'admin'));

------------------------------------------------------------------------
-- 権限
------------------------------------------------------------------------
revoke all on all functions in schema private from public;
grant execute on function private.my_verified_email() to authenticated;
do $$
declare f text;
begin
  foreach f in array array[
    'public.set_year_status(uuid, public.year_status, text, integer)',
    'public.update_year(uuid, jsonb, text)',
    'public.create_year_from(uuid, text, date)',
    'public.invite(uuid, text, public.app_role, uuid)',
    'public.set_role(uuid, uuid, public.app_role, text)',
    'public.remove_role(uuid, uuid, text)',
    'public.revoke_invitation(uuid)',
    'public.remove_group_member(uuid, uuid, text)',
    'public.accept_my_invitations()'] loop
    execute format('revoke all on function %s from public, anon', f);
    execute format('grant execute on function %s to authenticated', f);
  end loop;
end $$;
