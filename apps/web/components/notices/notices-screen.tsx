'use client';

// お知らせ一覧（/notices。PC・スマホ。04「お知らせ一覧」、notes/T17.md「後半（画面）の約束」3〜5。T17・D-53）。
// - 読む：開いている年度のお知らせ（RLS が返したものをそのまま。総務はその年度の全部、閲覧のみは団体あて、店長・副店長は全団体あてと
//   自団体あて）と団体。総務には書いた人の表示名も。並びはピン留め → 出した日時の新しい順 → id。最終読み込みと「読み直す」。
// - 総務は宛先で絞り込める（`?audience=soumu|all_groups|groups`。件数つき。知らない値は「すべて」）。`?notice=<id>`（ダッシュボードの
//   欄から来る）はそのお知らせを目立たせて見える所に送り、絞り込みは「すべて」にする（読めない・ないお知らせなら何もしない）。
// - 書く・編集・削除は総務だけ（段は lib/modules/notices/permissions.ts。終了した年度は読むだけで、総務には帯を出す）。閲覧のみ・
//   店長・副店長には書くためのもの（ボタン・帯）を何も出さない。
// - 削除は確かめてから delete_notice（読んだときの updated_at）。応答が届かなかった・forbidden・conflict は読み直して決める（(B1)）。
import { useQueryClient } from '@tanstack/react-query';
import { Plus } from 'lucide-react';
import { useSearchParams } from 'next/navigation';
import { useMemo, useState } from 'react';
import { toast } from 'sonner';
import { ConfirmDialog } from '@/components/common/confirm-dialog';
import { PageHeader } from '@/components/common/page-header';
import { EmptyState, QueryState, ReadOnlyNotice } from '@/components/states';
import { Button } from '@/components/ui/button';
import { ToggleGroup, ToggleGroupItem } from '@/components/ui/toggle-group';
import { useAuth } from '@/lib/auth/auth-provider';
import { useAuthErrorHandler } from '@/lib/auth/guarded';
import type { YearStatus } from '@/lib/auth/membership';
import { isSoumu, type AppRole } from '@/lib/auth/roles';
import {
  deleteNotice,
  dropNoticeFromCache,
  invalidateNotices,
  NOTICE_AUDIENCES,
  readNotice,
  useNotices,
  type NoticeAudience,
  type NoticeRow,
  type NoticesData,
} from '@/lib/data/notices';
import { useYearRow } from '@/lib/data/year';
import { classifyError, effectOf, messageFor, unknownOutcomeMessage } from '@/lib/errors';
import { NOTICE_AUDIENCE_LABELS } from '@/lib/labels';
import { canWriteNotices } from '@/lib/modules/notices/permissions';
import { useGuardedRouter } from '@/lib/navigation/guarded-router';
import { NoticeFormDialog, type NoticeFormTarget } from './notice-form-dialog';
import { NoticeList } from './notice-list';
import { runNoticeDelete } from './notice-write';

/** 終了した年度の帯（総務だけ） */
export const CLOSED_NOTICE = '終了した年度のため、お知らせは読むだけです';
/** 削除で forbidden・conflict・not_found が返り、読み直すともうなかった */
export const ALREADY_DELETED_MESSAGE = 'すでに削除されていました（ほかの人が削除した可能性があります）';
/** 削除で、読み直すと版が違った */
export const DELETE_CHANGED_MESSAGE = 'ほかの人がこのお知らせを先に変えました。読み直しました。内容を確かめてから、もう一度削除してください';

/** `?audience=` の値（知らない値・ないときは null＝すべて） */
export function parseAudienceParam(v: string | null): NoticeAudience | null {
  return v !== null && (NOTICE_AUDIENCES as readonly string[]).includes(v) ? (v as NoticeAudience) : null;
}

export function NoticesScreen() {
  const { membership, session } = useAuth();
  if (membership.status !== 'ready') return null; // AppShell が読み込み中・未招待を出す
  const m = membership.membership;
  if (!m.year) return null;
  const userId = session.status === 'signedIn' ? session.session.user.id : null;
  return <NoticesBoard key={m.year.id} yearId={m.year.id} yearStatus={m.year.status} role={m.role} userId={userId} />;
}

function NoticesBoard({ yearId, yearStatus, role, userId }: { yearId: string; yearStatus: YearStatus; role: AppRole | null; userId: string | null }) {
  const queryClient = useQueryClient();
  const { reloadMembership } = useAuth();
  const onAuthError = useAuthErrorHandler();
  const router = useGuardedRouter();
  const params = useSearchParams();
  const soumu = isSoumu(role);
  const yearQ = useYearRow(yearId);
  const q = useNotices(yearId, soumu);
  // 書けるかは年度の行の状態で決める（立場と一緒に読んだキャッシュ。forbidden・invalid_state の後は読み直す）
  const status = yearQ.data?.status ?? yearStatus;
  const writable = canWriteNotices(role, status) && !!userId;
  const actor = useMemo(() => ({ role, status, userId }), [role, status, userId]);

  const [form, setForm] = useState<NoticeFormTarget | null>(null);
  const [deleting, setDeleting] = useState<NoticeRow | null>(null);
  const [deleteError, setDeleteError] = useState<string | null>(null);

  const reload = () => void q.refetch();
  const reloadYear = () => {
    reloadMembership();
    void yearQ.refetch();
  };

  const data = q.data;
  const noticeParam = params.get('notice');
  const highlightId = data && noticeParam && data.notices.some((n) => n.id === noticeParam) ? noticeParam : null;
  // 絞り込みは総務だけ。?notice= のお知らせがあれば「すべて」にする
  const filter = soumu && !highlightId ? parseAudienceParam(params.get('audience')) : null;
  const setFilter = (v: NoticeAudience | null) => router.forceReplace(v ? `/notices?audience=${v}` : '/notices');

  const confirmDelete = async () => {
    const n = deleting;
    if (!n) return;
    setDeleteError(null);
    const r = await runNoticeDelete({ send: () => deleteNotice(n), reread: () => readNotice(n.id), baseVersion: n.updated_at }, onAuthError);
    switch (r.type) {
      case 'deleted':
        dropNoticeFromCache(queryClient, yearId, n.id);
        invalidateNotices(queryClient, yearId);
        if (r.before) toast.info(ALREADY_DELETED_MESSAGE);
        else toast.success(`「${n.title}」を削除しました`);
        return;
      case 'changed':
        invalidateNotices(queryClient, yearId);
        toast.error(DELETE_CHANGED_MESSAGE);
        return;
      case 'unknown':
        // 消せたか分からない：確かめのダイアログを開いたまま知らせる（もう一度押すと、確かめてから送る）
        setDeleteError(unknownOutcomeMessage('削除'));
        throw new Error('keep-open');
      case 'failed': {
        const c = classifyError(r.error);
        const effect = effectOf(c);
        if (effect.reload === 'year') {
          reloadYear();
          reload();
        } else if (effect.reload === 'data') reload();
        toast.error(messageFor(c, { rpc: 'delete_notice' }));
        return;
      }
    }
  };

  return (
    <div className="mx-auto max-w-6xl space-y-4">
      <PageHeader
        title="お知らせ一覧"
        loadedAt={q.dataUpdatedAt ? new Date(q.dataUpdatedAt) : null}
        onReload={reload}
        reloading={q.isFetching}
        actions={
          writable ? (
            <Button onClick={() => setForm({ type: 'new' })} disabled={!data}>
              <Plus aria-hidden />
              お知らせを書く
            </Button>
          ) : undefined
        }
      />
      {soumu && status === 'closed' ? <ReadOnlyNotice>{CLOSED_NOTICE}</ReadOnlyNotice> : null}
      <QueryState query={q}>
        {(d) => (
          <NoticesBody
            data={d}
            soumu={soumu}
            writable={writable}
            actor={actor}
            filter={filter}
            onFilter={setFilter}
            highlightId={highlightId}
            onEdit={(n) => setForm({ type: 'edit', notice: n })}
            onDelete={(n) => {
              setDeleteError(null);
              setDeleting(n);
            }}
          />
        )}
      </QueryState>
      {data && userId ? (
        <NoticeFormDialog
          target={form}
          onClose={() => setForm(null)}
          yearId={yearId}
          userId={userId}
          role={role}
          writable={writable}
          groups={data.groups}
          notices={data.notices}
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
        description="宛先の人もこのお知らせを読めなくなります。元に戻せません。"
        confirmLabel="削除する"
        pendingLabel="削除しています…"
        destructive
        onConfirm={confirmDelete}
      >
        {deleteError ? (
          <p role="alert" data-testid="notice-delete-error" className="rounded-md border border-destructive/40 bg-destructive/5 px-3 py-2 text-sm text-destructive">
            {deleteError}
          </p>
        ) : null}
      </ConfirmDialog>
    </div>
  );
}

function NoticesBody({
  data,
  soumu,
  writable,
  actor,
  filter,
  onFilter,
  highlightId,
  onEdit,
  onDelete,
}: {
  data: NoticesData;
  soumu: boolean;
  writable: boolean;
  actor: { role: AppRole | null; status: YearStatus; userId: string | null };
  filter: NoticeAudience | null;
  onFilter: (v: NoticeAudience | null) => void;
  highlightId: string | null;
  onEdit: (n: NoticeRow) => void;
  onDelete: (n: NoticeRow) => void;
}) {
  const counts = useMemo(() => {
    const c: Record<NoticeAudience, number> = { soumu: 0, all_groups: 0, groups: 0 };
    for (const n of data.notices) c[n.audience] += 1;
    return c;
  }, [data.notices]);
  const shown = filter ? data.notices.filter((n) => n.audience === filter) : data.notices;
  return (
    <div className="space-y-3">
      {soumu ? (
        <ToggleGroup
          type="single"
          variant="outline"
          size="sm"
          spacing={2}
          value={filter ?? 'all'}
          onValueChange={(v) => {
            if (v) onFilter(v === 'all' ? null : (v as NoticeAudience));
          }}
          aria-label="宛先で絞り込む"
          data-testid="notices-filter"
          className="flex-wrap"
        >
          <ToggleGroupItem value="all" className="data-[state=on]:bg-primary data-[state=on]:text-primary-foreground">
            すべて（{data.notices.length}）
          </ToggleGroupItem>
          {NOTICE_AUDIENCES.map((a) => (
            <ToggleGroupItem key={a} value={a} className="data-[state=on]:bg-primary data-[state=on]:text-primary-foreground">
              {NOTICE_AUDIENCE_LABELS[a]}（{counts[a]}）
            </ToggleGroupItem>
          ))}
        </ToggleGroup>
      ) : null}
      {data.notices.length === 0 ? (
        <div data-testid="notices-empty">
          <EmptyState title="お知らせはまだありません" description={writable ? '「お知らせを書く」から出せます。' : undefined} />
        </div>
      ) : shown.length === 0 ? (
        <div data-testid="notices-empty">
          <EmptyState title="この宛先のお知らせはありません" />
        </div>
      ) : (
        <NoticeList
          notices={shown}
          groups={data.groups}
          authors={data.authors}
          showAuthors={soumu}
          actor={actor}
          highlightId={highlightId}
          onEdit={onEdit}
          onDelete={onDelete}
        />
      )}
    </div>
  );
}
