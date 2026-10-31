// ログインの保存（storageState）と、API を直接呼ぶときのトークン（画面の設計 7.2。T09a）。
// setup（e2e/setup/auth.setup.ts）が seed の admin・head・staff・viewer・rep に1回ずつログインして e2e/.auth/<user>.json に保存し、
// 各テストは `test.use({ storageState: storageStateFor('admin') })` で使う。
// ログアウトを試すテストは storageState を使わない（画面からログインし直すか、createUser のユーザーで行う。7.2）。
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import type { APIRequestContext } from '@playwright/test';
import { SUPABASE_PUBLISHABLE_KEY, SUPABASE_URL } from '../helpers';
import { TEST_PASSWORD, USERS, type SeedUser } from './users';

/**
 * storageState を保存する seed のユーザー（outsider は保存しない。ログイン後の画面が「招待されていません」だけのため）。
 * head（総務部門長）は T15b で足した。総務副部門長は seed にいないので、使い捨てのユーザーで画面からログインする（D-36）
 */
export const STORED_USERS = ['admin', 'head', 'staff', 'viewer', 'rep'] as const;
export type StoredUser = (typeof STORED_USERS)[number];

const AUTH_DIR = fileURLToPath(new URL('../.auth/', import.meta.url));

/** e2e/.auth/<user>.json（git に入れない） */
export function storageStateFor(user: StoredUser): string {
  return path.join(AUTH_DIR, `${user}.json`);
}

/** パスワードでログインしてアクセストークンを得る（API を直接呼ぶテスト用。publishable キーだけを使う） */
export async function accessToken(request: APIRequestContext, user: SeedUser | { email: string; password: string }): Promise<string> {
  const cred = typeof user === 'string' ? { email: USERS[user], password: TEST_PASSWORD } : user;
  const res = await request.post(`${SUPABASE_URL}/auth/v1/token?grant_type=password`, {
    headers: { apikey: SUPABASE_PUBLISHABLE_KEY },
    data: cred,
  });
  if (!res.ok()) throw new Error(`ログインできません（${res.status()}）`);
  const body = (await res.json()) as { access_token: string };
  return body.access_token;
}

/** PostgREST の応答（supabase-js の { data, error, status } と同じ中身） */
export interface RestResult<T> {
  status: number;
  data: T | null;
  /** 失敗のときの本文（{ code, message, details, hint }。supabase-js の error と同じ形） */
  error: { code?: string; message?: string; details?: string | null; hint?: string | null } | null;
}

async function toResult<T>(res: Awaited<ReturnType<APIRequestContext['get']>>): Promise<RestResult<T>> {
  const text = await res.text();
  const body: unknown = text ? JSON.parse(text) : null;
  return res.ok() ? { status: res.status(), data: body as T, error: null } : { status: res.status(), data: null, error: body as RestResult<T>['error'] };
}

const headers = (token: string | null) => ({
  apikey: SUPABASE_PUBLISHABLE_KEY,
  ...(token ? { Authorization: `Bearer ${token}` } : {}),
});

/** GET /rest/v1/<path>（例：`requests?select=group_id&group_id=eq.<id>`） */
export async function restGet<T = unknown[]>(request: APIRequestContext, token: string | null, query: string): Promise<RestResult<T>> {
  return toResult<T>(await request.get(`${SUPABASE_URL}/rest/v1/${query}`, { headers: headers(token) }));
}

/** POST /rest/v1/rpc/<name>（supabase.rpc と同じ） */
export async function rpc<T = unknown>(request: APIRequestContext, token: string | null, name: string, args: Record<string, unknown>): Promise<RestResult<T>> {
  return toResult<T>(await request.post(`${SUPABASE_URL}/rest/v1/rpc/${name}`, { headers: headers(token), data: args }));
}

/** POST /rest/v1/<table>（直接の insert。supabase.from(table).insert と同じ） */
export async function restPost<T = unknown>(request: APIRequestContext, token: string | null, table: string, body: unknown): Promise<RestResult<T>> {
  return toResult<T>(
    await request.post(`${SUPABASE_URL}/rest/v1/${table}`, { headers: { ...headers(token), Prefer: 'return=representation' }, data: body }),
  );
}
