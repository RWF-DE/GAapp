// 取り込みの E2E とスクリーンショットで使う、模擬店フォームの CSV（fixtures/importer-samples/stall.csv と同じ見出し）。
// 模擬店甲の新しい回答（10/07）が列のずれで読めない。模擬店甲の読めた回答は 10/06 の1件だけ、模擬店乙は読める。
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

const STALL_CSV = fileURLToPath(new URL('../../fixtures/importer-samples/stall.csv', import.meta.url));

/** 1行（列：0 タイムスタンプ・7 団体名（非飲食）・8 机(木)・9 椅子(木)。extra は見出しのない右端の列＝列のずれ） */
function line(cols: number, ts: string, name: string, desk: number, chair: number, extra = ''): string {
  const cells = Array<string>(cols).fill('');
  cells[0] = ts;
  cells[7] = name;
  cells[8] = String(desk);
  cells[9] = String(chair);
  if (extra) cells[cols - 1] = extra;
  return cells.join(',');
}

/** setInputFiles に渡す形 */
export function stallCsvWithUnreadableNewer(): { name: string; mimeType: string; buffer: Buffer } {
  const header = readFileSync(STALL_CSV, 'utf8').split(/\r?\n/)[0]!;
  const cols = header.split(',').length;
  const text = [
    header,
    line(cols, '2026/10/06 09:00:00', '模擬店甲', 3, 6), // 行2：模擬店甲の読めた回答
    line(cols, '2026/10/07 09:00:00', '模擬店甲', 4, 8, 'ずれ'), // 行3：模擬店甲の新しい回答（列のずれ）
    line(cols, '2026/10/06 10:00:00', '模擬店乙', 1, 2), // 行4：模擬店乙
    '',
  ].join('\n');
  return { name: 'stall.csv', mimeType: 'text/csv', buffer: Buffer.from(text, 'utf8') };
}
