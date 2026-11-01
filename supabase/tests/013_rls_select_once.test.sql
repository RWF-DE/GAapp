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
-- T20：シフト・作業の5表（0017）も同じ形で書いたので、①の比べる表に足し（行ごとの形の述語は 02 の「シフト・作業の権限」から書いた）、
-- ④にポリシーの形と実行計画を足した（集合の関数は足していない）。
begin;
\ir _helpers/personas.psql
\ir _helpers/fixture.psql

-- 年度のない履歴の行：年度をまたぐ3表の行は fixture の rooms・items・distance_overrides の insert で監査のトリガーが書いた。
-- 3表のほかの表の年度のない行（ふつうはできないが、念のため）は誰にも見えない
insert into public.audit_logs (table_name, row_pk, action, year_id, before, after)
values ('years', '{}', 'update', null, '{"a":1}', '{"a":2}'), ('profiles', '{}', 'update', null, '{"a":1}', '{"a":2}');

select plan(80);

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
-- シフト・作業（T20）：5表とも、その年度の総務（admin・head・deputy_head・staff）だけが全部を読む（閲覧のみ・団体の代表の枝はない）
insert into tests.old_pred values
  ('shift_duties', $p$ private.has_any_role(year_id, '{admin,head,deputy_head,staff}') $p$),
  ('shift_slots', $p$ private.has_any_role(year_id, '{admin,head,deputy_head,staff}') $p$),
  ('shift_needs', $p$ private.has_any_role(year_id, '{admin,head,deputy_head,staff}') $p$),
  ('shift_assignments', $p$ private.has_any_role(year_id, '{admin,head,deputy_head,staff}') $p$),
  ('tasks', $p$ private.has_any_role(year_id, '{admin,head,deputy_head,staff}') $p$);

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
-- 比べたものに中身がある（全員 0 行や全員同じでは比べたことにならない）
select is_empty($q$ select tbl from tests.compared group by tbl
                    having count(distinct new) < 2 or not bool_or(new !~ '^0:') $q$,
  '10 表とも、ペルソナ・状態によって見える行が違い、見える行のある組がある');
-- シフト・作業（T20）
select is_empty(format($q$ select scenario, persona, old, new from tests.compared where tbl = %L and old <> new $q$, t),
  format('%s：D-47 の形のポリシーで見える行は、行ごとの形の述語で選ぶ行と同じ（9 人 × Y1 の6状態 × Y2 の2状態。T20）', t))
from unnest(array['shift_duties', 'shift_slots', 'shift_needs', 'shift_assignments', 'tasks']) t;
select is((select count(distinct tbl)::int from tests.compared
           where tbl in ('shift_duties', 'shift_slots', 'shift_needs', 'shift_assignments', 'tasks')
             and new !~ '^0:'
             and tbl in (select tbl from tests.compared group by tbl having count(distinct new) >= 3)), 5,
  'シフト・作業の5表とも、見える行のある組があり、ペルソナで見える行が分かれる（Y1 の総務・Y2 の総務・何も見えない人の3通り以上）');

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

-- シフト・作業（T20）：5表の select のポリシーも集合を1回作る形で、総務の年度の集合（my_role_year_ids）だけを使う（閲覧のみ・店長・副店長の
-- 枝はない。段の配列に viewer を足すと閲覧のみに見えてしまう）
select is_empty($q$ select tablename::text || ': ' || qual from pg_policies
                   where schemaname = 'public' and cmd = 'SELECT'
                     and tablename in ('shift_duties', 'shift_slots', 'shift_needs', 'shift_assignments', 'tasks')
                     and qual ~ '(?<!SELECT )private\.[a-z_]+\((year_id|group_id|id|user_id|slot_id|duty_id|assignee_id|private\.)' $q$,
  'シフト・作業の5表の select のポリシーは、行の列を判定関数に渡さない（集合を1回作る形）');
select is((select string_agg(tablename || '=' || qual, ' / ' order by tablename collate "C") from pg_policies
           where schemaname = 'public' and cmd = 'SELECT'
             and tablename in ('shift_duties', 'shift_slots', 'shift_needs', 'shift_assignments', 'tasks')),
  (select string_agg(t || '=(year_id IN ( SELECT private.my_role_year_ids(''{admin,head,deputy_head,staff}''::app_role[]) AS my_role_year_ids))', ' / '
                     order by t collate "C")
   from unnest(array['shift_duties', 'shift_slots', 'shift_needs', 'shift_assignments', 'tasks']) t),
  'シフト・作業の5表の select のポリシーは、どれも year_id in (総務〔admin・head・deputy_head・staff〕の年度の集合) だけ');
select tests.login_as('outsider');
select is((select string_agg(t, ' ' order by t collate "C")
           from unnest(array['shift_duties', 'shift_slots', 'shift_needs', 'shift_assignments', 'tasks']) t
           where (select string_agg(l, E'\n') from tests.explain_lines('select * from public.' || t) l) ~ '(?n)Filter: .*private\.'), null,
  'シフト・作業の5表の読みの計画の Filter に、行ごとの判定関数が出ない（hashed SubPlan だけ）');
select tests.logout();

select * from finish();
rollback;
