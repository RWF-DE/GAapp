import { describe, expect, it } from 'vitest';
import { normalizePath } from '@/lib/navigation';
import { staticImportGraph } from '@/lib/testing/import-graph';
import { PORTAL_PROVIDERS } from './providers';
import { MODULES } from './registry';

describe('T16 機能の登録（MODULES）', () => {
  it('机椅子：名前は「机椅子」、入口は /furniture', () => {
    expect(MODULES[0]).toEqual({ id: 'furniture', label: '机椅子', homeHref: '/furniture' });
  });

  it('id は英字の小文字で重ならない。名前も重ならない', () => {
    const ids = MODULES.map((m) => m.id);
    for (const id of ids) expect(id).toMatch(/^[a-z]+$/);
    expect(new Set(ids).size).toBe(ids.length);
    expect(new Set(MODULES.map((m) => m.label)).size).toBe(MODULES.length);
  });

  it('入口はパスだけ（/ で始まり、クエリ・末尾の / がない。静的書き出しのページ）', () => {
    for (const m of MODULES) {
      expect(m.homeHref).toMatch(/^\/[a-z]/);
      expect(normalizePath(m.homeHref)).toBe(m.homeHref);
    }
  });

  it('PORTAL_PROVIDERS は登録にある機能を1つずつ、登録の順に並べる', () => {
    const ids = PORTAL_PROVIDERS.map((p) => p.moduleId);
    const registered: string[] = MODULES.map((m) => m.id);
    expect(new Set(ids).size).toBe(ids.length);
    for (const id of ids) expect(registered).toContain(id);
    expect(ids).toEqual(registered.filter((id) => (ids as string[]).includes(id)));
    for (const p of PORTAL_PROVIDERS) expect(p.kinds.length).toBeGreaterThan(0);
  });
});

describe('T16 lib/modules の import（ナビと / の JS を軽くする。D-51・D-52）', () => {
  it('registry.ts は何も import しない（lib/navigation.ts が読む）', () => {
    expect(staticImportGraph('lib/modules/registry.ts')).toEqual({ files: ['lib/modules/registry.ts'], packages: [] });
  });

  it('portal.ts（型と小さな関数）は React・Supabase・TanStack・lib/data を実行時に読まない', () => {
    const g = staticImportGraph('lib/modules/portal.ts');
    expect(g.packages).toEqual([]);
    expect(g.files).toEqual(['lib/auth/membership.ts', 'lib/auth/roles.ts', 'lib/datetime.ts', 'lib/modules/portal.ts', 'lib/modules/registry.ts']);
  });

  it('プロバイダと団体代表のクエリは lib/data・画面の部品・振り分けと書き出しのパッケージを読まない（/ にスナップショット・検証を入れない）', () => {
    const g = staticImportGraph('lib/modules/providers.ts', 'lib/modules/furniture/rep.ts');
    expect(g.files.filter((f) => f.startsWith('lib/data/') || f.startsWith('components/') || f.startsWith('app/'))).toEqual([]);
    expect(g.packages.filter((p) => /^(@gaapp\/(allocator|exporter|importer)|highs|react|react-dom|next)(\/|$)/.test(p))).toEqual([]);
    expect(g.files).toContain('lib/modules/furniture/portal.ts');
  });
});
