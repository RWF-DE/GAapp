import { describe, expect, it } from 'vitest';
import { checkGroupNames, compareGroupsForReport, groupNameSchema } from './groups';

describe('groupNameSchema・checkGroupNames（D-27）', () => {
  it('SUMIF のワイルドカード・比較演算子・予約語を止める', () => {
    for (const n of ['a*b', '何?', 'x~y', '=A', ' <未定>', '>1', '(計)', '（計）', '使用不可', '余り', '残す', '']) {
      expect(groupNameSchema.safeParse(n).success, n).toBe(false);
    }
    for (const n of ['剣道部(飲食)', 'SE企画', '2年2組', '＊全角は可', 'a=b']) {
      expect(groupNameSchema.safeParse(n).success, n).toBe(true);
    }
  });

  it('NFKC・小文字で同じになる名前の重複', () => {
    const e = checkGroupNames([{ name: 'SE企画' }, { name: 'ｓｅ企画' }, { name: '残す' }]);
    expect(e.map((x) => x.path)).toEqual(['groups.1.name', 'groups.2.name']);
  });
});

describe('compareGroupsForReport（K-27）', () => {
  it('区分 → 提出日時（未提出は最後）→ sort_order → 名前 → id', () => {
    const g = (id: string, category: 'stall' | 'company', submittedAt: string | null, sortOrder = 1, name = id) => ({ id, name, category, submittedAt, sortOrder });
    const list = [
      g('c', 'company', '2026-07-01T00:00:00+09:00'),
      g('n', 'stall', null),
      g('late', 'stall', '2026-07-02T00:00:00+09:00'),
      g('early', 'stall', '2026-07-01T10:00:00+09:00'),
      g('utc', 'stall', '2026-07-01T00:30:00Z'), // 09:30 JST
    ];
    expect(list.sort(compareGroupsForReport).map((x) => x.id)).toEqual(['utc', 'early', 'late', 'n', 'c']);
  });
});
