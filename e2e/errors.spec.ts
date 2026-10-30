import { expect, test } from '@playwright/test';
import { classifyError } from '../apps/web/lib/errors';
import { accessToken, restPost, rpc } from './support/auth';
import { createScenario, sql, type Scenario } from './support/db';
import { SMALL } from './support/datasets';
import { expectMessage } from './support/errors';
import { SEED_USER_IDS } from './support/users';

// T09a エラーの分類を本物の DB の応答で確かめる（画面の設計 2.5・7.2）。
// supabase-js の error は PostgREST の応答の本文（{ code, message, details, hint }）そのものなので、本文と status を
// apps/web/lib/errors.ts の classifyError に通し、messageFor の文言が既定（表にないときの文言）に落ちないことを見る。
// 2.5 の対象のうち、create_year_from の details のない invalid_input は最新の年度が要るので e2e/serial/errors.spec.ts で確かめる。

async function version(s: Scenario): Promise<number> {
  const [row] = await sql<{ v: number }>('select allocation_version as v from public.years where id = $1', [s.yearId]);
  return row!.v;
}

test.describe('T09a エラーの分類（本物の DB）', () => {
  let admin: string;
  let staff: string;
  let rep: string;
  test.beforeEach(async ({ request }) => {
    [admin, staff, rep] = await Promise.all([accessToken(request, 'admin'), accessToken(request, 'staff'), accessToken(request, 'rep')]);
  });

  test('T09a 年度の状態の RPC：forbidden・遷移できない・理由なし・版の食い違い・確定前の在庫超過', async ({ request }) => {
    const s = await createScenario({ status: 'allocating', roles: { admin: true, staff: true } });
    try {
      const ctx = { rpc: 'set_year_status' };
      // staff は状態を変えられない
      expectMessage(await rpc(request, staff, 'set_year_status', { p_year_id: s.yearId, p_to: 'confirmed', p_reason: 'E2E' }), 'forbidden', ctx, '権限がありません。立場が変わった可能性があります');
      // 振り分け中から申請受付中には戻れない
      expectMessage(await rpc(request, admin, 'set_year_status', { p_year_id: s.yearId, p_to: 'requesting' }), 'state', ctx, '振り分け中から申請受付中には進められません。読み直しました');
      // 確定は理由が要る
      const v = await version(s);
      expectMessage(await rpc(request, admin, 'set_year_status', { p_year_id: s.yearId, p_to: 'confirmed', p_base_version: v }), 'reason', ctx, '理由を入力してください');
      // 検証した版が古い
      expectMessage(
        await rpc(request, admin, 'set_year_status', { p_year_id: s.yearId, p_to: 'confirmed', p_reason: 'E2E', p_base_version: v - 1 }),
        'conflict',
        ctx,
        /^確定の前に入力が変わったので、検証をやり直しました/,
      );
      // 在庫を超える振り分けがあると確定できない（E001。details の id を画面の名前に置き換える）
      await sql(
        `insert into public.allocations (year_id, source_room_id, group_id, item_id, requested_item_id, count, origin)
         values ($1, $2, $3, $4, $4, 100, 'manual')`,
        [s.yearId, s.ids.rooms[SMALL.rooms.storageA], s.ids.groups[SMALL.groups.stall], s.ids.items['desk']],
      );
      const names = {
        room: (id: string) => Object.entries(s.ids.rooms).find(([, x]) => x === id)?.[0],
        item: (id: string) => (id === s.ids.items['desk'] ? '机(木)' : undefined),
      };
      expectMessage(
        await rpc(request, admin, 'set_year_status', { p_year_id: s.yearId, p_to: 'confirmed', p_reason: 'E2E', p_base_version: await version(s) }),
        'issue',
        { ...ctx, names },
        '在庫を超えます（E2E倉庫Aの机(木)：振り分け100、在庫10）',
      );
    } finally {
      await s.cleanup();
    }
  });

  test('T09a 年度とロールの RPC：最新でない年度からの作成・1日目の範囲・最後の管理者・同じ名前', async ({ request }) => {
    const s = await createScenario({ status: 'preparing', roles: { admin: true } });
    try {
      // シナリオの年度（2001 年）は seed の R8 より前なので、最新の年度ではない
      expectMessage(
        await rpc(request, admin, 'create_year_from', { p_prev_year_id: s.yearId, p_label: `${s.label}-next`, p_festival_start: '2002-10-12' }),
        'state',
        { rpc: 'create_year_from' },
        '最新の年度からだけ新しい年度を作れます',
      );
      expectMessage(
        await rpc(request, admin, 'update_year', { p_year_id: s.yearId, p_patch: { festival_start: '2300-01-01' } }),
        'input',
        { rpc: 'update_year' },
        /^1日目は、前の年度より後・次の年度より前で/,
      );
      expectMessage(
        await rpc(request, admin, 'remove_role', { p_year_id: s.yearId, p_user_id: SEED_USER_IDS.admin, p_reason: 'E2E' }),
        'state',
        { rpc: 'remove_role' },
        '最後の管理者は外せません',
      );
      // 直接の insert の一意の違反（23505）
      expectMessage(
        await restPost(request, admin, 'groups', { year_id: s.yearId, name: SMALL.groups.stall, category: 'stall' }),
        'conflict',
        {},
        '同じものがすでにあります（ほかの人が先に足した可能性があります）',
      );
    } finally {
      await s.cleanup();
    }
  });

  test('T09a 申請の RPC：受付期間の外の提出は「締切を過ぎました」', async ({ request }) => {
    const s = await createScenario({ status: 'requesting', requestWindow: 'closed', repGroup: SMALL.groups.stall });
    try {
      expectMessage(
        await rpc(request, rep, 'submit_requests', { p_group_id: s.ids.groups[SMALL.groups.stall], p_rows: [] }),
        'state',
        { rpc: 'submit_requests' },
        /^締切を過ぎました/,
      );
    } finally {
      await s.cleanup();
    }
  });

  test('T09a 取り込み：フォームのタイムスタンプが未来の日時なら invalid_input {field: submittedAt}', async ({ request }) => {
    const s = await createScenario({ status: 'requesting', requestWindow: 'closed', roles: { admin: true } });
    try {
      const groupId = s.ids.groups[SMALL.groups.stall]!;
      const future = new Date(Date.now() + 24 * 60 * 60 * 1000).toISOString();
      const r = await rpc(request, admin, 'update_requests_after_deadline', {
        p_group_id: groupId,
        p_rows: [],
        p_reason: 'E2E',
        p_submission: { submittedAt: future },
      });
      const names = { group: (id: string) => (id === groupId ? SMALL.groups.stall : undefined) };
      const e = expectMessage(
        r,
        'input',
        { rpc: 'update_requests_after_deadline', names, groupId },
        `フォームのタイムスタンプが読めないか、未来の日時です（${SMALL.groups.stall}）`,
      );
      expect(e.details).toEqual({ field: 'submittedAt' });
    } finally {
      await s.cleanup();
    }
  });

  test('T09a 自動振り分けの保存：古い版なら conflict {allocation_version}（save_auto_allocations の文言）', async ({ request }) => {
    const s = await createScenario({ status: 'allocating', roles: { admin: true } });
    try {
      const v = await version(s);
      const e = expectMessage(
        await rpc(request, admin, 'save_auto_allocations', { p_year_id: s.yearId, p_rows: [], p_mode: 'full', p_base_version: v - 1 }),
        'conflict',
        { rpc: 'save_auto_allocations' },
        '計算している間に、ほかの人が振り分け・了承・在庫・申請・ルールなどを変えました。読み直しました。もう一度実行してください',
      );
      expect(e.details).toEqual({ allocation_version: v });
    } finally {
      await s.cleanup();
    }
  });

  test('T09a 了承：団体代表が依頼の前に答えると details のない invalid_state', async ({ request }) => {
    const s = await createScenario({ status: 'allocating', repGroup: SMALL.groups.stall });
    try {
      const groupId = s.ids.groups[SMALL.groups.stall]!;
      const [from, to] = [s.ids.items['desk'], s.ids.items['caster_desk']];
      // 依頼されていない（行がないか not_asked）ことを先に確かめる
      const rows = await sql<{ status: string }>(
        'select status::text from public.substitution_consents where group_id = $1 and from_item_id = $2 and to_item_id = $3',
        [groupId, from, to],
      );
      expect(rows.filter((x) => x.status !== 'not_asked')).toEqual([]);
      const e = expectMessage(
        await rpc(request, rep, 'set_consent', { p_group_id: groupId, p_from_item: from, p_to_item: to, p_status: 'accepted' }),
        'state',
        { rpc: 'set_consent' },
        'まだ依頼されていないので回答できません。読み直しました',
      );
      expect(e.details).toBeNull();
    } finally {
      await s.cleanup();
    }
  });

  test('T09a 認証：署名を壊したトークンは PGRST301 の auth（ログインし直す）', async ({ request }) => {
    // 形は正しい JWT のまま、署名の1文字目だけを変える（末尾の文字は余りのビットだけが変わることがあるので使わない）
    const [header, payload, signature] = staff.split('.');
    expect(signature, 'アクセストークンが JWT の形ではありません').toBeTruthy();
    const tampered = `${header}.${payload}.${signature![0] === 'A' ? 'B' : 'A'}${signature!.slice(1)}`;
    const r = await rpc(request, tampered, 'set_year_status', { p_year_id: SEED_USER_IDS.admin, p_to: 'allocating' });
    expect(r.status).toBe(401);
    expect(classifyError(r.error, r.status).code).toBe('PGRST301');
    expectMessage(r, 'auth', {}, 'ログインし直してください');
  });
});
