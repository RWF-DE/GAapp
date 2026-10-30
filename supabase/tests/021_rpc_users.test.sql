-- 021_rpc_users：invite、set_role、remove_role、revoke_invitation、remove_group_member、accept_my_invitations（T03）
-- auth.users のトリガー（0007）とフックは 030_auth（T04）で確かめる。ここでは RPC の中での招待の受け入れを確かめる。
-- 招待を付けるのは、今のメールが本人のものと確かめられるアカウントだけ（private.verified_email、D-17a）。
begin;
\ir _helpers/personas.psql
\ir _helpers/fixture.psql
select plan(97);

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
select is(jsonb_array_length(public.invite(tests.id('Y1'), 'new@pgtap.test', 'staff', tests.id('G1')) -> 'invitation_ids'), 2,
  'ロールと団体の両方なら招待は2つ');
select is((public.invite(tests.id('Y1'), 'new@pgtap.test', 'viewer') ->> 'applied')::boolean, false, '未登録は招待だけ（applied: false）');
select tests.logout();
select is((select role from public.invitations where email = 'new@pgtap.test' and role is not null and used_at is null), 'viewer'::public.app_role,
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
insert into public.invitations (year_id, email, group_id, used_at) values (tests.id('Y1'), 'rep2@pgtap.test', tests.id('G2'), now());
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
insert into public.invitations (year_id, email, group_id) values (tests.id('Y1'), 'victim@pgtap.test', tests.id('G1'));
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

select * from finish();
rollback;
