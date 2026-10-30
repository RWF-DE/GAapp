'use client';

// ?row=… で開いたら、その行のタブを開いてスクロールする（行のタブが違えば直す。画面の設計 3.9。T13）。
// スクロールは ?row= の行ごとに1回だけ：同じ ?row= のまま行を編集・読み直しても（rowItem が新しくなっても）、その行へ引き戻さない。
// 行がまだ描かれていない（読み込み中・タブを直している途中）ときは、描かれたときにスクロールする。
// 検証の一覧・precheck の項目から同じ行をもう一度押したときは URL が変わらないので、押した回数（focusKey）が進んだら
// もう一度スクロールする。
import { useEffect, useRef } from 'react';
import type { AllocationQuery } from './allocation-query';

export function useRowFocus(p: {
  row: string | undefined;
  view: AllocationQuery['view'];
  rowItem: ReadonlyMap<string, string>;
  tabByItem: ReadonlyMap<string, string>;
  currentTabKey: string | undefined;
  setQuery: (q: Partial<AllocationQuery>) => void;
  /** 行へ移る操作（項目を押す）の回数。進むと、同じ ?row= でももう一度スクロールする */
  focusKey?: number;
}) {
  const { row, view, rowItem, tabByItem, currentTabKey, setQuery, focusKey = 0 } = p;
  const scrolledTo = useRef<string | null>(null);
  const lastFocusKey = useRef(focusKey);
  useEffect(() => {
    if (lastFocusKey.current !== focusKey) {
      lastFocusKey.current = focusKey;
      scrolledTo.current = null;
    }
    if (!row) {
      scrolledTo.current = null;
      return;
    }
    const itemId = rowItem.get(row);
    const tab = itemId ? tabByItem.get(itemId) : undefined;
    if (tab && view === 'item' && tab !== currentTabKey) {
      setQuery({ view: 'item', tab, row });
      return;
    }
    if (scrolledTo.current === row) return;
    const el = document.querySelector(`[data-row-id="${CSS.escape(row)}"]`);
    if (!el) return;
    el.scrollIntoView({ block: 'center' });
    scrolledTo.current = row;
  }, [row, view, rowItem, tabByItem, currentTabKey, setQuery, focusKey]);
}
