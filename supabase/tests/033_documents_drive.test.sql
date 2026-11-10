-- 033_documents_drive：提出物をドライブへ（T24。D-62。0023_documents_drive.sql）。
-- 期待値は 02 の「提出物」の表（submit_url・requires_file）・「Storage の容量」・「提出物の権限」と、04 の DB 関数の行
-- （reserve_document_file の uploads_disabled、copy_previous_documents が提出先も写す）から先に書いてから流した。
-- ① 形：列 submit_url（text・null 可・既定なし）、requires_file の既定 false、CHECK documents_submit_url_check、トリガー
--    keep_requires_file_off、v_document_status の最後の列 submit_url、置き換えた関数の属性（SECURITY DEFINER・search_path = ''）
-- ② submit_url の CHECK（https だけ・空白と制御文字なし・500 字まで）と、部門長以上の直接の書き込み（RLS は今のまま）
-- ③ requires_file はいつも false（今の行・insert・update。どのロールでも。拒まずに直す）
-- ④ reserve_document_file：forbidden → invalid_state（終了）→ invalid_state（uploads_disabled）。何も作らない
-- ⑤ ファイルなしで「提出した」、前年度から写すと提出先も写る、T24 の前のファイルは読める・外せる
-- ペルソナ・提出物・ファイルは fixture（026 の冒頭の説明と同じ）。DOC_STALL は fixture で requires_file を true にして入れている。
begin;
\ir _helpers/personas.psql
\ir _helpers/fixture.psql

-- ペルソナで SQL を1回流し、エラーのコードと detail を返して必ず取り消す（032 の rpc_error と同じ形）。成功なら {"code": "ok"}
create function tests.rpc_error(p_persona text, p_sql text, p_setup text default null) returns jsonb language plpgsql as $$
declare v jsonb; v_msg text; v_detail text; v_state text;
begin
  begin
    if p_setup is not null then execute tests.sql(p_setup); end if;
    if p_persona = 'anon' then perform tests.login_anon();
    elsif p_persona is not null then perform tests.login_as(p_persona);
    end if;
    execute tests.sql(p_sql);
    v := jsonb_build_object('code', 'ok');
    raise exception using errcode = 'TT001';
  exception
    when sqlstate 'TT001' then null;
    when others then
      get stacked diagnostics v_msg = message_text, v_detail = pg_exception_detail, v_state = returned_sqlstate;
      v := case when v_state = 'P0001' then jsonb_build_object('code', v_msg, 'detail', nullif(v_detail, '')::jsonb)
                else jsonb_build_object('code', 'error:' || v_state) end;
  end;
  return v;
end $$;
-- ペルソナで SQL を流して最初の列を返す（取り消さない）
create function tests.as_text(p_persona text, p_sql text) returns text language plpgsql as $$
declare v text;
begin
  perform tests.login_as(p_persona);
  execute tests.sql(p_sql) into v;
  perform tests.logout();
  return v;
end $$;
-- submit_url を入れてみる（postgres。取り消す）：ok か SQLSTATE
create function tests.try_url(p_url text) returns text language plpgsql as $$
declare v text;
begin
  begin
    update public.documents set submit_url = p_url where id = tests.id('DOC_NOFILE');
    v := 'ok';
    raise exception using errcode = 'TT001';
  exception
    when sqlstate 'TT001' then null;
    when others then v := sqlstate;
  end;
  return v;
end $$;

select plan(44);

-- ================================================================ ① 形
select has_column('public', 'documents', 'submit_url', 'documents に submit_url（提出先の URL）がある');
select col_type_is('public', 'documents', 'submit_url', 'text', 'submit_url は text');
select col_is_null('public', 'documents', 'submit_url', 'submit_url は null 可（任意）');
select col_hasnt_default('public', 'documents', 'submit_url', 'submit_url に既定値はない');
select col_default_is('public', 'documents', 'requires_file', 'false', 'requires_file の既定は false（T24）');
select is((select count(*)::int from pg_constraint where conrelid = 'public.documents'::regclass and conname = 'documents_submit_url_check'), 1,
  'CHECK documents_submit_url_check がある');
select is((select format('%s %s', tgenabled, (pg_get_triggerdef(oid) ~ 'BEFORE INSERT OR UPDATE OF requires_file ON public.documents FOR EACH ROW')::text)
           from pg_trigger where tgrelid = 'public.documents'::regclass and tgname = 'keep_requires_file_off'),
  'O true', 'トリガー keep_requires_file_off（BEFORE INSERT OR UPDATE OF requires_file・行ごと）');
select is((select attname from pg_attribute where attrelid = 'public.v_document_status'::regclass and attnum > 0 and not attisdropped
           order by attnum desc limit 1)::text, 'submit_url', 'v_document_status の最後の列は submit_url');
select is((select reloptions::text from pg_class where oid = 'public.v_document_status'::regclass), '{security_invoker=true}',
  '作り直した v_document_status も security_invoker');
select is((select string_agg(format('%s %s %s', p.proname, p.prosecdef::text, array_to_string(p.proconfig, ',')), ' / ' order by p.proname)
           from pg_proc p where p.pronamespace = 'public'::regnamespace and p.proname in ('reserve_document_file', 'copy_previous_documents')),
  'copy_previous_documents true search_path="" / reserve_document_file true search_path=""',
  '置き換えた RPC は SECURITY DEFINER・search_path が空');
select is((select format('%s %s', has_function_privilege('authenticated', 'public.reserve_document_file(uuid, uuid, uuid, text, integer)', 'execute')::text,
                                  has_function_privilege('anon', 'public.reserve_document_file(uuid, uuid, uuid, text, integer)', 'execute')::text)),
  'true false', 'reserve_document_file の実行の権限は変えない（authenticated だけ）');

-- ================================================================ ② submit_url の CHECK と直接の書き込み
select is(tests.try_url('https://drive.google.com/drive/folders/abc?usp=sharing'), 'ok', 'https の URL は入る');
select is(tests.try_url(null), 'ok', 'null（提出先なし）は入る');
select is(tests.try_url('https://' || repeat('a', 492)), 'ok', '500 字ちょうどは入る');
select is(tests.try_url('https://' || repeat('a', 493)), '23514', '501 字は 23514');
select is(tests.try_url('http://example.com/form'), '23514', 'http は 23514（https だけ）');
select is(tests.try_url('HTTPS://example.com/form'), '23514', '大文字の HTTPS は 23514（画面と同じ形だけ）');
select is(tests.try_url('javascript:alert(1)'), '23514', 'javascript: は 23514');
select is(tests.try_url('https://'), '23514', 'https:// だけは 23514');
select is(tests.try_url(''), '23514', '空の文字は 23514（画面は null にする）');
select is(tests.try_url('https://example.com/a b'), '23514', '空白を含むと 23514');
select is(tests.try_url(' https://example.com/'), '23514', '前の空白は 23514（画面が除いてから送る）');
select is(tests.try_url('https://example.com/' || chr(10)), '23514', '改行を含むと 23514');
select is(tests.try_url('https://example.com/' || chr(12288)), '23514', '全角の空白を含むと 23514');
select is(tests.as_text('head', $q$ with u as (update public.documents set submit_url = 'https://forms.gle/abc' where id = :DOC_NOFILE returning submit_url)
                                   select string_agg(submit_url, ',') from u $q$),
  'https://forms.gle/abc', '部門長は提出物の submit_url を直接直せる（RLS は今の can_lead）');
select is(tests.as_text('staff', $q$ with u as (update public.documents set submit_url = 'https://example.com/x' where id = :DOC_NOFILE returning 1)
                                    select count(*) from u $q$),
  '0', '部門員は直せない（0 行）');
select is(tests.as_text('rep', $q$ select submit_url from public.v_document_status where document_id = :DOC_NOFILE and group_id = :G1 $q$),
  'https://forms.gle/abc', '店長は v_document_status で自団体の提出物の submit_url を読める');

-- ================================================================ ③ requires_file はいつも false
select is((select count(*)::int from public.documents where requires_file), 0,
  '今の行（fixture は DOC_STALL などを true で入れた）は、どれも false');
insert into public.documents (year_id, title, deadline, target_categories, requires_file)
values (tests.id('Y1'), 'T-DOC_T24', '2027-10-02 17:00+09', '{stall}', true);
select is((select requires_file from public.documents where title = 'T-DOC_T24'), false, 'postgres の insert で true を送っても false になる');
update public.documents set requires_file = true where title = 'T-DOC_T24';
select is((select requires_file from public.documents where title = 'T-DOC_T24'), false, 'postgres の update で true にしても false のまま');
select is(tests.as_text('head', $q$ with u as (update public.documents set requires_file = true where id = :DOC_STALL returning requires_file)
                                   select string_agg(requires_file::text, ',') from u $q$),
  'false', '部門長の直接の update で true にしても false（拒まずに直す）');
select is(tests.as_text('head', $q$ with i as (insert into public.documents (year_id, title, deadline, target_categories, requires_file)
                                                 values (:Y1, 'T-DOC_T24B', '2027-10-02 17:00+09', '{stall}', true) returning requires_file)
                                   select string_agg(requires_file::text, ',') from i $q$),
  'false', '部門長の直接の insert で true を送っても false');

-- ================================================================ ④ reserve_document_file は止めた
select is(tests.rpc_error('outsider', $q$ select public.reserve_document_file(:DOC_NOFILE, :G1, gen_random_uuid(), 'application/pdf', 10) $q$),
  '{"code": "forbidden", "detail": null}'::jsonb, '予約：呼べない人は forbidden（先にロールを確かめる）');
select is(tests.rpc_error('staff', $q$ select public.reserve_document_file(:DOC_NOFILE, :G1, gen_random_uuid(), 'application/pdf', 10) $q$),
  '{"code": "forbidden", "detail": null}'::jsonb, '予約：部門員は forbidden');
select is(tests.rpc_error('rep', $q$ select public.reserve_document_file(:DOC_NOFILE, :G1, gen_random_uuid(), 'application/pdf', 10) $q$,
                          $q$ select tests.set_scenario('closed') $q$),
  '{"code": "invalid_state", "detail": {"status": "closed"}}'::jsonb, '予約：終了の年度は invalid_state（status closed）が先');
select is(tests.rpc_error('rep', $q$ select public.reserve_document_file(:DOC_NOFILE, :G1, gen_random_uuid(), 'application/pdf', 10) $q$),
  '{"code": "invalid_state", "detail": {"reason": "uploads_disabled"}}'::jsonb, '予約：店長は uploads_disabled');
select is(tests.rpc_error('head', $q$ select public.reserve_document_file(:DOC_STALL, :G2, gen_random_uuid(), 'application/pdf', 10) $q$),
  '{"code": "invalid_state", "detail": {"reason": "uploads_disabled"}}'::jsonb, '予約：部門長の代理も uploads_disabled');
select is(tests.rpc_error('rep', $q$ select public.reserve_document_file(null, :G1, null, 'image/gif', 0) $q$),
  '{"code": "invalid_state", "detail": {"reason": "uploads_disabled"}}'::jsonb, '予約：入力の形より先に uploads_disabled');
select is(tests.rpc_error('rep', $q$ select public.reserve_document_file(:DOC_STALL, :G1, :F_G1, 'application/pdf', 1000) $q$),
  '{"code": "invalid_state", "detail": {"reason": "uploads_disabled"}}'::jsonb, '予約：今の行と同じ file_id の送り直しも uploads_disabled');
select is((select count(*)::int from public.document_files) || ' '
          || (select count(*)::int from public.document_submissions where document_id = tests.id('DOC_NOFILE') and group_id = tests.id('G1')),
  '2 0', '止めた予約は、ファイルの行も提出の行も作らない（fixture の F_G1・F_Y2 だけ）');

-- ================================================================ ⑤ ファイルなしの提出・前年度から写す・T24 の前のファイル
select is(tests.as_text('viewer', $q$ select format('%s %s', (s).status, (s).proxy::text) from (select public.submit_document(:DOC_STALL, :G4, null) as s) x $q$),
  'submitted false', '前はファイルが要った DOC_STALL も、G4 の副店長がファイルなしで出せる（no_file にならない）');
update public.years set prev_year_id = tests.id('Y2') where id = tests.id('Y1');
update public.documents set submit_url = 'https://drive.google.com/drive/folders/prev', requires_file = true where id = tests.id('DOC_Y2');
select is(tests.as_text('head', $q$ select string_agg(format('%s %s %s', title, submit_url, requires_file::text), ',')
                                   from public.copy_previous_documents(:Y1, array[:DOC_Y2]) $q$),
  'T-DOC_Y2 https://drive.google.com/drive/folders/prev false', '前年度から写すと、提出先の URL も写る（requires_file は false）');
select is(tests.as_text('rep', $q$ select format('%s %s', uploaded::text, (object_path ~ '\.pdf$')::text) from public.v_document_files where id = :F_G1 $q$),
  'true true', 'T24 の前のファイル（F_G1）は、店長が今までどおり読める');
select is(tests.as_text('head', $q$ select public.discard_document_file(:F_G1) ~ '\.pdf$' $q$), 'true',
  'T24 の前のファイルは、部門長が外せる（代理。承認でない提出）');

select * from finish();
rollback;
