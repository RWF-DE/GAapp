// 最小限の CSV（RFC 4180。UTF-8・LF・見出しつき）。fixtures の読み書きだけに使う

export function parseCsv(text: string): string[][] {
  if (text.charCodeAt(0) === 0xfeff) throw new Error('CSV に BOM があります（UTF-8 の BOM なしにしてください）');
  const rows: string[][] = [];
  let row: string[] = [];
  let field = '';
  let quoted = false;
  let i = 0;
  while (i < text.length) {
    const c = text[i]!;
    if (quoted) {
      if (c === '"') {
        if (text[i + 1] === '"') {
          field += '"';
          i += 2;
          continue;
        }
        quoted = false;
        i++;
        continue;
      }
      field += c;
      i++;
      continue;
    }
    if (c === '"' && field === '') {
      quoted = true;
      i++;
    } else if (c === ',') {
      row.push(field);
      field = '';
      i++;
    } else if (c === '\n') {
      row.push(field);
      rows.push(row);
      row = [];
      field = '';
      i++;
    } else if (c === '\r') {
      throw new Error('CSV の改行は LF にしてください（CR があります）');
    } else {
      field += c;
      i++;
    }
  }
  if (quoted) throw new Error('CSV の引用符が閉じていません');
  if (field !== '' || row.length > 0) {
    row.push(field);
    rows.push(row);
  }
  return rows;
}

function quote(v: string): string {
  return /[",\n\r]/.test(v) ? `"${v.replace(/"/g, '""')}"` : v;
}

export function formatCsv(header: readonly string[], rows: readonly (readonly string[])[]): string {
  return [header, ...rows].map((r) => r.map(quote).join(',')).join('\n') + '\n';
}

/** 見出しが期待どおり（同じ列・同じ順）の CSV を、見出し → 値のオブジェクトの配列にする */
export function readCsvRecords(text: string, expected: readonly string[], file: string): Record<string, string>[] {
  const rows = parseCsv(text);
  const header = rows[0];
  if (!header) throw new Error(`${file}: 見出しがありません`);
  if (header.length !== expected.length || header.some((h, k) => h !== expected[k])) {
    const unknown = header.filter((h) => !expected.includes(h));
    throw new Error(
      `${file}: 見出しが違います（期待：${expected.join(',')}${unknown.length ? `、知らない列：${unknown.join(',')}` : ''}）`,
    );
  }
  return rows.slice(1).map((r, k) => {
    if (r.length !== header.length) throw new Error(`${file}:${k + 2}: 列の数が見出しと違います`);
    return Object.fromEntries(header.map((h, j) => [h, r[j]!]));
  });
}
