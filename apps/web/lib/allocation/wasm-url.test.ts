import { describe, expect, it } from 'vitest';
import { highsWasmUrl, normalizeBasePath } from './wasm-url';

describe('highsWasmUrl', () => {
  it('basePath なし（ローカル・E2E）', () => {
    expect(highsWasmUrl('http://localhost:3270', '', '1.15.4', 0)).toBe('http://localhost:3270/highs.wasm?v=1.15.4');
  });

  it('basePath あり（GitHub Pages の /GAapp）', () => {
    expect(highsWasmUrl('https://example.github.io', '/GAapp', '1.15.4', 0)).toBe('https://example.github.io/GAapp/highs.wasm?v=1.15.4');
  });

  it('読み直しの回数を r に付ける（0 なら付けない）', () => {
    expect(highsWasmUrl('https://example.github.io', '/GAapp', '1.15.4', 2)).toBe('https://example.github.io/GAapp/highs.wasm?v=1.15.4&r=2');
    expect(highsWasmUrl('http://localhost:3270', '', '1.15.4', 1)).toBe('http://localhost:3270/highs.wasm?v=1.15.4&r=1');
  });

  it('末尾と先頭のスラッシュをそろえる', () => {
    expect(highsWasmUrl('https://example.github.io/', 'GAapp/', '1.15.4')).toBe('https://example.github.io/GAapp/highs.wasm?v=1.15.4');
    expect(normalizeBasePath('/')).toBe('');
    expect(normalizeBasePath('  ')).toBe('');
    expect(normalizeBasePath('/GAapp')).toBe('/GAapp');
  });

  it('負・小数の回数は 0 とみなす', () => {
    expect(highsWasmUrl('http://x', '', '1', -1)).toBe('http://x/highs.wasm?v=1');
    expect(highsWasmUrl('http://x', '', '1', 1.5)).toBe('http://x/highs.wasm?v=1');
  });
});
