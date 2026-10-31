'use client';

import { Loader2, LogOut, Menu, X } from 'lucide-react';
import { usePathname } from 'next/navigation';
import { Fragment, useEffect, useRef, useState } from 'react';
import { NotLatestYearBanner } from '@/components/common/latest-year';
import { ErrorState, LoadingState } from '@/components/states';
import { Button } from '@/components/ui/button';
import { useAuth } from '@/lib/auth/auth-provider';
import { useGuardedSetYear, useGuardedSignOut } from '@/lib/auth/guarded';
import {
  audiencesOf,
  isInvited,
  positionLabels,
  YEAR_STATUS_LABELS,
  yearOptionLabel,
  type Membership,
} from '@/lib/auth/membership';
import { navSectionsFor } from '@/lib/navigation';
import { useGuardedRouter } from '@/lib/navigation/guarded-router';
import { cn } from '@/lib/utils';
import { AppNav } from './app-nav';
import { NotInvited } from './not-invited';

/**
 * ログインが要る画面の共通レイアウト（P-03。T09a で年度の切り替え・裏での読み直し・ログアウトの確かめを足した）。
 * ログインしていなければ /login/ へ送り、招待されていなければ「総務から招待されていません」だけを出す。
 * 招待されていれば、ヘッダー（年度・立場・ログアウト）とロールに合わせたナビゲーションを出す。
 *
 * ページ全体を LoadingState・ErrorState に置き換えるのは、初回の読み込みと利用者が変わったときだけ
 * （同じ利用者の立場の読み直しでは AuthProvider が前の立場を ready のまま出すので、画面は外れない）。
 */
export function AppShell({ children }: { children: React.ReactNode }) {
  const { session, membership, reloadMembership } = useAuth();
  const router = useGuardedRouter();
  const pathname = usePathname();
  const guardedSignOut = useGuardedSignOut();
  const manualSignOut = useRef(false);

  // 未ログイン（強制の signOut・ほかのタブのログアウトを含む）は、確かめずに /login へ（入力は下書きに残る）
  useEffect(() => {
    if (session.status !== 'signedOut') return;
    const next = pathname + window.location.search;
    router.forceReplace(manualSignOut.current || next === '/' ? '/login/' : `/login/?next=${encodeURIComponent(next)}`);
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
  // 手動のログアウト：未保存の入力があれば確かめる（やめればそのまま）。続ければキャッシュ・下書き・選んだ年度を消す
  const handleSignOut = () => {
    void guardedSignOut().then((done) => {
      if (done) {
        manualSignOut.current = true;
        router.forceReplace('/login/');
      }
    });
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

/** 年度の選択（自分の年度が2つ以上あるときだけ。1日目の新しい順。D-31） */
function YearSelect({ membership }: { membership: Membership }) {
  const setYear = useGuardedSetYear();
  if (membership.years.length < 2 || !membership.year) return null;
  return (
    <label className="flex min-w-0 items-center gap-1 text-xs">
      <span className="sr-only">年度を切り替える</span>
      <select
        data-testid="year-select"
        aria-label="年度を切り替える"
        className="h-8 min-w-0 max-w-36 truncate rounded-md border bg-background px-1 text-xs"
        // 確かめてやめたときは今の年度のまま（制御された select なので元に戻る）
        value={membership.year.id}
        onChange={(e) => void setYear(e.target.value)}
      >
        {membership.years.map((y) => (
          <option key={y.id} value={y.id}>
            {yearOptionLabel(y)}
          </option>
        ))}
      </select>
    </label>
  );
}

function Frame({ membership, onSignOut, children }: { membership: Membership; onSignOut: () => void; children: React.ReactNode }) {
  const { isRefreshing } = useAuth();
  const [menuOpen, setMenuOpen] = useState(false);
  const year = membership.year;
  // ナビは見出し（ホーム・機能ごと・共通）ごと（T16。PC の左とスマホのメニューで同じもの）
  const sections = navSectionsFor(audiencesOf(membership), year?.status);
  // 立場：ロールの表示名と、代表する団体ごとの「{団体名} の店長」「{団体名} の副店長」（T15b。ホームの立場の一覧と同じ言い方）
  const roles = positionLabels(membership);
  // スマホ（md 未満）では年度の選択があれば印を隠す（選択に今の年度が出る。幅 390px でヘッダーがはみ出さないように）
  const hasYearSelect = membership.years.length >= 2 && !!year;

  return (
    <div className="flex min-h-dvh flex-col">
      <header className="sticky top-0 z-20 flex h-14 items-center gap-2 border-b bg-background px-4 print:hidden">
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
          <span
            className={cn('min-w-0 truncate rounded-full border px-2 py-0.5 text-xs', hasYearSelect && 'max-md:sr-only')}
            data-testid="current-year"
          >
            {year.label}・{YEAR_STATUS_LABELS[year.status]}
          </span>
        ) : null}
        <YearSelect membership={membership} />
        {isRefreshing ? (
          <Loader2 aria-label="立場を読み直しています" role="status" className="size-4 shrink-0 animate-spin text-muted-foreground" />
        ) : null}
        <div className="ml-auto flex shrink-0 items-center gap-2 md:min-w-0 md:shrink">
          <div className="hidden min-w-0 text-right text-xs leading-tight md:block">
            <div className="truncate font-medium">{membership.displayName ?? '名前未設定'}</div>
            <div className="truncate text-muted-foreground">{roles.join('・')}</div>
          </div>
          <Button variant="outline" size="sm" className="shrink-0" onClick={onSignOut}>
            <LogOut aria-hidden />
            <span className="hidden sm:inline">ログアウト</span>
            <span className="sr-only sm:hidden">ログアウト</span>
          </Button>
        </div>
      </header>

      <NotLatestYearBanner />

      {menuOpen ? (
        <div id="app-mobile-nav" className="border-b bg-sidebar p-2 md:hidden print:hidden">
          <div className="px-3 pb-2 text-xs text-muted-foreground">
            {membership.displayName ?? '名前未設定'}（{roles.join('・')}）
          </div>
          <AppNav sections={sections} onNavigate={() => setMenuOpen(false)} />
        </div>
      ) : null}

      <div className="flex flex-1">
        <aside className="hidden w-56 shrink-0 border-r bg-sidebar p-3 md:block print:hidden">
          <AppNav sections={sections} />
        </aside>
        <main className="min-w-0 flex-1 p-4 md:p-6 print:p-0">
          {/* 年度が変わったら画面を作り直す（前の年度の入力を持ち越さない。入力は前の年度の下書きに残る。1.3.1）。
              同じ年度の立場の読み直しでは key が変わらないので、画面は外れない */}
          <Fragment key={year?.id ?? 'none'}>{children}</Fragment>
        </main>
      </div>
    </div>
  );
}
