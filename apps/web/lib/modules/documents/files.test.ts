// 提出物のファイルの決まり（04「提出物」のファイルの扱い。T19）：先頭のバイトでの形の判定（作ったバイト列で）、中身・形・数・大きさの
// 確かめと文言、番号、大きさの表示、1件の名前、保存の名前、path（DB の CHECK と同じ形）、1件の状態、「提出した」を押せない理由。
import { describe, expect, it } from 'vitest';
import {
  checkPicked,
  checkPrepared,
  checkSelection,
  displaySize,
  downloadNameFor,
  FILE_ACCEPT,
  FILE_EMPTY_MESSAGE,
  FILE_SIZE_MESSAGE,
  FILE_TYPE_MESSAGE,
  fileLabel,
  fileStateOf,
  formatFileSize,
  MAX_FILE_BYTES,
  MAX_FILES,
  numberFiles,
  objectPathFor,
  sniffContentType,
  STORAGE_LIMIT_BYTES,
  SUBMIT_BLOCKERS,
  submitBlocker,
  tooManyFilesMessage,
} from './files';

const bytes = (...b: number[]) => new Uint8Array(b);
const text = (s: string) => new TextEncoder().encode(s);

const Y = '11111111-1111-4111-8111-111111111111';
const G = '22222222-2222-4222-8222-222222222222';
const D = '33333333-3333-4333-8333-333333333333';
const F = '44444444-4444-4444-8444-444444444444';

describe('T19 sniffContentType（先頭のバイトで形を決める。名前とブラウザの形は見ない）', () => {
  it('PDF は %PDF-、JPEG は FF D8 FF、PNG は 89 50 4E 47 0D 0A 1A 0A', () => {
    expect(sniffContentType(text('%PDF-1.7\n%âãÏÓ'))).toBe('application/pdf');
    expect(sniffContentType(bytes(0xff, 0xd8, 0xff, 0xe0, 0x00, 0x10))).toBe('image/jpeg');
    expect(sniffContentType(bytes(0xff, 0xd8, 0xff, 0xe1))).toBe('image/jpeg');
    expect(sniffContentType(bytes(0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0x00))).toBe('image/png');
  });

  it('ほか・短すぎる・途中まで同じものは null（HEIC・GIF・ZIP・テキスト・「%PDF」だけ・PNG の 7 バイト）', () => {
    expect(sniffContentType(bytes(0x00, 0x00, 0x00, 0x18, 0x66, 0x74, 0x79, 0x70))).toBeNull(); // HEIC（ftyp）
    expect(sniffContentType(text('GIF89a'))).toBeNull();
    expect(sniffContentType(bytes(0x50, 0x4b, 0x03, 0x04))).toBeNull();
    expect(sniffContentType(text('hello'))).toBeNull();
    expect(sniffContentType(text('%PDF'))).toBeNull();
    expect(sniffContentType(bytes(0xff, 0xd8))).toBeNull();
    expect(sniffContentType(bytes(0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a))).toBeNull();
    expect(sniffContentType(new Uint8Array())).toBeNull();
    // 拡張子のような文字が先頭にあっても見ない
    expect(sniffContentType(text('PDF %PDF-'))).toBeNull();
  });

  it('accept はこの3つの形', () => {
    expect(FILE_ACCEPT).toBe('application/pdf,image/jpeg,image/png');
  });
});

describe('T19 選んだファイルの確かめ（04「ファイルの扱い」：1つでも合わなければどれも送らない）', () => {
  const pdf = (size = 1000) => ({ size, type: 'application/pdf' as const });

  it('中身がない（0 バイト）→ 形 → 数の順に、最初の理由の文言', () => {
    expect(checkPicked([pdf(), pdf(0)], 0)).toEqual({ ok: false, message: FILE_EMPTY_MESSAGE });
    expect(checkPicked([pdf(), { size: 10, type: null }], 0)).toEqual({ ok: false, message: FILE_TYPE_MESSAGE });
    // 0 バイトで形も読めないものは、中身がない方を出す
    expect(checkPicked([{ size: 0, type: null }], 0)).toEqual({ ok: false, message: FILE_EMPTY_MESSAGE });
    expect(checkPicked([pdf(), pdf()], 0)).toEqual({ ok: true });
  });

  it('数：その提出のファイル（届いていないものを含む）と合わせて 5 つまで。超えれば「あと {n} つ足せます」', () => {
    expect(MAX_FILES).toBe(5);
    expect(checkPicked([pdf(), pdf()], 3)).toEqual({ ok: true });
    expect(checkPicked([pdf(), pdf(), pdf()], 3)).toEqual({ ok: false, message: tooManyFilesMessage(2) });
    expect(tooManyFilesMessage(2)).toBe('選んだファイルが多すぎます。この提出物には、あと 2 つ足せます（1つの提出物に 5 つまで）');
    expect(checkPicked(Array.from({ length: 6 }, () => pdf()), 0)).toEqual({ ok: false, message: tooManyFilesMessage(5) });
    expect(checkPicked([pdf()], 5)).toEqual({ ok: false, message: tooManyFilesMessage(0) });
    expect(tooManyFilesMessage(-1)).toContain('あと 0 つ');
  });

  it('大きさ（作り直した後）：1 バイト以上 10 MiB（10,485,760 バイト）まで', () => {
    expect(MAX_FILE_BYTES).toBe(10485760);
    expect(checkPrepared([1, MAX_FILE_BYTES])).toEqual({ ok: true });
    expect(checkPrepared([1, MAX_FILE_BYTES + 1])).toEqual({ ok: false, message: FILE_SIZE_MESSAGE });
    expect(checkPrepared([0])).toEqual({ ok: false, message: FILE_EMPTY_MESSAGE });
    expect(FILE_SIZE_MESSAGE).toBe('10 MB を超えるファイルがあります（1つ 10 MB まで）');
    expect(FILE_TYPE_MESSAGE).toBe('PDF・JPEG・PNG 以外のファイルがあります。PDF・JPEG・PNG を選んでください');
  });

  it('checkSelection：作り直す前の大きい写真も、作り直した後の大きさで見る（prepared がなければ選んだときの大きさ）', () => {
    const photo = { size: 15 * 1024 * 1024, type: 'image/jpeg' as const };
    expect(checkSelection([photo], 0)).toEqual({ ok: false, message: FILE_SIZE_MESSAGE });
    expect(checkSelection([photo], 0, [900_000])).toEqual({ ok: true });
    expect(checkSelection([photo, { size: 5, type: null }], 0, [900_000, 5])).toEqual({ ok: false, message: FILE_TYPE_MESSAGE });
  });
});

describe('T19 番号・大きさ・名前', () => {
  it('numberFiles：created_at → id の順に 1, 2, …（元の配列は変えない）', () => {
    const files = [
      { id: 'b', created_at: '2026-10-05T08:00:00Z' },
      { id: 'c', created_at: '2026-10-04T08:00:00Z' },
      { id: 'a', created_at: '2026-10-05T08:00:00Z' },
    ];
    expect(numberFiles(files).map((x) => [x.n, x.file.id])).toEqual([
      [1, 'c'],
      [2, 'a'],
      [3, 'b'],
    ]);
    expect(files.map((f) => f.id)).toEqual(['b', 'c', 'a']);
  });

  it('formatFileSize：1 MB 未満は KB（切り上げ）、10 MB 未満は小数1桁の MB、ほかは整数の MB（1 KB は 1,024 バイト）', () => {
    expect(formatFileSize(0)).toBe('0 KB');
    expect(formatFileSize(1)).toBe('1 KB');
    expect(formatFileSize(1024)).toBe('1 KB');
    expect(formatFileSize(1025)).toBe('2 KB');
    expect(formatFileSize(1024 * 1024 - 1)).toBe('1024 KB');
    expect(formatFileSize(1024 * 1024)).toBe('1.0 MB');
    expect(formatFileSize(1_258_291)).toBe('1.2 MB');
    expect(formatFileSize(10 * 1024 * 1024 - 1)).toBe('10 MB');
    expect(formatFileSize(10 * 1024 * 1024)).toBe('10 MB');
    expect(formatFileSize(180 * 1024 * 1024)).toBe('180 MB');
    expect(formatFileSize(STORAGE_LIMIT_BYTES)).toBe('900 MB');
    expect(formatFileSize(Number.NaN)).toBe('0 KB');
    expect(formatFileSize(-5)).toBe('0 KB');
  });

  it('fileLabel：「ファイル 1（PDF・1.2 MB・10/5 17:00）」。届いたものは実際の大きさ、届いていないものは申告の大きさ。元の名前は出さない', () => {
    const f = { content_type: 'application/pdf', size: 2_000_000, stored_size: 1_258_291, uploaded: true, created_at: '2026-10-05T08:00:00Z' };
    expect(fileLabel(1, f)).toBe('ファイル 1（PDF・1.2 MB・10/5 17:00）');
    expect(displaySize(f)).toBe(1_258_291);
    expect(fileLabel(2, { ...f, uploaded: false, stored_size: null, content_type: 'image/jpeg' })).toBe('ファイル 2（JPEG・1.9 MB・10/5 17:00）');
    expect(fileLabel(3, { ...f, content_type: 'image/png', stored_size: 2048 })).toBe('ファイル 3（PNG・2 KB・10/5 17:00）');
  });

  it('downloadNameFor：「{提出物}_{団体}_{n}.{拡張子}」。使えない文字と制御文字は _、それぞれ 40 字まで', () => {
    expect(downloadNameFor('出店計画書', '模擬店01', 2, 'application/pdf')).toBe('出店計画書_模擬店01_2.pdf');
    expect(downloadNameFor('食品/届け:第1回*?', 'A<B>|"C"\\', 1, 'image/jpeg')).toBe('食品_届け_第1回___A_B___C___1.jpg');
    expect(downloadNameFor('改行\nとタブ\tと\u0000', '団体', 3, 'image/png')).toBe('改行_とタブ_と__団体_3.png');
    const long = 'あ'.repeat(50);
    expect(downloadNameFor(long, '😀'.repeat(45), 1, 'application/pdf')).toBe(`${'あ'.repeat(40)}_${'😀'.repeat(40)}_1.pdf`);
    expect(downloadNameFor('  ', ' ', 1, 'application/pdf')).toBe('提出物_団体_1.pdf');
  });

  it('objectPathFor：`{year_id}/{group_id}/{document_id}/{file_id}.{pdf|jpg|png}`（uuid は小文字。DB の CHECK と同じ）', () => {
    expect(objectPathFor(Y, G, D, F, 'application/pdf')).toBe(`${Y}/${G}/${D}/${F}.pdf`);
    expect(objectPathFor(Y.toUpperCase(), G, D, F.toUpperCase(), 'image/jpeg')).toBe(`${Y}/${G}/${D}/${F}.jpg`);
    expect(objectPathFor(Y, G, D, F, 'image/png')).toMatch(/^[0-9a-f-]{36}\/[0-9a-f-]{36}\/[0-9a-f-]{36}\/[0-9a-f-]{36}\.png$/);
  });
});

describe('T19 1件の状態と「提出した」を押せない理由', () => {
  it('fileStateOf：届いた → そのタブで上げている → そのタブで失敗した → 届いていない', () => {
    const local = { uploading: new Set(['u']), failed: new Set(['f']) };
    expect(fileStateOf({ id: 'u', uploaded: true }, local)).toBe('uploaded');
    expect(fileStateOf({ id: 'u', uploaded: false }, local)).toBe('uploading');
    expect(fileStateOf({ id: 'f', uploaded: null }, local)).toBe('failed');
    expect(fileStateOf({ id: 'x', uploaded: false }, local)).toBe('missing');
    expect(fileStateOf({ id: 'x', uploaded: false })).toBe('missing');
  });

  it('fileStateOf：そのタブで上げ終えて読み直しを待つもの（sent）は、行の uploaded が古くても届いたとして出す（「届いていません」を一瞬出さない。レビューの UX-2）', () => {
    const local = { uploading: new Set(['u']), failed: new Set(['f']), sent: new Set(['s', 'f']) };
    expect(fileStateOf({ id: 's', uploaded: false }, local)).toBe('uploaded');
    expect(fileStateOf({ id: 'u', uploaded: false }, local)).toBe('uploading');
    // 失敗の印が付いていれば失敗（もう一度の前の状態）
    expect(fileStateOf({ id: 'f', uploaded: false }, local)).toBe('failed');
  });

  it('submitBlocker：送っている間 → 届いていないファイル（DB の not_uploaded と同じ条件）。ファイルがなくても出せる（T24。no_file は返らない）', () => {
    expect(submitBlocker([], false)).toBeNull();
    expect(submitBlocker([{ uploaded: false }], false)).toBe(SUBMIT_BLOCKERS.notUploaded);
    expect(submitBlocker([{ uploaded: true }, { uploaded: null }], false)).toBe(SUBMIT_BLOCKERS.notUploaded);
    expect(submitBlocker([{ uploaded: true }], true)).toBe(SUBMIT_BLOCKERS.uploading);
    expect(submitBlocker([{ uploaded: true }], false)).toBeNull();
    expect(SUBMIT_BLOCKERS).toEqual({
      notUploaded: '届いていないファイルがあります。外してから提出してください',
      uploading: 'アップロードが終わるまでお待ちください',
    });
  });
});
