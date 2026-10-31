// 団体代表の机椅子（自団体の提出と了承。T09 のホームのカードから T16 で移した。D-52）。ダッシュボード（/）の代表する団体の欄
// （components/dashboard/rep-home.tsx）と、机椅子の団体代表の要対応（portal.ts）が同じクエリ（furnitureRepOptions）を読む
// （リクエストは1回）。/ の JS に lib/data（swaps.ts の ruleSchema・スナップショット・検証）を入れないため、lib/data を import
// しない（lib/data/dashboard.ts が今の名前で出し直す）。
import { queryOptions } from '@tanstack/react-query';
import type { YearStatus } from '@/lib/auth/membership';
import { fetchAll } from '@/lib/db/fetch-all';
import { COLUMNS, type ConsentDbRow, type SubmissionRow, type YearRow } from '@/lib/db/types';
import { toAppError } from '@/lib/errors';
import { getSupabase, type AppSupabaseClient } from '@/lib/supabase/client';
import { portalQueryKey } from '../portal';

export interface RepGroupCard {
  groupId: string;
  name: string;
  /** 提出した日時（なければ未提出） */
  submittedAt: string | null;
  /** キャスター机への交換の依頼（status = asked）があるか */
  consentAsked: boolean;
  /** 振り分けが決まった（確定・終了） */
  final: boolean;
}

export interface RepHomeSource {
  groups: readonly { id: string; name: string }[];
  submissions: readonly Pick<SubmissionRow, 'group_id' | 'submitted_at'>[];
  consents: readonly Pick<ConsentDbRow, 'group_id' | 'status'>[];
}

/** 団体代表の読み取りの結果（loadRepHome。自団体の提出と了承の行） */
export type RepHomeRows = Pick<RepHomeSource, 'submissions' | 'consents'>;

/** 団体代表のカード（代表する団体ごと。並びは立場の一覧と同じ名前の順） */
export function repGroupCards(src: RepHomeSource, status: YearStatus): RepGroupCard[] {
  const submittedAt = new Map(src.submissions.map((s) => [s.group_id, s.submitted_at]));
  const asked = new Set(src.consents.filter((c) => c.status === 'asked').map((c) => c.group_id));
  return src.groups.map((g) => ({
    groupId: g.id,
    name: g.name,
    submittedAt: submittedAt.get(g.id) ?? null,
    consentAsked: asked.has(g.id),
    final: status === 'confirmed' || status === 'closed',
  }));
}

/** 団体代表が申請を書けるか（02 の「締切前」と同じ：requesting・受付開始が null か過ぎた・締切の前） */
export function requestWindowOpen(year: Pick<YearRow, 'status' | 'request_open_at' | 'request_close_at'>, now: number): boolean {
  if (year.status !== 'requesting' || !year.request_close_at) return false;
  if (year.request_open_at && new Date(year.request_open_at).getTime() > now) return false;
  return new Date(year.request_close_at).getTime() > now;
}

/**
 * 団体代表のホームに要る行（自団体の提出と了承。RLS で自団体の行だけが返る）。
 * 年度の行（締切）は useYearRow で読む。
 */
export async function loadRepHome(groupIds: readonly string[], client: AppSupabaseClient = getSupabase()): Promise<RepHomeRows> {
  if (groupIds.length === 0) return { submissions: [], consents: [] };
  const [sub, con] = await Promise.all([
    client.from('request_submissions').select(COLUMNS.request_submissions).in('group_id', [...groupIds]).order('group_id'),
    fetchAll((from, to) =>
      client
        .from('substitution_consents')
        .select(COLUMNS.substitution_consents)
        .in('group_id', [...groupIds])
        .order('group_id')
        .order('from_item_id')
        .order('to_item_id')
        .range(from, to),
    ),
  ]);
  if (sub.error) throw toAppError(sub.error, sub.status);
  return {
    submissions: (sub.data ?? []) as unknown as SubmissionRow[],
    consents: con as unknown as ConsentDbRow[],
  };
}

/**
 * 団体代表の机椅子のクエリ（キーは `['year', yearId, 'portal', 'furniture', 'rep', ...groupIds]`。団体の id は立場の一覧の順）。
 * 代表する団体の欄（rep-home.tsx）はこのまま、要対応は select を足して（portal.ts の furniturePortalProvider）同じキャッシュを読む。
 * 代表する団体が変われば別のキャッシュになる。
 */
export function furnitureRepOptions(yearId: string, groupIds: readonly string[]) {
  const ids = [...groupIds];
  return queryOptions({
    queryKey: portalQueryKey(yearId, 'furniture', 'rep', ...ids),
    queryFn: () => loadRepHome(ids),
  });
}
