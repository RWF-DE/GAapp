import { describe, expect, it } from 'vitest';
import { AppError, isUnknownOutcome } from '@/lib/errors';
import { createFakeSupabase, opArgs, type FakeCall, type FakeResult } from '@/lib/testing/fake-supabase';
import { isLockRejection, settleLockedWrite } from './locked-save';
import { fixedRowsFrom, opsBeforeUnusable, readRoomYear, roomYearMatches, setRoomUsable } from './room-years';

const Y = '11111111-1111-4111-8111-111111111111';
const R = '22222222-2222-4222-8222-222222222222';
const R2 = '33333333-3333-4333-8333-333333333333';

// PostgREST はマイクロ秒まで返す。受け取った文字列をそのまま比べる
const T0 = '2026-10-29T01:02:03.123456+00:00';
const T1 = '2026-10-29T01:02:04.654321+00:00';

const reasonOf = async (p: Promise<unknown>) => {
  try {
    await p;
  } catch (e) {
    if (e instanceof AppError) return [e.info.kind, e.info.reason];
    throw e;
  }
  return null;
};

/** 書き込み（update・insert）と読み直し（select だけ）の応答を分ける */
function fake(write: FakeResult, reread?: FakeResult) {
  return createFakeSupabase((call: FakeCall) => {
    const isWrite = call.ops.some((o) => o.op === 'update' || o.op === 'insert' || o.op === 'upsert');
    if (isWrite) return write;
    if (!reread) throw new Error('読み直さないはず');
    return reread;
  });
}

describe('setRoomUsable', () => {
  it('行があれば、読み込んだときの updated_at を条件に update する（upsert しない）。メモは前後の空白を除いて空なら null', async () => {
    const { client, issued } = fake({ data: { year_id: Y, room_id: R, usable: false, note: '工事', updated_at: T1 } });
    const row = await setRoomUsable(Y, R, T0, false, '  工事 ', client);
    expect(row.usable).toBe(false);
    expect(issued).toHaveLength(1);
    const call = issued[0]!;
    expect(call.table).toBe('room_years');
    expect(call.ops.map((o) => o.op)).toEqual(['update', 'match', 'eq', 'select', 'maybeSingle']);
    expect(opArgs(call, 'update')).toEqual([[{ usable: false, note: '工事' }]]);
    expect(opArgs(call, 'match')).toEqual([[{ year_id: Y, room_id: R }]]);
    expect(opArgs(call, 'eq')).toEqual([['updated_at', T0]]);
    await setRoomUsable(Y, R, T0, true, '   ', client);
    expect(opArgs(issued[1]!, 'update')[0]![0]).toEqual({ usable: true, note: null });
  });

  it('行がなければ（updated_at が null）insert する', async () => {
    const { client, issued } = fake({ data: { year_id: Y, room_id: R, usable: false, note: null, updated_at: T1 } });
    const row = await setRoomUsable(Y, R, null, false, null, client);
    expect(row.updated_at).toBe(T1);
    expect(issued).toHaveLength(1);
    const call = issued[0]!;
    expect(call.ops.map((o) => o.op)).toEqual(['insert', 'select', 'maybeSingle']);
    expect(opArgs(call, 'insert')).toEqual([[{ year_id: Y, room_id: R, usable: false, note: null }]]);
  });

  it('update が 0 行で updated_at が違う → conflict（ほかの人が先に変えた。黙って上書きしない）', async () => {
    const { client, issued } = fake({ data: null }, { data: { updated_at: T1 } });
    expect(await reasonOf(setRoomUsable(Y, R, T0, false, null, client))).toEqual(['conflict', 'lock_conflict']);
    expect(issued[1]!.ops.map((o) => o.op)).toEqual(['select', 'match', 'maybeSingle']);
    expect(opArgs(issued[1]!, 'match')).toEqual([[{ year_id: Y, room_id: R }]]);
  });

  it('update が 0 行で行がない → not_found、updated_at が同じ → forbidden（RLS）', async () => {
    const gone = fake({ data: null }, { data: null });
    expect(await reasonOf(setRoomUsable(Y, R, T0, false, null, gone.client))).toEqual(['not_found', 'lock_missing']);
    const same = fake({ data: null }, { data: { updated_at: T0 } });
    expect(await reasonOf(setRoomUsable(Y, R, T0, false, null, same.client))).toEqual(['forbidden', 'lock_unchanged']);
  });

  it('insert が 23505（ほかの人が先に足した）→ conflict', async () => {
    const { client, issued } = fake({ error: { code: '23505', message: 'duplicate key value violates unique constraint' }, status: 409 });
    expect(await reasonOf(setRoomUsable(Y, R, null, false, null, client))).toEqual(['conflict', 'lock_conflict']);
    expect(issued).toHaveLength(1);
  });

  it('RLS で書けなければ forbidden（insert のエラーでも 0 行でも）', async () => {
    const denied = fake({ error: { code: '42501', message: 'new row violates row-level security policy' }, status: 403 });
    await expect(setRoomUsable(Y, R, null, false, null, denied.client)).rejects.toMatchObject({ info: { kind: 'forbidden' } });
    const empty = fake({ data: null });
    await expect(setRoomUsable(Y, R, null, false, null, empty.client)).rejects.toMatchObject({ info: { kind: 'forbidden' } });
  });

  it('通信の失敗は network のまま（届いたか分からない。conflict にしない）', async () => {
    const { client } = fake({ data: null, error: { code: '', message: 'TypeError: Failed to fetch' }, status: 0 });
    expect(await reasonOf(setRoomUsable(Y, R, null, false, null, client))).toEqual(['network', null]);
  });

  it('id・updated_at の形が違えば送らない', async () => {
    const { client, issued } = fake({ data: null });
    await expect(setRoomUsable('x', R, null, false, null, client)).rejects.toBeInstanceOf(AppError);
    await expect(setRoomUsable(Y, R, '', false, null, client)).rejects.toBeInstanceOf(AppError);
    expect(issued).toHaveLength(0);
  });
});

const NETWORK: FakeResult = { data: null, error: { code: '', message: 'TypeError: Failed to fetch' }, status: 0 };

/**
 * 画面の使い方（2.6 の (B1)）：setRoomUsable が応答なし・conflict・not_found で失敗したら、readRoomYear で読み直して
 * settleLockedWrite で決める。読み直しの応答は reread で順に返す（setRoomUsable の中の 0 行の読み直しも select だけ）。
 */
async function saveRoomUsable(write: FakeResult, rereads: FakeResult[], base: string | null, usable: boolean, note: string | null) {
  const queue = [...rereads];
  const { client, issued } = createFakeSupabase((call: FakeCall) => {
    const isWrite = call.ops.some((o) => o.op === 'update' || o.op === 'insert' || o.op === 'upsert');
    if (isWrite) return write;
    const next = queue.shift();
    if (!next) throw new Error('読み直しが多すぎる');
    return next;
  });
  try {
    await setRoomUsable(Y, R, base, usable, note, client);
    return { result: 'ok' as const, issued };
  } catch (e) {
    if (!isUnknownOutcome(e) && !isLockRejection(e)) return { result: 'thrown' as const, issued };
    const outcome = await settleLockedWrite({
      reread: () => readRoomYear(Y, R, client),
      matches: (row) => roomYearMatches(row, usable, note),
      baseVersion: base,
      versionOf: (row) => row.updated_at,
    });
    return { result: outcome, unknown: isUnknownOutcome(e), issued };
  }
}

describe('setRoomUsable の応答が届かなかったとき・止められたとき（2.6 の (B1)）', () => {
  const row = (usable: boolean, note: string | null, updated_at: string) => ({ year_id: Y, room_id: R, usable, note, updated_at });

  it('readRoomYear は (year_id, room_id) で1行読む。なければ null、失敗は AppError', async () => {
    const { client, issued } = fake({ data: null }, { data: row(false, null, T1) });
    expect(await readRoomYear(Y, R, client)).toEqual(row(false, null, T1));
    expect(issued[0]!.ops.map((o) => o.op)).toEqual(['select', 'match', 'maybeSingle']);
    expect(opArgs(issued[0]!, 'match')).toEqual([[{ year_id: Y, room_id: R }]]);
    expect(await readRoomYear(Y, R, fake({ data: null }, { data: null }).client)).toBeNull();
    await expect(readRoomYear(Y, R, fake({ data: null }, NETWORK).client)).rejects.toBeInstanceOf(AppError);
  });

  it('roomYearMatches は note を setRoomUsable と同じにそろえて比べる（前後の空白・空は null）', () => {
    expect(roomYearMatches({ usable: false, note: '工事' }, false, '  工事 ')).toBe(true);
    expect(roomYearMatches({ usable: false, note: null }, false, '   ')).toBe(true);
    expect(roomYearMatches({ usable: true, note: '工事' }, false, '工事')).toBe(false);
    expect(roomYearMatches({ usable: false, note: '別' }, false, '工事')).toBe(false);
  });

  it('更新の応答が届かず、読み直すと書いた値 → saved（「保存されていました」）', async () => {
    const r = await saveRoomUsable(NETWORK, [{ data: row(false, '工事', T1) }], T0, false, ' 工事 ');
    expect(r).toMatchObject({ result: 'saved', unknown: true });
    // 書き込み1回と読み直し1回だけ（自動で送り直さない）
    expect(r.issued.map((c) => c.ops[0]!.op)).toEqual(['update', 'select']);
  });

  it('更新の応答が届かず、版が入力の元のまま → not-saved（入力を残して unknownOutcomeMessage。次の保存はふつうに送る）', async () => {
    expect(await saveRoomUsable(NETWORK, [{ data: row(true, null, T0) }], T0, false, null)).toMatchObject({
      result: 'not-saved',
      unknown: true,
    });
  });

  it('応答が届かず、読み直しも通信できない → unread', async () => {
    expect(await saveRoomUsable(NETWORK, [NETWORK], T0, false, null)).toMatchObject({ result: 'unread', unknown: true });
  });

  it('前の送信が後から通っていて、次の保存が conflict → 読み直すと書いた値なので saved', async () => {
    // update の 0 行 → setRoomUsable の中の読み直し（updated_at が違う → conflict）→ readRoomYear
    const r = await saveRoomUsable({ data: null }, [{ data: { updated_at: T1 } }, { data: row(false, '工事', T1) }], T0, false, '工事');
    expect(r).toMatchObject({ result: 'saved', unknown: false });
  });

  it('conflict で、読み直すとほかの人の値 → changed（今までの conflict の扱い）', async () => {
    const r = await saveRoomUsable({ data: null }, [{ data: { updated_at: T1 } }, { data: row(true, '戻した', T1) }], T0, false, '工事');
    expect(r).toMatchObject({ result: 'changed', unknown: false });
  });

  it('not_found（行がなくなった）→ changed', async () => {
    const r = await saveRoomUsable({ data: null }, [{ data: null }, { data: null }], T0, false, null);
    expect(r).toMatchObject({ result: 'changed', unknown: false });
  });

  it('insert が 23505 で、読み直すと書いた値（前の insert が通っていた）→ saved', async () => {
    const dup: FakeResult = { error: { code: '23505', message: 'duplicate key value violates unique constraint' }, status: 409 };
    expect(await saveRoomUsable(dup, [{ data: row(false, null, T1) }], null, false, null)).toMatchObject({ result: 'saved' });
    expect(await saveRoomUsable(dup, [{ data: row(true, null, T1) }], null, false, null)).toMatchObject({ result: 'changed' });
  });

  it('insert の応答が届かず、行がない → not-saved。conflict の後に読み直せない → unread', async () => {
    expect(await saveRoomUsable(NETWORK, [{ data: null }], null, false, null)).toMatchObject({ result: 'not-saved', unknown: true });
    expect(await saveRoomUsable({ data: null }, [{ data: { updated_at: T1 } }, NETWORK], T0, false, null)).toMatchObject({
      result: 'unread',
      unknown: false,
    });
  });

  it('forbidden（RLS）は読み直さず 2.5 の表のとおり', async () => {
    const r = await saveRoomUsable({ data: null }, [{ data: { updated_at: T0 } }], T0, false, null);
    expect(r.result).toBe('thrown');
    expect(r.issued).toHaveLength(2);
  });
});

describe('fixedRowsFrom と opsBeforeUnusable（使用不可にする前に直す行。3.9）', () => {
  const rows = [
    { id: 'a', sourceRoomId: R, origin: 'auto' as const, pinned: false },
    { id: 'b', sourceRoomId: R, origin: 'auto' as const, pinned: true },
    { id: 'c', sourceRoomId: R, origin: 'manual' as const, pinned: false },
    { id: 'd', sourceRoomId: R, origin: 'manual' as const, pinned: true },
    { id: 'e', sourceRoomId: R2, origin: 'manual' as const, pinned: true },
  ];

  it('その部屋からの固定・手動の行だけ（未固定の自動の行は再実行で動くので含めない）', () => {
    expect(fixedRowsFrom(rows, R).map((r) => r.id)).toEqual(['b', 'c', 'd']);
    expect(fixedRowsFrom(rows, 'none')).toEqual([]);
  });

  it('固定の自動の行は「固定を外す」も出し、手動の行は「運び元を変える」「削除」だけ', () => {
    expect(opsBeforeUnusable(rows[1]!)).toEqual(['unpin', 'change_source', 'delete']);
    expect(opsBeforeUnusable(rows[2]!)).toEqual(['change_source', 'delete']);
    expect(opsBeforeUnusable(rows[3]!)).toEqual(['change_source', 'delete']);
  });
});
