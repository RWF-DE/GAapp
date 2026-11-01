// テント等の貸し出しがダッシュボードに出すもの（T21・D-57。notes/T21.md「画面の約束」7）：立場（総務・閲覧のみ・店長・副店長・兼ねた人）
// ごとのカードと要対応、段（部門長以上と部門員）、年度の状態（準備中・受付中の締切の前後・振り分け中・確定・終了）、canOpen、id と並び、
// カードの3行目の「未返却 K 団体」と要対応が2日目の 0 時（Asia/Tokyo）の前後で出し分かれること、祭の後の急ぎ、読み取り（select と絞り方）。
import { describe, expect, it } from 'vitest';
import type { Audience, GroupSummary, YearStatus } from '@/lib/auth/membership';
import type { AppRole } from '@/lib/auth/roles';
import type { YearRow } from '@/lib/db/types';
import { canOpen } from '@/lib/navigation';
import { createFakeSupabase, opArgs, type FakeCall } from '@/lib/testing/fake-supabase';
import { mergePortalSections, portalWidgetQuery, type PortalContext, type PortalKind } from '../portal';
import {
  LENDING_CONFIRM_TODO,
  LENDING_NO_ITEMS_CARD_TEXT,
  LENDING_NO_ITEMS_TODO,
  LENDING_VIEWER_CARD_TEXT,
  lendingPortal,
  lendingPortalProvider,
} from './portal';
import { LENDING_REP_SELECT, LENDING_SOUMU_SELECT, lendingRepOptions, lendingSoumuOptions, loadLendingRep, loadLendingSoumu, type LendingRepRaw, type LendingSoumuRaw } from './summary';

const Y = '11111111-1111-4111-8111-111111111111';
/** 10/5 17:00（Asia/Tokyo） */
const CLOSE = '2026-10-05T08:00:00Z';
const at = (iso: string) => Date.parse(iso);
const BEFORE_CLOSE = at('2026-10-01T00:00:00Z');
const AFTER_CLOSE = at('2026-10-06T00:00:00Z');
/** 1日目 2026-10-17。2日目の 0 時と祭の後（2日後の 0 時）は Asia/Tokyo */
const DAY1 = at('2026-10-17T12:00:00+09:00');
const DAY2 = at('2026-10-18T00:00:00+09:00');
const OVER = at('2026-10-19T00:00:00+09:00');

const year = (status: YearStatus, over: Partial<YearRow> = {}): YearRow => ({
  id: Y,
  label: 'R8',
  status,
  allocation_version: 3,
  auto_allocated_at: null,
  festival_start: '2026-10-17',
  request_open_at: '2026-09-20T00:00:00Z',
  request_close_at: CLOSE,
  prev_year_id: null,
  updated_at: 't',
  ...over,
});

const G1: GroupSummary = { id: 'g1', name: '模擬店01', year_id: Y, role: 'manager' };
const G2: GroupSummary = { id: 'g2', name: '模擬店02', year_id: Y, role: 'deputy_manager' };

function ctx(kind: PortalKind, y: YearRow, opts: { role?: AppRole | null; groups?: GroupSummary[]; now?: number; audiences?: Audience[] } = {}): PortalContext {
  const role = opts.role ?? null;
  const groups = opts.groups ?? [];
  const audiences = opts.audiences ?? [...(role ? [role] : []), ...(groups.length > 0 ? (['rep'] as const) : [])];
  return { kind, year: y, role, groups, audiences, now: opts.now ?? BEFORE_CLOSE };
}

const TENT = { id: 'i-tent', name: 'テント', unit: '張', stock: 3, sort_order: 1 };
const WEIGHT = { id: 'i-weight', name: '重し', unit: '個', stock: 20, sort_order: 2 };

/** テントは申請 4（g1・g2 が 2 ずつ）・割り当て 2（g1 だけ。g2 は未入力）／在庫 3。重しは g1 に 8 */
const RAW: LendingSoumuRaw = {
  confirmedAt: null,
  items: [WEIGHT, TENT],
  requests: [
    { group_id: 'g1', lending_item_id: TENT.id, count: 2 },
    { group_id: 'g2', lending_item_id: TENT.id, count: 2 },
    { group_id: 'g1', lending_item_id: WEIGHT.id, count: 8 },
  ],
  assignments: [
    { group_id: 'g1', lending_item_id: TENT.id, count: 2 },
    { group_id: 'g1', lending_item_id: WEIGHT.id, count: 8 },
  ],
  records: [],
};
const soumu = (raw: LendingSoumuRaw = RAW) => ({ kind: 'soumu' as const, ...raw });
const ids = (todos: readonly { id: string }[]) => todos.map((t) => t.id);

describe('T21 総務のカード', () => {
  it('備品がなければ「貸し出す備品がまだ登録されていません」だけ。リンクは「備品と割り当てへ」（/lending）', () => {
    const s = lendingPortal(soumu({ ...RAW, items: [], requests: [], assignments: [] }), ctx('soumu', year('preparing'), { role: 'staff' }));
    expect(s.card).toEqual({
      moduleId: 'lending',
      title: 'テント等の貸し出し',
      lines: [LENDING_NO_ITEMS_CARD_TEXT],
      href: '/lending',
      linkLabel: '備品と割り当てへ',
    });
  });

  it('確定前：「割り当て：確定前（在庫を超える備品 N）」（割り当て＋未入力の申請 > 在庫）と「申請 N 団体・割り当て N 団体」', () => {
    const s = lendingPortal(soumu(), ctx('soumu', year('requesting'), { role: 'head' }));
    expect(s.card?.lines).toEqual(['割り当て：確定前（在庫を超える備品 1）', '申請 2 団体・割り当て 1 団体']);
    // 未入力を割り当てると（g2 に 1。合計 3 = 在庫）、超えていない
    const fixed = soumu({ ...RAW, assignments: [...RAW.assignments, { group_id: 'g2', lending_item_id: TENT.id, count: 1 }] });
    expect(lendingPortal(fixed, ctx('soumu', year('requesting'), { role: 'head' })).card?.lines[0]).toBe('割り当て：確定前');
  });

  it('確定後：「割り当て：確定（10/12 17:00）」と「渡した N／M 団体」、2日目からは「・未返却 K 団体」を足す（2日目の 0 時の前後）', () => {
    const raw = soumu({
      ...RAW,
      confirmedAt: '2026-10-12T08:00:00Z',
      assignments: [...RAW.assignments, { group_id: 'g2', lending_item_id: TENT.id, count: 1 }],
      records: [
        { group_id: 'g1', lending_item_id: TENT.id, lent_count: 2, returned_count: 1 },
        { group_id: 'g2', lending_item_id: TENT.id, lent_count: 0, returned_count: 0 },
      ],
    });
    const before = lendingPortal(raw, ctx('soumu', year('confirmed'), { role: 'staff', now: DAY2 - 1 }));
    expect(before.card?.lines).toEqual(['割り当て：確定（10/12 17:00）', '申請 2 団体・割り当て 2 団体', '渡した 1／2 団体']);
    const day2 = lendingPortal(raw, ctx('soumu', year('confirmed'), { role: 'staff', now: DAY2 }));
    expect(day2.card?.lines[2]).toBe('渡した 1／2 団体・未返却 1 団体');
  });

  it('閲覧のみ：「割り当てが確定すると、ここから見られます」（年度の行だけ。何も読まない）と /lending へのリンク', () => {
    const c = ctx('viewer', year('requesting'), { role: 'viewer' });
    expect(lendingPortal(null, c)).toEqual({
      card: { moduleId: 'lending', title: 'テント等の貸し出し', lines: [LENDING_VIEWER_CARD_TEXT], href: '/lending', linkLabel: '備品と割り当てへ' },
      todos: [],
      dated: [],
    });
    expect(lendingPortalProvider.query!.options(c)).toBeNull();
    expect(lendingPortalProvider.fromYear!(c).card?.lines).toEqual([LENDING_VIEWER_CARD_TEXT]);
  });

  it('読み込み前（raw が null）の総務・店長・副店長は何も出さない（年度の行だけで決まるものがない）', () => {
    expect(lendingPortal(null, ctx('soumu', year('requesting'), { role: 'head' }))).toEqual({ card: null, todos: [], dated: [] });
    expect(lendingPortal(null, ctx('rep', year('requesting'), { groups: [G1] }))).toEqual({ card: null, todos: [], dated: [] });
  });
});

describe('T21 部門長以上と総務の要対応', () => {
  it('準備中で備品が 0 件：「テント等の貸し出す備品と在庫を登録してください」（部門長以上だけ。部員には出さない）', () => {
    const raw = soumu({ ...RAW, items: [], requests: [], assignments: [] });
    const lead = lendingPortal(raw, ctx('soumu', year('preparing'), { role: 'deputy_head' }));
    expect(lead.todos).toEqual([{ id: 'lending:lead:no-items', moduleId: 'lending', title: LENDING_NO_ITEMS_TODO, severity: 'normal', href: '/lending' }]);
    expect(lendingPortal(raw, ctx('soumu', year('preparing'), { role: 'staff' })).todos).toEqual([]);
    // 受付中になれば出さない
    expect(lendingPortal(raw, ctx('soumu', year('requesting'), { role: 'head' })).todos).toEqual([]);
  });

  it('締切の前は在庫超過・確定の要対応を出さない。締切の後・確定前は備品ごとの直していない在庫超過（急ぎ）', () => {
    expect(lendingPortal(soumu(), ctx('soumu', year('requesting'), { role: 'admin', now: BEFORE_CLOSE })).todos).toEqual([]);
    const s = lendingPortal(soumu(), ctx('soumu', year('requesting'), { role: 'admin', now: AFTER_CLOSE }));
    expect(s.todos).toEqual([
      {
        id: `lending:lead:over-stock:${TENT.id}`,
        moduleId: 'lending',
        title: 'テント等が在庫を超えています：テント（申請 4・割り当て 2／在庫 3）',
        severity: 'urgent',
        href: '/lending',
      },
    ]);
    // 振り分け中は締切の後（締切の日時によらない）
    expect(ids(lendingPortal(soumu(), ctx('soumu', year('allocating', { request_close_at: null }), { role: 'head' })).todos)).toEqual([
      `lending:lead:over-stock:${TENT.id}`,
    ]);
  });

  it('締切の後・確定前で、直していない在庫超過がなければ「確定」を押す要対応（ふつう）。確定後・部員・終了は出さない', () => {
    const fixed = soumu({ ...RAW, assignments: [...RAW.assignments, { group_id: 'g2', lending_item_id: TENT.id, count: 1 }] });
    const s = lendingPortal(fixed, ctx('soumu', year('requesting'), { role: 'head', now: AFTER_CLOSE }));
    expect(s.todos).toEqual([{ id: 'lending:lead:confirm', moduleId: 'lending', title: LENDING_CONFIRM_TODO, severity: 'normal', href: '/lending' }]);
    expect(lendingPortal({ ...fixed, confirmedAt: '2026-10-12T08:00:00Z' }, ctx('soumu', year('requesting'), { role: 'head', now: AFTER_CLOSE })).todos).toEqual([]);
    expect(lendingPortal(fixed, ctx('soumu', year('requesting'), { role: 'staff', now: AFTER_CLOSE })).todos).toEqual([]);
    // 終了の年度は要対応を作らない（カードは出す）
    const closed = lendingPortal(fixed, ctx('soumu', year('closed'), { role: 'admin', now: AFTER_CLOSE }));
    expect(closed.todos).toEqual([]);
    expect(closed.card).not.toBeNull();
  });

  it('総務の未返却：2日目から「テント等の未返却 N 団体」（ふつう。祭の後から急ぎ）、行き先は未返却だけの受け渡し・返却', () => {
    const raw = soumu({
      ...RAW,
      confirmedAt: '2026-10-12T08:00:00Z',
      records: [
        { group_id: 'g1', lending_item_id: TENT.id, lent_count: 2, returned_count: 1 },
        { group_id: 'g2', lending_item_id: WEIGHT.id, lent_count: 4, returned_count: 0 },
        { group_id: 'g3', lending_item_id: WEIGHT.id, lent_count: 4, returned_count: 4 },
      ],
    });
    expect(lendingPortal(raw, ctx('soumu', year('confirmed'), { role: 'staff', now: DAY1 })).todos).toEqual([]);
    const day2 = lendingPortal(raw, ctx('soumu', year('confirmed'), { role: 'staff', now: DAY2 }));
    expect(day2.todos).toEqual([
      {
        id: 'lending:soumu:unreturned',
        moduleId: 'lending',
        title: 'テント等の未返却 2 団体',
        count: 2,
        severity: 'normal',
        href: '/lending/records?filter=unreturned',
      },
    ]);
    expect(lendingPortal(raw, ctx('soumu', year('confirmed'), { role: 'staff', now: OVER })).todos[0]?.severity).toBe('urgent');
    // 行き先は総務が開ける
    expect(canOpen('/lending/records?filter=unreturned', ['staff'], 'confirmed')).toBe(true);
    expect(canOpen('/lending/records?filter=unreturned', ['viewer'], 'confirmed')).toBe(false);
  });
});

describe('T21 店長・副店長の要対応', () => {
  const REP: LendingRepRaw = {
    assignments: [
      { group_id: 'g1', lending_item_id: WEIGHT.id, count: 4, item: { name: '重し', unit: '個', sort_order: 2 } },
      { group_id: 'g1', lending_item_id: TENT.id, count: 1, item: { name: 'テント', unit: '張', sort_order: 1 } },
      { group_id: 'g2', lending_item_id: TENT.id, count: 0, item: { name: 'テント', unit: '張', sort_order: 1 } },
    ],
    records: [],
  };
  const rep = (raw: LendingRepRaw = REP) => ({ kind: 'rep' as const, ...raw });

  it('割り当て（1以上）があり渡した数がすべて 0：「{団体名}：テント等の割り当てが決まりました（テント 1・重し 4）」（参考）、行き先はテント等のタブ', () => {
    const s = lendingPortal(rep(), ctx('rep', year('confirmed'), { groups: [G1, G2] }));
    expect(s.card).toBeNull();
    expect(s.todos).toEqual([
      {
        id: 'lending:rep:g1:assigned',
        moduleId: 'lending',
        title: '模擬店01：テント等の割り当てが決まりました（テント 1・重し 4）',
        severity: 'info',
        href: '/request?group=g1&tab=lending',
      },
    ]);
    // 渡した後は出さない
    const lent = rep({ ...REP, records: [{ group_id: 'g1', lending_item_id: TENT.id, lent_count: 1, returned_count: 0, item: REP.assignments[1]!.item }] });
    expect(ids(lendingPortal(lent, ctx('rep', year('confirmed'), { groups: [G1, G2], now: DAY1 })).todos)).toEqual([]);
  });

  it('2日目から、未返却：「{団体名}：テント等を返してください（テント 1・重し 4）」（渡した − 返った。ふつう、祭の後から急ぎ）', () => {
    const raw = rep({
      assignments: REP.assignments,
      records: [
        { group_id: 'g1', lending_item_id: WEIGHT.id, lent_count: 4, returned_count: 0, item: { name: '重し', unit: '個', sort_order: 2 } },
        { group_id: 'g1', lending_item_id: TENT.id, lent_count: 2, returned_count: 1, item: { name: 'テント', unit: '張', sort_order: 1 } },
      ],
    });
    expect(lendingPortal(raw, ctx('rep', year('confirmed'), { groups: [G1], now: DAY2 - 1 })).todos).toEqual([]);
    expect(lendingPortal(raw, ctx('rep', year('confirmed'), { groups: [G1], now: DAY2 })).todos).toEqual([
      {
        id: 'lending:rep:g1:unreturned',
        moduleId: 'lending',
        title: '模擬店01：テント等を返してください（テント 1・重し 4）',
        severity: 'normal',
        href: '/request?group=g1&tab=lending',
      },
    ]);
    expect(lendingPortal(raw, ctx('rep', year('confirmed'), { groups: [G1], now: OVER })).todos[0]?.severity).toBe('urgent');
    // 終了の年度は作らない
    expect(lendingPortal(raw, ctx('rep', year('closed'), { groups: [G1], now: OVER })).todos).toEqual([]);
  });

  it('兼ねた人（店長も務める管理者）は総務と店長・副店長の両方の分（mergePortalSections で重なりなく）', () => {
    const y = year('requesting');
    const now = AFTER_CLOSE;
    const parts = [
      { moduleId: 'lending' as const, kind: 'soumu' as const, section: lendingPortal(soumu(), ctx('soumu', y, { role: 'admin', groups: [G1], now })) },
      { moduleId: 'lending' as const, kind: 'rep' as const, section: lendingPortal(rep(), ctx('rep', y, { role: 'admin', groups: [G1], now })) },
    ];
    const [merged] = mergePortalSections(parts);
    expect(ids(merged!.todos)).toEqual([`lending:lead:over-stock:${TENT.id}`, 'lending:rep:g1:assigned']);
    expect(merged!.card?.lines[0]).toBe('割り当て：確定前（在庫を超える備品 1）');
  });
});

describe('T21 プロバイダと読み取り', () => {
  it('種類は総務・閲覧のみ・店長・副店長。読み取りの結果を使う欄は要対応とカード（締切と予定・お知らせの欄は使わない）', () => {
    expect(lendingPortalProvider.kinds).toEqual(['soumu', 'viewer', 'rep']);
    expect(lendingPortalProvider.query!.widgets).toEqual(['todos', 'cards']);
    const c = ctx('soumu', year('requesting'), { role: 'staff' });
    expect(portalWidgetQuery(lendingPortalProvider, c, 'dated')).toBeNull();
    expect(portalWidgetQuery(lendingPortalProvider, c, 'todos')!.queryKey).toEqual(lendingSoumuOptions(Y).queryKey);
    const r = ctx('rep', year('requesting'), { groups: [G1, G2] });
    expect(portalWidgetQuery(lendingPortalProvider, r, 'todos')!.queryKey).toEqual(lendingRepOptions(Y, ['g1', 'g2']).queryKey);
    expect(lendingRepOptions(Y, ['g1', 'g2']).queryKey).toEqual(['year', Y, 'portal', 'lending', 'rep', 'g1', 'g2']);
    expect(lendingSoumuOptions(Y).queryKey).toEqual(['year', Y, 'portal', 'lending', 'soumu']);
  });

  it('読んだ行と立場の種類が違えば例外', () => {
    expect(() => lendingPortal(soumu(), ctx('rep', year('requesting'), { groups: [G1] }))).toThrow();
  });

  it('総務の読み取り：5本を年度で絞って並行に、要る列だけ（申請は 1 以上だけ）。確定の印の行がなければ確定前', async () => {
    const calls: FakeCall[] = [];
    const { client } = createFakeSupabase((call) => {
      calls.push(call);
      if (call.table === 'lending_years') return { data: null };
      if (call.table === 'lending_items') return { data: [{ ...TENT, year_id: Y }] };
      if (call.table === 'lending_requests') return { data: [{ group_id: 'g1', lending_item_id: TENT.id, count: 2 }] };
      return { data: [] };
    });
    const raw = await loadLendingSoumu(Y, client);
    expect(raw).toEqual({ confirmedAt: null, items: [TENT], requests: [{ group_id: 'g1', lending_item_id: TENT.id, count: 2 }], assignments: [], records: [] });
    expect(calls.map((c) => c.table).sort()).toEqual(['lending_assignments', 'lending_items', 'lending_records', 'lending_requests', 'lending_years']);
    for (const c of calls) {
      expect(opArgs(c, 'select')[0]![0]).toBe(LENDING_SOUMU_SELECT[c.table as keyof typeof LENDING_SOUMU_SELECT]);
      expect(opArgs(c, 'eq')).toContainEqual(['year_id', Y]);
    }
    expect(opArgs(calls.find((c) => c.table === 'lending_requests')!, 'gt')).toEqual([['count', 0]]);
  });

  it('店長・副店長の読み取り：代表する団体に割り当てと記録（備品の名前・単位・並びつき）を埋め込んで1本（レビューの T21-R2）。団体がなければ読まない', async () => {
    const calls: FakeCall[] = [];
    const { client } = createFakeSupabase((call) => {
      calls.push(call);
      return {
        data: [
          {
            id: 'g1',
            lending_assignments: [
              { lending_item_id: WEIGHT.id, count: 4, lending_items: { name: '重し', unit: '個', sort_order: 2 } },
              { lending_item_id: TENT.id, count: 1, lending_items: [{ name: 'テント', unit: '張', sort_order: 1 }] },
            ],
            lending_records: [{ lending_item_id: TENT.id, lent_count: 1, returned_count: 0, lending_items: null }],
          },
          // 確定前（割り当ては RLS が返さない）で記録もない団体
          { id: 'g2', lending_assignments: [], lending_records: [] },
        ],
      };
    });
    const raw = await loadLendingRep(['g1', 'g2'], client);
    // 団体 → 備品の id の順。埋め込みの備品は配列で返っても最初のもの、読めなければ null
    expect(raw.assignments).toEqual(
      [
        { group_id: 'g1', lending_item_id: WEIGHT.id, count: 4, item: { name: '重し', unit: '個', sort_order: 2 } },
        { group_id: 'g1', lending_item_id: TENT.id, count: 1, item: { name: 'テント', unit: '張', sort_order: 1 } },
      ].sort((a, b) => (a.lending_item_id < b.lending_item_id ? -1 : 1)),
    );
    expect(raw.records).toEqual([{ group_id: 'g1', lending_item_id: TENT.id, lent_count: 1, returned_count: 0, item: null }]);
    expect(calls).toHaveLength(1);
    expect(calls[0]!.table).toBe('groups');
    expect(opArgs(calls[0]!, 'select')[0]![0]).toBe(LENDING_REP_SELECT);
    expect(opArgs(calls[0]!, 'in')).toEqual([['id', ['g1', 'g2']]]);
    const none = createFakeSupabase(() => ({ data: [] }));
    expect(await loadLendingRep([], none.client)).toEqual({ assignments: [], records: [] });
    expect(none.issued).toEqual([]);
  });
});
