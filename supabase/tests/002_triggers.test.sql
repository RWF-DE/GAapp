-- 002_triggers：時刻・v_remaining・監査・残す・申請できる品目・数えた人・提出の記録・版・確定中の守り・closed のルール（T02）
-- T02 の時点ではポリシーがないので、ロールは切り替えず postgres のまま tests.act_as() で auth.uid() だけを変える。
begin;
\ir _helpers/personas.psql
\ir _helpers/fixture.psql
select plan(148);

-- ---------------------------------------------------------------- 時刻（created_at・updated_at）
select lives_ok($$ insert into public.rooms (name, created_at, updated_at) values ('pgtap-T', '2000-01-01', '2000-01-01') $$, '時刻を指定した insert');
select ok((select created_at = now() and updated_at = now() from public.rooms where name = 'pgtap-T'), 'insert の時刻は DB が入れる（クライアントの値は使わない）');
-- テスト全体が1つのトランザクションなので now() は変わらない。トリガーを止めて過去の時刻を入れ、update で守られるかを見る
alter table public.rooms disable trigger set_timestamps;
update public.rooms set created_at = '2000-01-01', updated_at = '2000-01-01' where name = 'pgtap-T';
alter table public.rooms enable trigger set_timestamps;
select ok((select created_at = '2000-01-01' and updated_at = '2000-01-01' from public.rooms where name = 'pgtap-T'), '準備：過去の created_at・updated_at の行');
select lives_ok($$ update public.rooms set created_at = '2010-01-01', updated_at = '2010-01-01', sort_order = 5 where name = 'pgtap-T' $$, '時刻を指定した update');
select ok((select created_at = '2000-01-01' and updated_at = now() from public.rooms where name = 'pgtap-T'),
  'update で created_at は元のまま（指定した値は使わない）、updated_at は now()');

-- ---------------------------------------------------------------- v_remaining
select is((select count(*)::int from public.v_remaining where year_id = tests.id('Y1')), 3,
  'v_remaining：使用不可の部屋（R3）の在庫は含めない');
select is((select remaining from public.v_remaining where year_id = tests.id('Y1') and room_id = tests.id('R1') and item_id = tests.id('desk')), 6,
  'v_remaining：R1 の机 在庫 10 − 振り分け 4 = 6（残すを含む）');
select is((select allocated from public.v_remaining where year_id = tests.id('Y1') and room_id = tests.id('R2') and item_id = tests.id('desk')), 3,
  'v_remaining：R2 の机の振り分けは 3');
select is((select remaining from public.v_remaining where year_id = tests.id('Y1') and room_id = tests.id('R2') and item_id = tests.id('caster_desk')), 3,
  'v_remaining：R2 のキャスター机は 5 − 2 = 3（置き換えの行）');
select is((select count(*)::int from public.v_remaining where year_id = tests.id('Y1') and room_id = tests.id('R3')), 0,
  'v_remaining：R3 は行がない');
update public.room_years set usable = true where year_id = tests.id('Y1') and room_id = tests.id('R3');
select is((select remaining from public.v_remaining where year_id = tests.id('Y1') and room_id = tests.id('R3') and item_id = tests.id('desk')), 3,
  'v_remaining：使用可に戻すと在庫がそのまま余りに出る（振り分けなし）');
update public.room_years set usable = false where year_id = tests.id('Y1') and room_id = tests.id('R3');
delete from public.room_years where year_id = tests.id('Y1') and room_id = tests.id('R3');
select is((select count(*)::int from public.v_remaining where year_id = tests.id('Y1') and room_id = tests.id('R3')), 1,
  'v_remaining：room_years の行がなければ使用可');
insert into public.room_years (year_id, room_id, usable) values (tests.id('Y1'), tests.id('R3'), false);
select is((select count(*)::int from public.v_remaining where year_id = tests.id('Y1')), 3, 'v_remaining：使用不可に戻すと除かれる');
update public.stocks set count = 3 where year_id = tests.id('Y1') and room_id = tests.id('R2') and item_id = tests.id('desk');
select is((select remaining from public.v_remaining where year_id = tests.id('Y1') and room_id = tests.id('R2') and item_id = tests.id('desk')), 0,
  'v_remaining：在庫 = 振り分けなら余り 0');
update public.stocks set count = 5 where year_id = tests.id('Y1') and room_id = tests.id('R2') and item_id = tests.id('desk');

-- ---------------------------------------------------------------- 監査（理由・user_id・row_pk・変化のない更新）
select is((select count(*)::int from public.audit_logs where table_name in ('invitations', 'profiles')), 0,
  '個人情報を持つ invitations・profiles は監査に書かない（fixture の insert でも）');
select tests.act_as('staff');
update public.stocks set count = 11 where year_id = tests.id('Y1') and room_id = tests.id('R1') and item_id = tests.id('desk');
select tests.act_clear();
select is((select user_id from public.audit_logs where table_name = 'stocks' and action = 'update' order by id desc limit 1),
  tests.id('staff'), '監査の user_id はログイン中の人（auth.uid()）');
select is((select row_pk from public.audit_logs where table_name = 'stocks' and action = 'update' order by id desc limit 1),
  jsonb_build_object('year_id', tests.id('Y1'), 'room_id', tests.id('R1'), 'item_id', tests.id('desk')), 'row_pk は主キーの列');
select is((select (before ->> 'count')::int || '>' || (after ->> 'count')::int from public.audit_logs where table_name = 'stocks' and action = 'update' order by id desc limit 1),
  '10>11', 'before・after は行全体');
select is((select year_id from public.audit_logs where table_name = 'stocks' and action = 'update' order by id desc limit 1), tests.id('Y1'), '年度が入る');
select is((select reason from public.audit_logs where table_name = 'stocks' and action = 'update' order by id desc limit 1), null, '理由を置かなければ null');
select is((select user_id from public.audit_logs where table_name = 'stocks' and action = 'insert' order by id desc limit 1), null, 'auth.uid() がない書き込み（seed・SQL Editor）の user_id は null');

select set_config('app.reason', '数え直し', true);
update public.stocks set count = 10 where year_id = tests.id('Y1') and room_id = tests.id('R1') and item_id = tests.id('desk');
select is((select reason from public.audit_logs where table_name = 'stocks' and action = 'update' order by id desc limit 1), '数え直し', 'app.reason が理由として残る');
select set_config('app.reason', '', true);
update public.stocks set count = 12 where year_id = tests.id('Y1') and room_id = tests.id('R1') and item_id = tests.id('desk');
select is((select reason from public.audit_logs where table_name = 'stocks' and action = 'update' order by id desc limit 1), null, '空の理由は null');
update public.stocks set count = 10 where year_id = tests.id('Y1') and room_id = tests.id('R1') and item_id = tests.id('desk');

select lives_ok($$ update public.rooms set sort_order = sort_order where id = tests.id('R1') $$, '変化のない更新');
select is((select count(*)::int from public.audit_logs where table_name = 'rooms' and action = 'update' and row_pk ->> 'id' = tests.id('R1')::text), 0,
  '変化のない更新は監査に書かない（updated_at だけの変更）');
select lives_ok($$ update public.rooms set name = 'pgtap-R1b' where id = tests.id('R1') $$, '名前を変える');
select is((select after ->> 'name' from public.audit_logs where table_name = 'rooms' and action = 'update' and row_pk ->> 'id' = tests.id('R1')::text), 'pgtap-R1b', '変化のある更新は書く');
update public.rooms set name = 'pgtap-R1' where id = tests.id('R1');

-- insert・delete と、year_id・group_id の入れ方
insert into public.requests (group_id, item_id, count) values (tests.id('G2'), tests.id('chair'), 2);
select is((select action || '/' || coalesce(before::text, 'null') || '/' || (after ->> 'count') from public.audit_logs where table_name = 'requests' and row_pk ->> 'item_id' = tests.id('chair')::text order by id desc limit 1),
  'insert/null/2', 'insert は before が null');
select is((select year_id || '/' || group_id from public.audit_logs where table_name = 'requests' and row_pk ->> 'item_id' = tests.id('chair')::text order by id desc limit 1)::text,
  tests.id('Y1') || '/' || tests.id('G2'), 'year_id を持たない表は団体から年度を引く');
delete from public.requests where group_id = tests.id('G2') and item_id = tests.id('chair');
select is((select action || '/' || (before ->> 'count') || '/' || coalesce(after::text, 'null') from public.audit_logs where table_name = 'requests' and row_pk ->> 'item_id' = tests.id('chair')::text order by id desc limit 1),
  'delete/2/null', 'delete は after が null');
select is((select year_id from public.audit_logs where table_name = 'years' and action = 'insert' and row_pk ->> 'id' = tests.id('Y1')::text), tests.id('Y1'), 'years は自分の id が年度');
select is((select group_id from public.audit_logs where table_name = 'groups' and action = 'insert' and row_pk ->> 'id' = tests.id('G1')::text), tests.id('G1'), 'groups は自分の id が団体');
select is((select year_id from public.audit_logs where table_name = 'rooms' and row_pk ->> 'id' = tests.id('R1')::text order by id desc limit 1), null, '年度をまたぐ表（rooms）の year_id は null');

-- 団体の連鎖削除：消えた子の行にも消える前の団体の年度が入る
select lives_ok($$ delete from public.groups where id = tests.id('G2') $$, '団体を消す（requesting の年度）');
select is((select count(distinct table_name)::int from public.audit_logs where action = 'delete' and table_name in ('requests', 'request_submissions', 'allocations', 'group_members')
            and group_id = tests.id('G2') and year_id = tests.id('Y1')), 4,
  '連鎖で消えた申請・提出・振り分け・団体代表の監査に年度が入る');
select is((select count(*)::int from public.audit_logs where action = 'delete' and group_id = tests.id('G2') and year_id is null), 0, '年度が null の記録がない');

-- ---------------------------------------------------------------- 残す（E005）
select throws_ok(format($$ insert into public.allocations (year_id, source_room_id, group_id, item_id, requested_item_id, count, is_keep, origin)
  values (%L, %L, %L, %L, %L, 1, true, 'auto') $$, tests.id('Y1'), tests.id('R2'), tests.id('G1'), tests.id('desk'), tests.id('desk')),
  'P0001', 'E005', '残す：運び元が使用場所と違えば E005');
select throws_ok(format($$ insert into public.allocations (year_id, source_room_id, group_id, item_id, requested_item_id, count, is_keep, origin)
  values (%L, %L, %L, %L, %L, 1, true, 'auto') $$, tests.id('Y1'), tests.id('R1'), tests.id('G4'), tests.id('desk'), tests.id('desk')),
  'P0001', 'E005', '残す：使用場所のない団体は残せない（null と比べても通さない）');
select lives_ok(format($$ insert into public.allocations (year_id, source_room_id, group_id, item_id, requested_item_id, count, is_keep, origin)
  values (%L, %L, %L, %L, %L, 1, true, 'auto') $$, tests.id('Y1'), tests.id('R1'), tests.id('G1'), tests.id('chair'), tests.id('chair')),
  '残す：運び元 = 使用場所なら通る');
select lives_ok(format($$ insert into public.allocations (year_id, source_room_id, group_id, item_id, requested_item_id, count, is_keep, origin)
  values (%L, %L, %L, %L, %L, 1, false, 'auto') $$, tests.id('Y1'), tests.id('R2'), tests.id('G1'), tests.id('chair'), tests.id('chair')),
  '残すでない行は運び元が何でもよい');
select throws_ok(format($$ update public.allocations set is_keep = true where id = %L $$, tests.id('A_G1_SWAP')),
  'P0001', 'E005', '残す：後から is_keep を true にしても確かめる');
select throws_ok(format($$ update public.allocations set source_room_id = %L where id = %L $$, tests.id('R2'), tests.id('A_G1_KEEP')),
  'P0001', 'E005', '残す：運び元を変えても確かめる');
select lives_ok(format($$ update public.allocations set count = 5 where id = %L $$, tests.id('A_G1_KEEP')), '残す：数だけの更新は通る');

-- ---------------------------------------------------------------- 年度の一致（複合外部キー）
select throws_ok(format($$ insert into public.allocations (year_id, source_room_id, group_id, item_id, requested_item_id, count, origin)
  values (%L, %L, %L, %L, %L, 1, 'manual') $$, tests.id('Y2'), tests.id('R1'), tests.id('G1'), tests.id('desk'), tests.id('desk')),
  '23503', null, '振り分けの year_id は団体の year_id と一致する');
select throws_ok(format($$ update public.allocations set year_id = %L where id = %L $$, tests.id('Y2'), tests.id('A_G1_SWAP')),
  'P0001', 'invalid_input', '振り分けの年度を団体と違う年度に変えられない（年度は変えられない）');
select throws_ok(format($$ insert into public.deliveries (year_id, group_id, kind) values (%L, %L, 'tent') $$, tests.id('Y2'), tests.id('G1')),
  '23503', null, '受け渡しの year_id は団体の year_id と一致する');
select throws_ok(format($$ insert into public.invitations (year_id, email, group_id) values (%L, 'wrong@pgtap.test', %L) $$, tests.id('Y2'), tests.id('G1')),
  '23503', null, '招待の year_id は団体の year_id と一致する');
insert into public.slots (year_id, day, label) values (tests.id('Y2'), 'day1', 'Y2 の時間枠');
select throws_ok(format($$ update public.deliveries set slot_id = (select id from public.slots where label = 'Y2 の時間枠') where id = %L $$, tests.id('D_G1')),
  '23503', null, '受け渡しの時間枠は同じ年度のものだけ');
select lives_ok(format($$ delete from public.slots where id = %L $$, tests.id('SLOT1')), '時間枠を消す');
select ok((select slot_id is null and year_id = tests.id('Y1') from public.deliveries where id = tests.id('D_G1')),
  '時間枠を消しても受け渡しは残り、slot_id だけ null になる');

-- ---------------------------------------------------------------- 申請できる品目（D-05）
select throws_ok(format($$ insert into public.requests (group_id, item_id, count) values (%L, %L, 1) $$, tests.id('G1'), tests.id('desk_ng')),
  'P0001', 'E006', '不可机は申請できない（E006）');
select throws_ok(format($$ insert into public.requests (group_id, item_id, count) values (%L, %L, 1) $$, tests.id('G1'), tests.id('chair_ng')),
  'P0001', 'E006', '不可椅子は申請できない（E006）');
select lives_ok(format($$ insert into public.requests (group_id, item_id, count) values (%L, %L, 0) $$, tests.id('G1'), tests.id('chair_ng')),
  '0 台は通す（全品目を 0 で保存しても困らない）');
select throws_ok(format($$ update public.requests set count = 1 where group_id = %L and item_id = %L $$, tests.id('G1'), tests.id('chair_ng')),
  'P0001', 'E006', '0 台の行を 1 台以上に変えると止める');
select lives_ok(format($$ insert into public.requests (group_id, item_id, count) values (%L, %L, 2) $$, tests.id('G1'), tests.id('long_desk_3')),
  '企業以外でも長机(3人掛)は通す（前処理で長机(2人掛)に読み替える）');
select lives_ok(format($$ insert into public.requests (group_id, item_id, count) values (%L, %L, 2) $$, tests.id('G4'), tests.id('long_desk_3')),
  '部門でも長机(3人掛)は通す');
select lives_ok(format($$ insert into public.requests (group_id, item_id, count) values (%L, %L, 2) $$, tests.id('G1'), tests.id('lectern')),
  '全区分の品目は通す');
select throws_ok(format($$ insert into public.requests (group_id, item_id, count) values (%L, gen_random_uuid(), 1) $$, tests.id('G1')),
  '23503', null, '存在しない品目は E006 でなく外部キーのエラー');
select throws_ok(format($$ insert into public.requests (group_id, item_id, count) values (gen_random_uuid(), %L, 1) $$, tests.id('desk')),
  '23503', null, '存在しない団体は外部キーのエラー');
with g as (insert into public.groups (year_id, name, category) values (tests.id('Y1'), 'T-G5', 'company') returning id)
insert into tests.ids select 'G5', id from g;
select lives_ok(format($$ insert into public.requests (group_id, item_id, count) values (%L, %L, 1) $$, tests.id('G5'), tests.id('long_desk_3')), '企業は長机(3人掛)を申請できる');
select throws_ok(format($$ insert into public.requests (group_id, item_id, count) values (%L, %L, 1) $$, tests.id('G5'), tests.id('desk_ng')),
  'P0001', 'E006', '企業でも不可机は申請できない');

-- ---------------------------------------------------------------- 数えた人（K-25）
select tests.act_as('staff');
insert into public.stocks (year_id, room_id, item_id, count, counted_by, counted_at)
values (tests.id('Y1'), tests.id('R1'), tests.id('chair'), 7, tests.id('admin'), '2000-01-01');
select tests.act_clear();
select is((select counted_by from public.stocks where year_id = tests.id('Y1') and room_id = tests.id('R1') and item_id = tests.id('chair')),
  tests.id('staff'), 'insert：counted_by は書いた人（クライアントの値は使わない）');
select ok((select counted_at = now() from public.stocks where year_id = tests.id('Y1') and room_id = tests.id('R1') and item_id = tests.id('chair')),
  'insert：counted_at は now()');
select tests.act_as('admin');
update public.stocks set count = 8, counted_by = tests.id('staff'), counted_at = '2000-01-01'
where year_id = tests.id('Y1') and room_id = tests.id('R1') and item_id = tests.id('chair');
select tests.act_clear();
select is((select counted_by from public.stocks where year_id = tests.id('Y1') and room_id = tests.id('R1') and item_id = tests.id('chair')),
  tests.id('admin'), 'update：counted_by は更新した人');
select ok((select counted_at = now() from public.stocks where year_id = tests.id('Y1') and room_id = tests.id('R1') and item_id = tests.id('chair')),
  'update：counted_at は now()');
insert into public.stocks (year_id, room_id, item_id, count, counted_by, counted_at)
values (tests.id('Y1'), tests.id('R2'), tests.id('chair'), 1, tests.id('rep'), '2020-05-05');
select is((select counted_by || '/' || counted_at::date from public.stocks where year_id = tests.id('Y1') and room_id = tests.id('R2') and item_id = tests.id('chair')),
  tests.id('rep') || '/2020-05-05', 'auth.uid() がない書き込み（seed）は渡した値のまま');

-- ---------------------------------------------------------------- 提出の記録
select tests.act_as('rep2');
insert into public.request_submissions (group_id, submitted_at, note) values (tests.id('G5'), '2000-01-01', 'x');
select tests.act_clear();
select ok((select submitted_at = now() and updated_by = tests.id('rep2') from public.request_submissions where group_id = tests.id('G5')),
  'insert：submitted_at は now()、updated_by は書いた人');
update public.request_submissions set submitted_at = '2020-01-01' where group_id = tests.id('G5');   -- seed 相当（auth.uid() なし）
select is((select submitted_at from public.request_submissions where group_id = tests.id('G5')), '2020-01-01'::timestamptz, 'auth.uid() なしは渡した値のまま');
select tests.act_as('rep');
update public.request_submissions set note = '備考だけ' where group_id = tests.id('G5');
select tests.act_clear();
select is((select submitted_at from public.request_submissions where group_id = tests.id('G5')), '2020-01-01'::timestamptz, '備考だけの更新では submitted_at を変えない');
select is((select updated_by from public.request_submissions where group_id = tests.id('G5')), tests.id('rep'), '更新した人が updated_by');
select tests.act_as('rep');
update public.request_submissions set submitted_at = '2001-01-01' where group_id = tests.id('G5');
select tests.act_clear();
select ok((select submitted_at = now() from public.request_submissions where group_id = tests.id('G5')), 'submitted_at を変える更新は now() にそろえる');
select tests.act_as('rep');
update public.request_submissions set submitted_at = null where group_id = tests.id('G5');
select tests.act_clear();
select is((select submitted_at from public.request_submissions where group_id = tests.id('G5')), null, '未提出に戻せる');

-- ---------------------------------------------------------------- 距離の組の向き
insert into public.distance_overrides (building_a, building_b, cost) values ('pgtap棟Z', 'pgtap棟A2', 13);
select is((select building_a || '|' || building_b from public.distance_overrides where cost = 13), 'pgtap棟A2|pgtap棟Z', '向きを問わず入れると小さい方が building_a になる');
insert into public.distance_overrides (building_a, building_b, cost) values ('a', 'Z', 14);
select is((select building_a || '|' || building_b from public.distance_overrides where cost = 14), 'Z|a',
  'C の照合順序（コードポイント順）で並べる。DB の照合順序（a < Z）や JavaScript の localeCompare に依存しない');
insert into public.distance_overrides (building_a, building_b, cost) values ('Z', 'a', 15)
  on conflict (building_a, building_b) do update set cost = 16;
select is((select count(*)::int || '/' || max(cost) from public.distance_overrides where building_a = 'Z' and building_b = 'a'), '1/16',
  '同じ組を逆順で入れても主キーが衝突する（upsert できる）');
select throws_ok($$ insert into public.distance_overrides (building_a, building_b, cost) values ('a', 'Z', 17) $$, '23505', null, '逆順の同じ組は二重に入れられない');
update public.distance_overrides set building_a = 'zz', building_b = 'yy' where cost = 13;
select is((select building_a || '|' || building_b from public.distance_overrides where cost = 13), 'yy|zz', '更新でも向きをそろえる');
select throws_ok($$ update public.distance_overrides set building_b = building_a where cost = 13 $$, '23514', null, '更新で同じ建物にはできない');

-- ---------------------------------------------------------------- rules.year_id は変えられない
select throws_ok(format($$ update public.rules set year_id = %L where id = %L $$, tests.id('Y2'), tests.id('RULE1')),
  'P0001', 'invalid_input', 'ルールの year_id は変えられない');
select lives_ok(format($$ update public.rules set memo = 'メモ', enabled = false where id = %L $$, tests.id('RULE1')), 'ほかの列は変えられる（受付中）');

-- ---------------------------------------------------------------- 年度・団体は付け替えられない（check_immutable）
select throws_ok(format($$ update public.room_years set year_id = %L where year_id = %L and room_id = %L $$, tests.id('Y2'), tests.id('Y1'), tests.id('R3')),
  'P0001', 'invalid_input', 'room_years.year_id は変えられない');
select throws_ok(format($$ update public.stocks set year_id = %L where year_id = %L and room_id = %L and item_id = %L $$, tests.id('Y2'), tests.id('Y1'), tests.id('R1'), tests.id('desk')),
  'P0001', 'invalid_input', 'stocks.year_id は変えられない');
select throws_ok(format($$ update public.groups set year_id = %L where id = %L $$, tests.id('Y2'), tests.id('G4')),
  'P0001', 'invalid_input', 'groups.year_id は変えられない');
select throws_ok(format($$ update public.year_roles set year_id = %L where year_id = %L and user_id = %L $$, tests.id('Y2'), tests.id('Y1'), tests.id('staff')),
  'P0001', 'invalid_input', 'year_roles.year_id は変えられない');
select throws_ok(format($$ update public.invitations set year_id = %L where email = 'someone@pgtap.test' $$, tests.id('Y2')),
  'P0001', 'invalid_input', 'invitations.year_id は変えられない');
select throws_ok(format($$ update public.allocations set year_id = %L, group_id = %L where id = %L $$, tests.id('Y2'), tests.id('G3'), tests.id('A_G1_SWAP')),
  'P0001', 'invalid_input', 'allocations は年度と団体を一緒に変えても別の年度へ動かせない（複合外部キーを通る抜け道）');
select throws_ok(format($$ update public.slots set year_id = %L where label = 'Y2 の時間枠' $$, tests.id('Y1')),
  'P0001', 'invalid_input', 'slots.year_id は変えられない');
select throws_ok(format($$ update public.deliveries set year_id = %L, group_id = %L where id = %L $$, tests.id('Y2'), tests.id('G3'), tests.id('D_G1')),
  'P0001', 'invalid_input', 'deliveries は年度と団体を一緒に変えても別の年度へ動かせない');
select throws_ok(format($$ update public.group_members set group_id = %L where group_id = %L and user_id = %L $$, tests.id('G3'), tests.id('G1'), tests.id('rep')),
  'P0001', 'invalid_input', 'group_members.group_id は変えられない');
select throws_ok(format($$ update public.request_submissions set group_id = %L where group_id = %L $$, tests.id('G3'), tests.id('G1')),
  'P0001', 'invalid_input', 'request_submissions.group_id は変えられない');
select throws_ok(format($$ update public.requests set group_id = %L where group_id = %L and item_id = %L $$, tests.id('G3'), tests.id('G1'), tests.id('desk')),
  'P0001', 'invalid_input', 'requests.group_id は変えられない（別の年度の団体へも）');
select throws_ok(format($$ update public.substitution_consents set group_id = %L where group_id = %L $$, tests.id('G3'), tests.id('G1')),
  'P0001', 'invalid_input', 'substitution_consents.group_id は変えられない');
select throws_ok(format($$ update public.allocations set group_id = %L where id = %L $$, tests.id('G3'), tests.id('A_G1_SWAP')),
  '23503', null, 'allocations.group_id を別の年度の団体へは変えられない（複合外部キー）');
select lives_ok(format($$ update public.allocations set group_id = %L where id = %L $$, tests.id('G4'), tests.id('A_G1_SWAP')),
  'allocations.group_id は同じ年度の別の団体へ変えられる');
update public.allocations set group_id = tests.id('G1') where id = tests.id('A_G1_SWAP');
select lives_ok(format($$ update public.groups set year_id = year_id, name = name where id = %L $$, tests.id('G4')),
  '値が同じなら year_id を指定した update も通る');

-- ---------------------------------------------------------------- lock_year_guard
select is(private.lock_year_guard(tests.id('Y1')), 'requesting'::public.year_status, 'lock_year_guard は状態を返す');
select is(private.lock_year_guard(gen_random_uuid()), null, 'lock_year_guard は年度がなければ null');

-- ---------------------------------------------------------------- 版の増分（allocating だけ）
select tests.ver() as v0 \gset
update public.stocks set count = count + 1 where year_id = tests.id('Y1');
insert into public.requests (group_id, item_id, count) values (tests.id('G1'), tests.id('blue_chair'), 1);
select is(tests.ver(), :v0, '受付中の書き込みでは版は増えない');
update public.years set status = 'allocating' where id = tests.id('Y1');
select is(tests.ver(), :v0, '年度の状態の更新だけでは版は増えない（遷移の増分は T03 の RPC）');
select tests.ver() as v1 \gset
update public.stocks set count = count + 1 where year_id = tests.id('Y1');
select is(tests.ver(), :v1 + 1, 'allocating：複数行の update でも文につき 1 回だけ増える');
update public.stocks set count = count where year_id = tests.id('Y1') and room_id = tests.id('R4');
select is(tests.ver(), :v1 + 1, '対象の行がない update では増えない');
insert into public.requests (group_id, item_id, count) values (tests.id('G1'), tests.id('chair'), 1);
select is(tests.ver(), :v1 + 2, 'requests の insert（団体から年度を引く）');
update public.requests set count = 3 where group_id = tests.id('G1') and item_id = tests.id('chair');
select is(tests.ver(), :v1 + 3, 'requests の update');
delete from public.requests where group_id = tests.id('G1') and item_id = tests.id('chair');
select is(tests.ver(), :v1 + 4, 'requests の delete');
update public.request_submissions set note = '版' where group_id = tests.id('G1');
select is(tests.ver(), :v1 + 5, 'request_submissions');
update public.substitution_consents set status = 'asked', count = 2 where group_id = tests.id('G1');
select is(tests.ver(), :v1 + 6, 'substitution_consents');
update public.rules set enabled = true where id = tests.id('RULE1');
select is(tests.ver(), :v1 + 7, 'rules');
update public.room_years set note = '版' where year_id = tests.id('Y1') and room_id = tests.id('R3');
select is(tests.ver(), :v1 + 8, 'room_years');
update public.groups set display_name = '版' where id = tests.id('G1');
select is(tests.ver(), :v1 + 9, 'groups');
update public.allocations set note = '版' where id = tests.id('A_G1_KEEP');
select is(tests.ver(), :v1 + 10, 'allocations');
update public.rooms set sort_order = 9 where id = tests.id('R4');
select is(tests.ver(), :v1 + 11, '年度をまたぐ rooms は allocating の年度の版を増やす');
update public.items set sort_order = 99 where id = tests.id('spare');
select is(tests.ver(), :v1 + 12, '年度をまたぐ items');
update public.distance_overrides set cost = 9 where cost = 16;
select is(tests.ver(), :v1 + 13, '年度をまたぐ distance_overrides');
select is(tests.ver_of('Y2'), 0, 'allocating でない年度（Y2）の版は増えない');
update public.slots set label = '版' where year_id = tests.id('Y2');
select is(tests.ver(), :v1 + 13, '入力にならない表（slots）では増えない');
update public.rooms set sort_order = sort_order where id = tests.id('R4');
select is(tests.ver(), :v1 + 14, '値が同じ update でも、文が行に当たれば増える（監査は書かない）');
select is((select count(*)::int from public.audit_logs where table_name = 'years' and (after ->> 'allocation_version')::int > :v0), 0,
  '版の増分は監査に残らない');

-- ---------------------------------------------------------------- 確定中の守り
update public.years set status = 'confirmed' where id = tests.id('Y1');
select throws_ok($$ delete from public.groups where id = tests.id('G1') $$, 'P0001', 'invalid_state', '確定中は団体を消せない（振り分けが連鎖で消えない）');
select throws_ok($$ update public.groups set location_room_id = tests.id('R2') where id = tests.id('G1') $$, 'P0001', 'invalid_state', '確定中は使用場所を変えられない（E005）');
select throws_ok($$ update public.groups set category = 'company' where id = tests.id('G1') $$, 'P0001', 'invalid_state', '確定中は区分を変えられない');
select throws_ok($$ update public.groups set year_id = tests.id('Y2') where id = tests.id('G4') $$, 'P0001', 'invalid_input', '確定中は年度を変えられない（そもそも変えられない）');
select throws_ok($$ update public.allocations set year_id = tests.id('Y2'), group_id = tests.id('G3') where id = tests.id('A_G1_SWAP') $$,
  'P0001', 'invalid_input', '確定中の年度から振り分けを別の年度へ抜き出せない');
select lives_ok($$ update public.groups set display_name = '表示名だけ', sort_order = 9 where id = tests.id('G1') $$, '確定中でも表示名・並び順は直せる');
select throws_ok($$ update public.stocks set count = 0 where year_id = tests.id('Y1') and room_id = tests.id('R2') and item_id = tests.id('caster_desk') $$,
  'P0001', 'invalid_state', '確定中は振り分けより少ない在庫にできない（E001）');
select throws_ok($$ delete from public.stocks where year_id = tests.id('Y1') and room_id = tests.id('R2') and item_id = tests.id('caster_desk') $$,
  'P0001', 'invalid_state', '確定中は振り分けのある在庫を消せない');
select lives_ok($$ update public.stocks set count = 2 where year_id = tests.id('Y1') and room_id = tests.id('R2') and item_id = tests.id('caster_desk') $$,
  '確定中でも振り分けと同じ数までは減らせる');
select lives_ok($$ update public.stocks set count = count + 1 where year_id = tests.id('Y1') and room_id = tests.id('R2') and item_id = tests.id('caster_desk') $$,
  '確定中でも在庫を増やす数え直しはできる');
select lives_ok($$ update public.stocks set count = 0 where year_id = tests.id('Y1') and room_id = tests.id('R3') and item_id = tests.id('desk') $$,
  '確定中でも振り分けのない在庫は減らせる');
select throws_ok($$ update public.stocks set room_id = tests.id('R4') where year_id = tests.id('Y1') and room_id = tests.id('R2') and item_id = tests.id('caster_desk') $$,
  'P0001', 'invalid_state', '確定中は在庫の行を別の場所へ付け替えられない');
select throws_ok($$ insert into public.room_years (year_id, room_id, usable) values (tests.id('Y1'), tests.id('R2'), false) $$,
  'P0001', 'invalid_state', '確定中は振り分けのある部屋を使用不可にできない（E002）');
select lives_ok($$ insert into public.room_years (year_id, room_id, usable) values (tests.id('Y1'), tests.id('R4'), false) $$,
  '確定中でも振り分けのない部屋は使用不可にできる');
select lives_ok($$ update public.room_years set usable = true where year_id = tests.id('Y1') and room_id = tests.id('R4') $$, '使用可に戻すのは通る');
select throws_ok($$ update public.allocations set count = 1 where id = tests.id('A_G1_SWAP') $$, 'P0001', 'invalid_state', '確定中は postgres でも振り分けを変えられない');
select throws_ok($$ delete from public.allocations where id = tests.id('A_G1_KEEP') $$, 'P0001', 'invalid_state', '確定中は振り分けを消せない');
select throws_ok(format($$ insert into public.allocations (year_id, source_room_id, group_id, item_id, requested_item_id, count, origin)
  values (%L, %L, %L, %L, %L, 1, 'manual') $$, tests.id('Y1'), tests.id('R1'), tests.id('G4'), tests.id('desk'), tests.id('desk')),
  'P0001', 'invalid_state', '確定中は振り分けを足せない');
select lives_ok($$ update public.rules set enabled = false where id = tests.id('RULE1') $$, '確定中のルールは直せる（解除してからの運用は画面側）');

-- closed
update public.years set status = 'closed' where id = tests.id('Y1');
select throws_ok($$ delete from public.groups where id = tests.id('G4') $$, 'P0001', 'invalid_state', 'closed でも団体を消せない');
select throws_ok($$ delete from public.allocations where id = tests.id('A_G1_KEEP') $$, 'P0001', 'invalid_state', 'closed でも振り分けを変えられない');
select lives_ok($$ update public.rules set memo = '見直し点：S05 を再検討' where id = tests.id('RULE1') $$, 'closed でもルールの memo は書ける');
select throws_ok($$ update public.rules set enabled = true where id = tests.id('RULE1') $$, 'P0001', 'invalid_state', 'closed ではルールの memo 以外を変えられない');
select throws_ok($$ update public.rules set params = '{}', memo = 'x' where id = tests.id('RULE1') $$, 'P0001', 'invalid_state', 'memo と一緒でも、ほかの列を変えれば止める');
select throws_ok($$ update public.rules set year_id = tests.id('Y2') where id = tests.id('RULE1') $$, 'P0001', 'invalid_input', 'closed の年度のルールを別の年度へ移せない');
select lives_ok($$ update public.deliveries set returned = true where id = tests.id('D_G1') $$, 'closed でも返却のチェックは書ける（受け渡しは守りの対象外）');

-- ---------------------------------------------------------------- 年度ごと消す（連鎖）は守りに止められない
select coalesce(max(id), 0) as a0 from public.audit_logs \gset
select lives_ok($$ delete from public.years where id = tests.id('Y1') $$, 'closed の年度を年度ごと消せる（SQL Editor から。連鎖で団体・振り分けも消える）');
select is((select count(*)::int from public.allocations where year_id = tests.id('Y1')), 0, '連鎖で振り分けも消えた');
select is((select count(*)::int from public.audit_logs where id > :a0 and table_name = 'allocations' and action = 'delete' and year_id = tests.id('Y1')), 4,
  '年度の連鎖削除で消えた振り分けの監査にも年度が入る');
select is((select count(*)::int from public.audit_logs where id > :a0 and action = 'delete' and year_id is null and table_name <> 'years'), 0,
  '年度の連鎖削除で消えた行の監査に、年度が null のものがない');
select lives_ok($$ delete from public.groups where id = tests.id('G3') $$, '受付前の年度（Y2）の団体は消せる');

select * from finish();
rollback;
