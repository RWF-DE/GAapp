'use client';

// 備品と割り当て（/lending。PC。04「テント等の貸し出し」の「備品と割り当て」、notes/T21.md「画面の約束」4・9・10。T21・D-57）。
// - 開ける人は総務と閲覧のみ（ページの守りは RequireAudience）。読むものは lendingBoardOptions（閲覧のみは申請・記録を読まない）。
// - 段（lib/auth/roles.ts）：部門長以上は備品の登録・編集・削除・前年度から読み込む・割り当ての編集・確定・確定の解除、総務部門員は
//   読むだけ（と CSV）、閲覧のみは確定後の備品と割り当てだけ（確定前は「割り当ては確定後に表示されます」だけ）。終了した年度は読むだけ。
//   画面の出し分けは見た目だけで、書けるかは RLS と RPC が守る。
// - 割り当ての編集は未保存の変更（セル → 数と、入力を始めたときの版）として持ち、「保存（N件）」で save_lending_assignments を1回呼ぶ。
//   未保存の変更は下書きに置き、離れるとき・年度を切り替えるときに確かめる。応答が届かない・conflict は送った組を読み直して決める（(B1)）。
// - 版（allocation_version）・スナップショットは使わない。
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { FileDown } from 'lucide-react';
import { useSearchParams } from 'next/navigation';
import { useEffect, useMemo, useState } from 'react';
import { toast } from 'sonner';
import { ConfirmDialog } from '@/components/common/confirm-dialog';
import { DraftNotice } from '@/components/common/draft-notice';
import { ErrorBanner } from '@/components/common/error-banner';
import { PageHeader } from '@/components/common/page-header';
import { QueryState } from '@/components/states';
import { Button } from '@/components/ui/button';
import { useAuth } from '@/lib/auth/auth-provider';
import { useAuthErrorHandler } from '@/lib/auth/guarded';
import type { Membership } from '@/lib/auth/membership';
import { isLead, isSoumu } from '@/lib/auth/roles';
import {
  applyAssignmentResult,
  assignmentChanges,
  assignmentRowsChanged,
  invalidateLending,
  lendingBoardOptions,
  pruneAssignmentEdits,
  readAssignmentRows,
  rebaseAssignmentEdits,
  replaceAssignmentRows,
  sameAssignmentInput,
  saveLendingAssignments,
  type AssignmentEdit,
  type LendingAssignmentRow,
  type LendingBoardData,
} from '@/lib/data/lending';
import { useYearRow } from '@/lib/data/year';
import { formatShortDateTime } from '@/lib/datetime';
import { downloadFile, MIME } from '@/lib/download';
import { createDraftWriter, loadDraft, removeDraft, type DraftKey } from '@/lib/drafts';
import { classifyError, effectOf, isUnknownOutcome, messageFor, type MessageContext } from '@/lib/errors';
import { cellKey, fillRequested, lendingTotals } from '@/lib/modules/lending/counts';
import { LENDING_CLOSED_TEXT } from '@/lib/modules/lending/labels';
import { useGuardedRouter } from '@/lib/navigation/guarded-router';
import { useUnsavedChanges } from '@/lib/unsaved-changes';
import { AssignmentsTable, lendingHref, parseAssignmentFilter } from './assignments-table';
import { LendingNotice } from './common';
import { ConfirmActions } from './confirm-actions';
import { ItemsTable } from './items-table';

/** 帯の文（04「備品と割り当て」） */
export const LENDING_TEXTS = {
  staff: '総務部門員は備品と割り当てを見るだけです（登録・割り当て・確定は管理者・総務部門長・総務副部門長が行います）。',
  confirmed: '確定中です。直すときは「確定を解除」してください',
  viewerBefore: '割り当ては確定後に表示されます',
} as const;

/** 割り当ての保存で、応答が届かず保存できたか分からない */
export function assignmentUnknownMessage(n: number): string {
  return `保存できたか分かりません。もう一度「保存（${n}件）」を押すと、確かめてから送ります`;
}
/** conflict で読み直した後に添える文 */
export const ASSIGNMENT_KEEP_INPUT = '入力は残してあります。確かめてから、もう一度「保存」を押してください（押すと、この入力で上書きします）';

export function LendingScreen() {
  const { membership, session } = useAuth();
  if (membership.status !== 'ready') return null; // AppShell が読み込み中・未招待を出す
  const m = membership.membership;
  if (!m.year) return null;
  const userId = session.status === 'signedIn' ? session.session.user.id : null;
  return <LendingBoard key={m.year.id} membership={m} yearId={m.year.id} userId={userId} />;
}

/** 下書きの形（セルのキー → 変更）。形が違えば戻さない */
function normalizeEditsDraft(v: unknown): [string, AssignmentEdit][] | null {
  if (!Array.isArray(v)) return null;
  const out: [string, AssignmentEdit][] = [];
  for (const e of v) {
    if (!Array.isArray(e) || e.length !== 2 || typeof e[0] !== 'string' || !/^[^:]+:[^:]+$/.test(e[0])) return null;
    const x = e[1] as { count?: unknown; base?: unknown } | null;
    if (!x || typeof x !== 'object') return null;
    const count = x.count;
    if (count !== null && !(typeof count === 'number' && Number.isInteger(count) && count >= 0 && count <= 10000)) return null;
    if (x.base !== null && typeof x.base !== 'string') return null;
    out.push([e[0], { count, base: x.base }]);
  }
  return out;
}

function LendingBoard({ membership: m, yearId, userId }: { membership: Membership; yearId: string; userId: string | null }) {
  const queryClient = useQueryClient();
  const { reloadMembership } = useAuth();
  const onAuthError = useAuthErrorHandler();
  const router = useGuardedRouter();
  const params = useSearchParams();
  const role = m.role;
  const soumu = isSoumu(role);
  const lead = isLead(role);
  const yearQ = useYearRow(yearId);
  const boardOptions = lendingBoardOptions(yearId, soumu);
  const q = useQuery(boardOptions);
  // 画面を開いた時刻（確定の押せない理由の「締切の後」）。「読み直す」で押した時刻にする
  const [now, setNow] = useState(() => Date.now());
  const year = yearQ.data;
  const status = year?.status ?? m.year?.status ?? null;
  const closed = status === 'closed';
  const data = q.data;
  const confirmed = !!data?.confirmedAt;
  const editable = lead && !closed && !confirmed && !!userId;
  const filter = parseAssignmentFilter(params);

  // ---- 割り当ての未保存の変更（下書きつき） ----
  const draftKeyValue = useMemo<DraftKey | null>(() => (userId ? { userId, yearId, screen: 'lending', target: 'assignments' } : null), [userId, yearId]);
  const writer = useMemo(() => (draftKeyValue ? createDraftWriter<[string, AssignmentEdit][]>(draftKeyValue) : null), [draftKeyValue]);
  const [edits, setEdits] = useState<Map<string, AssignmentEdit>>(() => new Map());
  const [draft, setDraft] = useState(() => {
    const d = draftKeyValue ? loadDraft<unknown>(draftKeyValue) : null;
    const value = d ? normalizeEditsDraft(d.value) : null;
    return d && value && value.length > 0 ? { value, savedAt: d.savedAt } : null;
  });
  useEffect(() => () => writer?.flush(), [writer]);
  const [saving, setSaving] = useState(false);
  const [saveNotice, setSaveNotice] = useState<{ message: string } | null>(null);
  const [discardOpen, setDiscardOpen] = useState(false);
  const changes = data ? assignmentChanges(edits, data.assignments) : [];
  const unsaved = changes.length;
  useUnsavedChanges(editable && unsaved > 0);

  const names = useMemo<MessageContext['names']>(
    () => ({ group: (id) => data?.groups.find((g) => g.id === id)?.name, item: (id) => data?.items.find((i) => i.id === id)?.name }),
    [data],
  );
  const totals = useMemo(() => (data ? lendingTotals(data.items, data.requests ?? [], data.assignments, data.records ?? []) : []), [data]);

  /**
   * 未保存の変更を置き換え、下書きに写す（空なら消す）。戻していない前の下書きは、今の入力で置き換える（在庫入力と同じ。新しく入れ始めた・
   * 保存が決まったので、前の下書きの「戻す」は出さない）
   */
  const commitEdits = (next: Map<string, AssignmentEdit>) => {
    setEdits(next);
    setDraft(null);
    if (!writer) return;
    if (next.size === 0) writer.clear();
    else writer.write([...next]);
  };

  const putAssignments = (next: LendingAssignmentRow[]) =>
    queryClient.setQueryData<LendingBoardData>(boardOptions.queryKey, (old) => (old ? { ...old, assignments: next } : old));

  const reload = () => {
    setNow(Date.now());
    void q.refetch();
    void yearQ.refetch();
  };
  const reloadYear = () => {
    reloadMembership();
    void yearQ.refetch();
  };
  const afterWrite = () => {
    setNow(Date.now());
    invalidateLending(queryClient, yearId);
  };

  const onEdit = (groupId: string, itemId: string, count: number | null) => {
    if (!data || !editable) return;
    const key = cellKey(groupId, itemId);
    const row = data.assignments.find((a) => a.group_id === groupId && a.lending_item_id === itemId);
    const next = new Map(edits);
    const prev = edits.get(key);
    if (count === null ? !row : row?.count === count) next.delete(key);
    else next.set(key, { count, base: prev ? prev.base : (row?.updated_at ?? null) });
    commitEdits(next);
  };

  const onFill = (itemId: string) => {
    if (!data || !editable) return;
    const cells = fillRequested(itemId, data.requests ?? [], data.assignments, new Set(edits.keys()), new Set(data.groups.map((g) => g.id)));
    if (cells.length === 0) {
      toast.info('入れるセルはありません（割り当てのない申請がありません）');
      return;
    }
    const next = new Map(edits);
    for (const c of cells) next.set(cellKey(c.groupId, c.itemId), { count: c.count, base: null });
    commitEdits(next);
    toast.success(`申請の数を ${cells.length} か所に入れました（まだ保存していません）`);
  };

  const save = async () => {
    if (!data || !editable || saving) return;
    const sent = assignmentChanges(edits, data.assignments);
    if (sent.length === 0) {
      commitEdits(pruneAssignmentEdits(edits, data.assignments));
      return;
    }
    setSaving(true);
    setSaveNotice(null);
    const keys = sent.map((c) => cellKey(c.groupId, c.itemId));
    try {
      let failure: unknown = null;
      let result: Awaited<ReturnType<typeof saveLendingAssignments>> | null = null;
      try {
        result = await saveLendingAssignments(yearId, sent);
      } catch (e) {
        failure = e;
        if ((await onAuthError(e)) === 'retry') {
          try {
            result = await saveLendingAssignments(yearId, sent);
            failure = null;
          } catch (e2) {
            failure = e2;
          }
        }
      }
      const current = queryClient.getQueryData<LendingBoardData>(boardOptions.queryKey)?.assignments ?? data.assignments;
      if (result) {
        const next = applyAssignmentResult(current, result);
        putAssignments(next);
        const rest = new Map(edits);
        for (const k of keys) rest.delete(k);
        commitEdits(pruneAssignmentEdits(rest, next));
        toast.success(`割り当てを保存しました（${sent.length}件）`);
        afterWrite();
        return;
      }
      const c = classifyError(failure);
      const unknown = isUnknownOutcome(failure);
      if (unknown || c.kind === 'conflict') {
        let fresh: LendingAssignmentRow[];
        try {
          fresh = await readAssignmentRows(yearId, sent);
        } catch {
          setSaveNotice({
            message: unknown
              ? assignmentUnknownMessage(sent.length)
              : `${messageFor(c, { rpc: 'save_lending_assignments', names })}（読み直せませんでした。「読み直す」を押してから、もう一度保存してください）`,
          });
          return;
        }
        const next = replaceAssignmentRows(current, keys, fresh);
        putAssignments(next);
        if (sameAssignmentInput(fresh, sent)) {
          const rest = new Map(edits);
          for (const k of keys) rest.delete(k);
          commitEdits(pruneAssignmentEdits(rest, next));
          toast.success('保存されていました');
          afterWrite();
          return;
        }
        if (!unknown || assignmentRowsChanged(fresh, sent)) {
          // ほかの人が先に変えた：読み直した版に進めて入力を残す（次の保存はこの入力で上書きする）
          commitEdits(pruneAssignmentEdits(rebaseAssignmentEdits(edits, keys, fresh), next));
          const message = unknown ? 'ほかの人が先に割り当てを変えました。読み直しました' : messageFor(c, { rpc: 'save_lending_assignments', names });
          setSaveNotice({ message: `${message}。${ASSIGNMENT_KEEP_INPUT}` });
          afterWrite();
          return;
        }
        setSaveNotice({ message: assignmentUnknownMessage(sent.length) });
        return;
      }
      const effect = effectOf(c);
      if (effect.reload === 'year') reloadYear();
      void q.refetch();
      setSaveNotice({ message: messageFor(c, { rpc: 'save_lending_assignments', names }) });
    } finally {
      setSaving(false);
    }
  };

  const exportCsv = async () => {
    if (!data || !m.year) return;
    const { buildLendingCsv } = await import('@/lib/modules/lending/csv');
    const { fileName, text } = buildLendingCsv({
      yearLabel: m.year.label,
      items: data.items,
      groups: data.groups,
      requests: data.requests ?? [],
      assignments: data.assignments,
      records: data.records ?? [],
    });
    downloadFile(text, fileName, MIME.csv);
  };

  const showTables = soumu || confirmed;

  return (
    <div className="mx-auto max-w-7xl space-y-4 pb-20">
      <PageHeader
        title="備品と割り当て"
        loadedAt={q.dataUpdatedAt ? new Date(q.dataUpdatedAt) : null}
        onReload={reload}
        reloading={q.isFetching || yearQ.isFetching}
        actions={
          soumu ? (
            <Button variant="outline" data-testid="lending-csv" onClick={() => void exportCsv()} disabled={!data}>
              <FileDown aria-hidden />
              CSV 出力
            </Button>
          ) : undefined
        }
      />
      {soumu && closed ? <LendingNotice testId="lending-readonly">{LENDING_CLOSED_TEXT}</LendingNotice> : null}
      {soumu && !lead ? <LendingNotice testId="lending-staff-note">{LENDING_TEXTS.staff}</LendingNotice> : null}
      {lead && confirmed && !closed ? (
        <LendingNotice testId="lending-confirmed-note" tone="info">
          {LENDING_TEXTS.confirmed}
        </LendingNotice>
      ) : null}
      {yearQ.isError && !yearQ.data ? <ErrorBanner error={yearQ.error} onRetry={() => void yearQ.refetch()} /> : null}
      <QueryState query={q}>
        {(d) => (
          <>
            <div
              data-testid="lending-status"
              data-confirmed={d.confirmedAt ? 'true' : 'false'}
              className="flex flex-wrap items-start gap-x-6 gap-y-2 rounded-lg border bg-card p-4 text-sm"
            >
              <div className="space-y-1">
                <p className="font-semibold">{d.confirmedAt ? `割り当て：確定（${formatShortDateTime(d.confirmedAt)}）` : '割り当て：確定前'}</p>
                <p className="text-muted-foreground">
                  {year?.request_close_at ? `受付の締切 ${formatShortDateTime(year.request_close_at)}` : '受付の締切は未設定'}
                </p>
              </div>
              {lead && year && userId ? (
                <div className="ml-auto">
                  <ConfirmActions
                    yearId={yearId}
                    year={year}
                    now={now}
                    data={d}
                    totals={totals}
                    unsaved={unsaved}
                    onChanged={afterWrite}
                    onReloadMembership={reloadYear}
                  />
                </div>
              ) : null}
            </div>
            {!showTables ? (
              <LendingNotice testId="lending-before-confirm" tone="info">
                {LENDING_TEXTS.viewerBefore}
              </LendingNotice>
            ) : (
              <>
                <ItemsTable
                  data={d}
                  totals={totals}
                  soumu={soumu}
                  canEdit={lead && !closed}
                  yearId={yearId}
                  userId={userId}
                  onReload={reload}
                  onReloadMembership={reloadYear}
                />
                {draft && editable ? (
                  <DraftNotice
                    savedAt={draft.savedAt}
                    onRestore={() => {
                      const restored = new Map(draft.value);
                      setDraft(null);
                      setEdits(restored);
                      writer?.write([...restored]);
                    }}
                    onDiscard={() => {
                      writer?.cancel();
                      if (draftKeyValue) removeDraft(draftKeyValue);
                      setDraft(null);
                    }}
                  />
                ) : null}
                {saveNotice ? (
                  <div role="alert" data-testid="lending-save-error" className="rounded-md border border-destructive/40 bg-destructive/5 px-4 py-3 text-sm">
                    <p className="font-medium text-destructive">{saveNotice.message}</p>
                  </div>
                ) : null}
                <AssignmentsTable
                  data={d}
                  soumu={soumu}
                  editable={editable && !saving}
                  edits={edits}
                  onEdit={onEdit}
                  onFill={onFill}
                  filter={filter}
                  onFilterChange={(next) => router.forceReplace(lendingHref(next))}
                />
              </>
            )}
          </>
        )}
      </QueryState>
      {editable && (unsaved > 0 || saving) ? (
        <div className="sticky bottom-0 z-10 -mx-4 flex flex-wrap items-center justify-end gap-3 border-t bg-background/95 px-4 py-3 backdrop-blur md:-mx-6 md:px-6 print:hidden">
          <p className="mr-auto text-sm text-amber-700">保存していない変更が {unsaved} 件あります</p>
          <Button variant="outline" onClick={() => setDiscardOpen(true)} disabled={saving}>
            変更を取り消す
          </Button>
          <Button data-testid="lending-save" onClick={() => void save()} disabled={saving} aria-busy={saving || undefined}>
            {saving ? '保存中…' : `保存（${unsaved}件）`}
          </Button>
        </div>
      ) : null}
      <ConfirmDialog
        open={discardOpen}
        onOpenChange={setDiscardOpen}
        title="保存していない変更を取り消しますか"
        description="割り当ての表に入れた数を、保存してある数に戻します。"
        confirmLabel="取り消す"
        destructive
        onConfirm={() => {
          setSaveNotice(null);
          commitEdits(new Map());
        }}
      />
    </div>
  );
}
