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

  it('ほかの人が先に変えた（changed）：入力の元を読み直した行に付け替えても、メモの入力と知らせを残して開いたまま', async () => {
    const user = userEvent.setup();
    const onClose = vi.fn();
    const onReload = vi.fn();
    const rebased: RuleDbRow = { ...s04, memo: 'ほかの人のメモ', updated_at: '2026-10-29T01:00:00.000000+00:00' };
    const onConfirm = vi.fn<(memo: string | null) => Promise<DisableFailure | null>>().mockResolvedValue({ message: '他の人が先に変更しました' });
    const { rerender } = render(<DisableDialog rule={s04} onClose={onClose} onConfirm={onConfirm} onReload={onReload} />);
    const memo = screen.getByLabelText('メモ');
    await user.clear(memo);
    await user.type(memo, 'わたしのメモ');
    await user.click(confirmButton());
    await screen.findByTestId('disable-failure');
    // 呼ぶ側が rebase の行を渡し直す（作り直さない）
    rerender(<DisableDialog rule={rebased} onClose={onClose} onConfirm={onConfirm} onReload={onReload} />);
    expect((screen.getByLabelText('メモ') as HTMLTextAreaElement).value).toBe('わたしのメモ');
    expect(screen.getByTestId('disable-failure').textContent).toContain('他の人が先に変更しました');
    expect(onClose).not.toHaveBeenCalled();
  });
});
