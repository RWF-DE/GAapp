// テント等の貸し出しの JS の置き場（T21。notes/T21.md「画面の約束」2・7、04「ダッシュボードに出すもの」の読み取り）：
// ダッシュボード（/）と申請（/request）の最初に読む JS に、/lending の表・CSV・受け渡し・返却の部品・/lending の読み書き・入力の zod を
// 入れない。申請のテント等のパネルと CSV は使うときに動的 import で読む（静的な import のグラフに入らない）。
import { describe, expect, it } from 'vitest';
import { staticImportGraph } from '@/lib/testing/import-graph';

const HEAVY = [
  'components/lending/lending-screen.tsx',
  'components/lending/items-table.tsx',
  'components/lending/item-dialog.tsx',
  'components/lending/assignments-table.tsx',
  'components/lending/confirm-actions.tsx',
  'components/lending/records-screen.tsx',
  'components/lending/records-list.tsx',
  'components/lending/records-panel.tsx',
  'components/lending/records-print.tsx',
  'components/lending/lending-request-panel.tsx',
  'lib/modules/lending/csv.ts',
  'lib/data/lending.ts',
  'lib/schemas/lending.ts',
];

describe('T21 テント等の JS の置き場', () => {
  it('ダッシュボード（/）はテント等のプロバイダ（数え方と組み立て）と読み取りだけを読む', () => {
    const g = staticImportGraph('app/(app)/page.tsx');
    expect(g.files.filter((f) => HEAVY.includes(f))).toEqual([]);
    expect(g.files).toContain('lib/modules/lending/portal.ts');
    expect(g.files).toContain('lib/modules/lending/summary.ts');
  });

  it('申請（/request）はタブ（request-tabs.tsx）と、タブを出すかを決める読み取りだけ。テント等のパネルは開いたときに読む', () => {
    const g = staticImportGraph('app/(app)/request/page.tsx');
    expect(g.files).toContain('components/lending/request-tabs.tsx');
    expect(g.files).toContain('lib/modules/lending/queries.ts');
    expect(g.files).toContain('components/requests/request-screen.tsx');
    expect(g.files.filter((f) => HEAVY.includes(f))).toEqual([]);
  });

  it('備品と割り当て（/lending）は CSV を押したときに読む', () => {
    const g = staticImportGraph('app/(app)/lending/page.tsx');
    expect(g.files).toContain('components/lending/lending-screen.tsx');
    expect(g.files).not.toContain('lib/modules/lending/csv.ts');
    expect(g.packages.filter((p) => p.startsWith('@gaapp/exporter') || p === 'exceljs')).toEqual([]);
  });
});
