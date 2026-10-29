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
  isUnknownOutcome,
  judgeProxyAfterUnknown,
  previousCountsFor,
  sameProxyInput,
  stateChangesSince,
  submitAfterDeadline,
  submitRequests,
  toDeadlineRows,
  toSubmitRows,
  type GroupChanges,
  type GroupRequestState,
  type MatrixRow,
  type ProxyInput,
  type ProxySent,
  type ProxyUnverified,
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
 * 失敗は onError に渡す（呼ぶ側が年度を読み直し、DB が締切後と判断したなら書き方を切り替える）。ただし応答が届かなかった失敗
 * （通信の失敗・タイムアウト。isUnknownOutcome）は自動で送り直さず、未確定の送信（ProxyUnverified）として呼ぶ側に団体ごとに
 * 持ってもらい（シートを閉じても消えない）、団体の申請と提出の記録を読み直して確かめる（2.6。決まりは notes/T11.md の 12）：
 * - 送った値が入っていて、その後に入力を変えていなければ「保存されていました」で閉じる。変えていれば閉じずに「前に送った値は
 *   保存されていました。その後に変えた値はまだ保存していません」と知らせ、読み直した記録を基準にして入力を残す。
 * - 入っておらず、ほかの人の保存もなければ「保存されていませんでした」と知らせて送り直せる状態に戻す。
 * - ほかの人の保存があれば言い切らず、ほかの人の変更のダイアログ（上書きする・見直す）に回す。
 * - 読み直せなければ知らせを残し、「確かめる」まで送信を押せない。
 * シートの基準（比べる記録）は開いたときの表の行で、提出の直前の読み直し・確かめの読み直しのときだけ変える。裏の表の読み直しでは
 * 入力を置き換えない（未確定の間は、届いた行で上の確かめだけを行う）。
 * 未確定の間に閉じるときは「保存されたか分からない」と確かめてから閉じる（呼ぶ側が表を読み直して確かめる）。開き直すと送った入力を戻す。
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
  unverified,
  onUnverifiedChange,
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
  /** この団体の未確定の送信（呼ぶ側が団体ごとに持つ。閉じても消さない） */
  unverified: ProxyUnverified | null;
  onUnverifiedChange: (groupId: string, u: ProxyUnverified | null) => void;
}) {
  /** シートの中の入力の状態（閉じる前に確かめる） */
  const formRef = useRef<FormState>({ dirty: false, busy: false });
  const [busy, setBusy] = useState(false);
  const [askClose, setAskClose] = useState(false);
  const reportState = (st: FormState) => {
    formRef.current = st;
    setBusy(st.busy);
  };
  /** 閉じる操作（外側のクリック・Esc・×・「やめる」）：送信中は閉じず、未保存の入力か未確定の送信があれば確かめる */
  const requestClose = () => {
    if (formRef.current.busy) return;
    if (formRef.current.dirty || unverified) setAskClose(true);
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
            unverified={unverified}
            onUnverifiedChange={(u) => onUnverifiedChange(row.group.id, u)}
          />
        ) : null}
        {unverified ? (
          <ConfirmDialog
            open={askClose}
            onOpenChange={setAskClose}
            title="保存されたか分からないまま閉じますか"
            description="前に送った代理入力が保存されたか、まだ分かりません。閉じると表を読み直して確かめます。確かめるまで、この団体の代理入力は送り直せません（開き直すと送った入力が戻ります。その後に変えた入力は消えます）。"
            confirmLabel="閉じる"
            cancelLabel="シートに戻る"
            onConfirm={() => onOpenChange(false)}
          />
        ) : (
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
        )}
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
  unverified,
  onUnverifiedChange,
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
  /** この団体の未確定の送信（確かめるまで送り直せない。2.6） */
  unverified: ProxyUnverified | null;
  onUnverifiedChange: (u: ProxyUnverified | null) => void;
}) {
  const group = row.group;
  /**
   * シートの基準（比べる団体の申請と提出の記録）。開いたときの表の行で始め、提出の直前の読み直しと確かめの読み直しのときだけ変える
   * （裏の表の読み直しでは変えない。入力を黙って置き換えない。2.6）
   */
  const [base, setBase] = useState<GroupRequestState>(() => groupStateOf(row));
  const requests = base.requests;
  const model = useMemo(() => buildRequestForm(items, group.category, requests), [items, group.category, requests]);
  const savedNote = base.submission?.note ?? '';
  // 未確定の送信がある団体を開き直したときは、送った入力を戻す
  const [edits, setEdits] = useState<Record<string, number>>(() => ({ ...(unverified?.input.counts ?? {}) }));
  /** 書き換えた備考（null なら読み込んだ備考のまま。読み直したら新しい備考になる） */
  const [noteEdit, setNoteEdit] = useState<string | null>(() => unverified?.input.note ?? null);
  const note = noteEdit ?? savedNote;
  const [error, setError] = useState<string | null>(() =>
    unverified ? '前に送った代理入力が保存されたか分かりません。「確かめる」を押して確かめてください' : null,
  );
  /** 確かめた後の知らせ（前に送った値は保存されていた、など） */
  const [info, setInfo] = useState<string | null>(null);
  const [reasonOpen, setReasonOpen] = useState(false);
  const [prevLoading, setPrevLoading] = useState(false);
  /** 提出の直前の読み直しの最中 */
  const [checking, setChecking] = useState(false);
  /**
   * 読み直してほかの人の変更が見つかった（上書きしてよいか確かめる）。変わった品目の「名前（前 → 今）」と、提出の記録が変わったか。
   * afterUnknown は未確定の送信を確かめたときに見つかった（前に送った値が保存されたか決められない）
   */
  const [overwrite, setOverwrite] = useState<{ items: string[]; submission: boolean; afterUnknown: boolean } | null>(null);
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
    mutationFn: (vars: { sent: ProxySent; reason: string }) => submitAfterDeadline(group.id, vars.sent.rows, vars.sent.note, vars.reason),
  });
  const busy = direct.isPending || deadline.isPending || checking;
  /** 今の入力（未確定の送信と比べる。await の後でも最新を読む） */
  const input: ProxyInput = { counts: Object.fromEntries(toSubmitRows(model.fields, edits).map((r) => [r.itemId, r.count])), note };
  const inputRef = useRef(input);
  const busyRef = useRef(busy);
  useEffect(() => {
    inputRef.current = input;
    busyRef.current = busy;
  });
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

  /**
   * 読み直した記録でほかの人の変更が見つかったとき：読み直した記録をシートの基準にし（表の読み直しを待たずに、確かめる値をシートに
   * 出す）、入れた数（前の基準から変えた品目）と書き換えた備考だけを残して、上書きしてよいか確かめる。表も読み直す。
   */
  const askOverwrite = (latest: GroupRequestState, changed: GroupChanges, afterUnknown: boolean) => {
    const current = new Map(model.fields.map((f) => [f.item.id, f.current]));
    setEdits((e) => Object.fromEntries(Object.entries(e).filter(([id, v]) => v !== current.get(id))));
    setNoteEdit((n) => (n === savedNote ? null : n));
    setBase(latest);
    const name = (id: string) => items.find((i) => i.id === id)?.name ?? '（不明な品目）';
    setOverwrite({ items: changed.items.map((c) => `${name(c.itemId)}（${c.from} → ${c.to}）`), submission: changed.submission, afterUnknown });
    // 表も読み直す（シートは読み直した記録で確かめるので、待たない）
    void onReload().catch(() => undefined);
  };

  /**
   * 未確定の送信を、読み直した記録で確かめる（2.6。「確かめる」・送った直後・裏の表の読み直しのどれでも同じ。notes/T11.md の 12）。
   * 印は外す（others ならダイアログで選んでもらう）。
   */
  const settle = async (u: ProxyUnverified, latest: GroupRequestState) => {
    const { verdict, changes } = judgeProxyAfterUnknown(u, latest);
    onUnverifiedChange(null);
    setError(null);
    setInfo(null);
    if (verdict === 'saved') {
      if (sameProxyInput(u.input, inputRef.current)) {
        toast.success(`通信が途切れましたが、${group.name}の申請は保存されていました`);
        await onSaved();
        onClose();
        return;
      }
      // その後に入力を変えていた：閉じずに、保存された記録を基準にして入力を残す（rebased）
      setBase(latest);
      setInfo('前に送った値は保存されていました。その後に変えた値はまだ保存していません。保存するには、もう一度押してください');
      void Promise.resolve(onSaved()).catch(() => undefined);
      return;
    }
    if (verdict === 'not_saved') {
      setBase(latest);
      setError('保存されていませんでした（通信できませんでした）。もう一度押してください');
      return;
    }
    setError('前に送った値が保存されたか決められません（ほかの人がこの団体の申請を保存しました）。最新の値を読み直しました');
    askOverwrite(latest, changes, true);
  };

  /** 未確定の送信を、団体の申請と提出の記録を読み直して確かめる。読み直せなければ印を残し、「確かめる」まで送信を押せない */
  const verify = async (u: ProxyUnverified) => {
    setError(null);
    setInfo(null);
    setChecking(true);
    let latest: GroupRequestState;
    try {
      latest = await fetchGroupRequestState(group.id);
    } catch {
      setChecking(false);
      setError('通信が途切れ、保存できたか確かめられません。通信が戻ったら「確かめる」を押してください');
      return;
    }
    setChecking(false);
    await settle(u, latest);
  };

  /** 応答が届かなかった送信：未確定の印を呼ぶ側に預けて（閉じても消えない）、すぐに読み直して確かめる。自動で送り直さない */
  const onUnknown = async (sent: ProxySent, before: GroupRequestState, sentInput: ProxyInput) => {
    const u: ProxyUnverified = { sent, before, input: sentInput };
    onUnverifiedChange(u);
    await verify(u);
  };

  // 裏の表の読み直し（再接続・ほかの書き込みの後など）で行が届いたら、未確定の間は送った値が入ったかを確かめる。入力は置き換えない
  const lastRow = useRef(row);
  const onRowLoaded = useEffectEvent((r: MatrixRow) => {
    if (unverified && !busyRef.current) void settle(unverified, groupStateOf(r));
  });
  useEffect(() => {
    if (lastRow.current === row) return;
    lastRow.current = row;
    onRowLoaded(row);
  }, [row]);

  /** 締切前の提出。before は送る直前に読み直した記録（応答が届かなかったときに、提出の記録が書き直されたかを比べる） */
  const sendDirect = async (before: GroupRequestState) => {
    setError(null);
    setInfo(null);
    const rows = toSubmitRows(model.fields, edits);
    const sentNote = noteValue();
    const sentInput = input;
    try {
      await direct.mutateAsync({ rows, note: sentNote });
    } catch (e) {
      if (isUnknownOutcome(e)) {
        await onUnknown({ rows, note: sentNote, submissionUpdatedAt: before.submission?.updated_at ?? null, checkRowVersions: false }, before, sentInput);
        return;
      }
      setError(await onError(e, 'submit_requests', group.id));
      return;
    }
    await finish();
  };

  /**
   * 送る直前に団体の申請と提出の記録を読み直し、シートの基準（開いた表の行、確かめた後は前に読み直した記録）と比べる
   * （updated_at・submitted_at・備考）。変わっていなければ送る（'sent'）。変わっていれば送らずに上書きしてよいか確かめる
   * （'changed'。askOverwrite）。読み直せなければ送らない（'error'）。
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
      await sendDirect(latest);
      return 'sent';
    }
    setChecking(false);
    askOverwrite(latest, changed, false);
    return 'changed';
  };

  const onSubmit = async () => {
    if (noteTooLong || busy || unverified) return;
    setError(null);
    setInfo(null);
    if (mode === 'deadline') {
      setReasonOpen(true);
      return;
    }
    await checkAndSend();
  };

  return (
    <>
      <UnsavedChangesGuard when={dirty || unverified !== null} />
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
        {info ? (
          <p role="status" className="rounded-md border border-sky-300 bg-sky-50 px-3 py-2 text-sm text-sky-900 dark:border-sky-800 dark:bg-sky-950 dark:text-sky-100">
            {info}
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
        {unverified ? (
          <Button variant="secondary" disabled={busy} aria-busy={checking || undefined} onClick={() => void verify(unverified)}>
            {checking ? '確かめています…' : '確かめる'}
          </Button>
        ) : null}
        <Button disabled={busy || noteTooLong || unverified !== null} aria-busy={busy || undefined} onClick={() => void onSubmit()}>
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
        description={`${overwrite?.afterUnknown ? '前に送った値が保存されたかは決められません（その間に、ほかの人がこの団体の申請を保存しました）。' : 'シートを開いた後に、ほかの人がこの団体の申請を変えました。'}最新の値を読み直し、入れた数（色のついた欄）と書き換えた備考は残しています。${mode === 'deadline' ? '保存すると、変えた品目がシートに出ている数で置き換わります（理由を入れます）。' : '提出すると、シートに出ている数と備考で置き換わります。'}`}
        confirmLabel={mode === 'deadline' ? '上書きして保存する' : '上書きして提出する'}
        cancelLabel={mode === 'deadline' ? '保存しないで見直す' : '提出しないで見直す'}
        pendingLabel="保存中…"
        pending={direct.isPending || checking}
        onConfirm={async () => {
          // 締切後は理由を入れて保存する（行ごとの楽観ロックは読み直した記録の値）
          if (mode === 'deadline') {
            setReasonOpen(true);
            return;
          }
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
          setError(null);
          setInfo(null);
          const before = base;
          const sentInput = input;
          const sent: ProxySent = {
            rows: toDeadlineRows(model.fields, edits),
            ...(noteChanged ? { note: noteValue() } : {}),
            submissionUpdatedAt: base.submission?.updated_at ?? null,
            checkRowVersions: true,
          };
          try {
            await deadline.mutateAsync({ sent, reason: reason ?? '' });
          } catch (e) {
            if (isUnknownOutcome(e)) {
              // 理由のダイアログは閉じ、シートで確かめる（自動で送り直さない）
              void onUnknown(sent, before, sentInput);
              return;
            }
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
