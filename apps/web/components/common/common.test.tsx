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

  it('size を渡さなければ今までの大きさ（ボタンは size="icon"、欄は h-9）', () => {
    render(<Stepper initial={1} />);
    expect(screen.getByRole('group', { name: '長机の数' }).getAttribute('data-size')).toBe('default');
    for (const name of ['長机の数を1減らす', '長机の数を1増やす']) {
      const b = screen.getByRole('button', { name });
      expect(b.className).toContain('size-9');
      expect(b.className).not.toContain('size-11');
    }
    const input = screen.getByRole('textbox', { name: '長机の数' });
    expect(input.className.split(' ')).toEqual(expect.arrayContaining(['h-9', 'w-20', 'md:text-sm']));
    expect(input.className).not.toContain('h-11');
  });

  it('size="lg" はボタンと欄の高さを 44px（size-11・h-11）にし、className は外側に付く', async () => {
    const user = userEvent.setup();
    const onChange = vi.fn();
    render(<CountStepper size="lg" label="長机の数" value={2} onChange={onChange} className="shrink-0" />);
    const group = screen.getByRole('group', { name: '長机の数' });
    expect(group.getAttribute('data-size')).toBe('lg');
    expect(group.className).toContain('shrink-0');
    for (const name of ['長机の数を1減らす', '長机の数を1増やす']) {
      const classes = screen.getByRole('button', { name }).className.split(' ');
      expect(classes).toContain('size-11');
      expect(classes).not.toContain('size-9');
    }
    const classes = screen.getByRole('textbox', { name: '長机の数' }).className.split(' ');
    expect(classes).toEqual(expect.arrayContaining(['h-11', 'text-lg', 'md:text-lg']));
    expect(classes).not.toContain('h-9');
    expect(classes).not.toContain('md:text-sm');
    // 動きは同じ
    await user.click(screen.getByRole('button', { name: '長机の数を1増やす' }));
    expect(onChange).toHaveBeenCalledWith(3);
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

  it('defaultValue を渡さなければ理由の欄は空', () => {
    render(<ReasonDialog open onOpenChange={() => {}} title="確定" onSubmit={() => {}} />);
    expect((screen.getByRole('textbox', { name: '理由（必須）' }) as HTMLTextAreaElement).value).toBe('');
  });

  it('defaultValue は理由の欄の初期値。そのまま送れ、開き直すと初期値に戻る', async () => {
    const user = userEvent.setup();
    const onSubmit = vi.fn();
    function Host() {
      const [open, setOpen] = useState(true);
      return (
        <>
          <button type="button" onClick={() => setOpen(true)}>
            開く
          </button>
          <ReasonDialog
            open={open}
            onOpenChange={setOpen}
            title="取り込み"
            defaultValue="  取り込み：requests.csv  "
            onSubmit={onSubmit}
            confirmLabel="取り込む"
          />
        </>
      );
    }
    render(<Host />);
    const box = () => screen.getByRole('textbox', { name: '理由（必須）' }) as HTMLTextAreaElement;
    expect(box().value).toBe('  取り込み：requests.csv  ');
    // 書き換えてから閉じると、開き直したときは初期値に戻る
    await user.type(box(), '追記');
    await user.click(screen.getByRole('button', { name: 'やめる' }));
    expect(screen.queryByRole('textbox', { name: '理由（必須）' })).toBeNull();
    await user.click(screen.getByRole('button', { name: '開く' }));
    expect(box().value).toBe('  取り込み：requests.csv  ');
    // 初期値のまま送ると前後の空白を除いて送る
    await user.click(screen.getByRole('button', { name: '取り込む' }));
    expect(onSubmit).toHaveBeenCalledWith('取り込み：requests.csv');
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

  it('開くとフォーカスがダイアログの中（やめるのボタン）に移り、Enter で開いたボタンをもう一度押さない', async () => {
    const user = userEvent.setup();
    const onOpen = vi.fn();
    function Opener() {
      const [open, setOpen] = useState(false);
      return (
        <>
          <button
            onClick={() => {
              onOpen();
              setOpen(true);
            }}
          >
            ログアウト
          </button>
          <ConfirmDialog open={open} onOpenChange={setOpen} title="移りますか" onConfirm={() => undefined} />
        </>
      );
    }
    render(<Opener />);
    await user.click(screen.getByRole('button', { name: 'ログアウト' }));
    const dialog = await screen.findByRole('alertdialog');
    await vi.waitFor(() => expect(dialog.contains(document.activeElement)).toBe(true));
    expect(document.activeElement).toBe(screen.getByRole('button', { name: 'やめる' }));
    await user.keyboard('{Enter}');
    expect(onOpen).toHaveBeenCalledTimes(1);
    expect(screen.queryByRole('alertdialog')).toBeNull();
  });
  it('閉じると（やめる・Esc）フォーカスが開いた元のボタンに戻る', async () => {
    const user = userEvent.setup();
    function Opener() {
      const [open, setOpen] = useState(false);
      return (
        <>
          <button onClick={() => setOpen(true)}>削除</button>
          <ConfirmDialog open={open} onOpenChange={setOpen} title="削除しますか" onConfirm={() => undefined} />
        </>
      );
    }
    render(<Opener />);
    const opener = screen.getByRole('button', { name: '削除' });
    for (const close of [() => user.click(screen.getByRole('button', { name: 'やめる' })), () => user.keyboard('{Escape}')]) {
      await user.click(opener);
      const dialog = await screen.findByRole('alertdialog');
      await vi.waitFor(() => expect(dialog.contains(document.activeElement)).toBe(true));
      await close();
      await vi.waitFor(() => expect(screen.queryByRole('alertdialog')).toBeNull());
      await vi.waitFor(() => expect(document.activeElement).toBe(opener));
    }
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
