// そのタブで選んだ年度（画面の設計 1.3.1、D-31。T09a）。sessionStorage（タブごと）の `gaapp:year:<user_id>` に置く。
// localStorage には置かない（前年度を一度見ただけで、次の日の在庫入力・申請が前年度で開くのを避ける）。
// sessionStorage が使えない（プライベートモード・ストレージの拒否）ときは例外を受け止め、既定の最新の年度で動く。

export const SELECTED_YEAR_PREFIX = 'gaapp:year:';

export type YearStorage = Pick<Storage, 'getItem' | 'setItem' | 'removeItem'>;

export function selectedYearKey(userId: string): string {
  return `${SELECTED_YEAR_PREFIX}${userId}`;
}

function sessionStore(): YearStorage | null {
  try {
    return typeof window === 'undefined' ? null : window.sessionStorage;
  } catch {
    return null;
  }
}

/** 選んだ年度の id（なければ・読めなければ null） */
export function readSelectedYear(userId: string, storage: YearStorage | null = sessionStore()): string | null {
  try {
    return storage?.getItem(selectedYearKey(userId)) ?? null;
  } catch {
    return null;
  }
}

/** 選んだ年度を置く（null なら消す）。書けなくても例外にしない（その場合はこの画面の中でだけ切り替わる） */
export function writeSelectedYear(userId: string, yearId: string | null, storage: YearStorage | null = sessionStore()): void {
  try {
    if (yearId) storage?.setItem(selectedYearKey(userId), yearId);
    else storage?.removeItem(selectedYearKey(userId));
  } catch {
    // 使えなければ覚えない
  }
}

export function clearSelectedYear(userId: string, storage: YearStorage | null = sessionStore()): void {
  writeSelectedYear(userId, null, storage);
}
