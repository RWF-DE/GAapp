-- 0022_item_images.sql（T23。2026-11-10。D-61）：品目の画像。items・count_items の列 image_path、画像の予約の表 item_image_uploads、
-- Supabase Storage の非公開の bucket item-images と storage.objects のポリシー3つ・トリガー1つ、RPC reserve_item_image・set_item_image
-- 9 品目（items）と備品（数えるだけ。count_items）に写真を1枚ずつ付けられる（なくてもよい）。在庫入力・「その他」の選択・申請の画面に出す。
-- 書き込みの道（T19 の提出物のファイルと同じ「DB が予約してから上げる」形）：
--   予約・行の画像：RPC だけ（予約の表には書き込みの権限を与えない。image_path は、トリガー check_image_path が RPC の外からの変更を止める。
--                   RLS は列を制限できないので、管理者の直接の update でも変えられない）
--   Storage の物  ：Storage API（画面の upload・remove）。上げられるのは DB が予約した path だけ（storage.objects の insert のポリシーと、
--                   ロールによらず動くトリガー item_images_objects_guard。署名つきアップロードなど RLS を通らない書き込みも予約で止め、上書き・
--                   移動はいつでも止める）。Storage の物は SQL では消せない（storage.protect_delete）ので、替えた・外した前の物は画面が消す
--                   （set_item_image が前の path を返す）
-- 段（年度を選ばずに見る。画像は年度をまたぐ）：kind が item（9 品目）なら終了でない年度のどれかの管理者（is_admin_of_open_year。マスタと
-- 同じ）、count_item（備品）なら終了でない年度のどれかで在庫を書ける人（can_write_stocks_any。add_count_item と同じ段）。
-- 読める人：どこかの年度のロールか団体代表がある人（has_any_access。品目の一覧と同じ。申請の画面に出すので店長・副店長・閲覧のみも）。
-- 振り分けの入力でないので、items の画像だけの変更は版（allocation_version）を上げない（下で tg_bump_allocation_version を置き換える）。
-- 0016 の bucket documents のポリシー・トリガーは変えない（どれも bucket で分かれる）。0021 の count_items を使うので 0021 の後に当てる。

------------------------------------------------------------------------
-- 列と表
------------------------------------------------------------------------
-- 行の画像（null なら画像なし）。形はその行の id のフォルダ・予約の id（小文字の uuid）・webp か jpg に固定する（CHECK は同じ行だけを見る）
alter table public.items add column image_path text;
alter table public.items add constraint items_image_path_check check (image_path is null or image_path ~ (
  '^items/' || id::text || '/[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}\.(webp|jpg)$'));
alter table public.count_items add column image_path text;
alter table public.count_items add constraint count_items_image_path_check check (image_path is null or image_path ~ (
  '^count-items/' || id::text || '/[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}\.(webp|jpg)$'));

-- 画像の予約（RPC だけで書く）。id は画面が作る（reserve_item_image の p_image_id。既定値なし。送り直しの鍵）。対象は item_id か
-- count_item_id のどちらか1つ（行を消すと予約も消える。Storage の物は使われていない物として残り、画面が消す）。object_path は DB が作り、
-- CHECK で `items/{item_id}/{id}.{webp|jpg}` か `count-items/{count_item_id}/{id}.{webp|jpg}` に固定する（日本語・名前を入れない）。
-- created_by は予約した人（Storage に上げられるのはこの人だけ）。expires_at は予約から 1 時間（過ぎたら上げられない。同じ id で予約し直せる）。
-- used_at・replaced_path は set_item_image が行の画像にした日時と、そのときの前の画像の path（送り直しで同じ値を返す）
create table public.item_image_uploads (
  id uuid primary key,
  item_id uuid references public.items on delete cascade,
  count_item_id uuid references public.count_items on delete cascade,
  object_path text not null,
  content_type text not null,
  created_by uuid references auth.users on delete set null,
  expires_at timestamptz not null,
  used_at timestamptz,
  replaced_path text,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  constraint item_image_uploads_object_path_key unique (object_path),
  constraint item_image_uploads_target_check check (num_nonnulls(item_id, count_item_id) = 1),
  constraint item_image_uploads_content_type_check check (content_type in ('image/webp', 'image/jpeg')),
  constraint item_image_uploads_object_path_check check (object_path =
    case when item_id is not null then 'items/' || item_id::text else 'count-items/' || count_item_id::text end
    || '/' || id::text || '.' || case content_type when 'image/webp' then 'webp' else 'jpg' end)
);
-- 対象の行の削除の連鎖と、人ごとの生きた予約の数え上げ
create index item_image_uploads_item_id_idx on public.item_image_uploads (item_id);
create index item_image_uploads_count_item_id_idx on public.item_image_uploads (count_item_id);
create index item_image_uploads_created_by_idx on public.item_image_uploads (created_by);

alter table public.item_image_uploads enable row level security;

-- 日時（0002 の共通の関数）。予約の表は監査しない（手順の途中の記録。使った物は行の image_path の変更として items・count_items の監査に残る）
create trigger set_timestamps before insert or update on public.item_image_uploads
  for each row execute function private.tg_set_timestamps();

-- 予約の行は予約した人だけが読む（画面は RPC の返り値を使うので、読み直しのため）
create policy item_image_uploads_select on public.item_image_uploads for select to authenticated
  using (created_by = (select auth.uid()));

------------------------------------------------------------------------
-- 段の補助と、image_path の守り
------------------------------------------------------------------------
-- 終了でない年度のどれかで在庫を書ける（can_write_stocks と同じ条件を、年度を選ばずに見る：部門長以上は終了でない年度、部員は準備中・
-- 受付中の年度）。呼んだ人（auth.uid()）についてだけ答える。RPC と集合の関数（DEFINER）から呼ぶので、誰にも execute を与えない
create function private.can_write_stocks_any()
returns boolean language sql stable security definer set search_path = '' as $$
  select exists (
    select 1 from public.year_roles yr join public.years y on y.id = yr.year_id
    where yr.user_id = (select auth.uid())
      and ((yr.role in ('admin', 'head', 'deputy_head') and y.status <> 'closed')
        or (yr.role = 'staff' and y.status in ('preparing', 'requesting'))))
$$;

-- image_path を RPC の外で変えさせない（RLS は列を制限できない）。set_item_image が transaction-local の app.item_image を立てた書き込み
-- だけを通す。seed・SQL Editor（auth.uid() が null）では入れた値のまま（D-10 と同じ）。止めるのは invalid_input（column・reason: immutable）。
-- private.fail を呼ぶので SECURITY DEFINER（authenticated は private の補助を実行できない）
create function private.tg_check_image_path()
returns trigger language plpgsql security definer set search_path = '' as $$
begin
  if auth.uid() is not null
     and coalesce(current_setting('app.item_image', true), '') <> 'on'
     and new.image_path is distinct from (case when tg_op = 'INSERT' then null else old.image_path end) then
    perform private.fail('invalid_input', jsonb_build_object('column', 'image_path', 'reason', 'immutable'));
  end if;
  return new;
end $$;
create trigger check_image_path before insert or update of image_path on public.items
  for each row execute function private.tg_check_image_path();
create trigger check_image_path before insert or update of image_path on public.count_items
  for each row execute function private.tg_check_image_path();

-- 版の増分（0002 の関数を置き換える）：set_item_image が app.item_image を立てた items の書き込み（画像だけを変える）では何もしない。
-- 写真は振り分けの入力でないので、振り分け中に替えても自動振り分けの conflict にしない。ほかの枝は 0002 のまま
create or replace function private.tg_bump_allocation_version()
returns trigger language plpgsql security definer set search_path = '' as $$
begin
  if tg_table_name = 'items' and coalesce(current_setting('app.item_image', true), '') = 'on' then
    return null;
  end if;
  if tg_table_name in ('rooms', 'items', 'distance_overrides') then
    if exists (select 1 from changed_rows) then
      update public.years y set allocation_version = y.allocation_version + 1 where y.status = 'allocating';
    end if;
  elsif tg_table_name in ('requests', 'request_submissions', 'substitution_consents') then
    update public.years y set allocation_version = y.allocation_version + 1
    where y.status = 'allocating'
      and y.id in (select g.year_id from changed_rows c join public.groups g on g.id = c.group_id);
  else
    if tg_table_name = 'allocations' and exists (
         select 1 from changed_rows c join public.years y on y.id = c.year_id where y.status in ('confirmed', 'closed')) then
      perform private.fail('invalid_state', jsonb_build_object('reason', 'confirmed'));
    end if;
    update public.years y set allocation_version = y.allocation_version + 1
    where y.status = 'allocating' and y.id in (select c.year_id from changed_rows c);
  end if;
  return null;
end $$;

------------------------------------------------------------------------
-- Storage：bucket item-images と、storage.objects のポリシー
------------------------------------------------------------------------
-- 非公開の bucket（公開の URL を作らない）。1 枚 1 MiB まで、形は WebP・JPEG だけ（画面が長い辺 1024px に描き直してから上げる）。
-- config.toml の [storage.buckets] は使わず、ここで作る（0016 と同じ。管理画面で先に作っていても、この設定に直す）
insert into storage.buckets (id, name, public, file_size_limit, allowed_mime_types)
values ('item-images', 'item-images', false, 1048576, array['image/webp', 'image/jpeg'])
on conflict (id) do update set name = excluded.name, public = excluded.public,
  file_size_limit = excluded.file_size_limit, allowed_mime_types = excluded.allowed_mime_types;

-- 自分が予約した、期限の切れていない、まだ使っていない予約の path で、今もその段の物（insert のポリシー）。「まだ届いていない」は入れない：
-- 届いた後の2回目は storage.objects の一意の索引で止まり（23505。Storage API は 409）、送り直しを「もう届いていた」と分けられる
create function private.my_item_image_upload_paths()
returns setof text language sql stable security definer set search_path = '' as $$
  select r.object_path from public.item_image_uploads r
  where r.created_by = (select auth.uid()) and r.expires_at > now() and r.used_at is null
    and case when r.item_id is not null then (select private.is_admin_of_open_year())
             else (select private.can_write_stocks_any()) end
$$;

-- 自分が消せる物（delete のポリシー）：bucket item-images の、どの行の image_path にも使われていない物で、1つ目のフォルダの段がある
-- （items は管理者、count-items は在庫を書ける人）。ほかの人の生きた（期限の切れていない、使っていない）予約の物は消せない（上げた直後で
-- set_item_image の前の物を、ほかの人が消さないように）
create function private.my_item_image_orphan_paths()
returns setof text language sql stable security definer set search_path = '' as $$
  select o.name from storage.objects o
  where o.bucket_id = 'item-images'
    and ((split_part(o.name, '/', 1) = 'items' and (select private.is_admin_of_open_year()))
         or (split_part(o.name, '/', 1) = 'count-items' and (select private.can_write_stocks_any())))
    and not exists (select 1 from public.items i where i.image_path = o.name)
    and not exists (select 1 from public.count_items c where c.image_path = o.name)
    and not exists (select 1 from public.item_image_uploads r
                    where r.object_path = o.name and r.created_by is distinct from (select auth.uid())
                      and r.expires_at > now() and r.used_at is null)
$$;

-- ポリシーは bucket item-images の物だけに効く（bucket documents の物は 0016 のポリシーが決める）。anon 向けと update のポリシーは作らない
-- （上書き・移動・upsert はできない。画面の upload は upsert: false）。storage の表の権限（Supabase の既定）は変えない。
-- select（署名つき URL・ダウンロード。Storage API の insert・remove も行を返させるので要る）は、has_any_access を1回だけ呼ぶ形
create policy item_images_objects_select on storage.objects for select to authenticated
  using (bucket_id = 'item-images' and (select private.has_any_access()));
create policy item_images_objects_insert on storage.objects for insert to authenticated
  with check (bucket_id = 'item-images' and name in (select private.my_item_image_upload_paths()));
create policy item_images_objects_delete on storage.objects for delete to authenticated
  using (bucket_id = 'item-images' and name in (select private.my_item_image_orphan_paths()));

-- 書き込みの守り（0016 の documents_objects_guard と同じ考え方。T19-SEC-1）：上のポリシーは、Storage API が呼んだ人の権限で書くときにしか
-- 効かない。署名つきアップロード・service_role の鍵・SQL Editor の postgres は RLS を通らないので、bucket item-images の物の書き込みを
-- storage.objects の行の前のトリガーで確かめる（止めるのは 42501。Storage API は 403）：
--   insert：name が予約の object_path で、期限が切れておらず、まだ使っておらず、予約した人（created_by。呼んだ人でなく）が今もその段
--     （item は終了でない年度のどれかの admin、count_item は終了でない年度のどれかで在庫を書ける）で、metadata の mimetype があれば予約の
--     形と同じ物だけ。detail の reason は not_reserved・expired・used・not_editable・type
--   update：名前・bucket・版・metadata を変える update（上書き・移動。bucket item-images の物から、または物へ）は、いつでも止める（immutable）
--   delete は見ない（delete のポリシーと storage.protect_delete が守る）
-- 予約の行を for share でロックしてから見る（set_item_image・予約し直しと同時でも、終わった後の状態で決まる）。
-- 確かめを飛ばせるのは session_replication_role = replica の間だけ（テストの準備 tests.put_object と手での直しにだけ使う）
create function private.tg_item_images_objects_guard()
returns trigger language plpgsql security definer set search_path = '' as $$
declare
  v_up public.item_image_uploads;
begin
  if tg_op = 'UPDATE' then
    if (old.bucket_id = 'item-images' or new.bucket_id = 'item-images')
       and (new.bucket_id, new.name, new.version, new.metadata) is distinct from (old.bucket_id, old.name, old.version, old.metadata) then
      raise exception using errcode = '42501', message = 'forbidden', detail = '{"reason": "immutable"}';
    end if;
    return new;
  end if;
  if new.bucket_id is distinct from 'item-images' then
    return new;
  end if;

  select * into v_up from public.item_image_uploads r where r.object_path = new.name for share;
  if not found then
    raise exception using errcode = '42501', message = 'forbidden', detail = '{"reason": "not_reserved"}';
  end if;
  if v_up.used_at is not null then
    raise exception using errcode = '42501', message = 'forbidden', detail = '{"reason": "used"}';
  end if;
  if v_up.expires_at <= now() then
    raise exception using errcode = '42501', message = 'forbidden', detail = '{"reason": "expired"}';
  end if;
  if v_up.created_by is null
     or not exists (
       select 1 from public.year_roles yr join public.years y on y.id = yr.year_id
       where yr.user_id = v_up.created_by
         and case when v_up.item_id is not null then yr.role = 'admin' and y.status <> 'closed'
                  else (yr.role in ('admin', 'head', 'deputy_head') and y.status <> 'closed')
                       or (yr.role = 'staff' and y.status in ('preparing', 'requesting')) end) then
    raise exception using errcode = '42501', message = 'forbidden', detail = '{"reason": "not_editable"}';
  end if;
  if new.metadata ? 'mimetype' and new.metadata ->> 'mimetype' is distinct from v_up.content_type then
    raise exception using errcode = '42501', message = 'forbidden', detail = '{"reason": "type"}';
  end if;
  return new;
end $$;
create trigger item_images_objects_guard before insert or update on storage.objects
  for each row execute function private.tg_item_images_objects_guard();

------------------------------------------------------------------------
-- RPC
------------------------------------------------------------------------
-- 共通：SECURITY DEFINER・search_path = ''。最初に段（どちらの段でもなければ forbidden）→ kind（invalid_input）→ kind ごとの段（item は
-- 管理者だけ。forbidden）→ 入力（invalid_input）→ 対象の行（not_found）の順に確かめる。理由は置かない（監査の理由は null）

-- 段と kind を確かめる（forbidden・invalid_input）。RPC の中からだけ呼ぶ
create function private.assert_item_image_tier(p_kind text)
returns void language plpgsql stable security definer set search_path = '' as $$
declare
  v_admin boolean := private.is_admin_of_open_year();
begin
  if not (v_admin or private.can_write_stocks_any()) then
    perform private.fail('forbidden');
  end if;
  if p_kind is null or p_kind not in ('item', 'count_item') then
    perform private.fail('invalid_input', jsonb_build_object('field', 'kind'));
  end if;
  if p_kind = 'item' and not v_admin then
    perform private.fail('forbidden');
  end if;
end $$;

-- 予約の上限を確かめる（reserve_item_image の中から、勧告的ロックを取った後に、新しい予約と予約し直し〔期限の切れた予約を延ばす〕の両方で呼ぶ。
-- p_exclude_id は予約し直しの予約の id で、その行は数えない〔今回の 1 MiB として足す〕）。invalid_state の reason：
--   too_many_reservations：呼んだ人の、行の画像にしていない（used_at が null の）予約のうち、生きている物と、期限が切れても物が Storage に
--     残っている物が 10 個以上（上げて set_item_image を呼ばない物を積み上げて bucket を埋めさせない。物を消せば数えない）
--   too_many_orphans：その対象のフォルダ（items/{id}/・count-items/{id}/）に、行の画像（image_path）でも生きた予約の物でもない物が 3 個以上
--     （画像を替えるたびに前の物を消さずに溜めて bucket を埋めさせない。画面はそのフォルダの、行の画像以外を remove してから1回だけやり直す）
--   storage_full：bucket の合計（届いた物の size ＋ 届いていない生きた予約 × 1 MiB ＋ 今回の 1 MiB）が 100 MiB を超える
create function private.assert_item_image_quota(p_kind text, p_target_id uuid, p_exclude_id uuid)
returns void language plpgsql stable security definer set search_path = '' as $$
declare
  v_current text;
  v_prefix text := case when p_kind = 'item' then 'items/' else 'count-items/' end || p_target_id::text || '/';
begin
  if (select count(*) from public.item_image_uploads r
      where r.created_by = auth.uid() and r.used_at is null and r.id is distinct from p_exclude_id
        and (r.expires_at > now()
             or exists (select 1 from storage.objects o where o.bucket_id = 'item-images' and o.name = r.object_path))) >= 10 then
    perform private.fail('invalid_state', jsonb_build_object('reason', 'too_many_reservations'));
  end if;

  if p_kind = 'item' then
    select i.image_path into v_current from public.items i where i.id = p_target_id;
  else
    select c.image_path into v_current from public.count_items c where c.id = p_target_id;
  end if;
  if (select count(*) from storage.objects o
      where o.bucket_id = 'item-images' and left(o.name, length(v_prefix)) = v_prefix
        and o.name is distinct from v_current
        and not exists (select 1 from public.item_image_uploads r
                        where r.object_path = o.name and r.used_at is null and r.expires_at > now())) >= 3 then
    perform private.fail('invalid_state', jsonb_build_object('reason', 'too_many_orphans'));
  end if;

  if (select coalesce(sum((o.metadata ->> 'size')::bigint), 0) from storage.objects o where o.bucket_id = 'item-images')
     + (select count(*) * 1048576 from public.item_image_uploads r
        where r.expires_at > now() and r.used_at is null and r.id is distinct from p_exclude_id
          and not exists (select 1 from storage.objects o where o.bucket_id = 'item-images' and o.name = r.object_path))
     + 1048576 > 104857600 then
    perform private.fail('invalid_state', jsonb_build_object('reason', 'storage_full'));
  end if;
end $$;

-- reserve_item_image：画像の予約を作り、予約の行（DB が作った object_path を含む）を返す。画面はその path へ Storage API で upload する
-- （upsert: false）。同じ id・同じ中身（kind・対象・形・予約した人）の送り直しは、その行を返す（期限が切れていて、まだ上げておらず、まだ
-- 使っていなければ、新しい予約と同じ上限を確かめてから期限を延ばす〔予約し直し〕）。中身が違えば invalid_input（image_id・in_use）。
-- 上限（private.assert_item_image_quota。新しい予約と予約し直しの両方）：invalid_state の too_many_reservations〔呼んだ人の行の画像にしていない
-- 予約が、生きている物と期限が切れても物が残っている物で 10 個〕・too_many_orphans〔その対象のフォルダに、行の画像でも生きた予約でもない物が
-- 3 個〕・storage_full〔bucket の合計＝届いた物の metadata の size ＋ 届いていない生きた予約 × 1 MiB ＋ 今回の 1 MiB が 100 MiB
-- （104857600 バイト）を超える。bucket documents の 900 MiB と合わせて無料プランの 1 GB を超えない〕。数は勧告的ロックで予約どうしを順にして数える
create function public.reserve_item_image(p_kind text, p_target_id uuid, p_image_id uuid, p_content_type text)
returns public.item_image_uploads language plpgsql security definer set search_path = '' as $$
declare
  v_up public.item_image_uploads;
  v_item_id uuid;
  v_count_item_id uuid;
  v_path text;
begin
  perform private.assert_item_image_tier(p_kind);
  if p_target_id is null then
    perform private.fail('invalid_input', jsonb_build_object('field', 'target_id'));
  end if;
  if p_image_id is null then
    perform private.fail('invalid_input', jsonb_build_object('field', 'image_id'));
  end if;
  if p_content_type is null or p_content_type not in ('image/webp', 'image/jpeg') then
    perform private.fail('invalid_input', jsonb_build_object('field', 'content_type'));
  end if;
  if p_kind = 'item' then
    perform 1 from public.items i where i.id = p_target_id for key share;
    v_item_id := p_target_id;
  else
    perform 1 from public.count_items c where c.id = p_target_id for key share;
    v_count_item_id := p_target_id;
  end if;
  if not found then
    perform private.fail('not_found');
  end if;

  perform pg_advisory_xact_lock(hashtext('gaapp.item_images'), 0);
  select * into v_up from public.item_image_uploads r where r.id = p_image_id for update;
  if found then
    if (v_up.item_id, v_up.count_item_id, v_up.content_type, v_up.created_by)
       is distinct from (v_item_id, v_count_item_id, p_content_type, auth.uid()) then
      perform private.fail('invalid_input', jsonb_build_object('field', 'image_id', 'reason', 'in_use'));
    end if;
    if v_up.used_at is null and v_up.expires_at <= now()
       and not exists (select 1 from storage.objects o where o.bucket_id = 'item-images' and o.name = v_up.object_path) then
      perform private.assert_item_image_quota(p_kind, p_target_id, p_image_id);   -- 予約し直しも新しい予約と同じ上限（2026-11-10 のセキュリティのレビュー）
      update public.item_image_uploads r set expires_at = now() + interval '1 hour' where r.id = p_image_id
      returning * into v_up;
    end if;
    return v_up;                                     -- 送り直し（同じ id・同じ中身）
  end if;

  perform private.assert_item_image_quota(p_kind, p_target_id, null);

  v_path := case when p_kind = 'item' then 'items/' else 'count-items/' end || p_target_id::text || '/' || p_image_id::text || '.'
            || case p_content_type when 'image/webp' then 'webp' else 'jpg' end;
  insert into public.item_image_uploads (id, item_id, count_item_id, object_path, content_type, created_by, expires_at)
  values (p_image_id, v_item_id, v_count_item_id, v_path, p_content_type, auth.uid(), now() + interval '1 hour')
  returning * into v_up;
  return v_up;
exception
  when foreign_key_violation then                    -- 確かめた後に対象の行が消えた
    perform private.fail('not_found');
  when unique_violation then                         -- 同じ id の予約が同時に入った（ほかの中身）
    perform private.fail('invalid_input', jsonb_build_object('field', 'image_id', 'reason', 'in_use'));
end $$;

-- set_item_image：予約して Storage に上げた物を、その行の画像（image_path）にし、前の画像の path（なければ null）を返す（画面はそれを
-- Storage API で消す）。p_image_id が null なら画像を外し、前の path を返す（もう画像がなければ null。行は変えない）。
-- 対象の行は for update でロックする（同時に替えても片方ずつ）。エラー：段・kind（assert_item_image_tier）→ invalid_input（target_id）→
-- not_found → invalid_input（image_id・not_reserved：その kind・対象・呼んだ人の予約でない）→ 使った予約で、行の画像がその物のままなら前と同じ
-- 前の path を返す（送り直し）。もう別の物なら invalid_state（used）→ invalid_state（not_uploaded：Storage に届いていない）。
-- 行の書き込みは app.item_image を立てて行う（トリガー check_image_path を通し、items の版を上げない）
create function public.set_item_image(p_kind text, p_target_id uuid, p_image_id uuid)
returns text language plpgsql security definer set search_path = '' as $$
declare
  v_prev text;
  v_up public.item_image_uploads;
begin
  perform private.assert_item_image_tier(p_kind);
  if p_target_id is null then
    perform private.fail('invalid_input', jsonb_build_object('field', 'target_id'));
  end if;
  if p_kind = 'item' then
    select i.image_path into v_prev from public.items i where i.id = p_target_id for update;
  else
    select c.image_path into v_prev from public.count_items c where c.id = p_target_id for update;
  end if;
  if not found then
    perform private.fail('not_found');
  end if;
  perform private.set_reason(null);

  if p_image_id is null then
    if v_prev is not null then
      perform set_config('app.item_image', 'on', true);
      if p_kind = 'item' then
        update public.items i set image_path = null where i.id = p_target_id;
      else
        update public.count_items c set image_path = null where c.id = p_target_id;
      end if;
      perform set_config('app.item_image', '', true);
    end if;
    return v_prev;
  end if;

  select * into v_up from public.item_image_uploads r
  where r.id = p_image_id and r.created_by = auth.uid()
    and case when p_kind = 'item' then r.item_id = p_target_id else r.count_item_id = p_target_id end
  for update;
  if not found then
    perform private.fail('invalid_input', jsonb_build_object('field', 'image_id', 'reason', 'not_reserved'));
  end if;
  if v_up.used_at is not null then
    if v_prev is not distinct from v_up.object_path then
      return v_up.replaced_path;                     -- 送り直し（もう行の画像にしてある）
    end if;
    perform private.fail('invalid_state', jsonb_build_object('reason', 'used'));
  end if;
  if not exists (select 1 from storage.objects o where o.bucket_id = 'item-images' and o.name = v_up.object_path) then
    perform private.fail('invalid_state', jsonb_build_object('reason', 'not_uploaded'));
  end if;

  perform set_config('app.item_image', 'on', true);
  if p_kind = 'item' then
    update public.items i set image_path = v_up.object_path where i.id = p_target_id;
  else
    update public.count_items c set image_path = v_up.object_path where c.id = p_target_id;
  end if;
  perform set_config('app.item_image', '', true);
  update public.item_image_uploads r set used_at = now(), replaced_path = v_prev where r.id = p_image_id;
  return v_prev;
end $$;

------------------------------------------------------------------------
-- 権限
------------------------------------------------------------------------
-- 表：Supabase の既定の権限（public スキーマの新しい表に anon・authenticated の全部）を外してから、authenticated に select だけ（RPC だけで
-- 書く表。行はポリシーで絞る）。anon と PUBLIC には何も与えない
revoke all on table public.item_image_uploads from public, anon, authenticated;
grant select on table public.item_image_uploads to authenticated;

-- storage.objects のポリシーが呼ぶ集合の関数は authenticated だけが実行できる（0016 と同じ）。段の補助・トリガー関数・RPC の補助は誰も
-- 実行できない（DEFINER の RPC・集合の関数・トリガーから持ち主の権限で呼ぶ）
revoke all on function private.my_item_image_upload_paths(), private.my_item_image_orphan_paths() from public, anon;
grant execute on function private.my_item_image_upload_paths(), private.my_item_image_orphan_paths() to authenticated;
revoke all on function private.can_write_stocks_any(), private.tg_check_image_path(), private.tg_item_images_objects_guard(),
  private.assert_item_image_tier(text), private.assert_item_image_quota(text, uuid, uuid) from public, anon, authenticated;
revoke all on all functions in schema private from public;

-- RPC は 0005 と同じ繰り返しで、authenticated だけが実行できる
do $$
declare f text;
begin
  foreach f in array array[
    'public.reserve_item_image(text, uuid, uuid, text)',
    'public.set_item_image(text, uuid, uuid)'] loop
    execute format('revoke all on function %s from public, anon', f);
    execute format('grant execute on function %s to authenticated', f);
  end loop;
end $$;
