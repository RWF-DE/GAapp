'use client';

// 在庫入力の場所を選ぶ一覧（room がないとき。画面の設計 3.3）。保管場所を並び順で、建物ごとに見出し、名前で絞れる。
// 各行に「数えた（日時・人）」か「まだ」と使用不可の印。行を押すと /stock?room=<id>（部屋に貼った QR と同じ URL）。
import { ChevronRight, Search } from 'lucide-react';
import { useMemo, useState } from 'react';
import { AppLink } from '@/components/common/app-link';
import { matchesEntity } from '@/components/common/entity-select';
import { LatestYearSwitch } from '@/components/common/latest-year';
import { PageHeader } from '@/components/common/page-header';
import { Input } from '@/components/ui/input';
import { EmptyState, ErrorState, LoadingState } from '@/components/states';
import type { YearRow } from '@/lib/db/types';
import {
  countedByRoom,
  groupByBuilding,
  placeOf,
  stockPath,
  useProfileNames,
  useYearStocks,
  type StorageRoom,
} from '@/lib/data/stocks';
import { classifyError, messageFor } from '@/lib/errors';
import { CountedLabel, UnusableBadge, type OpenYear } from './common';

export function RoomPicker({ open, year, storage }: { open: OpenYear; year: YearRow; storage: StorageRoom[] }) {
  const stocksQ = useYearStocks(year.id);
  const counted = useMemo(() => countedByRoom(stocksQ.data ?? []), [stocksQ.data]);
  const namesQ = useProfileNames(year.id, [...counted.values()].map((c) => c?.countedBy ?? null));
  const [search, setSearch] = useState('');

  const filtered = useMemo(
    () => storage.filter((s) => matchesEntity({ id: s.room.id, name: s.room.name, group: placeOf(s.room), keywords: s.room.aliases }, search)),
    [storage, search],
  );
  const groups = groupByBuilding(filtered);

  let body: React.ReactNode;
  if (storage.length === 0) {
    body = (
      <EmptyState
        title="保管場所がありません"
        description={open.role === 'admin' ? 'マスタ設定の場所で「保管場所」にしてください。' : '総務の管理者に、保管場所の登録を頼んでください。'}
        action={
          open.role === 'admin' ? (
            <AppLink href="/settings?tab=rooms" className="text-sm underline underline-offset-4">
              マスタ設定（場所）へ
            </AppLink>
          ) : undefined
        }
      />
    );
  } else if (stocksQ.isError) {
    body = <ErrorState message={messageFor(classifyError(stocksQ.error))} onRetry={() => void stocksQ.refetch()} />;
  } else if (!stocksQ.data) {
    body = <LoadingState />;
  } else {
    body = (
      <div className="space-y-4">
        <label className="relative block">
          <span className="sr-only">場所の名前で絞る</span>
          <Search aria-hidden className="pointer-events-none absolute top-1/2 left-3 size-4 -translate-y-1/2 text-muted-foreground" />
          <Input
            type="search"
            className="h-11 pl-9"
            placeholder="場所の名前で絞る"
            value={search}
            onChange={(e) => setSearch(e.target.value)}
          />
        </label>
        {groups.length === 0 ? (
          <EmptyState title="当てはまる場所がありません" description="別の言葉で絞ってください。" />
        ) : (
          groups.map((g) => (
            <section key={g.building} aria-label={g.building} className="space-y-2">
              <h2 className="text-sm font-semibold text-muted-foreground">{g.building}</h2>
              <ul className="divide-y rounded-lg border">
                {g.rooms.map((s) => (
                  <li key={s.room.id} data-testid="stock-room-row" data-room-id={s.room.id}>
                    <AppLink
                      href={stockPath(s.room.id)}
                      className="flex min-h-14 items-center gap-3 px-4 py-2 hover:bg-accent focus-visible:bg-accent"
                    >
                      <span className="min-w-0 flex-1">
                        <span className="flex flex-wrap items-center gap-2">
                          <span className="font-medium">{s.room.name}</span>
                          {!s.usable ? <UnusableBadge /> : null}
                        </span>
                        <CountedLabel className="block text-xs" info={counted.get(s.room.id)} names={namesQ.data} />
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
    <>
      <LatestYearSwitch />
      <PageHeader title="在庫入力" description="数える保管場所を選んでください。部屋に貼った QR を読んでも開けます。" />
      {body}
    </>
  );
}
