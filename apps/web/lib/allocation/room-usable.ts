// 部屋の見出しから今年の使用を変える流れ（「今年は使用不可にする」「使用可に戻す」。画面の設計 3.9・2.3・2.6 の (B1)。T13 の段 2）。
// setRoomUsable（T09a）に、ダイアログを開いたときに読み込んでいた room_years.updated_at（行がなければ null）を渡し、
// ほかの人の変更（マスタ設定・別の画面）を黙って上書きしない。React に依存しない（テストは依存を差し替える）。
// setRoomUsable は送り直しても DB が二重の書き込みを止める（updated_at が進んでいれば conflict、行のなかった部屋の insert は 23505）ので、
// 確かめるためだけの状態（「確かめる」のボタン・押せなくしたボタン・未確定の印）は持たない（2.6 の (B1)）。
// 応答が届かなかったとき（isUnknownOutcome）と conflict・not_found（23505 を含む）のときに、スナップショットを1回読み直し、
// 読み直した room_years の行（usable と note）で settleLockedWrite（lib/data/locked-save.ts）が決める：
// - saved（読み直した行が送った usable・note と同じ）→ 成功と同じ（「保存されていました」）。
// - 応答が届かなかった後の not-saved・unread → unknownOutcomeMessage()。ダイアログとメモを残す。次はふつうに送る（同じ base）。
// - 止められた後の unread → 「読み直せませんでした」。ダイアログとメモを残し、読み直すボタンを出す。次もまた同じ道を通る。
// - それ以外（changed、止められた後の not-saved）→ conflict の扱い（読み直した行を次の base にする）。読み直した部屋がすでに望んだ
//   usable（メモだけ違う）なら、ほかの人がすでにしていたと知らせて閉じる（入れたメモは保存していない）。
// 自分の前の送信（値が今の入力と違う）が後から通った場合はほかの人の変更に見える。これは受け入れる（2.6 の (B1) の 4）。
import type { ClassifiedError } from '@/lib/errors';
import { classifyError, isUnknownOutcome, unknownOutcomeMessage } from '@/lib/errors';
import type { RoomYearRow } from '@/lib/db/types';
import { isLockRejection, settleLockedWrite } from '@/lib/data/locked-save';
import { roomYearMatches } from '@/lib/data/room-years';
import type { Snapshot } from '@/lib/data/snapshot';

export const ROOM_USABLE_CONFLICT = 'ほかの人がこの部屋の使用を変えました。読み直しました';
export const ROOM_USABLE_UNREAD = 'ほかの人がこの部屋の使用を変えたかもしれませんが、読み直せませんでした。「読み直す」を押してください';

/** ほかの人がすでに望んだ usable にしていた（メモだけ違う）ときの知らせ。入れたメモがあれば、保存していないことを添える */
export function roomUsableAlreadyMessage(roomName: string, usable: boolean, note: string | null): string {
  const done = usable ? `ほかの人がすでに${roomName}を使用可に戻していました` : `ほかの人がすでに${roomName}を使用不可にしていました`;
  return normalizeNote(note) === null ? done : `${done}（入れたメモは保存していません）`;
}

/** ダイアログを開いたときの部屋の今年の使用（room_years の行。ない部屋は使用可で updatedAt は null） */
export interface RoomUsableBase {
  roomId: string;
  usable: boolean;
  note: string | null;
  /** 読み込んだときの room_years.updated_at（受け取った文字列のまま）。行がなければ null */
  updatedAt: string | null;
}

type RoomYearLike = Pick<RoomYearRow, 'room_id' | 'usable' | 'note' | 'updated_at'>;

export function roomUsableBase(roomYears: readonly RoomYearLike[], roomId: string): RoomUsableBase {
  const ry = roomYears.find((r) => r.room_id === roomId);
  return { roomId, usable: ry?.usable ?? true, note: ry?.note ?? null, updatedAt: ry?.updated_at ?? null };
}

export type RoomUsableOutcome =
  /** 保存した。recovered は、応答が届かなかった・止められたが、読み直すと送った値になっていた（「保存されていました」。読み直し済み） */
  | { kind: 'saved'; recovered: boolean }
  /** 読み直すと、ほかの人がすでに望んだ usable にしていた（メモだけ違う）。message を知らせて閉じる（読み直し済み） */
  | { kind: 'already'; message: string }
  /** ほかの人が先に変えた。読み直した部屋の状態を next に入れる（ダイアログとメモを残し、next で押し直せる） */
  | { kind: 'conflict'; message: string; next: RoomUsableBase }
  /** 応答が届かず、読み直すと保存されていない・読み直せない。unknownOutcomeMessage()。ダイアログとメモを残し、同じ base で押し直せる */
  | { kind: 'unknown'; message: string }
  /** 止められた後に読み直せなかった。ダイアログとメモを残し、読み直すボタンを出す（「読み直しました」とは言わない） */
  | { kind: 'unread'; message: string }
  /** それ以外の失敗（呼ぶ側が messageFor・effectOf で知らせて読み直す） */
  | { kind: 'error'; error: ClassifiedError };

export interface RoomUsableDeps {
  save: (yearId: string, roomId: string, updatedAt: string | null, usable: boolean, note: string | null) => Promise<unknown>;
  /** スナップショットを読み直す（読み直せなければ undefined を返すか投げる） */
  reload: () => Promise<Pick<Snapshot, 'roomYears'> | undefined>;
}

/** setRoomUsable と同じに note をそろえる（前後の空白を除き、空なら null） */
function normalizeNote(note: string | null): string | null {
  const t = (note ?? '').trim();
  return t === '' ? null : t;
}

/**
 * 部屋の今年の使用を変える。base は開いたときの状態（roomUsableBase。押し直しでは前の conflict の next か、同じ base）。
 * 成功の後の読み直しは呼ぶ側が行う（成功の知らせと一緒に）。応答の届かない失敗と conflict・not_found は、ここで1回読み直して決める。
 * roomName は「ほかの人がすでに…」の知らせに使う。
 */
export async function changeRoomUsable(
  args: { yearId: string; base: RoomUsableBase; usable: boolean; note: string | null; roomName: string },
  deps: RoomUsableDeps,
): Promise<RoomUsableOutcome> {
  const { yearId, base, usable, note } = args;
  try {
    await deps.save(yearId, base.roomId, base.updatedAt, usable, note);
    return { kind: 'saved', recovered: false };
  } catch (e) {
    const unknown = isUnknownOutcome(e);
    if (!unknown && !isLockRejection(e)) return { kind: 'error', error: classifyError(e) };
    const read: { row: RoomYearLike | null } = { row: null };
    const outcome = await settleLockedWrite<RoomYearLike>({
      reread: async () => {
        const s = await deps.reload();
        if (!s) throw new Error('reload_failed');
        read.row = s.roomYears.find((r) => r.room_id === base.roomId) ?? null;
        return read.row;
      },
      matches: (row) => roomYearMatches(row, usable, note),
      baseVersion: base.updatedAt,
      versionOf: (row) => row.updated_at,
    });
    if (outcome === 'saved') return { kind: 'saved', recovered: true };
    if (unknown && (outcome === 'not-saved' || outcome === 'unread')) return { kind: 'unknown', message: unknownOutcomeMessage() };
    if (outcome === 'unread') return { kind: 'unread', message: ROOM_USABLE_UNREAD };
    // changed（と、止められた後の not-saved）：今までの conflict の扱い。読み直した行を入力の元にする
    const next = roomUsableBase(read.row ? [read.row] : [], base.roomId);
    if (next.usable === usable) return { kind: 'already', message: roomUsableAlreadyMessage(args.roomName, usable, note) };
    return { kind: 'conflict', message: ROOM_USABLE_CONFLICT, next };
  }
}
