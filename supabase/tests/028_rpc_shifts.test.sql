-- 028_rpc_shifts：シフト・作業の RPC（set_task_status・add_shift_slots）（T20。D-56。0017_shifts.sql）
-- 期待値は 02 の「シフト・作業の権限」、04 の DB 関数の表、notes/T20.md の「SQL の約束」（set_task_status のエラーの順 1〜6、
-- add_shift_slots の 1〜7）から先に書いてから流した。
-- ① 段の表：RPC を admin・head・deputy・staff・viewer・rep・outsider・admin2 で1回ずつ試して取り消す（tests.try_rpc。024・025 と同じ形）。
--    yn は列の順（admin head staff viewer rep outsider admin2）に、空白で区切った7つの結果。deputy は head の列で確かめ、実際の結果どうしも
--    比べる。略号：ok、F＝forbidden、NF＝not_found、IS＝invalid_state、II＝invalid_input、CF＝conflict。
-- ② set_task_status のエラーの順番と detail（tests.error_json）。作業の有無を漏らさない（ない作業・ほかの年度の作業・読めない作業は同じ forbidden）。
-- ③ set_task_status の楽観ロック（ミリ秒までで比べる。detail は id）と、書いた中身（返り値・状態だけ・直した人・監査の理由・同じ状態）。
-- ④ set_task_status：担当者が閲覧のみに変わった・ロールを外された作業と、年度の行のロックを待つ間に消えた作業（not_found）。
-- ⑤ add_shift_slots の入力の誤りの順番と detail（段 → slots の数 → 時間枠ごと → 送ったものどうしの重なり → needs → 今ある時間枠との重なり）。
-- ⑥ add_shift_slots で作るもの（返り値の並び・ますと必要人数・監査の理由・オフセットの形・96 個）と、途中で失敗したら何も残らないこと、
--    例外の直し（確かめた後に持ち場が消えた 23503 → not_in_year、23514・22xxx → slots の invalid）。
-- ペルソナ（fixture）：admin・head・deputy・staff・viewer は Y1 のロール。rep は G1（Y1）の店長で Y2 の viewer、staff は G3（Y2）の店長
-- （Y2 では総務でない）、admin2 は Y2（preparing）の admin、outsider は何もない。
-- シフト・作業（fixture）：Y1 の持ち場 DU1（T-受付）・DU2（T-運搬）・DU3（T-予備）、時間枠 SL1（2027-10-15 9:00〜10:00）・SL2（10:00〜11:00）、
-- 作業 TK_STAFF（staff が担当・未着手）・TK_NONE（担当者なし・未着手）・TK_DONE（head が担当・完了）。Y2 の DU_Y2・DU_Y2B・SL_Y2・SL_Y2B・
-- TK_Y2（admin2 が担当・作業中）
begin;
\ir _helpers/personas.psql
\ir _helpers/fixture.psql

-- 作業の今の updated_at（RLS を通らない。段の表で、読めない人にも同じ引数を渡すため）
create function tests.task_ts(p_name text) returns timestamptz language sql stable security definer set search_path = '' as $$
  select t.updated_at from public.tasks t where t.id = (select i.id from tests.ids i where i.name = p_name)
$$;
grant execute on function tests.task_ts(text) to authenticated;

-- 時間枠の JSON（p_from から p_step ごとに p_n 個。Asia/Tokyo の +09:00 の ISO 8601 の文字列）
create function tests.slots_json(p_from timestamptz, p_step interval, p_n integer) returns jsonb language sql stable as $$
  select coalesce(jsonb_agg(jsonb_build_object(
           'starts_at', to_char(s at time zone 'Asia/Tokyo', 'YYYY-MM-DD"T"HH24:MI:SS') || '+09:00',
           'ends_at', to_char((s + p_step) at time zone 'Asia/Tokyo', 'YYYY-MM-DD"T"HH24:MI:SS') || '+09:00') order by s), '[]'::jsonb)
  from generate_series(p_from, p_from + p_step * (p_n - 1), p_step) s
$$;
-- 1つの時間枠・1つのます
create function tests.slot(p_starts text, p_ends text) returns jsonb language sql immutable as $$
  select jsonb_build_object('starts_at', p_starts, 'ends_at', p_ends)
$$;
create function tests.need(p_duty text, p_count integer) returns jsonb language sql stable as $$
  select jsonb_build_object('duty_id', tests.id(p_duty), 'required_count', p_count)
$$;
-- add_shift_slots を呼んだ結果（tests.error_json の形。成功した書き込みは残る）
create function tests.add_err(p_slots jsonb, p_needs jsonb default '[]'::jsonb, p_year text default 'Y1') returns jsonb language sql as $$
  select tests.error_json(format('select public.add_shift_slots(%L::uuid, %L::jsonb, %L::jsonb)', tests.id(p_year), p_slots, p_needs))
$$;
-- 送った時間枠の invalid_input（field: slots）の detail
create function tests.slots_err(p_reason text, p_ord integer default null) returns jsonb language sql immutable as $$
  select jsonb_build_object('code', 'invalid_input', 'detail',
                            jsonb_strip_nulls(jsonb_build_object('field', 'slots', 'reason', p_reason, 'ord', p_ord)))
$$;
create function tests.needs_err(p_reason text, p_ord integer default null) returns jsonb language sql immutable as $$
  select jsonb_build_object('code', 'invalid_input', 'detail',
                            jsonb_strip_nulls(jsonb_build_object('field', 'needs', 'reason', p_reason, 'ord', p_ord)))
$$;
grant execute on function tests.slots_json(timestamptz, interval, integer), tests.slot(text, text), tests.need(text, integer),
  tests.add_err(jsonb, jsonb, text), tests.slots_err(text, integer), tests.needs_err(text, integer) to authenticated;

-- ================================================================ ① 段の表
create table tests.rpc_case (n int primary key, label text not null, scenario text not null, template text not null, yn text not null);
insert into tests.rpc_case values
 -- set_task_status：総務で、その作業の担当者か部門長以上。終了の年度は変えられない（総務でない人は forbidden が先）。確定中も変えられる
 ( 1, '担当の作業（staff）を作業中にする', 'requesting',
  $t$ select public.set_task_status(:TK_STAFF, 'doing', tests.task_ts('TK_STAFF')) $t$, 'ok ok ok F F F F'),
 ( 2, '担当の作業を完了にする（準備中）', 'preparing',
  $t$ select public.set_task_status(:TK_STAFF, 'done', tests.task_ts('TK_STAFF')) $t$, 'ok ok ok F F F F'),
 ( 3, '担当の作業を完了にする（締切後）', 'requesting:after',
  $t$ select public.set_task_status(:TK_STAFF, 'done', tests.task_ts('TK_STAFF')) $t$, 'ok ok ok F F F F'),
 ( 4, '担当の作業を完了にする（振り分け中）', 'allocating',
  $t$ select public.set_task_status(:TK_STAFF, 'done', tests.task_ts('TK_STAFF')) $t$, 'ok ok ok F F F F'),
 ( 5, '担当の作業を完了にする（確定中）', 'confirmed',
  $t$ select public.set_task_status(:TK_STAFF, 'done', tests.task_ts('TK_STAFF')) $t$, 'ok ok ok F F F F'),
 ( 6, '担当の作業を完了にする（終了）', 'closed',
  $t$ select public.set_task_status(:TK_STAFF, 'done', tests.task_ts('TK_STAFF')) $t$, 'IS IS IS F F F F'),
 ( 7, '担当者のいない作業を作業中にする', 'requesting',
  $t$ select public.set_task_status(:TK_NONE, 'doing', tests.task_ts('TK_NONE')) $t$, 'ok ok F F F F F'),
 ( 8, 'ほかの人（head）が担当の完了した作業を未着手に戻す', 'requesting',
  $t$ select public.set_task_status(:TK_DONE, 'todo', tests.task_ts('TK_DONE')) $t$, 'ok ok F F F F F'),
 ( 9, '同じ状態（未着手のまま）にする', 'requesting',
  $t$ select public.set_task_status(:TK_STAFF, 'todo', tests.task_ts('TK_STAFF')) $t$, 'ok ok ok F F F F'),
 (10, 'Y2 の作業（admin2 が担当）を完了にする', 'requesting',
  $t$ select public.set_task_status(:TK_Y2, 'done', tests.task_ts('TK_Y2')) $t$, 'F F F F F F ok'),
 (11, 'ない作業', 'requesting', $t$ select public.set_task_status(gen_random_uuid(), 'doing', now()) $t$, 'F F F F F F F'),
 (12, '状態が null', 'requesting', $t$ select public.set_task_status(:TK_STAFF, null, tests.task_ts('TK_STAFF')) $t$, 'II II II F F F F'),
 (13, '版が null', 'requesting', $t$ select public.set_task_status(:TK_STAFF, 'doing', null) $t$, 'II II II F F F F'),
 (14, '古い版（担当の作業。1 ミリ秒古い）', 'requesting',
  $t$ select public.set_task_status(:TK_STAFF, 'doing', tests.task_ts('TK_STAFF') - interval '1 millisecond') $t$, 'CF CF CF F F F F'),
 (15, '古い版（担当者のいない作業。担当者の確かめが先）', 'requesting',
  $t$ select public.set_task_status(:TK_NONE, 'doing', tests.task_ts('TK_NONE') - interval '1 second') $t$, 'CF CF F F F F F'),
 (16, '状態が null（終了。年度の状態の確かめが先）', 'closed',
  $t$ select public.set_task_status(:TK_STAFF, null, tests.task_ts('TK_STAFF')) $t$, 'IS IS IS F F F F'),
 -- add_shift_slots：部門長以上（総務部門員は forbidden）。終了の年度は作れない（部門長以上でない人は forbidden が先）。確定中も作れる
 (17, '1日分を作る（時間枠だけ）', 'requesting',
  $t$ select public.add_shift_slots(:Y1, '[{"starts_at": "2027-10-16T09:00:00+09:00", "ends_at": "2027-10-16T10:00:00+09:00"}]') $t$,
  'ok ok F F F F F'),
 (18, '1日分を作る（ますも）', 'requesting',
  $t$ select public.add_shift_slots(:Y1, '[{"starts_at": "2027-10-16T09:00:00+09:00", "ends_at": "2027-10-16T10:00:00+09:00"}]',
                                     jsonb_build_array(jsonb_build_object('duty_id', :DU1, 'required_count', 2))) $t$, 'ok ok F F F F F'),
 (19, '1日分を作る（準備中）', 'preparing',
  $t$ select public.add_shift_slots(:Y1, '[{"starts_at": "2027-10-16T09:00:00+09:00", "ends_at": "2027-10-16T10:00:00+09:00"}]') $t$,
  'ok ok F F F F F'),
 (20, '1日分を作る（締切後）', 'requesting:after',
  $t$ select public.add_shift_slots(:Y1, '[{"starts_at": "2027-10-16T09:00:00+09:00", "ends_at": "2027-10-16T10:00:00+09:00"}]') $t$,
  'ok ok F F F F F'),
 (21, '1日分を作る（振り分け中）', 'allocating',
  $t$ select public.add_shift_slots(:Y1, '[{"starts_at": "2027-10-16T09:00:00+09:00", "ends_at": "2027-10-16T10:00:00+09:00"}]') $t$,
  'ok ok F F F F F'),
 (22, '1日分を作る（確定中）', 'confirmed',
  $t$ select public.add_shift_slots(:Y1, '[{"starts_at": "2027-10-16T09:00:00+09:00", "ends_at": "2027-10-16T10:00:00+09:00"}]') $t$,
  'ok ok F F F F F'),
 (23, '1日分を作る（終了）', 'closed',
  $t$ select public.add_shift_slots(:Y1, '[{"starts_at": "2027-10-16T09:00:00+09:00", "ends_at": "2027-10-16T10:00:00+09:00"}]') $t$,
  'IS IS F F F F F'),
 (24, 'Y2 に作る', 'requesting',
  $t$ select public.add_shift_slots(:Y2, '[{"starts_at": "2026-10-16T09:00:00+09:00", "ends_at": "2026-10-16T10:00:00+09:00"}]') $t$,
  'F F F F F F ok'),
 (25, 'ない年度に作る', 'requesting',
  $t$ select public.add_shift_slots(gen_random_uuid(), '[{"starts_at": "2027-10-16T09:00:00+09:00", "ends_at": "2027-10-16T10:00:00+09:00"}]') $t$,
  'F F F F F F F'),
 (26, '年度が null', 'requesting',
  $t$ select public.add_shift_slots(null, '[{"starts_at": "2027-10-16T09:00:00+09:00", "ends_at": "2027-10-16T10:00:00+09:00"}]') $t$,
  'F F F F F F F'),
 (27, '時間枠が空', 'requesting', $t$ select public.add_shift_slots(:Y1, '[]') $t$, 'II II F F F F F'),
 (28, '今ある時間枠（SL1）と重なる', 'requesting',
  $t$ select public.add_shift_slots(:Y1, '[{"starts_at": "2027-10-15T09:30:00+09:00", "ends_at": "2027-10-15T10:30:00+09:00"}]') $t$,
  'II II F F F F F'),
 (29, 'ほかの年度（Y2）の持ち場のます', 'requesting',
  $t$ select public.add_shift_slots(:Y1, '[{"starts_at": "2027-10-16T09:00:00+09:00", "ends_at": "2027-10-16T10:00:00+09:00"}]',
                                     jsonb_build_array(jsonb_build_object('duty_id', :DU_Y2, 'required_count', 1))) $t$, 'II II F F F F F'),
 (30, '時間枠が空（終了。年度の状態の確かめが先）', 'closed', $t$ select public.add_shift_slots(:Y1, '[]') $t$, 'IS IS F F F F F');

-- ペルソナと期待値の列。deputy は head の列で確かめる（総務副部門長の権限は総務部門長と同じ。D-48）
create table tests.rpc_persona (persona text primary key, col int not null, ord int not null unique);
insert into tests.rpc_persona values
  ('admin', 1, 1), ('head', 2, 2), ('deputy', 2, 3), ('staff', 3, 4), ('viewer', 4, 5), ('rep', 5, 6), ('outsider', 6, 7), ('admin2', 7, 8);

create view tests.rpc_cells as
select c.n, c.label, c.scenario, p.persona, p.ord,
       case split_part(c.yn, ' ', p.col)
         when 'F' then 'forbidden' when 'NF' then 'not_found' when 'IS' then 'invalid_state'
         when 'II' then 'invalid_input' when 'CF' then 'conflict' else split_part(c.yn, ' ', p.col) end as expected,
       tests.sql(c.template) as sql
from tests.rpc_case c cross join tests.rpc_persona p;

select plan((select count(*)::int from tests.rpc_cells) + 3 + 118);

select is_empty($$ select n, yn from tests.rpc_case
                   where array_length(string_to_array(yn, ' '), 1) <> 7
                      or exists (select 1 from unnest(string_to_array(yn, ' ')) t where t not in ('ok', 'F', 'NF', 'IS', 'II', 'CF')) $$,
  '期待値はどの行も7列（admin head staff viewer rep outsider admin2）で、略号は ok・F・NF・IS・II・CF');
select is((select string_agg(persona || '=' || col, ' ' order by ord) from tests.rpc_persona),
  'admin=1 head=2 deputy=2 staff=3 viewer=4 rep=5 outsider=6 admin2=7', 'deputy は head の列で確かめる（8人 × 7列）');

create table tests.rpc_results as
select n, label, scenario, persona, ord, expected, tests.try_rpc(persona, sql, scenario) as got from tests.rpc_cells;

select is(got, expected, format('%s [%s] %s', label, scenario, persona))
from tests.rpc_results
order by n, ord;

select is_empty($$ select h.n, h.label, h.got as head, d.got as deputy
                   from tests.rpc_results h join tests.rpc_results d using (n)
                   where h.persona = 'head' and d.persona = 'deputy' and h.got is distinct from d.got $$,
  'deputy（総務副部門長）は全部の行で head（総務部門長）と同じ結果');

-- ================================================================ ② set_task_status のエラーの順番と detail
-- 1. 段（lock_year）：作業がない・その作業の年度の総務でない → forbidden（detail なし。入力の誤りより先。作業の有無を漏らさない）。
--    終了 → invalid_state（detail は状態。入力より先）
select tests.login_as('outsider');
select is(tests.error_json(tests.sql($q$ select public.set_task_status(:TK_STAFF, null, null) $q$)), '{"code": "forbidden", "detail": null}'::jsonb,
  'その年度の総務でなければ、入力が誤っていても forbidden（detail なし）');
select tests.logout();
select tests.login_as('viewer');
select is(tests.error_json(tests.sql($q$ select public.set_task_status(:TK_STAFF, 'doing', tests.task_ts('TK_STAFF')) $q$)),
  '{"code": "forbidden", "detail": null}'::jsonb, '閲覧のみは、その年度の作業の状態を変えられない（読めもしない）');
select tests.logout();
select tests.login_as('staff');
select is(tests.error_json($q$ select public.set_task_status(gen_random_uuid(), 'doing', now()) $q$), '{"code": "forbidden", "detail": null}'::jsonb,
  'staff：ない作業 → forbidden');
select is(tests.error_json(tests.sql($q$ select public.set_task_status(:TK_Y2, 'doing', tests.task_ts('TK_Y2')) $q$)),
  '{"code": "forbidden", "detail": null}'::jsonb, 'staff：ほかの年度（Y2。総務でない年度）の作業 → ない作業と同じ forbidden（有無を漏らさない）');
select is(tests.error_json($q$ select public.set_task_status(null, 'doing', now()) $q$), '{"code": "forbidden", "detail": null}'::jsonb,
  'staff：作業が null → forbidden');
select tests.logout();
select tests.set_scenario('closed');
select tests.login_as('staff');
select is(tests.error_json(tests.sql($q$ select public.set_task_status(:TK_STAFF, null, null) $q$)),
  '{"code": "invalid_state", "detail": {"status": "closed"}}'::jsonb, '終了の年度は、入力が誤っていても invalid_state（detail は状態）');
select tests.logout();
select tests.login_as('viewer');
select is(tests.error_json(tests.sql($q$ select public.set_task_status(:TK_STAFF, 'doing', tests.task_ts('TK_STAFF')) $q$)),
  '{"code": "forbidden", "detail": null}'::jsonb, '終了の年度でも、総務でない人には forbidden（状態を漏らさない）');
select tests.logout();
select tests.set_scenario('requesting');
-- 2. 入力：status → base_updated_at の順（担当者の確かめより先）
select tests.login_as('staff');
select is(tests.error_json(tests.sql($q$ select public.set_task_status(:TK_STAFF, null, null) $q$)),
  '{"code": "invalid_input", "detail": {"field": "status"}}'::jsonb, '状態と版の両方が null → status が先');
select is(tests.error_json(tests.sql($q$ select public.set_task_status(:TK_STAFF, 'done', null) $q$)),
  '{"code": "invalid_input", "detail": {"field": "base_updated_at"}}'::jsonb, '版が null → base_updated_at');
select is(tests.error_json(tests.sql($q$ select public.set_task_status(:TK_NONE, null, now()) $q$)),
  '{"code": "invalid_input", "detail": {"field": "status"}}'::jsonb, '担当でない作業でも、入力の誤りが担当者の確かめより先');
-- 4. 担当者でも部門長以上でもない → forbidden（担当者のいない作業は部門長以上だけ。古い版でも conflict より先に forbidden）
select is(tests.error_json(tests.sql($q$ select public.set_task_status(:TK_NONE, 'doing', tests.task_ts('TK_NONE')) $q$)),
  '{"code": "forbidden", "detail": null}'::jsonb, 'staff：担当者のいない作業 → forbidden');
select is(tests.error_json(tests.sql($q$ select public.set_task_status(:TK_DONE, 'todo', tests.task_ts('TK_DONE') - interval '1 second') $q$)),
  '{"code": "forbidden", "detail": null}'::jsonb, 'staff：ほかの人（head）が担当の作業を古い版で → conflict でなく forbidden');
select tests.logout();
select is((select string_agg(t.name || ':' || x.status, ' ' order by t.name) from public.tasks x join tests.ids t on t.id = x.id
           where t.name in ('TK_STAFF', 'TK_NONE', 'TK_DONE')),
  'TK_DONE:done TK_NONE:todo TK_STAFF:todo', '止まった呼び出しは何も変えない');

-- ================================================================ ③ 楽観ロック（ミリ秒までで比べる。detail は id）と書いた中身
-- テスト全体が1つのトランザクションで now() が変わらないので、トリガーを止めてミリ秒より細かい過去の updated_at を入れる
alter table public.tasks disable trigger set_timestamps;
update public.tasks set updated_at = '2026-10-01 10:00:00.123456+09' where id = tests.id('TK_STAFF');
alter table public.tasks enable trigger set_timestamps;
select tests.login_as('staff');
select is(tests.error_json(tests.sql($q$ select public.set_task_status(:TK_STAFF, 'doing', '2026-10-01 10:00:00.124+09') $q$)),
  jsonb_build_object('code', 'conflict', 'detail', jsonb_build_object('id', tests.id('TK_STAFF'))), '版が 1 ミリ秒新しい → conflict（detail は id）');
select is(tests.error_json(tests.sql($q$ select public.set_task_status(:TK_STAFF, 'doing', '2026-10-01 10:00:00.122+09') $q$)),
  jsonb_build_object('code', 'conflict', 'detail', jsonb_build_object('id', tests.id('TK_STAFF'))), '版が 1 ミリ秒古い → conflict');
select tests.logout();
select is((select status::text from public.tasks where id = tests.id('TK_STAFF')), 'todo', 'conflict のときは何も変わらない');
select coalesce(max(id), 0) as m0 from public.audit_logs \gset
select tests.login_as('staff');
select to_jsonb(r) as saved from public.set_task_status(tests.id('TK_STAFF'), 'doing', '2026-10-01 10:00:00.123999+09') r \gset
select tests.logout();
select is((select to_jsonb(t) from public.tasks t where t.id = tests.id('TK_STAFF')), :'saved'::jsonb,
  'ミリ秒より細かい違いは見ない（同じミリ秒の版なら通る）。返り値は保存した作業の行（全部の列）');
select is((select format('%s %s %s %s', status, (created_by = tests.id('head'))::text, (updated_by = tests.id('staff'))::text, (updated_at = now())::text)
           from public.tasks where id = tests.id('TK_STAFF')),
  'doing true true true', '状態が変わり、created_by は書いた人（head）のまま、updated_by は呼んだ人（staff）、updated_at は進む');
select is((select format('%s|%s|%s|%s', title, coalesce(note, 'null'), (assignee_id = tests.id('staff'))::text, (due_at = '2027-10-10 17:00+09')::text)
           from public.tasks where id = tests.id('TK_STAFF')),
  'T-TK_STAFF|机の数を数える|true|true', '題名・説明・担当者・締切は変わらない（状態だけを書く）');
select is((select string_agg(format('%s %s %s>%s %s %s %s', table_name, action, before ->> 'status', after ->> 'status', reason,
                                    (user_id = tests.id('staff'))::text, (year_id = tests.id('Y1'))::text), ' / ')
           from public.audit_logs where id > :m0),
  'tasks update todo>doing 作業の状態 true true', '監査は作業の update だけで、理由「作業の状態」・前後の状態・呼んだ人・年度が残る');
select tests.login_as('staff');
select is(tests.error_json(tests.sql($q$ select public.set_task_status(:TK_STAFF, 'done', '2026-10-01 10:00:00.123+09') $q$)),
  jsonb_build_object('code', 'conflict', 'detail', jsonb_build_object('id', tests.id('TK_STAFF'))),
  '保存の後は、前の版（画面がミリ秒までで受け取った文字列）では conflict');
select is(tests.error_json(format($q$ select public.set_task_status(%L, 'done', %L) $q$, tests.id('TK_STAFF'), :'saved'::jsonb ->> 'updated_at')),
  '{"code": "ok"}'::jsonb, '返った updated_at の文字列を次の版にすれば、続けて変えられる（作業中 → 完了）');
select is(tests.error_json(tests.sql($q$ select public.set_task_status(:TK_STAFF, 'todo', tests.task_ts('TK_STAFF')) $q$)),
  '{"code": "ok"}'::jsonb, '完了から未着手に戻せる（どの状態からどの状態へも変えられる）');
select tests.logout();
-- 同じ状態でも書く（updated_at が進み、前の版は conflict になる）。同じ人が同じ状態にした更新は updated_at だけの変更なので監査に書かない
alter table public.tasks disable trigger set_timestamps;
update public.tasks set updated_at = '2026-10-02 09:00:00+09' where id = tests.id('TK_STAFF');
alter table public.tasks enable trigger set_timestamps;
select coalesce(max(id), 0) as m1 from public.audit_logs \gset
select tests.login_as('staff');
select is(tests.error_json(tests.sql($q$ select public.set_task_status(:TK_STAFF, 'todo', '2026-10-02 09:00:00+09') $q$)), '{"code": "ok"}'::jsonb,
  '同じ状態（未着手 → 未着手）でも通る');
select is(tests.error_json(tests.sql($q$ select public.set_task_status(:TK_STAFF, 'todo', '2026-10-02 09:00:00+09') $q$)),
  jsonb_build_object('code', 'conflict', 'detail', jsonb_build_object('id', tests.id('TK_STAFF'))),
  '同じ状態でも書いて版が進むので、同じ版でもう一度は conflict');
select tests.logout();
select is((select format('%s %s', status, (updated_at = now())::text) from public.tasks where id = tests.id('TK_STAFF')), 'todo true',
  '同じ状態でも書き、updated_at が進む');
select is((select count(*)::int from public.audit_logs where id > :m1), 0, '同じ人が同じ状態にした更新（updated_at だけの変更）は監査に書かない');
-- 部門長以上はどの作業の状態も変えられる（ほかの人が担当の作業・担当者のいない作業）
select tests.login_as('deputy');
select is(tests.error_json(tests.sql($q$ select public.set_task_status(:TK_STAFF, 'done', tests.task_ts('TK_STAFF')) $q$)), '{"code": "ok"}'::jsonb,
  '部門長以上（deputy）は、ほかの人（staff）が担当の作業の状態も変えられる');
select tests.logout();
select is((select format('%s %s %s', status, (updated_by = tests.id('deputy'))::text, (assignee_id = tests.id('staff'))::text)
           from public.tasks where id = tests.id('TK_STAFF')),
  'done true true', '直した人は deputy、担当者は staff のまま');
select is((select count(*)::int from public.audit_logs
           where id > :m1 and table_name = 'tasks' and reason = '作業の状態' and user_id = tests.id('deputy')), 1,
  '部門長以上が変えた状態も、理由「作業の状態」で監査に残る');
select tests.login_as('head');
select is(tests.error_json(tests.sql($q$ select public.set_task_status(:TK_NONE, 'done', tests.task_ts('TK_NONE')) $q$)), '{"code": "ok"}'::jsonb,
  '担当者のいない作業は、部門長以上が変えられる');
select tests.logout();
-- anon は呼べない
select tests.login_anon();
select throws_ok($q$ select public.set_task_status(gen_random_uuid(), 'done', now()) $q$, '42501', null, 'anon は set_task_status を呼べない');
select throws_ok($q$ select public.add_shift_slots(gen_random_uuid(), '[]') $q$, '42501', null, 'anon は add_shift_slots を呼べない');
select tests.logout();

-- ================================================================ ④ 担当者のロールが変わった作業と、消えた作業
-- 担当者が set_role で閲覧のみに変わった作業：本人は変えられない（その年度の総務でない。lock_year の forbidden）。部門長以上は変えられる
select tests.create_user('tk_conv');
insert into public.year_roles (year_id, user_id, role) values (tests.id('Y1'), tests.id('tk_conv'), 'staff');
with t as (insert into public.tasks (year_id, title, assignee_id) values (tests.id('Y1'), 'T-TK_CONV', tests.id('tk_conv')) returning id)
insert into tests.ids select 'TK_CONV', id from t;
select tests.login_as('tk_conv');
select is(tests.error_json(tests.sql($q$ select public.set_task_status(:TK_CONV, 'doing', tests.task_ts('TK_CONV')) $q$)), '{"code": "ok"}'::jsonb,
  '担当の総務部門員（tk_conv）は、自分の作業の状態を変えられる');
select tests.logout();
update public.year_roles set role = 'viewer' where year_id = tests.id('Y1') and user_id = tests.id('tk_conv');
select tests.login_as('tk_conv');
select is(tests.error_json(tests.sql($q$ select public.set_task_status(:TK_CONV, 'done', tests.task_ts('TK_CONV')) $q$)),
  '{"code": "forbidden", "detail": null}'::jsonb, '担当者が閲覧のみに変わると、本人はその作業の状態を変えられない（担当者の列は残る）');
select tests.logout();
select tests.login_as('head');
select is(tests.error_json(tests.sql($q$ select public.set_task_status(:TK_CONV, 'done', tests.task_ts('TK_CONV')) $q$)), '{"code": "ok"}'::jsonb,
  '担当者が総務でなくなった作業も、部門長以上は変えられる');
select tests.logout();
-- ロールを外された担当者：担当者が空になり（set null）、本人は変えられない
delete from public.year_roles where year_id = tests.id('Y1') and user_id = tests.id('tk_conv');
select is((select format('%s %s', coalesce(assignee_id::text, 'null'), status) from public.tasks where id = tests.id('TK_CONV')), 'null done',
  'ロールを外すと担当者が空になる（状態はそのまま）');
select tests.login_as('tk_conv');
select is(tests.error_json(tests.sql($q$ select public.set_task_status(:TK_CONV, 'todo', tests.task_ts('TK_CONV')) $q$)),
  '{"code": "forbidden", "detail": null}'::jsonb, 'ロールを外された人は、前に担当だった作業の状態を変えられない');
select tests.logout();
-- 年度の行のロックを待つ間に作業が消えた → not_found（呼んだ人はその年度の総務で、その作業を読めた。消えた作業の update が 0 行で黙って
-- 成功しないように。delete_notice と同じ）。2つのセッションの代わりに、このトランザクションの中だけ private.lock_year を、年度の行を
-- ロックした後に作業を消す版に置き換え、確かめた後に元の定義に戻す（最後の rollback でも戻る）
create table tests.saved_fn as
  select pg_get_functiondef('private.lock_year(uuid, public.year_status[], public.app_role[])'::regprocedure) as def;
create or replace function private.lock_year(p_year_id uuid, p_allowed public.year_status[], p_roles public.app_role[])
returns public.years language plpgsql security definer set search_path = '' as $f$
declare v public.years;
begin
  perform private.assert_role(p_year_id, p_roles);
  select * into v from public.years where id = p_year_id for no key update;
  if not found then perform private.fail('forbidden'); end if;
  perform private.assert_role(p_year_id, p_roles);
  if not (v.status = any (p_allowed)) then
    perform private.fail('invalid_state', jsonb_build_object('status', v.status));
  end if;
  -- テストだけ：年度の行をロックした後に、ほかのセッションが作業を消したことにする
  delete from public.tasks where id = nullif(current_setting('tests.vanish_task', true), '')::uuid;
  return v;
end $f$;
select set_config('tests.vanish_task', tests.id('TK_STAFF')::text, true);
select tests.login_as('staff');
select is(tests.error_json(tests.sql($q$ select public.set_task_status(:TK_STAFF, 'todo', tests.task_ts('TK_STAFF') - interval '1 day') $q$)),
  '{"code": "not_found", "detail": null}'::jsonb, '担当の作業がロックを待つ間に消えた → not_found（detail なし。古い版の conflict より先）');
select tests.logout();
select set_config('tests.vanish_task', tests.id('TK_NONE')::text, true);
select tests.login_as('staff');
select is(tests.error_json(tests.sql($q$ select public.set_task_status(:TK_NONE, 'todo', tests.task_ts('TK_NONE')) $q$)),
  '{"code": "not_found", "detail": null}'::jsonb, '担当でない作業が消えたときも not_found（担当者の確かめより先）');
select tests.logout();
select set_config('tests.vanish_task', '', true);
do $$ begin execute (select def from tests.saved_fn); end $$;
select is(pg_get_functiondef('private.lock_year(uuid, public.year_status[], public.app_role[])'::regprocedure), (select def from tests.saved_fn),
  '置き換えた lock_year を元の定義に戻した');
select is((select count(*)::int from public.tasks where id in (tests.id('TK_STAFF'), tests.id('TK_NONE'))), 2,
  '止まった呼び出しは取り消され、作業は残っている');

-- ================================================================ ⑤ add_shift_slots の入力の誤りの順番と detail（head。Y1 は受付中）
-- 1. 段（lock_year）：年度がない・その年度の部門長以上でない → forbidden（入力の誤りより先）。終了 → invalid_state（入力より先）
select tests.login_as('staff');
select is(tests.add_err('"x"', '"y"'), '{"code": "forbidden", "detail": null}'::jsonb, 'staff は、入力が誤っていても forbidden（総務部門員は作れない）');
select tests.logout();
select tests.login_as('viewer');
select is(tests.add_err('"x"', '"y"'), '{"code": "forbidden", "detail": null}'::jsonb, '閲覧のみも forbidden');
select tests.logout();
select tests.set_scenario('closed');
select tests.login_as('head');
select is(tests.add_err('"x"', '"y"'), '{"code": "invalid_state", "detail": {"status": "closed"}}'::jsonb,
  '終了の年度は、入力が誤っていても invalid_state（detail は状態）');
select tests.logout();
select tests.set_scenario('requesting');
select tests.login_as('head');
-- 2. slots の数：null・配列でない・空 → required、97 個以上 → too_many（大きな配列の中身を読む前）
select is(tests.add_err(null), tests.slots_err('required'), 'slots が null → required');
select is(tests.add_err('null'), tests.slots_err('required'), 'slots が JSON の null → required');
select is(tests.add_err('{"starts_at": "2027-10-16T09:00:00+09:00", "ends_at": "2027-10-16T10:00:00+09:00"}'), tests.slots_err('required'),
  'slots が配列でない（object） → required');
select is(tests.add_err('"x"'), tests.slots_err('required'), 'slots が文字列 → required');
select is(tests.add_err('[]'), tests.slots_err('required'), 'slots が空の配列 → required');
select is(tests.add_err((select jsonb_agg(1) from generate_series(1, 97))), tests.slots_err('too_many'),
  'slots が 97 個 → too_many（中身の形より先に数で見る）');
select is(tests.add_err((select jsonb_agg(1) from generate_series(1, 96))), tests.slots_err('invalid', 1),
  'slots が 96 個なら数は通り、中身の形で止まる');
-- 3. 時間枠ごと（送った順）：形 → 順 → 24 時間 → 日付の範囲。detail の ord は送った配列の中の番号（1 から）
select is(tests.add_err('[1]'), tests.slots_err('invalid', 1), '時間枠が object でない → invalid（ord 1）');
select is(tests.add_err('[{"starts_at": "2027-10-16T09:00:00+09:00"}]'), tests.slots_err('invalid', 1), 'ends_at がない → invalid');
select is(tests.add_err('[{"starts_at": "2027-10-16T09:00:00+09:00", "ends_at": 1}]'), tests.slots_err('invalid', 1), 'ends_at が文字列でない → invalid');
select is(tests.add_err('[{"starts_at": "2027-10-16T09:00:00", "ends_at": "2027-10-16T10:00:00"}]'), tests.slots_err('invalid', 1),
  'オフセットのない日時 → invalid（セッションのタイムゾーンで読んで 9 時間ずらさない）');
select is(tests.add_err('[{"starts_at": "2027-10-16", "ends_at": "2027-10-17"}]'), tests.slots_err('invalid', 1), '日付だけ → invalid');
select is(tests.add_err('[{"starts_at": "now", "ends_at": "infinity"}]'), tests.slots_err('invalid', 1), 'now・infinity などの特別な値 → invalid');
select is(tests.add_err('[{"starts_at": " 2027-10-16T09:00:00+09:00", "ends_at": "2027-10-16T10:00:00+09:00"}]'), tests.slots_err('invalid', 1),
  '前に空白のある日時 → invalid');
select is(tests.add_err('[{"starts_at": "2027-13-16T09:00:00+09:00", "ends_at": "2027-13-16T10:00:00+09:00"}]'), tests.slots_err('invalid', 1),
  '形は合うが読めない日時（13 月） → invalid（変換の誤りも ord つき）');
select is(tests.add_err('[{"starts_at": "2027-10-16T25:00:00+09:00", "ends_at": "2027-10-16T26:00:00+09:00"}]'), tests.slots_err('invalid', 1),
  '形は合うが読めない日時（25 時） → invalid');
select is(tests.add_err('[{"starts_at": "2027-10-16T09:00:00+99:00", "ends_at": "2027-10-16T10:00:00+99:00"}]'), tests.slots_err('invalid', 1),
  '形は合うが読めないオフセット（+99:00） → invalid');
select is(tests.add_err(jsonb_build_array(tests.slot('2027-10-16T09:00:00+09:00', '2027-10-16T10:00:00+09:00'),
                                          tests.slot('2027-10-16T10:00:00+09:00', '2027-10-16T11:00:00+09:00'),
                                          tests.slot('2027-10-16T11:00:00+09:00', '2027-10-16T12:00:00'))),
  tests.slots_err('invalid', 3), '3つ目の時間枠の形が誤り → ord 3');
select is(tests.add_err(jsonb_build_array(tests.slot('2027-10-16T09:00:00+09:00', '2027-10-16T10:00:00+09:00'),
                                          tests.slot('2027-10-16T10:00:00+09:00', '2027-13-16T11:00:00+09:00'))),
  tests.slots_err('invalid', 2), '2つ目の時間枠の日時が読めない → ord 2（変換の誤りでも、何番目かを残す）');
select is(tests.add_err('[{"starts_at": "2027-10-16T09:00:00+09:00", "ends_at": "2027-10-16T09:00:00+09:00"}]'), tests.slots_err('order', 1),
  '開始と終わりが同じ → order');
select is(tests.add_err('[{"starts_at": "2027-10-16T10:00:00+09:00", "ends_at": "2027-10-16T09:00:00+09:00"}]'), tests.slots_err('order', 1),
  '終わりが開始より前 → order');
select is(tests.add_err('[{"starts_at": "2027-10-16T09:00:00+09:00", "ends_at": "2027-10-17T09:00:01+09:00"}]'), tests.slots_err('too_long', 1),
  '24 時間より長い（1 秒） → too_long');
select is(tests.add_err('[{"starts_at": "1999-12-31T23:30:00+09:00", "ends_at": "2000-01-01T00:30:00+09:00"}]'), tests.slots_err('out_of_range', 1),
  '開始の日付（Asia/Tokyo）が 2000-01-01 より前 → out_of_range');
select is(tests.add_err('[{"starts_at": "1999-12-31T14:59:59Z", "ends_at": "1999-12-31T16:00:00Z"}]'), tests.slots_err('out_of_range', 1),
  '日付は Asia/Tokyo で見る（UTC の 1999-12-31 14:59:59 は Asia/Tokyo の 23:59:59 で範囲の外）');
select is(tests.add_err('[{"starts_at": "2200-12-31T23:30:00+09:00", "ends_at": "2201-01-01T00:30:00+09:00"}]'), tests.slots_err('out_of_range', 1),
  '終わりの日付が 2200-12-31 より後 → out_of_range');
select is(tests.add_err('[{"starts_at": "0001-01-01T00:00:00+09:00", "ends_at": "0001-01-01T01:00:00+09:00"}]'), tests.slots_err('out_of_range', 1),
  '1 年 → out_of_range');
select is(tests.add_err(jsonb_build_array(tests.slot('2027-10-16T09:00:00+09:00', '2027-10-17T10:00:00+09:00'), '1'::jsonb)),
  tests.slots_err('too_long', 1), '1つの時間枠の4つの確かめをしてから次へ進む（1つ目の too_long が、2つ目の invalid より先）');
-- 4. 送った時間枠どうしの重なり（開始の順に並べて、前の時間枠の終わりより前に始まる。ord は送った順で後のもの）
select is(tests.add_err(jsonb_build_array(tests.slot('2027-10-16T09:00:00+09:00', '2027-10-16T10:00:00+09:00'),
                                          tests.slot('2027-10-16T09:30:00+09:00', '2027-10-16T10:30:00+09:00'))),
  tests.slots_err('overlap', 2), '送った2つが重なる → overlap（ord 2）');
select is(tests.add_err(jsonb_build_array(tests.slot('2027-10-16T09:30:00+09:00', '2027-10-16T10:30:00+09:00'),
                                          tests.slot('2027-10-16T09:00:00+09:00', '2027-10-16T10:00:00+09:00'))),
  tests.slots_err('overlap', 2), '開始の遅いものを先に送っても、ord は送った順で後のもの（2）');
select is(tests.add_err(jsonb_build_array(tests.slot('2027-10-16T09:00:00+09:00', '2027-10-16T10:00:00+09:00'),
                                          tests.slot('2027-10-16T10:00:00+09:00', '2027-10-16T11:00:00+09:00'),
                                          tests.slot('2027-10-16T09:30:00+09:00', '2027-10-16T09:45:00+09:00'))),
  tests.slots_err('overlap', 3), '3つ目が1つ目の中に入る → ord 3');
select is(tests.add_err(jsonb_build_array(tests.slot('2027-10-16T09:00:00+09:00', '2027-10-16T10:00:00+09:00'),
                                          tests.slot('2027-10-16T09:00:00+09:00', '2027-10-16T09:30:00+09:00'))),
  tests.slots_err('overlap', 2), '開始が同じ2つ → overlap（ord 2）');
select is(tests.add_err(jsonb_build_array(tests.slot('2027-10-16T09:00:00+09:00', '2027-10-16T10:00:00+09:00'),
                                          tests.slot('2027-10-16T09:30:00+09:00', '2027-10-16T10:30:00+09:00'), '1'::jsonb)),
  tests.slots_err('invalid', 3), '時間枠ごとの確かめ（3つ目の形）が、送ったものどうしの重なりより先');
select is(tests.add_err(jsonb_build_array(tests.slot('2027-10-16T09:00:00+09:00', '2027-10-16T10:00:00+09:00'),
                                          tests.slot('2027-10-16T09:30:00+09:00', '2027-10-16T10:30:00+09:00')), '"x"'),
  tests.slots_err('overlap', 2), '送ったものどうしの重なりが、needs の誤りより先');
-- 5. needs（null・JSON の null は空と同じ）：配列でない → invalid、101 個以上 → too_many、要素ごとの形（全部を先に見る）→ 同じ持ち場 →
--    その年度の持ち場でない
select is(tests.add_err('[{"starts_at": "2027-10-16T09:00:00+09:00", "ends_at": "2027-10-16T10:00:00+09:00"}]', '{}'), tests.needs_err('invalid'),
  'needs が配列でない（object） → invalid（ord なし）');
select is(tests.add_err('[{"starts_at": "2027-10-16T09:00:00+09:00", "ends_at": "2027-10-16T10:00:00+09:00"}]', '"x"'), tests.needs_err('invalid'),
  'needs が文字列 → invalid');
select is(tests.add_err('[{"starts_at": "2027-10-16T09:00:00+09:00", "ends_at": "2027-10-16T10:00:00+09:00"}]',
                        (select jsonb_agg(1) from generate_series(1, 101))), tests.needs_err('too_many'),
  'needs が 101 個 → too_many（形より先に数で見る）');
select is(tests.add_err('[{"starts_at": "2027-10-16T09:00:00+09:00", "ends_at": "2027-10-16T10:00:00+09:00"}]', '[1]'), tests.needs_err('invalid', 1),
  'ますが object でない → invalid（ord 1）');
select is(tests.add_err('[{"starts_at": "2027-10-16T09:00:00+09:00", "ends_at": "2027-10-16T10:00:00+09:00"}]',
                        '[{"duty_id": 1, "required_count": 1}]'), tests.needs_err('invalid', 1), 'duty_id が文字列でない → invalid');
select is(tests.add_err('[{"starts_at": "2027-10-16T09:00:00+09:00", "ends_at": "2027-10-16T10:00:00+09:00"}]',
                        '[{"duty_id": "abc", "required_count": 1}]'), tests.needs_err('invalid', 1), 'duty_id が uuid でない → invalid（変換の誤りも ord つき）');
select is(tests.add_err('[{"starts_at": "2027-10-16T09:00:00+09:00", "ends_at": "2027-10-16T10:00:00+09:00"}]',
                        jsonb_build_array(jsonb_build_object('duty_id', tests.id('DU1')))), tests.needs_err('invalid', 1), 'required_count がない → invalid');
select is(tests.add_err('[{"starts_at": "2027-10-16T09:00:00+09:00", "ends_at": "2027-10-16T10:00:00+09:00"}]',
                        jsonb_build_array(jsonb_build_object('duty_id', tests.id('DU1'), 'required_count', '1'))), tests.needs_err('invalid', 1),
  'required_count が JSON の数でない（文字列） → invalid');
select is(tests.add_err('[{"starts_at": "2027-10-16T09:00:00+09:00", "ends_at": "2027-10-16T10:00:00+09:00"}]',
                        jsonb_build_array(jsonb_build_object('duty_id', tests.id('DU1'), 'required_count', 1.5))), tests.needs_err('invalid', 1),
  'required_count が整数でない → invalid');
select is(tests.add_err('[{"starts_at": "2027-10-16T09:00:00+09:00", "ends_at": "2027-10-16T10:00:00+09:00"}]', jsonb_build_array(tests.need('DU1', -1))),
  tests.needs_err('invalid', 1), 'required_count が -1 → invalid');
select is(tests.add_err('[{"starts_at": "2027-10-16T09:00:00+09:00", "ends_at": "2027-10-16T10:00:00+09:00"}]', jsonb_build_array(tests.need('DU1', 101))),
  tests.needs_err('invalid', 1), 'required_count が 101 → invalid');
select is(tests.add_err('[{"starts_at": "2027-10-16T09:00:00+09:00", "ends_at": "2027-10-16T10:00:00+09:00"}]',
                        jsonb_build_array(tests.need('DU1', 1), jsonb_build_object('duty_id', 'abc', 'required_count', 1))),
  tests.needs_err('invalid', 2), '2つ目のますの duty_id が読めない → ord 2');
select is(tests.add_err('[{"starts_at": "2027-10-16T09:00:00+09:00", "ends_at": "2027-10-16T10:00:00+09:00"}]',
                        jsonb_build_array(tests.need('DU1', 1), tests.need('DU2', 1), tests.need('DU1', 2))),
  tests.needs_err('duplicate', 3), '同じ持ち場が2回 → duplicate（ord は2回目の 3）');
select is(tests.add_err('[{"starts_at": "2027-10-16T09:00:00+09:00", "ends_at": "2027-10-16T10:00:00+09:00"}]',
                        jsonb_build_array(tests.need('DU1', 1), tests.need('DU2', 1), tests.need('DU2', 1), tests.need('DU1', 1))),
  tests.needs_err('duplicate', 3), '重なる持ち場が2つ → 2回目のうち送った順で最初のもの（ord 3）');
select is(tests.add_err('[{"starts_at": "2027-10-16T09:00:00+09:00", "ends_at": "2027-10-16T10:00:00+09:00"}]',
                        jsonb_build_array(tests.need('DU1', 1), tests.need('DU1', 1), '1'::jsonb)),
  tests.needs_err('invalid', 3), '要素の形を全部見てから同じ持ち場を見る（3つ目の invalid が、2つ目の duplicate より先）');
select is(tests.add_err('[{"starts_at": "2027-10-16T09:00:00+09:00", "ends_at": "2027-10-16T10:00:00+09:00"}]',
                        jsonb_build_array(tests.need('DU1', 1), tests.need('DU_Y2', 1))),
  tests.needs_err('not_in_year', 2), 'ほかの年度（Y2）の持ち場 → not_in_year（ord 2）');
select is(tests.add_err('[{"starts_at": "2027-10-16T09:00:00+09:00", "ends_at": "2027-10-16T10:00:00+09:00"}]',
                        jsonb_build_array(jsonb_build_object('duty_id', gen_random_uuid(), 'required_count', 1))),
  tests.needs_err('not_in_year', 1), 'ない持ち場 → not_in_year（ほかの年度の持ち場と同じ）');
select is(tests.add_err('[{"starts_at": "2027-10-16T09:00:00+09:00", "ends_at": "2027-10-16T10:00:00+09:00"}]',
                        jsonb_build_array(tests.need('DU_Y2', 1), tests.need('DU1', 1), tests.need('DU1', 1))),
  tests.needs_err('duplicate', 3), '同じ持ち場（duplicate）が、その年度の持ち場でない（not_in_year）より先');
-- 6. 今ある時間枠との重なり：no_overlap のトリガーの invalid_input（field: starts_at、reason: overlap、slot_id は今ある時間枠。ord なし）
select is(tests.add_err('[{"starts_at": "2027-10-15T09:30:00+09:00", "ends_at": "2027-10-15T10:30:00+09:00"}]'),
  jsonb_build_object('code', 'invalid_input', 'detail', jsonb_build_object('field', 'starts_at', 'reason', 'overlap', 'slot_id', tests.id('SL1'))),
  '今ある時間枠と重なる → field: starts_at・reason: overlap・slot_id（開始の早い SL1）');
select tests.logout();
select is((select count(*)::int from public.shift_slots where year_id = tests.id('Y1') and starts_at >= '2027-10-16 00:00+09'), 0,
  '入力の誤りで止まった呼び出しは、時間枠を1つも作っていない');

-- ================================================================ ⑥ add_shift_slots で作るもの
-- 送った順によらず、開始の早い順に作って返す。作った時間枠のすべてに、needs の持ち場のますを同じ必要人数で作る
select coalesce(max(id), 0) as m2 from public.audit_logs \gset
select tests.login_as('head');
select string_agg(to_char(r.starts_at at time zone 'Asia/Tokyo', 'MM-DD HH24:MI') || '-' || to_char(r.ends_at at time zone 'Asia/Tokyo', 'HH24:MI'),
                  ' ' order by r.ordinality) as made
from public.add_shift_slots(tests.id('Y1'),
       jsonb_build_array(tests.slot('2027-10-18T11:00:00+09:00', '2027-10-18T12:00:00+09:00'),
                         tests.slot('2027-10-18T09:00:00+09:00', '2027-10-18T10:00:00+09:00'),
                         tests.slot('2027-10-18T10:00:00+09:00', '2027-10-18T11:00:00+09:00')),
       jsonb_build_array(tests.need('DU1', 2), tests.need('DU2', 0))) with ordinality r \gset
select tests.logout();
select is(:'made'::text, '10-18 09:00-10:00 10-18 10:00-11:00 10-18 11:00-12:00',
  '返り値は作った時間枠で、開始の早い順（送った順は 11 時・9 時・10 時。隣り合う時間枠どうしはよい）');
select is((select string_agg(to_char(s.starts_at at time zone 'Asia/Tokyo', 'HH24') || ':' || d.name || '=' || n.required_count, ' '
                             order by s.starts_at, d.sort_order)
           from public.shift_needs n join public.shift_slots s on s.id = n.slot_id join public.shift_duties d on d.id = n.duty_id
           where s.year_id = tests.id('Y1') and s.starts_at >= '2027-10-18 00:00+09' and s.starts_at < '2027-10-19 00:00+09'),
  '09:T-受付=2 09:T-運搬=0 10:T-受付=2 10:T-運搬=0 11:T-受付=2 11:T-運搬=0',
  '作った3つの時間枠のすべてに、受付（2人）と運搬（0 人＝人数を決めない）のますができる');
select is((select string_agg(format('%s %s', table_name, n), ' / ' order by table_name collate "C")
           from (select table_name, count(*) n from public.audit_logs
                 where id > :m2 and action = 'insert' and reason = 'シフトの時間枠' and user_id = tests.id('head') and year_id = tests.id('Y1')
                 group by table_name) x),
  'shift_needs 6 / shift_slots 3', '時間枠3つとます6つの insert が、理由「シフトの時間枠」・呼んだ人・年度つきで監査に残る');
select is((select count(*)::int from public.audit_logs where id > :m2), 9, 'ほかの表は書かない（時間枠とますだけ）');
-- needs を省く（既定は空の配列）・JSON の null・SQL の null は、時間枠だけを作る。オフセットは Z・+0900 の形も読める
select tests.login_as('deputy');
select is(tests.error_json(format($q$ select public.add_shift_slots(%L, '[{"starts_at": "2027-10-19T00:00:00Z", "ends_at": "2027-10-19T01:00:00Z"}]') $q$,
                                  tests.id('Y1'))), '{"code": "ok"}'::jsonb, 'needs を省くと時間枠だけを作る（オフセット Z）');
select is(tests.add_err('[{"starts_at": "2027-10-19T10:00:00+0900", "ends_at": "2027-10-19T11:00:00+0900"}]', 'null'), '{"code": "ok"}'::jsonb,
  'needs が JSON の null なら時間枠だけ（オフセット +0900）');
select is(tests.add_err('[{"starts_at": "2027-10-19T11:00:00+09", "ends_at": "2027-10-19T12:00:00+09"}]', null), '{"code": "ok"}'::jsonb,
  'needs が SQL の null でも時間枠だけ（オフセット +09）');
select tests.logout();
select is((select string_agg(to_char(s.starts_at at time zone 'Asia/Tokyo', 'HH24:MI') || '-' || to_char(s.ends_at at time zone 'Asia/Tokyo', 'HH24:MI')
                             || '/' || (select count(*) from public.shift_needs n where n.slot_id = s.id), ' ' order by s.starts_at)
           from public.shift_slots s
           where s.year_id = tests.id('Y1') and s.starts_at >= '2027-10-19 00:00+09' and s.starts_at < '2027-10-20 00:00+09'),
  '09:00-10:00/0 10:00-11:00/0 11:00-12:00/0', '3つのオフセットの形がどれも Asia/Tokyo の同じ時刻になり、ますは作らない');
-- ちょうど 24 時間・0 時をまたぐ時間枠と、1回に 96 個（15 分ずつの 24 時間）
select tests.login_as('head');
select is(tests.add_err('[{"starts_at": "2027-10-20T12:00:00+09:00", "ends_at": "2027-10-21T12:00:00+09:00"}]'), '{"code": "ok"}'::jsonb,
  'ちょうど 24 時間の、0 時をまたぐ時間枠を作れる');
select is(tests.add_err(tests.slots_json('2027-10-22 00:00+09', interval '15 minutes', 96), jsonb_build_array(tests.need('DU1', 1))),
  '{"code": "ok"}'::jsonb, '1回に 96 個（15 分ずつの 24 時間）を作れる');
select tests.logout();
select is((select format('%s %s', count(*), (select count(*) from public.shift_needs n join public.shift_slots s2 on s2.id = n.slot_id
                                                where s2.year_id = tests.id('Y1') and s2.starts_at >= '2027-10-22 00:00+09'
                                                  and s2.starts_at < '2027-10-23 00:00+09'))
           from public.shift_slots s
           where s.year_id = tests.id('Y1') and s.starts_at >= '2027-10-22 00:00+09' and s.starts_at < '2027-10-23 00:00+09'),
  '96 96', '96 個の時間枠と、それぞれのますができる');
select tests.login_as('head');
select is(tests.add_err('[{"starts_at": "2026-10-15T09:00:00+09:00", "ends_at": "2026-10-15T10:00:00+09:00"}]'), '{"code": "ok"}'::jsonb,
  'ほかの年度（Y2）の時間枠（SL_Y2）と同じ時刻でも、Y1 には作れる（重なりは年度ごと）');
select tests.logout();
-- 途中で今ある時間枠と重なれば、それまでに作った時間枠とますも残らない（1つのトランザクション）
insert into public.shift_slots (year_id, starts_at, ends_at) values (tests.id('Y1'), '2027-10-24 15:00+09', '2027-10-24 16:00+09');
insert into tests.ids select 'SL_LATE', id from public.shift_slots where year_id = tests.id('Y1') and starts_at = '2027-10-24 15:00+09';
select coalesce(max(id), 0) as m3 from public.audit_logs \gset
select tests.login_as('head');
select is(tests.add_err(jsonb_build_array(tests.slot('2027-10-24T11:00:00+09:00', '2027-10-24T12:00:00+09:00'),
                                          tests.slot('2027-10-24T15:30:00+09:00', '2027-10-24T16:30:00+09:00')),
                        jsonb_build_array(tests.need('DU1', 1))),
  jsonb_build_object('code', 'invalid_input', 'detail', jsonb_build_object('field', 'starts_at', 'reason', 'overlap', 'slot_id', tests.id('SL_LATE'))),
  '2つ目が今ある時間枠（15:00〜16:00）と重なる → overlap（slot_id は今ある時間枠）');
select tests.logout();
select is((select count(*)::int from public.shift_slots where year_id = tests.id('Y1') and starts_at >= '2027-10-24 00:00+09' and starts_at < '2027-10-25 00:00+09'),
  1, '先に作った1つ目（11:00〜12:00）とそのますも残らない（今ある 15:00〜16:00 だけ）');
select is((select count(*)::int from public.audit_logs where id > :m3), 0, '失敗した呼び出しは監査に何も残さない');

-- 7. 確かめた後の変化（ふつうは起きない）：ますの insert の外部キーの違反（確かめた後に持ち場が消えた）→ needs の not_in_year（ord なし）、
--    CHECK の違反（23514）と形の誤り（22xxx）→ slots の invalid（ord なし）。どれも何も残らない。テスト用のトリガーで、時間枠・ますの insert に
--    エラーを起こす（tests.raise に「表:SQLSTATE」を置いたときだけ）
create function tests.tg_raise() returns trigger language plpgsql as $$
declare v text[] := string_to_array(nullif(current_setting('tests.raise', true), ''), ':');
begin
  if v[1] = tg_table_name then
    raise exception 'tests.raise' using errcode = v[2];
  end if;
  return new;
end $$;
create trigger zz_tests_raise before insert on public.shift_slots for each row execute function tests.tg_raise();
create trigger zz_tests_raise before insert on public.shift_needs for each row execute function tests.tg_raise();
select coalesce(max(id), 0) as m4 from public.audit_logs \gset
select set_config('tests.raise', 'shift_needs:23503', true);
select tests.login_as('head');
select is(tests.add_err(tests.slots_json('2027-10-25 09:00+09', interval '1 hour', 2), jsonb_build_array(tests.need('DU1', 1))),
  tests.needs_err('not_in_year'), 'ますの insert の外部キーの違反（確かめた後に持ち場が消えた） → needs の not_in_year（ord なし）');
select tests.logout();
select set_config('tests.raise', 'shift_slots:23514', true);
select tests.login_as('head');
select is(tests.add_err(tests.slots_json('2027-10-25 09:00+09', interval '1 hour', 2)), tests.slots_err('invalid'),
  '時間枠の insert の CHECK の違反 → slots の invalid（ord なし）');
select tests.logout();
select set_config('tests.raise', 'shift_needs:22003', true);
select tests.login_as('head');
select is(tests.add_err(tests.slots_json('2027-10-25 09:00+09', interval '1 hour', 2), jsonb_build_array(tests.need('DU1', 1))),
  tests.slots_err('invalid'), 'ますの insert の形の誤り（クラス 22） → slots の invalid');
select tests.logout();
select set_config('tests.raise', '', true);
drop trigger zz_tests_raise on public.shift_slots;
drop trigger zz_tests_raise on public.shift_needs;
select is((select count(*)::int from public.shift_slots where year_id = tests.id('Y1') and starts_at >= '2027-10-25 00:00+09' and starts_at < '2027-10-26 00:00+09'),
  0, '例外で止まった呼び出しは、時間枠もますも残さない');
select is((select count(*)::int from public.audit_logs where id > :m4), 0, '例外で止まった呼び出しは監査に何も残さない');

select * from finish();
rollback;
