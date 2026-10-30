// 楽観ロックつきの直接の更新（画面の設計 2.3、D-33。T09a）
import type { TablesUpdate } from '@gaapp/shared';
import { appError, toAppError } from '@/lib/errors';
import type { AppSupabaseClient } from '@/lib/supabase/client';
import type { LooseClient } from './loose';
import type { Row, TableName } from './types';

/** 主キーの列と値（例：`{ id }`、`{ year_id, room_id }`） */
export type KeyMatch = Record<string, string>;

/**
 * 0 行だった更新・削除の理由を、行の updated_at を読み直して分ける（2.3）。
 * - 行がない → not_found（lock_missing。ほかの人が消した。一覧を読み直す）
 * - updated_at が違う → conflict（lock_conflict。ほかの人が先に変えた。読み直して入力を残す）
 * - 同じ → forbidden（lock_unchanged。RLS で拒否された＝権限か年度の状態・締切が変わった。年度の行と立場を読み直す）
 * updatedAt を持っていない削除で行が残っていれば forbidden。
 */
export async function explainZeroRows(
  client: AppSupabaseClient,
  table: TableName,
  match: KeyMatch,
  updatedAt: string | undefined,
): Promise<never> {
  const c = client as unknown as LooseClient;
  const res = await c.from(table).select('updated_at').match(match).maybeSingle();
  if (res.error) throw toAppError(res.error, res.status);
  const row = res.data as { updated_at?: unknown } | null;
  const details = { table, match };
  if (!row) throw appError('not_found', 'lock_missing', details);
  if (updatedAt !== undefined && row.updated_at !== updatedAt) throw appError('conflict', 'lock_conflict', details);
  throw appError('forbidden', 'lock_unchanged', details);
}

/**
 * 既存の行を、受け取ったときの updated_at が同じときだけ更新する（2.3）。
 * `update(patch).match(主キー).eq('updated_at', 受け取った文字列).select().maybeSingle()`。
 * updated_at は受け取った文字列をそのまま渡す（Date に通すとマイクロ秒が落ちて一致しない）。
 * 更新した行を返す。0 行なら explainZeroRows の AppError（not_found・conflict・forbidden）を投げる。
 *
 * @example
 * const row = await updateWithLock(supabase, 'groups', { id: g.id }, g.updated_at, { display_name: optional });
 */
export async function updateWithLock<T extends TableName>(
  client: AppSupabaseClient,
  table: T,
  match: KeyMatch,
  updatedAt: string,
  patch: TablesUpdate<T>,
): Promise<Row<T>> {
  const c = client as unknown as LooseClient;
  const res = await c.from(table).update(patch).match(match).eq('updated_at', updatedAt).select().maybeSingle();
  if (res.error) throw toAppError(res.error, res.status);
  if (res.data) return res.data as Row<T>;
  return explainZeroRows(client, table, match, updatedAt);
}
