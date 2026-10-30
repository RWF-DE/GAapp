import { describe, expect, it } from 'vitest';
import { cn } from './utils';

describe('cn', () => {
  it('後に書いた Tailwind クラスが勝つ', () => {
    expect(cn('p-2', 'p-4')).toBe('p-4');
  });
});
