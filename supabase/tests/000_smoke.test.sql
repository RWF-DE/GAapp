-- 空の pgTAP テスト（T02 以降で RLS・RPC のテストを足す）
begin;
select plan(1);
select ok(true, 'pgTAP が動く');
select * from finish();
rollback;
