-- 001_schema：列挙型・表・列・制約・index・ビュー・RLS・権限・seed（T02）
begin;
\ir _helpers/personas.psql
\ir _helpers/fixture.psql
select plan(133);

-- 列挙型
select enum_has_labels('public', 'year_status', array['preparing','requesting','allocating','confirmed','closed']);
select enum_has_labels('public', 'group_category', array['stall','department','company','rest_area']);
select enum_has_labels('public', 'room_kind', array['room','gym','outdoor','other']);
select enum_has_labels('public', 'app_role', array['admin','staff','viewer']);
select enum_has_labels('public', 'rule_kind', array['substitute','source_restrict','fixed_request','keep']);
select enum_has_labels('public', 'alloc_origin', array['auto','manual']);
select enum_has_labels('public', 'consent_status', array['not_asked','asked','accepted','declined']);
select enum_has_labels('public', 'festival_day', array['day_minus2','day_minus1','day1','day2']);
select enum_has_labels('public', 'delivery_kind', array['furniture','tent','weight','side_curtain']);
select enum_has_labels('public', 'delivery_status', array['pending','done','problem']);

-- 表が 19 個、ビューが v_remaining
select tables_are('public', array['years','rooms','room_years','items','stocks','groups','year_roles','group_members',
  'invitations','request_submissions','requests','rules','substitution_consents','allocations',
  'distance_overrides','slots','deliveries','profiles','audit_logs'], 'public の表は 19 個');
select views_are('public', array['v_remaining'], 'public のビューは v_remaining だけ');

-- 列（表ごとに列の集合が一致する）
select columns_are('public', 'years', array['id','label','festival_start','request_open_at','request_close_at','status','allocation_version','auto_allocated_at','prev_year_id','created_at','updated_at']);
select columns_are('public', 'rooms', array['id','name','aliases','kind','building','floor','is_storage','extra_cost','sort_order','created_at','updated_at']);
select columns_are('public', 'room_years', array['year_id','room_id','usable','note','created_at','updated_at']);
select columns_are('public', 'items', array['id','code','name','aliases','requestable_categories','sort_order','created_at','updated_at']);
select columns_are('public', 'stocks', array['year_id','room_id','item_id','count','counted_by','counted_at','created_at','updated_at']);
select columns_are('public', 'groups', array['id','year_id','name','display_name','aliases','category','is_food','location_room_id','sort_order','created_at','updated_at']);
select columns_are('public', 'year_roles', array['year_id','user_id','role','created_at','updated_at']);
select columns_are('public', 'group_members', array['group_id','user_id','created_at','updated_at']);
select columns_are('public', 'invitations', array['id','year_id','email','role','group_id','used_at','created_at','updated_at']);
select columns_are('public', 'request_submissions', array['group_id','submitted_at','note','updated_by','created_at','updated_at']);
select columns_are('public', 'requests', array['group_id','item_id','count','created_at','updated_at']);
select columns_are('public', 'rules', array['id','year_id','code','kind','params','enabled','memo','created_at','updated_at']);
select columns_are('public', 'substitution_consents', array['group_id','from_item_id','to_item_id','count','status','note','created_at','updated_at']);
select columns_are('public', 'allocations', array['id','year_id','source_room_id','group_id','item_id','requested_item_id','count','is_keep','pinned','origin','note','created_at','updated_at']);
select columns_are('public', 'distance_overrides', array['building_a','building_b','cost','created_at','updated_at']);
select columns_are('public', 'slots', array['id','year_id','day','starts_at','ends_at','label','created_at','updated_at']);
select columns_are('public', 'deliveries', array['id','year_id','group_id','kind','slot_id','team','status','problem_note','returned','checked_by','checked_at','created_at','updated_at']);
select columns_are('public', 'profiles', array['user_id','display_name','created_at','updated_at']);
select columns_are('public', 'audit_logs', array['id','table_name','row_pk','action','year_id','group_id','before','after','reason','user_id','at']);
select columns_are('public', 'v_remaining', array['year_id','room_id','item_id','stock','allocated','remaining']);

-- 主な列の型・既定値
select col_type_is('years', 'allocation_version', 'integer');
select col_default_is('years', 'allocation_version', '0');
select col_default_is('years', 'status', 'preparing');
select col_type_is('years', 'request_close_at', 'timestamp with time zone');
select col_type_is('stocks', 'counted_at', 'timestamp with time zone');
select col_type_is('items', 'requestable_categories', 'group_category[]');
select is((select column_default from information_schema.columns where table_name = 'items' and column_name = 'requestable_categories'),
  '''{}''::group_category[]', 'items.requestable_categories の既定は空');
select col_type_is('v_remaining', 'allocated', 'integer');
select col_type_is('v_remaining', 'remaining', 'integer');
select col_not_null('allocations', 'requested_item_id');
select col_not_null('allocations', 'origin');
select col_is_null('deliveries', 'slot_id');
select ok((select bool_and(is_nullable = 'NO' and column_default is not null)
           from information_schema.columns
           where table_schema = 'public' and column_name in ('created_at', 'updated_at')
             and table_name <> 'audit_logs'),
  'created_at・updated_at は全表で not null・既定値あり');

-- 主キー
select col_is_pk('years', 'id');
select col_is_pk('room_years', array['year_id','room_id']);
select col_is_pk('stocks', array['year_id','room_id','item_id']);
select col_is_pk('year_roles', array['year_id','user_id']);
select col_is_pk('group_members', array['group_id','user_id']);
select col_is_pk('request_submissions', 'group_id');
select col_is_pk('requests', array['group_id','item_id']);
select col_is_pk('substitution_consents', array['group_id','from_item_id','to_item_id']);
select col_is_pk('distance_overrides', array['building_a','building_b']);
select col_is_pk('profiles', 'user_id');
select col_is_pk('audit_logs', 'id');

-- 一意制約
select col_is_unique('years', 'label');
select col_is_unique('rooms', 'name');
select col_is_unique('items', 'code');
select col_is_unique('groups', array['year_id','name']);
select col_is_unique('groups', array['id','year_id']);
select col_is_unique('slots', array['id','year_id']);
select col_is_unique('deliveries', array['group_id','kind']);
select col_is_unique('rules', array['year_id','code']);

-- 外部キー（年度の一致は複合外部キー）
select fk_ok('public', 'allocations', array['group_id','year_id'], 'public', 'groups', array['id','year_id']);
select fk_ok('public', 'deliveries', array['group_id','year_id'], 'public', 'groups', array['id','year_id']);
select fk_ok('public', 'deliveries', array['slot_id','year_id'], 'public', 'slots', array['id','year_id']);
select fk_ok('public', 'invitations', array['group_id','year_id'], 'public', 'groups', array['id','year_id']);
select fk_ok('public', 'years', 'prev_year_id', 'public', 'years', 'id');
select fk_ok('public', 'stocks', 'counted_by', 'auth', 'users', 'id');

-- on delete の動作（c＝cascade、r＝restrict、n＝set null）
with fk as (
  select conrelid::regclass::text as tbl, confrelid::regclass::text as ref, confdeltype as del,
         (select string_agg(a.attname, ',' order by a.attnum) from pg_attribute a
           where a.attrelid = c.conrelid and a.attnum = any (c.conkey)) as cols
  from pg_constraint c where c.contype = 'f' and c.connamespace = 'public'::regnamespace)
select is((select string_agg(tbl || '.' || cols, ' ' order by tbl, cols) from fk where del = 'r'),
  'allocations.item_id allocations.requested_item_id allocations.source_room_id groups.location_room_id requests.item_id room_years.room_id stocks.item_id stocks.room_id substitution_consents.from_item_id substitution_consents.to_item_id',
  '場所・品目への外部キーは restrict');
with fk as (
  select conrelid::regclass::text as tbl, confdeltype as del,
         (select string_agg(a.attname, ',' order by a.attnum) from pg_attribute a
           where a.attrelid = c.conrelid and a.attnum = any (c.conkey)) as cols
  from pg_constraint c where c.contype = 'f' and c.connamespace = 'public'::regnamespace)
select is((select string_agg(tbl || '.' || cols, ' ' order by tbl, cols) from fk where del = 'n'),
  'deliveries.checked_by deliveries.year_id,slot_id request_submissions.updated_by stocks.counted_by years.prev_year_id',
  '記録のためのユーザー参照・時間枠・複製元は set null');
select is((select count(*)::int from pg_constraint c
           where c.contype = 'f' and c.connamespace = 'public'::regnamespace and c.confdeltype = 'c'), 19,
  '年度・団体・ユーザーへの参照は cascade（19 本）');
select is((select pg_get_constraintdef(oid) from pg_constraint where conname = 'deliveries_slot_id_year_id_fkey'),
  'FOREIGN KEY (slot_id, year_id) REFERENCES slots(id, year_id) ON DELETE SET NULL (slot_id)',
  '時間枠を消しても受け渡しの year_id は残す（列を指定した set null）');

-- CHECK 制約（上限と形）。fixture のデータは書き換えず、new な行か update で試す
select throws_ok($$ insert into public.years (label, festival_start) values (' ', date '2030-01-01') $$, '23514', null, 'years.label が空白だけ');
select throws_ok($$ insert into public.years (label, festival_start) values (repeat('a', 51), date '2030-01-01') $$, '23514', null, 'years.label は 50 字まで');
select throws_ok($$ insert into public.years (label, festival_start, request_open_at, request_close_at)
                    values ('T-Y9', date '2030-01-01', now(), now()) $$, '23514', null, '受付開始は締切より前');
select throws_ok($$ insert into public.rooms (name) values ('') $$, '23514', null, 'rooms.name が空');
select throws_ok($$ insert into public.rooms (name, extra_cost) values ('pgtap-x', -1) $$, '23514', null, 'rooms.extra_cost は 0 以上');
select throws_ok($$ insert into public.rooms (name, aliases) values ('pgtap-x', array_fill('a'::text, array[21])) $$, '23514', null, 'aliases は 20 個まで');
select throws_ok($$ insert into public.rooms (name, aliases) values ('pgtap-x', array[repeat('a', 1001)]) $$, '23514', null, 'aliases は合計 1000 字まで');
select throws_ok($$ insert into public.items (code, name, sort_order) values ('Desk', 'x', 1) $$, '23514', null, 'items.code は小文字の英数字と _');
select throws_ok($$ insert into public.items (code, name, sort_order) values ('1desk', 'x', 1) $$, '23514', null, 'items.code は英字で始まる');
select throws_ok(format($$ update public.stocks set count = -1 where year_id = %L and room_id = %L and item_id = %L $$,
  tests.id('Y1'), tests.id('R1'), tests.id('desk')), '23514', null, 'stocks.count は 0 以上');
select throws_ok(format($$ update public.stocks set count = 10001 where year_id = %L and room_id = %L and item_id = %L $$,
  tests.id('Y1'), tests.id('R1'), tests.id('desk')), '23514', null, 'stocks.count は 10000 まで');
select throws_ok(format($$ update public.requests set count = 10001 where group_id = %L and item_id = %L $$,
  tests.id('G1'), tests.id('desk')), '23514', null, 'requests.count は 10000 まで');
select throws_ok(format($$ update public.request_submissions set note = repeat('あ', 2001) where group_id = %L $$,
  tests.id('G1')), '23514', null, '備考は 2000 字まで');
select lives_ok(format($$ update public.request_submissions set note = repeat('あ', 2000) where group_id = %L $$,
  tests.id('G1')), '備考 2000 字は通る');
select throws_ok(format($$ update public.allocations set count = 0 where id = %L $$, tests.id('A_G2')), '23514', null, 'allocations.count は 1 以上');
select throws_ok(format($$ update public.allocations set count = 10001 where id = %L $$, tests.id('A_G2')), '23514', null, 'allocations.count は 10000 まで');
select throws_ok(format($$ update public.allocations set note = repeat('a', 2001) where id = %L $$, tests.id('A_G2')), '23514', null, 'allocations.note は 2000 字まで');
select throws_ok(format($$ insert into public.invitations (year_id, email, role, group_id) values (%L, 'both@pgtap.test', 'viewer', %L) $$,
  tests.id('Y1'), tests.id('G1')), '23514', null, '招待は role と group_id の両方を持てない');
select throws_ok(format($$ insert into public.invitations (year_id, email) values (%L, 'none@pgtap.test') $$,
  tests.id('Y1')), '23514', null, '招待は role か group_id のどちらかが要る');
select throws_ok(format($$ insert into public.invitations (year_id, email, role) values (%L, 'Upper@pgtap.test', 'viewer') $$,
  tests.id('Y1')), '23514', null, '招待のメールは小文字');
select throws_ok(format($$ insert into public.invitations (year_id, email, role) values (%L, 'no-at-sign', 'viewer') $$,
  tests.id('Y1')), '23514', null, '招待のメールの形');
select throws_ok(format($$ insert into public.rules (year_id, code, kind, params) values (%L, 'S90', 'keep', '[]') $$,
  tests.id('Y1')), '23514', null, 'rules.params は object');
select throws_ok(format($$ insert into public.rules (year_id, code, kind, params) values (%L, 'S91', 'keep', jsonb_build_object('x', repeat('a', 20000))) $$,
  tests.id('Y1')), '23514', null, 'rules.params は 20000 字まで');
select throws_ok(format($$ insert into public.substitution_consents (group_id, from_item_id, to_item_id) values (%L, %L, %L) $$,
  tests.id('G2'), tests.id('desk'), tests.id('desk')), '23514', null, '代替の元と先は別の品目');
select throws_ok($$ insert into public.distance_overrides (building_a, building_b, cost) values ('pgtap棟C', 'pgtap棟C', 1) $$, '23514', null, '同じ建物どうしの距離は入れられない');
select throws_ok($$ insert into public.distance_overrides (building_a, building_b, cost) values ('pgtap棟C', 'pgtap棟D', -1) $$, '23514', null, '距離は 0 以上');
select throws_ok(format($$ insert into public.slots (year_id, day, starts_at, ends_at, label) values (%L, 'day1', '10:00', '09:00', 'x') $$,
  tests.id('Y1')), '23514', null, '時間枠の開始は終了より前');
select throws_ok(format($$ update public.deliveries set team = 0 where id = %L $$, tests.id('D_G1')), '23514', null, 'team は 1 以上');
select throws_ok(format($$ update public.deliveries set team = 101 where id = %L $$, tests.id('D_G1')), '23514', null, 'team は 100 まで');
select throws_ok($$ insert into public.audit_logs (table_name, row_pk, action) values ('x', '{}', 'merge') $$, '23514', null, 'audit_logs.action は insert・update・delete');

-- 部分一意 index：未使用の招待は二重にできない
select throws_ok(format($$ insert into public.invitations (year_id, email, role) values (%L, 'someone@pgtap.test', 'viewer') $$,
  tests.id('Y1')), '23505', null, '未使用のロール招待は（年度・メール）に1つ');
select lives_ok(format($$ insert into public.invitations (year_id, email, role) values (%L, 'viewer@pgtap.test', 'staff') $$,
  tests.id('Y1')), '使用済みのロール招待があっても新しい招待は作れる');
select throws_ok(format($$ insert into public.invitations (year_id, email, group_id) values (%L, 'dup@pgtap.test', %L), (%L, 'dup@pgtap.test', %L) $$,
  tests.id('Y1'), tests.id('G2'), tests.id('Y1'), tests.id('G2')), '23505', null, '未使用の団体招待は（年度・メール・団体）に1つ');

-- index
select has_index('invitations', 'invitations_email_idx');
select has_index('invitations', 'invitations_group_id_idx');
select has_index('year_roles', 'year_roles_user_id_idx');
select has_index('group_members', 'group_members_user_id_idx');
select has_index('allocations', 'allocations_year_item_room_idx');
select has_index('allocations', 'allocations_year_group_idx');
select has_index('audit_logs', 'audit_logs_year_at_idx');
select has_index('audit_logs', 'audit_logs_table_at_idx');
select has_index('audit_logs', 'audit_logs_group_at_idx');

-- ビュー：security_invoker（RLS を素通りしない）
select ok((select 'security_invoker=true' = any (reloptions) from pg_class where oid = 'public.v_remaining'::regclass),
  'v_remaining は security_invoker');

-- RLS を全表で有効にし、anon・authenticated には何の権限も与えていない（権限は T03 で表ごとに与える）
select is((select count(*)::int from pg_class c where c.relnamespace = 'public'::regnamespace and c.relkind = 'r' and not c.relrowsecurity), 0,
  'public の全表で RLS が有効');
select is((select count(*)::int from information_schema.role_table_grants
           where table_schema = 'public' and grantee in ('anon', 'authenticated', 'public')), 0,
  'anon・authenticated に表・ビューの権限がない');
select is((select count(*)::int from information_schema.role_routine_grants
           where routine_schema in ('public', 'private') and grantee in ('anon', 'authenticated', 'public')
             and routine_name not like 'pg_%'), 0,
  'anon・authenticated に public・private の関数の execute がない');
select ok(not has_schema_privilege('anon', 'private', 'usage') and not has_schema_privilege('authenticated', 'private', 'usage'),
  'private スキーマは API のロールから使えない');

-- 時刻のトリガーが audit_logs 以外の 18 表にある
select is((select count(distinct c.relname)::int from pg_trigger t join pg_class c on c.oid = t.tgrelid
           where t.tgname = 'set_timestamps' and c.relnamespace = 'public'::regnamespace and not t.tgisinternal), 18,
  'set_timestamps が 18 表にある');

-- トリガーの一覧（表ごとの名前の集合）
select is((select string_agg(c.relname, ' ' order by c.relname) from pg_trigger t join pg_class c on c.oid = t.tgrelid
           where t.tgname = 'audit' and c.relnamespace = 'public'::regnamespace),
  'allocations distance_overrides group_members groups items request_submissions requests room_years rooms rules stocks substitution_consents year_roles years',
  'audit が 14 表にある（invitations・profiles は個人情報のため記録しない）');
select is((select string_agg(c.relname, ' ' order by c.relname) from pg_trigger t join pg_class c on c.oid = t.tgrelid
           where t.tgname = 'bump_version_upd' and c.relnamespace = 'public'::regnamespace),
  'allocations distance_overrides groups items request_submissions requests room_years rooms rules stocks substitution_consents',
  '版の増分が 11 表にある');
select is((select count(*)::int from pg_trigger t where t.tgname like 'bump_version_%' and not t.tgisinternal), 33, '版の増分のトリガーは 11 表 × 3');
select is((select string_agg(distinct t.tgname, ' ' order by t.tgname) from pg_trigger t
           where t.tgrelid in ('public.allocations'::regclass, 'public.requests'::regclass, 'public.stocks'::regclass,
                               'public.groups'::regclass, 'public.room_years'::regclass, 'public.rules'::regclass,
                               'public.distance_overrides'::regclass, 'public.request_submissions'::regclass)
             and not t.tgisinternal and t.tgname not like 'bump_version_%' and t.tgname not in ('audit', 'set_timestamps')),
  'check_keep check_requestable guard_confirmed guard_rules normalize_pair set_actor set_counted',
  '検査・守りのトリガーの名前');

-- private の関数：SECURITY DEFINER はすべて search_path = ''、API のロールは実行できない
select is((select count(*)::int from pg_proc p where p.pronamespace = 'private'::regnamespace and p.prosecdef
             and not ('search_path=""' = any (coalesce(p.proconfig, '{}')))), 0,
  'private の SECURITY DEFINER の関数はすべて search_path = ""');
select is((select count(*)::int from pg_proc p where p.pronamespace = 'private'::regnamespace
             and not ('search_path=""' = any (coalesce(p.proconfig, '{}')))), 0,
  'private の関数はすべて search_path を固定している');

-- seed（T02 の分）：品目 9 件
select is((select string_agg(code, ' ' order by sort_order) from public.items where code <> 'pgtap_spare'),
  'desk desk_ng chair chair_ng caster_desk blue_chair long_desk_3 long_desk_2 lectern', 'seed の品目 9 件が並び順どおり');
select is((select requestable_categories from public.items where code = 'desk_ng'), '{}'::public.group_category[], '不可机は申請できる区分がない');
select is((select requestable_categories from public.items where code = 'long_desk_3'), '{company}'::public.group_category[], '長机(3人掛)は企業だけ');
select is((select requestable_categories from public.items where code = 'desk'), '{stall,department,company,rest_area}'::public.group_category[], '机(木)は全区分');
select ok((select count(*) >= 4 from public.rooms where name like 'テスト用%'), 'seed のテスト用の場所がある');

select * from finish();
rollback;
