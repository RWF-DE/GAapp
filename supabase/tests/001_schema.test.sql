-- 001_schema：列挙型・表・列・制約・index・ビュー・RLS・権限・seed（T02）
begin;
\ir _helpers/personas.psql
\ir _helpers/fixture.psql
select plan(355);

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
-- event_kind・event_audience：予定と締切の種類（締切・予定）と対象（総務・団体・全員。T18）
select enum_has_labels('public', 'event_kind', array['deadline','event']);
select enum_has_labels('public', 'event_audience', array['soumu','groups','all']);

-- 表が 27 個（T17 でお知らせの notices・notice_groups を、T18 で予定と締切の events を、T21 でテント等の貸し出しの5表を足した）、
-- ビューが v_remaining
select tables_are('public', array['years','rooms','room_years','items','stocks','groups','year_roles','group_members',
  'invitations','request_submissions','requests','rules','substitution_consents','allocations',
  'distance_overrides','slots','deliveries','profiles','audit_logs','notices','notice_groups','events',
  'lending_items','lending_requests','lending_assignments','lending_records','lending_years'], 'public の表は 27 個');
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
select columns_are('public', 'events', array['id','year_id','kind','audience','title','starts_at','ends_at','all_day','note','created_by','updated_by','created_at','updated_at']);
-- テント等の貸し出し（T21）：備品・申請・割り当て・記録・割り当ての確定の印
select columns_are('public', 'lending_items', array['id','year_id','name','unit','stock','requestable_categories','sort_order','created_at','updated_at']);
select columns_are('public', 'lending_requests', array['group_id','lending_item_id','year_id','count','updated_by','created_at','updated_at']);
select columns_are('public', 'lending_assignments', array['group_id','lending_item_id','year_id','count','updated_by','created_at','updated_at']);
select columns_are('public', 'lending_records', array['group_id','lending_item_id','year_id','lent_count','returned_count','damaged_count','note','updated_by','created_at','updated_at']);
select columns_are('public', 'lending_years', array['year_id','confirmed_at','confirmed_by','created_at','updated_at']);
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
-- 予定と締切（T18）：種類・対象・題名・開始・終日は not null（終日の既定は false）。種類・対象・開始には既定値がない（画面が決めて送る）。
-- 終わり・メモは任意。書いた人・直した人は null 可・既定なし（トリガー set_actor が入れる。アカウントが消えると set null）
select col_type_is('events', 'kind', 'event_kind');
select col_type_is('events', 'audience', 'event_audience');
select col_type_is('events', 'title', 'text');
select col_type_is('events', 'starts_at', 'timestamp with time zone');
select col_type_is('events', 'ends_at', 'timestamp with time zone');
select col_type_is('events', 'all_day', 'boolean');
select col_type_is('events', 'note', 'text');
select ok((select bool_and(is_nullable = 'NO') from information_schema.columns
           where table_schema = 'public' and table_name = 'events' and column_name in ('year_id', 'kind', 'audience', 'title', 'starts_at', 'all_day')),
  'events の year_id・kind・audience・title・starts_at・all_day は not null');
select ok((select bool_and(column_default is null) from information_schema.columns
           where table_schema = 'public' and table_name = 'events' and column_name in ('year_id', 'kind', 'audience', 'title', 'starts_at', 'ends_at', 'note')),
  'events の year_id・kind・audience・title・starts_at・ends_at・note には既定値がない');
select col_default_is('events', 'all_day', 'false');
select col_is_null('events', 'ends_at');
select col_is_null('events', 'note');
select ok((select bool_and(data_type = 'uuid' and is_nullable = 'YES' and column_default is null)
           from information_schema.columns
           where table_schema = 'public' and table_name = 'events' and column_name in ('created_by', 'updated_by'))
          and (select count(*) = 2 from information_schema.columns
               where table_schema = 'public' and table_name = 'events' and column_name in ('created_by', 'updated_by')),
  'events.created_by・updated_by は uuid・null 可・既定なし');
-- テント等の貸し出し（T21）：null を許すのは書いた人（updated_by）・記録のメモ・確定した日時と人だけ。単位の既定は「個」、申請できる区分の
-- 既定は模擬店・部門、並びと記録の数の既定は 0。名前・在庫・申請と割り当ての数・年度・団体・備品には既定値がない（画面と RPC が決めて送る）
select is((select string_agg(table_name || '.' || column_name, ' ' order by table_name, column_name) from information_schema.columns
           where table_schema = 'public' and table_name like 'lending\_%' and is_nullable = 'YES'),
  'lending_assignments.updated_by lending_records.note lending_records.updated_by lending_requests.updated_by lending_years.confirmed_at lending_years.confirmed_by',
  'テント等の5表で null を許す列は updated_by・note・confirmed_at・confirmed_by だけ');
select col_type_is('lending_items', 'name', 'text');
select col_type_is('lending_items', 'unit', 'text');
select col_type_is('lending_items', 'stock', 'integer');
select col_type_is('lending_items', 'requestable_categories', 'group_category[]');
select col_type_is('lending_items', 'sort_order', 'integer');
select col_default_is('lending_items', 'unit', '個');
select is((select column_default from information_schema.columns
           where table_schema = 'public' and table_name = 'lending_items' and column_name = 'requestable_categories'),
  '''{stall,department}''::group_category[]', 'lending_items.requestable_categories の既定は模擬店・部門');
select col_default_is('lending_items', 'sort_order', '0');
select col_type_is('lending_records', 'lent_count', 'integer');
select col_type_is('lending_records', 'note', 'text');
select is((select string_agg(column_name || '=' || column_default, ' ' order by column_name) from information_schema.columns
           where table_schema = 'public' and table_name = 'lending_records' and column_name like '%\_count'),
  'damaged_count=0 lent_count=0 returned_count=0', '記録の渡した数・返った数・破損の数の既定は 0');
select ok((select bool_and(data_type = 'integer') from information_schema.columns
           where table_schema = 'public' and table_name in ('lending_requests', 'lending_assignments') and column_name = 'count'),
  '申請と割り当ての数は integer');
select is((select coalesce(string_agg(table_name || '.' || column_name, ' ' order by table_name, column_name), '') from information_schema.columns
           where table_schema = 'public' and table_name like 'lending\_%' and column_default is not null
             and column_name not in ('created_at', 'updated_at')),
  'lending_items.id lending_items.requestable_categories lending_items.sort_order lending_items.unit lending_records.damaged_count lending_records.lent_count lending_records.returned_count',
  'テント等の5表で既定値があるのは、備品の id・申請できる区分・並び・単位と記録の3つの数だけ（年度・団体・備品・名前・在庫・数には既定値がない）');
select ok((select bool_and(data_type = 'uuid') and count(*) = 4 from information_schema.columns
           where table_schema = 'public' and table_name like 'lending\_%' and column_name in ('updated_by', 'confirmed_by')),
  'テント等の書いた人（updated_by 3つ）と確定した人（confirmed_by）は uuid');
select col_type_is('lending_years', 'confirmed_at', 'timestamp with time zone');
select ok((select bool_and(data_type = 'uuid') and count(*) = 12 from information_schema.columns
           where table_schema = 'public' and table_name like 'lending\_%' and column_name in ('id', 'year_id', 'group_id', 'lending_item_id')),
  'テント等の5表の id・year_id・group_id・lending_item_id（12 列）は uuid');
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
select col_is_pk('events', 'id');
-- テント等の貸し出し（T21）：申請・割り当て・記録は団体×備品で1行、確定の印は年度に1行
select col_is_pk('lending_items', 'id');
select col_is_pk('lending_requests', array['group_id','lending_item_id']);
select col_is_pk('lending_assignments', array['group_id','lending_item_id']);
select col_is_pk('lending_records', array['group_id','lending_item_id']);
select col_is_pk('lending_years', 'year_id');

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
-- テント等の備品（T21）：名前は年度の中で1つ（「テント」と「テント 」は名前の CHECK が分ける）。(id, year_id) は申請・割り当て・記録の
-- 複合外部キーの参照先（備品が行と同じ年度であることを保証する）
select col_is_unique('lending_items', array['year_id','name']);
select col_is_unique('lending_items', array['id','year_id']);
select is((select string_agg(conname || ': ' || pg_get_constraintdef(oid), ' / ' order by conname collate "C") from pg_constraint
           where conrelid = 'public.lending_items'::regclass and contype = 'u'),
  'lending_items_id_year_id_key: UNIQUE (id, year_id) / lending_items_year_id_name_key: UNIQUE (year_id, name)',
  'lending_items の一意制約は (id, year_id) と (year_id, name) の2つ');

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
-- 予定と締切（T18）：年度へは cascade、書いた人・直した人へは set null（団体への参照はない）
select fk_ok('public', 'events', 'year_id', 'public', 'years', 'id');
select fk_ok('public', 'events', 'created_by', 'auth', 'users', 'id');
select fk_ok('public', 'events', 'updated_by', 'auth', 'users', 'id');
-- テント等の貸し出し（T21）：申請・割り当て・記録は団体と備品に年度ごと結ぶ（団体と備品が行と同じ年度）。団体へは cascade、備品へは
-- restrict（申請・割り当て・記録のある備品は消せない）。子の3表は年度へも直接 cascade（年度を消したときに、連鎖の順によらず備品の
-- restrict に止められない。notes/T21.md の判断したことの 1）。書いた人・確定した人へは set null
select fk_ok('public', 'lending_items', 'year_id', 'public', 'years', 'id');
select fk_ok('public', 'lending_requests', array['group_id','year_id'], 'public', 'groups', array['id','year_id']);
select fk_ok('public', 'lending_requests', array['lending_item_id','year_id'], 'public', 'lending_items', array['id','year_id']);
select fk_ok('public', 'lending_assignments', array['group_id','year_id'], 'public', 'groups', array['id','year_id']);
select fk_ok('public', 'lending_assignments', array['lending_item_id','year_id'], 'public', 'lending_items', array['id','year_id']);
select fk_ok('public', 'lending_records', array['group_id','year_id'], 'public', 'groups', array['id','year_id']);
select fk_ok('public', 'lending_records', array['lending_item_id','year_id'], 'public', 'lending_items', array['id','year_id']);
select fk_ok('public', 'lending_years', 'year_id', 'public', 'years', 'id');
select fk_ok('public', 'lending_years', 'confirmed_by', 'auth', 'users', 'id');
select is((select string_agg(conname || '=' || confdeltype::text || ': ' || pg_get_constraintdef(oid), ' / ' order by conname collate "C")
           from pg_constraint where contype = 'f' and conrelid::regclass::text like 'lending\_%'),
  'lending_assignments_group_fkey=c: FOREIGN KEY (group_id, year_id) REFERENCES groups(id, year_id) ON DELETE CASCADE / '
  || 'lending_assignments_item_fkey=r: FOREIGN KEY (lending_item_id, year_id) REFERENCES lending_items(id, year_id) ON DELETE RESTRICT / '
  || 'lending_assignments_updated_by_fkey=n: FOREIGN KEY (updated_by) REFERENCES auth.users(id) ON DELETE SET NULL / '
  || 'lending_assignments_year_id_fkey=c: FOREIGN KEY (year_id) REFERENCES years(id) ON DELETE CASCADE / '
  || 'lending_items_year_id_fkey=c: FOREIGN KEY (year_id) REFERENCES years(id) ON DELETE CASCADE / '
  || 'lending_records_group_fkey=c: FOREIGN KEY (group_id, year_id) REFERENCES groups(id, year_id) ON DELETE CASCADE / '
  || 'lending_records_item_fkey=r: FOREIGN KEY (lending_item_id, year_id) REFERENCES lending_items(id, year_id) ON DELETE RESTRICT / '
  || 'lending_records_updated_by_fkey=n: FOREIGN KEY (updated_by) REFERENCES auth.users(id) ON DELETE SET NULL / '
  || 'lending_records_year_id_fkey=c: FOREIGN KEY (year_id) REFERENCES years(id) ON DELETE CASCADE / '
  || 'lending_requests_group_fkey=c: FOREIGN KEY (group_id, year_id) REFERENCES groups(id, year_id) ON DELETE CASCADE / '
  || 'lending_requests_item_fkey=r: FOREIGN KEY (lending_item_id, year_id) REFERENCES lending_items(id, year_id) ON DELETE RESTRICT / '
  || 'lending_requests_updated_by_fkey=n: FOREIGN KEY (updated_by) REFERENCES auth.users(id) ON DELETE SET NULL / '
  || 'lending_requests_year_id_fkey=c: FOREIGN KEY (year_id) REFERENCES years(id) ON DELETE CASCADE / '
  || 'lending_years_confirmed_by_fkey=n: FOREIGN KEY (confirmed_by) REFERENCES auth.users(id) ON DELETE SET NULL / '
  || 'lending_years_year_id_fkey=c: FOREIGN KEY (year_id) REFERENCES years(id) ON DELETE CASCADE',
  'テント等の5表の外部キーは 15 本（名前・列・参照先・on delete：年度と団体へ cascade、備品へ restrict、人へ set null）');

-- on delete の動作（c＝cascade、r＝restrict、n＝set null）
with fk as (
  select conrelid::regclass::text as tbl, confrelid::regclass::text as ref, confdeltype as del,
         (select string_agg(a.attname, ',' order by a.attnum) from pg_attribute a
           where a.attrelid = c.conrelid and a.attnum = any (c.conkey)) as cols
  from pg_constraint c where c.contype = 'f' and c.connamespace = 'public'::regnamespace)
select is((select string_agg(tbl || '.' || cols, ' ' order by tbl, cols) from fk where del = 'r'),
  'allocations.item_id allocations.requested_item_id allocations.source_room_id groups.location_room_id lending_assignments.lending_item_id,year_id lending_records.lending_item_id,year_id lending_requests.lending_item_id,year_id requests.item_id room_years.room_id stocks.item_id stocks.room_id substitution_consents.from_item_id substitution_consents.to_item_id',
  '場所・品目（T21 のテント等の備品を含む）への外部キーは restrict');
with fk as (
  select conrelid::regclass::text as tbl, confdeltype as del,
         (select string_agg(a.attname, ',' order by a.attnum) from pg_attribute a
           where a.attrelid = c.conrelid and a.attnum = any (c.conkey)) as cols
  from pg_constraint c where c.contype = 'f' and c.connamespace = 'public'::regnamespace)
select is((select string_agg(tbl || '.' || cols, ' ' order by tbl, cols) from fk where del = 'n'),
  'deliveries.checked_by deliveries.year_id,slot_id events.created_by events.updated_by lending_assignments.updated_by lending_records.updated_by lending_requests.updated_by lending_years.confirmed_by notices.created_by notices.updated_by request_submissions.updated_by stocks.counted_by years.prev_year_id',
  '記録のためのユーザー参照（お知らせ・予定と締切の書いた人・直した人、テント等の書いた人・確定した人を含む）・時間枠・複製元は set null');
-- T17 で3本足した：notices.year_id と、notice_groups の2本の複合外部キー。T18 で events.year_id を足した。
-- T21 で8本足した：テント等の5表の year_id と、申請・割り当て・記録の団体への複合外部キー
select is((select count(*)::int from pg_constraint c
           where c.contype = 'f' and c.connamespace = 'public'::regnamespace and c.confdeltype = 'c'), 31,
  '年度・団体・ユーザー・お知らせへの参照は cascade（31 本）');
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
-- お知らせ（T17）：題名は前後の空白（JavaScript の String.prototype.trim が除く 25 文字。半角の空白・タブ・改行・全角の空白・U+00A0 など）を
-- 除いた形で 1〜100 字（RPC が除いてから入れ、CHECK は除いた形であることを確かめる。SQL Editor から前後に空白のある題名を入れさせない）。
-- 本文は 4000 字まで（null 可）
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
select throws_ok(format($$ insert into public.notices (year_id, audience, title) values (%L, 'soumu', E'\u00a0') $$, tests.id('Y1')),
  '23514', null, '題名がノーブレークスペース（U+00A0）だけ（T17A-1）');
select throws_ok(format($$ insert into public.notices (year_id, audience, title) values (%L, 'soumu', E'\u000b題名\ufeff') $$, tests.id('Y1')),
  '23514', null, '題名の前に垂直タブ（U+000B）、後ろに U+FEFF（T17A-1）');
select lives_ok(format($$ insert into public.notices (year_id, audience, title) values (%L, 'soumu', E'\u200b\u0085v題名v\u180e\u3164') $$,
  tests.id('Y1')), 'JavaScript の trim が除かない文字（U+200B・U+0085・U+180E・U+3164・v）は、前後にあっても入る（T17A-1）');
-- 題名の CHECK の式をそのまま、BMP のすべての文字（U+0000 とサロゲートを除く）と補助面のいくつかの文字に当て、題名の前か後ろに
-- 置くと拒まれる文字を並べる（T17A-1）。JavaScript の String.prototype.trim が除く 25 文字（Node で全部の文字を数えた）とちょうど同じこと
create function tests.title_check_trimmed_chars() returns text language plpgsql as $f$
declare
  v_expr text := (select pg_get_expr(c.conbin, c.conrelid) from pg_constraint c
                  where c.conrelid = 'public.notices'::regclass and c.conname = 'notices_title_check');
  v text;
begin
  execute format($q$
    select coalesce(string_agg(to_hex(g.c), ' ' order by g.c), '')
    from (select c from generate_series(1, 65535) c where c not between 55296 and 57343
          union all select unnest(array[65536, 128512, 131072, 917536, 1114111])) g(c)
    where not (select bool_and(%s) from (values (chr(g.c) || '題名'), ('題名' || chr(g.c))) t(title)) $q$, v_expr) into v;
  return v;
end $f$;
select is(tests.title_check_trimmed_chars(),
  '9 a b c d 20 a0 1680 2000 2001 2002 2003 2004 2005 2006 2007 2008 2009 200a 2028 2029 202f 205f 3000 feff',
  '題名の前後に置けない文字は、JavaScript の trim が除く 25 文字とちょうど同じ（T17A-1）');
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
-- 予定と締切（T18）：題名はお知らせと同じ式（同じ 25 文字の空白を除いた形で 1〜100 字。DB では除かず、前後の空白は拒む）。
-- メモは 1000 字まで。終わりは開始より前にできない。終日は Asia/Tokyo の 00:00（開始の日と最後の日）だけ。
-- 開始・終了の日付は 2000-01-01〜2200-12-31（Asia/Tokyo。infinity などを入れさせない）
select is((select string_agg(conname, ' ' order by conname) from pg_constraint where conrelid = 'public.events'::regclass and contype = 'c'),
  'events_all_day_check events_date_range_check events_ends_at_check events_note_check events_title_check', 'events の CHECK は5つ');
select is((select pg_get_constraintdef(oid) from pg_constraint where conname = 'events_title_check'),
  (select pg_get_constraintdef(oid) from pg_constraint where conname = 'notices_title_check'),
  'events_title_check は notices_title_check と同じ式（同じ 25 文字の空白・100 字まで）');
select is((select pg_get_constraintdef(oid) from pg_constraint where conname = 'events_note_check'), 'CHECK ((length(note) <= 1000))',
  'events_note_check はメモ 1000 字まで');
select is((select pg_get_constraintdef(oid) from pg_constraint where conname = 'events_ends_at_check'), 'CHECK ((ends_at >= starts_at))',
  'events_ends_at_check は終わりが開始より前でないこと');
select throws_ok(format($$ insert into public.events (year_id, kind, audience, title, starts_at) values (%L, 'event', 'soumu', '', now()) $$, tests.id('Y1')),
  '23514', null, 'events.title が空');
select throws_ok(format($$ insert into public.events (year_id, kind, audience, title, starts_at) values (%L, 'event', 'soumu', %L, now()) $$,
  tests.id('Y1'), chr(12288) || chr(9)), '23514', null, '予定と締切の題名が空白だけ（全角の空白とタブ）');
select throws_ok(format($$ insert into public.events (year_id, kind, audience, title, starts_at) values (%L, 'event', 'soumu', ' 題名', now()) $$, tests.id('Y1')),
  '23514', null, '予定と締切の題名の前に半角の空白（DB は除かずに拒む）');
select throws_ok(format($$ insert into public.events (year_id, kind, audience, title, starts_at) values (%L, 'event', 'soumu', %L, now()) $$,
  tests.id('Y1'), '題名' || chr(160)), '23514', null, '予定と締切の題名の後ろに U+00A0');
select throws_ok(format($$ insert into public.events (year_id, kind, audience, title, starts_at) values (%L, 'event', 'soumu', repeat('あ', 101), now()) $$, tests.id('Y1')),
  '23514', null, '予定と締切の題名は 100 字まで');
select lives_ok(format($$ insert into public.events (year_id, kind, audience, title, starts_at) values (%L, 'event', 'soumu', repeat('あ', 100), now()) $$, tests.id('Y1')),
  '予定と締切の 100 字の題名は入る');
select lives_ok(format($$ insert into public.events (year_id, kind, audience, title, starts_at) values (%L, 'event', 'soumu', %L, now()) $$,
  tests.id('Y1'), '題 名' || chr(12288) || 'の中'), '予定と締切の題名の中の空白はそのまま入る');
select throws_ok(format($$ insert into public.events (year_id, kind, audience, title, starts_at, note) values (%L, 'event', 'soumu', 'メモ', now(), repeat('あ', 1001)) $$, tests.id('Y1')),
  '23514', null, 'events.note は 1000 字まで');
select lives_ok(format($$ insert into public.events (year_id, kind, audience, title, starts_at, note) values (%L, 'event', 'soumu', 'メモ', now(), repeat('あ', 1000)) $$, tests.id('Y1')),
  '1000 字のメモは入る');
select throws_ok(format($$ insert into public.events (year_id, kind, audience, title, starts_at, ends_at) values (%L, 'event', 'soumu', '終わり', '2027-10-14 10:00+09', '2027-10-14 09:59:59.999999+09') $$, tests.id('Y1')),
  '23514', null, '終わりは開始より前にできない（1 マイクロ秒でも）');
select lives_ok(format($$ insert into public.events (year_id, kind, audience, title, starts_at, ends_at) values (%L, 'event', 'soumu', '終わり', '2027-10-14 10:00+09', '2027-10-14 10:00+09') $$, tests.id('Y1')),
  '終わりが開始と同じ日時は入る');
select throws_ok(format($$ insert into public.events (year_id, kind, audience, title, starts_at, all_day) values (%L, 'event', 'soumu', '終日', '2027-10-16 09:00+09', true) $$, tests.id('Y1')),
  '23514', null, '終日の開始が Asia/Tokyo の 00:00 でない（09:00）');
select throws_ok(format($$ insert into public.events (year_id, kind, audience, title, starts_at, all_day) values (%L, 'event', 'soumu', '終日', '2027-10-16 00:00+00', true) $$, tests.id('Y1')),
  '23514', null, '終日の開始が UTC の 00:00（Asia/Tokyo の 09:00）');
select throws_ok(format($$ insert into public.events (year_id, kind, audience, title, starts_at, ends_at, all_day) values (%L, 'event', 'soumu', '終日', '2027-10-16 00:00+09', '2027-10-17 23:59+09', true) $$, tests.id('Y1')),
  '23514', null, '終日の終わりが Asia/Tokyo の 00:00 でない（最後の日の 00:00 で表す）');
select lives_ok(format($$ insert into public.events (year_id, kind, audience, title, starts_at, ends_at, all_day) values (%L, 'event', 'soumu', '終日', '2027-10-15 15:00+00', '2027-10-16 15:00+00', true) $$, tests.id('Y1')),
  '終日は Asia/Tokyo の 00:00（UTC の前の日の 15:00）で始まり、最後の日の 00:00 で終わる');
select lives_ok(format($$ do $d$ begin perform set_config('timezone', 'UTC', true);
  insert into public.events (year_id, kind, audience, title, starts_at, all_day) values (%L, 'event', 'soumu', '終日', '2027-10-16 00:00+09', true); end $d$ $$, tests.id('Y1')),
  '終日の判定はセッションの TimeZone によらない（UTC でも Asia/Tokyo の 00:00 を受け付ける）');
select lives_ok(format($$ insert into public.events (year_id, kind, audience, title, starts_at, all_day) values (%L, 'event', 'soumu', '時刻', '2027-10-16 09:00+09', false) $$, tests.id('Y1')),
  '終日でなければ時刻の決まりはない');
select throws_ok(format($$ insert into public.events (year_id, kind, audience, title, starts_at) values (%L, 'event', 'soumu', '無限', 'infinity') $$, tests.id('Y1')),
  '23514', null, '開始は infinity にできない');
select throws_ok(format($$ insert into public.events (year_id, kind, audience, title, starts_at) values (%L, 'event', 'soumu', '無限', '-infinity') $$, tests.id('Y1')),
  '23514', null, '開始は -infinity にできない');
select throws_ok(format($$ insert into public.events (year_id, kind, audience, title, starts_at, ends_at) values (%L, 'event', 'soumu', '無限', now(), 'infinity') $$, tests.id('Y1')),
  '23514', null, '終わりは infinity にできない');
select throws_ok(format($$ insert into public.events (year_id, kind, audience, title, starts_at) values (%L, 'event', 'soumu', '範囲', '1999-12-31 23:59+09') $$, tests.id('Y1')),
  '23514', null, '開始の日付は 2000-01-01（Asia/Tokyo）から');
select lives_ok(format($$ insert into public.events (year_id, kind, audience, title, starts_at) values (%L, 'event', 'soumu', '範囲', '2000-01-01 00:00+09') $$, tests.id('Y1')),
  '2000-01-01 00:00（Asia/Tokyo）の開始は入る');
select lives_ok(format($$ insert into public.events (year_id, kind, audience, title, starts_at, ends_at) values (%L, 'event', 'soumu', '範囲', now(), '2200-12-31 23:59+09') $$, tests.id('Y1')),
  '2200-12-31 23:59（Asia/Tokyo）の終わりは入る');
select throws_ok(format($$ insert into public.events (year_id, kind, audience, title, starts_at, ends_at) values (%L, 'event', 'soumu', '範囲', now(), '2201-01-01 00:00+09') $$, tests.id('Y1')),
  '23514', null, '終わりの日付は 2200-12-31（Asia/Tokyo）まで');
-- テント等の貸し出し（T21）：備品の名前・単位はお知らせの題名と同じ式（同じ 25 文字の空白を除いた形）で 1〜100 字・1〜10 字（DB では除かずに
-- 拒む。unique (year_id, name) が「テント」と「テント 」を別の名前にしないため）。在庫・数は 0〜10000、申請できる区分は 4 個まで、記録は
-- 0 ≤ 破損 ≤ 返った ≤ 渡した ≤ 10000、メモは 2000 字まで、確定した人は確定した日時があるときだけ
select is((select string_agg(conname, ' ' order by conname) from pg_constraint where contype = 'c' and conrelid::regclass::text like 'lending\_%'),
  'lending_assignments_count_check lending_items_categories_check lending_items_name_check lending_items_stock_check lending_items_unit_check '
  || 'lending_records_counts_check lending_records_note_check lending_requests_count_check lending_years_confirmed_check',
  'テント等の5表の CHECK は9つ');
select is((select pg_get_constraintdef(oid) from pg_constraint where conname = 'lending_items_name_check'),
  (select replace(pg_get_constraintdef(oid), 'title', 'name') from pg_constraint where conname = 'notices_title_check'),
  'lending_items_name_check は notices_title_check と同じ式（同じ 25 文字の空白・100 字まで）');
select is((select pg_get_constraintdef(oid) from pg_constraint where conname = 'lending_items_unit_check'),
  (select replace(replace(pg_get_constraintdef(oid), 'title', 'unit'), '<= 100', '<= 10') from pg_constraint where conname = 'notices_title_check'),
  'lending_items_unit_check も同じ式で 10 字まで');
select is((select string_agg(conname || '=' || pg_get_constraintdef(oid), ' / ' order by conname) from pg_constraint
           where contype = 'c' and conrelid::regclass::text like 'lending\_%' and conname not in ('lending_items_name_check', 'lending_items_unit_check')),
  'lending_assignments_count_check=CHECK (((count >= 0) AND (count <= 10000))) / '
  || 'lending_items_categories_check=CHECK ((cardinality(requestable_categories) <= 4)) / '
  || 'lending_items_stock_check=CHECK (((stock >= 0) AND (stock <= 10000))) / '
  || 'lending_records_counts_check=CHECK (((damaged_count >= 0) AND (damaged_count <= returned_count) AND (returned_count <= lent_count) AND (lent_count <= 10000))) / '
  || 'lending_records_note_check=CHECK ((length(note) <= 2000)) / '
  || 'lending_requests_count_check=CHECK (((count >= 0) AND (count <= 10000))) / '
  || 'lending_years_confirmed_check=CHECK (((confirmed_at IS NOT NULL) OR (confirmed_by IS NULL)))',
  'テント等の CHECK の式（数は 0〜10000、区分は 4 個まで、破損 ≤ 返った ≤ 渡した ≤ 10000、メモは 2000 字、確定した人は日時があるときだけ）');
select throws_ok(format($$ insert into public.lending_items (year_id, name, stock) values (%L, '', 1) $$, tests.id('Y1')),
  '23514', null, '備品の名前が空');
select throws_ok(format($$ insert into public.lending_items (year_id, name, stock) values (%L, %L, 1) $$, tests.id('Y1'), chr(12288) || chr(9)),
  '23514', null, '備品の名前が空白だけ（全角の空白とタブ）');
select throws_ok(format($$ insert into public.lending_items (year_id, name, stock) values (%L, ' テント', 1) $$, tests.id('Y1')),
  '23514', null, '備品の名前の前に半角の空白（DB は除かずに拒む）');
select throws_ok(format($$ insert into public.lending_items (year_id, name, stock) values (%L, %L, 1) $$, tests.id('Y1'), 'テント' || chr(160)),
  '23514', null, '備品の名前の後ろに U+00A0');
select throws_ok(format($$ insert into public.lending_items (year_id, name, stock) values (%L, repeat('あ', 101), 1) $$, tests.id('Y1')),
  '23514', null, '備品の名前は 100 字まで');
select lives_ok(format($$ insert into public.lending_items (year_id, name, stock) values (%L, repeat('あ', 100), 1) $$, tests.id('Y1')),
  '100 字の備品の名前は入る');
select lives_ok(format($$ insert into public.lending_items (year_id, name, stock) values (%L, %L, 1) $$, tests.id('Y1'), 'テ ン' || chr(12288) || 'ト'),
  '備品の名前の中の空白はそのまま入る');
select throws_ok(format($$ insert into public.lending_items (year_id, name, unit, stock) values (%L, 'T-単位', '', 1) $$, tests.id('Y1')),
  '23514', null, '単位が空');
select throws_ok(format($$ insert into public.lending_items (year_id, name, unit, stock) values (%L, 'T-単位', ' 個', 1) $$, tests.id('Y1')),
  '23514', null, '単位の前に空白');
select throws_ok(format($$ insert into public.lending_items (year_id, name, unit, stock) values (%L, 'T-単位', repeat('a', 11), 1) $$, tests.id('Y1')),
  '23514', null, '単位は 10 字まで');
select lives_ok(format($$ insert into public.lending_items (year_id, name, unit, stock) values (%L, 'T-単位', repeat('a', 10), 1) $$, tests.id('Y1')),
  '10 字の単位は入る');
select throws_ok(format($$ insert into public.lending_items (year_id, name, stock) values (%L, 'T-在庫', -1) $$, tests.id('Y1')),
  '23514', null, '在庫は 0 以上');
select throws_ok(format($$ insert into public.lending_items (year_id, name, stock) values (%L, 'T-在庫', 10001) $$, tests.id('Y1')),
  '23514', null, '在庫は 10000 まで');
select lives_ok(format($$ insert into public.lending_items (year_id, name, stock) values (%L, 'T-在庫0', 0), (%L, 'T-在庫10000', 10000) $$,
  tests.id('Y1'), tests.id('Y1')), '在庫 0・10000 は入る');
select throws_ok(format($$ insert into public.lending_items (year_id, name, stock, requestable_categories) values (%L, 'T-区分', 1, '{stall,department,company,rest_area,stall}') $$,
  tests.id('Y1')), '23514', null, '申請できる区分は 4 個まで');
select lives_ok(format($$ insert into public.lending_items (year_id, name, stock, requestable_categories) values (%L, 'T-区分4', 1, '{stall,department,company,rest_area}'), (%L, 'T-区分0', 1, '{}') $$,
  tests.id('Y1'), tests.id('Y1')), '申請できる区分 4 個・0 個（申請させない備品）は入る');
select throws_ok(format($$ insert into public.lending_items (year_id, name, stock) values (%L, 'T-テント', 1) $$, tests.id('Y1')),
  '23505', null, '同じ年度に同じ名前の備品は作れない');
select lives_ok(format($$ insert into public.lending_items (year_id, name, stock) values (%L, 'T-重し', 1) $$, tests.id('Y2')),
  '年度が違えば同じ名前の備品を作れる');
select throws_ok(format($$ update public.lending_requests set count = -1 where group_id = %L and lending_item_id = %L $$, tests.id('G1'), tests.id('LI_TENT')),
  '23514', null, '申請の数は 0 以上');
select throws_ok(format($$ update public.lending_requests set count = 10001 where group_id = %L and lending_item_id = %L $$, tests.id('G1'), tests.id('LI_TENT')),
  '23514', null, '申請の数は 10000 まで');
select lives_ok(format($$ insert into public.lending_requests (group_id, lending_item_id, year_id, count) values (%L, %L, %L, 10000) $$,
  tests.id('G1'), tests.id('LI_SPARE'), tests.id('Y1')), '申請の数 10000 は入る');
select throws_ok(format($$ update public.lending_assignments set count = -1 where group_id = %L and lending_item_id = %L $$, tests.id('G1'), tests.id('LI_TENT')),
  '23514', null, '割り当ての数は 0 以上');
select throws_ok(format($$ update public.lending_assignments set count = 10001 where group_id = %L and lending_item_id = %L $$, tests.id('G1'), tests.id('LI_TENT')),
  '23514', null, '割り当ての数は 10000 まで');
select lives_ok(format($$ insert into public.lending_assignments (group_id, lending_item_id, year_id, count) values (%L, %L, %L, 0) $$,
  tests.id('G2'), tests.id('LI_TENT'), tests.id('Y1')), '割り当ての 0（貸さないと決めた）は入る');
select throws_ok(format($$ insert into public.lending_records (group_id, lending_item_id, year_id, lent_count, returned_count) values (%L, %L, %L, 1, 2) $$,
  tests.id('G1'), tests.id('LI_SPARE'), tests.id('Y1')), '23514', null, '返った数は渡した数まで');
select throws_ok(format($$ insert into public.lending_records (group_id, lending_item_id, year_id, lent_count, returned_count, damaged_count) values (%L, %L, %L, 2, 1, 2) $$,
  tests.id('G1'), tests.id('LI_SPARE'), tests.id('Y1')), '23514', null, '破損の数は返った数まで');
select throws_ok(format($$ insert into public.lending_records (group_id, lending_item_id, year_id, damaged_count) values (%L, %L, %L, -1) $$,
  tests.id('G1'), tests.id('LI_SPARE'), tests.id('Y1')), '23514', null, '破損の数は 0 以上');
select throws_ok(format($$ insert into public.lending_records (group_id, lending_item_id, year_id, lent_count) values (%L, %L, %L, 10001) $$,
  tests.id('G1'), tests.id('LI_SPARE'), tests.id('Y1')), '23514', null, '渡した数は 10000 まで');
select lives_ok(format($$ insert into public.lending_records (group_id, lending_item_id, year_id, lent_count, returned_count, damaged_count) values (%L, %L, %L, 10000, 10000, 10000) $$,
  tests.id('G1'), tests.id('LI_SPARE'), tests.id('Y1')), '渡した・返った・破損が 10000 でそろうのは入る');
select throws_ok(format($$ update public.lending_records set note = repeat('あ', 2001) where group_id = %L and lending_item_id = %L $$, tests.id('G1'), tests.id('LI_TENT')),
  '23514', null, '記録のメモは 2000 字まで');
select lives_ok(format($$ insert into public.lending_records (group_id, lending_item_id, year_id, note) values (%L, %L, %L, repeat('あ', 2000)) $$,
  tests.id('G2'), tests.id('LI_SPARE'), tests.id('Y1')), '2000 字のメモは入る');
select throws_ok(format($$ insert into public.lending_years (year_id, confirmed_by) values (%L, %L) $$, tests.id('Y1'), tests.id('head')),
  '23514', null, '確定した日時のない確定の印に、確定した人は入れられない');
select lives_ok(format($$ insert into public.lending_years (year_id) values (%L) $$, tests.id('Y1')),
  '確定した日時と人が両方 null の確定の印（確定前・解除の後）は入る');
select throws_ok(format($$ insert into public.lending_years (year_id) values (%L) $$, tests.id('Y2')),
  '23505', null, '確定の印は年度に1行');
-- 年度の一致（複合外部キー）：団体・備品が行と同じ年度でなければ入れられない
select throws_ok(format($$ insert into public.lending_assignments (group_id, lending_item_id, year_id, count) values (%L, %L, %L, 1) $$,
  tests.id('G3'), tests.id('LI_TENT'), tests.id('Y1')), '23503', null, '団体（Y2 の G3）と行の年度（Y1）が違う割り当ては入れられない');
select throws_ok(format($$ insert into public.lending_records (group_id, lending_item_id, year_id) values (%L, %L, %L) $$,
  tests.id('G1'), tests.id('LI_Y2_TENT'), tests.id('Y1')), '23503', null, '備品（Y2）と行の年度（Y1）が違う記録は入れられない');
select throws_ok(format($$ insert into public.lending_assignments (group_id, lending_item_id, year_id, count) values (%L, %L, %L, 0) $$,
  tests.id('G1'), tests.id('LI_SPARE'), tests.id('Y2')), '23503', null, '団体と備品が同じ年度（Y1）でも、行の年度（Y2）が違えば入れられない');

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
-- 予定と締切（T18）：年度ごとの一覧（早い順）とポリシーの year_id in (…) 用
select is((select pg_get_indexdef('public.events_year_id_idx'::regclass)),
  'CREATE INDEX events_year_id_idx ON public.events USING btree (year_id, starts_at)', 'events_year_id_idx は (year_id, starts_at)');
-- テント等の貸し出し（T21）：主キーが団体からの連鎖と団体ごとの読み取りを、(lending_item_id, year_id) が備品の restrict の確かめを、
-- year_id が年度ごとの読み取り（ダッシュボード・/lending）・ポリシーの year_id in (…)・年度からの連鎖を受け持つ
select is((select string_agg(indexname || '=' || regexp_replace(indexdef, '^.* USING btree ', ''), ' / ' order by indexname) from pg_indexes
           where schemaname = 'public' and tablename like 'lending\_%'),
  'lending_assignments_item_idx=(lending_item_id, year_id) / lending_assignments_pkey=(group_id, lending_item_id) / '
  || 'lending_assignments_year_id_idx=(year_id) / lending_items_id_year_id_key=(id, year_id) / lending_items_pkey=(id) / '
  || 'lending_items_year_id_name_key=(year_id, name) / lending_records_item_idx=(lending_item_id, year_id) / '
  || 'lending_records_pkey=(group_id, lending_item_id) / lending_records_year_id_idx=(year_id) / '
  || 'lending_requests_item_idx=(lending_item_id, year_id) / lending_requests_pkey=(group_id, lending_item_id) / '
  || 'lending_requests_year_id_idx=(year_id) / lending_years_pkey=(year_id)',
  'テント等の5表の索引（主キー・一意と、申請・割り当て・記録の年度と備品の索引）');

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

-- 年度・団体の付け替えを止めるトリガーが 20 表にある（T17 で notices の year_id と notice_groups の鍵の列を、T18 で events の year_id を、
-- T21 でテント等の5表の年度・団体・備品の列を足した）
select is((select string_agg(c.relname, ' ' order by c.relname) from pg_trigger t join pg_class c on c.oid = t.tgrelid
           where t.tgname = 'check_immutable' and c.relnamespace = 'public'::regnamespace),
  'allocations deliveries events group_members groups invitations lending_assignments lending_items lending_records lending_requests lending_years notice_groups notices request_submissions requests room_years slots stocks substitution_consents year_roles',
  'check_immutable が 20 表にある');
select is((select pg_get_triggerdef(t.oid) from pg_trigger t where t.tgname = 'check_immutable' and t.tgrelid = 'public.events'::regclass),
  'CREATE TRIGGER check_immutable BEFORE UPDATE OF year_id ON public.events FOR EACH ROW EXECUTE FUNCTION private.tg_immutable_columns(''year_id'')',
  'events は year_id を変えられない');
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

-- 予定と締切（T18）のトリガー：版の増分（bump_version_*）と確定中・終了の守りはない（振り分けの入力でない。終了の年度の読み取り専用は
-- RLS の can_lead）。書いた人・直した人は set_actor（お知らせと同じ中身の、表ごとの関数）。BEFORE ROW のトリガーは名前の順に動く
select is((select string_agg(t.tgname, ' ' order by t.tgname) from pg_trigger t
           where t.tgrelid = 'public.events'::regclass and not t.tgisinternal),
  'audit check_immutable set_actor set_timestamps', 'events のトリガーは4つ（版の増分・確定中の守りはない）');
select is((select string_agg(t.tgname, ' ' order by t.tgname) from pg_trigger t
           where t.tgrelid = 'public.events'::regclass and not t.tgisinternal and (t.tgtype & 3) = 3),
  'check_immutable set_actor set_timestamps', 'events の BEFORE ROW のトリガーの順');
select is((select pg_get_triggerdef(t.oid) from pg_trigger t where t.tgname = 'set_actor' and t.tgrelid = 'public.events'::regclass),
  'CREATE TRIGGER set_actor BEFORE INSERT OR UPDATE ON public.events FOR EACH ROW EXECUTE FUNCTION private.tg_events_set_actor()',
  'events の set_actor：BEFORE INSERT OR UPDATE・行ごと');
select is((select pg_get_triggerdef(t.oid) from pg_trigger t where t.tgname = 'audit' and t.tgrelid = 'public.events'::regclass),
  'CREATE TRIGGER audit AFTER INSERT OR DELETE OR UPDATE ON public.events FOR EACH ROW EXECUTE FUNCTION private.tg_audit(''id'')',
  '予定と締切の監査の row_pk は id');
select is((select case when p.prosecdef then 'definer' else 'invoker' end from pg_proc p
           where p.oid = 'private.tg_events_set_actor()'::regprocedure),
  'invoker', 'tg_events_set_actor は INVOKER（auth.uid() を読むだけ。直接の書き込みでは authenticated で動く）');

-- テント等の貸し出し（T21）のトリガー：版の増分（bump_version_*）と、机椅子の確定中・終了の守り（lock_year_guard）はない（振り分けの
-- 入力でない。終了の年度の読み取り専用は RLS〔can_lead・can_write_requests・can_record_lending〕と RPC）。申請できる区分は
-- check_requestable、確定中の在庫の守りは guard_stock、書いた人は set_actor（表ごとの関数）。BEFORE ROW のトリガーは名前の順に動く
-- （付け替えの禁止 → 区分・在庫の守り → 書いた人 → 日時）
create function pg_temp.lending_triggers(p_before_row boolean) returns text language sql stable as $f$
  select string_agg(c.relname || ':' || x.names, ' ' order by c.relname)
  from (select t.tgrelid, string_agg(t.tgname, ',' order by t.tgname) as names from pg_trigger t
        where not t.tgisinternal and (not p_before_row or (t.tgtype & 3) = 3) group by t.tgrelid) x
  join pg_class c on c.oid = x.tgrelid
  where c.relnamespace = 'public'::regnamespace and c.relname like 'lending\_%'
$f$;
select is(pg_temp.lending_triggers(false),
  'lending_assignments:audit,check_immutable,set_actor,set_timestamps lending_items:audit,check_immutable,guard_stock,set_timestamps '
  || 'lending_records:audit,check_immutable,set_actor,set_timestamps '
  || 'lending_requests:audit,check_immutable,check_requestable,set_actor,set_timestamps lending_years:audit,check_immutable,set_timestamps',
  'テント等の5表のトリガー（版の増分・確定中の守りはない）');
select is(pg_temp.lending_triggers(true),
  'lending_assignments:check_immutable,set_actor,set_timestamps lending_items:check_immutable,guard_stock,set_timestamps '
  || 'lending_records:check_immutable,set_actor,set_timestamps lending_requests:check_immutable,check_requestable,set_actor,set_timestamps '
  || 'lending_years:check_immutable,set_timestamps',
  'テント等の BEFORE ROW のトリガーの順');
create function pg_temp.lending_triggerdefs(p_table text) returns text language sql stable as $f$
  select string_agg(regexp_replace(pg_get_triggerdef(t.oid), '^CREATE TRIGGER ', ''), ' / ' order by t.tgname)
  from pg_trigger t where t.tgrelid = ('public.' || p_table)::regclass and not t.tgisinternal and t.tgname <> 'set_timestamps'
$f$;
select is(pg_temp.lending_triggerdefs('lending_items'),
  'audit AFTER INSERT OR DELETE OR UPDATE ON public.lending_items FOR EACH ROW EXECUTE FUNCTION private.tg_audit(''id'') / '
  || 'check_immutable BEFORE UPDATE OF year_id ON public.lending_items FOR EACH ROW EXECUTE FUNCTION private.tg_immutable_columns(''year_id'') / '
  || 'guard_stock BEFORE UPDATE OF stock ON public.lending_items FOR EACH ROW EXECUTE FUNCTION private.tg_lending_items_guard_stock()',
  'lending_items：監査の row_pk は id、year_id は変えられない、在庫の更新で確定中の守り');
select is(pg_temp.lending_triggerdefs('lending_requests'),
  'audit AFTER INSERT OR DELETE OR UPDATE ON public.lending_requests FOR EACH ROW EXECUTE FUNCTION private.tg_audit(''group_id,lending_item_id'') / '
  || 'check_immutable BEFORE UPDATE OF group_id, lending_item_id, year_id ON public.lending_requests FOR EACH ROW EXECUTE FUNCTION private.tg_immutable_columns(''group_id'', ''lending_item_id'', ''year_id'') / '
  || 'check_requestable BEFORE INSERT OR UPDATE OF group_id, lending_item_id, count ON public.lending_requests FOR EACH ROW EXECUTE FUNCTION private.tg_lending_requests_check_requestable() / '
  || 'set_actor BEFORE INSERT OR UPDATE ON public.lending_requests FOR EACH ROW EXECUTE FUNCTION private.tg_lending_requests_set_actor()',
  'lending_requests：監査の row_pk は団体と備品、鍵の列は変えられない、申請できる区分、書いた人');
select is(pg_temp.lending_triggerdefs('lending_assignments'),
  'audit AFTER INSERT OR DELETE OR UPDATE ON public.lending_assignments FOR EACH ROW EXECUTE FUNCTION private.tg_audit(''group_id,lending_item_id'') / '
  || 'check_immutable BEFORE UPDATE OF group_id, lending_item_id, year_id ON public.lending_assignments FOR EACH ROW EXECUTE FUNCTION private.tg_immutable_columns(''group_id'', ''lending_item_id'', ''year_id'') / '
  || 'set_actor BEFORE INSERT OR UPDATE ON public.lending_assignments FOR EACH ROW EXECUTE FUNCTION private.tg_lending_assignments_set_actor()',
  'lending_assignments：監査の row_pk は団体と備品、鍵の列は変えられない、書いた人（区分の確かめはない）');
select is(pg_temp.lending_triggerdefs('lending_records'),
  'audit AFTER INSERT OR DELETE OR UPDATE ON public.lending_records FOR EACH ROW EXECUTE FUNCTION private.tg_audit(''group_id,lending_item_id'') / '
  || 'check_immutable BEFORE UPDATE OF group_id, lending_item_id, year_id ON public.lending_records FOR EACH ROW EXECUTE FUNCTION private.tg_immutable_columns(''group_id'', ''lending_item_id'', ''year_id'') / '
  || 'set_actor BEFORE INSERT OR UPDATE ON public.lending_records FOR EACH ROW EXECUTE FUNCTION private.tg_lending_records_set_actor()',
  'lending_records：監査の row_pk は団体と備品、鍵の列は変えられない、書いた人');
select is(pg_temp.lending_triggerdefs('lending_years'),
  'audit AFTER INSERT OR DELETE OR UPDATE ON public.lending_years FOR EACH ROW EXECUTE FUNCTION private.tg_audit(''year_id'') / '
  || 'check_immutable BEFORE UPDATE OF year_id ON public.lending_years FOR EACH ROW EXECUTE FUNCTION private.tg_immutable_columns(''year_id'')',
  'lending_years：監査の row_pk は年度、year_id は変えられない');
-- トリガー関数と年度のロック：set_actor は INVOKER（auth.uid() を読むだけ）、区分と在庫の守りは DEFINER（RLS を通らずに団体・備品・
-- 確定の印・割り当てを読み、private.fail を呼ぶ）、年度のロックは表を読まないので INVOKER（どれも VOLATILE）
select is((select string_agg(p.proname || '=' || case when p.prosecdef then 'definer' else 'invoker' end || ':' || p.provolatile::text, ' ' order by p.proname)
           from pg_proc p where p.pronamespace = 'private'::regnamespace
             and p.proname in ('tg_lending_items_guard_stock', 'tg_lending_requests_check_requestable', 'tg_lending_requests_set_actor',
                               'tg_lending_assignments_set_actor', 'tg_lending_records_set_actor', 'lock_lending_year')),
  'lock_lending_year=invoker:v tg_lending_assignments_set_actor=invoker:v tg_lending_items_guard_stock=definer:v '
  || 'tg_lending_records_set_actor=invoker:v tg_lending_requests_check_requestable=definer:v tg_lending_requests_set_actor=invoker:v',
  'テント等のトリガー関数と年度のロックの SECURITY と揮発性');

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

-- 時刻のトリガーが audit_logs 以外の 26 表にある（T17 で notices・notice_groups を、T18 で events を、T21 でテント等の5表を足した）
select is((select count(distinct c.relname)::int from pg_trigger t join pg_class c on c.oid = t.tgrelid
           where t.tgname = 'set_timestamps' and c.relnamespace = 'public'::regnamespace and not t.tgisinternal), 26,
  'set_timestamps が 26 表にある');

-- トリガーの一覧（表ごとの名前の集合）
select is((select string_agg(c.relname, ' ' order by c.relname) from pg_trigger t join pg_class c on c.oid = t.tgrelid
           where t.tgname = 'audit' and c.relnamespace = 'public'::regnamespace),
  'allocations distance_overrides events group_members groups items lending_assignments lending_items lending_records lending_requests lending_years notice_groups notices request_submissions requests room_years rooms rules stocks substitution_consents year_roles years',
  'audit が 22 表にある（invitations・profiles は個人情報のため記録しない。T17 でお知らせの2表を、T18 で予定と締切を、T21 でテント等の5表を足した）');
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
