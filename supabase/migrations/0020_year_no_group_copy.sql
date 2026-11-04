-- 0020_year_no_group_copy：年度の作成（create_year_from）で団体を複製しない（D-59。ユーザーの決定「団体は引き継がない」）
--
-- 0005 の public.create_year_from を create or replace で置き換える。引数・戻り値・SECURITY DEFINER・search_path・
-- ロールの確認・ロック・エラーのコードは 0005 のまま。変えるのは次の 2 点だけ。
-- - groups を複製しない（団体は毎年入れ直す）。したがって rules.params の団体 id は付け替えられない
-- - ルールは複製する。団体を参照するルール（params.group が文字列、または params.groups が空でない配列）は
--   無効にして複製し、memo に理由を足す（元の memo があれば ' / ' でつなぐ）。params は前年度のまま。
--   団体を参照しないルールは enabled も memo もそのまま
-- create or replace は権限（revoke ... from public、grant ... to authenticated）を変えない。
-- private.remap_group_ids は使わなくなるが、残す（消すと 0005 の関数の依存を探す手間が増えるだけで、害はない）。

create or replace function public.create_year_from(p_prev_year_id uuid, p_label text, p_festival_start date)
returns public.years language plpgsql security definer set search_path = '' as $$
declare
  v_prev public.years;
  v_new  public.years;
  r      record;
  v_refs_group boolean;
  v_constraint text;
begin
  -- 呼べるのは複製元の年度の admin だけ（複製元が closed でもよい）。複製元は最新の年度でなければならない（D-01）
  if (select auth.uid()) is null or not private.has_role(p_prev_year_id, 'admin') then
    perform private.fail('forbidden');
  end if;
  -- 複製元の行をロックして、同じ年度からの同時の複製を順に処理する（2回目は下の「最新か」で止まる）
  select * into v_prev from public.years where id = p_prev_year_id for no key update;
  if not found or not private.has_role(p_prev_year_id, 'admin') then
    perform private.fail('forbidden');
  end if;
  if exists (select 1 from public.years y
             where y.id <> p_prev_year_id
               and (y.prev_year_id = p_prev_year_id or y.festival_start >= v_prev.festival_start)) then
    perform private.fail('invalid_state', jsonb_build_object('reason', 'not_latest'));
  end if;
  if nullif(btrim(p_label), '') is null or p_festival_start is null or p_festival_start <= v_prev.festival_start then
    perform private.fail('invalid_input');
  end if;
  perform private.set_reason(format('%s から複製', v_prev.label));
  begin
    insert into public.years (label, festival_start, prev_year_id)
    values (btrim(p_label), p_festival_start, p_prev_year_id) returning * into v_new;
  exception
    when unique_violation then perform private.fail('conflict', jsonb_build_object('field', 'label'));
    when check_violation then                -- 年度名の長さか、1日目の範囲（years_festival_start_check）
      get stacked diagnostics v_constraint = constraint_name;
      perform private.fail('invalid_input', jsonb_build_object('field',
        case when v_constraint = 'years_festival_start_check' then 'festival_start' else 'label' end));
  end;
  insert into public.year_roles (year_id, user_id, role) values (v_new.id, auth.uid(), 'admin');
  insert into public.room_years (year_id, room_id, usable, note)
    select v_new.id, ry.room_id, ry.usable, ry.note from public.room_years ry where ry.year_id = p_prev_year_id;

  -- 団体は複製しない（D-59）。団体を参照するルールは、参照先がないので無効にして写す
  for r in select * from public.rules where year_id = p_prev_year_id order by code loop
    -- キーがなければ jsonb_typeof は null を返すので、coalesce で偽にそろえる
    v_refs_group := coalesce(jsonb_typeof(r.params -> 'group') = 'string', false)
                    or (coalesce(jsonb_typeof(r.params -> 'groups') = 'array', false) and jsonb_array_length(r.params -> 'groups') > 0);
    insert into public.rules (year_id, code, kind, params, enabled, memo)
    values (v_new.id, r.code, r.kind, r.params,
            r.enabled and not v_refs_group,
            case when v_refs_group
                 then concat_ws(' / ', r.memo, format('%s から複製したとき、団体は複製しないので無効にした', v_prev.label))
                 else r.memo end);
  end loop;
  return v_new;
end $$;
