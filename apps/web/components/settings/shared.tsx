'use client';

// マスタ設定の各タブが使う小さな部品と、書き込みのエラーの扱い（画面の設計 2.5・2.6・3.2。T09）。
// 2つ目の画面が要るようになったら common/ に移す（docs/prompts/T09.md）。
import { useQueryClient, type QueryKey } from '@tanstack/react-query';
import { createContext, useCallback, useContext, useId } from 'react';
import { toast } from 'sonner';
import { Label } from '@/components/ui/label';
import { Sheet, SheetContent, SheetDescription, SheetHeader, SheetTitle } from '@/components/ui/sheet';
import { useAuth } from '@/lib/auth/auth-provider';
import { useAuthErrorHandler } from '@/lib/auth/guarded';
import type { Membership } from '@/lib/auth/membership';
import type { YearRow } from '@/lib/db/types';
import { classifyError, effectOf, messageFor, type MessageContext } from '@/lib/errors';
import { queryKeys } from '@/lib/query';
import { cn } from '@/lib/utils';

// ---- 画面の文脈 ----

export interface SettingsContextValue {
  year: YearRow;
  membership: Membership;
  /** 年度の表（groups・room_years・年度の変更・招待・ロールの変更）を書けるか（closed では偽） */
  yearWritable: boolean;
  /** 年度をまたぐ表（rooms・items・distance_overrides）を書けるか（開いている年度のどれかの admin〔D-01〕で、開いている年度が closed でない。04） */
  globalWritable: boolean;
}

export const SettingsContext = createContext<SettingsContextValue | null>(null);

export function useSettings(): SettingsContextValue {
  const v = useContext(SettingsContext);
  if (!v) throw new Error('SettingsContext の外で使っている');
  return v;
}

// ---- エラー ----

export interface WriteErrorOptions {
  context?: MessageContext;
  /** conflict・not_found などで読み直すクエリ */
  dataKeys?: readonly QueryKey[];
}

/**
 * 書き込みの失敗を、2.5・2.6 の決まりで扱う：文言を toast で出し、forbidden・state は年度の行と立場を、conflict・not_found は
 * その画面のデータを読み直す。auth はセッションの更新を試す。入力は残す（呼ぶ側はフォームを閉じない）。文言を返す。
 */
export function useWriteErrorHandler(): (e: unknown, opts?: WriteErrorOptions) => Promise<string> {
  const queryClient = useQueryClient();
  const { reloadMembership } = useAuth();
  const onAuthError = useAuthErrorHandler();
  const { year } = useSettings();
  return useCallback(
    async (e: unknown, opts: WriteErrorOptions = {}) => {
      const c = classifyError(e);
      const message = messageFor(c, opts.context);
      if (c.kind === 'auth') {
        await onAuthError(e);
        return message;
      }
      toast.error(message);
      const effect = effectOf(c);
      if (effect.reload === 'year' || c.kind === 'network' || c.kind === 'unknown') {
        await queryClient.invalidateQueries({ queryKey: queryKeys.yearRow(year.id) });
        reloadMembership();
      }
      if (effect.reload !== 'none' || c.kind === 'network' || c.kind === 'unknown') {
        await Promise.all((opts.dataKeys ?? []).map((k) => queryClient.invalidateQueries({ queryKey: k })));
      }
      return message;
    },
    [queryClient, reloadMembership, onAuthError, year.id],
  );
}

// ---- フォームの欄 ----

/** ラベル・入力・説明・エラーの組（入力は children。id は htmlFor に渡す） */
export function Field({
  label,
  error,
  hint,
  className,
  children,
}: {
  label: string;
  error?: string | undefined;
  hint?: React.ReactNode;
  className?: string;
  children: (props: { id: string; 'aria-invalid'?: true; 'aria-describedby'?: string }) => React.ReactNode;
}) {
  const id = useId();
  const errId = `${id}-error`;
  const hintId = `${id}-hint`;
  const describedBy = [hint ? hintId : null, error ? errId : null].filter(Boolean).join(' ') || undefined;
  return (
    <div className={cn('space-y-1.5', className)}>
      <Label htmlFor={id}>{label}</Label>
      {children({ id, ...(error ? { 'aria-invalid': true as const } : {}), ...(describedBy ? { 'aria-describedby': describedBy } : {}) })}
      {hint ? (
        <p id={hintId} className="text-xs text-muted-foreground">
          {hint}
        </p>
      ) : null}
      {error ? (
        <p id={errId} role="alert" className="text-xs text-destructive">
          {error}
        </p>
      ) : null}
    </div>
  );
}

/** ネイティブの select（Input と同じ見た目） */
export const selectClass =
  'h-9 w-full rounded-md border border-input bg-transparent px-3 py-1 text-sm shadow-xs outline-none focus-visible:border-ring focus-visible:ring-[3px] focus-visible:ring-ring/50 disabled:cursor-not-allowed disabled:opacity-50 aria-invalid:border-destructive';

/** 各タブの見出しと説明 */
export function TabHeading({ title, description, actions }: { title: string; description?: React.ReactNode; actions?: React.ReactNode }) {
  return (
    <div className="mb-3 flex flex-col gap-x-4 gap-y-2 md:flex-row md:items-start">
      <div className="min-w-0 flex-1 space-y-1">
        <h2 className="text-lg font-semibold">{title}</h2>
        {description ? <div className="text-sm text-muted-foreground">{description}</div> : null}
      </div>
      {actions ? <div className="flex flex-wrap items-center gap-2">{actions}</div> : null}
    </div>
  );
}

// ---- 追加・編集のシート ----

/** 行の追加・編集のシート（右から出す。中身はフォーム。閉じるとフォームが外れ、未保存の印も消える） */
export function FormSheet({
  open,
  onOpenChange,
  title,
  description,
  busy = false,
  children,
}: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  title: string;
  description?: React.ReactNode;
  /** 送信中は閉じない */
  busy?: boolean;
  children: React.ReactNode;
}) {
  // 閉じたら外す（閉じる動きの途中に次のシートを開くと、前のシートがフォーカスを戻して新しいシートが閉じてしまうため。
  // 開くたびに新しいシートにする）
  if (!open) return null;
  return (
    <Sheet open onOpenChange={(o) => (busy ? undefined : onOpenChange(o))}>
      <SheetContent className="w-full overflow-y-auto sm:max-w-lg">
        <SheetHeader>
          <SheetTitle>{title}</SheetTitle>
          {description ? <SheetDescription>{description}</SheetDescription> : null}
        </SheetHeader>
        <div className="px-4 pb-6">{children}</div>
      </SheetContent>
    </Sheet>
  );
}

// ---- クエリのキー ----

/**
 * マスタ設定のクエリのキー。ほかの画面（別のチケット）が同じキーに別の形のデータを置かないよう、最後に 'settings' を付ける。
 * 書いた後は前の部分（queryKeys.rooms() など）で invalidate して、ほかの画面のキャッシュも読み直させる。
 */
export const settingsKeys = {
  rooms: () => [...queryKeys.rooms(), 'settings'] as const,
  items: () => [...queryKeys.items(), 'settings'] as const,
  distance: () => [...queryKeys.distance(), 'settings'] as const,
  roomYears: (yearId: string) => queryKeys.yearPart(yearId, 'settings', 'room_years'),
  groups: (yearId: string) => queryKeys.yearPart(yearId, 'settings', 'groups'),
  rules: (yearId: string) => queryKeys.yearPart(yearId, 'settings', 'rules'),
  members: (yearId: string) => queryKeys.yearPart(yearId, 'settings', 'members'),
  allocationSources: (yearId: string) => queryKeys.yearPart(yearId, 'settings', 'allocation_sources'),
};
