-- 0006_rpc_allocations.sql（T03）：振り分け・了承・申請・受け渡しの RPC

------------------------------------------------------------------------
-- save_auto_allocations（D-06・P-01・K-07）
------------------------------------------------------------------------
create type private.auto_row as (
  ord integer, source_room_id uuid, group_id uuid, item_id uuid, requested_item_id uuid, count integer, is_keep boolean);

create function private.parse_auto_rows(p_rows jsonb)
returns private.auto_row[] language plpgsql set search_path = '' as $$
declare v private.auto_row[];
begin
  if p_rows is null or jsonb_typeof(p_rows) <> 'array' or jsonb_array_length(p_rows) > 10000 then
    perform private.fail('invalid_input', jsonb_build_object('field', 'rows'));
  end if;
  begin
    select coalesce(array_agg(row(
             e.ord::integer,
             (e.v ->> 'sourceRoomId')::uuid, (e.v ->> 'groupId')::uuid,
             (e.v ->> 'itemId')::uuid, (e.v ->> 'requestedItemId')::uuid,
             case when jsonb_typeof(e.v -> 'count') = 'number' then (e.v ->> 'count')::integer end,
             coalesce((e.v ->> 'isKeep')::boolean, false))::private.auto_row order by e.ord), '{}')
    into v
    from jsonb_array_elements(p_rows) with ordinality as e(v, ord);
  exception when data_exception then                 -- 22xxx（uuid・整数・真偽値の形の誤り）
    perform private.fail('invalid_input', jsonb_build_object('field', 'rows'));
  end;
  return v;
end $$;

create function public.save_auto_allocations(p_year_id uuid, p_rows jsonb, p_mode text, p_base_version integer)
returns jsonb language plpgsql security definer set search_path = '' as $$
declare
  v_year public.years;
  v_rows private.auto_row[];
  v_bad  jsonb;
  v_del  integer;
  v_upd  integer;
  v_ins  integer;
begin
  -- 1. ロール → 状態 → 版
  v_year := private.lock_year(p_year_id, '{allocating}', '{admin}');
  if p_base_version is distinct from v_year.allocation_version then
    perform private.fail('conflict', jsonb_build_object('allocation_version', v_year.allocation_version));
  end if;
  if p_mode is null or p_mode not in ('full', 'minimal_change') then
    perform private.fail('invalid_input', jsonb_build_object('field', 'mode'));
  end if;

  -- 2. 入力の形と参照
  v_rows := private.parse_auto_rows(p_rows);
  select jsonb_agg(r.ord order by r.ord) into v_bad
  from unnest(v_rows) r
  where r.source_room_id is null or r.group_id is null or r.item_id is null or r.requested_item_id is null
     or r.count is null or r.count <= 0 or r.count > 10000
     or not exists (select 1 from public.groups g where g.id = r.group_id and g.year_id = p_year_id)
     or not exists (select 1 from public.rooms rm where rm.id = r.source_room_id)
     or not exists (select 1 from public.items i where i.id = r.item_id)
     or not exists (select 1 from public.items i where i.id = r.requested_item_id);
  if v_bad is not null then
    perform private.fail('invalid_input', jsonb_build_object('rows', v_bad));
  end if;
  select jsonb_agg(d.k) into v_bad from (
    select jsonb_build_object('source_room_id', r.source_room_id, 'group_id', r.group_id,
                              'requested_item_id', r.requested_item_id, 'item_id', r.item_id) as k
    from unnest(v_rows) r
    group by r.source_room_id, r.group_id, r.requested_item_id, r.item_id
    having count(*) > 1) d;
  if v_bad is not null then
    perform private.fail('invalid_input', jsonb_build_object('duplicates', v_bad));
  end if;

  -- 3. E002・E005（is_keep は DB が決め直す）
  select jsonb_agg(jsonb_build_object('code', 'E002', 'ord', r.ord, 'room_id', r.source_room_id)) into v_bad
  from unnest(v_rows) r
  join public.room_years ry on ry.year_id = p_year_id and ry.room_id = r.source_room_id
  where not ry.usable;
  if v_bad is not null then perform private.fail('E002', v_bad); end if;

  select jsonb_agg(jsonb_build_object('code', 'E005', 'ord', r.ord, 'group_id', r.group_id)) into v_bad
  from unnest(v_rows) r join public.groups g on g.id = r.group_id
  where r.is_keep and r.source_room_id is distinct from g.location_room_id;
  if v_bad is not null then perform private.fail('E005', v_bad); end if;

  select coalesce(array_agg(row(r.ord, r.source_room_id, r.group_id, r.item_id, r.requested_item_id, r.count,
                                 r.source_room_id is not distinct from g.location_room_id)::private.auto_row order by r.ord), '{}')
  into v_rows
  from unnest(v_rows) r join public.groups g on g.id = r.group_id;

  -- 4. 理由を置いてから、auto かつ未固定の行だけを差分で入れ替える
  perform private.set_reason(case p_mode when 'full' then '自動振り分け（全体）' else '自動振り分け（最小変更）' end);

  with cur as (
    select a.id, a.source_room_id, a.group_id, a.requested_item_id, a.item_id,
           count(*) over (partition by a.source_room_id, a.group_id, a.requested_item_id, a.item_id) as n
    from public.allocations a
    where a.year_id = p_year_id and a.origin = 'auto' and not a.pinned)
  delete from public.allocations a using cur
  where a.id = cur.id
    and (cur.n > 1 or not exists (
      select 1 from unnest(v_rows) r
      where r.source_room_id = cur.source_room_id and r.group_id = cur.group_id
        and r.requested_item_id = cur.requested_item_id and r.item_id = cur.item_id));
  get diagnostics v_del = row_count;

  update public.allocations a set count = r.count, is_keep = r.is_keep
  from unnest(v_rows) r
  where a.year_id = p_year_id and a.origin = 'auto' and not a.pinned
    and a.source_room_id = r.source_room_id and a.group_id = r.group_id
    and a.requested_item_id = r.requested_item_id and a.item_id = r.item_id
    and (a.count, a.is_keep) is distinct from (r.count, r.is_keep);
  get diagnostics v_upd = row_count;

  insert into public.allocations (year_id, source_room_id, group_id, item_id, requested_item_id, count, is_keep, pinned, origin)
  select p_year_id, r.source_room_id, r.group_id, r.item_id, r.requested_item_id, r.count, r.is_keep, false, 'auto'
  from unnest(v_rows) r
  where not exists (
    select 1 from public.allocations a
    where a.year_id = p_year_id and a.origin = 'auto' and not a.pinned
      and a.source_room_id = r.source_room_id and a.group_id = r.group_id
      and a.requested_item_id = r.requested_item_id and a.item_id = r.item_id)
  order by r.ord;
  get diagnostics v_ins = row_count;

  -- 5. 保存後の在庫超過（固定・手動の行を含む）。あれば全体を取り消す
  select jsonb_agg(i) into v_bad
  from jsonb_array_elements(private.confirm_issues(p_year_id)) i
  where i ->> 'code' = 'E001';
  if v_bad is not null then perform private.fail('E001', v_bad); end if;

  update public.years set auto_allocated_at = now() where id = p_year_id;
  return jsonb_build_object(
    'allocation_version', (select y.allocation_version from public.years y where y.id = p_year_id),
    'deleted', v_del, 'updated', v_upd, 'inserted', v_ins);
exception
  -- 上で確かめきれなかった形の誤り（22xxx）と CHECK 違反（23514）も invalid_input にする（生の SQLSTATE を返さない）
  when data_exception or check_violation then
    perform private.fail('invalid_input', jsonb_build_object('field', 'rows'));
end $$;

------------------------------------------------------------------------
-- save_allocation_rows
------------------------------------------------------------------------
create function public.save_allocation_rows(p_year_id uuid, p_changes jsonb, p_reason text)
returns jsonb language plpgsql security definer set search_path = '' as $$
declare
  c jsonb;
  v_op text;
  v_old public.allocations;
  v_new public.allocations;
  v_out jsonb := '[]';
  v_loc uuid;
  v_data_changed boolean;
  v_version_before integer;
begin
  -- ロックした時点の版（自分の書き込みの前）。画面は、これが自分の持つ版と同じときだけ返り値の版を覚え直す
  v_version_before := (private.lock_year(p_year_id, '{allocating}', '{admin}')).allocation_version;
  if p_changes is null or jsonb_typeof(p_changes) <> 'array'
     or jsonb_array_length(p_changes) not between 1 and 1000 then
    perform private.fail('invalid_input', jsonb_build_object('field', 'changes'));
  end if;
  if (select count(*) <> count(distinct e ->> 'id') from jsonb_array_elements(p_changes) e where e ? 'id') then
    perform private.fail('invalid_input', jsonb_build_object('reason', 'duplicate_id'));
  end if;
  perform private.set_reason(p_reason, true);

  for c in select e from jsonb_array_elements(p_changes) e loop
    v_op := c ->> 'op';
    if v_op = 'insert' then
      v_new := null;
      v_new.year_id := p_year_id;
      v_new.source_room_id := (c ->> 'sourceRoomId')::uuid;
      v_new.group_id := (c ->> 'groupId')::uuid;
      v_new.item_id := (c ->> 'itemId')::uuid;
      v_new.requested_item_id := (c ->> 'requestedItemId')::uuid;
      v_new.count := (c ->> 'count')::integer;
      v_new.pinned := coalesce((c ->> 'pinned')::boolean, false);
      v_new.note := c ->> 'note';
      v_new.origin := 'manual';
    elsif v_op in ('update', 'delete') then
      select * into v_old from public.allocations a
      where a.id = (c ->> 'id')::uuid and a.year_id = p_year_id for update;
      if not found or date_trunc('milliseconds', v_old.updated_at)
                      is distinct from date_trunc('milliseconds', (c ->> 'updatedAt')::timestamptz) then
        perform private.fail('conflict', jsonb_build_object('id', c ->> 'id'));
      end if;
      if v_op = 'delete' then
        delete from public.allocations where id = v_old.id;
        v_out := v_out || jsonb_build_object('op', 'delete', 'id', v_old.id);
        continue;
      end if;
      v_new := v_old;
      if c ? 'sourceRoomId' then v_new.source_room_id := (c ->> 'sourceRoomId')::uuid; end if;
      if c ? 'itemId' then v_new.item_id := (c ->> 'itemId')::uuid; end if;
      if c ? 'requestedItemId' then v_new.requested_item_id := (c ->> 'requestedItemId')::uuid; end if;
      if c ? 'count' then v_new.count := (c ->> 'count')::integer; end if;
      if c ? 'note' then v_new.note := c ->> 'note'; end if;
      if c ? 'pinned' then v_new.pinned := (c ->> 'pinned')::boolean; end if;
      v_data_changed := (v_new.source_room_id, v_new.item_id, v_new.requested_item_id, v_new.count, v_new.note)
             is distinct from (v_old.source_room_id, v_old.item_id, v_old.requested_item_id, v_old.count, v_old.note);
      if v_data_changed then v_new.origin := 'manual'; end if;
    else
      perform private.fail('invalid_input', jsonb_build_object('field', 'op'));
    end if;

    -- 共通の検査
    if length(v_new.note) > 2000 then
      perform private.fail('invalid_input', jsonb_build_object('field', 'note'));
    end if;
    if v_new.source_room_id is null or v_new.item_id is null or v_new.requested_item_id is null
       or v_new.count is null or v_new.count <= 0 or v_new.count > 10000 or v_new.pinned is null
       or not exists (select 1 from public.rooms where id = v_new.source_room_id)
       or not exists (select 1 from public.items where id = v_new.item_id)
       or not exists (select 1 from public.items where id = v_new.requested_item_id) then
      perform private.fail('invalid_input', c);
    end if;
    select g.location_room_id into v_loc from public.groups g where g.id = v_new.group_id and g.year_id = p_year_id;
    if not found then perform private.fail('invalid_input', jsonb_build_object('field', 'groupId')); end if;
    if exists (select 1 from public.room_years ry
               where ry.year_id = p_year_id and ry.room_id = v_new.source_room_id and not ry.usable) then
      perform private.fail('E002', jsonb_build_object('room_id', v_new.source_room_id));
    end if;
    v_new.is_keep := v_new.source_room_id is not distinct from v_loc;

    if v_op = 'insert' then
      insert into public.allocations (year_id, source_room_id, group_id, item_id, requested_item_id, count, is_keep, pinned, origin, note)
      values (v_new.year_id, v_new.source_room_id, v_new.group_id, v_new.item_id, v_new.requested_item_id,
              v_new.count, v_new.is_keep, v_new.pinned, v_new.origin, v_new.note)
      returning * into v_new;
    else
      update public.allocations set
        source_room_id = v_new.source_room_id, item_id = v_new.item_id, requested_item_id = v_new.requested_item_id,
        count = v_new.count, note = v_new.note, pinned = v_new.pinned, origin = v_new.origin, is_keep = v_new.is_keep
      where id = v_old.id
      returning * into v_new;
    end if;
    v_out := v_out || jsonb_build_object('op', v_op, 'row', to_jsonb(v_new));
  end loop;

  return jsonb_build_object(
    'allocation_version_before', v_version_before,
    'allocation_version', (select y.allocation_version from public.years y where y.id = p_year_id),
    'rows', v_out);
exception
  when data_exception or check_violation then   -- 22xxx（uuid・整数・日時の形、範囲外の日付）と CHECK
    perform private.fail('invalid_input', jsonb_build_object('field', 'changes'));
end $$;

------------------------------------------------------------------------
-- set_consent（P-01：asked で count を入れる）
------------------------------------------------------------------------
create function public.set_consent(p_group_id uuid, p_from_item uuid, p_to_item uuid,
                                   p_status public.consent_status, p_note text default null)
returns public.substitution_consents language plpgsql security definer set search_path = '' as $$
declare
  v_year_id uuid := private.group_year_id(p_group_id);
  v_is_admin boolean := private.has_role(v_year_id, 'admin');
  v_cur public.substitution_consents;
  v_found boolean;
  v_total integer;
  v_count integer;
  v_res public.substitution_consents;
begin
  if v_year_id is null or not (v_is_admin or private.is_group_member(p_group_id)) then
    perform private.fail('forbidden');
  end if;
  perform 1 from public.years where id = v_year_id for no key update;
  -- ロックの後でもう一度ロールと状態を確かめる
  v_is_admin := private.has_role(v_year_id, 'admin');
  if not (v_is_admin or private.is_group_member(p_group_id)) then
    perform private.fail('forbidden');
  end if;
  if private.year_status(v_year_id) <> 'allocating' then
    perform private.fail('invalid_state', jsonb_build_object('status', private.year_status(v_year_id)));
  end if;
  if p_status is null or p_from_item is null or p_to_item is null or p_from_item = p_to_item
     or (select count(*) from public.items where id in (p_from_item, p_to_item)) <> 2
     or length(p_note) > 2000 then
    perform private.fail('invalid_input');
  end if;
  select * into v_cur from public.substitution_consents
  where group_id = p_group_id and from_item_id = p_from_item and to_item_id = p_to_item for update;
  v_found := found;
  if not v_is_admin then
    if p_status not in ('accepted', 'declined') then perform private.fail('forbidden'); end if;
    if not v_found or v_cur.status = 'not_asked' then perform private.fail('invalid_state'); end if;
  end if;

  select coalesce(sum(a.count), 0) into v_total from public.allocations a
  where a.year_id = v_year_id and a.group_id = p_group_id
    and a.requested_item_id = p_from_item and a.item_id = p_to_item;
  v_count := v_cur.count;
  if p_status = 'asked' then
    if v_total = 0 then perform private.fail('invalid_state', jsonb_build_object('reason', 'no_rows')); end if;
    v_count := v_total;
  elsif p_status = 'accepted' then
    if v_count is null then
      v_count := v_total;
    elsif v_total > v_count then
      perform private.fail('conflict', jsonb_build_object('asked', v_count, 'current', v_total));
    end if;
  end if;

  perform private.set_reason(format('交換の了承を記録（%s）', p_status));
  insert into public.substitution_consents (group_id, from_item_id, to_item_id, count, status, note)
  values (p_group_id, p_from_item, p_to_item, v_count, p_status, p_note)
  on conflict (group_id, from_item_id, to_item_id) do update
    set count = excluded.count, status = excluded.status,
        note = coalesce(excluded.note, public.substitution_consents.note)
  returning * into v_res;

  if p_status = 'accepted' then
    update public.allocations set pinned = true
    where year_id = v_year_id and group_id = p_group_id
      and requested_item_id = p_from_item and item_id = p_to_item and not pinned;
  elsif p_status = 'declined' then
    update public.allocations set pinned = false
    where year_id = v_year_id and group_id = p_group_id
      and requested_item_id = p_from_item and item_id = p_to_item and pinned;
  end if;
  return v_res;
exception
  -- CHECK 違反（count の上限など）と形の誤りは invalid_input にする（生の SQLSTATE を返さない）
  when data_exception or check_violation then
    perform private.fail('invalid_input');
end $$;

------------------------------------------------------------------------
-- 申請の行の読み取り（update_requests_after_deadline・submit_requests で共通）
------------------------------------------------------------------------
create type private.request_row as (item_id uuid, count integer, updated_at timestamptz);

create function private.parse_request_rows(p_rows jsonb)
returns private.request_row[] language plpgsql set search_path = '' as $$
declare
  v private.request_row[];
  v_bad jsonb;
begin
  if p_rows is null or jsonb_typeof(p_rows) <> 'array' or jsonb_array_length(p_rows) > 100 then
    perform private.fail('invalid_input', jsonb_build_object('field', 'rows'));
  end if;
  begin
    select coalesce(array_agg(row(
             (e.v ->> 'itemId')::uuid,
             case when jsonb_typeof(e.v -> 'count') = 'number' then (e.v ->> 'count')::integer end,
             (e.v ->> 'updatedAt')::timestamptz)::private.request_row order by e.ord), '{}')
    into v
    from jsonb_array_elements(p_rows) with ordinality as e(v, ord);
  exception when data_exception then
    perform private.fail('invalid_input', jsonb_build_object('field', 'rows'));
  end;
  select jsonb_agg(r.item_id) into v_bad from unnest(v) r
  where r.item_id is null or r.count is null or r.count not between 0 and 10000
     or not exists (select 1 from public.items i where i.id = r.item_id);
  if v_bad is not null or (select count(*) <> count(distinct r.item_id) from unnest(v) r) then
    perform private.fail('invalid_input', jsonb_build_object('field', 'rows'));
  end if;
  return v;
end $$;

------------------------------------------------------------------------
-- update_requests_after_deadline
------------------------------------------------------------------------
create function public.update_requests_after_deadline(p_group_id uuid, p_rows jsonb, p_reason text,
                                                      p_submission jsonb default null)
returns void language plpgsql security definer set search_path = '' as $$
declare
  v_year_id uuid := private.group_year_id(p_group_id);
  v_rows private.request_row[];
  r private.request_row;
  v_cur public.requests;
begin
  perform private.lock_year(v_year_id, '{preparing,requesting,allocating}', '{admin}');
  perform private.set_reason(p_reason, true);
  v_rows := private.parse_request_rows(p_rows);
  -- p_submission：{ "submitted": true, "note": "…" }（どちらのキーも省略できる）。
  -- submitted は true だけを受け付ける（提出済みにする。提出済みなら最初の提出日時を保つ）。未提出に戻すと D-07 で需要が
  -- fixed_request に変わって振り分けが変わるので、この RPC では戻さない（false は invalid_input）
  if p_submission is not null and (jsonb_typeof(p_submission) <> 'object' or length(p_submission ->> 'note') > 2000
     or (p_submission ? 'submitted' and p_submission -> 'submitted' is distinct from 'true'::jsonb)
     or (p_submission ? 'note' and jsonb_typeof(p_submission -> 'note') not in ('string', 'null'))
     or exists (select 1 from jsonb_object_keys(p_submission) k where k not in ('submitted', 'note'))) then
    perform private.fail('invalid_input', jsonb_build_object('field', 'submission'));
  end if;
  foreach r in array v_rows loop
    select * into v_cur from public.requests where group_id = p_group_id and item_id = r.item_id for update;
    if found then
      if r.updated_at is null or date_trunc('milliseconds', v_cur.updated_at) <> date_trunc('milliseconds', r.updated_at) then
        perform private.fail('conflict', jsonb_build_object('item_id', r.item_id));
      end if;
      update public.requests set count = r.count where group_id = p_group_id and item_id = r.item_id;
    else
      if r.updated_at is not null then
        perform private.fail('conflict', jsonb_build_object('item_id', r.item_id));
      end if;
      insert into public.requests (group_id, item_id, count) values (p_group_id, r.item_id, r.count);
    end if;
  end loop;
  if p_submission is not null then
    insert into public.request_submissions (group_id, submitted_at, note)
    values (p_group_id,
            case when p_submission ? 'submitted' then now() end,
            p_submission ->> 'note')
    on conflict (group_id) do update set
      submitted_at = case when p_submission ? 'submitted'
                          then coalesce(public.request_submissions.submitted_at, now())
                          else public.request_submissions.submitted_at end,
      note = case when p_submission ? 'note' then p_submission ->> 'note'
                  else public.request_submissions.note end;
  end if;
exception
  when data_exception or check_violation then
    perform private.fail('invalid_input', jsonb_build_object('field', 'rows'));
end $$;

------------------------------------------------------------------------
-- submit_requests（締切前の提出。申請と提出を1トランザクションで書く）
------------------------------------------------------------------------
create function public.submit_requests(p_group_id uuid, p_rows jsonb, p_note text default null)
returns public.request_submissions language plpgsql security definer set search_path = '' as $$
declare
  v_year_id uuid := private.group_year_id(p_group_id);
  r private.request_row;
  v_res public.request_submissions;
begin
  if v_year_id is null or not (private.has_role(v_year_id, 'admin') or private.is_group_member(p_group_id)) then
    perform private.fail('forbidden');
  end if;
  -- 年度の行をロックしてから締切を確かめる（状態の遷移と順に処理する。受付中は for share なので提出どうしは並行してよい）
  perform private.lock_year_guard(v_year_id);
  if not private.can_write_requests(p_group_id) then
    perform private.fail('invalid_state', jsonb_build_object('status', private.year_status(v_year_id)));
  end if;
  if length(p_note) > 2000 then
    perform private.fail('invalid_input', jsonb_build_object('field', 'note'));
  end if;
  perform private.set_reason(null);                 -- 理由の要らない書き込み（監査の reason は空）
  foreach r in array private.parse_request_rows(p_rows) loop
    insert into public.requests (group_id, item_id, count) values (p_group_id, r.item_id, r.count)
    on conflict (group_id, item_id) do update set count = excluded.count
    where public.requests.count is distinct from excluded.count;
  end loop;
  insert into public.request_submissions (group_id, submitted_at, note)
  values (p_group_id, now(), p_note)
  on conflict (group_id) do update set submitted_at = now(), note = excluded.note
  returning * into v_res;
  return v_res;
exception
  when data_exception or check_violation then
    perform private.fail('invalid_input', jsonb_build_object('field', 'rows'));
end $$;

------------------------------------------------------------------------
-- check_delivery（フェーズ2）
------------------------------------------------------------------------
create function public.check_delivery(p_delivery_id uuid, p_status public.delivery_status,
                                      p_problem_note text default null, p_returned boolean default null)
returns public.deliveries language plpgsql security definer set search_path = '' as $$
declare
  v_year_id uuid := (select d.year_id from public.deliveries d where d.id = p_delivery_id);
  v public.deliveries;
begin
  perform private.assert_role(v_year_id, '{admin,staff}');
  if private.year_status(v_year_id) not in ('confirmed', 'closed') then      -- 返却チェックは closed でも（01 の 9）
    perform private.fail('invalid_state');
  end if;
  if p_status is null or length(p_problem_note) > 2000 then perform private.fail('invalid_input'); end if;
  update public.deliveries set
    status = p_status,
    problem_note = p_problem_note,
    returned = coalesce(p_returned, returned),
    checked_by = auth.uid(),
    checked_at = now()
  where id = p_delivery_id
  returning * into v;
  return v;
exception
  when data_exception or check_violation then
    perform private.fail('invalid_input');
end $$;

------------------------------------------------------------------------
-- 前年度の数（読み取り専用。在庫入力の「前年の数」、休憩所の申請の初期値）
------------------------------------------------------------------------
create function public.previous_year_stocks(p_year_id uuid)
returns table (room_id uuid, item_id uuid, count integer)
language plpgsql stable security definer set search_path = '' as $$
begin
  perform private.assert_role(p_year_id, '{admin,staff}');
  return query
    select s.room_id, s.item_id, s.count
    from public.years y join public.stocks s on s.year_id = y.prev_year_id
    where y.id = p_year_id;
end $$;

create function public.previous_year_requests(p_year_id uuid)
returns table (group_name text, item_id uuid, count integer)
language plpgsql stable security definer set search_path = '' as $$
begin
  perform private.assert_role(p_year_id, '{admin}');
  return query
    select g.name, r.item_id, r.count
    from public.years y
    join public.groups g on g.year_id = y.prev_year_id
    join public.requests r on r.group_id = g.id
    where y.id = p_year_id;
end $$;

------------------------------------------------------------------------
-- 権限
------------------------------------------------------------------------
revoke all on all functions in schema private from public;
do $$
declare f text;
begin
  foreach f in array array[
    'public.save_auto_allocations(uuid, jsonb, text, integer)',
    'public.save_allocation_rows(uuid, jsonb, text)',
    'public.set_consent(uuid, uuid, uuid, public.consent_status, text)',
    'public.update_requests_after_deadline(uuid, jsonb, text, jsonb)',
    'public.submit_requests(uuid, jsonb, text)',
    'public.check_delivery(uuid, public.delivery_status, text, boolean)',
    'public.previous_year_stocks(uuid)',
    'public.previous_year_requests(uuid)'] loop
    execute format('revoke all on function %s from public, anon', f);
    execute format('grant execute on function %s to authenticated', f);
  end loop;
end $$;
