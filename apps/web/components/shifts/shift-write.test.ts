// シフト表の書き込みの決め方（2.6 の (A)・(B1)・(B2)。04「シフト表」のエラーと読み直し。T20）：持ち場の 23505（名前の重複と送り直し）、
// 時間枠の楽観ロック、必要人数（送る前に読み直して同じなら送らない）、割り当て（23505 で読み直してほかのますなら busy）、移す、消す、
// 1日分（応答なしで読み直し、全部あれば作られていた・1つもなければ作られていない・読み直せなければ確かめるまで送らない・一部）。
import { describe, expect, it } from 'vitest';
import type { AssignmentRow, NeedRow } from '@/lib/data/shifts';
import { appError, AppError } from '@/lib/errors';
import { countPlannedIn, runAddDay, runAssign, runMove, runNeedSave, runRowDelete, runRowSave, verifyAddDay } from './shift-write';

const NETWORK = { code: '', message: 'TypeError: Failed to fetch' };
const DUP = new AppError({ kind: 'conflict', code: '23505', reason: null, details: null, issues: [], status: 409 });
const noAuth = async () => 'other' as const;
const fail = (e: unknown) => () => Promise.reject(e);

interface Duty {
  id: string;
  name: string;
  updated_at: string;
}
const duty = (over: Partial<Duty> = {}): Duty => ({ id: 'd1', name: '受付', updated_at: 'v1', ...over });
const same = (d: Duty) => d.name === '受付';

describe('T20 runRowSave（持ち場・時間枠）', () => {
  it('持ち場を足す：23505 で同じ id の持ち場がなければ名前の重複、あって同じなら足されていた、違えば conflict', async () => {
    expect(await runRowSave({ baseVersion: null, matches: same, send: fail(DUP), reread: async () => null, uniqueName: true }, noAuth)).toEqual({ type: 'duplicate' });
    expect(await runRowSave({ baseVersion: null, matches: same, send: fail(DUP), reread: async () => duty() }, noAuth)).toEqual({ type: 'saved', row: duty(), before: true });
    const other = duty({ name: '別' });
    expect(await runRowSave({ baseVersion: null, matches: same, send: fail(DUP), reread: async () => other, uniqueName: true }, noAuth)).toEqual({ type: 'conflict', row: other });
    // 応答なしで行がない：時間枠でも持ち場でも unknown（もう一度押すと同じ id で送る）
    expect(await runRowSave({ baseVersion: null, matches: same, send: fail(NETWORK), reread: async () => null, uniqueName: true }, noAuth)).toEqual({ type: 'unknown' });
  });

  it('持ち場を直す：23505 は名前の重複（読み直さない）。conflict・not_found・応答なしは締切と予定と同じ', async () => {
    expect(await runRowSave({ baseVersion: 'v1', matches: same, send: fail(DUP), reread: fail(new Error('呼ばない')), uniqueName: true }, noAuth)).toEqual({ type: 'duplicate' });
    const changed = duty({ name: '別', updated_at: 'v2' });
    expect(await runRowSave({ baseVersion: 'v1', matches: same, send: fail(appError('conflict', 'lock_conflict')), reread: async () => changed }, noAuth)).toEqual({ type: 'conflict', row: changed });
    expect(await runRowSave({ baseVersion: 'v1', matches: same, send: fail(appError('not_found', 'lock_missing')), reread: async () => null }, noAuth)).toEqual({ type: 'missing' });
    expect(await runRowSave({ baseVersion: 'v1', matches: same, send: fail(appError('conflict', 'lock_conflict')), reread: fail(NETWORK) }, noAuth)).toEqual({ type: 'unread' });
    expect(await runRowSave({ baseVersion: 'v1', matches: same, send: fail(NETWORK), reread: async () => duty({ name: '別' }) }, noAuth)).toEqual({ type: 'unknown' });
  });

  it('時間枠の重なり（invalid_input）・forbidden は failed', async () => {
    const overlap = new AppError({ kind: 'input', code: 'P0001', reason: 'invalid_input', details: { field: 'starts_at', reason: 'overlap', slot_id: 's9' }, issues: [], status: 400 });
    expect(await runRowSave({ baseVersion: null, matches: same, send: fail(overlap), reread: async () => null }, noAuth)).toEqual({ type: 'failed', error: overlap });
  });
});

describe('T20 runRowDelete・runNeedSave（(A)）', () => {
  it('消す：not_found は deleted（before）、conflict は changed、応答なしは読み直して決める', async () => {
    expect(await runRowDelete({ send: fail(appError('not_found', 'lock_missing')), reread: async () => null, baseVersion: 'v1' }, noAuth)).toEqual({ type: 'deleted', before: true });
    expect(await runRowDelete({ send: fail(appError('conflict', 'lock_conflict')), reread: async () => null, baseVersion: 'v1' }, noAuth)).toEqual({ type: 'changed' });
    expect(await runRowDelete({ send: fail(NETWORK), reread: async () => ({ updated_at: 'v1' }), baseVersion: 'v1' }, noAuth)).toEqual({ type: 'unknown' });
    expect(await runRowDelete({ send: fail(NETWORK), reread: async () => null, baseVersion: 'v1' }, noAuth)).toEqual({ type: 'deleted', before: false });
  });

  it('必要人数：送る前に読み直し、同じ数なら送らずに saved（before）。違えば upsert。読み直し・送信が届かなければ unknown', async () => {
    const need = (n: number): NeedRow => ({ slot_id: 's1', duty_id: 'd1', required_count: n, updated_at: 'v' });
    let sent = 0;
    const send = async () => {
      sent++;
      return need(3);
    };
    expect(await runNeedSave({ count: 3, reread: async () => need(3), send }, noAuth)).toEqual({ type: 'saved', row: need(3), before: true });
    expect(sent).toBe(0);
    expect(await runNeedSave({ count: 3, reread: async () => need(2), send }, noAuth)).toEqual({ type: 'saved', row: need(3), before: false });
    expect(await runNeedSave({ count: 3, reread: async () => null, send }, noAuth)).toMatchObject({ type: 'saved', before: false });
    expect(sent).toBe(2);
    expect(await runNeedSave({ count: 3, reread: fail(NETWORK), send }, noAuth)).toEqual({ type: 'unknown' });
    expect(await runNeedSave({ count: 3, reread: async () => null, send: fail(NETWORK) }, noAuth)).toEqual({ type: 'unknown' });
    const blocked = new AppError({ kind: 'blocked', code: '23503', reason: null, details: null, issues: [], status: 409 });
    expect(await runNeedSave({ count: 3, reread: async () => null, send: fail(blocked) }, noAuth)).toEqual({ type: 'failed', error: blocked });
  });
});

describe('T20 runAssign・runMove（割り当て）', () => {
  const a = (duty_id: string, updated_at = 'v1'): AssignmentRow => ({ slot_id: 's1', duty_id, user_id: 'u1', updated_at });

  it('23505・応答なし：読み直して入れようとしたますにいれば saved（before）、ほかのますなら busy、いなければ unknown', async () => {
    expect(await runAssign({ dutyId: 'd1', send: fail(DUP), reread: async () => a('d1') }, noAuth)).toEqual({ type: 'saved', row: a('d1'), before: true });
    expect(await runAssign({ dutyId: 'd1', send: fail(DUP), reread: async () => a('d2') }, noAuth)).toEqual({ type: 'busy', row: a('d2') });
    expect(await runAssign({ dutyId: 'd1', send: fail(NETWORK), reread: async () => null }, noAuth)).toEqual({ type: 'unknown' });
    expect(await runAssign({ dutyId: 'd1', send: fail(NETWORK), reread: fail(NETWORK) }, noAuth)).toEqual({ type: 'unknown' });
  });

  it('not_soumu（invalid_input）・23503 はそのまま failed', async () => {
    const notSoumu = new AppError({ kind: 'input', code: 'P0001', reason: 'invalid_input', details: { field: 'user_id', reason: 'not_soumu' }, issues: [], status: 400 });
    expect(await runAssign({ dutyId: 'd1', send: fail(notSoumu), reread: async () => null }, noAuth)).toEqual({ type: 'failed', error: notSoumu });
  });

  it('移す：止められた・応答なしで読み直し、移す先にいれば saved（before）、応答なしで版が同じなら unknown、ほかは changed', async () => {
    const lock = appError('conflict', 'lock_conflict');
    expect(await runMove({ dutyId: 'd2', baseVersion: 'v1', send: fail(lock), reread: async () => a('d2', 'v2') }, noAuth)).toMatchObject({ type: 'saved', before: true });
    expect(await runMove({ dutyId: 'd2', baseVersion: 'v1', send: fail(NETWORK), reread: async () => a('d1', 'v1') }, noAuth)).toEqual({ type: 'unknown' });
    expect(await runMove({ dutyId: 'd2', baseVersion: 'v1', send: fail(lock), reread: async () => a('d3', 'v2') }, noAuth)).toEqual({ type: 'changed', row: a('d3', 'v2') });
    expect(await runMove({ dutyId: 'd2', baseVersion: 'v1', send: fail(appError('not_found', 'lock_missing')), reread: async () => null }, noAuth)).toEqual({ type: 'changed', row: null });
  });
});

describe('T20 runAddDay・verifyAddDay（1日分。(B2)）', () => {
  const planned = [
    { starts_at: '2027-10-15T09:00:00+09:00', ends_at: '2027-10-15T10:00:00+09:00' },
    { starts_at: '2027-10-15T10:00:00+09:00', ends_at: '2027-10-15T11:00:00+09:00' },
  ];
  // DB は UTC で返す（同じ時刻かで比べる）
  const utc = [
    { starts_at: '2027-10-15T00:00:00+00:00', ends_at: '2027-10-15T01:00:00+00:00' },
    { starts_at: '2027-10-15T01:00:00+00:00', ends_at: '2027-10-15T02:00:00+00:00' },
  ];

  it('送れたら作った数。応答なしで読み直すと全部あれば created（before）、1つもなければ not-created、一部なら partial、読めなければ unverified', async () => {
    expect(await runAddDay({ planned, send: async () => [1, 2], rereadDay: async () => [] }, noAuth)).toEqual({ type: 'created', count: 2, before: false });
    expect(await runAddDay({ planned, send: fail(NETWORK), rereadDay: async () => utc }, noAuth)).toEqual({ type: 'created', count: 2, before: true });
    expect(await runAddDay({ planned, send: fail(NETWORK), rereadDay: async () => [] }, noAuth)).toEqual({ type: 'not-created' });
    expect(await runAddDay({ planned, send: fail(NETWORK), rereadDay: async () => [utc[0]!] }, noAuth)).toEqual({ type: 'partial' });
    expect(await runAddDay({ planned, send: fail(NETWORK), rereadDay: fail(NETWORK) }, noAuth)).toEqual({ type: 'unverified' });
    expect(await verifyAddDay(planned, async () => utc)).toEqual({ type: 'created', count: 2, before: true });
    expect(countPlannedIn(planned, [{ starts_at: '2027-10-15T00:00:00Z', ends_at: '2027-10-15T01:30:00Z' }])).toBe(0);
  });

  it('届いた失敗（invalid_input・forbidden）は failed（読み直さない）', async () => {
    const err = new AppError({ kind: 'input', code: 'P0001', reason: 'invalid_input', details: { field: 'slots', reason: 'overlap', ord: 2 }, issues: [], status: 400 });
    expect(await runAddDay({ planned, send: fail(err), rereadDay: fail(new Error('呼ばない')) }, noAuth)).toEqual({ type: 'failed', error: err });
  });
});
