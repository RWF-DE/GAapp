-- 010_grants：権限の棚卸し（T03）。grant・ポリシー・関数の設定の漏れを、一覧との比較で見つける。
-- anon と PUBLIC に何もないことは 001_schema が確かめる。ここでは authenticated と supabase_auth_admin を一覧で比べる（supabase_auth_admin は T04 でフックを足した）。
begin;
\ir _helpers/personas.psql
select plan(43);

-- 一覧（T15 から版〔引数の型〕まで比べる。同じ名前の古い版〔4引数の invite など〕が残れば落ちる）
create table tests.expected_fn (kind text not null, sig text primary key);
insert into tests.expected_fn values
  -- authenticated が実行できる public の関数（RPC 20 個。T17 でお知らせの save_notice・delete_notice を足した）
  ('rpc', 'public.set_year_status(uuid, public.year_status, text, integer)'),
  ('rpc', 'public.update_year(uuid, jsonb, text)'),
  ('rpc', 'public.create_year_from(uuid, text, date)'),
  ('rpc', 'public.invite(uuid, text, public.app_role, uuid, public.group_role)'),
  ('rpc', 'public.set_role(uuid, uuid, public.app_role, text)'),
  ('rpc', 'public.remove_role(uuid, uuid, text)'),
  ('rpc', 'public.revoke_invitation(uuid)'),
  ('rpc', 'public.remove_group_member(uuid, uuid, text)'),
  ('rpc', 'public.set_group_member_role(uuid, uuid, public.group_role, text)'),
  ('rpc', 'public.accept_my_invitations()'),
  ('rpc', 'public.save_auto_allocations(uuid, jsonb, text, integer)'),
  ('rpc', 'public.save_allocation_rows(uuid, jsonb, text)'),
  ('rpc', 'public.set_consent(uuid, uuid, uuid, public.consent_status, text)'),
  ('rpc', 'public.submit_requests(uuid, jsonb, text)'),
  ('rpc', 'public.update_requests_after_deadline(uuid, jsonb, text, jsonb)'),
  ('rpc', 'public.check_delivery(uuid, public.delivery_status, text, boolean)'),
  ('rpc', 'public.previous_year_stocks(uuid)'),
  ('rpc', 'public.previous_year_requests(uuid)'),
  ('rpc', 'public.save_notice(uuid, public.notice_audience, text, text, boolean, uuid[], uuid, timestamp with time zone)'),
  ('rpc', 'public.delete_notice(uuid, timestamp with time zone)'),
  -- authenticated が実行できる private の関数（ポリシー・トリガーが呼ぶ判定関数 19 個。0010 の集合の3個、T15 の can_lead、
  -- T17 のお知らせの集合の2個〔my_group_year_ids・my_group_notice_ids〕を含む）
  ('predicate', 'private.has_role(uuid, public.app_role)'),
  ('predicate', 'private.has_any_role(uuid, public.app_role[])'),
  ('predicate', 'private.is_group_member(uuid)'),
  ('predicate', 'private.group_year_id(uuid)'),
  ('predicate', 'private.year_status(uuid)'),
  ('predicate', 'private.can_read_year(uuid)'),
  ('predicate', 'private.has_any_access()'),
  ('predicate', 'private.is_admin_of_open_year()'),
  ('predicate', 'private.can_see_profile(uuid)'),
  ('predicate', 'private.can_admin(uuid)'),
  ('predicate', 'private.can_lead(uuid)'),
  ('predicate', 'private.can_write_stocks(uuid)'),
  ('predicate', 'private.can_write_requests(uuid)'),
  ('predicate', 'private.my_verified_email()'),
  ('predicate', 'private.my_role_year_ids(public.app_role[])'),
  ('predicate', 'private.my_group_ids()'),
  ('predicate', 'private.my_role_group_ids(public.app_role[])'),
  ('predicate', 'private.my_group_year_ids()'),
  ('predicate', 'private.my_group_notice_ids()'),
  -- 兼任の禁止の補助とトリガー関数（0013。任意の人について答えるので、誰も実行できない）
  ('overlap', 'private.lock_year_member(uuid, uuid)'),
  ('overlap', 'private.year_member_has_department_role(uuid, uuid)'),
  ('overlap', 'private.year_member_in_group(uuid, uuid)'),
  ('overlap', 'private.tg_year_roles_check_overlap()'),
  ('overlap', 'private.tg_group_members_check_overlap()'),
  -- お知らせのトリガー関数（0014。T17。誰も実行できない）
  ('notice_trigger', 'private.tg_notices_set_actor()'),
  ('notice_trigger', 'private.tg_notice_groups_check_audience()'),
  ('notice_trigger', 'private.tg_notices_check_groups()'),
  -- 予定と締切のトリガー関数（0015。T18。誰も実行できない。判定関数と RPC は足していない）
  ('event_trigger', 'private.tg_events_set_actor()');
-- 提出物（0016。T19）：RPC 11 個、ポリシー（storage.objects を含む）が呼ぶ集合の関数3個、トリガー関数2つと RPC の補助2つ（誰も実行できない）
insert into tests.expected_fn values
  ('rpc', 'public.reserve_document_file(uuid, uuid, uuid, text, integer)'),
  ('rpc', 'public.discard_document_file(uuid)'),
  ('rpc', 'public.submit_document(uuid, uuid, timestamp with time zone)'),
  ('rpc', 'public.withdraw_document(uuid, uuid, timestamp with time zone)'),
  ('rpc', 'public.approve_document(uuid, uuid, text, timestamp with time zone)'),
  ('rpc', 'public.return_document(uuid, uuid, text, timestamp with time zone)'),
  ('rpc', 'public.previous_year_documents(uuid)'),
  ('rpc', 'public.copy_previous_documents(uuid, uuid[])'),
  ('rpc', 'public.delete_year_document_files(uuid, text)'),
  ('rpc', 'public.document_orphan_paths(uuid)'),
  ('rpc', 'public.document_storage_usage(uuid)'),
  ('predicate', 'private.my_group_document_ids()'),
  ('predicate', 'private.my_document_upload_paths()'),
  ('predicate', 'private.my_document_orphan_paths()'),
  ('document_helper', 'private.tg_documents_normalize_categories()'),
  ('document_helper', 'private.tg_documents_set_actor()'),
  ('document_helper', 'private.lock_document_year(uuid, uuid)'),
  ('document_helper', 'private.target_document(uuid, uuid, uuid)');

-- ---------------------------------------------------------------- 関数
select is_empty($$ select sig from tests.expected_fn where to_regprocedure(sig) is null $$,
  '一覧の関数がすべてある（名前と引数の型で）');
select is_empty($$ select p.oid::regprocedure::text from pg_proc p
                   where p.pronamespace in ('public'::regnamespace, 'private'::regnamespace)
                     and has_function_privilege('anon', p.oid, 'execute') $$,
  'anon が実行できる public・private の関数はない');
select set_eq($$ select p.oid::regprocedure::text from pg_proc p
                 where p.pronamespace = 'public'::regnamespace and has_function_privilege('authenticated', p.oid, 'execute') $$,
  $$ select to_regprocedure(sig)::text from tests.expected_fn where kind = 'rpc' $$,
  'authenticated が実行できる public の関数は RPC 31 個だけ（版まで比べる。T19 で提出物の 11 個を足した）');
select set_eq($$ select p.oid::regprocedure::text from pg_proc p
                 where p.pronamespace = 'private'::regnamespace and has_function_privilege('authenticated', p.oid, 'execute') $$,
  $$ select to_regprocedure(sig)::text from tests.expected_fn where kind = 'predicate' $$,
  'authenticated が実行できる private の関数は、ポリシーが呼ぶ判定関数 22 個だけ（0010 の集合の3個・can_lead・お知らせの集合の2個・提出物の集合の3個を含む。RPC の補助・トリガー関数・verified_email・兼任の補助は実行できない）');
-- 同じ名前の public の関数は版が1つだけ（2つあると、名前つきの引数で呼ぶ PostgREST が版を選べない。PGRST203）
select is_empty($$ select p.proname::text from pg_proc p where p.pronamespace = 'public'::regnamespace
                   and not exists (select 1 from pg_depend d where d.classid = 'pg_proc'::regclass and d.objid = p.oid and d.deptype = 'e')
                   group by p.proname having count(*) > 1 $$,
  'public に同じ名前の関数が2つない（T15 で4引数の invite を消した）');
-- invite は今の画面の名前つきの呼び出し（{p_year_id, p_email, p_role} か {p_year_id, p_email, p_group_id}）で動く：引数名は変えず、
-- 足した p_group_role も既定値つき（後ろの3つが既定値 null）
select is((select array_to_string(p.proargnames, ',') || ' defaults=' || p.pronargdefaults
           from pg_proc p where p.oid = to_regprocedure('public.invite(uuid, text, public.app_role, uuid, public.group_role)')),
  'p_year_id,p_email,p_role,p_group_id,p_group_role defaults=3', 'invite の引数名と既定値（今の画面と後方互換）');
-- save_notice（T17）：要る引数（年度・宛先・題名）を先に、省ける5つ（本文・ピン留め・宛先の団体・お知らせ・版）を後ろに置く
-- （既定値のある引数の後に既定値のない引数を置けない。PostgREST は名前で呼ぶ）。返り値はお知らせの行。delete_notice は2つとも要る
select is((select array_to_string(p.proargnames, ',') || ' defaults=' || p.pronargdefaults || ' returns=' || pg_get_function_result(p.oid)
           from pg_proc p where p.oid = to_regprocedure('public.save_notice(uuid, public.notice_audience, text, text, boolean, uuid[], uuid, timestamptz)')),
  'p_year_id,p_audience,p_title,p_body,p_pinned,p_group_ids,p_notice_id,p_base_updated_at defaults=5 returns=notices',
  'save_notice の引数名・既定値の数・返り値');
select is((select pg_get_function_arguments(p.oid) from pg_proc p
           where p.oid = to_regprocedure('public.save_notice(uuid, public.notice_audience, text, text, boolean, uuid[], uuid, timestamptz)')),
  'p_year_id uuid, p_audience notice_audience, p_title text, p_body text DEFAULT NULL::text, p_pinned boolean DEFAULT false, '
  || 'p_group_ids uuid[] DEFAULT ''{}''::uuid[], p_notice_id uuid DEFAULT NULL::uuid, p_base_updated_at timestamp with time zone DEFAULT NULL::timestamp with time zone',
  'save_notice の既定値：本文 null・ピン留め false・宛先の団体は空・お知らせ null（作る）・版 null');
select is((select array_to_string(p.proargnames, ',') || ' defaults=' || p.pronargdefaults || ' returns=' || pg_get_function_result(p.oid)
           from pg_proc p where p.oid = to_regprocedure('public.delete_notice(uuid, timestamptz)')),
  'p_notice_id,p_base_updated_at defaults=0 returns=void', 'delete_notice の引数名・既定値なし・返り値');
-- Before User Created フック（0007、T04）と、フックが呼ぶ学校のドメインの関数だけ。トリガー関数・招待の受け入れの関数は実行できない
select set_eq($$ select p.oid::regprocedure::text from pg_proc p
                 where p.pronamespace in ('public'::regnamespace, 'private'::regnamespace)
                   and has_function_privilege('supabase_auth_admin', p.oid, 'execute') $$,
  array['private.hook_before_user_created(jsonb)', 'private.school_domain()'],
  'supabase_auth_admin が実行できる public・private の関数は、フックとフックが呼ぶ school_domain だけ');
select is_empty($$ select f.sig from tests.expected_fn f
                   where f.kind = 'overlap'
                     and (has_function_privilege('authenticated', to_regprocedure(f.sig), 'execute')
                          or has_function_privilege('anon', to_regprocedure(f.sig), 'execute')
                          or has_function_privilege('supabase_auth_admin', to_regprocedure(f.sig), 'execute')
                          or exists (select 1 from pg_proc p, aclexplode(p.proacl) a
                                     where p.oid = to_regprocedure(f.sig) and a.grantee = 0)) $$,
  '兼任の禁止の補助とトリガー関数は、authenticated・anon・supabase_auth_admin・PUBLIC のどれも実行できない');
select is_empty($$ select f.sig from tests.expected_fn f
                   where f.kind = 'notice_trigger'
                     and (has_function_privilege('authenticated', to_regprocedure(f.sig), 'execute')
                          or has_function_privilege('anon', to_regprocedure(f.sig), 'execute')
                          or has_function_privilege('supabase_auth_admin', to_regprocedure(f.sig), 'execute')
                          or exists (select 1 from pg_proc p, aclexplode(p.proacl) a
                                     where p.oid = to_regprocedure(f.sig) and a.grantee = 0)) $$,
  'お知らせのトリガー関数（set_actor・check_audience・check_groups）は、authenticated・anon・supabase_auth_admin・PUBLIC のどれも実行できない');
select is_empty($$ select f.sig from tests.expected_fn f
                   where f.kind = 'event_trigger'
                     and (has_function_privilege('authenticated', to_regprocedure(f.sig), 'execute')
                          or has_function_privilege('anon', to_regprocedure(f.sig), 'execute')
                          or has_function_privilege('supabase_auth_admin', to_regprocedure(f.sig), 'execute')
                          or exists (select 1 from pg_proc p, aclexplode(p.proacl) a
                                     where p.oid = to_regprocedure(f.sig) and a.grantee = 0)) $$,
  '予定と締切のトリガー関数（set_actor）は、authenticated・anon・supabase_auth_admin・PUBLIC のどれも実行できない（T18）');
select is_empty($$ select f.sig from tests.expected_fn f
                   where f.kind = 'document_helper'
                     and (has_function_privilege('authenticated', to_regprocedure(f.sig), 'execute')
                          or has_function_privilege('anon', to_regprocedure(f.sig), 'execute')
                          or has_function_privilege('supabase_auth_admin', to_regprocedure(f.sig), 'execute')
                          or exists (select 1 from pg_proc p, aclexplode(p.proacl) a
                                     where p.oid = to_regprocedure(f.sig) and a.grantee = 0)) $$,
  '提出物のトリガー関数（set_actor・区分の並べ直し）と RPC の補助（lock_document_year・target_document）は、authenticated・anon・supabase_auth_admin・PUBLIC のどれも実行できない（T19）');
select is((select string_agg(p.proname || '=' || case when p.prosecdef then 'definer' else 'invoker' end || ':' || p.provolatile::text, ' ' order by p.proname)
           from tests.expected_fn f join pg_proc p on p.oid = to_regprocedure(f.sig) where f.kind = 'document_helper'),
  'lock_document_year=definer:v target_document=definer:v tg_documents_normalize_categories=invoker:v tg_documents_set_actor=invoker:v',
  '提出物の RPC の補助は DEFINER・VOLATILE（ロックの後を新しいスナップショットで読む）、トリガー関数は INVOKER');
-- 提出物の RPC（T19。04 の DB 関数）：引数名・既定値・返り値。どれも名前つきで呼ぶ。既定値は delete_year_document_files の理由（null）だけ
-- （base_updated_at は既定値なし：行がなければ null を名前つきで渡す）
select is((select string_agg(p.proname || '(' || array_to_string(p.proargnames[1:p.pronargs], ',') || ') defaults=' || p.pronargdefaults
                             || ' returns=' || pg_get_function_result(p.oid), ' | ' order by p.proname)
           from tests.expected_fn f join pg_proc p on p.oid = to_regprocedure(f.sig)
           where f.kind = 'rpc' and p.proname ~ 'document'),
  'approve_document(p_document_id,p_group_id,p_note,p_base_updated_at) defaults=0 returns=document_submissions | '
  || 'copy_previous_documents(p_year_id,p_document_ids) defaults=0 returns=SETOF documents | '
  || 'delete_year_document_files(p_year_id,p_reason) defaults=1 returns=integer | '
  || 'discard_document_file(p_file_id) defaults=0 returns=text | '
  || 'document_orphan_paths(p_year_id) defaults=0 returns=SETOF text | '
  || 'document_storage_usage(p_year_id) defaults=0 returns=TABLE(bucket_bytes bigint, limit_bytes bigint, file_count integer, file_bytes bigint, orphan_count integer) | '
  || 'previous_year_documents(p_year_id) defaults=0 returns=TABLE(document_id uuid, title text, description text, deadline timestamp with time zone, '
  || 'new_deadline timestamp with time zone, target_categories group_category[], food_only boolean, requires_file boolean, exists_in_year boolean) | '
  || 'reserve_document_file(p_document_id,p_group_id,p_file_id,p_content_type,p_size) defaults=0 returns=document_files | '
  || 'return_document(p_document_id,p_group_id,p_note,p_base_updated_at) defaults=0 returns=document_submissions | '
  || 'submit_document(p_document_id,p_group_id,p_base_updated_at) defaults=0 returns=document_submissions | '
  || 'withdraw_document(p_document_id,p_group_id,p_base_updated_at) defaults=0 returns=document_submissions',
  '提出物の RPC 11 個の引数名・既定値の数・返り値');
select is((select pg_get_function_arguments(p.oid) from pg_proc p where p.oid = to_regprocedure('public.delete_year_document_files(uuid, text)')),
  'p_year_id uuid, p_reason text DEFAULT NULL::text', 'delete_year_document_files の理由は省ける（既定値 null。省けば「提出物のファイルの削除」）');
select is((select string_agg(p.proname || '=' || p.provolatile::text, ' ' order by p.proname)
           from tests.expected_fn f join pg_proc p on p.oid = to_regprocedure(f.sig)
           where f.kind = 'rpc' and p.proname ~ 'document' and p.provolatile <> 'v'),
  'document_orphan_paths=s document_storage_usage=s previous_year_documents=s',
  '提出物の読み取りの RPC 3つは STABLE（ほかの 8 個は書く）');
select is_empty($$ select p.oid::regprocedure::text from pg_proc p
                   where p.pronamespace = 'public'::regnamespace
                     and not exists (select 1 from pg_depend d where d.classid = 'pg_proc'::regclass and d.objid = p.oid and d.deptype = 'e')
                     and not (p.prosecdef and coalesce(p.proconfig @> array['search_path=""'], false)) $$,
  'public の関数（RPC）はすべて SECURITY DEFINER・search_path = ""');
select is_empty($$ select p.oid::regprocedure::text from pg_proc p
                   where p.pronamespace in ('public'::regnamespace, 'private'::regnamespace) and p.prosecdef
                     and not coalesce(p.proconfig @> array['search_path=""'], false) $$,
  'SECURITY DEFINER の関数はすべて search_path = ""');
select is_empty($$ select f.sig from tests.expected_fn f join pg_proc p on p.oid = to_regprocedure(f.sig)
                   where f.kind = 'predicate' and not (p.prosecdef and p.provolatile = 's') $$,
  '判定関数はすべて SECURITY DEFINER・STABLE（can_lead を含む）');

-- 段の書き漏れの守り（T15。D-48：総務副部門長の権限は総務部門長と同じ）：関数の本体とポリシーの式で、head が出てくる所には
-- いつも deputy_head も出てくる（数が同じ）。片方だけを足した・直した関数やポリシーがあれば落ちる。
-- \m・\M は単語の境目なので、deputy_head の中の head は数えない
select is_empty($$ select p.oid::regprocedure::text || ' head=' || regexp_count(p.prosrc, '\mhead\M')
                          || ' deputy_head=' || regexp_count(p.prosrc, '\mdeputy_head\M')
                   from pg_proc p
                   where p.pronamespace in ('public'::regnamespace, 'private'::regnamespace)
                     and not exists (select 1 from pg_depend d where d.classid = 'pg_proc'::regclass and d.objid = p.oid and d.deptype = 'e')
                     and regexp_count(p.prosrc, '\mhead\M') <> regexp_count(p.prosrc, '\mdeputy_head\M') $$,
  '関数の本体で、head と deputy_head はいつも組で出てくる');
select is_empty($$ select format('%s %s head=%s deputy_head=%s', tablename, policyname,
                                 regexp_count(coalesce(qual, '') || ' ' || coalesce(with_check, ''), '\mhead\M'),
                                 regexp_count(coalesce(qual, '') || ' ' || coalesce(with_check, ''), '\mdeputy_head\M'))
                   from pg_policies
                   where schemaname = 'public'
                     and regexp_count(coalesce(qual, '') || ' ' || coalesce(with_check, ''), '\mhead\M')
                         <> regexp_count(coalesce(qual, '') || ' ' || coalesce(with_check, ''), '\mdeputy_head\M') $$,
  'ポリシーの式（using・with check）で、head と deputy_head はいつも組で出てくる');
-- 守りが空振りしていない（段の配列を使う関数とポリシーがある）
select ok((select count(*) >= 20 from pg_proc p
           where p.pronamespace in ('public'::regnamespace, 'private'::regnamespace) and p.prosrc ~ '\mdeputy_head\M')
          and (select count(*) >= 10 from pg_policies
               where schemaname = 'public' and coalesce(qual, '') || ' ' || coalesce(with_check, '') ~ '\mdeputy_head\M'),
  'head・deputy_head の守りの対象が空でない（段の配列を書いた関数 20 個以上、ポリシー 10 個以上。can_lead を呼ぶポリシーは数えない）');

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
          'distance_overrides','slots','deliveries','profiles','audit_logs','notices','notice_groups','events','v_remaining',
          'documents','document_submissions','document_files','v_document_status','v_document_files']) t, unnest(array['select']) p
        union all
        select format('%s %s', t, p) from unnest(array['rooms','items','room_years','distance_overrides','stocks','groups',
          'request_submissions','requests','rules','slots','deliveries','events',
          'documents']) t, unnest(array['insert','update','delete']) p),
  'authenticated の表の権限：全表の select と、W の 13 表（T18 の予定と締切、T19 の提出物を含む）の insert・update・delete だけ（RPC だけで書く表〔お知らせの2表、提出・ファイルを含む〕には書き込みの権限がない）');
select is_empty($$ select c.relname::text from pg_class c
                   where c.relnamespace = 'public'::regnamespace and c.relkind in ('r', 'v')
                     and (has_any_column_privilege('anon', c.oid, 'select') or has_any_column_privilege('anon', c.oid, 'insert')
                          or has_any_column_privilege('anon', c.oid, 'update')) $$,
  'anon は表・ビュー・列に何の権限もない');
-- お知らせ（T17）は RPC だけで書く：列の単位でも authenticated に insert・update の権限がない（表の単位は上の一覧）
select is_empty($$ select c.relname || ' ' || p.p from pg_class c
                   cross join unnest(array['insert', 'update', 'references']) as p(p)
                   where c.oid in ('public.notices'::regclass, 'public.notice_groups'::regclass)
                     and has_any_column_privilege('authenticated', c.oid, p.p) $$,
  'authenticated は notices・notice_groups のどの列にも insert・update（・references）の権限がない');
-- 提出とファイル（T19）も RPC だけで書く：列の単位でも authenticated に insert・update の権限がない
select is_empty($$ select c.relname || ' ' || p.p from pg_class c
                   cross join unnest(array['insert', 'update', 'references']) as p(p)
                   where c.oid in ('public.document_submissions'::regclass, 'public.document_files'::regclass)
                     and has_any_column_privilege('authenticated', c.oid, p.p) $$,
  'authenticated は document_submissions・document_files のどの列にも insert・update（・references）の権限がない');
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
          'request_submissions','requests','rules','deliveries','events',
          'documents']) t, unnest(array['SELECT','INSERT','UPDATE','DELETE']) c
        union all
        select format('%s SELECT', t) from unnest(array['years','year_roles','group_members','invitations','substitution_consents',
          'allocations','profiles','audit_logs','notices','notice_groups',
          'document_submissions','document_files']) t),
  'ポリシーは 64 個（W の 13 表は4操作、RPC だけで書く 12 表は select だけ。T17 でお知らせの2表、T18 で予定と締切の4つ、T19 で提出物の6つを足した）');
-- 予定と締切（T18）の書き込みは、その年度の部門長以上で年度が終了でないとき（can_lead。room_years・slots・deliveries と同じ）
select is((select string_agg(format('%s %s using=%s check=%s', policyname, cmd, coalesce(qual, '-'), coalesce(with_check, '-')), ' / ' order by policyname)
           from pg_policies where schemaname = 'public' and tablename = 'events' and cmd <> 'SELECT'),
  'events_delete DELETE using=private.can_lead(year_id) check=- / events_insert INSERT using=- check=private.can_lead(year_id) / '
  || 'events_update UPDATE using=private.can_lead(year_id) check=private.can_lead(year_id)',
  'events の書き込みのポリシーは3つとも can_lead(year_id)（部門長以上・終了でない年度）');
-- 提出物（T19）の書き込みも、その年度の部門長以上で年度が終了でないとき（can_lead。予定と締切と同じ）
select is((select string_agg(format('%s %s using=%s check=%s', policyname, cmd, coalesce(qual, '-'), coalesce(with_check, '-')), ' / ' order by policyname)
           from pg_policies where schemaname = 'public' and tablename = 'documents' and cmd <> 'SELECT'),
  'documents_delete DELETE using=private.can_lead(year_id) check=- / documents_insert INSERT using=- check=private.can_lead(year_id) / '
  || 'documents_update UPDATE using=private.can_lead(year_id) check=private.can_lead(year_id)',
  'documents の書き込みのポリシーは3つとも can_lead(year_id)（部門長以上・終了でない年度）');
-- Storage（T19）：storage.objects のポリシーは bucket documents の3つ（select・insert・delete）だけで、どれも to authenticated・permissive。
-- update のポリシーと anon 向けはない（上書き・移動・upsert はできない）。storage の表の権限（Supabase の既定）は変えない
select is((select string_agg(format('%s %s %s %s', policyname, cmd, array_to_string(roles, ','), permissive), ' / ' order by policyname)
           from pg_policies where schemaname = 'storage'),
  'documents_objects_delete DELETE authenticated PERMISSIVE / documents_objects_insert INSERT authenticated PERMISSIVE / '
  || 'documents_objects_select SELECT authenticated PERMISSIVE',
  'storage のポリシーは storage.objects の bucket documents の3つだけ（update と anon 向けはない）');
select ok((select bool_and(coalesce(qual, with_check) ~ '^\(\(bucket_id = ''documents''::text\) AND ')
           from pg_policies where schemaname = 'storage' and tablename = 'objects'),
  'storage.objects の3つのポリシーは、どれも bucket documents の物だけに効く（式の先頭で bucket を見る）');
select is((select format('%s %s', (qual is null)::text, with_check) from pg_policies where schemaname = 'storage' and policyname = 'documents_objects_insert'),
  'true ((bucket_id = ''documents''::text) AND (name IN ( SELECT private.my_document_upload_paths() AS my_document_upload_paths)))',
  'documents_objects_insert：予約した、今書ける提出の path だけ（with check。集合を1回作る形）');
select is((select format('%s %s', qual, (with_check is null)::text) from pg_policies where schemaname = 'storage' and policyname = 'documents_objects_delete'),
  '((bucket_id = ''documents''::text) AND (name IN ( SELECT private.my_document_orphan_paths() AS my_document_orphan_paths))) true',
  'documents_objects_delete：自分の範囲の、どの提出にも属さない物だけ（using。集合を1回作る形）');
select ok((select relrowsecurity from pg_class where oid = 'storage.objects'::regclass)
          and (select bool_and(has_table_privilege(r, 'storage.objects', p))
               from unnest(array['authenticated', 'anon']) r, unnest(array['select', 'insert', 'update', 'delete']) p),
  'storage.objects は RLS が有効で、authenticated・anon の表の権限は Supabase の既定のまま（ポリシーで守る）');
select is_empty($$ select format('%s %s head=%s deputy_head=%s', tablename, policyname,
                                 regexp_count(coalesce(qual, '') || ' ' || coalesce(with_check, ''), '\mhead\M'),
                                 regexp_count(coalesce(qual, '') || ' ' || coalesce(with_check, ''), '\mdeputy_head\M'))
                   from pg_policies
                   where schemaname = 'storage'
                     and regexp_count(coalesce(qual, '') || ' ' || coalesce(with_check, ''), '\mhead\M')
                         <> regexp_count(coalesce(qual, '') || ' ' || coalesce(with_check, ''), '\mdeputy_head\M') $$,
  'storage のポリシーの式でも、head と deputy_head はいつも組で出てくる（T19）');
select is_empty($$ select policyname::text from pg_policies where schemaname = 'public' and roles <> '{authenticated}' $$,
  'ポリシーはすべて to authenticated');
select is_empty($$ select policyname::text from pg_policies
                   where schemaname = 'public' and cmd = 'UPDATE' and (qual is null or with_check is null) $$,
  'update のポリシーはすべて using と with check の両方を持つ');

select * from finish();
rollback;
