'use client';

import { QueryClientProvider } from '@tanstack/react-query';
import { useState } from 'react';
import { UnsavedChangesProvider } from '@/components/common/unsaved-changes-guard';
import { Toaster } from '@/components/ui/sonner';
import { TooltipProvider } from '@/components/ui/tooltip';
import { AuthProvider } from '@/lib/auth/auth-provider';
import { createQueryClient } from '@/lib/query';

/**
 * アプリ全体の Provider（画面の設計 1.3・1.7。T09a）。QueryClient は1つだけ作る（AuthProvider がログアウト・利用者の切り替えで消す）。
 * 並び：QueryClient → AuthProvider（キャッシュを消すため QueryClient の中）→ 未保存の入力の守り → 画面。
 */
export function Providers({ children }: { children: React.ReactNode }) {
  const [queryClient] = useState(createQueryClient);
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
