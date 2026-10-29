'use client';

// 立場の一覧（画面の設計 3.1。T09）。ダッシュボードとホームの両方に出す。T04 のホームと同じ要素と文字を保つ：
// `home-year` は「R8（申請受付中）」、`home-roles` は開いている年度のロールの日本語名と「{団体名} の団体代表」を1行ずつ（ほかの文字を入れない）。
// T04 の e2e/auth.spec.ts と T09a の foundation.spec が toHaveText で確かめている。
import { ROLE_LABELS, YEAR_STATUS_LABELS, type Membership } from '@/lib/auth/membership';
import { cn } from '@/lib/utils';

export function RoleSummary({ membership: m, className }: { membership: Membership; className?: string }) {
  return (
    <section aria-labelledby="home-role-summary" className={cn('rounded-lg border bg-card px-4 py-3 text-sm', className)}>
      <h2 id="home-role-summary" className="sr-only">
        あなたの立場
      </h2>
      <div className="flex flex-wrap items-baseline gap-x-6 gap-y-1">
        <p>
          <span className="text-muted-foreground">今の年度：</span>
          <span data-testid="home-year">{m.year ? `${m.year.label}（${YEAR_STATUS_LABELS[m.year.status]}）` : '—'}</span>
        </p>
        <p>
          <span className="text-muted-foreground">あなた：</span>
          {m.displayName ?? '名前未設定'} さん
        </p>
        <div className="flex min-w-0 items-baseline gap-1">
          <span className="shrink-0 text-muted-foreground">立場：</span>
          <ul className="flex min-w-0 flex-wrap gap-x-3" data-testid="home-roles">
            {m.role ? <li>{ROLE_LABELS[m.role]}</li> : null}
            {m.groups.map((g) => (
              <li key={g.id}>{g.name} の団体代表</li>
            ))}
          </ul>
        </div>
      </div>
    </section>
  );
}
