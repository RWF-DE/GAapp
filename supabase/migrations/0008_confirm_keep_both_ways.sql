-- 0008_confirm_keep_both_ways.sql（T07）：確定の前の確認の E005 を両方向にする
-- 03 の E005 は「is_keep と『運び元＝団体の使用場所』の不一致」で、両方向（残すなのに運び元が使用場所でない／
-- 使用場所からの行が残すでない）を error にする。保存の RPC は is_keep を「運び元＝使用場所」で決め直すので、
-- RPC で書いた行はいつもそろっている。ずれるのは、振り分けの後に団体の使用場所を変えたときと、postgres からの直接の書き込みだけで、
-- 確定ではその両方向を止める。

create or replace function private.confirm_issues(p_year_id uuid)
returns jsonb language sql stable security definer set search_path = '' as $$
  select jsonb_agg(x.issue order by x.ord)
  from (
    select 1 as ord, jsonb_build_object('code', 'E001', 'room_id', a.source_room_id, 'item_id', a.item_id,
             'allocated', sum(a.count), 'stock', coalesce(max(s.count), 0)) as issue
    from public.allocations a
    left join public.stocks s on s.year_id = a.year_id and s.room_id = a.source_room_id and s.item_id = a.item_id
    where a.year_id = p_year_id
    group by a.source_room_id, a.item_id
    having sum(a.count) > coalesce(max(s.count), 0)
    union all
    select 2, jsonb_build_object('code', 'E002', 'allocation_id', a.id, 'room_id', a.source_room_id)
    from public.allocations a
    join public.room_years ry on ry.year_id = a.year_id and ry.room_id = a.source_room_id
    where a.year_id = p_year_id and not ry.usable
    union all
    -- 残す ⇔ 運び元が使用場所（使用場所のない団体の行は、残すでなければよい）
    select 3, jsonb_build_object('code', 'E005', 'allocation_id', a.id, 'group_id', a.group_id)
    from public.allocations a
    join public.groups g on g.id = a.group_id
    where a.year_id = p_year_id and a.is_keep <> (a.source_room_id is not distinct from g.location_room_id)
  ) x
$$;
