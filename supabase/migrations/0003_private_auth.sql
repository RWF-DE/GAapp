-- 0003_private_auth.sql（T03）：権限の判定と RPC の共通関数
-- 判定関数はすべて SECURITY DEFINER・search_path = ''・STABLE。呼んだ人（auth.uid()）についてだけ答える。
-- ポリシーは呼んだ人の権限で評価されるので、authenticated には private の usage と、ポリシーが呼ぶ判定関数 12 個の
-- execute だけを与える。RPC の補助とトリガー関数には execute を与えない（DEFINER の RPC・トリガーから所有者の権限で呼ぶ）。
-- 0002 のトリガー関数はここの関数を呼ばない（T02 だけを当てた状態でも動くように）。

create function private.has_role(p_year_id uuid, p_role public.app_role)
returns boolean language sql stable security definer set search_path = '' as $$
  select exists (
    select 1 from public.year_roles yr
    where yr.year_id = p_year_id and yr.user_id = (select auth.uid()) and yr.role = p_role)
$$;

create function private.has_any_role(p_year_id uuid, p_roles public.app_role[])
returns boolean language sql stable security definer set search_path = '' as $$
  select exists (
    select 1 from public.year_roles yr
    where yr.year_id = p_year_id and yr.user_id = (select auth.uid()) and yr.role = any (p_roles))
$$;

create function private.is_group_member(p_group_id uuid)
returns boolean language sql stable security definer set search_path = '' as $$
  select exists (
    select 1 from public.group_members gm
    where gm.group_id = p_group_id and gm.user_id = (select auth.uid()))
$$;

-- 団体の年度（RLS を通さずに引く）
create function private.group_year_id(p_group_id uuid)
returns uuid language sql stable security definer set search_path = '' as $$
  select g.year_id from public.groups g where g.id = p_group_id
$$;

create function private.year_status(p_year_id uuid)
returns public.year_status language sql stable security definer set search_path = '' as $$
  select y.status from public.years y where y.id = p_year_id
$$;

-- 年度を読める：その年度のロールがあるか、その年度の団体の代表
create function private.can_read_year(p_year_id uuid)
returns boolean language sql stable security definer set search_path = '' as $$
  select exists (select 1 from public.year_roles yr
                 where yr.year_id = p_year_id and yr.user_id = (select auth.uid()))
      or exists (select 1 from public.group_members gm join public.groups g on g.id = gm.group_id
                 where g.year_id = p_year_id and gm.user_id = (select auth.uid()))
$$;

-- 招待されている（どこかの年度のロールか団体代表）。年度をまたぐ表の読み取り、自分あての招待の読み取りに使う
create function private.has_any_access()
returns boolean language sql stable security definer set search_path = '' as $$
  select exists (select 1 from public.year_roles yr where yr.user_id = (select auth.uid()))
      or exists (select 1 from public.group_members gm where gm.user_id = (select auth.uid()))
$$;

-- D-01：closed でない年度のどれかで admin（年度をまたぐ表の書き込み、年度のない監査の読み取り）
create function private.is_admin_of_open_year()
returns boolean language sql stable security definer set search_path = '' as $$
  select exists (
    select 1 from public.year_roles yr join public.years y on y.id = yr.year_id
    where yr.user_id = (select auth.uid()) and yr.role = 'admin' and y.status <> 'closed')
$$;

-- profiles を読める：自分の行と、自分が admin・staff である年度にロールか団体代表の行がある人（年度ごとに閉じる）
create function private.can_see_profile(p_user_id uuid)
returns boolean language sql stable security definer set search_path = '' as $$
  select p_user_id = (select auth.uid())
      or exists (
        select 1 from public.year_roles me
        where me.user_id = (select auth.uid()) and me.role in ('admin', 'staff')
          and (exists (select 1 from public.year_roles t where t.year_id = me.year_id and t.user_id = p_user_id)
               or exists (select 1 from public.group_members gm join public.groups g on g.id = gm.group_id
                          where g.year_id = me.year_id and gm.user_id = p_user_id)))
$$;

-- その年度を管理者として直接編集できる（closed は読み取り専用）
create function private.can_admin(p_year_id uuid)
returns boolean language sql stable security definer set search_path = '' as $$
  select exists (
    select 1 from public.year_roles yr join public.years y on y.id = yr.year_id
    where yr.year_id = p_year_id and yr.user_id = (select auth.uid())
      and yr.role = 'admin' and y.status <> 'closed')
$$;

-- 在庫を書ける：admin（closed 以外）、staff（preparing・requesting）
create function private.can_write_stocks(p_year_id uuid)
returns boolean language sql stable security definer set search_path = '' as $$
  select exists (
    select 1 from public.year_roles yr join public.years y on y.id = yr.year_id
    where yr.year_id = p_year_id and yr.user_id = (select auth.uid())
      and ((yr.role = 'admin' and y.status <> 'closed')
        or (yr.role = 'staff' and y.status in ('preparing', 'requesting'))))
$$;

-- 申請を RPC なしで書ける（K-24）：
--   団体代表：requesting で、request_open_at が null か過ぎていて、締切前。request_close_at が null なら書けない（比較が null）
--   admin：preparing（締切に関係なく代理入力できる）か、締切前の requesting
create function private.can_write_requests(p_group_id uuid)
returns boolean language sql stable security definer set search_path = '' as $$
  select exists (
    select 1 from public.groups g join public.years y on y.id = g.year_id
    where g.id = p_group_id
      and (
        (exists (select 1 from public.year_roles yr
                 where yr.year_id = g.year_id and yr.user_id = (select auth.uid()) and yr.role = 'admin')
         and (y.status = 'preparing' or (y.status = 'requesting' and now() < y.request_close_at)))
        or
        (exists (select 1 from public.group_members gm
                 where gm.group_id = g.id and gm.user_id = (select auth.uid()))
         and y.status = 'requesting'
         and (y.request_open_at is null or y.request_open_at <= now())
         and now() < y.request_close_at)))
$$;

------------------------------------------------------------------------
-- RPC の共通関数（authenticated には execute を与えない）
------------------------------------------------------------------------

-- RPC の最初で使う。ロールがなければ forbidden（年度が null のときも）
create function private.assert_role(p_year_id uuid, p_roles public.app_role[])
returns void language plpgsql stable security definer set search_path = '' as $$
begin
  if p_year_id is null or not private.has_any_role(p_year_id, p_roles) then
    perform private.fail('forbidden');
  end if;
end $$;

-- 年度の行をロックして、ロールと状態を確かめる（同じ年度の書き込み RPC を直列にする）
-- ①ロック前にロールを確かめ（ロールのない人にロックを取らせない）、②for no key update でロックし（外部キーの確認の
-- FOR KEY SHARE とはぶつからない）、③ロックの後でロールをもう一度確かめる（待っている間に外されたとき。READ COMMITTED
-- なので、ロックの後の文は新しいスナップショットで読む）、④状態を確かめる
create function private.lock_year(p_year_id uuid, p_allowed public.year_status[], p_roles public.app_role[])
returns public.years language plpgsql security definer set search_path = '' as $$
declare v public.years;
begin
  perform private.assert_role(p_year_id, p_roles);
  select * into v from public.years where id = p_year_id for no key update;
  if not found then perform private.fail('forbidden'); end if;
  perform private.assert_role(p_year_id, p_roles);
  if not (v.status = any (p_allowed)) then
    perform private.fail('invalid_state', jsonb_build_object('status', v.status));
  end if;
  return v;
end $$;

-- 監査の理由を置く（書き込みと同じトランザクション。PostgREST は1リクエスト＝1トランザクション）
create function private.set_reason(p_reason text, p_required boolean default false)
returns void language plpgsql set search_path = '' as $$
begin
  if p_required and nullif(btrim(coalesce(p_reason, '')), '') is null then
    perform private.fail('reason_required');
  end if;
  if length(p_reason) > 500 then
    perform private.fail('invalid_input', jsonb_build_object('field', 'reason'));
  end if;
  perform set_config('app.reason', coalesce(btrim(p_reason), ''), true);
end $$;

------------------------------------------------------------------------
-- 権限
------------------------------------------------------------------------
revoke all on all functions in schema private from public;
grant usage on schema private to authenticated;
grant execute on function
  private.has_role(uuid, public.app_role), private.has_any_role(uuid, public.app_role[]),
  private.is_group_member(uuid), private.group_year_id(uuid), private.year_status(uuid),
  private.can_read_year(uuid), private.has_any_access(), private.is_admin_of_open_year(),
  private.can_see_profile(uuid), private.can_admin(uuid), private.can_write_stocks(uuid),
  private.can_write_requests(uuid)
  to authenticated;
