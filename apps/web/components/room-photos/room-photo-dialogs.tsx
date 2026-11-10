'use client';

// 現状復帰の写真を足す・メモを直すダイアログ（04「現状復帰の写真」。T25・D-63）。
// - 足す：品目の画像と同じ写真の欄（ItemPhotoField。「撮る」「写真を選ぶ」と、注意の文「人の顔・名前・掲示物が写らないように撮って
//   ください」）とメモ（任意。0〜50 字。{n}/50）。ダイアログが開いている間（同じ写真）は photo_id を保ち、「送る」を押し直したら同じ id で
//   やり直す（B1）。写真を選び直す・閉じる・送れたら新しい id にする。
// - メモを直す：同じメモの欄。update_room_photo の memo だけ。
import { useId, useRef, useState } from 'react';
import { ItemPhotoField } from '@/components/common/item-photo-field';
import { Button } from '@/components/ui/button';
import { Dialog, DialogContent, DialogDescription, DialogHeader, DialogTitle } from '@/components/ui/dialog';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { ROOM_PHOTO_MEMO_MAX, roomPhotoMemoSchema } from '@/lib/schemas/room-photos';

/** メモの欄（{n}/50。改行は入らない〔input〕。前後の空白は送る前に除く） */
export function RoomPhotoMemoField({ value, onChange, disabled }: { value: string; onChange: (v: string) => void; disabled?: boolean }) {
  const id = useId();
  const n = [...value.trim()].length;
  return (
    <div className="space-y-1.5">
      <div className="flex items-baseline justify-between gap-2">
        <Label htmlFor={id}>メモ（なくてもよい）</Label>
        <span className={n > ROOM_PHOTO_MEMO_MAX ? 'text-xs text-destructive' : 'text-xs text-muted-foreground'} data-testid="room-photo-memo-count">
          {n}/{ROOM_PHOTO_MEMO_MAX}
        </span>
      </div>
      <Input
        id={id}
        className="h-11"
        value={value}
        disabled={disabled}
        placeholder="例：黒板の前に机 6 台"
        onChange={(e) => onChange(e.target.value.replace(/[\r\n]+/g, ' '))}
        data-testid="room-photo-memo-input"
      />
    </div>
  );
}

/** メモを確かめる（文言。よければ null） */
function memoError(memo: string): string | null {
  const r = roomPhotoMemoSchema.safeParse(memo);
  return r.success ? null : (r.error.issues[0]?.message ?? 'メモを直してください');
}

export function RoomPhotoAddDialog({
  open,
  onOpenChange,
  roomName,
  onSubmit,
}: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  roomName: string;
  /** 送った結果の文言（成功なら null。閉じる）。photoId は送り直しの id */
  onSubmit: (input: { file: File; memo: string; photoId: string }) => Promise<string | null>;
}) {
  const [file, setFile] = useState<File | null>(null);
  const [memo, setMemo] = useState('');
  const photoIdRef = useRef<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const reset = () => {
    setFile(null);
    setMemo('');
    photoIdRef.current = null;
    setError(null);
  };
  const close = () => {
    if (busy) return;
    reset();
    onOpenChange(false);
  };
  const send = async () => {
    if (!file) {
      setError('写真を撮るか、選んでください');
      return;
    }
    const m = memoError(memo);
    if (m) {
      setError(m);
      return;
    }
    setBusy(true);
    setError(null);
    try {
      photoIdRef.current ??= crypto.randomUUID();
      const message = await onSubmit({ file, memo: memo.trim(), photoId: photoIdRef.current });
      if (message) {
        setError(message);
        return;
      }
      reset();
      onOpenChange(false);
    } finally {
      setBusy(false);
    }
  };
  return (
    <Dialog open={open} onOpenChange={(o) => (o ? onOpenChange(true) : close())}>
      <DialogContent data-testid="room-photo-add-dialog" className="max-h-[90vh] overflow-y-auto">
        <DialogHeader>
          <DialogTitle>写真を足す（{roomName}）</DialogTitle>
          <DialogDescription>写真は縮めてから送ります（位置情報などは残りません）。</DialogDescription>
        </DialogHeader>
        <ItemPhotoField
          file={file}
          disabled={busy}
          label="写真"
          onChange={(f) => {
            setFile(f);
            // 写真を選び直したら新しい id（同じ写真の送り直しだけ同じ id）
            photoIdRef.current = null;
            setError(null);
          }}
        />
        <RoomPhotoMemoField value={memo} onChange={setMemo} disabled={busy} />
        {error ? (
          <p role="alert" className="text-sm text-destructive">
            {error}
          </p>
        ) : null}
        <Button type="button" className="h-11 w-full" disabled={busy || !file} onClick={() => void send()} data-testid="room-photo-submit">
          {busy ? '送っています…' : '送る'}
        </Button>
      </DialogContent>
    </Dialog>
  );
}

export function RoomPhotoMemoDialog({
  open,
  onOpenChange,
  initial,
  onSubmit,
}: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  initial: string;
  onSubmit: (memo: string) => Promise<string | null>;
}) {
  const [memo, setMemo] = useState(initial);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const save = async () => {
    const m = memoError(memo);
    if (m) {
      setError(m);
      return;
    }
    setBusy(true);
    setError(null);
    try {
      const message = await onSubmit(memo.trim());
      if (message) setError(message);
      else onOpenChange(false);
    } finally {
      setBusy(false);
    }
  };
  return (
    <Dialog open={open} onOpenChange={(o) => !busy && onOpenChange(o)}>
      <DialogContent data-testid="room-photo-memo-dialog">
        <DialogHeader>
          <DialogTitle>メモを直す</DialogTitle>
          <DialogDescription className="sr-only">写真のメモ</DialogDescription>
        </DialogHeader>
        <RoomPhotoMemoField value={memo} onChange={setMemo} disabled={busy} />
        {error ? (
          <p role="alert" className="text-sm text-destructive">
            {error}
          </p>
        ) : null}
        <Button type="button" className="h-11 w-full" disabled={busy} onClick={() => void save()}>
          {busy ? '保存しています…' : '保存する'}
        </Button>
      </DialogContent>
    </Dialog>
  );
}
