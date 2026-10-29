import { expect, test } from '@playwright/test';
import { accessToken, rpc } from '../support/auth';
import { createScenario, createUser, sql } from '../support/db';
import { expectMessage } from '../support/errors';

// T09a エラーの分類（本物の DB。画面の設計 2.5）のうち、最新の年度が要るもの。
// create_year_from は最新の年度でないと not_latest で先に止まるので、details のない invalid_input は
// 最新の年度のシナリオ（festivalStart: 'latest'。serial でだけ）と grants の使い捨ての admin で起こす。

test('T09a 年度の作成：年度名が空・1日目が複製元より後でないときは details のない invalid_input（create_year_from の文言）', async ({ request }) => {
  const admin = await createUser({ purpose: 'admin' });
  const s = await createScenario({ festivalStart: 'latest', status: 'closed', grants: [{ userId: admin.id, role: 'admin' }] });
  try {
    const token = await accessToken(request, admin);
    const ctx = { rpc: 'create_year_from', prevFestivalStart: s.festivalStart };
    const expected = `年度名を入れ、1日目は今の年度（${s.festivalStart}）より後の日付にしてください`;
    const nextYear = `${Number(s.festivalStart.slice(0, 4)) + 1}${s.festivalStart.slice(4)}`;
    // 年度名が空白だけ
    const blank = expectMessage(
      await rpc(request, token, 'create_year_from', { p_prev_year_id: s.yearId, p_label: '  ', p_festival_start: nextYear }),
      'input',
      ctx,
      expected,
    );
    expect(blank.details).toBeNull();
    // 1日目が複製元の1日目と同じ（後でない）
    const sameDay = expectMessage(
      await rpc(request, token, 'create_year_from', { p_prev_year_id: s.yearId, p_label: `${s.label}-next`, p_festival_start: s.festivalStart }),
      'input',
      ctx,
      expected,
    );
    expect(sameDay.details).toBeNull();
    // どちらも年度を作っていない
    expect(await sql('select id from public.years where prev_year_id = $1', [s.yearId])).toEqual([]);
  } finally {
    await s.cleanup();
    await admin.cleanup();
  }
});
