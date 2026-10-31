// お知らせの段の判定（04「共通レイアウト」の段の表・「お知らせ一覧」の書く・編集・削除、notes/T17.md「後半（画面）の約束」4。T17）
import { describe, expect, it } from 'vitest';
import type { YearStatus } from '@/lib/auth/membership';
import type { AppRole } from '@/lib/auth/roles';
import type { NoticeAudience } from '@/lib/data/notices';
import { canDeleteNotice, canEditNotice, canPinNotices, canWriteNotices, noticeAudiencesFor } from './permissions';

const ROLES: (AppRole | null)[] = ['admin', 'head', 'deputy_head', 'staff', 'viewer', null];
const STATUSES: YearStatus[] = ['preparing', 'requesting', 'allocating', 'confirmed', 'closed'];
const AUDIENCES: NoticeAudience[] = ['soumu', 'all_groups', 'groups'];
const LEAD = new Set<AppRole | null>(['admin', 'head', 'deputy_head']);
const ME = 'u-me';
const OTHER = 'u-other';

describe('T17 お知らせの段', () => {
  it('出せる宛先：部門長以上は3つ（02 の並び）、総務部門員は総務内だけ、閲覧のみ・ロールなしは何もない', () => {
    for (const r of ['admin', 'head', 'deputy_head'] as const) expect(noticeAudiencesFor(r)).toEqual(['soumu', 'all_groups', 'groups']);
    expect(noticeAudiencesFor('staff')).toEqual(['soumu']);
    expect(noticeAudiencesFor('viewer')).toEqual([]);
    expect(noticeAudiencesFor(null)).toEqual([]);
  });

  it('書ける：総務（管理者・総務部門長・総務副部門長・総務部門員）で、年度が終了でない（確定中も書ける）', () => {
    for (const role of ROLES) {
      for (const st of STATUSES) {
        const soumu = role !== null && role !== 'viewer';
        expect(canWriteNotices(role, st), `${role}・${st}`).toBe(soumu && st !== 'closed');
      }
    }
  });

  it('ピン留めの付け外し：部門長以上だけ', () => {
    for (const role of ROLES) expect(canPinNotices(role), String(role)).toBe(LEAD.has(role));
  });

  it('編集・削除の表（6 つの立場 × 5 つの状態 × 自分の／ほかの人の／書いた人なし × 3 つの宛先）', () => {
    for (const role of ROLES) {
      for (const status of STATUSES) {
        for (const author of [ME, OTHER, null]) {
          for (const audience of AUDIENCES) {
            const me = { role, status, userId: ME };
            const n = { created_by: author, audience };
            const label = `${role}・${status}・${author}・${audience}`;
            const writable = canWriteNotices(role, status);
            const mine = author === ME;
            // 部門長以上はどれも。総務部門員は、自分が書いた総務内のお知らせだけ編集、自分が書いたお知らせを削除
            expect(canEditNotice(n, me), label).toBe(writable && (LEAD.has(role) || (mine && audience === 'soumu')));
            expect(canDeleteNotice(n, me), label).toBe(writable && (LEAD.has(role) || mine));
          }
        }
      }
    }
  });

  it('総務部門員：自分が書いた団体あて（部門長以上だったときに出したもの）は削除だけ（編集は出さない。後半の判断したことの 5）', () => {
    const me = { role: 'staff' as const, status: 'requesting' as const, userId: ME };
    expect(canEditNotice({ created_by: ME, audience: 'all_groups' }, me)).toBe(false);
    expect(canDeleteNotice({ created_by: ME }, me)).toBe(true);
    expect(canEditNotice({ created_by: ME, audience: 'soumu' }, me)).toBe(true);
  });

  it('自分の user_id が分からなければ、総務部門員は自分のお知らせを見分けられないので出さない（部門長以上は出す）', () => {
    expect(canEditNotice({ created_by: null, audience: 'soumu' }, { role: 'staff', status: 'requesting', userId: null })).toBe(false);
    expect(canDeleteNotice({ created_by: null }, { role: 'staff', status: 'requesting', userId: null })).toBe(false);
    expect(canEditNotice({ created_by: null, audience: 'soumu' }, { role: 'head', status: 'requesting', userId: null })).toBe(true);
  });
});
