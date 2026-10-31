'use client';

// お知らせの欄（ダッシュボード〔/〕の「総務内のお知らせ」〔総務〕と「お知らせ」〔閲覧のみ・店長・副店長〕。04「ダッシュボード」と
// 「お知らせ一覧」の「ダッシュボードに出すもの」、notes/T17.md「後半（画面）の約束」6。T17・D-52・D-53）。
// お知らせの新着を5件まで（latestNotices：ピン留め → 出した日時の新しい順 → id）。1件は行全体を一覧でそのお知らせを目立たせる
// リンク（/notices?notice=<id>）にし、ピン留めの印・出した日時（「10/5 17:00」）と、お知らせの欄では宛先の印を出す。
// 読み込み中・失敗は、この欄の読み取り（お知らせのプロバイダの query.widgets）の分だけ出す（机椅子の読み込み中・失敗は出ない）。
// 欄の下には、失敗のときも「お知らせ一覧へ」（総務内のお知らせの欄は総務内で絞った一覧）。
// / の JS を軽くするため、一覧の画面とダイアログ（components/notices・lib/data/notices・lib/schemas/notices）を import しない。
import { ChevronRight, Pin } from 'lucide-react';
import { AppLink } from '@/components/common/app-link';
import { Badge } from '@/components/ui/badge';
import { formatShortDateTime } from '@/lib/datetime';
import { NOTICE_AUDIENCE_LABELS } from '@/lib/labels';
import { latestNotices, type NoticeDigest, type PortalContext } from '@/lib/modules/portal';
import { usePortalWidget } from './use-portal';
import { ModuleError, PortalLoading, YearGateView, type YearGate } from './widget';

/** お知らせの欄（総務内のお知らせ・お知らせ） */
export type NoticeWidgetId = 'soumuNotices' | 'notices';

/** 欄ごとの空の文と、欄の下のリンクの行き先 */
const WIDGET_TEXT: Readonly<Record<NoticeWidgetId, { empty: string; href: string }>> = {
  soumuNotices: { empty: '総務内のお知らせはありません', href: '/notices?audience=soumu' },
  notices: { empty: 'お知らせはありません', href: '/notices' },
};

/** お知らせの欄の中身（枠とエラーの境界は portal-screen.tsx） */
export function NoticeDigests({ ctxs, gate, widget }: { ctxs: readonly PortalContext[]; gate: YearGate; widget: NoticeWidgetId }) {
  const modules = usePortalWidget(ctxs, widget);
  if (gate.status !== 'ready') return <YearGateView gate={gate} />;
  const items = latestNotices(modules.flatMap((m) => m.notices ?? []));
  const loading = modules.filter((m) => m.loading);
  const failed = modules.filter((m) => m.failure);
  const text = WIDGET_TEXT[widget];
  return (
    <div className="space-y-3">
      {failed.map((m) => (
        <ModuleError key={m.moduleId} moduleId={m.moduleId} error={m.failure!.error} onRetry={m.failure!.retry} />
      ))}
      {items.length > 0 ? (
        <ul className="divide-y">
          {items.map((n) => (
            <NoticeDigestRow key={n.id} notice={n} showAudience={widget === 'notices'} />
          ))}
        </ul>
      ) : loading.length === 0 && failed.length === 0 ? (
        <p data-testid="portal-notices-empty" className="text-sm text-muted-foreground">
          {text.empty}
        </p>
      ) : null}
      {loading.map((m) => (
        <PortalLoading key={m.moduleId} moduleId={m.moduleId} />
      ))}
      <p className="text-sm">
        <AppLink href={text.href} data-testid="portal-notices-link" className="underline underline-offset-2 hover:text-primary">
          お知らせ一覧へ
        </AppLink>
      </p>
    </div>
  );
}

function NoticeDigestRow({ notice: n, showAudience }: { notice: NoticeDigest; showAudience: boolean }) {
  return (
    <li data-testid="portal-notice" data-id={n.id} data-pinned={String(n.pinned)} data-audience={n.audience}>
      <AppLink href={n.href} className="-mx-2 flex items-start gap-3 rounded-md px-2 py-2.5 hover:bg-accent">
        <span className="min-w-0 flex-1 space-y-1">
          <span className="flex flex-wrap items-center gap-1.5">
            {n.pinned ? (
              <Badge variant="outline" className="border-amber-300 bg-amber-50 text-amber-900">
                <Pin aria-hidden />
                ピン留め
              </Badge>
            ) : null}
            {showAudience ? (
              <Badge variant="outline" className="text-muted-foreground">
                {NOTICE_AUDIENCE_LABELS[n.audience]}
              </Badge>
            ) : null}
            <time dateTime={n.at} className="text-xs text-muted-foreground tabular-nums">
              {formatShortDateTime(n.at)}
            </time>
          </span>
          {/* 題名は1行で切らずに折り返す（文節で。外枠の word-break: auto-phrase。長い英数字は anywhere で折る） */}
          <span className="block text-sm font-medium [overflow-wrap:anywhere]">{n.title}</span>
        </span>
        <ChevronRight aria-hidden className="mt-0.5 size-4 shrink-0 text-muted-foreground" />
      </AppLink>
    </li>
  );
}
