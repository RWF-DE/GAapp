-- 0017_shifts.sql（T20 の前半。2026-11-01。D-56）：シフト・作業（持ち場・シフトの時間枠・ます・割り当て・作業）の表・RLS・RPC
-- シフト・作業は総務アプリの機能の1つ（機能の id は shifts。D-51・D-52）。年度ごとに、部門長以上が次のものを作る：
--   持ち場（shift_duties）        ：シフト表の列（受付・運搬など）
--   シフトの時間枠（shift_slots）  ：シフト表の行（9:00〜10:00 など）。すべての持ち場が同じ時間枠を使い、同じ年度の時間枠は重ならない
--   ます（shift_needs）            ：時間枠×持ち場と必要人数。行がなければ、その時間枠にその持ち場はない（表では「—」）
--   割り当て（shift_assignments）  ：ますに入る人。その年度の総務だけで、同じ時間枠には1人1つの持ち場だけ
--   作業（tasks）                  ：担当者（1人。いなくてもよい）・締切・状態（未着手・作業中・完了）
-- 読めるのはその年度の総務（管理者・総務部門長・総務副部門長・総務部門員）だけで、閲覧のみ・店長・副店長には何も見せない（総務の中の
-- 当番と作業で、学生の名前が入るため）。
-- 書き込みは画面から直接（RLS。理由の要らない1つの表の書き込みなので、予定と締切〔0015〕と同じく RPC にしない。監査の理由は null）：
-- insert・update・delete は、その年度の部門長以上（admin・head・deputy_head）で、年度が終了（closed）でないとき（private.can_lead）。
-- RPC は2つだけ（理由を書き込みと同じトランザクションで置く）：
--   set_task_status：作業の状態だけを変える。担当の総務部門員も呼べる（RLS は列を分けられないので、update のポリシーは部門長以上のまま）
--   add_shift_slots：「1日分をまとめて作る」。時間枠とますの2つの表をまとめて作る
-- 振り分けの入力でないので、版（allocation_version）を増やさず、確定中の守りもない（確定中も書ける。当日に直すため）。
-- 机椅子のフェーズ2の時間枠（slots・deliveries）は使い回さない：あちらは団体への配布の時間帯（festival_day と時刻・班）で、団体代表と
-- 閲覧のみも読む（can_read_year）。使い回すと店長・副店長・閲覧のみに総務の当番が見え、机椅子の表を T20 が直すことになる（D-56）。
-- 0015 までの関数（lock_year・can_lead・my_role_year_ids・rls_applies・tg_audit・tg_immutable_columns など）だけを使い、T19 の 0016・
-- T21 の 0018 の物には依らない。足すだけで、今の表・関数・ポリシー（year_roles・remove_role・set_role・create_year_from、フェーズ2の
-- slots・deliveries を含む）は変えない。画面（/shift・/shifts・/shifts/print・/tasks とダッシュボードの分）は T20 の後半。

------------------------------------------------------------------------
-- 列挙型と表
------------------------------------------------------------------------
-- 作業の状態：未着手・作業中・完了（どの状態からどの状態へも変えられる。完了から戻すのもよい）
create type public.task_status as enum ('todo', 'doing', 'done');

-- 持ち場（シフト表の列）。名前は前後の空白を除いた形で 1〜50 字（events_title_check と同じ式。除く空白は JavaScript の
-- String.prototype.trim が除く 25 文字：タブ・LF・垂直タブ・改ページ・CR・半角の空白・U+00A0・U+1680・U+2000〜U+200A・U+2028・
-- U+2029・U+202F・U+205F・全角の空白〔U+3000〕・U+FEFF）。書き込みを RPC にしないので DB では除かず、前後に空白のある名前と空白だけの
-- 名前を拒む（23514）。画面は zod の trim（同じ 25 文字）を通してから送る。同じ年度に同じ名前の持ち場は置けない（23505）。
-- 場所（集合場所など）は任意で 100 字、説明（仕事の中身）は任意で 1000 字まで（空なら画面が null にする。D-33。字数はコードポイント）。
-- 並び（sort_order）は表の列の順（sort_order → 名前 → id。画面が並べる）。
-- unique (id, year_id) は shift_needs の複合外部キーの参照先（ますと持ち場が同じ年度であることを保証する。groups・notices と同じ）
create table public.shift_duties (
  id uuid primary key default gen_random_uuid(),
  year_id uuid not null references public.years on delete cascade,
  name text not null,
  place text,
  note text,
  sort_order integer not null default 0,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  constraint shift_duties_name_check check (name <> ''
    and name = btrim(name, E'\t\n\u000b\f\r                  　﻿')
    and length(name) <= 50),
  constraint shift_duties_place_check check (length(place) <= 100),
  constraint shift_duties_note_check check (length(note) <= 1000),
  constraint shift_duties_year_id_name_key unique (year_id, name),
  constraint shift_duties_id_year_id_key unique (id, year_id)
);
-- 年度ごとの列の並びと、ポリシーの year_id in (…) 用
create index shift_duties_year_id_idx on public.shift_duties (year_id, sort_order);

-- シフトの時間枠（シフト表の行）。開始・終わりは timestamptz で、画面は Asia/Tokyo で入力・表示する。日（シフト表のタブ）は開始の
-- Asia/Tokyo の日付で、0 時をまたぐ枠は開始の日に入る。
-- CHECK は名前の順に確かめられる（PostgreSQL は1つの表の CHECK を名前の順に評価する）ので、名前で順を決める：
--   date_range：開始・終わりの Asia/Tokyo の日付が 2000-01-01〜2200-12-31（D-18・D-54 と同じ。infinity と、JavaScript の Date で
--               扱えない日時を入れさせない）。無限の日時の引き算（下の length）より先に止める（無限の timestamptz の引き算は、
--               PostgreSQL 16 までは 22008、17 では無限の interval になる。どちらの版でも 23514 にそろえる）
--   length    ：24 時間まで（ちょうど 24 時間はよい。0 時をまたいでよい）
--   order     ：開始が終わりより前
-- 同じ年度の時間枠どうしは [開始, 終わり) が重ならない（下の no_overlap のトリガー。隣り合う 9:00〜10:00 と 10:00〜11:00 はよい）。
-- 時刻の式は timezone('Asia/Tokyo', …)（AT TIME ZONE。タイムゾーンを名前で渡すので、セッションの TimeZone によらない）と date への
-- 変換だけ。unique (id, year_id) は shift_needs の複合外部キーの参照先
create table public.shift_slots (
  id uuid primary key default gen_random_uuid(),
  year_id uuid not null references public.years on delete cascade,
  starts_at timestamptz not null,
  ends_at timestamptz not null,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  constraint shift_slots_date_range_check check (
    (starts_at at time zone 'Asia/Tokyo')::date between date '2000-01-01' and date '2200-12-31'
    and (ends_at at time zone 'Asia/Tokyo')::date between date '2000-01-01' and date '2200-12-31'),
  constraint shift_slots_length_check check (ends_at - starts_at <= interval '24 hours'),
  constraint shift_slots_order_check check (starts_at < ends_at),
  constraint shift_slots_id_year_id_key unique (id, year_id)
);
-- 年度ごとの一覧（早い順）と、重なりの確かめ・ポリシーの year_id in (…) 用
create index shift_slots_year_id_idx on public.shift_slots (year_id, starts_at);

-- ます（時間枠×持ち場）と必要人数（0〜100。0 は「人数を決めない」）。行がなければ、その時間枠にその持ち場はない（表では「—」）。
-- 複合外部キーで、ますと時間枠・持ち場が同じ年度であることを保証する。時間枠・持ち場を消すと、ます（と、その割り当て）も消える。
-- unique (slot_id, duty_id, year_id) は shift_assignments の複合外部キーの参照先（割り当てとますが同じ年度であることを保証する）。
-- 索引は主キーだけにする（1年に 250 行ほどの見込みで、持ち場の削除の連鎖〔duty_id で引く〕も、年度で絞った読みも小さい）
create table public.shift_needs (
  year_id uuid not null references public.years on delete cascade,
  slot_id uuid not null,
  duty_id uuid not null,
  required_count integer not null default 0,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  primary key (slot_id, duty_id),
  constraint shift_needs_required_count_check check (required_count between 0 and 100),
  constraint shift_needs_slot_id_duty_id_year_id_key unique (slot_id, duty_id, year_id),
  constraint shift_needs_slot_fkey foreign key (slot_id, year_id)
    references public.shift_slots (id, year_id) on delete cascade,
  constraint shift_needs_duty_fkey foreign key (duty_id, year_id)
    references public.shift_duties (id, year_id) on delete cascade
);

-- 割り当て（ますに入る人）。主キー (slot_id, user_id) で、同じ時間枠に同じ人は1行だけ（1人1つの持ち場）。時間枠は重ならないので、
-- 同じ人が同じ時刻に2か所にいることを、この主キーの 23505 が止める（トリガーも勧告的ロックも要らない。D-56）。
-- ほかの持ち場へ移すときは duty_id を update で変える（消してから足さない。移す先のますがあることは外部キーが確かめる）。
-- 入る人はその年度の総務だけ：外部キー (year_id, user_id) → year_roles で、その年度のロールがあることを（ロールを外すと割り当ても
-- 消える。on delete cascade）、下の member_check のトリガーで、総務のロールであることを確かめる。
-- 索引：自分の割り当て（year_id, user_id。ロールを外したときの連鎖も引く）と、ますごとの人（slot_id, duty_id。ますの削除の連鎖）
create table public.shift_assignments (
  year_id uuid not null references public.years on delete cascade,
  slot_id uuid not null,
  duty_id uuid not null,
  user_id uuid not null,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  primary key (slot_id, user_id),
  constraint shift_assignments_need_fkey foreign key (slot_id, duty_id, year_id)
    references public.shift_needs (slot_id, duty_id, year_id) on delete cascade,
  constraint shift_assignments_member_fkey foreign key (year_id, user_id)
    references public.year_roles (year_id, user_id) on delete cascade
);
create index shift_assignments_year_id_user_id_idx on public.shift_assignments (year_id, user_id);
create index shift_assignments_slot_id_duty_id_idx on public.shift_assignments (slot_id, duty_id);

-- 作業。題名は前後の空白を除いた形で 1〜100 字（持ち場の名前・events の題名と同じ式）、説明は任意で 2000 字まで（空なら画面が
-- null にする）。
-- 担当者（assignee_id）は1人で、いなくてもよい（null）。担当者はその年度の総務だけ（外部キー (year_id, assignee_id) → year_roles と、
-- 下の member_check のトリガー）。外部キーは MATCH SIMPLE なので、担当者が null なら確かめない。ロールを外すと、担当者の列だけが
-- 空になる（on delete set null (assignee_id)。year_id は残す。状態はそのまま）。
-- 締切（due_at）は任意の日時（画面の時刻の既定は 17:00）。Asia/Tokyo の日付は 2000-01-01〜2200-12-31（時間枠と同じ理由）。
-- 状態は作ったときは未着手。担当の総務部門員は RPC set_task_status だけで変える（下の RLS）。
-- 書いた人・直した人（created_by・updated_by）と日時（created_at・updated_at）は DB が入れる（下の set_actor・set_timestamps）。
-- 索引：締切の順（year_id, due_at）と、担当者ごと（year_id, assignee_id。ロールを外したときの set null の連鎖も引く）
create table public.tasks (
  id uuid primary key default gen_random_uuid(),
  year_id uuid not null references public.years on delete cascade,
  title text not null,
  note text,
  assignee_id uuid,
  due_at timestamptz,
  status public.task_status not null default 'todo',
  created_by uuid references auth.users on delete set null,
  updated_by uuid references auth.users on delete set null,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  constraint tasks_title_check check (title <> ''
    and title = btrim(title, E'\t\n\u000b\f\r                  　﻿')
    and length(title) <= 100),
  constraint tasks_note_check check (length(note) <= 2000),
  constraint tasks_due_at_check check (
    (due_at at time zone 'Asia/Tokyo')::date between date '2000-01-01' and date '2200-12-31'),
  constraint tasks_assignee_fkey foreign key (year_id, assignee_id)
    references public.year_roles (year_id, user_id) on delete set null (assignee_id)
);
create index tasks_year_id_due_at_idx on public.tasks (year_id, due_at);
create index tasks_year_id_assignee_id_idx on public.tasks (year_id, assignee_id);

alter table public.shift_duties enable row level security;
alter table public.shift_slots enable row level security;
alter table public.shift_needs enable row level security;
alter table public.shift_assignments enable row level security;
alter table public.tasks enable row level security;

------------------------------------------------------------------------
-- トリガー
------------------------------------------------------------------------
-- BEFORE ROW のトリガーは名前の順に動く（年度の付け替えを先に止めてから、重なり・総務かを確かめる）：
--   shift_slots       ：check_immutable → no_overlap → set_timestamps
--   shift_assignments ：check_immutable → member_check → set_timestamps
--   tasks             ：check_immutable → member_check → set_actor → set_timestamps
-- 版の増分（bump_version_*）と確定中・終了の守り（lock_year_guard）は付けない（振り分けの入力でない。終了の年度の読み取り専用は、
-- 下の書き込みのポリシー〔can_lead〕と RPC の invalid_state が守る。SQL Editor〔postgres〕からは終了の年度でも書ける。予定と締切と同じ）

-- 日時（0002 の共通の関数。クライアントが送った created_at・updated_at は使わない）
create trigger set_timestamps before insert or update on public.shift_duties
  for each row execute function private.tg_set_timestamps();
create trigger set_timestamps before insert or update on public.shift_slots
  for each row execute function private.tg_set_timestamps();
create trigger set_timestamps before insert or update on public.shift_needs
  for each row execute function private.tg_set_timestamps();
create trigger set_timestamps before insert or update on public.shift_assignments
  for each row execute function private.tg_set_timestamps();
create trigger set_timestamps before insert or update on public.tasks
  for each row execute function private.tg_set_timestamps();

-- 監査（D-11。0002 の tg_audit。year_id は行から、group_id は null）。理由は、画面からの直接の書き込みでは null、RPC では
-- 「作業の状態」「シフトの時間枠」、ロールを外したときの連鎖（割り当ての削除・担当者を空にする）では remove_role の理由。
-- row_pk は持ち場・時間枠・作業が id、ますが slot_id・duty_id、割り当てが slot_id・user_id
create trigger audit after insert or update or delete on public.shift_duties
  for each row execute function private.tg_audit('id');
create trigger audit after insert or update or delete on public.shift_slots
  for each row execute function private.tg_audit('id');
create trigger audit after insert or update or delete on public.shift_needs
  for each row execute function private.tg_audit('slot_id,duty_id');
create trigger audit after insert or update or delete on public.shift_assignments
  for each row execute function private.tg_audit('slot_id,user_id');
create trigger audit after insert or update or delete on public.tasks
  for each row execute function private.tg_audit('id');

-- 年度の付け替えを止める（D-16。0002 の tg_immutable_columns〔0004 で DEFINER〕。invalid_input）。ます（shift_needs）は時間枠・
-- 持ち場も変えられない（ますの付け替えは、消して作り直す）。割り当ては year_id だけを止める（ほかの持ち場へ移すときに duty_id を
-- 変える。移す先のますがあることと二重の割り当てでないことは、外部キーと主キーが確かめる）
create trigger check_immutable before update of year_id on public.shift_duties
  for each row execute function private.tg_immutable_columns('year_id');
create trigger check_immutable before update of year_id on public.shift_slots
  for each row execute function private.tg_immutable_columns('year_id');
create trigger check_immutable before update of year_id, slot_id, duty_id on public.shift_needs
  for each row execute function private.tg_immutable_columns('year_id', 'slot_id', 'duty_id');
create trigger check_immutable before update of year_id on public.shift_assignments
  for each row execute function private.tg_immutable_columns('year_id');
create trigger check_immutable before update of year_id on public.tasks
  for each row execute function private.tg_immutable_columns('year_id');

-- 時間枠の重なり：同じ年度に [開始, 終わり) が重なる2つの時間枠を置かない（隣り合う 9:00〜10:00 と 10:00〜11:00 はよい）。
-- 他の表・他の行を参照する CHECK は使わない決まりなので、BEFORE ROW のトリガーで確かめる（insert と、開始・終わりの update）。
-- 同時に重なる時間枠を足す2人が、どちらも相手の行を見ずに入れないように、年度ごとの勧告的ロック（int4 の鍵2つ。トランザクションの
-- 終わりまで持つ）を取ってから確かめる。ロックを取る文と確かめる文を分ける（READ COMMITTED：VOLATILE の関数の中の文ごとに新しい
-- スナップショットになるので、ロックを待つ間に確定した時間枠も次の文で見える。0013 の兼任の禁止と同じ）。年度の行はロックしない
-- （lock_year〔for no key update〕と外部キーの for key share はぶつからないので、時間枠の直接の書き込みは、振り分けの保存や状態の
-- 遷移を待たない。add_shift_slots は年度の行 → このロックの順に取る）。
-- 重なれば invalid_input（field: starts_at、reason: overlap、slot_id: 重なる時間枠のうち開始の早い順・id の順で最初のもの）。
-- 確かめないもの（ロックも取らない）：
--   - 書けない人（anon・authenticated で can_lead でない人）の書き込み：拒否を RLS に任せる（BEFORE ROW のトリガーはポリシーの
--     with check より先に動くので、書けない人にロックを取らせない。0004 の守りのトリガーと同じ。書けない人が重なりの有無で、読めない
--     時間枠を知ることもない）。SQL Editor（postgres）と RPC の中（role は authenticated のまま。add_shift_slots を呼べるのは部門長
--     以上）は確かめる
--   - CHECK が拒む値（時刻の順が違う・null・日付の範囲の外・24 時間より長い）：CHECK（と NOT NULL）に任せる（重なりと取り違えた文言を
--     出さない。範囲の外の値で日時の計算をしない）。範囲の境目は shift_slots_date_range_check と同じ（Asia/Tokyo は 2000 年より後は
--     ずっと +09:00 なので、開始が 2000-01-01 00:00+09 以後で、終わりが 2201-01-01 00:00+09 より前なら、両方の日付が範囲の中）
create function private.tg_shift_slots_no_overlap()
returns trigger language plpgsql security definer set search_path = '' as $$
declare v_other uuid;
begin
  if private.rls_applies() and not private.can_lead(new.year_id) then
    return new;
  end if;
  if not coalesce(new.starts_at < new.ends_at, false)
     or new.starts_at < timestamptz '2000-01-01 00:00:00+09'
     or new.ends_at >= timestamptz '2201-01-01 00:00:00+09' then
    return new;
  end if;
  if new.ends_at - new.starts_at > interval '24 hours' then
    return new;
  end if;
  perform pg_advisory_xact_lock(hashtext('gaapp.shift_slots'), hashtext(new.year_id::text));
  select s.id into v_other from public.shift_slots s
  where s.year_id = new.year_id and s.id <> new.id
    and s.starts_at < new.ends_at and new.starts_at < s.ends_at
  order by s.starts_at, s.id
  limit 1;
  if v_other is not null then
    perform private.fail('invalid_input', jsonb_build_object('field', 'starts_at', 'reason', 'overlap', 'slot_id', v_other));
  end if;
  return new;
end $$;
create trigger no_overlap before insert or update of starts_at, ends_at on public.shift_slots
  for each row execute function private.tg_shift_slots_no_overlap();

-- その年度の総務（admin・head・deputy_head・staff）か。任意の人について答えるので、誰にも execute を与えない（下の member_check の
-- 中からだけ呼ぶ。0013 の兼任の禁止の補助と同じ）。year_roles の行を for share で読む：閲覧のみへのロールの変更（set_role）・ロールを
-- 外すこと（remove_role）と同時の割り当てを、year_roles の行で順にする（割り当てる側が先なら、remove_role はそれを待ってから消し、
-- 連鎖で入ったばかりの割り当ても消す。ロールの変更が先なら、待った後の行〔なくなった・閲覧のみになった〕を読んで not_soumu）。
-- VOLATILE（既定のまま。for share は STABLE の関数では使えず、待った後の値を読むため）。行がなければ false（招待されていない人・
-- ほかの年度だけの人。外部キーの 23503 より先に not_soumu で止まる）
create function private.year_member_is_soumu(p_year_id uuid, p_user_id uuid)
returns boolean language plpgsql security definer set search_path = '' as $$
declare v_role public.app_role;
begin
  select yr.role into v_role from public.year_roles yr
  where yr.year_id = p_year_id and yr.user_id = p_user_id
  for share;
  return coalesce(v_role in ('admin', 'head', 'deputy_head', 'staff'), false);
end $$;

-- 割り当てる人（shift_assignments.user_id）と作業の担当者（tasks.assignee_id）は、その年度の総務だけ（tg_argv[0] は列の名前）。
-- 閲覧のみ・店長・副店長だけの人・招待されていない人・ほかの年度だけの人は invalid_input（field: 列の名前、reason: not_soumu）。
-- 外部キー（year_roles の行があること）だけでは閲覧のみを止められず、他の表を参照する CHECK は使わない決まりなので、トリガーにする。
-- 確かめないもの（year_roles を読まず、ロックも取らない）：
--   - null（担当者のいない作業）
--   - 値が変わらない update（担当者を変えずに作業を直す書き込みが、year_roles の行を待たない。set_role で閲覧のみに変わった人の
--     割り当て・担当は残し〔D-56〕、画面が「総務でない人」と出す）
--   - 書けない人（anon・authenticated で can_lead でない人）の書き込み：拒否を RLS に任せる（ロックを取らせず、総務部門員が自分の
--     読めない year_roles のロールを not_soumu と 42501 の違いで知らないように。no_overlap と同じ）
-- private.fail を呼ぶので DEFINER（authenticated は private.fail を実行できない。0004 の tg_immutable_columns と同じ）
create function private.tg_soumu_member_check()
returns trigger language plpgsql security definer set search_path = '' as $$
declare
  v_col constant text := tg_argv[0];
  v_user uuid := (to_jsonb(new) ->> v_col)::uuid;
begin
  if v_user is null then
    return new;
  end if;
  if tg_op = 'UPDATE' and v_user is not distinct from (to_jsonb(old) ->> v_col)::uuid then
    return new;
  end if;
  if private.rls_applies() and not private.can_lead(new.year_id) then
    return new;
  end if;
  if not private.year_member_is_soumu(new.year_id, v_user) then
    perform private.fail('invalid_input', jsonb_build_object('field', v_col, 'reason', 'not_soumu'));
  end if;
  return new;
end $$;
create trigger member_check before insert or update of user_id on public.shift_assignments
  for each row execute function private.tg_soumu_member_check('user_id');
create trigger member_check before insert or update of assignee_id on public.tasks
  for each row execute function private.tg_soumu_member_check('assignee_id');

-- 作業を書いた人・直した人：ログインしている人の書き込み（RPC の中と、ロールを外したときの担当者の連鎖も）では DB が auth.uid() を
-- 入れる（クライアントの値は使わない。created_by は最初に書いた人のまま）。seed・SQL Editor（auth.uid() が null）では入れた値のまま
-- （D-10。0015 の tg_events_set_actor と同じ中身で、表ごとの関数にする）。auth.uid() を読むだけで private.fail を呼ばないので
-- INVOKER でよい
create function private.tg_tasks_set_actor()
returns trigger language plpgsql set search_path = '' as $$
begin
  if auth.uid() is not null then
    if tg_op = 'INSERT' then
      new.created_by := auth.uid();
    else
      new.created_by := old.created_by;
    end if;
    new.updated_by := auth.uid();
  end if;
  return new;
end $$;
create trigger set_actor before insert or update on public.tasks
  for each row execute function private.tg_tasks_set_actor();

------------------------------------------------------------------------
-- RLS
------------------------------------------------------------------------
-- 読み取り：D-47 の形（呼んだ人の年度の集合を問い合わせごとに1回だけ作り、行ごとに判定関数を呼ばない。0010 の my_role_year_ids）。
-- その年度の総務は5表の全部を読む（総務部門員も、シフト表の全体〔ほかの人・足りないます〕とほかの人の作業を見られる。D-56）。
-- 閲覧のみ・店長・副店長・ロールのない人は何も読めない。読み取りは年度の状態によらない（終了した年度も読める）。判定関数・集合の
-- 関数は足さない。
-- 書き込み：その年度の部門長以上で、年度が closed でない（0013 の can_lead。events・slots と同じ）。書き込みのポリシーは行ごとの
-- 形のまま（D-47）。update は using と with check に同じ述語を書く（year_id は check_immutable で変えられない）。書けない人の
-- insert は 42501、update・delete は 0 行（画面は読み直して分ける。04 の (B1)）。総務部門員は作業の状態も直接は変えられない
-- （RPC set_task_status だけ）。ポリシーは5表×4 の 20 個
create policy shift_duties_select on public.shift_duties for select to authenticated
  using (year_id in (select private.my_role_year_ids('{admin,head,deputy_head,staff}')));
create policy shift_duties_insert on public.shift_duties for insert to authenticated
  with check (private.can_lead(year_id));
create policy shift_duties_update on public.shift_duties for update to authenticated
  using (private.can_lead(year_id)) with check (private.can_lead(year_id));
create policy shift_duties_delete on public.shift_duties for delete to authenticated
  using (private.can_lead(year_id));

create policy shift_slots_select on public.shift_slots for select to authenticated
  using (year_id in (select private.my_role_year_ids('{admin,head,deputy_head,staff}')));
create policy shift_slots_insert on public.shift_slots for insert to authenticated
  with check (private.can_lead(year_id));
create policy shift_slots_update on public.shift_slots for update to authenticated
  using (private.can_lead(year_id)) with check (private.can_lead(year_id));
create policy shift_slots_delete on public.shift_slots for delete to authenticated
  using (private.can_lead(year_id));

create policy shift_needs_select on public.shift_needs for select to authenticated
  using (year_id in (select private.my_role_year_ids('{admin,head,deputy_head,staff}')));
create policy shift_needs_insert on public.shift_needs for insert to authenticated
  with check (private.can_lead(year_id));
create policy shift_needs_update on public.shift_needs for update to authenticated
  using (private.can_lead(year_id)) with check (private.can_lead(year_id));
create policy shift_needs_delete on public.shift_needs for delete to authenticated
  using (private.can_lead(year_id));

create policy shift_assignments_select on public.shift_assignments for select to authenticated
  using (year_id in (select private.my_role_year_ids('{admin,head,deputy_head,staff}')));
create policy shift_assignments_insert on public.shift_assignments for insert to authenticated
  with check (private.can_lead(year_id));
create policy shift_assignments_update on public.shift_assignments for update to authenticated
  using (private.can_lead(year_id)) with check (private.can_lead(year_id));
create policy shift_assignments_delete on public.shift_assignments for delete to authenticated
  using (private.can_lead(year_id));

create policy tasks_select on public.tasks for select to authenticated
  using (year_id in (select private.my_role_year_ids('{admin,head,deputy_head,staff}')));
create policy tasks_insert on public.tasks for insert to authenticated
  with check (private.can_lead(year_id));
create policy tasks_update on public.tasks for update to authenticated
  using (private.can_lead(year_id)) with check (private.can_lead(year_id));
create policy tasks_delete on public.tasks for delete to authenticated
  using (private.can_lead(year_id));

------------------------------------------------------------------------
-- RPC
------------------------------------------------------------------------
-- set_task_status：作業の状態だけを変える（総務で、その作業の担当者か部門長以上）。RLS は列を分けられないので、担当の総務部門員が
-- 状態だけを変えるための RPC（update のポリシーは部門長以上のまま）。どの状態からどの状態へも変えられる（完了から戻すのもよい）。
-- 同じ状態でも書き、updated_at・updated_by を進める（save_notice の「何も変わらなくても書く」と同じ。画面は今の状態のボタンを
-- 押せなくするので、ふつうは起きない）。返り値は作業の行（画面は返った updated_at を次の p_base_updated_at に使う）。
-- エラーの順番（pgTAP の 028 はこの順で確かめる。notes/T20.md）：
--   1. 作業がない・その作業の年度の総務でない → forbidden（作業の有無を漏らさない。delete_notice と同じ）。終了の年度 → invalid_state
--      （lock_year。担当者が set_role で閲覧のみに変わった作業は、本人はここで止まる。部門長以上は変えられる）
--   2. p_status が null → invalid_input（field: status）。p_base_updated_at が null → invalid_input（field: base_updated_at）
--   3. 年度の行のロックを待つ間に作業が消えた → not_found（呼んだ人はその年度の総務で、その作業を読めた。delete_notice と同じ。
--      消えた作業の update が 0 行で黙って成功しないように）
--   4. 担当者でも部門長以上でもない → forbidden（担当者のいない作業は部門長以上だけ）
--   5. 楽観ロック：p_base_updated_at がその行の updated_at と違う（ミリ秒までで比べる）→ conflict（detail は id）
--   6. 理由「作業の状態」を置き、status だけを書く（updated_by は set_actor が呼んだ人にする）
-- 確定中も変えられる（当日に直すため）。ロックは年度の行（lock_year）→ 作業の行（for update）の順に取る
create function public.set_task_status(p_task_id uuid, p_status public.task_status, p_base_updated_at timestamptz)
returns public.tasks language plpgsql security definer set search_path = '' as $$
declare
  v_year_id uuid := (select t.year_id from public.tasks t where t.id = p_task_id);
  v_old public.tasks;
  v public.tasks;
begin
  perform private.lock_year(v_year_id, '{preparing,requesting,allocating,confirmed}', '{admin,head,deputy_head,staff}');
  if p_status is null then
    perform private.fail('invalid_input', jsonb_build_object('field', 'status'));
  end if;
  if p_base_updated_at is null then
    perform private.fail('invalid_input', jsonb_build_object('field', 'base_updated_at'));
  end if;
  select * into v_old from public.tasks t where t.id = p_task_id for update;
  if not found then
    perform private.fail('not_found');
  end if;
  if v_old.assignee_id is distinct from auth.uid() and not private.has_any_role(v_year_id, '{admin,head,deputy_head}') then
    perform private.fail('forbidden');
  end if;
  if date_trunc('milliseconds', v_old.updated_at) is distinct from date_trunc('milliseconds', p_base_updated_at) then
    perform private.fail('conflict', jsonb_build_object('id', v_old.id));
  end if;
  perform private.set_reason('作業の状態');
  update public.tasks set status = p_status where id = v_old.id returning * into v;
  return v;
end $$;

-- add_shift_slots：「1日分をまとめて作る」（部門長以上）。時間枠（p_slots）と、作った時間枠のすべてに同じ持ち場のます（p_needs）を
-- 1回で作る（2つの表をまとめて変えるので RPC。理由は「シフトの時間枠」）。返り値は作った時間枠（開始の早い順）。
--   p_slots：[{"starts_at": "2027-10-15T09:00:00+09:00", "ends_at": "2027-10-15T10:00:00+09:00"}, …]（1〜96 個）。日時は ISO 8601 で
--            オフセットつきだけを受け付ける（オフセットのない日時をセッションのタイムゾーン〔UTC〕で読んで 9 時間ずらさない。'now'・
--            'infinity' などの特別な値も通さない。update_requests_after_deadline の submittedAt と同じ式。画面の zod の
--            z.iso.datetime({ offset: true }) と同じ）
--   p_needs：[{"duty_id": "<uuid>", "required_count": 1}, …]（0〜100 個。null〔SQL の null と JSON の null〕は空と同じで、時間枠だけを
--            作る〔ますは「—」〕）。required_count は 0〜100 の整数の JSON の数
-- エラーの順番（detail の ord は送った配列の中の番号。1 から。save_auto_allocations の ord と同じ数え方。pgTAP の 028 はこの順で
-- 確かめる。notes/T20.md）：
--   1. 年度がない・その年度の部門長以上でない → forbidden。終了の年度 → invalid_state（lock_year）
--   2. p_slots が null・配列でない・空 → invalid_input {field: slots, reason: required}。97 個以上 → {field: slots, reason: too_many}
--   3. 時間枠ごと（送った順。1つの時間枠について、下の4つをこの順に見てから次の時間枠へ進む）：
--      object でない・starts_at か ends_at が文字列でない・オフセットつきの日時として読めない → {field: slots, reason: invalid, ord}
--      開始が終わりより前でない → {…, reason: order, ord}。24 時間より長い → {…, reason: too_long, ord}
--      開始・終わりの Asia/Tokyo の日付が 2000-01-01〜2200-12-31 の外 → {…, reason: out_of_range, ord}
--      （表の CHECK と同じ決まりを、CHECK より先に、どの時間枠かが分かる形で返す）
--   4. 送った時間枠どうしが重なる（開始の順〔同じなら送った順〕に並べ、前の時間枠の終わりより前に始まる。並べた隣どうしで確かめれば、
--      どこかで重なっていれば必ず見つかる）→ {field: slots, reason: overlap, ord}（ord は、並べた順で最初に見つかった重なる2つのうち、
--      送った順で後のもの）
--   5. p_needs：配列でない → {field: needs, reason: invalid}。101 個以上 → {field: needs, reason: too_many}。
--      要素ごと（送った順。全部の要素の形を先に見る）：object でない・duty_id が uuid の文字列でない・required_count が 0〜100 の整数の
--      JSON の数でない → {field: needs, reason: invalid, ord}
--      同じ持ち場が2回 → {field: needs, reason: duplicate, ord}（ord は2回目以降の要素のうち、送った順で最初のもの）
--      その年度の持ち場でない（ほかの年度の持ち場・ない持ち場）→ {field: needs, reason: not_in_year, ord}（送った順で最初のもの）
--   6. 理由を置き、時間枠を開始の早い順に1つずつ insert する（今ある時間枠と重なれば、no_overlap のトリガーが
--      {field: starts_at, reason: overlap, slot_id}。slot_id は今ある時間枠）。作った時間枠ごとに、p_needs の並びでますを insert する
--   7. 確かめた後に持ち場が消えた（23503。ほかの部門長以上の削除と重なった）→ {field: needs, reason: not_in_year}。CHECK の違反
--      （23514）と形の誤り（22xxx）→ {field: slots, reason: invalid}（どれも確かめの後なので、ふつうは起きない）
-- どのエラーでも何も残らない（1つのトランザクション）。冪等の鍵はない（応答が届かなかったら、画面はその日の時間枠を読み直して
-- 確かめてから送り直す。04 の (B2)）。確定中も作れる（当日に直すため）。
-- ロックは年度の行（lock_year の for no key update）→ 年度ごとの勧告的ロック（no_overlap）→ 時間枠とますの行の順に取る
create function public.add_shift_slots(p_year_id uuid, p_slots jsonb, p_needs jsonb default '[]'::jsonb)
returns setof public.shift_slots language plpgsql security definer set search_path = '' as $$
declare
  -- オフセットつきの ISO 8601 の日時（0013 の update_requests_after_deadline の submittedAt と同じ式。直すときは両方を直す）
  c_datetime constant text := '^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}(:\d{2}(\.\d+)?)?(Z|[+-]\d{2}(:?\d{2})?)$';
  v_needs jsonb := case when p_needs is null or p_needs = 'null'::jsonb then '[]'::jsonb else p_needs end;
  v_starts timestamptz[] := '{}';
  v_ends timestamptz[] := '{}';
  v_duty_ids uuid[] := '{}';
  v_counts integer[] := '{}';
  v_item jsonb;
  v_ord integer;
  v_bad integer;
  v_count numeric;
  v_slot public.shift_slots;
  r record;
begin
  -- 1. ロールと状態
  perform private.lock_year(p_year_id, '{preparing,requesting,allocating,confirmed}', '{admin,head,deputy_head}');

  -- 2. 時間枠の数（大きな配列を読む前に見る）
  if p_slots is null or jsonb_typeof(p_slots) <> 'array' or jsonb_array_length(p_slots) = 0 then
    perform private.fail('invalid_input', jsonb_build_object('field', 'slots', 'reason', 'required'));
  end if;
  if jsonb_array_length(p_slots) > 96 then
    perform private.fail('invalid_input', jsonb_build_object('field', 'slots', 'reason', 'too_many'));
  end if;

  -- 3. 時間枠ごと。日時の変換の誤り（22xxx。正規表現は通るが、13 月・25 時・+99:00 などの読めない値）は、その時間枠の invalid に
  -- する（v_ord は副トランザクションを取り消しても残る。整数の FOR の変数はループの中だけのものなので、別の変数に写す）
  begin
    for i in 1 .. jsonb_array_length(p_slots) loop
      v_ord := i;
      v_item := p_slots -> (i - 1);
      if jsonb_typeof(v_item) <> 'object'
         or jsonb_typeof(v_item -> 'starts_at') is distinct from 'string'
         or jsonb_typeof(v_item -> 'ends_at') is distinct from 'string'
         or (v_item ->> 'starts_at') !~ c_datetime
         or (v_item ->> 'ends_at') !~ c_datetime then
        perform private.fail('invalid_input', jsonb_build_object('field', 'slots', 'reason', 'invalid', 'ord', i));
      end if;
      v_starts[i] := (v_item ->> 'starts_at')::timestamptz;
      v_ends[i] := (v_item ->> 'ends_at')::timestamptz;
      if not (v_starts[i] < v_ends[i]) then
        perform private.fail('invalid_input', jsonb_build_object('field', 'slots', 'reason', 'order', 'ord', i));
      end if;
      if v_ends[i] - v_starts[i] > interval '24 hours' then
        perform private.fail('invalid_input', jsonb_build_object('field', 'slots', 'reason', 'too_long', 'ord', i));
      end if;
      if (v_starts[i] at time zone 'Asia/Tokyo')::date not between date '2000-01-01' and date '2200-12-31'
         or (v_ends[i] at time zone 'Asia/Tokyo')::date not between date '2000-01-01' and date '2200-12-31' then
        perform private.fail('invalid_input', jsonb_build_object('field', 'slots', 'reason', 'out_of_range', 'ord', i));
      end if;
    end loop;
  exception when data_exception then
    perform private.fail('invalid_input', jsonb_build_object('field', 'slots', 'reason', 'invalid', 'ord', v_ord));
  end;

  -- 4. 送った時間枠どうしの重なり
  select greatest(x.ord, x.prev_ord)::integer into v_bad
  from (select t.ord, t.s, lag(t.e) over w as prev_e, lag(t.ord) over w as prev_ord
        from unnest(v_starts, v_ends) with ordinality as t(s, e, ord)
        window w as (order by t.s, t.ord)) x
  where x.s < x.prev_e
  order by x.s, x.ord
  limit 1;
  if v_bad is not null then
    perform private.fail('invalid_input', jsonb_build_object('field', 'slots', 'reason', 'overlap', 'ord', v_bad));
  end if;

  -- 5. ます（持ち場と必要人数）。uuid の変換の誤り（22P02）は、その要素の invalid にする
  if jsonb_typeof(v_needs) <> 'array' then
    perform private.fail('invalid_input', jsonb_build_object('field', 'needs', 'reason', 'invalid'));
  end if;
  if jsonb_array_length(v_needs) > 100 then
    perform private.fail('invalid_input', jsonb_build_object('field', 'needs', 'reason', 'too_many'));
  end if;
  begin
    for i in 1 .. jsonb_array_length(v_needs) loop
      v_ord := i;
      v_item := v_needs -> (i - 1);
      if jsonb_typeof(v_item) <> 'object'
         or jsonb_typeof(v_item -> 'duty_id') is distinct from 'string'
         or jsonb_typeof(v_item -> 'required_count') is distinct from 'number' then
        perform private.fail('invalid_input', jsonb_build_object('field', 'needs', 'reason', 'invalid', 'ord', i));
      end if;
      v_count := (v_item ->> 'required_count')::numeric;
      if v_count <> trunc(v_count) or v_count not between 0 and 100 then
        perform private.fail('invalid_input', jsonb_build_object('field', 'needs', 'reason', 'invalid', 'ord', i));
      end if;
      v_duty_ids[i] := (v_item ->> 'duty_id')::uuid;
      v_counts[i] := v_count::integer;
    end loop;
  exception when data_exception then
    perform private.fail('invalid_input', jsonb_build_object('field', 'needs', 'reason', 'invalid', 'ord', v_ord));
  end;
  select min(x.ord)::integer into v_bad
  from (select t.ord, row_number() over (partition by t.duty_id order by t.ord) as n
        from unnest(v_duty_ids) with ordinality as t(duty_id, ord)) x
  where x.n > 1;
  if v_bad is not null then
    perform private.fail('invalid_input', jsonb_build_object('field', 'needs', 'reason', 'duplicate', 'ord', v_bad));
  end if;
  select min(t.ord)::integer into v_bad
  from unnest(v_duty_ids) with ordinality as t(duty_id, ord)
  where not exists (select 1 from public.shift_duties d where d.id = t.duty_id and d.year_id = p_year_id);
  if v_bad is not null then
    perform private.fail('invalid_input', jsonb_build_object('field', 'needs', 'reason', 'not_in_year', 'ord', v_bad));
  end if;

  -- 6. 理由を置いて作る（今ある時間枠との重なりは no_overlap のトリガーの invalid_input がそのまま出る）
  perform private.set_reason('シフトの時間枠');
  begin
    for r in select t.s, t.e from unnest(v_starts, v_ends) as t(s, e) order by t.s loop
      insert into public.shift_slots (year_id, starts_at, ends_at)
      values (p_year_id, r.s, r.e)
      returning * into v_slot;
      insert into public.shift_needs (year_id, slot_id, duty_id, required_count)
      select p_year_id, v_slot.id, n.duty_id, n.required_count
      from unnest(v_duty_ids, v_counts) with ordinality as n(duty_id, required_count, ord)
      order by n.ord;
      return next v_slot;
    end loop;
  exception
    -- 7. 確かめた後の変化（ふつうは起きない）
    when foreign_key_violation then                  -- 持ち場が消えた（ほかの部門長以上の削除と重なった）
      perform private.fail('invalid_input', jsonb_build_object('field', 'needs', 'reason', 'not_in_year'));
    when check_violation or data_exception then      -- 23514・22xxx（D-19）
      perform private.fail('invalid_input', jsonb_build_object('field', 'slots', 'reason', 'invalid'));
  end;
  return;
end $$;

------------------------------------------------------------------------
-- 権限
------------------------------------------------------------------------
-- 表：authenticated に select・insert・update・delete（02 の W の表。truncate・references・trigger は与えない）。anon と PUBLIC には
-- 何も与えない。Supabase の既定の権限（public スキーマの新しい表に anon・authenticated の全部）を、先に外す（0014・0015 と同じ）
revoke all on table public.shift_duties, public.shift_slots, public.shift_needs, public.shift_assignments, public.tasks
  from public, anon, authenticated;
grant select, insert, update, delete on table public.shift_duties, public.shift_slots, public.shift_needs,
  public.shift_assignments, public.tasks to authenticated;

-- トリガー関数と「総務か」の補助は誰も実行できない（判定関数・集合の関数は足さない。authenticated が実行できる private の関数の
-- 数は変わらない）
revoke all on function private.tg_shift_slots_no_overlap(), private.tg_soumu_member_check(), private.tg_tasks_set_actor(),
  private.year_member_is_soumu(uuid, uuid) from public, anon, authenticated;
revoke all on all functions in schema private from public;

-- RPC は 0005 と同じ繰り返しで、authenticated だけが実行できる
do $$
declare f text;
begin
  foreach f in array array[
    'public.set_task_status(uuid, public.task_status, timestamptz)',
    'public.add_shift_slots(uuid, jsonb, jsonb)'] loop
    execute format('revoke all on function %s from public, anon', f);
    execute format('grant execute on function %s to authenticated', f);
  end loop;
end $$;
