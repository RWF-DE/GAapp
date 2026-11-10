-- 034_room_photos：現状復帰の写真（T25。D-63。0024_room_photos.sql）。表 room_photos・予約の表 room_photo_uploads、Storage の bucket room-photos と
-- storage.objects のポリシー・トリガー、判定と集合の関数、RPC reserve_room_photo・add_room_photo・update_room_photo・delete_room_photo・
-- room_photos_with_previous。
-- 期待値は 02 の「現状復帰の写真」の表と「現状復帰の写真の権限」（Storage の表を含む）、04 の DB 関数の行から先に書いてから流した。
-- storage-api なしで、authenticated（・anon）に切り替えて storage.objects を SQL で操作する（027・032 と同じ。Storage API の upload は insert、
-- 署名つき URL は select、remove は select と delete を、呼んだ人の権限で行う）。
-- ① 形：列・CHECK・bucket・ポリシー・トリガー・関数の属性
-- ② 段：書ける人（その年度の総務の4つのロール）と書けない人（閲覧のみ・どの団体の代表・anon・未招待）、終了の年度
-- ③ 予約：エラーの順・DB が作る path・送り直し・in_use・期限切れの予約し直し・上限（予約 10・使われていない物 3・800 MiB・6 枚）
-- ④ Storage の insert：予約した人の、生きた予約の path だけ。トリガーは RLS を通らない書き込みも止める。update のポリシーはない
-- ⑤ add_room_photo・update_room_photo・delete_room_photo：届いた物だけ・送り直し・6 枚・メモ 50 字・並び・消す・監査・版を上げない
-- ⑥ 見る人：room_photos の行と Storage の物（総務・部門の代表〔部門長・副部門長〕は見え、模擬店・企業・休憩所の代表・閲覧のみ・anon は
--    見えない）と、room_photos_with_previous（前の年度のロールがなくても、今の年度で見られれば前の年度の行が返る）
-- ペルソナ（fixture）：admin・head・deputy・staff・viewer は Y1 のロール。viewer は Y1 の G4（部門）の副店長も兼ねる（部門の代表として見る）。
-- rep は G1（模擬店）の店長で Y2 の viewer。rep2 は G2（部門）の店長。admin2 は Y2 の admin。outsider は何もない。
-- このファイルで足すペルソナ：viewonly（Y1 の閲覧のみだけ）、depdep（G2〔部門〕の副店長＝副部門長）、repco（Y1 の企業の団体の店長）、
-- repra（Y1 の休憩所の団体の店長）。fixture の写真は Y1・Y2 の R1 に1枚ずつ（RP_Y1・RP_Y2）、予約は staff の期限の切れた RU_STAFF。
begin;
\ir _helpers/personas.psql
\ir _helpers/fixture.psql

select tests.create_user(n) from unnest(array['viewonly', 'depdep', 'repco', 'repra']) n;
insert into public.year_roles (year_id, user_id, role) values (tests.id('Y1'), tests.id('viewonly'), 'viewer');
with g as (
  insert into public.groups (year_id, name, category, sort_order) values
    (tests.id('Y1'), 'T-GCO', 'company', 5), (tests.id('Y1'), 'T-GRA', 'rest_area', 6)
  returning id, name)
insert into tests.ids select substr(name, 3), id from g;
insert into public.group_members (group_id, user_id, role) values
  (tests.id('G2'), tests.id('depdep'), 'deputy_manager'),
  (tests.id('GCO'), tests.id('repco'), 'manager'), (tests.id('GRA'), tests.id('repra'), 'manager');

-- 写真の id（画面が作る uuid の代わり）
insert into tests.ids select 'PH' || n, gen_random_uuid() from generate_series(1, 40) n;

-- path：{year_id}/{room_id}/{photo_id}.{ext}
create function tests.ph_path(p_year text, p_room text, p_photo text, p_ext text default 'webp') returns text language sql stable as $$
  select tests.id(p_year) || '/' || tests.id(p_room) || '/' || tests.id(p_photo) || '.' || p_ext
$$;
-- ペルソナ（anon なら anon）で SQL を1回流し、エラーのコードと detail を返して必ず取り消す。成功なら {"code": "ok"}（032 と同じ）
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
create function tests.try_reserve(p_persona text, p_year text, p_room text, p_setup text default null) returns text language sql as $$
  select tests.rpc_error(p_persona,
    format('select public.reserve_room_photo(%L::uuid, %L::uuid, gen_random_uuid(), ''image/webp'')', tests.id(p_year), tests.id(p_room)), p_setup) ->> 'code'
$$;
-- ペルソナで予約する（取り消さない）。返り値は object_path
create function tests.reserve_as(p_persona text, p_year text, p_room text, p_photo text, p_type text default 'image/webp') returns text
language plpgsql as $$
declare v text;
begin
  perform tests.login_as(p_persona);
  select r.object_path into v from public.reserve_room_photo(tests.id(p_year), tests.id(p_room), tests.id(p_photo), p_type) r;
  perform tests.logout();
  return v;
end $$;
-- ペルソナで上げる（取り消さない）
create function tests.put_as(p_persona text, p_name text, p_mime text default 'image/webp') returns void language plpgsql as $$
begin
  perform tests.login_as(p_persona);
  insert into storage.objects (bucket_id, name, metadata)
  values ('room-photos', p_name, jsonb_build_object('size', 1000, 'mimetype', p_mime));
  perform tests.logout();
end $$;
-- ペルソナで add_room_photo を呼ぶ（取り消さない）。返り値は行の id の名前と並びとメモ
create function tests.add_as(p_persona text, p_photo text, p_memo text default null) returns text language plpgsql as $$
declare v public.room_photos;
begin
  perform tests.login_as(p_persona);
  v := public.add_room_photo(tests.id(p_photo), p_memo);
  perform tests.logout();
  return (select t.name from tests.ids t where t.id = v.id) || ' ' || v.sort_order || ' ' || v.memo;
end $$;
-- 予約・上げる・写真にするを続けて行う（取り消さない）
create function tests.photo_as(p_persona text, p_year text, p_room text, p_photo text, p_memo text default null) returns text language plpgsql as $$
begin
  perform tests.put_as(p_persona, tests.reserve_as(p_persona, p_year, p_room, p_photo));
  return tests.add_as(p_persona, p_photo, p_memo);
end $$;
-- 上げてみる（取り消す）：ok か error:<SQLSTATE>。p_persona が null なら postgres のまま、'service_role' なら service_role で
create function tests.try_upload(p_persona text, p_name text, p_mime text default 'image/webp', p_setup text default null,
                                 p_bucket text default 'room-photos') returns text language plpgsql as $$
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
    delete from storage.objects o where o.bucket_id = 'room-photos' and o.name = p_name;
    get diagnostics n = row_count;
    v := n::text;
    raise exception using errcode = 'TT001';
  exception
    when sqlstate 'TT001' then null;
    when others then v := 'error:' || sqlstate;
  end;
  return v;
end $$;
-- 見える物（bucket room-photos）と行（room_photos）の名前（取り消す）
create function tests.visible(p_persona text) returns text language plpgsql as $$
declare v text;
begin
  begin
    if p_persona = 'anon' then perform tests.login_anon(); else perform tests.login_as(p_persona); end if;
    select coalesce(string_agg(t.name, ',' order by t.name), '-') into v
    from public.room_photos p join tests.ids t on t.id = p.id;
    select v || ' / ' || coalesce(string_agg(t.name, ',' order by t.name), '-') into v
    from storage.objects o join tests.ids t on t.id::text = split_part(split_part(o.name, '/', 3), '.', 1)
    where o.bucket_id = 'room-photos';
    raise exception using errcode = 'TT001';
  exception when sqlstate 'TT001' then null;
  end;
  return v;
end $$;
-- room_photos_with_previous の行の名前（取り消す。anon なら error:<SQLSTATE>）
create function tests.with_prev(p_persona text, p_year text, p_room text) returns text language plpgsql as $$
declare v text;
begin
  begin
    if p_persona = 'anon' then perform tests.login_anon(); else perform tests.login_as(p_persona); end if;
    select coalesce(string_agg(t.name, ',' order by x.ordinality), '-') into v
    from public.room_photos_with_previous(tests.id(p_year), tests.id(p_room)) with ordinality as x
    join tests.ids t on t.id = x.id;
    raise exception using errcode = 'TT001';
  exception
    when sqlstate 'TT001' then null;
    when others then v := 'error:' || sqlstate;
  end;
  return v;
end $$;
-- update してみる（取り消す）：変わった行の数か error:<SQLSTATE>
create function tests.try_update(p_persona text, p_name text) returns text language plpgsql as $$
declare v text; n bigint;
begin
  begin
    perform tests.login_as(p_persona);
    update storage.objects o set metadata = '{"size": 2}' where o.bucket_id = 'room-photos' and o.name = p_name;
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

select plan(139);

-- ================================================================ ① 形
select columns_are('public', 'room_photos', array['id','year_id','room_id','object_path','memo','sort_order','created_by','created_at','updated_at']);
select columns_are('public', 'room_photo_uploads', array['id','year_id','room_id','object_path','content_type','created_by','expires_at','used_at','created_at','updated_at']);
select col_hasnt_default('room_photos', 'id');
select col_hasnt_default('room_photo_uploads', 'id');
select is((select column_default from information_schema.columns where table_schema = 'public' and table_name = 'room_photos' and column_name = 'memo'),
  '''''::text', 'room_photos.memo の既定値は空');
select ok((select bool_and(relrowsecurity) from pg_class where oid in ('public.room_photos'::regclass, 'public.room_photo_uploads'::regclass)),
  'room_photos・room_photo_uploads は RLS が有効');
select is((select format('%s %s %s %s', name, public::text, file_size_limit, allowed_mime_types) from storage.buckets where id = 'room-photos'),
  'room-photos false 1048576 {image/webp,image/jpeg}', 'bucket room-photos は非公開・1 枚 1 MiB・WebP・JPEG');
select is((select string_agg(format('%s %s %s', policyname, cmd, array_to_string(roles, ',')), ' / ' order by policyname)
           from pg_policies where schemaname = 'storage' and policyname like 'room\_photos\_%'),
  'room_photos_objects_delete DELETE authenticated / room_photos_objects_insert INSERT authenticated / room_photos_objects_select SELECT authenticated',
  'bucket room-photos のポリシーは select・insert・delete の3つ（update と anon 向けはない）');
select matches((select qual from pg_policies where schemaname = 'storage' and policyname = 'room_photos_objects_select'),
  '^\(\(bucket_id = ''room-photos''::text\) AND \(split_part\(name, ''/''::text, 1\) IN \( SELECT \(y\.y\)::text AS y\s+FROM private\.room_photo_year_ids\(\) y\(y\)\)\)\)$',
  'select：1つ目のフォルダの年度を、見られる年度とその前の年度の集合と比べる（集合を1回作る形）');
select is((select with_check from pg_policies where schemaname = 'storage' and policyname = 'room_photos_objects_insert'),
  '((bucket_id = ''room-photos''::text) AND (name IN ( SELECT private.my_room_photo_upload_paths() AS my_room_photo_upload_paths)))',
  'insert：自分の生きた予約の path だけ（集合を1回作る形）');
select is((select qual from pg_policies where schemaname = 'storage' and policyname = 'room_photos_objects_delete'),
  '((bucket_id = ''room-photos''::text) AND (name IN ( SELECT private.my_room_photo_orphan_paths() AS my_room_photo_orphan_paths)))',
  'delete：どの写真にも使われていない物だけ（集合を1回作る形）');
select is((select string_agg(format('%s %s %s', policyname, cmd, coalesce(qual, '-')), ' / ' order by policyname collate "C")
           from pg_policies where schemaname = 'public' and tablename in ('room_photos', 'room_photo_uploads')),
  'room_photo_uploads_select SELECT (created_by = ( SELECT auth.uid() AS uid)) / '
  || 'room_photos_select SELECT (year_id IN ( SELECT private.room_photo_year_ids() AS room_photo_year_ids))',
  '2表のポリシーは select だけ（写真は見られる年度の集合、予約は予約した人。書き込みは RPC だけ）');
select is((select pg_get_triggerdef(t.oid) from pg_trigger t where t.tgrelid = 'storage.objects'::regclass and t.tgname = 'room_photos_objects_guard'),
  'CREATE TRIGGER room_photos_objects_guard BEFORE INSERT OR UPDATE ON storage.objects FOR EACH ROW EXECUTE FUNCTION private.tg_room_photos_objects_guard()',
  'storage.objects に、bucket room-photos の物の書き込みを予約で確かめるトリガーがある');
select is((select string_agg(t.tgname, ' ' order by t.tgname) from pg_trigger t where t.tgrelid = 'public.room_photos'::regclass and not t.tgisinternal),
  'audit check_immutable check_photo_limit set_timestamps',
  'room_photos のトリガーは監査・付け替えの禁止・6 枚の上限・日時だけ（版の増分と確定中の守りはない）');
select is((select pg_get_triggerdef(t.oid) from pg_trigger t where t.tgrelid = 'public.room_photos'::regclass and t.tgname in ('check_photo_limit')),
  'CREATE TRIGGER check_photo_limit BEFORE INSERT ON public.room_photos FOR EACH ROW EXECUTE FUNCTION private.tg_room_photos_check_limit()',
  '6 枚の上限は insert の前のトリガー');
select is((select pg_get_triggerdef(t.oid) from pg_trigger t where t.tgrelid = 'public.room_photos'::regclass and t.tgname in ('check_immutable')),
  'CREATE TRIGGER check_immutable BEFORE UPDATE OF year_id, room_id, object_path ON public.room_photos FOR EACH ROW EXECUTE FUNCTION private.tg_immutable_columns(''year_id'', ''room_id'', ''object_path'')',
  '年度・場所・path は変えられない');
select is((select string_agg(t.tgname, ' ' order by t.tgname) from pg_trigger t where t.tgrelid = 'public.room_photo_uploads'::regclass and not t.tgisinternal),
  'set_timestamps', '予約の表は監査しない（日時だけ）');
select is((select string_agg(format('%s=%s %s %s', p.proname, p.prosecdef::text, p.provolatile, array_to_string(p.proconfig, ',')), ' / ' order by p.proname collate "C")
           from pg_proc p where p.oid in (to_regprocedure('public.reserve_room_photo(uuid, uuid, uuid, text)'),
                                          to_regprocedure('public.add_room_photo(uuid, text)'),
                                          to_regprocedure('public.update_room_photo(uuid, text, integer)'),
                                          to_regprocedure('public.delete_room_photo(uuid)'),
                                          to_regprocedure('public.room_photos_with_previous(uuid, uuid)'),
                                          to_regprocedure('private.can_see_room_photos(uuid)'),
                                          to_regprocedure('private.room_photo_year_ids()'),
                                          to_regprocedure('private.tg_room_photos_objects_guard()'))),
  'add_room_photo=true v search_path="" / can_see_room_photos=true s search_path="" / delete_room_photo=true v search_path="" / '
  || 'reserve_room_photo=true v search_path="" / room_photo_year_ids=true s search_path="" / room_photos_with_previous=true s search_path="" / '
  || 'tg_room_photos_objects_guard=true v search_path="" / update_room_photo=true v search_path=""',
  'RPC・判定と集合の関数・トリガー関数は SECURITY DEFINER・search_path は空（読み取りの3つは STABLE）');
-- CHECK：path は年度・場所のフォルダ・その行の id・webp か jpg。メモは 50 字まで・制御文字なし
select throws_ok($q$ insert into public.room_photos (id, year_id, room_id, object_path, sort_order)
                     values (gen_random_uuid(), tests.id('Y1'), tests.id('R2'), tests.id('Y1') || '/' || tests.id('R2') || '/' || gen_random_uuid() || '.webp', 0) $q$,
  '23514', null, 'room_photos.object_path：その行の id でない名前は入らない');
select throws_ok($q$ insert into public.room_photos (id, year_id, room_id, object_path, sort_order)
                     select x, tests.id('Y1'), tests.id('R2'), tests.id('Y1') || '/' || tests.id('R1') || '/' || x || '.webp', 0 from gen_random_uuid() x $q$,
  '23514', null, 'room_photos.object_path：ほかの場所のフォルダは入らない');
select throws_ok($q$ insert into public.room_photos (id, year_id, room_id, object_path, sort_order)
                     select x, tests.id('Y1'), tests.id('R2'), tests.id('Y1') || '/' || tests.id('R2') || '/' || x || '.png', 0 from gen_random_uuid() x $q$,
  '23514', null, 'room_photos.object_path：png は入らない');
select throws_ok($q$ insert into public.room_photos (id, year_id, room_id, object_path, memo, sort_order)
                     select x, tests.id('Y1'), tests.id('R2'), tests.id('Y1') || '/' || tests.id('R2') || '/' || x || '.jpg', repeat('あ', 51), 0 from gen_random_uuid() x $q$,
  '23514', null, 'room_photos.memo：51 字は入らない');
select throws_ok($q$ insert into public.room_photos (id, year_id, room_id, object_path, memo, sort_order)
                     select x, tests.id('Y1'), tests.id('R2'), tests.id('Y1') || '/' || tests.id('R2') || '/' || x || '.jpg', E'一\n二', 0 from gen_random_uuid() x $q$,
  '23514', null, 'room_photos.memo：改行は入らない');
select throws_ok($q$ insert into public.room_photo_uploads (id, year_id, room_id, object_path, content_type, expires_at)
                     select x, tests.id('Y1'), tests.id('R2'), tests.id('Y1') || '/' || tests.id('R2') || '/' || x || '.webp', 'image/jpeg', now() from gen_random_uuid() x $q$,
  '23514', null, 'room_photo_uploads.object_path：形（JPEG）と拡張子（webp）が合わなければ入らない');
insert into public.room_photos (id, year_id, room_id, object_path, sort_order)
select x, tests.id('Y1'), tests.id('R4'), tests.id('Y1') || '/' || tests.id('R4') || '/' || x || '.webp', 0 from gen_random_uuid() x;
select throws_ok($q$ delete from public.rooms where id = tests.id('R4') $q$, '23503', null, '写真のある場所は消せない（restrict）');
delete from public.room_photos where room_id = tests.id('R4');

-- ================================================================ ② 段
-- 書けるのは、その年度の総務の4つのロール。閲覧のみ・どの区分の団体の代表（部門を含む）・Y2 の管理者・未招待は forbidden
select is((select string_agg(p || '=' || tests.try_reserve(p, 'Y1', 'R2'), ' ' order by p)
           from unnest(array['admin', 'admin2', 'depdep', 'deputy', 'head', 'outsider', 'rep', 'rep2', 'repco', 'repra', 'staff', 'viewer', 'viewonly']) p),
  'admin=ok admin2=forbidden depdep=forbidden deputy=ok head=ok outsider=forbidden rep=forbidden rep2=forbidden repco=forbidden repra=forbidden staff=ok viewer=forbidden viewonly=forbidden',
  '受付中：総務の4つのロールは予約でき、閲覧のみ・団体の代表（部門の部門長・副部門長も）・ほかの年度の管理者・未招待は forbidden');
select is((select string_agg(s || '=' || tests.try_reserve('staff', 'Y1', 'R2', format('select tests.set_scenario(%L)', s)), ' ' order by s)
           from unnest(array['preparing', 'allocating', 'confirmed']) s),
  'allocating=ok confirmed=ok preparing=ok', '部員（staff）は準備中・振り分け中・確定中も予約できる（在庫と違う）');
select is((select string_agg(p || '=' || tests.try_reserve(p, 'Y1', 'R2', $q$ select tests.set_scenario('closed') $q$), ' ' order by p)
           from unnest(array['admin', 'deputy', 'head', 'staff', 'viewer']) p),
  'admin=invalid_state deputy=invalid_state head=invalid_state staff=invalid_state viewer=forbidden',
  '終了の年度：総務は invalid_state（読むだけ）、総務でない人はその前に forbidden');
select is(tests.rpc_error('admin', $q$ select public.reserve_room_photo(:Y1, :R2, gen_random_uuid(), 'image/webp') $q$, $q$ select tests.set_scenario('closed') $q$),
  '{"code": "invalid_state", "detail": {"status": "closed"}}'::jsonb, '終了の年度の invalid_state の detail は status');
select is(tests.try_reserve('admin2', 'Y2', 'R2'), 'ok', 'Y2 の管理者は Y2 には予約できる');
select is((select string_agg(f || '=' || (tests.rpc_error('anon', q) ->> 'code'), ' ' order by f)
           from (values ('reserve', $q$ select public.reserve_room_photo(:Y1, :R2, gen_random_uuid(), 'image/webp') $q$),
                        ('add', $q$ select public.add_room_photo(:RU_STAFF, null) $q$),
                        ('update', $q$ select public.update_room_photo(:RP_Y1, 'x', null) $q$),
                        ('delete', $q$ select public.delete_room_photo(:RP_Y1) $q$),
                        ('with_previous', $q$ select public.room_photos_with_previous(:Y1, :R1) $q$)) v(f, q)),
  'add=error:42501 delete=error:42501 reserve=error:42501 update=error:42501 with_previous=error:42501',
  'anon は5つの RPC をどれも実行できない');
-- 写真を直す・消すのも同じ段（取り消す）
select is((select string_agg(p || '=' || (tests.rpc_error(p, $q$ select public.update_room_photo(:RP_Y1, 'T-直した', null) $q$) ->> 'code'), ' ' order by p)
           from unnest(array['admin', 'admin2', 'depdep', 'deputy', 'head', 'outsider', 'rep', 'rep2', 'repco', 'staff', 'viewer', 'viewonly']) p),
  'admin=ok admin2=forbidden depdep=forbidden deputy=ok head=ok outsider=forbidden rep=forbidden rep2=forbidden repco=forbidden staff=ok viewer=forbidden viewonly=forbidden',
  'update_room_photo：写真の年度（Y1）の総務だけ。ほかの年度の総務（admin2）も、総務でない人も forbidden');
select is((select string_agg(p || '=' || (tests.rpc_error(p, $q$ select public.delete_room_photo(:RP_Y1) $q$) ->> 'code'), ' ' order by p)
           from unnest(array['admin', 'admin2', 'depdep', 'deputy', 'head', 'rep2', 'staff', 'viewer']) p),
  'admin=ok admin2=forbidden depdep=forbidden deputy=ok head=ok rep2=forbidden staff=ok viewer=forbidden',
  'delete_room_photo も同じ段');
select is((select string_agg(p || '=' || (tests.rpc_error(p, $q$ select public.delete_room_photo(:RP_Y1) $q$, $q$ select tests.set_scenario('closed') $q$) ->> 'code'), ' ' order by p)
           from unnest(array['admin', 'staff', 'viewer']) p),
  'admin=invalid_state staff=invalid_state viewer=forbidden', '終了の年度の写真は消せない（総務は invalid_state）');
select is(tests.rpc_error('staff', $q$ select public.update_room_photo(:RP_Y1, 'x', null) $q$, $q$ select tests.set_scenario('closed') $q$),
  '{"code": "invalid_state", "detail": {"status": "closed"}}'::jsonb, '終了の年度の写真のメモは直せない');
select is(tests.rpc_error('staff', $q$ select public.update_room_photo(gen_random_uuid(), 'x', null) $q$),
  '{"code": "not_found", "detail": null}'::jsonb, '写真がなければ not_found');
select is(tests.rpc_error('rep', $q$ select public.update_room_photo(gen_random_uuid(), 'x', null) $q$),
  '{"code": "forbidden", "detail": null}'::jsonb, 'どの年度の総務でもない人には、写真がなくても forbidden（有無を漏らさない）');
select is(tests.rpc_error('staff', $q$ insert into public.room_photos (id, year_id, room_id, object_path, sort_order) values (gen_random_uuid(), :Y1, :R2, 'x', 0) $q$) ->> 'code',
  'error:42501', '写真の表へ直接は書けない（総務でも）');
select is(tests.rpc_error('staff', $q$ update public.room_photo_uploads set expires_at = now() where id = :RU_STAFF $q$) ->> 'code',
  'error:42501', '予約の表へ直接は書けない');

-- ================================================================ ③ 予約
select is(tests.rpc_error('staff', $q$ select public.reserve_room_photo(null, :R2, gen_random_uuid(), 'image/webp') $q$),
  '{"code": "forbidden", "detail": null}'::jsonb, '年度が null なら forbidden');
select is(tests.rpc_error('staff', $q$ select public.reserve_room_photo(gen_random_uuid(), :R2, gen_random_uuid(), 'image/webp') $q$),
  '{"code": "forbidden", "detail": null}'::jsonb, 'ない年度は forbidden');
select is(tests.rpc_error('rep', $q$ select public.reserve_room_photo(:Y1, null, null, 'image/png') $q$),
  '{"code": "forbidden", "detail": null}'::jsonb, '総務でない人は、入力の誤りより先に forbidden');
select is(tests.rpc_error('staff', $q$ select public.reserve_room_photo(:Y1, null, gen_random_uuid(), 'image/webp') $q$),
  '{"code": "invalid_input", "detail": {"field": "room_id"}}'::jsonb, 'room_id が null なら invalid_input（room_id）');
select is(tests.rpc_error('staff', $q$ select public.reserve_room_photo(:Y1, :R2, null, 'image/webp') $q$),
  '{"code": "invalid_input", "detail": {"field": "photo_id"}}'::jsonb, 'photo_id が null なら invalid_input（photo_id）');
select is(tests.rpc_error('staff', $q$ select public.reserve_room_photo(:Y1, :R2, gen_random_uuid(), 'image/png') $q$),
  '{"code": "invalid_input", "detail": {"field": "content_type"}}'::jsonb, 'content_type が WebP・JPEG でなければ invalid_input（content_type）');
select is(tests.rpc_error('staff', $q$ select public.reserve_room_photo(:Y1, gen_random_uuid(), gen_random_uuid(), 'image/webp') $q$),
  '{"code": "not_found", "detail": null}'::jsonb, '場所がなければ not_found');

select is(tests.reserve_as('staff', 'Y1', 'R2', 'PH1'), tests.ph_path('Y1', 'R2', 'PH1'),
  'staff：予約の path は {year_id}/{room_id}/{photo_id}.webp（DB が作る）');
select is(tests.reserve_as('admin', 'Y1', 'R2', 'PH2', 'image/jpeg'), tests.ph_path('Y1', 'R2', 'PH2', 'jpg'), 'JPEG の予約の path は .jpg');
select is((select format('%s %s %s %s %s', (year_id = tests.id('Y1'))::text, (room_id = tests.id('R2'))::text, content_type,
                         (created_by = tests.id('staff'))::text, (expires_at between now() + interval '59 minutes' and now() + interval '61 minutes')::text)
           from public.room_photo_uploads where id = tests.id('PH1')),
  'true true image/webp true true', '予約の行：年度・場所・形・予約した人・期限（1 時間）');
select is(tests.reserve_as('staff', 'Y1', 'R2', 'PH1'), tests.ph_path('Y1', 'R2', 'PH1'), '同じ id・同じ中身の送り直しは同じ予約を返す');
select is((select count(*)::int from public.room_photo_uploads where id = tests.id('PH1')), 1, '送り直しで予約は増えない');
select is(tests.rpc_error('staff', $q$ select public.reserve_room_photo(:Y1, :R3, :PH1, 'image/webp') $q$),
  '{"code": "invalid_input", "detail": {"field": "photo_id", "reason": "in_use"}}'::jsonb, '同じ id でほかの場所なら invalid_input（in_use）');
select is(tests.rpc_error('staff', $q$ select public.reserve_room_photo(:Y1, :R2, :PH1, 'image/jpeg') $q$),
  '{"code": "invalid_input", "detail": {"field": "photo_id", "reason": "in_use"}}'::jsonb, '同じ id でほかの形なら invalid_input（in_use）');
select is(tests.rpc_error('head', $q$ select public.reserve_room_photo(:Y1, :R2, :PH1, 'image/webp') $q$),
  '{"code": "invalid_input", "detail": {"field": "photo_id", "reason": "in_use"}}'::jsonb, '同じ id・同じ中身でも、ほかの人の予約なら invalid_input（in_use）');
-- 期限切れ：上げられず、同じ id で予約し直せる
update public.room_photo_uploads set expires_at = now() - interval '1 minute' where id = tests.id('PH1');
select is(tests.try_upload('staff', tests.ph_path('Y1', 'R2', 'PH1')), 'error:42501', '期限の切れた予約の path には上げられない');
select is(tests.reserve_as('staff', 'Y1', 'R2', 'PH1'), tests.ph_path('Y1', 'R2', 'PH1'), '期限の切れた予約は、同じ id で予約し直せる');
select ok((select expires_at > now() + interval '59 minutes' from public.room_photo_uploads where id = tests.id('PH1')), '予約し直すと期限が延びる');
select is(tests.try_upload('staff', tests.ph_path('Y1', 'R2', 'PH1')), 'ok', '予約し直した後は上げられる');

-- 上限：1人の、写真にしていない予約（生きているか、物が残っている）は 10 個まで（PH1 を含めて staff の予約を 10 個にする。fixture の
-- RU_STAFF は期限が切れていて物がないので数えない）
select tests.reserve_as('staff', 'Y1', 'R3', 'PH' || n) from generate_series(11, 19) n;
select is(tests.rpc_error('staff', $q$ select public.reserve_room_photo(:Y1, :R3, :PH20, 'image/webp') $q$),
  '{"code": "invalid_state", "detail": {"reason": "too_many_reservations"}}'::jsonb, '写真にしていない生きた予約が 10 個なら invalid_state（too_many_reservations）');
select is(tests.rpc_error('staff', $q$ select public.reserve_room_photo(:Y1, :R3, :PH11, 'image/webp') $q$) ->> 'code',
  'ok', '上限でも、ある予約の送り直しは通る');
select is(tests.rpc_error('staff', $q$ select public.reserve_room_photo(:Y1, :R3, :PH20, 'image/webp') $q$,
                          $q$ update public.room_photo_uploads set expires_at = now() - interval '1 minute' where id = :PH11 $q$) ->> 'code',
  'ok', '期限の切れた予約（物がない）は数えない');
select is(tests.rpc_error('staff', $q$ select public.reserve_room_photo(:Y1, :R3, :PH20, 'image/webp') $q$,
                          $q$ with u as (update public.room_photo_uploads set expires_at = now() - interval '1 minute' where id = :PH11 returning 1)
                              select tests.put_object('room-photos', :Y1::text || '/' || :R3::text || '/' || :PH11::text || '.webp', '{"size": 1024}') from u $q$),
  '{"code": "invalid_state", "detail": {"reason": "too_many_reservations"}}'::jsonb,
  '期限が切れても、物が Storage に残っていれば数える');
select is(tests.rpc_error('staff', $q$ select public.reserve_room_photo(:Y1, :R3, :PH12, 'image/webp') $q$,
                          $q$ update public.room_photo_uploads set expires_at = now() - interval '1 minute' where id = :PH12;
                              select tests.reserve_as('staff', 'Y1', 'R3', 'PH20') $q$),
  '{"code": "invalid_state", "detail": {"reason": "too_many_reservations"}}'::jsonb,
  '期限の切れた古い予約の予約し直しも、ほかに生きた予約が 10 個あれば too_many_reservations');
select is(tests.rpc_error('head', $q$ select public.reserve_room_photo(:Y1, :R3, :PH20, 'image/webp') $q$) ->> 'code',
  'ok', '上限は人ごと（head は予約できる）');
-- bucket の合計：届いた物の大きさ ＋ 届いていない生きた予約 × 1 MiB ＋ 今回の 1 MiB が 800 MiB を超えれば storage_full
-- （届いていない生きた予約は staff の PH1・PH11〜PH19 の 10 個と admin の PH2 の 11 個。11 MiB。上の try_upload は取り消すので PH1 は届いていない）
select is(tests.rpc_error('head', $q$ select public.reserve_room_photo(:Y1, :R3, :PH20, 'image/webp') $q$,
                          $q$ select tests.put_object('room-photos', :Y2::text || '/' || :R3::text || '/' || gen_random_uuid() || '.webp', '{"size": 828375040}') $q$),
  '{"code": "invalid_state", "detail": {"reason": "storage_full"}}'::jsonb,
  '届いた物 790 MiB ＋ 届いていない生きた予約 11 MiB ＋ 今回 1 MiB は 800 MiB を超えるので storage_full');
select is(tests.rpc_error('head', $q$ select public.reserve_room_photo(:Y1, :R3, :PH20, 'image/webp') $q$,
                          $q$ select tests.put_object('room-photos', :Y2::text || '/' || :R3::text || '/' || gen_random_uuid() || '.webp', '{"size": 817889280}') $q$) ->> 'code',
  'ok', '届いた物 780 MiB なら、まだ予約できる');
select is(tests.rpc_error('head', $q$ select public.reserve_room_photo(:Y1, :R3, :PH25, 'image/webp') $q$,
                          $q$ select tests.reserve_as('head', 'Y1', 'R3', 'PH25');
                              update public.room_photo_uploads set expires_at = now() - interval '1 minute' where id = :PH25;
                              select tests.put_object('room-photos', :Y2::text || '/' || :R3::text || '/' || gen_random_uuid() || '.webp', '{"size": 828375040}') $q$),
  '{"code": "invalid_state", "detail": {"reason": "storage_full"}}'::jsonb,
  '期限の切れた予約の予約し直しも、bucket の合計が 800 MiB を超えれば storage_full');
-- その年度・場所のフォルダの、写真の行でも生きた予約の物でもない物：3 個で too_many_orphans
select is(tests.rpc_error('head', $q$ select public.reserve_room_photo(:Y1, :R3, :PH24, 'image/webp') $q$,
                          $q$ select tests.put_object('room-photos', :Y1::text || '/' || :R3::text || '/' || gen_random_uuid() || '.webp', '{"size": 1024}')
                              from generate_series(1, 3) $q$),
  '{"code": "invalid_state", "detail": {"reason": "too_many_orphans"}}'::jsonb,
  'その年度・場所のフォルダに、写真でも生きた予約でもない物が 3 個あれば too_many_orphans');
select is(tests.rpc_error('head', $q$ select public.reserve_room_photo(:Y1, :R3, :PH24, 'image/webp') $q$,
                          $q$ select tests.put_object('room-photos', :Y1::text || '/' || :R3::text || '/' || gen_random_uuid() || '.webp', '{"size": 1024}')
                              from generate_series(1, 2) $q$) ->> 'code',
  'ok', '残った物が 2 個なら予約できる');
select is(tests.rpc_error('head', $q$ select public.reserve_room_photo(:Y1, :R3, :PH24, 'image/webp') $q$,
                          $q$ select tests.put_object('room-photos', :Y2::text || '/' || :R3::text || '/' || gen_random_uuid() || '.webp', '{"size": 1024}')
                              from generate_series(1, 3);
                              select tests.put_object('room-photos', :Y1::text || '/' || :R2::text || '/' || gen_random_uuid() || '.webp', '{"size": 1024}')
                              from generate_series(1, 3) $q$) ->> 'code',
  'ok', '残った物は年度・場所ごと（ほかの年度・ほかの場所のフォルダの物は数えない）');
-- 1 部屋 6 枚：もう 6 枚あれば、予約も too_many_photos（fixture の RP_Y1 を含めて Y1・R1 を 6 枚にする）
select is(tests.rpc_error('head', $q$ select public.reserve_room_photo(:Y1, :R1, gen_random_uuid(), 'image/webp') $q$,
                          $q$ insert into public.room_photos (id, year_id, room_id, object_path, sort_order)
                              select x, :Y1, :R1, :Y1::text || '/' || :R1::text || '/' || x || '.webp', n from (select gen_random_uuid() x, n from generate_series(1, 5) n) s $q$),
  '{"code": "invalid_state", "detail": {"reason": "too_many_photos"}}'::jsonb, 'その年度・場所の写真がもう 6 枚なら予約も too_many_photos');
select is(tests.rpc_error('head', $q$ select public.reserve_room_photo(:Y2, :R1, gen_random_uuid(), 'image/webp') $q$,
                          $q$ insert into public.room_photos (id, year_id, room_id, object_path, sort_order)
                              select x, :Y1, :R1, :Y1::text || '/' || :R1::text || '/' || x || '.webp', n from (select gen_random_uuid() x, n from generate_series(1, 5) n) s $q$) ->> 'code',
  'forbidden', '（6 枚は年度ごと：head は Y2 の総務でないので forbidden）');
select is(tests.rpc_error('admin2', $q$ select public.reserve_room_photo(:Y2, :R1, gen_random_uuid(), 'image/webp') $q$,
                          $q$ insert into public.room_photos (id, year_id, room_id, object_path, sort_order)
                              select x, :Y1, :R1, :Y1::text || '/' || :R1::text || '/' || x || '.webp', n from (select gen_random_uuid() x, n from generate_series(1, 5) n) s $q$) ->> 'code',
  'ok', '6 枚は年度・場所ごと（Y1 の R1 が 6 枚でも、Y2 の R1 には予約できる）');

-- 後の節のために、staff の上限の確かめの予約（PH11〜PH19。物はない）を PH13 のほかは期限切れにする（数えない）
update public.room_photo_uploads set expires_at = now() - interval '1 minute'
where id in (select tests.id('PH' || n) from generate_series(11, 19) n where n <> 13);

-- ================================================================ ④ Storage の insert・update
select is(tests.try_upload('admin', tests.ph_path('Y1', 'R2', 'PH2', 'jpg'), 'image/jpeg'), 'ok', 'admin：自分の予約の path に上げられる');
select is(tests.try_upload('head', tests.ph_path('Y1', 'R2', 'PH2', 'jpg'), 'image/jpeg'), 'error:42501', 'ほかの人の予約の path には上げられない');
select is(tests.try_upload('admin', tests.ph_path('Y1', 'R2', 'PH3')), 'error:42501', '予約していない path には上げられない');
select is(tests.try_upload('admin', tests.ph_path('Y1', 'R2', 'PH2', 'jpg'), 'image/webp'), 'error:42501', '予約の形（JPEG）と違う形の物は上げられない（トリガー）');
select is(tests.try_upload('admin', tests.ph_path('Y1', 'R2', 'PH2', 'jpg'), 'image/jpeg', null, 'item-images'), 'error:42501',
  '予約の path でも、ほかの bucket には上げられない');
select is(tests.try_upload('admin', tests.ph_path('Y1', 'R2', 'PH2', 'jpg'), 'image/jpeg', $q$ select tests.set_scenario('closed') $q$), 'error:42501',
  '年度が終了なら、自分の予約にも上げられない');
select is(tests.try_upload('staff', tests.ph_path('Y1', 'R3', 'PH13'), 'image/webp', $q$ select tests.set_scenario('confirmed') $q$), 'ok',
  '部員は確定中でも自分の予約に上げられる');
select is(tests.try_upload('anon', tests.ph_path('Y1', 'R3', 'PH13')), 'error:42501', 'anon は上げられない');
select is(tests.try_upload('rep2', tests.ph_path('Y1', 'R3', 'PH13')), 'error:42501', '部門の代表は上げられない');
select is(tests.try_upload('service_role', tests.ph_path('Y1', 'R3', 'PH21')), 'error:42501', 'service_role でも、予約のない path には上げられない（トリガー）');
select is(tests.try_upload(null, tests.ph_path('Y1', 'R3', 'PH21')), 'error:42501', 'postgres でも、予約のない path には上げられない（トリガー）');
select is(tests.try_upload('service_role', tests.ph_path('Y1', 'R3', 'PH13')), 'ok', 'service_role：生きた予約の path なら上げられる（署名つきアップロード）');
select is(tests.try_upload('service_role', tests.ph_path('Y1', 'R3', 'PH13'), 'image/webp', $q$ delete from public.year_roles where user_id = :staff $q$), 'error:42501',
  'service_role：予約した人がもう総務でなければ上げられない（トリガー）');
select is(tests.rpc_error(null, $q$ insert into storage.objects (bucket_id, name, metadata) values ('room-photos', 'x.webp', '{"size": 1}') $q$) -> 'detail',
  to_jsonb('{"reason": "not_reserved"}'::text), 'トリガーの detail の reason は not_reserved');
select tests.put_as('admin', tests.ph_path('Y1', 'R2', 'PH2', 'jpg'), 'image/jpeg');
select is(tests.try_upload('admin', tests.ph_path('Y1', 'R2', 'PH2', 'jpg'), 'image/jpeg'), 'error:23505', '届いた後の2回目は一意の索引で止まる（もう届いている）');
select is((select string_agg(p || '=' || tests.try_update(p, tests.ph_path('Y1', 'R2', 'PH2', 'jpg')), ' ' order by p)
           from unnest(array['admin', 'staff']) p),
  'admin=0 staff=0', 'authenticated の update は 0 行（update のポリシーがない。上書き・移動はできない）');
select is(tests.rpc_error(null, format($q$ update storage.objects set name = name || '.x' where bucket_id = 'room-photos' and name = %L $q$,
                                       tests.ph_path('Y1', 'R2', 'PH2', 'jpg'))) ->> 'code',
  'error:42501', 'postgres でも、bucket room-photos の物の名前を変える update はトリガーが止める（移動）');
select is(tests.rpc_error(null, format($q$ update storage.objects set bucket_id = 'room-photos' where bucket_id = 'pgtap-other' and name = %L $q$,
                                       tests.id('Y1') || '/' || tests.id('G1') || '/' || tests.id('DOC_STALL') || '/' || tests.id('F_G1') || '.pdf')) ->> 'code',
  'error:42501', 'ほかの bucket の物を room-photos へ移す update も止める');

-- ================================================================ ⑤ 写真にする・直す・消す
select tests.put_as('staff', tests.ph_path('Y1', 'R2', 'PH1'));
select is(tests.rpc_error('staff', $q$ select public.add_room_photo(:PH14, null) $q$),
  '{"code": "invalid_state", "detail": {"reason": "not_uploaded"}}'::jsonb, 'まだ上げていない予約は invalid_state（not_uploaded）');
select is(tests.rpc_error('head', $q$ select public.add_room_photo(:PH1, null) $q$),
  '{"code": "invalid_input", "detail": {"field": "photo_id", "reason": "not_reserved"}}'::jsonb, 'ほかの人の予約は invalid_input（not_reserved）');
select is(tests.rpc_error('staff', $q$ select public.add_room_photo(gen_random_uuid(), null) $q$),
  '{"code": "invalid_input", "detail": {"field": "photo_id", "reason": "not_reserved"}}'::jsonb, '予約のない id は invalid_input（not_reserved）');
select is(tests.rpc_error('rep2', $q$ select public.add_room_photo(:PH1, null) $q$),
  '{"code": "forbidden", "detail": null}'::jsonb, '総務でない人は forbidden');
select is(tests.rpc_error('staff', $q$ select public.add_room_photo(:PH1, repeat('あ', 51)) $q$),
  '{"code": "invalid_input", "detail": {"field": "memo"}}'::jsonb, 'メモが 51 字なら invalid_input（memo）');
select is(tests.rpc_error('staff', $q$ select public.add_room_photo(:PH1, E'一\n二') $q$),
  '{"code": "invalid_input", "detail": {"field": "memo"}}'::jsonb, 'メモに改行があれば invalid_input（memo）');
select is(tests.rpc_error('staff', $q$ select public.add_room_photo(:PH1, null) $q$, $q$ select tests.set_scenario('closed') $q$),
  '{"code": "invalid_state", "detail": {"status": "closed"}}'::jsonb, '終了の年度では写真にできない');
select is(tests.add_as('staff', 'PH1', repeat('あ', 50)), 'PH1 0 ' || repeat('あ', 50), '1枚目（R2）：並びは 0、メモは 50 字まで入る');
select is((select format('%s %s %s', object_path = tests.ph_path('Y1', 'R2', 'PH1'), created_by = tests.id('staff'), (select used_at is not null from public.room_photo_uploads where id = tests.id('PH1')))
           from public.room_photos where id = tests.id('PH1')),
  't t t', '写真の行は予約の path・足した人を持ち、予約は使用済みになる');
select is(tests.add_as('staff', 'PH1', 'ちがうメモ'), 'PH1 0 ' || repeat('あ', 50), '送り直しは同じ行を返す（メモは変えない）');
select is(tests.try_upload('staff', tests.ph_path('Y1', 'R2', 'PH1')), 'error:42501', '使った予約の path には上げ直せない');
select is(tests.add_as('admin', 'PH2', null), 'PH2 1 ', '2枚目：並びは最大＋1、メモが null なら空');
select is(tests.photo_as('deputy', 'Y1', 'R2', 'PH3', 'T-窓側'), 'PH3 2 T-窓側', '副部門長も写真を足せる');
select is(tests.photo_as('head', 'Y1', 'R2', 'PH4'), 'PH4 3 ', '部門長も写真を足せる');
-- 6 枚の上限（トリガー）：予約は先に取っておき、5・6枚目を足した後の7枚目の add は too_many_photos
select tests.reserve_as('staff', 'Y1', 'R2', 'PH7');
select tests.put_as('staff', tests.ph_path('Y1', 'R2', 'PH7'));
select is(tests.photo_as('staff', 'Y1', 'R2', 'PH5'), 'PH5 4 ', '5枚目');
select is(tests.photo_as('staff', 'Y1', 'R2', 'PH6'), 'PH6 5 ', '6枚目');
select is(tests.rpc_error('staff', $q$ select public.add_room_photo(:PH7, null) $q$),
  '{"code": "invalid_state", "detail": {"reason": "too_many_photos"}}'::jsonb, '7枚目は、先に予約して上げていても too_many_photos（トリガー）');
select is(tests.rpc_error(null, $q$ insert into public.room_photos (id, year_id, room_id, object_path, sort_order)
                                    select x, :Y1, :R2, :Y1::text || '/' || :R2::text || '/' || x || '.webp', 9 from gen_random_uuid() x $q$),
  '{"code": "invalid_state", "detail": {"reason": "too_many_photos"}}'::jsonb, '6 枚の上限は postgres の直接の insert でも止まる');
-- メモの変更・並べ替え
select tests.login_as('staff');
select is((select format('%s %s', memo, sort_order) from public.update_room_photo(tests.id('PH2'), 'T-入口', null)), 'T-入口 1',
  'update_room_photo：メモだけを変える（並びが null なら変えない）');
select is((select format('%s %s', memo, sort_order) from public.update_room_photo(tests.id('PH2'), null, 7)), 'T-入口 7',
  'update_room_photo：並びだけを変える（メモが null なら変えない）');
select is((select format('%s %s', memo, sort_order) from public.update_room_photo(tests.id('PH2'), '', null)), ' 7', 'メモを空にできる');
select tests.logout();
select is(tests.rpc_error('staff', $q$ select public.update_room_photo(:PH2, repeat('a', 51), null) $q$),
  '{"code": "invalid_input", "detail": {"field": "memo"}}'::jsonb, 'update のメモも 50 字まで');
select is(tests.rpc_error('staff', $q$ select public.update_room_photo(:PH2, null, 1001) $q$),
  '{"code": "invalid_input", "detail": {"field": "sort_order"}}'::jsonb, '並びは 0〜1000（1001 は invalid_input）');
select is(tests.rpc_error('staff', $q$ select public.update_room_photo(:PH2, null, -1) $q$),
  '{"code": "invalid_input", "detail": {"field": "sort_order"}}'::jsonb, '並びは 0〜1000（-1 は invalid_input）');
-- 消す：path を返す。物は使われていない物になり、総務が消せる
select tests.login_as('head');
select is(public.delete_room_photo(tests.id('PH3')), tests.ph_path('Y1', 'R2', 'PH3'), 'delete_room_photo は消した写真の path を返す');
select tests.logout();
select is((select count(*)::int from public.room_photos where id = tests.id('PH3')), 0, '写真の行が消える');
select is(tests.rpc_error('deputy', $q$ select public.add_room_photo(:PH3, null) $q$),
  '{"code": "invalid_state", "detail": {"reason": "used"}}'::jsonb, '消した写真の予約の送り直しは invalid_state（used）');
select is(tests.rpc_error('head', $q$ select public.delete_room_photo(:PH3) $q$),
  '{"code": "not_found", "detail": null}'::jsonb, '消した写真をもう一度消すと not_found');
select is((select string_agg(p || '=' || tests.try_remove(p, tests.ph_path('Y1', 'R2', 'PH3')), ' ' order by p)
           from unnest(array['admin', 'admin2', 'depdep', 'rep2', 'staff', 'viewer']) p),
  'admin=1 admin2=0 depdep=0 rep2=0 staff=1 viewer=0', '消した写真の物（使われていない物）は、その年度の総務が消せる（部門の代表は見えても消せない）');
select is(tests.try_remove('staff', tests.ph_path('Y1', 'R2', 'PH3'), $q$ select tests.set_scenario('closed') $q$), '0', '終了の年度の物は消せない');
select is((select string_agg(p || '=' || tests.try_remove(p, tests.ph_path('Y1', 'R2', 'PH1')), ' ' order by p)
           from unnest(array['admin', 'staff']) p),
  'admin=0 staff=0', '写真の行に使っている物は消せない');
select tests.put_as('staff', tests.ph_path('Y1', 'R3', 'PH13'));
select is((select string_agg(p || '=' || tests.try_remove(p, tests.ph_path('Y1', 'R3', 'PH13')), ' ' order by p)
           from unnest(array['admin', 'head', 'staff']) p),
  'admin=0 head=0 staff=1', '生きた予約で上げてまだ写真にしていない物は、予約した人だけが消せる');
-- 監査：写真の追加・変更・削除は room_photos の履歴に残る（年度は行から）。版は上げない
select is((select string_agg(action, ' ' order by id) from public.audit_logs
           where table_name = 'room_photos' and row_pk ->> 'id' = tests.id('PH2')::text and year_id = tests.id('Y1')),
  'insert update update update', '写真 PH2 の追加と3回の変更が、Y1 の room_photos の履歴に残る');
select is((select count(*)::int from public.audit_logs where table_name = 'room_photos' and row_pk ->> 'id' = tests.id('PH3')::text and action = 'delete'), 1,
  '写真の削除も履歴に残る');
select is((select count(*)::int from public.audit_logs where table_name = 'room_photo_uploads'), 0, '予約の表は監査しない');
update public.years set status = 'allocating' where id = tests.id('Y1');
create temp table v0 as select tests.ver() as v;
select tests.reserve_as('admin', 'Y1', 'R3', 'PH30');
select tests.put_as('admin', tests.ph_path('Y1', 'R3', 'PH30'));
select is(tests.add_as('admin', 'PH30', null), 'PH30 0 ', '（準備）振り分け中に写真を足す');
select tests.login_as('admin');
select public.update_room_photo(tests.id('PH30'), 'T-版', 3);
select public.delete_room_photo(tests.id('PH30'));
select tests.logout();
select is(tests.ver(), (select v from v0), '写真の予約・追加・変更・削除は、振り分け中の版を上げない');

-- ================================================================ ⑥ 見る人
-- 前の年度：Y1 の前の年度を Y2 にする（Y2 は Y1 より前の年度。Y2 の R1 に fixture の RP_Y2）
update public.years set status = 'requesting', prev_year_id = tests.id('Y2') where id = tests.id('Y1');
select tests.put_object('room-photos', tests.ph_path('Y1', 'R1', 'RP_Y1'));
select tests.put_object('room-photos', tests.ph_path('Y2', 'R1', 'RP_Y2'));
-- 写真の行と Storage の物（このときの Y1 の写真は R1 の RP_Y1 と R2 の PH1・PH2・PH4・PH5・PH6、Y2 は RP_Y2。物は写真の行と、写真にしていない
-- 物〔PH3・PH13 は消した後に置き直さないので無い。PH7 は届いたまま〕）。比べやすいよう、物は R1 の2つだけを見る
create function tests.visible_r1(p_persona text) returns text language sql as $$
  select (select string_agg(x, ',' order by x) from unnest(string_to_array(split_part(tests.visible(p_persona), ' / ', 1), ',')) x
          where x in ('RP_Y1', 'RP_Y2', 'PH1', '-'))
         || ' / ' || coalesce((select string_agg(x, ',' order by x) from unnest(string_to_array(split_part(tests.visible(p_persona), ' / ', 2), ',')) x
                               where x in ('RP_Y1', 'RP_Y2')), '-')
$$;
select is((select string_agg(p || '=' || tests.visible_r1(p), ' | ' order by p)
           from unnest(array['admin', 'admin2', 'depdep', 'deputy', 'head', 'outsider', 'rep', 'rep2', 'repco', 'repra', 'staff', 'viewer', 'viewonly']) p),
  'admin=PH1,RP_Y1,RP_Y2 / RP_Y1,RP_Y2 | admin2=RP_Y2 / RP_Y2 | depdep=PH1,RP_Y1,RP_Y2 / RP_Y1,RP_Y2 | '
  || 'deputy=PH1,RP_Y1,RP_Y2 / RP_Y1,RP_Y2 | head=PH1,RP_Y1,RP_Y2 / RP_Y1,RP_Y2 | outsider=- / - | rep=- / - | '
  || 'rep2=PH1,RP_Y1,RP_Y2 / RP_Y1,RP_Y2 | repco=- / - | repra=- / - | staff=PH1,RP_Y1,RP_Y2 / RP_Y1,RP_Y2 | '
  || 'viewer=PH1,RP_Y1,RP_Y2 / RP_Y1,RP_Y2 | viewonly=- / -',
  '写真の行と Storage の物：Y1 の総務と部門の代表（部門長 rep2・副部門長 depdep・部門の副店長を兼ねる viewer）は Y1 と前の年度 Y2 の分が見え、'
  || 'Y2 の管理者は Y2 だけ、模擬店（rep）・企業・休憩所の代表、閲覧のみ（viewonly）、未招待は何も見えない');
select is(tests.rpc_error('anon', $q$ select count(*) from public.room_photos $q$) ->> 'code', 'error:42501', 'anon は写真の表を読めない（権限がない）');
select is(tests.rpc_error('anon', $q$ do $d$ begin if (select count(*) from storage.objects where bucket_id = 'room-photos') > 0 then raise exception 'seen'; end if; end $d$ $q$) ->> 'code',
  'ok', 'anon には bucket room-photos の物が見えない（anon 向けのポリシーがない）');
select is((select string_agg(p || '=' || tests.with_prev(p, 'Y1', 'R1'), ' ' order by p)
           from unnest(array['admin', 'admin2', 'anon', 'depdep', 'outsider', 'rep', 'rep2', 'repco', 'repra', 'staff', 'viewer', 'viewonly']) p),
  'admin=RP_Y1,RP_Y2 admin2=- anon=error:42501 depdep=RP_Y1,RP_Y2 outsider=- rep=- rep2=RP_Y1,RP_Y2 repco=- repra=- staff=RP_Y1,RP_Y2 viewer=RP_Y1,RP_Y2 viewonly=-',
  'room_photos_with_previous(Y1, R1)：今年（RP_Y1）が先で前年（RP_Y2）が後。前の年度のロールがない部門の代表にも返り、見られない人には 0 行');
select is(tests.with_prev('admin2', 'Y2', 'R1'), 'RP_Y2', 'Y2 の管理者は Y2 の分を読める（Y2 には前の年度がない）');
select is(tests.with_prev('admin', 'Y1', 'R2'), 'PH1,PH4,PH5,PH6,PH2', 'ほかの場所：その場所の今年の写真だけ（並び順。PH2 は並びを 7 にした）');
select is((select count(*)::int from public.room_photos_with_previous(tests.id('Y1'), null)), 0,
  'ログインしていない（auth.uid() がない）postgres には 0 行（判定は呼んだ人について答える）');
select tests.login_as('rep2');
select is((select count(*)::int from public.room_photos_with_previous(tests.id('Y1'), null)), 7,
  '部門の代表：room_id が null なら、Y1 の全部の場所の6枚と前の年度の1枚');
select is((select count(*)::int from public.room_photos_with_previous(tests.id('Y2'), null)), 0,
  '部門の代表は、Y2（自分が代表でない年度）を今の年度として読めない');
select tests.logout();
-- 予約の行は予約した人だけが読める
select tests.login_as('staff');
select ok((select count(*) > 0 and bool_and(created_by = tests.id('staff')) from public.room_photo_uploads), 'staff は自分の予約だけを読める');
select tests.logout();
select tests.login_as('rep2');
select is((select count(*)::int from public.room_photo_uploads), 0, '部門の代表には予約の行が見えない');
select tests.logout();

select * from finish();
rollback;
