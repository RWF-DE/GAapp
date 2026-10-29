'use client';

// 団体・場所の削除の確認に出す「参照しているルール」（画面の設計 2.7・3.2。T09）。
import { useQuery } from '@tanstack/react-query';
import { AppLink } from '@/components/common/app-link';
import { ConfirmDialog } from '@/components/common/confirm-dialog';
import { fetchRules, rulesReferencing, type RuleRefs } from '@/lib/data/settings';
import { settingsKeys, useSettings } from './shared';

/** 参照している有効なルールがあれば削除を押せない理由と一覧、無効のルールは件数だけ */
export function RuleRefsNotice({ refs, what }: { refs: RuleRefs | null; what: '団体' | '場所' }) {
  if (refs === null) return <p className="text-sm text-muted-foreground">ルールの参照を確かめています…</p>;
  if (refs.enabled.length === 0 && refs.disabled.length === 0) return null;
  return (
    <div className="space-y-2 text-sm" data-testid="rule-refs">
      {refs.enabled.length > 0 ? (
        <div className="rounded-md border border-destructive/40 bg-destructive/5 p-3">
          <p className="font-medium text-destructive">
            この{what}を参照している有効なルールがあるので、削除できません。先にルール画面でこのルールを無効にするか、参照を直してください。
          </p>
          <ul className="mt-2 list-inside list-disc">
            {refs.enabled.map((r) => (
              <li key={r.id}>
                <AppLink href={`/rules?code=${encodeURIComponent(r.code)}`} className="font-mono underline">
                  {r.code}
                </AppLink>{' '}
                {r.summary}
              </li>
            ))}
          </ul>
        </div>
      ) : null}
      {refs.disabled.length > 0 ? (
        <p className="text-muted-foreground">
          無効のルール {refs.disabled.length} 件（{refs.disabled.map((r) => r.code).join('、')}）の参照が切れます（有効にする前に直してください）。
        </p>
      ) : null}
    </div>
  );
}

/**
 * 団体・場所の削除の確認（3.2）。開いている年度のルールを読み、参照している有効なルールがあれば削除を押せなくする。
 * 「削除しました」は onConfirm（deleteChecked）が行を返したときだけ呼ぶ側が出す。
 */
export function DeleteWithRefsDialog({
  open,
  onOpenChange,
  title,
  description,
  target,
  what,
  onConfirm,
}: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  title: string;
  description: React.ReactNode;
  target: { groupId: string } | { roomId: string };
  what: '団体' | '場所';
  onConfirm: () => Promise<void>;
}) {
  const { year } = useSettings();
  const rulesQ = useQuery({
    queryKey: settingsKeys.rules(year.id),
    queryFn: () => fetchRules(year.id),
    enabled: open,
    staleTime: 0,
  });
  // 読み直している間は前の結果で判断しない（開いた時点のルールで確かめる）
  const refs = rulesQ.data && !rulesQ.isFetching ? rulesReferencing(rulesQ.data, target) : null;
  return (
    <ConfirmDialog
      open={open}
      onOpenChange={onOpenChange}
      title={title}
      description={description}
      destructive
      confirmLabel="削除する"
      pendingLabel="削除中…"
      confirmDisabled={refs === null || refs.enabled.length > 0}
      onConfirm={onConfirm}
    >
      {rulesQ.isError ? (
        <p className="text-sm text-destructive">ルールを読めませんでした。閉じてからもう一度開いてください。</p>
      ) : (
        <RuleRefsNotice refs={refs} what={what} />
      )}
    </ConfirmDialog>
  );
}
