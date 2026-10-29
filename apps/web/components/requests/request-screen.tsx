'use client';

import { useMutation, useQueryClient } from '@tanstack/react-query';
import { useSearchParams } from 'next/navigation';
import { useEffect, useMemo, useState } from 'react';
import { toast } from 'sonner';
import { ConfirmDialog } from '@/components/common/confirm-dialog';
import { DraftNotice } from '@/components/common/draft-notice';
import { LatestYearSwitch, useNotLatestYearConfirm } from '@/components/common/latest-year';
import { PageHeader } from '@/components/common/page-header';
import { TokyoTime } from '@/components/common/tokyo-time';
import { UnsavedChangesGuard } from '@/components/common/unsaved-changes-guard';
import { EmptyState, ErrorState, LoadingState, ReadOnlyNotice } from '@/components/states';
import { Button } from '@/components/ui/button';
import { useAuth } from '@/lib/auth/auth-provider';
import { useAuthErrorHandler } from '@/lib/auth/guarded';
import type { GroupSummary } from '@/lib/auth/membership';
import {
  decideGroupSave,
  fetchGroupRequestState,
  hasCountChanges,
  isOutsideFlagActive,
  judgeSubmitFailure,
  nonZeroSummary,
  outsideFlagOf,
  remainingText,
  requestWindowOf,
  stateChangesSince,
  submitRequests,
  toSubmitRows,
  useRepRequest,
  buildRequestForm,
  type GroupRequestState,
  type OutsideFlag,
  type RepRequestData,
  type RequestWindow,
} from '@/lib/data/requests';
import { useYearRow, type YearRow } from '@/lib/data/year';
import { formatDateTime, formatShortDateTime } from '@/lib/datetime';
import { createDraftWriter, loadDraft, removeDraft, type DraftKey } from '@/lib/drafts';
import { classifyError, effectOf, isUnknownOutcome, messageFor, unknownOutcomeMessage, type NameLookup } from '@/lib/errors';
import { useGuardedRouter } from '@/lib/navigation/guarded-router';
import { queryKeys } from '@/lib/query';
import { NOTE_MAX } from '@/lib/schemas/common';
import { parseGroupParam, requestFormSchema } from '@/lib/schemas/requests';
import { RequestFields } from './request-fields';
import { useNow } from './use-now';

/** 下書き（団体ごと。1.4） */
interface RequestDraft {
  edits: Record<string, number>;
  note: string | null;
}

/**
 * 申請 /request（団体代表。スマホ。画面の設計 3.5。T11）。
 * 提出は毎回、送る前に自団体の申請と提出の記録を読み直して決める（設計 2.6 の (A)。decideGroupSave）：DB がすでに入力と同じなら
 * 送らずに「提出されていました」、ほかの人の変更があれば上書きしてよいか確かめ、ほかは送る。応答が届かず提出できたか分からない
 * ときは入力を残して知らせるだけで、確かめるための状態は持たない（もう一度押すと、上の読み直しで決まる）。
 * 団体は `?group=<id>`（自分が代表する団体にない id は無視して最初の団体）。団体・年度を変えると作り直す（入力は団体ごとの下書きに残る）。
 */
export function RequestScreen() {
  const { membership, session } = useAuth();
  const params = useSearchParams();
  const m = membership.status === 'ready' ? membership.membership : null;
  const groups = m?.groups ?? [];
  const wanted = parseGroupParam(params.get('group'));
  const group = groups.find((g) => g.id === wanted) ?? groups[0] ?? null;
  const yearId = m?.year?.id ?? null;
  const userId = session.status === 'signedIn' ? session.session.user.id : null;

  if (!m || !yearId || !userId) return <LoadingState />;
  if (!group) {
    return (
      <>
        <PageHeader title="申請" />
        <EmptyState title="代表している団体がありません" description="団体の代表として招待されると、ここで申請できます。" />
      </>
    );
  }
  return <RequestEditor key={`${yearId}:${group.id}`} yearId={yearId} group={group} groups={groups} userId={userId} />;
}

function windowNotice(win: RequestWindow, year: YearRow, outside: boolean): string | null {
  if (outside) return '締切を過ぎました（または受付の前です）。端末の時計がずれている可能性があります。変更は総務へ';
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

function RequestEditor({ yearId, group, groups, userId }: { yearId: string; group: GroupSummary; groups: GroupSummary[]; userId: string }) {
  const queryClient = useQueryClient();
  const { reloadMembership } = useAuth();
  const onAuthError = useAuthErrorHandler();
  const router = useGuardedRouter();
  const notLatest = useNotLatestYearConfirm({ verb: '提出' });
  const yearQ = useYearRow(yearId);
  const q = useRepRequest(yearId, group.id);
  const now = useNow();

  const [edits, setEdits] = useState<Record<string, number>>({});
  const [noteEdit, setNoteEdit] = useState<string | null>(null);
  const [outside, setOutside] = useState<OutsideFlag | null>(null);
  const [confirmOpen, setConfirmOpen] = useState(false);
  /** 送る前の読み直しで見つかった、ほかの人の変更（上書きしてよいか確かめる。2.6） */
  const [overwrite, setOverwrite] = useState<{ submittedAt: string | null; items: string[] } | null>(null);
  const [submitError, setSubmitError] = useState<string | null>(null);

  const draftKeyValue: DraftKey = useMemo(() => ({ userId, yearId, screen: 'request', target: group.id }), [userId, yearId, group.id]);
  const writer = useMemo(() => createDraftWriter<RequestDraft>(draftKeyValue), [draftKeyValue]);
  const [draft, setDraft] = useState(() => loadDraft<RequestDraft>(draftKeyValue));
  useEffect(() => () => writer.flush(), [writer]);

  const data = q.data;
  const model = useMemo(() => (data ? buildRequestForm(data.items, data.group.category, data.requests) : null), [data]);
  const savedNote = data?.submission?.note ?? '';
  const note = noteEdit ?? savedNote;
  const dirty = !!model && (hasCountChanges(model.fields, edits) || (noteEdit !== null && noteEdit !== savedNote));

  const names: NameLookup = useMemo(
    () => ({
      item: (id) => data?.items.find((i) => i.id === id)?.name,
      group: (id) => (id === group.id ? group.name : undefined),
    }),
    [data, group],
  );

  const submit = useMutation({
    mutationFn: (vars: { rows: { itemId: string; count: number }[]; note: string | null }) => submitRequests(group.id, vars.rows, vars.note),
  });

  const writeDraft = (nextEdits: Record<string, number>, nextNote: string | null) => writer.write({ edits: nextEdits, note: nextNote });

  if (yearQ.isError || q.isError) {
    const err = yearQ.error ?? q.error;
    return (
      <>
        <PageHeader title="申請" />
        <ErrorState
          message={messageFor(classifyError(err))}
          onRetry={() => {
            void yearQ.refetch();
            void q.refetch();
          }}
        />
      </>
    );
  }
  const year = yearQ.data;
  if (!year || !data || !model) {
    return (
      <>
        <PageHeader title="申請" />
        <LoadingState />
      </>
    );
  }

  const win = requestWindowOf(year, now);
  const flagged = isOutsideFlagActive(outside, year);
  const writable = win === 'open' && !flagged;
  const notice = windowNotice(win, year, flagged);
  const submittedAt = data.submission?.submitted_at ?? null;
  const left = remainingText(year.request_close_at, now);
  const summary = nonZeroSummary(model.fields, edits);
  const noteTooLong = note.length > NOTE_MAX;

  const handleError = async (e: unknown) => {
    const c = classifyError(e);
    if ((await onAuthError(e)) !== 'other') return;
    let reloaded: YearRow | null = null;
    const effect = effectOf(c);
    if (effect.reload === 'year') {
      reloaded = (await yearQ.refetch()).data ?? null;
      if (c.kind === 'forbidden') reloadMembership();
    }
    if (judgeSubmitFailure(e, reloaded).outside && reloaded) setOutside(outsideFlagOf(reloaded));
    const msg = messageFor(c, { rpc: 'submit_requests', reloadedStatus: reloaded?.status, names, groupId: group.id });
    setSubmitError(msg);
    toast.error(msg);
    if (effect.reload === 'data') void q.refetch();
  };

  const queryKey = queryKeys.yearPart(yearId, 'request', group.id);

  /** 入力の元（読み込んだ申請と提出の記録）を読み直したものにする。入れていない欄は読み直した値になり、入れた数と書き換えた備考は残る */
  const rebaseTo = (fresh: GroupRequestState) => {
    setNoteEdit((n) => (n === savedNote ? null : n));
    queryClient.setQueryData<RepRequestData>(queryKey, (old) => (old ? { ...old, requests: fresh.requests, submission: fresh.submission } : old));
  };

  const done = (message: string) => {
    toast.success(message);
    writer.clear();
    setDraft(null);
    setEdits({});
    setNoteEdit(null);
    void queryClient.invalidateQueries({ queryKey });
  };

  /**
   * 提出。送る前に申請と提出の記録を読み直して決める。'changed' はほかの人の変更があって送らなかった（上書きの確かめを出した）。
   */
  const submitNow = async (): Promise<'done' | 'changed' | 'error'> => {
    setSubmitError(null);
    const rows = toSubmitRows(model.fields, edits);
    const parsed = requestFormSchema.safeParse({ counts: Object.fromEntries(rows.map((r) => [r.itemId, r.count])), note });
    if (!parsed.success) {
      setSubmitError(parsed.error.issues[0]?.message ?? '入力の形が違います');
      return 'error';
    }
    let fresh: GroupRequestState;
    try {
      fresh = await fetchGroupRequestState(group.id);
    } catch (e) {
      if (isUnknownOutcome(e)) setSubmitError(unknownOutcomeMessage('提出'));
      else await handleError(e);
      return 'error';
    }
    const base: GroupRequestState = { requests: data.requests, submission: data.submission };
    const decision = decideGroupSave(base, fresh, { counts: parsed.data.counts, note: parsed.data.note }, userId);
    if (decision === 'saved') {
      done('提出されていました');
      return 'done';
    }
    rebaseTo(fresh);
    if (decision === 'conflict') {
      const changed = stateChangesSince(base, fresh);
      const name = (id: string) => data.items.find((i) => i.id === id)?.name ?? '（不明な品目）';
      setOverwrite({
        submittedAt: changed.submission ? (fresh.submission?.submitted_at ?? null) : null,
        items: changed.items.map((c) => `${name(c.itemId)}（${c.from} → ${c.to}）`),
      });
      return 'changed';
    }
    try {
      const res = await submit.mutateAsync({ rows, note: parsed.data.note });
      done(`提出しました（${formatShortDateTime(res.submitted_at)}）`);
      return 'done';
    } catch (e) {
      // 応答が届かなかった：自動では送り直さない。入力を残し、もう一度押すと読み直して決める
      if (isUnknownOutcome(e)) setSubmitError(unknownOutcomeMessage('提出'));
      else await handleError(e);
      return 'error';
    }
  };

  const onSubmitClick = async () => {
    if (!writable || noteTooLong || submit.isPending) return;
    if (!(await notLatest.confirmBeforeWrite())) return;
    setConfirmOpen(true);
  };

  return (
    <div className="mx-auto max-w-xl pb-24">
      <LatestYearSwitch />
      <PageHeader title="申請" />
      {groups.length > 1 ? (
        <label className="mb-3 flex items-center gap-2 text-sm">
          <span className="shrink-0">団体</span>
          <select
            className="h-9 min-w-0 flex-1 rounded-md border bg-background px-2"
            value={group.id}
            onChange={(e) => void router.push(`/request?group=${e.target.value}`)}
          >
            {groups.map((g) => (
              <option key={g.id} value={g.id}>
                {g.name}
              </option>
            ))}
          </select>
        </label>
      ) : null}
      <GroupSummaryCard data={data} year={year} left={left} submittedAt={submittedAt} />
      {notice ? <ReadOnlyNotice className="mb-3">{notice}</ReadOnlyNotice> : null}
      {draft && writable ? (
        <DraftNotice
          className="mb-3"
          savedAt={draft.savedAt}
          onRestore={() => {
            setEdits(draft.value.edits ?? {});
            setNoteEdit(draft.value.note ?? null);
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
        <p role="alert" data-testid="submit-error" className="mb-3 rounded-md border border-destructive/40 bg-destructive/5 px-3 py-2 text-sm text-destructive">
          {submitError}
        </p>
      ) : null}
      <UnsavedChangesGuard when={dirty && writable} />
      <RequestFields
        idPrefix="request"
        fields={model.fields}
        extras={model.extras}
        edits={edits}
        onCountChange={(itemId, v) => {
          const next = { ...edits, [itemId]: v };
          setEdits(next);
          writeDraft(next, noteEdit);
        }}
        note={note}
        onNoteChange={(v) => {
          setNoteEdit(v);
          writeDraft(edits, v);
        }}
        disabled={!writable || submit.isPending}
      />
      {writable ? (
        <div className="sticky bottom-0 -mx-4 mt-4 border-t bg-background px-4 py-3 md:mx-0 md:rounded-b-lg">
          <Button
            className="w-full"
            size="lg"
            disabled={submit.isPending || noteTooLong}
            aria-busy={submit.isPending || undefined}
            onClick={() => void onSubmitClick()}
          >
            {submit.isPending ? '送信中…' : submittedAt ? '修正して再提出' : '提出'}
          </Button>
        </div>
      ) : null}
      <ConfirmDialog
        open={confirmOpen}
        onOpenChange={setConfirmOpen}
        title={submittedAt ? '修正した申請を提出しますか' : '申請を提出しますか'}
        description={summary.length === 0 ? 'すべて 0 です。何も借りない申請として提出しますか。' : '次の数で提出します。'}
        confirmLabel="提出する"
        pendingLabel="送信中…"
        pending={submit.isPending}
        onConfirm={async () => {
          await submitNow();
        }}
      >
        {summary.length > 0 ? (
          <ul className="max-h-60 space-y-1 overflow-auto text-sm" data-testid="submit-summary">
            {summary.map((r) => (
              <li key={r.name} className="flex justify-between gap-4">
                <span>{r.name}</span>
                <span className="tabular-nums">{r.count}</span>
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
        title={
          overwrite?.submittedAt
            ? `${formatShortDateTime(overwrite.submittedAt)} にほかの人が提出しています。上書きしますか`
            : 'ほかの人がこの団体の申請を変えました。上書きしますか'
        }
        description="画面は読み直した値にしました（入れた数と書き換えた備考は残しています）。上書きすると、画面の数と備考で置き換わります。"
        confirmLabel="上書きして提出する"
        cancelLabel="提出しないで見直す"
        pendingLabel="送信中…"
        pending={submit.isPending}
        onConfirm={async () => {
          // もう一度読み直してから送る。その間にまた変わっていれば、送らずに最新の値で確かめ直す（ダイアログは開いたまま）
          if ((await submitNow()) === 'changed') throw new Error('changed_again');
        }}
      >
        {overwrite && overwrite.items.length > 0 ? (
          <ul className="max-h-60 space-y-1 overflow-auto text-sm" data-testid="request-conflicts">
            {overwrite.items.map((t) => (
              <li key={t}>{t}</li>
            ))}
          </ul>
        ) : null}
      </ConfirmDialog>
      {notLatest.dialog}
    </div>
  );
}

function GroupSummaryCard({
  data,
  year,
  left,
  submittedAt,
}: {
  data: RepRequestData;
  year: YearRow;
  left: string | null;
  submittedAt: string | null;
}) {
  return (
    <dl className="mb-3 grid grid-cols-[auto_1fr] gap-x-3 gap-y-1 rounded-lg border p-3 text-sm" data-testid="request-summary">
      <dt className="text-muted-foreground">団体</dt>
      <dd className="font-medium" data-testid="request-group-name">
        {data.group.name}
      </dd>
      <dt className="text-muted-foreground">使用場所</dt>
      <dd>{data.locationName ?? '校内に分散'}</dd>
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
      <dt className="text-muted-foreground">提出</dt>
      <dd data-testid="request-submitted">{submittedAt ? `提出済み（${formatShortDateTime(submittedAt)}）` : '未提出'}</dd>
    </dl>
  );
}
