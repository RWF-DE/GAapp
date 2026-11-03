'use client';

// 申請（/request）の「机・椅子」「テント等」のタブ（04「申請の「テント等」のタブ」、notes/T21.md「画面の約束」6。T21・D-57）。
// app/(app)/request/page.tsx が机椅子の RequestScreen をこれで包む（D-52 の例外。RequestScreen と、その testid・提出の流れは変えない）。
// - 団体の選び方は RequestScreen と同じ（`?group=` が代表する団体ならそれ、なければ最初の団体）。その団体の区分で申請できるテント等の
//   備品が1つ以上あるか、その団体に確定後の割り当て（数が1以上）か渡した記録（渡した数が1以上）のある備品が1つ以上あるときだけ
//   タブを出す（showLendingTab。2026-11-01 のリードの決定。D-57。`?tab=lending` でテント等。知らない値・タブを出さないときは
//   机・椅子）。割り当ては読む人によらず確定後のものだけ数える（団体の代表を兼ねた管理者には RLS が確定前の割り当ても返すが、確定前は
//   タブに割り当てを出さないので、数えると中身のないタブになる。タブの直しのレビューの T21-R6）。割り当てか記録だけでタブを出す団体は
//   申請しない（パネルが欄と保存を出さない）。
// - タブを出すかを決める読み取り（lendingRequestItemsOptions。備品に、その団体の割り当てと記録と、年度の確定の印を埋め込む）は、
//   RequestScreen の読み込みと並行に1本だけ。団体の区分は RequestScreen と同じクエリ（repRequestOptions。リクエストは1回）から読む。読み込み中と
//   失敗のときはタブを出さずに机・椅子のまま（失敗のときはタブの場所に「テント等の申請を読み込めませんでした」と「もう一度」）。
// - 机・椅子のパネル（children）はいつも同じ位置に置き、タブを出す前後・テント等を開いている間も作り直さない（hidden で隠す。入力・
//   下書き・確かめを残す）。`?tab=lending` で開いたときだけ、テント等のパネルを出した後に作る（隠したまま。描く順だけ。レビューの T21-R1）。
//   テント等のパネルは初めて開いたときに作り、その後は残す。パネルの JS は /request の最初に読む JS に入れる（静的な import。FU3 の
//   PR B の案 4。T21 の「確認したいこと」の 11 の (b)）：ダッシュボードの要対応の行き先が `?tab=lending` なので、立場が届いてタブを出すと
//   決めたら、JS の読み込みを待たずに同じ描画でパネルを出す（前は動的 import で、タブを開いたときか立場が届いたときに読み始めていた）。
//   机・椅子のタブを開くときも読む。
// - テント等のタブのボタンに、保存していない入力があれば印（data-unsaved）。
import { useQuery } from '@tanstack/react-query';
import { useSearchParams } from 'next/navigation';
import { startTransition, useCallback, useEffect, useState } from 'react';
import { LoadingState } from '@/components/states';
import { Button } from '@/components/ui/button';
import { useAuth } from '@/lib/auth/auth-provider';
import type { GroupSummary } from '@/lib/auth/membership';
import { repRequestOptions } from '@/lib/data/screen-queries';
import { lendingRequestItemsOptions, type LendingRequestItem } from '@/lib/modules/lending/queries';
import { useGuardedRouter } from '@/lib/navigation/guarded-router';
import { parseGroupParam } from '@/lib/schemas/requests';
import { cn } from '@/lib/utils';
import { LendingRequestPanel, type LendingRequestPanelProps } from './lending-request-panel';

/** タブ（`?tab=`） */
export type RequestTab = 'furniture' | 'lending';

/** タブの読み込みが失敗したときの文 */
export const REQUEST_TABS_ERROR = 'テント等の申請を読み込めませんでした';

/** その区分で申請できる備品（申請できる区分に区分がある） */
export function requestableItems<T extends Pick<LendingRequestItem, 'requestable_categories'>>(items: readonly T[], category: string | null | undefined): T[] {
  return category ? items.filter((i) => (i.requestable_categories as readonly string[]).includes(category)) : [];
}

/**
 * テント等のタブを出すか（2026-11-01 のリードの決定。D-57）：その区分で申請できる備品があるか、その団体に確定後の割り当て（数が1以上。
 * `assigned` は年度の確定の印があるときだけ真。タブの直しのレビューの T21-R6）か渡した記録（渡した数が1以上）のある備品があるとき。
 * どれもなければ出さない（空のタブを出さない）
 */
export function showLendingTab(items: readonly Pick<LendingRequestItem, 'requestable_categories' | 'assigned' | 'lent'>[], category: string | null | undefined): boolean {
  return requestableItems(items, category).length > 0 || items.some((i) => i.assigned || i.lent);
}

/** `?tab=` を変えた /request の URL（ほかのクエリ〔group〕は残す） */
export function requestTabHref(params: { toString(): string }, tab: RequestTab): string {
  const q = new URLSearchParams(params.toString());
  if (tab === 'lending') q.set('tab', 'lending');
  else q.delete('tab');
  const s = q.toString();
  return s ? `/request?${s}` : '/request';
}

export function RequestTabs({ children }: { children: React.ReactNode }) {
  const { membership, session } = useAuth();
  const params = useSearchParams();
  const m = membership.status === 'ready' ? membership.membership : null;
  const groups = m?.groups ?? [];
  const wanted = parseGroupParam(params.get('group'));
  const group = groups.find((g) => g.id === wanted) ?? groups[0] ?? null;
  const yearId = m?.year?.id ?? null;
  const userId = session.status === 'signedIn' ? session.session.user.id : null;
  // TabsFrame に key を付けない（団体・年度が変わっても机・椅子のパネル〔children〕を作り直さない。RequestScreen が自分で作り直す）
  return (
    <TabsFrame yearId={yearId} group={group} userId={userId} params={params}>
      {children}
    </TabsFrame>
  );
}

function TabsFrame({
  yearId,
  group,
  userId,
  params,
  children,
}: {
  yearId: string | null;
  group: GroupSummary | null;
  userId: string | null;
  params: URLSearchParams | { get(name: string): string | null; toString(): string };
  children: React.ReactNode;
}) {
  const router = useGuardedRouter();
  const enabled = !!yearId && !!group;
  const itemsQ = useQuery({ ...lendingRequestItemsOptions(yearId ?? '', group?.id ?? ''), enabled });
  const groupQ = useQuery({ ...repRequestOptions(yearId, group?.id ?? null), enabled });
  const category = groupQ.data?.group.category ?? null;
  const showTabs = enabled && !!itemsQ.data && !!groupQ.data && showLendingTab(itemsQ.data, category);
  const wantLending = params.get('tab') === 'lending';
  const tab: RequestTab = showTabs && wantLending ? 'lending' : 'furniture';
  // テント等のパネルは初めて開いたときに作り、その後は残す（入力を消さない）。団体・年度が変わったら作り直す
  const frameKey = `${yearId ?? ''}:${group?.id ?? ''}`;
  const [openedFor, setOpenedFor] = useState<string | null>(null);
  if (tab === 'lending' && openedFor !== frameKey) setOpenedFor(frameKey);
  const opened = openedFor === frameKey;
  const [lendingDirty, setLendingDirty] = useState(false);
  // 机・椅子のパネル（children）を作ったか。`?tab=lending` で開いたときは、テント等のパネルを出した後に作る（隠したまま。描く順だけで、
  // 作った後は作り直さない。4G の遅い端末で、隠れた机・椅子の画面を描く分だけテント等の表示が遅れないように。レビューの T21-R1）。
  // タブを出すかが決まって机・椅子を出すとき（タブを出さない・読み込みの失敗・机・椅子のタブ）は、すぐに作る
  const [furnitureMounted, setFurnitureMounted] = useState(!wantLending);
  const decided = !enabled || itemsQ.isError || groupQ.isError || (!!itemsQ.data && !!groupQ.data);
  if (!furnitureMounted && decided && tab === 'furniture') setFurnitureMounted(true);
  const onLendingShown = useCallback(() => startTransition(() => setFurnitureMounted(true)), []);

  const switchTo = (next: RequestTab) => router.forceReplace(requestTabHref(params, next));

  return (
    <>
      <div className="mx-auto max-w-xl print:hidden">
        {showTabs ? (
          <div role="tablist" aria-label="申請の種類" data-testid="request-tabs" className="mb-3 grid grid-cols-2 gap-1 rounded-lg bg-muted p-1">
            <TabButton id="furniture" testId="request-tab-furniture" active={tab === 'furniture'} onSelect={() => switchTo('furniture')}>
              机・椅子
            </TabButton>
            <TabButton id="lending" testId="request-tab-lending" active={tab === 'lending'} unsaved={lendingDirty} onSelect={() => switchTo('lending')}>
              テント等
            </TabButton>
          </div>
        ) : enabled && itemsQ.isError ? (
          <div role="alert" data-testid="request-tabs-error" className="mb-3 flex flex-wrap items-center gap-2 rounded-md border px-3 py-2 text-sm text-muted-foreground">
            <span>{REQUEST_TABS_ERROR}</span>
            <Button size="sm" variant="outline" onClick={() => void itemsQ.refetch()}>
              もう一度
            </Button>
          </div>
        ) : null}
      </div>
      <div id="request-panel-furniture" role={showTabs ? 'tabpanel' : undefined} aria-labelledby={showTabs ? 'request-tab-furniture' : undefined} hidden={tab === 'lending'}>
        {furnitureMounted ? children : <LoadingState />}
      </div>
      {opened && showTabs && yearId && group && userId && category ? (
        <div id="request-panel-lending" role="tabpanel" aria-labelledby="request-tab-lending" hidden={tab !== 'lending'}>
          <LendingPanelSlot
            key={frameKey}
            yearId={yearId}
            group={group}
            groupCategory={category}
            locationName={groupQ.data?.locationName ?? null}
            items={itemsQ.data ?? []}
            userId={userId}
            onDirtyChange={setLendingDirty}
            onShown={onLendingShown}
          />
        </div>
      ) : null}
    </>
  );
}

/**
 * テント等のパネル（初めて開いたときに作る。JS は /request の最初に読む JS に入っているので、JS の読み込み中・読み込みの失敗はない。
 * FU3 の PR B の案 4）。パネルを出した後に onShown で1回知らせる（`?tab=lending` で開いたとき、机・椅子のパネルをこの後に作る。
 * レビューの T21-R1）
 */
function LendingPanelSlot({ onShown, ...props }: LendingRequestPanelProps & { onShown: () => void }) {
  useEffect(() => {
    onShown();
  }, [onShown]);
  return <LendingRequestPanel {...props} />;
}

function TabButton({
  id,
  testId,
  active,
  unsaved = false,
  onSelect,
  children,
}: {
  id: RequestTab;
  testId: string;
  active: boolean;
  unsaved?: boolean;
  onSelect: () => void;
  children: React.ReactNode;
}) {
  return (
    <button
      type="button"
      role="tab"
      id={`request-tab-${id}`}
      data-testid={testId}
      aria-selected={active}
      aria-controls={`request-panel-${id}`}
      data-unsaved={unsaved ? 'true' : undefined}
      onClick={onSelect}
      className={cn(
        'relative min-h-11 rounded-md px-3 text-sm font-medium transition-colors',
        active ? 'bg-background text-foreground shadow-sm' : 'text-muted-foreground hover:text-foreground',
      )}
    >
      {children}
      {unsaved ? (
        <span className="ml-1 inline-block size-2 rounded-full bg-amber-500 align-middle" aria-label="保存していない入力があります" />
      ) : null}
    </button>
  );
}
