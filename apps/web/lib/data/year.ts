// 年度の行を読む（画面の設計 1.5・2.2。T09a）。どの画面も最初に年度の行を読み、状態で書けるかを決める。
import { useQuery } from '@tanstack/react-query';
import { appError, toAppError } from '@/lib/errors';
import { COLUMNS, type YearRow, type YearStatus } from '@/lib/db/types';
import { queryKeys } from '@/lib/query';
import { getSupabase, type AppSupabaseClient } from '@/lib/supabase/client';

export type { YearRow, YearStatus };

/** 年度の行（id・label・status・allocation_version・auto_allocated_at・festival_start・受付期間・prev_year_id）。読めなければ not_found */
export async function fetchYear(yearId: string, client: AppSupabaseClient = getSupabase()): Promise<YearRow> {
  const res = await client.from('years').select(COLUMNS.years).eq('id', yearId).maybeSingle();
  if (res.error) throw toAppError(res.error, res.status);
  if (!res.data) throw appError('not_found', 'year_missing', { yearId });
  return res.data as unknown as YearRow;
}

/** 版だけを読む（版の見張り・保存されたか分からないときの確かめ。2.6・3.9） */
export async function fetchYearVersion(yearId: string, client: AppSupabaseClient = getSupabase()): Promise<number> {
  const res = await client.from('years').select('allocation_version').eq('id', yearId).maybeSingle();
  if (res.error) throw toAppError(res.error, res.status);
  if (!res.data) throw appError('not_found', 'year_missing', { yearId });
  return res.data.allocation_version;
}

/** 年度の行のクエリ（キーは `['year', yearId, 'row']`） */
export function useYearRow(yearId: string | null | undefined) {
  return useQuery({
    queryKey: queryKeys.yearRow(yearId ?? ''),
    queryFn: () => fetchYear(yearId!),
    enabled: !!yearId,
  });
}

/** 振り分けが決まった（確定・終了）か。viewer の振り分け表・団体代表の /my の確定後の表示・Excel のファイル名（Q3） */
export function isAllocationFinal(status: YearStatus): boolean {
  return status === 'confirmed' || status === 'closed';
}
