// 部屋の見出しから今年の使用を変える流れ（「今年は使用不可にする」「使用可に戻す」。画面の設計 3.9・2.3・2.6。T13 の段 2）。
// setRoomUsable（T09a）に、ダイアログを開いたときに読み込んでいた room_years.updated_at（行がなければ null）を渡し、
// ほかの人の変更（マスタ設定・別の画面）を黙って上書きしない。React に依存しない（テストは依存を差し替える）。
// - conflict・not_found：スナップショットを読み直して「ほかの人がこの部屋の使用を変えました。読み直しました」と知らせる。
//   読み直した後も同じ操作に意味があれば、ダイアログ（理由のメモ）は残し、読み直した updated_at で押し直せるようにする。
// - 応答が届かなかった（network・unknown。row-save の isUnknownOutcome と同じ範囲）：送り直す前に読み直し、部屋の usable と
//   note が送ったものと同じなら「保存されていました」（成功と同じに扱う）。違えば読み直した updated_at に当て直す。
// - 読み直しに失敗したら unchecked：「読み直しました」とは言わず、ダイアログとメモを残して、「確かめる」（checkRoomUsable）で
//   読み直せるまで送り直させない。
// - 応答の届かない送信をした base には maybeSaved を付ける。その後の conflict（先の送信が後から通った・insert の 23505）で
//   読み直した行が自分の値なら、ほかの人の変更とは言わずに「保存されていました」にする。
import type { ClassifiedError } from '@/lib/errors';
import { classifyError } from '@/lib/errors';
import type { RoomYearRow } from '@/lib/db/types';
import type { Snapshot } from '@/lib/data/snapshot';
import { isUnknownOutcome } from './row-save';

export const ROOM_USABLE_CONFLICT = 'ほかの人がこの部屋の使用を変えました。読み直しました';
export const ROOM_USABLE_CONFLICT_UNREAD = 'ほかの人がこの部屋の使用を変えました。読み直せませんでした。通信が戻ったら『確かめる』を押してください';
export const ROOM_USABLE_UNVERIFIED = '保存できたか確かめられません。通信が戻ったら『確かめる』を押してください';
export const ROOM_USABLE_NOT_SAVED = '保存されていませんでした（応答が届かなかったので、読み直して確かめました）。もう一度押してください';

/** ダイアログを開いたときの部屋の今年の使用（room_years の行。ない部屋は使用可で updatedAt は null） */
export interface RoomUsableBase {
  roomId: string;
  usable: boolean;
  note: string | null;
  /** 読み込んだときの room_years.updated_at（受け取った文字列のまま）。行がなければ null */
  updatedAt: string | null;
  /** この base で応答の届かない送信をした（後から通っているかもしれない） */
  maybeSaved: boolean;
}

export function roomUsableBase(
  roomYears: readonly Pick<RoomYearRow, 'room_id' | 'usable' | 'note' | 'updated_at'>[],
  roomId: string,
): RoomUsableBase {
  const ry = roomYears.find((r) => r.room_id === roomId);
  return { roomId, usable: ry?.usable ?? true, note: ry?.note ?? null, updatedAt: ry?.updated_at ?? null, maybeSaved: false };
}

export type RoomUsableOutcome =
  /** 保存した。recovered は、応答が届かなかったが読み直すと保存されていた（「保存されていました」） */
  | { kind: 'saved'; recovered: boolean }
  /**
   * ほかの人が先に変えた（conflict・not_found、または応答の届かない送信の後に読み直すとほかの人の値）。読み直した部屋の状態を next に入れる。
   * done は、読み直した部屋がすでに望んだ状態（ほかの人が同じ操作をした）でダイアログを閉じてよいこと。
   */
  | { kind: 'conflict'; message: string; next: RoomUsableBase; done: boolean }
  /** 応答が届かなかったが、読み直すと保存されていなかった（updated_at が開いたときのまま）。next で押し直してよい */
  | { kind: 'not-saved'; message: string; next: RoomUsableBase }
  /**
   * 読み直せなかった（after：応答が届かなかった後か、conflict の後か）。ダイアログとメモを残し、「確かめる」（checkRoomUsable）で
   * 読み直せるまで送り直させない。base は次に使う base（応答が届かなかった後は maybeSaved を付ける）。
   */
  | { kind: 'unchecked'; after: 'unknown' | 'conflict'; message: string; base: RoomUsableBase }
  /** それ以外の失敗（呼ぶ側が messageFor・effectOf で知らせて読み直す） */
  | { kind: 'error'; error: ClassifiedError };

export interface RoomUsableDeps {
  save: (yearId: string, roomId: string, updatedAt: string | null, usable: boolean, note: string | null) => Promise<unknown>;
  /** スナップショットを読み直す（読み直せなければ undefined を返すか投げる） */
  reload: () => Promise<Pick<Snapshot, 'roomYears'> | undefined>;
}

/** setRoomUsable と同じに note をそろえる（前後の空白を除き、空なら null） */
const normalizeNote = (note: string | null): string | null => {
  const t = (note ?? '').trim();
  return t === '' ? null : t;
};

/**
 * 読み直して確かめる（応答が届かなかった後・conflict の後。「確かめる」もこれを呼ぶ）。
 * - 読み直せない → unchecked
 * - 読み直した部屋が送った usable・note と同じで、送信が通ったかもしれない（after が unknown か base.maybeSaved）→ saved（recovered）
 * - 応答が届かなかった後で updated_at が開いたときのまま → not-saved
 * - それ以外 → conflict（読み直した updated_at に当て直す）
 */
export async function checkRoomUsable(
  args: { base: RoomUsableBase; usable: boolean; note: string | null; after: 'unknown' | 'conflict' },
  deps: Pick<RoomUsableDeps, 'reload'>,
): Promise<RoomUsableOutcome> {
  const { base, usable, after } = args;
  const maybeSaved = after === 'unknown' || base.maybeSaved;
  let read: RoomUsableBase | null;
  try {
    const s = await deps.reload();
    read = s ? roomUsableBase(s.roomYears, base.roomId) : null;
  } catch {
    read = null;
  }
  if (!read) {
    return after === 'unknown'
      ? { kind: 'unchecked', after, message: ROOM_USABLE_UNVERIFIED, base: { ...base, maybeSaved: true } }
      : { kind: 'unchecked', after, message: ROOM_USABLE_CONFLICT_UNREAD, base };
  }
  const next: RoomUsableBase = { ...read, maybeSaved };
  if (maybeSaved && read.usable === usable && read.note === normalizeNote(args.note)) return { kind: 'saved', recovered: true };
  if (after === 'unknown' && read.updatedAt === base.updatedAt) return { kind: 'not-saved', message: ROOM_USABLE_NOT_SAVED, next };
  return { kind: 'conflict', message: ROOM_USABLE_CONFLICT, next, done: read.usable === usable };
}

/**
 * 部屋の今年の使用を変える。base は開いたときの状態（roomUsableBase。押し直しでは前の結果の next・base）。
 * 成功の後の読み直しは呼ぶ側が行う（成功・失敗の知らせと一緒に）。conflict・not_found と応答の届かない失敗は、ここで読み直して確かめる。
 */
export async function changeRoomUsable(
  args: { yearId: string; base: RoomUsableBase; usable: boolean; note: string | null },
  deps: RoomUsableDeps,
): Promise<RoomUsableOutcome> {
  const { yearId, base, usable, note } = args;
  try {
    await deps.save(yearId, base.roomId, base.updatedAt, usable, note);
    return { kind: 'saved', recovered: false };
  } catch (e) {
    const c = classifyError(e);
    if (isUnknownOutcome(e)) return checkRoomUsable({ base, usable, note, after: 'unknown' }, deps);
    if (c.kind === 'conflict' || c.kind === 'not_found') return checkRoomUsable({ base, usable, note, after: 'conflict' }, deps);
    return { kind: 'error', error: c };
  }
}
