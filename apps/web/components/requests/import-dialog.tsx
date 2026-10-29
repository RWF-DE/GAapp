'use client';

import { useId, useMemo, useState } from 'react';
import { toast } from 'sonner';
import { AppLink } from '@/components/common/app-link';
import { EntitySelect } from '@/components/common/entity-select';
import { reasonError } from '@/components/common/reason-dialog';
import { Button } from '@/components/ui/button';
import { Checkbox } from '@/components/ui/checkbox';
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from '@/components/ui/dialog';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { Textarea } from '@/components/ui/textarea';
import { CsvEncodingError, readCsvFile } from '@/lib/csv-file';
import { formatDateTime } from '@/lib/datetime';
import {
  buildImportPreview,
  defaultImportReason,
  groupsForKind,
  IMPORT_KINDS,
  KIND_LABELS,
  readForm,
  REJECT_LABELS,
  saveImport,
  type FormKind,
  type ImportPlan,
  type ImportPreview,
  type RejectReason,
} from '@/lib/data/import';
import type { RequestsTables } from '@/lib/data/requests';
import type { ParsedForm } from '@gaapp/importer';
import { cn } from '@/lib/utils';

/** 失敗の文言（呼ぶ側が読み直し・権限の扱いをして文言を返す） */
export type ImportErrorHandler = (e: unknown, groupId: string) => Promise<string>;

/**
 * 「Googleフォームの回答を取り込む」のダイアログ（申請一覧から。admin。画面の設計 5 章。T11）。
 * 種類とファイルを選ぶ → 読み取り（parseFormCsv）→ その種類の区分の団体に対応（resolveResponses）→ プレビュー → 理由を確かめて
 * 団体ごとに update_requests_after_deadline（p_submission にフォームのタイムスタンプ）。
 * ファイルの中身と結果はこの部品の状態にだけ持つ。閉じると部品が外れて消える（ログにも出さず、どこにも保存しない）。
 */
export function ImportDialog({
  open,
  onOpenChange,
  tables,
  onImported,
  onError,
}: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  tables: RequestsTables;
  /** 1団体でも保存したら呼ぶ（申請一覧を読み直す） */
  onImported: () => void | Promise<void>;
  onError: ImportErrorHandler;
}) {
  const [busy, setBusy] = useState(false);
  return (
    <Dialog open={open} onOpenChange={(o) => (busy ? undefined : onOpenChange(o))}>
      <DialogContent showCloseButton={!busy} className="max-h-[92vh] overflow-y-auto sm:max-w-6xl" data-testid="import-dialog">
        {open ? (
          <ImportForm tables={tables} onClose={() => onOpenChange(false)} onImported={onImported} onError={onError} setBusy={setBusy} />
        ) : null}
      </DialogContent>
    </Dialog>
  );
}

type Loaded = { fileName: string; text: string };
type Outcome = { plan: ImportPlan; ok: boolean; message: string };

function ImportForm({
  tables,
  onClose,
  onImported,
  onError,
  setBusy,
}: {
  tables: RequestsTables;
  onClose: () => void;
  onImported: () => void | Promise<void>;
  onError: ImportErrorHandler;
  setBusy: (b: boolean) => void;
}) {
  const id = useId();
  const [kind, setKind] = useState<FormKind>('stall');
  const [file, setFile] = useState<Loaded | null>(null);
  const [readError, setReadError] = useState<string | null>(null);
  const [manual, setManual] = useState<Record<number, string>>({});
  const [overwrite, setOverwrite] = useState<Record<string, boolean>>({});
  const [reason, setReason] = useState('');
  const [reasonTouched, setReasonTouched] = useState(false);
  const [saving, setSaving] = useState(false);
  const [outcomes, setOutcomes] = useState<Outcome[] | null>(null);
  const [notSent, setNotSent] = useState(0);

  const read = useMemo(() => (file ? readForm(kind, file.text, tables.items) : null), [file, kind, tables.items]);
  const parsed: ParsedForm | null = read?.ok ? read.parsed : null;
  const preview = useMemo(() => (parsed ? buildImportPreview(parsed, kind, tables, manual) : null), [parsed, kind, tables, manual]);
  const chosen = useMemo(
    () => (preview ? preview.plans.filter((p) => overwrite[p.group.id] ?? p.defaultOverwrite) : []),
    [preview, overwrite],
  );
  const reasonMessage = reasonError(reason, true);

  const reset = (next: Partial<{ kind: FormKind }> = {}) => {
    if (next.kind) setKind(next.kind);
    setManual({});
    setOverwrite({});
    setOutcomes(null);
  };

  const onFile = async (f: File | undefined) => {
    reset();
    setFile(null);
    setReadError(null);
    if (!f) return;
    try {
      const { text } = await readCsvFile(f);
      setFile({ fileName: f.name, text });
      setReason(defaultImportReason(kind, f.name));
      setReasonTouched(false);
    } catch (e) {
      setReadError(e instanceof CsvEncodingError ? e.message : 'ファイルを読めませんでした');
    }
  };

  const onSave = async () => {
    setReasonTouched(true);
    if (saving || chosen.length === 0 || reasonMessage) return;
    setSaving(true);
    setBusy(true);
    try {
      const results = await saveImport(chosen, reason.trim());
      const out: Outcome[] = [];
      for (const r of results) {
        const plan = chosen.find((p) => p.group.id === r.groupId)!;
        if (r.ok) out.push({ plan, ok: true, message: '取り込みました' });
        else if (r.error.info.kind === 'conflict') {
          out.push({ plan, ok: false, message: '取り込みの前に、ほかの人がこの団体の申請を変えました。読み直してからもう一度取り込んでください' });
        } else out.push({ plan, ok: false, message: await onError(r.error, r.groupId) });
      }
      setOutcomes(out);
      setNotSent(chosen.length - results.length);
      const okCount = out.filter((o) => o.ok).length;
      if (okCount > 0) await onImported();
      if (okCount === out.length && results.length === chosen.length) toast.success(`${okCount} 団体の申請を取り込みました`);
      else toast.error(`${okCount} 団体を取り込みました。${chosen.length - okCount} 団体は取り込めませんでした`);
    } finally {
      setSaving(false);
      setBusy(false);
    }
  };

  if (outcomes) {
    const okCount = outcomes.filter((o) => o.ok).length;
    return (
      <>
        <DialogHeader>
          <DialogTitle>取り込みの結果</DialogTitle>
          <DialogDescription>
            {okCount} 団体を取り込みました。{outcomes.length - okCount + notSent > 0 ? `${outcomes.length - okCount + notSent} 団体は取り込めませんでした。` : ''}
          </DialogDescription>
        </DialogHeader>
        <ul className="space-y-1 text-sm" data-testid="import-results">
          {outcomes.map((o) => (
            <li key={o.plan.group.id} className={cn(o.ok ? '' : 'text-destructive')}>
              {o.plan.group.name}：{o.message}
            </li>
          ))}
          {notSent > 0 ? <li className="text-muted-foreground">残りの {notSent} 団体は送っていません（権限か年度の状態が変わりました）</li> : null}
        </ul>
        <DialogFooter>
          <Button onClick={onClose}>閉じる</Button>
        </DialogFooter>
      </>
    );
  }

  return (
    <>
      <DialogHeader>
        <DialogTitle>Googleフォームの回答を取り込む</DialogTitle>
        <DialogDescription>
          フォームの回答の CSV を読み、団体ごとに申請と提出日時（フォームのタイムスタンプ）を上書きします。ファイルの中身は保存しません（閉じると消えます）。
        </DialogDescription>
      </DialogHeader>

      <div className="grid gap-3 sm:grid-cols-[auto_1fr] sm:items-center">
        <span className="text-sm font-medium" id={`${id}-kind`}>
          フォームの種類
        </span>
        <div className="flex flex-wrap gap-2" role="radiogroup" aria-labelledby={`${id}-kind`}>
          {IMPORT_KINDS.map((k) => (
            <Button
              key={k}
              type="button"
              size="sm"
              role="radio"
              aria-checked={kind === k}
              variant={kind === k ? 'default' : 'outline'}
              disabled={saving}
              onClick={() => {
                if (k === kind) return;
                reset({ kind: k });
                if (file) setReason(defaultImportReason(k, file.fileName));
              }}
            >
              {KIND_LABELS[k]}
            </Button>
          ))}
        </div>
        <Label htmlFor={`${id}-file`}>CSV ファイル</Label>
        <Input
          id={`${id}-file`}
          type="file"
          accept=".csv,text/csv"
          disabled={saving}
          onChange={(e) => void onFile(e.target.files?.[0])}
        />
      </div>

      {readError ? <ErrorText>{readError}</ErrorText> : null}
      {read && !read.ok ? <ErrorText>{read.message}</ErrorText> : null}

      {preview ? (
        <PreviewBody
          preview={preview}
          kind={kind}
          tables={tables}
          manual={manual}
          setManual={(m) => setManual(m)}
          overwrite={overwrite}
          setOverwrite={setOverwrite}
          disabled={saving}
        />
      ) : null}

      {preview ? (
        <div className="grid gap-2 border-t pt-3">
          <Label htmlFor={`${id}-reason`}>理由（必須。履歴に残ります）</Label>
          <Textarea
            id={`${id}-reason`}
            value={reason}
            disabled={saving}
            aria-invalid={reasonTouched && reasonMessage ? true : undefined}
            onChange={(e) => setReason(e.target.value)}
            onBlur={() => setReasonTouched(true)}
          />
          {reasonTouched && reasonMessage ? <ErrorText>{reasonMessage}</ErrorText> : null}
        </div>
      ) : null}

      <DialogFooter>
        <Button variant="outline" disabled={saving} onClick={onClose}>
          やめる
        </Button>
        <Button
          disabled={!preview || chosen.length === 0 || saving || (reasonTouched && !!reasonMessage)}
          aria-busy={saving || undefined}
          onClick={() => void onSave()}
        >
          {saving ? '取り込み中…' : `取り込む（${chosen.length} 団体）`}
        </Button>
      </DialogFooter>
    </>
  );
}

function ErrorText({ children }: { children: React.ReactNode }) {
  return (
    <p role="alert" className="text-sm text-destructive">
      {children}
    </p>
  );
}

function Section({ title, children, testId }: { title: string; children: React.ReactNode; testId?: string }) {
  return (
    <section className="space-y-2" data-testid={testId}>
      <h3 className="text-sm font-semibold">{title}</h3>
      {children}
    </section>
  );
}

function PreviewBody({
  preview,
  kind,
  tables,
  manual,
  setManual,
  overwrite,
  setOverwrite,
  disabled,
}: {
  preview: ImportPreview;
  kind: FormKind;
  tables: RequestsTables;
  manual: Record<number, string>;
  setManual: (m: Record<number, string>) => void;
  overwrite: Record<string, boolean>;
  setOverwrite: (o: Record<string, boolean>) => void;
  disabled: boolean;
}) {
  const options = useMemo(
    () => groupsForKind(tables.groups, kind).map((g) => ({ id: g.id, name: g.name, keywords: g.aliases })),
    [tables.groups, kind],
  );
  const rejectedText = (Object.entries(preview.rejectedByReason) as [RejectReason, number][])
    .map(([r, n]) => `${REJECT_LABELS[r]} ${n}`)
    .join('・');
  const rejectedTotal = preview.rejected.length;

  return (
    <div className="space-y-4">
      <p className="rounded-md border bg-muted/40 px-3 py-2 text-sm" data-testid="import-counts">
        回答 {preview.responseCount}・対応した {preview.matchedCount}・対応しない {preview.responseCount - preview.matchedCount}・取り込まない {rejectedTotal}
        {rejectedTotal > 0 ? `（${rejectedText}）` : ''}・古い回答 {preview.supersededCount}
        {preview.ignoredColumns.length > 0 ? (
          <span className="block text-xs text-muted-foreground">読まなかった列：{preview.ignoredColumns.join('、')}</span>
        ) : null}
      </p>

      {preview.unmatched.length > 0 ? (
        <Section title={`対応しない行（${preview.unmatched.length}）：団体を選ぶと取り込みます`} testId="import-unmatched">
          <div className="overflow-x-auto">
            <table className="w-full text-sm">
              <thead className="text-left text-xs text-muted-foreground">
                <tr>
                  <th className="py-1 pr-3 font-normal">行</th>
                  <th className="py-1 pr-3 font-normal">フォームの団体名</th>
                  <th className="py-1 pr-3 font-normal">タイムスタンプ</th>
                  <th className="py-1 pr-3 font-normal">数</th>
                  <th className="py-1 font-normal">団体</th>
                </tr>
              </thead>
              <tbody>
                {preview.unmatched.map((u) => (
                  <tr key={u.rowNumber} className="border-t align-middle" data-testid={`unmatched-row-${u.rowNumber}`}>
                    <td className="py-1 pr-3 tabular-nums">{u.rowNumber}</td>
                    <td className="py-1 pr-3">{u.groupName ?? <span className="text-muted-foreground">（なし）</span>}</td>
                    <td className="py-1 pr-3 tabular-nums">{formatDateTime(u.submittedAt)}</td>
                    <td className="py-1 pr-3">{u.summary}</td>
                    <td className="py-1">
                      <EntitySelect
                        label={`行${u.rowNumber}の団体`}
                        options={options}
                        value={manual[u.rowNumber] ?? null}
                        placeholder="取り込まない（団体を選ぶ）"
                        allowClear
                        disabled={disabled}
                        className="w-56"
                        onChange={(gid) => {
                          const next = { ...manual };
                          if (gid) next[u.rowNumber] = gid;
                          else delete next[u.rowNumber];
                          setManual(next);
                        }}
                      />
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
          <p className="text-xs text-muted-foreground">
            マスタにない団体は、先にマスタ設定で団体を作ってください（<AppLink href="/settings?tab=groups">マスタ設定へ</AppLink>）。
          </p>
        </Section>
      ) : null}

      {preview.superseded.length > 0 ? (
        <Section title="古い回答（同じ団体の回答が複数あります。一番新しい回答を使います）" testId="import-superseded">
          <ul className="space-y-1 text-sm">
            {preview.superseded.map((s) => (
              <li key={s.group.id}>
                {s.group.name}：行{s.kept.rowNumber}（{formatDateTime(s.kept.submittedAt)}）を使い、
                {s.dropped.map((d) => `行${d.rowNumber}（${formatDateTime(d.submittedAt)}）`).join('・')}は使いません
              </li>
            ))}
          </ul>
        </Section>
      ) : null}

      {preview.rejected.length > 0 ? (
        <Section title={`取り込まない行（${preview.rejected.length}）`} testId="import-rejected">
          <ul className="flex flex-wrap gap-x-4 gap-y-1 text-sm">
            {preview.rejected.map((r) => (
              <li key={r.rowNumber}>
                行{r.rowNumber}：{REJECT_LABELS[r.reason]}
              </li>
            ))}
          </ul>
        </Section>
      ) : null}

      <Section title={`団体ごとの結果（${preview.plans.length}）`} testId="import-plans">
        {preview.plans.length === 0 ? (
          <p className="text-sm text-muted-foreground">取り込む団体がありません（対応しない行は、上で団体を選んでください）</p>
        ) : (
          <PlansTable plans={preview.plans} overwrite={overwrite} setOverwrite={setOverwrite} disabled={disabled} />
        )}
      </Section>
    </div>
  );
}

function PlansTable({
  plans,
  overwrite,
  setOverwrite,
  disabled,
}: {
  plans: readonly ImportPlan[];
  overwrite: Record<string, boolean>;
  setOverwrite: (o: Record<string, boolean>) => void;
  disabled: boolean;
}) {
  // 列：どれかの団体で申請できる品目か、DB に数がある品目
  const columns = plans[0]!.cells
    .map((c, i) => ({ item: c.item, index: i }))
    .filter(({ index }) => plans.some((p) => p.cells[index]!.requestable || p.cells[index]!.db > 0));
  return (
    <div className="overflow-x-auto">
      <table className="w-full text-sm">
        <thead className="text-left text-xs text-muted-foreground">
          <tr>
            <th className="py-1 pr-2 font-normal">上書き</th>
            <th className="py-1 pr-3 font-normal">団体</th>
            <th className="py-1 pr-3 font-normal">フォームのタイムスタンプ</th>
            <th className="py-1 pr-3 font-normal">今の提出日時</th>
            {columns.map((c) => (
              <th key={c.item.id} className="px-1 py-1 text-right font-normal">
                {c.item.name}
              </th>
            ))}
            <th className="py-1 pl-3 font-normal">備考・印</th>
          </tr>
        </thead>
        <tbody>
          {plans.map((p) => {
            const checked = overwrite[p.group.id] ?? p.defaultOverwrite;
            return (
              <tr key={p.group.id} className={cn('border-t align-top', !checked && 'text-muted-foreground')} data-testid={`plan-${p.group.name}`}>
                <td className="py-1 pr-2">
                  <Checkbox
                    aria-label={`${p.group.name}を上書きする`}
                    checked={checked}
                    disabled={disabled}
                    onCheckedChange={(v) => setOverwrite({ ...overwrite, [p.group.id]: v === true })}
                  />
                </td>
                <td className="py-1 pr-3 font-medium">{p.group.name}</td>
                <td className="py-1 pr-3 tabular-nums">
                  {formatDateTime(p.submittedAt)}
                  <span className="block text-xs text-muted-foreground">行{p.rowNumber}</span>
                </td>
                <td className="py-1 pr-3 tabular-nums">
                  {p.dbSubmittedAt ? formatDateTime(p.dbSubmittedAt) : '未提出'}
                  {!p.defaultOverwrite ? <span className="block text-xs text-amber-700">アプリの提出の方が新しい</span> : null}
                </td>
                {columns.map(({ item, index }) => {
                  const c = p.cells[index]!;
                  const diff = (c.requestable || c.db > 0) && c.csv !== c.db && !p.blocked.some((b) => b.item.id === item.id);
                  return (
                    <td
                      key={item.id}
                      className={cn('px-1 py-1 text-right tabular-nums', diff && 'bg-amber-100 font-medium dark:bg-amber-900/40')}
                      title={diff ? `今の数 ${c.db} → ${c.csv}` : undefined}
                    >
                      {c.requestable ? c.csv : c.db > 0 ? 0 : '—'}
                      {diff ? <span className="block text-xs font-normal text-muted-foreground">今 {c.db}</span> : null}
                    </td>
                  );
                })}
                <td className="py-1 pl-3 text-xs">
                  <ul className="space-y-0.5">
                    {p.note ? <li>備考あり{p.dbHasNote ? '（今の備考を置き換えます）' : ''}</li> : p.dbHasNote ? <li>今の備考を消します</li> : null}
                    {p.rewritten ? <li>長机(3人掛)を長机(2人掛)に読み替えました</li> : null}
                    {p.blocked.map((b) => (
                      <li key={b.item.id} className="text-destructive">
                        {b.item.name} {b.count}：申請できない品目のため取り込みません
                      </li>
                    ))}
                    {!p.changed ? <li className="text-muted-foreground">数は今と同じ</li> : null}
                  </ul>
                </td>
              </tr>
            );
          })}
        </tbody>
      </table>
    </div>
  );
}
