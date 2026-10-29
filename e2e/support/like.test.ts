// LIKE のパターンの組み立て（e2e/support/db.ts の cleanupLeftovers が使う）。DB につながない。
import { describe, expect, it } from 'vitest';
import { escapeLike, likePrefix } from './like';

/** Postgres の `x like pattern escape '\'` と同じ判定（テスト用の小さな実装） */
function pgLike(value: string, pattern: string): boolean {
  let re = '';
  for (let i = 0; i < pattern.length; i++) {
    const ch = pattern[i];
    if (ch === '\\') {
      i++;
      re += (pattern[i] ?? '').replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
    } else if (ch === '%') re += '[\\s\\S]*';
    else if (ch === '_') re += '[\\s\\S]';
    else re += ch.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  }
  return new RegExp(`^${re}$`, 'u').test(value);
}

describe('escapeLike', () => {
  it('%・_・\\ をエスケープする', () => {
    expect(escapeLike('a_b%c\\d')).toBe('a\\_b\\%c\\\\d');
  });
});

describe('likePrefix', () => {
  it('_ を任意の1文字にしない（e2e_serial_ が e2eXserialY に当たらない）', () => {
    const p = likePrefix('e2e_serial_');
    expect(p).toBe('e2e\\_serial\\_%');
    expect(pgLike('e2e_serial_chair', p)).toBe(true);
    expect(pgLike('e2eXserialYchair', p)).toBe(false);
  });

  it('- や日本語はそのまま', () => {
    expect(pgLike('E2E-serial-棟A', likePrefix('E2E-serial-棟'))).toBe(true);
    expect(pgLike('MANUAL-1', likePrefix('E2E-'))).toBe(false);
  });

  it('前と後ろを指定できる（e2e-…@example.test）', () => {
    const p = likePrefix('e2e-', '@example.test');
    expect(p).toBe('e2e-%@example.test');
    expect(pgLike('e2e-role-1234abcd@example.test', p)).toBe(true);
    expect(pgLike('e2e-role@exampleXtest', p)).toBe(false);
  });
});
