// ロールの段（D-48・D-50）：一覧の中身と並び、段の判定、扱えるロールと招待の立場
import { Constants } from '@gaapp/shared';
import { describe, expect, it } from 'vitest';
import {
  APP_ROLES,
  canRevokeInvitation,
  GROUP_ROLES,
  inviteKindsFor,
  isAdmin,
  isGroupRole,
  isLead,
  isSoumu,
  LEAD_ROLES,
  manageableRoles,
  SOUMU_ROLES,
  type AppRole,
} from './roles';

const ALL: (AppRole | null | undefined)[] = ['admin', 'head', 'deputy_head', 'staff', 'viewer', null, undefined];
const pick = (f: (r: AppRole | null | undefined) => boolean) => ALL.filter(f);

describe('ロールの一覧', () => {
  it('APP_ROLES・GROUP_ROLES は DB の列挙と同じ中身・同じ並び（supabase gen types の Constants）', () => {
    expect(APP_ROLES).toEqual([...Constants.public.Enums.app_role]);
    expect(APP_ROLES).toEqual(['admin', 'head', 'deputy_head', 'staff', 'viewer']);
    expect(GROUP_ROLES).toEqual([...Constants.public.Enums.group_role]);
    expect(GROUP_ROLES).toEqual(['manager', 'deputy_manager']);
  });

  it('部門長以上（lead）は admin・head・deputy_head、総務（soumu）はそれと staff（DB のロールの配列と同じ）', () => {
    expect(LEAD_ROLES).toEqual(['admin', 'head', 'deputy_head']);
    expect(SOUMU_ROLES).toEqual(['admin', 'head', 'deputy_head', 'staff']);
  });
});

describe('段の判定', () => {
  it('isAdmin は admin だけ', () => {
    expect(pick(isAdmin)).toEqual(['admin']);
  });
  it('isLead は admin・head・deputy_head（staff・viewer・ロールなしは偽）', () => {
    expect(pick(isLead)).toEqual(['admin', 'head', 'deputy_head']);
  });
  it('isSoumu は部門長以上と staff（viewer・ロールなしは偽）', () => {
    expect(pick(isSoumu)).toEqual(['admin', 'head', 'deputy_head', 'staff']);
  });
  it('isGroupRole は店長・副店長だけ（ロール・空・知らない値は偽）', () => {
    expect(isGroupRole('manager')).toBe(true);
    expect(isGroupRole('deputy_manager')).toBe(true);
    for (const v of ['admin', 'staff', 'rep', '', null, undefined]) expect(isGroupRole(v)).toBe(false);
  });
});

describe('扱えるロールと招待の立場（D-50）', () => {
  it('manageableRoles：管理者は5つ、部門長・副部門長は総務部門員だけ、ほかは何もない', () => {
    expect(manageableRoles('admin')).toEqual(['admin', 'head', 'deputy_head', 'staff', 'viewer']);
    expect(manageableRoles('head')).toEqual(['staff']);
    expect(manageableRoles('deputy_head')).toEqual(['staff']);
    for (const r of ['staff', 'viewer', null, undefined] as const) expect(manageableRoles(r)).toEqual([]);
  });

  it('inviteKindsFor：管理者は7つ、部門長・副部門長は総務部門員・店長・副店長、ほかは何もない', () => {
    expect(inviteKindsFor('admin')).toEqual(['admin', 'head', 'deputy_head', 'staff', 'viewer', 'manager', 'deputy_manager']);
    expect(inviteKindsFor('head')).toEqual(['staff', 'manager', 'deputy_manager']);
    expect(inviteKindsFor('deputy_head')).toEqual(['staff', 'manager', 'deputy_manager']);
    for (const r of ['staff', 'viewer', null, undefined] as const) expect(inviteKindsFor(r)).toEqual([]);
  });

  it('canRevokeInvitation：管理者はすべて、部門長・副部門長は総務部門員の招待と団体の招待、ほかは何もない', () => {
    const revocable = (actor: AppRole | null | undefined) => [
      ...APP_ROLES.filter((role) => canRevokeInvitation(actor, { role })),
      ...(canRevokeInvitation(actor, { role: null }) ? ['group'] : []),
    ];
    expect(revocable('admin')).toEqual(['admin', 'head', 'deputy_head', 'staff', 'viewer', 'group']);
    expect(revocable('head')).toEqual(['staff', 'group']);
    expect(revocable('deputy_head')).toEqual(['staff', 'group']);
    for (const r of ['staff', 'viewer', null, undefined] as const) expect(revocable(r)).toEqual([]);
  });
});
