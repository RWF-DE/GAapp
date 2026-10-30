'use client';

// 在庫入力 /stock?room=…（画面の設計 3.3、04「在庫入力」。T10）。
// room がなければ保管場所の一覧（RoomPicker）、あれば部屋の入力（StockInput）。room が保管場所の一覧にない・形が違うときは
// 「この場所は見つかりません」。年度の行（状態で書けるか。立場と一緒に読んだもの）と場所・品目・その年度の使用、部屋の在庫を
// 並行に読む（D-45。部屋の在庫は StockInput が使う。場所の一覧で部屋を確かめる前に読み始めてよい：読めるのは RLS の範囲だけで、
// 見つからない部屋なら使わない）。前に開いた年度があれば、ページを開いたときに先読みも始まっている（lib/boot/early-load.ts）。
import { useQueryClient } from '@tanstack/react-query';
import { useSearchParams } from 'next/navigation';
import { useEffect } from 'react';
import { AppLink } from '@/components/common/app-link';
import { PageHeader } from '@/components/common/page-header';
import { Button } from '@/components/ui/button';
import { EmptyState, ErrorState, LoadingState } from '@/components/states';
import { roomStocksOptions, storageRooms, useStockMaster, yearStocksOptions } from '@/lib/data/stocks';
import { useYearRow } from '@/lib/data/year';
import { classifyError, messageFor } from '@/lib/errors';
import { parseRoomParam } from '@/lib/schemas/stock';
import { useOpenYear } from './common';
import { RoomPicker } from './room-picker';
import { StockInput } from './stock-input';

export function StockScreen() {
  const params = useSearchParams();
  const raw = params.get('room');
  const roomId = parseRoomParam(raw);
  const open = useOpenYear();
  const yearId = open?.year.id ?? null;
  const yearQ = useYearRow(yearId);
  const masterQ = useStockMaster(yearId);
  // 部屋の在庫（と、保存の後の「次の部屋へ」に使う年度の在庫）を、場所・品目を待たずに読み始める（StockInput が同じキーで使う）
  const queryClient = useQueryClient();
  useEffect(() => {
    if (!yearId || !roomId) return;
    void queryClient.prefetchQuery(roomStocksOptions(yearId, roomId));
    void queryClient.prefetchQuery(yearStocksOptions(yearId));
  }, [queryClient, yearId, roomId]);

  if (!open) return <LoadingState />;
  const failed = yearQ.isError ? yearQ : masterQ.isError ? masterQ : null;
  if (failed) {
    return (
      <>
        <PageHeader title="在庫入力" />
        <ErrorState message={messageFor(classifyError(failed.error))} onRetry={() => void failed.refetch()} />
      </>
    );
  }
  if (!yearQ.data || !masterQ.data) {
    return (
      <>
        <PageHeader title="在庫入力" />
        <LoadingState />
      </>
    );
  }

  const year = yearQ.data;
  const master = masterQ.data;
  const storage = storageRooms(master.rooms, master.roomYears);

  if (raw === null || raw.trim() === '') {
    return <RoomPicker open={open} year={year} storage={storage} />;
  }
  const target = roomId ? storage.find((s) => s.room.id === roomId) : undefined;
  if (!target) {
    return (
      <>
        <PageHeader title="在庫入力" />
        <EmptyState
          title="この場所は見つかりません"
          description="保管場所の一覧にない場所です（消した場所・別の場所の QR・URL の誤りの可能性があります）。"
          action={
            <Button asChild variant="outline">
              <AppLink href="/stock">保管場所の一覧へ</AppLink>
            </Button>
          }
        />
      </>
    );
  }
  // 部屋か年度を変えたら入力を作り直す（前の部屋・前の年度の入力と入力の元を持ち越さない。入力は年度・部屋ごとの下書きに残る）。
  // 年度の行と場所・品目がキャッシュにあると、年度を切り替えても読み込み中を挟まずにここへ来るので、キーに年度も入れる
  return <StockInput key={`${year.id}:${target.room.id}`} open={open} year={year} target={target} storage={storage} items={master.items} />;
}
