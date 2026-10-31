'use client';

// 機能ごとのカード（ダッシュボード〔/〕の欄「機能ごとの状況」。04「ダッシュボード」、notes/T16.md「固めた約束」2。T16）。
// 総務と閲覧のみに出す（団体代表には出さない。代表する団体の欄がその代わり）。機能ごとに1枚（機能の登録の順）：機能の名前、
// 数行の要約、その機能の入口へのリンク（開けるときだけ）。読み込みが失敗してカードがない機能は、機能の名前・失敗の文言・
// 「もう一度」と、その機能の入口（homeHref）を開けるならそのリンクを出す。
import { AppLink } from '@/components/common/app-link';
import { Button } from '@/components/ui/button';
import type { ModuleCardModel, PortalContext } from '@/lib/modules/portal';
import { MODULES, type ModuleId } from '@/lib/modules/registry';
import { routeFor } from '@/lib/navigation';
import { useCanOpen } from '@/lib/navigation/can-open';
import { usePortalWidget, type ModuleWidgetState } from './use-portal';
import { ModuleError, PortalLoading, YearGateView, type YearGate } from './widget';

const CARD = 'flex min-w-0 flex-col gap-3 rounded-xl border bg-card p-5 text-card-foreground shadow-sm';

/** 機能ごとのカードの欄の中身（枠とエラーの境界は portal-screen.tsx） */
export function ModuleCards({ ctxs, gate }: { ctxs: readonly PortalContext[]; gate: YearGate }) {
  const modules = usePortalWidget(ctxs, 'cards');
  if (gate.status !== 'ready') return <YearGateView gate={gate} />;
  return (
    <div className="grid gap-4 md:grid-cols-2 xl:grid-cols-3">
      {modules.map((m) => (
        <ModuleSlot key={m.moduleId} module={m} />
      ))}
    </div>
  );
}

function ModuleSlot({ module: m }: { module: ModuleWidgetState }) {
  if (m.card) {
    return (
      <div className="space-y-2">
        <ModuleCard card={m.card} />
        {/* カードがあって、ほかの読み込みが失敗・読み込み中のとき（カードは年度の行だけから作った分） */}
        {m.failure ? <ModuleError moduleId={m.moduleId} error={m.failure.error} onRetry={m.failure.retry} /> : null}
        {m.loading ? <PortalLoading moduleId={m.moduleId} rows={1} /> : null}
      </div>
    );
  }
  if (m.failure) return <ModuleFailureCard moduleId={m.moduleId} error={m.failure.error} onRetry={m.failure.retry} />;
  if (m.loading) return <PortalLoading moduleId={m.moduleId} rows={4} className={CARD} />;
  return null;
}

function ModuleCard({ card: c }: { card: ModuleCardModel }) {
  return (
    <article data-testid="module-card" data-module={c.moduleId} className={CARD}>
      <h3 className="font-semibold">{c.title}</h3>
      <ul className="space-y-1 text-sm">
        {c.lines.map((line, k) => (
          <li key={k}>{line}</li>
        ))}
      </ul>
      {c.href ? (
        <div>
          <Button asChild size="sm" variant="outline">
            <AppLink href={c.href}>{c.linkLabel}</AppLink>
          </Button>
        </div>
      ) : null}
    </article>
  );
}

/** カードを作れなかった機能（読み込みの失敗）。入口を開けるなら、その画面へのリンクも出す */
function ModuleFailureCard({ moduleId, error, onRetry }: { moduleId: ModuleId; error: unknown; onRetry: () => void }) {
  const canOpen = useCanOpen();
  const def = MODULES.find((d) => d.id === moduleId);
  const home = def && canOpen(def.homeHref) ? def.homeHref : null;
  return (
    <div className={CARD}>
      <h3 className="font-semibold">{def?.label ?? moduleId}</h3>
      <ModuleError moduleId={moduleId} error={error} onRetry={onRetry}>
        {home ? (
          <AppLink href={home} className="text-sm underline underline-offset-2">
            {routeFor(home)?.label ?? def?.label}へ
          </AppLink>
        ) : null}
      </ModuleError>
    </div>
  );
}
