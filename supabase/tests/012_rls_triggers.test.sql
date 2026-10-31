-- 012_rls_triggers：ポリシーを通した直接の書き込みと、T02 のトリガーの組み合わせ（T03）
-- 002_triggers は postgres のまま auth.uid() だけを変えて確かめた。ここでは authenticated に切り替えて、RLS の下でも
-- SECURITY DEFINER のトリガー（監査・版・守り）が動き、読めない表に書けないことで失敗しないことを確かめる。
begin;
\ir _helpers/personas.psql
\ir _helpers/fixture.psql
select plan(42);

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

-- 守りのトリガーと RLS：BEFORE ROW トリガーは with check より先に動く。書く権限のない人の拒否される書き込みでは、
-- 守りのトリガーが年度の行をロックしない（admin の RPC を待たせられない）。拒否は今までどおり RLS が返す。
-- lock_year_guard を呼び出しを数える関数に差し替えて確かめる（数はシーケンスで数える。throws_ok・try_cell の副トランザクションの
-- 取り消しでも消えない）。このテストのトランザクションの中だけの差し替え（最後に rollback する）
create sequence tests.guard_calls;
alter function private.lock_year_guard(uuid) rename to lock_year_guard_orig;
create function private.lock_year_guard(p_year_id uuid)
returns public.year_status language plpgsql security definer set search_path = '' as $$
begin
  perform nextval('tests.guard_calls');
  return private.lock_year_guard_orig(p_year_id);
end $$;
create function tests.guard_calls() returns bigint language sql security definer set search_path = '' as $$
  select case when is_called then last_value else 0 end from tests.guard_calls
$$;
select tests.set_scenario('confirmed');
select is(tests.try_cell(tests.sql('insert into public.room_years (year_id, room_id, usable) values (:Y1, :R4, true)'), p, 'insert'),
          'denied', format('%s の room_years の insert は今までどおり拒否（42501）', p))
from unnest(array['viewer', 'staff', 'rep', 'outsider']) p;
select tests.login_as('viewer');
select throws_ok(tests.sql('insert into public.room_years (year_id, room_id, usable) values (:Y1, :R4, true)'), '42501', null,
  '拒否のエラーは RLS の 42501');
select tests.logout();
select is(tests.try_cell(tests.sql(t), 'staff', 'update'), 'denied', format('staff の %s は今までどおり0行（RLS）', split_part(t, ' ', 2)))
from unnest(array['update public.stocks set count = 0 where year_id = :Y1',
                  'update public.groups set location_room_id = null where year_id = :Y1',
                  'update public.room_years set usable = false where year_id = :Y1']) t;
select is(tests.guard_calls(), 0::bigint, '拒否される insert・update では、守りのトリガーが年度の行をロックしない');
-- 部門長・副部門長（T15）：groups の書き込みは管理者だけのまま（前置きの確かめは can_admin）なので、拒否されロックもしない。
-- room_years（今年の使用）は部門長以上が書く。前置きの確かめが can_lead になったので、守りが年度の行をロックして E002 を止める
select is(tests.try_cell(tests.sql('update public.groups set location_room_id = null where year_id = :Y1'), p, 'update'), 'denied',
          format('%s の groups の update は拒否（管理者だけ）', p))
from unnest(array['head', 'deputy']) p;
select is(tests.guard_calls(), 0::bigint, '部門長・副部門長の groups の書き込みでも、守りは年度の行をロックしない');
select is(tests.try_cell(tests.sql('insert into public.room_years (year_id, room_id, usable) values (:Y1, :R4, true)'), p, 'insert'),
          'allowed', format('%s は確定中も場所の状態を足せる', p))
from unnest(array['head', 'deputy']) p;
select is(tests.guard_calls(), 2::bigint, '部門長・副部門長の room_years の書き込みでは、守りのトリガーが年度の行をロックして状態を読む（1回ずつ）');
select tests.login_as('head');
select throws_ok(tests.sql('insert into public.room_years (year_id, room_id, usable) values (:Y1, :R1, false)'),
  'P0001', 'invalid_state', '部門長も、確定中に振り分けのある部屋を使用不可にできない（守りが効く）');
select tests.logout();
-- admin の書き込みでは守りが効く（確定中に E001・E002・E005 を作れない）
select tests.login_as('admin');
select throws_ok(tests.sql('insert into public.room_years (year_id, room_id, usable) values (:Y1, :R1, false)'),
  'P0001', 'invalid_state', 'admin でも、確定中に振り分けのある部屋を使用不可にできない（insert でも守りが効く）');
select throws_ok(tests.sql('update public.stocks set count = 0 where year_id = :Y1 and room_id = :R1 and item_id = :desk'), 'P0001', 'invalid_state',
  'admin でも、確定中に振り分けより少ない在庫にできない');
select throws_ok(tests.sql('update public.groups set location_room_id = :R2 where id = :G1'), 'P0001', 'invalid_state',
  'admin でも、確定中に団体の使用場所を変えられない');
select lives_ok(tests.sql('insert into public.room_years (year_id, room_id, usable) values (:Y1, :R4, true)'), 'admin は確定中も場所の状態を足せる');
select tests.logout();
select ok(tests.guard_calls() >= 4, 'admin の書き込みでは守りのトリガーが年度の行をロックして状態を読む');

-- 変えられない列のトリガー（SECURITY DEFINER）：authenticated の書き込みでも invalid_input（42501 にならない）
select tests.set_scenario('requesting');
select tests.login_as('staff');
select throws_ok(tests.sql('update public.stocks set year_id = :Y2 where year_id = :Y1 and room_id = :R1 and item_id = :desk'), 'P0001', 'invalid_input',
  'staff が在庫の年度を変えようとすると invalid_input');
select tests.logout();
select tests.login_as('admin');
select throws_ok(tests.sql('update public.groups set year_id = :Y2 where id = :G2'), 'P0001', 'invalid_input',
  'admin が団体の年度を変えようとすると invalid_input');
select tests.logout();

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
