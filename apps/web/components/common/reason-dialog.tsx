'use client';

import { useId, useState } from 'react';
import { Button } from '@/components/ui/button';
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from '@/components/ui/dialog';
import { Label } from '@/components/ui/label';
import { Textarea } from '@/components/ui/textarea';
import { REASON_MAX } from '@/lib/schemas/common';

export interface ReasonDialogProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  title: string;
  description?: React.ReactNode;
  /** 理由が必須か（確定・確定の解除・締切後の申請の変更など）。既定 true */
  required?: boolean;
  /** よく使う理由のボタン（「数え直し」「団体の希望」など） */
  presets?: readonly string[];
  /** 理由の欄の上に置くもの（warning の一覧と「確認しました」のチェックなど） */
  children?: React.ReactNode;
  confirmLabel?: string;
  pendingLabel?: string;
  destructive?: boolean;
  /** 確定のボタンを押せない（前提を満たさない。チェックが入っていないなど） */
  confirmDisabled?: boolean;
  /** 外の送信中（useMutation の isPending） */
  pending?: boolean;
  /** サーバーから返った理由の誤り（reason_required など）を欄の下に出す */
  error?: string | null;
  /**
   * 送る。理由は前後の空白を除き、空なら null（必須でないとき）。Promise を返すと終わるまで押せない。
   * 終われば閉じる。例外を投げたら開いたまま（理由も残す）。
   */
  onSubmit: (reason: string | null) => void | Promise<void>;
}

/** 理由の入力の確かめ（必須なら1字以上、500 字まで。DB の set_reason と同じ上限） */
export function reasonError(value: string, required: boolean): string | null {
  const v = value.trim();
  if (required && v.length === 0) return '理由を入れてください';
  if (v.length > REASON_MAX) return `理由は${REASON_MAX}字以内で入れてください`;
  return null;
}

/**
 * 理由を入れて送るダイアログ（画面の設計 1.4。T09a）。送信中は確定のボタンを押せない。
 *
 * @example
 * <ReasonDialog open={open} onOpenChange={setOpen} title="確定を解除する" presets={['数え直し']}
 *   onSubmit={(reason) => m.mutateAsync({ p_reason: reason })} pending={m.isPending} error={reasonFieldError} />
 */
export function ReasonDialog(props: ReasonDialogProps) {
  const { open, onOpenChange, pending = false } = props;
  const [running, setRunning] = useState(false);
  const busy = pending || running;
  return (
    <Dialog open={open} onOpenChange={(o) => (busy ? undefined : onOpenChange(o))}>
      <DialogContent showCloseButton={!busy}>
        {/* 閉じると中身が外れるので、開き直すと理由は空に戻る */}
        <ReasonForm {...props} busy={busy} setRunning={setRunning} />
      </DialogContent>
    </Dialog>
  );
}

function ReasonForm({
  onOpenChange,
  title,
  description,
  required = true,
  presets,
  children,
  confirmLabel = '保存する',
  pendingLabel = '保存中…',
  destructive = false,
  confirmDisabled = false,
  error,
  onSubmit,
  busy,
  setRunning,
}: ReasonDialogProps & { busy: boolean; setRunning: (v: boolean) => void }) {
  const id = useId();
  const [value, setValue] = useState('');
  const [touched, setTouched] = useState(false);

  const localError = reasonError(value, required);
  const shownError = (touched ? localError : null) ?? error ?? null;

  const submit = async () => {
    setTouched(true);
    if (busy || localError || confirmDisabled) return;
    setRunning(true);
    try {
      const v = value.trim();
      await onSubmit(v.length > 0 ? v : null);
      setRunning(false);
      onOpenChange(false);
    } catch {
      // 開いたまま（理由も残す）
      setRunning(false);
    }
  };

  return (
    <>
      <DialogHeader>
        <DialogTitle>{title}</DialogTitle>
        {description ? <DialogDescription>{description}</DialogDescription> : null}
      </DialogHeader>
      {children}
      <form
        className="grid gap-2"
        onSubmit={(e) => {
          e.preventDefault();
          void submit();
        }}
      >
        <Label htmlFor={`${id}-reason`}>理由{required ? '（必須）' : '（任意）'}</Label>
        {presets && presets.length > 0 ? (
          <div className="flex flex-wrap gap-2">
            {presets.map((p) => (
              <Button key={p} type="button" variant="outline" size="xs" disabled={busy} onClick={() => setValue(p)}>
                {p}
              </Button>
            ))}
          </div>
        ) : null}
        <Textarea
          id={`${id}-reason`}
          value={value}
          disabled={busy}
          aria-invalid={shownError ? true : undefined}
          aria-describedby={shownError ? `${id}-error` : undefined}
          onChange={(e) => setValue(e.target.value)}
          onBlur={() => setTouched(true)}
        />
        {shownError ? (
          <p id={`${id}-error`} role="alert" className="text-sm text-destructive">
            {shownError}
          </p>
        ) : null}
        <DialogFooter className="mt-2">
          <Button type="button" variant="outline" disabled={busy} onClick={() => onOpenChange(false)}>
            やめる
          </Button>
          <Button
            type="submit"
            variant={destructive ? 'destructive' : 'default'}
            disabled={busy || confirmDisabled}
            aria-busy={busy || undefined}
          >
            {busy ? pendingLabel : confirmLabel}
          </Button>
        </DialogFooter>
      </form>
    </>
  );
}
