import { readFileSync } from 'node:fs';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import { INITIAL_ITEMS, type GroupCategory } from '@gaapp/shared';
import { fixtureIds, fixtureItems, repoRoot } from '@gaapp/shared/testing';
import {
  containsEmail,
  parseFormCsv,
  stripEmails,
  resolveResponses,
  type FormKind,
  type ImportGroup,
} from './index';
import { parseCsvLoose } from './csv';
import { parseCountCell, parseTimestamp } from './parse';

const SAMPLES = path.join(repoRoot(), 'fixtures', 'importer-samples');
const sample = (kind: FormKind) => readFileSync(path.join(SAMPLES, `${kind}.csv`), 'utf8');
const itemDefs = INITIAL_ITEMS.map((i) => ({ code: i.code, aliases: i.aliases }));
const items = fixtureItems();
const itemId = (code: string) => fixtureIds.item(code);

const group = (name: string, category: GroupCategory, aliases: string[] = []): ImportGroup => ({
  id: fixtureIds.group('test', name),
  name,
  aliases,
  category,
});
const gid = (name: string) => fixtureIds.group('test', name);

// メールのテストには予約済みのドメイン（.example）を使う。取り込みはドメインによらず、すべてのアドレスを捨てる
const realMail = 'taro@mail.example';
const schoolMail = 'x.y@school.example';

describe('parseCsvLoose', () => {
  it('BOM・CRLF・引用符内の改行と引用符を読む', () => {
    const rows = parseCsvLoose('﻿a,b\r\n"x\r\ny","q""r"\r\n');
    expect(rows).toEqual([
      ['a', 'b'],
      ['x\r\ny', 'q"r'],
    ]);
  });
  it('引用符が閉じていなければ失敗する', () => {
    expect(() => parseCsvLoose('a,"b\n')).toThrow();
  });
});

describe('parseTimestamp / parseCountCell', () => {
  it('Asia/Tokyo として読み、+09:00 の ISO にする', () => {
    expect(parseTimestamp('2026/10/05 18:01:02')).toBe('2026-10-05T18:01:02+09:00');
    expect(parseTimestamp('2026-10-05 21:00:00')).toBe('2026-10-05T21:00:00+09:00');
    expect(parseTimestamp('2026/10/05 午後 10:00:00')).toBe('2026-10-05T22:00:00+09:00');
    expect(parseTimestamp('2026/10/05 午前 12:05:00')).toBe('2026-10-05T00:05:00+09:00');
    expect(parseTimestamp('2026-10-05T09:00:00Z')).toBe('2026-10-05T18:00:00+09:00');
    expect(parseTimestamp('2026/10/05')).toBe('2026-10-05T00:00:00+09:00');
  });
  it('読めないものは null', () => {
    expect(parseTimestamp('')).toBeNull();
    expect(parseTimestamp('2026/02/30 10:00:00')).toBeNull();
    expect(parseTimestamp('2026/10/05 25:00:00')).toBeNull();
    expect(parseTimestamp('昨日')).toBeNull();
  });
  it('数：空は 0、全角と単位を許し、負数・小数・上限超過は null', () => {
    expect(parseCountCell('')).toBe(0);
    expect(parseCountCell('４')).toBe(4);
    expect(parseCountCell('3台')).toBe(3);
    expect(parseCountCell('-1')).toBeNull();
    expect(parseCountCell('1.5')).toBeNull();
    expect(parseCountCell('10001')).toBeNull();
  });
});

describe('parseFormCsv: 模擬店フォーム', () => {
  const parsed = parseFormCsv('stall', sample('stall'), itemDefs);
  it('団体名は飲食・非飲食の2列のうち空でない方を使う', () => {
    const names = parsed.responses.map((r) => [r.rowNumber, r.groupName]);
    expect(names).toEqual([
      [2, '模擬店甲'],
      [3, '模擬店乙'],
      [4, '模擬店甲'],
      [9, null], // 団体名の列にメールだけ
      [8, '存在しない団体'],
    ].sort((a, b) => (a[0] as number) - (b[0] as number)));
  });
  it('列がずれている行（見出しのない列に値がある行・数の列にメール）と不正な数、空行は取り込まず、理由だけを返す', () => {
    // タイムスタンプと団体名が読めれば添える（同じ団体の新しい回答が読めないことを resolveResponses が見つけるため）
    expect(parsed.rejected).toEqual([
      { rowNumber: 5, reason: 'misaligned', submittedAt: '2026-10-06T10:15:00+09:00', groupName: '模擬店丙' },
      { rowNumber: 6, reason: 'invalid_number', submittedAt: '2026-10-06T10:20:00+09:00', groupName: '模擬店丁' },
      { rowNumber: 7, reason: 'misaligned', submittedAt: '2026-10-06T10:30:00+09:00', groupName: '模擬店戊' },
      { rowNumber: 10, reason: 'empty', submittedAt: null, groupName: null },
    ]);
  });
  it('全角の数字を読み、空の数は 0。品目は aliases で対応する', () => {
    const r = parsed.responses.find((x) => x.rowNumber === 3)!;
    expect(r.counts).toMatchObject({ desk: 2, chair: 4, caster_desk: 1, long_desk_2: 0, long_desk_3: 0 });
    expect(r.submittedAt).toBe('2026-10-05T19:30:00+09:00');
  });
  it('対応表にない列（氏名・学籍番号・電話・メール・質問）は捨て、見出しだけを返す', () => {
    expect(parsed.ignoredColumns).toEqual([
      'メールアドレス',
      '代表者氏名',
      '学籍番号',
      '電話番号',
      '飲食模擬店を運営しますか？',
      '(列17)',
    ]);
    for (const r of parsed.responses) expect(Object.keys(r).sort()).toEqual(['counts', 'groupName', 'note', 'rowNumber', 'submittedAt']);
  });
  it('どの列にメールがあっても、結果の全体にメールのパターンが出ない', () => {
    expect(JSON.stringify(parsed)).not.toContain('@');
    // 備考の中のメールは取り除かれ、そのほかの文は残る
    const r = parsed.responses.find((x) => x.rowNumber === 4)!;
    expect(r.note).toContain('人数が増えました');
    expect(r.note).not.toContain('@');
  });
});

describe('parseFormCsv: 途中で切れた行', () => {
  const header = 'タイムスタンプ,団体名,机(木),椅子(木),備考';
  it('読む列の位置まで届かない行は、足りない列を 0 として取り込まず misaligned にする', () => {
    const csv = [
      header,
      '2026/10/01 10:00:00,団体1,2,3,メモ', // 全部ある
      '2026/10/01 10:01:00,団体2,2,3', // 備考の列まで届かない
      '2026/10/01 10:02:00,団体3,2', // 椅子の列まで届かない
      '2026/10/01 10:03:00', // 団体名の列から届かない
      '2026/10/01 10:04:00,団体5,2,3,', // 空の備考まである
      '',
    ].join('\n');
    const parsed = parseFormCsv('department', csv, itemDefs);
    expect(parsed.responses.map((r) => r.rowNumber)).toEqual([2, 6]);
    expect(parsed.rejected).toEqual([
      { rowNumber: 3, reason: 'misaligned', submittedAt: '2026-10-01T10:01:00+09:00', groupName: '団体2' },
      { rowNumber: 4, reason: 'misaligned', submittedAt: '2026-10-01T10:02:00+09:00', groupName: '団体3' },
      { rowNumber: 5, reason: 'misaligned', submittedAt: '2026-10-01T10:03:00+09:00', groupName: null },
    ]);
  });
  it('対応表にない列（右端）が省かれていても、読む列に届いていれば取り込む', () => {
    const csv = 'タイムスタンプ,団体名,机(木),備考,電話番号\n2026/10/01 10:00:00,団体1,2,\n';
    const parsed = parseFormCsv('department', csv, itemDefs);
    expect(parsed.rejected).toEqual([]);
    expect(parsed.responses).toHaveLength(1);
  });
});

describe('parseFormCsv: メールの扱い', () => {
  const header = 'タイムスタンプ,メール,団体名,机(木),備考';
  it('どのドメインのメールも、団体名・備考・数のどこにあっても出さない', () => {
    const csv = [
      header,
      `2026/10/01 10:00:00,${realMail},団体1 ${schoolMail},2,連絡先 ${realMail} です`,
      `2026/10/01 10:01:00,${schoolMail},団体2,${realMail},`,
      `2026/10/01 10:02:00,x,${realMail},1,`,
      '',
    ].join('\r\n');
    const parsed = parseFormCsv('department', csv, itemDefs);
    const dump = JSON.stringify(parsed);
    expect(dump).not.toContain('@');
    expect(parsed.responses.map((r) => [r.groupName, r.note])).toEqual([
      ['団体1', '連絡先  です'],
      [null, null],
    ]);
    expect(parsed.rejected).toEqual([{ rowNumber: 3, reason: 'misaligned', submittedAt: '2026-10-01T10:01:00+09:00', groupName: '団体2' }]);
    expect(containsEmail(realMail)).toBe(true);
    expect(containsEmail('全角＠でも')).toBe(false);
    expect(containsEmail('a＠mail.example')).toBe(true);
  });
  it('見出しがメールなら、見出しも返さない', () => {
    const csv = `タイムスタンプ,${realMail},団体名,机(木)\n2026/10/01 10:00:00,x,団体,1\n`;
    const parsed = parseFormCsv('department', csv, itemDefs);
    expect(parsed.ignoredColumns).toEqual(['(列2)']);
    expect(JSON.stringify(parsed)).not.toContain('@');
  });
  it('必要な列がなければ、中身を含まないメッセージで失敗する', () => {
    expect(() => parseFormCsv('stall', `団体名,机(木)\n${realMail},1\n`, itemDefs)).toThrow(/タイムスタンプ/);
    expect(() => parseFormCsv('stall', 'タイムスタンプ,机(木)\n2026/10/01,1\n', itemDefs)).toThrow(/団体名/);
    expect(() => parseFormCsv('stall', 'タイムスタンプ,団体名\n2026/10/01,x\n', itemDefs)).toThrow(/品目/);
    try {
      parseFormCsv('stall', `団体名,机(木)\n${realMail},1\n`, itemDefs);
    } catch (e) {
      expect(String((e as Error).message)).not.toContain('@');
    }
  });
});

describe('メールのパターン：書き方の揺れと処理時間', () => {
  const strip = (s: string) => stripEmails(s);
  it('@ の前後に空白がある書き方も見つけて取り除く', () => {
    for (const s of ['taro @ mail.example', 'taro@ mail.example', 'taro @mail.example', 'taro\u3000＠\u3000mail.example']) {
      expect(containsEmail(s), s).toBe(true);
      expect(strip(`連絡先 ${s} です`).text, s).toBe('連絡先  です');
    }
  });
  it('ドメインの区切りが「。」「．」でも見つけて取り除く（それ以外の文は変えない）', () => {
    for (const s of ['taro@mail。example', 'taro@mail．example', 'taro@mail｡example', 'x.y@mail。school。example']) {
      expect(containsEmail(s), s).toBe(true);
      expect(strip(`連絡先 ${s} 以上`).text, s).toBe('連絡先  以上');
    }
    // メールを含まない文は、「。」があっても書き換えない
    expect(strip('ありがとう。よろしく。')).toEqual({ text: 'ありがとう。よろしく。', stripped: false });
  });
  it('メールのない文は見つけない', () => {
    for (const s of ['机は2台', '@だけ', 'a @', '@ mail.example', 'a@b']) expect(containsEmail(s), s).toBe(false);
  });
  it('5万字のセルでも十分速い（@ のない長い列・@ だらけ・空白だらけ・ドット列）', () => {
    const N = 50_000;
    const cells = [
      'a'.repeat(N),
      'ab.'.repeat(N / 3),
      ' '.repeat(N),
      `${'a'.repeat(N)}@`,
      `@${'a'.repeat(N)}`,
      `${'a'.repeat(N)}@${'b'.repeat(N)}`,
      'a@'.repeat(N / 2),
      'a @ '.repeat(N / 4),
      `x@${'b'.repeat(62)}`.repeat(N / 64),
      `x@${'a.'.repeat(N / 2)}`,
      '長'.repeat(N),
    ];
    for (const c of cells) {
      const t0 = performance.now();
      stripEmails(c);
      containsEmail(c);
      expect(performance.now() - t0, `${c.slice(0, 8)}…`).toBeLessThan(100);
    }
  });
  it('local 部が長くても、全体を取り除く（一部を残さない）', () => {
    expect(strip(`${'a'.repeat(100)}@mail.example`)).toEqual({ text: '', stripped: true });
    // 2 つのアドレスがつながっていても、全部取り除く
    expect(strip('a@b.example@c.example')).toEqual({ text: '', stripped: true });
  });
  it('フォームの CSV に長い備考があっても、取り込みが速い', () => {
    const csv = `タイムスタンプ,団体名,机(木),備考\n2026/10/01 10:00:00,団体,1,${'あ'.repeat(50_000)}\n`;
    const t0 = performance.now();
    const parsed = parseFormCsv('department', csv, itemDefs);
    expect(performance.now() - t0).toBeLessThan(500);
    expect(parsed.responses).toHaveLength(1);
  });
});

describe('resolveResponses: 模擬店・部門', () => {
  const groups = [
    group('模擬店甲', 'stall'),
    group('模擬店乙', 'stall', ['乙店']),
    group('模擬店丙', 'stall'),
  ];
  const parsed = parseFormCsv('stall', sample('stall'), itemDefs);
  const res = resolveResponses(parsed, groups, items, {});

  it('同じ団体の回答はタイムスタンプが一番新しいものを使い、古い行を返す', () => {
    expect(res.superseded).toEqual([{ groupId: gid('模擬店甲'), keptRow: 4, droppedRows: [2] }]);
    expect(res.submissions).toEqual([
      { groupId: gid('模擬店甲'), submittedAt: '2026-10-06T09:00:00+09:00', note: expect.stringContaining('人数が増えました') },
      { groupId: gid('模擬店乙'), submittedAt: '2026-10-05T19:30:00+09:00', note: null },
    ]);
    const kou = res.requests.filter((r) => r.groupId === gid('模擬店甲'));
    expect(kou).toEqual([
      { groupId: gid('模擬店甲'), itemId: itemId('desk'), count: 6 },
      { groupId: gid('模擬店甲'), itemId: itemId('chair'), count: 10 },
      { groupId: gid('模擬店甲'), itemId: itemId('blue_chair'), count: 2 },
      { groupId: gid('模擬店甲'), itemId: itemId('long_desk_2'), count: 1 },
    ]);
  });
  it('団体に合わない行（名前なし・未登録）は unmatched に返す。別名で対応する', () => {
    expect(res.unmatched).toEqual([
      { rowNumber: 8, groupName: '存在しない団体' },
      { rowNumber: 9, groupName: null },
    ]);
    const viaAlias = resolveResponses(
      parseFormCsv('stall', 'タイムスタンプ,団体名,机(木)\n2026/10/01 10:00:00, 乙店 ,2\n', itemDefs),
      groups,
      items,
    );
    expect(viaAlias.requests).toEqual([{ groupId: gid('模擬店乙'), itemId: itemId('desk'), count: 2 }]);
  });
  it('2つの団体に当たる表記は対応させない', () => {
    const dup = [group('A', 'stall', ['共通']), group('B', 'stall', ['共通'])];
    const r = resolveResponses(
      parseFormCsv('stall', 'タイムスタンプ,団体名,机(木)\n2026/10/01 10:00:00,共通,2\n', itemDefs),
      dup,
      items,
    );
    expect(r.unmatched).toHaveLength(1);
    expect(r.requests).toEqual([]);
  });
  it('部門：長机(三席用)は長机(二席用)に読み替え、両方を申請した回答は1行に合算する', () => {
    const dep = [group('学科展示', 'department'), group('同好会ア', 'department'), group('同好会イ', 'department')];
    const p = parseFormCsv('department', sample('department'), itemDefs);
    expect(p.rejected).toEqual([]);
    expect(p.responses.map((r) => r.submittedAt)).toEqual([
      '2026-10-05T20:00:00+09:00',
      '2026-10-05T21:00:00+09:00',
      '2026-10-05T22:00:00+09:00',
    ]);
    const r = resolveResponses(p, dep, items);
    const ld2 = r.requests.filter((x) => x.itemId === itemId('long_desk_2'));
    expect(ld2).toEqual([
      { groupId: gid('学科展示'), itemId: itemId('long_desk_2'), count: 3 },
      { groupId: gid('同好会イ'), itemId: itemId('long_desk_2'), count: 3 },
    ]);
    expect(r.requests.some((x) => x.itemId === itemId('long_desk_3'))).toBe(false);
    // (団体, 品目) は一意
    const keys = r.requests.map((x) => `${x.groupId}|${x.itemId}`);
    expect(new Set(keys).size).toBe(keys.length);
  });
});

describe('resolveResponses: 同じ団体の新しい回答が取り込まない行になったとき', () => {
  const header = 'タイムスタンプ,団体名,机(木),椅子(木),備考';
  const groups = [group('団体1', 'department'), group('団体2', 'department'), group('団体3', 'department', ['別名3']), group('重複', 'department'), group('重複 ', 'department')];
  const csv = [
    header,
    '2026/10/01 10:00:00,団体1,2,3,古い', // 2：団体1 の古い回答
    '2026/10/01 11:00:00,団体1,abc,3,', // 3：団体1 の新しい回答（数が読めない）
    '2026/10/01 09:00:00,団体1,1,1,,ずれ', // 4：団体1 のもっと古い取り込まない行（関係ない）
    '2026/10/01 10:00:00,団体2,5,5,', // 5：団体2
    '2026/10/01 09:00:00,団体2,x,1,', // 6：団体2 の古い取り込まない行（関係ない）
    'いつか,団体2,1,1,', // 7：日時が読めない（団体2 に当てない）
    '2026/10/01 10:00:00,別名3,1,1,', // 8：団体3
    '2026/10/01 10:00:00,別名3,1,1,,ずれ', // 9：団体3 の同じ時刻の後の行（使う回答より新しいとみなす）
    '',
  ].join('\n');
  const parsed = parseFormCsv('department', csv, itemDefs);
  const res = resolveResponses(parsed, groups, items, {});

  it('使う回答より新しい取り込まない行があれば、その団体は requests・submissions に入れず newerRejected で返す', () => {
    expect(parsed.rejected.map((r) => [r.rowNumber, r.reason])).toEqual([
      [3, 'invalid_number'],
      [4, 'misaligned'],
      [6, 'invalid_number'],
      [7, 'invalid_timestamp'],
      [9, 'misaligned'],
    ]);
    expect(res.submissions.map((s) => s.groupId)).toEqual([gid('団体2')]);
    expect(new Set(res.requests.map((r) => r.groupId))).toEqual(new Set([gid('団体2')]));
    expect(res.newerRejected).toEqual([
      {
        groupId: gid('団体1'),
        keptRow: 2,
        droppedRows: [],
        rejectedRows: [{ rowNumber: 3, reason: 'invalid_number', submittedAt: '2026-10-01T11:00:00+09:00' }],
        submission: { groupId: gid('団体1'), submittedAt: '2026-10-01T10:00:00+09:00', note: '古い' },
        requests: [
          { groupId: gid('団体1'), itemId: itemId('desk'), count: 2 },
          { groupId: gid('団体1'), itemId: itemId('chair'), count: 3 },
        ],
      },
      {
        groupId: gid('団体3'),
        keptRow: 8,
        droppedRows: [],
        rejectedRows: [{ rowNumber: 9, reason: 'misaligned', submittedAt: '2026-10-01T10:00:00+09:00' }],
        submission: { groupId: gid('団体3'), submittedAt: '2026-10-01T10:00:00+09:00', note: null },
        requests: [
          { groupId: gid('団体3'), itemId: itemId('desk'), count: 1 },
          { groupId: gid('団体3'), itemId: itemId('chair'), count: 1 },
        ],
      },
    ]);
    expect(res.superseded).toEqual([]);
  });

  it('新しい取り込まない行のある団体の古い回答は、superseded ではなく newerRejected の droppedRows に出す', () => {
    const csv2 = [header, '2026/10/01 09:00:00,団体1,1,1,', '2026/10/01 10:00:00,団体1,2,2,', '2026/10/01 11:00:00,団体1,2,2,,ずれ', ''].join('\n');
    const r = resolveResponses(parseFormCsv('department', csv2, itemDefs), groups, items, {});
    expect(r.superseded).toEqual([]);
    expect(r.newerRejected.map((x) => [x.groupId, x.keptRow, x.droppedRows, x.rejectedRows.map((y) => y.rowNumber)])).toEqual([
      [gid('団体1'), 3, [2], [4]],
    ]);
  });

  it('団体名が2つの団体に当たる・どの団体にも当たらない取り込まない行は、どの団体も止めない', () => {
    const csv3 = [header, '2026/10/01 09:00:00,重複,1,1,', '2026/10/01 10:00:00,重複,x,1,', '2026/10/01 10:00:00,未登録,x,1,', ''].join('\n');
    const r = resolveResponses(parseFormCsv('department', csv3, itemDefs), groups, items, { 2: gid('重複') });
    expect(r.newerRejected).toEqual([]);
    expect(r.submissions.map((s) => s.groupId)).toEqual([gid('重複')]);
  });

  it('使う回答がない団体（回答が全部取り込まない行）は、今までどおり取り込まない行に出すだけ', () => {
    const csv4 = [header, '2026/10/01 10:00:00,団体1,x,1,', ''].join('\n');
    const r = resolveResponses(parseFormCsv('department', csv4, itemDefs), groups, items, {});
    expect(r.newerRejected).toEqual([]);
    expect(r.submissions).toEqual([]);
  });
});

describe('resolveResponses: 企業フォーム', () => {
  const p = parseFormCsv('company', sample('company'), itemDefs);
  const groups = [group('企業ア', 'company'), group('企業イ', 'company'), group('企業ウ', 'company')];
  it('団体名の列は読まず（「オプション 1」）、groupName は null', () => {
    expect(p.responses.map((r) => r.groupName)).toEqual([null, null, null]);
    expect(p.ignoredColumns).toContain('団体名');
  });
  it('企業名のない回答は、手で団体を選ぶまで unmatched。選んだら企業は長机(三席用)のまま', () => {
    const none = resolveResponses(p, groups, items, {});
    expect(none.unmatched.map((u) => u.rowNumber)).toEqual([2, 3, 4]);
    expect(none.requests).toEqual([]);

    const r = resolveResponses(p, groups, items, { 2: gid('企業ア'), 3: gid('企業イ'), 4: gid('企業ウ') });
    expect(r.unmatched).toEqual([]);
    expect(r.requests.filter((x) => x.groupId === gid('企業ア'))).toEqual([
      { groupId: gid('企業ア'), itemId: itemId('long_desk_3'), count: 4 },
      { groupId: gid('企業ア'), itemId: itemId('long_desk_2'), count: 2 },
    ]);
    expect(r.submissions.find((s) => s.groupId === gid('企業イ'))?.note).toBe('電源が必要 ()');
  });
  it('存在しない団体 id の手動対応は unmatched にする', () => {
    const r = resolveResponses(p, groups, items, { 2: 'not-a-group' });
    expect(r.unmatched.map((u) => u.rowNumber)).toContain(2);
  });
  it('同じ企業を2行に割り当てると新しい方を使う', () => {
    const r = resolveResponses(p, groups, items, { 2: gid('企業ア'), 3: gid('企業ア') });
    expect(r.superseded).toEqual([{ groupId: gid('企業ア'), keptRow: 3, droppedRows: [2] }]);
  });
});

describe('サンプルの CSV にはメールアドレスの実在ドメインがない', () => {
  it('予約ドメイン以外のメールを含まない', async () => {
    const { findEmails } = (await import('../../../scripts/check-emails.mjs' as string)) as { findEmails: (t: string) => string[] };
    for (const k of ['stall', 'department', 'company'] as const) expect(findEmails(sample(k))).toEqual([]);
  });
});
