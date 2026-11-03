'use client';

// 備品の登録・編集のダイアログ（04「備品と割り当て」の備品の登録・編集、notes/T21.md「画面の約束」4・9。T21・D-57）。部門長以上だけが
// 開く（終了した年度を除く）。
// - 欄：名前（前後の空白を除いて 1〜100 字）・単位（1〜10 字。既定「個」）・在庫（0〜10000 の整数）・申請できる区分（模擬店・部門・企業・
//   休憩所。既定は模擬店・部門。0 個もよい）・並び（整数。既定は今の最大＋1）。送る前に lib/schemas/lending.ts で確かめる。
// - 登録はダイアログを開いたときに作った id で insert する（閉じるまで同じ id。(B1)：送り直しは 23505 で止まる）。編集は読んだときの
//   updated_at の文字列のまま条件に入れて全部の欄を置き換える。応答が届かない・止められたときは runLendingItemSave（lib/data/lending.ts）。
//   23505 で id の行がなければ同じ名前の別の行（「同じ名前の備品がすでにあります」を名前の欄に出す）。
// - 入力は下書きに置き（登録はダイアログの id、編集は読んだときの updated_at も）、開き直したときに戻せる。閉じる前・アプリの中で
//   移る前・年度を切り替える前に確かめる（UnsavedChangesGuard）。
import { useQueryClient } from '@tanstack/react-query';
import { GROUP_CATEGORIES, type GroupCategory } from '@gaapp/shared';
import { useEffect, useId, useMemo, useState } from 'react';
import { toast } from 'sonner';
import { ConfirmDialog } from '@/components/common/confirm-dialog';
import { DraftNotice } from '@/components/common/draft-notice';
import { ErrorBanner } from '@/components/common/error-banner';
import { UnsavedChangesGuard } from '@/components/common/unsaved-changes-guard';
import { Button } from '@/components/ui/button';
import { Checkbox } from '@/components/ui/checkbox';
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from '@/components/ui/dialog';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { useAuthErrorHandler } from '@/lib/auth/guarded';
import {
  insertLendingItems,
  invalidateLending,
  newLendingId,
  readLendingItem,
  runLendingItemSave,
  updateLendingItem,
  type LendingItemRow,
  type LendingItemSaveResult,
} from '@/lib/data/lending';
import { createDraftWriter, loadDraft, removeDraft, type DraftKey } from '@/lib/drafts';
import { classifyError, effectOf, messageFor, unknownOutcomeMessage } from '@/lib/errors';
import { CATEGORY_LABELS } from '@/lib/labels';
import {
  checkLendingItemForm,
  emptyLendingItemForm,
  LENDING_ITEM_NAME_MAX,
  LENDING_UNIT_MAX,
  lendingItemFormValuesOf,
  normalizeCategories,
  sameLendingItemWrite,
  type LendingItemFormErrors,
  type LendingItemFormValues,
} from '@/lib/schemas/lending';

/** 開いているダイアログ：登録（並びの既定つき）か、備品の編集 */
export type LendingItemTarget = { type: 'new'; nextSortOrder: number } | { type: 'edit'; item: LendingItemRow };

export interface LendingItemDialogProps {
  target: LendingItemTarget | null;
  onClose: () => void;
  yearId: string;
  userId: string;
  /** 書けるか（部門長以上で、年度が終了していない） */
  writable: boolean;
  /** 保存・登録した行を一覧に入れる */
  onSaved: (row: LendingItemRow) => void;
  /** 一覧を読み直す */
  onReload: () => void;
  /** 年度の行と立場を読み直す（forbidden の後） */
  onReloadMembership: () => void;
}

/** ほかの人が先に変えた（読み直した行を入力の元にして入力を残す） */
export const ITEM_CONFLICT_NOTICE =
  'ほかの人がこの備品を先に変えました。読み直しました。入力は残してあります。確かめてから、もう一度「保存」を押してください（押すと、この入力で上書きします）';
/** 保存の間に備品が消えた */
export const ITEM_MISSING_MESSAGE = 'この備品は見つかりません（ほかの人が削除した可能性があります）';
/** 止められた後に読み直せなかった */
export const ITEM_REREAD_FAILED = 'ほかの人が先に変えた可能性がありますが、読み直せませんでした。「読み直す」を押してから、もう一度保存してください';
/** 送るボタンを押せないとき */
export const ITEM_CANNOT_SAVE = '今の立場・年度の状態では保存できません';

type SubmitState =
  | { type: 'conflict'; row: LendingItemRow }
  | { type: 'missing' }
  | { type: 'unknown'; message: string }
  | { type: 'unread' }
  | { type: 'error'; error: unknown };

/** 下書きの値 */
interface ItemDraft {
  values: LendingItemFormValues;
  /** 送る先の id（登録はダイアログで作った id） */
  id: string;
  /** 編集の版（読んだときの updated_at）。登録は null */
  baseUpdatedAt: string | null;
}

const isRecord = (v: unknown): v is Record<string, unknown> => typeof v === 'object' && v !== null && !Array.isArray(v);

/** 下書きの形を確かめる（形が違えば戻さない） */
export function normalizeItemDraft(v: unknown): ItemDraft | null {
  if (!isRecord(v) || !isRecord(v.values) || typeof v.id !== 'string') return null;
  const { name, unit, stock, categories, sortOrder } = v.values;
  for (const s of [name, unit, stock, sortOrder]) if (typeof s !== 'string') return null;
  if (!Array.isArray(categories) || !categories.every((c) => typeof c === 'string')) return null;
  if (v.baseUpdatedAt !== null && typeof v.baseUpdatedAt !== 'string') return null;
  return {
    values: { name: name as string, unit: unit as string, stock: stock as string, categories: normalizeCategories(categories as string[]), sortOrder: sortOrder as string },
    id: v.id,
    baseUpdatedAt: v.baseUpdatedAt,
  };
}

export function LendingItemDialog(props: LendingItemDialogProps) {
  const { target } = props;
  const key = target ? (target.type === 'edit' ? `edit:${target.item.id}` : 'new') : 'closed';
  return (
    <Dialog open={target !== null} onOpenChange={() => undefined}>
      {target ? <ItemForm key={key} {...props} target={target} /> : null}
    </Dialog>
  );
}

type Mode = { type: 'new'; id: string } | { type: 'edit'; id: string };

function ItemForm({ target, onClose, yearId, userId, writable, onSaved, onReload, onReloadMembership }: LendingItemDialogProps & { target: LendingItemTarget }) {
  const queryClient = useQueryClient();
  const onAuthError = useAuthErrorHandler();
  const editing = target.type === 'edit' ? target.item : null;
  const [mode, setMode] = useState<Mode>(() => (editing ? { type: 'edit', id: editing.id } : { type: 'new', id: newLendingId() }));
  const initial = useMemo<LendingItemFormValues>(
    () => (editing ? lendingItemFormValuesOf(editing) : emptyLendingItemForm(target.type === 'new' ? target.nextSortOrder : 0)),
    [editing, target],
  );
  const [values, setValues] = useState<LendingItemFormValues>(initial);
  const [errors, setErrors] = useState<LendingItemFormErrors>({});
  const [submit, setSubmit] = useState<SubmitState | null>(null);
  const [pending, setPending] = useState(false);
  const [rereading, setRereading] = useState(false);
  const [discardOpen, setDiscardOpen] = useState(false);
  const [forbidden, setForbidden] = useState(false);
  const [lockUpdatedAt, setLockUpdatedAt] = useState<string | null>(editing?.updated_at ?? null);
  const [savedRow, setSavedRow] = useState<LendingItemRow | null>(editing);
  const baseId = useId();

  const draftKeyValue: DraftKey = useMemo(() => ({ userId, yearId, screen: 'lending-item', target: editing ? editing.id : 'new' }), [userId, yearId, editing]);
  const writer = useMemo(() => createDraftWriter<ItemDraft>(draftKeyValue), [draftKeyValue]);
  const [draft, setDraft] = useState(() => {
    const d = loadDraft<unknown>(draftKeyValue);
    const value = d ? normalizeItemDraft(d.value) : null;
    return d && value ? { value, savedAt: d.savedAt } : null;
  });
  useEffect(() => () => writer.flush(), [writer]);

  const isNew = mode.type === 'new';
  const dirty = useMemo(() => JSON.stringify(values) !== JSON.stringify(initial), [values, initial]);
  const mustSend = submit?.type === 'unknown' || submit?.type === 'unread';
  const blocked = !writable || forbidden;
  const busy = pending || rereading;

  const writeDraft = (next: LendingItemFormValues, m: Mode = mode, base: string | null = lockUpdatedAt) => {
    if (draft) return;
    if (JSON.stringify(next) === JSON.stringify(initial)) writer.clear();
    else writer.write({ values: next, id: m.id, baseUpdatedAt: m.type === 'edit' ? base : null });
  };
  const update = (patch: Partial<LendingItemFormValues>) => {
    const next = { ...values, ...patch };
    setValues(next);
    writeDraft(next);
  };
  const toggleCategory = (c: GroupCategory, on: boolean) => {
    const set = new Set(values.categories);
    if (on) set.add(c);
    else set.delete(c);
    update({ categories: normalizeCategories([...set]) });
  };

  const requestClose = () => {
    if (busy) return;
    if (dirty) setDiscardOpen(true);
    else {
      writer.cancel();
      onClose();
    }
  };

  const finish = (row: LendingItemRow, before: boolean) => {
    onSaved(row);
    invalidateLending(queryClient, yearId);
    writer.clear();
    toast.success(isNew ? (before ? `「${row.name}」は登録されていました` : `「${row.name}」を登録しました`) : before ? '保存されていました' : `「${row.name}」を保存しました`);
    onClose();
  };

  const settle = (result: LendingItemSaveResult) => {
    switch (result.type) {
      case 'saved':
        finish(result.row, result.before);
        return;
      case 'conflict': {
        // 読み直した行を入力の元にする（次の保存はその版で送り、この入力で上書きする。登録の 23505 なら、その備品の編集に切り替える）
        const m: Mode = { type: 'edit', id: result.row.id };
        setMode(m);
        setLockUpdatedAt(result.row.updated_at);
        setSavedRow(result.row);
        setSubmit({ type: 'conflict', row: result.row });
        if (!draft) writer.write({ values, id: m.id, baseUpdatedAt: result.row.updated_at });
        onReload();
        return;
      }
      case 'duplicate':
        setErrors((e) => ({ ...e, name: messageFor(classifyError(result.error), { table: 'lending_items' }) }));
        return;
      case 'missing':
        setSubmit({ type: 'missing' });
        onReload();
        return;
      case 'unknown':
        setSubmit({ type: 'unknown', message: unknownOutcomeMessage(isNew ? '登録' : '保存') });
        return;
      case 'unread':
        setSubmit({ type: 'unread' });
        return;
      case 'failed': {
        const c = classifyError(result.error);
        const effect = effectOf(c);
        if (c.kind === 'forbidden') setForbidden(true);
        if (effect.reload === 'year') {
          onReloadMembership();
          onReload();
        } else if (effect.reload === 'data') onReload();
        setSubmit({ type: 'error', error: result.error });
        return;
      }
    }
  };

  const save = async () => {
    if (busy || blocked || submit?.type === 'missing') return;
    const r = checkLendingItemForm(values);
    setErrors(r.ok ? {} : r.errors);
    if (!r.ok) return;
    const w = r.write;
    if (mode.type === 'edit' && savedRow && !mustSend && savedRow.updated_at === lockUpdatedAt && sameLendingItemWrite(savedRow, w)) {
      writer.clear();
      toast.info('変更はありません');
      onClose();
      return;
    }
    if (mode.type === 'edit' && !lockUpdatedAt) return;
    const id = mode.id;
    const base = mode.type === 'edit' ? lockUpdatedAt : null;
    setSubmit(null);
    setPending(true);
    try {
      const result = await runLendingItemSave(
        {
          baseVersion: base,
          write: w,
          send: async () => (base === null ? (await insertLendingItems(yearId, [{ id, ...w }]))[0]! : updateLendingItem({ id, updated_at: base }, w)),
          reread: () => readLendingItem(id),
        },
        onAuthError,
      );
      settle(result);
    } finally {
      setPending(false);
    }
  };

  /** 止められた後に読み直せなかったときの「読み直す」：その備品を読み直し、入力と同じなら保存されていた、あれば conflict、なければ消えていた */
  const rereadUnread = async () => {
    if (busy) return;
    const r = checkLendingItemForm(values);
    setRereading(true);
    try {
      const row = await readLendingItem(mode.id);
      if (!row) settle({ type: 'missing' });
      else if (r.ok && sameLendingItemWrite(row, r.write)) settle({ type: 'saved', row, before: true });
      else settle({ type: 'conflict', row });
    } catch {
      toast.error('まだ読み直せませんでした。通信を確かめてから、もう一度「読み直す」を押してください（入力は残してあります）');
    } finally {
      setRereading(false);
    }
  };

  const restoreDraft = () => {
    if (!draft || busy) return;
    const d = draft.value;
    setValues(d.values);
    if (mode.type === 'new') setMode({ type: 'new', id: d.id });
    if (editing) setLockUpdatedAt(d.baseUpdatedAt ?? editing.updated_at);
    setDraft(null);
  };
  const discardDraft = () => {
    writer.cancel();
    removeDraft(draftKeyValue);
    setDraft(null);
  };

  const ids = {
    name: `${baseId}-name`,
    unit: `${baseId}-unit`,
    stock: `${baseId}-stock`,
    categories: `${baseId}-categories`,
    sortOrder: `${baseId}-sort`,
  };
  const fieldError = (k: keyof LendingItemFormErrors) =>
    errors[k] ? (
      <p data-field-error={k} className="text-sm text-destructive">
        {errors[k]}
      </p>
    ) : null;

  return (
    <>
      <UnsavedChangesGuard when={dirty} />
      <DialogContent
        data-testid="lending-item-dialog"
        className="flex max-h-[calc(100dvh-2rem)] flex-col gap-0 p-0 sm:max-w-lg"
        showCloseButton={false}
        onEscapeKeyDown={(e) => {
          e.preventDefault();
          requestClose();
        }}
        onPointerDownOutside={(e) => {
          e.preventDefault();
          requestClose();
        }}
        onInteractOutside={(e) => e.preventDefault()}
      >
        <DialogHeader className="border-b px-6 pt-6 pb-4">
          <DialogTitle>{isNew ? '備品を登録' : '備品を編集'}</DialogTitle>
          <DialogDescription>在庫は、その年度に貸し出せる総数です。申請できる区分の団体が、申請の画面の「テント等」で申請できます。</DialogDescription>
        </DialogHeader>
        <div className="min-h-0 flex-1 space-y-4 overflow-y-auto px-6 py-4">
          <SubmitNotice submit={submit} onReload={onReload} onReread={() => void rereadUnread()} rereading={rereading} />
          {draft ? <DraftNotice savedAt={draft.savedAt} onRestore={restoreDraft} onDiscard={discardDraft} /> : null}
          <div className="space-y-1.5">
            <Label htmlFor={ids.name}>名前</Label>
            <Input
              id={ids.name}
              data-testid="lending-item-name"
              value={values.name}
              maxLength={LENDING_ITEM_NAME_MAX * 2}
              onChange={(e) => update({ name: e.target.value })}
              disabled={busy}
              aria-invalid={errors.name ? true : undefined}
              autoComplete="off"
            />
            {fieldError('name')}
          </div>
          <div className="grid gap-4 sm:grid-cols-3">
            <div className="space-y-1.5">
              <Label htmlFor={ids.unit}>単位</Label>
              <Input
                id={ids.unit}
                data-testid="lending-item-unit"
                value={values.unit}
                maxLength={LENDING_UNIT_MAX * 2}
                onChange={(e) => update({ unit: e.target.value })}
                disabled={busy}
                aria-invalid={errors.unit ? true : undefined}
                autoComplete="off"
              />
              {fieldError('unit')}
            </div>
            <div className="space-y-1.5">
              <Label htmlFor={ids.stock}>在庫</Label>
              <Input
                id={ids.stock}
                data-testid="lending-item-stock"
                inputMode="numeric"
                value={values.stock}
                onChange={(e) => update({ stock: e.target.value })}
                disabled={busy}
                aria-invalid={errors.stock ? true : undefined}
                autoComplete="off"
              />
              {fieldError('stock')}
            </div>
            <div className="space-y-1.5">
              <Label htmlFor={ids.sortOrder}>並び</Label>
              <Input
                id={ids.sortOrder}
                data-testid="lending-item-sort"
                inputMode="numeric"
                value={values.sortOrder}
                onChange={(e) => update({ sortOrder: e.target.value })}
                disabled={busy}
                aria-invalid={errors.sortOrder ? true : undefined}
                autoComplete="off"
              />
              {fieldError('sortOrder')}
            </div>
          </div>
          <fieldset className="space-y-2" aria-describedby={`${ids.categories}-help`}>
            <legend className="text-sm font-medium">申請できる区分</legend>
            <div className="flex flex-wrap gap-x-5 gap-y-2" data-testid="lending-item-categories">
              {GROUP_CATEGORIES.map((c) => (
                <div key={c} className="flex items-center gap-2">
                  <Checkbox
                    id={`${ids.categories}-${c}`}
                    checked={values.categories.includes(c)}
                    onCheckedChange={(v) => toggleCategory(c, v === true)}
                    disabled={busy}
                  />
                  <Label htmlFor={`${ids.categories}-${c}`} className="font-normal">
                    {CATEGORY_LABELS[c]}
                  </Label>
                </div>
              ))}
            </div>
            <p id={`${ids.categories}-help`} className="text-xs text-muted-foreground">
              どれも選ばなければ、団体は申請できません（総務が「備品と割り当て」で割り当てます。企業・休憩所もここで入れます）。
            </p>
          </fieldset>
        </div>
        <DialogFooter className="flex-row flex-wrap items-center justify-end gap-2 border-t px-6 py-4">
          {blocked ? <p className="mr-auto text-sm text-muted-foreground">{ITEM_CANNOT_SAVE}</p> : null}
          <Button variant="outline" onClick={requestClose} disabled={busy}>
            やめる
          </Button>
          <Button data-testid="lending-item-submit" onClick={() => void save()} disabled={busy || blocked || submit?.type === 'missing'} aria-busy={pending || undefined}>
            {isNew ? (pending ? '登録しています…' : '登録') : pending ? '保存中…' : '保存'}
          </Button>
        </DialogFooter>
      </DialogContent>
      <ConfirmDialog
        open={discardOpen}
        onOpenChange={setDiscardOpen}
        title="保存していない入力を捨てますか"
        description="閉じると、このフォームに入れた内容は消えます。"
        confirmLabel="捨てて閉じる"
        cancelLabel="入力に戻る"
        destructive
        onConfirm={() => {
          writer.clear();
          onClose();
        }}
      />
    </>
  );
}

function SubmitNotice({ submit, onReload, onReread, rereading }: { submit: SubmitState | null; onReload: () => void; onReread: () => void; rereading: boolean }) {
  if (!submit) return null;
  const box = 'space-y-2 rounded-md border border-destructive/40 bg-destructive/5 px-4 py-3 text-sm';
  switch (submit.type) {
    case 'conflict':
      return (
        <div role="alert" data-testid="lending-item-conflict" className={box}>
          <p className="font-medium text-destructive">{ITEM_CONFLICT_NOTICE}</p>
          <p className="[overflow-wrap:anywhere]">
            今の値：{submit.row.name}（{submit.row.unit}・在庫 {submit.row.stock}）
          </p>
        </div>
      );
    case 'missing':
      return (
        <div role="alert" data-testid="lending-item-missing" className={box}>
          <p className="font-medium text-destructive">{ITEM_MISSING_MESSAGE}</p>
        </div>
      );
    case 'unknown':
      return (
        <div role="alert" data-testid="lending-item-error" data-kind="unknown" className={box}>
          <p className="font-medium text-destructive">{submit.message}</p>
        </div>
      );
    case 'unread':
      return (
        <div role="alert" data-testid="lending-item-error" data-kind="unread" className={box}>
          <p className="font-medium text-destructive">{ITEM_REREAD_FAILED}</p>
          <Button size="sm" variant="outline" onClick={onReread} disabled={rereading} aria-busy={rereading || undefined}>
            {rereading ? '読み直しています…' : '読み直す'}
          </Button>
        </div>
      );
    case 'error':
      return (
        <div data-testid="lending-item-error">
          <ErrorBanner error={submit.error} context={{ table: 'lending_items' }} onReload={onReload} />
        </div>
      );
  }
}
