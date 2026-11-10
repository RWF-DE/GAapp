// 現状復帰の写真の画面のパス（T25・D-63）。在庫入力と振り分けの部屋の見出しのリンクが使う（リンクだけ。写真の部品・読み取りは
// それらの画面の JS に入れないので、このファイルは何も import しない）。

/** /room-photos のパス（room を付けるとその部屋） */
export function roomPhotosPath(roomId?: string | null): string {
  return roomId ? `/room-photos?room=${encodeURIComponent(roomId)}` : '/room-photos';
}

/** リンクの文字 */
export const ROOM_PHOTOS_LINK_LABEL = '現状復帰の写真';
