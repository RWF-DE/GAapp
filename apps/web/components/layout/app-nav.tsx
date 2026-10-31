'use client';

import { usePathname } from 'next/navigation';
import { useId } from 'react';
import { AppLink } from '@/components/common/app-link';
import { isActivePath, type NavItem, type NavSection } from '@/lib/navigation';
import { cn } from '@/lib/utils';

/**
 * ナビゲーション（04「共通レイアウト」）。見出し（ホーム・機能ごと・共通。lib/navigation.ts の navSectionsFor）ごとに、
 * 見出しと項目の一覧を `role="group"` にまとめる（T16。D-51・D-52）。「ホーム」の見出しは項目が「ホーム」1つなので
 * 見た目では出さない（読み上げでは見出しとして読む。同じ言葉を縦に2つ並べない）。`<li>` は項目（リンク）だけにする
 * （見出しを `<li>` にしない。E2E の navLabels は listitem の文字を平らな一覧として読む）。
 * T09a で全画面に雛形のページを置いたので、項目はすべてリンク（ready）。AppLink を使うので、未保存の入力があれば移る前に確かめる。
 * PC の左とスマホのメニューで2つ置かれうるので、見出しの id は useId で作る。
 */
export function AppNav({
  sections,
  onNavigate,
  className,
}: {
  sections: readonly NavSection[];
  onNavigate?: () => void;
  className?: string;
}) {
  const pathname = usePathname();
  const baseId = useId();
  return (
    <nav aria-label="メインメニュー" className={cn('flex flex-col gap-3', className)}>
      {sections.map((section) => {
        const headingId = `${baseId}-${section.id}`;
        return (
          <div key={section.id} role="group" aria-labelledby={headingId} data-nav-section={section.id}>
            <h2
              id={headingId}
              className={cn(
                'px-3 pb-1 text-xs font-medium text-muted-foreground',
                // 「ホーム」の見出しは見た目では出さない（項目が「ホーム」1つだけなので）
                section.id === 'home' && 'sr-only',
              )}
            >
              {section.heading}
            </h2>
            <ul className="flex flex-col gap-1">
              {section.items.map((item) => (
                <NavLink key={item.href} item={item} active={isActivePath(pathname, item.href)} onNavigate={onNavigate} />
              ))}
            </ul>
          </div>
        );
      })}
    </nav>
  );
}

function NavLink({ item, active, onNavigate }: { item: NavItem; active: boolean; onNavigate: (() => void) | undefined }) {
  const base = 'flex items-center justify-between gap-2 rounded-md px-3 py-2 text-sm';
  return (
    <li>
      {item.ready ? (
        <AppLink
          href={item.href}
          onClick={onNavigate}
          aria-current={active ? 'page' : undefined}
          className={cn(
            base,
            active ? 'bg-sidebar-accent font-medium text-sidebar-accent-foreground' : 'text-sidebar-foreground hover:bg-sidebar-accent/60',
          )}
        >
          {item.label}
        </AppLink>
      ) : (
        <span aria-disabled="true" className={cn(base, 'cursor-default text-muted-foreground')}>
          {item.label}
          <span className="rounded border px-1.5 py-0.5 text-[10px] leading-none">準備中</span>
        </span>
      )}
    </li>
  );
}
