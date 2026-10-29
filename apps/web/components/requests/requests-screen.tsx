'use client';

import { GROUP_CATEGORIES, type GroupCategory } from '@gaapp/shared';
import { useQueryClient } from '@tanstack/react-query';
import { useSearchParams } from 'next/navigation';
import { useEffect, useEffectEvent, useMemo, useRef, useState } from 'react';
import { toast } from 'sonner';
import { ConfirmDialog } from '@/components/common/confirm-dialog';
import { DraftNotice } from '@/components/common/draft-notice';
import { PageHeader } from '@/components/common/page-header';
import { ReasonDialog } from '@/components/common/reason-dialog';
import { TokyoTime } from '@/components/common/tokyo-time';
import { UnsavedChangesGuard } from '@/components/common/unsaved-changes-guard';
import { AppLink } from '@/components/common/app-link';
import { EmptyState, ErrorState, LoadingState, ReadOnlyNotice } from '@/components/states';
import { Button } from '@/components/ui/button';
import { useAuth } from '@/lib/auth/auth-provider';
import { useAuthErrorHandler } from '@/lib/auth/guarded';
import {
  adminWriteMode,
  buildRequestMatrix,
  cellKey,
  columnTotals,
  groupDeadlineRows,
  isOutsideFlagActive,
  isUnknownOutcome,
  judgeDirectFailure,
  judgeSubmitFailure,
  markSubmittedAfterDeadline,
  markSubmittedDirect,
  normalizePending,
  outsideFlagOf,
  pendingChanges,
  rebaseKeysTo,
  rebasePending,
  remainingText,
  samePending,
  saveCellsDirect,
  saveGroupsAfterDeadline,
  savedAfterUnknown,
  saveSummary,
  setPendingCell,
  useRequestsTables,
  type AdminWriteMode,
  type CellChange,
  type MatrixRow,
  type OutsideFlag,
  type PendingCell,
  type PendingCells,
  type RequestsTables,
} from '@/lib/data/requests';
import { useYearRow, type YearRow } from '@/lib/data/year';
import { formatDateTime } from '@/lib/datetime';
import { createDraftWriter, loadDraft, removeDraft, type DraftKey } from '@/lib/drafts';
import { AppError, classifyError, effectOf, messageFor, type NameLookup } from '@/lib/errors';
import { CATEGORY_LABELS } from '@/lib/labels';
import { useGuardedRouter } from '@/lib/navigation/guarded-router';
import { queryKeys } from '@/lib/query';
import { parseCategoryParam, parseFilterParam, type RequestsFilter } from '@/lib/schemas/requests';
import { ImportDialog } from './import-dialog';
import { ProxySheet } from './proxy-sheet';
import { RequestsTable, type CellMark } from './requests-table';
import { useNow } from './use-now';

/**
 * 申請一覧 /requests（admin は読み書き、staff は読み取り。PC。画面の設計 3.6。T11）。
 * 年度を変えると作り直す（未保存のセルは年度ごとの下書きに残る）。
 */
export function RequestsScreen() {
  const { membership, session } = useAuth();
  const m = membership.status === 'ready' ? membership.membership : null;
  const yearId = m?.year?.id ?? null;
  const userId = session.status === 'signedIn' ? session.session.user.id : null;
  if (!m || !yearId || !userId) return <LoadingState />;
  return <RequestsBoard key={yearId} yearId={yearId} userId={userId} admin={m.role === 'admin'} />;
}

const FILTER_LABELS: Record<RequestsFilter, string> = { unsubmitted: '未提出だけ', noted: '備考ありだけ' };

/** 通信が途切れて保存されたか分からない変更（cell：締切前のセルごと、group：締切後の団体ごと〔全部か何もないか〕） */
interface Unverified {
  changes: CellChange[];
  unit: 'cell' | 'group';
}

function queryString(category: GroupCategory | null, filter: RequestsFilter | null): string {
  const p = new URLSearchParams();
  if (category) p.set('category', category);
  if (filter) p.set('filter', filter);
  const s = p.toString();
  return s ? `/requests?${s}` : '/requests';
}

function modeNotice(mode: AdminWriteMode, year: YearRow, admin: boolean, outside: boolean): React.ReactNode {
  if (!admin) return <ReadOnlyNotice>部員は申請一覧を見るだけです</ReadOnlyNotice>;
  if (mode === 'readonly') {
    return <ReadOnlyNotice>{year.status === 'closed' ? '終了した年度のため編集できません' : '年度が確定中のため編集できません（確定を解除してから）'}</ReadOnlyNotice>;
  }
  if (outside) {
    return (
      <ReadOnlyNotice>
        DB が締切後と判断しました（端末の時計がずれている可能性があります）。変更は理由をつけて保存します
      </ReadOnlyNotice>
    );
  }
  return null;
}

function RequestsBoard({ yearId, userId, admin }: { yearId: string; userId: string; admin: boolean }) {
  const params = useSearchParams();
  const category = parseCategoryParam(params.get('category'));
  const filter = parseFilterParam(params.get('filter'));
  const router = useGuardedRouter();
  const queryClient = useQueryClient();
  const { reloadMembership } = useAuth();
  const onAuthError = useAuthErrorHandler();
  const yearQ = useYearRow(yearId);
  const q = useRequestsTables(yearId);
  const now = useNow();

  const [pending, setPending] = useState<PendingCells>({});
  const [marks, setMarks] = useState<Record<string, CellMark>>({});
  const [outside, setOutside] = useState<OutsideFlag | null>(null);
  const [reasonOpen, setReasonOpen] = useState(false);
  const [saving, setSaving] = useState(false);
  const [saveError, setSaveError] = useState<string | null>(null);
  /** 保存の後の知らせ（通信が途切れたが保存されていた、など） */
  const [saveInfo, setSaveInfo] = useState<string | null>(null);
  /** 通信が途切れて保存されたか分からず、読み直しもできなかった変更（確かめるまで保存を押せない。2.6） */
  const [unverified, setUnverified] = useState<Unverified | null>(null);
  const [proxyGroupId, setProxyGroupId] = useState<string | null>(null);
  const [markRow, setMarkRow] = useState<MatrixRow | null>(null);
  const [importOpen, setImportOpen] = useState(false);

  const draftKeyValue: DraftKey = useMemo(() => ({ userId, yearId, screen: 'requests' }), [userId, yearId]);
  const writer = useMemo(() => createDraftWriter<PendingCells>(draftKeyValue), [draftKeyValue]);
  const [draft, setDraft] = useState(() => {
    // 下書きは未保存のセル（入れた数と、編集したときの行）。形の違う値（古い形の下書きなど）は捨てる
    const d = admin ? loadDraft<unknown>(draftKeyValue) : null;
    const value = d ? normalizePending(d.value) : {};
    return d && Object.keys(value).length > 0 ? { value, savedAt: d.savedAt } : null;
  });
  useEffect(() => () => writer.flush(), [writer]);

  /** 今の未保存のセル（保存の途中の await の後でも最新を読む。pending と同じものを持つ） */
  const pendingRef = useRef<PendingCells>({});
  /** 保存中か（保存中に届いた表は、保存の後にまとめて当て直す） */
  const savingRef = useRef(false);
  /** 未保存のセルを当て直した表（同じ表で2回当て直さない） */
  const rebasedRef = useRef<RequestsTables | null>(null);
  /** unverified と同じもの（表が届いたときに最新を読む） */
  const unverifiedRef = useRef<Unverified | null>(null);

  const tables = q.data;
  const matrix = useMemo(() => (tables ? buildRequestMatrix(tables, { category, filter }) : null), [tables, category, filter]);
  const allRows = useMemo(() => (tables ? buildRequestMatrix(tables) : null), [tables]);
  const changes = useMemo(() => (tables ? pendingChanges(pending, tables) : []), [pending, tables]);
  const totals = useMemo(() => (matrix ? columnTotals(matrix, pending) : {}), [matrix, pending]);
  const names: NameLookup = useMemo(
    () => ({
      item: (id) => tables?.items.find((i) => i.id === id)?.name,
      group: (id) => tables?.groups.find((g) => g.id === id)?.name,
    }),
    [tables],
  );

  /** 未保存のセルを最新の値から変える（下書きにも写す。変わらなければ何もしない） */
  const applyPending = (fn: (p: PendingCells) => PendingCells) => {
    const prev = pendingRef.current;
    const next = fn(prev);
    if (samePending(prev, next)) return;
    pendingRef.current = next;
    setPending(next);
    if (Object.keys(next).length === 0) writer.clear();
    else writer.write(next);
  };

  /** セルに印をつける（null は外す） */
  const applyMarks = (updates: Readonly<Record<string, CellMark | null>>) => {
    if (Object.keys(updates).length === 0) return;
    setMarks((m) => {
      const next = { ...m };
      for (const [k, v] of Object.entries(updates)) {
        if (v) next[k] = v;
        else delete next[k];
      }
      return next;
    });
  };

  /**
   * 表（読み直した表・戻した下書きの相手）に未保存のセルを当て直す。編集したときの行からほかの人が変えたセルは、読み直した値に
   * 戻して印をつける（3.6。黙って上書きしない）。戻したセルの数を返す。
   */
  const rebaseOnto = (t: RequestsTables, prepare: (p: PendingCells) => PendingCells = (p) => p): number => {
    let conflicts: string[] = [];
    applyPending((p) => {
      const r = rebasePending(prepare(p), t);
      conflicts = r.conflicts;
      return r.pending;
    });
    rebasedRef.current = t;
    applyMarks(Object.fromEntries(conflicts.map((k) => [k, 'conflict' as const])));
    return conflicts.length;
  };

  /**
   * 保存の結果を未保存のセルに当てる（最新の未保存のセルに対して）。
   * - saved：保存したセル。送った値のままなら外す。送った後に入れ直していれば、基準を保存した行に付け替えて残す。
   * - revert：読み直した値に戻すセル。keep：値を残して基準を今の行に付け替えるセル（締切後の conflict。2.5）。
   * その後で、読み直した表に残りを当て直す。戻したセルの数を返す。
   */
  const applySaveResults = (
    data: RequestsTables | undefined,
    sent: readonly CellChange[],
    { saved, revert, keep }: { saved: ReadonlySet<string>; revert: ReadonlySet<string>; keep: ReadonlySet<string> },
  ): number => {
    const sentCount = new Map(sent.map((c) => [cellKey(c.groupId, c.itemId), c.count]));
    const moved: string[] = [...keep];
    const prepare = (p: PendingCells): PendingCells => {
      const next: Record<string, PendingCell> = { ...p };
      for (const k of saved) {
        if (next[k]?.value === sentCount.get(k)) delete next[k];
        else if (next[k]) moved.push(k);
      }
      for (const k of revert) delete next[k];
      return data ? rebaseKeysTo(next, moved, data) : next;
    };
    if (data) return rebaseOnto(data, prepare);
    applyPending(prepare);
    return 0;
  };

  /** 保存されたか分からない変更を残す・外す（確かめるまで保存を押せない） */
  const setUnverifiedBoth = (u: Unverified | null) => {
    unverifiedRef.current = u;
    setUnverified(u);
  };

  /**
   * 保存されたか分からなかった変更を、届いた表で確かめる（2.6）。保存されていたセルは保存したものとして外し、
   * されていなければ入力を残して送り直してもらう。当て直しも行う。戻したセルの数を返す。
   */
  const settleUnverified = (t: RequestsTables, u: Unverified): number => {
    setUnverifiedBoth(null);
    const confirmed = savedAfterUnknown(u.changes, t, u.unit);
    applyMarks(Object.fromEntries([...confirmed].map((k) => [k, null])));
    const n = applySaveResults(t, u.changes, { saved: confirmed, revert: new Set(), keep: new Set() });
    const notSaved = u.changes.length - confirmed.size;
    if (notSaved === 0) {
      setSaveError(null);
      setSaveInfo(`通信が途切れましたが、${confirmed.size} 件は保存されていました`);
      toast.success('保存されていました');
    } else {
      setSaveInfo(null);
      setSaveError(
        `${notSaved} 件は保存されていませんでした（通信できませんでした）。もう一度保存してください${confirmed.size > 0 ? `（${confirmed.size} 件は保存されていました）` : ''}`,
      );
    }
    return n;
  };

  /** 表が届いたら当て直す（読み直す・代理入力や取り込みの後の invalidate・ほかの書き込みの後の読み直し）。保存中は保存が行う */
  const rebaseIfNew = (t: RequestsTables) => {
    if (savingRef.current || rebasedRef.current === t) return;
    const u = unverifiedRef.current;
    const n = u ? settleUnverified(t, u) : rebaseOnto(t);
    if (n > 0) toast.info(`${n} 件のセルは、ほかの人が先に変えたので読み直した値に戻しました`);
  };
  const onTablesLoaded = useEffectEvent((t: RequestsTables) => rebaseIfNew(t));
  useEffect(() => {
    if (q.data) onTablesLoaded(q.data);
  }, [q.data]);

  // 読み直しに失敗しても、表があれば表を出したままにする（未保存のセルと「確かめる」を出せるように）
  if ((yearQ.isError && !yearQ.data) || (q.isError && !q.data)) {
    return (
      <>
        <PageHeader title="申請一覧" />
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
  const year = yearQ.data;
  if (!year || !tables || !matrix || !allRows) {
    return (
      <>
        <PageHeader title="申請一覧" />
        <LoadingState />
      </>
    );
  }

  const flagged = isOutsideFlagActive(outside, year);
  const mode: AdminWriteMode = admin ? adminWriteMode(year, now, flagged) : 'readonly';
  const editable = admin && mode !== 'readonly';
  const left = remainingText(year.request_close_at, now);
  const proxyRow = proxyGroupId ? (allRows.rows.find((r) => r.group.id === proxyGroupId) ?? null) : null;

  /** 表を読み直す。読めなければ undefined（前の表は返さない） */
  const refetchFresh = async (): Promise<RequestsTables | undefined> => {
    const res = await q.refetch();
    return res.isSuccess ? res.data : undefined;
  };

  /** 書き込みの後に読み直す（未保存のセルは当て直す。保存中は保存が当て直す）。読めなければ undefined */
  const reloadTables = async (): Promise<RequestsTables | undefined> => {
    const data = await refetchFresh();
    if (data) rebaseIfNew(data);
    return data;
  };

  /** 「確かめる」：読み直して、保存されたか分からなかった変更を確かめる */
  const verifyNow = async () => {
    const data = await reloadTables();
    if (!data) toast.error('読み直せませんでした。通信が戻ったらもう一度「確かめる」を押してください');
  };

  /** 書き込みの失敗の共通の扱い。DB が締切後と判断した（端末の時計のずれ）なら印を立てる。文言を返す */
  const handleWriteError = async (
    e: unknown,
    rpc: 'direct' | 'submit_requests' | 'update_requests_after_deadline',
    groupId?: string,
  ): Promise<string> => {
    const c = classifyError(e);
    if ((await onAuthError(e)) !== 'other') return messageFor(c);
    const effect = effectOf(c);
    let reloaded: YearRow | null = null;
    if (effect.reload === 'year') {
      reloaded = (await yearQ.refetch()).data ?? null;
      if (c.kind === 'forbidden') reloadMembership();
    }
    const judged = rpc === 'direct' ? judgeDirectFailure(e, reloaded) : rpc === 'submit_requests' ? judgeSubmitFailure(e, reloaded) : { outside: false };
    if (judged.outside && reloaded) {
      setOutside(outsideFlagOf(reloaded));
      return 'DB が締切後と判断しました（端末の時計がずれている可能性があります）。理由をつけて保存し直してください';
    }
    if (effect.reload === 'data') void reloadTables();
    return messageFor(c, {
      rpc: rpc === 'direct' ? undefined : rpc,
      reloadedStatus: reloaded?.status,
      names,
      groupId,
    });
  };

  /** 保存を始める・終える（保存中はセルを編集できず、届いた表の当て直しは保存の後にまとめて行う） */
  const beginSaving = () => {
    savingRef.current = true;
    setSaving(true);
    setSaveError(null);
    setSaveInfo(null);
  };
  const endSaving = () => {
    savingRef.current = false;
    setSaving(false);
  };

  /**
   * 通信が途切れた変更（network・unknown）を、読み直した表で確かめる（2.6）。読み直せなければ unverified に残して、
   * 確かめるまで保存を押せなくする。保存されていたセルの鍵と、知らせの文（失敗・知らせ）を返す。
   */
  const checkUnknown = (
    unknown: readonly CellChange[],
    data: RequestsTables | undefined,
    unit: Unverified['unit'],
  ): { confirmed: Set<string>; error: string | null; info: string | null; uncertain: number; notSaved: number } => {
    if (unknown.length === 0) return { confirmed: new Set(), error: null, info: null, uncertain: 0, notSaved: 0 };
    if (!data) {
      setUnverifiedBoth({ changes: [...unknown], unit });
      return {
        confirmed: new Set(),
        error: '通信が途切れ、保存できたか確かめられません。通信が戻ったら「確かめる」を押してください',
        info: null,
        uncertain: unknown.length,
        notSaved: 0,
      };
    }
    const confirmed = savedAfterUnknown(unknown, data, unit);
    const notSaved = unknown.length - confirmed.size;
    return {
      confirmed,
      error: notSaved > 0 ? `${notSaved} 件は保存されていませんでした（通信できませんでした）。もう一度保存してください` : null,
      info: confirmed.size > 0 ? `通信が途切れましたが、${confirmed.size} 件は保存されていました` : null,
      uncertain: 0,
      notSaved,
    };
  };

  const saveDirect = async () => {
    const sent = changes;
    beginSaving();
    try {
      const results = await saveCellsDirect(sent);
      const markUpdates: Record<string, CellMark | null> = {};
      const saved = new Set<string>();
      const revert = new Set<string>();
      const unknown: CellChange[] = [];
      let conflicts = 0;
      let forbidden: AppError | null = null;
      let other: AppError | null = null;
      for (const r of results) {
        const key = cellKey(r.change.groupId, r.change.itemId);
        if (r.ok) {
          saved.add(key);
          markUpdates[key] = null;
          continue;
        }
        const kind = r.error.info.kind;
        if (kind === 'conflict' || kind === 'not_found') {
          // ほかの人が先に変えた：読み直した値に戻して印をつける
          revert.add(key);
          markUpdates[key] = 'conflict';
          conflicts++;
          continue;
        }
        markUpdates[key] = 'error';
        if (isUnknownOutcome(r.error)) unknown.push(r.change);
        else if (kind === 'forbidden') forbidden ??= r.error;
        else other ??= r.error;
      }
      const data = await refetchFresh();
      const checked = checkUnknown(unknown, data, 'cell');
      for (const k of checked.confirmed) {
        saved.add(k);
        markUpdates[k] = null;
      }
      applyMarks(markUpdates);
      applySaveResults(data, sent, { saved, revert, keep: new Set() });

      // 失敗はまとめて見る：forbidden があれば時計のずれを判断する（最初の失敗が conflict でも）
      const parts: string[] = [];
      if (conflicts > 0) parts.push(`${conflicts} 件はほかの人が先に変えたので、読み直した値に戻しました`);
      if (checked.error) parts.push(checked.error);
      const primary = forbidden ?? other;
      if (primary) parts.push(await handleWriteError(primary, 'direct', undefined));
      const savedCount = saved.size;
      const notSent = sent.length - results.length;
      const failed = results.length - savedCount - checked.uncertain;
      setSaveInfo(checked.info);
      if (parts.length > 0) {
        const head = saveSummary('件', { saved: savedCount, failed, uncertain: checked.uncertain, notSent });
        setSaveError(`${head}：${parts.join('／')}`);
        toast.error(parts[parts.length - 1]!);
      } else {
        toast.success(`${savedCount} 件を保存しました`);
      }
    } finally {
      endSaving();
    }
  };

  const saveDeadline = async (reason: string) => {
    const sent = changes;
    beginSaving();
    try {
      const byGroup = groupDeadlineRows(sent);
      const results = await saveGroupsAfterDeadline(byGroup, reason);
      const markUpdates: Record<string, CellMark | null> = {};
      const saved = new Set<string>();
      const keep = new Set<string>();
      const unknown: CellChange[] = [];
      const unknownGroups = new Set<string>();
      const messages: string[] = [];
      let reasonError: unknown = null;
      for (const r of results) {
        const rows = byGroup.get(r.groupId) ?? [];
        const isUnknown = !r.ok && isUnknownOutcome(r.error);
        if (isUnknown) unknownGroups.add(r.groupId);
        for (const row of rows) {
          const key = cellKey(r.groupId, row.itemId);
          if (r.ok) {
            saved.add(key);
            markUpdates[key] = null;
          } else if (r.error.info.kind === 'conflict') {
            // 締切後の conflict は、その団体を読み直し、変えたセルの値は残して印をつける（2.5）。次の保存は新しい updated_at で送る
            keep.add(key);
            markUpdates[key] = 'conflict';
          } else {
            markUpdates[key] = 'error';
          }
        }
        if (isUnknown) {
          unknown.push(...sent.filter((c) => c.groupId === r.groupId));
        } else if (!r.ok) {
          if (r.error.info.kind === 'reason') reasonError = r.error;
          messages.push(await handleWriteError(r.error, 'update_requests_after_deadline', r.groupId));
        }
      }
      const data = await refetchFresh();
      const checked = checkUnknown(unknown, data, 'group');
      for (const k of checked.confirmed) {
        saved.add(k);
        markUpdates[k] = null;
      }
      applyMarks(markUpdates);
      applySaveResults(data, sent, { saved, revert: new Set(), keep });
      if (checked.error) messages.push(checked.error);
      const confirmedGroups = new Set([...checked.confirmed].map((k) => k.split(':')[0]!));
      const okGroups = results.filter((r) => r.ok).length + confirmedGroups.size;
      const uncertainGroups = checked.uncertain > 0 ? unknownGroups.size : 0;
      setSaveInfo(checked.info);
      if (messages.length > 0) {
        const notSent = byGroup.size - results.length;
        const failed = results.length - okGroups - uncertainGroups;
        setSaveError(
          `${saveSummary('団体', { saved: okGroups, failed, uncertain: uncertainGroups, notSent })}：${messages.join('／')}`,
        );
        toast.error(messages[0]!);
      } else {
        toast.success(`${okGroups} 団体の申請を保存しました`);
      }
      if (reasonError) throw reasonError;
    } finally {
      endSaving();
    }
  };

  const onSave = () => {
    if (changes.length === 0 || saving || unverified) return;
    if (mode === 'deadline') setReasonOpen(true);
    else if (mode === 'direct') void saveDirect();
  };

  const onMarkSubmitted = async (row: MatrixRow, reason: string | null) => {
    try {
      if (mode === 'deadline') {
        await markSubmittedAfterDeadline(row.group.id, reason ?? '');
        toast.success(`${row.group.name}を提出済みにしました`);
      } else {
        // すでに提出済みなら書かない（提出日時を今に変えない）
        const r = await markSubmittedDirect(row.group.id);
        if (r.already) {
          toast.info(`${row.group.name}はすでに提出済みでした（${r.row.submitted_at ? formatDateTime(r.row.submitted_at) : ''}）。読み直しました`);
        } else {
          toast.success(`${row.group.name}を提出済みにしました`);
        }
      }
      await reloadTables();
    } catch (e) {
      const msg = await handleWriteError(e, mode === 'deadline' ? 'update_requests_after_deadline' : 'direct', row.group.id);
      toast.error(msg);
      throw e;
    }
  };

  const setFilters = (c: GroupCategory | null, f: RequestsFilter | null) => router.forceReplace(queryString(c, f));

  return (
    <div className="space-y-3">
      <PageHeader
        title="申請一覧"
        loadedAt={q.dataUpdatedAt ? new Date(q.dataUpdatedAt) : null}
        onReload={() => {
          void yearQ.refetch();
          void reloadTables();
        }}
        reloading={q.isFetching}
        actions={
          editable ? (
            <Button variant="outline" disabled={saving} onClick={() => setImportOpen(true)}>
              Googleフォームの回答を取り込む
            </Button>
          ) : null
        }
        description={
          mode === 'deadline' || (year.status !== 'preparing' && year.status !== 'requesting') || flagged ? (
            <span data-testid="deadline-text">締切後（変更には理由が要ります）</span>
          ) : year.request_close_at ? (
            <span data-testid="deadline-text">
              締切 <TokyoTime value={year.request_close_at} />
              {left ? `（${left}）` : ''}
            </span>
          ) : (
            <span data-testid="deadline-text">締切は未定です</span>
          )
        }
      />
      {modeNotice(mode, year, admin, flagged)}
      {draft && editable ? (
        <DraftNotice
          savedAt={draft.savedAt}
          onRestore={() => {
            // 編集したときの行と今の行を比べて当て直す（ほかの人が先に変えたセルは読み直した値に戻して印をつける）
            const n = rebaseOnto(tables, () => draft.value);
            setDraft(null);
            if (n > 0) toast.info(`${n} 件のセルは、ほかの人が先に変えたので読み直した値に戻しました`);
          }}
          onDiscard={() => {
            writer.cancel();
            removeDraft(draftKeyValue);
            setDraft(null);
          }}
        />
      ) : null}
      <UnsavedChangesGuard when={editable && changes.length > 0} />

      {tables.groups.length === 0 ? (
        <EmptyState
          title="団体がありません"
          description="マスタ設定で団体を登録すると、ここに申請が並びます。"
          action={<AppLink href="/settings?tab=groups">マスタ設定へ</AppLink>}
        />
      ) : (
        <>
          <div className="flex flex-wrap items-center gap-2 text-sm" role="group" aria-label="絞り込み">
            <FilterButton active={!category} onClick={() => setFilters(null, filter)}>
              すべて
            </FilterButton>
            {GROUP_CATEGORIES.map((c) => (
              <FilterButton key={c} active={category === c} onClick={() => setFilters(c, filter)}>
                {CATEGORY_LABELS[c]}
              </FilterButton>
            ))}
            <span className="mx-2 h-5 w-px bg-border" aria-hidden />
            {(Object.keys(FILTER_LABELS) as RequestsFilter[]).map((f) => (
              <FilterButton key={f} active={filter === f} onClick={() => setFilters(category, filter === f ? null : f)}>
                {FILTER_LABELS[f]}
              </FilterButton>
            ))}
          </div>
          <UnsubmittedList groups={matrix.unsubmitted} total={matrix.groupCount} />
          {saveError ? (
            <p role="alert" data-testid="save-error" className="rounded-md border border-destructive/40 bg-destructive/5 px-3 py-2 text-sm text-destructive">
              {saveError}
            </p>
          ) : null}
          {saveInfo ? (
            <p role="status" data-testid="save-info" className="rounded-md border border-sky-300 bg-sky-50 px-3 py-2 text-sm text-sky-900 dark:border-sky-800 dark:bg-sky-950 dark:text-sky-100">
              {saveInfo}
            </p>
          ) : null}
          {matrix.rows.length === 0 ? (
            <EmptyState title="条件に合う団体がありません" />
          ) : (
            <RequestsTable
              matrix={matrix}
              pending={pending}
              marks={marks}
              totals={totals}
              editable={editable}
              busy={saving}
              admin={admin}
              onCellChange={(row, itemId, value) => {
                if (saving) return;
                const cell = row.cells[itemId];
                if (!cell) return;
                applyMarks({ [cellKey(row.group.id, itemId)]: null });
                applyPending((p) => setPendingCell(p, row.group.id, itemId, value, cell));
              }}
              onProxy={(row) => setProxyGroupId(row.group.id)}
              onMarkSubmitted={(row) => setMarkRow(row)}
            />
          )}
          <p className="text-xs text-muted-foreground">
            「—」はその区分で申請できない品目。※ は申請できない品目に残っている申請（企業以外の長机(3人掛)は長机(2人掛)として扱う。ほかは申請できない品目〔E006〕）。
          </p>
          {editable ? (
            <div className="sticky bottom-0 z-30 flex flex-wrap items-center gap-2 border-t bg-background py-3">
              <Button disabled={changes.length === 0 || saving || !!unverified} aria-busy={saving || undefined} onClick={onSave}>
                {saving ? '保存中…' : `保存（${changes.length}件）`}
              </Button>
              {unverified ? (
                <Button variant="secondary" disabled={saving || q.isFetching} onClick={() => void verifyNow()}>
                  確かめる
                </Button>
              ) : null}
              <Button variant="outline" disabled={changes.length === 0 || saving} onClick={() => applyPending(() => ({}))}>
                変更を取り消す
              </Button>
              {mode === 'deadline' ? <span className="text-xs text-muted-foreground">締切後なので、保存には理由が要ります</span> : null}
            </div>
          ) : null}
        </>
      )}

      <ReasonDialog
        open={reasonOpen}
        onOpenChange={setReasonOpen}
        title={`締切後の申請の変更（${changes.length}件）`}
        description="団体ごとに保存します。理由は履歴に残ります。"
        presets={['団体の希望', '総務の確認', '入力の誤り']}
        pending={saving}
        onSubmit={async (reason) => {
          await saveDeadline(reason ?? '');
        }}
      />
      {markRow && mode === 'deadline' ? (
        <ReasonDialog
          open
          onOpenChange={(o) => {
            if (!o) setMarkRow(null);
          }}
          title={`${markRow.group.name}を提出済みにする`}
          description="締切後なので理由が要ります。未提出に戻す操作はありません。"
          presets={['紙で提出済み', '団体の希望']}
          confirmLabel="提出済みにする"
          onSubmit={(reason) => onMarkSubmitted(markRow, reason)}
        />
      ) : (
        <ConfirmDialog
          open={markRow !== null}
          onOpenChange={(o) => {
            if (!o) setMarkRow(null);
          }}
          title={`${markRow?.group.name ?? ''}を提出済みにしますか`}
          description="提出日時は今の時刻になります。未提出に戻す操作はありません。"
          confirmLabel="提出済みにする"
          onConfirm={() => (markRow ? onMarkSubmitted(markRow, null) : undefined)}
        />
      )}
      {editable ? (
        <ImportDialog
          open={importOpen}
          onOpenChange={setImportOpen}
          tables={tables}
          onImported={async () => {
            await queryClient.invalidateQueries({ queryKey: queryKeys.yearPart(yearId, 'requests') });
          }}
          onError={(e, groupId) => handleWriteError(e, 'update_requests_after_deadline', groupId)}
        />
      ) : null}
      <ProxySheet
        open={proxyRow !== null}
        onOpenChange={(o) => {
          if (!o) setProxyGroupId(null);
        }}
        row={proxyRow}
        items={tables.items}
        year={year}
        mode={mode === 'deadline' ? 'deadline' : 'direct'}
        onSaved={async () => {
          await queryClient.invalidateQueries({ queryKey: queryKeys.yearPart(yearId, 'requests') });
        }}
        onReload={async () => {
          await reloadTables();
        }}
        onError={(e, rpc, groupId) => handleWriteError(e, rpc, groupId)}
      />
    </div>
  );
}

function FilterButton({ active, onClick, children }: { active: boolean; onClick: () => void; children: React.ReactNode }) {
  return (
    <Button size="sm" variant={active ? 'default' : 'outline'} aria-pressed={active} onClick={onClick}>
      {children}
    </Button>
  );
}

function UnsubmittedList({ groups, total }: { groups: MatrixRow['group'][]; total: number }) {
  if (total === 0) return null;
  return (
    <div className="rounded-md border px-3 py-2 text-sm" data-testid="unsubmitted">
      {groups.length === 0 ? (
        <span>すべての団体が提出済みです（{total} 団体）</span>
      ) : (
        <>
          <span className="font-medium text-amber-700">
            未提出 {groups.length} 団体
          </span>
          <span className="text-muted-foreground">／{total} 団体：</span>
          <span>{groups.map((g) => g.name).join('、')}</span>
        </>
      )}
    </div>
  );
}
