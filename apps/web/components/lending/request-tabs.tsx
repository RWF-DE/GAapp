'use client';

// 申請（/request）の「机・椅子」「テント等」のタブ（04「申請の「テント等」のタブ」、notes/T21.md「画面の約束」6。T21・D-57）。
// app/(app)/request/page.tsx が机椅子の RequestScreen をこれで包む（D-52 の例外。RequestScreen と、その testid・提出の流れは変えない）。
// - 団体の選び方は RequestScreen と同じ（`?group=` が代表する団体ならそれ、なければ最初の団体）。その団体の区分で申請できるテント等の
//   備品が1つ以上あるときだけタブを出す（`?tab=lending` でテント等。知らない値・申請できる備品がないときは机・椅子）。
// - タブを出すかを決める備品の読み取り（lendingRequestItemsOptions）は、RequestScreen の読み込みと並行に1本だけ。団体の区分は
//   RequestScreen と同じクエリ（repRequestOptions。リクエストは1回）から読む。読み込み中と失敗のときはタブを出さずに机・椅子のまま
//   （失敗のときはタブの場所に「テント等の申請を読み込めませんでした」と「もう一度」）。
// - 机・椅子のパネル（children）はいつも同じ位置に置き、タブを出す前後・テント等を開いている間も作り直さない（hidden で隠す。入力・
//   下書き・確かめを残す）。`?tab=lending` で開いたときだけ、テント等のパネルを出した後に作る（隠したまま。描く順だけ）。
//   テント等のパネルは初めて開いたときに作り、その後は残す。パネルの JS は、`?tab=lending` で開いたときは
//   立場が届いてこの部品を描くときに（タブを出すかを決める読み取りと並行に）、ほかはテント等のタブを開いたときに読み始める
//   （request-panel-loader.ts。ダッシュボードの要対応の行き先が `?tab=lending` なので、4G で 2 秒以内に開くため。レビューの T21-R1）。
// - テント等のタブのボタンに、保存していない入力があれば印（data-unsaved）。
import { useQuery } from '@tanstack/react-query';
import { useSearchParams } from 'next/navigation';
import { startTransition, useCallback, useEffect, useState } from 'react';
import { ErrorState, LoadingState } from '@/components/states';
import { Button } from '@/components/ui/button';
import { useAuth } from '@/lib/auth/auth-provider';
import type { GroupSummary } from '@/lib/auth/membership';
import { repRequestOptions } from '@/lib/data/screen-queries';
import { lendingRequestItemsOptions, type LendingRequestItem } from '@/lib/modules/lending/queries';
import { useGuardedRouter } from '@/lib/navigation/guarded-router';
import { parseGroupParam } from '@/lib/schemas/requests';
import { cn } from '@/lib/utils';
import type { LendingRequestPanelProps } from './lending-request-panel';
import { loadedLendingRequestPanel, loadLendingRequestPanel, type LendingRequestPanelModule } from './request-panel-loader';

/** タブ（`?tab=`） */
export type RequestTab = 'furniture' | 'lending';

/** タブの読み込みが失敗したときの文 */
export const REQUEST_TABS_ERROR = 'テント等の申請を読み込めませんでした';

/** その区分で申請できる備品（申請できる区分に区分がある） */
export function requestableItems<T extends Pick<LendingRequestItem, 'requestable_categories'>>(items: readonly T[], category: string | null | undefined): T[] {
  return category ? items.filter((i) => (i.requestable_categories as readonly string[]).includes(category)) : [];
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
  // `?tab=lending` で開いたときは、タブを出すかを決める読み取り（備品と団体の区分）を待たずに、パネルの JS を読み始める（読み取りと
  // 並行に。待つと、読み取り → JS の読み込み → 描画と直列に並ぶ。レビューの T21-R1）。描くときに始める（何度呼んでも読むのは1回。
  // effect で始めると、この下の画面を描き終えるまで遅れる）。タブを出さないと決まれば使わないだけ。失敗は、タブを開いたときの読み込み
  // （LendingPanelSlot）が読み直して出す。プリレンダーではここを描かない（RequireAudience の中）が、window のないときは読まない
  if (params.get('tab') === 'lending' && typeof window !== 'undefined') void loadLendingRequestPanel().catch(() => undefined);
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
  const itemsQ = useQuery({ ...lendingRequestItemsOptions(yearId ?? ''), enabled });
  const groupQ = useQuery({ ...repRequestOptions(yearId, group?.id ?? null), enabled });
  const category = groupQ.data?.group.category ?? null;
  const requestable = itemsQ.data ? requestableItems(itemsQ.data, category) : [];
  const showTabs = enabled && !!itemsQ.data && !!groupQ.data && requestable.length > 0;
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
 * テント等のパネル（初めて開いたときに JS を読む。/request の最初に読む JS に入れない。開くのは立場が届いた後のブラウザだけなので、
 * プリレンダーでは読まない）。JS を読み終えていればそのまま描き、まだなら読み込み中を出して、読み終えたら描く。React.lazy と Suspense は
 * 使わない（React は Suspense の読み込み中を出してから 300 ms たつまで中身を出さないので、4G で JS が読み取りの少し後に届くと、表示が
 * 300 ms ほど遅れた。レビューの T21-R1）。読めなければ「もう一度読み込む」（読み直す）。パネルを出した後に onShown で1回知らせる
 */
function LendingPanelSlot({ onShown, ...props }: LendingRequestPanelProps & { onShown: () => void }) {
  const [mod, setMod] = useState<LendingRequestPanelModule | null>(loadedLendingRequestPanel);
  const [failed, setFailed] = useState(false);
  const [attempt, setAttempt] = useState(0);
  useEffect(() => {
    if (mod) return;
    let alive = true;
    loadLendingRequestPanel().then(
      (m) => {
        if (alive) setMod(() => m);
      },
      () => {
        if (alive) setFailed(true);
      },
    );
    return () => {
      alive = false;
    };
  }, [mod, attempt]);
  useEffect(() => {
    if (mod) onShown();
  }, [mod, onShown]);
  if (mod) return <mod.LendingRequestPanel {...props} />;
  if (failed) {
    return (
      <ErrorState
        message={REQUEST_TABS_ERROR}
        onRetry={() => {
          setFailed(false);
          setAttempt((n) => n + 1);
        }}
      />
    );
  }
  return <LoadingState />;
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
