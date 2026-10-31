'use client';

// 締切と予定（ダッシュボード〔/〕の欄「締切と予定」。04「ダッシュボード」、notes/T16.md「固めた約束」2、notes/T18.md「後半（画面）の約束」
// 2・3。T16・T18）。
// どの立場にも出す。機能が出す日時の決まった項目（机椅子の受付開始・申請の締切・祭の日と、締切と予定の機能〔T18〕の項目のうちその人が
// 読めるもの）から、これからの 30 日のものと過ぎた締切を 8 件まで（upcomingDated。T18 で改めた）。続きは「ほか N 件」。1件は日付
// （曜日つき。datedWhen）・相対の言い方（datedRelative。「締切を過ぎました」は注意の色）・種類・文で、行き先を開けるものだけ行をリンクに
// する。欄の下に「締切と予定の一覧へ」（/calendar）。
// 読み込み中・失敗は、読み取りの結果をこの欄に使う機能（query.widgets に 'dated' がある機能。締切と予定の機能）の分だけ出す
// （「締切と予定：…」と「もう一度」）。机椅子の日付は年度の行だけで決まるので、その間も出たまま。机椅子の読み込み中・失敗はこの欄に
// 出さない（T16 の決定 7。要対応とカードの欄に出す）。
// / の JS を軽くするため、締切と予定の一覧の画面とダイアログ（components/calendar・lib/data/calendar・lib/schemas/calendar・
// lib/modules/calendar/list）を import しない。
import { ChevronRight } from 'lucide-react';
import { AppLink } from '@/components/common/app-link';
import { Badge } from '@/components/ui/badge';
import { EVENT_KIND_LABELS } from '@/lib/modules/calendar/labels';
import { DATED_OVERDUE, datedRelative, datedWhen, upcomingDated, type DatedItem, type PortalContext } from '@/lib/modules/portal';
import { cn } from '@/lib/utils';
import { usePortalWidget } from './use-portal';
import { ModuleError, PortalLoading, YearGateView, type YearGate } from './widget';

/** 欄の下のリンクの行き先（締切と予定の一覧） */
export const CALENDAR_HREF = '/calendar';

/** 締切と予定の欄の中身（枠とエラーの境界は portal-screen.tsx）。now はダッシュボードを開いた時刻 */
export function DatedList({ ctxs, gate, now }: { ctxs: readonly PortalContext[]; gate: YearGate; now: number }) {
  const modules = usePortalWidget(ctxs, 'dated');
  if (gate.status !== 'ready') return <YearGateView gate={gate} />;
  const { items, more } = upcomingDated(
    modules.flatMap((m) => m.dated),
    now,
  );
  const loading = modules.filter((m) => m.loading);
  const failed = modules.filter((m) => m.failure);
  return (
    <div className="space-y-3">
      {failed.map((m) => (
        <ModuleError key={m.moduleId} moduleId={m.moduleId} error={m.failure!.error} onRetry={m.failure!.retry} />
      ))}
      {items.length > 0 ? (
        <ul className="divide-y">
          {items.map((d) => (
            <DatedRow key={d.id} item={d} now={now} />
          ))}
        </ul>
      ) : loading.length === 0 && failed.length === 0 ? (
        <p data-testid="portal-dated-empty" className="text-sm text-muted-foreground">
          これからの締切と予定はありません
        </p>
      ) : null}
      {more > 0 ? (
        <p data-testid="portal-dated-more" className="text-sm text-muted-foreground">
          ほか {more} 件
        </p>
      ) : null}
      {loading.map((m) => (
        <PortalLoading key={m.moduleId} moduleId={m.moduleId} />
      ))}
      {/* 一覧へのリンク（開けるときだけ。招待されている全員が開ける。読み込み中・失敗・空のときも出す） */}
      <p className="text-sm">
        <AppLink href={CALENDAR_HREF} fallback={null} data-testid="portal-dated-link" className="underline underline-offset-2 hover:text-primary">
          締切と予定の一覧へ
        </AppLink>
      </p>
    </div>
  );
}

function DatedRow({ item: d, now }: { item: DatedItem; now: number }) {
  const relative = datedRelative(d, now);
  const body = (
    <>
      <span className="min-w-0 flex-1 space-y-1">
        <span className="flex flex-wrap items-center gap-x-2 gap-y-1">
          <Badge
            variant="outline"
            className={cn(
              'shrink-0',
              d.kind === 'deadline' ? 'border-amber-300 bg-amber-50 text-amber-900' : 'border-transparent bg-muted text-muted-foreground',
            )}
          >
            {EVENT_KIND_LABELS[d.kind]}
          </Badge>
          <time data-testid="portal-dated-when" dateTime={d.at} className="text-sm tabular-nums">
            {datedWhen(d, now)}
          </time>
          {relative ? (
            <span
              data-testid="portal-dated-relative"
              className={cn('text-xs', relative === DATED_OVERDUE ? 'font-medium text-amber-700' : 'text-muted-foreground')}
            >
              {relative}
            </span>
          ) : null}
        </span>
        {/* 文は文節で折り返す（ダッシュボードの外枠の word-break: auto-phrase。長い英数字は anywhere で折る） */}
        <span className="block text-sm [overflow-wrap:anywhere]">{d.title}</span>
      </span>
      {d.href ? <ChevronRight aria-hidden className="mt-0.5 size-4 shrink-0 text-muted-foreground" /> : null}
    </>
  );
  const row = 'flex items-start gap-3 py-2';
  return (
    <li data-testid="portal-dated-item" data-id={d.id} data-kind={d.kind} data-module={d.moduleId}>
      {d.href ? (
        <AppLink href={d.href} className={cn(row, '-mx-2 rounded-md px-2 hover:bg-accent')} fallback={<div className={row}>{body}</div>}>
          {body}
        </AppLink>
      ) : (
        <div className={row}>{body}</div>
      )}
    </li>
  );
}
