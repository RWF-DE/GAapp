'use client';

// ホーム /（画面の設計 3.1。T09）。総務（管理者・総務部門長・総務副部門長・総務部門員。isSoumu）はダッシュボード、
// 団体代表（店長・副店長）・閲覧のみはホーム。どの立場にも「立場の一覧」（home-year・home-roles）を出す。
// 管理者で店長・副店長も務める人には、ダッシュボードの上に団体代表のカードを出す（部門のロールは同じ年度の団体代表を兼ねられない。D-49）。
import { PageHeader } from '@/components/common/page-header';
import { useAuth } from '@/lib/auth/auth-provider';
import { audiencesOf } from '@/lib/auth/membership';
import { isSoumu } from '@/lib/auth/roles';
import { Dashboard } from './dashboard';
import { RepHome, ViewerHome } from './rep-home';
import { RoleSummary } from './role-summary';

export function HomeScreen() {
  const { membership } = useAuth();
  if (membership.status !== 'ready') return null; // AppShell が読み込み中・未招待を出す
  const m = membership.membership;
  if (!m.year) return null;
  const audiences = audiencesOf(m);
  const soumu = isSoumu(m.role);

  return (
    <div className="mx-auto max-w-6xl space-y-4">
      <RoleSummary membership={m} />
      {!soumu ? <PageHeader title="ホーム" /> : null}
      {m.groups.length > 0 ? <RepHome yearId={m.year.id} groups={m.groups} /> : null}
      {m.role === 'viewer' ? <ViewerHome status={m.year.status} /> : null}
      {soumu ? <Dashboard yearId={m.year.id} audiences={audiences} /> : null}
    </div>
  );
}
