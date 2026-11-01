'use client';

// 締切と予定の一覧（/calendar の中身。04「締切と予定」の並び・1件に出すもの・形、notes/T18.md「後半（画面）の約束」6。T18・D-54）。
// Asia/Tokyo の日ごとに、日の見出し（「10月16日（土）」と相対の言い方）の下に1件ずつ。広い PC（lg 以上）は1件1行の grid（列：時刻・印・
// 題名とメモ・操作）、それより狭い幅（スマホと、左のナビの分だけ狭い md）は縦に重ねる（時刻と印 → 題名 → メモ → 操作）。同じ <li> を
// 幅で並べ替え、DOM を2つ作らない（testid と読み上げを重ねない）。
// メモは書いたとおりの文字で出す（改行を残し、長い語も折り返す。テキストとして出し、リンクにしない・HTML として読まない）。
// 機能の日付（机椅子の受付開始など）は読むだけ（編集・削除なし）で、題名を機能が決めた行き先（なければ機能の入口）へのリンクにする
// （開けなければ文字だけ。AppLink）。
import { Fragment, useEffect, useRef } from 'react';
import { AppLink } from '@/components/common/app-link';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import type { CalendarEventRow } from '@/lib/data/calendar';
import { formatDayHeading } from '@/lib/datetime-weekday';
import { EVENT_AUDIENCE_LABELS, EVENT_KIND_LABELS } from '@/lib/modules/calendar/labels';
import { dayRelative, entryRelative, entryTimeLabel, type CalendarDay, type CalendarEntry } from '@/lib/modules/calendar/list';
import { DATED_OVERDUE, moduleLabel, tokyoYearOf } from '@/lib/modules/portal';
import { MODULES } from '@/lib/modules/registry';
import { cn } from '@/lib/utils';

export interface CalendarListProps {
  days: readonly CalendarDay[];
  /** 画面を開いた時刻（ms） */
  now: number;
  /** 対象の印を出すか（総務だけ） */
  showAudience: boolean;
  /** 編集・削除を出すか（部門長以上で、年度が終了していない） */
  canWrite: boolean;
  /** `?event=` の項目の id（目立たせて見える所に送る） */
  highlightId: string | null;
  onEdit: (e: CalendarEventRow) => void;
  onDelete: (e: CalendarEventRow) => void;
}

/** 種類の印の色（締切は注意の色、予定は目立たない色。ダッシュボードの欄と同じ） */
export const KIND_BADGE_CLASS = {
  deadline: 'border-amber-300 bg-amber-50 text-amber-900',
  event: 'border-transparent bg-muted text-muted-foreground',
} as const;

/**
 * 時刻の文（entryTimeLabel）を「〜」の後でだけ折り返す（「09:00〜」と「11/13（金）17:00」のように、日付と時刻の組の途中で割らない。
 * 文字は変えない〔textContent は entryTimeLabel のまま〕。広い PC の時刻の列〔11rem〕で「09:00〜11/13（金）」と「17:00」に割れていた。
 * パート B の撮影で見つけた）
 */
function TimeText({ text }: { text: string }) {
  const parts = text.split('〜');
  return parts.map((part, k) => (
    <Fragment key={k}>
      {k > 0 ? <wbr /> : null}
      <span className="whitespace-nowrap">{k < parts.length - 1 ? `${part}〜` : part}</span>
    </Fragment>
  ));
}

/** 機能の日付の行き先：機能が決めた行き先、なければ機能の入口（開けるかは AppLink が確かめる） */
function moduleHref(entry: CalendarEntry): string | null {
  if (entry.event) return null;
  return entry.item.href ?? MODULES.find((m) => m.id === entry.item.moduleId)?.homeHref ?? null;
}

export function CalendarList({ days, now, showAudience, canWrite, highlightId, onEdit, onDelete }: CalendarListProps) {
  const year = tokyoYearOf(now);
  const cols = canWrite ? 'lg:grid-cols-[11rem_7.5rem_minmax(0,1fr)_8.5rem]' : 'lg:grid-cols-[11rem_7.5rem_minmax(0,1fr)]';
  return (
    <ol data-testid="calendar-days" className="space-y-5">
      {days.map((day) => {
        const relative = dayRelative(day.date, now);
        return (
          <li key={day.date} data-testid="calendar-day" data-date={day.date} className="space-y-2">
            <h2 className="flex flex-wrap items-baseline gap-x-3 gap-y-0.5">
              <span data-testid="calendar-day-heading" className="text-base font-semibold">
                {formatDayHeading(day.date, year)}
              </span>
              <span
                data-testid="calendar-day-relative"
                className={cn('text-sm', relative === '今日' ? 'font-medium text-primary' : 'text-muted-foreground')}
              >
                {relative}
              </span>
            </h2>
            <ul className="divide-y rounded-lg border bg-card">
              {day.entries.map((entry) => (
                <CalendarItem
                  key={entry.item.id}
                  entry={entry}
                  day={day.date}
                  now={now}
                  cols={cols}
                  showAudience={showAudience}
                  canWrite={canWrite}
                  highlighted={!!entry.event && entry.event.id === highlightId}
                  onEdit={onEdit}
                  onDelete={onDelete}
                />
              ))}
            </ul>
          </li>
        );
      })}
    </ol>
  );
}

function CalendarItem({
  entry,
  day,
  now,
  cols,
  showAudience,
  canWrite,
  highlighted,
  onEdit,
  onDelete,
}: {
  entry: CalendarEntry;
  day: string;
  now: number;
  cols: string;
  showAudience: boolean;
  canWrite: boolean;
  highlighted: boolean;
  onEdit: (e: CalendarEventRow) => void;
  onDelete: (e: CalendarEventRow) => void;
}) {
  const ref = useRef<HTMLLIElement>(null);
  // ダッシュボードの欄から来た項目（?event=）は、見える所に送る（目立たせるのは data-highlighted と色）
  useEffect(() => {
    if (highlighted) ref.current?.scrollIntoView?.({ block: 'center' });
  }, [highlighted]);
  const { item, event } = entry;
  const relative = entryRelative(item, day, now);
  const href = moduleHref(entry);
  return (
    <li
      ref={ref}
      data-testid="calendar-item"
      data-id={item.id}
      data-kind={item.kind}
      data-module={item.moduleId}
      data-audience={event?.audience}
      data-highlighted={highlighted ? 'true' : undefined}
      className={cn('grid gap-x-4 gap-y-1.5 px-4 py-3 lg:items-start', cols, highlighted && 'bg-amber-50 ring-2 ring-inset ring-amber-300')}
    >
      {/* 狭い幅では時刻と印を1行に（lg では contents にして、時刻と印がそれぞれ grid の列になる） */}
      <div className="flex flex-wrap items-center gap-x-3 gap-y-1 lg:contents">
        <p className="text-sm tabular-nums">
          <span data-testid="calendar-item-time">
            <TimeText text={entryTimeLabel(item, day, now)} />
          </span>
          {relative ? (
            <span
              data-testid="calendar-item-relative"
              className={cn('ml-2 text-xs lg:ml-0 lg:block', relative === DATED_OVERDUE ? 'font-medium text-amber-700' : 'text-muted-foreground')}
            >
              {relative}
            </span>
          ) : null}
        </p>
        <div className="flex flex-wrap items-center gap-1.5">
          <Badge data-testid="calendar-item-kind" variant="outline" className={KIND_BADGE_CLASS[item.kind]}>
            {EVENT_KIND_LABELS[item.kind]}
          </Badge>
          {event && showAudience ? (
            <Badge data-testid="calendar-item-audience" variant="outline">
              {EVENT_AUDIENCE_LABELS[event.audience]}
            </Badge>
          ) : null}
          {!event ? (
            <Badge data-testid="calendar-item-module" variant="outline" className="text-muted-foreground">
              {moduleLabel(item.moduleId)}
            </Badge>
          ) : null}
        </div>
      </div>
      <div className="min-w-0 space-y-1">
        <h3 data-testid="calendar-item-title" className="font-semibold [overflow-wrap:anywhere]">
          {/* 開けない立場では、AppLink が下線も色もない文字だけを出す（パート B の撮影で見つけ、マージの後の直しで AppLink の既定にした） */}
          {href ? (
            <AppLink href={href} className="underline underline-offset-2 hover:text-primary">
              {item.title}
            </AppLink>
          ) : (
            item.title
          )}
        </h3>
        {event?.note ? (
          <p data-testid="calendar-item-note" className="text-sm whitespace-pre-wrap text-muted-foreground [overflow-wrap:anywhere]">
            {event.note}
          </p>
        ) : null}
      </div>
      {canWrite && event ? (
        <div className="flex flex-wrap gap-2 lg:justify-end">
          <Button data-testid="calendar-item-edit" size="sm" variant="outline" onClick={() => onEdit(event)} aria-label={`「${event.title}」を編集`}>
            編集
          </Button>
          <Button
            data-testid="calendar-item-delete"
            size="sm"
            variant="outline"
            className="text-destructive"
            onClick={() => onDelete(event)}
            aria-label={`「${event.title}」を削除`}
          >
            削除
          </Button>
        </div>
      ) : null}
    </li>
  );
}
