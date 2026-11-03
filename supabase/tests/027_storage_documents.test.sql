-- 027_storage_documents：Supabase Storage の bucket documents と storage.objects のポリシー（T19。D-55。0016_documents.sql）
-- storage-api なしで、authenticated（・anon）に切り替えて storage.objects を SQL で操作する。Storage API の upload は insert（返り値を読むので
-- select も）、download・署名つき URL・list は select、remove は select と delete を、呼んだ人の権限で行うので、同じポリシーが効く。
-- 期待値は 02 の「提出物の権限」の Storage の表と notes/T19.md の「SQL の約束」から先に書いてから流した。
-- ① select：部門長以上は年度のフォルダ（1つ目）、店長・副店長は自団体のフォルダ（2つ目）の物。DB の行でなくフォルダで決める。部門員・
--    閲覧のみ・未招待・anon は何も読めない。ほかの bucket の物は誰も読めない。年度の状態によらない
-- ② insert：予約した人の、予約した path だけ（店長・副店長は未提出・差し戻し、部門長以上は承認でない、終了でない年度）。届いた後の2回目は
--    一意の索引で止まる（23505。Storage API は 409）
-- ③ update：ポリシーがないので 0 行（上書き・移動・upsert はできない）
-- ④ delete：storage.allow_delete_query を立てないと誰も消せない（storage.protect_delete。42501）。立てると、範囲の中のどの提出にも属さない物だけ
-- ⑤ 流れ：予約 → 上げる → v_document_files で届いたと分かる → 外す → どの提出にも属さない物になる → 消す
-- ⑥ bucket の設定と storage の表の権限（Supabase の既定のまま）と、書き込みを確かめるトリガー documents_objects_guard
-- ⑦ スーパーユーザーの書き込み（T19 のレビューの T19-SEC-1）：service_role（Storage API の署名つきアップロードの書き込み）と postgres でも、
--    承認・終了の後・予約のない path・上書き・移動・申告を超える大きさはトリガーが止める（42501）。正しい道は通る
-- ペルソナと提出物は fixture（026 の頭の注を参照）。Storage の fixture：F_G1 の物（1000 B。行あり）、O_G1（G1 のフォルダ。行なし）、
-- ほかの bucket（pgtap-other）の F_G1 と同じ path の物
begin;
\ir _helpers/personas.psql
\ir _helpers/fixture.psql

-- 027 だけで使う予約と物：
--   R_REP（rep。G1 の DOC_NOFILE。未提出）、R_REP_SUB（rep。G1 の DOC_STALL。提出済み）、R_HEAD（head の代理。G1 の DOC_STALL。提出済み）、
--   R_REP2（rep2。G2 の DOC_STALL。差し戻し）、R_VIEWER（viewer。G4 の DOC_NOFILE。承認）。どれも届いていない。F_Y2（staff。Y2 の G3）も届いていない。
--   O_G2（Y1・G2 のフォルダ）と O_Y2（Y2・G3 のフォルダ）は、どの提出にも属さない物
insert into tests.ids values ('R_REP', gen_random_uuid()), ('R_REP_SUB', gen_random_uuid()), ('R_HEAD', gen_random_uuid()),
  ('R_REP2', gen_random_uuid()), ('R_VIEWER', gen_random_uuid()), ('O_G2', gen_random_uuid()), ('O_Y2', gen_random_uuid()),
  ('F_FLOW', gen_random_uuid()), ('F_NONE', gen_random_uuid());
create function tests.doc_path(p_year text, p_group text, p_doc text, p_file text) returns text language sql stable as $$
  select tests.id(p_year) || '/' || tests.id(p_group) || '/' || tests.id(p_doc) || '/' || tests.id(p_file) || '.pdf'
$$;
insert into public.document_submissions (document_id, group_id, year_id) values (tests.id('DOC_NOFILE'), tests.id('G1'), tests.id('Y1'));
insert into public.document_files (id, year_id, document_id, group_id, object_path, content_type, size, created_by)
select tests.id(f), tests.id(y), tests.id(d), tests.id(g), tests.doc_path(y, g, d, f), 'application/pdf', 100, tests.id(u)
from (values ('R_REP', 'Y1', 'G1', 'DOC_NOFILE', 'rep'), ('R_REP_SUB', 'Y1', 'G1', 'DOC_STALL', 'rep'), ('R_HEAD', 'Y1', 'G1', 'DOC_STALL', 'head'),
             ('R_REP2', 'Y1', 'G2', 'DOC_STALL', 'rep2'), ('R_VIEWER', 'Y1', 'G4', 'DOC_NOFILE', 'viewer')) v(f, y, g, d, u);
-- どの提出にも属さない物は予約の外なので、tests.put_object（fixture。トリガーを飛ばして置く）で置く
select tests.put_object('documents', tests.doc_path(y, g, d, f), m::jsonb)
from (values ('Y1', 'G2', 'DOC_STALL', 'O_G2', '{"size": 20}'), ('Y2', 'G3', 'DOC_Y2', 'O_Y2', '{"size": 30}')) v(y, g, d, f, m);

-- path の4つ目のフォルダ（ファイルの id）の名前
create function tests.path_name(p_path text) returns text language sql stable as $$
  select coalesce((select t.name from tests.ids t where t.id::text = split_part(split_part(p_path, '/', 4), '.', 1)), p_path)
$$;
grant execute on function tests.doc_path(text, text, text, text), tests.path_name(text) to authenticated, anon;
-- ペルソナ（anon も）に切り替えて、見える storage.objects の物を「bucket:名前」で並べる（取り消す。p_setup は先に postgres で流す）
create function tests.visible_objects(p_persona text, p_setup text default null) returns text language plpgsql as $$
declare v text;
begin
  begin
    if p_setup is not null then execute tests.sql(p_setup); end if;
    if p_persona = 'anon' then perform tests.login_anon(); else perform tests.login_as(p_persona); end if;
    select coalesce(string_agg(o.bucket_id || ':' || tests.path_name(o.name), ' ' order by o.bucket_id, tests.path_name(o.name) collate "C"), '-')
    into v from storage.objects o;
    raise exception using errcode = 'TT001';
  exception when sqlstate 'TT001' then null;
  end;
  return v;
end $$;
-- 上げてみる（取り消す）：ok か error:<SQLSTATE>（42501 はポリシーの違反、23505 はもう届いている）
create function tests.upload(p_persona text, p_bucket text, p_name text, p_setup text default null) returns text language plpgsql as $$
declare v text;
begin
  begin
    if p_setup is not null then execute tests.sql(p_setup); end if;
    if p_persona = 'anon' then perform tests.login_anon(); else perform tests.login_as(p_persona); end if;
    insert into storage.objects (bucket_id, name, metadata) values (p_bucket, p_name, '{"size": 1, "mimetype": "application/pdf"}');
    v := 'ok';
    raise exception using errcode = 'TT001';
  exception
    when sqlstate 'TT001' then null;
    when others then v := 'error:' || sqlstate;
  end;
  return v;
end $$;
-- 消してみる（取り消す）：消えた行の数か error:<SQLSTATE>。p_allow で storage.allow_delete_query を立てる
create function tests.remove(p_persona text, p_bucket text, p_name text, p_allow boolean default true, p_setup text default null)
returns text language plpgsql as $$
declare v text; n bigint;
begin
  begin
    if p_setup is not null then execute tests.sql(p_setup); end if;
    if p_allow then perform set_config('storage.allow_delete_query', 'true', true); end if;
    if p_persona = 'anon' then perform tests.login_anon(); else perform tests.login_as(p_persona); end if;
    delete from storage.objects o where o.bucket_id = p_bucket and o.name = p_name;
    get diagnostics n = row_count;
    v := n::text;
    raise exception using errcode = 'TT001';
  exception
    when sqlstate 'TT001' then null;
    when others then v := 'error:' || sqlstate;
  end;
  return v;
end $$;
-- まとめて消してみる（取り消す。storage.allow_delete_query を立てる）：消えた物の名前
create function tests.remove_all(p_persona text) returns text language plpgsql as $$
declare v text;
begin
  begin
    perform set_config('storage.allow_delete_query', 'true', true);
    perform tests.login_as(p_persona);
    with d as (delete from storage.objects returning bucket_id, name)
    select coalesce(string_agg(tests.path_name(d.name), ' ' order by tests.path_name(d.name) collate "C"), '-') into v from d;
    raise exception using errcode = 'TT001';
  exception
    when sqlstate 'TT001' then null;
  end;
  return v;
end $$;
-- upsert（insert … on conflict do update。Storage API の x-upsert）してみる（取り消す）：ok か error:<SQLSTATE>
create function tests.upsert(p_persona text, p_name text, p_setup text default null) returns text language plpgsql as $$
declare v text;
begin
  begin
    if p_setup is not null then execute tests.sql(p_setup); end if;
    perform tests.login_as(p_persona);
    insert into storage.objects (bucket_id, name, metadata) values ('documents', p_name, '{"size": 2}')
    on conflict (bucket_id, name, version) do update set metadata = excluded.metadata;
    v := 'ok';
    raise exception using errcode = 'TT001';
  exception
    when sqlstate 'TT001' then null;
    when others then v := 'error:' || sqlstate;
  end;
  return v;
end $$;
-- update してみる（取り消す）：変わった行の数か error:<SQLSTATE>
create function tests.update_object(p_persona text, p_bucket text, p_name text, p_set text) returns text language plpgsql as $$
declare v text; n bigint;
begin
  begin
    perform tests.login_as(p_persona);
    execute format('update storage.objects o set %s where o.bucket_id = %L and o.name = %L', p_set, p_bucket, p_name);
    get diagnostics n = row_count;
    v := n::text;
    raise exception using errcode = 'TT001';
  exception
    when sqlstate 'TT001' then null;
    when others then v := 'error:' || sqlstate;
  end;
  return v;
end $$;

select plan(118);

-- ================================================================ ① select
select is(tests.visible_objects('admin'), 'documents:F_G1 documents:O_G1 documents:O_G2', 'admin：Y1 のフォルダの物（ほかの年度・ほかの bucket は見えない）');
select is(tests.visible_objects('head'), 'documents:F_G1 documents:O_G1 documents:O_G2', 'head：Y1 のフォルダの物');
select is(tests.visible_objects('deputy'), 'documents:F_G1 documents:O_G1 documents:O_G2', 'deputy：Y1 のフォルダの物');
select is(tests.visible_objects('rep'), 'documents:F_G1 documents:O_G1', 'rep：自団体（G1）のフォルダの物（どの提出にも属さない O_G1 も）');
select is(tests.visible_objects('rep2'), 'documents:O_G2', 'rep2：自団体（G2）のフォルダの物だけ');
select is(tests.visible_objects('staff'), 'documents:O_Y2', 'staff：Y1 の部門員のロールでは何も見えない（Q4）。Y2 の G3 の店長として G3 のフォルダの物');
select is(tests.visible_objects('viewer'), '-', 'viewer：閲覧のみのロールでは何も見えない（Q5）。G4 のフォルダには物がない');
select is(tests.visible_objects('admin2'), 'documents:O_Y2', 'admin2：Y2 のフォルダの物');
select is(tests.visible_objects('outsider'), '-', '未招待の人は何も見えない');
select is(tests.visible_objects('anon'), '-', 'anon は何も見えない（anon 向けのポリシーはない）');
select is(tests.visible_objects('rep', $q$ select tests.set_scenario('closed') $q$), 'documents:F_G1 documents:O_G1', '終了の年度でも読める（rep）');
select is(tests.visible_objects('head', $q$ select tests.set_scenario('closed') $q$), 'documents:F_G1 documents:O_G1 documents:O_G2', '終了の年度でも読める（head）');
select is(tests.visible_objects('rep', $q$ select tests.put_object('documents', 'x/' || :G1::text || '/y.pdf'),
                                                   tests.put_object('documents', :G1::text || '/' || :Y1::text || '/y.pdf') $q$),
  'documents:F_G1 documents:O_G1 documents:x/' || tests.id('G1') || '/y.pdf',
  'フォルダで決める：2つ目のフォルダが自団体なら見え、1つ目に団体を置いた物は見えない');
select is(tests.visible_objects('head', $q$ select tests.put_object('documents', upper(:Y1::text) || '/x.pdf') $q$),
  'documents:F_G1 documents:O_G1 documents:O_G2', 'フォルダは文字列で比べる（大文字の年度の id のフォルダは見えない）');
select is(tests.visible_objects('rep', $q$ delete from public.group_members where group_id = :G1 and user_id = :rep $q$), '-',
  '店長を外されると、その団体のフォルダの物は見えない');
select is(tests.visible_objects('rep', $q$ delete from public.document_files where id = :F_G1 $q$), 'documents:F_G1 documents:O_G1',
  'DB の行がなくなっても、フォルダの範囲の人には見える（消すために読める）');

-- ================================================================ ② insert（アップロード）
select is(tests.upload('rep', 'documents', tests.doc_path('Y1', 'G1', 'DOC_NOFILE', 'R_REP')), 'ok', 'rep：自分の予約（未提出）の path に上げられる');
select is(tests.upload('rep', 'documents', tests.doc_path('Y1', 'G1', 'DOC_NOFILE', 'R_REP'), $q$ select tests.set_scenario('preparing') $q$), 'ok',
  'rep：準備中の年度でも上げられる');
select is(tests.upload('rep', 'documents', tests.doc_path('Y1', 'G1', 'DOC_NOFILE', 'R_REP'), $q$ select tests.set_scenario('confirmed') $q$), 'ok',
  'rep：確定中でも上げられる（振り分けの守りは提出物にない）');
select is(tests.upload('rep', 'documents', tests.doc_path('Y1', 'G1', 'DOC_NOFILE', 'R_REP'), $q$ select tests.set_scenario('closed') $q$), 'error:42501',
  'rep：終了の年度には上げられない');
select is(tests.upload('rep', 'pgtap-other', tests.doc_path('Y1', 'G1', 'DOC_NOFILE', 'R_REP')), 'error:42501',
  'rep：予約の path でも、ほかの bucket には上げられない');
select is(tests.upload('rep', 'documents', upper(tests.doc_path('Y1', 'G1', 'DOC_NOFILE', 'R_REP'))), 'error:42501',
  'rep：予約の path と1文字でも違えば上げられない（大文字）');
select is(tests.upload('rep', 'documents', tests.doc_path('Y1', 'G1', 'DOC_NOFILE', 'F_NONE')), 'error:42501',
  'rep：自団体のフォルダでも、予約していない path には上げられない');
select is(tests.upload('rep2', 'documents', tests.doc_path('Y1', 'G1', 'DOC_NOFILE', 'R_REP')), 'error:42501',
  'rep2：ほかの人（ほかの団体）の予約の path には上げられない');
select is(tests.upload('head', 'documents', tests.doc_path('Y1', 'G1', 'DOC_NOFILE', 'R_REP')), 'error:42501',
  'head：部門長でも、ほかの人の予約の path には上げられない（予約した人だけ）');
select is(tests.upload('rep', 'documents', tests.doc_path('Y1', 'G1', 'DOC_NOFILE', 'R_REP'),
                       $q$ insert into public.group_members (group_id, user_id, role) values (:G1, :admin, 'deputy_manager') $q$), 'ok',
  '（準備）rep の予約は rep が上げられる');
select is(tests.upload('admin', 'documents', tests.doc_path('Y1', 'G1', 'DOC_NOFILE', 'R_REP'),
                       $q$ insert into public.group_members (group_id, user_id, role) values (:G1, :admin, 'deputy_manager') $q$), 'error:42501',
  '同じ団体の副店長（を兼ねる管理者）でも、ほかの人の予約の path には上げられない');
select is(tests.upload('rep', 'documents', tests.doc_path('Y1', 'G1', 'DOC_STALL', 'R_REP_SUB')), 'error:42501',
  'rep：自分の予約でも、提出済みの提出には上げられない（店長は未提出・差し戻しだけ）');
select is(tests.upload('rep', 'documents', tests.doc_path('Y1', 'G1', 'DOC_STALL', 'R_REP_SUB'),
                       $q$ update public.document_submissions set status = 'returned', reviewed_at = now(), review_note = '理由'
                           where document_id = :DOC_STALL and group_id = :G1 $q$), 'ok',
  'rep：差し戻されれば、自分の予約に上げられる');
select is(tests.upload('head', 'documents', tests.doc_path('Y1', 'G1', 'DOC_STALL', 'R_HEAD')), 'ok',
  'head：自分の代理の予約は、提出済みの提出にも上げられる（部門長以上は承認でなければ）');
select is(tests.upload('head', 'documents', tests.doc_path('Y1', 'G1', 'DOC_STALL', 'R_HEAD'),
                       $q$ update public.document_submissions set status = 'approved', reviewed_at = now() where document_id = :DOC_STALL and group_id = :G1 $q$),
  'error:42501', 'head：承認の後は、自分の予約にも上げられない');
select is(tests.upload('head', 'documents', tests.doc_path('Y1', 'G1', 'DOC_STALL', 'R_HEAD'),
                       $q$ delete from public.year_roles where year_id = :Y1 and user_id = :head $q$), 'error:42501',
  'head：ロールを外されると、自分の予約にも上げられない');
select is(tests.upload('rep2', 'documents', tests.doc_path('Y1', 'G2', 'DOC_STALL', 'R_REP2')), 'ok', 'rep2：差し戻しの提出の自分の予約に上げられる');
select is(tests.upload('rep2', 'documents', tests.doc_path('Y1', 'G2', 'DOC_STALL', 'R_REP2'),
                       $q$ delete from public.group_members where group_id = :G2 and user_id = :rep2 $q$), 'error:42501',
  'rep2：店長を外されると、自分の予約にも上げられない');
select is(tests.upload('viewer', 'documents', tests.doc_path('Y1', 'G4', 'DOC_NOFILE', 'R_VIEWER')), 'error:42501',
  'viewer（G4 の副店長）：承認の提出の自分の予約には上げられない');
select is(tests.upload('staff', 'documents', tests.doc_path('Y2', 'G3', 'DOC_Y2', 'F_Y2')), 'ok', 'staff（Y2 の G3 の店長）：自分の予約に上げられる');
select is(tests.upload('staff', 'documents', tests.doc_path('Y2', 'G3', 'DOC_Y2', 'F_Y2'), $q$ update public.years set status = 'closed' where id = :Y2 $q$),
  'error:42501', 'staff：Y2 が終了なら上げられない');
select is(tests.upload('staff', 'documents', tests.doc_path('Y1', 'G1', 'DOC_NOFILE', 'R_REP')), 'error:42501', '部門員はほかの人の予約に上げられない');
select is(tests.upload('outsider', 'documents', tests.doc_path('Y1', 'G1', 'DOC_NOFILE', 'R_REP')), 'error:42501', '未招待の人は上げられない');
select is(tests.upload('anon', 'documents', tests.doc_path('Y1', 'G1', 'DOC_NOFILE', 'R_REP')), 'error:42501', 'anon は上げられない（anon 向けのポリシーはない）');
select is(tests.upload('rep', 'documents', tests.doc_path('Y1', 'G1', 'DOC_STALL', 'F_G1')), 'error:42501',
  'rep：届いている提出済みのファイルの path には上げられない（ポリシーが先に止める）');
select is(tests.upload('head', 'documents', tests.doc_path('Y1', 'G1', 'DOC_STALL', 'O_G1')), 'error:42501',
  'head：どの提出にも属さない物の path には上げられない（予約がない）');
-- 同じ path の2回目は一意の索引で止まる（「まだ届いていない」はポリシーに入れない。送り直しを 409 で「もう届いていた」と分けるため。判断 3）
select is(tests.upload('rep', 'documents', tests.doc_path('Y1', 'G1', 'DOC_NOFILE', 'R_REP'),
                       $q$ insert into storage.objects (bucket_id, name, metadata) values ('documents', tests.doc_path('Y1', 'G1', 'DOC_NOFILE', 'R_REP'), '{"size": 1}') $q$),
  'error:23505', '届いた後の2回目の upload は一意の索引で止まる（23505。Storage API は 409。上書きしない）');
select is(tests.upload('rep', 'documents', tests.doc_path('Y1', 'G1', 'DOC_NOFILE', 'R_REP'),
                       $q$ delete from public.document_files where id = :R_REP $q$), 'error:42501',
  '予約を外した後は、その path に上げられない');

-- ================================================================ ③ update（ポリシーがない）
select is(tests.update_object('rep', 'documents', tests.doc_path('Y1', 'G1', 'DOC_STALL', 'O_G1'), $s$ metadata = '{"size": 1}' $s$), '0',
  'rep：自団体の物でも update は 0 行（上書きできない）');
select is(tests.update_object('head', 'documents', tests.doc_path('Y1', 'G1', 'DOC_STALL', 'F_G1'), $s$ name = name || '.moved' $s$), '0',
  'head：物の名前を変える（移動する）update も 0 行');
select is(tests.update_object('admin', 'documents', tests.doc_path('Y1', 'G1', 'DOC_STALL', 'F_G1'), $s$ bucket_id = 'pgtap-other' $s$), '0',
  'admin：ほかの bucket へ移す update も 0 行');
select is(tests.update_object('staff', 'documents', tests.doc_path('Y2', 'G3', 'DOC_Y2', 'O_Y2'), $s$ metadata = '{"size": 1}' $s$), '0',
  'staff（G3 の店長）：update は 0 行');
select is(tests.upsert('rep', tests.doc_path('Y1', 'G1', 'DOC_NOFILE', 'R_REP'),
                       $q$ insert into storage.objects (bucket_id, name, metadata) values ('documents', tests.doc_path('Y1', 'G1', 'DOC_NOFILE', 'R_REP'), '{"size": 1}') $q$),
  'error:42501', 'rep：届いた物への upsert（on conflict do update）は、自分の予約の path でも止まる（update のポリシーがない）');
select is((select count(*)::int from pg_policies where schemaname = 'storage' and tablename = 'objects' and cmd in ('UPDATE', 'ALL')), 0,
  'storage.objects に update（と all）のポリシーはない（upsert もできない）');

-- ================================================================ ④ delete（どの提出にも属さない物だけ）
select is(tests.remove('admin', 'documents', tests.doc_path('Y1', 'G1', 'DOC_STALL', 'O_G1'), false), 'error:42501',
  'storage.allow_delete_query を立てないと、管理者でも SQL では消せない（storage.protect_delete）');
select is(tests.remove('outsider', 'documents', 'nothing', false), 'error:42501',
  'storage.allow_delete_query を立てないと、消す行がなくても止まる（文のトリガー）');
select is((select string_agg(p || '=' || tests.remove(p, 'documents', tests.doc_path('Y1', 'G1', 'DOC_STALL', 'O_G1')), ' ' order by p)
           from unnest(array['admin', 'admin2', 'deputy', 'head', 'outsider', 'rep', 'rep2', 'staff', 'viewer']) p),
  'admin=1 admin2=0 deputy=1 head=1 outsider=0 rep=1 rep2=0 staff=0 viewer=0',
  'O_G1（G1 のフォルダ。行なし）：消せるのは Y1 の部門長以上と G1 の店長');
select is(tests.remove('anon', 'documents', tests.doc_path('Y1', 'G1', 'DOC_STALL', 'O_G1')), '0', 'anon は消せない（0 行）');
select is((select string_agg(p || '=' || tests.remove(p, 'documents', tests.doc_path('Y1', 'G1', 'DOC_STALL', 'F_G1')), ' ' order by p)
           from unnest(array['admin', 'deputy', 'head', 'rep']) p),
  'admin=0 deputy=0 head=0 rep=0', 'F_G1（DB の行がある）：誰も消せない（承認したファイルなども Storage から消えない）');
select is((select string_agg(p || '=' || tests.remove(p, 'documents', tests.doc_path('Y1', 'G2', 'DOC_STALL', 'O_G2')), ' ' order by p)
           from unnest(array['head', 'rep', 'rep2']) p),
  'head=1 rep=0 rep2=1', 'O_G2（G2 のフォルダ）：Y1 の部門長以上と G2 の店長だけ（G1 の店長は消せない）');
select is((select string_agg(p || '=' || tests.remove(p, 'documents', tests.doc_path('Y2', 'G3', 'DOC_Y2', 'O_Y2')), ' ' order by p)
           from unnest(array['admin', 'admin2', 'rep', 'staff']) p),
  'admin=0 admin2=1 rep=0 staff=1', 'O_Y2（Y2・G3 のフォルダ）：Y2 の管理者と G3 の店長だけ（Y1 の管理者・Y2 の閲覧のみは消せない）');
select is(tests.remove('head', 'pgtap-other', tests.doc_path('Y1', 'G1', 'DOC_STALL', 'F_G1')), '0', 'ほかの bucket の物は誰も消せない');
select is(tests.remove('admin', 'documents', tests.doc_path('Y1', 'G1', 'DOC_STALL', 'O_G1'), true, $q$ select tests.set_scenario('closed') $q$), '1',
  '終了の年度でも、どの提出にも属さない物は消せる（年度のファイルの削除の後の片付け）');
select is(tests.remove('rep', 'documents', tests.doc_path('Y1', 'G1', 'DOC_STALL', 'F_G1'), true, $q$ delete from public.document_files where id = :F_G1 $q$), '1',
  'DB の行を消した物は、どの提出にも属さない物になり、範囲の人が消せる');
select is(tests.remove('rep', 'documents', tests.doc_path('Y1', 'G1', 'DOC_STALL', 'O_G1'), true,
                       $q$ delete from public.group_members where group_id = :G1 and user_id = :rep $q$), '0',
  '店長を外されると、その団体のフォルダの物は消せない');
select is(tests.remove('rep', 'documents', tests.doc_path('Y1', 'G1', 'DOC_STALL', 'O_G1'), true,
                       $q$ insert into public.document_files (id, year_id, document_id, group_id, object_path, content_type, size)
                           values (:O_G1, :Y1, :DOC_STALL, :G1, tests.doc_path('Y1', 'G1', 'DOC_STALL', 'O_G1'), 'application/pdf', 500) $q$), '0',
  '行ができた物（予約し直した path）は消せない');
-- 消すのは1つずつでも、まとめてでも、範囲の中のどの提出にも属さない物だけ（Storage API の remove は path の一覧を送る）
select is(tests.remove_all('head'), 'O_G1 O_G2',
  'head がまとめて消すと、Y1 の範囲のどの提出にも属さない物（O_G1・O_G2）だけが消える（F_G1・O_Y2・ほかの bucket は残る）');
select is(tests.remove_all('rep'), 'O_G1', 'rep がまとめて消すと、G1 のフォルダのどの提出にも属さない物（O_G1）だけが消える');

-- ================================================================ ⑤ 流れ：予約 → 上げる → 届いたと分かる → 外す → どの提出にも属さない物 → 消す
select tests.login_as('rep');
select is((select tests.path_name(object_path) from public.reserve_document_file(tests.id('DOC_NOFILE'), tests.id('G1'), tests.id('F_FLOW'), 'application/pdf', 100)),
  'F_FLOW', 'rep：G1 の DOC_NOFILE に F_FLOW を予約する');
select is((select format('%s %s', uploaded::text, coalesce(stored_size::text, 'null')) from public.v_document_files where id = tests.id('F_FLOW')), 'false null',
  '上げる前は、v_document_files で届いていない（実際の大きさなし）');
insert into storage.objects (bucket_id, name, metadata) values ('documents', tests.doc_path('Y1', 'G1', 'DOC_NOFILE', 'F_FLOW'), '{"size": 90, "mimetype": "application/pdf"}');
select is((select format('%s %s %s', uploaded::text, stored_size, size) from public.v_document_files where id = tests.id('F_FLOW')), 'true 90 100',
  '上げた後は届いている（実際の大きさ 90。申告は 100）');
select throws_ok($q$ insert into storage.objects (bucket_id, name, metadata) values ('documents', tests.doc_path('Y1', 'G1', 'DOC_NOFILE', 'F_FLOW'), '{"size": 90}') $q$,
  '23505', null, '同じ path の送り直しは一意の索引で止まる（もう届いていた）');
select tests.logout();
select is(tests.visible_objects('head'), 'documents:F_FLOW documents:F_G1 documents:O_G1 documents:O_G2', 'head も届いた物を読める');
select tests.login_as('head');
select is((select format('%s %s', uploaded::text, stored_size) from public.v_document_files where id = tests.id('F_FLOW')), 'true 90',
  'head も v_document_files で届いたことが分かる');
select tests.logout();
select tests.login_as('staff');
select is((select count(*)::int from public.v_document_files where id = tests.id('F_FLOW')), 0, '部門員は v_document_files でもファイルを読めない（Q4）');
select tests.logout();
select is(tests.remove('rep', 'documents', tests.doc_path('Y1', 'G1', 'DOC_NOFILE', 'F_FLOW')), '0', '行があるうちは消せない');
select tests.login_as('rep');
select is(tests.path_name(public.discard_document_file(tests.id('F_FLOW'))), 'F_FLOW', 'rep：未提出なので届いた F_FLOW を外せる（行が消える）');
select is((select string_agg(tests.path_name(p), ' ' order by tests.path_name(p) collate "C") from public.document_orphan_paths(tests.id('Y1')) p),
  'F_FLOW O_G1', '外した物は、どの提出にも属さない物として document_orphan_paths に出る');
select tests.logout();
select set_config('storage.allow_delete_query', 'true', true);
select tests.login_as('rep');
with d as (delete from storage.objects where bucket_id = 'documents'
             and name in (select p from public.document_orphan_paths(tests.id('Y1')) p) returning name)
select is((select string_agg(tests.path_name(name), ' ' order by tests.path_name(name) collate "C") from d), 'F_FLOW O_G1',
  'rep：document_orphan_paths の path を消せる（画面の片付けと同じ）');
select is((select count(*)::int from public.document_orphan_paths(tests.id('Y1'))), 0, '消した後は、rep の範囲にどの提出にも属さない物はない');
select tests.logout();
select set_config('storage.allow_delete_query', '', true);
select is(tests.visible_objects('head'), 'documents:F_G1 documents:O_G2', 'head の見える物：F_G1 と、G2 の O_G2 だけが残る');

-- ================================================================ ⑥ bucket の設定と権限
select is((select format('%s %s %s %s', name, public::text, file_size_limit, allowed_mime_types) from storage.buckets where id = 'documents'),
  'documents false 10485760 {application/pdf,image/jpeg,image/png}', 'bucket documents は非公開・1ファイル 10 MiB・PDF・JPEG・PNG（Q1）');
select ok((select relrowsecurity from pg_class where oid = 'storage.objects'::regclass), 'storage.objects は RLS が有効（ポリシーで守る）');
select ok((select bool_and(has_table_privilege(r, 'storage.objects', p))
           from unnest(array['authenticated', 'anon']) r, unnest(array['select', 'insert', 'update', 'delete']) p),
  'storage.objects の表の権限は Supabase の既定のまま（authenticated・anon に select・insert・update・delete。0016 は変えない）');
select is((select count(*)::int from pg_policies where schemaname = 'storage' and tablename = 'objects' and roles && array['anon', 'public']::name[]), 0,
  'storage.objects に anon・public 向けのポリシーはない');
select is((select count(*)::int from pg_trigger where tgrelid = 'storage.objects'::regclass and tgname = 'protect_objects_delete' and not tgisinternal), 1,
  'storage.objects には SQL の削除を止めるトリガー（protect_objects_delete）がある');
select is((select pg_get_triggerdef(t.oid) from pg_trigger t where t.tgrelid = 'storage.objects'::regclass and t.tgname = 'documents_objects_guard'),
  'CREATE TRIGGER documents_objects_guard BEFORE INSERT OR UPDATE ON storage.objects FOR EACH ROW EXECUTE FUNCTION private.tg_documents_objects_guard()',
  'storage.objects に、bucket documents の物の書き込みを予約と提出の状態で確かめるトリガー（documents_objects_guard。BEFORE INSERT OR UPDATE・行ごと）がある');
select is((select format('%s %s %s', p.prosecdef::text, p.provolatile, array_to_string(p.proconfig, ','))
           from pg_proc p where p.oid = to_regprocedure('private.tg_documents_objects_guard()')),
  'true v search_path=""', 'トリガー関数は SECURITY DEFINER・VOLATILE・search_path は空（書いたロールによらず、予約と提出を読み、ロックの後に読み直す）');

-- ================================================================ ⑦ スーパーユーザーの書き込み（T19 のレビューの T19-SEC-1。トリガー documents_objects_guard）
-- Storage API の署名つきアップロード（createSignedUploadUrl → uploadToSignedUrl）は、URL を作るときだけ呼んだ人の RLS を確かめ、書くときは
-- service_role（BYPASSRLS）で書く（トークンは 2 時間使い回せる）。TUS・S3 の道の最後の書き込み、service_role の鍵、SQL Editor・マイグレーションの
-- postgres も RLS を通らない。トリガーはロールによらず動き、insert は予約した人（created_by）の段で今書けるか（my_document_upload_paths と同じ
-- 条件を、auth.uid() でなく予約した人で見る）と、届いた物の大きさ（metadata の size）が申告を超えないかを見る。名前・bucket・版・metadata を
-- 変える update（上書き・移動）は、いつでも止める。止めるのは 42501（Storage API は 403）
-- p_role（service_role か postgres）で SQL を流してみる（取り消す）：ok:<行数> か error:<SQLSTATE>（トリガーが止めたときは
-- error:42501:<detail の reason>）。p_setup は先に postgres で流す。service_role は Storage API の書き込みと同じ形にする（role と
-- request.jwt.claims が service_role で、sub がない。auth.uid() は null）
create function tests.su_write(p_role text, p_sql text, p_setup text default null) returns text language plpgsql as $$
declare v text; n bigint; d text; s text := tests.sql(p_sql);
begin
  begin
    if p_setup is not null then execute tests.sql(p_setup); end if;
    perform set_config('request.jwt.claim.sub', '', true);
    if p_role = 'service_role' then
      perform set_config('request.jwt.claims', '{"role": "service_role"}', true);
      set local role service_role;
    else
      perform set_config('request.jwt.claims', '', true);
    end if;
    execute s;
    get diagnostics n = row_count;
    v := 'ok:' || n;
    raise exception using errcode = 'TT001';
  exception
    when sqlstate 'TT001' then null;
    when others then
      get stacked diagnostics d = pg_exception_detail;
      v := 'error:' || sqlstate || case when sqlstate = '42501' and d like '{%' then ':' || (d::jsonb ->> 'reason') else '' end;
  end;
  return v;
end $$;
-- 置く（Storage API の upload の最後の insert）・上書きする（x-upsert の insert … on conflict do update。Storage API と同じ衝突の対象）・
-- update する（移動・中身の書き換え）
create function tests.su_put(p_role text, p_name text, p_setup text default null, p_metadata text default '{"size": 1}', p_bucket text default 'documents')
returns text language sql as $$
  select tests.su_write(p_role, format('insert into storage.objects (bucket_id, name, metadata) values (%L, %L, %L)', p_bucket, p_name, p_metadata), p_setup)
$$;
create function tests.su_upsert(p_role text, p_name text, p_setup text default null) returns text language sql as $$
  select tests.su_write(p_role, format($s$ insert into storage.objects (bucket_id, name, metadata, version) values ('documents', %L, '{"size": 2}', 'v2')
                                          on conflict (bucket_id, name collate "C") where archived_at is null
                                          do update set metadata = excluded.metadata, version = excluded.version $s$, p_name), p_setup)
$$;
create function tests.su_update(p_role text, p_bucket text, p_name text, p_set text, p_setup text default null) returns text language sql as $$
  select tests.su_write(p_role, format('update storage.objects o set %s where o.bucket_id = %L and o.name = %L', p_set, p_bucket, p_name), p_setup)
$$;
grant usage on schema tests to service_role;
grant select on tests.ids to service_role;
grant execute on all functions in schema tests to service_role;

-- insert：予約した人の段で今書けるときだけ（service_role。署名つきアップロード・TUS・S3 の道）
select is(tests.su_put('service_role', tests.doc_path('Y1', 'G1', 'DOC_NOFILE', 'R_REP'), null, '{"size": 100}'), 'ok:1',
  'service_role：予約した path で、予約した人（rep）が今書ける（未提出）なら置ける（署名つきアップロードのふつうの道）');
select is(tests.su_put('service_role', tests.doc_path('Y1', 'G1', 'DOC_NOFILE', 'R_REP'),
                       $q$ update public.document_submissions set status = 'approved', reviewed_at = now() where document_id = :DOC_NOFILE and group_id = :G1 $q$),
  'error:42501:not_editable', 'service_role：承認の後は、予約した path にも置けない（承認の前に作った署名つき URL を後で使う道）');
select is(tests.su_put('service_role', tests.doc_path('Y1', 'G1', 'DOC_STALL', 'R_REP_SUB')), 'error:42501:not_editable',
  'service_role：店長の予約は、提出済みの提出には置けない（予約した人の段で決める）');
select is(tests.su_put('service_role', tests.doc_path('Y1', 'G1', 'DOC_STALL', 'R_HEAD')), 'ok:1',
  'service_role：部門長の代理の予約は、提出済みの提出にも置ける（部門長以上は承認でなければ）');
select is(tests.su_put('service_role', tests.doc_path('Y1', 'G1', 'DOC_STALL', 'R_HEAD'),
                       $q$ update public.document_submissions set status = 'approved', reviewed_at = now() where document_id = :DOC_STALL and group_id = :G1 $q$),
  'error:42501:not_editable', 'service_role：部門長の予約も、承認の後は置けない');
select is(tests.su_put('service_role', tests.doc_path('Y1', 'G4', 'DOC_NOFILE', 'R_VIEWER')), 'error:42501:not_editable',
  'service_role：紙などで受け取った承認の提出の予約には置けない（予約だけして上げずにおいた道）');
select is(tests.su_put('service_role', tests.doc_path('Y1', 'G1', 'DOC_NOFILE', 'R_REP'), $q$ select tests.set_scenario('closed') $q$), 'error:42501:closed',
  'service_role：終了の年度には置けない');
select is(tests.su_put('service_role', tests.doc_path('Y1', 'G1', 'DOC_NOFILE', 'F_NONE')), 'error:42501:not_reserved',
  'service_role：予約していない path（document_files に行がない）には置けない');
select is(tests.su_put('service_role', 'pgtap/x.pdf'), 'error:42501:not_reserved', 'service_role：形の違う名前には置けない');
select is(tests.su_put('service_role', tests.doc_path('Y1', 'G1', 'DOC_NOFILE', 'R_REP'), $q$ delete from public.document_files where id = :R_REP $q$),
  'error:42501:not_reserved', 'service_role：外した予約の path には置けない');
select is(tests.su_put('service_role', tests.doc_path('Y1', 'G2', 'DOC_STALL', 'R_REP2'), $q$ delete from public.group_members where group_id = :G2 and user_id = :rep2 $q$),
  'error:42501:not_editable', 'service_role：予約した店長が外された後は置けない（今もその団体の店長・副店長か）');
select is(tests.su_put('service_role', tests.doc_path('Y1', 'G1', 'DOC_STALL', 'R_HEAD'), $q$ delete from public.year_roles where year_id = :Y1 and user_id = :head $q$),
  'error:42501:not_editable', 'service_role：予約した部門長がロールを外された後は置けない');
select is(tests.su_put('service_role', tests.doc_path('Y1', 'G1', 'DOC_NOFILE', 'R_REP'), $q$ update public.document_files set created_by = null where id = :R_REP $q$),
  'error:42501:not_editable', 'service_role：予約した人がいない（利用者を消した。set null）予約には置けない');
select is(tests.su_put('service_role', tests.doc_path('Y1', 'G1', 'DOC_NOFILE', 'R_REP'), null, '{"size": 101}'), 'error:42501:too_large',
  'service_role：届いた物の大きさ（metadata の size）が申告（100）を超えれば置けない（T19-SEC-2）');
select is(tests.su_put('service_role', tests.doc_path('Y1', 'G1', 'DOC_NOFILE', 'R_REP'), null, '{"mimetype": "application/pdf"}'), 'ok:1',
  'service_role：metadata に size がなければ大きさは見ない（Storage API の書く前の確かめの insert。大きさは書くときに入る）');
select is(tests.su_put('service_role', tests.doc_path('Y1', 'G1', 'DOC_NOFILE', 'F_NONE'), null, '{"size": 1}', 'pgtap-other'), 'ok:1',
  'service_role：ほかの bucket の物にはトリガーは効かない');
-- 上書き・移動（update）：いつでも止める（Storage API の upsert は insert … on conflict do update。insert の確かめが先に動く）
select is(tests.su_upsert('service_role', tests.doc_path('Y1', 'G1', 'DOC_STALL', 'F_G1')), 'error:42501:not_editable',
  'service_role：提出済みの提出の届いた物は upsert で上書きできない（upsert の署名つき URL）');
select is(tests.su_upsert('service_role', tests.doc_path('Y1', 'G1', 'DOC_NOFILE', 'R_REP'),
                          $q$ insert into storage.objects (bucket_id, name, metadata) values ('documents', tests.doc_path('Y1', 'G1', 'DOC_NOFILE', 'R_REP'), '{"size": 1}') $q$),
  'error:42501:immutable', 'service_role：書ける状態（未提出）でも、届いた物は upsert で上書きできない');
select is(tests.su_update('service_role', 'documents', tests.doc_path('Y1', 'G1', 'DOC_STALL', 'F_G1'), $s$ metadata = '{"size": 2}' $s$), 'error:42501:immutable',
  'service_role：届いた物の metadata を書き換えられない');
select is(tests.su_update('service_role', 'documents', tests.doc_path('Y1', 'G1', 'DOC_STALL', 'F_G1'), $s$ version = 'v2' $s$), 'error:42501:immutable',
  'service_role：届いた物の版（中身）を書き換えられない');
select is(tests.su_update('service_role', 'documents', tests.doc_path('Y1', 'G1', 'DOC_STALL', 'F_G1'), $s$ name = name || '.moved' $s$), 'error:42501:immutable',
  'service_role：届いた物の名前を変えられない（移動）');
select is(tests.su_update('service_role', 'documents', tests.doc_path('Y1', 'G1', 'DOC_STALL', 'F_G1'), $s$ bucket_id = 'pgtap-other', name = name || '.x' $s$),
  'error:42501:immutable', 'service_role：届いた物をほかの bucket へ移せない');
select is(tests.su_update('service_role', 'pgtap-other', tests.doc_path('Y1', 'G1', 'DOC_STALL', 'F_G1'),
                          format('bucket_id = %L, name = %L', 'documents', tests.doc_path('Y1', 'G1', 'DOC_NOFILE', 'R_REP'))), 'error:42501:immutable',
  'service_role：ほかの bucket の物を、予約した path へ移して置けない');
select is(tests.su_update('service_role', 'documents', tests.doc_path('Y1', 'G1', 'DOC_STALL', 'F_G1'),
                          $s$ owner_id = 'x', user_metadata = '{"a": 1}', last_accessed_at = now() $s$), 'ok:1',
  'service_role：名前・bucket・版・metadata のほかの列（持ち主・利用者の metadata・最後に読んだ日時）は変えられる（Storage の版上げの update を止めない）');
select is(tests.su_update('service_role', 'pgtap-other', tests.doc_path('Y1', 'G1', 'DOC_STALL', 'F_G1'), $s$ metadata = '{"size": 8}' $s$), 'ok:1',
  'service_role：ほかの bucket の物の update にはトリガーは効かない');
select is(tests.su_write('service_role', format('delete from storage.objects where bucket_id = %L and name = %L', 'documents', tests.doc_path('Y1', 'G2', 'DOC_STALL', 'O_G2')),
                         $q$ select set_config('storage.allow_delete_query', 'true', true) $q$), 'ok:1',
  'service_role：消すのはトリガーが見ない（storage.protect_delete と delete のポリシーが守る）');
-- postgres（SQL Editor・マイグレーション。BYPASSRLS）も同じ
select is(tests.su_put('postgres', tests.doc_path('Y1', 'G1', 'DOC_NOFILE', 'R_REP')), 'ok:1', 'postgres：予約した path で今書けるなら置ける');
select is(tests.su_put('postgres', tests.doc_path('Y1', 'G1', 'DOC_NOFILE', 'R_REP'),
                       $q$ update public.document_submissions set status = 'approved', reviewed_at = now() where document_id = :DOC_NOFILE and group_id = :G1 $q$),
  'error:42501:not_editable', 'postgres：承認の後は置けない');
select is(tests.su_put('postgres', tests.doc_path('Y1', 'G1', 'DOC_NOFILE', 'R_REP'), $q$ select tests.set_scenario('closed') $q$), 'error:42501:closed',
  'postgres：終了の年度には置けない');
select is(tests.su_put('postgres', tests.doc_path('Y1', 'G1', 'DOC_NOFILE', 'F_NONE')), 'error:42501:not_reserved', 'postgres：予約していない path には置けない');
select is(tests.su_upsert('postgres', tests.doc_path('Y1', 'G1', 'DOC_STALL', 'F_G1')), 'error:42501:not_editable', 'postgres：届いた物を upsert で上書きできない');
select is(tests.su_update('postgres', 'documents', tests.doc_path('Y1', 'G1', 'DOC_STALL', 'F_G1'), $s$ metadata = '{"size": 2}' $s$), 'error:42501:immutable',
  'postgres：届いた物の metadata を書き換えられない');
-- 確かめを飛ばせるのは session_replication_role = replica の間だけ（テストの準備の tests.put_object。postgres だけが設定できる）
select is(tests.su_write('postgres', format('set local session_replication_role = replica; insert into storage.objects (bucket_id, name) values (%L, %L)',
                                            'documents', tests.doc_path('Y1', 'G1', 'DOC_NOFILE', 'F_NONE'))), 'ok:1',
  'postgres は session_replication_role = replica の間だけ、トリガーを飛ばして置ける（テストの準備・手での直し）');
select is(tests.su_write('service_role', 'set local session_replication_role = replica'), 'error:42501',
  'service_role（Storage API の書き込み）は session_replication_role を変えられない（トリガーを飛ばせない）');

select * from finish();
rollback;
