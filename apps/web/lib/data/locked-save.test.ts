import { describe, expect, it, vi } from 'vitest';
import { appError } from '@/lib/errors';
import { isLockRejection, settleLockedWrite } from './locked-save';

interface R {
  name: string;
  updated_at: string;
}

const T0 = '2026-10-29T01:02:03.123456+00:00';
const T1 = '2026-10-29T01:02:04.654321+00:00';

const settle = (row: R | null | Error, input: string, baseVersion: string | null) =>
  settleLockedWrite<R>({
    reread: () => (row instanceof Error ? Promise.reject(row) : Promise.resolve(row)),
    matches: (r) => r.name === input,
    baseVersion,
    versionOf: (r) => r.updated_at,
  });

describe('settleLockedWrite（楽観ロックの更新・一意のキーの insert の読み直し。2.6 の (B1)）', () => {
  it('更新：読み直した行が入力と同じなら saved（前の送信が後から通っていた）', async () => {
    expect(await settle({ name: '新', updated_at: T1 }, '新', T0)).toBe('saved');
  });

  it('更新：入力と同じなら版が入力の元のままでも saved（入力が元と同じだった）', async () => {
    expect(await settle({ name: '新', updated_at: T0 }, '新', T0)).toBe('saved');
  });

  it('更新：入力と違い、版が入力の元のまま → not-saved（誰も保存していない）', async () => {
    expect(await settle({ name: '元', updated_at: T0 }, '新', T0)).toBe('not-saved');
  });

  it('更新：入力と違い、版が進んだ → changed（ほかの人の変更。自分の前の送信の値が違うときもここ）', async () => {
    expect(await settle({ name: '他', updated_at: T1 }, '新', T0)).toBe('changed');
  });

  it('更新：行がなくなった → changed（not_found の後も同じ）', async () => {
    expect(await settle(null, '新', T0)).toBe('changed');
  });

  it('insert：行がない（入力の元も null）→ not-saved', async () => {
    expect(await settle(null, '新', null)).toBe('not-saved');
  });

  it('insert：一意のキーの行ができていて入力と同じ → saved（23505 の後でも）', async () => {
    expect(await settle({ name: '新', updated_at: T1 }, '新', null)).toBe('saved');
  });

  it('insert：一意のキーの行ができていて入力と違う → changed（ほかの人が先に足した）', async () => {
    expect(await settle({ name: '他', updated_at: T1 }, '新', null)).toBe('changed');
  });

  it('reread が投げたら unread（matches・versionOf は呼ばない）', async () => {
    const matches = vi.fn(() => true);
    const versionOf = vi.fn(() => T0);
    const out = await settleLockedWrite<R>({
      reread: () => Promise.reject(appError('network', 'fetch_failed')),
      matches,
      baseVersion: T0,
      versionOf,
    });
    expect(out).toBe('unread');
    expect(matches).not.toHaveBeenCalled();
    expect(versionOf).not.toHaveBeenCalled();
    expect(await settle(new TypeError('Failed to fetch'), '新', T0)).toBe('unread');
  });

  it('reread は1回だけ呼ぶ', async () => {
    const reread = vi.fn(() => Promise.resolve<R | null>({ name: '元', updated_at: T0 }));
    await settleLockedWrite<R>({ reread, matches: () => false, baseVersion: T0, versionOf: (r) => r.updated_at });
    expect(reread).toHaveBeenCalledTimes(1);
  });

  it('版は受け取った文字列のまま比べる（マイクロ秒が違えば changed）', async () => {
    expect(await settle({ name: '他', updated_at: '2026-10-29T01:02:03.123457+00:00' }, '新', T0)).toBe('changed');
  });
});

describe('isLockRejection', () => {
  it('conflict（lock_conflict・23505・P0001 の conflict）と not_found（lock_missing）は真', () => {
    expect(isLockRejection(appError('conflict', 'lock_conflict'))).toBe(true);
    expect(isLockRejection(appError('not_found', 'lock_missing'))).toBe(true);
    expect(isLockRejection({ code: '23505', message: 'duplicate key value violates unique constraint' }, 409)).toBe(true);
    expect(isLockRejection({ code: 'P0001', message: 'conflict', details: '' })).toBe(true);
  });

  it('forbidden（lock_unchanged・42501）・通信の失敗・ほかの失敗は偽', () => {
    expect(isLockRejection(appError('forbidden', 'lock_unchanged'))).toBe(false);
    expect(isLockRejection({ code: '42501', message: 'new row violates row-level security policy' }, 403)).toBe(false);
    expect(isLockRejection({ code: '', message: 'TypeError: Failed to fetch' }, 0)).toBe(false);
    expect(isLockRejection(new TypeError('Failed to fetch'))).toBe(false);
    expect(isLockRejection({ code: '23503', message: 'fk' })).toBe(false);
    expect(isLockRejection({ code: '40P01', message: 'deadlock' })).toBe(false);
  });
});
