import { describe, expect, it } from 'vitest';
import { NAV_SECTIONS, normalizePath, routeFor } from '@/lib/navigation';
import { staticImportGraph } from '@/lib/testing/import-graph';
import { PORTAL_PROVIDERS } from './providers';
import { MODULES } from './registry';

describe('T16 機能の登録（MODULES）', () => {
  it('机椅子：名前は「机椅子」、入口は /furniture', () => {
    expect(MODULES[0]).toEqual({ id: 'furniture', label: '机椅子', homeHref: '/furniture' });
  });

  it('T17 お知らせ：名前は「お知らせ」、入口は /notices（机椅子の後。見出しとカードの並び）', () => {
    expect(MODULES[1]).toEqual({ id: 'notices', label: 'お知らせ', homeHref: '/notices' });
    expect(MODULES.map((m) => m.id).slice(0, 2)).toEqual(['furniture', 'notices']);
  });

  it('T18 締切と予定：名前は「締切と予定」（ダッシュボードの欄と同じ）、入口は /calendar（お知らせの後。最後に1行足した）', () => {
    expect(MODULES[2]).toEqual({ id: 'calendar', label: '締切と予定', homeHref: '/calendar' });
    expect(MODULES.map((m) => m.id).slice(0, 3)).toEqual(['furniture', 'notices', 'calendar']);
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

  it('入口（homeHref）は ROUTES にあり、その見出し（section）が機能の id で、ナビに出る', () => {
    for (const m of MODULES) {
      const r = routeFor(m.homeHref);
      expect(r?.href).toBe(m.homeHref);
      expect(r?.section).toBe(m.id);
      expect(r?.nav).toBe(true);
    }
  });

  it('ナビの機能の見出しは MODULES と同じ並び・同じ名前（ホームと共通の間）', () => {
    expect(NAV_SECTIONS[0]?.id).toBe('home');
    expect(NAV_SECTIONS.at(-1)?.id).toBe('common');
    expect(NAV_SECTIONS.slice(1, -1)).toEqual(MODULES.map((m) => ({ id: m.id, heading: m.label })));
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
    expect(g.files).toEqual([
      'lib/auth/membership.ts',
      'lib/auth/roles.ts',
      'lib/datetime-weekday.ts',
      'lib/datetime.ts',
      'lib/modules/portal.ts',
      'lib/modules/query-key.ts',
      'lib/modules/registry.ts',
    ]);
  });

  it('プロバイダと団体代表・総務のクエリは lib/data・画面の部品・振り分けと書き出しのパッケージを読まない（/ にスナップショット・検証を入れない）', () => {
    const g = staticImportGraph('lib/modules/providers.ts', 'lib/modules/furniture/rep.ts', 'lib/modules/furniture/soumu.ts');
    expect(g.files.filter((f) => f.startsWith('lib/data/') || f.startsWith('components/') || f.startsWith('app/'))).toEqual([]);
    expect(g.packages.filter((p) => /^(@gaapp\/(allocator|exporter|importer)|highs|react|react-dom|next)(\/|$)/.test(p))).toEqual([]);
    expect(g.files).toContain('lib/modules/furniture/portal.ts');
    expect(g.files).toContain('lib/modules/notices/portal.ts');
    expect(g.files).toContain('lib/modules/calendar/portal.ts');
    // T18：締切と予定の一覧の画面・組み立て・ダイアログの入力・一覧の読み書きはプロバイダから読まない
    for (const f of ['lib/modules/calendar/list.ts', 'lib/modules/calendar/permissions.ts', 'lib/data/calendar.ts', 'lib/schemas/calendar.ts']) {
      expect(g.files).not.toContain(f);
    }
  });

  it('T17・T18 PORTAL_PROVIDERS は 机椅子 → お知らせ → 締切と予定（MODULES と同じ並び）', () => {
    expect(PORTAL_PROVIDERS.map((p) => p.moduleId).slice(0, 3)).toEqual(['furniture', 'notices', 'calendar']);
  });

  it('T18 / の先読みにも使える締切と予定の欄の読み取り（calendar/dated.ts）は、組み立て・ダッシュボードの型と関数・ナビゲーション・日付の表示・一覧の画面を読まない', () => {
    const g = staticImportGraph('lib/modules/calendar/dated.ts');
    for (const f of [
      'lib/modules/calendar/portal.ts',
      'lib/modules/calendar/list.ts',
      'lib/modules/portal.ts',
      'lib/navigation.ts',
      'lib/datetime.ts',
      'lib/datetime-weekday.ts',
      'lib/data/calendar.ts',
      'lib/schemas/calendar.ts',
    ]) {
      expect(g.files).not.toContain(f);
    }
    expect(g.files.filter((f) => f.startsWith('lib/data/') || f.startsWith('components/') || f.startsWith('app/'))).toEqual([]);
    expect(g.files).toContain('lib/modules/query-key.ts');
    expect(g.packages.filter((p) => p.startsWith('@gaapp/') || p === 'zod')).toEqual([]);
  });

  it('T17 / の先読みが使うお知らせの新着（notices/latest.ts）は、並べ方・欄の組み立て・ダッシュボードの型と関数・ナビゲーション・一覧の画面を読まない', () => {
    const g = staticImportGraph('lib/modules/notices/latest.ts');
    for (const f of ['lib/modules/notices/portal.ts', 'lib/modules/portal.ts', 'lib/navigation.ts', 'lib/datetime.ts', 'lib/data/notices.ts', 'lib/schemas/notices.ts']) {
      expect(g.files).not.toContain(f);
    }
    expect(g.files.filter((f) => f.startsWith('lib/data/') || f.startsWith('components/') || f.startsWith('app/'))).toEqual([]);
    expect(g.files).toContain('lib/modules/query-key.ts');
    expect(g.packages.filter((p) => p.startsWith('@gaapp/') || p === 'zod')).toEqual([]);
  });

  it('T16 / の先読みが使う机椅子のクエリ（soumu.ts・rep.ts）は、数え方・要対応の組み立て・ダッシュボードの型と関数・ナビゲーションを読まない（ルートのレイアウトの JS を軽く）', () => {
    const g = staticImportGraph('lib/modules/furniture/rep.ts', 'lib/modules/furniture/soumu.ts');
    for (const f of ['lib/modules/furniture/portal.ts', 'lib/modules/furniture/counts.ts', 'lib/modules/portal.ts', 'lib/navigation.ts', 'lib/datetime.ts']) {
      expect(g.files).not.toContain(f);
    }
    expect(g.files).toContain('lib/modules/query-key.ts');
    expect(staticImportGraph('lib/modules/query-key.ts')).toEqual({ files: ['lib/modules/query-key.ts'], packages: [] });
    expect(g.packages.filter((p) => p.startsWith('@gaapp/'))).toEqual([]);
  });
});

describe('T20 シフト・作業（機能の登録・プロバイダ）', () => {
  it('名前は「シフト・作業」、入口は /shifts（締切と予定の後に1行足した）。プロバイダも同じ並び', () => {
    const k = MODULES.findIndex((m) => m.id === 'shifts');
    expect(MODULES[k]).toEqual({ id: 'shifts', label: 'シフト・作業', homeHref: '/shifts' });
    expect(MODULES[k - 1]?.id).toBe('calendar');
    const ids = PORTAL_PROVIDERS.map((p) => p.moduleId);
    expect(ids.indexOf('shifts')).toBe(ids.indexOf('calendar') + 1);
  });

  it('プロバイダ（providers.ts）からシフト表の組み立て・作業一覧の組み立て・書き込み・画面の部品を読まない', () => {
    const g = staticImportGraph('lib/modules/providers.ts');
    expect(g.files).toContain('lib/modules/shifts/portal.ts');
    for (const f of ['lib/modules/shifts/board.ts', 'lib/modules/shifts/my-shift.ts', 'lib/data/shifts.ts', 'lib/data/tasks.ts', 'lib/schemas/shifts.ts', 'lib/schemas/tasks.ts']) {
      expect(g.files).not.toContain(f);
    }
  });
});
