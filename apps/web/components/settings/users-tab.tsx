'use client';

// ユーザーのタブ（画面の設計 3.2「ユーザー」。T09）。メンバー（ロールと団体代表）と招待。
// ロールの変更（set_role）と招待は closed では出さない。ロールを外す（remove_role）・団体代表を外す（remove_group_member）・
// 招待の取り消し（revoke_invitation）は closed でも出す。メールはこの画面にだけ出し、toast・ログに入れない。
import { zodResolver } from '@hookform/resolvers/zod';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import type { ColumnDef } from '@tanstack/react-table';
import { useMemo, useState } from 'react';
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
import { ROLE_LABELS, type AppRole } from '@/lib/auth/membership';
import { fetchGroups, fetchMembers, type InvitationRow, type MemberRow } from '@/lib/data/settings';
import { classifyError, messageFor } from '@/lib/errors';
import { CATEGORY_LABELS } from '@/lib/labels';
import { callRpc } from '@/lib/rpc';
import { EMAIL_MAX } from '@/lib/schemas/common';
import { INVITE_KINDS, inviteFormSchema, type InviteFormInput } from '@/lib/schemas/settings';
import { Field, selectClass, settingsKeys, TabHeading, useSettings, useWriteErrorHandler } from './shared';

const ROLES: readonly AppRole[] = ['admin', 'staff', 'viewer'];
const INVITE_KIND_LABELS: Record<(typeof INVITE_KINDS)[number], string> = { ...ROLE_LABELS, rep: '団体代表' };
const NO_NAME = '名前を表示できません';

type Pending =
  | { kind: 'role'; member: MemberRow }
  | { kind: 'remove_role'; member: MemberRow }
  | { kind: 'remove_rep'; member: MemberRow; group: { id: string; name: string } }
  | { kind: 'revoke'; invitation: InvitationRow };

export function UsersTab() {
  const { year, yearWritable } = useSettings();
  const membersQ = useQuery({ queryKey: settingsKeys.members(year.id), queryFn: () => fetchMembers(year.id) });
  const groupsQ = useQuery({ queryKey: settingsKeys.groups(year.id), queryFn: () => fetchGroups(year.id) });
  const [pending, setPending] = useState<Pending | null>(null);
  const [reasonError, setReasonError] = useState<string | null>(null);
  const queryClient = useQueryClient();
  const { reloadMembership } = useAuth();
  const onError = useWriteErrorHandler();
  const groupName = useMemo(() => new Map((groupsQ.data ?? []).map((g) => [g.id, g.name] as const)), [groupsQ.data]);

  const reload = async () => {
    await queryClient.invalidateQueries({ queryKey: settingsKeys.members(year.id) });
    // 自分のロールを変えた・外したときのため、立場も読み直す（裏で。画面は外れない）
    reloadMembership();
  };

  /** 理由つきの操作（理由は任意）。失敗したら開いたまま（理由の誤りは欄に出す） */
  const run = async (fn: () => Promise<unknown>, success: string, rpc: string) => {
    setReasonError(null);
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
      await onError(e, { context: { rpc }, dataKeys: [settingsKeys.members(year.id)], unknownMessage: null });
      if (c.kind === 'state' || c.kind === 'input' || c.kind === 'deadlock') throw e; // 開いたまま
    }
  };

  const memberCols = useMemo<ColumnDef<MemberRow>[]>(
    () => [
      {
        id: 'name',
        header: '表示名',
        cell: ({ row }) => row.original.displayName ?? <span className="text-muted-foreground">{NO_NAME}</span>,
      },
      { id: 'role', header: 'ロール', cell: ({ row }) => (row.original.role ? ROLE_LABELS[row.original.role] : '—') },
      {
        id: 'groups',
        header: '代表する団体',
        cell: ({ row }) =>
          row.original.groups.length === 0 ? (
            '—'
          ) : (
            <ul className="space-y-1">
              {row.original.groups.map((g) => (
                <li key={g.id} className="flex items-center gap-2">
                  <span>{g.name}</span>
                  <Button
                    size="sm"
                    variant="ghost"
                    className="h-7 text-destructive"
                    onClick={() => setPending({ kind: 'remove_rep', member: row.original, group: g })}
                  >
                    代表を外す
                  </Button>
                </li>
              ))}
            </ul>
          ),
      },
      {
        id: 'actions',
        header: '',
        cell: ({ row }) =>
          row.original.role ? (
            <div className="flex justify-end gap-1">
              {yearWritable ? (
                <Button size="sm" variant="outline" onClick={() => setPending({ kind: 'role', member: row.original })}>
                  ロールを変える
                </Button>
              ) : null}
              <Button size="sm" variant="ghost" className="text-destructive" onClick={() => setPending({ kind: 'remove_role', member: row.original })}>
                ロールを外す
              </Button>
            </div>
          ) : null,
      },
    ],
    [yearWritable],
  );

  const invitationCols = useMemo<ColumnDef<InvitationRow>[]>(
    () => [
      { accessorKey: 'email', header: 'メール' },
      {
        id: 'target',
        header: 'ロール・団体',
        cell: ({ row }) =>
          row.original.role ? ROLE_LABELS[row.original.role] : `${groupName.get(row.original.groupId ?? '') ?? '（団体）'} の団体代表`,
      },
      { id: 'state', header: '状態', cell: ({ row }) => (row.original.usedAt ? '使用済み' : '未使用') },
      { id: 'created', header: '招待した日時', cell: ({ row }) => <TokyoTime value={row.original.createdAt} /> },
      {
        id: 'actions',
        header: '',
        cell: ({ row }) =>
          row.original.usedAt ? null : (
            <div className="flex justify-end">
              <Button size="sm" variant="ghost" className="text-destructive" onClick={() => setPending({ kind: 'revoke', invitation: row.original })}>
                取り消す
              </Button>
            </div>
          ),
      },
    ],
    [groupName],
  );

  const who = (m: MemberRow) => m.displayName ?? 'この人';

  return (
    <div className="space-y-8">
      {yearWritable ? (
        <InviteCard groups={groupsQ.data ?? []} onInvited={reload} />
      ) : (
        <p className="text-sm text-muted-foreground">終了した年度では招待・ロールの変更はできません（外す・取り消しはできます）。</p>
      )}

      <section>
        <TabHeading title="メンバー" description="この年度のロールと団体代表。年度の最後の管理者は外せません。" />
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
          description="この年度の画面を開けなくなります（団体代表は残ります）。"
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
      {pending?.kind === 'remove_rep' ? (
        <ReasonDialog
          open
          onOpenChange={(o) => !o && setPending(null)}
          title={`${who(pending.member)}を「${pending.group.name}」の団体代表から外しますか`}
          required={false}
          destructive
          confirmLabel="外す"
          pendingLabel="外しています…"
          error={reasonError}
          onSubmit={(reason) =>
            run(
              () => callRpc('remove_group_member', { p_group_id: pending.group.id, p_user_id: pending.member.userId, ...(reason ? { p_reason: reason } : {}) }),
              `「${pending.group.name}」の団体代表から外しました`,
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

function RoleDialog({
  member,
  reasonError,
  onClose,
  onSubmit,
}: {
  member: MemberRow;
  reasonError: string | null;
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
            <select id="role-select" className={selectClass} value={role} onChange={(e) => setRole(e.target.value as AppRole)}>
              {ROLES.map((r) => (
                <option key={r} value={r}>
                  {ROLE_LABELS[r]}
                </option>
              ))}
            </select>
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

function InviteCard({ groups, onInvited }: { groups: readonly { id: string; name: string; category: keyof typeof CATEGORY_LABELS }[]; onInvited: () => Promise<void> }) {
  const { year } = useSettings();
  const onError = useWriteErrorHandler();
  const form = useForm<InviteFormInput, unknown, { email: string; role: AppRole | null; group_id: string | null }>({
    resolver: zodResolver(inviteFormSchema),
    defaultValues: { email: '', kind: 'staff', group_id: '' },
  });
  const { register, handleSubmit, formState, setValue, setError, reset, control } = form;
  useUnsavedChanges(formState.isDirty);
  const [saving, setSaving] = useState(false);
  const [result, setResult] = useState<string | null>(null);
  const kind = useWatch({ control, name: 'kind' });
  const groupId = useWatch({ control, name: 'group_id' });

  const onSubmit = handleSubmit(async (v) => {
    setSaving(true);
    setResult(null);
    try {
      const r = await callRpc('invite', {
        p_year_id: year.id,
        p_email: v.email,
        ...(v.role ? { p_role: v.role } : {}),
        ...(v.group_id ? { p_group_id: v.group_id } : {}),
      });
      // applied が偽でも「アカウントがない」とは言わない（今のメールを本人のものと確かめられないときも偽。D-17a）
      const message = r.applied
        ? 'この人はすでにアカウントがあるので、その場でロールを付けました'
        : '招待しました。この人が学校の Google アカウントでログインしたときに付きます';
      setResult(message);
      toast.success(message);
      reset({ email: '', kind: v.role ?? 'rep', group_id: v.group_id ?? '' });
      await onInvited();
    } catch (e) {
      const c = classifyError(e);
      const field = (c.details as { field?: unknown } | null)?.field;
      if (c.kind === 'input' && field === 'email') setError('email', { message: messageFor(c) });
      else if (c.kind === 'input' && field === 'group_id') setError('group_id', { message: '団体を選び直してください' });
      else if (c.kind === 'conflict' && field === 'role') setError('kind', { message: messageFor(c) });
      else await onError(e, { context: { rpc: 'invite' }, dataKeys: [settingsKeys.members(year.id)], unknownMessage: null });
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
          学校の Google アカウントのメールアドレスを入れます。すでにアカウントがあり、今のメールを本人のものと確かめられれば、その場でロールが付きます。
          それ以外（まだアカウントがない、メールを確かめられないなど）は、その人が学校の Google アカウントでログインしたときに付きます。
        </CardDescription>
      </CardHeader>
      <CardContent>
        <form onSubmit={onSubmit} className="grid gap-4 md:grid-cols-3" noValidate data-testid="invite-form">
          <Field label="メールアドレス" error={formState.errors.email?.message}>
            {(p) => <Input {...p} type="email" autoComplete="off" {...register('email')} maxLength={EMAIL_MAX} />}
          </Field>
          <Field label="立場" error={formState.errors.kind?.message}>
            {(p) => (
              <select {...p} {...register('kind')} className={selectClass}>
                {INVITE_KINDS.map((k) => (
                  <option key={k} value={k}>
                    {INVITE_KIND_LABELS[k]}
                  </option>
                ))}
              </select>
            )}
          </Field>
          {kind === 'rep' ? (
            <div className="space-y-1.5">
              <Label>団体</Label>
              <EntitySelect
                label="団体"
                options={groups.map((g) => ({ id: g.id, name: g.name, group: CATEGORY_LABELS[g.category] }))}
                value={groupId === '' ? null : groupId}
                onChange={(id) => setValue('group_id', id ?? '', { shouldDirty: true, shouldValidate: true })}
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
