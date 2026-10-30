// 振り分けの計算の Web Worker（画面の設計 4.2、ロジック設計 4 章、D-34。T13）。
// highs（wasm）を1回だけ読み込んで使い回す。読み込みに失敗したら覚えず（solver を null に戻す）、次の要求で読み直す。
// wasm の URL は highsWasmUrl（basePath と版、読み直しの回数 r）。オプションのオブジェクトは呼ぶたびに新しく作る（T00）。
import loadHighs from 'highs';
import { allocate, type LpSolver } from '@gaapp/allocator';
import { HIGHS_VERSION } from '@gaapp/shared';
import { highsWasmUrl } from '../lib/allocation/wasm-url';
import type { WorkerRequest, WorkerResponse } from '../lib/allocation/protocol';
import { BASE_PATH } from '../lib/env';

// apps/web の tsconfig は DOM の型なので、Worker の self は使う所だけの形で受ける（lib の webworker と DOM は同時に読めない）
const ctx = self as unknown as {
  location: { origin: string };
  onmessage: ((e: MessageEvent<WorkerRequest>) => void) | null;
  postMessage(message: WorkerResponse): void;
};

let solver: Promise<LpSolver> | null = null;

function getSolver(attempt: number): Promise<LpSolver> {
  solver ??= (
    loadHighs({
      locateFile: (file: string) =>
        file.endsWith('.wasm') ? highsWasmUrl(ctx.location.origin, BASE_PATH, HIGHS_VERSION, attempt) : file,
    }) as unknown as Promise<LpSolver>
  ).catch((err: unknown) => {
    solver = null; // 失敗を残さない（次の要求で読み直す）
    throw err;
  });
  return solver;
}

ctx.onmessage = async (e: MessageEvent<WorkerRequest>) => {
  const req = e.data;
  const t0 = performance.now();
  let s: LpSolver;
  try {
    s = await getSolver(req.attempt);
  } catch (err) {
    ctx.postMessage({ id: req.id, type: 'load-error', message: String(err) });
    return;
  }
  const loadMs = performance.now() - t0;
  if (req.type === 'warmup') {
    ctx.postMessage({ id: req.id, type: 'ready', loadMs });
    return;
  }
  ctx.postMessage({ id: req.id, type: 'progress', phase: 'solving' });
  try {
    ctx.postMessage({ id: req.id, type: 'result', loadMs, result: allocate(req.input, s) });
  } catch (err) {
    ctx.postMessage({ id: req.id, type: 'error', message: String(err) });
  }
};
