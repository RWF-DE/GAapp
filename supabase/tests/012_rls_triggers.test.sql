-- 012_rls_triggers：ポリシーを通した直接の書き込みと、T02 のトリガーの組み合わせ（T03）
-- 002_triggers は postgres のまま auth.uid() だけを変えて確かめた。ここでは authenticated に切り替えて、RLS の下でも
-- SECURITY DEFINER のトリガー（監査・版・守り）が動き、読めない表に書けないことで失敗しないことを確かめる。
begin;
\ir _helpers/personas.psql
\ir _helpers/fixture.psql
select plan(19);

-- 在庫：staff の書き込みが監査に残る（K-16）。数えた人は DB が入れる（K-25）
select tests.login_as('staff');
select lives_ok($$ update public.stocks set count = 9, counted_by = tests.id('admin')
                   where year_id = tests.id('Y1') and room_id = tests.id('R1') and item_id = tests.id('desk') $$, 'staff が在庫を直す');
select is((select counted_by from public.stocks where year_id = tests.id('Y1') and room_id = tests.id('R1') and item_id = tests.id('desk')),
  tests.id('staff'), 'counted_by は送った値でなく、書いた人');
select is((select count(*)::int from public.audit_logs), 0, 'staff は audit_logs を読めない');
select tests.logout();
select is((select user_id from public.audit_logs where table_name = 'stocks' and action = 'update' order by id desc limit 1), tests.id('staff'),
  '監査（SECURITY DEFINER）は staff の在庫の更新を記録する');
select tests.login_as('admin');
select ok((select count(*) > 0 from public.audit_logs where table_name = 'stocks' and user_id = tests.id('staff')), 'その年度の admin は履歴を読める');
select tests.logout();

-- 版：受付中の在庫の書き込みでは増えない。振り分け中は増える
select tests.ver() as v_req \gset
select tests.login_as('staff');
update public.stocks set count = count + 1 where year_id = tests.id('Y1') and room_id = tests.id('R2') and item_id = tests.id('desk');
select tests.logout();
select is(tests.ver(), :v_req, '受付中の在庫の書き込みでは版は増えない');

-- 提出：日時と人は DB が入れる
select tests.login_as('rep');
select lives_ok($$ insert into public.request_submissions (group_id, submitted_at, note) values (tests.id('G1'), '2000-01-01', 'x')
                   on conflict (group_id) do update set submitted_at = excluded.submitted_at, note = excluded.note $$, '団体代表は締切前に提出できる');
select throws_ok($$ update public.requests set count = 2147483647 where group_id = tests.id('G1') $$, '23514', null, '直接の書き込みでも数の上限');
select throws_ok($$ insert into public.requests (group_id, item_id, count) values (tests.id('G1'), tests.id('desk_ng'), 1) $$, 'P0001', 'E006',
  '団体代表の直接の書き込みでも申請できない品目は E006');
select tests.logout();
select ok((select submitted_at = now() and updated_by = tests.id('rep') from public.request_submissions where group_id = tests.id('G1')),
  'submitted_at と updated_by は DB が入れる');

-- 距離：呼ぶ側が建物の順を気にしなくてよい（抜け (d)）
select tests.login_as('admin');
select lives_ok($$ insert into public.distance_overrides (building_a, building_b, cost) values ('pgtap棟Y', 'pgtap棟X', 3) $$, '逆順で入れる');
select throws_ok($$ insert into public.distance_overrides (building_a, building_b, cost) values ('pgtap棟X', 'pgtap棟Y', 3) $$, '23505', null,
  '同じ組を正順で入れると重複（向きのない組として扱う）');
select tests.logout();
select is((select building_a || '/' || building_b from public.distance_overrides where cost = 3 and building_a like 'pgtap%'), 'pgtap棟X/pgtap棟Y',
  'C の照合順序で小さい方が building_a');

-- 振り分け中に管理者が団体を消す：振り分けも連鎖で消え（版の増分も DEFINER で通る）、監査には年度が入り、別の年度の admin には見えない
select tests.set_scenario('allocating');
select tests.ver() as v_alloc \gset
select tests.login_as('admin');
select lives_ok($$ delete from public.groups where id = tests.id('G1') $$, '振り分け中は団体を消せる');
select tests.logout();
select is((select count(*)::int from public.allocations where group_id = tests.id('G1')), 0, '振り分けも連鎖で消える');
select ok(tests.ver() > :v_alloc, '連鎖で消えた振り分けの分も版が増える');
select ok((select count(*) >= 4 from public.audit_logs where action = 'delete' and group_id = tests.id('G1') and year_id = tests.id('Y1')
           and table_name in ('requests', 'request_submissions', 'substitution_consents', 'allocations')), '連鎖で消えた行の監査にも年度が入る');
select tests.login_as('admin2');
select is((select count(*)::int from public.audit_logs where group_id = tests.id('G1')), 0, '別の年度の admin には見えない');
select is((select count(*)::int from public.audit_logs where year_id is null and table_name not in ('rooms', 'items', 'distance_overrides')), 0,
  '年度のない行は年度をまたぐ3表のものだけ');
select tests.logout();

select * from finish();
rollback;
