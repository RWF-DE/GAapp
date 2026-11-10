-- 0024_room_photos.sql（T25。2026-11-10。D-63）：現状復帰の写真。表 room_photos と写真の予約の表 room_photo_uploads、判定と集合の関数、
-- Supabase Storage の非公開の bucket room-photos と storage.objects のポリシー3つ・トリガー1つ、RPC reserve_room_photo・add_room_photo・
-- update_room_photo・delete_room_photo・room_photos_with_previous。
-- 教室の現状復帰（祭の後に部屋を元に戻すこと）のために、祭の前の部屋の様子を、年度 × 場所ごとに 6 枚まで写真で残す（1 枚ごとに 50 字までの
-- メモ）。前の年度（prev_year_id）の写真も、今の年度の立場で見られる。
-- 書き込みの道（T23 の品目の画像〔0022〕と同じ「DB が予約してから上げる」形）：
--   予約・写真の行：RPC だけ（2つの表には書き込みの権限を与えない）
--   Storage の物  ：Storage API（画面の upload・remove）。上げられるのは DB が予約した path だけ（storage.objects の insert のポリシーと、
--                   ロールによらず動くトリガー room_photos_objects_guard。署名つきアップロードなど RLS を通らない書き込みも予約で止め、上書き・
--                   移動はいつでも止める）。Storage の物は SQL では消せない（storage.protect_delete）ので、消した写真の物は画面が消す
--                   （delete_room_photo が path を返す）
-- 段：書けるのは、その年度の総務（admin・head・deputy_head・staff）で、年度が終了でないとき（終了なら invalid_state）。
-- 見る人：その年度の総務と、その年度の区分「部門」の団体の代表（店長・副店長＝部門長・副部門長。執行部）と、それらの年度を前の年度とする
-- 年度で見られる人（前の年度の写真）。閲覧のみと、模擬店・企業・休憩所の代表は見られない。
-- 振り分けの入力でないので、版（allocation_version）の増分と確定中の守りは付けない。0016・0022 の bucket documents・item-images の
-- ポリシー・トリガーは変えない（どれも bucket で分かれる）。足すだけで、今の表と関数は変えない。

------------------------------------------------------------------------
-- 表
------------------------------------------------------------------------
-- 写真の予約（RPC だけで書く）。id は画面が作る（reserve_room_photo の p_photo_id。既定値なし。送り直しの鍵。写真の行の id にもなる）。
-- object_path は DB が作り、CHECK で `{year_id}/{room_id}/{id}.{webp|jpg}` に固定する（日本語・名前を入れない）。created_by は予約した人
-- （Storage に上げられるのはこの人だけ）。expires_at は予約から 1 時間（過ぎたら上げられない。同じ id で予約し直せる）。used_at は
-- add_room_photo が写真の行にした日時。年度・場所を消すと予約も消える（Storage の物は使われていない物として残り、画面が消す）
create table public.room_photo_uploads (
  id uuid primary key,
  year_id uuid not null references public.years on delete cascade,
  room_id uuid not null references public.rooms on delete cascade,
  object_path text not null,
  content_type text not null,
  created_by uuid references auth.users on delete set null,
  expires_at timestamptz not null,
  used_at timestamptz,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  constraint room_photo_uploads_object_path_key unique (object_path),
  constraint room_photo_uploads_content_type_check check (content_type in ('image/webp', 'image/jpeg')),
  constraint room_photo_uploads_object_path_check check (object_path =
    year_id::text || '/' || room_id::text || '/' || id::text || '.' || case content_type when 'image/webp' then 'webp' else 'jpg' end)
);
create index room_photo_uploads_year_id_idx on public.room_photo_uploads (year_id);
create index room_photo_uploads_room_id_idx on public.room_photo_uploads (room_id);
create index room_photo_uploads_created_by_idx on public.room_photo_uploads (created_by);

-- 部屋の写真（RPC だけで書く）。id は予約の id。object_path は予約の path（CHECK で、その行の年度・場所・id のフォルダと名前、webp か jpg に
-- 固定する）。memo は 50 字まで（空でもよい）、制御文字（改行を含む）は入れない。sort_order は 0〜1000（同じ年度・場所の中の並び）。
-- 場所への参照は restrict（場所への参照の決まり。写真のある場所は消せない）。年度を消すと写真の行も消える（物は残る）
create table public.room_photos (
  id uuid primary key,
  year_id uuid not null references public.years on delete cascade,
  room_id uuid not null references public.rooms on delete restrict,
  object_path text not null,
  memo text not null default '',
  sort_order integer not null,
  created_by uuid references auth.users on delete set null,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  constraint room_photos_object_path_key unique (object_path),
  constraint room_photos_object_path_check check (object_path ~ (
    '^' || year_id::text || '/' || room_id::text || '/' || id::text || '\.(webp|jpg)$')),
  constraint room_photos_memo_check check (char_length(memo) <= 50 and memo !~ '[[:cntrl:]]'),
  constraint room_photos_sort_order_check check (sort_order between 0 and 1000)
);
create index room_photos_year_room_idx on public.room_photos (year_id, room_id, sort_order);
create index room_photos_room_id_idx on public.room_photos (room_id);
create index room_photos_created_by_idx on public.room_photos (created_by);

alter table public.room_photo_uploads enable row level security;
alter table public.room_photos enable row level security;

-- 日時（0002 の共通の関数）
create trigger set_timestamps before insert or update on public.room_photo_uploads
  for each row execute function private.tg_set_timestamps();
create trigger set_timestamps before insert or update on public.room_photos
  for each row execute function private.tg_set_timestamps();
-- 年度・場所・path の付け替えを止める（D-16。0002 の tg_immutable_columns。invalid_input）
create trigger check_immutable before update of year_id, room_id, object_path on public.room_photos
  for each row execute function private.tg_immutable_columns('year_id', 'room_id', 'object_path');
-- 監査（D-11）：写真の行だけ（year_id は行から、group_id は null）。予約の表は監査しない（手順の途中の記録。使った物は写真の追加として残る）
create trigger audit after insert or update or delete on public.room_photos
  for each row execute function private.tg_audit('id');

-- 1 部屋 6 枚：年度と場所ごとの勧告的ロックを取ってから数え、もう 6 枚あれば invalid_state（reason: too_many_photos）。他の表を参照する
-- CHECK は使わない決まりなので、トリガーで確かめる（自分の表を数えるだけでも、同時の insert を順にするためにロックが要る）。
-- 書けるのは RPC と postgres だけ（表に書き込みの権限がない）。private.fail を呼ぶので SECURITY DEFINER
create function private.tg_room_photos_check_limit()
returns trigger language plpgsql security definer set search_path = '' as $$
begin
  perform pg_advisory_xact_lock(hashtext('gaapp.room_photos'), hashtext(new.year_id::text || '/' || new.room_id::text));
  if (select count(*) from public.room_photos p where p.year_id = new.year_id and p.room_id = new.room_id) >= 6 then
    perform private.fail('invalid_state', jsonb_build_object('reason', 'too_many_photos'));
  end if;
  return new;
end $$;
create trigger check_photo_limit before insert on public.room_photos
  for each row execute function private.tg_room_photos_check_limit();

------------------------------------------------------------------------
-- 判定と集合の関数
------------------------------------------------------------------------
-- 見られる：その年度の総務か、その年度の区分「部門」の団体の代表（店長・副店長のどちらも）。呼んだ人（auth.uid()）についてだけ答える。
-- RPC の中からだけ呼ぶので、誰にも execute を与えない
create function private.can_see_room_photos(p_year_id uuid)
returns boolean language sql stable security definer set search_path = '' as $$
  select private.has_any_role(p_year_id, '{admin,head,deputy_head,staff}')
         or exists (select 1 from public.group_members gm join public.groups g on g.id = gm.group_id
                    where gm.user_id = (select auth.uid()) and g.year_id = p_year_id and g.category = 'department')
$$;

-- 書ける段：その年度の総務（年度の状態は見ない。終了は RPC が invalid_state にする）。RPC の中からだけ呼ぶ
create function private.can_write_room_photos(p_year_id uuid)
returns boolean language sql stable security definer set search_path = '' as $$
  select private.has_any_role(p_year_id, '{admin,head,deputy_head,staff}')
$$;

-- 見られる年度の集合（room_photos と bucket room-photos の select のポリシー。D-47 の形で問い合わせごとに1回だけ作る）：
-- can_see_room_photos が真の年度（総務のロールの年度と、部門の団体の代表である年度）と、その prev_year_id の年度（1つ前だけ）
create function private.room_photo_year_ids()
returns setof uuid language sql stable security definer set search_path = '' as $$
  with seen as (
    select yr.year_id from public.year_roles yr
    where yr.user_id = (select auth.uid()) and yr.role in ('admin', 'head', 'deputy_head', 'staff')
    union
    select g.year_id from public.group_members gm join public.groups g on g.id = gm.group_id
    where gm.user_id = (select auth.uid()) and g.category = 'department')
  select s.year_id from seen s
  union
  select y.prev_year_id from public.years y join seen s on s.year_id = y.id where y.prev_year_id is not null
$$;

-- 自分が予約した、期限の切れていない、まだ使っていない予約の path で、今もその年度の総務で、年度が終了でない物（insert のポリシー）。
-- 「まだ届いていない」は入れない：届いた後の2回目は storage.objects の一意の索引で止まり（23505。Storage API は 409）、送り直しを分けられる
create function private.my_room_photo_upload_paths()
returns setof text language sql stable security definer set search_path = '' as $$
  select r.object_path from public.room_photo_uploads r join public.years y on y.id = r.year_id
  where r.created_by = (select auth.uid()) and r.expires_at > now() and r.used_at is null
    and y.status <> 'closed' and private.can_write_room_photos(r.year_id)
$$;

-- 自分が消せる物（delete のポリシー）：bucket room-photos の、1つ目のフォルダが自分が総務で終了でない年度で、どの写真の行にも使われて
-- いない物。ほかの人の生きた（期限の切れていない、使っていない）予約の物は消せない（上げた直後で add の前の物を、ほかの人が消さないように）
create function private.my_room_photo_orphan_paths()
returns setof text language sql stable security definer set search_path = '' as $$
  select o.name from storage.objects o
  where o.bucket_id = 'room-photos'
    and split_part(o.name, '/', 1) in (
      select yr.year_id::text from public.year_roles yr join public.years y on y.id = yr.year_id
      where yr.user_id = (select auth.uid()) and yr.role in ('admin', 'head', 'deputy_head', 'staff') and y.status <> 'closed')
    and not exists (select 1 from public.room_photos p where p.object_path = o.name)
    and not exists (select 1 from public.room_photo_uploads r
                    where r.object_path = o.name and r.created_by is distinct from (select auth.uid())
                      and r.expires_at > now() and r.used_at is null)
$$;

------------------------------------------------------------------------
-- RLS（select だけ。書き込みは RPC）
------------------------------------------------------------------------
create policy room_photos_select on public.room_photos for select to authenticated
  using (year_id in (select private.room_photo_year_ids()));
-- 予約の行は予約した人だけが読む（画面は RPC の返り値を使い、送り直しや片付けのときに読み直す）
create policy room_photo_uploads_select on public.room_photo_uploads for select to authenticated
  using (created_by = (select auth.uid()));

------------------------------------------------------------------------
-- Storage：bucket room-photos と、storage.objects のポリシー・トリガー
------------------------------------------------------------------------
-- 非公開の bucket（公開の URL を作らない）。1 枚 1 MiB まで、形は WebP・JPEG だけ（画面が長い辺 1600px に描き直してから上げる）。
-- config.toml の [storage.buckets] は使わず、ここで作る（0016・0022 と同じ。管理画面で先に作っていても、この設定に直す）
insert into storage.buckets (id, name, public, file_size_limit, allowed_mime_types)
values ('room-photos', 'room-photos', false, 1048576, array['image/webp', 'image/jpeg'])
on conflict (id) do update set name = excluded.name, public = excluded.public,
  file_size_limit = excluded.file_size_limit, allowed_mime_types = excluded.allowed_mime_types;

-- ポリシーは bucket room-photos の物だけに効く。anon 向けと update のポリシーは作らない（上書き・移動・upsert はできない。画面の upload は
-- upsert: false）。storage の表の権限（Supabase の既定）は変えない。select は1つ目のフォルダ（年度）を、見られる年度の集合と比べる
-- （行ごとには組み込みの split_part だけを呼ぶ。Storage API の insert・remove も行を返させるので、書く人〔総務〕も見られる必要がある）
create policy room_photos_objects_select on storage.objects for select to authenticated
  using (bucket_id = 'room-photos' and split_part(name, '/', 1) in (select y::text from private.room_photo_year_ids() as y));
create policy room_photos_objects_insert on storage.objects for insert to authenticated
  with check (bucket_id = 'room-photos' and name in (select private.my_room_photo_upload_paths()));
create policy room_photos_objects_delete on storage.objects for delete to authenticated
  using (bucket_id = 'room-photos' and name in (select private.my_room_photo_orphan_paths()));

-- 書き込みの守り（0022 の item_images_objects_guard と同じ考え方）：上のポリシーは、Storage API が呼んだ人の権限で書くときにしか効かない。
-- 署名つきアップロード・service_role の鍵・SQL Editor の postgres は RLS を通らないので、bucket room-photos の物の書き込みを
-- storage.objects の行の前のトリガーで確かめる（止めるのは 42501。Storage API は 403）：
--   insert：name が予約の object_path で、期限が切れておらず、まだ使っておらず、予約した人（created_by。呼んだ人でなく）が今もその年度の
--     総務で、年度が終了でなく、metadata の mimetype があれば予約の形と同じ物だけ。detail の reason は not_reserved・expired・used・
--     not_editable・type
--   update：名前・bucket・版・metadata を変える update（上書き・移動。bucket room-photos の物から、または物へ）は、いつでも止める（immutable）
--   delete は見ない（delete のポリシーと storage.protect_delete が守る）
-- 予約の行を for share でロックしてから見る（add_room_photo・予約し直しと同時でも、終わった後の状態で決まる）。
-- 確かめを飛ばせるのは session_replication_role = replica の間だけ（テストの準備 tests.put_object と手での直しにだけ使う）
create function private.tg_room_photos_objects_guard()
returns trigger language plpgsql security definer set search_path = '' as $$
declare
  v_up public.room_photo_uploads;
begin
  if tg_op = 'UPDATE' then
    if (old.bucket_id = 'room-photos' or new.bucket_id = 'room-photos')
       and (new.bucket_id, new.name, new.version, new.metadata) is distinct from (old.bucket_id, old.name, old.version, old.metadata) then
      raise exception using errcode = '42501', message = 'forbidden', detail = '{"reason": "immutable"}';
    end if;
    return new;
  end if;
  if new.bucket_id is distinct from 'room-photos' then
    return new;
  end if;

  select * into v_up from public.room_photo_uploads r where r.object_path = new.name for share;
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
       where yr.user_id = v_up.created_by and yr.year_id = v_up.year_id
         and yr.role in ('admin', 'head', 'deputy_head', 'staff') and y.status <> 'closed') then
    raise exception using errcode = '42501', message = 'forbidden', detail = '{"reason": "not_editable"}';
  end if;
  if new.metadata ? 'mimetype' and new.metadata ->> 'mimetype' is distinct from v_up.content_type then
    raise exception using errcode = '42501', message = 'forbidden', detail = '{"reason": "type"}';
  end if;
  return new;
end $$;
create trigger room_photos_objects_guard before insert or update on storage.objects
  for each row execute function private.tg_room_photos_objects_guard();

------------------------------------------------------------------------
-- RPC の補助
------------------------------------------------------------------------
-- ロール → 年度の行を for share → ロールをもう一度（待つ間に外されたとき）→ 終了なら invalid_state（detail は status）。
-- 0016 の lock_document_year と同じ形。年度が null・ない年度は forbidden
create function private.lock_room_photo_year(p_year_id uuid)
returns void language plpgsql security definer set search_path = '' as $$
declare v_status public.year_status;
begin
  if p_year_id is null or not private.can_write_room_photos(p_year_id) then
    perform private.fail('forbidden');
  end if;
  select y.status into v_status from public.years y where y.id = p_year_id for share;
  if not found or not private.can_write_room_photos(p_year_id) then
    perform private.fail('forbidden');
  end if;
  if v_status = 'closed' then
    perform private.fail('invalid_state', jsonb_build_object('status', v_status));
  end if;
end $$;

-- 予約の上限を確かめる（reserve_room_photo の中から、勧告的ロックを取った後に、新しい予約と予約し直しの両方で呼ぶ。p_exclude_id は
-- 予約し直しの予約の id で、その行は数えない〔今回の 1 MiB として足す〕）。invalid_state の reason：
--   too_many_photos：その年度・場所の写真がもう 6 枚
--   too_many_reservations：呼んだ人の、写真にしていない予約のうち、生きている物と、期限が切れても物が Storage に残っている物が 10 個以上
--   too_many_orphans：その年度・場所のフォルダ（{year_id}/{room_id}/）に、写真の行でも生きた予約の物でもない物が 3 個以上
--   storage_full：bucket の合計（届いた物の size ＋ 届いていない生きた予約 × 1 MiB ＋ 今回の 1 MiB）が 800 MiB（838860800 バイト）を超える
create function private.assert_room_photo_quota(p_year_id uuid, p_room_id uuid, p_exclude_id uuid)
returns void language plpgsql stable security definer set search_path = '' as $$
declare
  v_prefix text := p_year_id::text || '/' || p_room_id::text || '/';
begin
  if (select count(*) from public.room_photos p where p.year_id = p_year_id and p.room_id = p_room_id) >= 6 then
    perform private.fail('invalid_state', jsonb_build_object('reason', 'too_many_photos'));
  end if;

  if (select count(*) from public.room_photo_uploads r
      where r.created_by = auth.uid() and r.used_at is null and r.id is distinct from p_exclude_id
        and (r.expires_at > now()
             or exists (select 1 from storage.objects o where o.bucket_id = 'room-photos' and o.name = r.object_path))) >= 10 then
    perform private.fail('invalid_state', jsonb_build_object('reason', 'too_many_reservations'));
  end if;

  if (select count(*) from storage.objects o
      where o.bucket_id = 'room-photos' and left(o.name, length(v_prefix)) = v_prefix
        and not exists (select 1 from public.room_photos p where p.object_path = o.name)
        and not exists (select 1 from public.room_photo_uploads r
                        where r.object_path = o.name and r.used_at is null and r.expires_at > now())) >= 3 then
    perform private.fail('invalid_state', jsonb_build_object('reason', 'too_many_orphans'));
  end if;

  if (select coalesce(sum((o.metadata ->> 'size')::bigint), 0) from storage.objects o where o.bucket_id = 'room-photos')
     + (select count(*) * 1048576 from public.room_photo_uploads r
        where r.expires_at > now() and r.used_at is null and r.id is distinct from p_exclude_id
          and not exists (select 1 from storage.objects o where o.bucket_id = 'room-photos' and o.name = r.object_path))
     + 1048576 > 838860800 then
    perform private.fail('invalid_state', jsonb_build_object('reason', 'storage_full'));
  end if;
end $$;

------------------------------------------------------------------------
-- RPC
------------------------------------------------------------------------
-- 共通：SECURITY DEFINER・search_path = ''。最初にロール（forbidden）、年度の状態（invalid_state）、入力（invalid_input）、行（not_found）の
-- 順に確かめる。理由は置かない（監査の理由は null）

-- reserve_room_photo：写真の予約を作り、予約の行（DB が作った object_path を含む）を返す。画面はその path へ Storage API で upload する
-- （upsert: false）。同じ id・同じ中身（年度・場所・形・予約した人）の送り直しは、その行を返す（期限が切れていて、まだ上げておらず、まだ
-- 使っていなければ、新しい予約と同じ上限を確かめてから期限を延ばす〔予約し直し〕）。中身が違えば invalid_input（photo_id・in_use）。
-- 上限は private.assert_room_photo_quota。数は勧告的ロックで予約どうしを順にして数える
create function public.reserve_room_photo(p_year_id uuid, p_room_id uuid, p_photo_id uuid, p_content_type text)
returns public.room_photo_uploads language plpgsql security definer set search_path = '' as $$
declare
  v_up public.room_photo_uploads;
  v_path text;
begin
  perform private.lock_room_photo_year(p_year_id);
  if p_room_id is null then
    perform private.fail('invalid_input', jsonb_build_object('field', 'room_id'));
  end if;
  if p_photo_id is null then
    perform private.fail('invalid_input', jsonb_build_object('field', 'photo_id'));
  end if;
  if p_content_type is null or p_content_type not in ('image/webp', 'image/jpeg') then
    perform private.fail('invalid_input', jsonb_build_object('field', 'content_type'));
  end if;
  perform 1 from public.rooms r where r.id = p_room_id for key share;
  if not found then
    perform private.fail('not_found');
  end if;

  perform pg_advisory_xact_lock(hashtext('gaapp.room_photo_uploads'), 0);
  select * into v_up from public.room_photo_uploads r where r.id = p_photo_id for update;
  if found then
    if (v_up.year_id, v_up.room_id, v_up.content_type, v_up.created_by)
       is distinct from (p_year_id, p_room_id, p_content_type, auth.uid()) then
      perform private.fail('invalid_input', jsonb_build_object('field', 'photo_id', 'reason', 'in_use'));
    end if;
    if v_up.used_at is null and v_up.expires_at <= now()
       and not exists (select 1 from storage.objects o where o.bucket_id = 'room-photos' and o.name = v_up.object_path) then
      perform private.assert_room_photo_quota(p_year_id, p_room_id, p_photo_id);   -- 予約し直しも新しい予約と同じ上限
      update public.room_photo_uploads r set expires_at = now() + interval '1 hour' where r.id = p_photo_id
      returning * into v_up;
    end if;
    return v_up;                                     -- 送り直し（同じ id・同じ中身）
  end if;

  perform private.assert_room_photo_quota(p_year_id, p_room_id, null);

  v_path := p_year_id::text || '/' || p_room_id::text || '/' || p_photo_id::text || '.'
            || case p_content_type when 'image/webp' then 'webp' else 'jpg' end;
  insert into public.room_photo_uploads (id, year_id, room_id, object_path, content_type, created_by, expires_at)
  values (p_photo_id, p_year_id, p_room_id, v_path, p_content_type, auth.uid(), now() + interval '1 hour')
  returning * into v_up;
  return v_up;
exception
  when foreign_key_violation then                    -- 確かめた後に場所が消えた
    perform private.fail('not_found');
  when unique_violation then                         -- 同じ id の予約が同時に入った（ほかの中身）
    perform private.fail('invalid_input', jsonb_build_object('field', 'photo_id', 'reason', 'in_use'));
end $$;

-- add_room_photo：予約して Storage に上げた物を写真の行にし、その行を返す。並びはその年度・場所の今の最大＋1（最初は 0）。メモは null なら空。
-- エラーの順：forbidden（予約の年度の総務でない。予約がなく、どの年度の総務でもない）→ invalid_state（終了の年度）→ invalid_input（photo_id・
-- not_reserved：呼んだ人の予約でない）→ invalid_input（memo：51 字以上・制御文字）→ 使った予約で写真の行がまだあればその行を返す（送り直し。
-- メモは変えない）→ invalid_state（used：もう消した写真の予約、not_uploaded：まだ届いていない）→ 6 枚の上限（トリガー。too_many_photos）。
-- add は予約の期限を見ない（物が先に届いた期限切れの予約も写真にできる）
create function public.add_room_photo(p_photo_id uuid, p_memo text)
returns public.room_photos language plpgsql security definer set search_path = '' as $$
declare
  v_up public.room_photo_uploads;
  v_row public.room_photos;
  v_memo text := coalesce(p_memo, '');
begin
  select * into v_up from public.room_photo_uploads r where r.id = p_photo_id;
  if not found then
    if exists (select 1 from public.year_roles yr where yr.user_id = auth.uid() and yr.role in ('admin', 'head', 'deputy_head', 'staff')) then
      perform private.fail('invalid_input', jsonb_build_object('field', 'photo_id', 'reason', 'not_reserved'));
    end if;
    perform private.fail('forbidden');
  end if;
  perform private.lock_room_photo_year(v_up.year_id);
  select * into v_up from public.room_photo_uploads r where r.id = p_photo_id for update;
  if not found or v_up.created_by is distinct from auth.uid() then
    perform private.fail('invalid_input', jsonb_build_object('field', 'photo_id', 'reason', 'not_reserved'));
  end if;
  if char_length(v_memo) > 50 or v_memo ~ '[[:cntrl:]]' then
    perform private.fail('invalid_input', jsonb_build_object('field', 'memo'));
  end if;
  if v_up.used_at is not null then
    select * into v_row from public.room_photos p where p.id = p_photo_id;
    if found then
      return v_row;                                  -- 送り直し（もう写真にしてある）
    end if;
    perform private.fail('invalid_state', jsonb_build_object('reason', 'used'));
  end if;
  if not exists (select 1 from storage.objects o where o.bucket_id = 'room-photos' and o.name = v_up.object_path) then
    perform private.fail('invalid_state', jsonb_build_object('reason', 'not_uploaded'));
  end if;

  perform private.set_reason(null);
  -- 6 枚の上限はトリガーが同じロックを取って数える。並びの最大はロックの後に読む（同時に足しても同じ並びにならないように、先にロックを取る）
  perform pg_advisory_xact_lock(hashtext('gaapp.room_photos'), hashtext(v_up.year_id::text || '/' || v_up.room_id::text));
  insert into public.room_photos (id, year_id, room_id, object_path, memo, sort_order, created_by)
  values (v_up.id, v_up.year_id, v_up.room_id, v_up.object_path, v_memo,
          least(coalesce((select max(p.sort_order) + 1 from public.room_photos p
                          where p.year_id = v_up.year_id and p.room_id = v_up.room_id), 0), 1000),
          auth.uid())
  returning * into v_row;
  update public.room_photo_uploads r set used_at = now() where r.id = p_photo_id;
  return v_row;
end $$;

-- 写真の行を読んで、段と年度を確かめる（update_room_photo・delete_room_photo の補助。行を for update でロックして返す）。
-- 写真がない：どの年度の総務でもなければ forbidden、そうなら not_found（有無を漏らさない）。写真の年度の総務でない：forbidden。
-- 終了の年度：invalid_state
create function private.lock_room_photo(p_photo_id uuid)
returns public.room_photos language plpgsql security definer set search_path = '' as $$
declare
  v_row public.room_photos;
begin
  select * into v_row from public.room_photos p where p.id = p_photo_id;
  if not found then
    if exists (select 1 from public.year_roles yr where yr.user_id = auth.uid() and yr.role in ('admin', 'head', 'deputy_head', 'staff')) then
      perform private.fail('not_found');
    end if;
    perform private.fail('forbidden');
  end if;
  perform private.lock_room_photo_year(v_row.year_id);
  select * into v_row from public.room_photos p where p.id = p_photo_id for update;
  if not found then
    perform private.fail('not_found');
  end if;
  return v_row;
end $$;

-- update_room_photo：写真のメモと並び（0〜1000）を変え、変えた行を返す。null の引数は変えない。エラーの順は lock_room_photo の後に
-- invalid_input（memo・sort_order）
create function public.update_room_photo(p_photo_id uuid, p_memo text, p_sort_order integer)
returns public.room_photos language plpgsql security definer set search_path = '' as $$
declare
  v_row public.room_photos;
begin
  v_row := private.lock_room_photo(p_photo_id);
  if p_memo is not null and (char_length(p_memo) > 50 or p_memo ~ '[[:cntrl:]]') then
    perform private.fail('invalid_input', jsonb_build_object('field', 'memo'));
  end if;
  if p_sort_order is not null and p_sort_order not between 0 and 1000 then
    perform private.fail('invalid_input', jsonb_build_object('field', 'sort_order'));
  end if;
  perform private.set_reason(null);
  update public.room_photos p set memo = coalesce(p_memo, p.memo), sort_order = coalesce(p_sort_order, p.sort_order)
  where p.id = p_photo_id
  returning * into v_row;
  return v_row;
end $$;

-- delete_room_photo：写真の行を消し、object_path を返す（画面がそれを Storage API で remove する。物は「どの写真にも使われていない物」になり、
-- その年度の総務が消せる）。エラーの順は lock_room_photo と同じ
create function public.delete_room_photo(p_photo_id uuid)
returns text language plpgsql security definer set search_path = '' as $$
declare
  v_row public.room_photos;
begin
  v_row := private.lock_room_photo(p_photo_id);
  perform private.set_reason(null);
  delete from public.room_photos p where p.id = p_photo_id;
  return v_row.object_path;
end $$;

-- room_photos_with_previous：その年度で写真を見られる人（can_see_room_photos）にだけ、その年度と前の年度（prev_year_id）の、その場所
-- （room_id が null なら全部の場所）の写真の行を返す（今の年度が先、場所、並び、足した日時、id の順）。見られなければ 0 行（エラーにしない）。
-- 前の年度にロールや代表の立場がなくても、前の年度の行を返す（今の年度の立場で読む）
create function public.room_photos_with_previous(p_year_id uuid, p_room_id uuid)
returns setof public.room_photos language sql stable security definer set search_path = '' as $$
  select p.* from public.years y
  join public.room_photos p on p.year_id = y.id or p.year_id = y.prev_year_id
  where y.id = p_year_id and private.can_see_room_photos(p_year_id)
    and (p_room_id is null or p.room_id = p_room_id)
  order by (p.year_id = y.id) desc, p.room_id, p.sort_order, p.created_at, p.id
$$;

------------------------------------------------------------------------
-- 権限
------------------------------------------------------------------------
-- 表：Supabase の既定の権限（public スキーマの新しい表に anon・authenticated の全部）を外してから、authenticated に select だけ（RPC だけで
-- 書く表。行はポリシーで絞る）。anon と PUBLIC には何も与えない
revoke all on table public.room_photos, public.room_photo_uploads from public, anon, authenticated;
grant select on table public.room_photos, public.room_photo_uploads to authenticated;

-- ポリシーが呼ぶ集合の関数は authenticated だけが実行できる（0016・0022 と同じ）。判定・段・ロック・上限の補助とトリガー関数は誰も
-- 実行できない（DEFINER の RPC・集合の関数・トリガーから持ち主の権限で呼ぶ）
revoke all on function private.room_photo_year_ids(), private.my_room_photo_upload_paths(), private.my_room_photo_orphan_paths() from public, anon;
grant execute on function private.room_photo_year_ids(), private.my_room_photo_upload_paths(), private.my_room_photo_orphan_paths() to authenticated;
revoke all on function private.can_see_room_photos(uuid), private.can_write_room_photos(uuid), private.lock_room_photo_year(uuid),
  private.lock_room_photo(uuid), private.assert_room_photo_quota(uuid, uuid, uuid),
  private.tg_room_photos_check_limit(), private.tg_room_photos_objects_guard() from public, anon, authenticated;
revoke all on all functions in schema private from public;

-- RPC は 0005 と同じ繰り返しで、authenticated だけが実行できる
do $$
declare f text;
begin
  foreach f in array array[
    'public.reserve_room_photo(uuid, uuid, uuid, text)',
    'public.add_room_photo(uuid, text)',
    'public.update_room_photo(uuid, text, integer)',
    'public.delete_room_photo(uuid)',
    'public.room_photos_with_previous(uuid, uuid)'] loop
    execute format('revoke all on function %s from public, anon', f);
    execute format('grant execute on function %s to authenticated', f);
  end loop;
end $$;
