import { describe, expect, it } from 'vitest';
import { audiencesFor, canOpen, isActivePath, NAV_ITEMS, navItemsFor, normalizePath, ROUTES, routeFor } from './navigation';

const labels = (a: Parameters<typeof navItemsFor>[0], s?: Parameters<typeof navItemsFor>[1]) => navItemsFor(a, s).map((i) => i.label);

describe('navItemsFor', () => {
  it('管理者は総務の画面をすべて見る（団体の画面は見ない）', () => {
    expect(labels(['admin'])).toEqual([
      'ホーム', 'マスタ設定', '在庫入力', '在庫一覧', '申請一覧', 'ルール', '振り分け', 'キャスター机交換', '履歴',
    ]);
  });
  it('部員は在庫・申請一覧と振り分け（いつでも読み取り。Q1）', () => {
    expect(labels(['staff'])).toEqual(['ホーム', '在庫入力', '在庫一覧', '申請一覧', '振り分け']);
    expect(labels(['staff'], 'requesting')).toEqual(['ホーム', '在庫入力', '在庫一覧', '申請一覧', '振り分け']);
  });
  it('閲覧のみは、確定・終了の年度でだけ振り分けを見る（Q1）', () => {
    expect(labels(['viewer'])).toEqual(['ホーム']);
    expect(labels(['viewer'], 'requesting')).toEqual(['ホーム']);
    expect(labels(['viewer'], 'allocating')).toEqual(['ホーム']);
    expect(labels(['viewer'], 'confirmed')).toEqual(['ホーム', '振り分け']);
    expect(labels(['viewer'], 'closed')).toEqual(['ホーム', '振り分け']);
  });
  it('団体代表は申請と自団体の振り分け', () => {
    expect(labels(['rep'])).toEqual(['ホーム', '申請', '自団体の振り分け']);
  });
  it('兼ねた人は両方', () => {
    expect(labels(['staff', 'rep'])).toEqual(['ホーム', '在庫入力', '在庫一覧', '申請一覧', '振り分け', '申請', '自団体の振り分け']);
  });
  it('立場がなければ何もない', () => {
    expect(labels([])).toEqual([]);
  });
  it('ホームはどの立場にも出る。全項目が ready（雛形のページがある）', () => {
    expect(NAV_ITEMS[0]?.href).toBe('/');
    expect(NAV_ITEMS.every((i) => i.ready)).toBe(true);
  });
  it('QR の印刷はナビに出さない', () => {
    expect(NAV_ITEMS.map((i) => i.href)).not.toContain('/stocks/qr');
  });
});

describe('audiencesFor・canOpen', () => {
  it('クエリと末尾の / を無視してルートを引く', () => {
    expect(normalizePath('/stock/?room=abc#x')).toBe('/stock');
    expect(routeFor('/stocks/qr/?rooms=a,b')?.ticket).toBe('T10');
    expect(routeFor('/nothing')).toBeUndefined();
  });
  it('ページの立場', () => {
    expect(audiencesFor('/stocks')).toEqual(['admin', 'staff']);
    expect(audiencesFor('/allocation')).toEqual(['admin', 'staff']);
    expect(audiencesFor('/allocation', 'confirmed')).toEqual(['admin', 'staff', 'viewer']);
    expect(audiencesFor('/nothing')).toEqual([]);
  });
  it('staff は /swaps・/rules を開けない（リンクにせず文字だけにする）', () => {
    expect(canOpen('/swaps', ['staff'])).toBe(false);
    expect(canOpen('/rules?code=S05', ['staff'])).toBe(false);
    expect(canOpen('/rules?code=S05', ['admin'])).toBe(true);
    expect(canOpen('/stock?room=r1', ['staff'])).toBe(true);
  });
  it('viewer の振り分け表は確定後だけ', () => {
    expect(canOpen('/allocation', ['viewer'], 'allocating')).toBe(false);
    expect(canOpen('/allocation', ['viewer'], 'confirmed')).toBe(true);
    expect(canOpen('/allocation', ['viewer'])).toBe(false);
  });
  it('兼ねた人は、どれかの立場で開ければ開ける', () => {
    expect(canOpen('/my?group=g', ['staff', 'rep'])).toBe(true);
    expect(canOpen('/settings', ['staff', 'rep'])).toBe(false);
  });
  it('表にないパスは判定しない（真）', () => {
    expect(canOpen('/login/', [])).toBe(true);
  });
  it('どのルートにもチケットがある', () => {
    expect(ROUTES.every((r) => /^T\d+$/.test(r.ticket))).toBe(true);
  });
});

describe('isActivePath', () => {
  it('末尾の / を無視する', () => {
    expect(isActivePath('/stocks/', '/stocks')).toBe(true);
    expect(isActivePath('/', '/')).toBe(true);
    expect(isActivePath('/stock/', '/stocks')).toBe(false);
  });
});
