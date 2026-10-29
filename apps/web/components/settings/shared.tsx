'use client';

// マスタ設定の各タブが使う小さな部品と、書き込みのエラーの扱い（画面の設計 2.5・2.6・3.2。T09）。
// 2つ目の画面が要るようになったら common/ に移す（docs/prompts/T09.md）。
import { useQuery, useQueryClient, type QueryKey } from '@tanstack/react-query';
import { createContext, useCallback, useContext, useId, useState } from 'react';
import { toast } from 'sonner';
import { Label } from '@/components/ui/label';
import { Sheet, SheetContent, SheetDescription, SheetHeader, SheetTitle } from '@/components/ui/sheet';
import { useAuth } from '@/lib/auth/auth-provider';
import { Button } from '@/components/ui/button';
import { useAuthErrorHandler, useGuardedSetYear } from '@/lib/auth/guarded';
import type { Membership } from '@/lib/auth/membership';
import {
  fetchMyYearRoles,
  freshDataOf,
  latestAdminOpenYear,
  runLockedWrite,
  type LockedWriteCall,
  type LockedWriteResult,
} from '@/lib/data/settings';
import type { YearRow } from '@/lib/db/types';
import { classifyError, effectOf, isUnknownOutcome, messageFor, unknownOutcomeMessage, type AppError, type MessageContext } from '@/lib/errors';
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

/**
 * 年度をまたぐ表（場所・品目・距離）のタブの説明に添える、読み取り専用の理由。終了した年度では、ほかの開いている年度の
 * 管理者でも直せない（04「終了した年度では読み取り専用」）ので、直せる年度を開くよう案内する。行き先は、自分が admin の、
 * 終了していない最新の年度だけ（部員・閲覧のみ・団体代表の年度は開いても直せない）。なければボタンを出さず、
 * 開いている年度の管理者が直すと知らせる。
 */
export function GlobalReadOnlyNote({ what }: { what: '場所' | '品目' | '距離' }) {
  const { year, membership, yearWritable, globalWritable } = useSettings();
  const { session } = useAuth();
  const setYear = useGuardedSetYear();
  const userId = session.status === 'signedIn' ? session.session.user.id : null;
  const closedNote = !globalWritable && !yearWritable;
  const rolesQ = useQuery({
    queryKey: settingsKeys.myYearRoles(userId ?? ''),
    queryFn: () => fetchMyYearRoles(userId!),
    enabled: closedNote && userId !== null,
    staleTime: 0,
  });
  if (globalWritable) return null;
  if (yearWritable) {
    return <span data-testid="global-read-only"> 開いている年度の管理者でないため、{what}は編集できません。</span>;
  }
  // 読み直し中・失敗では前の結果を使わない（ロールが変わっていれば、直せない年度へ案内してしまうため）
  const roles = freshDataOf(rolesQ);
  const target = roles ? latestAdminOpenYear(membership.years, roles) : null;
  // 行き先がないと言えるのは、読めたうえで行き先がないときだけ。読み込みに失敗したら確かめられなかったと知らせ、もう一度読める
  const failed = rolesQ.isError;
  return (
    <span className="mt-1 block" data-testid="global-read-only">
      終了した年度のため、{what}は直せません（すべての年度で共有の表です）。
      {target && target.id !== year.id ? (
        <>
          管理者の年度を開いて直してください。
          <Button
            type="button"
            variant="link"
            size="sm"
            className="h-auto px-1 py-0"
            data-testid="open-admin-year"
            onClick={() => void setYear(target.id)}
          >
            {target.label}を開く
          </Button>
        </>
      ) : failed ? (
        <span data-testid="global-read-only-roles-error">
          直せる年度を確かめられませんでした。
          <Button
            type="button"
            variant="link"
            size="sm"
            className="h-auto px-1 py-0"
            disabled={rolesQ.isFetching}
            onClick={() => void rolesQ.refetch()}
          >
            {rolesQ.isFetching ? '確かめ中…' : 'もう一度'}
          </Button>
        </span>
      ) : roles !== null ? (
        <span data-testid="global-read-only-no-target">この表は、開いている年度の管理者が直します。</span>
      ) : null}
    </span>
  );
}

// ---- エラー ----

export interface WriteErrorOptions {
  context?: MessageContext;
  /** conflict・not_found などで読み直すクエリ */
  dataKeys?: readonly QueryKey[];
  /**
   * 応答が届かず保存できたか分からない失敗（isUnknownOutcome）で出す文言。省くと unknownOutcomeMessage()
   * （「保存できたか分かりません。もう一度「保存」を押すと、確かめてから送ります」。2.6 の (B1)）。
   * 押し直しても確かめてから送らない書き込み（年度の作成・変更、招待・ロール、団体の CSV、削除）は null を渡し、
   * 2.5 の表の文言（「通信できませんでした…」など）にする（notes/T09.md の「(B1) にそろえる」）
   */
  unknownMessage?: string | null;
}

/**
 * 書き込みの失敗を、2.5・2.6 の決まりで扱う：文言を toast で出し、forbidden・state は年度の行と立場を、conflict・not_found は
 * その画面のデータを読み直す。auth はセッションの更新を試す。入力は残す（呼ぶ側はフォームを閉じない）。文言を返す。
 * 応答が届かなかった失敗は unknownOutcomeMessage()（WriteErrorOptions.unknownMessage）。
 */
export function useWriteErrorHandler(): (e: unknown, opts?: WriteErrorOptions) => Promise<string> {
  const queryClient = useQueryClient();
  const { reloadMembership } = useAuth();
  const onAuthError = useAuthErrorHandler();
  const { year } = useSettings();
  return useCallback(
    async (e: unknown, opts: WriteErrorOptions = {}) => {
      const c = classifyError(e);
      const unknownMessage = opts.unknownMessage === undefined ? unknownOutcomeMessage() : opts.unknownMessage;
      const message = isUnknownOutcome(e) && unknownMessage !== null ? unknownMessage : messageFor(c, opts.context);
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

/** 止められた後に読み直せなかったときの文言（2.6 の (B1) の 3。「読み直しました」とは言わない） */
export const LOCKED_UNREAD_MESSAGE = 'ほかの人が変えた可能性がありますが、読み直せませんでした';

export interface LockedSaveRun<Row extends { updated_at: string }> extends LockedWriteCall<Row> {
  /**
   * changed のとき（と、読み直せなかった後に「読み直す」で読めたとき）に、読み直した行（なくなっていれば null）を渡す。
   * 呼ぶ側は更新なら入力の元をこの行にする（入力は残す）。insert は何もしない（insert のまま）
   */
  onRebase?: (row: Row | null) => void;
  /** changed のとき、toast の代わりに欄にエラーを出す（距離の組の重複など）。真を返したら toast を出さない */
  onChanged?: (result: { row: Row | null; conflict: AppError }) => boolean;
  /** failed のとき、欄にエラーを出す（23514 など）。真を返したら useWriteErrorHandler に回さない */
  onFailed?: (e: unknown) => boolean;
}

/**
 * マスタ設定の楽観ロックの更新・一意のキーの insert（団体・場所・品目・距離・今年の使用）を、2.6 の (B1) で送る。
 * run は runLockedWrite の結果を返す（done なら呼ぶ側が「保存しました」か、earlier なら「保存されていました」と出して閉じ、
 * 関係するクエリを読み直す）。changed は conflict の文言を出してデータを読み直し、onRebase で入力の元を付け替える。
 * unknown は unknownOutcomeMessage()。unread は notice（読み直すボタンつき）を出す。確かめるための状態は持たず、
 * 保存のボタンは押せるまま（次の保存はまた同じ道を通る）。
 */
export function useLockedSave(opts: { dataKeys: readonly QueryKey[]; context?: MessageContext }) {
  const onError = useWriteErrorHandler();
  const queryClient = useQueryClient();
  const [unread, setUnread] = useState<{ reload: () => Promise<void> } | null>(null);
  const [reloading, setReloading] = useState(false);
  const { dataKeys, context } = opts;

  const invalidate = useCallback(
    () => Promise.all(dataKeys.map((k) => queryClient.invalidateQueries({ queryKey: k }))),
    [dataKeys, queryClient],
  );

  const run = useCallback(
    async <Row extends { updated_at: string }>(call: LockedSaveRun<Row>): Promise<LockedWriteResult<Row>> => {
      setUnread(null);
      const r = await runLockedWrite(call);
      switch (r.kind) {
        case 'done':
          break;
        case 'failed':
          if (!call.onFailed?.(r.error)) await onError(r.error, { ...(context ? { context } : {}), dataKeys });
          break;
        case 'unknown':
          // 入力を残して unknownOutcomeMessage()。年度の行と立場も読み直す（通信の失敗と同じ。useWriteErrorHandler）。
          // 読み直しは待たない（通信が切れていると再試行で十数秒かかり、その間「保存中…」で保存を押せなくなるため）
          void onError(r.error, { ...(context ? { context } : {}), dataKeys });
          break;
        case 'changed':
          call.onRebase?.(r.row);
          if (call.onChanged?.(r)) await invalidate();
          else await onError(r.conflict, { ...(context ? { context } : {}), dataKeys });
          break;
        case 'unread':
          toast.error(LOCKED_UNREAD_MESSAGE);
          setUnread({
            reload: async () => {
              const row = await call.reread();
              call.onRebase?.(row);
              await invalidate();
            },
          });
          break;
      }
      return r;
    },
    [context, dataKeys, invalidate, onError],
  );

  const reload = async () => {
    if (!unread) return;
    setReloading(true);
    try {
      await unread.reload();
      setUnread(null);
      toast.success('読み直しました');
    } catch (e) {
      toast.error(messageFor(classifyError(e)));
    } finally {
      setReloading(false);
    }
  };

  const notice = unread ? (
    <div role="alert" className="space-y-2 rounded-md border border-destructive/40 p-2 text-sm text-destructive" data-testid="locked-save-unread">
      <p>{LOCKED_UNREAD_MESSAGE}。読み直してから、もう一度保存してください（入力は残しています）。</p>
      <Button type="button" size="sm" variant="outline" onClick={() => void reload()} disabled={reloading}>
        {reloading ? '読み直し中…' : '読み直す'}
      </Button>
    </div>
  ) : null;

  return { run, notice };
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
  /** 場所の削除の前に読む、終了していない年度のルール（年度をまたぐので年度を入れない。利用者ごと） */
  openYearRules: (userId: string) => ['settings', 'open_year_rules', userId] as const,
  /** 自分の年度のロール（終了した年度の「年度を開く」の行き先。利用者ごと） */
  myYearRoles: (userId: string) => ['settings', 'my_year_roles', userId] as const,
};
