// @vitest-environment jsdom
import { cleanup, render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { useState } from 'react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { ConfirmDialog } from './confirm-dialog';
import { CountStepper, parseCount } from './count-stepper';
import { ReasonDialog, reasonError } from './reason-dialog';
import { canStartRequesting, confirmBlockers, statusActionsFor } from './year-status-actions';

afterEach(() => cleanup());

function Stepper({ min, max, initial }: { min?: number; max?: number; initial: number }) {
  const [v, setV] = useState(initial);
  return (
    <>
      <CountStepper label="長机の数" value={v} onChange={setV} min={min} max={max} />
      <p data-testid="value">{v}</p>
    </>
  );
}

describe('CountStepper', () => {
  it('min で－、max で＋を押せない', async () => {
    const user = userEvent.setup();
    render(<Stepper min={1} max={3} initial={1} />);
    const minus = screen.getByRole('button', { name: '長机の数を1減らす' });
    const plus = screen.getByRole('button', { name: '長机の数を1増やす' });
    expect((minus as HTMLButtonElement).disabled).toBe(true);
    await user.click(plus);
    await user.click(plus);
    expect(screen.getByTestId('value').textContent).toBe('3');
    expect((plus as HTMLButtonElement).disabled).toBe(true);
    expect((minus as HTMLButtonElement).disabled).toBe(false);
  });

  it('入力した数は確定したときに min〜max に収め、数字でなければ元に戻す', async () => {
    const user = userEvent.setup();
    render(<Stepper initial={5} />);
    const input = screen.getByRole('textbox', { name: '長机の数' }) as HTMLInputElement;
    await user.clear(input);
    await user.type(input, '20000{Enter}');
    expect(screen.getByTestId('value').textContent).toBe('10000');
    await user.clear(input);
    await user.type(input, 'abc');
    await user.tab();
    expect(screen.getByTestId('value').textContent).toBe('10000');
    expect(input.value).toBe('10000');
  });

  it('parseCount は全角の数字も読み、範囲に収める', () => {
    expect(parseCount('１２', 0, 100)).toBe(12);
    expect(parseCount('-3', 0, 100)).toBe(0);
    expect(parseCount('0', 1, 100)).toBe(1);
    expect(parseCount('1.5', 0, 100)).toBeNull();
    expect(parseCount('', 0, 100)).toBeNull();
  });
});

describe('ReasonDialog', () => {
  it('reasonError：必須なら空はだめ、500 字まで', () => {
    expect(reasonError('  ', true)).toBe('理由を入れてください');
    expect(reasonError('', false)).toBeNull();
    expect(reasonError('a'.repeat(500), true)).toBeNull();
    expect(reasonError('a'.repeat(501), false)).toBe('理由は500字以内で入れてください');
  });

  it('必須の理由が空なら送らずに知らせる', async () => {
    const user = userEvent.setup();
    const onSubmit = vi.fn();
    render(<ReasonDialog open onOpenChange={() => {}} title="確定を解除する" onSubmit={onSubmit} confirmLabel="解除する" />);
    await user.click(screen.getByRole('button', { name: '解除する' }));
    expect(onSubmit).not.toHaveBeenCalled();
    expect(screen.getByRole('alert').textContent).toBe('理由を入れてください');
  });

  it('前後の空白を除いて送り、送信中は押せない。終われば閉じる', async () => {
    const user = userEvent.setup();
    let finish: () => void = () => {};
    const onSubmit = vi.fn(() => new Promise<void>((r) => (finish = r)));
    const onOpenChange = vi.fn();
    render(
      <ReasonDialog open onOpenChange={onOpenChange} title="確定" presets={['数え直し']} onSubmit={onSubmit} confirmLabel="確定する" />,
    );
    await user.click(screen.getByRole('button', { name: '数え直し' }));
    await user.click(screen.getByRole('button', { name: '確定する' }));
    expect(onSubmit).toHaveBeenCalledWith('数え直し');
    const busy = screen.getByRole('button', { name: '保存中…' }) as HTMLButtonElement;
    expect(busy.disabled).toBe(true);
    await user.click(busy);
    expect(onSubmit).toHaveBeenCalledTimes(1);
    finish();
    await vi.waitFor(() => expect(onOpenChange).toHaveBeenCalledWith(false));
  });

  it('任意の理由が空なら null を送る。失敗したら開いたまま', async () => {
    const user = userEvent.setup();
    const onSubmit = vi.fn(async () => {
      throw new Error('失敗');
    });
    const onOpenChange = vi.fn();
    render(<ReasonDialog open onOpenChange={onOpenChange} title="受付開始" required={false} onSubmit={onSubmit} confirmLabel="開始する" />);
    await user.click(screen.getByRole('button', { name: '開始する' }));
    expect(onSubmit).toHaveBeenCalledWith(null);
    expect(onOpenChange).not.toHaveBeenCalled();
    expect((screen.getByRole('button', { name: '開始する' }) as HTMLButtonElement).disabled).toBe(false);
  });

  it('外の送信中（pending）は確定のボタンを押せない', () => {
    render(<ReasonDialog open onOpenChange={() => {}} title="確定" pending onSubmit={() => {}} />);
    expect((screen.getByRole('button', { name: '保存中…' }) as HTMLButtonElement).disabled).toBe(true);
    expect((screen.getByRole('button', { name: 'やめる' }) as HTMLButtonElement).disabled).toBe(true);
  });
});

describe('ConfirmDialog', () => {
  it('確定の間は押せず、二重に送らない', async () => {
    const user = userEvent.setup();
    let finish: () => void = () => {};
    const onConfirm = vi.fn(() => new Promise<void>((r) => (finish = r)));
    const onOpenChange = vi.fn();
    render(<ConfirmDialog open onOpenChange={onOpenChange} title="削除しますか" destructive confirmLabel="削除する" onConfirm={onConfirm} />);
    await user.click(screen.getByRole('button', { name: '削除する' }));
    const busy = screen.getByRole('button', { name: '処理中…' }) as HTMLButtonElement;
    expect(busy.disabled).toBe(true);
    await user.click(busy);
    expect(onConfirm).toHaveBeenCalledTimes(1);
    finish();
    await vi.waitFor(() => expect(onOpenChange).toHaveBeenCalledWith(false));
  });
});

describe('YearStatusActions の純粋な部分', () => {
  const ok = { status: 'ok' as const, issues: [], problems: [], version: 7 };

  it('状態ごとのボタン', () => {
    expect(statusActionsFor('preparing').map((a) => a.label)).toEqual(['受付開始']);
    expect(statusActionsFor('allocating')[0]).toMatchObject({ to: 'confirmed', reasonRequired: true });
    expect(statusActionsFor('confirmed').map((a) => a.label)).toEqual(['確定を解除', '終了']);
    expect(statusActionsFor('closed')).toEqual([]);
  });

  it('受付開始は締切が未来のときだけ', () => {
    const now = new Date('2026-10-01T00:00:00+09:00');
    expect(canStartRequesting({ request_close_at: null }, now)).toBe(false);
    expect(canStartRequesting({ request_close_at: '2026-09-30T23:00:00+09:00' }, now)).toBe(false);
    expect(canStartRequesting({ request_close_at: '2026-10-05T18:00:00+09:00' }, now)).toBe(true);
  });

  it('確定：error 0・problems 0・検証した版が v・見張りと未保存の変更なしで押せる', () => {
    expect(confirmBlockers({ status: 'allocating', snapshotVersion: 7, validation: ok })).toEqual([]);
  });

  it('確定：problems（壊れたルール）・error・古い版・stale・未保存の変更があれば押せない', () => {
    const blockers = confirmBlockers({
      status: 'allocating',
      snapshotVersion: 8,
      validation: {
        status: 'ok',
        version: 7,
        problems: [
          { path: 'rules.S05', message: '品目がありません', ruleCode: 'S05' },
          { path: 'rooms.0.building', message: '空です' },
        ],
        issues: [
          { code: 'E001', severity: 'error', message: '', refs: {} },
          { code: 'E003', severity: 'error', message: '', refs: {} },
          { code: 'W102', severity: 'warning', message: '', refs: {} },
        ],
      },
      stale: true,
      unsaved: true,
    });
    expect(blockers).toEqual([
      'ルール S05 の設定に誤りがあります',
      '入力の誤りが 1 件あります',
      'error が 2 件あります',
      '検証した版が古くなりました。読み直してください',
      'ほかの人が入力を変えました。読み直してから確定してください',
      '保存していない変更があります。先に保存してください',
    ]);
  });

  it('確定：振り分け中でない・読み込み中・検証できないときも押せない', () => {
    expect(confirmBlockers({ status: 'requesting', snapshotVersion: 7, validation: ok })).toEqual(['振り分け中の年度だけ確定できます']);
    expect(confirmBlockers({ status: 'allocating', snapshotVersion: null, validation: null })).toEqual(['振り分けのデータを読み込んでいます']);
    expect(
      confirmBlockers({ status: 'allocating', snapshotVersion: 7, validation: { ...ok, status: 'unavailable' } }),
    ).toEqual(['検証できません']);
  });
});
