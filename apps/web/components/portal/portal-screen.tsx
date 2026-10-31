'use client';

// ダッシュボード /（総務アプリのトップ。04「ダッシュボード」、D-51・D-52、notes/T16.md「固めた約束」2・5。T16）。
// 並び：立場の一覧（home-year・home-roles）→ 見出し（総務は「ダッシュボード」、ほかは「ホーム」。今の年度と状態は立場の一覧に
// あるので、見出しの横に出さない）→ 要対応と締切と予定
// （広い PC〔lg 以上〕は横に 3:2、それより狭ければ縦）→ 代表する団体（店長・副店長を務める人）→ 機能ごとの状況（総務・閲覧のみ）。
//   総務（soumu）：要対応・締切と予定・機能ごとのカード（店長・副店長も務める管理者は代表する団体も）
//   閲覧のみ（viewer）：締切と予定・機能ごとのカード（読み取り）（店長・副店長も務める人は要対応と代表する団体も）
//   店長・副店長（rep）：要対応・締切と予定・代表する団体
// 欄ごとに別々に読み（components/portal/use-portal.ts。機能の読み取りは、その結果を使う欄〔query.widgets〕にだけ並べる）、欄ごとに
// 読み込み中・失敗ともう一度・エラーの境界を持つ（1つの機能・1つの欄の失敗でほかを止めない。机椅子の読み込み中・失敗は要対応と
// カードの欄にだけ出し、年度の行だけで決まる締切と予定の欄には出さない）。年度の行は立場と一緒に読んだキャッシュ（useYearRow。
// D-45）を使い、年度の行だけで決まる項目はほかの読み込みを待たずに出す。版・振り分けの行・検証・スナップショットは読まず、それらを
// 読む部品（components/dashboard/dashboard.tsx など）を import しない（団体代表・閲覧のみの / を軽くする。D-51）。/ の欄が読むものは、
// 開いたときに立場と同時に読み始める（lib/data/screen-queries.ts の planHomePrefetch。D-45）。
import { useQueryClient } from '@tanstack/react-query';
import { useMemo, useState } from 'react';
import { PageHeader } from '@/components/common/page-header';
import { RepHome } from '@/components/dashboard/rep-home';
import { RoleSummary } from '@/components/dashboard/role-summary';
import { useAuth } from '@/lib/auth/auth-provider';
import type { Membership } from '@/lib/auth/membership';
import { useYearRow } from '@/lib/data/year';
import { portalContextsOf, portalKindsOf } from '@/lib/modules/portal';
import { furnitureRepOptions } from '@/lib/modules/furniture/rep';
import { cn } from '@/lib/utils';
import { DatedList } from './dated-list';
import { ModuleCards } from './module-cards';
import { TodoList } from './todo-list';
import { showsWidget, useRefetchWidget } from './use-portal';
import { PortalWidget, type YearGate } from './widget';
import { WidgetBoundary } from './widget-boundary';

export function PortalScreen() {
  const { membership } = useAuth();
  if (membership.status !== 'ready') return null; // AppShell が読み込み中・未招待を出す
  const m = membership.membership;
  if (!m.year) return null;
  return <Portal membership={m} yearId={m.year.id} />;
}

function Portal({ membership: m, yearId }: { membership: Membership; yearId: string }) {
  const queryClient = useQueryClient();
  const year = useYearRow(yearId);
  // 画面を開いた時刻（描画のたびに時計を読まない。要対応・締切と予定・代表する団体が同じ時刻で決める）
  const [now] = useState(() => Date.now());
  const ctxs = useMemo(() => (year.data ? portalContextsOf(m, year.data, now) : []), [m, year.data, now]);
  const kinds = portalKindsOf(m);
  const soumu = kinds.includes('soumu');
  const showTodos = showsWidget(kinds, 'todos');
  const showCards = showsWidget(kinds, 'cards');
  const showGroups = m.groups.length > 0;

  const gate: YearGate = year.data
    ? { status: 'ready' }
    : year.isError
      ? { status: 'error', error: year.error, retry: () => void year.refetch() }
      : { status: 'loading' };
  // エラーの境界の「もう一度」：その欄の query を読み直す（年度の行がなければ年度の行も）
  const refetchYear = () => {
    if (!year.data) void year.refetch();
  };
  const refetchTodos = useRefetchWidget(ctxs, 'todos');
  const refetchDated = useRefetchWidget(ctxs, 'dated');
  const refetchCards = useRefetchWidget(ctxs, 'cards');
  const refetchGroups = () => {
    void queryClient.refetchQueries({ queryKey: furnitureRepOptions(yearId, m.groups.map((g) => g.id)).queryKey, exact: true });
    refetchYear();
  };

  return (
    // 日本語は文節で折り返す（word-break: auto-phrase は受け継がれるので、立場の一覧・要対応・締切と予定・カードの文が単語の途中で
    // 折れない。<html lang="ja">。対応しないブラウザは今までどおり。レビューの T16-UX-12）
    <div className="mx-auto max-w-6xl space-y-4 [word-break:auto-phrase]">
      <RoleSummary membership={m} />
      {/* 最後に読み込んだ日時と「読み直す」は出さない（04「ダッシュボード」の読むもの。ほかの画面から戻ったときに、既定の staleTime
          〔30 秒〕より前に読んだものを読み直す。portal.test.tsx で確かめる） */}
      <PageHeader title={soumu ? 'ダッシュボード' : 'ホーム'} showYear={false} />
      {/* 要対応と締切と予定は、広い PC（lg 以上）で横に 3:2（要対応を広く）。md では左のナビの分だけ狭く、締切と予定が 130px ほどに
          なるので縦に。2:1 では幅 1280px でも締切と予定の文が 130px ほどで折り返したので 3:2 にした（T16 の段 8 のスクリーンショット） */}
      <div className={cn('grid gap-4', showTodos && 'lg:grid-cols-5')}>
        {showTodos ? (
          <PortalWidget title="要対応" testId="portal-todos" className="lg:col-span-3">
            <WidgetBoundary
              onRetry={() => {
                refetchTodos();
                refetchYear();
              }}
            >
              <TodoList ctxs={ctxs} gate={gate} now={now} />
            </WidgetBoundary>
          </PortalWidget>
        ) : null}
        <PortalWidget title="締切と予定" testId="portal-dated" className={showTodos ? 'lg:col-span-2' : undefined}>
          <WidgetBoundary
            onRetry={() => {
              refetchDated();
              refetchYear();
            }}
          >
            <DatedList ctxs={ctxs} gate={gate} now={now} />
          </WidgetBoundary>
        </PortalWidget>
      </div>
      {showGroups ? (
        <PortalWidget title="代表する団体" framed={false}>
          <WidgetBoundary onRetry={refetchGroups}>
            <RepHome yearId={yearId} groups={m.groups} now={now} />
          </WidgetBoundary>
        </PortalWidget>
      ) : null}
      {showCards ? (
        <PortalWidget title="機能ごとの状況" testId="portal-cards" framed={false}>
          <WidgetBoundary
            onRetry={() => {
              refetchCards();
              refetchYear();
            }}
          >
            <ModuleCards ctxs={ctxs} gate={gate} />
          </WidgetBoundary>
        </PortalWidget>
      ) : null}
    </div>
  );
}
