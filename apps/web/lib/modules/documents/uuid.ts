// 提出物とファイルの id（uuid v4。T19・D-55）。書き込みの JS（lib/data/documents.ts）を読む前に、選んだファイルに file_id を付けるため
// （/document は書き込みの JS を初めて使うときに読む。読めなくてもファイルを「アップロードできませんでした」として残し、「もう一度」で同じ
// file_id を送る。FU3 の PR B の案 5）、何も import しない小さなモジュールに置く。lib/data/documents.ts は同じ名前で出し直す。

/**
 * 登録の id（uuid v4）。ダイアログを開いたときに作り、閉じるまで（もう一度の送信と下書きを含めて）同じ id を使う（(B1)：送り直しは主キーの
 * 重複〔23505〕で止まる）。ファイルの id（予約の p_file_id）も同じ作り方（ファイルを選んだときに1つずつ作り、もう一度でも同じ id を使う）。
 * crypto.randomUUID のないとき（安全でない接続）は getRandomValues で作る。
 */
export function newDocumentUuid(): string {
  const c = globalThis.crypto;
  if (typeof c.randomUUID === 'function') return c.randomUUID();
  const b = c.getRandomValues(new Uint8Array(16));
  b[6] = (b[6]! & 0x0f) | 0x40;
  b[8] = (b[8]! & 0x3f) | 0x80;
  const h = [...b].map((x) => x.toString(16).padStart(2, '0')).join('');
  return `${h.slice(0, 8)}-${h.slice(8, 12)}-${h.slice(12, 16)}-${h.slice(16, 20)}-${h.slice(20)}`;
}
