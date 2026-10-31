// お知らせ一覧の読み取り・並べ方・読み直し（04「お知らせ一覧」、notes/T17.md「後半（画面）の約束」2・5。T17）
import { QueryClient } from '@tanstack/react-query';
import { describe, expect, it } from 'vitest';
import { AppError } from '@/lib/errors';
import { checkNoticeForm, emptyNoticeForm, type NoticeFormValues } from '@/lib/schemas/notices';
import { createFakeSupabase, opArgs, type FakeCall } from '@/lib/testing/fake-supabase';
import {
  dropNoticeFromCache,
  fetchNotices,
  findCreatedNotice,
  FIND_CREATED_LIMIT,
  NOTICES_SELECT,
  noticeInvalidateKeys,
  noticesOptions,
  orderGroupIds,
  putNoticeInCache,
  readNotice,
  sameNoticeWrite,
  sortNotices,
  type NoticeRow,
  type NoticesData,
} from './notices';

const Y = 'y1';
const ME = 'u-me';
const OTHER = 'u-other';

const db = (id: string, over: Record<string, unknown> = {}) => ({
  id,
  year_id: Y,
  audience: 'soumu',
  title: `題名${id}`,
  body: null,
  pinned: false,
  created_by: ME,
  created_at: '2026-10-01T00:00:00Z',
  updated_by: ME,
  updated_at: '2026-10-01T00:00:00Z',
  notice_groups: [],
  ...over,
});
const GROUPS = [
  { id: 'gb', name: '模擬店B', aliases: [], category: 'stall', sort_order: 2 },
  { id: 'ga', name: '模擬店A', aliases: ['A店'], category: 'stall', sort_order: 1 },
  { id: 'gc', name: '部門C', aliases: [], category: 'department', sort_order: 1 },
];
const write = (over: Partial<NoticeFormValues> = {}) => checkNoticeForm({ ...emptyNoticeForm(), title: '題名', ...over }).write!;

function client(tables: Record<string, unknown>) {
  return createFakeSupabase((call: FakeCall) => {
    const v = tables[call.table];
    if (v === undefined) return { error: { code: '42501', message: `読まない表：${call.table}` }, status: 403 };
    return { data: v };
  });
}

describe('T17 fetchNotices（一覧の読み取り）', () => {
  it('お知らせ（宛先の団体の行つき。年度で絞り、ピン留め → 新しい順 → id）と団体を並行に読む。総務なら書いた人の表示名も読む', async () => {
    const { client: c, issued } = client({
      notices: [
        db('n1', { created_at: '2026-10-02T00:00:00Z', created_by: ME }),
        db('n2', { audience: 'groups', pinned: true, created_by: OTHER, notice_groups: [{ group_id: 'gb' }, { group_id: 'gone' }, { group_id: 'ga' }] }),
        db('n3', { created_by: null }),
      ],
      groups: GROUPS,
      profiles: [{ user_id: ME, display_name: '総務 一郎' }],
    });
    const d = await fetchNotices(Y, { withAuthors: true }, c);
    expect(d.notices.map((n) => n.id)).toEqual(['n2', 'n1', 'n3']);
    // 宛先の団体は団体の並び（sort_order → 名前 → id）、読めない団体の id は後ろ
    expect(d.notices[0]!.groupIds).toEqual(['ga', 'gb', 'gone']);
    expect(d.groups.map((g) => g.id)).toEqual(['ga', 'gc', 'gb']);
    expect([...d.authors]).toEqual([[ME, '総務 一郎']]);
    expect(d.loadedAt).toMatch(/^\d{4}-/);

    const notices = issued.find((x) => x.table === 'notices')!;
    expect(opArgs(notices, 'select')).toEqual([[NOTICES_SELECT]]);
    expect(NOTICES_SELECT).toContain('notice_groups(group_id)');
    expect(opArgs(notices, 'eq')).toEqual([['year_id', Y]]);
    expect(opArgs(notices, 'order')).toEqual([['pinned', { ascending: false }], ['created_at', { ascending: false }], ['id']]);
    expect(opArgs(notices, 'range')).toEqual([[0, 999]]);
    const groups = issued.find((x) => x.table === 'groups')!;
    expect(opArgs(groups, 'select')).toEqual([['id, name, aliases, category, sort_order']]);
    expect(opArgs(groups, 'eq')).toEqual([['year_id', Y]]);
    // 書いた人は created_by の重なりと null を除いて読む
    const profiles = issued.find((x) => x.table === 'profiles')!;
    expect(opArgs(profiles, 'select')).toEqual([['user_id, display_name']]);
    expect(opArgs(profiles, 'in')).toEqual([['user_id', [ME, OTHER].sort()]]);
  });

  it('閲覧のみ・店長・副店長（withAuthors なし）は profiles を読まない。書いた人がいなければ総務でも読まない', async () => {
    const plain = client({ notices: [db('n1')], groups: [] });
    const d = await fetchNotices(Y, { withAuthors: false }, plain.client);
    expect(plain.issued.map((x) => x.table).sort()).toEqual(['groups', 'notices']);
    expect(d.authors.size).toBe(0);
    const none = client({ notices: [db('n1', { created_by: null })], groups: [] });
    await fetchNotices(Y, { withAuthors: true }, none.client);
    expect(none.issued.map((x) => x.table)).not.toContain('profiles');
  });

  it('どれかが読めなければ AppError を投げる', async () => {
    const { client: c } = client({ notices: [db('n1')] });
    await expect(fetchNotices(Y, { withAuthors: false }, c)).rejects.toBeInstanceOf(AppError);
  });

  it('キーは ["year", 年度, "notices", "list", "authors" | "plain"]。書いた後は一覧とダッシュボードのお知らせの欄を読み直す', () => {
    expect(noticesOptions(Y, true).queryKey).toEqual(['year', Y, 'notices', 'list', 'authors']);
    expect(noticesOptions(Y, false).queryKey).toEqual(['year', Y, 'notices', 'list', 'plain']);
    expect(noticeInvalidateKeys(Y)).toEqual([
      ['year', Y, 'notices'],
      ['year', Y, 'portal', 'notices'],
    ]);
  });
});

describe('T17 sortNotices・orderGroupIds', () => {
  it('ピン留め → 出した日時の新しい順 → id。元の配列は変えない', () => {
    const rows = [
      { id: 'b', pinned: false, created_at: '2026-10-01T00:00:00Z' },
      { id: 'a', pinned: false, created_at: '2026-10-01T00:00:00Z' },
      { id: 'p', pinned: true, created_at: '2026-09-01T00:00:00Z' },
      { id: 'n', pinned: false, created_at: '2026-10-05T00:00:00Z' },
    ];
    expect(sortNotices(rows).map((r) => r.id)).toEqual(['p', 'n', 'a', 'b']);
    expect(rows.map((r) => r.id)).toEqual(['b', 'a', 'p', 'n']);
  });

  it('orderGroupIds：団体の並びの id が先、読めない id は後ろに id の順、重なりは除く', () => {
    const order = new Map([
      ['g2', 0],
      ['g1', 1],
    ]);
    expect(orderGroupIds(['z', 'g1', 'a', 'g2', 'g1'], order)).toEqual(['g2', 'g1', 'a', 'z']);
    expect(orderGroupIds(['g2', 'g1'])).toEqual(['g1', 'g2']);
  });
});

describe('T17 sameNoticeWrite（読み直した行が入力と同じか）', () => {
  const row = (over: Partial<NoticeRow> = {}) => ({ audience: 'soumu' as const, title: '題名', body: null, pinned: false, groupIds: [], ...over });

  it('宛先・題名・本文（null と空白だけをそろえる）・ピン留めを比べる', () => {
    expect(sameNoticeWrite(row(), write({ body: '  ' }))).toBe(true);
    expect(sameNoticeWrite(row({ body: '本文' }), write({ body: '本文' }))).toBe(true);
    expect(sameNoticeWrite(row({ body: '本文' }), write({ body: '本文 ' }))).toBe(false);
    expect(sameNoticeWrite(row({ title: '別' }), write())).toBe(false);
    expect(sameNoticeWrite(row({ pinned: true }), write())).toBe(false);
    expect(sameNoticeWrite(row({ audience: 'all_groups' }), write())).toBe(false);
  });

  it('宛先の団体は指定の団体のときだけ、並べて比べる', () => {
    expect(sameNoticeWrite(row({ audience: 'groups', groupIds: ['g2', 'g1'] }), write({ audience: 'groups', groupIds: ['g1', 'g2'] }))).toBe(true);
    expect(sameNoticeWrite(row({ audience: 'groups', groupIds: ['g1'] }), write({ audience: 'groups', groupIds: ['g1', 'g2'] }))).toBe(false);
    // ほかの宛先では、フォームが覚えている団体を見ない
    expect(sameNoticeWrite(row({ audience: 'all_groups' }), write({ audience: 'all_groups', groupIds: ['g1'] }))).toBe(true);
  });
});

describe('T17 readNotice・findCreatedNotice（(B1)・(B2) の読み直し）', () => {
  it('readNotice：id で1行（宛先の団体つき）。なければ null。読めなければ投げる', async () => {
    const one = client({ notices: db('n1', { audience: 'groups', notice_groups: [{ group_id: 'g2' }, { group_id: 'g1' }] }) });
    const r = await readNotice('n1', one.client);
    expect(r?.groupIds).toEqual(['g1', 'g2']);
    expect(opArgs(one.issued[0]!, 'eq')).toEqual([['id', 'n1']]);
    expect(one.issued[0]!.ops.map((o) => o.op)).toContain('maybeSingle');
    expect(await readNotice('n1', client({ notices: null }).client)).toBeNull();
    await expect(readNotice('n1', client({}).client)).rejects.toBeInstanceOf(AppError);
  });

  it('findCreatedNotice：自分が出したその年度の最近のお知らせ（新しい順に 20 件）から、開いたときの一覧になく、中身が同じものを返す', async () => {
    const w = write({ title: '同じ題名' });
    const rows = [db('new-other', { title: '別の題名' }), db('known', { title: '同じ題名' }), db('created', { title: '同じ題名' })];
    const { client: c, issued } = client({ notices: rows });
    const found = await findCreatedNotice(Y, ME, w, new Set(['known']), c);
    expect(found?.id).toBe('created');
    const call = issued[0]!;
    expect(opArgs(call, 'eq')).toEqual([
      ['year_id', Y],
      ['created_by', ME],
    ]);
    expect(opArgs(call, 'order')).toEqual([['created_at', { ascending: false }], ['id']]);
    expect(opArgs(call, 'limit')).toEqual([[FIND_CREATED_LIMIT]]);
    expect(FIND_CREATED_LIMIT).toBe(20);
    // 時刻では絞らない（端末の時計がずれうる）
    expect(opArgs(call, 'gte')).toEqual([]);
    expect(await findCreatedNotice(Y, ME, w, new Set(['known', 'created']), c)).toBeNull();
    await expect(findCreatedNotice(Y, ME, w, new Set(), client({}).client)).rejects.toBeInstanceOf(AppError);
  });
});

describe('T17 一覧のキャッシュ（putNoticeInCache・dropNoticeFromCache）', () => {
  const data = (): NoticesData => ({
    notices: [
      { ...db('old', { created_at: '2026-09-01T00:00:00Z' }), groupIds: [] } as unknown as NoticeRow,
      { ...db('pin', { pinned: true, created_at: '2026-08-01T00:00:00Z' }), groupIds: [] } as unknown as NoticeRow,
    ],
    groups: [
      { id: 'g2', name: '模擬店02', aliases: [], category: 'stall', sort_order: 1 },
      { id: 'g1', name: '模擬店01', aliases: [], category: 'stall', sort_order: 2 },
    ],
    authors: new Map(),
    loadedAt: 't',
  });

  it('出した・直したお知らせを、書いた人の名前つき・なしの両方の一覧に入れる（並びはピン留め → 新しい順。団体は団体の並び）', () => {
    const qc = new QueryClient();
    qc.setQueryData(noticesOptions(Y, true).queryKey, data());
    const saved = { ...db('new', { audience: 'groups', created_at: '2026-10-10T00:00:00Z' }) } as never;
    putNoticeInCache(qc, Y, saved, ['g1', 'g2']);
    const after = qc.getQueryData(noticesOptions(Y, true).queryKey)!;
    expect(after.notices.map((n) => n.id)).toEqual(['pin', 'new', 'old']);
    expect(after.notices[1]!.groupIds).toEqual(['g2', 'g1']);
    // キャッシュのない一覧（名前なし）は作らない
    expect(qc.getQueryData(noticesOptions(Y, false).queryKey)).toBeUndefined();
    // 直したお知らせは置き換える（重ねない）
    putNoticeInCache(qc, Y, { ...db('old', { title: '直した', created_at: '2026-09-01T00:00:00Z' }) } as never, []);
    const edited = qc.getQueryData(noticesOptions(Y, true).queryKey)!;
    expect(edited.notices.filter((n) => n.id === 'old').map((n) => n.title)).toEqual(['直した']);
  });

  it('消したお知らせを一覧から外す', () => {
    const qc = new QueryClient();
    qc.setQueryData(noticesOptions(Y, false).queryKey, data());
    dropNoticeFromCache(qc, Y, 'old');
    expect(qc.getQueryData(noticesOptions(Y, false).queryKey)!.notices.map((n) => n.id)).toEqual(['pin']);
  });
});
