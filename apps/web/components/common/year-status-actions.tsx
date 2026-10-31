'use client';

import { useMutation, useQueryClient } from '@tanstack/react-query';
import { useId, useState } from 'react';
import { toast } from 'sonner';
import { Button } from '@/components/ui/button';
import { Checkbox } from '@/components/ui/checkbox';
import { Label } from '@/components/ui/label';
import { useAuth } from '@/lib/auth/auth-provider';
import { useAuthErrorHandler } from '@/lib/auth/guarded';
import type { AppRole, YearStatus } from '@/lib/auth/membership';
import { isAdmin, isLead } from '@/lib/auth/roles';
import type { ValidationResult } from '@/lib/data/validation';
import type { YearRow } from '@/lib/db/types';
import { classifyError, effectOf, messageFor, type NameLookup } from '@/lib/errors';
import { queryKeys } from '@/lib/query';
import { callRpc } from '@/lib/rpc';
import { AppLink } from './app-link';
import { ErrorBanner } from './error-banner';
import { ReasonDialog } from './reason-dialog';

/** 遷移のボタン（3.1 の表） */
export interface StatusAction {
  to: YearStatus;
  label: string;
  /** 理由が必須か（確定・確定の解除） */
  reasonRequired: boolean;
  destructive: boolean;
}

/**
 * そのロールが今の状態から押せる遷移（closed は何もない）。遷移は部門長以上、終了（closed へ）は管理者だけ
 * （set_year_status の段。D-48・D-50。部門長・副部門長は確定中に「確定を解除」だけ）。部門長以上でなければ何もない。
 */
export function statusActionsFor(status: YearStatus, role: AppRole | null | undefined): StatusAction[] {
  if (!isLead(role)) return [];
  const actions = allStatusActions(status);
  return isAdmin(role) ? actions : actions.filter((a) => a.to !== 'closed');
}

function allStatusActions(status: YearStatus): StatusAction[] {
  switch (status) {
    case 'preparing':
      return [{ to: 'requesting', label: '受付開始', reasonRequired: false, destructive: false }];
    case 'requesting':
      return [{ to: 'allocating', label: '締切（振り分けを始める）', reasonRequired: false, destructive: false }];
    case 'allocating':
      return [{ to: 'confirmed', label: '確定', reasonRequired: true, destructive: false }];
    case 'confirmed':
      return [
        { to: 'allocating', label: '確定を解除', reasonRequired: true, destructive: true },
        { to: 'closed', label: '終了', reasonRequired: false, destructive: true },
      ];
    case 'closed':
      return [];
  }
}

/** 受付開始の前提：締切が未来で入っていること（DB も同じことを確かめる） */
export function canStartRequesting(year: Pick<YearRow, 'request_close_at'>, now: Date = new Date()): boolean {
  return !!year.request_close_at && new Date(year.request_close_at).getTime() > now.getTime();
}

export interface ConfirmInput {
  status: YearStatus;
  /** スナップショットの版（v。先に読んだもの） */
  snapshotVersion: number | null;
  /** useValidation の結果（problems・issues・検証した版） */
  validation: Pick<ValidationResult, 'status' | 'issues' | 'problems' | 'version'> | null;
  /** 版の見張りで、ほかの人の変更に気づいている（StaleBanner が出ている） */
  stale?: boolean;
  /** 振り分け画面の未保存の変更がある */
  unsaved?: boolean;
}

/**
 * 確定を押せない理由の一覧（空なら押せる。画面の設計 3.1 の「確定の流れ」の 2。純粋関数）。
 * DB の確定の検査は E001・E002・E005 だけでルール違反を見ないので、壊れたルール（problems）のまま確定させないのは画面の役目。
 */
export function confirmBlockers(c: ConfirmInput): string[] {
  if (c.status !== 'allocating') return ['振り分け中の年度だけ確定できます'];
  if (c.snapshotVersion === null || !c.validation) return ['振り分けのデータを読み込んでいます'];
  const out: string[] = [];
  const v = c.validation;
  if (v.problems.length > 0) {
    const rules = [...new Set(v.problems.flatMap((p) => (p.ruleCode ? [p.ruleCode] : [])))];
    for (const code of rules) out.push(`ルール ${code} の設定に誤りがあります`);
    const others = v.problems.filter((p) => !p.ruleCode).length;
    if (others > 0) out.push(`入力の誤りが ${others} 件あります`);
  }
  if (v.status === 'unavailable' && v.problems.length === 0) out.push('検証できません');
  if (v.status === 'skipped') out.push('検証していません');
  const errors = v.issues.filter((i) => i.severity === 'error').length;
  if (errors > 0) out.push(`error が ${errors} 件あります`);
  if (v.version !== c.snapshotVersion) out.push('検証した版が古くなりました。読み直してください');
  if (c.stale) out.push('ほかの人が入力を変えました。読み直してから確定してください');
  if (c.unsaved) out.push('保存していない変更があります。先に保存してください');
  return out;
}

/** warning を件数の多い順にコードごとに（「W102 3件」） */
function warningSummary(issues: ValidationResult['issues']): { total: number; top: string[] } {
  const counts = new Map<string, number>();
  for (const i of issues) if (i.severity === 'warning') counts.set(i.code, (counts.get(i.code) ?? 0) + 1);
  const top = [...counts.entries()]
    .sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0]))
    .slice(0, 5)
    .map(([code, n]) => `${code} ${n}件`);
  return { total: [...counts.values()].reduce((a, b) => a + b, 0), top };
}

export interface YearStatusActionsProps {
  /** 年度の行（状態・受付期間） */
  year: Pick<YearRow, 'id' | 'label' | 'status' | 'request_close_at'>;
  /** 確定に使う版（スナップショットの version）。allocating のときに渡す */
  snapshotVersion?: number | null;
  /** useValidation の結果。allocating のときに渡す */
  validation?: ConfirmInput['validation'];
  stale?: boolean;
  unsaved?: boolean;
  /** conflict・issue の後にスナップショットを読み直す（検証は useValidation が回し直す） */
  onReloadSnapshot?: () => unknown;
  /** 「終了」のダイアログに並べる書き出しのボタン（年度データ・振り分け表） */
  closeExtras?: React.ReactNode;
  /** E001 などの details を名前にする */
  names?: NameLookup;
}

/**
 * 年度の状態の遷移のボタンと理由のダイアログ、確定の流れ（画面の設計 3.1。机椅子の状況〔/furniture。T09・T16〕と振り分け画面〔T13〕。T09a）。
 * 部門長以上にだけ出し、「終了」と、その確認に並べる書き出し（closeExtras）は管理者だけ（statusActionsFor。T15b・D-50）。
 * 送信中は押せない。成功したら年度の下のクエリと立場を読み直す。
 *
 * @example
 * const snap = useSnapshot(yearId, 'full');
 * const v = useValidation(snap.data);
 * const { stale } = useVersionWatch(yearId, snap.data?.version ?? null);
 * <YearStatusActions year={snap.data.year} snapshotVersion={snap.data.version} validation={v} stale={stale}
 *   onReloadSnapshot={() => snap.refetch()} names={names} />
 */
export function YearStatusActions({
  year,
  snapshotVersion = null,
  validation = null,
  stale = false,
  unsaved = false,
  onReloadSnapshot,
  closeExtras,
  names,
}: YearStatusActionsProps) {
  const { membership, reloadMembership } = useAuth();
  const queryClient = useQueryClient();
  const onAuthError = useAuthErrorHandler();
  const checkId = useId();
  const [open, setOpen] = useState<StatusAction | null>(null);
  const [openedAt, setOpenedAt] = useState(0);
  const [warningsChecked, setWarningsChecked] = useState(false);
  const [reasonError, setReasonError] = useState<string | null>(null);
  const [lastError, setLastError] = useState<unknown>(null);

  const m = useMutation({
    mutationFn: (v: { to: YearStatus; reason: string | null }) =>
      callRpc('set_year_status', {
        p_year_id: year.id,
        p_to: v.to,
        ...(v.reason ? { p_reason: v.reason } : {}),
        ...(v.to === 'confirmed' && snapshotVersion !== null ? { p_base_version: snapshotVersion } : {}),
      }),
  });

  const role = membership.status === 'ready' ? membership.membership.role : null;
  const actions = statusActionsFor(year.status, role);
  if (actions.length === 0) return null;

  const blockers = confirmBlockers({ status: year.status, snapshotVersion, validation, stale, unsaved });
  const warnings = warningSummary(validation?.issues ?? []);
  const startBlocked = year.status === 'preparing' && !canStartRequesting(year);

  const reloadYear = async () => {
    await queryClient.invalidateQueries({ queryKey: queryKeys.year(year.id) });
    reloadMembership();
  };

  const submit = async (action: StatusAction, reason: string | null) => {
    setReasonError(null);
    setLastError(null);
    try {
      await m.mutateAsync({ to: action.to, reason });
    } catch (e) {
      const c = classifyError(e);
      if (c.kind === 'reason') {
        setReasonError(messageFor(c));
        throw e; // 理由の欄に出し、ダイアログは開いたまま
      }
      if (c.kind === 'auth') {
        await onAuthError(e);
        throw e;
      }
      const effect = effectOf(c);
      setLastError(e);
      if (c.kind === 'conflict' || c.kind === 'issue' || effect.reload === 'data') {
        // 自動で再送しない。読み直して検証し直した結果を見せてから、もう一度押してもらう（3.1 の 6・7）
        await queryClient.invalidateQueries({ queryKey: queryKeys.yearRow(year.id) });
        await onReloadSnapshot?.();
        return; // ダイアログは閉じる
      }
      if (effect.reload === 'year' || c.kind === 'network' || c.kind === 'unknown') {
        // 状態・権限が変わった、または保存されたか分からない：年度の行と立場を読み直す
        await reloadYear();
        return;
      }
      throw e; // input・deadlock など：入力を残して開いたまま
    }
    toast.success(`${year.label} を「${action.label}」にしました`);
    await reloadYear();
  };

  const isConfirm = open?.to === 'confirmed';
  const closeAt = year.request_close_at ? new Date(year.request_close_at) : null;
  const description = (a: StatusAction): React.ReactNode => {
    switch (a.to) {
      case 'requesting':
        return '団体代表が申請を書けるようになります。';
      case 'allocating':
        return a.label === '確定を解除'
          ? '確定を解除すると、団体への公開も止まります。'
          : closeAt && closeAt.getTime() > openedAt
            ? '締切の前ですが、団体代表は申請を変えられなくなります。'
            : '団体代表は申請を変えられなくなります。';
      case 'confirmed':
        return '確定すると、団体代表と閲覧のみの人に振り分けが公開されます。';
      case 'closed':
        return '終了すると読み取り専用になり、戻せません。先に年度データと振り分け表を書き出してください。';
      default:
        return undefined;
    }
  };

  return (
    <div className="space-y-2" data-testid="year-status-actions">
      <div className="flex flex-wrap items-center gap-2">
        {actions.map((a) => {
          const disabled =
            m.isPending || (a.to === 'confirmed' && blockers.length > 0) || (a.to === 'requesting' && startBlocked);
          return (
            <Button
              key={`${a.to}-${a.label}`}
              variant={a.destructive ? 'outline' : 'default'}
              disabled={disabled}
              onClick={() => {
                setWarningsChecked(false);
                setReasonError(null);
                setOpenedAt(Date.now());
                setOpen(a);
              }}
            >
              {m.isPending && m.variables?.to === a.to ? '保存中…' : a.label}
            </Button>
          );
        })}
      </div>
      {startBlocked ? (
        <p className="text-sm text-muted-foreground">
          先に受付期間（締切は未来の日時）を入れてください。
          <AppLink href="/settings?tab=years" className="ml-1 underline">
            マスタ設定の年度へ
          </AppLink>
        </p>
      ) : null}
      {year.status === 'allocating' && blockers.length > 0 ? (
        <ul className="list-inside list-disc text-sm text-muted-foreground" data-testid="confirm-blockers">
          {blockers.map((b) => (
            <li key={b}>{b}</li>
          ))}
        </ul>
      ) : null}
      {lastError ? (
        <ErrorBanner error={lastError} context={{ rpc: 'set_year_status', names }} onReload={() => void onReloadSnapshot?.()} />
      ) : null}
      <ReasonDialog
        open={open !== null}
        onOpenChange={(o) => {
          if (!o) setOpen(null);
        }}
        title={open ? `「${open.label}」にする（${year.label}）` : ''}
        description={open ? description(open) : undefined}
        required={open?.reasonRequired ?? false}
        destructive={open?.destructive ?? false}
        confirmLabel={open?.label ?? '保存する'}
        pending={m.isPending}
        error={reasonError}
        confirmDisabled={isConfirm && (blockers.length > 0 || (warnings.total > 0 && !warningsChecked))}
        onSubmit={(reason) => (open ? submit(open, reason) : undefined)}
      >
        {isConfirm && warnings.total > 0 ? (
          <div className="space-y-2 rounded-md border border-amber-300 bg-amber-50 p-3 text-sm">
            <p>
              warning が {warnings.total} 件あります（{warnings.top.join('、')}）。
            </p>
            <div className="flex items-center gap-2">
              <Checkbox id={checkId} checked={warningsChecked} onCheckedChange={(v) => setWarningsChecked(v === true)} />
              <Label htmlFor={checkId}>warning を確認しました</Label>
            </div>
          </div>
        ) : null}
        {open?.to === 'closed' && closeExtras ? <div className="flex flex-wrap gap-2">{closeExtras}</div> : null}
      </ReasonDialog>
    </div>
  );
}
