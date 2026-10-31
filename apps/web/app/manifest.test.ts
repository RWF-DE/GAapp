// PWA のマニフェスト（D-38。T14）：display は browser、start_url・scope・icons の src に basePath が付く。名前は総務アプリ（D-51。T16）
import { afterEach, describe, expect, it, vi } from 'vitest';

async function load(basePath: string | undefined) {
  vi.resetModules();
  if (basePath === undefined) vi.stubEnv('NEXT_PUBLIC_BASE_PATH', undefined as unknown as string);
  else vi.stubEnv('NEXT_PUBLIC_BASE_PATH', basePath);
  const mod = await import('./manifest');
  return mod.default();
}

describe('manifest', () => {
  afterEach(() => {
    vi.unstubAllEnvs();
  });

  it('basePath なし：/ から始まる', async () => {
    const m = await load('');
    expect(m.display).toBe('browser');
    expect(m.start_url).toBe('/');
    expect(m.scope).toBe('/');
    expect(m.icons?.map((i) => i.src)).toEqual(['/icon.png', '/apple-icon.png']);
  });

  it('T16 名前は総務アプリ：name「電波祭 総務」、short_name「総務」、description は総務部門の仕事。色と表示は変えない', async () => {
    const m = await load('');
    expect(m.name).toBe('電波祭 総務');
    expect(m.short_name).toBe('総務');
    expect(m.description).toBe('電波祭の総務部門の仕事をまとめるアプリ（机椅子の在庫・申請・振り分けなど）');
    expect(m.lang).toBe('ja');
    expect(m.theme_color).toBe('#1d4ed8');
    expect(m.background_color).toBe('#ffffff');
  });

  it('basePath /GAapp：start_url・scope・icons の src に付く', async () => {
    const m = await load('/GAapp');
    expect(m.display).toBe('browser');
    expect(m.start_url).toBe('/GAapp/');
    expect(m.scope).toBe('/GAapp/');
    expect(m.icons?.map((i) => i.src)).toEqual(['/GAapp/icon.png', '/GAapp/apple-icon.png']);
    expect(m.icons?.every((i) => i.type === 'image/png')).toBe(true);
  });
});
