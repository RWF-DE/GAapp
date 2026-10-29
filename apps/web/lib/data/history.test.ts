import { describe, expect, it } from 'vitest';
import { createFakeSupabase, opArgs } from '@/lib/testing/fake-supabase';
import {
  actionLabel,
  actorLabel,
  auditTarget,
  diffAudit,
  EMPTY_FILTER,
  fetchDeletedGroupNames,
  fetchHistoryPage,
  formatAuditValue,
  formatDiffEntry,
  HISTORY_PAGE_SIZE,
  historyConditions,
  historyHref,
  isDateParam,
  NAME_UNKNOWN,
  OUTSIDE_LABEL,
  parseHistoryParams,
  type AuditLogRow,
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

describe('historyConditions', () => {
  it('年度だけ（絞り込みなし）', () => {
    expect(historyConditions(Y, EMPTY_FILTER)).toEqual([{ op: 'eq', column: 'year_id', value: Y }]);
  });

  it('年度をまたぐ表を選ぶと year_id が null の行も含める。期間は Asia/Tokyo の 0 時で gte・lt', () => {
    expect(historyConditions(Y, { tables: ['stocks', 'rooms'], groupId: G, from: '2026-10-01', to: '2026-10-31', user: U })).toEqual([
      { op: 'or', expr: `year_id.eq.${Y},year_id.is.null` },
      { op: 'in', column: 'table_name', values: ['stocks', 'rooms'] },
      { op: 'eq', column: 'group_id', value: G },
      { op: 'gte', column: 'at', value: '2026-10-01T00:00:00+09:00' },
      { op: 'lt', column: 'at', value: '2026-11-01T00:00:00+09:00' },
      { op: 'eq', column: 'user_id', value: U },
    ]);
  });

  it('表が1つなら eq。アプリの外は user_id is null。続きは最後の行の at と id より前', () => {
    expect(
      historyConditions(Y, { ...EMPTY_FILTER, tables: ['requests'], user: 'outside' }, { at: '2026-10-05T09:01:02.123456+00:00', id: 42 }),
    ).toEqual([
      { op: 'eq', column: 'year_id', value: Y },
      { op: 'eq', column: 'table_name', value: 'requests' },
      { op: 'is', column: 'user_id', value: null },
      {
        op: 'or',
        expr: 'at.lt."2026-10-05T09:01:02.123456+00:00",and(at.eq."2026-10-05T09:01:02.123456+00:00",id.lt.42)',
      },
    ]);
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
    expect(opArgs(call, 'or')).toEqual([[`year_id.eq.${Y},year_id.is.null`]]);
    expect(opArgs(call, 'eq')).toEqual([['table_name', 'items']]);
    expect(String(opArgs(call, 'select')[0]![0])).not.toContain('count');
  });

  it('50 件以下なら続きはない', async () => {
    const fake = createFakeSupabase(() => ({ data: [logRow(1, '2026-10-05T09:00:00+00:00')] }));
    const page = await fetchHistoryPage(Y, EMPTY_FILTER, { at: '2026-10-06T00:00:00+00:00', id: 9 }, fake.client);
    expect(page.next).toBeNull();
    expect(opArgs(fake.issued[0]!, 'or')).toHaveLength(1);
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
