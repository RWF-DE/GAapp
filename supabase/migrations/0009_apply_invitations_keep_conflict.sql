-- 0009_apply_invitations_keep_conflict.sql（T03 のマージの後の直し）：別のロールを持つ人へのロールの招待を使用済みにしない
-- 0005 の apply_invitations は、その年度で本人がもう別のロールを持っていると、year_roles の insert が
-- on conflict do nothing で何もせず、招待だけを使用済み（used_at）にしていた。管理者には招待が使われたように見え、
-- 依頼したロールの変更は黙って捨てられる（invite の conflict の確認は、招待した時点で本人のメールを確かめられた
-- アカウントにしかかからないため、確かめられなかった人が後で受け入れるときに起きる）。
-- 04 の招待の決まり（別のロールを持っていればエラー）に合わせ、その招待は使用済みにせず残す。管理者の画面では未使用のまま見え、
-- ロールを変えたいときは、管理者が set_role で変えるか、招待を取り消す。受け入れの件数にも数えない。
-- 同じロールを持っているとき・ロールを持っていないとき・団体代表の招待は、今までどおり。
-- 引数・返り値・SECURITY DEFINER・search_path・権限（private の関数は PUBLIC から外したまま。create or replace は権限を保つ）は変えない。
--
-- 招待を残すようにしたので、remove_role も直す（下）。0005 の remove_role は year_roles を消すだけで、本人あての未使用の
-- ロールの招待に触れないため、管理者が人を外すつもりで remove_role をしても、残っていた招待のロールが次のログインで付き、
-- 外したはずの人に権限が戻っていた。「外す」は外すだけにする（ロールを変えるのは set_role）。

create or replace function private.apply_invitations(p_user_id uuid, p_email text)
returns integer language plpgsql security definer set search_path = '' as $$
declare
  inv record;
  v_n integer := 0;
begin
  for inv in
    select i.id, i.year_id, i.role, i.group_id
    from public.invitations i join public.years y on y.id = i.year_id
    where i.email = lower(btrim(p_email)) and i.used_at is null and y.status <> 'closed'
    order by i.created_at
    for update of i
  loop
    if inv.role is not null then
      insert into public.year_roles (year_id, user_id, role) values (inv.year_id, p_user_id, inv.role)
      on conflict (year_id, user_id) do nothing;
      -- 行が既にあった：同じロールなら使用済みにする。別のロールなら招待を残す（ロールも変えない）。
      -- insert が同時の書き込みを待った後でも、この select は新しいスナップショットで確定した行を読む（read committed）
      if not found and not exists (
        select 1 from public.year_roles yr
        where yr.year_id = inv.year_id and yr.user_id = p_user_id and yr.role = inv.role) then
        continue;
      end if;
    else
      insert into public.group_members (group_id, user_id) values (inv.group_id, p_user_id)
      on conflict (group_id, user_id) do nothing;
    end if;
    update public.invitations set used_at = now() where id = inv.id;
    v_n := v_n + 1;
  end loop;
  return v_n;
end $$;

-- ロールを外す。closed の年度でもできる（卒業した admin を外して、権限を残さないため）。最後の admin は外せない。
-- 外した人の、本人のものと確かめられるメール（private.verified_email）あての、その年度の未使用のロールの招待も消す
-- （残すと次のログインでそのロールが付く）。メールを確かめられなければ招待には触れない（だれあての招待かを決められないため）。
-- 団体代表の招待（role が null）は消さない（団体代表を外すのは remove_group_member）。
-- 引数・返り値・SECURITY DEFINER・search_path・最初のロールの確認・権限（create or replace は権限を保つ）は 0005 と同じ
create or replace function public.remove_role(p_year_id uuid, p_user_id uuid, p_reason text default null)
returns void language plpgsql security definer set search_path = '' as $$
declare v_email text;
begin
  perform private.lock_year(p_year_id, '{preparing,requesting,allocating,confirmed,closed}', '{admin}');
  if exists (select 1 from public.year_roles where year_id = p_year_id and user_id = p_user_id and role = 'admin')
     and not exists (select 1 from public.year_roles where year_id = p_year_id and role = 'admin' and user_id <> p_user_id) then
    perform private.fail('invalid_state', jsonb_build_object('reason', 'last_admin'));
  end if;
  perform private.set_reason(p_reason);
  delete from public.year_roles where year_id = p_year_id and user_id = p_user_id;
  if not found then perform private.fail('not_found'); end if;
  v_email := private.verified_email(p_user_id);
  if v_email is not null then
    delete from public.invitations
    where year_id = p_year_id and email = v_email and role is not null and used_at is null;
  end if;
end $$;
