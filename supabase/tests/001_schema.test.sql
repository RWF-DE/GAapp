-- 001_schema：列挙型・表・列・制約・index・ビュー・RLS・権限・seed（T02）
begin;
\ir _helpers/personas.psql
\ir _helpers/fixture.psql
select plan(206);

-- 列挙型
select enum_has_labels('public', 'year_status', array['preparing','requesting','allocating','confirmed','closed']);
select enum_has_labels('public', 'group_category', array['stall','department','company','rest_area']);
select enum_has_labels('public', 'room_kind', array['room','gym','outdoor','other']);
-- app_role：T15 で総務部門長（head）・総務副部門長（deputy_head）を admin の後に足した（0011）
select enum_has_labels('public', 'app_role', array['admin','head','deputy_head','staff','viewer']);
-- group_role：団体代表の立場（店長・副店長。T15）
select enum_has_labels('public', 'group_role', array['manager','deputy_manager']);
select enum_has_labels('public', 'rule_kind', array['substitute','source_restrict','fixed_request','keep']);
select enum_has_labels('public', 'alloc_origin', array['auto','manual']);
select enum_has_labels('public', 'consent_status', array['not_asked','asked','accepted','declined']);
select enum_has_labels('public', 'festival_day', array['day_minus2','day_minus1','day1','day2']);
select enum_has_labels('public', 'delivery_kind', array['furniture','tent','weight','side_curtain']);
select enum_has_labels('public', 'delivery_status', array['pending','done','problem']);
-- notice_audience：お知らせの宛先（総務内・全団体・指定の団体。T17）
select enum_has_labels('public', 'notice_audience', array['soumu','all_groups','groups']);

-- 表が 21 個（T17 でお知らせの notices・notice_groups を足した）、ビューが v_remaining
select tables_are('public', array['years','rooms','room_years','items','stocks','groups','year_roles','group_members',
  'invitations','request_submissions','requests','rules','substitution_consents','allocations',
  'distance_overrides','slots','deliveries','profiles','audit_logs','notices','notice_groups'], 'public の表は 21 個');
select views_are('public', array['v_remaining'], 'public のビューは v_remaining だけ');

-- 列（表ごとに列の集合が一致する）
select columns_are('public', 'years', array['id','label','festival_start','request_open_at','request_close_at','status','allocation_version','auto_allocated_at','prev_year_id','created_at','updated_at']);
select columns_are('public', 'rooms', array['id','name','aliases','kind','building','floor','is_storage','extra_cost','sort_order','created_at','updated_at']);
select columns_are('public', 'room_years', array['year_id','room_id','usable','note','created_at','updated_at']);
select columns_are('public', 'items', array['id','code','name','aliases','requestable_categories','sort_order','created_at','updated_at']);
select columns_are('public', 'stocks', array['year_id','room_id','item_id','count','counted_by','counted_at','created_at','updated_at']);
select columns_are('public', 'groups', array['id','year_id','name','display_name','aliases','category','is_food','location_room_id','sort_order','created_at','updated_at']);
select columns_are('public', 'year_roles', array['year_id','user_id','role','created_at','updated_at']);
select columns_are('public', 'group_members', array['group_id','user_id','role','created_at','updated_at']);
select columns_are('public', 'invitations', array['id','year_id','email','role','group_id','group_role','used_at','created_at','updated_at']);
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
select columns_are('public', 'notices', array['id','year_id','audience','title','body','pinned','created_by','updated_by','created_at','updated_at']);
select columns_are('public', 'notice_groups', array['notice_id','year_id','group_id','created_at','updated_at']);
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
-- 団体代表の立場（T15）：group_members.role は not null・既定は店長（今の団体代表は店長になった）。invitations.group_role は団体の招待だけ
select col_type_is('group_members', 'role', 'group_role');
select col_not_null('group_members', 'role');
select col_default_is('group_members', 'role', 'manager');
select col_type_is('invitations', 'group_role', 'group_role');
select col_is_null('invitations', 'group_role');
select col_hasnt_default('invitations', 'group_role');
-- お知らせ（T17）：宛先・題名・ピン留めは not null（ピン留めの既定は false）。本文は任意（空白だけなら RPC が null にする）。
-- 書いた人・直した人は null 可・既定なし（トリガー set_actor が入れる。アカウントが消えると set null）。宛先の団体の列はどれも not null
select col_type_is('notices', 'audience', 'notice_audience');
select col_not_null('notices', 'audience');
select col_hasnt_default('notices', 'audience');
select col_type_is('notices', 'title', 'text');
select col_not_null('notices', 'title');
select col_type_is('notices', 'body', 'text');
select col_is_null('notices', 'body');
select col_type_is('notices', 'pinned', 'boolean');
select col_not_null('notices', 'pinned');
select col_default_is('notices', 'pinned', 'false');
select ok((select bool_and(data_type = 'uuid' and is_nullable = 'YES' and column_default is null)
           from information_schema.columns
           where table_schema = 'public' and table_name = 'notices' and column_name in ('created_by', 'updated_by'))
          and (select count(*) = 2 from information_schema.columns
               where table_schema = 'public' and table_name = 'notices' and column_name in ('created_by', 'updated_by')),
  'notices.created_by・updated_by は uuid・null 可・既定なし');
select ok((select bool_and(is_nullable = 'NO' and data_type = 'uuid') from information_schema.columns
           where table_schema = 'public' and table_name = 'notice_groups' and column_name in ('notice_id', 'year_id', 'group_id')),
  'notice_groups の notice_id・year_id・group_id は uuid・not null');
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
select col_is_pk('notices', 'id');
select col_is_pk('notice_groups', array['notice_id','group_id']);

-- 一意制約
select col_is_unique('years', 'label');
select col_is_unique('rooms', 'name');
select col_is_unique('items', 'code');
select col_is_unique('groups', array['year_id','name']);
select col_is_unique('groups', array['id','year_id']);
select col_is_unique('slots', array['id','year_id']);
select col_is_unique('deliveries', array['group_id','kind']);
select col_is_unique('rules', array['year_id','code']);
-- notices の (id, year_id) は notice_groups の複合外部キーの参照先（T17。groups・slots と同じ）
select col_is_unique('notices', array['id','year_id']);
select is((select pg_get_constraintdef(oid) from pg_constraint where conname = 'notices_id_year_id_key'), 'UNIQUE (id, year_id)',
  'notices_id_year_id_key は unique (id, year_id)');

-- 外部キー（年度の一致は複合外部キー）
select fk_ok('public', 'allocations', array['group_id','year_id'], 'public', 'groups', array['id','year_id']);
select fk_ok('public', 'deliveries', array['group_id','year_id'], 'public', 'groups', array['id','year_id']);
select fk_ok('public', 'deliveries', array['slot_id','year_id'], 'public', 'slots', array['id','year_id']);
select fk_ok('public', 'invitations', array['group_id','year_id'], 'public', 'groups', array['id','year_id']);
select fk_ok('public', 'years', 'prev_year_id', 'public', 'years', 'id');
select fk_ok('public', 'stocks', 'counted_by', 'auth', 'users', 'id');
-- お知らせ（T17）：宛先の団体は、お知らせとも団体とも年度ごと結ぶ（お知らせと団体が同じ年度）
select fk_ok('public', 'notices', 'year_id', 'public', 'years', 'id');
select fk_ok('public', 'notices', 'created_by', 'auth', 'users', 'id');
select fk_ok('public', 'notices', 'updated_by', 'auth', 'users', 'id');
select fk_ok('public', 'notice_groups', array['notice_id','year_id'], 'public', 'notices', array['id','year_id']);
select fk_ok('public', 'notice_groups', array['group_id','year_id'], 'public', 'groups', array['id','year_id']);
select is((select string_agg(conname || ': ' || pg_get_constraintdef(oid), ' / ' order by conname collate "C") from pg_constraint
           where conrelid = 'public.notice_groups'::regclass and contype = 'f'),
  'notice_groups_group_fkey: FOREIGN KEY (group_id, year_id) REFERENCES groups(id, year_id) ON DELETE CASCADE / '
  || 'notice_groups_notice_fkey: FOREIGN KEY (notice_id, year_id) REFERENCES notices(id, year_id) ON DELETE CASCADE',
  'notice_groups の外部キーは2本とも名前つきの複合外部キーで cascade（お知らせを消す・団体を消すと行も消える）');

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
  'deliveries.checked_by deliveries.year_id,slot_id notices.created_by notices.updated_by request_submissions.updated_by stocks.counted_by years.prev_year_id',
  '記録のためのユーザー参照（お知らせの書いた人・直した人を含む）・時間枠・複製元は set null');
-- T17 で3本足した：notices.year_id と、notice_groups の2本の複合外部キー
select is((select count(*)::int from pg_constraint c
           where c.contype = 'f' and c.connamespace = 'public'::regnamespace and c.confdeltype = 'c'), 22,
  '年度・団体・ユーザー・お知らせへの参照は cascade（22 本）');
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
select throws_ok($$ insert into public.rooms (name, extra_cost) values ('pgtap-x', 21) $$, '23514', null, 'rooms.extra_cost は 20 まで（T03）');
select lives_ok($$ insert into public.rooms (name, extra_cost) values ('pgtap-x20', 20) $$, 'rooms.extra_cost の 20 は入る');
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
-- 招待の立場（T15。invitations_group_role_check）：団体の招待だけが group_role を持つ
select is((select pg_get_constraintdef(oid) from pg_constraint where conname = 'invitations_group_role_check'),
  'CHECK (((group_id IS NULL) = (group_role IS NULL)))', 'invitations_group_role_check は「団体の招待のときだけ立場がある」');
select throws_ok(format($$ insert into public.invitations (year_id, email, group_id) values (%L, 'nogr@pgtap.test', %L) $$,
  tests.id('Y1'), tests.id('G1')), '23514', null, '団体の招待には立場（group_role）が要る');
select throws_ok(format($$ insert into public.invitations (year_id, email, role, group_role) values (%L, 'grrole@pgtap.test', 'viewer', 'manager') $$,
  tests.id('Y1')), '23514', null, 'ロールの招待は立場を持てない');
select lives_ok(format($$ insert into public.invitations (year_id, email, group_id, group_role) values (%L, 'grdep@pgtap.test', %L, 'deputy_manager') $$,
  tests.id('Y1'), tests.id('G1')), '団体の招待は副店長でも作れる');
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
select throws_ok($$ insert into public.distance_overrides (building_a, building_b, cost) values ('pgtap棟C', 'pgtap棟D', 21) $$, '23514', null, '距離は 20 まで（T03）');
select lives_ok($$ insert into public.distance_overrides (building_a, building_b, cost) values ('pgtap棟C', 'pgtap棟D', 20) $$, '距離の 20 は入る');
select throws_ok(format($$ insert into public.slots (year_id, day, starts_at, ends_at, label) values (%L, 'day1', '10:00', '09:00', 'x') $$,
  tests.id('Y1')), '23514', null, '時間枠の開始は終了より前');
select throws_ok(format($$ update public.deliveries set team = 0 where id = %L $$, tests.id('D_G1')), '23514', null, 'team は 1 以上');
select throws_ok(format($$ update public.deliveries set team = 101 where id = %L $$, tests.id('D_G1')), '23514', null, 'team は 100 まで');
select throws_ok($$ insert into public.audit_logs (table_name, row_pk, action) values ('x', '{}', 'merge') $$, '23514', null, 'audit_logs.action は insert・update・delete');
-- お知らせ（T17）：題名は前後の空白（半角の空白・タブ・改行・全角の空白）を除いた形で 1〜100 字（RPC が除いてから入れ、CHECK は
-- 除いた形であることを確かめる。SQL Editor から前後に空白のある題名を入れさせない）。本文は 4000 字まで（null 可）
select throws_ok(format($$ insert into public.notices (year_id, audience, title) values (%L, 'soumu', '') $$, tests.id('Y1')),
  '23514', null, 'notices.title が空');
select throws_ok(format($$ insert into public.notices (year_id, audience, title) values (%L, 'soumu', E' \t\u3000') $$, tests.id('Y1')),
  '23514', null, '題名が空白だけ（タブ・全角の空白を含む）');
select throws_ok(format($$ insert into public.notices (year_id, audience, title) values (%L, 'soumu', ' 題名') $$, tests.id('Y1')),
  '23514', null, '題名の前に半角の空白');
select throws_ok(format($$ insert into public.notices (year_id, audience, title) values (%L, 'soumu', E'題名\u3000') $$, tests.id('Y1')),
  '23514', null, '題名の後ろに全角の空白');
select throws_ok(format($$ insert into public.notices (year_id, audience, title) values (%L, 'soumu', E'\t題名') $$, tests.id('Y1')),
  '23514', null, '題名の前にタブ');
select throws_ok(format($$ insert into public.notices (year_id, audience, title) values (%L, 'soumu', E'題名\n') $$, tests.id('Y1')),
  '23514', null, '題名の後ろに改行（LF）');
select throws_ok(format($$ insert into public.notices (year_id, audience, title) values (%L, 'soumu', E'題名\r') $$, tests.id('Y1')),
  '23514', null, '題名の後ろに改行（CR）');
select throws_ok(format($$ insert into public.notices (year_id, audience, title) values (%L, 'soumu', repeat('あ', 101)) $$, tests.id('Y1')),
  '23514', null, '題名は 100 字まで');
select lives_ok(format($$ insert into public.notices (year_id, audience, title) values (%L, 'soumu', repeat('あ', 100)) $$, tests.id('Y1')),
  '100 字の題名は入る');
select lives_ok(format($$ insert into public.notices (year_id, audience, title) values (%L, 'soumu', E'題 名\u3000の中') $$, tests.id('Y1')),
  '題名の中の空白はそのまま入る');
select throws_ok(format($$ insert into public.notices (year_id, audience, title, body) values (%L, 'soumu', '本文', repeat('あ', 4001)) $$, tests.id('Y1')),
  '23514', null, 'notices.body は 4000 字まで');
select lives_ok(format($$ insert into public.notices (year_id, audience, title, body) values (%L, 'soumu', '本文', repeat('あ', 4000)) $$, tests.id('Y1')),
  '4000 字の本文は入る');
select lives_ok(format($$ insert into public.notices (year_id, audience, title, body) values (%L, 'soumu', '本文なし', null) $$, tests.id('Y1')),
  '本文は null でよい');
select is((select pg_get_constraintdef(oid) from pg_constraint where conname = 'notices_body_check'), 'CHECK ((length(body) <= 4000))',
  'notices_body_check は 4000 字まで');

-- 部分一意 index：未使用の招待は二重にできない
select throws_ok(format($$ insert into public.invitations (year_id, email, role) values (%L, 'someone@pgtap.test', 'viewer') $$,
  tests.id('Y1')), '23505', null, '未使用のロール招待は（年度・メール）に1つ');
select lives_ok(format($$ insert into public.invitations (year_id, email, role) values (%L, 'viewer@pgtap.test', 'staff') $$,
  tests.id('Y1')), '使用済みのロール招待があっても新しい招待は作れる');
select throws_ok(format($$ insert into public.invitations (year_id, email, group_id, group_role) values (%L, 'dup@pgtap.test', %L, 'manager'), (%L, 'dup@pgtap.test', %L, 'deputy_manager') $$,
  tests.id('Y1'), tests.id('G2'), tests.id('Y1'), tests.id('G2')), '23505', null, '未使用の団体招待は（年度・メール・団体）に1つ（立場が違っても。招待し直すと立場が変わる）');

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
-- お知らせ（T17）：年度ごとの一覧（新しい順）とポリシーの year_id in (…) 用。宛先の団体は団体からの引き（集合の関数・団体の連鎖削除）用
select is((select pg_get_indexdef('public.notices_year_id_idx'::regclass)),
  'CREATE INDEX notices_year_id_idx ON public.notices USING btree (year_id, created_at DESC)', 'notices_year_id_idx は (year_id, created_at desc)');
select is((select pg_get_indexdef('public.notice_groups_group_id_idx'::regclass)),
  'CREATE INDEX notice_groups_group_id_idx ON public.notice_groups USING btree (group_id)', 'notice_groups_group_id_idx は (group_id)');

-- ビュー：security_invoker（RLS を素通りしない）
select ok((select 'security_invoker=true' = any (reloptions) from pg_class where oid = 'public.v_remaining'::regclass),
  'v_remaining は security_invoker');

-- RLS を全表で有効にし、anon・PUBLIC には何の権限も与えていない（authenticated の権限は T03 の 010_grants で集合として確かめる）
select is((select count(*)::int from pg_class c where c.relnamespace = 'public'::regnamespace and c.relkind = 'r' and not c.relrowsecurity), 0,
  'public の全表で RLS が有効');
-- 権限の棚卸し：public・private スキーマの全オブジェクトを、anon・public（PUBLIC への付与。関数の既定の execute）に当てる。
-- authenticated は T03 で表・RPC・判定関数ごとに与えるので、010_grants.test.sql で一覧と比べる。
-- information_schema の grantee は小文字の public と比べても PUBLIC を拾えないので、has_*_privilege で実効の権限を見る。
-- 拡張が持つオブジェクト（pg_depend の deptype = 'e'）は対象外。失敗したときは対象の一覧が差分に出る。
create temporary view pg_temp.priv_roles as select r from unnest(array['anon', 'public']) as r;
select is((select coalesce(string_agg(format('%s %s %s', c.oid::regclass, r.r, p.p), ', ' order by c.oid::regclass::text, r.r, p.p), '')
           from pg_class c
           cross join pg_temp.priv_roles r
           cross join unnest(array['select', 'insert', 'update', 'delete', 'truncate', 'references', 'trigger']) as p(p)
           where c.relnamespace in ('public'::regnamespace, 'private'::regnamespace) and c.relkind in ('r', 'v', 'm', 'f', 'p')
             and (has_table_privilege(r.r, c.oid, p.p)
                  or (p.p in ('select', 'insert', 'update', 'references') and has_any_column_privilege(r.r, c.oid, p.p)))), '',
  'anon・public に public・private の表・ビューの権限がない');
select is((select coalesce(string_agg(format('%s %s %s', c.oid::regclass, r.r, p.p), ', ' order by c.oid::regclass::text, r.r, p.p), '')
           from pg_class c
           cross join pg_temp.priv_roles r
           cross join unnest(array['usage', 'select', 'update']) as p(p)
           where c.relnamespace in ('public'::regnamespace, 'private'::regnamespace) and c.relkind = 'S'
             and has_sequence_privilege(r.r, c.oid, p.p)), '',
  'anon・public に public・private のシーケンスの権限がない（audit_logs_id_seq など）');
select is((select coalesce(string_agg(format('%s %s', p.oid::regprocedure, r.r), ', ' order by p.oid::regprocedure::text, r.r), '')
           from pg_proc p
           cross join pg_temp.priv_roles r
           where p.pronamespace in ('public'::regnamespace, 'private'::regnamespace)
             and not exists (select 1 from pg_depend d where d.classid = 'pg_proc'::regclass and d.objid = p.oid and d.deptype = 'e')
             and has_function_privilege(r.r, p.oid, 'execute')), '',
  'anon・public に public・private の関数の execute がない（PUBLIC の既定の execute を含む）');
select ok((select count(*) filter (where relkind in ('r', 'v')) >= 20 and count(*) filter (where relkind = 'S') >= 1
           from pg_class where relnamespace = 'public'::regnamespace)
          and exists (select 1 from pg_proc where pronamespace = 'private'::regnamespace),
  '棚卸しの対象が空でない（表・ビュー・シーケンス・private の関数）');
select ok(not has_schema_privilege('anon', 'private', 'usage') and not has_schema_privilege('public', 'private', 'usage')
          and not has_schema_privilege('anon', 'private', 'create') and not has_schema_privilege('authenticated', 'private', 'create'),
  'private スキーマは anon・PUBLIC から使えず、だれも create できない（authenticated の usage は T03 の 010）');

-- 年度・団体の付け替えを止めるトリガーが 14 表にある（T17 で notices の year_id と notice_groups の鍵の列を足した）
select is((select string_agg(c.relname, ' ' order by c.relname) from pg_trigger t join pg_class c on c.oid = t.tgrelid
           where t.tgname = 'check_immutable' and c.relnamespace = 'public'::regnamespace),
  'allocations deliveries group_members groups invitations notice_groups notices request_submissions requests room_years slots stocks substitution_consents year_roles',
  'check_immutable が 14 表にある');
select is((select string_agg(c.relname || ': ' || pg_get_triggerdef(t.oid), ' / ' order by c.relname) from pg_trigger t join pg_class c on c.oid = t.tgrelid
           where t.tgname = 'check_immutable' and c.relname in ('notices', 'notice_groups') and c.relnamespace = 'public'::regnamespace),
  'notice_groups: CREATE TRIGGER check_immutable BEFORE UPDATE OF notice_id, year_id, group_id ON public.notice_groups FOR EACH ROW EXECUTE FUNCTION private.tg_immutable_columns(''notice_id'', ''year_id'', ''group_id'') / '
  || 'notices: CREATE TRIGGER check_immutable BEFORE UPDATE OF year_id ON public.notices FOR EACH ROW EXECUTE FUNCTION private.tg_immutable_columns(''year_id'')',
  'notices は year_id、notice_groups は鍵の列（notice_id・year_id・group_id）を全部変えられない');

-- お知らせ（T17）のトリガー：版の増分（bump_version_*）と確定中・終了の守りはない（振り分けの入力でない。終了の年度の読み取り専用は RPC）。
-- 宛先の団体の行は宛先が groups のお知らせにだけ置ける（notice_groups の insert の check_audience と、notices の audience の更新の
-- check_groups）。書いた人・直した人は set_actor。BEFORE ROW のトリガーは名前の順に動く
select is((select string_agg(t.tgname, ' ' order by t.tgname) from pg_trigger t
           where t.tgrelid = 'public.notices'::regclass and not t.tgisinternal),
  'audit check_groups check_immutable set_actor set_timestamps', 'notices のトリガーは5つ（版の増分・確定中の守りはない）');
select is((select string_agg(t.tgname, ' ' order by t.tgname) from pg_trigger t
           where t.tgrelid = 'public.notice_groups'::regclass and not t.tgisinternal),
  'audit check_audience check_immutable set_timestamps', 'notice_groups のトリガーは4つ');
select is((select string_agg(t.tgname, ' ' order by t.tgname) from pg_trigger t
           where t.tgrelid = 'public.notices'::regclass and not t.tgisinternal and (t.tgtype & 3) = 3),
  'check_groups check_immutable set_actor set_timestamps', 'notices の BEFORE ROW のトリガーの順');
select is((select pg_get_triggerdef(t.oid) from pg_trigger t where t.tgname = 'check_groups' and t.tgrelid = 'public.notices'::regclass),
  'CREATE TRIGGER check_groups BEFORE UPDATE OF audience ON public.notices FOR EACH ROW EXECUTE FUNCTION private.tg_notices_check_groups()',
  'notices の check_groups：BEFORE UPDATE OF audience・行ごと');
select is((select pg_get_triggerdef(t.oid) from pg_trigger t where t.tgname = 'set_actor' and t.tgrelid = 'public.notices'::regclass),
  'CREATE TRIGGER set_actor BEFORE INSERT OR UPDATE ON public.notices FOR EACH ROW EXECUTE FUNCTION private.tg_notices_set_actor()',
  'notices の set_actor：BEFORE INSERT OR UPDATE・行ごと');
select is((select pg_get_triggerdef(t.oid) from pg_trigger t where t.tgname = 'check_audience' and t.tgrelid = 'public.notice_groups'::regclass),
  'CREATE TRIGGER check_audience BEFORE INSERT ON public.notice_groups FOR EACH ROW EXECUTE FUNCTION private.tg_notice_groups_check_audience()',
  'notice_groups の check_audience：BEFORE INSERT・行ごと');
select is((select string_agg(c.relname || '=' || pg_get_triggerdef(t.oid), ' / ' order by c.relname) from pg_trigger t join pg_class c on c.oid = t.tgrelid
           where t.tgname = 'audit' and c.relname in ('notices', 'notice_groups') and c.relnamespace = 'public'::regnamespace),
  'notice_groups=CREATE TRIGGER audit AFTER INSERT OR DELETE OR UPDATE ON public.notice_groups FOR EACH ROW EXECUTE FUNCTION private.tg_audit(''notice_id,group_id'') / '
  || 'notices=CREATE TRIGGER audit AFTER INSERT OR DELETE OR UPDATE ON public.notices FOR EACH ROW EXECUTE FUNCTION private.tg_audit(''id'')',
  '監査の row_pk はお知らせの id と、宛先の団体の (notice_id, group_id)');
-- トリガー関数：set_actor は INVOKER（auth.uid() を読むだけ）、宛先の団体の決まりの2つは DEFINER（RLS を通らずにもう一方の表を読む）
select is((select string_agg(p.proname || '=' || case when p.prosecdef then 'definer' else 'invoker' end, ' ' order by p.proname)
           from pg_proc p where p.pronamespace = 'private'::regnamespace
             and p.proname in ('tg_notices_set_actor', 'tg_notice_groups_check_audience', 'tg_notices_check_groups')),
  'tg_notice_groups_check_audience=definer tg_notices_check_groups=definer tg_notices_set_actor=invoker',
  'お知らせのトリガー関数の SECURITY');

-- 兼任の禁止（T15。0013）：check_role_overlap が year_roles・group_members にだけあり、BEFORE・ROW・列が約束どおり。
-- 店長⇄副店長（group_members の role だけの更新）では動かない（列に role がない）
select is((select string_agg(c.relname, ' ' order by c.relname) from pg_trigger t join pg_class c on c.oid = t.tgrelid
           where t.tgname = 'check_role_overlap' and not t.tgisinternal),
  'group_members year_roles', 'check_role_overlap は year_roles と group_members にある');
select is((select pg_get_triggerdef(t.oid) from pg_trigger t where t.tgname = 'check_role_overlap' and t.tgrelid = 'public.year_roles'::regclass),
  'CREATE TRIGGER check_role_overlap BEFORE INSERT OR UPDATE OF role, user_id ON public.year_roles FOR EACH ROW EXECUTE FUNCTION private.tg_year_roles_check_overlap()',
  'year_roles の check_role_overlap：BEFORE INSERT OR UPDATE OF role, user_id・行ごと');
select is((select pg_get_triggerdef(t.oid) from pg_trigger t where t.tgname = 'check_role_overlap' and t.tgrelid = 'public.group_members'::regclass),
  'CREATE TRIGGER check_role_overlap BEFORE INSERT OR UPDATE OF user_id, group_id ON public.group_members FOR EACH ROW EXECUTE FUNCTION private.tg_group_members_check_overlap()',
  'group_members の check_role_overlap：BEFORE INSERT OR UPDATE OF user_id, group_id・行ごと（role の更新では動かない）');
-- BEFORE ROW のトリガーは名前の順に動く：check_immutable（年度・団体の付け替えを invalid_input で止める）→ check_role_overlap → set_timestamps
select is((select string_agg(t.tgname, ' ' order by t.tgname) from pg_trigger t
           where t.tgrelid = 'public.year_roles'::regclass and not t.tgisinternal and (t.tgtype & 3) = 3),
  'check_immutable check_role_overlap set_timestamps', 'year_roles の BEFORE ROW のトリガーの順');
select is((select string_agg(t.tgname, ' ' order by t.tgname) from pg_trigger t
           where t.tgrelid = 'public.group_members'::regclass and not t.tgisinternal and (t.tgtype & 3) = 3),
  'check_immutable check_role_overlap set_timestamps', 'group_members の BEFORE ROW のトリガーの順');

-- 時刻のトリガーが audit_logs 以外の 20 表にある（T17 で notices・notice_groups を足した）
select is((select count(distinct c.relname)::int from pg_trigger t join pg_class c on c.oid = t.tgrelid
           where t.tgname = 'set_timestamps' and c.relnamespace = 'public'::regnamespace and not t.tgisinternal), 20,
  'set_timestamps が 20 表にある');

-- トリガーの一覧（表ごとの名前の集合）
select is((select string_agg(c.relname, ' ' order by c.relname) from pg_trigger t join pg_class c on c.oid = t.tgrelid
           where t.tgname = 'audit' and c.relnamespace = 'public'::regnamespace),
  'allocations distance_overrides group_members groups items notice_groups notices request_submissions requests room_years rooms rules stocks substitution_consents year_roles years',
  'audit が 16 表にある（invitations・profiles は個人情報のため記録しない。T17 でお知らせの2表を足した）');
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
  'check_immutable check_keep check_requestable guard_confirmed guard_rules normalize_pair set_actor set_counted',
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
