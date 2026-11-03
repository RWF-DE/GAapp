-- 0019_set_reason_trim.sql（T19〜T21 の後の片付け〔FU3〕。notes/T21.md の「確認したいこと」の 6）：監査の理由を置く
-- private.set_reason が前後から除く空白を、画面の zod の trim（JavaScript の String.prototype.trim）が除く 25 文字にそろえる。
-- 0003 の set_reason は btrim(p_reason)（半角の空白 U+0020 だけを除く）で、タブ・改行・全角の空白（U+3000）などだけの理由を空と
-- みなさなかった：理由が必須の RPC（set_year_status の確定と確定の解除、save_allocation_rows、update_requests_after_deadline、
-- set_lending_confirmed の解除）を、空白に見える理由で通せた。除いた後の理由（監査の reason）にも、それらの文字が前後に残った。
-- 画面は zod の trim で除いてから送るので、画面からは入らない（RPC を直接呼んだときだけ）。
-- 除く文字は notices_title_check・save_notice の c_space（0014）と同じ 25 文字：タブ・LF・垂直タブ・改ページ・CR・半角の空白・
-- U+00A0・U+1680・U+2000〜U+200A・U+2028・U+2029・U+202F・U+205F・全角の空白（U+3000）・U+FEFF（直すときは全部を直す）。
-- 500 字の上限は今までどおり除く前の長さで見る。引数・戻り値・volatility・search_path は変えない。create or replace は持ち主と
-- 権限を保つ（0003 の revoke のまま、authenticated・anon・PUBLIC に execute はない。呼ぶのは SECURITY DEFINER の RPC とトリガーだけ）。
-- 呼び手（RPC）は変えない。delete_year_document_files（0016）は 25 文字で除いて空なら決まった文を渡し、それ以外は p_reason を
-- そのまま渡していたので、この直しで監査の理由の前後の空白も除かれる。表は変えない。
-- 確かめ：supabase/tests/003_set_reason.test.sql。
create or replace function private.set_reason(p_reason text, p_required boolean default false)
returns void language plpgsql set search_path = '' as $$
declare
  -- 前後から除く空白（notices_title_check・save_notice と同じ 25 文字。JavaScript の trim と同じ）
  c_space constant text := E'\t\n\u000b\f\r \u00a0\u1680\u2000\u2001\u2002\u2003\u2004\u2005\u2006\u2007\u2008\u2009\u200a\u2028\u2029\u202f\u205f\u3000\ufeff';
  v_reason text := btrim(coalesce(p_reason, ''), c_space);
begin
  if p_required and v_reason = '' then
    perform private.fail('reason_required');
  end if;
  if length(p_reason) > 500 then
    perform private.fail('invalid_input', jsonb_build_object('field', 'reason'));
  end if;
  perform set_config('app.reason', v_reason, true);
end $$;
