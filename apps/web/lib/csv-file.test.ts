import { describe, expect, it } from 'vitest';
import { CsvEncodingError, decodeCsvBytes, readCsvFile } from './csv-file';

// 「団体名,机(木)」の Shift_JIS（Excel で保存し直した CSV の形）
const SJIS = new Uint8Array([0x92, 0x63, 0x91, 0xcc, 0x96, 0xbc, 0x2c, 0x8a, 0xf7, 0x28, 0x96, 0xd8, 0x29]);

describe('decodeCsvBytes', () => {
  it('UTF-8 は BOM を除いて読む（TextDecoder が除く）', () => {
    const utf8 = new TextEncoder().encode('\uFEFF団体名,机(木)\r\n模擬店甲,4');
    const r = decodeCsvBytes(utf8);
    expect(r.encoding).toBe('utf-8');
    expect(r.text).toBe('団体名,机(木)\r\n模擬店甲,4');
  });

  it('UTF-8 で読めなければ Shift_JIS で読む', () => {
    expect(decodeCsvBytes(SJIS)).toEqual({ text: '団体名,机(木)', encoding: 'shift_jis' });
  });

  it('どちらでも読めなければ CsvEncodingError（中身を文言に入れない）', () => {
    const bad = new Uint8Array([0x82, 0xff, 0xfd]);
    expect(() => decodeCsvBytes(bad)).toThrow(CsvEncodingError);
    expect(() => decodeCsvBytes(bad)).toThrow('文字コードが読めません（UTF-8 か Shift_JIS の CSV にしてください）');
  });

  it('Blob からも読める', async () => {
    const r = await readCsvFile(new Blob([SJIS]));
    expect(r.encoding).toBe('shift_jis');
  });
});
