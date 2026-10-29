'use client';

// 在庫入力の部屋の画面（画面の設計 3.3、04「在庫入力」。T10）。スマホ（390px）を基本にする。
// - 表示：場所名、使用不可なら「今年は使用不可」と理由のメモ、前回入力した人と日時、品目ごとの行（品目名・＋－と数字・前年の数）。
// - 保存：部屋の全品目（0 を含む）を1回の upsert。counted_by・counted_at は DB が入れる。保存の直前に部屋を読み直し、
//   読み込んだ後にほかの人が保存していれば「上書きする」「読み直す」を選んでもらう。
// - 年度の状態とロールで書けるか（stockAccess）。管理者は振り分け中なら振り分けの合計より少なくなる品目を確かめ、確定中なら止める。
// - 最新でない年度なら保存の前に確かめる（useNotLatestYearConfirm）。入力の途中で離れるときは確かめ、入力は部屋ごとの下書きに残す。
//   下書きには入力の元にした行の updated_at も置き、戻した後の保存では、下書きを作った後のほかの人の保存も確かめる。
//   下書きは 500 ms まとめて書くほか、画面を外れる・pagehide・裏に回った（visibilitychange で hidden）ときにすぐ書き出す。
// - 読み直し（設計 2.6）：部屋の行を読み直したら、未保存の入力がなければその数で作り直し、入力があれば入力を残して
//   「ほかの人が保存しました」と知らせる（入力の元の行は変えないので、保存の前のほかの人の保存の確かめが効く）。
// - 通信の失敗の後の「もう一度」：読み直した行が送った数で、数えた人が自分なら「保存されていました」として終える。
//   その読み直しも通信できなければ、入力を残して「保存できたか確かめられません」と出し、「確かめる」で読み直せるまで
//   送り直しを押せなくする（読み直せたら、自分の保存が入っていれば「保存されていました」、なければ送り直せる状態に戻す）。
import { useQueryClient } from '@tanstack/react-query';
import { AlertTriangle, Ban, CheckCircle2, Info } from 'lucide-react';
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
  AlertDialogCancel,
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
  isOwnSave,
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
import {
  stockCountsSchema,
  stockDraftSchema,
  type StockBaseStamps,
  type StockCounts,
  type StockDraft,
} from '@/lib/schemas/stock';
import { useUnsavedChanges } from '@/lib/unsaved-changes';
import { cn } from '@/lib/utils';
import { countedName, knownName, type OpenYear } from './common';

type Phase = 'idle' | 'checking' | 'saving';

/** 保存の前の読み直しで 401 になり、セッションを更新できなかった（onAuthError が signOut まで済ませた） */
class AuthHandled extends Error {}

/** 応答が届かず、保存されたか分からない失敗（設計 2.6 の「通信の失敗の後の書き込み」） */
function isUncertain(e: unknown): boolean {
  const kind = classifyError(e).kind;
  return kind === 'network' || kind === 'unknown';
}

/** 行の updated_at（品目の id → updated_at） */
function stampsOf(rows: readonly StockDbRow[]): StockBaseStamps {
  return Object.fromEntries(rows.map((r) => [r.item_id, r.updated_at]));
}

/** detectOtherSave に渡す「読み込んだときの行」 */
function loadedOf(stamps: StockBaseStamps) {
  return Object.entries(stamps).map(([item_id, updated_at]) => ({ item_id, updated_at }));
}

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
  const baseCounts = useMemo(() => (base ? countsFromRows(items, base) : null), [base, items]);
  const dirty = access.writable && !!counts && !!baseCounts && !sameCounts(items, counts, baseCounts);
  useUnsavedChanges(dirty);
  // 下書きを戻したときは、入力の元が「下書きを作ったときの行」になる（null なら base が元）。
  // 保存の直前に読み直した行とこれを比べるので、下書きを作った後のほかの人の保存も確かめられる
  const [restoredStamps, setRestoredStamps] = useState<StockBaseStamps | null>(null);
  const stamps = useMemo(() => restoredStamps ?? (base ? stampsOf(base) : null), [restoredStamps, base]);

  // 読み直し（設計 2.6）：部屋の行が新しくなったら（ErrorBanner の「読み直す」、キャッシュから開いた後の裏の読み直し、
  // 自分の保存の後の invalidate など）、未保存の入力がなければその行で作り直す。入力があれば入力も元の行も残し、
  // ほかの人が保存していれば知らせる（保存のときに元の行と読み直した行を比べるので、上書きするか選べる）
  const [seen, setSeen] = useState<StockDbRow[] | null>(null);
  const [remote, setRemote] = useState<OtherSave | null>(null);
  const data = stocksQ.data;
  if (data && (data !== seen || (remote !== null && !dirty))) {
    setSeen(data);
    if (base === null || !dirty) {
      setBase(data);
      setCounts(countsFromRows(items, data));
      setRestoredStamps(null);
      setRemote(null);
    } else if (stamps) {
      const other = detectOtherSave(loadedOf(stamps), data);
      if (other) setRemote(other);
    }
  }
  // ほかの人の保存のダイアログを閉じたら「保存」へフォーカスを戻す（送信中で押せなければ、終わってから戻す）
  const saveButtonRef = useRef<HTMLButtonElement>(null);
  const refocusSave = useRef(false);

  // 下書き（部屋ごと。カメラで次の QR を読んだ・別のアプリへ行った・タブが捨てられた後に戻せる）
  const draftKey = useMemo<DraftKey>(() => ({ userId: open.userId, yearId, screen: 'stock', target: roomId }), [open.userId, yearId, roomId]);
  const writer = useMemo(() => createDraftWriter<StockDraft>(draftKey), [draftKey]);
  useEffect(() => () => writer.flush(), [writer]);
  // 次の QR の URL を開く・スマホで裏に回る・タブを閉じるときは、500 ms を待たずに書き出す（unmount だけでは間に合わない）
  useEffect(() => {
    const flush = () => writer.flush();
    const onVisibility = () => {
      if (document.visibilityState === 'hidden') writer.flush();
    };
    window.addEventListener('pagehide', flush);
    document.addEventListener('visibilitychange', onVisibility);
    return () => {
      window.removeEventListener('pagehide', flush);
      document.removeEventListener('visibilitychange', onVisibility);
    };
  }, [writer]);
  const [draft, setDraft] = useState(() => {
    const d = loadDraft<unknown>(draftKey);
    if (!d) return null;
    const parsed = stockDraftSchema.safeParse(d.value);
    if (!parsed.success) {
      removeDraft(draftKey);
      return null;
    }
    return { savedAt: d.savedAt, counts: parsed.data.counts, base: parsed.data.base };
  });
  const showDraft = access.writable && !!draft && !!counts && !sameCounts(items, { ...counts, ...draft.counts }, counts);

  const [phase, setPhase] = useState<Phase>('idle');
  const [error, setError] = useState<unknown>(null);
  const [blocked, setBlocked] = useState<Shortfall[] | null>(null);
  const [conflict, setConflict] = useState<Conflict | null>(null);
  const [savedAt, setSavedAt] = useState<string | null>(null);
  /** 保存の表示：saved（今送って保存した）・recovered（前の送信で保存されていた） */
  const [savedKind, setSavedKind] = useState<'saved' | 'recovered'>('saved');
  // 最後に送った数（応答が届かなかったときに残す。「もう一度」で保存されていたかを確かめる。設計 2.6）
  const lastSent = useRef<StockCounts | null>(null);
  // 応答の届かなかった送信があり、確かめる読み直しも通信できなかった（「確かめる」で読み直せるまで送り直さない）
  const [unconfirmed, setUnconfirmed] = useState(false);

  // 「前回の入力」は今の DB の行（入力を残して元の行を変えないときも、読み直した行で出す）
  const last = data ? latestCounted(data) : base ? latestCounted(base) : null;
  const namesQ = useProfileNames(yearId, [last?.countedBy ?? null, conflict?.other.by?.countedBy ?? null, remote?.by?.countedBy ?? null]);
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
    else if (stamps) writer.write({ counts: next, base: stamps });
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

  /** 保存できた（今送った・前の送信で保存されていた）後の片づけ。rows が今の DB の部屋の行 */
  const finishSaved = (rows: StockDbRow[], kind: 'saved' | 'recovered') => {
    lastSent.current = null;
    writer.clear();
    setDraft(null);
    setBase(rows);
    setRestoredStamps(null);
    setRemote(null);
    setCounts(countsFromRows(items, rows));
    setSavedKind(kind);
    setSavedAt(kind === 'recovered' ? (latestCounted(rows)?.countedAt ?? new Date().toISOString()) : new Date().toISOString());
    toast.success(kind === 'recovered' ? '保存されていました' : '保存しました');
    queryClient.setQueryData(queryKeys.yearPart(yearId, 'stocks', 'room', roomId), rows);
    for (const key of stockInvalidationKeys(yearId)) void queryClient.invalidateQueries({ queryKey: key });
  };

  const write = async (values: StockCounts, retried = false): Promise<void> => {
    setPhase('saving');
    lastSent.current = values;
    try {
      const rows = await saveRoomStocks(yearId, roomId, items, values);
      finishSaved(rows, 'saved');
    } catch (e) {
      // 応答が届いた失敗なら何も保存されていない（応答の届かなかった失敗だけ、送った数を残して後で確かめる）
      if (!isUncertain(e)) lastSent.current = null;
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

  /** 保存の前の読み直し。401 ならセッションの更新を1回試し、通れば読み直しを1回だけやり直す（読むだけなので送り直してよい） */
  const fresh = async <T,>(read: () => Promise<T>): Promise<T> => {
    try {
      return await read();
    } catch (e) {
      if (classifyError(e).kind !== 'auth') throw e;
      if ((await onAuthError(e)) !== 'retry') throw new AuthHandled();
      return read();
    }
  };

  /** 読み直した部屋の行が、応答の届かなかった自分の保存だけで変わっていたら片づける（設計 2.6）。片づけたら true。
   *  同じ数なら「保存されていました」で終え、その後に入力を変えていれば、読み直した行を元にする（その数はまだ保存していない） */
  const settleOwnSave = (latest: StockDbRow[], other: OtherSave, values: StockCounts): 'recovered' | 'rebased' | null => {
    const sent = lastSent.current;
    if (!sent || !isOwnSave(items, latest, other, sent, open.userId)) return null;
    if (sameCounts(items, values, sent)) {
      finishSaved(latest, 'recovered');
      return 'recovered';
    }
    lastSent.current = null;
    setBase(latest);
    setRestoredStamps(null);
    setRemote(null);
    return 'rebased';
  };

  /** 「確かめる」：応答の届かなかった送信が保存されたかを、部屋の行を読み直して確かめる */
  const confirmLastSave = async () => {
    if (!unconfirmed || !counts || !stamps || phase !== 'idle') return;
    setError(null);
    setPhase('checking');
    try {
      const latest = await fresh(() => fetchRoomStocks(yearId, roomId));
      setUnconfirmed(false);
      const other = detectOtherSave(loadedOf(stamps), latest);
      const settled = other ? settleOwnSave(latest, other, counts) : null;
      if (settled === 'recovered') return;
      if (settled === 'rebased') {
        setSeen(latest);
        writer.write({ counts, base: stampsOf(latest) });
        toast.info('前に送った数は保存されていました。その後に変えた数はまだ保存していません');
      } else {
        // 保存は入っていなかった。ほかの人の保存があれば、読み直しの決まりで知らせる（保存のときに上書きするか選べる）
        lastSent.current = null;
        toast.info('前に送った数は保存されていませんでした。もう一度「保存」を押してください');
      }
      queryClient.setQueryData(queryKeys.yearPart(yearId, 'stocks', 'room', roomId), latest);
      for (const key of stockInvalidationKeys(yearId)) void queryClient.invalidateQueries({ queryKey: key });
    } catch (e) {
      if (e instanceof AuthHandled) return;
      if (isUncertain(e)) toast.error('まだ通信できません。通信が戻ったらもう一度「確かめる」を押してください');
      else await handleError(e);
    } finally {
      setPhase('idle');
    }
  };

  const save = async () => {
    if (!counts || !base || !stamps || phase !== 'idle' || !access.writable || unconfirmed) return;
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
        const allocated = await fresh(() => fetchRoomAllocated(yearId, roomId));
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
      const latest = await fresh(() => fetchRoomStocks(yearId, roomId));
      const other = detectOtherSave(loadedOf(stamps), latest);
      if (other) {
        // 変わったのが応答の届かなかった自分の保存だけなら、「保存されていました」で終えるか、読み直した行を元にしてその数で送る
        const settled = settleOwnSave(latest, other, parsed.data);
        if (settled === null) {
          setConflict({ latest, other });
          return;
        }
        if (settled === 'recovered') return;
      }
      proceed = true;
    } catch (e) {
      if (e instanceof AuthHandled) return;
      if (lastSent.current && isUncertain(e)) {
        // 応答の届かなかった送信があり、確かめる読み直しも通信できない。確かめずに送り直さない（設計 2.6）
        setError(null);
        setUnconfirmed(true);
        return;
      }
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
    setRestoredStamps(null);
    setRemote(null);
    setConflict(null);
    await write(counts);
  };

  /** ほかの人の数を入力にする（入力と下書きは捨てる） */
  const adopt = (rows: StockDbRow[]) => {
    setBase(rows);
    setRestoredStamps(null);
    setRemote(null);
    setCounts(countsFromRows(items, rows));
    writer.clear();
    setDraft(null);
    toast.info('ほかの人が保存した数を読み直しました');
  };

  /** ダイアログの「読み直す」。保存の直前に読み直した行はキャッシュに入っていないので、ここで入れる
   *  （「前回の入力」はキャッシュの行で出す）。一覧（数えたか）も古いので、保存の後と同じく読み直させる */
  const reloadLatest = () => {
    if (!conflict) return;
    const rows = conflict.latest;
    adopt(rows);
    setSeen(rows);
    setConflict(null);
    queryClient.setQueryData(queryKeys.yearPart(yearId, 'stocks', 'room', roomId), rows);
    for (const key of stockInvalidationKeys(yearId)) void queryClient.invalidateQueries({ queryKey: key });
  };

  useEffect(() => {
    if (phase !== 'idle' || !refocusSave.current) return;
    refocusSave.current = false;
    saveButtonRef.current?.focus();
  }, [phase]);

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
  const otherName = conflict?.other.by ? knownName(conflict.other.by, namesQ.data) : null;
  const remoteName = remote?.by ? knownName(remote.by, namesQ.data) : null;
  const prevFailed = hasPrev && prevQ.isError;
  // E2E が「読み込み終わった」を待つ印（部屋の行・前年・名前・振り分けの合計のどれかを読んでいる間は true）
  const fetching = stocksQ.isFetching || prevQ.isFetching || namesQ.isFetching || allocQ.isFetching;

  return (
    <div className={cn('mx-auto max-w-xl', access.writable && 'pb-4')} data-testid="stock-input" data-fetching={fetching ? 'true' : 'false'}>
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
              setRestoredStamps(draft.base);
              writer.write({ counts: restored, base: draft.base });
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
              if (access.shortfall !== 'none') void allocQ.refetch();
            }}
            onRetry={!unconfirmed && (classifyError(error).kind === 'network' || classifyError(error).kind === 'deadlock') ? () => void save() : undefined}
          />
        ) : null}
        {unconfirmed ? (
          <div role="alert" data-testid="stock-unconfirmed" className="flex gap-2 rounded-md border border-destructive/40 bg-destructive/5 px-4 py-3 text-sm">
            <AlertTriangle aria-hidden className="mt-0.5 size-4 shrink-0 text-destructive" />
            <div className="min-w-0 flex-1 space-y-2">
              <p className="font-medium text-destructive">保存できたか確かめられません。通信が戻ったら「確かめる」を押してください</p>
              <p className="text-xs text-muted-foreground">入力はそのまま残しています。確かめるまで保存は押せません（二重に送らないため）。</p>
              <Button size="sm" variant="outline" onClick={() => void confirmLastSave()} disabled={busy}>
                {phase === 'checking' ? '確かめています…' : '確かめる'}
              </Button>
            </div>
          </div>
        ) : null}
        {remote && dirty ? (
          <div role="status" data-testid="stock-remote-change" className="flex gap-2 rounded-md border border-amber-300 bg-amber-50 px-4 py-3 text-sm text-amber-950">
            <Info aria-hidden className="mt-0.5 size-4 shrink-0" />
            <div className="min-w-0 flex-1 space-y-2">
              <p>
                {remote.by ? (
                  remoteName ? (
                    <>
                      {remoteName}さんが <TokyoTime value={remote.by.countedAt} /> にこの部屋の数を保存しました。
                    </>
                  ) : (
                    <>
                      ほかの人が <TokyoTime value={remote.by.countedAt} /> にこの部屋の数を保存しました（名前は表示できません）。
                    </>
                  )
                ) : (
                  'ほかの人がこの部屋の数を保存しました。'
                )}
                入力はそのまま残しています。保存するときに、上書きするか読み直すかを選べます。
              </p>
              <Button size="sm" variant="outline" onClick={() => data && adopt(data)} disabled={busy}>
                ほかの人の数を読み直す
              </Button>
            </div>
          </div>
        ) : null}
        {prevFailed ? (
          <div role="alert" data-testid="stock-prev-error" className="flex gap-2 rounded-md border border-destructive/40 bg-destructive/5 px-4 py-3 text-sm">
            <AlertTriangle aria-hidden className="mt-0.5 size-4 shrink-0 text-destructive" />
            <div className="min-w-0 flex-1 space-y-2">
              <p className="font-medium text-destructive">前年の数を読み込めませんでした（{messageFor(classifyError(prevQ.error))}）</p>
              <Button size="sm" variant="outline" onClick={() => void prevQ.refetch()} disabled={prevQ.isFetching}>
                前年の数を読み直す
              </Button>
            </div>
          </div>
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
                    {hasPrev && !prevFailed ? (
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
                  size="lg"
                  label={`${item.name}の数`}
                  value={value}
                  onChange={(v) => change(item.id, v)}
                  disabled={!access.writable || busy}
                  className="shrink-0"
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
              {savedKind === 'recovered' ? '保存されていました' : '保存しました'}（<TokyoTime value={savedAt} format="time" />）
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
          <Button
            ref={saveButtonRef}
            size="lg"
            className="h-12 w-full text-base"
            onClick={() => void save()}
            disabled={busy || unconfirmed}
            aria-busy={busy || undefined}
          >
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
        <AlertDialogContent
          data-testid="stock-conflict-dialog"
          onCloseAutoFocus={(e) => {
            // 開いた元（「保存」）は Radix が知らないので、自分で戻す。上書きして送信中なら、終わってから戻す
            e.preventDefault();
            const b = saveButtonRef.current;
            if (b && !b.disabled) b.focus();
            else refocusSave.current = true;
          }}
        >
          <AlertDialogHeader>
            <AlertDialogTitle>ほかの人が先に保存しています</AlertDialogTitle>
            <AlertDialogDescription>
              {conflict?.other.by ? (
                otherName ? (
                  <>
                    {otherName}さんが <TokyoTime value={conflict.other.by.countedAt} /> に保存しています。
                  </>
                ) : (
                  <>
                    ほかの人が <TokyoTime value={conflict.other.by.countedAt} /> に保存しました（名前は表示できません）。
                  </>
                )
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
            {/* AlertDialogCancel にすると、開いたときに Radix がここへフォーカスを移す（Esc と同じく閉じるだけ） */}
            <AlertDialogCancel variant="ghost">やめる</AlertDialogCancel>
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
