import type { AllocateInput, AllocateResult } from '@gaapp/shared';
import { describe, expect, it, vi } from 'vitest';
import {
  createAllocatorEngine,
  EngineCancelledError,
  LOAD_ERROR_MESSAGE,
  UNEXPECTED_ERROR_MESSAGE,
  WORKER_ERROR_MESSAGE,
  type WorkerLike,
} from './engine';
import type { WorkerRequest, WorkerResponse } from './protocol';

class FakeWorker implements WorkerLike {
  onmessage: ((e: MessageEvent<WorkerResponse>) => void) | null = null;
  onerror: ((e: Event) => void) | null = null;
  sent: WorkerRequest[] = [];
  terminated = false;
  postMessage(m: WorkerRequest) {
    this.sent.push(m);
  }
  terminate() {
    this.terminated = true;
  }
  reply(m: WorkerResponse) {
    this.onmessage?.({ data: m } as MessageEvent<WorkerResponse>);
  }
  last() {
    return this.sent.at(-1)!;
  }
}

const input = { mode: 'full' } as unknown as AllocateInput;
const okResult: AllocateResult = {
  ok: true,
  rows: [],
  objective: 0,
  elapsedMs: 12,
  stats: {} as Extract<AllocateResult, { ok: true }>['stats'],
};

function setup() {
  const workers: FakeWorker[] = [];
  const engine = createAllocatorEngine(() => {
    const w = new FakeWorker();
    workers.push(w);
    return w;
  });
  return { engine, workers };
}

describe('createAllocatorEngine', () => {
  it('Worker は warmup を呼ぶまで作らず、1つだけ作って使い回す', async () => {
    const { engine, workers } = setup();
    expect(workers).toHaveLength(0);
    expect(engine.state()).toBe('idle');
    const p = engine.warmup();
    expect(engine.state()).toBe('loading');
    expect(engine.warmup()).toBe(p); // 読み込み中はまとめる
    workers[0]!.reply({ id: workers[0]!.last().id, type: 'ready', loadMs: 200 });
    await expect(p).resolves.toEqual({ ok: true, loadMs: 200 });
    expect(engine.state()).toBe('ready');

    const r = engine.run(input);
    const req = workers[0]!.last();
    expect(req).toMatchObject({ type: 'allocate', attempt: 0 });
    workers[0]!.reply({ id: req.id, type: 'progress', phase: 'solving' });
    workers[0]!.reply({ id: req.id, type: 'result', loadMs: 0, result: okResult });
    await expect(r).resolves.toMatchObject({ result: okResult, loadMs: 0 });
    expect(workers).toHaveLength(1);
    await expect(engine.warmup()).resolves.toEqual({ ok: true, loadMs: 0 }); // 済んでいればすぐ返る
    expect(workers[0]!.sent).toHaveLength(2);
  });

  it('読み込みの失敗を覚えない：次の要求で読み直し、回数（attempt）を付ける', async () => {
    const { engine, workers } = setup();
    const p = engine.warmup();
    const w = workers[0]!;
    w.reply({ id: w.last().id, type: 'load-error', message: '404' });
    await expect(p).resolves.toEqual({ ok: false, message: LOAD_ERROR_MESSAGE });
    expect(engine.state()).toBe('failed');

    const r = engine.run(input);
    expect(w.last()).toMatchObject({ type: 'allocate', attempt: 1 });
    w.reply({ id: w.last().id, type: 'load-error', message: '404' });
    const out = await r;
    expect(out.result).toMatchObject({ ok: false, reason: 'solver_error', message: LOAD_ERROR_MESSAGE });

    const r2 = engine.run(input);
    expect(w.last()).toMatchObject({ attempt: 2 });
    w.reply({ id: w.last().id, type: 'result', loadMs: 180, result: okResult });
    await expect(r2).resolves.toMatchObject({ result: okResult, loadMs: 180 });
    expect(engine.state()).toBe('ready');
    expect(workers).toHaveLength(1); // 同じ Worker の中で読み直す
  });

  it('段階を知らせる：読み込みが済んでいなければ loading、計算を始めたら solving', async () => {
    const { engine, workers } = setup();
    const phases: string[] = [];
    const r = engine.run(input, { onPhase: (p) => phases.push(p) });
    const w = workers[0]!;
    expect(phases).toEqual(['loading']);
    w.reply({ id: w.last().id, type: 'progress', phase: 'solving' });
    expect(phases).toEqual(['loading', 'solving']);
    w.reply({ id: w.last().id, type: 'result', loadMs: 150, result: okResult });
    await r;
    const phases2: string[] = [];
    void engine.run(input, { onPhase: (p) => phases2.push(p) });
    expect(phases2).toEqual(['solving']);
  });

  it('allocate の例外は solver_error（予期しないエラー）にそろえる', async () => {
    const { engine, workers } = setup();
    const r = engine.run(input);
    const w = workers[0]!;
    w.reply({ id: w.last().id, type: 'error', message: 'boom' });
    const out = await r;
    expect(out.result).toMatchObject({ ok: false, reason: 'solver_error', message: UNEXPECTED_ERROR_MESSAGE });
  });

  it('中止（cancel）は Worker を terminate し、run は EngineCancelledError。次の run で作り直す', async () => {
    const { engine, workers } = setup();
    const r = engine.run(input);
    engine.cancel();
    await expect(r).rejects.toBeInstanceOf(EngineCancelledError);
    expect(workers[0]!.terminated).toBe(true);
    expect(engine.state()).toBe('idle');
    void engine.run(input);
    expect(workers).toHaveLength(2);
  });

  it('Worker の起動の失敗（onerror）は Worker を捨て、待っている要求を solver_error にする', async () => {
    const { engine, workers } = setup();
    const p = engine.warmup();
    const r = engine.run(input);
    workers[0]!.onerror!(new Event('error'));
    await expect(p).resolves.toEqual({ ok: false, message: WORKER_ERROR_MESSAGE });
    expect((await r).result).toMatchObject({ ok: false, reason: 'solver_error', message: WORKER_ERROR_MESSAGE });
    expect(workers[0]!.terminated).toBe(true);
    expect(engine.state()).toBe('failed');
    void engine.warmup();
    expect(workers).toHaveLength(2);
  });

  it('状態の変化を知らせる（useSyncExternalStore 用）', async () => {
    const { engine, workers } = setup();
    const fn = vi.fn();
    const off = engine.subscribe(fn);
    const p = engine.warmup();
    workers[0]!.reply({ id: workers[0]!.last().id, type: 'ready', loadMs: 1 });
    await p;
    expect(fn).toHaveBeenCalledTimes(2); // loading → ready
    off();
    engine.dispose();
    expect(fn).toHaveBeenCalledTimes(2);
  });

  it('Worker を作れない環境（例外）は failed にして solver_error を返す', async () => {
    const engine = createAllocatorEngine(() => {
      throw new Error('no Worker');
    });
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    await expect(engine.warmup()).resolves.toEqual({ ok: false, message: WORKER_ERROR_MESSAGE });
    expect((await engine.run(input)).result).toMatchObject({ ok: false, reason: 'solver_error' });
    warn.mockRestore();
  });
});
