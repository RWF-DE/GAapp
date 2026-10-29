'use client';

import { LogOut, Menu, X } from 'lucide-react';
import { usePathname, useRouter } from 'next/navigation';
import { useEffect, useState } from 'react';
import { ErrorState, LoadingState } from '@/components/states';
import { Button } from '@/components/ui/button';
import { useAuth } from '@/lib/auth/auth-provider';
import { audiencesOf, isInvited, ROLE_LABELS, YEAR_STATUS_LABELS, type Membership } from '@/lib/auth/membership';
import { navItemsFor } from '@/lib/navigation';
import { AppNav } from './app-nav';
import { NotInvited } from './not-invited';

/**
 * ログインが要る画面の共通レイアウト（P-03）。
 * ログインしていなければ /login/ へ送り、招待されていなければ「総務から招待されていません」だけを出す。
 * 招待されていれば、ヘッダー（年度・立場・ログアウト）とロールに合わせたナビゲーションを出す。
 */
export function AppShell({ children }: { children: React.ReactNode }) {
  const { session, membership, reloadMembership, signOut } = useAuth();
  const router = useRouter();
  const pathname = usePathname();

  useEffect(() => {
    if (session.status === 'signedOut') {
      const next = pathname + window.location.search;
      router.replace(next === '/' ? '/login/' : `/login/?next=${encodeURIComponent(next)}`);
    }
  }, [session.status, pathname, router]);

  if (session.status === 'configError') {
    return <ErrorState className="min-h-dvh" message={session.message} />;
  }
  if (session.status !== 'signedIn' || membership.status === 'idle' || membership.status === 'loading') {
    return <LoadingState className="min-h-dvh" />;
  }
  if (membership.status === 'error') {
    return <ErrorState className="min-h-dvh" message={membership.message} onRetry={reloadMembership} />;
  }
  const handleSignOut = () => {
    void signOut().then(() => router.replace('/login/'));
  };
  if (!isInvited(membership.membership)) {
    return <NotInvited onSignOut={handleSignOut} />;
  }
  return (
    <Frame membership={membership.membership} onSignOut={handleSignOut}>
      {children}
    </Frame>
  );
}

function roleSummary(m: Membership): string[] {
  const parts: string[] = [];
  if (m.role) parts.push(ROLE_LABELS[m.role]);
  for (const g of m.groups) parts.push(`${g.name} の団体代表`);
  return parts;
}

function Frame({ membership, onSignOut, children }: { membership: Membership; onSignOut: () => void; children: React.ReactNode }) {
  const [menuOpen, setMenuOpen] = useState(false);
  const items = navItemsFor(audiencesOf(membership));
  const year = membership.year;
  const roles = roleSummary(membership);

  return (
    <div className="flex min-h-dvh flex-col">
      <header className="sticky top-0 z-20 flex h-14 items-center gap-2 border-b bg-background px-4">
        <Button
          variant="ghost"
          size="icon"
          className="md:hidden"
          aria-label={menuOpen ? 'メニューを閉じる' : 'メニューを開く'}
          aria-expanded={menuOpen}
          aria-controls="app-mobile-nav"
          onClick={() => setMenuOpen((v) => !v)}
        >
          {menuOpen ? <X /> : <Menu />}
        </Button>
        <span className="truncate font-bold">
          <span className="hidden sm:inline">電波祭 総務 </span>机椅子管理
        </span>
        {year ? (
          <span className="shrink-0 rounded-full border px-2 py-0.5 text-xs" data-testid="current-year">
            {year.label}・{YEAR_STATUS_LABELS[year.status]}
          </span>
        ) : null}
        <div className="ml-auto flex min-w-0 items-center gap-2">
          <div className="hidden min-w-0 text-right text-xs leading-tight md:block">
            <div className="truncate font-medium">{membership.displayName ?? '名前未設定'}</div>
            <div className="truncate text-muted-foreground">{roles.join('・')}</div>
          </div>
          <Button variant="outline" size="sm" onClick={onSignOut}>
            <LogOut aria-hidden />
            <span className="hidden sm:inline">ログアウト</span>
            <span className="sr-only sm:hidden">ログアウト</span>
          </Button>
        </div>
      </header>

      {menuOpen ? (
        <div id="app-mobile-nav" className="border-b bg-sidebar p-2 md:hidden">
          <div className="px-3 pb-2 text-xs text-muted-foreground">
            {membership.displayName ?? '名前未設定'}（{roles.join('・')}）
          </div>
          <AppNav items={items} onNavigate={() => setMenuOpen(false)} />
        </div>
      ) : null}

      <div className="flex flex-1">
        <aside className="hidden w-56 shrink-0 border-r bg-sidebar p-3 md:block">
          <AppNav items={items} />
        </aside>
        <main className="min-w-0 flex-1 p-4 md:p-6">{children}</main>
      </div>
    </div>
  );
}
