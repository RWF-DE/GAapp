'use client';

import { useMutation } from '@tanstack/react-query';
import { useEffect, useEffectEvent, useMemo, useRef, useState } from 'react';
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
  groupStateOf,
  hasCountChanges,
  hasGroupChanges,
  hasNoRequests,
  hasPreviousFor,
  previousCountsFor,
  stateChangesSince,
  submitAfterDeadline,
  submitRequests,
  toDeadlineRows,
  toSubmitRows,
  type GroupRequestState,
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
 * 確かめた後は、読み直した値をシートの基準にする（表の読み直しを待たない）。「上書きして提出する」でももう一度読み直し、その間に
 * また変わっていれば送らずに最新の値でもう一度確かめる。
 * 締切後は、備考を変えたときだけ備考を送る（開いた後にほかの人が変えた備考を上書きしない）。
 * 未保存の入力があれば、外側のクリック・Esc・×・「やめる」で閉じる前に確かめる。送信中は閉じない。
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
  /** シートの中の入力の状態（閉じる前に確かめる） */
  const formRef = useRef<FormState>({ dirty: false, busy: false });
  const [busy, setBusy] = useState(false);
  const [askClose, setAskClose] = useState(false);
  const reportState = (st: FormState) => {
    formRef.current = st;
    setBusy(st.busy);
  };
  /** 閉じる操作（外側のクリック・Esc・×・「やめる」）：送信中は閉じず、未保存の入力があれば確かめる */
  const requestClose = () => {
    if (formRef.current.busy) return;
    if (formRef.current.dirty) setAskClose(true);
    else onOpenChange(false);
  };
  return (
    <Sheet open={open} onOpenChange={(o) => (o ? onOpenChange(true) : requestClose())}>
      <SheetContent side="right" className="w-full overflow-y-auto sm:max-w-md" showCloseButton={!busy}>
        {row ? (
          <ProxyForm
            key={row.group.id}
            row={row}
            items={items}
            year={year}
            mode={mode}
            onClose={() => onOpenChange(false)}
            onCancel={requestClose}
            onStateChange={reportState}
            onSaved={onSaved}
            onReload={onReload}
            onError={onError}
          />
        ) : null}
        <ConfirmDialog
          open={askClose}
          onOpenChange={setAskClose}
          title="入力を捨てて閉じますか"
          description="代理入力のシートに、まだ保存していない入力があります。閉じると入力は消えます。"
          confirmLabel="捨てて閉じる"
          cancelLabel="入力に戻る"
          destructive
          onConfirm={() => onOpenChange(false)}
        />
      </SheetContent>
    </Sheet>
  );
}

interface FormState {
  dirty: boolean;
  busy: boolean;
}

function ProxyForm({
  row,
  items,
  year,
  mode,
  onClose,
  onCancel,
  onStateChange,
  onSaved,
  onReload,
  onError,
}: {
  row: MatrixRow;
  items: readonly ItemRow[];
  year: YearRow;
  mode: ProxyMode;
  /** 閉じる（保存の後。確かめない） */
  onClose: () => void;
  /** 「やめる」（入力があれば確かめてから閉じる） */
  onCancel: () => void;
  onStateChange: (st: FormState) => void;
  onSaved: () => void | Promise<void>;
  onReload: () => Promise<void>;
  onError: (e: unknown, rpc: 'submit_requests' | 'update_requests_after_deadline', groupId: string) => Promise<string>;
}) {
  const group = row.group;
  /** 提出の直前に読み直した団体の申請と提出の記録（ほかの人の変更を確かめた後は、これをシートの基準にする） */
  const [fresh, setFresh] = useState<GroupRequestState | null>(null);
  const base = useMemo(() => fresh ?? groupStateOf(row), [fresh, row]);
  const requests = base.requests;
  const model = useMemo(() => buildRequestForm(items, group.category, requests), [items, group.category, requests]);
  const savedNote = base.submission?.note ?? '';
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
  /** 備考を書き換えたか（締切後は書き換えたときだけ備考を送る） */
  const noteChanged = noteEdit !== null && (noteEdit.trim() === '' ? null : noteEdit.trim()) !== (savedNote.trim() === '' ? null : savedNote.trim());

  const direct = useMutation({
    mutationFn: (vars: { rows: { itemId: string; count: number }[]; note: string | null }) => submitRequests(group.id, vars.rows, vars.note),
  });
  const deadline = useMutation({
    mutationFn: (reason: string) =>
      submitAfterDeadline(group.id, toDeadlineRows(model.fields, edits), noteChanged ? noteValue() : undefined, reason),
  });
  const busy = direct.isPending || deadline.isPending || checking;
  // シートに入力と送信中を知らせる（閉じる前の確かめ・送信中に閉じない）。外れたら何もない状態に戻す
  const report = useEffectEvent((st: FormState) => onStateChange(st));
  useEffect(() => {
    report({ dirty, busy });
  }, [dirty, busy]);
  useEffect(() => () => report({ dirty: false, busy: false }), []);

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
   * 送る直前に団体の申請と提出の記録を読み直し、シートの基準（開いた表の行、確かめた後は前に読み直した記録）と比べる
   * （updated_at・submitted_at・備考）。変わっていなければ送る（'sent'）。変わっていれば送らない（'changed'）：読み直した記録を
   * シートの基準にし（表の読み直しを待たずに、確かめる値をシートに出す）、入れた数（基準から変えた品目）と書き換えた備考だけを残して、
   * 上書きしてよいか確かめる。表も読み直す。読み直せなければ送らない（'error'）。
   */
  const checkAndSend = async (): Promise<'sent' | 'changed' | 'error'> => {
    setChecking(true);
    let latest: GroupRequestState;
    try {
      latest = await fetchGroupRequestState(group.id);
    } catch (e) {
      setChecking(false);
      setError(messageFor(classifyError(e)));
      return 'error';
    }
    const changed = stateChangesSince(base, latest);
    if (!hasGroupChanges(changed)) {
      setChecking(false);
      await sendDirect();
      return 'sent';
    }
    const current = new Map(model.fields.map((f) => [f.item.id, f.current]));
    setEdits((e) => Object.fromEntries(Object.entries(e).filter(([id, v]) => v !== current.get(id))));
    if (noteEdit === savedNote) setNoteEdit(null);
    setFresh(latest);
    setChecking(false);
    const name = (id: string) => items.find((i) => i.id === id)?.name ?? '（不明な品目）';
    setOverwrite({ items: changed.items.map((c) => `${name(c.itemId)}（${c.from} → ${c.to}）`), submission: changed.submission });
    // 表も読み直す（シートは読み直した記録で確かめるので、待たない）
    void onReload().catch(() => undefined);
    return 'changed';
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
        <Button variant="outline" disabled={busy} onClick={onCancel}>
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
        pending={direct.isPending || checking}
        onConfirm={async () => {
          // もう一度読み直してから送る。その間にまた変わっていれば、送らずに最新の値で確かめ直す（ダイアログは開いたまま）
          if ((await checkAndSend()) === 'changed') throw new Error('changed_again');
        }}
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
