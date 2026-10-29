import { spawnSync } from 'node:child_process';
import { cpSync, existsSync, mkdtempSync, readdirSync, readFileSync, rmSync, appendFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
// @ts-expect-error JS モジュール（型宣言なし）
import { findEmails } from './check-emails.mjs';
import { readCsvRecords, readFixtureDir, readReferenceDir, repoRoot } from '@gaapp/shared/testing';
import { main } from './build-r8-fixtures';

const SAMPLE = path.join(repoRoot(), 'fixtures', 'r8-build-sample');
const at = '@';
const realMail = `taro${at}${'gmail'}.com`;

let work: string;
let out: string;
let source: string;
beforeEach(() => {
  work = mkdtempSync(path.join(tmpdir(), 'r8build-'));
  out = path.join(work, 'out');
  source = path.join(work, 'source');
  cpSync(path.join(SAMPLE, 'out'), out, { recursive: true });
  cpSync(path.join(SAMPLE, 'source'), source, { recursive: true });
});
afterEach(() => rmSync(work, { recursive: true, force: true }));

function run(env: Record<string, string | undefined> = { R8_SOURCE_DIR: source }, argv: string[] = []) {
  const err = vi.spyOn(console, 'error').mockImplementation(() => {});
  const log = vi.spyOn(console, 'log').mockImplementation(() => {});
  try {
    const code = main(['--out', out, ...argv], env as NodeJS.ProcessEnv);
    return { code, stderr: err.mock.calls.flat().join('\n'), stdout: log.mock.calls.flat().join('\n') };
  } finally {
    err.mockRestore();
    log.mockRestore();
  }
}
const read = (rel: string) => readFileSync(path.join(out, rel), 'utf8');
const rec = (rel: string) => {
  const rows = read(rel).trimEnd().split('\n');
  return rows.slice(1);
};

describe('build-r8-fixtures: R8_SOURCE_DIR がないとき', () => {
  it('何が要るかを示して、終了コード 2 で終わる（何も書かない）', () => {
    for (const env of [{}, { R8_SOURCE_DIR: '' }, { R8_SOURCE_DIR: path.join(work, 'ない') }]) {
      const r = run(env);
      expect(r.code).toBe(2);
      expect(r.stderr).toContain('R8_SOURCE_DIR');
      expect(r.stderr).toContain('forms/stall.csv');
      expect(r.stderr).toContain('anonymize.csv');
    }
    expect(existsSync(path.join(out, 'groups.csv'))).toBe(false);
  });
  it('コマンドとして実行しても同じ（pnpm build:r8-fixtures）', () => {
    const env = { ...process.env };
    delete env.R8_SOURCE_DIR;
    const r = spawnSync(process.execPath, ['--import', 'tsx', path.join(repoRoot(), 'scripts', 'build-r8-fixtures.ts')], {
      cwd: repoRoot(),
      env,
      encoding: 'utf8',
    });
    expect(r.status).toBe(2);
    expect(r.stderr).toContain('R8_SOURCE_DIR');
  });
});

describe('build-r8-fixtures: 匿名化した小さなサンプル', () => {
  it('生成物は fixtures の読み込みと同じ確かめを通る（手で書いたファイルと合わせて読める）', () => {
    const r = run();
    expect(r.code, r.stderr).toBe(0);
    const fx = readFixtureDir(out);
    expect(fx.groups).toHaveLength(11);
    const ref = readReferenceDir(out)!;
    expect(ref.allocations.length).toBeGreaterThan(0);
  });

  it('提出日時：フォームは最後の回答、代理入力は proxySubmittedAt、未提出は空。手で書いたファイルは変えない', () => {
    run();
    const fx = readFixtureDir(out);
    const at = (n: string) => fx.groups.find((g) => g.name === n)!.submittedAt;
    expect(at('模擬店甲')).toBe('2026-10-05T18:00:00+09:00');
    expect(at('企業ア')).toBe('2026-10-04T10:00:00+09:00'); // 企業フォーム（company_map）
    expect(at('企業イ')).toBe('2026-10-10T23:59:00+09:00');
    expect(at('設営')).toBe('2026-10-10T23:59:00+09:00');
    expect(at('未提出団体')).toBeNull();
    for (const f of ['rooms.csv', 'rules.json', 'meta.json', 'distance_overrides.csv', 'manual/groups.csv'])
      expect(read(f)).toBe(readFileSync(path.join(SAMPLE, 'out', f), 'utf8'));
  });

  it('申請：フォームの読み替え（学科の長机(3人掛)→長机(2人掛)の合算）と adjustments を当てる', () => {
    run();
    const rows = readCsvRecords(read('requests.csv'), ['group', 'desk', 'desk_ng', 'chair', 'chair_ng', 'caster_desk', 'blue_chair', 'long_desk_3', 'long_desk_2', 'lectern'], 'requests.csv');
    const by = (g: string) => rows.find((r) => r.group === g)!;
    expect(by('学科展示')).toMatchObject({ desk: '6', long_desk_2: '3', long_desk_3: '0' });
    expect(by('剣道部(非飲食)')).toMatchObject({ desk: '3', chair: '3' }); // 1+2, 2+1
    expect(by('設営')).toMatchObject({ desk: '5' });
    expect(by('企業ア')).toMatchObject({ long_desk_3: '4', long_desk_2: '2' }); // 企業は読み替えない
    expect(rows.some((r) => r.group === '未提出団体')).toBe(false);
  });

  it('reference：剣道部を2団体に分け、申請より多い分は最後の団体に付ける', () => {
    const r = run();
    const ref = readReferenceDir(out)!;
    const kendo = (g: string, item: string) =>
      ref.allocations.filter((a) => a.group === g && a.item === item).reduce((s, a) => s + a.count, 0);
    expect(kendo('剣道部(飲食)', 'desk')).toBe(3);
    expect(kendo('剣道部(非飲食)', 'desk')).toBe(5); // 申請 3 + 多い分 2
    expect(kendo('剣道部(飲食)', 'chair') + kendo('剣道部(非飲食)', 'chair')).toBe(7);
    expect(ref.allocations.some((a) => a.group === '剣道部')).toBe(false);
    // 1行の途中で分かれた行は2行になる
    expect(ref.allocations.filter((a) => a.source === '1-1' && a.item === 'desk' && a.group.startsWith('剣道部')).map((a) => a.count)).toEqual([3, 2]);
    expect(r.stdout).toContain('剣道部(非飲食) desk +2');
  });

  it('reference：requested_item（不可机→机、キャスター机に交換→机、企業の長机(2人掛)の一部→長机(3人掛)）', () => {
    run();
    const { allocations: a } = readReferenceDir(out)!;
    expect(a.find((x) => x.item === 'desk_ng')!.requestedItem).toBe('desk');
    expect(a.find((x) => x.item === 'caster_desk' && x.note !== null)).toMatchObject({ requestedItem: 'desk', note: 'キャスター机に交換' });
    expect(a.find((x) => x.item === 'caster_desk' && x.note === null)!.requestedItem).toBe('caster_desk');
    // 企業ア：長机(3人掛)の申請4、長机(3人掛)の行3 → 長机(2人掛)の行のうち1台が長机(3人掛)の申請
    const ld = a.filter((x) => x.group === '企業ア' && x.item === 'long_desk_2');
    expect(ld.map((x) => [x.requestedItem, x.count])).toEqual([['long_desk_3', 1], ['long_desk_2', 2]]);
    // 企業以外は長机(2人掛)のまま
    expect(a.find((x) => x.group === '学科展示' && x.item === 'long_desk_2')!.requestedItem).toBe('long_desk_2');
  });

  it('reference：計・余り・残す・予備（reference_skip）の行は入れず、匿名化した団体に対応する', () => {
    run();
    const { allocations: a } = readReferenceDir(out)!;
    expect(a.map((x) => x.group)).not.toContain('予備');
    expect(a.some((x) => x.source === '2-1' && x.item === 'desk')).toBe(false); // 余り・残すの行だけの運び元
    expect(a.find((x) => x.group === '研究室A')!.count).toBe(1);
    expect(a.every((x) => x.note === null || x.note === 'キャスター机に交換')).toBe(true);
  });

  it('group_totals：集計シートと振り分け表の行の合計が違う団体は載せない', () => {
    const r = run();
    const t = readReferenceDir(out)!.groupTotals.map((g) => g.group);
    expect(t).not.toContain('学科展示');
    expect(t).toContain('剣道部(飲食)');
    expect(t).toHaveLength(10);
    expect(r.stdout).toContain('比較から除いた団体');
    expect(r.stdout).toMatch(/除いた団体.*学科展示/);
  });

  it('在庫：場所は name・aliases で対応させ、rooms.csv の順に並べる', () => {
    run();
    expect(rec('stocks.csv').map((l) => l.split(',')[0])).toEqual(['1-1', '1-2', '2-1', '倉庫']);
  });

  it('出力のどこにもメールアドレスがない（元データには予約ドメインのメールが入っている）', () => {
    const src = readFileSync(path.join(source, 'forms', 'stall.csv'), 'utf8');
    expect(src).toContain(at);
    const r = run();
    expect(r.code).toBe(0);
    for (const rel of ['groups.csv', 'stocks.csv', 'requests.csv', 'consents.csv', 'reference/allocations.csv', 'reference/group_totals.csv'])
      expect(read(rel), rel).not.toContain(at);
    expect(r.stdout + r.stderr).not.toContain(at);
  });

  it('実在しうるドメインのメールがフォームのどの列にあっても、出力とログに出ない', () => {
    const f = path.join(source, 'forms', 'stall.csv');
    appendFileSync(f, `2026/10/05 21:00:00,${realMail},いいえ,,模擬店乙 ${realMail},1,1,0,連絡先 ${realMail}\n`);
    appendFileSync(f, `2026/10/05 21:30:00,${realMail},いいえ,,${realMail},1,1,0,\n`);
    const r = run({ R8_SOURCE_DIR: source }, ['--allow-rejected']);
    expect(r.code, r.stderr).toBe(0);
    for (const rel of ['groups.csv', 'requests.csv', 'reference/allocations.csv']) expect(read(rel)).not.toContain(at);
    expect(r.stdout + r.stderr).not.toContain(at);
    expect(r.stdout + r.stderr).not.toContain('gmail');
  });
});

describe('build-r8-fixtures: 失敗のしかた（元データの値を出さない）', () => {
  const secret = '秘密の個人名ABC';
  it('対応しない使用用途：名前を出さずに行番号だけを示して失敗する', () => {
    appendFileSync(path.join(source, 'allocation.csv'), `机(木),倉庫,${secret},1,\n`);
    const r = run();
    expect(r.code).toBe(1);
    expect(r.stderr).toContain('allocation.csv:');
    expect(r.stderr).not.toContain(secret);
    expect(existsSync(path.join(out, 'groups.csv'))).toBe(false);
  });
  it('対応しない団体名のフォーム回答：行番号と理由だけ', () => {
    appendFileSync(path.join(source, 'forms', 'department.csv'), `2026/10/06 12:00:00,x@example.test,${secret},1,0,0\n`);
    const r = run();
    expect(r.code).toBe(1);
    expect(r.stderr).toContain('forms/department.csv:4');
    expect(r.stderr).not.toContain(secret);
    expect(r.stderr).not.toContain(at);
  });
  it('許さない備考：文言を出さずに失敗する', () => {
    appendFileSync(path.join(source, 'allocation.csv'), `机(木),倉庫,設営,1,${secret}\n`);
    const r = run();
    expect(r.code).toBe(1);
    expect(r.stderr).not.toContain(secret);
  });
  it('場所が rooms.csv に合わない：失敗する', () => {
    appendFileSync(path.join(source, 'stock.csv'), '謎の場所,1,0,0,0,0,0\n');
    const r = run();
    expect(r.code).toBe(1);
    expect(r.stderr).toContain('stock.csv:6');
  });
  it('anonymize.csv がないと、個人名を含む名前は対応せず失敗する（名前は出さない）', () => {
    rmSync(path.join(source, 'anonymize.csv'));
    const r = run();
    expect(r.code).toBe(1);
    expect(r.stderr).not.toContain('研究室源');
  });
});

describe('fixtures とスクリプトの出力に個人情報がない', () => {
  const files = (dir: string): string[] =>
    readdirSync(dir, { withFileTypes: true }).flatMap((e) => (e.isDirectory() ? files(path.join(dir, e.name)) : [path.join(dir, e.name)]));
  it('fixtures/ の全ファイルに、予約ドメイン以外のメールがない。生成物の置き場（r8・synthetic・サンプルの out）には @ 自体がない', () => {
    const root = path.join(repoRoot(), 'fixtures');
    for (const f of files(root)) {
      const text = readFileSync(f, 'utf8');
      expect(findEmails(text), path.relative(root, f)).toEqual([]);
      if (/^(r8\/|synthetic\/|r8-build-sample\/out\/)/.test(path.relative(root, f).split(path.sep).join('/'))) expect(text, path.relative(root, f)).not.toContain(at);
    }
  });
  it('supabase/seed.sql があれば、予約ドメイン以外のメールがない', () => {
    const p = path.join(repoRoot(), 'supabase', 'seed.sql');
    if (existsSync(p)) expect(findEmails(readFileSync(p, 'utf8'))).toEqual([]);
  });
  it('fixtures/r8 があれば、fixtures の読み込み（strictObject）を通る', () => {
    const dir = path.join(repoRoot(), 'fixtures', 'r8');
    if (existsSync(path.join(dir, 'meta.json'))) expect(readFixtureDir(dir).meta.kind).toBe('r8');
    else expect(existsSync(dir)).toBe(false); // R8 の元データが届くまでは作らない
  });
});

