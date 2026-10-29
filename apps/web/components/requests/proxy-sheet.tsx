'use client';

import { useMutation } from '@tanstack/react-query';
import { useMemo, useState } from 'react';
import { toast } from 'sonner';
import { ReasonDialog } from '@/components/common/reason-dialog';
import { UnsavedChangesGuard } from '@/components/common/unsaved-changes-guard';
import { Button } from '@/components/ui/button';
import { Sheet, SheetContent, SheetDescription, SheetFooter, SheetHeader, SheetTitle } from '@/components/ui/sheet';
import { CATEGORY_LABELS } from '@/lib/labels';
import {
  buildRequestForm,
  fetchPreviousYearRequests,
  hasCountChanges,
  hasNoRequests,
  hasPreviousFor,
  previousCountsFor,
  submitAfterDeadline,
  submitRequests,
  toDeadlineRows,
  toSubmitRows,
  type MatrixRow,
} from '@/lib/data/requests';
import type { ItemRow, YearRow } from '@/lib/db/types';
import { classifyError, messageFor } from '@/lib/errors';
import { NOTE_MAX } from '@/lib/schemas/common';
import { RequestFields } from './request-fields';

/** 代理入力の書き方：direct（締切前。submit_requests）・deadline（締切後。理由と update_requests_after_deadline） */
export type ProxyMode = 'direct' | 'deadline';

/**
 * 代理入力のシート（企業・休憩所など。admin。画面の設計 3.6。T11）。/request と同じ入力欄（RequestFields）を使う。
 * 休憩所で今年の申請がまだないときは「前年の数を入れる」（previous_year_requests を団体名で引く）。
 * 締切前の「提出」は submit_requests（申請と提出を1回で）、締切後は update_requests_after_deadline に提出を付ける（理由は必須）。
 * 失敗は onError に渡す（呼ぶ側が年度を読み直し、DB が締切後と判断したなら書き方を切り替える）。
 */
export function ProxySheet({
  open,
  onOpenChange,
  row,
  items,
  year,
  mode,
  onSaved,
  onError,
}: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  row: MatrixRow | null;
  items: readonly ItemRow[];
  year: YearRow;
  mode: ProxyMode;
  onSaved: () => void | Promise<void>;
  /** 失敗の扱い（読み直し・印）。表示する文言を返す */
  onError: (e: unknown, rpc: 'submit_requests' | 'update_requests_after_deadline', groupId: string) => Promise<string>;
}) {
  return (
    <Sheet open={open} onOpenChange={onOpenChange}>
      <SheetContent side="right" className="w-full overflow-y-auto sm:max-w-md">
        {row ? (
          <ProxyForm
            key={row.group.id}
            row={row}
            items={items}
            year={year}
            mode={mode}
            onClose={() => onOpenChange(false)}
            onSaved={onSaved}
            onError={onError}
          />
        ) : null}
      </SheetContent>
    </Sheet>
  );
}

function ProxyForm({
  row,
  items,
  year,
  mode,
  onClose,
  onSaved,
  onError,
}: {
  row: MatrixRow;
  items: readonly ItemRow[];
  year: YearRow;
  mode: ProxyMode;
  onClose: () => void;
  onSaved: () => void | Promise<void>;
  onError: (e: unknown, rpc: 'submit_requests' | 'update_requests_after_deadline', groupId: string) => Promise<string>;
}) {
  const group = row.group;
  const requests = useMemo(
    () =>
      Object.values(row.cells)
        .filter((c) => c.updatedAt !== null)
        .map((c) => ({ item_id: c.itemId, count: c.count, updated_at: c.updatedAt! })),
    [row],
  );
  const model = useMemo(() => buildRequestForm(items, group.category, requests), [items, group.category, requests]);
  const savedNote = row.submission?.note ?? '';
  const [edits, setEdits] = useState<Record<string, number>>({});
  const [note, setNote] = useState(savedNote);
  const [error, setError] = useState<string | null>(null);
  const [reasonOpen, setReasonOpen] = useState(false);
  const [prevLoading, setPrevLoading] = useState(false);
  const dirty = hasCountChanges(model.fields, edits) || note !== savedNote;
  const noteTooLong = note.length > NOTE_MAX;
  const showPrev = group.category === 'rest_area' && !!year.prev_year_id && hasNoRequests(requests);
  const noteValue = () => (note.trim() === '' ? null : note.trim());

  const direct = useMutation({ mutationFn: () => submitRequests(group.id, toSubmitRows(model.fields, edits), noteValue()) });
  const deadline = useMutation({
    mutationFn: (reason: string) => submitAfterDeadline(group.id, toDeadlineRows(model.fields, edits), noteValue(), reason),
  });
  const busy = direct.isPending || deadline.isPending;

  const fillPrevious = async () => {
    setPrevLoading(true);
    try {
      const rows = await fetchPreviousYearRequests(year.id);
      if (!hasPreviousFor(rows, group.name)) {
        toast.info(`前年度に「${group.name}」の申請がありません`);
        return;
      }
      setEdits(previousCountsFor(rows, group.name, model.fields));
      toast.success('前年の数を入れました。確かめてから提出してください');
    } catch (e) {
      toast.error(messageFor(classifyError(e)));
    } finally {
      setPrevLoading(false);
    }
  };

  const finish = async () => {
    toast.success(`${group.name}の申請を保存しました`);
    await onSaved();
    onClose();
  };

  const onSubmit = async () => {
    setError(null);
    if (noteTooLong || busy) return;
    if (mode === 'deadline') {
      setReasonOpen(true);
      return;
    }
    try {
      await direct.mutateAsync();
      await finish();
    } catch (e) {
      setError(await onError(e, 'submit_requests', group.id));
    }
  };

  return (
    <>
      <UnsavedChangesGuard when={dirty} />
      <SheetHeader>
        <SheetTitle>代理入力：{group.name}</SheetTitle>
        <SheetDescription>
          {CATEGORY_LABELS[group.category]}。
          {mode === 'deadline' ? '締切後なので、理由をつけて保存し、提出済みにします。' : '申請を入れて提出します（提出日時は今の時刻）。'}
        </SheetDescription>
      </SheetHeader>
      <div className="space-y-3 px-4">
        {showPrev ? (
          <Button variant="outline" size="sm" disabled={prevLoading || busy} onClick={() => void fillPrevious()}>
            {prevLoading ? '読み込み中…' : '前年の数を入れる'}
          </Button>
        ) : null}
        {error ? (
          <p role="alert" className="rounded-md border border-destructive/40 bg-destructive/5 px-3 py-2 text-sm text-destructive">
            {error}
          </p>
        ) : null}
        <RequestFields
          idPrefix={`proxy-${group.id}`}
          fields={model.fields}
          extras={model.extras}
          edits={edits}
          onCountChange={(itemId, v) => setEdits((e) => ({ ...e, [itemId]: v }))}
          note={note}
          onNoteChange={setNote}
          disabled={busy}
          audience="admin"
        />
      </div>
      <SheetFooter>
        <Button disabled={busy || noteTooLong} aria-busy={busy || undefined} onClick={() => void onSubmit()}>
          {busy ? '保存中…' : mode === 'deadline' ? '理由をつけて保存・提出済みにする' : '提出する'}
        </Button>
        <Button variant="outline" disabled={busy} onClick={onClose}>
          やめる
        </Button>
      </SheetFooter>
      <ReasonDialog
        open={reasonOpen}
        onOpenChange={setReasonOpen}
        title={`${group.name}の申請を締切後に変更する`}
        description="理由は履歴に残ります。"
        presets={['団体の希望', '代理入力', '紙の申請の入力']}
        pending={deadline.isPending}
        onSubmit={async (reason) => {
          try {
            await deadline.mutateAsync(reason ?? '');
          } catch (e) {
            const msg = await onError(e, 'update_requests_after_deadline', group.id);
            setError(msg);
            if (classifyError(e).kind === 'reason') throw e;
            return;
          }
          await finish();
        }}
      />
    </>
  );
}
