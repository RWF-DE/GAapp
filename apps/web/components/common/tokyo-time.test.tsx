// @vitest-environment jsdom
import { cleanup, render, screen } from '@testing-library/react';
import { afterEach, describe, expect, it } from 'vitest';
import { TokyoTime } from './tokyo-time';

afterEach(() => cleanup());

describe('TokyoTime', () => {
  it('日時は Asia/Tokyo で出し、title に秒まで', () => {
    render(<TokyoTime value="2026-10-05T09:01:09Z" />);
    const t = screen.getByText('2026/10/05 18:01');
    expect(t.getAttribute('title')).toBe('2026/10/05 18:01:09');
  });

  it('format="date" に YYYY-MM-DD を渡すとそのまま（タイムゾーンを通さない）', () => {
    render(<TokyoTime value="2026-10-17" format="date" />);
    expect(screen.getByText('2026/10/17').getAttribute('datetime')).toBe('2026-10-17');
  });

  it('format="date" に Date を渡すと Asia/Tokyo の日付（UTC では前の日の 15 時以降）', () => {
    render(<TokyoTime value={new Date('2026-10-04T15:30:00Z')} format="date" />);
    expect(screen.getByText('2026/10/05').getAttribute('datetime')).toBe('2026-10-05');
  });

  it('format="date" に timestamptz の文字列を渡しても Asia/Tokyo の日付', () => {
    render(<TokyoTime value="2026-10-04T15:30:00+00:00" format="date" />);
    expect(screen.getByText('2026/10/05').getAttribute('datetime')).toBe('2026-10-05');
  });

  it('値がなければ empty', () => {
    render(<TokyoTime value={null} format="date" empty="未設定" />);
    expect(screen.getByText('未設定')).toBeTruthy();
  });

  it('読めない値（不正な Date・読めない文字列）は、どの形でも落ちずに empty', () => {
    for (const format of ['datetime', 'short', 'time', 'date'] as const) {
      for (const value of [new Date('x'), 'garbage']) {
        cleanup();
        const { container } = render(<TokyoTime value={value} format={format} empty="不明" />);
        expect(container.textContent).toBe('不明');
        expect(container.querySelector('time')).toBeNull();
      }
    }
  });

  it('既定の形でも、読めない値は既定の empty（—）', () => {
    for (const value of [new Date('x'), 'garbage']) {
      cleanup();
      const { container } = render(<TokyoTime value={value} />);
      expect(container.textContent).toBe('—');
    }
  });

  it('dateTime 属性は読めた Date から作る（ISO 8601 の UTC）', () => {
    render(<TokyoTime value="2026-10-05T18:01:09+09:00" />);
    expect(screen.getByText('2026/10/05 18:01').getAttribute('datetime')).toBe('2026-10-05T09:01:09.000Z');
  });
});
