-- T14 段 1：履歴の読み込みの速さ（audit_logs に 10 万行）。全部を1つのトランザクションで行い、最後に rollback する（何も残さない）。
-- 流し方（ローカルの Supabase。共有の DB はロックを取って）：psql postgresql://postgres:postgres@127.0.0.1:54322/postgres -f notes/T14/history-perf.sql
-- 最後に rollback するので、行も案の RLS も残らない。結果は notes/T14.md の「履歴の読み込みの速さ」。
\set ON_ERROR_STOP on
\timing on
begin;
insert into public.years (id, label, festival_start, status, request_open_at, request_close_at)
values ('7e140000-0000-4000-8000-000000000001', 'E2E-perf-t14', '2001-10-13', 'allocating', now() - interval '30 days', now() - interval '1 day');
insert into public.year_roles (year_id, user_id, role) values
  ('7e140000-0000-4000-8000-000000000001', '00000000-0000-4000-8000-000000000001', 'admin');
-- 団体は audit_logs の group_id にだけ使う（groups の行は要らない）
create temp table perf_groups as select gen_random_uuid() as id, n from generate_series(1, 40) n;
insert into public.audit_logs (table_name, row_pk, action, year_id, group_id, before, after, reason, user_id, at)
select t.table_name, '{}'::jsonb, 'update', '7e140000-0000-4000-8000-000000000001',
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
-- 珍しい表（ルール 20 行）と珍しい人（5 行）
insert into public.audit_logs (table_name, row_pk, action, year_id, before, after, user_id, at)
select 'rules', '{}'::jsonb, 'update', '7e140000-0000-4000-8000-000000000001', '{"a":1}', '{"a":2}', null, now() - g * interval '3 days' from generate_series(1, 20) g;
insert into public.audit_logs (table_name, row_pk, action, year_id, before, after, user_id, at)
select 'stocks', '{}'::jsonb, 'update', '7e140000-0000-4000-8000-000000000001', '{"a":1}', '{"a":2}', '00000000-0000-4000-8000-000000000004', now() - g * interval '20 days' from generate_series(1, 5) g;
-- 年度のない行（場所・品目）
insert into public.audit_logs (table_name, row_pk, action, year_id, before, after, at)
select (array['rooms','items'])[1 + g % 2], '{}'::jsonb, 'update', null, '{"name":"a"}', '{"name":"b"}', now() - g * interval '1 day' from generate_series(1, 200) g;
analyze public.audit_logs;
select count(*) as all_rows, count(*) filter (where year_id = '7e140000-0000-4000-8000-000000000001') as perf_year from public.audit_logs;

select id as g7 from perf_groups where n = 7 \gset
-- 管理者として（PostgREST と同じく authenticated と JWT の sub）
set local role authenticated;
select set_config('request.jwt.claims', '{"sub":"00000000-0000-4000-8000-000000000001","role":"authenticated"}', true);
\set Y '''7e140000-0000-4000-8000-000000000001'''
\set COLS 'id, table_name, row_pk, action, year_id, group_id, before, after, reason, user_id, at'

\echo '== Q1 年度だけ'
explain (analyze, buffers, costs off) select :COLS from public.audit_logs where year_id = :Y order by at desc, id desc limit 51;
\echo '== Q2 年度と表（申請・提出）'
explain (analyze, buffers, costs off) select :COLS from public.audit_logs where year_id = :Y and table_name in ('requests','request_submissions') order by at desc, id desc limit 51;
\echo '== Q2b 年度と珍しい表（ルール 20 行）'
explain (analyze, buffers, costs off) select :COLS from public.audit_logs where year_id = :Y and table_name = 'rules' order by at desc, id desc limit 51;
\echo '== Q3 年度と団体'
explain (analyze, buffers, costs off) select :COLS from public.audit_logs where year_id = :Y and group_id = :'g7' order by at desc, id desc limit 51;
\echo '== Q4 年度と期間（7 日）'
explain (analyze, buffers, costs off) select :COLS from public.audit_logs where year_id = :Y and at >= now() - interval '60 days' and at < now() - interval '53 days' order by at desc, id desc limit 51;
\echo '== Q4b 年度と行のない期間'
explain (analyze, buffers, costs off) select :COLS from public.audit_logs where year_id = :Y and at >= '1999-01-01T00:00:00+09:00' and at < '1999-01-02T00:00:00+09:00' order by at desc, id desc limit 51;
\echo '== Q5 年度をまたぐ表（場所）と在庫：or(year_id.eq,year_id.is.null)'
explain (analyze, buffers, costs off) select :COLS from public.audit_logs where (year_id = :Y or year_id is null) and table_name in ('stocks','rooms') order by at desc, id desc limit 51;
\echo '== Q5b 年度をまたぐ表（場所）だけ'
explain (analyze, buffers, costs off) select :COLS from public.audit_logs where (year_id = :Y or year_id is null) and table_name = 'rooms' order by at desc, id desc limit 51;
\echo '== Q6 年度とした人（部員。1 割）'
explain (analyze, buffers, costs off) select :COLS from public.audit_logs where year_id = :Y and user_id = '00000000-0000-4000-8000-000000000002' order by at desc, id desc limit 51;
\echo '== Q6b 年度と珍しい人（5 行）'
explain (analyze, buffers, costs off) select :COLS from public.audit_logs where year_id = :Y and user_id = '00000000-0000-4000-8000-000000000004' order by at desc, id desc limit 51;
\echo '== Q7 年度と続き（20 ページ目）'
select at as c_at, id as c_id from public.audit_logs where year_id = :Y order by at desc, id desc offset 999 limit 1 \gset
explain (analyze, buffers, costs off) select :COLS from public.audit_logs where year_id = :Y and (at < :'c_at' or (at = :'c_at' and id < :c_id)) order by at desc, id desc limit 51;

\echo '== Q5-split-A 年度の在庫（画面の新しい問い合わせ：年度の行）'
explain (analyze, buffers, costs off) select :COLS from public.audit_logs where year_id = :Y and table_name = 'stocks' order by at desc, id desc limit 51;
\echo '== Q5-split-B 年度のない場所（画面の新しい問い合わせ：year_id is null）'
explain (analyze, buffers, costs off) select :COLS from public.audit_logs where year_id is null and table_name = 'rooms' order by at desc, id desc limit 51;
\echo '== Q7-new 年度と続き（20 ページ目。at <= を足す）'
explain (analyze, buffers, costs off) select :COLS from public.audit_logs where year_id = :Y and at <= :'c_at' and (at < :'c_at' or (at = :'c_at' and id < :c_id)) order by at desc, id desc limit 51;
select at as d_at, id as d_id from public.audit_logs where year_id = :Y order by at desc, id desc offset 49999 limit 1 \gset
\echo '== Q7-deep-old 年度と続き（1000 ページ目。or だけ）'
explain (analyze, buffers, costs off) select :COLS from public.audit_logs where year_id = :Y and (at < :'d_at' or (at = :'d_at' and id < :d_id)) order by at desc, id desc limit 51;
\echo '== Q7-deep-new 年度と続き（1000 ページ目。at <= を足す）'
explain (analyze, buffers, costs off) select :COLS from public.audit_logs where year_id = :Y and at <= :'d_at' and (at < :'d_at' or (at = :'d_at' and id < :d_id)) order by at desc, id desc limit 51;
\echo '== Q8 未招待の人が絞り込みなしで読む（RLS で 0 行。foundation.spec の statement timeout の形）'
select set_config('request.jwt.claims', '{"sub":"00000000-0000-4000-8000-000000000005","role":"authenticated"}', true);
explain (analyze, buffers, costs off) select :COLS from public.audit_logs limit 51;
select set_config('request.jwt.claims', '{"sub":"00000000-0000-4000-8000-000000000001","role":"authenticated"}', true);

-- DB への申し送りの案：年度の判定を行ごとの has_role(year_id) から、admin の年度の集合を1回だけ作る形にする
reset role;
create function private.admin_year_ids() returns setof uuid language sql stable security definer set search_path = '' as $$
  select yr.year_id from public.year_roles yr where yr.user_id = (select auth.uid()) and yr.role = 'admin' $$;
grant execute on function private.admin_year_ids() to authenticated;
drop policy audit_logs_select on public.audit_logs;
create policy audit_logs_select on public.audit_logs for select to authenticated
  using (case when year_id is null
              then table_name in ('rooms', 'items', 'distance_overrides') and (select private.is_admin_of_open_year())
              else year_id in (select private.admin_year_ids()) end);
set local role authenticated;
\echo '== P-Q5 案の RLS：or(year_id.eq,year_id.is.null) と在庫・場所'
explain (analyze, buffers, costs off) select :COLS from public.audit_logs where (year_id = :Y or year_id is null) and table_name in ('stocks','rooms') order by at desc, id desc limit 51;
\echo '== P-Q1 案の RLS：年度だけ'
explain (analyze, buffers, costs off) select :COLS from public.audit_logs where year_id = :Y order by at desc, id desc limit 51;
\echo '== P-Q6b 案の RLS：年度と珍しい人'
explain (analyze, buffers, costs off) select :COLS from public.audit_logs where year_id = :Y and user_id = '00000000-0000-4000-8000-000000000004' order by at desc, id desc limit 51;
\echo '== P-Q8 案の RLS：未招待の人が絞り込みなしで読む'
select set_config('request.jwt.claims', '{"sub":"00000000-0000-4000-8000-000000000005","role":"authenticated"}', true);
explain (analyze, buffers, costs off) select :COLS from public.audit_logs limit 51;
rollback;
