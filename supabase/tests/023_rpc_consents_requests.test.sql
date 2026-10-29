-- 023_rpc_consents_requests：set_consent、submit_requests、update_requests_after_deadline、check_delivery、previous_year_*（T03）
begin;
\ir _helpers/personas.psql
\ir _helpers/fixture.psql
select plan(84);

-- ================================================================ submit_requests（受付中）
select tests.login_anon();
select throws_ok($$ select public.submit_requests(tests.id('G1'), '[]') $$, '42501', null, 'anon は提出できない');
select tests.logout();
select tests.login_as('outsider');
select throws_ok($$ select public.submit_requests(tests.id('G1'), '[]') $$, 'P0001', 'forbidden', '未招待は提出できない');
select tests.logout();
select tests.login_as('staff');
select throws_ok($$ select public.submit_requests(tests.id('G1'), '[]') $$, 'P0001', 'forbidden', 'staff は他の団体の申請を出せない');
select tests.logout();
select tests.login_as('rep2');
select throws_ok($$ select public.submit_requests(tests.id('G1'), '[]') $$, 'P0001', 'forbidden', '他の団体の代表は提出できない');
select tests.logout();
select tests.login_as('admin2');
select throws_ok($$ select public.submit_requests(tests.id('G1'), '[]') $$, 'P0001', 'forbidden', '別の年度の admin は提出できない');
select throws_ok($$ select public.submit_requests(gen_random_uuid(), '[]') $$, 'P0001', 'forbidden', '存在しない団体は forbidden');
select tests.logout();

-- 理由を置く RPC の後でも、提出の監査の理由は空になる（1トランザクションのテストで前の理由が残らないこと）
select tests.login_as('admin');
select lives_ok($$ select public.update_year(tests.id('Y1'), '{}', '前の理由') $$, '理由を置く RPC');
select tests.logout();
select tests.login_as('rep');
select is((public.submit_requests(tests.id('G1'), jsonb_build_array(
            jsonb_build_object('itemId', tests.id('desk'), 'count', 5), jsonb_build_object('itemId', tests.id('blue_chair'), 'count', 2),
            jsonb_build_object('itemId', tests.id('long_desk_3'), 'count', 1)),
          '備考')).note, '備考', '団体代表が申請と提出を1回で書く（企業以外の長机(3人掛)も通す。D-05）');
select tests.logout();
select is((select string_agg(i.code || '=' || r.count, ' ' order by i.sort_order) from public.requests r join public.items i on i.id = r.item_id
           where r.group_id = tests.id('G1')), 'desk=5 blue_chair=2 long_desk_3=1', '申請の数');
select ok((select submitted_at = now() and updated_by = tests.id('rep') from public.request_submissions where group_id = tests.id('G1')), '提出の日時と人は DB が入れる');
select is((select reason from public.audit_logs where table_name = 'requests' and group_id = tests.id('G1') order by id desc limit 1), null,
  '提出の監査に前の理由が残らない');
select tests.login_as('rep');
select throws_ok(format($$ select public.submit_requests(%L, %L) $$, tests.id('G1'),
  jsonb_build_array(jsonb_build_object('itemId', tests.id('desk_ng'), 'count', 1))), 'P0001', 'E006', '申請できない品目は E006');
select throws_ok(format($$ select public.submit_requests(%L, %L) $$, tests.id('G1'),
  jsonb_build_array(jsonb_build_object('itemId', tests.id('desk'), 'count', 20000))), 'P0001', 'invalid_input', '数の上限（10000）');
select throws_ok(format($$ select public.submit_requests(%L, %L) $$, tests.id('G1'),
  jsonb_build_array(jsonb_build_object('itemId', tests.id('desk'), 'count', -1))), 'P0001', 'invalid_input', '負の数は invalid_input');
select throws_ok(format($$ select public.submit_requests(%L, %L) $$, tests.id('G1'),
  jsonb_build_array(jsonb_build_object('itemId', tests.id('desk'), 'count', '3'))), 'P0001', 'invalid_input', '数が文字列なら invalid_input');
select throws_ok(format($$ select public.submit_requests(%L, %L) $$, tests.id('G1'),
  jsonb_build_array(jsonb_build_object('itemId', 'x', 'count', 1))), 'P0001', 'invalid_input', 'uuid でない品目は invalid_input');
select throws_ok(format($$ select public.submit_requests(%L, %L) $$, tests.id('G1'),
  jsonb_build_array(jsonb_build_object('itemId', gen_random_uuid(), 'count', 1))), 'P0001', 'invalid_input', '存在しない品目は invalid_input（E006 にしない）');
select throws_ok(format($$ select public.submit_requests(%L, %L) $$, tests.id('G1'),
  jsonb_build_array(jsonb_build_object('itemId', tests.id('desk'), 'count', 1), jsonb_build_object('itemId', tests.id('desk'), 'count', 2))),
  'P0001', 'invalid_input', '同じ品目の重複は invalid_input');
select throws_ok(format($$ select public.submit_requests(%L, '{}') $$, tests.id('G1')), 'P0001', 'invalid_input', 'rows は配列');
select throws_ok(format($$ select public.submit_requests(%L, '[]', %L) $$, tests.id('G1'), repeat('あ', 2001)), 'P0001', 'invalid_input', '備考の上限（2000 字）');
select tests.logout();
-- staff は G4 の代表なので、G4 の申請は出せる
select tests.login_as('staff');
select lives_ok(format($$ select public.submit_requests(%L, %L) $$, tests.id('G4'),
  jsonb_build_array(jsonb_build_object('itemId', tests.id('desk'), 'count', 1))), '団体代表を兼ねる staff は自団体（G4）の申請を出せる');
select tests.logout();
-- 締切後・受付前・preparing
select tests.set_scenario('requesting:after');
select tests.login_as('rep');
select throws_ok(format($$ select public.submit_requests(%L, '[]') $$, tests.id('G1')), 'P0001', 'invalid_state', '締切後は提出できない');
select tests.logout();
select tests.login_as('admin');
select throws_ok(format($$ select public.submit_requests(%L, '[]') $$, tests.id('G1')), 'P0001', 'invalid_state', '締切後は admin も submit_requests では出せない（締切後の RPC を使う）');
select tests.logout();
select tests.set_scenario('preparing');
select tests.login_as('rep');
select throws_ok(format($$ select public.submit_requests(%L, '[]') $$, tests.id('G1')), 'P0001', 'invalid_state', '受付前（preparing）は団体代表は出せない');
select tests.logout();
select tests.login_as('admin');
select lives_ok(format($$ select public.submit_requests(%L, %L) $$, tests.id('G2'),
  jsonb_build_array(jsonb_build_object('itemId', tests.id('desk'), 'count', 4))), 'preparing では admin が代理で出せる');
select tests.logout();

-- ================================================================ update_requests_after_deadline（振り分け中）
select tests.set_scenario('allocating');
select tests.login_as('staff');
select throws_ok(format($$ select public.update_requests_after_deadline(%L, '[]', '理由') $$, tests.id('G1')), 'P0001', 'forbidden', 'staff は締切後に直せない');
select tests.logout();
select tests.login_as('rep');
select throws_ok(format($$ select public.update_requests_after_deadline(%L, '[]', '理由') $$, tests.id('G1')), 'P0001', 'forbidden', '団体代表は締切後に直せない');
select tests.logout();
select tests.login_as('admin2');
select throws_ok(format($$ select public.update_requests_after_deadline(%L, '[]', '理由') $$, tests.id('G1')), 'P0001', 'forbidden', '別の年度の admin は直せない');
select tests.logout();
select tests.login_as('admin');
select throws_ok(format($$ select public.update_requests_after_deadline(%L, '[]', '') $$, tests.id('G1')), 'P0001', 'reason_required', '理由は必須');
select tests.ver() as v0 \gset
select lives_ok(format($$ select public.update_requests_after_deadline(%L, %L, '剣道部の追加') $$, tests.id('G1'),
  jsonb_build_array(jsonb_build_object('itemId', tests.id('desk'), 'count', 8,
     'updatedAt', (select updated_at from public.requests where group_id = tests.id('G1') and item_id = tests.id('desk'))),
     jsonb_build_object('itemId', tests.id('chair'), 'count', 1))), '締切後の申請修正（既存の行は updatedAt つき、新しい行はなし）');
select tests.logout();
select is((select count from public.requests where group_id = tests.id('G1') and item_id = tests.id('desk')), 8, '数が変わる');
select is((select reason from public.audit_logs where table_name = 'requests' order by id desc limit 1), '剣道部の追加', '締切後の修正の理由が監査に残る');
select ok(tests.ver() > :v0, '振り分け中は申請の修正で版が増える');
select tests.login_as('admin');
select throws_ok(format($$ select public.update_requests_after_deadline(%L, %L, '再送') $$, tests.id('G1'),
  jsonb_build_array(jsonb_build_object('itemId', tests.id('chair'), 'count', 2))), 'P0001', 'conflict', '既存の行に updatedAt がなければ conflict');
select throws_ok(format($$ select public.update_requests_after_deadline(%L, %L, '再送') $$, tests.id('G1'),
  jsonb_build_array(jsonb_build_object('itemId', tests.id('desk'), 'count', 2, 'updatedAt', '2000-01-01T00:00:00Z'))), 'P0001', 'conflict', 'updatedAt が違えば conflict');
select throws_ok(format($$ select public.update_requests_after_deadline(%L, %L, '新規') $$, tests.id('G1'),
  jsonb_build_array(jsonb_build_object('itemId', tests.id('lectern'), 'count', 2, 'updatedAt', now()))), 'P0001', 'conflict', 'ない行に updatedAt があれば conflict（他の人が消した）');
select throws_ok(format($$ select public.update_requests_after_deadline(%L, '[{"itemId":"x","count":1}]', '理由') $$, tests.id('G1')),
  'P0001', 'invalid_input', 'uuid でない itemId は invalid_input（22P02 を返さない）');
select throws_ok(format($$ select public.update_requests_after_deadline(%L, %L, '理由') $$, tests.id('G1'),
  jsonb_build_array(jsonb_build_object('itemId', tests.id('desk_ng'), 'count', 1))), 'P0001', 'E006', '申請できない品目は E006');
-- 提出の扱い：submitted は true だけ（未提出に戻すと D-07 で需要が変わるので戻さない）
select throws_ok(format($$ select public.update_requests_after_deadline(%L, '[]', '取り消し', '{"submitted": false}') $$, tests.id('G1')),
  'P0001', 'invalid_input', 'submitted: false（未提出に戻す）は invalid_input');
select throws_ok(format($$ select public.update_requests_after_deadline(%L, '[]', '理由', '{"submittedAt": "2026-10-01"}') $$, tests.id('G1')),
  'P0001', 'invalid_input', '知らないキーは invalid_input');
select throws_ok(format($$ select public.update_requests_after_deadline(%L, '[]', '理由', %L) $$, tests.id('G1'), jsonb_build_object('note', repeat('x', 2001))),
  'P0001', 'invalid_input', '備考の上限（2000 字）');
select lives_ok(format($$ select public.update_requests_after_deadline(%L, '[]', '電話で提出', '{"submitted": true, "note": "電話"}') $$, tests.id('G4')),
  '未提出の団体を提出済みにする');
select tests.logout();
select ok((select submitted_at is not null and note = '電話' from public.request_submissions where group_id = tests.id('G4')), '提出済みになる');
select tests.login_as('admin');
select lives_ok(format($$ select public.update_requests_after_deadline(%L, '[]', '備考だけ', '{"note": null}') $$, tests.id('G4')), '備考だけ消す');
select tests.logout();
select ok((select submitted_at is not null and note is null from public.request_submissions where group_id = tests.id('G4')),
  'submitted を渡さなければ提出の状態は変わらない');
-- 確定中・終了は直せない
select tests.set_scenario('confirmed');
select tests.login_as('admin');
select throws_ok(format($$ select public.update_requests_after_deadline(%L, '[]', '理由') $$, tests.id('G1')), 'P0001', 'invalid_state', '確定中は申請を直せない');
select tests.logout();

-- ================================================================ set_consent（振り分け中）
select tests.set_scenario('requesting');
select tests.login_as('admin');
select throws_ok(format($$ select public.set_consent(%L, %L, %L, 'asked') $$, tests.id('G1'), tests.id('desk'), tests.id('caster_desk')),
  'P0001', 'invalid_state', '振り分け中でなければ記録できない');
select tests.logout();
select tests.set_scenario('allocating');
select tests.login_anon();
select throws_ok(format($$ select public.set_consent(%L, %L, %L, 'accepted') $$, tests.id('G1'), tests.id('desk'), tests.id('caster_desk')),
  '42501', null, 'anon は呼べない');
select tests.logout();
select tests.login_as('staff');
select throws_ok(format($$ select public.set_consent(%L, %L, %L, 'asked') $$, tests.id('G1'), tests.id('desk'), tests.id('caster_desk')),
  'P0001', 'forbidden', 'staff は記録できない');
select tests.logout();
select tests.login_as('rep2');
select throws_ok(format($$ select public.set_consent(%L, %L, %L, 'accepted') $$, tests.id('G1'), tests.id('desk'), tests.id('caster_desk')),
  'P0001', 'forbidden', '他の団体の代表は回答できない');
select tests.logout();
select tests.login_as('admin2');
select throws_ok(format($$ select public.set_consent(%L, %L, %L, 'asked') $$, tests.id('G1'), tests.id('desk'), tests.id('caster_desk')),
  'P0001', 'forbidden', '別の年度の admin は記録できない');
select tests.logout();
select tests.login_as('rep');
select throws_ok(format($$ select public.set_consent(%L, %L, %L, 'accepted') $$, tests.id('G1'), tests.id('desk'), tests.id('caster_desk')),
  'P0001', 'invalid_state', '未依頼には回答できない');
select throws_ok(format($$ select public.set_consent(%L, %L, %L, 'asked') $$, tests.id('G1'), tests.id('desk'), tests.id('caster_desk')),
  'P0001', 'forbidden', '団体代表は依頼済みにできない');
select tests.logout();
select tests.login_as('admin');
select throws_ok(format($$ select public.set_consent(%L, %L, %L, 'asked') $$, tests.id('G1'), tests.id('desk'), tests.id('desk')),
  'P0001', 'invalid_input', '同じ品目どうしは invalid_input');
select throws_ok(format($$ select public.set_consent(%L, %L, %L, 'asked') $$, tests.id('G1'), tests.id('desk'), gen_random_uuid()),
  'P0001', 'invalid_input', '存在しない品目は invalid_input');
select throws_ok(format($$ select public.set_consent(%L, %L, %L, 'asked', %L) $$, tests.id('G1'), tests.id('desk'), tests.id('caster_desk'), repeat('x', 2001)),
  'P0001', 'invalid_input', '備考の上限（2000 字）');
select throws_ok(format($$ select public.set_consent(%L, %L, %L, 'asked') $$, tests.id('G1'), tests.id('desk'), tests.id('blue_chair')),
  'P0001', 'invalid_state', '置き換えの行がなければ依頼できない');
select tests.logout();
-- CHECK 違反（count の上限 10000）は invalid_input にする（抜け (g)）
insert into public.allocations (year_id, source_room_id, group_id, item_id, requested_item_id, count, origin)
values (tests.id('Y1'), tests.id('R1'), tests.id('G1'), tests.id('caster_desk'), tests.id('desk'), 10000, 'manual');
select tests.login_as('admin');
select throws_ok(format($$ select public.set_consent(%L, %L, %L, 'asked') $$, tests.id('G1'), tests.id('desk'), tests.id('caster_desk')),
  'P0001', 'invalid_input', '台数が上限を超えると invalid_input（23514 を返さない）');
select tests.logout();
delete from public.allocations where group_id = tests.id('G1') and source_room_id = tests.id('R1') and item_id = tests.id('caster_desk');
select tests.login_as('admin');
select tests.ver() as v1 \gset
select is((public.set_consent(tests.id('G1'), tests.id('desk'), tests.id('caster_desk'), 'asked')).count, 2, 'asked で count にその時点の置き換え台数');
select ok(tests.ver() > :v1, '了承の記録で版が増える');
select tests.logout();
select tests.login_as('rep');
select throws_ok(format($$ select public.set_consent(%L, %L, %L, 'not_asked') $$, tests.id('G1'), tests.id('desk'), tests.id('caster_desk')),
  'P0001', 'forbidden', '団体代表は未依頼に戻せない');
select is((public.set_consent(tests.id('G1'), tests.id('desk'), tests.id('caster_desk'), 'accepted', '了承')).status, 'accepted'::public.consent_status, '団体代表が了承');
select tests.logout();
select ok((select bool_and(pinned) from public.allocations where group_id = tests.id('G1') and item_id = tests.id('caster_desk')), '了承で置き換え行が pinned');
select is((select reason from public.audit_logs where table_name = 'substitution_consents' order by id desc limit 1), '交換の了承を記録（accepted）', '了承の理由');
-- 依頼後に置き換えが増えたら、了承を記録する前に依頼し直す
select tests.login_as('admin');
select lives_ok(format($$ select public.save_allocation_rows(%L, %L, '増やす') $$, tests.id('Y1'),
  jsonb_build_array(jsonb_build_object('op', 'insert', 'sourceRoomId', tests.id('R2'), 'groupId', tests.id('G1'),
    'itemId', tests.id('caster_desk'), 'requestedItemId', tests.id('caster_desk'), 'count', 1),
   jsonb_build_object('op', 'insert', 'sourceRoomId', tests.id('R1'), 'groupId', tests.id('G1'),
    'itemId', tests.id('caster_desk'), 'requestedItemId', tests.id('desk'), 'count', 1))), '依頼後に置き換えが増える');
select throws_ok(format($$ select public.set_consent(%L, %L, %L, 'accepted') $$, tests.id('G1'), tests.id('desk'), tests.id('caster_desk')),
  'P0001', 'conflict', '依頼した台数より多ければ了承を記録できない');
select tests.logout();
select tests.login_as('rep');
select is((public.set_consent(tests.id('G1'), tests.id('desk'), tests.id('caster_desk'), 'declined')).note, '了承', '拒否（備考を渡さなければ前の備考を残す）');
select tests.logout();
select ok((select not bool_or(pinned) from public.allocations where group_id = tests.id('G1') and requested_item_id = tests.id('desk') and item_id = tests.id('caster_desk')),
  '拒否で置き換え行の pinned を外す');

-- ================================================================ check_delivery（フェーズ2）
select tests.set_scenario('requesting');
select tests.login_as('staff');
select throws_ok(format($$ select public.check_delivery(%L, 'done') $$, tests.id('D_G1')), 'P0001', 'invalid_state', '確定前は運搬チェックできない');
select tests.logout();
select tests.set_scenario('confirmed');
select tests.login_anon();
select throws_ok(format($$ select public.check_delivery(%L, 'done') $$, tests.id('D_G1')), '42501', null, 'anon は呼べない');
select tests.logout();
select tests.login_as('viewer');
select throws_ok(format($$ select public.check_delivery(%L, 'done') $$, tests.id('D_G1')), 'P0001', 'forbidden', 'viewer は運搬チェックできない');
select tests.logout();
select tests.login_as('rep');
select throws_ok(format($$ select public.check_delivery(%L, 'done') $$, tests.id('D_G1')), 'P0001', 'forbidden', '団体代表は運搬チェックできない');
select tests.logout();
select tests.login_as('admin2');
select throws_ok(format($$ select public.check_delivery(%L, 'done') $$, tests.id('D_G1')), 'P0001', 'forbidden', '別の年度の admin はチェックできない');
select tests.logout();
select tests.login_as('staff');
select throws_ok($$ select public.check_delivery(gen_random_uuid(), 'done') $$, 'P0001', 'forbidden', '存在しない受け渡しは forbidden');
select throws_ok(format($$ select public.check_delivery(%L, null) $$, tests.id('D_G1')), 'P0001', 'invalid_input', '状態がなければ invalid_input');
select throws_ok(format($$ select public.check_delivery(%L, 'problem', %L) $$, tests.id('D_G1'), repeat('x', 2001)), 'P0001', 'invalid_input', '問題の備考の上限');
select is((public.check_delivery(tests.id('D_G1'), 'done')).checked_by, tests.id('staff'), 'staff が運搬済みにする（チェックした人は DB が入れる）');
select tests.logout();
select tests.set_scenario('closed');
select tests.login_as('staff');
select is((public.check_delivery(tests.id('D_G1'), 'done', null, true)).returned, true, 'closed でも返却チェックはできる（01 の 9）');
select tests.logout();

-- ================================================================ previous_year_stocks・previous_year_requests
with y as (insert into public.years (label, festival_start, prev_year_id) values ('T-Y3', date '2028-10-14', tests.id('Y1')) returning id)
insert into tests.ids select 'Y3', id from y;
insert into public.year_roles (year_id, user_id, role) values
  (tests.id('Y3'), tests.id('staff'), 'staff'), (tests.id('Y3'), tests.id('admin2'), 'admin');
select tests.login_as('staff');
select is((select count(*)::int from public.previous_year_stocks(tests.id('Y3'))), 4, 'Y3 の staff は前年度（Y1）の在庫を読める');
select throws_ok($$ select * from public.previous_year_requests(tests.id('Y3')) $$, 'P0001', 'forbidden', '前年度の申請は admin だけ');
select tests.logout();
select tests.login_as('admin2');
select ok((select bool_and(group_name like 'T-G%') and count(*) > 0 from public.previous_year_requests(tests.id('Y3'))),
  'Y3 の admin は前年度の申請を団体名つきで読める');
select tests.logout();
select tests.login_as('admin');
select throws_ok($$ select * from public.previous_year_stocks(tests.id('Y3')) $$, 'P0001', 'forbidden', '前年度の admin でも、その年度のロールがなければ読めない');
select tests.logout();
select tests.login_as('outsider');
select throws_ok($$ select * from public.previous_year_stocks(tests.id('Y3')) $$, 'P0001', 'forbidden', '未招待は読めない');
select tests.logout();
select tests.login_anon();
select throws_ok($$ select * from public.previous_year_stocks(gen_random_uuid()) $$, '42501', null, 'anon は呼べない');
select tests.logout();

select * from finish();
rollback;
