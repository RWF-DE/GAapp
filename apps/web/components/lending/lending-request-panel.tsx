'use client';

// 申請の「テント等」のタブの中身（04「申請の「テント等」のタブ」、notes/T21.md「画面の約束」6・9。T21・D-57）。スマホ。
// request-tabs.tsx が初めてテント等を開いたときに作る（JS は /request の最初に読む JS に入れる。FU3 の PR B の案 4）。
// - 団体名と締切（机・椅子と同じ受付期間と文）、申請できる備品ごとの ＋－ と数字の欄。区分で申請できなくなった備品に1以上の申請が
//   残っていれば読み取り専用の行。「テント等の申請を保存」（確かめのダイアログ）と保存した日時。申請の備考はない。
// - 受付の前・締切後・振り分け中以降・終了は読み取り専用（文は机・椅子と同じ）。割り当ての確定後は備品ごとの割り当て（0・未定も）、
//   記録があれば（確定の前でも）渡した・返った、2日目から未返却（判断したことの 20・21）。
// - その団体の区分で申請できる備品がない（割り当てか記録だけでタブを出した。2026-11-01 のリードの決定）ときは申請できない：申請の欄・
//   保存・締切・保存した日時・受付の状態の文・下書きを出さず、数は総務が決める旨の1行と、割り当て（申請の数は1以上のときだけ添える）・
//   記録を読むだけで出す。申請できる備品のある団体は今までどおり。
// - 保存（設計 2.6 の (A)）：送る前にその団体の申請を読み直し、入力と同じなら「保存されていました」、入力を始めた後にほかの人が変えて
//   いれば変わった備品（前 → 今）を出して上書きしてよいか確かめる。送るのは申請できる備品の全部の行（0 を含む）の upsert。
//   42501 で年度を読み直しても受付中のままなら、読み取り専用にして端末の時計のずれの文を出す。下書き・離れるときの確かめ・最新でない
//   年度の確かめは机・椅子と同じ共通の部品。入力の元（base）は最初に編集したときの申請の行で、裏の読み直しでは変えない。
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { useEffect, useMemo, useState } from 'react';
import { toast } from 'sonner';
import { ConfirmDialog } from '@/components/common/confirm-dialog';
import { CountStepper } from '@/components/common/count-stepper';
import { DraftNotice } from '@/components/common/draft-notice';
import { LatestYearSwitch, useNotLatestYearConfirm } from '@/components/common/latest-year';
import { PageHeader } from '@/components/common/page-header';
import { TokyoTime } from '@/components/common/tokyo-time';
import { UnsavedChangesGuard } from '@/components/common/unsaved-changes-guard';
import { ErrorState, LoadingState, ReadOnlyNotice } from '@/components/states';
import { Button } from '@/components/ui/button';
import { useAuth } from '@/lib/auth/auth-provider';
import { useAuthErrorHandler } from '@/lib/auth/guarded';
import type { GroupSummary } from '@/lib/auth/membership';
import {
  changedLendingRequests,
  decideLendingRequestSave,
  invalidateLending,
  lendingRequestTabOptions,
  readGroupLendingRequests,
  saveLendingRequests,
  type LendingRequestItem,
  type LendingRequestRow,
  type LendingRequestTabData,
} from '@/lib/data/lending';
import { isOutsideFlagActive, judgeDirectFailure, outsideFlagOf, remainingText, requestWindowOf, type OutsideFlag, type RequestWindow } from '@/lib/data/requests';
import { useYearRow, type YearRow } from '@/lib/data/year';
import { formatDateTime, formatShortDateTime } from '@/lib/datetime';
import { createDraftWriter, loadDraft, removeDraft, type DraftKey } from '@/lib/drafts';
import { classifyError, effectOf, isUnknownOutcome, messageFor, unknownOutcomeMessage } from '@/lib/errors';
import { CATEGORY_LABELS } from '@/lib/labels';
import { cellKey, festivalDay2Started, sortLendingItems } from '@/lib/modules/lending/counts';
import { useGuardedRouter } from '@/lib/navigation/guarded-router';
import { queryKeys } from '@/lib/query';
import { cn } from '@/lib/utils';
import { useNow } from '@/components/requests/use-now';

/** 保存の確かめ（すべて 0） */
export const LENDING_REQUEST_ZERO = 'テント等を借りない申請として保存しますか';
/** 端末の時計のずれ（DB が受付期間の外と判断した） */
export const LENDING_REQUEST_OUTSIDE = '締切を過ぎました（または受付の前です）。端末の時計がずれている可能性があります';

/** 区分で申請できる備品がない団体（割り当てか記録だけでタブを出した団体）の文 */
export function lendingNotRequestableText(category: string): string {
  return `${CATEGORY_LABELS[category as keyof typeof CATEGORY_LABELS] ?? category}の団体はテント等を申請しません。数は総務が決めます`;
}

/** 読み取り専用の文（机・椅子の申請の画面と同じ文） */
function windowNotice(win: RequestWindow, year: YearRow, outside: boolean): string | null {
  if (outside) return `${LENDING_REQUEST_OUTSIDE}。変更は総務へ`;
  switch (win) {
    case 'preparing':
      return '受付の前です';
    case 'not_yet':
      return `受付は ${formatDateTime(year.request_open_at)} からです`;
    case 'closed':
      return '締切を過ぎました。変更は総務へ';
    case 'open':
      return null;
  }
}

/** 下書き（入力と、入力の元の行） */
interface RequestLendingDraft {
  edits: Record<string, number>;
  base: LendingRequestRow[];
}

function normalizeDraft(v: unknown): RequestLendingDraft | null {
  if (!v || typeof v !== 'object') return null;
  const { edits, base } = v as { edits?: unknown; base?: unknown };
  if (!edits || typeof edits !== 'object' || Array.isArray(edits) || !Array.isArray(base)) return null;
  for (const n of Object.values(edits as Record<string, unknown>)) {
    if (typeof n !== 'number' || !Number.isInteger(n) || n < 0 || n > 10000) return null;
  }
  for (const r of base as unknown[]) {
    const x = r as Record<string, unknown> | null;
    if (!x || typeof x.lending_item_id !== 'string' || typeof x.count !== 'number' || typeof x.updated_at !== 'string') return null;
  }
  return { edits: edits as Record<string, number>, base: base as LendingRequestRow[] };
}

export interface LendingRequestPanelProps {
  yearId: string;
  group: GroupSummary;
  /** 団体の区分（申請の画面と同じクエリから） */
  groupCategory: string;
  locationName: string | null;
  /** 年度の備品（タブを出すかを決めた読み取り） */
  items: readonly LendingRequestItem[];
  userId: string;
  /** 保存していない入力があるか（タブの印） */
  onDirtyChange: (dirty: boolean) => void;
}

export function LendingRequestPanel({ yearId, group, groupCategory, locationName, items, userId, onDirtyChange }: LendingRequestPanelProps) {
  const queryClient = useQueryClient();
  const { membership, reloadMembership } = useAuth();
  const onAuthError = useAuthErrorHandler();
  const router = useGuardedRouter();
  const notLatest = useNotLatestYearConfirm();
  const yearQ = useYearRow(yearId);
  const tabOptions = lendingRequestTabOptions(yearId, group.id);
  const q = useQuery(tabOptions);
  const now = useNow();
  const groups = membership.status === 'ready' ? membership.membership.groups : [group];

  const sorted = useMemo(() => sortLendingItems(items), [items]);
  const requestable = useMemo(() => sorted.filter((i) => (i.requestable_categories as readonly string[]).includes(groupCategory)), [sorted, groupCategory]);

  const [base, setBase] = useState<LendingRequestRow[] | null>(null);
  const [edits, setEdits] = useState<Record<string, number>>({});
  const [outside, setOutside] = useState<OutsideFlag | null>(null);
  const [confirmOpen, setConfirmOpen] = useState(false);
  const [overwrite, setOverwrite] = useState<{ itemId: string; from: number; to: number }[] | null>(null);
  const [submitError, setSubmitError] = useState<string | null>(null);
  const [pending, setPending] = useState(false);

  const draftKeyValue: DraftKey = useMemo(() => ({ userId, yearId, screen: 'request-lending', target: group.id }), [userId, yearId, group.id]);
  const writer = useMemo(() => createDraftWriter<RequestLendingDraft>(draftKeyValue), [draftKeyValue]);
  const [draft, setDraft] = useState(() => {
    const d = loadDraft<unknown>(draftKeyValue);
    const value = d ? normalizeDraft(d.value) : null;
    return d && value && Object.keys(value.edits).length > 0 ? { value, savedAt: d.savedAt } : null;
  });
  useEffect(() => () => writer.flush(), [writer]);

  const data = q.data;
  const shown = base ?? data?.requests ?? [];
  const shownCount = (id: string) => shown.find((r) => r.lending_item_id === id)?.count ?? 0;
  const countOf = (id: string) => edits[id] ?? shownCount(id);
  const dirty = requestable.some((i) => countOf(i.id) !== shownCount(i.id));
  useEffect(() => {
    onDirtyChange(dirty);
  }, [dirty, onDirtyChange]);
  useEffect(() => () => onDirtyChange(false), [onDirtyChange]);

  const year = yearQ.data;
  if (yearQ.isError || q.isError) {
    return (
      <>
        <PageHeader title="申請" />
        <ErrorState
          message={messageFor(classifyError(yearQ.error ?? q.error))}
          onRetry={() => {
            void yearQ.refetch();
            void q.refetch();
          }}
        />
      </>
    );
  }
  if (!year || !data) {
    return (
      <>
        <PageHeader title="申請" />
        <LoadingState />
      </>
    );
  }

  // 区分で申請できる備品がない団体（割り当てか記録だけでタブを出した。2026-11-01 のリードの決定）は申請しない：欄・保存・締切・
  // 受付の状態の文・下書きを出さず、数は総務が決める旨の1行と割り当て・記録だけ
  const canRequest = requestable.length > 0;
  const win = requestWindowOf(year, now);
  const flagged = isOutsideFlagActive(outside, year);
  const writable = canRequest && win === 'open' && !flagged;
  const notice = canRequest ? windowNotice(win, year, flagged) : null;
  const left = remainingText(year.request_close_at, now);
  const latestRows = data.requests;
  const savedAt = latestRows.reduce<string | null>((m, r) => (!m || Date.parse(r.updated_at) > Date.parse(m) ? r.updated_at : m), null);
  const requestableIds = new Set(requestable.map((i) => i.id));
  const stale = sorted.filter((i) => !requestableIds.has(i.id) && (latestRows.find((r) => r.lending_item_id === i.id)?.count ?? 0) > 0);
  const summary = requestable.filter((i) => countOf(i.id) > 0);

  /** 編集を始める：入力の元を今の行で固める（裏の読み直しで変えない） */
  const startEditing = (): LendingRequestRow[] => {
    const b = base ?? data.requests;
    if (!base) setBase(b);
    return b;
  };
  const writeDraft = (nextEdits: Record<string, number>, nextBase: LendingRequestRow[]) => {
    if (Object.keys(nextEdits).length === 0) writer.clear();
    else writer.write({ edits: nextEdits, base: nextBase });
  };
  const change = (itemId: string, n: number) => {
    const b = startEditing();
    const baseCount = b.find((r) => r.lending_item_id === itemId)?.count ?? 0;
    const next = { ...edits };
    if (n === baseCount) delete next[itemId];
    else next[itemId] = n;
    setEdits(next);
    setDraft(null);
    writeDraft(next, b);
  };

  const putRows = (rows: LendingRequestRow[]) =>
    queryClient.setQueryData<LendingRequestTabData>(tabOptions.queryKey, (old) => (old ? { ...old, requests: rows } : old));

  const done = (message: string, rows: LendingRequestRow[]) => {
    putRows(rows);
    writer.clear();
    setDraft(null);
    setBase(null);
    setEdits({});
    toast.success(message);
    invalidateLending(queryClient, yearId);
  };

  const handleError = async (e: unknown) => {
    const c = classifyError(e);
    if (c.kind === 'auth') {
      await onAuthError(e);
      return;
    }
    let reloaded: YearRow | null = null;
    if (effectOf(c).reload === 'year') {
      reloaded = (await yearQ.refetch()).data ?? null;
      reloadMembership();
    }
    if (judgeDirectFailure(e, reloaded).outside && reloaded) {
      setOutside(outsideFlagOf(reloaded));
      setSubmitError(LENDING_REQUEST_OUTSIDE);
      toast.error(LENDING_REQUEST_OUTSIDE);
      return;
    }
    const msg = messageFor(c, { table: 'lending_requests' });
    setSubmitError(msg);
    toast.error(msg);
    if (c.kind === 'input' || c.kind === 'blocked') void queryClient.invalidateQueries({ queryKey: queryKeys.yearPart(yearId, 'lending', 'request-items') });
    if (effectOf(c).reload === 'data' || c.kind === 'blocked') void q.refetch();
  };

  /** 保存（送る前に読み直して決める）。'changed' はほかの人の変更があって送らなかった（上書きの確かめを出した） */
  const saveNow = async (): Promise<'done' | 'changed' | 'error'> => {
    setSubmitError(null);
    const counts = Object.fromEntries(requestable.map((i) => [i.id, countOf(i.id)]));
    const from = startEditing();
    let fresh: LendingRequestRow[];
    try {
      fresh = await readGroupLendingRequests(group.id);
    } catch (e) {
      if (isUnknownOutcome(e)) setSubmitError(unknownOutcomeMessage('保存'));
      else await handleError(e);
      return 'error';
    }
    const ids = requestable.map((i) => i.id);
    const decision = decideLendingRequestSave({ itemIds: ids, counts, base: from, fresh, userId });
    if (decision === 'saved') {
      done('保存されていました', fresh);
      return 'done';
    }
    // 入力の元を読み直した行にする（入れた数は残す）
    const nextEdits = Object.fromEntries(ids.flatMap((id) => (counts[id] !== (fresh.find((r) => r.lending_item_id === id)?.count ?? 0) ? [[id, counts[id]!]] : [])));
    setBase(fresh);
    setEdits(nextEdits);
    writeDraft(nextEdits, fresh);
    putRows(fresh);
    if (decision === 'conflict') {
      setOverwrite(changedLendingRequests(ids, from, fresh));
      return 'changed';
    }
    setPending(true);
    try {
      const rows = await saveLendingRequests(ids.map((id) => ({ group_id: group.id, lending_item_id: id, year_id: yearId, count: counts[id]! })));
      const merged = [...fresh.filter((r) => !requestableIds.has(r.lending_item_id)), ...rows];
      done(`テント等の申請を保存しました（${formatShortDateTime(new Date())}）`, merged);
      return 'done';
    } catch (e) {
      if (isUnknownOutcome(e)) setSubmitError(unknownOutcomeMessage('保存'));
      else await handleError(e);
      return 'error';
    } finally {
      setPending(false);
    }
  };

  const onSaveClick = async () => {
    if (!writable || pending) return;
    if (!(await notLatest.confirmBeforeWrite())) return;
    setConfirmOpen(true);
  };

  const itemName = (id: string) => sorted.find((i) => i.id === id)?.name ?? '（消えた備品）';
  const confirmed = !!data.confirmedAt;
  const reqCount = (id: string) => latestRows.find((r) => r.lending_item_id === id)?.count ?? 0;
  const assigned = new Map(data.assignments.map((a) => [cellKey(a.group_id, a.lending_item_id), a.count]));
  const recordOf = (id: string) => data.records.find((r) => r.lending_item_id === id);
  const day2 = festivalDay2Started(year, now);

  return (
    <div className="mx-auto max-w-xl pb-24" data-testid="lending-request">
      <LatestYearSwitch />
      <PageHeader title="申請" />
      {groups.length > 1 ? (
        <label className="mb-3 flex items-center gap-2 text-sm">
          <span className="shrink-0">団体</span>
          <select
            className="h-9 min-w-0 flex-1 rounded-md border bg-background px-2"
            value={group.id}
            onChange={(e) => void router.push(`/request?group=${e.target.value}&tab=lending`)}
          >
            {groups.map((g) => (
              <option key={g.id} value={g.id}>
                {g.name}
              </option>
            ))}
          </select>
        </label>
      ) : null}
      <dl className="mb-3 grid grid-cols-[auto_1fr] gap-x-3 gap-y-1 rounded-lg border p-3 text-sm">
        <dt className="text-muted-foreground">団体</dt>
        <dd className="font-medium">{group.name}</dd>
        <dt className="text-muted-foreground">使用場所</dt>
        <dd>{locationName ?? '校内に分散'}</dd>
        {canRequest ? (
          <>
            <dt className="text-muted-foreground">締切</dt>
            <dd>
              {year.request_close_at ? (
                <>
                  <TokyoTime value={year.request_close_at} />
                  {left ? <span className="ml-1 text-muted-foreground">（{left}）</span> : null}
                </>
              ) : (
                '未定'
              )}
            </dd>
            <dt className="text-muted-foreground">保存</dt>
            <dd data-testid="lending-request-saved-at">{savedAt ? `保存済み（${formatShortDateTime(savedAt)}）` : 'まだ保存していません'}</dd>
          </>
        ) : null}
      </dl>
      {!canRequest ? (
        <div data-testid="lending-request-not-requestable" className="mb-3">
          <ReadOnlyNotice>{lendingNotRequestableText(groupCategory)}</ReadOnlyNotice>
        </div>
      ) : null}
      {notice ? (
        <div data-testid="lending-request-readonly" className="mb-3">
          <ReadOnlyNotice>{notice}</ReadOnlyNotice>
        </div>
      ) : null}
      {draft && writable ? (
        <DraftNotice
          className="mb-3"
          savedAt={draft.savedAt}
          onRestore={() => {
            setBase(draft.value.base);
            setEdits(draft.value.edits);
            setDraft(null);
          }}
          onDiscard={() => {
            writer.cancel();
            removeDraft(draftKeyValue);
            setDraft(null);
          }}
        />
      ) : null}
      {submitError ? (
        <p role="alert" data-testid="lending-request-error" className="mb-3 rounded-md border border-destructive/40 bg-destructive/5 px-3 py-2 text-sm text-destructive">
          {submitError}
        </p>
      ) : null}
      <UnsavedChangesGuard when={dirty && writable} />
      {canRequest || stale.length > 0 ? (
        <>
          <h2 className="mb-2 text-base font-semibold">テント等の数</h2>
          <ul className="divide-y rounded-lg border" aria-label="テント等の申請">
            {requestable.map((it) => (
              <li key={it.id} data-testid="lending-request-item" data-item-id={it.id} className="flex items-center gap-3 px-3 py-3">
                <div className="min-w-0 flex-1">
                  <p className="font-medium [overflow-wrap:anywhere]">{it.name}</p>
                  <p className="text-xs text-muted-foreground">単位：{it.unit}</p>
                </div>
                <div data-testid="lending-request-count">
                  <CountStepper size="lg" label={`${it.name}の数`} value={countOf(it.id)} onChange={(n) => change(it.id, n)} disabled={!writable || pending} />
                </div>
              </li>
            ))}
            {stale.map((it) => (
              <li key={it.id} data-testid="lending-request-stale" data-item-id={it.id} className="px-3 py-3 text-sm text-muted-foreground">
                {it.name} {reqCount(it.id)} {it.unit}（今は申請できない備品です。変えるときは総務へ）
              </li>
            ))}
          </ul>
        </>
      ) : null}
      {confirmed ? (
        <section data-testid="lending-request-assigned" aria-label="割り当て" className="mt-4 space-y-1 rounded-lg border border-sky-300 bg-sky-50 p-3 text-sm text-sky-950">
          <h2 className="font-semibold">割り当て（確定）</h2>
          <ul className="space-y-0.5">
            {sorted
              .filter((it) => reqCount(it.id) > 0 || assigned.has(cellKey(group.id, it.id)))
              .map((it) => {
                const a = assigned.get(cellKey(group.id, it.id));
                // 申請しない団体（区分で申請できる備品がない）には、申請がなければ「（申請 0）」を添えない
                return (
                  <li key={it.id}>
                    割り当て：{it.name} {a === undefined ? '未定' : `${a} ${it.unit}`}
                    {canRequest || reqCount(it.id) > 0 ? `（申請 ${reqCount(it.id)}）` : null}
                  </li>
                );
              })}
          </ul>
        </section>
      ) : null}
      {data.records.some((r) => r.lent_count > 0) ? (
        <section aria-label="受け渡し・返却" data-testid="lending-request-records" className="mt-4 space-y-1 rounded-lg border p-3 text-sm">
          <h2 className="font-semibold">受け渡し・返却</h2>
          <ul className="space-y-0.5">
            {sorted.flatMap((it) => {
              const r = recordOf(it.id);
              if (!r || r.lent_count === 0) return [];
              const lines = [
                <li key={`${it.id}-l`}>
                  渡した：{it.name} {r.lent_count} {it.unit}
                </li>,
                <li key={`${it.id}-r`}>
                  返った：{it.name} {r.returned_count} {it.unit}
                </li>,
              ];
              if (day2 && r.lent_count > r.returned_count) {
                lines.push(
                  <li key={`${it.id}-u`} data-testid="lending-request-unreturned" className="font-semibold text-destructive">
                    未返却：{it.name} {r.lent_count - r.returned_count} {it.unit}
                  </li>,
                );
              }
              return lines;
            })}
          </ul>
        </section>
      ) : null}
      {writable ? (
        <div className="sticky bottom-0 -mx-4 mt-4 border-t bg-background px-4 py-3 md:mx-0 md:rounded-b-lg">
          {dirty ? <p className="mb-2 text-xs text-amber-700">保存していない入力があります</p> : null}
          <Button
            data-testid="lending-request-save"
            className="w-full"
            size="lg"
            disabled={pending}
            aria-busy={pending || undefined}
            onClick={() => void onSaveClick()}
          >
            {pending ? '保存中…' : 'テント等の申請を保存'}
          </Button>
        </div>
      ) : null}
      <ConfirmDialog
        open={confirmOpen}
        onOpenChange={setConfirmOpen}
        title="テント等の申請を保存しますか"
        description={summary.length === 0 ? LENDING_REQUEST_ZERO : '次の数で保存します。'}
        confirmLabel="保存する"
        pendingLabel="保存中…"
        pending={pending}
        onConfirm={async () => {
          await saveNow();
        }}
      >
        {summary.length > 0 ? (
          <ul className="max-h-60 space-y-1 overflow-auto text-sm" data-testid="lending-request-summary">
            {summary.map((it) => (
              <li key={it.id} className="flex justify-between gap-4">
                <span>{it.name}</span>
                <span className="tabular-nums">
                  {countOf(it.id)} {it.unit}
                </span>
              </li>
            ))}
          </ul>
        ) : null}
      </ConfirmDialog>
      <ConfirmDialog
        open={overwrite !== null}
        onOpenChange={(o) => {
          if (!o) setOverwrite(null);
        }}
        title="ほかの人がこの団体のテント等の申請を変えました。上書きしますか"
        description="画面は読み直した値にしました（入れた数は残しています）。上書きすると、画面の数で置き換わります。"
        confirmLabel="上書きして保存する"
        cancelLabel="保存しないで見直す"
        pendingLabel="保存中…"
        pending={pending}
        onConfirm={async () => {
          if ((await saveNow()) === 'changed') throw new Error('changed_again');
        }}
      >
        {overwrite && overwrite.length > 0 ? (
          <ul className={cn('max-h-60 space-y-1 overflow-auto text-sm')} data-testid="lending-request-conflicts">
            {overwrite.map((c) => (
              <li key={c.itemId}>
                {itemName(c.itemId)}（{c.from} → {c.to}）
              </li>
            ))}
          </ul>
        ) : null}
      </ConfirmDialog>
      {notLatest.dialog}
    </div>
  );
}
