-- 024_rpc_lead_tier：RPC の段（T15。D-48。notes/T15.md の「権限の段」と「SQL の約束」の RPC）
-- 全部の RPC を、admin・head（総務部門長）・deputy（総務副部門長）・staff・viewer・rep・outsider・admin2 で呼び、段の表のとおりに
-- 通るか、どのエラーになるかを確かめる（tests.try_rpc：1回ずつ試して取り消す）。期待値は「段」から書いた：
--   管理者だけ：admin・head・deputy_head・viewer の招待・付ける・外す・取り消し、終了（closed）、年度名・1日目、年度の作成
--   部門長以上：staff と団体代表（店長・副店長）の招待・付ける・外す・取り消し、店長⇄副店長、状態の遷移（closed を除く）、受付期間、
--              振り分けの保存、了承の記録、申請の代理入力・締切後の修正・前年度の申請
--   総務：運搬・返却のチェック、前年度の在庫
-- yn は列の順（admin head staff viewer rep outsider admin2）に、空白で区切った7つの結果。deputy は head の列で確かめる（文字を写さない）。
-- 略号：ok、F＝forbidden、NF＝not_found、IS＝invalid_state、II＝invalid_input、RO＝role_overlap。
-- 兼任の禁止の管理者の経路は 021、トリガーは 014。
begin;
\ir _helpers/personas.psql
\ir _helpers/fixture.psql

-- 相手と招待（fixture に足す）：v_plain は Y1 の viewer（団体代表でない）、a_extra は Y1 の2人目の admin、none1 はロールなし、
-- st_target は Y1 の staff。未使用の招待：viewer・head・deputy_head のロールの招待と、団体（G2）の招待
select tests.create_user(n) from unnest(array['v_plain', 'a_extra', 'none1', 'st_target', 'none2']) n;
insert into public.year_roles (year_id, user_id, role) values
  (tests.id('Y1'), tests.id('v_plain'), 'viewer'), (tests.id('Y1'), tests.id('a_extra'), 'admin'),
  (tests.id('Y1'), tests.id('st_target'), 'staff');
with i as (
  insert into public.invitations (year_id, email, role) values
    (tests.id('Y1'), 'tier_viewer@pgtap.test', 'viewer'), (tests.id('Y1'), 'tier_head@pgtap.test', 'head'),
    (tests.id('Y1'), 'tier_dep@pgtap.test', 'deputy_head')
  returning id, role)
insert into tests.ids select case role when 'viewer' then 'INV_VIEWER' when 'head' then 'INV_HEAD' else 'INV_DEPUTY' end, id from i;
with i as (
  insert into public.invitations (year_id, email, group_id, group_role) values (tests.id('Y1'), 'tier_grp@pgtap.test', tests.id('G2'), 'manager')
  returning id)
insert into tests.ids select 'INV_GROUP', id from i;
insert into tests.ids select 'INV_STAFF', id from public.invitations where email = 'someone@pgtap.test';
insert into tests.ids select 'INV_USED_STAFF', id from public.invitations where email = 'staff@pgtap.test' and role = 'staff';
insert into tests.ids select 'INV_USED_VIEWER', id from public.invitations where email = 'viewer@pgtap.test' and role = 'viewer';

create table tests.rpc_case (n int primary key, label text not null, scenario text not null, template text not null, yn text not null);
insert into tests.rpc_case values
 -- invite（role か団体。部門長・副部門長は staff と団体だけ。未使用の staff 以外のロールの招待は上書きさせない）
 ( 1, 'invite staff', 'requesting', $t$ select public.invite(:Y1, 'tier_new@pgtap.test', 'staff') $t$, 'ok ok F F F F F'),
 ( 2, 'invite viewer', 'requesting', $t$ select public.invite(:Y1, 'tier_new@pgtap.test', 'viewer') $t$, 'ok F F F F F F'),
 ( 3, 'invite admin', 'requesting', $t$ select public.invite(:Y1, 'tier_new@pgtap.test', 'admin') $t$, 'ok F F F F F F'),
 ( 4, 'invite head', 'requesting', $t$ select public.invite(:Y1, 'tier_new@pgtap.test', 'head') $t$, 'ok F F F F F F'),
 ( 5, 'invite deputy_head', 'requesting', $t$ select public.invite(:Y1, 'tier_new@pgtap.test', 'deputy_head') $t$, 'ok F F F F F F'),
 ( 6, 'invite 団体（既定の店長）', 'requesting', $t$ select public.invite(:Y1, 'tier_new@pgtap.test', null, :G1) $t$, 'ok ok F F F F F'),
 ( 7, 'invite 団体（副店長）', 'requesting', $t$ select public.invite(:Y1, 'tier_new@pgtap.test', null, :G1, 'deputy_manager') $t$, 'ok ok F F F F F'),
 ( 8, 'invite staff（未使用の admin の招待の上書き）', 'requesting', $t$ select public.invite(:Y1, 'invited_admin@pgtap.test', 'staff') $t$, 'ok F F F F F F'),
 ( 9, 'invite staff（未使用の viewer の招待の上書き）', 'requesting', $t$ select public.invite(:Y1, 'tier_viewer@pgtap.test', 'staff') $t$, 'ok F F F F F F'),
 (10, 'invite staff（未使用の head の招待の上書き）', 'requesting', $t$ select public.invite(:Y1, 'tier_head@pgtap.test', 'staff') $t$, 'ok F F F F F F'),
 (11, 'invite staff（未使用の staff の招待し直し）', 'requesting', $t$ select public.invite(:Y1, 'someone@pgtap.test', 'staff') $t$, 'ok ok F F F F F'),
 (12, 'invite 団体（未使用の admin の招待があるメール）', 'requesting', $t$ select public.invite(:Y1, 'invited_admin@pgtap.test', null, :G2) $t$, 'ok ok F F F F F'),
 (13, 'invite 団体なしで立場', 'requesting', $t$ select public.invite(:Y1, 'tier_new@pgtap.test', 'staff', null, 'manager') $t$, 'II II F F F F F'),
 (14, 'invite closed', 'closed', $t$ select public.invite(:Y1, 'tier_new@pgtap.test', 'staff') $t$, 'IS IS F F F F F'),
 -- set_role（部門長・副部門長は、ロールがないか staff の人に staff を付けるだけ）
 (15, 'set_role staff（ロールなし）', 'requesting', $t$ select public.set_role(:Y1, :none1, 'staff') $t$, 'ok ok F F F F F'),
 (16, 'set_role staff（staff）', 'requesting', $t$ select public.set_role(:Y1, :st_target, 'staff') $t$, 'ok ok F F F F F'),
 (17, 'set_role viewer（ロールなし）', 'requesting', $t$ select public.set_role(:Y1, :none1, 'viewer') $t$, 'ok F F F F F F'),
 (18, 'set_role admin（ロールなし）', 'requesting', $t$ select public.set_role(:Y1, :none1, 'admin') $t$, 'ok F F F F F F'),
 (19, 'set_role head（ロールなし）', 'requesting', $t$ select public.set_role(:Y1, :none1, 'head') $t$, 'ok F F F F F F'),
 (20, 'set_role deputy_head（ロールなし）', 'requesting', $t$ select public.set_role(:Y1, :none1, 'deputy_head') $t$, 'ok F F F F F F'),
 (21, 'set_role staff（viewer）', 'requesting', $t$ select public.set_role(:Y1, :v_plain, 'staff') $t$, 'ok F F F F F F'),
 (22, 'set_role staff（2人目の admin）', 'requesting', $t$ select public.set_role(:Y1, :a_extra, 'staff') $t$, 'ok F F F F F F'),
 (23, 'set_role staff（deputy_head）', 'requesting', $t$ select public.set_role(:Y1, :deputy, 'staff') $t$, 'ok F F F F F F'),
 (24, 'set_role staff（head）', 'requesting', $t$ select public.set_role(:Y1, :head, 'staff') $t$, 'ok F F F F F F'),
 (25, 'set_role role なし', 'requesting', $t$ select public.set_role(:Y1, :none1, null) $t$, 'II II F F F F F'),
 (26, 'set_role いないユーザー', 'requesting', $t$ select public.set_role(:Y1, gen_random_uuid(), 'staff') $t$, 'NF NF F F F F F'),
 (27, 'set_role staff（その年度の店長）', 'requesting', $t$ select public.set_role(:Y1, :rep, 'staff') $t$, 'RO RO F F F F F'),
 (28, 'set_role closed', 'closed', $t$ select public.set_role(:Y1, :none1, 'staff') $t$, 'IS IS F F F F F'),
 -- remove_role（部門長・副部門長は staff だけ。ロールがなければ not_found が先。closed でも外せる）
 (29, 'remove_role staff', 'requesting', $t$ select public.remove_role(:Y1, :st_target) $t$, 'ok ok F F F F F'),
 (30, 'remove_role viewer', 'requesting', $t$ select public.remove_role(:Y1, :v_plain) $t$, 'ok F F F F F F'),
 (31, 'remove_role 2人目の admin', 'requesting', $t$ select public.remove_role(:Y1, :a_extra) $t$, 'ok F F F F F F'),
 (32, 'remove_role deputy_head', 'requesting', $t$ select public.remove_role(:Y1, :deputy) $t$, 'ok F F F F F F'),
 (33, 'remove_role head', 'requesting', $t$ select public.remove_role(:Y1, :head) $t$, 'ok F F F F F F'),
 (34, 'remove_role ロールなし', 'requesting', $t$ select public.remove_role(:Y1, :none1) $t$, 'NF NF F F F F F'),
 (35, 'remove_role staff closed', 'closed', $t$ select public.remove_role(:Y1, :st_target) $t$, 'ok ok F F F F F'),
 -- revoke_invitation（部門長・副部門長は staff のロールの招待と団体の招待だけ。ほかは見つからないときと同じ forbidden）
 (36, 'revoke staff の招待', 'requesting', $t$ select public.revoke_invitation(:INV_STAFF) $t$, 'ok ok F F F F F'),
 (37, 'revoke 団体の招待', 'requesting', $t$ select public.revoke_invitation(:INV_GROUP) $t$, 'ok ok F F F F F'),
 (38, 'revoke admin の招待', 'requesting', $t$ select public.revoke_invitation(:INV_ADMIN) $t$, 'ok F F F F F F'),
 (39, 'revoke viewer の招待', 'requesting', $t$ select public.revoke_invitation(:INV_VIEWER) $t$, 'ok F F F F F F'),
 (40, 'revoke head の招待', 'requesting', $t$ select public.revoke_invitation(:INV_HEAD) $t$, 'ok F F F F F F'),
 (41, 'revoke deputy_head の招待', 'requesting', $t$ select public.revoke_invitation(:INV_DEPUTY) $t$, 'ok F F F F F F'),
 (42, 'revoke 使用済みの staff の招待', 'requesting', $t$ select public.revoke_invitation(:INV_USED_STAFF) $t$, 'IS IS F F F F F'),
 (43, 'revoke 使用済みの viewer の招待', 'requesting', $t$ select public.revoke_invitation(:INV_USED_VIEWER) $t$, 'IS F F F F F F'),
 (44, 'revoke ない招待', 'requesting', $t$ select public.revoke_invitation(gen_random_uuid()) $t$, 'F F F F F F F'),
 (45, 'revoke staff の招待 closed', 'closed', $t$ select public.revoke_invitation(:INV_STAFF) $t$, 'ok ok F F F F F'),
 -- remove_group_member（部門長以上。closed でも）
 (46, 'remove_group_member', 'requesting', $t$ select public.remove_group_member(:G1, :rep) $t$, 'ok ok F F F F F'),
 (47, 'remove_group_member closed', 'closed', $t$ select public.remove_group_member(:G1, :rep) $t$, 'ok ok F F F F F'),
 (48, 'remove_group_member 代表でない人', 'requesting', $t$ select public.remove_group_member(:G1, :staff) $t$, 'NF NF F F F F F'),
 -- set_group_member_role（T15。部門長以上。closed ではできない）
 (49, 'set_group_member_role 店長→副店長', 'requesting', $t$ select public.set_group_member_role(:G1, :rep, 'deputy_manager') $t$, 'ok ok F F F F F'),
 (50, 'set_group_member_role 同じ立場', 'requesting', $t$ select public.set_group_member_role(:G4, :viewer, 'deputy_manager') $t$, 'ok ok F F F F F'),
 (51, 'set_group_member_role 立場なし', 'requesting', $t$ select public.set_group_member_role(:G1, :rep, null) $t$, 'II II F F F F F'),
 (52, 'set_group_member_role 代表でない人', 'requesting', $t$ select public.set_group_member_role(:G1, :staff, 'manager') $t$, 'NF NF F F F F F'),
 (53, 'set_group_member_role ない団体', 'requesting', $t$ select public.set_group_member_role(gen_random_uuid(), :rep, 'manager') $t$, 'F F F F F F F'),
 (54, 'set_group_member_role closed', 'closed', $t$ select public.set_group_member_role(:G1, :rep, 'deputy_manager') $t$, 'IS IS F F F F F'),
 -- 年度（状態の遷移は部門長以上で終了は admin、受付期間は部門長以上で年度名は admin、年度の作成は admin）
 (55, 'set_year_status 締切', 'requesting', $t$ select public.set_year_status(:Y1, 'allocating', '締切') $t$, 'ok ok F F F F F'),
 (56, 'set_year_status 終了', 'confirmed', $t$ select public.set_year_status(:Y1, 'closed', null) $t$, 'ok F F F F F F'),
 (57, 'update_year 締切', 'requesting', $t$ select public.update_year(:Y1, jsonb_build_object('request_close_at', now() + interval '3 day'), null) $t$, 'ok ok F F F F F'),
 (58, 'update_year 年度名', 'requesting', $t$ select public.update_year(:Y1, '{"label": "T-Y1x"}', null) $t$, 'ok F F F F F F'),
 (59, 'create_year_from', 'requesting', $t$ select public.create_year_from(:Y1, 'T-Y9', date '2028-10-01') $t$, 'ok F F F F F F'),
 -- 振り分け・了承・申請（部門長以上）、受け渡しと前年度の在庫（総務）
 (60, 'save_auto_allocations', 'allocating', $t$ select public.save_auto_allocations(:Y1, '[]', 'full', tests.ver()) $t$, 'ok ok F F F F F'),
 (61, 'save_allocation_rows', 'allocating', $t$ select public.save_allocation_rows(:Y1, jsonb_build_array(jsonb_build_object('op', 'insert',
       'sourceRoomId', :R2, 'groupId', :G1, 'itemId', :chair, 'requestedItemId', :chair, 'count', 1)), '段の確かめ') $t$, 'ok ok F F F F F'),
 (62, 'set_consent 依頼', 'allocating', $t$ select public.set_consent(:G1, :desk, :caster_desk, 'asked') $t$, 'ok ok F F F F F'),
 (63, 'submit_requests 代理（preparing）', 'preparing', $t$ select public.submit_requests(:G2, '[]') $t$, 'ok ok F F F F F'),
 (64, 'update_requests_after_deadline', 'allocating', $t$ select public.update_requests_after_deadline(:G1, '[]', '段の確かめ') $t$, 'ok ok F F F F F'),
 (65, 'check_delivery', 'confirmed', $t$ select public.check_delivery(:D_G1, 'done') $t$, 'ok ok ok F F F F'),
 (66, 'previous_year_stocks', 'requesting', $t$ select * from public.previous_year_stocks(:Y1) $t$, 'ok ok ok F F F F'),
 (67, 'previous_year_requests', 'requesting', $t$ select * from public.previous_year_requests(:Y1) $t$, 'ok ok F F F F F'),
 (68, 'accept_my_invitations', 'requesting', $t$ select public.accept_my_invitations() $t$, 'ok ok ok ok ok ok ok');

-- ペルソナと期待値の列。deputy は head の列で確かめる（総務副部門長の権限は総務部門長と同じ。D-48）
create table tests.rpc_persona (persona text primary key, col int not null, ord int not null unique);
insert into tests.rpc_persona values
  ('admin', 1, 1), ('head', 2, 2), ('deputy', 2, 3), ('staff', 3, 4), ('viewer', 4, 5), ('rep', 5, 6), ('outsider', 6, 7), ('admin2', 7, 8);

create view tests.rpc_cells as
select c.n, c.label, c.scenario, p.persona, p.ord,
       case split_part(c.yn, ' ', p.col)
         when 'F' then 'forbidden' when 'NF' then 'not_found' when 'IS' then 'invalid_state'
         when 'II' then 'invalid_input' when 'RO' then 'role_overlap' else split_part(c.yn, ' ', p.col) end as expected,
       tests.sql(c.template) as sql
from tests.rpc_case c cross join tests.rpc_persona p;

select plan((select count(*)::int from tests.rpc_cells) + 3 + 25);

select is_empty($$ select n, yn from tests.rpc_case
                   where array_length(string_to_array(yn, ' '), 1) <> 7
                      or exists (select 1 from unnest(string_to_array(yn, ' ')) t where t not in ('ok', 'F', 'NF', 'IS', 'II', 'RO')) $$,
  '期待値はどの行も7列（admin head staff viewer rep outsider admin2）で、略号は ok・F・NF・IS・II・RO');
select is((select string_agg(persona || '=' || col, ' ' order by ord) from tests.rpc_persona),
  'admin=1 head=2 deputy=2 staff=3 viewer=4 rep=5 outsider=6 admin2=7', 'deputy は head の列で確かめる（8人 × 7列）');

create table tests.rpc_results as
select n, label, scenario, persona, ord, expected, tests.try_rpc(persona, sql, scenario) as got from tests.rpc_cells;

select is(got, expected, format('%s [%s] %s', label, scenario, persona))
from tests.rpc_results
order by n, ord;

select is_empty($$ select h.n, h.label, h.got as head, d.got as deputy
                   from tests.rpc_results h join tests.rpc_results d using (n)
                   where h.persona = 'head' and d.persona = 'deputy' and h.got is distinct from d.got $$,
  'deputy（総務副部門長）は全部の RPC で head（総務部門長）と同じ結果');

-- ---------------------------------------------------------------- 管理者の招待を上書きさせない（invite の 5）
select tests.login_as('head');
select throws_ok($$ select public.invite(tests.id('Y1'), 'invited_admin@pgtap.test', 'staff') $$, 'P0001', 'forbidden',
  '部門長は、未使用の admin の招待があるメールを staff で招待できない');
select tests.logout();
select is((select role::text || ' used=' || (used_at is not null)::text from public.invitations where id = tests.id('INV_ADMIN')),
  'admin used=false', 'admin の招待は admin のまま（未使用）');

-- ---------------------------------------------------------------- 団体の招待の立場
select tests.login_as('head');
select is(jsonb_array_length(public.invite(tests.id('Y1'), 'lead_grp@pgtap.test', null, tests.id('G1'), 'deputy_manager') -> 'invitation_ids'), 1,
  '部門長は団体に副店長として招待できる');
select tests.logout();
select tests.login_as('deputy');
select is(public.invite(tests.id('Y1'), 'lead_grp@pgtap.test', null, tests.id('G1')) ->> 'applied', 'false',
  '副部門長が店長（立場を省く）で招待し直す');
select tests.logout();
select is((select string_agg(group_role::text, ' ') from public.invitations where email = 'lead_grp@pgtap.test' and used_at is null),
  'manager', '招待し直すと立場が変わる（未使用の招待は1件のまま）');

-- ---------------------------------------------------------------- 部門長が staff を付けて、副部門長が外す
select tests.login_as('head');
select is((public.invite(tests.id('Y1'), 'none2@pgtap.test', 'staff') ->> 'applied')::boolean, true,
  '部門長が、確かめられたアカウントを staff に招待すると、その場で付く');
select tests.logout();
select is((select role from public.year_roles where year_id = tests.id('Y1') and user_id = tests.id('none2')), 'staff'::public.app_role,
  'none2 は Y1 の staff');
-- 外すと、その人あての未使用のロールの招待も消える（0009）。部門長・副部門長が外したときに消えるのは staff の招待だけで、
-- 管理者が作った staff 以外の招待は残る（admin・head・deputy_head・viewer の招待の取り消しは管理者だけ。D-48。T15 のレビューで直した）。
-- 1つの年度・1つのメールに未使用のロールの招待は1つなので、staff の招待は別の staff（st_target2）で確かめる
select tests.create_user('st_target2');
insert into public.year_roles (year_id, user_id, role) values (tests.id('Y1'), tests.id('st_target2'), 'staff');
insert into public.invitations (year_id, email, role) values
  (tests.id('Y1'), 'st_target@pgtap.test', 'admin'),       -- 管理者が別に作った招待（受け入れでは別のロールなので残っている）
  (tests.id('Y1'), 'st_target2@pgtap.test', 'staff');
select tests.login_as('deputy');
select lives_ok($$ select public.remove_role(tests.id('Y1'), tests.id('st_target'), '交代') $$, '副部門長は staff を外せる');
select tests.logout();
select is((select count(*)::int from public.year_roles where year_id = tests.id('Y1') and user_id = tests.id('st_target')), 0, 'st_target の staff が外れる');
select is((select string_agg(role::text, ' ') from public.invitations where email = 'st_target@pgtap.test' and used_at is null), 'admin',
  '副部門長が外しても、管理者が作った admin の招待は消えない（取り消しは管理者だけ）');
select is((select reason || ' ' || (user_id = tests.id('deputy'))::text from public.audit_logs
           where table_name = 'year_roles' and action = 'delete' and row_pk ->> 'user_id' = tests.id('st_target')::text),
  '交代 true', '外したことは理由と人つきで監査に残る');
select tests.login_as('head');
select lives_ok($$ select public.remove_role(tests.id('Y1'), tests.id('st_target2')) $$, '部門長も staff を外せる');
select tests.logout();
select is((select count(*)::int from public.invitations where email = 'st_target2@pgtap.test'), 0,
  '部門長が外すと、その人あての未使用の staff の招待は消える（残すと次のログインで staff が戻る）');
-- 残った管理者の招待は、ロールがなくなった本人の次の受け入れで、管理者の招待どおりに付く（管理者が取り消さなければ）
select tests.login_as('st_target');
select is(public.accept_my_invitations(), 1, '外された後の受け入れで、残っていた管理者の招待を受け入れる');
select tests.logout();
select is((select role from public.year_roles where year_id = tests.id('Y1') and user_id = tests.id('st_target')), 'admin'::public.app_role,
  'st_target は管理者の招待どおり admin になる');

-- ---------------------------------------------------------------- 店長⇄副店長（相手のロールによらず、部門長以上が切り替える）
insert into public.group_members (group_id, user_id, role) values (tests.id('G2'), tests.id('admin'), 'manager');   -- admin は店長を兼ねられる
select tests.login_as('deputy');
select lives_ok($$ select public.set_group_member_role(tests.id('G2'), tests.id('admin'), 'deputy_manager', '副店長に') $$,
  '副部門長は、管理者の店長も副店長に切り替えられる');
select tests.logout();
select is((select role from public.group_members where group_id = tests.id('G2') and user_id = tests.id('admin')),
  'deputy_manager'::public.group_role, '立場が副店長になる');
select is((select (before ->> 'role') || '>' || (after ->> 'role') || ' ' || reason || ' ' || (user_id = tests.id('deputy'))::text
           from public.audit_logs where table_name = 'group_members' and action = 'update' order by id desc limit 1),
  'manager>deputy_manager 副店長に true', '切り替えは監査に残る（理由と人つき）');
select tests.login_as('head');
select lives_ok($$ select public.set_group_member_role(tests.id('G2'), tests.id('admin'), 'manager') $$, '部門長が店長に戻す（理由は任意）');
select tests.logout();

-- ---------------------------------------------------------------- 取り消し（staff と団体の招待だけ）
select tests.login_as('head');
select lives_ok($$ select public.revoke_invitation(tests.id('INV_GROUP')) $$, '部門長は団体の招待を取り消せる');
select throws_ok($$ select public.revoke_invitation(tests.id('INV_VIEWER')) $$, 'P0001', 'forbidden',
  '部門長は viewer の招待を取り消せない（見つからないときと同じ forbidden）');
select tests.logout();
select is((select string_agg(t.name, ' ' order by t.name) from public.invitations i join tests.ids t on t.id = i.id
           where t.name in ('INV_GROUP', 'INV_VIEWER')), 'INV_VIEWER', '団体の招待だけが消え、viewer の招待は残る');

-- ---------------------------------------------------------------- 読める招待（staff のロールの招待と団体の招待だけ）
select tests.login_as('head');
select is((select string_agg(distinct coalesce(role::text, 'group'), ' ' order by coalesce(role::text, 'group')) from public.invitations),
  'group staff', '部門長が読める招待は、staff のロールの招待と団体の招待だけ');
select is((select count(*)::int from public.invitations where role in ('admin', 'head', 'deputy_head', 'viewer')), 0,
  '部門長は admin・head・deputy_head・viewer の招待を読めない');
select tests.logout();
select tests.login_as('deputy');
select is((select string_agg(distinct coalesce(role::text, 'group'), ' ' order by coalesce(role::text, 'group')) from public.invitations),
  'group staff', '副部門長も同じ');
select tests.logout();

select * from finish();
rollback;
