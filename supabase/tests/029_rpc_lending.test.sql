-- 029_rpc_lending：テント等の貸し出しの RPC（save_lending_assignments・set_lending_confirmed・previous_year_lending_items）と、
-- 権限表の外の読み書き（T21。D-57。0018_lending.sql）
-- 期待値は 02 の「テント等の貸し出しの権限」と notes/T21.md の「SQL の約束」（save_lending_assignments のエラーの順番 1〜5、
-- set_lending_confirmed の 1〜7、previous_year_lending_items）から先に書いてから流した。
-- ⓪ 年度ごとの勧告的ロック：どの書き込みが取り、どれが取らないか（取った文を副トランザクションの中で調べて取り消す）。
-- ① 段の表：RPC を admin・head・deputy・staff・viewer・rep・outsider・admin2 で1回ずつ試して取り消す（025 と同じ形。準備の SQL〔prep〕を
--    postgres で先に流せる）。yn は列の順（admin head staff viewer rep outsider admin2）に、空白で区切った7つの結果。deputy は head の列で
--    確かめ、実際の結果どうしも比べる。略号：ok、F＝forbidden、IS＝invalid_state、II＝invalid_input、CF＝conflict、RR＝reason_required。
-- ② 読み取り：割り当ての確定の前に、ペルソナごとに見える割り当てと確定の印（確定の後と解除の後は ④ で）。
-- ③ save_lending_assignments：エラーの順番と detail（forbidden → invalid_state → invalid_input → conflict）、入力の形、楽観ロック
--    （ミリ秒まで）、全部か何も、保存の中身（返り値・行・書いた人・監査の理由・送り直し）、在庫超過と企業への割り当て、版を増やさない。
-- ④ set_lending_confirmed：エラーの順番と detail、解除の理由と中身、締切の後の読み方、在庫超過と未入力（備品の並び）、確定の中身
--    （行・監査の理由）、確定中の保存と在庫の守り、確定の後・解除の後に見える割り当て（RLS の確定後の枝）、版を増やさない。
-- ⑤ previous_year_lending_items：並び・列・前年度のロールが要らない・前年度がない・終了の年度。
-- ⑥ not_found と forbidden：ない年度とロールのない年度、ほかの年度の団体・備品とない団体・備品を同じに返す（有無を漏らさない）。
-- ⑦ 権限表の外の直接の書き込み：書いた人（set_actor）、画面の id の送り直し、書けない人の upsert（42501）と update（0 行）、申請できる
--    区分を書けない人に漏らさない、在庫の守り、参照のある備品の削除、can_record_lending、両方の年度の管理者でも年度を変えられない、anon。
-- ⑧ 例外の読み替え（D-19）：確かめた後に団体が消えた（外部キー）・同じ行が足された（一意）・CHECK 違反を、生の SQLSTATE でなく
--    invalid_input・conflict で返す（テストの中だけのトリガーで重なりを作る）。
-- ペルソナ（fixture）：admin・head・deputy・staff・viewer は Y1 のロール。rep は G1（Y1）の店長で Y2 の viewer、rep2 は G2（Y1）の店長、
-- viewer は G4（Y1）の副店長も兼ねる。staff は G3（Y2）の店長（Y2 では総務でない）。admin2 は Y2（preparing）の admin。outsider は何もない。
-- テント等（fixture）：Y1 は受付中・割り当ての確定前（備品 LI_TENT〔在庫 3。模擬店・部門〕・LI_WEIGHT〔20〕・LI_CURTAIN〔2。模擬店〕・
-- LI_SPARE〔5〕、申請 G1×テント 2・G2×テント 2・G1×重し 8・G1×三方幕 1、割り当て G1×テント 2・G1×重し 8）。Y2 は確定後（LI_Y2_TENT〔2〕、
-- G3 の申請・割り当て・記録が1つずつ）。029 だけで、Y1 に企業の団体 T-G5 を足す。
begin;
\ir _helpers/personas.psql
\ir _helpers/fixture.psql

-- 029 だけで使う企業の団体（申請できる区分にないが、割り当てには入れられる）
with g as (insert into public.groups (year_id, name, category, sort_order) values (tests.id('Y1'), 'T-G5', 'company', 5) returning id)
insert into tests.ids select 'G5', id from g;

-- 割り当ての1件（save_lending_assignments の p_changes の要素）
create function tests.ch(p_group text, p_item text, p_count integer, p_updated_at text default null) returns jsonb language sql stable as $$
  select jsonb_build_object('groupId', tests.id(p_group), 'itemId', tests.id(p_item), 'count', p_count, 'updatedAt', p_updated_at)
$$;
-- 割り当ての今の版（受け取ったままの文字列。RLS を通らない：段の表で、読めない人にも同じ引数を渡すため）
create function tests.ver_a(p_group text, p_item text) returns text language sql stable security definer set search_path = '' as $$
  select to_jsonb(a.updated_at) #>> '{}' from public.lending_assignments a
  where a.group_id = (select t.id from tests.ids t where t.name = p_group)
    and a.lending_item_id = (select t.id from tests.ids t where t.name = p_item)
$$;
-- tests.ids の名前（なければ ?）
create function tests.nm(p_id uuid) returns text language sql stable as $$
  select coalesce((select t.name from tests.ids t where t.id = p_id order by t.name limit 1), '?')
$$;
-- ':名前' を uuid（引用なし）に置き換えて jsonb にする（エラーの detail の期待値用）
create function tests.j(p_template text) returns jsonb language plpgsql stable as $$
declare r record; v text := p_template;
begin
  for r in select name, id from tests.ids order by length(name) desc loop
    v := replace(v, ':' || r.name, r.id::text);
  end loop;
  return v::jsonb;
end $$;
-- ペルソナ（null なら postgres のまま、anon は anon）で SQL を1回流し、エラーのコードと detail を返して必ず取り消す。成功なら {"code": "ok"}。
-- P0001 でないエラーは {"code": "error:<SQLSTATE>"}
create function tests.rpc_error(p_persona text, p_sql text) returns jsonb language plpgsql as $$
declare v jsonb; v_msg text; v_detail text; v_state text;
begin
  begin
    if p_persona = 'anon' then perform tests.login_anon();
    elsif p_persona is not null then perform tests.login_as(p_persona);
    end if;
    execute tests.sql(p_sql);
    v := jsonb_build_object('code', 'ok');
    raise exception using errcode = 'TT001';
  exception
    when sqlstate 'TT001' then null;
    when others then
      get stacked diagnostics v_msg = message_text, v_detail = pg_exception_detail, v_state = returned_sqlstate;
      v := case when v_state = 'P0001' then jsonb_build_object('code', v_msg, 'detail', nullif(v_detail, '')::jsonb)
                else jsonb_build_object('code', 'error:' || v_state) end;
  end;
  return v;
end $$;
-- ペルソナで SQL を流して1つ目の値を返し、必ず取り消す（エラーは「ERR コード 詳細」）
create function tests.q_as(p_persona text, p_sql text) returns text language plpgsql as $$
declare v text; v_msg text; v_detail text; v_state text;
begin
  begin
    if p_persona = 'anon' then perform tests.login_anon();
    elsif p_persona is not null then perform tests.login_as(p_persona);
    end if;
    execute tests.sql(p_sql) into v;
    raise exception using errcode = 'TT001';
  exception
    when sqlstate 'TT001' then null;
    when others then
      get stacked diagnostics v_msg = message_text, v_detail = pg_exception_detail, v_state = returned_sqlstate;
      v := 'ERR ' || case when v_state = 'P0001' then v_msg || coalesce(' ' || nullif(v_detail, ''), '') else v_state end;
  end;
  return v;
end $$;
-- ペルソナで SQL を流して1つ目の値を返し、成功したら残す（エラーの文だけ取り消す。エラーは「ERR コード 詳細」）
create function tests.do_as(p_persona text, p_sql text) returns text language plpgsql as $$
declare v text; v_msg text; v_detail text; v_state text;
begin
  if p_persona is not null then perform tests.login_as(p_persona); end if;
  begin
    execute tests.sql(p_sql) into v;
  exception when others then
    get stacked diagnostics v_msg = message_text, v_detail = pg_exception_detail, v_state = returned_sqlstate;
    v := 'ERR ' || case when v_state = 'P0001' then v_msg || coalesce(' ' || nullif(v_detail, ''), '') else v_state end;
  end;
  perform tests.logout();
  return v;
end $$;
-- 年度ごとの勧告的ロックをこのセッションが持っているか（int4 の鍵2つ。pg_locks の classid・objid は符号なし）
create function tests.lending_lock_held(p_year text) returns text language sql as $$
  select count(*)::text from pg_locks l
  where l.locktype = 'advisory' and l.pid = pg_backend_pid() and l.objsubid = 2 and l.granted
    and l.classid::text::bigint = (hashtext('gaapp.lending')::bigint + 4294967296) % 4294967296
    and l.objid::text::bigint = (hashtext(tests.id(p_year)::text)::bigint + 4294967296) % 4294967296
$$;
-- ペルソナで SQL を流した直後に、Y1・Y2 のロックを持っているかを返して取り消す
create function tests.lock_after(p_persona text, p_sql text) returns text language plpgsql as $$
declare v text;
begin
  begin
    perform tests.login_as(p_persona);
    execute tests.sql(p_sql);
    perform tests.logout();
    v := format('Y1=%s Y2=%s', tests.lending_lock_held('Y1'), tests.lending_lock_held('Y2'));
    raise exception using errcode = 'TT001';
  exception
    when sqlstate 'TT001' then null;
    when others then v := 'ERR ' || sqlstate || ' ' || sqlerrm;
  end;
  return v;
end $$;
-- ペルソナに見える割り当て（団体x備品）と確定の印（年度。confirmed_at が null なら「(解除)」）
create function tests.visible_lending(p_persona text) returns text language plpgsql as $$
declare v text;
begin
  perform tests.login_as(p_persona);
  select format('%s | %s',
    coalesce((select string_agg(tests.nm(a.group_id) || 'x' || tests.nm(a.lending_item_id), ' '
                                order by tests.nm(a.group_id) collate "C", tests.nm(a.lending_item_id) collate "C")
              from public.lending_assignments a), '-'),
    coalesce((select string_agg(tests.nm(ly.year_id) || case when ly.confirmed_at is null then '(解除)' else '' end, ' '
                                order by tests.nm(ly.year_id) collate "C")
              from public.lending_years ly), '-'))
  into v;
  perform tests.logout();
  return v;
end $$;
create function tests.visible_lending_all() returns text language sql as $$
  select string_agg(x.p || '=' || tests.visible_lending(x.p), ' ; ' order by x.o)
  from unnest(array['admin', 'head', 'deputy', 'staff', 'viewer', 'rep', 'rep2', 'outsider', 'admin2']) with ordinality as x(p, o)
$$;
-- 呼んだ人が記録を書けるか（private.can_record_lending）
create function tests.can_record(p_persona text, p_year text) returns text language plpgsql as $$
declare v text;
begin
  perform tests.login_as(p_persona);
  v := private.can_record_lending(tests.id(p_year))::text;
  perform tests.logout();
  return v;
end $$;
-- 段の表：p_scenario で Y1 の状態を決め、p_prep を postgres で流してから、ペルソナで RPC を1回試して取り消す（tests.try_rpc に準備を足した形）
create function tests.try_rpc_prep(p_persona text, p_prep text, p_sql text, p_scenario text) returns text language plpgsql as $$
declare v_result text;
begin
  begin
    perform tests.set_scenario(p_scenario);
    if p_prep is not null then execute p_prep; end if;
    perform tests.login_as(p_persona);
    execute p_sql;
    v_result := 'ok';
    raise exception using errcode = 'TT001';
  exception
    when sqlstate 'TT001' then null;
    when sqlstate 'P0001' then v_result := sqlerrm;
    when others then v_result := 'error:' || sqlstate || ' ' || sqlerrm;
  end;
  return v_result;
end $$;
grant execute on all functions in schema tests to authenticated, anon;

-- ================================================================ ① 段の表
create table tests.rpc_case (n int primary key, label text not null, scenario text not null, prep text, template text not null, yn text not null);
insert into tests.rpc_case values
 -- 割り当てを保存する：部門長以上だけ。年度の状態（準備中〜机椅子の確定中）によらず保存できる。終了の年度とテント等の割り当ての確定中は
 -- invalid_state（部門長以上でなければ forbidden が先）
 ( 1, '割り当てを保存する（受付中）', 'requesting', null,
  $t$ select public.save_lending_assignments(:Y1, jsonb_build_array(tests.ch('G2', 'LI_TENT', 1))) $t$, 'ok ok F F F F F'),
 ( 2, '割り当てを保存する（準備中）', 'preparing', null,
  $t$ select public.save_lending_assignments(:Y1, jsonb_build_array(tests.ch('G2', 'LI_TENT', 1))) $t$, 'ok ok F F F F F'),
 ( 3, '割り当てを保存する（締切後）', 'requesting:after', null,
  $t$ select public.save_lending_assignments(:Y1, jsonb_build_array(tests.ch('G2', 'LI_TENT', 1))) $t$, 'ok ok F F F F F'),
 ( 4, '割り当てを保存する（振り分け中）', 'allocating', null,
  $t$ select public.save_lending_assignments(:Y1, jsonb_build_array(tests.ch('G2', 'LI_TENT', 1))) $t$, 'ok ok F F F F F'),
 ( 5, '割り当てを保存する（机椅子の確定中）', 'confirmed', null,
  $t$ select public.save_lending_assignments(:Y1, jsonb_build_array(tests.ch('G2', 'LI_TENT', 1))) $t$, 'ok ok F F F F F'),
 ( 6, '割り当てを保存する（終了）', 'closed', null,
  $t$ select public.save_lending_assignments(:Y1, jsonb_build_array(tests.ch('G2', 'LI_TENT', 1))) $t$, 'IS IS F F F F F'),
 ( 7, '割り当てを保存する（Y1 のテント等の確定中）', 'requesting:after',
  $p$ insert into public.lending_years (year_id, confirmed_at, confirmed_by) values (:Y1, now(), :head) $p$,
  $t$ select public.save_lending_assignments(:Y1, jsonb_build_array(tests.ch('G2', 'LI_TENT', 1))) $t$, 'IS IS F F F F F'),
 ( 8, 'Y2 の割り当てを保存する（テント等の確定中）', 'requesting', null,
  $t$ select public.save_lending_assignments(:Y2, jsonb_build_array(tests.ch('G3', 'LI_Y2_TENT', 2, tests.ver_a('G3', 'LI_Y2_TENT')))) $t$,
  'F F F F F F IS'),
 ( 9, 'Y2 の割り当てを保存する（解除の後）', 'requesting',
  $p$ update public.lending_years set confirmed_at = null, confirmed_by = null where year_id = :Y2 $p$,
  $t$ select public.save_lending_assignments(:Y2, jsonb_build_array(tests.ch('G3', 'LI_Y2_TENT', 2, tests.ver_a('G3', 'LI_Y2_TENT')))) $t$,
  'F F F F F F ok'),
 (10, 'ない年度に保存する', 'requesting', null,
  $t$ select public.save_lending_assignments(gen_random_uuid(), jsonb_build_array(tests.ch('G2', 'LI_TENT', 1))) $t$, 'F F F F F F F'),
 (11, 'ほかの年度（Y2）の団体を Y1 に保存する', 'requesting', null,
  $t$ select public.save_lending_assignments(:Y1, jsonb_build_array(tests.ch('G3', 'LI_TENT', 1))) $t$, 'II II F F F F F'),
 (12, 'ない団体を保存する', 'requesting', null,
  $t$ select public.save_lending_assignments(:Y1, jsonb_build_array(jsonb_build_object('groupId', gen_random_uuid(), 'itemId', :LI_TENT,
        'count', 1, 'updatedAt', null))) $t$, 'II II F F F F F'),
 (13, '古い版で直す', 'requesting', null,
  $t$ select public.save_lending_assignments(:Y1, jsonb_build_array(tests.ch('G1', 'LI_TENT', 3, '2000-01-01T00:00:00Z'))) $t$, 'CF CF F F F F F'),
 (14, '今の版で直す', 'requesting', null,
  $t$ select public.save_lending_assignments(:Y1, jsonb_build_array(tests.ch('G1', 'LI_TENT', 3, tests.ver_a('G1', 'LI_TENT')))) $t$,
  'ok ok F F F F F'),
 -- 確定する・確定を解除する：部門長以上だけ。確定は締切の後で、在庫超過と未入力がないとき。解除は理由が要る
 (15, '確定する（受付中の締切前）', 'requesting', null, $t$ select public.set_lending_confirmed(:Y1, true) $t$, 'IS IS F F F F F'),
 (16, '確定する（締切後。未入力が残る）', 'requesting:after', null, $t$ select public.set_lending_confirmed(:Y1, true) $t$, 'IS IS F F F F F'),
 (17, '確定する（締切後。全部入れた）', 'requesting:after',
  $p$ insert into public.lending_assignments (group_id, lending_item_id, year_id, count) values (:G2, :LI_TENT, :Y1, 1), (:G1, :LI_CURTAIN, :Y1, 1) $p$,
  $t$ select public.set_lending_confirmed(:Y1, true) $t$, 'ok ok F F F F F'),
 (18, '確定する（振り分け中。全部入れた）', 'allocating',
  $p$ insert into public.lending_assignments (group_id, lending_item_id, year_id, count) values (:G2, :LI_TENT, :Y1, 1), (:G1, :LI_CURTAIN, :Y1, 1) $p$,
  $t$ select public.set_lending_confirmed(:Y1, true) $t$, 'ok ok F F F F F'),
 (19, '確定する（机椅子の確定中。全部入れた）', 'confirmed',
  $p$ insert into public.lending_assignments (group_id, lending_item_id, year_id, count) values (:G2, :LI_TENT, :Y1, 1), (:G1, :LI_CURTAIN, :Y1, 1) $p$,
  $t$ select public.set_lending_confirmed(:Y1, true) $t$, 'ok ok F F F F F'),
 (20, '確定する（終了。全部入れた）', 'closed',
  $p$ insert into public.lending_assignments (group_id, lending_item_id, year_id, count) values (:G2, :LI_TENT, :Y1, 1), (:G1, :LI_CURTAIN, :Y1, 1) $p$,
  $t$ select public.set_lending_confirmed(:Y1, true) $t$, 'IS IS F F F F F'),
 (21, '確定する（Y2 は確定中）', 'requesting', null, $t$ select public.set_lending_confirmed(:Y2, true) $t$, 'F F F F F F IS'),
 (22, '確定を解除する（Y1 は確定前）', 'requesting', null, $t$ select public.set_lending_confirmed(:Y1, false, 'T-理由') $t$, 'IS IS F F F F F'),
 (23, '確定を解除する（Y1 の確定中）', 'requesting:after',
  $p$ insert into public.lending_years (year_id, confirmed_at, confirmed_by) values (:Y1, now(), :head) $p$,
  $t$ select public.set_lending_confirmed(:Y1, false, 'T-理由') $t$, 'ok ok F F F F F'),
 (24, '確定を解除する（理由なし）', 'requesting:after',
  $p$ insert into public.lending_years (year_id, confirmed_at, confirmed_by) values (:Y1, now(), :head) $p$,
  $t$ select public.set_lending_confirmed(:Y1, false) $t$, 'RR RR F F F F F'),
 (25, '確定を解除する（Y2）', 'requesting', null, $t$ select public.set_lending_confirmed(:Y2, false, 'T-理由') $t$, 'F F F F F F ok'),
 (26, 'ない年度を確定する', 'requesting', null, $t$ select public.set_lending_confirmed(gen_random_uuid(), true) $t$, 'F F F F F F F'),
 -- 前年度の備品を読む：部門長以上だけ（年度の状態によらない）
 (27, '前年度の備品を読む', 'requesting', null, $t$ select count(*) from public.previous_year_lending_items(:Y1) $t$, 'ok ok F F F F F'),
 (28, '前年度の備品を読む（終了）', 'closed', null, $t$ select count(*) from public.previous_year_lending_items(:Y1) $t$, 'ok ok F F F F F'),
 (29, 'Y2 の前年度の備品を読む', 'requesting', null, $t$ select count(*) from public.previous_year_lending_items(:Y2) $t$, 'F F F F F F ok'),
 (30, 'ない年度の前年度の備品を読む', 'requesting', null,
  $t$ select count(*) from public.previous_year_lending_items(gen_random_uuid()) $t$, 'F F F F F F F');

-- ペルソナと期待値の列。deputy は head の列で確かめる（総務副部門長の権限は総務部門長と同じ。D-48）
create table tests.rpc_persona (persona text primary key, col int not null, ord int not null unique);
insert into tests.rpc_persona values
  ('admin', 1, 1), ('head', 2, 2), ('deputy', 2, 3), ('staff', 3, 4), ('viewer', 4, 5), ('rep', 5, 6), ('outsider', 6, 7), ('admin2', 7, 8);

create view tests.rpc_cells as
select c.n, c.label, c.scenario, p.persona, p.ord,
       case split_part(c.yn, ' ', p.col)
         when 'F' then 'forbidden' when 'IS' then 'invalid_state' when 'II' then 'invalid_input'
         when 'CF' then 'conflict' when 'RR' then 'reason_required' else split_part(c.yn, ' ', p.col) end as expected,
       tests.sql(c.prep) as prep, tests.sql(c.template) as sql
from tests.rpc_case c cross join tests.rpc_persona p;

select plan((select count(*)::int from tests.rpc_cells) + 3 + 134);

-- ================================================================ ⓪ 年度ごとの勧告的ロック
-- 割り当ての保存・確定と解除・在庫を減らす更新（guard_stock）は、その年度の勧告的ロックを取る。在庫を増やす・変えない更新、書けない人の
-- 更新、前年度の備品の読み取り、申請と記録の直接の書き込みは取らない（0018 の「年度ごとのロック」）。years の行はロックしない
select is(tests.lending_lock_held('Y1') || tests.lending_lock_held('Y2'), '00', '始める前は、どちらの年度のロックも持っていない');
select is(tests.lock_after('head', $q$ select public.save_lending_assignments(:Y1, jsonb_build_array(tests.ch('G2', 'LI_TENT', 1))) $q$),
  'Y1=1 Y2=0', '割り当ての保存は、その年度のロックを取る（ほかの年度は取らない）');
select is(tests.lock_after('admin2', $q$ select public.set_lending_confirmed(:Y2, false, 'T-理由') $q$),
  'Y1=0 Y2=1', '確定の解除は、その年度のロックを取る');
select is(tests.lock_after('head', $q$ update public.lending_items set stock = 2 where id = :LI_TENT $q$),
  'Y1=1 Y2=0', '在庫を減らす更新は、その年度のロックを取る（guard_stock）');
select is(tests.lock_after('head', $q$ update public.lending_items set stock = 4 where id = :LI_TENT $q$),
  'Y1=0 Y2=0', '在庫を増やす更新はロックを取らない');
select is(tests.lock_after('head', $q$ update public.lending_items set name = name, stock = stock where id = :LI_TENT $q$),
  'Y1=0 Y2=0', '在庫を変えない更新もロックを取らない');
select is(tests.lock_after('staff', $q$ update public.lending_items set stock = 0 where id = :LI_TENT $q$),
  'Y1=0 Y2=0', '書けない人の在庫の更新（0 行）はロックを取らない');
select is(tests.lock_after('head', $q$ select count(*) from public.previous_year_lending_items(:Y1) $q$),
  'Y1=0 Y2=0', '前年度の備品の読み取りはロックを取らない');
select is(tests.lock_after('rep', $q$ update public.lending_requests set count = 3 where group_id = :G1 and lending_item_id = :LI_TENT $q$),
  'Y1=0 Y2=0', '申請の直接の書き込みはロックを取らない');
select is(tests.lock_after('staff', $q$ update public.lending_records set returned_count = 2 where group_id = :G1 and lending_item_id = :LI_TENT $q$),
  'Y1=0 Y2=0', '記録の直接の書き込みもロックを取らない');
select is(tests.lending_lock_held('Y1') || tests.lending_lock_held('Y2'), '00', '取り消した文のロックは残らない（以降の確かめの前提）');
select is(tests.rpc_error('head', $q$ select private.lock_lending_year(:Y1) $q$), '{"code": "error:42501"}'::jsonb,
  '年度のロックの補助は authenticated から直接呼べない');

-- ---------------------------------------------------------------- ① の続き（段の表を流す）
select is_empty($$ select n, yn from tests.rpc_case
                   where array_length(string_to_array(yn, ' '), 1) <> 7
                      or exists (select 1 from unnest(string_to_array(yn, ' ')) t where t not in ('ok', 'F', 'IS', 'II', 'CF', 'RR')) $$,
  '期待値はどの行も7列（admin head staff viewer rep outsider admin2）で、略号は ok・F・IS・II・CF・RR');
select is((select string_agg(persona || '=' || col, ' ' order by ord) from tests.rpc_persona),
  'admin=1 head=2 deputy=2 staff=3 viewer=4 rep=5 outsider=6 admin2=7', 'deputy は head の列で確かめる（8人 × 7列）');

create table tests.rpc_results as
select n, label, scenario, persona, ord, expected, tests.try_rpc_prep(persona, prep, sql, scenario) as got from tests.rpc_cells;

select is(got, expected, format('%s [%s] %s', label, scenario, persona))
from tests.rpc_results
order by n, ord;

select is_empty($$ select h.n, h.label, h.got as head, d.got as deputy
                   from tests.rpc_results h join tests.rpc_results d using (n)
                   where h.persona = 'head' and d.persona = 'deputy' and h.got is distinct from d.got $$,
  'deputy（総務副部門長）は全部の行で head（総務部門長）と同じ結果');

-- ================================================================ ② 読み取り（割り当ての確定の前）
-- 総務（admin・head・deputy・staff）はその年度の割り当てを全部読める（確定の前も）。閲覧のみ・団体の代表は確定後だけ（Y1 は確定前なので
-- 何も見えない。Y2 は確定後なので、Y2 の閲覧のみの rep・G3 の店長の staff・管理者の admin2 に G3 の割り当てが見える）。確定の印は、
-- 総務と閲覧のみはその年度、団体の代表は代表である年度（fixture は Y2 だけに行がある）
select tests.set_scenario('requesting');
select is(tests.visible_lending_all(),
  'admin=G1xLI_TENT G1xLI_WEIGHT | - ; head=G1xLI_TENT G1xLI_WEIGHT | - ; deputy=G1xLI_TENT G1xLI_WEIGHT | - ; '
  || 'staff=G1xLI_TENT G1xLI_WEIGHT G3xLI_Y2_TENT | Y2 ; viewer=- | - ; rep=G3xLI_Y2_TENT | Y2 ; rep2=- | - ; outsider=- | - ; '
  || 'admin2=G3xLI_Y2_TENT | Y2',
  '確定の前：ペルソナごとに見える割り当てと確定の印');

-- ================================================================ ③ save_lending_assignments（Y1 は受付中・割り当ての確定前）
-- 1. 段：部門長以上でなければ、終了の年度でも入力が誤っていても forbidden（detail なし）。年度が null も forbidden
select is(tests.rpc_error('staff', $q$ select public.save_lending_assignments(:Y1, '{}') $q$), '{"code": "forbidden", "detail": null}'::jsonb,
  '部門員は入力が誤っていても forbidden（段が先）');
select is(tests.rpc_error('head', $q$ select public.save_lending_assignments(null, jsonb_build_array(tests.ch('G2', 'LI_TENT', 1))) $q$),
  '{"code": "forbidden", "detail": null}'::jsonb, '年度が null なら forbidden');
select tests.set_scenario('closed');
select is(tests.rpc_error('viewer', $q$ select public.save_lending_assignments(:Y1, '{}') $q$), '{"code": "forbidden", "detail": null}'::jsonb,
  '閲覧のみは、終了の年度で入力が誤っていても forbidden（段が状態より先）');
-- 2. 状態：終了 → invalid_state（status）、割り当ての確定中 → invalid_state（reason confirmed）。どちらも入力より先、終了が確定中より先
select is(tests.rpc_error('head', $q$ select public.save_lending_assignments(:Y1, '{}') $q$),
  '{"code": "invalid_state", "detail": {"status": "closed"}}'::jsonb, '終了の年度は、入力が誤っていても invalid_state（status。入力より先）');
select tests.set_scenario('requesting');
select is(tests.rpc_error('admin2', $q$ select public.save_lending_assignments(:Y2, '[]') $q$),
  '{"code": "invalid_state", "detail": {"reason": "confirmed"}}'::jsonb, '割り当ての確定中（Y2）は、入力が誤っていても invalid_state（reason は confirmed）');
update public.years set status = 'closed' where id = tests.id('Y2');
select is(tests.rpc_error('admin2', $q$ select public.save_lending_assignments(:Y2, '[]') $q$),
  '{"code": "invalid_state", "detail": {"status": "closed"}}'::jsonb, '終了と割り当ての確定中が重なれば、終了（status）が先');
update public.years set status = 'preparing' where id = tests.id('Y2');
-- 3. 入力：数（配列でない・0 件・1001 件）→ 形 → 重複 → その年度にない団体 → その年度にない備品
select is(tests.rpc_error('head', $q$ select public.save_lending_assignments(:Y1, null) $q$),
  '{"code": "invalid_input", "detail": {"field": "changes"}}'::jsonb, 'changes が null → changes');
select is(tests.rpc_error('head', $q$ select public.save_lending_assignments(:Y1, '{}') $q$),
  '{"code": "invalid_input", "detail": {"field": "changes"}}'::jsonb, 'changes が配列でない（オブジェクト）→ changes');
select is(tests.rpc_error('head', $q$ select public.save_lending_assignments(:Y1, '"x"') $q$),
  '{"code": "invalid_input", "detail": {"field": "changes"}}'::jsonb, 'changes が文字列 → changes');
select is(tests.rpc_error('head', $q$ select public.save_lending_assignments(:Y1, '[]') $q$),
  '{"code": "invalid_input", "detail": {"field": "changes"}}'::jsonb, 'changes が 0 件 → changes');
select is(tests.rpc_error('head', $q$ select public.save_lending_assignments(:Y1, (select jsonb_agg(tests.ch('G2', 'LI_TENT', 1)) from generate_series(1, 1001))) $q$),
  '{"code": "invalid_input", "detail": {"field": "changes"}}'::jsonb, 'changes が 1001 件 → changes（数は形・重複より先）');
select is(tests.rpc_error('head', $q$ select public.save_lending_assignments(:Y1, (select jsonb_agg(tests.ch('G2', 'LI_TENT', 1)) from generate_series(1, 1000))) $q$),
  '{"code": "invalid_input", "detail": {"field": "changes", "reason": "duplicate"}}'::jsonb,
  '1000 件は数の確かめを通る（同じ団体・備品が重なって duplicate）');
-- 形の誤り：要素がオブジェクトでない、groupId・itemId が uuid の文字列でない、count のキーがないか 0〜10000 の整数・null でない、updatedAt の
-- キーがないかオフセットつきの ISO 8601 の文字列・null でない（'infinity' などの特別な値・ない日付・空白の区切り・オフセットなしも通さない）。
-- 正しい要素（前）と一緒に送っても全体が止まる
create table tests.bad_shape (k text primary key, v jsonb);
insert into tests.bad_shape values
  ('element_number', '1'), ('element_empty_object', '{}'), ('element_null', 'null'), ('element_array', '[1]');
insert into tests.bad_shape select k, jsonb_build_object('groupId', g, 'itemId', i, 'count', c) || u from (values
  ('group_number', '1'::jsonb, to_jsonb(tests.id('LI_TENT')), '1'::jsonb, '{"updatedAt": null}'::jsonb),
  ('group_not_uuid', '"x"', to_jsonb(tests.id('LI_TENT')), '1', '{"updatedAt": null}'),
  ('item_null', to_jsonb(tests.id('G2')), 'null', '1', '{"updatedAt": null}'),
  ('count_string', to_jsonb(tests.id('G2')), to_jsonb(tests.id('LI_TENT')), '"1"', '{"updatedAt": null}'),
  ('count_decimal', to_jsonb(tests.id('G2')), to_jsonb(tests.id('LI_TENT')), '1.5', '{"updatedAt": null}'),
  ('count_one_point_zero', to_jsonb(tests.id('G2')), to_jsonb(tests.id('LI_TENT')), '1.0', '{"updatedAt": null}'),
  ('count_negative', to_jsonb(tests.id('G2')), to_jsonb(tests.id('LI_TENT')), '-1', '{"updatedAt": null}'),
  ('count_10001', to_jsonb(tests.id('G2')), to_jsonb(tests.id('LI_TENT')), '10001', '{"updatedAt": null}'),
  ('count_huge', to_jsonb(tests.id('G2')), to_jsonb(tests.id('LI_TENT')), '99999999999', '{"updatedAt": null}'),
  ('count_bool', to_jsonb(tests.id('G2')), to_jsonb(tests.id('LI_TENT')), 'true', '{"updatedAt": null}'),
  ('updated_missing', to_jsonb(tests.id('G2')), to_jsonb(tests.id('LI_TENT')), '1', '{}'),
  ('updated_number', to_jsonb(tests.id('G2')), to_jsonb(tests.id('LI_TENT')), '1', '{"updatedAt": 123}'),
  ('updated_word', to_jsonb(tests.id('G2')), to_jsonb(tests.id('LI_TENT')), '1', '{"updatedAt": "yesterday"}'),
  ('updated_infinity', to_jsonb(tests.id('G2')), to_jsonb(tests.id('LI_TENT')), '1', '{"updatedAt": "infinity"}'),
  ('updated_no_date', to_jsonb(tests.id('G2')), to_jsonb(tests.id('LI_TENT')), '1', '{"updatedAt": "2026-02-30T00:00:00Z"}'),
  ('updated_space', to_jsonb(tests.id('G2')), to_jsonb(tests.id('LI_TENT')), '1', '{"updatedAt": "2026-11-01 00:00:00+00"}'),
  ('updated_no_offset', to_jsonb(tests.id('G2')), to_jsonb(tests.id('LI_TENT')), '1', '{"updatedAt": "2026-11-01T00:00:00"}')
) as t(k, g, i, c, u);
insert into tests.bad_shape values
  ('item_missing', jsonb_build_object('groupId', tests.id('G2'), 'count', 1, 'updatedAt', null)),
  ('count_missing', jsonb_build_object('groupId', tests.id('G2'), 'itemId', tests.id('LI_TENT'), 'updatedAt', null));
select is((select count(*)::int from tests.bad_shape), 23, '確かめる形の誤りは 23 とおり');
select is((select coalesce(string_agg(k, ' ' order by k), '') from tests.bad_shape
           where tests.rpc_error('head', format($f$ select public.save_lending_assignments(:Y1, jsonb_build_array(tests.ch('G2', 'LI_TENT', 1), %L::jsonb)) $f$, v::text))
                 is distinct from '{"code": "invalid_input", "detail": {"field": "changes", "reason": "shape"}}'::jsonb), '',
  '形の誤り（23 とおり）はどれも invalid_input（shape）。正しい要素と一緒でも全体が止まる');
select is((tests.rpc_error('head', $q$ select public.save_lending_assignments(:Y1, jsonb_build_array(tests.ch('G2', 'LI_TENT', 0))) $q$) ->> 'code')
          || ' ' || (tests.rpc_error('head', $q$ select public.save_lending_assignments(:Y1, jsonb_build_array(tests.ch('G2', 'LI_TENT', 10000))) $q$) ->> 'code')
          || ' ' || (tests.rpc_error('head', $q$ select public.save_lending_assignments(:Y1, jsonb_build_array(tests.ch('G2', 'LI_TENT', null))) $q$) ->> 'code'),
  'ok ok ok', '通る形：数 0（貸さない）・10000、null（行がなく版も null なら何もしない）');
select is(tests.rpc_error('head', $q$ select public.save_lending_assignments(:Y1, jsonb_build_array(tests.ch('G2', 'LI_TENT', 1, '2026-11-01T09:00+09'))) $q$),
  tests.j('{"code": "conflict", "detail": {"group_id": ":G2", "lending_item_id": ":LI_TENT"}}'),
  '秒を省いた・短いオフセット（+09）の日時は形を通る（行がないのに版があるので conflict）');
select is(tests.rpc_error('head', $q$ select public.save_lending_assignments(:Y1,
            jsonb_build_array(tests.ch('G2', 'LI_TENT', 1) || '{"op": "delete", "id": 1, "reason": "x"}')) $q$),
  '{"code": "ok"}'::jsonb, 'ほかのキー（op・id・reason）は見ない');
select is(tests.rpc_error('head', $q$ select public.save_lending_assignments(:Y1, jsonb_build_array(tests.ch('G2', 'LI_TENT', 1), tests.ch('G2', 'LI_TENT', 2), 1)) $q$),
  '{"code": "invalid_input", "detail": {"field": "changes", "reason": "shape"}}'::jsonb, '重複と形の誤りが両方あれば shape が先');
select is(tests.rpc_error('head', $q$ select public.save_lending_assignments(:Y1, jsonb_build_array(tests.ch('G3', 'LI_TENT', 1), tests.ch('G3', 'LI_TENT', 1))) $q$),
  '{"code": "invalid_input", "detail": {"field": "changes", "reason": "duplicate"}}'::jsonb, '重複とその年度にない団体が両方あれば duplicate が先');
select is(tests.rpc_error('head', $q$ select public.save_lending_assignments(:Y1,
            jsonb_build_array(tests.ch('G1', 'LI_TENT', 2, tests.ver_a('G1', 'LI_TENT')), tests.ch('G3', 'LI_TENT', 1))) $q$),
  tests.j('{"code": "invalid_input", "detail": {"field": "groupId", "reason": "not_in_year", "group_id": ":G3"}}'),
  'ほかの年度（Y2）の団体 → groupId（not_in_year。detail は送った団体）');
select is(tests.rpc_error('head', $q$ select public.save_lending_assignments(:Y1, jsonb_build_array(jsonb_build_object('groupId',
            '00000000-0000-4000-8000-00000000dead', 'itemId', :LI_TENT, 'count', 1, 'updatedAt', null))) $q$),
  '{"code": "invalid_input", "detail": {"field": "groupId", "reason": "not_in_year", "group_id": "00000000-0000-4000-8000-00000000dead"}}'::jsonb,
  'ない団体も同じ groupId（not_in_year）');
select is(tests.rpc_error('head', $q$ select public.save_lending_assignments(:Y1, jsonb_build_array(tests.ch('G2', 'LI_Y2_TENT', 1))) $q$),
  tests.j('{"code": "invalid_input", "detail": {"field": "itemId", "reason": "not_in_year", "lending_item_id": ":LI_Y2_TENT"}}'),
  'ほかの年度（Y2）の備品 → itemId（not_in_year。detail は送った備品）');
select is(tests.rpc_error('head', $q$ select public.save_lending_assignments(:Y1, jsonb_build_array(tests.ch('G2', 'LI_Y2_TENT', 1), tests.ch('G3', 'LI_TENT', 1))) $q$),
  tests.j('{"code": "invalid_input", "detail": {"field": "groupId", "reason": "not_in_year", "group_id": ":G3"}}'),
  '団体の誤りは備品の誤りより先（changes の並びによらない）');
-- 4. 楽観ロック：changes の順に行をロックして比べ、最初に違う1つを conflict で返す（detail は団体と備品）。版はミリ秒までで比べる
select is(tests.rpc_error('head', $q$ select public.save_lending_assignments(:Y1, jsonb_build_array(tests.ch('G1', 'LI_TENT', 3))) $q$),
  tests.j('{"code": "conflict", "detail": {"group_id": ":G1", "lending_item_id": ":LI_TENT"}}'), '行があるのに版が null → conflict');
select is(tests.rpc_error('head', $q$ select public.save_lending_assignments(:Y1, jsonb_build_array(tests.ch('G1', 'LI_TENT', 3, '2000-01-01T00:00:00Z'))) $q$),
  tests.j('{"code": "conflict", "detail": {"group_id": ":G1", "lending_item_id": ":LI_TENT"}}'), '版が違う → conflict');
select is(tests.rpc_error('head', $q$ select public.save_lending_assignments(:Y1, jsonb_build_array(tests.ch('G2', 'LI_TENT', 1, '2000-01-01T00:00:00Z'))) $q$),
  tests.j('{"code": "conflict", "detail": {"group_id": ":G2", "lending_item_id": ":LI_TENT"}}'), '行がないのに版がある → conflict');
select is(tests.rpc_error('head', $q$ select public.save_lending_assignments(:Y1,
            jsonb_build_array(tests.ch('G2', 'LI_TENT', 1), tests.ch('G1', 'LI_WEIGHT', 9), tests.ch('G1', 'LI_TENT', 3))) $q$),
  tests.j('{"code": "conflict", "detail": {"group_id": ":G1", "lending_item_id": ":LI_WEIGHT"}}'), 'changes の順で最初の conflict を返す');
select is((tests.rpc_error('head', $q$ select public.save_lending_assignments(:Y1, jsonb_build_array(tests.ch('G1', 'LI_TENT', 3, tests.ver_a('G1', 'LI_TENT')))) $q$) ->> 'code')
          || ' ' || (tests.rpc_error('head', $q$ select public.save_lending_assignments(:Y1, jsonb_build_array(tests.ch('G1', 'LI_TENT', 3,
                to_char((select a.updated_at from public.lending_assignments a where a.group_id = :G1 and a.lending_item_id = :LI_TENT) at time zone 'UTC',
                        'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"')))) $q$) ->> 'code')
          || ' ' || (tests.rpc_error('head', $q$ select public.save_lending_assignments(:Y1, jsonb_build_array(tests.ch('G1', 'LI_TENT', 3,
                to_char((select a.updated_at + interval '1 millisecond' from public.lending_assignments a where a.group_id = :G1 and a.lending_item_id = :LI_TENT)
                        at time zone 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"')))) $q$) ->> 'code'),
  'ok ok conflict', '受け取った版の文字列のまま・ミリ秒に切った文字列は通り、1 ミリ秒違えば conflict');
-- 保存すると updated_at が進む（同じ数でも）：前の版で送り直すと conflict（ほかの人が読んだ版も）。テスト全体が1つのトランザクションで
-- now() が変わらないので、set_timestamps を止めて過去の updated_at を入れてから確かめる
alter table public.lending_assignments disable trigger set_timestamps;
update public.lending_assignments set updated_at = '2027-01-01 00:00:00.123456+00'
where group_id = tests.id('G1') and lending_item_id = tests.id('LI_WEIGHT');
alter table public.lending_assignments enable trigger set_timestamps;
select is(tests.do_as('head', $q$ select public.save_lending_assignments(:Y1,
            jsonb_build_array(tests.ch('G1', 'LI_WEIGHT', 8, '2027-01-01T09:00:00.123+09:00'))) -> 0 ->> 'count' $q$), '8',
  'オフセットの違う同じ時刻の版（ミリ秒まで）でも保存できる（同じ数）');
select set_config('app.reason', '', true);
select is(tests.rpc_error('head', $q$ select public.save_lending_assignments(:Y1, jsonb_build_array(tests.ch('G1', 'LI_WEIGHT', 8, '2027-01-01T00:00:00.123Z'))) $q$),
  tests.j('{"code": "conflict", "detail": {"group_id": ":G1", "lending_item_id": ":LI_WEIGHT"}}'),
  '同じ数でも保存すると updated_at が進むので、前の版で送り直すと conflict');
-- 5. 全部か何も：後ろの conflict で、前の行も書かれない
select is(tests.do_as('head', $q$ select public.save_lending_assignments(:Y1, jsonb_build_array(tests.ch('G2', 'LI_TENT', 1), tests.ch('G1', 'LI_TENT', 9)))::text $q$),
  'ERR conflict ' || jsonb_build_object('group_id', tests.id('G1'), 'lending_item_id', tests.id('LI_TENT'))::text,
  '後ろの要素が conflict なら、エラーを返す');
select is((select count(*)::int from public.lending_assignments where group_id = tests.id('G2')), 0,
  '全部か何も：後ろの conflict で、前の要素（G2×テント）も書かれない');
-- 6. 保存：数があれば insert か update（同じ数でも書く）、null なら delete（行がなく版も null なら何もしない）。返り値は changes の順
select is(tests.do_as('head', $q$ select public.save_lending_assignments(:Y1, jsonb_build_array(
            tests.ch('G2', 'LI_TENT', 1), tests.ch('G1', 'LI_TENT', 2, tests.ver_a('G1', 'LI_TENT')),
            tests.ch('G1', 'LI_WEIGHT', null, tests.ver_a('G1', 'LI_WEIGHT')), tests.ch('G1', 'LI_CURTAIN', null)))::text $q$),
  jsonb_build_array(
    jsonb_build_object('groupId', tests.id('G2'), 'itemId', tests.id('LI_TENT'), 'count', 1, 'updatedAt', now()),
    jsonb_build_object('groupId', tests.id('G1'), 'itemId', tests.id('LI_TENT'), 'count', 2, 'updatedAt', now()),
    jsonb_build_object('groupId', tests.id('G1'), 'itemId', tests.id('LI_WEIGHT'), 'count', null, 'updatedAt', null),
    jsonb_build_object('groupId', tests.id('G1'), 'itemId', tests.id('LI_CURTAIN'), 'count', null, 'updatedAt', null))::text,
  '返り値：changes の順に、書いた行の数と updated_at（消した行・何もしなかった行は null）');
select is(tests.lending_lock_held('Y1'), '1', '保存の後も（トランザクションの終わりまで）年度のロックを持つ');
select set_config('app.reason', '', true);
select is((select string_agg(tests.nm(group_id) || 'x' || tests.nm(lending_item_id) || '=' || count || '/' || tests.nm(updated_by) || '/' || tests.nm(year_id), ' '
                             order by tests.nm(group_id) collate "C", tests.nm(lending_item_id) collate "C")
           from public.lending_assignments where year_id = tests.id('Y1')),
  'G1xLI_TENT=2/head/Y1 G2xLI_TENT=1/head/Y1', '行：insert・update・delete が反映され、書いた人は head、year_id は団体の年度');
select is((select string_agg(action || ':' || tests.nm(group_id) || 'x' || tests.nm((row_pk ->> 'lending_item_id')::uuid) || ':' || tests.nm(year_id)
                             || ':' || tests.nm(user_id), ' ' order by action collate "C")
           from public.audit_logs where table_name = 'lending_assignments' and reason = 'テント等の割り当て'),
  'delete:G1xLI_WEIGHT:Y1:head insert:G2xLI_TENT:Y1:head',
  '監査：理由「テント等の割り当て」で、足した行と消した行が残る（updated_at だけ変わる同じ数の update は残らない）');
select is(tests.rpc_error('head', $q$ select public.save_lending_assignments(:Y1, jsonb_build_array(tests.ch('G2', 'LI_TENT', 1))) $q$),
  tests.j('{"code": "conflict", "detail": {"group_id": ":G2", "lending_item_id": ":LI_TENT"}}'),
  '応答が届かずに同じ内容（版なし）を送り直すと conflict（行ができていた。画面は読み直して保存されていたと分かる）');
select is(tests.rpc_error('head', $q$ select public.save_lending_assignments(:Y1, jsonb_build_array(tests.ch('G1', 'LI_WEIGHT', null, '2000-01-01T00:00:00Z'))) $q$),
  tests.j('{"code": "conflict", "detail": {"group_id": ":G1", "lending_item_id": ":LI_WEIGHT"}}'),
  '消した行を同じ版で消し直すと conflict（行が消えた。読み直すと入力と同じ）');
-- 7. 在庫を超えても保存できる（確定で止める）。区分で申請できない団体（企業）にも入れられる
select is(tests.rpc_error('head', $q$ select public.save_lending_assignments(:Y1,
            jsonb_build_array(tests.ch('G2', 'LI_TENT', 100, tests.ver_a('G2', 'LI_TENT')), tests.ch('G5', 'LI_CURTAIN', 2))) $q$),
  '{"code": "ok"}'::jsonb, '在庫（3）を超える数も、企業（G5）への割り当ても保存できる');
-- 8. 版（allocation_version）を増やさない（振り分けの入力でない）
select tests.set_scenario('allocating');
select tests.ver() as v_save \gset
select is(tests.do_as('head', $q$ select public.save_lending_assignments(:Y1,
            jsonb_build_array(tests.ch('G2', 'LI_TENT', 1, tests.ver_a('G2', 'LI_TENT')))) -> 0 ->> 'count' $q$), '1',
  '振り分け中に割り当てを保存する');
select set_config('app.reason', '', true);
select is(tests.ver(), :v_save, '割り当ての保存では版（allocation_version）は増えない');
select tests.set_scenario('requesting');

-- ================================================================ ④ set_lending_confirmed
-- 1. 段：部門長以上でなければ、終了の年度でも confirmed が null でも forbidden。年度が null も forbidden
select is(tests.rpc_error('staff', $q$ select public.set_lending_confirmed(:Y1, null) $q$), '{"code": "forbidden", "detail": null}'::jsonb,
  '部門員は confirmed が null でも forbidden（段が先）');
select is(tests.rpc_error('head', $q$ select public.set_lending_confirmed(null, true) $q$), '{"code": "forbidden", "detail": null}'::jsonb,
  '年度が null なら forbidden');
select tests.set_scenario('closed');
select is(tests.rpc_error('viewer', $q$ select public.set_lending_confirmed(:Y1, true) $q$), '{"code": "forbidden", "detail": null}'::jsonb,
  '閲覧のみは終了の年度でも forbidden（段が状態より先）');
-- 2. 終了 → invalid_state（status）。confirmed が null でも状態が先
select is(tests.rpc_error('head', $q$ select public.set_lending_confirmed(:Y1, null) $q$),
  '{"code": "invalid_state", "detail": {"status": "closed"}}'::jsonb, '終了の年度は、confirmed が null でも invalid_state（status）');
select tests.set_scenario('requesting');
-- 3. confirmed が null → invalid_input
select is(tests.rpc_error('head', $q$ select public.set_lending_confirmed(:Y1, null) $q$),
  '{"code": "invalid_input", "detail": {"field": "confirmed"}}'::jsonb, 'confirmed が null → invalid_input（confirmed）');
-- 4. 今と同じ状態 → invalid_state（unchanged と今の状態）。解除の理由がなくても、理由より先
select is(tests.rpc_error('head', $q$ select public.set_lending_confirmed(:Y1, false) $q$),
  '{"code": "invalid_state", "detail": {"reason": "unchanged", "confirmed": false}}'::jsonb,
  '確定前（行がない）の解除は unchanged（理由がなくても、理由より先）');
select is(tests.rpc_error('admin2', $q$ select public.set_lending_confirmed(:Y2, true) $q$),
  '{"code": "invalid_state", "detail": {"reason": "unchanged", "confirmed": true}}'::jsonb, '確定中（Y2）の確定は unchanged');
-- 5. 解除の理由：null・空白だけは reason_required、501 字は invalid_input（reason）、500 字は通る
select is(tests.rpc_error('admin2', $q$ select public.set_lending_confirmed(:Y2, false) $q$), '{"code": "reason_required", "detail": null}'::jsonb,
  '解除の理由が null → reason_required');
select is(tests.rpc_error('admin2', $q$ select public.set_lending_confirmed(:Y2, false, '   ') $q$), '{"code": "reason_required", "detail": null}'::jsonb,
  '解除の理由が半角の空白だけ → reason_required（0003 の set_reason。画面は zod の trim で前後の空白を除いてから送る）');
select is(tests.rpc_error('admin2', $q$ select public.set_lending_confirmed(:Y2, false, repeat('あ', 501)) $q$),
  '{"code": "invalid_input", "detail": {"field": "reason"}}'::jsonb, '解除の理由が 501 字 → invalid_input（reason）');
select is(tests.rpc_error('admin2', $q$ select public.set_lending_confirmed(:Y2, false, repeat('あ', 500)) $q$), '{"code": "ok"}'::jsonb,
  '解除の理由 500 字は通る');
-- 解除（Y2。admin2）：行は残り、confirmed_at・confirmed_by は null。理由は前後の空白を除いて監査に残る。閲覧のみ・店長に見えなくなる
select is(tests.do_as('admin2', $q$ select format('%s %s %s', tests.nm(r.year_id), coalesce(r.confirmed_at::text, 'null'), coalesce(r.confirmed_by::text, 'null'))
                                    from public.set_lending_confirmed(:Y2, false, ' T-理由 ') r $q$),
  'Y2 null null', '解除：返り値は確定の印の行で、confirmed_at・confirmed_by が null');
select set_config('app.reason', '', true);
select is((select format('%s %s', count(*), bool_and(confirmed_at is null and confirmed_by is null)::text) from public.lending_years where year_id = tests.id('Y2')),
  '1 true', '解除しても確定の印の行は消さない（confirmed_at・confirmed_by を null にする）');
select is((select string_agg(action || ':' || reason || ':' || tests.nm(user_id) || ':' || coalesce(after ->> 'confirmed_at', 'null'), ' ' order by id)
           from public.audit_logs where table_name = 'lending_years' and year_id = tests.id('Y2') and user_id is not null),
  'update:T-理由:admin2:null', '解除は同じ行の更新として、入れた理由（前後の空白を除く）で監査に残る');
select is(tests.visible_lending('rep') || ' / ' || tests.visible_lending('staff'),
  '- | Y2(解除) / G1xLI_TENT G2xLI_TENT | Y2(解除)',
  '解除すると、Y2 の閲覧のみ（rep）・G3 の店長（staff）には Y2 の割り当てが見えなくなる（確定の印の行は見える）');
select is(tests.rpc_error('admin2', $q$ select public.set_lending_confirmed(:Y2, true) $q$),
  '{"code": "invalid_state", "detail": {"reason": "before_deadline"}}'::jsonb, '解除の後、準備中の Y2 を確定しようとすると締切の前');
update public.lending_years set confirmed_at = now(), confirmed_by = tests.id('admin2') where year_id = tests.id('Y2');
-- 6. 確定の条件：締切の後（受付中で締切を過ぎた、または振り分け中・確定）→ 在庫超過 → 未入力
select is(tests.rpc_error('head', $q$ select public.set_lending_confirmed(:Y1, true) $q$),
  '{"code": "invalid_state", "detail": {"reason": "before_deadline"}}'::jsonb, '受付中の締切前 → before_deadline');
update public.years set status = 'preparing', request_close_at = now() - interval '1 hour' where id = tests.id('Y1');
select is(tests.rpc_error('head', $q$ select public.set_lending_confirmed(:Y1, true) $q$),
  '{"code": "invalid_state", "detail": {"reason": "before_deadline"}}'::jsonb, '準備中は締切の日時を過ぎていても before_deadline（受付を始めていない）');
update public.years set status = 'requesting', request_close_at = null where id = tests.id('Y1');
select is(tests.rpc_error('head', $q$ select public.set_lending_confirmed(:Y1, true) $q$),
  '{"code": "invalid_state", "detail": {"reason": "before_deadline"}}'::jsonb, '受付中で締切が未設定 → before_deadline');
-- 申請も割り当てもない年度（備品だけ）は、締切の後なら確定できる
select is(tests.try_rpc_prep('head', tests.sql($p$ do $d$ begin delete from public.lending_requests where year_id = :Y1;
                                                              delete from public.lending_assignments where year_id = :Y1; end $d$ $p$),
                             tests.sql($q$ select public.set_lending_confirmed(:Y1, true) $q$), 'requesting:after'),
  'ok', '申請も割り当てもない年度は、締切の後なら確定できる');
update public.years set request_close_at = now() where id = tests.id('Y1');
select is(tests.rpc_error('head', $q$ select public.set_lending_confirmed(:Y1, true) $q$),
  tests.j('{"code": "invalid_state", "detail": {"reason": "unassigned", "lending_item_ids": [":LI_WEIGHT", ":LI_CURTAIN"]}}'),
  '締切ちょうど（now() = 締切）は締切の後。未入力（G1 の重し・三方幕）の備品を備品の並びで返す');
select tests.set_scenario('allocating');
select is(tests.rpc_error('head', $q$ select public.set_lending_confirmed(:Y1, true) $q$),
  tests.j('{"code": "invalid_state", "detail": {"reason": "unassigned", "lending_item_ids": [":LI_WEIGHT", ":LI_CURTAIN"]}}'), '振り分け中は締切の後');
select tests.set_scenario('confirmed');
select is(tests.rpc_error('head', $q$ select public.set_lending_confirmed(:Y1, true) $q$),
  tests.j('{"code": "invalid_state", "detail": {"reason": "unassigned", "lending_item_ids": [":LI_WEIGHT", ":LI_CURTAIN"]}}'), '机椅子の確定中も締切の後');
select tests.set_scenario('requesting:after');
-- 在庫超過（割り当て合計 > 在庫。未入力の組は数えない）は未入力より先。備品の並び（sort_order → 名前〔コードポイントの順〕→ id）で返す
update public.lending_assignments set count = 2 where group_id = tests.id('G2') and lending_item_id = tests.id('LI_TENT');
insert into public.lending_assignments (group_id, lending_item_id, year_id, count) values (tests.id('G2'), tests.id('LI_WEIGHT'), tests.id('Y1'), 21);
select is(tests.rpc_error('head', $q$ select public.set_lending_confirmed(:Y1, true) $q$),
  tests.j('{"code": "invalid_state", "detail": {"reason": "over_stock", "lending_item_ids": [":LI_TENT", ":LI_WEIGHT"]}}'),
  '在庫超過（テント 2+2 > 3・重し 21 > 20）が未入力より先。未入力の組（G1 の重し 8）は割り当て合計に数えない');
update public.lending_items set sort_order = 0 where id = tests.id('LI_WEIGHT');
select is(tests.rpc_error('head', $q$ select public.set_lending_confirmed(:Y1, true) $q$),
  tests.j('{"code": "invalid_state", "detail": {"reason": "over_stock", "lending_item_ids": [":LI_WEIGHT", ":LI_TENT"]}}'), '並びは sort_order が先');
update public.lending_items set sort_order = 1 where id = tests.id('LI_WEIGHT');
select is(tests.rpc_error('head', $q$ select public.set_lending_confirmed(:Y1, true) $q$),
  tests.j('{"code": "invalid_state", "detail": {"reason": "over_stock", "lending_item_ids": [":LI_TENT", ":LI_WEIGHT"]}}'),
  'sort_order が同じなら名前（コードポイントの順：T-テント < T-重し）');
update public.lending_items set name = 'T-a' where id = tests.id('LI_TENT');
update public.lending_items set name = 'T-B' where id = tests.id('LI_WEIGHT');
select is(tests.rpc_error('head', $q$ select public.set_lending_confirmed(:Y1, true) $q$),
  tests.j('{"code": "invalid_state", "detail": {"reason": "over_stock", "lending_item_ids": [":LI_WEIGHT", ":LI_TENT"]}}'),
  '名前はコードポイントの順（T-B < T-a。データベースの照合順序〔en_US〕によらない。packages/shared の compareStrings と同じ）');
update public.lending_items set name = 'T-テント' where id = tests.id('LI_TENT');
update public.lending_items set name = 'T-重し' where id = tests.id('LI_WEIGHT');
update public.lending_items set sort_order = 2 where id = tests.id('LI_WEIGHT');
update public.lending_assignments set count = 1 where group_id = tests.id('G2') and lending_item_id = tests.id('LI_TENT');
update public.lending_assignments set count = 0 where group_id = tests.id('G2') and lending_item_id = tests.id('LI_WEIGHT');
select is(tests.rpc_error('head', $q$ select public.set_lending_confirmed(:Y1, true) $q$),
  tests.j('{"code": "invalid_state", "detail": {"reason": "unassigned", "lending_item_ids": [":LI_WEIGHT", ":LI_CURTAIN"]}}'),
  '在庫ちょうど（テント 2+1 = 3）は在庫超過でない');
-- 割り当て 0 は「貸さない」と決めたので未入力でない。申請が 0 の組は数えない
insert into public.lending_assignments (group_id, lending_item_id, year_id, count) values
  (tests.id('G1'), tests.id('LI_WEIGHT'), tests.id('Y1'), 8), (tests.id('G1'), tests.id('LI_CURTAIN'), tests.id('Y1'), 0);
insert into public.lending_requests (group_id, lending_item_id, year_id, count) values (tests.id('G2'), tests.id('LI_SPARE'), tests.id('Y1'), 0);
-- 7. 確定（head）：行を作って confirmed_at = now()・confirmed_by = 確定した人。理由は決まった文（渡した p_reason は使わない）
select is(tests.do_as('head', $q$ select format('%s %s %s', tests.nm(r.year_id), (r.confirmed_at = now())::text, tests.nm(r.confirmed_by))
                                  from public.set_lending_confirmed(:Y1, true, '使わない理由') r $q$),
  'Y1 true head', '確定：割り当て 0 は未入力でなく、申請 0 の組は数えない。返り値は確定の印の行');
select set_config('app.reason', '', true);
select is((select string_agg(action || ':' || reason || ':' || tests.nm(user_id), ' ' order by id)
           from public.audit_logs where table_name = 'lending_years' and year_id = tests.id('Y1')),
  'insert:テント等の割り当ての確定:head', '確定は確定の印の insert として、理由「テント等の割り当ての確定」で監査に残る（p_reason は使わない）');
-- 確定中：割り当ては保存できず、在庫を割り当て合計より減らせない（部門長の画面の更新でも）。同じ在庫にはできる
select is(tests.rpc_error('head', $q$ select public.save_lending_assignments(:Y1, jsonb_build_array(tests.ch('G2', 'LI_TENT', 0, tests.ver_a('G2', 'LI_TENT')))) $q$),
  '{"code": "invalid_state", "detail": {"reason": "confirmed"}}'::jsonb, '確定中は割り当てを保存できない（reason confirmed）');
select is(tests.rpc_error('head', $q$ update public.lending_items set stock = 2 where id = :LI_TENT $q$),
  tests.j('{"code": "invalid_state", "detail": {"reason": "confirmed", "lending_item_id": ":LI_TENT", "assigned": 3, "stock": 2}}'),
  '確定中は在庫を割り当て合計（3）より少なくできない（部門長の直接の更新でも。guard_stock）');
select is(tests.q_as('head', $q$ with u as (update public.lending_items set stock = 3 where id = :LI_TENT returning 1) select count(*) from u $q$), '1',
  '確定中でも割り当て合計と同じ在庫にはできる');
-- 確定の後：閲覧のみはその年度の割り当てを全部、団体の代表は自団体の割り当てを読める。閲覧のみは申請と記録を読めない
select is(tests.visible_lending_all(),
  'admin=G1xLI_CURTAIN G1xLI_TENT G1xLI_WEIGHT G2xLI_TENT G2xLI_WEIGHT | Y1 ; head=G1xLI_CURTAIN G1xLI_TENT G1xLI_WEIGHT G2xLI_TENT G2xLI_WEIGHT | Y1 ; '
  || 'deputy=G1xLI_CURTAIN G1xLI_TENT G1xLI_WEIGHT G2xLI_TENT G2xLI_WEIGHT | Y1 ; '
  || 'staff=G1xLI_CURTAIN G1xLI_TENT G1xLI_WEIGHT G2xLI_TENT G2xLI_WEIGHT G3xLI_Y2_TENT | Y1 Y2 ; '
  || 'viewer=G1xLI_CURTAIN G1xLI_TENT G1xLI_WEIGHT G2xLI_TENT G2xLI_WEIGHT | Y1 ; rep=G1xLI_CURTAIN G1xLI_TENT G1xLI_WEIGHT G3xLI_Y2_TENT | Y1 Y2 ; '
  || 'rep2=G2xLI_TENT G2xLI_WEIGHT | Y1 ; outsider=- | - ; admin2=G3xLI_Y2_TENT | Y2',
  '確定の後：閲覧のみは Y1 の割り当てを全部、店長（rep・rep2）は自団体の割り当てを読める');
select is(tests.q_as('viewer', 'select count(*) from public.lending_requests') || ' ' || tests.q_as('viewer', 'select count(*) from public.lending_records'),
  '0 0', '確定の後も、閲覧のみは申請と記録を読めない');
select is(tests.q_as('rep', $q$ with u as (update public.lending_requests set count = 9 where group_id = :G1 and lending_item_id = :LI_TENT returning 1) select count(*) from u $q$),
  '0', '確定の後も（締切の後なので）店長は申請を直せない（割り当てで直す。0 行）');
-- 解除（deputy・理由つき）→ もう一度確定（admin）：同じ行の更新として残る。解除の間は閲覧のみ・店長に見えない
select is(tests.do_as('deputy', $q$ select coalesce(r.confirmed_at::text, 'null') || ' ' || coalesce(r.confirmed_by::text, 'null')
                                    from public.set_lending_confirmed(:Y1, false, 'T-解除') r $q$), 'null null', '確定を解除する（副部門長・理由つき）');
select set_config('app.reason', '', true);
select is(tests.visible_lending('viewer') || ' / ' || tests.visible_lending('rep2') || ' / ' || tests.visible_lending('rep'),
  '- | Y1(解除) / - | Y1(解除) / G3xLI_Y2_TENT | Y1(解除) Y2', '解除すると、閲覧のみ・店長には Y1 の割り当てがまた見えない');
select tests.set_scenario('allocating');
select tests.ver() as v_conf \gset
select is(tests.do_as('admin', $q$ select tests.nm(r.confirmed_by) from public.set_lending_confirmed(:Y1, true) r $q$), 'admin',
  'もう一度確定する（管理者。振り分け中）');
select set_config('app.reason', '', true);
select is(tests.ver(), :v_conf, '確定では版（allocation_version）は増えない');
select tests.set_scenario('requesting');
select is((select string_agg(action || ':' || reason || ':' || tests.nm(user_id), ' ' order by id)
           from public.audit_logs where table_name = 'lending_years' and year_id = tests.id('Y1')),
  'insert:テント等の割り当ての確定:head update:T-解除:deputy update:テント等の割り当ての確定:admin',
  '確定・解除・確定し直しは、同じ行の insert と update として理由つきで監査に残る');
select is((select count(*)::int from public.lending_years where year_id = tests.id('Y1')), 1, '確定の印は年度に1行のまま');
select is(tests.lending_lock_held('Y1'), '1', '確定と解除の後も、年度のロックを持つ');

-- ================================================================ ⑤ previous_year_lending_items
-- 年度の prev_year_id（複製元）の備品を、並び → 名前（コードポイントの順）→ id の順に返す。部門長以上なら、前年度のロールは要らない
update public.years set prev_year_id = tests.id('Y2') where id = tests.id('Y1');
insert into public.lending_items (year_id, name, unit, stock, requestable_categories, sort_order) values
  (tests.id('Y2'), 'T-a', '個', 0, '{company,rest_area}', 0), (tests.id('Y2'), 'T-B', '枚', 7, '{}', 0);
select is(tests.q_as('head', $q$ select string_agg(p.name || '/' || p.unit || '/' || p.stock || '/' || p.requestable_categories::text || '/' || p.sort_order, ' '
                                                   order by p.ord)
                                 from public.previous_year_lending_items(:Y1) with ordinality as p(name, unit, stock, requestable_categories, sort_order, ord) $q$),
  'T-B/枚/7/{}/0 T-a/個/0/{company,rest_area}/0 T-テント/張/2/{stall,department}/1',
  '前年度（Y2）の備品を、並び → 名前（コードポイントの順：B < a）の順に、名前・単位・在庫・区分・並びで返す（部門長は前年度のロールがなくても読める）');
select is(tests.q_as('head', $q$ select count(*) from public.lending_items where year_id = :Y2 $q$), '0',
  '部門長は前年度の備品の表を直接は読めない（読めるのは RPC が返す列だけ）');
select is(tests.q_as('admin2', $q$ select count(*) from public.previous_year_lending_items(:Y2) $q$), '0', '前年度がない年度（Y2）は 0 行');
select tests.set_scenario('closed');
select is(tests.q_as('head', $q$ select count(*) from public.previous_year_lending_items(:Y1) $q$), '3', '終了の年度でも読める');
select tests.set_scenario('requesting');
select is(tests.q_as('anon', $q$ select count(*) from public.previous_year_lending_items(:Y1) $q$), 'ERR 42501', 'anon は呼べない');

-- ================================================================ ⑥ not_found と forbidden（有無を漏らさない）
-- 段のない人には、ない年度もロールのない年度も同じ forbidden（025 と同じく not_found を返さない）
select is(tests.rpc_error('staff', $q$ select public.save_lending_assignments(gen_random_uuid(), jsonb_build_array(tests.ch('G2', 'LI_TENT', 1))) $q$),
  tests.rpc_error('staff', $q$ select public.save_lending_assignments(:Y1, jsonb_build_array(tests.ch('G2', 'LI_TENT', 1))) $q$),
  '保存：ない年度と、部門長以上でない年度は、同じ forbidden');
select is(tests.rpc_error('head', $q$ select public.set_lending_confirmed(gen_random_uuid(), false, 'T-理由') $q$),
  tests.rpc_error('head', $q$ select public.set_lending_confirmed(:Y2, false, 'T-理由') $q$),
  '確定：ない年度と、ロールのない年度（Y1 の部門長にとっての Y2）は、同じ forbidden');
select is(tests.rpc_error('head', $q$ select count(*) from public.previous_year_lending_items(gen_random_uuid()) $q$),
  tests.rpc_error('head', $q$ select count(*) from public.previous_year_lending_items(:Y2) $q$),
  '前年度の備品：ない年度と、ロールのない年度は、同じ forbidden');
-- 部門長以上には、ほかの年度の団体・備品とない団体・備品を同じ not_in_year で返す（detail に入るのは送った id だけ）
update public.lending_years set confirmed_at = null, confirmed_by = null where year_id = tests.id('Y1');
select is(tests.rpc_error('head', $q$ select public.save_lending_assignments(:Y1, jsonb_build_array(tests.ch('G3', 'LI_TENT', 1))) $q$) #- '{detail,group_id}',
  tests.rpc_error('head', $q$ select public.save_lending_assignments(:Y1, jsonb_build_array(jsonb_build_object('groupId', gen_random_uuid(),
                                'itemId', :LI_TENT, 'count', 1, 'updatedAt', null))) $q$) #- '{detail,group_id}',
  'ほかの年度の団体とない団体は、同じ invalid_input（groupId・not_in_year。ほかの年度にあるかを漏らさない）');
select is(tests.rpc_error('head', $q$ select public.save_lending_assignments(:Y1, jsonb_build_array(tests.ch('G2', 'LI_Y2_TENT', 1))) $q$) #- '{detail,lending_item_id}',
  tests.rpc_error('head', $q$ select public.save_lending_assignments(:Y1, jsonb_build_array(jsonb_build_object('groupId', :G2,
                                'itemId', gen_random_uuid(), 'count', 1, 'updatedAt', null))) $q$) #- '{detail,lending_item_id}',
  'ほかの年度の備品とない備品は、同じ invalid_input（itemId・not_in_year）');
update public.lending_years set confirmed_at = now(), confirmed_by = tests.id('admin') where year_id = tests.id('Y1');

-- ================================================================ ⑦ 権限表の外の直接の書き込み（Y1 は受付中・割り当ての確定中、Y2 は確定中）
-- 書いた人（set_actor）：直接の書き込みで送った updated_by は使わず、書いた人になる（返り値も読める。returning は select のポリシーも通る）
select is(tests.q_as('head', $q$ insert into public.lending_requests (group_id, lending_item_id, year_id, count, updated_by)
                                 values (:G1, :LI_SPARE, :Y1, 1, :rep) returning tests.nm(updated_by) $q$),
  'head', '部門長の申請の代理入力：送った updated_by は使わず、自分になる');
select is(tests.q_as('rep', $q$ update public.lending_requests set count = 3, updated_by = :admin where group_id = :G1 and lending_item_id = :LI_TENT
                                returning tests.nm(updated_by) || ':' || count $q$),
  'rep:3', '店長の申請の更新：updated_by は自分（受付中）');
select is(tests.q_as('staff', $q$ insert into public.lending_records (group_id, lending_item_id, year_id, lent_count, updated_by) values (:G1, :LI_TENT, :Y1, 3, :admin)
                                  on conflict (group_id, lending_item_id) do update set lent_count = excluded.lent_count, updated_by = excluded.updated_by
                                  returning tests.nm(updated_by) || ':' || lent_count || ':' || returned_count $q$),
  'staff:3:1', '部員の記録の upsert（既にある行）：updated_by は自分、送らなかった列（返った数）は元のまま');
-- 画面が作った id で備品を登録し、応答が届かずに送り直すと主キーの重複で止まる（二重にならない。04 の (B1)）
select is(tests.do_as('head', $q$ insert into public.lending_items (id, year_id, name, stock) values ('00000000-0000-4000-8000-0000000c0ffe', :Y1, 'T-画面の id', 1)
                                  returning name $q$),
  'T-画面の id', '部門長は画面が作った id で備品を登録でき、返り値も読める');
select is(tests.rpc_error('head', $q$ insert into public.lending_items (id, year_id, name, stock) values ('00000000-0000-4000-8000-0000000c0ffe', :Y1, 'T-画面の id', 1) $q$),
  '{"code": "error:23505"}'::jsonb, '同じ id で送り直すと 23505（二重にならない）');
select is(tests.rpc_error('head', $q$ delete from public.lending_items where id = :LI_TENT $q$), '{"code": "error:23503"}'::jsonb,
  '申請・割り当て・記録のある備品は、部門長でも消せない（23503）');
-- 書けない人：upsert（insert … on conflict do update）は 42501、update はエラーにならず 0 行
select is((tests.rpc_error('outsider', $q$ insert into public.lending_requests (group_id, lending_item_id, year_id, count) values (:G2, :LI_SPARE, :Y1, 1)
                                          on conflict (group_id, lending_item_id) do update set count = excluded.count $q$) ->> 'code')
          || ' ' || (tests.rpc_error('rep', $q$ insert into public.lending_requests (group_id, lending_item_id, year_id, count) values (:G2, :LI_SPARE, :Y1, 1)
                                          on conflict (group_id, lending_item_id) do update set count = excluded.count $q$) ->> 'code')
          || ' ' || (tests.rpc_error('staff', $q$ insert into public.lending_requests (group_id, lending_item_id, year_id, count) values (:G2, :LI_SPARE, :Y1, 1)
                                          on conflict (group_id, lending_item_id) do update set count = excluded.count $q$) ->> 'code'),
  'error:42501 error:42501 error:42501', '書けない人（未招待・ほかの団体の店長・部員）の申請の upsert は 42501');
select is((tests.rpc_error('rep', $q$ insert into public.lending_records (group_id, lending_item_id, year_id, lent_count) values (:G1, :LI_TENT, :Y1, 3)
                                     on conflict (group_id, lending_item_id) do update set lent_count = excluded.lent_count $q$) ->> 'code')
          || ' ' || (tests.rpc_error('viewer', $q$ insert into public.lending_records (group_id, lending_item_id, year_id, lent_count) values (:G1, :LI_TENT, :Y1, 3)
                                     on conflict (group_id, lending_item_id) do update set lent_count = excluded.lent_count $q$) ->> 'code')
          || ' ' || (tests.rpc_error('outsider', $q$ insert into public.lending_records (group_id, lending_item_id, year_id, lent_count) values (:G1, :LI_TENT, :Y1, 3)
                                     on conflict (group_id, lending_item_id) do update set lent_count = excluded.lent_count $q$) ->> 'code'),
  'error:42501 error:42501 error:42501', '書けない人（店長・閲覧のみ・未招待）の記録の upsert は 42501');
select is(tests.q_as('staff', $q$ with u as (update public.lending_items set stock = 0 where id = :LI_TENT returning 1) select count(*) from u $q$)
          || ' ' || tests.q_as('rep', $q$ with u as (update public.lending_records set lent_count = 9 where group_id = :G1 returning 1) select count(*) from u $q$),
  '0 0', '書けない人の update はエラーにならず 0 行（部員の備品・店長の記録）');
-- 申請できる区分：書ける人には区分の誤り（invalid_input）、書けない人には区分を確かめずに RLS の 42501（備品の区分を漏らさない）
select is(tests.rpc_error('rep2', $q$ insert into public.lending_requests (group_id, lending_item_id, year_id, count) values (:G2, :LI_CURTAIN, :Y1, 1) $q$),
  tests.j('{"code": "invalid_input", "detail": {"field": "lending_item_id", "reason": "not_requestable", "group_id": ":G2", "lending_item_id": ":LI_CURTAIN"}}'),
  'G2（部門）の店長が模擬店だけの三方幕を申請すると区分の誤り');
select is(tests.rpc_error('viewer', $q$ insert into public.lending_requests (group_id, lending_item_id, year_id, count) values (:G4, :LI_CURTAIN, :Y1, 1) $q$),
  tests.j('{"code": "invalid_input", "detail": {"field": "lending_item_id", "reason": "not_requestable", "group_id": ":G4", "lending_item_id": ":LI_CURTAIN"}}'),
  '副店長（viewer。G4 は部門）も自団体で三方幕を申請すると区分の誤り');
select is((tests.rpc_error('outsider', $q$ insert into public.lending_requests (group_id, lending_item_id, year_id, count) values (:G2, :LI_CURTAIN, :Y1, 1) $q$) ->> 'code')
          || ' ' || (tests.rpc_error('rep', $q$ insert into public.lending_requests (group_id, lending_item_id, year_id, count) values (:G2, :LI_CURTAIN, :Y1, 1) $q$) ->> 'code')
          || ' ' || (tests.rpc_error('staff', $q$ insert into public.lending_requests (group_id, lending_item_id, year_id, count) values (:G2, :LI_CURTAIN, :Y1, 1) $q$) ->> 'code'),
  'error:42501 error:42501 error:42501', '書けない人（未招待・ほかの団体の店長・部員）には区分を確かめず 42501');
select tests.set_scenario('requesting:after');
select is((tests.rpc_error('rep2', $q$ insert into public.lending_requests (group_id, lending_item_id, year_id, count) values (:G2, :LI_CURTAIN, :Y1, 1) $q$) ->> 'code')
          || ' ' || (tests.rpc_error('head', $q$ insert into public.lending_requests (group_id, lending_item_id, year_id, count) values (:G2, :LI_CURTAIN, :Y1, 1) $q$) ->> 'code'),
  'error:42501 error:42501', '締切後は、店長も部門長以上も区分でなく 42501（書けない）');
select tests.set_scenario('preparing');
select is(tests.rpc_error('head', $q$ insert into public.lending_requests (group_id, lending_item_id, year_id, count) values (:G2, :LI_CURTAIN, :Y1, 1) $q$),
  tests.j('{"code": "invalid_input", "detail": {"field": "lending_item_id", "reason": "not_requestable", "group_id": ":G2", "lending_item_id": ":LI_CURTAIN"}}'),
  '準備中の部門長（代理入力）には区分の誤り');
select tests.set_scenario('requesting');
-- 確定中の在庫の守り：Y2 の管理者の画面の更新でも止まる（書けない人は RLS が 0 行にする）
select is(tests.rpc_error('admin2', $q$ update public.lending_items set stock = 0 where id = :LI_Y2_TENT $q$),
  tests.j('{"code": "invalid_state", "detail": {"reason": "confirmed", "lending_item_id": ":LI_Y2_TENT", "assigned": 1, "stock": 0}}'),
  'Y2 の管理者が、確定中の在庫を割り当て合計（1）より減らすと invalid_state');
-- 記録を書ける（can_record_lending）：その年度の総務で、終了でない年度。呼んだ人についてだけ答える
select is(format('%s %s %s %s %s %s %s', tests.can_record('admin', 'Y1'), tests.can_record('head', 'Y1'), tests.can_record('deputy', 'Y1'),
                 tests.can_record('staff', 'Y1'), tests.can_record('viewer', 'Y1'), tests.can_record('rep', 'Y1'), tests.can_record('outsider', 'Y1')),
  'true true true true false false false', 'Y1 の記録を書けるのは総務（管理者・部門長・副部門長・部員）だけ（閲覧のみ・店長・未招待は書けない）');
select is(tests.can_record('staff', 'Y2') || ' ' || tests.can_record('rep', 'Y2') || ' ' || tests.can_record('admin2', 'Y2') || ' ' || tests.can_record('admin2', 'Y1'),
  'false false true false', 'Y2：G3 の店長（staff）・閲覧のみ（rep）は書けず、管理者（admin2）は書ける（Y1 は書けない）');
select tests.set_scenario('closed');
select is(tests.can_record('staff', 'Y1') || ' ' || tests.can_record('admin', 'Y1'), 'false false', '終了の年度は、総務でも記録を書けない');
select tests.set_scenario('requesting');
select set_config('request.jwt.claims', '{"role":"authenticated"}', true);
set local role authenticated;
select is(private.can_record_lending((select id from tests.ids where name = 'Y1')), false, 'auth.uid() が null なら記録を書けない');
select tests.logout();
-- 両方の年度の管理者でも、備品・記録を別の年度へ移せない（BEFORE ROW の check_immutable が、ポリシーの with check より先に止める）
insert into public.year_roles (year_id, user_id, role) values (tests.id('Y2'), tests.id('admin'), 'admin');
select is(tests.rpc_error('admin', $q$ update public.lending_items set year_id = :Y2 where id = :LI_SPARE $q$),
  '{"code": "invalid_input", "detail": {"column": "year_id", "reason": "immutable"}}'::jsonb, '両方の年度の管理者でも、備品を別の年度へ移せない');
select is(tests.rpc_error('admin', $q$ update public.lending_records set year_id = :Y2 where group_id = :G1 and lending_item_id = :LI_TENT $q$),
  '{"code": "invalid_input", "detail": {"column": "year_id", "reason": "immutable"}}'::jsonb, '両方の年度の管理者でも、記録を別の年度へ移せない');
delete from public.year_roles where year_id = tests.id('Y2') and user_id = tests.id('admin');
-- anon は5表を読めず、RPC も呼べない
select is((select string_agg(tests.rpc_error('anon', format('select count(*) from public.%I', x.t)) ->> 'code', ' ' order by x.o)
           from unnest(array['lending_items', 'lending_requests', 'lending_assignments', 'lending_records', 'lending_years']) with ordinality as x(t, o)),
  'error:42501 error:42501 error:42501 error:42501 error:42501', 'anon はテント等の5表を読めない');
select is((tests.rpc_error('anon', $q$ select public.save_lending_assignments(:Y1, '[]') $q$) ->> 'code')
          || ' ' || (tests.rpc_error('anon', $q$ select public.set_lending_confirmed(:Y1, true) $q$) ->> 'code')
          || ' ' || (tests.rpc_error('anon', $q$ select count(*) from public.previous_year_lending_items(:Y1) $q$) ->> 'code'),
  'error:42501 error:42501 error:42501', 'anon はテント等の RPC を呼べない');

-- ================================================================ ⑧ 例外の読み替え（D-19）
-- 確かめた後に団体が消えた・同じ行が足された・CHECK に反した、をテストの中だけのトリガー（割り当ての insert の前に動く）で作る。
-- どれも生の SQLSTATE を返さず、invalid_input・conflict に読み替える。Y1 の割り当ての確定を外してから試す
update public.lending_years set confirmed_at = null, confirmed_by = null where year_id = tests.id('Y1');
create function tests.tg_lending_race() returns trigger language plpgsql as $$
begin
  if pg_trigger_depth() = 1 and new.group_id = (select id from tests.ids where name = 'G5') then
    case current_setting('tests.lending_race', true)
      when 'group_deleted' then delete from public.groups where id = new.group_id;    -- 管理者の団体の削除と重なった
      when 'row_added' then insert into public.lending_assignments (group_id, lending_item_id, year_id, count)
                            values (new.group_id, new.lending_item_id, new.year_id, 0);  -- 同じ行が先に足された
      when 'bad_count' then new.count := -1;                                             -- CHECK に反する数になった
      else null;
    end case;
  end if;
  return new;
end $$;
create trigger a_lending_race before insert on public.lending_assignments for each row execute function tests.tg_lending_race();
select set_config('tests.lending_race', 'group_deleted', true);
select is(tests.rpc_error('head', $q$ select public.save_lending_assignments(:Y1, jsonb_build_array(tests.ch('G5', 'LI_SPARE', 1))) $q$),
  '{"code": "invalid_input", "detail": {"field": "changes", "reason": "not_in_year"}}'::jsonb,
  '確かめた後に団体が消えた（外部キーの違反）→ invalid_input（changes・not_in_year）');
select set_config('tests.lending_race', 'row_added', true);
select is(tests.rpc_error('head', $q$ select public.save_lending_assignments(:Y1, jsonb_build_array(tests.ch('G5', 'LI_SPARE', 1))) $q$),
  tests.j('{"code": "conflict", "detail": {"group_id": ":G5", "lending_item_id": ":LI_SPARE"}}'),
  '確かめた後に同じ行が足された（一意の違反）→ conflict（detail は書いていた団体と備品）');
select set_config('tests.lending_race', 'bad_count', true);
select is(tests.rpc_error('head', $q$ select public.save_lending_assignments(:Y1, jsonb_build_array(tests.ch('G5', 'LI_SPARE', 1))) $q$),
  '{"code": "invalid_input", "detail": {"field": "changes"}}'::jsonb, 'CHECK 違反 → invalid_input（changes）');
select set_config('tests.lending_race', '', true);
drop trigger a_lending_race on public.lending_assignments;
select is(tests.rpc_error('head', $q$ select public.save_lending_assignments(:Y1, jsonb_build_array(tests.ch('G5', 'LI_SPARE', 1))) $q$), '{"code": "ok"}'::jsonb,
  'トリガーを外せば同じ保存は通る（上の3つはトリガーの重なりで止まった）');

select * from finish();
rollback;
