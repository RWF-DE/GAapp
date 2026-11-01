import { describe, expect, it } from 'vitest';
import { createFakeSupabase, opArgs } from '@/lib/testing/fake-supabase';
import {
  actionLabel,
  actorLabel,
  AUDIT_TABLES,
  auditTarget,
  crossYearNote,
  diffAudit,
  EMPTY_FILTER,
  fetchDeletedGroupNames,
  fetchHistoryPage,
  formatAuditValue,
  formatDiffEntry,
  HISTORY_PAGE_SIZE,
  historyQueries,
  atMicros,
  compareHistoryRows,
  historyEmptyNote,
  historyHref,
  isDateParam,
  NAME_UNKNOWN,
  OUTSIDE_LABEL,
  parseHistoryParams,
  tableLabel,
  type AuditLogRow,
  type HistoryFilter,
} from './history';

const Y = '11111111-1111-4111-8111-111111111111';
const G = '22222222-2222-4222-8222-222222222222';
const U = '33333333-3333-4333-8333-333333333333';
const R = '44444444-4444-4444-8444-444444444444';
const I = '55555555-5555-4555-8555-555555555555';

const params = (q: string) => new URLSearchParams(q);

describe('diffAudit', () => {
  it('変更：値の違う列だけを列名の順で返し、created_at・updated_at は除く', () => {
    const before = { group_id: G, item_id: I, count: 3, created_at: '2026-10-01T00:00:00+00:00', updated_at: '2026-10-01T00:00:00+00:00' };
    const after = { ...before, count: 5, updated_at: '2026-10-02T00:00:00+00:00' };
    expect(diffAudit(before, after)).toEqual([{ key: 'count', before: 3, after: 5 }]);
  });

  it('created_at・updated_at だけが変わったら空', () => {
    expect(diffAudit({ a: 1, updated_at: 'x', created_at: 'p' }, { a: 1, updated_at: 'y', created_at: 'q' })).toEqual([]);
  });

  it('追加は after の全部の列（before は undefined）、削除は before の全部の列（after は undefined）', () => {
    expect(diffAudit(null, { count: 2, b: null, updated_at: 'x' })).toEqual([
      { key: 'b', before: undefined, after: null },
      { key: 'count', before: undefined, after: 2 },
    ]);
    expect(diffAudit({ name: 'A', created_at: 'x' }, null)).toEqual([{ key: 'name', before: 'A', after: undefined }]);
  });

  it('jsonb（ルールの params・配列）はキーの順によらず比べる。片方にしかない列も差にする', () => {
    const before = { params: { a: 1, b: [1, 2] }, aliases: ['x'] };
    expect(diffAudit(before, { params: { b: [1, 2], a: 1 }, aliases: ['x'] })).toEqual([]);
    expect(diffAudit(before, { params: { a: 1, b: [2, 1] }, aliases: ['x'], memo: 'm' })).toEqual([
      { key: 'memo', before: undefined, after: 'm' },
      { key: 'params', before: { a: 1, b: [1, 2] }, after: { a: 1, b: [2, 1] } },
    ]);
  });

  it('null と値の違い・null どうしは同じ', () => {
    expect(diffAudit({ note: null }, { note: '' })).toEqual([{ key: 'note', before: null, after: '' }]);
    expect(diffAudit({ note: null }, { note: null })).toEqual([]);
  });

  it('両方 null・オブジェクトでない値は空', () => {
    expect(diffAudit(null, null)).toEqual([]);
    expect(diffAudit('x', 3)).toEqual([]);
  });
});

describe('差の表示', () => {
  it('「count：3 → 5」、追加は「count：5」、削除は「（削除前）」', () => {
    expect(formatDiffEntry('requests', { key: 'count', before: 3, after: 5 })).toBe('count：3 → 5');
    expect(formatDiffEntry('requests', { key: 'count', before: undefined, after: 5 })).toBe('count：5');
    expect(formatDiffEntry('requests', { key: 'count', before: 3, after: undefined })).toBe('count：3（削除前）');
  });

  it('参照は名前、真偽・null・列挙・日時は日本語（Asia/Tokyo）', () => {
    const lookups = { rooms: new Map([[R, 'E101']]), items: new Map([[I, '長机']]) };
    expect(formatAuditValue('stocks', 'room_id', R, lookups)).toBe('E101');
    expect(formatAuditValue('allocations', 'requested_item_id', I, lookups)).toBe('長机');
    expect(formatAuditValue('room_years', 'usable', false)).toBe('いいえ');
    expect(formatAuditValue('room_years', 'note', null)).toBe('なし');
    expect(formatAuditValue('years', 'status', 'confirmed')).toBe('確定');
    expect(formatAuditValue('substitution_consents', 'status', 'accepted')).toBe('了承');
    expect(formatAuditValue('rules', 'kind', 'keep')).toBe('残す');
    expect(formatAuditValue('groups', 'category', 'stall')).toBe('模擬店');
    expect(formatAuditValue('stocks', 'counted_at', '2026-10-05T09:01:00+00:00')).toBe('2026/10/05 18:01');
    expect(formatAuditValue('stocks', 'counted_by', U)).toBe(NAME_UNKNOWN);
    expect(formatAuditValue('groups', 'aliases', ['a', 'b'])).toBe('a、b');
    expect(formatAuditValue('rules', 'params', { group: 'x' })).toBe('{"group":"x"}');
    expect(formatAuditValue('groups', 'year_id', Y, { years: new Map([[Y, 'R8']]) })).toBe('R8');
  });

  it('ロールは表示名、団体代表の立場（group_members の role）は店長・副店長（T15b。04「履歴」）', () => {
    expect(formatAuditValue('year_roles', 'role', 'admin')).toBe('管理者');
    expect(formatAuditValue('year_roles', 'role', 'head')).toBe('総務部門長');
    expect(formatAuditValue('year_roles', 'role', 'deputy_head')).toBe('総務副部門長');
    expect(formatAuditValue('year_roles', 'role', 'staff')).toBe('総務部門員');
    expect(formatAuditValue('year_roles', 'role', 'viewer')).toBe('閲覧のみ');
    expect(formatAuditValue('group_members', 'role', 'manager')).toBe('店長');
    expect(formatAuditValue('group_members', 'role', 'deputy_manager')).toBe('副店長');
    // 招待の立場（invitations は監査しないが、出ても日本語にする）
    expect(formatAuditValue('invitations', 'group_role', 'deputy_manager')).toBe('副店長');
    expect(formatAuditValue('invitations', 'role', 'staff')).toBe('総務部門員');
    // 表にない値はそのまま
    expect(formatAuditValue('group_members', 'role', 'owner')).toBe('owner');
    expect(formatDiffEntry('group_members', { key: 'role', before: 'manager', after: 'deputy_manager' })).toBe('role：店長 → 副店長');
  });

  it('表の選びの注：開いている年度の管理者には年度をまたぐ表の説明、ほか（部門長・副部門長）には見られない理由', () => {
    expect(crossYearNote(true)).toBe('場所・品目・距離は年度をまたぐ表です（年度のない記録も出します）。');
    expect(crossYearNote(false)).toBe('場所・品目・距離の記録（年度のない記録）は、開いている年度の管理者だけが見られます。');
  });

  it('0 件のときの説明：年度をまたぐ表だけを選んだ部門長・副部門長には見られない理由を先に出す', () => {
    const f = (tables: HistoryFilter['tables'], more: Partial<HistoryFilter> = {}): HistoryFilter => ({ ...EMPTY_FILTER, tables, ...more });
    expect(historyEmptyNote(f(['rooms', 'items']), false)).toBe(
      '場所・品目・距離の記録（年度のない記録）は、開いている年度の管理者だけが見られます。絞り込みを変えるか、消してください。',
    );
    // 開いている年度の管理者・年度の表も選んだ・絞り込みがない
    expect(historyEmptyNote(f(['rooms']), true)).toBe('絞り込みを変えるか、消してください。');
    expect(historyEmptyNote(f(['rooms', 'rules']), false)).toBe('絞り込みを変えるか、消してください。');
    expect(historyEmptyNote(f([]), false)).toBeUndefined();
    expect(historyEmptyNote(f([], { from: '2026-10-01' }), false)).toBe('絞り込みを変えるか、消してください。');
  });

  it('操作・した人', () => {
    expect(actionLabel('insert')).toBe('追加');
    expect(actionLabel('update')).toBe('変更');
    expect(actionLabel('delete')).toBe('削除');
    expect(actorLabel(null, new Map())).toBe(OUTSIDE_LABEL);
    expect(actorLabel(U, new Map())).toBe(NAME_UNKNOWN);
    expect(actorLabel(U, new Map([[U, '総務 太郎']]))).toBe('総務 太郎');
  });

  it('対象：団体・部屋・品目の名前。消えた団体は記録の中の名前', () => {
    const lookups = { groups: new Map([[G, '模擬店A']]), rooms: new Map([[R, 'E101']]), items: new Map([[I, '長机']]) };
    const row = (table_name: string, data: Record<string, unknown>, del = false) => ({
      table_name,
      row_pk: {},
      group_id: (data.group_id as string) ?? null,
      before: del ? data : null,
      after: del ? null : data,
    });
    expect(auditTarget(row('requests', { group_id: G, item_id: I }), lookups)).toBe('模擬店A・長机');
    expect(auditTarget(row('stocks', { room_id: R, item_id: I }), lookups)).toBe('E101・長机');
    expect(auditTarget(row('groups', { id: 'gone', name: '消えた店' }, true), lookups)).toBe('消えた店');
    expect(auditTarget(row('requests', { group_id: 'gone', item_id: I }), lookups)).toBe('（消えた団体）・長机');
    expect(auditTarget(row('distance_overrides', { building_a: 'A棟', building_b: 'B棟' }), lookups)).toBe('A棟・B棟');
    expect(auditTarget(row('rules', { code: 'S01' }), lookups)).toBe('S01');
    expect(auditTarget(row('year_roles', { user_id: U }), lookups)).toBe(NAME_UNKNOWN);
  });

  it('T17 お知らせ：表の絞り込みの最後に notices・notice_groups（足すだけ）。表の名前、対象（題名・宛先の団体の名前）、宛先と書いた人の値', () => {
    expect(AUDIT_TABLES.slice(AUDIT_TABLES.indexOf('notices'), AUDIT_TABLES.indexOf('notices') + 2)).toEqual(['notices', 'notice_groups']);
    expect(AUDIT_TABLES.slice(0, 2)).toEqual(['requests', 'request_submissions']);
    expect(tableLabel('notices')).toBe('お知らせ');
    expect(tableLabel('notice_groups')).toBe('宛先の団体');
    const lookups = { groups: new Map([[G, '模擬店A']]), users: new Map([[U, '総務 太郎']]) };
    const row = (table_name: string, data: Record<string, unknown>) => ({ table_name, row_pk: {}, group_id: (data.group_id as string) ?? null, before: null, after: data });
    expect(auditTarget(row('notices', { id: 'n1', title: '机の返却' }), lookups)).toBe('机の返却');
    expect(auditTarget(row('notice_groups', { notice_id: 'n1', group_id: G }), lookups)).toBe('模擬店A');
    expect(auditTarget(row('notice_groups', { notice_id: 'n1', group_id: 'gone' }), lookups)).toBe('（消えた団体）');
    expect(formatAuditValue('notices', 'audience', 'all_groups')).toBe('全団体');
    expect(formatAuditValue('notices', 'audience', 'soumu')).toBe('総務内');
    expect(formatAuditValue('notices', 'created_by', U, lookups)).toBe('総務 太郎');
    expect(formatAuditValue('notices', 'created_by', 'x', lookups)).toBe(NAME_UNKNOWN);
  });

  it('T18 締切と予定：表の絞り込みの最後に events（足すだけ）。表の名前は「締切と予定」、対象は題名、種類・対象は表示名（お知らせの宛先と取り違えない）', () => {
    expect(AUDIT_TABLES.indexOf('events')).toBe(AUDIT_TABLES.indexOf('notice_groups') + 1);
    expect(new Set(AUDIT_TABLES).size).toBe(AUDIT_TABLES.length);
    expect(tableLabel('events')).toBe('締切と予定');
    const lookups = { users: new Map([[U, '総務 太郎']]) };
    const row = (data: Record<string, unknown> | null, before: Record<string, unknown> | null = null) => ({
      table_name: 'events',
      row_pk: { id: 'e1' },
      group_id: null,
      before,
      after: data,
    });
    expect(auditTarget(row({ id: 'e1', title: '申請書の提出' }), lookups)).toBe('申請書の提出');
    // 削除（after が null）は前の行の題名
    expect(auditTarget(row(null, { id: 'e1', title: '消した予定' }), lookups)).toBe('消した予定');
    expect(formatAuditValue('events', 'kind', 'deadline')).toBe('締切');
    expect(formatAuditValue('events', 'kind', 'event')).toBe('予定');
    expect(formatAuditValue('events', 'audience', 'soumu')).toBe('総務');
    expect(formatAuditValue('events', 'audience', 'groups')).toBe('団体');
    expect(formatAuditValue('events', 'audience', 'all')).toBe('全員');
    // お知らせの宛先はそのまま（groups は「指定の団体」）。ほかの表の kind もそのまま
    expect(formatAuditValue('notices', 'audience', 'groups')).toBe('指定の団体');
    expect(formatAuditValue('rules', 'kind', 'keep')).toBe('残す');
    // 知らない値はそのまま。開始・終わりは Asia/Tokyo の日時、終日は「はい」、書いた人は表示名
    expect(formatAuditValue('events', 'audience', 'teachers')).toBe('teachers');
    expect(formatAuditValue('events', 'starts_at', '2027-10-15T15:00:00+00:00')).toBe('2027/10/16 00:00');
    expect(formatAuditValue('events', 'all_day', true)).toBe('はい');
    expect(formatAuditValue('events', 'updated_by', U, lookups)).toBe('総務 太郎');
  });
});

describe('絞り込み（URL）', () => {
  it('合わない値は無視し、表は決まった順にそろえる。from が to より後なら入れ替える', () => {
    expect(parseHistoryParams(params('table=stocks,nope,requests&group=bad&from=2026-02-30&to=2026-10-05&user=x'))).toEqual({
      tables: ['requests', 'stocks'],
      groupId: null,
      from: null,
      to: '2026-10-05',
      user: null,
    });
    expect(parseHistoryParams(params(`group=${G}&from=2026-10-09&to=2026-10-01&user=outside`))).toEqual({
      tables: [],
      groupId: G,
      from: '2026-10-01',
      to: '2026-10-09',
      user: 'outside',
    });
  });

  it('URL に戻すと同じ絞り込みになる', () => {
    const f = { tables: ['rooms', 'stocks'] as const, groupId: G, from: '2026-10-01', to: '2026-10-02', user: U };
    const href = historyHref({ ...f, tables: [...f.tables] });
    expect(href.startsWith('/history?')).toBe(true);
    expect(parseHistoryParams(new URLSearchParams(href.slice('/history?'.length)))).toEqual({ ...f, tables: ['stocks', 'rooms'] });
    expect(historyHref(EMPTY_FILTER)).toBe('/history');
  });

  it('isDateParam は実在する日付だけ', () => {
    expect(isDateParam('2024-02-29')).toBe(true);
    expect(isDateParam('2025-02-29')).toBe(false);
    expect(isDateParam('2025-1-01')).toBe(false);
    expect(isDateParam(null)).toBe(false);
  });
});

describe('historyQueries', () => {
  it('年度だけ（絞り込みなし）', () => {
    expect(historyQueries(Y, EMPTY_FILTER)).toEqual([[{ op: 'eq', column: 'year_id', value: Y }]]);
  });

  it('年度の表と年度をまたぐ表を選ぶと、年度の行と year_id が null の行の2つに分ける。期間は Asia/Tokyo の 0 時で gte・lt', () => {
    const common = [
      { op: 'gte', column: 'at', value: '2026-10-01T00:00:00+09:00' },
      { op: 'lt', column: 'at', value: '2026-11-01T00:00:00+09:00' },
      { op: 'eq', column: 'user_id', value: U },
    ];
    expect(historyQueries(Y, { tables: ['stocks', 'requests', 'rooms', 'items'], groupId: null, from: '2026-10-01', to: '2026-10-31', user: U })).toEqual([
      [{ op: 'eq', column: 'year_id', value: Y }, { op: 'in', column: 'table_name', values: ['stocks', 'requests'] }, ...common],
      [{ op: 'is', column: 'year_id', value: null }, { op: 'in', column: 'table_name', values: ['rooms', 'items'] }, ...common],
    ]);
  });

  it('年度をまたぐ表だけなら year_id が null の問い合わせだけ。団体で絞ると年度をまたぐ表の問い合わせは作らない', () => {
    expect(historyQueries(Y, { ...EMPTY_FILTER, tables: ['distance_overrides'] })).toEqual([
      [
        { op: 'is', column: 'year_id', value: null },
        { op: 'eq', column: 'table_name', value: 'distance_overrides' },
      ],
    ]);
    expect(historyQueries(Y, { ...EMPTY_FILTER, tables: ['rooms', 'stocks'], groupId: G })).toEqual([
      [
        { op: 'eq', column: 'year_id', value: Y },
        { op: 'eq', column: 'table_name', value: 'stocks' },
        { op: 'eq', column: 'group_id', value: G },
      ],
    ]);
    expect(historyQueries(Y, { ...EMPTY_FILTER, tables: ['rooms'], groupId: G })).toEqual([]);
  });

  it('アプリの外は user_id is null。続きは at <= と、最後の行の at と id より前', () => {
    expect(historyQueries(Y, { ...EMPTY_FILTER, tables: ['requests'], user: 'outside' }, { at: '2026-10-05T09:01:02.123456+00:00', id: 42 })).toEqual([
      [
        { op: 'eq', column: 'year_id', value: Y },
        { op: 'eq', column: 'table_name', value: 'requests' },
        { op: 'is', column: 'user_id', value: null },
        { op: 'lte', column: 'at', value: '2026-10-05T09:01:02.123456+00:00' },
        {
          op: 'or',
          expr: 'at.lt."2026-10-05T09:01:02.123456+00:00",and(at.eq."2026-10-05T09:01:02.123456+00:00",id.lt.42)',
        },
      ],
    ]);
  });
});

describe('並び（at desc・id desc）', () => {
  it('マイクロ秒まで比べる（Date のミリ秒で丸めない）。同じ at は id の大きい順', () => {
    expect(atMicros('2026-10-05T09:01:02.123457+00:00') - atMicros('2026-10-05T09:01:02.123456+00:00')).toBe(1);
    expect(atMicros('2026-10-05T18:01:02+09:00')).toBe(atMicros('2026-10-05T09:01:02Z'));
    expect(atMicros('2026-10-05T09:01:02.5+00')).toBe(atMicros('2026-10-05T09:01:02.500000+00:00'));
    const rows = [
      { at: '2026-10-05T09:01:02.123456+00:00', id: 1 },
      { at: '2026-10-05T09:01:02.123457+00:00', id: 2 },
      { at: '2026-10-05T09:01:02.123456+00:00', id: 3 },
    ];
    expect([...rows].sort(compareHistoryRows).map((r) => r.id)).toEqual([2, 3, 1]);
  });
});

function logRow(id: number, at: string): AuditLogRow {
  return { id, at, table_name: 'stocks', row_pk: {}, action: 'update', year_id: Y, group_id: null, before: {}, after: {}, reason: null, user_id: null };
}

describe('fetchHistoryPage', () => {
  it('at desc・id desc で 51 件を頼み、51 件目があれば 50 件と続きの読み始めを返す（件数は数えない）', async () => {
    const rows = Array.from({ length: HISTORY_PAGE_SIZE + 1 }, (_, i) => logRow(100 - i, `2026-10-05T09:00:${String(59 - i).padStart(2, '0')}+00:00`));
    const fake = createFakeSupabase(() => ({ data: rows }));
    const page = await fetchHistoryPage(Y, { ...EMPTY_FILTER, tables: ['items'] }, null, fake.client);
    expect(page.rows).toHaveLength(HISTORY_PAGE_SIZE);
    expect(page.next).toEqual({ at: rows[HISTORY_PAGE_SIZE - 1]!.at, id: rows[HISTORY_PAGE_SIZE - 1]!.id });
    const call = fake.issued[0]!;
    expect(call.table).toBe('audit_logs');
    expect(opArgs(call, 'order')).toEqual([
      ['at', { ascending: false }],
      ['id', { ascending: false }],
    ]);
    expect(opArgs(call, 'limit')).toEqual([[HISTORY_PAGE_SIZE + 1]]);
    expect(opArgs(call, 'is')).toEqual([['year_id', null]]);
    expect(opArgs(call, 'eq')).toEqual([['table_name', 'items']]);
    expect(String(opArgs(call, 'select')[0]![0])).not.toContain('count');
  });

  it('50 件以下なら続きはない', async () => {
    const fake = createFakeSupabase(() => ({ data: [logRow(1, '2026-10-05T09:00:00+00:00')] }));
    const page = await fetchHistoryPage(Y, EMPTY_FILTER, { at: '2026-10-06T00:00:00+00:00', id: 9 }, fake.client);
    expect(page.next).toBeNull();
    expect(opArgs(fake.issued[0]!, 'or')).toHaveLength(1);
  });

  it('年度の行と年度のない行は別に読み、合わせて at desc・id desc の先頭 50 件にする', async () => {
    const at = (sec: number) => `2026-10-05T09:00:${String(sec).padStart(2, '0')}+00:00`;
    const yearRows = Array.from({ length: 51 }, (_, i) => logRow(1000 - i, at(59 - i)));
    const nullRows = [logRow(5000, at(58)), logRow(5001, '2026-10-05T09:00:58.5+00:00')];
    const fake = createFakeSupabase((call) => ({ data: opArgs(call, 'is').length > 0 ? nullRows : yearRows }));
    const page = await fetchHistoryPage(Y, { ...EMPTY_FILTER, tables: ['stocks', 'rooms'] }, null, fake.client);
    expect(fake.issued).toHaveLength(2);
    expect(page.rows.slice(0, 4).map((r) => r.id)).toEqual([1000, 5001, 5000, 999]);
    expect(page.rows).toHaveLength(HISTORY_PAGE_SIZE);
    expect(page.next).toEqual({ at: page.rows[49]!.at, id: page.rows[49]!.id });
  });

  it('失敗は AppError にして投げる', async () => {
    const fake = createFakeSupabase(() => ({ error: { code: '42501', message: 'denied' }, status: 403 }));
    await expect(fetchHistoryPage(Y, EMPTY_FILTER, null, fake.client)).rejects.toMatchObject({ info: { kind: 'forbidden' } });
  });
});

describe('fetchDeletedGroupNames', () => {
  it('団体の履歴の新しい記録の name を使う（削除の記録は before）', async () => {
    const fake = createFakeSupabase(() => ({
      data: [
        { group_id: G, before: { name: '新しい名前' }, after: null },
        { group_id: G, before: { name: '古い名前' }, after: { name: '新しい名前?' } },
      ],
    }));
    const names = await fetchDeletedGroupNames(Y, [G, 'not-a-uuid'], fake.client);
    expect(names.get(G)).toBe('新しい名前');
    expect(opArgs(fake.issued[0]!, 'in')).toEqual([['group_id', [G]]]);
  });

  it('引く団体がなければ問い合わせない', async () => {
    const fake = createFakeSupabase(() => ({ data: [] }));
    expect((await fetchDeletedGroupNames(Y, [], fake.client)).size).toBe(0);
    expect(fake.issued).toHaveLength(0);
  });
});

describe('T20 シフト・作業の履歴（04「シフト表」の履歴、notes/T20.md「画面の約束」12）', () => {
  const D = '66666666-6666-4666-8666-666666666666';
  const S = '77777777-7777-4777-8777-777777777777';
  const row = (table_name: string, data: Record<string, unknown>, before: Record<string, unknown> | null = null) => ({
    table_name,
    row_pk: {},
    group_id: null,
    before,
    after: data,
  });
  const lookups = { users: new Map([[U, '部門員A']]), duties: new Map([[D, '受付']]), slots: new Map([[S, '10/15 09:00〜10:00']]) };

  it('表の絞り込みの最後に5表（足すだけ）。表の名前', () => {
    expect(AUDIT_TABLES.slice(AUDIT_TABLES.indexOf('shift_duties'), AUDIT_TABLES.indexOf('shift_duties') + 5)).toEqual([
      'shift_duties',
      'shift_slots',
      'shift_needs',
      'shift_assignments',
      'tasks',
    ]);
    expect(['shift_duties', 'shift_slots', 'shift_needs', 'shift_assignments', 'tasks'].map(tableLabel)).toEqual([
      '持ち場',
      'シフトの時間枠',
      '必要人数',
      'シフトの割り当て',
      '作業',
    ]);
    expect(new Set(AUDIT_TABLES).size).toBe(AUDIT_TABLES.length);
  });

  it('対象：持ち場は名前、時間枠は「11/5 09:00〜10:00」、ますは持ち場の名前（なければ消えた持ち場）、割り当ては人と持ち場、作業は題名', () => {
    expect(auditTarget(row('shift_duties', { id: D, name: '受付（旧）' }), lookups)).toBe('受付');
    expect(auditTarget(row('shift_duties', { id: 'gone', name: '運搬' }), lookups)).toBe('運搬');
    expect(auditTarget(row('shift_slots', { id: S, starts_at: '2027-11-05T00:00:00+00:00', ends_at: '2027-11-05T01:00:00+00:00' }), lookups)).toBe(
      '11/5 09:00〜10:00',
    );
    expect(auditTarget(row('shift_needs', { slot_id: S, duty_id: D, required_count: 2 }), lookups)).toBe('受付');
    expect(auditTarget(row('shift_needs', { slot_id: S, duty_id: 'gone', required_count: 2 }), lookups)).toBe('消えた持ち場');
    expect(auditTarget(row('shift_assignments', { slot_id: S, duty_id: D, user_id: U }), lookups)).toBe('部門員A・受付');
    expect(auditTarget(row('tasks', { id: 't', title: '名札を作る' }), lookups)).toBe('名札を作る');
  });

  it('値：作業の状態は表示名、担当者は表示名、持ち場・時間枠は今の名前と日時（引けなければ id）', () => {
    expect(formatAuditValue('tasks', 'status', 'doing')).toBe('作業中');
    expect(formatAuditValue('tasks', 'assignee_id', U, lookups)).toBe('部門員A');
    expect(formatAuditValue('tasks', 'assignee_id', 'x', lookups)).toBe(NAME_UNKNOWN);
    expect(formatAuditValue('shift_assignments', 'duty_id', D, lookups)).toBe('受付');
    expect(formatAuditValue('shift_needs', 'slot_id', S, lookups)).toBe('10/15 09:00〜10:00');
    expect(formatAuditValue('shift_needs', 'slot_id', 'x', lookups)).toBe('x');
    // 年度の状態の status は今までどおり
    expect(formatAuditValue('years', 'status', 'closed')).toBe('終了');
  });
});
