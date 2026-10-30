import { fixturePath, readFixtureDir } from '@gaapp/shared/testing';
import { describe, expect, it, vi } from 'vitest';
import type { Snapshot } from '@/lib/data/snapshot';
import { toStoredRows } from '@/lib/data/year-data';
import type { AllocationDbRow } from '@/lib/db/types';
import { appError, toAppError } from '@/lib/errors';
import type { SaveAllocationRowsResult } from '@/lib/rpc/payloads';
import { FIXTURE_UPDATED_AT, fixtureSnapshot } from '@/lib/testing/fixture-rows';
import type { PendingChange } from './pending';
import { applySaveResult, saveRows, type RowSaveDeps } from './row-save';

const fx = readFixtureDir(fixturePath('synthetic', 'r8like'));
const base = fixtureSnapshot(fx, { version: 7 });
const room = base.rooms.find((r) => r.is_storage)!;
const room2 = base.rooms.filter((r) => r.is_storage)[1]!;
const group = base.groups[0]!;
const desk = base.items.find((i) => i.code === 'desk')!;

let n = 0;
function dbRow(p: Partial<AllocationDbRow> = {}): AllocationDbRow {
  n += 1;
  return {
    id: `00000000-0000-4000-8000-${String(n).padStart(12, '0')}`,
    year_id: base.year.id,
    source_room_id: room.id,
    group_id: group.id,
    item_id: desk.id,
    requested_item_id: desk.id,
    count: 3,
    is_keep: false,
    origin: 'auto',
    pinned: false,
    note: null,
    updated_at: FIXTURE_UPDATED_AT,
    ...p,
  };
}

const r1 = dbRow();
const r2 = dbRow();
const held: Snapshot = { ...base, allocations: [r1, r2] };
const before = toStoredRows(held);
const pending: PendingChange[] = [
  { op: 'update', id: r1.id, updatedAt: r1.updated_at, patch: { count: 5 } },
  { op: 'insert', tempId: 'new-1', groupId: group.id, sourceRoomId: room2.id, itemId: desk.id, requestedItemId: desk.id, count: 2, note: null, pinned: false },
];
const network = () => new TypeError('Failed to fetch');

function deps(p: Partial<RowSaveDeps>): RowSaveDeps {
  return {
    save: vi.fn(async () => {
      throw network();
    }),
    readVersion: vi.fn(async () => 7),
    loadFresh: vi.fn(async () => held),
    ...p,
  };
}

describe('saveRows', () => {
  it('通れば saved。送る changes は toRpcChanges（tempId なし）と理由', async () => {
    const result: SaveAllocationRowsResult = { allocation_version_before: 7, allocation_version: 8, rows: [] };
    const save = vi.fn(async () => result);
    const out = await saveRows(deps({ save }), { pending, reason: '団体の希望', heldVersion: 7, before });
    expect(out).toEqual({ kind: 'saved', result });
    expect(save).toHaveBeenCalledWith(
      [
        { op: 'update', id: r1.id, updatedAt: r1.updated_at, count: 5 },
        { op: 'insert', sourceRoomId: room2.id, groupId: group.id, itemId: desk.id, requestedItemId: desk.id, count: 2, pinned: false, note: null },
      ],
      '団体の希望',
    );
  });

  it('拒まれた（conflict など）はそのまま返し、版を読まない', async () => {
    const e = toAppError({ code: 'P0001', message: 'conflict', details: JSON.stringify({ id: r1.id }) });
    const d = deps({ save: vi.fn(async () => Promise.reject(e)) });
    expect(await saveRows(d, { pending, reason: 'x', heldVersion: 7, before })).toEqual({ kind: 'rejected', error: e });
    expect(d.readVersion).not.toHaveBeenCalled();
  });

  it('応答が届かず、版が同じなら保存されていない（送り直してよい）', async () => {
    const d = deps({});
    expect(await saveRows(d, { pending, reason: 'x', heldVersion: 7, before })).toEqual({ kind: 'not-saved' });
    expect(d.loadFresh).not.toHaveBeenCalled();
  });

  it('応答が届かず、版が進んでいて、すべて反映済みなら保存されていた（行が二重にならない）', async () => {
    const after: Snapshot = {
      ...held,
      version: 8,
      allocations: [
        { ...r1, count: 5, origin: 'manual', updated_at: '2026-10-29T01:00:00+00:00' },
        r2,
        dbRow({ source_room_id: room2.id, count: 2, origin: 'manual' }),
      ],
    };
    const out = await saveRows(deps({ readVersion: async () => 8, loadFresh: async () => after }), { pending, reason: 'x', heldVersion: 7, before });
    expect(out).toEqual({ kind: 'was-saved', snapshot: after });
  });

  it('版が進んでいても反映されていなければ、ほかの人の変更', async () => {
    const after: Snapshot = { ...held, version: 8, allocations: [r1, { ...r2, count: 9, updated_at: '2026-10-29T01:00:00+00:00' }] };
    const out = await saveRows(deps({ readVersion: async () => 8, loadFresh: async () => after }), { pending, reason: 'x', heldVersion: 7, before });
    expect(out).toEqual({ kind: 'other-change', snapshot: after });
  });

  it('一部だけなら partial（反映済みに見えるものと残り）', async () => {
    const after: Snapshot = { ...held, version: 8, allocations: [{ ...r1, count: 5, updated_at: '2026-10-29T01:00:00+00:00' }, r2] };
    const out = await saveRows(deps({ readVersion: async () => 8, loadFresh: async () => after }), { pending, reason: 'x', heldVersion: 7, before });
    expect(out).toMatchObject({ kind: 'partial', applied: [pending[0]], remaining: [pending[1]] });
  });

  it('版も読めなければ unverified（「確かめる」まで送り直させない）。予期しない応答も確かめる', async () => {
    const d = deps({ readVersion: vi.fn(async () => Promise.reject(network())) });
    expect(await saveRows(d, { pending, reason: 'x', heldVersion: 7, before })).toEqual({ kind: 'unverified' });
    const d2 = deps({ save: vi.fn(async () => Promise.reject(appError('unknown', 'unexpected_response'))) });
    expect(await saveRows(d2, { pending, reason: 'x', heldVersion: 7, before })).toEqual({ kind: 'not-saved' });
  });
});

describe('applySaveResult', () => {
  it('allocation_version_before が持っている版と同じなら、返った行で置き換えて版を進める', () => {
    const ins = dbRow({ origin: 'manual' });
    const out = applySaveResult(held, {
      allocation_version_before: 7,
      allocation_version: 8,
      rows: [
        { op: 'update', row: { ...r1, count: 5, origin: 'manual' } },
        { op: 'delete', id: r2.id },
        { op: 'insert', row: ins },
      ],
    });
    expect(out?.version).toBe(8);
    expect(out?.year.allocation_version).toBe(8);
    expect(out?.allocations.map((a) => [a.id, a.count])).toEqual([
      [r1.id, 5],
      [ins.id, 3],
    ]);
  });

  it('違えば null（その間にほかの人が変えたので読み直す）', () => {
    expect(applySaveResult(held, { allocation_version_before: 8, allocation_version: 9, rows: [] })).toBeNull();
  });
});
