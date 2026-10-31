-- 014_role_overlap：兼任の禁止（T15。D-49。0013 のトリガー check_role_overlap と補助の関数）と、ロックの順（T15 のレビュー）
-- 同じ年度で、部門のロール（head・deputy_head・staff）を year_roles に持つ人は、その年度の団体の group_members に入れない。
-- admin と viewer は入れる。違う年度ならよい。ここでは postgres のまま直接書いて、トリガーそのものを確かめる
-- （RPC の早めのエラーと招待の受け入れは 021・024・030、同時に書いたときは notes/T15.md の「同時に書いたときの確かめ」）。
-- fixture：staff は Y1 の staff で Y2 の G3 の店長、viewer は Y1 の viewer で G4 の副店長、rep は G1（Y1）の店長、
-- head・deputy は Y1 の部門長・副部門長。
begin;
\ir _helpers/personas.psql
\ir _helpers/fixture.psql
select plan(50);

-- このトランザクションが、年度と人の組の勧告的ロック（private.lock_year_member）を持っているか。
-- pg_advisory_xact_lock(int4, int4) は pg_locks に locktype = 'advisory'、classid と objid に符号なしの数、objsubid = 2 で出る
create function tests.holds_year_member_lock(p_year_id uuid, p_user_id uuid) returns boolean language sql as $$
  select exists (
    select 1 from pg_locks l
    where l.locktype = 'advisory' and l.pid = pg_backend_pid() and l.granted and l.objsubid = 2
      and l.classid::bigint = (hashtext('gaapp.year_member')::bigint & 4294967295)
      and l.objid::bigint = (hashtext(p_year_id::text || '/' || p_user_id::text)::bigint & 4294967295))
$$;

-- ---------------------------------------------------------------- 両方の向き（insert）
select is(tests.error_json(format($$ insert into public.group_members (group_id, user_id) values (%L, %L) $$, tests.id('G1'), tests.id('staff'))),
  jsonb_build_object('code', 'role_overlap', 'detail', jsonb_build_object('year_id', tests.id('Y1'), 'user_id', tests.id('staff'))),
  'Y1 の staff を Y1 の団体代表にすると role_overlap（detail は年度と人だけ。メールは入れない）');
select is(tests.error_json(format($$ insert into public.group_members (group_id, user_id, role) values (%L, %L, 'deputy_manager') $$,
                                  tests.id('G2'), tests.id(p))) ->> 'code',
          'role_overlap', format('Y1 の %s を Y1 の副店長にしても role_overlap', p))
from unnest(array['head', 'deputy']) p;
select is(tests.error_json(format($$ insert into public.year_roles (year_id, user_id, role) values (%L, %L, %L) $$,
                                  tests.id('Y1'), tests.id('rep'), r)),
          jsonb_build_object('code', 'role_overlap', 'detail', jsonb_build_object('year_id', tests.id('Y1'), 'user_id', tests.id('rep'))),
          format('Y1 の店長に Y1 の %s を付けると role_overlap', r))
from unnest(array['staff', 'head', 'deputy_head']) r;

-- ---------------------------------------------------------------- update の道
select is(tests.error_json(format($$ update public.year_roles set role = %L where year_id = %L and user_id = %L $$,
                                  r, tests.id('Y1'), tests.id('viewer'))) ->> 'code',
          'role_overlap', format('閲覧のみの副店長（viewer）のロールを %s に変えると role_overlap', r))
from unnest(array['staff', 'head', 'deputy_head']) r;
select is(tests.error_json(format($$ update public.year_roles set user_id = %L where year_id = %L and user_id = %L $$,
                                  tests.id('rep'), tests.id('Y1'), tests.id('staff'))),
  jsonb_build_object('code', 'role_overlap', 'detail', jsonb_build_object('year_id', tests.id('Y1'), 'user_id', tests.id('rep'))),
  'staff の year_roles の行を、同じ年度の店長に付け替えると role_overlap');
select is(tests.error_json(format($$ update public.group_members set user_id = %L where group_id = %L and user_id = %L $$,
                                  tests.id('staff'), tests.id('G1'), tests.id('rep'))),
  jsonb_build_object('code', 'role_overlap', 'detail', jsonb_build_object('year_id', tests.id('Y1'), 'user_id', tests.id('staff'))),
  '店長の group_members の行を、同じ年度の staff に付け替えると role_overlap');
select is(tests.error_json(format($$ update public.group_members set group_id = %L where group_id = %L and user_id = %L $$,
                                  tests.id('G2'), tests.id('G1'), tests.id('rep'))) ->> 'code',
  'invalid_input', '団体の付け替えは、兼任の確かめより先に check_immutable が invalid_input で止める（名前の順）');
select is((select string_agg(t.name || ':' || yr.role, ' ' order by t.name) from public.year_roles yr join tests.ids t on t.id = yr.user_id
           where yr.year_id = tests.id('Y1') and t.name in ('staff', 'viewer', 'rep')),
  'staff:staff viewer:viewer', '止まった書き込みは何も変えない');

-- ---------------------------------------------------------------- 兼ねてよいもの
select ok(exists (select 1 from public.group_members gm join public.year_roles yr on yr.user_id = gm.user_id and yr.year_id = tests.id('Y1')
                  where gm.group_id = tests.id('G4') and gm.user_id = tests.id('viewer') and gm.role = 'deputy_manager' and yr.role = 'viewer'),
  'viewer と副店長は同じ年度で兼ねられる（fixture の G4）');
select lives_ok(format($$ insert into public.group_members (group_id, user_id) values (%L, %L) $$, tests.id('G2'), tests.id('admin')),
  'admin と店長は同じ年度で兼ねられる');
select lives_ok(format($$ insert into public.group_members (group_id, user_id) values (%L, %L) $$, tests.id('G1'), tests.id('viewer')),
  'viewer は同じ年度の2つ目の団体の店長にもなれる');
select lives_ok(format($$ update public.year_roles set role = 'admin' where year_id = %L and user_id = %L $$, tests.id('Y1'), tests.id('viewer')),
  '団体代表の viewer を admin に変えられる');
select lives_ok(format($$ update public.year_roles set role = 'viewer' where year_id = %L and user_id = %L $$, tests.id('Y1'), tests.id('viewer')),
  '団体代表の admin を viewer に戻せる（admin・viewer のあいだは自由）');
select ok(exists (select 1 from public.group_members gm join public.groups g on g.id = gm.group_id
                  join public.year_roles yr on yr.user_id = gm.user_id and yr.year_id = tests.id('Y1')
                  where gm.user_id = tests.id('staff') and g.year_id = tests.id('Y2') and yr.role = 'staff'),
  '違う年度なら staff と店長を兼ねられる（fixture：Y1 の staff が Y2 の G3 の店長）');
select tests.create_user(n) from unnest(array['oy_role_first', 'oy_group_first', 'conv']) n;
insert into public.year_roles (year_id, user_id, role) values (tests.id('Y1'), tests.id('oy_role_first'), 'head');
select lives_ok(format($$ insert into public.group_members (group_id, user_id) values (%L, %L) $$, tests.id('G3'), tests.id('oy_role_first')),
  '違う年度：Y1 の部門長を、あとから Y2 の団体代表にできる');
insert into public.group_members (group_id, user_id) values (tests.id('G1'), tests.id('oy_group_first'));
select lives_ok(format($$ insert into public.year_roles (year_id, user_id, role) values (%L, %L, 'deputy_head') $$, tests.id('Y2'), tests.id('oy_group_first')),
  '違う年度：Y1 の店長に、あとから Y2 の副部門長を付けられる');
-- staff を外せば（ここでは viewer に変えれば）団体代表になれ、団体代表のまま staff に戻すのは止まる
insert into public.year_roles (year_id, user_id, role) values (tests.id('Y1'), tests.id('conv'), 'staff');
select is(tests.error_json(format($$ insert into public.group_members (group_id, user_id) values (%L, %L) $$, tests.id('G2'), tests.id('conv'))) ->> 'code',
  'role_overlap', '準備：staff のままでは団体代表になれない');
select lives_ok(format($$ update public.year_roles set role = 'viewer' where year_id = %L and user_id = %L $$, tests.id('Y1'), tests.id('conv')),
  'staff → viewer は、団体代表でなければ通る（向きによらず確かめる）');
select lives_ok(format($$ insert into public.group_members (group_id, user_id) values (%L, %L) $$, tests.id('G2'), tests.id('conv')),
  'viewer になった後なら団体代表になれる');
select is(tests.error_json(format($$ update public.year_roles set role = 'staff' where year_id = %L and user_id = %L $$, tests.id('Y1'), tests.id('conv'))) ->> 'code',
  'role_overlap', '団体代表のまま staff に戻すのは role_overlap（viewer → staff）');

-- ---------------------------------------------------------------- 店長⇄副店長はトリガーを動かさない
select lives_ok(format($$ update public.group_members set role = 'deputy_manager' where group_id = %L and user_id = %L $$, tests.id('G1'), tests.id('rep')),
  '店長 → 副店長（role だけの更新）は通る');
select is((select string_agg(a.attname, ',' order by a.attnum) from pg_trigger t
           join pg_attribute a on a.attrelid = t.tgrelid and a.attnum = any (t.tgattr::int2[])
           where t.tgname = 'check_role_overlap' and t.tgrelid = 'public.group_members'::regclass),
  'group_id,user_id', 'group_members のトリガーの列は group_id・user_id だけ（role の更新では動かない）');
select is((select string_agg(a.attname, ',' order by a.attnum) from pg_trigger t
           join pg_attribute a on a.attrelid = t.tgrelid and a.attnum = any (t.tgattr::int2[])
           where t.tgname = 'check_role_overlap' and t.tgrelid = 'public.year_roles'::regclass),
  'user_id,role', 'year_roles のトリガーの列は user_id・role');
-- トリガーを一時的に止めて兼任の行を作り（0013 より前のデータの代わり）、role だけの更新では動かず、user_id を書く更新では動くことを見る
alter table public.group_members disable trigger check_role_overlap;
insert into public.group_members (group_id, user_id) values (tests.id('G2'), tests.id('staff'));
alter table public.group_members enable trigger check_role_overlap;
select lives_ok(format($$ update public.group_members set role = 'deputy_manager' where group_id = %L and user_id = %L $$, tests.id('G2'), tests.id('staff')),
  '兼任している行でも、role だけの更新はトリガーを動かさない');
select is(tests.error_json(format($$ update public.group_members set user_id = user_id where group_id = %L and user_id = %L $$,
                                  tests.id('G2'), tests.id('staff'))) ->> 'code',
  'role_overlap', 'user_id を set に書けば（値が同じでも）トリガーが動く');
delete from public.group_members where group_id = tests.id('G2') and user_id = tests.id('staff');

-- ---------------------------------------------------------------- 外部キーのエラーは外部キーのまま
select throws_ok(format($$ insert into public.group_members (group_id, user_id) values (gen_random_uuid(), %L) $$, tests.id('staff')),
  '23503', null, '団体がなければ外部キーのエラー（role_overlap にしない）');
select throws_ok(format($$ insert into public.year_roles (year_id, user_id, role) values (gen_random_uuid(), %L, 'staff') $$, tests.id('rep')),
  '23503', null, '年度がなければ外部キーのエラー');

-- ---------------------------------------------------------------- ロックの鍵
select tests.create_user(n) from unnest(array['lk_role', 'lk_group']) n;
select ok(not tests.holds_year_member_lock(tests.id('Y2'), tests.id('lk_role')) and not tests.holds_year_member_lock(tests.id('Y2'), tests.id('lk_group')),
  '前提：まだ書いていない組のロックは持っていない');
insert into public.year_roles (year_id, user_id, role) values (tests.id('Y2'), tests.id('lk_role'), 'viewer');
select ok(tests.holds_year_member_lock(tests.id('Y2'), tests.id('lk_role')),
  'year_roles に書くと、このトランザクションは（年度・人）の勧告的ロックを持つ（gaapp.year_member、hashtext(年度 || ''/'' || 人)）');
select ok(not tests.holds_year_member_lock(tests.id('Y1'), tests.id('lk_role')), 'ほかの年度の組のロックは取らない');
insert into public.group_members (group_id, user_id) values (tests.id('G3'), tests.id('lk_group'));
select ok(tests.holds_year_member_lock(tests.id('Y2'), tests.id('lk_group')), 'group_members に書くと、団体の年度と人のロックを持つ');

-- ---------------------------------------------------------------- 書き方の決まり
-- 年度の行をロックしない（lock_year・lock_year_guard も、for share・for update・for no key update も使わない）
select is_empty($$ select p.proname::text from pg_proc p
                   where p.oid in ('private.tg_year_roles_check_overlap()'::regprocedure, 'private.tg_group_members_check_overlap()'::regprocedure,
                                   'private.lock_year_member(uuid, uuid)'::regprocedure,
                                   'private.year_member_has_department_role(uuid, uuid)'::regprocedure,
                                   'private.year_member_in_group(uuid, uuid)'::regprocedure)
                     and p.prosrc ~* '(for\s+(share|update|no\s+key\s+update))|lock_year\s*\(|lock_year_guard' $$,
  'トリガー関数と補助の本体に、年度の行のロック（lock_year・lock_year_guard・for share・for update・for no key update）がない');
-- 補助は VOLATILE（ロックを待った後で、待っている間に確定した行を読む）。表を読む2つは SECURITY DEFINER、ロックだけの1つは INVOKER
select is((select string_agg(p.proname || ':' || p.provolatile::text || ':' || p.prosecdef::text, ' ' order by p.proname) from pg_proc p
           where p.pronamespace = 'private'::regnamespace
             and p.proname in ('lock_year_member', 'year_member_has_department_role', 'year_member_in_group')),
  'lock_year_member:v:false year_member_has_department_role:v:true year_member_in_group:v:true',
  '兼任の補助は VOLATILE（表を読む2つは SECURITY DEFINER）');
select ok((select bool_and(p.prosecdef and p.provolatile = 'v' and coalesce(p.proconfig @> array['search_path=""'], false)) from pg_proc p
           where p.oid in ('private.tg_year_roles_check_overlap()'::regprocedure, 'private.tg_group_members_check_overlap()'::regprocedure)),
  'トリガー関数は SECURITY DEFINER・VOLATILE・search_path = ""');
select is_empty($$ select p.oid::regprocedure::text from pg_proc p
                   where p.pronamespace = 'private'::regnamespace
                     and p.proname in ('lock_year_member', 'year_member_has_department_role', 'year_member_in_group',
                                       'tg_year_roles_check_overlap', 'tg_group_members_check_overlap')
                     and (has_function_privilege('authenticated', p.oid, 'execute') or has_function_privilege('anon', p.oid, 'execute')) $$,
  '兼任の補助とトリガー関数は authenticated・anon が実行できない（任意の人について答えるため）');
select tests.login_as('staff');
select throws_ok(format($$ select private.year_member_in_group(%L, %L) $$, tests.id('Y1'), tests.id('rep')), '42501', null,
  'ログインした人は補助を呼べない（42501）');
select tests.logout();

-- ---------------------------------------------------------------- ロックの順（T15 のレビュー）
-- 招待・ロール・団体代表を書く関数は、どれも「年度の行（lock_year）→ そのメールの未使用の招待の行（apply_invitations の並び）→
-- 年度と人の勧告的ロック（lock_year_member）→ year_roles・group_members の行」の順にロックを取る（0013 の「ロックの順」）。
-- 逆の順の組があるとデッドロックする（invite が勧告的ロックの後で招待の行を待ち、受け入れが招待の行の後で勧告的ロックを待つ。
-- remove_role が year_roles の後で招待の行を待ち、受け入れが招待の行の後で year_roles を待つ）。2つのセッションの同時の実行は
-- pgTAP では流せないので、関数の本体の並びと、ロックを取っていることで確かめる（2つのセッションでの確かめは notes/T15.md の
-- 「レビューで直したこと」）
create function tests.fn_at(p_fn regprocedure, p_needle text) returns integer language sql stable as $$
  select strpos(lower(p.prosrc), lower(p_needle)) from pg_proc p where p.oid = p_fn
$$;
select ok(tests.fn_at('public.invite(uuid, text, public.app_role, uuid, public.group_role)', 'for update of i') > 0
          and tests.fn_at('public.invite(uuid, text, public.app_role, uuid, public.group_role)', 'for update of i')
              < tests.fn_at('public.invite(uuid, text, public.app_role, uuid, public.group_role)', 'private.lock_year_member(')
          and tests.fn_at('public.invite(uuid, text, public.app_role, uuid, public.group_role)', 'private.lock_year_member(')
              < tests.fn_at('public.invite(uuid, text, public.app_role, uuid, public.group_role)', 'insert into public.invitations'),
  'invite：そのメールの招待の行をロックしてから勧告的ロックを取り、その後で招待を書く');
select ok(tests.fn_at('private.apply_invitations(uuid, text)', 'for update of i') > 0
          and tests.fn_at('private.apply_invitations(uuid, text)', 'for update of i')
              < tests.fn_at('private.apply_invitations(uuid, text)', 'private.lock_year_member('),
  '受け入れ（apply_invitations）：招待の行をロックしてから勧告的ロックを取る');
select is((select count(*)::int from pg_proc p
           where p.oid in ('public.invite(uuid, text, public.app_role, uuid, public.group_role)'::regprocedure,
                           'private.apply_invitations(uuid, text)'::regprocedure)
             and p.prosrc ~* 'join public\.years y on y\.id = i\.year_id\s+where i\.email = [^;]* and i\.used_at is null and y\.status <> ''closed''\s+order by i\.created_at, \(i\.role is null\), i\.id\s+for update of i'),
  2, 'invite と受け入れは、同じ条件（closed でない年度の未使用の招待）・同じ並びで招待の行をロックする');
select ok(tests.fn_at('public.remove_role(uuid, uuid, text)', 'delete from public.invitations') > 0
          and tests.fn_at('public.remove_role(uuid, uuid, text)', 'delete from public.invitations')
              < tests.fn_at('public.remove_role(uuid, uuid, text)', 'delete from public.year_roles'),
  'remove_role：招待を消してから year_roles を消す（受け入れと同じ「招待の行 → year_roles」）');
select is_empty($$ select p.oid::regprocedure::text from pg_proc p
                   where p.oid in ('public.set_role(uuid, uuid, public.app_role, text)'::regprocedure,
                                   'public.remove_group_member(uuid, uuid, text)'::regprocedure,
                                   'public.set_group_member_role(uuid, uuid, public.group_role, text)'::regprocedure,
                                   'private.tg_year_roles_check_overlap()'::regprocedure,
                                   'private.tg_group_members_check_overlap()'::regprocedure,
                                   'private.lock_year_member(uuid, uuid)'::regprocedure)
                     and p.prosrc ~* 'public\.invitations' $$,
  '勧告的ロックを取る関数（set_role・トリガー）と、団体代表だけを書く RPC は、招待の行に触れない（勧告的ロックの後で招待の行を待たない）');
select is_empty($$ select p.oid::regprocedure::text from pg_proc p
                   where p.oid in ('public.remove_role(uuid, uuid, text)'::regprocedure, 'public.revoke_invitation(uuid)'::regprocedure)
                     and p.prosrc ~* 'lock_year_member' $$,
  '招待の行を消す RPC（remove_role・revoke_invitation）は勧告的ロックを取らない');
-- 実際にロックを取っていること：確かめられるアカウントのないメールを招待しても（中の受け入れは動かない）、そのメールの
-- ほかの年度（closed でない）の未使用の招待の行を、このトランザクションがロックする（xmax がこのトランザクション）
with i as (insert into public.invitations (year_id, email, role) values (tests.id('Y2'), 'lo_pending@pgtap.test', 'staff') returning id)
insert into tests.ids select 'INV_LO_Y2', id from i;
select is((select xmax::text from public.invitations where id = tests.id('INV_LO_Y2')), '0',
  '前提：ほかの年度の未使用の招待の行は、まだロックされていない');
select tests.login_as('admin');
select is(public.invite(tests.id('Y1'), 'lo_pending@pgtap.test', 'viewer') ->> 'applied', 'false',
  '準備：管理者が同じメールを Y1 に招待する（アカウントがないので、その場では付かない）');
select tests.logout();
select is((select xmax::text from public.invitations where id = tests.id('INV_LO_Y2')),
          (pg_current_xact_id()::text::bigint % 4294967296)::text,
  'invite は、そのメールのほかの年度の未使用の招待の行もロックする（中の受け入れが触る行を、勧告的ロックより先に取る）');

select * from finish();
rollback;
