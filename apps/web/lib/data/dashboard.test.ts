import { compareBySortOrder, type Issue } from '@gaapp/shared';
import { fixtureIndex, fixturePath, readFixtureDir } from '@gaapp/shared/testing';
import { describe, expect, it } from 'vitest';
import type { YearStatus } from '@/lib/auth/membership';
import type { AllocationDbRow, ConsentDbRow } from '@/lib/db/types';
import { FIXTURE_UPDATED_AT, fixtureSnapshot } from '@/lib/testing/fixture-rows';
import { DASHBOARD_LIST_LIMIT, repGroupCards, requestWindowOpen, summarizeDashboard, topIssueCodes } from './dashboard';
import type { Snapshot } from './snapshot';
import { runValidation, type ValidationResult } from './validation';
import { toStoredRows, toYearData } from './year-data';

const fx = readFixtureDir(fixturePath('synthetic', 'r8like'));
const ix = fixtureIndex(fx);
const desk = ix.itemId('desk');
const caster = ix.itemId('caster_desk');
const ADMIN = { audiences: ['admin'] as const };
const STAFF = { audiences: ['staff'] as const };

const snap = (status: YearStatus = 'allocating', tables: Partial<Snapshot> = {}): Snapshot => ({
  ...fixtureSnapshot(fx, { status }),
  ...tables,
});

const validated = (s: Snapshot): ValidationResult => runValidation(toYearData(s), toStoredRows(s).rows, s.version);
const noIssues: Pick<ValidationResult, 'status' | 'issues' | 'problems'> = { status: 'ok', issues: [], problems: [] };
const issue = (code: Issue['code'], severity: Issue['severity']): Issue => ({ code, severity, message: code, refs: {} });

let n = 0;
const alloc = (group: string, requested: string, item: string, count: number): AllocationDbRow => ({
  id: `00000000-0000-4000-8000-${String(++n).padStart(12, '0')}`,
  year_id: 'y',
  source_room_id: ix.roomId('1-1'),
  group_id: ix.groupId(group),
  item_id: item,
  requested_item_id: requested,
  count,
  is_keep: false,
  origin: 'auto',
  pinned: false,
  note: null,
  updated_at: FIXTURE_UPDATED_AT,
});
const consent = (group: string, status: ConsentDbRow['status'], count: number | null): ConsentDbRow => ({
  group_id: ix.groupId(group),
  from_item_id: desk,
  to_item_id: caster,
  status,
  count,
  note: null,
  updated_at: FIXTURE_UPDATED_AT,
});

describe('summarizeDashboard：申請', () => {
  it('提出した団体の数／団体の数と、区分ごとの内訳（団体のない区分は出さない）', () => {
    const s = snap('requesting');
    const sum = summarizeDashboard(s, noIssues, ADMIN);
    const submitted = fx.groups.filter((g) => g.submittedAt !== null);
    expect(sum.submissions.total).toBe(fx.groups.length);
    expect(sum.submissions.submitted).toBe(submitted.length);
    expect(sum.submissions.byCategory.reduce((a, c) => a + c.total, 0)).toBe(fx.groups.length);
    expect(sum.submissions.byCategory.reduce((a, c) => a + c.submitted, 0)).toBe(submitted.length);
    expect(sum.submissions.byCategory[0]).toMatchObject({ category: 'stall', label: '模擬店' });
    for (const c of sum.submissions.byCategory) expect(c.total).toBeGreaterThan(0);
  });

  it('未提出の団体は団体の並びで5件まで、件数は全部。submitted_at が null の行は未提出', () => {
    const s = snap('requesting');
    const sorted = s.groups.map((g) => ({ id: g.id, name: g.name, sortOrder: g.sort_order })).sort(compareBySortOrder);
    // 並びの最後の7団体を未提出にする（1つは submitted_at が null の行、6つは行なし）
    const late = sorted.slice(-7);
    const lateIds = new Set(late.map((g) => g.id));
    const submissions = s.submissions
      .filter((x) => !lateIds.has(x.group_id) || x.group_id === late[0]!.id)
      .map((x) => (x.group_id === late[0]!.id ? { ...x, submitted_at: null } : x));
    const others = s.groups.filter((g) => !lateIds.has(g.id) && !s.submissions.some((x) => x.group_id === g.id && x.submitted_at));
    const sum = summarizeDashboard({ ...s, submissions }, noIssues, ADMIN);
    expect(sum.submissions.unsubmittedCount).toBe(7 + others.length);
    expect(sum.submissions.unsubmitted).toHaveLength(DASHBOARD_LIST_LIMIT);
    const expected = sorted.filter((g) => lateIds.has(g.id) || others.some((o) => o.id === g.id)).slice(0, DASHBOARD_LIST_LIMIT);
    expect(sum.submissions.unsubmitted.map((g) => g.name)).toEqual(expected.map((g) => g.name));
    expect(sum.submissions.unsubmittedHref).toBe('/requests?filter=unsubmitted');
  });
});

describe('summarizeDashboard：在庫', () => {
  it('数えた保管場所の数／保管場所の数は使用不可の部屋を除く。まだ数えていない場所は在庫入力へのリンクつき', () => {
    const s = snap('requesting');
    const storages = fx.rooms.filter((r) => r.isStorage && r.usable);
    const first = storages[0]!;
    const stocks = s.stocks.filter((x) => x.room_id !== ix.roomId(first.name));
    const sum = summarizeDashboard({ ...s, stocks }, noIssues, STAFF);
    expect(sum.stocks.total).toBe(storages.length);
    const counted = new Set(fx.stocks.map((x) => x.room));
    const uncounted = storages.filter((r) => r.name === first.name || !counted.has(r.name));
    expect(sum.stocks.counted).toBe(storages.length - uncounted.length);
    expect(sum.stocks.uncountedCount).toBe(uncounted.length);
    expect(sum.stocks.uncounted[0]).toEqual({ id: ix.roomId(first.name), name: first.name, href: `/stock?room=${ix.roomId(first.name)}` });

    // 使用不可にすると数から外れる
    const roomYears = [...s.roomYears, { year_id: s.year.id, room_id: ix.roomId(first.name), usable: false, note: null, updated_at: FIXTURE_UPDATED_AT }];
    const sum2 = summarizeDashboard({ ...s, stocks, roomYears }, noIssues, STAFF);
    expect(sum2.stocks.total).toBe(storages.length - 1);
    expect(sum2.stocks.uncounted.map((r) => r.name)).not.toContain(first.name);
  });

  it('validate の W104 と同じ場所を数えていないとする', () => {
    const s = snap('allocating');
    const stocks = s.stocks.filter((x) => x.room_id !== ix.roomId('1-1') && x.room_id !== ix.roomId('1-2'));
    const t = { ...s, stocks };
    const v = validated(t);
    const w104 = v.issues.filter((i) => i.code === 'W104').map((i) => i.refs.roomId);
    const sum = summarizeDashboard(t, v, ADMIN);
    expect(sum.stocks.uncountedCount).toBe(w104.length);
    expect(new Set(sum.stocks.uncounted.map((r) => r.id))).toEqual(new Set(w104.slice(0, DASHBOARD_LIST_LIMIT)));
  });
});

describe('summarizeDashboard：検証', () => {
  const issues = [issue('E003', 'error'), issue('E003', 'error'), issue('W104', 'warning'), issue('W102', 'warning'), issue('W102', 'warning'), issue('W102', 'warning'), issue('I201', 'info')];

  it.each(['preparing', 'requesting'] as const)('%s は振り分け前（渡された issues を数えない）', (status) => {
    const sum = summarizeDashboard(snap(status), { status: 'ok', issues, problems: [] }, ADMIN);
    expect(sum.validation).toMatchObject({ phase: 'before', errors: 0, warnings: 0, infos: 0, topCodes: [] });
  });

  it.each(['allocating', 'confirmed'] as const)('%s は error・warning・info の件数と多いコード', (status) => {
    const sum = summarizeDashboard(snap(status), { status: 'ok', issues, problems: [] }, ADMIN);
    expect(sum.validation).toMatchObject({ phase: 'ok', errors: 2, warnings: 4, infos: 1, href: '/allocation' });
    expect(sum.validation.topCodes).toEqual([
      { code: 'W102', severity: 'warning', count: 3 },
      { code: 'E003', severity: 'error', count: 2 },
      { code: 'W104', severity: 'warning', count: 1 },
      { code: 'I201', severity: 'info', count: 1 },
    ]);
  });

  it('入力の誤りで検証できないときは unavailable、終了した年度は closed', () => {
    const problems = [{ path: 'rules.S05', message: '団体がありません', ruleCode: 'S05' }];
    expect(summarizeDashboard(snap('allocating'), { status: 'unavailable', issues: [], problems }, ADMIN).validation.phase).toBe('unavailable');
    expect(summarizeDashboard(snap('closed'), { status: 'ok', issues, problems: [] }, ADMIN).validation).toMatchObject({ phase: 'closed', errors: 0 });
  });

  it('topIssueCodes：同じ件数なら error → warning → info、コードの順。上限で切る', () => {
    const top = topIssueCodes([issue('W105', 'warning'), issue('E001', 'error'), issue('I201', 'info'), issue('W101', 'warning')], 3);
    expect(top.map((c) => c.code)).toEqual(['E001', 'W101', 'W105']);
  });

  it('壊れたルール（参照の切れたルール）は入力の誤りに出て、admin はルールの画面へ', () => {
    const s = snap('allocating');
    const rules = s.rules.map((r) => (r.code === 'S05' ? { ...r, params: { ...(r.params as object), group: '00000000-0000-4000-8000-ffffffffffff' } } : r));
    const t = { ...s, rules };
    const v = validated(t);
    const admin = summarizeDashboard(t, v, ADMIN);
    expect(admin.problems.length).toBeGreaterThan(0);
    expect(admin.problems.find((p) => p.ruleCode === 'S05')?.href).toBe('/rules?code=S05');
    const staff = summarizeDashboard(t, v, STAFF);
    expect(staff.problems.find((p) => p.ruleCode === 'S05')?.href).toBeNull();
  });
});

describe('summarizeDashboard：了承', () => {
  it('/swaps と同じ数え方で、状況ごと・依頼し直し・再実行の団体の数。置き換えのない了承の行は数えない', () => {
    const s = snap('allocating', {
      allocations: [
        alloc('模擬店01', desk, caster, 2), // 未依頼
        alloc('模擬店02', desk, caster, 3), // 依頼済み（依頼の後に増えた）
        alloc('模擬店03', desk, caster, 1), // 了承
        alloc('模擬店04', desk, caster, 2), // 拒否（再実行が要る）
        alloc('模擬店05', desk, desk, 4), // 置き換えでない
      ],
      consents: [
        consent('模擬店02', 'asked', 2),
        consent('模擬店03', 'accepted', 1),
        consent('模擬店04', 'declined', 2),
        consent('模擬店06', 'accepted', 2), // 置き換えがもうない
      ],
    });
    const sum = summarizeDashboard(s, noIssues, ADMIN);
    expect(sum.consents).toEqual({ groups: 4, notAsked: 1, asked: 1, accepted: 1, declined: 1, reask: 1, rerun: 1, href: '/swaps' });
  });

  it('了承の後に増えた（W102）も依頼し直しに数える', () => {
    const s = snap('allocating', { allocations: [alloc('模擬店03', desk, caster, 3)], consents: [consent('模擬店03', 'accepted', 1)] });
    expect(summarizeDashboard(s, noIssues, ADMIN).consents).toMatchObject({ groups: 1, accepted: 1, reask: 1 });
  });
});

describe('summarizeDashboard：部員に開けない画面へのリンクを出さない', () => {
  it('staff：キャスター机交換・ルール・マスタ設定は null、申請一覧・在庫入力・振り分けはリンク', () => {
    const s = snap('allocating', { stocks: [] });
    const problems = [
      { path: 'rules.S05', message: 'ルール S05 の設定に誤りがあります', ruleCode: 'S05' },
      { path: 'distance', message: '建物が空です' },
    ];
    const sum = summarizeDashboard(s, { status: 'unavailable', issues: [], problems }, STAFF);
    expect(sum.consents.href).toBeNull();
    expect(sum.problems.map((p) => p.href)).toEqual([null, null]);
    expect(sum.submissions.unsubmittedHref).toBe('/requests?filter=unsubmitted');
    expect(sum.stocks.uncounted.every((r) => r.href?.startsWith('/stock?room='))).toBe(true);
    expect(sum.validation.href).toBe('/allocation');

    expect(sum.submissions.emptyHref).toBeNull();
    expect(sum.stocks.emptyHref).toBeNull();

    const hrefs = JSON.stringify(sum).match(/"\/[a-z]+[^"]*"/g) ?? [];
    for (const h of hrefs) expect(h).not.toMatch(/^"\/(swaps|rules|settings|history)/);
  });

  it('admin：同じ入力で全部のリンクが出る', () => {
    const problems = [
      { path: 'rules.S05', message: 'x', ruleCode: 'S05' },
      { path: 'distance', message: 'y' },
    ];
    const sum = summarizeDashboard(snap('allocating'), { status: 'unavailable', issues: [], problems }, ADMIN);
    expect(sum.consents.href).toBe('/swaps');
    expect(sum.problems.map((p) => p.href)).toEqual(['/rules?code=S05', '/settings']);
    // 団体・保管場所がないときの「マスタ設定の団体へ」「マスタ設定の場所へ」
    expect(sum.submissions.emptyHref).toBe('/settings?tab=groups');
    expect(sum.stocks.emptyHref).toBe('/settings?tab=rooms');
  });

  it('総務部門長・総務副部門長：キャスター机交換・ルール・マスタ設定（場所）へのリンクは出し、団体のタブ（管理者だけ）へは出さない（D-50）', () => {
    const problems = [
      { path: 'rules.S05', message: 'x', ruleCode: 'S05' },
      { path: 'distance', message: 'y' },
    ];
    for (const role of ['head', 'deputy_head'] as const) {
      const sum = summarizeDashboard(snap('allocating'), { status: 'unavailable', issues: [], problems }, { audiences: [role] });
      expect(sum.consents.href).toBe('/swaps');
      expect(sum.problems.map((p) => p.href)).toEqual(['/rules?code=S05', '/settings']);
      expect(sum.submissions.emptyHref).toBeNull();
      expect(sum.stocks.emptyHref).toBe('/settings?tab=rooms');
      expect(sum.validation.href).toBe('/allocation');
    }
  });
});

describe('repGroupCards', () => {
  const groups = [
    { id: 'g1', name: '模擬店01' },
    { id: 'g2', name: '模擬店02' },
  ];
  it('提出の日時・依頼の有無・確定後か', () => {
    const cards = repGroupCards(
      {
        groups,
        submissions: [
          { group_id: 'g1', submitted_at: '2026-10-05T09:01:00+00:00' },
          { group_id: 'g2', submitted_at: null },
        ],
        consents: [
          { group_id: 'g2', status: 'asked' },
          { group_id: 'g1', status: 'accepted' },
        ],
      },
      'allocating',
    );
    expect(cards).toEqual([
      { groupId: 'g1', name: '模擬店01', submittedAt: '2026-10-05T09:01:00+00:00', consentAsked: false, final: false },
      { groupId: 'g2', name: '模擬店02', submittedAt: null, consentAsked: true, final: false },
    ]);
    expect(repGroupCards({ groups, submissions: [], consents: [] }, 'confirmed').every((c) => c.final)).toBe(true);
    expect(repGroupCards({ groups, submissions: [], consents: [] }, 'closed').every((c) => c.final)).toBe(true);
  });
});

describe('requestWindowOpen', () => {
  const now = Date.parse('2026-10-05T00:00:00Z');
  const y = (status: YearStatus, open: string | null, close: string | null) => ({ status, request_open_at: open, request_close_at: close });
  it('受付中・受付開始が null か過ぎた・締切の前のときだけ真', () => {
    expect(requestWindowOpen(y('requesting', null, '2026-10-06T00:00:00Z'), now)).toBe(true);
    expect(requestWindowOpen(y('requesting', '2026-10-01T00:00:00Z', '2026-10-06T00:00:00Z'), now)).toBe(true);
    expect(requestWindowOpen(y('requesting', '2026-10-05T00:00:01Z', '2026-10-06T00:00:00Z'), now)).toBe(false);
    expect(requestWindowOpen(y('requesting', null, '2026-10-05T00:00:00Z'), now)).toBe(false);
    expect(requestWindowOpen(y('requesting', null, null), now)).toBe(false);
    expect(requestWindowOpen(y('allocating', null, '2026-10-06T00:00:00Z'), now)).toBe(false);
  });
});
