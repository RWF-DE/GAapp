'use client';

// ホーム /（画面の設計 3.1。T09）。総務（admin・staff）はダッシュボード、団体代表・閲覧のみはホーム。
// どの立場にも「立場の一覧」（home-year・home-roles）を出す。総務で団体代表も兼ねる人には、ダッシュボードの上に団体代表のカードを出す。
import { PageHeader } from '@/components/common/page-header';
import { useAuth } from '@/lib/auth/auth-provider';
import { audiencesOf } from '@/lib/auth/membership';
import { Dashboard } from './dashboard';
import { RepHome, ViewerHome } from './rep-home';
import { RoleSummary } from './role-summary';

export function HomeScreen() {
  const { membership } = useAuth();
  if (membership.status !== 'ready') return null; // AppShell が読み込み中・未招待を出す
  const m = membership.membership;
  if (!m.year) return null;
  const audiences = audiencesOf(m);
  const staffLike = m.role === 'admin' || m.role === 'staff';

  return (
    <div className="mx-auto max-w-6xl space-y-4">
      <RoleSummary membership={m} />
      {!staffLike ? <PageHeader title="ホーム" /> : null}
      {m.groups.length > 0 ? <RepHome yearId={m.year.id} groups={m.groups} /> : null}
      {m.role === 'viewer' ? <ViewerHome status={m.year.status} /> : null}
      {staffLike ? <Dashboard yearId={m.year.id} audiences={audiences} /> : null}
    </div>
  );
}
