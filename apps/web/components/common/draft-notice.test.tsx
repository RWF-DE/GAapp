// @vitest-environment jsdom
import { cleanup, render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { DraftNotice } from './draft-notice';

afterEach(cleanup);

describe('DraftNotice', () => {
  it('書いた時刻を Asia/Tokyo の hh:mm で出し、戻す・捨てるを呼ぶ', async () => {
    const onRestore = vi.fn();
    const onDiscard = vi.fn();
    // 2026-10-29 09:01（UTC）= 18:01（Asia/Tokyo）
    render(<DraftNotice savedAt={Date.UTC(2026, 9, 29, 9, 1)} onRestore={onRestore} onDiscard={onDiscard} />);
    expect(screen.getByTestId('draft-notice').textContent).toContain('保存していない入力があります（18:01）');
    await userEvent.click(screen.getByRole('button', { name: '戻す' }));
    await userEvent.click(screen.getByRole('button', { name: '捨てる' }));
    expect(onRestore).toHaveBeenCalledTimes(1);
    expect(onDiscard).toHaveBeenCalledTimes(1);
  });
});
