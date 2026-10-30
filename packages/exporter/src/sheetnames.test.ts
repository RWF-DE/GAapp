// 品目名をシート名に使えるかの確認（マージの後の直し。03「Excel出力仕様」のシート構成）
import { describe, expect, it, vi } from 'vitest';
import type { YearData } from '@gaapp/shared';
import { scenario } from './testing/scenario';
import { buildAllocationSheets, exportAllocationXlsx, exportSwapsXlsx, ExportInputError, SUMMARY_SHEET_NAME } from './index';

/** 品目コード → 新しい名前 で品目名を変えたデータ */
function renamed(names: Record<string, string>): { data: YearData; rows: ReturnType<typeof scenario>['rows'] } {
  const { data, rows } = scenario();
  return { data: { ...data, items: data.items.map((i) => (names[i.code] !== undefined ? { ...i, name: names[i.code]! } : i)) }, rows };
}

const expectBlocked = async (names: Record<string, string>, ...parts: (string | RegExp)[]) => {
  const { data, rows } = renamed(names);
  const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
  try {
    let err: unknown;
    try {
      buildAllocationSheets({ yearLabel: 'R8', data, rows });
    } catch (e) {
      err = e;
    }
    expect(err).toBeInstanceOf(ExportInputError);
    const msg = (err as Error).message;
    expect(msg).toMatch(/^品目名を変えてから出力してください：/);
    expect(msg).toMatch(/マスタ設定/);
    for (const p of parts) expect(msg).toMatch(p);
    await expect(exportAllocationXlsx({ yearLabel: 'R8', data, rows })).rejects.toBeInstanceOf(ExportInputError);
    expect(warn).not.toHaveBeenCalled(); // ExcelJS が黙って切り詰める（警告だけ出す）前に止める
  } finally {
    warn.mockRestore();
  }
};

describe('シート名にできない品目名', () => {
  it('Excel のシート名に使えない文字（* ? : \\ / [ ]）', async () => {
    for (const ch of ['*', '?', ':', '\\', '/', '[', ']']) {
      await expectBlocked({ caster_desk: `キャスター${ch}机` }, `「キャスター${ch}机」`, '* ? : \\ / [ ]');
    }
  });

  it('先頭か末尾が \'', async () => {
    await expectBlocked({ lectern: "'教卓" }, "「'教卓」", /'/);
    await expectBlocked({ lectern: "教卓'" }, "「教卓'」");
  });

  it('31 文字を超える（ExcelJS は黙って切り詰め、団体別集計の SUMIF が #REF! になる）', async () => {
    const long = 'あ'.repeat(32);
    await expectBlocked({ blue_chair: long }, `「${long}」`, /31/);
  });

  it('ほかのシートと同じ名前（大文字・小文字の違いだけも）・団体別集計・History', async () => {
    await expectBlocked({ long_desk_3: '長机', long_desk_2: '長机' }, '「長机」', /同じ/);
    await expectBlocked({ long_desk_3: 'Desk', long_desk_2: 'desk' }, '「desk」');
    await expectBlocked({ lectern: SUMMARY_SHEET_NAME }, `「${SUMMARY_SHEET_NAME}」`);
    await expectBlocked({ lectern: 'history' }, '「history」');
  });

  it('複数の品目名をまとめて知らせる', async () => {
    await expectBlocked({ desk: 'a/b', chair: 'c?d' }, '「a/b」', '「c?d」');
  });

  it('31 文字ちょうど・シートにならない品目（不可机）の名前は止めない', async () => {
    const ok = 'い'.repeat(31);
    const { data, rows } = renamed({ blue_chair: ok, desk_ng: '不可/机' });
    const sheets = buildAllocationSheets({ yearLabel: 'R8', data, rows });
    expect(sheets.map((s) => s.name)).toContain(ok);
    await expect(exportAllocationXlsx({ yearLabel: 'R8', data, rows })).resolves.toBeInstanceOf(Uint8Array);
  });

  it('交換依頼一覧は品目名をシート名に使わないので止めない', async () => {
    const { data, rows } = renamed({ caster_desk: 'キャスター/机' });
    await expect(exportSwapsXlsx({ yearLabel: 'R8', data, rows })).resolves.toBeInstanceOf(Uint8Array);
  });
});
