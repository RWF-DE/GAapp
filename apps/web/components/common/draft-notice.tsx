'use client';

import { History } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { formatTime } from '@/lib/datetime';
import { cn } from '@/lib/utils';

/**
 * 下書きを戻す表示（画面の設計 1.4 の「下書き」。T09a）。画面を開いたときに下書き（lib/drafts.ts）があれば出す。
 * 「保存していない入力があります（hh:mm）［戻す］［捨てる］」。戻すかどうかは画面が決める（振り分けは rebasePending で当て直す）。
 * 段 D で足した（段 C の共通の部品に抜けていた。T10・T11・T13 が同じ帯をそれぞれ作らないように）。
 *
 * @example
 * const draft = loadDraft<Counts>(key);
 * {draft && !restored ? (
 *   <DraftNotice savedAt={draft.savedAt} onRestore={() => { setCounts(draft.value); setRestored(true); }}
 *     onDiscard={() => { removeDraft(key); setRestored(true); }} />
 * ) : null}
 */
export function DraftNotice({
  savedAt,
  onRestore,
  onDiscard,
  className,
}: {
  /** 下書きを書いた時刻（ミリ秒。Draft の savedAt） */
  savedAt: number;
  onRestore: () => void;
  onDiscard: () => void;
  className?: string;
}) {
  return (
    <div
      role="status"
      data-testid="draft-notice"
      className={cn(
        'flex flex-wrap items-center gap-3 rounded-md border border-sky-300 bg-sky-50 px-4 py-2 text-sm text-sky-950 print:hidden',
        className,
      )}
    >
      <History aria-hidden className="size-4 shrink-0" />
      <span>保存していない入力があります（{formatTime(savedAt)}）</span>
      <div className="ml-auto flex gap-2">
        <Button size="sm" onClick={onRestore}>
          戻す
        </Button>
        <Button size="sm" variant="outline" onClick={onDiscard}>
          捨てる
        </Button>
      </div>
    </div>
  );
}
