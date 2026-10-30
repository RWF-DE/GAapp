import { describe, expect, it } from 'vitest';
import { FixtureBuilder, RULES, toYearData } from './testing';
import { checkRuleRefs, ruleSchema, type Rule, type RuleDraft } from './rules';
import { distanceOverrideSchema, roomSchema } from './model';

const b = new FixtureBuilder('rules')
  .room('X')
  .room('Y')
  .room('外1', { kind: 'outdoor' })
  .group('模擬店', 'stall', 'X')
  .group('企業', 'company', 'Y')
  .group('設営', 'department', 'Y');
const data = toYearData(b.fixture());
const ix = b.ids();
const ctx = (rules: Rule[] = []) => ({ items: data.items, rooms: data.rooms, groups: data.groups, rules });
const draft = (r: unknown) => ruleSchema.parse({ id: '00000000-0000-4000-8000-000000000001', ...(r as object) });
const strip = (r: Rule): RuleDraft => {
  const { id: _id, ...rest } = r;
  void _id;
  return rest as RuleDraft;
};

describe('ruleSchema', () => {
  it('既定値を埋め、余計なキーと範囲外を止める', () => {
    const r = draft({ code: 'S01', kind: 'substitute', params: { from: 'desk', to: 'desk_ng', categories: ['stall'], cost: 0 } });
    expect(r.kind === 'substitute' && r.params.indoorOnly).toBe(false);
    expect(r.kind === 'substitute' && r.params.needsConsent).toBe(false);
    const bad = (p: object) =>
      ruleSchema.safeParse({ id: '00000000-0000-4000-8000-000000000001', code: 'S', kind: 'substitute', params: p }).success;
    expect(bad({ from: 'desk', to: 'desk_ng', categories: ['stall'], cost: 0, indoorOnyl: true })).toBe(false);
    expect(bad({ from: 'desk', to: 'desk', categories: ['stall'], cost: 0 })).toBe(false);
    expect(bad({ from: 'desk', to: 'desk_ng', categories: ['stall'], cost: 0.5 })).toBe(false);
    expect(bad({ from: 'desk', to: 'desk_ng', categories: ['stall'], cost: 11 })).toBe(false);
    expect(bad({ from: 'desk', to: 'desk_ng', categories: ['stall'], cost: 0, preferCategory: 'company' })).toBe(false);
    expect(bad({ from: 'desk', to: 'desk_ng', categories: ['stall', 'stall'], cost: 0 })).toBe(false);
  });

  it('code は 50 字まで、数は 10000 まで', () => {
    const fixed = (code: string, count: number) =>
      ruleSchema.safeParse({
        id: '00000000-0000-4000-8000-000000000001',
        code,
        kind: 'fixed_request',
        params: { group: ix.groupId('設営'), item: 'desk', count },
      }).success;
    expect(fixed('a'.repeat(50), 10000)).toBe(true);
    expect(fixed('a'.repeat(51), 1)).toBe(false);
    expect(fixed('S06', 10001)).toBe(false);
    expect(fixed('S06', 0)).toBe(false);
  });
});

describe('距離の値の範囲（D-28）', () => {
  it('extraCost・distanceOverrides.cost は 0〜20 の整数', () => {
    const room = { id: ix.roomId('X'), name: 'X', kind: 'room', building: 'A', floor: 1, isStorage: true, usable: true, sortOrder: 1 };
    for (const [v, ok] of [[0, true], [20, true], [21, false], [-1, false], [1.5, false]] as const) {
      expect(roomSchema.safeParse({ ...room, extraCost: v }).success).toBe(ok);
      expect(distanceOverrideSchema.safeParse({ buildingA: 'A', buildingB: 'B', cost: v }).success).toBe(ok);
    }
  });
});

describe('checkRuleRefs', () => {
  it('参照先がないものを示す', () => {
    const r = draft({ code: 'S05', kind: 'source_restrict', params: { group: ix.roomId('X'), items: ['desk', 'nope'], rooms: [ix.groupId('設営')] } });
    const e = checkRuleRefs(strip(r), ctx());
    expect(e.map((x) => x.path).sort()).toEqual(['params.group', 'params.items.1', 'params.rooms.0']);
  });

  it('fixed_request・keep の品目は団体の区分で申請できるものだけ（企業以外の長机(3人掛)も不可）', () => {
    const f = draft({ code: 'F', kind: 'fixed_request', params: { group: ix.groupId('模擬店'), item: 'long_desk_3', count: 1 } });
    const e = checkRuleRefs(strip(f), ctx());
    expect(e).toHaveLength(1);
    expect(e[0]!.message).toContain('long_desk_2');
    const ok = draft({ code: 'F', kind: 'fixed_request', params: { group: ix.groupId('企業'), item: 'long_desk_3', count: 1 } });
    expect(checkRuleRefs(strip(ok), ctx())).toEqual([]);
    const k = draft({ code: 'K', kind: 'keep', params: { group: ix.groupId('模擬店'), room: ix.roomId('X'), items: { desk_ng: 1 } } });
    expect(checkRuleRefs(strip(k), ctx()).map((x) => x.path)).toEqual(['params.items.desk_ng']);
  });

  it('keep の room が使用場所でなければ code E005', () => {
    const k = draft({ code: 'K', kind: 'keep', params: { group: ix.groupId('模擬店'), room: ix.roomId('Y'), items: { desk: 1 } } });
    expect(checkRuleRefs(strip(k), ctx())).toEqual([{ path: 'params.room', message: expect.any(String), code: 'E005' }]);
  });

  it('重なり：fixed_request の（団体、品目）、substitute の区分、code', () => {
    const f1 = draft({ code: 'F1', kind: 'fixed_request', params: { group: ix.groupId('設営'), item: 'desk', count: 1 } });
    const f2 = { ...strip(f1), code: 'F2' } as RuleDraft;
    expect(checkRuleRefs(f2, ctx([f1])).map((x) => x.path)).toEqual(['params.item']);
    const { enabled: _e, memo: _m, ...s02 } = RULES.S02();
    void _e;
    void _m;
    const s1 = draft(s02);
    const s2 = draft({ code: 'S99', kind: 'substitute', params: { from: 'chair', to: 'chair_ng', categories: ['stall'], cost: 1 } });
    expect(checkRuleRefs(strip(s2), ctx([s1])).map((x) => x.path)).toEqual(['params.categories']);
    const s3 = draft({ code: 'S99', kind: 'substitute', params: { from: 'chair', to: 'chair_ng', categories: ['department'], cost: 1 } });
    expect(checkRuleRefs(strip(s3), ctx([s1]))).toEqual([]);
    const dupCode = { ...strip(s3), code: 'S02' } as RuleDraft;
    expect(checkRuleRefs(dupCode, ctx([s1])).map((x) => x.path)).toEqual(['code']);
  });

  it('重なり：同じ団体・部屋・品目の keep', () => {
    const k1 = draft({ code: 'K1', kind: 'keep', params: { group: ix.groupId('模擬店'), room: ix.roomId('X'), items: { desk: 2 } } });
    const k2 = draft({ code: 'K2', kind: 'keep', params: { group: ix.groupId('模擬店'), room: ix.roomId('X'), items: { chair: 1, desk: 3 } } });
    expect(checkRuleRefs(strip(k2), ctx([k1])).map((x) => x.path)).toEqual(['params.items.desk']);
    expect(checkRuleRefs(strip(k1), ctx([k2])).map((x) => x.path)).toEqual(['params.items.desk']);
    const k3 = draft({ code: 'K3', kind: 'keep', params: { group: ix.groupId('模擬店'), room: ix.roomId('X'), items: { chair: 1 } } });
    expect(checkRuleRefs(strip(k3), ctx([k1]))).toEqual([]);
  });

  it('keep の room が、同じ団体・品目の source_restrict の rooms に入っていること（両方のルールから）', () => {
    const k = draft({ code: 'K', kind: 'keep', params: { group: ix.groupId('模擬店'), room: ix.roomId('X'), items: { desk: 2, chair: 1 } } });
    const r = draft({ code: 'R', kind: 'source_restrict', params: { group: ix.groupId('模擬店'), items: ['desk'], rooms: [ix.roomId('Y')] } });
    const ek = checkRuleRefs(strip(k), ctx([r]));
    expect(ek.map((x) => x.path)).toEqual(['params.room']);
    expect(ek[0]!.message).toContain('R');
    const er = checkRuleRefs(strip(r), ctx([k]));
    expect(er.map((x) => x.path)).toEqual(['params.rooms']);
    expect(er[0]!.message).toContain('K');
    const inside = draft({ code: 'R', kind: 'source_restrict', params: { group: ix.groupId('模擬店'), items: ['desk'], rooms: [ix.roomId('X'), ix.roomId('Y')] } });
    expect(checkRuleRefs(strip(k), ctx([inside]))).toEqual([]);
    const otherItem = draft({ code: 'R', kind: 'source_restrict', params: { group: ix.groupId('模擬店'), items: ['long_desk_2'], rooms: [ix.roomId('Y')] } });
    expect(checkRuleRefs(strip(k), ctx([otherItem]))).toEqual([]);
    const otherGroup = draft({ code: 'R', kind: 'source_restrict', params: { group: ix.groupId('企業'), items: ['desk'], rooms: [ix.roomId('Y')] } });
    expect(checkRuleRefs(strip(k), ctx([otherGroup]))).toEqual([]);
  });

  it('id のない RuleDraft を受け取れる', () => {
    const d: RuleDraft = { code: 'N', kind: 'keep', params: { group: ix.groupId('模擬店'), room: ix.roomId('X'), items: { desk: 2 } } };
    expect(checkRuleRefs(d, ctx())).toEqual([]);
  });
});
