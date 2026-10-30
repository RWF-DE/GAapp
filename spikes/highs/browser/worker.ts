import loadHighs from 'highs';
import { generate, makeInfeasibleS05, shuffleInput } from '../src/gen.ts';
import { buildModel, hashValues, solveModel, toRows, type CostMode } from '../src/lp.ts';
import { check, w107 } from '../src/analyze.ts';

const median = (a: number[]) => { const s = [...a].sort((x, y) => x - y); const n = s.length; return n % 2 ? s[(n - 1) / 2]! : (s[n / 2 - 1]! + s[n / 2]!) / 2; };

self.onmessage = async (ev: MessageEvent<{ base: string; locate: string; full: boolean }>) => {
  const { base, locate, full } = ev.data;
  let step = 'start';
  try {
    const res: Record<string, any> = { userAgent: navigator.userAgent, base, locate };
    const wasmUrl = locate === 'base' ? `${base}highs.wasm` : locate === 'root' ? '/highs.wasm' : undefined;
    // 注意：loadHighs に渡したオブジェクトは highs.js が書き換える。使い回すと 2 回目で TypeError になるので毎回作る
    const mkOpts = () => (wasmUrl ? { locateFile: (f: string) => (f === 'highs.wasm' ? new URL(wasmUrl, self.location.href).href : f) } : {});
    res.wasmUrl = wasmUrl ?? '(locateFile なし：既定)';
    // highs 1.15.4 は wasmModule / wasmBinary を読まない（型にはあるが実装にない）。compiled な Module を共有するには
    // Emscripten の instantiateWasm フックを使う（fetch も compile もせず instantiate だけ行う）
    const mkShared = (mod: WebAssembly.Module) => ({ instantiateWasm: (imports: WebAssembly.Imports, receive: (i: WebAssembly.Instance) => void) => { WebAssembly.instantiate(mod, imports).then(receive); return {}; } }) as any;

    step = 'cold load';
    // 1. 読み込み（初回。fetch + compile + instantiate）
    const t0 = performance.now();
    const highs = await loadHighs(mkOpts());
    res.loadColdMs = performance.now() - t0;
    const rt = performance.getEntriesByType('resource').filter((e) => e.name.endsWith('.wasm')) as PerformanceResourceTiming[];
    res.wasmResource = rt.map((e) => ({ name: e.name, transferSize: e.transferSize, encodedBodySize: e.encodedBodySize, decodedBodySize: e.decodedBodySize, durationMs: e.duration }));
    res.highsVersion = highs.version.string;

    // 2. 内訳：fetch / compile / instantiate を分けて測る（locateFile の URL を使う）
    if (wasmUrl) {
      step = 'split';
      const url = new URL(wasmUrl, self.location.href).href;
      const a = performance.now();
      const buf = await (await fetch(url)).arrayBuffer(); // HTTP キャッシュが効く場合がある
      const b = performance.now();
      const mod = await WebAssembly.compile(buf);
      const c = performance.now();
      await loadHighs(mkShared(mod));
      const d = performance.now();
      res.split = { fetchMs: b - a, compileMs: c - b, instantiateMs: d - c, bytes: buf.byteLength };
      step = 'reload x5';
      // 5 回読み込み直し（キャッシュ後）
      const ts: number[] = [];
      for (let k = 0; k < 5; k++) { const s = performance.now(); await loadHighs(mkOpts()); ts.push(performance.now() - s); }
      res.loadWarmMs = ts; res.loadWarmMedian = median(ts);
    }

    step = 'solve';
    // 3. モデルを作る・解く（5回）
    const d0 = generate();
    const tb = performance.now();
    const models = { original: buildModel(d0.input, { costMode: 'original', wrap: 300 }), integer: buildModel(d0.input, { costMode: 'integer', wrap: 300 }) };
    res.buildMs = (performance.now() - tb) / 2;
    res.stats = { original: models.original.stats, integer: models.integer.stats };
    for (const mode of ['original', 'integer'] as CostMode[]) {
      const m = models[mode];
      const times: number[] = [], hashes: string[] = [];
      let maxFrac = 0, status = '', objective = 0, rows: ReturnType<typeof toRows> = [];
      for (let k = 0; k < 5; k++) {
        const s = solveModel(highs, m);
        status = s.status; if (status !== 'Optimal') break;
        times.push(s.ms); hashes.push(hashValues(s.values)); maxFrac = Math.max(maxFrac, s.maxFrac); objective = s.objective;
        if (k === 0) rows = toRows(m, s.values);
      }
      res[mode] = { status, times, median: median(times), hashes, sameAll: new Set(hashes).size === 1, maxFrac, objective, issues: check(d0.input, m, rows).length, w107: w107(d0.input, rows).length };
    }
    // 並べ替え
    const ms = buildModel(shuffleInput(d0.input, 3), { costMode: 'original', wrap: 300 });
    res.shuffledSame = hashValues(solveModel(highs, ms).values) === res.original.hashes[0];
    res.infeasibleStatus = solveModel(highs, buildModel(makeInfeasibleS05(d0), { costMode: 'original', wrap: 300 })).status;

    if (full) {
      step = 'reuse/recreate';
      // 4. 20回続けて解く（使い回し／毎回作り直し）
      const m = models.original;
      const reuse: number[] = [], rh: string[] = [];
      const mem0 = highs.memoryBytes;
      for (let k = 0; k < 20; k++) { const s = solveModel(highs, m); reuse.push(s.ms); rh.push(hashValues(s.values)); }
      res.reuse = { times: reuse, first: reuse[0], medianRest: median(reuse.slice(1)), sameAll: new Set(rh).size === 1, mem0, mem1: highs.memoryBytes };
      const url = new URL(wasmUrl ?? `${base}highs.wasm`, self.location.href).href;
      const mod = await WebAssembly.compile(await (await fetch(url)).arrayBuffer());
      const lt: number[] = [], st: number[] = [], rc: string[] = [];
      for (let k = 0; k < 20; k++) {
        const s0 = performance.now();
        const h = await loadHighs(mkShared(mod));
        lt.push(performance.now() - s0);
        const s = solveModel(h, m); st.push(s.ms); rc.push(hashValues(s.values));
      }
      res.recreate = { loadMedian: median(lt), solveMedian: median(st), sameAll: new Set(rc).size === 1, loadMax: Math.max(...lt) };
    }
    (self as any).postMessage(res);
  } catch (e) {
    (self as any).postMessage({ error: `[${step}] ` + String((e as Error)?.stack ?? e).slice(0, 1500), locate });
  }
};
