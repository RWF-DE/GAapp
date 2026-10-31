-- 0013_role_overlap_lead_tier.sql（T15。2026-10-31。D-48・D-49）：兼任の禁止と3つの段（管理者だけ・部門長以上・総務）を、
-- 1つのトランザクションで入れる
-- 1. 最初にロックを取り、適用する時点で兼任している人がいれば止める（README の「5. 本番 DB への適用」の問い合わせで探して直してから
--    流し直す）
-- 2. 今の団体の招待を店長にして、invitations_group_role_check を足す（group_role の型と列は 0012）
-- 3. 兼任の禁止（年度ごと）：部門のロール（head・deputy_head・staff）を year_roles に持つ人は、その年度の団体の group_members に
--    入れない（admin と viewer は入れる。違う年度ならよい）。他の表を参照する CHECK は使えないので、BEFORE ROW のトリガーで止める
-- 4. 3つの段の判定関数・ポリシー・RPC と、兼任を前提にする invite（早めのエラー）と招待の受け入れ（重なる招待を飛ばす）
-- 2〜4 を1つのファイルにしているのは、トリガーと CHECK だけが先に確定すると、古い invite（0005。団体の招待に group_role を
-- 入れない）が 23514 で、古い受け入れ（0009。兼任を飛ばさない）が role_overlap で失敗し、招待とログインが止まるため。
-- このファイルがどこで止まっても、何も残らない（残るのは 0011・0012 の、足すだけの変更で、今の関数のまま動く）。
-- 段はロールの配列で渡す：部門長以上（LEAD）＝'{admin,head,deputy_head}'、総務（SOUMU）＝'{admin,head,deputy_head,staff}'。
-- deputy_head の権限は head と同じ。どの判定がどの段かは notes/T15.md の「権限の段」の表（02「権限とRLS」・04 の RPC の表）。
-- admin は全部の段に入るので、admin の見えるもの・できることは変わらない。staff も変わらない（どちらも兼任の禁止を除く）。
-- 管理者だけのもの（マスタ・groups の書き込み〔can_admin・is_admin_of_open_year〕、create_year_from、年度のない履歴）は変えない。
-- 今の画面（T14 までの版）がそのまま動くように、RPC の名前・引数名・返り値は変えない。足したのは invite の p_group_role
-- （既定 null）と、新しい RPC の set_group_member_role だけ。
-- 適用済みのファイル（0003〜0010）は書き換えず、ここで関数を create or replace し、ポリシーは drop して create する
-- （create or replace は関数の権限を保つ。最後に 0005 と同じ繰り返しでもう一度与える）。
--
-- ロックの順（デッドロックを作らないための約束。notes/T15.md の「ロックの順」）：招待・ロール・団体代表を書く関数は、どれも
--   年度の行（lock_year）→ そのメールの未使用の招待の行（apply_invitations の並び）→ 年度と人の勧告的ロック（lock_year_member）
--   → year_roles・group_members の行
-- の順に取る（どれかを飛ばすのはよいが、逆には取らない）。invite は勧告的ロックの前に招待の行をロックし、remove_role は
-- year_roles の前に招待を消す。

------------------------------------------------------------------------
-- 最初のロックと、既に兼任している行の確かめ
------------------------------------------------------------------------
-- 先に、招待の受け入れ（招待の行 → group_members・year_roles）と同じ順に表をロックする：invitations・group_members は、このファイルが
-- 後で CHECK・ポリシーのために取る強さ（access exclusive）、year_roles は書き込みだけを止める強さ（読み取り〔RLS の判定〕は通す。
-- ポリシーを作り直すところで強くなる）。確かめてからトリガーを作るまでの間に、受け入れ（ログイン）などが重なる行を入れないため
-- （トリガーができるまでは止めるものがない）。同時のログインは、このファイルが終わるまで待つだけになる（1秒もかからない）。
-- 待つのは 5 秒まで（lock_timeout。このファイルのトランザクションの間だけ）：超えたら（と、デッドロックで止められたら）何も残さずに
-- 止まるので、流し直す（長く待つと、その間のアプリの読み書きがこのファイルの後ろに並んで止まる）。
-- LOCK TABLE は DO の中で取る：CLI は明示の BEGIN なしにファイルを1つのトランザクション（拡張問い合わせのパイプライン）で流すので、
-- トップレベルの LOCK TABLE は「LOCK TABLE can only be used in transaction blocks」（25P01）で失敗する（CLI 2.122.0 で確かめた）。
-- 関数の中なら取れ、取ったロック（と set_config の第3引数 true の設定）は次の文からも残る。
do $$
begin
  perform set_config('lock_timeout', '5s', true);
  lock table public.invitations, public.group_members in access exclusive mode;
  lock table public.year_roles in share row exclusive mode;
  if exists (select 1 from public.year_roles yr
             join public.group_members gm on gm.user_id = yr.user_id
             join public.groups g on g.id = gm.group_id and g.year_id = yr.year_id
             where yr.role in ('head', 'deputy_head', 'staff')) then
    raise exception 'role_overlap: 同じ年度で部員（staff）のロールと団体代表を兼ねている人がいます。README の「5. 本番 DB への適用」の問い合わせで探して直してから、もう一度 migrate.yml を流してください';
  end if;
end $$;

------------------------------------------------------------------------
-- 団体の招待の立場（型と列は 0012）
------------------------------------------------------------------------
-- 今の団体の招待（0012 の後に古い invite が作ったものを含む）は店長にしてから、団体の招待のときだけ持つ CHECK を足す
update public.invitations set group_role = 'manager' where group_id is not null and group_role is null;
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
-- （years・groups の for key share）は、lock_year の for no key update とぶつからない。
-- 招待の行は、このロックより先に取る（上の「ロックの順」。このロックを持ったまま招待の行を待たない）
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

-- 補助とトリガー関数は誰にも execute を与えない（ポリシーの判定関数ではない。010 の一覧に入れない）
revoke all on function private.lock_year_member(uuid, uuid), private.year_member_has_department_role(uuid, uuid),
  private.year_member_in_group(uuid, uuid), private.tg_year_roles_check_overlap(), private.tg_group_members_check_overlap()
  from public, anon, authenticated;

------------------------------------------------------------------------
-- 判定関数（0003 と同じく SECURITY DEFINER・search_path = ''・STABLE。呼んだ人〔auth.uid()〕についてだけ答える）
------------------------------------------------------------------------
-- その年度の部門長以上で、年度が closed でない（can_admin と同じ形。room_years・slots・deliveries の書き込み、rules の追加と削除）
create function private.can_lead(p_year_id uuid)
returns boolean language sql stable security definer set search_path = '' as $$
  select exists (
    select 1 from public.year_roles yr join public.years y on y.id = yr.year_id
    where yr.year_id = p_year_id and yr.user_id = (select auth.uid())
      and yr.role in ('admin', 'head', 'deputy_head') and y.status <> 'closed')
$$;

-- 在庫を書ける：部門長以上（closed 以外）、staff（preparing・requesting）
create or replace function private.can_write_stocks(p_year_id uuid)
returns boolean language sql stable security definer set search_path = '' as $$
  select exists (
    select 1 from public.year_roles yr join public.years y on y.id = yr.year_id
    where yr.year_id = p_year_id and yr.user_id = (select auth.uid())
      and ((yr.role in ('admin', 'head', 'deputy_head') and y.status <> 'closed')
        or (yr.role = 'staff' and y.status in ('preparing', 'requesting'))))
$$;

-- 申請を RPC なしで書ける（K-24）：
--   団体代表（店長・副店長）：requesting で、request_open_at が null か過ぎていて、締切前。request_close_at が null なら書けない
--   部門長以上：preparing（締切に関係なく代理入力できる）か、締切前の requesting
create or replace function private.can_write_requests(p_group_id uuid)
returns boolean language sql stable security definer set search_path = '' as $$
  select exists (
    select 1 from public.groups g join public.years y on y.id = g.year_id
    where g.id = p_group_id
      and (
        (exists (select 1 from public.year_roles yr
                 where yr.year_id = g.year_id and yr.user_id = (select auth.uid())
                   and yr.role in ('admin', 'head', 'deputy_head'))
         and (y.status = 'preparing' or (y.status = 'requesting' and now() < y.request_close_at)))
        or
        (exists (select 1 from public.group_members gm
                 where gm.group_id = g.id and gm.user_id = (select auth.uid()))
         and y.status = 'requesting'
         and (y.request_open_at is null or y.request_open_at <= now())
         and now() < y.request_close_at)))
$$;

-- profiles を読める：自分の行と、自分が総務（部門長以上・staff）である年度にロールか団体代表の行がある人（年度ごとに閉じる）
create or replace function private.can_see_profile(p_user_id uuid)
returns boolean language sql stable security definer set search_path = '' as $$
  select p_user_id = (select auth.uid())
      or exists (
        select 1 from public.year_roles me
        where me.user_id = (select auth.uid()) and me.role in ('admin', 'head', 'deputy_head', 'staff')
          and (exists (select 1 from public.year_roles t where t.year_id = me.year_id and t.user_id = p_user_id)
               or exists (select 1 from public.group_members gm join public.groups g on g.id = gm.group_id
                          where g.year_id = me.year_id and gm.user_id = p_user_id)))
$$;

------------------------------------------------------------------------
-- 守りのトリガー（0004 の関数を置き換える）
------------------------------------------------------------------------
-- 今年の使用（room_years）は振り分けの作業なので部門長以上が書く。前置きの確かめをポリシー（room_years_insert・room_years_update）と
-- 同じ can_lead にそろえる（0004 の決まり：書けない人ではロックを取らずに、拒否を RLS に任せる）。ほかは 0004 と同じ
create or replace function private.tg_room_years_guard()
returns trigger language plpgsql security definer set search_path = '' as $$
declare v_status public.year_status;
begin
  if private.rls_applies() and not private.can_lead(new.year_id) then     -- room_years_insert・room_years_update と同じ
    return new;
  end if;
  v_status := private.lock_year_guard(new.year_id);
  if v_status in ('confirmed', 'closed') and not new.usable
     and exists (select 1 from public.allocations a where a.year_id = new.year_id and a.source_room_id = new.room_id) then
    perform private.fail('invalid_state', jsonb_build_object('status', v_status, 'code', 'E002', 'room_id', new.room_id));
  end if;
  return new;
end $$;

------------------------------------------------------------------------
-- ポリシー（24 個を drop して create。全部で 52 個のまま）
------------------------------------------------------------------------
-- 行が多くなりうる表の select は 0010 の形（集合を問い合わせごとに1回だけ作る。D-47）のまま、ロールの配列だけを直す。
-- 行の少ない表と書き込みのポリシーは、行ごとの形のまま。update は using と with check に同じ述語を書く。

-- 今年の使用・時間枠：書き込みは部門長以上（closed でない年度）
drop policy room_years_insert on public.room_years;
drop policy room_years_update on public.room_years;
drop policy room_years_delete on public.room_years;
create policy room_years_insert on public.room_years for insert to authenticated with check (private.can_lead(year_id));
create policy room_years_update on public.room_years for update to authenticated
  using (private.can_lead(year_id)) with check (private.can_lead(year_id));
create policy room_years_delete on public.room_years for delete to authenticated using (private.can_lead(year_id));

drop policy slots_insert on public.slots;
drop policy slots_update on public.slots;
drop policy slots_delete on public.slots;
create policy slots_insert on public.slots for insert to authenticated with check (private.can_lead(year_id));
create policy slots_update on public.slots for update to authenticated
  using (private.can_lead(year_id)) with check (private.can_lead(year_id));
create policy slots_delete on public.slots for delete to authenticated using (private.can_lead(year_id));

-- 在庫：総務が読む
drop policy stocks_select on public.stocks;
create policy stocks_select on public.stocks for select to authenticated
  using (year_id in (select private.my_role_year_ids('{admin,head,deputy_head,staff}')));

-- 団体：総務・viewer と自団体が読む（書き込みは管理者だけのまま）
drop policy groups_select on public.groups;
create policy groups_select on public.groups for select to authenticated
  using (year_id in (select private.my_role_year_ids('{admin,head,deputy_head,staff,viewer}')) or id in (select private.my_group_ids()));

-- ロール・団体代表：自分の行と、部門長以上はその年度の全行
drop policy year_roles_select on public.year_roles;
create policy year_roles_select on public.year_roles for select to authenticated
  using (user_id = (select auth.uid()) or private.has_any_role(year_id, '{admin,head,deputy_head}'));
drop policy group_members_select on public.group_members;
create policy group_members_select on public.group_members for select to authenticated
  using (user_id = (select auth.uid()) or private.has_any_role(private.group_year_id(group_id), '{admin,head,deputy_head}'));

-- 招待：自分のメールの行（0005 と同じ。D-17a）、admin はその年度の全部、head・deputy_head はその年度の staff のロールの招待と
-- 団体の招待だけ（admin・head・deputy_head・viewer のロールの招待は読めない。扱えるものだけを見せる）
drop policy invitations_select on public.invitations;
create policy invitations_select on public.invitations for select to authenticated
  using ((email = (select private.my_verified_email()) and private.has_any_access())
         or private.has_role(year_id, 'admin')
         or ((role = 'staff' or group_id is not null) and private.has_any_role(year_id, '{head,deputy_head}')));

-- 申請・提出・了承：総務と自団体が読む
drop policy request_submissions_select on public.request_submissions;
create policy request_submissions_select on public.request_submissions for select to authenticated
  using (group_id in (select private.my_role_group_ids('{admin,head,deputy_head,staff}')) or group_id in (select private.my_group_ids()));

drop policy requests_select on public.requests;
create policy requests_select on public.requests for select to authenticated
  using (group_id in (select private.my_role_group_ids('{admin,head,deputy_head,staff}')) or group_id in (select private.my_group_ids()));

drop policy substitution_consents_select on public.substitution_consents;
create policy substitution_consents_select on public.substitution_consents for select to authenticated
  using (group_id in (select private.my_role_group_ids('{admin,head,deputy_head,staff}')) or group_id in (select private.my_group_ids()));

-- ルール：総務が読み、部門長以上が書く。closed でも部門長以上は更新できるが、トリガー（guard_rules）が memo 以外の変更を止める
-- （0004 と同じ。year_id の付け替えも guard_rules が止める）
drop policy rules_select on public.rules;
drop policy rules_insert on public.rules;
drop policy rules_update on public.rules;
drop policy rules_delete on public.rules;
create policy rules_select on public.rules for select to authenticated
  using (private.has_any_role(year_id, '{admin,head,deputy_head,staff}'));
create policy rules_insert on public.rules for insert to authenticated with check (private.can_lead(year_id));
create policy rules_update on public.rules for update to authenticated
  using (private.has_any_role(year_id, '{admin,head,deputy_head}')) with check (private.has_any_role(year_id, '{admin,head,deputy_head}'));
create policy rules_delete on public.rules for delete to authenticated using (private.can_lead(year_id));

-- 振り分け：総務はいつも、viewer と自団体は確定後（viewer と自団体の枝は 0010 のまま）
drop policy allocations_select on public.allocations;
create policy allocations_select on public.allocations for select to authenticated
  using (year_id in (select private.my_role_year_ids('{admin,head,deputy_head,staff}'))
         or ((year_id in (select private.my_role_year_ids('{viewer}')) or group_id in (select private.my_group_ids()))
             and private.year_status(year_id) in ('confirmed', 'closed')));

-- 受け渡し（フェーズ2）：総務・viewer と自団体が読み、部門長以上が書く（総務の更新は check_delivery）
drop policy deliveries_select on public.deliveries;
drop policy deliveries_insert on public.deliveries;
drop policy deliveries_update on public.deliveries;
drop policy deliveries_delete on public.deliveries;
create policy deliveries_select on public.deliveries for select to authenticated
  using (private.has_any_role(year_id, '{admin,head,deputy_head,staff,viewer}') or private.is_group_member(group_id));
create policy deliveries_insert on public.deliveries for insert to authenticated with check (private.can_lead(year_id));
create policy deliveries_update on public.deliveries for update to authenticated
  using (private.can_lead(year_id)) with check (private.can_lead(year_id));
create policy deliveries_delete on public.deliveries for delete to authenticated using (private.can_lead(year_id));

-- 履歴：年度の行は部門長以上。年度のない行（年度をまたぐ3表）は今までどおり closed でない年度の admin だけ
drop policy audit_logs_select on public.audit_logs;
create policy audit_logs_select on public.audit_logs for select to authenticated
  using (case when year_id is null
              then table_name in ('rooms', 'items', 'distance_overrides') and (select private.is_admin_of_open_year())
              else year_id in (select private.my_role_year_ids('{admin,head,deputy_head}')) end);

------------------------------------------------------------------------
-- 招待の受け入れ（0009 の関数を置き換える）
------------------------------------------------------------------------
-- 兼任になる招待（部門のロールの招待で、その年度の団体代表のとき。団体の招待で、その年度の部門のロールを持つとき）と、その団体に
-- もう別の立場でいるときの団体の招待は、使用済みにせず残し、件数に数えない（0009 の「別のロールを持つ」と同じ扱い。管理者の画面
-- では未使用のまま見える）。団体の招待は招待の立場（group_role）で group_members を作る。
-- 例外を出さない：on_auth_user_confirmed・on_auth_identity_created（0007）は GoTrue のトランザクションの中で動き、例外はログインの
-- 失敗（「Database error …」）になる。そこで招待ごとに、トリガー（上の check_role_overlap）と同じ勧告的ロックを取ってから、
-- トリガーと同じ関数で先に確かめる（insert … on conflict do nothing でも BEFORE INSERT のトリガーは動くので、確かめは insert の前に
-- 置く。同じロックの下で確かめてあるので、トリガーは role_overlap を出さない）。1回の呼び出しの中でも順に効く（同じ年度の staff の招待を先に付けたら、
-- その後の団体の招待は飛ばす。同じトランザクションの行は見える）。
-- 順番は created_at、同じならロールの招待を先（T15 より前の 4 引数の invite は、同じ年度・同じメールの staff の招待と団体の招待を
-- 一度に〔同じ時刻で〕作れたので、どちらが付くかを決めておく）。
-- この並び（order by i.created_at, (i.role is null), i.id）は、招待の行をロックする順の約束でもある（上の「ロックの順」）：
-- 招待の行をこの順にロックしてから、行ごとに年度と人の勧告的ロックを取る。invite も勧告的ロックの前に、同じ条件・同じ並びで
-- そのメールの招待の行をロックする（逆の順だと、受け入れと invite がデッドロックする。T15 のレビュー）。
-- 引数・返り値・SECURITY DEFINER・search_path・権限（private の関数は PUBLIC から外したまま）は変えない。
-- 呼ぶのは accept_invitations_of（0007）、accept_my_invitations、invite
create or replace function private.apply_invitations(p_user_id uuid, p_email text)
returns integer language plpgsql security definer set search_path = '' as $$
declare
  inv record;
  v_n integer := 0;
begin
  for inv in
    select i.id, i.year_id, i.role, i.group_id, i.group_role
    from public.invitations i join public.years y on y.id = i.year_id
    where i.email = lower(btrim(p_email)) and i.used_at is null and y.status <> 'closed'
    order by i.created_at, (i.role is null), i.id
    for update of i
  loop
    perform private.lock_year_member(inv.year_id, p_user_id);
    if inv.role is not null then
      if inv.role in ('head', 'deputy_head', 'staff') and private.year_member_in_group(inv.year_id, p_user_id) then
        continue;                                        -- 兼任になる：使用済みにしない・数えない
      end if;
      insert into public.year_roles (year_id, user_id, role) values (inv.year_id, p_user_id, inv.role)
      on conflict (year_id, user_id) do nothing;
      -- 行が既にあった：同じロールなら使用済みにする。別のロールなら招待を残す（ロールも変えない。0009 のまま）。
      -- insert が同時の書き込みを待った後でも、この select は新しいスナップショットで確定した行を読む（read committed）
      if not found and not exists (
        select 1 from public.year_roles yr
        where yr.year_id = inv.year_id and yr.user_id = p_user_id and yr.role = inv.role) then
        continue;
      end if;
    else
      if private.year_member_has_department_role(inv.year_id, p_user_id) then
        continue;                                        -- 兼任になる
      end if;
      insert into public.group_members (group_id, user_id, role) values (inv.group_id, p_user_id, inv.group_role)
      on conflict (group_id, user_id) do nothing;
      -- その団体にもう別の立場でいる：招待を残す（立場も変えない。変えるのは set_group_member_role）
      if not found and not exists (
        select 1 from public.group_members gm
        where gm.group_id = inv.group_id and gm.user_id = p_user_id and gm.role = inv.group_role) then
        continue;
      end if;
    end if;
    update public.invitations set used_at = now() where id = inv.id;
    v_n := v_n + 1;
  end loop;
  return v_n;
end $$;

------------------------------------------------------------------------
-- set_year_status（部門長以上。終了〔closed〕へは admin だけ）
------------------------------------------------------------------------
create or replace function public.set_year_status(p_year_id uuid, p_to public.year_status, p_reason text default null,
                                                  p_base_version integer default null)
returns public.years language plpgsql security definer set search_path = '' as $$
declare
  v public.years;
  v_issues jsonb;
begin
  v := private.lock_year(p_year_id, '{preparing,requesting,allocating,confirmed,closed}', '{admin,head,deputy_head}');
  -- 終了は admin だけ（D-48）。遷移の確かめより先に止める（head・deputy_head は、どの状態からでも closed を頼むと forbidden）
  if p_to = 'closed' and not private.has_role(p_year_id, 'admin') then
    perform private.fail('forbidden');
  end if;
  if not ((v.status::text, p_to::text) in (('preparing', 'requesting'), ('requesting', 'allocating'),
          ('allocating', 'confirmed'), ('confirmed', 'allocating'), ('confirmed', 'closed'))) then
    perform private.fail('invalid_state', jsonb_build_object('from', v.status, 'to', p_to));
  end if;
  -- 理由は確定と確定の解除で必須（02「設計上の決めごと」）
  perform private.set_reason(p_reason, p_to = 'confirmed' or (v.status = 'confirmed' and p_to = 'allocating'));
  if p_to = 'requesting' and (v.request_close_at is null or v.request_close_at <= now()) then
    perform private.fail('invalid_state', jsonb_build_object('field', 'request_close_at'));
  end if;
  if p_to = 'confirmed' then
    -- 確定ボタンを押した人が検証した版と同じか（同時に振り分けや入力が変わっていれば conflict）
    if p_base_version is distinct from v.allocation_version then
      perform private.fail('conflict', jsonb_build_object('allocation_version', v.allocation_version));
    end if;
    v_issues := private.confirm_issues(p_year_id);
    if v_issues is not null then
      perform private.fail(v_issues -> 0 ->> 'code', v_issues);
    end if;
  end if;
  -- 遷移のたびに版を増やす（遷移の前に読んだ入力で保存・確定させない）
  update public.years set status = p_to, allocation_version = allocation_version + 1
  where id = p_year_id returning * into v;
  return v;
end $$;

------------------------------------------------------------------------
-- update_year（部門長以上。年度名・1日目は admin だけ）
------------------------------------------------------------------------
create or replace function public.update_year(p_year_id uuid, p_patch jsonb, p_reason text default null)
returns public.years language plpgsql security definer set search_path = '' as $$
declare
  v public.years;
  k text;
  v_constraint text;
begin
  v := private.lock_year(p_year_id, '{preparing,requesting,allocating,confirmed}', '{admin,head,deputy_head}');
  if p_patch is null or jsonb_typeof(p_patch) <> 'object' then
    perform private.fail('invalid_input', jsonb_build_object('field', 'patch'));
  end if;
  for k in select jsonb_object_keys(p_patch) loop
    if k not in ('label', 'festival_start', 'request_open_at', 'request_close_at') then
      perform private.fail('invalid_input', jsonb_build_object('field', k));
    end if;
  end loop;
  -- head・deputy_head が変えられるのは受付期間だけ（D-48）。知らないキーの invalid_input の後で見る。キーのない {} は通る
  if exists (select 1 from jsonb_object_keys(p_patch) as t(patch_key)
             where t.patch_key not in ('request_open_at', 'request_close_at'))
     and not private.has_role(p_year_id, 'admin') then
    perform private.fail('forbidden');
  end if;
  perform private.set_reason(p_reason);
  begin
    update public.years set
      festival_start   = case when p_patch ? 'festival_start' then (p_patch ->> 'festival_start')::date else festival_start end,
      request_open_at  = case when p_patch ? 'request_open_at' then (p_patch ->> 'request_open_at')::timestamptz else request_open_at end,
      request_close_at = case when p_patch ? 'request_close_at' then (p_patch ->> 'request_close_at')::timestamptz else request_close_at end
    where id = p_year_id
    returning * into v;
    -- label（一意の列）は、変えるときだけ別の文で書く。SET に label があると、値が同じでも行のロックが
    -- 外部キーの確認（FOR KEY SHARE）とぶつかる強さになり、その年度を参照する行の insert（在庫など）を待たせる
    if p_patch ? 'label' and btrim(p_patch ->> 'label') is distinct from v.label then
      update public.years set label = btrim(p_patch ->> 'label') where id = p_year_id returning * into v;
    end if;
  exception
    when unique_violation then perform private.fail('conflict', jsonb_build_object('field', 'label'));
    when check_violation then
      get stacked diagnostics v_constraint = constraint_name;
      perform private.fail('invalid_input', jsonb_build_object('field',
        case when v_constraint = 'years_festival_start_check' then 'festival_start' else 'patch' end));
    when data_exception or not_null_violation then      -- 22xxx（範囲外の日付 22008 を含む）
      perform private.fail('invalid_input', jsonb_build_object('field', 'patch'));
  end;
  if v.status = 'requesting' and v.request_close_at is null then
    perform private.fail('invalid_input', jsonb_build_object('field', 'request_close_at'));
  end if;
  -- 1日目は、複製元（prev_year_id）より後で、この年度を複製元にした年度より前（create_year_from の前提と「最新の年度」の
  -- 判定を崩さない。崩すと、どの年度も最新でなくなり次の年度を作れなくなる）
  if p_patch ? 'festival_start'
     and (exists (select 1 from public.years p where p.id = v.prev_year_id and p.festival_start >= v.festival_start)
          or exists (select 1 from public.years n where n.prev_year_id = v.id and n.festival_start <= v.festival_start)) then
    perform private.fail('invalid_input', jsonb_build_object('field', 'festival_start'));
  end if;
  return v;
end $$;

------------------------------------------------------------------------
-- 招待とロール（部門長以上。head・deputy_head が扱えるのは staff のロールと団体代表〔店長・副店長〕だけ）
------------------------------------------------------------------------
-- invite：4引数の版を消してから作る（2つ残すと、名前つきの引数で呼ぶ PostgREST が版を選べない。PGRST203）。今の画面の呼び出し
-- （{p_year_id, p_email, p_role} か {p_year_id, p_email, p_group_id}）は新しい版に解決し、団体の招待は店長になる。
-- エラーの順番（pgTAP はこの順で確かめる。notes/T15.md）：
--   1. ロール（部門長以上）と状態（forbidden・invalid_state）
--   2. 入力（invalid_input：role も group_id もない → role、group_id なしで group_role → group_role、メールの形 → email、
--      その年度にない団体 → group_id）
--   3. 段：admin でなく、role が staff 以外 → forbidden
--   4. 部門のロールと団体を一度に頼んだ → role_overlap（reason: requested_together）
--   5. このメールの未使用の招待の行を、受け入れ（apply_invitations）と同じ条件・同じ並びでロックしてから（ロックの順を「年度の行
--      → 招待の行 → 年度と人」にそろえる。勧告的ロックを持ったまま招待の行を待つと、受け入れとデッドロックする）、
--      admin でなく role を渡し、同じ年度・同じメールの未使用のロールの招待が staff 以外 → forbidden（管理者・部門長・副部門長・
--      閲覧のみの招待を、下の on conflict … do update set role で上書きさせない）
--   6〜9. 今のメールが本人のものと確かめられるアカウント（private.verified_email。D-17a）があれば、その人のロック
--      （lock_year_member。年度の行と招待の行の後に取る）を取ってから：
--      別のロール → conflict（field: role）、その団体に別の立場 → conflict（field: group_role）、
--      兼任になる → role_overlap（reason: current_membership）
--  10. 反対側の未使用の招待（同じ年度・同じメール）を、この呼び出しの後の状態で見る → role_overlap（reason: pending_invitation）。
--      ロールの招待はこの呼び出しの role（渡せば上書きする）か今の未使用のもの、団体の招待は今の未使用のものかこの呼び出しのもの。
--      admin・viewer を渡して招待し直せば、残っていた staff の招待は上書きされるので重ならない
--  11. 理由「招待」を置いて、招待を作るか作り直す（未使用のロールの招待はロールが、団体の招待は立場が変わる）
--  12. アカウントがあれば、その場で受け入れる（apply_invitations。返り値は今のまま {invitation_ids, applied}）
-- role_overlap の detail は year_id と reason、アカウントが分かるときだけ user_id（メールは入れない）
drop function public.invite(uuid, text, public.app_role, uuid);
create function public.invite(p_year_id uuid, p_email text, p_role public.app_role default null, p_group_id uuid default null,
                              p_group_role public.group_role default null)
returns jsonb language plpgsql security definer set search_path = '' as $$
declare
  v_email text := lower(btrim(p_email));
  v_is_admin boolean;
  v_group_role public.group_role;
  v_pending_role public.app_role;
  v_user uuid;
  v_current public.app_role;
  v_current_group_role public.group_role;
  v_ids uuid[] := '{}';
  v_id uuid;
  v_applied integer := 0;
begin
  perform private.lock_year(p_year_id, '{preparing,requesting,allocating,confirmed}', '{admin,head,deputy_head}');   -- 1
  v_is_admin := private.has_role(p_year_id, 'admin');
  if p_role is null and p_group_id is null then                                                                -- 2
    perform private.fail('invalid_input', jsonb_build_object('field', 'role'));
  end if;
  if p_group_id is null and p_group_role is not null then
    perform private.fail('invalid_input', jsonb_build_object('field', 'group_role'));
  end if;
  if v_email is null or v_email !~ '^[^@[:space:]]+@[^@[:space:]]+$' or length(v_email) > 254 then
    perform private.fail('invalid_input', jsonb_build_object('field', 'email'));
  end if;
  if p_group_id is not null
     and not exists (select 1 from public.groups g where g.id = p_group_id and g.year_id = p_year_id) then
    perform private.fail('invalid_input', jsonb_build_object('field', 'group_id'));
  end if;
  if p_group_id is not null then
    v_group_role := coalesce(p_group_role, 'manager');      -- 省くと店長
  end if;
  if not v_is_admin and p_role <> 'staff' then                                                                 -- 3
    perform private.fail('forbidden');
  end if;
  if p_role in ('head', 'deputy_head', 'staff') and p_group_id is not null then                                -- 4
    perform private.fail('role_overlap', jsonb_build_object('year_id', p_year_id, 'reason', 'requested_together'));
  end if;
  -- 5. 下の upsert と中の apply_invitations が触る行（このメールの、closed でない年度の未使用の招待）を、apply_invitations と同じ並びで
  --    先にロックする（ロックの後の文は、待っている間に確定した行を新しいスナップショットで読む）
  perform 1 from public.invitations i join public.years y on y.id = i.year_id
  where i.email = v_email and i.used_at is null and y.status <> 'closed'
  order by i.created_at, (i.role is null), i.id
  for update of i;
  select i.role into v_pending_role from public.invitations i
  where i.year_id = p_year_id and i.email = v_email and i.role is not null and i.used_at is null;
  if not v_is_admin and p_role is not null and v_pending_role <> 'staff' then
    perform private.fail('forbidden');
  end if;
  -- その場で付けるのは、今のメールが本人のものと確かめられるアカウントだけ（未確認のアカウントや、
  -- email を他人のアドレスに変えたアカウントに招待を取らせない。private.verified_email、D-17a）
  select u.id into v_user from auth.users u
  where lower(u.email) = v_email and private.verified_email(u.id) = v_email;
  if v_user is not null then
    perform private.lock_year_member(p_year_id, v_user);                                                       -- 6
    if p_role is not null then                                                                                 -- 7
      select yr.role into v_current from public.year_roles yr where yr.year_id = p_year_id and yr.user_id = v_user;
      if v_current is not null and v_current <> p_role then
        perform private.fail('conflict', jsonb_build_object('field', 'role', 'current', v_current));
      end if;
    end if;
    if p_group_id is not null then                                                                             -- 8
      select gm.role into v_current_group_role from public.group_members gm
      where gm.group_id = p_group_id and gm.user_id = v_user;
      if v_current_group_role is not null and v_current_group_role <> v_group_role then
        perform private.fail('conflict', jsonb_build_object('field', 'group_role', 'current', v_current_group_role));
      end if;
    end if;
    if (p_role in ('head', 'deputy_head', 'staff') and private.year_member_in_group(p_year_id, v_user))         -- 9
       or (p_group_id is not null and private.year_member_has_department_role(p_year_id, v_user)) then
      perform private.fail('role_overlap',
        jsonb_build_object('year_id', p_year_id, 'user_id', v_user, 'reason', 'current_membership'));
    end if;
  end if;
  if coalesce(p_role, v_pending_role) in ('head', 'deputy_head', 'staff')                                       -- 10
     and (p_group_id is not null
          or exists (select 1 from public.invitations i
                     where i.year_id = p_year_id and i.email = v_email and i.group_id is not null and i.used_at is null)) then
    perform private.fail('role_overlap', jsonb_build_object('year_id', p_year_id, 'reason', 'pending_invitation'));
  end if;
  perform private.set_reason('招待');                                                                           -- 11
  if p_role is not null then
    insert into public.invitations (year_id, email, role) values (p_year_id, v_email, p_role)
    on conflict (year_id, email) where role is not null and used_at is null
    do update set role = excluded.role
    returning id into v_id;
    v_ids := v_ids || v_id;
  end if;
  if p_group_id is not null then
    insert into public.invitations (year_id, email, group_id, group_role) values (p_year_id, v_email, p_group_id, v_group_role)
    on conflict (year_id, email, group_id) where group_id is not null and used_at is null
    do update set group_role = excluded.group_role
    returning id into v_id;
    v_ids := v_ids || v_id;
  end if;
  if v_user is not null then                                                                                   -- 12
    v_applied := private.apply_invitations(v_user, v_email);
  end if;
  return jsonb_build_object('invitation_ids', to_jsonb(v_ids), 'applied', v_applied > 0);
end $$;

-- set_role：head・deputy_head は、その年度のロールがないか staff の人に staff を付けるだけ。
-- 相手の今のロールを読む前に、その人のロック（lock_year_member）を取る：招待の受け入れ（年度の行を取らない）がその間にロールを
-- 付けても（同じロックを取ってから insert する）、読んだロールと書くときのロールがずれない（head・deputy_head に、受け入れと
-- 同時に付いた admin・viewer のロールを staff で上書きさせない）。ロックの順は「年度の行 → 年度と人 → year_roles」（招待の行は
-- 取らない。上の「ロックの順」）。
-- 兼任になれば、year_roles のトリガー（上の check_role_overlap）が role_overlap を返す（閲覧のみの店長を staff にするなど）。
-- 未使用の招待は見ない（反対側の招待が残っていても止めない。受け入れのときに飛ばされる。早めのエラーは invite だけ）
create or replace function public.set_role(p_year_id uuid, p_user_id uuid, p_role public.app_role, p_reason text default null)
returns void language plpgsql security definer set search_path = '' as $$
declare
  v_is_admin boolean;
  v_current public.app_role;
begin
  perform private.lock_year(p_year_id, '{preparing,requesting,allocating,confirmed}', '{admin,head,deputy_head}');
  v_is_admin := private.has_role(p_year_id, 'admin');
  if p_role is null then                           -- 外すのは remove_role
    perform private.fail('invalid_input', jsonb_build_object('field', 'role'));
  end if;
  if not v_is_admin and p_role <> 'staff' then
    perform private.fail('forbidden');
  end if;
  if not exists (select 1 from auth.users u where u.id = p_user_id) then
    perform private.fail('not_found', jsonb_build_object('field', 'user_id'));
  end if;
  perform private.lock_year_member(p_year_id, p_user_id);
  select yr.role into v_current from public.year_roles yr where yr.year_id = p_year_id and yr.user_id = p_user_id;
  if not v_is_admin and v_current is not null and v_current <> 'staff' then
    perform private.fail('forbidden');
  end if;
  if p_role <> 'admin'
     and exists (select 1 from public.year_roles where year_id = p_year_id and user_id = p_user_id and role = 'admin')
     and not exists (select 1 from public.year_roles where year_id = p_year_id and role = 'admin' and user_id <> p_user_id) then
    perform private.fail('invalid_state', jsonb_build_object('reason', 'last_admin'));
  end if;
  perform private.set_reason(p_reason);
  insert into public.year_roles (year_id, user_id, role) values (p_year_id, p_user_id, p_role)
  on conflict (year_id, user_id) do update set role = excluded.role;
end $$;

-- remove_role：closed の年度でもできる（卒業した人を外して、権限を残さないため）。最後の admin は外せない。
-- 相手のロールを先に読み、なければ not_found（段の確かめより先）。head・deputy_head が外せるのは staff だけ（ほかは forbidden）。
-- 外した人の、本人のものと確定しているメールあての、その年度の未使用のロールの招待も消す（0009 のまま）。ただし head・deputy_head が
-- 外したときに消すのは staff のロールの招待だけ（admin・head・deputy_head・viewer の招待の取り消しは管理者だけ。D-48。T15 のレビューで
-- 直した。残った招待は管理者の画面に未使用のまま見え、管理者が取り消せる。取り消さなければ、ロールがなくなった本人の次の受け入れで
-- 管理者の招待どおりのロールが付く）。消す相手のメールは 0009 と同じ
--   ・private.verified_email(p_user_id)（取れれば）
--   ・lower(auth.users.email)（今の確定したメール。Secure email change では、変更が確定するまで変わらない）
--   ・provider = 'google' で identity_data の email_verified が真の identity の lower(identity_data ->> 'email')
-- email_change（確定していない変更先）は使わない（他人のアドレスを入れて、他人の招待を消せてしまうため）。
-- 団体代表の招待（role が null）は消さない（団体代表を外すのは remove_group_member）。
-- 招待を消してから year_roles を消す（受け入れ〔招待の行 → year_roles〕と同じ順。0009 の逆の順では、受け入れが招待の行を持ったまま
-- 消している途中の year_roles の行を待ち、こちらがその招待の行を待ってデッドロックした。T15 のレビュー）。year_roles が先に
-- 消えていて not_found になれば、招待を消したことも取り消される（1つのトランザクション）
create or replace function public.remove_role(p_year_id uuid, p_user_id uuid, p_reason text default null)
returns void language plpgsql security definer set search_path = '' as $$
declare
  v_is_admin boolean;
  v_current public.app_role;
begin
  perform private.lock_year(p_year_id, '{preparing,requesting,allocating,confirmed,closed}', '{admin,head,deputy_head}');
  v_is_admin := private.has_role(p_year_id, 'admin');
  select yr.role into v_current from public.year_roles yr where yr.year_id = p_year_id and yr.user_id = p_user_id;
  if v_current is null then
    perform private.fail('not_found');
  end if;
  if v_current <> 'staff' and not v_is_admin then
    perform private.fail('forbidden');
  end if;
  if v_current = 'admin'
     and not exists (select 1 from public.year_roles where year_id = p_year_id and role = 'admin' and user_id <> p_user_id) then
    perform private.fail('invalid_state', jsonb_build_object('reason', 'last_admin'));
  end if;
  perform private.set_reason(p_reason);
  delete from public.invitations
  where year_id = p_year_id and role is not null and used_at is null
    and (v_is_admin or role = 'staff')
    and email in (
      select private.verified_email(p_user_id)
      union
      select lower(u.email) from auth.users u where u.id = p_user_id
      union
      select lower(i.identity_data ->> 'email') from auth.identities i
      where i.user_id = p_user_id and i.provider = 'google' and i.identity_data ->> 'email_verified' = 'true');
  delete from public.year_roles where year_id = p_year_id and user_id = p_user_id;
  if not found then perform private.fail('not_found'); end if;
end $$;

-- revoke_invitation：ロールを確かめてからロックする（ロールのない人に行ロックを取らせない）。見つからなければ year_id が null で
-- forbidden（有無を漏らさない）。closed の年度でも取り消せる（年度の状態は見ない）。head・deputy_head が取り消せるのは staff の
-- ロールの招待と団体の招待だけで、ほかは見つからないときと同じ forbidden（使用済みかどうかも漏らさない）
create or replace function public.revoke_invitation(p_invitation_id uuid)
returns void language plpgsql security definer set search_path = '' as $$
declare v public.invitations;
begin
  perform private.assert_role((select i.year_id from public.invitations i where i.id = p_invitation_id), '{admin,head,deputy_head}');
  select * into v from public.invitations where id = p_invitation_id for update;
  if not found then perform private.fail('not_found'); end if;
  if v.role is distinct from 'staff' and v.group_id is null and not private.has_role(v.year_id, 'admin') then
    perform private.fail('forbidden');
  end if;
  if v.used_at is not null then
    perform private.fail('invalid_state', jsonb_build_object('reason', 'used'));
  end if;
  delete from public.invitations where id = p_invitation_id;
end $$;

-- remove_group_member：closed の年度でもできる（0005 のまま。ロールの配列だけを部門長以上に）
create or replace function public.remove_group_member(p_group_id uuid, p_user_id uuid, p_reason text default null)
returns void language plpgsql security definer set search_path = '' as $$
declare v_year_id uuid := private.group_year_id(p_group_id);
begin
  perform private.lock_year(v_year_id, '{preparing,requesting,allocating,confirmed,closed}', '{admin,head,deputy_head}');
  perform private.set_reason(p_reason);
  delete from public.group_members where group_id = p_group_id and user_id = p_user_id;
  if not found then perform private.fail('not_found'); end if;
end $$;

-- set_group_member_role（T15 で足した）：団体代表の立場を店長⇄副店長で切り替える（権限は変わらない）。相手のロールによらず
-- （管理者が店長のときも）部門長以上ができる（remove_group_member・団体の招待と同じ）。closed の年度ではできない。
-- 団体がなければ年度が null で forbidden（有無を漏らさない）、団体代表でなければ not_found。同じ立場への変更も1行の更新で
-- 成功する（監査は updated_at だけの変更を記録しない）。role だけの update なので、兼任のトリガー（check_role_overlap）は動かない
create function public.set_group_member_role(p_group_id uuid, p_user_id uuid, p_group_role public.group_role,
                                             p_reason text default null)
returns void language plpgsql security definer set search_path = '' as $$
declare v_year_id uuid := private.group_year_id(p_group_id);
begin
  perform private.lock_year(v_year_id, '{preparing,requesting,allocating,confirmed}', '{admin,head,deputy_head}');
  if p_group_role is null then
    perform private.fail('invalid_input', jsonb_build_object('field', 'group_role'));
  end if;
  perform private.set_reason(p_reason);
  update public.group_members set role = p_group_role where group_id = p_group_id and user_id = p_user_id;
  if not found then perform private.fail('not_found'); end if;
end $$;

------------------------------------------------------------------------
-- 振り分け・了承・申請・受け渡しの RPC（0006 の関数を置き換える）
------------------------------------------------------------------------
-- create or replace は本体ごと書くので、0006 から写してロールの確かめだけを直した（0006 との差分はロールの配列と、set_consent の
-- v_is_admin → v_is_lead、submit_requests の最初の確かめ、update_requests_after_deadline の注釈だけ）。
--   save_auto_allocations・save_allocation_rows・update_requests_after_deadline・previous_year_requests：部門長以上
--   set_consent・submit_requests：admin の枝を部門長以上に（団体代表の枝は変えない）
--   check_delivery・previous_year_stocks：総務
create or replace function public.save_auto_allocations(p_year_id uuid, p_rows jsonb, p_mode text, p_base_version integer)
returns jsonb language plpgsql security definer set search_path = '' as $$
declare
  v_year public.years;
  v_rows private.auto_row[];
  v_bad  jsonb;
  v_del  integer;
  v_upd  integer;
  v_ins  integer;
begin
  -- 1. ロール → 状態 → 版
  v_year := private.lock_year(p_year_id, '{allocating}', '{admin,head,deputy_head}');
  if p_base_version is distinct from v_year.allocation_version then
    perform private.fail('conflict', jsonb_build_object('allocation_version', v_year.allocation_version));
  end if;
  if p_mode is null or p_mode not in ('full', 'minimal_change') then
    perform private.fail('invalid_input', jsonb_build_object('field', 'mode'));
  end if;

  -- 2. 入力の形と参照
  v_rows := private.parse_auto_rows(p_rows);
  select jsonb_agg(r.ord order by r.ord) into v_bad
  from unnest(v_rows) r
  where r.source_room_id is null or r.group_id is null or r.item_id is null or r.requested_item_id is null
     or r.count is null or r.count <= 0 or r.count > 10000
     or not exists (select 1 from public.groups g where g.id = r.group_id and g.year_id = p_year_id)
     or not exists (select 1 from public.rooms rm where rm.id = r.source_room_id)
     or not exists (select 1 from public.items i where i.id = r.item_id)
     or not exists (select 1 from public.items i where i.id = r.requested_item_id);
  if v_bad is not null then
    perform private.fail('invalid_input', jsonb_build_object('rows', v_bad));
  end if;
  select jsonb_agg(d.k) into v_bad from (
    select jsonb_build_object('source_room_id', r.source_room_id, 'group_id', r.group_id,
                              'requested_item_id', r.requested_item_id, 'item_id', r.item_id) as k
    from unnest(v_rows) r
    group by r.source_room_id, r.group_id, r.requested_item_id, r.item_id
    having count(*) > 1) d;
  if v_bad is not null then
    perform private.fail('invalid_input', jsonb_build_object('duplicates', v_bad));
  end if;

  -- 3. E002・E005（is_keep は DB が決め直す）
  select jsonb_agg(jsonb_build_object('code', 'E002', 'ord', r.ord, 'room_id', r.source_room_id)) into v_bad
  from unnest(v_rows) r
  join public.room_years ry on ry.year_id = p_year_id and ry.room_id = r.source_room_id
  where not ry.usable;
  if v_bad is not null then perform private.fail('E002', v_bad); end if;

  select jsonb_agg(jsonb_build_object('code', 'E005', 'ord', r.ord, 'group_id', r.group_id)) into v_bad
  from unnest(v_rows) r join public.groups g on g.id = r.group_id
  where r.is_keep and r.source_room_id is distinct from g.location_room_id;
  if v_bad is not null then perform private.fail('E005', v_bad); end if;

  select coalesce(array_agg(row(r.ord, r.source_room_id, r.group_id, r.item_id, r.requested_item_id, r.count,
                                 r.source_room_id is not distinct from g.location_room_id)::private.auto_row order by r.ord), '{}')
  into v_rows
  from unnest(v_rows) r join public.groups g on g.id = r.group_id;

  -- 4. 理由を置いてから、auto かつ未固定の行だけを差分で入れ替える
  perform private.set_reason(case p_mode when 'full' then '自動振り分け（全体）' else '自動振り分け（最小変更）' end);

  with cur as (
    select a.id, a.source_room_id, a.group_id, a.requested_item_id, a.item_id,
           count(*) over (partition by a.source_room_id, a.group_id, a.requested_item_id, a.item_id) as n
    from public.allocations a
    where a.year_id = p_year_id and a.origin = 'auto' and not a.pinned)
  delete from public.allocations a using cur
  where a.id = cur.id
    and (cur.n > 1 or not exists (
      select 1 from unnest(v_rows) r
      where r.source_room_id = cur.source_room_id and r.group_id = cur.group_id
        and r.requested_item_id = cur.requested_item_id and r.item_id = cur.item_id));
  get diagnostics v_del = row_count;

  update public.allocations a set count = r.count, is_keep = r.is_keep
  from unnest(v_rows) r
  where a.year_id = p_year_id and a.origin = 'auto' and not a.pinned
    and a.source_room_id = r.source_room_id and a.group_id = r.group_id
    and a.requested_item_id = r.requested_item_id and a.item_id = r.item_id
    and (a.count, a.is_keep) is distinct from (r.count, r.is_keep);
  get diagnostics v_upd = row_count;

  insert into public.allocations (year_id, source_room_id, group_id, item_id, requested_item_id, count, is_keep, pinned, origin)
  select p_year_id, r.source_room_id, r.group_id, r.item_id, r.requested_item_id, r.count, r.is_keep, false, 'auto'
  from unnest(v_rows) r
  where not exists (
    select 1 from public.allocations a
    where a.year_id = p_year_id and a.origin = 'auto' and not a.pinned
      and a.source_room_id = r.source_room_id and a.group_id = r.group_id
      and a.requested_item_id = r.requested_item_id and a.item_id = r.item_id)
  order by r.ord;
  get diagnostics v_ins = row_count;

  -- 5. 保存後の在庫超過（固定・手動の行を含む）。あれば全体を取り消す
  select jsonb_agg(i) into v_bad
  from jsonb_array_elements(private.confirm_issues(p_year_id)) i
  where i ->> 'code' = 'E001';
  if v_bad is not null then perform private.fail('E001', v_bad); end if;

  update public.years set auto_allocated_at = now() where id = p_year_id;
  return jsonb_build_object(
    'allocation_version', (select y.allocation_version from public.years y where y.id = p_year_id),
    'deleted', v_del, 'updated', v_upd, 'inserted', v_ins);
exception
  -- 上で確かめきれなかった形の誤り（22xxx）と CHECK 違反（23514）も invalid_input にする（生の SQLSTATE を返さない）
  when data_exception or check_violation then
    perform private.fail('invalid_input', jsonb_build_object('field', 'rows'));
end $$;

create or replace function public.save_allocation_rows(p_year_id uuid, p_changes jsonb, p_reason text)
returns jsonb language plpgsql security definer set search_path = '' as $$
declare
  c jsonb;
  v_op text;
  v_old public.allocations;
  v_new public.allocations;
  v_out jsonb := '[]';
  v_loc uuid;
  v_data_changed boolean;
  v_version_before integer;
begin
  -- ロックした時点の版（自分の書き込みの前）。画面は、これが自分の持つ版と同じときだけ返り値の版を覚え直す
  v_version_before := (private.lock_year(p_year_id, '{allocating}', '{admin,head,deputy_head}')).allocation_version;
  if p_changes is null or jsonb_typeof(p_changes) <> 'array'
     or jsonb_array_length(p_changes) not between 1 and 1000 then
    perform private.fail('invalid_input', jsonb_build_object('field', 'changes'));
  end if;
  if (select count(*) <> count(distinct e ->> 'id') from jsonb_array_elements(p_changes) e where e ? 'id') then
    perform private.fail('invalid_input', jsonb_build_object('reason', 'duplicate_id'));
  end if;
  perform private.set_reason(p_reason, true);

  for c in select e from jsonb_array_elements(p_changes) e loop
    v_op := c ->> 'op';
    if v_op = 'insert' then
      v_new := null;
      v_new.year_id := p_year_id;
      v_new.source_room_id := (c ->> 'sourceRoomId')::uuid;
      v_new.group_id := (c ->> 'groupId')::uuid;
      v_new.item_id := (c ->> 'itemId')::uuid;
      v_new.requested_item_id := (c ->> 'requestedItemId')::uuid;
      v_new.count := (c ->> 'count')::integer;
      v_new.pinned := coalesce((c ->> 'pinned')::boolean, false);
      v_new.note := c ->> 'note';
      v_new.origin := 'manual';
    elsif v_op in ('update', 'delete') then
      select * into v_old from public.allocations a
      where a.id = (c ->> 'id')::uuid and a.year_id = p_year_id for update;
      if not found or date_trunc('milliseconds', v_old.updated_at)
                      is distinct from date_trunc('milliseconds', (c ->> 'updatedAt')::timestamptz) then
        perform private.fail('conflict', jsonb_build_object('id', c ->> 'id'));
      end if;
      if v_op = 'delete' then
        delete from public.allocations where id = v_old.id;
        v_out := v_out || jsonb_build_object('op', 'delete', 'id', v_old.id);
        continue;
      end if;
      v_new := v_old;
      if c ? 'sourceRoomId' then v_new.source_room_id := (c ->> 'sourceRoomId')::uuid; end if;
      if c ? 'itemId' then v_new.item_id := (c ->> 'itemId')::uuid; end if;
      if c ? 'requestedItemId' then v_new.requested_item_id := (c ->> 'requestedItemId')::uuid; end if;
      if c ? 'count' then v_new.count := (c ->> 'count')::integer; end if;
      if c ? 'note' then v_new.note := c ->> 'note'; end if;
      if c ? 'pinned' then v_new.pinned := (c ->> 'pinned')::boolean; end if;
      v_data_changed := (v_new.source_room_id, v_new.item_id, v_new.requested_item_id, v_new.count, v_new.note)
             is distinct from (v_old.source_room_id, v_old.item_id, v_old.requested_item_id, v_old.count, v_old.note);
      if v_data_changed then v_new.origin := 'manual'; end if;
    else
      perform private.fail('invalid_input', jsonb_build_object('field', 'op'));
    end if;

    -- 共通の検査
    if length(v_new.note) > 2000 then
      perform private.fail('invalid_input', jsonb_build_object('field', 'note'));
    end if;
    if v_new.source_room_id is null or v_new.item_id is null or v_new.requested_item_id is null
       or v_new.count is null or v_new.count <= 0 or v_new.count > 10000 or v_new.pinned is null
       or not exists (select 1 from public.rooms where id = v_new.source_room_id)
       or not exists (select 1 from public.items where id = v_new.item_id)
       or not exists (select 1 from public.items where id = v_new.requested_item_id) then
      perform private.fail('invalid_input', c);
    end if;
    select g.location_room_id into v_loc from public.groups g where g.id = v_new.group_id and g.year_id = p_year_id;
    if not found then perform private.fail('invalid_input', jsonb_build_object('field', 'groupId')); end if;
    if exists (select 1 from public.room_years ry
               where ry.year_id = p_year_id and ry.room_id = v_new.source_room_id and not ry.usable) then
      perform private.fail('E002', jsonb_build_object('room_id', v_new.source_room_id));
    end if;
    v_new.is_keep := v_new.source_room_id is not distinct from v_loc;

    if v_op = 'insert' then
      insert into public.allocations (year_id, source_room_id, group_id, item_id, requested_item_id, count, is_keep, pinned, origin, note)
      values (v_new.year_id, v_new.source_room_id, v_new.group_id, v_new.item_id, v_new.requested_item_id,
              v_new.count, v_new.is_keep, v_new.pinned, v_new.origin, v_new.note)
      returning * into v_new;
    else
      update public.allocations set
        source_room_id = v_new.source_room_id, item_id = v_new.item_id, requested_item_id = v_new.requested_item_id,
        count = v_new.count, note = v_new.note, pinned = v_new.pinned, origin = v_new.origin, is_keep = v_new.is_keep
      where id = v_old.id
      returning * into v_new;
    end if;
    v_out := v_out || jsonb_build_object('op', v_op, 'row', to_jsonb(v_new));
  end loop;

  return jsonb_build_object(
    'allocation_version_before', v_version_before,
    'allocation_version', (select y.allocation_version from public.years y where y.id = p_year_id),
    'rows', v_out);
exception
  when data_exception or check_violation then   -- 22xxx（uuid・整数・日時の形、範囲外の日付）と CHECK
    perform private.fail('invalid_input', jsonb_build_object('field', 'changes'));
end $$;

create or replace function public.set_consent(p_group_id uuid, p_from_item uuid, p_to_item uuid,
                                   p_status public.consent_status, p_note text default null)
returns public.substitution_consents language plpgsql security definer set search_path = '' as $$
declare
  v_year_id uuid := private.group_year_id(p_group_id);
  v_is_lead boolean := private.has_any_role(v_year_id, '{admin,head,deputy_head}');
  v_cur public.substitution_consents;
  v_found boolean;
  v_total integer;
  v_count integer;
  v_res public.substitution_consents;
begin
  if v_year_id is null or not (v_is_lead or private.is_group_member(p_group_id)) then
    perform private.fail('forbidden');
  end if;
  perform 1 from public.years where id = v_year_id for no key update;
  -- ロックの後でもう一度ロールと状態を確かめる
  v_is_lead := private.has_any_role(v_year_id, '{admin,head,deputy_head}');
  if not (v_is_lead or private.is_group_member(p_group_id)) then
    perform private.fail('forbidden');
  end if;
  if private.year_status(v_year_id) <> 'allocating' then
    perform private.fail('invalid_state', jsonb_build_object('status', private.year_status(v_year_id)));
  end if;
  if p_status is null or p_from_item is null or p_to_item is null or p_from_item = p_to_item
     or (select count(*) from public.items where id in (p_from_item, p_to_item)) <> 2
     or length(p_note) > 2000 then
    perform private.fail('invalid_input');
  end if;
  select * into v_cur from public.substitution_consents
  where group_id = p_group_id and from_item_id = p_from_item and to_item_id = p_to_item for update;
  v_found := found;
  if not v_is_lead then
    if p_status not in ('accepted', 'declined') then perform private.fail('forbidden'); end if;
    if not v_found or v_cur.status = 'not_asked' then perform private.fail('invalid_state'); end if;
  end if;

  select coalesce(sum(a.count), 0) into v_total from public.allocations a
  where a.year_id = v_year_id and a.group_id = p_group_id
    and a.requested_item_id = p_from_item and a.item_id = p_to_item;
  v_count := v_cur.count;
  if p_status = 'asked' then
    if v_total = 0 then perform private.fail('invalid_state', jsonb_build_object('reason', 'no_rows')); end if;
    v_count := v_total;
  elsif p_status = 'accepted' then
    if v_count is null then
      v_count := v_total;
    elsif v_total > v_count then
      perform private.fail('conflict', jsonb_build_object('asked', v_count, 'current', v_total));
    end if;
  end if;

  perform private.set_reason(format('交換の了承を記録（%s）', p_status));
  insert into public.substitution_consents (group_id, from_item_id, to_item_id, count, status, note)
  values (p_group_id, p_from_item, p_to_item, v_count, p_status, p_note)
  on conflict (group_id, from_item_id, to_item_id) do update
    set count = excluded.count, status = excluded.status,
        note = coalesce(excluded.note, public.substitution_consents.note)
  returning * into v_res;

  if p_status = 'accepted' then
    update public.allocations set pinned = true
    where year_id = v_year_id and group_id = p_group_id
      and requested_item_id = p_from_item and item_id = p_to_item and not pinned;
  elsif p_status = 'declined' then
    update public.allocations set pinned = false
    where year_id = v_year_id and group_id = p_group_id
      and requested_item_id = p_from_item and item_id = p_to_item and pinned;
  end if;
  return v_res;
exception
  -- CHECK 違反（count の上限など）と形の誤りは invalid_input にする（生の SQLSTATE を返さない）
  when data_exception or check_violation then
    perform private.fail('invalid_input');
end $$;

create or replace function public.update_requests_after_deadline(p_group_id uuid, p_rows jsonb, p_reason text,
                                                      p_submission jsonb default null)
returns void language plpgsql security definer set search_path = '' as $$
declare
  v_year_id uuid := private.group_year_id(p_group_id);
  v_rows private.request_row[];
  r private.request_row;
  v_cur public.requests;
  v_submitted_at timestamptz;
begin
  perform private.lock_year(v_year_id, '{preparing,requesting,allocating}', '{admin,head,deputy_head}');
  perform private.set_reason(p_reason, true);
  v_rows := private.parse_request_rows(p_rows);
  -- p_submission：{ "submitted": true, "submittedAt": "…", "note": "…" }（どのキーも省略できる）。
  -- submitted は true だけを受け付ける（提出済みにする。提出済みなら最初の提出日時を保つ）。未提出に戻すと D-07 で需要が
  -- fixed_request に変わって振り分けが変わるので、この RPC では戻さない（false は invalid_input）。
  -- submittedAt（ISO の日時。CSV の取り込みでフォームのタイムスタンプを渡す）があれば、提出済みにして提出日時をその値にする
  -- （提出済みでも置き換える。未来の日時は invalid_input）。部門長以上だけが呼べるので、団体代表は日時を偽れない
  if p_submission is not null and (jsonb_typeof(p_submission) <> 'object' or length(p_submission ->> 'note') > 2000
     or (p_submission ? 'submitted' and p_submission -> 'submitted' is distinct from 'true'::jsonb)
     or (p_submission ? 'submittedAt' and jsonb_typeof(p_submission -> 'submittedAt') is distinct from 'string')
     or (p_submission ? 'note' and jsonb_typeof(p_submission -> 'note') not in ('string', 'null'))
     or exists (select 1 from jsonb_object_keys(p_submission) k where k not in ('submitted', 'submittedAt', 'note'))) then
    perform private.fail('invalid_input', jsonb_build_object('field', 'submission'));
  end if;
  if p_submission ? 'submittedAt' then
    -- ISO 8601 の日時でオフセットつきだけを受け付ける（'now'・'infinity' などの特別な値と、セッションのタイムゾーンで
    -- 読まれる値を通さない。画面の zod の z.iso.datetime({ offset: true }) と同じ）
    begin
      if (p_submission ->> 'submittedAt')
         !~ '^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}(:\d{2}(\.\d+)?)?(Z|[+-]\d{2}(:?\d{2})?)$' then
        raise exception using errcode = '22007';
      end if;
      v_submitted_at := (p_submission ->> 'submittedAt')::timestamptz;
    exception when data_exception then
      v_submitted_at := null;
    end;
    if v_submitted_at is null or v_submitted_at > now() then
      perform private.fail('invalid_input', jsonb_build_object('field', 'submittedAt'));
    end if;
  end if;
  foreach r in array v_rows loop
    select * into v_cur from public.requests where group_id = p_group_id and item_id = r.item_id for update;
    if found then
      if r.updated_at is null or date_trunc('milliseconds', v_cur.updated_at) <> date_trunc('milliseconds', r.updated_at) then
        perform private.fail('conflict', jsonb_build_object('item_id', r.item_id));
      end if;
      update public.requests set count = r.count where group_id = p_group_id and item_id = r.item_id;
    else
      if r.updated_at is not null then
        perform private.fail('conflict', jsonb_build_object('item_id', r.item_id));
      end if;
      insert into public.requests (group_id, item_id, count) values (p_group_id, r.item_id, r.count);
    end if;
  end loop;
  if p_submission is not null then
    -- 提出日時を渡されたときだけ、提出の記録のトリガー（set_actor）が値を now() に置き換えないようにする（この文の間だけ）
    if v_submitted_at is not null then
      perform set_config('app.keep_submitted_at', 'on', true);
    end if;
    insert into public.request_submissions (group_id, submitted_at, note)
    values (p_group_id,
            case when v_submitted_at is not null then v_submitted_at when p_submission ? 'submitted' then now() end,
            p_submission ->> 'note')
    on conflict (group_id) do update set
      submitted_at = case when v_submitted_at is not null then v_submitted_at
                          when p_submission ? 'submitted'
                          then coalesce(public.request_submissions.submitted_at, now())
                          else public.request_submissions.submitted_at end,
      note = case when p_submission ? 'note' then p_submission ->> 'note'
                  else public.request_submissions.note end;
    perform set_config('app.keep_submitted_at', '', true);
  end if;
exception
  when data_exception or check_violation then
    perform private.fail('invalid_input', jsonb_build_object('field', 'rows'));
end $$;

create or replace function public.submit_requests(p_group_id uuid, p_rows jsonb, p_note text default null)
returns public.request_submissions language plpgsql security definer set search_path = '' as $$
declare
  v_year_id uuid := private.group_year_id(p_group_id);
  r private.request_row;
  v_res public.request_submissions;
begin
  if v_year_id is null or not (private.has_any_role(v_year_id, '{admin,head,deputy_head}') or private.is_group_member(p_group_id)) then
    perform private.fail('forbidden');
  end if;
  -- 年度の行をロックしてから締切を確かめる（状態の遷移と順に処理する。受付中は for share なので提出どうしは並行してよい）
  perform private.lock_year_guard(v_year_id);
  if not private.can_write_requests(p_group_id) then
    perform private.fail('invalid_state', jsonb_build_object('status', private.year_status(v_year_id)));
  end if;
  if length(p_note) > 2000 then
    perform private.fail('invalid_input', jsonb_build_object('field', 'note'));
  end if;
  perform private.set_reason(null);                 -- 理由の要らない書き込み（監査の reason は空）
  foreach r in array private.parse_request_rows(p_rows) loop
    insert into public.requests (group_id, item_id, count) values (p_group_id, r.item_id, r.count)
    on conflict (group_id, item_id) do update set count = excluded.count
    where public.requests.count is distinct from excluded.count;
  end loop;
  insert into public.request_submissions (group_id, submitted_at, note)
  values (p_group_id, now(), p_note)
  on conflict (group_id) do update set submitted_at = now(), note = excluded.note
  returning * into v_res;
  return v_res;
exception
  when data_exception or check_violation then
    perform private.fail('invalid_input', jsonb_build_object('field', 'rows'));
end $$;

create or replace function public.check_delivery(p_delivery_id uuid, p_status public.delivery_status,
                                      p_problem_note text default null, p_returned boolean default null)
returns public.deliveries language plpgsql security definer set search_path = '' as $$
declare
  v_year_id uuid := (select d.year_id from public.deliveries d where d.id = p_delivery_id);
  v public.deliveries;
begin
  perform private.assert_role(v_year_id, '{admin,head,deputy_head,staff}');
  if private.year_status(v_year_id) not in ('confirmed', 'closed') then      -- 返却チェックは closed でも（01 の 9）
    perform private.fail('invalid_state');
  end if;
  if p_status is null or length(p_problem_note) > 2000 then perform private.fail('invalid_input'); end if;
  update public.deliveries set
    status = p_status,
    problem_note = p_problem_note,
    returned = coalesce(p_returned, returned),
    checked_by = auth.uid(),
    checked_at = now()
  where id = p_delivery_id
  returning * into v;
  return v;
exception
  when data_exception or check_violation then
    perform private.fail('invalid_input');
end $$;

create or replace function public.previous_year_stocks(p_year_id uuid)
returns table (room_id uuid, item_id uuid, count integer)
language plpgsql stable security definer set search_path = '' as $$
begin
  perform private.assert_role(p_year_id, '{admin,head,deputy_head,staff}');
  return query
    select s.room_id, s.item_id, s.count
    from public.years y join public.stocks s on s.year_id = y.prev_year_id
    where y.id = p_year_id;
end $$;

create or replace function public.previous_year_requests(p_year_id uuid)
returns table (group_name text, item_id uuid, count integer)
language plpgsql stable security definer set search_path = '' as $$
begin
  perform private.assert_role(p_year_id, '{admin,head,deputy_head}');
  return query
    select g.name, r.item_id, r.count
    from public.years y
    join public.groups g on g.year_id = y.prev_year_id
    join public.requests r on r.group_id = g.id
    where y.id = p_year_id;
end $$;

------------------------------------------------------------------------
-- 権限
------------------------------------------------------------------------
-- 判定関数 can_lead はポリシー・トリガーが呼ぶので authenticated に与える（ほかの判定関数と同じ）。RPC は 0005 と同じ繰り返しで、
-- ここで作った・作り直した 16 個に与える。authenticated が実行できる public の関数は 18 個、private の判定関数は 17 個になる
revoke all on all functions in schema private from public;
revoke all on function private.can_lead(uuid) from public, anon;
grant execute on function private.can_lead(uuid) to authenticated;
do $$
declare f text;
begin
  foreach f in array array[
    'public.set_year_status(uuid, public.year_status, text, integer)',
    'public.update_year(uuid, jsonb, text)',
    'public.invite(uuid, text, public.app_role, uuid, public.group_role)',
    'public.set_role(uuid, uuid, public.app_role, text)',
    'public.remove_role(uuid, uuid, text)',
    'public.revoke_invitation(uuid)',
    'public.remove_group_member(uuid, uuid, text)',
    'public.set_group_member_role(uuid, uuid, public.group_role, text)',
    'public.save_auto_allocations(uuid, jsonb, text, integer)',
    'public.save_allocation_rows(uuid, jsonb, text)',
    'public.set_consent(uuid, uuid, uuid, public.consent_status, text)',
    'public.update_requests_after_deadline(uuid, jsonb, text, jsonb)',
    'public.submit_requests(uuid, jsonb, text)',
    'public.check_delivery(uuid, public.delivery_status, text, boolean)',
    'public.previous_year_stocks(uuid)',
    'public.previous_year_requests(uuid)'] loop
    execute format('revoke all on function %s from public, anon', f);
    execute format('grant execute on function %s to authenticated', f);
  end loop;
end $$;
