import { readFileSync } from 'node:fs';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import { formatFixtureFiles, generateSynthetic, readFixtureDir, SYNTHETIC_SEED } from '@gaapp/shared/testing';
import { SYNTHETIC_DIR } from './gen-synthetic-fixtures';

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
