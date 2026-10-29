'use client';

import { useEffect, useState } from 'react';

/**
 * 今の時刻（ミリ秒）。intervalMs ごとに描き直す（締切の残り・受付期間の切り替わりを画面に出すため。T11）。
 * 受付期間の判断は端末の時計なので、DB に拒否されたら画面の印（lib/data/requests.ts の OutsideFlag）で合わせる。
 */
export function useNow(intervalMs = 30_000): number {
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    const t = setInterval(() => setNow(Date.now()), intervalMs);
    return () => clearInterval(t);
  }, [intervalMs]);
  return now;
}
