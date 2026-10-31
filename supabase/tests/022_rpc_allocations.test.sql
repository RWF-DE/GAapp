-- 022_rpc_allocations：save_auto_allocations、save_allocation_rows（T03）
-- fixture の振り分け：A_G1_KEEP（R1→G1 机 4、残す）、A_G1_SWAP（R2→G1 キャスター机 2、申請は机）、A_G2（R2→G2 机 3）。すべて auto。
-- 在庫：R1 机 10、R2 机 5、R2 キャスター机 5、R3（使用不可）机 3。
begin;
\ir _helpers/personas.psql
\ir _helpers/fixture.psql
select plan(72);

-- 行を JSON にする補助（camelCase。03 の AllocationRow）
create function tests.arow(p_room text, p_group text, p_item text, p_req text, p_count numeric, p_keep boolean default null)
returns jsonb language sql stable as $$
  select jsonb_strip_nulls(jsonb_build_object('sourceRoomId', tests.id(p_room), 'groupId', tests.id(p_group),
           'itemId', tests.id(p_item), 'requestedItemId', tests.id(p_req), 'count', p_count, 'isKeep', p_keep))
$$;
grant execute on function tests.arow(text, text, text, text, numeric, boolean) to authenticated;

-- ================================================================ save_auto_allocations：権限・状態・版
select tests.login_as('admin');
select throws_ok($$ select public.save_auto_allocations(tests.id('Y1'), '[]', 'full', tests.ver()) $$, 'P0001', 'invalid_state', '受付中（requesting）は保存できない');
select tests.logout();
select tests.set_scenario('allocating');
select tests.login_anon();
select throws_ok($$ select public.save_auto_allocations(tests.id('Y1'), '[]', 'full', 0) $$, '42501', null, 'anon は呼べない');
select tests.logout();
select tests.login_as('staff');
select throws_ok($$ select public.save_auto_allocations(tests.id('Y1'), '[]', 'full', tests.ver()) $$, 'P0001', 'forbidden', 'staff は保存できない');
select tests.logout();
select tests.login_as('rep');
select throws_ok($$ select public.save_auto_allocations(tests.id('Y1'), '[]', 'full', tests.ver()) $$, 'P0001', 'forbidden', '団体代表は保存できない');
select tests.logout();
select tests.login_as('admin2');
select throws_ok($$ select public.save_auto_allocations(tests.id('Y1'), '[]', 'full', tests.ver()) $$, 'P0001', 'forbidden', '別の年度の admin は保存できない');
select tests.logout();
-- 部門長・副部門長（T15。振り分けの保存は部門長以上）：試して取り消す（tests.try_rpc）。版・状態の確かめは admin と同じ
select is(tests.try_rpc(p, $$ select public.save_auto_allocations(tests.id('Y1'), jsonb_build_array(
            tests.arow('R1', 'G1', 'desk', 'desk', 4), tests.arow('R2', 'G2', 'desk', 'desk', 4)), 'full', tests.ver()) $$), 'ok',
          format('%s は自動振り分けを保存できる', p))
from unnest(array['head', 'deputy']) p;
select is(tests.try_rpc('head', $$ select public.save_auto_allocations(tests.id('Y1'), '[]', 'full', tests.ver() - 1) $$), 'conflict',
  '部門長でも版が違えば conflict');
select is(tests.try_rpc('deputy', $$ select public.save_auto_allocations(tests.id('Y1'), '[]', 'full', tests.ver()) $$, 'requesting'),
  'invalid_state', '副部門長でも受付中は保存できない');
select tests.login_as('admin');
select throws_ok($$ select public.save_auto_allocations(tests.id('Y1'), '[]', 'full', tests.ver() - 1) $$, 'P0001', 'conflict', '版が違えば conflict');
select throws_ok($$ select public.save_auto_allocations(tests.id('Y1'), '[]', 'full', null) $$, 'P0001', 'conflict', '版がなければ conflict');
select throws_ok($$ select public.save_auto_allocations(tests.id('Y1'), '[]', 'all', tests.ver()) $$, 'P0001', 'invalid_input', 'mode は full か minimal_change');

-- ================================================================ save_auto_allocations：入力の誤り
select throws_ok($$ select public.save_auto_allocations(tests.id('Y1'), '{}', 'full', tests.ver()) $$, 'P0001', 'invalid_input', 'rows は配列');
select throws_ok($$ select public.save_auto_allocations(tests.id('Y1'), jsonb_build_array(tests.arow('R2', 'G1', 'desk', 'desk', 2.5)), 'full', tests.ver()) $$,
  'P0001', 'invalid_input', '整数でない数は invalid_input');
select throws_ok($$ select public.save_auto_allocations(tests.id('Y1'), jsonb_build_array(tests.arow('R2', 'G1', 'desk', 'desk', 0)), 'full', tests.ver()) $$,
  'P0001', 'invalid_input', '0 台の行は invalid_input');
select throws_ok($$ select public.save_auto_allocations(tests.id('Y1'), jsonb_build_array(tests.arow('R2', 'G1', 'desk', 'desk', 10001)), 'full', tests.ver()) $$,
  'P0001', 'invalid_input', '数の上限（10000。CHECK 違反の 23514 を返さない）');
select throws_ok($$ select public.save_auto_allocations(tests.id('Y1'), '[{"sourceRoomId":"x","groupId":"x","itemId":"x","requestedItemId":"x","count":1}]', 'full', tests.ver()) $$,
  'P0001', 'invalid_input', 'uuid でない id は invalid_input（22P02 を返さない）');
select throws_ok($$ select public.save_auto_allocations(tests.id('Y1'), jsonb_build_array(tests.arow('R2', 'G1', 'desk', 'desk', 1) - 'groupId'), 'full', tests.ver()) $$,
  'P0001', 'invalid_input', '団体のない行は invalid_input');
select throws_ok($$ select public.save_auto_allocations(tests.id('Y1'), jsonb_build_array(tests.arow('R2', 'G3', 'desk', 'desk', 1)), 'full', tests.ver()) $$,
  'P0001', 'invalid_input', '別の年度の団体は invalid_input');
select throws_ok($$ select public.save_auto_allocations(tests.id('Y1'),
                      jsonb_build_array(tests.arow('R2', 'G1', 'desk', 'desk', 1) || jsonb_build_object('sourceRoomId', gen_random_uuid())), 'full', tests.ver()) $$,
  'P0001', 'invalid_input', '存在しない場所は invalid_input');
select throws_ok($$ select public.save_auto_allocations(tests.id('Y1'),
                      jsonb_build_array(tests.arow('R2', 'G1', 'desk', 'desk', 1), tests.arow('R2', 'G1', 'desk', 'desk', 2)), 'full', tests.ver()) $$,
  'P0001', 'invalid_input', '同じ組み合わせ（運び元・団体・申請品目・品目）の重複は invalid_input');
select throws_ok($$ select public.save_auto_allocations(tests.id('Y1'), jsonb_build_array(tests.arow('R3', 'G1', 'desk', 'desk', 1)), 'full', tests.ver()) $$,
  'P0001', 'E002', '使用不可の部屋からの行は E002');
select throws_ok($$ select public.save_auto_allocations(tests.id('Y1'), jsonb_build_array(tests.arow('R2', 'G1', 'desk', 'desk', 1, true)), 'full', tests.ver()) $$,
  'P0001', 'E005', '残すの運び元が使用場所でなければ E005');
-- 在庫超過：R2 の机は在庫 5、G2 に 6 を入れる
select throws_ok($$ select public.save_auto_allocations(tests.id('Y1'), jsonb_build_array(tests.arow('R2', 'G2', 'desk', 'desk', 6)), 'full', tests.ver()) $$,
  'P0001', 'E001', '保存後に在庫超過なら E001');
select tests.logout();
select is((select string_agg(id::text, ',' order by id) from public.allocations where year_id = tests.id('Y1')),
  (select string_agg(id::text, ',' order by id) from tests.ids where name in ('A_G1_KEEP', 'A_G1_SWAP', 'A_G2')), 'E001 なら全体を取り消す（行は元のまま）');
select is((select count from public.allocations where id = tests.id('A_G2')), 3, '取り消された後は数も元のまま');

-- ================================================================ save_auto_allocations：正常系（差分の入れ替え）
-- 置き換えの行を固定（了承と同じ）。固定・手動の行は自動の保存で消えない
update public.allocations set pinned = true where id = tests.id('A_G1_SWAP');
select tests.login_as('admin');
select tests.ver() as v0 \gset
-- 残すの行（isKeep を送らない：DB が「運び元＝使用場所」で決める）、G2 は 3 → 4、G1 に R2 の机 1 を足す
select is(public.save_auto_allocations(tests.id('Y1'), jsonb_build_array(
            tests.arow('R1', 'G1', 'desk', 'desk', 4), tests.arow('R2', 'G2', 'desk', 'desk', 4), tests.arow('R2', 'G1', 'desk', 'desk', 1)),
          'full', :v0) - 'allocation_version',
  '{"deleted":0,"updated":1,"inserted":1}'::jsonb, '差分で入れ替える（変わらない残すの行はそのまま、固定の行は触らない）');
select tests.logout();
select is((select count from public.allocations where id = tests.id('A_G2')), 4, '同じ組み合わせの行は id を保ったまま数を変える');
select ok((select is_keep and origin = 'auto' and not pinned from public.allocations where id = tests.id('A_G1_KEEP')), '残すの行は is_keep のまま（DB が決める）');
select ok((select pinned and count = 2 from public.allocations where id = tests.id('A_G1_SWAP')), '固定の行は残る');
select ok((select is_keep = false and origin = 'auto' and not pinned from public.allocations
           where group_id = tests.id('G1') and source_room_id = tests.id('R2') and item_id = tests.id('desk')), '新しい行は auto・未固定・残すでない');
select is(tests.ver(), :v0 + 2, '文ごとに版が増える（update・insert）');
select is((select count(*)::int from public.audit_logs where table_name = 'allocations' and reason = '自動振り分け（全体）'), 2,
  '変わった行だけ監査に残る（理由つき）');
select is((select count(*)::int from public.audit_logs where table_name = 'years' and reason = '自動振り分け（全体）'), 0, '版と実行日時の更新は監査に残さない');
select ok((select auto_allocated_at = now() from public.years where id = tests.id('Y1')), '最終実行日時を入れる');
-- is_keep は DB が決め直す：使用場所からの行が残すでなくなっていても（逆向きの E005）、isKeep: false を送っても、保存で残すに直る
update public.allocations set is_keep = false where id = tests.id('A_G1_KEEP');
select tests.login_as('admin');
select is(public.save_auto_allocations(tests.id('Y1'), jsonb_build_array(
            tests.arow('R1', 'G1', 'desk', 'desk', 4, false), tests.arow('R2', 'G2', 'desk', 'desk', 4), tests.arow('R2', 'G1', 'desk', 'desk', 1)),
          'full', tests.ver()) - 'allocation_version',
  '{"deleted":0,"updated":1,"inserted":0}'::jsonb, '使用場所からの行は isKeep: false を送っても残すとして保存する');
select tests.logout();
select ok((select is_keep from public.allocations where id = tests.id('A_G1_KEEP')), '逆向きの不整合は保存で直る（DB が is_keep を決め直す）');
select tests.login_as('admin');
select is(public.save_auto_allocations(tests.id('Y1'), jsonb_build_array(
            tests.arow('R2', 'G2', 'desk', 'desk', 4), tests.arow('R2', 'G1', 'desk', 'desk', 1)), 'minimal_change', tests.ver())
          - 'allocation_version',
  '{"deleted":1,"updated":0,"inserted":0}'::jsonb, 'rows にない auto・未固定の行は消える（残すのルールを無効にしたとき）');
select tests.ver() as v1 \gset
select is((public.save_auto_allocations(tests.id('Y1'), jsonb_build_array(
            tests.arow('R2', 'G2', 'desk', 'desk', 4), tests.arow('R2', 'G1', 'desk', 'desk', 1)), 'minimal_change', tests.ver())
          ->> 'allocation_version')::int, :v1, '何も変わらなければ版も増えない');
select tests.logout();
select is((select count(*)::int from public.audit_logs where table_name = 'allocations' and reason = '自動振り分け（最小変更）'), 1,
  '最小変更の理由');

-- ================================================================ save_allocation_rows
select tests.login_as('staff');
select throws_ok($$ select public.save_allocation_rows(tests.id('Y1'), '[{"op":"delete","id":"00000000-0000-0000-0000-000000000000"}]', '理由') $$,
  'P0001', 'forbidden', 'staff は手で直せない');
select tests.logout();
select tests.login_as('admin2');
select throws_ok($$ select public.save_allocation_rows(tests.id('Y1'), '[{"op":"delete","id":"00000000-0000-0000-0000-000000000000"}]', '理由') $$,
  'P0001', 'forbidden', '別の年度の admin は手で直せない');
select tests.logout();
-- 部門長・副部門長は手で直せる（試して取り消す）。理由は admin と同じく必須
select is(tests.try_rpc(p, $$ select public.save_allocation_rows(tests.id('Y1'),
            jsonb_build_array(tests.arow('R2', 'G1', 'chair', 'chair', 1) || '{"op":"insert"}'), '部門長が足す') $$), 'ok',
          format('%s は手で振り分けを直せる', p))
from unnest(array['head', 'deputy']) p;
select is(tests.try_rpc('head', $$ select public.save_allocation_rows(tests.id('Y1'),
            jsonb_build_array(tests.arow('R2', 'G1', 'chair', 'chair', 1) || '{"op":"insert"}'), '') $$), 'reason_required',
  '部門長の手での変更も理由が必須');
select tests.login_as('head');
select lives_ok($$ select public.save_allocation_rows(tests.id('Y1'),
                     jsonb_build_array(tests.arow('R2', 'G1', 'lectern', 'lectern', 1) || '{"op":"insert"}'), '部門長が足す') $$,
  '部門長が手で行を足す');
select tests.logout();
select is((select user_id::text || ' ' || reason from public.audit_logs
           where table_name = 'allocations' and action = 'insert' and after ->> 'item_id' = tests.id('lectern')::text),
  tests.id('head')::text || ' 部門長が足す', '部門長の変更も監査に残る（人と理由）');
delete from public.allocations where group_id = tests.id('G1') and item_id = tests.id('lectern');
select tests.login_as('admin');
select throws_ok(format($$ select public.save_allocation_rows(%L, %L, '') $$, tests.id('Y1'),
  jsonb_build_array(jsonb_build_object('op', 'delete', 'id', tests.id('A_G2'), 'updatedAt', '2000-01-01T00:00:00Z'))), 'P0001', 'reason_required', '理由は必須');
select throws_ok($$ select public.save_allocation_rows(tests.id('Y1'), '[]', '理由') $$, 'P0001', 'invalid_input', '変更が空なら invalid_input');
select throws_ok($$ select public.save_allocation_rows(tests.id('Y1'), '[{"op":"merge"}]', '理由') $$, 'P0001', 'invalid_input', '知らない op は invalid_input');
select throws_ok(format($$ select public.save_allocation_rows(%L, %L, '理由') $$, tests.id('Y1'),
  jsonb_build_array(jsonb_build_object('op', 'delete', 'id', tests.id('A_G2')), jsonb_build_object('op', 'update', 'id', tests.id('A_G2')))),
  'P0001', 'invalid_input', '同じ行を2回変えない');
select throws_ok(format($$ select public.save_allocation_rows(%L, %L, '直す') $$, tests.id('Y1'),
  jsonb_build_array(jsonb_build_object('op', 'update', 'id', tests.id('A_G2'), 'updatedAt', '2000-01-01T00:00:00Z', 'count', 2))),
  'P0001', 'conflict', 'updated_at が違えば conflict');
select throws_ok(format($$ select public.save_allocation_rows(%L, %L, '直す') $$, tests.id('Y1'),
  jsonb_build_array(jsonb_build_object('op', 'update', 'id', tests.id('A_G2'), 'count', 2))),
  'P0001', 'conflict', 'updatedAt がなければ conflict');
select throws_ok(format($$ select public.save_allocation_rows(%L, %L, '直す') $$, tests.id('Y1'),
  jsonb_build_array(jsonb_build_object('op', 'delete', 'id', gen_random_uuid(), 'updatedAt', now()))),
  'P0001', 'conflict', '見つからない行（消えた・別の年度）は conflict');
select throws_ok(format($$ select public.save_allocation_rows(%L, %L, '足す') $$, tests.id('Y1'),
  jsonb_build_array(tests.arow('R3', 'G1', 'desk', 'desk', 1) || '{"op":"insert"}')), 'P0001', 'E002', '使用不可の部屋からの行は E002');
select throws_ok(format($$ select public.save_allocation_rows(%L, %L, '足す') $$, tests.id('Y1'),
  jsonb_build_array(tests.arow('R2', 'G3', 'desk', 'desk', 1) || '{"op":"insert"}')), 'P0001', 'invalid_input', '別の年度の団体は invalid_input');
select throws_ok(format($$ select public.save_allocation_rows(%L, %L, '足す') $$, tests.id('Y1'),
  jsonb_build_array(tests.arow('R2', 'G1', 'desk', 'desk', 0) || '{"op":"insert"}')), 'P0001', 'invalid_input', '0 台は invalid_input');
select throws_ok(format($$ select public.save_allocation_rows(%L, %L, '足す') $$, tests.id('Y1'),
  jsonb_build_array(tests.arow('R2', 'G1', 'desk', 'desk', 1) || '{"op":"insert","count":"x"}')), 'P0001', 'invalid_input', '数でない数は invalid_input（22P02 を返さない）');
select throws_ok(format($$ select public.save_allocation_rows(%L, %L, '足す') $$, tests.id('Y1'),
  jsonb_build_array(tests.arow('R2', 'G1', 'chair', 'chair', 1) || jsonb_build_object('op', 'insert', 'note', repeat('x', 2001)))),
  'P0001', 'invalid_input', '備考の上限（2000 字）');
-- 固定だけなら origin は auto のまま
select lives_ok(format($$ select public.save_allocation_rows(%L, %L, '固定する') $$, tests.id('Y1'),
  jsonb_build_array(jsonb_build_object('op', 'update', 'id', tests.id('A_G2'),
    'updatedAt', (select updated_at from public.allocations where id = tests.id('A_G2')), 'pinned', true))), '固定だけ');
select tests.logout();
select is((select origin::text || '/' || pinned::text from public.allocations where id = tests.id('A_G2')), 'auto/true', '固定だけなら origin は auto のまま');
select is((select reason from public.audit_logs where table_name = 'allocations' and row_pk ->> 'id' = tests.id('A_G2')::text order by id desc limit 1),
  '固定する', '手での変更の理由が監査に残る');
-- 数を変えると manual。運び元を使用場所に変えると is_keep を DB が付け直す
select tests.login_as('admin');
select tests.ver() as v2 \gset
select is((public.save_allocation_rows(tests.id('Y1'), jsonb_build_array(jsonb_build_object('op', 'update', 'id', tests.id('A_G2'),
            'updatedAt', (select updated_at from public.allocations where id = tests.id('A_G2')), 'count', 2)), '減らす')
          ->> 'allocation_version_before')::int, :v2, 'ロックした時点（自分の書き込みの前）の版を返す');
select tests.logout();
select ok((select origin = 'manual' and count = 2 from public.allocations where id = tests.id('A_G2')), '数を変えた行は manual');
select tests.login_as('admin');
select lives_ok(format($$ select public.save_allocation_rows(%L, %L, '残す') $$, tests.id('Y1'),
  jsonb_build_array(tests.arow('R1', 'G1', 'chair', 'chair', 2) || '{"op":"insert","isKeep":false}')), '手で行を足す');
select tests.logout();
select ok((select is_keep and origin = 'manual' from public.allocations where group_id = tests.id('G1') and item_id = tests.id('chair')),
  '運び元が使用場所なら is_keep を DB が付ける（送った isKeep は使わない）');
-- 手での保存は E001 を止めない（途中の状態を保存できる。確定で止める）
select tests.login_as('admin');
select lives_ok(format($$ select public.save_allocation_rows(%L, %L, '多め') $$, tests.id('Y1'),
  jsonb_build_array(tests.arow('R1', 'G2', 'desk', 'desk', 100) || '{"op":"insert"}')), '在庫を超える行も手でなら保存できる');
select lives_ok(format($$ select public.save_allocation_rows(%L, %L, '消す') $$, tests.id('Y1'),
  jsonb_build_array(jsonb_build_object('op', 'delete', 'id', tests.id('A_G2'), 'updatedAt', (select updated_at from public.allocations where id = tests.id('A_G2'))))),
  '行を消す');
select tests.logout();
select is((select count(*)::int from public.allocations where id = tests.id('A_G2')), 0, '消した');

-- ================================================================ 確定中は保存できない
delete from public.allocations where group_id = tests.id('G2') and source_room_id = tests.id('R1');
select tests.set_scenario('confirmed');
select tests.login_as('admin');
select throws_ok($$ select public.save_auto_allocations(tests.id('Y1'), '[]', 'full', tests.ver()) $$, 'P0001', 'invalid_state', '確定中は自動の保存ができない');
select throws_ok(format($$ select public.save_allocation_rows(%L, %L, '直す') $$, tests.id('Y1'),
  jsonb_build_array(tests.arow('R2', 'G1', 'chair', 'chair', 1) || '{"op":"insert"}')), 'P0001', 'invalid_state', '確定中は手でも直せない');
select tests.logout();
select throws_ok($$ delete from public.allocations where id = tests.id('A_G1_SWAP') $$, 'P0001', 'invalid_state', '確定中は postgres でも振り分けを変えられない（トリガー）');

select * from finish();
rollback;
