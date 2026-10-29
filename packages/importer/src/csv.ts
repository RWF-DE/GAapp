// Googleフォームの回答 CSV を読む最小のパーサ（ブラウザでも動く。Node の API は使わない）。
// Google / Excel が書き出す CSV に合わせ、BOM と CRLF・CR・LF を受け付ける（shared/testing の parseCsv は fixtures 用で厳格）。

export function parseCsvLoose(text: string): string[][] {
  const src = text.charCodeAt(0) === 0xfeff ? text.slice(1) : text;
  const rows: string[][] = [];
  let row: string[] = [];
  let field = '';
  let quoted = false;
  let started = false; // 今の行に何か（区切りを含む）書いたか
  for (let i = 0; i < src.length; i++) {
    const c = src[i]!;
    if (quoted) {
      if (c === '"') {
        if (src[i + 1] === '"') {
          field += '"';
          i++;
        } else quoted = false;
      } else field += c;
      continue;
    }
    if (c === '"' && field === '') {
      quoted = true;
      started = true;
    } else if (c === ',') {
      row.push(field);
      field = '';
      started = true;
    } else if (c === '\n' || c === '\r') {
      if (c === '\r' && src[i + 1] === '\n') i++;
      if (started || field !== '') {
        row.push(field);
        rows.push(row);
      }
      row = [];
      field = '';
      started = false;
    } else {
      field += c;
      started = true;
    }
  }
  if (quoted) throw new Error('CSV の引用符が閉じていません');
  if (started || field !== '') {
    row.push(field);
    rows.push(row);
  }
  return rows;
}
