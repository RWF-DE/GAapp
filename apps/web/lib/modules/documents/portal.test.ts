// 提出物がダッシュボード（/）に出すもの（04「提出状況」の節の後の「ダッシュボードに出すもの（提出物）」、notes/T19.md「パート B・C の約束」9。
// T19）：要対応・締切と予定・カード × 立場（管理者・総務部門長・総務部門員・店長・副店長・兼ねた人）、終了した年度、行き先（canOpen）、
// 差し戻しの理由の2行目、締切と予定の id と中身が兼ねた人でも同じこと、プロバイダの読み取りのキー（閲覧のみは読まない）。
import { describe, expect, it } from 'vitest';
import type { GroupSummary, Membership, YearStatus } from '@/lib/auth/membership';
import type { AppRole } from '@/lib/auth/roles';
import type { YearRow } from '@/lib/db/types';
import { mergePortalSections, portalContextsOf, portalQueryKey, portalWidgetQuery, type PortalContext, type PortalSection } from '@/lib/modules/portal';
import { documentsPortal, documentsPortalProvider } from './portal';
import type { DocumentsRepPortalRow, DocumentsSoumuPortalRaw, DocumentStorageUsage } from './reads';

const Y = '11111111-1111-4111-8111-111111111111';
const uuid = (n: number) => `00000000-0000-4000-8000-${String(n).padStart(12, '0')}`;
const D1 = uuid(1); // 10/5 17:00（過ぎた）
const D2 = uuid(2); // 10/6 17:00（明日〔24 時間以内〕）
const D3 = uuid(3); // 10/20 17:00
const D4 = uuid(4); // 9/30 17:00（過ぎた。全部承認）
const G1: GroupSummary = { id: uuid(11), name: '模擬店01', year_id: Y, role: 'manager' };
const G2: GroupSummary = { id: uuid(12), name: '模擬店02', year_id: Y, role: 'deputy_manager' };

/** 開いた時刻：10/6 9:00（Asia/Tokyo） */
const NOW = Date.parse('2026-10-06T00:00:00Z');
const MB = 1024 * 1024;

const yearRow = (status: YearStatus): YearRow =>
  ({ id: Y, label: 'R8', status, festival_start: '2026-10-17', request_open_at: null, request_close_at: null }) as unknown as YearRow;

function member(role: AppRole | null, groups: GroupSummary[] = [], status: YearStatus = 'requesting'): Membership {
  const y = { id: Y, label: 'R8', status, festival_start: '2026-10-17' };
  return { displayName: null, year: y, role, groups, years: [y], latestYear: y, adminOfOpenYear: role === 'admin' };
}
const ctxOf = (m: Membership, kind: PortalContext['kind']) => portalContextsOf(m, yearRow(m.year!.status), NOW).find((c) => c.kind === kind)!;

const DOCS = [
  { id: D1, title: '出店計画', deadline: '2026-10-05T08:00:00Z' },
  { id: D2, title: '食品の届け', deadline: '2026-10-06T08:00:00Z' },
  { id: D3, title: '片付けの計画', deadline: '2026-10-20T08:00:00Z' },
  { id: D4, title: '参加の申し込み', deadline: '2026-09-30T08:00:00Z' },
];
const STATUSES: DocumentsSoumuPortalRaw['statuses'] = [
  { document_id: D1, status: 'not_submitted' },
  { document_id: D1, status: 'returned' },
  { document_id: D1, status: 'submitted' },
  { document_id: D2, status: 'submitted' },
  { document_id: D2, status: 'approved' },
  { document_id: D3, status: 'not_submitted' },
  { document_id: D4, status: 'approved' },
  { document_id: D4, status: 'approved' },
];
const USAGE: DocumentStorageUsage = { bucket_bytes: 180 * MB, limit_bytes: 900 * MB, file_count: 120, file_bytes: 180 * MB, orphan_count: 3 };
const soumuRaw = (over: Partial<DocumentsSoumuPortalRaw> = {}) => ({ kind: 'soumu' as const, docs: DOCS, statuses: STATUSES, usage: USAGE, ...over });

const ids = (s: PortalSection, part: 'todos' | 'dated') => s[part].map((x) => x.id);
const todo = (s: PortalSection, id: string) => s.todos.find((t) => t.id === id)!;

describe('T19 総務の要対応・締切と予定・カード', () => {
  it('管理者：承認待ち・締切を過ぎた未提出（差し戻しを含む）・片付けていないファイル。行き先は提出状況の絞り込み', () => {
    const s = documentsPortal(soumuRaw(), ctxOf(member('admin'), 'soumu'));
    expect(ids(s, 'todos')).toEqual(['documents:lead:submitted', 'documents:soumu:overdue', 'documents:lead:orphans']);
    expect(todo(s, 'documents:lead:submitted')).toMatchObject({ title: '承認待ち 2 件', count: 2, severity: 'normal', href: '/documents?status=submitted', moduleId: 'documents' });
    expect(todo(s, 'documents:soumu:overdue')).toMatchObject({ title: '締切を過ぎた未提出 2 件（差し戻しを含む）', count: 2, severity: 'normal', href: '/documents?status=overdue' });
    expect(todo(s, 'documents:lead:orphans')).toMatchObject({ title: '片付けていないファイル 3 件（提出状況を開くと消します）', severity: 'info', href: '/documents' });
    for (const t of s.todos) expect(t).not.toHaveProperty('detail');
  });

  it('管理者のカード：提出物の数と次の締切、承認／対象・承認待ち・差し戻し・未提出、前に上げたファイルの使った量（T24 から上限は出さない）。リンクは「提出状況へ」', () => {
    const s = documentsPortal(soumuRaw(), ctxOf(member('admin'), 'soumu'));
    expect(s.card).toEqual({
      moduleId: 'documents',
      title: '提出物',
      lines: ['提出物 4 件（次の締切 10/6 17:00）', '承認 3／8・承認待ち 2・差し戻し 1・未提出 2', '前に上げたファイル 180 MB（新しくは上げません）'],
      href: '/documents',
      linkLabel: '提出状況へ',
    });
  });

  it('総務部門長：承認待ち・締切を過ぎた・片付けの要対応は同じ。カードの使った量は管理者だけ', () => {
    const s = documentsPortal(soumuRaw(), ctxOf(member('head'), 'soumu'));
    expect(ids(s, 'todos')).toEqual(['documents:lead:submitted', 'documents:soumu:overdue', 'documents:lead:orphans']);
    expect(s.card!.lines).toHaveLength(2);
  });

  it('総務部門員：締切を過ぎた未提出だけ（参考）。承認待ち・片付けは出さない（使った量を読まない）', () => {
    const s = documentsPortal(soumuRaw({ usage: null }), ctxOf(member('staff'), 'soumu'));
    expect(ids(s, 'todos')).toEqual(['documents:soumu:overdue']);
    expect(todo(s, 'documents:soumu:overdue').severity).toBe('info');
    expect(s.card!.lines).toEqual(['提出物 4 件（次の締切 10/6 17:00）', '承認 3／8・承認待ち 2・差し戻し 1・未提出 2']);
  });

  it('締切と予定：締切が今より後のものと、締切を過ぎて未提出・差し戻しの団体が残っているもの（全部承認の D4 は出さない）。行き先は提出状況のその提出物', () => {
    const s = documentsPortal(soumuRaw(), ctxOf(member('staff'), 'soumu'));
    expect(ids(s, 'dated')).toEqual([`documents:deadline:${D1}`, `documents:deadline:${D2}`, `documents:deadline:${D3}`]);
    expect(s.dated[0]).toEqual({
      id: `documents:deadline:${D1}`,
      moduleId: 'documents',
      title: '提出物「出店計画」の締切',
      at: '2026-10-05T08:00:00Z',
      kind: 'deadline',
      href: `/documents?document=${D1}`,
    });
  });

  it('提出物がなければカードは「提出物はまだありません」だけ（管理者は使った量も）。対象の団体がなければ「対象の団体がありません」。締切がすべて過ぎていれば言う', () => {
    expect(documentsPortal(soumuRaw({ docs: [], statuses: [], usage: null }), ctxOf(member('head'), 'soumu')).card!.lines).toEqual(['提出物はまだありません']);
    expect(documentsPortal(soumuRaw({ docs: [], statuses: [] }), ctxOf(member('admin'), 'soumu')).card!.lines).toEqual([
      '提出物はまだありません',
      '前に上げたファイル 180 MB（新しくは上げません）',
    ]);
    const past = soumuRaw({ docs: [DOCS[0]!, DOCS[3]!], statuses: [], usage: null });
    expect(documentsPortal(past, ctxOf(member('staff'), 'soumu')).card!.lines).toEqual(['提出物 2 件（締切はすべて過ぎました）', '対象の団体がありません']);
    // 承認待ち・締切を過ぎたがなければ作らない
    expect(documentsPortal(past, ctxOf(member('admin'), 'soumu')).todos).toEqual([]);
  });

  it('締切ちょうどは過ぎた側（未提出が残る締切は出し、締切を過ぎた未提出に数える）', () => {
    const at = Date.parse(DOCS[1]!.deadline);
    const ctx = { ...ctxOf(member('staff'), 'soumu'), now: at };
    const s = documentsPortal(soumuRaw({ statuses: [{ document_id: D2, status: 'not_submitted' }] }), ctx);
    expect(todo(s, 'documents:soumu:overdue').count).toBe(1);
    expect(documentsPortal(soumuRaw({ statuses: [{ document_id: D2, status: 'not_submitted' }] }), { ...ctx, now: at - 1 }).todos).toEqual([]);
  });

  it('終了した年度：要対応は片付けていないファイルと、管理者の年度のファイルだけ（{N} 件・{X} MB）。締切と予定は今より後のものだけ。カードは出す', () => {
    const admin = documentsPortal(soumuRaw(), ctxOf(member('admin', [], 'closed'), 'soumu'));
    expect(ids(admin, 'todos')).toEqual(['documents:lead:orphans', 'documents:admin:closed-files']);
    expect(todo(admin, 'documents:admin:closed-files')).toMatchObject({
      title: '提出物のファイル 120 件（180 MB）が残っています。要るものを保存してから削除してください',
      severity: 'normal',
      href: '/documents',
    });
    expect(ids(admin, 'dated')).toEqual([`documents:deadline:${D2}`, `documents:deadline:${D3}`]);
    expect(admin.card).not.toBeNull();
    const head = documentsPortal(soumuRaw(), ctxOf(member('head', [], 'closed'), 'soumu'));
    expect(ids(head, 'todos')).toEqual(['documents:lead:orphans']);
    // ファイルが残っていなければ出さない
    expect(ids(documentsPortal(soumuRaw({ usage: { ...USAGE, file_count: 0, orphan_count: 0 } }), ctxOf(member('admin', [], 'closed'), 'soumu')), 'todos')).toEqual([]);
  });
});

describe('T19 店長・副店長の要対応と締切と予定', () => {
  const rows: DocumentsRepPortalRow[] = [
    { document_id: D1, group_id: G1.id, status: 'returned', title: '出店計画', deadline: '2026-10-05T08:00:00Z', review_note: '印鑑がありません\n2枚目の写真が暗いです' },
    { document_id: D2, group_id: G1.id, status: 'not_submitted', title: '食品の届け', deadline: '2026-10-06T08:00:00Z', review_note: null },
    { document_id: D3, group_id: G1.id, status: 'not_submitted', title: '片付けの計画', deadline: '2026-10-20T08:00:00Z', review_note: null },
    { document_id: D3, group_id: G2.id, status: 'submitted', title: '片付けの計画', deadline: '2026-10-20T08:00:00Z', review_note: null },
    { document_id: D4, group_id: G2.id, status: 'approved', title: '参加の申し込み', deadline: '2026-09-30T08:00:00Z', review_note: null },
  ];

  it('差し戻し（提出物ごとに1件。急ぎ。2行目に「理由：…」。期日はその締切）と未提出（団体ごとに1件。いちばん早い締切まで 24 時間を切れば急ぎ）', () => {
    const s = documentsPortal({ kind: 'rep', rows }, ctxOf(member(null, [G1, G2]), 'rep'));
    expect(ids(s, 'todos')).toEqual([`documents:rep:${G1.id}:returned:${D1}`, `documents:rep:${G1.id}:pending`]);
    expect(todo(s, `documents:rep:${G1.id}:returned:${D1}`)).toEqual({
      id: `documents:rep:${G1.id}:returned:${D1}`,
      moduleId: 'documents',
      title: '模擬店01：提出物「出店計画」が差し戻されました',
      detail: '理由：印鑑がありません\n2枚目の写真が暗いです',
      severity: 'urgent',
      due: '2026-10-05T08:00:00Z',
      href: `/document?group=${G1.id}&document=${D1}`,
    });
    expect(todo(s, `documents:rep:${G1.id}:pending`)).toEqual({
      id: `documents:rep:${G1.id}:pending`,
      moduleId: 'documents',
      title: '模擬店01：未提出の提出物 2 件',
      count: 2,
      severity: 'urgent',
      due: '2026-10-06T08:00:00Z',
      href: `/document?group=${G1.id}`,
    });
    expect(s.card).toBeNull();
  });

  it('未提出のいちばん早い締切まで 24 時間より前ならふつう。理由のない差し戻しは2行目を付けない', () => {
    const later = documentsPortal(
      {
        kind: 'rep',
        rows: [
          { ...rows[2]! },
          { document_id: D1, group_id: G1.id, status: 'returned', title: '出店計画', deadline: '2026-10-05T08:00:00Z', review_note: null },
        ],
      },
      ctxOf(member(null, [G1]), 'rep'),
    );
    expect(todo(later, `documents:rep:${G1.id}:pending`).severity).toBe('normal');
    expect(todo(later, `documents:rep:${G1.id}:returned:${D1}`)).not.toHaveProperty('detail');
  });

  it('締切と予定：自団体が対象の提出物。過ぎた締切は自団体に未提出・差し戻しがあるときだけ。行き先は対象の代表する団体のうち最初のもの', () => {
    const s = documentsPortal({ kind: 'rep', rows }, ctxOf(member(null, [G1, G2]), 'rep'));
    expect(ids(s, 'dated')).toEqual([`documents:deadline:${D1}`, `documents:deadline:${D2}`, `documents:deadline:${D3}`]);
    expect(s.dated.map((d) => d.href)).toEqual([
      `/document?group=${G1.id}&document=${D1}`,
      `/document?group=${G1.id}&document=${D2}`,
      `/document?group=${G1.id}&document=${D3}`,
    ]);
    // 2つ目の団体だけが対象の提出物は、その団体へ
    const only2 = documentsPortal({ kind: 'rep', rows: [{ ...rows[3]! }] }, ctxOf(member(null, [G1, G2]), 'rep'));
    expect(only2.dated[0]!.href).toBe(`/document?group=${G2.id}&document=${D3}`);
  });

  it('終了した年度：要対応は作らない。締切と予定は今より後のものだけ', () => {
    const s = documentsPortal({ kind: 'rep', rows }, ctxOf(member(null, [G1, G2], 'closed'), 'rep'));
    expect(s.todos).toEqual([]);
    expect(ids(s, 'dated')).toEqual([`documents:deadline:${D2}`, `documents:deadline:${D3}`]);
  });
});

describe('T19 兼ねた人と、読み取りのキー', () => {
  it('管理者で店長も務める人：総務と店長・副店長の要対応の両方。締切と予定は同じ id・同じ中身（行き先は提出状況）で、まとめると1回だけ', () => {
    const m = member('admin', [G1]);
    const repRows: DocumentsRepPortalRow[] = [
      { document_id: D3, group_id: G1.id, status: 'not_submitted', title: '片付けの計画', deadline: '2026-10-20T08:00:00Z', review_note: null },
    ];
    const soumu = documentsPortal(soumuRaw(), ctxOf(m, 'soumu'));
    const rep = documentsPortal({ kind: 'rep', rows: repRows }, ctxOf(m, 'rep'));
    const d3 = (s: PortalSection) => s.dated.find((d) => d.id === `documents:deadline:${D3}`);
    expect(d3(rep)).toEqual(d3(soumu));
    expect(d3(rep)!.href).toBe(`/documents?document=${D3}`);
    const [merged] = mergePortalSections([
      { moduleId: 'documents', kind: 'soumu', section: soumu },
      { moduleId: 'documents', kind: 'rep', section: rep },
    ]);
    expect(merged!.dated.filter((d) => d.id === `documents:deadline:${D3}`)).toHaveLength(1);
    expect(merged!.todos.map((t) => t.id)).toEqual([...soumu.todos.map((t) => t.id), `documents:rep:${G1.id}:pending`]);
  });

  it('閲覧のみで店長も務める人：店長・副店長として読み、行き先は自団体の提出物', () => {
    const m = member('viewer', [G1]);
    const s = documentsPortal(
      { kind: 'rep', rows: [{ document_id: D3, group_id: G1.id, status: 'not_submitted', title: '片付けの計画', deadline: '2026-10-20T08:00:00Z', review_note: null }] },
      ctxOf(m, 'rep'),
    );
    expect(s.dated[0]!.href).toBe(`/document?group=${G1.id}&document=${D3}`);
    expect(ids(s, 'todos')).toEqual([`documents:rep:${G1.id}:pending`]);
  });

  it('読んだ行の種類と立場の種類が違えば例外', () => {
    expect(() => documentsPortal({ kind: 'rep', rows: [] }, ctxOf(member('admin'), 'soumu'))).toThrow();
  });

  it('プロバイダ：総務は段ごとのキー（部門長以上と総務部門員で別）、店長・副店長は団体の id つきのキー、団体がなければ読まない。閲覧のみの種類はない（Q5）', () => {
    expect(documentsPortalProvider.kinds).toEqual(['soumu', 'rep']);
    expect(documentsPortalProvider.query!.widgets).toEqual(['todos', 'dated', 'cards']);
    expect(documentsPortalProvider.fromYear).toBeUndefined();
    expect(documentsPortalProvider.query!.options(ctxOf(member('admin'), 'soumu'))!.queryKey).toEqual(portalQueryKey(Y, 'documents', 'soumu', 'lead'));
    expect(documentsPortalProvider.query!.options(ctxOf(member('deputy_head'), 'soumu'))!.queryKey).toEqual(portalQueryKey(Y, 'documents', 'soumu', 'lead'));
    expect(documentsPortalProvider.query!.options(ctxOf(member('staff'), 'soumu'))!.queryKey).toEqual(portalQueryKey(Y, 'documents', 'soumu', 'staff'));
    expect(documentsPortalProvider.query!.options(ctxOf(member(null, [G1, G2]), 'rep'))!.queryKey).toEqual(portalQueryKey(Y, 'documents', 'rep', G1.id, G2.id));
    const noGroups = { ...ctxOf(member(null, [G1]), 'rep'), groups: [] };
    expect(documentsPortalProvider.query!.options(noGroups)).toBeNull();
    // 欄ごと：要対応・締切と予定・カードの3つに並べる（お知らせの欄には並べない）
    const ctx = ctxOf(member('admin'), 'soumu');
    for (const w of ['todos', 'dated', 'cards'] as const) expect(portalWidgetQuery(documentsPortalProvider, ctx, w)).not.toBeNull();
    for (const w of ['soumuNotices', 'notices'] as const) expect(portalWidgetQuery(documentsPortalProvider, ctx, w)).toBeNull();
  });

  it('select は読んだ行から、その種類の全部を作る（締切と予定の一覧〔/calendar〕の機能の日付も同じ）', () => {
    const ctx = ctxOf(member('staff'), 'soumu');
    const q = documentsPortalProvider.query!.options(ctx)!;
    const section = (q.select as (raw: unknown) => PortalSection)({ docs: DOCS, statuses: STATUSES, usage: null });
    expect(section).toEqual(documentsPortal(soumuRaw({ usage: null }), ctx));
  });
});
