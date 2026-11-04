// テント等の貸し出しの JS の置き場（T21。notes/T21.md「画面の約束」2・7、04「ダッシュボードに出すもの」の読み取り）：
// - ダッシュボード（/）の最初に読む JS に、/lending の表・CSV・受け渡し・返却の部品・/lending の読み書き・入力の zod と、申請のテント等の
//   パネルを入れない。
// - 申請（/request）の最初に読む JS には、申請のテント等のパネル（とその読み書き・入力の zod）を入れる（FU3 の PR B の案 4。T21 の
//   「確認したいこと」の 11 の (b)：`?tab=lending` で開いたとき、立場が届いた後にパネルの JS を待たない）。/lending の表・CSV・受け渡し・
//   返却の部品は入れない。
// - CSV は使うときに動的 import で読む（静的な import のグラフに入らない）。
import { describe, expect, it } from 'vitest';
import { staticImportGraph } from '@/lib/testing/import-graph';

/** /lending・/lending/records の部品と CSV（/ にも /request にも入れない） */
const LENDING_SCREENS = [
  'components/lending/lending-screen.tsx',
  'components/lending/items-table.tsx',
  'components/lending/item-dialog.tsx',
  'components/lending/assignments-table.tsx',
  'components/lending/confirm-actions.tsx',
  'components/lending/records-screen.tsx',
  'components/lending/records-list.tsx',
  'components/lending/records-panel.tsx',
  'components/lending/records-print.tsx',
  'lib/modules/lending/csv.ts',
];
/** 申請のテント等のパネル（/request の最初に読む JS に入れる） */
const REQUEST_PANEL = 'components/lending/lending-request-panel.tsx';
/** / に入れないもの：上の部品と CSV、申請のテント等のパネル、/lending の読み書き、入力の zod */
const NOT_ON_HOME = [...LENDING_SCREENS, REQUEST_PANEL, 'lib/data/lending.ts', 'lib/schemas/lending.ts'];

describe('T21 テント等の JS の置き場', () => {
  it('ダッシュボード（/）はテント等のプロバイダ（数え方と組み立て）と読み取りだけを読む', () => {
    const g = staticImportGraph('app/(app)/page.tsx');
    expect(g.files.filter((f) => NOT_ON_HOME.includes(f))).toEqual([]);
    expect(g.files).toContain('lib/modules/lending/portal.ts');
    expect(g.files).toContain('lib/modules/lending/summary.ts');
  });

  it('申請（/request）は、タブ・タブを出すかを決める読み取りと、テント等のパネルを最初に読む JS に入れる（FU3 の案 4）。/lending の表・CSV・受け渡し・返却の部品は入れない', () => {
    const g = staticImportGraph('app/(app)/request/page.tsx');
    expect(g.files).toContain('components/lending/request-tabs.tsx');
    expect(g.files).toContain('lib/modules/lending/queries.ts');
    expect(g.files).toContain('components/requests/request-screen.tsx');
    expect(g.files).toContain(REQUEST_PANEL);
    expect(g.files.filter((f) => LENDING_SCREENS.includes(f))).toEqual([]);
  });

  it('備品と割り当て（/lending）は CSV を押したときに読む', () => {
    const g = staticImportGraph('app/(app)/lending/page.tsx');
    expect(g.files).toContain('components/lending/lending-screen.tsx');
    expect(g.files).not.toContain('lib/modules/lending/csv.ts');
    expect(g.packages.filter((p) => p.startsWith('@gaapp/exporter') || p === 'exceljs')).toEqual([]);
  });
});
