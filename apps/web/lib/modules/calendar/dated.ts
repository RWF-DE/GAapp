// ダッシュボード（/）の締切と予定の欄が読む予定と締切（04「締切と予定」の「ダッシュボードに出すもの」、notes/T18.md「後半（画面）の
// 約束」3。T18・D-52・D-54）。読み取りとキーだけの軽いモジュール：/ の先読み（lib/data/screen-queries.ts の planHomePrefetch。ルートの
// レイアウトが読む）からも使えるように、並べ方・組み立て（lib/modules/calendar/portal.ts）とダッシュボードの型と関数
// （lib/modules/portal.ts）を実行時に import しない（お知らせの notices/latest.ts と同じ形。型だけの import はよい）。
// 読むのは id・種類・題名・開始・終わり・終日だけ（対象・メモ・書いた人は読まない。4G の / を軽くする）。読める範囲は RLS が決める
// （総務はその年度の全部、閲覧のみ・店長・副店長は対象が団体・全員のもの）。
// 日付で絞らずに年度の全部を読み、どれを出すかはブラウザで決める（/ の記録・先送り〔<head> の script が覚えた URL を次に開いたときに
// 送る〕の URL が日ごとに変わらないように。年度の項目は数十件の見込み。後半の判断したことの 11）。
import type { Tables } from '@gaapp/shared';
import { queryOptions } from '@tanstack/react-query';
import { fetchAll, type PageResult } from '@/lib/db/fetch-all';
import { getSupabase, type AppSupabaseClient } from '@/lib/supabase/client';
import type { PortalKind } from '../portal';
import { portalQueryKey } from '../query-key';

/** 欄の select（対象・メモ・書いた人は読まない） */
export const CALENDAR_DATED_SELECT = 'id, kind, title, starts_at, ends_at, all_day';

/** 欄の1行 */
export type CalendarDatedRow = Pick<Tables<'events'>, 'id' | 'kind' | 'title' | 'starts_at' | 'ends_at' | 'all_day'>;

/** その年度の項目を全部読む（fetchAll。year_id で絞り、starts_at・id の順）。読めなければ AppError を投げる */
export async function loadCalendarDated(yearId: string, client: AppSupabaseClient = getSupabase()): Promise<CalendarDatedRow[]> {
  return fetchAll<CalendarDatedRow>(
    (from, to) =>
      client
        .from('events')
        .select(CALENDAR_DATED_SELECT)
        .eq('year_id', yearId)
        .order('starts_at')
        .order('id')
        .range(from, to) as unknown as PromiseLike<PageResult<CalendarDatedRow>>,
  );
}

/**
 * 欄のクエリ（lib/modules/calendar/portal.ts の calendarPortalProvider が select を足す。/ の先読みに足すときも同じキャッシュ）。
 * キー：`portalQueryKey(yearId, 'calendar', kind)`（soumu・viewer・rep）。rep に団体の id を入れない（読める範囲は代表である年度で
 * 決まり、どの団体かによらない）。
 *
 * @example
 * calendarDatedOptions(yearId, 'rep')
 */
export function calendarDatedOptions(yearId: string, kind: PortalKind) {
  return queryOptions({
    queryKey: portalQueryKey(yearId, 'calendar', kind),
    queryFn: () => loadCalendarDated(yearId),
  });
}
