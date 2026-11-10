'use client';

// 品目の画像（04「品目の画像の共通の部品」。T23・D-61）。在庫入力・その他の選択・申請・マスタ設定の品目のタブで使う。
// - 画像のない物（path が null）と、URL を作れなかった・読み込みに失敗した物は、名前の頭文字のカード（失敗しても操作は止めない）。
// - URL を作っている間は、同じ大きさの枠（読み込み中）。
// - zoomable なら押すと大きく出す（ダイアログ。閉じるボタンと Esc で閉じる）。
// URL は呼ぶ側が一覧でまとめて作る（lib/data/item-images.ts の useItemImageUrls）。この部品は URL を受け取って出すだけで、
// URL を下書き・ログ・localStorage に残さない。代替の文字は品目の名前。
import { useState } from 'react';
import { Dialog, DialogContent, DialogDescription, DialogHeader, DialogTitle } from '@/components/ui/dialog';
import type { ItemImageUrls } from '@/lib/data/item-images';
import { cn } from '@/lib/utils';

/** 名前の頭文字（前後の空白を除いた最初の1文字。空なら「？」） */
export function initialOf(name: string): string {
  return Array.from(name.trim())[0] ?? '？';
}

const SIZE_CLASS = {
  sm: 'size-12', // 48px（一覧の行）
  lg: 'size-20', // 80px（その他の選択のカード）
} as const;

export function ItemImage({
  name,
  path,
  images,
  size = 'sm',
  zoomable = false,
  decorative = false,
  className,
}: {
  name: string;
  /** 行の image_path（null・undefined なら画像なし） */
  path: string | null | undefined;
  images: ItemImageUrls;
  size?: keyof typeof SIZE_CLASS;
  /** 押すと大きく出す */
  zoomable?: boolean;
  /** 隣に名前の文字があるカード（代替の文字を空にして、読み上げで名前を二重にしない） */
  decorative?: boolean;
  className?: string;
}) {
  const url = path ? images.urls.get(path) : undefined;
  // 読み込みに失敗した URL（URL が変われば〔作り直した〕もう一度出す）
  const [failedUrl, setFailedUrl] = useState<string | null>(null);
  const [loadedUrl, setLoadedUrl] = useState<string | null>(null);
  const [open, setOpen] = useState(false);
  const box = cn('relative shrink-0 overflow-hidden rounded-md border bg-muted', SIZE_CLASS[size], className);

  if (!path || (!url && !images.pending) || (url && failedUrl === url)) {
    return (
      // 頭文字は CSS の content で出す（行・カードの文字〔textContent〕と読み上げに名前を二重に入れない）
      <span
        data-testid="item-image"
        data-state={path ? 'failed' : 'none'}
        data-initial={initialOf(name)}
        aria-hidden
        className={cn(
          box,
          'flex items-center justify-center font-semibold text-muted-foreground before:content-[attr(data-initial)]',
          size === 'lg' ? 'text-2xl' : 'text-lg',
        )}
      />
    );
  }
  if (!url) {
    return <span data-testid="item-image" data-state="loading" aria-hidden className={cn(box, 'animate-pulse')} />;
  }
  const img = (
    // 署名つき URL の画像（Next の Image は静的書き出しで使わない）
    // eslint-disable-next-line @next/next/no-img-element
    <img
      src={url}
      alt={decorative ? '' : name}
      loading="lazy"
      decoding="async"
      className="size-full object-cover"
      onLoad={() => setLoadedUrl(url)}
      onError={() => {
        // 10 分を過ぎた URL なら作り直す（作り直す間は今の URL のまま。作り直せば URL が変わる）
        if (!images.reportError()) setFailedUrl(url);
      }}
    />
  );
  const state = loadedUrl === url ? 'loaded' : 'loading';
  if (!zoomable) {
    return (
      <span data-testid="item-image" data-state={state} className={box}>
        {img}
      </span>
    );
  }
  return (
    <>
      <button
        type="button"
        data-testid="item-image"
        data-state={state}
        className={cn(box, 'cursor-zoom-in focus-visible:ring-2 focus-visible:ring-ring focus-visible:outline-none')}
        aria-label={`${name}の画像を大きく見る`}
        onClick={() => setOpen(true)}
      >
        {img}
      </button>
      <Dialog open={open} onOpenChange={setOpen}>
        <DialogContent data-testid="item-image-large" className="max-h-[90vh] overflow-y-auto">
          <DialogHeader>
            <DialogTitle>{name}</DialogTitle>
            <DialogDescription className="sr-only">{name}の画像</DialogDescription>
          </DialogHeader>
          {/* eslint-disable-next-line @next/next/no-img-element */}
          <img src={url} alt={name} className="mx-auto max-h-[70vh] w-auto max-w-full rounded-md object-contain" />
        </DialogContent>
      </Dialog>
    </>
  );
}
