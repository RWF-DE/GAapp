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
  decideGroupSave,
  fetchGroupRequestState,
  fetchPreviousYearRequests,
  groupStateOf,
  hasCountChanges,
  hasNoRequests,
  hasPreviousFor,
  previousCountsFor,
  stateChangesSince,
  submitAfterDeadline,
  submitRequests,
  toDeadlineRows,
  toSubmitRows,
  type GroupChanges,
  type GroupRequestState,
  type MatrixRow,
  type RequestField,
} from '@/lib/data/requests';
import type { ItemRow, YearRow } from '@/lib/db/types';
import { classifyError, isUnknownOutcome, messageFor, unknownOutcomeMessage } from '@/lib/errors';
import { NOTE_MAX } from '@/lib/schemas/common';
import { RequestFields } from './request-fields';

/** 代理入力の書き方：direct（締切前。submit_requests）・deadline（締切後。理由と update_requests_after_deadline） */
export type ProxyMode = 'direct' | 'deadline';

/**
 * 代理入力のシート（企業・休憩所など。admin。画面の設計 3.6。T11）。/request と同じ入力欄（RequestFields）を使う。
 * 休憩所で今年の申請がまだないときは「前年の数を入れる」（previous_year_requests を団体名で引く）。
 * 締切前の「提出」は submit_requests（申請と提出を1回で）、締切後は update_requests_after_deadline に提出を付ける（理由は必須）。
 * 入力の元（base）は開いたときの表の行。裏の表の読み直しでは変えない（入力を黙って置き換えない）。
 * 保存は毎回、送る前に団体の申請と提出の記録を読み直して決める（設計 2.6 の (A)。decideGroupSave）：
 * - 読み直した値が入力と同じ（前に送って応答が届かなかった保存が通っていた）なら、送らずに「保存されていました」で閉じる。
 * - 入力の元からほかの人の変更があれば、送らずに読み直した記録を入力の元にし（入れた数と書き換えた備考は残す）、
 *   上書きしてよいか確かめる。「上書きして…」でももう一度読み直し、また変わっていれば確かめ直す。
 * - ほかは、読み直した記録を入力の元にして送る。締切後の行の楽観ロックも読み直した行の updated_at。
 * 応答が届かず保存できたか分からないとき（isUnknownOutcome）は、入力を残して「…できたか分かりません。もう一度…」と出すだけで、
 * 確かめるための状態は持たない（もう一度押すと、上の読み直しで決まる）。読み直しが通信できなければ送らずに同じ知らせを出す。
 * 締切後は、備考を変えたときだけ備考を送る（開いた後にほかの人が変えた備考を上書きしない）。
 * 閉じる操作（外側のクリック・Esc・×・「やめる」）：送信中は閉じない。保存できたか分からないままなら「閉じると入力は消えます
 * （表を読み直します）」と確かめ、閉じたら表を読み直す。未保存の入力があれば「入力を捨てて閉じますか」と確かめる。
 * 失敗は onError に渡す（呼ぶ側が年度を読み直し、DB が締切後と判断したなら書き方を切り替える）。
 */
export function ProxySheet({
  open,
  onOpenChange,
  row,
  items,
  year,
  mode,
  userId,
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
  /** 自分（提出の記録の updated_by と比べ、自分の書き込みをほかの人の変更として扱わない） */
  userId: string;
  onSaved: () => void | Promise<void>;
  /** 表を読み直す（ほかの人の変更が見つかったとき・保存できたか分からないまま閉じたとき） */
  onReload: () => Promise<void>;
  /** 失敗の扱い（読み直し・印）。表示する文言を返す */
  onError: (e: unknown, rpc: 'submit_requests' | 'update_requests_after_deadline', groupId: string) => Promise<string>;
}) {
  /** シートの中の入力の状態（閉じる前に確かめる） */
  const formRef = useRef<FormState>({ dirty: false, busy: false, unknown: false });
  const [busy, setBusy] = useState(false);
  const [askClose, setAskClose] = useState<'discard' | 'unknown' | null>(null);
  const reportState = (st: FormState) => {
    formRef.current = st;
    setBusy(st.busy);
  };
  /** 閉じる操作（外側のクリック・Esc・×・「やめる」）：送信中は閉じず、保存できたか分からないか未保存の入力があれば確かめる */
  const requestClose = () => {
    const st = formRef.current;
    if (st.busy) return;
    if (st.unknown) setAskClose('unknown');
    else if (st.dirty) setAskClose('discard');
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
            userId={userId}
            onClose={() => onOpenChange(false)}
            onCancel={requestClose}
            onStateChange={reportState}
            onSaved={onSaved}
            onReload={onReload}
            onError={onError}
          />
        ) : null}
        <ConfirmDialog
          open={askClose !== null}
          onOpenChange={(o) => {
            if (!o) setAskClose(null);
          }}
          title={askClose === 'unknown' ? '保存できたか分からないまま閉じますか' : '入力を捨てて閉じますか'}
          description={
            askClose === 'unknown'
              ? '保存できたか分かりません。閉じると入力は消えます（表を読み直します）。'
              : '代理入力のシートに、まだ保存していない入力があります。閉じると入力は消えます。'
          }
          confirmLabel={askClose === 'unknown' ? '閉じる' : '捨てて閉じる'}
          cancelLabel={askClose === 'unknown' ? 'シートに戻る' : '入力に戻る'}
          destructive
          onConfirm={() => {
            const reload = askClose === 'unknown';
            onOpenChange(false);
            if (reload) void onReload().catch(() => undefined);
          }}
        />
      </SheetContent>
    </Sheet>
  );
}

interface FormState {
  dirty: boolean;
  busy: boolean;
  /** 前の送信の応答が届かず、保存できたか分からない（閉じる前の確かめの文を変えるだけ） */
  unknown: boolean;
}

/** 上書きするかのダイアログに出すもの。reason は締切後に入れた理由（上書きするときにもう一度入れさせない） */
interface OverwriteAsk {
  items: string[];
  submission: boolean;
  reason: string | null;
}

/** 入れた数のうち、入力の元の欄の値（fields の current）から変えた品目だけを残す（上書きの確かめで、入れていない欄は読み直した値にする） */
function keepTyped(fields: readonly RequestField[], edits: Readonly<Record<string, number>>): Record<string, number> {
  const current = new Map(fields.map((f) => [f.item.id, f.current]));
  return Object.fromEntries(Object.entries(edits).filter(([id, v]) => v !== current.get(id)));
}

function ProxyForm({
  row,
  items,
  year,
  mode,
  userId,
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
  userId: string;
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
  /** 入力の元（比べる団体の申請と提出の記録）。開いたときの表の行で始め、送る前の読み直しのときだけ変える */
  const [base, setBase] = useState<GroupRequestState>(() => groupStateOf(row));
  const model = useMemo(() => buildRequestForm(items, group.category, base.requests), [items, group.category, base.requests]);
  const savedNote = base.submission?.note ?? '';
  const [edits, setEdits] = useState<Record<string, number>>({});
  /** 書き換えた備考（null なら入力の元の備考のまま） */
  const [noteEdit, setNoteEdit] = useState<string | null>(null);
  const note = noteEdit ?? savedNote;
  const [error, setError] = useState<string | null>(null);
  /** 前の送信の応答が届かず、保存できたか分からない（知らせと閉じる前の確かめの文だけに使う。次の読み直しで外す） */
  const [unknown, setUnknown] = useState(false);
  const [reasonOpen, setReasonOpen] = useState(false);
  const [prevLoading, setPrevLoading] = useState(false);
  /** 送る前の読み直しの最中 */
  const [checking, setChecking] = useState(false);
  /** 読み直してほかの人の変更が見つかった（上書きしてよいか確かめる） */
  const [overwrite, setOverwrite] = useState<OverwriteAsk | null>(null);
  const dirty = hasCountChanges(model.fields, edits) || (noteEdit !== null && noteEdit !== savedNote);
  const noteTooLong = note.length > NOTE_MAX;
  const showPrev = group.category === 'rest_area' && !!year.prev_year_id && hasNoRequests(base.requests);
  const noteValue = () => (note.trim() === '' ? null : note.trim());
  /** 備考を書き換えたか（締切後は書き換えたときだけ備考を送る） */
  const noteChanged = noteEdit !== null && (noteEdit.trim() === '' ? null : noteEdit.trim()) !== (savedNote.trim() === '' ? null : savedNote.trim());
  const verb = mode === 'deadline' ? '保存' : '提出';

  const direct = useMutation({
    mutationFn: (vars: { rows: { itemId: string; count: number }[]; note: string | null }) => submitRequests(group.id, vars.rows, vars.note),
  });
  const deadline = useMutation({
    mutationFn: (vars: { rows: { itemId: string; count: number; updatedAt?: string }[]; note: string | null | undefined; reason: string }) =>
      submitAfterDeadline(group.id, vars.rows, vars.note, vars.reason),
  });
  const busy = direct.isPending || deadline.isPending || checking;
  // シートに入力と送信中を知らせる（閉じる前の確かめ・送信中に閉じない）。外れたら何もない状態に戻す
  const report = useEffectEvent((st: FormState) => onStateChange(st));
  useEffect(() => {
    report({ dirty, busy, unknown });
  }, [dirty, busy, unknown]);
  useEffect(() => () => report({ dirty: false, busy: false, unknown: false }), []);

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

  const close = async (message: string) => {
    toast.success(message);
    await onSaved();
    onClose();
  };

  /**
   * 読み直した記録でほかの人の変更が見つかったとき：読み直した記録を入力の元にし（表の読み直しを待たずに、確かめる値をシートに
   * 出す）、入れた数（前の入力の元から変えた品目）と書き換えた備考だけを残して、上書きしてよいか確かめる。表も読み直す。
   */
  const askOverwrite = (latest: GroupRequestState, reason: string | null) => {
    const changed: GroupChanges = stateChangesSince(base, latest);
    const name = (id: string) => items.find((i) => i.id === id)?.name ?? '（不明な品目）';
    setEdits((e) => keepTyped(model.fields, e));
    setNoteEdit((n) => (n === savedNote ? null : n));
    setBase(latest);
    setOverwrite({ items: changed.items.map((c) => `${name(c.itemId)}（${c.from} → ${c.to}）`), submission: changed.submission, reason });
    void onReload().catch(() => undefined);
  };

  /**
   * 保存（締切前は提出、締切後は理由つきの保存）。送る前に団体の申請と提出の記録を読み直して決める（設計 2.6 の (A)）。
   * 'changed' はほかの人の変更があって送らなかった（上書きの確かめを出した）。
   */
  const save = async (reason: string | null): Promise<'done' | 'changed' | 'error'> => {
    setError(null);
    setChecking(true);
    let latest: GroupRequestState;
    try {
      latest = await fetchGroupRequestState(group.id);
    } catch (e) {
      setChecking(false);
      setError(isUnknownOutcome(e) ? unknownOutcomeMessage(verb) : messageFor(classifyError(e)));
      return 'error';
    }
    setChecking(false);
    setUnknown(false);
    const counts = Object.fromEntries(toSubmitRows(model.fields, edits).map((r) => [r.itemId, r.count]));
    // 締切後に備考を書き換えていなければ備考は送らない（入力の元の備考のまま）
    const sentNote = mode === 'deadline' && !noteChanged ? undefined : noteValue();
    const decision = decideGroupSave(base, latest, { counts, note: sentNote === undefined ? savedNote : sentNote }, userId);
    if (decision === 'saved') {
      await close(`${group.name}の申請は保存されていました`);
      return 'done';
    }
    if (decision === 'conflict') {
      askOverwrite(latest, reason);
      return 'changed';
    }
    // 入力の元を読み直した記録にして送る（入れていない欄は読み直した値と同じ。違えばほかの人の変更で、上で止まる）
    setBase(latest);
    try {
      if (mode === 'deadline') {
        const fields = buildRequestForm(items, group.category, latest.requests).fields;
        await deadline.mutateAsync({ rows: toDeadlineRows(fields, counts), note: sentNote, reason: reason ?? '' });
      } else {
        await direct.mutateAsync({ rows: toSubmitRows(model.fields, edits), note: noteValue() });
      }
    } catch (e) {
      if (isUnknownOutcome(e)) {
        // 自動では送り直さない。入力を残し、もう一度押すと読み直して決める
        setUnknown(true);
        setError(unknownOutcomeMessage(verb));
        return 'error';
      }
      setError(await onError(e, mode === 'deadline' ? 'update_requests_after_deadline' : 'submit_requests', group.id));
      if (classifyError(e).kind === 'reason') throw e;
      return 'error';
    }
    await close(`${group.name}の申請を保存しました`);
    return 'done';
  };

  const onSubmit = async () => {
    if (noteTooLong || busy) return;
    setError(null);
    if (mode === 'deadline') {
      setReasonOpen(true);
      return;
    }
    await save(null);
  };

  return (
    <>
      <UnsavedChangesGuard when={dirty || unknown} />
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
        title={mode === 'deadline' ? 'ほかの人が変更しました。上書きして保存しますか' : 'ほかの人が変更しました。上書きして提出しますか'}
        description={`シートを開いた後に、ほかの人がこの団体の申請を変えました。最新の値を読み直し、入れた数（色のついた欄）と書き換えた備考は残しています。${mode === 'deadline' ? '保存すると、変えた品目がシートに出ている数で置き換わります。' : '提出すると、シートに出ている数と備考で置き換わります。'}`}
        confirmLabel={mode === 'deadline' ? '上書きして保存する' : '上書きして提出する'}
        cancelLabel={mode === 'deadline' ? '保存しないで見直す' : '提出しないで見直す'}
        pendingLabel="保存中…"
        pending={busy}
        onConfirm={async () => {
          // もう一度読み直してから送る。その間にまた変わっていれば、送らずに最新の値で確かめ直す（ダイアログは開いたまま）
          if ((await save(overwrite?.reason ?? null)) === 'changed') throw new Error('changed_again');
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
        pending={busy}
        onSubmit={async (reason) => {
          await save(reason ?? '');
        }}
      />
    </>
  );
}
