'use client';

// 総務（admin・staff）のダッシュボード（画面の設計 3.1・6。T09）。版を先に読むスナップショット → useValidation → summarizeDashboard。
// 状態の遷移と確定の流れは T09a の YearStatusActions（admin にだけ出る）。版の見張りで、ほかの人の変更に気づいたら帯を出す。
import { AlertTriangle } from 'lucide-react';
import { useMemo, useState } from 'react';
import { toast } from 'sonner';
import { AppLink } from '@/components/common/app-link';
import { ErrorBanner } from '@/components/common/error-banner';
import { PageHeader } from '@/components/common/page-header';
import { StaleBanner } from '@/components/common/stale-banner';
import { TokyoTime } from '@/components/common/tokyo-time';
import { YearStatusActions } from '@/components/common/year-status-actions';
import { YearStatusBadge } from '@/components/common/year-status-badge';
import { ErrorState } from '@/components/states';
import { Button } from '@/components/ui/button';
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card';
import { Skeleton } from '@/components/ui/skeleton';
import { useAuthErrorHandler } from '@/lib/auth/guarded';
import type { Audience } from '@/lib/auth/membership';
import { summarizeDashboard, type DashboardSummary } from '@/lib/data/dashboard';
import { downloadAllocationXlsx, ExportBlockedError } from '@/lib/data/export';
import { useSnapshot, type Snapshot } from '@/lib/data/snapshot';
import { useValidation } from '@/lib/data/validation';
import { useVersionWatch } from '@/lib/data/version-watch';
import { brokenRulesNotice, downloadYearJson } from '@/lib/data/year-export';
import { classifyError, messageFor, type NameLookup } from '@/lib/errors';
import { CONSENT_STATUS_LABELS } from '@/lib/labels';
import { cn } from '@/lib/utils';

function namesOf(s: Snapshot): NameLookup {
  const rooms = new Map(s.rooms.map((r) => [r.id, r.name]));
  const items = new Map(s.items.map((i) => [i.id, i.name]));
  const groups = new Map(s.groups.map((g) => [g.id, g.name]));
  return { room: (id) => rooms.get(id), item: (id) => items.get(id), group: (id) => groups.get(id) };
}

export function Dashboard({ yearId, audiences }: { yearId: string; audiences: readonly Audience[] }) {
  const snap = useSnapshot(yearId, 'full');
  const v = useValidation(snap.data);
  const { stale } = useVersionWatch(yearId, snap.data?.version ?? null, { paused: snap.isFetching });
  const summary = useMemo(() => (snap.data ? summarizeDashboard(snap.data, v, { audiences }) : null), [snap.data, v, audiences]);
  const names = useMemo(() => (snap.data ? namesOf(snap.data) : undefined), [snap.data]);

  const header = (
    <PageHeader
      title="ダッシュボード"
      loadedAt={snap.data?.loadedAt ?? null}
      onReload={() => void snap.refetch()}
      reloading={snap.isFetching}
    />
  );

  if (snap.isError && !snap.data) {
    return (
      <>
        {header}
        <ErrorState message={messageFor(classifyError(snap.error))} onRetry={() => void snap.refetch()} />
      </>
    );
  }
  if (!snap.data || !summary) {
    return (
      <>
        {header}
        <DashboardSkeleton />
      </>
    );
  }
  const s = snap.data;
  return (
    <div className="space-y-4">
      {header}
      {/* データがあるときの読み直し（読み直す・帯の読み直す・状態の遷移の後）の失敗は、中身を残して帯で知らせる */}
      {snap.isError ? (
        <div data-testid="dashboard-reload-error">
          <ErrorBanner error={snap.error} onRetry={() => void snap.refetch()} />
        </div>
      ) : null}
      {stale ? <StaleBanner onReload={() => void snap.refetch()} reloading={snap.isFetching} /> : null}
      <YearCard snapshot={s} summary={summary} validation={v} stale={stale} names={names} onReload={() => snap.refetch()} />
      {summary.problems.length > 0 ? <ProblemsCard summary={summary} /> : null}
      <div className="grid gap-4 md:grid-cols-2">
        <SubmissionsCard summary={summary} />
        <StocksCard summary={summary} />
        <ValidationCard summary={summary} />
        <ConsentsCard summary={summary} />
      </div>
    </div>
  );
}

function DashboardSkeleton() {
  return (
    <div className="space-y-4" data-testid="dashboard-loading" role="status" aria-label="読み込み中">
      <Skeleton className="h-36 w-full" />
      <div className="grid gap-4 md:grid-cols-2">
        {[0, 1, 2, 3].map((k) => (
          <Skeleton key={k} className="h-44 w-full" />
        ))}
      </div>
    </div>
  );
}

function Stat({ value, total, unit }: { value: number; total?: number; unit: string }) {
  return (
    <p className="text-3xl font-bold tabular-nums">
      {value}
      {total !== undefined ? <span className="text-lg font-normal text-muted-foreground"> ／ {total}</span> : null}
      <span className="ml-1 text-sm font-normal text-muted-foreground">{unit}</span>
    </p>
  );
}

function YearCard({
  snapshot,
  summary,
  validation,
  stale,
  names,
  onReload,
}: {
  snapshot: Snapshot;
  summary: DashboardSummary;
  validation: ReturnType<typeof useValidation>;
  stale: boolean;
  names: NameLookup | undefined;
  onReload: () => unknown;
}) {
  return (
    <Card data-testid="dashboard-year">
      <CardHeader>
        <CardTitle className="flex flex-wrap items-center gap-2">
          {snapshot.year.label}
          <YearStatusBadge status={summary.status} />
        </CardTitle>
      </CardHeader>
      <CardContent className="space-y-4">
        <dl className="grid gap-x-6 gap-y-1 text-sm sm:grid-cols-[auto_1fr]">
          <dt className="text-muted-foreground">1日目</dt>
          <dd>
            <TokyoTime value={snapshot.year.festival_start} format="date" />
          </dd>
          <dt className="text-muted-foreground">受付期間</dt>
          <dd data-testid="dashboard-request-window">
            <TokyoTime value={summary.requestOpenAt} empty="（開始は決めていない）" /> 〜 <TokyoTime value={summary.requestCloseAt} empty="（締切は未定）" />
          </dd>
          <dt className="text-muted-foreground">最後の自動振り分け</dt>
          <dd>
            <TokyoTime value={summary.autoAllocatedAt} empty="まだ実行していません" />
          </dd>
        </dl>
        <YearStatusActions
          year={snapshot.year}
          snapshotVersion={snapshot.version}
          validation={validation}
          stale={stale}
          onReloadSnapshot={onReload}
          names={names}
          closeExtras={<CloseExports snapshot={snapshot} />}
        />
      </CardContent>
    </Card>
  );
}

/** 「終了」の確認に並べる書き出しのボタン */
function CloseExports({ snapshot }: { snapshot: Snapshot }) {
  const [busy, setBusy] = useState<'json' | 'xlsx' | null>(null);
  const onAuthError = useAuthErrorHandler();
  const fail = async (e: unknown) => {
    if (e instanceof ExportBlockedError) {
      toast.error(e.message);
      return;
    }
    if ((await onAuthError(e)) !== 'other') return;
    toast.error(messageFor(classifyError(e)));
  };
  const run = async (kind: 'json' | 'xlsx') => {
    setBusy(kind);
    try {
      if (kind === 'json') {
        const r = await downloadYearJson(snapshot.year.id);
        toast.success(`${r.fileName} を保存しました`);
        const broken = brokenRulesNotice(r.brokenRuleCodes);
        if (broken) toast.warning(broken, { duration: 15000 });
      } else {
        const { fileName } = await downloadAllocationXlsx(snapshot);
        toast.success(`${fileName} を保存しました`);
      }
    } catch (e) {
      await fail(e);
    } finally {
      setBusy(null);
    }
  };
  return (
    <>
      <Button type="button" variant="outline" size="sm" disabled={busy !== null} onClick={() => void run('json')} data-testid="close-export-json">
        {busy === 'json' ? '書き出し中…' : '年度データを書き出す'}
      </Button>
      <Button type="button" variant="outline" size="sm" disabled={busy !== null} onClick={() => void run('xlsx')} data-testid="close-export-xlsx">
        {busy === 'xlsx' ? '書き出し中…' : '振り分け表を書き出す'}
      </Button>
    </>
  );
}

function ProblemsCard({ summary }: { summary: DashboardSummary }) {
  return (
    <Card data-testid="dashboard-problems" className="border-destructive/40">
      <CardHeader>
        <CardTitle className="flex items-center gap-2 text-destructive">
          <AlertTriangle aria-hidden className="size-5" />
          入力の誤りが {summary.problems.length} 件あります
        </CardTitle>
        <CardDescription>直すまで確定できません。ルールの設定やマスタ設定を確かめてください。</CardDescription>
      </CardHeader>
      <CardContent>
        <ul className="list-inside list-disc space-y-1 text-sm">
          {summary.problems.map((p, k) => (
            <li key={k}>
              {p.ruleCode ? (
                <>
                  {p.href ? (
                    <AppLink href={p.href} className="font-mono underline">
                      {p.ruleCode}
                    </AppLink>
                  ) : (
                    <span className="font-mono">{p.ruleCode}</span>
                  )}
                  ：
                </>
              ) : null}
              {p.message}
              {!p.ruleCode && p.href ? (
                <AppLink href={p.href} className="ml-2 underline">
                  マスタ設定へ
                </AppLink>
              ) : null}
            </li>
          ))}
        </ul>
      </CardContent>
    </Card>
  );
}

function SubmissionsCard({ summary }: { summary: DashboardSummary }) {
  const sub = summary.submissions;
  return (
    <Card data-testid="dashboard-submissions">
      <CardHeader>
        <CardTitle>申請</CardTitle>
        <CardDescription>提出した団体／団体の数</CardDescription>
      </CardHeader>
      <CardContent className="space-y-3 text-sm">
        <Stat value={sub.submitted} total={sub.total} unit="団体" />
        {sub.byCategory.length > 0 ? (
          <ul className="flex flex-wrap gap-x-4 gap-y-1 text-muted-foreground" data-testid="dashboard-submissions-by-category">
            {sub.byCategory.map((c) => (
              <li key={c.category}>
                {c.label} {c.submitted}／{c.total}
              </li>
            ))}
          </ul>
        ) : (
          <p className="text-muted-foreground">
            団体がありません。
            {sub.emptyHref ? (
              <AppLink href={sub.emptyHref} className="ml-1 underline">
                マスタ設定の団体へ
              </AppLink>
            ) : null}
          </p>
        )}
        {sub.unsubmittedCount > 0 ? (
          <div data-testid="dashboard-unsubmitted">
            <p className="font-medium">未提出 {sub.unsubmittedCount} 団体</p>
            <p className="text-muted-foreground">
              {sub.unsubmitted.map((g) => g.name).join('、')}
              {sub.unsubmittedCount > sub.unsubmitted.length ? ' ほか' : ''}
            </p>
            {sub.unsubmittedHref ? (
              <AppLink href={sub.unsubmittedHref} className="underline">
                未提出の団体を申請一覧で見る
              </AppLink>
            ) : null}
          </div>
        ) : sub.total > 0 ? (
          <p className="text-emerald-800">すべての団体が提出しました</p>
        ) : null}
      </CardContent>
    </Card>
  );
}

function StocksCard({ summary }: { summary: DashboardSummary }) {
  const st = summary.stocks;
  return (
    <Card data-testid="dashboard-stocks">
      <CardHeader>
        <CardTitle>在庫</CardTitle>
        <CardDescription>在庫を数えた保管場所／保管場所の数（使用不可の部屋を除く）</CardDescription>
      </CardHeader>
      <CardContent className="space-y-3 text-sm">
        <Stat value={st.counted} total={st.total} unit="か所" />
        {st.total === 0 ? (
          <p className="text-muted-foreground">
            保管場所がありません。
            {st.emptyHref ? (
              <AppLink href={st.emptyHref} className="ml-1 underline">
                マスタ設定の場所へ
              </AppLink>
            ) : null}
          </p>
        ) : st.uncountedCount > 0 ? (
          <div data-testid="dashboard-uncounted">
            <p className="font-medium">まだ数えていない場所 {st.uncountedCount} か所</p>
            <ul className="mt-1 flex flex-wrap gap-x-3 gap-y-1">
              {st.uncounted.map((r) => (
                <li key={r.id}>
                  {r.href ? (
                    <AppLink href={r.href} className="underline">
                      {r.name}
                    </AppLink>
                  ) : (
                    r.name
                  )}
                </li>
              ))}
              {st.uncountedCount > st.uncounted.length ? <li className="text-muted-foreground">ほか</li> : null}
            </ul>
          </div>
        ) : (
          <p className="text-emerald-800">すべての保管場所を数えました</p>
        )}
      </CardContent>
    </Card>
  );
}

function ValidationCard({ summary }: { summary: DashboardSummary }) {
  const v = summary.validation;
  return (
    <Card data-testid="dashboard-validation">
      <CardHeader>
        <CardTitle>検証</CardTitle>
        <CardDescription>振り分けの error・warning・info</CardDescription>
      </CardHeader>
      <CardContent className="space-y-3 text-sm">
        {v.phase === 'before' ? (
          <p className="text-muted-foreground">振り分け前（検証は振り分け中から）</p>
        ) : v.phase === 'closed' ? (
          <p className="text-muted-foreground">終了した年度です（検証は振り分け中と確定中だけ）</p>
        ) : v.phase === 'unavailable' ? (
          <p className="font-medium text-destructive">検証できません（入力の誤りを直してください）</p>
        ) : (
          <>
            <div className="flex flex-wrap gap-4" data-testid="dashboard-validation-counts">
              <Count label="error" n={v.errors} tone={v.errors > 0 ? 'text-destructive' : undefined} />
              <Count label="warning" n={v.warnings} tone={v.warnings > 0 ? 'text-amber-800' : undefined} />
              <Count label="info" n={v.infos} />
            </div>
            {v.topCodes.length > 0 ? (
              <p className="text-muted-foreground" data-testid="dashboard-top-codes">
                多いもの：{v.topCodes.map((c) => `${c.code} ${c.count}件`).join('、')}
              </p>
            ) : (
              <p className="text-emerald-800">問題は見つかりませんでした</p>
            )}
          </>
        )}
        {v.href && v.phase !== 'before' ? (
          <AppLink href={v.href} className="underline">
            振り分け画面へ
          </AppLink>
        ) : null}
      </CardContent>
    </Card>
  );
}

function Count({ label, n, tone }: { label: string; n: number; tone?: string | undefined }) {
  return (
    <p className={cn('tabular-nums', tone)}>
      <span className="text-2xl font-bold">{n}</span>
      <span className="ml-1 text-xs">{label}</span>
    </p>
  );
}

function ConsentsCard({ summary }: { summary: DashboardSummary }) {
  const c = summary.consents;
  const rows: [string, number][] = [
    [CONSENT_STATUS_LABELS.not_asked, c.notAsked],
    [CONSENT_STATUS_LABELS.asked, c.asked],
    [CONSENT_STATUS_LABELS.accepted, c.accepted],
    [CONSENT_STATUS_LABELS.declined, c.declined],
  ];
  return (
    <Card data-testid="dashboard-consents">
      <CardHeader>
        <CardTitle>キャスター机交換の了承</CardTitle>
        <CardDescription>了承が要る置き換えがある団体の数</CardDescription>
      </CardHeader>
      <CardContent className="space-y-3 text-sm">
        <Stat value={c.groups} unit="団体" />
        {c.groups > 0 ? (
          <>
            <ul className="flex flex-wrap gap-x-4 gap-y-1" data-testid="dashboard-consent-statuses">
              {rows.map(([label, n]) => (
                <li key={label}>
                  {label} {n}
                </li>
              ))}
            </ul>
            {c.reask > 0 ? <p className="text-amber-800">依頼し直しが要る団体 {c.reask}</p> : null}
            {c.rerun > 0 ? <p className="text-destructive">拒否されたので最小変更での再実行が要る団体 {c.rerun}</p> : null}
          </>
        ) : (
          <p className="text-muted-foreground">了承が要る置き換えはありません</p>
        )}
        {c.href ? (
          <AppLink href={c.href} className="underline">
            キャスター机交換へ
          </AppLink>
        ) : null}
      </CardContent>
    </Card>
  );
}
