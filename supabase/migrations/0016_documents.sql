-- 0016_documents.sql（T19 のパート A。2026-11-01。D-55）：提出物（documents）・提出（document_submissions）・提出物のファイル
-- （document_files）の表・ビュー・トリガー・RLS・RPC と、Supabase Storage の非公開の bucket documents と storage.objects のポリシー
-- 提出物は総務アプリの機能の1つ（D-51・D-52。機能の id は documents）。年度ごとに部門長以上が提出物（団体が出す書類の種類と締切）を
-- 登録し、団体の店長・副店長（と、代わりに出す部門長以上）がファイルを上げて「提出した」を押し、部門長以上が承認か差し戻しをする。
-- 書き込みの道：
--   提出物（documents）：画面から直接（RLS の can_lead）。理由の要らない、1つの表だけの書き込みなので RPC にしない（締切と予定と同じ）
--   提出・ファイル      ：RPC だけ（表には書き込みの権限を与えない）。状態の移り方・ファイルの数と容量・理由を同じトランザクションで
--                         確かめ、提出とファイルを1回で変えるため（CLAUDE.md の設計上の約束）
--   Storage の物        ：Storage API（画面の upload・remove）。上げられるのは DB が予約した path だけ（storage.objects の insert の
--                         ポリシーと、ロールによらず動くトリガー documents_objects_guard。署名つきアップロードなど RLS を通らない
--                         書き込みも、予約と提出の状態で止め、上書き・移動はいつでも止める。T19 のレビューの T19-SEC-1）。Storage の物は
--                         SQL では消せない（storage.protect_delete）ので、DB の行を消した物は「どの提出にも属さないファイル」として残り、
--                         画面が消す（document_orphan_paths が消せる path を返す）
-- 読める人（Q4・Q5）：部門長以上はその年度の全部（ファイルを含む）、総務部門員は提出物と提出の状況だけ（ファイルは読めない）、
-- 店長・副店長は自団体が対象の提出物と自団体の提出・ファイル、閲覧のみ・未招待は何も読めない。読み取りは年度の状態によらない。
-- 終了（closed）の年度は読むだけ（例外は、管理者がファイルの行を全部消す delete_year_document_files だけ。Q3）。振り分けの入力で
-- ないので、版（allocation_version）を増やさず、確定中の守りもない（確定中も書ける）。年度の複製（create_year_from）は写さない。
-- 細部（RPC のエラーの順・ロックの順・判断したこと）は notes/T19.md の「SQL の約束」。画面は T19 のパート B。
-- storage のスキーマ（storage.buckets・storage.objects と、その権限・トリガー）は Supabase のもの（CLI は DB を作るときに storage-api の
-- マイグレーションを流す。本番にもある）。ここでは bucket の行とポリシー3つとトリガー1つを足すだけで、storage の表・関数・既定の権限は
-- 変えない（トリガーの関数は private に置く）。
-- 0014 の private.my_group_year_ids を使うので 0014 の後（0015 の次）に当てる。足すだけで、今の表・関数・ポリシーは変えない。

------------------------------------------------------------------------
-- 列挙型と表
------------------------------------------------------------------------
-- 提出の状態。表示名は 未提出 / 提出済み（画面の絞り込みでは「承認待ち」）/ 差し戻し / 承認
create type public.document_status as enum ('not_submitted', 'submitted', 'returned', 'approved');

-- 提出物（年度ごとの書類の種類と締切）。部門長以上が画面から直接書く（下の書き込みのポリシー）。
-- 題名は前後の空白を除いた形で 1〜100 字（notices・events の題名と同じ式。除く空白は JavaScript の trim が除く 25 文字）。書き込みを
-- RPC にしないので DB では除かず、前後に空白のある題名と空白だけの題名を拒む（23514）。画面は zod の trim を通してから送る。
-- 説明は任意で 2000 字まで（空なら画面が null にする。D-33）。締切の日付（Asia/Tokyo）は 2000-01-01〜2200-12-31（events と同じ。
-- infinity や JavaScript の Date で扱えない日時を入れさせない）。
-- 対象の区分は 1〜4 個で null の要素は不可（重なりは下の normalize_target_categories が除いて、列挙の順に並べる）。
-- food_only は飲食の団体（groups.is_food）だけに出す（Q8）。requires_file は「提出した」にファイルが1つ以上要る（Q7。既定はオン）。
-- files_deleted_at は年度のファイルを削除した日時で、delete_year_document_files だけが入れる（下の set_actor が直接の書き込みでは
-- 元に戻す。Q3）。書いた人・直した人と日時は DB が入れる（set_actor・set_timestamps）。
-- unique (id, year_id) は提出の複合外部キーの参照先（提出物と団体が同じ年度であることを保証する。notices と同じ）
create table public.documents (
  id uuid primary key default gen_random_uuid(),
  year_id uuid not null references public.years on delete cascade,
  title text not null,
  description text,
  deadline timestamptz not null,
  target_categories public.group_category[] not null,
  food_only boolean not null default false,
  requires_file boolean not null default true,
  files_deleted_at timestamptz,
  created_by uuid references auth.users on delete set null,
  updated_by uuid references auth.users on delete set null,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  constraint documents_title_check check (title <> ''
    and title = btrim(title, E'\t\n\u000b\f\r \u00a0\u1680\u2000\u2001\u2002\u2003\u2004\u2005\u2006\u2007\u2008\u2009\u200a\u2028\u2029\u202f\u205f\u3000\ufeff')
    and length(title) <= 100),
  constraint documents_description_check check (length(description) <= 2000),
  constraint documents_deadline_check check (
    (deadline at time zone 'Asia/Tokyo')::date between date '2000-01-01' and date '2200-12-31'),
  constraint documents_target_categories_check check (
    cardinality(target_categories) between 1 and 4 and array_position(target_categories, null) is null),
  constraint documents_year_id_title_key unique (year_id, title),
  constraint documents_id_year_id_key unique (id, year_id)
);
-- 年度ごとの一覧（締切の順）と、ポリシーの year_id in (…) 用
create index documents_year_id_idx on public.documents (year_id, deadline);

-- 提出（団体×提出物で1行。最初の操作〔予約・提出・承認〕で RPC が作る。行がなければ未提出）。RPC だけで書く。
-- 複合外部キーで、提出物・団体と同じ年度に縛る（allocations・notice_groups と同じ）。提出物・団体・年度を消すと行も消える。
-- submitted_at は最後に「提出した」を押した日時（未提出と、紙などで受け取った承認では null）、proxy は部門長以上が代わりに
-- 提出した印（Q9）、reviewed_at・reviewed_by・review_note は最後の承認・差し戻し（review_note は差し戻しの理由か承認のメモ）。
-- review_note は RPC が前後の空白（題名と同じ 25 文字）を除いてから入れ、CHECK は除いた形で 1〜1000 字であることを確かめる。
-- 状態の CHECK は同じ行の列だけで状態と列をそろえる（RPC だけで書くが、SQL Editor の誤りも止める。*_by は set null で消えるので
-- 見ない）：未提出は提出の日時も代理もなし、提出済みは提出の日時あり、差し戻しは確かめた日時と理由あり、承認は確かめた日時あり、
-- 代理なら提出の日時あり。unique (document_id, group_id, year_id) はファイルの複合外部キーの参照先
create table public.document_submissions (
  document_id uuid not null,
  group_id uuid not null,
  year_id uuid not null,
  status public.document_status not null default 'not_submitted',
  submitted_at timestamptz,
  submitted_by uuid references auth.users on delete set null,
  proxy boolean not null default false,
  reviewed_at timestamptz,
  reviewed_by uuid references auth.users on delete set null,
  review_note text,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  primary key (document_id, group_id),
  unique (document_id, group_id, year_id),
  constraint document_submissions_document_fkey foreign key (document_id, year_id)
    references public.documents (id, year_id) on delete cascade,
  constraint document_submissions_group_fkey foreign key (group_id, year_id)
    references public.groups (id, year_id) on delete cascade,
  constraint document_submissions_review_note_check check (review_note is null or (review_note <> ''
    and review_note = btrim(review_note, E'\t\n\u000b\f\r \u00a0\u1680\u2000\u2001\u2002\u2003\u2004\u2005\u2006\u2007\u2008\u2009\u200a\u2028\u2029\u202f\u205f\u3000\ufeff')
    and length(review_note) <= 1000)),
  constraint document_submissions_status_check check (
    case status
      when 'not_submitted' then submitted_at is null and not proxy
      when 'submitted' then submitted_at is not null
      when 'returned' then reviewed_at is not null and review_note is not null
      when 'approved' then reviewed_at is not null
    end
    and (not proxy or submitted_at is not null))
);
-- 団体の削除の連鎖・自団体の行の読み取り用と、年度ごとの状態の数え上げ用
create index document_submissions_group_id_idx on public.document_submissions (group_id);
create index document_submissions_year_id_idx on public.document_submissions (year_id, status);

-- 提出物のファイル（Storage の物と1対1。行は足すか消すだけ）。RPC だけで書く。
-- id は画面が作る（reserve_document_file の p_file_id。既定値なし。送り直しの鍵）。object_path は Storage の path で、DB が列から作り、
-- CHECK で形を `{year_id}/{group_id}/{document_id}/{id}.{pdf|jpg|png}` に固定する（uuid は小文字の 36 字。拡張子は形から決める。
-- 日本語や個人名を入れない。元のファイル名は持たない。Q16）。size は申告の大きさ（バイト。1 B〜10 MiB。届いた物の大きさは
-- v_document_files の stored_size）。created_by は予約した人（Storage に上げられるのはこの人だけ）
create table public.document_files (
  id uuid primary key,
  year_id uuid not null,
  document_id uuid not null,
  group_id uuid not null,
  object_path text not null,
  content_type text not null,
  size integer not null,
  created_by uuid references auth.users on delete set null,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  constraint document_files_submission_fkey foreign key (document_id, group_id, year_id)
    references public.document_submissions (document_id, group_id, year_id) on delete cascade,
  constraint document_files_object_path_key unique (object_path),
  constraint document_files_content_type_check check (content_type in ('application/pdf', 'image/jpeg', 'image/png')),
  constraint document_files_size_check check (size between 1 and 10485760),
  constraint document_files_object_path_check check (object_path = year_id::text || '/' || group_id::text || '/'
    || document_id::text || '/' || id::text || '.'
    || case content_type when 'application/pdf' then 'pdf' when 'image/jpeg' then 'jpg' when 'image/png' then 'png' end)
);
-- 提出ごとのファイル（数の上限・提出の確かめ）と、年度ごと（ポリシーの year_id in (…)・年度のファイルの削除・使った量）
create index document_files_submission_idx on public.document_files (document_id, group_id);
create index document_files_year_id_idx on public.document_files (year_id);

alter table public.documents enable row level security;
alter table public.document_submissions enable row level security;
alter table public.document_files enable row level security;

------------------------------------------------------------------------
-- トリガー（BEFORE ROW は名前の順に動く：check_immutable → normalize_target_categories → set_actor → set_timestamps）
------------------------------------------------------------------------
-- 日時（0002 の共通の関数）
create trigger set_timestamps before insert or update on public.documents
  for each row execute function private.tg_set_timestamps();
create trigger set_timestamps before insert or update on public.document_submissions
  for each row execute function private.tg_set_timestamps();
create trigger set_timestamps before insert or update on public.document_files
  for each row execute function private.tg_set_timestamps();

-- 監査（D-11。0002 の tg_audit。year_id は行から、提出とファイルの group_id も行から〔documents は null〕）。
-- 提出とファイルの理由は RPC が置く。提出物の直接の書き込みは null（events と同じ）。updated_at だけの変更（ファイルを足す・外すときに
-- 提出の版を進める update）は記録しない（tg_audit の決まり）
create trigger audit after insert or update or delete on public.documents
  for each row execute function private.tg_audit('id');
create trigger audit after insert or update or delete on public.document_submissions
  for each row execute function private.tg_audit('document_id,group_id');
create trigger audit after insert or update or delete on public.document_files
  for each row execute function private.tg_audit('id');

-- 付け替えを止める（D-16。0002 の tg_immutable_columns〔0004 で DEFINER〕。invalid_input）。提出は別の提出物・団体・年度へ動かさない。
-- ファイルの行は足すか消すだけ（鍵・path・形・大きさを変えない。created_by は利用者の削除の set null で変わるので入れない）
create trigger check_immutable before update of year_id on public.documents
  for each row execute function private.tg_immutable_columns('year_id');
create trigger check_immutable before update of document_id, group_id, year_id on public.document_submissions
  for each row execute function private.tg_immutable_columns('document_id', 'group_id', 'year_id');
create trigger check_immutable before update of id, year_id, document_id, group_id, object_path, content_type, size
  on public.document_files
  for each row execute function private.tg_immutable_columns('id', 'year_id', 'document_id', 'group_id', 'object_path',
                                                              'content_type', 'size');

-- 対象の区分：重なりを除き、列挙の順（stall・department・company・rest_area）に並べる（画面の並べ方によらず同じ配列になる）。
-- null の要素は1つ残し、CHECK（documents_target_categories_check）が 23514 で拒む。配列ごと null なら not null（23502）に任せる。
-- 直接の書き込みでは authenticated で動くが、表を読まず private.fail も呼ばないので INVOKER でよい
create function private.tg_documents_normalize_categories()
returns trigger language plpgsql set search_path = '' as $$
begin
  if new.target_categories is not null then
    new.target_categories := array(select distinct t.c from unnest(new.target_categories) as t(c) order by t.c);
  end if;
  return new;
end $$;
create trigger normalize_target_categories before insert or update of target_categories on public.documents
  for each row execute function private.tg_documents_normalize_categories();

-- 書いた人・直した人：ログインしている人の書き込み（RPC の中も）では DB が auth.uid() を入れる（クライアントの値は使わない。
-- created_by は最初に書いた人のまま。0015 の tg_events_set_actor と同じ）。
-- files_deleted_at（年度のファイルを削除した日時）も、ログインしている人の書き込みでは元の値（insert では null）に戻す：提出物は
-- 部門長以上が直接 update できるので、RLS では列を守れない（RLS は列を制限できない）。delete_year_document_files だけが
-- transaction-local の app.document_files_deleted を 'on' にしてその文の間だけ入れさせる（0006 の app.keep_submitted_at と同じ形。
-- PostgREST の利用者は app.* を設定できない）。
-- seed・SQL Editor・pgTAP の postgres（auth.uid() が null）では、どの列も入れた値のまま（D-10）。auth.uid() を読むだけなので INVOKER
create function private.tg_documents_set_actor()
returns trigger language plpgsql set search_path = '' as $$
begin
  if auth.uid() is not null then
    if tg_op = 'INSERT' then
      new.created_by := auth.uid();
      if coalesce(current_setting('app.document_files_deleted', true), '') <> 'on' then
        new.files_deleted_at := null;
      end if;
    else
      new.created_by := old.created_by;
      if coalesce(current_setting('app.document_files_deleted', true), '') <> 'on' then
        new.files_deleted_at := old.files_deleted_at;
      end if;
    end if;
    new.updated_by := auth.uid();
  end if;
  return new;
end $$;
create trigger set_actor before insert or update on public.documents
  for each row execute function private.tg_documents_set_actor();

-- 版の増分（bump_version_*）と確定中・終了の守り（lock_year_guard）は付けない（振り分けの入力でない。終了の年度の読み取り専用は、
-- 提出物は書き込みのポリシー〔can_lead〕、提出とファイルは RPC が守る）

------------------------------------------------------------------------
-- 読み取り（RLS。D-47 の形）
------------------------------------------------------------------------
-- 集合の関数は 0010・0014 と同じく SECURITY DEFINER・search_path = ''・STABLE で、呼んだ人（auth.uid()）についてだけ答える（利用者の
-- 引数を取らない）。execute は authenticated だけ（ポリシーは呼んだ人の権限で評価される）。持ち主の postgres は BYPASSRLS なので、
-- 提出物の表と storage.objects を RLS を通らずに読む（ポリシーの中で RLS のある表を読み合うと再帰する）。ポリシーは
-- `x in (select 集合)` の形で問い合わせごとに1回だけ集合を作り、行ごとに判定関数を呼ばない。

-- 自分が代表（店長・副店長）の団体が対象（区分・飲食）の提出物
create function private.my_group_document_ids()
returns setof uuid language sql stable security definer set search_path = '' as $$
  select d.id from public.group_members gm
  join public.groups g on g.id = gm.group_id
  join public.documents d on d.year_id = g.year_id
                         and g.category = any (d.target_categories)
                         and (not d.food_only or g.is_food)
  where gm.user_id = (select auth.uid())
$$;

-- 提出物：総務はその年度の全部。店長・副店長は自団体が対象の提出物（対象の判定は上の集合）。閲覧のみ（Q5）・未招待は何も読めない
-- （ロールの配列に viewer を入れない）
create policy documents_select on public.documents for select to authenticated
  using (year_id in (select private.my_role_year_ids('{admin,head,deputy_head,staff}'))
         or id in (select private.my_group_document_ids()));

-- 提出：総務はその年度の全部。店長・副店長は自団体の行（対象から外れた提出物の分も読める。ビューには出ない。判断したことの 11）
create policy document_submissions_select on public.document_submissions for select to authenticated
  using (year_id in (select private.my_role_year_ids('{admin,head,deputy_head,staff}'))
         or group_id in (select private.my_group_ids()));

-- ファイル：部門長以上はその年度の全部。総務部門員は読めない（Q4。配列に staff を入れない）。店長・副店長は自団体の行
create policy document_files_select on public.document_files for select to authenticated
  using (year_id in (select private.my_role_year_ids('{admin,head,deputy_head}'))
         or group_id in (select private.my_group_ids()));

------------------------------------------------------------------------
-- 書き込み：提出物（直接。RLS）
------------------------------------------------------------------------
-- その年度の部門長以上で、年度が closed でない（0013 の can_lead。events・room_years・slots・deliveries と同じ）。書き込みのポリシーは
-- 行ごとの形のまま（D-47）。update は using と with check に同じ述語を書く（year_id は check_immutable で変えられない）。
-- 書けない人の insert は 42501、update・delete は 0 行（画面は読み直して not_found・conflict・権限や状態の変化を分ける）。
-- 消すと提出とファイルの行も cascade で消える（監査に残る）。Storage の物は残り、どの提出にも属さないファイルになる
create policy documents_insert on public.documents for insert to authenticated
  with check (private.can_lead(year_id));
create policy documents_update on public.documents for update to authenticated
  using (private.can_lead(year_id)) with check (private.can_lead(year_id));
create policy documents_delete on public.documents for delete to authenticated
  using (private.can_lead(year_id));

------------------------------------------------------------------------
-- ビュー（どちらも security_invoker。読む人の RLS〔提出物・団体・提出・ファイル・storage.objects〕がそのまま効く）
------------------------------------------------------------------------
-- 提出の状況：提出物 × 対象の団体（区分・飲食）× 提出の行。行がなければ未提出として出す。late は締切の後の提出（Q6）、updated_at は
-- 楽観ロックの版（提出・取り消し・承認・差し戻しの base_updated_at。行がなければ null）。今の対象の団体だけを出す（対象から外れた
-- 団体の提出の行は残るが出ない。判断したことの 11）。
-- where は、読む人が提出を読める団体の行だけにする（document_submissions_select と同じ集合。問い合わせごとに1回だけ作る。D-47）：
-- 閲覧のみも務める店長・副店長は groups をその年度の全部読めるので、RLS だけに任せると、自団体が対象の提出物 × ほかの団体の行が、
-- 提出の行を読めないまま未提出として出てしまう（判断したことの 24）
create view public.v_document_status with (security_invoker = true) as
  select d.year_id, d.id as document_id, g.id as group_id,
         d.title, d.description, d.deadline, d.requires_file,
         coalesce(s.status, 'not_submitted'::public.document_status) as status,
         s.submitted_at, s.submitted_by, coalesce(s.proxy, false) as proxy,
         coalesce(s.submitted_at > d.deadline, false) as late,
         s.reviewed_at, s.reviewed_by, s.review_note,
         s.updated_at
  from public.documents d
  join public.groups g on g.year_id = d.year_id
                      and g.category = any (d.target_categories)
                      and (not d.food_only or g.is_food)
  left join public.document_submissions s on s.document_id = d.id and s.group_id = g.id
  where d.year_id in (select private.my_role_year_ids('{admin,head,deputy_head,staff}'))
     or g.id in (select private.my_group_ids());

-- ファイルの行に、Storage に届いたか（uploaded）と実際の大きさ（stored_size。metadata の size）を足す。storage.objects で使う列は
-- bucket_id・name・metadata だけ（版のある bucket の列〔is_delete_marker など〕は Storage の版で違いうるので使わない）
create view public.v_document_files with (security_invoker = true) as
  select f.id, f.year_id, f.document_id, f.group_id, f.object_path, f.content_type, f.size,
         f.created_by, f.created_at,
         o.id is not null as uploaded,
         (o.metadata ->> 'size')::bigint as stored_size
  from public.document_files f
  left join storage.objects o on o.bucket_id = 'documents' and o.name = f.object_path;

------------------------------------------------------------------------
-- Storage：bucket documents と、storage.objects のポリシー
------------------------------------------------------------------------
-- 非公開の bucket（公開の URL を作らない）。1ファイル 10 MiB まで、形は PDF・JPEG・PNG だけ（Q1。Storage API が上げるときに止める）。
-- config.toml の [storage.buckets] は使わず、ここで作る（ローカル・CI・本番を同じマイグレーションでそろえる）。管理画面で先に
-- 作っていても、この設定に直す（on conflict do update）
insert into storage.buckets (id, name, public, file_size_limit, allowed_mime_types)
values ('documents', 'documents', false, 10485760, array['application/pdf', 'image/jpeg', 'image/png'])
on conflict (id) do update set name = excluded.name, public = excluded.public,
  file_size_limit = excluded.file_size_limit, allowed_mime_types = excluded.allowed_mime_types;

-- 自分が予約した（created_by）、終了でない年度の、今書ける提出（店長・副店長は未提出・差し戻し、部門長以上は承認でない）の path
-- （insert のポリシー）。「まだ届いていない」は入れない：届いた後の2回目は storage.objects の一意の索引（bucket_id, name）で止まり
-- （23505。Storage API は 409）、通信が切れた後の送り直しを「もう届いていた」と分けられるようにする（判断したことの 3）
create function private.my_document_upload_paths()
returns setof text language sql stable security definer set search_path = '' as $$
  select f.object_path from public.document_files f
  join public.document_submissions s on s.document_id = f.document_id and s.group_id = f.group_id
  join public.years y on y.id = f.year_id
  where f.created_by = (select auth.uid()) and y.status <> 'closed'
    and ((s.status in ('not_submitted', 'returned') and f.group_id in (select private.my_group_ids()))
         or (s.status <> 'approved' and f.year_id in (select private.my_role_year_ids('{admin,head,deputy_head}'))))
$$;

-- 自分の範囲（1つ目のフォルダが自分の部門長以上の年度、または2つ目が自分の団体。select のポリシーと同じ）の、どの提出にも属さない物
-- （document_files に行のない物。delete のポリシーと document_orphan_paths）。DB の行がある物（承認したファイルなど）は消せない
create function private.my_document_orphan_paths()
returns setof text language sql stable security definer set search_path = '' as $$
  select o.name from storage.objects o
  where o.bucket_id = 'documents'
    and (split_part(o.name, '/', 1) in (select y::text from private.my_role_year_ids('{admin,head,deputy_head}') as y)
         or split_part(o.name, '/', 2) in (select g::text from private.my_group_ids() as g))
    and not exists (select 1 from public.document_files f where f.object_path = o.name)
$$;

-- ポリシーは bucket documents の物だけに効く（ほかの bucket の物は、ほかのポリシーがなければ誰も触れない）。anon 向けと update の
-- ポリシーは作らない（上書き・移動・upsert はできない。画面の upload は upsert: false）。storage の表の権限（Supabase の既定）は変えない。
-- RLS を通らない書き込み（署名つきアップロードなど）は、下のトリガー documents_objects_guard が同じ条件で止める。
-- フォルダは組み込みの split_part で分ける（文字列を分けるだけ。storage.foldername と同じ意味で、storage の補助の版によらない）。
-- select（ダウンロード・署名つき URL・一覧。Storage API の insert・remove も行を返させるので要る）は DB の行でなくフォルダで決める
-- （どの提出にも属さない物も、範囲の人が読んで消せる。判断したことの 23）。部門員・閲覧のみ・未招待は読めない（Q4・Q5）
create policy documents_objects_select on storage.objects for select to authenticated
  using (bucket_id = 'documents'
         and (split_part(name, '/', 1) in (select y::text from private.my_role_year_ids('{admin,head,deputy_head}') as y)
              or split_part(name, '/', 2) in (select g::text from private.my_group_ids() as g)));
create policy documents_objects_insert on storage.objects for insert to authenticated
  with check (bucket_id = 'documents' and name in (select private.my_document_upload_paths()));
create policy documents_objects_delete on storage.objects for delete to authenticated
  using (bucket_id = 'documents' and name in (select private.my_document_orphan_paths()));

-- 書き込みの守り（T19 のレビューの T19-SEC-1。2026-11-01）：上のポリシー（RLS）は、Storage API が呼んだ人の権限で書くときにしか効かない。
-- 署名つきアップロード（createSignedUploadUrl → uploadToSignedUrl）は、URL を作るときだけ呼んだ人の RLS を確かめ、書くときは service_role
-- （BYPASSRLS）で書く。トークンは有効期限（ローカル・ホスト版の既定で 2 時間）の間は使い回せるので、RLS だけでは、予約の後に URL を作って
-- おけば承認・終了の後にファイルを足せ、upsert の URL で承認済みのファイルを上書きできてしまう（TUS・S3 の道の最後の書き込み、service_role の
-- 鍵、SQL Editor・マイグレーションの postgres も RLS を通らない）。トリガーはロールによらず動くので、bucket documents の物の書き込みを
-- storage.objects の行の前のトリガーで確かめる（止めるのは 42501。Storage API は 403 AccessDenied にする）：
--   insert：name が document_files の object_path で、年度が終了でなく、予約した人（created_by）が、その段で今書ける提出（店長・副店長は
--     未提出・差し戻しで今もその団体の店長・副店長、部門長以上は承認でなく今もその年度の部門長以上）の物だけ（my_document_upload_paths と
--     同じ条件を、呼んだ人〔auth.uid()〕でなく予約した人で見る。スーパーユーザーの書き込みには auth.uid() がない）。予約した人のいない
--     （利用者を消した。set null）予約には置けない。届いた物の大きさ（metadata の size。Storage API が書くときに入れる）が申告の大きさを
--     超えれば止める（size のない insert〔Storage API が書く前に権限だけを確かめる insert〕は大きさを見ない。T19-SEC-2。判断したことの 18）
--   update：名前・bucket・版（version）・metadata を変える update（上書き・移動。bucket documents の物から、または物へ）は、いつでも止める
--     （authenticated は update のポリシーがないので、もともと 0 行か 42501）。ほかの列（持ち主・利用者の metadata・最後に読んだ日時など）は
--     変えてよい（Storage の版上げの、列を埋める update を止めない）
--   delete は見ない（delete のポリシーと storage.protect_delete が守る）
-- ロックは RPC と同じ順（年度の行 → 提出の行。どちらも for share）に取り、その後にファイルの行を読み直す：承認・差し戻し・外す・年度の
-- 終了（提出の行を for update、年度の行を for no key update で取る）と同時でも、終わった後の状態で決まる。
-- 確かめを飛ばせるのは session_replication_role = replica の間だけ（トリガーが動かない。設定できるのは postgres〔supautils〕だけで、
-- Storage API の service_role・authenticated・anon はできない。テストの準備〔tests.put_object〕と手での直しにだけ使う）。
-- 持ち主の postgres（BYPASSRLS）の権限で予約と提出を読む（SECURITY DEFINER。書いたロールが anon・authenticated でも、RLS によらず読む）。
-- 本番の postgres が storage.objects にトリガーを作れることは、本番を使い始める前に README の 5 で確かめる（作れないときの代わりは
-- notes/T19.md の判断したことの 29）
create function private.tg_documents_objects_guard()
returns trigger language plpgsql security definer set search_path = '' as $$
declare
  v_file public.document_files;
  v_year_status public.year_status;
  v_sub_status public.document_status;
begin
  if tg_op = 'UPDATE' then
    if (old.bucket_id = 'documents' or new.bucket_id = 'documents')
       and (new.bucket_id, new.name, new.version, new.metadata) is distinct from (old.bucket_id, old.name, old.version, old.metadata) then
      raise exception using errcode = '42501', message = 'forbidden', detail = '{"reason": "immutable"}';
    end if;
    return new;
  end if;
  if new.bucket_id is distinct from 'documents' then
    return new;
  end if;

  select * into v_file from public.document_files f where f.object_path = new.name;
  if found then
    select y.status into v_year_status from public.years y where y.id = v_file.year_id for share;
    select s.status into v_sub_status from public.document_submissions s
    where s.document_id = v_file.document_id and s.group_id = v_file.group_id
    for share;
    select * into v_file from public.document_files f where f.object_path = new.name;  -- ロックを待つ間に外された・消された
  end if;
  -- detail の reason：not_reserved（予約がない）・closed（終了の年度）・not_editable（予約した人の段で今書けない）・too_large（申告を
  -- 超える）・immutable（上書き・移動）。Storage API は message だけを返すので、画面は 403 で分ける（理由は pgTAP と調べるときのため）
  if not found then
    raise exception using errcode = '42501', message = 'forbidden', detail = '{"reason": "not_reserved"}';
  end if;
  if v_year_status is null or v_year_status = 'closed' then
    raise exception using errcode = '42501', message = 'forbidden', detail = '{"reason": "closed"}';
  end if;
  if v_file.created_by is null
     or not coalesce(
          (v_sub_status in ('not_submitted', 'returned')
           and exists (select 1 from public.group_members gm
                       where gm.group_id = v_file.group_id and gm.user_id = v_file.created_by))
          or (v_sub_status <> 'approved'
              and exists (select 1 from public.year_roles yr
                          where yr.year_id = v_file.year_id and yr.user_id = v_file.created_by
                            and yr.role in ('admin', 'head', 'deputy_head'))),
          false) then
    raise exception using errcode = '42501', message = 'forbidden', detail = '{"reason": "not_editable"}';
  end if;
  if new.metadata ->> 'size' ~ '^[0-9]+$' and (new.metadata ->> 'size')::numeric > v_file.size then
    raise exception using errcode = '42501', message = 'forbidden', detail = '{"reason": "too_large"}';
  end if;
  return new;
end $$;
create trigger documents_objects_guard before insert or update on storage.objects
  for each row execute function private.tg_documents_objects_guard();

------------------------------------------------------------------------
-- 書き込み：提出とファイル（RPC）
------------------------------------------------------------------------
-- 共通の決まり（notes/T19.md の「SQL の約束」。どれも SECURITY DEFINER・search_path = ''、execute は authenticated だけ）：
--   1. ロール（forbidden）：対象の年度（団体・ファイル・p_year_id の年度）がない、または呼んだ人が「呼べる人」でない
--   2. 年度の行を for share でロックし、ロールをもう一度確かめ（待つ間に外されたとき）、終了なら invalid_state（detail は status）。
--      for share なので提出どうしは並行に進み、年度の状態の遷移（set_year_status の for no key update）とは順に処理される
--   3. 入力（invalid_input。detail は field と reason）
--   4. not_found（その年度にない提出物・団体が対象でない提出物。detail なし）
--   5. 状態（invalid_state。detail は status と reason：not_editable・no_file・not_uploaded・too_many_files・too_many_orphans・
--      storage_full）。提出・取り消し・承認で同じ操作が重なったとき（店長と副店長が同時に「提出した」を押した）と、成功した後の送り直しは、
--      ロックを待った後の状態で invalid_state（not_editable と今の status）になる（6 の conflict より先。画面は読み直して今の状態を出す。
--      差し戻しは差し戻しからもできるので、重なると conflict。T19 のレビューの F1）
--   6. 楽観ロック（conflict。detail は document_id と group_id）：base_updated_at と提出の行の updated_at をミリ秒までで比べる。
--      行がなければ版は null とみなす（null と null は同じ）
--   7. 理由を置いて（private.set_reason）書く
-- 段の forbidden（計画のエラーの順の 5）は使わない：どの RPC も呼べる人は 1 で決まり、店長・副店長と部門長以上の違いは書ける状態の
-- 違い（not_editable）になる。書ける（ファイルを足す・外す）のは、店長・副店長は未提出・差し戻し、部門長以上は承認でないとき
-- （部門長以上で店長・副店長も務める人は部門長以上の決まり）。
-- ロックの順：年度の行（for share）→ 提出の行（for update）→ ファイルの行 → 容量の勧告的ロック（reserve だけ）。どの RPC もこの順に
-- 取る（飛ばすのはよいが、逆には取らない）。提出の行がなければ書くときに作り（同じトランザクション。失敗すれば一緒に消える）、
-- 同じ提出への書き込みは提出の行の for update で順にする。
-- 例外の直し（D-19）：外部キーの違反（確かめた後に提出物・団体が消えた）→ not_found、CHECK の違反 → invalid_input、クラス 22 →
-- invalid_input。detail にメール・ファイルの中身・元のファイル名を入れない。

-- 1・2 の補助：ロール → 年度の行を for share → ロールをもう一度 → 終了なら invalid_state。p_year_id が null（団体・ファイル・年度が
-- ない）なら forbidden。p_group_id はその団体の店長・副店長として呼べる団体（null なら部門長以上だけが呼べる）。返り値は、呼んだ人が
-- その年度の部門長以上か（書ける状態の決まりに使う）。ロックの後の確かめは新しいスナップショットで読む（READ COMMITTED。VOLATILE）
create function private.lock_document_year(p_year_id uuid, p_group_id uuid)
returns boolean language plpgsql security definer set search_path = '' as $$
declare v_status public.year_status;
begin
  if p_year_id is null
     or not (private.has_any_role(p_year_id, '{admin,head,deputy_head}')
             or (p_group_id is not null and private.is_group_member(p_group_id))) then
    perform private.fail('forbidden');
  end if;
  select y.status into v_status from public.years y where y.id = p_year_id for share;
  if not found then
    perform private.fail('forbidden');
  end if;
  if not (private.has_any_role(p_year_id, '{admin,head,deputy_head}')
          or (p_group_id is not null and private.is_group_member(p_group_id))) then
    perform private.fail('forbidden');
  end if;
  if v_status = 'closed' then
    perform private.fail('invalid_state', jsonb_build_object('status', v_status));
  end if;
  return private.has_any_role(p_year_id, '{admin,head,deputy_head}');
end $$;

-- 4 の補助：その年度の提出物で、団体が対象（区分・飲食）なら提出物の行を返し、そうでなければ not_found
create function private.target_document(p_document_id uuid, p_group_id uuid, p_year_id uuid)
returns public.documents language plpgsql security definer set search_path = '' as $$
declare v public.documents;
begin
  select d.* into v from public.documents d
  join public.groups g on g.id = p_group_id and g.year_id = d.year_id
                      and g.category = any (d.target_categories)
                      and (not d.food_only or g.is_food)
  where d.id = p_document_id and d.year_id = p_year_id;
  if not found then
    perform private.fail('not_found');
  end if;
  return v;
end $$;

-- reserve_document_file：ファイルを予約し、ファイルの行（DB が作った object_path を含む）を返す。画面はその path へ Storage API で
-- upload する（upsert: false）。呼べる人：その年度の部門長以上（代理）、その団体の店長・副店長。
-- 同じ file_id・同じ中身（提出物・団体・形・大きさ）で送り直したら、状態・数・容量を見ずにその行を返す（冪等。04 の (B1)）。
-- 中身が違えば invalid_input（file_id・in_use）。提出の行がなければ作る（未提出）。1つの提出に 5 つまで（Q2）、その団体のフォルダの
-- どの提出にも属さない物（DB の行のない物）が 5 つ未満（T19 のレビューの T19-SEC-2：届いた物を外して予約し直す繰り返しで、1つの団体が
-- bucket を埋められないようにする。画面は document_orphan_paths の path を消してから足し直す）、bucket の合計（届いた物の metadata の
-- size ＋ 届いていない予約の申告 ＋ 今回）が 900 MiB（943718400 バイト。無料プランの 1 GB の手前）まで。届いた物は申告を超えられない
-- （トリガー documents_objects_guard）。容量は勧告的ロックで予約どうしを順にして数える。ファイルを足すと提出の版（updated_at）を進める
-- （提出・承認の base_updated_at がファイルの組も守る。判断したことの 4）。理由は置かない（理由の要らない書き込み）
create function public.reserve_document_file(p_document_id uuid, p_group_id uuid, p_file_id uuid,
                                             p_content_type text, p_size integer)
returns public.document_files language plpgsql security definer set search_path = '' as $$
declare
  v_year_id uuid := private.group_year_id(p_group_id);
  v_is_lead boolean;
  v_file public.document_files;
  v_sub public.document_submissions;
  v_constraint text;
begin
  v_is_lead := private.lock_document_year(v_year_id, p_group_id);

  if p_document_id is null then
    perform private.fail('invalid_input', jsonb_build_object('field', 'document_id'));
  end if;
  if p_file_id is null then
    perform private.fail('invalid_input', jsonb_build_object('field', 'file_id'));
  end if;
  if p_content_type is null or p_content_type not in ('application/pdf', 'image/jpeg', 'image/png') then
    perform private.fail('invalid_input', jsonb_build_object('field', 'content_type'));
  end if;
  if p_size is null or p_size not between 1 and 10485760 then
    perform private.fail('invalid_input', jsonb_build_object('field', 'size'));
  end if;
  select * into v_file from public.document_files f where f.id = p_file_id;
  if found and (v_file.document_id, v_file.group_id, v_file.content_type, v_file.size)
               is distinct from (p_document_id, p_group_id, p_content_type, p_size) then
    perform private.fail('invalid_input', jsonb_build_object('field', 'file_id', 'reason', 'in_use'));
  end if;

  perform private.target_document(p_document_id, p_group_id, v_year_id);

  if v_file.id is not null then
    return v_file;                                   -- 送り直し（同じ id・同じ中身）
  end if;

  perform private.set_reason(null);
  insert into public.document_submissions (document_id, group_id, year_id)
  values (p_document_id, p_group_id, v_year_id)
  on conflict (document_id, group_id) do nothing;
  select * into v_sub from public.document_submissions s
  where s.document_id = p_document_id and s.group_id = p_group_id
  for update;
  -- 提出の行を待つ間に、同じ id の予約が入った（送り直しが重なった）ときも、上と同じに分ける
  select * into v_file from public.document_files f where f.id = p_file_id;
  if found then
    if (v_file.document_id, v_file.group_id, v_file.content_type, v_file.size)
       is distinct from (p_document_id, p_group_id, p_content_type, p_size) then
      perform private.fail('invalid_input', jsonb_build_object('field', 'file_id', 'reason', 'in_use'));
    end if;
    return v_file;
  end if;

  if not (case when v_is_lead then v_sub.status <> 'approved'
               else v_sub.status in ('not_submitted', 'returned') end) then
    perform private.fail('invalid_state', jsonb_build_object('status', v_sub.status, 'reason', 'not_editable'));
  end if;
  if (select count(*) from public.document_files f
      where f.document_id = p_document_id and f.group_id = p_group_id) >= 5 then
    perform private.fail('invalid_state', jsonb_build_object('status', v_sub.status, 'reason', 'too_many_files'));
  end if;
  if (select count(*) from storage.objects o
      where o.bucket_id = 'documents' and split_part(o.name, '/', 2) = p_group_id::text
        and not exists (select 1 from public.document_files f where f.object_path = o.name)) >= 5 then
    perform private.fail('invalid_state', jsonb_build_object('status', v_sub.status, 'reason', 'too_many_orphans'));
  end if;
  perform pg_advisory_xact_lock(hashtext('gaapp.document_storage'), 0);
  if (select coalesce(sum((o.metadata ->> 'size')::bigint), 0)
      from storage.objects o where o.bucket_id = 'documents')
     + (select coalesce(sum(f.size), 0) from public.document_files f
        where not exists (select 1 from storage.objects o where o.bucket_id = 'documents' and o.name = f.object_path))
     + p_size > 943718400 then
    perform private.fail('invalid_state', jsonb_build_object('status', v_sub.status, 'reason', 'storage_full'));
  end if;

  insert into public.document_files (id, year_id, document_id, group_id, object_path, content_type, size, created_by)
  values (p_file_id, v_year_id, p_document_id, p_group_id,
          v_year_id::text || '/' || p_group_id::text || '/' || p_document_id::text || '/' || p_file_id::text || '.'
          || case p_content_type when 'application/pdf' then 'pdf' when 'image/jpeg' then 'jpg' else 'png' end,
          p_content_type, p_size, auth.uid())
  returning * into v_file;
  update public.document_submissions s set updated_at = now()
  where s.document_id = p_document_id and s.group_id = p_group_id;
  return v_file;
exception
  when foreign_key_violation then                    -- 確かめた後に提出物・団体が消えた
    perform private.fail('not_found');
  when unique_violation then                         -- 同じ id のファイルの行が、ほかの提出に同時に入った
    perform private.fail('invalid_input', jsonb_build_object('field', 'file_id', 'reason', 'in_use'));
  when check_violation then
    get stacked diagnostics v_constraint = constraint_name;
    perform private.fail('invalid_input', jsonb_build_object('field',
      case v_constraint when 'document_files_content_type_check' then 'content_type'
                        when 'document_files_size_check' then 'size' else 'file_id' end));
  when data_exception then                           -- 22xxx（関数の中で起きた形の誤り。D-19）
    perform private.fail('invalid_input', jsonb_build_object('field', 'file_id'));
end $$;

-- discard_document_file：ファイルの行を消し、object_path を返す（Storage の物は「どの提出にも属さないファイル」になり、画面がすぐ
-- remove する）。呼べる人は reserve と同じ。Storage に届いた物は書ける状態のときだけ外せる。届いていない予約（上げられなかったもの）は
-- 状態によらず外せる。ファイルを外すと提出の版を進める。理由は置かない。
-- エラーの順：1. ファイルの行がない・その年度の部門長以上でもその団体の店長・副店長でもない → forbidden（有無を漏らさない。
-- delete_notice と同じ）2. 終了 → invalid_state 3. 提出の行を for update でロックした後に読み直して、ない → not_found（待つ間に外された・
-- 提出物が消された）4. 届いた物で、書けない状態 → invalid_state（not_editable）
create function public.discard_document_file(p_file_id uuid)
returns text language plpgsql security definer set search_path = '' as $$
declare
  v_file public.document_files;
  v_is_lead boolean;
  v_sub public.document_submissions;
begin
  select * into v_file from public.document_files f where f.id = p_file_id;
  if not found then
    perform private.fail('forbidden');
  end if;
  v_is_lead := private.lock_document_year(v_file.year_id, v_file.group_id);

  select * into v_sub from public.document_submissions s
  where s.document_id = v_file.document_id and s.group_id = v_file.group_id
  for update;
  select * into v_file from public.document_files f where f.id = p_file_id for update;
  if not found then
    perform private.fail('not_found');
  end if;
  if exists (select 1 from storage.objects o where o.bucket_id = 'documents' and o.name = v_file.object_path)
     and not (case when v_is_lead then v_sub.status <> 'approved'
                   else v_sub.status in ('not_submitted', 'returned') end) then
    perform private.fail('invalid_state', jsonb_build_object('status', v_sub.status, 'reason', 'not_editable'));
  end if;

  perform private.set_reason(null);
  delete from public.document_files f where f.id = v_file.id;
  update public.document_submissions s set updated_at = now()
  where s.document_id = v_file.document_id and s.group_id = v_file.group_id;
  return v_file.object_path;
end $$;

-- submit_document：未提出・差し戻し → 提出済み。呼べる人：その団体の店長・副店長、その年度の部門長以上（その団体の店長・副店長で
-- なければ代理〔proxy〕。部門長以上が自分の団体に出すときは代理でない）。ファイルが要る提出物はファイルの行が1つ以上要り、付けた
-- ファイルは全部 Storage に届いていること（ファイルが要らない提出物でも）。締切の後も出せる（v_document_status の late。Q6）。
-- 前の差し戻しの理由（reviewed_*・review_note）は残す（「前の差し戻しの理由」として出す）。
-- エラーの順：forbidden → invalid_state（終了）→ invalid_input（document_id）→ not_found → invalid_state（not_editable・no_file・
-- not_uploaded）→ conflict。理由は「提出物の提出」（代理は「提出物の代理の提出」）。返り値は提出の行
create function public.submit_document(p_document_id uuid, p_group_id uuid, p_base_updated_at timestamptz)
returns public.document_submissions language plpgsql security definer set search_path = '' as $$
declare
  v_year_id uuid := private.group_year_id(p_group_id);
  v_is_member boolean;
  v_doc public.documents;
  v_created boolean;
  v_sub public.document_submissions;
begin
  perform private.lock_document_year(v_year_id, p_group_id);
  if p_document_id is null then
    perform private.fail('invalid_input', jsonb_build_object('field', 'document_id'));
  end if;
  v_doc := private.target_document(p_document_id, p_group_id, v_year_id);

  v_is_member := private.is_group_member(p_group_id);
  perform private.set_reason(case when v_is_member then '提出物の提出' else '提出物の代理の提出' end);
  insert into public.document_submissions (document_id, group_id, year_id)
  values (p_document_id, p_group_id, v_year_id)
  on conflict (document_id, group_id) do nothing
  returning true into v_created;
  select * into v_sub from public.document_submissions s
  where s.document_id = p_document_id and s.group_id = p_group_id
  for update;

  if v_sub.status not in ('not_submitted', 'returned') then
    perform private.fail('invalid_state', jsonb_build_object('status', v_sub.status, 'reason', 'not_editable'));
  end if;
  if v_doc.requires_file and not exists (select 1 from public.document_files f
                                         where f.document_id = p_document_id and f.group_id = p_group_id) then
    perform private.fail('invalid_state', jsonb_build_object('status', v_sub.status, 'reason', 'no_file'));
  end if;
  if exists (select 1 from public.document_files f
             where f.document_id = p_document_id and f.group_id = p_group_id
               and not exists (select 1 from storage.objects o where o.bucket_id = 'documents' and o.name = f.object_path)) then
    perform private.fail('invalid_state', jsonb_build_object('status', v_sub.status, 'reason', 'not_uploaded'));
  end if;
  -- 行を今作ったなら、読んだときの版は null（行がなかった）
  if date_trunc('milliseconds', case when v_created then null else v_sub.updated_at end)
     is distinct from date_trunc('milliseconds', p_base_updated_at) then
    perform private.fail('conflict', jsonb_build_object('document_id', p_document_id, 'group_id', p_group_id));
  end if;

  update public.document_submissions s
  set status = 'submitted', submitted_at = now(), submitted_by = auth.uid(), proxy = not v_is_member
  where s.document_id = p_document_id and s.group_id = p_group_id
  returning * into v_sub;
  return v_sub;
exception
  when foreign_key_violation then
    perform private.fail('not_found');
  when check_violation or data_exception then        -- 23514・22xxx（関数の中で起きた形の誤り。D-19）
    perform private.fail('invalid_input', jsonb_build_object('field', 'document_id'));
end $$;

-- withdraw_document：提出済み → 未提出（Q13。承認・差し戻しの前なら、店長・副店長が総務に頼まずに直せる）。呼べる人は submit と同じ。
-- 提出の日時と人・代理の印を消す（ファイルと、前の差し戻しの理由は残す）。取り消すのは行のある提出だけなので base_updated_at は要る。
-- エラーの順：forbidden → invalid_state（終了）→ invalid_input（document_id・base_updated_at）→ not_found → invalid_state（提出済み
-- でない：not_editable。行がなければ未提出）→ conflict。理由は「提出の取り消し」。返り値は提出の行
create function public.withdraw_document(p_document_id uuid, p_group_id uuid, p_base_updated_at timestamptz)
returns public.document_submissions language plpgsql security definer set search_path = '' as $$
declare
  v_year_id uuid := private.group_year_id(p_group_id);
  v_sub public.document_submissions;
begin
  perform private.lock_document_year(v_year_id, p_group_id);
  if p_document_id is null then
    perform private.fail('invalid_input', jsonb_build_object('field', 'document_id'));
  end if;
  if p_base_updated_at is null then
    perform private.fail('invalid_input', jsonb_build_object('field', 'base_updated_at'));
  end if;
  perform private.target_document(p_document_id, p_group_id, v_year_id);

  select * into v_sub from public.document_submissions s
  where s.document_id = p_document_id and s.group_id = p_group_id
  for update;
  if not found or v_sub.status <> 'submitted' then
    perform private.fail('invalid_state', jsonb_build_object(
      'status', coalesce(v_sub.status, 'not_submitted'), 'reason', 'not_editable'));
  end if;
  if date_trunc('milliseconds', v_sub.updated_at) is distinct from date_trunc('milliseconds', p_base_updated_at) then
    perform private.fail('conflict', jsonb_build_object('document_id', p_document_id, 'group_id', p_group_id));
  end if;

  perform private.set_reason('提出の取り消し');
  update public.document_submissions s
  set status = 'not_submitted', submitted_at = null, submitted_by = null, proxy = false
  where s.document_id = p_document_id and s.group_id = p_group_id
  returning * into v_sub;
  return v_sub;
end $$;

-- approve_document：提出済み → 承認（メモは任意）。未提出・差し戻しからの承認（紙などで受け取ったとき。Q9）はメモが必須で、提出の
-- 日時と人・代理の印を消す（「submitted_at のない承認」が紙などでの承認になり、画面と CSV で分けられる。判断したことの 7）。
-- 呼べる人：その年度の部門長以上。メモは前後の空白（題名と同じ 25 文字）を除き、空なら null で、1000 字まで。review_note はメモで
-- 置き換える（なければ null）。提出の行がなければ作る（版は null）。
-- エラーの順：forbidden → invalid_state（終了）→ invalid_input（document_id・note〔too_long〕）→ not_found → invalid_state（承認済み：
-- not_editable）・invalid_input（未提出・差し戻しからでメモがない：note・required。メモが要るかは状態で決まるので、状態を見た後。
-- 判断したことの 15）→ conflict。理由は「提出物の承認」。返り値は提出の行
create function public.approve_document(p_document_id uuid, p_group_id uuid, p_note text, p_base_updated_at timestamptz)
returns public.document_submissions language plpgsql security definer set search_path = '' as $$
declare
  -- 前後から除く空白（documents_title_check・document_submissions_review_note_check と同じ 25 文字。JavaScript の trim と同じ）
  c_space constant text := E'\t\n\u000b\f\r \u00a0\u1680\u2000\u2001\u2002\u2003\u2004\u2005\u2006\u2007\u2008\u2009\u200a\u2028\u2029\u202f\u205f\u3000\ufeff';
  v_year_id uuid := private.group_year_id(p_group_id);
  v_note text := nullif(btrim(coalesce(p_note, ''), c_space), '');
  v_created boolean;
  v_sub public.document_submissions;
  v_constraint text;
begin
  perform private.lock_document_year(v_year_id, null);
  if p_document_id is null then
    perform private.fail('invalid_input', jsonb_build_object('field', 'document_id'));
  end if;
  if length(v_note) > 1000 then
    perform private.fail('invalid_input', jsonb_build_object('field', 'note', 'reason', 'too_long'));
  end if;
  perform private.target_document(p_document_id, p_group_id, v_year_id);

  perform private.set_reason('提出物の承認');
  insert into public.document_submissions (document_id, group_id, year_id)
  values (p_document_id, p_group_id, v_year_id)
  on conflict (document_id, group_id) do nothing
  returning true into v_created;
  select * into v_sub from public.document_submissions s
  where s.document_id = p_document_id and s.group_id = p_group_id
  for update;

  if v_sub.status = 'approved' then
    perform private.fail('invalid_state', jsonb_build_object('status', v_sub.status, 'reason', 'not_editable'));
  end if;
  if v_sub.status <> 'submitted' and v_note is null then
    perform private.fail('invalid_input', jsonb_build_object('field', 'note', 'reason', 'required'));
  end if;
  if date_trunc('milliseconds', case when v_created then null else v_sub.updated_at end)
     is distinct from date_trunc('milliseconds', p_base_updated_at) then
    perform private.fail('conflict', jsonb_build_object('document_id', p_document_id, 'group_id', p_group_id));
  end if;

  update public.document_submissions s
  set status = 'approved', reviewed_at = now(), reviewed_by = auth.uid(), review_note = v_note,
      submitted_at = case when v_sub.status = 'submitted' then s.submitted_at end,
      submitted_by = case when v_sub.status = 'submitted' then s.submitted_by end,
      proxy = (v_sub.status = 'submitted' and s.proxy)
  where s.document_id = p_document_id and s.group_id = p_group_id
  returning * into v_sub;
  return v_sub;
exception
  when foreign_key_violation then
    perform private.fail('not_found');
  when check_violation then
    get stacked diagnostics v_constraint = constraint_name;
    perform private.fail('invalid_input', jsonb_build_object('field',
      case v_constraint when 'document_submissions_review_note_check' then 'note' else 'document_id' end));
  when data_exception then
    perform private.fail('invalid_input', jsonb_build_object('field', 'note'));
end $$;

-- return_document：提出済み・承認・差し戻し → 差し戻し（承認の取り消しと、理由の書き直しも兼ねる）。理由（note）は前後の空白を除いて
-- 1〜1000 字で必須（団体のホームの要対応に出す）。提出の日時と人・代理の印は残す。呼べる人：その年度の部門長以上。
-- エラーの順：forbidden → invalid_state（終了）→ invalid_input（document_id・note〔required・too_long〕・base_updated_at）→ not_found →
-- invalid_state（未提出：not_editable。行がなければ未提出）→ conflict。理由は「提出物の差し戻し」。返り値は提出の行
create function public.return_document(p_document_id uuid, p_group_id uuid, p_note text, p_base_updated_at timestamptz)
returns public.document_submissions language plpgsql security definer set search_path = '' as $$
declare
  -- 前後から除く空白（approve_document と同じ 25 文字。直すときは両方を直す）
  c_space constant text := E'\t\n\u000b\f\r \u00a0\u1680\u2000\u2001\u2002\u2003\u2004\u2005\u2006\u2007\u2008\u2009\u200a\u2028\u2029\u202f\u205f\u3000\ufeff';
  v_year_id uuid := private.group_year_id(p_group_id);
  v_note text := nullif(btrim(coalesce(p_note, ''), c_space), '');
  v_sub public.document_submissions;
  v_constraint text;
begin
  perform private.lock_document_year(v_year_id, null);
  if p_document_id is null then
    perform private.fail('invalid_input', jsonb_build_object('field', 'document_id'));
  end if;
  if v_note is null then
    perform private.fail('invalid_input', jsonb_build_object('field', 'note', 'reason', 'required'));
  end if;
  if length(v_note) > 1000 then
    perform private.fail('invalid_input', jsonb_build_object('field', 'note', 'reason', 'too_long'));
  end if;
  if p_base_updated_at is null then
    perform private.fail('invalid_input', jsonb_build_object('field', 'base_updated_at'));
  end if;
  perform private.target_document(p_document_id, p_group_id, v_year_id);

  select * into v_sub from public.document_submissions s
  where s.document_id = p_document_id and s.group_id = p_group_id
  for update;
  if not found or v_sub.status = 'not_submitted' then
    perform private.fail('invalid_state', jsonb_build_object('status', 'not_submitted', 'reason', 'not_editable'));
  end if;
  if date_trunc('milliseconds', v_sub.updated_at) is distinct from date_trunc('milliseconds', p_base_updated_at) then
    perform private.fail('conflict', jsonb_build_object('document_id', p_document_id, 'group_id', p_group_id));
  end if;

  perform private.set_reason('提出物の差し戻し');
  update public.document_submissions s
  set status = 'returned', reviewed_at = now(), reviewed_by = auth.uid(), review_note = v_note
  where s.document_id = p_document_id and s.group_id = p_group_id
  returning * into v_sub;
  return v_sub;
exception
  when check_violation then
    get stacked diagnostics v_constraint = constraint_name;
    perform private.fail('invalid_input', jsonb_build_object('field',
      case v_constraint when 'document_submissions_review_note_check' then 'note' else 'document_id' end));
  when data_exception then
    perform private.fail('invalid_input', jsonb_build_object('field', 'note'));
end $$;

------------------------------------------------------------------------
-- 前年度から写す（Q10。年度の作成〔create_year_from〕では写さない。D-54 と同じ）
------------------------------------------------------------------------
-- previous_year_documents：複製元（years.prev_year_id）の年度の提出物を、締切 → 題名 → id の順に返す（読み取りのみ。ロックしない。
-- 年度の状態によらない。previous_year_requests と同じ）。複製元がなければ空。呼べる人：その年度の部門長以上（違えば forbidden）。
-- new_deadline は1日目の差の日数だけずらした締切（Asia/Tokyo の時刻は同じ。Asia/Tokyo に夏時間はない）。exists_in_year は同じ題名の
-- 提出物がこの年度にある（写すと飛ばされる）
create function public.previous_year_documents(p_year_id uuid)
returns table (document_id uuid, title text, description text, deadline timestamptz, new_deadline timestamptz,
               target_categories public.group_category[], food_only boolean, requires_file boolean, exists_in_year boolean)
language plpgsql stable security definer set search_path = '' as $$
begin
  perform private.assert_role(p_year_id, '{admin,head,deputy_head}');
  return query
    select d.id, d.title, d.description, d.deadline,
           ((d.deadline at time zone 'Asia/Tokyo') + (y.festival_start - py.festival_start) * interval '1 day')
             at time zone 'Asia/Tokyo',
           d.target_categories, d.food_only, d.requires_file,
           exists (select 1 from public.documents x where x.year_id = y.id and x.title = d.title)
    from public.years y
    join public.years py on py.id = y.prev_year_id
    join public.documents d on d.year_id = py.id
    where y.id = p_year_id
    order by d.deadline, d.title, d.id;
end $$;

-- copy_previous_documents：選んだ前年度の提出物を、ずらした締切でこの年度に写す（題名・説明・対象の区分・飲食の団体だけ・ファイルが
-- 要る。files_deleted_at は写さない）。同じ題名は飛ばす（on conflict do nothing。何度呼んでも同じ結果になる）。今回写した行を返す。
-- 呼べる人：その年度の部門長以上。
-- エラーの順：forbidden → invalid_state（終了）→ invalid_input（field document_ids、reason：required〔null・空〕・too_many〔1000 を
-- 超える。unnest の前に数で見る〕・invalid〔null の要素・重なり〕・not_in_prev_year〔複製元の年度の提出物でない id がある。複製元が
-- ないときも〕・deadline_out_of_range〔ずらした締切が 2000〜2200 年の外〕）。理由は「提出物の前年度からの写し」
create function public.copy_previous_documents(p_year_id uuid, p_document_ids uuid[])
returns setof public.documents language plpgsql security definer set search_path = '' as $$
declare
  v_prev_year_id uuid;
  v_days integer;
  v_constraint text;
begin
  perform private.lock_document_year(p_year_id, null);
  if p_document_ids is null or cardinality(p_document_ids) = 0 then
    perform private.fail('invalid_input', jsonb_build_object('field', 'document_ids', 'reason', 'required'));
  end if;
  if cardinality(p_document_ids) > 1000 then
    perform private.fail('invalid_input', jsonb_build_object('field', 'document_ids', 'reason', 'too_many'));
  end if;
  if exists (select 1 from unnest(p_document_ids) as t(id) where t.id is null)
     or (select count(distinct t.id) from unnest(p_document_ids) as t(id)) <> cardinality(p_document_ids) then
    perform private.fail('invalid_input', jsonb_build_object('field', 'document_ids', 'reason', 'invalid'));
  end if;
  select y.prev_year_id, y.festival_start - py.festival_start into v_prev_year_id, v_days
  from public.years y left join public.years py on py.id = y.prev_year_id
  where y.id = p_year_id;
  if exists (select 1 from unnest(p_document_ids) as t(id)
             where not exists (select 1 from public.documents d where d.id = t.id and d.year_id = v_prev_year_id)) then
    perform private.fail('invalid_input', jsonb_build_object('field', 'document_ids', 'reason', 'not_in_prev_year'));
  end if;
  if exists (select 1 from public.documents d
             where d.id = any (p_document_ids) and d.year_id = v_prev_year_id
               and not (((d.deadline at time zone 'Asia/Tokyo') + v_days * interval '1 day')::date
                        between date '2000-01-01' and date '2200-12-31')) then
    perform private.fail('invalid_input', jsonb_build_object('field', 'document_ids', 'reason', 'deadline_out_of_range'));
  end if;

  perform private.set_reason('提出物の前年度からの写し');
  return query
    insert into public.documents (year_id, title, description, deadline, target_categories, food_only, requires_file)
    select p_year_id, d.title, d.description,
           ((d.deadline at time zone 'Asia/Tokyo') + v_days * interval '1 day') at time zone 'Asia/Tokyo',
           d.target_categories, d.food_only, d.requires_file
    from public.documents d
    where d.id = any (p_document_ids) and d.year_id = v_prev_year_id
    order by d.deadline, d.title, d.id
    on conflict (year_id, title) do nothing
    returning *;
exception
  when check_violation then
    get stacked diagnostics v_constraint = constraint_name;
    perform private.fail('invalid_input', jsonb_build_object('field', 'document_ids', 'reason',
      case v_constraint when 'documents_deadline_check' then 'deadline_out_of_range' else 'invalid' end));
  when data_exception then
    perform private.fail('invalid_input', jsonb_build_object('field', 'document_ids', 'reason', 'invalid'));
end $$;

------------------------------------------------------------------------
-- 年度の終了の後のファイルの削除・片付け・使った量
------------------------------------------------------------------------
-- delete_year_document_files：終了した年度の提出物のファイルの行を全部消し、その年度の提出物の files_deleted_at を入れる（null のもの
-- だけ。最初の削除の日時のまま）。提出の状態・日時・理由は残す（Q3）。消した行の数を返す（2回目は 0。Storage の物は、画面が
-- document_orphan_paths の path を remove する）。呼べる人：その年度の管理者。
-- エラーの順：forbidden（年度がない・管理者でない）→ invalid_state（終了でない：detail は status と reason not_closed）→ invalid_input
-- （reason が 500 字を超える）。理由は p_reason（前後の空白を除いて空なら「提出物のファイルの削除」）
create function public.delete_year_document_files(p_year_id uuid, p_reason text default null)
returns integer language plpgsql security definer set search_path = '' as $$
declare
  c_space constant text := E'\t\n\u000b\f\r \u00a0\u1680\u2000\u2001\u2002\u2003\u2004\u2005\u2006\u2007\u2008\u2009\u200a\u2028\u2029\u202f\u205f\u3000\ufeff';
  v_status public.year_status;
  v_count integer;
begin
  perform private.assert_role(p_year_id, '{admin}');
  select y.status into v_status from public.years y where y.id = p_year_id for share;
  if not found then
    perform private.fail('forbidden');
  end if;
  perform private.assert_role(p_year_id, '{admin}');      -- 待つ間に外されたとき
  if v_status <> 'closed' then
    perform private.fail('invalid_state', jsonb_build_object('status', v_status, 'reason', 'not_closed'));
  end if;
  if length(p_reason) > 500 then
    perform private.fail('invalid_input', jsonb_build_object('field', 'reason'));
  end if;

  perform private.set_reason(case when btrim(coalesce(p_reason, ''), c_space) = '' then '提出物のファイルの削除'
                                  else p_reason end);
  delete from public.document_files f where f.year_id = p_year_id;
  get diagnostics v_count = row_count;
  -- files_deleted_at は set_actor が直接の書き込みでは元に戻すので、この文の間だけ入れさせる
  perform set_config('app.document_files_deleted', 'on', true);
  update public.documents d set files_deleted_at = now()
  where d.year_id = p_year_id and d.files_deleted_at is null;
  perform set_config('app.document_files_deleted', '', true);
  return v_count;
end $$;

-- document_orphan_paths：呼んだ人が Storage から消せる「どの提出にも属さないファイル」の path を返す（その年度のフォルダの分。
-- 部門長以上は年度の全部、店長・副店長は自団体の分。private.my_document_orphan_paths と同じ範囲で、delete のポリシーで消せるもの）。
-- 呼べる人：その年度の部門長以上、その年度の団体の店長・副店長（どちらでもなければ forbidden）。読み取りのみ（ロックしない。
-- 終了の年度も）
create function public.document_orphan_paths(p_year_id uuid)
returns setof text language plpgsql stable security definer set search_path = '' as $$
begin
  if p_year_id is null
     or not (private.has_any_role(p_year_id, '{admin,head,deputy_head}')
             or p_year_id in (select private.my_group_year_ids())) then
    perform private.fail('forbidden');
  end if;
  return query
    select p.path from private.my_document_orphan_paths() as p(path)
    where split_part(p.path, '/', 1) = p_year_id::text
    order by p.path;
end $$;

-- document_storage_usage：1行を返す（読み取りのみ。ロックしない）。bucket_bytes は bucket documents の全部の物（全年度・どの提出にも
-- 属さない物を含む）の大きさの合計、limit_bytes は上限（900 MiB。reserve_document_file と同じ）、file_count・file_bytes はその年度の
-- ファイルの行の数と大きさ（届いたものは実際、届いていないものは申告）、orphan_count はその年度のフォルダの、どの提出にも属さない物の
-- 数（ダッシュボードのカードと要対応に使う）。呼べる人：その年度の部門長以上（違えば forbidden）
create function public.document_storage_usage(p_year_id uuid)
returns table (bucket_bytes bigint, limit_bytes bigint, file_count integer, file_bytes bigint, orphan_count integer)
language plpgsql stable security definer set search_path = '' as $$
begin
  perform private.assert_role(p_year_id, '{admin,head,deputy_head}');
  return query
    select
      (select coalesce(sum((o.metadata ->> 'size')::bigint), 0)::bigint
       from storage.objects o where o.bucket_id = 'documents'),
      943718400::bigint,
      (select count(*)::integer from public.document_files f where f.year_id = p_year_id),
      (select coalesce(sum(coalesce((o.metadata ->> 'size')::bigint, f.size)), 0)::bigint
       from public.document_files f
       left join storage.objects o on o.bucket_id = 'documents' and o.name = f.object_path
       where f.year_id = p_year_id),
      (select count(*)::integer from storage.objects o
       where o.bucket_id = 'documents' and split_part(o.name, '/', 1) = p_year_id::text
         and not exists (select 1 from public.document_files f where f.object_path = o.name));
end $$;

------------------------------------------------------------------------
-- 権限
------------------------------------------------------------------------
-- 表とビュー：authenticated に select と、提出物（documents。W の表）の insert・update・delete だけ。提出とファイルは RPC だけで書く表
-- （書き込みの権限を与えない。02 の「RPC でだけ書く表」）。anon と PUBLIC には何も与えない。Supabase の既定の権限（public スキーマの
-- 新しい表・ビューに anon・authenticated の全部）を、先に外す（0014・0015 と同じ）
revoke all on table public.documents, public.document_submissions, public.document_files,
  public.v_document_status, public.v_document_files from public, anon, authenticated;
grant select on table public.documents, public.document_submissions, public.document_files,
  public.v_document_status, public.v_document_files to authenticated;
grant insert, update, delete on table public.documents to authenticated;

-- ポリシー（storage.objects を含む）が呼ぶ集合の関数は authenticated だけが実行できる（0010・0014 と同じ）。トリガー関数と RPC の
-- 補助は誰も実行できない（DEFINER の RPC・トリガーから持ち主の権限で呼ぶ）
revoke all on function private.my_group_document_ids(), private.my_document_upload_paths(),
  private.my_document_orphan_paths() from public, anon;
grant execute on function private.my_group_document_ids(), private.my_document_upload_paths(),
  private.my_document_orphan_paths() to authenticated;
revoke all on function private.tg_documents_normalize_categories(), private.tg_documents_set_actor(),
  private.tg_documents_objects_guard(), private.lock_document_year(uuid, uuid), private.target_document(uuid, uuid, uuid)
  from public, anon, authenticated;
revoke all on all functions in schema private from public;

-- RPC は 0005 と同じ繰り返しで、authenticated だけが実行できる
do $$
declare f text;
begin
  foreach f in array array[
    'public.reserve_document_file(uuid, uuid, uuid, text, integer)',
    'public.discard_document_file(uuid)',
    'public.submit_document(uuid, uuid, timestamptz)',
    'public.withdraw_document(uuid, uuid, timestamptz)',
    'public.approve_document(uuid, uuid, text, timestamptz)',
    'public.return_document(uuid, uuid, text, timestamptz)',
    'public.previous_year_documents(uuid)',
    'public.copy_previous_documents(uuid, uuid[])',
    'public.delete_year_document_files(uuid, text)',
    'public.document_orphan_paths(uuid)',
    'public.document_storage_usage(uuid)'] loop
    execute format('revoke all on function %s from public, anon', f);
    execute format('grant execute on function %s to authenticated', f);
  end loop;
end $$;
