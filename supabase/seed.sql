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

-- ---------------------------------------------------------------- T04：R8 の年度とテストユーザー（D-02）
-- ローカル専用。本番には流さない（migrate.yml は supabase db push だけ）。本番ではメールログインを無効にする。
-- 年度・団体・招待を先に入れておくと、auth.identities の追加のトリガー（0007_auth.sql）がロールを付ける
-- （email_confirmed_at を入れたユーザーに、同じメールで email_verified: true の email の identity を足すので、本人のメールと
-- 確かめられる。private.verified_email、D-17a。profiles は auth.users のトリガーが作るので、ここでは入れない）。
-- R8 の年度は固定の id（…a1）。T05 の R8 の本データはこの年度に団体・在庫を足し、年度を作り直さない。
-- テスト用の団体は R8 の団体名と重ならない名前にする（groups の unique (year_id, name)）。
-- ユーザーの id は固定（Playwright から参照できるように）。メールは予約済みのドメイン（@example.test）。
-- パスワードはローカル専用の固定値で、秘密ではない。pgTAP のペルソナは別のドメイン（@pgtap.test）を使う。
insert into public.years (id, label, festival_start, status, request_close_at)
values ('00000000-0000-4000-8000-0000000000a1', 'R8', date '2026-10-17', 'requesting', now() + interval '30 days');
insert into public.groups (id, year_id, name, category)
values ('00000000-0000-4000-8000-0000000000b1', '00000000-0000-4000-8000-0000000000a1', 'テスト団体', 'stall');
insert into public.invitations (year_id, email, role) values
  ('00000000-0000-4000-8000-0000000000a1', 'admin@example.test', 'admin'),
  ('00000000-0000-4000-8000-0000000000a1', 'staff@example.test', 'staff'),
  ('00000000-0000-4000-8000-0000000000a1', 'viewer@example.test', 'viewer');
-- 団体の招待には立場（group_role）が要る（T15 の 0013 の invitations_group_role_check）。テスト用の団体代表は店長
insert into public.invitations (year_id, email, group_id, group_role) values
  ('00000000-0000-4000-8000-0000000000a1', 'rep@example.test', '00000000-0000-4000-8000-0000000000b1', 'manager');

with u (id, email, name) as (values
  ('00000000-0000-4000-8000-000000000001'::uuid, 'admin@example.test',    'テスト管理者'),
  ('00000000-0000-4000-8000-000000000002'::uuid, 'staff@example.test',    'テスト部員'),
  ('00000000-0000-4000-8000-000000000003'::uuid, 'rep@example.test',      'テスト団体代表'),
  ('00000000-0000-4000-8000-000000000004'::uuid, 'viewer@example.test',   'テスト閲覧'),
  ('00000000-0000-4000-8000-000000000005'::uuid, 'outsider@example.test', 'テスト未招待')),
ins as (
  insert into auth.users (instance_id, id, aud, role, email, encrypted_password, email_confirmed_at,
                          raw_app_meta_data, raw_user_meta_data, created_at, updated_at,
                          confirmation_token, recovery_token, email_change_token_new, email_change)
  select '00000000-0000-0000-0000-000000000000', u.id, 'authenticated', 'authenticated', u.email,
         extensions.crypt('password123', extensions.gen_salt('bf')), now(),
         '{"provider":"email","providers":["email"]}', jsonb_build_object('full_name', u.name), now(), now(),
         '', '', '', ''
  from u
  returning id, email)
insert into auth.identities (provider_id, user_id, identity_data, provider, last_sign_in_at, created_at, updated_at)
select ins.id::text, ins.id, jsonb_build_object('sub', ins.id::text, 'email', ins.email, 'email_verified', true),
       'email', now(), now(), now()
from ins;
