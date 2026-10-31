-- 0011_app_role_lead.sql（T15。2026-10-31。D-48）：app_role に総務部門長（head）・総務副部門長（deputy_head）を足すだけ
-- alter type … add value で足した値は、同じトランザクションの中では使えない（55P04 unsafe use of new value）。CLI
-- （supabase db reset・db push）はファイルごとに1つのトランザクションで流すので、値を足すだけのこのファイルを分け、値を使うのは
-- 0012 から（関数の本体・DO ブロック・ポリシーのロールの配列）にする。並びは admin, head, deputy_head, staff, viewer。
alter type public.app_role add value 'deputy_head' after 'admin';
alter type public.app_role add value 'head' after 'admin';
