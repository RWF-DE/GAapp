// 提出・取り消し・承認・差し戻しの (B1) の決め方（04「提出物」の書き込みの決まり。T19）と、前年度から写すの締切のずらし方（Q10。DB の
// previous_year_documents の new_deadline と同じ計算）。
import { describe, expect, it } from 'vitest';
import { copySummary, deadlineInRange, shiftDeadline } from './copy';
import { AFTER_STATUS, sameVersion, settleSubmissionOutcome } from './outcome';

const V1 = '2026-10-01T00:00:00.123456+00:00';
const V2 = '2026-10-01T00:00:01.000000+00:00';

describe('T19 settleSubmissionOutcome', () => {
  it('操作の後の状態：提出した → 提出済み、取り消し → 未提出、承認・紙 → 承認、差し戻し → 差し戻し', () => {
    expect(AFTER_STATUS).toEqual({ submit: 'submitted', withdraw: 'not_submitted', approve: 'approved', paper: 'approved', return: 'returned' });
  });

  it('読み直した提出が操作の後の状態なら done（ほかの人が同じ操作をしていても同じ）', () => {
    expect(settleSubmissionOutcome('submit', V1, { status: 'submitted', updated_at: V2, review_note: null })).toBe('done');
    expect(settleSubmissionOutcome('withdraw', V1, { status: 'not_submitted', updated_at: V2, review_note: '前の理由' })).toBe('done');
    expect(settleSubmissionOutcome('approve', null, { status: 'approved', updated_at: V2, review_note: 'メモ' })).toBe('done');
    expect(settleSubmissionOutcome('paper', V1, { status: 'approved', updated_at: V2, review_note: '紙で受け取りました' })).toBe('done');
  });

  it('差し戻しは理由も比べる（前後の空白は除いて）。理由が違えば版で決める', () => {
    const reread = { status: 'returned' as const, updated_at: V2, review_note: '印鑑がありません' };
    expect(settleSubmissionOutcome('return', V1, reread, '  印鑑がありません\n')).toBe('done');
    expect(settleSubmissionOutcome('return', V1, reread, '別の理由')).toBe('changed');
    expect(settleSubmissionOutcome('return', V2, reread, '別の理由')).toBe('unknown');
  });

  it('版がミリ秒まで同じなら unknown（もう一度押してもらう）、違えば changed。行がなければ版は null', () => {
    expect(settleSubmissionOutcome('submit', V1, { status: 'not_submitted', updated_at: '2026-10-01T00:00:00.123999+00:00', review_note: null })).toBe('unknown');
    expect(settleSubmissionOutcome('submit', V1, { status: 'not_submitted', updated_at: V2, review_note: null })).toBe('changed');
    expect(settleSubmissionOutcome('submit', null, { status: null, updated_at: null, review_note: null })).toBe('unknown');
    expect(settleSubmissionOutcome('submit', null, { status: 'returned', updated_at: V2, review_note: 'x' })).toBe('changed');
    // 読み直すと提出物が消えていた・対象から外れた（null）：前に行があれば changed
    expect(settleSubmissionOutcome('approve', V1, null)).toBe('changed');
  });

  it('sameVersion：ミリ秒まで比べ（マイクロ秒は見ない。DB の date_trunc と同じ）、どちらも null なら同じ', () => {
    expect(sameVersion('2026-10-01T00:00:00.123456+00:00', '2026-10-01 00:00:00.123+00')).toBe(true);
    expect(sameVersion('2026-10-01T09:00:00+09:00', '2026-10-01T00:00:00Z')).toBe(true);
    expect(sameVersion(V1, null)).toBe(false);
    expect(sameVersion(null, undefined)).toBe(true);
    expect(sameVersion('x', 'x')).toBe(true);
    expect(sameVersion('x', 'y')).toBe(false);
  });
});

describe('T19 前年度から写すの締切（shiftDeadline・deadlineInRange・copySummary）', () => {
  it('1日目の差の日数だけずらし、Asia/Tokyo の時刻は同じ（月・年の境目、うるう日も暦のとおり）', () => {
    // R8 の1日目 2026-10-17（土）→ R9 の1日目 2027-10-16（土）：364 日前へ
    expect(shiftDeadline('2026-10-05T08:00:00Z', '2026-10-17', '2027-10-16')).toBe('2027-10-04T17:00:00+09:00');
    // Asia/Tokyo の 0:30（UTC の前の日）も Asia/Tokyo の日付でずらす
    expect(shiftDeadline('2026-09-30T15:30:00Z', '2026-10-17', '2027-10-16')).toBe('2027-09-30T00:30:00+09:00');
    // うるう年をまたぐ（2028-02-29 を含む）
    expect(shiftDeadline('2027-02-28T08:00:00Z', '2027-10-16', '2028-10-14')).toBe('2028-02-27T17:00:00+09:00');
    // 前の年度へ（1日目が前）
    expect(shiftDeadline('2027-10-04T08:00:00Z', '2027-10-16', '2026-10-17')).toBe('2026-10-05T17:00:00+09:00');
    expect(shiftDeadline('oops', '2026-10-17', '2027-10-16')).toBeNull();
    expect(shiftDeadline('2026-10-05T08:00:00Z', '2026-13-01', '2027-10-16')).toBeNull();
  });

  it('締切の範囲は Asia/Tokyo の 2000-01-01〜2200-12-31（DB の documents_deadline_check）', () => {
    expect(deadlineInRange('1999-12-31T15:00:00Z')).toBe(true); // 2000-01-01 00:00（Asia/Tokyo）
    expect(deadlineInRange('1999-12-31T14:59:59Z')).toBe(false);
    expect(deadlineInRange('2200-12-31T14:59:59Z')).toBe(true);
    expect(deadlineInRange('2200-12-31T15:00:00Z')).toBe(false); // 2201-01-01（Asia/Tokyo）
    expect(deadlineInRange('x')).toBe(false);
  });

  it('copySummary：「{N} 件を写しました」と、写らなかった同じ題名の数', () => {
    expect(copySummary(3, 3)).toBe('3 件を写しました');
    expect(copySummary(3, 1)).toBe('1 件を写しました（同じ題名の 2 件は写しませんでした）');
    expect(copySummary(0, 0)).toBe('0 件を写しました');
  });
});
