// シフト表（/shifts）と印刷（/shifts/print）の読み取り（04「シフト表」の読むもの、notes/T20.md「画面の約束」2。T20・D-56）。
// 読み取りとキーだけの小さなモジュール：シフト表の画面（部門員も開く）が書き込みの部品（lib/data/shifts.ts）を読まずに済むように分けた。
// 先読み（lib/data/screen-queries.ts）からは読まない（シフト表は先読み・記録・先送りの対象でない。ルートのレイアウトの JS に入れない）。
// lib/data/shifts.ts が同じ名前で出し直す。
import { queryOptions } from '@tanstack/react-query';
import { fetchAll, type PageResult } from '@/lib/db/fetch-all';
import { queryKeys } from '@/lib/query';
import { getSupabase, type AppSupabaseClient } from '@/lib/supabase/client';
import type { BoardDuty, BoardSlot, ShiftBoard } from './board';

/** 時間枠の select（ますと割り当てを埋め込む） */
export const SHIFT_SLOTS_SELECT = 'id, starts_at, ends_at, updated_at, shift_needs(duty_id, required_count, updated_at, shift_assignments(user_id, updated_at))';
/** 持ち場の select */
export const SHIFT_DUTIES_SELECT = 'id, name, place, note, sort_order, updated_at';

/** シフト表を読む（時間枠〔開始・id の順〕と持ち場を並行に fetchAll）。読めなければ AppError を投げる */
export async function loadShiftBoard(yearId: string, client: AppSupabaseClient = getSupabase()): Promise<ShiftBoard> {
  const [slots, duties] = await Promise.all([
    fetchAll<BoardSlot>(
      (from, to) =>
        client
          .from('shift_slots')
          .select(SHIFT_SLOTS_SELECT)
          .eq('year_id', yearId)
          .order('starts_at')
          .order('id')
          .range(from, to) as unknown as PromiseLike<PageResult<BoardSlot>>,
    ),
    fetchAll<BoardDuty>(
      (from, to) =>
        client.from('shift_duties').select(SHIFT_DUTIES_SELECT).eq('year_id', yearId).order('id').range(from, to) as unknown as PromiseLike<
          PageResult<BoardDuty>
        >,
    ),
  ]);
  return { slots, duties };
}

/** シフト表のクエリ（キーは `['year', yearId, 'shifts', 'board']`。/shifts と印刷が使う） */
export function shiftBoardOptions(yearId: string | null | undefined) {
  return queryOptions({
    queryKey: queryKeys.yearPart(yearId ?? '', 'shifts', 'board'),
    queryFn: () => loadShiftBoard(yearId!),
    enabled: !!yearId,
  });
}

/** シフト表を画面に戻ったときと 60 秒ごとに読み直す間隔（04「シフト表」。Realtime は使わない） */
export const SHIFT_BOARD_REFETCH_MS = 60_000;
