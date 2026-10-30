import { COLUMNS, type YearRow } from '@/lib/db/types';
import type { AppSupabaseClient } from '@/lib/supabase/client';
import { buildMembership, type Membership, type MembershipSource } from './membership';

/**
 * ログインしている人の立場を読む。accept_my_invitations を呼び、invite と初回ログインが行き違って
 * 未使用のまま残った招待を受け入れる（04「DB関数」。画面はログインのたびに呼ぶ）。
 * 読み取りは RLS の範囲だけ：招待されていない人は自分の profiles 以外は何も返らない。
 *
 * accept_my_invitations と4つの読み取りは同時に送る（T14。4G で画面を開くまでの往復を1回減らす。notes/T14.md の 4G の速さ）。
 * 受け入れた招待が1件以上あったとき（返り値 > 0。初回ログインなど）だけ、受け入れた後の立場をもう一度読む。
 * years は年度の行の列（COLUMNS.years）をすべて読み、yearRows に入れる（AuthProvider が年度の行のキャッシュに入れ、画面が
 * 年度の行のために往復しない。D-45）。readStartedAt は使った読み取りを送った時刻（先送りの応答を使ったときは、実際に
 * 読んだのはそれより前。seedYearRows の説明）。
 */
export async function loadMembershipSource(supabase: AppSupabaseClient, userId: string): Promise<MembershipSource> {
  const readAll = async () => {
    const startedAt = Date.now();
    const rows = await Promise.all([
      supabase.from('profiles').select('display_name').eq('user_id', userId).maybeSingle(),
      supabase.from('year_roles').select('year_id, role').eq('user_id', userId),
      supabase.from('group_members').select('group_id, groups (id, name, year_id)').eq('user_id', userId),
      supabase.from('years').select(COLUMNS.years),
    ]);
    for (const r of rows) {
      if (r.error) throw r.error;
    }
    return { rows, startedAt };
  };

  const [accepted, first] = await Promise.allSettled([supabase.rpc('accept_my_invitations'), readAll()]);
  if (accepted.status === 'rejected') throw accepted.reason;
  if (accepted.value.error) throw accepted.value.error;
  if (first.status === 'rejected') throw first.reason;
  const read = (accepted.value.data ?? 0) > 0 ? await readAll() : first.value;
  const [profile, roles, members, years] = read.rows;
  const yearRows = (years.data ?? []) as unknown as YearRow[];

  return {
    displayName: profile.data?.display_name ?? null,
    years: yearRows.map((y) => ({ id: y.id, label: y.label, status: y.status, festival_start: y.festival_start })),
    yearRows: { rows: yearRows, readStartedAt: read.startedAt },
    roles: roles.data ?? [],
    groups: (members.data ?? []).flatMap((m) => (m.groups ? [m.groups] : [])),
  };
}

/** 立場を読んで組み立てる（selectedYearId は選んだ年度。1.3.1） */
export async function loadMembership(supabase: AppSupabaseClient, userId: string, selectedYearId?: string | null): Promise<Membership> {
  return buildMembership(await loadMembershipSource(supabase, userId), selectedYearId);
}
