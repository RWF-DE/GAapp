'use client';

// 未保存の変更のバーと知らせ（画面の設計 3.9。T13 の段 2）。
// 画面の下に「未保存の変更 N 件［取り消す］［保存…］」。保存は ReasonDialog（理由が必須。よく使う理由のボタンつき）。
// 知らせ：保存されていない（もう一度保存）・確かめられない（「確かめる」まで保存を押せない）・一部だけ反映済みに見える（選ぶ）・
// ほかの人の変更とぶつかったので外した変更の一覧・拒まれた（ErrorBanner）。
import type { StoredAllocationRow } from '@gaapp/shared';
import { AlertTriangle, ChevronDown, ChevronUp, Info } from 'lucide-react';
import { useMemo, useState } from 'react';
import { ConfirmDialog } from '@/components/common/confirm-dialog';
import { ErrorBanner } from '@/components/common/error-banner';
import { ReasonDialog } from '@/components/common/reason-dialog';
import { Button } from '@/components/ui/button';
import { changeRowId, pendingSummary, type DroppedChange, type PendingChange } from '@/lib/allocation/pending';
import { describeChange } from '@/lib/allocation/pending-text';
import type { ViewModel } from '@/lib/allocation/view-model';
import { namesOf } from '@/lib/allocation/view-model';
import { classifyError, messageFor } from '@/lib/errors';
import { cn } from '@/lib/utils';
import type { PendingApi } from './use-pending';

export const REASON_PRESETS = ['団体の希望', '在庫の数え直し', '固定', '運び元の調整'] as const;

function Notice({ tone, testId, children }: { tone: 'warn' | 'info'; testId: string; children: React.ReactNode }) {
  const Icon = tone === 'warn' ? AlertTriangle : Info;
  return (
    <div
      role="status"
      data-testid={testId}
      className={cn(
        'flex gap-2 rounded-md border px-4 py-2 text-sm',
        tone === 'warn' ? 'border-amber-300 bg-amber-50 text-amber-950' : 'bg-muted/50',
      )}
    >
      <Icon aria-hidden className="mt-0.5 size-4 shrink-0" />
      <div className="min-w-0 flex-1 space-y-1">{children}</div>
    </div>
  );
}

function ChangeList({ changes, vm, rowsById }: { changes: readonly PendingChange[]; vm: ViewModel; rowsById: ReadonlyMap<string, StoredAllocationRow> }) {
  return (
    <ul className="list-inside list-disc space-y-0.5">
      {changes.map((c) => (
        <li key={changeRowId(c)}>{describeChange(vm, c, rowsById)}</li>
      ))}
    </ul>
  );
}

/** 保存の後・読み直しの後の知らせ */
export function PendingNotices({ api, vm, onReload }: { api: PendingApi; vm: ViewModel; onReload: () => void }) {
  const rowsById = useMemo(() => new Map(api.stored.rows.map((r) => [r.id, r])), [api.stored]);
  const n = api.notice;
  return (
    <>
      {api.dropped.length > 0 ? <DroppedNotice dropped={api.dropped} vm={vm} rowsById={rowsById} onDismiss={api.dismissDropped} /> : null}
      {n?.kind === 'not-saved' ? (
        <Notice tone="warn" testId="rows-not-saved">
          <p>保存されていません（応答が届く前に通信が切れました。版を読み直して確かめました）。もう一度「保存」を押してください。</p>
        </Notice>
      ) : null}
      {n?.kind === 'other-change' ? (
        <Notice tone="warn" testId="rows-other-change">
          <p>保存されていませんでした。その間にほかの人が振り分けを変えたので、読み直して変更を当て直しました。確かめてから、もう一度保存してください。</p>
        </Notice>
      ) : null}
      {n?.kind === 'unverified' ? (
        <Notice tone="warn" testId="rows-unverified">
          <p>保存できたか確かめられません。通信が戻ったら「確かめる」を押してください（確かめるまで、もう一度保存できません）。</p>
          <Button size="sm" variant="outline" disabled={api.saving} onClick={() => void api.recheck()}>
            {api.saving ? '確かめています…' : '確かめる'}
          </Button>
        </Notice>
      ) : null}
      {n?.kind === 'partial' ? (
        <Notice tone="warn" testId="rows-partial">
          <p>一部の変更だけが保存されているように見えます（決めきれません）。読み直した振り分けを確かめて、残りをどうするか選んでください。</p>
          <p className="font-medium">反映済みに見える変更</p>
          <ChangeList changes={n.applied} vm={vm} rowsById={rowsById} />
          <p className="font-medium">残っている変更（未保存の変更に残しています）</p>
          <ChangeList changes={n.remaining} vm={vm} rowsById={rowsById} />
          <div className="flex flex-wrap gap-2">
            <Button size="sm" onClick={() => api.resolvePartial(true)}>
              残りを残す
            </Button>
            <Button size="sm" variant="outline" onClick={() => api.resolvePartial(false)}>
              残りも取り消す
            </Button>
          </div>
        </Notice>
      ) : null}
      {n?.kind === 'rejected' && classifyError(n.error).kind !== 'reason' ? (
        <ErrorBanner error={n.error} context={{ rpc: 'save_allocation_rows', names: namesOf(vm) }} onReload={onReload} />
      ) : null}
    </>
  );
}

function DroppedNotice({
  dropped,
  vm,
  rowsById,
  onDismiss,
}: {
  dropped: readonly DroppedChange[];
  vm: ViewModel;
  rowsById: ReadonlyMap<string, StoredAllocationRow>;
  onDismiss: () => void;
}) {
  return (
    <Notice tone="warn" testId="rows-dropped">
      <p className="font-medium">次の変更は、ほかの人の変更とぶつかったので外しました（他の人が変更しました。読み直した値を確かめてください）。</p>
      <ul className="list-inside list-disc space-y-0.5">
        {dropped.map((d, k) => (
          <li key={k}>
            {describeChange(vm, d.change, rowsById)}
            {d.reason === 'gone' ? '（行が消えていました）' : '（行がほかの人に変えられていました）'}
          </li>
        ))}
      </ul>
      <Button size="sm" variant="outline" onClick={onDismiss}>
        閉じる
      </Button>
    </Notice>
  );
}

/** 画面の下の「未保存の変更 N 件［取り消す］［保存…］」 */
export function PendingBar({ api, vm }: { api: PendingApi; vm: ViewModel }) {
  const [open, setOpen] = useState(false);
  const [reasonOpen, setReasonOpen] = useState(false);
  const [discardOpen, setDiscardOpen] = useState(false);
  const rowsById = useMemo(() => new Map(api.stored.rows.map((r) => [r.id, r])), [api.stored]);
  const [reasonError, setReasonError] = useState<string | null>(null);
  if (api.pending.length === 0) return null;
  const s = pendingSummary(api.pending);
  return (
    <div
      className="sticky bottom-0 z-30 mt-4 rounded-t-md border border-sky-300 bg-sky-50 px-4 py-2 text-sm shadow-md print:hidden"
      data-testid="pending-bar"
      data-count={api.pending.length}
    >
      <div className="flex flex-wrap items-center gap-2">
        <button type="button" className="inline-flex items-center gap-1 font-medium" aria-expanded={open} onClick={() => setOpen((o) => !o)}>
          {open ? <ChevronDown aria-hidden className="size-4" /> : <ChevronUp aria-hidden className="size-4" />}
          未保存の変更 {api.pending.length} 件
        </button>
        <span className="text-muted-foreground">
          （追加 {s.inserts}・変更 {s.updates}・削除 {s.deletes}）
        </span>
        {api.saveBlock ? <span className="text-amber-800">{api.saveBlock}</span> : null}
        <div className="ml-auto flex gap-2">
          <Button size="sm" variant="outline" disabled={api.saving} onClick={() => setDiscardOpen(true)}>
            取り消す
          </Button>
          <Button
            size="sm"
            disabled={api.saving || api.saveBlock !== null}
            onClick={() => {
              setReasonError(null);
              setReasonOpen(true);
            }}
          >
            {api.saving ? '保存中…' : '保存…'}
          </Button>
        </div>
      </div>
      {open ? (
        <ul className="mt-2 max-h-48 space-y-1 overflow-auto" data-testid="pending-list">
          {api.pending.map((c) => (
            <li key={changeRowId(c)} className="flex items-center gap-2">
              <span className="min-w-0 flex-1">{describeChange(vm, c, rowsById)}</span>
              <Button size="xs" variant="ghost" onClick={() => api.revert(changeRowId(c))}>
                元に戻す
              </Button>
            </li>
          ))}
        </ul>
      ) : null}
      <ReasonDialog
        open={reasonOpen}
        onOpenChange={setReasonOpen}
        title={`振り分けの変更 ${api.pending.length} 件を保存する`}
        description="理由は履歴に残ります。"
        presets={REASON_PRESETS}
        pending={api.saving}
        error={reasonError}
        onSubmit={async (reason) => {
          try {
            await api.save(reason ?? '');
          } catch (e) {
            setReasonError(messageFor(classifyError(e)));
            throw e;
          }
        }}
      />
      <ConfirmDialog
        open={discardOpen}
        onOpenChange={setDiscardOpen}
        title="未保存の変更を取り消しますか"
        description={`未保存の変更 ${api.pending.length} 件をすべて取り消します（DB は変わりません）。`}
        destructive
        confirmLabel="取り消す"
        onConfirm={() => {
          api.discardAll();
          setDiscardOpen(false);
        }}
      />
    </div>
  );
}
