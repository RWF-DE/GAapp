// 現状復帰の写真の読み取りと並べ替え（04「現状復帰の写真」。T25・D-63）
import { describe, expect, it } from 'vitest';
import { createFakeSupabase } from '@/lib/testing/fake-supabase';
import type { AppSupabaseClient } from '@/lib/supabase/client';
import { staticImportGraph } from '@/lib/testing/import-graph';
import {
  countRoomPhotos,
  fetchRoomPhotos,
  movePhotoChanges,
  photoCountLabel,
  roomPhotosPath,
  sortRooms,
  splitRoomPhotos,
  type RoomPhotoRow,
} from './room-photos';

const Y = 'y9';
const P = 'y8';
const photo = (id: string, over: Partial<RoomPhotoRow> = {}): RoomPhotoRow => ({
  id,
  year_id: Y,
  room_id: 'r1',
  object_path: `${Y}/r1/${id}.webp`,
  memo: '',
  sort_order: 0,
  created_at: '2026-11-10T00:00:00Z',
  created_by: null,
  updated_at: '2026-11-10T00:00:00Z',
  ...over,
});

describe('T25 写真の並び・分け方・数え方', () => {
  it('今年と前年に分け、どちらも sort_order → created_at → id の順', () => {
    const rows = [
      photo('c', { sort_order: 1 }),
      photo('b', { sort_order: 0, created_at: '2026-11-10T01:00:00Z' }),
      photo('a', { sort_order: 0, created_at: '2026-11-10T01:00:00Z' }),
      photo('z', { sort_order: 0, created_at: '2026-11-09T00:00:00Z' }),
      photo('p2', { year_id: P, sort_order: 2 }),
      photo('p1', { year_id: P, sort_order: 1 }),
      photo('old', { year_id: 'y7' }),
    ];
    const s = splitRoomPhotos(rows, Y, P);
    expect(s.current.map((r) => r.id)).toEqual(['z', 'a', 'b', 'c']);
    expect(s.previous.map((r) => r.id)).toEqual(['p1', 'p2']);
    expect(splitRoomPhotos(rows, Y, null).previous).toEqual([]);
  });

  it('部屋ごとの枚数と文字（0 枚は「まだ」、前の年度がなければ前年を出さない）', () => {
    const rows = [photo('a'), photo('b'), photo('c', { room_id: 'r2', year_id: P }), photo('d', { room_id: 'r2', year_id: 'y7' })];
    const m = countRoomPhotos(rows, Y, P);
    expect(m.get('r1')).toEqual({ current: 2, previous: 0 });
    expect(m.get('r2')).toEqual({ current: 0, previous: 1 });
    expect(photoCountLabel(m.get('r1'), true)).toBe('今年 2 枚・前年 まだ');
    expect(photoCountLabel(m.get('r2'), true)).toBe('今年 まだ・前年 1 枚');
    expect(photoCountLabel(undefined, true)).toBe('今年 まだ・前年 まだ');
    expect(photoCountLabel(m.get('r1'), false)).toBe('今年 2 枚');
  });

  it('場所の並びは sort_order → 名前 → id', () => {
    const r = (id: string, name: string, sort_order: number) => ({ id, name, sort_order });
    expect(sortRooms([r('3', 'B', 1), r('2', 'A', 1), r('1', 'Z', 0), r('0', 'A', 1)]).map((x) => x.id)).toEqual(['1', '0', '2', '3']);
  });

  it('前へ・後ろへ：隣と sort_order を入れ替える。端は動かさない。同じ値なら 0 から振り直す（変わる物だけ）', () => {
    const list = [photo('a', { sort_order: 0 }), photo('b', { sort_order: 5 }), photo('c', { sort_order: 9 })];
    expect(movePhotoChanges(list, 'b', -1)).toEqual([
      { id: 'b', sortOrder: 0 },
      { id: 'a', sortOrder: 5 },
    ]);
    expect(movePhotoChanges(list, 'b', 1)).toEqual([
      { id: 'b', sortOrder: 9 },
      { id: 'c', sortOrder: 5 },
    ]);
    expect(movePhotoChanges(list, 'a', -1)).toEqual([]);
    expect(movePhotoChanges(list, 'c', 1)).toEqual([]);
    expect(movePhotoChanges(list, 'x', 1)).toEqual([]);
    const same = [photo('a', { sort_order: 1, created_at: '1' }), photo('b', { sort_order: 1, created_at: '2' }), photo('c', { sort_order: 1, created_at: '3' })];
    expect(movePhotoChanges(same, 'b', -1)).toEqual([
      { id: 'b', sortOrder: 0 },
      { id: 'c', sortOrder: 2 },
    ]);
  });

  it('パスは /room-photos と ?room=', () => {
    expect(roomPhotosPath()).toBe('/room-photos');
    expect(roomPhotosPath('r 1')).toBe('/room-photos?room=r%201');
  });
});

describe('T25 読み取り', () => {
  it('room_photos_with_previous を年度と部屋（一覧では null）で呼ぶ', async () => {
    const fake = createFakeSupabase((c) => (c.table === 'rpc:room_photos_with_previous' ? { data: [photo('a')] } : { data: null }));
    const client = fake.client as unknown as AppSupabaseClient;
    expect((await fetchRoomPhotos('00000000-0000-4000-8000-000000000001', null, client)).map((r) => r.id)).toEqual(['a']);
    await fetchRoomPhotos('00000000-0000-4000-8000-000000000001', '00000000-0000-4000-8000-000000000002', client);
    expect(fake.issued.map((c) => c.ops[0]?.args[0])).toEqual([
      { p_year_id: '00000000-0000-4000-8000-000000000001', p_room_id: null },
      { p_year_id: '00000000-0000-4000-8000-000000000001', p_room_id: '00000000-0000-4000-8000-000000000002' },
    ]);
  });

  it('このファイルは送る部品（lib/room-photos/upload）と作り直し（image.ts）を静的に読まない（押したときに動的 import）', () => {
    const { files } = staticImportGraph('lib/data/room-photos.ts');
    expect(files.some((f) => f.includes('room-photos/upload') || f.includes('item-images/image') || f.includes('room-photos/messages'))).toBe(false);
  });
});
