'use client';

// 自動振り分けの結果の表示（画面の設計 3.9 の手順5〜7。T13）。ok: false は reason ごとに見出しを変えたパネル、
// 保存したときは件数と計算の時間（data-testid="allocate-elapsed"。D-21 の確認）、保存されたか分からないときは「確かめる」。
import type { Issue } from '@gaapp/shared';
import { AlertTriangle, CheckCircle2, Info } from 'lucide-react';
import { AppLink } from '@/components/common/app-link';
import { ErrorBanner } from '@/components/common/error-banner';
import { Button } from '@/components/ui/button';
import { failureView, type FailureView } from '@/lib/allocation/failure-view';
import { ruleHref } from '@/lib/allocation/issue-target';
import type { ViewModel } from '@/lib/allocation/view-model';
import { namesOf } from '@/lib/allocation/view-model';
import { cn } from '@/lib/utils';
import { MODE_LABELS, type AutoOutcome } from './auto-run';

/** 計算の時間（秒。小数2桁） */
export const seconds = (ms: number) => (ms / 1000).toFixed(2);

function RuleLink({ code }: { code: string }) {
  // ルール画面を開けない立場（staff）には文字だけ（AppLink が canOpen で決める）
  return (
    <AppLink href={ruleHref(code)} className="underline underline-offset-2">
      ルール {code}
    </AppLink>
  );
}

/** ok: false のパネル（reason ごとの見出し）。precheck の項目は押すと該当の行・ルールへ */
export function FailurePanel({ view, onIssue }: { view: FailureView; onIssue?: (issue: Issue) => void }) {
  return (
    <section
      role="alert"
      aria-labelledby="allocate-failure-title"
      data-testid="allocate-failure"
      data-reason={view.reason}
      className="space-y-3 rounded-md border border-destructive/40 bg-destructive/5 p-4 text-sm"
    >
      <h2 id="allocate-failure-title" className="flex items-center gap-2 text-base font-bold text-destructive">
        <AlertTriangle aria-hidden className="size-4" />
        {view.title}
      </h2>
      {view.message ? <p>{view.message}</p> : null}
      {view.sections.map((s, k) => (
        <div key={k} className="space-y-1">
          {s.heading ? <h3 className="font-semibold">{s.heading}</h3> : null}
          <ul className="list-inside list-disc space-y-1">
            {s.lines.map((l, j) => (
              <li key={j}>
                {l.issue && onIssue ? (
                  <button type="button" className="text-left underline underline-offset-2" onClick={() => onIssue(l.issue!)}>
                    {l.text}
                  </button>
                ) : (
                  <span>{l.text}</span>
                )}
                {l.ruleCode ? (
                  <span className="ml-2">
                    （<RuleLink code={l.ruleCode} />）
                  </span>
                ) : null}
                {l.details && l.details.length > 0 ? (
                  <ul className="ml-6 list-[circle] space-y-0.5 text-muted-foreground">
                    {l.details.map((d, i) => (
                      <li key={i}>{d}</li>
                    ))}
                  </ul>
                ) : null}
              </li>
            ))}
          </ul>
        </div>
      ))}
      {view.footer ? <p className="font-medium">{view.footer}</p> : null}
    </section>
  );
}

function Notice({ tone, children, testId }: { tone: 'ok' | 'info' | 'warn'; children: React.ReactNode; testId?: string }) {
  const Icon = tone === 'ok' ? CheckCircle2 : tone === 'warn' ? AlertTriangle : Info;
  return (
    <div
      role="status"
      data-testid={testId}
      className={cn(
        'flex gap-2 rounded-md border px-4 py-2 text-sm',
        tone === 'ok' && 'border-emerald-300 bg-emerald-50 text-emerald-950',
        tone === 'info' && 'bg-muted/50',
        tone === 'warn' && 'border-amber-300 bg-amber-50 text-amber-950',
      )}
    >
      <Icon aria-hidden className="mt-0.5 size-4 shrink-0" />
      <div className="min-w-0 flex-1 space-y-1">{children}</div>
    </div>
  );
}

/**
 * 自動振り分けの結果。errorsAfter は保存して読み直した後の検証の error の数（固定・手動の行が原因）。
 */
export function AutoResult({
  outcome,
  vm,
  errorsAfter,
  onIssue,
  onRecheck,
  onReload,
}: {
  outcome: AutoOutcome;
  vm: ViewModel;
  errorsAfter: number;
  onIssue?: (issue: Issue) => void;
  onRecheck: () => void;
  onReload: () => void;
}) {
  const label = MODE_LABELS[outcome.mode];
  switch (outcome.kind) {
    case 'failure':
      return <FailurePanel view={failureView(outcome.result, vm)} {...(onIssue ? { onIssue } : {})} />;
    case 'problems':
      return (
        <FailurePanel
          view={{
            reason: 'invalid_input',
            title: '入力に誤りがあります',
            sections: [
              {
                lines: outcome.problems.map((p) => ({
                  text: p.message,
                  ...(p.ruleCode ? { ruleCode: p.ruleCode } : {}),
                })),
              },
            ],
          }}
        />
      );
    case 'saved': {
      const c = outcome.counts;
      return (
        <div className="space-y-2">
          {outcome.excludedRequests > 0 ? (
            <Notice tone="warn" testId="allocate-excluded">
              申請できない品目の申請 {outcome.excludedRequests} 件を除いて計算しました（検証の E006 を見てください）。
            </Notice>
          ) : null}
          <Notice tone="ok" testId="allocate-saved">
            <p>
              {outcome.verified
                ? `${label}の結果は保存されていました（応答が届かなかったので、読み直して確かめました）。`
                : `${label}の結果を保存しました（追加 ${c.inserted}・変更 ${c.updated}・削除 ${c.deleted}）。`}
            </p>
            <p data-testid="allocate-elapsed" data-elapsed-ms={Math.round(outcome.elapsedMs)} data-load-ms={Math.round(outcome.loadMs)}>
              計算 {seconds(outcome.elapsedMs)} 秒
              {outcome.loadMs >= 1 ? `（計算エンジンの読み込み ${seconds(outcome.loadMs)} 秒は含まない）` : ''}
            </p>
          </Notice>
          {errorsAfter > 0 ? (
            <Notice tone="warn" testId="allocate-errors-after">
              自動振り分けの後に error が {errorsAfter} 件あります（固定・手動の行が原因）。検証の一覧を見てください。
            </Notice>
          ) : null}
        </div>
      );
    }
    case 'save-error':
      return <ErrorBanner error={outcome.error} context={{ rpc: 'save_auto_allocations', names: namesOf(vm) }} onReload={onReload} />;
    case 'not-saved':
      return (
        <Notice tone="warn" testId="allocate-not-saved">
          {outcome.otherChange
            ? `${label}の結果は保存されていません。その間にほかの人が振り分けの入力を変えました。読み直したので、もう一度実行してください。`
            : `${label}の結果は保存されていません（通信が切れました）。もう一度実行してください。`}
        </Notice>
      );
    case 'unverified':
      return (
        <Notice tone="warn" testId="allocate-unverified">
          <p>保存できたか確かめられません。通信が戻ったら「確かめる」を押してください（確かめるまで、もう一度実行できません）。</p>
          <Button size="sm" variant="outline" onClick={onRecheck}>
            確かめる
          </Button>
        </Notice>
      );
    case 'cancelled':
      return (
        <Notice tone="info" testId="allocate-cancelled">
          {label}を中止しました。振り分けは変わっていません。
        </Notice>
      );
    case 'error':
      return <ErrorBanner error={outcome.error} context={{ names: namesOf(vm) }} onReload={onReload} />;
  }
}
