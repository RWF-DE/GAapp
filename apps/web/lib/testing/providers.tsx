// テスト専用：app/layout.tsx の Providers と同じ並び（Toaster は除く）で包む。
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { UnsavedChangesProvider } from '@/components/common/unsaved-changes-guard';
import { AuthProvider } from '@/lib/auth/auth-provider';

/** QueryClient・AuthProvider・未保存の入力の守りで包む（app/layout.tsx の Providers と同じ並び。Toaster は除く） */
export function TestProviders({ children, queryClient }: { children: React.ReactNode; queryClient?: QueryClient }) {
  const qc = queryClient ?? new QueryClient({ defaultOptions: { queries: { retry: false } } });
  return (
    <QueryClientProvider client={qc}>
      <AuthProvider>
        <UnsavedChangesProvider>{children}</UnsavedChangesProvider>
      </AuthProvider>
    </QueryClientProvider>
  );
}
