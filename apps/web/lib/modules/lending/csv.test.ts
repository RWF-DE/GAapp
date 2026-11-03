// テント等の貸し出しの CSV（T21。notes/T21.md「画面の約束」10）：ファイル名、見出し・行（団体の並び。申請・割り当て・記録のある団体だけ）、
// 空欄と 0、BOM・CRLF・引用、式として読まれる先頭の文字（= + - @・タブ・CR・LF）、メモのメールアドレスの置き換え。
import { describe, expect, it } from 'vitest';
import { staticImportGraph } from '@/lib/testing/import-graph';
import { buildLendingCsv, csvCell, EMAIL_REDACTED, lendingCsvFileName, redactEmails, type LendingCsvInput } from './csv';

const TENT = { id: 'i-tent', name: 'テント', sort_order: 1 };
const WEIGHT = { id: 'i-weight', name: '重し', sort_order: 2 };

const base: LendingCsvInput = {
  yearLabel: 'R8',
  items: [WEIGHT, TENT],
  groups: [
    { id: 'g-company', name: '企業A', category: 'company', sort_order: 0, location: null },
    { id: 'g-stall', name: '模擬店01', category: 'stall', sort_order: 1, location: { name: '1-1' } },
    { id: 'g-none', name: '何もない団体', category: 'stall', sort_order: 2, location: null },
    { id: 'g-dept', name: '部門01', category: 'department', sort_order: 0, location: { name: '体育館' } },
  ],
  requests: [
    { group_id: 'g-stall', lending_item_id: TENT.id, count: 2 },
    { group_id: 'g-dept', lending_item_id: TENT.id, count: 0 },
  ],
  assignments: [
    { group_id: 'g-stall', lending_item_id: TENT.id, count: 1 },
    { group_id: 'g-company', lending_item_id: WEIGHT.id, count: 4 },
  ],
  records: [{ group_id: 'g-stall', lending_item_id: TENT.id, lent_count: 1, returned_count: 1, damaged_count: 1, note: '骨が曲がった' }],
};

const lines = (text: string) => text.replace(/^\uFEFF/, '').split('\r\n');

describe('T21 CSV', () => {
  it('ファイル名は `{年度名}_テント等の貸し出し.csv`。BOM つき・CRLF・最後も改行', () => {
    expect(lendingCsvFileName('R8')).toBe('R8_テント等の貸し出し.csv');
    const { fileName, text } = buildLendingCsv(base);
    expect(fileName).toBe('R8_テント等の貸し出し.csv');
    expect(text.startsWith('\uFEFF')).toBe(true);
    expect(text.endsWith('\r\n')).toBe(true);
    expect(text.replace(/\r\n/g, '')).not.toContain('\n');
  });

  it('見出しは区分・団体・使用場所、備品ごと（備品の並び）に申請・割り当て・渡した数・返った数・破損、最後にメモ', () => {
    const [header] = lines(buildLendingCsv(base).text);
    expect(header).toBe(
      '区分,団体,使用場所,テントの申請,テントの割り当て,テントの渡した数,テントの返った数,テントの破損,重しの申請,重しの割り当て,重しの渡した数,重しの返った数,重しの破損,メモ',
    );
  });

  it('行は申請・割り当て・記録のどれかがある団体（団体の並び。行があれば数が 0 でも）。行のない数は空欄、使用場所がなければ「校内に分散」', () => {
    const [, ...rows] = lines(buildLendingCsv(base).text);
    expect(rows.filter((r) => r !== '')).toEqual([
      '模擬店,模擬店01,1-1,2,1,1,1,1,,,,,,テント：骨が曲がった',
      '部門,部門01,体育館,0,,,,,,,,,,',
      '企業,企業A,校内に分散,,,,,,,4,,,,',
    ]);
  });

  it('メモは「{備品}：{メモ}」を「／」でつなぎ（備品の並び）、メールアドレスは「(メールアドレス削除)」に置き換える', () => {
    const { text } = buildLendingCsv({
      ...base,
      records: [
        { group_id: 'g-stall', lending_item_id: WEIGHT.id, lent_count: 1, returned_count: 0, damaged_count: 0, note: '連絡は x.y@example.test まで' },
        { group_id: 'g-stall', lending_item_id: TENT.id, lent_count: 1, returned_count: 1, damaged_count: 1, note: '  破れ ' },
      ],
    });
    const row = lines(text)[1]!;
    expect(row.endsWith(`テント：破れ／重し：連絡は ${EMAIL_REDACTED} まで`)).toBe(true);
    expect(text).not.toContain('example.test');
  });

  it('式として読まれる先頭の文字（= + - @・タブ・CR・LF）に「\'」を付け、「,」「"」改行を含む欄は「"」で囲む（「"」は2つ）', () => {
    expect(csvCell('=SUM(A1)')).toBe("'=SUM(A1)");
    expect(csvCell('+1')).toBe("'+1");
    expect(csvCell('-1')).toBe("'-1");
    expect(csvCell('@cmd')).toBe("'@cmd");
    expect(csvCell('\tx')).toBe("'\tx");
    expect(csvCell('\rx')).toBe(`"'\rx"`);
    expect(csvCell('\nx')).toBe(`"'\nx"`);
    expect(csvCell('a,b')).toBe('"a,b"');
    expect(csvCell('say "hi"')).toBe('"say ""hi"""');
    expect(csvCell('=a,"b"')).toBe(`"'=a,""b"""`);
    expect(csvCell(0)).toBe('0');
    expect(csvCell(null)).toBe('');
    expect(csvCell('ふつう')).toBe('ふつう');
    // 団体名・メモも同じく守る
    const { text } = buildLendingCsv({
      ...base,
      groups: [{ id: 'g-stall', name: '=HYPERLINK("x")', category: 'stall', sort_order: 1, location: { name: '1-1' } }],
      records: [{ group_id: 'g-stall', lending_item_id: TENT.id, lent_count: 1, returned_count: 1, damaged_count: 0, note: '@attack' }],
    });
    expect(lines(text)[1]).toBe(`模擬店,"'=HYPERLINK(""x"")",1-1,2,1,1,1,0,,,,,,テント：@attack`);
  });

  it('メールアドレスの見つけ方は importer と同じ（全角の＠・前後の空白・「。」の区切りも）。なければそのまま', () => {
    expect(redactEmails('a@example.test')).toBe(EMAIL_REDACTED);
    expect(redactEmails('連絡：ａｂｃ＠ｅｘａｍｐｌｅ．ｔｅｓｔ です')).toBe(`連絡：${EMAIL_REDACTED} です`);
    expect(redactEmails('x @ example。test')).toBe(EMAIL_REDACTED);
    // メールアドレスの外の全角の文字は変えない（2つ以上も置き換える）
    expect(redactEmails('（担当）a@example.test・ｂ＠example.test：済')).toBe(`（担当）${EMAIL_REDACTED}・${EMAIL_REDACTED}：済`);
    expect(redactEmails('メモ @ だけ')).toBe('メモ @ だけ');
    expect(redactEmails('メールなし')).toBe('メールなし');
  });

  it('ExcelJS を含む packages/exporter と、画面の部品・lib/data を読まない（/lending の CSV 出力が動的 import で読む）', () => {
    const g = staticImportGraph('lib/modules/lending/csv.ts');
    expect(g.packages.filter((p) => p.startsWith('@gaapp/exporter') || p === 'exceljs')).toEqual([]);
    expect(g.files.filter((f) => f.startsWith('components/') || f.startsWith('lib/data/'))).toEqual([]);
  });
});
