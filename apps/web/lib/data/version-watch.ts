// 版の見張り（画面の設計 2.6、D-33。T09a）。ダッシュボード・振り分け・キャスター机交換で、年度の allocation_version だけを
// 60 秒ごとと、ウィンドウにフォーカスが戻ったときに読み、持っている版より新しければ StaleBanner を出す。自動では読み直さない。
import { useQuery } from '@tanstack/react-query';
import { queryKeys } from '@/lib/query';
import { fetchYearVersion } from './year';

export const VERSION_WATCH_INTERVAL_MS = 60_000;

/** 読んだ版が持っている版より新しいか */
export function isStale(latest: number | undefined, held: number | null | undefined): boolean {
  return latest !== undefined && held !== null && held !== undefined && latest > held;
}

/**
 * @param version 持っている版（スナップショットの version）。null なら見張らない
 * @param paused 計算中・保存中は止める
 *
 * @example
 * const { stale } = useVersionWatch(yearId, snapshot?.version ?? null, { paused: saving });
 * {stale && <StaleBanner onReload={() => snapshotQuery.refetch()} />}
 */
export function useVersionWatch(yearId: string | null | undefined, version: number | null, opts: { paused?: boolean } = {}) {
  const enabled = !!yearId && version !== null && !opts.paused;
  const q = useQuery({
    queryKey: queryKeys.yearVersion(yearId ?? ''),
    queryFn: () => fetchYearVersion(yearId!),
    enabled,
    refetchInterval: enabled ? VERSION_WATCH_INTERVAL_MS : false,
    refetchIntervalInBackground: false,
    refetchOnWindowFocus: enabled ? 'always' : false,
    staleTime: 0,
  });
  return { stale: isStale(q.data, version), latestVersion: q.data ?? null };
}
