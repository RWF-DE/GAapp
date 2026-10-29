'use client';

// ルール（/rules。admin。PC）の画面（画面の設計 3.8。T12）。
// 一覧（コード・種別・内容の文・有効・メモ）、種別ごとのフォームでの追加・編集、R8 の初期ルールのひな形、有効・無効の切り替え。
// 削除は出さない（無効にしてメモに理由を書く。無効のルールも次の年度に引き継がれる）。確定中と終了の年度はメモだけ直せる。
import { useQueryClient } from '@tanstack/react-query';
import type { ColumnDef } from '@tanstack/react-table';
import { AlertTriangle, ChevronDown, Info, Pencil, Plus } from 'lucide-react';
import { useSearchParams } from 'next/navigation';
import { useEffect, useId, useMemo, useState } from 'react';
import { toast } from 'sonner';
import { RULE_KINDS, type RuleKind } from '@gaapp/shared';
import { ConfirmDialog } from '@/components/common/confirm-dialog';
import { DataTable } from '@/components/common/data-table';
import { ErrorBanner } from '@/components/common/error-banner';
import { PageHeader } from '@/components/common/page-header';
import { EmptyState, ErrorState, LoadingState, ReadOnlyNotice } from '@/components/states';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuLabel,
  DropdownMenuTrigger,
} from '@/components/ui/dropdown-menu';
import { Label } from '@/components/ui/label';
import { Switch } from '@/components/ui/switch';
import { Textarea } from '@/components/ui/textarea';
import { useAuth } from '@/lib/auth/auth-provider';
import { useAuthErrorHandler } from '@/lib/auth/guarded';
import {
  checkEnable,
  describeRule,
  emptyRuleForm,
  findRuleByCode,
  findRuleById,
  insertRule,
  missingTemplates,
  parseCodeParam,
  ruleEditMode,
  ruleNamesOf,
  ruleProblems,
  ruleToForm,
  sameRuleWrite,
  templateToForm,
  updateRule,
  useRulesData,
  type RuleProblem,
  type RulesData,
  type RuleTemplate,
  type RuleWrite,
} from '@/lib/data/rules';
import type { RuleDbRow } from '@/lib/db/types';
import { classifyError, effectOf, messageFor } from '@/lib/errors';
import { RULE_KIND_LABELS } from '@/lib/labels';
import { queryKeys } from '@/lib/query';
import { NOTE_MAX, optionalText } from '@/lib/schemas/common';
import { cn } from '@/lib/utils';
import { RuleFormSheet, type RuleSheetTarget, type SaveOutcome } from './rule-form-sheet';

const memoSchema = optionalText(NOTE_MAX);

export function RulesScreen() {
  const { membership } = useAuth();
  const yearId = membership.status === 'ready' ? (membership.membership.year?.id ?? null) : null;
  const q = useRulesData(yearId);
  const searchParams = useSearchParams();
  const code = parseCodeParam(searchParams.get('code'));
  // 読んだ後の読み直しの失敗（TanStack Query は前の data を残したまま isError にする）。
  // 画面を ErrorState に置き換えず（開いているシートの入力を残す。1.3・2.5・2.6）、toast と一覧の上の帯で知らせる
  const reloadFailed = q.isError && q.data !== undefined;
  useEffect(() => {
    if (reloadFailed) toast.error(`${RELOAD_FAILED_MESSAGE}（${messageFor(classifyError(q.error))}）`);
    // eslint-disable-next-line react-hooks/exhaustive-deps -- 失敗のたびに1回（errorUpdatedAt が変わったとき）だけ知らせる
  }, [reloadFailed, q.errorUpdatedAt]);

  if (!yearId) return <EmptyState title="年度がありません" />;
  if (q.isError && q.data === undefined) {
    return (
      <>
        <PageHeader title="ルール" />
        <ErrorState message={messageFor(classifyError(q.error))} onRetry={() => void q.refetch()} />
      </>
    );
  }
  if (q.isPending || !q.data) {
    return (
      <>
        <PageHeader title="ルール" />
        <LoadingState />
      </>
    );
  }
  return (
    <RulesView
      key={`${yearId}|${code ?? ''}`}
      data={q.data}
      code={code}
      loadedAt={q.dataUpdatedAt ? new Date(q.dataUpdatedAt) : null}
      reloading={q.isFetching}
      reloadError={reloadFailed ? q.error : null}
      onReload={() => void q.refetch()}
    />
  );
}

function RulesView({
  data,
  code,
  loadedAt,
  reloading,
  reloadError,
  onReload,
}: {
  data: RulesData;
  code: string | null;
  loadedAt: Date | null;
  reloading: boolean;
  /** 読み直しの失敗（表示は前に読んだ内容のまま） */
  reloadError: unknown;
  onReload: () => void;
}) {
  const queryClient = useQueryClient();
  const { reloadMembership } = useAuth();
  const onAuthError = useAuthErrorHandler();
  const yearId = data.year.id;
  const editMode = ruleEditMode(data.year.status);
  const names = useMemo(() => ruleNamesOf(data), [data]);
  const problems = useMemo(() => ruleProblems(data), [data]);
  const templates = useMemo(() => missingTemplates(data.rules), [data.rules]);

  // ?code=S05：その行を目立たせて、編集のシートを開く（振り分け画面の原因・入力の誤りのリンクから来る）。
  // 開いたときの1回だけ（code が変われば、呼ぶ側の key で作り直す）
  const [codeRule] = useState(() => (code ? (data.rules.find((x) => x.code.trim() === code) ?? null) : null));
  const [sheet, setSheet] = useState<RuleSheetTarget | null>(() =>
    codeRule ? { type: 'edit', ruleId: codeRule.id, initial: ruleToForm(codeRule), baseUpdatedAt: codeRule.updated_at } : null,
  );
  const [highlight, setHighlight] = useState<string | null>(codeRule?.id ?? null);
  const [toggling, setToggling] = useState<string | null>(null);
  const [disableTarget, setDisableTarget] = useState<RuleDbRow | null>(null);
  const [enableBlocked, setEnableBlocked] = useState<{ rule: RuleDbRow; messages: string[] } | null>(null);

  const missingCode = code && !codeRule ? code : null;
  useEffect(() => {
    if (missingCode) toast.error(`ルール「${missingCode}」は見つかりません`);
  }, [missingCode]);

  const afterSaved = async () => {
    await queryClient.invalidateQueries({ queryKey: queryKeys.year(yearId) });
  };

  /**
   * 書き込みを送り、エラーを分ける（2.5・2.6）。401 は1回だけセッションを更新して送り直す。
   * 通信の失敗（保存されたか分からない）は verify で読み直し、保存されていれば成功とする。
   */
  const runWrite = async (send: () => Promise<unknown>, verify: () => Promise<boolean>, okMessage: string): Promise<SaveOutcome> => {
    let error: unknown;
    try {
      await send();
      await afterSaved();
      toast.success(okMessage);
      return { ok: true };
    } catch (e) {
      error = e;
    }
    if ((await onAuthError(error)) === 'retry') {
      try {
        await send();
        await afterSaved();
        toast.success(okMessage);
        return { ok: true };
      } catch (e) {
        error = e;
      }
    }
    const c = classifyError(error);
    if (c.kind === 'network' || (c.kind === 'unknown' && c.reason !== 'unexpected_response')) {
      try {
        if (await verify()) {
          await afterSaved();
          toast.success('保存されていました');
          return { ok: true };
        }
      } catch {
        return { ok: false, error, notice: UNKNOWN_OUTCOME_MESSAGE };
      }
      return { ok: false, error };
    }
    if (c.code === '23505') {
      onReload();
      return { ok: false, error, fieldErrors: { code: ['同じコードのルールがあります'] } };
    }
    const effect = effectOf(c);
    if (effect.reload === 'data') onReload();
    if (effect.reload === 'year') {
      onReload();
      reloadMembership();
    }
    return { ok: false, error };
  };

  const onInsert = (row: RuleWrite) =>
    runWrite(
      () => insertRule(yearId, row),
      async () => {
        const saved = await findRuleByCode(yearId, row.code);
        return !!saved && sameRuleWrite(saved, row);
      },
      `ルール ${row.code} を追加しました`,
    );

  const onUpdate = (rule: RuleDbRow, patch: Partial<RuleWrite>) =>
    runWrite(
      () => updateRule(rule, patch),
      async () => {
        const saved = await findRuleById(rule.id);
        return !!saved && saved.updated_at !== rule.updated_at && sameRuleWrite(saved, patch);
      },
      `ルール ${patch.code ?? rule.code} を保存しました`,
    );

  const setEnabled = async (rule: RuleDbRow, enabled: boolean, memo?: string | null) => {
    const patch: Partial<RuleWrite> = memo === undefined ? { enabled } : { enabled, memo };
    setToggling(rule.id);
    try {
      const out = await runWrite(
        () => updateRule(rule, patch),
        async () => {
          const saved = await findRuleById(rule.id);
          return !!saved && saved.updated_at !== rule.updated_at && sameRuleWrite(saved, patch);
        },
        enabled ? `ルール ${rule.code} を有効にしました` : `ルール ${rule.code} を無効にしました`,
      );
      if (!out.ok) {
        toast.error(out.notice ?? messageFor(classifyError(out.error)));
        throw out.error;
      }
    } finally {
      setToggling(null);
    }
  };

  const onToggle = (rule: RuleDbRow, next: boolean) => {
    if (editMode !== 'full') return;
    if (!next) {
      setDisableTarget(rule);
      return;
    }
    const messages = checkEnable(rule, data);
    if (messages.length > 0) {
      setEnableBlocked({ rule, messages });
      return;
    }
    void setEnabled(rule, true).catch(() => undefined);
  };

  const openEdit = (r: RuleDbRow) => {
    setHighlight(r.id);
    setSheet({ type: 'edit', ruleId: r.id, initial: ruleToForm(r), baseUpdatedAt: r.updated_at });
  };
  const openNew = (kind: RuleKind) => setSheet({ type: 'new', initial: emptyRuleForm(kind) });
  const openTemplate = (t: RuleTemplate) => setSheet({ type: 'new', initial: templateToForm(t), template: t.code });

  const columns = useMemo<ColumnDef<RuleDbRow>[]>(
    () => [
      {
        accessorKey: 'code',
        header: 'コード',
        cell: ({ row }) => <span className="font-mono font-medium">{row.original.code}</span>,
      },
      {
        accessorKey: 'kind',
        header: '種別',
        cell: ({ row }) => <span className="whitespace-nowrap">{RULE_KIND_LABELS[row.original.kind]}</span>,
      },
      {
        id: 'description',
        header: '内容',
        enableSorting: false,
        cell: ({ row }) => <RuleDescription rule={row.original} text={describeRule(row.original, names)} problem={problems.get(row.original.id)} />,
      },
      {
        accessorKey: 'enabled',
        header: '有効',
        cell: ({ row }) => (
          <EnabledSwitch
            rule={row.original}
            disabled={editMode !== 'full' || toggling !== null}
            onChange={(v) => onToggle(row.original, v)}
          />
        ),
      },
      {
        accessorKey: 'memo',
        header: 'メモ',
        enableSorting: false,
        cell: ({ row }) => <span className="line-clamp-2 min-w-40 max-w-72 text-muted-foreground">{row.original.memo ?? ''}</span>,
      },
      {
        id: 'actions',
        header: '',
        enableSorting: false,
        cell: ({ row }) => (
          <Button size="sm" variant="outline" onClick={() => openEdit(row.original)} aria-label={editMode === 'full' ? `${row.original.code} を編集` : `${row.original.code} のメモを直す`}>
            <Pencil aria-hidden />
            {editMode === 'full' ? '編集' : 'メモ'}
          </Button>
        ),
      },
    ],
    // eslint-disable-next-line react-hooks/exhaustive-deps -- onToggle・openEdit は data と editMode から決まる
    [names, problems, editMode, toggling, data],
  );

  const addMenu = (
    <DropdownMenu>
      <DropdownMenuTrigger asChild>
        <Button>
          <Plus aria-hidden />
          ルールを追加
          <ChevronDown aria-hidden />
        </Button>
      </DropdownMenuTrigger>
      <DropdownMenuContent align="end">
        <DropdownMenuLabel>種別</DropdownMenuLabel>
        {RULE_KINDS.map((k) => (
          <DropdownMenuItem key={k} onSelect={() => openNew(k)}>
            {RULE_KIND_LABELS[k]}
          </DropdownMenuItem>
        ))}
      </DropdownMenuContent>
    </DropdownMenu>
  );

  const templateMenu = (
    <DropdownMenu>
      <DropdownMenuTrigger asChild>
        <Button variant="outline" disabled={templates.length === 0}>
          R8 の初期ルールから追加
          <ChevronDown aria-hidden />
        </Button>
      </DropdownMenuTrigger>
      <DropdownMenuContent align="end" className="max-w-sm">
        <DropdownMenuLabel>まだないルール</DropdownMenuLabel>
        {templates.map((t) => (
          <DropdownMenuItem key={t.code} onSelect={() => openTemplate(t)}>
            <span className="font-mono">{t.code}</span>
            <span className="text-muted-foreground">
              {RULE_KIND_LABELS[t.kind]}
              {t.needsChoice ? '（団体・場所を選ぶ）' : ''}
            </span>
          </DropdownMenuItem>
        ))}
      </DropdownMenuContent>
    </DropdownMenu>
  );

  const brokenCount = problems.size;

  return (
    <div data-testid="rules-screen">
      <PageHeader
        title="ルール"
        loadedAt={loadedAt}
        onReload={onReload}
        reloading={reloading}
        actions={
          editMode === 'full' ? (
            <>
              {templateMenu}
              {addMenu}
            </>
          ) : null
        }
      />
      <div className="space-y-3">
        {reloadError ? (
          <div data-testid="rules-reload-error" className="space-y-1">
            <p className="text-sm text-muted-foreground">{RELOAD_FAILED_MESSAGE}</p>
            <ErrorBanner error={reloadError} onRetry={onReload} />
          </div>
        ) : null}
        <p className="text-sm text-muted-foreground">
          振り分けの代替・運び元の制限・固定の申請・残すを決めます。使わなくなったルールは削除せず無効にし、理由をメモに残します。
        </p>
        {data.year.status === 'allocating' ? (
          <Notice icon={<Info aria-hidden className="size-4 shrink-0" />} testId="rules-allocating-notice">
            ルールを変えると、振り分け画面で再実行が要ります
          </Notice>
        ) : null}
        {data.year.status === 'confirmed' ? (
          <ReadOnlyNotice>確定中です。ルールは確定を解除してから変えてください（メモだけ直せます）</ReadOnlyNotice>
        ) : null}
        {data.year.status === 'closed' ? <ReadOnlyNotice>終了した年度のルールは、メモだけ直せます</ReadOnlyNotice> : null}
        {brokenCount > 0 ? (
          <Notice icon={<AlertTriangle aria-hidden className="size-4 shrink-0" />} tone="warn" testId="rules-problem-notice">
            直す必要のある有効なルールが {brokenCount} 件あります（振り分け・確定の前に、編集して直すか無効にしてください）
          </Notice>
        ) : null}
        {data.rules.length === 0 ? (
          <EmptyState
            title="ルールがありません"
            description={editMode === 'full' ? 'R8 の初期ルール（S01〜S08）から追加するか、種別を選んで追加してください。' : undefined}
            className="rounded-lg border border-dashed"
            action={
              editMode === 'full' ? (
                <div className="flex flex-wrap justify-center gap-2">
                  {templateMenu}
                  {addMenu}
                </div>
              ) : undefined
            }
          />
        ) : (
          <DataTable
            caption="ルールの一覧"
            columns={columns}
            data={data.rules}
            getRowId={(r) => r.id}
            highlightRowId={highlight}
            rowClassName={(r) => (r.enabled ? undefined : 'text-muted-foreground')}
          />
        )}
      </div>

      <RuleFormSheet
        target={sheet}
        onClose={() => setSheet(null)}
        data={data}
        editMode={editMode}
        onInsert={onInsert}
        onUpdate={onUpdate}
        onReload={onReload}
      />

      {disableTarget ? (
        <DisableDialog
          rule={disableTarget}
          onClose={() => setDisableTarget(null)}
          onConfirm={async (memo) => {
            // 開いたときの行（updated_at）で送る。開いた後に一覧が読み直されても版を進めない
            // （メモの欄は開いたときのメモから作ったので、進めるとほかの人のメモを黙って上書きする）
            try {
              await setEnabled(disableTarget, false, memo);
            } catch (e) {
              // ほかの人が先に変えた・消した：一覧は読み直したので閉じる（古い行・古いメモで送り続けない。開き直すと今のメモが入る）
              const kind = classifyError(e).kind;
              if (kind === 'conflict' || kind === 'not_found') setDisableTarget(null);
              throw e;
            }
          }}
        />
      ) : null}

      <ConfirmDialog
        open={enableBlocked !== null}
        onOpenChange={(o) => {
          if (!o) setEnableBlocked(null);
        }}
        title={enableBlocked ? `ルール ${enableBlocked.rule.code} を有効にできません` : ''}
        description="ほかの有効なルールと重なるか、参照が切れています。編集して直してから有効にしてください。"
        confirmLabel="編集する"
        cancelLabel="閉じる"
        onConfirm={() => {
          if (enableBlocked) openEdit(enableBlocked.rule);
        }}
      >
        <ul data-testid="enable-blocked-messages" className="list-inside list-disc space-y-0.5 text-sm text-destructive">
          {(enableBlocked?.messages ?? []).map((m) => (
            <li key={m}>{m}</li>
          ))}
        </ul>
      </ConfirmDialog>
    </div>
  );
}

/** 読んだ後の読み直しに失敗したとき（表示は前に読んだ内容のまま） */
const RELOAD_FAILED_MESSAGE = 'ルールを読み直せませんでした。表示は前に読んだ内容のままです';

/** 通信の失敗の後、保存されたかを読み直しても確かめられなかったとき（2.6） */
const UNKNOWN_OUTCOME_MESSAGE = '保存できたか確かめられません。通信が戻ったら「読み直す」で確かめてから、もう一度保存してください';

function Notice({
  icon,
  tone = 'info',
  testId,
  children,
}: {
  icon: React.ReactNode;
  tone?: 'info' | 'warn';
  testId?: string;
  children: React.ReactNode;
}) {
  return (
    <div
      role="status"
      data-testid={testId}
      className={cn(
        'flex items-center gap-2 rounded-md border px-4 py-2 text-sm',
        tone === 'warn' ? 'border-amber-300 bg-amber-50 text-amber-950' : 'border-sky-200 bg-sky-50 text-sky-950',
      )}
    >
      {icon}
      <span>{children}</span>
    </div>
  );
}

function RuleDescription({ rule, text, problem }: { rule: RuleDbRow; text: string; problem: RuleProblem | undefined }) {
  return (
    <div className="min-w-56 max-w-xl space-y-1 whitespace-normal">
      <p>
        {!rule.enabled ? (
          <Badge variant="outline" className="mr-1 align-middle">
            無効
          </Badge>
        ) : null}
        {text}
      </p>
      {problem ? (
        <div data-testid="rule-problem" className="space-y-0.5">
          <Badge variant="destructive">{problem.label}</Badge>
          <ul className="list-inside list-disc text-xs text-destructive">
            {problem.messages.map((m) => (
              <li key={m}>{m}</li>
            ))}
          </ul>
        </div>
      ) : null}
    </div>
  );
}

function EnabledSwitch({ rule, disabled, onChange }: { rule: RuleDbRow; disabled: boolean; onChange: (v: boolean) => void }) {
  return (
    <Switch
      checked={rule.enabled}
      onCheckedChange={onChange}
      disabled={disabled}
      aria-label={`${rule.code} を有効にする`}
    />
  );
}

/** 無効にする前の確認（理由をメモに残す。削除はしない） */
function DisableDialog({
  rule,
  onClose,
  onConfirm,
}: {
  rule: RuleDbRow;
  onClose: () => void;
  onConfirm: (memo: string | null) => Promise<void>;
}) {
  const [memo, setMemo] = useState(rule.memo ?? '');
  const id = useId();
  const parsed = memoSchema.safeParse(memo);
  return (
    <ConfirmDialog
      open
      onOpenChange={(o) => {
        if (!o) onClose();
      }}
      title={`ルール ${rule.code} を無効にしますか`}
      description="無効のルールは振り分けに使われません。削除はせず、次の年度にも無効のまま引き継がれます。使わなくなった理由をメモに残してください。"
      confirmLabel="無効にする"
      destructive
      confirmDisabled={!parsed.success}
      onConfirm={() => onConfirm(parsed.success ? parsed.data : null)}
    >
      <div className="space-y-1.5">
        <Label htmlFor={id}>メモ</Label>
        <Textarea id={id} value={memo} onChange={(e) => setMemo(e.target.value)} rows={3} />
        {!parsed.success ? <p className="text-sm text-destructive">メモは {NOTE_MAX} 字までです</p> : null}
      </div>
    </ConfirmDialog>
  );
}
