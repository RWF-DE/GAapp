'use client';

// 受け渡し・返却（/lending/records。スマホ。04「テント等の貸し出し」の「受け渡し・返却」、notes/T21.md「画面の約束」5。T21・D-57）。
// - 開ける人は総務（部門員を含む。ページの守りは RequireAudience）。読むものは lendingRecordsOptions（備品・団体・割り当て・記録・
//   確定の印を並行に。版を使わないので、開いたときの先読み・記録・先送りの許可リストに入る）。
// - 確定の前でも記録できる（帯「割り当ては確定前です（数は変わることがあります）」）。終了した年度は帯を出し、入力と保存を出さない。
// - 一覧（records-list.tsx）と、団体を押すと `?group=<id>` で団体の欄（records-panel.tsx）。知らない id なら一覧のまま。
// - 「印刷」で印刷用の表（records-print.tsx。画面では隠す）を印刷する。
import { useQuery } from '@tanstack/react-query';
import { Printer } from 'lucide-react';
import { useSearchParams } from 'next/navigation';
import { useState } from 'react';
import { ErrorBanner } from '@/components/common/error-banner';
import { LatestYearSwitch } from '@/components/common/latest-year';
import { PageHeader } from '@/components/common/page-header';
import { QueryState } from '@/components/states';
import { Button } from '@/components/ui/button';
import { useAuth } from '@/lib/auth/auth-provider';
import type { Membership } from '@/lib/auth/membership';
import { isSoumu } from '@/lib/auth/roles';
import { useYearRow } from '@/lib/data/year';
import { LENDING_CLOSED_TEXT, type RecordState } from '@/lib/modules/lending/labels';
import { lendingRecordsOptions } from '@/lib/modules/lending/queries';
import { useGuardedRouter } from '@/lib/navigation/guarded-router';
import { LendingNotice } from './common';
import { parseRecordsFilter, RecordsList } from './records-list';
import { RecordsPanel } from './records-panel';
import { RecordsPrint } from './records-print';

/** 確定前の帯 */
export const RECORDS_BEFORE_CONFIRM = '割り当ては確定前です（数は変わることがあります）';

/** `/lending/records` の URL（団体・状態のチップ） */
export function recordsHref(groupId: string | null, filter: RecordState | null): string {
  const q = new URLSearchParams();
  if (groupId) q.set('group', groupId);
  if (filter) q.set('filter', filter);
  const s = q.toString();
  return s ? `/lending/records?${s}` : '/lending/records';
}

export function LendingRecordsScreen() {
  const { membership, session } = useAuth();
  if (membership.status !== 'ready') return null; // AppShell が読み込み中・未招待を出す
  const m = membership.membership;
  if (!m.year) return null;
  const userId = session.status === 'signedIn' ? session.session.user.id : null;
  return <RecordsBoard key={m.year.id} membership={m} yearId={m.year.id} userId={userId} />;
}

function RecordsBoard({ membership: m, yearId, userId }: { membership: Membership; yearId: string; userId: string | null }) {
  const { reloadMembership } = useAuth();
  const router = useGuardedRouter();
  const params = useSearchParams();
  const yearQ = useYearRow(yearId);
  const q = useQuery(lendingRecordsOptions(yearId));
  // 画面を開いた時刻（状態の「未返却」は2日目から）。「読み直す」で押した時刻にする
  const [now, setNow] = useState(() => Date.now());
  const year = yearQ.data;
  const status = year?.status ?? m.year?.status ?? null;
  const closed = status === 'closed';
  const writable = isSoumu(m.role) && !closed && !!userId;
  const filter = parseRecordsFilter(params.get('filter'));
  const groupParam = params.get('group');

  const reload = () => {
    setNow(Date.now());
    void q.refetch();
    void yearQ.refetch();
  };
  const reloadYear = () => {
    reloadMembership();
    void yearQ.refetch();
  };

  return (
    // 画面はスマホの幅（max-w-xl）、印刷は A4 の幅いっぱい（印刷用の表の列を詰めない。撮影で見つけた）
    <div className="mx-auto max-w-xl space-y-3 pb-4 print:max-w-none">
      <div className="space-y-3 print:hidden">
        <LatestYearSwitch />
        <PageHeader
          title="受け渡し・返却"
          loadedAt={q.dataUpdatedAt ? new Date(q.dataUpdatedAt) : null}
          onReload={reload}
          reloading={q.isFetching || yearQ.isFetching}
          actions={
            <Button variant="outline" data-testid="records-print" onClick={() => window.print()} disabled={!q.data}>
              <Printer aria-hidden />
              印刷
            </Button>
          }
        />
        {closed ? <LendingNotice testId="lending-readonly">{LENDING_CLOSED_TEXT}</LendingNotice> : null}
        {q.data && !q.data.confirmedAt ? (
          <LendingNotice testId="records-before-confirm" tone="warn">
            {RECORDS_BEFORE_CONFIRM}
          </LendingNotice>
        ) : null}
        {yearQ.isError && !yearQ.data ? <ErrorBanner error={yearQ.error} onRetry={() => void yearQ.refetch()} /> : null}
      </div>
      <QueryState query={q}>
        {(d) => {
          const group = groupParam ? d.groups.find((g) => g.id === groupParam) : undefined;
          return (
            <>
              <div className="print:hidden">
                {group && year && userId ? (
                  <RecordsPanel
                    key={group.id}
                    data={d}
                    group={group}
                    year={year}
                    userId={userId}
                    writable={writable}
                    onBack={() => void router.push(recordsHref(null, filter))}
                    onReloadMembership={reloadYear}
                  />
                ) : (
                  <RecordsList
                    data={d}
                    year={year ?? { festival_start: m.year?.festival_start ?? '' }}
                    now={now}
                    filter={filter}
                    onFilter={(next) => router.forceReplace(recordsHref(null, next))}
                    onOpen={(id) => void router.push(recordsHref(id, filter))}
                  />
                )}
              </div>
              <RecordsPrint data={d} yearLabel={m.year?.label ?? ''} />
            </>
          );
        }}
      </QueryState>
    </div>
  );
}
