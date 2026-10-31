-- 030_auth：auth.users のトリガー（profiles・招待の受け入れ）と Before User Created フック（T04、0007_auth.sql）
-- GoTrue（Google）は、ユーザーを email_confirmed_at が null のまま insert し、同じトランザクションで確認済みに update する
-- （notes/T04.md）。identity はその間に insert する。ここでは auth.users・auth.identities に直接書いて、2つの経路
-- （確認済みのユーザーに identity を足す＝seed・後の update で確認済み＝Google）と、email を他人のアドレスに変えたユーザーに
-- 招待が付かないこと（private.verified_email、D-17a）を確かめる。
-- フックは GoTrue が supabase_auth_admin で呼ぶ。テストでは関数に入力の JSON を渡して直接呼ぶ（GoTrue を通した確認は e2e/auth-hook.spec.ts）。
begin;
\ir _helpers/personas.psql
\ir _helpers/fixture.psql
select plan(90);

-- auth.users に直接ユーザーを入れ、続けて identity を入れる（GoTrue の代わり）。confirmed = false なら email_confirmed_at を null にする。
-- provider が google なら Google の identity（Google の経路）、email なら email_verified: true の email の identity（seed の経路）
create function tests.auth_insert(p_name text, p_email text, p_meta jsonb, p_confirmed boolean, p_deleted boolean default false,
                                  p_provider text default 'google')
returns uuid language plpgsql as $$
declare v_id uuid := gen_random_uuid();
begin
  insert into auth.users (instance_id, id, aud, role, email, encrypted_password, email_confirmed_at, deleted_at,
                          raw_app_meta_data, raw_user_meta_data, created_at, updated_at,
                          confirmation_token, recovery_token, email_change_token_new, email_change)
  values ('00000000-0000-0000-0000-000000000000', v_id, 'authenticated', 'authenticated', p_email, '',
          case when p_confirmed then now() end, case when p_deleted then now() end,
          jsonb_build_object('provider', p_provider, 'providers', jsonb_build_array(p_provider)), p_meta, now(), now(), '', '', '', '');
  insert into auth.identities (provider_id, user_id, identity_data, provider, created_at, updated_at)
  values (case when p_provider = 'google' then 'g-' || p_name else v_id::text end, v_id,
          jsonb_build_object('sub', case when p_provider = 'google' then 'g-' || p_name else v_id::text end,
                             'email', lower(p_email), 'email_verified', true),
          p_provider, now(), now());
  insert into tests.ids values (p_name, v_id);
  return v_id;
end $$;

create function tests.hook(p_provider text, p_email text, p_hd text default null) returns jsonb language sql as $$
  select private.hook_before_user_created(jsonb_build_object(
    'metadata', jsonb_build_object('name', 'before-user-created'),
    'user', jsonb_strip_nulls(jsonb_build_object(
      'email', p_email,
      'app_metadata', case when p_provider is not null
                           then jsonb_build_object('provider', p_provider, 'providers', jsonb_build_array(p_provider)) end,
      'user_metadata', case when p_hd is not null
                            then jsonb_build_object('custom_claims', jsonb_build_object('hd', p_hd)) end))))
$$;

-- ログインしている人から見える行数（RLS を通す。SECURITY INVOKER）
create function tests.count_visible(p_table text) returns bigint language plpgsql as $$
declare v bigint;
begin
  execute format('select count(*) from public.%I', p_table) into v;
  return v;
end $$;
grant execute on function tests.count_visible(text) to authenticated;

-- ================================================================ 関数とトリガーの形
select has_trigger('auth', 'users', 'on_auth_user_created', 'auth.users に insert のトリガー');
select has_trigger('auth', 'users', 'on_auth_user_confirmed', 'auth.users にメール確認のトリガー');
select has_trigger('auth', 'identities', 'on_auth_identity_created', 'auth.identities に insert のトリガー');
select ok((select prosecdef and proconfig @> array['search_path=""'] from pg_proc where oid = 'private.handle_identity_created()'::regprocedure),
  'handle_identity_created は SECURITY DEFINER・search_path = ""');
select ok((select prosecdef and proconfig @> array['search_path=""'] from pg_proc where oid = 'private.handle_new_user()'::regprocedure),
  'handle_new_user は SECURITY DEFINER・search_path = ""');
select ok((select prosecdef and proconfig @> array['search_path=""'] from pg_proc where oid = 'private.handle_user_confirmed()'::regprocedure),
  'handle_user_confirmed は SECURITY DEFINER・search_path = ""');
select ok((select not prosecdef and proconfig @> array['search_path=""'] from pg_proc
           where oid = 'private.hook_before_user_created(jsonb)'::regprocedure),
  'フックは SECURITY DEFINER にしない（表を読まない）・search_path = ""');
select ok(has_function_privilege('supabase_auth_admin', 'private.hook_before_user_created(jsonb)', 'execute')
          and has_schema_privilege('supabase_auth_admin', 'private', 'usage'),
  'supabase_auth_admin はフックを実行できる');
select ok(not has_function_privilege('authenticated', 'private.hook_before_user_created(jsonb)', 'execute')
          and not has_function_privilege('anon', 'private.hook_before_user_created(jsonb)', 'execute'),
  'authenticated・anon はフックを実行できない');
select ok((select not prosecdef and provolatile = 's' and proconfig @> array['search_path=""'] from pg_proc
           where oid = 'private.school_domain()'::regprocedure),
  'school_domain は SECURITY DEFINER にしない・STABLE・search_path = ""');
select ok(has_function_privilege('supabase_auth_admin', 'private.school_domain()', 'execute')
          and not has_function_privilege('authenticated', 'private.school_domain()', 'execute')
          and not has_function_privilege('anon', 'private.school_domain()', 'execute'),
  'school_domain は supabase_auth_admin（フックが呼ぶ）だけが実行でき、authenticated・anon は実行できない');
select ok(not has_function_privilege('authenticated', 'private.handle_new_user()', 'execute')
          and not has_function_privilege('authenticated', 'private.handle_user_confirmed()', 'execute')
          and not has_function_privilege('authenticated', 'private.handle_identity_created()', 'execute')
          and not has_function_privilege('authenticated', 'private.accept_invitations_of(uuid, text)', 'execute')
          and not has_function_privilege('authenticated', 'private.verified_email(uuid)', 'execute'),
  'authenticated はトリガー関数と招待の受け入れの関数を実行できない');
select tests.login_as('outsider');
select throws_ok($$ select private.hook_before_user_created('{}') $$, '42501', null, 'ログインした人がフックを呼ぶと 42501');
select throws_ok($$ select private.accept_invitations_of(tests.id('outsider'), 'admin@pgtap.test') $$, '42501', null,
  'ログインした人が他人のメールで招待を受け入れる関数を呼ぶと 42501');
select tests.logout();

-- ================================================================ profiles
select tests.auth_insert('p_full', 'p_full@pgtap.test', '{"full_name": "  山田 花子  ", "name": "別名"}', true);
select tests.auth_insert('p_name', 'p_name@pgtap.test', '{"name": "名前だけ"}', true);
select tests.auth_insert('p_none', 'gakuseki12345@pgtap.test', '{}', true);
select tests.auth_insert('p_long', 'p_long@pgtap.test', jsonb_build_object('full_name', repeat('長', 150)), true);
select tests.auth_insert('p_blank', 'p_blank@pgtap.test', '{"full_name": "  ", "name": ""}', false);
select is((select display_name from public.profiles where user_id = tests.id('p_full')), '山田 花子', '表示名は full_name（前後の空白を除く）');
select is((select display_name from public.profiles where user_id = tests.id('p_name')), '名前だけ', 'full_name がなければ name');
select is((select display_name from public.profiles where user_id = tests.id('p_none')), '名前未設定', 'どちらもなければ「名前未設定」（メールからは作らない）');
select is((select length(display_name) from public.profiles where user_id = tests.id('p_long')), 100, '100 字に切り詰める');
select is((select display_name from public.profiles where user_id = tests.id('p_blank')), '名前未設定', '空白だけの名前は使わない。未確認でも profiles はできる');

-- ================================================================ 招待の受け入れ
-- 招待を用意する（Y1 の staff、G1・G2 の代表。メールは大文字が混じっても小文字で比べる）。
-- g_new は同じ年度（Y1）の staff の招待と団体（G2）の招待を持つ（T15 より前の 4 引数の invite は一度に作れた）。兼任の禁止（D-49）で
-- 片方しか付かない。同じ時刻の招待はロールの招待を先に受け入れるので、staff が付いて団体の招待は残る
insert into public.invitations (year_id, email, role) values
  (tests.id('Y1'), 'g_new@pgtap.test', 'staff'),
  (tests.id('Y1'), 'seed_path@pgtap.test', 'viewer'),
  (tests.id('Y1'), 'unconf@pgtap.test', 'staff'),
  (tests.id('Y1'), 'deleted@pgtap.test', 'staff'),
  (tests.id('Y1'), 'mixed@pgtap.test', 'viewer');
insert into public.invitations (year_id, email, group_id, group_role) values
  (tests.id('Y1'), 'g_new@pgtap.test', tests.id('G2'), 'manager'),
  (tests.id('Y1'), 'seed_path@pgtap.test', tests.id('G1'), 'deputy_manager');

-- (1) Google の経路：未確認で insert → 同じトランザクションで確認済みに update
select tests.auth_insert('g_new', 'g_new@pgtap.test', '{"full_name": "グーグル 太郎"}', false);
select is((select count(*)::int from public.year_roles where user_id = tests.id('g_new')), 0, 'insert の時点（未確認）ではロールを付けない');
select is((select count(*)::int from public.invitations where email = 'g_new@pgtap.test' and used_at is null), 2, '招待は未使用のまま');
select lives_ok($$ update auth.users set email_confirmed_at = now() where id = tests.id('g_new') $$,
  '兼任になる招待があっても、初回ログイン（メールの確認。GoTrue のトランザクション）は失敗しない（例外を出さない）');
select is((select role from public.year_roles where year_id = tests.id('Y1') and user_id = tests.id('g_new')), 'staff'::public.app_role,
  '初回ログイン（メールの確認）で招待どおりの year_roles ができる（同じ時刻ならロールの招待が先）');
select ok(not exists (select 1 from public.group_members where user_id = tests.id('g_new')),
  '同じ年度の staff と兼任になる団体（G2）の招待からは group_members を作らない');
select is((select count(*)::int from public.invitations where email = 'g_new@pgtap.test' and used_at is not null and role = 'staff'), 1,
  'staff の招待は使用済みになる');
select ok((select used_at is null from public.invitations where email = 'g_new@pgtap.test' and group_id is not null),
  '兼任になる団体の招待は未使用のまま残る（管理者の画面で見える）');
select is((select reason from public.audit_logs where table_name = 'year_roles' and row_pk ->> 'user_id' = tests.id('g_new')::text),
  '招待の受け入れ', '監査に「招待の受け入れ」と残る');
select is(nullif(current_setting('app.reason', true), ''), null, '受け入れの後、トランザクションの理由は元に戻る（後の書き込みに残らない）');
update auth.users set email_confirmed_at = now() + interval '1 second' where id = tests.id('g_new');
select is((select count(*)::int from public.year_roles where user_id = tests.id('g_new')), 1, '確認済みのまま更新しても、もう一度は動かない');

-- (2) seed の経路：確認済みで insert し、email_verified: true の email の identity を足す（大文字の混じったメール）
select tests.auth_insert('seed_path', 'Seed_Path@PGTAP.test', '{}', true, false, 'email');
select is((select role from public.year_roles where year_id = tests.id('Y1') and user_id = tests.id('seed_path')), 'viewer'::public.app_role,
  '確認済みのユーザーに identity が足されたら、その場で招待を受け入れる（メールは小文字で比べる）');
select ok(exists (select 1 from public.group_members where group_id = tests.id('G1') and user_id = tests.id('seed_path')),
  'ロールと団体代表の両方の招待を受け入れる（viewer は団体代表を兼ねられる）');
select is((select role from public.group_members where group_id = tests.id('G1') and user_id = tests.id('seed_path')),
  'deputy_manager'::public.group_role, '団体の招待の立場（副店長）で group_members ができる');

-- (2b) Google の経路で、立場と年度：Y1 の G2 の副店長の招待と、Y2 の staff の招待（違う年度なので兼ねてよい）
insert into public.invitations (year_id, email, role) values (tests.id('Y2'), 'g_dep@pgtap.test', 'staff');
insert into public.invitations (year_id, email, group_id, group_role) values (tests.id('Y1'), 'g_dep@pgtap.test', tests.id('G2'), 'deputy_manager');
select tests.auth_insert('g_dep', 'g_dep@pgtap.test', '{}', false);
select lives_ok($$ update auth.users set email_confirmed_at = now() where id = tests.id('g_dep') $$, '初回ログイン（Google の経路）');
select is((select role from public.group_members where group_id = tests.id('G2') and user_id = tests.id('g_dep')),
  'deputy_manager'::public.group_role, 'Google の経路でも、団体の招待の立場（副店長）で group_members ができる');
select is((select role from public.year_roles where year_id = tests.id('Y2') and user_id = tests.id('g_dep')), 'staff'::public.app_role,
  '違う年度（Y2）の staff の招待も付く（兼任の禁止は年度ごと）');
select is((select count(*)::int from public.invitations where email = 'g_dep@pgtap.test' and used_at is not null), 2, '2つの招待とも使用済み');

-- (2c) すでに団体代表（Y1 の G1 の店長）の人の、同じ年度の staff の招待：初回ログインは失敗せず、招待は未使用のまま
select tests.auth_insert('g_rep', 'g_rep@pgtap.test', '{}', false);
insert into public.group_members (group_id, user_id, role) values (tests.id('G1'), tests.id('g_rep'), 'manager');
insert into public.invitations (year_id, email, role) values (tests.id('Y1'), 'g_rep@pgtap.test', 'staff');
select lives_ok($$ update auth.users set email_confirmed_at = now() where id = tests.id('g_rep') $$,
  '団体代表の人に同じ年度の staff の招待があっても、初回ログインは失敗しない');
select is((select count(*)::int from public.year_roles where user_id = tests.id('g_rep')), 0, '兼任になる staff は付かない');
select ok((select used_at is null from public.invitations where email = 'g_rep@pgtap.test'), 'staff の招待は未使用のまま');
select tests.login_as('g_rep');
select is(public.accept_my_invitations(), 0, '次のログインの accept_my_invitations も0件（例外を出さない）');
select tests.logout();

-- (2d) 副店長の人への同じ団体の店長の招待：立場は変えず（変えるのは set_group_member_role）、招待は未使用のまま
select tests.auth_insert('g_pos', 'g_pos@pgtap.test', '{}', false);
insert into public.group_members (group_id, user_id, role) values (tests.id('G2'), tests.id('g_pos'), 'deputy_manager');
insert into public.invitations (year_id, email, group_id, group_role) values (tests.id('Y1'), 'g_pos@pgtap.test', tests.id('G2'), 'manager');
select lives_ok($$ update auth.users set email_confirmed_at = now() where id = tests.id('g_pos') $$,
  '別の立場の招待があっても、初回ログインは失敗しない');
select is((select role from public.group_members where group_id = tests.id('G2') and user_id = tests.id('g_pos')),
  'deputy_manager'::public.group_role, '立場は副店長のまま');
select ok((select used_at is null from public.invitations where email = 'g_pos@pgtap.test'), '別の立場の団体の招待は未使用のまま');

-- (3) 未確認のまま（メールのサインアップで他人のメールを名乗った登録）には付けない
select tests.auth_insert('unconf', 'unconf@pgtap.test', '{}', false);
select is((select count(*)::int from public.year_roles where user_id = tests.id('unconf')), 0, '未確認のアカウントには招待を付けない');
select tests.login_as('unconf');
select is(public.accept_my_invitations(), 0, '未確認なら accept_my_invitations も0件');
select tests.logout();
-- 確認済みでも削除済みのアカウントには付けない
select tests.auth_insert('deleted', 'deleted@pgtap.test', '{}', true, true);
select is((select count(*)::int from public.year_roles where user_id = tests.id('deleted')), 0, '削除済みのアカウントには招待を付けない');

-- (4) すでにロールがあれば上書きしない（別のロールなら招待は使用済みにせず残す。0009、T03 のマージの後の直し）
insert into public.year_roles (year_id, user_id, role)
  select tests.id('Y1'), tests.auth_insert('mixed', 'mixed@pgtap.test', '{}', false), 'admin';
update auth.users set email_confirmed_at = now() where id = tests.id('mixed');
select is((select role from public.year_roles where year_id = tests.id('Y1') and user_id = tests.id('mixed')), 'admin'::public.app_role,
  'すでにあるロールは招待で上書きしない');
select ok((select used_at is null from public.invitations where email = 'mixed@pgtap.test'),
  '別のロールの招待は使用済みにせず残す（ロールを変えるなら管理者が set_role で変えるか、招待を取り消す）');

-- (5) closed の年度の招待は受け入れない
insert into public.invitations (year_id, email, role) values (tests.id('Y1'), 'closed_y@pgtap.test', 'staff');
select tests.set_scenario('closed');
select tests.auth_insert('closed_y', 'closed_y@pgtap.test', '{}', true);
select is((select count(*)::int from public.year_roles where user_id = tests.id('closed_y')), 0, 'closed の年度の招待は受け入れない');
select ok((select used_at is null from public.invitations where email = 'closed_y@pgtap.test'), 'closed の年度の招待は未使用のまま');
select tests.set_scenario('requesting');

-- (5b) email を他人のアドレスに変えたユーザーには、その人あての招待が付かない（D-17a）
-- email_confirmed_at は最初の確認の時刻のまま残る。メールの変更に確認が要らない設定（や SQL・管理 API での変更）で、
-- auth.users.email だけが招待された人のアドレスに変わった状態を作る
insert into public.invitations (year_id, email, role) values (tests.id('Y1'), 'victim@pgtap.test', 'admin');
insert into public.invitations (year_id, email, group_id, group_role) values (tests.id('Y1'), 'victim@pgtap.test', tests.id('G1'), 'manager');
-- Google のユーザー：Google の identity のメールは自分のまま
select tests.auth_insert('sw_google', 'sw_google@pgtap.test', '{}', false);
update auth.users set email_confirmed_at = now() where id = tests.id('sw_google');
update auth.users set email = 'victim@pgtap.test' where id = tests.id('sw_google');
select tests.login_as('sw_google');
select is(public.accept_my_invitations(), 0, 'email を他人のアドレスに変えた Google のユーザーは、その人あての招待を受け入れられない');
select tests.logout();
select tests.login_as('admin');
select is((public.invite(tests.id('Y1'), 'victim@pgtap.test', 'admin') ->> 'applied')::boolean, false,
  'invite も、email を変えただけのアカウントにはその場で付けない');
select tests.logout();
select is((select count(*)::int from public.year_roles where user_id = tests.id('sw_google'))
          + (select count(*)::int from public.group_members where user_id = tests.id('sw_google')), 0,
  'email を変えた Google のユーザーには、admin の招待も団体代表の招待も付かない');
select is((select count(*)::int from public.invitations where email = 'victim@pgtap.test' and used_at is null), 2, 'その招待は未使用のまま');
update auth.users set email = 'sw_google@pgtap.test' where id = tests.id('sw_google');   -- 元に戻す（email は一意）
-- メールの identity（seed の形）：identity のメールは自分のまま、または変えたアドレスでも email_verified でない
select tests.auth_insert('sw_email', 'sw_email@pgtap.test', '{}', true, false, 'email');
update auth.users set email = 'victim@pgtap.test' where id = tests.id('sw_email');
select tests.login_as('sw_email');
select is(public.accept_my_invitations(), 0, 'email の identity のメールが元のままなら受け入れない');
select tests.logout();
update auth.identities set identity_data = identity_data || '{"email": "victim@pgtap.test", "email_verified": false}'
where user_id = tests.id('sw_email');
select tests.login_as('sw_email');
select is(public.accept_my_invitations(), 0, 'email の identity のメールが変わっても、email_verified でなければ受け入れない');
select tests.logout();
-- 本人のメールでも、メールの変更の途中（email_change が空でない）は受け入れない
insert into public.invitations (year_id, email, role) values (tests.id('Y1'), 'pending@pgtap.test', 'viewer');
select tests.auth_insert('pending', 'pending@pgtap.test', '{}', false);
update auth.users set email_change = 'other@pgtap.test' where id = tests.id('pending');
update auth.users set email_confirmed_at = now() where id = tests.id('pending');
select is((select count(*)::int from public.year_roles where user_id = tests.id('pending')), 0, 'メールの変更の途中なら、確認のトリガーでも受け入れない');
update auth.users set email_change = '' where id = tests.id('pending');
select tests.login_as('pending');
select is(public.accept_my_invitations(), 1, '変更が終われば（取り消されれば）、ログイン時に受け入れる');
select tests.logout();
-- 受信箱で確かめた変更（GoTrue は email の identity を新しいアドレスと email_verified: true に書き換える）なら受け入れる
update auth.identities set identity_data = identity_data || '{"email": "victim@pgtap.test", "email_verified": true}'
where user_id = tests.id('sw_email');
select tests.login_as('sw_email');
select is(public.accept_my_invitations(), 2, '新しいアドレスを受信箱で確かめた変更なら、そのアドレスあての招待を受け入れる');
select tests.logout();
select is((select role from public.year_roles where year_id = tests.id('Y1') and user_id = tests.id('sw_email')), 'admin'::public.app_role,
  '確かめたアドレスの持ち主に招待のロールが付く');

-- (6) 招待のない人：profiles だけができ、何も読めない
select tests.auth_insert('nobody', 'nobody@pgtap.test', '{"full_name": "招待なし"}', false);
update auth.users set email_confirmed_at = now() where id = tests.id('nobody');
select is((select count(*)::int from public.year_roles where user_id = tests.id('nobody'))
          + (select count(*)::int from public.group_members where user_id = tests.id('nobody')), 0, '招待のない人にはロールも団体代表も付かない');
select tests.login_as('nobody');
select is(public.accept_my_invitations(), 0, '招待のない人の accept_my_invitations は0件');
select is((select count(*)::int from public.profiles), 1, '招待のない人が読める profiles は自分の行だけ');
select is((select display_name from public.profiles), '招待なし', '自分の表示名は読める');
select is_empty($$ select t from unnest(array['years','rooms','room_years','items','stocks','groups','year_roles','group_members',
                     'invitations','request_submissions','requests','rules','substitution_consents','allocations',
                     'distance_overrides','slots','deliveries','audit_logs','v_remaining']) t
                   where tests.count_visible(t) > 0 $$,
  '招待のない人は、profiles の自分の行のほかに何も読めない（全表と v_remaining が0行）');
select tests.logout();
-- 同じ人をあとから招待すると、その場でロールが付き、読めるようになる
select tests.login_as('admin');
select is((public.invite(tests.id('Y1'), 'NoBody@pgtap.test', 'viewer') ->> 'applied')::boolean, true, '確認済みのアカウントへの招待はその場で付く');
select tests.logout();
select tests.login_as('nobody');
select is((select count(*)::int from public.years where id = tests.id('Y1')), 1, '招待された年度を読めるようになる');
select tests.logout();

-- ================================================================ seed のテストユーザー（D-02）
-- seed は auth.users・auth.identities に直接入れる（フックを通らない）。identity の追加のトリガーでロールが付く
select is((select string_agg(coalesce(yr.role::text, case when gm.user_id is not null then 'rep' else 'none' end), ',' order by u.id)
           from auth.users u
           left join public.year_roles yr on yr.user_id = u.id and yr.year_id = '00000000-0000-4000-8000-0000000000a1'
           left join public.group_members gm on gm.user_id = u.id and gm.group_id = '00000000-0000-4000-8000-0000000000b1'
           where u.id between '00000000-0000-4000-8000-000000000001' and '00000000-0000-4000-8000-000000000005'),
  'admin,staff,rep,viewer,none', 'seed のテストユーザー（@example.test）は、招待からトリガーでロールが付く（未招待は何もない）');
select is((select count(*)::int from public.profiles
           where user_id between '00000000-0000-4000-8000-000000000001' and '00000000-0000-4000-8000-000000000005'), 5,
  'seed のテストユーザーの profiles はトリガーが作る');
select ok((select bool_and(i.provider = 'email' and u.encrypted_password like '$2%') from auth.users u join auth.identities i on i.user_id = u.id
           where u.id between '00000000-0000-4000-8000-000000000001' and '00000000-0000-4000-8000-000000000005'),
  'seed のテストユーザーはメールとパスワードでログインできる形（identities あり、bcrypt）');

-- ================================================================ Before User Created フック
-- 本番の値（D-04）。実在のドメインのメールアドレスはテストに書かない（公開リポジトリ。実在の人のアドレスと重なるおそれ）ので、
-- ドメインの値とフックがそれを使うことだけを確かめ、判定はこのトランザクションの中で school_domain を予約済みのドメイン
-- school.example を返すものに置き換えてから確かめる（最後の rollback で元に戻る）。
select is(private.school_domain(), 'g.kumamoto-nct.ac.jp', '学校のドメインは g.kumamoto-nct.ac.jp（D-04）');
select ok((select prosrc ~ 'private\.school_domain\(\)' from pg_proc where oid = 'private.hook_before_user_created(jsonb)'::regprocedure),
  'フックは許可するドメインを school_domain から取る');
select ok(tests.hook('google', 'taro@school.example') ? 'error', '置き換える前は、予約済みのドメイン（school.example）は学校のドメインではないので拒否');
create or replace function private.school_domain()
returns text language sql stable set search_path = '' as $$ select 'school.example'::text $$;
-- 許可（{}）
select is(tests.hook('google', 'taro@school.example'), '{}'::jsonb, 'Google・学校のドメイン・hd なし（userinfo の経路）は許可');
select is(tests.hook('google', 'taro@school.example', 'school.example'), '{}'::jsonb, 'Google・学校のドメイン・hd も学校は許可');
select is(tests.hook('google', 'Taro@School.EXAMPLE', 'SCHOOL.example'), '{}'::jsonb, '大文字が混じっても小文字で比べる');
-- 拒否（403）
select is(tests.hook('google', 'taro@gmail.example') -> 'error' ->> 'http_code', '403', '学校以外のドメインは 403');
select is(tests.hook('google', 'taro@gmail.example') -> 'error' ->> 'message', '学校の Google アカウントでログインしてください', '拒否の文言');
select ok(tests.hook('google', 'taro@school.example', 'other.example') ? 'error', 'hd が学校でなければ、メールが学校のドメインでも拒否');
select ok(tests.hook('google', 'taro@other.example', 'school.example') ? 'error', 'hd が学校でも、メールが学校のドメインでなければ拒否');
select ok(tests.hook('google', 'taro@sub.school.example') ? 'error', 'サブドメインは拒否（完全一致）');
select ok(tests.hook('google', 'taro@school.example.evil.example') ? 'error', '学校のドメインで始まるだけのドメインは拒否');
select ok(tests.hook('google', 'a@b@school.example') ? 'error', '@ が2つあるメールは拒否');
select ok(tests.hook('google', null) ? 'error', 'メールがなければ拒否');
select ok(tests.hook('email', 'taro@school.example') ? 'error', 'メールのサインアップは学校のドメインでも拒否（本番でメールログインを無効にし忘れたときの守り）');
select ok(tests.hook(null, 'taro@school.example') ? 'error', 'プロバイダーがなければ拒否');
select ok(tests.hook('github', 'taro@school.example') ? 'error', 'Google 以外のプロバイダーは拒否');
-- テスト用のドメイン（@example.test・@pgtap.test）は、GoTrue を通しては作れない（seed・pgTAP の直接の insert だけ）
select ok(tests.hook('email', 'admin@example.test') ? 'error', 'テスト用のドメイン（example.test）のメールのサインアップは拒否');
select ok(tests.hook('google', 'admin@example.test') ? 'error', 'テスト用のドメインは Google でも拒否');
select ok(private.hook_before_user_created('{}') ? 'error', '空の入力は拒否');

select * from finish();
rollback;
