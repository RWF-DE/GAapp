-- 速さの改善（2026-10-30）：RLS の判定関数を行ごとに呼ぶ書き方の速さ。audit_logs に 10 万行と、ほかの表に合成データ r8like の
-- 規模（の K 倍）を入れて、ペルソナ（seed の管理者・部員・団体代表・閲覧のみ・未招待）ごとに EXPLAIN ANALYZE の実行時間
-- （1回の空回しの後の 7 回の中央値）を測る。全部を1つのトランザクションで行い、最後に rollback する（何も残さない）。
-- 流し方（ローカルの Supabase。共有の DB はロックを取って）：
--   psql postgresql://postgres:postgres@127.0.0.1:54322/postgres -v K=1 -f notes/T14/rls-perf.sql
--   -v K=5 で 5 倍。-v CANDIDATE=<ファイル> を渡すと、今のポリシーで測った後に同じトランザクションでそのファイルを流して
--   （案のポリシー）もう一度測り、前後を並べる。CANDIDATE を渡さなければ、今の DB のポリシーで1回だけ測る。
-- 規模（年度あたり。r8like は団体 59・場所 56・品目 9）：場所 56K（年度をまたぐ）、団体 60K、在庫 56K×9、申請 60K×6、提出 60K、
-- 了承 25K、振り分け 60K×10。年度は 5 つ（測る年度〔allocating〕と、終わった年度 4 つ〔closed〕。ペルソナのロールは測る年度だけ）。
-- 結果は notes/T14.md の「速さの改善（2026-10-30）」。
\set ON_ERROR_STOP on
\if :{?K}
\else
  \set K 1
\endif
begin;
create schema perf;
grant usage on schema perf to authenticated;
create table perf.results (phase text, label text, persona text, ms numeric, rows bigint, plan text);
create table perf.cases (ord serial, label text, persona text, sql text);

-- ペルソナ（seed のユーザー）
create table perf.personas (name text primary key, id uuid);
insert into perf.personas values
  ('admin', '00000000-0000-4000-8000-000000000001'), ('staff', '00000000-0000-4000-8000-000000000002'),
  ('rep', '00000000-0000-4000-8000-000000000003'), ('viewer', '00000000-0000-4000-8000-000000000004'),
  ('outsider', '00000000-0000-4000-8000-000000000005');

-- ---------------------------------------------------------------- データ
-- 年度：n = 0 が測る年度。1〜4 は終わった年度
create table perf.years as
  select n, ('7e140000-0000-4000-8000-' || lpad(n::text, 12, '0'))::uuid as id from generate_series(0, 4) n;
insert into public.years (id, label, festival_start, status, request_open_at, request_close_at)
select id, 'perf-rls-' || n, date '2011-10-13' - n * 365, 'allocating', now() - interval '30 days', now() - interval '1 day'
from perf.years;
insert into public.year_roles (year_id, user_id, role)
select (select id from perf.years where n = 0), p.id, p.name::public.app_role
from perf.personas p where p.name in ('admin', 'staff', 'viewer');

create table perf.rooms as select n, gen_random_uuid() as id from generate_series(1, 56 * :K) n;
insert into public.rooms (id, name, kind, building, floor, is_storage, sort_order)
select id, 'perf-rls-room-' || n, 'room', 'perf棟', 1, true, 1000 + n from perf.rooms;

create table perf.groups as
  select y.id as year_id, y.n as year_n, g.n, gen_random_uuid() as id from perf.years y cross join generate_series(1, 60 * :K) g(n);
insert into public.groups (id, year_id, name, category, sort_order)
select id, year_id, 'perf-rls-group-' || n, 'stall', n from perf.groups;
-- 団体代表：測る年度の最初の団体
insert into public.group_members (group_id, user_id)
select g.id, p.id from perf.groups g, perf.personas p where g.year_n = 0 and g.n = 1 and p.name = 'rep';

insert into public.stocks (year_id, room_id, item_id, count)
select y.id, r.id, i.id, (r.n + y.n) % 13 from perf.years y cross join perf.rooms r cross join public.items i;

insert into public.requests (group_id, item_id, count)
select g.id, i.id, 1 + (g.n % 7) from perf.groups g join public.items i
  on i.code in ('desk', 'chair', 'caster_desk', 'blue_chair', 'long_desk_2', 'lectern');
insert into public.request_submissions (group_id, submitted_at) select id, now() - interval '10 days' from perf.groups;
insert into public.substitution_consents (group_id, from_item_id, to_item_id, status)
select g.id, (select id from public.items where code = 'desk'), (select id from public.items where code = 'caster_desk'), 'accepted'
from perf.groups g where g.n <= 25 * :K;
insert into public.allocations (year_id, source_room_id, group_id, item_id, requested_item_id, count, origin)
select g.year_id, r.id, g.id, i.id, i.id, 1 + (k % 5), 'auto'
from perf.groups g cross join generate_series(1, 10) k
join perf.rooms r on r.n = 1 + ((g.n * 10 + k) % (56 * :K))
join public.items i on i.code = (array['desk', 'chair'])[1 + k % 2];
-- 終わった年度を closed にする（振り分けの後で）
update public.years set status = 'closed' where id in (select id from perf.years where n > 0);

-- 履歴：notes/T14/history-perf.sql と同じ形の 10 万行（測る年度）と、年度のない行 200
create temp table perf_groups as select id, n from perf.groups where year_n = 0 and n <= 40;
insert into public.audit_logs (table_name, row_pk, action, year_id, group_id, before, after, reason, user_id, at)
select t.table_name, '{}'::jsonb, 'update', (select id from perf.years where n = 0),
       case when t.table_name in ('requests','request_submissions','allocations','substitution_consents','groups','group_members')
            then (select id from perf_groups where n = 1 + (g % 40)) end,
       jsonb_build_object('count', g % 17), jsonb_build_object('count', g % 19), null,
       case g % 10 when 0 then null when 1 then '00000000-0000-4000-8000-000000000002'::uuid
                   when 2 then '00000000-0000-4000-8000-000000000003'::uuid
                   else '00000000-0000-4000-8000-000000000001'::uuid end,
       now() - (random() * interval '120 days')
from generate_series(1, 100000) g
cross join lateral (select (array['stocks','stocks','stocks','requests','requests','allocations','allocations','allocations',
                                  'request_submissions','substitution_consents','room_years','groups','year_roles','group_members',
                                  'years'])[1 + (g % 15)] as table_name) t;
insert into public.audit_logs (table_name, row_pk, action, year_id, before, after, user_id, at)
select 'stocks', '{}'::jsonb, 'update', (select id from perf.years where n = 0), '{"a":1}', '{"a":2}',
       '00000000-0000-4000-8000-000000000004', now() - g * interval '20 days' from generate_series(1, 5) g;
insert into public.audit_logs (table_name, row_pk, action, year_id, before, after, at)
select (array['rooms','items'])[1 + g % 2], '{}'::jsonb, 'update', null, '{"name":"a"}', '{"name":"b"}', now() - g * interval '1 day'
from generate_series(1, 200) g;
analyze public.audit_logs, public.allocations, public.requests, public.stocks, public.request_submissions,
        public.substitution_consents, public.groups, public.year_roles, public.group_members, public.years, public.rooms;

select (select count(*) from public.audit_logs) as audit_logs, (select count(*) from public.allocations) as allocations,
       (select count(*) from public.requests) as requests, (select count(*) from public.stocks) as stocks,
       (select count(*) from public.request_submissions) as submissions,
       (select count(*) from public.substitution_consents) as consents, (select count(*) from public.groups) as groups;

-- ---------------------------------------------------------------- 測る問い合わせ
-- :Y は測る年度、:G は団体代表の団体、:R は最初の場所（在庫の入力の画面）
select id as "Y" from perf.years where n = 0 \gset
select id as "G" from perf.groups where year_n = 0 and n = 1 \gset
select id as "R" from perf.rooms where n = 1 \gset
\set AC 'id, table_name, row_pk, action, year_id, group_id, before, after, reason, user_id, at'
insert into perf.cases (label, persona, sql) values
  -- 履歴（notes/T14/history-perf.sql の Q1〜Q8 と同じ形）
  ('audit 年度だけ', 'admin', format('select %s from public.audit_logs where year_id = %L order by at desc, id desc limit 51', :'AC', :'Y')),
  ('audit 年度と表（申請・提出）', 'admin', format('select %s from public.audit_logs where year_id = %L and table_name in (''requests'',''request_submissions'') order by at desc, id desc limit 51', :'AC', :'Y')),
  ('audit 年度と団体', 'admin', format('select %s from public.audit_logs where year_id = %L and group_id = %L order by at desc, id desc limit 51', :'AC', :'Y', :'G')),
  ('audit 年度と期間（7 日）', 'admin', format('select %s from public.audit_logs where year_id = %L and at >= now() - interval ''60 days'' and at < now() - interval ''53 days'' order by at desc, id desc limit 51', :'AC', :'Y')),
  ('audit or(年度,年度なし)と在庫・場所', 'admin', format('select %s from public.audit_logs where (year_id = %L or year_id is null) and table_name in (''stocks'',''rooms'') order by at desc, id desc limit 51', :'AC', :'Y')),
  ('audit 年度のない場所', 'admin', format('select %s from public.audit_logs where year_id is null and table_name = ''rooms'' order by at desc, id desc limit 51', :'AC')),
  ('audit 年度とした人（部員。1 割）', 'admin', format('select %s from public.audit_logs where year_id = %L and user_id = ''00000000-0000-4000-8000-000000000002'' order by at desc, id desc limit 51', :'AC', :'Y')),
  ('audit 年度と珍しい人（5 行）', 'admin', format('select %s from public.audit_logs where year_id = %L and user_id = ''00000000-0000-4000-8000-000000000004'' order by at desc, id desc limit 51', :'AC', :'Y')),
  ('audit 絞り込みなし（新しい順）', 'admin', format('select %s from public.audit_logs order by at desc, id desc limit 51', :'AC')),
  ('audit 絞り込みなし', 'admin', format('select %s from public.audit_logs limit 51', :'AC')),
  ('audit 絞り込みなし', 'staff', format('select %s from public.audit_logs limit 51', :'AC')),
  ('audit 絞り込みなし', 'viewer', format('select %s from public.audit_logs limit 51', :'AC')),
  ('audit 絞り込みなし', 'rep', format('select %s from public.audit_logs limit 51', :'AC')),
  ('audit 絞り込みなし', 'outsider', format('select %s from public.audit_logs limit 51', :'AC')),
  ('audit 年度だけ', 'staff', format('select %s from public.audit_logs where year_id = %L order by at desc, id desc limit 51', :'AC', :'Y')),
  ('audit 年度だけ', 'outsider', format('select %s from public.audit_logs where year_id = %L order by at desc, id desc limit 51', :'AC', :'Y')),
  -- 振り分け（スナップショット：year_id で全行）
  ('allocations 年度', 'admin', format('select * from public.allocations where year_id = %L order by id', :'Y')),
  ('allocations 年度', 'staff', format('select * from public.allocations where year_id = %L order by id', :'Y')),
  ('allocations 年度', 'viewer', format('select * from public.allocations where year_id = %L order by id', :'Y')),
  ('allocations 年度', 'rep', format('select * from public.allocations where year_id = %L order by id', :'Y')),
  ('allocations 年度', 'outsider', format('select * from public.allocations where year_id = %L order by id', :'Y')),
  ('allocations 年度と団体', 'rep', format('select * from public.allocations where year_id = %L and group_id = %L order by id', :'Y', :'G')),
  ('allocations 絞り込みなし', 'outsider', 'select * from public.allocations limit 1000'),
  -- 申請（スナップショット：groups!inner(year_id) で年度の全行。団体代表は自団体）
  ('requests 年度（groups と結合）', 'admin', format('select r.* from public.requests r join public.groups g on g.id = r.group_id where g.year_id = %L order by r.group_id, r.item_id', :'Y')),
  ('requests 年度（groups と結合）', 'staff', format('select r.* from public.requests r join public.groups g on g.id = r.group_id where g.year_id = %L order by r.group_id, r.item_id', :'Y')),
  ('requests 年度（groups と結合）', 'outsider', format('select r.* from public.requests r join public.groups g on g.id = r.group_id where g.year_id = %L order by r.group_id, r.item_id', :'Y')),
  ('requests 団体', 'rep', format('select * from public.requests where group_id = %L order by item_id', :'G')),
  ('requests 絞り込みなし', 'outsider', 'select * from public.requests limit 1000'),
  ('request_submissions 年度（groups と結合）', 'admin', format('select s.* from public.request_submissions s join public.groups g on g.id = s.group_id where g.year_id = %L order by s.group_id', :'Y')),
  ('request_submissions 年度（groups と結合）', 'staff', format('select s.* from public.request_submissions s join public.groups g on g.id = s.group_id where g.year_id = %L order by s.group_id', :'Y')),
  ('substitution_consents 年度（groups と結合）', 'admin', format('select c.* from public.substitution_consents c join public.groups g on g.id = c.group_id where g.year_id = %L order by c.group_id', :'Y')),
  -- 在庫（スナップショットと在庫の入力の画面）
  ('stocks 年度', 'admin', format('select * from public.stocks where year_id = %L order by room_id, item_id', :'Y')),
  ('stocks 年度', 'staff', format('select * from public.stocks where year_id = %L order by room_id, item_id', :'Y')),
  ('stocks 年度', 'outsider', format('select * from public.stocks where year_id = %L order by room_id, item_id', :'Y')),
  ('stocks 年度と場所', 'staff', format('select * from public.stocks where year_id = %L and room_id = %L order by item_id', :'Y', :'R')),
  -- 団体
  ('groups 年度', 'admin', format('select * from public.groups where year_id = %L order by sort_order, id', :'Y')),
  ('groups 年度', 'rep', format('select * from public.groups where year_id = %L order by sort_order, id', :'Y'));

-- 1つの問い合わせを、ペルソナで（PostgREST と同じく authenticated と JWT の sub）1回空回ししてから 7 回測り、中央値を返す
create function perf.measure(p_phase text) returns void language plpgsql as $$
declare
  c record; j json; t numeric[]; r bigint; i int; v_plan text; v_line text;
begin
  for c in select * from perf.cases order by ord loop
    perform set_config('request.jwt.claims',
      json_build_object('sub', (select id from perf.personas where name = c.persona), 'role', 'authenticated')::text, true);
    set local role authenticated;
    t := '{}';
    for i in 0..7 loop
      execute 'explain (analyze, format json) ' || c.sql into j;
      if i > 0 then t := t || (j -> 0 ->> 'Execution Time')::numeric; end if;
      r := (j -> 0 -> 'Plan' ->> 'Actual Rows')::bigint;
    end loop;
    v_plan := '';
    for v_line in execute 'explain (costs off) ' || c.sql loop v_plan := v_plan || v_line || E'\n'; end loop;
    reset role;
    insert into perf.results
    select p_phase, c.label, c.persona, round(percentile_cont(0.5) within group (order by x)::numeric, 2), r, v_plan
    from unnest(t) x;
  end loop;
end $$;
grant usage on schema perf to authenticated;
grant select on perf.cases, perf.personas to authenticated;

select perf.measure('db');

\if :{?CANDIDATE}
  \ir :CANDIDATE
  analyze public.audit_logs;
  select perf.measure('candidate');
\endif

\pset footer off
-- db_ms：今の DB のポリシー、candidate_ms：CANDIDATE を流した後（渡したときだけ）。rows は返った行数
select b.label, b.persona, b.ms as db_ms, a.ms as candidate_ms, b.rows,
       case when a.rows is not null and a.rows <> b.rows then '行数が違う' else '' end as check
from perf.results b left join perf.results a on a.phase = 'candidate' and a.label = b.label and a.persona = b.persona
join perf.cases c on c.label = b.label and c.persona = b.persona
where b.phase = 'db' order by c.ord;
\if :{?PLANS}
select phase, label, persona, plan from perf.results order by phase, label, persona;
\endif
select now() as measured_at;
rollback;
