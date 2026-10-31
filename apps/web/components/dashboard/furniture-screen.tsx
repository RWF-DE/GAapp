'use client';

// 机椅子の状況 /furniture（04「机椅子の状況」。T16）。開いている年度の机椅子の Dashboard（components/dashboard/dashboard.tsx。
// T16 より前の / のダッシュボードの中身。D-51）を出す。立場の一覧と代表する団体は出さない（ダッシュボード〔/〕に出す）。
import { useMemo } from 'react';
import { LoadingState } from '@/components/states';
import { useAuth } from '@/lib/auth/auth-provider';
import { audiencesOf } from '@/lib/auth/membership';
import { Dashboard } from './dashboard';

export function FurnitureScreen() {
  const { membership } = useAuth();
  const m = membership.status === 'ready' ? membership.membership : null;
  // 立場が変わらない間は同じ配列にする（Dashboard の集計の useMemo を描画のたびにやり直さない）
  const audiences = useMemo(() => (m ? audiencesOf(m) : []), [m]);
  if (!m?.year) return <LoadingState />; // AppShell が読み込み中・未招待を出す
  return (
    <div className="mx-auto max-w-6xl">
      <Dashboard yearId={m.year.id} audiences={audiences} />
    </div>
  );
}
