'use client';

import { usePathname } from 'next/navigation';
import { AppLink } from '@/components/common/app-link';
import { isActivePath, type NavItem } from '@/lib/navigation';
import { cn } from '@/lib/utils';

/**
 * ナビゲーション。T09a で全画面に雛形のページを置いたので、項目はすべてリンク（ready）。
 * AppLink を使うので、未保存の入力があれば移る前に確かめる。
 */
export function AppNav({ items, onNavigate, className }: { items: NavItem[]; onNavigate?: () => void; className?: string }) {
  const pathname = usePathname();
  return (
    <nav aria-label="メインメニュー" className={className}>
      <ul className="flex flex-col gap-1">
        {items.map((item) => {
          const active = isActivePath(pathname, item.href);
          const base = 'flex items-center justify-between gap-2 rounded-md px-3 py-2 text-sm';
          return (
            <li key={item.href}>
              {item.ready ? (
                <AppLink
                  href={item.href}
                  onClick={onNavigate}
                  aria-current={active ? 'page' : undefined}
                  className={cn(
                    base,
                    active
                      ? 'bg-sidebar-accent font-medium text-sidebar-accent-foreground'
                      : 'text-sidebar-foreground hover:bg-sidebar-accent/60',
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
        })}
      </ul>
    </nav>
  );
}
