// ダッシュボード（/）のお知らせの欄が読む新着（04「お知らせ一覧」の「ダッシュボードに出すもの」、notes/T17.md「後半（画面）の約束」6。
// T17・D-52・D-53）。読み取りとキーだけの軽いモジュール：/ の先読み（lib/data/screen-queries.ts の planHomePrefetch。ルートの
// レイアウトが読む）がこのクエリを使うので、並べ方・組み立て（lib/modules/notices/portal.ts）とダッシュボードの型と関数
// （lib/modules/portal.ts）を import しない（机椅子の furniture/soumu.ts・rep.ts と同じ形。型だけの import はよい）。
// 読むのは id・宛先・題名・ピン留め・出した日時だけ（本文・宛先の団体・書いた人は読まない。4G の / を軽くする）。
import type { Tables } from '@gaapp/shared';
import { queryOptions } from '@tanstack/react-query';
import { toAppError } from '@/lib/errors';
import { getSupabase, type AppSupabaseClient } from '@/lib/supabase/client';
import type { PortalKind } from '../portal';
import { portalQueryKey } from '../query-key';

/** 新着の select（本文・宛先の団体・書いた人は読まない） */
export const NOTICES_LATEST_SELECT = 'id, audience, title, pinned, created_at';
/** 新着の数（lib/modules/portal.ts の PORTAL_NOTICE_LIMIT と同じ。テストで確かめる） */
export const NOTICES_LATEST_LIMIT = 5;

/** 新着の1行 */
export type NoticeLatestRow = Pick<Tables<'notices'>, 'id' | 'audience' | 'title' | 'pinned' | 'created_at'>;

/** 読む範囲：soumu は総務内のお知らせ、groups は団体あて（全団体・指定の団体。読める範囲は RLS） */
export type NoticeLatestScope = 'soumu' | 'groups';

/**
 * 新着を読む：その年度の、scope の宛先のお知らせを pinned desc・created_at desc・id の順に NOTICES_LATEST_LIMIT 件。
 * 宛先は名前で並べて絞る（団体あてを `<> 'soumu'` で書かない。宛先の種類が増えても黙って入らない）。
 */
export async function loadLatestNotices(yearId: string, scope: NoticeLatestScope, client: AppSupabaseClient = getSupabase()): Promise<NoticeLatestRow[]> {
  const base = client.from('notices').select(NOTICES_LATEST_SELECT).eq('year_id', yearId);
  const filtered = scope === 'soumu' ? base.eq('audience', 'soumu') : base.in('audience', ['all_groups', 'groups']);
  const res = await filtered
    .order('pinned', { ascending: false })
    .order('created_at', { ascending: false })
    .order('id')
    .limit(NOTICES_LATEST_LIMIT);
  if (res.error) throw toAppError(res.error, res.status);
  return (res.data ?? []) as NoticeLatestRow[];
}

/**
 * 新着のクエリ（ダッシュボードの欄〔lib/modules/notices/portal.ts の noticesPortalProvider が select を足す〕と、/ の先読みが
 * 同じキャッシュを読む）。キー：
 * - soumu → `portalQueryKey(yearId, 'notices', 'soumu')`（総務内のお知らせ）
 * - viewer → `portalQueryKey(yearId, 'notices', 'viewer')`（団体あて）
 * - rep → `portalQueryKey(yearId, 'notices', 'rep', ...groupIds)`（団体あて。団体の id は立場の一覧の順。代表する団体が変われば
 *   読める範囲が変わるので別のキャッシュ）
 *
 * @example
 * noticesLatestOptions(yearId, 'rep', m.groups.map((g) => g.id))
 */
export function noticesLatestOptions(yearId: string, kind: PortalKind, groupIds: readonly string[] = []) {
  const scope: NoticeLatestScope = kind === 'soumu' ? 'soumu' : 'groups';
  const extra = kind === 'rep' ? [...groupIds] : [];
  return queryOptions({
    queryKey: portalQueryKey(yearId, 'notices', kind, ...extra),
    queryFn: () => loadLatestNotices(yearId, scope),
  });
}
