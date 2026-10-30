-- 010_grants：権限の棚卸し（T03）。grant・ポリシー・関数の設定の漏れを、一覧との比較で見つける。
-- anon と PUBLIC に何もないことは 001_schema が確かめる。ここでは authenticated と supabase_auth_admin を一覧で比べる（supabase_auth_admin は T04 でフックを足した）。
begin;
\ir _helpers/personas.psql
select plan(16);

-- ---------------------------------------------------------------- 関数
select is_empty($$ select p.oid::regprocedure::text from pg_proc p
                   where p.pronamespace in ('public'::regnamespace, 'private'::regnamespace)
                     and has_function_privilege('anon', p.oid, 'execute') $$,
  'anon が実行できる public・private の関数はない');
select set_eq($$ select p.proname::text from pg_proc p
                 where p.pronamespace = 'public'::regnamespace and has_function_privilege('authenticated', p.oid, 'execute') $$,
  array['set_year_status','update_year','create_year_from','invite','set_role','remove_role','revoke_invitation',
        'remove_group_member','accept_my_invitations','save_auto_allocations','save_allocation_rows','set_consent','submit_requests',
        'update_requests_after_deadline','check_delivery','previous_year_stocks','previous_year_requests'],
  'authenticated が実行できる public の関数は RPC 17 個だけ');
select set_eq($$ select p.proname::text from pg_proc p
                 where p.pronamespace = 'private'::regnamespace and has_function_privilege('authenticated', p.oid, 'execute') $$,
  array['has_role','has_any_role','is_group_member','group_year_id','year_status','can_read_year','has_any_access',
        'is_admin_of_open_year','can_see_profile','can_admin','can_write_stocks','can_write_requests','my_verified_email'],
  'authenticated が実行できる private の関数は、ポリシーが呼ぶ判定関数 13 個だけ（RPC の補助・トリガー関数・verified_email は実行できない）');
-- Before User Created フック（0007、T04）と、フックが呼ぶ学校のドメインの関数だけ。トリガー関数・招待の受け入れの関数は実行できない
select set_eq($$ select p.oid::regprocedure::text from pg_proc p
                 where p.pronamespace in ('public'::regnamespace, 'private'::regnamespace)
                   and has_function_privilege('supabase_auth_admin', p.oid, 'execute') $$,
  array['private.hook_before_user_created(jsonb)', 'private.school_domain()'],
  'supabase_auth_admin が実行できる public・private の関数は、フックとフックが呼ぶ school_domain だけ');
select is_empty($$ select p.oid::regprocedure::text from pg_proc p
                   where p.pronamespace = 'public'::regnamespace
                     and not exists (select 1 from pg_depend d where d.classid = 'pg_proc'::regclass and d.objid = p.oid and d.deptype = 'e')
                     and not (p.prosecdef and coalesce(p.proconfig @> array['search_path=""'], false)) $$,
  'public の関数（RPC）はすべて SECURITY DEFINER・search_path = ""');
select is_empty($$ select p.oid::regprocedure::text from pg_proc p
                   where p.pronamespace in ('public'::regnamespace, 'private'::regnamespace) and p.prosecdef
                     and not coalesce(p.proconfig @> array['search_path=""'], false) $$,
  'SECURITY DEFINER の関数はすべて search_path = ""');
select is_empty($$ select p.oid::regprocedure::text from pg_proc p
                   where p.pronamespace = 'private'::regnamespace
                     and p.proname in ('has_role','has_any_role','is_group_member','group_year_id','year_status','can_read_year',
                                       'has_any_access','is_admin_of_open_year','can_see_profile','can_admin','can_write_stocks',
                                       'can_write_requests','my_verified_email')
                     and not (p.prosecdef and p.provolatile = 's') $$,
  '判定関数はすべて SECURITY DEFINER・STABLE');

-- ---------------------------------------------------------------- スキーマ・表・シーケンス
select ok(has_schema_privilege('authenticated', 'private', 'usage') and not has_schema_privilege('authenticated', 'private', 'create')
          and not has_schema_privilege('anon', 'private', 'usage'),
  'authenticated は private を usage できる（ポリシーの判定関数のため）が create できない。anon は usage もない');
select set_eq($$ select format('%s %s', c.relname, p.p) from pg_class c
                 cross join unnest(array['select', 'insert', 'update', 'delete', 'truncate', 'references', 'trigger']) as p(p)
                 where c.relnamespace = 'public'::regnamespace and c.relkind in ('r', 'v')
                   and has_table_privilege('authenticated', c.oid, p.p) $$,
  array(select format('%s %s', t, p) from unnest(array['years','rooms','room_years','items','stocks','groups','year_roles',
          'group_members','invitations','request_submissions','requests','rules','substitution_consents','allocations',
          'distance_overrides','slots','deliveries','profiles','audit_logs','v_remaining']) t, unnest(array['select']) p
        union all
        select format('%s %s', t, p) from unnest(array['rooms','items','room_years','distance_overrides','stocks','groups',
          'request_submissions','requests','rules','slots','deliveries']) t, unnest(array['insert','update','delete']) p),
  'authenticated の表の権限：全表の select と、W の 11 表の insert・update・delete だけ（RPC だけで書く表には書き込みの権限がない）');
select is_empty($$ select c.relname::text from pg_class c
                   where c.relnamespace = 'public'::regnamespace and c.relkind in ('r', 'v')
                     and (has_any_column_privilege('anon', c.oid, 'select') or has_any_column_privilege('anon', c.oid, 'insert')
                          or has_any_column_privilege('anon', c.oid, 'update')) $$,
  'anon は表・ビュー・列に何の権限もない');
select is_empty($$ select c.relname::text from pg_class c
                   where c.relnamespace in ('public'::regnamespace, 'private'::regnamespace) and c.relkind = 'S'
                     and (has_sequence_privilege('authenticated', c.oid, 'usage') or has_sequence_privilege('authenticated', c.oid, 'update')) $$,
  'authenticated はシーケンスを使えない（audit_logs は DEFINER のトリガーだけが書く）');

-- ---------------------------------------------------------------- RLS とポリシー
select is((select count(*)::int from pg_class c where c.relnamespace = 'public'::regnamespace and c.relkind = 'r' and not c.relrowsecurity), 0,
  '全表で RLS が有効');
select ok((select 'security_invoker=true' = any (reloptions) from pg_class where oid = 'public.v_remaining'::regclass),
  'v_remaining は security_invoker（RLS を素通りしない）');
select set_eq($$ select format('%s %s', tablename, cmd) from pg_policies where schemaname = 'public' $$,
  array(select format('%s %s', t, c) from unnest(array['rooms','items','distance_overrides','room_years','slots','stocks','groups',
          'request_submissions','requests','rules','deliveries']) t, unnest(array['SELECT','INSERT','UPDATE','DELETE']) c
        union all
        select format('%s SELECT', t) from unnest(array['years','year_roles','group_members','invitations','substitution_consents',
          'allocations','profiles','audit_logs']) t),
  'ポリシーは 52 個（W の 11 表は4操作、RPC だけで書く 8 表は select だけ）');
select is_empty($$ select policyname::text from pg_policies where schemaname = 'public' and roles <> '{authenticated}' $$,
  'ポリシーはすべて to authenticated');
select is_empty($$ select policyname::text from pg_policies
                   where schemaname = 'public' and cmd = 'UPDATE' and (qual is null or with_check is null) $$,
  'update のポリシーはすべて using と with check の両方を持つ');

select * from finish();
rollback;
