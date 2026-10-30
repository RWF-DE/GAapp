import { allocationXlsxFileName } from '@gaapp/exporter';
import { fixturePath, readFixtureDir } from '@gaapp/shared/testing';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { fixtureSnapshot } from '@/lib/testing/fixture-rows';
import {
  allocationExportFileName,
  assertExportableGroupNames,
  downloadAllocationXlsx,
  ExportBlockedError,
  isBeforeConfirm,
  toReportInput,
} from './export';

const saved = vi.hoisted(() => ({ files: [] as { data: Uint8Array | string; fileName: string; mime: string }[] }));
vi.mock('@/lib/download', async (orig) => ({
  ...(await orig<typeof import('@/lib/download')>()),
  downloadFile: (data: Uint8Array | string, fileName: string, mime: string) => saved.files.push({ data, fileName, mime }),
}));

const fx = readFixtureDir(fixturePath('synthetic', 'r8like'));

beforeEach(() => {
  saved.files.length = 0;
});

describe('ファイル名（Q3）', () => {
  it('確定・終了は exporter の allocationXlsxFileName と同じ', () => {
    expect(allocationExportFileName('R8', 'confirmed')).toBe(allocationXlsxFileName('R8'));
    expect(allocationExportFileName('R8', 'closed')).toBe(allocationXlsxFileName('R8'));
  });
  it('確定前は _確定前 をつける', () => {
    for (const s of ['preparing', 'requesting', 'allocating'] as const) {
      expect(isBeforeConfirm(s)).toBe(true);
      expect(allocationExportFileName('R8', s)).toBe('R8_椅子机振り分け_部門員共有用_確定前.xlsx');
    }
    expect(isBeforeConfirm('confirmed')).toBe(false);
  });
});

describe('downloadAllocationXlsx', () => {
  it('exporter で xlsx を作って保存させる（確定前のファイル名）', async () => {
    const snapshot = fixtureSnapshot(fx, { status: 'allocating' });
    const { fileName } = await downloadAllocationXlsx(snapshot, { generatedAt: new Date('2026-10-29T00:00:00Z') });
    expect(fileName).toBe(`${snapshot.year.label}_椅子机振り分け_部門員共有用_確定前.xlsx`);
    expect(saved.files).toHaveLength(1);
    const f = saved.files[0]!;
    expect(f.fileName).toBe(fileName);
    expect(f.mime).toBe('application/vnd.openxmlformats-officedocument.spreadsheetml.sheet');
    const bytes = f.data as Uint8Array;
    expect([...bytes.subarray(0, 2)]).toEqual([0x50, 0x4b]); // ZIP（xlsx）
  });

  it('確定後は共有用のファイル名', async () => {
    const { fileName } = await downloadAllocationXlsx(fixtureSnapshot(fx, { status: 'confirmed' }));
    expect(fileName).toBe(allocationXlsxFileName(fx.meta.yearLabel));
  });

  it('SUMIF に使えない団体名があれば、名前を添えて止める（ファイルを作らない）', async () => {
    const s = fixtureSnapshot(fx);
    s.groups[0] = { ...s.groups[0]!, name: '(計)' };
    await expect(downloadAllocationXlsx(s)).rejects.toThrow(ExportBlockedError);
    expect(() => assertExportableGroupNames(s)).toThrow(
      '団体名「(計)」は Excel の集計に使えません。マスタ設定で名前を変えてから出力してください',
    );
    expect(saved.files).toHaveLength(0);
  });

  it('シート名に使えない品目名があれば、exporter の日本語の文をそのまま画面に出せる形（ExportBlockedError）で止める', async () => {
    const s = fixtureSnapshot(fx);
    s.items = s.items.map((i) => (i.code === 'caster_desk' ? { ...i, name: 'キャスター/机' } : i));
    const err = await downloadAllocationXlsx(s).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(ExportBlockedError);
    expect((err as Error).message).toMatch(/^品目名を変えてから出力してください：/);
    expect((err as Error).message).toContain('「キャスター/机」');
    expect((err as Error).message).toContain('マスタ設定');
    expect(saved.files).toHaveLength(0);
  });

  it('viewer のスナップショット（在庫なし）では出さない', async () => {
    const s = { ...fixtureSnapshot(fx), part: 'public' as const };
    await expect(downloadAllocationXlsx(s)).rejects.toThrow(ExportBlockedError);
  });

  it('toReportInput：全行を手で書いた備考つきで渡す', () => {
    const s = fixtureSnapshot(fx);
    s.allocations = [
      {
        id: 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa',
        year_id: s.year.id,
        source_room_id: s.rooms[0]!.id,
        group_id: s.groups[0]!.id,
        item_id: s.items[0]!.id,
        requested_item_id: s.items[0]!.id,
        count: 2,
        is_keep: false,
        origin: 'manual',
        pinned: true,
        note: '団体の希望',
        updated_at: 't',
      },
    ];
    const input = toReportInput(s);
    expect(input.yearLabel).toBe(s.year.label);
    expect(input.rows).toEqual([
      { sourceRoomId: s.rooms[0]!.id, groupId: s.groups[0]!.id, itemId: s.items[0]!.id, requestedItemId: s.items[0]!.id, count: 2, isKeep: false, note: '団体の希望' },
    ]);
  });
});
