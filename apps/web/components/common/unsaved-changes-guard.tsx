'use client';

import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import {
  LEAVE_CANCEL_LABEL,
  leaveMessageFor,
  UnsavedChangesContext,
  useUnsavedChanges,
  type LeaveKind,
  type LeaveMessage,
  type LeaveMessages,
  type UnsavedChangesApi,
} from '@/lib/unsaved-changes';
import { ConfirmDialog } from './confirm-dialog';

export { useUnsavedChanges } from '@/lib/unsaved-changes';

/**
 * 未保存の入力の守り（画面の設計 1.4、D-33。T09a）。app/layout.tsx の Providers が1つだけ置く。
 * - 画面は `<UnsavedChangesGuard when={dirty} />` か `useUnsavedChanges(dirty)` で知らせる。
 * - アプリの中の移動（AppLink・useGuardedRouter）・手動のログアウト（useGuardedSignOut）・年度の切り替え（useGuardedSetYear）は
 *   confirmLeave で確かめる。やめればそのまま（入力も下書きも残る）。
 * - 確かめの文は既定では LEAVE_MESSAGES（下書きに残る）。知らせた部品が文を渡していれば（useUnsavedChanges の messages。下書きに残らない
 *   もの）、渡した最初のものを出す（2026-11-03。D-52 の T19 の直し・2。渡さない画面は今までどおり）。
 * - タブを閉じる・再読み込み・別のサイトへは beforeunload で止める。
 * - ブラウザの戻る・タブの破棄・アプリの切り替えは止められないので、画面が下書き（lib/drafts.ts）を置く。
 */
export function UnsavedChangesProvider({ children }: { children: React.ReactNode }) {
  // 知らせている部品（id → 渡した確かめの文。知らせた順）
  const dirtyIds = useRef(new Map<string, LeaveMessages | undefined>());
  const [anyDirty, setAnyDirty] = useState(false);
  const [ask, setAsk] = useState<{ kind: LeaveKind; message: Required<LeaveMessage> } | null>(null);
  const resolverRef = useRef<((ok: boolean) => void) | null>(null);

  const setDirty = useCallback((id: string, dirty: boolean, messages?: LeaveMessages) => {
    if (dirty) dirtyIds.current.set(id, messages);
    else dirtyIds.current.delete(id);
    setAnyDirty(dirtyIds.current.size > 0);
  }, []);

  const isDirty = useCallback(() => dirtyIds.current.size > 0, []);

  const confirmLeave = useCallback((kind: LeaveKind) => {
    if (dirtyIds.current.size === 0) return Promise.resolve(true);
    resolverRef.current?.(false); // 前の確かめが残っていれば、やめた扱いにする
    // 文は確かめたときの知らせで決める（開いている間に知らせが変わっても、出した文のまま）
    const message = leaveMessageFor(kind, dirtyIds.current.values());
    return new Promise<boolean>((resolve) => {
      resolverRef.current = resolve;
      setAsk({ kind, message });
    });
  }, []);

  useEffect(() => {
    if (!anyDirty) return;
    const onBeforeUnload = (e: BeforeUnloadEvent) => {
      e.preventDefault();
      // 古いブラウザ向け（文言は表示されない）
      e.returnValue = '';
    };
    window.addEventListener('beforeunload', onBeforeUnload);
    return () => window.removeEventListener('beforeunload', onBeforeUnload);
  }, [anyDirty]);

  const api = useMemo<UnsavedChangesApi>(() => ({ confirmLeave, isDirty, setDirty }), [confirmLeave, isDirty, setDirty]);
  const msg = ask?.message ?? null;
  const answer = (ok: boolean) => {
    const resolve = resolverRef.current;
    resolverRef.current = null;
    resolve?.(ok);
    setAsk(null);
  };

  return (
    <UnsavedChangesContext.Provider value={api}>
      {children}
      <ConfirmDialog
        open={ask !== null}
        onOpenChange={(open) => {
          if (!open) answer(false);
        }}
        title={msg?.title ?? ''}
        description={msg?.description}
        confirmLabel={msg?.confirm ?? 'OK'}
        cancelLabel={msg?.cancel ?? LEAVE_CANCEL_LABEL}
        destructive={ask?.kind === 'signOut'}
        onConfirm={() => answer(true)}
      />
    </UnsavedChangesContext.Provider>
  );
}

/**
 * 未保存の入力があることを知らせる部品（何も描かない）。
 *
 * @example
 * <UnsavedChangesGuard when={pending.length > 0} />
 */
export function UnsavedChangesGuard({ when }: { when: boolean }) {
  useUnsavedChanges(when);
  return null;
}
