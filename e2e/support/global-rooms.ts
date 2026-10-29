// db-setup が書いた年度をまたぐ表の場所の一覧（e2e/.cache/global-rooms.json。画面の設計 7.2。T09a）。
// 年度をまたぐ表の全体（場所の数など）を当てにするテストは、数を書き込まずにここから期待値を作る。
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import type { GlobalRoom } from './db';

export const GLOBAL_ROOMS_FILE = fileURLToPath(new URL('../.cache/global-rooms.json', import.meta.url));

/** db-setup の後に読む（なければ例外） */
export function readGlobalRooms(): GlobalRoom[] {
  const body = JSON.parse(readFileSync(GLOBAL_ROOMS_FILE, 'utf8')) as { rooms: GlobalRoom[] };
  return body.rooms;
}
