// @vitest-environment jsdom
// 共有のダイアログ（components/ui の AlertDialog・Dialog・Sheet と、それを使う components/common の ConfirmDialog）の重なり
// （04「共通レイアウト」のダイアログの重なりの項、D-52 の T19 の直し・3。2026-11-03。notes/T19.md の「CI の E2E の失敗の直し（2026-11-03）」）：
// 閉じる動きの途中で同じダイアログを開き直しても、覆い（overlay）が自分の中身（content）の上に来ない。覆いと中身はどちらも z-50 で、
// body の中の順で重なる（後ろのものが上）ので、body の直下の順で確かめる。
// jsdom は CSS の動きを走らせず、getComputedStyle も呼んだときの写し（ブラウザでは生きている）なので、Radix の Presence が閉じる動きを
// 待つように、data-state で animation-name が決まる style を置き、読むたびに今の値を返す getComputedStyle に置き換える。動きの終わり
// （animationend）はテストが送る：覆いの動き（150 ms）が中身の動き（200 ms。シートは 300 ms）より先に終わった間を、時間によらずに作る。
import { act, cleanup, render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { useState } from 'react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { ConfirmDialog } from '@/components/common/confirm-dialog';
import { Dialog, DialogContent, DialogDescription, DialogTitle } from './dialog';
import { Sheet, SheetContent, SheetDescription, SheetTitle } from './sheet';

const PARTS = ['alert-dialog-overlay', 'alert-dialog-content', 'dialog-overlay', 'dialog-content', 'sheet-overlay', 'sheet-content'];
const ANIMATIONS = PARTS.map(
  (slot) => `[data-slot="${slot}"][data-state="open"] { animation-name: enter; } [data-slot="${slot}"][data-state="closed"] { animation-name: exit; }`,
).join('\n');

let style: HTMLStyleElement;
beforeEach(() => {
  style = document.createElement('style');
  style.textContent = ANIMATIONS;
  document.head.append(style);
  const real = window.getComputedStyle.bind(window);
  vi.spyOn(window, 'getComputedStyle').mockImplementation(
    (el: Element, pseudo?: string | null) =>
      new Proxy({} as CSSStyleDeclaration, {
        get(_target, key) {
          const now = real(el, pseudo);
          const value: unknown = Reflect.get(now, key);
          return typeof value === 'function' ? (value as (...a: unknown[]) => unknown).bind(now) : value;
        },
      }),
  );
});

afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
  style.remove();
});

/** body の直下のダイアログの部品（data-slot:data-state）を、body の中の順（後ろのものが上に重なる）で */
function layers(): string[] {
  return [...document.body.children]
    .filter((el) => PARTS.includes(el.getAttribute('data-slot') ?? ''))
    .map((el) => `${el.getAttribute('data-slot')}:${el.getAttribute('data-state')}`);
}

function part(slot: string): Element {
  const el = document.body.querySelector(`:scope > [data-slot="${slot}"]`);
  if (!el) throw new Error(`${slot} がありません`);
  return el;
}

/** その部品の閉じる動きを終わらせる（ブラウザでは CSS の動きが終わると animationend が届く） */
function finishExit(slot: string) {
  const event = new Event('animationend', { bubbles: true });
  Object.defineProperty(event, 'animationName', { value: 'exit' });
  act(() => {
    part(slot).dispatchEvent(event);
  });
}

describe('閉じる動きの途中で開き直したときの覆いと中身の重なり', () => {
  it('ConfirmDialog（AlertDialog）：覆いの動きが先に終わった後に開き直しても、覆いは中身の前（中身が上）で、確定のボタンを押せる', async () => {
    const user = userEvent.setup();
    const onConfirm = vi.fn();
    function Opener() {
      const [open, setOpen] = useState(false);
      return (
        <>
          <button onClick={() => setOpen(true)}>提出した</button>
          <ConfirmDialog open={open} onOpenChange={setOpen} title="「E2E 書類」を提出しますか" confirmLabel="提出する" onConfirm={onConfirm} />
        </>
      );
    }
    render(<Opener />);
    // 開いた元のボタン（ダイアログの中身がある間は、閉じる途中も aria-hidden になるので、先に取っておく）
    const opener = screen.getByRole('button', { name: '提出した' });
    await user.click(opener);
    expect(layers()).toEqual(['alert-dialog-overlay:open', 'alert-dialog-content:open']);

    // やめる → 閉じる動きの間は、覆いも中身も closed で残る
    await user.click(screen.getByRole('button', { name: 'やめる' }));
    expect(layers()).toEqual(['alert-dialog-overlay:closed', 'alert-dialog-content:closed']);
    // 覆いの動き（150 ms）が先に終わる。中身（200 ms）は閉じる途中のまま
    finishExit('alert-dialog-overlay');
    expect(layers()).toEqual(['alert-dialog-content:closed']);

    // 閉じる途中で同じダイアログを開き直す：覆いは中身の前に入る（直す前は body の最後〔中身の後ろ〕に付き、中身の上に来ていた）
    await user.click(opener);
    expect(layers()).toEqual(['alert-dialog-overlay:open', 'alert-dialog-content:open']);
    await user.click(screen.getByRole('button', { name: '提出する' }));
    expect(onConfirm).toHaveBeenCalledTimes(1);

    // 閉じきってから開くときは今までどおり（body の最後に覆い → 中身）
    finishExit('alert-dialog-overlay');
    finishExit('alert-dialog-content');
    expect(layers()).toEqual([]);
    await user.click(opener);
    expect(layers()).toEqual(['alert-dialog-overlay:open', 'alert-dialog-content:open']);
  });

  it('Dialog：閉じる途中（覆いの動きが終わり、中身が残る間）に開き直しても、覆いは中身の前', async () => {
    const user = userEvent.setup();
    function Opener() {
      const [open, setOpen] = useState(false);
      return (
        <>
          <button onClick={() => setOpen(true)}>編集</button>
          <Dialog open={open} onOpenChange={setOpen}>
            <DialogContent>
              <DialogTitle>提出物を編集</DialogTitle>
              <DialogDescription>題名と締切を直します</DialogDescription>
              <button>保存</button>
            </DialogContent>
          </Dialog>
        </>
      );
    }
    render(<Opener />);
    const opener = screen.getByRole('button', { name: '編集' });
    await user.click(opener);
    expect(layers()).toEqual(['dialog-overlay:open', 'dialog-content:open']);
    await user.click(screen.getByRole('button', { name: '閉じる' }));
    finishExit('dialog-overlay');
    expect(layers()).toEqual(['dialog-content:closed']);
    await user.click(opener);
    expect(layers()).toEqual(['dialog-overlay:open', 'dialog-content:open']);
  });

  it('Sheet：閉じる途中（覆いの 150 ms が終わり、シートの 300 ms が残る間）に開き直しても、覆いはシートの前', async () => {
    const user = userEvent.setup();
    function Opener() {
      const [open, setOpen] = useState(false);
      return (
        <>
          <button onClick={() => setOpen(true)}>詳しく</button>
          <Sheet open={open} onOpenChange={setOpen}>
            <SheetContent>
              <SheetTitle>E2E模擬店1・E2E 書類</SheetTitle>
              <SheetDescription>ファイルと状態</SheetDescription>
            </SheetContent>
          </Sheet>
        </>
      );
    }
    render(<Opener />);
    const opener = screen.getByRole('button', { name: '詳しく' });
    await user.click(opener);
    expect(layers()).toEqual(['sheet-overlay:open', 'sheet-content:open']);
    await user.click(screen.getByRole('button', { name: '閉じる' }));
    finishExit('sheet-overlay');
    expect(layers()).toEqual(['sheet-content:closed']);
    await user.click(opener);
    expect(layers()).toEqual(['sheet-overlay:open', 'sheet-content:open']);
  });

  it('シートの上の確かめ：後から開いた確かめがシートの上に来て、確かめを閉じる途中で開き直しても、覆いは確かめの中身の前（どちらもシートの後ろ）', async () => {
    const user = userEvent.setup();
    function SheetWithConfirm() {
      const [sheet, setSheet] = useState(false);
      const [confirm, setConfirm] = useState(false);
      return (
        <>
          <button onClick={() => setSheet(true)}>詳しく</button>
          <Sheet open={sheet} onOpenChange={setSheet}>
            <SheetContent>
              <SheetTitle>E2E模擬店1・E2E 書類</SheetTitle>
              <SheetDescription>ファイルと状態</SheetDescription>
              <button onClick={() => setConfirm(true)}>ファイル 1 を外す</button>
              <ConfirmDialog
                open={confirm}
                onOpenChange={setConfirm}
                title="ファイル 1 を外しますか"
                confirmLabel="外す"
                destructive
                onConfirm={() => undefined}
              />
            </SheetContent>
          </Sheet>
        </>
      );
    }
    render(<SheetWithConfirm />);
    await user.click(screen.getByRole('button', { name: '詳しく' }));
    const remove = screen.getByRole('button', { name: 'ファイル 1 を外す' });
    await user.click(remove);
    expect(layers()).toEqual(['sheet-overlay:open', 'sheet-content:open', 'alert-dialog-overlay:open', 'alert-dialog-content:open']);
    await user.click(screen.getByRole('button', { name: 'やめる' }));
    finishExit('alert-dialog-overlay');
    expect(layers()).toEqual(['sheet-overlay:open', 'sheet-content:open', 'alert-dialog-content:closed']);
    await user.click(remove);
    expect(layers()).toEqual(['sheet-overlay:open', 'sheet-content:open', 'alert-dialog-overlay:open', 'alert-dialog-content:open']);
  });
});
