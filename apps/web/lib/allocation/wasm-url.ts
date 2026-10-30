// highs の wasm の URL（画面の設計 4.2・4.3、D-34。T13）。Worker と Vitest（basePath ありとなし）で同じ関数を使う。
// public/highs.wasm（predev・prebuild でコピー）は basePath の下に置かれる。Next.js は public のファイルに basePath を付けないので、
// ここで付ける（1.9）。v は highs の版（版を上げたときに古い wasm をキャッシュから使わない）、r は読み直しの回数
// （GitHub Pages の 404 がキャッシュされても、読み直しで別の URL にして取り直す）。

/** basePath を `/GAapp` の形にそろえる（空・`/` は ''。末尾の `/` は外し、先頭に `/` を付ける） */
export function normalizeBasePath(basePath: string): string {
  const trimmed = basePath.trim().replace(/\/+$/, '');
  if (trimmed === '') return '';
  return trimmed.startsWith('/') ? trimmed : `/${trimmed}`;
}

/**
 * @param origin `self.location.origin`（例 `https://example.github.io`）。末尾の `/` は外す
 * @param basePath `BASE_PATH`（lib/env.ts。例 `/GAapp`、ローカルは ''）
 * @param version highs の版（shared の HIGHS_VERSION）
 * @param attempt 読み込みに失敗した回数（0 なら r を付けない）
 *
 * @example
 * highsWasmUrl('https://example.github.io', '/GAapp', '1.15.4', 0) // 'https://example.github.io/GAapp/highs.wasm?v=1.15.4'
 * highsWasmUrl('http://localhost:3000', '', '1.15.4', 2)          // 'http://localhost:3000/highs.wasm?v=1.15.4&r=2'
 */
export function highsWasmUrl(origin: string, basePath: string, version: string, attempt = 0): string {
  const o = origin.replace(/\/+$/, '');
  const base = `${o}${normalizeBasePath(basePath)}/highs.wasm?v=${encodeURIComponent(version)}`;
  const r = Number.isInteger(attempt) && attempt > 0 ? attempt : 0;
  return r > 0 ? `${base}&r=${r}` : base;
}
