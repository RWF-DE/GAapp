// RPC の呼び出し（画面の設計 2.4。T09a）
import type { Database } from '@gaapp/shared';
import type { z } from 'zod';
import { AppError, appError, toAppError } from '@/lib/errors';
import { getSupabase, type AppSupabaseClient } from '@/lib/supabase/client';
import { RPC_ARGS, RPC_RESULTS } from './payloads';

type Functions = Database['public']['Functions'];
export type RpcName = keyof typeof RPC_ARGS & keyof Functions;
/** 呼ぶ側が渡す引数（zod の入力の型。jsonb の引数も型つきで渡せる） */
export type RpcArgs<N extends RpcName> = z.input<(typeof RPC_ARGS)[N]>;
/** jsonb を返す RPC は zod で確かめた型、それ以外は supabase gen types の型 */
export type RpcResult<N extends RpcName> = N extends keyof typeof RPC_RESULTS
  ? z.output<(typeof RPC_RESULTS)[N]>
  : Functions[N]['Returns'];

interface LooseRpcClient {
  rpc(name: string, args: unknown): PromiseLike<{ data: unknown; error: unknown; status?: number }>;
}

/** 送る前の確かめに落ちたとき。理由が空なら reason、それ以外は input（field は p_ を除いた引数の名前） */
function clientValidationError(issues: readonly z.core.$ZodIssue[]): AppError {
  const first = issues[0];
  const arg = typeof first?.path[0] === 'string' ? first.path[0] : '';
  const field = arg.replace(/^p_/, '');
  if (field === 'reason' && first?.code === 'too_small') return appError('reason', 'client_validation', { field });
  if (field === 'reason') return appError('input', 'client_validation', { field: 'reason' });
  return appError('input', 'client_validation', field ? { field } : null);
}

/**
 * RPC を呼ぶ。引数は `p_` つきの名前で渡す（2.4）。
 * - 送る前に引数を zod で確かめ（lib/rpc/payloads.ts の RPC_ARGS）、確かめた値（前後の空白を除くなど）を送る。
 * - エラーなら classifyError した AppError を投げる（status も渡すので 401 を見分けられる）。
 * - jsonb の返り値（save_auto_allocations・save_allocation_rows・invite）は zod で確かめ、合わなければ
 *   AppError（unknown・unexpected_response。画面は読み直す）を投げる。
 *
 * @example
 * const r = await callRpc('save_allocation_rows', { p_year_id, p_changes: toRpcChanges(pending), p_reason });
 * if (r.allocation_version_before === version) … else 読み直す
 */
export async function callRpc<N extends RpcName>(
  name: N,
  args: RpcArgs<N>,
  client: AppSupabaseClient = getSupabase(),
): Promise<RpcResult<N>> {
  const parsedArgs = (RPC_ARGS[name] as z.ZodType).safeParse(args);
  if (!parsedArgs.success) throw clientValidationError(parsedArgs.error.issues);
  const res = await (client as unknown as LooseRpcClient).rpc(name, parsedArgs.data);
  if (res.error) throw toAppError(res.error, res.status);
  const schema = (RPC_RESULTS as Partial<Record<RpcName, z.ZodType>>)[name];
  if (!schema) return res.data as RpcResult<N>;
  const parsed = schema.safeParse(res.data);
  if (!parsed.success) throw appError('unknown', 'unexpected_response', { rpc: name });
  return parsed.data as RpcResult<N>;
}
