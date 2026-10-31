import { describe, expect, it } from 'vitest';
import { consentGroupCounts, storageCounts, submissionCounts } from './counts';

const g = (id: string, name: string, sort_order: number) => ({ id, name, sort_order, category: 'stall' as const });
const room = (id: string, name: string, sort_order: number, is_storage = true) => ({ id, name, sort_order, is_storage });

describe('T16 submissionCounts（提出した団体）', () => {
  const groups = [g('g3', '模擬店03', 2), g('g1', '模擬店01', 1), g('g2b', '模擬店02', 2), g('g2a', '模擬店02', 2), g('g4', '部門01', 9)];

  it('submitted_at が空でない記録がある団体を数える。null の記録は未提出、年度にない団体の記録は数えない', () => {
    const s = submissionCounts(groups, [
      { group_id: 'g1', submitted_at: '2026-10-01T00:00:00Z' },
      { group_id: 'g3', submitted_at: null },
      { group_id: 'other-year', submitted_at: '2026-10-01T00:00:00Z' },
    ]);
    expect(s.submitted).toBe(1);
    expect(s.total).toBe(5);
    expect([...s.submittedGroupIds]).toEqual(['g1']);
    // 未提出は sort_order → 名前 → id の順（名前は UTF-16 のコード単位で比べる）
    expect(s.unsubmitted.map((x) => x.id)).toEqual(['g2a', 'g2b', 'g3', 'g4']);
  });

  it('団体がなければ 0／0。入力の配列は並べ替えない', () => {
    expect(submissionCounts([], [{ group_id: 'g1', submitted_at: 't' }])).toEqual({ submitted: 0, total: 0, submittedGroupIds: new Set(), unsubmitted: [] });
    const before = groups.map((x) => x.id);
    submissionCounts(groups, []);
    expect(groups.map((x) => x.id)).toEqual(before);
  });
});

describe('T16 storageCounts（在庫を数えた保管場所）', () => {
  const rooms = [room('r2', '1-2', 2), room('r1', '1-1', 1), room('gym', '体育館', 3, false), room('r3', '2-1', 4), room('r4', '2-2', 5)];

  it('保管場所でない場所と使用不可の場所を除く。在庫の行（場所×品目）が重なっても1か所。数えていない場所は場所の並び', () => {
    const s = storageCounts(
      rooms,
      [
        { room_id: 'r3', usable: false },
        { room_id: 'r1', usable: true },
      ],
      ['r1', 'r1', 'r1', 'gym', 'r3'],
    );
    expect(s.total).toBe(3); // r1・r2・r4
    expect(s.counted).toBe(1); // r1（r3 は使用不可、gym は保管場所でない）
    expect(s.uncounted.map((r) => r.id)).toEqual(['r2', 'r4']);
  });

  it('今年の使用の行がなければ使用可。保管場所がなければ 0／0', () => {
    expect(storageCounts(rooms, [], new Set(['r2'])).total).toBe(4);
    expect(storageCounts([room('gym', '体育館', 1, false)], [], [])).toEqual({ counted: 0, total: 0, uncounted: [] });
  });
});

describe('T16 consentGroupCounts（了承の状況ごとの団体の数）', () => {
  it('1つの団体に品目の組が2つで状況が違えば、それぞれの状況に入る。団体の数は重ねない', () => {
    expect(
      consentGroupCounts([
        { groupId: 'g1', status: 'asked' },
        { groupId: 'g1', status: 'accepted' },
        { groupId: 'g2', status: 'asked' },
        { groupId: 'g3', status: 'not_asked' },
        { groupId: 'g4', status: 'declined' },
        { groupId: 'g4', status: 'declined' },
      ]),
    ).toEqual({ groups: 4, notAsked: 1, asked: 2, accepted: 1, declined: 1 });
    expect(consentGroupCounts([])).toEqual({ groups: 0, notAsked: 0, asked: 0, accepted: 0, declined: 0 });
  });
});
