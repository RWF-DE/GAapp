// 最小変更モードの確かめ方（D-08、設計 12.3）
import type { AllocateInput, AllocationRow } from '@gaapp/shared';
import { toFixedRow } from '@gaapp/shared/testing';
import { allocate } from '../allocate';
import { rgijKey } from '../context';
import { buildModel } from '../model';
import { substituteCost } from '../rules';
import type { LpSolver } from '../solve';

/** 候補のつながり：需要の行 (g,i) と在庫の行 (r,j) を変数で結んだ二部グラフの連結成分 */
export function componentsOf(vars: readonly { r: string; g: string; i: string; j: string }[]): (g: string, i: string) => string {
  const parent = new Map<string, string>();
  const find = (x: string): string => {
    let p = parent.get(x) ?? x;
    if (p !== x) {
      p = find(p);
      parent.set(x, p);
    }
    return p;
  };
  const union = (a: string, b: string) => {
    const ra = find(a);
    const rb = find(b);
    if (ra !== rb) parent.set(ra, rb);
  };
  for (const v of vars) union(`D|${v.g}|${v.i}`, `S|${v.r}|${v.j}`);
  return (g, i) => find(`D|${g}|${i}`);
}

const keyOf = (r: AllocationRow) => rgijKey(r.sourceRoomId, r.groupId, r.requestedItemId, r.itemId);
const giOf = (r: AllocationRow) => `${r.groupId}|${r.requestedItemId}`;

export function sumByKey(rows: readonly AllocationRow[]): Map<string, number> {
  const m = new Map<string, number>();
  for (const r of rows) m.set(keyOf(r), (m.get(keyOf(r)) ?? 0) + r.count);
  return m;
}

export type D08Judgement = {
  /** (a) 前回の M 以外の行が減ったキー（補えるつながり） */
  decreased: string[];
  /** (b) 無関係な行が変わった・現れた・なくなったキー（補えるつながり） */
  unrelatedChanged: string[];
  /** M から受け取っていた (g,i) の前回の M 以外の行が増えたキー（補えるつながり。許す。記録する。設計 6.3） */
  increased: string[];
  /** M から受け取っていた (g,i) の新しいキー（補えるつながり。許す。記録する） */
  appeared: string[];
  /** 補えないつながりの変わった行の数（記録する） */
  changedInBad: number;
  /** M の行を含まないつながりの変わった行（0 であるべき） */
  untouchedChanged: string[];
};

/**
 * 変わった行を判定する（手順3・6）。before・after は rows（固定行を含まない）、comp は手順2のモデルのつながり、
 * goodComps は「補える」つながり、targetComps は M から運んでいた前回の行の (g,i) を含むつながり。
 */
export function judgeD08(args: {
  before: readonly AllocationRow[];
  after: readonly AllocationRow[];
  M: string;
  comp: (g: string, i: string) => string;
  targetComps: ReadonlySet<string>;
  goodComps: ReadonlySet<string>;
}): D08Judgement {
  const { before, after, M, comp, targetComps, goodComps } = args;
  const lostGi = new Set(before.filter((r) => r.sourceRoomId === M).map(giOf));
  const b = sumByKey(before);
  const a = sumByKey(after);
  const out: D08Judgement = { decreased: [], unrelatedChanged: [], increased: [], appeared: [], changedInBad: 0, untouchedChanged: [] };
  for (const k of new Set([...b.keys(), ...a.keys()])) {
    const x = b.get(k) ?? 0;
    const y = a.get(k) ?? 0;
    const [r, g, i] = k.split('|') as [string, string, string];
    const c = comp(g, i);
    if (!targetComps.has(c)) {
      if (x !== y) out.untouchedChanged.push(k);
      continue;
    }
    if (!goodComps.has(c)) {
      if (x !== y) out.changedInBad++;
      continue;
    }
    if (r === M) continue; // M からの行は失われてよい
    if (y < x) out.decreased.push(k);
    if (!lostGi.has(`${g}|${i}`)) {
      if (x !== y) out.unrelatedChanged.push(k);
    } else if (y > x) (x > 0 ? out.increased : out.appeared).push(k);
  }
  return out;
}

export type D08Result =
  | { ok: false; fullOk: boolean; reason: string }
  | ({
      ok: true;
      /** 前回 M から運んだ行の数 */
      fromM: number;
      comps: number;
      good: number;
      bad: number;
      before: AllocationRow[];
      after: AllocationRow[];
    } & D08Judgement);

/**
 * input は M を使用可にした全体の実行の入力。手順1〜6を行う：full で解き、M を使用不可にして minimal_change で解き、
 * つながりごとに「補える」かを判定して、変わった行を judgeD08 で分ける。
 */
export function checkMinimalChange(input: AllocateInput, M: string, solver: LpSolver): D08Result {
  const full = allocate(input, solver);
  if (!full.ok) return { ok: false, fullOk: false, reason: full.reason };
  const input2: AllocateInput = {
    ...input,
    rooms: input.rooms.map((r) => (r.id === M ? { ...r, usable: false } : r)),
    mode: 'minimal_change',
    previousRows: full.rows,
  };
  const mc = allocate(input2, solver);
  if (!mc.ok) return { ok: false, fullOk: true, reason: mc.reason };
  const m2 = buildModel(input2);
  if (m2.stage !== 'ready') throw new Error(`手順2のモデルが ${m2.stage}`);
  const comp = componentsOf(m2.cands.vars);
  const ctx = m2.ctx;
  const csub = (r: AllocationRow) =>
    substituteCost(ctx, ctx.groupById.get(r.groupId)!, ctx.itemById.get(r.requestedItemId)!, r.itemId) ?? Number.NaN;

  const fromM = full.rows.filter((r) => r.sourceRoomId === M);
  const prevNonM = full.rows.filter((r) => r.sourceRoomId !== M);
  const targetComps = new Set(fromM.map((r) => comp(r.groupId, r.requestedItemId)));
  const goodComps = new Set<string>();
  for (const c of targetComps) {
    const inC = (r: AllocationRow) => comp(r.groupId, r.requestedItemId) === c;
    const fixed = prevNonM.filter(inC).map((r, n) => toFixedRow(r, 100000 + n, { pinned: true }));
    const aux = allocate({ ...input2, mode: 'full', previousRows: [], fixedRows: [...input.fixedRows, ...fixed] }, solver);
    if (!aux.ok) continue;
    const before = full.rows.filter(inC).reduce((s, r) => s + csub(r) * r.count, 0);
    const after = [...fixed, ...aux.rows.filter(inC)].reduce((s, r) => s + csub(r) * r.count, 0);
    if (before === after) goodComps.add(c);
  }
  const j = judgeD08({ before: full.rows, after: mc.rows, M, comp, targetComps, goodComps });
  return {
    ok: true,
    fromM: fromM.length,
    comps: targetComps.size,
    good: goodComps.size,
    bad: targetComps.size - goodComps.size,
    before: full.rows,
    after: mc.rows,
    ...j,
  };
}
