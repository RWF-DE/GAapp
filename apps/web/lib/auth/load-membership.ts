import type { AppSupabaseClient } from '@/lib/supabase/client';
import { buildMembership, type Membership, type MembershipSource } from './membership';

/**
 * ログインしている人の立場を読む。最初に accept_my_invitations を呼び、invite と初回ログインが行き違って
 * 未使用のまま残った招待を受け入れる（04「DB関数」。画面はログインのたびに呼ぶ）。
 * 読み取りは RLS の範囲だけ：招待されていない人は自分の profiles 以外は何も返らない。
 */
export async function loadMembershipSource(supabase: AppSupabaseClient, userId: string): Promise<MembershipSource> {
  const accepted = await supabase.rpc('accept_my_invitations');
  if (accepted.error) throw accepted.error;

  const [profile, roles, members, years] = await Promise.all([
    supabase.from('profiles').select('display_name').eq('user_id', userId).maybeSingle(),
    supabase.from('year_roles').select('year_id, role').eq('user_id', userId),
    supabase.from('group_members').select('group_id, groups (id, name, year_id)').eq('user_id', userId),
    supabase.from('years').select('id, label, status, festival_start'),
  ]);
  for (const r of [profile, roles, members, years]) {
    if (r.error) throw r.error;
  }

  return {
    displayName: profile.data?.display_name ?? null,
    years: years.data ?? [],
    roles: roles.data ?? [],
    groups: (members.data ?? []).flatMap((m) => (m.groups ? [m.groups] : [])),
  };
}

/** 立場を読んで組み立てる（selectedYearId は選んだ年度。1.3.1） */
export async function loadMembership(supabase: AppSupabaseClient, userId: string, selectedYearId?: string | null): Promise<Membership> {
  return buildMembership(await loadMembershipSource(supabase, userId), selectedYearId);
}
