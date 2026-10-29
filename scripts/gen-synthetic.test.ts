import { readFileSync } from 'node:fs';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import loadHighs from 'highs';
import { formatFixtureFiles, formatReferenceFiles, generateSynthetic, readFixtureDir, readReferenceDir, SYNTHETIC_SEED } from '@gaapp/shared/testing';
import { SYNTHETIC_DIR } from './gen-synthetic-fixtures';
import { buildSyntheticReference } from './gen-synthetic-reference';

describe('fixtures/synthetic/r8like（設計 3.6）', () => {
  it('生成し直した結果がコミット済みのファイルと一致する（pnpm gen:synthetic で作り直す）', () => {
    const files = formatFixtureFiles(generateSynthetic(SYNTHETIC_SEED));
    for (const [rel, text] of Object.entries(files)) {
      expect(readFileSync(path.join(SYNTHETIC_DIR, rel), 'utf8'), rel).toBe(text);
    }
  });

  it('readFixtureDir で読める', () => {
    expect(readFixtureDir(SYNTHETIC_DIR)).toEqual(generateSynthetic(SYNTHETIC_SEED));
  });
});

describe('fixtures/synthetic/r8like/reference（設計 3.6）', () => {
  it('allocate の結果から再生成した結果がコミット済みのファイルと一致する（pnpm gen:synthetic-reference で作り直す）', async () => {
    const files = formatReferenceFiles(buildSyntheticReference(await loadHighs()));
    for (const [rel, text] of Object.entries(files)) {
      expect(readFileSync(path.join(SYNTHETIC_DIR, rel), 'utf8'), rel).toBe(text);
    }
  });

  it('group_totals は allocations を団体・品目ごとに足したもの。キャスター机への置き換えは 97', () => {
    const ref = readReferenceDir(SYNTHETIC_DIR)!;
    for (const g of ref.groupTotals) {
      for (const [code, n] of Object.entries(g.counts)) {
        const sum = ref.allocations.filter((a) => a.group === g.group && a.item === code).reduce((s, a) => s + a.count, 0);
        expect(n, `${g.group} ${code}`).toBe(sum);
      }
    }
    expect(ref.allocations.filter((a) => a.requestedItem === 'desk' && a.item === 'caster_desk').reduce((s, a) => s + a.count, 0)).toBe(97);
    expect(ref.allocations.every((a) => a.note === null)).toBe(true);
  });
});
