-- 0007_auth.sql（T04）：auth.users のトリガーと Before User Created フック
--
-- 確かめたこと（notes/T04.md）：
-- - GoTrue（v2.197）は外部 ID（Google）のユーザーを、email_confirmed_at が null のまま insert し、同じトランザクションの
--   後の update で確認済みにする（internal/api/external.go の createAccountFromExternalIdentity → user.Confirm）。
--   そのため招待の受け入れは on_auth_user_confirmed で起きる。seed のように確認済みで insert されたときは on_auth_user_created で起きる。
-- - フックの入力は {"metadata": {...}, "user": {...}}。user.app_metadata.provider にプロバイダー（"google"・"email"）、
--   Google の ID トークンに hd があれば user.user_metadata.custom_claims.hd に入る（internal/api/provider/oidc.go）。
--   ID トークンがなく userinfo で取ったときは hd が入らないので、そのときはメールのドメインだけで判定する。
-- - フックは GoTrue の API でユーザーを作るときだけ呼ばれる。seed・SQL Editor の insert と、管理 API（admin）の作成では呼ばれない。

------------------------------------------------------------------------
-- auth.users への追加：profiles を作る。招待の受け入れは、メールを確認済みのときだけ
------------------------------------------------------------------------
-- 表示名は Google の氏名（full_name → name）。なければ「名前未設定」。メールの @ より前は使わない（学籍番号などが入り得るため）。
-- 例外を握りつぶさない（失敗するとユーザーの作成も失敗し、GoTrue は「Database error saving new user」を返す）。
-- そのため中の insert はすべて on conflict で衝突しないようにしてある。

-- 招待を受け入れる（監査の理由は「招待の受け入れ」）。理由は transaction-local なので、受け入れの後で元に戻す
-- （seed や SQL Editor の同じトランザクションの後の書き込みに、この理由が残らないように）
create function private.accept_invitations_of(p_user_id uuid, p_email text)
returns void language plpgsql security definer set search_path = '' as $$
declare v_prev text := current_setting('app.reason', true);
begin
  perform private.set_reason('招待の受け入れ');
  perform private.apply_invitations(p_user_id, p_email);
  perform set_config('app.reason', coalesce(v_prev, ''), true);
end $$;

create function private.handle_new_user()
returns trigger language plpgsql security definer set search_path = '' as $$
begin
  insert into public.profiles (user_id, display_name)
  values (new.id, left(coalesce(nullif(btrim(new.raw_user_meta_data ->> 'full_name'), ''),
                                nullif(btrim(new.raw_user_meta_data ->> 'name'), ''),
                                '名前未設定'), 100))
  on conflict (user_id) do nothing;
  if new.email is not null and new.email_confirmed_at is not null and new.deleted_at is null then
    perform private.accept_invitations_of(new.id, new.email);
  end if;
  return null;
end $$;
create trigger on_auth_user_created after insert on auth.users
  for each row execute function private.handle_new_user();

-- メールの確認（Google のユーザーはここで招待が付く）
create function private.handle_user_confirmed()
returns trigger language plpgsql security definer set search_path = '' as $$
begin
  if new.email is not null and new.deleted_at is null then
    perform private.accept_invitations_of(new.id, new.email);
  end if;
  return null;
end $$;
create trigger on_auth_user_confirmed after update of email_confirmed_at on auth.users
  for each row when (old.email_confirmed_at is null and new.email_confirmed_at is not null)
  execute function private.handle_user_confirmed();

------------------------------------------------------------------------
-- Before User Created フック
------------------------------------------------------------------------
-- Google 以外のプロバイダー（メールのサインアップなど）と、学校のドメイン以外を拒否する。
-- プロバイダーを見るのは、本番でメールログインを無効にし忘れたときに、学校のドメインのメールでのサインアップを止めるため。
-- E2E のテストユーザー（@example.test）は seed で auth.users に直接入れるので、このフックを通らない（D-02）。
-- 表を読まないので SECURITY DEFINER にしない（supabase_auth_admin として動く）。
create function private.hook_before_user_created(event jsonb)
returns jsonb language plpgsql stable set search_path = '' as $$
declare
  c_domain constant text := 'school.example';          -- D-04：学校の Google ドメイン（仮。決まったらこの1行を直す）
  v_provider text := event -> 'user' -> 'app_metadata' ->> 'provider';
  v_hd text := lower(event -> 'user' -> 'user_metadata' -> 'custom_claims' ->> 'hd');
  v_email text := lower(btrim(event -> 'user' ->> 'email'));
  v_email_domain text;
begin
  if v_email is not null and v_email ~ '^[^@[:space:]]+@[^@[:space:]]+$' then
    v_email_domain := split_part(v_email, '@', 2);
  end if;
  -- hd があれば hd とメールの両方、なければメールのドメインだけで判定する
  if v_provider = 'google' and v_email_domain = c_domain and coalesce(v_hd, v_email_domain) = c_domain then
    return '{}'::jsonb;
  end if;
  return jsonb_build_object('error', jsonb_build_object(
    'http_code', 403, 'message', '学校の Google アカウントでログインしてください'));
end $$;

------------------------------------------------------------------------
-- 権限
------------------------------------------------------------------------
-- トリガー関数は誰にも execute を与えない（トリガーは関数の持ち主の postgres の権限で動く）。
-- フックは supabase_auth_admin だけが実行できる。supabase_auth_admin が実行できる関数はフックだけ（010 で確かめる）。
revoke all on function private.accept_invitations_of(uuid, text) from public, anon, authenticated;
revoke all on function private.handle_new_user() from public, anon, authenticated;
revoke all on function private.handle_user_confirmed() from public, anon, authenticated;
revoke all on function private.hook_before_user_created(jsonb) from public, anon, authenticated;
grant usage on schema private to supabase_auth_admin;
grant execute on function private.hook_before_user_created(jsonb) to supabase_auth_admin;
