'use client';

// 年度のタブ（画面の設計 3.2「年度」。T09・T15b）：今の年度の変更（update_year）と、新しい年度の作成（create_year_from）。
// 年度名・1日目の変更と年度の作成は管理者だけ。総務部門長・総務副部門長は受付期間だけを変えられる（年度名・1日目は入力欄でなく
// 文字で出す〔書ける欄と見分けられるように〕。update_year は管理者でない人のほかのキーを forbidden にする。D-48・D-50）。
import { zodResolver } from '@hookform/resolvers/zod';
import { useQueryClient } from '@tanstack/react-query';
import { useState } from 'react';
import { useForm } from 'react-hook-form';
import { toast } from 'sonner';
import type { z } from 'zod';
import { AppLink } from '@/components/common/app-link';
import { useUnsavedChanges } from '@/components/common/unsaved-changes-guard';
import { YearStatusBadge } from '@/components/common/year-status-badge';
import { Button } from '@/components/ui/button';
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card';
import { Input } from '@/components/ui/input';
import { useAuth } from '@/lib/auth/auth-provider';
import { useGuardedSetYear } from '@/lib/auth/guarded';
import { isAdmin } from '@/lib/auth/roles';
import { createYearFrom, yearPatch } from '@/lib/data/settings';
import { formatDate, toDateTimeLocal } from '@/lib/datetime';
import type { YearRow } from '@/lib/db/types';
import { classifyError, messageFor } from '@/lib/errors';
import { queryKeys } from '@/lib/query';
import { callRpc } from '@/lib/rpc';
import { FESTIVAL_START_MAX, FESTIVAL_START_MIN, REASON_MAX } from '@/lib/schemas/common';
import { yearCreateSchema, yearEditSchema, type YearEditInput } from '@/lib/schemas/settings';
import { Field, useSettings, useWriteErrorHandler } from './shared';

/** disabledRuleCodes が null：年度は作れたが、無効になったルールを数えられなかった（作った後のルールの読み込みの失敗） */
type CreatedYear = { year: YearRow; disabledRuleCodes: string[] | null };

/** 無効になったルールを数えられなかったときの知らせ */
const DISABLED_RULES_UNKNOWN_MESSAGE = '無効になったルールの数を確かめられませんでした。ルール画面で確かめてください';

// 作った結果。作ると新しい年度に切り替わり、画面が作り直される（AppShell の key）ので、state ではなくモジュールに置いて
// 新しい年度の年度のタブで出す（04・設計 3.2：無効になったルールの数とルール画面へのリンク）。閉じるか再読み込みで消える。
let lastCreated: CreatedYear | null = null;

export function YearsTab() {
  const { year, membership } = useSettings();
  // 年度の作成は、最新の年度の管理者だけ（create_year_from。部門長・副部門長には作成の欄を出さず、管理者が作ると知らせる）
  const canCreate = isAdmin(membership.role) && membership.latestYear?.id === year.id;
  // 作った年度で出す（切り替えが止められたときは、作る前の年度の画面にそのまま残る）
  const [created, setCreated] = useState<CreatedYear | null>(() => (lastCreated && lastCreated.year.id === year.id ? lastCreated : null));
  const onCreated = (r: CreatedYear) => {
    lastCreated = r;
    setCreated(r);
  };
  const dismiss = () => {
    lastCreated = null;
    setCreated(null);
  };
  return (
    <div className="space-y-6">
      {created ? <YearCreatedNotice created={created} onDismiss={dismiss} /> : null}
      <YearEditCard key={`${year.id}:${year.updated_at}`} year={year} />
      {canCreate ? (
        <YearCreateCard year={year} onCreated={onCreated} />
      ) : (
        <p className="text-sm text-muted-foreground" data-testid="year-create-unavailable">
          {isAdmin(membership.role)
            ? `新しい年度は、最新の年度（${membership.latestYear?.label ?? '—'}）を開いて、その年度の管理者が作れます。`
            : `新しい年度は、最新の年度（${membership.latestYear?.label ?? '—'}）の管理者が作ります。`}
        </p>
      )}
    </div>
  );
}

type EditForm = YearEditInput & { reason: string };

function YearEditCard({ year }: { year: YearRow }) {
  const { yearWritable, membership } = useSettings();
  // 年度名・1日目を変えられるのは管理者だけ（部門長・副部門長は受付期間だけ。欄は読み取りにし、patch も受付期間だけにする）
  const admin = isAdmin(membership.role);
  const queryClient = useQueryClient();
  const { reloadMembership } = useAuth();
  const onError = useWriteErrorHandler();
  const schema = yearEditSchema(year.status);
  const form = useForm<EditForm>({
    defaultValues: {
      label: year.label,
      festival_start: year.festival_start,
      request_open_at: toDateTimeLocal(year.request_open_at),
      request_close_at: toDateTimeLocal(year.request_close_at),
      reason: '',
    },
  });
  const { register, handleSubmit, formState, setError, reset } = form;
  useUnsavedChanges(formState.isDirty);
  const [saving, setSaving] = useState(false);
  const disabled = !yearWritable || saving;

  const onSubmit = handleSubmit(async (values) => {
    const parsed = schema.safeParse(values);
    if (!parsed.success) {
      for (const i of parsed.error.issues) setError(String(i.path[0]) as keyof EditForm, { message: i.message });
      return;
    }
    const patch = yearPatch(year, parsed.data, { windowOnly: !admin });
    if (Object.keys(patch).length === 0) {
      toast.info('変わった項目がありません');
      return;
    }
    const reason = values.reason.trim();
    setSaving(true);
    try {
      await callRpc('update_year', { p_year_id: year.id, p_patch: patch, ...(reason ? { p_reason: reason } : {}) });
      toast.success('年度を保存しました');
      reset(values);
      await queryClient.invalidateQueries({ queryKey: queryKeys.year(year.id) });
      reloadMembership();
    } catch (e) {
      const c = classifyError(e);
      const d = c.details as { field?: unknown } | null;
      const field = d && typeof d.field === 'string' ? d.field : null;
      if (c.kind === 'input' && (field === 'festival_start' || field === 'request_close_at' || field === 'reason')) {
        setError(field, { message: messageFor(c) });
      } else if (c.kind === 'conflict' && field === 'label') {
        setError('label', { message: messageFor(c) });
      } else {
        await onError(e, { context: { rpc: 'update_year' }, dataKeys: [queryKeys.yearRow(year.id)], unknownMessage: null });
      }
    } finally {
      setSaving(false);
    }
  });

  const err = (k: keyof EditForm) => formState.errors[k]?.message;
  return (
    <Card>
      <CardHeader>
        <CardTitle className="flex items-center gap-2">
          今の年度 <YearStatusBadge status={year.status} />
        </CardTitle>
        <CardDescription data-testid="year-edit-description">
          {admin
            ? '年度名・1日目・申請の受付期間を変えます。受付開始の前に締切を入れてください（受付中は締切を空にできません）。'
            : '申請の受付期間を変えます（年度名と1日目は管理者が変えます）。受付開始の前に締切を入れてください（受付中は締切を空にできません）。'}
        </CardDescription>
      </CardHeader>
      <CardContent>
        <form onSubmit={onSubmit} className="grid gap-4 md:grid-cols-2" noValidate data-testid="year-edit-form">
          {admin ? (
            <>
              <Field label="年度名" error={err('label')}>
                {(p) => <Input {...p} {...register('label')} readOnly={disabled} maxLength={50} />}
              </Field>
              <Field label="1日目" error={err('festival_start')} hint="前の年度より後・次の年度より前の日付にします">
                {(p) => (
                  <Input {...p} type="date" min={FESTIVAL_START_MIN} max={FESTIVAL_START_MAX} {...register('festival_start')} readOnly={disabled} />
                )}
              </Field>
            </>
          ) : (
            // 部門長・副部門長：年度名と1日目は変えられないので、入力欄でなく文字で出す（読み取りの入力欄は書ける欄と同じ見た目のため）
            <dl className="grid gap-4 md:col-span-2 md:grid-cols-2" data-testid="year-fixed-fields">
              <FixedField label="年度名" value={year.label} testId="year-fixed-label" />
              <FixedField label="1日目" value={formatDate(year.festival_start)} testId="year-fixed-festival-start" />
            </dl>
          )}
          <Field label="受付開始（日本時間）" error={err('request_open_at')}>
            {(p) => <Input {...p} type="datetime-local" {...register('request_open_at')} readOnly={disabled} />}
          </Field>
          <Field label="締切（日本時間）" error={err('request_close_at')}>
            {(p) => (
              <Input {...p} type="datetime-local" {...register('request_close_at')} readOnly={disabled} required={year.status === 'requesting'} />
            )}
          </Field>
          <Field label="理由（任意）" error={err('reason')} className="md:col-span-2">
            {(p) => <Input {...p} {...register('reason')} readOnly={disabled} maxLength={REASON_MAX} />}
          </Field>
          {yearWritable ? (
            <div className="md:col-span-2">
              <Button type="submit" disabled={saving || !formState.isDirty}>
                {saving ? '保存中…' : '年度を保存'}
              </Button>
            </div>
          ) : null}
        </form>
      </CardContent>
    </Card>
  );
}

/** 変えられない項目（部門長・副部門長の年度名と1日目）：見出しと値を文字で出す */
function FixedField({ label, value, testId }: { label: string; value: string; testId: string }) {
  return (
    <div className="space-y-1.5">
      <dt className="text-sm leading-none font-medium">{label}</dt>
      <dd className="flex min-h-9 flex-wrap items-center gap-x-2 text-sm">
        <span data-testid={testId}>{value}</span>
        <span className="text-xs text-muted-foreground">（管理者が変えます）</span>
      </dd>
    </div>
  );
}

type CreateForm = z.input<ReturnType<typeof yearCreateSchema>>;

function YearCreatedNotice({ created, onDismiss }: { created: CreatedYear; onDismiss: () => void }) {
  const codes = created.disabledRuleCodes;
  return (
    <div role="status" data-testid="year-created" className="flex flex-wrap items-center gap-2 rounded-md border bg-muted/40 p-3 text-sm">
      <span>
        {created.year.label} を作りました。
        {codes === null
          ? `${DISABLED_RULES_UNKNOWN_MESSAGE}。`
          : `無効になったルール ${codes.length} 件${codes.length > 0 ? `（${codes.join('、')}）` : ''}。`}
        <AppLink href="/rules" className="ml-1 underline">
          ルール画面へ
        </AppLink>
      </span>
      <Button size="sm" variant="ghost" className="ml-auto h-7 px-2 text-xs" onClick={onDismiss}>
        閉じる
      </Button>
    </div>
  );
}

function YearCreateCard({ year, onCreated }: { year: YearRow; onCreated: (r: CreatedYear) => void }) {
  const { reloadMembership } = useAuth();
  const setYear = useGuardedSetYear();
  const onError = useWriteErrorHandler();
  const schema = yearCreateSchema(year.festival_start);
  const form = useForm<CreateForm, unknown, z.output<typeof schema>>({
    resolver: zodResolver(schema),
    defaultValues: { label: '', festival_start: '' },
  });
  const { register, handleSubmit, formState, setError, reset } = form;
  useUnsavedChanges(formState.isDirty);
  const [saving, setSaving] = useState(false);

  const onSubmit = handleSubmit(async (values) => {
    setSaving(true);
    try {
      const r = await createYearFrom(year, values.label, values.festival_start);
      reset({ label: '', festival_start: '' });
      onCreated(r);
      // 年度は作れている（数え直しが失敗しても createYearFrom は投げない）ので、ここから先は作れたものとして扱う
      const codes = r.disabledRuleCodes;
      toast.success(`${r.year.label} を作りました`, {
        description:
          codes === null
            ? DISABLED_RULES_UNKNOWN_MESSAGE
            : codes.length > 0
              ? `対象の団体が見つからず無効になったルールが ${codes.length} 件あります（${codes.join('、')}）。ルール画面で確かめてください`
              : '無効になったルールはありません',
        duration: 15000,
      });
      reloadMembership();
      // reset の後の描画で「未保存の入力」の印が消えてから切り替える（消える前だと切り替えの確かめが出てしまう）
      await new Promise((resolve) => setTimeout(resolve, 0));
      // 新しい年度に切り替える（画面は作り直される。1.3.1）
      await setYear(r.year.id);
    } catch (e) {
      const c = classifyError(e);
      const d = c.details as { field?: unknown } | null;
      const field = d && typeof d.field === 'string' ? d.field : null;
      const message = messageFor(c, { rpc: 'create_year_from', prevFestivalStart: year.festival_start });
      if (c.kind === 'input' && field === 'festival_start') setError('festival_start', { message });
      else if (c.kind === 'input' && field === 'label') setError('label', { message });
      else if (c.kind === 'input' && !field) {
        setError('label', { message });
        setError('festival_start', { message });
      } else if (c.kind === 'conflict' && field === 'label') setError('label', { message });
      else await onError(e, { context: { rpc: 'create_year_from', prevFestivalStart: year.festival_start }, unknownMessage: null });
    } finally {
      setSaving(false);
    }
  });

  const err = (k: keyof CreateForm) => formState.errors[k]?.message;
  return (
    <Card>
      <CardHeader>
        <CardTitle>新しい年度を作る</CardTitle>
        <CardDescription>
          {year.label}（1日目 {formatDate(year.festival_start)}）から複製します。あなたが新しい年度の管理者になります。
        </CardDescription>
      </CardHeader>
      <CardContent className="space-y-4">
        <div className="grid gap-2 text-sm md:grid-cols-2">
          <div className="rounded-md border p-3">
            <p className="font-medium">複製されるもの</p>
            <p className="text-muted-foreground">団体・ルール・場所の使用不可の設定</p>
          </div>
          <div className="rounded-md border p-3">
            <p className="font-medium">複製されないもの</p>
            <p className="text-muted-foreground">在庫・申請・振り分け・了承・ほかの人のロール・招待</p>
          </div>
        </div>
        <p className="text-sm text-muted-foreground">
          団体を付け替えられなかったルールは無効になり、メモに理由が入ります。作った後にその件数を出します。
        </p>
        <form onSubmit={onSubmit} className="grid gap-4 md:grid-cols-2" noValidate data-testid="year-create-form">
          <Field label="新しい年度名" error={err('label')}>
            {(p) => <Input {...p} {...register('label')} maxLength={50} placeholder="R9" />}
          </Field>
          <Field label="新しい年度の1日目" error={err('festival_start')} hint={`${formatDate(year.festival_start)} より後の日付`}>
            {(p) => <Input {...p} type="date" min={FESTIVAL_START_MIN} max={FESTIVAL_START_MAX} {...register('festival_start')} />}
          </Field>
          <div className="md:col-span-2">
            <Button type="submit" disabled={saving}>
              {saving ? '作成中…' : '新しい年度を作る'}
            </Button>
          </div>
        </form>
      </CardContent>
    </Card>
  );
}
