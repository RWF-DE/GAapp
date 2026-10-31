// お知らせのプロバイダと新着の読み取り（04「お知らせ一覧」の「ダッシュボードに出すもの」、notes/T17.md「後半（画面）の約束」6。T17）
import { describe, expect, it } from 'vitest';
import type { GroupSummary, Membership } from '@/lib/auth/membership';
import type { AppRole } from '@/lib/auth/roles';
import type { YearRow } from '@/lib/db/types';
import { AppError } from '@/lib/errors';
import { PORTAL_NOTICE_LIMIT, PORTAL_WIDGETS, portalContextsOf, portalWidgetQuery, type PortalContext, type PortalSection } from '@/lib/modules/portal';
import { createFakeSupabase, opArgs } from '@/lib/testing/fake-supabase';
import { loadLatestNotices, NOTICES_LATEST_LIMIT, NOTICES_LATEST_SELECT, noticesLatestOptions } from './latest';
import { noticeDigests, noticesPortalProvider } from './portal';

const Y = '11111111-1111-4111-8111-111111111111';
const year = { id: Y, label: 'R8', status: 'requesting', festival_start: '2026-10-17' } as unknown as YearRow;
const G1: GroupSummary = { id: 'g1', name: '模擬店01', year_id: Y, role: 'manager' };
const G2: GroupSummary = { id: 'g2', name: '模擬店02', year_id: Y, role: 'deputy_manager' };

function member(role: AppRole | null, groups: GroupSummary[] = []): Membership {
  const y = { id: Y, label: 'R8', status: 'requesting' as const, festival_start: '2026-10-17' };
  return { displayName: null, year: y, role, groups, years: [y], latestYear: y, adminOfOpenYear: false };
}
const ctxOf = (m: Membership, kind: PortalContext['kind']) => portalContextsOf(m, year, 0).find((c) => c.kind === kind)!;

const ROWS = [
  { id: 'n1', audience: 'soumu' as const, title: '総務の連絡', pinned: false, created_at: '2026-10-01T00:00:00Z' },
  { id: 'n2', audience: 'all_groups' as const, title: '全団体へ', pinned: true, created_at: '2026-10-02T00:00:00Z' },
];

describe('T17 noticesPortalProvider（お知らせのプロバイダ）', () => {
  it('機能は notices、種類は総務・閲覧のみ・団体代表。読み取りの結果を使う欄は総務内のお知らせとお知らせだけ。年度の行だけで決まる項目はない', () => {
    expect(noticesPortalProvider.moduleId).toBe('notices');
    expect(noticesPortalProvider.kinds).toEqual(['soumu', 'viewer', 'rep']);
    expect(noticesPortalProvider.query?.widgets).toEqual(['soumuNotices', 'notices']);
    expect(noticesPortalProvider.fromYear).toBeUndefined();
  });

  it('種類ごとのキー：総務は総務内、閲覧のみは団体あて、団体代表は団体あて（団体の id つき）', () => {
    const q = noticesPortalProvider.query!;
    expect(q.options(ctxOf(member('staff'), 'soumu'))?.queryKey).toEqual(['year', Y, 'portal', 'notices', 'soumu']);
    expect(q.options(ctxOf(member('viewer'), 'viewer'))?.queryKey).toEqual(['year', Y, 'portal', 'notices', 'viewer']);
    expect(q.options(ctxOf(member(null, [G1, G2]), 'rep'))?.queryKey).toEqual(['year', Y, 'portal', 'notices', 'rep', 'g1', 'g2']);
    // 店長・副店長も務める管理者の団体代表の分は、管理者として読める団体あて（キーは団体代表の形）
    expect(q.options(ctxOf(member('admin', [G1]), 'rep'))?.queryKey).toEqual(['year', Y, 'portal', 'notices', 'rep', 'g1']);
  });

  it('閲覧のみで店長も務める人の団体代表の分は読まない（閲覧のみとして読む分と同じ結果）', () => {
    const m = member('viewer', [G1]);
    expect(noticesPortalProvider.query!.options(ctxOf(m, 'rep'))).toBeNull();
    expect(noticesPortalProvider.query!.options(ctxOf(m, 'viewer'))).not.toBeNull();
  });

  it('キーは / の先読み（noticesLatestOptions）と同じ', () => {
    const q = noticesPortalProvider.query!;
    expect(q.options(ctxOf(member('head'), 'soumu'))?.queryKey).toEqual(noticesLatestOptions(Y, 'soumu').queryKey);
    // 団体の id は立場の一覧の順（ここでは G2・G1 の順に渡した）
    expect(q.options(ctxOf(member(null, [G2, G1]), 'rep'))?.queryKey).toEqual(noticesLatestOptions(Y, 'rep', ['g2', 'g1']).queryKey);
  });

  it('select の結果はお知らせの欄の分だけ（カード・要対応・締切と予定はない）。1件の行き先は /notices?notice=<id>', () => {
    const opts = noticesPortalProvider.query!.options(ctxOf(member('staff'), 'soumu'))!;
    const section = (opts.select as (raw: unknown) => PortalSection)(ROWS);
    expect(section).toEqual({
      card: null,
      todos: [],
      dated: [],
      notices: [
        { id: 'n1', moduleId: 'notices', title: '総務の連絡', at: '2026-10-01T00:00:00Z', pinned: false, audience: 'soumu', href: '/notices?notice=n1' },
        { id: 'n2', moduleId: 'notices', title: '全団体へ', at: '2026-10-02T00:00:00Z', pinned: true, audience: 'all_groups', href: '/notices?notice=n2' },
      ],
    });
    expect(noticeDigests([])).toEqual([]);
  });

  it('要対応・締切と予定・カードの欄には並べない（お知らせの読み込み中・失敗をその欄に出さない）', () => {
    for (const m of [member('admin', [G1]), member('viewer'), member(null, [G1])]) {
      for (const ctx of portalContextsOf(m, year, 0)) {
        for (const w of PORTAL_WIDGETS) {
          const q = portalWidgetQuery(noticesPortalProvider, ctx, w);
          if (w === 'todos' || w === 'dated' || w === 'cards') expect(q, `${ctx.kind}・${w}`).toBeNull();
        }
      }
    }
  });
});

describe('T17 loadLatestNotices（新着の読み取り）', () => {
  it('総務内：year_id と audience = soumu で絞り、pinned desc・created_at desc・id の順に 5 件。読むのは id・宛先・題名・ピン留め・出した日時だけ', async () => {
    const { client, issued } = createFakeSupabase(() => ({ data: ROWS }));
    expect(await loadLatestNotices(Y, 'soumu', client)).toEqual(ROWS);
    expect(issued).toHaveLength(1);
    const c = issued[0]!;
    expect(c.table).toBe('notices');
    expect(opArgs(c, 'select')).toEqual([[NOTICES_LATEST_SELECT]]);
    expect(NOTICES_LATEST_SELECT).toBe('id, audience, title, pinned, created_at');
    expect(opArgs(c, 'eq')).toEqual([
      ['year_id', Y],
      ['audience', 'soumu'],
    ]);
    expect(opArgs(c, 'in')).toEqual([]);
    expect(opArgs(c, 'order')).toEqual([['pinned', { ascending: false }], ['created_at', { ascending: false }], ['id']]);
    expect(opArgs(c, 'limit')).toEqual([[5]]);
  });

  it('団体あて：audience を名前で並べて絞る（全団体・指定の団体。総務内を否定で書かない）。本文・宛先の団体・書いた人は読まない', async () => {
    const { client, issued } = createFakeSupabase(() => ({ data: [] }));
    expect(await loadLatestNotices(Y, 'groups', client)).toEqual([]);
    const c = issued[0]!;
    expect(opArgs(c, 'in')).toEqual([['audience', ['all_groups', 'groups']]]);
    expect(opArgs(c, 'eq')).toEqual([['year_id', Y]]);
    expect(opArgs(c, 'neq')).toEqual([]);
    const select = String(opArgs(c, 'select')[0]![0]);
    for (const col of ['body', 'notice_groups', 'created_by', 'profiles']) expect(select).not.toContain(col);
    expect(issued.map((x) => x.table)).toEqual(['notices']);
  });

  it('読めなければ AppError を投げる（欄が失敗ともう一度を出す）', async () => {
    const { client } = createFakeSupabase(() => ({ error: { code: '42501', message: 'denied' }, status: 403 }));
    await expect(loadLatestNotices(Y, 'groups', client)).rejects.toBeInstanceOf(AppError);
  });

  it('件数は欄に出す数（PORTAL_NOTICE_LIMIT）と同じ', () => {
    expect(NOTICES_LATEST_LIMIT).toBe(PORTAL_NOTICE_LIMIT);
  });

  it('キー：soumu・viewer は団体の id を付けない。rep は団体の id を立場の一覧の順に付ける', () => {
    expect(noticesLatestOptions(Y, 'soumu', ['g1']).queryKey).toEqual(['year', Y, 'portal', 'notices', 'soumu']);
    expect(noticesLatestOptions(Y, 'viewer', ['g1']).queryKey).toEqual(['year', Y, 'portal', 'notices', 'viewer']);
    expect(noticesLatestOptions(Y, 'rep', ['g2', 'g1']).queryKey).toEqual(['year', Y, 'portal', 'notices', 'rep', 'g2', 'g1']);
  });
});
