import { describe, expect, it } from 'vitest';
import {
  audiencesOf,
  buildMembership,
  GROUP_ROLE_LABELS,
  groupPositionLabel,
  hasAudience,
  isInvited,
  isLatestYear,
  latestWritableYear,
  pickCurrentYear,
  positionLabels,
  ROLE_LABELS,
  yearOptionLabel,
  type MembershipSource,
} from './membership';

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
    const src = { ...base, roles: [{ year_id: 'y8', role: 'admin' as const }], groups: [{ id: 'g', name: '2年2組', year_id: 'y7', role: 'manager' as const }] };
    expect(pickCurrentYear(src)?.label).toBe('R8');
  });

  it('読める年度でも、自分の行がなければ選ばない', () => {
    const src = { ...base, roles: [{ year_id: 'y7', role: 'staff' as const }] };
    expect(pickCurrentYear(src)?.label).toBe('R7');
  });

  it('今の年度のロールと団体だけを持つ（管理者・閲覧のみは店長・副店長を兼ねられる）。団体ごとの立場（店長・副店長）を残す', () => {
    const m = buildMembership({
      ...base,
      roles: [
        { year_id: 'y9', role: 'viewer' },
        { year_id: 'y8', role: 'admin' },
      ],
      groups: [
        { id: 'g2', name: '電子研究部', year_id: 'y9', role: 'deputy_manager' },
        { id: 'g1', name: '2年2組', year_id: 'y9', role: 'manager' },
        { id: 'g0', name: '旧団体', year_id: 'y8', role: 'manager' },
      ],
    });
    expect(m.year?.label).toBe('R9');
    expect(m.role).toBe('viewer');
    expect(m.groups.map((g) => [g.id, g.role])).toEqual([
      ['g1', 'manager'],
      ['g2', 'deputy_manager'],
    ]);
    expect(audiencesOf(m)).toEqual(['viewer', 'rep']);
    expect(hasAudience(m, ['admin'])).toBe(false);
    expect(hasAudience(m, ['rep'])).toBe(true);
    expect(positionLabels(m)).toEqual(['閲覧のみ', '2年2組 の店長', '電子研究部 の副店長']);
  });

  it('団体代表だけの人（店長も副店長も立場は rep）', () => {
    const m = buildMembership({ ...base, groups: [{ id: 'g', name: 'テスト団体', year_id: 'y8', role: 'deputy_manager' }] });
    expect(m.role).toBeNull();
    expect(audiencesOf(m)).toEqual(['rep']);
    expect(positionLabels(m)).toEqual(['テスト団体 の副店長']);
  });

  it('総務部門長・総務副部門長は、ロールの立場（団体代表の立場はない）', () => {
    for (const role of ['head', 'deputy_head'] as const) {
      const m = buildMembership({ ...base, roles: [{ year_id: 'y8', role }] });
      expect(audiencesOf(m)).toEqual([role]);
      expect(m.adminOfOpenYear).toBe(false); // 年度をまたぐ表（場所・品目・距離）は管理者だけ（D-01）
    }
    expect(positionLabels(buildMembership({ ...base, roles: [{ year_id: 'y8', role: 'head' }] }))).toEqual(['総務部門長']);
  });
});

describe('選んだ年度（D-31）', () => {
  const src: MembershipSource = {
    ...base,
    years: [
      { id: 'y8', label: 'R8', festival_start: '2026-10-17', status: 'closed' },
      { id: 'y9', label: 'R9', festival_start: '2027-10-16', status: 'preparing' },
      { id: 'y7', label: 'R7', festival_start: '2025-10-18', status: 'closed' },
    ],
    roles: [
      { year_id: 'y8', role: 'admin' },
      { year_id: 'y9', role: 'staff' },
    ],
  };

  it('自分の年度を1日目の新しい順に持ち、既定は最新の年度', () => {
    const m = buildMembership(src);
    expect(m.years.map((y) => y.label)).toEqual(['R9', 'R8']);
    expect(m.latestYear?.id).toBe('y9');
    expect(m.year?.id).toBe('y9');
    expect(isLatestYear(m)).toBe(true);
  });

  it('選んだ年度を開き、その年度のロールで立場を決める', () => {
    const m = buildMembership(src, 'y8');
    expect(m.year?.label).toBe('R8');
    expect(m.role).toBe('admin');
    expect(isLatestYear(m)).toBe(false);
    expect(latestWritableYear(m)?.label).toBe('R9');
  });

  it('選んだ年度にロールも団体代表もなければ既定の年度に戻る', () => {
    expect(buildMembership(src, 'y7').year?.id).toBe('y9');
    expect(buildMembership(src, 'no-such-year').year?.id).toBe('y9');
  });

  it('adminOfOpenYear は closed でない年度のどれかで admin のとき', () => {
    expect(buildMembership(src).adminOfOpenYear).toBe(false); // admin は終了した R8 だけ
    const open = { ...src, roles: [...src.roles, { year_id: 'y9', role: 'admin' as const }] };
    expect(buildMembership(open, 'y8').adminOfOpenYear).toBe(true);
  });

  it('最新の年度が終了していれば、切り替え先（書ける最新の年度）はない', () => {
    const m = buildMembership({ ...src, roles: [{ year_id: 'y8', role: 'admin' }] });
    expect(latestWritableYear(m)).toBeNull();
  });

  it('年度の選択肢の文字', () => {
    expect(yearOptionLabel({ label: 'R9', status: 'preparing' })).toBe('R9（準備中）');
  });
});

describe('表示名（02「列挙型」。T15b）', () => {
  it('ロールの表示名', () => {
    expect(ROLE_LABELS).toEqual({
      admin: '管理者',
      head: '総務部門長',
      deputy_head: '総務副部門長',
      staff: '総務部門員',
      viewer: '閲覧のみ',
    });
  });

  it('団体代表の立場の表示名と「{団体名} の店長・副店長」', () => {
    expect(GROUP_ROLE_LABELS).toEqual({ manager: '店長', deputy_manager: '副店長' });
    expect(groupPositionLabel({ name: '2年2組', role: 'manager' })).toBe('2年2組 の店長');
    expect(groupPositionLabel({ name: '電子研究部', role: 'deputy_manager' })).toBe('電子研究部 の副店長');
  });

  it('立場の表示：ロール → 団体の順。どちらもなければ空', () => {
    expect(positionLabels({ role: 'admin', groups: [{ id: 'g', name: '模擬店01', year_id: 'y8', role: 'manager' }] })).toEqual([
      '管理者',
      '模擬店01 の店長',
    ]);
    expect(positionLabels({ role: null, groups: [] })).toEqual([]);
  });
});
