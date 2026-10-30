import { describe, expect, it } from 'vitest';
import type { AllocateInput, Rule } from '@gaapp/shared';
import { FixtureBuilder, RULES } from '@gaapp/shared/testing';
import { buildCandidates } from './candidates';
import { createContext } from './context';
import { prepare } from './prepare';
import { substituteOptions } from './rules';

const build = (input: AllocateInput) => {
  const c = createContext(input);
  if (!c.ok) throw new Error(JSON.stringify(c.inputErrors));
  const p = prepare(c.ctx);
  return { ctx: c.ctx, p, cands: buildCandidates(c.ctx, p) };
};

const world = () =>
  new FixtureBuilder('cand')
    .room('教室', { building: 'A' })
    .room('体育館', { kind: 'gym', building: '体育館' })
    .room('外1', { kind: 'outdoor' })
    .room('倉庫', { building: 'B' })
    .stock('倉庫', { desk: 50, desk_ng: 50, caster_desk: 50, chair: 50, chair_ng: 50 })
    .stock('教室', { desk: 1 });

/** 団体 g・申請品目 i の変数の (j のコード, 運び元の名前) */
const varsOf = (b: FixtureBuilder, input: AllocateInput, g: string, i: string) => {
  const ix = b.ids();
  const { cands } = build(input);
  return cands.vars
    .filter((v) => v.g === ix.groupId(g) && v.i === ix.itemId(i) && !v.hat)
    .map((v) => `${ix.itemCode.get(v.j)}@${ix.roomName.get(v.r)}`);
};

describe('品目の候補（代替ルール。設計 7 章）', () => {
  it('categories：模擬店だけ不可机', () => {
    const b = world().group('模擬店', 'stall', '教室').group('部門', 'department', '教室').request('模擬店', { desk: 1 }).request('部門', { desk: 1 }).rule(RULES.S01());
    expect(varsOf(b, b.input(), '模擬店', 'desk')).toEqual(['desk@教室', 'desk@倉庫', 'desk_ng@倉庫']);
    expect(varsOf(b, b.input(), '部門', 'desk')).toEqual(['desk@教室', 'desk@倉庫']);
  });

  it('indoorOnly：屋外・体育館・使用場所なしは対象外', () => {
    const b = world()
      .group('屋内', 'stall', '教室')
      .group('屋外', 'stall', '外1')
      .group('体育館', 'stall', '体育館')
      .group('なし', 'stall', null)
      .request('屋内', { desk: 1 }).request('屋外', { desk: 1 }).request('体育館', { desk: 1 }).request('なし', { desk: 1 })
      .rule(RULES.S07());
    const input = b.input();
    expect(varsOf(b, input, '屋内', 'desk')).toContain('caster_desk@倉庫');
    for (const g of ['屋外', '体育館', 'なし']) expect(varsOf(b, input, g, 'desk')).not.toContain('caster_desk@倉庫');
  });

  it('needsConsent：declined だけ外す', () => {
    for (const [status, has] of [['declined', false], ['asked', true], ['accepted', true], ['not_asked', true]] as const) {
      const b = world().group('模擬店', 'stall', '教室').request('模擬店', { desk: 1 }).rule(RULES.S07()).consent('模擬店', 'desk', 'caster_desk', status);
      expect(varsOf(b, b.input(), '模擬店', 'desk').includes('caster_desk@倉庫'), status).toBe(has);
    }
  });

  it('preferCategory の p は休憩所への不可椅子だけ 1', () => {
    const b = world().group('休憩所', 'rest_area', '教室').group('模擬店', 'stall', '教室').request('休憩所', { chair: 1 }).request('模擬店', { chair: 1 }).rule(RULES.S02());
    const ix = b.ids();
    const { cands } = build(b.input());
    const p = cands.vars.filter((v) => v.p === 1).map((v) => `${ix.groupName.get(v.g)}:${ix.itemCode.get(v.j)}`);
    expect(new Set(p)).toEqual(new Set(['休憩所:chair_ng']));
  });

  it('同じ j に当てはまる代替が2つ（checkRuleRefs を通らない入力）：cost が小さいもの、同じなら code が先', () => {
    const sub = (id: string, code: string, cost: number): Rule => ({
      id, code, kind: 'substitute',
      params: { from: 'desk', to: 'caster_desk', categories: ['stall'], cost, indoorOnly: false, needsConsent: false } });
    const b = world().group('模擬店', 'stall', '教室').request('模擬店', { desk: 1 });
    const { ctx } = build(b.input());
    const g = ctx.groups[0]!;
    const desk = ctx.items.find((i) => i.code === 'desk')!;
    const opts = (rules: Rule[]) => substituteOptions({ ...ctx, rules }, g, desk).filter((o) => o.cSub > 0 || o.ruleCode);
    expect(opts([sub('00000000-0000-4000-8000-000000000001', 'S1', 3), sub('00000000-0000-4000-8000-000000000002', 'S2', 1)]).map((o) => o.ruleCode)).toEqual(['S2']);
    expect(opts([sub('00000000-0000-4000-8000-000000000001', 'S1', 3), sub('00000000-0000-4000-8000-000000000002', 'S2', 3)]).map((o) => o.ruleCode)).toEqual(['S1']);
  });

  it('source_restrict：共通部分と、代替先の品目にもかかる（D-22）', () => {
    const b = world()
      .room('倉庫2', { building: 'B' })
      .stock('倉庫2', { desk: 5, desk_ng: 5 })
      .group('模擬店', 'stall', '教室')
      .request('模擬店', { desk: 1 })
      .rule(RULES.S01(), RULES.restrict('R1', '模擬店', ['desk'], ['倉庫', '倉庫2']), RULES.restrict('R2', '模擬店', ['desk', 'chair'], ['倉庫2', '教室']));
    expect(varsOf(b, b.input(), '模擬店', 'desk')).toEqual(['desk@倉庫2', 'desk_ng@倉庫2']);
  });

  it('並びは j = i、次に品目の並び、その中は部屋の並び', () => {
    const b = world().group('模擬店', 'stall', '教室').request('模擬店', { desk: 1 }).rule(RULES.S07(), RULES.S01());
    expect(varsOf(b, b.input(), '模擬店', 'desk')).toEqual(['desk@教室', 'desk@倉庫', 'desk_ng@倉庫', 'caster_desk@倉庫']);
  });
});

describe('x̂（最小変更。K-14）', () => {
  it('x があるキーだけ、上限は前回 − keep', () => {
    const b = world().group('模擬店', 'stall', '教室').request('模擬店', { desk: 3 }).rule(RULES.S07()).consent('模擬店', 'desk', 'caster_desk', 'declined');
    const ix = b.ids();
    const prev = (room: string, j: string, count: number) => ({
      sourceRoomId: ix.roomId(room), groupId: ix.groupId('模擬店'), itemId: ix.itemId(j), requestedItemId: ix.itemId('desk'), count, isKeep: room === '教室' });
    const input = b.input({ mode: 'minimal_change', previousRows: [prev('倉庫', 'desk', 2), prev('倉庫', 'caster_desk', 1), prev('体育館', 'desk', 1)] });
    const { cands } = build(input);
    const hats = cands.vars.filter((v) => v.hat).map((v) => `${ix.itemCode.get(v.j)}@${ix.roomName.get(v.r)}<=${v.ub}`);
    // 了承を拒否した置き換えと、在庫のない体育館には x̂ を作らない
    expect(hats).toEqual(['desk@倉庫<=2']);
    // x̂ は対応する x の直後
    const k = cands.vars.findIndex((v) => v.hat);
    expect(cands.vars[k - 1]).toMatchObject({ hat: false, r: cands.vars[k]!.r, j: cands.vars[k]!.j });
  });
});

describe('候補が足りない需要（前処理7）', () => {
  it('候補がない、または候補の在庫の合計が足りない需要を、団体つきで返す', () => {
    const b = world()
      .group('模擬店', 'stall', '教室')
      .group('設営', 'department', '体育館')
      .request('模擬店', { lectern: 1 })
      .request('設営', { desk: 2 })
      .rule(RULES.restrict('S05', '設営', ['desk'], ['教室']));
    const ix = b.ids();
    const { cands } = build(b.input());
    expect(cands.shortages).toEqual([
      { requestedItemId: ix.itemId('lectern'), groupId: ix.groupId('模擬店'), demand: 1, supply: 0 },
      { requestedItemId: ix.itemId('desk'), groupId: ix.groupId('設営'), demand: 2, supply: 1 },
    ]);
  });
});
