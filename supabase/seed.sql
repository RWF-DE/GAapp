-- supabase/seed.sql
-- supabase db reset の後に流れる（postgres として。RLS は通らず、auth.uid() は null）。
-- T02：品目9件（01_rules.md「品目」表のとおり）と、テスト用の場所。
-- T04：R8 の年度（固定の id）、テスト用の団体・招待・ユーザー。T05：R8 の本データ（T04 の年度に足す）。
-- 個人情報は入れない。seed は本番に流さない。

insert into public.items (code, name, aliases, requestable_categories, sort_order) values
  ('desk',        '机(木)',       '{"机(木)"}',          '{stall,department,company,rest_area}', 1),
  ('desk_ng',     '不可机',       '{}',                  '{}',                                   2),
  ('chair',       '椅子(木)',     '{"椅子(木)"}',        '{stall,department,company,rest_area}', 3),
  ('chair_ng',    '不可椅子',     '{}',                  '{}',                                   4),
  ('caster_desk', 'キャスター机', '{"机(キャスター有)"}', '{stall,department,company,rest_area}', 5),
  ('blue_chair',  '椅子(青)',     '{"椅子(青)"}',        '{stall,department,company,rest_area}', 6),
  ('long_desk_3', '長机(3人掛)',  '{"長机(三席用)"}',    '{company}',                            7),
  ('long_desk_2', '長机(2人掛)',  '{"長机(二席用)"}',    '{stall,department,company,rest_area}', 8),
  ('lectern',     '教卓',         '{"教卓"}',            '{stall,department,company,rest_area}', 9);

-- テスト用の場所（名前は「テスト用」と分かるもの。R8 の本データの場所は T05）
insert into public.rooms (name, kind, building, floor, is_storage, sort_order) values
  ('テスト用保管場所1', 'room',    '1号棟', 1,    true,  1),
  ('テスト用保管場所2', 'room',    '2号棟', 1,    true,  2),
  ('テスト用使用場所1', 'room',    '1号棟', 2,    false, 3),
  ('テスト用屋外1',     'outdoor', null,    null, false, 4);
