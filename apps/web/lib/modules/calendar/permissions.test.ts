// 締切と予定の段の判定（04「締切と予定」・「共通レイアウト」の段の表、notes/T18.md「後半（画面）の約束」7。T18）
import { describe, expect, it } from 'vitest';
import type { YearStatus } from '@/lib/auth/membership';
import type { AppRole } from '@/lib/auth/roles';
import { canWriteEvents, seesEventAudience } from './permissions';

const ROLES: readonly (AppRole | null)[] = ['admin', 'head', 'deputy_head', 'staff', 'viewer', null];
const STATUSES: readonly YearStatus[] = ['preparing', 'requesting', 'allocating', 'confirmed', 'closed'];

describe('T18 canWriteEvents（登録・編集・削除。DB の private.can_lead と同じ）', () => {
  it.each(ROLES.flatMap((role) => STATUSES.map((status) => [role, status] as const)))('%s・%s', (role, status) => {
    const lead = role === 'admin' || role === 'head' || role === 'deputy_head';
    expect(canWriteEvents(role, status)).toBe(lead && status !== 'closed');
  });

  it('部門長以上は確定中も書ける（振り分けの入力でないので守りがない）。終了した年度・年度の状態が分からないときは書けない', () => {
    expect(canWriteEvents('head', 'confirmed')).toBe(true);
    expect(canWriteEvents('admin', 'closed')).toBe(false);
    expect(canWriteEvents('admin', null)).toBe(false);
    expect(canWriteEvents(undefined, 'requesting')).toBe(false);
  });
});

describe('T18 seesEventAudience（対象の印と絞り込み。総務だけ）', () => {
  it.each(ROLES)('%s', (role) => {
    expect(seesEventAudience(role)).toBe(role === 'admin' || role === 'head' || role === 'deputy_head' || role === 'staff');
  });
});
