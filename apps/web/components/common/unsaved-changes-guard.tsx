'use client';

import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { LEAVE_MESSAGES, UnsavedChangesContext, useUnsavedChanges, type LeaveKind, type UnsavedChangesApi } from '@/lib/unsaved-changes';
import { ConfirmDialog } from './confirm-dialog';

export { useUnsavedChanges } from '@/lib/unsaved-changes';

/**
 * 未保存の入力の守り（画面の設計 1.4、D-33。T09a）。app/layout.tsx の Providers が1つだけ置く。
 * - 画面は `<UnsavedChangesGuard when={dirty} />` か `useUnsavedChanges(dirty)` で知らせる。
 * - アプリの中の移動（AppLink・useGuardedRouter）・手動のログアウト（useGuardedSignOut）・年度の切り替え（useGuardedSetYear）は
 *   confirmLeave で確かめる。やめればそのまま（入力も下書きも残る）。
 * - タブを閉じる・再読み込み・別のサイトへは beforeunload で止める。
 * - ブラウザの戻る・タブの破棄・アプリの切り替えは止められないので、画面が下書き（lib/drafts.ts）を置く。
 */
export function UnsavedChangesProvider({ children }: { children: React.ReactNode }) {
  const dirtyIds = useRef(new Set<string>());
  const [anyDirty, setAnyDirty] = useState(false);
  const [ask, setAsk] = useState<LeaveKind | null>(null);
  const resolverRef = useRef<((ok: boolean) => void) | null>(null);

  const setDirty = useCallback((id: string, dirty: boolean) => {
    if (dirty) dirtyIds.current.add(id);
    else dirtyIds.current.delete(id);
    setAnyDirty(dirtyIds.current.size > 0);
  }, []);

  const isDirty = useCallback(() => dirtyIds.current.size > 0, []);

  const confirmLeave = useCallback((kind: LeaveKind) => {
    if (dirtyIds.current.size === 0) return Promise.resolve(true);
    resolverRef.current?.(false); // 前の確かめが残っていれば、やめた扱いにする
    return new Promise<boolean>((resolve) => {
      resolverRef.current = resolve;
      setAsk(kind);
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
  const msg = ask ? LEAVE_MESSAGES[ask] : null;
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
        cancelLabel="やめる（入力を続ける）"
        destructive={ask === 'signOut'}
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
