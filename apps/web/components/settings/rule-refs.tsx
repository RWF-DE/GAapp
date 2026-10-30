'use client';

// 団体・場所の削除の確認に出す「参照しているルール」（画面の設計 2.7・3.2。T09）。
import { useQuery } from '@tanstack/react-query';
import { AppLink } from '@/components/common/app-link';
import { ConfirmDialog } from '@/components/common/confirm-dialog';
import { useAuth } from '@/lib/auth/auth-provider';
import { fetchOpenYearRules, fetchRules, freshDataOf, roomRefsAcrossYears, rulesReferencing, type RoomRuleRefs, type RuleRefs } from '@/lib/data/settings';
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
 * 場所の削除の確認に出す参照（場所は全年度で共有なので、終了していない年度のうち読める年度のルールをすべて見る）。
 * 表示中の年度のルールはルール画面へのリンク、ほかの年度はコードと年度名だけ（その年度を開いて直す）。
 * ルールを読めない年度（団体代表・閲覧のみの年度）があれば、削除できない理由として知らせる（削除は呼ぶ側で押せなくする）。
 */
export function RoomRuleRefsNotice({ refs, currentYearId }: { refs: RoomRuleRefs | null; currentYearId: string }) {
  if (refs === null) return <p className="text-sm text-muted-foreground">ルールの参照を確かめています…</p>;
  const disabled = refs.byYear.filter((y) => y.refs.disabled.length > 0);
  return (
    <div className="space-y-2 text-sm">
      {refs.byYear.length > 0 ? (
        <div className="space-y-2" data-testid="rule-refs">
          {refs.enabledCount > 0 ? (
            <div className="rounded-md border border-destructive/40 bg-destructive/5 p-3">
              <p className="font-medium text-destructive">
                この場所を参照している有効なルールがあるので、削除できません（場所はすべての年度で共有なので、終了していない年度のルールを確かめています）。先にその年度のルール画面で、ルールを無効にするか参照を直してください。
              </p>
              <ul className="mt-2 list-inside list-disc">
                {refs.byYear.flatMap(({ year, refs: r }) =>
                  r.enabled.map((ref) => (
                    <li key={ref.id}>
                      {year.id === currentYearId ? (
                        <AppLink href={`/rules?code=${encodeURIComponent(ref.code)}`} className="font-mono underline">
                          {ref.code}
                        </AppLink>
                      ) : (
                        <span className="font-mono">{ref.code}</span>
                      )}{' '}
                      {ref.summary}
                      <span className="text-muted-foreground">
                        （{year.label}
                        {year.id === currentYearId ? '・表示中の年度' : '。その年度を開いて直してください'}）
                      </span>
                    </li>
                  )),
                )}
              </ul>
            </div>
          ) : null}
          {disabled.length > 0 ? (
            <p className="text-muted-foreground">
              無効のルール{' '}
              {disabled.map(({ year, refs: r }) => `${year.label}：${r.disabled.map((d) => d.code).join('、')}`).join('／')}{' '}
              の参照が切れます（有効にする前に直してください）。
            </p>
          ) : null}
        </div>
      ) : null}
      {refs.unreadable.length > 0 ? (
        <p className="rounded-md border border-amber-300 bg-amber-50 p-3 text-amber-900" data-testid="rule-refs-unreadable">
          {`ルールを読めない終了していない年度があるので、削除できません（${refs.unreadable.map((y) => y.label).join('、')}。`}
          {'その年度の総務管理者・総務部員でないため、この場所を参照する有効なルールがないかを確かめられません）。'}
          {'削除は、終了していないすべての年度のルールを読める管理者が行ってください。'}
        </p>
      ) : null}
    </div>
  );
}

/**
 * 団体・場所の削除の確認（3.2）。団体は表示中の年度の、場所は終了していない年度のうち読める年度のルールを読み、
 * 参照している有効なルールがあれば削除を押せなくする。場所は、ルールを読めない終了していない年度があるときも押せなくする
 * （ロールのない年度は画面から見えないので、DB 側の確かめ〔rooms の削除のトリガー〕は別のチケット。notes/T09.md）。
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
  const { session } = useAuth();
  const userId = session.status === 'signedIn' ? session.session.user.id : null;
  const isRoom = 'roomId' in target;
  // 団体（年度ごと）は表示中の年度のルール、場所（全年度で共有）は終了していない年度のうち読める年度のルール
  const rulesQ = useQuery({
    queryKey: settingsKeys.rules(year.id),
    queryFn: () => fetchRules(year.id),
    enabled: open && !isRoom,
    staleTime: 0,
  });
  const openRulesQ = useQuery({
    queryKey: settingsKeys.openYearRules(userId ?? ''),
    queryFn: () => fetchOpenYearRules(userId!),
    enabled: open && isRoom && userId !== null,
    staleTime: 0,
  });
  const q = isRoom ? openRulesQ : rulesQ;
  // 読み直している間と、読み直しに失敗したとき（isError でも前の data が残る）は前の結果で判断しない（開いた時点のルールで確かめる）
  const groupRules = freshDataOf(rulesQ);
  const openRules = freshDataOf(openRulesQ);
  const groupRefs = !isRoom && groupRules ? rulesReferencing(groupRules, target) : null;
  const roomRefs = 'roomId' in target && openRules ? roomRefsAcrossYears(openRules.rules, openRules.scope, target.roomId) : null;
  // 場所は、ルールを読めない終了していない年度が1つでもあれば押せない（その年度のルールが参照していないかを確かめられないため）
  const blocked =
    q.isError ||
    (isRoom
      ? roomRefs === null || roomRefs.enabledCount > 0 || roomRefs.unreadable.length > 0
      : groupRefs === null || groupRefs.enabled.length > 0);
  return (
    <ConfirmDialog
      open={open}
      onOpenChange={onOpenChange}
      title={title}
      description={description}
      destructive
      confirmLabel="削除する"
      pendingLabel="削除中…"
      confirmDisabled={blocked}
      onConfirm={onConfirm}
    >
      {q.isError ? (
        <p role="alert" className="text-sm text-destructive" data-testid="rule-refs-error">
          ルールを読めなかったので、参照しているルールがないかを確かめられず、削除できません。閉じてからもう一度開いてください。
        </p>
      ) : isRoom ? (
        <RoomRuleRefsNotice refs={roomRefs} currentYearId={year.id} />
      ) : (
        <RuleRefsNotice refs={groupRefs} what={what} />
      )}
    </ConfirmDialog>
  );
}
