// 今年の場所の使用（room_years）の書き込みと、使用不可にする前に直す行（画面の設計 1.5・3.9。T09a）。
// マスタ設定（T09）と振り分け画面の部屋の見出し（T13）で使う。
import type { AllocOrigin } from '@gaapp/shared';
import { appError, toAppError } from '@/lib/errors';
import { COLUMNS, type RoomYearRow } from '@/lib/db/types';
import { updateWithLock } from '@/lib/db/update-with-lock';
import { NOTE_MAX, optionalText, uuidSchema } from '@/lib/schemas/common';
import { getSupabase, type AppSupabaseClient } from '@/lib/supabase/client';

const noteSchema = optionalText(NOTE_MAX);

/**
 * 今年の使用を変える（room_years。主キーは (year_id, room_id)）。ほかの人の変更を黙って上書きしない（2.3）。
 * - updatedAt は読み込んだときの room_years.updated_at（受け取った文字列のまま）。行がなかったときは null。
 * - 行があれば updateWithLock（updated_at が同じときだけ更新）。0 行なら読み直して分ける：
 *   updated_at が違う → conflict（lock_conflict）、行がない → not_found（lock_missing）、同じ → forbidden（lock_unchanged。RLS）。
 * - 行がなければ insert。ほかの人が先に足していれば（23505）conflict（lock_conflict）。
 * 失敗は AppError で投げる（info.kind が conflict・not_found なら room_years と年度を読み直して「ほかの人が変えました」と出し、
 * 入力は残す。forbidden は年度の行と立場を読み直す。network は「保存できたか分からない」）。classifyError・effectOf でそのまま分けられる。
 * note は理由のメモ（空なら null）。
 * 使用不可にする前に、その部屋からの固定・手動の行を直して保存しておく（fixedRowsFrom。3.9 の順番）。
 * 書き込みで版が上がるので、成功した後はスナップショットを読み直す。
 *
 * @example
 * // roomYear は読み込んだ room_years の行（ない部屋は null）
 * await setRoomUsable(yearId, roomId, roomYear?.updated_at ?? null, false, '工事のため');
 * await queryClient.invalidateQueries({ queryKey: queryKeys.year(yearId) });
 */
export async function setRoomUsable(
  yearId: string,
  roomId: string,
  updatedAt: string | null,
  usable: boolean,
  note: string | null,
  client: AppSupabaseClient = getSupabase(),
): Promise<RoomYearRow> {
  if (!uuidSchema.safeParse(yearId).success || !uuidSchema.safeParse(roomId).success) {
    throw appError('input', 'client_validation', { field: 'room_id' });
  }
  if (updatedAt !== null && (typeof updatedAt !== 'string' || updatedAt === '')) {
    throw appError('input', 'client_validation', { field: 'updated_at' });
  }
  const n = noteSchema.safeParse(note);
  if (!n.success) throw appError('input', 'client_validation', { field: 'note' });
  const match = { year_id: yearId, room_id: roomId };
  if (updatedAt !== null) {
    const row = await updateWithLock(client, 'room_years', match, updatedAt, { usable, note: n.data });
    return row as unknown as RoomYearRow;
  }
  const res = await client
    .from('room_years')
    .insert({ ...match, usable, note: n.data })
    .select(COLUMNS.room_years)
    .maybeSingle();
  if (res.error) {
    const err = toAppError(res.error, res.status);
    if (err.info.code === '23505') throw appError('conflict', 'lock_conflict', { table: 'room_years', match });
    throw err;
  }
  if (!res.data) throw appError('forbidden', 'lock_unchanged', { table: 'room_years', match });
  return res.data as unknown as RoomYearRow;
}

/** 行の操作（使用不可にする前の一覧・使用不可の部屋の行で出すもの） */
export type FixedRowOp = 'unpin' | 'change_source' | 'delete';

interface RowLike {
  sourceRoomId: string;
  origin: AllocOrigin;
  pinned: boolean;
}

/**
 * その部屋からの固定・手動の行（pinned か origin = manual。全品目）。使用不可にする前に直すもの（3.9）。
 * save_allocation_rows は使用不可の部屋の行の update を、固定だけの変更でも E002 で拒否し、手動の行は固定を外しても
 * fixedRows に残る（再実行で動かない）ので、部屋を使用不可にする前に、この一覧が空になるまで直して保存する。
 */
export function fixedRowsFrom<T extends RowLike>(rows: readonly T[], roomId: string): T[] {
  return rows.filter((r) => r.sourceRoomId === roomId && (r.pinned || r.origin === 'manual'));
}

/**
 * 使用不可にする前の一覧で、行ごとに出す操作。固定の自動の行は「固定を外す」（次の最小変更で動かせる）・「運び元を変える」・
 * 「削除」。手動の行は固定を外しても動かないので「運び元を変える」・「削除」だけ。
 */
export function opsBeforeUnusable(row: RowLike): FixedRowOp[] {
  return row.origin === 'auto' && row.pinned ? ['unpin', 'change_source', 'delete'] : ['change_source', 'delete'];
}
