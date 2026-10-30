'use client';

// 団体代表・閲覧のみのホーム（画面の設計 3.1「rep・viewer：ホーム」。T09）。スマホでも使う。
import { useQuery } from '@tanstack/react-query';
import { useState } from 'react';
import { CalendarClock, CheckCircle2, CircleDashed, Repeat } from 'lucide-react';
import { AppLink } from '@/components/common/app-link';
import { TokyoTime } from '@/components/common/tokyo-time';
import { ErrorState } from '@/components/states';
import { Button } from '@/components/ui/button';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import { Skeleton } from '@/components/ui/skeleton';
import type { GroupSummary, YearStatus } from '@/lib/auth/membership';
import type { YearRow } from '@/lib/db/types';
import { loadRepHome, repGroupCards, requestWindowOpen, type RepGroupCard } from '@/lib/data/dashboard';
import { isAllocationFinal, useYearRow } from '@/lib/data/year';
import { classifyError, messageFor } from '@/lib/errors';
import { queryKeys } from '@/lib/query';

/** 団体代表のカード（代表する団体ごと） */
export function RepHome({ yearId, groups }: { yearId: string; groups: readonly GroupSummary[] }) {
  const year = useYearRow(yearId);
  // 受付中かは開いた時刻で決める（描画のたびに時計を読まない。締切を過ぎたら読み直しで変わる）
  const [now] = useState(() => Date.now());
  const ids = groups.map((g) => g.id);
  const q = useQuery({
    queryKey: queryKeys.yearPart(yearId, 'home', 'rep', ...ids),
    queryFn: () => loadRepHome(ids),
  });

  if (q.isError || year.isError) {
    return (
      <ErrorState
        message={messageFor(classifyError(q.error ?? year.error))}
        onRetry={() => {
          void q.refetch();
          void year.refetch();
        }}
      />
    );
  }
  if (q.isPending || year.isPending) {
    return (
      <div className="grid gap-4 md:grid-cols-2" data-testid="rep-home-loading">
        {groups.map((g) => (
          <Skeleton key={g.id} className="h-40 w-full" />
        ))}
      </div>
    );
  }
  const cards = repGroupCards({ groups, ...q.data }, year.data.status);
  return (
    <section aria-label="代表する団体" className="grid gap-4 md:grid-cols-2" data-testid="rep-home">
      {cards.map((c) => (
        <RepCard key={c.groupId} card={c} year={year.data} now={now} />
      ))}
    </section>
  );
}

function RepCard({ card: c, year, now }: { card: RepGroupCard; year: YearRow; now: number }) {
  const open = requestWindowOpen(year, now);
  const closeAt = year.request_close_at;
  return (
    <Card data-testid="rep-card" data-group={c.name}>
      <CardHeader>
        <CardTitle className="text-lg">{c.name}</CardTitle>
      </CardHeader>
      <CardContent className="space-y-3 text-sm">
        <dl className="grid grid-cols-[auto_1fr] gap-x-3 gap-y-1">
          <dt className="text-muted-foreground">申請</dt>
          <dd data-testid="rep-submission">
            {c.submittedAt ? (
              <span className="inline-flex items-center gap-1 text-emerald-800">
                <CheckCircle2 aria-hidden className="size-4" />
                <span>
                  提出済み（<TokyoTime value={c.submittedAt} format="short" />）
                </span>
              </span>
            ) : (
              <span className="inline-flex items-center gap-1 text-amber-800">
                <CircleDashed aria-hidden className="size-4" />
                未提出
              </span>
            )}
          </dd>
          <dt className="text-muted-foreground">締切</dt>
          <dd>
            <span className="inline-flex items-center gap-1">
              <CalendarClock aria-hidden className="size-4 text-muted-foreground" />
              <TokyoTime value={closeAt} empty="未定" />
            </span>
          </dd>
        </dl>
        {c.final ? (
          <div className="space-y-2 rounded-md border border-emerald-300 bg-emerald-50 p-3" data-testid="rep-final">
            <p className="font-medium text-emerald-900">振り分けが決まりました</p>
            <Button asChild size="sm">
              <AppLink href={`/my?group=${c.groupId}`}>自団体の振り分けを見る</AppLink>
            </Button>
          </div>
        ) : null}
        {!c.final && c.consentAsked ? (
          <div className="space-y-2 rounded-md border border-amber-300 bg-amber-50 p-3" data-testid="rep-consent-asked">
            <p className="inline-flex items-center gap-1 font-medium text-amber-950">
              <Repeat aria-hidden className="size-4" />
              キャスター机への交換の依頼があります
            </p>
            <Button asChild size="sm">
              <AppLink href={`/my?group=${c.groupId}`}>依頼に答える</AppLink>
            </Button>
          </div>
        ) : null}
        <Button asChild variant={open ? 'default' : 'outline'} size="sm">
          <AppLink href={`/request?group=${c.groupId}`}>{open ? (c.submittedAt ? '申請を直す' : '申請する') : '申請を見る'}</AppLink>
        </Button>
      </CardContent>
    </Card>
  );
}

/** 閲覧のみのホーム（Q1：確定・終了なら振り分け表へ） */
export function ViewerHome({ status }: { status: YearStatus }) {
  return (
    <Card data-testid="viewer-home">
      <CardHeader>
        <CardTitle className="text-lg">振り分け表</CardTitle>
      </CardHeader>
      <CardContent className="text-sm">
        {isAllocationFinal(status) ? (
          <Button asChild>
            <AppLink href="/allocation">振り分け表を見る</AppLink>
          </Button>
        ) : (
          <p className="text-muted-foreground">振り分けが確定すると、ここから見られます。</p>
        )}
      </CardContent>
    </Card>
  );
}
