// 振り分けの Worker と主スレッドの間のメッセージ（画面の設計 4.2。T13）。型だけ（Worker と engine が共有する）。
import type { AllocateInput, AllocateResult } from '@gaapp/shared';

/** 主スレッド → Worker。attempt は読み込みに失敗した回数（wasm の URL の r。highsWasmUrl） */
export type WorkerRequest =
  | { id: number; type: 'warmup'; attempt: number }
  | { id: number; type: 'allocate'; attempt: number; input: AllocateInput };

/** Worker → 主スレッド */
export type WorkerResponse =
  /** 読み込みが終わった（warmup の答え） */
  | { id: number; type: 'ready'; loadMs: number }
  /** 読み込みに失敗した（Worker は solver を覚えず、次の要求で読み直す） */
  | { id: number; type: 'load-error'; message: string }
  /** 読み込みが終わり、計算を始めた（allocate のとき） */
  | { id: number; type: 'progress'; phase: 'solving' }
  /** 計算の結果（ok: false も含む） */
  | { id: number; type: 'result'; loadMs: number; result: AllocateResult }
  /** allocate が例外を投げた */
  | { id: number; type: 'error'; message: string };
