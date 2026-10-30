'use client';

// 部屋に貼る QR のカード（画面の設計 3.4・6 章。T10）。A4 に 2列×4段。場所名を大きく、建物・階、QR、URL の文字、
// 「在庫入力（電波祭 総務）」、アプリの中のブラウザでは Google でログインできないことの案内。
// QR は uqr の renderSVG（文字列）を dangerouslySetInnerHTML で出す。入れるのは uqr が作る SVG だけで、利用者の文字列は入れない
// （URL は部屋の id〔uuid〕と origin・basePath から作る。部屋の id は秘密ではなく、開くにはログインが要る）。
import { useMemo } from 'react';
import { renderSVG } from 'uqr';
import type { RoomRow } from '@/lib/db/types';
import { placeOf, stockUrl } from '@/lib/data/stocks';

/** 1枚の A4 に並べるカードの数（2列×4段） */
export const CARDS_PER_PAGE = 8;

export const QR_NOTICE = 'スマホのカメラで読み、Safari か Chrome で開いてください（LINE などのアプリの中で開くと Google でログインできません）';

export function QrCard({ room, url }: { room: Pick<RoomRow, 'id' | 'name' | 'building' | 'kind' | 'floor'>; url: string }) {
  const svg = useMemo(() => renderSVG(url, { border: 2, ecc: 'M' }), [url]);
  return (
    <article
      data-testid="qr-card"
      data-room-id={room.id}
      className="flex h-[66mm] break-inside-avoid flex-col items-center justify-between gap-1 rounded-md border border-dashed border-zinc-400 p-3 text-center print:rounded-none"
    >
      <div className="w-full">
        <h2 className="truncate text-2xl leading-tight font-bold">{room.name}</h2>
        <p className="text-sm text-zinc-600">{placeOf(room)}</p>
      </div>
      <div className="size-[32mm] shrink-0 [&_svg]:size-full" aria-label={`${room.name}の在庫入力の QR コード`} role="img" dangerouslySetInnerHTML={{ __html: svg }} />
      <div className="w-full space-y-0.5">
        <p className="text-xs font-semibold">在庫入力（電波祭 総務）</p>
        <p data-testid="qr-url" className="font-mono text-[9px] leading-tight break-all text-zinc-600">
          {url}
        </p>
        <p className="text-[9px] leading-tight text-zinc-600">{QR_NOTICE}</p>
      </div>
    </article>
  );
}

/** A4 ごとに8枚ずつのカード（印刷で改ページ）。origin が空（プリレンダーの間）なら何も出さない */
export function QrCards({
  rooms,
  origin,
  basePath,
}: {
  rooms: readonly Pick<RoomRow, 'id' | 'name' | 'building' | 'kind' | 'floor'>[];
  origin: string;
  basePath?: string;
}) {
  if (!origin) return null;
  const pages: (typeof rooms)[] = [];
  for (let i = 0; i < rooms.length; i += CARDS_PER_PAGE) pages.push(rooms.slice(i, i + CARDS_PER_PAGE));
  return (
    <div data-testid="qr-pages" className="space-y-6 print:space-y-0">
      {pages.map((page, i) => (
        <div key={i} className="grid grid-cols-2 gap-3 print:gap-[4mm] print:break-after-page print:last:break-after-auto">
          {page.map((room) => (
            <QrCard key={room.id} room={room} url={stockUrl(room.id, origin, basePath)} />
          ))}
        </div>
      ))}
    </div>
  );
}
