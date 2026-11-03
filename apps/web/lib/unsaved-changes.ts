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

/** 確かめの「やめる」のボタン（既定） */
export const LEAVE_CANCEL_LABEL = 'やめる（入力を続ける）';

/**
 * 画面が渡す確かめの文（2026-11-03。D-52 の T19 の直し・2。04「共通レイアウト」の確かめの文）。下書きに残らないもの（提出物のアップロード中）が、
 * 既定の文（入力は下書きに残り…戻せます）を出さないために渡す。cancel を省けば LEAVE_CANCEL_LABEL。
 */
export interface LeaveMessage {
  title: string;
  description: string;
  /** 続ける（移る・切り替える・ログアウトする）のボタン */
  confirm: string;
  /** やめるのボタン */
  cancel?: string;
}

/** 確かめの種類ごとの、画面が渡す文（渡さない種類は既定の文） */
export type LeaveMessages = Partial<Record<LeaveKind, LeaveMessage>>;

/**
 * 確かめに出す文：知らせている部品（sources。知らせた順）のうち、その種類の文を渡した最初のもの。なければ既定（LEAVE_MESSAGES と
 * LEAVE_CANCEL_LABEL）。
 *
 * @example
 * leaveMessageFor('navigate', [undefined, { navigate: { title: 'アップロード中です', description: '…', confirm: '移る' } }])
 * // { title: 'アップロード中です', description: '…', confirm: '移る', cancel: 'やめる（入力を続ける）' }
 */
export function leaveMessageFor(kind: LeaveKind, sources: Iterable<LeaveMessages | undefined>): Required<LeaveMessage> {
  for (const s of sources) {
    const m = s?.[kind];
    if (m) return { title: m.title, description: m.description, confirm: m.confirm, cancel: m.cancel ?? LEAVE_CANCEL_LABEL };
  }
  return { ...LEAVE_MESSAGES[kind], cancel: LEAVE_CANCEL_LABEL };
}

export interface UnsavedChangesApi {
  /** 未保存の入力があれば確かめる。続けてよければ true（なければ確かめずに true） */
  confirmLeave: (kind: LeaveKind) => Promise<boolean>;
  /** 未保存の入力があるか */
  isDirty: () => boolean;
  /**
   * 未保存の入力の有無を知らせる（UnsavedChangesGuard・useUnsavedChanges が使う）。messages を渡すと、知らせている間の確かめはその文に
   * なる（省けば既定の文。D-52 の T19 の直し・2）
   */
  setDirty: (id: string, dirty: boolean, messages?: LeaveMessages) => void;
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
 * messages（任意）を渡すと、その間の確かめはその文になる（下書きに残らないもの。描くたびに作り直さない定数を渡す）。
 *
 * @example
 * const dirty = pending.length > 0;
 * useUnsavedChanges(dirty);
 * useUnsavedChanges(uploading, UPLOADING_LEAVE_MESSAGES); // 「アップロード中です。離れると、残りのファイルは送られません」
 */
export function useUnsavedChanges(dirty: boolean, messages?: LeaveMessages): void {
  const id = useId();
  const { setDirty } = useUnsavedChangesApi();
  useEffect(() => {
    setDirty(id, dirty, messages);
    return () => setDirty(id, false);
  }, [id, dirty, messages, setDirty]);
}
