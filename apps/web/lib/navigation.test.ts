import { describe, expect, it } from 'vitest';
import { APP_ROLES } from '@/lib/auth/roles';
import {
  ALLOCATION_BEFORE_FINAL_NOTE,
  audiencesFor,
  canOpen,
  finalOnlyNoteFor,
  isActivePath,
  NAV_ITEMS,
  NAV_SECTIONS,
  navItemsFor,
  navSectionsFor,
  normalizePath,
  ROUTES,
  routeFor,
  SETTINGS_TABS,
  settingsTabsFor,
} from './navigation';

const labels = (a: Parameters<typeof navItemsFor>[0], s?: Parameters<typeof navItemsFor>[1]) => navItemsFor(a, s).map((i) => i.label);

/** 机椅子の見出しの総務の画面（部門長以上。T16 で机椅子の状況を足し、マスタ設定・履歴は共通の見出しへ） */
const FURNITURE_LEAD = ['机椅子の状況', '在庫入力', '在庫一覧', '申請一覧', 'ルール', '振り分け', 'キャスター机交換'];
/** お知らせの見出しの項目（T17。招待されている全員） */
const NOTICES = 'お知らせ一覧';
/** 締切と予定の見出しの項目（T18。招待されている全員。見出しと同じ言葉を縦に並べないよう「の一覧」を付ける） */
const CALENDAR = '締切と予定の一覧';
const SOUMU_SCREENS = ['ホーム', ...FURNITURE_LEAD, NOTICES, CALENDAR, 'マスタ設定', '履歴'];

describe('navItemsFor', () => {
  it('管理者は総務の画面をすべて見る（団体の画面は見ない）', () => {
    expect(labels(['admin'])).toEqual(SOUMU_SCREENS);
  });
  it('総務部門長・総務副部門長のナビは管理者と同じ（マスタ設定は段ごとのタブだけ。D-50）', () => {
    expect(labels(['head'])).toEqual(SOUMU_SCREENS);
    expect(labels(['deputy_head'])).toEqual(SOUMU_SCREENS);
    expect(labels(['head'], 'confirmed')).toEqual(SOUMU_SCREENS);
  });
  it('総務部門員は机椅子の状況・在庫・申請一覧と振り分け（いつでも読み取り。Q1）', () => {
    expect(labels(['staff'])).toEqual(['ホーム', '机椅子の状況', '在庫入力', '在庫一覧', '申請一覧', '振り分け', NOTICES, CALENDAR]);
    expect(labels(['staff'], 'requesting')).toEqual(['ホーム', '机椅子の状況', '在庫入力', '在庫一覧', '申請一覧', '振り分け', NOTICES, CALENDAR]);
  });
  it('閲覧のみは、確定・終了の年度でだけ振り分けを見る（Q1）', () => {
    expect(labels(['viewer'])).toEqual(['ホーム', NOTICES, CALENDAR]);
    expect(labels(['viewer'], 'requesting')).toEqual(['ホーム', NOTICES, CALENDAR]);
    expect(labels(['viewer'], 'allocating')).toEqual(['ホーム', NOTICES, CALENDAR]);
    expect(labels(['viewer'], 'confirmed')).toEqual(['ホーム', '振り分け', NOTICES, CALENDAR]);
    expect(labels(['viewer'], 'closed')).toEqual(['ホーム', '振り分け', NOTICES, CALENDAR]);
  });
  it('団体代表（店長・副店長）は申請と自団体の振り分け', () => {
    expect(labels(['rep'])).toEqual(['ホーム', '申請', '自団体の振り分け', NOTICES, CALENDAR]);
  });
  it('兼ねた人（管理者・閲覧のみで店長・副店長も務める人。D-49）は両方（団体の画面は机椅子の見出しの最後）', () => {
    expect(labels(['admin', 'rep'])).toEqual(['ホーム', ...FURNITURE_LEAD, '申請', '自団体の振り分け', NOTICES, CALENDAR, 'マスタ設定', '履歴']);
    expect(labels(['viewer', 'rep'], 'confirmed')).toEqual(['ホーム', '振り分け', '申請', '自団体の振り分け', NOTICES, CALENDAR]);
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

describe('T16 ナビの見出し（NAV_SECTIONS・navSectionsFor。04「共通レイアウト」、D-51・D-52）', () => {
  const headings = (a: Parameters<typeof navSectionsFor>[0], st?: Parameters<typeof navSectionsFor>[1]) =>
    navSectionsFor(a, st).map((x) => x.heading);
  const itemsOf = (a: Parameters<typeof navSectionsFor>[0], st?: Parameters<typeof navSectionsFor>[1]) =>
    Object.fromEntries(navSectionsFor(a, st).map((x) => [x.heading, x.items.map((i) => i.label)]));

  it('見出しはホーム → 機能（机椅子 → お知らせ〔T17〕→ 締切と予定〔T18〕）→ 共通の順', () => {
    expect(NAV_SECTIONS).toEqual([
      { id: 'home', heading: 'ホーム' },
      { id: 'furniture', heading: '机椅子' },
      { id: 'notices', heading: 'お知らせ' },
      { id: 'calendar', heading: '締切と予定' },
      { id: 'common', heading: '共通' },
    ]);
  });

  it('ROUTES は見出しごとにひと続きで、見出しは NAV_SECTIONS の順（navItemsFor の平らな並びと表示の並びが同じ）', () => {
    const order = NAV_SECTIONS.map((x) => x.id);
    const runs = ROUTES.map((r) => r.section).filter((sec, k, all) => k === 0 || all[k - 1] !== sec);
    expect(runs).toEqual(order);
  });

  it('各ルートの見出し：ホームは home、机椅子の画面は furniture、マスタ設定・履歴は common', () => {
    const sectionOf = (href: string) => routeFor(href)?.section;
    expect(sectionOf('/')).toBe('home');
    for (const href of ['/furniture', '/stock', '/stocks', '/stocks/qr', '/requests', '/rules', '/allocation', '/swaps', '/request', '/my']) {
      expect(sectionOf(href)).toBe('furniture');
    }
    expect(sectionOf('/notices')).toBe('notices');
    expect(sectionOf('/calendar')).toBe('calendar');
    expect(sectionOf('/settings')).toBe('common');
    expect(sectionOf('/history')).toBe('common');
    for (const item of NAV_ITEMS) expect(item.section).toBe(routeFor(item.href)?.section);
  });

  it('/furniture：「机椅子の状況」、総務（部門長以上と総務部門員）、ナビに出す、T16。ホームも T16', () => {
    const r = routeFor('/furniture/');
    expect(r).toMatchObject({ href: '/furniture', label: '机椅子の状況', section: 'furniture', nav: true, ticket: 'T16' });
    expect(audiencesFor('/furniture')).toEqual(['admin', 'head', 'deputy_head', 'staff']);
    expect(routeFor('/')?.ticket).toBe('T16');
    // 机椅子の見出しの最初の項目
    expect(NAV_ITEMS.filter((i) => i.section === 'furniture')[0]?.href).toBe('/furniture');
  });

  it('canOpen(/furniture)：総務は真、閲覧のみ・団体代表は偽（年度の状態によらない）', () => {
    for (const role of ['admin', 'head', 'deputy_head', 'staff'] as const) expect(canOpen('/furniture', [role])).toBe(true);
    for (const st of ['preparing', 'requesting', 'allocating', 'confirmed', 'closed'] as const) {
      expect(canOpen('/furniture', ['viewer'], st)).toBe(false);
      expect(canOpen('/furniture', ['rep'], st)).toBe(false);
      expect(canOpen('/furniture', ['viewer', 'rep'], st)).toBe(false);
    }
    expect(canOpen('/furniture', ['admin', 'rep'])).toBe(true);
  });

  it('管理者・総務部門長・総務副部門長：ホーム／机椅子の状況〜キャスター机交換／お知らせ一覧／締切と予定の一覧／マスタ設定・履歴', () => {
    for (const role of ['admin', 'head', 'deputy_head'] as const) {
      expect(headings([role])).toEqual(['ホーム', '机椅子', 'お知らせ', '締切と予定', '共通']);
      expect(itemsOf([role])).toEqual({
        ホーム: ['ホーム'],
        机椅子: FURNITURE_LEAD,
        お知らせ: [NOTICES],
        締切と予定: [CALENDAR],
        共通: ['マスタ設定', '履歴'],
      });
    }
  });

  it('総務部門員：共通の見出しがない（マスタ設定・履歴は部門長以上）。お知らせ一覧と締切と予定の一覧はある', () => {
    expect(headings(['staff'])).toEqual(['ホーム', '机椅子', 'お知らせ', '締切と予定']);
    expect(itemsOf(['staff'])).toEqual({
      ホーム: ['ホーム'],
      机椅子: ['机椅子の状況', '在庫入力', '在庫一覧', '申請一覧', '振り分け'],
      お知らせ: [NOTICES],
      締切と予定: [CALENDAR],
    });
  });

  it('閲覧のみ：受付中はホーム・お知らせ一覧・締切と予定の一覧、確定・終了で机椅子の見出しに振り分け', () => {
    expect(headings(['viewer'], 'requesting')).toEqual(['ホーム', 'お知らせ', '締切と予定']);
    expect(headings(['viewer'], 'allocating')).toEqual(['ホーム', 'お知らせ', '締切と予定']);
    for (const st of ['confirmed', 'closed'] as const) {
      expect(itemsOf(['viewer'], st)).toEqual({ ホーム: ['ホーム'], 机椅子: ['振り分け'], お知らせ: [NOTICES], 締切と予定: [CALENDAR] });
    }
  });

  it('店長・副店長：ホームと、机椅子の見出しに申請・自団体の振り分け、お知らせの見出しにお知らせ一覧、締切と予定の見出しに締切と予定の一覧', () => {
    expect(itemsOf(['rep'])).toEqual({ ホーム: ['ホーム'], 机椅子: ['申請', '自団体の振り分け'], お知らせ: [NOTICES], 締切と予定: [CALENDAR] });
  });

  it('管理者で店長も務める人：管理者の机椅子の見出しの最後に申請・自団体の振り分け。お知らせ一覧・締切と予定の一覧は1つずつ', () => {
    expect(itemsOf(['admin', 'rep'])).toEqual({
      ホーム: ['ホーム'],
      机椅子: [...FURNITURE_LEAD, '申請', '自団体の振り分け'],
      お知らせ: [NOTICES],
      締切と予定: [CALENDAR],
      共通: ['マスタ設定', '履歴'],
    });
    expect(labels(['admin', 'rep']).filter((l) => l === NOTICES)).toHaveLength(1);
    expect(labels(['admin', 'rep']).filter((l) => l === CALENDAR)).toHaveLength(1);
  });

  it('T17 /notices：「お知らせ一覧」、見出しは notices、招待されている全員（5つのロールと rep）、ナビに出す、T17', () => {
    const r = routeFor('/notices/');
    expect(r).toMatchObject({ href: '/notices', label: 'お知らせ一覧', section: 'notices', nav: true, ticket: 'T17' });
    expect(audiencesFor('/notices')).toEqual([...APP_ROLES, 'rep']);
    // お知らせの見出しの最初の項目（機能の入口）
    expect(NAV_ITEMS.filter((i) => i.section === 'notices').map((i) => i.href)).toEqual(['/notices']);
  });

  it('T17 canOpen(/notices)：招待されている全員が、年度の状態によらず開ける（?audience=・?notice= つきも）。立場がなければ開けない', () => {
    for (const a of [...APP_ROLES, 'rep'] as const) {
      for (const st of ['preparing', 'requesting', 'allocating', 'confirmed', 'closed'] as const) {
        expect(canOpen('/notices', [a], st), `${a}・${st}`).toBe(true);
        expect(canOpen('/notices?audience=soumu', [a], st)).toBe(true);
        expect(canOpen('/notices?notice=00000000-0000-4000-8000-000000000001', [a], st)).toBe(true);
      }
    }
    expect(canOpen('/notices', [])).toBe(false);
  });

  it('T18 /calendar：「締切と予定の一覧」、見出しは calendar、招待されている全員（5つのロールと rep）、ナビに出す、T18', () => {
    const r = routeFor('/calendar/');
    expect(r).toMatchObject({ href: '/calendar', label: '締切と予定の一覧', section: 'calendar', nav: true, ticket: 'T18' });
    expect(audiencesFor('/calendar')).toEqual([...APP_ROLES, 'rep']);
    expect(r?.finalOnly).toBeUndefined();
    // 締切と予定の見出しの項目は1つ（機能の入口。見出しと同じ言葉を縦に並べないよう「の一覧」。お知らせの「お知らせ一覧」と同じ形）
    expect(NAV_ITEMS.filter((i) => i.section === 'calendar').map((i) => [i.href, i.label])).toEqual([['/calendar', '締切と予定の一覧']]);
  });

  it('T18 canOpen(/calendar)：招待されている全員が、年度の状態によらず開ける（?event=・?past=・?kind= つきも）。立場がなければ開けない', () => {
    for (const a of [...APP_ROLES, 'rep'] as const) {
      for (const st of ['preparing', 'requesting', 'allocating', 'confirmed', 'closed'] as const) {
        expect(canOpen('/calendar', [a], st), `${a}・${st}`).toBe(true);
        expect(canOpen('/calendar?event=00000000-0000-4000-8000-000000000001', [a], st)).toBe(true);
        expect(canOpen('/calendar?past=1&kind=deadline&audience=all', [a], st)).toBe(true);
      }
    }
    expect(canOpen('/calendar', [])).toBe(false);
  });

  it('見出しごとの項目をつなぐと navItemsFor と同じ（どの立場・年度の状態でも）。項目のない見出しは出さない', () => {
    const cases: [Parameters<typeof navSectionsFor>[0], Parameters<typeof navSectionsFor>[1]][] = [];
    for (const a of [[], ['admin'], ['head'], ['deputy_head'], ['staff'], ['viewer'], ['rep'], ['admin', 'rep'], ['viewer', 'rep']] as const) {
      for (const st of [undefined, null, 'preparing', 'requesting', 'allocating', 'confirmed', 'closed'] as const) cases.push([a, st]);
    }
    for (const [a, st] of cases) {
      const sections = navSectionsFor(a, st);
      expect(sections.flatMap((x) => x.items)).toEqual(navItemsFor(a, st));
      for (const x of sections) expect(x.items.length).toBeGreaterThan(0);
    }
    expect(navSectionsFor([])).toEqual([]);
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
    for (const href of ['/furniture', '/stock', '/stocks', '/stocks/qr', '/requests']) expect(audiencesFor(href)).toEqual(SOUMU);
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
  it('T16 /furniture/ は机椅子の状況（ホームではない）', () => {
    expect(isActivePath('/furniture/', '/furniture')).toBe(true);
    expect(isActivePath('/furniture/', '/')).toBe(false);
    expect(isActivePath('/', '/furniture')).toBe(false);
  });
});
