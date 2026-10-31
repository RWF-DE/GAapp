'use client';

// 履歴 /history（画面の設計 3.12、04「履歴」。T14）。部門長以上（年度のない記録は開いている年度の管理者だけ。RLS。T15b）。PC。
// - 絞り込み（表〔複数〕・団体・期間・した人）は URL のクエリ（table・group・from・to・user）に入れる。合わない値は無視する。
// - 表：日時・操作・表・対象・変更（diffAudit）・理由・した人。at desc・id desc で 50 件ずつ、「さらに読み込む」で続き。件数は数えない。
import { useSearchParams } from 'next/navigation';
import { useEffect, useMemo, useRef } from 'react';
import { PageHeader } from '@/components/common/page-header';
import { ErrorBanner } from '@/components/common/error-banner';
import { TokyoTime } from '@/components/common/tokyo-time';
import { EmptyState, ErrorState, LoadingState } from '@/components/states';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { useAuth } from '@/lib/auth/auth-provider';
import {
  actionLabel,
  actorLabel,
  auditTarget,
  diffAudit,
  EMPTY_FILTER,
  formatDiffEntry,
  hasFilter,
  historyHref,
  parseHistoryParams,
  tableLabel,
  useHistoryNames,
  useHistoryOptions,
  useHistoryPages,
  type AuditLogRow,
  type HistoryFilter,
  type HistoryLookups,
} from '@/lib/data/history';
import { classifyError, messageFor } from '@/lib/errors';
import { useGuardedRouter } from '@/lib/navigation/guarded-router';
import { HistoryFilters } from './history-filters';

export function HistoryScreen() {
  const { membership } = useAuth();
  const m = membership.status === 'ready' ? membership.membership : null;
  if (!m?.year) return <LoadingState />;
  return <HistoryBody key={m.year.id} yearId={m.year.id} yearLabel={m.year.label} adminOfOpenYear={m.adminOfOpenYear} />;
}

const ACTION_VARIANT: Record<string, 'default' | 'secondary' | 'outline' | 'destructive'> = {
  insert: 'secondary',
  update: 'outline',
  delete: 'destructive',
};

function HistoryBody({ yearId, yearLabel, adminOfOpenYear }: { yearId: string; yearLabel: string; adminOfOpenYear: boolean }) {
  const params = useSearchParams();
  const filter = useMemo(() => parseHistoryParams(params), [params]);
  const router = useGuardedRouter();
  const optionsQ = useHistoryOptions(yearId);
  const pagesQ = useHistoryPages(yearId, filter);
  const rows = useMemo(() => pagesQ.data?.pages.flatMap((p) => p.rows) ?? [], [pagesQ.data]);
  const namesQ = useHistoryNames(yearId, rows, optionsQ.data);

  const o = optionsQ.data;
  const n = namesQ.data;
  const lookups: HistoryLookups = useMemo(() => {
    const groups = new Map(o?.groups.map((g) => [g.id, g.name]) ?? []);
    for (const [id, name] of n?.groups ?? []) if (!groups.has(id)) groups.set(id, name);
    const users = new Map<string, string>();
    for (const mem of o?.members ?? []) if (mem.displayName !== null) users.set(mem.userId, mem.displayName);
    for (const [id, name] of n?.users ?? []) users.set(id, name);
    return { groups, rooms: o?.rooms ?? new Map(), items: o?.items ?? new Map(), users, years: new Map([[yearId, yearLabel]]) };
  }, [o, n, yearId, yearLabel]);

  // URL の反映（router.replace）は少し遅れて届くので、続けて変えたとき（始めと終わりの日付を続けて入れるなど）に前の変更を
  // 落とさないよう、最後に送った絞り込みを持ち、次の変更はそこから作る。URL が変わったら（戻る・リンク）それに合わせる
  const latest = useRef(filter);
  useEffect(() => {
    latest.current = filter;
  }, [filter]);
  const changeFilter = (update: (f: HistoryFilter) => HistoryFilter) => {
    const next = update(latest.current);
    latest.current = next;
    void router.replace(historyHref(next), { scroll: false });
  };
  const reload = () => {
    void optionsQ.refetch();
    void pagesQ.refetch();
  };
  const loadedAt = pagesQ.dataUpdatedAt ? new Date(pagesQ.dataUpdatedAt) : null;

  const header = (
    <PageHeader
      title="履歴"
      description="変更の記録を新しい順に出します（50 件ずつ）。"
      loadedAt={loadedAt}
      onReload={reload}
      reloading={pagesQ.isFetching || optionsQ.isFetching}
    />
  );

  if (optionsQ.isError) {
    return (
      <>
        {header}
        <ErrorState message={messageFor(classifyError(optionsQ.error))} onRetry={reload} />
      </>
    );
  }
  if (!optionsQ.data) {
    return (
      <>
        {header}
        <LoadingState />
      </>
    );
  }

  return (
    <>
      {header}
      <HistoryFilters filter={filter} options={optionsQ.data} adminOfOpenYear={adminOfOpenYear} onChange={changeFilter} />
      {pagesQ.isPending ? (
        <LoadingState />
      ) : pagesQ.isError && rows.length === 0 ? (
        <ErrorState message={messageFor(classifyError(pagesQ.error))} onRetry={() => void pagesQ.refetch()} />
      ) : rows.length === 0 ? (
        <EmptyState
          title="この条件の変更はありません"
          description={hasFilter(filter) ? '絞り込みを変えるか、消してください。' : undefined}
          action={
            hasFilter(filter) ? (
              <Button variant="outline" size="sm" onClick={() => changeFilter(() => EMPTY_FILTER)}>
                絞り込みを消す
              </Button>
            ) : undefined
          }
        />
      ) : (
        <>
          <HistoryTable rows={rows} lookups={lookups} />
          {pagesQ.isFetchNextPageError ? (
            <ErrorBanner className="mt-3" error={pagesQ.error} onRetry={() => void pagesQ.fetchNextPage()} />
          ) : pagesQ.isRefetchError ? (
            <ErrorBanner className="mt-3" error={pagesQ.error} onRetry={() => void pagesQ.refetch()} />
          ) : null}
          <div className="mt-3 flex items-center gap-3 text-sm text-muted-foreground">
            <span data-testid="history-shown">{rows.length} 件を表示</span>
            {pagesQ.hasNextPage ? (
              <Button variant="outline" size="sm" disabled={pagesQ.isFetchingNextPage} onClick={() => void pagesQ.fetchNextPage()}>
                {pagesQ.isFetchingNextPage ? '読み込み中…' : 'さらに読み込む'}
              </Button>
            ) : (
              <span>これより前の変更はありません</span>
            )}
          </div>
        </>
      )}
    </>
  );
}

// 列の幅（PC 1280px〔中身の幅 約 1000px〕で全部の列が横にはみ出さずに見えるよう、table-fixed で幅を決める。T14 のレビュー）。
// 日時は日付と時刻の2行、した人・対象・変更・理由は折り返す（長い JSON や区切りのない文字列も wrap-anywhere で折る）。
// 狭い画面（スマホ）では列を潰さないよう表に最小の幅を付け、入れ物の中で横にスクロールする
function HistoryTable({ rows, lookups }: { rows: readonly AuditLogRow[]; lookups: HistoryLookups }) {
  return (
    <div className="max-h-[70vh] overflow-auto rounded-lg border" data-testid="history-table-scroll">
      <table className="w-full min-w-[52rem] table-fixed border-collapse text-sm" data-testid="history-table">
        <colgroup>
          <col className="w-[6.5rem]" />
          <col className="w-[4.5rem]" />
          <col className="w-[6.5rem]" />
          <col className="w-[16%]" />
          <col />
          <col className="w-[13%]" />
          <col className="w-[8rem]" />
        </colgroup>
        <thead className="sticky top-0 z-10 bg-background">
          <tr className="border-b text-left">
            <th scope="col" className="px-3 py-2 whitespace-nowrap">
              日時
            </th>
            <th scope="col" className="px-3 py-2 whitespace-nowrap">
              操作
            </th>
            <th scope="col" className="px-3 py-2 whitespace-nowrap">
              表
            </th>
            <th scope="col" className="px-3 py-2">
              対象
            </th>
            <th scope="col" className="px-3 py-2">
              変更
            </th>
            <th scope="col" className="px-3 py-2">
              理由
            </th>
            <th scope="col" className="px-3 py-2 whitespace-nowrap" data-testid="history-actor-header">
              した人
            </th>
          </tr>
        </thead>
        <tbody>
          {rows.map((r) => {
            const diff = diffAudit(r.before, r.after);
            return (
              <tr key={r.id} data-testid="history-row" data-row-id={r.id} data-table={r.table_name} className="border-b align-top">
                <td className="px-3 py-2 tabular-nums">
                  {/* 日付と時刻の2行（w-min で空白のところで折る） */}
                  <TokyoTime value={r.at} className="inline-block w-min" />
                </td>
                <td className="px-3 py-2">
                  <Badge variant={ACTION_VARIANT[r.action] ?? 'outline'}>{actionLabel(r.action)}</Badge>
                </td>
                <td className="px-3 py-2 wrap-anywhere">{tableLabel(r.table_name)}</td>
                <td className="px-3 py-2 wrap-anywhere" data-testid="history-target">
                  {auditTarget(r, lookups) || '—'}
                </td>
                <td className="px-3 py-2" data-testid="history-diff">
                  {diff.length === 0 ? (
                    <span className="text-muted-foreground">—</span>
                  ) : (
                    <ul className="space-y-0.5 wrap-anywhere">
                      {diff.map((d) => (
                        <li key={d.key}>{formatDiffEntry(r.table_name, d, lookups)}</li>
                      ))}
                    </ul>
                  )}
                </td>
                <td className="px-3 py-2 wrap-anywhere" data-testid="history-reason">
                  {r.reason ?? <span className="text-muted-foreground">—</span>}
                </td>
                <td className="px-3 py-2 wrap-anywhere" data-testid="history-actor">
                  <ActorName label={actorLabel(r.user_id, lookups.users)} />
                </td>
              </tr>
            );
          })}
        </tbody>
      </table>
    </div>
  );
}

/** した人の名前。かっこの部分（「（アプリの外）」など）は途中で折らず、折るときはかっこの前で次の行に送る */
function ActorName({ label }: { label: string }) {
  const i = label.indexOf('（');
  if (i <= 0) return <>{label}</>;
  return (
    <>
      {label.slice(0, i)}
      <span className="inline-block">{label.slice(i)}</span>
    </>
  );
}
