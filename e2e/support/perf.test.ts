// 4G の速さの計測の集計と交互の順（e2e/support/perf.ts。FU3）。ブラウザにも DB にもつながない。
import { describe, expect, it } from 'vitest';
import { orderEffects, pairedDiffs, pairOrder, poolDiffs, quantile, signed, summarize, type CellDiff } from './perf';

describe('quantile（R の type 7）', () => {
  it('偶数の数の中央値は真ん中の2つの平均、四分位は線形に補う', () => {
    expect(quantile([4, 1, 3, 2], 0.5)).toBe(2.5);
    expect(quantile([4, 1, 3, 2], 0.25)).toBe(1.75);
    expect(quantile([4, 1, 3, 2], 0.75)).toBe(3.25);
  });

  it('奇数の数の中央値は真ん中の値（並べ替えてから選ぶ）', () => {
    expect(quantile([2900, 2800, 2844], 0.5)).toBe(2844);
  });

  it('1つなら どの分位もその値、空なら null', () => {
    expect(quantile([5], 0.25)).toBe(5);
    expect(quantile([5], 0.75)).toBe(5);
    expect(quantile([], 0.5)).toBeNull();
  });

  it('呼び手の配列を並べ替えない', () => {
    const xs = [3, 1, 2];
    quantile(xs, 0.5);
    expect(xs).toEqual([3, 1, 2]);
  });
});

describe('summarize', () => {
  it('数・中央値・四分位・最小・最大を返す', () => {
    expect(summarize([-40, 10, -12, 30, -6, 8])).toEqual({ n: 6, median: 1, q1: -10.5, q3: 9.5, min: -40, max: 30 });
  });

  it('小数第1位に丸める', () => {
    expect(summarize([0, 1 / 3]).median).toBe(0.2);
  });

  it('空なら数のほかは null', () => {
    expect(summarize([])).toEqual({ n: 0, median: null, q1: null, q3: null, min: null, max: null });
  });
});

describe('pairOrder', () => {
  it('偶数の組は A → B、奇数の組は B → A', () => {
    expect([0, 1, 2, 3].map(pairOrder)).toEqual([
      ['a', 'b'],
      ['b', 'a'],
      ['a', 'b'],
      ['b', 'a'],
    ]);
  });

  it('組の数が偶数なら、A と B が先になる数は同じ', () => {
    const firsts = Array.from({ length: 12 }, (_, i) => pairOrder(i)[0]);
    expect(firsts.filter((x) => x === 'a')).toHaveLength(6);
    expect(firsts.filter((x) => x === 'b')).toHaveLength(6);
  });
});

describe('pairedDiffs（B − A）', () => {
  it('同じ組の B − A を並べる（負なら B が速い）', () => {
    expect(pairedDiffs([2000, 2100, 1900], [1950, 2150, 1900])).toEqual([-50, 50, 0]);
  });

  it('どちらかが欠けた組（止まった・失敗した回）は除く', () => {
    expect(pairedDiffs([2000, null, 1900, 2000], [1950, 2150, undefined, 2010])).toEqual([-50, 10]);
    expect(pairedDiffs([2000, 2100], [1950])).toEqual([-50]);
  });
});

describe('orderEffects（後に開いた方 − 先に開いた方）', () => {
  it('偶数の組は B − A、奇数の組は A − B', () => {
    // 0 組目：A → B（後の B が 30 速い）、1 組目：B → A（後の A が 20 遅い）
    expect(orderEffects([2000, 2000], [1970, 1980])).toEqual([-30, 20]);
  });

  it('A と B が同じ速さでも、2回目が必ず速い機械なら、どの組も負になる（差は 0 の前後に残る）', () => {
    const a = [2000, 1950, 2000, 1950];
    const b = [1950, 2000, 1950, 2000];
    expect(orderEffects(a, b)).toEqual([-50, -50, -50, -50]);
    expect(summarize(pairedDiffs(a, b)).median).toBe(0);
  });

  it('欠けた組は除く', () => {
    expect(orderEffects([2000, null, 2000], [1970, 1980, null])).toEqual([-30]);
  });
});

describe('poolDiffs（画面ごと・印ごとに全部のマスを合わせる）', () => {
  it('同じ画面のマスの対の差を印ごとに合わせ、マスの数と、中央値が負のマスの数を数える（画面・印は最初に出た順）', () => {
    const cells: CellDiff[] = [
      { page: '/（総務部門員）', diff: { shown: { values: [-100, -60, 20] }, frame: { values: [-10, 0, 10] } } },
      { page: '/stock', diff: { shown: { values: [5, -5] } } },
      { page: '/（総務部門員）', diff: { shown: { values: [-40, 30, 50] }, frame: { values: [-30, -20, -10] } } },
    ];
    expect(poolDiffs(cells)).toEqual([
      { page: '/（総務部門員）', mark: 'shown', cells: 2, cellsNegative: 1, n: 6, median: -10, q1: -55, q3: 27.5, min: -100, max: 50 },
      { page: '/（総務部門員）', mark: 'frame', cells: 2, cellsNegative: 1, n: 6, median: -10, q1: -17.5, q3: -2.5, min: -30, max: 10 },
      { page: '/stock', mark: 'shown', cells: 1, cellsNegative: 0, n: 2, median: 0, q1: -2.5, q3: 2.5, min: -5, max: 5 },
    ]);
  });

  it('組のないマス（止まって飛ばしたマス）は数えるが、値は足さない', () => {
    expect(poolDiffs([{ page: '/my', diff: { shown: { values: [] } } }, { page: '/my', diff: { shown: { values: [-20] } } }])).toEqual([
      { page: '/my', mark: 'shown', cells: 2, cellsNegative: 1, n: 1, median: -20, q1: -20, q3: -20, min: -20, max: -20 },
    ]);
  });
});

describe('signed', () => {
  it('符号をつけて表す（負は全角の −）', () => {
    expect([12, -8, 0, -12.5, null].map(signed)).toEqual(['+12', '−8', '0', '−12.5', '—']);
  });
});
