-- 0015_events.sql（T18 の前半。2026-10-31。D-54）：予定と締切（events）の表・RLS
-- 予定と締切は総務アプリの機能の1つ（D-51・D-52）。年度ごとに、部門長以上が日時の決まった項目を登録する：
--   種類（event_kind）：deadline（締切。それまでに何かを終える日時）・event（予定。日時の決まった出来事）
--   対象（event_audience）：
--     soumu（総務） ：その年度の総務（管理者・総務部門長・総務副部門長・総務部門員）だけが読む
--     groups（団体）：総務に加えて、その年度の閲覧のみと、その年度の団体の代表（店長・副店長）が読む（団体に向けた項目）
--     all（全員）   ：groups と同じ人が読む（全員に向けた項目。v1 では読める人は groups と同じで、違いは誰に向けた項目か）
-- 書き込みは画面から直接（RLS）。理由の要らない、1つの表だけの書き込みなので RPC にしない（CLAUDE.md の設計上の約束）：
-- insert・update・delete は、その年度の部門長以上（admin・head・deputy_head）で、年度が終了（closed）でないとき（private.can_lead）。
-- 楽観ロックは画面が updated_at を条件に入れて行う（update … where id = … and updated_at = … returning。0 行なら読み直して
-- not_found・conflict・権限や状態の変化を分ける。04 の (B1)）。
-- 予定と締切は振り分けの入力でないので、版（allocation_version）を増やさず、確定中の守りもない（確定中も書ける）。
-- 画面（/calendar と、ダッシュボードの「締切と予定」へのまとめ）は T18 の後半（T16・T17 のマージの後）。
-- 0014 の private.my_group_year_ids（自分が団体の代表である年度）を使うので、0014 の後に当てる。足すだけで、今の表・関数・
-- ポリシーは変えない。

------------------------------------------------------------------------
-- 列挙型と表
------------------------------------------------------------------------
create type public.event_kind as enum ('deadline', 'event');
create type public.event_audience as enum ('soumu', 'groups', 'all');

-- 題名は前後の空白を除いた形で 1〜100 字（notices_title_check と同じ式。除く空白は JavaScript の String.prototype.trim が除く
-- 25 文字：タブ・LF・垂直タブ・改ページ・CR・半角の空白・U+00A0・U+1680・U+2000〜U+200A・U+2028・U+2029・U+202F・U+205F・
-- 全角の空白〔U+3000〕・U+FEFF）。書き込みを RPC にしないので DB では除かず、前後に空白のある題名と空白だけの題名を拒む（23514）。
-- 画面は zod の trim（同じ 25 文字）を通してから送る。
-- メモは任意で 1000 字まで（空なら画面が null にする。D-33）。
-- 終わり（ends_at）は任意で、開始より前にできない（同じ日時はよい）。
-- 終日（all_day）の項目は、日付を Asia/Tokyo の 00:00 で表す：starts_at は開始の日の 00:00、ends_at は最後の日の 00:00（その日を
-- 含む。翌日の 00:00 ではない。1日だけなら null）。CHECK は終日の項目の日時が Asia/Tokyo の 00:00 であることを確かめる。
-- 開始・終了の日付（Asia/Tokyo）は 2000-01-01〜2200-12-31（年度の1日目と同じ範囲。D-18）。infinity や、JavaScript の Date で
-- 扱えない日時を入れさせない（予定と締切は全員が開くダッシュボードに出るので、表示できない値で欄を壊さない）。
-- 時刻の式は timezone('Asia/Tokyo', …)（AT TIME ZONE。タイムゾーンを名前で渡すので、セッションの TimeZone によらない）と
-- date・time への変換だけ。
-- 書いた人・直した人（created_by・updated_by）と日時（created_at・updated_at）は DB が入れる（下の set_actor・set_timestamps）。
create table public.events (
  id uuid primary key default gen_random_uuid(),
  year_id uuid not null references public.years on delete cascade,
  kind public.event_kind not null,
  audience public.event_audience not null,
  title text not null,
  starts_at timestamptz not null,
  ends_at timestamptz,
  all_day boolean not null default false,
  note text,
  created_by uuid references auth.users on delete set null,
  updated_by uuid references auth.users on delete set null,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  constraint events_title_check check (title <> ''
    and title = btrim(title, E'\t\n\u000b\f\r \u00a0\u1680\u2000\u2001\u2002\u2003\u2004\u2005\u2006\u2007\u2008\u2009\u200a\u2028\u2029\u202f\u205f\u3000\ufeff')
    and length(title) <= 100),
  constraint events_note_check check (length(note) <= 1000),
  constraint events_ends_at_check check (ends_at >= starts_at),
  constraint events_all_day_check check (not all_day
    or ((starts_at at time zone 'Asia/Tokyo')::time = time '00:00'
        and (ends_at is null or (ends_at at time zone 'Asia/Tokyo')::time = time '00:00'))),
  constraint events_date_range_check check (
    (starts_at at time zone 'Asia/Tokyo')::date between date '2000-01-01' and date '2200-12-31'
    and (ends_at is null or (ends_at at time zone 'Asia/Tokyo')::date between date '2000-01-01' and date '2200-12-31'))
);
-- 年度ごとの一覧（早い順）と、ポリシーの year_id in (…) 用
create index events_year_id_idx on public.events (year_id, starts_at);

alter table public.events enable row level security;

------------------------------------------------------------------------
-- トリガー
------------------------------------------------------------------------
-- 日時（0002 の共通の関数）
create trigger set_timestamps before insert or update on public.events
  for each row execute function private.tg_set_timestamps();

-- 監査（D-11。0002 の tg_audit。year_id は行から、group_id は null。直接の書き込みなので理由は null）
create trigger audit after insert or update or delete on public.events
  for each row execute function private.tg_audit('id');

-- 年度の付け替えを止める（D-16。0002 の tg_immutable_columns〔0004 で DEFINER〕。invalid_input）
create trigger check_immutable before update of year_id on public.events
  for each row execute function private.tg_immutable_columns('year_id');

-- 書いた人・直した人：ログインしている人の書き込みでは DB が auth.uid() を入れる（クライアントの値は使わない。created_by は最初に
-- 書いた人のまま）。seed・SQL Editor（auth.uid() が null）では入れた値のまま（D-10。0014 の tg_notices_set_actor と同じ中身）。
-- 直接の書き込みでは authenticated で動くが、auth.uid() を読むだけで private.fail を呼ばないので INVOKER でよい
-- （tg_stocks_set_counted と同じ）
create function private.tg_events_set_actor()
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
create trigger set_actor before insert or update on public.events
  for each row execute function private.tg_events_set_actor();

-- 版の増分（bump_version_*）と確定中・終了の守り（lock_year_guard）は付けない（振り分けの入力でない。終了の年度の読み取り専用は
-- 下の書き込みのポリシー〔can_lead〕が守る）

------------------------------------------------------------------------
-- RLS
------------------------------------------------------------------------
-- 読み取り：D-47 の形（呼んだ人の年度の集合を問い合わせごとに1回だけ作り、行ごとに判定関数を呼ばない）。集合の関数は 0010 の
-- my_role_year_ids と、0014 の my_group_year_ids（自分が団体の代表〔店長・副店長〕である年度）。
-- 総務はその年度の全部。閲覧のみと団体の代表は、その年度（代表である年度）の対象が団体・全員の項目。ほかの人は何も読めない。
-- 対象で分ける枝は対象を名前で並べる（対象の種類を足しても、黙って閲覧のみ・団体の代表に見えないように。お知らせと同じ）。
-- 読み取りは年度の状態によらない
create policy events_select on public.events for select to authenticated
  using (year_id in (select private.my_role_year_ids('{admin,head,deputy_head,staff}'))
         or (audience in ('groups', 'all')
             and (year_id in (select private.my_role_year_ids('{viewer}'))
                  or year_id in (select private.my_group_year_ids()))));

-- 書き込み：その年度の部門長以上で、年度が closed でない（0013 の can_lead。room_years・slots・deliveries と同じ）。
-- 書き込みのポリシーは行ごとの形のまま（D-47）。update は using と with check に同じ述語を書く（year_id は check_immutable で
-- 変えられない）。書けない人の insert は 42501、update・delete は 0 行（画面は読み直して分ける）
create policy events_insert on public.events for insert to authenticated
  with check (private.can_lead(year_id));
create policy events_update on public.events for update to authenticated
  using (private.can_lead(year_id)) with check (private.can_lead(year_id));
create policy events_delete on public.events for delete to authenticated
  using (private.can_lead(year_id));

------------------------------------------------------------------------
-- 権限
------------------------------------------------------------------------
-- 表：authenticated に select・insert・update・delete（02 の W の表）。anon と PUBLIC には何も与えない。Supabase の既定の権限
-- （public スキーマの新しい表に anon・authenticated の全部）を、先に外す（0014 と同じ）
revoke all on table public.events from public, anon, authenticated;
grant select, insert, update, delete on table public.events to authenticated;

-- トリガー関数は誰も実行できない（判定関数・RPC は足さない）
revoke all on function private.tg_events_set_actor() from public, anon, authenticated;
revoke all on all functions in schema private from public;
