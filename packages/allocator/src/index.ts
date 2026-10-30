export const PACKAGE_NAME = '@gaapp/allocator';

export { allocate, FAILURE_MESSAGES } from './allocate';
export { buildModel, type Model, type BuildModelOptions } from './model';
export { createContext, rewriteRowRequestedItem, type Ctx } from './context';
export { prepare, type Prepared } from './prepare';
export { buildCandidates, type Candidate, type Candidates, type DemandRow, type SupplyRow } from './candidates';
export { computeWeights, ScaleError, type Weights } from './weights';
export { writeLp, varName } from './lp';
export { runSolver, HIGHS_OPTIONS, INFEASIBLE_STATUSES, type LpSolver, type SolverOutcome } from './solve';
export { toRows } from './rows';
export { distance } from './distance';
export { substituteOptions, allowedSources, canUse, substituteCost, type SubstituteOption } from './rules';
export { diagnose, INFEASIBLE_MESSAGE, COMBINATION_MESSAGE, type Diagnosis } from './diagnose';
export { validate } from './validate';
export { findW107, contextFor, type W107Finding } from './w107';
