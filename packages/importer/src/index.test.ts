import { describe, expect, it } from 'vitest';
import { PACKAGE_NAME } from './index';

describe('@gaapp/importer', () => {
  it('読み込める', () => {
    expect(PACKAGE_NAME).toBe('@gaapp/importer');
  });
});
