// テスト専用：supabase-js の問い合わせの偽物（Vitest だけで使う。アプリのコードから import しない）。
// from(表).select().eq()… の呼び出しを記録し、await されたとき（問い合わせを出したとき）に handler の結果を返す。
import type { AppSupabaseClient } from '@/lib/supabase/client';

export interface FakeOp {
  op: string;
  args: unknown[];
}

export interface FakeCall {
  /** 表の名前。RPC は `rpc:<名前>` */
  table: string;
  ops: FakeOp[];
}

export interface FakeResult {
  data?: unknown;
  error?: unknown;
  status?: number;
}

export type FakeHandler = (call: FakeCall) => FakeResult | PromiseLike<FakeResult>;

const CHAIN = [
  'select',
  'insert',
  'update',
  'upsert',
  'delete',
  'eq',
  'neq',
  'in',
  'is',
  'gt',
  'gte',
  'lt',
  'lte',
  'or',
  'match',
  'order',
  'range',
  'limit',
  'maybeSingle',
  'single',
  'retry',
] as const;

/** 問い合わせの中の op を探す（例：`opArgs(call, 'eq')`） */
export function opArgs(call: FakeCall, op: string): unknown[][] {
  return call.ops.filter((o) => o.op === op).map((o) => o.args);
}

export function createFakeSupabase(handler: FakeHandler) {
  /** 出した（await された）問い合わせの順 */
  const issued: FakeCall[] = [];

  const builder = (call: FakeCall) => {
    const b: Record<string, unknown> = {};
    for (const name of CHAIN) {
      b[name] = (...args: unknown[]) => {
        call.ops.push({ op: name, args });
        return b;
      };
    }
    b.then = (onFulfilled?: (v: unknown) => unknown, onRejected?: (e: unknown) => unknown) => {
      issued.push(call);
      return Promise.resolve(handler(call))
        .then((r) => ({ data: r.data ?? null, error: r.error ?? null, status: r.status ?? (r.error ? 400 : 200), count: null, statusText: '' }))
        .then(onFulfilled, onRejected);
    };
    return b;
  };

  const client = {
    from: (table: string) => builder({ table, ops: [] }),
    rpc: (name: string, args?: unknown) => builder({ table: `rpc:${name}`, ops: [{ op: 'rpc', args: [args] }] }),
  };
  return { client: client as unknown as AppSupabaseClient, issued };
}
