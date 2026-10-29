// 入力から LP までを組み立てる（設計 4 章 buildModel）。allocate・diagnose・テストが使う
import type { InputError } from '@gaapp/shared';
import { buildCandidates, type Candidates } from './candidates';
import { createContext, type CreateContextOptions, type Ctx } from './context';
import { varName, writeLp } from './lp';
import { prepare, type Prepared } from './prepare';
import { computeWeights, ScaleError, type Weights } from './weights';

export type BuildModelOptions = CreateContextOptions;

export type Model =
  | { stage: 'invalid_input'; inputErrors: InputError[] }
  /** 前処理で止める（E001、残すのルールの E002・E005） */
  | { stage: 'precheck'; ctx: Ctx; prepared: Prepared }
  /** 前処理7：候補が足りない需要がある（LP は作らない） */
  | { stage: 'shortage'; ctx: Ctx; prepared: Prepared; cands: Candidates }
  /** 需要の行がない（solver を呼ばない） */
  | { stage: 'empty'; ctx: Ctx; prepared: Prepared; cands: Candidates }
  | { stage: 'scale_error'; ctx: Ctx; prepared: Prepared; cands: Candidates; message: string }
  | {
      stage: 'ready';
      ctx: Ctx;
      prepared: Prepared;
      cands: Candidates;
      weights: Weights;
      coef: number[];
      lp: string;
      names: string[];
    };

export function buildModel(input: unknown, opts: BuildModelOptions = {}): Model {
  const c = createContext(input, opts);
  if (!c.ok) return { stage: 'invalid_input', inputErrors: c.inputErrors };
  const ctx = c.ctx;
  const prepared = prepare(ctx);
  if (prepared.issues.length > 0) return { stage: 'precheck', ctx, prepared };
  const cands = buildCandidates(ctx, prepared);
  if (cands.shortages.length > 0) return { stage: 'shortage', ctx, prepared, cands };
  if (cands.demandRows.length === 0) return { stage: 'empty', ctx, prepared, cands };
  let w: ReturnType<typeof computeWeights>;
  try {
    w = computeWeights(cands.vars, cands.demandRows, ctx.mode);
  } catch (err) {
    if (err instanceof ScaleError) return { stage: 'scale_error', ctx, prepared, cands, message: err.message };
    throw err;
  }
  const lp = writeLp(cands, w.coef);
  return {
    stage: 'ready',
    ctx,
    prepared,
    cands,
    weights: w.weights,
    coef: w.coef,
    lp,
    names: cands.vars.map((_, n) => varName(n)),
  };
}
