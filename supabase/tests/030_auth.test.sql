-- 030_auth：auth.users のトリガー（profiles・招待の受け入れ）と Before User Created フック（T04、0007_auth.sql）
-- GoTrue（Google）は、ユーザーを email_confirmed_at が null のまま insert し、同じトランザクションで確認済みに update する
-- （notes/T04.md）。ここでは auth.users に直接書いて、その2つの経路（insert で確認済み・後の update で確認済み）を確かめる。
-- フックは GoTrue が supabase_auth_admin で呼ぶ。テストでは関数に入力の JSON を渡して直接呼ぶ（GoTrue を通した確認は e2e/auth-hook.spec.ts）。
begin;
\ir _helpers/personas.psql
\ir _helpers/fixture.psql
select plan(59);

-- auth.users に直接ユーザーを入れる（GoTrue の代わり）。confirmed = false なら email_confirmed_at を null にする
create function tests.auth_insert(p_name text, p_email text, p_meta jsonb, p_confirmed boolean, p_deleted boolean default false)
returns uuid language plpgsql as $$
declare v_id uuid := gen_random_uuid();
begin
  insert into auth.users (instance_id, id, aud, role, email, encrypted_password, email_confirmed_at, deleted_at,
                          raw_app_meta_data, raw_user_meta_data, created_at, updated_at,
                          confirmation_token, recovery_token, email_change_token_new, email_change)
  values ('00000000-0000-0000-0000-000000000000', v_id, 'authenticated', 'authenticated', p_email, '',
          case when p_confirmed then now() end, case when p_deleted then now() end,
          '{"provider":"google","providers":["google"]}', p_meta, now(), now(), '', '', '', '');
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
select ok(not has_function_privilege('authenticated', 'private.handle_new_user()', 'execute')
          and not has_function_privilege('authenticated', 'private.handle_user_confirmed()', 'execute')
          and not has_function_privilege('authenticated', 'private.accept_invitations_of(uuid, text)', 'execute'),
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
-- 招待を用意する（Y1 の staff、G1・G2 の代表。メールは大文字が混じっても小文字で比べる）
insert into public.invitations (year_id, email, role) values
  (tests.id('Y1'), 'g_new@pgtap.test', 'staff'),
  (tests.id('Y1'), 'seed_path@pgtap.test', 'viewer'),
  (tests.id('Y1'), 'unconf@pgtap.test', 'staff'),
  (tests.id('Y1'), 'deleted@pgtap.test', 'staff'),
  (tests.id('Y1'), 'mixed@pgtap.test', 'viewer');
insert into public.invitations (year_id, email, group_id) values
  (tests.id('Y1'), 'g_new@pgtap.test', tests.id('G2')),
  (tests.id('Y1'), 'seed_path@pgtap.test', tests.id('G1'));

-- (1) Google の経路：未確認で insert → 同じトランザクションで確認済みに update
select tests.auth_insert('g_new', 'g_new@pgtap.test', '{"full_name": "グーグル 太郎"}', false);
select is((select count(*)::int from public.year_roles where user_id = tests.id('g_new')), 0, 'insert の時点（未確認）ではロールを付けない');
select is((select count(*)::int from public.invitations where email = 'g_new@pgtap.test' and used_at is null), 2, '招待は未使用のまま');
update auth.users set email_confirmed_at = now() where id = tests.id('g_new');
select is((select role from public.year_roles where year_id = tests.id('Y1') and user_id = tests.id('g_new')), 'staff'::public.app_role,
  '初回ログイン（メールの確認）で招待どおりの year_roles ができる');
select ok(exists (select 1 from public.group_members where group_id = tests.id('G2') and user_id = tests.id('g_new')),
  '団体代表の招待から group_members ができる');
select is((select count(*)::int from public.invitations where email = 'g_new@pgtap.test' and used_at is not null), 2, '招待は使用済みになる');
select is((select reason from public.audit_logs where table_name = 'year_roles' and row_pk ->> 'user_id' = tests.id('g_new')::text),
  '招待の受け入れ', '監査に「招待の受け入れ」と残る');
select is(nullif(current_setting('app.reason', true), ''), null, '受け入れの後、トランザクションの理由は元に戻る（後の書き込みに残らない）');
update auth.users set email_confirmed_at = now() + interval '1 second' where id = tests.id('g_new');
select is((select count(*)::int from public.year_roles where user_id = tests.id('g_new')), 1, '確認済みのまま更新しても、もう一度は動かない');

-- (2) seed の経路：確認済みで insert（大文字の混じったメール）
select tests.auth_insert('seed_path', 'Seed_Path@PGTAP.test', '{}', true);
select is((select role from public.year_roles where year_id = tests.id('Y1') and user_id = tests.id('seed_path')), 'viewer'::public.app_role,
  '確認済みで insert されたら、その場で招待を受け入れる（メールは小文字で比べる）');
select ok(exists (select 1 from public.group_members where group_id = tests.id('G1') and user_id = tests.id('seed_path')),
  'ロールと団体代表の両方の招待を受け入れる');

-- (3) 未確認のまま（メールのサインアップで他人のメールを名乗った登録）には付けない
select tests.auth_insert('unconf', 'unconf@pgtap.test', '{}', false);
select is((select count(*)::int from public.year_roles where user_id = tests.id('unconf')), 0, '未確認のアカウントには招待を付けない');
select tests.login_as('unconf');
select is(public.accept_my_invitations(), 0, '未確認なら accept_my_invitations も0件');
select tests.logout();
-- 確認済みでも削除済みのアカウントには付けない
select tests.auth_insert('deleted', 'deleted@pgtap.test', '{}', true, true);
select is((select count(*)::int from public.year_roles where user_id = tests.id('deleted')), 0, '削除済みのアカウントには招待を付けない');

-- (4) すでにロールがあれば上書きしない（招待は使用済みにする）
insert into public.year_roles (year_id, user_id, role)
  select tests.id('Y1'), tests.auth_insert('mixed', 'mixed@pgtap.test', '{}', false), 'admin';
update auth.users set email_confirmed_at = now() where id = tests.id('mixed');
select is((select role from public.year_roles where year_id = tests.id('Y1') and user_id = tests.id('mixed')), 'admin'::public.app_role,
  'すでにあるロールは招待で上書きしない');
select ok((select used_at is not null from public.invitations where email = 'mixed@pgtap.test'), 'その招待は使用済みになる');

-- (5) closed の年度の招待は受け入れない
insert into public.invitations (year_id, email, role) values (tests.id('Y1'), 'closed_y@pgtap.test', 'staff');
select tests.set_scenario('closed');
select tests.auth_insert('closed_y', 'closed_y@pgtap.test', '{}', true);
select is((select count(*)::int from public.year_roles where user_id = tests.id('closed_y')), 0, 'closed の年度の招待は受け入れない');
select ok((select used_at is null from public.invitations where email = 'closed_y@pgtap.test'), 'closed の年度の招待は未使用のまま');
select tests.set_scenario('requesting');

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
-- seed は auth.users に直接入れる（フックを通らない）。トリガーでロールが付き、本番と同じ経路を通る
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
-- 許可（{}）
select is(tests.hook('google', 'taro@example.ac.jp'), '{}'::jsonb, 'Google・学校のドメイン・hd なし（userinfo の経路）は許可');
select is(tests.hook('google', 'taro@example.ac.jp', 'example.ac.jp'), '{}'::jsonb, 'Google・学校のドメイン・hd も学校は許可');
select is(tests.hook('google', 'Taro@Example.AC.jp', 'EXAMPLE.ac.jp'), '{}'::jsonb, '大文字が混じっても小文字で比べる');
-- 拒否（403）
select is(tests.hook('google', 'taro@gmail.example') -> 'error' ->> 'http_code', '403', '学校以外のドメインは 403');
select is(tests.hook('google', 'taro@gmail.example') -> 'error' ->> 'message', '学校の Google アカウントでログインしてください', '拒否の文言');
select ok(tests.hook('google', 'taro@example.ac.jp', 'other.example') ? 'error', 'hd が学校でなければ、メールが学校のドメインでも拒否');
select ok(tests.hook('google', 'taro@other.example', 'example.ac.jp') ? 'error', 'hd が学校でも、メールが学校のドメインでなければ拒否');
select ok(tests.hook('google', 'taro@sub.example.ac.jp') ? 'error', 'サブドメインは拒否（完全一致）');
select ok(tests.hook('google', 'taro@example.ac.jp.evil.example') ? 'error', '学校のドメインで始まるだけのドメインは拒否');
select ok(tests.hook('google', 'a@b@example.ac.jp') ? 'error', '@ が2つあるメールは拒否');
select ok(tests.hook('google', null) ? 'error', 'メールがなければ拒否');
select ok(tests.hook('email', 'taro@example.ac.jp') ? 'error', 'メールのサインアップは学校のドメインでも拒否（本番でメールログインを無効にし忘れたときの守り）');
select ok(tests.hook(null, 'taro@example.ac.jp') ? 'error', 'プロバイダーがなければ拒否');
select ok(tests.hook('github', 'taro@example.ac.jp') ? 'error', 'Google 以外のプロバイダーは拒否');
-- テスト用のドメイン（@example.test・@pgtap.test）は、GoTrue を通しては作れない（seed・pgTAP の直接の insert だけ）
select ok(tests.hook('email', 'admin@example.test') ? 'error', 'テスト用のドメイン（example.test）のメールのサインアップは拒否');
select ok(tests.hook('google', 'admin@example.test') ? 'error', 'テスト用のドメインは Google でも拒否');
select ok(private.hook_before_user_created('{}') ? 'error', '空の入力は拒否');

select * from finish();
rollback;
