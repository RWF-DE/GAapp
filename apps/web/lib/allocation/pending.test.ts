import type { StoredAllocationRow } from '@gaapp/shared';
import { describe, expect, it } from 'vitest';
import type { StoredRows } from '@/lib/data/year-data';
import { allocationChangesPayload } from '@/lib/rpc/payloads';
import {
  allowedRowOps,
  applyPending,
  countError,
  editPending,
  parseNote,
  pendingListSchema,
  rebasePending,
  reconcileAfterUnknown,
  sameUpdatedAt,
  toRpcChanges,
  type PendingChange,
} from './pending';
import { BLOCK_FIX_ROWS, BLOCK_PENDING, unusableBlocker, unusableChecklist } from './unusable';

const id = (n: number) => `00000000-0000-4000-8000-${String(n).padStart(12, '0')}`;
const ROOM_A = id(101);
const ROOM_B = id(102);
const ROOM_USE = id(103); // 団体の使用場所
const GROUP = id(201);
const DESK = id(301);
const CASTER = id(302);
const T0 = '2026-10-20T01:02:03.123456+00:00';
const T1 = '2026-10-20T01:05:00.000001+00:00';

function row(n: number, p: Partial<StoredAllocationRow> = {}): StoredAllocationRow {
  return {
    id: id(n),
    sourceRoomId: ROOM_A,
    groupId: GROUP,
    itemId: DESK,
    requestedItemId: DESK,
    count: 3,
    isKeep: false,
    origin: 'auto',
    pinned: false,
    note: null,
    ...p,
  };
}
const stored = (rows: StoredAllocationRow[], at: Record<string, string> = {}): StoredRows => ({
  rows,
  updatedAt: new Map(rows.map((r) => [r.id, at[r.id] ?? T0])),
});
const locationOf = (g: string) => (g === GROUP ? ROOM_USE : undefined);
let seq = 0;
const temp = () => `new-${++seq}`;

describe('applyPending', () => {
  const base = [row(1), row(2, { pinned: true }), row(3, { origin: 'manual' })];

  it('備考だけを変えた自動の行は手動の行になる（DB の v_data_changed と同じ）', () => {
    const out = applyPending(base, [{ op: 'update', id: id(1), updatedAt: T0, patch: { note: '団体の希望' } }], locationOf);
    expect(out[0]).toMatchObject({ id: id(1), note: '団体の希望', origin: 'manual' });
  });

  it('固定だけの変更は origin を変えない', () => {
    const out = applyPending(base, [{ op: 'update', id: id(1), updatedAt: T0, patch: { pinned: true } }], locationOf);
    expect(out[0]).toMatchObject({ pinned: true, origin: 'auto' });
  });

  it('数・運び元を変えると manual、運び元が使用場所なら残す（is_keep）', () => {
    const out = applyPending(base, [{ op: 'update', id: id(1), updatedAt: T0, patch: { sourceRoomId: ROOM_USE } }], locationOf);
    expect(out[0]).toMatchObject({ sourceRoomId: ROOM_USE, isKeep: true, origin: 'manual' });
    const out2 = applyPending(base, [{ op: 'update', id: id(1), updatedAt: T0, patch: { count: 3 } }], locationOf);
    expect(out2[0]!.origin).toBe('auto'); // 同じ値は変更でない
  });

  it('delete は外し、insert は tempId の手動の行として後ろに足す', () => {
    const out = applyPending(
      base,
      [
        { op: 'delete', id: id(2), updatedAt: T0 },
        { op: 'insert', tempId: 'new-x', groupId: GROUP, sourceRoomId: ROOM_B, itemId: CASTER, requestedItemId: DESK, count: 2, note: null, pinned: false },
      ],
      locationOf,
    );
    expect(out.map((r) => r.id)).toEqual([id(1), id(3), 'new-x']);
    expect(out[2]).toMatchObject({ origin: 'manual', isKeep: false, itemId: CASTER, requestedItemId: DESK });
  });

  it('変更がなければ同じ行', () => {
    expect(applyPending(base, [], locationOf)).toEqual(base);
  });
});

describe('editPending', () => {
  const base = stored([row(1), row(2)]);

  it('同じ行への update は1つにまとめ、元の値に戻した項目は外す（何も残らなければ外す）', () => {
    let p = editPending([], { op: 'update', id: id(1), patch: { count: 5 } }, base, temp);
    p = editPending(p, { op: 'update', id: id(1), patch: { note: 'メモ' } }, base, temp);
    expect(p).toEqual([{ op: 'update', id: id(1), updatedAt: T0, patch: { count: 5, note: 'メモ' } }]);
    p = editPending(p, { op: 'update', id: id(1), patch: { count: 3, note: null } }, base, temp);
    expect(p).toEqual([]);
  });

  it('delete は update を置き換える。未保存の行への変更は insert に入れ、delete は insert ごと外す', () => {
    let p = editPending([], { op: 'update', id: id(1), patch: { count: 5 } }, base, temp);
    p = editPending(p, { op: 'delete', id: id(1) }, base, temp);
    expect(p).toEqual([{ op: 'delete', id: id(1), updatedAt: T0 }]);
    p = editPending(p, { op: 'insert', groupId: GROUP, sourceRoomId: ROOM_B, itemId: DESK, requestedItemId: DESK, count: 1, note: null, pinned: false }, base, temp);
    const tempId = (p[1] as Extract<PendingChange, { op: 'insert' }>).tempId;
    p = editPending(p, { op: 'update', id: tempId, patch: { count: 4, pinned: true } }, base, temp);
    expect(p[1]).toMatchObject({ op: 'insert', count: 4, pinned: true });
    p = editPending(p, { op: 'delete', id: tempId }, base, temp);
    expect(p).toHaveLength(1);
  });

  it('DB にない行への操作は無視する', () => {
    expect(editPending([], { op: 'update', id: id(9), patch: { count: 2 } }, base, temp)).toEqual([]);
  });
});

describe('toRpcChanges', () => {
  it('save_allocation_rows の p_changes（camelCase、tempId は送らない、update は変えた項目だけ）', () => {
    const p: PendingChange[] = [
      { op: 'insert', tempId: 'new-1', groupId: GROUP, sourceRoomId: ROOM_B, itemId: CASTER, requestedItemId: DESK, count: 2, note: null, pinned: true },
      { op: 'update', id: id(1), updatedAt: T0, patch: { count: 5, note: null } },
      { op: 'delete', id: id(2), updatedAt: T1 },
    ];
    const out = toRpcChanges(p);
    expect(out).toEqual([
      { op: 'insert', sourceRoomId: ROOM_B, groupId: GROUP, itemId: CASTER, requestedItemId: DESK, count: 2, pinned: true, note: null },
      { op: 'update', id: id(1), updatedAt: T0, count: 5, note: null },
      { op: 'delete', id: id(2), updatedAt: T1 },
    ]);
    expect(allocationChangesPayload.safeParse(out).success).toBe(true);
  });
});

describe('pending の zod', () => {
  it('数は 1〜10000 の整数、備考は 2000 字まで', () => {
    expect(countError(0)).toMatch(/削除/);
    expect(countError(1)).toBeNull();
    expect(countError(10001)).not.toBeNull();
    expect(countError(1.5)).not.toBeNull();
    expect(parseNote('  ')).toEqual({ ok: true, note: null });
    expect(parseNote('a'.repeat(2001)).ok).toBe(false);
    const bad = [{ op: 'update', id: id(1), updatedAt: T0, patch: { count: 0 } }];
    expect(pendingListSchema.safeParse(bad).success).toBe(false);
    const good = [{ op: 'update', id: id(1), updatedAt: T0, patch: { count: 1 } }];
    expect(pendingListSchema.safeParse(good).success).toBe(true);
  });
});

describe('rebasePending', () => {
  const p: PendingChange[] = [
    { op: 'update', id: id(1), updatedAt: T0, patch: { count: 5 } },
    { op: 'update', id: id(2), updatedAt: T0, patch: { note: 'x' } },
    { op: 'delete', id: id(3), updatedAt: T0 },
    { op: 'insert', tempId: 'new-1', groupId: GROUP, sourceRoomId: ROOM_B, itemId: DESK, requestedItemId: DESK, count: 1, note: null, pinned: false },
  ];

  it('ぶつからない変更は当て直し、消えた行・updated_at が変わった行への変更は外して返す', () => {
    const after = stored([row(1), row(2, { count: 9 })], { [id(2)]: T1 });
    const r = rebasePending(p, after);
    expect(r.pending.map((c) => c.op)).toEqual(['update', 'insert']);
    expect(r.dropped).toEqual([
      { change: p[1], reason: 'changed' },
      { change: p[2], reason: 'gone' },
    ]);
  });

  it('マイクロ秒の書き方が違っても、ミリ秒で同じなら同じ updated_at（DB の date_trunc と同じ）', () => {
    expect(sameUpdatedAt('2026-10-20T01:02:03.123456+00:00', '2026-10-20T01:02:03.123+00:00')).toBe(true);
    expect(sameUpdatedAt('2026-10-20T01:02:03.123456+00:00', '2026-10-20T01:02:03.124+00:00')).toBe(false);
    const after = stored([row(1), row(2), row(3)], { [id(1)]: '2026-10-20T01:02:03.123+00:00' });
    expect(rebasePending(p, after).dropped).toEqual([]);
  });

  it('今の値と同じになった update は外す', () => {
    const after = stored([row(1, { count: 5 }), row(2), row(3)]);
    expect(rebasePending(p, after).pending.map((c) => c.op)).toEqual(['update', 'delete', 'insert']);
  });
});

describe('reconcileAfterUnknown', () => {
  const before = stored([row(1), row(2), row(3)]);
  const p: PendingChange[] = [
    { op: 'update', id: id(1), updatedAt: T0, patch: { count: 5 } },
    { op: 'delete', id: id(2), updatedAt: T0 },
    { op: 'insert', tempId: 'new-1', groupId: GROUP, sourceRoomId: ROOM_B, itemId: CASTER, requestedItemId: DESK, count: 2, note: 'a', pinned: false },
  ];

  it('全部：update の値と updated_at が変わり、delete の行がなく、insert と同じ新しい行がある → 保存されていた', () => {
    const after = stored(
      [row(1, { count: 5, origin: 'manual' }), row(3), row(9, { sourceRoomId: ROOM_B, itemId: CASTER, count: 2, note: 'a', origin: 'manual' })],
      { [id(1)]: T1, [id(9)]: T1 },
    );
    const r = reconcileAfterUnknown(p, before, after);
    expect(r.status).toBe('all');
    expect(r.remaining).toEqual([]);
  });

  it('なし：行がそのまま（ほかの人の変更で版が進んだだけ）', () => {
    const after = stored([row(1), row(2), row(3), row(8, { sourceRoomId: ROOM_B })], { [id(8)]: T1 });
    const r = reconcileAfterUnknown(p, before, after);
    expect(r.status).toBe('none');
    expect(r.applied).toEqual([]);
  });

  it('一部：決めきれないので、反映済みに見えるものと残りを分けて返す', () => {
    const after = stored([row(1, { count: 5 }), row(2), row(3)], { [id(1)]: T1 });
    const r = reconcileAfterUnknown(p, before, after);
    expect(r.status).toBe('partial');
    expect(r.applied).toEqual([p[0]]);
    expect(r.remaining).toEqual([p[1], p[2]]);
  });

  it('1つの新しい行は1つの insert にだけ当てる（同じ insert が2つなら新しい行が2つ要る）', () => {
    const twice = [p[2]!, { ...p[2]!, tempId: 'new-2' } as PendingChange];
    const after = stored([...before.rows, row(9, { sourceRoomId: ROOM_B, itemId: CASTER, count: 2, note: 'a' })]);
    expect(reconcileAfterUnknown(twice, before, after).status).toBe('partial');
  });
});

describe('allowedRowOps', () => {
  const usable = new Map([
    [ROOM_A, true],
    [ROOM_B, false],
  ]);

  it('使用可の部屋の行は数・運び元・備考・固定（する／外す）・削除', () => {
    expect(allowedRowOps(row(1), usable)).toEqual(['count', 'change_source', 'note', 'pin', 'delete']);
    expect(allowedRowOps(row(1, { pinned: true }), usable)).toEqual(['count', 'change_source', 'note', 'unpin', 'delete']);
  });

  it('使用不可の部屋の行は運び元の変更と削除だけ（固定の行にも「固定を外す」を出さない）', () => {
    expect(allowedRowOps(row(1, { sourceRoomId: ROOM_B, pinned: true }), usable)).toEqual(['change_source', 'delete']);
    expect(allowedRowOps(row(1, { sourceRoomId: ROOM_B, origin: 'manual' }), (r) => r !== ROOM_B)).toEqual(['change_source', 'delete']);
  });
});

describe('使用不可にする前の一覧', () => {
  const rows = [
    row(1), // 自動・未固定：一覧に出ない（最小変更で動く）
    row(2, { pinned: true }), // 固定の自動の行
    row(3, { origin: 'manual' }), // 手動の行
    row(4, { origin: 'manual', pinned: true }), // 固定の手動の行
    row(5, { sourceRoomId: ROOM_B, pinned: true }), // ほかの部屋
  ];

  it('その部屋からの固定・手動の行。固定の自動の行は「固定を外す」も、手動の行は運び元の変更と削除だけ', () => {
    const list = unusableChecklist(rows, ROOM_A);
    expect(list.map((x) => [x.row.id, x.ops])).toEqual([
      [id(2), ['unpin', 'change_source', 'delete']],
      [id(3), ['change_source', 'delete']],
      [id(4), ['change_source', 'delete']],
    ]);
  });

  it('未保存の変更を当てた行で作る（運び元を変えた・固定を外した行は消える）', () => {
    const pending: PendingChange[] = [
      { op: 'update', id: id(2), updatedAt: T0, patch: { pinned: false } },
      { op: 'update', id: id(3), updatedAt: T0, patch: { sourceRoomId: ROOM_B } },
      { op: 'delete', id: id(4), updatedAt: T0 },
    ];
    expect(unusableChecklist(applyPending(rows, pending, locationOf), ROOM_A)).toEqual([]);
  });

  it('一覧が空で未保存の変更がないときだけ押せる', () => {
    const list = unusableChecklist(rows, ROOM_A);
    expect(unusableBlocker({ checklist: list, pendingCount: 0 })).toBe(BLOCK_FIX_ROWS);
    expect(unusableBlocker({ checklist: [], pendingCount: 2 })).toBe(BLOCK_PENDING);
    expect(unusableBlocker({ checklist: [], pendingCount: 0 })).toBeNull();
  });
});
