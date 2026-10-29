// @vitest-environment jsdom
import { cleanup, renderHook } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { useRowFocus } from './use-row-focus';

const ROW = 'r1';
const tabByItem = new Map([
  ['desk', 'desk'],
  ['chair', 'chair'],
]);
let scroll: ReturnType<typeof vi.fn>;

beforeEach(() => {
  scroll = vi.fn();
  Element.prototype.scrollIntoView = scroll as unknown as Element['scrollIntoView'];
  document.body.innerHTML = `<div data-row-id="${ROW}"></div><div data-row-id="r2"></div>`;
});
afterEach(() => {
  cleanup();
  document.body.innerHTML = '';
});

type Props = Parameters<typeof useRowFocus>[0];

describe('useRowFocus（?row= の行へ移る）', () => {
  it('開いたときに1回だけスクロールする。同じ ?row= のまま行が変わっても（編集・読み直し）戻さない', () => {
    const setQuery = vi.fn();
    const props: Props = { row: ROW, view: 'item', rowItem: new Map([[ROW, 'desk']]), tabByItem, currentTabKey: 'desk', setQuery };
    const { rerender } = renderHook((p: Props) => useRowFocus(p), { initialProps: props });
    expect(scroll).toHaveBeenCalledTimes(1);
    // 未保存の変更・読み直しのたびに rowItem は新しい Map になる
    rerender({ ...props, rowItem: new Map([[ROW, 'desk']]) });
    rerender({ ...props, rowItem: new Map([[ROW, 'desk'], ['r3', 'desk']]) });
    expect(scroll).toHaveBeenCalledTimes(1);
    expect(setQuery).not.toHaveBeenCalled();
  });

  it('?row= が変われば、その行へスクロールする', () => {
    const props: Props = { row: ROW, view: 'item', rowItem: new Map([[ROW, 'desk'], ['r2', 'desk']]), tabByItem, currentTabKey: 'desk', setQuery: vi.fn() };
    const { rerender } = renderHook((p: Props) => useRowFocus(p), { initialProps: props });
    rerender({ ...props, row: 'r2' });
    expect(scroll).toHaveBeenCalledTimes(2);
  });

  it('行のタブが違えば直し、直したタブでスクロールする', () => {
    const setQuery = vi.fn();
    const props: Props = { row: ROW, view: 'item', rowItem: new Map([[ROW, 'chair']]), tabByItem, currentTabKey: 'desk', setQuery };
    const { rerender } = renderHook((p: Props) => useRowFocus(p), { initialProps: props });
    expect(setQuery).toHaveBeenCalledWith({ view: 'item', tab: 'chair', row: ROW });
    expect(scroll).not.toHaveBeenCalled();
    rerender({ ...props, currentTabKey: 'chair' });
    expect(scroll).toHaveBeenCalledTimes(1);
    rerender({ ...props, currentTabKey: 'chair', rowItem: new Map([[ROW, 'chair']]) });
    expect(scroll).toHaveBeenCalledTimes(1);
  });

  it('行がまだ描かれていなければ、描かれたときにスクロールする', () => {
    document.body.innerHTML = '';
    const props: Props = { row: ROW, view: 'item', rowItem: new Map(), tabByItem, currentTabKey: 'desk', setQuery: vi.fn() };
    const { rerender } = renderHook((p: Props) => useRowFocus(p), { initialProps: props });
    expect(scroll).not.toHaveBeenCalled();
    document.body.innerHTML = `<div data-row-id="${ROW}"></div>`;
    rerender({ ...props, rowItem: new Map([[ROW, 'desk']]) });
    expect(scroll).toHaveBeenCalledTimes(1);
  });
});
