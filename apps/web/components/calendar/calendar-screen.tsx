'use client';

// 締切と予定（/calendar。PC・スマホ。04「締切と予定」、notes/T18.md「後半（画面）の約束」4〜7。T18・D-54）。
// - 読む：開いている年度の項目（RLS が返したものをそのまま。総務はその年度の全部、閲覧のみ・店長・副店長は対象が団体・全員のもの）と、
//   ほかの機能が締切と予定に出す日付（機能の日付。ダッシュボードの「締切と予定」と同じプロバイダの流れ〔usePortalWidget の 'dated'〕で
//   集め、calendar のプロバイダだけを除く〔項目は全部の列でここが読むので、欄用の軽い読み取りを二重に送らない〕。机椅子は年度の行から
//   作るので読み取りは増えない）。最終読み込みと「読み直す」。
// - Asia/Tokyo の日ごとの1つの一覧（lib/modules/calendar/list.ts）。既定は今日から、「過去も表示」（`?past=1`）で過去も。総務は種類・
//   対象で絞り込める（`?kind=`・`?audience=`。知らない値は「すべて」）。`?event=<id>`（ダッシュボードの欄から来る）はその項目を
//   目立たせて見える所に送り、絞り込みは「すべて」に、今日より前に終わった項目なら「過去も表示」にする（読めない・ない id なら何もしない）。
// - 登録・編集・削除は部門長以上だけ（終了した年度を除く。lib/modules/calendar/permissions.ts）。終了した年度では部門長以上に帯を出し、
//   総務部門員・閲覧のみ・店長・副店長には書くためのもの（ボタン・帯）を何も出さない。
// - 削除は確かめてから、読んだときの updated_at を条件に入れて delete（deleteChecked）。0 行・応答が届かなかったときは event-write.ts の
//   決め方（(B1)）。消せたか分からずに終わった後のもう一度で消えていたら「「{題名}」は削除されていました」（前の削除が通っていた可能性が
//   あるので、ほかの人が削除したとは言わない）。
import { useQueryClient } from '@tanstack/react-query';
import { Plus } from 'lucide-react';
import { useSearchParams } from 'next/navigation';
import { useMemo, useState } from 'react';
import { toast } from 'sonner';
import { ConfirmDialog } from '@/components/common/confirm-dialog';
import { ErrorBanner } from '@/components/common/error-banner';
import { PageHeader } from '@/components/common/page-header';
import { usePortalWidget } from '@/components/portal/use-portal';
import { ModuleError, PortalLoading } from '@/components/portal/widget';
import { EmptyState, QueryState, ReadOnlyNotice } from '@/components/states';
import { Button } from '@/components/ui/button';
import { Checkbox } from '@/components/ui/checkbox';
import { Label } from '@/components/ui/label';
import { ToggleGroup, ToggleGroupItem } from '@/components/ui/toggle-group';
import { useAuth } from '@/lib/auth/auth-provider';
import { useAuthErrorHandler } from '@/lib/auth/guarded';
import type { Membership } from '@/lib/auth/membership';
import { isLead } from '@/lib/auth/roles';
import {
  deleteEvent,
  dropEventFromCache,
  EVENT_AUDIENCES,
  EVENT_KINDS,
  invalidateCalendar,
  readEvent,
  useCalendarEvents,
  type CalendarEventRow,
  type EventAudience,
  type EventKind,
} from '@/lib/data/calendar';
import { useYearRow } from '@/lib/data/year';
import { tokyoToday } from '@/lib/datetime';
import { classifyError, effectOf, messageFor, unknownOutcomeMessage } from '@/lib/errors';
import { EVENT_AUDIENCE_LABELS, EVENT_KIND_LABELS } from '@/lib/modules/calendar/labels';
import { buildCalendarDays, calendarHref, parseCalendarParams, type CalendarFilter } from '@/lib/modules/calendar/list';
import { canWriteEvents, seesEventAudience } from '@/lib/modules/calendar/permissions';
import { eventDatedItem } from '@/lib/modules/calendar/portal';
import { datedLastDay, portalContextsOf, type PortalProvider } from '@/lib/modules/portal';
import { PORTAL_PROVIDERS } from '@/lib/modules/providers';
import { useGuardedRouter } from '@/lib/navigation/guarded-router';
import { CalendarList } from './calendar-list';
import { EventFormDialog, type EventFormTarget } from './event-form-dialog';
import { runEventDelete } from './event-write';

/** 終了した年度の帯（部門長以上だけ） */
export const CLOSED_CALENDAR = '終了した年度のため、締切と予定は読むだけです';
/** 削除で、読み直すと（0 行の理由を見ると）もうなかった */
export const ALREADY_DELETED_MESSAGE = 'すでに削除されていました（ほかの人が削除した可能性があります）';
/** 削除で、版が違った */
export const DELETE_CHANGED_MESSAGE = 'ほかの人がこの項目を先に変えました。読み直しました。内容を確かめてから、もう一度削除してください';
/** 空の表示（04「締切と予定」の空の表示） */
export const EMPTY_TEXTS = {
  upcoming: 'これからの締切と予定はありません',
  all: '締切と予定はまだありません',
  filtered: '条件に合う締切と予定はありません',
  addHint: '「締切・予定を登録」から足せます。',
} as const;

/**
 * 機能の日付を出すプロバイダ（calendar 以外。/calendar は項目を全部の列で自分で読むので、ダッシュボードの欄用の軽い読み取りを
 * 二重に送らない。後半の判断したことの 8）
 */
export function moduleDateProviders(providers: readonly PortalProvider[] = PORTAL_PROVIDERS): PortalProvider[] {
  return providers.filter((p) => p.moduleId !== 'calendar');
}

const TOGGLE_ON = 'data-[state=on]:bg-primary data-[state=on]:text-primary-foreground';

export function CalendarScreen() {
  const { membership, session } = useAuth();
  if (membership.status !== 'ready') return null; // AppShell が読み込み中・未招待を出す
  const m = membership.membership;
  if (!m.year) return null;
  const userId = session.status === 'signedIn' ? session.session.user.id : null;
  return <CalendarBoard key={m.year.id} membership={m} yearId={m.year.id} userId={userId} />;
}

function CalendarBoard({ membership: m, yearId, userId }: { membership: Membership; yearId: string; userId: string | null }) {
  const queryClient = useQueryClient();
  const { reloadMembership } = useAuth();
  const onAuthError = useAuthErrorHandler();
  const router = useGuardedRouter();
  const params = useSearchParams();
  const yearQ = useYearRow(yearId);
  const q = useCalendarEvents(yearId);
  // 画面を開いた時刻（描画のたびに時計を読まない。日の見出しと相対の言い方・既定の今日から・機能の日付が同じ時刻で決める）
  const [now] = useState(() => Date.now());
  const role = m.role;
  // 書けるかは年度の行の状態で決める（立場と一緒に読んだキャッシュ。forbidden の後は読み直す）
  const status = yearQ.data?.status ?? m.year?.status ?? null;
  const writable = canWriteEvents(role, status) && !!userId;
  const soumu = seesEventAudience(role);

  const ctxs = useMemo(() => (yearQ.data ? portalContextsOf(m, yearQ.data, now) : []), [m, yearQ.data, now]);
  const providers = useMemo(() => moduleDateProviders(), []);
  const modules = usePortalWidget(ctxs, 'dated', providers);

  const [form, setForm] = useState<EventFormTarget | null>(null);
  const [deleting, setDeleting] = useState<CalendarEventRow | null>(null);
  const [deleteError, setDeleteError] = useState<string | null>(null);

  const reload = () => void q.refetch();
  const reloadYear = () => {
    reloadMembership();
    void yearQ.refetch();
  };

  const data = q.data;
  const parsed = parseCalendarParams(params, soumu);
  // ?event= の項目（読めた項目だけ）：絞り込みを「すべて」にし、今日より前に終わった項目なら過去も出す
  const highlightRow = data && parsed.highlight ? (data.events.find((e) => e.id === parsed.highlight) ?? null) : null;
  const filter: CalendarFilter = highlightRow
    ? { past: parsed.past || datedLastDay(eventDatedItem(highlightRow)) < tokyoToday(new Date(now)), kind: null, audience: null }
    : { past: parsed.past, kind: parsed.kind, audience: parsed.audience };
  const setFilter = (next: CalendarFilter) => router.forceReplace(calendarHref(next));

  const confirmDelete = async () => {
    const e = deleting;
    if (!e) return;
    // 同じ確かめのダイアログで、前の削除が消せたか分からずに終わった（deleteError は unknown のときだけ立ち、閉じると消える）
    const afterUnknown = deleteError !== null;
    setDeleteError(null);
    const r = await runEventDelete({ send: () => deleteEvent(e), reread: () => readEvent(e.id), baseVersion: e.updated_at }, onAuthError);
    switch (r.type) {
      case 'deleted':
        dropEventFromCache(queryClient, yearId, e.id);
        invalidateCalendar(queryClient, yearId);
        // 止められて（0 行で）もうなかった：前の削除が通っていた可能性があるなら「削除されていました」（ほかの人とは言わない）
        if (r.before && afterUnknown) toast.success(`「${e.title}」は削除されていました`);
        else if (r.before) toast.info(ALREADY_DELETED_MESSAGE);
        else toast.success(`「${e.title}」を削除しました`);
        return;
      case 'changed':
        invalidateCalendar(queryClient, yearId);
        toast.error(DELETE_CHANGED_MESSAGE);
        return;
      case 'unknown':
        // 消せたか分からない：確かめのダイアログを開いたまま知らせる（もう一度押すと、同じ版で送る）
        setDeleteError(unknownOutcomeMessage('削除'));
        throw new Error('keep-open');
      case 'failed': {
        const c = classifyError(r.error);
        const effect = effectOf(c);
        if (effect.reload === 'year') {
          reloadYear();
          reload();
        } else if (effect.reload === 'data') reload();
        toast.error(messageFor(c));
        return;
      }
    }
  };

  return (
    <div className="mx-auto max-w-6xl space-y-4">
      <PageHeader
        title="締切と予定"
        loadedAt={q.dataUpdatedAt ? new Date(q.dataUpdatedAt) : null}
        onReload={reload}
        reloading={q.isFetching}
        actions={
          writable ? (
            <Button data-testid="calendar-add" onClick={() => setForm({ type: 'new' })} disabled={!data}>
              <Plus aria-hidden />
              締切・予定を登録
            </Button>
          ) : undefined
        }
      />
      {isLead(role) && status === 'closed' ? (
        <div data-testid="calendar-closed">
          <ReadOnlyNotice>{CLOSED_CALENDAR}</ReadOnlyNotice>
        </div>
      ) : null}
      {yearQ.isError && !yearQ.data ? <ErrorBanner error={yearQ.error} onRetry={() => void yearQ.refetch()} /> : null}
      <CalendarFilters soumu={soumu} filter={filter} onChange={setFilter} />
      {modules
        .filter((x) => x.failure)
        .map((x) => (
          <ModuleError key={x.moduleId} moduleId={x.moduleId} error={x.failure!.error} onRetry={x.failure!.retry} />
        ))}
      {modules
        .filter((x) => x.loading)
        .map((x) => (
          <PortalLoading key={x.moduleId} moduleId={x.moduleId} />
        ))}
      <QueryState query={q}>
        {(d) => {
          const days = buildCalendarDays(
            d.events,
            modules.flatMap((x) => x.dated),
            now,
            filter,
          );
          if (days.length > 0) {
            return (
              <CalendarList
                days={days}
                now={now}
                showAudience={soumu}
                canWrite={writable}
                highlightId={highlightRow?.id ?? null}
                onEdit={(e) => setForm({ type: 'edit', event: e })}
                onDelete={(e) => {
                  setDeleteError(null);
                  setDeleting(e);
                }}
              />
            );
          }
          const filtered = !!filter.kind || !!filter.audience;
          return (
            <div data-testid="calendar-empty">
              <EmptyState
                title={filtered ? EMPTY_TEXTS.filtered : filter.past ? EMPTY_TEXTS.all : EMPTY_TEXTS.upcoming}
                description={!filtered && !filter.past && writable ? EMPTY_TEXTS.addHint : undefined}
              />
            </div>
          );
        }}
      </QueryState>
      {data && userId ? (
        <EventFormDialog
          target={form}
          onClose={() => setForm(null)}
          yearId={yearId}
          userId={userId}
          writable={writable}
          onReload={reload}
          onReloadMembership={reloadYear}
        />
      ) : null}
      <ConfirmDialog
        open={deleting !== null}
        onOpenChange={(open) => {
          if (!open) {
            setDeleting(null);
            setDeleteError(null);
          }
        }}
        title={deleting ? `「${deleting.title}」を削除しますか` : ''}
        description="この項目は、一覧とダッシュボードの締切と予定から消えます。元に戻せません。"
        confirmLabel="削除する"
        pendingLabel="削除しています…"
        destructive
        onConfirm={confirmDelete}
      >
        <div data-testid="event-delete-confirm">
          {deleteError ? (
            <p role="alert" data-testid="event-delete-error" className="rounded-md border border-destructive/40 bg-destructive/5 px-3 py-2 text-sm text-destructive">
              {deleteError}
            </p>
          ) : null}
        </div>
      </ConfirmDialog>
    </div>
  );
}

/** 絞り込み：総務には種類・対象（ToggleGroup。URL に入れる）、全員に「過去も表示」 */
function CalendarFilters({ soumu, filter, onChange }: { soumu: boolean; filter: CalendarFilter; onChange: (next: CalendarFilter) => void }) {
  return (
    <div className="flex flex-wrap items-center gap-x-6 gap-y-3">
      {soumu ? (
        <>
          <ToggleGroup
            type="single"
            variant="outline"
            size="sm"
            spacing={2}
            value={filter.kind ?? 'all'}
            onValueChange={(v) => {
              if (v) onChange({ ...filter, kind: v === 'all' ? null : (v as EventKind) });
            }}
            aria-label="種類で絞り込む"
            data-testid="calendar-kind-filter"
            className="flex-wrap"
          >
            <ToggleGroupItem value="all" className={TOGGLE_ON}>
              すべて
            </ToggleGroupItem>
            {EVENT_KINDS.map((k) => (
              <ToggleGroupItem key={k} value={k} className={TOGGLE_ON}>
                {EVENT_KIND_LABELS[k]}
              </ToggleGroupItem>
            ))}
          </ToggleGroup>
          <ToggleGroup
            type="single"
            variant="outline"
            size="sm"
            spacing={2}
            value={filter.audience ?? 'all'}
            onValueChange={(v) => {
              if (v) onChange({ ...filter, audience: v === 'all' ? null : (v as EventAudience) });
            }}
            aria-label="対象で絞り込む"
            data-testid="calendar-audience-filter"
            className="flex-wrap"
          >
            <ToggleGroupItem value="all" className={TOGGLE_ON}>
              すべて
            </ToggleGroupItem>
            {EVENT_AUDIENCES.map((a) => (
              <ToggleGroupItem key={a} value={a} className={TOGGLE_ON}>
                {EVENT_AUDIENCE_LABELS[a]}
              </ToggleGroupItem>
            ))}
          </ToggleGroup>
        </>
      ) : null}
      <div className="flex items-center gap-2">
        <Checkbox id="calendar-past" data-testid="calendar-past" checked={filter.past} onCheckedChange={(v) => onChange({ ...filter, past: v === true })} />
        <Label htmlFor="calendar-past" className="font-normal">
          過去も表示
        </Label>
      </div>
    </div>
  );
}
