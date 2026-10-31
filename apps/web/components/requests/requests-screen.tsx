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
import type { AppRole } from '@/lib/auth/membership';
import { isAdmin, isLead } from '@/lib/auth/roles';
import {
  buildRequestMatrix,
  cellKey,
  columnTotals,
  groupDeadlineRows,
  isOutsideFlagActive,
  judgeDirectFailure,
  judgePendingCells,
  judgeSubmitFailure,
  leadWriteMode,
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
  saveSummary,
  setPendingCell,
  useRequestsTables,
  type CellChange,
  type CellConflict,
  type LeadWriteMode,
  type MatrixRow,
  type OutsideFlag,
  type PendingCell,
  type PendingCells,
  type RequestsTables,
} from '@/lib/data/requests';
import { useYearRow, type YearRow } from '@/lib/data/year';
import { formatDateTime } from '@/lib/datetime';
import { createDraftWriter, loadDraft, removeDraft, type DraftKey } from '@/lib/drafts';
import { AppError, classifyError, effectOf, isUnknownOutcome, messageFor, unknownOutcomeMessage, type NameLookup } from '@/lib/errors';
import { CATEGORY_LABELS } from '@/lib/labels';
import { useGuardedRouter } from '@/lib/navigation/guarded-router';
import { queryKeys } from '@/lib/query';
import { parseCategoryParam, parseFilterParam, type RequestsFilter } from '@/lib/schemas/requests';
import { ImportDialog } from './import-dialog';
import { ProxySheet } from './proxy-sheet';
import { RequestsTable, type CellMark } from './requests-table';
import { useNow } from './use-now';

/**
 * 申請一覧 /requests（部門長以上は読み書き、総務部門員は読み取り。PC。画面の設計 3.6。T11・T15b）。
 * 年度を変えると作り直す（未保存のセルは年度ごとの下書きに残る）。
 */
export function RequestsScreen() {
  const { membership, session } = useAuth();
  const m = membership.status === 'ready' ? membership.membership : null;
  const yearId = m?.year?.id ?? null;
  const userId = session.status === 'signedIn' ? session.session.user.id : null;
  if (!m || !yearId || !userId) return <LoadingState />;
  return <RequestsBoard key={yearId} yearId={yearId} userId={userId} role={m.role} />;
}

const FILTER_LABELS: Record<RequestsFilter, string> = { unsubmitted: '未提出だけ', noted: '備考ありだけ' };

/** 送る前の読み直しで見つかった、ほかの人が先に変えたセル（上書きするか読み直すかを確かめる。2.6）。reason は締切後の理由 */
interface ConflictAsk {
  cells: CellConflict[];
  data: RequestsTables;
  reason: string | null;
}

function queryString(category: GroupCategory | null, filter: RequestsFilter | null): string {
  const p = new URLSearchParams();
  if (category) p.set('category', category);
  if (filter) p.set('filter', filter);
  const s = p.toString();
  return s ? `/requests?${s}` : '/requests';
}

function modeNotice(mode: LeadWriteMode, year: YearRow, lead: boolean, outside: boolean): React.ReactNode {
  if (!lead) return <ReadOnlyNotice>総務部門員は申請一覧を見るだけです</ReadOnlyNotice>;
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

function RequestsBoard({ yearId, userId, role }: { yearId: string; userId: string; role: AppRole | null }) {
  // 書けるのは部門長以上（セル・代理入力・提出済みにする・取り込み。D-50）。団体を作れる（マスタ）のは管理者だけ
  const lead = isLead(role);
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
  /** 保存の後の知らせ（送る前の読み直しで、前の保存が通っていた、など） */
  const [saveInfo, setSaveInfo] = useState<string | null>(null);
  /** ほかの人が先に変えたセルの確かめ（ref は閉じたときの扱いを、上書きの後に二重に行わないため） */
  const [conflictAsk, setConflictAskState] = useState<ConflictAsk | null>(null);
  const conflictAskRef = useRef<ConflictAsk | null>(null);
  const setConflictAsk = (a: ConflictAsk | null) => {
    conflictAskRef.current = a;
    setConflictAskState(a);
  };
  const [proxyGroupId, setProxyGroupId] = useState<string | null>(null);
  const [markRow, setMarkRow] = useState<MatrixRow | null>(null);
  const [importOpen, setImportOpen] = useState(false);

  const draftKeyValue: DraftKey = useMemo(() => ({ userId, yearId, screen: 'requests' }), [userId, yearId]);
  const writer = useMemo(() => createDraftWriter<PendingCells>(draftKeyValue), [draftKeyValue]);
  const [draft, setDraft] = useState(() => {
    // 下書きは未保存のセル（入れた数と、編集したときの行）。形の違う値（古い形の下書きなど）は捨てる
    const d = lead ? loadDraft<unknown>(draftKeyValue) : null;
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

  const tables = q.data;
  const matrix = useMemo(() => (tables ? buildRequestMatrix(tables, { category, filter }) : null), [tables, category, filter]);
  const allRows = useMemo(() => (tables ? buildRequestMatrix(tables) : null), [tables]);
  /**
   * 未保存のセルの数（保存のボタン・離れるときの確かめ）。今の表の数と同じセル（応答が届かなかった後に、読み直しも落ちたまま
   * 入力の元の数へ戻したセルなど）も数える：表が古いと DB の数と違うことがあり、押すと保存の読み直しで決まる（2.6 の (A) の (1)）
   */
  const unsaved = Object.keys(pending).length;
  const totals = useMemo(() => (matrix ? columnTotals(matrix, pending) : {}), [matrix, pending]);
  /**
   * 未保存のセルのうち、編集した後に裏で届いた表で数が変わったもの（入力の元とも入れた数とも違う。保存の判定と同じ judgePendingCells）。
   * 入力は置き換えず、知らせだけを出す（R1。置き換えるのは、保存が決まったとき・知らせかダイアログの「読み直す」・取り消すときだけ）
   */
  const remoteCells = useMemo(() => (tables ? judgePendingCells(pending, tables).conflicts : []), [pending, tables]);
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
   * 表（読み直した表・戻した下書きの相手）に未保存のセルを当て直す。入れた数は捨てない：DB の数が入れた数と同じになったセルと、
   * なくなった団体・品目のセルだけを外す（rebasePending）。ほかの人の変更かどうかは、保存を押したときの読み直しで決める（2.6 の (A)）。
   */
  const rebaseOnto = (t: RequestsTables, prepare: (p: PendingCells) => PendingCells = (p) => p) => {
    applyPending((p) => rebasePending(prepare(p), t));
    rebasedRef.current = t;
  };

  /**
   * 保存の結果を未保存のセルに当てる（最新の未保存のセルに対して）。
   * - saved：保存したセル。送った値のままなら外す。送った後に入れ直していれば、基準を保存した行に付け替えて残す。
   * - revert：読み直した値に戻すセル。keep：値を残して基準を今の行に付け替えるセル（締切後の conflict。2.5）。
   * その後で、読み直した表に残りを当て直す（応答が届かなかったセルも、DB が送った数になっていればここで外れる）。
   */
  const applySaveResults = (
    data: RequestsTables | undefined,
    sent: readonly CellChange[],
    { saved, revert, keep }: { saved: ReadonlySet<string>; revert: ReadonlySet<string>; keep: ReadonlySet<string> },
  ) => {
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
    if (data) rebaseOnto(data, prepare);
    else applyPending(prepare);
  };

  /** 表が届いたら当て直す（読み直す・代理入力や取り込みの後の invalidate・ほかの書き込みの後の読み直し）。保存中は保存が行う */
  const onTablesLoaded = useEffectEvent((t: RequestsTables) => {
    if (savingRef.current || rebasedRef.current === t) return;
    rebaseOnto(t);
  });
  useEffect(() => {
    if (q.data) onTablesLoaded(q.data);
  }, [q.data]);

  // 読み直しに失敗しても、表があれば表を出したままにする（未保存のセルを残し、もう一度保存できるように）
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
  const mode: LeadWriteMode = lead ? leadWriteMode(year, now, flagged) : 'readonly';
  const editable = lead && mode !== 'readonly';
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
    if (data && !savingRef.current && rebasedRef.current !== data) rebaseOnto(data);
    return data;
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

  /**
   * 応答が届かなかったセルのうち、保存の後の読み直しでも未保存のまま残ったもの（保存できたか分からない。入力と印を残す）の数。
   * 外れたもの（読み直した DB の数が送った数と同じ）は保存できたので印も外す。読み直した数が違えば、ほかの人が後で変えていても
   * 入力を残し（裏の当て直しは入力を捨てない）、次の保存の読み直しで確かめる。
   */
  const stillUnknown = (keys: readonly string[]): number => {
    const left = keys.filter((k) => Object.hasOwn(pendingRef.current, k));
    applyMarks(Object.fromEntries(keys.filter((k) => !left.includes(k)).map((k) => [k, null])));
    return left.length;
  };

  /** 締切前：セルごとに直接送る。savedBefore は送る前の読み直しで保存されていたセルの数 */
  const sendDirect = async (sent: CellChange[], savedBefore: number) => {
    const results = await saveCellsDirect(sent);
    const markUpdates: Record<string, CellMark | null> = {};
    const saved = new Set<string>();
    const revert = new Set<string>();
    const unknown: string[] = [];
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
        // ほかの人が先に変えた（読み直しと送る間）：読み直した値に戻して印をつける
        revert.add(key);
        markUpdates[key] = 'conflict';
        conflicts++;
        continue;
      }
      markUpdates[key] = 'error';
      if (isUnknownOutcome(r.error)) unknown.push(key);
      else if (kind === 'forbidden') forbidden ??= r.error;
      else other ??= r.error;
    }
    applyMarks(markUpdates);
    applySaveResults(await refetchFresh(), sent, { saved, revert, keep: new Set() });
    const uncertain = stillUnknown(unknown);

    // 失敗はまとめて見る：forbidden があれば時計のずれを判断する（最初の失敗が conflict でも）
    const parts: string[] = [];
    if (conflicts > 0) parts.push(`${conflicts} 件はほかの人が先に変えたので、読み直した値に戻しました`);
    if (uncertain > 0) parts.push(unknownOutcomeMessage());
    const primary = forbidden ?? other;
    if (primary) parts.push(await handleWriteError(primary, 'direct', undefined));
    const savedCount = saved.size + unknown.length - uncertain;
    const notSent = sent.length - results.length;
    setSaveInfo(savedBefore > 0 ? `${savedBefore} 件は保存されていました` : null);
    if (parts.length > 0) {
      const failed = results.length - savedCount - uncertain;
      setSaveError(`${saveSummary('件', { saved: savedCount, failed, uncertain, notSent })}：${parts.join('／')}`);
      toast.error(parts[parts.length - 1]!);
    } else {
      toast.success(`${savedCount} 件を保存しました`);
    }
  };

  /** 締切後：団体ごとに理由つきで送る。理由が空なら投げる（理由のダイアログを開いたままにする） */
  const sendDeadline = async (sent: CellChange[], reason: string, savedBefore: number) => {
    const byGroup = groupDeadlineRows(sent);
    const results = await saveGroupsAfterDeadline(byGroup, reason);
    const markUpdates: Record<string, CellMark | null> = {};
    const saved = new Set<string>();
    const keep = new Set<string>();
    const unknown: string[] = [];
    const messages: string[] = [];
    let reasonError: unknown = null;
    for (const r of results) {
      const isUnknown = !r.ok && isUnknownOutcome(r.error);
      for (const row of byGroup.get(r.groupId) ?? []) {
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
          if (isUnknown) unknown.push(key);
        }
      }
      if (!r.ok && !isUnknown) {
        if (r.error.info.kind === 'reason') reasonError = r.error;
        messages.push(await handleWriteError(r.error, 'update_requests_after_deadline', r.groupId));
      }
    }
    applyMarks(markUpdates);
    applySaveResults(await refetchFresh(), sent, { saved, revert: new Set(), keep });
    const uncertainCells = stillUnknown(unknown);
    // 団体は全部か何もないかなので、残ったセルの団体を数える
    const uncertain = new Set(unknown.filter((k) => Object.hasOwn(pendingRef.current, k)).map((k) => k.split(':')[0]!)).size;
    if (uncertainCells > 0) messages.push(unknownOutcomeMessage());
    const unknownGroups = new Set(unknown.map((k) => k.split(':')[0]!)).size;
    const okGroups = results.filter((r) => r.ok).length + unknownGroups - uncertain;
    setSaveInfo(savedBefore > 0 ? `${savedBefore} 件は保存されていました` : null);
    if (messages.length > 0) {
      const notSent = byGroup.size - results.length;
      const failed = results.length - okGroups - uncertain;
      setSaveError(`${saveSummary('団体', { saved: okGroups, failed, uncertain, notSent })}：${messages.join('／')}`);
      toast.error(messages[0]!);
    } else {
      toast.success(`${okGroups} 団体の申請を保存しました`);
    }
    if (reasonError) throw reasonError;
  };

  /**
   * 保存（締切前は直接、締切後は reason つき）。送る前に表を読み直し、セルごとに決める（設計 2.6 の (A)。judgePendingCells）：
   * DB がすでに入れた数のセルは送らずに「保存されていました」、ほかの人が先に変えたセルがあれば送らずに上書きするか確かめる、
   * ほかは入力の元を読み直した行にして送る。読み直しが通信できなければ送らずに知らせる（入力は残す）。
   * 'changed' はほかの人の変更があって送らなかった（上書きの確かめを出した）。
   */
  const runSave = async (reason: string | null): Promise<'changed' | 'done'> => {
    savingRef.current = true;
    setSaving(true);
    setSaveError(null);
    setSaveInfo(null);
    try {
      const res = await q.refetch();
      if (!res.isSuccess) {
        const msg = isUnknownOutcome(res.error) ? unknownOutcomeMessage() : messageFor(classifyError(res.error));
        setSaveError(msg);
        toast.error(msg);
        return 'done';
      }
      const data = res.data;
      rebasedRef.current = data;
      const { saved, conflicts } = judgePendingCells(pendingRef.current, data);
      const conflictKeys = new Set(conflicts.map((c) => c.key));
      applyMarks(Object.fromEntries(saved.map((k) => [k, null])));
      // 入力の元を読み直した行にする（DB がすでに入れた数のセルはここで外れる）
      applyPending((p) => rebaseKeysTo(p, Object.keys(p).filter((k) => !conflictKeys.has(k)), data));
      if (conflicts.length > 0) {
        setConflictAsk({ cells: conflicts, data, reason });
        return 'changed';
      }
      const sent = pendingChanges(pendingRef.current, data);
      if (sent.length === 0) {
        if (saved.length > 0) {
          setSaveInfo(`保存されていました（${saved.length} 件）`);
          toast.success('保存されていました');
        }
        return 'done';
      }
      if (mode === 'deadline') await sendDeadline(sent, reason ?? '', saved.length);
      else await sendDirect(sent, saved.length);
      return 'done';
    } finally {
      savingRef.current = false;
      setSaving(false);
    }
  };

  /**
   * ほかの人が先に変えたセルを上書きする：入力の元を読み直した行にして、もう一度保存する（もう一度読み直してから送る）。
   * その読み直しでまた変わっていれば、送らずに最新の値で確かめ直す（投げてダイアログを開いたままにする。閉じると
   * onOpenChange(false) で新しい確かめを「読み直す」として扱ってしまうため。/request・代理入力の changed_again と同じ）。
   */
  const overwriteConflicts = async () => {
    const ask = conflictAskRef.current;
    if (!ask) return;
    setConflictAsk(null);
    applyPending((p) => rebaseKeysTo(p, ask.cells.map((c) => c.key), ask.data));
    if ((await runSave(ask.reason)) === 'changed') throw new Error('changed_again');
  };

  /** 編集した後に変わったセルを、今の表の値に戻して印をつける（ダイアログの「読み直す」・知らせの「…読み直した値に戻す」） */
  const revertCells = (keys: readonly string[]) => {
    applyPending((p) => {
      const next = { ...p };
      for (const k of keys) delete next[k];
      return next;
    });
    applyMarks(Object.fromEntries(keys.map((k) => [k, 'conflict' as const])));
    toast.info(`${keys.length} 件のセルを読み直した値に戻しました`);
  };

  /** 読み直す（ダイアログを閉じたときも）：編集した後に変わったセルを読み直した値に戻して印をつける */
  const revertConflicts = () => {
    const ask = conflictAskRef.current;
    if (!ask) return;
    setConflictAsk(null);
    revertCells(ask.cells.map((c) => c.key));
  };

  const onSave = () => {
    if (unsaved === 0 || saving) return;
    if (mode === 'deadline') setReasonOpen(true);
    else if (mode === 'direct') void runSave(null);
  };

  const onMarkSubmitted = async (row: MatrixRow, reason: string | null) => {
    try {
      // すでに提出済みなら書かない（提出日時を今に変えない。応答が届かなかった後の押し直しもこれで決まる）
      const already =
        mode === 'deadline'
          ? await markSubmittedAfterDeadline(row.group.id, reason ?? '')
          : await markSubmittedDirect(row.group.id).then((r) => (r.already ? r.row : null));
      if (already) {
        toast.info(`${row.group.name}はすでに提出済みでした（${already.submitted_at ? formatDateTime(already.submitted_at) : ''}）。読み直しました`);
      } else {
        toast.success(`${row.group.name}を提出済みにしました`);
      }
      await reloadTables();
    } catch (e) {
      const msg = isUnknownOutcome(e)
        ? '提出済みにできたか分かりません。もう一度「提出済みにする」を押すと、確かめてから送ります'
        : await handleWriteError(e, mode === 'deadline' ? 'update_requests_after_deadline' : 'direct', row.group.id);
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
      {modeNotice(mode, year, lead, flagged)}
      {draft && editable && Object.keys(rebasePending(draft.value, tables)).length > 0 ? (
        <DraftNotice
          savedAt={draft.savedAt}
          onRestore={() => {
            // 入れた数と編集したときの行（入力の元）を戻す。DB がすでに入れた数のセルだけ外れる。ほかの人の変更は保存のときに確かめる
            rebaseOnto(tables, () => draft.value);
            setDraft(null);
          }}
          onDiscard={() => {
            writer.cancel();
            removeDraft(draftKeyValue);
            setDraft(null);
          }}
        />
      ) : null}
      <UnsavedChangesGuard when={editable && unsaved > 0} />

      {tables.groups.length === 0 ? (
        // 団体はマスタ（管理者がマスタ設定で登録する）。管理者でない人には、取り込みのダイアログと同じく管理者に頼む文を出す（D-50）
        <EmptyState
          title="団体がありません"
          description={
            isAdmin(role)
              ? 'マスタ設定で団体を登録すると、ここに申請が並びます。'
              : '管理者に団体の登録を頼んでください（登録されると、ここに申請が並びます）。'
          }
          action={isAdmin(role) ? <AppLink href="/settings?tab=groups">マスタ設定へ</AppLink> : undefined}
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
          {editable && remoteCells.length > 0 && !saving && !conflictAsk ? (
            <div
              role="status"
              data-testid="requests-remote-change"
              className="space-y-2 rounded-md border border-amber-300 bg-amber-50 px-3 py-2 text-sm text-amber-950 dark:border-amber-800 dark:bg-amber-950 dark:text-amber-100"
            >
              <p>
                編集した後に、表を読み直したら数が変わったセルがあります（ほかの人の変更のほか、前に送って応答が届かなかった自分の保存のこともあります）。入れた数はそのまま残しています。保存するときに、上書きするか読み直すかを選べます。
              </p>
              <ul className="max-h-40 space-y-1 overflow-auto">
                {remoteCells.map((c) => (
                  <li key={c.key}>
                    {names.group?.(c.groupId) ?? ''}の{names.item?.(c.itemId) ?? ''}：{c.base} → {c.fresh}（入れた数 {c.value}）
                  </li>
                ))}
              </ul>
              <Button size="sm" variant="outline" onClick={() => revertCells(remoteCells.map((c) => c.key))}>
                変わったセルを読み直した値に戻す
              </Button>
            </div>
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
              lead={lead}
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
              <Button disabled={unsaved === 0 || saving} aria-busy={saving || undefined} onClick={onSave}>
                {saving ? '保存中…' : `保存（${unsaved}件）`}
              </Button>
              <Button variant="outline" disabled={unsaved === 0 || saving} onClick={() => applyPending(() => ({}))}>
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
        title={`締切後の申請の変更（${unsaved}件）`}
        description="団体ごとに保存します。理由は履歴に残ります。"
        presets={['団体の希望', '総務の確認', '入力の誤り']}
        pending={saving}
        onSubmit={async (reason) => {
          await runSave(reason ?? '');
        }}
      />
      <ConfirmDialog
        open={conflictAsk !== null}
        onOpenChange={(o) => {
          if (!o) revertConflicts();
        }}
        title="編集した後に変わったセルがあります。上書きして保存しますか"
        description="保存の前に読み直したら、次のセルの数が、編集を始めたときとも入れた数とも違っていました（まだ何も送っていません）。ほかの人の変更のほか、前に送って応答が届かなかった自分の保存のこともあります（セルは書いた人を記録しないため）。上書きすると入れた数で保存します。読み直すと、読み直した値に戻して印をつけます。"
        confirmLabel="上書きして保存する"
        cancelLabel="読み直す"
        pendingLabel="保存中…"
        pending={saving}
        onConfirm={overwriteConflicts}
      >
        <ul className="max-h-60 space-y-1 overflow-auto text-sm" data-testid="cell-conflicts">
          {conflictAsk?.cells.map((c) => (
            <li key={c.key}>
              {names.group?.(c.groupId) ?? ''}の{names.item?.(c.itemId) ?? ''}：{c.base} → {c.fresh}（入れた数 {c.value}）
            </li>
          ))}
        </ul>
      </ConfirmDialog>
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
          canCreateGroups={isAdmin(role)}
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
        userId={userId}
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
