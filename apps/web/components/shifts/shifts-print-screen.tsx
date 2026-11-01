'use client';

// シフト表の印刷（/shifts/print。PC。04「シフト表の印刷」、notes/T20.md「画面の約束」6。T20・D-56）。紙で配るときと、当日に通信が切れた
// ときのため（書き出しは印刷だけ。PDF にも保存できる）。
// - `?day=`（既定はシフト表と同じ決め方）と `?view=table|people`（既定 table。知らない値も table）。画面の上に日と表示の切り替え・「印刷」
//   （window.print）・「シフト表へ戻る」を出す（印刷には出さない。ヘッダーとナビは AppShell が印刷で隠す）。
// - 日ごとの表（table）：A4 横。年度名・日付と、シフト表と同じ表（列はその日にますのある持ち場。足りなければ「あと1人」を文字で）。持ち場は
//   8 ずつに分けて別の表にする（表の途中で改ページしない）。
// - 人ごと（people）：A4 縦。その日に割り当てのある人ごとに1枚のカード（表示名の順。カードの途中で改ページしない）。
// 読むものはシフト表と同じ（表示名つき）。書き込みはない。
import { useQuery } from '@tanstack/react-query';
import { Printer } from 'lucide-react';
import { useSearchParams } from 'next/navigation';
import { useMemo, useState } from 'react';
import { AppLink } from '@/components/common/app-link';
import { ErrorBanner } from '@/components/common/error-banner';
import { PageHeader } from '@/components/common/page-header';
import { EmptyState, QueryState } from '@/components/states';
import { Button } from '@/components/ui/button';
import { useAuth } from '@/lib/auth/auth-provider';
import { useYearRow } from '@/lib/data/year';
import {
  buildShiftTable,
  cellCountText,
  cellDiffText,
  chunk,
  peopleOfDay,
  pickShiftDay,
  shiftDays,
  type ShiftBoard,
  type ShiftDay,
} from '@/lib/modules/shifts/board';
import { NAME_UNKNOWN, nameMapOf } from '@/lib/modules/shifts/names';
import { shiftBoardOptions } from '@/lib/modules/shifts/board-read';
import { soumuNamesOptions } from '@/lib/modules/shifts/reads';
import { shiftDayPrintLabel } from '@/lib/modules/shifts/time';
import { useGuardedRouter } from '@/lib/navigation/guarded-router';
import { selectClass } from './write-notice';

/** 印刷の表の持ち場の数（これを超える日は 8 ずつ別の表にする） */
export const PRINT_COLUMNS = 8;

/** 表示：日ごとの表・人ごと */
export type PrintView = 'table' | 'people';

/** `?view=`（知らない値は table） */
export function parsePrintView(v: string | null): PrintView {
  return v === 'people' ? 'people' : 'table';
}

/** `/shifts/print?day=…&view=…`（table は入れない） */
export function shiftsPrintHref(day: string | null, view: PrintView): string {
  const q = new URLSearchParams();
  if (day) q.set('day', day);
  if (view === 'people') q.set('view', 'people');
  const s = q.toString();
  return s ? `/shifts/print?${s}` : '/shifts/print';
}

export function ShiftsPrintScreen() {
  const { membership } = useAuth();
  if (membership.status !== 'ready') return null; // AppShell が読み込み中・未招待を出す
  const m = membership.membership;
  if (!m.year) return null;
  return <ShiftsPrint key={m.year.id} yearId={m.year.id} yearLabel={m.year.label} festivalStart={m.year.festival_start} />;
}

function ShiftsPrint({ yearId, yearLabel, festivalStart }: { yearId: string; yearLabel: string; festivalStart: string }) {
  const params = useSearchParams();
  const router = useGuardedRouter();
  const yearQ = useYearRow(yearId);
  const boardQ = useQuery(shiftBoardOptions(yearId));
  const namesQ = useQuery(soumuNamesOptions(yearId));
  const [openedAt] = useState(() => Date.now());
  const now = Math.max(openedAt, boardQ.dataUpdatedAt);
  const names = useMemo(() => nameMapOf(namesQ.data), [namesQ.data]);
  const fs = yearQ.data?.festival_start ?? festivalStart;
  const days = useMemo(() => (boardQ.data ? shiftDays(boardQ.data.slots, fs, now) : []), [boardQ.data, fs, now]);
  const day = pickShiftDay(days, params.get('day'), now);
  const view = parsePrintView(params.get('view'));
  const go = (d: string | null, v: PrintView) => router.forceReplace(shiftsPrintHref(d, v));
  const backHref = day ? `/shifts?day=${day}` : '/shifts';

  return (
    <div data-testid="shifts-print" className="mx-auto max-w-7xl space-y-4">
      {/* 印刷の向き：表は A4 横、人ごとは A4 縦（表示の切り替えで入れ替える） */}
      <style>{`@media print { @page { size: A4 ${view === 'table' ? 'landscape' : 'portrait'}; margin: 10mm; } }`}</style>
      <div className="space-y-3 print:hidden">
        <PageHeader
          title="シフト表の印刷"
          loadedAt={boardQ.dataUpdatedAt ? new Date(boardQ.dataUpdatedAt) : null}
          onReload={() => {
            void boardQ.refetch();
            void namesQ.refetch();
          }}
          reloading={boardQ.isFetching || namesQ.isFetching}
          actions={
            <div className="flex flex-wrap gap-2">
              <Button asChild variant="outline">
                <AppLink href={backHref}>シフト表へ戻る</AppLink>
              </Button>
              <Button data-testid="shifts-print-button" onClick={() => window.print()} disabled={!day}>
                <Printer aria-hidden />
                印刷
              </Button>
            </div>
          }
        />
        <div className="flex flex-wrap items-end gap-4">
          <label className="space-y-1 text-sm">
            <span className="block font-medium">日</span>
            <select
              className={`${selectClass} w-48`}
              value={day ?? ''}
              disabled={days.length === 0}
              onChange={(e) => go(e.target.value || null, view)}
              aria-label="印刷する日"
            >
              {days.map((d) => (
                <option key={d.date} value={d.date}>
                  {d.label}
                </option>
              ))}
            </select>
          </label>
          <label className="space-y-1 text-sm">
            <span className="block font-medium">表示</span>
            <select
              data-testid="shifts-print-view"
              className={`${selectClass} w-40`}
              value={view}
              onChange={(e) => go(day, parsePrintView(e.target.value))}
              aria-label="表示"
            >
              <option value="table">日ごとの表（A4 横）</option>
              <option value="people">人ごと（A4 縦）</option>
            </select>
          </label>
        </div>
        {namesQ.isError && !namesQ.data ? <ErrorBanner error={namesQ.error} onRetry={() => void namesQ.refetch()} /> : null}
      </div>
      <QueryState query={boardQ}>
        {(board) => {
          const openDay = days.find((d) => d.date === day) ?? null;
          if (!openDay) {
            return <EmptyState title="シフトの時間枠はまだありません" />;
          }
          // 見出しの日付は曜日つき（祭の日は「前日 10/15（金）」。04「シフト表の印刷」）
          const dayTitle = shiftDayPrintLabel(openDay.date, fs, now) || openDay.label;
          return view === 'table' ? (
            <PrintTables board={board} day={openDay} dayTitle={dayTitle} yearLabel={yearLabel} names={names} />
          ) : (
            <PrintPeople board={board} day={openDay} dayTitle={dayTitle} yearLabel={yearLabel} names={names} />
          );
        }}
      </QueryState>
    </div>
  );
}

function PrintTables({
  board,
  day,
  dayTitle,
  yearLabel,
  names,
}: {
  board: ShiftBoard;
  day: ShiftDay;
  dayTitle: string;
  yearLabel: string;
  names: ReadonlyMap<string, string>;
}) {
  // 印刷は総務部門員の表と同じ（その日にますのある持ち場だけ、ロールで分けない）
  const table = buildShiftTable(board, day.date, { allDuties: false, roles: null, names, userId: null });
  const groups = chunk(
    table.columns.map((c, k) => ({ c, k })),
    PRINT_COLUMNS,
  );
  if (groups.length === 0) groups.push([]);
  return (
    <div className="space-y-6">
      {groups.map((g, gi) => (
        <section key={gi} data-testid="shifts-print-table" className="break-inside-avoid space-y-2 [break-inside:avoid] print:break-after-page last:print:break-after-auto">
          <h2 className="text-lg font-bold">
            {yearLabel} シフト表 {dayTitle}
            {groups.length > 1 ? `（${gi + 1}／${groups.length}）` : ''}
          </h2>
          <table className="w-full border-collapse text-sm">
            <thead>
              <tr>
                <th scope="col" className="border px-2 py-1 text-left">
                  時間枠
                </th>
                {g.map(({ c }) => (
                  <th key={c.id} scope="col" className="border px-2 py-1 text-left">
                    {c.name}
                    {c.place ? <span className="block text-xs font-normal">{c.place}</span> : null}
                  </th>
                ))}
              </tr>
            </thead>
            <tbody>
              {table.rows.map((row) => (
                <tr key={row.slot.id} className="break-inside-avoid">
                  <th scope="row" className="border px-2 py-1 text-left tabular-nums">
                    {row.label}
                  </th>
                  {g.map(({ k }) => {
                    const cell = row.cells[k]!;
                    const diff = cellDiffText(cell);
                    return (
                      <td key={cell.duty.id} className="border px-2 py-1 align-top">
                        {cell.members.map((p) => (
                          <span key={p.userId} className="block">
                            {p.name ?? NAME_UNKNOWN}
                          </span>
                        ))}
                        <span className="block text-xs tabular-nums">
                          {cellCountText(cell)}
                          {diff ? <strong className="ml-1">{diff}</strong> : null}
                        </span>
                      </td>
                    );
                  })}
                </tr>
              ))}
            </tbody>
          </table>
        </section>
      ))}
    </div>
  );
}

function PrintPeople({
  board,
  day,
  dayTitle,
  yearLabel,
  names,
}: {
  board: ShiftBoard;
  day: ShiftDay;
  dayTitle: string;
  yearLabel: string;
  names: ReadonlyMap<string, string>;
}) {
  const people = peopleOfDay(board, day.date, names);
  if (people.length === 0) return <EmptyState title="この日に割り当てのある人はいません" />;
  return (
    <div className="grid gap-4 sm:grid-cols-2 print:grid-cols-2">
      {people.map((p) => (
        <section key={p.userId} data-testid="shifts-print-person" className="break-inside-avoid space-y-2 rounded-lg border p-4 [break-inside:avoid]">
          <h2 className="text-lg font-bold [overflow-wrap:anywhere]">{p.name ?? NAME_UNKNOWN}</h2>
          <p className="text-sm">
            {yearLabel} {dayTitle}
          </p>
          <ul className="space-y-1 text-sm">
            {p.items.map((i) => (
              <li key={i.slot.id}>
                <span className="font-semibold tabular-nums">{i.label}</span> {i.duty?.name ?? ''}
                {i.duty?.place ? <span className="text-muted-foreground">（{i.duty.place}）</span> : null}
              </li>
            ))}
          </ul>
        </section>
      ))}
    </div>
  );
}
