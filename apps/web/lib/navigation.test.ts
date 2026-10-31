import { describe, expect, it } from 'vitest';
import { APP_ROLES } from '@/lib/auth/roles';
import {
  ALLOCATION_BEFORE_FINAL_NOTE,
  audiencesFor,
  canOpen,
  finalOnlyNoteFor,
  isActivePath,
  NAV_ITEMS,
  navItemsFor,
  normalizePath,
  ROUTES,
  routeFor,
  SETTINGS_TABS,
  settingsTabsFor,
} from './navigation';

const labels = (a: Parameters<typeof navItemsFor>[0], s?: Parameters<typeof navItemsFor>[1]) => navItemsFor(a, s).map((i) => i.label);

const SOUMU_SCREENS = ['ホーム', 'マスタ設定', '在庫入力', '在庫一覧', '申請一覧', 'ルール', '振り分け', 'キャスター机交換', '履歴'];

describe('navItemsFor', () => {
  it('管理者は総務の画面をすべて見る（団体の画面は見ない）', () => {
    expect(labels(['admin'])).toEqual(SOUMU_SCREENS);
  });
  it('総務部門長・総務副部門長のナビは管理者と同じ（マスタ設定は段ごとのタブだけ。D-50）', () => {
    expect(labels(['head'])).toEqual(SOUMU_SCREENS);
    expect(labels(['deputy_head'])).toEqual(SOUMU_SCREENS);
    expect(labels(['head'], 'confirmed')).toEqual(SOUMU_SCREENS);
  });
  it('総務部門員は在庫・申請一覧と振り分け（いつでも読み取り。Q1）', () => {
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
  it('団体代表（店長・副店長）は申請と自団体の振り分け', () => {
    expect(labels(['rep'])).toEqual(['ホーム', '申請', '自団体の振り分け']);
  });
  it('兼ねた人（管理者・閲覧のみで店長・副店長も務める人。D-49）は両方', () => {
    expect(labels(['admin', 'rep'])).toEqual([...SOUMU_SCREENS, '申請', '自団体の振り分け']);
    expect(labels(['viewer', 'rep'], 'confirmed')).toEqual(['ホーム', '振り分け', '申請', '自団体の振り分け']);
  });
  it('立場がなければ何もない', () => {
    expect(labels([])).toEqual([]);
  });
  it('ホームはどの立場にも出る。全項目が ready（雛形のページがある）', () => {
    expect(NAV_ITEMS[0]?.href).toBe('/');
    expect(NAV_ITEMS.every((i) => i.ready)).toBe(true);
    for (const a of [...APP_ROLES, 'rep'] as const) expect(labels([a])[0]).toBe('ホーム');
  });
  it('QR の印刷はナビに出さない', () => {
    expect(NAV_ITEMS.map((i) => i.href)).not.toContain('/stocks/qr');
  });
});

describe('audiencesFor・canOpen（立場はロールの段から作る。D-50）', () => {
  it('クエリと末尾の / を無視してルートを引く', () => {
    expect(normalizePath('/stock/?room=abc#x')).toBe('/stock');
    expect(routeFor('/stocks/qr/?rooms=a,b')?.ticket).toBe('T10');
    expect(routeFor('/nothing')).toBeUndefined();
  });
  it('ページの立場：部門長以上・総務・振り分け（総務と確定後の閲覧のみ）・団体代表', () => {
    const LEAD = ['admin', 'head', 'deputy_head'];
    const SOUMU = [...LEAD, 'staff'];
    for (const href of ['/settings', '/rules', '/swaps', '/history']) expect(audiencesFor(href)).toEqual(LEAD);
    for (const href of ['/stock', '/stocks', '/stocks/qr', '/requests']) expect(audiencesFor(href)).toEqual(SOUMU);
    expect(audiencesFor('/allocation')).toEqual(SOUMU);
    expect(audiencesFor('/allocation', 'allocating')).toEqual(SOUMU);
    expect(audiencesFor('/allocation', 'confirmed')).toEqual([...SOUMU, 'viewer']);
    expect(audiencesFor('/allocation', 'closed')).toEqual([...SOUMU, 'viewer']);
    expect(audiencesFor('/request')).toEqual(['rep']);
    expect(audiencesFor('/my')).toEqual(['rep']);
    expect(audiencesFor('/')).toEqual([...APP_ROLES, 'rep']);
    expect(audiencesFor('/nothing')).toEqual([]);
  });
  it('どのルートの立場も、5つのロールと rep のどれか', () => {
    const known = new Set<string>([...APP_ROLES, 'rep']);
    for (const r of ROUTES) expect(r.audiences.every((a) => known.has(a))).toBe(true);
  });
  it('総務部門員は /swaps・/rules・/history を開けない（リンクにせず文字だけにする）。部門長以上は開ける', () => {
    expect(canOpen('/swaps', ['staff'])).toBe(false);
    expect(canOpen('/rules?code=S05', ['staff'])).toBe(false);
    expect(canOpen('/history', ['staff'])).toBe(false);
    for (const role of ['admin', 'head', 'deputy_head'] as const) {
      expect(canOpen('/rules?code=S05', [role])).toBe(true);
      expect(canOpen('/swaps', [role])).toBe(true);
      expect(canOpen('/history', [role])).toBe(true);
    }
    expect(canOpen('/stock?room=r1', ['staff'])).toBe(true);
    expect(canOpen('/stock?room=r1', ['viewer'])).toBe(false);
  });
  it('viewer の振り分け表は確定後だけ', () => {
    expect(canOpen('/allocation', ['viewer'], 'allocating')).toBe(false);
    expect(canOpen('/allocation', ['viewer'], 'confirmed')).toBe(true);
    expect(canOpen('/allocation', ['viewer'])).toBe(false);
  });
  it('兼ねた人は、どれかの立場で開ければ開ける', () => {
    expect(canOpen('/my?group=g', ['admin', 'rep'])).toBe(true);
    expect(canOpen('/settings', ['viewer', 'rep'])).toBe(false);
  });
  it('表にないパスは判定しない（真）', () => {
    expect(canOpen('/login/', [])).toBe(true);
  });
  it('どのルートにもチケットがある', () => {
    expect(ROUTES.every((r) => /^T\d+$/.test(r.ticket))).toBe(true);
  });
});

describe('マスタ設定のタブ（D-50）', () => {
  it('settingsTabsFor：管理者は7つ、総務部門長・総務副部門長は年度・場所・ユーザー、ほかは何もない', () => {
    expect(settingsTabsFor('admin')).toEqual(['years', 'rooms', 'items', 'groups', 'distance', 'users', 'export']);
    expect(settingsTabsFor('admin')).toEqual(SETTINGS_TABS);
    expect(settingsTabsFor('head')).toEqual(['years', 'rooms', 'users']);
    expect(settingsTabsFor('deputy_head')).toEqual(['years', 'rooms', 'users']);
    for (const r of ['staff', 'viewer', null, undefined] as const) expect(settingsTabsFor(r)).toEqual([]);
  });

  it('canOpen は /settings の ?tab= も見る：部門長・副部門長には団体・品目・距離・書き出しのタブへのリンクを出さない', () => {
    for (const role of ['head', 'deputy_head'] as const) {
      for (const tab of ['years', 'rooms', 'users']) expect(canOpen(`/settings?tab=${tab}`, [role])).toBe(true);
      for (const tab of ['items', 'groups', 'distance', 'export']) expect(canOpen(`/settings?tab=${tab}`, [role])).toBe(false);
      // tab のない /settings（と空の tab）は開ける（最初のタブ〔年度〕が出る）
      expect(canOpen('/settings', [role])).toBe(true);
      expect(canOpen('/settings?tab=', [role])).toBe(true);
    }
    for (const tab of SETTINGS_TABS) expect(canOpen(`/settings?tab=${tab}`, ['admin'])).toBe(true);
  });

  it('末尾の /・ほかのクエリ・ハッシュがあっても tab を読む。知らないタブは誰にもリンクにしない', () => {
    expect(canOpen('/settings/?tab=groups#x', ['head'])).toBe(false);
    expect(canOpen('/settings/?x=1&tab=rooms', ['head'])).toBe(true);
    expect(canOpen('/settings#tab=groups', ['head'])).toBe(true); // ハッシュの中はクエリではない
    expect(canOpen('/settings?tab=foo', ['admin'])).toBe(false);
  });

  it('マスタ設定を開けない立場は、どのタブも開けない。兼ねた人はロールで決まる', () => {
    for (const a of [['staff'], ['viewer'], ['rep'], ['viewer', 'rep']] as const) {
      expect(canOpen('/settings', a)).toBe(false);
      expect(canOpen('/settings?tab=years', a)).toBe(false);
    }
    expect(canOpen('/settings?tab=groups', ['admin', 'rep'])).toBe(true);
  });

  it('ページの守り（audiencesFor）はパスだけを見る（開けないタブは画面が最初のタブに戻す）', () => {
    expect(audiencesFor('/settings?tab=groups')).toEqual(['admin', 'head', 'deputy_head']);
  });
});

describe('finalOnlyNoteFor（確定前の閲覧のみ。04「共通レイアウト」）', () => {
  it('閲覧のみが確定前に振り分けを開くと「振り分けは確定後に表示されます。」', () => {
    expect(ALLOCATION_BEFORE_FINAL_NOTE).toBe('振り分けは確定後に表示されます。');
    for (const s of ['preparing', 'requesting', 'allocating', null, undefined] as const) {
      expect(finalOnlyNoteFor('/allocation/?view=group', ['viewer'], s)).toBe(ALLOCATION_BEFORE_FINAL_NOTE);
    }
    expect(finalOnlyNoteFor('/allocation', ['viewer', 'rep'], 'allocating')).toBe(ALLOCATION_BEFORE_FINAL_NOTE);
  });

  it('開ける・年度の状態によらず開けない・ほかの画面は null', () => {
    expect(finalOnlyNoteFor('/allocation', ['viewer'], 'confirmed')).toBeNull();
    expect(finalOnlyNoteFor('/allocation', ['viewer'], 'closed')).toBeNull();
    expect(finalOnlyNoteFor('/allocation', ['staff'], 'allocating')).toBeNull();
    expect(finalOnlyNoteFor('/allocation', ['rep'], 'allocating')).toBeNull();
    expect(finalOnlyNoteFor('/settings', ['viewer'], 'allocating')).toBeNull();
    expect(finalOnlyNoteFor('/nothing', ['viewer'], 'allocating')).toBeNull();
  });
});

describe('isActivePath', () => {
  it('末尾の / を無視する', () => {
    expect(isActivePath('/stocks/', '/stocks')).toBe(true);
    expect(isActivePath('/', '/')).toBe(true);
    expect(isActivePath('/stock/', '/stocks')).toBe(false);
  });
});
