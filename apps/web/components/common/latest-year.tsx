'use client';

import { useCallback, useRef, useState } from 'react';
import { Button } from '@/components/ui/button';
import { useAuth } from '@/lib/auth/auth-provider';
import { useGuardedSetYear } from '@/lib/auth/guarded';
import { isLatestYear, latestWritableYear, YEAR_STATUS_LABELS, type Membership } from '@/lib/auth/membership';
import { cn } from '@/lib/utils';
import { ConfirmDialog } from './confirm-dialog';

const yearText = (y: { label: string; status: keyof typeof YEAR_STATUS_LABELS }) => `${y.label}・${YEAR_STATUS_LABELS[y.status]}`;

function useReadyMembership(): Membership | null {
  const { membership } = useAuth();
  return membership.status === 'ready' ? membership.membership : null;
}

/**
 * 最新でない年度を開いているときの帯（ヘッダーの下。AppShell が出す。画面の設計 1.3.1、D-31。T09a）。
 * 「最新でない年度（R8・終了）を表示しています ［最新の年度（R9）に切り替える］」。切り替えは未保存の入力を確かめる。
 */
export function NotLatestYearBanner({ className }: { className?: string }) {
  const m = useReadyMembership();
  const setYear = useGuardedSetYear();
  if (!m || !m.year || !m.latestYear || isLatestYear(m)) return null;
  const latest = m.latestYear;
  return (
    <div
      role="status"
      data-testid="not-latest-year-banner"
      className={cn(
        'flex flex-wrap items-center gap-x-3 gap-y-1 border-b border-amber-300 bg-amber-50 px-4 py-2 text-sm text-amber-950 print:hidden',
        className,
      )}
    >
      <span>最新でない年度（{yearText(m.year)}）を表示しています</span>
      <Button size="sm" variant="outline" onClick={() => void setYear(latest.id)}>
        最新の年度（{latest.label}）に切り替える
      </Button>
    </div>
  );
}

/**
 * 書き込む画面（在庫入力・申請・自団体の了承）の上部に置く、大きな「最新の年度に切り替える」（1.3.1。T09a）。
 * 最新の年度を開いているとき・最新の年度が終了しているときは何も出さない。
 *
 * @example
 * <LatestYearSwitch />
 */
export function LatestYearSwitch({ className }: { className?: string }) {
  const m = useReadyMembership();
  const setYear = useGuardedSetYear();
  if (!m || !m.year || isLatestYear(m)) return null;
  const target = latestWritableYear(m);
  if (!target) return null;
  return (
    <div
      data-testid="latest-year-switch"
      className={cn('mb-4 flex flex-col gap-2 rounded-lg border border-amber-300 bg-amber-50 p-4 print:hidden', className)}
    >
      <p className="text-sm text-amber-950">
        開いているのは最新でない年度（{yearText(m.year)}）です。ふだんは最新の年度に入力します。
      </p>
      <Button size="lg" onClick={() => void setYear(target.id)}>
        最新の年度（{target.label}）に切り替える
      </Button>
    </div>
  );
}

/**
 * 書き込む画面の保存・提出・回答の前に、最新でない年度なら確かめる（1.3.1。T09a）。
 * confirmBeforeWrite() は、最新の年度なら確かめずに true。最新でなければダイアログを出し、続ければ true。dialog を画面に置く。
 *
 * @example
 * const notLatest = useNotLatestYearConfirm();
 * const save = async () => { if (!(await notLatest.confirmBeforeWrite())) return; m.mutate(); };
 * return <>{notLatest.dialog}<Button onClick={save}>保存</Button></>;
 */
export function useNotLatestYearConfirm(): { isLatest: boolean; confirmBeforeWrite: () => Promise<boolean>; dialog: React.ReactNode } {
  const m = useReadyMembership();
  const latest = !m || isLatestYear(m);
  const [open, setOpen] = useState(false);
  const resolver = useRef<((ok: boolean) => void) | null>(null);

  const confirmBeforeWrite = useCallback(() => {
    if (latest) return Promise.resolve(true);
    resolver.current?.(false);
    return new Promise<boolean>((resolve) => {
      resolver.current = resolve;
      setOpen(true);
    });
  }, [latest]);

  const answer = (ok: boolean) => {
    const r = resolver.current;
    resolver.current = null;
    r?.(ok);
    setOpen(false);
  };

  const dialog =
    m && m.year && !latest ? (
      <ConfirmDialog
        open={open}
        onOpenChange={(o) => {
          if (!o) answer(false);
        }}
        title={`最新でない年度（${yearText(m.year)}）に保存します。よろしいですか`}
        description="ふだんは最新の年度に入力します。前の年度に書くときだけ続けてください。"
        confirmLabel="この年度に保存する"
        onConfirm={() => answer(true)}
      />
    ) : null;

  return { isLatest: latest, confirmBeforeWrite, dialog };
}
