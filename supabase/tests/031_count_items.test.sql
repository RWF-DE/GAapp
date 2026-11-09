-- 031_count_items：備品（数えるだけ）の表・トリガー・RPC（T22。D-60。0021_count_items.sql）
-- 期待値は 02 の「備品（数えるだけ）」の表と「備品（数えるだけ）の権限」、04 の DB 関数の行（add_count_item・previous_year_count_stocks）
-- から先に書いてから流した。権限表のセル（表 × 操作 × 年度の状態 × ペルソナ）は 011 が見る。
-- ① 表の形：列の型と既定値、CHECK（名前は lending_items_name_check と同じ式で 50 字まで）、名前の一意（NFKC・小文字）、外部キー、
--    トリガーの一覧（版の増分・確定中の守りがない）、RLS、最初から出す4つ。
-- ② トリガー：数えた人・日時（set_counted）、足した人（set_actor）、鍵の付け替えの禁止（check_immutable）、監査。
-- ③ 版を増やさない：振り分け中に数・名前を書いても allocation_version は変わらない（在庫を書けば増える）。確定中も数を減らせる。
-- ④ add_count_item：同じ名前（NFKC・大文字小文字）なら同じ id、名前の誤り（除かずに拒む）、段の表（年度の状態 × ペルソナ）、anon。
-- ⑤ previous_year_count_stocks：前年度の数、段（総務だけ）、前年度がない、終了の年度。
-- ペルソナ（fixture）：admin・head・deputy・staff・viewer は Y1 のロール。rep は G1（Y1）の店長で Y2 の viewer。admin2 は Y2（preparing）の
-- admin。outsider は何もない。備品（数えるだけ。fixture）：CI_TRASH（0021 のゴミ箱）・CI_WHITE（T-白椅子）・CI_SPARE（T-予備）、
-- 数は Y1 の R1 にゴミ箱 5・T-白椅子 2、Y2 の R1 にゴミ箱 3。
begin;
\ir _helpers/personas.psql
\ir _helpers/fixture.psql

-- ペルソナ（anon なら anon）で SQL を1回流し、エラーのコードと detail を返して必ず取り消す。成功なら {"code": "ok"}
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
-- ペルソナで add_count_item を呼び、返った id を返す（取り消さない）
create function tests.add_as(p_persona text, p_year text, p_name text) returns uuid language plpgsql as $$
declare v uuid;
begin
  perform tests.login_as(p_persona);
  v := public.add_count_item(tests.id(p_year), p_name);
  perform tests.logout();
  return v;
end $$;

select plan(91);

-- ---------------------------------------------------------------- ① 表の形
select col_type_is('count_items', 'name', 'text');
select col_type_is('count_items', 'always_shown', 'boolean');
select col_default_is('count_items', 'always_shown', 'false');
select col_type_is('count_items', 'sort_order', 'integer');
select col_default_is('count_items', 'sort_order', '0');
select col_type_is('count_stocks', 'count', 'integer');
select col_type_is('count_stocks', 'counted_at', 'timestamp with time zone');
select is((select string_agg(table_name || '.' || column_name, ' ' order by table_name, column_name) from information_schema.columns
           where table_schema = 'public' and table_name in ('count_items', 'count_stocks') and is_nullable = 'YES'),
  'count_items.created_by count_stocks.counted_at count_stocks.counted_by',
  '2表で null を許すのは足した人・数えた人・数えた日時だけ');
select is((select string_agg(table_name || '.' || column_name, ' ' order by table_name, column_name) from information_schema.columns
           where table_schema = 'public' and table_name in ('count_items', 'count_stocks') and column_default is not null
             and column_name not in ('created_at', 'updated_at')),
  'count_items.always_shown count_items.id count_items.sort_order',
  '既定値があるのは名前の一覧の id・最初から出す・並びだけ（名前・年度・場所・物・数には既定値がない）');
select col_is_pk('count_items', 'id');
select col_is_pk('count_stocks', array['year_id','room_id','count_item_id']);
-- CHECK：名前は lending_items_name_check と同じ式（同じ 25 文字の空白を除いた形）で 50 字まで。数は 0〜10000
select is((select string_agg(conname, ' ' order by conname) from pg_constraint
           where contype = 'c' and conrelid in ('public.count_items'::regclass, 'public.count_stocks'::regclass)),
  'count_items_name_check count_stocks_count_check', '2表の CHECK は名前と数の2つ');
select is((select pg_get_constraintdef(oid) from pg_constraint where conname = 'count_items_name_check'),
  (select replace(pg_get_constraintdef(oid), '<= 100', '<= 50') from pg_constraint where conname = 'lending_items_name_check'),
  'count_items_name_check は lending_items_name_check と同じ式で 50 字まで');
select is((select pg_get_constraintdef(oid) from pg_constraint where conname = 'count_stocks_count_check'),
  'CHECK (((count >= 0) AND (count <= 10000)))', '数は 0〜10000');
select is((select indexdef from pg_indexes where schemaname = 'public' and indexname = 'count_items_name_key'),
  'CREATE UNIQUE INDEX count_items_name_key ON public.count_items USING btree (lower(NORMALIZE(name, NFKC)))',
  '名前の一意の索引は NFKC にして小文字にした名前（画面の nameKey と同じ比べ方）');
select is((select string_agg(conname || '=' || confdeltype::text || ': ' || pg_get_constraintdef(oid), ' / ' order by conname collate "C")
           from pg_constraint where contype = 'f' and conrelid in ('public.count_items'::regclass, 'public.count_stocks'::regclass)),
  'count_items_created_by_fkey=n: FOREIGN KEY (created_by) REFERENCES auth.users(id) ON DELETE SET NULL / '
  || 'count_stocks_count_item_id_fkey=r: FOREIGN KEY (count_item_id) REFERENCES count_items(id) ON DELETE RESTRICT / '
  || 'count_stocks_counted_by_fkey=n: FOREIGN KEY (counted_by) REFERENCES auth.users(id) ON DELETE SET NULL / '
  || 'count_stocks_room_id_fkey=r: FOREIGN KEY (room_id) REFERENCES rooms(id) ON DELETE RESTRICT / '
  || 'count_stocks_year_id_fkey=c: FOREIGN KEY (year_id) REFERENCES years(id) ON DELETE CASCADE',
  '外部キーは5本（年度へ cascade、場所と物へ restrict、人へ set null）');
select has_index('count_stocks', 'count_stocks_room_id_idx');
select has_index('count_stocks', 'count_stocks_count_item_id_idx');
-- トリガー：版の増分（bump_version_*）・確定中の守り（guard_confirmed）・終了の守り（lock_year_guard）はない
select is((select string_agg(c.relname || '.' || t.tgname, ' ' order by c.relname, t.tgname) from pg_trigger t join pg_class c on c.oid = t.tgrelid
           where c.oid in ('public.count_items'::regclass, 'public.count_stocks'::regclass) and not t.tgisinternal),
  'count_items.audit count_items.set_actor count_items.set_timestamps '
  || 'count_stocks.audit count_stocks.check_immutable count_stocks.set_counted count_stocks.set_timestamps',
  '2表のトリガーは監査・日時・足した人・数えた人・付け替えの禁止だけ（版の増分と確定中の守りはない）');
select is((select pg_get_triggerdef(t.oid) from pg_trigger t where t.tgname = 'check_immutable' and t.tgrelid = 'public.count_stocks'::regclass),
  'CREATE TRIGGER check_immutable BEFORE UPDATE OF year_id, room_id, count_item_id ON public.count_stocks FOR EACH ROW EXECUTE FUNCTION private.tg_immutable_columns(''year_id'', ''room_id'', ''count_item_id'')',
  'count_stocks の check_immutable は年度・場所・物の3列');
select ok((select bool_and(relrowsecurity) from pg_class where oid in ('public.count_items'::regclass, 'public.count_stocks'::regclass)),
  '2表とも RLS が有効');
select ok((select bool_and(p.prosecdef and 'search_path=""' = any (p.proconfig)) from pg_proc p
           where p.oid in ('public.add_count_item(uuid, text)'::regprocedure, 'public.previous_year_count_stocks(uuid)'::regprocedure)),
  '2つの RPC は SECURITY DEFINER・search_path = ""');
-- 最初から出す4つ（0021）
select is((select string_agg(name || ':' || sort_order, ' ' order by sort_order) from public.count_items where always_shown),
  'ゴミ箱:1 延長コード:2 扇風機:3 オレンジ椅子:4', '最初から出す4つが並び順どおり（ゴミ箱・延長コード・扇風機・オレンジ椅子）');
select ok((select bool_and(created_by is null) from public.count_items where always_shown), '最初から出す4つは足した人がない（マイグレーション）');

-- 名前の CHECK と一意（postgres。DB は除かずに拒む）
select throws_ok($$ insert into public.count_items (name) values ('') $$, '23514', null, '名前が空');
select throws_ok($$ insert into public.count_items (name) values (' T-椅子') $$, '23514', null, '名前の前に半角の空白');
select throws_ok(format($$ insert into public.count_items (name) values (%L) $$, 'T-椅子' || chr(12288)), '23514', null, '名前の後ろに全角の空白');
select throws_ok($$ insert into public.count_items (name) values (repeat('あ', 51)) $$, '23514', null, '名前は 50 字まで');
select lives_ok($$ insert into public.count_items (name) values (repeat('あ', 50)) $$, '50 字の名前は入る');
select throws_ok($$ insert into public.count_items (name) values ('ｺﾞﾐ箱') $$, '23505', null, '半角のカタカナでも同じ名前（NFKC）は入らない');
select lives_ok($$ insert into public.count_items (name) values ('T-Lan') $$, 'T-Lan は入る');
select throws_ok($$ insert into public.count_items (name) values ('T-LAN') $$, '23505', null, '大文字小文字だけが違う名前は入らない');
select throws_ok($$ insert into public.count_items (name) values ('Ｔ－ｌａｎ') $$, '23505', null, '全角の英字・記号だけが違う名前は入らない（NFKC）');
select throws_ok(format($$ insert into public.count_stocks (year_id, room_id, count_item_id, count) values (%L, %L, %L, 10001) $$,
                        tests.id('Y1'), tests.id('R2'), tests.id('CI_TRASH')), '23514', null, '数は 10000 まで');
select throws_ok(format($$ delete from public.count_items where id = %L $$, tests.id('CI_WHITE')), '23503', null, '数のある物は消せない（restrict）');
insert into public.count_stocks (year_id, room_id, count_item_id, count) values (tests.id('Y1'), tests.id('R4'), tests.id('CI_SPARE'), 1);
select throws_ok(format($$ delete from public.rooms where id = %L $$, tests.id('R4')), '23503', null, '数のある場所は消せない（restrict。R4 は在庫のない場所）');
delete from public.count_stocks where room_id = tests.id('R4');

-- ---------------------------------------------------------------- ② トリガー
-- 数えた人・日時：ログインしている人の書き込みでは DB が入れる（クライアントの値は使わない）
select tests.login_as('staff');
select lives_ok(format($$ insert into public.count_stocks (year_id, room_id, count_item_id, count, counted_by, counted_at)
                          values (%L, %L, %L, 4, %L, '2000-01-01') $$, tests.id('Y1'), tests.id('R2'), tests.id('CI_TRASH'), tests.id('admin')),
  'staff が数を足せる（受付中）');
select tests.logout();
select is((select format('%s %s', counted_by = tests.id('staff'), counted_at > now() - interval '1 minute')
           from public.count_stocks where year_id = tests.id('Y1') and room_id = tests.id('R2') and count_item_id = tests.id('CI_TRASH')),
  't t', '数えた人と日時は DB が入れる（送った値ではない）');
select tests.login_as('head');
select lives_ok(format($$ update public.count_stocks set count = 6 where year_id = %L and room_id = %L and count_item_id = %L $$,
                       tests.id('Y1'), tests.id('R2'), tests.id('CI_TRASH')), '部門長が数を直せる');
select tests.logout();
select is((select (counted_by = tests.id('head'))::text from public.count_stocks
           where year_id = tests.id('Y1') and room_id = tests.id('R2') and count_item_id = tests.id('CI_TRASH')),
  'true', '直すと数えた人が直した人になる');
select is((select counted_by from public.count_stocks where year_id = tests.id('Y1') and room_id = tests.id('R1') and count_item_id = tests.id('CI_TRASH')),
  null::uuid, 'seed・SQL Editor（auth.uid() がない）の書き込みは入れた値のまま（fixture は null）');
-- 付け替えの禁止
select is(tests.error_json(format($$ update public.count_stocks set room_id = %L where year_id = %L and room_id = %L and count_item_id = %L $$,
                                  tests.id('R3'), tests.id('Y1'), tests.id('R1'), tests.id('CI_WHITE'))),
  '{"code": "invalid_input", "detail": {"column": "room_id", "reason": "immutable"}}', '数の場所は変えられない');
select is(tests.error_json(format($$ update public.count_stocks set count_item_id = %L where year_id = %L and room_id = %L and count_item_id = %L $$,
                                  tests.id('CI_SPARE'), tests.id('Y1'), tests.id('R1'), tests.id('CI_WHITE'))),
  '{"code": "invalid_input", "detail": {"column": "count_item_id", "reason": "immutable"}}', '数の物は変えられない');
select is(tests.error_json(format($$ update public.count_stocks set year_id = %L where year_id = %L and room_id = %L and count_item_id = %L $$,
                                  tests.id('Y2'), tests.id('Y1'), tests.id('R1'), tests.id('CI_WHITE'))),
  '{"code": "invalid_input", "detail": {"column": "year_id", "reason": "immutable"}}', '数の年度は変えられない');
-- 監査：数は年度つき、名前の一覧は年度なし。理由は null（直接の書き込み）
select is((select format('%s %s %s %s', a.action, a.year_id = tests.id('Y1'), a.user_id = tests.id('head'), coalesce(a.reason, 'null'))
           from public.audit_logs a where a.table_name = 'count_stocks' and a.action = 'update'
             and a.row_pk = jsonb_build_object('year_id', tests.id('Y1'), 'room_id', tests.id('R2'), 'count_item_id', tests.id('CI_TRASH'))),
  'update t t null', '数の変更は監査に残る（年度・書いた人つき、理由は null）');
select is((select format('%s %s', count(*), bool_and(year_id is null and group_id is null)) from public.audit_logs
           where table_name = 'count_items' and row_pk = jsonb_build_object('id', tests.id('CI_WHITE'))),
  '1 t', '名前の一覧の行の監査は年度・団体なし');
-- 足した人：ログインしている人の insert では DB が入れ、update では元の値のまま
select tests.login_as('admin');
select lives_ok($$ insert into public.count_items (name, created_by) values ('T-掃除機', null) $$, '管理者は名前の一覧に直接足せる');
select tests.logout();
select is((select created_by from public.count_items where name = 'T-掃除機'), tests.id('admin'), '足した人は DB が入れる');
select tests.login_as('admin');
select lives_ok(format($$ update public.count_items set name = 'T-掃除機（小）', created_by = %L where name = 'T-掃除機' $$, tests.id('head')),
  '管理者は名前を直せる');
select tests.logout();
select is((select created_by from public.count_items where name = 'T-掃除機（小）'), tests.id('admin'), '直しても足した人は変わらない');

-- ---------------------------------------------------------------- ③ 版を増やさない
select tests.set_scenario('allocating');
select tests.ver() as v0 \gset
select tests.login_as('admin');
select lives_ok(format($$ insert into public.count_stocks (year_id, room_id, count_item_id, count) values (%L, %L, %L, 1)
                          on conflict (year_id, room_id, count_item_id) do update set count = excluded.count $$,
                       tests.id('Y1'), tests.id('R3'), tests.id('CI_WHITE')), '振り分け中に管理者が数を書ける');
select lives_ok(format($$ delete from public.count_stocks where year_id = %L and room_id = %L and count_item_id = %L $$,
                       tests.id('Y1'), tests.id('R3'), tests.id('CI_WHITE')), '振り分け中に管理者が数を消せる');
select lives_ok($$ update public.count_items set sort_order = sort_order + 1 where name = 'T-掃除機（小）' $$, '振り分け中に名前の一覧を直せる');
select lives_ok(format($$ select public.add_count_item(%L, 'T-台形机') $$, tests.id('Y1')), '振り分け中に部門長以上は名前を足せる');
select tests.logout();
select is(tests.ver(), :v0, '数・名前の一覧の書き込みと add_count_item では振り分けの版が増えない');
select tests.login_as('admin');
select lives_ok(format($$ update public.stocks set count = count where year_id = %L and room_id = %L $$, tests.id('Y1'), tests.id('R1')),
  '（比べ）在庫を書く');
select tests.logout();
select ok(tests.ver() > :v0, '（比べ）在庫を書けば版が増える（守りが空振りしていない）');
-- 確定中：数は振り分けに使わないので、部門長以上は減らせる（stocks の guard_confirmed のような守りはない）
select tests.set_scenario('confirmed');
select tests.login_as('head');
select is(tests.error_json(format($$ update public.count_stocks set count = 0 where year_id = %L and room_id = %L and count_item_id = %L $$,
                                  tests.id('Y1'), tests.id('R1'), tests.id('CI_TRASH'))),
  '{"code": "ok"}', '確定中も部門長は数を 0 にできる');
select tests.logout();
select tests.set_scenario('requesting');

-- ---------------------------------------------------------------- ④ add_count_item
-- 同じ名前ならその id（足さない）
select is(tests.add_as('staff', 'Y1', 'ゴミ箱'), tests.id('CI_TRASH'), '同じ名前（ゴミ箱）はその id を返す');
select is(tests.add_as('staff', 'Y1', 'ｺﾞﾐ箱'), tests.id('CI_TRASH'), '半角のカタカナでも同じ名前（NFKC）ならその id');
select is((select count(*)::int from public.count_items where lower(normalize(name, NFKC)) = 'ゴミ箱'), 1, 'ゴミ箱は1行のまま');
select tests.add_as('staff', 'Y1', 'T-Fan') as fan \gset
select is(tests.add_as('head', 'Y1', 'T-FAN'), :'fan'::uuid, '大文字小文字だけが違う名前は同じ id');
select is(tests.add_as('admin', 'Y1', 'Ｔ－ｆａｎ'), :'fan'::uuid, '全角の英字・記号だけが違う名前も同じ id（NFKC）');
select is((select format('%s %s %s %s', name, always_shown, created_by = tests.id('staff'),
                         sort_order = (select max(ci.sort_order) from public.count_items ci where ci.id <> :'fan'::uuid) + 1)
           from public.count_items where id = :'fan'::uuid),
  'T-Fan f t t', '新しい名前は書いたとおりに足し、最初から出さず、足した人を入れ、並びは最大＋1');
-- 名前の誤り（除かずに拒む。invalid_input、field: name）。書けない人には名前を確かめる前に forbidden
select is(tests.rpc_error('staff', $q$ select public.add_count_item(:Y1, null) $q$),
  '{"code": "invalid_input", "detail": {"field": "name"}}', '名前が null');
select is(tests.rpc_error('staff', $q$ select public.add_count_item(:Y1, '') $q$),
  '{"code": "invalid_input", "detail": {"field": "name"}}', '名前が空');
select is(tests.rpc_error('staff', $q$ select public.add_count_item(:Y1, ' T-椅子') $q$),
  '{"code": "invalid_input", "detail": {"field": "name"}}', '名前の前に空白（除かない）');
select is(tests.rpc_error('staff', $q$ select public.add_count_item(:Y1, 'T-椅子' || chr(12288)) $q$),
  '{"code": "invalid_input", "detail": {"field": "name"}}', '名前の後ろに全角の空白（除かない）');
select is(tests.rpc_error('staff', $q$ select public.add_count_item(:Y1, chr(9)) $q$),
  '{"code": "invalid_input", "detail": {"field": "name"}}', '名前がタブだけ');
select is(tests.rpc_error('staff', $q$ select public.add_count_item(:Y1, repeat('い', 51)) $q$),
  '{"code": "invalid_input", "detail": {"field": "name"}}', '名前が 51 字');
select is(tests.rpc_error('staff', $q$ select public.add_count_item(:Y1, repeat('い', 50)) $q$),
  '{"code": "ok"}', '50 字の名前は足せる');
select is(tests.rpc_error('viewer', $q$ select public.add_count_item(:Y1, '') $q$),
  '{"code": "forbidden", "detail": null}', '書けない人には名前を確かめる前に forbidden');
select is(tests.rpc_error('admin', $q$ select public.add_count_item(null, 'T-机') $q$),
  '{"code": "forbidden", "detail": null}', '年度が null なら forbidden');
select is(tests.rpc_error('admin', format($q$ select public.add_count_item(%L, 'T-机') $q$, gen_random_uuid())),
  '{"code": "forbidden", "detail": null}', 'ない年度なら forbidden');
select is(tests.rpc_error('anon', $q$ select public.add_count_item(:Y1, 'T-机') $q$),
  '{"code": "error:42501"}', 'anon は呼べない（execute の権限がない）');
-- 段の表：年度の状態ごとに、呼べる人（在庫を書ける人。can_write_stocks）だけが ok。書けない人は forbidden（終了の年度も）
create function tests.tier_row(p_scenario text) returns text language plpgsql as $$
declare v text := ''; p text;
begin
  foreach p in array array['admin', 'head', 'deputy', 'staff', 'viewer', 'rep', 'outsider', 'admin2'] loop
    v := v || ' ' || p || '=' || tests.try_rpc(p, tests.sql('select public.add_count_item(:Y1, ''T-段の確かめ'')'), p_scenario);
  end loop;
  return ltrim(v);
end $$;
select is(tests.tier_row(s), e, 'add_count_item の段（Y1 が ' || s || '）')
from (values
  ('preparing', 'admin=ok head=ok deputy=ok staff=ok viewer=forbidden rep=forbidden outsider=forbidden admin2=forbidden'),
  ('requesting', 'admin=ok head=ok deputy=ok staff=ok viewer=forbidden rep=forbidden outsider=forbidden admin2=forbidden'),
  ('requesting:after', 'admin=ok head=ok deputy=ok staff=ok viewer=forbidden rep=forbidden outsider=forbidden admin2=forbidden'),
  ('allocating', 'admin=ok head=ok deputy=ok staff=forbidden viewer=forbidden rep=forbidden outsider=forbidden admin2=forbidden'),
  ('confirmed', 'admin=ok head=ok deputy=ok staff=forbidden viewer=forbidden rep=forbidden outsider=forbidden admin2=forbidden'),
  ('closed', 'admin=forbidden head=forbidden deputy=forbidden staff=forbidden viewer=forbidden rep=forbidden outsider=forbidden admin2=forbidden')
) as v(s, e);
select is((select count(*)::int from public.count_items where name = 'T-段の確かめ'), 0, '段の表の呼び出しはすべて取り消した');
-- Y2 の管理者は Y2 では足せる（名前の一覧は年度をまたぐので、Y1 からも同じ物が見える）
select tests.add_as('admin2', 'Y2', 'T-延長コード（10m）') as cord \gset
select is(tests.add_as('staff', 'Y1', 'T-延長コード（10m）'), :'cord'::uuid, 'ほかの年度で足した名前も同じ id（年度をまたぐ）');
-- 足した名前は誰でも（招待された人なら）読める。書き込みのポリシーは管理者だけのまま（staff は直接 insert できない）
select tests.login_as('staff');
select throws_ok($$ insert into public.count_items (name) values ('T-直接') $$, '42501', null, 'staff は名前の一覧に直接足せない（RPC だけ）');
select tests.logout();

-- ---------------------------------------------------------------- ⑤ previous_year_count_stocks
update public.years set prev_year_id = tests.id('Y2') where id = tests.id('Y1');
create function tests.prev_as(p_persona text, p_year text) returns text language plpgsql as $$
declare v text;
begin
  perform tests.login_as(p_persona);
  select coalesce(string_agg(format('%s/%s/%s', tests.nm(p.room_id), tests.nm(p.count_item_id), p.count), ' '
                             order by tests.nm(p.room_id), tests.nm(p.count_item_id)), '-')
  into v from public.previous_year_count_stocks(tests.id(p_year)) p;
  perform tests.logout();
  return v;
end $$;
create function tests.nm(p_id uuid) returns text language sql stable as $$
  select coalesce((select t.name from tests.ids t where t.id = p_id order by t.name limit 1), '?')
$$;
grant execute on all functions in schema tests to authenticated, anon;
select is(tests.prev_as('admin', 'Y1'), 'R1/CI_TRASH/3', '管理者は前年度（Y2）の数を読める（Y2 のロールは要らない）');
select is(tests.prev_as('staff', 'Y1'), 'R1/CI_TRASH/3', '部員も前年度の数を読める');
select is(tests.rpc_error('viewer', $q$ select public.previous_year_count_stocks(:Y1) $q$),
  '{"code": "forbidden", "detail": null}', '閲覧のみは前年度の数を読めない');
select is(tests.rpc_error('rep', $q$ select public.previous_year_count_stocks(:Y1) $q$),
  '{"code": "forbidden", "detail": null}', '店長は前年度の数を読めない');
select is(tests.rpc_error('admin2', $q$ select public.previous_year_count_stocks(:Y1) $q$),
  '{"code": "forbidden", "detail": null}', 'ほかの年度の管理者は読めない');
select is(tests.prev_as('admin2', 'Y2'), '-', '前年度がなければ 0 行');
select tests.set_scenario('closed');
select is(tests.prev_as('head', 'Y1'), 'R1/CI_TRASH/3', '終了した年度でも前年度の数を読める');
select tests.set_scenario('requesting');

select * from finish();
rollback;
