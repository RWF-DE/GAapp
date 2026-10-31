'use client';

// ユーザーのタブ（画面の設計 3.2「ユーザー」。T09・T15b）。メンバー（ロールと店長・副店長）と招待。
// できる操作は段で分ける（04「マスタ設定」のユーザーの表。D-50。判定は lib/auth/roles.ts）：
// - 招待の立場（1回に1つ）：inviteKindsFor（管理者は7つ、総務部門長・総務副部門長は総務部門員・店長・副店長）。closed では出さない
// - ロールの変更（set_role）：管理者だけ（5つのロールから）。closed では出さない
// - ロールを外す（remove_role）：相手のロールが manageableRoles にあるとき（部門長・副部門長は総務部門員だけ）。closed でも出す
// - 店長⇄副店長（set_group_member_role）：部門長以上。closed では出さない。店長・副店長を外す（remove_group_member）は closed でも出す
// - 招待の取り消し（revoke_invitation）：canRevokeInvitation（部門長・副部門長には RLS が総務部門員と団体の招待だけを返す）。closed でも出す
// 画面の出し分けは見た目だけで、段は DB の RPC が守る。メールはこの画面にだけ出し、toast・ログに入れない。
import { zodResolver } from '@hookform/resolvers/zod';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import type { ColumnDef } from '@tanstack/react-table';
import { useCallback, useMemo, useState } from 'react';
import { useForm, useWatch } from 'react-hook-form';
import { toast } from 'sonner';
import { ConfirmDialog } from '@/components/common/confirm-dialog';
import { DataTable } from '@/components/common/data-table';
import { EntitySelect } from '@/components/common/entity-select';
import { ReasonDialog } from '@/components/common/reason-dialog';
import { TokyoTime } from '@/components/common/tokyo-time';
import { useUnsavedChanges } from '@/components/common/unsaved-changes-guard';
import { EmptyState, QueryState } from '@/components/states';
import { Button } from '@/components/ui/button';
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card';
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from '@/components/ui/dialog';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { useAuth } from '@/lib/auth/auth-provider';
import { GROUP_ROLE_LABELS, groupPositionLabel, ROLE_LABELS } from '@/lib/auth/membership';
import {
  APP_ROLES,
  canRevokeInvitation,
  inviteKindsFor,
  isAdmin,
  isGroupRole,
  isLead,
  manageableRoles,
  type AppRole,
  type GroupRole,
  type InviteKind,
} from '@/lib/auth/roles';
import { fetchGroups, fetchMembers, type InvitationRow, type MemberGroup, type MemberRow } from '@/lib/data/settings';
import { classifyError, messageFor, type ClassifiedError } from '@/lib/errors';
import { CATEGORY_LABELS } from '@/lib/labels';
import { callRpc } from '@/lib/rpc';
import { EMAIL_MAX } from '@/lib/schemas/common';
import { inviteFormSchema, type InviteFormInput, type InviteFormOutput } from '@/lib/schemas/settings';
import { Field, selectClass, settingsKeys, TabHeading, useSettings, useWriteErrorHandler } from './shared';

/** 招待の立場の表示名（ロールと、店長・副店長） */
const INVITE_KIND_LABELS: Record<InviteKind, string> = { ...ROLE_LABELS, ...GROUP_ROLE_LABELS };
const NO_NAME = '名前を表示できません';

/** 店長⇄副店長の切り替えの行き先（店長なら副店長、副店長なら店長） */
const switchedGroupRole = (r: GroupRole): GroupRole => (r === 'manager' ? 'deputy_manager' : 'manager');

/** 兼任の禁止（role_overlap。D-49）か。招待は立場の欄の下、ロールの変更はダイアログの中に出す（04） */
const isRoleOverlap = (c: ClassifiedError) => c.kind === 'conflict' && c.reason === 'role_overlap';

/** 招待の「立場」の列：ロールの招待はロールの表示名、団体の招待は「{団体} の店長」「{団体} の副店長」 */
function invitationTarget(inv: InvitationRow, groupName: ReadonlyMap<string, string>): string {
  if (inv.role) return ROLE_LABELS[inv.role];
  // 団体の招待の立場は 0013 から必ず入る（CHECK）。入っていなければ invite の既定の店長として出す
  return groupPositionLabel({ name: groupName.get(inv.groupId ?? '') ?? '（団体）', role: inv.groupRole ?? 'manager' });
}

type Pending =
  | { kind: 'role'; member: MemberRow }
  | { kind: 'remove_role'; member: MemberRow }
  | { kind: 'switch_group_role'; member: MemberRow; group: MemberGroup; to: GroupRole }
  | { kind: 'remove_rep'; member: MemberRow; group: MemberGroup }
  | { kind: 'revoke'; invitation: InvitationRow };

export function UsersTab() {
  const { year, yearWritable, membership } = useSettings();
  const actor = membership.role;
  const admin = isAdmin(actor);
  const kinds = useMemo(() => inviteKindsFor(actor), [actor]);
  const membersQ = useQuery({ queryKey: settingsKeys.members(year.id), queryFn: () => fetchMembers(year.id) });
  const groupsQ = useQuery({ queryKey: settingsKeys.groups(year.id), queryFn: () => fetchGroups(year.id) });
  const [pending, setPending] = useState<Pending | null>(null);
  const [reasonError, setReasonError] = useState<string | null>(null);
  /** ロールの変更のダイアログの中に出すエラー（兼任の禁止） */
  const [dialogError, setDialogError] = useState<string | null>(null);
  const queryClient = useQueryClient();
  const { reloadMembership } = useAuth();
  const onError = useWriteErrorHandler();
  const groupName = useMemo(() => new Map((groupsQ.data ?? []).map((g) => [g.id, g.name] as const)), [groupsQ.data]);

  /** ダイアログを開く（前のダイアログのエラーを持ち越さない） */
  const open = useCallback((p: Pending) => {
    setReasonError(null);
    setDialogError(null);
    setPending(p);
  }, []);

  const reloadMembers = useCallback(
    () => queryClient.invalidateQueries({ queryKey: settingsKeys.members(year.id) }),
    [queryClient, year.id],
  );

  const reload = async () => {
    await reloadMembers();
    // 自分のロール・店長と副店長を変えた・外したときのため、立場も読み直す（裏で。画面は外れない。ヘッダーの立場も変わる）
    reloadMembership();
  };

  /** 理由つきの操作（理由は任意）。失敗したら開いたまま（理由の誤りは欄に、兼任の禁止はダイアログの中に出す） */
  const run = async (fn: () => Promise<unknown>, success: string, rpc: string) => {
    setReasonError(null);
    setDialogError(null);
    try {
      await fn();
      toast.success(success);
      await reload();
    } catch (e) {
      const c = classifyError(e);
      if (c.kind === 'reason' || (c.kind === 'input' && (c.details as { field?: unknown } | null)?.field === 'reason')) {
        setReasonError(messageFor(c));
        throw e;
      }
      if (isRoleOverlap(c)) {
        // ロールの変更が兼任になる（閲覧のみの店長を総務部門員にするなど）：閉じずにダイアログの中に出し、選んだロールを残す
        // （直すのはほかの行。04）。一覧はほかの人の変更を見せるために読み直す
        setDialogError(messageFor(c, { rpc }));
        await reloadMembers();
        throw e;
      }
      await onError(e, { context: { rpc }, dataKeys: [settingsKeys.members(year.id)], unknownMessage: null });
      if (c.kind === 'state' || c.kind === 'input' || c.kind === 'deadlock') throw e; // 開いたまま
    }
  };

  const memberCols = useMemo<ColumnDef<MemberRow>[]>(() => {
    const lead = isLead(actor);
    const removable = manageableRoles(actor);
    // ロールの変更は管理者だけ（DB は部門長・副部門長に「ロールのない人か staff の人」に staff を付けるのを許すが、一覧でロールのない人は
    // その年度の店長・副店長〔兼任になる〕で、staff の人は変わらないので出さない。総務部門員は招待で足す。D-50）
    const canChangeRole = isAdmin(actor) && yearWritable;
    return [
      {
        id: 'name',
        header: '表示名',
        cell: ({ row }) => row.original.displayName ?? <span className="text-muted-foreground">{NO_NAME}</span>,
      },
      { id: 'role', header: 'ロール', cell: ({ row }) => (row.original.role ? ROLE_LABELS[row.original.role] : '—') },
      {
        id: 'groups',
        header: '店長・副店長',
        cell: ({ row }) =>
          row.original.groups.length === 0 ? (
            '—'
          ) : (
            <ul className="space-y-1">
              {row.original.groups.map((g) => {
                const to = switchedGroupRole(g.role);
                return (
                  <li key={g.id} className="flex flex-wrap items-center gap-x-2 gap-y-1" data-testid="member-position">
                    <span>{groupPositionLabel(g)}</span>
                    {lead && yearWritable ? (
                      <Button
                        size="sm"
                        variant="outline"
                        className="h-7"
                        onClick={() => open({ kind: 'switch_group_role', member: row.original, group: g, to })}
                      >
                        {`${GROUP_ROLE_LABELS[to]}にする`}
                      </Button>
                    ) : null}
                    {lead ? (
                      <Button
                        size="sm"
                        variant="ghost"
                        className="h-7 text-destructive"
                        onClick={() => open({ kind: 'remove_rep', member: row.original, group: g })}
                      >
                        代表を外す
                      </Button>
                    ) : null}
                  </li>
                );
              })}
            </ul>
          ),
      },
      {
        id: 'actions',
        header: '',
        cell: ({ row }) => {
          const role = row.original.role;
          if (!role) return null;
          const canRemove = removable.includes(role);
          if (!canChangeRole && !canRemove) return null;
          return (
            <div className="flex justify-end gap-1">
              {canChangeRole ? (
                <Button size="sm" variant="outline" onClick={() => open({ kind: 'role', member: row.original })}>
                  ロールを変える
                </Button>
              ) : null}
              {canRemove ? (
                <Button size="sm" variant="ghost" className="text-destructive" onClick={() => open({ kind: 'remove_role', member: row.original })}>
                  ロールを外す
                </Button>
              ) : null}
            </div>
          );
        },
      },
    ];
  }, [actor, yearWritable, open]);

  const invitationCols = useMemo<ColumnDef<InvitationRow>[]>(
    () => [
      { accessorKey: 'email', header: 'メール' },
      { id: 'target', header: '立場', cell: ({ row }) => invitationTarget(row.original, groupName) },
      { id: 'state', header: '状態', cell: ({ row }) => (row.original.usedAt ? '使用済み' : '未使用') },
      { id: 'created', header: '招待した日時', cell: ({ row }) => <TokyoTime value={row.original.createdAt} /> },
      {
        id: 'actions',
        header: '',
        cell: ({ row }) =>
          row.original.usedAt || !canRevokeInvitation(actor, row.original) ? null : (
            <div className="flex justify-end">
              <Button size="sm" variant="ghost" className="text-destructive" onClick={() => open({ kind: 'revoke', invitation: row.original })}>
                取り消す
              </Button>
            </div>
          ),
      },
    ],
    [groupName, actor, open],
  );

  const who = (m: MemberRow) => m.displayName ?? 'この人';

  return (
    <div className="space-y-8">
      {yearWritable ? (
        kinds.length > 0 ? (
          <InviteCard groups={groupsQ.data ?? []} kinds={kinds} canChangeRoles={admin} onInvited={reload} onRejected={reloadMembers} />
        ) : null
      ) : (
        <p className="text-sm text-muted-foreground" data-testid="users-closed-note">
          終了した年度では、招待、ロールの変更、店長・副店長の切り替えはできません（外す・取り消しはできます）。
        </p>
      )}

      <section>
        <TabHeading title="メンバー" description="この年度のロールと店長・副店長。年度の最後の管理者は外せません。" />
        <QueryState
          query={{ ...membersQ, data: membersQ.data?.members }}
          isEmpty={(rows) => rows.length === 0}
          empty={<EmptyState title="メンバーがいません" />}
        >
          {(rows) => <DataTable columns={memberCols} data={rows} getRowId={(r) => r.userId} caption="メンバー" />}
        </QueryState>
      </section>

      <section>
        <TabHeading title="招待" description="未使用の招待は、終了した年度でも取り消せます。" />
        <QueryState
          query={{ ...membersQ, data: membersQ.data?.invitations }}
          isEmpty={(rows) => rows.length === 0}
          empty={<EmptyState title="招待はありません" />}
        >
          {(rows) => <DataTable columns={invitationCols} data={rows} getRowId={(r) => r.id} caption="招待" />}
        </QueryState>
      </section>

      {pending?.kind === 'role' ? (
        <RoleDialog
          member={pending.member}
          reasonError={reasonError}
          error={dialogError}
          onEdit={() => setDialogError(null)}
          onClose={() => setPending(null)}
          onSubmit={(role, reason) =>
            run(
              () => callRpc('set_role', { p_year_id: year.id, p_user_id: pending.member.userId, p_role: role, ...(reason ? { p_reason: reason } : {}) }),
              `${who(pending.member)}のロールを「${ROLE_LABELS[role]}」にしました`,
              'set_role',
            )
          }
        />
      ) : null}
      {pending?.kind === 'remove_role' ? (
        <ReasonDialog
          open
          onOpenChange={(o) => !o && setPending(null)}
          title={`${who(pending.member)}のロール（${pending.member.role ? ROLE_LABELS[pending.member.role] : ''}）を外しますか`}
          description={
            admin
              ? 'この年度の画面を開けなくなります（店長・副店長は残ります）。この人あての未使用のロールの招待も取り消します。'
              : 'この年度の画面を開けなくなります。この人あての未使用の総務部門員の招待も取り消します。'
          }
          required={false}
          destructive
          confirmLabel="外す"
          pendingLabel="外しています…"
          error={reasonError}
          onSubmit={(reason) =>
            run(
              () => callRpc('remove_role', { p_year_id: year.id, p_user_id: pending.member.userId, ...(reason ? { p_reason: reason } : {}) }),
              `${who(pending.member)}のロールを外しました`,
              'remove_role',
            )
          }
        />
      ) : null}
      {pending?.kind === 'switch_group_role' ? (
        <ReasonDialog
          open
          onOpenChange={(o) => !o && setPending(null)}
          title={`${who(pending.member)}を「${pending.group.name}」の${GROUP_ROLE_LABELS[pending.to]}にしますか`}
          description="店長と副店長は、できることが同じです（表示だけが変わります）。"
          required={false}
          confirmLabel={`${GROUP_ROLE_LABELS[pending.to]}にする`}
          pendingLabel="変えています…"
          error={reasonError}
          onSubmit={(reason) =>
            run(
              () =>
                callRpc('set_group_member_role', {
                  p_group_id: pending.group.id,
                  p_user_id: pending.member.userId,
                  p_group_role: pending.to,
                  ...(reason ? { p_reason: reason } : {}),
                }),
              `${who(pending.member)}を「${pending.group.name}」の${GROUP_ROLE_LABELS[pending.to]}にしました`,
              'set_group_member_role',
            )
          }
        />
      ) : null}
      {pending?.kind === 'remove_rep' ? (
        <ReasonDialog
          open
          onOpenChange={(o) => !o && setPending(null)}
          title={`${who(pending.member)}を「${pending.group.name}」の${GROUP_ROLE_LABELS[pending.group.role]}から外しますか`}
          required={false}
          destructive
          confirmLabel="外す"
          pendingLabel="外しています…"
          error={reasonError}
          onSubmit={(reason) =>
            run(
              () => callRpc('remove_group_member', { p_group_id: pending.group.id, p_user_id: pending.member.userId, ...(reason ? { p_reason: reason } : {}) }),
              `「${pending.group.name}」の${GROUP_ROLE_LABELS[pending.group.role]}から外しました`,
              'remove_group_member',
            )
          }
        />
      ) : null}
      {pending?.kind === 'revoke' ? (
        <ConfirmDialog
          open
          onOpenChange={(o) => !o && setPending(null)}
          title="この招待を取り消しますか"
          description="取り消した招待は使えなくなります。"
          destructive
          confirmLabel="取り消す"
          pendingLabel="取り消し中…"
          onConfirm={() =>
            run(() => callRpc('revoke_invitation', { p_invitation_id: pending.invitation.id }), '招待を取り消しました', 'revoke_invitation')
          }
        />
      ) : null}
    </div>
  );
}

/** ロールの変更（管理者だけ。5つのロールから）。兼任の禁止はこの中に出し、閉じない */
function RoleDialog({
  member,
  reasonError,
  error,
  onEdit,
  onClose,
  onSubmit,
}: {
  member: MemberRow;
  reasonError: string | null;
  /** 兼任の禁止（role_overlap）など、ダイアログの中に出すエラー */
  error: string | null;
  /** ロールを選び直したとき（前のエラーを消す） */
  onEdit: () => void;
  onClose: () => void;
  onSubmit: (role: AppRole, reason: string | null) => Promise<void>;
}) {
  const [role, setRole] = useState<AppRole>(member.role ?? 'staff');
  const [reason, setReason] = useState('');
  const [busy, setBusy] = useState(false);
  const submit = async () => {
    setBusy(true);
    try {
      await onSubmit(role, reason.trim() || null);
      onClose();
    } catch {
      // 開いたまま
    } finally {
      setBusy(false);
    }
  };
  return (
    <Dialog open onOpenChange={(o) => !o && !busy && onClose()}>
      <DialogContent>
        <DialogHeader>
          <DialogTitle>{member.displayName ?? 'この人'}のロールを変える</DialogTitle>
          <DialogDescription>今のロール：{member.role ? ROLE_LABELS[member.role] : 'なし'}</DialogDescription>
        </DialogHeader>
        <div className="space-y-4">
          <div className="space-y-1.5">
            <Label htmlFor="role-select">新しいロール</Label>
            <select
              id="role-select"
              className={selectClass}
              value={role}
              aria-invalid={error ? true : undefined}
              aria-describedby={error ? 'role-select-error' : undefined}
              onChange={(e) => {
                setRole(e.target.value as AppRole);
                onEdit();
              }}
            >
              {APP_ROLES.map((r) => (
                <option key={r} value={r}>
                  {ROLE_LABELS[r]}
                </option>
              ))}
            </select>
            {error ? (
              <p id="role-select-error" role="alert" className="text-xs text-destructive" data-testid="role-dialog-error">
                {error}
              </p>
            ) : null}
          </div>
          <div className="space-y-1.5">
            <Label htmlFor="role-reason">理由（任意）</Label>
            <Input id="role-reason" value={reason} onChange={(e) => setReason(e.target.value)} maxLength={500} />
            {reasonError ? <p className="text-xs text-destructive">{reasonError}</p> : null}
          </div>
        </div>
        <DialogFooter>
          <Button variant="outline" onClick={onClose} disabled={busy}>
            やめる
          </Button>
          <Button onClick={() => void submit()} disabled={busy || role === member.role}>
            {busy ? '保存中…' : '変える'}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

/** 送った招待の立場（送った後も同じ立場と団体を残す） */
const sentKind = (v: InviteFormOutput): InviteKind => (v.role !== null ? v.role : v.group_role);

function InviteCard({
  groups,
  kinds,
  canChangeRoles,
  onInvited,
  onRejected,
}: {
  groups: readonly { id: string; name: string; category: keyof typeof CATEGORY_LABELS }[];
  /** 選べる立場（inviteKindsFor。並びは選択肢の並び） */
  kinds: readonly InviteKind[];
  /** ロールを変えられる人か（管理者。conflict の field: role の後ろの文を選ぶ） */
  canChangeRoles: boolean;
  onInvited: () => Promise<void>;
  /** 立場の欄に出すエラー（兼任の禁止・別のロール・別の立場）の後に、メンバーと招待の一覧を読み直す */
  onRejected: () => Promise<void>;
}) {
  const { year } = useSettings();
  const onError = useWriteErrorHandler();
  const schema = useMemo(() => inviteFormSchema(kinds), [kinds]);
  const form = useForm<InviteFormInput, unknown, InviteFormOutput>({
    resolver: zodResolver(schema),
    // 既定は総務部門員（どちらの段でも選べる）
    defaultValues: { email: '', kind: kinds.includes('staff') ? 'staff' : (kinds[0] ?? ''), group_id: '' },
  });
  const { register, handleSubmit, formState, setValue, setError, clearErrors, reset, control } = form;
  useUnsavedChanges(formState.isDirty);
  const [saving, setSaving] = useState(false);
  const [result, setResult] = useState<string | null>(null);
  const kind = useWatch({ control, name: 'kind' });
  const groupId = useWatch({ control, name: 'group_id' });

  const onSubmit = handleSubmit(async (v) => {
    setSaving(true);
    setResult(null);
    try {
      // 1回にロールか団体の立場のどちらか1つ（部門のロールと団体を一度に頼まない。D-49）
      const r = await callRpc('invite', {
        p_year_id: year.id,
        p_email: v.email,
        ...(v.role !== null ? { p_role: v.role } : { p_group_id: v.group_id, p_group_role: v.group_role }),
      });
      // applied が偽でも「アカウントがない」とは言わない（今のメールを本人のものと確かめられないときも偽。D-17a）。
      // 店長・副店長の招待はロールでないので、付いた立場（「{団体} の副店長」）で言う
      const message = !r.applied
        ? '招待しました。この人が学校の Google アカウントでログインしたときに付きます'
        : v.role !== null
          ? 'この人はすでにアカウントがあるので、その場でロールを付けました'
          : `この人はすでにアカウントがあるので、その場で「${groupPositionLabel({
              name: groups.find((g) => g.id === v.group_id)?.name ?? '（団体）',
              role: v.group_role,
            })}」にしました`;
      setResult(message);
      toast.success(message);
      reset({ email: '', kind: sentKind(v), group_id: v.group_id ?? '' });
      await onInvited();
    } catch (e) {
      const c = classifyError(e);
      const field = (c.details as { field?: unknown } | null)?.field;
      if (c.kind === 'input' && field === 'email') setError('email', { message: messageFor(c) });
      else if (c.kind === 'input' && field === 'group_id') setError('group_id', { message: '団体を選び直してください' });
      else if (c.kind === 'conflict' && (isRoleOverlap(c) || field === 'role' || field === 'group_role')) {
        // 兼任の禁止・別のロールを持つ・同じ団体に別の立場でいる：立場の欄の下に出し、入力は残す（直す操作はメンバーの一覧か、
        // 別の立場。04・D-50）。一覧は、ほかの人が先に付けた立場も見せるために読み直す
        setError('kind', { message: messageFor(c, { rpc: 'invite', canChangeRoles }) });
        await onRejected();
      } else {
        // forbidden は toast と立場の読み直し（部門長・副部門長には、管理者の未使用の招待があるメールかもしれないと添える。lib/errors.ts）
        await onError(e, { context: { rpc: 'invite', canChangeRoles }, dataKeys: [settingsKeys.members(year.id)], unknownMessage: null });
      }
    } finally {
      setSaving(false);
    }
  });

  return (
    <Card>
      <CardHeader>
        <CardTitle>招待する</CardTitle>
        {/* applied が偽を「アカウントがない」と読ませない（アカウントがあっても今のメールを本人のものと確かめられなければ偽。D-17a） */}
        <CardDescription data-testid="invite-description">
          {
            '学校の Google アカウントのメールアドレスを入れます。すでにアカウントがあり、今のメールを本人のものと確かめられれば、その場で付きます。それ以外（まだアカウントがない、メールを確かめられないなど）は、その人が学校の Google アカウントでログインしたときに付きます。'
          }
        </CardDescription>
      </CardHeader>
      <CardContent>
        <form onSubmit={onSubmit} className="grid gap-4 md:grid-cols-3" noValidate data-testid="invite-form">
          <Field label="メールアドレス" error={formState.errors.email?.message}>
            {(p) => (
              <Input
                {...p}
                type="email"
                autoComplete="off"
                // 立場の欄の下の誤り（兼任の禁止・別の立場）は前に送ったメールのものなので、メールを変えたら消す
                {...register('email', { onChange: () => clearErrors('kind') })}
                maxLength={EMAIL_MAX}
              />
            )}
          </Field>
          <Field
            label="立場"
            error={formState.errors.kind?.message}
            errorTestId="invite-kind-error"
            // 部門長・副部門長には、選べない立場とロールの変更をだれが行うかを添える（D-50）
            hint={canChangeRoles ? undefined : '管理者・総務部門長・総務副部門長・閲覧のみの招待と、ロールの変更は管理者が行います'}
          >
            {(p) => (
              <select {...p} {...register('kind')} className={selectClass}>
                {kinds.map((k) => (
                  <option key={k} value={k}>
                    {INVITE_KIND_LABELS[k]}
                  </option>
                ))}
              </select>
            )}
          </Field>
          {isGroupRole(kind) ? (
            <div className="space-y-1.5">
              <Label>団体</Label>
              <EntitySelect
                label="団体"
                options={groups.map((g) => ({ id: g.id, name: g.name, group: CATEGORY_LABELS[g.category] }))}
                value={groupId === '' ? null : groupId}
                onChange={(id) => {
                  clearErrors('kind');
                  setValue('group_id', id ?? '', { shouldDirty: true, shouldValidate: true });
                }}
              />
              {formState.errors.group_id?.message ? <p className="text-xs text-destructive">{formState.errors.group_id.message}</p> : null}
            </div>
          ) : (
            <div />
          )}
          <div className="md:col-span-3 flex flex-wrap items-center gap-3">
            <Button type="submit" disabled={saving}>
              {saving ? '招待中…' : '招待する'}
            </Button>
            {result ? (
              <p role="status" className="text-sm" data-testid="invite-result">
                {result}
              </p>
            ) : null}
          </div>
        </form>
      </CardContent>
    </Card>
  );
}
