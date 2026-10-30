// 消えたことを確かめる削除（画面の設計 2.3、D-33。T09a）
import { toAppError } from '@/lib/errors';
import type { AppSupabaseClient } from '@/lib/supabase/client';
import type { LooseClient } from './loose';
import type { Row, TableName } from './types';
import { explainZeroRows, type KeyMatch } from './update-with-lock';

/**
 * 主キーで1行を消し、消えた行を返す（`delete().match(主キー).select()`。updatedAt を渡せば `.eq('updated_at', …)` も）。
 * RLS の USING で拒否された delete はエラーにならず 0 行で成功するので、0 行なら読み直して
 * not_found（すでに消えていた）・conflict（updated_at が違う）・forbidden（権限か年度の状態）に分けて AppError を投げる。
 * 「削除しました」は、この関数が行を返したときだけ出す。
 *
 * @example
 * await deleteChecked(supabase, 'rules', { id: rule.id }, rule.updated_at);
 */
export async function deleteChecked<T extends TableName>(
  client: AppSupabaseClient,
  table: T,
  match: KeyMatch,
  updatedAt?: string,
): Promise<Row<T>> {
  const c = client as unknown as LooseClient;
  let q = c.from(table).delete().match(match);
  if (updatedAt !== undefined) q = q.eq('updated_at', updatedAt);
  const res = await q.select();
  if (res.error) throw toAppError(res.error, res.status);
  const rows = res.data ?? [];
  if (rows.length > 0) return rows[0] as Row<T>;
  return explainZeroRows(client, table, match, updatedAt);
}
