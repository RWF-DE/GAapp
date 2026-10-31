'use client';

// 在庫の画面（/stock・/stocks・/stocks/qr）で使う小さな部品と、開いている年度・立場の取り出し（T10）。
// 2つ目の画面が要るまでは components/common に移さない（画面の設計 1.2。T09a の申し送り）。
import { Ban } from 'lucide-react';
import { useSyncExternalStore } from 'react';
import { AppLink } from '@/components/common/app-link';
import { EmptyState } from '@/components/states';
import { Badge } from '@/components/ui/badge';
import { useAuth } from '@/lib/auth/auth-provider';
import type { AppRole, Membership, YearSummary } from '@/lib/auth/membership';
import { isAdmin } from '@/lib/auth/roles';
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

/**
 * 保管場所が1つもないとき（在庫一覧・在庫入力の場所の選び方）。保管場所にする（場所の is_storage）のはマスタの変更なので、
 * 管理者にだけマスタ設定の場所へのリンクを出し、ほかの人（総務部門長・総務副部門長・総務部門員）には管理者に頼む文を出す
 * （部門長・副部門長は場所のタブを開けるが、変えられるのは今年の使用だけ。D-50）。
 */
export function NoStorageState({ role }: { role: AppRole | null }) {
  const admin = isAdmin(role);
  return (
    <EmptyState
      title="保管場所がありません"
      description={admin ? 'マスタ設定の場所で「保管場所」にしてください。' : '管理者に、保管場所の登録を頼んでください。'}
      action={
        admin ? (
          <AppLink href="/settings?tab=rooms" className="text-sm underline underline-offset-4">
            マスタ設定（場所）へ
          </AppLink>
        ) : undefined
      }
    />
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
