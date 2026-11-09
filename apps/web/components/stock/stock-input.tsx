'use client';

// 在庫入力の部屋の画面（画面の設計 3.3、04「在庫入力」。T10）。スマホ（390px）を基本にする。
// - 表示：場所名、使用不可なら「今年は使用不可」と理由のメモ、前回入力した人と日時、品目ごとの行（品目名・＋－と数字・前年の数）。
// - 保存：部屋の全品目（0 を含む）を1回の upsert。counted_by・counted_at は DB が入れる。
// - 保存の前の読み直し（設計 2.6 の (A)。notes/T10.md の決めたことの 21）：保存は毎回、送る前にその部屋の stocks を読み直し、
//   decideStockSave で決める。全品目が入力と同じで、入力の元から行が変わっていれば送らずに「保存されていました」。入力の元から
//   変わった行に自分以外の人（counted_by）のものがあれば「上書きする」「読み直す」を選んでもらう。それ以外は読み直した行を
//   入力の元にして送る。応答が届かない・読み直しが通信できないときは、入力を残して unknownOutcomeMessage を出すだけで、
//   保存できたか分からない状態は持たない（数を絶対値で書くので、もう一度「保存」を押せば同じく読み直して決まる）。
// - 年度の状態とロールで書けるか（stockAccess）。部門長以上は振り分け中なら振り分けの合計より少なくなる品目を確かめ、確定中なら止める。
// - 最新でない年度なら保存の前に確かめる（useNotLatestYearConfirm）。入力の途中で離れるときは確かめ、入力は部屋ごとの下書きに残す。
//   下書きには入力の元にした行の updated_at も置き、戻した後の保存では、下書きを作った後のほかの人の保存も確かめる。
//   下書きは 500 ms まとめて書くほか、画面を外れる・pagehide・裏に回った（visibilitychange で hidden）ときにすぐ書き出す。
// 入力の守りと下書きの消し方は、次の4つの決まりだけで決める（notes/T10.md の決めたことの 22）。
// - R1 入力の守りの印（held）：この画面で数を変えた・下書きを戻した・「保存」を押したら立てる。立っている間は、裏で届いた行
//   （読み直し・invalidate・通信の復帰・キャッシュ）で入力・入力の元・戻した下書きの元を置き換えず、「ほかの人が保存しました」
//   （detectOtherSave）と「前回の入力」だけを新しくする。下ろすのは、保存が決まったとき（送って成功・「保存されていました」）と、
//   ほかの人の数を取ったとき（知らせ・ダイアログの「読み直す」）だけ（エラー・段階・ダイアログ・下書きの「捨てる」では変えない）。
//   印は書ける間だけ効かせる。書けなくなったら（読み取り専用）印を下ろし、届いた行で作り直す（入力は下書きに残る）。
//   そのとき、書くための状態（「保存できたか分かりません」・ほかの人の保存のダイアログ・振り分けの合計の確かめ）もすべて閉じ、
//   送る（「保存」の続き・「上書きする」）前にも書けるかを見る（書けなければ送らない・ダイアログを出さない）。
//   「保存していない」かは、入力の元と、届いた最新の行の両方と比べて決める（ほかの人の保存が届いた後に元の数へ戻しても未保存）。
//   保存していない入力はいつも下書きに写す（数を変えずに未保存になったとき〔ほかの人の保存が届いた・ダイアログを出した〕も書く。
//   戻していない下書きがあれば、「保存」を押して今の入力を選んだので、今の入力で置き換える）。
// - R2 「保存できたか分かりません」（unknownOutcome）は、次の保存が決まる（送った・「保存されていました」・ほかの人の保存の
//   ダイアログを出した）か、ほかの人の数を取るまで消さない。送る前の読み直しがコードつきで失敗しても残し、その失敗は toast で出す。
//   ただし書けなくなって届いた行で作り直すときは消す（入力が DB の数になるので「入力はそのまま残しています」が事実と違う。
//   押した数は送るときに下書きへ書いてあり、書けるときに開き直せば戻して「保存」で決められる）。
// - R3 下書きを消すのは、保存が決まったとき・「捨てる」・戻していない下書きがある間に届いた行の記録（updated_at）が下書きの
//   base から変わっていて、下書きを重ねても行と同じ数のとき（下書きの数が書かれた証拠がある）だけ。キャッシュに残った送る前の行
//   （記録が下書きの base と同じ）では消さない。ほかに、入力に保存していないものがなくなったら（入力の元とも届いた最新の行とも
//   同じ数。分からない間・ほかの人の保存を知らせている間を除く）書く中身がないので消す。「読み直す」は戻していない下書きを消さない。
//   戻していない下書きを今の入力で置き換えるのは、下書きを戻さずに「保存」を押した後に保存していない入力になったとき（R1）と送るとき。
// - R4 送る前の読み直し（「確かめています…」）の間に画面を離れたら、読み直しが返っても何もしない（送らない。入力は下書きにある）。
// 備品（数えるだけ。T22・D-60。04「在庫入力」の備品〔数えるだけ〕）：9 品目の下に「備品（数えるだけ）」の行（最初から出す物と
// 「その他」）を出す。同じ部屋の在庫と数をまとめて1つの入力として扱い（行のキーは品目の id と `c:<count_item_id>`。数の行は
// mergeRoomRows で在庫の行の形に写す）、上の R1〜R4・読み直し・ほかの人の保存・下書き・読み取り専用の決まりをそのまま当てる。
// 「＋ その他を足す」で足した行（added）は、数の行ができる（保存が決まる）までは数 0 でも保存していない入力として扱う。
// 「保存」は在庫の upsert の後に、出ている数の行を全部（0 を含む）upsert する（saveRoomLines）。在庫が通って数が失敗したときは、
// 在庫の保存は決まった（入力の元を保存した在庫の行にする）として、数は保存していない入力のまま残し、失敗を知らせる。
// 振り分けの合計の確かめ・確定中の守りは品目だけに効く。
import { useQueryClient } from '@tanstack/react-query';
import { AlertTriangle, Ban, CheckCircle2, Info } from 'lucide-react';
import { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react';
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
import type { CountItemRow, ItemRow, StockDbRow, YearRow } from '@/lib/db/types';
import {
  addCountItem,
  CountSaveError,
  countLinesUnchanged,
  countedByRoom,
  countsFromRows,
  decideStockSave,
  detectOtherSave,
  fetchRoomAllocated,
  fetchRoomLines,
  latestCounted,
  mergeRoomRows,
  nextUncountedRoom,
  placeOf,
  previousLineMap,
  roomCountStocksOptions,
  roomStocksOptions,
  sameCounts,
  saveRoomCountLines,
  saveRoomLines,
  shortfallMessage,
  shownCountItems,
  splitRoomRows,
  stocksAlreadySaved,
  stockMasterOptions,
  shortfalls,
  stockAccess,
  stockInvalidationKeys,
  stockPath,
  usePreviousYearCountStocks,
  usePreviousYearStocks,
  useProfileNames,
  useRoomAllocated,
  useRoomCountStocks,
  useRoomStocks,
  useYearStocks,
  type OtherSave,
  type Shortfall,
  type StockLine,
  type StorageRoom,
} from '@/lib/data/stocks';
import { createDraftWriter, draftKey as draftStorageKey, loadDraft, removeDraft, type DraftKey } from '@/lib/drafts';
import { appError, classifyError, effectOf, isUnknownOutcome, messageFor, unknownOutcomeMessage, type NameLookup } from '@/lib/errors';
import { queryKeys } from '@/lib/query';
import {
  countItemIdOf,
  countKey,
  stockCountsSchema,
  stockDraftSchema,
  type StockBaseStamps,
  type StockCounts,
  type StockDraft,
} from '@/lib/schemas/stock';
import { useUnsavedChanges } from '@/lib/unsaved-changes';
import { cn } from '@/lib/utils';
import { AddCountItemDialog } from './add-count-item-dialog';
import { countedName, knownName, type OpenYear } from './common';

type Phase = 'idle' | 'checking' | 'saving';

/** 保存の前の読み直しで 401 になり、セッションを更新できなかった（onAuthError が signOut まで済ませた） */
class AuthHandled extends Error {}

/** 行の updated_at（品目の id → updated_at） */
function stampsOf(rows: readonly StockDbRow[]): StockBaseStamps {
  return Object.fromEntries(rows.map((r) => [r.item_id, r.updated_at]));
}

interface Conflict {
  latest: StockDbRow[];
  other: OtherSave;
  /** 「保存」を押したときに確かめた数（「上書きする」はこれを送る。ダイアログの「あなた」もこれ） */
  values: StockCounts;
}

/** 入力の元の updated_at が同じか */
function sameStamps(a: StockBaseStamps, b: StockBaseStamps): boolean {
  const keys = Object.keys(a);
  return keys.length === Object.keys(b).length && keys.every((k) => a[k] === b[k]);
}

/**
 * 送っている upsert（下書きのキー → 終わると解決する Promise）。画面を離れても送信は続くので、開き直した画面の保存は、
 * これが終わってから読み直す（前の画面の送信が後から届いて、新しい保存を古い数で上書きしないため。送ったかの記録ではない）。
 */
const sendsInFlight = new Map<string, Promise<unknown>>();

/** 入力に下書きの数を重ねる（今の行にあるものだけ） */
function withDraft(items: readonly StockLine[], counts: StockCounts, draftCounts: StockCounts): StockCounts {
  return { ...counts, ...Object.fromEntries(items.filter((i) => i.id in draftCounts).map((i) => [i.id, draftCounts[i.id]!])) };
}

const NO_COUNT_ITEMS: CountItemRow[] = [];

/** 足したばかりで、まだ名前の一覧（場所・品目の読み込み）に入っていない物の並び（最後に出す） */
const EXTRA_SORT_ORDER = Number.MAX_SAFE_INTEGER;

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
  const answer = useCallback((ok: boolean) => {
    const r = resolver.current;
    resolver.current = null;
    r?.(ok);
    setList(null);
  }, []);
  return { list, ask, answer };
}

export function StockInput({
  open,
  year,
  target,
  storage,
  items,
  countItems = NO_COUNT_ITEMS,
}: {
  open: OpenYear;
  year: YearRow;
  target: StorageRoom;
  storage: StorageRoom[];
  items: ItemRow[];
  /** 備品（数えるだけ）の名前の一覧（並び → 名前 → id。T22） */
  countItems?: CountItemRow[];
}) {
  const yearId = year.id;
  const roomId = target.room.id;
  const queryClient = useQueryClient();
  const { reloadMembership } = useAuth();
  const onAuthError = useAuthErrorHandler();
  const notLatest = useNotLatestYearConfirm();
  const shortfallAsk = useShortfallAsk();
  const access = stockAccess(year.status, open.role);
  // 送る前に見る、今書けるか（「保存」の続きは押したときの描画の access を持っているので、最新の値を ref で見る。
  // 描き直しを確定したときに同期で入れ、読み直しが返るのが先にならないようにする）
  const writableRef = useRef(access.writable);
  useLayoutEffect(() => {
    writableRef.current = access.writable;
  }, [access.writable]);

  const stocksQ = useRoomStocks(yearId, roomId);
  const countQ = useRoomCountStocks(yearId, roomId);
  const prevQ = usePreviousYearStocks(yearId, year.prev_year_id);
  const prevCountQ = usePreviousYearCountStocks(yearId, year.prev_year_id);
  const allocQ = useRoomAllocated(yearId, roomId, access.shortfall !== 'none');
  const yearStocksQ = useYearStocks(yearId);
  const roomKey = roomStocksOptions(yearId, roomId).queryKey;
  const countRoomKey = roomCountStocksOptions(yearId, roomId).queryKey;

  // 入力の元にした行（ほかの人の保存を見分ける元）と入力中の数。行は在庫と数をまとめた形（mergeRoomRows）
  const [base, setBase] = useState<StockDbRow[] | null>(null);
  const [counts, setCounts] = useState<StockCounts | null>(null);
  // 届いた最新の部屋の行（R1 の印が立っている間は、入力の元より新しいことがある）。在庫と数の両方が届いてから
  const stocksData = stocksQ.data;
  const countData = countQ.data;
  const data = useMemo(() => (stocksData && countData ? mergeRoomRows(stocksData, countData) : undefined), [stocksData, countData]);

  // 備品（数えるだけ）：名前の一覧（足したばかりでまだ一覧にない物を後ろに足す）と、この画面で足した物（数の行ができるまで保存していない入力）
  const [extraItems, setExtraItems] = useState<CountItemRow[]>([]);
  const allCountItems = useMemo(
    () => [...countItems, ...extraItems.filter((x) => !countItems.some((c) => c.id === x.id))],
    [countItems, extraItems],
  );
  const [added, setAdded] = useState<string[]>([]);
  const [adding, setAdding] = useState(false);
  /** 出す行（品目と、出す備品〔数えるだけ〕）。extra は今の入力の元・届いた行のほかに見る行（保存の直前に読み直した行など） */
  const linesFor = (extra: readonly (readonly StockDbRow[] | null | undefined)[] = []) => {
    const shown = shownCountItems(allCountItems, [base, data, ...extra], added);
    const countLines = [...shown.always, ...shown.others];
    return {
      shown,
      countIds: countLines.map((c) => c.id),
      lines: [...items.map((i): StockLine => ({ id: i.id, name: i.name })), ...countLines.map((c): StockLine => ({ id: countKey(c.id), name: c.name }))],
    };
  };
  const { shown, lines } = linesFor();
  const baseCounts = base ? countsFromRows(lines, base) : null;
  const latestCounts = data ? countsFromRows(lines, data) : null;
  /** 足した物のうち、入力の元にまだ数の行がない物がある（数 0 でも保存していない入力） */
  const addedPending = !!base && added.some((id) => allCountItems.some((c) => c.id === id) && !base.some((r) => r.item_id === countKey(id)));
  /**
   * values に保存していないものがあるか：入力の元とも、届いた最新の行とも同じでなければある。印が立っている間は入力の元を
   * 新しくしないので、ほかの人の保存が届いた後に入力を古い元の数へ戻しても、最新の行と違えば保存していない入力のまま。
   * 足した物の行がまだなければ、それも保存していない入力
   */
  const unsavedIn = (values: StockCounts) =>
    !!baseCounts &&
    (addedPending || !sameCounts(lines, values, baseCounts) || (!!latestCounts && !sameCounts(lines, values, latestCounts)));
  const dirty = access.writable && !!counts && unsavedIn(counts);
  // 下書きを戻したときは、入力の元が「下書きを作ったときの行」になる（null なら base が元）。
  // 保存の直前に読み直した行とこれを比べるので、下書きを作った後のほかの人の保存も確かめられる
  const [restoredStamps, setRestoredStamps] = useState<StockBaseStamps | null>(null);
  const stamps = useMemo(() => restoredStamps ?? (base ? stampsOf(base) : null), [restoredStamps, base]);

  const [phase, setPhase] = useState<Phase>('idle');
  /** 応答が届いた失敗・入力の誤り（ErrorBanner で出す） */
  const [error, setError] = useState<unknown>(null);
  /** error の文言の文脈の表（数の保存の失敗なら count_stocks。23503 の文言を分ける） */
  const [errorTable, setErrorTable] = useState<string | undefined>(undefined);
  const [blocked, setBlocked] = useState<Shortfall[] | null>(null);
  const [conflict, setConflict] = useState<Conflict | null>(null);
  const [remote, setRemote] = useState<OtherSave | null>(null);
  // R1 入力の守りの印（上の決まり）
  const [held, setHeld] = useState(false);
  // R2 保存できたか分からない（2.6 の (A) の 1）。入力の元と同じ数でも、保存していない入力として扱う
  // （離れるときに確かめ、下書きに残し、「保存していない変更があります」を出す）
  const [unknownOutcome, setUnknownOutcome] = useState(false);
  const unsaved = dirty || (access.writable && unknownOutcome);
  useUnsavedChanges(unsaved);

  // 下書き（部屋ごと。カメラで次の QR を読んだ・別のアプリへ行った・タブが捨てられた後に戻せる）
  const draftKey = useMemo<DraftKey>(() => ({ userId: open.userId, yearId, screen: 'stock', target: roomId }), [open.userId, yearId, roomId]);
  const writer = useMemo(() => createDraftWriter<StockDraft>(draftKey), [draftKey]);
  const storageKey = draftStorageKey(draftKey);
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
  // まだ戻していない（捨ててもいない）下書き。入力に触れる・戻す・捨てる・送ると null（null でない間は、入力は読み込んだ行のまま）
  const [draft, setDraft] = useState(() => {
    const d = loadDraft<unknown>(draftKey);
    if (!d) return null;
    const parsed = stockDraftSchema.safeParse(d.value);
    if (!parsed.success) {
      removeDraft(draftKey);
      return null;
    }
    return { savedAt: d.savedAt, ...parsed.data };
  });
  /**
   * R3 (c)：戻していない下書きの数が rows（届いた部屋の行）に書かれた証拠があるか。行の記録（updated_at。counted_at が変われば
   * これも変わる）が下書きの base から変わっていて、しかも下書きを重ねても rows と同じ数のとき。キャッシュに残った送る前の行は
   * 記録が base と同じなので、数が同じに見えても証拠にしない
   */
  /** 下書きの行のうち、今の一覧にある物（品目と備品〔数えるだけ〕。消えた物は捨てる） */
  const knownKey = (k: string) => {
    const ci = countItemIdOf(k);
    return ci === null ? items.some((i) => i.id === k) : allCountItems.some((c) => c.id === ci);
  };
  /** 下書きにあって今出ていない備品（数えるだけ）の id（戻すと「その他」に足す） */
  const draftExtraIds = draft
    ? Object.keys(draft.counts)
        .filter((k) => knownKey(k) && !lines.some((l) => l.id === k))
        .flatMap((k) => {
          const ci = countItemIdOf(k);
          return ci === null ? [] : [ci];
        })
    : [];
  const draftLines: StockLine[] = [
    ...lines,
    ...draftExtraIds.map((ci) => ({ id: countKey(ci), name: allCountItems.find((c) => c.id === ci)?.name ?? '' })),
  ];
  const draftWritten = (rows: readonly StockDbRow[]) => {
    if (!draft || sameStamps(draft.base, stampsOf(rows))) return false;
    // 下書きの備品（数えるだけ）の行が届いた行にない（まだ書かれていない）なら、下書きの数が書かれた証拠にしない
    if (Object.keys(draft.counts).some((k) => countItemIdOf(k) !== null && knownKey(k) && !rows.some((r) => r.item_id === k))) return false;
    const fromRows = countsFromRows(draftLines, rows);
    return sameCounts(draftLines, withDraft(draftLines, fromRows, draft.counts), fromRows);
  };

  // 部屋の行が届いたら（初めて読めた、ErrorBanner の「読み直す」、キャッシュから開いた後の裏の読み直し、通信の復帰、
  // 自分の保存の後の invalidate など）：R3 の (c) で下書きを確かめ、R1 の印がなければその行で作り直す。印があれば入力も
  // 入力の元も残し、自分以外の人が保存していれば知らせる（保存のときに元の行と読み直した行を比べるので、上書きするか選べる）
  const [seen, setSeen] = useState<StockDbRow[] | null>(null);
  /** rows（届いた部屋の行）で入力と入力の元を作り直す */
  const rebuild = (rows: StockDbRow[]) => {
    setBase(rows);
    setCounts(countsFromRows(linesFor([rows]).lines, rows));
    setRestoredStamps(null);
    setRemote(null);
  };
  if (data && data !== seen) {
    setSeen(data);
    if (draftWritten(data)) {
      removeDraft(draftKey);
      setDraft(null);
    }
    if (base === null || !held) rebuild(data);
    else if (stamps) setRemote(detectOtherSave(linesFor([data]).lines, stamps, data, open.userId));
  }
  // R1：印は書ける間だけ効かせる。書けなくなったら（部員の振り分け中・終了など。保存の失敗や年度の読み直しで切り替わる）
  // 印を下ろし、届いた行で作り直す（読み取り専用の画面に DB にない数を出さない）。入力は数を変えたときに下書きへ書いているので、
  // 書けるときに開き直せば戻せる。書けない間は数を変える・戻す・「保存」ができないので、印は立たない。
  // 書くための状態も残さない：「保存できたか分かりません」（R2。入力が DB の数になるので、また書けるようになったときに出すと
  // 「保存」で押していない数を確かめることになる）と、ほかの人の保存のダイアログ（「上書きする」は RLS が拒む）を閉じる
  const writeStateWhileReadOnly = !access.writable && (held || unknownOutcome || conflict !== null);
  if (writeStateWhileReadOnly) {
    setHeld(false);
    setUnknownOutcome(false);
    setConflict(null);
    // 足した物も入力なので捨てる（下書きに残る）
    setAdded([]);
    const rows = data ?? base;
    if (rows) rebuild(rows);
  }
  // 振り分けの合計の確かめを開いている間に書けなくなったら、「やめる」と同じく閉じる（「保存」の続きは送らずに終わる）
  const answerShortfall = shortfallAsk.answer;
  useEffect(() => {
    if (!access.writable) answerShortfall(false);
  }, [access.writable, answerShortfall]);
  // ほかの人の保存のダイアログを閉じたら「保存」へフォーカスを戻す（送信中で押せなければ、終わってから戻す）
  const saveButtonRef = useRef<HTMLButtonElement>(null);
  const refocusSave = useRef(false);

  const showDraft =
    access.writable && !!draft && !!counts && (draftExtraIds.length > 0 || !sameCounts(draftLines, { ...counts, ...draft.counts }, counts));
  const writeDraft = (values: StockCounts, baseStamps: StockBaseStamps) => writer.write({ counts: values, base: baseStamps });
  // 保存していない入力（unsaved）は、いつも下書きに写す（画面の設計 1.4。離れるときの確かめは「入力は下書きに残り…戻せます」と言う）。
  // 数を変えた・戻した・送るときは各操作で書くが、数を変えずに未保存になるとき（印が立っている間にほかの人の保存が届いた・
  // ダイアログを出した・「保存できたか分かりません」になった）もここで書く。元は入力の元（戻した下書きならその base）なので、
  // 開き直すと最新の行と比べて「戻す」が出て、戻して保存すればほかの人の保存のダイアログで選べる。
  // 戻していない下書き（draft）があるまま未保存になるのは、下書きを戻さずに「保存」を押した後だけ（印が立っていなければ、届いた行で
  // 作り直すので未保存にならない）。「保存」を押したことで今の入力を選んだので、write と同じく戻していない下書きは使わず、今の入力で
  // 置き換える（R3。古い下書きを残すと、離れた後の「戻す」で、「保存」を押した入力でなく古い数が戻る）
  // 届いた行で作り直す・書けなくなって作り直す描画（上の2つ。この描画の値は捨てられて描き直される）では見ない（作り直す前の入力の元と
  // 届いた行を比べると、未保存に見える）
  const rebuilding = (!!data && data !== seen) || writeStateWhileReadOnly;
  if (!rebuilding && unsaved && draft) setDraft(null);
  useEffect(() => {
    if (unsaved && !draft && counts && stamps) writer.write({ counts, base: stamps });
  }, [unsaved, draft, counts, stamps, writer]);

  const [savedAt, setSavedAt] = useState<string | null>(null);
  /** 保存の表示：saved（今送って保存した）・recovered（読み直したら保存されていた） */
  const [savedKind, setSavedKind] = useState<'saved' | 'recovered'>('saved');
  // 画面を離れた後も送信は続く。離れた後は、送信の結果で知らせたり下書きを変えたりしない（開き直した画面と同じキーの下書きを消さない）
  const mounted = useRef(true);
  useEffect(() => {
    mounted.current = true;
    return () => {
      mounted.current = false;
    };
  }, []);

  // 「前回の入力」は今の DB の行（入力を残して元の行を変えないときも、読み直した行で出す）
  const last = data ? latestCounted(data) : base ? latestCounted(base) : null;
  const namesQ = useProfileNames(yearId, [last?.countedBy ?? null, conflict?.other.by?.countedBy ?? null, remote?.by?.countedBy ?? null]);
  const prev = useMemo(() => (prevQ.data && prevCountQ.data ? previousLineMap(prevQ.data, prevCountQ.data) : null), [prevQ.data, prevCountQ.data]);
  const hasPrev = !!year.prev_year_id;
  const itemName = new Map(lines.map((i) => [i.id, i.name]));
  // 行は描画ごとに変わりうる（備品〔数えるだけ〕の行が増える）ので、名前の引き方も描画ごとに作る
  const names: NameLookup = {
    room: (id) => (id === roomId ? target.room.name : storage.find((s) => s.room.id === id)?.room.name),
    item: (id) => itemName.get(id),
  };

  const change = (itemId: string, value: number) => {
    if (!counts) return;
    const next = { ...counts, [itemId]: value };
    setCounts(next);
    setHeld(true);
    setDraft(null);
    setSavedAt(null);
    setBlocked(null);
    // 保存していないものがなくなったら（入力の元とも、届いた最新の行とも同じ数）、下書きに書く中身がないので消す（印は下ろさない）。
    // 保存できたか分からない間（送った数が入っていれば、戻した数を送り直す入力になる）と、ほかの人の保存を知らせている間
    // （入力はほかの人の数と比べて選ぶまで守る）は下書きに残す（R3）
    if (baseCounts && !unknownOutcome && !remote && !unsavedIn(next)) writer.clear();
    else if (stamps) writeDraft(next, stamps);
  };

  /** 「＋ その他を足す」で物を足す（数 0 の行を出し、保存していない入力にする。もう出ていれば何もしない） */
  const addLine = (countItemId: string) => {
    if (!counts || !stamps || lines.some((l) => l.id === countKey(countItemId))) return;
    const next = { ...counts, [countKey(countItemId)]: 0 };
    setAdded((a) => (a.includes(countItemId) ? a : [...a, countItemId]));
    setCounts(next);
    setHeld(true);
    setDraft(null);
    setSavedAt(null);
    setBlocked(null);
    writeDraft(next, stamps);
  };

  /**
   * 「新しい名前で足す」（RPC add_count_item。同じ名前ならその id が返る）。足せたら行を出して null、足せなければ文言を返す。
   * 同じ名前なら同じ id が返るので、応答が届かなかったときは確かめずにもう一度押してもらう（2.6。行は二重にならない）
   */
  const createCountItem = async (name: string, retried = false): Promise<string | null> => {
    try {
      const newId = await addCountItem(yearId, name);
      if (!allCountItems.some((c) => c.id === newId)) {
        setExtraItems((xs) => [...xs, { id: newId, name, always_shown: false, sort_order: EXTRA_SORT_ORDER, updated_at: '' }]);
      }
      // 名前の一覧（場所・品目の読み込み）を読み直す（ほかの部屋・翌年の選択肢にも出る）
      void queryClient.invalidateQueries({ queryKey: stockMasterOptions(yearId).queryKey });
      addLine(newId);
      return null;
    } catch (e) {
      const c = classifyError(e);
      if (c.kind === 'auth') {
        if (!retried && (await onAuthError(e)) === 'retry') return createCountItem(name, true);
        return messageFor(c);
      }
      if (effectOf(c).reload === 'year') {
        void queryClient.invalidateQueries({ queryKey: queryKeys.yearRow(yearId) });
        reloadMembership();
      }
      if (isUnknownOutcome(e)) return '足せたか分かりません。もう一度「新しい名前で足す」を押してください（同じ名前は二重になりません）';
      return messageFor(c, { rpc: 'add_count_item' });
    }
  };

  /**
   * 保存の流れの失敗。応答が届かない・読み直しが通信できないときは unknownOutcome（設計 2.6 の (A) の 1・4）。応答が届いた失敗は
   * ErrorBanner に出すが、keepUnknown（「保存できたか分かりません」を出したまま確かめ始めた）なら知らせを残して toast で出す（R2）
   */
  const handleError = async (e: unknown, keepUnknown: boolean, table?: string) => {
    const c = classifyError(e);
    if (c.kind === 'auth') {
      // 'retry' でも自動では送り直さない（もう一度「保存」を押してもらう）。'signedOut' なら /login へ移る（下書きは残る）
      await onAuthError(e);
      return;
    }
    if (isUnknownOutcome(e)) setUnknownOutcome(true);
    else if (keepUnknown) toast.error(messageFor(c, { names, table }));
    else {
      setErrorTable(table);
      setError(e);
    }
    const eff = effectOf(c);
    if (eff.reload === 'year') {
      void queryClient.invalidateQueries({ queryKey: queryKeys.yearRow(yearId) });
      reloadMembership();
    } else if (eff.reload === 'data') {
      for (const key of stockInvalidationKeys(yearId)) void queryClient.invalidateQueries({ queryKey: key });
    }
  };

  /** 入力の元を rows（今の DB の部屋の行）にする。キャッシュにも入れる（「前回の入力」はキャッシュの行で出す） */
  const rebase = (rows: StockDbRow[]) => {
    setBase(rows);
    setSeen(rows);
    setRestoredStamps(null);
    setRemote(null);
    setRoomCache(rows);
  };
  /** 部屋の在庫と数のキャッシュに rows（mergeRoomRows の形）を入れる */
  const setRoomCache = (rows: readonly StockDbRow[]) => {
    const split = splitRoomRows(rows);
    queryClient.setQueryData(roomKey, split.stocks);
    queryClient.setQueryData(countRoomKey, split.counts);
  };
  const invalidateStocks = () => {
    for (const key of stockInvalidationKeys(yearId)) void queryClient.invalidateQueries({ queryKey: key });
  };

  /** 保存できた（今送った・読み直したら保存されていた）後の片づけ。rows が今の DB の部屋の行 */
  const finishSaved = (rows: StockDbRow[], kind: 'saved' | 'recovered') => {
    setError(null);
    setUnknownOutcome(false);
    setHeld(false);
    writer.clear();
    setDraft(null);
    rebase(rows);
    setCounts(countsFromRows(linesFor([rows]).lines, rows));
    // 足した物は数の行ができたので、ふつうの「その他」の行になる
    setAdded([]);
    setSavedKind(kind);
    setSavedAt(kind === 'recovered' ? (latestCounted(rows)?.countedAt ?? new Date().toISOString()) : new Date().toISOString());
    toast.success(kind === 'recovered' ? '保存されていました' : '保存しました');
    invalidateStocks();
  };

  /**
   * 数の保存が 23503（出していた物がマスタ設定から削除された）のとき：名前の一覧（場所・品目の読み込み）を読み直し、消えた物を
   * 足したばかりの物（extraItems）と足した物（added）から外す（最初から出す物は読み直した一覧で消える）。次の「保存」は残った行だけを送る
   */
  const dropDeletedCountItems = async () => {
    try {
      const master = await queryClient.fetchQuery({ ...stockMasterOptions(yearId), staleTime: 0 });
      const ids = new Set(master.countItems.map((c) => c.id));
      setExtraItems((xs) => xs.filter((x) => ids.has(x.id)));
      setAdded((a) => a.filter((x) => ids.has(x)));
    } catch {
      // 読み直せなければ、次に読み直したときに外れる（失敗の文言は数の保存の失敗として出す）
      void queryClient.invalidateQueries({ queryKey: stockMasterOptions(yearId).queryKey });
    }
  };

  /** values を送る。latest は送る前に読み直した部屋の行（入力の元にする。設計 2.6 の (A) の 4） */
  const write = async (values: StockCounts, latest: StockDbRow[], retried = false, stocksSaved = false): Promise<void> => {
    // 送る前に書けるかを見る（読み直しやダイアログの間に書けなくなっていれば送らない。入力は下書きにある）
    if (!writableRef.current) {
      setPhase('idle');
      return;
    }
    // 送ると決まったので、前の「保存できたか分かりません」は消す（この送信の結果で決まる。R2）。印は成功まで残す（R1）
    setError(null);
    setUnknownOutcome(false);
    setPhase('saving');
    rebase(latest);
    // 戻していない下書きは、今の入力を送ると決めたので使わない。送っている間に離れても入力を戻せるよう、元を latest にして書き切る
    setDraft(null);
    writeDraft(values, stampsOf(latest));
    writer.flush();
    // 在庫の upsert の後に、出ている数の行を全部（0 を含む）upsert する（読み直した行に増えた物も含める）
    // 在庫がもう自分の保存なら（応答が届かなかった在庫の upsert が入っていた）、在庫は送り直さず数だけを送る
    const countIds = linesFor([latest]).countIds;
    const sending = stocksSaved
      ? saveRoomCountLines(yearId, roomId, splitRoomRows(latest).stocks, countIds, values)
      : saveRoomLines(yearId, roomId, items, countIds, values);
    const inFlight = sending.catch(() => undefined);
    sendsInFlight.set(storageKey, inFlight);
    try {
      const rows = await sending;
      if (mounted.current) finishSaved(rows, stocksSaved ? 'recovered' : 'saved');
      else {
        // 離れた後に届いた：下書きがこの送信で書いたまま（送った数と、送る前に読み直した行）なら、保存できたので消す。
        // 違えば開き直した画面が書き直した下書きなので残す
        const d = loadDraft<unknown>(draftKey);
        const parsedDraft = d ? stockDraftSchema.safeParse(d.value) : null;
        const sentLines = linesFor([latest]).lines;
        if (parsedDraft?.success && sameCounts(sentLines, parsedDraft.data.counts, values) && sameStamps(parsedDraft.data.base, stampsOf(latest))) {
          removeDraft(draftKey);
        }
        invalidateStocks();
      }
    } catch (thrown) {
      if (!mounted.current) {
        // 在庫は保存できた（数だけ失敗）なら、一覧などを読み直す（下書きは残す：数は保存していない）
        if (thrown instanceof CountSaveError) invalidateStocks();
        return;
      }
      let e = thrown;
      let next = latest;
      const countFailed = thrown instanceof CountSaveError;
      if (thrown instanceof CountSaveError) {
        // 在庫の保存は決まった：入力の元を保存した在庫の行と、送る前に読み直した数の行にする。数は保存していない入力として残し
        // （印も残す。R1）、下書きもその元で書き直す。失敗は数の保存の失敗として出す
        next = mergeRoomRows(thrown.stocks, splitRoomRows(latest).counts);
        rebase(next);
        writeDraft(values, stampsOf(next));
        // 数の応答が届かなかったときは、数は入っているかもしれないので「まだ保存していません」とは言わない（「保存できたか分かりません」を出す）
        toast.info(isUnknownOutcome(thrown.cause) ? '在庫の数は保存しました' : '在庫の数は保存しました。備品（数えるだけ）の数はまだ保存していません');
        invalidateStocks();
        e = thrown.cause;
        if (classifyError(e).kind === 'blocked') await dropDeletedCountItems();
      }
      // 401：セッションを更新できたら同じ要求を1回だけ送り直す（stocks・count_stocks の upsert は同じ値で何度送っても同じ。2.6）。
      // 在庫がもう保存できていれば（数だけ失敗）、在庫は送り直さず数だけを送る
      if (classifyError(e).kind === 'auth' && !retried) {
        if ((await onAuthError(e)) === 'retry') return write(values, next, true, stocksSaved || countFailed);
        return;
      }
      await handleError(e, false, countFailed ? 'count_stocks' : undefined);
    } finally {
      if (sendsInFlight.get(storageKey) === inFlight) sendsInFlight.delete(storageKey);
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

  const save = async () => {
    if (!counts || !base || !stamps || phase !== 'idle' || !access.writable) return;
    // R1：「保存」を押したら入力を守る（確かめの途中・やめた・止まった・ダイアログの間も、裏で届いた行で置き換えない）
    setHeld(true);
    setBlocked(null);
    const parsed = stockCountsSchema.safeParse(counts);
    if (!parsed.success) {
      setErrorTable(undefined);
      setError(appError('input', 'client_validation', { field: 'count' }));
      return;
    }
    writer.flush();
    if (!(await notLatest.confirmBeforeWrite())) return;
    // 前の失敗は確かめ始めるときに消す。「保存できたか分かりません」は別に持ち、保存が決まるまで残す（R2）
    const keepUnknown = unknownOutcome;
    setError(null);
    setPhase('checking');
    // R4：確かめの途中で画面を離れたら、読み直しが返っても何もしない。書けなくなったときも同じく何もしない（R1。送らない・
    // ダイアログを出さない。印と「分かりません」は書けなくなったときに下ろしている。入力は下書きにある）
    const gone = () => !mounted.current || !writableRef.current;
    // 送ると決まったら、送る前に読み直した部屋の行が入る
    let latest: StockDbRow[] | null = null;
    let stocksSaved = false;
    try {
      // 前の画面（離れた画面）の送信が残っていれば、終わってから読み直す
      await sendsInFlight.get(storageKey);
      if (gone()) return;
      if (access.shortfall !== 'none') {
        // 振り分けの合計は保存の直前に読み直す（DB の確定中の守りと同じ条件を先に確かめる）
        const allocated = await fresh(() => fetchRoomAllocated(yearId, roomId));
        if (gone()) return;
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
      // 毎回、送る前に部屋の行を読み直して決める（設計 2.6 の (A) の 2〜4）
      const rows = await fresh(() => fetchRoomLines(yearId, roomId));
      if (gone()) return;
      const rowLines = linesFor([rows]).lines;
      const decided = decideStockSave(rowLines, parsed.data, stamps, rows, open.userId);
      // 在庫は自分の保存が入っていて、数だけがまだ（在庫の応答が届かず数を送っていなかった）なら、数だけを送る
      const stocksDone = decided.kind !== 'conflict' && stocksAlreadySaved(items, parsed.data, stamps, rows, open.userId);
      // 全体では「保存されていた」でも、変わったのが在庫だけで数の行が入力の元から1つも変わっていなければ、数はまだ送っていない
      // （前からある数の行が入力と同じ数なだけ）。数を送って数え直しの記録を残す
      const decision = decided.kind === 'saved' && stocksDone && countLinesUnchanged(rowLines, stamps, rows) ? ({ kind: 'send' } as const) : decided;
      if (decision.kind === 'saved') {
        finishSaved(rows, 'recovered');
      } else if (decision.kind === 'conflict') {
        // ほかの人の保存のダイアログを出したら、前の「保存できたか分かりません」は決まった（R2）。印は残す（R1）
        setUnknownOutcome(false);
        setConflict({ latest: rows, other: decision.other, values: parsed.data });
        // やめた後も「ほかの人が保存しました」を出し、入力を残す（ほかの人の数にするのは「読み直す」だけ）。
        // 知らせの「ほかの人の数を読み直す」と「前回の入力」が今読み直した行を使うよう、キャッシュにも入れる
        setRemote(decision.other);
        setRoomCache(rows);
      } else {
        latest = rows;
        stocksSaved = stocksDone;
      }
    } catch (e) {
      // 読み直しが通信できなければ送らずに unknownOutcomeMessage を出す（(A) の 4）。コードつきの失敗は、知らせを出していれば
      // 残して toast で出す（R2）
      if (!gone() && !(e instanceof AuthHandled)) await handleError(e, keepUnknown);
    } finally {
      if (!latest) setPhase('idle');
    }
    if (latest) await write(parsed.data, latest, false, stocksSaved);
  };

  /** ダイアログの「上書きする」：読み直した行を入力の元にして、「保存」を押したときの数で送る */
  const overwrite = async () => {
    if (!conflict || !writableRef.current) return;
    const { latest, values } = conflict;
    setConflict(null);
    await write(values, latest);
  };

  /**
   * ほかの人の数を入力にする（今の入力の下書きは捨てる）。rows は今の DB の部屋の行。利用者がほかの人の数を取ったので、印を下ろし（R1）、
   * 「保存できたか分かりません」も消す（ダイアログの「読み直す」はダイアログを出したときに消えている。知らせの「ほかの人の数を
   * 読み直す」も同じく、押した数を捨てると決めたので、残すと「入力はそのまま残しています」が事実と違う）
   */
  const adopt = (rows: StockDbRow[]) => {
    setError(null);
    setUnknownOutcome(false);
    setHeld(false);
    rebase(rows);
    setCounts(countsFromRows(linesFor([rows]).lines, rows));
    // 足した物も捨てる（ほかの人の数にする）
    setAdded([]);
    // 戻していない前の下書き（draft。知らせが出ている）は、利用者が戻すか捨てるかを選ぶまで残す（R3）。ストレージにあるのは
    // その下書きのまま（数を変える・戻す・送る・保存していない入力になると draft は null になる）なので、消すのは今の入力の分だけ
    if (!draft) writer.clear();
    toast.info('ほかの人が保存した数を読み直しました');
  };

  /** ダイアログの「読み直す」。保存の直前に読み直した行を入力にする。一覧（数えたか）も古いので、保存の後と同じく読み直させる */
  const reloadLatest = () => {
    if (!conflict) return;
    adopt(conflict.latest);
    setConflict(null);
    invalidateStocks();
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

  const roomFailed = stocksQ.isError ? stocksQ : countQ.isError ? countQ : null;
  if (roomFailed && !base) {
    return (
      <>
        <PageHeader title="在庫入力" />
        <ErrorState
          message={messageFor(classifyError(roomFailed.error))}
          onRetry={() => {
            void stocksQ.refetch();
            void countQ.refetch();
          }}
        />
      </>
    );
  }

  const busy = phase !== 'idle';
  const otherName = conflict?.other.by ? knownName(conflict.other.by, namesQ.data) : null;
  const remoteName = remote?.by ? knownName(remote.by, namesQ.data) : null;
  const prevFailed = hasPrev && (prevQ.isError || prevCountQ.isError);
  const prevError = prevQ.isError ? prevQ.error : prevCountQ.error;
  const prevPending = prevQ.isPending || prevCountQ.isPending;
  // E2E が「読み込み終わった」を待つ印（部屋の行・前年・名前・振り分けの合計のどれかを読んでいる間は true）
  const fetching =
    stocksQ.isFetching || countQ.isFetching || prevQ.isFetching || prevCountQ.isFetching || namesQ.isFetching || allocQ.isFetching;
  const shownIds = new Set([...shown.always, ...shown.others].map((c) => c.id));

  /** 1行（品目か備品〔数えるだけ〕）。allocated は品目だけ（振り分けの合計） */
  const lineRow = (line: StockLine, kind: 'item' | 'count') => {
    const allocated = kind === 'item' ? (allocQ.data?.get(line.id) ?? 0) : 0;
    const value = counts?.[line.id] ?? 0;
    // 備品（数えるだけ）は数の行がなければ前年も 0（04「在庫入力」。在庫一覧の表の前年との差と同じ）。品目は行がなければ「—」
    const prevCount = prev?.get(`${roomId}:${line.id}`) ?? (kind === 'count' && prev ? 0 : undefined);
    return (
      <li
        key={line.id}
        data-testid={kind === 'item' ? 'stock-item-row' : 'count-item-row'}
        {...(kind === 'item' ? { 'data-item-id': line.id } : { 'data-count-item-id': countItemIdOf(line.id) ?? '' })}
        className="flex items-center gap-3 px-3 py-3"
      >
        <div className="min-w-0 flex-1">
          <p className="font-medium break-words">{line.name}</p>
          <p className="flex flex-wrap gap-x-3 text-xs text-muted-foreground">
            {hasPrev && !prevFailed ? (
              <span data-testid="stock-prev">前年 {prevPending ? '…' : prevCount === undefined ? '—' : prevCount}</span>
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
          label={`${line.name}の数`}
          value={value}
          onChange={(v) => change(line.id, v)}
          disabled={!access.writable || busy}
          className="shrink-0"
        />
      </li>
    );
  };
  const countLine = (c: CountItemRow): StockLine => ({ id: countKey(c.id), name: c.name });

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
              const restored = withDraft(draftLines, counts!, draft.counts);
              // 下書きにあって今出ていない備品（数えるだけ）は、足した物として「その他」に出す
              if (draftExtraIds.length > 0) setAdded((a) => [...a, ...draftExtraIds.filter((x) => !a.includes(x))]);
              setCounts(restored);
              setHeld(true);
              setRestoredStamps(draft.base);
              writeDraft(restored, draft.base);
              setDraft(null);
            }}
            onDiscard={() => {
              // 消すのは下書きだけ（R1 の印は変えない。知らせが出ている間に印が立っているのは「保存」を押したときだけで、
              // 保存はまだ決まっていない）
              writer.clear();
              setDraft(null);
            }}
          />
        ) : null}
        {access.writable && unknownOutcome ? (
          // 応答が届かず保存できたか分からない・保存の前の読み直しが通信できない（設計 2.6 の (A) の 1・4）。
          // 確かめるためのボタンは置かない（「保存」を押せば、送る前に読み直して決まる）
          <div role="alert" data-testid="stock-unknown-outcome" className="flex gap-2 rounded-md border border-destructive/40 bg-destructive/5 px-4 py-3 text-sm">
            <AlertTriangle aria-hidden className="mt-0.5 size-4 shrink-0 text-destructive" />
            <div className="min-w-0 flex-1 space-y-1">
              <p className="font-medium text-destructive">{unknownOutcomeMessage()}</p>
              <p className="text-xs text-muted-foreground">入力はそのまま残しています。</p>
            </div>
          </div>
        ) : null}
        {error ? (
          <ErrorBanner
            error={error}
            context={{ names, table: errorTable }}
            onReload={() => {
              setError(null);
              void stocksQ.refetch();
              if (access.shortfall !== 'none') void allocQ.refetch();
            }}
            onRetry={classifyError(error).kind === 'deadlock' ? () => void save() : undefined}
          />
        ) : null}
        {access.writable && remote ? (
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
              <p className="font-medium text-destructive">前年の数を読み込めませんでした（{messageFor(classifyError(prevError))}）</p>
              <Button
                size="sm"
                variant="outline"
                onClick={() => {
                  if (prevQ.isError) void prevQ.refetch();
                  if (prevCountQ.isError) void prevCountQ.refetch();
                }}
                disabled={prevQ.isFetching || prevCountQ.isFetching}
              >
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
        <>
          <ul className="divide-y rounded-lg border" aria-label="品目ごとの数">
            {items.map((item) => lineRow({ id: item.id, name: item.name }, 'item'))}
          </ul>
          {allCountItems.length > 0 ? (
            <section aria-labelledby="count-items-heading" className="mt-6 space-y-2" data-testid="count-items-section">
              <h3 id="count-items-heading" className="text-base font-semibold">
                備品（数えるだけ）
              </h3>
              <p className="text-xs text-muted-foreground">数えるだけの物です（申請・振り分けには使いません）。</p>
              {shown.always.length > 0 ? (
                <ul className="divide-y rounded-lg border" aria-label="備品（数えるだけ）の数">
                  {shown.always.map((c) => lineRow(countLine(c), 'count'))}
                </ul>
              ) : null}
              <h4 className="pt-2 text-sm font-semibold">その他</h4>
              {shown.others.length > 0 ? (
                <ul className="divide-y rounded-lg border" aria-label="その他の数">
                  {shown.others.map((c) => lineRow(countLine(c), 'count'))}
                </ul>
              ) : (
                <p className="text-sm text-muted-foreground" data-testid="count-others-empty">
                  この場所で数えたその他の物はありません。
                </p>
              )}
              {access.writable ? (
                <Button type="button" variant="outline" className="h-11 w-full" onClick={() => setAdding(true)} disabled={busy} data-testid="count-item-add">
                  ＋ その他を足す
                </Button>
              ) : null}
            </section>
          ) : null}
        </>
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
          {unsaved ? <p className="mb-2 text-xs text-amber-700">保存していない変更があります</p> : null}
          <Button
            ref={saveButtonRef}
            size="lg"
            className="h-12 w-full text-base"
            onClick={() => void save()}
            disabled={busy}
            aria-busy={busy || undefined}
          >
            {phase === 'saving' ? '保存中…' : phase === 'checking' ? '確かめています…' : '保存'}
          </Button>
        </div>
      ) : null}

      {notLatest.dialog}

      {access.writable ? (
        <AddCountItemDialog
          open={adding}
          onOpenChange={setAdding}
          countItems={allCountItems}
          shownIds={shownIds}
          onPick={addLine}
          onCreate={(name) => createCountItem(name)}
        />
      ) : null}

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
            // 書けなくなって閉じたときは「保存」がないので戻さない
            const b = saveButtonRef.current;
            if (b && !b.disabled) b.focus();
            else if (b) refocusSave.current = true;
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
          {conflict ? (
            <table className="w-full text-sm">
              <thead>
                <tr className="border-b text-left text-muted-foreground">
                  <th className="py-1 font-normal">品目</th>
                  <th className="py-1 text-right font-normal">{otherName ? `${otherName}さん` : 'ほかの人'}</th>
                  <th className="py-1 text-right font-normal">あなた</th>
                </tr>
              </thead>
              <tbody>
                {lines.map((i) => {
                  const theirs = conflict.latest.find((r) => r.item_id === i.id)?.count;
                  const mine = conflict.values[i.id] ?? 0;
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
