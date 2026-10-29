import { expect, test } from '@playwright/test';
import { accessToken, rpc } from '../support/auth';
import { createScenario, createUser, sql } from '../support/db';
import { SEED_R8 } from '../support/users';

// T09a serial：最新の年度のシナリオ（festivalStart: 'latest'）と使い捨てのユーザー（createUser・grants）の補助を確かめる（画面の設計 7.2）。
// latest の年度は全年度の中で最新になるので、並行の chromium では使わない（serial でだけ）。

test('T09a 最新の年度のシナリオ：grants のユーザーで開け、そこから年度を作れ、cleanup で作った年度も消える', async ({ page, request }) => {
  const admin = await createUser({ purpose: 'admin' });
  const s = await createScenario({ festivalStart: 'latest', status: 'closed', grants: [{ userId: admin.id, role: 'admin' }], prevYear: { dataset: 'small' } });
  let created: string | undefined;
  try {
    expect(s.festivalStart).toMatch(/^2199-/);
    const [prev] = await sql<{ d: string }>(`select to_char(festival_start, 'YYYY-MM-DD') as d from public.years where id = $1`, [s.prevYearId]);
    expect(prev!.d).toMatch(/^2198-/);

    // 使い捨てのユーザーで画面からログインすると、シナリオの年度（その人の最新の年度）が開く
    await page.goto('/login/');
    const form = page.getByTestId('test-login-form');
    await form.getByLabel('メールアドレス').fill(admin.email);
    await form.getByLabel('パスワード').fill(admin.password);
    await form.getByRole('button', { name: 'テスト用ユーザーでログイン' }).click();
    await expect(page.getByTestId('current-year')).toHaveText(`${s.label}・終了`);

    // 終了した最新の年度から、新しい年度を作れる（新しい年度の1日目は 2200 年）
    const token = await accessToken(request, admin);
    const r = await rpc<{ id: string; prev_year_id: string }>(request, token, 'create_year_from', {
      p_prev_year_id: s.yearId,
      p_label: `${s.label}-next`,
      p_festival_start: '2200-10-14',
    });
    expect(r.error).toBeNull();
    created = r.data!.id;
    expect(r.data!.prev_year_id).toBe(s.yearId);
  } finally {
    await s.cleanup();
    await admin.cleanup();
  }
  // cleanup は prev_year_id でつながる年度（作った年度）と前年度も消す
  const left = await sql('select id from public.years where id = any($1::uuid[])', [[s.yearId, s.prevYearId, created].filter(Boolean)]);
  expect(left).toEqual([]);
  // seed の R8 には何もつながっていない
  expect(await sql('select id from public.years where prev_year_id = $1', [SEED_R8.yearId])).toEqual([]);
});

test('T09a createUser：確かめていないユーザーの email の identity には email_verified が付かない', async () => {
  const unverified = await createUser({ purpose: 'unverified', verified: false });
  const verified = await createUser({ purpose: 'verified' });
  try {
    const rows = await sql<{ user_id: string; v: string | null }>(
      `select user_id::text, identity_data ->> 'email_verified' as v from auth.identities where user_id = any($1::uuid[])`,
      [[unverified.id, verified.id]],
    );
    expect(Object.fromEntries(rows.map((r) => [r.user_id, r.v]))).toEqual({ [unverified.id]: null, [verified.id]: 'true' });
    expect(unverified.email).toMatch(/^e2e-unverified-[0-9a-f]{8}@example\.test$/);
  } finally {
    await unverified.cleanup();
    await verified.cleanup();
  }
  expect(await sql('select id from auth.users where id = any($1::uuid[])', [[unverified.id, verified.id]])).toEqual([]);
});

test('T09a latest は seed のユーザーにロールを付けられない', async () => {
  await expect(createScenario({ festivalStart: 'latest', roles: { admin: true } })).rejects.toThrow(/grants/);
});
