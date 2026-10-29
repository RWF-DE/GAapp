// @vitest-environment jsdom
import { fixturePath, readFixtureDir } from '@gaapp/shared/testing';
import { cleanup, render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { RuleDbRow } from '@/lib/db/types';
import { fixtureToTables } from '@/lib/testing/fixture-rows';
import { DISABLE_NOTICES } from './rule-write';
import { DisableDialog, type DisableFailure } from './rules-screen';

// 「無効にする」のダイアログ（T12）：開いたままにする失敗は、ダイアログの中に知らせと「読み直す」を出す
// （モーダルの間は toast の action を押せない）。
const toast = vi.hoisted(() => ({ info: vi.fn(), error: vi.fn(), success: vi.fn() }));
vi.mock('sonner', () => ({ toast }));
// rules-screen.tsx が読み込む、画面の外のもの（このテストでは使わない）
vi.mock('next/navigation', () => ({ useSearchParams: () => new URLSearchParams() }));

afterEach(() => {
  cleanup();
  vi.clearAllMocks();
});

const s04: RuleDbRow = fixtureToTables(readFixtureDir(fixturePath('synthetic', 'r8like'))).rules.find((r) => r.code === 'S04')!;

function setup(onConfirm: (memo: string | null) => Promise<DisableFailure | null>) {
  const onClose = vi.fn();
  const onReload = vi.fn();
  render(<DisableDialog rule={s04} onClose={onClose} onConfirm={onConfirm} onReload={onReload} />);
  return { onClose, onReload };
}

const dialog = () => screen.getByRole('alertdialog');
const confirmButton = () => screen.getByRole('button', { name: '無効にする' });

describe('DisableDialog', () => {
  it('止められた後に読み直せなかった：ダイアログの中に知らせと「読み直す」を出し、メモを残して開いたまま。もう一度押すと送る', async () => {
    const user = userEvent.setup();
    const onConfirm = vi
      .fn<(memo: string | null) => Promise<DisableFailure | null>>()
      .mockResolvedValueOnce({ message: DISABLE_NOTICES.rereadFailed, showReload: true })
      .mockResolvedValue(null);
    const { onClose, onReload } = setup(onConfirm);
    const memo = screen.getByLabelText('メモ');
    await user.clear(memo);
    await user.type(memo, '使わなくなった');
    await user.click(confirmButton());

    const failure = await screen.findByTestId('disable-failure');
    expect(failure.textContent).toContain(DISABLE_NOTICES.rereadFailed);
    expect(dialog().contains(failure)).toBe(true);
    expect(onClose).not.toHaveBeenCalled();
    expect((memo as HTMLTextAreaElement).value).toBe('使わなくなった');
    // 「読み直す」はダイアログの中で押せる
    await user.click(screen.getByRole('button', { name: '読み直す' }));
    expect(onReload).toHaveBeenCalledTimes(1);

    await user.click(confirmButton());
    await waitFor(() => expect(onConfirm).toHaveBeenCalledTimes(2));
    expect(onConfirm.mock.calls[1]![0]).toBe('使わなくなった');
    await waitFor(() => expect(onClose).toHaveBeenCalledTimes(1));
  });

  it('保存できたか分からない：ダイアログの中に「無効にできたか分かりません…」を出す（読み直すボタンはない）', async () => {
    const user = userEvent.setup();
    const { onClose } = setup(async () => ({ message: DISABLE_NOTICES.unknownOutcome }));
    await user.click(confirmButton());
    const failure = await screen.findByTestId('disable-failure');
    expect(failure.textContent).toBe('無効にできたか分かりません。もう一度「無効にする」を押すと、確かめてから送ります');
    expect(screen.queryByRole('button', { name: '読み直す' })).toBeNull();
    expect((confirmButton() as HTMLButtonElement).disabled).toBe(false);
    expect(onClose).not.toHaveBeenCalled();
  });
});
