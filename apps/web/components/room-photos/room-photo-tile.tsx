'use client';

// 現状復帰の写真の1枚（04「現状復帰の写真」。T25・D-63）。品目の画像の部品（components/common/item-image.tsx）と同じ考え方で、
// URL は一覧でまとめて作ったもの（useItemImageUrls。bucket room-photos）を受け取って出すだけ（URL を下書き・ログ・localStorage に残さない）。
// - 縦横比を保った縮小（4:3 の枠の中に object-contain）。読み込み中は同じ大きさの枠、失敗は「写真を読み込めませんでした」の枠
//   （10 分を過ぎた URL なら作り直す。画面の操作は止めない）。
// - 押すと大きく出す（閉じるボタンと Esc で閉じる）。メモと、総務には足した日時（Asia/Tokyo）。
// - 下にメモ（なければ出さない）。menu は写真ごとのメニュー（総務・書ける年度だけ）。
import { useState } from 'react';
import { TokyoTime } from '@/components/common/tokyo-time';
import { Dialog, DialogContent, DialogDescription, DialogHeader, DialogTitle } from '@/components/ui/dialog';
import type { ItemImageUrls } from '@/lib/data/item-images';
import type { RoomPhotoRow } from '@/lib/data/room-photos';
import { cn } from '@/lib/utils';

export const ROOM_PHOTO_LOAD_FAILED = '写真を読み込めませんでした';

export function RoomPhotoTile({
  photo,
  label,
  images,
  showCreatedAt,
  menu,
}: {
  photo: Pick<RoomPhotoRow, 'id' | 'object_path' | 'memo' | 'created_at'>;
  /** 代替の文字（「1年1組 の今年の写真 1」など。メモがあれば添える） */
  label: string;
  images: ItemImageUrls;
  /** 大きく出したときに足した日時を出す（総務） */
  showCreatedAt: boolean;
  menu?: React.ReactNode;
}) {
  const url = images.urls.get(photo.object_path);
  const [failedUrl, setFailedUrl] = useState<string | null>(null);
  const [loadedUrl, setLoadedUrl] = useState<string | null>(null);
  const [open, setOpen] = useState(false);
  const frame = 'relative flex aspect-[4/3] w-full items-center justify-center overflow-hidden rounded-md border bg-muted';
  const alt = photo.memo ? `${label}（${photo.memo}）` : label;

  let body: React.ReactNode;
  if ((!url && !images.pending) || (url && failedUrl === url)) {
    body = (
      <div data-testid="room-photo-image" data-state="failed" className={cn(frame, 'p-2 text-center text-xs text-muted-foreground')}>
        {ROOM_PHOTO_LOAD_FAILED}
      </div>
    );
  } else if (!url) {
    body = <div data-testid="room-photo-image" data-state="loading" aria-hidden className={cn(frame, 'animate-pulse')} />;
  } else {
    body = (
      <button
        type="button"
        data-testid="room-photo-image"
        data-state={loadedUrl === url ? 'loaded' : 'loading'}
        className={cn(frame, 'cursor-zoom-in focus-visible:ring-2 focus-visible:ring-ring focus-visible:outline-none')}
        aria-label={`${alt}を大きく見る`}
        onClick={() => setOpen(true)}
      >
        {/* 署名つき URL の画像（Next の Image は静的書き出しで使わない） */}
        {/* eslint-disable-next-line @next/next/no-img-element */}
        <img
          src={url}
          alt={alt}
          loading="lazy"
          decoding="async"
          className="size-full object-contain"
          onLoad={() => setLoadedUrl(url)}
          onError={() => {
            if (!images.reportError()) setFailedUrl(url);
          }}
        />
      </button>
    );
  }

  return (
    <li className="space-y-1" data-testid="room-photo" data-photo-id={photo.id}>
      {body}
      {photo.memo || menu ? (
        <div className="flex items-start gap-1">
          {photo.memo ? (
            <p className="min-w-0 flex-1 text-sm wrap-anywhere" data-testid="room-photo-memo">
              {photo.memo}
            </p>
          ) : (
            <span className="flex-1" />
          )}
          {menu}
        </div>
      ) : null}
      {url ? (
        <Dialog open={open} onOpenChange={setOpen}>
          <DialogContent data-testid="room-photo-large" className="max-h-[90vh] overflow-y-auto sm:max-w-3xl">
            <DialogHeader>
              <DialogTitle>{label}</DialogTitle>
              <DialogDescription className={photo.memo ? undefined : 'sr-only'}>{photo.memo || '写真'}</DialogDescription>
            </DialogHeader>
            {/* eslint-disable-next-line @next/next/no-img-element */}
            <img src={url} alt={alt} className="mx-auto max-h-[70vh] w-auto max-w-full rounded-md object-contain" />
            {showCreatedAt ? (
              <p className="text-xs text-muted-foreground" data-testid="room-photo-created-at">
                足した日時：<TokyoTime value={photo.created_at} />
              </p>
            ) : null}
          </DialogContent>
        </Dialog>
      ) : null}
    </li>
  );
}
