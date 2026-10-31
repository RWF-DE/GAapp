'use client';

import { QueryClientProvider } from '@tanstack/react-query';
import { useState } from 'react';
import { UnsavedChangesProvider } from '@/components/common/unsaved-changes-guard';
import { Toaster } from '@/components/ui/sonner';
import { TooltipProvider } from '@/components/ui/tooltip';
import { AuthProvider } from '@/lib/auth/auth-provider';
import { startEarlyLoad } from '@/lib/boot/early-load';
import { SCREEN_PREFETCH } from '@/lib/data/screen-queries';
import { createQueryClient } from '@/lib/query';

/**
 * アプリ全体の Provider（画面の設計 1.3・1.7。T09a）。QueryClient は1つだけ作る（AuthProvider がログアウト・利用者の切り替えで消す）。
 * 並び：QueryClient → AuthProvider（キャッシュを消すため QueryClient の中）→ 未保存の入力の守り → 画面。
 * ブラウザでは、最初の描画のときに立場と画面のデータの読み込みを始める（D-45。lib/boot/early-load.ts。effect を待たない）。
 */
export function Providers({ children }: { children: React.ReactNode }) {
  const [queryClient] = useState(browserQueryClient);
  return (
    <QueryClientProvider client={queryClient}>
      <AuthProvider>
        <UnsavedChangesProvider>
          <TooltipProvider delayDuration={300}>{children}</TooltipProvider>
        </UnsavedChangesProvider>
      </AuthProvider>
      <Toaster position="top-center" richColors closeButton />
    </QueryClientProvider>
  );
}

let browserClient: ReturnType<typeof createQueryClient> | null = null;

/**
 * ブラウザでは QueryClient をページに1つだけ作り、作ったときに先読みを始める（開発の StrictMode で初期化が2回呼ばれても、
 * 先読みと画面が同じキャッシュを使うように）。プリレンダーでは毎回作る。
 */
function browserQueryClient() {
  if (typeof window === 'undefined') return createQueryClient();
  if (!browserClient) {
    browserClient = createQueryClient();
    startEarlyLoad(browserClient, { routes: SCREEN_PREFETCH });
  }
  return browserClient;
}
