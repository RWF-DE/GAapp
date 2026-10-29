-- 020_rpc_years：set_year_status、update_year、create_year_from（T03）
-- 各 RPC の正常系と、権限がない（forbidden）・状態が違う（invalid_state）・版が違う（conflict）・入力の誤り（invalid_input）
begin;
\ir _helpers/personas.psql
\ir _helpers/fixture.psql
select plan(90);

-- エラーの message と detail（invalid_input の field を確かめる）。成功したら 'ok'
create function tests.error_of(p_sql text) returns text language plpgsql as $$
declare v_msg text; v_detail text;
begin
  execute p_sql;
  return 'ok';
exception when others then
  get stacked diagnostics v_msg = message_text, v_detail = pg_exception_detail;
  return v_msg || ' ' || v_detail;
end $$;
grant execute on function tests.error_of(text) to authenticated;

-- ================================================================ set_year_status
select tests.login_anon();
select throws_ok($$ select public.set_year_status(tests.id('Y1'), 'allocating', 'x') $$, '42501', null, 'anon は RPC を呼べない');
select tests.logout();
select tests.login_as('staff');
select throws_ok($$ select public.set_year_status(tests.id('Y1'), 'allocating', 'x') $$, 'P0001', 'forbidden', 'staff は状態を変えられない');
select tests.logout();
select tests.login_as('rep');
select throws_ok($$ select public.set_year_status(tests.id('Y1'), 'allocating', 'x') $$, 'P0001', 'forbidden', '団体代表は状態を変えられない');
select tests.logout();
select tests.login_as('outsider');
select throws_ok($$ select public.set_year_status(tests.id('Y1'), 'allocating', 'x') $$, 'P0001', 'forbidden', '未招待は状態を変えられない');
select throws_ok($$ select public.set_year_status(gen_random_uuid(), 'allocating', 'x') $$, 'P0001', 'forbidden', '存在しない年度も forbidden（有無を漏らさない）');
select tests.logout();
select tests.login_as('admin2');
select throws_ok($$ select public.set_year_status(tests.id('Y1'), 'allocating', 'x') $$, 'P0001', 'forbidden', '別の年度の admin は状態を変えられない');
-- 受付開始は未来の締切が要る（Y2 は preparing で締切なし）
select throws_ok($$ select public.set_year_status(tests.id('Y2'), 'requesting', null) $$, 'P0001', 'invalid_state', '締切がなければ受付を始められない');
select lives_ok($$ select public.update_year(tests.id('Y2'), jsonb_build_object('request_close_at', now() - interval '1 day'), null) $$, '締切を過去に');
select throws_ok($$ select public.set_year_status(tests.id('Y2'), 'requesting', null) $$, 'P0001', 'invalid_state', '締切が過去なら受付を始められない');
select lives_ok($$ select public.update_year(tests.id('Y2'), jsonb_build_object('request_close_at', now() + interval '7 day'), null) $$, '締切を未来に');
select is((public.set_year_status(tests.id('Y2'), 'requesting', '受付開始')).status, 'requesting'::public.year_status, 'preparing → requesting');
select tests.logout();

select tests.login_as('admin');
select throws_ok($$ select public.set_year_status(tests.id('Y1'), 'confirmed', 'x', tests.ver()) $$, 'P0001', 'invalid_state', '図にない遷移（requesting → confirmed）はエラー');
select throws_ok($$ select public.set_year_status(tests.id('Y1'), 'preparing', 'x') $$, 'P0001', 'invalid_state', '戻る遷移（requesting → preparing）はエラー');
select throws_ok(format($$ select public.set_year_status(%L, 'allocating', %L) $$, tests.id('Y1'), repeat('x', 501)), 'P0001', 'invalid_input', '理由は 500 字まで');
select tests.ver() as v0 \gset
select lives_ok($$ select public.set_year_status(tests.id('Y1'), 'allocating', '締切') $$, 'requesting → allocating（理由は任意）');
select tests.logout();
select is((select reason from public.audit_logs where table_name = 'years' and action = 'update' and row_pk ->> 'id' = tests.id('Y1')::text
           order by id desc limit 1), '締切', '理由が監査に残る');
select is(tests.ver(), :v0 + 1, '状態の遷移で版が増える');

-- 確定：理由と版が要る。E001・E002・E005 があれば確定できない
select tests.login_as('admin');
select throws_ok($$ select public.set_year_status(tests.id('Y1'), 'confirmed', null, tests.ver()) $$, 'P0001', 'reason_required', '確定は理由が必須');
select throws_ok($$ select public.set_year_status(tests.id('Y1'), 'confirmed', '  ', tests.ver()) $$, 'P0001', 'reason_required', '空白だけの理由は理由とみなさない');
select throws_ok($$ select public.set_year_status(tests.id('Y1'), 'confirmed', '確定', tests.ver() - 1) $$, 'P0001', 'conflict', '検証した版と違えば conflict');
select throws_ok($$ select public.set_year_status(tests.id('Y1'), 'confirmed', '確定', null) $$, 'P0001', 'conflict', '版を渡さなければ conflict');
select tests.logout();
-- E001：R2 の机の在庫（5）を振り分け（G2 に 3）より少なくする
update public.stocks set count = 1 where year_id = tests.id('Y1') and room_id = tests.id('R2') and item_id = tests.id('desk');
select tests.login_as('admin');
select throws_ok($$ select public.set_year_status(tests.id('Y1'), 'confirmed', '確定', tests.ver()) $$, 'P0001', 'E001', '在庫超過があれば確定できない');
select tests.logout();
update public.stocks set count = 5 where year_id = tests.id('Y1') and room_id = tests.id('R2') and item_id = tests.id('desk');
-- E002：振り分けのある R2 を使用不可にする
insert into public.room_years (year_id, room_id, usable) values (tests.id('Y1'), tests.id('R2'), false);
select tests.login_as('admin');
select throws_ok($$ select public.set_year_status(tests.id('Y1'), 'confirmed', '確定', tests.ver()) $$, 'P0001', 'E002', '使用不可の部屋からの振り分けがあれば確定できない');
select tests.logout();
delete from public.room_years where year_id = tests.id('Y1') and room_id = tests.id('R2');
-- E005：G1 の使用場所を変えると、残すの行（R1）が使用場所と合わなくなる
update public.groups set location_room_id = tests.id('R2') where id = tests.id('G1');
select tests.login_as('admin');
select throws_ok($$ select public.set_year_status(tests.id('Y1'), 'confirmed', '確定', tests.ver()) $$, 'P0001', 'E005', '残すの不整合があれば確定できない');
select tests.logout();
update public.groups set location_room_id = tests.id('R1') where id = tests.id('G1');
-- E005 の逆向き：使用場所（R1）から運ぶ行が残すでない
update public.allocations set is_keep = false where id = tests.id('A_G1_KEEP');
select tests.login_as('admin');
select throws_ok($$ select public.set_year_status(tests.id('Y1'), 'confirmed', '確定', tests.ver()) $$, 'P0001', 'E005', '使用場所から運ぶ行が残すでなければ確定できない');
select tests.logout();
select is((select private.confirm_issues(tests.id('Y1'))),
  jsonb_build_array(jsonb_build_object('code', 'E005', 'allocation_id', tests.id('A_G1_KEEP'), 'group_id', tests.id('G1'))),
  '逆向きの E005 は該当の行を示す');
update public.allocations set is_keep = true where id = tests.id('A_G1_KEEP');
-- E005 の逆向き：G2 の使用場所を、G2 への振り分け（R2 から、残すでない）の運び元に変える
update public.groups set location_room_id = tests.id('R2') where id = tests.id('G2');
select tests.login_as('admin');
select throws_ok($$ select public.set_year_status(tests.id('Y1'), 'confirmed', '確定', tests.ver()) $$, 'P0001', 'E005', '使用場所を運び元に変えて残すでない行ができれば確定できない');
select tests.logout();
update public.groups set location_room_id = null where id = tests.id('G2');

select tests.login_as('admin');
select tests.ver() as v1 \gset
select is((public.set_year_status(tests.id('Y1'), 'confirmed', '確定', tests.ver())).status, 'confirmed'::public.year_status, '確定');
select is(tests.ver(), :v1 + 1, '確定でも版が増える');
select throws_ok($$ select public.save_auto_allocations(tests.id('Y1'), '[]', 'full', tests.ver()) $$, 'P0001', 'invalid_state', '確定中は自動振り分けを保存できない');
select throws_ok($$ select public.set_year_status(tests.id('Y1'), 'allocating', null) $$, 'P0001', 'reason_required', '確定の解除は理由が必須');
select lives_ok($$ select public.set_year_status(tests.id('Y1'), 'allocating', '部屋が使えなくなった') $$, '確定を解除');
select lives_ok($$ select public.set_year_status(tests.id('Y1'), 'confirmed', '確定し直し', tests.ver()) $$, 'もう一度確定');
select lives_ok($$ select public.set_year_status(tests.id('Y1'), 'closed', null) $$, 'confirmed → closed（理由は任意）');
select throws_ok($$ select public.set_year_status(tests.id('Y1'), 'allocating', 'x') $$, 'P0001', 'invalid_state', 'closed は終点');

-- ================================================================ update_year
select throws_ok($$ select public.update_year(tests.id('Y1'), '{"label": "x"}', null) $$, 'P0001', 'invalid_state', 'closed の年度は変えられない');
select tests.logout();
select tests.set_scenario('requesting');
select tests.login_as('staff');
select throws_ok($$ select public.update_year(tests.id('Y1'), '{"label": "x"}', null) $$, 'P0001', 'forbidden', 'staff は年度を変えられない');
select tests.logout();
select tests.login_as('admin2');
select throws_ok($$ select public.update_year(tests.id('Y1'), '{"label": "x"}', null) $$, 'P0001', 'forbidden', '別の年度の admin は変えられない');
select tests.logout();
select tests.login_as('admin');
select throws_ok($$ select public.update_year(tests.id('Y1'), '{"festival_start": "2026-13-45"}', null) $$, 'P0001', 'invalid_input', '範囲外の日付は invalid_input（22008 を返さない）');
select throws_ok($$ select public.update_year(tests.id('Y1'), '{"request_close_at": "あした"}', null) $$, 'P0001', 'invalid_input', '日時でない値は invalid_input');
select throws_ok($$ select public.update_year(tests.id('Y1'), '{"status": "closed"}', null) $$, 'P0001', 'invalid_input', '状態は update_year で変えられない');
select throws_ok($$ select public.update_year(tests.id('Y1'), '["label"]', null) $$, 'P0001', 'invalid_input', 'patch はオブジェクト');
select throws_ok(format($$ select public.update_year(%L, %L, null) $$, tests.id('Y1'), jsonb_build_object('label', repeat('x', 51))), 'P0001', 'invalid_input', '年度名の上限（CHECK 違反も invalid_input）');
select throws_ok($$ select public.update_year(tests.id('Y1'), '{"label": "T-Y2"}', null) $$, 'P0001', 'conflict', '年度名の重複は conflict');
select throws_ok($$ select public.update_year(tests.id('Y1'), '{"request_close_at": null}', null) $$, 'P0001', 'invalid_input', 'requesting の間は締切を消せない');
-- 1日目は有限で現実的な範囲（2000-01-01〜2200-12-31）だけ。infinity などを入れて closed にすると、それより後の1日目が
-- なくなり、誰も次の年度を作れなくなる（D-18）。前後の年度との比較では止まらない（Y1 は最新で、複製元もない）
select is(tests.error_of($$ select public.update_year(tests.id('Y1'), '{"festival_start": "infinity"}', null) $$),
  'invalid_input {"field": "festival_start"}', '1日目に infinity は入れられない');
select is(tests.error_of($$ select public.update_year(tests.id('Y1'), '{"festival_start": "5874897-12-31"}', null) $$),
  'invalid_input {"field": "festival_start"}', '1日目に date の上限は入れられない');
select is(tests.error_of($$ select public.update_year(tests.id('Y1'), '{"festival_start": "2201-01-01"}', null) $$),
  'invalid_input {"field": "festival_start"}', '1日目は 2200-12-31 まで');
select is(tests.error_of($$ select public.update_year(tests.id('Y1'), '{"festival_start": "1999-12-31"}', null) $$),
  'invalid_input {"field": "festival_start"}', '1日目は 2000-01-01 から');
select is(tests.error_of($$ select public.update_year(tests.id('Y1'), '{"festival_start": "-infinity"}', null) $$),
  'invalid_input {"field": "festival_start"}', '1日目に -infinity は入れられない');
select ok((select festival_start = date '2027-10-16' from public.years where id = tests.id('Y1')), '範囲外の1日目は保存されない');
select is((public.update_year(tests.id('Y1'), jsonb_build_object('request_close_at', now() + interval '2 day', 'label', ' T-Y1改 '), '延長')).label,
  'T-Y1改', 'update_year は patch のキーだけを変える（前後の空白を除く）');
select tests.logout();
select is((select reason from public.audit_logs where table_name = 'years' and row_pk ->> 'id' = tests.id('Y1')::text order by id desc limit 1),
  '延長', 'update_year の理由が監査に残る');
select ok((select festival_start = date '2027-10-16' from public.years where id = tests.id('Y1')), 'patch にないキー（1日目）は変わらない');

-- ================================================================ create_year_from（D-01）
-- ルール：団体が見つからないもの（S99）と、団体の配列（S98）
insert into public.rules (year_id, code, kind, params) values
  (tests.id('Y1'), 'S99', 'keep', jsonb_build_object('group', gen_random_uuid())),
  (tests.id('Y1'), 'S98', 'keep', jsonb_build_object('groups', jsonb_build_array(tests.id('G1'), tests.id('G2'))));
select tests.login_anon();
select throws_ok($$ select public.create_year_from(tests.id('Y1'), 'T-Y3', date '2028-10-01') $$, '42501', null, 'anon は年度を作れない');
select tests.logout();
select tests.login_as('staff');
select throws_ok($$ select public.create_year_from(tests.id('Y1'), 'T-Y3', date '2028-10-01') $$, 'P0001', 'forbidden', 'staff は年度を作れない');
select tests.logout();
select tests.login_as('outsider');
select throws_ok($$ select public.create_year_from(tests.id('Y1'), 'T-Y3', date '2028-10-01') $$, 'P0001', 'forbidden', '未招待は年度を作れない');
select tests.logout();
select tests.login_as('admin2');
select throws_ok($$ select public.create_year_from(tests.id('Y1'), 'T-Y3', date '2028-10-01') $$, 'P0001', 'forbidden', '複製元にロールのない admin は複製できない');
select throws_ok($$ select public.create_year_from(tests.id('Y2'), 'T-Y3', date '2028-10-01') $$, 'P0001', 'invalid_state', '最新でない年度は複製元にできない');
select tests.logout();
select tests.login_as('admin');
select throws_ok($$ select public.create_year_from(tests.id('Y1'), 'T-Y3', date '2027-10-16') $$, 'P0001', 'invalid_input', '新しい年度の1日目は複製元より後');
select throws_ok($$ select public.create_year_from(tests.id('Y1'), ' ', date '2028-10-01') $$, 'P0001', 'invalid_input', '年度名は空にできない');
select is(tests.error_of($$ select public.create_year_from(tests.id('Y1'), 'T-Y3', 'infinity'::date) $$),
  'invalid_input {"field": "festival_start"}', '新しい年度の1日目に infinity は入れられない');
select is(tests.error_of($$ select public.create_year_from(tests.id('Y1'), 'T-Y3', date '2201-01-01') $$),
  'invalid_input {"field": "festival_start"}', '新しい年度の1日目も 2200-12-31 まで');
select throws_ok($$ select public.create_year_from(tests.id('Y1'), 'T-Y2', date '2028-10-01') $$, 'P0001', 'conflict', '同じ名前の年度は作れない');
select throws_ok($$ select public.create_year_from(tests.id('Y2'), 'T-Y3', date '2028-10-01') $$, 'P0001', 'forbidden', 'ロールのない年度は複製できない（他の年度のデータを読み出せない）');
select tests.logout();

-- 7月の流れ：前年度は closed で、ほかに開いている年度がない admin が次の年度を作る
select tests.set_scenario('closed');
select tests.login_as('admin');
select is(private.is_admin_of_open_year(), false, 'closed の年度だけの admin は年度をまたぐ表を書けない');
select isnt((select id from public.create_year_from(tests.id('Y1'), 'T-Y3', date '2028-10-01')), null, 'closed の最新の年度の admin は次の年度を作れる');
select is(private.is_admin_of_open_year(), true, '作った年度の admin になるので、年度をまたぐ表も書ける');
select throws_ok($$ select public.create_year_from(tests.id('Y1'), 'T-Y5', date '2029-10-01') $$, 'P0001', 'invalid_state', '一度複製した年度からもう一度は作れない');
select tests.logout();
insert into tests.ids select 'Y3', id from public.years where label = 'T-Y3';
select is((select status from public.years where id = tests.id('Y3')), 'preparing'::public.year_status, '新しい年度は preparing');
select is((select prev_year_id from public.years where id = tests.id('Y3')), tests.id('Y1'), 'prev_year_id は複製元');
select is((select array_agg(user_id::text || ':' || role) from public.year_roles where year_id = tests.id('Y3')),
  array[tests.id('admin')::text || ':admin'], '作った人だけが新しい年度の admin（D-01。ほかのロールは複製しない）');
select is((select string_agg(name, ' ' order by name) from public.groups where year_id = tests.id('Y3')), 'T-G1 T-G2 T-G4', '団体を複製');
select is((select count(*)::int from public.group_members gm join public.groups g on g.id = gm.group_id where g.year_id = tests.id('Y3')), 0,
  '団体代表は複製しない');
select is((select params ->> 'group' from public.rules where year_id = tests.id('Y3') and code = 'S05'),
  (select id::text from public.groups where year_id = tests.id('Y3') and name = 'T-G2'), 'ルールの団体 id を名前で付け替える');
select is((select params -> 'groups' from public.rules where year_id = tests.id('Y3') and code = 'S98'),
  (select jsonb_agg(id order by name) from public.groups where year_id = tests.id('Y3') and name in ('T-G1', 'T-G2')), '団体の配列も付け替える');
select ok((select not enabled and memo like '%見つからなかった%' from public.rules where year_id = tests.id('Y3') and code = 'S99'),
  '付け替えられないルールは無効にして memo に理由を書く');
select is((select count(*)::int from public.room_years where year_id = tests.id('Y3') and not usable), 1, '使用不可を複製');
select is((select count(*)::int from public.stocks where year_id = tests.id('Y3')), 0, '在庫は複製しない');
select is((select reason from public.audit_logs where table_name = 'years' and row_pk ->> 'id' = tests.id('Y3')::text), 'T-Y1改 から複製',
  '複製の理由が監査に残る');

-- ================================================================ update_year の1日目（複製元より後、複製先より前）
select tests.login_as('admin');
select throws_ok($$ select public.update_year(tests.id('Y3'), '{"festival_start": "2027-10-16"}', null) $$, 'P0001', 'invalid_input',
  '1日目を複製元と同じ日にできない');
select throws_ok($$ select public.update_year(tests.id('Y3'), '{"festival_start": "2026-01-01"}', null) $$, 'P0001', 'invalid_input',
  '1日目を複製元より前にできない');
select lives_ok($$ select public.update_year(tests.id('Y3'), '{"festival_start": "2028-12-01"}', null) $$, '複製元より後なら変えられる');
select tests.logout();
select tests.set_scenario('confirmed');
select tests.login_as('admin');
select throws_ok($$ select public.update_year(tests.id('Y1'), '{"festival_start": "2028-12-01"}', null) $$, 'P0001', 'invalid_input',
  '複製元の1日目を複製先と同じ日にできない');
select throws_ok($$ select public.update_year(tests.id('Y1'), '{"festival_start": "2029-01-01"}', null) $$, 'P0001', 'invalid_input',
  '複製元の1日目を複製先より後にできない（どの年度も最新でなくなるため）');
select lives_ok($$ select public.update_year(tests.id('Y1'), '{"festival_start": "2027-11-01"}', null) $$, '複製先より前なら変えられる');
select isnt((select id from public.create_year_from(tests.id('Y3'), 'T-Y4', date '2029-10-01')), null,
  '1日目を変えた後も、最新の年度（複製先）から次の年度を作れる');
select tests.logout();

-- ================================================================ 1日目の CHECK（RPC を通らない書き込みも止める）
select throws_ok($$ update public.years set festival_start = 'infinity' where label = 'T-Y4' $$, '23514', null,
  'years の CHECK：1日目に infinity は入れられない');
select throws_ok($$ insert into public.years (label, festival_start) values ('T-Y9', date '1999-12-31') $$, '23514', null,
  'years の CHECK：1日目は 2000-01-01 から');
select lives_ok($$ insert into public.years (label, festival_start) values ('T-Y9', date '2200-12-31') $$, 'years の CHECK：2200-12-31 は入れられる');

select * from finish();
rollback;
