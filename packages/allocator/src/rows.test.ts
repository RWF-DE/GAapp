import { describe, expect, it } from 'vitest';
import { FixtureBuilder } from '@gaapp/shared/testing';
import type { Candidate } from './candidates';
import { createContext } from './context';
import { toRows } from './rows';

describe('toRows（設計 10 章）', () => {
  const b = new FixtureBuilder('rows').room('X').room('Y').group('G', 'stall', 'X').group('H', 'stall', 'Y').stock('X', { desk: 9, desk_ng: 9 });
  const ix = b.ids();
  const c = createContext(b.input());
  if (!c.ok) throw new Error('ctx');
  const ctx = c.ctx;
  const v = (r: string, g: string, j: string, hat = false): Candidate => ({
    r: ix.roomId(r), g: ix.groupId(g), i: ix.itemId('desk'), j: ix.itemId(j), hat, ub: hat ? 9 : null, d: 0, e: 0, p: 0, cSub: 0 });

  it('x と x̂ と残すの行を (r,g,i,j) で足し、0 は出さず、isKeep は運び元 = 使用場所', () => {
    const keep = [{ sourceRoomId: ix.roomId('X'), groupId: ix.groupId('G'), itemId: ix.itemId('desk'), requestedItemId: ix.itemId('desk'), count: 4, isKeep: true }];
    const rows = toRows(ctx, [v('X', 'G', 'desk'), v('X', 'G', 'desk', true), v('X', 'H', 'desk'), v('X', 'H', 'desk_ng'), v('Y', 'G', 'desk')], [1, 2, 3, 0, 0], keep);
    expect(rows.map((r) => [ix.roomName.get(r.sourceRoomId), ix.groupName.get(r.groupId), ix.itemCode.get(r.itemId), r.count, r.isKeep])).toEqual([
      ['X', 'G', 'desk', 7, true],
      ['X', 'H', 'desk', 3, false],
    ]);
  });

  it('並びは 品目 → 運び元 → 団体 → 申請品目', () => {
    const rows = toRows(ctx, [v('Y', 'H', 'desk'), v('X', 'H', 'desk_ng'), v('X', 'H', 'desk'), v('X', 'G', 'desk')], [1, 1, 1, 1], []);
    expect(rows.map((r) => `${ix.itemCode.get(r.itemId)}:${ix.roomName.get(r.sourceRoomId)}:${ix.groupName.get(r.groupId)}`)).toEqual([
      'desk:X:G',
      'desk:X:H',
      'desk:Y:H',
      'desk_ng:X:H',
    ]);
  });
});
