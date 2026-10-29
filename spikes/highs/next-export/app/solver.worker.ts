import loadHighs from 'highs';

const LP = `Minimize
 obj: + 2 x1 + 3 x2 + 4 x3 + 1 x4
Subject To
 s1: + x1 + x2 <= 5
 s2: + x3 + x4 <= 5
 d1: + x1 + x3 = 4
 d2: + x2 + x4 = 6
End
`;

self.onmessage = async (ev: MessageEvent<{ basePath: string; locate: string }>) => {
  const { basePath, locate } = ev.data;
  try {
    const opts =
      locate === 'base'
        ? { locateFile: (f: string) => (f.endsWith('.wasm') ? new URL(`${basePath}/${f}?v=1.15.4`, self.location.origin).href : f) }
        : locate === 'root'
          ? { locateFile: (f: string) => `/${f}` } // basePath を忘れた例
          : {};
    const t0 = performance.now();
    const highs = await loadHighs(opts);
    const loadMs = performance.now() - t0;
    const r = highs.solve(LP, { solver: 'simplex', random_seed: 0, time_limit: 30, output_flag: false });
    (self as any).postMessage({ ok: true, locate, loadMs, status: r.Status, objective: r.ObjectiveValue, x: Object.fromEntries(Object.entries(r.Columns).map(([k, v]: any) => [k, v.Primal])) });
  } catch (e) {
    (self as any).postMessage({ error: String((e as Error)?.message ?? e).slice(0, 300), locate });
  }
};
