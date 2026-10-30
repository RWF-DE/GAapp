'use client';

import Link from 'next/link';
import { useCanOpen } from '@/lib/navigation/can-open';
import { useGuardedRouter } from '@/lib/navigation/guarded-router';
import { useUnsavedChangesApi } from '@/lib/unsaved-changes';

export type AppLinkProps = Omit<React.ComponentProps<typeof Link>, 'href'> & {
  /** アプリの中のパス（basePath と末尾の / は Next.js が付ける。例 `/stock?room=…`） */
  href: string;
  /** 開けない立場のときに出すもの（既定は children を文字のまま出す） */
  fallback?: React.ReactNode;
};

/**
 * アプリの中のリンク（画面の設計 1.1・1.4。T09a）。
 * - 今の立場で行き先を開けなければ（canOpen が偽）、リンクにせず文字だけを出す（権限なしの画面に飛ばさない）。
 * - 未保存の入力があれば、移る前に確かめる（やめれば移らない）。
 *
 * @example
 * <AppLink href={`/rules?code=${code}`} className="underline">{code}</AppLink>   // staff には文字だけ
 */
export function AppLink({ href, fallback, children, className, onNavigate, ...rest }: AppLinkProps) {
  const canOpen = useCanOpen();
  const router = useGuardedRouter();
  const { isDirty, confirmLeave } = useUnsavedChangesApi();
  if (!canOpen(href)) {
    return fallback !== undefined ? <>{fallback}</> : <span className={className}>{children}</span>;
  }
  return (
    <Link
      href={href}
      className={className}
      {...rest}
      onNavigate={(e) => {
        onNavigate?.(e);
        if (!isDirty()) return;
        // 確かめる間は移らない（Next 16.4.2 で preventDefault で止まる）。続ければ確かめずに移る
        e.preventDefault();
        void confirmLeave('navigate').then((ok) => {
          if (ok) router.forcePush(href);
        });
      }}
    >
      {children}
    </Link>
  );
}
