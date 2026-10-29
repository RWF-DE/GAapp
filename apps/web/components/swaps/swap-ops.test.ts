import { describe, expect, it } from 'vitest';
import { swapOps } from './swap-ops';

const ops = (status: 'not_asked' | 'asked' | 'accepted' | 'declined', current: number, asked: number | null, allocating = true) =>
  swapOps({ status, current, asked }, allocating).map((o) => (o.disabledReason ? `${o.label}（押せない）` : o.label));

describe('swapOps（キャスター机交換の操作）', () => {
  it('未依頼：依頼済みにする・了承・拒否（未依頼に戻すはない）', () => {
    expect(ops('not_asked', 6, null)).toEqual(['依頼済みにする', '了承', '拒否']);
  });

  it('置き換えの行がなければ依頼できない', () => {
    expect(ops('not_asked', 0, null)).toEqual(['依頼済みにする（押せない）', '了承', '拒否']);
  });

  it('依頼済み：了承・拒否・未依頼に戻す。依頼の後に増えたら依頼し直すが出て、了承は押せない', () => {
    expect(ops('asked', 6, 6)).toEqual(['了承', '拒否', '未依頼に戻す']);
    expect(ops('asked', 8, 6)).toEqual(['依頼し直す', '了承（押せない）', '拒否', '未依頼に戻す']);
  });

  it('了承：「未依頼に戻す」を出さない（了承で固定した行が固定のまま残るため）', () => {
    expect(ops('accepted', 6, 6)).toEqual(['拒否']);
    expect(ops('accepted', 8, 6)).toEqual(['依頼し直す', '拒否']);
    expect(ops('accepted', 6, null)).toEqual(['依頼し直す', '拒否']);
    for (const [cur, asked] of [
      [0, null],
      [6, 6],
      [8, 6],
    ] as const) {
      expect(swapOps({ status: 'accepted', current: cur, asked }, true).map((o) => o.op)).not.toContain('not_asked');
    }
  });

  it('拒否：了承・未依頼に戻す（置き換えが残っていれば依頼し直すも）', () => {
    expect(ops('declined', 0, 6)).toEqual(['了承', '未依頼に戻す']);
    expect(ops('declined', 6, 6)).toEqual(['了承', '未依頼に戻す']);
  });

  it('振り分け中でなければ何も出さない（読み取り）', () => {
    expect(ops('asked', 6, 6, false)).toEqual([]);
    expect(ops('not_asked', 6, null, false)).toEqual([]);
  });
});
