-- 013_rls_select_once：0010 の select のポリシー（判定関数を行ごとに呼ばない形。T14 の速さの改善、D-47）
-- ① 見える行が行ごとの形のポリシー（0004 の述語のロールの配列を、T15 の段〔部門長以上・総務。0013〕に直したもの）とまったく同じこと：
--    7 表 × 9 人 × Y1 の6つの状態 × Y2 の2つの状態で、今のポリシーで見える行（authenticated に切り替えて読む）と、行ごとの形の述語で
--    postgres が選んだ行（auth.uid() だけを変える）を、行の中身ごと比べる。
-- ② 新しい関数（my_role_year_ids・my_group_ids・my_role_group_ids）が呼んだ人についてだけ答えることと、実行の権限。
-- ③ audit_logs の年度をまたぐ表の行（year_id が null）と、開いていない（closed の）年度の扱い。
-- ④ 7 表の select のポリシーが、行の列を判定関数に渡していないこと（書き方の決まり。02 の「権限とRLS」）。
-- T17：お知らせの notices・notice_groups（0014）も同じ形で書いたので、①の比べる表に足し（行ごとの形の述語は 02 の「お知らせの権限」
-- から書いた）、②に集合の関数 my_group_year_ids・my_group_notice_ids、④に2表のポリシーの形と実行計画を足した。
-- T18：予定と締切の events（0015）も同じ形で書いたので、①の比べる表に足し（行ごとの形の述語は 02 の「予定と締切の権限」から書いた）、
-- ④にポリシーの形と実行計画を足した（集合の関数は足していない）。
-- T19：提出物の documents・document_submissions・document_files（0016）も同じ形で書いたので、①の比べる表に足し（行ごとの形の述語は 02 の
-- 「提出物の権限」から書いた）、②に集合の関数 my_group_document_ids・my_document_upload_paths・my_document_orphan_paths、④に3表と
-- v_document_status・storage.objects のポリシーの形と実行計画を足した。⑤で storage.objects の3つのポリシー（select・insert・delete）が
-- 行ごとの形の述語と同じ物を選ぶことを確かめる。
begin;
\ir _helpers/personas.psql
\ir _helpers/fixture.psql

-- 年度のない履歴の行：年度をまたぐ3表の行は fixture の rooms・items・distance_overrides の insert で監査のトリガーが書いた。
-- 3表のほかの表の年度のない行（ふつうはできないが、念のため）は誰にも見えない
insert into public.audit_logs (table_name, row_pk, action, year_id, before, after)
values ('years', '{}', 'update', null, '{"a":1}', '{"a":2}'), ('profiles', '{}', 'update', null, '{"a":1}', '{"a":2}');

-- 提出物（T19）：飲食の団体だけの提出物（Q8）を足す。Y1 の G1 を飲食にして対象に入れ、Y2 の G3（飲食でない）は対象に入れない。
-- ⑤の Storage の比べ方のために、予約（rep・head〔代理〕・承認の提出の viewer）と、届いた物・どの提出にも属さない物・形の違う名前の物を足す
with d as (
  insert into public.documents (year_id, title, deadline, target_categories, food_only) values
    (tests.id('Y1'), 'T-DOC_FOOD', '2027-10-02 12:00+09', '{stall}', true),
    (tests.id('Y2'), 'T-DOC_Y2_FOOD', '2026-10-02 12:00+09', '{stall}', true)
  returning id, title)
insert into tests.ids select substr(title, 3), id from d;
update public.groups set is_food = true where id = tests.id('G1');
insert into public.document_submissions (document_id, group_id, year_id) values
  (tests.id('DOC_NOFILE'), tests.id('G1'), tests.id('Y1')), (tests.id('DOC_FOOD'), tests.id('G1'), tests.id('Y1'));
insert into tests.ids values ('F13_REP', gen_random_uuid()), ('F13_HEAD', gen_random_uuid()), ('F13_VIEWER', gen_random_uuid()),
  ('F13_REP2', gen_random_uuid()), ('O13_G2', gen_random_uuid());
create function tests.doc_path(p_year text, p_group text, p_doc text, p_file text) returns text language sql stable as $$
  select tests.id(p_year) || '/' || tests.id(p_group) || '/' || tests.id(p_doc) || '/' || tests.id(p_file) || '.pdf'
$$;
insert into public.document_files (id, year_id, document_id, group_id, object_path, content_type, size, created_by) values
  (tests.id('F13_REP'), tests.id('Y1'), tests.id('DOC_NOFILE'), tests.id('G1'), tests.doc_path('Y1', 'G1', 'DOC_NOFILE', 'F13_REP'), 'application/pdf', 10, tests.id('rep')),
  (tests.id('F13_HEAD'), tests.id('Y1'), tests.id('DOC_STALL'), tests.id('G1'), tests.doc_path('Y1', 'G1', 'DOC_STALL', 'F13_HEAD'), 'application/pdf', 10, tests.id('head')),
  (tests.id('F13_VIEWER'), tests.id('Y1'), tests.id('DOC_NOFILE'), tests.id('G4'), tests.doc_path('Y1', 'G4', 'DOC_NOFILE', 'F13_VIEWER'), 'application/pdf', 10, tests.id('viewer')),
  (tests.id('F13_REP2'), tests.id('Y1'), tests.id('DOC_STALL'), tests.id('G2'), tests.doc_path('Y1', 'G2', 'DOC_STALL', 'F13_REP2'), 'application/pdf', 10, tests.id('rep2'));
-- 物は tests.put_object（fixture。0016 のトリガー documents_objects_guard を飛ばして置く。どの提出にも属さない物と形の違う名前の物は、
-- 予約の外なのでトリガーが止めるため）で置く
select tests.put_object('documents', v.name, v.metadata::jsonb)
from (values (tests.doc_path('Y1', 'G1', 'DOC_NOFILE', 'F13_REP'), '{"size": 10}'),
             (tests.doc_path('Y1', 'G2', 'DOC_STALL', 'O13_G2'), '{"size": 10}'),
             (tests.doc_path('Y2', 'G3', 'DOC_Y2', 'F_Y2'), '{"size": 2000}'),
             ('pgtap/' || tests.id('G1') || '/x.pdf', '{"size": 1}'),
             (tests.id('Y1') || '', '{"size": 1}')) v(name, metadata);

select plan(101);

-- ---------------------------------------------------------------- ① 行ごとの形の述語と同じ行が見える
-- 0004 の述語の形のまま、ロールの配列だけを T15 の段にした（年度の行の履歴は部門長以上、ほかは総務。groups は総務と viewer）
create table tests.old_pred (tbl text primary key, pred text not null);
insert into tests.old_pred values
  ('audit_logs', $p$ case when year_id is null
                         then table_name in ('rooms', 'items', 'distance_overrides') and private.is_admin_of_open_year()
                         else private.has_any_role(year_id, '{admin,head,deputy_head}') end $p$),
  ('allocations', $p$ private.has_any_role(year_id, '{admin,head,deputy_head,staff}')
                      or ((private.has_role(year_id, 'viewer') or private.is_group_member(group_id))
                          and private.year_status(year_id) in ('confirmed', 'closed')) $p$),
  ('requests', $p$ private.has_any_role(private.group_year_id(group_id), '{admin,head,deputy_head,staff}') or private.is_group_member(group_id) $p$),
  ('request_submissions', $p$ private.has_any_role(private.group_year_id(group_id), '{admin,head,deputy_head,staff}') or private.is_group_member(group_id) $p$),
  ('substitution_consents', $p$ private.has_any_role(private.group_year_id(group_id), '{admin,head,deputy_head,staff}') or private.is_group_member(group_id) $p$),
  ('stocks', $p$ private.has_any_role(year_id, '{admin,head,deputy_head,staff}') $p$),
  ('groups', $p$ private.has_any_role(year_id, '{admin,head,deputy_head,staff,viewer}') or private.is_group_member(id) $p$),
  -- お知らせ（T17）：総務はその年度の全部。閲覧のみはその年度の団体あて。団体の代表は、代表である年度の全団体あてと、自団体を
  -- 宛先の団体に含む指定の団体あて（行ごとに判定関数を呼ぶ形。t は比べる表の行）
  ('notices', $p$ private.has_any_role(year_id, '{admin,head,deputy_head,staff}')
                  or (audience in ('all_groups', 'groups') and private.has_role(year_id, 'viewer'))
                  or (audience = 'all_groups'
                      and exists (select 1 from public.groups g where g.year_id = t.year_id and private.is_group_member(g.id)))
                  or (audience = 'groups'
                      and exists (select 1 from public.notice_groups ng where ng.notice_id = t.id and private.is_group_member(ng.group_id))) $p$),
  -- 宛先の団体：総務と閲覧のみはその年度の全部、団体の代表は自団体の行だけ
  ('notice_groups', $p$ private.has_any_role(year_id, '{admin,head,deputy_head,staff,viewer}') or private.is_group_member(group_id) $p$),
  -- 予定と締切（T18）：総務はその年度の全部。閲覧のみはその年度の、団体の代表は代表である年度の、対象が団体・全員の項目
  ('events', $p$ private.has_any_role(year_id, '{admin,head,deputy_head,staff}')
                 or (audience in ('groups', 'all')
                     and (private.has_role(year_id, 'viewer')
                          or exists (select 1 from public.groups g where g.year_id = t.year_id and private.is_group_member(g.id)))) $p$);
-- 提出物（T19）：総務はその年度の全部。店長・副店長は自団体が対象（区分・飲食）の提出物と、自団体の提出・ファイル。ファイルは部門長以上
-- （部門員は読めない。Q4）。閲覧のみは何も読めない（Q5）
insert into tests.old_pred values
  ('documents', $p$ private.has_any_role(year_id, '{admin,head,deputy_head,staff}')
                    or exists (select 1 from public.groups g
                               where g.year_id = t.year_id and g.category = any (t.target_categories)
                                 and (not t.food_only or g.is_food) and private.is_group_member(g.id)) $p$),
  ('document_submissions', $p$ private.has_any_role(year_id, '{admin,head,deputy_head,staff}') or private.is_group_member(group_id) $p$),
  ('document_files', $p$ private.has_any_role(year_id, '{admin,head,deputy_head}') or private.is_group_member(group_id) $p$);

-- 行の中身をまとめた指紋（件数と、行の文字列を並べた md5）
create function tests.visible_old(p_tbl text, p_persona text) returns text language plpgsql as $$
declare v text;
begin
  perform tests.act_as(p_persona);                       -- postgres のまま（RLS を通らない）。auth.uid() だけを変える
  execute format('select count(*) || '':'' || md5(coalesce(string_agg(t::text, ''|'' order by t::text), '''')) from public.%I t where %s',
                 p_tbl, (select pred from tests.old_pred where tbl = p_tbl)) into v;
  perform tests.act_clear();
  return v;
end $$;
create function tests.visible_new(p_tbl text, p_persona text) returns text language plpgsql as $$
declare v text;
begin
  perform tests.login_as(p_persona);                     -- authenticated（ポリシーを通る）
  execute format('select count(*) || '':'' || md5(coalesce(string_agg(t::text, ''|'' order by t::text), '''')) from public.%I t',
                 p_tbl) into v;
  perform tests.logout();
  return v;
end $$;
create table tests.compared (tbl text, scenario text, persona text, old text, new text);
create function tests.compare_all() returns void language plpgsql as $$
declare s1 text; s2 text; t text; p text;
begin
  foreach s2 in array array['preparing', 'closed'] loop
    foreach s1 in array array['preparing', 'requesting', 'requesting:after', 'allocating', 'confirmed', 'closed'] loop
      perform tests.set_scenario(s1);
      update public.years set status = s2::public.year_status where id = tests.id('Y2');
      for t in select tbl from tests.old_pred order by tbl loop
        foreach p in array array['admin', 'staff', 'rep', 'rep2', 'viewer', 'outsider', 'admin2', 'head', 'deputy'] loop
          insert into tests.compared values (t, s1 || ' / Y2 ' || s2, p, tests.visible_old(t, p), tests.visible_new(t, p));
        end loop;
      end loop;
    end loop;
  end loop;
  perform tests.set_scenario('requesting');
  update public.years set status = 'preparing' where id = tests.id('Y2');
end $$;
select tests.compare_all();

select is_empty(format($q$ select scenario, persona, old, new from tests.compared where tbl = %L and old <> new $q$, t),
  format('%s：0010 の形（0013 の段）のポリシーで見える行は、行ごとの形の述語で選ぶ行と同じ（9 人 × Y1 の6状態 × Y2 の2状態）', t))
from unnest(array['audit_logs', 'allocations', 'requests', 'request_submissions', 'substitution_consents', 'stocks', 'groups',
                   'notices', 'notice_groups', 'events']) t;
-- 提出物の3表（T19）も同じ（行ごとの形の述語は 02 の「提出物の権限」から）。並行の機能のチケットとぶつからないよう、上の一覧とは分ける
select is_empty(format($q$ select scenario, persona, old, new from tests.compared where tbl = %L and old <> new $q$, t),
  format('%s：0010 の形（0013 の段）のポリシーで見える行は、行ごとの形の述語で選ぶ行と同じ（9 人 × Y1 の6状態 × Y2 の2状態）', t))
from unnest(array['documents', 'document_submissions', 'document_files']) t;
-- 提出物の3表を比べたものに中身がある（下の 10 表の確かめと同じ。全員 0 行や全員同じでは比べたことにならない）
select is((select string_agg(x.tbl, ' ' order by x.tbl) from (select tbl from tests.compared
             where tbl in ('documents', 'document_submissions', 'document_files')
             group by tbl having count(distinct new) >= 2 and bool_or(new !~ '^0:')) x),
  'document_files document_submissions documents',
  '提出物の3表（T19）とも比べていて、ペルソナ・状態によって見える行が違い、見える行のある組がある');
-- 比べたものに中身がある（全員 0 行や全員同じでは比べたことにならない）
select is_empty($q$ select tbl from tests.compared where tbl not in ('documents', 'document_submissions', 'document_files') group by tbl
                    having count(distinct new) < 2 or not bool_or(new !~ '^0:') $q$,
  '10 表とも、ペルソナ・状態によって見える行が違い、見える行のある組がある');

-- ---------------------------------------------------------------- ② 新しい関数は呼んだ人についてだけ答える
select tests.login_as('admin');
select set_eq($q$ select private.my_role_year_ids('{admin}') $q$, array[tests.id('Y1')], 'admin：admin の年度は Y1 だけ');
select is_empty($q$ select private.my_role_year_ids('{staff,viewer}') $q$, 'admin：staff・viewer の年度はない');
select is_empty($q$ select private.my_group_ids() $q$, 'admin：代表の団体はない');
select set_eq($q$ select private.my_role_group_ids('{admin,staff}') $q$, array[tests.id('G1'), tests.id('G2'), tests.id('G4')],
  'admin：admin・staff の年度の団体は Y1 の3団体（Y2 の G3 は入らない）');
select tests.logout();

-- 部門長・副部門長（T15）：ロールの年度は Y1。集合は渡したロールの配列どおり（段の配列を渡すポリシーで、head・deputy_head が入る）
select tests.login_as('head');
select set_eq($q$ select private.my_role_year_ids('{admin,head,deputy_head}') $q$, array[tests.id('Y1')], 'head：部門長以上の年度は Y1');
select is_empty($q$ select private.my_role_year_ids('{admin,staff,viewer}') $q$, 'head：admin・staff・viewer の年度はない');
select set_eq($q$ select private.my_role_group_ids('{admin,head,deputy_head,staff}') $q$, array[tests.id('G1'), tests.id('G2'), tests.id('G4')],
  'head：総務の年度の団体は Y1 の3団体');
select is_empty($q$ select private.my_group_ids() $q$, 'head：代表の団体はない');
select tests.logout();
select tests.login_as('deputy');
select set_eq($q$ select private.my_role_year_ids('{deputy_head}') $q$, array[tests.id('Y1')], 'deputy：副部門長の年度は Y1');
select is_empty($q$ select private.my_role_year_ids('{head}') $q$, 'deputy：head（部門長）のロールの年度はない（副部門長は別のロール）');
select set_eq($q$ select private.my_role_year_ids('{admin,head,deputy_head}') $q$, array[tests.id('Y1')], 'deputy：部門長以上の年度は Y1');
select tests.logout();

select tests.login_as('rep');
select set_eq($q$ select private.my_role_year_ids('{admin,staff,viewer}') $q$, array[tests.id('Y2')], 'rep：ロールの年度は Y2（viewer）だけ');
select set_eq($q$ select private.my_group_ids() $q$, array[tests.id('G1')], 'rep：代表の団体は G1 だけ');
select set_eq($q$ select private.my_role_group_ids('{viewer}') $q$, array[tests.id('G3')], 'rep：viewer の年度の団体は Y2 の G3');
select is_empty($q$ select private.my_role_group_ids('{admin,staff}') $q$, 'rep：admin・staff の年度の団体はない');
select tests.logout();

select tests.login_as('staff');
select set_eq($q$ select private.my_group_ids() $q$, array[tests.id('G3')],
  'staff：代表の団体は Y2 の G3 だけ（兼任の禁止で、staff の年度〔Y1〕の団体代表は兼ねられない）');
select set_eq($q$ select private.my_role_year_ids('{staff}') $q$, array[tests.id('Y1')], 'staff：staff の年度は Y1');
select tests.logout();

select tests.login_as('outsider');
select is_empty($q$ select private.my_role_year_ids('{admin,staff,viewer}') union all select private.my_group_ids()
                    union all select private.my_role_group_ids('{admin,staff,viewer}') $q$,
  '未招待の人：3つの関数とも何も返さない');
select tests.logout();

-- ログインしていない（JWT に sub がない）authenticated
select set_config('request.jwt.claims', '{"role":"authenticated"}', true);
set local role authenticated;
select is_empty($q$ select private.my_role_year_ids('{admin,staff,viewer}') union all select private.my_group_ids()
                    union all select private.my_role_group_ids('{admin,staff,viewer}') $q$,
  'auth.uid() が null なら、3つの関数とも何も返さない');
select tests.logout();

-- 引数に利用者を取らない（ほかの人については答えられない）・実行の権限
select set_eq($q$ select p.oid::regprocedure::text from pg_proc p
                 where p.pronamespace = 'private'::regnamespace and p.proname in ('my_role_year_ids', 'my_group_ids', 'my_role_group_ids') $q$,
  array['private.my_role_year_ids(app_role[])', 'private.my_group_ids()', 'private.my_role_group_ids(app_role[])'],
  '新しい関数の引数はロールの配列だけ（利用者・年度・団体を取らない）');
select is_empty($q$ select p.proname::text from pg_proc p
                   where p.pronamespace = 'private'::regnamespace and p.proname in ('my_role_year_ids', 'my_group_ids', 'my_role_group_ids')
                     and not (p.prosecdef and p.provolatile = 's' and p.proretset
                              and coalesce(p.proconfig @> array['search_path=""'], false)) $q$,
  '新しい関数は SECURITY DEFINER・STABLE・setof・search_path = ""');
select is_empty($q$ select p.proname::text from pg_proc p
                   where p.pronamespace = 'private'::regnamespace and p.proname in ('my_role_year_ids', 'my_group_ids', 'my_role_group_ids')
                     and (has_function_privilege('anon', p.oid, 'execute') or not has_function_privilege('authenticated', p.oid, 'execute')
                          or exists (select 1 from aclexplode(p.proacl) a where a.grantee = 0)) $q$,
  '新しい関数は authenticated だけが実行できる（anon・PUBLIC は実行できない）');
select is_empty($q$ select p.proname::text from pg_proc p
                   where p.pronamespace = 'private'::regnamespace and p.proname in ('my_role_year_ids', 'my_group_ids', 'my_role_group_ids')
                     and has_function_privilege('supabase_auth_admin', p.oid, 'execute') $q$,
  '新しい関数は supabase_auth_admin も実行できない');
-- anon は private を usage できないので、呼べない
select tests.login_anon();
select throws_ok($q$ select private.my_group_ids() $q$, '42501', null, 'anon は新しい関数を呼べない');
select tests.logout();

-- お知らせの集合（T17。0014）：my_group_year_ids は自分が団体の代表（店長・副店長）である年度、my_group_notice_ids は自分が代表の
-- 団体を宛先の団体に含むお知らせ。どちらも呼んだ人についてだけ答え、ロール（総務・閲覧のみ）では答えない
select tests.login_as('rep');
select set_eq($q$ select private.my_group_year_ids() $q$, array[tests.id('Y1')], 'rep：代表である年度は Y1 だけ（Y2 は閲覧のみで、代表でない）');
select set_eq($q$ select private.my_group_notice_ids() $q$, array[tests.id('N_G1'), tests.id('N_G12')],
  'rep：自団体（G1）を宛先に含むお知らせは N_G1・N_G12（G4 あての N_G4 は入らない）');
select tests.logout();
select tests.login_as('rep2');
select set_eq($q$ select private.my_group_year_ids() $q$, array[tests.id('Y1')], 'rep2：代表である年度は Y1');
select set_eq($q$ select private.my_group_notice_ids() $q$, array[tests.id('N_G12')], 'rep2：自団体（G2）を宛先に含むお知らせは N_G12 だけ');
select tests.logout();
select tests.login_as('viewer');
select set_eq($q$ select private.my_group_year_ids() $q$, array[tests.id('Y1')], 'viewer：G4 の副店長として Y1（副店長も店長と同じ）');
select set_eq($q$ select private.my_group_notice_ids() $q$, array[tests.id('N_G4')], 'viewer：G4 を宛先に含むお知らせは N_G4');
select tests.logout();
select tests.login_as('staff');
select set_eq($q$ select private.my_group_year_ids() $q$, array[tests.id('Y2')], 'staff：G3 の店長として Y2（staff の Y1 は入らない）');
select set_eq($q$ select private.my_group_notice_ids() $q$, array[tests.id('N_Y2_G3')], 'staff：G3 を宛先に含むお知らせは N_Y2_G3');
select tests.logout();
select tests.login_as('admin');
select is_empty($q$ select private.my_group_year_ids() union all select private.my_group_notice_ids() $q$,
  'admin：団体の代表でないので、どちらも何も返さない（総務の年度・お知らせは入らない）');
select tests.logout();
select tests.login_as('outsider');
select is_empty($q$ select private.my_group_year_ids() union all select private.my_group_notice_ids() $q$,
  '未招待の人：お知らせの集合の関数は何も返さない');
select tests.logout();
select set_config('request.jwt.claims', '{"role":"authenticated"}', true);
set local role authenticated;
select is_empty($q$ select private.my_group_year_ids() union all select private.my_group_notice_ids() $q$,
  'auth.uid() が null なら、お知らせの集合の関数は何も返さない');
select tests.logout();
select is_empty($q$ select p.oid::regprocedure::text from pg_proc p
                   where p.pronamespace = 'private'::regnamespace and p.proname in ('my_group_year_ids', 'my_group_notice_ids')
                     and not (p.pronargs = 0 and p.prosecdef and p.provolatile = 's' and p.proretset
                              and p.prorettype = 'uuid'::regtype and coalesce(p.proconfig @> array['search_path=""'], false)) $q$,
  'お知らせの集合の関数は引数を取らず（ほかの人については答えられない）、SECURITY DEFINER・STABLE・setof uuid・search_path = ""');
select is((select count(*)::int from pg_proc p
           where p.pronamespace = 'private'::regnamespace and p.proname in ('my_group_year_ids', 'my_group_notice_ids')
             and has_function_privilege('authenticated', p.oid, 'execute') and not has_function_privilege('anon', p.oid, 'execute')
             and not has_function_privilege('supabase_auth_admin', p.oid, 'execute')
             and not exists (select 1 from aclexplode(p.proacl) a where a.grantee = 0)), 2,
  'お知らせの集合の関数は authenticated だけが実行できる（anon・supabase_auth_admin・PUBLIC は実行できない）');
select tests.login_anon();
select throws_ok($q$ select private.my_group_notice_ids() $q$, '42501', null, 'anon はお知らせの集合の関数を呼べない');
select tests.logout();

-- 提出物の集合（T19。0016）：my_group_document_ids は自分が代表の団体が対象（区分・飲食）の提出物、my_document_upload_paths は自分が
-- 予約した、終了でない年度の、今書ける提出（店長・副店長は未提出・差し戻し、部門長以上は承認でない）の path、my_document_orphan_paths は
-- 自分の範囲（1つ目のフォルダが部門長以上の年度、または2つ目が自分の団体）の、どの提出にも属さない物の path。どれも呼んだ人についてだけ答える
create function tests.path_label(p_path text) returns text language sql stable as $$
  select coalesce((select t.name from tests.ids t where t.id::text = split_part(split_part(p_path, '/', 4), '.', 1)),
                  replace(replace(p_path, tests.id('Y1')::text, 'Y1'), tests.id('G1')::text, 'G1'))
$$;
grant execute on function tests.path_label(text) to authenticated;
create function tests.doc_sets(p_persona text) returns text language plpgsql as $$
declare v text;
begin
  perform tests.login_as(p_persona);
  select format('%s | %s | %s',
    coalesce((select string_agg(t.name, ' ' order by t.name collate "C") from private.my_group_document_ids() x(id) join tests.ids t on t.id = x.id), '-'),
    coalesce((select string_agg(tests.path_label(x.p), ' ' order by tests.path_label(x.p) collate "C") from private.my_document_upload_paths() x(p)), '-'),
    coalesce((select string_agg(tests.path_label(x.p), ' ' order by tests.path_label(x.p) collate "C") from private.my_document_orphan_paths() x(p)), '-'))
  into v;
  perform tests.logout();
  return v;
end $$;
select is(tests.doc_sets('rep'), 'DOC_FOOD DOC_NOFILE DOC_STALL | F13_REP | O_G1 pgtap/G1/x.pdf',
  'rep（G1 の店長。G1 は飲食）：対象の提出物は飲食だけのものを含む3つ、上げられるのは未提出の提出の自分の予約だけ（提出済みの F_G1 は入らない）、'
  || '消せるのは G1 のフォルダのどの提出にも属さない物');
select is(tests.doc_sets('rep2'), 'DOC_NOFILE DOC_STALL | F13_REP2 | O13_G2',
  'rep2（G2 の店長。学科）：飲食だけの提出物は対象でない。差し戻しの提出の自分の予約は上げられる');
select is(tests.doc_sets('viewer'), 'DOC_NOFILE DOC_STALL | - | -',
  'viewer（G4 の副店長）：承認の提出の自分の予約（F13_VIEWER）は上げられない。閲覧のみのロールでは何も答えない');
select is(tests.doc_sets('staff'), 'DOC_Y2 | F_Y2 | -',
  'staff（Y2 の G3 の店長。飲食でない）：Y2 の飲食だけの提出物は対象でない。Y1 の部門員のロールでは何も答えない');
select is(tests.doc_sets('head'), '- | F13_HEAD | O13_G2 O_G1 Y1',
  'head：代表の団体はない。提出済みの提出への自分の代理の予約は上げられる。Y1 のフォルダのどの提出にも属さない物を全部消せる');
select is(tests.doc_sets('admin'), '- | - | O13_G2 O_G1 Y1', 'admin：自分の予約はない（ほかの人の予約は入らない）');
select is(tests.doc_sets('admin2'), '- | - | -', 'admin2：Y2 にはどの提出にも属さない物がない（Y1 の物は入らない）');
select is(tests.doc_sets('outsider'), '- | - | -', '未招待の人：提出物の集合の関数は何も返さない');
select tests.set_scenario('closed');
select is(tests.doc_sets('rep') || ' / ' || tests.doc_sets('head') || ' / ' || tests.doc_sets('staff'),
  'DOC_FOOD DOC_NOFILE DOC_STALL | - | O_G1 pgtap/G1/x.pdf / - | - | O13_G2 O_G1 Y1 / DOC_Y2 | F_Y2 | -',
  '終了の年度（Y1）の予約は上げられない（Y2 の予約は上げられる）。対象の提出物とどの提出にも属さない物は変わらない');
select tests.set_scenario('requesting');
select set_config('request.jwt.claims', '{"role":"authenticated"}', true);
set local role authenticated;
select is_empty($q$ select private.my_group_document_ids()::text union all select private.my_document_upload_paths()
                    union all select private.my_document_orphan_paths() $q$,
  'auth.uid() が null なら、提出物の集合の関数は何も返さない');
select tests.logout();
select is((select string_agg(p.proname || ':' || format_type(p.prorettype, null), ' ' order by p.proname) from pg_proc p
           where p.pronamespace = 'private'::regnamespace
             and p.proname in ('my_group_document_ids', 'my_document_upload_paths', 'my_document_orphan_paths')
             and p.pronargs = 0 and p.prosecdef and p.provolatile = 's' and p.proretset
             and coalesce(p.proconfig @> array['search_path=""'], false)),
  'my_document_orphan_paths:text my_document_upload_paths:text my_group_document_ids:uuid',
  '提出物の集合の関数は引数を取らず（ほかの人については答えられない）、SECURITY DEFINER・STABLE・setof・search_path = ""');
select is((select count(*)::int from pg_proc p
           where p.pronamespace = 'private'::regnamespace
             and p.proname in ('my_group_document_ids', 'my_document_upload_paths', 'my_document_orphan_paths')
             and has_function_privilege('authenticated', p.oid, 'execute') and not has_function_privilege('anon', p.oid, 'execute')
             and not has_function_privilege('supabase_auth_admin', p.oid, 'execute')
             and not exists (select 1 from aclexplode(p.proacl) a where a.grantee = 0)), 3,
  '提出物の集合の関数は authenticated だけが実行できる（anon・supabase_auth_admin・PUBLIC は実行できない）');
select tests.login_anon();
select throws_ok($q$ select private.my_document_upload_paths() $q$, '42501', null, 'anon は提出物の集合の関数を呼べない');
select tests.logout();

-- ---------------------------------------------------------------- ③ audit_logs：年度をまたぐ表の行と、開いていない年度
create function tests.audit_counts(p_persona text) returns text language plpgsql as $$
declare v text;
begin
  perform tests.login_as(p_persona);
  select format('Y1=%s Y2=%s null3=%s null_other=%s',
                (count(*) filter (where year_id = tests.id('Y1')) > 0)::text,
                (count(*) filter (where year_id = tests.id('Y2')) > 0)::text,
                (count(*) filter (where year_id is null and table_name in ('rooms', 'items', 'distance_overrides')) > 0)::text,
                (count(*) filter (where year_id is null and table_name not in ('rooms', 'items', 'distance_overrides')) > 0)::text)
  into v from public.audit_logs;
  perform tests.logout();
  return v;
end $$;

select tests.set_scenario('requesting');
select is(tests.audit_counts('admin'), 'Y1=true Y2=false null3=true null_other=false',
  'Y1（開いている）の admin：Y1 の行と、年度をまたぐ3表の行が見える。Y2 の行と、3表のほかの年度のない行は見えない');
select is(tests.audit_counts('head'), 'Y1=true Y2=false null3=false null_other=false',
  'Y1 の部門長：Y1 の行は読めるが、年度をまたぐ3表の行（管理者だけ）は読めない');
select is(tests.audit_counts('deputy'), 'Y1=true Y2=false null3=false null_other=false', 'Y1 の副部門長も部門長と同じ');
select is(tests.audit_counts('staff'), 'Y1=false Y2=false null3=false null_other=false', 'staff は履歴を読めない');
select is(tests.audit_counts('outsider'), 'Y1=false Y2=false null3=false null_other=false', '未招待の人は履歴を読めない');
select tests.set_scenario('closed');
select is(tests.audit_counts('admin'), 'Y1=true Y2=false null3=false null_other=false',
  'Y1 が closed：admin は Y1 の行は読めるが、年度をまたぐ表の行は読めない（closed でない年度の admin でないため。D-01）');
select is(tests.audit_counts('head'), 'Y1=true Y2=false null3=false null_other=false', 'Y1 が closed でも、部門長は Y1 の行を読める');
select is(tests.audit_counts('admin2'), 'Y1=false Y2=true null3=true null_other=false',
  'Y1 が closed でも、Y2（preparing）の admin は年度をまたぐ表の行を読める');
-- admin が Y2 の admin も兼ねる：開いている年度があれば、年度をまたぐ表の行が読める
insert into public.year_roles (year_id, user_id, role) values (tests.id('Y2'), tests.id('admin'), 'admin');
select is(tests.audit_counts('admin'), 'Y1=true Y2=true null3=true null_other=false',
  'closed の Y1 と開いている Y2 の admin：両方の年度の行と、年度をまたぐ表の行を読める');
update public.years set status = 'closed' where id = tests.id('Y2');
select is(tests.audit_counts('admin'), 'Y1=true Y2=true null3=false null_other=false',
  '両方の年度が closed：年度の行は読めるが、年度をまたぐ表の行は読めない');
select is(tests.audit_counts('admin2'), 'Y1=false Y2=true null3=false null_other=false',
  'closed の Y2 だけの admin：Y2 の行だけ読める');
delete from public.year_roles where year_id = tests.id('Y2') and user_id = tests.id('admin');
update public.years set status = 'preparing' where id = tests.id('Y2');
select tests.set_scenario('requesting');

-- ---------------------------------------------------------------- ④ 書き方の決まり：select のポリシーで、行の列を判定関数に渡さない
-- （「(select private.f())」の initPlan と「列 in (select private.集合())」は1回だけ評価される。allocations の year_status は
-- 見える側の行でしか呼ばれないので例外）
select is_empty($q$ select tablename::text || ': ' || qual from pg_policies
                   where schemaname = 'public' and cmd = 'SELECT'
                     and tablename in ('audit_logs', 'allocations', 'requests', 'request_submissions', 'substitution_consents',
                                       'stocks', 'groups')
                     and regexp_replace(qual, 'private\.year_status\(year_id\)', '', 'g')
                         ~ '(?<!SELECT )private\.[a-z_]+\((year_id|group_id|id|user_id|private\.)' $q$,
  '7 表の select のポリシーは、行の列を判定関数に渡さない（集合を1回作る形）');
select ok((select qual ~ 'SELECT private\.my_role_year_ids' and qual ~ 'SELECT private\.is_admin_of_open_year'
           from pg_policies where schemaname = 'public' and policyname = 'audit_logs_select'),
  'audit_logs_select は my_role_year_ids の集合と (select is_admin_of_open_year()) を使う');
create function tests.explain_lines(p_sql text) returns setof text language plpgsql as $$
begin
  return query execute 'explain (costs off) ' || p_sql;
end $$;
grant execute on function tests.explain_lines(text) to authenticated;
-- 実行計画でも、判定関数は1回だけ（initPlan・hashed SubPlan）。行ごとに呼ぶ形なら Filter に関数が直接出る
select tests.login_as('outsider');
select ok((select string_agg(l, E'\n') from (select * from tests.explain_lines('select * from public.audit_logs')) x(l))
          !~ 'Filter: .*private\.has_role',
  'audit_logs の読みの計画の Filter に、行ごとの has_role が出ない');
select tests.logout();

-- お知らせ（T17）：notices・notice_groups の select のポリシーも集合を1回作る形。宛先で分ける枝は宛先を名前で並べる
-- （否定〔<> 'soumu'〕で書くと、宛先の種類を足したときに閲覧のみ・団体の代表へ黙って広がる）
select is_empty($q$ select tablename::text || ': ' || qual from pg_policies
                   where schemaname = 'public' and cmd = 'SELECT' and tablename in ('notices', 'notice_groups')
                     and qual ~ '(?<!SELECT )private\.[a-z_]+\((year_id|group_id|id|user_id|audience|private\.)' $q$,
  'お知らせの2表の select のポリシーは、行の列を判定関数に渡さない（集合を1回作る形）');
select ok((select qual ~ 'SELECT private\.my_role_year_ids' and qual ~ 'SELECT private\.my_group_year_ids\(\)'
                  and qual ~ 'SELECT private\.my_group_notice_ids\(\)' and qual !~ '<>' and qual !~ '\mNOT\M'
           from pg_policies where schemaname = 'public' and policyname = 'notices_select'),
  'notices_select は my_role_year_ids・my_group_year_ids・my_group_notice_ids の集合を使い、宛先を否定で書かない');
select ok((select qual ~ 'SELECT private\.my_role_year_ids' and qual ~ 'SELECT private\.my_group_ids\(\)'
           from pg_policies where schemaname = 'public' and policyname = 'notice_groups_select'),
  'notice_groups_select は my_role_year_ids・my_group_ids の集合を使う');
select tests.login_as('outsider');
select ok((select string_agg(l, E'\n') from (select * from tests.explain_lines('select * from public.notices')) x(l))
          !~ '(?n)Filter: .*private\.',
  'notices の読みの計画の Filter に、行ごとの判定関数が出ない（hashed SubPlan だけ）');
select ok((select string_agg(l, E'\n') from (select * from tests.explain_lines('select * from public.notice_groups')) x(l))
          !~ '(?n)Filter: .*private\.',
  'notice_groups の読みの計画の Filter に、行ごとの判定関数が出ない');
select tests.logout();

-- 予定と締切（T18）：events の select のポリシーも集合を1回作る形。対象で分ける枝は対象を名前で並べる（groups・all。総務〔soumu〕を
-- 否定で除く形〔<> 'soumu'〕で書くと、対象の種類を足したときに閲覧のみ・団体の代表へ黙って広がる）
select is_empty($q$ select tablename::text || ': ' || qual from pg_policies
                   where schemaname = 'public' and cmd = 'SELECT' and tablename = 'events'
                     and qual ~ '(?<!SELECT )private\.[a-z_]+\((year_id|group_id|id|user_id|audience|private\.)' $q$,
  '予定と締切の select のポリシーは、行の列を判定関数に渡さない（集合を1回作る形）');
select ok((select qual ~ 'SELECT private\.my_role_year_ids' and qual ~ 'SELECT private\.my_group_year_ids\(\)'
                  and qual ~ '''groups''::event_audience' and qual ~ '''all''::event_audience'
                  and qual !~ '''soumu''' and qual !~ '<>' and qual !~ '\mNOT\M'
           from pg_policies where schemaname = 'public' and policyname = 'events_select'),
  'events_select は my_role_year_ids・my_group_year_ids の集合を使い、対象を名前（groups・all）で並べ、否定で書かない');
select tests.login_as('outsider');
select ok((select string_agg(l, E'\n') from (select * from tests.explain_lines('select * from public.events')) x(l))
          !~ '(?n)Filter: .*private\.',
  'events の読みの計画の Filter に、行ごとの判定関数が出ない（hashed SubPlan だけ）');
select tests.logout();

-- 提出物（T19）：3表の select のポリシーと v_document_status の where も集合を1回作る形（行の列を判定関数に渡さない）。閲覧のみは配列に
-- 入れない（Q5）。ファイルは部門長以上の配列（staff を入れない。Q4）
select is_empty($q$ select tablename::text || ': ' || qual from pg_policies
                   where schemaname = 'public' and cmd = 'SELECT' and tablename in ('documents', 'document_submissions', 'document_files')
                     and qual ~ '(?<!SELECT )private\.[a-z_]+\((year_id|group_id|id|user_id|target_categories|private\.)' $q$,
  '提出物の3表の select のポリシーは、行の列を判定関数に渡さない（集合を1回作る形）');
select is((select string_agg(policyname || '=' || (regexp_match(qual, 'my_role_year_ids\(''(\{[a-z_,]+\})'''))[1]
                             || case when qual ~ 'SELECT private\.my_group_document_ids\(\)' then '+group_documents' else '' end
                             || case when qual ~ 'SELECT private\.my_group_ids\(\)' then '+groups' else '' end, ' ' order by policyname)
           from pg_policies where schemaname = 'public' and cmd = 'SELECT' and tablename in ('documents', 'document_submissions', 'document_files')),
  'document_files_select={admin,head,deputy_head}+groups document_submissions_select={admin,head,deputy_head,staff}+groups '
  || 'documents_select={admin,head,deputy_head,staff}+group_documents',
  '提出物の select のポリシーの段の配列と集合（閲覧のみを入れない。ファイルは部門長以上と自団体だけ）');
select ok((select pg_get_viewdef('public.v_document_status'::regclass) !~ '(?<!SELECT )private\.[a-z_]+\((d\.|g\.|s\.|year_id|group_id|private\.)'),
  'v_document_status の where は、行の列を判定関数に渡さない（集合を1回作る形）');
-- Storage（T19）：storage.objects の3つのポリシーも集合を1回作る形。行ごとには組み込みの split_part（文字列を分けるだけ）だけを呼ぶ
select is_empty($q$ select policyname || ': ' || coalesce(qual, '') || ' ' || coalesce(with_check, '') from pg_policies
                   where schemaname = 'storage' and tablename = 'objects'
                     and coalesce(qual, '') || ' ' || coalesce(with_check, '')
                         ~ '(?<!SELECT |FROM )private\.[a-z_]+\((name|bucket_id|owner|owner_id|metadata|private\.|split_part)' $q$,
  'storage.objects のポリシーは、行の列を判定関数に渡さない（集合を1回作る形）');
select ok((select qual ~ 'split_part\(name, ''/''::text, 1\) IN \( SELECT \(y\.y\)::text AS y\s+FROM private\.my_role_year_ids\(''\{admin,head,deputy_head\}''::app_role\[\]\) y\(y\)\)'
                  and qual ~ 'split_part\(name, ''/''::text, 2\) IN \( SELECT \(g\.g\)::text AS g\s+FROM private\.my_group_ids\(\) g\(g\)\)'
                  and qual !~ 'storage\.foldername'
           from pg_policies where schemaname = 'storage' and policyname = 'documents_objects_select'),
  'documents_objects_select は1つ目のフォルダを部門長以上の年度の集合と、2つ目を自分の団体の集合と比べる（split_part。storage の補助によらない）');
select tests.login_as('outsider');
select ok((select string_agg(l, E'\n') from (select * from tests.explain_lines('select * from public.documents')) x(l))
          !~ '(?n)Filter: .*private\.',
  'documents の読みの計画の Filter に、行ごとの判定関数が出ない（hashed SubPlan だけ）');
select ok((select string_agg(l, E'\n') from (select * from tests.explain_lines('select * from public.document_submissions')) x(l))
          !~ '(?n)Filter: .*private\.',
  'document_submissions の読みの計画の Filter に、行ごとの判定関数が出ない');
select ok((select string_agg(l, E'\n') from (select * from tests.explain_lines('select * from public.document_files')) x(l))
          !~ '(?n)Filter: .*private\.',
  'document_files の読みの計画の Filter に、行ごとの判定関数が出ない');
select ok((select string_agg(l, E'\n') from (select * from tests.explain_lines('select * from storage.objects')) x(l))
          !~ '(?n)Filter: .*private\.',
  'storage.objects の読みの計画の Filter に、行ごとの判定関数が出ない（split_part と hashed SubPlan だけ）');
select tests.logout();
select tests.login_as('rep');
select ok((select string_agg(l, E'\n') from (select * from tests.explain_lines('select * from public.v_document_status')) x(l))
          !~ '(?n)(Filter|Join Filter|Cond): .*private\.',
  'v_document_status の読みの計画にも、行ごとの判定関数が出ない（ビューの where と下の表のポリシー）');
select tests.logout();

-- ---------------------------------------------------------------- ⑤ Storage：3つのポリシーが行ごとの形の述語と同じ物を選ぶ（T19）
-- 行ごとの形の述語は 02 の「提出物の権限」の Storage の表から書いた。select：1つ目のフォルダが自分の部門長以上の年度か、2つ目が自分の団体。
-- insert：自分が予約した、終了でない年度の、今書ける提出の path。delete：select の範囲の、document_files に行のない物。
-- 9 人 × Y1 の6状態 × Y2 の2状態で、select は見える物を中身ごと、insert は予約の path と予約していない path の全部に1つずつ上げてみて、
-- delete は bucket の物を1つずつ消してみて（storage.allow_delete_query を立てて）、許されるかを比べる
create function tests.is_uuid_text(p text) returns boolean language sql immutable as $$
  select p ~ '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$'
$$;
create function tests.storage_old_select(p_bucket text, p_name text) returns boolean language sql stable as $$
  select p_bucket = 'documents'
         and (case when tests.is_uuid_text(split_part(p_name, '/', 1))
                   then private.has_any_role(split_part(p_name, '/', 1)::uuid, '{admin,head,deputy_head}') else false end
              or case when tests.is_uuid_text(split_part(p_name, '/', 2))
                      then private.is_group_member(split_part(p_name, '/', 2)::uuid) else false end)
$$;
create function tests.storage_old_insert(p_bucket text, p_name text) returns boolean language sql stable as $$
  select p_bucket = 'documents'
         and exists (select 1 from public.document_files f
                     join public.document_submissions s on s.document_id = f.document_id and s.group_id = f.group_id
                     where f.object_path = p_name and f.created_by = auth.uid() and private.year_status(f.year_id) <> 'closed'
                       and ((s.status in ('not_submitted', 'returned') and private.is_group_member(f.group_id))
                            or (s.status <> 'approved' and private.has_any_role(f.year_id, '{admin,head,deputy_head}'))))
$$;
create function tests.storage_old_delete(p_bucket text, p_name text) returns boolean language sql stable as $$
  select tests.storage_old_select(p_bucket, p_name)
         and not exists (select 1 from public.document_files f where f.object_path = p_name)
$$;
-- 試す物と path（bucket と name）：bucket の全部の物と、予約の path の全部と、予約していない path
create function tests.storage_candidates() returns table (bucket text, name text) language sql stable as $$
  select o.bucket_id, o.name from storage.objects o
  union
  select 'documents', f.object_path from public.document_files f
  union
  select 'documents', tests.id('Y1') || '/' || tests.id('G1') || '/' || tests.id('DOC_NOFILE') || '/' || tests.id('outsider') || '.pdf'
$$;
create function tests.storage_old(p_persona text) returns text language plpgsql as $$
declare v text;
begin
  perform tests.act_as(p_persona);                       -- postgres のまま（RLS を通らない）。auth.uid() だけを変える
  select format('select=%s insert=%s delete=%s',
    coalesce(string_agg(c.bucket || ':' || tests.path_label(c.name), ' ' order by c.bucket, tests.path_label(c.name) collate "C")
             filter (where tests.storage_old_select(c.bucket, c.name)
                     and exists (select 1 from storage.objects o where o.bucket_id = c.bucket and o.name = c.name)), '-'),
    coalesce(string_agg(c.bucket || ':' || tests.path_label(c.name), ' ' order by c.bucket, tests.path_label(c.name) collate "C")
             filter (where tests.storage_old_insert(c.bucket, c.name)), '-'),
    coalesce(string_agg(c.bucket || ':' || tests.path_label(c.name), ' ' order by c.bucket, tests.path_label(c.name) collate "C")
             filter (where tests.storage_old_delete(c.bucket, c.name)
                     and exists (select 1 from storage.objects o where o.bucket_id = c.bucket and o.name = c.name)), '-'))
  into v from tests.storage_candidates() c;
  perform tests.act_clear();
  return v;
end $$;
-- 1つの path に authenticated で上げてみる（取り消す）。ポリシーが許せば通るか一意の索引で止まる（23505。もう届いている）、許さなければ 42501
create function tests.try_upload(p_persona text, p_bucket text, p_name text) returns boolean language plpgsql as $$
declare v boolean;
begin
  begin
    perform tests.login_as(p_persona);
    insert into storage.objects (bucket_id, name, metadata) values (p_bucket, p_name, '{"size": 1}');
    v := true;
    raise exception using errcode = 'TT001';
  exception
    when sqlstate 'TT001' then null;
    when unique_violation then v := true;
    when insufficient_privilege then v := false;
  end;
  return v;
end $$;
-- 1つの物を authenticated で消してみる（取り消す）。消せた行の数が 1 なら許された
create function tests.try_remove(p_persona text, p_bucket text, p_name text) returns boolean language plpgsql as $$
declare v boolean; n bigint;
begin
  begin
    perform set_config('storage.allow_delete_query', 'true', true);
    perform tests.login_as(p_persona);
    delete from storage.objects o where o.bucket_id = p_bucket and o.name = p_name;
    get diagnostics n = row_count;
    v := n = 1;
    raise exception using errcode = 'TT001';
  exception
    when sqlstate 'TT001' then null;
  end;
  return v;
end $$;
create function tests.storage_new(p_persona text) returns text language plpgsql as $$
declare v_select text; v_rest text;
begin
  perform tests.login_as(p_persona);
  select coalesce(string_agg(o.bucket_id || ':' || tests.path_label(o.name), ' ' order by o.bucket_id, tests.path_label(o.name) collate "C"), '-')
  into v_select from storage.objects o;
  perform tests.logout();
  select format('insert=%s delete=%s',
    coalesce(string_agg(c.bucket || ':' || tests.path_label(c.name), ' ' order by c.bucket, tests.path_label(c.name) collate "C")
             filter (where tests.try_upload(p_persona, c.bucket, c.name)), '-'),
    coalesce(string_agg(c.bucket || ':' || tests.path_label(c.name), ' ' order by c.bucket, tests.path_label(c.name) collate "C")
             filter (where exists (select 1 from storage.objects o where o.bucket_id = c.bucket and o.name = c.name)
                     and tests.try_remove(p_persona, c.bucket, c.name)), '-'))
  into v_rest from tests.storage_candidates() c;
  return 'select=' || v_select || ' ' || v_rest;
end $$;
create table tests.compared_storage (scenario text, persona text, old text, new text);
create function tests.compare_storage() returns void language plpgsql as $$
declare s1 text; s2 text; p text;
begin
  foreach s2 in array array['preparing', 'closed'] loop
    foreach s1 in array array['preparing', 'requesting', 'requesting:after', 'allocating', 'confirmed', 'closed'] loop
      perform tests.set_scenario(s1);
      update public.years set status = s2::public.year_status where id = tests.id('Y2');
      foreach p in array array['admin', 'staff', 'rep', 'rep2', 'viewer', 'outsider', 'admin2', 'head', 'deputy'] loop
        insert into tests.compared_storage values (s1 || ' / Y2 ' || s2, p, tests.storage_old(p), tests.storage_new(p));
      end loop;
    end loop;
  end loop;
  perform tests.set_scenario('requesting');
  update public.years set status = 'preparing' where id = tests.id('Y2');
end $$;
select tests.compare_storage();
select is_empty($q$ select scenario, persona, old, new from tests.compared_storage where old <> new $q$,
  'storage.objects の select・insert・delete のポリシーで許される物は、行ごとの形の述語で選ぶ物と同じ（9 人 × Y1 の6状態 × Y2 の2状態）');
-- 比べたものに中身がある（見える物・上げられる path・消せる物が、ペルソナ・状態で変わり、許される組がある）
select ok((select count(distinct new) >= 5 and bool_or(new ~ 'select=documents:') and bool_or(new ~ 'insert=documents:')
                  and bool_or(new ~ 'delete=documents:') from tests.compared_storage),
  'Storage の比べたものに中身がある（見える物・上げられる path・消せる物がある組と、ない組がある）');
select is((select new from tests.compared_storage where scenario = 'requesting / Y2 preparing' and persona = 'rep'),
  'select=documents:F13_REP documents:F_G1 documents:O_G1 documents:pgtap/G1/x.pdf insert=documents:F13_REP delete=documents:O_G1 documents:pgtap/G1/x.pdf',
  'rep（受付中）：G1 のフォルダの物が見え、自分の予約（F13_REP）に上げられ（届いていても一意の索引で止まるだけ）、どの提出にも属さない物を消せる');

select * from finish();
rollback;
