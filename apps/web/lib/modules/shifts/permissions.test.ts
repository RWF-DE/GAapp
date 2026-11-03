// シフト・作業の段（04「シフト表」「作業一覧」、02「シフト・作業の権限」。T20）：6 つの立場 × 5 つの状態。画面は DB（can_lead・
// set_task_status）より広く出さない。
import { describe, expect, it } from 'vitest';
import type { AppRole, YearStatus } from '@/lib/auth/membership';
import { canEditShifts, canEditTasks, canSetTaskStatus, seesMemberRoles } from './permissions';

const ROLES: (AppRole | null)[] = ['admin', 'head', 'deputy_head', 'staff', 'viewer', null];
const STATUSES: YearStatus[] = ['preparing', 'requesting', 'allocating', 'confirmed', 'closed'];
const LEAD: (AppRole | null)[] = ['admin', 'head', 'deputy_head'];

describe('T20 シフト・作業の段', () => {
  it.each(ROLES)('%s：時間枠・持ち場・ます・割り当てと作業を書けるのは部門長以上で終了でないとき（確定中も書ける）', (role) => {
    for (const st of STATUSES) {
      const expected = LEAD.includes(role) && st !== 'closed';
      expect(canEditShifts(role, st), `${role}・${st}`).toBe(expected);
      expect(canEditTasks(role, st), `${role}・${st}`).toBe(expected);
    }
    expect(canEditShifts(role, null)).toBe(false);
  });

  it.each(ROLES)('%s：作業の状態は総務で終了でなく、部門長以上か担当者が自分（担当者なしは部門長以上だけ）', (role) => {
    for (const st of STATUSES) {
      const open = st !== 'closed';
      const soumu = role !== null && role !== 'viewer';
      expect(canSetTaskStatus(role, st, { assignee_id: 'me' }, 'me'), `${role}・${st}・自分`).toBe(soumu && open);
      expect(canSetTaskStatus(role, st, { assignee_id: 'other' }, 'me'), `${role}・${st}・ほか`).toBe(LEAD.includes(role) && open);
      expect(canSetTaskStatus(role, st, { assignee_id: null }, 'me'), `${role}・${st}・なし`).toBe(LEAD.includes(role) && open);
    }
    expect(canSetTaskStatus(role, 'requesting', { assignee_id: 'me' }, null)).toBe(LEAD.includes(role));
  });

  it('割り当て・担当者のロールを見分けるのは部門長以上だけ（year_roles を年度の全部読める）', () => {
    expect(ROLES.map(seesMemberRoles)).toEqual([true, true, true, false, false, false]);
  });
});
