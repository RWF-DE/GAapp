-- 011_rls_matrix：権限表の全セル（表 × 操作 × 年度の状態 × ペルソナ）（T03。T15 で総務部門長・副部門長を足した）
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
 ('audit_logs','delete','delete from public.audit_logs');

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
 ('audit_logs','insert','*','NNNNNNN'), ('audit_logs','update','*','NNNNNNN'), ('audit_logs','delete','*','NNNNNNN');

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

select plan((select count(*)::int from tests.cells) + 6 + 24);

-- 期待値の表の形
select is((select count(*)::int from tests.cells where expected is null), 0, '全セルに期待値がある（既定の * か状態ごとの行）');
select is_empty($$ select e.tbl, e.op from tests.expect e left join tests.cell_sql c using (tbl, op) where c.tbl is null $$,
  '期待値の表に、試す SQL のない行がない');
select is((select count(distinct tbl)::int from tests.cell_sql where tbl !~ '\('), 20, '19 表と v_remaining をすべて試す');
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

-- anon は表もビューも読めない
select tests.login_anon();
select throws_ok($q$ select count(*) from public.years $q$, '42501', null, 'anon は表を読めない');
select throws_ok($q$ select count(*) from public.v_remaining $q$, '42501', null, 'anon はビューを読めない');
select tests.logout();

select * from finish();
rollback;
