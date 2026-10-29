// 様式のテスト用の小さな入力（使用不可の部屋・2列でまとまる行・自動の備考・在庫超過を含む）
import { FixtureBuilder, RULES } from '@gaapp/shared/testing';
import type { ExportRow } from '../types';

export function scenario() {
  const b = new FixtureBuilder('R8')
    .room('A教室', { sortOrder: 1 })
    .room('B教室', { sortOrder: 2, usable: false })
    .room('C教室', { sortOrder: 3 })
    .room('外1', { kind: 'outdoor', sortOrder: 4 })
    .room('外2', { kind: 'outdoor', sortOrder: 5 })
    .group('たこ焼き', 'stall', '外1', { sortOrder: 1 })
    .group('焼きそば', 'stall', '外2', { sortOrder: 2 })
    .group('室内店', 'stall', 'C教室', { sortOrder: 3, displayName: 'ミニ縁日' })
    .stock('A教室', { desk: 10, desk_ng: 4, chair: 5 })
    .stock('B教室', { desk: 7, chair: 2, desk_ng: 1 })
    .stock('C教室', { desk: 3, caster_desk: 4 })
    .rule(RULES.S01(), RULES.S07())
    .consent('室内店', 'desk', 'caster_desk', 'accepted', 2);
  const ix = b.ids();
  const row = (source: string, group: string, item: string, count: number, req = item, keep = false, note: string | null = null): ExportRow => ({
    sourceRoomId: ix.roomId(source),
    groupId: ix.groupId(group),
    itemId: ix.itemId(item),
    requestedItemId: ix.itemId(req),
    count,
    isKeep: keep,
    note,
  });
  const rows = [
    row('A教室', 'たこ焼き', 'desk', 3),
    row('A教室', 'たこ焼き', 'desk_ng', 2, 'desk'),
    row('A教室', '焼きそば', 'desk', 2),
    row('C教室', '室内店', 'desk', 3, 'desk', true),
    row('C教室', '室内店', 'caster_desk', 3, 'desk', true),
    row('C教室', 'たこ焼き', 'chair', 1, 'chair', false, '手で書いた備考'),
  ];
  return { b, ix, rows, data: b.yearData() };
}

