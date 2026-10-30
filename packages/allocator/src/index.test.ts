import { describe, expect, it } from 'vitest';
import { PACKAGE_NAME } from './index';

describe('@gaapp/allocator', () => {
  it('読み込める', () => {
    expect(PACKAGE_NAME).toBe('@gaapp/allocator');
  });
});
