// テスト専用：AuthProvider を Supabase なしで動かす偽物（段 C の部品のテスト。アプリのコードから import しない）。
// テストのファイルで次のように差し替える（vi.mock は巻き上げられるので、factory の中で import する）：
//   vi.mock('@/lib/supabase/client', async () => (await import('@/lib/testing/fake-auth')).supabaseClientModule);
//   vi.mock('@/lib/auth/load-membership', async () => (await import('@/lib/testing/fake-auth')).loadMembershipModule);
// このファイルはアプリの部品を import しない（差し替える側の factory から読むので、循環して止まる）。包む部品は ./providers.tsx。
import { vi } from 'vitest';
import type { MembershipSource } from '@/lib/auth/membership';

type Listener = (event: string, session: unknown) => void;

interface Deferred {
  userId: string;
  resolve: (s: MembershipSource) => void;
  reject: (e: unknown) => void;
}

/** 偽の supabase.auth と、立場の読み込み（手で応答を返す） */
export const fakeAuth = {
  session: null as { user: { id: string } } | null,
  listeners: new Set<Listener>(),
  /** 読み込みの要求（resolveLoad・rejectLoad で返す） */
  pending: [] as Deferred[],
  /** 真なら要求をすぐに sources[userId] で返す */
  autoResolve: true,
  sources: {} as Record<string, MembershipSource>,
  signOut: vi.fn(async (opts?: { scope?: string }) => {
    void opts;
    fakeAuth.setUser(null);
    return { error: null };
  }),
  refreshSession: vi.fn(async () => ({ data: { session: null }, error: { message: 'expired' } as unknown })),

  reset() {
    this.session = null;
    this.listeners.clear();
    this.pending = [];
    this.autoResolve = true;
    this.sources = {};
    this.signOut.mockClear();
    this.refreshSession.mockClear();
  },
  /** ログインしている利用者を変える（null でログアウト）。onAuthStateChange に知らせる */
  setUser(userId: string | null) {
    this.session = userId ? { user: { id: userId } } : null;
    for (const l of this.listeners) l(userId ? 'SIGNED_IN' : 'SIGNED_OUT', this.session);
  },
  resolveLoad(source?: MembershipSource) {
    const d = this.pending.shift();
    if (!d) throw new Error('読み込みの要求がない');
    d.resolve(source ?? this.sources[d.userId]!);
  },
  rejectLoad(e: unknown = new Error('network')) {
    const d = this.pending.shift();
    if (!d) throw new Error('読み込みの要求がない');
    d.reject(e);
  },
};

export const supabaseClientModule = {
  supabaseConfigError: () => null,
  getSupabase: () => ({
    auth: {
      getSession: async () => ({ data: { session: fakeAuth.session } }),
      onAuthStateChange: (cb: Listener) => {
        fakeAuth.listeners.add(cb);
        return { data: { subscription: { unsubscribe: () => fakeAuth.listeners.delete(cb) } } };
      },
      signOut: fakeAuth.signOut,
      refreshSession: fakeAuth.refreshSession,
    },
  }),
};

export const loadMembershipModule = {
  loadMembershipSource: (_client: unknown, userId: string) =>
    new Promise<MembershipSource>((resolve, reject) => {
      if (fakeAuth.autoResolve && fakeAuth.sources[userId]) resolve(fakeAuth.sources[userId]);
      else fakeAuth.pending.push({ userId, resolve, reject });
    }),
};

/** 1つの年度（または複数）でロールを持つ立場の元 */
export function sourceOf(opts: {
  displayName?: string;
  years?: MembershipSource['years'];
  roles?: MembershipSource['roles'];
  groups?: MembershipSource['groups'];
}): MembershipSource {
  return {
    displayName: opts.displayName ?? 'テスト',
    years: opts.years ?? [{ id: 'y8', label: 'R8', status: 'requesting', festival_start: '2026-10-17' }],
    roles: opts.roles ?? [{ year_id: 'y8', role: 'admin' }],
    groups: opts.groups ?? [],
  };
}
