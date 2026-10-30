// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from 'vitest';
import { downloadFile, MIME } from './download';

afterEach(() => {
  vi.restoreAllMocks();
  vi.useRealTimers();
});

describe('downloadFile', () => {
  it('Blob の URL を a 要素の download で押し、後で URL を消す', async () => {
    vi.useFakeTimers();
    const blobs: Blob[] = [];
    URL.createObjectURL = vi.fn((b: Blob) => {
      blobs.push(b);
      return 'blob:fake';
    });
    URL.revokeObjectURL = vi.fn();
    const clicked: { href: string; download: string }[] = [];
    vi.spyOn(HTMLAnchorElement.prototype, 'click').mockImplementation(function (this: HTMLAnchorElement) {
      clicked.push({ href: this.href, download: this.download });
    });

    const bytes = new Uint8Array([1, 2, 3, 4]).subarray(1, 3);
    downloadFile(bytes, 'R8_椅子机振り分け_部門員共有用.xlsx', MIME.xlsx);

    expect(clicked).toEqual([{ href: 'blob:fake', download: 'R8_椅子机振り分け_部門員共有用.xlsx' }]);
    expect(blobs[0]!.type).toBe(MIME.xlsx);
    expect([...new Uint8Array(await blobs[0]!.arrayBuffer())]).toEqual([2, 3]);
    expect(document.querySelectorAll('a')).toHaveLength(0);
    expect(URL.revokeObjectURL).not.toHaveBeenCalled();
    vi.advanceTimersByTime(1000);
    expect(URL.revokeObjectURL).toHaveBeenCalledWith('blob:fake');
  });

  it('文字列も保存できる', async () => {
    const blobs: Blob[] = [];
    URL.createObjectURL = vi.fn((b: Blob) => {
      blobs.push(b);
      return 'blob:fake';
    });
    URL.revokeObjectURL = vi.fn();
    vi.spyOn(HTMLAnchorElement.prototype, 'click').mockImplementation(() => {});
    downloadFile('{"a":1}', 'R8_年度データ.json', MIME.json);
    expect(await blobs[0]!.text()).toBe('{"a":1}');
  });
});
