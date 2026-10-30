'use client';

// 今の立場（開いている年度の立場と状態）で、そのページを開けるか（画面の設計 1.1。T09a）。
import { useCallback } from 'react';
import { useAuth } from '@/lib/auth/auth-provider';
import { audiencesOf } from '@/lib/auth/membership';
import { canOpen } from '@/lib/navigation';

/**
 * @example
 * const canOpen = useCanOpen();
 * {canOpen('/swaps') ? <AppLink href="/swaps">{n} 件</AppLink> : <span>{n} 件</span>}
 */
export function useCanOpen(): (href: string) => boolean {
  const { membership } = useAuth();
  const m = membership.status === 'ready' ? membership.membership : null;
  return useCallback((href: string) => (m ? canOpen(href, audiencesOf(m), m.year?.status) : false), [m]);
}
