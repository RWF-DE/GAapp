'use client';

// 品目の写真の欄（04「在庫入力」の「新しく登録」・「写真を足す」、「マスタ設定」の品目のタブの「画像を足す」「画像を替える」。T23・D-61）。
// ボタンは2つ：「撮る」は `<input type="file" accept="image/*" capture="environment">` でスマホのカメラを開き、「写真を選ぶ」は capture
// なしの input で撮ってある写真・ファイルを選ぶ（iOS の Safari・Android の Chrome は capture があるとカメラだけを開くため。2026-11-10 の
// レビュー）。ボタンと写真の「外す」は 44px 以上（h-11）。注意の文
// 「人の顔・名前・掲示物が写らないように撮ってください」を出す。選んだ写真は送る前に作り直す（lib/item-images/image.ts。EXIF は残らない）。
// 選んだ写真の見本は object URL で出し、外したとき・閉じたときに外す（どこにも残さない。ファイルの名前は出さない）。
import { Camera, ImageIcon } from 'lucide-react';
import { useEffect, useId, useMemo, useRef, useState } from 'react';
import { Button } from '@/components/ui/button';
import { Dialog, DialogContent, DialogDescription, DialogHeader, DialogTitle } from '@/components/ui/dialog';
import { Label } from '@/components/ui/label';

/** 撮るときの注意（04） */
export const ITEM_PHOTO_NOTE = '人の顔・名前・掲示物が写らないように撮ってください';

export function ItemPhotoField({
  file,
  onChange,
  disabled,
  label = '写真（なくてもよい）',
}: {
  file: File | null;
  onChange: (file: File | null) => void;
  disabled?: boolean;
  label?: string;
}) {
  const labelId = useId();
  const noteId = useId();
  const cameraRef = useRef<HTMLInputElement>(null);
  const inputRef = useRef<HTMLInputElement>(null);
  // 見本の object URL（選び直した・外した・閉じたときに外す）
  const preview = useMemo(() => (file && typeof URL.createObjectURL === 'function' ? URL.createObjectURL(file) : null), [file]);
  useEffect(
    () => () => {
      if (preview) URL.revokeObjectURL(preview);
    },
    [preview],
  );

  return (
    <div className="space-y-2" data-testid="item-photo-field">
      <Label id={labelId}>{label}</Label>
      <p id={noteId} className="text-xs text-amber-800">
        {ITEM_PHOTO_NOTE}
      </p>
      {(
        [
          ['camera', cameraRef, true],
          ['input', inputRef, false],
        ] as const
      ).map(([kind, ref, capture]) => (
        <input
          key={kind}
          ref={ref}
          type="file"
          accept="image/*"
          {...(capture ? { capture: 'environment' as const } : {})}
          className="sr-only"
          tabIndex={-1}
          aria-hidden
          disabled={disabled}
          data-testid={kind === 'camera' ? 'item-photo-camera' : 'item-photo-input'}
          onChange={(e) => {
            onChange(e.target.files?.[0] ?? null);
            // 同じ写真を選び直せるように空にする
            e.target.value = '';
          }}
        />
      ))}
      {file ? (
        <div className="flex items-center gap-3">
          {preview ? (
            // eslint-disable-next-line @next/next/no-img-element
            <img src={preview} alt="選んだ写真" className="size-16 rounded-md border object-cover" data-testid="item-photo-preview" />
          ) : null}
          <span className="text-sm">写真を選びました</span>
          <Button type="button" variant="ghost" className="h-11" disabled={disabled} onClick={() => onChange(null)}>
            外す
          </Button>
        </div>
      ) : null}
      <div className="grid grid-cols-2 gap-2" role="group" aria-labelledby={labelId} aria-describedby={noteId}>
        <Button type="button" variant="outline" className="h-11 w-full" disabled={disabled} onClick={() => cameraRef.current?.click()}>
          <Camera aria-hidden />
          {file ? '撮り直す' : '撮る'}
        </Button>
        <Button type="button" variant="outline" className="h-11 w-full" disabled={disabled} onClick={() => inputRef.current?.click()}>
          <ImageIcon aria-hidden />
          {file ? '選び直す' : '写真を選ぶ'}
        </Button>
      </div>
    </div>
  );
}

/**
 * 写真を足す・替えるダイアログ（在庫入力の行のメニューと、マスタ設定の品目のタブ）。onSubmit は送った結果の文言（成功なら null。閉じる）。
 */
export function ItemPhotoDialog({
  open,
  onOpenChange,
  title,
  description,
  onSubmit,
}: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  title: string;
  description?: string;
  /** imageId は送り直しの id（開いている間、同じ写真なら同じ。選び直す・閉じる・送れたら新しくする。04「品目の画像の共通の部品」） */
  onSubmit: (file: File, imageId: string) => Promise<string | null>;
}) {
  const [file, setFile] = useState<File | null>(null);
  const imageIdRef = useRef<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const close = () => {
    if (busy) return;
    setFile(null);
    imageIdRef.current = null;
    setError(null);
    onOpenChange(false);
  };
  const send = async () => {
    if (!file) {
      setError('写真を撮るか、選んでください');
      return;
    }
    setBusy(true);
    setError(null);
    try {
      imageIdRef.current ??= crypto.randomUUID();
      const message = await onSubmit(file, imageIdRef.current);
      if (message) {
        setError(message);
        return;
      }
      setFile(null);
      imageIdRef.current = null;
      onOpenChange(false);
    } finally {
      setBusy(false);
    }
  };
  return (
    <Dialog open={open} onOpenChange={(o) => (o ? onOpenChange(true) : close())}>
      <DialogContent data-testid="item-photo-dialog" className="max-h-[90vh] overflow-y-auto">
        <DialogHeader>
          <DialogTitle>{title}</DialogTitle>
          <DialogDescription>{description ?? '写真は縮めてから送ります（位置情報などは残りません）。'}</DialogDescription>
        </DialogHeader>
        <ItemPhotoField
          file={file}
          disabled={busy}
          label="写真"
          onChange={(f) => {
            setFile(f);
            imageIdRef.current = null;
            setError(null);
          }}
        />
        {error ? (
          <p role="alert" className="text-sm text-destructive">
            {error}
          </p>
        ) : null}
        <Button type="button" className="h-11 w-full" disabled={busy || !file} onClick={() => void send()} data-testid="item-photo-submit">
          {busy ? '送っています…' : '送る'}
        </Button>
      </DialogContent>
    </Dialog>
  );
}
