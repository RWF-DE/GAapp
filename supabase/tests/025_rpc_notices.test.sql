-- 025_rpc_notices：お知らせの RPC（save_notice・delete_notice）と読み取り（T17。D-53。0014_notices.sql）
-- 期待値は 02 の「お知らせの権限」と notes/T17.md の「SQL の約束」（save_notice のエラーの順番 1〜10、delete_notice の 1〜6）から
-- 先に書いてから流した。
-- ① 段の表：RPC を admin・head・deputy・staff・viewer・rep・outsider・admin2 で1回ずつ試して取り消す（tests.try_rpc。024 と同じ形）。
--    yn は列の順（admin head staff viewer rep outsider admin2）に、空白で区切った7つの結果。deputy は head の列で確かめ、実際の結果どうしも
--    比べる。略号：ok、F＝forbidden、NF＝not_found、IS＝invalid_state、II＝invalid_input、CF＝conflict。
-- ② 読み取り：ペルソナごとに見えるお知らせと宛先の団体（fixture の名前で全部比べる。終了の年度も同じ）。
-- ③ save_notice のエラーの順番と detail（tests.error_json）と、題名・本文の空白の扱い。
-- ④ 楽観ロック（ミリ秒までで比べる。detail は id）。
-- ⑤ 作る・直すの中身：返り値の行、書いた人・直した人、宛先の団体の差分の入れ替え、宛先の付け替え、監査の理由。
-- ⑥ ピン留め、書いた人のアカウントがない、ロールを外された人、部門長以上だった人（判断 11）。
-- ⑦ not_found と forbidden（読めないお知らせの有無を漏らさない）。
-- ⑧ 終了の年度は読むだけ（detail は状態）。
-- ⑨ 1回で入れ替える（途中で失敗したら何も変わらない）と、例外の直し（D-19。外部キー・CHECK・クラス 22）。
-- ⑩ 消す（宛先の団体の行も消える、監査の理由、楽観ロック）と、団体の削除で宛先の団体が 0 になった指定の団体あて。
-- ペルソナ（fixture）：admin・head・deputy・staff・viewer は Y1 のロール。rep は G1（Y1）の店長で Y2 の viewer、rep2 は G2（Y1）の店長、
-- viewer は G4（Y1）の副店長も兼ねる。staff は G3（Y2）の店長（Y2 では総務でない）。admin2 は Y2（preparing）の admin。outsider は何もない。
-- お知らせ（fixture）：Y1 の N_SOUMU（総務内。staff）・N_ALL（全団体。head・ピン留め）・N_G1（G1 あて。head）・N_G12（G1・G2 あて。deputy）・
-- N_G4（G4 あて。admin）、Y2 の N_Y2_SOUMU・N_Y2_ALL・N_Y2_G3（G3 あて。どれも admin2）。
begin;
\ir _helpers/personas.psql
\ir _helpers/fixture.psql

-- 025 だけで使うお知らせ：staff が書いて部門長以上がピン留めした総務内（N_SOUMU_PIN）、deputy が書いた総務内（N_SOUMU_DEP）
with n as (
  insert into public.notices (year_id, audience, title, pinned, created_by, updated_by) values
    (tests.id('Y1'), 'soumu', 'T-N_SOUMU_PIN', true, tests.id('staff'), tests.id('head')),
    (tests.id('Y1'), 'soumu', 'T-N_SOUMU_DEP', false, tests.id('deputy'), tests.id('deputy'))
  returning id, title)
insert into tests.ids select substr(title, 3), id from n;

-- お知らせの今の updated_at（RLS を通らない。段の表で、読めない人にも同じ引数を渡すため）
create function tests.notice_ts(p_name text) returns timestamptz language sql stable security definer set search_path = '' as $$
  select n.updated_at from public.notices n where n.id = (select t.id from tests.ids t where t.name = p_name)
$$;
grant execute on function tests.notice_ts(text) to authenticated;

-- JavaScript の String.prototype.trim が除く 25 文字（Node で U+0000〜U+10FFFF を全部数えた。T17A-1）。0014 の notices_title_check と
-- save_notice の c_space はこの文字を除く（CHECK がちょうどこの文字を拒むことは、001 が CHECK の式を BMP の全部の文字に当てて確かめる）
create function tests.js_space_codes() returns int[] language sql immutable as $$
  select array[0x09, 0x0a, 0x0b, 0x0c, 0x0d, 0x20, 0xa0, 0x1680, 0x2000, 0x2001, 0x2002, 0x2003, 0x2004, 0x2005, 0x2006, 0x2007,
               0x2008, 0x2009, 0x200a, 0x2028, 0x2029, 0x202f, 0x205f, 0x3000, 0xfeff]
$$;
create function tests.js_space() returns text language sql immutable as $$
  select string_agg(chr(c), '' order by c) from unnest(tests.js_space_codes()) c
$$;
grant execute on function tests.js_space_codes(), tests.js_space() to authenticated;

-- ペルソナに切り替えて、見えるお知らせと宛先の団体を名前で並べる（名前のないお知らせは数えない）
create function tests.visible_notices(p_persona text) returns text language plpgsql as $$
declare v text;
begin
  perform tests.login_as(p_persona);
  select format('%s | %s',
    coalesce((select string_agg(t.name, ' ' order by t.name collate "C") from public.notices n join tests.ids t on t.id = n.id), '-'),
    coalesce((select string_agg(tn.name || ':' || tg.name, ' ' order by tn.name collate "C", tg.name collate "C")
              from public.notice_groups ng join tests.ids tn on tn.id = ng.notice_id join tests.ids tg on tg.id = ng.group_id), '-'))
  into v;
  perform tests.logout();
  return v;
end $$;

-- ペルソナがそのお知らせを読めるか
create function tests.can_read(p_persona text, p_name text) returns boolean language plpgsql as $$
declare v boolean;
begin
  perform tests.login_as(p_persona);
  select exists (select 1 from public.notices n where n.id = (select t.id from tests.ids t where t.name = p_name)) into v;
  perform tests.logout();
  return v;
end $$;

-- 監査の行（お知らせの2表）を「表 操作 団体 理由」で並べる（id が p_mark より後のもの。団体は宛先の団体の名前、お知らせは -）
create function tests.audit_since(p_mark bigint) returns text language sql stable as $$
  select coalesce(string_agg(format('%s %s %s %s', a.table_name, a.action, coalesce(g.name, '-'), coalesce(a.reason, 'null')), ', '
                             order by a.table_name collate "C", a.action collate "C", g.name collate "C"), '')
  from public.audit_logs a left join tests.ids g on g.id = a.group_id
  where a.id > p_mark and a.table_name in ('notices', 'notice_groups')
$$;

-- お知らせの宛先の団体の名前
create function tests.notice_group_names(p_name text) returns text language sql stable as $$
  select coalesce(string_agg(t.name, ' ' order by t.name collate "C"), '')
  from public.notice_groups ng join tests.ids t on t.id = ng.group_id
  where ng.notice_id = (select id from tests.ids where name = p_name)
$$;

-- ================================================================ ① 段の表
create table tests.rpc_case (n int primary key, label text not null, scenario text not null, template text not null, yn text not null);
insert into tests.rpc_case values
 -- 作る：総務内は総務、全団体・指定の団体とピン留めは部門長以上。終了の年度は読むだけ（総務でない人は forbidden が先）。確定中も書ける
 ( 1, '総務内を出す', 'requesting', $t$ select public.save_notice(:Y1, 'soumu', 'T-段') $t$, 'ok ok ok F F F F'),
 ( 2, '総務内を出す（準備中）', 'preparing', $t$ select public.save_notice(:Y1, 'soumu', 'T-段') $t$, 'ok ok ok F F F F'),
 ( 3, '総務内を出す（締切後）', 'requesting:after', $t$ select public.save_notice(:Y1, 'soumu', 'T-段') $t$, 'ok ok ok F F F F'),
 ( 4, '総務内を出す（振り分け中）', 'allocating', $t$ select public.save_notice(:Y1, 'soumu', 'T-段') $t$, 'ok ok ok F F F F'),
 ( 5, '総務内を出す（確定中）', 'confirmed', $t$ select public.save_notice(:Y1, 'soumu', 'T-段') $t$, 'ok ok ok F F F F'),
 ( 6, '総務内を出す（終了）', 'closed', $t$ select public.save_notice(:Y1, 'soumu', 'T-段') $t$, 'IS IS IS F F F F'),
 ( 7, '全団体あてを出す', 'requesting', $t$ select public.save_notice(:Y1, 'all_groups', 'T-段') $t$, 'ok ok F F F F F'),
 ( 8, '全団体あてを出す（確定中）', 'confirmed', $t$ select public.save_notice(:Y1, 'all_groups', 'T-段') $t$, 'ok ok F F F F F'),
 ( 9, '全団体あてを出す（終了）', 'closed', $t$ select public.save_notice(:Y1, 'all_groups', 'T-段') $t$, 'IS IS IS F F F F'),
 (10, '指定の団体あてを出す', 'requesting', $t$ select public.save_notice(:Y1, 'groups', 'T-段', null, false, array[:G1, :G2]) $t$, 'ok ok F F F F F'),
 (11, '指定の団体あてを出す（終了）', 'closed', $t$ select public.save_notice(:Y1, 'groups', 'T-段', null, false, array[:G1, :G2]) $t$, 'IS IS IS F F F F'),
 (12, 'ピン留めして総務内を出す', 'requesting', $t$ select public.save_notice(:Y1, 'soumu', 'T-段', null, true) $t$, 'ok ok F F F F F'),
 (13, 'Y2 に総務内を出す', 'requesting', $t$ select public.save_notice(:Y2, 'soumu', 'T-段') $t$, 'F F F F F F ok'),
 (14, 'Y2 に指定の団体あて（G3）を出す', 'requesting', $t$ select public.save_notice(:Y2, 'groups', 'T-段', null, false, array[:G3]) $t$, 'F F F F F F ok'),
 (15, 'ない年度に出す', 'requesting', $t$ select public.save_notice(gen_random_uuid(), 'soumu', 'T-段') $t$, 'F F F F F F F'),
 -- 直す：直した後の宛先の段と、書いた人か部門長以上（ピン留めを変えるのは部門長以上）。全部の欄を置き換える
 (16, '自分の総務内を直す（staff が書いた）', 'requesting',
  $t$ select public.save_notice(:Y1, 'soumu', 'T-直す', null, false, '{}', :N_SOUMU, tests.notice_ts('N_SOUMU')) $t$, 'ok ok ok F F F F'),
 (17, 'ほかの人の総務内を直す（deputy が書いた）', 'requesting',
  $t$ select public.save_notice(:Y1, 'soumu', 'T-直す', null, false, '{}', :N_SOUMU_DEP, tests.notice_ts('N_SOUMU_DEP')) $t$, 'ok ok F F F F F'),
 (18, '自分の総務内を全団体あてに変える（staff が書いた）', 'requesting',
  $t$ select public.save_notice(:Y1, 'all_groups', 'T-直す', null, false, '{}', :N_SOUMU, tests.notice_ts('N_SOUMU')) $t$, 'ok ok F F F F F'),
 (19, '自分の総務内を指定の団体あてに変える（staff が書いた）', 'requesting',
  $t$ select public.save_notice(:Y1, 'groups', 'T-直す', null, false, array[:G1], :N_SOUMU, tests.notice_ts('N_SOUMU')) $t$, 'ok ok F F F F F'),
 (20, '全団体あてをピン留めのまま直す（head が書いた）', 'requesting',
  $t$ select public.save_notice(:Y1, 'all_groups', 'T-直す', null, true, '{}', :N_ALL, tests.notice_ts('N_ALL')) $t$, 'ok ok F F F F F'),
 (21, '全団体あてを総務内に変える（head が書いた）', 'requesting',
  $t$ select public.save_notice(:Y1, 'soumu', 'T-直す', null, true, '{}', :N_ALL, tests.notice_ts('N_ALL')) $t$, 'ok ok F F F F F'),
 (22, '指定の団体あての宛先の団体を変える（deputy が書いた）', 'requesting',
  $t$ select public.save_notice(:Y1, 'groups', 'T-直す', null, false, array[:G2, :G4], :N_G12, tests.notice_ts('N_G12')) $t$, 'ok ok F F F F F'),
 (23, '指定の団体あてを総務内に変える（deputy が書いた）', 'requesting',
  $t$ select public.save_notice(:Y1, 'soumu', 'T-直す', null, false, '{}', :N_G12, tests.notice_ts('N_G12')) $t$, 'ok ok F F F F F'),
 (24, 'ピン留めを付ける（staff が書いた総務内）', 'requesting',
  $t$ select public.save_notice(:Y1, 'soumu', 'T-直す', null, true, '{}', :N_SOUMU, tests.notice_ts('N_SOUMU')) $t$, 'ok ok F F F F F'),
 (25, 'ピン留めを外す（staff が書いた総務内）', 'requesting',
  $t$ select public.save_notice(:Y1, 'soumu', 'T-直す', null, false, '{}', :N_SOUMU_PIN, tests.notice_ts('N_SOUMU_PIN')) $t$, 'ok ok F F F F F'),
 (26, 'ピン留めのまま直す（staff が書いた総務内）', 'requesting',
  $t$ select public.save_notice(:Y1, 'soumu', 'T-直す', null, true, '{}', :N_SOUMU_PIN, tests.notice_ts('N_SOUMU_PIN')) $t$, 'ok ok ok F F F F'),
 (27, '直す（確定中）', 'confirmed',
  $t$ select public.save_notice(:Y1, 'soumu', 'T-直す', null, false, '{}', :N_SOUMU, tests.notice_ts('N_SOUMU')) $t$, 'ok ok ok F F F F'),
 (28, '直す（終了）', 'closed',
  $t$ select public.save_notice(:Y1, 'soumu', 'T-直す', null, false, '{}', :N_SOUMU, tests.notice_ts('N_SOUMU')) $t$, 'IS IS IS F F F F'),
 (29, 'ないお知らせを直す', 'requesting',
  $t$ select public.save_notice(:Y1, 'soumu', 'T-直す', null, false, '{}', gen_random_uuid(), now()) $t$, 'NF NF NF F F F F'),
 (30, 'Y2 のお知らせを Y1 として直す', 'requesting',
  $t$ select public.save_notice(:Y1, 'soumu', 'T-直す', null, false, '{}', :N_Y2_SOUMU, tests.notice_ts('N_Y2_SOUMU')) $t$, 'NF NF NF F F F F'),
 (31, 'Y1 のお知らせを Y2 として直す', 'requesting',
  $t$ select public.save_notice(:Y2, 'soumu', 'T-直す', null, false, '{}', :N_SOUMU, tests.notice_ts('N_SOUMU')) $t$, 'F F F F F F NF'),
 (32, 'Y2 のお知らせを直す', 'requesting',
  $t$ select public.save_notice(:Y2, 'soumu', 'T-直す', null, false, '{}', :N_Y2_SOUMU, tests.notice_ts('N_Y2_SOUMU')) $t$, 'F F F F F F ok'),
 (33, '古い版で直す（staff が書いた総務内）', 'requesting',
  $t$ select public.save_notice(:Y1, 'soumu', 'T-直す', null, false, '{}', :N_SOUMU, tests.notice_ts('N_SOUMU') - interval '1 second') $t$,
  'CF CF CF F F F F'),
 (34, '古い版で直す（deputy が書いた総務内。書いた人の確かめが先）', 'requesting',
  $t$ select public.save_notice(:Y1, 'soumu', 'T-直す', null, false, '{}', :N_SOUMU_DEP, tests.notice_ts('N_SOUMU_DEP') - interval '1 second') $t$,
  'CF CF F F F F F'),
 -- 消す：書いた人か部門長以上。お知らせがない・その年度の総務でないは forbidden（有無を漏らさない）。終了の年度は消せない
 (35, '自分の総務内を消す（staff が書いた）', 'requesting', $t$ select public.delete_notice(:N_SOUMU, tests.notice_ts('N_SOUMU')) $t$, 'ok ok ok F F F F'),
 (36, 'ほかの人の総務内を消す（deputy が書いた）', 'requesting',
  $t$ select public.delete_notice(:N_SOUMU_DEP, tests.notice_ts('N_SOUMU_DEP')) $t$, 'ok ok F F F F F'),
 (37, '全団体あてを消す（head が書いた）', 'requesting', $t$ select public.delete_notice(:N_ALL, tests.notice_ts('N_ALL')) $t$, 'ok ok F F F F F'),
 (38, '指定の団体あてを消す（deputy が書いた）', 'requesting', $t$ select public.delete_notice(:N_G12, tests.notice_ts('N_G12')) $t$, 'ok ok F F F F F'),
 (39, 'ピン留めの付いた自分の総務内を消す（staff が書いた）', 'requesting',
  $t$ select public.delete_notice(:N_SOUMU_PIN, tests.notice_ts('N_SOUMU_PIN')) $t$, 'ok ok ok F F F F'),
 (40, '消す（確定中）', 'confirmed', $t$ select public.delete_notice(:N_SOUMU, tests.notice_ts('N_SOUMU')) $t$, 'ok ok ok F F F F'),
 (41, '消す（終了）', 'closed', $t$ select public.delete_notice(:N_SOUMU, tests.notice_ts('N_SOUMU')) $t$, 'IS IS IS F F F F'),
 (42, 'ないお知らせを消す', 'requesting', $t$ select public.delete_notice(gen_random_uuid(), now()) $t$, 'F F F F F F F'),
 (43, 'Y2 のお知らせを消す', 'requesting', $t$ select public.delete_notice(:N_Y2_ALL, tests.notice_ts('N_Y2_ALL')) $t$, 'F F F F F F ok'),
 (44, '版なしで消す', 'requesting', $t$ select public.delete_notice(:N_SOUMU, null) $t$, 'II II II F F F F'),
 (45, '古い版で消す（staff が書いた）', 'requesting',
  $t$ select public.delete_notice(:N_SOUMU, tests.notice_ts('N_SOUMU') - interval '1 second') $t$, 'CF CF CF F F F F'),
 (46, '古い版で消す（deputy が書いた。書いた人の確かめが先）', 'requesting',
  $t$ select public.delete_notice(:N_SOUMU_DEP, tests.notice_ts('N_SOUMU_DEP') - interval '1 second') $t$, 'CF CF F F F F F');

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

select plan((select count(*)::int from tests.rpc_cells) + 3 + 141);

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

-- ================================================================ ② 読み取り（ペルソナごとに見えるお知らせ | 宛先の団体）
-- 総務はその年度の全部。閲覧のみはその年度の団体あて（総務内は読めない）。団体の代表は代表である年度の全団体あてと、自団体を宛先に
-- 含む指定の団体あてで、宛先の団体は自団体の行だけ（N_G12 の rep は G1 の行、rep2 は G2 の行）。ほかの人は何も読めない
select is(tests.visible_notices('admin'),
  'N_ALL N_G1 N_G12 N_G4 N_SOUMU N_SOUMU_DEP N_SOUMU_PIN | N_G1:G1 N_G12:G1 N_G12:G2 N_G4:G4', 'admin：Y1 の全部');
select is(tests.visible_notices('head'),
  'N_ALL N_G1 N_G12 N_G4 N_SOUMU N_SOUMU_DEP N_SOUMU_PIN | N_G1:G1 N_G12:G1 N_G12:G2 N_G4:G4', 'head：Y1 の全部');
select is(tests.visible_notices('deputy'),
  'N_ALL N_G1 N_G12 N_G4 N_SOUMU N_SOUMU_DEP N_SOUMU_PIN | N_G1:G1 N_G12:G1 N_G12:G2 N_G4:G4', 'deputy：Y1 の全部');
select is(tests.visible_notices('staff'),
  'N_ALL N_G1 N_G12 N_G4 N_SOUMU N_SOUMU_DEP N_SOUMU_PIN N_Y2_ALL N_Y2_G3 | N_G1:G1 N_G12:G1 N_G12:G2 N_G4:G4 N_Y2_G3:G3',
  'staff：Y1 の全部と、Y2 の G3 の店長として Y2 の全団体あてと G3 あて（Y2 の総務内は読めない）');
select is(tests.visible_notices('viewer'),
  'N_ALL N_G1 N_G12 N_G4 | N_G1:G1 N_G12:G1 N_G12:G2 N_G4:G4', 'viewer：Y1 の団体あてと、その宛先の団体の全部（総務内は読めない）');
select is(tests.visible_notices('rep'),
  'N_ALL N_G1 N_G12 N_Y2_ALL N_Y2_G3 | N_G1:G1 N_G12:G1 N_Y2_G3:G3',
  'rep：Y1 の全団体あてと G1 あて（G1・G2 あての宛先の団体は G1 の行だけ。G4 あては読めない）と、Y2 の閲覧のみとして Y2 の団体あて');
select is(tests.visible_notices('rep2'), 'N_ALL N_G12 | N_G12:G2', 'rep2：Y1 の全団体あてと G2 を含む N_G12（宛先の団体は G2 の行だけ）');
select is(tests.visible_notices('outsider'), '- | -', 'outsider：何も読めない');
select is(tests.visible_notices('admin2'), 'N_Y2_ALL N_Y2_G3 N_Y2_SOUMU | N_Y2_G3:G3', 'admin2：Y2 の全部（Y1 は読めない）');
-- 読み取りは年度の状態によらない（終了の年度も読める）
select tests.set_scenario('closed');
select is(tests.visible_notices('viewer'), 'N_ALL N_G1 N_G12 N_G4 | N_G1:G1 N_G12:G1 N_G12:G2 N_G4:G4', '終了の年度でも viewer は同じだけ読める');
select is(tests.visible_notices('rep'), 'N_ALL N_G1 N_G12 N_Y2_ALL N_Y2_G3 | N_G1:G1 N_G12:G1 N_Y2_G3:G3', '終了の年度でも rep は同じだけ読める');
select is(tests.visible_notices('staff'),
  'N_ALL N_G1 N_G12 N_G4 N_SOUMU N_SOUMU_DEP N_SOUMU_PIN N_Y2_ALL N_Y2_G3 | N_G1:G1 N_G12:G1 N_G12:G2 N_G4:G4 N_Y2_G3:G3',
  '終了の年度でも staff は同じだけ読める');
select tests.set_scenario('requesting');
-- anon は読めない
select tests.login_anon();
select throws_ok($q$ select count(*) from public.notices $q$, '42501', null, 'anon は notices を読めない');
select throws_ok($q$ select count(*) from public.notice_groups $q$, '42501', null, 'anon は notice_groups を読めない');
select throws_ok($q$ select public.save_notice(gen_random_uuid(), 'soumu', 'x') $q$, '42501', null, 'anon は save_notice を呼べない');
select tests.logout();

-- ================================================================ ③ save_notice のエラーの順番と detail（staff。Y1 は受付中）
-- 1. ロールと状態：その年度の総務でない・年度がない → forbidden（入力の誤りより先）。終了 → invalid_state（detail は状態。入力より先）
select tests.login_as('outsider');
select is(tests.error_json(tests.sql($q$ select public.save_notice(:Y1, null, null) $q$)), '{"code": "forbidden", "detail": null}'::jsonb,
  'その年度の総務でなければ、入力が誤っていても forbidden（detail なし）');
select tests.logout();
select tests.login_as('staff');
select is(tests.error_json($q$ select public.save_notice(null, 'soumu', 'T-x') $q$), '{"code": "forbidden", "detail": null}'::jsonb,
  '年度が null なら forbidden');
select tests.logout();
select tests.set_scenario('closed');
select tests.login_as('staff');
select is(tests.error_json(tests.sql($q$ select public.save_notice(:Y1, null, null) $q$)),
  '{"code": "invalid_state", "detail": {"status": "closed"}}'::jsonb, '終了の年度は、入力が誤っていても invalid_state（detail は状態）');
select tests.logout();
select tests.set_scenario('requesting');
-- 2. 入力：audience → title → body → pinned → group_ids → base_updated_at の順
select tests.login_as('staff');
select is(tests.error_json(tests.sql($q$ select public.save_notice(:Y1, null, null) $q$)),
  '{"code": "invalid_input", "detail": {"field": "audience"}}'::jsonb, '宛先が null → audience（題名より先）');
select is(tests.error_json(tests.sql($q$ select public.save_notice(:Y1, 'soumu', null) $q$)),
  '{"code": "invalid_input", "detail": {"field": "title"}}'::jsonb, '題名が null → title');
select is(tests.error_json(tests.sql($q$ select public.save_notice(:Y1, 'soumu', '') $q$)),
  '{"code": "invalid_input", "detail": {"field": "title"}}'::jsonb, '題名が空 → title');
select is(tests.error_json(tests.sql($q$ select public.save_notice(:Y1, 'soumu', E' \t\n\r\u3000') $q$)),
  '{"code": "invalid_input", "detail": {"field": "title"}}'::jsonb, '題名が空白だけ（タブ・改行・全角の空白） → title');
-- 除く空白は JavaScript の trim と同じ 25 文字（T17A-1）：U+00A0 だけ・垂直タブだけの題名も、25 文字のどれか1字だけの題名も title
select is(tests.error_json(tests.sql($q$ select public.save_notice(:Y1, 'soumu', E'\u00a0') $q$)),
  '{"code": "invalid_input", "detail": {"field": "title"}}'::jsonb, '題名がノーブレークスペース（U+00A0）だけ → title（T17A-1）');
select is(tests.error_json(tests.sql($q$ select public.save_notice(:Y1, 'soumu', E'\u000b') $q$)),
  '{"code": "invalid_input", "detail": {"field": "title"}}'::jsonb, '題名が垂直タブ（U+000B）だけ → title（T17A-1）');
select is((select coalesce(string_agg(to_hex(c), ' ' order by c), '') from unnest(tests.js_space_codes()) c
           where tests.error_json(tests.sql(format($q$ select public.save_notice(:Y1, 'soumu', %L) $q$, chr(c))))
                 <> '{"code": "invalid_input", "detail": {"field": "title"}}'::jsonb),
  '', 'JavaScript の trim が除く 25 文字のどれか1字だけの題名は、どれも title（T17A-1）');
select is(tests.error_json(tests.sql($q$ select public.save_notice(:Y1, 'soumu', repeat('あ', 101)) $q$)),
  '{"code": "invalid_input", "detail": {"field": "title"}}'::jsonb, '題名が 101 字 → title');
select is(tests.error_json(tests.sql($q$ select public.save_notice(:Y1, 'soumu', '', repeat('あ', 4001)) $q$)),
  '{"code": "invalid_input", "detail": {"field": "title"}}'::jsonb, '題名と本文の両方が誤り → title が先');
select is(tests.error_json(tests.sql($q$ select public.save_notice(:Y1, 'soumu', 'T-本文', repeat('あ', 4001)) $q$)),
  '{"code": "invalid_input", "detail": {"field": "body"}}'::jsonb, '本文が 4001 字 → body');
select is(tests.error_json(tests.sql($q$ select public.save_notice(:Y1, 'groups', 'T-順', repeat('あ', 4001), false, '{}') $q$)),
  '{"code": "invalid_input", "detail": {"field": "body"}}'::jsonb, '本文と宛先の団体の両方が誤り → body が先');
select is(tests.error_json(tests.sql($q$ select public.save_notice(:Y1, 'soumu', 'T-ピン', null, null) $q$)),
  '{"code": "invalid_input", "detail": {"field": "pinned"}}'::jsonb, 'ピン留めが null → pinned');
select is(tests.error_json(tests.sql($q$ select public.save_notice(:Y1, 'soumu', 'T-順', null, null, array[:G1]) $q$)),
  '{"code": "invalid_input", "detail": {"field": "pinned"}}'::jsonb, 'ピン留めと宛先の団体の両方が誤り → pinned が先');
select is(tests.error_json(tests.sql($q$ select public.save_notice(:Y1, 'groups', 'T-宛先', null, false, '{}') $q$)),
  '{"code": "invalid_input", "detail": {"field": "group_ids", "reason": "required"}}'::jsonb,
  '指定の団体あてで団体が 0 → required（staff でも、段の forbidden より先）');
select is(tests.error_json(tests.sql($q$ select public.save_notice(:Y1, 'groups', 'T-宛先', null, false, null) $q$)),
  '{"code": "invalid_input", "detail": {"field": "group_ids", "reason": "required"}}'::jsonb, '団体が null の配列 → 空とみなして required');
select is(tests.error_json(tests.sql($q$ select public.save_notice(:Y1, 'groups', 'T-宛先', null, false, array_fill(:G1, array[1001])) $q$)),
  '{"code": "invalid_input", "detail": {"field": "group_ids", "reason": "too_many"}}'::jsonb, '団体が 1001 個 → too_many（重複より先に数で見る）');
select is(tests.error_json(tests.sql($q$ select public.save_notice(:Y1, 'groups', 'T-宛先', null, false, array[:G1, null]) $q$)),
  '{"code": "invalid_input", "detail": {"field": "group_ids", "reason": "invalid"}}'::jsonb, '団体に null が入る → invalid');
select is(tests.error_json(tests.sql($q$ select public.save_notice(:Y1, 'groups', 'T-宛先', null, false, array[:G1, :G1]) $q$)),
  '{"code": "invalid_input", "detail": {"field": "group_ids", "reason": "invalid"}}'::jsonb, '団体が重複 → invalid');
select is(tests.error_json(tests.sql($q$ select public.save_notice(:Y1, 'groups', 'T-宛先', null, false, array[:G1, :G3]) $q$)),
  '{"code": "invalid_input", "detail": {"field": "group_ids", "reason": "not_in_year"}}'::jsonb, 'ほかの年度の団体（Y2 の G3） → not_in_year');
select is(tests.error_json(tests.sql($q$ select public.save_notice(:Y1, 'groups', 'T-宛先', null, false, array[gen_random_uuid()]) $q$)),
  '{"code": "invalid_input", "detail": {"field": "group_ids", "reason": "not_in_year"}}'::jsonb, 'ない団体 → not_in_year');
select is(tests.error_json(tests.sql($q$ select public.save_notice(:Y1, 'soumu', 'T-宛先', null, false, array[:G1]) $q$)),
  '{"code": "invalid_input", "detail": {"field": "group_ids", "reason": "not_allowed"}}'::jsonb, '総務内に団体を渡す → not_allowed');
select is(tests.error_json(tests.sql($q$ select public.save_notice(:Y1, 'all_groups', 'T-宛先', null, false, array[:G1]) $q$)),
  '{"code": "invalid_input", "detail": {"field": "group_ids", "reason": "not_allowed"}}'::jsonb,
  '全団体あてに団体を渡す → not_allowed（staff でも、段の forbidden より先）');
select is(tests.error_json(tests.sql($q$ select public.save_notice(:Y1, 'soumu', 'T-順', null, false, array[:G1], null, now()) $q$)),
  '{"code": "invalid_input", "detail": {"field": "group_ids", "reason": "not_allowed"}}'::jsonb, '宛先の団体と版の両方が誤り → group_ids が先');
select is(tests.error_json(tests.sql($q$ select public.save_notice(:Y1, 'soumu', 'T-版', null, false, '{}', null, now()) $q$)),
  '{"code": "invalid_input", "detail": {"field": "base_updated_at"}}'::jsonb, '作るときに版を渡す → base_updated_at');
select is(tests.error_json(tests.sql($q$ select public.save_notice(:Y1, 'soumu', 'T-版', null, false, '{}', :N_SOUMU, null) $q$)),
  '{"code": "invalid_input", "detail": {"field": "base_updated_at"}}'::jsonb, '直すときに版がない → base_updated_at');
select is(tests.error_json(tests.sql($q$ select public.save_notice(:Y1, 'all_groups', 'T-順', null, false, '{}', null, now()) $q$)),
  '{"code": "invalid_input", "detail": {"field": "base_updated_at"}}'::jsonb, 'staff の全団体あてでも、入力の誤りが段の forbidden より先');
-- 3. 段：入力が正しければ、全団体・指定の団体あては部門長以上でなければ forbidden（detail なし）
select is(tests.error_json(tests.sql($q$ select public.save_notice(:Y1, 'groups', 'T-宛先', null, false, array[:G1]) $q$)),
  '{"code": "forbidden", "detail": null}'::jsonb, 'staff：正しい指定の団体あて → forbidden');
-- 通る入力：題名は前後の空白（JavaScript の trim と同じ 25 文字）を除いて 100 字まで。本文は 4000 字まで、空白だけなら null、前後の空白はそのまま
select is(tests.error_json(tests.sql($q$ select public.save_notice(:Y1, 'soumu', E'\u3000 ' || repeat('い', 100) || E' \t') $q$)),
  '{"code": "ok"}'::jsonb, '前後の空白を除いて 100 字の題名は通る');
select is(tests.error_json(tests.sql($q$ select public.save_notice(:Y1, 'soumu', 'T-本文4000', repeat('あ', 4000)) $q$)),
  '{"code": "ok"}'::jsonb, '4000 字の本文は通る');
select is(tests.error_json(tests.sql($q$ select public.save_notice(:Y1, 'soumu', 'T-本文空白', E' \n\u3000\t') $q$)),
  '{"code": "ok"}'::jsonb, '空白だけの本文は通る');
select is(tests.error_json(tests.sql($q$ select public.save_notice(:Y1, 'soumu', 'T-本文NBSP', E'\u00a0') $q$)),
  '{"code": "ok"}'::jsonb, 'ノーブレークスペース（U+00A0）だけの本文は通る（T17A-1）');
select is(tests.error_json(tests.sql($q$ select public.save_notice(:Y1, 'soumu', 'T-本文VT', E'\u000b') $q$)),
  '{"code": "ok"}'::jsonb, '垂直タブ（U+000B）だけの本文は通る（T17A-1）');
select is(tests.error_json(tests.sql($q$ select public.save_notice(:Y1, 'soumu', 'T-本文25', tests.js_space()) $q$)),
  '{"code": "ok"}'::jsonb, 'JavaScript の trim が除く 25 文字だけの本文は通る（T17A-1）');
select is(tests.error_json(tests.sql($q$ select public.save_notice(:Y1, 'soumu', tests.js_space() || 'T-端' || tests.js_space()) $q$)),
  '{"code": "ok"}'::jsonb, '前後に 25 文字を全部並べた題名は通る（T17A-1）');
select is(tests.error_json(tests.sql($q$ select public.save_notice(:Y1, 'soumu', E'\u200b\u0085vT-残すv\u180e\u3164') $q$)),
  '{"code": "ok"}'::jsonb, 'JavaScript の trim が除かない文字が前後にある題名は通る（T17A-1）');
select is(tests.error_json(tests.sql($q$ select public.save_notice(:Y1, 'soumu', 'T-字下げ', E'  一行目\n\n\u3000二行目\n') $q$)),
  '{"code": "ok"}'::jsonb, '字下げ・空行のある本文は通る');
select tests.logout();
select is((select format('%s %s %s', length(title), audience, (created_by = tests.id('staff'))::text) from public.notices where title = repeat('い', 100)),
  '100 soumu true', '題名は前後の空白を除いて入る（書いた人は staff）');
select is((select body is null from public.notices where title = 'T-本文空白'), true, '空白だけの本文は null で入る');
select is((select string_agg(format('%s=%s', title, coalesce(body, 'null')), ' ' order by title collate "C") from public.notices
           where title in ('T-本文NBSP', 'T-本文VT', 'T-本文25')),
  'T-本文25=null T-本文NBSP=null T-本文VT=null', 'U+00A0 だけ・垂直タブだけ・25 文字だけの本文は null で入る（T17A-1）');
select is((select count(*)::int from public.notices where title = 'T-端'), 1, '題名の前後の 25 文字は除いて入る（T17A-1）');
select is((select count(*)::int from public.notices where title = E'\u200b\u0085vT-残すv\u180e\u3164'), 1,
  'JavaScript の trim が除かない文字（U+200B・U+0085・U+180E・U+3164・v）は除かずに入る（T17A-1）');
select is((select body from public.notices where title = 'T-字下げ'), E'  一行目\n\n\u3000二行目\n', '本文の前後の空白・改行・字下げはそのまま入る');
select is((select length(body) from public.notices where title = 'T-本文4000'), 4000, '4000 字の本文がそのまま入る');

-- ================================================================ ④ 楽観ロック（ミリ秒までで比べる。detail は id）
-- テスト全体が1つのトランザクションで now() が変わらないので、トリガーを止めてミリ秒より細かい過去の updated_at を入れる
alter table public.notices disable trigger set_timestamps;
update public.notices set updated_at = '2026-10-01 10:00:00.123456+09' where id = tests.id('N_SOUMU');
alter table public.notices enable trigger set_timestamps;
select tests.login_as('staff');
select is(tests.error_json(tests.sql($q$ select public.save_notice(:Y1, 'soumu', 'T-ロック', null, false, '{}', :N_SOUMU, '2026-10-01 10:00:00.124+09') $q$)),
  jsonb_build_object('code', 'conflict', 'detail', jsonb_build_object('id', tests.id('N_SOUMU'))), '版が 1 ミリ秒新しい → conflict（detail は id）');
select is(tests.error_json(tests.sql($q$ select public.save_notice(:Y1, 'soumu', 'T-ロック', null, false, '{}', :N_SOUMU, '2026-10-01 10:00:00.122+09') $q$)),
  jsonb_build_object('code', 'conflict', 'detail', jsonb_build_object('id', tests.id('N_SOUMU'))), '版が 1 ミリ秒古い → conflict');
select tests.logout();
select is((select title from public.notices where id = tests.id('N_SOUMU')), 'T-N_SOUMU', 'conflict のときは何も変わらない');
select tests.login_as('staff');
select is(tests.error_json(tests.sql($q$ select public.save_notice(:Y1, 'soumu', 'T-ロック', null, false, '{}', :N_SOUMU, '2026-10-01 10:00:00.123999+09') $q$)),
  '{"code": "ok"}'::jsonb, 'ミリ秒より細かい違いは見ない（同じミリ秒の版なら通る）');
select is(tests.error_json(tests.sql($q$ select public.save_notice(:Y1, 'soumu', 'T-ロック2', null, false, '{}', :N_SOUMU, '2026-10-01 10:00:00.123+09') $q$)),
  jsonb_build_object('code', 'conflict', 'detail', jsonb_build_object('id', tests.id('N_SOUMU'))),
  '保存の後は、前の版（画面がミリ秒までで受け取った文字列）では conflict');
select tests.logout();
select is((select title || ' ' || (updated_at = now())::text from public.notices where id = tests.id('N_SOUMU')), 'T-ロック true',
  '通った保存で updated_at が進む');

-- ================================================================ ⑤ 作る・直すの中身（返り値・書いた人・宛先の団体の差分・監査の理由）
select coalesce(max(id), 0) as m0 from public.audit_logs \gset
select tests.login_as('head');
select to_jsonb(r) as created
from public.save_notice(tests.id('Y1'), 'groups', E'\u3000 T-作る \t', E'  本文\n', false, array[tests.id('G1'), tests.id('G2')]) r \gset
select tests.logout();
insert into tests.ids values ('N_NEW', (:'created'::jsonb ->> 'id')::uuid);
select is((select to_jsonb(n) from public.notices n where n.id = tests.id('N_NEW')), :'created'::jsonb,
  '作ったときの返り値は保存した行（全部の列）');
select is((select format('%s|%s|%s|%s|%s', audience, title, body, pinned::text, (year_id = tests.id('Y1'))::text) from public.notices where id = tests.id('N_NEW')),
  E'groups|T-作る|  本文\n|false|true', '作った行：宛先・題名（前後の空白を除く）・本文（そのまま）・ピン留め・年度');
select ok((select created_by = tests.id('head') and updated_by = tests.id('head') and created_at = now() and updated_at = now()
           from public.notices where id = tests.id('N_NEW')), '書いた人・直した人は呼んだ人（head）、日時は DB が入れる');
select is(tests.notice_group_names('N_NEW'), 'G1 G2', '宛先の団体は G1・G2');
select is(tests.audit_since(:m0), 'notice_groups insert G1 お知らせ, notice_groups insert G2 お知らせ, notices insert - お知らせ',
  '作ると、お知らせと宛先の団体の insert が理由「お知らせ」で監査に残る');
select ok((select bool_and(user_id = tests.id('head') and year_id = tests.id('Y1')) from public.audit_logs where id > :m0),
  '監査の人は head、年度は Y1');
select is(format('%s %s %s %s', tests.can_read('rep', 'N_NEW')::text, tests.can_read('rep2', 'N_NEW')::text, tests.can_read('viewer', 'N_NEW')::text,
              tests.can_read('outsider', 'N_NEW')::text), 'true true true false', 'G1 の rep・G2 の rep2・viewer は読め、outsider は読めない');

-- deputy が直す：宛先の団体を [G1, G2] → [G2, G4]、本文を省く（全部の欄を置き換えるので null）
alter table public.notices disable trigger set_timestamps;
update public.notices set updated_at = '2026-10-02 09:00:00+09' where id = tests.id('N_NEW');
alter table public.notices enable trigger set_timestamps;
select coalesce(max(id), 0) as m1 from public.audit_logs \gset
select tests.login_as('deputy');
select to_jsonb(r) as edited
from public.save_notice(tests.id('Y1'), 'groups', 'T-直した', null, false, array[tests.id('G2'), tests.id('G4')],
                        tests.id('N_NEW'), tests.notice_ts('N_NEW')) r \gset
select tests.logout();
select is((select to_jsonb(n) from public.notices n where n.id = tests.id('N_NEW')), :'edited'::jsonb, '直したときの返り値も保存した行');
select is((select format('%s|%s|%s|%s', title, coalesce(body, 'null'), (created_by = tests.id('head'))::text, (updated_by = tests.id('deputy'))::text)
           from public.notices where id = tests.id('N_NEW')),
  'T-直した|null|true|true', '直すと全部の欄を置き換える（本文を省くと null）。created_by は head のまま、updated_by は deputy');
select is((select updated_at = now() from public.notices where id = tests.id('N_NEW')), true,
  '直すと updated_at が進む（過去の版 → now()）');
select is(tests.notice_group_names('N_NEW'), 'G2 G4', '宛先の団体は G2・G4 に入れ替わる');
select is(tests.audit_since(:m1),
  'notice_groups delete G1 お知らせの更新, notice_groups insert G4 お知らせの更新, notices update - お知らせの更新',
  '差分で入れ替える：外した G1 の delete と足した G4 の insert だけが監査に出る（変わらない G2 は出ない）。理由は「お知らせの更新」');
select is(format('%s %s %s', tests.can_read('rep', 'N_NEW')::text, tests.can_read('rep2', 'N_NEW')::text, tests.can_read('viewer', 'N_NEW')::text),
  'false true true', 'G1 を外すと rep は読めなくなる（rep2・viewer は読める）');

-- 中身を変えずに保存しても書く（updated_at が進み、前の版は conflict になる）
alter table public.notices disable trigger set_timestamps;
update public.notices set updated_at = '2026-10-03 09:00:00+09' where id = tests.id('N_NEW');
alter table public.notices enable trigger set_timestamps;
select tests.login_as('deputy');
select is(tests.error_json(tests.sql($q$ select public.save_notice(:Y1, 'groups', 'T-直した', null, false, array[:G4, :G2], :N_NEW, '2026-10-03 09:00:00+09') $q$)),
  '{"code": "ok"}'::jsonb, '同じ中身で保存する（宛先の団体の並びが違っても同じ集合）');
select tests.logout();
select is((select updated_at = now() from public.notices where id = tests.id('N_NEW')), true, '中身が同じでも updated_at は進む');
select is(tests.notice_group_names('N_NEW'), 'G2 G4', '宛先の団体はそのまま');

-- 宛先の付け替え：指定の団体あて → 総務内で宛先の団体の行が消え、総務内 → 指定の団体あて（G2）で行が入る
select coalesce(max(id), 0) as m2 from public.audit_logs \gset
select tests.login_as('deputy');
select is(tests.error_json(tests.sql($q$ select public.save_notice(:Y1, 'soumu', 'T-直した', null, false, '{}', :N_NEW, tests.notice_ts('N_NEW')) $q$)),
  '{"code": "ok"}'::jsonb, '指定の団体あてを総務内に変える');
select tests.logout();
select is(tests.notice_group_names('N_NEW'), '', '総務内に変えると宛先の団体の行が全部消える');
select is(tests.audit_since(:m2),
  'notice_groups delete G2 お知らせの更新, notice_groups delete G4 お知らせの更新, notices update - お知らせの更新',
  '宛先の団体の delete とお知らせの update が、理由「お知らせの更新」で残る');
select is(format('%s %s %s', tests.can_read('rep2', 'N_NEW')::text, tests.can_read('viewer', 'N_NEW')::text, tests.can_read('staff', 'N_NEW')::text),
  'false false true', '総務内になると rep2・viewer は読めず、staff は読める');
select tests.login_as('head');
select is(tests.error_json(tests.sql($q$ select public.save_notice(:Y1, 'groups', 'T-直した', null, false, array[:G2], :N_NEW, tests.notice_ts('N_NEW')) $q$)),
  '{"code": "ok"}'::jsonb, '総務内を指定の団体あて（G2）に変える');
select tests.logout();
select is(tests.notice_group_names('N_NEW'), 'G2', '指定の団体あてに変えると宛先の団体の行が入る');
select is(format('%s %s', tests.can_read('rep2', 'N_NEW')::text, tests.can_read('rep', 'N_NEW')::text), 'true false', 'G2 の rep2 は読め、G1 の rep は読めない');

-- ================================================================ ⑥ ピン留め・書いた人と部門長以上
-- 作るときにピン留めを付けるのは部門長以上（総務内でも）
select tests.login_as('staff');
select is(tests.error_json(tests.sql($q$ select public.save_notice(:Y1, 'soumu', 'T-ピン', null, true) $q$)),
  '{"code": "forbidden", "detail": null}'::jsonb, 'staff はピン留めして出せない（総務内でも）');
select tests.logout();
select tests.login_as('deputy');
select is(tests.error_json(tests.sql($q$ select public.save_notice(:Y1, 'soumu', 'T-ピン', null, true) $q$)),
  '{"code": "ok"}'::jsonb, 'deputy はピン留めして総務内を出せる');
select tests.logout();
select is((select pinned from public.notices where title = 'T-ピン'), true, 'ピン留めが付いて入る');
-- 部門長以上が付けたピン留めは、書いた人（staff）がそのままにして直せる。外すのは部門長以上
select tests.login_as('staff');
select is(tests.error_json(tests.sql($q$ select public.save_notice(:Y1, 'soumu', 'T-ピンのまま', null, true, '{}', :N_SOUMU_PIN, tests.notice_ts('N_SOUMU_PIN')) $q$)),
  '{"code": "ok"}'::jsonb, 'staff は、部門長以上がピン留めした自分のお知らせを、ピン留めのまま直せる');
select is(tests.error_json(tests.sql($q$ select public.save_notice(:Y1, 'soumu', 'T-外す', null, false, '{}', :N_SOUMU_PIN, tests.notice_ts('N_SOUMU_PIN')) $q$)),
  '{"code": "forbidden", "detail": null}'::jsonb, 'staff はピン留めを外せない');
select tests.logout();
select is((select format('%s %s %s', title, pinned::text, (updated_by = tests.id('staff'))::text) from public.notices where id = tests.id('N_SOUMU_PIN')),
  'T-ピンのまま true true', 'ピン留めのまま直り、外す保存は何も変えない');
select tests.login_as('head');
select is(tests.error_json(tests.sql($q$ select public.save_notice(:Y1, 'soumu', 'T-ピンのまま', null, false, '{}', :N_SOUMU_PIN, tests.notice_ts('N_SOUMU_PIN')) $q$)),
  '{"code": "ok"}'::jsonb, 'head は staff のお知らせのピン留めを外せる');
select tests.logout();
select is((select format('%s %s %s', pinned::text, (created_by = tests.id('staff'))::text, (updated_by = tests.id('head'))::text) from public.notices where id = tests.id('N_SOUMU_PIN')),
  'false true true', 'ピン留めが外れ、書いた人は staff のまま、直した人は head');

-- 書いた人のアカウントがない（created_by が null。アカウントを消すと set null）お知らせは、部門長以上だけが直せる
update public.notices set created_by = null where id = tests.id('N_SOUMU_DEP');
select tests.login_as('staff');
select is(tests.error_json(tests.sql($q$ select public.save_notice(:Y1, 'soumu', 'T-書いた人なし', null, false, '{}', :N_SOUMU_DEP, tests.notice_ts('N_SOUMU_DEP')) $q$)),
  '{"code": "forbidden", "detail": null}'::jsonb, 'created_by が null のお知らせを staff は直せない');
select tests.logout();
select tests.login_as('deputy');
select is(tests.error_json(tests.sql($q$ select public.save_notice(:Y1, 'soumu', 'T-書いた人なし', null, false, '{}', :N_SOUMU_DEP, tests.notice_ts('N_SOUMU_DEP')) $q$)),
  '{"code": "ok"}'::jsonb, 'created_by が null のお知らせを deputy（部門長以上）は直せる');
select tests.logout();
select is((select created_by is null and updated_by = tests.id('deputy') from public.notices where id = tests.id('N_SOUMU_DEP')), true,
  '直しても created_by は null のまま（直した人だけが入る）');

-- ロールを外された人は、自分が書いたお知らせも直せず消せない（まずその年度の総務であること）。読めもしない
delete from public.year_roles where year_id = tests.id('Y1') and user_id = tests.id('staff');
select tests.login_as('staff');
select is(tests.error_json(tests.sql($q$ select public.save_notice(:Y1, 'soumu', 'T-外された', null, false, '{}', :N_SOUMU, tests.notice_ts('N_SOUMU')) $q$)),
  '{"code": "forbidden", "detail": null}'::jsonb, 'ロールを外された staff は、自分が書いたお知らせを直せない');
select is(tests.error_json(tests.sql($q$ select public.delete_notice(:N_SOUMU, tests.notice_ts('N_SOUMU')) $q$)),
  '{"code": "forbidden", "detail": null}'::jsonb, '消せもしない');
select is((select count(*)::int from public.notices where id = tests.id('N_SOUMU')), 0, '読めもしない');
select tests.logout();
insert into public.year_roles (year_id, user_id, role) values (tests.id('Y1'), tests.id('staff'), 'staff');

-- 部門長以上だった人が出した全団体あては、その人が staff になった後は、全団体あてのままでは直せず、総務内に変えるなら直せる
-- （直した後の宛先の段だけを見る。notes/T17.md の判断 11。ユーザーに確認中の「確認したいこと」の 2）
update public.year_roles set role = 'staff' where year_id = tests.id('Y1') and user_id = tests.id('head');
select tests.login_as('head');
select is(tests.error_json(tests.sql($q$ select public.save_notice(:Y1, 'all_groups', 'T-元部門長', null, true, '{}', :N_ALL, tests.notice_ts('N_ALL')) $q$)),
  '{"code": "forbidden", "detail": null}'::jsonb, 'staff になった head は、自分の全団体あてを全団体あてのまま直せない');
select is(tests.error_json(tests.sql($q$ select public.save_notice(:Y1, 'soumu', 'T-元部門長', null, true, '{}', :N_ALL, tests.notice_ts('N_ALL')) $q$)),
  '{"code": "ok"}'::jsonb, 'staff になった head は、自分の全団体あてを総務内に変えられる（ピン留めはそのまま）');
select tests.logout();
update public.year_roles set role = 'head' where year_id = tests.id('Y1') and user_id = tests.id('head');
select is((select format('%s %s %s', audience, title, pinned::text) from public.notices where id = tests.id('N_ALL')), 'soumu T-元部門長 true',
  '総務内に変わり、ピン留めは付いたまま');

-- ================================================================ ⑦ not_found と forbidden（読めないお知らせの有無を漏らさない）
-- save_notice：その年度の総務には、ないお知らせとほかの年度のお知らせが同じ not_found（detail なし）
select tests.login_as('staff');
select is(tests.error_json(tests.sql($q$ select public.save_notice(:Y1, 'soumu', 'T-x', null, false, '{}', gen_random_uuid(), now()) $q$)),
  '{"code": "not_found", "detail": null}'::jsonb, 'staff：ないお知らせを直す → not_found');
select is(tests.error_json(tests.sql($q$ select public.save_notice(:Y1, 'soumu', 'T-x', null, false, '{}', :N_Y2_ALL, tests.notice_ts('N_Y2_ALL')) $q$)),
  '{"code": "not_found", "detail": null}'::jsonb, 'staff：Y2 のお知らせ（G3 の店長として読める）を Y1 として直す → 同じ not_found');
-- delete_notice：その年度の総務でない人には、ないお知らせと、あるお知らせ（読めるものも）が同じ forbidden
select is(tests.error_json(tests.sql($q$ select public.delete_notice(:N_Y2_ALL, tests.notice_ts('N_Y2_ALL')) $q$)),
  '{"code": "forbidden", "detail": null}'::jsonb, 'staff：Y2 のお知らせ（読める）を消す → forbidden');
select is(tests.error_json($q$ select public.delete_notice(gen_random_uuid(), now()) $q$),
  '{"code": "forbidden", "detail": null}'::jsonb, 'staff：ないお知らせを消す → 同じ forbidden');
select tests.logout();
select tests.login_as('rep');
select is(tests.error_json(tests.sql($q$ select public.save_notice(:Y1, 'groups', 'T-x', null, false, array[:G1], :N_G1, tests.notice_ts('N_G1')) $q$)),
  '{"code": "forbidden", "detail": null}'::jsonb, 'rep：読めるお知らせ（自団体あて）を直す → forbidden');
select is(tests.error_json(tests.sql($q$ select public.save_notice(:Y1, 'groups', 'T-x', null, false, array[:G1], gen_random_uuid(), now()) $q$)),
  '{"code": "forbidden", "detail": null}'::jsonb, 'rep：ないお知らせを直す → 同じ forbidden');
select is(tests.error_json(tests.sql($q$ select public.delete_notice(:N_G1, tests.notice_ts('N_G1')) $q$)),
  '{"code": "forbidden", "detail": null}'::jsonb, 'rep：読めるお知らせを消す → forbidden');
select is(tests.error_json(tests.sql($q$ select public.delete_notice(:N_G4, tests.notice_ts('N_G4')) $q$)),
  '{"code": "forbidden", "detail": null}'::jsonb, 'rep：読めないお知らせを消す → 同じ forbidden');
select tests.logout();
select tests.login_as('admin2');
select is(tests.error_json(tests.sql($q$ select public.save_notice(:Y2, 'soumu', 'T-x', null, false, '{}', :N_G4, tests.notice_ts('N_G4')) $q$)),
  '{"code": "not_found", "detail": null}'::jsonb, 'admin2：Y1 のお知らせ（読めない）を Y2 として直す → not_found');
select is(tests.error_json(tests.sql($q$ select public.save_notice(:Y2, 'soumu', 'T-x', null, false, '{}', gen_random_uuid(), now()) $q$)),
  '{"code": "not_found", "detail": null}'::jsonb, 'admin2：ないお知らせを直す → 同じ not_found');
select is(tests.error_json(tests.sql($q$ select public.delete_notice(:N_G4, tests.notice_ts('N_G4')) $q$)),
  '{"code": "forbidden", "detail": null}'::jsonb, 'admin2：Y1 のお知らせを消す → forbidden');
select tests.logout();

-- ================================================================ ⑧ 終了の年度は読むだけ（だれも書けない。detail は状態）
select tests.set_scenario('closed');
select tests.login_as('admin');
select is(tests.error_json(tests.sql($q$ select public.save_notice(:Y1, 'soumu', 'T-終了') $q$)),
  '{"code": "invalid_state", "detail": {"status": "closed"}}'::jsonb, '終了：admin も作れない');
select is(tests.error_json(tests.sql($q$ select public.save_notice(:Y1, 'groups', 'T-終了', null, false, array[:G4], :N_G4, tests.notice_ts('N_G4')) $q$)),
  '{"code": "invalid_state", "detail": {"status": "closed"}}'::jsonb, '終了：直せない');
select is(tests.error_json(tests.sql($q$ select public.delete_notice(:N_G4, tests.notice_ts('N_G4')) $q$)),
  '{"code": "invalid_state", "detail": {"status": "closed"}}'::jsonb, '終了：消せない');
select is((select count(*)::int from public.notices where year_id = tests.id('Y1') and id = tests.id('N_G4')), 1, '終了の年度でも読める');
select tests.logout();
select tests.set_scenario('requesting');

-- ================================================================ ⑨ 1回で入れ替える（途中で失敗したら何も変わらない）と、例外の直し（D-19）
-- テスト用のトリガーで、お知らせ・宛先の団体の書き込みにエラーを起こす（tests.raise に「表:SQLSTATE[:制約の名前]」を置いたときだけ）
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
create trigger zz_tests_raise before insert or update on public.notices for each row execute function tests.tg_raise();
create trigger zz_tests_raise before insert on public.notice_groups for each row execute function tests.tg_raise();

-- 宛先の団体の insert が外部キーの違反（確かめた後に団体が消えた）：invalid_input（group_ids・not_in_year）。先に消した G2 の行と、
-- お知らせの update も取り消される
select coalesce(max(id), 0) as m3 from public.audit_logs \gset
select set_config('tests.raise', 'notice_groups:23503', true);
select tests.login_as('head');
select is(tests.error_json(tests.sql($q$ select public.save_notice(:Y1, 'groups', 'T-失敗', null, false, array[:G1, :G4], :N_NEW, tests.notice_ts('N_NEW')) $q$)),
  '{"code": "invalid_input", "detail": {"field": "group_ids", "reason": "not_in_year"}}'::jsonb,
  '宛先の団体の外部キーの違反は invalid_input（group_ids・not_in_year）');
select tests.logout();
select is((select title from public.notices where id = tests.id('N_NEW')) || ' ' || tests.notice_group_names('N_NEW'), 'T-直した G2',
  '途中で失敗すると、題名も宛先の団体（先に消した G2 の行）も元のまま');
select is(tests.audit_since(:m3), '', '失敗した保存は監査に何も残さない');
-- CHECK の違反とクラス 22 は invalid_input（notices_title_check は title、notices_body_check は body、ほかは notice）
select set_config('tests.raise', 'notices:23514:notices_title_check', true);
select tests.login_as('head');
select is(tests.error_json(tests.sql($q$ select public.save_notice(:Y1, 'soumu', 'T-x') $q$)),
  '{"code": "invalid_input", "detail": {"field": "title"}}'::jsonb, 'notices_title_check の違反 → title');
select tests.logout();
select set_config('tests.raise', 'notices:23514:notices_body_check', true);
select tests.login_as('head');
select is(tests.error_json(tests.sql($q$ select public.save_notice(:Y1, 'soumu', 'T-x') $q$)),
  '{"code": "invalid_input", "detail": {"field": "body"}}'::jsonb, 'notices_body_check の違反 → body');
select tests.logout();
select set_config('tests.raise', 'notices:23514:x_check', true);
select tests.login_as('head');
select is(tests.error_json(tests.sql($q$ select public.save_notice(:Y1, 'soumu', 'T-x', null, false, '{}', :N_NEW, tests.notice_ts('N_NEW')) $q$)),
  '{"code": "invalid_input", "detail": {"field": "notice"}}'::jsonb, 'ほかの CHECK の違反（直すとき） → notice');
select tests.logout();
select set_config('tests.raise', 'notices:22003', true);
select tests.login_as('head');
select is(tests.error_json(tests.sql($q$ select public.save_notice(:Y1, 'soumu', 'T-x') $q$)),
  '{"code": "invalid_input", "detail": {"field": "notice"}}'::jsonb, 'クラス 22（関数の中で起きた形の誤り） → notice');
select tests.logout();
select set_config('tests.raise', '', true);
drop trigger zz_tests_raise on public.notices;
drop trigger zz_tests_raise on public.notice_groups;
select is((select count(*)::int from public.notices where title = 'T-x'), 0, '例外で止まった保存はどれも入っていない');

-- ================================================================ ⑩ 消す
-- head が deputy の指定の団体あて（G1・G2）を消す：宛先の団体の行も消え、どれも理由「お知らせの削除」で監査に残る
select coalesce(max(id), 0) as m4 from public.audit_logs \gset
select tests.login_as('head');
select is(tests.error_json(tests.sql($q$ select public.delete_notice(:N_G12, tests.notice_ts('N_G12')) $q$)), '{"code": "ok"}'::jsonb,
  'head は deputy が書いた指定の団体あてを消せる');
select is(tests.error_json(tests.sql($q$ select public.delete_notice(:N_G12, now()) $q$)), '{"code": "forbidden", "detail": null}'::jsonb,
  '消した後にもう一度消す → forbidden（ないお知らせと同じ）');
select tests.logout();
select is((select count(*)::int from public.notices where id = tests.id('N_G12')) + (select count(*)::int from public.notice_groups where notice_id = tests.id('N_G12')),
  0, 'お知らせと宛先の団体の行が消える');
select is(tests.audit_since(:m4), 'notice_groups delete G1 お知らせの削除, notice_groups delete G2 お知らせの削除, notices delete - お知らせの削除',
  '消すと、お知らせと宛先の団体の delete が理由「お知らせの削除」で監査に残る');
select ok((select bool_and(user_id = tests.id('head') and year_id = tests.id('Y1')) from public.audit_logs where id > :m4), '監査の人は head、年度は Y1');
-- 楽観ロック：古い版では消せない。ミリ秒までの版が合えば、書いた人（staff）はピン留めの付いたお知らせも消せる
alter table public.notices disable trigger set_timestamps;
update public.notices set updated_at = '2026-10-04 12:00:00.555777+09', pinned = true where id = tests.id('N_SOUMU_PIN');
alter table public.notices enable trigger set_timestamps;
select tests.login_as('staff');
select is(tests.error_json(tests.sql($q$ select public.delete_notice(:N_SOUMU_PIN, '2026-10-04 12:00:00.556+09') $q$)),
  jsonb_build_object('code', 'conflict', 'detail', jsonb_build_object('id', tests.id('N_SOUMU_PIN'))), '古い版では消せない（conflict。detail は id）');
select is(tests.error_json(tests.sql($q$ select public.delete_notice(:N_SOUMU_PIN, '2026-10-04 12:00:00.555+09') $q$)), '{"code": "ok"}'::jsonb,
  'ミリ秒までの版が合えば、staff はピン留めの付いた自分のお知らせを消せる');
select tests.logout();
select is((select count(*)::int from public.notices where id = tests.id('N_SOUMU_PIN')), 0, '消えた');

-- 団体を消して宛先の団体が 0 になった指定の団体あては、総務と閲覧のみだけが読む（団体の代表はだれも読まない。お知らせは残る）
select tests.login_as('admin');
select lives_ok($q$ delete from public.groups where id = tests.id('G4') $q$, 'admin が G4 を消す（受付中。viewer の副店長の行も消える）');
select tests.logout();
select is(tests.notice_group_names('N_G4'), '', 'N_G4 の宛先の団体は 0 になる');
select is(format('%s %s %s %s %s', tests.can_read('staff', 'N_G4')::text, tests.can_read('viewer', 'N_G4')::text, tests.can_read('rep', 'N_G4')::text,
                 tests.can_read('rep2', 'N_G4')::text, tests.can_read('outsider', 'N_G4')::text),
  'true true false false false', '宛先の団体が 0 の指定の団体あては、総務と閲覧のみだけが読める');

select * from finish();
rollback;
