import { describe, expect, it } from 'vitest';
import type { AllocationRow, Issue, IssueCode, StoredAllocationRow } from '@gaapp/shared';
import { FixtureBuilder, RULES, type FixtureRule } from '@gaapp/shared/testing';
import { validate } from './validate';

type B = FixtureBuilder;
const mk = (b: B) => {
  const ix = b.ids();
  const row = (r: string, g: string, j = 'desk', count = 1, o: { i?: string; keep?: boolean } = {}): AllocationRow => ({
    sourceRoomId: ix.roomId(r),
    groupId: ix.groupId(g),
    itemId: ix.itemId(j),
    requestedItemId: ix.itemId(o.i ?? j),
    count,
    isKeep: o.keep ?? false,
  });
  const run = (rows: AllocationRow[]) => validate(b.yearData(), rows);
  return { ix, row, run };
};
const codes = (is: Issue[]) => is.map((i) => i.code);
const has = (is: Issue[], c: IssueCode) => is.some((i) => i.code === c);

/** 満たされた小さな入力：G(部門・X) が机3、X に 5 台 */
const base = () =>
  new FixtureBuilder('v')
    .room('X', { building: 'A' })
    .room('Y', { building: 'B' })
    .group('G', 'department', 'X')
    .group('H', 'department', 'Y')
    .stock('X', { desk: 5 })
    .stock('Y', { desk: 2 })
    .request('G', { desk: 3 });

describe('validate：正常な入力', () => {
  it('error も warning も出ない。I201 だけ（余り）', () => {
    const { row, run } = mk(base());
    const is = run([row('X', 'G', 'desk', 3, { keep: true })]);
    expect(codes(is)).toEqual(['I201']);
    expect(is[0]!.message).toBe('机(木) 余り4（X：2、Y：2）');
  });
});

describe('E001', () => {
  it('在庫を超えると出る（rowIds つき）。ちょうどなら出ない', () => {
    const b = base();
    const { row, run } = mk(b);
    expect(has(run([row('X', 'G', 'desk', 5, { keep: true })]), 'E001')).toBe(false);
    const stored: StoredAllocationRow = { ...row('X', 'G', 'desk', 6, { keep: true }), id: '00000000-0000-4000-8000-000000000001', origin: 'manual', pinned: false, note: null };
    const e = validate(b.yearData(), [stored]).find((i) => i.code === 'E001')!;
    expect(e.message).toContain('1 台在庫超過');
    expect(e.refs.rowIds).toEqual([stored.id]);
  });
});

describe('E002', () => {
  it('使用不可の部屋からの行で出る。使える部屋なら出ない', () => {
    const b = base().room('Z', { usable: false }).stock('Z', { desk: 5 });
    const { row, run } = mk(b);
    expect(has(run([row('Z', 'G', 'desk', 3)]), 'E002')).toBe(true);
    expect(has(run([row('X', 'G', 'desk', 3, { keep: true })]), 'E002')).toBe(false);
  });
});

describe('E003 と W101', () => {
  it('不足で E003、超過で W101、等しければどちらも出ない', () => {
    const { row, run } = mk(base());
    const short = run([row('X', 'G', 'desk', 2, { keep: true })]);
    expect(short.find((i) => i.code === 'E003')!.message).toContain('1 台不足');
    expect(has(short, 'W101')).toBe(false);
    const over = run([row('X', 'G', 'desk', 5, { keep: true })]);
    expect(over.find((i) => i.code === 'W101')!.message).toContain('2 台多い');
    expect(has(over, 'E003')).toBe(false);
    const ok = run([row('X', 'G', 'desk', 3, { keep: true })]);
    expect(has(ok, 'E003') || has(ok, 'W101')).toBe(false);
  });

  it('未提出の団体は fixed_request の数が需要になる', () => {
    const b = base().group('S', 'department', 'X', { submittedAt: null }).rule(RULES.fixed('S06', 'S', 'desk', 2));
    const { row, run } = mk(b);
    const is = run([row('X', 'G', 'desk', 3, { keep: true })]);
    expect(is.find((i) => i.code === 'E003')!.message).toContain('Sの机(木)が 2 台不足');
  });

  it('DB に長机(3人掛)のまま残る行は読み替えて比べる（企業以外）', () => {
    const b = base().room('L').stock('L', { long_desk_2: 2 }).request('G', { long_desk_3: 2 });
    const { row, run } = mk(b);
    const rows = [row('X', 'G', 'desk', 3, { keep: true }), row('L', 'G', 'long_desk_2', 2, { i: 'long_desk_3' })];
    const is = run(rows);
    expect(has(is, 'E003')).toBe(false);
    expect(has(is, 'W101')).toBe(false);
    expect(has(is, 'E004')).toBe(false);
  });
});

describe('E004', () => {
  const sub = () =>
    base().group('M', 'stall', 'X').stock('X', { desk_ng: 3, caster_desk: 3 }).request('M', { desk: 2 }).rule(RULES.S01());
  it('代替の区分が合わなければ出る（部門に不可机）。合えば出ない', () => {
    const { row, run } = mk(sub());
    expect(has(run([row('X', 'G', 'desk_ng', 3, { i: 'desk', keep: true })]), 'E004')).toBe(true);
    expect(has(run([row('X', 'M', 'desk_ng', 2, { i: 'desk', keep: true })]), 'E004')).toBe(false);
  });
  it('置き換えのルールがないと出る', () => {
    const { row, run } = mk(sub());
    const e = run([row('X', 'M', 'caster_desk', 2, { i: 'desk', keep: true })]).find((i) => i.code === 'E004')!;
    expect(e.message).toContain('置き換えのルールがありません');
  });
  it('了承しなかった団体への置き換えで出る。了承済みなら出ない', () => {
    const mkB = (status: 'declined' | 'accepted') => sub().rule(RULES.S07()).consent('M', 'desk', 'caster_desk', status, 5);
    const d = mk(mkB('declined'));
    const e = d.run([d.row('X', 'M', 'caster_desk', 2, { i: 'desk', keep: true })]).find((i) => i.code === 'E004')!;
    expect(e.refs.ruleCode).toBe('S07');
    expect(e.message).toContain('了承しなかった');
    const a = mk(mkB('accepted'));
    expect(has(a.run([a.row('X', 'M', 'caster_desk', 2, { i: 'desk', keep: true })]), 'E004')).toBe(false);
  });
  it('indoorOnly：屋外の団体への置き換えで出る', () => {
    const b = sub().room('O', { kind: 'outdoor' }).group('Out', 'stall', 'O').request('Out', { desk: 1 }).rule(RULES.S07());
    const { row, run } = mk(b);
    expect(has(run([row('X', 'Out', 'caster_desk', 1, { i: 'desk' })]), 'E004')).toBe(true);
  });
  it('運び元の制限：指定外の場所から運ぶと出る。指定内なら出ない', () => {
    const b = base().rule(RULES.restrict('S05', 'G', ['desk'], ['X']));
    const { row, run } = mk(b);
    const bad = run([row('Y', 'G', 'desk', 2), row('X', 'G', 'desk', 1, { keep: true })]).find((i) => i.code === 'E004')!;
    expect(bad.refs.ruleCode).toBe('S05');
    expect(has(run([row('X', 'G', 'desk', 3, { keep: true })]), 'E004')).toBe(false);
  });
  it('制限は代替先の品目にもかかる', () => {
    const b = sub().rule(RULES.restrict('S05', 'M', ['desk'], ['Y'])).stock('Y', { desk_ng: 2 });
    const { row, run } = mk(b);
    expect(has(run([row('X', 'M', 'desk_ng', 2, { i: 'desk', keep: true })]), 'E004')).toBe(true);
    expect(has(run([row('Y', 'M', 'desk_ng', 2, { i: 'desk' })]), 'E004')).toBe(false);
  });
  it('申請品目が団体の区分で申請できないと出る（不可机を部門が申請）', () => {
    const { row, run } = mk(base());
    expect(has(run([row('X', 'G', 'desk_ng', 3, { keep: true })]), 'E004')).toBe(true);
  });
});

describe('E005', () => {
  it('残すの行の運び元が使用場所でないと出る。使用場所からの行が残すでなくても出る。正しければ出ない', () => {
    const { row, run } = mk(base());
    expect(has(run([row('Y', 'G', 'desk', 3, { keep: true })]), 'E005')).toBe(true);
    expect(has(run([row('X', 'G', 'desk', 3, { keep: false })]), 'E005')).toBe(true);
    expect(has(run([row('X', 'G', 'desk', 3, { keep: true })]), 'E005')).toBe(false);
    expect(has(run([row('Y', 'G', 'desk', 3)]), 'E005')).toBe(false);
  });
});

describe('E006', () => {
  it('申請できない区分の申請で出る。長机(3人掛)の読み替えでは出ない', () => {
    const b = base().request('G', { desk_ng: 2, long_desk_3: 1 });
    const { row, run } = mk(b);
    const is = run([row('X', 'G', 'desk', 3, { keep: true })]);
    expect(is.filter((i) => i.code === 'E006').map((i) => i.message)).toEqual(['Gは不可机を申請できません（2 台は計算から除きます）']);
    expect(has(mk(base()).run([]), 'E006')).toBe(false);
  });
});

describe('W102', () => {
  const b = (status?: 'accepted' | 'asked' | 'not_asked', count: number | null = null) => {
    const x = base().group('M', 'stall', 'X').stock('X', { caster_desk: 6 }).rule(RULES.S07());
    return status ? x.consent('M', 'desk', 'caster_desk', status, count) : x;
  };
  const w = (bb: B, n = 4) => {
    const m = mk(bb);
    return m.run([m.row('X', 'M', 'caster_desk', n, { i: 'desk' })]).filter((i) => i.code === 'W102');
  };
  it('記録なし・未了承で出る', () => {
    expect(w(b())).toHaveLength(1);
    expect(w(b('asked'))).toHaveLength(1);
    expect(w(b('not_asked'))).toHaveLength(1);
  });
  it('了承済みで台数以内なら出ない。超えると出る', () => {
    expect(w(b('accepted', 5))).toHaveLength(0);
    expect(w(b('accepted', null))).toHaveLength(0);
    expect(w(b('accepted', 3))[0]!.message).toContain('了承は 3 台、今は 4 台');
  });
  it('置き換えがなければ出ない', () => {
    const m = mk(b());
    expect(m.run([]).some((i) => i.code === 'W102')).toBe(false);
  });
  const consentRule = (code: string, categories: ('stall' | 'company')[]): FixtureRule => ({
    code,
    kind: 'substitute',
    enabled: true,
    memo: null,
    params: { from: 'desk', to: 'caster_desk', categories, cost: 3, needsConsent: true },
  });
  it('同じ (from, to) で区分の違うルールがあっても、団体に当てはまるルールだけで1件（同じ団体・品目の組では1件にまとめる）', () => {
    const x = base().group('M', 'stall', 'X').stock('X', { caster_desk: 6 }).rule(consentRule('S05', ['company']), RULES.S07());
    const is = w(x);
    expect(is).toHaveLength(1);
    expect(is[0]!.refs.ruleCode).toBe('S07');
  });
  it('団体の区分に当てはまらないルールでは出さない：当てはまるルールがなければ W102 でなく E004', () => {
    const only = base().group('M', 'stall', 'X').stock('X', { caster_desk: 6 }).rule(consentRule('S11', ['company']));
    const m = mk(only);
    const is = m.run([m.row('X', 'M', 'caster_desk', 4, { i: 'desk' })]);
    expect(has(is, 'W102')).toBe(false);
    expect(has(is, 'E004')).toBe(true);
  });
  it('屋内だけのルールは、屋外が使用場所の団体には当てはまらず W102 を出さない', () => {
    const x = base().room('Out', { kind: 'outdoor' }).group('M', 'stall', 'Out').stock('X', { caster_desk: 6 }).rule(RULES.S07());
    const m = mk(x);
    const is = m.run([m.row('X', 'M', 'caster_desk', 4, { i: 'desk' })]);
    expect(has(is, 'W102')).toBe(false);
  });
});

describe('W103', () => {
  it('運び元が4か所で出る。3か所なら出ない', () => {
    const mkB = (n: number) => {
      let x = new FixtureBuilder('w').room('X').group('G', 'department', 'X').request('G', { desk: n });
      for (let k = 0; k < 4; k++) x = x.room(`R${k}`).stock(`R${k}`, { desk: 1 });
      return x;
    };
    const four = mk(mkB(4));
    expect(has(four.run([0, 1, 2, 3].map((k) => four.row(`R${k}`, 'G'))), 'W103')).toBe(true);
    const three = mk(mkB(3));
    expect(has(three.run([0, 1, 2].map((k) => three.row(`R${k}`, 'G'))), 'W103')).toBe(false);
  });
});

describe('W104', () => {
  it('保管場所の在庫の行がなければ出る。数えた（0 でも）、使用不可、保管場所でないなら出ない', () => {
    const none = mk(base().room('N'));
    expect(none.run([]).find((i) => i.code === 'W104')!.message).toBe('Nの在庫がまだ数えられていません');
    expect(has(mk(base().room('N').stock('N', {})).run([]), 'W104')).toBe(false);
    expect(has(mk(base().room('N').stock('N', { desk: 0 })).run([]), 'W104')).toBe(false);
    expect(has(mk(base().room('N', { usable: false })).run([]), 'W104')).toBe(false);
    expect(has(mk(base().room('N', { isStorage: false })).run([]), 'W104')).toBe(false);
  });
});

describe('W105', () => {
  it('未提出の団体で出る（まとめて1件）。全員提出済みなら出ない', () => {
    const b = base().group('U1', 'department', 'X', { submittedAt: null }).group('U2', 'department', 'X', { submittedAt: null });
    const is = mk(b).run([]).filter((i) => i.code === 'W105');
    expect(is).toHaveLength(1);
    expect(is[0]!.message).toContain('2団体が未提出');
    expect(has(mk(base()).run([]), 'W105')).toBe(false);
  });
});

describe('W106', () => {
  it('提出済みで固定と申請が違うと出る。同じなら、未提出なら出ない', () => {
    const w = (fixed: number, submittedAt: string | null | undefined) => {
      const b = new FixtureBuilder('w').room('X').stock('X', { desk: 9 }).group('S', 'department', 'X', submittedAt === undefined ? {} : { submittedAt }).request('S', { desk: 3 }).rule(RULES.fixed('S06', 'S', 'desk', fixed));
      return mk(b).run([]).filter((i) => i.code === 'W106');
    };
    expect(w(5, undefined)[0]!.message).toBe('S：固定5、申請3（机(木)）');
    expect(w(3, undefined)).toHaveLength(0);
    expect(w(5, null)).toHaveLength(0);
  });
});

describe('W107', () => {
  // G は使用場所 L の机を H に出し、自分は R から受け取っている。入れ替えても距離は増えない
  const scene = (restrictG: boolean) => {
    let b = new FixtureBuilder('w')
      .room('L', { building: 'A' })
      .room('R', { building: 'A' })
      .room('P', { building: 'A' })
      .group('G', 'department', 'L')
      .group('H', 'department', 'P')
      .stock('L', { desk: 1 })
      .stock('R', { desk: 1 })
      .request('G', { desk: 1 })
      .request('H', { desk: 1 });
    if (restrictG) b = b.rule(RULES.restrict('S05', 'G', ['desk'], ['R']));
    return mk(b);
  };
  it('入れ替えられるのに外へ出していると出る', () => {
    const m = scene(false);
    const is = m.run([m.row('L', 'H'), m.row('R', 'G')]);
    expect(is.find((i) => i.code === 'W107')!.refs).toMatchObject({ groupId: m.ix.groupId('G'), roomId: m.ix.roomId('L') });
  });
  it('自室を使っていれば出ない', () => {
    const m = scene(false);
    expect(has(m.run([m.row('L', 'G', 'desk', 1, { keep: true }), m.row('R', 'H')]), 'W107')).toBe(false);
  });
  it('S05 で入れ替えられないものは出ない', () => {
    const m = scene(true);
    expect(has(m.run([m.row('L', 'H'), m.row('R', 'G')]), 'W107')).toBe(false);
  });
});

describe('I201', () => {
  it('余りがあれば品目ごとに出る。使い切れば出ない。使用不可の部屋の在庫は数えない', () => {
    const b = base().room('Z', { usable: false }).stock('Z', { desk: 9 });
    const m = mk(b);
    expect(m.run([m.row('X', 'G', 'desk', 3, { keep: true })]).filter((i) => i.code === 'I201').map((i) => i.message)).toEqual(['机(木) 余り4（X：2、Y：2）']);
    const all = mk(new FixtureBuilder('i').room('X').group('G', 'department', 'X').stock('X', { desk: 3 }).request('G', { desk: 3 }));
    expect(has(all.run([all.row('X', 'G', 'desk', 3, { keep: true })]), 'I201')).toBe(false);
  });
});

describe('並びと入力', () => {
  it('error → warning → info の順', () => {
    const m = mk(base().room('N'));
    const is = m.run([m.row('X', 'G', 'desk', 6, { keep: true })]);
    const sev = is.map((i) => i.severity);
    expect(sev).toEqual([...sev].sort((a, b) => ['error', 'warning', 'info'].indexOf(a) - ['error', 'warning', 'info'].indexOf(b)));
    expect(sev[0]).toBe('error');
    expect(sev.at(-1)).toBe('info');
  });
  it('知らない団体を参照する行は例外', () => {
    const m = mk(base());
    expect(() => m.run([{ ...m.row('X', 'G'), groupId: '00000000-0000-4000-8000-0000000000ff' }])).toThrow();
  });
});
