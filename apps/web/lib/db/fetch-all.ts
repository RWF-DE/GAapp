// 全部の行を読む（画面の設計 1.5。T09a）。Supabase の max_rows（1000）を超えうる表（stocks・requests・allocations・
// audit_logs など）は、1回の select では途中で切れる（エラーにならない）ので、`.range()` で分けて読む。
import { toAppError } from '@/lib/errors';

export interface PageResult<T> {
  data: T[] | null;
  error: unknown;
  status?: number;
}

/**
 * `page(from, to)` は、主キーの順（`.order()` を必ず付ける）の問い合わせに `.range(from, to)` を付けて返す関数。
 * 呼ぶたびに新しい問い合わせを作る（supabase-js の問い合わせは使い回さない）。
 * 1ページが pageSize 件より少なければ終わる。失敗したら AppError を投げる。
 *
 * @example
 * const stocks = await fetchAll((from, to) =>
 *   supabase.from('stocks').select(COLUMNS.stocks).eq('year_id', yearId).order('room_id').order('item_id').range(from, to));
 */
export async function fetchAll<T>(page: (from: number, to: number) => PromiseLike<PageResult<T>>, pageSize = 1000): Promise<T[]> {
  if (!Number.isInteger(pageSize) || pageSize < 1) throw new Error('pageSize は 1 以上の整数');
  const out: T[] = [];
  for (let from = 0; ; from += pageSize) {
    const res = await page(from, from + pageSize - 1);
    if (res.error) throw toAppError(res.error, res.status);
    const rows = res.data ?? [];
    out.push(...rows);
    if (rows.length < pageSize) return out;
  }
}
