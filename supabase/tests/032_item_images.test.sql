-- 032_item_images：品目の画像（T23。D-61。0022_item_images.sql）。列 image_path、予約の表 item_image_uploads、Storage の bucket item-images と
-- storage.objects のポリシー・トリガー、RPC reserve_item_image・set_item_image。
-- 期待値は 02 の「品目の画像」の表と「品目の画像の権限」（Storage の表を含む）、04 の DB 関数の行から先に書いてから流した。
-- storage-api なしで、authenticated（・anon）に切り替えて storage.objects を SQL で操作する（027 と同じ。Storage API の upload は insert、
-- 署名つき URL は select、remove は select と delete を、呼んだ人の権限で行う）。
-- ① 形：列・CHECK・予約の表・bucket・ポリシー・トリガー・関数の属性
-- ② 段：reserve_item_image を呼べる人（count_item は在庫を書ける人、item は管理者だけ。年度の状態 × ペルソナ。anon）
-- ③ 入力と path：エラーの順・DB が作る path の形・送り直し・in_use・期限切れの予約し直し・上限
-- ④ Storage の insert：予約した人の、生きた予約の path だけ。トリガーは RLS を通らない書き込みも止める
-- ⑤ Storage の select・update・delete
-- ⑥ set_item_image：届いた物だけ・前の path を返す・送り直し・外す・直接の変更の禁止・版を上げない・監査
-- ペルソナ（fixture）：admin・head・deputy・staff・viewer は Y1（requesting）のロール。rep は G1 の店長で Y2 の viewer。rep2 は G2 の店長。
-- admin2 は Y2（preparing）の admin。staff は Y2 では G3 の店長（ロールではない）。outsider は何もない。
-- 備品（数えるだけ）は CI_TRASH・CI_WHITE・CI_SPARE、品目は desk・chair など（fixture）。
begin;
\ir _helpers/personas.psql
\ir _helpers/fixture.psql

-- 画像の id（画面が作る uuid の代わり）
insert into tests.ids select 'IMG' || n, gen_random_uuid() from generate_series(1, 30) n;

-- path：kind は item か count_item
create function tests.img_path(p_kind text, p_target text, p_image text, p_ext text default 'webp') returns text language sql stable as $$
  select case p_kind when 'item' then 'items/' else 'count-items/' end || tests.id(p_target) || '/' || tests.id(p_image) || '.' || p_ext
$$;
-- ペルソナ（anon なら anon）で SQL を1回流し、エラーのコードと detail を返して必ず取り消す。成功なら {"code": "ok"}（031 と同じ）
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
                else jsonb_build_object('code', 'error:' || v_state, 'detail', nullif(v_detail, '')) end;
  end;
  return v;
end $$;
-- 予約してみる（取り消す）：ok か P0001 のコード
create function tests.try_reserve(p_persona text, p_kind text, p_target text, p_setup text default null) returns text language sql as $$
  select tests.rpc_error(p_persona,
    format('select public.reserve_item_image(%L, %L::uuid, gen_random_uuid(), ''image/webp'')', p_kind, tests.id(p_target)), p_setup) ->> 'code'
$$;
-- ペルソナで予約する（取り消さない）。返り値は object_path
create function tests.reserve_as(p_persona text, p_kind text, p_target text, p_image text, p_type text default 'image/webp') returns text
language plpgsql as $$
declare v text;
begin
  perform tests.login_as(p_persona);
  select r.object_path into v from public.reserve_item_image(p_kind, tests.id(p_target), tests.id(p_image), p_type) r;
  perform tests.logout();
  return v;
end $$;
-- ペルソナで上げる（取り消さない）
create function tests.put_as(p_persona text, p_name text, p_mime text default 'image/webp') returns void language plpgsql as $$
begin
  perform tests.login_as(p_persona);
  insert into storage.objects (bucket_id, name, metadata)
  values ('item-images', p_name, jsonb_build_object('size', 1000, 'mimetype', p_mime));
  perform tests.logout();
end $$;
-- ペルソナで set_item_image を呼ぶ（取り消さない）。返り値は前の path（null は '-'）
create function tests.set_as(p_persona text, p_kind text, p_target text, p_image text) returns text language plpgsql as $$
declare v text;
begin
  perform tests.login_as(p_persona);
  v := public.set_item_image(p_kind, tests.id(p_target), tests.id(p_image));
  perform tests.logout();
  return coalesce(v, '-');
end $$;
-- 上げてみる（取り消す）：ok か error:<SQLSTATE>。p_persona が null なら postgres のまま、'service_role' なら service_role で
create function tests.try_upload(p_persona text, p_name text, p_mime text default 'image/webp', p_setup text default null,
                                 p_bucket text default 'item-images') returns text language plpgsql as $$
declare v text;
begin
  begin
    if p_setup is not null then execute tests.sql(p_setup); end if;
    if p_persona = 'anon' then perform tests.login_anon();
    elsif p_persona = 'service_role' then set local role service_role;
    elsif p_persona is not null then perform tests.login_as(p_persona);
    end if;
    insert into storage.objects (bucket_id, name, metadata) values (p_bucket, p_name, jsonb_build_object('size', 1000, 'mimetype', p_mime));
    v := 'ok';
    raise exception using errcode = 'TT001';
  exception
    when sqlstate 'TT001' then null;
    when others then v := 'error:' || sqlstate;
  end;
  return v;
end $$;
-- 消してみる（取り消す。storage.allow_delete_query を立てる）：消えた行の数か error:<SQLSTATE>
create function tests.try_remove(p_persona text, p_name text, p_setup text default null) returns text language plpgsql as $$
declare v text; n bigint;
begin
  begin
    if p_setup is not null then execute tests.sql(p_setup); end if;
    perform set_config('storage.allow_delete_query', 'true', true);
    if p_persona = 'anon' then perform tests.login_anon(); else perform tests.login_as(p_persona); end if;
    delete from storage.objects o where o.bucket_id = 'item-images' and o.name = p_name;
    get diagnostics n = row_count;
    v := n::text;
    raise exception using errcode = 'TT001';
  exception
    when sqlstate 'TT001' then null;
    when others then v := 'error:' || sqlstate;
  end;
  return v;
end $$;
-- 見える bucket item-images の物の数（取り消す）
create function tests.visible_images(p_persona text) returns int language plpgsql as $$
declare v int;
begin
  begin
    if p_persona = 'anon' then perform tests.login_anon(); else perform tests.login_as(p_persona); end if;
    select count(*)::int into v from storage.objects o where o.bucket_id = 'item-images';
    raise exception using errcode = 'TT001';
  exception when sqlstate 'TT001' then null;
  end;
  return v;
end $$;
-- update してみる（取り消す）：変わった行の数か error:<SQLSTATE>
create function tests.try_update(p_persona text, p_name text) returns text language plpgsql as $$
declare v text; n bigint;
begin
  begin
    perform tests.login_as(p_persona);
    update storage.objects o set metadata = '{"size": 2}' where o.bucket_id = 'item-images' and o.name = p_name;
    get diagnostics n = row_count;
    v := n::text;
    raise exception using errcode = 'TT001';
  exception
    when sqlstate 'TT001' then null;
    when others then v := 'error:' || sqlstate;
  end;
  return v;
end $$;
grant execute on all functions in schema tests to authenticated, anon;

select plan(126);

-- ================================================================ ① 形
select col_type_is('items', 'image_path', 'text');
select col_is_null('items', 'image_path');
select col_type_is('count_items', 'image_path', 'text');
select col_is_null('count_items', 'image_path');
select columns_are('public', 'item_image_uploads',
  array['id','item_id','count_item_id','object_path','content_type','created_by','expires_at','used_at','replaced_path','created_at','updated_at']);
select col_hasnt_default('item_image_uploads', 'id');
select ok((select relrowsecurity from pg_class where oid = 'public.item_image_uploads'::regclass), 'item_image_uploads は RLS が有効');
select is((select format('%s %s %s %s', name, public::text, file_size_limit, allowed_mime_types) from storage.buckets where id = 'item-images'),
  'item-images false 1048576 {image/webp,image/jpeg}', 'bucket item-images は非公開・1 枚 1 MiB・WebP・JPEG');
select is((select string_agg(format('%s %s %s', policyname, cmd, array_to_string(roles, ',')), ' / ' order by policyname)
           from pg_policies where schemaname = 'storage' and policyname like 'item\_images\_%'),
  'item_images_objects_delete DELETE authenticated / item_images_objects_insert INSERT authenticated / item_images_objects_select SELECT authenticated',
  'bucket item-images のポリシーは select・insert・delete の3つ（update と anon 向けはない）');
select ok((select bool_and(coalesce(qual, with_check) ~ '^\(\(bucket_id = ''item-images''::text\) AND ')
           from pg_policies where schemaname = 'storage' and policyname like 'item\_images\_%'),
  '3つのポリシーは、どれも bucket item-images の物だけに効く（式の先頭で bucket を見る）');
select is((select qual from pg_policies where schemaname = 'storage' and policyname = 'item_images_objects_select'),
  '((bucket_id = ''item-images''::text) AND ( SELECT private.has_any_access() AS has_any_access))',
  'select：どこかの年度のロールか団体代表がある人（has_any_access を1回だけ呼ぶ形）');
select is((select with_check from pg_policies where schemaname = 'storage' and policyname = 'item_images_objects_insert'),
  '((bucket_id = ''item-images''::text) AND (name IN ( SELECT private.my_item_image_upload_paths() AS my_item_image_upload_paths)))',
  'insert：自分の生きた予約の path だけ（集合を1回作る形）');
select is((select qual from pg_policies where schemaname = 'storage' and policyname = 'item_images_objects_delete'),
  '((bucket_id = ''item-images''::text) AND (name IN ( SELECT private.my_item_image_orphan_paths() AS my_item_image_orphan_paths)))',
  'delete：どの行にも使われていない物だけ（集合を1回作る形）');
select is((select pg_get_triggerdef(t.oid) from pg_trigger t where t.tgrelid = 'storage.objects'::regclass and t.tgname = 'item_images_objects_guard'),
  'CREATE TRIGGER item_images_objects_guard BEFORE INSERT OR UPDATE ON storage.objects FOR EACH ROW EXECUTE FUNCTION private.tg_item_images_objects_guard()',
  'storage.objects に、bucket item-images の物の書き込みを予約で確かめるトリガーがある');
select is((select string_agg(format('%s=%s %s %s', p.proname, p.prosecdef::text, p.provolatile, array_to_string(p.proconfig, ',')), ' / ' order by p.proname)
           from pg_proc p where p.oid in (to_regprocedure('public.reserve_item_image(text, uuid, uuid, text)'),
                                          to_regprocedure('public.set_item_image(text, uuid, uuid)'),
                                          to_regprocedure('private.tg_item_images_objects_guard()'))),
  'reserve_item_image=true v search_path="" / set_item_image=true v search_path="" / tg_item_images_objects_guard=true v search_path=""',
  'RPC 2つとトリガー関数は SECURITY DEFINER・VOLATILE・search_path は空');
select is((select string_agg(c.relname || ':' || pg_get_triggerdef(t.oid), ' / ' order by c.relname) from pg_trigger t join pg_class c on c.oid = t.tgrelid
           where t.tgname = 'check_image_path' and c.relnamespace = 'public'::regnamespace),
  'count_items:CREATE TRIGGER check_image_path BEFORE INSERT OR UPDATE OF image_path ON public.count_items FOR EACH ROW EXECUTE FUNCTION private.tg_check_image_path() / '
  || 'items:CREATE TRIGGER check_image_path BEFORE INSERT OR UPDATE OF image_path ON public.items FOR EACH ROW EXECUTE FUNCTION private.tg_check_image_path()',
  'items・count_items に、image_path を RPC の外で変えさせないトリガーがある');
-- CHECK：その行の id のフォルダ・uuid・webp か jpg（postgres のまま。auth.uid() がないのでトリガーは通す）
select lives_ok($q$ update public.items set image_path = 'items/' || id || '/' || gen_random_uuid() || '.jpg' where id = tests.id('chair') $q$,
  'items.image_path：items/{id}/{uuid}.jpg は入る（SQL Editor・seed では書ける）');
select throws_ok($q$ update public.items set image_path = 'items/' || tests.id('desk') || '/' || gen_random_uuid() || '.webp' where id = tests.id('chair') $q$,
  '23514', null, 'items.image_path：ほかの品目のフォルダは入らない');
select throws_ok($q$ update public.count_items set image_path = 'count-items/' || id || '/x.webp' where id = tests.id('CI_SPARE') $q$,
  '23514', null, 'count_items.image_path：uuid でない名前は入らない');
select throws_ok($q$ update public.count_items set image_path = 'count-items/' || id || '/' || gen_random_uuid() || '.png' where id = tests.id('CI_SPARE') $q$,
  '23514', null, 'count_items.image_path：png は入らない');
select throws_ok($q$ update public.count_items set image_path = 'items/' || id || '/' || gen_random_uuid() || '.webp' where id = tests.id('CI_SPARE') $q$,
  '23514', null, 'count_items.image_path：items のフォルダは入らない');
update public.items set image_path = null where id = tests.id('chair');

-- ================================================================ ② 段
-- count_item：在庫を書ける人（部門長以上は終了でない年度、部員は準備中・受付中）。どこかの年度で書ければよい
select is((select string_agg(p || '=' || tests.try_reserve(p, 'count_item', 'CI_WHITE'), ' ' order by p)
           from unnest(array['admin', 'admin2', 'deputy', 'head', 'outsider', 'rep', 'rep2', 'staff', 'viewer']) p),
  'admin=ok admin2=ok deputy=ok head=ok outsider=forbidden rep=forbidden rep2=forbidden staff=ok viewer=forbidden',
  'count_item（受付中）：総務と Y2 の管理者は予約でき、閲覧のみ・店長・未招待は forbidden');
select is((select string_agg(p || '=' || tests.try_reserve(p, 'count_item', 'CI_WHITE', $q$ select tests.set_scenario('preparing') $q$), ' ' order by p)
           from unnest(array['head', 'staff', 'viewer']) p),
  'head=ok staff=ok viewer=forbidden', 'count_item（準備中）：部員も予約できる');
select is((select string_agg(p || '=' || tests.try_reserve(p, 'count_item', 'CI_WHITE', $q$ select tests.set_scenario('allocating') $q$), ' ' order by p)
           from unnest(array['admin', 'head', 'staff']) p),
  'admin=ok head=ok staff=forbidden', 'count_item（振り分け中）：部員は予約できない（在庫と同じ）');
select is((select string_agg(p || '=' || tests.try_reserve(p, 'count_item', 'CI_WHITE', $q$ select tests.set_scenario('confirmed') $q$), ' ' order by p)
           from unnest(array['deputy', 'staff']) p),
  'deputy=ok staff=forbidden', 'count_item（確定中）：部門長以上は予約できる');
select is((select string_agg(p || '=' || tests.try_reserve(p, 'count_item', 'CI_WHITE', $q$ select tests.set_scenario('closed') $q$), ' ' order by p)
           from unnest(array['admin', 'admin2', 'head', 'staff']) p),
  'admin=forbidden admin2=ok head=forbidden staff=forbidden', 'count_item（Y1 が終了）：Y1 の人は予約できない（Y2 の管理者はできる）');
select is(tests.try_reserve('admin2', 'count_item', 'CI_WHITE', $q$ update public.years set status = 'closed' where id = :Y2 $q$), 'forbidden',
  'count_item：Y2 が終了なら、Y2 の管理者も予約できない');
-- item：終了でない年度のどれかの管理者だけ
select is((select string_agg(p || '=' || tests.try_reserve(p, 'item', 'desk'), ' ' order by p)
           from unnest(array['admin', 'admin2', 'deputy', 'head', 'outsider', 'rep', 'rep2', 'staff', 'viewer']) p),
  'admin=ok admin2=ok deputy=forbidden head=forbidden outsider=forbidden rep=forbidden rep2=forbidden staff=forbidden viewer=forbidden',
  'item：管理者だけが予約できる（部門長・副部門長・部員も forbidden）');
select is((select string_agg(p || '=' || tests.try_reserve(p, 'item', 'desk', $q$ select tests.set_scenario('closed') $q$), ' ' order by p)
           from unnest(array['admin', 'admin2']) p),
  'admin=forbidden admin2=ok', 'item（Y1 が終了）：Y1 の管理者は予約できない');
select is(tests.rpc_error('anon', $q$ select public.reserve_item_image('count_item', :CI_WHITE, gen_random_uuid(), 'image/webp') $q$) ->> 'code',
  'error:42501', 'anon は reserve_item_image を実行できない');
select is(tests.rpc_error('anon', $q$ select public.set_item_image('count_item', :CI_WHITE, null) $q$) ->> 'code',
  'error:42501', 'anon は set_item_image を実行できない');
select is((select string_agg(p || '=' || (tests.rpc_error(p, $q$ select public.set_item_image('count_item', :CI_WHITE, null) $q$) ->> 'code'), ' ' order by p)
           from unnest(array['admin', 'rep', 'staff', 'viewer']) p),
  'admin=ok rep=forbidden staff=ok viewer=forbidden', 'set_item_image（count_item を外す）も同じ段');
select is((select string_agg(p || '=' || (tests.rpc_error(p, $q$ select public.set_item_image('item', :desk, null) $q$) ->> 'code'), ' ' order by p)
           from unnest(array['admin', 'head', 'staff']) p),
  'admin=ok head=forbidden staff=forbidden', 'set_item_image（item を外す）は管理者だけ');

-- ================================================================ ③ 入力と path
select is(tests.rpc_error('rep', $q$ select public.reserve_item_image('x', :CI_WHITE, gen_random_uuid(), 'image/webp') $q$),
  '{"code": "forbidden", "detail": null}'::jsonb, 'どちらの段でもない人は、kind の誤りより先に forbidden');
select is(tests.rpc_error('staff', $q$ select public.reserve_item_image('x', :CI_WHITE, gen_random_uuid(), 'image/webp') $q$),
  '{"code": "invalid_input", "detail": {"field": "kind"}}'::jsonb, 'kind が item・count_item でなければ invalid_input（kind）');
select is(tests.rpc_error('staff', $q$ select public.reserve_item_image(null, :CI_WHITE, gen_random_uuid(), 'image/webp') $q$),
  '{"code": "invalid_input", "detail": {"field": "kind"}}'::jsonb, 'kind が null でも invalid_input（kind）');
select is(tests.rpc_error('staff', $q$ select public.reserve_item_image('count_item', null, gen_random_uuid(), 'image/webp') $q$),
  '{"code": "invalid_input", "detail": {"field": "target_id"}}'::jsonb, 'target_id が null なら invalid_input（target_id）');
select is(tests.rpc_error('staff', $q$ select public.reserve_item_image('count_item', :CI_WHITE, null, 'image/webp') $q$),
  '{"code": "invalid_input", "detail": {"field": "image_id"}}'::jsonb, 'image_id が null なら invalid_input（image_id）');
select is(tests.rpc_error('staff', $q$ select public.reserve_item_image('count_item', :CI_WHITE, gen_random_uuid(), 'image/png') $q$),
  '{"code": "invalid_input", "detail": {"field": "content_type"}}'::jsonb, 'content_type が WebP・JPEG でなければ invalid_input（content_type）');
select is(tests.rpc_error('staff', $q$ select public.reserve_item_image('count_item', gen_random_uuid(), gen_random_uuid(), 'image/webp') $q$),
  '{"code": "not_found", "detail": null}'::jsonb, '対象の行がなければ not_found');
select is(tests.rpc_error('admin', $q$ select public.reserve_item_image('item', :CI_WHITE, gen_random_uuid(), 'image/webp') $q$),
  '{"code": "not_found", "detail": null}'::jsonb, 'kind が item で count_items の id なら not_found（表を取り違えない）');

select is(tests.reserve_as('staff', 'count_item', 'CI_WHITE', 'IMG1'), tests.img_path('count_item', 'CI_WHITE', 'IMG1'),
  'staff：count_item の予約の path は count-items/{count_item_id}/{image_id}.webp（DB が作る）');
select is(tests.reserve_as('admin', 'item', 'desk', 'IMG2', 'image/jpeg'), tests.img_path('item', 'desk', 'IMG2', 'jpg'),
  'admin：item の JPEG の予約の path は items/{item_id}/{image_id}.jpg');
select is((select format('%s %s %s %s %s', (item_id is null)::text, (count_item_id = tests.id('CI_WHITE'))::text, content_type,
                         (created_by = tests.id('staff'))::text, (expires_at between now() + interval '59 minutes' and now() + interval '61 minutes')::text)
           from public.item_image_uploads where id = tests.id('IMG1')),
  'true true image/webp true true', '予約の行：対象・形・予約した人・期限（1 時間）');
select is(tests.reserve_as('staff', 'count_item', 'CI_WHITE', 'IMG1'), tests.img_path('count_item', 'CI_WHITE', 'IMG1'),
  '同じ id・同じ中身の送り直しは同じ予約を返す');
select is((select count(*)::int from public.item_image_uploads where id = tests.id('IMG1')), 1, '送り直しで予約は増えない');
select is(tests.rpc_error('staff', $q$ select public.reserve_item_image('count_item', :CI_TRASH, :IMG1, 'image/webp') $q$),
  '{"code": "invalid_input", "detail": {"field": "image_id", "reason": "in_use"}}'::jsonb, '同じ id でほかの対象なら invalid_input（in_use）');
select is(tests.rpc_error('staff', $q$ select public.reserve_item_image('count_item', :CI_WHITE, :IMG1, 'image/jpeg') $q$),
  '{"code": "invalid_input", "detail": {"field": "image_id", "reason": "in_use"}}'::jsonb, '同じ id でほかの形なら invalid_input（in_use）');
select is(tests.rpc_error('head', $q$ select public.reserve_item_image('count_item', :CI_WHITE, :IMG1, 'image/webp') $q$),
  '{"code": "invalid_input", "detail": {"field": "image_id", "reason": "in_use"}}'::jsonb, '同じ id・同じ中身でも、ほかの人の予約なら invalid_input（in_use）');
select is(tests.rpc_error('admin', $q$ select public.reserve_item_image('item', :desk, :IMG1, 'image/webp') $q$),
  '{"code": "invalid_input", "detail": {"field": "image_id", "reason": "in_use"}}'::jsonb, '同じ id でほかの kind なら invalid_input（in_use）');
select is_empty($q$ select 1 from pg_policies where schemaname = 'public' and tablename = 'item_image_uploads' and cmd <> 'SELECT' $q$,
  '予約の表に書き込みのポリシーはない（RPC だけ）');
select is(tests.rpc_error('staff', $q$ insert into public.item_image_uploads (id, count_item_id, object_path, content_type, expires_at)
                                       values (gen_random_uuid(), :CI_WHITE, 'x', 'image/webp', now()) $q$) ->> 'code',
  'error:42501', '予約の表へ直接は書けない');

-- 期限切れ：上げられず、同じ id で予約し直せる
update public.item_image_uploads set expires_at = now() - interval '1 minute' where id = tests.id('IMG1');
select is(tests.try_upload('staff', tests.img_path('count_item', 'CI_WHITE', 'IMG1')), 'error:42501', '期限の切れた予約の path には上げられない');
select is(tests.reserve_as('staff', 'count_item', 'CI_WHITE', 'IMG1'), tests.img_path('count_item', 'CI_WHITE', 'IMG1'),
  '期限の切れた予約は、同じ id で予約し直せる');
select ok((select expires_at > now() + interval '59 minutes' from public.item_image_uploads where id = tests.id('IMG1')), '予約し直すと期限が延びる');
select is(tests.try_upload('staff', tests.img_path('count_item', 'CI_WHITE', 'IMG1')), 'ok', '予約し直した後は上げられる');

-- 上限：1人の、行の画像にしていない予約（生きているか、物が残っている）は 10 個まで（IMG1 を含めて staff の予約を 10 個にする）
select tests.reserve_as('staff', 'count_item', 'CI_SPARE', 'IMG' || n) from generate_series(11, 19) n;
select is(tests.rpc_error('staff', $q$ select public.reserve_item_image('count_item', :CI_SPARE, :IMG20, 'image/webp') $q$),
  '{"code": "invalid_state", "detail": {"reason": "too_many_reservations"}}'::jsonb, '上げていない生きた予約が 10 個なら invalid_state（too_many_reservations）');
select is(tests.rpc_error('staff', $q$ select public.reserve_item_image('count_item', :CI_SPARE, :IMG11, 'image/webp') $q$) ->> 'code',
  'ok', '上限でも、ある予約の送り直しは通る');
select is(tests.rpc_error('staff', $q$ select public.reserve_item_image('count_item', :CI_SPARE, :IMG20, 'image/webp') $q$,
                          $q$ update public.item_image_uploads set expires_at = now() - interval '1 minute' where id = :IMG11 $q$) ->> 'code',
  'ok', '期限の切れた予約は数えない');
-- 上げたが行の画像にしていない物も数える（セキュリティのレビュー：上げて set を呼ばない物を積み上げて bucket を埋めさせない）
select is(tests.rpc_error('staff', $q$ select public.reserve_item_image('count_item', :CI_SPARE, :IMG20, 'image/webp') $q$,
                          $q$ select tests.put_object('item-images', 'count-items/' || :CI_SPARE::text || '/' || :IMG11::text || '.webp', '{"size": 1024}') $q$),
  '{"code": "invalid_state", "detail": {"reason": "too_many_reservations"}}'::jsonb, '上げて行の画像にしていない予約も数える（10 個なら too_many_reservations）');
select is(tests.rpc_error('staff', $q$ select public.reserve_item_image('count_item', :CI_SPARE, :IMG20, 'image/webp') $q$,
                          $q$ with u as (update public.item_image_uploads set expires_at = now() - interval '1 minute' where id = :IMG11 returning 1)
                              select tests.put_object('item-images', 'count-items/' || :CI_SPARE::text || '/' || :IMG11::text || '.webp', '{"size": 1024}') from u $q$),
  '{"code": "invalid_state", "detail": {"reason": "too_many_reservations"}}'::jsonb,
  '期限が切れても、物が Storage に残っていれば数える（消せば数えない）');
select is(tests.rpc_error('head', $q$ select public.reserve_item_image('count_item', :CI_SPARE, :IMG20, 'image/webp') $q$) ->> 'code',
  'ok', '上限は人ごと（head は予約できる）');
-- bucket の合計：届いた物の大きさ ＋ 届いていない生きた予約 × 1 MiB ＋ 今回の 1 MiB が 100 MiB を超えれば storage_full
select is(tests.rpc_error('head', $q$ select public.reserve_item_image('count_item', :CI_SPARE, :IMG20, 'image/webp') $q$,
                          $q$ select tests.put_object('item-images', 'count-items/' || :CI_SPARE::text || '/' || gen_random_uuid() || '.webp', '{"size": 94371840}') $q$),
  '{"code": "invalid_state", "detail": {"reason": "storage_full"}}'::jsonb,
  '届いた物 90 MiB ＋ 届いていない生きた予約 11 個（staff の 10 個と admin の 1 個。11 MiB）＋ 今回 1 MiB は 100 MiB を超えるので storage_full');
select is(tests.rpc_error('head', $q$ select public.reserve_item_image('count_item', :CI_SPARE, :IMG20, 'image/webp') $q$,
                          $q$ select tests.put_object('item-images', 'count-items/' || :CI_SPARE::text || '/' || gen_random_uuid() || '.webp', '{"size": 83886080}') $q$) ->> 'code',
  'ok', '届いた物 80 MiB なら、まだ予約できる');

-- ================================================================ ④ Storage の insert
select is(tests.try_upload('admin', tests.img_path('item', 'desk', 'IMG2', 'jpg'), 'image/jpeg'), 'ok', 'admin：自分の予約の path に上げられる');
select is(tests.try_upload('admin2', tests.img_path('item', 'desk', 'IMG2', 'jpg'), 'image/jpeg'), 'error:42501', 'ほかの人の予約の path には上げられない（管理者どうしでも）');
select is(tests.try_upload('admin', tests.img_path('item', 'desk', 'IMG3')), 'error:42501', '予約していない path には上げられない');
select is(tests.try_upload('admin', upper(tests.img_path('item', 'desk', 'IMG2', 'jpg')), 'image/jpeg'), 'error:42501', '予約の path と1文字でも違えば上げられない');
select is(tests.try_upload('admin', tests.img_path('item', 'desk', 'IMG2', 'jpg'), 'image/webp'), 'error:42501',
  '予約の形（JPEG）と違う形（WebP）の物は上げられない（トリガー）');
select is(tests.try_upload('admin', tests.img_path('item', 'desk', 'IMG2', 'jpg'), 'image/jpeg', null, 'pgtap-other'), 'error:42501',
  '予約の path でも、ほかの bucket には上げられない');
select is(tests.try_upload('admin', tests.img_path('item', 'desk', 'IMG2', 'jpg'), 'image/jpeg', $q$ select tests.set_scenario('closed') $q$), 'error:42501',
  'Y1 が終了で、管理者でなくなれば、自分の予約にも上げられない');
select is(tests.try_upload('staff', tests.img_path('count_item', 'CI_SPARE', 'IMG12'), 'image/webp', $q$ select tests.set_scenario('allocating') $q$), 'error:42501',
  '部員は振り分け中になれば、自分の予約にも上げられない（在庫を書けない）');
select is(tests.try_upload('staff', tests.img_path('count_item', 'CI_SPARE', 'IMG12')), 'ok', '部員は受付中なら上げられる');
select is(tests.try_upload('anon', tests.img_path('count_item', 'CI_SPARE', 'IMG12')), 'error:42501', 'anon は上げられない');
select is(tests.try_upload('outsider', tests.img_path('count_item', 'CI_SPARE', 'IMG12')), 'error:42501', '未招待の人は上げられない');
-- RLS を通らない書き込み（署名つきアップロードの service_role・postgres）もトリガーが止める
select is(tests.try_upload('service_role', tests.img_path('count_item', 'CI_SPARE', 'IMG21')), 'error:42501',
  'service_role でも、予約のない path には上げられない（トリガー）');
select is(tests.try_upload(null, tests.img_path('count_item', 'CI_SPARE', 'IMG21')), 'error:42501', 'postgres でも、予約のない path には上げられない（トリガー）');
select is(tests.try_upload('service_role', tests.img_path('count_item', 'CI_SPARE', 'IMG12')), 'ok', 'service_role：生きた予約の path なら上げられる（署名つきアップロード）');
select is(tests.try_upload('service_role', tests.img_path('count_item', 'CI_SPARE', 'IMG12'), 'image/webp',
                           $q$ update public.item_image_uploads set expires_at = now() - interval '1 second' where id = :IMG12 $q$), 'error:42501',
  'service_role：期限の切れた予約には上げられない（トリガー）');
select is(tests.try_upload('service_role', tests.img_path('count_item', 'CI_SPARE', 'IMG12'), 'image/webp',
                           $q$ delete from public.year_roles where user_id = :staff $q$), 'error:42501',
  'service_role：予約した人がもう段にいなければ上げられない（トリガー）');
select is(tests.rpc_error(null, $q$ insert into storage.objects (bucket_id, name, metadata) values ('item-images', 'items/x.webp', '{"size": 1}') $q$) -> 'detail',
  to_jsonb('{"reason": "not_reserved"}'::text), 'トリガーの detail の reason は not_reserved');
-- 上げた物の2回目は一意の索引で止まる
select tests.put_as('admin', tests.img_path('item', 'desk', 'IMG2', 'jpg'), 'image/jpeg');
select is(tests.try_upload('admin', tests.img_path('item', 'desk', 'IMG2', 'jpg'), 'image/jpeg'), 'error:23505', '届いた後の2回目は一意の索引で止まる（もう届いている）');

-- ================================================================ ⑤ Storage の select・update・delete
select is((select string_agg(p || '=' || tests.visible_images(p), ' ' order by p)
           from unnest(array['admin', 'admin2', 'anon', 'head', 'outsider', 'rep', 'rep2', 'staff', 'viewer']) p),
  'admin=1 admin2=1 anon=0 head=1 outsider=0 rep=1 rep2=1 staff=1 viewer=1',
  'select：ロールか団体代表がある人は全部の画像を読める（店長・閲覧のみも。申請の画面に出す）。未招待・anon は読めない');
select is((select string_agg(p || '=' || tests.try_update(p, tests.img_path('item', 'desk', 'IMG2', 'jpg')), ' ' order by p)
           from unnest(array['admin', 'staff', 'viewer']) p),
  'admin=0 staff=0 viewer=0', 'authenticated の update は 0 行（update のポリシーがない。上書き・移動はできない）');
select is((select count(*)::int from pg_policies where schemaname = 'storage' and tablename = 'objects' and cmd in ('UPDATE', 'ALL')), 0,
  'storage.objects に update のポリシーはない（上書き・移動・upsert はできない。authenticated の update は 0 行）');
select is(tests.rpc_error(null, format($q$ update storage.objects set name = name || '.x' where bucket_id = 'item-images' and name = %L $q$,
                                       tests.img_path('item', 'desk', 'IMG2', 'jpg'))) ->> 'code',
  'error:42501', 'postgres でも、bucket item-images の物の名前を変える update はトリガーが止める（移動）');
select is(tests.rpc_error(null, format($q$ update storage.objects set metadata = '{"size": 5}' where bucket_id = 'item-images' and name = %L $q$,
                                       tests.img_path('item', 'desk', 'IMG2', 'jpg'))) ->> 'code',
  'error:42501', 'postgres でも、bucket item-images の物の中身（metadata）を変える update はトリガーが止める（上書き）');
select is(tests.rpc_error(null, format($q$ update storage.objects set bucket_id = 'item-images' where bucket_id = 'pgtap-other' and name = %L $q$,
                                       tests.id('Y1') || '/' || tests.id('G1') || '/' || tests.id('DOC_STALL') || '/' || tests.id('F_G1') || '.pdf')) ->> 'code',
  'error:42501', 'ほかの bucket の物を item-images へ移す update も止める');
-- delete：どの行にも使われていない物。items のフォルダは管理者、count-items のフォルダは在庫を書ける人
select is((select string_agg(p || '=' || tests.try_remove(p, tests.img_path('item', 'desk', 'IMG2', 'jpg')), ' ' order by p)
           from unnest(array['admin', 'admin2', 'head', 'rep', 'staff', 'viewer']) p),
  'admin=1 admin2=0 head=0 rep=0 staff=0 viewer=0',
  'items のフォルダの、どの行にも使われていない物：消せるのは管理者だけ。ほかの人の生きた予約の物は、ほかの管理者も消せない');
select is(tests.try_remove('admin', tests.img_path('item', 'desk', 'IMG2', 'jpg'), $q$ select tests.set_scenario('closed') $q$), '0',
  'Y1 が終了なら、Y1 の管理者は消せない');

-- ================================================================ ⑥ set_item_image
select is(tests.rpc_error('staff', $q$ select public.set_item_image('count_item', :CI_SPARE, :IMG13) $q$),
  '{"code": "invalid_state", "detail": {"reason": "not_uploaded"}}'::jsonb, 'まだ上げていない予約は invalid_state（not_uploaded）');
select is(tests.rpc_error('head', $q$ select public.set_item_image('count_item', :CI_SPARE, :IMG12) $q$),
  '{"code": "invalid_input", "detail": {"field": "image_id", "reason": "not_reserved"}}'::jsonb, 'ほかの人の予約は invalid_input（not_reserved）');
select is(tests.rpc_error('staff', $q$ select public.set_item_image('count_item', :CI_WHITE, :IMG12) $q$),
  '{"code": "invalid_input", "detail": {"field": "image_id", "reason": "not_reserved"}}'::jsonb, 'ほかの対象の予約は invalid_input（not_reserved）');
select is(tests.rpc_error('staff', $q$ select public.set_item_image('count_item', :CI_SPARE, :IMG29) $q$),
  '{"code": "invalid_input", "detail": {"field": "image_id", "reason": "not_reserved"}}'::jsonb, '予約のない id は invalid_input（not_reserved）');
select is(tests.rpc_error('staff', $q$ select public.set_item_image('count_item', gen_random_uuid(), null) $q$),
  '{"code": "not_found", "detail": null}'::jsonb, '対象の行がなければ not_found');
select is(tests.rpc_error('staff', $q$ select public.set_item_image('x', :CI_SPARE, null) $q$),
  '{"code": "invalid_input", "detail": {"field": "kind"}}'::jsonb, 'kind の誤りは invalid_input（kind）');
-- 1枚目（前の画像なし）
select tests.put_as('staff', tests.img_path('count_item', 'CI_SPARE', 'IMG12'));
select is(tests.set_as('staff', 'count_item', 'CI_SPARE', 'IMG12'), '-', '1枚目：前の画像がないので null を返す');
select is((select image_path from public.count_items where id = tests.id('CI_SPARE')), tests.img_path('count_item', 'CI_SPARE', 'IMG12'),
  '行の image_path が予約の path になる');
select is(tests.set_as('staff', 'count_item', 'CI_SPARE', 'IMG12'), '-', '送り直しは同じ前の path（null）を返す');
select is(tests.try_upload('staff', tests.img_path('count_item', 'CI_SPARE', 'IMG12')), 'error:42501',
  '使った予約の path には（消した後でも）上げ直せない');
select is((select string_agg(p || '=' || tests.try_remove(p, tests.img_path('count_item', 'CI_SPARE', 'IMG12')), ' ' order by p)
           from unnest(array['admin', 'staff']) p),
  'admin=0 staff=0', '行の画像に使っている物は消せない');
-- 2枚目（前の画像を返す。前の物は使われていない物になり、消せる）
select tests.put_as('staff', tests.img_path('count_item', 'CI_SPARE', 'IMG14'));
select is(tests.set_as('staff', 'count_item', 'CI_SPARE', 'IMG14'), tests.img_path('count_item', 'CI_SPARE', 'IMG12'), '2枚目：前の画像の path を返す');
select is(tests.set_as('staff', 'count_item', 'CI_SPARE', 'IMG14'), tests.img_path('count_item', 'CI_SPARE', 'IMG12'), '送り直しは同じ前の path を返す');
select is(tests.rpc_error('staff', $q$ select public.set_item_image('count_item', :CI_SPARE, :IMG12) $q$),
  '{"code": "invalid_state", "detail": {"reason": "used"}}'::jsonb, '替えられた後の古い予約は invalid_state（used）');
select is((select string_agg(p || '=' || tests.try_remove(p, tests.img_path('count_item', 'CI_SPARE', 'IMG12')), ' ' order by p)
           from unnest(array['admin', 'head', 'rep', 'staff', 'viewer']) p),
  'admin=1 head=1 rep=0 staff=1 viewer=0', '替えた前の物（count-items のフォルダ）は、在庫を書ける人が消せる');
select is(tests.try_remove('staff', tests.img_path('count_item', 'CI_SPARE', 'IMG12'), $q$ select tests.set_scenario('allocating') $q$), '0',
  '部員は振り分け中になれば消せない');
-- ほかの人の生きた予約で上げた物（まだ使っていない）は消せない。自分の物は消せる
select tests.reserve_as('head', 'count_item', 'CI_WHITE', 'IMG22');
select tests.put_as('head', tests.img_path('count_item', 'CI_WHITE', 'IMG22'));
select is((select string_agg(p || '=' || tests.try_remove(p, tests.img_path('count_item', 'CI_WHITE', 'IMG22')), ' ' order by p)
           from unnest(array['admin', 'head', 'staff']) p),
  'admin=0 head=1 staff=0', '生きた予約で上げてまだ使っていない物は、予約した人だけが消せる');
-- 外す
select tests.login_as('staff');
select is(public.set_item_image('count_item', tests.id('CI_SPARE'), null), tests.img_path('count_item', 'CI_SPARE', 'IMG14'),
  '外すと、前の画像の path を返す');
select is(public.set_item_image('count_item', tests.id('CI_SPARE'), null), null, 'もう画像がなければ null を返す');
select tests.logout();
select is((select image_path from public.count_items where id = tests.id('CI_SPARE')), null, '外した後は image_path が null');
-- 監査：画像の変更は count_items の履歴に残る（理由は null）
select is((select count(*)::int from public.audit_logs where table_name = 'count_items' and row_pk ->> 'id' = tests.id('CI_SPARE')::text
           and action = 'update' and before ->> 'image_path' is distinct from after ->> 'image_path'), 3,
  '画像を足した・替えた・外したの3回が count_items の履歴に残る');
-- 直接の変更は止める（RLS は列を制限できない）
select is(tests.rpc_error('admin', format($q$ update public.count_items set image_path = %L where id = :CI_SPARE $q$,
                                          tests.img_path('count_item', 'CI_SPARE', 'IMG14'))),
  '{"code": "invalid_input", "detail": {"column": "image_path", "reason": "immutable"}}'::jsonb,
  '管理者でも、image_path を直接の update では変えられない');
select is(tests.rpc_error('admin', format($q$ update public.items set image_path = %L where id = :desk $q$, tests.img_path('item', 'desk', 'IMG2', 'jpg'))),
  '{"code": "invalid_input", "detail": {"column": "image_path", "reason": "immutable"}}'::jsonb, 'items も同じ');
select is(tests.rpc_error('admin', $q$ update public.count_items set name = name where id = :CI_SPARE $q$) ->> 'code', 'ok',
  'image_path を変えない直接の update は通る');
select is(tests.rpc_error('admin', $q$ insert into public.count_items (name, image_path) values ('T-画像つき', 'count-items/x') $q$) ->> 'code',
  'invalid_input', '画像つきの直接の insert も止める');
-- items：管理者が画像を付ける。振り分け中でも版を上げない（名前の変更は上げる）
update public.years set status = 'allocating' where id = tests.id('Y1');
select is(tests.reserve_as('admin', 'item', 'chair', 'IMG23'), tests.img_path('item', 'chair', 'IMG23'), '（準備）admin：椅子の画像を予約する');
select tests.put_as('admin', tests.img_path('item', 'chair', 'IMG23'));
create temp table v0 as select tests.ver() as v;
select is(tests.set_as('admin', 'item', 'chair', 'IMG23'), '-', 'admin：椅子の画像にする');
select is(tests.ver(), (select v from v0), 'items の画像だけを変えても、振り分け中の版は上がらない');
select is((select image_path from public.items where id = tests.id('chair')), tests.img_path('item', 'chair', 'IMG23'), '品目の image_path が入る');
select tests.login_as('admin');
update public.items set name = name || '' where id = tests.id('chair');
select tests.logout();
select is(tests.ver(), (select v from v0) + 1, '品目のほかの列の変更は、今までどおり版を上げる');
select tests.login_as('admin');
select is(public.set_item_image('item', tests.id('chair'), null), tests.img_path('item', 'chair', 'IMG23'), 'admin：品目の画像を外すと前の path を返す');
select tests.logout();
select is(tests.ver(), (select v from v0) + 1, '画像を外しても版は上がらない');
select is((select count(*)::int from public.audit_logs where table_name = 'items' and row_pk ->> 'id' = tests.id('chair')::text
           and action = 'update' and before ->> 'image_path' is distinct from after ->> 'image_path'
           and coalesce(after ->> 'image_path', before ->> 'image_path') = tests.img_path('item', 'chair', 'IMG23')), 2,
  '品目の画像を付けた・外したの2回が items の履歴に残る');
-- 品目を消すと予約も消える（物は使われていない物になる）
select is(tests.rpc_error(null, $q$ delete from public.count_items where id = :CI_SPARE $q$) ->> 'code', 'ok',
  '（準備）画像の予約のある備品も消せる（予約は cascade で消える）');
-- 予約の行は予約した人だけが読める
select tests.login_as('staff');
select ok((select count(*) > 0 and bool_and(created_by = tests.id('staff')) from public.item_image_uploads), 'staff は自分の予約だけを読める');
select tests.logout();
select tests.login_as('viewer');
select is((select count(*)::int from public.item_image_uploads), 0, 'viewer には予約の行が見えない');
select tests.logout();

select * from finish();
rollback;
