// 最小のページ：Web Worker で解いて、結果を window.__result に置く（Playwright が読む）
const params = new URLSearchParams(location.search);
const worker = new Worker(new URL('./worker.ts', import.meta.url), { type: 'module' });
const out = document.getElementById('out')!;
(window as any).__result = null;
worker.onmessage = (e) => {
  (window as any).__result = e.data;
  out.textContent = JSON.stringify(e.data, null, 1).slice(0, 4000);
};
worker.onerror = (e) => {
  (window as any).__result = { error: `worker error: ${e.message}` };
  out.textContent = `worker error: ${e.message}`;
};
worker.postMessage({
  base: import.meta.env.BASE_URL, // vite の base（Next.js なら basePath）
  locate: params.get('locate') ?? 'base', // base | none | root
  full: params.get('full') !== '0', // 0 なら 5回だけ解く軽い版
});
