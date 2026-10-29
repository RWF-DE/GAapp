import { describe, expect, it } from 'vitest';
import { audiencesOf, buildMembership, hasAudience, isInvited, pickCurrentYear, type MembershipSource } from './membership';

const y = (id: string, label: string, festival_start: string) => ({ id, label, festival_start, status: 'requesting' as const });

const base: MembershipSource = {
  displayName: 'テスト',
  years: [y('y8', 'R8', '2026-10-17'), y('y9', 'R9', '2027-10-16'), y('y7', 'R7', '2025-10-18')],
  roles: [],
  groups: [],
};

describe('pickCurrentYear・buildMembership', () => {
  it('ロールも団体代表もなければ招待されていない', () => {
    const m = buildMembership(base);
    expect(isInvited(m)).toBe(false);
    expect(audiencesOf(m)).toEqual([]);
  });

  it('ロールか団体代表のある年度のうち、1日目が最も遅い年度を開く', () => {
    const src = { ...base, roles: [{ year_id: 'y8', role: 'admin' as const }], groups: [{ id: 'g', name: '2年2組', year_id: 'y7' }] };
    expect(pickCurrentYear(src)?.label).toBe('R8');
  });

  it('読める年度でも、自分の行がなければ選ばない', () => {
    const src = { ...base, roles: [{ year_id: 'y7', role: 'staff' as const }] };
    expect(pickCurrentYear(src)?.label).toBe('R7');
  });

  it('今の年度のロールと団体だけを持つ（ロールと団体代表は兼ねられる）', () => {
    const m = buildMembership({
      ...base,
      roles: [
        { year_id: 'y9', role: 'staff' },
        { year_id: 'y8', role: 'admin' },
      ],
      groups: [
        { id: 'g2', name: '電子研究部', year_id: 'y9' },
        { id: 'g1', name: '2年2組', year_id: 'y9' },
        { id: 'g0', name: '旧団体', year_id: 'y8' },
      ],
    });
    expect(m.year?.label).toBe('R9');
    expect(m.role).toBe('staff');
    expect(m.groups.map((g) => g.id)).toEqual(['g1', 'g2']);
    expect(audiencesOf(m)).toEqual(['staff', 'rep']);
    expect(hasAudience(m, ['admin'])).toBe(false);
    expect(hasAudience(m, ['rep'])).toBe(true);
  });

  it('団体代表だけの人', () => {
    const m = buildMembership({ ...base, groups: [{ id: 'g', name: 'テスト団体', year_id: 'y8' }] });
    expect(m.role).toBeNull();
    expect(audiencesOf(m)).toEqual(['rep']);
  });
});
