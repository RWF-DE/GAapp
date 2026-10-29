// 部屋の見出しから今年の使用を変える流れ（「今年は使用不可にする」「使用可に戻す」。画面の設計 3.9・2.3。T13 の段 2）。
// setRoomUsable（T09a）に、ダイアログを開いたときに読み込んでいた room_years.updated_at（行がなければ null）を渡し、
// ほかの人の変更（マスタ設定・別の画面）を黙って上書きしない。conflict・not_found のときはスナップショットを読み直して
// 「ほかの人がこの部屋の使用を変えました」と知らせる。読み直した後も同じ操作に意味があれば、ダイアログ（理由のメモ）は残し、
// 読み直した updated_at で次の操作をできるようにする。React に依存しない（テストは依存を差し替える）。
import type { ClassifiedError } from '@/lib/errors';
import { classifyError } from '@/lib/errors';
import type { RoomYearRow } from '@/lib/db/types';
import type { Snapshot } from '@/lib/data/snapshot';

export const ROOM_USABLE_CONFLICT = 'ほかの人がこの部屋の使用を変えました。読み直しました';

/** ダイアログを開いたときの部屋の今年の使用（room_years の行。ない部屋は使用可で updatedAt は null） */
export interface RoomUsableBase {
  roomId: string;
  usable: boolean;
  /** 読み込んだときの room_years.updated_at（受け取った文字列のまま）。行がなければ null */
  updatedAt: string | null;
}

export function roomUsableBase(roomYears: readonly Pick<RoomYearRow, 'room_id' | 'usable' | 'updated_at'>[], roomId: string): RoomUsableBase {
  const ry = roomYears.find((r) => r.room_id === roomId);
  return { roomId, usable: ry?.usable ?? true, updatedAt: ry?.updated_at ?? null };
}

export type RoomUsableOutcome =
  | { kind: 'saved' }
  /**
   * ほかの人が先に変えた（conflict・not_found）。読み直したスナップショットでの部屋の状態を next に入れる（読み直せなければ null）。
   * done は、読み直した部屋がすでに望んだ状態（ほかの人が同じ操作をした）でダイアログを閉じてよいこと。
   */
  | { kind: 'conflict'; message: string; next: RoomUsableBase | null; done: boolean }
  /** それ以外の失敗（呼ぶ側が messageFor・effectOf で知らせて読み直す） */
  | { kind: 'error'; error: ClassifiedError };

export interface RoomUsableDeps {
  save: (yearId: string, roomId: string, updatedAt: string | null, usable: boolean, note: string | null) => Promise<unknown>;
  /** スナップショットを読み直す（読み直せなければ undefined を返すか投げる） */
  reload: () => Promise<Pick<Snapshot, 'roomYears'> | undefined>;
}

/**
 * 部屋の今年の使用を変える。base は開いたときの状態（roomUsableBase）。
 * 成功の後の読み直しは呼ぶ側が行う（成功・失敗の知らせと一緒に）。conflict・not_found だけは、ここで読み直して next を返す。
 */
export async function changeRoomUsable(
  args: { yearId: string; base: RoomUsableBase; usable: boolean; note: string | null },
  deps: RoomUsableDeps,
): Promise<RoomUsableOutcome> {
  const { yearId, base, usable, note } = args;
  try {
    await deps.save(yearId, base.roomId, base.updatedAt, usable, note);
    return { kind: 'saved' };
  } catch (e) {
    const c = classifyError(e);
    if (c.kind !== 'conflict' && c.kind !== 'not_found') return { kind: 'error', error: c };
    let next: RoomUsableBase | null;
    try {
      const s = await deps.reload();
      next = s ? roomUsableBase(s.roomYears, base.roomId) : null;
    } catch {
      next = null;
    }
    return { kind: 'conflict', message: ROOM_USABLE_CONFLICT, next, done: next !== null && next.usable === usable };
  }
}
