import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterAll, describe, expect, it } from 'vitest';
import { ITEM_CODES } from '../constants';
import {
  DNS_NAMESPACE,
  FixtureBuilder,
  RULES,
  formatFixtureFiles,
  generateSynthetic,
  makeInfeasibleS05,
  parseCsv,
  formatCsv,
  readFixtureDir,
  repoRoot,
  S05_ROOMS,
  toYearData,
  uuidv5,
  writeFixtureDir,
} from './index';

const tmp = mkdtempSync(path.join(tmpdir(), 'gaapp-fixtures-'));
afterAll(() => rmSync(tmp, { recursive: true, force: true }));

describe('uuidv5', () => {
  it('RFC 4122 の例（DNS 名前空間と www.example.com）', () => {
    expect(uuidv5('www.example.com', DNS_NAMESPACE)).toBe('2ed6657d-e927-568b-95e1-2665a8aea6a2');
  });
});

describe('repoRoot', () => {
  it('pnpm-workspace.yaml のあるディレクトリ', () => {
    expect(readFileSync(path.join(repoRoot(), 'pnpm-workspace.yaml'), 'utf8')).toContain('packages/*');
  });
});

describe('CSV', () => {
  it('引用符・カンマ・改行を往復できる', () => {
    const rows = [['a,b', 'x"y', 'line1\nline2', '']];
    expect(parseCsv(formatCsv(['h1', 'h2', 'h3', 'h4'], rows)).slice(1)).toEqual(rows);
  });
  it('CR と BOM は止める', () => {
    expect(() => parseCsv('a\r\n')).toThrow();
    expect(() => parseCsv('﻿a\n')).toThrow();
  });
});

describe('readFixtureDir・writeFixtureDir', () => {
  const fx = new FixtureBuilder('rt')
    .room('X', { building: 'A棟', floor: 2, aliases: ['えっくす'] })
    .room('外1', { kind: 'outdoor' })
    .group('模擬店,"引用"', 'stall', 'X', { aliases: ['別名1', '別名2'] })
    .group('未提出', 'department', null, { submittedAt: null })
    .stock('X', { desk: 3 })
    .request('模擬店,"引用"', { desk: 2 })
    .consent('模擬店,"引用"', 'desk', 'caster_desk', 'asked', 2)
    .override('B棟', 'A棟', 4)
    .rule(RULES.S01(), { ...RULES.fixed('S06', '未提出', 'desk', 5), enabled: false })
    .fixture();

  it('書いて読むと同じ', () => {
    const dir = path.join(tmp, 'rt');
    writeFixtureDir(dir, fx);
    expect(readFixtureDir(dir)).toEqual(fx);
  });

  it('知らない列があれば失敗する（個人情報の列を足すのを止める）', () => {
    const dir = path.join(tmp, 'extra');
    writeFixtureDir(dir, fx);
    const p = path.join(dir, 'groups.csv');
    const lines = readFileSync(p, 'utf8').trimEnd().split('\n');
    writeFileSync(p, lines.map((l, k) => `${l},${k === 0 ? 'email' : 'x'}`).join('\n') + '\n');
    expect(() => readFixtureDir(dir)).toThrow(/知らない列：email/);
  });

  it('同じ場所の在庫の行が2つあれば失敗する', () => {
    const files = formatFixtureFiles(fx);
    const dir = path.join(tmp, 'dup');
    writeFixtureDir(dir, fx);
    const stocks = files['stocks.csv']!;
    writeFileSync(path.join(dir, 'stocks.csv'), stocks + stocks.split('\n')[1] + '\n');
    expect(() => readFixtureDir(dir)).toThrow(/重複/);
  });

  it('rules.json の enabled: false は YearData に入れない', () => {
    const data = toYearData(fx);
    expect(data.rules.map((r) => r.code)).toEqual(['S01']);
  });

  it('数えた場所の在庫は全品目の行（0 も）、申請は 0 の品目を行にしない', () => {
    const data = toYearData(fx);
    expect(data.stocks).toHaveLength(ITEM_CODES.length);
    expect(data.requests).toHaveLength(1);
  });

  it('名前のない参照は失敗する', () => {
    expect(() => toYearData({ ...fx, requests: [{ group: 'ない団体', counts: fx.requests[0]!.counts }] })).toThrow(/ない団体/);
  });
});

describe('合成データ（設計 3.6）', () => {
  const fx = generateSynthetic();
  const sum = (rows: { counts: Record<string, number> }[], c: string) => rows.reduce((a, r) => a + r.counts[c]!, 0);

  it('在庫の合計は 05 の R8 の在庫（使用不可の第一セミナーを含む）', () => {
    expect(Object.fromEntries(ITEM_CODES.map((c) => [c, sum(fx.stocks, c)]))).toEqual({
      desk: 506, desk_ng: 41, chair: 493, chair_ng: 40, caster_desk: 180, blue_chair: 432, long_desk_3: 8, long_desk_2: 127, lectern: 27,
    });
    const seminar = fx.stocks.find((s) => s.room === '第一セミナー')!.counts;
    expect(seminar).toMatchObject({ caster_desk: 1, blue_chair: 49, long_desk_2: 25, lectern: 2 });
    expect(fx.rooms.find((r) => r.name === '第一セミナー')!.usable).toBe(false);
  });

  it('需要の合計 1,295（机系 644・椅子 372・椅子(青) 134・キャスター机 29・教卓 10・長机 106）', () => {
    const n = (c: string) => sum(fx.requests, c);
    expect(n('desk')).toBe(644);
    expect(n('chair')).toBe(372);
    expect(n('blue_chair')).toBe(134);
    expect(n('caster_desk')).toBe(29);
    expect(n('lectern')).toBe(10);
    expect(n('long_desk_3') + n('long_desk_2')).toBe(106);
    expect(ITEM_CODES.reduce((a, c) => a + n(c), 0)).toBe(1295);
  });

  it('足した団体：剣道部2団体・校内分散・未提出（W105 が1件）', () => {
    const g = (name: string) => fx.groups.find((x) => x.name === name)!;
    expect(g('剣道部(飲食)').location).toBe('外16');
    expect(g('部門(校内分散)').location).toBeNull();
    expect(fx.groups.filter((x) => x.submittedAt === null).map((x) => x.name)).toEqual(['未提出の団体']);
    expect(fx.requests.some((r) => r.group === '未提出の団体')).toBe(false);
  });

  it('同じシードなら同じ、違うシードなら違う', () => {
    expect(generateSynthetic()).toEqual(fx);
    expect(generateSynthetic(100)).not.toEqual(fx);
  });

  it('makeInfeasibleS05：S05 の部屋の机が 235、在庫の合計は同じ', () => {
    const inf = makeInfeasibleS05(fx);
    const s05 = new Set<string>(S05_ROOMS);
    expect(inf.stocks.filter((s) => s05.has(s.room)).reduce((a, s) => a + s.counts.desk, 0)).toBe(235);
    expect(sum(inf.stocks, 'desk')).toBe(506);
  });
});
