'use client';

// 割り当ての確定・確定の解除（04「備品と割り当て」の確定、notes/T21.md「画面の約束」4・9。T21・D-57）。部門長以上（終了した年度を除く）。
// - 確定：未保存の変更がなく、締切の後で、在庫超過と未入力がないときだけ押せる。押せない理由を並べて出す（confirmBlockers の順）。
//   押すとダイアログ（備品ごとの「割り当て合計／在庫」）。set_lending_confirmed の理由は DB が決まった文を置く。
// - 確定を解除：理由が要る（ReasonDialog）。
// - 応答が届かなければ確定の印を読み直し、頼んだ状態になっていれば成功と同じに扱う（(B1)）。invalid_state（締切の前・在庫超過・未入力・
//   同じ状態）は読み直して押せない理由・今の状態を出し直す。
import { CheckCircle2, Undo2 } from 'lucide-react';
import { useState } from 'react';
import { toast } from 'sonner';
import { ConfirmDialog } from '@/components/common/confirm-dialog';
import { ReasonDialog } from '@/components/common/reason-dialog';
import { Button } from '@/components/ui/button';
import { useAuthErrorHandler } from '@/lib/auth/guarded';
import { readLendingConfirmedAt, setLendingConfirmed, type LendingBoardData } from '@/lib/data/lending';
import type { YearRow } from '@/lib/db/types';
import { formatShortDateTime } from '@/lib/datetime';
import { classifyError, effectOf, isUnknownOutcome, messageFor, type MessageContext } from '@/lib/errors';
import { confirmBlockers, unassignedPairs, type ConfirmBlocker, type LendingItemTotal } from '@/lib/modules/lending/counts';

/** 押せない理由の文（04「備品と割り当て」の確定） */
export function blockerText(b: ConfirmBlocker, year: Pick<YearRow, 'request_close_at'>, itemName: (id: string) => string): string {
  switch (b.kind) {
    case 'before_deadline':
      return year.request_close_at ? `受付の締切の後に確定できます（締切 ${formatShortDateTime(year.request_close_at)}）` : '受付の締切の後に確定できます';
    case 'over_stock':
      return `在庫を超えている備品があります：${b.itemIds.map(itemName).join('・')}`;
    case 'unassigned':
      return `申請があるのに割り当てていない組があります：${b.items.map((i) => `${itemName(i.itemId)} ${i.groups} 団体`).join('・')}`;
    case 'unsaved':
      return '保存していない変更があります';
  }
}

/** 確定・解除の応答が届かなかった（確定の印を読み直しても頼んだ状態でない・読み直せない） */
export const CONFIRM_UNKNOWN_MESSAGE = '確定できたか分かりません。もう一度「確定する」を押すと、確かめてから送ります';
export const UNCONFIRM_UNKNOWN_MESSAGE = '確定を解除できたか分かりません。もう一度「確定を解除する」を押すと、確かめてから送ります';

export interface ConfirmActionsProps {
  yearId: string;
  year: YearRow;
  now: number;
  data: LendingBoardData;
  totals: readonly LendingItemTotal[];
  /** 保存していない割り当ての変更の数 */
  unsaved: number;
  /** 確定・解除の後（と止められた後）に、テント等の画面とダッシュボードを読み直す */
  onChanged: () => void;
  /** 年度の行と立場を読み直す（forbidden・終了の後） */
  onReloadMembership: () => void;
}

export function ConfirmActions({ yearId, year, now, data, totals, unsaved, onChanged, onReloadMembership }: ConfirmActionsProps) {
  const onAuthError = useAuthErrorHandler();
  const [confirmOpen, setConfirmOpen] = useState(false);
  const [unconfirmOpen, setUnconfirmOpen] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [reasonError, setReasonError] = useState<string | null>(null);
  const names = new Map(data.items.map((i) => [i.id, i.name]));
  const itemName = (id: string) => names.get(id) ?? '（消えた備品）';
  const ctx: MessageContext = { rpc: 'set_lending_confirmed', names: { item: (id) => names.get(id) } };
  const confirmed = !!data.confirmedAt;
  const blockers = confirmed ? [] : confirmBlockers({ year, now, totals, unassigned: unassignedPairs(data.requests ?? [], data.assignments), unsaved });

  /** 送る。応答が届かなければ確定の印を読み直して決める。成功（と、されていた）なら true。止められたら false（文言は出した） */
  const run = async (want: boolean, reason: string | null): Promise<boolean> => {
    const send = () => setLendingConfirmed(yearId, want, reason);
    let failure: unknown = null;
    try {
      await send();
    } catch (e) {
      failure = e;
      if ((await onAuthError(e)) === 'retry') {
        try {
          await send();
          failure = null;
        } catch (e2) {
          failure = e2;
        }
      }
    }
    if (failure === null) {
      toast.success(want ? '割り当てを確定しました' : '確定を解除しました');
      onChanged();
      return true;
    }
    if (isUnknownOutcome(failure)) {
      try {
        const at = await readLendingConfirmedAt(yearId);
        if ((at !== null) === want) {
          toast.success(want ? '割り当ては確定されていました' : '確定は解除されていました');
          onChanged();
          return true;
        }
      } catch {
        // 読み直せない：分からないまま
      }
      const message = want ? CONFIRM_UNKNOWN_MESSAGE : UNCONFIRM_UNKNOWN_MESSAGE;
      if (want) setError(message);
      else setReasonError(message);
      throw new Error('keep-open');
    }
    const c = classifyError(failure);
    if (c.kind === 'reason' || (c.kind === 'input' && !want)) {
      setReasonError(messageFor(c, ctx));
      throw new Error('keep-open');
    }
    const effect = effectOf(c);
    if (effect.reload === 'year') onReloadMembership();
    onChanged();
    toast.error(messageFor(c, ctx));
    return false;
  };

  if (year.status === 'closed') return null;
  return (
    <div className="flex flex-wrap items-start gap-3 print:hidden">
      {confirmed ? (
        <Button
          variant="outline"
          data-testid="lending-unconfirm"
          onClick={() => {
            setReasonError(null);
            setUnconfirmOpen(true);
          }}
        >
          <Undo2 aria-hidden />
          確定を解除
        </Button>
      ) : (
        <>
          <Button
            data-testid="lending-confirm"
            disabled={blockers.length > 0}
            onClick={() => {
              setError(null);
              setConfirmOpen(true);
            }}
          >
            <CheckCircle2 aria-hidden />
            確定
          </Button>
          {blockers.length > 0 ? (
            <ul data-testid="lending-confirm-blockers" className="space-y-0.5 text-sm text-muted-foreground" aria-label="確定できない理由">
              {blockers.map((b) => (
                <li key={b.kind} data-kind={b.kind}>
                  {blockerText(b, year, itemName)}
                </li>
              ))}
            </ul>
          ) : null}
        </>
      )}
      <ConfirmDialog
        open={confirmOpen}
        onOpenChange={(o) => {
          setConfirmOpen(o);
          if (!o) setError(null);
        }}
        title="割り当てを確定しますか"
        description="確定すると、店長・副店長と閲覧のみの人が割り当てを見られます。"
        confirmLabel="確定する"
        pendingLabel="確定しています…"
        onConfirm={async () => {
          setError(null);
          await run(true, null);
        }}
      >
        <div data-testid="lending-confirm-dialog" className="space-y-2">
          <table className="w-full text-sm">
            <thead className="text-left text-xs text-muted-foreground">
              <tr>
                <th className="py-1 font-normal">備品</th>
                <th className="py-1 text-right font-normal">割り当て合計／在庫</th>
              </tr>
            </thead>
            <tbody>
              {totals.map((t) => (
                <tr key={t.itemId} className="border-t">
                  <td className="py-1">{itemName(t.itemId)}</td>
                  <td className="py-1 text-right tabular-nums">
                    {t.assigned}／{t.stock}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
          {error ? (
            <p role="alert" data-testid="lending-confirm-error" className="rounded-md border border-destructive/40 bg-destructive/5 px-3 py-2 text-sm text-destructive">
              {error}
            </p>
          ) : null}
        </div>
      </ConfirmDialog>
      <ReasonDialog
        open={unconfirmOpen}
        onOpenChange={(o) => {
          setUnconfirmOpen(o);
          if (!o) setReasonError(null);
        }}
        title="割り当ての確定を解除しますか"
        description="解除すると、店長・副店長と閲覧のみの人は割り当てを見られなくなります。直した後に、もう一度「確定」を押してください。"
        confirmLabel="確定を解除する"
        pendingLabel="解除しています…"
        destructive
        error={reasonError}
        onSubmit={async (reason) => {
          setReasonError(null);
          await run(false, reason);
        }}
      />
    </div>
  );
}
