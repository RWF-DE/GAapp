-- 0010_rls_select_once.sql（T14 の速さの改善。2026-10-30。D-47）：行が多くなりうる表の select のポリシーで、判定関数を
-- 行ごとに呼ばない
-- 0004 のポリシーは private.has_role(year_id, …) のように行の列を判定関数に渡すので、関数が残った行の数だけ呼ばれ、そのたびに
-- year_roles・group_members・groups を引く（例：audit_logs に 10 万行あると、未招待の人の絞り込みなしの読みが約 1〜4 秒。
-- notes/T14.md の「速さの改善（2026-10-30）」）。呼んだ人の年度・団体の集合を問い合わせごとに1回だけ作る関数を足し、
-- 「列 in (select 集合)」と「(select 判定関数())」の形（initPlan・hashed SubPlan。行ごとに関数を呼ばない）に書き直す。
-- 見える行（RLS の意味）は 0004 とまったく同じにする：
--   private.has_role(y, r)・has_any_role(y, rs)  ⇔ y in (select private.my_role_year_ids(rs))
--   private.is_group_member(g)                  ⇔ g in (select private.my_group_ids())
--   has_any_role(private.group_year_id(g), rs)  ⇔ g in (select private.my_role_group_ids(rs))（団体の年度で rs のロール）
--   private.is_admin_of_open_year()             ⇔ (select private.is_admin_of_open_year())（引数がないので1回でよい）
-- 集合の要素は主キーの列なので null を含まない（in が null を返して意味が変わることはない）。allocations の year_status(year_id) は
-- 見える側の行（viewer・団体代表）でしか呼ばれないので、そのままにする。
-- 変えるのは select のポリシーだけ（audit_logs・allocations・requests・request_submissions・substitution_consents・stocks・groups）。
-- 書き込みのポリシー・トリガー・RPC は書き込む数行にしか判定関数を呼ばないので変えない。行の少ない表（years・room_years・slots・
-- year_roles・group_members・invitations・deliveries・profiles と年度をまたぐ3表）も変えない。
-- 新しい関数は 0003 の判定関数と同じく SECURITY DEFINER・search_path = ''・STABLE で、呼んだ人（auth.uid()）についてだけ答える
-- （利用者の引数を取らない）。ポリシーは呼んだ人の権限で評価されるので、execute は authenticated にだけ与える。

create function private.my_role_year_ids(p_roles public.app_role[])
returns setof uuid language sql stable security definer set search_path = '' as $$
  select yr.year_id from public.year_roles yr
  where yr.user_id = (select auth.uid()) and yr.role = any (p_roles)
$$;

create function private.my_group_ids()
returns setof uuid language sql stable security definer set search_path = '' as $$
  select gm.group_id from public.group_members gm where gm.user_id = (select auth.uid())
$$;

-- 自分が p_roles のロールを持つ年度の団体（団体の年度でのロールで判定する表〔申請・提出・了承〕のため）
create function private.my_role_group_ids(p_roles public.app_role[])
returns setof uuid language sql stable security definer set search_path = '' as $$
  select g.id from public.year_roles yr join public.groups g on g.year_id = yr.year_id
  where yr.user_id = (select auth.uid()) and yr.role = any (p_roles)
$$;

revoke all on function private.my_role_year_ids(public.app_role[]), private.my_group_ids(),
  private.my_role_group_ids(public.app_role[]) from public, anon;
grant execute on function private.my_role_year_ids(public.app_role[]), private.my_group_ids(),
  private.my_role_group_ids(public.app_role[]) to authenticated;

-- 在庫
drop policy stocks_select on public.stocks;
create policy stocks_select on public.stocks for select to authenticated
  using (year_id in (select private.my_role_year_ids('{admin,staff}')));

-- 団体
drop policy groups_select on public.groups;
create policy groups_select on public.groups for select to authenticated
  using (year_id in (select private.my_role_year_ids('{admin,staff,viewer}')) or id in (select private.my_group_ids()));

-- 申請
drop policy request_submissions_select on public.request_submissions;
create policy request_submissions_select on public.request_submissions for select to authenticated
  using (group_id in (select private.my_role_group_ids('{admin,staff}')) or group_id in (select private.my_group_ids()));

drop policy requests_select on public.requests;
create policy requests_select on public.requests for select to authenticated
  using (group_id in (select private.my_role_group_ids('{admin,staff}')) or group_id in (select private.my_group_ids()));

-- 了承
drop policy substitution_consents_select on public.substitution_consents;
create policy substitution_consents_select on public.substitution_consents for select to authenticated
  using (group_id in (select private.my_role_group_ids('{admin,staff}')) or group_id in (select private.my_group_ids()));

-- 振り分け
drop policy allocations_select on public.allocations;
create policy allocations_select on public.allocations for select to authenticated
  using (year_id in (select private.my_role_year_ids('{admin,staff}'))
         or ((year_id in (select private.my_role_year_ids('{viewer}')) or group_id in (select private.my_group_ids()))
             and private.year_status(year_id) in ('confirmed', 'closed')));

-- 履歴（年度のない行は年度をまたぐ3表のものだけ。0004 と同じ）
drop policy audit_logs_select on public.audit_logs;
create policy audit_logs_select on public.audit_logs for select to authenticated
  using (case when year_id is null
              then table_name in ('rooms', 'items', 'distance_overrides') and (select private.is_admin_of_open_year())
              else year_id in (select private.my_role_year_ids('{admin}')) end);
