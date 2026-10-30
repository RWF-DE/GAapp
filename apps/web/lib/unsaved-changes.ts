'use client';

// 未保存の入力の守り（画面の設計 1.4 の UnsavedChangesGuard、D-33。T09a）の、画面に依存しない部分。
// 確かめのダイアログは components/common/unsaved-changes-guard.tsx の UnsavedChangesProvider が出す。
// Provider がない所（部品のテストなど）では、未保存の入力はないものとして確かめずに進む。
import { createContext, useContext, useEffect, useId } from 'react';

/** 何の前に確かめるか：navigate（アプリの中の移動）・signOut（手動のログアウト）・year（年度の切り替え） */
export type LeaveKind = 'navigate' | 'signOut' | 'year';

export const LEAVE_MESSAGES: Record<LeaveKind, { title: string; description: string; confirm: string }> = {
  navigate: {
    title: '保存していない入力があります',
    description: 'このまま移りますか。入力は下書きに残り、画面を開き直すと戻せます。',
    confirm: '移る',
  },
  signOut: {
    title: '保存していない入力があります',
    description: 'ログアウトすると下書きも消えます。ログアウトしますか。',
    confirm: 'ログアウトする',
  },
  year: {
    title: '保存していない入力があります',
    description: '年度を切り替えますか。入力は下書きに残ります。',
    confirm: '切り替える',
  },
};

export interface UnsavedChangesApi {
  /** 未保存の入力があれば確かめる。続けてよければ true（なければ確かめずに true） */
  confirmLeave: (kind: LeaveKind) => Promise<boolean>;
  /** 未保存の入力があるか */
  isDirty: () => boolean;
  /** 未保存の入力の有無を知らせる（UnsavedChangesGuard・useUnsavedChanges が使う） */
  setDirty: (id: string, dirty: boolean) => void;
}

const passThrough: UnsavedChangesApi = {
  confirmLeave: async () => true,
  isDirty: () => false,
  setDirty: () => {},
};

export const UnsavedChangesContext = createContext<UnsavedChangesApi>(passThrough);

export function useUnsavedChangesApi(): UnsavedChangesApi {
  return useContext(UnsavedChangesContext);
}

/**
 * 画面が未保存の入力の有無を知らせる。dirty の間は、アプリの中の移動（AppLink・useGuardedRouter）・手動のログアウト・
 * 年度の切り替えで確かめ、タブを閉じる・再読み込みでは beforeunload で止める。外れたら（画面を離れたら）知らせを消す。
 *
 * @example
 * const dirty = pending.length > 0;
 * useUnsavedChanges(dirty);
 */
export function useUnsavedChanges(dirty: boolean): void {
  const id = useId();
  const { setDirty } = useUnsavedChangesApi();
  useEffect(() => {
    setDirty(id, dirty);
    return () => setDirty(id, false);
  }, [id, dirty, setDirty]);
}
