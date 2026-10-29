-- 0004_policies.sql（T03）：表の権限とポリシー
-- 表の権限（RLS の外側の守り）。anon には何も与えない
grant select on all tables in schema public to authenticated;
grant insert, update, delete on
  public.rooms, public.items, public.room_years, public.distance_overrides, public.stocks, public.groups,
  public.request_submissions, public.requests, public.rules, public.slots, public.deliveries
  to authenticated;

-- 年度
create policy years_select on public.years for select to authenticated
  using (private.can_read_year(id));

-- 年度をまたぐ表（D-01）
create policy rooms_select on public.rooms for select to authenticated using (private.has_any_access());
create policy rooms_insert on public.rooms for insert to authenticated with check (private.is_admin_of_open_year());
create policy rooms_update on public.rooms for update to authenticated
  using (private.is_admin_of_open_year()) with check (private.is_admin_of_open_year());
create policy rooms_delete on public.rooms for delete to authenticated using (private.is_admin_of_open_year());

create policy items_select on public.items for select to authenticated using (private.has_any_access());
create policy items_insert on public.items for insert to authenticated with check (private.is_admin_of_open_year());
create policy items_update on public.items for update to authenticated
  using (private.is_admin_of_open_year()) with check (private.is_admin_of_open_year());
create policy items_delete on public.items for delete to authenticated using (private.is_admin_of_open_year());

create policy distance_overrides_select on public.distance_overrides for select to authenticated using (private.has_any_access());
create policy distance_overrides_insert on public.distance_overrides for insert to authenticated with check (private.is_admin_of_open_year());
create policy distance_overrides_update on public.distance_overrides for update to authenticated
  using (private.is_admin_of_open_year()) with check (private.is_admin_of_open_year());
create policy distance_overrides_delete on public.distance_overrides for delete to authenticated using (private.is_admin_of_open_year());

-- 年度の表で「年度のロールなら読める・admin が書ける」もの
create policy room_years_select on public.room_years for select to authenticated using (private.can_read_year(year_id));
create policy room_years_insert on public.room_years for insert to authenticated with check (private.can_admin(year_id));
create policy room_years_update on public.room_years for update to authenticated
  using (private.can_admin(year_id)) with check (private.can_admin(year_id));
create policy room_years_delete on public.room_years for delete to authenticated using (private.can_admin(year_id));

create policy slots_select on public.slots for select to authenticated using (private.can_read_year(year_id));
create policy slots_insert on public.slots for insert to authenticated with check (private.can_admin(year_id));
create policy slots_update on public.slots for update to authenticated
  using (private.can_admin(year_id)) with check (private.can_admin(year_id));
create policy slots_delete on public.slots for delete to authenticated using (private.can_admin(year_id));

-- 在庫
create policy stocks_select on public.stocks for select to authenticated
  using (private.has_any_role(year_id, '{admin,staff}'));
create policy stocks_insert on public.stocks for insert to authenticated with check (private.can_write_stocks(year_id));
create policy stocks_update on public.stocks for update to authenticated
  using (private.can_write_stocks(year_id)) with check (private.can_write_stocks(year_id));
create policy stocks_delete on public.stocks for delete to authenticated using (private.can_write_stocks(year_id));

-- 団体
create policy groups_select on public.groups for select to authenticated
  using (private.has_any_role(year_id, '{admin,staff,viewer}') or private.is_group_member(id));
create policy groups_insert on public.groups for insert to authenticated with check (private.can_admin(year_id));
create policy groups_update on public.groups for update to authenticated
  using (private.can_admin(year_id)) with check (private.can_admin(year_id));
create policy groups_delete on public.groups for delete to authenticated using (private.can_admin(year_id));

-- ロール・団体代表・招待（書き込みは RPC だけ）
create policy year_roles_select on public.year_roles for select to authenticated
  using (user_id = (select auth.uid()) or private.has_role(year_id, 'admin'));
create policy group_members_select on public.group_members for select to authenticated
  using (user_id = (select auth.uid()) or private.has_role(private.group_year_id(group_id), 'admin'));
create policy invitations_select on public.invitations for select to authenticated
  using ((email = lower((select auth.jwt() ->> 'email')) and private.has_any_access())
         or private.has_role(year_id, 'admin'));

-- 申請
create policy request_submissions_select on public.request_submissions for select to authenticated
  using (private.has_any_role(private.group_year_id(group_id), '{admin,staff}') or private.is_group_member(group_id));
create policy request_submissions_insert on public.request_submissions for insert to authenticated
  with check (private.can_write_requests(group_id));
create policy request_submissions_update on public.request_submissions for update to authenticated
  using (private.can_write_requests(group_id)) with check (private.can_write_requests(group_id));
create policy request_submissions_delete on public.request_submissions for delete to authenticated
  using (private.can_write_requests(group_id));

create policy requests_select on public.requests for select to authenticated
  using (private.has_any_role(private.group_year_id(group_id), '{admin,staff}') or private.is_group_member(group_id));
create policy requests_insert on public.requests for insert to authenticated
  with check (private.can_write_requests(group_id));
create policy requests_update on public.requests for update to authenticated
  using (private.can_write_requests(group_id)) with check (private.can_write_requests(group_id));
create policy requests_delete on public.requests for delete to authenticated
  using (private.can_write_requests(group_id));

-- ルール
create policy rules_select on public.rules for select to authenticated
  using (private.has_any_role(year_id, '{admin,staff}'));
create policy rules_insert on public.rules for insert to authenticated with check (private.can_admin(year_id));
-- closed でも admin は更新できるが、トリガー（guard_rules）が memo 以外の変更を止める。
-- with check は更新後の行しか見られないので「year_id が変わらない」は書けない。year_id の付け替え（closed の年度へ移す）は
-- guard_rules が invalid_input で止める（0002。pgTAP の 011 で確かめる）
create policy rules_update on public.rules for update to authenticated
  using (private.has_role(year_id, 'admin')) with check (private.has_role(year_id, 'admin'));
create policy rules_delete on public.rules for delete to authenticated using (private.can_admin(year_id));

-- 了承（書き込みは set_consent）
create policy substitution_consents_select on public.substitution_consents for select to authenticated
  using (private.has_any_role(private.group_year_id(group_id), '{admin,staff}') or private.is_group_member(group_id));

-- 振り分け（書き込みは RPC だけ）
create policy allocations_select on public.allocations for select to authenticated
  using (private.has_any_role(year_id, '{admin,staff}')
         or ((private.has_role(year_id, 'viewer') or private.is_group_member(group_id))
             and private.year_status(year_id) in ('confirmed', 'closed')));

-- 受け渡し（フェーズ2。staff の更新は check_delivery）
create policy deliveries_select on public.deliveries for select to authenticated
  using (private.has_any_role(year_id, '{admin,staff,viewer}') or private.is_group_member(group_id));
create policy deliveries_insert on public.deliveries for insert to authenticated with check (private.can_admin(year_id));
create policy deliveries_update on public.deliveries for update to authenticated
  using (private.can_admin(year_id)) with check (private.can_admin(year_id));
create policy deliveries_delete on public.deliveries for delete to authenticated using (private.can_admin(year_id));

-- ユーザー
create policy profiles_select on public.profiles for select to authenticated
  using (private.can_see_profile(user_id));

-- 履歴
-- 年度のない行は年度をまたぐ3表のものだけ。団体の連鎖削除の行にも年度が入る（7 章）
create policy audit_logs_select on public.audit_logs for select to authenticated
  using (case when year_id is null
              then table_name in ('rooms', 'items', 'distance_overrides') and private.is_admin_of_open_year()
              else private.has_role(year_id, 'admin') end);
