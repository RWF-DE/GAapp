-- 003_set_reason：監査の理由を置く private.set_reason（0003。0019 で直す）が前後から除く空白と、理由が必須の RPC の reason_required
-- （T19〜T21 の後の片付け〔FU3〕。notes/T21.md の「確認したいこと」の 6）。除くのは画面の zod の trim（JavaScript の
-- String.prototype.trim）と同じ 25 文字（notices_title_check・save_notice の c_space と同じ。0014）。0003 の btrim は半角の空白だけを除いていた。
-- ① 関数そのもの（postgres で呼ぶ。置いた理由は app.reason を読む）② 理由が必須の RPC（ペルソナで呼び、どれも取り消す）
-- ③ 監査の reason に前後の空白が残らない（テント等の確定の解除と、年度の提出物のファイルの削除）④ 権限と search_path は 0003 のまま
-- 空白の文字は \u の形で書く（そのまま書くと見えず、U+2028・U+2029 は行が分かれて見える）。
begin;
\ir _helpers/personas.psql
\ir _helpers/fixture.psql
select plan(19);

-- JavaScript の trim が除く 25 文字（0014 の c_space と同じ並び）
create table tests.ws (n int primary key, c text not null);
insert into tests.ws values (1, E'\t'), (2, E'\n'), (3, E'\u000b'), (4, E'\f'), (5, E'\r'), (6, ' '), (7, E'\u00a0'), (8, E'\u1680'),
  (9, E'\u2000'), (10, E'\u2001'), (11, E'\u2002'), (12, E'\u2003'), (13, E'\u2004'), (14, E'\u2005'), (15, E'\u2006'), (16, E'\u2007'),
  (17, E'\u2008'), (18, E'\u2009'), (19, E'\u200a'), (20, E'\u2028'), (21, E'\u2029'), (22, E'\u202f'), (23, E'\u205f'), (24, E'\u3000'),
  (25, E'\ufeff');

-- private.set_reason を1回呼び、エラーなら message、通れば 'ok:' と置いた理由を返して取り消す
create function tests.reason_of(p_reason text, p_required boolean) returns text language plpgsql as $$
declare v text;
begin
  begin
    perform private.set_reason(p_reason, p_required);
    v := 'ok:' || current_setting('app.reason', true);
    raise exception using errcode = 'TT001';
  exception
    when sqlstate 'TT001' then null;
    when sqlstate 'P0001' then get stacked diagnostics v = message_text;
  end;
  return v;
end $$;

-- ペルソナで SQL を1回流し、エラーの message（P0001 でなければ error:SQLSTATE）か 'ok' を返して必ず取り消す（029 の rpc_error と同じ形）
create function tests.code_as(p_persona text, p_sql text) returns text language plpgsql as $$
declare v text; v_msg text; v_state text;
begin
  begin
    perform tests.login_as(p_persona);
    execute p_sql;
    v := 'ok';
    raise exception using errcode = 'TT001';
  exception
    when sqlstate 'TT001' then null;
    when others then
      get stacked diagnostics v_msg = message_text, v_state = returned_sqlstate;
      v := case when v_state = 'P0001' then v_msg else 'error:' || v_state end;
  end;
  return v;
end $$;

-- ---------------------------------------------------------------- ① 関数
select is((select string_agg(n::text, ',' order by n) from tests.ws where tests.reason_of(c, true) is distinct from 'reason_required'),
  null, '25 文字のどれか1つだけの理由は、理由とみなさない（reason_required。外れた文字の番号が出る）');
select is(tests.reason_of((select string_agg(c, '' order by n) from tests.ws), true), 'reason_required',
  '25 文字を全部並べただけの理由も reason_required');
select is(tests.reason_of((select string_agg(c, '' order by n) from tests.ws) || '確定' || (select string_agg(c, '' order by n desc) from tests.ws), true),
  'ok:確定', '前後の 25 文字は除いて置く（監査の reason に残らない）');
select is(tests.reason_of(E'\u3000締切\u3000の\t延長\u3000', true), E'ok:締切\u3000の\t延長', '途中の空白は残す（前後だけ除く）');
select is(tests.reason_of(E'\u200b\u180e', true), E'ok:\u200b\u180e',
  'JavaScript の trim が除かない文字（U+200B・U+180E）は除かない（画面と同じ。理由とみなす）');
select is(tests.reason_of(null, false), 'ok:', '理由が任意で null なら空を置く（今までどおり）');
select is(tests.reason_of(E'\u3000\t', false), 'ok:', '理由が任意で空白だけなら空を置く（監査の reason は null になる）');
select is(tests.reason_of(repeat('x', 500), true), 'ok:' || repeat('x', 500), '500 字は通る');
select is(tests.reason_of(repeat('x', 500) || E'\u3000', false), 'invalid_input',
  '500 字の上限は除く前の長さで見る（今までどおり。画面は除いてから送る）');

-- ---------------------------------------------------------------- ② 理由が必須の RPC（どれも取り消す）
select tests.set_scenario('allocating');
select is(tests.code_as('admin', format($q$ select public.set_year_status(%L, 'confirmed', %L, %s) $q$, tests.id('Y1'), E'\u3000\t', tests.ver())),
  'reason_required', 'set_year_status の確定：全角の空白とタブだけの理由は reason_required');
select is(tests.code_as('admin', format($q$ select public.save_allocation_rows(%L, %L, %L) $q$, tests.id('Y1'),
            jsonb_build_array(jsonb_build_object('op', 'delete', 'id', gen_random_uuid(), 'updatedAt', '2000-01-01T00:00:00Z')), E'\u3000')),
  'reason_required', 'save_allocation_rows：全角の空白だけの理由は reason_required');
select is(tests.code_as('admin', format($q$ select public.update_requests_after_deadline(%L, '[]', %L) $q$, tests.id('G1'), E'\n\u3000')),
  'reason_required', 'update_requests_after_deadline：改行と全角の空白だけの理由は reason_required');
select tests.set_scenario('confirmed');
select is(tests.code_as('admin', format($q$ select public.set_year_status(%L, 'allocating', %L) $q$, tests.id('Y1'), E'\u00a0')),
  'reason_required', 'set_year_status の確定の解除：U+00A0 だけの理由は reason_required');
select is(tests.code_as('admin2', format($q$ select public.set_lending_confirmed(%L, false, %L) $q$, tests.id('Y2'), E'\ufeff\u2003')),
  'reason_required', 'set_lending_confirmed の解除：U+FEFF・U+2003 だけの理由は reason_required');

-- ---------------------------------------------------------------- ③ 監査の reason（呼ぶ前の audit_logs の最後の id より後の行を見る）
select coalesce(max(id), 0) as a0 from public.audit_logs \gset
select tests.login_as('admin2');
select lives_ok(format($q$ select public.set_lending_confirmed(%L, false, %L) $q$, tests.id('Y2'), E'\u3000解除の理由\t'),
  'set_lending_confirmed の解除：前後に空白のある理由で解除できる');
select tests.logout();
select is((select string_agg(coalesce(reason, '(null)'), ',' order by id) from public.audit_logs
           where id > :a0 and table_name = 'lending_years'),
  '解除の理由', 'テント等の確定の解除の監査の reason に、前後の空白が残らない');
select tests.set_scenario('closed');
select coalesce(max(id), 0) as a1 from public.audit_logs \gset
select tests.login_as('admin');
select lives_ok(format($q$ select public.delete_year_document_files(%L, %L) $q$, tests.id('Y1'), E'\u3000年度末の削除\u3000'),
  'delete_year_document_files：前後に空白のある理由で消せる（終了の年度・管理者）');
select tests.logout();
select is((select string_agg(distinct coalesce(reason, '(null)'), ',') from public.audit_logs
           where id > :a1 and table_name in ('document_files', 'documents')),
  '年度末の削除', '提出物のファイルの削除の監査の reason に、前後の空白が残らない（0016 は空でなければ p_reason をそのまま渡す）');

-- ---------------------------------------------------------------- ④ 権限と search_path（0003 のまま）
select ok(not has_function_privilege('authenticated', 'private.set_reason(text, boolean)', 'execute')
          and not has_function_privilege('anon', 'private.set_reason(text, boolean)', 'execute')
          and (select proconfig = array['search_path=""'] and not prosecdef and provolatile = 'v'
               from pg_proc where oid = 'private.set_reason(text, boolean)'::regprocedure),
  'set_reason は authenticated・anon から呼べず、search_path は空、SECURITY INVOKER・VOLATILE のまま');

select * from finish();
rollback;
