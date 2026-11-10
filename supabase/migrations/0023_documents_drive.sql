-- 0023_documents_drive.sql（T24。2026-11-10。D-62）：提出物をドライブへ。提出物のファイルは学校の Google Workspace のドライブ（共有ドライブの
-- フォルダ・Google フォーム）に出してもらい、アプリは提出の状態と提出先のリンクだけを持つ（Storage の容量を部屋の写真〔T25〕に空ける）。
-- 変えるもの：
--   documents.submit_url：提出先の URL を足す（任意。`https://` で始まり、空白・制御文字を含まない 500 字まで）。部門長以上が画面から直接
--                         書く（今の documents の RLS〔can_lead〕のまま。形は CHECK だけで守る）
--   requires_file       ：今の行をすべて false にし、既定値も false にする。トリガー keep_requires_file_off がいつも false にする（true を
--                         拒まずに直す。古い画面・前年度から写す・SQL Editor のどれから来ても書き込みは通る）。列は年度データの互換のために残す
--   v_document_status   ：`create or replace view` で最後に submit_url を足す（店長・副店長はこのビューを読む。ほかの列・where は 0016 のまま）
--   reserve_document_file：ロールと年度の確かめ（0016 の lock_document_year）の後、いつも invalid_state（reason: uploads_disabled）
--   copy_previous_documents：submit_url も写す（ほかは 0016 のまま）
-- 変えないもの：Storage の bucket documents とポリシー3つ・トリガー documents_objects_guard、ほかの RPC（外す・提出・取り消し・承認・差し戻し・
-- 片付け・使った量・年度のファイルの削除）。T24 の前に上がったファイルは、今までどおり読める・外せる・片付けられる・削除できる。
-- 引数・戻り値・権限は変えない（create or replace は権限を残す）。0016 の関数を置き換えるので 0016 の後（0022 の次）に当てる。

------------------------------------------------------------------------
-- 列
------------------------------------------------------------------------
-- 提出先の URL。https だけ（javascript: などをリンクにさせない）、その後に1字以上、空白（JavaScript の trim が除く 25 文字を含む）と
-- 制御文字を含まない、500 字まで。画面は前後の空白を除き、空なら null にしてから同じ形を確かめて送る
alter table public.documents add column submit_url text;
alter table public.documents add constraint documents_submit_url_check check (
  submit_url ~ '^https://.+$'
  and submit_url !~ '[[:space:][:cntrl:]   -     　﻿]'
  and length(submit_url) <= 500);

-- 「ファイルが要る」はやめる（T24）。true の行だけを直す（変わらない行の版〔updated_at〕を進めない）
alter table public.documents alter column requires_file set default false;
update public.documents set requires_file = false where requires_file;

------------------------------------------------------------------------
-- トリガー：requires_file をいつも false にする
------------------------------------------------------------------------
-- BEFORE INSERT OR UPDATE OF requires_file。どのロールでも（seed・SQL Editor も）。INVOKER（表を読まない）
create function private.tg_documents_keep_requires_file_off()
returns trigger language plpgsql set search_path = '' as $$
begin
  new.requires_file := false;
  return new;
end $$;
create trigger keep_requires_file_off before insert or update of requires_file on public.documents
  for each row execute function private.tg_documents_keep_requires_file_off();

------------------------------------------------------------------------
-- ビュー：最後に submit_url を足す（create or replace view は列を後ろに足すことだけができる。security_invoker と権限は残る）
------------------------------------------------------------------------
create or replace view public.v_document_status with (security_invoker = true) as
  select d.year_id, d.id as document_id, g.id as group_id,
         d.title, d.description, d.deadline, d.requires_file,
         coalesce(s.status, 'not_submitted'::public.document_status) as status,
         s.submitted_at, s.submitted_by, coalesce(s.proxy, false) as proxy,
         coalesce(s.submitted_at > d.deadline, false) as late,
         s.reviewed_at, s.reviewed_by, s.review_note,
         s.updated_at,
         d.submit_url
  from public.documents d
  join public.groups g on g.year_id = d.year_id
                      and g.category = any (d.target_categories)
                      and (not d.food_only or g.is_food)
  left join public.document_submissions s on s.document_id = d.id and s.group_id = g.id
  where d.year_id in (select private.my_role_year_ids('{admin,head,deputy_head,staff}'))
     or g.id in (select private.my_group_ids());

------------------------------------------------------------------------
-- RPC
------------------------------------------------------------------------
-- reserve_document_file：新しいファイルの予約を止める（T24）。エラーの順：forbidden（団体がない・その年度の部門長以上でもその団体の店長・
-- 副店長でもない）→ invalid_state（終了。detail は status）→ invalid_state（detail は reason: uploads_disabled）。入力の形・送り直しは見ない
-- （同じ file_id の送り直しも止まる）。何も書かない。引数と戻り値は 0016 のまま（型と画面の RPC の一覧を変えない）
create or replace function public.reserve_document_file(p_document_id uuid, p_group_id uuid, p_file_id uuid,
                                                        p_content_type text, p_size integer)
returns public.document_files language plpgsql security definer set search_path = '' as $$
begin
  perform private.lock_document_year(private.group_year_id(p_group_id), p_group_id);
  perform private.fail('invalid_state', jsonb_build_object('reason', 'uploads_disabled'));
  return null;
end $$;

-- copy_previous_documents：0016 と同じ（エラーの順・理由・同じ題名を飛ばす）。写すものに提出先の URL（submit_url）を足した
-- （requires_file は写すが、トリガーで false になる）
create or replace function public.copy_previous_documents(p_year_id uuid, p_document_ids uuid[])
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
    insert into public.documents (year_id, title, description, deadline, target_categories, food_only, requires_file, submit_url)
    select p_year_id, d.title, d.description,
           ((d.deadline at time zone 'Asia/Tokyo') + v_days * interval '1 day') at time zone 'Asia/Tokyo',
           d.target_categories, d.food_only, d.requires_file, d.submit_url
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
-- 権限
------------------------------------------------------------------------
-- トリガー関数は誰も実行できない（0016 の提出物のトリガー関数と同じ）。置き換えた RPC とビューの権限は create or replace で残る
revoke all on function private.tg_documents_keep_requires_file_off() from public, anon, authenticated;
