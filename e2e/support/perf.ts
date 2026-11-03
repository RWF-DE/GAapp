// 4G の速さの計測（e2e/perf.spec.ts）のうち、ブラウザにも DB にもつながない部分：交互に開く順と、対の差の集計（FU3。
// notes/FU3.md の「計画」2.4）。e2e-support の Vitest（perf.test.ts）で確かめる。

/** 比べる2つの書き出し。a は PERF_AB のフォルダ（ふつうは main の apps/web/out）、b はこの checkout の apps/web/out */
export type Build = 'a' | 'b';

/**
 * 分位（R の quantile の type 7。numpy の既定と同じく、小さい順に並べた値の (n − 1)p 番目を前後の値から線形に補う）。空なら null。
 * 中央値は p = 0.5（数が偶数なら真ん中の2つの平均）、四分位は p = 0.25・0.75。
 */
export function quantile(xs: readonly number[], p: number): number | null {
  if (xs.length === 0) return null;
  const s = [...xs].sort((x, y) => x - y);
  const h = (s.length - 1) * p;
  const lo = Math.floor(h);
  const hi = Math.ceil(h);
  return s[lo]! + (h - lo) * (s[hi]! - s[lo]!);
}

/** 値の数・中央値・四分位・最小・最大（ms。小数第1位に丸める。値がなければ数のほかは null） */
export interface Summary {
  n: number;
  median: number | null;
  q1: number | null;
  q3: number | null;
  min: number | null;
  max: number | null;
}

const round1 = (v: number | null) => (v === null ? null : Math.round(v * 10) / 10);

export function summarize(xs: readonly number[]): Summary {
  return {
    n: xs.length,
    median: round1(quantile(xs, 0.5)),
    q1: round1(quantile(xs, 0.25)),
    q3: round1(quantile(xs, 0.75)),
    min: round1(quantile(xs, 0)),
    max: round1(quantile(xs, 1)),
  };
}

/**
 * i 組目（0 から）の開く順。偶数の組は A → B、奇数の組は B → A。先に開いた方が後の方に効くこと（DB や OS のキャッシュを温めるなど）
 * があっても、組の数が偶数なら両方に同じだけ乗る。
 */
export function pairOrder(i: number): readonly [Build, Build] {
  return i % 2 === 0 ? ['a', 'b'] : ['b', 'a'];
}

type Values = readonly (number | null | undefined)[];
const has = (v: number | null | undefined): v is number => typeof v === 'number' && Number.isFinite(v);

/** 組ごとの差（B − A。負なら B が速い）。どちらかが欠けた組（止まった・失敗した回）は除く */
export function pairedDiffs(a: Values, b: Values): number[] {
  const out: number[] = [];
  for (let i = 0; i < Math.max(a.length, b.length); i++) {
    const x = a[i];
    const y = b[i];
    if (has(x) && has(y)) out.push(y - x);
  }
  return out;
}

/**
 * 組ごとの「後に開いた方 − 先に開いた方」（pairOrder の順。偶数の組は B − A、奇数の組は A − B）。順の効き目の見張り
 * （A/A で 0 から大きく離れるなら、組の順を入れ替えないと差が偏る）。どちらかが欠けた組は除く
 */
export function orderEffects(a: Values, b: Values): number[] {
  const out: number[] = [];
  for (let i = 0; i < Math.max(a.length, b.length); i++) {
    const x = a[i];
    const y = b[i];
    if (!has(x) || !has(y)) continue;
    const [first] = pairOrder(i);
    out.push(first === 'a' ? y - x : x - y);
  }
  return out;
}

/** マス（配り方 × 開き方 × 画面）ごとの対の差（perf.json の results の diff と同じ形） */
export interface CellDiff {
  page: string;
  diff: Record<string, { values: readonly number[] }>;
}

/** 画面ごと・印ごとに、全部のマスの対の差を合わせた要約（PERF_AB の採る基準を画面で見るため。マスの並びの順） */
export interface PooledDiff extends Summary {
  page: string;
  mark: string;
  /** 合わせたマスの数 */
  cells: number;
  /** 差が負（B が速い）のマスの数（マスの中央値で数える） */
  cellsNegative: number;
}

export function poolDiffs(cells: readonly CellDiff[]): PooledDiff[] {
  const out = new Map<string, { page: string; mark: string; values: number[]; cells: number; cellsNegative: number }>();
  for (const c of cells) {
    for (const [mark, d] of Object.entries(c.diff)) {
      const key = `${c.page}\u0000${mark}`;
      const p = out.get(key) ?? { page: c.page, mark, values: [], cells: 0, cellsNegative: 0 };
      p.values.push(...d.values);
      p.cells += 1;
      const m = quantile(d.values, 0.5);
      if (m !== null && m < 0) p.cellsNegative += 1;
      out.set(key, p);
    }
  }
  return [...out.values()].map(({ values, ...p }) => ({ ...p, ...summarize(values) }));
}

/** 差の表し方（+12・−8・0。値がなければ —） */
export function signed(v: number | null): string {
  if (v === null) return '—';
  if (v === 0) return '0';
  return v > 0 ? `+${v}` : `−${-v}`;
}
