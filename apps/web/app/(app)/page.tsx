'use client';

import { useAuth } from '@/lib/auth/auth-provider';
import { ROLE_LABELS, YEAR_STATUS_LABELS } from '@/lib/auth/membership';

// ホーム。ダッシュボード（年度の状態・提出数など）は T09 でここに作る。今は、今の年度と自分の立場だけを出す。
export default function HomePage() {
  const { membership } = useAuth();
  if (membership.status !== 'ready') return null; // AppShell が読み込み中・未招待を出す
  const m = membership.membership;
  return (
    <div className="mx-auto max-w-3xl space-y-6">
      <h1 className="text-2xl font-bold">電波祭 総務 机椅子管理</h1>
      <section className="rounded-lg border p-4">
        <h2 className="text-sm font-medium text-muted-foreground">今の年度</h2>
        <p className="mt-1 text-lg" data-testid="home-year">
          {m.year ? `${m.year.label}（${YEAR_STATUS_LABELS[m.year.status]}）` : '—'}
        </p>
      </section>
      <section className="rounded-lg border p-4">
        <h2 className="text-sm font-medium text-muted-foreground">あなたの立場</h2>
        <p className="mt-1">{m.displayName ?? '名前未設定'} さん</p>
        <ul className="mt-2 list-inside list-disc text-sm" data-testid="home-roles">
          {m.role ? <li>{ROLE_LABELS[m.role]}</li> : null}
          {m.groups.map((g) => (
            <li key={g.id}>{g.name} の団体代表</li>
          ))}
        </ul>
      </section>
    </div>
  );
}
