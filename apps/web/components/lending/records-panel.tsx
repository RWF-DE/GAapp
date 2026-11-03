'use client';

// 受け渡し・返却の団体の欄（04「受け渡し・返却」の団体の欄と保存、notes/T21.md「画面の約束」5。T21・D-57）。スマホ（幅 390px）。
// - 備品ごとに「割り当て N {単位}」（確定前も出す）と、「渡した」「返った」「うち破損」の ＋－ と数字の欄（44px。数字のキーボード）、
//   破損が1以上（かメモがある）ならメモの欄。「割り当てどおり渡した」「全部返った」と、下に固定の「保存」。
// - 保存（設計 2.6 の (A)。在庫入力と同じ形）：送る前にその団体の記録を読み直して decideLendingRecordSave で決める。入力と同じなら
//   送らずに「保存されていました」、入力を始めた後にほかの人が保存していれば相手と自分の数を並べて「上書きする」「読み直す」を選んで
//   もらう。割り当てより多く渡す備品（入力を始めた後に渡した数を増やしたもの）があれば、送る前に確かめる（事実の記録は止めない）。
//   最新でない年度は保存の前に確かめる。送るのは欄に出した備品の全部の行（0 を含む）の upsert。応答が届かなければ入力を残して
//   「保存できたか分かりません…」（確かめるための状態は持たない。もう一度押せば読み直して決まる）。
// - 入力を始めた後は、裏で届いた行（読み直し）で入力を置き換えない（入力の元〔base〕も変えない）。入力は下書きに置き（入力の元の版も）、
//   離れるとき・年度を切り替えるときに確かめる。
import { useQueryClient } from '@tanstack/react-query';
import { AlertTriangle, CheckCircle2 } from 'lucide-react';
import { useEffect, useMemo, useRef, useState } from 'react';
import { toast } from 'sonner';
import { ConfirmDialog } from '@/components/common/confirm-dialog';
import { CountStepper } from '@/components/common/count-stepper';
import { DraftNotice } from '@/components/common/draft-notice';
import { useNotLatestYearConfirm } from '@/components/common/latest-year';
import { Button } from '@/components/ui/button';
import { Label } from '@/components/ui/label';
import { Textarea } from '@/components/ui/textarea';
import {
  AlertDialog,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
} from '@/components/ui/alert-dialog';
import { useAuthErrorHandler } from '@/lib/auth/guarded';
import {
  decideLendingRecordSave,
  invalidateLending,
  lendingRecordsOptions,
  readGroupRecords,
  recordValuesOf,
  saveLendingRecords,
  type LendingRecordWrite,
  type LendingRecordWriteValues,
} from '@/lib/data/lending';
import type { YearRow } from '@/lib/db/types';
import { createDraftWriter, loadDraft, removeDraft, type DraftKey } from '@/lib/drafts';
import { classifyError, effectOf, isUnknownOutcome, messageFor, unknownOutcomeMessage } from '@/lib/errors';
import { sortLendingItems } from '@/lib/modules/lending/counts';
import type { LendingGroup, LendingRecordRow, LendingRecordsData } from '@/lib/modules/lending/queries';
import { checkLendingRecord, LENDING_NOTE_MAX, type LendingRecordErrors } from '@/lib/schemas/lending';
import { useUnsavedChanges } from '@/lib/unsaved-changes';
import { cn } from '@/lib/utils';
import { GroupPlace, groupDisplayName } from './common';

/** 入力の値（備品の id → 渡した・返った・破損・メモ） */
type Values = Record<string, { lent: number; returned: number; damaged: number; note: string }>;
/** 入力の元の版（備品の id → 行の updated_at。行がなければ null） */
type Stamps = Record<string, string | null>;

/** 衝突のダイアログの文（04「受け渡し・返却」） */
export const RECORDS_CONFLICT_TITLE = '入力を始めた後に、ほかの人がこの団体の記録を保存しました';

const valuesOf = (itemIds: readonly string[], rows: readonly LendingRecordRow[]): Values => {
  const byItem = new Map(rows.map((r) => [r.lending_item_id, r]));
  return Object.fromEntries(
    itemIds.map((id) => {
      const r = byItem.get(id);
      return [id, { lent: r?.lent_count ?? 0, returned: r?.returned_count ?? 0, damaged: r?.damaged_count ?? 0, note: r?.note ?? '' }];
    }),
  );
};
const stampsOf = (itemIds: readonly string[], rows: readonly LendingRecordRow[]): Stamps => {
  const byItem = new Map(rows.map((r) => [r.lending_item_id, r.updated_at]));
  return Object.fromEntries(itemIds.map((id) => [id, byItem.get(id) ?? null]));
};
const writeValuesOf = (v: Values[string]): LendingRecordWriteValues => ({ lent_count: v.lent, returned_count: v.returned, damaged_count: v.damaged, note: v.note });
const sameValues = (a: Values, b: Values, itemIds: readonly string[]) =>
  itemIds.every((id) => {
    const x = a[id];
    const y = b[id];
    return !!x && !!y && x.lent === y.lent && x.returned === y.returned && x.damaged === y.damaged && x.note.trim() === y.note.trim();
  });

interface RecordsDraft {
  values: Values;
  base: Stamps;
}

function normalizeRecordsDraft(v: unknown, itemIds: readonly string[]): RecordsDraft | null {
  if (!v || typeof v !== 'object') return null;
  const { values, base } = v as { values?: unknown; base?: unknown };
  if (!values || typeof values !== 'object' || !base || typeof base !== 'object') return null;
  const out: RecordsDraft = { values: {}, base: {} };
  for (const id of itemIds) {
    const x = (values as Record<string, unknown>)[id] as Record<string, unknown> | undefined;
    const b = (base as Record<string, unknown>)[id];
    if (!x || typeof x !== 'object') return null;
    const { lent, returned, damaged, note } = x;
    if (![lent, returned, damaged].every((n) => typeof n === 'number' && Number.isInteger(n))) return null;
    if (typeof note !== 'string') return null;
    if (b !== null && b !== undefined && typeof b !== 'string') return null;
    out.values[id] = { lent: lent as number, returned: returned as number, damaged: damaged as number, note };
    out.base[id] = (b as string | null | undefined) ?? null;
  }
  return out;
}

interface Conflict {
  fresh: LendingRecordRow[];
  /** 「保存」を押したときの入力（「上書きする」はこれを送る） */
  values: Values;
}

export interface RecordsPanelProps {
  data: LendingRecordsData;
  group: LendingGroup;
  year: YearRow;
  userId: string;
  /** 書けるか（総務で、年度が終了していない） */
  writable: boolean;
  /** 一覧へ戻る（未保存の入力があれば確かめる） */
  onBack: () => void;
  /** 年度の行と立場を読み直す（forbidden の後） */
  onReloadMembership: () => void;
}

export function RecordsPanel({ data, group, year, userId, writable, onBack, onReloadMembership }: RecordsPanelProps) {
  const queryClient = useQueryClient();
  const onAuthError = useAuthErrorHandler();
  const notLatest = useNotLatestYearConfirm();
  const items = useMemo(() => sortLendingItems(data.items), [data.items]);
  const itemIds = useMemo(() => items.map((i) => i.id), [items]);
  const rows = useMemo(() => data.records.filter((r) => r.group_id === group.id), [data.records, group.id]);
  const assigned = useMemo(() => new Map(data.assignments.filter((a) => a.group_id === group.id).map((a) => [a.lending_item_id, a.count])), [data.assignments, group.id]);
  const confirmed = !!data.confirmedAt;

  // 入力の元（行の値と版）と入力。入力を始めた後（held）は、裏で届いた行で置き換えない
  const [base, setBase] = useState<{ values: Values; stamps: Stamps }>(() => ({ values: valuesOf(itemIds, rows), stamps: stampsOf(itemIds, rows) }));
  const [values, setValues] = useState<Values>(() => valuesOf(itemIds, rows));
  const [held, setHeld] = useState(false);
  const [seen, setSeen] = useState(rows);
  if (rows !== seen) {
    setSeen(rows);
    if (!held) {
      setBase({ values: valuesOf(itemIds, rows), stamps: stampsOf(itemIds, rows) });
      setValues(valuesOf(itemIds, rows));
    }
  }
  const [errors, setErrors] = useState<Record<string, LendingRecordErrors>>({});
  const [phase, setPhase] = useState<'idle' | 'checking' | 'saving'>('idle');
  const [notice, setNotice] = useState<{ kind: 'unknown' | 'error'; message: string } | null>(null);
  const [savedAt, setSavedAt] = useState<{ kind: 'saved' | 'recovered' } | null>(null);
  const [conflict, setConflict] = useState<Conflict | null>(null);
  const [overAsk, setOverAsk] = useState<{ lines: string[]; resolve: (ok: boolean) => void } | null>(null);
  const mounted = useRef(true);
  useEffect(() => {
    mounted.current = true;
    return () => {
      mounted.current = false;
    };
  }, []);

  const dirty = writable && !sameValues(values, base.values, itemIds);
  useUnsavedChanges(dirty);

  // 下書き（団体ごと）
  const draftKeyValue: DraftKey = useMemo(() => ({ userId, yearId: year.id, screen: 'lending-records', target: group.id }), [userId, year.id, group.id]);
  const writer = useMemo(() => createDraftWriter<RecordsDraft>(draftKeyValue), [draftKeyValue]);
  const [draft, setDraft] = useState(() => {
    const d = loadDraft<unknown>(draftKeyValue);
    const v = d ? normalizeRecordsDraft(d.value, itemIds) : null;
    return d && v && !sameValues(v.values, valuesOf(itemIds, rows), itemIds) ? { value: v, savedAt: d.savedAt } : null;
  });
  useEffect(() => () => writer.flush(), [writer]);

  const change = (itemId: string, patch: Partial<Values[string]>) => {
    const cur = values[itemId];
    if (!cur) return;
    const next = { ...values, [itemId]: { ...cur, ...patch } };
    setValues(next);
    setHeld(true);
    setDraft(null);
    setSavedAt(null);
    if (sameValues(next, base.values, itemIds)) writer.clear();
    else writer.write({ values: next, base: base.stamps });
  };
  const setAll = (f: (id: string, v: Values[string]) => Values[string]) => {
    const next: Values = Object.fromEntries(itemIds.map((id) => [id, f(id, values[id]!)]));
    setValues(next);
    setHeld(true);
    setDraft(null);
    setSavedAt(null);
    if (sameValues(next, base.values, itemIds)) writer.clear();
    else writer.write({ values: next, base: base.stamps });
  };
  /** 割り当てどおり渡した：渡した数を割り当ての数にする（返った・破損は渡した数を超えないよう下げる） */
  const lendAll = () =>
    setAll((id, v) => {
      const lent = assigned.get(id) ?? 0;
      const returned = Math.min(v.returned, lent);
      return { ...v, lent, returned, damaged: Math.min(v.damaged, returned) };
    });
  /** 全部返った：返った数を渡した数にする */
  const returnAll = () => setAll((_id, v) => ({ ...v, returned: v.lent }));

  const recordsKey = lendingRecordsOptions(year.id).queryKey;
  /** 保存が決まった：その団体の行をキャッシュに入れ、入力を行の値にする */
  const finish = (fresh: LendingRecordRow[], kind: 'saved' | 'recovered') => {
    queryClient.setQueryData<LendingRecordsData>(recordsKey, (old) => (old ? { ...old, records: [...old.records.filter((r) => r.group_id !== group.id), ...fresh] } : old));
    setSeen(fresh);
    setBase({ values: valuesOf(itemIds, fresh), stamps: stampsOf(itemIds, fresh) });
    setValues(valuesOf(itemIds, fresh));
    setHeld(false);
    setNotice(null);
    setErrors({});
    writer.clear();
    setDraft(null);
    setSavedAt({ kind });
    toast.success(kind === 'recovered' ? '保存されていました' : '保存しました');
    invalidateLending(queryClient, year.id);
  };

  /** ほかの人の数を入力にする（ダイアログの「読み直す」） */
  const adopt = (fresh: LendingRecordRow[]) => {
    queryClient.setQueryData<LendingRecordsData>(recordsKey, (old) => (old ? { ...old, records: [...old.records.filter((r) => r.group_id !== group.id), ...fresh] } : old));
    setSeen(fresh);
    setBase({ values: valuesOf(itemIds, fresh), stamps: stampsOf(itemIds, fresh) });
    setValues(valuesOf(itemIds, fresh));
    setHeld(false);
    setNotice(null);
    writer.clear();
    toast.info('ほかの人が保存した数を読み直しました');
  };

  const handleError = async (e: unknown) => {
    const c = classifyError(e);
    if (c.kind === 'auth') {
      await onAuthError(e);
      return;
    }
    if (isUnknownOutcome(e)) {
      setNotice({ kind: 'unknown', message: unknownOutcomeMessage() });
      return;
    }
    const effect = effectOf(c);
    if (effect.reload === 'year') onReloadMembership();
    if (effect.reload !== 'none' || c.kind === 'blocked') invalidateLending(queryClient, year.id);
    setNotice({ kind: 'error', message: messageFor(c, { table: 'lending_records' }) });
  };

  /** values を送る（fresh は送る前に読み直した行。入力の元にする） */
  const send = async (v: Values, fresh: LendingRecordRow[]) => {
    setBase({ values: valuesOf(itemIds, fresh), stamps: stampsOf(itemIds, fresh) });
    setPhase('saving');
    const out: LendingRecordWrite[] = itemIds.map((id) => ({ group_id: group.id, lending_item_id: id, year_id: year.id, ...writeValuesOf(v[id]!) }));
    try {
      let saved: LendingRecordRow[];
      try {
        saved = await saveLendingRecords(out);
      } catch (e) {
        if (classifyError(e).kind === 'auth' && (await onAuthError(e)) === 'retry') saved = await saveLendingRecords(out);
        else throw e;
      }
      if (mounted.current) finish(saved, 'saved');
    } catch (e) {
      if (mounted.current) await handleError(e);
    } finally {
      if (mounted.current) setPhase('idle');
    }
  };

  /** 割り当てより多く渡す備品（入力を始めた後に渡した数を変えたもの）を確かめる */
  const askOverAssigned = (v: Values): Promise<boolean> => {
    const lines = items.flatMap((it) => {
      const x = v[it.id]!;
      const a = assigned.get(it.id) ?? 0;
      return x.lent > a && x.lent !== base.values[it.id]?.lent ? [`${it.name}（割り当て ${a}・渡した ${x.lent}）`] : [];
    });
    if (lines.length === 0) return Promise.resolve(true);
    return new Promise((resolve) => setOverAsk({ lines, resolve }));
  };

  const save = async () => {
    if (!writable || phase !== 'idle') return;
    setHeld(true);
    const errs: Record<string, LendingRecordErrors> = {};
    for (const id of itemIds) {
      const e = checkLendingRecord(values[id]!);
      if (Object.keys(e).length > 0) errs[id] = e;
    }
    setErrors(errs);
    if (Object.keys(errs).length > 0) return;
    writer.flush();
    if (!(await notLatest.confirmBeforeWrite())) return;
    const v = values;
    if (!(await askOverAssigned(v))) return;
    setPhase('checking');
    let fresh: LendingRecordRow[];
    try {
      fresh = await readGroupRecords(year.id, group.id);
    } catch (e) {
      if (mounted.current) {
        setPhase('idle');
        await handleError(e);
      }
      return;
    }
    if (!mounted.current) return;
    // 入力の元の行（版のある備品だけ。行のなかった備品は、読み直して行があれば変わったとみる）
    const baseRows: LendingRecordRow[] = itemIds.flatMap((id) => {
      const stamp = base.stamps[id];
      const b = base.values[id]!;
      return stamp
        ? [{ group_id: group.id, lending_item_id: id, lent_count: b.lent, returned_count: b.returned, damaged_count: b.damaged, note: b.note || null, updated_by: null, updated_at: stamp }]
        : [];
    });
    const decision = decideLendingRecordSave({
      itemIds,
      values: Object.fromEntries(itemIds.map((id) => [id, writeValuesOf(v[id]!)])),
      base: baseRows,
      fresh,
      userId,
    });
    if (decision === 'saved') {
      setPhase('idle');
      finish(fresh, 'recovered');
      return;
    }
    if (decision === 'conflict') {
      setPhase('idle');
      setNotice(null);
      setConflict({ fresh, values: v });
      return;
    }
    await send(v, fresh);
  };

  const panelNotice = notice ? (
    <div role="alert" data-testid="records-error" data-kind={notice.kind} className="flex gap-2 rounded-md border border-destructive/40 bg-destructive/5 px-4 py-3 text-sm">
      <AlertTriangle aria-hidden className="mt-0.5 size-4 shrink-0 text-destructive" />
      <div className="space-y-1">
        <p className="font-medium text-destructive">{notice.message}</p>
        {notice.kind === 'unknown' ? <p className="text-xs text-muted-foreground">入力はそのまま残しています。</p> : null}
      </div>
    </div>
  ) : null;

  const busy = phase !== 'idle';
  return (
    <section data-testid="records-panel" data-group-id={group.id} aria-labelledby="records-panel-name" className="space-y-3">
      <div className="flex items-start gap-3">
        <div className="min-w-0 flex-1">
          <h2 id="records-panel-name" className="text-xl font-bold [overflow-wrap:anywhere]">
            {groupDisplayName(group)}
          </h2>
          <GroupPlace group={group} className="text-sm" />
        </div>
        <Button variant="outline" onClick={onBack} className="h-11 shrink-0">
          一覧へ
        </Button>
      </div>
      {draft && writable ? (
        <DraftNotice
          savedAt={draft.savedAt}
          onRestore={() => {
            setValues(draft.value.values);
            setBase((b) => ({ ...b, stamps: draft.value.base }));
            setHeld(true);
            setDraft(null);
          }}
          onDiscard={() => {
            writer.cancel();
            removeDraft(draftKeyValue);
            setDraft(null);
          }}
        />
      ) : null}
      {panelNotice}
      {savedAt ? (
        <p role="status" data-testid="records-saved" className="flex items-center gap-2 rounded-md border border-emerald-300 bg-emerald-50 px-4 py-2 text-sm text-emerald-950">
          <CheckCircle2 aria-hidden className="size-4" />
          {savedAt.kind === 'recovered' ? '保存されていました' : '保存しました'}
        </p>
      ) : null}
      {writable ? (
        <div className="flex flex-wrap gap-2">
          <Button variant="outline" className="h-11" data-testid="records-lend-all" onClick={lendAll} disabled={busy}>
            割り当てどおり渡した
          </Button>
          <Button variant="outline" className="h-11" data-testid="records-return-all" onClick={returnAll} disabled={busy}>
            全部返った
          </Button>
        </div>
      ) : null}
      <ul className="space-y-3">
        {items.map((it) => {
          const v = values[it.id]!;
          const e = errors[it.id] ?? {};
          const a = assigned.get(it.id);
          const showNote = v.damaged > 0 || v.note.trim() !== '';
          const noteId = `records-note-${it.id}`;
          return (
            <li key={it.id} data-testid="records-item" data-item-id={it.id} className="space-y-2 rounded-lg border p-3">
              <div className="flex flex-wrap items-baseline justify-between gap-2">
                <p className="font-semibold [overflow-wrap:anywhere]">{it.name}</p>
                <p className={cn('text-sm', !confirmed && 'text-muted-foreground')} data-testid="records-assigned">
                  割り当て {a ?? 0} {it.unit}
                  {!confirmed ? '（確定前）' : ''}
                </p>
              </div>
              <CountRow
                testId="records-lent"
                label="渡した"
                fullLabel={`${it.name}の渡した数`}
                value={v.lent}
                disabled={!writable || busy}
                error={e.lent}
                onChange={(n) => change(it.id, { lent: n })}
              />
              <CountRow
                testId="records-returned"
                label="返った"
                fullLabel={`${it.name}の返った数`}
                value={v.returned}
                disabled={!writable || busy}
                error={e.returned}
                onChange={(n) => change(it.id, { returned: n })}
              />
              <CountRow
                testId="records-damaged"
                label="うち破損"
                fullLabel={`${it.name}の破損の数`}
                value={v.damaged}
                disabled={!writable || busy}
                error={e.damaged}
                onChange={(n) => change(it.id, { damaged: n })}
              />
              {showNote ? (
                <div className="space-y-1">
                  <Label htmlFor={noteId}>破損のメモ（任意）</Label>
                  <Textarea
                    id={noteId}
                    data-testid="records-note"
                    rows={2}
                    value={v.note}
                    maxLength={LENDING_NOTE_MAX * 2}
                    disabled={!writable || busy}
                    aria-invalid={e.note ? true : undefined}
                    onChange={(ev) => change(it.id, { note: ev.target.value })}
                  />
                  {e.note ? <p className="text-sm text-destructive">{e.note}</p> : null}
                </div>
              ) : null}
            </li>
          );
        })}
      </ul>
      {writable ? (
        <div className="sticky bottom-0 z-10 -mx-4 border-t bg-background/95 px-4 py-3 backdrop-blur md:-mx-6 md:px-6 print:hidden">
          {dirty ? <p className="mb-2 text-xs text-amber-700">保存していない変更があります</p> : null}
          <Button data-testid="records-save" size="lg" className="h-12 w-full text-base" onClick={() => void save()} disabled={busy} aria-busy={busy || undefined}>
            {phase === 'saving' ? '保存中…' : phase === 'checking' ? '確かめています…' : '保存'}
          </Button>
        </div>
      ) : null}
      {notLatest.dialog}
      <ConfirmDialog
        open={overAsk !== null}
        onOpenChange={(o) => {
          if (!o && overAsk) {
            overAsk.resolve(false);
            setOverAsk(null);
          }
        }}
        title="割り当てより多く渡します"
        description="事実の記録は止めません。数を確かめてから記録してください。"
        confirmLabel="記録する"
        onConfirm={() => {
          overAsk?.resolve(true);
          setOverAsk(null);
        }}
      >
        {overAsk ? (
          <p data-testid="records-over-assigned" className="text-sm">
            割り当てより多く渡します：{overAsk.lines.join('・')}。記録してよいですか
          </p>
        ) : null}
      </ConfirmDialog>
      <AlertDialog open={conflict !== null} onOpenChange={(o) => (!o ? setConflict(null) : undefined)}>
        <AlertDialogContent data-testid="records-conflict">
          <AlertDialogHeader>
            <AlertDialogTitle>{RECORDS_CONFLICT_TITLE}</AlertDialogTitle>
            <AlertDialogDescription>上書きするか、ほかの人の数を読み直すかを選んでください。</AlertDialogDescription>
          </AlertDialogHeader>
          {conflict ? (
            <table className="w-full text-sm">
              <thead>
                <tr className="border-b text-left text-muted-foreground">
                  <th className="py-1 font-normal">備品</th>
                  {/* 2つの数の列の間をあける（スマホの幅で「渡1・返0・破0渡2・…」と続いて読めた。撮影で見つけた） */}
                  <th className="py-1 pl-3 text-right font-normal whitespace-nowrap">ほかの人</th>
                  <th className="py-1 pl-3 text-right font-normal whitespace-nowrap">あなた</th>
                </tr>
              </thead>
              <tbody>
                {items.map((it) => {
                  const theirs = recordValuesOf(conflict.fresh.find((r) => r.lending_item_id === it.id));
                  const mine = conflict.values[it.id]!;
                  const fmt = (l: number, r: number, d: number) => `渡${l}・返${r}・破${d}`;
                  const differs = theirs.lent_count !== mine.lent || theirs.returned_count !== mine.returned || theirs.damaged_count !== mine.damaged;
                  return (
                    <tr key={it.id} data-testid="records-conflict-row" className={cn('border-b last:border-0', differs && 'font-semibold')}>
                      <td className="py-1">{it.name}</td>
                      <td className="py-1 pl-3 text-right tabular-nums whitespace-nowrap">{fmt(theirs.lent_count, theirs.returned_count, theirs.damaged_count)}</td>
                      <td className="py-1 pl-3 text-right tabular-nums whitespace-nowrap">{fmt(mine.lent, mine.returned, mine.damaged)}</td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          ) : null}
          <AlertDialogFooter>
            <AlertDialogCancel variant="ghost">やめる</AlertDialogCancel>
            <Button
              variant="outline"
              onClick={() => {
                if (conflict) adopt(conflict.fresh);
                setConflict(null);
              }}
            >
              読み直す
            </Button>
            <Button
              variant="destructive"
              onClick={() => {
                const c = conflict;
                setConflict(null);
                if (c) void send(c.values, c.fresh);
              }}
            >
              上書きする
            </Button>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </section>
  );
}

/** 1つの数の行（ラベル・＋－と数字〔44px〕・欄の下の誤り） */
function CountRow({
  testId,
  label,
  fullLabel,
  value,
  disabled,
  error,
  onChange,
}: {
  testId: string;
  label: string;
  fullLabel: string;
  value: number;
  disabled: boolean;
  error?: string;
  onChange: (n: number) => void;
}) {
  return (
    <div data-testid={testId} className="space-y-1">
      <div className="flex items-center justify-between gap-2">
        <span className="text-sm">{label}</span>
        <CountStepper size="lg" label={fullLabel} value={value} onChange={onChange} disabled={disabled} />
      </div>
      {error ? (
        <p data-field-error className="text-right text-sm text-destructive">
          {error}
        </p>
      ) : null}
    </div>
  );
}
