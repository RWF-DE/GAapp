'use client';

import { useMutation } from '@tanstack/react-query';
import { useMemo, useState } from 'react';
import { toast } from 'sonner';
import { ConfirmDialog } from '@/components/common/confirm-dialog';
import { ReasonDialog } from '@/components/common/reason-dialog';
import { UnsavedChangesGuard } from '@/components/common/unsaved-changes-guard';
import { Button } from '@/components/ui/button';
import { Sheet, SheetContent, SheetDescription, SheetFooter, SheetHeader, SheetTitle } from '@/components/ui/sheet';
import { CATEGORY_LABELS } from '@/lib/labels';
import {
  buildRequestForm,
  fetchGroupRequestState,
  fetchPreviousYearRequests,
  groupChangesSince,
  hasCountChanges,
  hasGroupChanges,
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
 * submit_requests は楽観ロックを取らず、表示した品目の数と備考をすべて置き換えるので、締切前は送る直前に団体の申請と提出の記録を
 * 読み直す。シートを開いた表の後にほかの人が変えていれば、送らずに表を読み直し（入れた数は残す）、上書きしてよいか確かめる（2.3・3.6）。
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
  onReload,
  onError,
}: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  row: MatrixRow | null;
  items: readonly ItemRow[];
  year: YearRow;
  mode: ProxyMode;
  onSaved: () => void | Promise<void>;
  /** 表を読み直す（提出の直前に、ほかの人の変更が見つかったとき） */
  onReload: () => Promise<void>;
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
            onReload={onReload}
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
  onReload,
  onError,
}: {
  row: MatrixRow;
  items: readonly ItemRow[];
  year: YearRow;
  mode: ProxyMode;
  onClose: () => void;
  onSaved: () => void | Promise<void>;
  onReload: () => Promise<void>;
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
  /** 書き換えた備考（null なら読み込んだ備考のまま。読み直したら新しい備考になる） */
  const [noteEdit, setNoteEdit] = useState<string | null>(null);
  const note = noteEdit ?? savedNote;
  const [error, setError] = useState<string | null>(null);
  const [reasonOpen, setReasonOpen] = useState(false);
  const [prevLoading, setPrevLoading] = useState(false);
  /** 提出の直前の読み直しの最中 */
  const [checking, setChecking] = useState(false);
  /** 読み直してほかの人の変更が見つかった（上書きしてよいか確かめる）。変わった品目の「名前（前 → 今）」と、提出の記録が変わったか */
  const [overwrite, setOverwrite] = useState<{ items: string[]; submission: boolean } | null>(null);
  const dirty = hasCountChanges(model.fields, edits) || (noteEdit !== null && noteEdit !== savedNote);
  const noteTooLong = note.length > NOTE_MAX;
  const showPrev = group.category === 'rest_area' && !!year.prev_year_id && hasNoRequests(requests);
  const noteValue = () => (note.trim() === '' ? null : note.trim());

  const direct = useMutation({
    mutationFn: (vars: { rows: { itemId: string; count: number }[]; note: string | null }) => submitRequests(group.id, vars.rows, vars.note),
  });
  const deadline = useMutation({
    mutationFn: (reason: string) => submitAfterDeadline(group.id, toDeadlineRows(model.fields, edits), noteValue(), reason),
  });
  const busy = direct.isPending || deadline.isPending || checking;

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

  const sendDirect = async () => {
    setError(null);
    try {
      await direct.mutateAsync({ rows: toSubmitRows(model.fields, edits), note: noteValue() });
      await finish();
    } catch (e) {
      setError(await onError(e, 'submit_requests', group.id));
    }
  };

  /**
   * 送る直前に団体の申請と提出の記録を読み直し、シートを開いた表の行と比べる（updated_at・submitted_at・備考）。
   * 変わっていれば送らない：入れた数（読み込んだ数から変えた品目）と書き換えた備考だけを残して表を読み直し、上書きしてよいか確かめる。
   */
  const checkAndSend = async () => {
    setChecking(true);
    let changed: ReturnType<typeof groupChangesSince>;
    try {
      changed = groupChangesSince(row, await fetchGroupRequestState(group.id));
    } catch (e) {
      setChecking(false);
      setError(messageFor(classifyError(e)));
      return;
    }
    if (!hasGroupChanges(changed)) {
      setChecking(false);
      await sendDirect();
      return;
    }
    const current = new Map(model.fields.map((f) => [f.item.id, f.current]));
    setEdits((e) => Object.fromEntries(Object.entries(e).filter(([id, v]) => v !== current.get(id))));
    if (noteEdit === savedNote) setNoteEdit(null);
    try {
      await onReload();
    } finally {
      setChecking(false);
    }
    const name = (id: string) => items.find((i) => i.id === id)?.name ?? '（不明な品目）';
    setOverwrite({ items: changed.items.map((c) => `${name(c.itemId)}（${c.from} → ${c.to}）`), submission: changed.submission });
  };

  const onSubmit = async () => {
    setError(null);
    if (noteTooLong || busy) return;
    if (mode === 'deadline') {
      setReasonOpen(true);
      return;
    }
    await checkAndSend();
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
          onNoteChange={setNoteEdit}
          disabled={busy}
          audience="admin"
        />
      </div>
      <SheetFooter>
        <Button disabled={busy || noteTooLong} aria-busy={busy || undefined} onClick={() => void onSubmit()}>
          {checking ? '確かめています…' : busy ? '保存中…' : mode === 'deadline' ? '理由をつけて保存・提出済みにする' : '提出する'}
        </Button>
        <Button variant="outline" disabled={busy} onClick={onClose}>
          やめる
        </Button>
      </SheetFooter>
      <ConfirmDialog
        open={overwrite !== null}
        onOpenChange={(o) => {
          if (!o) setOverwrite(null);
        }}
        title="ほかの人が変更しました。上書きして提出しますか"
        description="シートを開いた後に、ほかの人がこの団体の申請を変えました。最新の値を読み直し、入れた数（色のついた欄）と書き換えた備考は残しています。提出すると、シートに出ている数と備考で置き換わります。"
        confirmLabel="上書きして提出する"
        cancelLabel="提出しないで見直す"
        pendingLabel="保存中…"
        pending={direct.isPending}
        onConfirm={sendDirect}
      >
        <ul className="max-h-60 space-y-1 overflow-auto text-sm" data-testid="proxy-conflicts">
          {overwrite?.items.map((t) => (
            <li key={t}>{t}</li>
          ))}
          {overwrite?.submission ? <li>提出日時・備考</li> : null}
        </ul>
      </ConfirmDialog>
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
