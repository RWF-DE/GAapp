'use client';

import Link from 'next/link';
import { useCanOpen } from '@/lib/navigation/can-open';
import { useGuardedRouter } from '@/lib/navigation/guarded-router';
import { useUnsavedChangesApi } from '@/lib/unsaved-changes';

export type AppLinkProps = Omit<React.ComponentProps<typeof Link>, 'href'> & {
  /** アプリの中のパス（basePath と末尾の / は Next.js が付ける。例 `/stock?room=…`） */
  href: string;
  /**
   * 開けない立場のときに出すもの。既定は children を、リンクの見た目のない文字（className もほかの属性も付けない `<span>`）で
   * 出す。null を渡すと何も出さない。開けないときに文字の形（字体・余白・行のレイアウトなど）が要るなら、ここで渡すか、
   * AppLink の外側の要素に付ける（className はリンクの見た目として扱い、開けないときには付けない）
   */
  fallback?: React.ReactNode;
};

/**
 * アプリの中のリンク（画面の設計 1.1・1.4。T09a）。
 * - 今の立場で行き先を開けなければ（canOpen が偽）、リンクにせず文字だけを出す（権限なしの画面に飛ばさない）。className は
 *   リンクの見た目（下線・色など）なので付けない（付けると、押せない文字がリンクに見える。T18 の撮影で見つけた。マージの後の直し）。
 *   呼ぶ側が fallback を渡せば、それを出す。
 * - 未保存の入力があれば、移る前に確かめる（やめれば移らない）。
 *
 * @example
 * <AppLink href={`/rules?code=${code}`} className="underline">{code}</AppLink>   // staff には下線のない文字だけ
 * <span className="font-mono"><AppLink href={`/rules?code=${code}`} className="underline">{code}</AppLink></span> // 字体は外側に
 */
export function AppLink({ href, fallback, children, className, onNavigate, ...rest }: AppLinkProps) {
  const canOpen = useCanOpen();
  const router = useGuardedRouter();
  const { isDirty, confirmLeave } = useUnsavedChangesApi();
  if (!canOpen(href)) {
    return fallback !== undefined ? <>{fallback}</> : <span>{children}</span>;
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
