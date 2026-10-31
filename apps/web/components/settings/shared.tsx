'use client';

// マスタ設定の各タブが使う小さな部品と、書き込みのエラーの扱い（画面の設計 2.5・2.6・3.2。T09）。
// 2つ目の画面が要るようになったら common/ に移す（docs/prompts/T09.md）。
import { useQuery, useQueryClient, type QueryKey } from '@tanstack/react-query';
import { createContext, useCallback, useContext, useEffect, useId, useRef, useState } from 'react';
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
  settleLockedCall,
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

/** 「読み直す」で、いまの入力が書く行に止めるものがなかったとき（書き込みの後でない読み直しの not-saved）の文言 */
export const LOCKED_REREAD_NOT_SAVED_MESSAGE = '読み直しました。まだ保存されていません（もう一度「保存」を押してください）';

export interface LockedSaveRun<Row extends { updated_at: string }> extends LockedWriteCall<Row> {
  /**
   * reread が読む行（更新は主キー、insert は一意のキー〔団体・場所の名前、品目のコード、距離の建物の組〕）を表す文字列。
   * 止められて読み直せなかった後の「読み直す」で、いまの入力が止められた書き込みと同じ行を書くかを見る（違えば、止められた
   * 結果はいまの入力に当たらない）
   */
  target: string;
  /**
   * 保存できたとき（判定が saved のときも。earlier が真なら「保存されていました」）。呼ぶ側は文言を出し、閉じて関係するクエリを
   * 読み直す。送った応答のほか、止められて読み直せなかった後の「読み直す」で読んだ行が入力と同じだったときにも呼ぶ
   */
  onSaved: (earlier: boolean) => Promise<void> | void;
  /**
   * 判定が changed（版が進んだ・行ができた・なくなった）のときに、読み直した行（なくなっていれば null）を渡す。
   * 呼ぶ側は更新なら入力の元をこの行にし（入力は残す）、ほかの人の変更として出す。insert は何もしない（insert のまま）。
   * not-saved（版が入力の元のまま）では呼ばない
   */
  onRebase?: (row: Row | null) => void;
  /** changed のとき、toast の代わりに欄にエラーを出す（距離の組の重複など）。真を返したら toast を出さない */
  onChanged?: (result: { row: Row | null; conflict: AppError }) => boolean;
  /** failed のとき、欄にエラーを出す（23514 など）。真を返したら useWriteErrorHandler に回さない */
  onFailed?: (e: unknown) => boolean;
}

/**
 * マスタ設定の楽観ロックの更新・一意のキーの insert（団体・場所・品目・距離・今年の使用）を、2.6 の (B1) で送る。
 * 送った結果も、止められて読み直せなかった後の「読み直す」で読んだ行も、同じ判定（settleLockedCall → settleLockedWrite）を
 * 通し、同じ扱い（handle）にする：done は onSaved（earlier なら「保存されていました」）、changed は conflict の文言を出して
 * データを読み直し、判定が changed なら onRebase で入力の元を付け替える。unknown は unknownOutcomeMessage()。
 * unread は notice（読み直すボタンつき）を出す。not-saved（「読み直す」で、いまの入力が止められたときと別の行を書き、その行に
 * 止めるものがない）は「まだ保存されていません」と出す。確かめるための状態は持たず、保存のボタンは押せるまま（次の保存はまた同じ道を通る）。
 * 「読み直す」の結果は、読み直している間に保存を送った・フォームが外れた（シートを閉じた）なら捨てる（前のフォームの結果を当てない）。
 * current は、いまの入力で作った呼び出し（入力が正しくなければ null）。「読み直す」で読んだ行は、送った値でも読み直しを始めたときの
 * 入力でもなく、行が届いたときの入力と比べる（送った後や読み直し中に入力を変えていれば、前の送信が通っていてもほかの人の変更に
 * 見える。2.6 の (B1)）。
 */
export function useLockedSave<Row extends { updated_at: string }>(opts: {
  dataKeys: readonly QueryKey[];
  context?: MessageContext;
  current: () => LockedSaveRun<Row> | null;
}) {
  const onError = useWriteErrorHandler();
  const queryClient = useQueryClient();
  const [unread, setUnread] = useState<{ call: LockedSaveRun<Row>; error: unknown } | null>(null);
  const [reloading, setReloading] = useState(false);
  // 送信と「読み直す」の世代。送るたびと、フォームが外れたとき（シートを閉じた）に進める。「読み直す」の結果は、始めたときから
  // 世代が変わっていなければ当てる。変わっていれば捨てる（読み直し中に送った保存の結果がもう出ている・前のフォームの onSaved が
  // 後から開いた別のシートを閉じてしまうため）。保存のボタンは押せるまま（2.6 の (B1)）
  const generation = useRef(0);
  useEffect(
    () => () => {
      generation.current += 1;
    },
    [],
  );
  // いまの入力で作った呼び出し。「読み直す」の行が届いたときに、そのときの入力で判定するために描画ごとに置き換える
  // （reload の閉包の current は押したときの描画のもので、入力の元〔base〕などが古いことがあるため）
  const currentRef = useRef(opts.current);
  useEffect(() => {
    currentRef.current = opts.current;
  });
  const { dataKeys, context } = opts;

  const invalidate = useCallback(
    () => Promise.all(dataKeys.map((k) => queryClient.invalidateQueries({ queryKey: k }))),
    [dataKeys, queryClient],
  );

  const handle = useCallback(
    async (call: LockedSaveRun<Row>, r: LockedWriteResult<Row>) => {
      switch (r.kind) {
        case 'done':
          await call.onSaved(r.earlier);
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
          if (r.outcome === 'changed') call.onRebase?.(r.row);
          if (call.onChanged?.(r)) await invalidate();
          else await onError(r.conflict, { ...(context ? { context } : {}), dataKeys });
          break;
        case 'unread':
          toast.error(LOCKED_UNREAD_MESSAGE);
          setUnread({ call, error: r.error });
          break;
        case 'not-saved':
          // いまの入力が書く行を止めるものはない（入力を残し、次の保存はふつうに送る）。一覧などは読み直す
          toast.info(LOCKED_REREAD_NOT_SAVED_MESSAGE);
          await invalidate();
          break;
      }
    },
    [context, dataKeys, invalidate, onError],
  );

  const run = useCallback(
    async (call: LockedSaveRun<Row>): Promise<LockedWriteResult<Row>> => {
      generation.current += 1;
      setUnread(null);
      setReloading(false);
      const r = await runLockedWrite(call);
      await handle(call, r);
      return r;
    },
    [handle],
  );

  // 止められて読み直せなかった後の「読み直す」：送った後と同じ判定（settleLockedCall → settleLockedWrite → handle）を通す。
  // 読む行は、読み直しを始めたときの入力が書く行（更新は主キー、insert は一意のキー）。届いた行は、届いたときの入力で判定する
  // （読み直し中に入力を変えていれば、変えた後の入力と比べる。前の入力と同じ行が届いても「保存されていました」で閉じない）。
  // 届いたときの入力が止められた書き込みと同じ行を書くなら、止められたときのエラーで決める。別の行を書く（insert で一意のキーを
  // 変えた）なら、止められた結果はいまの入力に当たらないので、書き込みの後でない読み直し（e が null）で決める（行がなければ
  // not-saved。重複とは言わない）。読み直し中に一意のキーを変えた（届いた行がいまの入力の書く行でない）なら、その行では決められない
  // ので結果を当てず、読み直せていないときのまま（notice と「読み直す」）にする。読み直している間に保存を送った・フォームが
  // 外れたなら、届いた結果は捨てる（generation）
  const reload = async () => {
    if (!unread) return;
    const pending = unread;
    const callNow = (): LockedSaveRun<Row> => currentRef.current() ?? { ...pending.call, matches: () => false };
    const start = callNow();
    const started = generation.current;
    setReloading(true);
    try {
      let read: { ok: true; row: Row | null } | { ok: false; error: unknown };
      try {
        read = { ok: true, row: await start.reread() };
      } catch (error) {
        read = { ok: false, error };
      }
      if (generation.current !== started) return;
      const now = callNow();
      if (now.target !== start.target) return;
      const got = read;
      const r = await settleLockedCall<Row>(
        {
          ...now,
          reread: async () => {
            if (!got.ok) throw got.error;
            return got.row;
          },
        },
        now.target === pending.call.target ? pending.error : null,
      );
      // また読み直せなければ handle が notice を出し直す（いまの入力の呼び出しで）
      if (r.kind !== 'unread') setUnread(null);
      await handle(now, r);
    } finally {
      // 読み直し中に保存を送ったなら、読み直し中の表示は run が戻している（その後に始めた読み直しの表示を消さない）
      if (generation.current === started) setReloading(false);
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
  errorTestId,
  children,
}: {
  label: string;
  error?: string | undefined;
  hint?: React.ReactNode;
  className?: string;
  /** エラーの文の data-testid（E2E が欄の下の文を名指しで見るとき。招待の立場の欄など） */
  errorTestId?: string;
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
        <p id={errId} role="alert" className="text-xs text-destructive" data-testid={errorTestId}>
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
