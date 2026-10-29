import { describe, expect, it } from 'vitest';
import { giKey, type AllocateInput } from '@gaapp/shared';
import { FixtureBuilder, RULES, toFixedRow } from '@gaapp/shared/testing';
import { allocate } from './allocate';
import { createContext, rjKey, rgijKey } from './context';
import { prepare } from './prepare';
import { getHighs } from './testing/getHighs';

const ctxOf = (input: AllocateInput, disabledRuleCodes?: string[]) => {
  const c = createContext(input, { disabledRuleCodes });
  if (!c.ok) throw new Error(JSON.stringify(c.inputErrors));
  return c.ctx;
};

const base = () =>
  new FixtureBuilder('prep')
    .room('X', { building: 'A' })
    .room('Y', { building: 'A' })
    .room('Z', { building: 'B', usable: false })
    .group('模擬店', 'stall', 'X')
    .group('企業', 'company', 'Y')
    .group('学科展示', 'department', 'Y')
    .stock('X', { desk: 10, long_desk_2: 5, long_desk_3: 2 })
    .stock('Y', { desk: 20, chair: 10 })
    .stock('Z', { desk: 7 });

describe('前処理1・2（D-05・D-07）', () => {
  it('企業以外の長机(3人掛)は長机(2人掛)に、企業はそのまま、不可机の申請は除いて止めない', async () => {
    const b = base().request('模擬店', { long_desk_3: 2, desk_ng: 3, desk: 1 }).request('企業', { long_desk_3: 1 });
    const ix = b.ids();
    const p = prepare(ctxOf(b.input()));
    expect(p.demand.get(giKey(ix.groupId('模擬店'), ix.itemId('long_desk_2')))).toBe(2);
    expect(p.demand.get(giKey(ix.groupId('企業'), ix.itemId('long_desk_3')))).toBe(1);
    expect(p.excluded).toEqual([{ groupId: ix.groupId('模擬店'), itemId: ix.itemId('desk_ng'), count: 3 }]);
    const res = allocate(b.input(), await getHighs());
    expect(res.ok).toBe(true);
    expect(res.ok && res.stats.excludedRequests).toBe(1);
  });

  it('未提出は固定数（申請の行があっても）、提出済みの0は0', () => {
    const unsub = base().group('設営', 'department', 'X', { submittedAt: null }).request('設営', { desk: 3 }).rule(RULES.fixed('S06', '設営', 'desk', 5));
    const ix = unsub.ids();
    expect(prepare(ctxOf(unsub.input())).demand.get(giKey(ix.groupId('設営'), ix.itemId('desk')))).toBe(5);
    const sub = base().group('設営', 'department', 'X').request('設営', { chair: 1 }).rule(RULES.fixed('S06', '設営', 'desk', 5));
    expect(prepare(ctxOf(sub.input())).demand.has(giKey(ix.groupId('設営'), ix.itemId('desk')))).toBe(false);
    // disabledRuleCodes で外すと申請の数
    expect(prepare(ctxOf(unsub.input(), ['S06'])).demand.get(giKey(ix.groupId('設営'), ix.itemId('desk')))).toBe(3);
  });
});

describe('前処理3（残す。D-06）', () => {
  it('keep の行を作り、需要と在庫から先に引く。申請より多くても作る', () => {
    const b = base().request('学科展示', { desk: 3 }).rule(RULES.keep('S08', '学科展示', 'Y', { chair: 2, desk: 5 }));
    const ix = b.ids();
    const p = prepare(ctxOf(b.input()));
    expect(p.keepRows.map((r) => [ix.itemCode.get(r.itemId), r.count, r.isKeep])).toEqual([
      ['desk', 5, true],
      ['chair', 2, true],
    ]);
    expect(p.demand.has(giKey(ix.groupId('学科展示'), ix.itemId('desk')))).toBe(false);
    expect(p.supply.get(rjKey(ix.roomId('Y'), ix.itemId('desk')))).toBe(15);
    expect(p.supply.get(rjKey(ix.roomId('Y'), ix.itemId('chair')))).toBe(8);
  });

  it('手で固定した keep と重なると、超える分だけ作る（二重にならない）', () => {
    const b = base().request('学科展示', { desk: 5 }).rule(RULES.keep('S08', '学科展示', 'Y', { desk: 5 }));
    const ix = b.ids();
    const pinned = toFixedRow(
      { sourceRoomId: ix.roomId('Y'), groupId: ix.groupId('学科展示'), itemId: ix.itemId('desk'), requestedItemId: ix.itemId('desk'), count: 3, isKeep: true },
      1,
    );
    const p = prepare(ctxOf(b.input({ fixedRows: [pinned] })));
    expect(p.keepRows.map((r) => r.count)).toEqual([2]);
    expect(p.supply.get(rjKey(ix.roomId('Y'), ix.itemId('desk')))).toBe(15);
    const p2 = prepare(ctxOf(b.input({ fixedRows: [{ ...pinned, count: 6 }] })));
    expect(p2.keepRows).toEqual([]);
  });

  it('keep の部屋が使用場所でなければ E005、使用不可なら E002（ruleCode つき）で止める', async () => {
    const e5 = base().rule(RULES.keep('S08', '学科展示', 'X', { desk: 1 }));
    const r5 = allocate(e5.input(), await getHighs());
    expect(r5).toMatchObject({ ok: false, reason: 'precheck', issues: [{ code: 'E005', refs: { ruleCode: 'S08' } }] });
    const e2 = base().group('Z の団体', 'department', 'Z').rule(RULES.keep('S08', 'Z の団体', 'Z', { desk: 1 }));
    const r2 = allocate(e2.input(), await getHighs());
    expect(r2).toMatchObject({ ok: false, reason: 'precheck', issues: [{ code: 'E002', refs: { ruleCode: 'S08' } }] });
  });
});

describe('前処理4・5（固定行）', () => {
  it('固定行を差し引く。企業以外の長机(3人掛)の手動の行は長机(2人掛)の需要から引かれる', async () => {
    const b = base().request('模擬店', { long_desk_2: 3 });
    const ix = b.ids();
    const manual = toFixedRow(
      { sourceRoomId: ix.roomId('X'), groupId: ix.groupId('模擬店'), itemId: ix.itemId('long_desk_2'), requestedItemId: ix.itemId('long_desk_3'), count: 2, isKeep: true },
      1,
      { origin: 'manual' },
    );
    const input = b.input({ fixedRows: [manual] });
    const p = prepare(ctxOf(input));
    expect(p.demand.get(giKey(ix.groupId('模擬店'), ix.itemId('long_desk_2')))).toBe(1);
    const res = allocate(input, await getHighs());
    expect(res.ok && res.rows.reduce((a, r) => a + r.count, 0)).toBe(1);
  });

  it('E001：固定行が在庫を超えると rowIds つきで止める（使用不可の部屋でも）', async () => {
    const b = base().request('模擬店', { desk: 1 });
    const ix = b.ids();
    const row = (room: string, count: number, n: number) =>
      toFixedRow({ sourceRoomId: ix.roomId(room), groupId: ix.groupId('模擬店'), itemId: ix.itemId('desk'), requestedItemId: ix.itemId('desk'), count, isKeep: false }, n, { origin: 'manual' });
    const r1 = allocate(b.input({ fixedRows: [row('X', 6, 1), row('X', 5, 2)] }), await getHighs());
    expect(r1).toMatchObject({ ok: false, reason: 'precheck' });
    expect(!r1.ok && r1.issues).toEqual([
      expect.objectContaining({ code: 'E001', refs: { roomId: ix.roomId('X'), itemId: ix.itemId('desk'), rowIds: expect.arrayContaining([row('X', 6, 1).id, row('X', 5, 2).id]) } }),
    ]);
    const r2 = allocate(b.input({ fixedRows: [row('Z', 8, 3)] }), await getHighs());
    expect(r2).toMatchObject({ ok: false, reason: 'precheck', issues: [{ code: 'E001' }] });
  });

  it('固定行の運び元が使用不可でも止めず、使用不可の部屋の在庫は使わない', async () => {
    const b = base().request('模擬店', { desk: 30 });
    const ix = b.ids();
    const fixed = toFixedRow({ sourceRoomId: ix.roomId('Z'), groupId: ix.groupId('模擬店'), itemId: ix.itemId('desk'), requestedItemId: ix.itemId('desk'), count: 2, isKeep: false }, 1);
    const p = prepare(ctxOf(b.input({ fixedRows: [fixed] })));
    expect(p.supply.has(rjKey(ix.roomId('Z'), ix.itemId('desk')))).toBe(false);
    const res = allocate(b.input({ fixedRows: [fixed] }), await getHighs());
    expect(res.ok).toBe(true);
    expect(res.ok && res.rows.some((r) => r.sourceRoomId === ix.roomId('Z'))).toBe(false);
    expect(res.ok && res.rows.reduce((a, r) => a + r.count, 0)).toBe(28);
  });
});

describe('前処理6（前回の行）', () => {
  it('前回の行を合計し、残すの行を引いたものが x̂ の上限。full では作らない', () => {
    const b = base().request('学科展示', { desk: 8 }).rule(RULES.keep('S08', '学科展示', 'Y', { desk: 5 }));
    const ix = b.ids();
    const prev = { sourceRoomId: ix.roomId('Y'), groupId: ix.groupId('学科展示'), itemId: ix.itemId('desk'), requestedItemId: ix.itemId('desk'), count: 8, isKeep: true };
    const p = prepare(ctxOf(b.input({ mode: 'minimal_change', previousRows: [prev] })));
    expect([...p.hatBound]).toEqual([[rgijKey(ix.roomId('Y'), ix.groupId('学科展示'), ix.itemId('desk'), ix.itemId('desk')), 3]]);
    expect(prepare(ctxOf(b.input())).hatBound.size).toBe(0);
  });
});
