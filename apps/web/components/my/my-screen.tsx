'use client';

// 自団体の振り分け /my（画面の設計 3.11、04「自団体の振り分け」、D-39 の Q4。T13）。団体代表。スマホ。
// - 確定前（準備中〜振り分け中）：「振り分け作業中」と、自団体の申請の内容（品目と数・提出日時・備考）、交換の依頼と回答。
//   回答（了承する・了承しない）は set_consent。答えた後は答えと日時を出し、確定までは「回答を変える」を出す（Q4）。
//   依頼の後に置き換えが増えていて記録できない（conflict）ときは「総務が依頼し直すのを待ってください」。
// - 確定後（確定・終了）：品目ごとの数と運び元。代替は「机(木)の代わりにキャスター机」、残すは「使用場所にあるものを使う（残す）」。
// - 振り分けの行は確定後にしか RLS で返らないので、確定前は読みに行かない（lib/data/my.ts）。
// - 複数の団体の代表なら `?group=<id>` で切り替える（合わない値は最初の団体）。
import { useQueryClient } from '@tanstack/react-query';
import { useSearchParams } from 'next/navigation';
import { useMemo, useState } from 'react';
import { toast } from 'sonner';
import { z } from 'zod';
import { AppLink } from '@/components/common/app-link';
import { ErrorBanner } from '@/components/common/error-banner';
import { LatestYearSwitch, useNotLatestYearConfirm } from '@/components/common/latest-year';
import { PageHeader } from '@/components/common/page-header';
import { TokyoTime } from '@/components/common/tokyo-time';
import { EmptyState, ErrorState, ForbiddenState, LoadingState } from '@/components/states';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Label } from '@/components/ui/label';
import { Textarea } from '@/components/ui/textarea';
import { useAuth } from '@/lib/auth/auth-provider';
import {
  allocationLineText,
  answerConsent,
  consentRequestText,
  myAllocationLines,
  myConsents,
  myRequestLines,
  pickMyGroup,
  useMyData,
  type MyConsent,
  type MyData,
} from '@/lib/data/my';
import { isAllocationFinal } from '@/lib/data/year';
import { classifyError, effectOf, messageFor } from '@/lib/errors';
import { useGuardedRouter } from '@/lib/navigation/guarded-router';
import { queryKeys } from '@/lib/query';
import { NOTE_MAX } from '@/lib/schemas/common';

const groupParam = z.uuid().optional().catch(undefined);
export const WAIT_REASK = '依頼の後に置き換えの台数が増えたので、今は回答を記録できません。総務が依頼し直すのを待ってください';

export function MyScreen() {
  const { membership } = useAuth();
  const params = useSearchParams();
  const router = useGuardedRouter();
  const m = membership.status === 'ready' ? membership.membership : null;
  if (!m?.year) return <LoadingState />;
  const group = pickMyGroup(m.groups, groupParam.parse(params.get('group') ?? undefined));
  if (!group) return <ForbiddenState description="この年度で店長・副店長を務める団体がありません。" />;
  const groupSwitch =
    m.groups.length > 1 ? (
      <div className="mb-4 flex items-center gap-2">
        <Label htmlFor="my-group">団体</Label>
        <select
          id="my-group"
          data-testid="my-group-select"
          className="h-10 min-w-0 flex-1 rounded-md border bg-background px-2 text-base sm:max-w-xs"
          value={group.id}
          onChange={(e) => void router.forceReplace(`/my?group=${encodeURIComponent(e.target.value)}`)}
        >
          {m.groups.map((g) => (
            <option key={g.id} value={g.id}>
              {g.name}
            </option>
          ))}
        </select>
      </div>
    ) : null;
  return <MyBody key={`${m.year.id}:${group.id}`} yearId={m.year.id} groupId={group.id} groupSwitch={groupSwitch} />;
}

function MyBody({ yearId, groupId, groupSwitch }: { yearId: string; groupId: string; groupSwitch: React.ReactNode }) {
  const q = useMyData(yearId, groupId);
  if (q.isPending) {
    return (
      <>
        <PageHeader title="自団体の振り分け" />
        <LatestYearSwitch />
        {groupSwitch}
        <LoadingState />
      </>
    );
  }
  if (q.isError || !q.data) {
    return (
      <>
        <PageHeader title="自団体の振り分け" />
        <LatestYearSwitch />
        {groupSwitch}
        <ErrorState message={messageFor(classifyError(q.error))} onRetry={() => void q.refetch()} />
      </>
    );
  }
  return <MyLoaded data={q.data} refetch={() => q.refetch()} fetching={q.isFetching} groupSwitch={groupSwitch} />;
}

function MyLoaded({
  data,
  refetch,
  fetching,
  groupSwitch,
}: {
  data: MyData;
  refetch: () => Promise<unknown>;
  fetching: boolean;
  groupSwitch: React.ReactNode;
}) {
  const final = isAllocationFinal(data.year.status);
  return (
    <div className="mx-auto max-w-2xl" data-testid="my-screen" data-final={final ? 'true' : 'false'}>
      <PageHeader
        title="自団体の振り分け"
        description={
          <span data-testid="my-group">
            {data.group.name}
            {data.group.display_name ? `（${data.group.display_name}）` : ''}
          </span>
        }
        loadedAt={data.loadedAt}
        onReload={() => void refetch()}
        reloading={fetching}
      />
      {/* 最新でない年度を開いているときの「最新の年度に切り替える」（設計 1.3.1。最新の年度・最新が終了なら何も出さない） */}
      <LatestYearSwitch />
      {groupSwitch}
      {final ? <FinalSection data={data} /> : <BeforeConfirmSection data={data} refetch={refetch} />}
    </div>
  );
}

// ---- 確定後 ----

function FinalSection({ data }: { data: MyData }) {
  const lines = useMemo(() => myAllocationLines(data), [data]);
  return (
    <section aria-labelledby="my-final-title" className="space-y-3">
      <h2 id="my-final-title" className="text-lg font-semibold">
        振り分け（確定）
      </h2>
      <p className="text-sm text-muted-foreground">品目ごとの数と、どこから運ぶか（運び元）です。</p>
      {lines.length === 0 ? (
        <EmptyState title="振り分けはありません" description="申請がないか、振り分けの対象になっていません。" />
      ) : (
        <ul className="space-y-2" data-testid="my-allocations">
          {lines.map((l) => (
            <li key={l.key} className="rounded-md border p-3" data-testid="my-allocation-line" data-item={l.itemName}>
              <p className="font-medium">{allocationLineText(l)}</p>
            </li>
          ))}
        </ul>
      )}
    </section>
  );
}

// ---- 確定前 ----

function BeforeConfirmSection({ data, refetch }: { data: MyData; refetch: () => Promise<unknown> }) {
  const lines = useMemo(() => myRequestLines(data), [data]);
  const consents = useMemo(() => myConsents(data), [data]);
  const submittedAt = data.submission?.submitted_at ?? null;
  return (
    <div className="space-y-6">
      <div role="status" className="rounded-md border border-sky-300 bg-sky-50 px-3 py-2 text-sm" data-testid="my-in-progress">
        <p className="font-medium">振り分け作業中</p>
        <p className="text-muted-foreground">確定したら、ここに品目ごとの数と運び元が出ます。</p>
      </div>

      {consents.length > 0 ? (
        <section aria-labelledby="my-consent-title" className="space-y-3">
          <h2 id="my-consent-title" className="text-lg font-semibold">
            交換の依頼
          </h2>
          {consents.map((c) => (
            <ConsentCard key={`${c.fromItemId}|${c.toItemId}`} consent={c} data={data} refetch={refetch} />
          ))}
        </section>
      ) : null}

      <section aria-labelledby="my-request-title" className="space-y-2">
        <h2 id="my-request-title" className="text-lg font-semibold">
          申請の内容
        </h2>
        <p className="text-sm" data-testid="my-submitted">
          {submittedAt ? (
            <>
              提出日時：<TokyoTime value={submittedAt} />
            </>
          ) : (
            <>まだ提出していません。</>
          )}
        </p>
        {lines.length === 0 ? (
          <EmptyState
            title="申請している品目はありません"
            action={
              <AppLink href={`/request?group=${data.group.id}`} className="underline underline-offset-2">
                申請の画面へ
              </AppLink>
            }
          />
        ) : (
          <ul className="divide-y rounded-md border" data-testid="my-requests">
            {lines.map((l) => (
              <li key={l.itemId} className="flex items-center justify-between px-3 py-2">
                <span>{l.itemName}</span>
                <span className="tabular-nums">{l.count}</span>
              </li>
            ))}
          </ul>
        )}
        {data.submission?.note ? (
          <p className="whitespace-pre-wrap text-sm">
            <span className="text-muted-foreground">備考：</span>
            {data.submission.note}
          </p>
        ) : null}
      </section>
    </div>
  );
}

const ANSWER_LABELS = { accepted: '了承する', declined: '了承しない' } as const;

/** 交換の依頼1件（依頼の台数・回答のボタン・回答の後の表示と「回答を変える」） */
export function ConsentCard({ consent: c, data, refetch }: { consent: MyConsent; data: MyData; refetch: () => Promise<unknown> }) {
  const queryClient = useQueryClient();
  const { reloadMembership } = useAuth();
  // 回答の前の確かめは「最新でない年度（…）に回答します」（設計 3.11。T13-15）
  const notLatest = useNotLatestYearConfirm({ verb: '回答' });
  const allocating = data.year.status === 'allocating';
  const [changing, setChanging] = useState(false);
  const [note, setNote] = useState('');
  const [pending, setPending] = useState<'accepted' | 'declined' | null>(null);
  const [error, setError] = useState<unknown>(null);
  const [waitReask, setWaitReask] = useState(false);
  const answered = c.status === 'accepted' || c.status === 'declined';
  const showForm = allocating && (!answered || changing);
  const noteTooLong = note.length > NOTE_MAX;

  const answer = async (status: 'accepted' | 'declined') => {
    if (pending || noteTooLong) return;
    if (!(await notLatest.confirmBeforeWrite())) return;
    setPending(status);
    setError(null);
    setWaitReask(false);
    try {
      await answerConsent({ groupId: data.group.id, fromItemId: c.fromItemId, toItemId: c.toItemId, status, note });
      toast.success(status === 'accepted' ? '了承を記録しました' : '了承しないと記録しました');
      setChanging(false);
      setNote('');
      await refetch();
    } catch (e) {
      const ce = classifyError(e);
      if (ce.kind === 'conflict') {
        setWaitReask(true);
      } else {
        setError(e);
      }
      if (effectOf(ce).reload === 'year') {
        await queryClient.invalidateQueries({ queryKey: queryKeys.year(data.year.id) });
        reloadMembership();
      } else {
        await refetch();
      }
    } finally {
      setPending(null);
    }
  };

  return (
    <article className="space-y-3 rounded-md border p-3" data-testid="my-consent" data-status={c.status}>
      <p className="font-medium" data-testid="my-consent-text">
        {consentRequestText(c)}
      </p>
      {answered ? (
        <p className="text-sm" data-testid="my-consent-answer">
          <Badge variant={c.status === 'accepted' ? 'default' : 'secondary'} className="mr-2">
            {c.status === 'accepted' ? '了承しました' : '了承しないと答えました'}
          </Badge>
          <TokyoTime value={c.updatedAt} />
        </p>
      ) : null}
      {c.note ? (
        <p className="whitespace-pre-wrap text-sm">
          <span className="text-muted-foreground">コメント：</span>
          {c.note}
        </p>
      ) : null}
      {waitReask ? (
        <p role="alert" className="rounded-md border border-amber-300 bg-amber-50 px-3 py-2 text-sm" data-testid="my-consent-wait">
          {WAIT_REASK}
        </p>
      ) : null}
      {error ? <ErrorBanner error={error} context={{ rpc: 'set_consent' }} /> : null}
      {showForm ? (
        <div className="space-y-2">
          <div className="space-y-1">
            <Label htmlFor={`consent-note-${c.fromItemId}-${c.toItemId}`}>コメント（任意）</Label>
            <Textarea
              id={`consent-note-${c.fromItemId}-${c.toItemId}`}
              value={note}
              onChange={(e) => setNote(e.target.value)}
              rows={2}
              aria-invalid={noteTooLong || undefined}
              disabled={pending !== null}
            />
            {noteTooLong ? <p className="text-sm text-destructive">コメントは {NOTE_MAX} 字までです</p> : null}
          </div>
          <div className="flex flex-wrap gap-2">
            {(['accepted', 'declined'] as const).map((s) => (
              <Button
                key={s}
                className="min-h-11 flex-1"
                variant={s === 'accepted' ? 'default' : 'outline'}
                disabled={pending !== null || noteTooLong}
                onClick={() => void answer(s)}
              >
                {pending === s ? '送信中…' : ANSWER_LABELS[s]}
              </Button>
            ))}
            {changing ? (
              <Button variant="ghost" className="min-h-11" disabled={pending !== null} onClick={() => setChanging(false)}>
                やめる
              </Button>
            ) : null}
          </div>
        </div>
      ) : null}
      {allocating && answered && !changing ? (
        <Button variant="outline" className="min-h-11" onClick={() => setChanging(true)}>
          回答を変える
        </Button>
      ) : null}
      {allocating && answered ? (
        <p className="text-xs text-muted-foreground">確定までは回答を変えられます。</p>
      ) : null}
      {notLatest.dialog}
    </article>
  );
}
