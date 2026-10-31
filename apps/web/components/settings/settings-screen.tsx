'use client';

// マスタ設定 /settings（画面の設計 3.2。T09・T15b）。部門長以上（ページの RequireAudience）。タブは `?tab=` で、段ごとに出し分ける
// （settingsTabsFor。D-50）：管理者はすべて、総務部門長・総務副部門長は年度（受付期間だけ）・場所（今年の使用だけ）・ユーザーだけ。
// 開けないタブ・知らない値の `?tab=` は開けるタブの最初（年度）を出す（URL は書き換えない）。
// closed の年度では、ロールを外す・店長・副店長を外す・招待の取り消し・新しい年度の作成（管理者）以外は読み取り専用。
import { useSearchParams } from 'next/navigation';
import { ErrorBanner } from '@/components/common/error-banner';
import { PageHeader } from '@/components/common/page-header';
import { ErrorState, ForbiddenState, LoadingState, ReadOnlyNotice } from '@/components/states';
import { Tabs, TabsContent, TabsList, TabsTrigger } from '@/components/ui/tabs';
import { useAuth } from '@/lib/auth/auth-provider';
import { isAdmin } from '@/lib/auth/roles';
import { parseSettingsTab, SETTINGS_TAB_LABELS, settingsTabsFor, type SettingsTab } from '@/lib/data/settings';
import { useYearRow } from '@/lib/data/year';
import { classifyError, messageFor } from '@/lib/errors';
import { useGuardedRouter } from '@/lib/navigation/guarded-router';
import { DistanceTab } from './distance-tab';
import { ExportTab } from './export-tab';
import { GroupsTab } from './groups-tab';
import { ItemsTab } from './items-tab';
import { RoomsTab } from './rooms-tab';
import { SettingsContext, type SettingsContextValue } from './shared';
import { UsersTab } from './users-tab';
import { YearsTab } from './years-tab';

const TAB_COMPONENTS: Record<SettingsTab, () => React.ReactNode> = {
  years: () => <YearsTab />,
  rooms: () => <RoomsTab />,
  items: () => <ItemsTab />,
  groups: () => <GroupsTab />,
  distance: () => <DistanceTab />,
  users: () => <UsersTab />,
  export: () => <ExportTab />,
};

/** 終了した年度の帯（できることが段で違う。04「マスタ設定」） */
const CLOSED_NOTICE = {
  admin: '終了した年度のため、読み取り専用です（ロールを外す・店長・副店長を外す・招待の取り消し・新しい年度の作成はできます）',
  lead: '終了した年度のため、読み取り専用です（総務部門員のロールを外す・店長・副店長を外す・招待の取り消しはできます）',
} as const;

export function SettingsScreen() {
  const params = useSearchParams();
  const router = useGuardedRouter();
  const { membership } = useAuth();
  const m = membership.status === 'ready' ? membership.membership : null;
  const yearQ = useYearRow(m?.year?.id);

  if (!m?.year) return <LoadingState />;
  // 開けるタブがない（部門長以上でない）ときはページの守り（RequireAudience）が権限なしにしているが、念のためここでも止める
  const tabs = settingsTabsFor(m.role);
  if (tabs.length === 0) return <ForbiddenState />;
  const tab = parseSettingsTab(params.get('tab'), tabs);
  // 年度の行がまだないときだけ ErrorState。あるときの読み直し（書き込みの失敗の後など）の失敗は、タブ（開いているフォーム・
  // ダイアログと入力を含む）を外さずに、上の帯で知らせる（2.5・2.6。机椅子の状況・QueryState と同じ）
  if (yearQ.isError && !yearQ.data) {
    return <ErrorState message={messageFor(classifyError(yearQ.error))} onRetry={() => void yearQ.refetch()} />;
  }
  if (!yearQ.data) return <LoadingState />;
  const year = yearQ.data;
  const ctx: SettingsContextValue = {
    year,
    membership: m,
    yearWritable: year.status !== 'closed',
    // 終了した年度では年度をまたぐ表も読み取り専用（04。ほかの開いている年度の管理者でも。その年度を開いて編集する）
    globalWritable: m.adminOfOpenYear && year.status !== 'closed',
  };

  return (
    <SettingsContext.Provider value={ctx}>
      <PageHeader title="マスタ設定" />
      {yearQ.isError ? (
        <div data-testid="settings-reload-error" className="mb-4">
          <ErrorBanner error={yearQ.error} onRetry={() => void yearQ.refetch()} />
        </div>
      ) : null}
      {year.status === 'closed' ? (
        <ReadOnlyNotice className="mb-4">{isAdmin(m.role) ? CLOSED_NOTICE.admin : CLOSED_NOTICE.lead}</ReadOnlyNotice>
      ) : null}
      <Tabs
        value={tab}
        onValueChange={(v) => void router.replace(`/settings?tab=${parseSettingsTab(v, tabs)}`, { scroll: false })}
        className="gap-4"
      >
        <div className="-mx-1 overflow-x-auto px-1 pb-1">
          <TabsList aria-label="マスタ設定の項目">
            {tabs.map((t) => (
              <TabsTrigger key={t} value={t} data-testid={`settings-tab-${t}`}>
                {SETTINGS_TAB_LABELS[t]}
              </TabsTrigger>
            ))}
          </TabsList>
        </div>
        {/* 選んだタブだけを描く（ほかのタブのデータを読みに行かない） */}
        <TabsContent value={tab}>{TAB_COMPONENTS[tab]()}</TabsContent>
      </Tabs>
    </SettingsContext.Provider>
  );
}
