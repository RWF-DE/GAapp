'use client';

// 自分のシフト（/shift。スマホ。04「自分のシフト」、notes/T20.md「画面の約束」5。T20・D-56）。
// - 読む（2本を並行）：開いている年度の自分の割り当て（時間枠・持ち場・同じますの人を埋め込む）と表示名。どちらも先読み・記録・先送りの
//   対象（lib/data/screen-queries.ts の planShiftPrefetch。4G で 2 秒以内に開くため）。最終読み込みと「読み直す」。
// - 日ごと（今日 → これからの日 → 終わった日〔畳む〕）。今の枠に「今」、これからの最初の枠に「次」の印。`?day=` はその日を見える所に送る。
// - 書き込みはない（終了した年度の帯も出さない）。シフト表の組み立て・編集の部品（board.ts・shift-write.ts・ダイアログ）を読まない
//   （部門員がスマホで開く画面の最初に読む JS を軽くする）。
import { useQuery } from '@tanstack/react-query';
import { ChevronDown, ChevronRight, MapPin, Users } from 'lucide-react';
import { useSearchParams } from 'next/navigation';
import { useEffect, useMemo, useRef, useState } from 'react';
import { AppLink } from '@/components/common/app-link';
import { ErrorBanner } from '@/components/common/error-banner';
import { PageHeader } from '@/components/common/page-header';
import { EmptyState, QueryState } from '@/components/states';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { useAuth } from '@/lib/auth/auth-provider';
import { buildMyShiftDays, type MyShiftDay } from '@/lib/modules/shifts/my-shift';
import { NAME_UNKNOWN, nameMapOf } from '@/lib/modules/shifts/names';
import { myShiftsOptions, soumuNamesOptions } from '@/lib/modules/shifts/reads';
import { cn } from '@/lib/utils';

/** 空の表示（04「自分のシフト」） */
export const MY_SHIFT_TEXTS = {
  empty: 'あなたのシフトはまだありません',
  noUpcoming: 'これからのシフトはありません',
  noMates: 'ほかの人はいません',
} as const;

export function MyShiftScreen() {
  const { membership, session } = useAuth();
  if (membership.status !== 'ready') return null; // AppShell が読み込み中・未招待を出す
  const m = membership.membership;
  if (!m.year) return null;
  const userId = session.status === 'signedIn' ? session.session.user.id : null;
  return <MyShiftBody key={m.year.id} yearId={m.year.id} festivalStart={m.year.festival_start} userId={userId} />;
}

function MyShiftBody({ yearId, festivalStart, userId }: { yearId: string; festivalStart: string; userId: string | null }) {
  const params = useSearchParams();
  const q = useQuery(myShiftsOptions(yearId));
  const namesQ = useQuery(soumuNamesOptions(yearId));
  // 画面を開いた時刻（今・次の印と日の並び）。「読み直す」で押した時刻にする
  const [now, setNow] = useState(() => Date.now());
  const names = useMemo(() => nameMapOf(namesQ.data), [namesQ.data]);
  const reload = () => {
    setNow(Date.now());
    void q.refetch();
    void namesQ.refetch();
  };
  const days = useMemo(() => (q.data ? buildMyShiftDays(q.data, names, userId, now, festivalStart) : []), [q.data, names, userId, now, festivalStart]);
  const dayParam = params.get('day');

  return (
    <div className="mx-auto max-w-2xl space-y-4">
      <PageHeader
        title="自分のシフト"
        loadedAt={q.dataUpdatedAt ? new Date(q.dataUpdatedAt) : null}
        onReload={reload}
        reloading={q.isFetching || namesQ.isFetching}
      />
      {namesQ.isError && !namesQ.data ? <ErrorBanner error={namesQ.error} onRetry={() => void namesQ.refetch()} /> : null}
      <QueryState query={q}>{() => <MyShiftDays days={days} dayParam={dayParam} />}</QueryState>
      <p>
        <AppLink href="/shifts" data-testid="my-shift-board-link" className="text-sm text-primary underline underline-offset-4">
          シフト表を見る
        </AppLink>
      </p>
    </div>
  );
}

function MyShiftDays({ days, dayParam }: { days: readonly MyShiftDay[]; dayParam: string | null }) {
  const upcoming = days.filter((d) => !d.past);
  const past = days.filter((d) => d.past);
  // ?day= が終わった日なら畳みを開く
  const [openPast, setOpenPast] = useState(() => past.some((d) => d.date === dayParam));
  if (days.length === 0) {
    return (
      <div data-testid="my-shift-empty">
        <EmptyState title={MY_SHIFT_TEXTS.empty} />
      </div>
    );
  }
  return (
    <div data-testid="my-shift-list" className="space-y-5">
      {upcoming.length === 0 ? (
        <div data-testid="my-shift-empty" data-past-only="true">
          <EmptyState title={MY_SHIFT_TEXTS.noUpcoming} />
        </div>
      ) : (
        upcoming.map((d) => <MyShiftDaySection key={d.date} day={d} focused={d.date === dayParam} />)
      )}
      {past.length > 0 ? (
        <div className="space-y-4">
          <Button
            variant="outline"
            size="sm"
            data-testid="my-shift-past-toggle"
            aria-expanded={openPast}
            onClick={() => setOpenPast((v) => !v)}
          >
            {openPast ? <ChevronDown aria-hidden /> : <ChevronRight aria-hidden />}
            終わった日（{past.length} 日）
          </Button>
          {openPast ? past.map((d) => <MyShiftDaySection key={d.date} day={d} focused={d.date === dayParam} />) : null}
        </div>
      ) : null}
    </div>
  );
}

function MyShiftDaySection({ day, focused }: { day: MyShiftDay; focused: boolean }) {
  const ref = useRef<HTMLElement>(null);
  // ダッシュボードの締切と予定から来た日（?day=）は見える所に送る
  useEffect(() => {
    if (focused) ref.current?.scrollIntoView?.({ block: 'start' });
  }, [focused]);
  return (
    <section
      ref={ref}
      data-testid="my-shift-day"
      data-day={day.date}
      data-past={day.past ? 'true' : 'false'}
      aria-labelledby={`my-shift-day-${day.date}`}
      className={cn('space-y-2 scroll-mt-20', focused && 'rounded-lg ring-2 ring-amber-300 ring-offset-4')}
    >
      <h2 id={`my-shift-day-${day.date}`} className="flex flex-wrap items-center gap-2 text-base font-semibold">
        {day.heading}
        {day.festival ? <Badge variant="secondary">{day.festival}</Badge> : null}
        {day.relative ? <Badge variant={day.relative === '今日' ? 'default' : 'outline'}>{day.relative}</Badge> : null}
      </h2>
      <ul className="space-y-2">
        {day.items.map((i) => (
          <li
            key={i.slotId}
            data-testid="my-shift-item"
            data-slot-id={i.slotId}
            className={cn(
              'space-y-1 rounded-lg border bg-card p-3 text-card-foreground',
              i.isNow && 'border-emerald-400 bg-emerald-50',
              day.past && 'opacity-80',
            )}
          >
            <div className="flex flex-wrap items-center gap-2">
              <span data-testid="my-shift-time" className="text-lg font-semibold tabular-nums">
                {i.time}
              </span>
              {i.isNow ? (
                <Badge data-testid="my-shift-now" className="bg-emerald-600 text-white">
                  今
                </Badge>
              ) : null}
              {i.isNext ? (
                <Badge data-testid="my-shift-next" variant="outline" className="border-sky-400 text-sky-900">
                  次
                </Badge>
              ) : null}
            </div>
            <p data-testid="my-shift-duty" className="font-medium [overflow-wrap:anywhere]">
              {i.dutyName}
            </p>
            {i.place ? (
              <p data-testid="my-shift-place" className="flex items-start gap-1 text-sm [overflow-wrap:anywhere]">
                <MapPin aria-hidden className="mt-0.5 size-4 shrink-0 text-muted-foreground" />
                <span>
                  <span className="sr-only">場所：</span>
                  {i.place}
                </span>
              </p>
            ) : null}
            {i.note ? (
              <p data-testid="my-shift-note" className="text-sm whitespace-pre-wrap text-muted-foreground [overflow-wrap:anywhere]">
                {i.note}
              </p>
            ) : null}
            <p data-testid="my-shift-mates" className="flex items-start gap-1 text-sm">
              <Users aria-hidden className="mt-0.5 size-4 shrink-0 text-muted-foreground" />
              <span>
                <span className="sr-only">同じ持ち場の人：</span>
                {i.mates.length > 0 ? i.mates.map((p) => p.name ?? NAME_UNKNOWN).join('・') : MY_SHIFT_TEXTS.noMates}
              </span>
            </p>
          </li>
        ))}
      </ul>
    </section>
  );
}
