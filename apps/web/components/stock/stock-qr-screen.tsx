'use client';

// 部屋の QR の印刷 /stocks/qr（画面の設計 3.4・6 章。T10）。保管場所を選ぶ（既定は全部。`?rooms=<id>,<id>` で絞れる）→
// 印刷用のカード（A4 に 2列×4段）。「印刷」で window.print()。印刷のときは AppShell のヘッダー・ナビと、この画面の操作を隠す。
// QR の URL は年度を入れない（`${origin}${basePath}/stock/?room=<id>`。D-31）。
import { Printer } from 'lucide-react';
import { useSearchParams } from 'next/navigation';
import { useMemo, useState } from 'react';
import { AppLink } from '@/components/common/app-link';
import { PageHeader } from '@/components/common/page-header';
import { Button } from '@/components/ui/button';
import { Checkbox } from '@/components/ui/checkbox';
import { EmptyState, ErrorState, LoadingState } from '@/components/states';
import { placeOf, sortByOrder, useRooms } from '@/lib/data/stocks';
import { classifyError, messageFor } from '@/lib/errors';
import { parseRoomsParam } from '@/lib/schemas/stock';
import { useOrigin } from './common';
import { QrCards } from './qr-cards';

export function StockQrScreen() {
  const params = useSearchParams();
  const fromQuery = useMemo(() => parseRoomsParam(params.get('rooms')), [params]);
  const roomsQ = useRooms();
  const origin = useOrigin();
  const storage = useMemo(() => sortByOrder((roomsQ.data ?? []).filter((r) => r.is_storage)), [roomsQ.data]);
  // 選んだ場所（null は既定：クエリで絞っていればその場所、なければ全部）
  const [picked, setPicked] = useState<Set<string> | null>(null);
  const selected = useMemo(() => {
    if (picked) return picked;
    const ids = storage.map((r) => r.id);
    if (!fromQuery) return new Set(ids);
    return new Set(ids.filter((id) => fromQuery.includes(id)));
  }, [picked, storage, fromQuery]);
  const cards = storage.filter((r) => selected.has(r.id));

  const toggle = (id: string, on: boolean) => {
    const next = new Set(selected);
    if (on) next.add(id);
    else next.delete(id);
    setPicked(next);
  };

  const header = (
    <PageHeader
      title="部屋の QR の印刷"
      showYear={false}
      description="部屋に貼る在庫入力の QR です。QR の URL には年度を入れないので、毎年貼り直さなくてよいです。"
      actions={
        <>
          <Button asChild variant="outline">
            <AppLink href="/stocks">在庫一覧へ</AppLink>
          </Button>
          <Button onClick={() => window.print()} disabled={cards.length === 0}>
            <Printer aria-hidden />
            印刷
          </Button>
        </>
      }
    />
  );

  if (roomsQ.isError) {
    return (
      <>
        {header}
        <ErrorState message={messageFor(classifyError(roomsQ.error))} onRetry={() => void roomsQ.refetch()} />
      </>
    );
  }
  if (!roomsQ.data) {
    return (
      <>
        {header}
        <LoadingState />
      </>
    );
  }
  if (storage.length === 0) {
    return (
      <>
        {header}
        <EmptyState title="保管場所がありません" description="マスタ設定の場所で「保管場所」にすると、ここに QR が出ます。" />
      </>
    );
  }

  return (
    <>
      <style>{'@media print { @page { size: A4; margin: 10mm; } }'}</style>
      <div className="print:hidden">{header}</div>
      <section aria-label="印刷する場所" className="mb-6 rounded-lg border p-4 print:hidden">
        <div className="mb-3 flex flex-wrap items-center gap-3">
          <h2 className="text-sm font-semibold">
            印刷する場所（<span data-testid="qr-selected-count">{cards.length}</span>／{storage.length}）
          </h2>
          <Button size="sm" variant="outline" onClick={() => setPicked(new Set(storage.map((r) => r.id)))}>
            すべて選ぶ
          </Button>
          <Button size="sm" variant="outline" onClick={() => setPicked(new Set())}>
            すべて外す
          </Button>
        </div>
        <ul className="grid grid-cols-2 gap-x-4 gap-y-2 md:grid-cols-3 lg:grid-cols-4">
          {storage.map((r) => (
            <li key={r.id}>
              <label className="flex items-center gap-2 text-sm">
                <Checkbox checked={selected.has(r.id)} onCheckedChange={(v) => toggle(r.id, v === true)} aria-label={`${r.name}を印刷する`} />
                <span>
                  {r.name}
                  <span className="ml-1 text-xs text-muted-foreground">{placeOf(r)}</span>
                </span>
              </label>
            </li>
          ))}
        </ul>
      </section>
      {cards.length === 0 ? (
        <EmptyState title="印刷する場所を選んでください" className="print:hidden" />
      ) : (
        <QrCards rooms={cards} origin={origin} />
      )}
    </>
  );
}
