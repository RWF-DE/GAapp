'use client';

// ルールの追加・編集のシート（画面の設計 3.8。T12）。保存の前に ruleRowSchema と checkRuleRefs で確かめ、エラーを欄の下に出す。
// 確定中・終了の年度はメモだけ直せる。保存は rules への直接の書き込み（insert・updated_at で楽観ロックの update）。
// 楽観ロックの版は、シートを開いたときの行の updated_at（baseUpdatedAt）。開いた後に一覧が読み直されても進めない
// （フォームは開いたときの値のままなので、進めるとほかの人の変更を黙って上書きする）。conflict を見た後だけ、読み直した行の版に進める（2.5）。
// 応答が届かなかったとき・止められたときは 2.6 の (B1)（rule-write.ts の runRuleWrite）。確かめるためだけの状態は持たず、保存のボタンは押せるまま。
import { useEffect, useId, useMemo, useRef, useState } from 'react';
import { toast } from 'sonner';
import { ConfirmDialog } from '@/components/common/confirm-dialog';
import { ErrorBanner } from '@/components/common/error-banner';
import { UnsavedChangesGuard } from '@/components/common/unsaved-changes-guard';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { Sheet, SheetContent, SheetDescription, SheetFooter, SheetHeader, SheetTitle } from '@/components/ui/sheet';
import { Textarea } from '@/components/ui/textarea';
import {
  checkRuleForm,
  errorsUnder,
  sameRuleWrite,
  toRuleWrite,
  type RuleFieldErrors,
  type RuleFormValues,
  type RulesData,
  type RuleWrite,
} from '@/lib/data/rules';
import type { RuleDbRow } from '@/lib/db/types';
import { classifyError, unknownOutcomeMessage } from '@/lib/errors';
import { RULE_KIND_LABELS } from '@/lib/labels';
import { NOTE_MAX, optionalText } from '@/lib/schemas/common';
import { CheckOne, FieldErrors, RuleParamsFields } from './rule-fields';
import type { SaveOutcome } from './rule-write';

/**
 * 開いているシート（新規はひな形のコードを持つことがある）。
 * 編集の baseUpdatedAt は initial を作った行の updated_at（楽観ロックの版）。
 */
export type RuleSheetTarget =
  | { type: 'new'; initial: RuleFormValues; template?: string }
  | { type: 'edit'; ruleId: string; initial: RuleFormValues; baseUpdatedAt: string };

export type { SaveOutcome };

export interface RuleFormSheetProps {
  target: RuleSheetTarget | null;
  onClose: () => void;
  data: RulesData;
  /** memo：確定中・終了（メモだけ直せる） */
  editMode: 'full' | 'memo';
  /** 新規の保存 */
  onInsert: (row: RuleWrite) => Promise<SaveOutcome>;
  /** 既存の保存（メモだけのときは patch が memo だけ。rule.updated_at が楽観ロックの版） */
  onUpdate: (rule: RuleDbRow, patch: Partial<RuleWrite>) => Promise<SaveOutcome>;
  /** エラーの後に「読み直す」 */
  onReload: () => void;
}

const memoSchema = optionalText(NOTE_MAX);

export function RuleFormSheet(props: RuleFormSheetProps) {
  const { target } = props;
  // target が変わるたびに中身を作り直す（入力の状態を前のルールから持ち込まない）
  const key = target ? (target.type === 'edit' ? `edit:${target.ruleId}` : `new:${target.template ?? target.initial.kind}`) : 'closed';
  return (
    <Sheet open={target !== null} onOpenChange={() => undefined}>
      {target ? <RuleFormSheetBody key={key} {...props} target={target} /> : null}
    </Sheet>
  );
}

function RuleFormSheetBody({ target, onClose, data, editMode, onInsert, onUpdate, onReload }: RuleFormSheetProps & { target: RuleSheetTarget }) {
  const [values, setValues] = useState<RuleFormValues>(target.initial);
  const [errors, setErrors] = useState<RuleFieldErrors>({});
  const [submitError, setSubmitError] = useState<{ error: unknown; notice?: string; showReload?: boolean } | null>(null);
  const [pending, setPending] = useState(false);
  const [discardOpen, setDiscardOpen] = useState(false);
  const bodyRef = useRef<HTMLDivElement>(null);
  const codeId = useId();
  const memoId = useId();

  const rule = target.type === 'edit' ? (data.rules.find((r) => r.id === target.ruleId) ?? null) : null;
  // 楽観ロックの版（開いたときの行の updated_at）。読み直しでは進めず、conflict を見た後だけ読み直した行の版に進める
  const [lockUpdatedAt, setLockUpdatedAt] = useState(target.type === 'edit' ? target.baseUpdatedAt : null);
  // conflict の後、止められたときに読み直した行（runRuleWrite の rebase）。版はこの行の updated_at に進める
  const [rebasedRow, setRebasedRow] = useState<RuleDbRow | null>(null);
  // conflict を見たが、読み直した行をまだ入力の元にしていない（読み直せなかった・行がなくなっていた）。一覧の読み直しが来たら、その版に進める
  const [adoptAfterConflict, setAdoptAfterConflict] = useState(false);
  if (adoptAfterConflict && rule && rule.updated_at !== lockUpdatedAt) {
    // conflict の後に読み直した行が来た：もう一度の保存は、その版での意図した上書きになる（描画中に state を合わせる）
    setLockUpdatedAt(rule.updated_at);
    setRebasedRow(null);
    setAdoptAfterConflict(false);
  }
  const dirty = useMemo(() => JSON.stringify(values) !== JSON.stringify(target.initial), [values, target.initial]);
  // 編集で何も変えていなければ、保存を押しても確かめるだけで送らない（update を送ると、振り分け中の年度の版を無駄に上げる）。
  // 開いたときの値（target.initial）と比べるのは、版が開いたときのままで、conflict を見ていない間だけ。conflict の後に読み直した行の版へ進んだら、
  // 比べる相手は読み直した行（save の noChange の sameRuleWrite）。開いたときの値に戻した入力も、読み直した行と違えば送る。
  // conflict を見た後、読み直した行をまだ入力の元にしていない間（adoptAfterConflict）は、送らずに閉じる分かれ道を使わない
  // （DB にはほかの人の値があるので、黙って閉じると入力が捨てられる。送れば今の版で conflict がもう一度返り、そのときに読み直す）
  // 応答が届かなかった後（保存できたか分からない）も同じ：前の送信が DB に入っているかもしれないので、送らずに閉じる分かれ道を使わない
  // （送れば、前の送信が通っていたときは conflict が返り、読み直して比べる。2.6 の (B1) の 2。新しい状態は足さず、今の submitError から決める）
  const afterUnknownOutcome =
    !!submitError &&
    (submitError.notice === unknownOutcomeMessage() || ['network', 'unknown'].includes(classifyError(submitError.error).kind));
  const mustSend = adoptAfterConflict || afterUnknownOutcome;
  const lockAdvanced = target.type === 'edit' && lockUpdatedAt !== target.baseUpdatedAt;
  const unchanged = target.type === 'edit' && !dirty && !lockAdvanced && !mustSend;
  const memoOnly = editMode === 'memo';
  const paramsDisabled = memoOnly || pending;

  // エラーが出たら最初のエラーの欄を見える所に出す
  useEffect(() => {
    if (Object.keys(errors).length === 0) return;
    bodyRef.current?.querySelector('[data-field-error]')?.scrollIntoView?.({ block: 'center' });
  }, [errors]);
  // 保存の失敗の知らせ（シートの本文の先頭）も、下の欄まで送っていたら見える所に出す
  useEffect(() => {
    if (!submitError) return;
    bodyRef.current?.querySelector('[data-submit-error]')?.scrollIntoView?.({ block: 'nearest' });
  }, [submitError]);

  const requestClose = () => {
    if (pending) return;
    if (dirty) setDiscardOpen(true);
    else onClose();
  };

  const save = async () => {
    if (pending) return;
    setSubmitError(null);
    if (target.type === 'edit' && (!rule || !lockUpdatedAt)) return;
    const locked = rule && lockUpdatedAt ? { ...rule, updated_at: lockUpdatedAt } : null;
    /**
     * 送らずに閉じるか：入力を開いたときのまま（unchanged。版が開いたときのままの間だけ）か、
     * 送る内容が保存してある行（版も同じ。conflict の後は読み直した行）と同じ（変えて戻したときなど）。
     * conflict の後で読み直した行をまだ元にしていない間と、応答が届かなかった後（mustSend）は、閉じずに必ず送る。
     * 確かめ（欄の下のエラー）は送るときと同じに通してから閉じる（参照の切れたルールを開いて保存を押すと、エラーが見える）
     */
    const savedRow = rebasedRow && rebasedRow.updated_at === lockUpdatedAt ? rebasedRow : rule;
    const noChange = (patch: Partial<RuleWrite>) =>
      !mustSend && (unchanged || (!!savedRow && savedRow.updated_at === lockUpdatedAt && sameRuleWrite(savedRow, patch)));
    const closeUnchanged = () => {
      toast.info('変更はありません');
      onClose();
    };
    let send: () => Promise<SaveOutcome>;
    if (memoOnly) {
      const m = memoSchema.safeParse(values.memo);
      if (!m.success) {
        setErrors({ memo: [`メモは ${NOTE_MAX} 字までです`] });
        return;
      }
      setErrors({});
      if (noChange({ memo: m.data })) {
        closeUnchanged();
        return;
      }
      send = () => onUpdate(locked!, { memo: m.data });
    } else {
      const res = checkRuleForm(values, data, rule?.id ?? null);
      setErrors(res.errors);
      if (!res.row) return;
      const write = toRuleWrite(res.row);
      if (target.type === 'edit' && noChange(write)) {
        closeUnchanged();
        return;
      }
      send = target.type === 'new' ? () => onInsert(write) : () => onUpdate(locked!, write);
    }
    setPending(true);
    try {
      const out = await send();
      if (out.ok) {
        onClose();
        return;
      }
      if (out.fieldErrors) setErrors(out.fieldErrors);
      else {
        setSubmitError({ error: out.error, notice: out.notice, showReload: out.showReload });
        const kind = classifyError(out.error).kind;
        if (target.type === 'edit' && out.rebase) {
          // 止められた後に読み直した行：その版を入力の元にする（もう一度の保存は、その版での意図した上書き）
          setLockUpdatedAt(out.rebase.updated_at);
          setRebasedRow(out.rebase);
          setAdoptAfterConflict(false);
        } else if (target.type === 'edit' && (out.showReload || kind === 'conflict' || kind === 'not_found')) {
          setAdoptAfterConflict(true);
        }
      }
    } finally {
      setPending(false);
    }
  };

  const kindLabel = RULE_KIND_LABELS[values.kind];
  const title =
    target.type === 'new'
      ? target.template
        ? `R8 の初期ルール ${target.template}（${kindLabel}）を追加`
        : `${kindLabel}のルールを追加`
      : memoOnly
        ? `ルール ${target.initial.code} のメモを直す`
        : `ルール ${target.initial.code}（${kindLabel}）を編集`;

  return (
    <>
      <UnsavedChangesGuard when={dirty} />
      <SheetContent
        side="right"
        className="w-full gap-0 sm:max-w-2xl"
        onEscapeKeyDown={(e) => {
          e.preventDefault();
          requestClose();
        }}
        onPointerDownOutside={(e) => {
          e.preventDefault();
          requestClose();
        }}
        onInteractOutside={(e) => e.preventDefault()}
        showCloseButton={false}
        aria-describedby={undefined}
      >
        <SheetHeader className="border-b">
          <SheetTitle>{title}</SheetTitle>
          <SheetDescription>
            {memoOnly
              ? '確定中・終了した年度は、メモだけ直せます。'
              : '団体・場所は名前で選びます。保存の前に、ほかの有効なルールとの重なりと参照を確かめます。'}
          </SheetDescription>
        </SheetHeader>
        <div ref={bodyRef} className="flex-1 space-y-5 overflow-y-auto p-4" data-testid="rule-form">
          {submitError?.notice ? (
            <div role="alert" data-testid="unknown-outcome" data-submit-error className="space-y-2 rounded-md border border-destructive/40 bg-destructive/5 px-4 py-3 text-sm">
              <p className="font-medium text-destructive">{submitError.notice}</p>
              {submitError.showReload ? (
                <Button size="sm" variant="outline" onClick={onReload}>
                  読み直す
                </Button>
              ) : null}
            </div>
          ) : submitError ? (
            <div data-submit-error>
              <ErrorBanner error={submitError.error} onReload={onReload} />
            </div>
          ) : null}
          {target.type === 'edit' && !rule ? (
            <p className="text-sm text-destructive">このルールは見つかりません（ほかの人が消した可能性があります）。閉じて読み直してください。</p>
          ) : null}
          <div className="grid gap-4 sm:grid-cols-[12rem_1fr]">
            <div data-field="code" className="space-y-1.5">
              <Label htmlFor={codeId}>コード</Label>
              <Input
                id={codeId}
                value={values.code}
                maxLength={50}
                onChange={(e) => setValues({ ...values, code: e.target.value })}
                disabled={paramsDisabled}
                aria-invalid={errorsUnder(errors, 'code').length > 0 || undefined}
                placeholder="例：S09"
              />
              <FieldErrors errors={errors} path="code" />
            </div>
            <div className="flex items-end pb-2">
              <CheckOne label="有効（振り分けに使う）" checked={values.enabled} onChange={(v) => setValues({ ...values, enabled: v })} disabled={paramsDisabled} />
            </div>
          </div>
          <RuleParamsFields values={values} onChange={setValues} errors={errors} data={data} disabled={paramsDisabled} />
          <FieldErrors errors={errors} path="params" exact />
          <div data-field="memo" className="space-y-1.5">
            <Label htmlFor={memoId}>メモ（見直し点や、無効にした理由など）</Label>
            <Textarea
              id={memoId}
              value={values.memo}
              rows={3}
              onChange={(e) => setValues({ ...values, memo: e.target.value })}
              disabled={pending}
              aria-invalid={errorsUnder(errors, 'memo').length > 0 || undefined}
            />
            <FieldErrors errors={errors} path="memo" />
          </div>
        </div>
        <SheetFooter className="flex-row justify-end border-t">
          <Button variant="outline" onClick={requestClose} disabled={pending}>
            閉じる
          </Button>
          <Button
            onClick={() => void save()}
            disabled={pending || (target.type === 'edit' && !rule)}
            aria-busy={pending || undefined}
          >
            {pending ? '保存中…' : '保存'}
          </Button>
        </SheetFooter>
      </SheetContent>
      <ConfirmDialog
        open={discardOpen}
        onOpenChange={setDiscardOpen}
        title="保存していない入力を捨てますか"
        description="閉じると、このフォームに入れた内容は消えます。"
        confirmLabel="捨てて閉じる"
        cancelLabel="入力に戻る"
        destructive
        onConfirm={() => onClose()}
      />
    </>
  );
}
