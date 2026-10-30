// CSV ファイルの文字コードを決めて読む（画面の設計 5.1。T09a）。UTF-8（fatal）で読み、だめなら Shift_JIS で読む
// （Excel で保存し直した CSV のため）。どちらでも読めなければ CsvEncodingError。UTF-8 の BOM は TextDecoder が除く（残っても importer の parseCsvLoose が許す）。
// ファイルの中身はログに出さず、どこにも保存しない（読んだ文字列は画面の状態にだけ持つ）。

export type CsvEncoding = 'utf-8' | 'shift_jis';

export class CsvEncodingError extends Error {
  override name = 'CsvEncodingError';
  constructor() {
    super('文字コードが読めません（UTF-8 か Shift_JIS の CSV にしてください）');
  }
}

/** バイト列を UTF-8 → Shift_JIS の順で読む */
export function decodeCsvBytes(bytes: ArrayBuffer | Uint8Array): { text: string; encoding: CsvEncoding } {
  const view = bytes instanceof Uint8Array ? bytes : new Uint8Array(bytes);
  for (const encoding of ['utf-8', 'shift_jis'] as const) {
    try {
      return { text: new TextDecoder(encoding, { fatal: true }).decode(view), encoding };
    } catch {
      // 次の文字コードで読む
    }
  }
  throw new CsvEncodingError();
}

/** 選んだファイル（File・Blob）を読む */
export async function readCsvFile(file: Blob): Promise<{ text: string; encoding: CsvEncoding }> {
  return decodeCsvBytes(await file.arrayBuffer());
}
