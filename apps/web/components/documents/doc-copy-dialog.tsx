'use client';

// 前年度から写す（04「提出状況 /documents（PC）」の提出物の設定の「前年度から写す」、Q10。notes/T19.md「パート B・C の約束」6。T19・D-55）。
// 部門長以上（終了した年度を除く。複製元〔prev_year_id〕のある年度だけ）。
// - 開くたびに previous_year_documents（GET。読み取りだけの RPC）を読み、複製元の提出物を締切 → 題名の順に、チェック・題名・締切（「前年度
//   10/5（月）17:00 → 10/4（日）17:00」。右は1日目の差の日数だけずらした new_deadline）・対象を並べる。同じ題名がこの年度にあるもの
//   （exists_in_year）は「同じ題名があります（写しません）」と出して選べなくする。前年度の提出物がなければ「前年度の提出物はありません」。
// - 「写す（{N} 件）」→ copy_previous_documents →「{N} 件を写しました」（写さなかったものがあれば「（同じ題名の {k} 件は写しませんでした）」）。
//   何度しても同じ結果になる（同じ題名は飛ばす）ので、応答が届かなければもう一度押してよい。止められたら文言を出し、前年度の一覧を読み直す。
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { useState } from 'react';
import { toast } from 'sonner';
import { Button } from '@/components/ui/button';
import { Checkbox } from '@/components/ui/checkbox';
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from '@/components/ui/dialog';
import { LoadingState } from '@/components/states';
import { useAuthErrorHandler } from '@/lib/auth/guarded';
import { copyPreviousDocuments, invalidateDocuments, previousYearDocumentsOptions, type PreviousYearDocument } from '@/lib/data/documents';
import { tokyoDate } from '@/lib/datetime';
import { formatShortDateTimeWeekday } from '@/lib/datetime-weekday';
import { classifyError, effectOf, messageFor } from '@/lib/errors';
import { CATEGORY_LABELS } from '@/lib/labels';
import { copySummary } from '@/lib/modules/documents/copy';
import { cn } from '@/lib/utils';
import { sendWithAuth } from './submission-write';

/** 前年度の提出物がない */
export const COPY_EMPTY_TEXT = '前年度の提出物はありません';
/** 同じ題名がこの年度にある（写さない） */
export const COPY_EXISTS_TEXT = '同じ題名があります（写しません）';

/** 締切の短い形（「10/5（月）17:00」。年は付けない。その日時の Asia/Tokyo の年で読む） */
function shortDeadline(iso: string): string {
  const year = Number(tokyoDate(iso).slice(0, 4));
  return formatShortDateTimeWeekday(iso, Number.isNaN(year) ? undefined : year) || '—';
}

/** 締切のずらし方の文（「前年度 10/5（月）17:00 → 10/4（日）17:00」） */
export function copyDeadlineText(doc: Pick<PreviousYearDocument, 'deadline' | 'new_deadline'>): string {
  return `前年度 ${shortDeadline(doc.deadline)} → ${shortDeadline(doc.new_deadline)}`;
}

/** 対象の文（区分の表示名を「・」で。飲食の団体だけなら「（飲食の団体だけ）」） */
export function targetText(doc: { target_categories: readonly string[]; food_only: boolean }): string {
  const names = doc.target_categories.map((c) => CATEGORY_LABELS[c as keyof typeof CATEGORY_LABELS] ?? c).join('・');
  return `${names}${doc.food_only ? '（飲食の団体だけ）' : ''}`;
}

export function DocCopyDialog({
  open,
  onClose,
  yearId,
  onReloadMembership,
}: {
  open: boolean;
  onClose: () => void;
  yearId: string;
  /** 年度の行と立場を読み直す（forbidden・invalid_state の後） */
  onReloadMembership: () => void;
}) {
  return (
    <Dialog
      open={open}
      onOpenChange={(o) => {
        if (!o) onClose();
      }}
    >
      {open ? <CopyBody onClose={onClose} yearId={yearId} onReloadMembership={onReloadMembership} /> : null}
    </Dialog>
  );
}

function CopyBody({ onClose, yearId, onReloadMembership }: { onClose: () => void; yearId: string; onReloadMembership: () => void }) {
  const queryClient = useQueryClient();
  const onAuthError = useAuthErrorHandler();
  const q = useQuery(previousYearDocumentsOptions(yearId));
  const [selected, setSelected] = useState<ReadonlySet<string>>(() => new Set());
  const [pending, setPending] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const rows = q.data ?? [];
  const choosable = rows.filter((r) => !r.exists_in_year);
  const picked = choosable.filter((r) => selected.has(r.document_id));

  const toggle = (id: string, on: boolean) =>
    setSelected((prev) => {
      const next = new Set(prev);
      if (on) next.add(id);
      else next.delete(id);
      return next;
    });

  const copy = async () => {
    if (pending || picked.length === 0) return;
    setError(null);
    setPending(true);
    try {
      const sent = await sendWithAuth(
        () =>
          copyPreviousDocuments(
            yearId,
            picked.map((r) => r.document_id),
          ),
        onAuthError,
      );
      if (sent.ok) {
        invalidateDocuments(queryClient, yearId);
        toast.success(copySummary(picked.length, sent.value.length));
        onClose();
        return;
      }
      const c = classifyError(sent.error);
      setError(messageFor(c, { rpc: 'copy_previous_documents' }));
      const effect = effectOf(c);
      if (effect.reload === 'year') onReloadMembership();
      // 止められた（前年度にない・同じ題名ができた）ら前年度の一覧とこの年度を読み直す
      if (effect.reload !== 'none' || c.kind === 'input') {
        invalidateDocuments(queryClient, yearId);
        void q.refetch();
      }
    } finally {
      setPending(false);
    }
  };

  return (
    <DialogContent
      data-testid="doc-copy-dialog"
      className="flex max-h-[calc(100dvh-2rem)] flex-col gap-0 p-0 sm:max-w-2xl"
      showCloseButton={!pending}
      // 写している間は閉じない（Esc・外側のクリック）
      onEscapeKeyDown={(e) => {
        if (pending) e.preventDefault();
      }}
      onPointerDownOutside={(e) => {
        if (pending) e.preventDefault();
      }}
    >
      <DialogHeader className="border-b px-6 pt-6 pb-4">
        <DialogTitle>前年度から写す</DialogTitle>
        <DialogDescription>締切は1日目の差の日数だけずらします（時刻は同じ）。写した後に直せます。</DialogDescription>
      </DialogHeader>
      <div className="min-h-0 flex-1 space-y-3 overflow-y-auto px-6 py-4">
        {error ? (
          <p role="alert" data-testid="doc-copy-error" className="rounded-md border border-destructive/40 bg-destructive/5 px-3 py-2 text-sm text-destructive">
            {error}
          </p>
        ) : null}
        {q.data === undefined ? (
          q.isError ? (
            <div role="alert" data-testid="doc-copy-error" className="space-y-2 rounded-md border border-destructive/40 bg-destructive/5 px-3 py-2 text-sm">
              <p className="font-medium text-destructive">{messageFor(classifyError(q.error), { rpc: 'previous_year_documents' })}</p>
              <Button size="sm" variant="outline" onClick={() => void q.refetch()}>
                もう一度読み込む
              </Button>
            </div>
          ) : (
            <LoadingState />
          )
        ) : rows.length === 0 ? (
          <p data-testid="doc-copy-empty" className="py-6 text-center text-sm text-muted-foreground">
            {COPY_EMPTY_TEXT}
          </p>
        ) : (
          <ul className="divide-y rounded-md border">
            {rows.map((r) => {
              const checkId = `doc-copy-${r.document_id}`;
              return (
                <li
                  key={r.document_id}
                  data-testid="doc-copy-item"
                  data-document-id={r.document_id}
                  data-exists={r.exists_in_year ? 'true' : 'false'}
                  className={cn('flex items-start gap-3 px-3 py-2.5', r.exists_in_year && 'bg-muted/40')}
                >
                  <Checkbox
                    id={checkId}
                    data-testid="doc-copy-check"
                    className="mt-0.5"
                    checked={!r.exists_in_year && selected.has(r.document_id)}
                    disabled={r.exists_in_year || pending}
                    onCheckedChange={(v) => toggle(r.document_id, v === true)}
                  />
                  <div className="min-w-0 flex-1 space-y-0.5 text-sm">
                    <label htmlFor={checkId} className="block font-medium [overflow-wrap:anywhere]">
                      {r.title}
                    </label>
                    <p data-testid="doc-copy-deadline" className="text-muted-foreground">
                      {copyDeadlineText(r)}
                    </p>
                    <p className="text-xs text-muted-foreground">{targetText(r)}</p>
                    {r.exists_in_year ? <p className="text-xs font-medium text-amber-800">{COPY_EXISTS_TEXT}</p> : null}
                  </div>
                </li>
              );
            })}
          </ul>
        )}
      </div>
      <DialogFooter className="flex-row flex-wrap items-center justify-end gap-2 border-t px-6 py-4">
        <Button variant="outline" onClick={onClose} disabled={pending}>
          やめる
        </Button>
        <Button data-testid="doc-copy-submit" onClick={() => void copy()} disabled={pending || picked.length === 0} aria-busy={pending || undefined}>
          {pending ? '写しています…' : `写す（${picked.length} 件）`}
        </Button>
      </DialogFooter>
    </DialogContent>
  );
}
