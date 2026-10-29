'use client';

// ?row=… で開いたら、その行のタブを開いてスクロールする（行のタブが違えば直す。画面の設計 3.9。T13）。
// スクロールは ?row= の行ごとに1回だけ：同じ ?row= のまま行を編集・読み直しても（rowItem が新しくなっても）、その行へ引き戻さない。
// 行がまだ描かれていない（読み込み中・タブを直している途中）ときは、描かれたときにスクロールする。
import { useEffect, useRef } from 'react';
import type { AllocationQuery } from './allocation-query';

export function useRowFocus(p: {
  row: string | undefined;
  view: AllocationQuery['view'];
  rowItem: ReadonlyMap<string, string>;
  tabByItem: ReadonlyMap<string, string>;
  currentTabKey: string | undefined;
  setQuery: (q: Partial<AllocationQuery>) => void;
}) {
  const { row, view, rowItem, tabByItem, currentTabKey, setQuery } = p;
  const scrolledTo = useRef<string | null>(null);
  useEffect(() => {
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
  }, [row, view, rowItem, tabByItem, currentTabKey, setQuery]);
}
