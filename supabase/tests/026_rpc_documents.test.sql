-- 026_rpc_documents：提出物の RPC（T19。D-55。0016_documents.sql）
-- 期待値は 02 の「提出物の権限」と notes/T19.md の「SQL の約束」（RPC ごとのエラーの順番：1. forbidden 2. invalid_state〔終了〕
-- 3. invalid_input 4. not_found 5.〔段の forbidden は使わない〕6. invalid_state〔状態〕7. conflict）から先に書いてから流した。
-- ① 段の表：RPC を admin・head・deputy・staff・viewer・rep・rep2・outsider・admin2 で1回ずつ試して取り消す（tests.try_rpc。024・025 と同じ形）。
--    yn は列の順（admin head staff viewer rep rep2 outsider admin2）に、空白で区切った8つの結果。deputy は head の列で確かめ、実際の結果
--    どうしも比べる。略号：ok、F＝forbidden、NF＝not_found、IS＝invalid_state、II＝invalid_input、CF＝conflict。
-- ② reserve_document_file：エラーの順番と detail、path の形、冪等（送り直し）と in_use、書ける状態（店長・副店長と部門長以上）、
--    5 つまで、bucket の合計 900 MiB（届いた物は実際の大きさ、届いていない予約は申告の大きさ）
-- ③ discard_document_file：有無を漏らさない forbidden、届いた物と届いていない予約、返り値と提出の版
-- ④ submit_document・withdraw_document：楽観ロック（ミリ秒まで。行がないときの null）、ファイルの確かめ、代理の印、締切の後
-- ⑤ approve_document・return_document：紙などで受け取った承認（メモが必須・提出の日時を消す）、メモ・理由の空白と長さ
-- ⑥ 監査の理由（提出・代理の提出・取り消し・承認・差し戻し。予約と外すは null）
-- ⑦ 前年度から写す（previous_year_documents・copy_previous_documents）
-- ⑧ どの提出にも属さないファイル・使った量・年度のファイルの削除（delete_year_document_files）
-- ⑨ not_found と forbidden（読めない提出物・ファイルの有無を漏らさない）と、例外の直し（D-19。外部キー・一意・CHECK・クラス 22）
-- ペルソナ（fixture）：admin・head・deputy・staff・viewer は Y1 のロール。rep は G1（Y1。模擬店）の店長で Y2 の viewer、rep2 は G2（Y1。学科）の
-- 店長、viewer は G4（Y1。学科）の副店長も兼ねる。staff は G3（Y2。模擬店）の店長（Y2 では総務でない）。admin2 は Y2（preparing）の admin。
-- 提出物（fixture）：Y1 の DOC_STALL（模擬店・学科。ファイルが要る）・DOC_NOFILE（全区分。ファイルが要らない）・DOC_COMPANY（企業）、
-- Y2 の DOC_Y2（模擬店）。提出：(DOC_STALL, G1) 提出済み（ファイル F_G1 が届いている）、(DOC_STALL, G2) 差し戻し、(DOC_NOFILE, G4) 紙での
-- 承認、(DOC_Y2, G3) 未提出（予約 F_Y2 は届いていない）。Storage：F_G1 の物（1000 B）と、G1 のフォルダのどの提出にも属さない O_G1（500 B）。
begin;
\ir _helpers/personas.psql
\ir _helpers/fixture.psql

-- 026 だけで使うもの：飲食の団体だけの提出物（DOC_FOOD。G1 は飲食でない）、学科だけのファイルが要らない提出物（DOC_PAPER。G2・G4 が
-- 対象。行はない）と、提出済みの G1 の DOC_STALL に部門長が代わりに足した届いていない予約（F_G1B。PNG・300 B）。Y1 の複製元を Y2 にする
-- （前年度から写す。1日目の差は 365 日）
with d as (
  insert into public.documents (year_id, title, deadline, target_categories, food_only, requires_file, created_by, updated_by) values
    (tests.id('Y1'), 'T-DOC_FOOD', '2027-10-04 12:00+09', '{stall}', true, true, tests.id('admin'), tests.id('admin')),
    (tests.id('Y1'), 'T-DOC_PAPER', '2027-10-06 12:00+09', '{department}', false, false, tests.id('admin'), tests.id('admin'))
  returning id, title)
insert into tests.ids select substr(title, 3), id from d;
insert into tests.ids values ('F_G1B', gen_random_uuid());
insert into public.document_files (id, year_id, document_id, group_id, object_path, content_type, size, created_by)
values (tests.id('F_G1B'), tests.id('Y1'), tests.id('DOC_STALL'), tests.id('G1'),
        tests.id('Y1') || '/' || tests.id('G1') || '/' || tests.id('DOC_STALL') || '/' || tests.id('F_G1B') || '.png', 'image/png', 300, tests.id('head'));
update public.years set prev_year_id = tests.id('Y2') where id = tests.id('Y1');
-- 版（楽観ロック）：テスト全体が1つのトランザクションで now() が変わらないので、set_timestamps を止めて、fixture の提出の updated_at を
-- 過去の別々の日時（マイクロ秒つき）にしておく
alter table public.document_submissions disable trigger set_timestamps;
update public.document_submissions s set updated_at = v.ts
from (values ('DOC_STALL', 'G1', timestamptz '2027-01-01 00:00:00.123456+00'), ('DOC_STALL', 'G2', '2027-01-02 00:00:00.654321+00'),
             ('DOC_NOFILE', 'G4', '2027-01-03 00:00:00.5+00'), ('DOC_Y2', 'G3', '2027-01-04 00:00:00.000999+00')) v(d, g, ts)
where s.document_id = tests.id(v.d) and s.group_id = tests.id(v.g);
alter table public.document_submissions enable trigger set_timestamps;

-- 提出の今の updated_at（RLS を通らない。段の表で、読めない人にも同じ引数を渡すため）
create function tests.sub_ts(p_doc text, p_group text) returns timestamptz language sql stable security definer set search_path = '' as $$
  select s.updated_at from public.document_submissions s
  where s.document_id = (select t.id from tests.ids t where t.name = p_doc) and s.group_id = (select t.id from tests.ids t where t.name = p_group)
$$;
-- Storage の path（{year_id}/{group_id}/{document_id}/{file_id}.{pdf|jpg|png}）
create function tests.doc_path(p_year text, p_group text, p_doc text, p_file text, p_ext text default 'pdf') returns text language sql stable as $$
  select tests.id(p_year) || '/' || tests.id(p_group) || '/' || tests.id(p_doc) || '/' || tests.id(p_file) || '.' || p_ext
$$;
-- id の名前（tests.ids にあれば）
create function tests.name_of(p_id uuid) returns text language sql stable as $$
  select coalesce((select t.name from tests.ids t where t.id = p_id), p_id::text)
$$;
-- path の4つ目のフォルダ（ファイルの id）の名前
create function tests.path_name(p_path text) returns text language sql stable as $$
  select coalesce((select t.name from tests.ids t where t.id::text = split_part(split_part(p_path, '/', 4), '.', 1)), p_path)
$$;
-- 期待するエラーの文字列（コードと、キーの順によらない detail の JSON）
create function tests.e(p_code text, p_detail text default null) returns text language sql immutable as $$
  select p_code || coalesce(' ' || p_detail::jsonb::text, '')
$$;
-- JavaScript の String.prototype.trim が除く 25 文字（025 と同じ。0016 の review_note の CHECK と RPC の c_space はこの文字を除く）
create function tests.js_space() returns text language sql immutable as $$
  select string_agg(chr(c), '' order by c)
  from unnest(array[0x09, 0x0a, 0x0b, 0x0c, 0x0d, 0x20, 0xa0, 0x1680, 0x2000, 0x2001, 0x2002, 0x2003, 0x2004, 0x2005, 0x2006, 0x2007,
                    0x2008, 0x2009, 0x200a, 0x2028, 0x2029, 0x202f, 0x205f, 0x3000, 0xfeff]) c
$$;
grant execute on function tests.sub_ts(text, text), tests.doc_path(text, text, text, text, text), tests.name_of(uuid), tests.path_name(text),
  tests.e(text, text), tests.js_space() to authenticated;
-- ペルソナに切り替えて SQL を1回試し、最初の列か、エラー（コードと detail）を返して取り消す。p_setup は先に postgres で流す（一緒に取り消す）。
-- :Y1 などの名前は id に置き換える。P0001 でないエラーは error:<SQLSTATE>
create function tests.q(p_persona text, p_sql text, p_setup text default null) returns text language plpgsql as $$
declare v text; d text;
begin
  begin
    if p_setup is not null then execute tests.sql(p_setup); end if;
    if p_persona = 'anon' then perform tests.login_anon(); elsif p_persona is not null then perform tests.login_as(p_persona); end if;
    execute tests.sql(p_sql) into v;
    raise exception using errcode = 'TT001';
  exception
    when sqlstate 'TT001' then null;
    when sqlstate 'P0001' then
      get stacked diagnostics d = pg_exception_detail;
      v := sqlerrm || coalesce(' ' || nullif(d, '')::jsonb::text, '');
    when others then v := 'error:' || sqlstate;
  end;
  return v;
end $$;
-- ペルソナで SQL を流して結果を残す（外のトランザクションの中。失敗した文だけ取り消す）。返り値は tests.q と同じ形
create function tests.run(p_persona text, p_sql text) returns text language plpgsql as $$
declare v text; d text;
begin
  begin
    if p_persona is not null then perform tests.login_as(p_persona); end if;
    execute tests.sql(p_sql) into v;
  exception
    when sqlstate 'P0001' then
      get stacked diagnostics d = pg_exception_detail;
      v := sqlerrm || coalesce(' ' || nullif(d, '')::jsonb::text, '');
    when others then v := 'error:' || sqlstate;
  end;
  perform tests.logout();
  return v;
end $$;
-- 監査の行（提出物の3表）を「表 操作 理由」で並べる（id が p_mark より後のもの）
create function tests.audit_since(p_mark bigint) returns text language sql stable as $$
  select coalesce(string_agg(format('%s %s %s', a.table_name, a.action, coalesce(a.reason, 'null')), ', ' order by a.id), '')
  from public.audit_logs a
  where a.id > p_mark and a.table_name in ('documents', 'document_submissions', 'document_files')
$$;

-- ================================================================ ① 段の表
create table tests.rpc_case (n int primary key, label text not null, scenario text not null, template text not null, yn text not null);
insert into tests.rpc_case values
 -- 予約：部門長以上は承認でない提出に（代理）、店長・副店長は自団体の未提出・差し戻しに。終了の年度は読むだけ（呼べない人は forbidden が先）
 ( 1, 'G1 の DOC_NOFILE（行なし＝未提出）にファイルを足す', 'requesting',
  $t$ select public.reserve_document_file(:DOC_NOFILE, :G1, gen_random_uuid(), 'application/pdf', 100) $t$, 'ok ok F F ok F F F'),
 ( 2, 'G1 の DOC_NOFILE にファイルを足す（準備中）', 'preparing',
  $t$ select public.reserve_document_file(:DOC_NOFILE, :G1, gen_random_uuid(), 'application/pdf', 100) $t$, 'ok ok F F ok F F F'),
 ( 3, 'G1 の DOC_NOFILE にファイルを足す（締切後）', 'requesting:after',
  $t$ select public.reserve_document_file(:DOC_NOFILE, :G1, gen_random_uuid(), 'application/pdf', 100) $t$, 'ok ok F F ok F F F'),
 ( 4, 'G1 の DOC_NOFILE にファイルを足す（振り分け中）', 'allocating',
  $t$ select public.reserve_document_file(:DOC_NOFILE, :G1, gen_random_uuid(), 'application/pdf', 100) $t$, 'ok ok F F ok F F F'),
 ( 5, 'G1 の DOC_NOFILE にファイルを足す（確定中）', 'confirmed',
  $t$ select public.reserve_document_file(:DOC_NOFILE, :G1, gen_random_uuid(), 'application/pdf', 100) $t$, 'ok ok F F ok F F F'),
 ( 6, 'G1 の DOC_NOFILE にファイルを足す（終了）', 'closed',
  $t$ select public.reserve_document_file(:DOC_NOFILE, :G1, gen_random_uuid(), 'application/pdf', 100) $t$, 'IS IS F F IS F F F'),
 ( 7, '提出済みの G1 の DOC_STALL にファイルを足す（部門長以上は代理）', 'requesting',
  $t$ select public.reserve_document_file(:DOC_STALL, :G1, gen_random_uuid(), 'application/pdf', 100) $t$, 'ok ok F F IS F F F'),
 ( 8, '差し戻しの G2 の DOC_STALL にファイルを足す', 'requesting',
  $t$ select public.reserve_document_file(:DOC_STALL, :G2, gen_random_uuid(), 'application/pdf', 100) $t$, 'ok ok F F F ok F F'),
 ( 9, 'G4（viewer が副店長）の DOC_STALL にファイルを足す', 'requesting',
  $t$ select public.reserve_document_file(:DOC_STALL, :G4, gen_random_uuid(), 'image/jpeg', 100) $t$, 'ok ok F ok F F F F'),
 (10, '承認の G4 の DOC_NOFILE にファイルを足す', 'requesting',
  $t$ select public.reserve_document_file(:DOC_NOFILE, :G4, gen_random_uuid(), 'application/pdf', 100) $t$, 'IS IS F IS F F F F'),
 (11, '対象でない提出物（企業。G1 の DOC_COMPANY）にファイルを足す', 'requesting',
  $t$ select public.reserve_document_file(:DOC_COMPANY, :G1, gen_random_uuid(), 'application/pdf', 100) $t$, 'NF NF F F NF F F F'),
 (12, '飲食だけの提出物（G1 は飲食でない）にファイルを足す', 'requesting',
  $t$ select public.reserve_document_file(:DOC_FOOD, :G1, gen_random_uuid(), 'application/pdf', 100) $t$, 'NF NF F F NF F F F'),
 (13, 'Y2 の G3 の DOC_Y2 にファイルを足す', 'requesting',
  $t$ select public.reserve_document_file(:DOC_Y2, :G3, gen_random_uuid(), 'application/pdf', 100) $t$, 'F F ok F F F F ok'),
 (14, 'Y1 の提出物を Y2 の団体（G3）として足す', 'requesting',
  $t$ select public.reserve_document_file(:DOC_STALL, :G3, gen_random_uuid(), 'application/pdf', 100) $t$, 'F F NF F F F F NF'),
 -- 外す：ファイルの行がない・呼べない人は forbidden（有無を漏らさない）。届いた物は書ける状態のときだけ、届いていない予約は状態によらない
 (15, '届いた F_G1（提出済みの G1）を外す', 'requesting', $t$ select public.discard_document_file(:F_G1) $t$, 'ok ok F F IS F F F'),
 (16, '届いた F_G1 を外す（終了）', 'closed', $t$ select public.discard_document_file(:F_G1) $t$, 'IS IS F F IS F F F'),
 (17, '届いていない F_G1B（提出済みの G1。部門長の代理の予約）を外す', 'requesting', $t$ select public.discard_document_file(:F_G1B) $t$, 'ok ok F F ok F F F'),
 (18, '届いていない F_Y2（Y2 の G3）を外す', 'requesting', $t$ select public.discard_document_file(:F_Y2) $t$, 'F F ok F F F F ok'),
 (19, 'ないファイルを外す', 'requesting', $t$ select public.discard_document_file(gen_random_uuid()) $t$, 'F F F F F F F F'),
 -- 「提出した」：店長・副店長と部門長以上（代理）。未提出・差し戻しから。ファイルが要る提出物はファイルが要り、付けたファイルは届いていること
 (20, 'G1 の DOC_NOFILE（行なし。版 null）を出す', 'requesting', $t$ select public.submit_document(:DOC_NOFILE, :G1, null) $t$, 'ok ok F F ok F F F'),
 (21, 'G1 の DOC_NOFILE を出す（確定中）', 'confirmed', $t$ select public.submit_document(:DOC_NOFILE, :G1, null) $t$, 'ok ok F F ok F F F'),
 (22, 'G1 の DOC_NOFILE を出す（終了）', 'closed', $t$ select public.submit_document(:DOC_NOFILE, :G1, null) $t$, 'IS IS F F IS F F F'),
 (23, 'G2 の DOC_STALL（差し戻し。ファイルなし）を出す', 'requesting',
  $t$ select public.submit_document(:DOC_STALL, :G2, tests.sub_ts('DOC_STALL', 'G2')) $t$, 'IS IS F F F IS F F'),
 (24, 'G1 の DOC_STALL（提出済み）をもう一度出す', 'requesting',
  $t$ select public.submit_document(:DOC_STALL, :G1, tests.sub_ts('DOC_STALL', 'G1')) $t$, 'IS IS F F IS F F F'),
 (25, 'G1 の DOC_NOFILE（行なし）に版を渡して出す', 'requesting',
  $t$ select public.submit_document(:DOC_NOFILE, :G1, '2000-01-01') $t$, 'CF CF F F CF F F F'),
 (26, 'G3 の DOC_Y2（届いていない予約がある）を出す', 'requesting',
  $t$ select public.submit_document(:DOC_Y2, :G3, tests.sub_ts('DOC_Y2', 'G3')) $t$, 'F F IS F F F F IS'),
 (27, 'G1 の DOC_COMPANY（対象でない）を出す', 'requesting', $t$ select public.submit_document(:DOC_COMPANY, :G1, null) $t$, 'NF NF F F NF F F F'),
 (28, 'G4 の DOC_STALL（行なし。ファイルが要る）を出す', 'requesting', $t$ select public.submit_document(:DOC_STALL, :G4, null) $t$, 'IS IS F IS F F F F'),
 -- 取り消す：提出済みだけ（Q13）。版は要る
 (29, 'G1 の DOC_STALL（提出済み）を取り消す', 'requesting',
  $t$ select public.withdraw_document(:DOC_STALL, :G1, tests.sub_ts('DOC_STALL', 'G1')) $t$, 'ok ok F F ok F F F'),
 (30, 'G1 の DOC_STALL を取り消す（終了）', 'closed',
  $t$ select public.withdraw_document(:DOC_STALL, :G1, tests.sub_ts('DOC_STALL', 'G1')) $t$, 'IS IS F F IS F F F'),
 (31, 'G2 の DOC_STALL（差し戻し）を取り消す', 'requesting',
  $t$ select public.withdraw_document(:DOC_STALL, :G2, tests.sub_ts('DOC_STALL', 'G2')) $t$, 'IS IS F F F IS F F'),
 (32, 'G1 の DOC_STALL を古い版で取り消す', 'requesting',
  $t$ select public.withdraw_document(:DOC_STALL, :G1, tests.sub_ts('DOC_STALL', 'G1') - interval '1 second') $t$, 'CF CF F F CF F F F'),
 (33, 'G1 の DOC_STALL を版なしで取り消す', 'requesting', $t$ select public.withdraw_document(:DOC_STALL, :G1, null) $t$, 'II II F F II F F F'),
 -- 承認：部門長以上だけ。未提出・差し戻しからの承認（紙など）はメモが必須（状態を見た後の invalid_input）
 (34, 'G1 の DOC_STALL（提出済み）を承認する', 'requesting',
  $t$ select public.approve_document(:DOC_STALL, :G1, null, tests.sub_ts('DOC_STALL', 'G1')) $t$, 'ok ok F F F F F F'),
 (35, 'G1 の DOC_STALL を承認する（確定中）', 'confirmed',
  $t$ select public.approve_document(:DOC_STALL, :G1, null, tests.sub_ts('DOC_STALL', 'G1')) $t$, 'ok ok F F F F F F'),
 (36, 'G1 の DOC_STALL を承認する（終了）', 'closed',
  $t$ select public.approve_document(:DOC_STALL, :G1, null, tests.sub_ts('DOC_STALL', 'G1')) $t$, 'IS IS F F F F F F'),
 (37, 'G2 の DOC_STALL（差し戻し）をメモなしで承認する', 'requesting',
  $t$ select public.approve_document(:DOC_STALL, :G2, null, tests.sub_ts('DOC_STALL', 'G2')) $t$, 'II II F F F F F F'),
 (38, 'G2 の DOC_STALL（差し戻し）を紙で受け取って承認する（メモ）', 'requesting',
  $t$ select public.approve_document(:DOC_STALL, :G2, 'T-紙', tests.sub_ts('DOC_STALL', 'G2')) $t$, 'ok ok F F F F F F'),
 (39, 'G4 の DOC_NOFILE（承認）をもう一度承認する', 'requesting',
  $t$ select public.approve_document(:DOC_NOFILE, :G4, 'T-紙', tests.sub_ts('DOC_NOFILE', 'G4')) $t$, 'IS IS F F F F F F'),
 (40, 'G1 の DOC_STALL を古い版で承認する', 'requesting',
  $t$ select public.approve_document(:DOC_STALL, :G1, null, tests.sub_ts('DOC_STALL', 'G1') - interval '1 second') $t$, 'CF CF F F F F F F'),
 (41, 'G1 の DOC_NOFILE（行なし）を紙で受け取って承認する', 'requesting',
  $t$ select public.approve_document(:DOC_NOFILE, :G1, 'T-紙', null) $t$, 'ok ok F F F F F F'),
 (42, 'Y2 の G3 の DOC_Y2 を紙で受け取って承認する', 'requesting',
  $t$ select public.approve_document(:DOC_Y2, :G3, 'T-紙', tests.sub_ts('DOC_Y2', 'G3')) $t$, 'F F F F F F F ok'),
 -- 差し戻し：部門長以上だけ。提出済み・承認・差し戻しから（理由は必須）
 (43, 'G1 の DOC_STALL（提出済み）を差し戻す', 'requesting',
  $t$ select public.return_document(:DOC_STALL, :G1, 'T-理由', tests.sub_ts('DOC_STALL', 'G1')) $t$, 'ok ok F F F F F F'),
 (44, 'G1 の DOC_STALL を差し戻す（終了）', 'closed',
  $t$ select public.return_document(:DOC_STALL, :G1, 'T-理由', tests.sub_ts('DOC_STALL', 'G1')) $t$, 'IS IS F F F F F F'),
 (45, 'G4 の DOC_NOFILE（承認）を差し戻す', 'requesting',
  $t$ select public.return_document(:DOC_NOFILE, :G4, 'T-理由', tests.sub_ts('DOC_NOFILE', 'G4')) $t$, 'ok ok F F F F F F'),
 (46, 'G2 の DOC_STALL（差し戻し）の理由を書き直す', 'requesting',
  $t$ select public.return_document(:DOC_STALL, :G2, 'T-理由2', tests.sub_ts('DOC_STALL', 'G2')) $t$, 'ok ok F F F F F F'),
 (47, 'G1 の DOC_NOFILE（行なし＝未提出）を差し戻す', 'requesting',
  $t$ select public.return_document(:DOC_NOFILE, :G1, 'T-理由', now()) $t$, 'IS IS F F F F F F'),
 (48, 'G1 の DOC_STALL を理由なしで差し戻す', 'requesting',
  $t$ select public.return_document(:DOC_STALL, :G1, null, tests.sub_ts('DOC_STALL', 'G1')) $t$, 'II II F F F F F F'),
 (49, 'G1 の DOC_STALL を古い版で差し戻す', 'requesting',
  $t$ select public.return_document(:DOC_STALL, :G1, 'T-理由', tests.sub_ts('DOC_STALL', 'G1') - interval '1 second') $t$, 'CF CF F F F F F F'),
 -- 前年度から写す：部門長以上。読むのは年度の状態によらない。写すのは終了でない年度
 (50, 'Y1 の前年度（Y2）の提出物を読む', 'requesting', $t$ select count(*) from public.previous_year_documents(:Y1) $t$, 'ok ok F F F F F F'),
 (51, 'Y1 の前年度の提出物を読む（終了）', 'closed', $t$ select count(*) from public.previous_year_documents(:Y1) $t$, 'ok ok F F F F F F'),
 (52, 'Y2 の前年度（なし）の提出物を読む', 'requesting', $t$ select count(*) from public.previous_year_documents(:Y2) $t$, 'F F F F F F F ok'),
 (53, 'DOC_Y2 を Y1 に写す', 'requesting', $t$ select count(*) from public.copy_previous_documents(:Y1, array[:DOC_Y2]) $t$, 'ok ok F F F F F F'),
 (54, 'DOC_Y2 を Y1 に写す（確定中）', 'confirmed', $t$ select count(*) from public.copy_previous_documents(:Y1, array[:DOC_Y2]) $t$, 'ok ok F F F F F F'),
 (55, 'DOC_Y2 を Y1 に写す（終了）', 'closed', $t$ select count(*) from public.copy_previous_documents(:Y1, array[:DOC_Y2]) $t$, 'IS IS F F F F F F'),
 -- 年度のファイルの削除：管理者だけ、終了の年度だけ（Q3）
 (56, 'Y1（受付中）のファイルを全部消す', 'requesting', $t$ select public.delete_year_document_files(:Y1) $t$, 'IS F F F F F F F'),
 (57, 'Y1（終了）のファイルを全部消す', 'closed', $t$ select public.delete_year_document_files(:Y1) $t$, 'ok F F F F F F F'),
 (58, 'Y2（準備中）のファイルを全部消す', 'requesting', $t$ select public.delete_year_document_files(:Y2) $t$, 'F F F F F F F IS'),
 -- どの提出にも属さないファイルの path：部門長以上と、その年度の団体の店長・副店長（読み取りだけ。終了の年度も）
 (59, 'Y1 のどの提出にも属さないファイルの path を読む', 'requesting', $t$ select count(*) from public.document_orphan_paths(:Y1) $t$, 'ok ok F ok ok ok F F'),
 (60, 'Y1 のどの提出にも属さないファイルの path を読む（終了）', 'closed', $t$ select count(*) from public.document_orphan_paths(:Y1) $t$, 'ok ok F ok ok ok F F'),
 (61, 'Y2 のどの提出にも属さないファイルの path を読む', 'requesting', $t$ select count(*) from public.document_orphan_paths(:Y2) $t$, 'F F ok F F F F ok'),
 -- 使った量：部門長以上（読み取りだけ。終了の年度も）
 (62, 'Y1 の使った量を読む', 'requesting', $t$ select bucket_bytes from public.document_storage_usage(:Y1) $t$, 'ok ok F F F F F F'),
 (63, 'Y1 の使った量を読む（終了）', 'closed', $t$ select bucket_bytes from public.document_storage_usage(:Y1) $t$, 'ok ok F F F F F F'),
 (64, 'Y2 の使った量を読む', 'requesting', $t$ select bucket_bytes from public.document_storage_usage(:Y2) $t$, 'F F F F F F F ok');

-- ペルソナと期待値の列。deputy は head の列で確かめる（総務副部門長の権限は総務部門長と同じ。D-48）
create table tests.rpc_persona (persona text primary key, col int not null, ord int not null unique);
insert into tests.rpc_persona values
  ('admin', 1, 1), ('head', 2, 2), ('deputy', 2, 3), ('staff', 3, 4), ('viewer', 4, 5), ('rep', 5, 6), ('rep2', 6, 7), ('outsider', 7, 8),
  ('admin2', 8, 9);

create view tests.rpc_cells as
select c.n, c.label, c.scenario, p.persona, p.ord,
       case split_part(c.yn, ' ', p.col)
         when 'F' then 'forbidden' when 'NF' then 'not_found' when 'IS' then 'invalid_state'
         when 'II' then 'invalid_input' when 'CF' then 'conflict' else split_part(c.yn, ' ', p.col) end as expected,
       tests.sql(c.template) as sql
from tests.rpc_case c cross join tests.rpc_persona p;

select plan((select count(*)::int from tests.rpc_cells) + 3 + 217);

select is_empty($$ select n, yn from tests.rpc_case
                   where array_length(string_to_array(yn, ' '), 1) <> 8
                      or exists (select 1 from unnest(string_to_array(yn, ' ')) t where t not in ('ok', 'F', 'NF', 'IS', 'II', 'CF')) $$,
  '期待値はどの行も8列（admin head staff viewer rep rep2 outsider admin2）で、略号は ok・F・NF・IS・II・CF');
select is((select string_agg(persona || '=' || col, ' ' order by ord) from tests.rpc_persona),
  'admin=1 head=2 deputy=2 staff=3 viewer=4 rep=5 rep2=6 outsider=7 admin2=8', 'deputy は head の列で確かめる（9人 × 8列）');

create table tests.rpc_results as
select n, label, scenario, persona, ord, expected, tests.try_rpc(persona, sql, scenario) as got from tests.rpc_cells;

select is(got, expected, format('%s [%s] %s', label, scenario, persona))
from tests.rpc_results
order by n, ord;

select is_empty($$ select h.n, h.label, h.got as head, d.got as deputy
                   from tests.rpc_results h join tests.rpc_results d using (n)
                   where h.persona = 'head' and d.persona = 'deputy' and h.got is distinct from d.got $$,
  'deputy（総務副部門長）は全部の行で head（総務部門長）と同じ結果');

-- ================================================================ ② reserve_document_file
-- 1. forbidden：団体がない・呼べない人（入力が誤っていても先に）。終了 → invalid_state（入力より先）。呼べない人は終了でも forbidden
select is(tests.q('outsider', $q$ select (public.reserve_document_file(null, :G1, null, 'image/gif', 0)).id $q$), 'forbidden',
  '予約：呼べない人は、入力が誤っていても forbidden（detail なし）');
select is(tests.q('rep', $q$ select (public.reserve_document_file(:DOC_NOFILE, null, gen_random_uuid(), 'application/pdf', 10)).id $q$), 'forbidden',
  '予約：団体が null なら forbidden');
select is(tests.q('rep', $q$ select (public.reserve_document_file(:DOC_NOFILE, gen_random_uuid(), gen_random_uuid(), 'application/pdf', 10)).id $q$), 'forbidden',
  '予約：ない団体なら forbidden');
select is(tests.q('rep', $q$ select (public.reserve_document_file(:DOC_STALL, :G2, gen_random_uuid(), 'application/pdf', 10)).id $q$), 'forbidden',
  '予約：店長はほかの団体（G2）に足せない');
select is(tests.q('staff', $q$ select (public.reserve_document_file(:DOC_NOFILE, :G1, gen_random_uuid(), 'application/pdf', 10)).id $q$,
                  $q$ select tests.set_scenario('closed') $q$), 'forbidden', '予約：呼べない人（部門員）は、終了の年度でも forbidden（終了より先）');
select is(tests.q('rep', $q$ select (public.reserve_document_file(null, :G1, null, 'image/gif', 0)).id $q$, $q$ select tests.set_scenario('closed') $q$),
  tests.e('invalid_state', '{"status": "closed"}'), '予約：終了の年度は、入力が誤っていても invalid_state（detail は状態）');
-- 3. 入力：document_id → file_id → content_type → size → file_id（in_use）の順
select is(tests.q('rep', $q$ select (public.reserve_document_file(null, :G1, null, 'image/gif', 0)).id $q$),
  tests.e('invalid_input', '{"field": "document_id"}'), '予約：提出物が null → document_id（ほかの誤りより先）');
select is(tests.q('rep', $q$ select (public.reserve_document_file(:DOC_NOFILE, :G1, null, 'image/gif', 0)).id $q$),
  tests.e('invalid_input', '{"field": "file_id"}'), '予約：ファイルの id が null → file_id（形・大きさより先）');
select is(tests.q('rep', $q$ select (public.reserve_document_file(:DOC_NOFILE, :G1, gen_random_uuid(), 'image/gif', 0)).id $q$),
  tests.e('invalid_input', '{"field": "content_type"}'), '予約：GIF → content_type（大きさより先）');
select is(tests.q('rep', $q$ select (public.reserve_document_file(:DOC_NOFILE, :G1, gen_random_uuid(), null, 10)).id $q$),
  tests.e('invalid_input', '{"field": "content_type"}'), '予約：形が null → content_type');
select is(tests.q('rep', $q$ select (public.reserve_document_file(:DOC_NOFILE, :G1, gen_random_uuid(), 'application/PDF', 10)).id $q$),
  tests.e('invalid_input', '{"field": "content_type"}'), '予約：形は小文字の名前だけ（application/PDF は通らない）');
select is(tests.q('rep', $q$ select (public.reserve_document_file(:DOC_NOFILE, :G1, gen_random_uuid(), 'image/jpg', 10)).id $q$),
  tests.e('invalid_input', '{"field": "content_type"}'), '予約：image/jpg は通らない（image/jpeg だけ）');
select is(tests.q('rep', $q$ select (public.reserve_document_file(:DOC_NOFILE, :G1, gen_random_uuid(), 'application/pdf', 0)).id $q$),
  tests.e('invalid_input', '{"field": "size"}'), '予約：大きさ 0 → size');
select is(tests.q('rep', $q$ select (public.reserve_document_file(:DOC_NOFILE, :G1, gen_random_uuid(), 'application/pdf', -1)).id $q$),
  tests.e('invalid_input', '{"field": "size"}'), '予約：大きさが負 → size');
select is(tests.q('rep', $q$ select (public.reserve_document_file(:DOC_NOFILE, :G1, gen_random_uuid(), 'application/pdf', 10485761)).id $q$),
  tests.e('invalid_input', '{"field": "size"}'), '予約：10 MiB を 1 B 超える → size');
select is(tests.q('rep', $q$ select (public.reserve_document_file(:DOC_NOFILE, :G1, gen_random_uuid(), 'application/pdf', null)).id $q$),
  tests.e('invalid_input', '{"field": "size"}'), '予約：大きさが null → size');
select is(tests.q('rep', $q$ select (public.reserve_document_file(:DOC_NOFILE, :G1, gen_random_uuid(), 'application/pdf', 10485760)).size $q$),
  '10485760', '予約：10 MiB ちょうどは通る');
select is(tests.q('rep', $q$ select (public.reserve_document_file(:DOC_NOFILE, :G1, :F_G1, 'application/pdf', 1000)).id $q$),
  tests.e('invalid_input', '{"field": "file_id", "reason": "in_use"}'), '予約：同じ id のファイルがほかの提出物にある → in_use');
select is(tests.q('rep', $q$ select (public.reserve_document_file(:DOC_STALL, :G1, :F_G1, 'application/pdf', 999)).id $q$),
  tests.e('invalid_input', '{"field": "file_id", "reason": "in_use"}'), '予約：同じ id で大きさが違う → in_use');
select is(tests.q('rep', $q$ select (public.reserve_document_file(:DOC_STALL, :G1, :F_G1, 'image/png', 1000)).id $q$),
  tests.e('invalid_input', '{"field": "file_id", "reason": "in_use"}'), '予約：同じ id で形が違う → in_use');
select is(tests.q('head', $q$ select (public.reserve_document_file(:DOC_STALL, :G2, :F_G1, 'application/pdf', 1000)).id $q$),
  tests.e('invalid_input', '{"field": "file_id", "reason": "in_use"}'), '予約：同じ id のファイルがほかの団体にある → in_use');
select is(tests.q('rep', $q$ select (public.reserve_document_file(:DOC_COMPANY, :G1, :F_G1, 'application/pdf', 1000)).id $q$),
  tests.e('invalid_input', '{"field": "file_id", "reason": "in_use"}'), '予約：in_use は not_found より先（入力の確かめの最後）');
-- 4. not_found：その年度にない提出物・団体が対象でない提出物（detail なし）
select is(tests.q('rep', $q$ select (public.reserve_document_file(:DOC_COMPANY, :G1, gen_random_uuid(), 'application/pdf', 10)).id $q$),
  'not_found', '予約：対象の区分でない提出物 → not_found');
select is(tests.q('rep', $q$ select (public.reserve_document_file(:DOC_FOOD, :G1, gen_random_uuid(), 'application/pdf', 10)).id $q$),
  'not_found', '予約：飲食だけの提出物で、団体が飲食でない → not_found（Q8）');
select is(tests.q('rep', $q$ select (public.reserve_document_file(:DOC_FOOD, :G1, gen_random_uuid(), 'application/pdf', 10)).size $q$,
                  $q$ update public.groups set is_food = true where id = :G1 $q$), '10', '予約：団体が飲食なら、飲食だけの提出物に足せる');
select is(tests.q('rep', $q$ select (public.reserve_document_file(:DOC_Y2, :G1, gen_random_uuid(), 'application/pdf', 10)).id $q$),
  'not_found', '予約：ほかの年度の提出物 → not_found');
select is(tests.q('rep', $q$ select (public.reserve_document_file(gen_random_uuid(), :G1, gen_random_uuid(), 'application/pdf', 10)).id $q$),
  'not_found', '予約：ない提出物 → not_found');
select is(tests.q('rep', $q$ select (public.reserve_document_file(:DOC_STALL, :G1, gen_random_uuid(), 'application/pdf', 10)).id $q$,
                  $q$ update public.documents set target_categories = '{company}' where id = :DOC_STALL $q$),
  'not_found', '予約：対象を変えて外れた団体 → not_found（今の対象で決める）');
-- 5. 冪等：同じ id・同じ中身なら、状態・数・容量を見ずにその行を返す（送り直し。(B1)）
select is(tests.q('rep', $q$ select tests.name_of((public.reserve_document_file(:DOC_STALL, :G1, :F_G1, 'application/pdf', 1000)).id) $q$),
  'F_G1', '予約の送り直し：提出済みでも、同じ id・同じ中身なら同じ行を返す');
select is(tests.q('rep', $q$ select tests.name_of((public.reserve_document_file(:DOC_STALL, :G1, :F_G1, 'application/pdf', 1000)).id) $q$,
                  $q$ insert into storage.objects (bucket_id, name, metadata) values ('documents', 'pgtap/full.pdf', jsonb_build_object('size', 943718400)) $q$),
  'F_G1', '予約の送り直し：bucket がいっぱいでも、同じ id・同じ中身なら同じ行を返す（容量を見ない）');
select is(tests.q('rep', $q$ select count(*) || ' ' || tests.name_of(min(f.id::text)::uuid) from public.reserve_document_file(:DOC_STALL, :G1, :F_G1, 'application/pdf', 1000) f $q$),
  '1 F_G1', '予約の送り直しは行を増やさない');
-- 6. 書ける状態：店長・副店長は未提出・差し戻し、部門長以上は承認でないとき（部門長以上で店長・副店長も務める人は部門長以上の決まり）
select is(tests.q('rep', $q$ select (public.reserve_document_file(:DOC_STALL, :G1, gen_random_uuid(), 'application/pdf', 10)).id $q$),
  tests.e('invalid_state', '{"status": "submitted", "reason": "not_editable"}'), '予約：店長は提出済みの提出に足せない');
select is(tests.q('rep', $q$ select (public.reserve_document_file(:DOC_STALL, :G1, gen_random_uuid(), 'application/pdf', 10)).id $q$,
                  $q$ update public.document_submissions set status = 'approved', reviewed_at = now() where document_id = :DOC_STALL and group_id = :G1 $q$),
  tests.e('invalid_state', '{"status": "approved", "reason": "not_editable"}'), '予約：店長は承認の提出に足せない');
select is(tests.q('head', $q$ select (public.reserve_document_file(:DOC_STALL, :G1, gen_random_uuid(), 'application/pdf', 10)).id $q$,
                  $q$ update public.document_submissions set status = 'approved', reviewed_at = now() where document_id = :DOC_STALL and group_id = :G1 $q$),
  tests.e('invalid_state', '{"status": "approved", "reason": "not_editable"}'), '予約：部門長も承認の提出には足せない');
select is(tests.q('admin', $q$ select (public.reserve_document_file(:DOC_STALL, :G1, gen_random_uuid(), 'application/pdf', 10)).id $q$,
                  $q$ insert into public.group_members (group_id, user_id, role) values (:G1, :admin, 'deputy_manager');
                      update public.document_submissions set status = 'approved', reviewed_at = now() where document_id = :DOC_STALL and group_id = :G1 $q$),
  tests.e('invalid_state', '{"status": "approved", "reason": "not_editable"}'), '予約：店長・副店長も務める管理者も、承認の提出には足せない');
select is(tests.q('admin', $q$ select tests.name_of((public.reserve_document_file(:DOC_STALL, :G1, :F_G1B, 'image/png', 300)).created_by) $q$,
                  $q$ delete from public.document_files where id = :F_G1B;
                      insert into public.group_members (group_id, user_id, role) values (:G1, :admin, 'deputy_manager') $q$),
  'admin', '予約：店長・副店長も務める管理者は、提出済みの自分の団体にも足せる（部門長以上の決まり）');
-- 返り値：path は DB が列から作る（拡張子は形から。予約した人は created_by）
select is(tests.q('head', $q$ select format('%s %s %s', ((f).object_path = tests.doc_path('Y1', 'G1', 'DOC_STALL', 'F_G1B', 'png'))::text, tests.name_of((f).created_by), (f).size)
                                from (select public.reserve_document_file(:DOC_STALL, :G1, :F_G1B, 'image/png', 300) as f) x $q$,
                  $q$ delete from public.document_files where id = :F_G1B $q$),
  'true head 300', '予約の返り値：path は {year}/{group}/{document}/{file}.png、予約した人と大きさ');
select is(tests.q('viewer', $q$ select (public.reserve_document_file(:DOC_STALL, :G4, :F_G1B, 'image/jpeg', 300)).object_path $q$,
                  $q$ delete from public.document_files where id = :F_G1B $q$),
  tests.doc_path('Y1', 'G4', 'DOC_STALL', 'F_G1B', 'jpg'), '予約の返り値：JPEG の拡張子は jpg（G4 の副店長の viewer）');
-- 5 つまで（Q2）：その提出のファイルの行（届いていない予約を含む）が 5 つなら too_many_files
select is(tests.q('rep2', $q$ select (public.reserve_document_file(:DOC_STALL, :G2, gen_random_uuid(), 'application/pdf', 10)).id $q$,
                  $q$ insert into public.document_files (id, year_id, document_id, group_id, object_path, content_type, size)
                      select x.id, :Y1, :DOC_STALL, :G2, :Y1::text || '/' || :G2::text || '/' || :DOC_STALL::text || '/' || x.id::text || '.pdf', 'application/pdf', 1
                      from (select gen_random_uuid() as id from generate_series(1, 5)) x $q$),
  tests.e('invalid_state', '{"status": "returned", "reason": "too_many_files"}'), '予約：その提出のファイルが 5 つなら too_many_files');
select is(tests.q('rep2', $q$ select (public.reserve_document_file(:DOC_STALL, :G2, gen_random_uuid(), 'application/pdf', 10)).size $q$,
                  $q$ insert into public.document_files (id, year_id, document_id, group_id, object_path, content_type, size)
                      select x.id, :Y1, :DOC_STALL, :G2, :Y1::text || '/' || :G2::text || '/' || :DOC_STALL::text || '/' || x.id::text || '.pdf', 'application/pdf', 1
                      from (select gen_random_uuid() as id from generate_series(1, 4)) x $q$),
  '10', '予約：4 つなら 5 つ目を足せる');
-- bucket の合計 900 MiB（943718400 B）：届いた物（metadata の size）＋届いていない予約（申告）＋今回。fixture と F_G1B では、届いた物が
-- F_G1 の 1000 と O_G1 の 500（ほかの bucket の 7 は数えない）、届いていない予約が F_Y2 の 2000 と F_G1B の 300 で、合計 3800
select is(tests.q('rep', $q$ select (public.reserve_document_file(:DOC_NOFILE, :G1, gen_random_uuid(), 'application/pdf', 11)).id $q$,
                  $q$ insert into storage.objects (bucket_id, name, metadata) values ('documents', 'pgtap/big.pdf', jsonb_build_object('size', 943718400 - 3800 - 10)) $q$),
  tests.e('invalid_state', '{"status": "not_submitted", "reason": "storage_full"}'), '予約：bucket の合計が 900 MiB を 1 B でも超えるなら storage_full');
select is(tests.q('rep', $q$ select (public.reserve_document_file(:DOC_NOFILE, :G1, gen_random_uuid(), 'application/pdf', 10)).size $q$,
                  $q$ insert into storage.objects (bucket_id, name, metadata) values ('documents', 'pgtap/big.pdf', jsonb_build_object('size', 943718400 - 3800 - 10)) $q$),
  '10', '予約：ちょうど 900 MiB までは足せる');
select is(tests.q('rep', $q$ select (public.reserve_document_file(:DOC_NOFILE, :G1, gen_random_uuid(), 'application/pdf', 10)).size $q$,
                  $q$ update storage.objects set metadata = '{"size": 1}' where bucket_id = 'documents' and name = tests.doc_path('Y1', 'G1', 'DOC_STALL', 'F_G1');
                      insert into storage.objects (bucket_id, name, metadata) values ('documents', 'pgtap/big.pdf', jsonb_build_object('size', 943718400 - 2801 - 10)) $q$),
  '10', '予約：届いた物は申告（1000）でなく実際の大きさ（1）で数える');
select is(tests.q('rep', $q$ select (public.reserve_document_file(:DOC_NOFILE, :G1, gen_random_uuid(), 'application/pdf', 11)).id $q$,
                  $q$ update storage.objects set metadata = '{"size": 1}' where bucket_id = 'documents' and name = tests.doc_path('Y1', 'G1', 'DOC_STALL', 'F_G1');
                      insert into storage.objects (bucket_id, name, metadata) values ('documents', 'pgtap/big.pdf', jsonb_build_object('size', 943718400 - 2801 - 10)) $q$),
  tests.e('invalid_state', '{"status": "not_submitted", "reason": "storage_full"}'), '予約：実際の大きさで数えても、超えれば storage_full');
select is(tests.q('rep', $q$ select (public.reserve_document_file(:DOC_NOFILE, :G1, gen_random_uuid(), 'application/pdf', 10)).size $q$,
                  $q$ insert into storage.objects (bucket_id, name, metadata) values ('pgtap-other', 'pgtap/big.pdf', jsonb_build_object('size', 943718400)) $q$),
  '10', '予約：ほかの bucket の物は数えない');
-- 予約の中身：提出の行がなければ作り（未提出）、ファイルの行を入れ、提出の版を進める（ファイルの組も提出の版で守る）。理由は置かない
select coalesce(max(id), 0) as m0 from public.audit_logs \gset
select set_config('app.reason', '前の理由', true);
insert into tests.ids values ('F1', gen_random_uuid()), ('F2', gen_random_uuid()), ('F3', gen_random_uuid()), ('F4', gen_random_uuid()),
  ('F5', gen_random_uuid()), ('F6', gen_random_uuid());
select is(tests.run('rep', $q$ select tests.name_of((public.reserve_document_file(:DOC_NOFILE, :G1, :F1, 'application/pdf', 100)).id) $q$), 'F1',
  'rep：G1 の DOC_NOFILE に F1 を予約する');
select is((select format('%s %s %s %s', status, (submitted_at is null)::text, proxy::text, (updated_at = now())::text) from public.document_submissions
           where document_id = tests.id('DOC_NOFILE') and group_id = tests.id('G1')),
  'not_submitted true false true', '予約で提出の行ができる（未提出・提出の日時なし・代理でない。版は今）');
select is((select format('%s %s %s %s', tests.name_of(created_by), content_type, size, (object_path = tests.doc_path('Y1', 'G1', 'DOC_NOFILE', 'F1'))::text)
           from public.document_files where id = tests.id('F1')),
  'rep application/pdf 100 true', '予約したファイルの行：予約した人・形・申告の大きさ・path');
select is(tests.audit_since(:m0), 'document_submissions insert null, document_files insert null',
  '予約は理由を置かない（同じトランザクションの前の理由を引き継がない）');
select set_config('app.reason', '', true);

-- ================================================================ ③ discard_document_file
-- 1. forbidden：ファイルの行がない・呼べない人（ほかの団体・部門員・閲覧のみ・ほかの年度の部門長以上）。どれも同じ forbidden（有無を漏らさない）
select is(tests.q('rep', $q$ select public.discard_document_file(null) $q$), 'forbidden', '外す：id が null → forbidden');
select is(tests.q('rep', $q$ select public.discard_document_file(gen_random_uuid()) $q$), 'forbidden', '外す：ないファイル → forbidden');
select is(tests.q('rep2', $q$ select public.discard_document_file(:F_G1) $q$), 'forbidden', '外す：ほかの団体のファイル → forbidden（ないファイルと同じ）');
select is(tests.q('staff', $q$ select public.discard_document_file(:F_G1) $q$), 'forbidden', '外す：部門員 → forbidden');
select is(tests.q('viewer', $q$ select public.discard_document_file(:F_G1) $q$), 'forbidden', '外す：閲覧のみ → forbidden');
select is(tests.q('admin', $q$ select public.discard_document_file(:F_Y2) $q$), 'forbidden', '外す：ほかの年度のファイル（Y1 の管理者が Y2 の F_Y2）→ forbidden');
-- 2. 終了 → invalid_state（届いた物でも、状態より先）
select is(tests.q('rep', $q$ select public.discard_document_file(:F1) $q$, $q$ select tests.set_scenario('closed') $q$),
  tests.e('invalid_state', '{"status": "closed"}'), '外す：終了の年度は invalid_state');
-- 4. 届いた物は書ける状態のときだけ。届いていない予約は状態によらない
select is(tests.q('rep', $q$ select public.discard_document_file(:F_G1) $q$),
  tests.e('invalid_state', '{"status": "submitted", "reason": "not_editable"}'), '外す：店長は提出済みの提出の届いた物を外せない');
select is(tests.q('head', $q$ select public.discard_document_file(:F_G1) $q$,
                  $q$ update public.document_submissions set status = 'approved', reviewed_at = now() where document_id = :DOC_STALL and group_id = :G1 $q$),
  tests.e('invalid_state', '{"status": "approved", "reason": "not_editable"}'), '外す：部門長も承認の提出の届いた物は外せない');
select is(tests.q('rep', $q$ select tests.path_name(public.discard_document_file(:F_G1B)) $q$), 'F_G1B',
  '外す：届いていない予約は、提出済みでも店長が外せる（部門長の代理の予約も）');
select is(tests.q('rep', $q$ select tests.path_name(public.discard_document_file(:F_G1B)) $q$,
                  $q$ update public.document_submissions set status = 'approved', reviewed_at = now() where document_id = :DOC_STALL and group_id = :G1 $q$),
  'F_G1B', '外す：届いていない予約は、承認の後でも外せる（上げられなかったもの）');
select is(tests.q('head', $q$ select tests.path_name(public.discard_document_file(:F_G1)) $q$), 'F_G1',
  '外す：部門長は提出済みの届いた物も外せる（承認でなければ）');
-- 中身：ファイルの行を消し、提出の版を進め、path を返す。Storage の物は残る（どの提出にも属さないファイルになる。画面がすぐ remove する）
alter table public.document_submissions disable trigger set_timestamps;
update public.document_submissions set updated_at = '2027-02-01 00:00:00+00' where document_id = tests.id('DOC_NOFILE') and group_id = tests.id('G1');
alter table public.document_submissions enable trigger set_timestamps;
insert into storage.objects (bucket_id, name, metadata) values ('documents', tests.doc_path('Y1', 'G1', 'DOC_NOFILE', 'F1'), '{"size": 90}');
select coalesce(max(id), 0) as m1 from public.audit_logs \gset
select is(tests.run('rep', $q$ select public.discard_document_file(:F1) $q$), tests.doc_path('Y1', 'G1', 'DOC_NOFILE', 'F1'),
  '外す：未提出の提出の届いた物を店長が外し、path が返る');
select is((select format('%s %s', (select count(*) from public.document_files where id = tests.id('F1')),
                         (select (updated_at = now())::text from public.document_submissions where document_id = tests.id('DOC_NOFILE') and group_id = tests.id('G1')))),
  '0 true', '外すとファイルの行が消え、提出の版が進む');
select is(tests.audit_since(:m1), 'document_files delete null', '外すのは理由を置かない（提出の版だけの更新は監査に書かない）');
select is((select count(*)::int from storage.objects where bucket_id = 'documents' and name = tests.doc_path('Y1', 'G1', 'DOC_NOFILE', 'F1')), 1,
  '外しても Storage の物は残る（SQL では消さない）');
select is(tests.run('rep', $q$ select public.discard_document_file(:F1) $q$), 'forbidden', 'もう一度外すと forbidden（行がない）');

-- ================================================================ ④ submit_document・withdraw_document
-- 入力の順：forbidden → 終了 → document_id → not_found（取り消しは base_updated_at も入力）
select is(tests.q('staff', $q$ select (public.submit_document(null, :G1, null)).status $q$), 'forbidden', '提出：呼べない人は、入力が誤っていても forbidden');
select is(tests.q('rep', $q$ select (public.submit_document(null, :G1, null)).status $q$, $q$ select tests.set_scenario('closed') $q$),
  tests.e('invalid_state', '{"status": "closed"}'), '提出：終了の年度は、入力が誤っていても invalid_state');
select is(tests.q('rep', $q$ select (public.submit_document(null, :G1, null)).status $q$),
  tests.e('invalid_input', '{"field": "document_id"}'), '提出：提出物が null → document_id');
select is(tests.q('rep', $q$ select (public.submit_document(:DOC_Y2, :G1, null)).status $q$), 'not_found', '提出：ほかの年度の提出物 → not_found');
select is(tests.q('rep2', $q$ select (public.submit_document(:DOC_NOFILE, :G1, null)).status $q$), 'forbidden', '提出：ほかの団体（rep2 が G1）→ forbidden');
select is(tests.q('rep', $q$ select (public.withdraw_document(null, :G1, null)).status $q$),
  tests.e('invalid_input', '{"field": "document_id"}'), '取り消し：提出物が null → document_id（版より先）');
select is(tests.q('rep', $q$ select (public.withdraw_document(:DOC_STALL, :G1, null)).status $q$),
  tests.e('invalid_input', '{"field": "base_updated_at"}'), '取り消し：版が null → base_updated_at（取り消すのは行のある提出だけ）');
select is(tests.q('rep', $q$ select (public.withdraw_document(:DOC_COMPANY, :G1, now())).status $q$), 'not_found', '取り消し：対象でない提出物 → not_found');
select is(tests.q('viewer', $q$ select (public.withdraw_document(:DOC_STALL, :G4, '2000-01-01')).status $q$),
  tests.e('invalid_state', '{"status": "not_submitted", "reason": "not_editable"}'), '取り消し：行のない提出は未提出として not_editable（版より先）');
-- 楽観ロック：base_updated_at と提出の updated_at をミリ秒までで比べる（G1 の DOC_STALL の版は 2027-01-01 00:00:00.123456+00）
select is(tests.q('rep', $q$ select (public.withdraw_document(:DOC_STALL, :G1, '2027-01-01 00:00:00.123456+00')).status $q$), 'not_submitted',
  '楽観ロック：同じ版なら通る');
select is(tests.q('rep', $q$ select (public.withdraw_document(:DOC_STALL, :G1, '2027-01-01 00:00:00.123+00')).status $q$), 'not_submitted',
  '楽観ロック：ミリ秒に丸めた版（JavaScript の Date）でも通る');
select is(tests.q('rep', $q$ select (public.withdraw_document(:DOC_STALL, :G1, '2027-01-01 00:00:00.123999+00')).status $q$), 'not_submitted',
  '楽観ロック：同じミリ秒の中の違いは通る');
select is(tests.q('rep', $q$ select (public.withdraw_document(:DOC_STALL, :G1, '2027-01-01 09:00:00.123+09')).status $q$), 'not_submitted',
  '楽観ロック：時間帯の書き方が違っても同じ時刻なら通る');
select is(tests.q('rep', $q$ select (public.withdraw_document(:DOC_STALL, :G1, '2027-01-01 00:00:00.124+00')).status $q$),
  tests.e('conflict', format('{"document_id": "%s", "group_id": "%s"}', tests.id('DOC_STALL'), tests.id('G1'))),
  '楽観ロック：1 ミリ秒新しい版は conflict（detail は提出物と団体）');
select is(tests.q('rep', $q$ select (public.withdraw_document(:DOC_STALL, :G1, '2027-01-01 00:00:00.122999+00')).status $q$),
  tests.e('conflict', format('{"document_id": "%s", "group_id": "%s"}', tests.id('DOC_STALL'), tests.id('G1'))),
  '楽観ロック：1 マイクロ秒でも前のミリ秒なら conflict');
-- ファイルの確かめ：付けたファイルは届いていること（ファイルが要らない提出物でも）
select is(tests.run('rep2', $q$ select tests.name_of((public.reserve_document_file(:DOC_NOFILE, :G2, :F2, 'image/jpeg', 100)).id) $q$), 'F2',
  'rep2：G2 の DOC_NOFILE（行なし）に F2 を予約する（行ができる）');
select is(tests.run('rep2', $q$ select (public.submit_document(:DOC_NOFILE, :G2, tests.sub_ts('DOC_NOFILE', 'G2'))).status $q$),
  tests.e('invalid_state', '{"status": "not_submitted", "reason": "not_uploaded"}'), '提出：届いていない予約があれば not_uploaded（ファイルが要らない提出物でも。版より先）');
insert into storage.objects (bucket_id, name, metadata) values ('documents', tests.doc_path('Y1', 'G2', 'DOC_NOFILE', 'F2', 'jpg'), '{"size": 80}');
-- 予約は提出の版を進める：予約の前に読んだ版（行がなかったので null）での提出は conflict（ほかの人が足したファイルを見ずに出さない）
select is(tests.run('rep2', $q$ select (public.submit_document(:DOC_NOFILE, :G2, null)).status $q$),
  tests.e('conflict', format('{"document_id": "%s", "group_id": "%s"}', tests.id('DOC_NOFILE'), tests.id('G2'))),
  '提出：予約の前に読んだ版（行がなかったので null）では conflict');
select is(tests.run('rep2', $q$ select (public.submit_document(:DOC_NOFILE, :G2, tests.sub_ts('DOC_NOFILE', 'G2') + interval '1 millisecond')).status $q$),
  tests.e('conflict', format('{"document_id": "%s", "group_id": "%s"}', tests.id('DOC_NOFILE'), tests.id('G2'))), '提出：違う版は conflict（状態の確かめの後）');
select is(tests.run('rep2', $q$ select format('%s %s %s %s %s', (s).status, (s).proxy::text, tests.name_of((s).submitted_by), ((s).submitted_at = now())::text, ((s).updated_at = now())::text)
                                from (select public.submit_document(:DOC_NOFILE, :G2, date_trunc('milliseconds', tests.sub_ts('DOC_NOFILE', 'G2'))) as s) x $q$),
  'submitted false rep2 true true', '提出：届いた後は出せる（提出済み・代理でない・提出した人と日時・新しい版）。版はミリ秒に丸めても通る');
select is(tests.run('rep2', $q$ select (public.submit_document(:DOC_NOFILE, :G2, tests.sub_ts('DOC_NOFILE', 'G2'))).status $q$),
  tests.e('invalid_state', '{"status": "submitted", "reason": "not_editable"}'), '提出：提出済みをもう一度出すと not_editable');
select is(tests.run('rep2', $q$ select (public.reserve_document_file(:DOC_NOFILE, :G2, :F3, 'application/pdf', 10)).id $q$),
  tests.e('invalid_state', '{"status": "submitted", "reason": "not_editable"}'), '提出の後は、店長はファイルを足せない');
select is(tests.run('rep2', $q$ select public.discard_document_file(:F2) $q$),
  tests.e('invalid_state', '{"status": "submitted", "reason": "not_editable"}'), '提出の後は、店長は届いた物を外せない');
select is(tests.q('admin', $q$ select late from public.v_document_status where document_id = :DOC_NOFILE and group_id = :G2 $q$), 'false',
  '締切の前の提出は late でない');
select is(tests.q('admin', $q$ select late from public.v_document_status where document_id = :DOC_NOFILE and group_id = :G2 $q$,
                  $q$ update public.documents set deadline = now() - interval '1 second' where id = :DOC_NOFILE $q$), 'true',
  '締切の後の提出は late（出せるが印が付く。Q6）');
-- 取り消す：提出の日時と人・代理の印を消す（ファイルと前の差し戻しの理由は残す）
select is(tests.run('rep2', $q$ select (public.withdraw_document(:DOC_NOFILE, :G2, '2000-01-01')).status $q$),
  tests.e('conflict', format('{"document_id": "%s", "group_id": "%s"}', tests.id('DOC_NOFILE'), tests.id('G2'))), '取り消し：古い版は conflict');
select is(tests.run('rep2', $q$ select format('%s %s %s %s', (s).status, coalesce((s).submitted_at::text, 'null'), coalesce(tests.name_of((s).submitted_by), 'null'), (s).proxy::text)
                                from (select public.withdraw_document(:DOC_NOFILE, :G2, tests.sub_ts('DOC_NOFILE', 'G2')) as s) x $q$),
  'not_submitted null null false', '取り消し：未提出に戻り、提出の日時と人・代理の印を消す');
select is((select count(*)::int from public.document_files where document_id = tests.id('DOC_NOFILE') and group_id = tests.id('G2')), 1,
  '取り消してもファイルは残る');
select is(tests.run('rep2', $q$ select (public.withdraw_document(:DOC_NOFILE, :G2, tests.sub_ts('DOC_NOFILE', 'G2'))).status $q$),
  tests.e('invalid_state', '{"status": "not_submitted", "reason": "not_editable"}'), '取り消し：未提出をもう一度取り消すと not_editable');
-- 代理の印（Q9）：その団体の店長・副店長でない部門長以上の提出は代理。店長・副店長も務める管理者が自分の団体に出すのは代理でない
select is(tests.run('head', $q$ select format('%s %s %s', (s).status, (s).proxy::text, tests.name_of((s).submitted_by))
                                from (select public.submit_document(:DOC_NOFILE, :G2, tests.sub_ts('DOC_NOFILE', 'G2')) as s) x $q$),
  'submitted true head', '部門長が代わりに出すと代理の印が付く');
select is(tests.q('admin', $q$ select (public.submit_document(:DOC_NOFILE, :G1, tests.sub_ts('DOC_NOFILE', 'G1'))).proxy $q$,
                  $q$ insert into public.group_members (group_id, user_id, role) values (:G1, :admin, 'deputy_manager') $q$), 'false',
  '店長・副店長も務める管理者が自分の団体（G1）に出すのは代理でない');
select is(tests.q('viewer', $q$ select format('%s %s', (s).status, (s).proxy::text) from (select public.withdraw_document(:DOC_NOFILE, :G2, tests.sub_ts('DOC_NOFILE', 'G2')) as s) x $q$),
  'forbidden', 'G4 の副店長はほかの団体（G2）の代理の提出を取り消せない');
select is(tests.run('rep2', $q$ select format('%s %s', (s).status, (s).proxy::text) from (select public.withdraw_document(:DOC_NOFILE, :G2, tests.sub_ts('DOC_NOFILE', 'G2')) as s) x $q$),
  'not_submitted false', '代理の提出も、その団体の店長が取り消せる（代理の印も消える）');
-- ファイルが要る提出物（G4 の DOC_STALL）：ファイルがなければ no_file。副店長（viewer）が足して上げて出す
select is(tests.run('viewer', $q$ select (public.submit_document(:DOC_STALL, :G4, null)).status $q$),
  tests.e('invalid_state', '{"status": "not_submitted", "reason": "no_file"}'), '提出：ファイルが要る提出物で、ファイルがなければ no_file');
select is((select count(*)::int from public.document_submissions where document_id = tests.id('DOC_STALL') and group_id = tests.id('G4')), 0,
  '失敗した提出は、作りかけた提出の行も残さない');
select is(tests.run('viewer', $q$ select tests.name_of((public.reserve_document_file(:DOC_STALL, :G4, :F4, 'application/pdf', 200)).id) $q$), 'F4',
  'viewer（G4 の副店長）：G4 の DOC_STALL に F4 を予約する');
insert into storage.objects (bucket_id, name, metadata) values ('documents', tests.doc_path('Y1', 'G4', 'DOC_STALL', 'F4'), '{"size": 200}');
select is(tests.run('viewer', $q$ select format('%s %s %s', (s).status, (s).proxy::text, tests.name_of((s).submitted_by))
                                  from (select public.submit_document(:DOC_STALL, :G4, tests.sub_ts('DOC_STALL', 'G4')) as s) x $q$),
  'submitted false viewer', '副店長が自団体に出す（代理でない）');

-- ================================================================ ⑤ approve_document・return_document
-- 入力の順：forbidden → 終了 → document_id → note（長さ）→ not_found → 状態（承認済み）→ note（必須。状態で決まる）→ conflict
select is(tests.q('rep', $q$ select (public.approve_document(null, :G1, null, null)).status $q$), 'forbidden', '承認：店長は呼べない（入力より先）');
select is(tests.q('head', $q$ select (public.approve_document(:DOC_STALL, null, null, null)).status $q$), 'forbidden', '承認：団体が null → forbidden');
select is(tests.q('head', $q$ select (public.approve_document(null, :G1, repeat('a', 1001), null)).status $q$, $q$ select tests.set_scenario('closed') $q$),
  tests.e('invalid_state', '{"status": "closed"}'), '承認：終了の年度は、入力が誤っていても invalid_state');
select is(tests.q('head', $q$ select (public.approve_document(null, :G1, repeat('a', 1001), null)).status $q$),
  tests.e('invalid_input', '{"field": "document_id"}'), '承認：提出物が null → document_id（メモの長さより先）');
select is(tests.q('head', $q$ select (public.approve_document(:DOC_COMPANY, :G1, repeat('a', 1001), null)).status $q$),
  tests.e('invalid_input', '{"field": "note", "reason": "too_long"}'), '承認：メモが 1001 字 → note・too_long（not_found より先）');
select is(tests.q('head', $q$ select length((public.approve_document(:DOC_STALL, :G1, E'　 ' || repeat('a', 1000) || E' \n', tests.sub_ts('DOC_STALL', 'G1'))).review_note) $q$),
  '1000', '承認：前後の空白を除いて 1000 字のメモは通る');
select is(tests.q('head', $q$ select (public.approve_document(:DOC_COMPANY, :G1, 'x', null)).status $q$), 'not_found', '承認：対象でない提出物 → not_found');
select is(tests.q('head', $q$ select (public.approve_document(:DOC_NOFILE, :G4, null, '2000-01-01')).status $q$),
  tests.e('invalid_state', '{"status": "approved", "reason": "not_editable"}'), '承認：承認済み → not_editable（メモの必須・版より先）');
select is(tests.q('head', $q$ select (public.approve_document(:DOC_STALL, :G2, null, '2000-01-01')).status $q$),
  tests.e('invalid_input', '{"field": "note", "reason": "required"}'), '承認：差し戻しからの承認でメモがない → note・required（版より先）');
select is(tests.q('head', $q$ select (public.approve_document(:DOC_STALL, :G2, tests.js_space(), tests.sub_ts('DOC_STALL', 'G2'))).status $q$),
  tests.e('invalid_input', '{"field": "note", "reason": "required"}'), '承認：JavaScript の trim が除く 25 文字だけのメモは、ないのと同じ');
select is(tests.q('head', $q$ select (public.approve_document(:DOC_NOFILE, :G1, null, null)).status $q$),
  tests.e('invalid_input', '{"field": "note", "reason": "required"}'), '承認：未提出（行なし）からの承認でメモがない → note・required');
select is((select count(*)::int from public.document_submissions where document_id = tests.id('DOC_NOFILE') and group_id = tests.id('G1')
             and status <> 'not_submitted'), 0, '（確かめ）G1 の DOC_NOFILE は未提出のまま');
select is(tests.q('head', $q$ select (public.approve_document(:DOC_STALL, :G1, null, null)).status $q$),
  tests.e('conflict', format('{"document_id": "%s", "group_id": "%s"}', tests.id('DOC_STALL'), tests.id('G1'))), '承認：行があるのに版が null → conflict');
-- 提出済みからの承認：メモは任意（空白だけなら null）。提出の日時・人・代理の印は残す
select is(tests.q('head', $q$ select format('%s %s %s %s %s', (s).status, coalesce((s).review_note, 'null'), ((s).submitted_at is not null)::text, tests.name_of((s).reviewed_by), ((s).reviewed_at = now())::text)
                                from (select public.approve_document(:DOC_STALL, :G1, E' 　', tests.sub_ts('DOC_STALL', 'G1')) as s) x $q$),
  'approved null true head true', '承認：提出済みからの承認は提出の日時を残し、空白だけのメモは null');
select is(tests.q('head', $q$ select format('%s %s', (s).proxy::text, ((s).submitted_at is not null)::text)
                                from (select public.approve_document(:DOC_STALL, :G1, null, tests.sub_ts('DOC_STALL', 'G1')) as s) x $q$,
                  $q$ update public.document_submissions set proxy = true where document_id = :DOC_STALL and group_id = :G1 $q$),
  'true true', '承認：代理の提出を承認しても代理の印は残る');
-- 紙などで受け取った承認（Q9）：差し戻し・未提出から、メモつきで。提出の日時と人・代理の印を消す（「submitted_at のない承認」）
select coalesce(max(id), 0) as m2 from public.audit_logs \gset
select is(tests.run('head', $q$ select format('%s %s %s %s %s', (s).status, coalesce((s).submitted_at::text, 'null'), coalesce(tests.name_of((s).submitted_by), 'null'), (s).proxy::text, (s).review_note)
                                from (select public.approve_document(:DOC_STALL, :G2, ' 紙で受け取った ', tests.sub_ts('DOC_STALL', 'G2')) as s) x $q$),
  'approved null null false 紙で受け取った', '紙での承認：差し戻しから、メモ（前後の空白を除く）つきで承認し、提出の日時と人を消す');
select is(tests.run('deputy', $q$ select format('%s %s %s', (s).status, coalesce((s).submitted_at::text, 'null'), (s).review_note)
                                  from (select public.approve_document(:DOC_PAPER, :G2, '受付で受け取った', null) as s) x $q$),
  'approved null 受付で受け取った', '紙での承認：未提出（行なし）から、版 null で承認できる（行を作る）');
select is(tests.audit_since(:m2), 'document_submissions update 提出物の承認, document_submissions insert 提出物の承認, document_submissions update 提出物の承認',
  '承認の監査の理由は「提出物の承認」（行を作る insert にも同じ理由）');
select is(tests.run('rep2', $q$ select (public.withdraw_document(:DOC_STALL, :G2, tests.sub_ts('DOC_STALL', 'G2'))).status $q$),
  tests.e('invalid_state', '{"status": "approved", "reason": "not_editable"}'), '承認の後は、店長は取り消せない');
-- 差し戻し：理由は前後の空白（25 文字）を除いて 1〜1000 字で必須。入力の順：document_id → note（required・too_long）→ base_updated_at
select is(tests.q('head', $q$ select (public.return_document(null, :G2, null, null)).status $q$),
  tests.e('invalid_input', '{"field": "document_id"}'), '差し戻し：提出物が null → document_id');
select is(tests.q('head', $q$ select (public.return_document(:DOC_STALL, :G2, null, null)).status $q$),
  tests.e('invalid_input', '{"field": "note", "reason": "required"}'), '差し戻し：理由が null → note・required（版より先）');
select is(tests.q('head', $q$ select (public.return_document(:DOC_STALL, :G2, '   ', tests.sub_ts('DOC_STALL', 'G2'))).status $q$),
  tests.e('invalid_input', '{"field": "note", "reason": "required"}'), '差し戻し：空白だけの理由 → required');
select is(tests.q('head', $q$ select (public.return_document(:DOC_STALL, :G2, tests.js_space(), tests.sub_ts('DOC_STALL', 'G2'))).status $q$),
  tests.e('invalid_input', '{"field": "note", "reason": "required"}'), '差し戻し：JavaScript の trim が除く 25 文字だけの理由 → required');
select is(tests.q('head', $q$ select (public.return_document(:DOC_STALL, :G2, repeat('あ', 1001), null)).status $q$),
  tests.e('invalid_input', '{"field": "note", "reason": "too_long"}'), '差し戻し：1001 字の理由 → too_long（版より先）');
select is(tests.q('head', $q$ select (public.return_document(:DOC_STALL, :G2, 'x', null)).status $q$),
  tests.e('invalid_input', '{"field": "base_updated_at"}'), '差し戻し：版が null → base_updated_at');
select is(tests.q('head', $q$ select (public.return_document(:DOC_STALL, :G2, 'x', '2000-01-01')).status $q$),
  tests.e('conflict', format('{"document_id": "%s", "group_id": "%s"}', tests.id('DOC_STALL'), tests.id('G2'))), '差し戻し：古い版 → conflict');
select is(tests.run('head', $q$ select format('%s %s %s %s', (s).status, (s).review_note, coalesce((s).submitted_at::text, 'null'), (s).proxy::text)
                                from (select public.return_document(:DOC_STALL, :G2, E'　写真が暗い\n', tests.sub_ts('DOC_STALL', 'G2')) as s) x $q$),
  'returned 写真が暗い null false', '差し戻し：紙での承認を取り消して差し戻す（理由は前後の空白を除く）');
select is(tests.run('deputy', $q$ select format('%s %s %s', (s).status, (s).review_note, tests.name_of((s).reviewed_by))
                                  from (select public.return_document(:DOC_STALL, :G2, '理由2', tests.sub_ts('DOC_STALL', 'G2')) as s) x $q$),
  'returned 理由2 deputy', '差し戻し：差し戻しの理由を書き直す（確かめた人も変わる）');
select is(tests.run('head', $q$ select format('%s %s %s %s', (s).status, (s).review_note, ((s).submitted_at = now())::text, tests.name_of((s).submitted_by))
                                from (select public.return_document(:DOC_STALL, :G4, 'G4 の理由', tests.sub_ts('DOC_STALL', 'G4')) as s) x $q$),
  'returned G4 の理由 true viewer', '差し戻し：提出済みからの差し戻しは、提出の日時と人を残す');
-- 差し戻しの後の出し直し：前の差し戻しの理由は残す（「前の差し戻しの理由」として出す）
select is(tests.run('viewer', $q$ select format('%s %s', (s).status, (s).review_note)
                                  from (select public.submit_document(:DOC_STALL, :G4, tests.sub_ts('DOC_STALL', 'G4')) as s) x $q$),
  'submitted G4 の理由', '出し直し：差し戻しから出し直すと提出済みになり、前の差し戻しの理由は残る');

-- ================================================================ ⑥ 監査の理由
select coalesce(max(id), 0) as m3 from public.audit_logs \gset
select is(tests.run('head', $q$ select (public.submit_document(:DOC_NOFILE, :G4, null)).status $q$),
  tests.e('invalid_state', '{"status": "approved", "reason": "not_editable"}'), '（準備）G4 の DOC_NOFILE は承認済みなので出せない');
select is(tests.run('head', $q$ select (public.return_document(:DOC_NOFILE, :G4, '理由', tests.sub_ts('DOC_NOFILE', 'G4'))).status $q$), 'returned',
  '承認を差し戻す');
select is(tests.run('head', $q$ select (public.submit_document(:DOC_NOFILE, :G4, tests.sub_ts('DOC_NOFILE', 'G4'))).proxy $q$), 'true',
  '差し戻しを部門長が代わりに出す（代理）');
select is(tests.run('viewer', $q$ select (public.withdraw_document(:DOC_NOFILE, :G4, tests.sub_ts('DOC_NOFILE', 'G4'))).status $q$), 'not_submitted',
  '副店長が代理の提出を取り消す');
select is(tests.run('viewer', $q$ select (public.submit_document(:DOC_NOFILE, :G4, tests.sub_ts('DOC_NOFILE', 'G4'))).proxy $q$), 'false',
  '副店長が出す');
select is(tests.audit_since(:m3), 'document_submissions update 提出物の差し戻し, document_submissions update 提出物の代理の提出, '
  || 'document_submissions update 提出の取り消し, document_submissions update 提出物の提出',
  '監査の理由：差し戻し・代理の提出・取り消し・提出（失敗した呼び出しは何も残さない）');
select is((select string_agg(format('%s %s', tests.name_of(a.user_id), a.after ->> 'status'), ', ' order by a.id) from public.audit_logs a
           where a.id > :m3 and a.table_name = 'document_submissions'),
  'head returned, head submitted, viewer not_submitted, viewer submitted', '監査に、した人と後の状態が残る');
select coalesce(max(id), 0) as m4 from public.audit_logs \gset
select is(tests.run('head', $q$ select (public.submit_document(:DOC_NOFILE, :G1, null)).proxy $q$),
  tests.e('conflict', format('{"document_id": "%s", "group_id": "%s"}', tests.id('DOC_NOFILE'), tests.id('G1'))), '（準備）行があるので版 null は conflict');
select is(tests.run('head', $q$ select format('%s %s', (s).status, (s).proxy::text) from (select public.submit_document(:DOC_NOFILE, :G1, tests.sub_ts('DOC_NOFILE', 'G1')) as s) x $q$),
  'submitted true', '部門長が G1 の DOC_NOFILE を代わりに出す');
select is(tests.audit_since(:m4), 'document_submissions update 提出物の代理の提出',
  '失敗した提出（conflict）は監査に何も残さない');
select coalesce(max(id), 0) as m5 from public.audit_logs \gset
select is(tests.run('head', $q$ select (public.submit_document(:DOC_COMPANY, :G1, null)).status $q$), 'not_found', '（準備）対象でない提出物には出せない');
select is(tests.run('head', $q$ select format('%s %s', (s).status, (s).proxy::text) from (select public.submit_document(:DOC_NOFILE, :G2, null) as s) x $q$),
  tests.e('conflict', format('{"document_id": "%s", "group_id": "%s"}', tests.id('DOC_NOFILE'), tests.id('G2'))), '（準備）版が違えば出せない');
select is(tests.audit_since(:m5), '', '失敗した呼び出し（not_found・conflict）は監査に何も残さない');

-- ================================================================ ⑦ 前年度から写す（Y1 の複製元は Y2。1日目の差は 365 日）
-- Y2 に締切の早い提出物（DOC_Y2_EARLY）を足す。Y1 にも同じ題名のものがある（写すと飛ばす）
with d as (
  insert into public.documents (year_id, title, description, deadline, target_categories, food_only, requires_file, files_deleted_at) values
    (tests.id('Y2'), 'T-DOC_Y2_EARLY', '説明', '2026-09-15 09:00+09', '{department,company}', true, false, '2026-12-01 00:00+09')
  returning id, title)
insert into tests.ids select substr(title, 3), id from d;
insert into public.documents (year_id, title, deadline, target_categories) values (tests.id('Y1'), 'T-DOC_Y2_EARLY', '2027-09-01 12:00+09', '{stall}');
update public.documents set files_deleted_at = '2026-12-01 00:00+09' where id = tests.id('DOC_Y2');
select is(tests.q('head', $q$ select string_agg(format('%s|%s|%s|%s|%s|%s|%s|%s', tests.name_of(document_id), deadline at time zone 'Asia/Tokyo', new_deadline at time zone 'Asia/Tokyo',
                                                     target_categories, food_only::text, requires_file::text, exists_in_year::text, coalesce(description, 'null')), ' / ' order by deadline)
                               from public.previous_year_documents(:Y1) $q$),
  'DOC_Y2_EARLY|2026-09-15 09:00:00|2027-09-15 09:00:00|{department,company}|true|false|true|説明 / '
  || 'DOC_Y2|2026-10-01 12:00:00|2027-10-01 12:00:00|{stall}|false|true|false|null',
  '前年度の提出物：締切の順に、1日目の差（365 日）だけずらした締切（Asia/Tokyo の時刻は同じ）と、同じ題名がこの年度にあるか');
select is(tests.q('admin2', $q$ select count(*) from public.previous_year_documents(:Y2) $q$), '0', '複製元のない年度の前年度の提出物は空');
select is(tests.q('head', $q$ select count(*) from public.previous_year_documents(null) $q$), 'forbidden', '年度が null → forbidden');
-- 写す：エラーの順と detail（field は document_ids）
select is(tests.q('staff', $q$ select count(*) from public.copy_previous_documents(:Y1, null) $q$, $q$ select tests.set_scenario('closed') $q$),
  'forbidden', '写す：部門員は、終了の年度でも forbidden');
select is(tests.q('head', $q$ select count(*) from public.copy_previous_documents(:Y1, null) $q$, $q$ select tests.set_scenario('closed') $q$),
  tests.e('invalid_state', '{"status": "closed"}'), '写す：終了の年度は、入力が誤っていても invalid_state');
select is(tests.q('head', $q$ select count(*) from public.copy_previous_documents(:Y1, null) $q$),
  tests.e('invalid_input', '{"field": "document_ids", "reason": "required"}'), '写す：null → required');
select is(tests.q('head', $q$ select count(*) from public.copy_previous_documents(:Y1, '{}') $q$),
  tests.e('invalid_input', '{"field": "document_ids", "reason": "required"}'), '写す：空 → required');
select is(tests.q('head', $q$ select count(*) from public.copy_previous_documents(:Y1, array_fill(:DOC_Y2, array[1001])) $q$),
  tests.e('invalid_input', '{"field": "document_ids", "reason": "too_many"}'), '写す：1001 個 → too_many（重なりより先に数で見る）');
select is(tests.q('head', $q$ select count(*) from public.copy_previous_documents(:Y1, array[:DOC_Y2, null]) $q$),
  tests.e('invalid_input', '{"field": "document_ids", "reason": "invalid"}'), '写す：null の要素 → invalid');
select is(tests.q('head', $q$ select count(*) from public.copy_previous_documents(:Y1, array[:DOC_Y2, :DOC_Y2]) $q$),
  tests.e('invalid_input', '{"field": "document_ids", "reason": "invalid"}'), '写す：重なり → invalid');
select is(tests.q('head', $q$ select count(*) from public.copy_previous_documents(:Y1, array[:DOC_Y2, :DOC_STALL]) $q$),
  tests.e('invalid_input', '{"field": "document_ids", "reason": "not_in_prev_year"}'), '写す：この年度の提出物が混じる → not_in_prev_year');
select is(tests.q('head', $q$ select count(*) from public.copy_previous_documents(:Y1, array[gen_random_uuid()]) $q$),
  tests.e('invalid_input', '{"field": "document_ids", "reason": "not_in_prev_year"}'), '写す：ない提出物 → not_in_prev_year');
select is(tests.q('admin2', $q$ select count(*) from public.copy_previous_documents(:Y2, array[:DOC_Y2]) $q$),
  tests.e('invalid_input', '{"field": "document_ids", "reason": "not_in_prev_year"}'), '写す：複製元のない年度 → not_in_prev_year');
select is(tests.q('head', $q$ select count(*) from public.copy_previous_documents(:Y1, array[:DOC_Y2]) $q$,
                  $q$ update public.documents set deadline = '2200-06-01 12:00+09' where id = :DOC_Y2 $q$),
  tests.e('invalid_input', '{"field": "document_ids", "reason": "deadline_out_of_range"}'), '写す：ずらした締切が 2200 年を超える → deadline_out_of_range');
-- 写す中身：題名・説明・対象・飲食だけ・ファイルが要るを写し、締切はずらす。files_deleted_at は写さない。書いた人は写した人。同じ題名は飛ばす
select coalesce(max(id), 0) as m6 from public.audit_logs \gset
select is(tests.run('head', $q$ select string_agg(format('%s|%s|%s|%s|%s|%s|%s|%s|%s', title, deadline at time zone 'Asia/Tokyo', target_categories, food_only::text, requires_file::text,
                                                       coalesce(files_deleted_at::text, 'null'), tests.name_of(created_by), tests.name_of(updated_by), coalesce(description, 'null')), ' / ')
                               from public.copy_previous_documents(:Y1, array[:DOC_Y2_EARLY, :DOC_Y2]) $q$),
  'T-DOC_Y2|2027-10-01 12:00:00|{stall}|false|true|null|head|head|null',
  '写す：同じ題名（T-DOC_Y2_EARLY）は飛ばし、DOC_Y2 だけを、ずらした締切で写す（files_deleted_at は写さない。書いた人は写した人）');
select is(tests.audit_since(:m6), 'documents insert 提出物の前年度からの写し', '写すの監査の理由は「提出物の前年度からの写し」');
select is(tests.run('head', $q$ select count(*) from public.copy_previous_documents(:Y1, array[:DOC_Y2_EARLY, :DOC_Y2]) $q$), '0',
  '写す：もう一度写しても何も増えない（同じ結果）');
select is(tests.q('head', $q$ select string_agg(tests.name_of(document_id) || '=' || exists_in_year, ' ' order by deadline) from public.previous_year_documents(:Y1) $q$),
  'DOC_Y2_EARLY=true DOC_Y2=true', '写した後は、どちらもこの年度にある');

-- ================================================================ ⑧ どの提出にも属さないファイル・使った量・年度のファイルの削除
-- 今の Storage の documents：F_G1（1000。行あり）・O_G1（500。行なし）・F1（90。外したので行なし）・F2（80。行あり）・F4（200。行あり）
select is(tests.q('admin', $q$ select string_agg(tests.path_name(p), ' ' order by tests.path_name(p) collate "C") from public.document_orphan_paths(:Y1) p $q$),
  'F1 O_G1', '部門長以上：その年度のフォルダの、どの提出にも属さない物を全部（G1 の F1 と O_G1）');
select is(tests.q('rep', $q$ select string_agg(tests.path_name(p), ' ' order by tests.path_name(p) collate "C") from public.document_orphan_paths(:Y1) p $q$),
  'F1 O_G1', '店長：自団体（G1）のフォルダの物だけ');
select is(tests.q('rep2', $q$ select count(*) from public.document_orphan_paths(:Y1) $q$), '0', 'rep2：G2 のフォルダにはない（ほかの団体の物は入らない）');
select is(tests.q('staff', $q$ select count(*) from public.document_orphan_paths(:Y1) $q$), 'forbidden', '部門員は forbidden');
select is(tests.q('admin', $q$ select count(*) from public.document_orphan_paths(null) $q$), 'forbidden', '年度が null → forbidden');
select is(tests.q('admin', $q$ select count(*) from public.document_orphan_paths(:Y1) $q$,
                  $q$ insert into storage.objects (bucket_id, name, metadata) values ('pgtap-other', tests.doc_path('Y1', 'G1', 'DOC_STALL', 'F5'), '{"size": 1}'),
                                                                                     ('documents', tests.doc_path('Y2', 'G3', 'DOC_Y2', 'F5'), '{"size": 1}') $q$),
  '2', 'ほかの bucket の物と、ほかの年度のフォルダの物は入らない');
-- 使った量：bucket の合計（全年度・どの提出にも属さない物も）、上限、その年度のファイルの数と大きさ（届いた物は実際、届いていないものは申告）、
-- その年度のフォルダのどの提出にも属さない物の数
select is(tests.q('head', $q$ select format('%s %s %s %s %s', bucket_bytes, limit_bytes, file_count, file_bytes, orphan_count) from public.document_storage_usage(:Y1) $q$),
  '1870 943718400 4 1580 2', '使った量（Y1）：bucket 1870 B（1000+500+90+80+200）、上限 900 MiB、ファイル 4 つ（F_G1 1000・F_G1B 申告 300・F2 80・F4 200）、行のない物 2 つ');
select is(tests.q('admin2', $q$ select format('%s %s %s %s', bucket_bytes, file_count, file_bytes, orphan_count) from public.document_storage_usage(:Y2) $q$),
  '1870 1 2000 0', '使った量（Y2）：bucket は全年度の合計、届いていない F_Y2 は申告の大きさ');
select is(tests.q('rep', $q$ select bucket_bytes from public.document_storage_usage(:Y1) $q$), 'forbidden', '店長は使った量を読めない');
-- 年度のファイルの削除（Q3）：管理者だけ、終了の年度だけ。ファイルの行を全部消し、提出物の files_deleted_at を入れる（最初の日時のまま）。
-- 提出の状態・日時・理由は残す。エラーの順：forbidden → 終了でない（invalid_state）→ 理由の長さ（invalid_input）
select is(tests.q('head', $q$ select public.delete_year_document_files(:Y1) $q$, $q$ select tests.set_scenario('closed') $q$), 'forbidden',
  '年度のファイルの削除：部門長は forbidden（管理者だけ）');
select is(tests.q('admin', $q$ select public.delete_year_document_files(null) $q$), 'forbidden', '年度のファイルの削除：年度が null → forbidden');
select is(tests.q('admin', $q$ select public.delete_year_document_files(:Y1, repeat('a', 501)) $q$),
  tests.e('invalid_state', '{"status": "requesting", "reason": "not_closed"}'), '年度のファイルの削除：終了でなければ、理由が誤っていても invalid_state（not_closed）');
select tests.set_scenario('closed');
select is(tests.q('admin', $q$ select public.delete_year_document_files(:Y1, repeat('a', 501)) $q$),
  tests.e('invalid_input', '{"field": "reason"}'), '年度のファイルの削除：理由が 501 字 → reason');
select (select count(*) from public.document_submissions where year_id = tests.id('Y1')) as subs_before \gset
select coalesce(max(id), 0) as m7 from public.audit_logs \gset
select is(tests.run('admin', $q$ select public.delete_year_document_files(:Y1, ' ') $q$), '4', '年度のファイルの削除：Y1 のファイルの行 4 つを消す');
select is((select count(*)::int from public.document_files where year_id = tests.id('Y1')) || ' ' || (select count(*)::int from public.document_files where year_id = tests.id('Y2')),
  '0 1', 'Y1 のファイルの行は全部消え、Y2 のファイルは残る');
select is((select count(*)::int from public.document_submissions where year_id = tests.id('Y1')), :subs_before,
  '提出の行は残る（状態・日時・理由を残す）');
select is((select string_agg(distinct coalesce(reason, 'null'), ' ') from public.audit_logs where id > :m7 and table_name = 'document_files'),
  '提出物のファイルの削除', '理由を省く（空白だけ）と、監査の理由は「提出物のファイルの削除」');
select is((select count(*)::int from public.documents where year_id = tests.id('Y1') and (files_deleted_at is null or files_deleted_at <> now())), 0,
  'Y1 の提出物の files_deleted_at は全部、削除した日時');
select is((select count(*)::int from public.documents where year_id = tests.id('Y2') and files_deleted_at = now()), 0, 'Y2 の提出物の files_deleted_at は変わらない');
update public.documents set files_deleted_at = '2026-12-31 00:00+09' where year_id = tests.id('Y1');
select coalesce(max(id), 0) as m8 from public.audit_logs \gset
select is(tests.run('admin', $q$ select public.delete_year_document_files(:Y1, '年度末の片付け') $q$), '0', 'もう一度消すと 0（同じ結果）');
select is((select count(*)::int from public.documents where year_id = tests.id('Y1') and files_deleted_at <> '2026-12-31 00:00+09'), 0,
  'files_deleted_at は最初の削除の日時のまま（null のものだけ入れる）');
select is(tests.audit_since(:m8), '', '何も消さなければ監査にも残らない');
select is(tests.q('admin', $q$ select string_agg(tests.path_name(p), ' ' order by tests.path_name(p) collate "C") from public.document_orphan_paths(:Y1) p $q$),
  'F1 F2 F4 F_G1 O_G1', '削除の後は、Y1 の物は全部どの提出にも属さない（画面が Storage から消す）');
select is(tests.q('admin', $q$ select format('%s %s %s', file_count, file_bytes, orphan_count) from public.document_storage_usage(:Y1) $q$),
  '0 0 5', '削除の後の使った量：ファイル 0、行のない物 5');
select is(tests.q('head', $q$ select string_agg(tests.name_of(document_id) || ':' || tests.name_of(group_id) || '=' || status, ' ' order by tests.name_of(document_id) collate "C", tests.name_of(group_id) collate "C")
                               from public.v_document_status where status <> 'not_submitted' $q$),
  'DOC_NOFILE:G1=submitted DOC_NOFILE:G4=submitted DOC_PAPER:G2=approved DOC_STALL:G1=submitted DOC_STALL:G2=returned DOC_STALL:G4=submitted',
  '削除の後も、提出の状態は読める（終了の年度でも）');
select is(tests.q('admin', $q$ with u as (update public.documents set files_deleted_at = null where year_id = :Y1 returning 1) select count(*) from u $q$), '0',
  '終了の年度の提出物は直接は直せない（files_deleted_at も。RLS の can_lead）');
select tests.set_scenario('requesting');

-- ================================================================ ⑨ not_found と forbidden、例外の直し（D-19）
-- 読めない提出物の有無を漏らさない：その年度の部門長以上にとって、ほかの年度の提出物とない提出物は同じ not_found。呼べない人は、ある提出物でも
-- ない提出物でも同じ forbidden
select is(tests.q('admin', $q$ select (public.reserve_document_file(:DOC_Y2, :G1, gen_random_uuid(), 'application/pdf', 10)).id $q$)
          || ' ' || tests.q('admin', $q$ select (public.reserve_document_file(gen_random_uuid(), :G1, gen_random_uuid(), 'application/pdf', 10)).id $q$),
  'not_found not_found', 'ほかの年度の提出物とない提出物は、どちらも not_found（detail なし）');
select is(tests.q('rep2', $q$ select (public.submit_document(:DOC_NOFILE, :G1, null)).status $q$)
          || ' ' || tests.q('rep2', $q$ select (public.submit_document(gen_random_uuid(), :G1, null)).status $q$),
  'forbidden forbidden', 'ほかの団体には、ある提出物でもない提出物でも forbidden');
select is(tests.q('staff', $q$ select (public.approve_document(:DOC_STALL, :G1, 'x', null)).status $q$)
          || ' ' || tests.q('staff', $q$ select (public.approve_document(gen_random_uuid(), gen_random_uuid(), 'x', null)).status $q$),
  'forbidden forbidden', '部門員の承認は、ある提出でもない提出でも forbidden');
-- 例外の直し：テスト用のトリガーで書き込みにエラーを起こす（tests.raise に「表:SQLSTATE[:制約の名前]」を置いたときだけ）
create function tests.tg_raise() returns trigger language plpgsql as $$
declare v text[] := string_to_array(nullif(current_setting('tests.raise', true), ''), ':');
begin
  if v[1] = tg_table_name then
    if v[3] is not null then
      raise exception 'tests.raise' using errcode = v[2], constraint = v[3];
    end if;
    raise exception 'tests.raise' using errcode = v[2];
  end if;
  return new;
end $$;
create trigger zz_tests_raise before insert on public.document_files for each row execute function tests.tg_raise();
create trigger zz_tests_raise before update on public.document_submissions for each row execute function tests.tg_raise();
create trigger zz_tests_raise before insert on public.documents for each row execute function tests.tg_raise();
select is(tests.q('head', $q$ select (public.reserve_document_file(:DOC_NOFILE, :G1, gen_random_uuid(), 'application/pdf', 10)).id $q$,
                  $q$ select set_config('tests.raise', 'document_files:23503', true) $q$), 'not_found',
  '予約：ファイルの insert の外部キーの違反（確かめた後に提出物・団体が消えた）→ not_found');
select is(tests.q('head', $q$ select (public.reserve_document_file(:DOC_NOFILE, :G1, gen_random_uuid(), 'application/pdf', 10)).id $q$,
                  $q$ select set_config('tests.raise', 'document_files:23505', true) $q$),
  tests.e('invalid_input', '{"field": "file_id", "reason": "in_use"}'), '予約：一意の違反（同じ id がほかの提出に同時に入った）→ file_id・in_use');
select is(tests.q('head', $q$ select (public.reserve_document_file(:DOC_NOFILE, :G1, gen_random_uuid(), 'application/pdf', 10)).id $q$,
                  $q$ select set_config('tests.raise', 'document_files:23514:document_files_size_check', true) $q$),
  tests.e('invalid_input', '{"field": "size"}'), '予約：大きさの CHECK の違反 → size');
select is(tests.q('head', $q$ select (public.reserve_document_file(:DOC_NOFILE, :G1, gen_random_uuid(), 'application/pdf', 10)).id $q$,
                  $q$ select set_config('tests.raise', 'document_files:23514:document_files_content_type_check', true) $q$),
  tests.e('invalid_input', '{"field": "content_type"}'), '予約：形の CHECK の違反 → content_type');
select is(tests.q('head', $q$ select (public.reserve_document_file(:DOC_NOFILE, :G1, gen_random_uuid(), 'application/pdf', 10)).id $q$,
                  $q$ select set_config('tests.raise', 'document_files:23514:document_files_object_path_check', true) $q$),
  tests.e('invalid_input', '{"field": "file_id"}'), '予約：ほかの CHECK の違反 → file_id');
select is(tests.q('head', $q$ select (public.reserve_document_file(:DOC_NOFILE, :G1, gen_random_uuid(), 'application/pdf', 10)).id $q$,
                  $q$ select set_config('tests.raise', 'document_files:22001', true) $q$),
  tests.e('invalid_input', '{"field": "file_id"}'), '予約：クラス 22 の誤り → file_id');
select is(tests.q('rep2', $q$ select (public.submit_document(:DOC_STALL, :G2, tests.sub_ts('DOC_STALL', 'G2'))).status $q$,
                  $q$ select set_config('tests.raise', 'document_submissions:23514', true);
                      insert into public.document_files (id, year_id, document_id, group_id, object_path, content_type, size)
                      values (:F6, :Y1, :DOC_STALL, :G2, tests.doc_path('Y1', 'G2', 'DOC_STALL', 'F6'), 'application/pdf', 1);
                      insert into storage.objects (bucket_id, name, metadata) values ('documents', tests.doc_path('Y1', 'G2', 'DOC_STALL', 'F6'), '{"size": 1}') $q$),
  tests.e('invalid_input', '{"field": "document_id"}'), '提出：CHECK の違反 → document_id');
select is(tests.q('rep2', $q$ select (public.submit_document(:DOC_STALL, :G2, tests.sub_ts('DOC_STALL', 'G2'))).status $q$,
                  $q$ select set_config('tests.raise', 'document_submissions:23503', true);
                      insert into public.document_files (id, year_id, document_id, group_id, object_path, content_type, size)
                      values (:F6, :Y1, :DOC_STALL, :G2, tests.doc_path('Y1', 'G2', 'DOC_STALL', 'F6'), 'application/pdf', 1);
                      insert into storage.objects (bucket_id, name, metadata) values ('documents', tests.doc_path('Y1', 'G2', 'DOC_STALL', 'F6'), '{"size": 1}') $q$),
  'not_found', '提出：外部キーの違反 → not_found');
select is(tests.q('rep2', $q$ select (public.submit_document(:DOC_STALL, :G2, tests.sub_ts('DOC_STALL', 'G2'))).status $q$,
                  $q$ select set_config('tests.raise', 'document_submissions:22003', true);
                      insert into public.document_files (id, year_id, document_id, group_id, object_path, content_type, size)
                      values (:F6, :Y1, :DOC_STALL, :G2, tests.doc_path('Y1', 'G2', 'DOC_STALL', 'F6'), 'application/pdf', 1);
                      insert into storage.objects (bucket_id, name, metadata) values ('documents', tests.doc_path('Y1', 'G2', 'DOC_STALL', 'F6'), '{"size": 1}') $q$),
  tests.e('invalid_input', '{"field": "document_id"}'), '提出：クラス 22 の誤り → document_id');
select is(tests.q('head', $q$ select (public.approve_document(:DOC_STALL, :G1, null, tests.sub_ts('DOC_STALL', 'G1'))).status $q$,
                  $q$ select set_config('tests.raise', 'document_submissions:23514:document_submissions_review_note_check', true) $q$),
  tests.e('invalid_input', '{"field": "note"}'), '承認：理由・メモの CHECK の違反 → note');
select is(tests.q('head', $q$ select (public.approve_document(:DOC_STALL, :G1, null, tests.sub_ts('DOC_STALL', 'G1'))).status $q$,
                  $q$ select set_config('tests.raise', 'document_submissions:23514:document_submissions_status_check', true) $q$),
  tests.e('invalid_input', '{"field": "document_id"}'), '承認：ほかの CHECK の違反 → document_id');
select is(tests.q('head', $q$ select (public.approve_document(:DOC_STALL, :G1, null, tests.sub_ts('DOC_STALL', 'G1'))).status $q$,
                  $q$ select set_config('tests.raise', 'document_submissions:22001', true) $q$),
  tests.e('invalid_input', '{"field": "note"}'), '承認：クラス 22 の誤り → note');
select is(tests.q('head', $q$ select (public.approve_document(:DOC_STALL, :G1, null, tests.sub_ts('DOC_STALL', 'G1'))).status $q$,
                  $q$ select set_config('tests.raise', 'document_submissions:23503', true) $q$),
  'not_found', '承認：外部キーの違反 → not_found');
select is(tests.q('head', $q$ select (public.return_document(:DOC_STALL, :G1, 'x', tests.sub_ts('DOC_STALL', 'G1'))).status $q$,
                  $q$ select set_config('tests.raise', 'document_submissions:23514:document_submissions_review_note_check', true) $q$),
  tests.e('invalid_input', '{"field": "note"}'), '差し戻し：理由の CHECK の違反 → note');
select is(tests.q('head', $q$ select (public.return_document(:DOC_STALL, :G1, 'x', tests.sub_ts('DOC_STALL', 'G1'))).status $q$,
                  $q$ select set_config('tests.raise', 'document_submissions:23514', true) $q$),
  tests.e('invalid_input', '{"field": "document_id"}'), '差し戻し：ほかの CHECK の違反 → document_id');
select is(tests.q('head', $q$ select (public.return_document(:DOC_STALL, :G1, 'x', tests.sub_ts('DOC_STALL', 'G1'))).status $q$,
                  $q$ select set_config('tests.raise', 'document_submissions:22001', true) $q$),
  tests.e('invalid_input', '{"field": "note"}'), '差し戻し：クラス 22 の誤り → note');
select is(tests.q('head', $q$ select count(*) from public.copy_previous_documents(:Y1, array[:DOC_Y2]) $q$,
                  $q$ delete from public.documents where year_id = :Y1 and title = 'T-DOC_Y2';
                      select set_config('tests.raise', 'documents:23514:documents_deadline_check', true) $q$),
  tests.e('invalid_input', '{"field": "document_ids", "reason": "deadline_out_of_range"}'), '写す：締切の CHECK の違反 → deadline_out_of_range');
select is(tests.q('head', $q$ select count(*) from public.copy_previous_documents(:Y1, array[:DOC_Y2]) $q$,
                  $q$ delete from public.documents where year_id = :Y1 and title = 'T-DOC_Y2';
                      select set_config('tests.raise', 'documents:23514:documents_title_check', true) $q$),
  tests.e('invalid_input', '{"field": "document_ids", "reason": "invalid"}'), '写す：ほかの CHECK の違反 → invalid');
select is(tests.q('head', $q$ select count(*) from public.copy_previous_documents(:Y1, array[:DOC_Y2]) $q$,
                  $q$ delete from public.documents where year_id = :Y1 and title = 'T-DOC_Y2';
                      select set_config('tests.raise', 'documents:22008', true) $q$),
  tests.e('invalid_input', '{"field": "document_ids", "reason": "invalid"}'), '写す：クラス 22 の誤り → invalid');
-- 途中で失敗すると何も変わらない（予約の失敗で、作りかけた提出の行も残さない）
select coalesce(max(id), 0) as m9 from public.audit_logs \gset
select set_config('tests.raise', 'document_files:23503', true);
select is(tests.run('rep', $q$ select (public.reserve_document_file(:DOC_FOOD, :G1, gen_random_uuid(), 'application/pdf', 10)).id $q$), 'not_found',
  '（準備）飲食だけの提出物は G1 が対象でない');
update public.groups set is_food = true where id = tests.id('G1');
select is(tests.run('rep', $q$ select (public.reserve_document_file(:DOC_FOOD, :G1, gen_random_uuid(), 'application/pdf', 10)).id $q$), 'not_found',
  '予約：ファイルの insert で失敗すると not_found');
select set_config('tests.raise', '', true);
select is((select count(*)::int from public.document_submissions where document_id = tests.id('DOC_FOOD')) || ' ' || tests.audit_since(:m9), '0 ',
  '失敗した予約は、作りかけた提出の行も監査も残さない');
-- anon は RPC を呼べない
select tests.login_anon();
select throws_ok($q$ select public.reserve_document_file(gen_random_uuid(), gen_random_uuid(), gen_random_uuid(), 'application/pdf', 1) $q$, '42501', null,
  'anon は reserve_document_file を呼べない');
select throws_ok($q$ select public.document_orphan_paths(gen_random_uuid()) $q$, '42501', null, 'anon は document_orphan_paths を呼べない');
select tests.logout();

select * from finish();
rollback;
