// TanStack Query の既定値とクエリのキー（画面の設計 1.7、D-33。T09a）
import { QueryClient } from '@tanstack/react-query';
import { classifyError } from '@/lib/errors';

/** サーバーのデータの既定の鮮度（30 秒） */
export const STALE_TIME_MS = 30_000;

/** 再試行は通信の失敗だけ1回（P0001・42501 などは何度送っても同じなので再試行しない） */
export function shouldRetry(failureCount: number, error: unknown): boolean {
  return failureCount < 1 && classifyError(error).kind === 'network';
}

/**
 * アプリの QueryClient（app/layout.tsx で1つ作る。段 C）。
 * ウィンドウに戻っても自動では読み直さない（編集中の画面を勝手に書き換えない）。書き込みは自動で再送しない。
 */
export function createQueryClient(): QueryClient {
  return new QueryClient({
    defaultOptions: {
      queries: { staleTime: STALE_TIME_MS, refetchOnWindowFocus: false, retry: shouldRetry },
      mutations: { retry: false },
    },
  });
}

/**
 * クエリのキー。年度の表は `['year', yearId, …]` の下に置く（年度を切り替えると別のキャッシュになり、
 * 年度の状態の遷移の後は `queryKeys.year(yearId)` で下を全部 invalidate できる）。年度をまたぐ表は年度を入れない。
 */
export const queryKeys = {
  /** その年度の下の全部（invalidate 用） */
  year: (yearId: string) => ['year', yearId] as const,
  /** 年度の行（状態・版・受付期間） */
  yearRow: (yearId: string) => ['year', yearId, 'row'] as const,
  /** 版の見張り（allocation_version だけ） */
  yearVersion: (yearId: string) => ['year', yearId, 'version'] as const,
  /** 振り分けのスナップショット（staleTime: Infinity。読み直しは明示的に） */
  snapshot: (yearId: string, part: 'full' | 'public') => ['year', yearId, 'snapshot', part] as const,
  /** 画面ごとの年度の表（例：`queryKeys.yearPart(yearId, 'stocks', roomId)`） */
  yearPart: (yearId: string, ...parts: readonly (string | number)[]) => ['year', yearId, ...parts] as const,
  rooms: () => ['rooms'] as const,
  items: () => ['items'] as const,
  distance: () => ['distance'] as const,
};
