import { describe, expect, it } from 'vitest';
import { isActivePath, NAV_ITEMS, navItemsFor } from './navigation';

const labels = (a: Parameters<typeof navItemsFor>[0]) => navItemsFor(a).map((i) => i.label);

describe('navItemsFor', () => {
  it('管理者は総務の画面をすべて見る（団体の画面は見ない）', () => {
    expect(labels(['admin'])).toEqual([
      'ホーム', 'マスタ設定', '在庫入力', '在庫一覧', '申請一覧', 'ルール', '振り分け', 'キャスター机交換', '履歴',
    ]);
  });
  it('部員は在庫と申請一覧だけ', () => {
    expect(labels(['staff'])).toEqual(['ホーム', '在庫入力', '在庫一覧', '申請一覧']);
  });
  it('団体代表は申請と自団体の振り分け', () => {
    expect(labels(['rep'])).toEqual(['ホーム', '申請', '自団体の振り分け']);
  });
  it('兼ねた人は両方', () => {
    expect(labels(['staff', 'rep'])).toEqual(['ホーム', '在庫入力', '在庫一覧', '申請一覧', '申請', '自団体の振り分け']);
  });
  it('立場がなければ何もない', () => {
    expect(labels([])).toEqual([]);
  });
  it('ホームはどの立場にも出る', () => {
    expect(NAV_ITEMS[0]?.href).toBe('/');
  });
});

describe('isActivePath', () => {
  it('末尾の / を無視する', () => {
    expect(isActivePath('/stocks/', '/stocks')).toBe(true);
    expect(isActivePath('/', '/')).toBe(true);
    expect(isActivePath('/stock/', '/stocks')).toBe(false);
  });
});
