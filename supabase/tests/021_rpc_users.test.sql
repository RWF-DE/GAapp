-- 021_rpc_users：invite、set_role、remove_role、revoke_invitation、remove_group_member、accept_my_invitations（T03）
-- auth.users のトリガー（0007）とフックは 030_auth（T04）で確かめる。ここでは RPC の中での招待の受け入れを確かめる。
-- 招待を付けるのは、今のメールが本人のものと確かめられるアカウントだけ（private.verified_email、D-17a）。
begin;
\ir _helpers/personas.psql
\ir _helpers/fixture.psql
select plan(185);

-- auth.users に直接ユーザーを入れ、続けて identity を入れる（GoTrue の代わり）。メールは <name>@pgtap.test。
-- provider が google なら Google の identity、email なら email_verified: true の email の identity
create function tests.user_with_identity(p_name text, p_provider text) returns uuid language plpgsql as $$
declare
  v_id uuid := gen_random_uuid();
  v_sub text := case when p_provider = 'google' then 'g-' || p_name else v_id::text end;
begin
  insert into auth.users (instance_id, id, aud, role, email, encrypted_password, email_confirmed_at,
                          raw_app_meta_data, raw_user_meta_data, created_at, updated_at,
                          confirmation_token, recovery_token, email_change_token_new, email_change)
  values ('00000000-0000-0000-0000-000000000000', v_id, 'authenticated', 'authenticated', p_name || '@pgtap.test', '', now(),
          jsonb_build_object('provider', p_provider, 'providers', jsonb_build_array(p_provider)), '{}', now(), now(), '', '', '', '');
  insert into auth.identities (provider_id, user_id, identity_data, provider, created_at, updated_at)
  values (v_sub, v_id, jsonb_build_object('sub', v_sub, 'email', p_name || '@pgtap.test', 'email_verified', true), p_provider, now(), now());
  insert into tests.ids values (p_name, v_id);
  return v_id;
end $$;

-- ================================================================ invite
select tests.login_anon();
select throws_ok($$ select public.invite(tests.id('Y1'), 'a@pgtap.test', 'viewer') $$, '42501', null, 'anon は招待できない');
select tests.logout();
select tests.login_as('staff');
select throws_ok($$ select public.invite(tests.id('Y1'), 'a@pgtap.test', 'viewer') $$, 'P0001', 'forbidden', 'staff は招待できない');
select tests.logout();
select tests.login_as('rep');
select throws_ok($$ select public.invite(tests.id('Y1'), 'a@pgtap.test', null, tests.id('G1')) $$, 'P0001', 'forbidden', '団体代表は招待できない');
select tests.logout();
select tests.login_as('admin2');
select throws_ok($$ select public.invite(tests.id('Y1'), 'a@pgtap.test', 'viewer') $$, 'P0001', 'forbidden', '別の年度の admin は招待できない');
select tests.logout();

select tests.login_as('admin');
select throws_ok($$ select public.invite(tests.id('Y1'), 'not-an-email', 'viewer') $$, 'P0001', 'invalid_input', 'メールの形でなければ invalid_input');
select throws_ok($$ select public.invite(tests.id('Y1'), null, 'viewer') $$, 'P0001', 'invalid_input', 'メールが空なら invalid_input');
select throws_ok(format($$ select public.invite(%L, %L, 'viewer') $$, tests.id('Y1'), repeat('a', 250) || '@pgtap.test'), 'P0001', 'invalid_input', 'メールは 254 字まで');
select throws_ok($$ select public.invite(tests.id('Y1'), 'a@pgtap.test') $$, 'P0001', 'invalid_input', 'ロールも団体もなければ invalid_input');
select throws_ok($$ select public.invite(tests.id('Y1'), 'a@pgtap.test', null, tests.id('G3')) $$, 'P0001', 'invalid_input', '別の年度の団体には招待できない');
select throws_ok($$ select public.invite(tests.id('Y1'), 'staff@pgtap.test', 'viewer') $$, 'P0001', 'conflict', '別のロールを持つ人は set_role で変える');
-- 既存の確認済みアカウント：その場で付く（大文字小文字と前後の空白はそろえる）
select is((public.invite(tests.id('Y1'), '  Outsider@PgTap.TEST ', 'viewer') ->> 'applied')::boolean, true, '既存ユーザーはその場で付く');
select tests.logout();
select is((select role from public.year_roles where year_id = tests.id('Y1') and user_id = tests.id('outsider')), 'viewer'::public.app_role, 'outsider に viewer が付く');
select ok((select used_at is not null from public.invitations where email = 'outsider@pgtap.test' and year_id = tests.id('Y1')), '招待は小文字で保存され、使用済み');
select is((select reason from public.audit_logs where table_name = 'year_roles' and action = 'insert'
           and row_pk ->> 'user_id' = tests.id('outsider')::text), '招待', 'ロールの追加の理由は「招待」');
-- 未登録：招待だけ
select tests.login_as('admin');
-- viewer は同じ年度の団体代表を兼ねられるので、一度に頼める（部門のロールと団体を一度に頼むのは role_overlap。下の「兼任の禁止」）
select is(jsonb_array_length(public.invite(tests.id('Y1'), 'new@pgtap.test', 'viewer', tests.id('G1')) -> 'invitation_ids'), 2,
  'ロール（viewer）と団体の両方なら招待は2つ');
select is((public.invite(tests.id('Y1'), 'new@pgtap.test', 'admin') ->> 'applied')::boolean, false, '未登録は招待だけ（applied: false）');
select tests.logout();
select is((select role from public.invitations where email = 'new@pgtap.test' and role is not null and used_at is null), 'admin'::public.app_role,
  '未使用のロールの招待は、招待し直すとロールが変わる（1件のまま）');
-- メール未確認のアカウントにはその場で付けない（他人のメールを名乗った登録に招待を取らせない）
insert into auth.users (instance_id, id, aud, role, email, email_confirmed_at, raw_user_meta_data, created_at, updated_at)
values ('00000000-0000-0000-0000-000000000000', '44444444-4444-4444-8444-444444444444', 'authenticated', 'authenticated',
        'late@pgtap.test', null, '{}', now(), now());
insert into auth.identities (provider_id, user_id, identity_data, provider, created_at, updated_at)
values ('44444444-4444-4444-8444-444444444444', '44444444-4444-4444-8444-444444444444',
        '{"sub": "44444444-4444-4444-8444-444444444444", "email": "late@pgtap.test", "email_verified": true}', 'email', now(), now());
insert into tests.ids values ('late', '44444444-4444-4444-8444-444444444444');
select tests.login_as('admin');
select is((public.invite(tests.id('Y1'), 'late@pgtap.test', 'viewer') ->> 'applied')::boolean, false, 'invite は未確認のアカウントには付けない');
select tests.logout();
select is((select count(*)::int from public.year_roles where user_id = tests.id('late')), 0, '未確認のアカウントにロールはない');
-- closed の年度には招待できない
select tests.set_scenario('closed');
select tests.login_as('admin');
select throws_ok($$ select public.invite(tests.id('Y1'), 'b@pgtap.test', 'viewer') $$, 'P0001', 'invalid_state', 'closed の年度には招待できない');
select tests.logout();
select tests.set_scenario('requesting');

-- ================================================================ accept_my_invitations
select tests.login_anon();
select throws_ok($$ select public.accept_my_invitations() $$, '42501', null, 'anon は呼べない');
select tests.logout();
select tests.login_as('late');
select is(public.accept_my_invitations(), 0, '未確認なら accept_my_invitations も0件');
select tests.logout();
-- T04 からは、メールの確認で auth.users のトリガー（on_auth_user_confirmed）が招待を受け入れる（詳しくは 030_auth）
update auth.users set email_confirmed_at = now() where id = tests.id('late');
select is((select role from public.year_roles where year_id = tests.id('Y1') and user_id = tests.id('late')), 'viewer'::public.app_role,
  'メールの確認でトリガーが招待を受け入れる');
select tests.login_as('late');
select is(public.accept_my_invitations(), 0, 'トリガーで受け入れ済みなら0件');
select tests.logout();
-- invite と初回ログインが行き違って未使用のまま残った招待（ここでは直接入れて作る）を、ログイン時の RPC で拾う
insert into public.invitations (year_id, email, role) values (tests.id('Y2'), 'late@pgtap.test', 'viewer');
select tests.login_as('late');
select is(public.accept_my_invitations(), 1, '確認済みなら、残っていた未使用の招待を受け入れる');
select is(public.accept_my_invitations(), 0, '受け入れた招待はもう受け入れない');
select is((select role from public.year_roles where year_id = tests.id('Y1') and user_id = tests.id('late')), 'viewer'::public.app_role,
  '自分のロールを読める');
select tests.logout();
-- closed の年度の招待は受け入れない
insert into public.invitations (year_id, email, role) values (tests.id('Y2'), 'outsider@pgtap.test', 'staff');
update public.years set status = 'closed' where id = tests.id('Y2');
select tests.login_as('outsider');
select is(public.accept_my_invitations(), 0, 'closed の年度の招待は受け入れない');
select tests.logout();
update public.years set status = 'preparing' where id = tests.id('Y2');
select tests.login_as('outsider');
select is(public.accept_my_invitations(), 1, '年度が開いていれば受け入れる（invite と初回ログインの行き違いを拾う）');
select tests.logout();
select is((select role from public.year_roles where year_id = tests.id('Y2') and user_id = tests.id('outsider')), 'staff'::public.app_role,
  'outsider は Y2 の staff');

-- ================================================================ set_role
select tests.login_as('staff');
select throws_ok($$ select public.set_role(tests.id('Y1'), tests.id('late'), 'staff') $$, 'P0001', 'forbidden', 'staff はロールを変えられない');
select tests.logout();
select tests.login_as('admin2');
select throws_ok($$ select public.set_role(tests.id('Y1'), tests.id('late'), 'staff') $$, 'P0001', 'forbidden', '別の年度の admin は変えられない');
select tests.logout();
select tests.login_as('admin');
select throws_ok($$ select public.set_role(tests.id('Y1'), gen_random_uuid(), 'staff') $$, 'P0001', 'not_found', '存在しないユーザーは not_found');
select throws_ok($$ select public.set_role(tests.id('Y1'), tests.id('admin'), 'staff') $$, 'P0001', 'invalid_state', '最後の admin を降格できない');
select throws_ok($$ select public.set_role(tests.id('Y1'), tests.id('late'), null) $$, 'P0001', 'invalid_input', 'set_role の role は必須（外すのは remove_role）');
select throws_ok($$ select public.remove_role(tests.id('Y1'), tests.id('admin')) $$, 'P0001', 'invalid_state', '最後の admin を外せない');
select throws_ok(format($$ select public.set_role(%L, %L, 'staff', %L) $$, tests.id('Y1'), tests.id('late'), repeat('x', 501)), 'P0001', 'invalid_input', '理由は 500 字まで');
select lives_ok($$ select public.set_role(tests.id('Y1'), tests.id('late'), 'staff', '手伝い') $$, 'ロールを変える');
select tests.logout();
select is((select role from public.year_roles where year_id = tests.id('Y1') and user_id = tests.id('late')), 'staff'::public.app_role, 'viewer → staff');
select is((select reason from public.audit_logs where table_name = 'year_roles' and row_pk ->> 'user_id' = tests.id('late')::text order by id desc limit 1),
  '手伝い', 'ロールの変更の理由が監査に残る');
select tests.login_as('admin');
select lives_ok($$ select public.set_role(tests.id('Y1'), tests.id('late'), 'admin') $$, '2人目の admin');
select lives_ok($$ select public.remove_role(tests.id('Y1'), tests.id('late')) $$, '最後でない admin は外せる');
select throws_ok($$ select public.remove_role(tests.id('Y1'), tests.id('late')) $$, 'P0001', 'not_found', 'ロールのない人は not_found');
select throws_ok(format($$ select public.remove_role(%L, %L, %L) $$, tests.id('Y1'), tests.id('outsider'), repeat('x', 501)), 'P0001', 'invalid_input', '外す理由も 500 字まで');
select tests.logout();
select is((select count(*)::int from public.year_roles where year_id = tests.id('Y1') and user_id = tests.id('late')), 0, '外した');
select tests.login_as('staff');
select throws_ok($$ select public.remove_role(tests.id('Y1'), tests.id('outsider')) $$, 'P0001', 'forbidden', 'staff はロールを外せない');
select tests.logout();
select tests.login_as('admin2');
select throws_ok($$ select public.remove_role(tests.id('Y1'), tests.id('outsider')) $$, 'P0001', 'forbidden', '別の年度の admin は外せない');
select tests.logout();
-- closed：外すのはできる、付けるのはできない
select tests.set_scenario('closed');
select tests.login_as('admin');
select throws_ok($$ select public.set_role(tests.id('Y1'), tests.id('outsider'), 'staff') $$, 'P0001', 'invalid_state', 'closed ではロールを付け替えられない');
select lives_ok($$ select public.remove_role(tests.id('Y1'), tests.id('outsider'), '卒業') $$, 'closed でもロールは外せる');
select tests.logout();
select is((select reason from public.audit_logs where table_name = 'year_roles' and action = 'delete'
           and row_pk ->> 'user_id' = tests.id('outsider')::text order by id desc limit 1), '卒業', 'ロールを外した理由が監査に残る');
select tests.set_scenario('requesting');

-- ================================================================ revoke_invitation
select tests.login_as('staff');
select throws_ok($$ select public.revoke_invitation((select id from public.invitations where email = 'someone@pgtap.test')) $$,
  'P0001', 'forbidden', 'staff は招待を取り消せない（自分では見えない招待でも forbidden）');
select tests.logout();
select tests.login_as('admin2');
select throws_ok(format($$ select public.revoke_invitation(%L) $$, (select id from public.invitations where email = 'someone@pgtap.test')),
  'P0001', 'forbidden', '別の年度の admin は取り消せない');
select tests.logout();
select tests.login_as('admin');
select throws_ok($$ select public.revoke_invitation(gen_random_uuid()) $$, 'P0001', 'forbidden', '存在しない招待は forbidden');
select throws_ok($$ select public.revoke_invitation((select id from public.invitations where email = 'viewer@pgtap.test')) $$,
  'P0001', 'invalid_state', '使用済みの招待は取り消せない');
select lives_ok($$ select public.revoke_invitation((select id from public.invitations where email = 'someone@pgtap.test')) $$, '未使用の招待を取り消す');
select is((select count(*)::int from public.invitations where email = 'someone@pgtap.test'), 0, '取り消した招待は消える');
select tests.logout();
-- closed の年度の未使用の招待も取り消せる
insert into public.invitations (year_id, email, role) values (tests.id('Y1'), 'closedinv@pgtap.test', 'viewer');
select tests.set_scenario('closed');
select tests.login_as('admin');
select lives_ok($$ select public.revoke_invitation((select id from public.invitations where email = 'closedinv@pgtap.test')) $$,
  'closed の年度でも未使用の招待を取り消せる');
select tests.logout();
select is((select count(*)::int from public.invitations where email = 'closedinv@pgtap.test'), 0, 'closed の年度の招待も消える');
select tests.set_scenario('requesting');

-- ================================================================ remove_group_member
insert into public.invitations (year_id, email, group_id, group_role, used_at) values (tests.id('Y1'), 'rep2@pgtap.test', tests.id('G2'), 'manager', now());
select tests.login_as('rep2');
select is((select count(*)::int from public.invitations), 1, '団体代表は自分あての招待を読める');
select throws_ok($$ select public.remove_group_member(tests.id('G1'), tests.id('rep'), null) $$, 'P0001', 'forbidden', '団体代表は他の代表を外せない');
select tests.logout();
select tests.login_as('admin2');
select throws_ok($$ select public.remove_group_member(tests.id('G2'), tests.id('rep2'), null) $$, 'P0001', 'forbidden', '別の年度の admin は外せない');
select tests.logout();
select tests.login_as('admin');
select throws_ok($$ select public.remove_group_member(gen_random_uuid(), tests.id('rep2'), null) $$, 'P0001', 'forbidden', '存在しない団体は forbidden');
select throws_ok($$ select public.remove_group_member(tests.id('G2'), tests.id('rep'), null) $$, 'P0001', 'not_found', '代表でない人は not_found');
select lives_ok($$ select public.remove_group_member(tests.id('G2'), tests.id('rep2'), '交代') $$, '団体代表を外す');
select tests.logout();
select tests.login_as('rep2');
select is((select count(*)::int from public.invitations), 0, '外された人は自分あての使用済みの招待も読めない');
select is((select count(*)::int from public.groups), 0, '外された人は団体も読めない');
select tests.logout();
select tests.set_scenario('closed');
select tests.login_as('admin');
select lives_ok($$ select public.remove_group_member(tests.id('G1'), tests.id('rep'), '卒業') $$, 'closed の年度でも団体代表を外せる');
select tests.logout();

-- ================================================================ 本人のメールの確認（private.verified_email、D-17a）
-- email_confirmed_at は最初の確認の時刻のまま残る。メールの変更に確認が要らない設定（や SQL・管理 API での変更）で、
-- auth.users.email だけが招待された人のアドレスに変わった状態を作る
select tests.set_scenario('requesting');
insert into public.invitations (year_id, email, role) values (tests.id('Y1'), 'victim@pgtap.test', 'admin');
insert into public.invitations (year_id, email, group_id, group_role) values (tests.id('Y1'), 'victim@pgtap.test', tests.id('G1'), 'manager');
-- Google のユーザー：Google の identity のメールは自分のまま
select tests.user_with_identity('sw_google', 'google');
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
-- Auth の Confirm email が無効だと、GoTrue は古いアドレスのリンクだけで変更を終え、Google だけのユーザーにも
-- email_verified: true の email の identity を新しく作る（GoTrue v2.197 で確かめた）。Google の identity があるアカウントは
-- Google の identity のメールだけを信じるので、設定が崩れていても受け入れない
select tests.user_with_identity('sw_gmix', 'google');
update auth.users set email = 'victim@pgtap.test' where id = tests.id('sw_gmix');
insert into auth.identities (provider_id, user_id, identity_data, provider, created_at, updated_at)
values (tests.id('sw_gmix')::text, tests.id('sw_gmix'),
        jsonb_build_object('sub', tests.id('sw_gmix')::text, 'email', 'victim@pgtap.test', 'email_verified', true), 'email', now(), now());
select tests.login_as('sw_gmix');
select is(private.my_verified_email(), null, 'Google の identity があれば、email_verified が true の email の identity でも本人のメールとみない');
select is(public.accept_my_invitations(), 0, 'Google のユーザーが確かめずに足した email の identity では、その人あての招待を受け入れられない');
select tests.logout();
select tests.login_as('admin');
select is((public.invite(tests.id('Y1'), 'victim@pgtap.test', 'admin') ->> 'applied')::boolean, false,
  'invite も、Google の identity と違うメールのアカウントにはその場で付けない');
select tests.logout();
select is((select count(*)::int from public.year_roles where user_id = tests.id('sw_gmix'))
          + (select count(*)::int from public.group_members where user_id = tests.id('sw_gmix')), 0,
  'Google の identity と違うメールのアカウントには、admin の招待も団体代表の招待も付かない');
select is((select count(*)::int from public.invitations where email = 'victim@pgtap.test' and used_at is null), 2, 'その招待も未使用のまま');
update auth.users set email = 'sw_gmix@pgtap.test' where id = tests.id('sw_gmix');   -- 元に戻す（email は一意）
select tests.login_as('sw_gmix');
select is(private.my_verified_email(), 'sw_gmix@pgtap.test', 'Google の identity と同じメールなら、ほかの email の identity があっても本人のメールとみる');
select tests.logout();
-- Google の identity でも、Google がメールの持ち主を確かめていない（identity_data の email_verified が真でない）なら信じない。
-- email_verified は真偽値の true と文字列の "true" を真とみる（GoTrue の版で形が違う）。読めるかを確かめるため、ほかの権限を持たせる
select tests.user_with_identity('sw_gunv', 'google');
update auth.identities set identity_data = identity_data || '{"email_verified": false}' where user_id = tests.id('sw_gunv');
insert into public.group_members (group_id, user_id) values (tests.id('G1'), tests.id('sw_gunv'));
select tests.login_as('admin');
select is((public.invite(tests.id('Y1'), 'sw_gunv@pgtap.test', 'viewer') ->> 'applied')::boolean, false,
  'invite は、Google の identity の email_verified が false のアカウントにはその場で付けない');
select tests.logout();
select tests.login_as('sw_gunv');
select is(private.my_verified_email(), null, 'Google の identity の email_verified が false なら、メールが同じでも本人のメールとみない');
select is((select count(*)::int from public.invitations where email = 'sw_gunv@pgtap.test'), 0,
  'Google の identity の email_verified が false なら、そのメールあての招待を読めない');
select is(public.accept_my_invitations(), 0, 'Google の identity の email_verified が false なら、招待を受け入れられない');
select tests.logout();
update auth.identities set identity_data = identity_data || '{"email_verified": "false"}' where user_id = tests.id('sw_gunv');
select tests.login_as('sw_gunv');
select is(private.my_verified_email(), null, 'Google の identity の email_verified が文字列の "false" でも本人のメールとみない');
select tests.logout();
update auth.identities set identity_data = identity_data - 'email_verified' where user_id = tests.id('sw_gunv');
select tests.login_as('sw_gunv');
select is(private.my_verified_email(), null, 'Google の identity に email_verified がなければ本人のメールとみない');
select tests.logout();
update auth.identities set identity_data = identity_data || '{"email_verified": "true"}' where user_id = tests.id('sw_gunv');
select tests.login_as('sw_gunv');
select is(private.my_verified_email(), 'sw_gunv@pgtap.test', 'Google の identity の email_verified が文字列の "true" なら本人のメールとみる');
select is((select count(*)::int from public.invitations where email = 'sw_gunv@pgtap.test'), 1, 'そのメールあての招待を読める');
select is(public.accept_my_invitations(), 1, 'そのメールあての招待を受け入れる');
select tests.logout();
select is((select role from public.year_roles where year_id = tests.id('Y1') and user_id = tests.id('sw_gunv')), 'viewer'::public.app_role,
  'email_verified が "true" の Google のユーザーに招待のロールが付く');
-- メールの identity（seed の形）：identity のメールは自分のまま、または変えたアドレスでも email_verified でない
select tests.user_with_identity('sw_email', 'email');
update auth.users set email = 'victim@pgtap.test' where id = tests.id('sw_email');
select tests.login_as('sw_email');
select is(public.accept_my_invitations(), 0, 'email の identity のメールが元のままなら受け入れない');
select tests.logout();
update auth.identities set identity_data = identity_data || '{"email": "victim@pgtap.test", "email_verified": false}'
where user_id = tests.id('sw_email');
select tests.login_as('sw_email');
select is(public.accept_my_invitations(), 0, 'email の identity のメールが変わっても、email_verified でなければ受け入れない');
select tests.logout();
update auth.identities set identity_data = identity_data || '{"email_verified": "true"}' where user_id = tests.id('sw_email');
select tests.login_as('sw_email');
select is(public.accept_my_invitations(), 0, 'email_verified が真偽値でなければ（文字列の "true" も）受け入れない');
select tests.logout();
-- 本人のメールでも、メールの変更の途中（email_change が空でない）は受け入れない
-- （identity を作った時点で招待を受け入れるトリガー（0007）があるので、ユーザーを作って email_change を入れてから招待を作る）
select tests.user_with_identity('pending', 'google');
update auth.users set email_change = 'other@pgtap.test' where id = tests.id('pending');
insert into public.invitations (year_id, email, role) values (tests.id('Y1'), 'pending@pgtap.test', 'viewer');
select tests.login_as('pending');
select is(public.accept_my_invitations(), 0, 'メールの変更の途中なら受け入れない');
select tests.logout();
select is((select count(*)::int from public.invitations where email = 'pending@pgtap.test' and used_at is null), 1,
  'メールの変更の途中は、招待が未使用のまま');
select tests.login_as('admin');
select is((public.invite(tests.id('Y1'), 'pending@pgtap.test', 'viewer') ->> 'applied')::boolean, false,
  'invite も、メールの変更の途中のアカウントにはその場で付けない');
select tests.logout();
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
select ok(exists (select 1 from public.group_members where group_id = tests.id('G1') and user_id = tests.id('sw_email')),
  '団体代表の招待も付く');

-- ================================================================ 別のロールを持つ人へのロールの招待（マージの後の直し）
-- invite の時点で本人のメールを確かめられなかった人（conflict の確認がかからない）が、その年度で別のロールを
-- 持っていたら、受け入れのときに招待を使用済みにせず残す（ロールも変えない）。団体代表の招待は受け入れる
-- （T15：ロールは viewer。staff なら兼任の禁止で団体代表の招待も飛ばされる。下の「兼任の禁止」）
select tests.create_user('fu_conflict');
insert into public.year_roles (year_id, user_id, role) values (tests.id('Y1'), tests.id('fu_conflict'), 'viewer');
insert into public.invitations (year_id, email, role) values (tests.id('Y1'), 'fu_conflict@pgtap.test', 'admin');
insert into public.invitations (year_id, email, group_id, group_role) values (tests.id('Y1'), 'fu_conflict@pgtap.test', tests.id('G1'), 'manager');
select tests.login_as('fu_conflict');
select is(public.accept_my_invitations(), 1, '別のロールを持つ人は、ロールの招待を受け入れず、団体代表の招待だけを受け入れる');
select is(public.accept_my_invitations(), 0, '残したロールの招待は、次のログインでも受け入れない');
select tests.logout();
select is((select role from public.year_roles where year_id = tests.id('Y1') and user_id = tests.id('fu_conflict')), 'viewer'::public.app_role,
  '別のロールを持つ人のロールは変わらない');
select ok((select used_at is null from public.invitations where email = 'fu_conflict@pgtap.test' and role is not null),
  '別のロールを持つ人へのロールの招待は使用済みにならない（管理者の画面で未使用のまま見える）');
select ok(exists (select 1 from public.group_members where group_id = tests.id('G1') and user_id = tests.id('fu_conflict')),
  '団体代表の招待は付く');
select ok((select used_at is not null from public.invitations where email = 'fu_conflict@pgtap.test' and group_id is not null),
  '団体代表の招待は使用済みになる');
-- 管理者がロールを外す（remove_role）と、その年度の本人あての未使用のロールの招待も取り消す（外した人に、次のログインで
-- 残っていた招待のロールが付かないように。ロールを変えるのは set_role）。ほかの年度・ほかの人・団体代表の招待は消さない
insert into public.invitations (year_id, email, role) values (tests.id('Y2'), 'fu_conflict@pgtap.test', 'staff');
insert into public.invitations (year_id, email, group_id, group_role) values (tests.id('Y1'), 'fu_conflict@pgtap.test', tests.id('G2'), 'manager');
insert into public.invitations (year_id, email, role) values (tests.id('Y1'), 'fu_other@pgtap.test', 'staff');
select tests.login_as('admin');
select lives_ok($$ select public.remove_role(tests.id('Y1'), tests.id('fu_conflict'), '交代') $$, '別のロールを持つ人へのロールの招待が残っていても外せる');
select tests.logout();
select is((select count(*)::int from public.invitations
           where year_id = tests.id('Y1') and email = 'fu_conflict@pgtap.test' and role is not null),
  0, 'ロールを外すと、その年度の本人あての未使用のロールの招待も消える');
select is((select count(*)::int from public.invitations
           where year_id = tests.id('Y2') and email = 'fu_conflict@pgtap.test' and role is not null and used_at is null),
  1, 'ほかの年度のロールの招待は消えない');
select is((select count(*)::int from public.invitations
           where year_id = tests.id('Y1') and email = 'fu_conflict@pgtap.test' and group_id is not null),
  2, '団体代表の招待（使用済み・未使用）は消えない');
select is((select count(*)::int from public.invitations where email = 'fu_other@pgtap.test' and used_at is null),
  1, 'ほかの人の招待は消えない');
select tests.login_as('fu_conflict');
select is(public.accept_my_invitations(), 2, '外した後のログインでは、ほかの年度のロールの招待と団体代表の招待だけを受け入れる');
select tests.logout();
select is((select count(*)::int from public.year_roles where year_id = tests.id('Y1') and user_id = tests.id('fu_conflict')),
  0, '外した人に、外した年度のロールは付かない');
-- 本人のメールを確かめられない人（メールの変更の途中。verified_email が null）も、ロールを外すと、本人のものと確定している
-- メール（auth.users.email。Secure email change では確定するまで変わらない）あての、その年度の未使用のロールの招待を消す
-- （残すと、変更を元に戻した後のログインでそのロールが付き、外した人に権限が戻る）。
-- 確定していない変更先（email_change）あての招待は消さない（他人のアドレスを入れて他人の招待を消せないように）
select tests.create_user('fu_unverified');
insert into public.year_roles (year_id, user_id, role) values (tests.id('Y1'), tests.id('fu_unverified'), 'staff');
insert into public.invitations (year_id, email, role) values (tests.id('Y1'), 'fu_unverified@pgtap.test', 'admin');
insert into public.invitations (year_id, email, role) values (tests.id('Y2'), 'fu_unverified@pgtap.test', 'viewer');
insert into public.invitations (year_id, email, group_id, group_role) values (tests.id('Y1'), 'fu_unverified@pgtap.test', tests.id('G1'), 'manager');
insert into public.invitations (year_id, email, role) values (tests.id('Y1'), 'fu_pending_to@pgtap.test', 'staff');
update auth.users set email_change = 'fu_pending_to@pgtap.test' where id = tests.id('fu_unverified');
select is(private.verified_email(tests.id('fu_unverified')), null, '前提：メールの変更の途中の人は、本人のメールを確かめられない');
select tests.login_as('admin');
select lives_ok($$ select public.remove_role(tests.id('Y1'), tests.id('fu_unverified')) $$, 'メールの変更の途中の人のロールも外せる');
select tests.logout();
select is((select count(*)::int from public.year_roles where year_id = tests.id('Y1') and user_id = tests.id('fu_unverified')),
  0, 'メールの変更の途中の人のロールが外れる');
select is((select count(*)::int from public.invitations
           where year_id = tests.id('Y1') and email = 'fu_unverified@pgtap.test' and role is not null),
  0, 'メールの変更の途中でも、本人の確定したメールあての、その年度の未使用のロールの招待を消す');
select is((select count(*)::int from public.invitations
           where year_id = tests.id('Y2') and email = 'fu_unverified@pgtap.test' and role is not null and used_at is null),
  1, 'メールの変更の途中の人でも、ほかの年度のロールの招待は消えない');
select is((select count(*)::int from public.invitations
           where year_id = tests.id('Y1') and email = 'fu_unverified@pgtap.test' and group_id is not null and used_at is null),
  1, 'メールの変更の途中の人でも、団体代表の招待は消えない');
select is((select count(*)::int from public.invitations where email = 'fu_pending_to@pgtap.test' and used_at is null),
  1, 'email_change に他人のアドレスを入れていても、その他人あての招待は消えない');
-- 変更を元に戻して（確定したメールに戻る）ログインしても、外した年度のロールは付かない
update auth.users set email_change = '' where id = tests.id('fu_unverified');
select tests.login_as('fu_unverified');
select is(public.accept_my_invitations(), 2,
  '元のアドレスに戻した後のログインでは、ほかの年度のロールの招待と団体代表の招待だけを受け入れる');
select tests.logout();
select is((select count(*)::int from public.year_roles where year_id = tests.id('Y1') and user_id = tests.id('fu_unverified')),
  0, 'メールの変更の途中で外し、元のアドレスに戻してから accept_my_invitations を呼んでも、外した年度のロールが付かない');
-- Google の identity（email_verified が真）のメールも本人のもの（auth.users.email と違い、verified_email が null でも）。
-- email_verified が真でない Google の identity のメールあての招待は消さない
select tests.user_with_identity('fu_google', 'google');
update auth.identities set identity_data = identity_data || '{"email": "Fu_Google_Acct@pgtap.test"}'
where user_id = tests.id('fu_google');
select tests.user_with_identity('fu_gunv', 'google');
update auth.identities set identity_data = identity_data || '{"email": "fu_gunv_acct@pgtap.test", "email_verified": false}'
where user_id = tests.id('fu_gunv');
insert into public.year_roles (year_id, user_id, role) values
  (tests.id('Y1'), tests.id('fu_google'), 'viewer'), (tests.id('Y1'), tests.id('fu_gunv'), 'viewer');
insert into public.invitations (year_id, email, role) values
  (tests.id('Y1'), 'fu_google_acct@pgtap.test', 'staff'), (tests.id('Y1'), 'fu_gunv_acct@pgtap.test', 'staff');
select tests.login_as('admin');
select lives_ok($$ select public.remove_role(tests.id('Y1'), tests.id('fu_google')) $$, 'Google の identity のメールが違う人のロールを外す');
select lives_ok($$ select public.remove_role(tests.id('Y1'), tests.id('fu_gunv')) $$, 'Google の identity のメールが確認されていない人のロールを外す');
select tests.logout();
select is((select count(*)::int from public.invitations where email = 'fu_google_acct@pgtap.test'),
  0, '確認済みの Google の identity のメールあての、その年度の未使用のロールの招待も消す');
select is((select count(*)::int from public.invitations where email = 'fu_gunv_acct@pgtap.test' and used_at is null),
  1, 'email_verified が真でない Google の identity のメールあての招待は消さない');
-- 最後の管理者は今までどおり外せず、その人あての招待も消えない（Y1 は sw_email も admin なので、admin が1人の Y2 で確かめる）
insert into public.invitations (year_id, email, role) values (tests.id('Y2'), 'admin2@pgtap.test', 'viewer');
select tests.login_as('admin2');
select throws_ok($$ select public.remove_role(tests.id('Y2'), tests.id('admin2')) $$, 'P0001', 'invalid_state',
  '招待が残っていても、最後の admin は外せない');
select tests.logout();
select is((select count(*)::int from public.invitations where email = 'admin2@pgtap.test' and used_at is null),
  1, '最後の admin を外せなかったときは、招待も消えない');
-- 同じロールを持つ人：今までどおり招待を使用済みにする（ロールはそのまま）
select tests.create_user('fu_same');
insert into public.year_roles (year_id, user_id, role) values (tests.id('Y1'), tests.id('fu_same'), 'staff');
insert into public.invitations (year_id, email, role) values (tests.id('Y1'), 'fu_same@pgtap.test', 'staff');
select tests.login_as('fu_same');
select is(public.accept_my_invitations(), 1, '同じロールを持つ人は、今までどおり招待を受け入れる');
select tests.logout();
select ok((select used_at is not null from public.invitations where email = 'fu_same@pgtap.test'), '同じロールの招待は使用済みになる');
select is((select role from public.year_roles where year_id = tests.id('Y1') and user_id = tests.id('fu_same')), 'staff'::public.app_role,
  '同じロールを持つ人のロールはそのまま');
-- ロールを持たない人：今までどおりロールが付き、招待は使用済みになる
select tests.create_user('fu_none');
insert into public.invitations (year_id, email, role) values (tests.id('Y1'), 'fu_none@pgtap.test', 'viewer');
select tests.login_as('fu_none');
select is(public.accept_my_invitations(), 1, 'ロールを持たない人は、今までどおり招待を受け入れる');
select tests.logout();
select ok((select used_at is not null from public.invitations where email = 'fu_none@pgtap.test'), 'ロールを持たない人への招待は使用済みになる');
select is((select role from public.year_roles where year_id = tests.id('Y1') and user_id = tests.id('fu_none')), 'viewer'::public.app_role,
  'ロールを持たない人に招待のロールが付く');

-- ================================================================ 兼任の禁止（T15。D-49）：管理者の経路
-- 部門のロール（head・deputy_head・staff）と同じ年度の団体代表（店長・副店長）は兼ねられない。admin・viewer は兼ねられる。
-- 違う年度ならよい。invite は早めに role_overlap（detail の reason：requested_together・current_membership・pending_invitation）を返し、
-- set_role はトリガー（0013）が止め、招待の受け入れは重なる招待を飛ばす（未使用のまま。例外を出さない）。
-- 部門長・副部門長の段は 024、トリガーそのものは 014、ログイン（auth のトリガー）の経路は 030
select tests.create_user(n) from unnest(array['ov_rep', 'ov_rep2', 'ov_staff', 'ov_view']) n;
insert into public.group_members (group_id, user_id, role) values
  (tests.id('G1'), tests.id('ov_rep'), 'manager'), (tests.id('G2'), tests.id('ov_rep2'), 'manager'),
  (tests.id('G2'), tests.id('ov_view'), 'deputy_manager');
insert into public.year_roles (year_id, user_id, role) values
  (tests.id('Y1'), tests.id('ov_staff'), 'staff'), (tests.id('Y1'), tests.id('ov_view'), 'viewer');

select tests.set_scenario('requesting');
select tests.login_as('admin');
-- 一度に頼んだ（部門のロールと団体）
select is(tests.error_json($$ select public.invite(tests.id('Y1'), 'ov_new@pgtap.test', 'staff', tests.id('G1')) $$),
  jsonb_build_object('code', 'role_overlap', 'detail', jsonb_build_object('year_id', tests.id('Y1'), 'reason', 'requested_together')),
  'staff と団体を一度に頼むと role_overlap（requested_together。メールは detail に入れない）');
select is(tests.error_json(format($$ select public.invite(%L, 'ov_new@pgtap.test', %L, %L) $$, tests.id('Y1'), r, tests.id('G1'))) ->> 'code',
          'role_overlap', format('%s と団体を一度に頼むと role_overlap', r))
from unnest(array['head', 'deputy_head']) r;
select is(jsonb_array_length(public.invite(tests.id('Y1'), 'ov_adm@pgtap.test', 'admin', tests.id('G1')) -> 'invitation_ids'), 2,
  'admin と団体は一度に頼める（admin は団体代表を兼ねられる）');
-- 確かめられたアカウントの今の立場（current_membership）。別のロールの conflict が先
select is(tests.error_json($$ select public.invite(tests.id('Y1'), 'ov_rep@pgtap.test', 'staff') $$),
  jsonb_build_object('code', 'role_overlap',
                     'detail', jsonb_build_object('year_id', tests.id('Y1'), 'user_id', tests.id('ov_rep'), 'reason', 'current_membership')),
  'その年度の店長に staff を招待すると role_overlap（current_membership。アカウントが分かれば user_id も）');
select is(tests.error_json($$ select public.invite(tests.id('Y1'), 'ov_rep@pgtap.test', 'head') $$) ->> 'code', 'role_overlap',
  'その年度の店長に head を招待しても role_overlap');
select is(tests.error_json($$ select public.invite(tests.id('Y1'), 'ov_staff@pgtap.test', null, tests.id('G1')) $$),
  jsonb_build_object('code', 'role_overlap',
                     'detail', jsonb_build_object('year_id', tests.id('Y1'), 'user_id', tests.id('ov_staff'), 'reason', 'current_membership')),
  'その年度の staff を団体に招待すると role_overlap（反対の向き）');
select is(tests.error_json($$ select public.invite(tests.id('Y1'), 'ov_view@pgtap.test', 'staff') $$),
  jsonb_build_object('code', 'conflict', 'detail', jsonb_build_object('field', 'role', 'current', 'viewer')),
  '閲覧のみの副店長に staff を招待すると、兼任より先に「別のロール」の conflict');
select is(tests.error_json($$ select public.invite(tests.id('Y1'), 'ov_view@pgtap.test', null, tests.id('G2')) $$),
  jsonb_build_object('code', 'conflict', 'detail', jsonb_build_object('field', 'group_role', 'current', 'deputy_manager')),
  'その団体に副店長でいる人を店長（既定）で招待すると conflict（field: group_role）');
select is((public.invite(tests.id('Y1'), 'ov_view@pgtap.test', null, tests.id('G2'), 'deputy_manager') ->> 'applied')::boolean, true,
  '同じ立場（副店長）で招待し直すと、その場で受け入れ済みになる');
select is((public.invite(tests.id('Y1'), 'ov_rep@pgtap.test', 'admin') ->> 'applied')::boolean, true,
  '店長に admin を招待できる（admin は兼ねられる）');
select is((public.invite(tests.id('Y1'), 'ov_rep2@pgtap.test', 'viewer') ->> 'applied')::boolean, true,
  '店長に viewer を招待できる（閲覧のみは兼ねられる）');
-- 反対側の未使用の招待（pending_invitation）
select is((public.invite(tests.id('Y1'), 'ov_pend@pgtap.test', 'staff') ->> 'applied')::boolean, false, '準備：未登録の人への staff の招待');
select is(tests.error_json($$ select public.invite(tests.id('Y1'), 'ov_pend@pgtap.test', null, tests.id('G1')) $$),
  jsonb_build_object('code', 'role_overlap', 'detail', jsonb_build_object('year_id', tests.id('Y1'), 'reason', 'pending_invitation')),
  '未使用の staff の招待があるメールを団体に招待すると role_overlap（pending_invitation）');
select is((public.invite(tests.id('Y1'), 'ov_pgrp@pgtap.test', null, tests.id('G2')) ->> 'applied')::boolean, false, '準備：未登録の人への団体の招待');
select is(tests.error_json(format($$ select public.invite(%L, 'ov_pgrp@pgtap.test', %L) $$, tests.id('Y1'), r)) ->> 'code',
          'role_overlap', format('未使用の団体の招待があるメールに %s を招待すると role_overlap（反対の向き）', r))
from unnest(array['staff', 'head', 'deputy_head']) r;
select is(jsonb_array_length(public.invite(tests.id('Y1'), 'ov_pend@pgtap.test', 'viewer', tests.id('G1')) -> 'invitation_ids'), 2,
  '未使用の staff の招待を viewer で招待し直しながら団体を足せる（この呼び出しの後の状態で見る）');
select is(public.invite(tests.id('Y1'), 'ov_pend@pgtap.test', null, tests.id('G1'), 'deputy_manager') ->> 'applied', 'false',
  '未使用の団体の招待を副店長で招待し直す');
select is(tests.error_json($$ select public.invite(tests.id('Y1'), 'ov_x@pgtap.test', 'viewer', null, 'manager') $$),
  jsonb_build_object('code', 'invalid_input', 'detail', jsonb_build_object('field', 'group_role')),
  '団体なしで立場を渡すと invalid_input（field: group_role）');
select tests.logout();
select is((select string_agg(coalesce(role::text, 'G:' || group_role::text), ' ' order by role nulls last)
           from public.invitations where email = 'ov_pend@pgtap.test' and used_at is null),
  'viewer G:deputy_manager', '招待し直すと、ロールの招待はロールが、団体の招待は立場が変わる（どちらも1件のまま）');
select is((select count(*)::int from public.invitations where email in ('ov_new@pgtap.test', 'ov_x@pgtap.test')), 0,
  'エラーになった招待は作られない');
select ok(exists (select 1 from public.year_roles where year_id = tests.id('Y1') and user_id = tests.id('ov_rep') and role = 'admin')
          and exists (select 1 from public.group_members where group_id = tests.id('G1') and user_id = tests.id('ov_rep')),
  'admin と店長を兼ねている');
-- 違う年度ならよい（Y1 の staff を Y2 の団体に、Y1 の店長を Y2 の staff に。Y2 の admin が招待する）
select tests.login_as('admin2');
select is((public.invite(tests.id('Y2'), 'ov_staff@pgtap.test', null, tests.id('G3')) ->> 'applied')::boolean, true,
  'Y1 の staff を Y2 の団体に招待できる（違う年度）');
select is((public.invite(tests.id('Y2'), 'ov_rep2@pgtap.test', 'staff') ->> 'applied')::boolean, true,
  'Y1 の店長を Y2 の staff に招待できる（違う年度）');
select is(jsonb_array_length(public.invite(tests.id('Y2'), 'ov_pend@pgtap.test', null, tests.id('G3')) -> 'invitation_ids'), 1,
  'Y1 に未使用の招待があっても、Y2 の団体には招待できる');
select tests.logout();

-- set_role：兼任になればトリガーが止める（閲覧のみの副店長を staff にするなど）。admin は兼ねられる
select tests.login_as('admin');
select is(tests.error_json($$ select public.set_role(tests.id('Y1'), tests.id('ov_view'), 'staff') $$),
  jsonb_build_object('code', 'role_overlap', 'detail', jsonb_build_object('year_id', tests.id('Y1'), 'user_id', tests.id('ov_view'))),
  '閲覧のみの副店長を staff にすると role_overlap（トリガー。detail は年度と人だけ）');
select is(tests.error_json(format($$ select public.set_role(%L, %L, %L) $$, tests.id('Y1'), tests.id('ov_rep2'), r)) ->> 'code',
          'role_overlap', format('閲覧のみの店長を %s にすると role_overlap', r))
from unnest(array['head', 'deputy_head']) r;
select is(tests.error_json($$ select public.set_role(tests.id('Y1'), tests.id('ov_view'), 'admin') $$) ->> 'code', 'ok',
  '閲覧のみの副店長を admin にできる（admin は兼ねられる）');
select tests.logout();
select is((select string_agg(u.name || ':' || yr.role, ' ' order by u.name) from public.year_roles yr
           join tests.ids u on u.id = yr.user_id and u.name in ('ov_view', 'ov_rep2') where yr.year_id = tests.id('Y1')),
  'ov_rep2:viewer ov_view:admin', '止まった set_role はロールを変えない');

-- 招待の受け入れ（accept_my_invitations）：兼任になる招待は飛ばして未使用のまま残し、数えない。例外は出さない
select tests.create_user(n) from unnest(array['ac_rep', 'ac_both', 'ac_years', 'ac_adm']) n;
insert into public.group_members (group_id, user_id, role) values (tests.id('G1'), tests.id('ac_rep'), 'manager');
insert into public.invitations (year_id, email, role) values
  (tests.id('Y1'), 'ac_rep@pgtap.test', 'staff'), (tests.id('Y1'), 'ac_both@pgtap.test', 'staff'),
  (tests.id('Y1'), 'ac_years@pgtap.test', 'staff'), (tests.id('Y1'), 'ac_adm@pgtap.test', 'admin');
insert into public.invitations (year_id, email, group_id, group_role) values
  (tests.id('Y1'), 'ov_staff@pgtap.test', tests.id('G1'), 'manager'), (tests.id('Y1'), 'ac_both@pgtap.test', tests.id('G2'), 'manager'),
  (tests.id('Y2'), 'ac_years@pgtap.test', tests.id('G3'), 'deputy_manager'), (tests.id('Y1'), 'ac_adm@pgtap.test', tests.id('G1'), 'manager');
select tests.login_as('ac_rep');
select is(public.accept_my_invitations(), 0, '店長への同じ年度の staff の招待は受け入れない（0件・例外なし）');
select tests.logout();
select tests.login_as('ov_staff');
select is(public.accept_my_invitations(), 0, 'staff への同じ年度の団体の招待は受け入れない');
select tests.logout();
select tests.login_as('ac_both');
select is(public.accept_my_invitations(), 1, '同じ年度の staff と団体の招待が両方あれば、ロールの招待だけを受け入れる（1回の呼び出しの中でも順に効く）');
select is(public.accept_my_invitations(), 0, '残した招待は次のログインでも受け入れない');
select tests.logout();
select tests.login_as('ac_years');
select is(public.accept_my_invitations(), 2, '違う年度の staff と団体の招待は両方受け入れる');
select tests.logout();
select tests.login_as('ac_adm');
select is(public.accept_my_invitations(), 2, 'admin のロールの招待と同じ年度の団体の招待は両方受け入れる');
select tests.logout();
select is((select string_agg(email || ':' || (used_at is not null)::text, ' ' order by email, role nulls last)
           from public.invitations where email in ('ac_rep@pgtap.test', 'ov_staff@pgtap.test', 'ac_both@pgtap.test')
             and year_id = tests.id('Y1')),
  'ac_both@pgtap.test:true ac_both@pgtap.test:false ac_rep@pgtap.test:false ov_staff@pgtap.test:false',
  '飛ばした招待は未使用のまま（ac_both は staff の招待だけ使用済み）');
select is((select count(*)::int from public.year_roles yr join tests.ids u on u.id = yr.user_id
           where u.name in ('ac_rep', 'ac_both') and yr.year_id = tests.id('Y1') and yr.role = 'staff')
          + (select count(*)::int from public.group_members gm join tests.ids u on u.id = gm.user_id
             where u.name in ('ov_staff', 'ac_both') and gm.group_id in (tests.id('G1'), tests.id('G2'))), 1,
  '兼任は作られない（ac_both の staff だけが付く）');
select is((select role from public.group_members where group_id = tests.id('G3') and user_id = tests.id('ac_years')),
  'deputy_manager'::public.group_role, '違う年度の団体の招待は、招待の立場（副店長）で付く');

-- ================================================================ ロールを外したとき・変えたとき（T20。D-56）：シフト・作業
-- 割り当ての (year_id, user_id) → year_roles は on delete cascade、作業の担当者は on delete set null (assignee_id)。remove_role の連鎖が、
-- その年度のその人の割り当てを消し、作業の担当者を空にする（状態はそのまま）。連鎖の行の監査に remove_role の理由・外した人・年度が残る。
-- ほかの年度の割り当て・作業は残る。set_role で部門長にしても、閲覧のみにしても行は残る（閲覧のみの人を新しく割り当てるのは not_soumu）。
-- 終了した年度の remove_role も連鎖する（year_roles・remove_role・set_role は T20 で変えていない）
select tests.set_scenario('requesting');
select tests.create_user(n) from unnest(array['sh_a', 'sh_b', 'sh_c']) n;
insert into public.year_roles (year_id, user_id, role) values
  (tests.id('Y1'), tests.id('sh_a'), 'staff'), (tests.id('Y2'), tests.id('sh_a'), 'staff'),
  (tests.id('Y1'), tests.id('sh_b'), 'staff'), (tests.id('Y1'), tests.id('sh_c'), 'staff');
insert into public.shift_assignments (year_id, slot_id, duty_id, user_id) values
  (tests.id('Y1'), tests.id('SL1'), tests.id('DU1'), tests.id('sh_a')),
  (tests.id('Y1'), tests.id('SL2'), tests.id('DU1'), tests.id('sh_a')),
  (tests.id('Y2'), tests.id('SL_Y2B'), tests.id('DU_Y2'), tests.id('sh_a')),
  (tests.id('Y1'), tests.id('SL2'), tests.id('DU1'), tests.id('sh_b')),
  (tests.id('Y1'), tests.id('SL1'), tests.id('DU2'), tests.id('sh_c'));
with t as (
  insert into public.tasks (year_id, title, assignee_id, status) values
    (tests.id('Y1'), 'T-TK_SHA', tests.id('sh_a'), 'doing'),
    (tests.id('Y2'), 'T-TK_SHA_Y2', tests.id('sh_a'), 'todo'),
    (tests.id('Y1'), 'T-TK_SHB', tests.id('sh_b'), 'todo'),
    (tests.id('Y1'), 'T-TK_SHC', tests.id('sh_c'), 'done')
  returning id, title)
insert into tests.ids select substr(title, 3), id from t;
select coalesce(max(id), 0) as r0 from public.audit_logs \gset
select tests.login_as('admin');
select lives_ok($$ select public.remove_role(tests.id('Y1'), tests.id('sh_a'), '交代（シフト）') $$,
  'シフトの割り当てと作業の担当のある staff のロールを外せる');
select tests.logout();
select is((select format('Y1=%s Y2=%s', count(*) filter (where year_id = tests.id('Y1')), count(*) filter (where year_id = tests.id('Y2')))
           from public.shift_assignments where user_id = tests.id('sh_a')),
  'Y1=0 Y2=1', 'ロールを外すと、その年度（Y1）の割り当て2つが消え、ほかの年度（Y2）の割り当ては残る');
select is((select format('%s %s %s %s', coalesce(assignee_id::text, 'null'), status, (year_id = tests.id('Y1'))::text, (updated_by = tests.id('admin'))::text)
           from public.tasks where id = tests.id('TK_SHA')),
  'null doing true true', 'その年度の作業の担当者が空になる（状態〔作業中〕・年度はそのまま。updated_by は外した人）');
select is((select assignee_id from public.tasks where id = tests.id('TK_SHA_Y2')), tests.id('sh_a'), 'ほかの年度（Y2）の作業の担当者は残る');
select is((select string_agg(format('%s %s %s %s %s', table_name, action, coalesce(reason, 'null'), (user_id = tests.id('admin'))::text,
                                    (year_id = tests.id('Y1'))::text), ' / ' order by table_name collate "C", action collate "C", id)
           from public.audit_logs where id > :r0 and table_name in ('shift_assignments', 'tasks', 'year_roles')),
  'shift_assignments delete 交代（シフト） true true / shift_assignments delete 交代（シフト） true true / tasks update 交代（シフト） true true / '
  || 'year_roles delete 交代（シフト） true true',
  'remove_role の理由・外した人・年度が、year_roles と、連鎖で消えた割り当て・担当者を空にした作業の監査に残る');
select tests.login_as('admin');
select lives_ok($$ select public.set_role(tests.id('Y1'), tests.id('sh_b'), 'head', '部門長に') $$, '割り当てと作業の担当のある staff を部門長にする');
select tests.logout();
select is((select format('%s %s', (select count(*) from public.shift_assignments where user_id = tests.id('sh_b')),
                         (select (assignee_id = tests.id('sh_b'))::text from public.tasks where id = tests.id('TK_SHB')))),
  '1 true', '部門長にしても、割り当てと作業の担当は残る');
select tests.login_as('admin');
select lives_ok($$ select public.set_role(tests.id('Y1'), tests.id('sh_b'), 'viewer', '閲覧のみに') $$, '閲覧のみにする（管理者だけ）');
select tests.logout();
select is((select format('%s %s', (select count(*) from public.shift_assignments where user_id = tests.id('sh_b')),
                         (select (assignee_id = tests.id('sh_b'))::text from public.tasks where id = tests.id('TK_SHB')))),
  '1 true', '閲覧のみにしても、割り当てと作業の担当の行は残る（画面が「総務でない人」と出し、人数に数えない。D-56）');
select tests.login_as('admin');
select is(tests.error_json(tests.sql('insert into public.shift_assignments (year_id, slot_id, duty_id, user_id) values (:Y1, :SL1, :DU1, :sh_b)')),
  '{"code": "invalid_input", "detail": {"field": "user_id", "reason": "not_soumu"}}'::jsonb, '閲覧のみにした人を新しく割り当てることはできない（not_soumu）');
select tests.logout();
select tests.set_scenario('closed');
select coalesce(max(id), 0) as r1 from public.audit_logs \gset
select tests.login_as('admin');
select lives_ok($$ select public.remove_role(tests.id('Y1'), tests.id('sh_c'), '年度末') $$, '終了した年度でも、割り当てと作業の担当のある人のロールを外せる');
select tests.logout();
select is((select format('%s %s %s', (select count(*) from public.shift_assignments where user_id = tests.id('sh_c')),
                         coalesce(t.assignee_id::text, 'null'), t.status) from public.tasks t where t.id = tests.id('TK_SHC')),
  '0 null done', '終了した年度の remove_role も連鎖する（割り当てが消え、作業の担当者が空になる。状態〔完了〕はそのまま）');
select is((select count(*)::int from public.audit_logs
           where id > :r1 and table_name in ('shift_assignments', 'tasks') and reason = '年度末' and user_id = tests.id('admin')), 2,
  '終了した年度の連鎖の監査にも、理由と外した人が残る');
select tests.set_scenario('requesting');

select * from finish();
rollback;
