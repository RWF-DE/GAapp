'use client';

// マスタ設定 /settings（画面の設計 3.2。T09）。admin だけ（ページの RequireAudience）。タブは `?tab=`（既定 years）。
// closed の年度では、ロールを外す・団体代表を外す・招待の取り消し・新しい年度の作成以外は読み取り専用。
import { useSearchParams } from 'next/navigation';
import { PageHeader } from '@/components/common/page-header';
import { ErrorState, LoadingState, ReadOnlyNotice } from '@/components/states';
import { Tabs, TabsContent, TabsList, TabsTrigger } from '@/components/ui/tabs';
import { useAuth } from '@/lib/auth/auth-provider';
import { parseSettingsTab, SETTINGS_TAB_LABELS, SETTINGS_TABS, type SettingsTab } from '@/lib/data/settings';
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

export function SettingsScreen() {
  const params = useSearchParams();
  const tab = parseSettingsTab(params.get('tab'));
  const router = useGuardedRouter();
  const { membership } = useAuth();
  const m = membership.status === 'ready' ? membership.membership : null;
  const yearQ = useYearRow(m?.year?.id);

  if (!m?.year) return <LoadingState />;
  if (yearQ.isError) {
    return <ErrorState message={messageFor(classifyError(yearQ.error))} onRetry={() => void yearQ.refetch()} />;
  }
  if (!yearQ.data) return <LoadingState />;
  const year = yearQ.data;
  const ctx: SettingsContextValue = {
    year,
    membership: m,
    yearWritable: year.status !== 'closed',
    globalWritable: m.adminOfOpenYear,
  };

  return (
    <SettingsContext.Provider value={ctx}>
      <PageHeader title="マスタ設定" />
      {year.status === 'closed' ? (
        <ReadOnlyNotice className="mb-4">
          終了した年度のため、読み取り専用です（ロールを外す・団体代表を外す・招待の取り消し・新しい年度の作成はできます）
        </ReadOnlyNotice>
      ) : null}
      <Tabs
        value={tab}
        onValueChange={(v) => void router.replace(`/settings?tab=${parseSettingsTab(v)}`, { scroll: false })}
        className="gap-4"
      >
        <div className="-mx-1 overflow-x-auto px-1 pb-1">
          <TabsList aria-label="マスタ設定の項目">
            {SETTINGS_TABS.map((t) => (
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
