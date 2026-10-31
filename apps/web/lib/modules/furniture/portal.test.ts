import { fixtureIndex, fixturePath, readFixtureDir } from '@gaapp/shared/testing';
import { QueryClient, QueryObserver } from '@tanstack/react-query';
import { describe, expect, it, vi } from 'vitest';
import type { Audience, GroupSummary, YearStatus } from '@/lib/auth/membership';
import type { AppRole } from '@/lib/auth/roles';
import { summarizeDashboard } from '@/lib/data/dashboard';
import type { Snapshot } from '@/lib/data/snapshot';
import { swapRows } from '@/lib/data/swaps';
import type { AllocationDbRow, ConsentDbRow, YearRow } from '@/lib/db/types';
import { AppError } from '@/lib/errors';
import { canOpen } from '@/lib/navigation';
import { createFakeSupabase, opArgs, type FakeCall } from '@/lib/testing/fake-supabase';
import { FIXTURE_UPDATED_AT, fixtureSnapshot } from '@/lib/testing/fixture-rows';
import { mergePortalSections, type PortalContext, type PortalKind, type PortalSection } from '../portal';
import { consentGroupCounts } from './counts';
import {
  FURNITURE_SOUMU_SELECT,
  furniturePortal,
  furniturePortalProvider,
  furnitureSoumuCounts,
  furnitureSoumuOptions,
  loadFurnitureSoumu,
  type FurnitureSoumuRaw,
} from './portal';
import { furnitureRepOptions, type RepHomeRows } from './rep';

const Y = '11111111-1111-4111-8111-111111111111';
const OPEN = '2026-09-20T00:00:00+00:00';
/** 10/5 17:00（Asia/Tokyo） */
const CLOSE = '2026-10-05T08:00:00+00:00';
const HOUR = 60 * 60 * 1000;
const DAY = 24 * HOUR;
const at = (iso: string) => Date.parse(iso);
/** 1日目 2026-10-17 の祭が終わる時刻（2日目の翌日 10/19 の 0 時。Asia/Tokyo） */
const FESTIVAL_OVER = at('2026-10-19T00:00:00+09:00');

const year = (status: YearStatus, over: Partial<YearRow> = {}): YearRow => ({
  id: Y,
  label: 'R8',
  status,
  allocation_version: 3,
  auto_allocated_at: null,
  festival_start: '2026-10-17',
  request_open_at: OPEN,
  request_close_at: CLOSE,
  prev_year_id: null,
  updated_at: 't',
  ...over,
});

const G1: GroupSummary = { id: 'g1', name: '模擬店01', year_id: Y, role: 'manager' };
const G2: GroupSummary = { id: 'g2', name: '模擬店02', year_id: Y, role: 'deputy_manager' };

function ctx(
  kind: PortalKind,
  y: YearRow,
  opts: { role?: AppRole | null; groups?: GroupSummary[]; now?: number; audiences?: Audience[] } = {},
): PortalContext {
  const role = opts.role ?? null;
  const groups = opts.groups ?? [];
  const audiences = opts.audiences ?? [...(role ? [role] : []), ...(groups.length > 0 ? (['rep'] as const) : [])];
  return { kind, year: y, role, groups, audiences, now: opts.now ?? at('2026-10-01T00:00:00Z') };
}

/** 未提出 1 団体（g2）・数えていない保管場所 1 か所（r2）・了承の依頼中 1 団体（g1） */
const RAW: FurnitureSoumuRaw = {
  groups: [
    { id: 'g2', name: '模擬店02', category: 'stall', sort_order: 2 },
    { id: 'g1', name: '模擬店01', category: 'stall', sort_order: 1 },
  ],
  submissions: [
    { group_id: 'g1', submitted_at: '2026-10-01T00:00:00Z' },
    { group_id: 'g2', submitted_at: null },
  ],
  rooms: [
    { id: 'r1', name: '1-1', is_storage: true, sort_order: 1 },
    { id: 'r2', name: '1-2', is_storage: true, sort_order: 2 },
    { id: 'gym', name: '体育館', is_storage: false, sort_order: 3 },
    { id: 'r4', name: '2-1', is_storage: true, sort_order: 4 },
  ],
  roomYears: [{ room_id: 'r4', usable: false }],
  stockRoomIds: ['r1'],
  consents: [
    { group_id: 'g1', status: 'asked' },
    { group_id: 'g2', status: 'accepted' },
  ],
};
const soumu = (raw: FurnitureSoumuRaw = RAW) => ({ kind: 'soumu' as const, ...raw });

const REP_ROWS: RepHomeRows = {
  submissions: [{ group_id: 'g1', submitted_at: '2026-10-01T00:00:00Z' }],
  consents: [
    { group_id: 'g2', status: 'asked' },
    { group_id: 'g1', status: 'accepted' },
  ],
};
const rep = (rows: RepHomeRows = REP_ROWS) => ({ kind: 'rep' as const, ...rows });

const ids = (s: PortalSection) => s.todos.map((t) => t.id);
const STATUSES: YearStatus[] = ['preparing', 'requesting', 'allocating', 'confirmed', 'closed'];

// ---------------------------------------------------------------- 数え方（summarizeDashboard と同じ）

const fx = readFixtureDir(fixturePath('synthetic', 'r8like'));
const ix = fixtureIndex(fx);
const desk = ix.itemId('desk');
const caster = ix.itemId('caster_desk');
const ADMIN = { audiences: ['admin'] as const };
const noIssues = { status: 'ok' as const, issues: [], problems: [] };

const toRaw = (s: Snapshot): FurnitureSoumuRaw => ({
  groups: s.groups.map(({ id, name, category, sort_order }) => ({ id, name, category, sort_order })),
  submissions: s.submissions.map(({ group_id, submitted_at }) => ({ group_id, submitted_at })),
  rooms: s.rooms.map(({ id, name, is_storage, sort_order }) => ({ id, name, is_storage, sort_order })),
  roomYears: s.roomYears.map(({ room_id, usable }) => ({ room_id, usable })),
  stockRoomIds: s.stocks.map((x) => x.room_id),
  consents: s.consents.map(({ group_id, status }) => ({ group_id, status })),
});

/** r8like：2団体の提出の記録を消し、1団体の submitted_at を空に。3つの保管場所（1つは使用不可）の在庫の行を消す */
function scenario(status: YearStatus, tables: Partial<Snapshot> = {}): Snapshot {
  const s = fixtureSnapshot(fx, { status });
  const dropped = new Set([ix.groupId('模擬店05'), ix.groupId('模擬店12')]);
  const nulled = ix.groupId('模擬店20');
  const unusable = fx.rooms.find((r) => r.isStorage && !r.usable)!.name;
  const gone = new Set(['1-1', '倉庫2', unusable].map((n) => ix.roomId(n)));
  return {
    ...s,
    submissions: s.submissions.filter((x) => !dropped.has(x.group_id)).map((x) => (x.group_id === nulled ? { ...x, submitted_at: null } : x)),
    stocks: s.stocks.filter((x) => !gone.has(x.room_id)),
    ...tables,
  };
}

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
const consent = (group: string, status: ConsentDbRow['status']): ConsentDbRow => ({
  group_id: ix.groupId(group),
  from_item_id: desk,
  to_item_id: caster,
  status,
  count: 2,
  note: null,
  updated_at: FIXTURE_UPDATED_AT,
});

describe('T16 机椅子のダッシュボードの数は机椅子の状況（summarizeDashboard）と同じ（r8like）', () => {
  it.each(STATUSES)('%s：提出・在庫の数、未提出・数えていない保管場所の並び、カードの行、要対応の N', (status) => {
    const s = scenario(status);
    const sum = summarizeDashboard(s, noIssues, ADMIN);
    const raw = toRaw(s);
    const c = furnitureSoumuCounts(raw);

    expect(sum.submissions.unsubmittedCount).toBe(4); // 3 団体＋元から未提出の1団体（並びが崩れていないことの前提）
    expect(c.submissions.submitted).toBe(sum.submissions.submitted);
    expect(c.submissions.total).toBe(sum.submissions.total);
    expect(c.submissions.unsubmitted.length).toBe(sum.submissions.unsubmittedCount);
    expect(c.submissions.unsubmitted.slice(0, 5).map((g) => g.id)).toEqual(sum.submissions.unsubmitted.map((g) => g.id));

    expect(sum.stocks.uncountedCount).toBe(2); // 使用不可の場所は数えない
    expect(c.storages.counted).toBe(sum.stocks.counted);
    expect(c.storages.total).toBe(sum.stocks.total);
    expect(c.storages.uncounted.length).toBe(sum.stocks.uncountedCount);
    expect(c.storages.uncounted.map((r) => r.id)).toEqual(sum.stocks.uncounted.map((r) => r.id));

    const out = furniturePortal(soumu(raw), ctx('soumu', s.year, { role: 'admin' }));
    expect(out.card?.lines.slice(1, 3)).toEqual([
      `申請 ${sum.submissions.submitted}／${sum.submissions.total} 団体が提出`,
      `在庫 ${sum.stocks.counted}／${sum.stocks.total} か所を数えた`,
    ]);
    const unsubmitted = out.todos.find((t) => t.id === 'furniture:soumu:unsubmitted');
    const uncounted = out.todos.find((t) => t.id === 'furniture:soumu:uncounted');
    expect(unsubmitted?.count).toBe(status === 'requesting' ? sum.submissions.unsubmittedCount : undefined);
    expect(uncounted?.count).toBe(status === 'preparing' || status === 'requesting' ? sum.stocks.uncountedCount : undefined);
  });

  it('了承の依頼中：どちらも consentGroupCounts で数え、入力だけが違う（置き換えのない依頼済みの組はダッシュボードだけが数える）', () => {
    const base = scenario('allocating', {
      allocations: [alloc('模擬店02', desk, caster, 3), alloc('模擬店03', desk, caster, 1)],
      consents: [consent('模擬店02', 'asked'), consent('模擬店03', 'accepted')],
    });
    // 依頼済み・了承の組がどれも今の置き換えを持てば、2つの画面の数は同じ
    const sum1 = summarizeDashboard(base, noIssues, ADMIN);
    const c1 = furnitureSoumuCounts(toRaw(base)).consents;
    expect(c1).toEqual({ groups: 2, notAsked: 0, asked: 1, accepted: 1, declined: 0 });
    expect(sum1.consents).toMatchObject(c1);

    // 置き換えのない依頼済みの組（模擬店07）を足すと、ダッシュボードだけが数える
    const more = { ...base, consents: [...base.consents, consent('模擬店07', 'asked')] };
    const sum2 = summarizeDashboard(more, noIssues, ADMIN);
    const c2 = furnitureSoumuCounts(toRaw(more)).consents;
    expect(sum2.consents.asked).toBe(1);
    expect(c2.asked).toBe(2);
    // 机椅子の状況は swapRows の今の置き換えがある行、ダッシュボードは了承の行を、同じ関数に渡す
    expect(sum2.consents).toMatchObject(consentGroupCounts(swapRows(more).filter((r) => r.current > 0)));
    expect(c2).toEqual(consentGroupCounts(more.consents.map((x) => ({ groupId: x.group_id, status: x.status }))));

    const out = furniturePortal(soumu(toRaw(more)), ctx('soumu', more.year, { role: 'head' }));
    expect(out.todos.find((t) => t.id === 'furniture:lead:consents-asked')).toMatchObject({
      title: 'キャスター机交換の了承の依頼中 2 団体',
      count: 2,
      href: '/swaps',
    });
    expect(out.card?.lines).toContain('了承の依頼中 2 団体');
  });
});

// ---------------------------------------------------------------- 総務：要対応とカード

/** 状態ごとに、どの要対応も出る年度と時刻 */
const CASES: { status: YearStatus; y: YearRow; now: number; lead: string[]; soumu: string[]; admin: string[] }[] = [
  {
    status: 'preparing',
    y: year('preparing', { request_open_at: null, request_close_at: null }),
    now: at('2026-09-01T00:00:00Z'),
    lead: ['furniture:lead:request-window'],
    soumu: ['furniture:soumu:uncounted'],
    admin: [],
  },
  {
    status: 'requesting',
    y: year('requesting'),
    now: at('2026-10-06T00:00:00Z'),
    lead: ['furniture:lead:close-requests'],
    soumu: ['furniture:soumu:unsubmitted', 'furniture:soumu:uncounted'],
    admin: [],
  },
  {
    status: 'allocating',
    y: year('allocating'),
    now: at('2026-10-08T00:00:00Z'),
    lead: ['furniture:lead:auto-allocate', 'furniture:lead:consents-asked'],
    soumu: [],
    admin: [],
  },
  {
    status: 'confirmed',
    y: year('confirmed', { auto_allocated_at: '2026-10-07T00:00:00Z' }),
    now: FESTIVAL_OVER,
    lead: [],
    soumu: [],
    admin: ['furniture:admin:close-year'],
  },
  { status: 'closed', y: year('closed'), now: at('2026-11-01T00:00:00Z'), lead: [], soumu: [], admin: [] },
];

describe('T16 机椅子の総務の要対応（段ごと）', () => {
  it.each(CASES)('$status：管理者は lead・soumu・admin、部門長・副部門長は lead・soumu、部門員は soumu だけ', (c) => {
    const expected: Record<string, string[]> = {
      admin: [...c.lead, ...c.soumu, ...c.admin],
      head: [...c.lead, ...c.soumu],
      deputy_head: [...c.lead, ...c.soumu],
      staff: [...c.soumu],
    };
    for (const role of ['admin', 'head', 'deputy_head', 'staff'] as const) {
      const k = ctx('soumu', c.y, { role, now: c.now });
      const out = furniturePortal(soumu(), k);
      expect(ids(out), role).toEqual(expected[role]);
      // 行き先はどれも今の立場で開ける
      for (const t of out.todos) expect(canOpen(t.href, k.audiences, c.y.status), `${role} ${t.href}`).toBe(true);
    }
  });

  it('管理者の要対応の中身（文・急ぎの度合い・期日・数・行き先）', () => {
    const todos = (c: (typeof CASES)[number]) => furniturePortal(soumu(), ctx('soumu', c.y, { role: 'admin', now: c.now })).todos;
    const [prep, req, allocating, confirmed] = CASES;
    const uncounted = {
      id: 'furniture:soumu:uncounted',
      moduleId: 'furniture',
      title: '在庫を数えていない保管場所 1 か所',
      count: 1,
      severity: 'normal',
      href: '/stocks',
    };
    expect(todos(prep!)).toEqual([
      {
        id: 'furniture:lead:request-window',
        moduleId: 'furniture',
        title: '申請の受付期間を入れてください（受付開始には未来の締切が要ります）',
        severity: 'normal',
        href: '/settings?tab=years',
      },
      uncounted,
    ]);
    expect(todos(req!)).toEqual([
      {
        id: 'furniture:lead:close-requests',
        moduleId: 'furniture',
        title: '申請の締切を過ぎました。「締切（振り分けを始める）」を押してください',
        severity: 'urgent',
        due: CLOSE,
        href: '/furniture',
      },
      { id: 'furniture:soumu:unsubmitted', moduleId: 'furniture', title: '未提出 1 団体', count: 1, severity: 'normal', due: CLOSE, href: '/requests?filter=unsubmitted' },
      uncounted,
    ]);
    expect(todos(allocating!)).toEqual([
      { id: 'furniture:lead:auto-allocate', moduleId: 'furniture', title: '自動振り分けをしてください', severity: 'normal', href: '/allocation' },
      { id: 'furniture:lead:consents-asked', moduleId: 'furniture', title: 'キャスター机交換の了承の依頼中 1 団体', count: 1, severity: 'normal', href: '/swaps' },
    ]);
    expect(todos(confirmed!)).toEqual([
      {
        id: 'furniture:admin:close-year',
        moduleId: 'furniture',
        title: '祭が終わりました。年度データと振り分け表を書き出して、年度を終了してください',
        severity: 'normal',
        href: '/furniture',
      },
    ]);
  });

  it('境目：受付期間が空か締切 ≤ 今の準備中、締切ちょうどの受付中、自動振り分けの有無、祭が終わる 0 時の前後', () => {
    const lead = (y: YearRow, now: number) => ids(furniturePortal(soumu(), ctx('soumu', y, { role: 'head', now })));
    const close = at(CLOSE);
    // 準備中：締切が空・締切 ≤ 今は受付期間を入れる。未来の締切なら出さない
    expect(lead(year('preparing', { request_close_at: null }), close)).toContain('furniture:lead:request-window');
    expect(lead(year('preparing'), close)).toContain('furniture:lead:request-window');
    expect(lead(year('preparing'), close - 1)).not.toContain('furniture:lead:request-window');
    // 受付中：締切ちょうどから。締切の前・締切が空なら出さない
    expect(lead(year('requesting'), close)).toContain('furniture:lead:close-requests');
    expect(lead(year('requesting'), close - 1)).not.toContain('furniture:lead:close-requests');
    expect(lead(year('requesting', { request_close_at: null }), close + DAY)).not.toContain('furniture:lead:close-requests');
    // 振り分け中：自動振り分けを保存したら出さない
    expect(lead(year('allocating', { auto_allocated_at: '2026-10-07T00:00:00Z' }), close + DAY)).not.toContain('furniture:lead:auto-allocate');
    // 確定中：2日目の翌日の 0 時（Asia/Tokyo）から、管理者だけ
    const admin = (now: number) => ids(furniturePortal(soumu(), ctx('soumu', year('confirmed'), { role: 'admin', now })));
    expect(admin(FESTIVAL_OVER - 1)).toEqual([]);
    expect(admin(FESTIVAL_OVER)).toEqual(['furniture:admin:close-year']);
    expect(lead(year('confirmed'), FESTIVAL_OVER + DAY)).toEqual([]);
    // 了承の依頼中がなければ出さない
    const noAsked = { ...RAW, consents: RAW.consents.filter((c) => c.status !== 'asked') };
    expect(ids(furniturePortal(soumu(noAsked), ctx('soumu', year('allocating'), { role: 'admin' })))).toEqual(['furniture:lead:auto-allocate']);
  });

  it('行き先を開けない立場には、段が合っても作らない（canOpen）', () => {
    // 段は部門長以上（role）でも、立場（audiences）が総務部門員だけなら、部門長以上の画面への要対応を作らない
    const prep = furniturePortal(soumu(), ctx('soumu', year('preparing', { request_close_at: null }), { role: 'admin', audiences: ['staff'] }));
    expect(ids(prep)).toEqual(['furniture:soumu:uncounted']); // /settings?tab=years は開けない
    const alloc = furniturePortal(soumu(), ctx('soumu', year('allocating'), { role: 'admin', audiences: ['staff'] }));
    expect(ids(alloc)).toEqual(['furniture:lead:auto-allocate']); // /swaps は開けない。/allocation は開ける
    // 立場がなければ、表にある画面への要対応はどれも作らない
    const none = furniturePortal(soumu(), ctx('soumu', year('requesting'), { role: 'admin', audiences: [], now: at('2026-10-01T00:00:00Z') }));
    expect(ids(none)).toEqual([]);
  });

  it('カード：年度の状態（受付中は締切つき）・提出・在庫・振り分け中の依頼中。机椅子の状況へのリンク', () => {
    const card = (y: YearRow) => furniturePortal(soumu(), ctx('soumu', y, { role: 'staff' })).card;
    expect(card(year('requesting'))).toEqual({
      moduleId: 'furniture',
      title: '机椅子',
      lines: ['申請受付中（締切 10/5 17:00）', '申請 1／2 団体が提出', '在庫 1／2 か所を数えた'],
      href: '/furniture',
      linkLabel: '机椅子の状況へ',
    });
    expect(card(year('requesting', { request_close_at: null }))?.lines[0]).toBe('申請受付中');
    expect(card(year('preparing'))?.lines[0]).toBe('準備中');
    expect(card(year('allocating'))?.lines).toEqual(['振り分け中', '申請 1／2 団体が提出', '在庫 1／2 か所を数えた', '了承の依頼中 1 団体']);
    expect(card(year('confirmed'))?.lines[0]).toBe('確定');
    expect(card(year('closed'))?.lines).toEqual(['終了', '申請 1／2 団体が提出', '在庫 1／2 か所を数えた']);
  });

  it('年度の行だけ（読み込み前）：カードはなく、年度の行で決まる要対応だけ', () => {
    const [prep, req] = CASES;
    const fromYear = (c: (typeof CASES)[number]) => furniturePortal(null, ctx('soumu', c.y, { role: 'admin', now: c.now }));
    expect(fromYear(prep!).card).toBeNull();
    expect(ids(fromYear(prep!))).toEqual(['furniture:lead:request-window']);
    expect(ids(fromYear(req!))).toEqual(['furniture:lead:close-requests']);
  });

  it('団体・保管場所がない年度：0／0 で、未提出・数えていない保管場所の要対応は出さない', () => {
    const empty: FurnitureSoumuRaw = { groups: [], submissions: [], rooms: [], roomYears: [], stockRoomIds: [], consents: [] };
    const out = furniturePortal(soumu(empty), ctx('soumu', year('requesting'), { role: 'admin', now: at('2026-10-01T00:00:00Z') }));
    expect(out.card?.lines).toEqual(['申請受付中（締切 10/5 17:00）', '申請 0／0 団体が提出', '在庫 0／0 か所を数えた']);
    expect(out.todos).toEqual([]);
  });

  it('終了した年度：どの段にも要対応を出さない', () => {
    for (const role of ['admin', 'head', 'deputy_head', 'staff'] as const) {
      for (const now of [at('2026-09-01T00:00:00Z'), FESTIVAL_OVER + DAY]) {
        expect(furniturePortal(soumu(), ctx('soumu', year('closed', { request_close_at: null }), { role, now })).todos).toEqual([]);
      }
    }
  });
});

// ---------------------------------------------------------------- 団体代表

describe('T16 机椅子の団体代表の要対応', () => {
  const repCtx = (y: YearRow, now: number, groups = [G1, G2]) => ctx('rep', y, { groups, now });
  const close = at(CLOSE);

  it('受付期間の中：未提出の団体に「申請が未提出です」（期日は締切）、依頼のある団体に「交換の依頼に答えてください」。団体の順。カードは出さない', () => {
    const out = furniturePortal(rep(), repCtx(year('requesting'), close - 2 * DAY));
    expect(out.card).toBeNull();
    expect(out.todos).toEqual([
      { id: 'furniture:rep:g2:unsubmitted', moduleId: 'furniture', title: '模擬店02：申請が未提出です', severity: 'normal', due: CLOSE, href: '/request?group=g2' },
      { id: 'furniture:rep:g2:consent', moduleId: 'furniture', title: '模擬店02：キャスター机への交換の依頼に答えてください', severity: 'normal', href: '/my?group=g2' },
    ]);
    // 団体が2つとも未提出なら、立場の一覧の団体の順
    const none = furniturePortal(rep({ submissions: [], consents: [] }), repCtx(year('requesting'), close - 2 * DAY));
    expect(ids(none)).toEqual(['furniture:rep:g1:unsubmitted', 'furniture:rep:g2:unsubmitted']);
  });

  it('締切まで 24 時間を切ったら急ぎ（ちょうど 24 時間はふつう）', () => {
    const sev = (now: number) => furniturePortal(rep(), repCtx(year('requesting'), now)).todos.find((t) => t.id.endsWith(':unsubmitted'))?.severity;
    expect(sev(close - DAY)).toBe('normal');
    expect(sev(close - DAY + 1)).toBe('urgent');
    expect(sev(close - 1)).toBe('urgent');
  });

  it('受付期間の外（締切の後・受付開始の前・締切が空・準備中・振り分け中）は未提出を出さない', () => {
    const unsubmitted = (y: YearRow, now: number) => ids(furniturePortal(rep(), repCtx(y, now))).filter((id) => id.endsWith(':unsubmitted'));
    expect(unsubmitted(year('requesting'), close)).toEqual([]);
    expect(unsubmitted(year('requesting'), at(OPEN) - 1)).toEqual([]);
    expect(unsubmitted(year('requesting', { request_open_at: null }), at(OPEN) - 1)).toEqual(['furniture:rep:g2:unsubmitted']);
    expect(unsubmitted(year('requesting', { request_close_at: null }), close - DAY)).toEqual([]);
    expect(unsubmitted(year('preparing'), close - DAY)).toEqual([]);
    expect(unsubmitted(year('allocating'), close + DAY)).toEqual([]);
  });

  it('確定中は団体ごとに「振り分けが決まりました」（お知らせ）で、交換の依頼は出さない。終了は何も出さない', () => {
    expect(furniturePortal(rep(), repCtx(year('confirmed'), close + 3 * DAY)).todos).toEqual([
      { id: 'furniture:rep:g1:final', moduleId: 'furniture', title: '模擬店01：振り分けが決まりました', severity: 'info', href: '/my?group=g1' },
      { id: 'furniture:rep:g2:final', moduleId: 'furniture', title: '模擬店02：振り分けが決まりました', severity: 'info', href: '/my?group=g2' },
    ]);
    expect(furniturePortal(rep(), repCtx(year('closed'), close + 30 * DAY)).todos).toEqual([]);
    expect(ids(furniturePortal(rep(), repCtx(year('allocating'), close + DAY)))).toEqual(['furniture:rep:g2:consent']);
  });

  it('年度の行だけ（読み込み前）は確定中のお知らせだけ。代表する団体がなければ何も出さない', () => {
    expect(ids(furniturePortal(null, repCtx(year('confirmed'), close + DAY)))).toEqual(['furniture:rep:g1:final', 'furniture:rep:g2:final']);
    expect(furniturePortal(null, repCtx(year('requesting'), close - DAY)).todos).toEqual([]);
    expect(furniturePortal(rep(), repCtx(year('requesting'), close - 2 * DAY, [])).todos).toEqual([]);
  });

  it('読んだ行にない団体（立場の一覧にない）の提出・依頼は使わない', () => {
    const other = rep({ submissions: [], consents: [{ group_id: 'other', status: 'asked' }] });
    expect(ids(furniturePortal(other, repCtx(year('allocating'), close + DAY)))).toEqual([]);
  });
});

// ---------------------------------------------------------------- 閲覧のみ

describe('T16 机椅子の閲覧のみ', () => {
  it.each(STATUSES)('%s：カード（確定・終了だけ振り分け表へ）。要対応はなく、読まない', (status) => {
    const k = ctx('viewer', year(status), { role: 'viewer' });
    const out = furniturePortal(null, k);
    const final = status === 'confirmed' || status === 'closed';
    expect(out.card).toEqual({
      moduleId: 'furniture',
      title: '机椅子',
      lines: [final ? '振り分けが決まりました' : '振り分けが確定すると、ここから見られます。'],
      href: final ? '/allocation' : null,
      linkLabel: '振り分け表を見る',
    });
    expect(out.todos).toEqual([]);
    expect(furniturePortalProvider.query!(k)).toBeNull();
  });
});

// ---------------------------------------------------------------- 締切と予定

describe('T16 机椅子の締切と予定', () => {
  it('受付開始・締切と、1日目からの4つの日（日付だけ。02 の festival_day）', () => {
    expect(furniturePortal(null, ctx('soumu', year('requesting'), { role: 'admin' })).dated).toEqual([
      { id: 'furniture:request-open', moduleId: 'furniture', title: '机椅子の申請の受付開始', at: OPEN, kind: 'event', href: '/requests' },
      { id: 'furniture:request-close', moduleId: 'furniture', title: '机椅子の申請の締切', at: CLOSE, kind: 'deadline', href: '/requests' },
      { id: 'furniture:day-minus2', moduleId: 'furniture', title: '前々日（机椅子の仕分け・配布）', at: '2026-10-15', kind: 'event' },
      { id: 'furniture:day-minus1', moduleId: 'furniture', title: '前日（机椅子の配布）', at: '2026-10-16', kind: 'event' },
      { id: 'furniture:day1', moduleId: 'furniture', title: '電波祭 1日目', at: '2026-10-17', kind: 'event' },
      { id: 'furniture:day2', moduleId: 'furniture', title: '電波祭 2日目', at: '2026-10-18', kind: 'event' },
    ]);
  });

  it('空の日時の項目は作らない（受付期間が空・1日目が読めない）', () => {
    const noWindow = furniturePortal(null, ctx('soumu', year('preparing', { request_open_at: null, request_close_at: null }), { role: 'admin' }));
    expect(noWindow.dated.map((d) => d.id)).toEqual(['furniture:day-minus2', 'furniture:day-minus1', 'furniture:day1', 'furniture:day2']);
    const noDay = furniturePortal(null, ctx('viewer', year('requesting', { festival_start: '' }), { role: 'viewer' }));
    expect(noDay.dated.map((d) => d.id)).toEqual(['furniture:request-open', 'furniture:request-close']);
  });

  it('1日目からの日付の足し引きは月・年の境目と閏年もそのまま', () => {
    const days = (festival_start: string) =>
      furniturePortal(null, ctx('viewer', year('requesting', { festival_start }), { role: 'viewer' }))
        .dated.filter((d) => d.id.startsWith('furniture:day'))
        .map((d) => d.at);
    expect(days('2027-03-01')).toEqual(['2027-02-27', '2027-02-28', '2027-03-01', '2027-03-02']);
    expect(days('2028-03-01')).toEqual(['2028-02-28', '2028-02-29', '2028-03-01', '2028-03-02']);
    expect(days('2027-01-01')).toEqual(['2026-12-30', '2026-12-31', '2027-01-01', '2027-01-02']);
    expect(days('2026-12-31')).toEqual(['2026-12-29', '2026-12-30', '2026-12-31', '2027-01-01']);
  });

  it('受付期間のリンクは立場全体で決める：総務は申請一覧、団体代表は申請、閲覧のみはなし。兼ねた人はどの種類でも同じ中身', () => {
    const href = (k: PortalContext) =>
      furniturePortal(null, k)
        .dated.filter((d) => d.id.startsWith('furniture:request-'))
        .map((d) => d.href);
    const y = year('requesting');
    expect(href(ctx('soumu', y, { role: 'staff' }))).toEqual(['/requests', '/requests']);
    expect(href(ctx('rep', y, { groups: [G1] }))).toEqual(['/request', '/request']);
    expect(href(ctx('viewer', y, { role: 'viewer' }))).toEqual([undefined, undefined]);
    expect(furniturePortal(null, ctx('viewer', y, { role: 'viewer' })).dated.every((d) => !('href' in d))).toBe(true);
    expect(href(ctx('viewer', y, { role: 'viewer', groups: [G1] }))).toEqual(['/request', '/request']);
    // 管理者で店長も務める人：総務と団体代表の種類で、締切と予定は同じ中身
    const asSoumu = furniturePortal(null, ctx('soumu', y, { role: 'admin', groups: [G1] })).dated;
    const asRep = furniturePortal(null, ctx('rep', y, { role: 'admin', groups: [G1] })).dated;
    expect(asRep).toEqual(asSoumu);
    expect(asSoumu[0]?.href).toBe('/requests');
  });
});

// ---------------------------------------------------------------- 純粋・fromYear と query の関係

describe('T16 furniturePortal の約束', () => {
  const everyCtx = (): { k: PortalContext; raw: Parameters<typeof furniturePortal>[0] }[] =>
    CASES.flatMap((c) => [
      ...(['admin', 'head', 'staff'] as const).map((role) => ({ k: ctx('soumu', c.y, { role, now: c.now }), raw: soumu() })),
      { k: ctx('viewer', c.y, { role: 'viewer', now: c.now }), raw: null },
      { k: ctx('rep', c.y, { groups: [G1, G2], now: c.now }), raw: rep() },
    ]);

  it('年度の行だけの分（fromYear）は、読んだ後の結果（query の select）にすべて入っている', () => {
    for (const { k, raw } of everyCtx()) {
      const from = furniturePortal(null, k);
      const full = furniturePortal(raw, k);
      for (const t of from.todos) expect(full.todos).toContainEqual(t);
      expect(full.dated).toEqual(from.dated);
      if (from.card) expect(full.card).toEqual(from.card);
    }
  });

  it('純粋：同じ入力で同じ出力。時計を読まない（ctx.now だけ）', () => {
    vi.useFakeTimers();
    try {
      vi.setSystemTime(new Date('2000-01-01T00:00:00Z'));
      const a = everyCtx().map(({ k, raw }) => furniturePortal(raw, k));
      vi.setSystemTime(new Date('2100-01-01T00:00:00Z'));
      const b = everyCtx().map(({ k, raw }) => furniturePortal(raw, k));
      expect(b).toEqual(a);
    } finally {
      vi.useRealTimers();
    }
  });

  it('読んだ行の種類と立場の種類が違えば例外（つなぎ間違い）', () => {
    expect(() => furniturePortal(rep(), ctx('soumu', year('requesting'), { role: 'admin' }))).toThrow();
  });

  it('管理者で店長も務める人：総務と団体代表の要対応がそろい、締切と予定は1回ずつ（mergePortalSections）', () => {
    const y = year('requesting');
    const now = at(CLOSE) - 2 * DAY;
    const parts = (['soumu', 'rep'] as const).map((kind) => {
      const k = ctx(kind, y, { role: 'admin', groups: [G2], now });
      return { moduleId: 'furniture' as const, kind, section: furniturePortal(kind === 'soumu' ? soumu() : rep(), k) };
    });
    const [merged] = mergePortalSections(parts);
    expect(merged?.todos.map((t) => t.id)).toEqual([
      'furniture:soumu:unsubmitted',
      'furniture:soumu:uncounted',
      'furniture:rep:g2:unsubmitted',
      'furniture:rep:g2:consent',
    ]);
    expect(merged?.dated.map((d) => d.id)).toEqual(parts[0]!.section.dated.map((d) => d.id));
    expect(merged?.card?.linkLabel).toBe('机椅子の状況へ');
  });
});

// ---------------------------------------------------------------- 読み取り

/** 偽のクライアントが返す行（join の列つき） */
function rowsFor(call: FakeCall): unknown[] {
  switch (call.table) {
    case 'groups':
      return [{ id: 'g1', name: '模擬店01', category: 'stall', sort_order: 1 }];
    case 'request_submissions':
      return [{ group_id: 'g1', submitted_at: '2026-10-01T00:00:00Z', groups: { year_id: Y } }];
    case 'rooms':
      return [{ id: 'r1', name: '1-1', is_storage: true, sort_order: 1 }];
    case 'room_years':
      return [{ room_id: 'r1', usable: true }];
    case 'stocks':
      return [{ room_id: 'r1' }, { room_id: 'r1' }, { room_id: 'r2' }];
    case 'substitution_consents':
      return [{ group_id: 'g1', status: 'asked', groups: { year_id: Y } }];
    default:
      throw new Error(`読まない表：${call.table}`);
  }
}

describe('T16 loadFurnitureSoumu（総務の軽い読み取り）', () => {
  it('6つの表を年度で絞って読む。版（years）・振り分けの行・ルール・申請の行・品目・距離は読まない', async () => {
    const { client, issued } = createFakeSupabase((call) => ({ data: rowsFor(call) }));
    const raw = await loadFurnitureSoumu(Y, client);
    expect(issued.map((c) => c.table).sort()).toEqual(['groups', 'request_submissions', 'room_years', 'rooms', 'stocks', 'substitution_consents']);
    const call = (t: string) => issued.find((c) => c.table === t)!;
    for (const [table, select] of Object.entries(FURNITURE_SOUMU_SELECT)) expect(opArgs(call(table), 'select'), table).toEqual([[select]]);
    expect(FURNITURE_SOUMU_SELECT).toEqual({
      groups: 'id, name, category, sort_order',
      request_submissions: 'group_id, submitted_at, groups!inner(year_id)',
      rooms: 'id, name, is_storage, sort_order',
      room_years: 'room_id, usable',
      stocks: 'room_id',
      substitution_consents: 'group_id, status, groups!inner(year_id)',
    });
    expect(opArgs(call('groups'), 'eq')).toEqual([['year_id', Y]]);
    expect(opArgs(call('request_submissions'), 'eq')).toEqual([['groups.year_id', Y]]);
    expect(opArgs(call('rooms'), 'eq')).toEqual([]); // 年度をまたぐ表
    expect(opArgs(call('room_years'), 'eq')).toEqual([['year_id', Y]]);
    expect(opArgs(call('stocks'), 'eq')).toEqual([['year_id', Y]]);
    expect(opArgs(call('stocks'), 'range')).toEqual([[0, 999]]);
    expect(opArgs(call('substitution_consents'), 'eq')).toEqual([['groups.year_id', Y]]);

    // join の列を外し、在庫の場所は重ねない
    expect(raw).toEqual({
      groups: [{ id: 'g1', name: '模擬店01', category: 'stall', sort_order: 1 }],
      submissions: [{ group_id: 'g1', submitted_at: '2026-10-01T00:00:00Z' }],
      rooms: [{ id: 'r1', name: '1-1', is_storage: true, sort_order: 1 }],
      roomYears: [{ room_id: 'r1', usable: true }],
      stockRoomIds: ['r1', 'r2'],
      consents: [{ group_id: 'g1', status: 'asked' }],
    });
  });

  it('在庫の行が 1000 を超えれば続きのページを読む', async () => {
    const { client, issued } = createFakeSupabase((call) => {
      if (call.table !== 'stocks') return { data: [] };
      const [[from]] = opArgs(call, 'range') as [[number, number]];
      return { data: from === 0 ? Array.from({ length: 1000 }, (_, k) => ({ room_id: `r${k % 3}` })) : [{ room_id: 'r9' }] };
    });
    const raw = await loadFurnitureSoumu(Y, client);
    expect(issued.filter((c) => c.table === 'stocks').map((c) => opArgs(c, 'range')[0])).toEqual([
      [0, 999],
      [1000, 1999],
    ]);
    expect(raw.stockRoomIds).toEqual(['r0', 'r1', 'r2', 'r9']);
  });

  it('読み取りの失敗は AppError（欄がその機能の分だけ失敗を出す）', async () => {
    const { client } = createFakeSupabase((call) => (call.table === 'rooms' ? { error: { code: '42501', message: 'denied' }, status: 403 } : { data: [] }));
    await expect(loadFurnitureSoumu(Y, client)).rejects.toBeInstanceOf(AppError);
  });
});

// ---------------------------------------------------------------- プロバイダとクエリ

describe('T16 furniturePortalProvider', () => {
  it('種類・fromYear・query のキー（総務・団体代表。閲覧のみは読まない）', () => {
    const p = furniturePortalProvider;
    expect(p.moduleId).toBe('furniture');
    expect(p.kinds).toEqual(['soumu', 'viewer', 'rep']);
    const k = ctx('soumu', year('requesting'), { role: 'admin' });
    expect(p.fromYear!(k)).toEqual(furniturePortal(null, k));
    expect(p.query!(k)?.queryKey).toEqual(['year', Y, 'portal', 'furniture', 'soumu']);
    expect(p.query!(k)?.queryKey).toEqual(furnitureSoumuOptions(Y).queryKey);
    expect(p.query!(ctx('rep', year('requesting'), { groups: [G1, G2] }))?.queryKey).toEqual(['year', Y, 'portal', 'furniture', 'rep', 'g1', 'g2']);
    expect(p.query!(ctx('viewer', year('confirmed'), { role: 'viewer' }))).toBeNull();
  });

  it('select は読んだ行から furniturePortal を作る。団体代表は代表する団体の欄（furnitureRepOptions）と同じキャッシュを読む', () => {
    const qc = new QueryClient({ defaultOptions: { queries: { staleTime: Infinity } } });
    const s = ctx('soumu', year('allocating'), { role: 'head' });
    const r = ctx('rep', year('requesting'), { groups: [G1, G2], now: at(CLOSE) - 2 * DAY });
    qc.setQueryData(furnitureSoumuOptions(Y).queryKey, RAW);
    qc.setQueryData(furnitureRepOptions(Y, ['g1', 'g2']).queryKey, REP_ROWS);
    const data = (k: PortalContext) => new QueryObserver(qc, furniturePortalProvider.query!(k)!).getCurrentResult().data;
    expect(data(s)).toEqual(furniturePortal(soumu(), s));
    expect(data(r)).toEqual(furniturePortal(rep(), r));
    expect(data(r)?.todos.map((t) => t.id)).toEqual(['furniture:rep:g2:unsubmitted', 'furniture:rep:g2:consent']);
  });
});
