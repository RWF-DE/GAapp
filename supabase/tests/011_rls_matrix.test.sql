-- 011_rls_matrix：権限表の全セル（表 × 操作 × 年度の状態 × ペルソナ）（T03。T15 で総務部門長・副部門長を、T17 でお知らせの notices・notice_groups を、
-- T18 で予定と締切の events を、T19 で提出物の documents・document_submissions・document_files と2つのビューを、T20 でシフト・作業の5表を足した）
-- 期待値の表（tests.expect）から、試す SQL（tests.cell_sql）と、Y1 の6つの状態（preparing、requesting、requesting:after＝締切後、
-- allocating、confirmed、closed）と、8人のペルソナ（admin staff rep viewer outsider admin2 head deputy）を掛け合わせてセルを作る。
-- yn は期待値の列の順（admin staff rep viewer outsider admin2 head）に Y（allowed）/N（denied）を並べた7文字。どのペルソナがどの列で
-- 確かめるかは tests.persona_col が決める。deputy（総務副部門長）は head（総務部門長）の列で確かめる（権限は同じ。D-48。文字を写さない）。
-- scenario が '*' の行は、その表・操作の既定（状態ごとの行がなければこれ）。
-- 各セルは副トランザクションの中でペルソナに切り替えて実行し、取り消す（tests.try_cell）。select は件数 > 0、書き込みは影響した
-- 行数 > 0 を allowed、42501（権限なし・with check 違反）・0 行（using で見えない）・トリガーの invalid_state（確定中の守り）を denied とする。
-- それ以外のエラーは error:<SQLSTATE> になり、期待値と合わないので、テストデータの不備が「拒否された」に紛れない。
-- ペルソナ（fixture）：admin・head・deputy・staff・viewer は Y1 のロール（head は総務部門長、deputy は総務副部門長）。
-- rep は G1（Y1）の代表で Y2 の viewer。viewer は G4（Y1）の副店長も兼ねる。staff は G3（Y2）の店長（兼任の禁止で、同じ年度の
-- 団体代表は兼ねられない。D-49）。admin2 は Y2（preparing）の admin。outsider はロールも団体もない。
-- head の列は、notes/T15.md の「権限の段」（02「権限とRLS」）から書いた：部門長以上（LEAD）の表（room_years・slots・deliveries・rules の
-- 書き込み、在庫の allocating・confirmed の書き込み、申請の直接の書き込み、year_roles・group_members の全行、staff と団体の招待、
-- 年度の履歴）は Y、管理者だけの表（rooms・items・distance_overrides・groups の書き込み、年度のない履歴、admin・viewer の招待）は N
begin;
\ir _helpers/personas.psql
\ir _helpers/fixture.psql

create table tests.cell_sql (tbl text, op text, template text, primary key (tbl, op));
create table tests.expect (tbl text, op text, scenario text, yn text, primary key (tbl, op, scenario));

insert into tests.cell_sql values
 -- 年度
 ('years','select','select count(*) from public.years where id = :Y1'),
 ('years','insert','insert into public.years(label, festival_start) values (gen_random_uuid()::text, current_date)'),
 ('years','update','update public.years set label = label where id = :Y1'),
 ('years','delete','delete from public.years where id = :Y1'),
 -- 年度をまたぐ表（D-01）
 ('rooms','select','select count(*) from public.rooms where id = :R1'),
 ('rooms','insert','insert into public.rooms(name) values (gen_random_uuid()::text)'),
 ('rooms','update','update public.rooms set sort_order = sort_order where id = :R1'),
 ('rooms','delete','delete from public.rooms where id = :R4'),
 ('items','select','select count(*) from public.items where id = :desk'),
 ('items','insert','insert into public.items(code, name, sort_order) values (''x_'' || substr(md5(random()::text), 1, 8), ''x'', 99)'),
 ('items','update','update public.items set name = name where id = :desk'),
 ('items','delete','delete from public.items where id = :spare'),
 ('distance_overrides','select','select count(*) from public.distance_overrides where building_a = ''pgtap棟A'''),
 ('distance_overrides','insert','insert into public.distance_overrides values (''pgtap棟Z'', ''pgtap棟Y'', 1)'),
 ('distance_overrides','update','update public.distance_overrides set cost = cost where building_a = ''pgtap棟A'''),
 ('distance_overrides','delete','delete from public.distance_overrides where building_a = ''pgtap棟A'''),
 -- 場所の状態・時間枠
 ('room_years','select','select count(*) from public.room_years where year_id = :Y1'),
 ('room_years','insert','insert into public.room_years(year_id, room_id, usable) values (:Y1, :R4, false)'),
 ('room_years','update','update public.room_years set usable = usable where year_id = :Y1'),
 ('room_years','delete','delete from public.room_years where year_id = :Y1'),
 ('room_years(unusable)','insert','insert into public.room_years(year_id, room_id, usable) values (:Y1, :R2, false) on conflict (year_id, room_id) do update set usable = false'),
 ('slots','select','select count(*) from public.slots where year_id = :Y1'),
 ('slots','insert','insert into public.slots(year_id, day, label) values (:Y1, ''day1'', ''x'')'),
 ('slots','update','update public.slots set label = label where year_id = :Y1'),
 ('slots','delete','delete from public.slots where year_id = :Y1'),
 -- 在庫
 ('stocks','select','select count(*) from public.stocks where year_id = :Y1'),
 ('stocks','insert','insert into public.stocks(year_id, room_id, item_id, count) values (:Y1, :R4, :desk, 1)'),
 ('stocks','update','update public.stocks set count = count where year_id = :Y1 and room_id = :R1'),
 ('stocks','delete','delete from public.stocks where year_id = :Y1 and room_id = :R1'),
 ('stocks(decrease)','update','update public.stocks set count = 0 where year_id = :Y1 and room_id = :R1 and item_id = :desk'),
 ('v_remaining','select','select count(*) from public.v_remaining where year_id = :Y1'),
 -- 団体
 ('groups','select','select count(*) from public.groups where id = :G1'),
 ('groups(G2)','select','select count(*) from public.groups where id = :G2'),
 ('groups','insert','insert into public.groups(year_id, name, category) values (:Y1, gen_random_uuid()::text, ''stall'')'),
 ('groups','update','update public.groups set sort_order = sort_order where id = :G1'),
 ('groups','delete','delete from public.groups where id = :G1'),
 ('groups(location)','update','update public.groups set location_room_id = :R2 where id = :G1'),
 -- ロール・団体代表・招待（書き込みは RPC だけ）
 ('year_roles','select','select count(*) from public.year_roles where year_id = :Y1 and user_id = :staff'),
 ('year_roles(own)','select','select count(*) from public.year_roles where user_id = auth.uid()'),
 ('year_roles','insert','insert into public.year_roles values (:Y1, :outsider, ''viewer'')'),
 ('year_roles','update','update public.year_roles set role = role where year_id = :Y1'),
 ('year_roles','delete','delete from public.year_roles where year_id = :Y1'),
 ('group_members','select','select count(*) from public.group_members where group_id = :G1'),
 ('group_members(own)','select','select count(*) from public.group_members where user_id = auth.uid()'),
 ('group_members(G4)','select','select count(*) from public.group_members where group_id = :G4'),
 ('group_members','insert','insert into public.group_members(group_id, user_id) values (:G1, :outsider)'),
 ('group_members','update','update public.group_members set user_id = user_id where group_id = :G1'),
 ('group_members','delete','delete from public.group_members where group_id = :G1'),
 ('invitations','select','select count(*) from public.invitations where email = ''someone@pgtap.test'''),
 ('invitations(own)','select','select count(*) from public.invitations where email = lower(auth.jwt() ->> ''email'')'),
 -- T15：部門長・副部門長が読める招待は staff のロールの招待（上の someone）と団体の招待だけ。admin・viewer のロールの招待は読めない
 ('invitations(admin)','select','select count(*) from public.invitations where id = :INV_ADMIN'),
 ('invitations(viewer)','select','select count(*) from public.invitations where email = ''viewer@pgtap.test'' and role = ''viewer'''),
 ('invitations(group)','select','select count(*) from public.invitations where email = ''rep@pgtap.test'' and group_id = :G1'),
 ('invitations','insert','insert into public.invitations(year_id, email, role) values (:Y1, ''new@pgtap.test'', ''staff'')'),
 ('invitations','update','update public.invitations set used_at = now() where year_id = :Y1'),
 ('invitations','delete','delete from public.invitations where year_id = :Y1'),
 -- 申請
 ('request_submissions','select','select count(*) from public.request_submissions where group_id = :G1'),
 ('request_submissions(G2)','select','select count(*) from public.request_submissions where group_id = :G2'),
 ('request_submissions','insert','insert into public.request_submissions(group_id) values (:G1) on conflict (group_id) do update set note = ''x'''),
 ('request_submissions','update','update public.request_submissions set note = ''x'' where group_id = :G1'),
 ('request_submissions(G2)','update','update public.request_submissions set note = ''x'' where group_id = :G2'),
 ('request_submissions','delete','delete from public.request_submissions where group_id = :G1'),
 ('requests','select','select count(*) from public.requests where group_id = :G1'),
 ('requests(G2)','select','select count(*) from public.requests where group_id = :G2'),
 ('requests','insert','insert into public.requests(group_id, item_id, count) values (:G1, :chair, 1)'),
 ('requests(G4)','insert','insert into public.requests(group_id, item_id, count) values (:G4, :desk, 1)'),
 ('requests','update','update public.requests set count = 7 where group_id = :G1'),
 ('requests(G2)','update','update public.requests set count = 7 where group_id = :G2'),
 ('requests','delete','delete from public.requests where group_id = :G1'),
 -- ルール
 ('rules','select','select count(*) from public.rules where year_id = :Y1'),
 ('rules','insert','insert into public.rules(year_id, code, kind, params) values (:Y1, ''S99'', ''keep'', ''{}'')'),
 ('rules','update','update public.rules set memo = ''x'' where year_id = :Y1'),
 ('rules(enabled)','update','update public.rules set enabled = not enabled where year_id = :Y1'),
 ('rules','delete','delete from public.rules where year_id = :Y1'),
 -- 了承・振り分け・受け渡し
 ('substitution_consents','select','select count(*) from public.substitution_consents where group_id = :G1'),
 ('substitution_consents','insert','insert into public.substitution_consents(group_id, from_item_id, to_item_id) values (:G1, :chair, :chair_ng)'),
 ('substitution_consents','update','update public.substitution_consents set status = ''accepted'' where group_id = :G1'),
 ('substitution_consents','delete','delete from public.substitution_consents where group_id = :G1'),
 ('allocations','select','select count(*) from public.allocations where group_id = :G1'),
 ('allocations(G2)','select','select count(*) from public.allocations where group_id = :G2'),
 ('allocations','insert','insert into public.allocations(year_id, source_room_id, group_id, item_id, requested_item_id, count, origin) values (:Y1, :R2, :G1, :desk, :desk, 1, ''manual'')'),
 ('allocations','update','update public.allocations set count = count where group_id = :G1'),
 ('allocations','delete','delete from public.allocations where group_id = :G1'),
 ('deliveries','select','select count(*) from public.deliveries where group_id = :G1'),
 ('deliveries(G2)','select','select count(*) from public.deliveries where group_id = :G2'),
 ('deliveries','insert','insert into public.deliveries(year_id, group_id, kind) values (:Y1, :G1, ''tent'')'),
 ('deliveries','update','update public.deliveries set status = ''done'' where group_id = :G1'),
 ('deliveries','delete','delete from public.deliveries where group_id = :G1'),
 -- ユーザー・履歴
 ('profiles','select','select count(*) from public.profiles where user_id = :admin'),
 ('profiles(own)','select','select count(*) from public.profiles where user_id = auth.uid()'),
 ('profiles(rep)','select','select count(*) from public.profiles where user_id = :rep'),
 ('profiles','insert','insert into public.profiles values (:outsider, ''x'')'),
 ('profiles','update','update public.profiles set display_name = ''x'''),
 ('profiles','delete','delete from public.profiles'),
 ('audit_logs','select','select count(*) from public.audit_logs where year_id = :Y1'),
 ('audit_logs(global)','select','select count(*) from public.audit_logs where year_id is null'),
 ('audit_logs','insert','insert into public.audit_logs(table_name, row_pk, action) values (''x'', ''{}'', ''insert'')'),
 ('audit_logs','update','update public.audit_logs set reason = ''x'''),
 ('audit_logs','delete','delete from public.audit_logs'),
 -- お知らせ（T17）：宛先ごとのお知らせ（fixture）を1件ずつ読む。N_G1 は rep の団体 G1 あて、N_G4 は rep の団体でない G4 あて
 -- （viewer が副店長）、Y2 の N_Y2_G3 は staff が店長の G3 あて。書き込みは RPC だけ（表に権限がない）
 ('notices','select','select count(*) from public.notices where id = :N_SOUMU'),
 ('notices(all_groups)','select','select count(*) from public.notices where id = :N_ALL'),
 ('notices(G1)','select','select count(*) from public.notices where id = :N_G1'),
 ('notices(G4)','select','select count(*) from public.notices where id = :N_G4'),
 ('notices(Y2 soumu)','select','select count(*) from public.notices where id = :N_Y2_SOUMU'),
 ('notices(Y2 all_groups)','select','select count(*) from public.notices where id = :N_Y2_ALL'),
 ('notices(Y2 G3)','select','select count(*) from public.notices where id = :N_Y2_G3'),
 ('notices','insert','insert into public.notices(year_id, audience, title) values (:Y1, ''soumu'', ''x'')'),
 ('notices','update','update public.notices set title = title where year_id = :Y1'),
 ('notices','delete','delete from public.notices where year_id = :Y1'),
 -- 宛先の団体：団体ごとの行を読む（N_G12 の G2 の行は、G1 の rep が読める N_G12 の、ほかの団体の行）
 ('notice_groups','select','select count(*) from public.notice_groups where group_id = :G1'),
 ('notice_groups(G2)','select','select count(*) from public.notice_groups where group_id = :G2'),
 ('notice_groups(G4)','select','select count(*) from public.notice_groups where group_id = :G4'),
 ('notice_groups(Y2 G3)','select','select count(*) from public.notice_groups where group_id = :G3'),
 ('notice_groups','insert','insert into public.notice_groups(notice_id, year_id, group_id) values (:N_G1, :Y1, :G2)'),
 ('notice_groups','update','update public.notice_groups set group_id = group_id where year_id = :Y1'),
 ('notice_groups','delete','delete from public.notice_groups where year_id = :Y1'),
 -- 予定と締切（T18）：対象ごとの項目（fixture）を1件ずつ読み、書く。E_* は Y1、E_Y2_* は Y2（準備中のまま）。書き込みは RLS（can_lead）
 ('events','select','select count(*) from public.events where id = :E_SOUMU'),
 ('events(groups)','select','select count(*) from public.events where id = :E_GROUPS'),
 ('events(all)','select','select count(*) from public.events where id = :E_ALL'),
 ('events(Y2 soumu)','select','select count(*) from public.events where id = :E_Y2_SOUMU'),
 ('events(Y2 groups)','select','select count(*) from public.events where id = :E_Y2_GROUPS'),
 ('events(Y2 all)','select','select count(*) from public.events where id = :E_Y2_ALL'),
 ('events','insert','insert into public.events(year_id, kind, audience, title, starts_at) values (:Y1, ''event'', ''soumu'', ''x'', now())'),
 ('events(groups)','insert','insert into public.events(year_id, kind, audience, title, starts_at) values (:Y1, ''deadline'', ''groups'', ''x'', now())'),
 ('events(all)','insert','insert into public.events(year_id, kind, audience, title, starts_at, all_day) values (:Y1, ''event'', ''all'', ''x'', ''2027-10-16 00:00+09'', true)'),
 ('events(Y2)','insert','insert into public.events(year_id, kind, audience, title, starts_at) values (:Y2, ''event'', ''all'', ''x'', now())'),
 ('events','update','update public.events set title = title where id = :E_SOUMU'),
 ('events(groups)','update','update public.events set title = title where id = :E_GROUPS'),
 ('events(all)','update','update public.events set note = ''x'' where id = :E_ALL'),
 ('events(Y2)','update','update public.events set title = title where id = :E_Y2_GROUPS'),
 ('events','delete','delete from public.events where id = :E_SOUMU'),
 ('events(groups)','delete','delete from public.events where id = :E_GROUPS'),
 ('events(all)','delete','delete from public.events where id = :E_ALL'),
 ('events(Y2)','delete','delete from public.events where id = :E_Y2_SOUMU');
-- 提出物（T19）：fixture の提出物・提出・ファイルを1件ずつ読み、提出物を書く。DOC_STALL は G1・G2・G4 が対象、DOC_COMPANY はどの団体も対象で
-- ない、DOC_Y2 は Y2 の G3 が対象。提出は (DOC_STALL, G1) 提出済み・(DOC_STALL, G2) 差し戻し・(DOC_NOFILE, G4) 承認・(DOC_Y2, G3) 未提出、
-- ファイルは F_G1（G1）と F_Y2（G3）。提出物の書き込みは RLS（can_lead）、提出とファイルの書き込みは RPC だけ（表に権限がない）
insert into tests.cell_sql values
 ('documents','select','select count(*) from public.documents where id = :DOC_STALL'),
 ('documents(company)','select','select count(*) from public.documents where id = :DOC_COMPANY'),
 ('documents(Y2)','select','select count(*) from public.documents where id = :DOC_Y2'),
 ('documents','insert','insert into public.documents(year_id, title, deadline, target_categories) values (:Y1, ''x'', ''2027-09-01 12:00+09'', ''{stall}'')'),
 ('documents','update','update public.documents set description = ''x'' where id = :DOC_STALL'),
 ('documents','delete','delete from public.documents where id = :DOC_STALL'),
 ('documents(Y2)','insert','insert into public.documents(year_id, title, deadline, target_categories) values (:Y2, ''x'', ''2026-09-01 12:00+09'', ''{stall}'')'),
 ('documents(Y2)','update','update public.documents set description = ''x'' where id = :DOC_Y2'),
 ('documents(Y2)','delete','delete from public.documents where id = :DOC_Y2'),
 ('document_submissions','select','select count(*) from public.document_submissions where document_id = :DOC_STALL and group_id = :G1'),
 ('document_submissions(G2)','select','select count(*) from public.document_submissions where document_id = :DOC_STALL and group_id = :G2'),
 ('document_submissions(G4)','select','select count(*) from public.document_submissions where document_id = :DOC_NOFILE and group_id = :G4'),
 ('document_submissions(Y2)','select','select count(*) from public.document_submissions where document_id = :DOC_Y2 and group_id = :G3'),
 ('document_submissions','insert','insert into public.document_submissions(document_id, group_id, year_id) values (:DOC_NOFILE, :G1, :Y1)'),
 ('document_submissions','update','update public.document_submissions set status = ''approved'', reviewed_at = now() where document_id = :DOC_STALL and group_id = :G1'),
 ('document_submissions','delete','delete from public.document_submissions where document_id = :DOC_STALL and group_id = :G1'),
 ('document_files','select','select count(*) from public.document_files where id = :F_G1'),
 ('document_files(Y2)','select','select count(*) from public.document_files where id = :F_Y2'),
 ('document_files','insert','insert into public.document_files(id, year_id, document_id, group_id, object_path, content_type, size) values (gen_random_uuid(), :Y1, :DOC_STALL, :G2, ''x'', ''application/pdf'', 1)'),
 ('document_files','update','update public.document_files set size = size where id = :F_G1'),
 ('document_files','delete','delete from public.document_files where id = :F_G1'),
 ('v_document_status','select','select count(*) from public.v_document_status where document_id = :DOC_STALL and group_id = :G1'),
 ('v_document_status(G4)','select','select count(*) from public.v_document_status where document_id = :DOC_STALL and group_id = :G4'),
 ('v_document_status(Y2)','select','select count(*) from public.v_document_status where document_id = :DOC_Y2 and group_id = :G3'),
 ('v_document_files','select','select count(*) from public.v_document_files where id = :F_G1'),
 ('v_document_files(Y2)','select','select count(*) from public.v_document_files where id = :F_Y2');

-- シフト・作業（T20）：5表を Y1（fixture の DU1〜DU3・SL1・SL2・ます・割り当て・TK_*）と Y2（準備中のまま。DU_Y2・SL_Y2 など）で1つずつ読み、
-- 書く。書き込みの値は BEFORE ROW のトリガー（重なり・総務だけ）を通るもの（時間枠は隣り合う時刻、割り当てる人はその年度の総務）。
-- 作業の update は状態を変える（担当の総務部門員も直接は変えられない）
insert into tests.cell_sql values
 ('shift_duties','select','select count(*) from public.shift_duties where id = :DU1'),
 ('shift_duties','insert','insert into public.shift_duties(year_id, name) values (:Y1, ''T-足す'')'),
 ('shift_duties','update','update public.shift_duties set place = ''集合場所'' where id = :DU1'),
 ('shift_duties','delete','delete from public.shift_duties where id = :DU3'),
 ('shift_duties(Y2)','select','select count(*) from public.shift_duties where id = :DU_Y2'),
 ('shift_duties(Y2)','insert','insert into public.shift_duties(year_id, name) values (:Y2, ''T-足す'')'),
 ('shift_duties(Y2)','update','update public.shift_duties set place = ''集合場所'' where id = :DU_Y2'),
 ('shift_duties(Y2)','delete','delete from public.shift_duties where id = :DU_Y2B'),
 ('shift_slots','select','select count(*) from public.shift_slots where id = :SL1'),
 ('shift_slots','insert','insert into public.shift_slots(year_id, starts_at, ends_at) values (:Y1, ''2027-10-15 11:00+09'', ''2027-10-15 12:00+09'')'),
 ('shift_slots','update','update public.shift_slots set ends_at = ''2027-10-15 11:30+09'' where id = :SL2'),
 ('shift_slots','delete','delete from public.shift_slots where id = :SL2'),
 ('shift_slots(Y2)','select','select count(*) from public.shift_slots where id = :SL_Y2'),
 ('shift_slots(Y2)','insert','insert into public.shift_slots(year_id, starts_at, ends_at) values (:Y2, ''2026-10-15 11:00+09'', ''2026-10-15 12:00+09'')'),
 ('shift_slots(Y2)','update','update public.shift_slots set ends_at = ''2026-10-15 11:30+09'' where id = :SL_Y2B'),
 ('shift_slots(Y2)','delete','delete from public.shift_slots where id = :SL_Y2B'),
 ('shift_needs','select','select count(*) from public.shift_needs where slot_id = :SL1 and duty_id = :DU1'),
 ('shift_needs','insert','insert into public.shift_needs(year_id, slot_id, duty_id, required_count) values (:Y1, :SL2, :DU2, 1)'),
 ('shift_needs','update','update public.shift_needs set required_count = 3 where slot_id = :SL1 and duty_id = :DU1'),
 ('shift_needs','delete','delete from public.shift_needs where slot_id = :SL2 and duty_id = :DU1'),
 ('shift_needs(Y2)','select','select count(*) from public.shift_needs where slot_id = :SL_Y2 and duty_id = :DU_Y2'),
 ('shift_needs(Y2)','insert','insert into public.shift_needs(year_id, slot_id, duty_id, required_count) values (:Y2, :SL_Y2, :DU_Y2B, 1)'),
 ('shift_needs(Y2)','update','update public.shift_needs set required_count = 3 where slot_id = :SL_Y2 and duty_id = :DU_Y2'),
 ('shift_needs(Y2)','delete','delete from public.shift_needs where slot_id = :SL_Y2B and duty_id = :DU_Y2'),
 ('shift_assignments','select','select count(*) from public.shift_assignments where slot_id = :SL1 and user_id = :staff'),
 ('shift_assignments','insert','insert into public.shift_assignments(year_id, slot_id, duty_id, user_id) values (:Y1, :SL2, :DU1, :deputy)'),
 ('shift_assignments','update','update public.shift_assignments set duty_id = :DU2 where slot_id = :SL1 and user_id = :staff'),
 ('shift_assignments','delete','delete from public.shift_assignments where slot_id = :SL1 and user_id = :staff'),
 ('shift_assignments(Y2)','select','select count(*) from public.shift_assignments where slot_id = :SL_Y2 and user_id = :admin2'),
 ('shift_assignments(Y2)','insert','insert into public.shift_assignments(year_id, slot_id, duty_id, user_id) values (:Y2, :SL_Y2B, :DU_Y2, :admin2)'),
 ('shift_assignments(Y2)','update','update public.shift_assignments set duty_id = duty_id where slot_id = :SL_Y2 and user_id = :admin2'),
 ('shift_assignments(Y2)','delete','delete from public.shift_assignments where slot_id = :SL_Y2 and user_id = :admin2'),
 ('tasks','select','select count(*) from public.tasks where id = :TK_STAFF'),
 ('tasks','insert','insert into public.tasks(year_id, title, assignee_id, due_at) values (:Y1, ''T-足す'', :staff, ''2027-10-10 17:00+09'')'),
 ('tasks','update','update public.tasks set status = ''doing'' where id = :TK_STAFF'),
 ('tasks','delete','delete from public.tasks where id = :TK_NONE'),
 ('tasks(Y2)','select','select count(*) from public.tasks where id = :TK_Y2'),
 ('tasks(Y2)','insert','insert into public.tasks(year_id, title, assignee_id) values (:Y2, ''T-足す'', :admin2)'),
 ('tasks(Y2)','update','update public.tasks set status = ''done'' where id = :TK_Y2'),
 ('tasks(Y2)','delete','delete from public.tasks where id = :TK_Y2');

-- 期待値（列の順：admin staff rep viewer outsider admin2 head。deputy は head の列）
insert into tests.expect values
 -- years：読むのはロールか団体代表。書き込みは RPC だけ（権限がない）
 ('years','select','*','YYYYNNY'),
 ('years','insert','*','NNNNNNN'), ('years','update','*','NNNNNNN'), ('years','delete','*','NNNNNNN'),
 -- 年度をまたぐ表：読むのは招待された人、書くのは closed でない年度のどれかの admin（管理者だけ。admin は Y1 だけなので Y1 が closed なら書けない）
 ('rooms','select','*','YYYYNYY'),
 ('rooms','insert','*','YNNNNYN'), ('rooms','insert','closed','NNNNNYN'),
 ('rooms','update','*','YNNNNYN'), ('rooms','update','closed','NNNNNYN'),
 ('rooms','delete','*','YNNNNYN'), ('rooms','delete','closed','NNNNNYN'),
 ('items','select','*','YYYYNYY'),
 ('items','insert','*','YNNNNYN'), ('items','insert','closed','NNNNNYN'),
 ('items','update','*','YNNNNYN'), ('items','update','closed','NNNNNYN'),
 ('items','delete','*','YNNNNYN'), ('items','delete','closed','NNNNNYN'),
 ('distance_overrides','select','*','YYYYNYY'),
 ('distance_overrides','insert','*','YNNNNYN'), ('distance_overrides','insert','closed','NNNNNYN'),
 ('distance_overrides','update','*','YNNNNYN'), ('distance_overrides','update','closed','NNNNNYN'),
 ('distance_overrides','delete','*','YNNNNYN'), ('distance_overrides','delete','closed','NNNNNYN'),
 -- room_years・slots：年度のロールか団体代表が読み、部門長以上が書く（closed は読み取り専用。今年の使用は振り分けの作業）
 ('room_years','select','*','YYYYNNY'),
 ('room_years','insert','*','YNNNNNY'), ('room_years','insert','closed','NNNNNNN'),
 ('room_years','update','*','YNNNNNY'), ('room_years','update','closed','NNNNNNN'),
 ('room_years','delete','*','YNNNNNY'), ('room_years','delete','closed','NNNNNNN'),
 -- 振り分けのある部屋を使用不可にするのは、確定中は止める（E002。部門長以上でも）
 ('room_years(unusable)','insert','*','YNNNNNY'), ('room_years(unusable)','insert','confirmed','NNNNNNN'),
 ('room_years(unusable)','insert','closed','NNNNNNN'),
 ('slots','select','*','YYYYNNY'),
 ('slots','insert','*','YNNNNNY'), ('slots','insert','closed','NNNNNNN'),
 ('slots','update','*','YNNNNNY'), ('slots','update','closed','NNNNNNN'),
 ('slots','delete','*','YNNNNNY'), ('slots','delete','closed','NNNNNNN'),
 -- stocks：総務が読む。部門長以上は closed 以外、staff は preparing・requesting（締切後も requesting の間）に書ける
 ('stocks','select','*','YYNNNNY'),
 ('stocks','insert','*','YYNNNNY'), ('stocks','insert','allocating','YNNNNNY'), ('stocks','insert','confirmed','YNNNNNY'),
 ('stocks','insert','closed','NNNNNNN'),
 ('stocks','update','*','YYNNNNY'), ('stocks','update','allocating','YNNNNNY'), ('stocks','update','confirmed','YNNNNNY'),
 ('stocks','update','closed','NNNNNNN'),
 -- 在庫の行を消す・在庫を振り分けより少なくするのは、確定中は止める（E001）
 ('stocks','delete','*','YYNNNNY'), ('stocks','delete','allocating','YNNNNNY'), ('stocks','delete','confirmed','NNNNNNN'),
 ('stocks','delete','closed','NNNNNNN'),
 ('stocks(decrease)','update','*','YYNNNNY'), ('stocks(decrease)','update','allocating','YNNNNNY'),
 ('stocks(decrease)','update','confirmed','NNNNNNN'), ('stocks(decrease)','update','closed','NNNNNNN'),
 ('v_remaining','select','*','YYNNNNY'),
 -- groups：総務・viewer と自団体の代表が読む。書くのは admin だけ。確定中は削除と使用場所の変更を止める
 ('groups','select','*','YYYYNNY'), ('groups(G2)','select','*','YYNYNNY'),
 ('groups','insert','*','YNNNNNN'), ('groups','insert','closed','NNNNNNN'),
 ('groups','update','*','YNNNNNN'), ('groups','update','closed','NNNNNNN'),
 ('groups','delete','*','YNNNNNN'), ('groups','delete','confirmed','NNNNNNN'), ('groups','delete','closed','NNNNNNN'),
 ('groups(location)','update','*','YNNNNNN'), ('groups(location)','update','confirmed','NNNNNNN'),
 ('groups(location)','update','closed','NNNNNNN'),
 -- year_roles・group_members：部門長以上はその年度の全行、ほかは自分の行。書き込みは RPC だけ
 -- （staff は G3〔Y2〕の店長なので group_members(own) は Y、G4 の行は読めない。viewer は G4 の副店長なので自分の行を読む）
 ('year_roles','select','*','YYNNNNY'), ('year_roles(own)','select','*','YYYYNYY'),
 ('year_roles','insert','*','NNNNNNN'), ('year_roles','update','*','NNNNNNN'), ('year_roles','delete','*','NNNNNNN'),
 ('group_members','select','*','YNYNNNY'), ('group_members(own)','select','*','NYYYNNN'), ('group_members(G4)','select','*','YNNYNNY'),
 ('group_members','insert','*','NNNNNNN'), ('group_members','update','*','NNNNNNN'), ('group_members','delete','*','NNNNNNN'),
 -- invitations：admin はその年度の全部、部門長以上は staff のロールの招待と団体の招待、ほかは自分のメールの行。書き込みは RPC だけ
 ('invitations','select','*','YNNNNNY'), ('invitations(own)','select','*','NYYYNNN'),
 ('invitations(admin)','select','*','YNNNNNN'), ('invitations(viewer)','select','*','YNNYNNN'),
 ('invitations(group)','select','*','YNYNNNY'),
 ('invitations','insert','*','NNNNNNN'), ('invitations','update','*','NNNNNNN'), ('invitations','delete','*','NNNNNNN'),
 -- 申請：総務と自団体の代表が読む。団体代表は受付期間内、部門長以上は preparing と締切前の requesting に書ける
 ('request_submissions','select','*','YYYNNNY'), ('request_submissions(G2)','select','*','YYNNNNY'),
 ('request_submissions','insert','*','NNNNNNN'), ('request_submissions','insert','preparing','YNNNNNY'),
 ('request_submissions','insert','requesting','YNYNNNY'),
 ('request_submissions','update','*','NNNNNNN'), ('request_submissions','update','preparing','YNNNNNY'),
 ('request_submissions','update','requesting','YNYNNNY'),
 ('request_submissions(G2)','update','*','NNNNNNN'), ('request_submissions(G2)','update','preparing','YNNNNNY'),
 ('request_submissions(G2)','update','requesting','YNNNNNY'),
 ('request_submissions','delete','*','NNNNNNN'), ('request_submissions','delete','preparing','YNNNNNY'),
 ('request_submissions','delete','requesting','YNYNNNY'),
 ('requests','select','*','YYYNNNY'), ('requests(G2)','select','*','YYNNNNY'),
 ('requests','insert','*','NNNNNNN'), ('requests','insert','preparing','YNNNNNY'), ('requests','insert','requesting','YNYNNNY'),
 -- viewer は G4 の副店長なので、受付期間内は G4 の申請を書ける（staff はもう G4 の代表でない）
 ('requests(G4)','insert','*','NNNNNNN'), ('requests(G4)','insert','preparing','YNNNNNY'),
 ('requests(G4)','insert','requesting','YNNYNNY'),
 ('requests','update','*','NNNNNNN'), ('requests','update','preparing','YNNNNNY'), ('requests','update','requesting','YNYNNNY'),
 ('requests(G2)','update','*','NNNNNNN'), ('requests(G2)','update','preparing','YNNNNNY'), ('requests(G2)','update','requesting','YNNNNNY'),
 ('requests','delete','*','NNNNNNN'), ('requests','delete','preparing','YNNNNNY'), ('requests','delete','requesting','YNYNNNY'),
 -- rules：総務が読み、部門長以上が書く。closed は memo だけ（トリガー）
 ('rules','select','*','YYNNNNY'),
 ('rules','insert','*','YNNNNNY'), ('rules','insert','closed','NNNNNNN'),
 ('rules','update','*','YNNNNNY'),
 ('rules(enabled)','update','*','YNNNNNY'), ('rules(enabled)','update','closed','NNNNNNN'),
 ('rules','delete','*','YNNNNNY'), ('rules','delete','closed','NNNNNNN'),
 -- 了承：総務と自団体の代表が読む。書き込みは set_consent だけ
 ('substitution_consents','select','*','YYYNNNY'),
 ('substitution_consents','insert','*','NNNNNNN'), ('substitution_consents','update','*','NNNNNNN'),
 ('substitution_consents','delete','*','NNNNNNN'),
 -- allocations：総務は常に、viewer と自団体の代表は confirmed 以降に読む。書き込みは RPC だけ
 ('allocations','select','*','YYNNNNY'), ('allocations','select','confirmed','YYYYNNY'), ('allocations','select','closed','YYYYNNY'),
 ('allocations(G2)','select','*','YYNNNNY'), ('allocations(G2)','select','confirmed','YYNYNNY'),
 ('allocations(G2)','select','closed','YYNYNNY'),
 ('allocations','insert','*','NNNNNNN'), ('allocations','update','*','NNNNNNN'), ('allocations','delete','*','NNNNNNN'),
 -- deliveries：総務・viewer と自団体の代表が読み、部門長以上が書く（staff の更新は check_delivery）
 ('deliveries','select','*','YYYYNNY'), ('deliveries(G2)','select','*','YYNYNNY'),
 ('deliveries','insert','*','YNNNNNY'), ('deliveries','insert','closed','NNNNNNN'),
 ('deliveries','update','*','YNNNNNY'), ('deliveries','update','closed','NNNNNNN'),
 ('deliveries','delete','*','YNNNNNY'), ('deliveries','delete','closed','NNNNNNN'),
 -- profiles：自分と、自分が総務（部門長以上・staff）である年度のメンバー（admin2 は Y2 の admin で、rep は Y2 の viewer）
 ('profiles','select','*','YYNNNNY'), ('profiles(own)','select','*','YYYYYYY'), ('profiles(rep)','select','*','YYYNNYY'),
 ('profiles','insert','*','NNNNNNN'), ('profiles','update','*','NNNNNNN'), ('profiles','delete','*','NNNNNNN'),
 -- audit_logs：その年度の部門長以上。年度のない行（年度をまたぐ3表）は closed でない年度の admin だけ
 ('audit_logs','select','*','YNNNNNY'),
 ('audit_logs(global)','select','*','YNNNNYN'), ('audit_logs(global)','select','closed','NNNNNYN'),
 ('audit_logs','insert','*','NNNNNNN'), ('audit_logs','update','*','NNNNNNN'), ('audit_logs','delete','*','NNNNNNN'),
 -- notices（T17。02「お知らせの権限」）：総務（admin・head・deputy_head・staff）はその年度の全部。閲覧のみはその年度の全団体あて・
 -- 指定の団体あて（総務内は読めない）。団体代表は代表である年度の全団体あてと、自団体を宛先に含む指定の団体あて。年度の状態によらない。
 -- staff は Y2 では G3 の店長（総務でない）なので、Y2 の全団体あてと G3 あてだけ。rep は Y1 の G1 の店長で Y2 の閲覧のみ
 ('notices','select','*','YYNNNNY'),
 ('notices(all_groups)','select','*','YYYYNNY'),
 ('notices(G1)','select','*','YYYYNNY'),
 ('notices(G4)','select','*','YYNYNNY'),
 ('notices(Y2 soumu)','select','*','NNNNNYN'),
 ('notices(Y2 all_groups)','select','*','NYYNNYN'),
 ('notices(Y2 G3)','select','*','NYYNNYN'),
 ('notices','insert','*','NNNNNNN'), ('notices','update','*','NNNNNNN'), ('notices','delete','*','NNNNNNN'),
 -- notice_groups：総務と閲覧のみはその年度の全部。団体代表は自団体の行だけ（ほかにどの団体へ出したかは読めない）
 ('notice_groups','select','*','YYYYNNY'),
 ('notice_groups(G2)','select','*','YYNYNNY'),
 ('notice_groups(G4)','select','*','YYNYNNY'),
 ('notice_groups(Y2 G3)','select','*','NYYNNYN'),
 ('notice_groups','insert','*','NNNNNNN'), ('notice_groups','update','*','NNNNNNN'), ('notice_groups','delete','*','NNNNNNN'),
 -- events（T18。02「予定と締切の権限」）：総務（admin・head・deputy_head・staff）はその年度の全部。閲覧のみと団体代表は、その年度（代表で
 -- ある年度）の対象が団体・全員の項目。読み取りは年度の状態によらない。staff は Y2 では G3 の店長（総務でない）なので、Y2 の団体・全員だけ。
 -- rep は Y1 の G1 の店長で Y2 の閲覧のみ。書き込みはその年度の部門長以上で、終了でない年度（can_lead）。確定中も書ける（守りがない）。
 -- Y2 は準備中のまま（admin2 だけが書ける。Y1 の部門長以上は書けない）
 ('events','select','*','YYNNNNY'),
 ('events(groups)','select','*','YYYYNNY'),
 ('events(all)','select','*','YYYYNNY'),
 ('events(Y2 soumu)','select','*','NNNNNYN'),
 ('events(Y2 groups)','select','*','NYYNNYN'),
 ('events(Y2 all)','select','*','NYYNNYN'),
 ('events','insert','*','YNNNNNY'), ('events','insert','closed','NNNNNNN'),
 ('events(groups)','insert','*','YNNNNNY'), ('events(groups)','insert','closed','NNNNNNN'),
 ('events(all)','insert','*','YNNNNNY'), ('events(all)','insert','closed','NNNNNNN'),
 ('events','update','*','YNNNNNY'), ('events','update','closed','NNNNNNN'),
 ('events(groups)','update','*','YNNNNNY'), ('events(groups)','update','closed','NNNNNNN'),
 ('events(all)','update','*','YNNNNNY'), ('events(all)','update','closed','NNNNNNN'),
 ('events','delete','*','YNNNNNY'), ('events','delete','closed','NNNNNNN'),
 ('events(groups)','delete','*','YNNNNNY'), ('events(groups)','delete','closed','NNNNNNN'),
 ('events(all)','delete','*','YNNNNNY'), ('events(all)','delete','closed','NNNNNNN'),
 ('events(Y2)','insert','*','NNNNNYN'), ('events(Y2)','update','*','NNNNNYN'), ('events(Y2)','delete','*','NNNNNYN');
-- 提出物（T19。02「提出物の権限」）：総務（admin・head・deputy_head・staff）はその年度の提出物と提出の全部。ファイル（v_document_files を
-- 含む）は部門長以上だけ（staff は読めない。Q4）。店長・副店長は自団体が対象の提出物と、自団体の提出・ファイル。閲覧のみは何も読めない（Q5）
-- が、viewer は G4 の副店長も兼ねるので、G4 が対象の提出物と G4 の行は読む（兼ねた人は両方の権限）。v_document_status は読む人が提出を
-- 読める団体の行だけ（viewer に G1 の行を未提出として出さない。判断 24）。staff は Y2 では G3 の店長、rep は Y2 の閲覧のみ（何も読めない）。
-- 読み取りは年度の状態によらない。提出物の書き込みはその年度の部門長以上で、終了でない年度（can_lead。確定中も書ける）。Y2 は準備中のまま
-- （admin2 だけが書ける）。提出とファイルは誰も直接は書けない（RPC だけ）
insert into tests.expect values
 ('documents','select','*','YYYYNNY'),
 ('documents(company)','select','*','YYNNNNY'),
 ('documents(Y2)','select','*','NYNNNYN'),
 ('documents','insert','*','YNNNNNY'), ('documents','insert','closed','NNNNNNN'),
 ('documents','update','*','YNNNNNY'), ('documents','update','closed','NNNNNNN'),
 ('documents','delete','*','YNNNNNY'), ('documents','delete','closed','NNNNNNN'),
 ('documents(Y2)','insert','*','NNNNNYN'), ('documents(Y2)','update','*','NNNNNYN'), ('documents(Y2)','delete','*','NNNNNYN'),
 ('document_submissions','select','*','YYYNNNY'),
 ('document_submissions(G2)','select','*','YYNNNNY'),
 ('document_submissions(G4)','select','*','YYNYNNY'),
 ('document_submissions(Y2)','select','*','NYNNNYN'),
 ('document_submissions','insert','*','NNNNNNN'), ('document_submissions','update','*','NNNNNNN'), ('document_submissions','delete','*','NNNNNNN'),
 ('document_files','select','*','YNYNNNY'),
 ('document_files(Y2)','select','*','NYNNNYN'),
 ('document_files','insert','*','NNNNNNN'), ('document_files','update','*','NNNNNNN'), ('document_files','delete','*','NNNNNNN'),
 ('v_document_status','select','*','YYYNNNY'),
 ('v_document_status(G4)','select','*','YYNYNNY'),
 ('v_document_status(Y2)','select','*','NYNNNYN'),
 ('v_document_files','select','*','YNYNNNY'),
 ('v_document_files(Y2)','select','*','NYNNNYN');

-- シフト・作業（T20。02「シフト・作業の権限」）：5表とも、その年度の総務（admin・head・deputy_head・staff）が全部を読み（年度の状態によらない）、
-- その年度の部門長以上が、終了でない年度に書く（can_lead。確定中も書ける）。閲覧のみ・店長・副店長・招待されていない人は読めも書けもしない。
-- Y2 の総務は admin2 だけ（rep は Y2 の閲覧のみ、staff は Y2 の G3 の店長で、Y2 では総務でない）。Y2 は準備中のまま
insert into tests.expect values
 ('shift_duties','select','*','YYNNNNY'),
 ('shift_duties','insert','*','YNNNNNY'), ('shift_duties','insert','closed','NNNNNNN'),
 ('shift_duties','update','*','YNNNNNY'), ('shift_duties','update','closed','NNNNNNN'),
 ('shift_duties','delete','*','YNNNNNY'), ('shift_duties','delete','closed','NNNNNNN'),
 ('shift_duties(Y2)','select','*','NNNNNYN'), ('shift_duties(Y2)','insert','*','NNNNNYN'), ('shift_duties(Y2)','update','*','NNNNNYN'), ('shift_duties(Y2)','delete','*','NNNNNYN'),
 ('shift_slots','select','*','YYNNNNY'),
 ('shift_slots','insert','*','YNNNNNY'), ('shift_slots','insert','closed','NNNNNNN'),
 ('shift_slots','update','*','YNNNNNY'), ('shift_slots','update','closed','NNNNNNN'),
 ('shift_slots','delete','*','YNNNNNY'), ('shift_slots','delete','closed','NNNNNNN'),
 ('shift_slots(Y2)','select','*','NNNNNYN'), ('shift_slots(Y2)','insert','*','NNNNNYN'), ('shift_slots(Y2)','update','*','NNNNNYN'), ('shift_slots(Y2)','delete','*','NNNNNYN'),
 ('shift_needs','select','*','YYNNNNY'),
 ('shift_needs','insert','*','YNNNNNY'), ('shift_needs','insert','closed','NNNNNNN'),
 ('shift_needs','update','*','YNNNNNY'), ('shift_needs','update','closed','NNNNNNN'),
 ('shift_needs','delete','*','YNNNNNY'), ('shift_needs','delete','closed','NNNNNNN'),
 ('shift_needs(Y2)','select','*','NNNNNYN'), ('shift_needs(Y2)','insert','*','NNNNNYN'), ('shift_needs(Y2)','update','*','NNNNNYN'), ('shift_needs(Y2)','delete','*','NNNNNYN'),
 ('shift_assignments','select','*','YYNNNNY'),
 ('shift_assignments','insert','*','YNNNNNY'), ('shift_assignments','insert','closed','NNNNNNN'),
 ('shift_assignments','update','*','YNNNNNY'), ('shift_assignments','update','closed','NNNNNNN'),
 ('shift_assignments','delete','*','YNNNNNY'), ('shift_assignments','delete','closed','NNNNNNN'),
 ('shift_assignments(Y2)','select','*','NNNNNYN'), ('shift_assignments(Y2)','insert','*','NNNNNYN'), ('shift_assignments(Y2)','update','*','NNNNNYN'), ('shift_assignments(Y2)','delete','*','NNNNNYN'),
 ('tasks','select','*','YYNNNNY'),
 ('tasks','insert','*','YNNNNNY'), ('tasks','insert','closed','NNNNNNN'),
 ('tasks','update','*','YNNNNNY'), ('tasks','update','closed','NNNNNNN'),
 ('tasks','delete','*','YNNNNNY'), ('tasks','delete','closed','NNNNNNN'),
 ('tasks(Y2)','select','*','NNNNNYN'), ('tasks(Y2)','insert','*','NNNNNYN'), ('tasks(Y2)','update','*','NNNNNYN'), ('tasks(Y2)','delete','*','NNNNNYN');

-- ペルソナと期待値の列。deputy は head の列で確かめる（総務副部門長の権限は総務部門長と同じ。D-48）
create table tests.persona_col (persona text primary key, col int not null, ord int not null unique);
insert into tests.persona_col values
  ('admin', 1, 1), ('staff', 2, 2), ('rep', 3, 3), ('viewer', 4, 4), ('outsider', 5, 5), ('admin2', 6, 6),
  ('head', 7, 7), ('deputy', 7, 8);

create view tests.cells as
select c.tbl, c.op, s.scenario, p.persona,
       case substr(coalesce(e.yn, d.yn), p.col, 1) when 'Y' then 'allowed' when 'N' then 'denied' end as expected,
       tests.sql(c.template) as sql
from tests.cell_sql c
cross join unnest(array['preparing','requesting','requesting:after','allocating','confirmed','closed']) as s(scenario)
cross join tests.persona_col p
left join tests.expect e on e.tbl = c.tbl and e.op = c.op and e.scenario = s.scenario
left join tests.expect d on d.tbl = c.tbl and d.op = c.op and d.scenario = '*';

create function tests.run_cell(p_scenario text, p_persona text, p_op text, p_sql text) returns text
language plpgsql as $$
begin
  perform tests.set_scenario(p_scenario);
  return tests.try_cell(p_sql, p_persona, p_op);
end $$;

select plan((select count(*)::int from tests.cells) + 6 + 31 + 14 + 22);   -- 14 は T19、22 は T20 の権限表の外の確かめ

-- 期待値の表の形
select is((select count(*)::int from tests.cells where expected is null), 0, '全セルに期待値がある（既定の * か状態ごとの行）');
select is_empty($$ select e.tbl, e.op from tests.expect e left join tests.cell_sql c using (tbl, op) where c.tbl is null $$,
  '期待値の表に、試す SQL のない行がない');
select is((select count(distinct tbl)::int from tests.cell_sql where tbl !~ '\('), 33,
  '30 表（T17 のお知らせの2表、T18 の予定と締切、T19 の提出物の3表、T20 のシフト・作業の5表を含む）と3つのビュー（v_remaining と提出物の2つ）をすべて試す');
select is_empty($$ select tbl, op, scenario, yn from tests.expect where yn !~ '^[YN]{7}$' $$,
  '期待値はどの行も7列（admin staff rep viewer outsider admin2 head）');
select is((select string_agg(persona || '=' || col, ' ' order by ord) from tests.persona_col),
  'admin=1 staff=2 rep=3 viewer=4 outsider=5 admin2=6 head=7 deputy=7', 'deputy は head の列で確かめる（8人 × 7列）');

-- 全セルを試して結果を残す（ペルソナ・状態ごとに副トランザクションで試して取り消す）
create table tests.results as
select tbl, op, scenario, persona, expected, tests.run_cell(scenario, persona, op, sql) as got from tests.cells;

select is(got, expected, format('%s %s [%s] %s', tbl, op, scenario, persona))
from tests.results
order by tbl, op, scenario, persona;

-- 総務副部門長は総務部門長と同じ（期待値とは別に、実際の結果どうしを比べる）
select is_empty($$ select h.tbl, h.op, h.scenario, h.got as head, d.got as deputy
                   from tests.results h join tests.results d using (tbl, op, scenario)
                   where h.persona = 'head' and d.persona = 'deputy' and h.got is distinct from d.got $$,
  'deputy（総務副部門長）は全セルで head（総務部門長）と同じ結果');

-- ---------------------------------------------------------------- 完了基準の2点と、権限表の外の確認
-- いま見えている public の表・ビューの行数（0 でないものだけ）を、呼んだ人の権限で数える
create function tests.visible_counts() returns text language plpgsql as $$
declare
  r record;
  n bigint;
  v text := '';
begin
  for r in select c.relname from pg_class c
           where c.relnamespace = 'public'::regnamespace and c.relkind in ('r', 'v') order by c.relname loop
    execute format('select count(*) from public.%I', r.relname) into n;
    if n > 0 then v := v || format('%s=%s ', r.relname, n); end if;
  end loop;
  return btrim(v);
end $$;
grant execute on function tests.visible_counts() to authenticated;

select tests.set_scenario('confirmed');          -- 振り分けも公開される状態で
select tests.login_as('outsider');
select is(tests.visible_counts(), 'profiles=1', '招待されていない人は、public の全表・ビューで自分の profiles 以外を読めない');
select is((select user_id from public.profiles), tests.id('outsider'), '読める profiles は自分の行');
select tests.logout();

select tests.set_scenario('requesting');
select tests.login_as('rep');
select is((select count(*)::int from public.requests where group_id <> tests.id('G1')), 0, '団体代表は他の団体の requests を読めない');
select is((select count(*)::int from public.request_submissions where group_id <> tests.id('G1')), 0, '団体代表は他の団体の提出を読めない');
select ok((select count(*) > 0 from public.requests where group_id = tests.id('G1')), '団体代表は自団体の requests を読める');
select tests.logout();
select tests.login_as('rep2');
select is((select count(*)::int from public.requests where group_id <> tests.id('G2')), 0, 'rep2 も他の団体（G1）の requests を読めない');
select is((select count(*)::int from public.groups where id <> tests.id('G2')), 0, '団体代表は他の団体の行を読めない');
select tests.logout();

-- rules.year_id の付け替え（抜け (a)）：両方の年度の admin でも、ルールを別の年度（closed を含む）へ移せない
insert into public.year_roles (year_id, user_id, role) values (tests.id('Y2'), tests.id('admin'), 'admin');
update public.years set status = 'closed' where id = tests.id('Y2');
select tests.login_as('admin');
select throws_ok(format($q$ update public.rules set year_id = %L where id = %L $q$, tests.id('Y2'), tests.id('RULE1')),
  'P0001', 'invalid_input', 'ルールを closed の年度へ移せない（guard_rules。ポリシーの with check は更新後の行しか見ない）');
select tests.logout();
update public.years set status = 'preparing' where id = tests.id('Y2');
select tests.login_as('admin');
select throws_ok(format($q$ update public.rules set year_id = %L where id = %L $q$, tests.id('Y2'), tests.id('RULE1')),
  'P0001', 'invalid_input', 'ルールを開いている別の年度へも移せない');
select tests.logout();

-- 受付開始前（request_open_at が未来）は、受付中でも団体代表は書けない
update public.years set request_open_at = now() + interval '1 hour' where id = tests.id('Y1');
select is(tests.try_cell(tests.sql('update public.requests set count = 7 where group_id = :G1'), 'rep', 'update'), 'denied',
  '受付開始前は団体代表は申請を書けない');
select is(tests.try_cell(tests.sql('update public.requests set count = 7 where group_id = :G1'), 'admin', 'update'), 'allowed',
  '受付開始前でも admin は締切前なら書ける');
select is(tests.try_cell(tests.sql('update public.requests set count = 7 where group_id = :G1'), 'head', 'update'), 'allowed',
  '受付開始前でも部門長は締切前なら書ける（申請の代理入力は部門長以上）');
-- 締切が null の requesting（RPC では作れないが、念のため）は、団体代表も admin も書けない
update public.years set request_open_at = null, request_close_at = null where id = tests.id('Y1');
select is(tests.try_cell(tests.sql('update public.requests set count = 7 where group_id = :G1'), 'rep', 'update'), 'denied',
  '締切が null なら団体代表は書けない（K-24）');
select is(tests.try_cell(tests.sql('update public.requests set count = 7 where group_id = :G1'), 'admin', 'update'), 'denied',
  '締切が null の requesting は admin も RPC なしでは書けない');
select is(tests.try_cell(tests.sql('update public.requests set count = 7 where group_id = :G1'), 'deputy', 'update'), 'denied',
  '締切が null の requesting は副部門長も RPC なしでは書けない');

-- 部門長以上は、その年度の year_roles・group_members を全部読める（ほかの年度の行は読めない。T15）
select tests.set_scenario('requesting');
select tests.login_as('head');
select is((select string_agg(p.display_name || ':' || yr.role, ' ' order by yr.role, p.display_name)
           from public.year_roles yr join public.profiles p on p.user_id = yr.user_id),
  'admin:admin head:head deputy:deputy_head staff:staff viewer:viewer',
  '部門長は Y1 の year_roles を全部読め（表示名も読める）、Y2 の行は読めない');
select is((select string_agg(g.name || ':' || p.display_name || ':' || gm.role, ' ' order by g.name)
           from public.group_members gm join public.groups g on g.id = gm.group_id join public.profiles p on p.user_id = gm.user_id),
  'T-G1:rep:manager T-G2:rep2:manager T-G4:viewer:deputy_manager',
  '部門長は Y1 の団体代表を全部読め（店長・副店長も）、Y2 の G3 の行は読めない');
select tests.logout();

-- 自分あての招待は、JWT の email ではなく、本人のものと確かめられる今のメール（private.verified_email、D-17a）で決める。
-- viewer（Y1 の viewer。自分あての使用済みの招待がある）の JWT の email だけを、未使用の招待がある someone に変える
select tests.set_scenario('requesting');
select tests.login_as('viewer');
select set_config('request.jwt.claims', jsonb_build_object('sub', tests.id('viewer'), 'role', 'authenticated',
                                                           'email', 'someone@pgtap.test')::text, true);
select is((select count(*)::int from public.invitations where email = 'someone@pgtap.test'), 0,
  'JWT の email が他人のアドレスでも、その人あての招待は読めない');
select tests.logout();
-- auth.users.email を他人のアドレスに変えた（email_confirmed_at は最初の確認のまま残る）。identity のメールは元のまま
update auth.users set email = 'someone@pgtap.test' where id = tests.id('viewer');
select tests.login_as('viewer');
select set_config('request.jwt.claims', jsonb_build_object('sub', tests.id('viewer'), 'role', 'authenticated',
                                                           'email', 'someone@pgtap.test')::text, true);
select is((select count(*)::int from public.invitations where email = 'someone@pgtap.test'), 0,
  'メールを他人のアドレスに変えたユーザーは、その人あての未使用の招待（年度・ロール）を読めない');
select is((select count(*)::int from public.invitations), 0, 'メールが確かめられない間は、元のメールあての招待も読めない');
select tests.logout();
-- 新しいアドレスを受信箱で確かめた（GoTrue は email の identity を新しいアドレスと email_verified: true に書き換える）
update auth.identities set identity_data = identity_data || '{"email": "someone@pgtap.test", "email_verified": true}'
where user_id = tests.id('viewer');
select tests.login_as('viewer');
select is((select count(*)::int from public.invitations where email = 'someone@pgtap.test'), 1,
  '確かめたアドレスあての招待は読める');
select tests.logout();
update auth.identities set identity_data = identity_data || '{"email": "viewer@pgtap.test"}' where user_id = tests.id('viewer');
update auth.users set email = 'viewer@pgtap.test' where id = tests.id('viewer');
select tests.login_as('viewer');
select is((select count(*)::int from public.invitations), 1, 'メールを戻せば、自分あての招待だけを読める');
select tests.logout();

-- 予定と締切（T18）：直接の書き込みの中身（権限表の外）。部門長以上の直接の insert で created_by・updated_by を送っても自分になり
-- （set_actor）、返り値も読める（returning は select のポリシーも通る）。画面が作った id で送り直すと主キーの重複で止まる（04 の (B1)）
select tests.set_scenario('requesting');
select tests.login_as('head');
with e as (
  insert into public.events (id, year_id, kind, audience, title, starts_at, created_by, updated_by)
  values ('00000000-0000-4000-8000-0000000e0001', tests.id('Y1'), 'deadline', 'groups', 'T-E_DIRECT', '2027-09-01 17:00+09',
          tests.id('admin'), tests.id('admin'))
  returning created_by, updated_by)
select is((select format('%s %s', (created_by = tests.id('head'))::text, (updated_by = tests.id('head'))::text) from e), 'true true',
  '部門長の直接の insert：送った created_by・updated_by は使われず自分になり、返り値も読める');
select throws_ok($q$ insert into public.events (id, year_id, kind, audience, title, starts_at)
                    values ('00000000-0000-4000-8000-0000000e0001', (select id from tests.ids where name = 'Y1'), 'deadline', 'groups',
                            'T-E_DIRECT', '2027-09-01 17:00+09') $q$,
  '23505', null, '画面が作った id で送り直すと、主キーの重複で止まる（二重にならない）');
select tests.logout();
insert into tests.ids values ('E_DIRECT', '00000000-0000-4000-8000-0000000e0001');
-- 楽観ロック（画面が updated_at を条件に入れる）：テスト全体が1つのトランザクションで now() が変わらないので、set_timestamps を止めて
-- 過去の updated_at を入れてから確かめる。合う版なら 1 行、同じ版でもう一度なら 0 行（画面は読み直して conflict にする）
alter table public.events disable trigger set_timestamps;
update public.events set updated_at = '2027-01-01 00:00:00.123456+00' where id = tests.id('E_DIRECT');
alter table public.events enable trigger set_timestamps;
select tests.login_as('deputy');
with u as (update public.events set title = 'T-E_DIRECT2'
           where id = tests.id('E_DIRECT') and updated_at = '2027-01-01 00:00:00.123456+00' returning 1)
select is((select count(*)::int from u), 1, '予定と締切の楽観ロック：updated_at が合えば直せる（1 行）');
with u as (update public.events set title = 'T-E_DIRECT3'
           where id = tests.id('E_DIRECT') and updated_at = '2027-01-01 00:00:00.123456+00' returning 1)
select is((select count(*)::int from u), 0, '予定と締切の楽観ロック：同じ版でもう一度は 0 行（直した後の updated_at は進んでいる）');
select tests.logout();
select is((select format('%s %s %s', (created_by = tests.id('head'))::text, (updated_by = tests.id('deputy'))::text, title)
           from public.events where id = tests.id('E_DIRECT')),
  'true true T-E_DIRECT2', '直した後も created_by は書いた人（head）、updated_by は直した人（副部門長）');
-- 両方の年度の管理者（admin は上のルールの確かめで Y2 の管理者も兼ねた）でも、予定と締切を別の年度へ移せない（BEFORE ROW の
-- check_immutable が、ポリシーの with check より先に invalid_input で止める）
select tests.login_as('admin');
select throws_ok(format($q$ update public.events set year_id = %L where id = %L $q$, tests.id('Y2'), tests.id('E_DIRECT')),
  'P0001', 'invalid_input', '両方の年度の管理者でも、予定と締切を別の年度へ移せない（check_immutable）');
select tests.logout();

-- シフト・作業（T20）：直接の書き込みの中身（権限表の外）。部門長以上の直接の insert で created_by・updated_by を送っても自分になり、返り値も
-- 読める。画面が作った id で送り直すと主キーの重複で止まる（04 の (B1)）。同じ時間枠に同じ人を2か所に入れるのは主キーが止める（23505）。
-- 書ける人が総務でない人を入れると not_soumu、重なる時間枠を足すと overlap。書けない人はどちらも RLS の 42501（読めない year_roles・
-- 時間枠の有無を、エラーの違いで知らせない）
select tests.set_scenario('requesting');
select tests.login_as('head');
with t as (
  insert into public.tasks (id, year_id, title, assignee_id, due_at, created_by, updated_by)
  values ('00000000-0000-4000-8000-0000000f0001', tests.id('Y1'), 'T-TK_DIRECT', tests.id('staff'), '2027-10-12 17:00+09',
          tests.id('admin'), tests.id('admin'))
  returning created_by, updated_by, status)
select is((select format('%s %s %s', (created_by = tests.id('head'))::text, (updated_by = tests.id('head'))::text, status) from t), 'true true todo',
  '部門長の作業の直接の insert：送った created_by・updated_by は使われず自分になり、状態は未着手、返り値も読める');
select throws_ok($q$ insert into public.tasks (id, year_id, title)
                    values ('00000000-0000-4000-8000-0000000f0001', (select id from tests.ids where name = 'Y1'), 'T-TK_DIRECT') $q$,
  '23505', null, '画面が作った id で作業を送り直すと、主キーの重複で止まる（二重にならない）');
select throws_ok(tests.sql('insert into public.shift_assignments (year_id, slot_id, duty_id, user_id) values (:Y1, :SL1, :DU2, :staff)'),
  '23505', null, '同じ時間枠（SL1）に同じ人（staff）をほかの持ち場で入れると、主キーの重複で止まる（二重の割り当て）');
select is(tests.error_json(tests.sql('insert into public.shift_assignments (year_id, slot_id, duty_id, user_id) values (:Y1, :SL2, :DU1, :viewer)')),
  '{"code": "invalid_input", "detail": {"field": "user_id", "reason": "not_soumu"}}'::jsonb, '部門長が閲覧のみを割り当てると not_soumu');
select is(tests.error_json(tests.sql($q$ insert into public.shift_slots (year_id, starts_at, ends_at) values (:Y1, '2027-10-15 09:30+09', '2027-10-15 10:30+09') $q$)),
  jsonb_build_object('code', 'invalid_input', 'detail', jsonb_build_object('field', 'starts_at', 'reason', 'overlap', 'slot_id', tests.id('SL1'))),
  '部門長が重なる時間枠を直接足すと overlap（slot_id つき）');
select throws_ok(tests.sql('update public.shift_assignments set duty_id = :DU3 where slot_id = :SL1 and user_id = :staff'),
  '23503', null, 'ますのない持ち場へ移すと外部キーで止まる');
select tests.logout();
select tests.login_as('staff');
select throws_ok(tests.sql('insert into public.shift_assignments (year_id, slot_id, duty_id, user_id) values (:Y1, :SL2, :DU1, :viewer)'),
  '42501', null, '総務部門員が閲覧のみを割り当てようとしても、not_soumu でなく RLS の 42501（ロールを漏らさない）');
select throws_ok(tests.sql($q$ insert into public.shift_slots (year_id, starts_at, ends_at) values (:Y1, '2027-10-15 09:30+09', '2027-10-15 10:30+09') $q$),
  '42501', null, '総務部門員が重なる時間枠を足そうとしても、overlap でなく RLS の 42501');
with u as (update public.tasks set status = 'done' where id = tests.id('TK_STAFF') returning 1)
select is((select count(*)::int from u), 0, '総務部門員は自分が担当の作業でも、状態を直接は変えられない（0 行。状態は RPC set_task_status だけ）');
select tests.logout();
insert into tests.ids values ('TK_DIRECT', '00000000-0000-4000-8000-0000000f0001');
-- 楽観ロック（画面が updated_at を条件に入れる）：set_timestamps を止めて過去の updated_at を入れてから確かめる。合う版なら 1 行、
-- 同じ版でもう一度・古い版なら 0 行（画面は読み直して conflict にする）
alter table public.tasks disable trigger set_timestamps;
update public.tasks set updated_at = '2027-01-01 00:00:00.123456+00' where id = tests.id('TK_DIRECT');
alter table public.tasks enable trigger set_timestamps;
alter table public.shift_assignments disable trigger set_timestamps;
update public.shift_assignments set updated_at = '2027-01-01 00:00:00.5+00' where slot_id = tests.id('SL1') and user_id = tests.id('staff');
alter table public.shift_assignments enable trigger set_timestamps;
select tests.login_as('deputy');
with u as (update public.tasks set title = 'T-TK_DIRECT2', assignee_id = null
           where id = tests.id('TK_DIRECT') and updated_at = '2027-01-01 00:00:00.123456+00' returning 1)
select is((select count(*)::int from u), 1, '作業の楽観ロック：updated_at が合えば直せる（1 行。担当者を空にしてもよい）');
with u as (update public.tasks set title = 'T-TK_DIRECT3'
           where id = tests.id('TK_DIRECT') and updated_at = '2027-01-01 00:00:00.123456+00' returning 1)
select is((select count(*)::int from u), 0, '作業の楽観ロック：同じ版でもう一度は 0 行（直した後の updated_at は進んでいる）');
with d as (delete from public.shift_assignments
           where slot_id = tests.id('SL1') and user_id = tests.id('staff') and updated_at = '2027-01-01 00:00:00.4+00' returning 1)
select is((select count(*)::int from d), 0, '割り当てを外す：古い版では 0 行');
with d as (delete from public.shift_assignments
           where slot_id = tests.id('SL1') and user_id = tests.id('staff') and updated_at = '2027-01-01 00:00:00.5+00' returning 1)
select is((select count(*)::int from d), 1, '割り当てを外す：合う版なら 1 行');
select tests.logout();
select is((select format('%s %s %s %s', (created_by = tests.id('head'))::text, (updated_by = tests.id('deputy'))::text, title,
                         coalesce(assignee_id::text, 'null'))
           from public.tasks where id = tests.id('TK_DIRECT')),
  'true true T-TK_DIRECT2 null', '直した後も created_by は書いた人（head）、updated_by は直した人（副部門長）');
-- 両方の年度の管理者（admin は上のルールの確かめで Y2 の管理者も兼ねた）でも、シフト・作業を別の年度へ移せず、ますの時間枠も付け替え
-- られない（BEFORE ROW の check_immutable が、ポリシーの with check より先に invalid_input で止める）
select tests.login_as('admin');
select throws_ok(tests.sql('update public.tasks set year_id = :Y2 where id = :TK_NONE'),
  'P0001', 'invalid_input', '両方の年度の管理者でも、作業を別の年度へ移せない（check_immutable）');
select throws_ok(tests.sql('update public.shift_slots set year_id = :Y2 where id = :SL2'),
  'P0001', 'invalid_input', '両方の年度の管理者でも、時間枠を別の年度へ移せない');
select throws_ok(tests.sql('update public.shift_needs set slot_id = :SL2 where slot_id = :SL1 and duty_id = :DU2'),
  'P0001', 'invalid_input', 'ますの時間枠は付け替えられない（消して作り直す）');
select tests.logout();
select tests.login_anon();
select throws_ok($q$ select count(*) from public.shift_duties $q$, '42501', null, 'anon は持ち場を読めない（T20）');
select throws_ok($q$ select count(*) from public.shift_slots $q$, '42501', null, 'anon は時間枠を読めない（T20）');
select throws_ok($q$ select count(*) from public.shift_needs $q$, '42501', null, 'anon はますを読めない（T20）');
select throws_ok($q$ select count(*) from public.shift_assignments $q$, '42501', null, 'anon は割り当てを読めない（T20）');
select throws_ok($q$ select count(*) from public.tasks $q$, '42501', null, 'anon は作業を読めない（T20）');
select tests.logout();

-- anon は表もビューも読めない
select tests.login_anon();
select throws_ok($q$ select count(*) from public.years $q$, '42501', null, 'anon は表を読めない');
select throws_ok($q$ select count(*) from public.v_remaining $q$, '42501', null, 'anon はビューを読めない');
select throws_ok($q$ select count(*) from public.events $q$, '42501', null, 'anon は予定と締切を読めない（T18）');
select tests.logout();

-- 提出物（T19）：直接の書き込みの中身（権限表の外）。部門長以上の直接の insert で created_by・updated_by・files_deleted_at を送っても、書いた人が
-- 入り files_deleted_at は null（set_actor）、対象の区分は並べ直され、返り値も読める。画面が作った id で送り直すと主キーの重複で止まる（(B1)）
select tests.set_scenario('requesting');
select tests.login_as('head');
with d as (
  insert into public.documents (id, year_id, title, deadline, target_categories, created_by, updated_by, files_deleted_at)
  values ('00000000-0000-4000-8000-0000000d0001', tests.id('Y1'), 'T-DOC_DIRECT', '2027-09-01 17:00+09', '{department,stall,department}',
          tests.id('admin'), tests.id('admin'), now())
  returning created_by, updated_by, files_deleted_at, target_categories)
select is((select format('%s %s %s %s', (created_by = tests.id('head'))::text, (updated_by = tests.id('head'))::text,
                         coalesce(files_deleted_at::text, 'null'), target_categories) from d),
  'true true null {stall,department}', '部門長の直接の insert：送った created_by・updated_by・files_deleted_at は使われず、区分は並べ直され、返り値も読める');
select throws_ok($q$ insert into public.documents (id, year_id, title, deadline, target_categories)
                    values ('00000000-0000-4000-8000-0000000d0001', (select id from tests.ids where name = 'Y1'), 'T-DOC_DIRECT2', '2027-09-01 17:00+09', '{stall}') $q$,
  '23505', null, '画面が作った id で送り直すと、主キーの重複で止まる（二重にならない）');
select throws_ok($q$ insert into public.documents (year_id, title, deadline, target_categories)
                    values ((select id from tests.ids where name = 'Y1'), 'T-DOC_DIRECT', '2027-09-02 17:00+09', '{stall}') $q$,
  '23505', null, '同じ年度に同じ題名は、部門長でも入らない（documents_year_id_title_key）');
select tests.logout();
insert into tests.ids values ('DOC_DIRECT', '00000000-0000-4000-8000-0000000d0001');
-- 楽観ロック（画面が updated_at を条件に入れる。予定と締切と同じ）：set_timestamps を止めて過去の updated_at を入れてから確かめる
alter table public.documents disable trigger set_timestamps;
update public.documents set updated_at = '2027-01-01 00:00:00.123456+00' where id = tests.id('DOC_DIRECT');
alter table public.documents enable trigger set_timestamps;
select tests.login_as('deputy');
with u as (update public.documents set title = 'T-DOC_DIRECT2'
           where id = tests.id('DOC_DIRECT') and updated_at = '2027-01-01 00:00:00.123456+00' returning 1)
select is((select count(*)::int from u), 1, '提出物の楽観ロック：updated_at が合えば直せる（1 行）');
with u as (update public.documents set title = 'T-DOC_DIRECT3'
           where id = tests.id('DOC_DIRECT') and updated_at = '2027-01-01 00:00:00.123456+00' returning 1)
select is((select count(*)::int from u), 0, '提出物の楽観ロック：同じ版でもう一度は 0 行（直した後の updated_at は進んでいる）');
select tests.logout();
select is((select format('%s %s %s', (created_by = tests.id('head'))::text, (updated_by = tests.id('deputy'))::text, title)
           from public.documents where id = tests.id('DOC_DIRECT')),
  'true true T-DOC_DIRECT2', '直した後も created_by は書いた人（head）、updated_by は直した人（副部門長）');
-- 両方の年度の管理者（admin は上のルールの確かめで Y2 の管理者も兼ねた）でも、提出物を別の年度へ移せない（check_immutable）
select tests.login_as('admin');
select throws_ok(format($q$ update public.documents set year_id = %L where id = %L $q$, tests.id('Y2'), tests.id('DOC_DIRECT')),
  'P0001', 'invalid_input', '両方の年度の管理者でも、提出物を別の年度へ移せない（check_immutable）');
select tests.logout();
-- 閲覧のみも務める副店長（viewer。Y1 の閲覧のみで G4 の副店長）：提出の状況は G4 の行だけ（G1・G2 の行を未提出として出さない。判断 24）
select tests.login_as('viewer');
select is((select string_agg(t.name || ':' || g.name || ':' || v.status, ' ' order by t.name, g.name)
           from public.v_document_status v join tests.ids t on t.id = v.document_id join tests.ids g on g.id = v.group_id),
  'DOC_DIRECT:G4:not_submitted DOC_NOFILE:G4:approved DOC_STALL:G4:not_submitted',
  '閲覧のみも務める副店長は、提出の状況を自団体（G4）の行だけ読む（G4 が対象の提出物ごとに1行。上で足した DOC_DIRECT も学科が対象）');
select tests.logout();
-- v_document_files は security_invoker：届いたか（storage.objects）も読む人の RLS で見る。部門長以上と自団体の店長には届いた物が見える
select is((select string_agg(p || '=' || tests.try_cell(tests.sql('select count(*) from public.v_document_files where id = :F_G1 and uploaded and stored_size = 1000'), p, 'select'), ' ' order by p)
           from unnest(array['admin', 'head', 'rep', 'staff']) p),
  'admin=allowed head=allowed rep=allowed staff=denied', 'v_document_files の届いた物と実際の大きさは、ファイルを読める人（部門長以上・自団体）に見える');
-- anon は提出物の表もビューも読めない
select tests.login_anon();
select throws_ok($q$ select count(*) from public.documents $q$, '42501', null, 'anon は提出物を読めない（T19）');
select throws_ok($q$ select count(*) from public.document_submissions $q$, '42501', null, 'anon は提出を読めない');
select throws_ok($q$ select count(*) from public.document_files $q$, '42501', null, 'anon は提出物のファイルを読めない');
select throws_ok($q$ select count(*) from public.v_document_status $q$, '42501', null, 'anon は提出の状況を読めない');
select throws_ok($q$ select count(*) from public.v_document_files $q$, '42501', null, 'anon はファイルのビューを読めない');
select tests.logout();

select * from finish();
rollback;
