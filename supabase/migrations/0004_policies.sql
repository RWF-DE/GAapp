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
-- 距離の値は 0〜20 の整数（03 の距離。allocator の入力の範囲と同じ。T02 の「0 以上」を狭める）
alter table public.rooms drop constraint rooms_extra_cost_check,
  add constraint rooms_extra_cost_check check (extra_cost between 0 and 20);
alter table public.distance_overrides drop constraint distance_overrides_cost_check,
  add constraint distance_overrides_cost_check check (cost between 0 and 20);

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

------------------------------------------------------------------------
-- 守りのトリガーと RLS（0002 の関数を置き換える）
------------------------------------------------------------------------
-- BEFORE ROW トリガーはポリシーの with check より先に動く。守りのトリガーが先に年度の行をロックすると、書く権限のない人
-- （viewer・staff・団体代表・未招待）が拒否される insert を繰り返して、admin の RPC（for no key update）を待たせられる。
-- そこで、RLS の対象のロール（anon・authenticated）で書いているときは、最初に「この人がこの表に書けるか」をポリシーと
-- 同じ条件で確かめ、書けなければロックを取らずに new を返し、拒否は RLS に任せる（RLS の判定は変えない）。
-- postgres・service_role（RLS を通らない）、年度ごとの連鎖削除は今までどおり守る。RPC（SECURITY DEFINER）の中の書き込みも
-- role は authenticated のままなので同じ条件を見る。これらの表に書く RPC は、呼んだ人がこの条件を満たすときだけ書くこと
-- （今は create_year_from の room_years だけで、呼んだ人は新しい年度の admin）。
create function private.rls_applies()
returns boolean language sql stable set search_path = '' as $$
  select coalesce(current_setting('role', true), 'none') in ('anon', 'authenticated')
$$;

create or replace function private.tg_groups_before_write()
returns trigger language plpgsql security definer set search_path = '' as $$
declare v_status public.year_status;
begin
  if private.rls_applies() and not private.can_admin(old.year_id) then     -- groups_update・groups_delete と同じ
    if tg_op = 'DELETE' then return old; end if;
    return new;
  end if;
  v_status := private.lock_year_guard(old.year_id);
  if tg_op = 'DELETE' then
    if v_status in ('confirmed', 'closed') then
      perform private.fail('invalid_state', jsonb_build_object('status', v_status, 'group_id', old.id));
    end if;
    -- 連鎖で消える子の表（requests など）の監査に年度を残す（7 章）
    perform set_config('app.deleted_group_years',
      (coalesce(nullif(current_setting('app.deleted_group_years', true), '')::jsonb, '{}'::jsonb)
       || jsonb_build_object(old.id::text, old.year_id))::text, true);
    return old;
  end if;
  if v_status in ('confirmed', 'closed')
     and (new.year_id, new.category, new.location_room_id) is distinct from (old.year_id, old.category, old.location_room_id) then
    perform private.fail('invalid_state', jsonb_build_object('status', v_status, 'group_id', old.id));
  end if;
  return new;
end $$;

create or replace function private.tg_room_years_guard()
returns trigger language plpgsql security definer set search_path = '' as $$
declare v_status public.year_status;
begin
  if private.rls_applies() and not private.can_admin(new.year_id) then     -- room_years_insert・room_years_update と同じ
    return new;
  end if;
  v_status := private.lock_year_guard(new.year_id);
  if v_status in ('confirmed', 'closed') and not new.usable
     and exists (select 1 from public.allocations a where a.year_id = new.year_id and a.source_room_id = new.room_id) then
    perform private.fail('invalid_state', jsonb_build_object('status', v_status, 'code', 'E002', 'room_id', new.room_id));
  end if;
  return new;
end $$;

create or replace function private.tg_stocks_guard()
returns trigger language plpgsql security definer set search_path = '' as $$
declare
  v_status public.year_status;
  v_count integer := 0;
  v_allocated integer;
begin
  if private.rls_applies() and not private.can_write_stocks(old.year_id) then   -- stocks_update・stocks_delete と同じ
    if tg_op = 'DELETE' then return old; end if;
    return new;
  end if;
  v_status := private.lock_year_guard(old.year_id);
  if tg_op = 'UPDATE' and (new.year_id, new.room_id, new.item_id) = (old.year_id, old.room_id, old.item_id) then
    v_count := new.count;
  end if;
  if v_status in ('confirmed', 'closed') then
    select coalesce(sum(a.count), 0) into v_allocated from public.allocations a
    where a.year_id = old.year_id and a.source_room_id = old.room_id and a.item_id = old.item_id;
    if v_allocated > v_count then
      perform private.fail('invalid_state', jsonb_build_object('status', v_status, 'code', 'E001',
        'room_id', old.room_id, 'item_id', old.item_id, 'allocated', v_allocated, 'stock', v_count));
    end if;
  end if;
  if tg_op = 'DELETE' then return old; end if;
  return new;
end $$;

-- 変えられない列のトリガー：authenticated で動くと private.fail を呼べず 42501 になるので、SECURITY DEFINER にする
alter function private.tg_immutable_columns() security definer;

revoke all on all functions in schema private from public;
