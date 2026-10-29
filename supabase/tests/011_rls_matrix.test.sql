-- 011_rls_matrix：権限表の全セル（表 × 操作 × 年度の状態 × ペルソナ）（T03）
-- 期待値の表（tests.expect）から、試す SQL（tests.cell_sql）と、Y1 の6つの状態（preparing、requesting、requesting:after＝締切後、
-- allocating、confirmed、closed）と、6人のペルソナ（admin staff rep viewer outsider admin2）を掛け合わせてセルを作る。
-- yn はペルソナの順に Y（allowed）/N（denied）を並べた6文字。scenario が '*' の行は、その表・操作の既定（状態ごとの行がなければこれ）。
-- 各セルは副トランザクションの中でペルソナに切り替えて実行し、取り消す（tests.try_cell）。select は件数 > 0、書き込みは影響した
-- 行数 > 0 を allowed、42501（権限なし・with check 違反）・0 行（using で見えない）・トリガーの invalid_state（確定中の守り）を denied とする。
-- それ以外のエラーは error:<SQLSTATE> になり、期待値と合わないので、テストデータの不備が「拒否された」に紛れない。
-- ペルソナ（fixture）：admin・staff・viewer は Y1 のロール。rep は G1（Y1）の代表で Y2 の viewer。staff と viewer は G4（Y1）の代表も兼ねる。
-- admin2 は Y2（preparing）の admin。outsider はロールも団体もない。
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
 ('group_members','insert','insert into public.group_members(group_id, user_id) values (:G1, :outsider)'),
 ('group_members','update','update public.group_members set user_id = user_id where group_id = :G1'),
 ('group_members','delete','delete from public.group_members where group_id = :G1'),
 ('invitations','select','select count(*) from public.invitations where email = ''someone@pgtap.test'''),
 ('invitations(own)','select','select count(*) from public.invitations where email = lower(auth.jwt() ->> ''email'')'),
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

-- 期待値（persona の順：admin staff rep viewer outsider admin2）
insert into tests.expect values
 -- years：読むのはロールか団体代表。書き込みは RPC だけ（権限がない）
 ('years','select','*','YYYYNN'),
 ('years','insert','*','NNNNNN'), ('years','update','*','NNNNNN'), ('years','delete','*','NNNNNN'),
 -- 年度をまたぐ表：読むのは招待された人、書くのは closed でない年度のどれかの admin（admin は Y1 だけなので Y1 が closed なら書けない）
 ('rooms','select','*','YYYYNY'),
 ('rooms','insert','*','YNNNNY'), ('rooms','insert','closed','NNNNNY'),
 ('rooms','update','*','YNNNNY'), ('rooms','update','closed','NNNNNY'),
 ('rooms','delete','*','YNNNNY'), ('rooms','delete','closed','NNNNNY'),
 ('items','select','*','YYYYNY'),
 ('items','insert','*','YNNNNY'), ('items','insert','closed','NNNNNY'),
 ('items','update','*','YNNNNY'), ('items','update','closed','NNNNNY'),
 ('items','delete','*','YNNNNY'), ('items','delete','closed','NNNNNY'),
 ('distance_overrides','select','*','YYYYNY'),
 ('distance_overrides','insert','*','YNNNNY'), ('distance_overrides','insert','closed','NNNNNY'),
 ('distance_overrides','update','*','YNNNNY'), ('distance_overrides','update','closed','NNNNNY'),
 ('distance_overrides','delete','*','YNNNNY'), ('distance_overrides','delete','closed','NNNNNY'),
 -- room_years・slots：年度のロールか団体代表が読み、admin が書く（closed は読み取り専用）
 ('room_years','select','*','YYYYNN'),
 ('room_years','insert','*','YNNNNN'), ('room_years','insert','closed','NNNNNN'),
 ('room_years','update','*','YNNNNN'), ('room_years','update','closed','NNNNNN'),
 ('room_years','delete','*','YNNNNN'), ('room_years','delete','closed','NNNNNN'),
 -- 振り分けのある部屋を使用不可にするのは、確定中は止める（E002）
 ('room_years(unusable)','insert','*','YNNNNN'), ('room_years(unusable)','insert','confirmed','NNNNNN'),
 ('room_years(unusable)','insert','closed','NNNNNN'),
 ('slots','select','*','YYYYNN'),
 ('slots','insert','*','YNNNNN'), ('slots','insert','closed','NNNNNN'),
 ('slots','update','*','YNNNNN'), ('slots','update','closed','NNNNNN'),
 ('slots','delete','*','YNNNNN'), ('slots','delete','closed','NNNNNN'),
 -- stocks：admin・staff が読む。admin は closed 以外、staff は preparing・requesting（締切後も requesting の間）に書ける
 ('stocks','select','*','YYNNNN'),
 ('stocks','insert','*','YYNNNN'), ('stocks','insert','allocating','YNNNNN'), ('stocks','insert','confirmed','YNNNNN'),
 ('stocks','insert','closed','NNNNNN'),
 ('stocks','update','*','YYNNNN'), ('stocks','update','allocating','YNNNNN'), ('stocks','update','confirmed','YNNNNN'),
 ('stocks','update','closed','NNNNNN'),
 -- 在庫の行を消す・在庫を振り分けより少なくするのは、確定中は止める（E001）
 ('stocks','delete','*','YYNNNN'), ('stocks','delete','allocating','YNNNNN'), ('stocks','delete','confirmed','NNNNNN'),
 ('stocks','delete','closed','NNNNNN'),
 ('stocks(decrease)','update','*','YYNNNN'), ('stocks(decrease)','update','allocating','YNNNNN'),
 ('stocks(decrease)','update','confirmed','NNNNNN'), ('stocks(decrease)','update','closed','NNNNNN'),
 ('v_remaining','select','*','YYNNNN'),
 -- groups：admin・staff・viewer と自団体の代表が読む。admin が書く。確定中は削除と使用場所の変更を止める
 ('groups','select','*','YYYYNN'), ('groups(G2)','select','*','YYNYNN'),
 ('groups','insert','*','YNNNNN'), ('groups','insert','closed','NNNNNN'),
 ('groups','update','*','YNNNNN'), ('groups','update','closed','NNNNNN'),
 ('groups','delete','*','YNNNNN'), ('groups','delete','confirmed','NNNNNN'), ('groups','delete','closed','NNNNNN'),
 ('groups(location)','update','*','YNNNNN'), ('groups(location)','update','confirmed','NNNNNN'),
 ('groups(location)','update','closed','NNNNNN'),
 -- year_roles・group_members・invitations：admin と自分の行。書き込みは RPC だけ
 ('year_roles','select','*','YYNNNN'), ('year_roles(own)','select','*','YYYYNY'),
 ('year_roles','insert','*','NNNNNN'), ('year_roles','update','*','NNNNNN'), ('year_roles','delete','*','NNNNNN'),
 ('group_members','select','*','YNYNNN'), ('group_members(own)','select','*','NYYYNN'),
 ('group_members','insert','*','NNNNNN'), ('group_members','update','*','NNNNNN'), ('group_members','delete','*','NNNNNN'),
 ('invitations','select','*','YNNNNN'), ('invitations(own)','select','*','NYYYNN'),
 ('invitations','insert','*','NNNNNN'), ('invitations','update','*','NNNNNN'), ('invitations','delete','*','NNNNNN'),
 -- 申請：admin・staff と自団体の代表が読む。団体代表は受付期間内、admin は preparing と締切前の requesting に書ける
 ('request_submissions','select','*','YYYNNN'), ('request_submissions(G2)','select','*','YYNNNN'),
 ('request_submissions','insert','*','NNNNNN'), ('request_submissions','insert','preparing','YNNNNN'),
 ('request_submissions','insert','requesting','YNYNNN'),
 ('request_submissions','update','*','NNNNNN'), ('request_submissions','update','preparing','YNNNNN'),
 ('request_submissions','update','requesting','YNYNNN'),
 ('request_submissions(G2)','update','*','NNNNNN'), ('request_submissions(G2)','update','preparing','YNNNNN'),
 ('request_submissions(G2)','update','requesting','YNNNNN'),
 ('request_submissions','delete','*','NNNNNN'), ('request_submissions','delete','preparing','YNNNNN'),
 ('request_submissions','delete','requesting','YNYNNN'),
 ('requests','select','*','YYYNNN'), ('requests(G2)','select','*','YYNNNN'),
 ('requests','insert','*','NNNNNN'), ('requests','insert','preparing','YNNNNN'), ('requests','insert','requesting','YNYNNN'),
 -- staff と viewer は G4 の代表なので、受付期間内は G4 の申請を書ける
 ('requests(G4)','insert','*','NNNNNN'), ('requests(G4)','insert','preparing','YNNNNN'),
 ('requests(G4)','insert','requesting','YYNYNN'),
 ('requests','update','*','NNNNNN'), ('requests','update','preparing','YNNNNN'), ('requests','update','requesting','YNYNNN'),
 ('requests(G2)','update','*','NNNNNN'), ('requests(G2)','update','preparing','YNNNNN'), ('requests(G2)','update','requesting','YNNNNN'),
 ('requests','delete','*','NNNNNN'), ('requests','delete','preparing','YNNNNN'), ('requests','delete','requesting','YNYNNN'),
 -- rules：admin・staff が読み、admin が書く。closed は memo だけ（トリガー）
 ('rules','select','*','YYNNNN'),
 ('rules','insert','*','YNNNNN'), ('rules','insert','closed','NNNNNN'),
 ('rules','update','*','YNNNNN'),
 ('rules(enabled)','update','*','YNNNNN'), ('rules(enabled)','update','closed','NNNNNN'),
 ('rules','delete','*','YNNNNN'), ('rules','delete','closed','NNNNNN'),
 -- 了承：admin・staff と自団体の代表が読む。書き込みは set_consent だけ
 ('substitution_consents','select','*','YYYNNN'),
 ('substitution_consents','insert','*','NNNNNN'), ('substitution_consents','update','*','NNNNNN'),
 ('substitution_consents','delete','*','NNNNNN'),
 -- allocations：admin・staff は常に、viewer と自団体の代表は confirmed 以降に読む。書き込みは RPC だけ
 ('allocations','select','*','YYNNNN'), ('allocations','select','confirmed','YYYYNN'), ('allocations','select','closed','YYYYNN'),
 ('allocations(G2)','select','*','YYNNNN'), ('allocations(G2)','select','confirmed','YYNYNN'),
 ('allocations(G2)','select','closed','YYNYNN'),
 ('allocations','insert','*','NNNNNN'), ('allocations','update','*','NNNNNN'), ('allocations','delete','*','NNNNNN'),
 -- deliveries：admin・staff・viewer と自団体の代表が読み、admin が書く（staff の更新は check_delivery）
 ('deliveries','select','*','YYYYNN'), ('deliveries(G2)','select','*','YYNYNN'),
 ('deliveries','insert','*','YNNNNN'), ('deliveries','insert','closed','NNNNNN'),
 ('deliveries','update','*','YNNNNN'), ('deliveries','update','closed','NNNNNN'),
 ('deliveries','delete','*','YNNNNN'), ('deliveries','delete','closed','NNNNNN'),
 -- profiles：自分と、自分が admin・staff である年度のメンバー（admin2 は Y2 の admin で、rep は Y2 の viewer）
 ('profiles','select','*','YYNNNN'), ('profiles(own)','select','*','YYYYYY'), ('profiles(rep)','select','*','YYYNNY'),
 ('profiles','insert','*','NNNNNN'), ('profiles','update','*','NNNNNN'), ('profiles','delete','*','NNNNNN'),
 -- audit_logs：その年度の admin。年度のない行（年度をまたぐ3表）は closed でない年度の admin
 ('audit_logs','select','*','YNNNNN'),
 ('audit_logs(global)','select','*','YNNNNY'), ('audit_logs(global)','select','closed','NNNNNY'),
 ('audit_logs','insert','*','NNNNNN'), ('audit_logs','update','*','NNNNNN'), ('audit_logs','delete','*','NNNNNN');

create view tests.cells as
select c.tbl, c.op, s.scenario, p.persona,
       case substr(coalesce(e.yn, d.yn), p.ord::int, 1) when 'Y' then 'allowed' when 'N' then 'denied' end as expected,
       tests.sql(c.template) as sql
from tests.cell_sql c
cross join unnest(array['preparing','requesting','requesting:after','allocating','confirmed','closed']) as s(scenario)
cross join unnest(array['admin','staff','rep','viewer','outsider','admin2']) with ordinality as p(persona, ord)
left join tests.expect e on e.tbl = c.tbl and e.op = c.op and e.scenario = s.scenario
left join tests.expect d on d.tbl = c.tbl and d.op = c.op and d.scenario = '*';

create function tests.run_cell(p_scenario text, p_persona text, p_op text, p_sql text) returns text
language plpgsql as $$
begin
  perform tests.set_scenario(p_scenario);
  return tests.try_cell(p_sql, p_persona, p_op);
end $$;

select plan((select count(*)::int from tests.cells) + 3 + 15);

-- 期待値の表の形
select is((select count(*)::int from tests.cells where expected is null), 0, '全セルに期待値がある（既定の * か状態ごとの行）');
select is_empty($$ select e.tbl, e.op from tests.expect e left join tests.cell_sql c using (tbl, op) where c.tbl is null $$,
  '期待値の表に、試す SQL のない行がない');
select is((select count(distinct tbl)::int from tests.cell_sql where tbl !~ '\('), 20, '19 表と v_remaining をすべて試す');

select is(tests.run_cell(scenario, persona, op, sql), expected,
          format('%s %s [%s] %s', tbl, op, scenario, persona))
from tests.cells
order by tbl, op, scenario, persona;

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
-- 締切が null の requesting（RPC では作れないが、念のため）は、団体代表も admin も書けない
update public.years set request_open_at = null, request_close_at = null where id = tests.id('Y1');
select is(tests.try_cell(tests.sql('update public.requests set count = 7 where group_id = :G1'), 'rep', 'update'), 'denied',
  '締切が null なら団体代表は書けない（K-24）');
select is(tests.try_cell(tests.sql('update public.requests set count = 7 where group_id = :G1'), 'admin', 'update'), 'denied',
  '締切が null の requesting は admin も RPC なしでは書けない');

-- anon は表もビューも読めない
select tests.login_anon();
select throws_ok($q$ select count(*) from public.years $q$, '42501', null, 'anon は表を読めない');
select throws_ok($q$ select count(*) from public.v_remaining $q$, '42501', null, 'anon はビューを読めない');
select tests.logout();

select * from finish();
rollback;
