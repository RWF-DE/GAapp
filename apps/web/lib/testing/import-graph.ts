// テスト専用：静的な import のグラフ（T16。D-51「/ の JS にスナップショット・検証を入れない」を Vitest で確かめる）。
// 型だけの import・export（`import type`・`export type`）と、動的な import()（使う所で読む）はたどらない。
// '@/…' と相対のパスは apps/web のファイルに解いてたどり、パッケージ（@tanstack/react-query など）は名前だけを集める。
import { existsSync, readFileSync, statSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import ts from 'typescript';

/** apps/web の置き場所 */
const WEB_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
const SUFFIXES = ['', '.ts', '.tsx', '/index.ts', '/index.tsx'];

export interface ImportGraph {
  /** たどったファイル（apps/web からの相対パス。例：'lib/modules/portal.ts'）。名前の順 */
  files: string[];
  /** 実行時に import するパッケージ（例：'@tanstack/react-query'）。名前の順 */
  packages: string[];
}

function resolveLocal(spec: string, from: string): string {
  const base = spec.startsWith('@/') ? path.join(WEB_ROOT, spec.slice(2)) : path.resolve(path.dirname(from), spec);
  for (const s of SUFFIXES) {
    const p = base + s;
    if (existsSync(p) && statSync(p).isFile()) return p;
  }
  throw new Error(`import を解けません：${spec}（${path.relative(WEB_ROOT, from)}）`);
}

/** そのファイルが実行時に読むモジュールの指定（トップレベルの import・export … from） */
function runtimeSpecifiers(file: string): string[] {
  const kind = file.endsWith('.tsx') ? ts.ScriptKind.TSX : ts.ScriptKind.TS;
  const sf = ts.createSourceFile(file, readFileSync(file, 'utf8'), ts.ScriptTarget.Latest, false, kind);
  const out: string[] = [];
  for (const st of sf.statements) {
    if (ts.isImportDeclaration(st) && !st.importClause?.isTypeOnly && ts.isStringLiteral(st.moduleSpecifier)) {
      out.push(st.moduleSpecifier.text);
    } else if (ts.isExportDeclaration(st) && !st.isTypeOnly && st.moduleSpecifier && ts.isStringLiteral(st.moduleSpecifier)) {
      out.push(st.moduleSpecifier.text);
    }
  }
  return out;
}

/**
 * entries（apps/web からの相対パス）から実行時の import をたどる。
 *
 * @example
 * const g = staticImportGraph('lib/modules/providers.ts');
 * expect(g.files.filter((f) => f.startsWith('lib/data/'))).toEqual([]);
 */
export function staticImportGraph(...entries: string[]): ImportGraph {
  const files = new Set<string>();
  const packages = new Set<string>();
  const queue = entries.map((e) => path.join(WEB_ROOT, e));
  for (let file = queue.shift(); file !== undefined; file = queue.shift()) {
    const rel = path.relative(WEB_ROOT, file).split(path.sep).join('/');
    if (files.has(rel)) continue;
    files.add(rel);
    for (const spec of runtimeSpecifiers(file)) {
      if (spec.startsWith('@/') || spec.startsWith('.')) queue.push(resolveLocal(spec, file));
      else packages.add(spec);
    }
  }
  return { files: [...files].sort(), packages: [...packages].sort() };
}
