'use client';

import { useLayoutEffect, useRef, useState } from 'react';
import {
  AlertDialog,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
} from '@/components/ui/alert-dialog';
import { Button } from '@/components/ui/button';

export interface ConfirmDialogProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  title: string;
  description?: React.ReactNode;
  /** 説明の下に置くもの（件数の一覧・チェックなど） */
  children?: React.ReactNode;
  confirmLabel?: string;
  cancelLabel?: string;
  /** 破壊的な操作（削除・終了など）は赤いボタン */
  destructive?: boolean;
  /**
   * 確定のボタンを押したとき。Promise を返すと、終わるまで確定・やめるのボタンを押せず「処理中…」を出す（二重に送らない。1.4）。
   * 終われば閉じる。例外を投げたら開いたまま（エラーの表示は呼ぶ側）。
   */
  onConfirm: () => void | Promise<void>;
  /** 外の送信中（useMutation の isPending）。真の間は確定のボタンを押せない */
  pending?: boolean;
  pendingLabel?: string;
  /** 確定のボタンを押せない（前提を満たさない） */
  confirmDisabled?: boolean;
}

/**
 * 確認のダイアログ（画面の設計 1.4。T09a）。送信中は確定のボタンを押せない。
 *
 * @example
 * <ConfirmDialog open={open} onOpenChange={setOpen} title="団体を削除しますか" destructive confirmLabel="削除する"
 *   onConfirm={() => m.mutateAsync()} pending={m.isPending} />
 */
export function ConfirmDialog({
  open,
  onOpenChange,
  title,
  description,
  children,
  confirmLabel = 'OK',
  cancelLabel = 'やめる',
  destructive = false,
  onConfirm,
  pending = false,
  pendingLabel = '処理中…',
  confirmDisabled = false,
}: ConfirmDialogProps) {
  const [running, setRunning] = useState(false);
  const busy = pending || running;
  // 開いた元の要素（閉じたらそこへフォーカスを戻す）。AlertDialogTrigger を使わないので、Radix は戻し先を知らず body に落とす。
  // レイアウトの effect で覚える（Radix がダイアログの中へフォーカスを移すのは、その後の effect）
  const returnFocusRef = useRef<HTMLElement | null>(null);
  useLayoutEffect(() => {
    if (!open) return;
    const active = document.activeElement;
    returnFocusRef.current = active instanceof HTMLElement && active !== document.body ? active : null;
  }, [open]);

  const confirm = async () => {
    if (busy) return;
    setRunning(true);
    try {
      await onConfirm();
      onOpenChange(false);
    } catch {
      // 開いたまま（呼ぶ側がエラーを出す）
    } finally {
      setRunning(false);
    }
  };

  return (
    <AlertDialog open={open} onOpenChange={(o) => (busy ? undefined : onOpenChange(o))}>
      <AlertDialogContent
        onCloseAutoFocus={(e) => {
          e.preventDefault();
          const el = returnFocusRef.current;
          returnFocusRef.current = null;
          // 開いた元がもうなければ（メニューの項目など）戻さない
          if (el?.isConnected) el.focus();
        }}
      >
        <AlertDialogHeader>
          <AlertDialogTitle>{title}</AlertDialogTitle>
          {description ? <AlertDialogDescription>{description}</AlertDialogDescription> : null}
        </AlertDialogHeader>
        {children}
        <AlertDialogFooter>
          {/* AlertDialogCancel にすると、開いたときに Radix がここへフォーカスを移す（開いたボタンに残さない。Enter で開き直さない） */}
          <AlertDialogCancel disabled={busy}>{cancelLabel}</AlertDialogCancel>
          <Button
            variant={destructive ? 'destructive' : 'default'}
            disabled={busy || confirmDisabled}
            aria-busy={busy || undefined}
            onClick={() => void confirm()}
          >
            {busy ? pendingLabel : confirmLabel}
          </Button>
        </AlertDialogFooter>
      </AlertDialogContent>
    </AlertDialog>
  );
}
