'use client';

// 在庫の画面（/stock・/stocks・/stocks/qr）で使う小さな部品と、開いている年度・立場の取り出し（T10）。
// 2つ目の画面が要るまでは components/common に移さない（画面の設計 1.2。T09a の申し送り）。
import { Ban } from 'lucide-react';
import { useSyncExternalStore } from 'react';
import { Badge } from '@/components/ui/badge';
import { useAuth } from '@/lib/auth/auth-provider';
import type { AppRole, Membership, YearSummary } from '@/lib/auth/membership';
import { formatShortDateTime } from '@/lib/datetime';
import type { CountedInfo } from '@/lib/data/stocks';
import { cn } from '@/lib/utils';

export interface OpenYear {
  membership: Membership;
  year: YearSummary;
  role: AppRole | null;
  userId: string;
}

/** 開いている年度と立場（RequireAudience の中で使う。立場が読めていなければ null） */
export function useOpenYear(): OpenYear | null {
  const { membership, session } = useAuth();
  if (membership.status !== 'ready' || session.status !== 'signedIn') return null;
  const m = membership.membership;
  if (!m.year) return null;
  return { membership: m, year: m.year, role: m.role, userId: session.session.user.id };
}

/** 数えた人の名前（読めなければ「名前を表示できません」。RLS で読めない人・消えた人） */
export const UNKNOWN_NAME = '名前を表示できません';

export function countedName(info: CountedInfo, names: ReadonlyMap<string, string> | undefined): string {
  return knownName(info, names) ?? UNKNOWN_NAME;
}

/** 数えた人の名前（読めなければ null。文の中で「○○さんが」と「ほかの人が…（名前は表示できません）」を分けるとき） */
export function knownName(info: CountedInfo, names: ReadonlyMap<string, string> | undefined): string | null {
  return (info.countedBy && names?.get(info.countedBy)) || null;
}

/** 「数えた（10/5 18:01・山田）」か「まだ」 */
export function CountedLabel({
  info,
  names,
  className,
}: {
  info: CountedInfo | null | undefined;
  names: ReadonlyMap<string, string> | undefined;
  className?: string;
}) {
  if (!info) {
    return (
      <span data-testid="counted-label" data-counted="false" className={cn('text-amber-700', className)}>
        まだ
      </span>
    );
  }
  return (
    <span data-testid="counted-label" data-counted="true" className={cn('text-muted-foreground', className)}>
      数えた（{formatShortDateTime(info.countedAt)}・{countedName(info, names)}）
    </span>
  );
}

/** 使用不可の印（灰色の帯・バッジ） */
export function UnusableBadge({ className }: { className?: string }) {
  return (
    <Badge variant="outline" data-testid="unusable-badge" className={cn('border-zinc-400 bg-zinc-100 text-zinc-700', className)}>
      <Ban aria-hidden />
      使用不可
    </Badge>
  );
}

const subscribeNothing = () => () => {};

/** ブラウザの location.origin（プリレンダーの間は空文字。描画の中で location を読まない。設計 1.9） */
export function useOrigin(): string {
  return useSyncExternalStore(
    subscribeNothing,
    () => window.location.origin,
    () => '',
  );
}
