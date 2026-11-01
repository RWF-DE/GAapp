'use client';

// 備品の表（04「備品と割り当て」の備品の表・登録・編集・削除・前年度から読み込む、notes/T21.md「画面の約束」4・9。T21・D-57）。
// - 列は総務：名前・単位・在庫・申請できる区分・申請合計・割り当て合計・残り、閲覧のみ：名前・単位・在庫・割り当て合計。
//   割り当て合計 > 在庫は「在庫を超えています（確定できません）」、そうでなく申請合計 > 在庫は「申請が在庫を超えています」（注意の色）。
// - 登録・編集・削除と前年度から読み込むは部門長以上（終了した年度を除く）。削除は確かめてから updated_at を条件に入れて delete
//   （(B1)。23503 は「申請・割り当て・記録のある備品は削除できません」）。前年度から読み込むは、その年度に備品が1つもないときだけ
//   （previous_year_lending_items の一覧を確かめのダイアログで見せてから、画面が作った id で1回の insert）。
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { Pencil, Plus, Trash2, Download } from 'lucide-react';
import { useState } from 'react';
import { toast } from 'sonner';
import { ConfirmDialog } from '@/components/common/confirm-dialog';
import { EmptyState } from '@/components/states';
import { Button } from '@/components/ui/button';
import { useAuthErrorHandler } from '@/lib/auth/guarded';
import {
  deleteLendingItem,
  fetchLendingBoard,
  insertLendingItems,
  invalidateLending,
  lendingBoardOptions,
  newLendingId,
  previousYearLendingItemsOptions,
  readLendingItem,
  runLendingItemDelete,
  type LendingBoardData,
  type LendingItemRow,
  type PreviousLendingItem,
} from '@/lib/data/lending';
import { classifyError, effectOf, isUnknownOutcome, messageFor, unknownOutcomeMessage } from '@/lib/errors';
import { CATEGORY_LABELS } from '@/lib/labels';
import { sortLendingItems, type LendingItemTotal } from '@/lib/modules/lending/counts';
import { cn } from '@/lib/utils';
import { LendingItemDialog, type LendingItemTarget } from './item-dialog';

/** 印の文（04「備品と割り当て」） */
export const OVER_ASSIGNED_TEXT = '在庫を超えています（確定できません）';
export const OVER_REQUESTED_TEXT = '申請が在庫を超えています';
export const NO_ITEMS_TEXT = '貸し出す備品がまだありません';

/** 行の印：assigned（割り当て合計 > 在庫）・requested（申請合計 > 在庫で、割り当ては超えていない）・none */
export function overOf(t: LendingItemTotal | undefined, soumu: boolean): 'assigned' | 'requested' | 'none' {
  if (!t) return 'none';
  if (t.assigned > t.stock) return 'assigned';
  return soumu && t.requested > t.stock ? 'requested' : 'none';
}

const categoriesText = (cs: readonly string[]) => (cs.length === 0 ? '（申請させない）' : cs.map((c) => CATEGORY_LABELS[c as keyof typeof CATEGORY_LABELS] ?? c).join('・'));

export interface ItemsTableProps {
  data: LendingBoardData;
  totals: readonly LendingItemTotal[];
  /** 総務の列（申請できる区分・申請合計・残り）を出すか。偽なら閲覧のみの列 */
  soumu: boolean;
  /** 登録・編集・削除・前年度から読み込むを出すか（部門長以上で終了でない年度） */
  canEdit: boolean;
  yearId: string;
  userId: string | null;
  onReload: () => void;
  onReloadMembership: () => void;
}

export function ItemsTable({ data, totals, soumu, canEdit, yearId, userId, onReload, onReloadMembership }: ItemsTableProps) {
  const queryClient = useQueryClient();
  const onAuthError = useAuthErrorHandler();
  const [form, setForm] = useState<LendingItemTarget | null>(null);
  const [deleting, setDeleting] = useState<LendingItemRow | null>(null);
  const [deleteError, setDeleteError] = useState<string | null>(null);
  const [importOpen, setImportOpen] = useState(false);
  const empty = data.items.length === 0;
  const prevQ = useQuery({ ...previousYearLendingItemsOptions(yearId), enabled: canEdit && empty });
  const byId = new Map(totals.map((t) => [t.itemId, t]));
  const nextSortOrder = data.items.reduce((m, i) => Math.max(m, i.sort_order), 0) + 1;

  const boardKey = lendingBoardOptions(yearId, true).queryKey;
  const putItem = (row: LendingItemRow) =>
    queryClient.setQueryData<LendingBoardData>(boardKey, (old) => (old ? { ...old, items: sortLendingItems([...old.items.filter((i) => i.id !== row.id), row]) } : old));
  const dropItem = (id: string) => queryClient.setQueryData<LendingBoardData>(boardKey, (old) => (old ? { ...old, items: old.items.filter((i) => i.id !== id) } : old));

  const handleFailure = (error: unknown) => {
    const c = classifyError(error);
    const effect = effectOf(c);
    if (effect.reload === 'year') {
      onReloadMembership();
      onReload();
    } else if (effect.reload === 'data') onReload();
    toast.error(messageFor(c, { table: 'lending_items' }));
  };

  const confirmDelete = async () => {
    const it = deleting;
    if (!it) return;
    const afterUnknown = deleteError !== null;
    setDeleteError(null);
    const r = await runLendingItemDelete({ send: () => deleteLendingItem(it), reread: () => readLendingItem(it.id), baseVersion: it.updated_at }, onAuthError);
    switch (r.type) {
      case 'deleted':
        dropItem(it.id);
        invalidateLending(queryClient, yearId);
        if (r.before && afterUnknown) toast.success(`「${it.name}」は削除されていました`);
        else if (r.before) toast.info('すでに削除されていました（ほかの人が削除した可能性があります）');
        else toast.success(`「${it.name}」を削除しました`);
        return;
      case 'changed':
        onReload();
        toast.error('ほかの人がこの備品を先に変えました。読み直しました。内容を確かめてから、もう一度削除してください');
        return;
      case 'unknown':
        setDeleteError(unknownOutcomeMessage('削除'));
        throw new Error('keep-open');
      case 'failed':
        handleFailure(r.error);
        return;
    }
  };

  return (
    <section aria-labelledby="lending-items-heading" className="space-y-3">
      <div className="flex flex-wrap items-center gap-2">
        <h2 id="lending-items-heading" className="text-lg font-semibold">
          貸し出す備品
        </h2>
        {canEdit && userId ? (
          <div className="ml-auto flex flex-wrap gap-2 print:hidden">
            {empty ? (
              <Button
                variant="outline"
                data-testid="lending-item-import"
                onClick={() => setImportOpen(true)}
                disabled={!prevQ.data || prevQ.data.length === 0}
                title={prevQ.data && prevQ.data.length === 0 ? '前年度に備品がありません' : undefined}
              >
                <Download aria-hidden />
                前年度から読み込む
              </Button>
            ) : null}
            <Button data-testid="lending-item-add" onClick={() => setForm({ type: 'new', nextSortOrder })}>
              <Plus aria-hidden />
              備品を登録
            </Button>
          </div>
        ) : null}
      </div>
      {empty ? (
        <div data-testid="lending-items-empty">
          <EmptyState
            title={NO_ITEMS_TEXT}
            description={
              canEdit
                ? prevQ.data && prevQ.data.length === 0
                  ? '「備品を登録」で足してください（前年度に備品がありません）。'
                  : '「備品を登録」か「前年度から読み込む」で足してください。'
                : undefined
            }
          />
        </div>
      ) : (
        <div className="overflow-x-auto rounded-lg border">
          <table data-testid="lending-items" className="w-full text-sm">
            <thead className="bg-muted/50 text-left text-xs text-muted-foreground">
              <tr>
                <th className="px-3 py-2 font-medium">名前</th>
                <th className="px-3 py-2 font-medium">単位</th>
                <th className="px-3 py-2 text-right font-medium">在庫</th>
                {soumu ? <th className="px-3 py-2 font-medium">申請できる区分</th> : null}
                {soumu ? <th className="px-3 py-2 text-right font-medium">申請合計</th> : null}
                <th className="px-3 py-2 text-right font-medium">割り当て合計</th>
                {soumu ? <th className="px-3 py-2 text-right font-medium">残り</th> : null}
                {canEdit ? <th className="px-3 py-2 font-medium print:hidden">操作</th> : null}
              </tr>
            </thead>
            <tbody>
              {data.items.map((it) => {
                const t = byId.get(it.id);
                const over = overOf(t, soumu);
                return (
                  <tr key={it.id} data-testid="lending-item-row" data-id={it.id} data-over={over} className="border-t align-top">
                    <td className="px-3 py-2">
                      <span className="font-medium [overflow-wrap:anywhere]">{it.name}</span>
                      {over !== 'none' ? (
                        <p data-testid="lending-item-over" className="text-xs font-medium text-destructive">
                          {over === 'assigned' ? OVER_ASSIGNED_TEXT : OVER_REQUESTED_TEXT}
                        </p>
                      ) : null}
                    </td>
                    <td className="px-3 py-2">{it.unit}</td>
                    <td className="px-3 py-2 text-right tabular-nums">{it.stock}</td>
                    {soumu ? <td className="px-3 py-2 text-xs">{categoriesText(it.requestable_categories)}</td> : null}
                    {soumu ? <td className={cn('px-3 py-2 text-right tabular-nums', (t?.requested ?? 0) > it.stock && 'text-destructive')}>{t?.requested ?? 0}</td> : null}
                    <td className={cn('px-3 py-2 text-right tabular-nums', over === 'assigned' && 'font-semibold text-destructive')}>{t?.assigned ?? 0}</td>
                    {soumu ? <td className={cn('px-3 py-2 text-right tabular-nums', (t?.remaining ?? 0) < 0 && 'text-destructive')}>{t?.remaining ?? it.stock}</td> : null}
                    {canEdit ? (
                      <td className="px-3 py-2 print:hidden">
                        <div className="flex gap-1">
                          <Button size="sm" variant="outline" data-testid="lending-item-edit" onClick={() => setForm({ type: 'edit', item: it })}>
                            <Pencil aria-hidden />
                            編集
                          </Button>
                          <Button
                            size="sm"
                            variant="outline"
                            data-testid="lending-item-delete"
                            onClick={() => {
                              setDeleteError(null);
                              setDeleting(it);
                            }}
                          >
                            <Trash2 aria-hidden />
                            削除
                          </Button>
                        </div>
                      </td>
                    ) : null}
                  </tr>
                );
              })}
            </tbody>
          </table>
        </div>
      )}
      {userId ? (
        <LendingItemDialog
          target={form}
          onClose={() => setForm(null)}
          yearId={yearId}
          userId={userId}
          writable={canEdit}
          onSaved={putItem}
          onReload={onReload}
          onReloadMembership={onReloadMembership}
        />
      ) : null}
      <ConfirmDialog
        open={deleting !== null}
        onOpenChange={(open) => {
          if (!open) {
            setDeleting(null);
            setDeleteError(null);
          }
        }}
        title={deleting ? `「${deleting.name}」を削除しますか` : ''}
        description="申請・割り当て・記録のある備品は削除できません。元に戻せません。"
        confirmLabel="削除する"
        pendingLabel="削除しています…"
        destructive
        onConfirm={confirmDelete}
      >
        {deleteError ? (
          <p role="alert" data-testid="lending-item-delete-error" className="rounded-md border border-destructive/40 bg-destructive/5 px-3 py-2 text-sm text-destructive">
            {deleteError}
          </p>
        ) : null}
      </ConfirmDialog>
      {importOpen && prevQ.data ? (
        <ImportDialog
          items={prevQ.data}
          yearId={yearId}
          onClose={() => setImportOpen(false)}
          onDone={(rows) => {
            queryClient.setQueryData<LendingBoardData>(boardKey, (old) => (old ? { ...old, items: sortLendingItems(rows) } : old));
            invalidateLending(queryClient, yearId);
          }}
          onFailure={handleFailure}
        />
      ) : null}
    </section>
  );
}

/**
 * 前年度から読み込む（確かめのダイアログで一覧を見せてから、画面が作った id で1回の insert）。応答が届かなかった・23505 で止められた
 * ときは備品を読み直し、作った id の行が全部あれば「読み込まれていました」。23505 で行がなければ同じ名前の備品がある
 */
function ImportDialog({
  items,
  yearId,
  onClose,
  onDone,
  onFailure,
}: {
  items: readonly PreviousLendingItem[];
  yearId: string;
  onClose: () => void;
  onDone: (rows: LendingItemRow[]) => void;
  onFailure: (e: unknown) => void;
}) {
  const [ids] = useState(() => items.map(() => newLendingId()));
  const [error, setError] = useState<string | null>(null);
  const run = async () => {
    setError(null);
    try {
      const rows = await insertLendingItems(
        yearId,
        items.map((p, k) => ({ ...p, id: ids[k]! })),
      );
      onDone(rows);
      toast.success(`前年度から ${rows.length} 件を読み込みました。在庫を確かめて直してください`);
    } catch (e) {
      const c = classifyError(e);
      if (!isUnknownOutcome(e) && c.kind !== 'conflict') {
        onFailure(e);
        return;
      }
      let fresh: LendingBoardData | null = null;
      try {
        fresh = await fetchLendingBoard(yearId, true);
      } catch {
        // 読み直せない：分からないまま（もう一度押すと同じ id で送る）
      }
      if (fresh && ids.every((id) => fresh.items.some((i) => i.id === id))) {
        onDone(fresh.items);
        toast.success('前年度の備品は読み込まれていました');
        return;
      }
      setError(isUnknownOutcome(e) || !fresh ? unknownOutcomeMessage('読み込み') : messageFor(c, { table: 'lending_items' }));
      throw new Error('keep-open', { cause: e });
    }
  };
  return (
    <ConfirmDialog
      open
      onOpenChange={(open) => {
        if (!open) onClose();
      }}
      title="前年度の備品を読み込みますか"
      description="在庫は前年度の数のまま入ります。読み込んだ後に確かめて直してください。"
      confirmLabel="読み込む"
      pendingLabel="読み込んでいます…"
      onConfirm={run}
    >
      <div data-testid="lending-import-dialog" className="max-h-64 overflow-auto">
        <table className="w-full text-sm">
          <thead className="text-left text-xs text-muted-foreground">
            <tr>
              <th className="py-1 font-normal">名前</th>
              <th className="py-1 font-normal">単位</th>
              <th className="py-1 text-right font-normal">在庫</th>
              <th className="py-1 pl-3 font-normal">申請できる区分</th>
            </tr>
          </thead>
          <tbody>
            {items.map((p) => (
              <tr key={p.name} className="border-t">
                <td className="py-1">{p.name}</td>
                <td className="py-1">{p.unit}</td>
                <td className="py-1 text-right tabular-nums">{p.stock}</td>
                <td className="py-1 pl-3 text-xs">{categoriesText(p.requestable_categories)}</td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
      {error ? (
        <p role="alert" data-testid="lending-import-error" className="rounded-md border border-destructive/40 bg-destructive/5 px-3 py-2 text-sm text-destructive">
          {error}
        </p>
      ) : null}
    </ConfirmDialog>
  );
}
