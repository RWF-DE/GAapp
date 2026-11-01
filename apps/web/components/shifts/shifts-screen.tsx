'use client';

// シフト表（/shifts。PC。04「シフト表」、notes/T20.md「画面の約束」4・13。T20・D-56）。
// - 読む：開いている年度の時間枠（ますと割り当てを埋め込む）と持ち場、表示名、部門長以上はロールの一覧（人を選ぶ一覧と「総務でない人」）。
//   画面に戻ったとき（refetchOnWindowFocus）と 60 秒ごとに読み直す（Realtime は使わない。開いているダイアログの入力は画面の状態なので消えない）。
//   最終読み込みと「読み直す」。
// - 日のタブ（`?day=`）・表（行は時間枠、列は持ち場。shift-table.tsx）・足りないますを目立たせる（`?filter=short`）・印刷へのリンク。
// - 部門長以上（終了した年度を除く。canEditShifts）は、1日分をまとめて作る・時間枠と持ち場の足す・直す・消す・ますのダイアログ。それらの
//   部品（ダイアログ・送信と読み直しの決め方）は動的 import にし、総務部門員の JS に入れない（shift-lead-dialogs.tsx）。
// - 終了した年度では、総務に「終了した年度のため、シフトと作業は読むだけです」の帯を出し、操作を出さない。
import { useQuery } from '@tanstack/react-query';
import { CalendarPlus, Plus, Printer } from 'lucide-react';
import dynamic from 'next/dynamic';
import { useSearchParams } from 'next/navigation';
import { useMemo, useState } from 'react';
import { AppLink } from '@/components/common/app-link';
import { ErrorBanner } from '@/components/common/error-banner';
import { PageHeader } from '@/components/common/page-header';
import { EmptyState, QueryState, ReadOnlyNotice } from '@/components/states';
import { Button } from '@/components/ui/button';
import { Checkbox } from '@/components/ui/checkbox';
import { Label } from '@/components/ui/label';
import { useAuth } from '@/lib/auth/auth-provider';
import type { Membership } from '@/lib/auth/membership';
import { isSoumu, type AppRole } from '@/lib/auth/roles';
import { useYearRow } from '@/lib/data/year';
import { buildShiftTable, pickShiftDay, shiftDays, type ShiftBoard, type ShiftDay } from '@/lib/modules/shifts/board';
import { nameMapOf } from '@/lib/modules/shifts/names';
import { canEditShifts, CLOSED_SHIFTS, seesMemberRoles } from '@/lib/modules/shifts/permissions';
import { SHIFT_BOARD_REFETCH_MS, shiftBoardOptions } from '@/lib/modules/shifts/board-read';
import { shiftMembersOptions, soumuNamesOptions } from '@/lib/modules/shifts/reads';
import { useGuardedRouter } from '@/lib/navigation/guarded-router';
import { cn } from '@/lib/utils';
import type { ShiftDialogTarget } from './shift-lead-dialogs';
import { ShiftTable } from './shift-table';

// 部門長以上の部品（ダイアログ・削除の確かめ・送信と読み直し）は動的 import（総務部門員の /shifts の JS に入れない）
const ShiftLeadDialogs = dynamic(() => import('./shift-lead-dialogs').then((m) => m.ShiftLeadDialogs), { ssr: false });

/** 空の表示（04「シフト表」） */
export const SHIFTS_EMPTY_TEXTS = {
  noSlots: 'シフトの時間枠はまだありません',
  addDayHint: '「1日分をまとめて作る」から作れます。',
  noDuties: '「持ち場を足す」から持ち場を作ってください',
} as const;

/** `/shifts?day=…&filter=short`（既定の日も入れる。印刷・ダッシュボードの行き先と同じ形） */
export function shiftsHref(day: string | null, filterShort: boolean): string {
  const q = new URLSearchParams();
  if (day) q.set('day', day);
  if (filterShort) q.set('filter', 'short');
  const s = q.toString();
  return s ? `/shifts?${s}` : '/shifts';
}

export function ShiftsScreen() {
  const { membership, session } = useAuth();
  if (membership.status !== 'ready') return null; // AppShell が読み込み中・未招待を出す
  const m = membership.membership;
  if (!m.year) return null;
  const userId = session.status === 'signedIn' ? session.session.user.id : null;
  return <ShiftsBoardScreen key={m.year.id} membership={m} yearId={m.year.id} userId={userId} />;
}

function ShiftsBoardScreen({ membership: m, yearId, userId }: { membership: Membership; yearId: string; userId: string | null }) {
  const { reloadMembership } = useAuth();
  const router = useGuardedRouter();
  const params = useSearchParams();
  const yearQ = useYearRow(yearId);
  const role = m.role;
  const lead = seesMemberRoles(role);
  const boardQ = useQuery({ ...shiftBoardOptions(yearId), refetchInterval: SHIFT_BOARD_REFETCH_MS, refetchOnWindowFocus: true });
  const namesQ = useQuery(soumuNamesOptions(yearId));
  const membersQ = useQuery({ ...shiftMembersOptions(yearId), enabled: lead });
  // 画面を開いた時刻と、表を読んだ時刻の遅いほう（60 秒ごとの読み直しで「これからの時間枠」と既定の日を決め直す。描画のたびに時計を読まない）
  const [openedAt] = useState(() => Date.now());
  const now = Math.max(openedAt, boardQ.dataUpdatedAt);
  const status = yearQ.data?.status ?? m.year?.status ?? null;
  const writable = canEditShifts(role, status) && !!userId;
  const [dialog, setDialog] = useState<ShiftDialogTarget | null>(null);

  const names = useMemo(() => nameMapOf(namesQ.data), [namesQ.data]);
  const roles = useMemo(
    () => (lead && membersQ.data ? new Map<string, AppRole>(membersQ.data.map((r) => [r.user_id, r.role])) : null),
    [lead, membersQ.data],
  );
  const board = boardQ.data;
  const festivalStart = yearQ.data?.festival_start ?? m.year?.festival_start ?? null;
  const days = useMemo(() => (board ? shiftDays(board.slots, festivalStart, now) : []), [board, festivalStart, now]);
  const day = pickShiftDay(days, params.get('day'), now);
  const filterShort = params.get('filter') === 'short';

  const reload = () => {
    void boardQ.refetch();
    void namesQ.refetch();
    if (lead) void membersQ.refetch();
    void yearQ.refetch();
  };
  const reloadYear = () => {
    reloadMembership();
    void yearQ.refetch();
  };
  const go = (nextDay: string | null, short: boolean) => router.forceReplace(shiftsHref(nextDay, short));

  const openDay = days.find((d) => d.date === day) ?? null;
  const newDate = day ?? null;

  return (
    <div className="mx-auto max-w-7xl space-y-4">
      <PageHeader
        title="シフト表"
        loadedAt={boardQ.dataUpdatedAt ? new Date(boardQ.dataUpdatedAt) : null}
        onReload={reload}
        reloading={boardQ.isFetching || namesQ.isFetching}
        actions={
          <div className="flex flex-wrap gap-2 print:hidden">
            <Button asChild variant="outline" data-testid="shifts-print-link">
              <AppLink href={day ? `/shifts/print?day=${day}` : '/shifts/print'}>
                <Printer aria-hidden />
                印刷
              </AppLink>
            </Button>
            {writable ? (
              <>
                <Button data-testid="shifts-add-day" onClick={() => setDialog({ type: 'day', date: newDate })} disabled={!board}>
                  <CalendarPlus aria-hidden />
                  1日分をまとめて作る
                </Button>
                <Button variant="outline" data-testid="shifts-add-slot" onClick={() => setDialog({ type: 'slot-new', date: newDate })} disabled={!board}>
                  <Plus aria-hidden />
                  時間枠を足す
                </Button>
                <Button variant="outline" data-testid="shifts-add-duty" onClick={() => setDialog({ type: 'duty-new' })} disabled={!board}>
                  <Plus aria-hidden />
                  持ち場を足す
                </Button>
              </>
            ) : null}
          </div>
        }
      />
      {status === 'closed' && isSoumu(role) ? <ReadOnlyNotice>{CLOSED_SHIFTS}</ReadOnlyNotice> : null}
      {yearQ.isError && !yearQ.data ? <ErrorBanner error={yearQ.error} onRetry={() => void yearQ.refetch()} /> : null}
      {namesQ.isError && !namesQ.data ? <ErrorBanner error={namesQ.error} onRetry={() => void namesQ.refetch()} /> : null}
      {lead && membersQ.isError && !membersQ.data ? <ErrorBanner error={membersQ.error} onRetry={() => void membersQ.refetch()} /> : null}
      <QueryState query={boardQ}>
        {(b) => (
          <BoardBody
            board={b}
            days={days}
            day={openDay}
            now={now}
            filterShort={filterShort}
            lead={lead}
            writable={writable}
            names={names}
            roles={roles}
            userId={userId}
            onDay={(d) => go(d, filterShort)}
            onFilterShort={(on) => go(day, on)}
            onDialog={setDialog}
          />
        )}
      </QueryState>
      {/* 開いているダイアログは、書けなくなっても（権限か年度の状態が変わった）入力を残して出したまま（送るボタンを押せなくする） */}
      {(writable || dialog !== null) && board && userId ? (
        <ShiftLeadDialogs
          target={dialog}
          onClose={() => setDialog(null)}
          yearId={yearId}
          userId={userId}
          board={board}
          names={names}
          members={membersQ.data ?? []}
          writable={writable}
          onReload={reload}
          onReloadMembership={reloadYear}
          onDayCreated={(d) => go(d, filterShort)}
        />
      ) : null}
    </div>
  );
}

function BoardBody({
  board,
  days,
  day,
  now,
  filterShort,
  lead,
  writable,
  names,
  roles,
  userId,
  onDay,
  onFilterShort,
  onDialog,
}: {
  board: ShiftBoard;
  days: readonly ShiftDay[];
  day: ShiftDay | null;
  now: number;
  filterShort: boolean;
  lead: boolean;
  writable: boolean;
  names: ReadonlyMap<string, string>;
  roles: ReadonlyMap<string, AppRole> | null;
  userId: string | null;
  onDay: (date: string) => void;
  onFilterShort: (on: boolean) => void;
  onDialog: (t: ShiftDialogTarget) => void;
}) {
  const table = useMemo(
    () => (day ? buildShiftTable(board, day.date, { allDuties: lead, roles, names, userId }) : null),
    [board, day, lead, roles, names, userId],
  );
  if (board.slots.length === 0 || !day || !table) {
    return (
      <div data-testid="shifts-empty">
        <EmptyState
          title={SHIFTS_EMPTY_TEXTS.noSlots}
          description={
            writable ? (
              <>
                <span className="block">{SHIFTS_EMPTY_TEXTS.addDayHint}</span>
                {board.duties.length === 0 ? <span className="block">{SHIFTS_EMPTY_TEXTS.noDuties}</span> : null}
              </>
            ) : undefined
          }
        />
      </div>
    );
  }
  return (
    <div data-testid="shifts-board" className="space-y-3">
      <div className="flex flex-wrap items-center justify-between gap-3">
        <nav aria-label="日" data-testid="shifts-day-tabs" className="flex flex-wrap gap-1.5">
          {days.map((d) => (
            <Button
              key={d.date}
              size="sm"
              variant={d.date === day.date ? 'default' : 'outline'}
              data-testid="shifts-day-tab"
              data-day={d.date}
              aria-current={d.date === day.date ? 'page' : undefined}
              onClick={() => onDay(d.date)}
            >
              {d.label}
            </Button>
          ))}
        </nav>
        <div className="flex items-center gap-2">
          <Checkbox
            id="shifts-filter-short"
            data-testid="shifts-filter-short"
            checked={filterShort}
            onCheckedChange={(v) => onFilterShort(v === true)}
          />
          <Label htmlFor="shifts-filter-short" className="font-normal">
            足りないますだけを目立たせる
          </Label>
        </div>
      </div>
      {writable && board.duties.length === 0 ? (
        <p className="rounded-md border border-dashed px-4 py-3 text-sm text-muted-foreground">{SHIFTS_EMPTY_TEXTS.noDuties}</p>
      ) : null}
      <h2 className={cn('text-base font-semibold')}>{day.label}</h2>
      <ShiftTable
        table={table}
        now={now}
        filterShort={filterShort}
        writable={writable}
        onCell={(c) => onDialog({ type: 'cell', slotId: c.slot.id, dutyId: c.duty.id })}
        onEditSlot={(s) => onDialog({ type: 'slot-edit', slot: s })}
        onDeleteSlot={(s) => onDialog({ type: 'slot-delete', slot: s })}
        onEditDuty={(d) => onDialog({ type: 'duty-edit', duty: d })}
        onDeleteDuty={(d) => onDialog({ type: 'duty-delete', duty: d })}
      />
    </div>
  );
}
