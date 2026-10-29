import type { Json } from '@gaapp/shared';
import { describe, expect, it } from 'vitest';
import type { GroupRow, RuleDbRow } from '@/lib/db/types';
import type { GroupCsvRow } from '@/lib/schemas/settings';
import { createFakeSupabase, opArgs } from '@/lib/testing/fake-supabase';
import {
  createYearFrom,
  fetchOpenYearRules,
  openYearsForRoomRefs,
  parseSettingsTab,
  planGroupImport,
  roomRefsAcrossYears,
  rulesReferencing,
  saveGroupImport,
  yearPatch,
} from './settings';

const G1 = '00000000-0000-4000-8000-000000000001';
const G2 = '00000000-0000-4000-8000-000000000002';
const R1 = '00000000-0000-4000-8000-0000000000a1';
const R2 = '00000000-0000-4000-8000-0000000000a2';
const T = '2026-10-29T00:00:00.123456+00:00';

let n = 0;
const rule = (code: string, kind: RuleDbRow['kind'], params: unknown, enabled = true): RuleDbRow => ({
  id: `00000000-0000-4000-8000-0000000001${String(++n).padStart(2, '0')}`,
  year_id: 'y',
  code,
  kind,
  params: params as NonNullable<Json>,
  enabled,
  memo: null,
  updated_at: T,
});

describe('rulesReferencing', () => {
  const rules = [
    rule('S05', 'source_restrict', { group: G1, items: ['desk'], rooms: [R1, R2] }),
    rule('S06', 'fixed_request', { group: G1, item: 'desk', count: 3 }),
    rule('S08', 'keep', { group: G2, room: R1, items: { desk: 2 } }),
    rule('S01', 'substitute', { from: 'desk', to: 'caster_desk', categories: ['stall'], cost: 1 }),
    rule('X01', 'keep', { group: G1, room: R2, items: { chair: 1 } }, false),
    // 壊れた params（配列・文字列・null）は読める所だけで判定し、落ちない
    rule('B01', 'keep', 'broken'),
    rule('B02', 'source_restrict', null),
    rule('B03', 'source_restrict', { rooms: 'not-array', group: 5 }),
    // DB の付け替えが見る groups の配列
    rule('G01', 'substitute', { groups: [G2] }),
  ];

  it('団体を参照する有効なルールと無効なルールをコードの順に分ける', () => {
    const r = rulesReferencing(rules, { groupId: G1 });
    expect(r.enabled.map((x) => x.code)).toEqual(['S05', 'S06']);
    expect(r.disabled.map((x) => x.code)).toEqual(['X01']);
    expect(r.enabled[0]).toMatchObject({ kind: 'source_restrict', enabled: true, summary: '運び元の制限：この団体の運び元を制限' });
    expect(r.enabled[1]!.summary).toBe('固定の申請：この団体の desk を固定');
  });

  it('団体の参照には params.groups の配列も入る', () => {
    expect(rulesReferencing(rules, { groupId: G2 }).enabled.map((x) => x.code)).toEqual(['G01', 'S08']);
  });

  it('場所を参照するのは source_restrict の rooms と keep の room', () => {
    const r1 = rulesReferencing(rules, { roomId: R1 });
    expect(r1.enabled.map((x) => x.code)).toEqual(['S05', 'S08']);
    expect(r1.enabled.map((x) => x.summary)).toEqual(['運び元の制限：この場所を運び元に含む', '残す：この場所の備品を残す']);
    const r2 = rulesReferencing(rules, { roomId: R2 });
    expect(r2.enabled.map((x) => x.code)).toEqual(['S05']);
    expect(r2.disabled.map((x) => x.code)).toEqual(['X01']);
  });

  it('参照がなければ空', () => {
    expect(rulesReferencing(rules, { groupId: '00000000-0000-4000-8000-000000000009' })).toEqual({ enabled: [], disabled: [] });
    expect(rulesReferencing([], { roomId: R1 })).toEqual({ enabled: [], disabled: [] });
  });
});

describe('parseSettingsTab', () => {
  it('知らない値は years', () => {
    expect(parseSettingsTab('groups')).toBe('groups');
    expect(parseSettingsTab('export')).toBe('export');
    expect(parseSettingsTab('foo')).toBe('years');
    expect(parseSettingsTab(null)).toBe('years');
  });
});

describe('yearPatch', () => {
  const year = {
    label: 'R9',
    festival_start: '2027-10-16',
    request_open_at: '2027-07-01T00:00:00+00:00',
    request_close_at: null,
  };
  it('変えたキーだけを入れる（同じ時刻は別の書き方でも変えていない）', () => {
    expect(yearPatch(year, { label: 'R9', festival_start: '2027-10-16', request_open_at: '2027-07-01T09:00:00+09:00', request_close_at: null })).toEqual({});
    expect(
      yearPatch(year, { label: 'R9b', festival_start: '2027-10-17', request_open_at: null, request_close_at: '2027-07-10T18:00:00+09:00' }),
    ).toEqual({ label: 'R9b', festival_start: '2027-10-17', request_open_at: null, request_close_at: '2027-07-10T18:00:00+09:00' });
  });
});

const group = (over: Partial<GroupRow>): GroupRow => ({
  id: G1,
  year_id: 'y',
  name: '模擬店A',
  display_name: null,
  aliases: [],
  category: 'stall',
  is_food: false,
  location_room_id: null,
  sort_order: 10,
  updated_at: T,
  ...over,
});
const csvRow = (over: Partial<GroupCsvRow>): GroupCsvRow => ({
  line: 2,
  name: '模擬店A',
  display_name: null,
  category: 'stall',
  is_food: false,
  location_room_id: null,
  aliases: [],
  sort_order: 10,
  ...over,
});

describe('planGroupImport', () => {
  it('同じ名前の団体は変える・変わらない、なければ足す（削除はしない）', () => {
    const groups = [group({}), group({ id: G2, name: '部門B', category: 'department', aliases: ['B'] })];
    const plan = planGroupImport(
      [
        csvRow({}),
        csvRow({ line: 3, name: '部門B', category: 'department', aliases: ['B', 'びー'], is_food: true, location_room_id: R1 }),
        csvRow({ line: 4, name: '企業C', category: 'company' }),
      ],
      groups,
    );
    expect(plan.counts).toEqual({ add: 1, change: 1, same: 1 });
    expect(plan.lines.map((l) => l.action)).toEqual(['same', 'change', 'add']);
    expect(plan.lines[1]!.changes).toEqual(['飲食', '使用場所', '別名']);
    expect(plan.lines[1]!.existing?.id).toBe(G2);
    expect(plan.nameErrors).toEqual([]);
  });

  it('取り込んだ後の団体に checkGroupNames を当てる（大文字・小文字・全角半角だけが違う名前）', () => {
    const plan = planGroupImport([csvRow({ name: 'ｍｏｇｉ' })], [group({ name: 'MOGI' })]);
    expect(plan.counts.add).toBe(1);
    expect(plan.nameErrors).toHaveLength(1);
    expect(plan.nameErrors[0]).toContain('MOGI');
  });
});

describe('saveGroupImport', () => {
  it('足す・変える行だけを (year_id, name) の upsert 1回で送る', async () => {
    const plan = planGroupImport([csvRow({}), csvRow({ line: 3, name: '企業C', category: 'company' })], [group({})]);
    const { client, issued } = createFakeSupabase(() => ({ data: [{ id: G2 }], error: null }));
    await expect(saveGroupImport('y', plan, client)).resolves.toBe(1);
    expect(issued).toHaveLength(1);
    const [values, opts] = opArgs(issued[0]!, 'upsert')[0]! as [{ name: string; year_id: string }[], { onConflict: string }];
    expect(values.map((v) => [v.year_id, v.name])).toEqual([['y', '企業C']]);
    expect(opts).toEqual({ onConflict: 'year_id,name' });
  });

  it('返った行が足りなければ（RLS で拒否）forbidden', async () => {
    const plan = planGroupImport([csvRow({ name: '企業C' })], []);
    const { client } = createFakeSupabase(() => ({ data: [], error: null }));
    await expect(saveGroupImport('y', plan, client)).rejects.toMatchObject({ info: { kind: 'forbidden' } });
  });

  it('変えるものがなければ送らない', async () => {
    const plan = planGroupImport([csvRow({})], [group({})]);
    const { client, issued } = createFakeSupabase(() => ({ data: [], error: null }));
    await expect(saveGroupImport('y', plan, client)).resolves.toBe(0);
    expect(issued).toHaveLength(0);
  });
});

describe('createYearFrom', () => {
  it('作った年度と、付け替えられずに無効になったルールのコードを返す', async () => {
    const PREV = '00000000-0000-4000-8000-00000000f001';
    const NEW = '00000000-0000-4000-8000-00000000f002';
    const { client, issued } = createFakeSupabase((call) => {
      if (call.table === 'rpc:create_year_from') return { data: { id: NEW, label: 'R10' }, error: null };
      const yearId = opArgs(call, 'eq')[0]![1];
      if (yearId === PREV) {
        return { data: [{ code: 'S05', enabled: true }, { code: 'S06', enabled: true }, { code: 'X01', enabled: false }], error: null };
      }
      return { data: [{ code: 'S05', enabled: false }, { code: 'S06', enabled: true }, { code: 'X01', enabled: false }], error: null };
    });
    const r = await createYearFrom({ id: PREV }, ' R10 ', '2027-10-16', client);
    expect(r.year.id).toBe(NEW);
    expect(r.disabledRuleCodes).toEqual(['S05']);
    const rpcArgs = opArgs(issued[0]!, 'rpc')[0]![0];
    expect(rpcArgs).toEqual({ p_prev_year_id: PREV, p_label: 'R10', p_festival_start: '2027-10-16' });
  });
});

describe('場所の削除の前：終了していない年度のルール（場所は全年度で共有）', () => {
  const y = (id: string, label: string, status: 'preparing' | 'requesting' | 'allocating' | 'confirmed' | 'closed', festival_start: string) => ({
    id,
    label,
    status,
    festival_start,
  });
  const R8 = y('y8', 'R8', 'confirmed', '2026-10-17');
  const R9 = y('y9', 'R9', 'preparing', '2027-10-16');
  const R7 = y('y7', 'R7', 'closed', '2025-10-18');
  const R10 = y('y10', 'R10', 'requesting', '2028-10-14');

  it('openYearsForRoomRefs：終了した年度は見ない。admin・staff の年度は読め、団体代表・閲覧のみ・ロールのない年度は読めない', () => {
    const scope = openYearsForRoomRefs(
      [R7, R8, R9, R10],
      [
        { year_id: 'y7', role: 'admin' },
        { year_id: 'y8', role: 'staff' },
        { year_id: 'y9', role: 'admin' },
        { year_id: 'y10', role: 'viewer' },
      ],
    );
    expect(scope.readable.map((x) => x.label)).toEqual(['R9', 'R8']);
    expect(scope.unreadable.map((x) => x.label)).toEqual(['R10']);
    // 団体代表だけの年度（ロールの行がない）も読めない
    expect(openYearsForRoomRefs([R8, R9], [{ year_id: 'y9', role: 'admin' }]).unreadable.map((x) => x.label)).toEqual(['R8']);
  });

  it('roomRefsAcrossYears：表示中でない年度の有効なルールも見つけ、年度ごとに分ける', () => {
    const rules = [
      { ...rule('S05', 'source_restrict', { group: G1, items: ['desk'], rooms: [R1] }), year_id: 'y8' },
      { ...rule('S08', 'keep', { group: G2, room: R1, items: { desk: 2 } }, false), year_id: 'y9' },
      { ...rule('S09', 'keep', { group: G2, room: R2, items: { desk: 2 } }), year_id: 'y9' },
    ];
    const r = roomRefsAcrossYears(rules, { readable: [R9, R8], unreadable: [R10] }, R1);
    expect(r.byYear.map((x) => [x.year.label, x.refs.enabled.map((e) => e.code), x.refs.disabled.map((e) => e.code)])).toEqual([
      ['R9', [], ['S08']],
      ['R8', ['S05'], []],
    ]);
    expect(r.enabledCount).toBe(1);
    expect(r.unreadable.map((x) => x.label)).toEqual(['R10']);
    // 参照がなければ年度の行を出さない
    expect(roomRefsAcrossYears(rules, { readable: [R9, R8], unreadable: [] }, 'other').byYear).toEqual([]);
  });

  it('fetchOpenYearRules：年度と自分のロールを読み、読める終了していない年度のルールだけを1回で読む', async () => {
    const { client, issued } = createFakeSupabase((call) => {
      if (call.table === 'years') return { data: [R7, R8, R9, R10], error: null };
      if (call.table === 'year_roles') {
        return {
          data: [
            { year_id: 'y7', role: 'admin' },
            { year_id: 'y8', role: 'admin' },
            { year_id: 'y9', role: 'staff' },
          ],
          error: null,
        };
      }
      if (call.table === 'rules') return { data: [{ ...rule('S05', 'keep', { room: R1 }), year_id: 'y8' }], error: null };
      throw new Error(call.table);
    });
    const r = await fetchOpenYearRules('u1', client);
    expect(r.scope.readable.map((x) => x.label)).toEqual(['R9', 'R8']);
    expect(r.scope.unreadable.map((x) => x.label)).toEqual(['R10']);
    expect(r.rules.map((x) => x.code)).toEqual(['S05']);
    const roles = issued.find((c) => c.table === 'year_roles')!;
    expect(opArgs(roles, 'eq')).toEqual([['user_id', 'u1']]);
    const rulesCall = issued.find((c) => c.table === 'rules')!;
    expect(opArgs(rulesCall, 'in')).toEqual([['year_id', ['y9', 'y8']]]);
  });

  it('fetchOpenYearRules：読める年度がなければルールを読まない', async () => {
    const { client, issued } = createFakeSupabase((call) => {
      if (call.table === 'years') return { data: [R8], error: null };
      if (call.table === 'year_roles') return { data: [], error: null };
      throw new Error(call.table);
    });
    const r = await fetchOpenYearRules('u1', client);
    expect(r.rules).toEqual([]);
    expect(r.scope.unreadable.map((x) => x.label)).toEqual(['R8']);
    expect(issued.some((c) => c.table === 'rules')).toBe(false);
  });
});
