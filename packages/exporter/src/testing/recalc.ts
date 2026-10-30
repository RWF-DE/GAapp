// LibreOffice (headless, UNO) で xlsx を再計算して値を読む。Node 専用のテスト用（tools/recalc.py を呼ぶ）
import { execFileSync, spawnSync } from 'node:child_process';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

export type RecalcCell = { v: string | number; f?: string; e?: number } | null;
export type Recalculated = Record<string, RecalcCell[][]>;

const SCRIPT = path.join(path.dirname(fileURLToPath(import.meta.url)), '..', '..', 'tools', 'recalc.py');

export function libreOfficeAvailable(): boolean {
  const so = spawnSync(process.env.SOFFICE ?? 'soffice', ['--version'], { stdio: 'ignore' });
  if (so.status !== 0) return false;
  return spawnSync('python3', ['-c', 'import uno'], { stdio: 'ignore' }).status === 0;
}

/** xlsx のバイト列を LibreOffice で再計算して、シートごとのセルの値を返す */
export function recalcWithLibreOffice(xlsx: Uint8Array): Recalculated {
  const dir = mkdtempSync(path.join(tmpdir(), 'gaapp-recalc-'));
  try {
    const src = path.join(dir, 'in.xlsx');
    const dst = path.join(dir, 'out.json');
    writeFileSync(src, xlsx);
    execFileSync('python3', ['-I', SCRIPT, src, dst], { stdio: 'pipe', timeout: 120_000 });
    return JSON.parse(readFileSync(dst, 'utf8')) as Recalculated;
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

/** 数式エラーのセル（#REF! など）の場所 */
export function findErrors(r: Recalculated): string[] {
  const out: string[] = [];
  for (const [sheet, grid] of Object.entries(r)) {
    grid.forEach((row, i) =>
      row.forEach((c, j) => {
        if (c && (c.e || (typeof c.v === 'string' && /^(#|Err:)/.test(c.v)))) out.push(`${sheet}!R${i + 1}C${j + 1}`);
      }),
    );
  }
  return out;
}

/** 文字列が text のセルの数 */
export function countText(r: Recalculated, text: string): number {
  let n = 0;
  for (const grid of Object.values(r)) for (const row of grid) for (const c of row) if (c && c.v === text) n++;
  return n;
}
