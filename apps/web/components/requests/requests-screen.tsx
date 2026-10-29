'use client';

import { GROUP_CATEGORIES, type GroupCategory } from '@gaapp/shared';
import { useQueryClient } from '@tanstack/react-query';
import { useSearchParams } from 'next/navigation';
import { useEffect, useMemo, useState } from 'react';
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
  judgeDirectFailure,
  judgeSubmitFailure,
  markSubmittedAfterDeadline,
  markSubmittedDirect,
  outsideFlagOf,
  pendingChanges,
  prunePending,
  remainingText,
  saveCellsDirect,
  saveGroupsAfterDeadline,
  setPendingCell,
  useRequestsTables,
  type AdminWriteMode,
  type MatrixRow,
  type OutsideFlag,
  type PendingCells,
  type RequestsTables,
} from '@/lib/data/requests';
import { useYearRow, type YearRow } from '@/lib/data/year';
import { createDraftWriter, loadDraft, removeDraft, type DraftKey } from '@/lib/drafts';
import { AppError, classifyError, effectOf, messageFor, type NameLookup } from '@/lib/errors';
import { CATEGORY_LABELS } from '@/lib/labels';
import { useGuardedRouter } from '@/lib/navigation/guarded-router';
import { queryKeys } from '@/lib/query';
import { parseCategoryParam, parseFilterParam, type RequestsFilter } from '@/lib/schemas/requests';
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
  const [proxyGroupId, setProxyGroupId] = useState<string | null>(null);
  const [markRow, setMarkRow] = useState<MatrixRow | null>(null);

  const draftKeyValue: DraftKey = useMemo(() => ({ userId, yearId, screen: 'requests' }), [userId, yearId]);
  const writer = useMemo(() => createDraftWriter<PendingCells>(draftKeyValue), [draftKeyValue]);
  const [draft, setDraft] = useState(() => (admin ? loadDraft<PendingCells>(draftKeyValue) : null));
  useEffect(() => () => writer.flush(), [writer]);

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

  const updatePending = (next: PendingCells) => {
    setPending(next);
    if (Object.keys(next).length === 0) writer.clear();
    else writer.write(next);
  };

  if (yearQ.isError || q.isError) {
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

  /** 書き込みの後に読み直す（表と年度。未保存のセルは DB と同じになったものを外す） */
  const reloadTables = async (): Promise<RequestsTables | undefined> => {
    const res = await q.refetch();
    if (res.data) setPending((p) => prunePending(p, res.data));
    return res.data;
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

  const saveDirect = async () => {
    setSaving(true);
    setSaveError(null);
    try {
      const results = await saveCellsDirect(changes);
      const nextMarks = { ...marks };
      let next: Record<string, number> = { ...pending };
      let okCount = 0;
      let firstError: AppError | null = null;
      for (const r of results) {
        const key = cellKey(r.change.groupId, r.change.itemId);
        if (r.ok) {
          okCount++;
          delete next[key];
          delete nextMarks[key];
          continue;
        }
        const kind = r.error.info.kind;
        if (kind === 'conflict' || kind === 'not_found') {
          // ほかの人が先に変えた：読み直した値に戻して印をつける
          delete next[key];
          nextMarks[key] = 'conflict';
        } else {
          nextMarks[key] = 'error';
        }
        firstError ??= r.error;
      }
      setMarks(nextMarks);
      const data = await reloadTables();
      if (data) next = prunePending(next, data);
      updatePending(next);
      if (firstError) {
        const msg = await handleWriteError(firstError, 'direct', undefined);
        const notSent = changes.length - results.length;
        const head = `${okCount} 件を保存しました。${results.length - okCount} 件は保存できませんでした${notSent > 0 ? `（${notSent} 件は送っていません）` : ''}`;
        setSaveError(`${head}：${msg}`);
        toast.error(msg);
      } else {
        toast.success(`${okCount} 件を保存しました`);
      }
    } finally {
      setSaving(false);
    }
  };

  const saveDeadline = async (reason: string) => {
    setSaving(true);
    setSaveError(null);
    try {
      const byGroup = groupDeadlineRows(changes);
      const results = await saveGroupsAfterDeadline(byGroup, reason);
      const nextMarks = { ...marks };
      let next: Record<string, number> = { ...pending };
      const messages: string[] = [];
      let reasonError: unknown = null;
      for (const r of results) {
        const rows = byGroup.get(r.groupId) ?? [];
        for (const row of rows) {
          const key = cellKey(r.groupId, row.itemId);
          if (r.ok) {
            delete next[key];
            delete nextMarks[key];
          } else {
            // 締切後の conflict は、その団体を読み直し、変えたセルの値は残して印をつける（2.5）
            nextMarks[key] = r.error.info.kind === 'conflict' ? 'conflict' : 'error';
          }
        }
        if (!r.ok) {
          if (r.error.info.kind === 'reason') reasonError = r.error;
          messages.push(await handleWriteError(r.error, 'update_requests_after_deadline', r.groupId));
        }
      }
      setMarks(nextMarks);
      const data = await reloadTables();
      if (data) next = prunePending(next, data);
      updatePending(next);
      const okGroups = results.filter((r) => r.ok).length;
      if (messages.length > 0) {
        const notSent = byGroup.size - results.length;
        setSaveError(
          `${okGroups} 団体を保存しました。${results.length - okGroups} 団体は保存できませんでした${notSent > 0 ? `（${notSent} 団体は送っていません）` : ''}：${messages.join('／')}`,
        );
        toast.error(messages[0]!);
      } else {
        toast.success(`${okGroups} 団体の申請を保存しました`);
      }
      if (reasonError) throw reasonError;
    } finally {
      setSaving(false);
    }
  };

  const onSave = () => {
    if (changes.length === 0 || saving) return;
    if (mode === 'deadline') setReasonOpen(true);
    else if (mode === 'direct') void saveDirect();
  };

  const onMarkSubmitted = async (row: MatrixRow, reason: string | null) => {
    try {
      if (mode === 'deadline') await markSubmittedAfterDeadline(row.group.id, reason ?? '');
      else await markSubmittedDirect(row.group.id);
      toast.success(`${row.group.name}を提出済みにしました`);
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
            setPending(draft.value ?? {});
            setDraft(null);
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
          {matrix.rows.length === 0 ? (
            <EmptyState title="条件に合う団体がありません" />
          ) : (
            <RequestsTable
              matrix={matrix}
              pending={pending}
              marks={marks}
              totals={totals}
              editable={editable}
              admin={admin}
              onCellChange={(row, itemId, value) => {
                const key = cellKey(row.group.id, itemId);
                if (marks[key]) {
                  const m = { ...marks };
                  delete m[key];
                  setMarks(m);
                }
                updatePending(setPendingCell(pending, row.group.id, itemId, value, row.cells[itemId]?.count ?? 0));
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
              <Button disabled={changes.length === 0 || saving} aria-busy={saving || undefined} onClick={onSave}>
                {saving ? '保存中…' : `保存（${changes.length}件）`}
              </Button>
              <Button variant="outline" disabled={changes.length === 0 || saving} onClick={() => updatePending({})}>
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
