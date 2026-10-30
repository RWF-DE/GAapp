// @vitest-environment jsdom
import { act, cleanup, render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { useState } from 'react';
import { afterEach, beforeAll, describe, expect, it, vi } from 'vitest';
import { EntitySelect, matchesEntity, type EntityOption } from './entity-select';

// jsdom にないもの（Radix の Popover と cmdk が使う）
beforeAll(() => {
  globalThis.ResizeObserver ??= class {
    observe() {}
    unobserve() {}
    disconnect() {}
  };
  Element.prototype.scrollIntoView ??= function scrollIntoView() {};
});

afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
});

// id は本物と同じ UUID の形（16 進の文字・数字と '-' を含む）。検索が id に当たらないことを確かめるため
const OPTIONS: EntityOption[] = [
  { id: 'a1b2c3d4-1e1f-4a1b-8c1d-2f3e4a5b6c7d', name: '2-3', group: 'E棟2F' },
  { id: 'f1e2d3c4-1b1a-4f2e-9d1c-1f2e3d4c5b6a', name: '1-1', group: 'E棟1F' },
  { id: '0a1b2c3d-4e5f-4a1b-8c2d-1e1f2a3b4c5d', name: '1-2', group: 'E棟1F' },
  { id: '9f8e7d6c-1a1b-4c2d-8e1f-2a2b3c4d5e6f', name: '第一セミナー', group: '共用', keywords: ['セミナー室'] },
];

function Harness({ allowClear = false }: { allowClear?: boolean }) {
  const [v, setV] = useState<string | null>(null);
  return (
    <>
      <EntitySelect label="部屋" options={OPTIONS} value={v} onChange={setV} allowClear={allowClear} />
      <p data-testid="value">{v ?? ''}</p>
    </>
  );
}

async function openAndType(text: string, allowClear = false) {
  const user = userEvent.setup();
  render(<Harness allowClear={allowClear} />);
  await user.click(screen.getByRole('combobox', { name: '部屋' }));
  const input = screen.getByPlaceholderText('名前で探す');
  if (text) await user.type(input, text);
  return { user, input };
}

const shown = () => screen.queryAllByRole('option').map((o) => o.textContent);

describe('EntitySelect の検索', () => {
  it('何も打たなければ、渡した順に全部出る', async () => {
    await openAndType('');
    expect(shown()).toEqual(['2-3', '1-1', '1-2', '第一セミナー']);
  });

  it("'1-1' と打つと 1-1 だけが残る（id の UUID には当たらない）", async () => {
    await openAndType('1-1');
    expect(shown()).toEqual(['1-1']);
  });

  it("'2F' と打つと group が E棟2F のものだけが残る", async () => {
    await openAndType('2F');
    expect(shown()).toEqual(['2-3']);
  });

  it('group で絞っても並びは渡した順のまま', async () => {
    await openAndType('E棟');
    expect(shown()).toEqual(['2-3', '1-1', '1-2']);
  });

  it('全角・大文字小文字の違いを無視し、空白で区切ると全部を含むものに絞る', async () => {
    await openAndType('ｅ棟１ｆ　1-2');
    expect(shown()).toEqual(['1-2']);
  });

  it('keywords でも探せる', async () => {
    await openAndType('セミナー室');
    expect(shown()).toEqual(['第一セミナー']);
  });

  it('当たらなければ「見つかりません」を出す', async () => {
    await openAndType('3-9');
    expect(shown()).toEqual([]);
    expect(screen.getByText('見つかりません')).toBeTruthy();
  });

  it('絞った結果を Enter で選べる', async () => {
    const { user } = await openAndType('1-2');
    await user.keyboard('{Enter}');
    expect(screen.getByTestId('value').textContent).toBe(OPTIONS[2]?.id);
  });

  it('「選ばない」は何も打っていないときだけ出る', async () => {
    const { user, input } = await openAndType('', true);
    expect(shown()).toEqual(['選ばない', '2-3', '1-1', '1-2', '第一セミナー']);
    await user.type(input, '1-1');
    expect(shown()).toEqual(['1-1']);
  });
});

/**
 * jsdom は CSS のアニメーションを動かさないので、Radix の Presence が閉じるアニメーションの終わりを待つように、
 * ポップオーバーの中身の animationName を開いているとき 'enter'、閉じたとき 'exit' に見せる。
 * 閉じきる（中身が外れる）のは、テストが animationend を投げたとき。
 */
function animatePopovers() {
  const real = window.getComputedStyle.bind(window);
  vi.spyOn(window, 'getComputedStyle').mockImplementation((el, pseudo) => {
    const styles = real(el, pseudo);
    if (!(el instanceof HTMLElement) || el.dataset.slot !== 'popover-content') return styles;
    return new Proxy(styles, {
      get(target, key) {
        if (key === 'animationName') return el.dataset.state === 'closed' ? 'exit' : 'enter';
        const v: unknown = Reflect.get(target, key, target);
        return typeof v === 'function' ? (v as (...a: unknown[]) => unknown).bind(target) : v;
      },
    });
  });
}

/** 閉じるアニメーションを終わらせ、中身が外れた後の FocusScope の setTimeout（onCloseAutoFocus を呼ぶ）まで待つ */
async function finishCloseAnimation(content: Element) {
  act(() => {
    const ev = new Event('animationend');
    Object.defineProperty(ev, 'animationName', { value: 'exit' });
    content.dispatchEvent(ev);
  });
  await act(() => new Promise((r) => setTimeout(r, 10)));
}

function TwoSelects() {
  const [a, setA] = useState<string | null>(null);
  const [b, setB] = useState<string | null>(null);
  return (
    <>
      <EntitySelect label="部屋A" options={OPTIONS} value={a} onChange={setA} />
      <EntitySelect label="部屋B" options={OPTIONS} value={b} onChange={setB} />
    </>
  );
}

describe('EntitySelect：閉じるアニメーションの間に別の EntitySelect を開く', () => {
  it('前のポップオーバーが閉じきっても、フォーカスを前のボタンに戻さず、新しいポップオーバーは開いたまま', async () => {
    animatePopovers();
    const user = userEvent.setup();
    render(<TwoSelects />);
    const a = screen.getByRole('combobox', { name: '部屋A' });
    const b = screen.getByRole('combobox', { name: '部屋B' });

    await user.click(a);
    await user.keyboard('{Enter}'); // 先頭（2-3）を選んで閉じる
    expect(a.getAttribute('aria-expanded')).toBe('false');
    const closing = document.querySelector('[data-slot="popover-content"][data-state="closed"]');
    expect(closing).not.toBeNull(); // まだ閉じるアニメーションの間

    // B を押して開く（フォーカスは B の検索の欄に移る）。
    // A の DismissableLayer が B を押したことを「外の操作」と数えると、Radix は自分ではフォーカスを戻さない。
    // E2E（T12）では数えられずに前のボタンへ戻ったので、その形を作る：外の pointerdown は click まで持ち越され
    // （deferPointerDownOutside）、click が document まで届かないと外の操作として扱われない。
    const stop = (e: Event) => e.stopPropagation();
    document.body.addEventListener('click', stop);
    try {
      await user.click(b);
      await act(() => new Promise((r) => setTimeout(r, 10)));
    } finally {
      document.body.removeEventListener('click', stop);
    }
    expect(b.getAttribute('aria-expanded')).toBe('true');
    const bInput = document.querySelector('[data-slot="popover-content"][data-state="open"] input');
    expect(bInput).not.toBeNull();
    await waitFor(() => expect(document.activeElement).toBe(bInput));

    // A の閉じるアニメーションが終わる（FocusScope は setTimeout の後に onCloseAutoFocus を呼ぶ）
    await finishCloseAnimation(closing!);
    expect(closing!.isConnected).toBe(false);
    expect(document.activeElement).toBe(bInput);
    expect(document.activeElement).not.toBe(a);
    expect(b.getAttribute('aria-expanded')).toBe('true');
  });

  it('ほかへフォーカスが移っていなければ、閉じきったときに開いたボタンへ戻す（今までどおり）', async () => {
    animatePopovers();
    const user = userEvent.setup();
    render(<TwoSelects />);
    const a = screen.getByRole('combobox', { name: '部屋A' });
    await user.click(a);
    await user.keyboard('{Enter}');
    const closing = document.querySelector('[data-slot="popover-content"][data-state="closed"]');
    expect(closing).not.toBeNull();
    await finishCloseAnimation(closing!);
    expect(closing!.isConnected).toBe(false);
    expect(document.activeElement).toBe(a);
  });
});

describe('matchesEntity', () => {
  const room: EntityOption = { id: 'a1b2c3d4-1e1f-4a1b-8c1d-2f3e4a5b6c7d', name: '2-3', group: 'E棟2F', keywords: ['二年三組'] };

  it('名前・group・keywords の部分一致で当たる', () => {
    expect(matchesEntity(room, '2-3')).toBe(true);
    expect(matchesEntity(room, 'e棟2f')).toBe(true);
    expect(matchesEntity(room, '三組')).toBe(true);
    expect(matchesEntity(room, '  ')).toBe(true);
  });

  it('id（UUID）の文字の並びには当たらない', () => {
    expect(matchesEntity(room, 'a1b2')).toBe(false);
    expect(matchesEntity(room, '1e1f')).toBe(false);
    expect(matchesEntity(room, '1-1')).toBe(false);
  });

  it('飛び飛びの文字（あいまい一致）には当たらない', () => {
    expect(matchesEntity(room, '23')).toBe(false);
  });
});
