// 05 の不変条件のうち T06 の分（設計 12.2）。合成データ fixtures/synthetic/r8like と、あれば fixtures/r8 に同じテストを流す
import { beforeAll, describe, expect, it } from 'vitest';
import type { AllocateInput, AllocationRow, AllocateResult } from '@gaapp/shared';
import { fixtureIndex, generateSynthetic, makeInfeasibleS05, toAllocateInput, toFixedRow } from '@gaapp/shared/testing';
import { allocate } from './allocate';
import { checkInvariants } from './testing/checkInvariants';
import { expectedDemand, hasR8, loadSet, requireR8, type FixtureSet } from './testing/fixtureSets';
import { getHighs } from './testing/getHighs';
import { findW107 } from './w107';

const SLOW = 120_000;

if (!hasR8()) {
  if (requireR8()) {
    it('fixtures/r8 が必要（REQUIRE_R8_FIXTURES=1）', () => {
      throw new Error('fixtures/r8/meta.json がありません');
    });
  } else {
    it.todo('fixtures/r8 がないため、R8 の不変条件を実行していない');
  }
}

const sets: FixtureSet[] = [loadSet('r8like'), ...(hasR8() ? [loadSet('r8')] : [])];

const sumBy = (rows: readonly AllocationRow[], key: (r: AllocationRow) => string) => {
  const m = new Map<string, number>();
  for (const r of rows) m.set(key(r), (m.get(key(r)) ?? 0) + r.count);
  return m;
};
const gi = (r: AllocationRow) => `${r.groupId}|${r.requestedItemId}`;
const rj = (r: AllocationRow) => `${r.sourceRoomId}|${r.itemId}`;
const rgij = (r: AllocationRow) => `${r.sourceRoomId}|${r.groupId}|${r.requestedItemId}|${r.itemId}`;

function okRows(res: AllocateResult): AllocationRow[] {
  if (!res.ok) throw new Error(`ok: false（${res.reason}）${res.message}`);
  return res.rows;
}

describe.each(sets)('不変条件：$label', (set) => {
  const { fx, ix, input } = set;
  const demand = expectedDemand(fx);
  const stock = new Map(input.stocks.map((s) => [`${s.roomId}|${s.itemId}`, s.count]));
  const rule = (kind: string) => fx.rules.filter((r) => r.enabled && r.kind === kind);
  let res: AllocateResult;
  let rows: AllocationRow[];
  beforeAll(async () => {
    res = allocate(input, await getHighs());
    rows = okRows(res);
  });
  const code = (id: string) => ix.itemCode.get(id)!;
  const category = (gid: string) => input.groups.find((g) => g.id === gid)!.category;

  it('解ける。独立の検算で E001〜E006 が0件', () => {
    expect(res.ok).toBe(true);
    expect(checkInvariants(input, rows, demand)).toEqual([]);
  });

  it('すべての団体・申請品目で、振り分け合計が需要（読み替えと未提出の固定数を当てた申請）と等しい', () => {
    const got = sumBy(rows, gi);
    for (const k of new Set([...got.keys(), ...demand.keys()])) expect(got.get(k) ?? 0, k).toBe(demand.get(k) ?? 0);
  });

  it('S05：運び元の制限の対象の行は指定した場所からだけ。合計は需要と同じ', () => {
    const rs = rule('source_restrict');
    expect(rs.length).toBeGreaterThan(0);
    for (const r of rs) {
      const p = r.params as { group: string; items: string[]; rooms: string[] };
      const allowed = new Set(p.rooms.map(ix.roomId));
      for (const item of p.items) {
        const target = rows.filter((x) => x.groupId === ix.groupId(p.group) && code(x.requestedItemId) === item);
        expect(target.every((x) => allowed.has(x.sourceRoomId))).toBe(true);
        expect(target.reduce((a, x) => a + x.count, 0)).toBe(demand.get(`${ix.groupId(p.group)}|${ix.itemId(item)}`) ?? 0);
      }
    }
    if (set.synthetic) {
      const setup = rows.filter((x) => x.groupId === ix.groupId('設営') && code(x.requestedItemId) === 'desk');
      expect(setup.reduce((a, x) => a + x.count, 0)).toBe(241);
    }
  });

  it('S01・S02・S03：不可机は模擬店、不可椅子は休憩所と模擬店、長机(3人掛)は企業だけ', () => {
    for (const r of rows) {
      const c = category(r.groupId);
      if (code(r.itemId) === 'desk_ng') expect(c).toBe('stall');
      if (code(r.itemId) === 'chair_ng') expect(['stall', 'rest_area']).toContain(c);
      if (code(r.itemId) === 'long_desk_3') expect(c).toBe('company');
    }
  });

  it('キャスター机への置き換えは 103 台以下（合成データは 97）', () => {
    const n = rows.filter((r) => code(r.requestedItemId) === 'desk' && code(r.itemId) === 'caster_desk').reduce((a, r) => a + r.count, 0);
    expect(n).toBeLessThanOrEqual(103);
    if (set.synthetic) expect(n).toBe(97);
  });

  it('代替のない品目の合計：椅子(青) 134、教卓 10、長机（3人掛＋2人掛）106', () => {
    const total = (codes: string[]) => rows.filter((r) => codes.includes(code(r.itemId))).reduce((a, r) => a + r.count, 0);
    expect(total(['blue_chair'])).toBe(134);
    expect(total(['lectern'])).toBe(10);
    expect(total(['long_desk_3', 'long_desk_2'])).toBe(106);
  });

  it('S08：残すのルールの行が is_keep で、数はルール以上', () => {
    const ks = rule('keep');
    expect(ks.length).toBeGreaterThan(0);
    for (const k of ks) {
      const p = k.params as { group: string; room: string; items: Record<string, number> };
      for (const [c, n] of Object.entries(p.items)) {
        const r = rows.filter((x) => x.groupId === ix.groupId(p.group) && x.sourceRoomId === ix.roomId(p.room) && code(x.itemId) === c && code(x.requestedItemId) === c);
        expect(r).toHaveLength(1);
        expect(r[0]!.isKeep).toBe(true);
        expect(r[0]!.count).toBeGreaterThanOrEqual(n);
      }
    }
  });

  it('W107（D-20 の定義）が0件。T00 の定義の件数は S05 の対象だけ', () => {
    const f = findW107(input, rows);
    expect(f.filter((x) => x.swappable)).toEqual([]);
    const s05Groups = new Set(rule('source_restrict').map((r) => ix.groupId((r.params as { group: string }).group)));
    const s05Rooms = new Set(rule('source_restrict').flatMap((r) => (r.params as { rooms: string[] }).rooms.map(ix.roomId)));
    for (const x of f) expect(s05Groups.has(x.groupId) || s05Rooms.has(x.roomId)).toBe(true);
    console.info(`[${set.label}] W107：D-20 の定義 0 件、T00 の定義 ${f.length} 件`);
  });

  it('同じ入力で2回実行すると同じ結果', async () => {
    expect(okRows(allocate(input, await getHighs()))).toEqual(rows);
  });

  it('固定行・手動行が二重にならない（5行おきに固定、manual と pinned を半分ずつ）', async () => {
    const picked = rows.filter((_, k) => k % 5 === 0);
    expect(picked.length).toBeGreaterThanOrEqual(5);
    const fixed = picked.map((r, n) => toFixedRow(r, n, n % 2 === 0 ? { origin: 'manual', pinned: false } : { pinned: true }));
    const again = okRows(allocate({ ...input, fixedRows: fixed }, await getHighs()));
    const all = [...fixed, ...again];
    const got = sumBy(all, gi);
    for (const k of new Set([...got.keys(), ...demand.keys()])) expect(got.get(k) ?? 0, k).toBe(demand.get(k) ?? 0);
    for (const [k, n] of sumBy(all, rj)) expect(n).toBeLessThanOrEqual(stock.get(k) ?? 0);
    expect(checkInvariants(input, all, demand)).toEqual([]);
  });

  it('残すの行を pinned にしても、同じキーの合計は pinned にする前と同じ（二重に足さない）', async () => {
    for (const k of rule('keep')) {
      const p = k.params as { group: string; room: string; items: Record<string, number> };
      for (const c of Object.keys(p.items)) {
        const keyRow = rows.find((x) => x.groupId === ix.groupId(p.group) && x.sourceRoomId === ix.roomId(p.room) && code(x.itemId) === c && code(x.requestedItemId) === c)!;
        const again = okRows(allocate({ ...input, fixedRows: [toFixedRow(keyRow, 1, { pinned: true })] }, await getHighs()));
        const same = again.filter((x) => rgij(x) === rgij(keyRow)).reduce((a, x) => a + x.count, 0);
        expect(keyRow.count + same).toBe(keyRow.count);
        if (set.synthetic && c === 'desk') expect(keyRow.count).toBe(18);
      }
    }
  });

  it('了承を拒否した団体には、再実行（最小変更）後にキャスター机への置き換えがない', async () => {
    const swapped = rows.filter((r) => code(r.requestedItemId) === 'desk' && code(r.itemId) === 'caster_desk');
    const target = swapped.map((r) => r.groupId).find((g) => !input.consents.some((c) => c.groupId === g && c.status === 'declined'))!;
    expect(target).toBeDefined();
    const consents = [
      ...input.consents.filter((c) => !(c.groupId === target && code(c.fromItemId) === 'desk' && code(c.toItemId) === 'caster_desk')),
      { groupId: target, fromItemId: ix.itemId('desk'), toItemId: ix.itemId('caster_desk'), status: 'declined' as const, count: null },
    ];
    const after = okRows(allocate({ ...input, consents, mode: 'minimal_change', previousRows: rows }, await getHighs()));
    expect(after.filter((r) => r.groupId === target && code(r.itemId) === 'caster_desk' && code(r.requestedItemId) === 'desk')).toEqual([]);
    expect(checkInvariants({ ...input, consents }, after, demand)).toEqual([]);
  });

  it('申請を在庫より多くすると ok: false（候補の在庫が足りない団体・LP が Infeasible）', async () => {
    const solver = await getHighs();
    if (set.synthetic) {
      const inf = toAllocateInput(makeInfeasibleS05(fx));
      expect(allocate(inf, solver)).toMatchObject({
        ok: false,
        reason: 'infeasible',
        shortages: [{ groupId: ix.groupId('設営'), requestedItemId: ix.itemId('desk'), demand: 241, supply: 235 }],
      });
    }
    // 教卓：2団体それぞれの需要は使える在庫以下だが、合わせると超える → LP が Infeasible
    const lectern = ix.itemId('lectern');
    const usable = new Set(input.rooms.filter((r) => r.usable).map((r) => r.id));
    const total = input.stocks.filter((s) => s.itemId === lectern && usable.has(s.roomId)).reduce((a, s) => a + s.count, 0);
    const [g1, g2] = input.groups.filter((g) => g.submittedAt !== null);
    const requests = [
      ...input.requests.filter((r) => r.itemId !== lectern),
      { groupId: g1!.id, itemId: lectern, count: total - 1 },
      { groupId: g2!.id, itemId: lectern, count: total - 1 },
    ];
    expect(allocate({ ...input, requests } satisfies AllocateInput, solver)).toMatchObject({ ok: false, reason: 'infeasible', stats: { solverStatus: 'Infeasible' } });
  });

  it('計算時間：Node で 2 秒未満（検証・前処理を含む）', async () => {
    const t = allocate(input, await getHighs());
    expect(t.elapsedMs).toBeLessThan(2000);
    if (t.ok) console.info(`[${set.label}] stats ${JSON.stringify(t.stats)}`);
  });
});

describe('合成データ シード 100〜129（数の一致を求めない不変条件）', () => {
  it(
    '解け、独立の検算で0件、W107（D-20）が0件',
    async () => {
      const solver = await getHighs();
      let old = 0;
      for (let seed = 100; seed < 130; seed++) {
        const fx = generateSynthetic(seed);
        const input = toAllocateInput(fx);
        const rows = okRows(allocate(input, solver));
        expect(checkInvariants(input, rows, expectedDemand(fx)), `seed ${seed}`).toEqual([]);
        const f = findW107(input, rows);
        expect(f.filter((x) => x.swappable), `seed ${seed}`).toEqual([]);
        const ix = fixtureIndex(fx);
        for (const x of f) expect(ix.groupName.get(x.groupId)).toBe('設営');
        old += f.length;
      }
      console.info(`[seeds 100-129] W107：D-20 の定義 0 件、T00 の定義 ${old} 件（すべて設営）`);
    },
    SLOW,
  );
});
