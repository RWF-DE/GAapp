import { describe, expect, it } from 'vitest';
import type { AllocationDbRow, ConsentDbRow, ItemRow, RoomRow } from '@/lib/db/types';
import type { AppSupabaseClient } from '@/lib/supabase/client';
import {
  allocationLineText,
  consentRequestText,
  loadMyData,
  myAllocationLines,
  myConsents,
  myRequestLines,
  pickMyGroup,
} from './my';

const T = '2026-10-29T00:00:00.000000+00:00';
const item = (id: string, name: string, sort: number): ItemRow => ({
  id,
  code: id,
  name,
  aliases: [],
  requestable_categories: [],
  sort_order: sort,
  updated_at: T,
});
const room = (id: string, name: string, sort: number): RoomRow => ({
  id,
  name,
  aliases: [],
  kind: 'room',
  building: null,
  floor: null,
  extra_cost: 0,
  is_storage: true,
  sort_order: sort,
  updated_at: T,
});
const items = [item('desk', '机(木)', 1), item('caster', 'キャスター机', 2), item('chair', '椅子(木)', 3)];
const rooms = [room('r11', '1-1', 1), room('r12', '1-2', 2), room('r23', '2-3', 3), room('home', '第一多目的室', 4)];
let n = 0;
const alloc = (p: Partial<AllocationDbRow>): AllocationDbRow => ({
  id: `a${++n}`,
  year_id: 'y',
  source_room_id: 'r11',
  group_id: 'g',
  item_id: 'desk',
  requested_item_id: 'desk',
  count: 1,
  is_keep: false,
  origin: 'auto',
  pinned: false,
  note: null,
  updated_at: T,
  ...p,
});

describe('自団体の振り分け（確定後）', () => {
  it('品目ごとの数と運び元（運び元が2つ・1つ・代替・残す）', () => {
    const allocations = [
      alloc({ source_room_id: 'r12', count: 4 }),
      alloc({ source_room_id: 'r11', count: 8 }),
      alloc({ item_id: 'caster', requested_item_id: 'desk', source_room_id: 'r23', count: 6 }),
      alloc({ item_id: 'chair', requested_item_id: 'chair', source_room_id: 'home', count: 18, is_keep: true }),
      alloc({ item_id: 'chair', requested_item_id: 'chair', source_room_id: 'r11', count: 2 }),
    ];
    const lines = myAllocationLines({ items, rooms, allocations });
    expect(lines.map(allocationLineText)).toEqual([
      '机(木) 12台：1-1 から 8台、1-2 から 4台',
      '机(木)の代わりにキャスター机 6台（2-3 から）',
      '椅子(木) 20台：使用場所にあるものを使う（残す） 18台、1-1 から 2台',
    ]);
  });

  it('残すだけ・同じ運び元はまとめる・数 0 は出さない', () => {
    const allocations = [
      alloc({ source_room_id: 'home', count: 3, is_keep: true }),
      alloc({ source_room_id: 'r11', count: 0 }),
    ];
    expect(myAllocationLines({ items, rooms, allocations }).map(allocationLineText)).toEqual(['机(木) 3台：使用場所にあるものを使う（残す）']);
    expect(myAllocationLines({ items, rooms, allocations: null })).toEqual([]);
  });
});

describe('自団体の振り分け（確定前）', () => {
  it('申請は数が 1 以上の品目を品目の並びで', () => {
    const requests = [
      { group_id: 'g', item_id: 'chair', count: 6, updated_at: T },
      { group_id: 'g', item_id: 'caster', count: 0, updated_at: T },
      { group_id: 'g', item_id: 'desk', count: 3, updated_at: T },
    ];
    expect(myRequestLines({ items, requests })).toEqual([
      { itemId: 'desk', itemName: '机(木)', count: 3 },
      { itemId: 'chair', itemName: '椅子(木)', count: 6 },
    ]);
  });

  it('交換の依頼は未依頼を出さず、依頼の台数の文を作る', () => {
    const c = (status: ConsentDbRow['status'], count: number | null): ConsentDbRow => ({
      group_id: 'g',
      from_item_id: 'desk',
      to_item_id: 'caster',
      status,
      count,
      note: null,
      updated_at: T,
    });
    expect(myConsents({ items, consents: [c('not_asked', null)] })).toEqual([]);
    const [asked] = myConsents({ items, consents: [c('asked', 6)] });
    expect(asked?.status).toBe('asked');
    expect(consentRequestText(asked!)).toBe('机(木) 6 台をキャスター机に交換してほしいという依頼があります');
    const [accepted] = myConsents({ items, consents: [c('accepted', null)] });
    expect(consentRequestText(accepted!)).toBe('机(木)をキャスター机に交換してほしいという依頼があります');
  });

  it('団体の選び方：?group= が自分の団体ならそれ、ほかは最初の団体', () => {
    const groups = [{ id: 'g1' }, { id: 'g2' }];
    expect(pickMyGroup(groups, 'g2')?.id).toBe('g2');
    expect(pickMyGroup(groups, 'other')?.id).toBe('g1');
    expect(pickMyGroup(groups, undefined)?.id).toBe('g1');
    expect(pickMyGroup([], 'g1')).toBeNull();
  });
});

/**
 * 読んだ表を記録する偽のクライアント（years と groups は1行、allocations は allocationRows〔読むたびに次の要素〕、ほかは空）。
 * yearGate を渡すと、years の応答はそれが解けるまで返らない（並行に読むかを確かめる）。
 */
function fakeClient(status: string, opts: { allocationRows?: unknown[][]; yearGate?: Promise<void> } = {}) {
  const tables: string[] = [];
  let allocationReads = 0;
  const result = (table: string, single: boolean) => {
    if (table === 'years') {
      return { data: { id: 'y', label: 'R8', status, allocation_version: 1 }, error: null, status: 200 };
    }
    if (table === 'groups') return { data: { id: 'g', name: '模擬店01' }, error: null, status: 200 };
    if (table === 'allocations') {
      const rows = opts.allocationRows?.[allocationReads] ?? [];
      allocationReads++;
      return { data: rows, error: null, status: 200 };
    }
    return { data: single ? null : [], error: null, status: 200 };
  };
  const wait = (table: string) => (table === 'years' && opts.yearGate ? opts.yearGate : Promise.resolve());
  const builder = (table: string) => {
    const b: Record<string, unknown> = {};
    for (const k of ['select', 'eq', 'order', 'range']) b[k] = () => b;
    b.maybeSingle = () => wait(table).then(() => result(table, true));
    b.then = (ok: (v: unknown) => unknown, ng?: (e: unknown) => unknown) => wait(table).then(() => result(table, false)).then(ok, ng);
    return b;
  };
  const client = {
    from: (table: string) => {
      tables.push(table);
      return builder(table);
    },
  } as unknown as AppSupabaseClient;
  return { client, tables };
}

const ALLOC_ROW = { id: 'a1', year_id: 'y', group_id: 'g', item_id: 'i', count: 3 };

describe('loadMyData', () => {
  it('年度の行を待たずに、団体・品目・場所・申請・提出・了承を並行に読む（D-45）', async () => {
    let open!: () => void;
    const yearGate = new Promise<void>((r) => (open = r));
    const { client, tables } = fakeClient('allocating', { yearGate });
    const p = loadMyData('y', 'g', client);
    await Promise.resolve();
    // 年度の行の応答の前に、ほかの表も送っている（振り分けの行は送らない）
    expect(new Set(tables)).toEqual(new Set(['years', 'groups', 'items', 'rooms', 'requests', 'request_submissions', 'substitution_consents']));
    open();
    await p;
  });

  it('確定前は振り分けの行を読みに行かない（RLS で 0 行になるのを「ない」と取り違えない）', async () => {
    const { client, tables } = fakeClient('allocating', { allocationRows: [[ALLOC_ROW]] });
    const d = await loadMyData('y', 'g', client);
    expect(tables).not.toContain('allocations');
    expect(d.allocations).toBeNull();
  });

  it('確定後は、年度の行を読んだ後に振り分けの行を読む', async () => {
    const { client, tables } = fakeClient('confirmed', { allocationRows: [[ALLOC_ROW]] });
    const d = await loadMyData('y', 'g', client);
    expect(tables.filter((t) => t === 'allocations')).toHaveLength(1);
    expect(tables.indexOf('allocations')).toBeGreaterThan(tables.indexOf('years'));
    expect(d.allocations).toEqual([ALLOC_ROW]);
  });

  it('終了の年度で振り分けの行がなければ、空の配列（振り分けがない）', async () => {
    const { client } = fakeClient('closed');
    const d = await loadMyData('y', 'g', client);
    expect(d.allocations).toEqual([]);
  });
});
