-- 0012_group_roles_overlap.sql（T15。2026-10-31。D-49）：団体代表の立場（店長・副店長）と兼任の禁止
-- 1. 適用する時点で兼任している人がいれば止める（README の「5. 本番 DB への適用」の問い合わせで探して直してから流し直す）
-- 2. 列挙 group_role（manager 店長・deputy_manager 副店長。権限は同じで、表示名だけが違う。人数の上限はない）と、
--    group_members.role・invitations.group_role
-- 3. 兼任の禁止（年度ごと）：部門のロール（head・deputy_head・staff）を year_roles に持つ人は、その年度の団体の group_members に
--    入れない（admin と viewer は入れる。違う年度ならよい）。他の表を参照する CHECK は使えないので、BEFORE ROW のトリガーで止める。
--    invite の早めのエラーと、招待の受け入れで重なる招待を飛ばすのは 0013
-- app_role の head・deputy_head（0011）は確定済みなので、このファイルから使える。

------------------------------------------------------------------------
-- 既に兼任している行があれば止める
------------------------------------------------------------------------
-- 先に year_roles・group_members をロックし（書き込みだけを止め、読み取りは通す）、確かめてからトリガーを作るまでの間に、
-- 受け入れ（ログイン）などが重なる行を入れないようにする（トリガーができるまでは止めるものがない）。ロックはこのファイルの
-- トランザクションの終わりまで持つ（その間〔1秒もかからない〕のログインは待つだけ）。
-- LOCK TABLE は DO の中で取る：CLI は明示の BEGIN なしにファイルを1つのトランザクション（拡張問い合わせのパイプライン）で流すので、
-- トップレベルの LOCK TABLE は「LOCK TABLE can only be used in transaction blocks」（25P01）で失敗する（CLI 2.122.0 で確かめた）。
-- 関数の中なら取れ、取ったロックは次の文からも残る。
-- 止まったときは、このファイルの変更は何も残らない（先に確定した 0011 は残るが害はない。流し直すとここから続く）
do $$
begin
  lock table public.year_roles, public.group_members in share row exclusive mode;
  if exists (select 1 from public.year_roles yr
             join public.group_members gm on gm.user_id = yr.user_id
             join public.groups g on g.id = gm.group_id and g.year_id = yr.year_id
             where yr.role in ('head', 'deputy_head', 'staff')) then
    raise exception 'role_overlap: 同じ年度で部員（staff）のロールと団体代表を兼ねている人がいます。README の「5. 本番 DB への適用」の問い合わせで探して直してから、もう一度 migrate.yml を流してください';
  end if;
end $$;

------------------------------------------------------------------------
-- 団体代表の立場（店長・副店長）
------------------------------------------------------------------------
create type public.group_role as enum ('manager', 'deputy_manager');

-- 今の団体代表は店長になる。既定値つきの not null の追加は表を書き直さず、行の update でもないので監査のトリガーは動かない
alter table public.group_members add column role public.group_role not null default 'manager';

-- 団体の招待の立場。団体の招待のときだけ持つ（ロールの招待は null）。今の団体の招待は店長にする。
-- 未使用の招待の一意の索引（invitations_pending_group_key：year_id, email, group_id）は変えない。同じ団体に立場違いの未使用の招待は
-- 2つ作れず、招待し直すと立場が変わる（0013 の invite）
alter table public.invitations add column group_role public.group_role;
update public.invitations set group_role = 'manager' where group_id is not null;
alter table public.invitations add constraint invitations_group_role_check
  check ((group_id is null) = (group_role is null));

------------------------------------------------------------------------
-- 兼任の禁止
------------------------------------------------------------------------
-- 補助の関数は任意の人について答えるので、誰にも execute を与えない（トリガーと、SECURITY DEFINER の RPC・招待の受け入れの中から
-- だけ呼ぶ）。3つとも VOLATILE（既定のまま。STABLE にしない）：ロックを待った後で、待っている間に確定した行を読むため（READ
-- COMMITTED では、VOLATILE の関数の中の問い合わせごとに新しいスナップショットになる）。呼ぶ側も、ロックを取る文と確かめる文を
-- 分ける（同じ文の中で取って読まない）。

-- 同じ年度・同じ人の「ロール」と「団体代表」の書き込みを順にする勧告的ロック（int4 の鍵2つ。トランザクションの終わりまで持つ）。
-- 年度・人の組が違えば待たない（ハッシュが偶然ぶつかっても、余分に待つだけ）。表を読まないので SECURITY DEFINER にしない。
-- 年度の行はロックしない（lock_year_guard・lock_year も、for share・for update・for no key update も使わない）：在庫の保存・申請の
-- 提出の lock_year_guard（for share）とぶつかり、GoTrue のログインのトランザクション（on_auth_user_confirmed → 招待の受け入れ）を
-- 長い振り分けの保存の後ろで待たせ、年度をまたいでデッドロックし得るため。year_roles・group_members の insert の外部キーの確認
-- （years・groups の for key share）は、lock_year の for no key update とぶつからない
create function private.lock_year_member(p_year_id uuid, p_user_id uuid)
returns void language sql set search_path = '' as $$
  select pg_advisory_xact_lock(hashtext('gaapp.year_member'), hashtext(p_year_id::text || '/' || p_user_id::text))
$$;

-- その年度で部門のロール（head・deputy_head・staff）を持つか
create function private.year_member_has_department_role(p_year_id uuid, p_user_id uuid)
returns boolean language sql security definer set search_path = '' as $$
  select exists (select 1 from public.year_roles yr
                 where yr.year_id = p_year_id and yr.user_id = p_user_id and yr.role in ('head', 'deputy_head', 'staff'))
$$;

-- その年度の団体の代表（店長・副店長）か
create function private.year_member_in_group(p_year_id uuid, p_user_id uuid)
returns boolean language sql security definer set search_path = '' as $$
  select exists (select 1 from public.group_members gm join public.groups g on g.id = gm.group_id
                 where g.year_id = p_year_id and gm.user_id = p_user_id)
$$;

-- トリガーは両方の表で check_role_overlap。BEFORE ROW のトリガーは名前の順に動くので、check_immutable（年度・団体の付け替えを
-- invalid_input で止める）の後、set_timestamps の前に動く。最初にロックを取り、その後の文で反対側を確かめる。
-- 違反は role_overlap（P0001。detail は year_id と user_id。メールは入れない）。
-- year_roles：insert と、role・user_id の update（staff → viewer のような向きでも、向きで分けずにロックを取って確かめる）。
-- set_role の insert … on conflict do update では BEFORE INSERT と BEFORE UPDATE の両方で動く（ロックは同じトランザクションで
-- 重ねて取れ、結果は同じ）。year_roles.year_id は変えられない（check_immutable）
create function private.tg_year_roles_check_overlap()
returns trigger language plpgsql security definer set search_path = '' as $$
begin
  perform private.lock_year_member(new.year_id, new.user_id);
  if new.role in ('head', 'deputy_head', 'staff') and private.year_member_in_group(new.year_id, new.user_id) then
    perform private.fail('role_overlap', jsonb_build_object('year_id', new.year_id, 'user_id', new.user_id));
  end if;
  return new;
end $$;
create trigger check_role_overlap before insert or update of role, user_id on public.year_roles
  for each row execute function private.tg_year_roles_check_overlap();

-- group_members：insert と、user_id・group_id の update（店長⇄副店長の role だけの update では動かない）。
-- 団体がなければ外部キーのエラー（23503）に任せる（role_overlap にしない）。groups.year_id と group_members.group_id は
-- 変えられない（check_immutable）ので、行の付け替えで重なりを作る道はない
create function private.tg_group_members_check_overlap()
returns trigger language plpgsql security definer set search_path = '' as $$
declare v_year_id uuid := (select g.year_id from public.groups g where g.id = new.group_id);
begin
  if v_year_id is null then return new; end if;
  perform private.lock_year_member(v_year_id, new.user_id);
  if private.year_member_has_department_role(v_year_id, new.user_id) then
    perform private.fail('role_overlap', jsonb_build_object('year_id', v_year_id, 'user_id', new.user_id));
  end if;
  return new;
end $$;
create trigger check_role_overlap before insert or update of user_id, group_id on public.group_members
  for each row execute function private.tg_group_members_check_overlap();

------------------------------------------------------------------------
-- 権限
------------------------------------------------------------------------
-- 補助とトリガー関数は誰にも execute を与えない（ポリシーの判定関数ではない。010 の一覧に入れない）
revoke all on function private.lock_year_member(uuid, uuid), private.year_member_has_department_role(uuid, uuid),
  private.year_member_in_group(uuid, uuid), private.tg_year_roles_check_overlap(), private.tg_group_members_check_overlap()
  from public, anon, authenticated;
revoke all on all functions in schema private from public;
