'use client';

// 現状復帰の写真 /room-photos（04「現状復帰の写真」。T25・D-63）。
// - 開ける人：開いている年度の総務と、区分「部門」の団体の代表（部門長・副部門長。執行部）。ページの守りは RequireAudience（href）。
//   書けるのは総務だけ（終了でない年度）。部門の代表は見るだけ（書くためのボタン・欄を出さない）。データは RLS と RPC が守る。
// - `?room=` がなければ部屋の一覧（建物ごと。今年・前年の枚数。名前で絞る）、あれば部屋の写真（今年・前年）。
// - 読むもの：年度の行（prev_year_id。立場と一緒に読んだもの）、前の年度の名前（読めなければ「前年」）、場所、
//   room_photos_with_previous（一覧は null で全部の場所。数えるだけ）。写真の署名つき URL は出す写真の分を createSignedUrls で1回に
//   まとめて作る（useItemImageUrls。bucket room-photos。メモリーにだけ持つ）。
// - 書き込みの部品（作り直し・予約・upload・RPC）は押したときに動的 import（lib/data/room-photos.ts）。
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { ArrowLeft, ArrowRight, ChevronRight, EllipsisVertical, ImagePlus, Search } from 'lucide-react';
import { useSearchParams } from 'next/navigation';
import { useMemo, useState } from 'react';
import { toast } from 'sonner';
import { AppLink } from '@/components/common/app-link';
import { ConfirmDialog } from '@/components/common/confirm-dialog';
import { matchesEntity } from '@/components/common/entity-select';
import { LatestYearSwitch } from '@/components/common/latest-year';
import { PageHeader } from '@/components/common/page-header';
import { EmptyState, ErrorState, LoadingState, ReadOnlyNotice } from '@/components/states';
import { Button } from '@/components/ui/button';
import { DropdownMenu, DropdownMenuContent, DropdownMenuItem, DropdownMenuTrigger } from '@/components/ui/dropdown-menu';
import { Input } from '@/components/ui/input';
import { useAuth } from '@/lib/auth/auth-provider';
import { isSoumu } from '@/lib/auth/roles';
import { useItemImageUrls } from '@/lib/data/item-images';
import {
  countRoomPhotos,
  movePhotoChanges,
  moveRoomPhoto,
  photoCountLabel,
  photoRoomsOptions,
  removeRoomPhoto,
  ROOM_PHOTOS_BUCKET_ID,
  roomPhotosOptions,
  roomPhotosPath,
  saveRoomPhotoMemo,
  sendRoomPhoto,
  splitRoomPhotos,
  type PhotoRoom,
  type RoomPhotoRow,
  type RoomPhotoWriteResult,
} from '@/lib/data/room-photos';
import { groupByBuilding, placeOf } from '@/lib/data/stocks';
import { useYearRow } from '@/lib/data/year';
import { classifyError, messageFor } from '@/lib/errors';
import { ROOM_PHOTO_LIMIT } from '@/lib/schemas/room-photos';
import { parseRoomParam } from '@/lib/schemas/stock';
import { RoomPhotoAddDialog, RoomPhotoMemoDialog } from './room-photo-dialogs';
import { RoomPhotoTile } from './room-photo-tile';

const TITLE = '現状復帰の写真';
/** 画面の上の注意（個人情報。04） */
export const ROOM_PHOTO_AUDIENCE_NOTE = '写真は総務と執行部（各部門の部門長・副部門長）だけが見られます';
/** 終了した年度の帯（総務だけ） */
export const ROOM_PHOTO_CLOSED_NOTE = '終了した年度のため、写真は見るだけです';
/** 6 枚あるとき */
export const ROOM_PHOTO_FULL_NOTE = '1 部屋 6 枚までです。足すときは先に消してください';

interface Ctx {
  yearId: string;
  yearLabel: string;
  prevYearId: string | null;
  /** 前の年度の名前（読めなければ null。見出しは「前年」とだけ出す） */
  prevLabel: string | null;
  soumu: boolean;
  writable: boolean;
}

function Header() {
  return (
    <>
      <LatestYearSwitch />
      <PageHeader title={TITLE} description={ROOM_PHOTO_AUDIENCE_NOTE} />
    </>
  );
}

export function RoomPhotosScreen() {
  const params = useSearchParams();
  const raw = params.get('room');
  const roomId = parseRoomParam(raw);
  const { membership } = useAuth();
  const m = membership.status === 'ready' ? membership.membership : null;
  const yearId = m?.year?.id ?? null;
  const yearQ = useYearRow(yearId);
  const prevYearId = yearQ.data?.prev_year_id ?? null;
  // 前の年度の名前（部門の代表は前の年度の行を読めないことがある。そのときは「前年」）
  const prevQ = useYearRow(prevYearId);
  const roomsQ = useQuery(photoRoomsOptions());

  if (!m?.year || !yearId) return <LoadingState />;
  const failed = yearQ.isError ? yearQ : roomsQ.isError ? roomsQ : null;
  if (failed) {
    return (
      <>
        <Header />
        <ErrorState message={messageFor(classifyError(failed.error))} onRetry={() => void failed.refetch()} />
      </>
    );
  }
  if (!yearQ.data || !roomsQ.data) {
    return (
      <>
        <Header />
        <LoadingState />
      </>
    );
  }
  const soumu = isSoumu(m.role);
  const ctx: Ctx = {
    yearId,
    yearLabel: yearQ.data.label,
    prevYearId,
    prevLabel: prevQ.data?.label ?? null,
    soumu,
    writable: soumu && yearQ.data.status !== 'closed',
  };
  const rooms = roomsQ.data;

  if (raw === null || raw.trim() === '') return <RoomList ctx={ctx} rooms={rooms} />;
  const room = roomId ? rooms.find((r) => r.id === roomId) : undefined;
  if (!room) {
    return (
      <>
        <Header />
        <EmptyState
          title="この場所は見つかりません"
          description="場所の一覧にない場所です（消した場所・URL の誤りの可能性があります）。"
          action={
            <Button asChild variant="outline">
              <AppLink href={roomPhotosPath()}>一覧へ</AppLink>
            </Button>
          }
        />
      </>
    );
  }
  return <RoomDetail key={room.id} ctx={ctx} room={room} />;
}

function ClosedNotice({ ctx }: { ctx: Ctx }) {
  return ctx.soumu && !ctx.writable ? <ReadOnlyNotice className="mb-4">{ROOM_PHOTO_CLOSED_NOTE}</ReadOnlyNotice> : null;
}

// ---------------------------------------------------------------- 部屋の一覧

function RoomList({ ctx, rooms }: { ctx: Ctx; rooms: PhotoRoom[] }) {
  const photosQ = useQuery(roomPhotosOptions(ctx.yearId, null));
  const [search, setSearch] = useState('');
  const counts = useMemo(() => countRoomPhotos(photosQ.data ?? [], ctx.yearId, ctx.prevYearId), [photosQ.data, ctx.yearId, ctx.prevYearId]);
  const filtered = useMemo(
    () => rooms.filter((r) => matchesEntity({ id: r.id, name: r.name, group: placeOf(r), keywords: r.aliases }, search)),
    [rooms, search],
  );
  const groups = groupByBuilding(filtered.map((room) => ({ room })));

  let body: React.ReactNode;
  if (photosQ.isError) body = <ErrorState message={messageFor(classifyError(photosQ.error))} onRetry={() => void photosQ.refetch()} />;
  else if (!photosQ.data) body = <LoadingState />;
  else if (rooms.length === 0) body = <EmptyState title="場所がありません" description="マスタ設定の場所に登録すると出ます。" />;
  else {
    body = (
      <div className="space-y-4">
        <label className="relative block">
          <span className="sr-only">場所の名前で絞る</span>
          <Search aria-hidden className="pointer-events-none absolute top-1/2 left-3 size-4 -translate-y-1/2 text-muted-foreground" />
          <Input type="search" className="h-11 pl-9" placeholder="場所の名前で絞る" value={search} onChange={(e) => setSearch(e.target.value)} />
        </label>
        {groups.length === 0 ? (
          <EmptyState title="当てはまる場所がありません" description="別の言葉で絞ってください。" />
        ) : (
          groups.map((g) => (
            <section key={g.building} aria-label={g.building} className="space-y-2">
              <h2 className="text-sm font-semibold text-muted-foreground">{g.building}</h2>
              <ul className="divide-y rounded-lg border">
                {g.rooms.map(({ room }) => (
                  <li key={room.id} data-testid="room-photo-room" data-room-id={room.id}>
                    <AppLink href={roomPhotosPath(room.id)} className="flex min-h-14 items-center gap-3 px-4 py-2 hover:bg-accent focus-visible:bg-accent">
                      <span className="min-w-0 flex-1">
                        <span className="block font-medium">{room.name}</span>
                        <span className="block text-xs text-muted-foreground" data-testid="room-photo-count">
                          {photoCountLabel(counts.get(room.id), ctx.prevYearId !== null)}
                        </span>
                      </span>
                      <ChevronRight aria-hidden className="size-4 shrink-0 text-muted-foreground" />
                    </AppLink>
                  </li>
                ))}
              </ul>
            </section>
          ))
        )}
      </div>
    );
  }
  return (
    <div className="mx-auto max-w-3xl" data-testid="room-photos-list">
      <Header />
      <ClosedNotice ctx={ctx} />
      {body}
    </div>
  );
}

// ---------------------------------------------------------------- 部屋の写真

type Pending = { kind: 'memo'; photo: RoomPhotoRow } | { kind: 'delete'; photo: RoomPhotoRow; resend: boolean };

function RoomDetail({ ctx, room }: { ctx: Ctx; room: PhotoRoom }) {
  const queryClient = useQueryClient();
  const { reloadMembership } = useAuth();
  const photosQ = useQuery(roomPhotosOptions(ctx.yearId, room.id));
  const { current, previous } = useMemo(() => splitRoomPhotos(photosQ.data ?? [], ctx.yearId, ctx.prevYearId), [photosQ.data, ctx.yearId, ctx.prevYearId]);
  const images = useItemImageUrls([...current, ...previous].map((p) => p.object_path), { bucket: ROOM_PHOTOS_BUCKET_ID });
  const [adding, setAdding] = useState(false);
  const [pending, setPending] = useState<Pending | null>(null);
  const [busy, setBusy] = useState(false);

  /** 失敗の後始末（立場の読み直し・消えていた写真の知らせ）。文言を返す（成功なら null） */
  const settle = (r: RoomPhotoWriteResult): string | null => {
    if (r.ok) return null;
    if (r.reloadMembership) reloadMembership();
    return r.message;
  };
  const move = async (photo: RoomPhotoRow, delta: -1 | 1) => {
    const changes = movePhotoChanges(current, photo.id, delta);
    if (changes.length === 0 || busy) return;
    setBusy(true);
    try {
      const message = settle(await moveRoomPhoto(queryClient, ctx.yearId, changes));
      if (message) toast.error(message);
    } finally {
      setBusy(false);
    }
  };

  const section = (title: string, list: RoomPhotoRow[], empty: string, which: 'current' | 'previous', canEdit: boolean) => (
    <section aria-label={title} className="space-y-2" data-testid={`room-photos-${which}`}>
      <h3 className="text-base font-semibold">{title}</h3>
      {list.length === 0 ? (
        <p className="text-sm text-muted-foreground">{empty}</p>
      ) : (
        <ul className="grid grid-cols-2 gap-3 md:grid-cols-3">
          {list.map((p, i) => (
            <RoomPhotoTile
              key={p.id}
              photo={p}
              label={`${room.name} の${which === 'current' ? '今年' : '前年'}の写真 ${i + 1}`}
              images={images}
              showCreatedAt={ctx.soumu}
              menu={
                canEdit ? (
                  <DropdownMenu>
                    <DropdownMenuTrigger asChild>
                      <Button type="button" variant="ghost" size="icon" className="-mr-2 size-11 shrink-0" aria-label={`写真 ${i + 1} のメニュー`} data-testid="room-photo-menu" disabled={busy}>
                        <EllipsisVertical aria-hidden />
                      </Button>
                    </DropdownMenuTrigger>
                    <DropdownMenuContent align="end">
                      <DropdownMenuItem onSelect={() => setPending({ kind: 'memo', photo: p })}>メモを直す</DropdownMenuItem>
                      <DropdownMenuItem disabled={i === 0} onSelect={() => void move(p, -1)}>
                        <ArrowLeft aria-hidden />
                        前へ
                      </DropdownMenuItem>
                      <DropdownMenuItem disabled={i === list.length - 1} onSelect={() => void move(p, 1)}>
                        <ArrowRight aria-hidden />
                        後ろへ
                      </DropdownMenuItem>
                      <DropdownMenuItem className="text-destructive" onSelect={() => setPending({ kind: 'delete', photo: p, resend: false })}>
                        消す
                      </DropdownMenuItem>
                    </DropdownMenuContent>
                  </DropdownMenu>
                ) : undefined
              }
            />
          ))}
        </ul>
      )}
    </section>
  );

  let body: React.ReactNode;
  if (photosQ.isError) body = <ErrorState message={messageFor(classifyError(photosQ.error))} onRetry={() => void photosQ.refetch()} />;
  else if (!photosQ.data) body = <LoadingState />;
  else {
    const full = current.length >= ROOM_PHOTO_LIMIT;
    body = (
      <div className="space-y-6">
        {ctx.writable ? (
          full ? (
            <p role="status" className="text-sm text-muted-foreground" data-testid="room-photo-full">
              {ROOM_PHOTO_FULL_NOTE}
            </p>
          ) : (
            <Button type="button" className="h-11" onClick={() => setAdding(true)} data-testid="room-photo-add">
              <ImagePlus aria-hidden />
              写真を足す
            </Button>
          )
        ) : null}
        {section(`今年（${ctx.yearLabel}）`, current, 'まだ写真がありません', 'current', ctx.writable)}
        {ctx.prevYearId ? (
          section(ctx.prevLabel ? `前年（${ctx.prevLabel}）` : '前年', previous, '前の年度の写真はありません', 'previous', false)
        ) : (
          <section aria-label="前年" className="space-y-2" data-testid="room-photos-previous">
            <h3 className="text-base font-semibold">前年</h3>
            <p className="text-sm text-muted-foreground">前の年度はありません</p>
          </section>
        )}
      </div>
    );
  }

  return (
    <div className="mx-auto max-w-3xl" data-testid="room-photos-room" data-room-id={room.id}>
      <Header />
      <ClosedNotice ctx={ctx} />
      <section aria-label="場所" className="mb-4 space-y-1">
        <AppLink href={roomPhotosPath()} className="text-sm text-muted-foreground underline underline-offset-4">
          一覧へ
        </AppLink>
        <h2 className="text-2xl font-bold" data-testid="room-photo-room-name">
          {room.name}
        </h2>
        <p className="text-sm text-muted-foreground">{placeOf(room)}</p>
      </section>
      {body}
      {ctx.writable ? (
        <RoomPhotoAddDialog
          open={adding}
          onOpenChange={setAdding}
          roomName={room.name}
          onSubmit={async (input) => {
            const r = await sendRoomPhoto(queryClient, { yearId: ctx.yearId, roomId: room.id, ...input });
            const message = settle(r);
            if (!message) toast.success('写真を足しました');
            return message;
          }}
        />
      ) : null}
      {pending?.kind === 'memo' ? (
        <RoomPhotoMemoDialog
          open
          onOpenChange={(o) => !o && setPending(null)}
          initial={pending.photo.memo}
          onSubmit={async (memo) => {
            const r = await saveRoomPhotoMemo(queryClient, ctx.yearId, pending.photo.id, memo);
            if (!r.ok && r.gone) {
              // ほかの人が消した：読み直して閉じる
              toast.error(r.message);
              setPending(null);
              return null;
            }
            const message = settle(r);
            if (!message) toast.success('メモを直しました');
            return message;
          }}
        />
      ) : null}
      {pending?.kind === 'delete' ? (
        <ConfirmDialog
          open
          onOpenChange={(o) => !o && setPending(null)}
          title="この写真を消します。元に戻せません"
          description="消した写真は、この部屋の今年の写真から外れます。"
          destructive
          confirmLabel="消す"
          pendingLabel="消しています…"
          onConfirm={async () => {
            const r = await removeRoomPhoto(queryClient, ctx.yearId, pending.photo, { resend: pending.resend });
            if (r.ok) {
              toast.success('写真を消しました');
              return;
            }
            if (r.gone) {
              toast.error(r.message);
              return;
            }
            const message = settle(r);
            toast.error(message ?? '消せませんでした');
            // 通信が切れたなど：次に押したときは送り直し（not_found なら消えていたものとして扱う。B1）
            setPending({ ...pending, resend: true });
            throw new Error('not_deleted');
          }}
        />
      ) : null}
    </div>
  );
}
