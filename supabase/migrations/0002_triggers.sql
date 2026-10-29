-- 0002_triggers.sql（T02）：private スキーマ・共通関数・トリガー
create schema private;
revoke all on schema private from public;

-- エラーを返す共通関数（message にコード、detail に JSON）
create function private.fail(p_code text, p_detail jsonb default null)
returns void language plpgsql set search_path = '' as $$
begin
  raise exception using errcode = 'P0001', message = p_code, detail = coalesce(p_detail::text, '');
end $$;

-- updated_at・created_at
create function private.tg_set_timestamps()
returns trigger language plpgsql set search_path = '' as $$
begin
  if tg_op = 'INSERT' then
    new.created_at := now();
  else
    new.created_at := old.created_at;
  end if;
  new.updated_at := now();
  return new;
end $$;

do $$
declare t text;
begin
  foreach t in array array['years','rooms','room_years','items','stocks','groups','year_roles','group_members',
    'invitations','request_submissions','requests','rules','substitution_consents','allocations',
    'distance_overrides','slots','deliveries','profiles'] loop
    execute format('create trigger set_timestamps before insert or update on public.%I
                    for each row execute function private.tg_set_timestamps()', t);
  end loop;
end $$;

-- 監査（K-16：SECURITY DEFINER。tg_argv[0] は主キーの列名をカンマ区切りで）
create function private.tg_audit()
returns trigger language plpgsql security definer set search_path = '' as $$
declare
  v_before jsonb;
  v_after  jsonb;
  v_row    jsonb;
  v_pk     jsonb;
  v_ignore constant text[] := array['updated_at', 'allocation_version', 'auto_allocated_at'];
begin
  if tg_op <> 'INSERT' then v_before := to_jsonb(old); end if;
  if tg_op <> 'DELETE' then v_after  := to_jsonb(new); end if;
  if tg_op = 'UPDATE' and (v_before - v_ignore) = (v_after - v_ignore) then
    return null;                                   -- 版や updated_at だけの変更は記録しない
  end if;
  v_row := coalesce(v_after, v_before);
  select jsonb_object_agg(c, v_row -> c) into v_pk
  from unnest(string_to_array(tg_argv[0], ',')) as c;

  insert into public.audit_logs (table_name, row_pk, action, year_id, group_id, before, after, reason, user_id)
  values (
    tg_table_name, v_pk, lower(tg_op),
    coalesce((v_row ->> 'year_id')::uuid,
             case when tg_table_name = 'years' then (v_row ->> 'id')::uuid end,
             (select g.year_id from public.groups g where g.id = (v_row ->> 'group_id')::uuid),
             -- 団体の連鎖削除で団体がもう引けないときは、groups の削除前のトリガーが置いた年度を使う
             (nullif(current_setting('app.deleted_group_years', true), '')::jsonb ->> (v_row ->> 'group_id'))::uuid),
    case when tg_table_name = 'groups' then (v_row ->> 'id')::uuid else (v_row ->> 'group_id')::uuid end,
    v_before, v_after,
    nullif(current_setting('app.reason', true), ''),
    auth.uid()
  );
  return null;
end $$;

do $$
declare r record;
begin
  for r in select * from (values
      ('years', 'id'), ('rooms', 'id'), ('items', 'id'), ('distance_overrides', 'building_a,building_b'),
      ('room_years', 'year_id,room_id'), ('stocks', 'year_id,room_id,item_id'), ('groups', 'id'),
      ('year_roles', 'year_id,user_id'), ('group_members', 'group_id,user_id'),
      ('request_submissions', 'group_id'), ('requests', 'group_id,item_id'), ('rules', 'id'),
      ('substitution_consents', 'group_id,from_item_id,to_item_id'), ('allocations', 'id')
    ) as v(t, pk) loop
    execute format('create trigger audit after insert or update or delete on public.%I
                    for each row execute function private.tg_audit(%L)', r.t, r.pk);
  end loop;
end $$;

-- 建物の組の向き：C の照合順序（コードポイント順）で小さい方を building_a に入れ替える。
-- DB の照合順序や JavaScript の並べ替えに依存せず、呼ぶ側は順序を気にしなくてよい（同じ建物どうしは CHECK で拒否）
create function private.tg_distance_overrides_normalize()
returns trigger language plpgsql set search_path = '' as $$
declare v_a text;
begin
  if new.building_a collate "C" > new.building_b collate "C" then
    v_a := new.building_a;
    new.building_a := new.building_b;
    new.building_b := v_a;
  end if;
  return new;
end $$;
create trigger normalize_pair before insert or update on public.distance_overrides
  for each row execute function private.tg_distance_overrides_normalize();

-- 残すの整合（E005）：is_keep の行は運び元＝団体の使用場所
create function private.tg_allocations_check_keep()
returns trigger language plpgsql security definer set search_path = '' as $$
declare v_loc uuid;
begin
  if new.is_keep then
    select g.location_room_id into v_loc from public.groups g where g.id = new.group_id;
    if v_loc is distinct from new.source_room_id then
      perform private.fail('E005', jsonb_build_object('group_id', new.group_id, 'source_room_id', new.source_room_id));
    end if;
  end if;
  return new;
end $$;
create trigger check_keep before insert or update of is_keep, source_room_id, group_id on public.allocations
  for each row execute function private.tg_allocations_check_keep();

-- 申請できる品目（D-05：企業以外の長机(3人掛)は例外。0 台は通す）
create function private.tg_requests_check_requestable()
returns trigger language plpgsql security definer set search_path = '' as $$
declare
  v_category public.group_category;
  v_code text;
  v_categories public.group_category[];
begin
  if new.count = 0 then return new; end if;
  select g.category into v_category from public.groups g where g.id = new.group_id;
  select i.code, i.requestable_categories into v_code, v_categories from public.items i where i.id = new.item_id;
  if v_category is null or v_code is null then
    return new;                                    -- 団体・品目がなければ外部キーのエラー（23503）に任せる
  end if;
  if v_category = any (v_categories) or v_code = 'long_desk_3' then
    return new;
  end if;
  perform private.fail('E006', jsonb_build_object('group_id', new.group_id, 'item_id', new.item_id));
  return null;
end $$;
create trigger check_requestable before insert or update of group_id, item_id, count on public.requests
  for each row execute function private.tg_requests_check_requestable();

-- 数えた人・日時（K-25）：ログイン中の書き込みは DB が上書きする
create function private.tg_stocks_set_counted()
returns trigger language plpgsql set search_path = '' as $$
begin
  if auth.uid() is not null then
    new.counted_by := auth.uid();
    new.counted_at := now();
  end if;
  return new;
end $$;
create trigger set_counted before insert or update on public.stocks
  for each row execute function private.tg_stocks_set_counted();

-- 提出の記録：updated_by と submitted_at は DB が入れる
create function private.tg_submissions_set_actor()
returns trigger language plpgsql set search_path = '' as $$
begin
  if auth.uid() is not null then
    new.updated_by := auth.uid();
    if new.submitted_at is not null
       and (tg_op = 'INSERT' or old.submitted_at is null or new.submitted_at is distinct from old.submitted_at) then
      new.submitted_at := now();
    end if;
  end if;
  return new;
end $$;
create trigger set_actor before insert or update on public.request_submissions
  for each row execute function private.tg_submissions_set_actor();

-- 守りのトリガーと submit_requests が、年度の行をロックして状態を返す（確定の RPC と順に処理するため。行がなければ null）
-- ロックの強さ：
--   allocating：同じ文の後で版の増分（years の update）が同じ行を更新するので、最初から for no key update を取る。
--     for share を持ったまま後で引き上げると、2つのセッションが share を持ったまま相手を待ち、デッドロック（40P01）になる。
--   それ以外：for share（版を増やさないので引き上げが起きない。部員の在庫入力どうしは並行に進む）。
--     ただし nowait で取り、誰かが for no key update を持っている（状態の遷移や書き込みの RPC の途中）ときは、
--     for no key update で待つ。待った後に allocating になっていても、引き上げずに済む。
--   share を取れた後の状態が allocating のとき（ロックなしで読んだ直後に遷移がコミットされた）だけ引き上げる。
--     2つのセッションがこの数マイクロ秒に重なったときだけ 40P01 になり得る（画面はもう一度保存する。11 章）。
create function private.lock_year_guard(p_year_id uuid)
returns public.year_status language plpgsql security definer set search_path = '' as $$
declare
  v_status public.year_status;
  v_done boolean := false;
begin
  select y.status into v_status from public.years y where y.id = p_year_id;     -- ロックなしで見る
  if not found then
    return null;                                   -- 年度ごと消しているとき（連鎖削除）は行が見えない
  end if;
  if v_status <> 'allocating' then
    begin
      select y.status into v_status from public.years y where y.id = p_year_id for share nowait;
      if not found then
        return null;
      end if;
      v_done := v_status <> 'allocating';
    exception when lock_not_available then
      null;                                        -- 遷移や RPC の途中。下で for no key update を待つ
    end;
  end if;
  if not v_done then
    select y.status into v_status from public.years y where y.id = p_year_id for no key update;
  end if;
  return v_status;
end $$;

-- 確定中・終了の年度では、振り分けの前提を崩す書き込みを止める（E001・E002・E005 が確定後に生じないように）
-- 年度の行をロックしてから状態を読むので（lock_year_guard）、set_year_status（for no key update）と同時に走っても順に処理される。
-- 年度ごと消すとき（連鎖削除）は年度の行がもう見えず、状態が null になるので止めない。
create function private.tg_groups_before_write()
returns trigger language plpgsql security definer set search_path = '' as $$
declare v_status public.year_status := private.lock_year_guard(old.year_id);
begin
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
create trigger guard_confirmed before update or delete on public.groups
  for each row execute function private.tg_groups_before_write();

create function private.tg_room_years_guard()
returns trigger language plpgsql security definer set search_path = '' as $$
declare v_status public.year_status := private.lock_year_guard(new.year_id);
begin
  if v_status in ('confirmed', 'closed') and not new.usable
     and exists (select 1 from public.allocations a where a.year_id = new.year_id and a.source_room_id = new.room_id) then
    perform private.fail('invalid_state', jsonb_build_object('status', v_status, 'code', 'E002', 'room_id', new.room_id));
  end if;
  return new;
end $$;
create trigger guard_confirmed before insert or update on public.room_years
  for each row execute function private.tg_room_years_guard();

create function private.tg_stocks_guard()
returns trigger language plpgsql security definer set search_path = '' as $$
declare
  v_status public.year_status := private.lock_year_guard(old.year_id);
  v_count integer := 0;
  v_allocated integer;
begin
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
create trigger guard_confirmed before update or delete on public.stocks
  for each row execute function private.tg_stocks_guard();

-- ルール：year_id は作った後に変えられない。closed の年度のルールは memo だけ直せる（01 の「ルールの見直し点をメモに残す」）
create function private.tg_rules_guard()
returns trigger language plpgsql security definer set search_path = '' as $$
begin
  if new.year_id is distinct from old.year_id then
    perform private.fail('invalid_input', jsonb_build_object('column', 'year_id', 'reason', 'immutable'));
  end if;
  if (select y.status from public.years y where y.id = old.year_id) = 'closed'
     and (to_jsonb(new) - '{memo,created_at,updated_at}'::text[]) is distinct from (to_jsonb(old) - '{memo,created_at,updated_at}'::text[]) then
    perform private.fail('invalid_state', jsonb_build_object('status', 'closed', 'reason', 'memo_only'));
  end if;
  return new;
end $$;
create trigger guard_rules before update on public.rules
  for each row execute function private.tg_rules_guard();

-- 年度・団体の付け替えを止める：行を別の年度（や団体）へ動かすと、確定中・closed の守りと版の増分が新しい行の年度しか見ず、
-- 確定中の年度から振り分けを抜き出せる。年度を持つ表の year_id と、団体を主キーに含む表の group_id は作った後に変えられない
-- （rules.year_id と同じ。rules は下の tg_rules_guard）。allocations・deliveries・invitations の group_id は、複合外部キーで
-- 年度が固定されるので同じ年度の中でしか動かせない。トリガーは名前順に動くので、名前を check_ で始めて guard_confirmed より先に止める。
create function private.tg_immutable_columns()
returns trigger language plpgsql set search_path = '' as $$
declare c text;
begin
  foreach c in array tg_argv loop
    if to_jsonb(new) -> c is distinct from to_jsonb(old) -> c then
      perform private.fail('invalid_input', jsonb_build_object('column', c, 'reason', 'immutable'));
    end if;
  end loop;
  return new;
end $$;

do $$
declare r record;
begin
  for r in select * from (values
      ('room_years', 'year_id'), ('stocks', 'year_id'), ('groups', 'year_id'), ('year_roles', 'year_id'),
      ('invitations', 'year_id'), ('allocations', 'year_id'), ('slots', 'year_id'), ('deliveries', 'year_id'),
      ('group_members', 'group_id'), ('request_submissions', 'group_id'), ('requests', 'group_id'),
      ('substitution_consents', 'group_id')
    ) as v(t, col) loop
    execute format('create trigger check_immutable before update of %I on public.%I
                    for each row execute function private.tg_immutable_columns(%L)', r.col, r.t, r.col);
  end loop;
end $$;

-- allocation_version の増分（P-01）。allocate の入力と結果になる表が、振り分け中（allocating）の年度で変わるたびに増やす。
-- 文単位・遷移表で、1文につき年度ごとに1回だけ増やす。allocating 以外の年度は増やさない（受付中の大量の書き込みで年度の行を取り合わない）。
-- allocations は確定中・終了の年度では変えられない（RPC の状態確認に加えた、最後の守り）。
create function private.tg_bump_allocation_version()
returns trigger language plpgsql security definer set search_path = '' as $$
begin
  if tg_table_name in ('rooms', 'items', 'distance_overrides') then
    if exists (select 1 from changed_rows) then
      update public.years y set allocation_version = y.allocation_version + 1 where y.status = 'allocating';
    end if;
  elsif tg_table_name in ('requests', 'request_submissions', 'substitution_consents') then
    update public.years y set allocation_version = y.allocation_version + 1
    where y.status = 'allocating'
      and y.id in (select g.year_id from changed_rows c join public.groups g on g.id = c.group_id);
  else
    if tg_table_name = 'allocations' and exists (
         select 1 from changed_rows c join public.years y on y.id = c.year_id where y.status in ('confirmed', 'closed')) then
      perform private.fail('invalid_state', jsonb_build_object('reason', 'confirmed'));
    end if;
    update public.years y set allocation_version = y.allocation_version + 1
    where y.status = 'allocating' and y.id in (select c.year_id from changed_rows c);
  end if;
  return null;
end $$;

do $$
declare t text;
begin
  foreach t in array array['allocations', 'substitution_consents', 'requests', 'request_submissions', 'stocks',
                           'room_years', 'groups', 'rules', 'rooms', 'items', 'distance_overrides'] loop
    execute format('create trigger bump_version_ins after insert on public.%I referencing new table as changed_rows
                    for each statement execute function private.tg_bump_allocation_version()', t);
    execute format('create trigger bump_version_upd after update on public.%I referencing new table as changed_rows
                    for each statement execute function private.tg_bump_allocation_version()', t);
    execute format('create trigger bump_version_del after delete on public.%I referencing old table as changed_rows
                    for each statement execute function private.tg_bump_allocation_version()', t);
  end loop;
end $$;

revoke all on all functions in schema private from public;
