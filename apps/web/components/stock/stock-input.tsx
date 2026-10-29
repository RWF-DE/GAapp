'use client';

// 在庫入力の部屋の画面（画面の設計 3.3、04「在庫入力」。T10）。スマホ（390px）を基本にする。
// - 表示：場所名、使用不可なら「今年は使用不可」と理由のメモ、前回入力した人と日時、品目ごとの行（品目名・＋－と数字・前年の数）。
// - 保存：部屋の全品目（0 を含む）を1回の upsert。counted_by・counted_at は DB が入れる。保存の直前に部屋を読み直し、
//   読み込んだ後にほかの人が保存していれば「上書きする」「読み直す」を選んでもらう。
// - 年度の状態とロールで書けるか（stockAccess）。管理者は振り分け中なら振り分けの合計より少なくなる品目を確かめ、確定中なら止める。
// - 最新でない年度なら保存の前に確かめる（useNotLatestYearConfirm）。入力の途中で離れるときは確かめ、入力は部屋ごとの下書きに残す。
import { useQueryClient } from '@tanstack/react-query';
import { AlertTriangle, Ban, CheckCircle2 } from 'lucide-react';
import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { toast } from 'sonner';
import { AppLink } from '@/components/common/app-link';
import { ConfirmDialog } from '@/components/common/confirm-dialog';
import { CountStepper } from '@/components/common/count-stepper';
import { DraftNotice } from '@/components/common/draft-notice';
import { ErrorBanner } from '@/components/common/error-banner';
import { LatestYearSwitch, useNotLatestYearConfirm } from '@/components/common/latest-year';
import { PageHeader } from '@/components/common/page-header';
import { TokyoTime } from '@/components/common/tokyo-time';
import {
  AlertDialog,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
} from '@/components/ui/alert-dialog';
import { Button } from '@/components/ui/button';
import { ErrorState, LoadingState, ReadOnlyNotice } from '@/components/states';
import { useAuth } from '@/lib/auth/auth-provider';
import { useAuthErrorHandler } from '@/lib/auth/guarded';
import type { ItemRow, StockDbRow, YearRow } from '@/lib/db/types';
import {
  countedByRoom,
  countsFromRows,
  detectOtherSave,
  fetchRoomAllocated,
  fetchRoomStocks,
  latestCounted,
  nextUncountedRoom,
  placeOf,
  previousCountMap,
  sameCounts,
  saveRoomStocks,
  shortfallMessage,
  shortfalls,
  stockAccess,
  stockInvalidationKeys,
  stockPath,
  usePreviousYearStocks,
  useProfileNames,
  useRoomAllocated,
  useRoomStocks,
  useYearStocks,
  type OtherSave,
  type Shortfall,
  type StorageRoom,
} from '@/lib/data/stocks';
import { createDraftWriter, loadDraft, removeDraft, type DraftKey } from '@/lib/drafts';
import { appError, classifyError, effectOf, messageFor, type NameLookup } from '@/lib/errors';
import { queryKeys } from '@/lib/query';
import { stockCountsSchema, stockDraftSchema, type StockCounts, type StockDraft } from '@/lib/schemas/stock';
import { useUnsavedChanges } from '@/lib/unsaved-changes';
import { cn } from '@/lib/utils';
import { countedName, type OpenYear } from './common';

type Phase = 'idle' | 'checking' | 'saving';

interface Conflict {
  latest: StockDbRow[];
  other: OtherSave;
}

/** 保存の前の「振り分けの合計より少なくなります」の確かめ（Promise で答える） */
function useShortfallAsk() {
  const [list, setList] = useState<Shortfall[] | null>(null);
  const resolver = useRef<((ok: boolean) => void) | null>(null);
  const ask = useCallback((l: Shortfall[]) => {
    resolver.current?.(false);
    return new Promise<boolean>((resolve) => {
      resolver.current = resolve;
      setList(l);
    });
  }, []);
  const answer = (ok: boolean) => {
    const r = resolver.current;
    resolver.current = null;
    r?.(ok);
    setList(null);
  };
  return { list, ask, answer };
}

export function StockInput({
  open,
  year,
  target,
  storage,
  items,
}: {
  open: OpenYear;
  year: YearRow;
  target: StorageRoom;
  storage: StorageRoom[];
  items: ItemRow[];
}) {
  const yearId = year.id;
  const roomId = target.room.id;
  const queryClient = useQueryClient();
  const { reloadMembership } = useAuth();
  const onAuthError = useAuthErrorHandler();
  const notLatest = useNotLatestYearConfirm();
  const shortfallAsk = useShortfallAsk();
  const access = stockAccess(year.status, open.role);

  const stocksQ = useRoomStocks(yearId, roomId);
  const prevQ = usePreviousYearStocks(yearId, year.prev_year_id);
  const allocQ = useRoomAllocated(yearId, roomId, access.shortfall !== 'none');
  const yearStocksQ = useYearStocks(yearId);

  // 読み込んだときの行（ほかの人の保存を見分ける元）と入力中の数
  const [base, setBase] = useState<StockDbRow[] | null>(null);
  const [counts, setCounts] = useState<StockCounts | null>(null);
  if (base === null && stocksQ.data) {
    setBase(stocksQ.data);
    setCounts(countsFromRows(items, stocksQ.data));
  }
  const baseCounts = useMemo(() => (base ? countsFromRows(items, base) : null), [base, items]);
  const dirty = access.writable && !!counts && !!baseCounts && !sameCounts(items, counts, baseCounts);
  useUnsavedChanges(dirty);

  // 下書き（部屋ごと。カメラで次の QR を読んだ・別のアプリへ行った・タブが捨てられた後に戻せる）
  const draftKey = useMemo<DraftKey>(() => ({ userId: open.userId, yearId, screen: 'stock', target: roomId }), [open.userId, yearId, roomId]);
  const writer = useMemo(() => createDraftWriter<StockDraft>(draftKey), [draftKey]);
  useEffect(() => () => writer.flush(), [writer]);
  const [draft, setDraft] = useState(() => {
    const d = loadDraft<unknown>(draftKey);
    if (!d) return null;
    const parsed = stockDraftSchema.safeParse(d.value);
    if (!parsed.success) {
      removeDraft(draftKey);
      return null;
    }
    return { savedAt: d.savedAt, counts: parsed.data.counts };
  });
  const showDraft = access.writable && !!draft && !!counts && !sameCounts(items, { ...counts, ...draft.counts }, counts);

  const [phase, setPhase] = useState<Phase>('idle');
  const [error, setError] = useState<unknown>(null);
  const [blocked, setBlocked] = useState<Shortfall[] | null>(null);
  const [conflict, setConflict] = useState<Conflict | null>(null);
  const [savedAt, setSavedAt] = useState<string | null>(null);

  const last = base ? latestCounted(base) : null;
  const namesQ = useProfileNames(yearId, [last?.countedBy ?? null, conflict?.other.by?.countedBy ?? null]);
  const prev = useMemo(() => (prevQ.data ? previousCountMap(prevQ.data) : null), [prevQ.data]);
  const hasPrev = !!year.prev_year_id;
  const itemName = useMemo(() => new Map(items.map((i) => [i.id, i.name])), [items]);
  const names: NameLookup = useMemo(
    () => ({ room: (id) => (id === roomId ? target.room.name : storage.find((s) => s.room.id === id)?.room.name), item: (id) => itemName.get(id) }),
    [roomId, target.room.name, storage, itemName],
  );

  const change = (itemId: string, value: number) => {
    if (!counts) return;
    const next = { ...counts, [itemId]: value };
    setCounts(next);
    setDraft(null);
    setSavedAt(null);
    setBlocked(null);
    if (baseCounts && sameCounts(items, next, baseCounts)) writer.clear();
    else writer.write({ counts: next });
  };

  const handleError = async (e: unknown) => {
    const c = classifyError(e);
    if (c.kind === 'auth') {
      // 'retry' でも自動では送り直さない（もう一度「保存」を押してもらう）。'signedOut' なら /login へ移る（下書きは残る）
      await onAuthError(e);
      return;
    }
    setError(e);
    const eff = effectOf(c);
    if (eff.reload === 'year') {
      void queryClient.invalidateQueries({ queryKey: queryKeys.yearRow(yearId) });
      reloadMembership();
    } else if (eff.reload === 'data') {
      for (const key of stockInvalidationKeys(yearId)) void queryClient.invalidateQueries({ queryKey: key });
    }
  };

  const write = async (values: StockCounts, retried = false): Promise<void> => {
    setPhase('saving');
    try {
      const rows = await saveRoomStocks(yearId, roomId, items, values);
      writer.clear();
      setDraft(null);
      setBase(rows);
      setCounts(countsFromRows(items, rows));
      setSavedAt(new Date().toISOString());
      toast.success('保存しました');
      for (const key of stockInvalidationKeys(yearId)) void queryClient.invalidateQueries({ queryKey: key });
    } catch (e) {
      // 401：セッションを更新できたら同じ要求を1回だけ送り直す（stocks の upsert は同じ値で何度送っても同じ。2.6）
      if (classifyError(e).kind === 'auth' && !retried) {
        if ((await onAuthError(e)) === 'retry') return write(values, true);
        return;
      }
      await handleError(e);
    } finally {
      setPhase('idle');
    }
  };

  const save = async () => {
    if (!counts || !base || phase !== 'idle' || !access.writable) return;
    setError(null);
    setBlocked(null);
    const parsed = stockCountsSchema.safeParse(counts);
    if (!parsed.success) {
      setError(appError('input', 'client_validation', { field: 'count' }));
      return;
    }
    writer.flush();
    if (!(await notLatest.confirmBeforeWrite())) return;
    setPhase('checking');
    let proceed = false;
    try {
      if (access.shortfall !== 'none') {
        // 振り分けの合計は保存の直前に読み直す（DB の確定中の守りと同じ条件を先に確かめる）
        const allocated = await fetchRoomAllocated(yearId, roomId);
        queryClient.setQueryData(queryKeys.yearPart(yearId, 'allocated', roomId), allocated);
        const list = shortfalls(items, parsed.data, allocated);
        if (list.length > 0) {
          if (access.shortfall === 'block') {
            setBlocked(list);
            return;
          }
          if (!(await shortfallAsk.ask(list))) return;
        }
      }
      const latest = await fetchRoomStocks(yearId, roomId);
      const other = detectOtherSave(base, latest);
      if (other) {
        setConflict({ latest, other });
        return;
      }
      proceed = true;
    } catch (e) {
      await handleError(e);
      return;
    } finally {
      if (!proceed) setPhase('idle');
    }
    await write(parsed.data);
  };

  const overwrite = async () => {
    if (!conflict || !counts) return;
    setBase(conflict.latest);
    setConflict(null);
    await write(counts);
  };

  const reloadLatest = () => {
    if (!conflict) return;
    setBase(conflict.latest);
    setCounts(countsFromRows(items, conflict.latest));
    writer.clear();
    setDraft(null);
    setConflict(null);
    toast.info('ほかの人が保存した数を読み直しました');
  };

  // 保存の後の「次の部屋へ」（今の部屋は数えたものとして探す）
  const next = useMemo(() => {
    if (!savedAt) return null;
    const countedIds = new Set(countedByRoom(yearStocksQ.data ?? []).keys());
    countedIds.add(roomId);
    return nextUncountedRoom(storage, countedIds, roomId);
  }, [savedAt, yearStocksQ.data, storage, roomId]);

  if (stocksQ.isError && !base) {
    return (
      <>
        <PageHeader title="在庫入力" />
        <ErrorState message={messageFor(classifyError(stocksQ.error))} onRetry={() => void stocksQ.refetch()} />
      </>
    );
  }

  const busy = phase !== 'idle';
  const otherName = conflict?.other.by ? countedName(conflict.other.by, namesQ.data) : null;

  return (
    <div className={cn('mx-auto max-w-xl', access.writable && 'pb-4')}>
      <LatestYearSwitch />
      <PageHeader title="在庫入力" />

      <section aria-label="場所" className="mb-4 space-y-2">
        <div>
          <AppLink href="/stock" className="text-sm text-muted-foreground underline underline-offset-4">
            保管場所の一覧
          </AppLink>
        </div>
        <h2 className="text-2xl font-bold" data-testid="stock-room-name">
          {target.room.name}
        </h2>
        <p className="text-sm text-muted-foreground">{placeOf(target.room)}</p>
        {!target.usable ? (
          <div role="status" data-testid="unusable-notice" className="flex gap-2 rounded-md border border-zinc-400 bg-zinc-100 px-4 py-2 text-sm text-zinc-800">
            <Ban aria-hidden className="mt-0.5 size-4 shrink-0" />
            <div>
              <p className="font-semibold">今年は使用不可</p>
              {target.note ? <p>{target.note}</p> : null}
              <p className="text-xs">数えることはできます（振り分けの運び元にはなりません）。</p>
            </div>
          </div>
        ) : null}
        {base ? (
          <p className="text-sm" data-testid="last-counted">
            前回の入力：
            {last ? (
              <>
                <TokyoTime value={last.countedAt} />（{countedName(last, namesQ.data)}）
              </>
            ) : (
              'まだありません'
            )}
          </p>
        ) : null}
      </section>

      <div className="mb-4 space-y-2">
        {!access.writable ? <ReadOnlyNotice status={year.status}>{access.readOnlyMessage ?? undefined}</ReadOnlyNotice> : null}
        {access.writable && access.shortfall === 'block' ? (
          <p className="text-xs text-muted-foreground">確定中は、振り分けの合計より少なくする数は保存できません。</p>
        ) : null}
        {showDraft && draft ? (
          <DraftNotice
            savedAt={draft.savedAt}
            onRestore={() => {
              const restored = { ...counts!, ...Object.fromEntries(items.filter((i) => i.id in draft.counts).map((i) => [i.id, draft.counts[i.id]!])) };
              setCounts(restored);
              writer.write({ counts: restored });
              setDraft(null);
            }}
            onDiscard={() => {
              writer.clear();
              setDraft(null);
            }}
          />
        ) : null}
        {error ? (
          <ErrorBanner
            error={error}
            context={{ names }}
            onReload={() => {
              setError(null);
              void stocksQ.refetch();
            }}
            onRetry={classifyError(error).kind === 'network' || classifyError(error).kind === 'deadlock' ? () => void save() : undefined}
          />
        ) : null}
        {blocked ? (
          <div role="alert" data-testid="stock-shortfall-blocked" className="flex gap-2 rounded-md border border-destructive/40 bg-destructive/5 px-4 py-3 text-sm">
            <AlertTriangle aria-hidden className="mt-0.5 size-4 shrink-0 text-destructive" />
            <p className="font-medium text-destructive">{shortfallMessage('block', blocked)}</p>
          </div>
        ) : null}
      </div>

      {!counts ? (
        <LoadingState />
      ) : (
        <ul className="divide-y rounded-lg border" aria-label="品目ごとの数">
          {items.map((item) => {
            const allocated = allocQ.data?.get(item.id) ?? 0;
            const value = counts[item.id] ?? 0;
            const prevCount = prev?.get(`${roomId}:${item.id}`);
            return (
              <li key={item.id} data-testid="stock-item-row" data-item-id={item.id} className="flex items-center gap-3 px-3 py-3">
                <div className="min-w-0 flex-1">
                  <p className="font-medium">{item.name}</p>
                  <p className="flex flex-wrap gap-x-3 text-xs text-muted-foreground">
                    {hasPrev ? (
                      <span data-testid="stock-prev">前年 {prevQ.isPending ? '…' : prevCount === undefined ? '—' : prevCount}</span>
                    ) : null}
                    {access.shortfall !== 'none' && allocated > 0 ? (
                      <span data-testid="stock-allocated" className={cn(value < allocated && 'font-semibold text-destructive')}>
                        振り分け {allocated}台
                      </span>
                    ) : null}
                  </p>
                </div>
                <CountStepper
                  label={`${item.name}の数`}
                  value={value}
                  onChange={(v) => change(item.id, v)}
                  disabled={!access.writable || busy}
                  className="shrink-0 [&_button]:size-11 [&_input]:h-11 [&_input]:w-16 [&_input]:text-lg"
                />
              </li>
            );
          })}
        </ul>
      )}

      {savedAt ? (
        <div role="status" data-testid="stock-saved" className="mt-4 space-y-3 rounded-lg border border-emerald-300 bg-emerald-50 p-4 text-sm text-emerald-950">
          <p className="flex items-center gap-2 font-medium">
            <CheckCircle2 aria-hidden className="size-4" />
            <span>
              保存しました（<TokyoTime value={savedAt} format="time" />）
            </span>
          </p>
          {next ? (
            <Button asChild size="lg" className="w-full">
              <AppLink href={stockPath(next.room.id)}>次の部屋へ（{next.room.name}）</AppLink>
            </Button>
          ) : yearStocksQ.isFetching ? null : (
            <p>まだ数えていない保管場所はありません。</p>
          )}
          <AppLink href="/stock" className="block text-center underline underline-offset-4">
            保管場所の一覧へ
          </AppLink>
        </div>
      ) : null}

      {access.writable && counts ? (
        <div className="sticky bottom-0 z-10 -mx-4 mt-4 border-t bg-background/95 px-4 py-3 backdrop-blur md:-mx-6 md:px-6 print:hidden">
          {dirty ? <p className="mb-2 text-xs text-amber-700">保存していない変更があります</p> : null}
          <Button size="lg" className="h-12 w-full text-base" onClick={() => void save()} disabled={busy} aria-busy={busy || undefined}>
            {phase === 'saving' ? '保存中…' : phase === 'checking' ? '確かめています…' : '保存'}
          </Button>
        </div>
      ) : null}

      {notLatest.dialog}

      <ConfirmDialog
        open={shortfallAsk.list !== null}
        onOpenChange={(o) => {
          if (!o) shortfallAsk.answer(false);
        }}
        title="保存すると在庫超過になります"
        description={shortfallAsk.list ? shortfallMessage('confirm', shortfallAsk.list) : undefined}
        confirmLabel="保存する"
        destructive
        onConfirm={() => shortfallAsk.answer(true)}
      />

      <AlertDialog open={conflict !== null} onOpenChange={(o) => (!o ? setConflict(null) : undefined)}>
        <AlertDialogContent data-testid="stock-conflict-dialog">
          <AlertDialogHeader>
            <AlertDialogTitle>ほかの人が先に保存しています</AlertDialogTitle>
            <AlertDialogDescription>
              {conflict?.other.by ? (
                <>
                  {otherName}さんが <TokyoTime value={conflict.other.by.countedAt} /> に保存しています。
                </>
              ) : (
                'この画面を開いた後に、ほかの人が保存しています。'
              )}
              上書きするか、ほかの人の数を読み直すかを選んでください。
            </AlertDialogDescription>
          </AlertDialogHeader>
          {conflict && counts ? (
            <table className="w-full text-sm">
              <thead>
                <tr className="border-b text-left text-muted-foreground">
                  <th className="py-1 font-normal">品目</th>
                  <th className="py-1 text-right font-normal">{otherName ? `${otherName}さん` : 'ほかの人'}</th>
                  <th className="py-1 text-right font-normal">あなた</th>
                </tr>
              </thead>
              <tbody>
                {items.map((i) => {
                  const theirs = conflict.latest.find((r) => r.item_id === i.id)?.count;
                  const mine = counts[i.id] ?? 0;
                  return (
                    <tr key={i.id} data-testid="conflict-row" className={cn('border-b last:border-0', theirs !== mine && 'font-semibold')}>
                      <td className="py-1">{i.name}</td>
                      <td className="py-1 text-right tabular-nums">{theirs ?? '—'}</td>
                      <td className="py-1 text-right tabular-nums">{mine}</td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          ) : null}
          <AlertDialogFooter>
            <Button variant="ghost" onClick={() => setConflict(null)}>
              やめる
            </Button>
            <Button variant="outline" onClick={reloadLatest}>
              読み直す
            </Button>
            <Button variant="destructive" onClick={() => void overwrite()}>
              上書きする
            </Button>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </div>
  );
}
