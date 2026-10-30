// 振り分けの計算エンジン（画面の設計 4.2・4.3、D-34。T13）。Web Worker を1つだけ持ち、使い回す。
// - Worker は warmup・run を初めて呼んだときに作る（管理者が振り分け中に振り分け画面を開いたときだけ。画面が warmup を呼ぶ）。
//   SPA の中で画面を離れて戻っても同じ Worker を使う。ログアウト（SIGNED_OUT）で terminate する。
// - 読み込みの失敗は覚えない：Worker は solver を null に戻し、次の要求で読み直す。読み直しの URL には失敗した回数（r）を付ける
//   （GitHub Pages の 404 がキャッシュされても取り直す）。
// - cancel()（「中止」）は Worker を terminate し、次の run で作り直す。DB には何も書いていない段階でだけ呼ぶ（保存を送った後は呼ばない）。
// - load-error と allocate の例外は、画面が同じ見出しで出せるよう ok: false・reason: solver_error の結果にそろえる。
import type { AllocateInput, AllocateResult } from '@gaapp/shared';
import { useSyncExternalStore } from 'react';
import type { WorkerRequest, WorkerResponse } from './protocol';

export type EngineState = 'idle' | 'loading' | 'ready' | 'failed';
/** Worker の中の段階：読み込み（初回・読み直し）と計算 */
export type EnginePhase = 'loading' | 'solving';

export const LOAD_ERROR_MESSAGE =
  '計算エンジン（highs）を読み込めませんでした。通信を確かめて、もう一度実行してください。続くならページを再読み込みしてください';
export const WORKER_ERROR_MESSAGE = '計算エンジンを起動できませんでした。ページを再読み込みしてください';
export const UNEXPECTED_ERROR_MESSAGE = '計算中に予期しないエラーが起きました';

/** 「中止」で止めた run の Promise が投げるエラー */
export class EngineCancelledError extends Error {
  override name = 'EngineCancelledError';
  constructor() {
    super('cancelled');
  }
}

export interface RunOutcome {
  result: AllocateResult;
  /** この run の中で highs を読み込んだ時間（読み込み済みならほぼ 0） */
  loadMs: number;
  /** postMessage から結果までの時間（往復） */
  wallMs: number;
}

export type WarmupOutcome = { ok: true; loadMs: number } | { ok: false; message: string; cancelled?: boolean };

export interface AllocatorEngine {
  state(): EngineState;
  /** 状態が変わったら呼ぶ（useSyncExternalStore 用）。戻り値で外す */
  subscribe(fn: () => void): () => void;
  /** 読み込みを始める（済んでいればすぐ返る）。失敗しても例外にせず ok: false を返す */
  warmup(): Promise<WarmupOutcome>;
  /** 計算する。onPhase で段階（読み込み → 計算）を知らせる。中止されたら EngineCancelledError */
  run(input: AllocateInput, opts?: { onPhase?: (phase: EnginePhase) => void }): Promise<RunOutcome>;
  /** 「中止」：Worker を terminate して、次の run で作り直す */
  cancel(): void;
  /** ログアウト：cancel と同じ（Worker を止める） */
  dispose(): void;
}

/** engine が使う Worker の部分（テストで偽物に差し替える） */
export interface WorkerLike {
  postMessage(message: WorkerRequest): void;
  terminate(): void;
  onmessage: ((e: MessageEvent<WorkerResponse>) => void) | null;
  onerror: ((e: Event) => void) | null;
}

/** solver_error の結果（読み込みの失敗・Worker の起動の失敗・allocate の例外） */
export function solverErrorResult(message: string): AllocateResult {
  return { ok: false, reason: 'solver_error', message, inputErrors: [], issues: [], shortages: [], causes: [], elapsedMs: 0 };
}

type Pending =
  | { kind: 'warmup'; resolve: (o: WarmupOutcome) => void }
  | {
      kind: 'run';
      t0: number;
      resolve: (o: RunOutcome) => void;
      reject: (e: unknown) => void;
      onPhase?: (phase: EnginePhase) => void;
    };

/**
 * engine を作る（テストは偽の Worker を渡す。アプリは getAllocatorEngine で1つだけ使う）。
 * @param makeWorker Worker を作る関数（warmup・run を初めて呼んだとき、cancel・起動の失敗の後に呼ぶ）
 */
export function createAllocatorEngine(makeWorker: () => WorkerLike, now: () => number = () => performance.now()): AllocatorEngine {
  let worker: WorkerLike | null = null;
  let current: EngineState = 'idle';
  let attempt = 0; // 読み込みに失敗した回数（wasm の URL の r）
  let seq = 0;
  let warming: Promise<WarmupOutcome> | null = null;
  const pending = new Map<number, Pending>();
  const listeners = new Set<() => void>();

  const setState = (s: EngineState) => {
    if (current === s) return;
    current = s;
    for (const fn of [...listeners]) fn();
  };

  const settleAll = (onWarmup: WarmupOutcome, onRun: (p: Extract<Pending, { kind: 'run' }>) => void) => {
    const list = [...pending.values()];
    pending.clear();
    warming = null;
    for (const p of list) {
      if (p.kind === 'warmup') p.resolve(onWarmup);
      else onRun(p);
    }
  };

  const drop = () => {
    if (!worker) return;
    const w = worker;
    worker = null;
    w.onmessage = null;
    w.onerror = null;
    w.terminate();
  };

  const onMessage = (e: MessageEvent<WorkerResponse>) => {
    const msg = e.data;
    const p = pending.get(msg.id);
    if (!p) return;
    switch (msg.type) {
      case 'ready':
        pending.delete(msg.id);
        setState('ready');
        if (p.kind === 'warmup') p.resolve({ ok: true, loadMs: msg.loadMs });
        return;
      case 'progress':
        setState('ready');
        if (p.kind === 'run') p.onPhase?.('solving');
        return;
      case 'load-error':
        pending.delete(msg.id);
        attempt += 1;
        setState('failed');
        console.warn('highs の読み込みに失敗しました', msg.message);
        if (p.kind === 'warmup') p.resolve({ ok: false, message: LOAD_ERROR_MESSAGE });
        else p.resolve({ result: solverErrorResult(LOAD_ERROR_MESSAGE), loadMs: 0, wallMs: now() - p.t0 });
        return;
      case 'result':
        pending.delete(msg.id);
        setState('ready');
        if (p.kind === 'run') p.resolve({ result: msg.result, loadMs: msg.loadMs, wallMs: now() - p.t0 });
        return;
      case 'error':
        pending.delete(msg.id);
        console.warn('allocate が例外を投げました', msg.message);
        if (p.kind === 'run') p.resolve({ result: solverErrorResult(UNEXPECTED_ERROR_MESSAGE), loadMs: 0, wallMs: now() - p.t0 });
        return;
    }
  };

  const onError = (e: Event) => {
    // Worker のチャンクの取得の失敗など（デプロイの直後に古いページで起きうる）。Worker を捨て、次の要求で作り直す
    e.preventDefault?.();
    drop();
    setState('failed');
    settleAll({ ok: false, message: WORKER_ERROR_MESSAGE }, (p) =>
      p.resolve({ result: solverErrorResult(WORKER_ERROR_MESSAGE), loadMs: 0, wallMs: now() - p.t0 }),
    );
  };

  const ensureWorker = (): WorkerLike | null => {
    if (worker) return worker;
    try {
      worker = makeWorker();
    } catch (err) {
      console.warn('Worker を作れませんでした', err);
      worker = null;
      return null;
    }
    worker.onmessage = onMessage;
    worker.onerror = onError;
    return worker;
  };

  const stop = () => {
    drop();
    setState('idle');
    settleAll({ ok: false, message: '中止しました', cancelled: true }, (p) => p.reject(new EngineCancelledError()));
  };

  return {
    state: () => current,
    subscribe(fn) {
      listeners.add(fn);
      return () => listeners.delete(fn);
    },
    warmup() {
      if (current === 'ready') return Promise.resolve({ ok: true, loadMs: 0 });
      if (warming) return warming;
      const w = ensureWorker();
      if (!w) {
        setState('failed');
        return Promise.resolve({ ok: false, message: WORKER_ERROR_MESSAGE });
      }
      const id = ++seq;
      setState('loading');
      warming = new Promise<WarmupOutcome>((resolve) => {
        pending.set(id, { kind: 'warmup', resolve });
      }).finally(() => {
        warming = null;
      });
      w.postMessage({ id, type: 'warmup', attempt });
      return warming;
    },
    run(input, opts = {}) {
      const t0 = now();
      const w = ensureWorker();
      if (!w) {
        setState('failed');
        return Promise.resolve({ result: solverErrorResult(WORKER_ERROR_MESSAGE), loadMs: 0, wallMs: 0 });
      }
      const id = ++seq;
      const ready = current === 'ready';
      if (!ready) setState('loading');
      opts.onPhase?.(ready ? 'solving' : 'loading');
      const p = new Promise<RunOutcome>((resolve, reject) => {
        pending.set(id, { kind: 'run', t0, resolve, reject, ...(opts.onPhase ? { onPhase: opts.onPhase } : {}) });
      });
      w.postMessage({ id, type: 'allocate', attempt, input });
      return p;
    },
    cancel: stop,
    dispose: stop,
  };
}

let shared: AllocatorEngine | null = null;

/**
 * アプリの engine（1つだけ。Worker はまだ作らない）。`new Worker(new URL(…, import.meta.url))` はここにだけ書く
 * （Turbopack が Worker のチャンクを分け、new Worker を実行するまで取得しない）。ブラウザでだけ呼ぶ（useEffect・イベントの中）。
 */
export function getAllocatorEngine(): AllocatorEngine {
  if (shared) return shared;
  const engine = createAllocatorEngine(
    () => new Worker(new URL('../../workers/allocate.worker.ts', import.meta.url)) as unknown as WorkerLike,
  );
  shared = engine;
  // ログアウトで Worker を止める（AuthProvider は T09a のものなので、ここで Supabase のイベントを聞く）
  void import('@/lib/supabase/client').then(({ getSupabase }) => {
    getSupabase().auth.onAuthStateChange((event) => {
      if (event === 'SIGNED_OUT') engine.dispose();
    });
  });
  return engine;
}

/** engine の状態（画面の表示用） */
export function useEngineState(engine: AllocatorEngine | null): EngineState {
  return useSyncExternalStore(
    (fn) => (engine ? engine.subscribe(fn) : () => undefined),
    () => (engine ? engine.state() : 'idle'),
    () => 'idle',
  );
}
