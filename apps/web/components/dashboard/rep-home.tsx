'use client';

// 代表する団体（ダッシュボード〔/〕の欄。04「ダッシュボード」。T09 の団体代表のホームのカードを T16 でダッシュボードの欄にした）。
// スマホでも使う。読むのは自団体の提出と了承だけ（lib/modules/furniture/rep.ts の furnitureRepOptions。机椅子の団体代表の要対応と
// 同じキー〔['year', y, 'portal', 'furniture', 'rep', ...団体の id]〕なので、リクエストは1回）。/ の JS に入るので、lib/data/dashboard.ts
// （swaps.ts の ruleSchema）・スナップショット・検証を import しない。閲覧のみのホームのカードは、ダッシュボードの机椅子のカードにした（T16）。
import { useQuery } from '@tanstack/react-query';
import { useState } from 'react';
import { CalendarClock, CheckCircle2, CircleDashed, Repeat } from 'lucide-react';
import { AppLink } from '@/components/common/app-link';
import { TokyoTime } from '@/components/common/tokyo-time';
import { ErrorState } from '@/components/states';
import { Button } from '@/components/ui/button';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import { Skeleton } from '@/components/ui/skeleton';
import type { GroupSummary } from '@/lib/auth/membership';
import type { YearRow } from '@/lib/db/types';
import { useYearRow } from '@/lib/data/year';
import { classifyError, messageFor } from '@/lib/errors';
import { furnitureRepOptions, repGroupCards, requestWindowOpen, type RepGroupCard } from '@/lib/modules/furniture/rep';

/**
 * 団体代表のカード（代表する団体ごと）。now はダッシュボードを開いた時刻（要対応と同じ時刻で受付中かを決める。なければ
 * この部品を出した時刻）。
 */
export function RepHome({ yearId, groups, now: openedAt }: { yearId: string; groups: readonly GroupSummary[]; now?: number }) {
  const year = useYearRow(yearId);
  // 受付中かは開いた時刻で決める（描画のたびに時計を読まない。締切を過ぎたら読み直しで変わる）
  const [mountedAt] = useState(() => Date.now());
  const now = openedAt ?? mountedAt;
  const q = useQuery(furnitureRepOptions(yearId, groups.map((g) => g.id)));

  // data のない失敗だけを ErrorState にする（読み直しだけの失敗は前の data を出し続ける。ダッシュボードの欄と同じ。T16）
  if ((q.isError && !q.data) || (year.isError && !year.data)) {
    return (
      <ErrorState
        message={messageFor(classifyError(q.isError && !q.data ? q.error : year.error))}
        onRetry={() => {
          void q.refetch();
          void year.refetch();
        }}
      />
    );
  }
  if (!q.data || !year.data) {
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
    <div className="grid gap-4 md:grid-cols-2" data-testid="rep-home">
      {cards.map((c) => (
        <RepCard key={c.groupId} card={c} year={year.data} now={now} />
      ))}
    </div>
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
              {/* 要対応・締切と予定と同じ短い形（「10/5 17:00」） */}
              <TokyoTime value={closeAt} format="short" empty="未定" />
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
