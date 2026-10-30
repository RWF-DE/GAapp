// 画面の受け入れ（総務で確認。手で確かめる。画面の設計 7.6。T14）のデータ作り。
// pnpm e2e:manual（E2E_MANUAL=1。CI では流さない）。ローカルの Supabase に、消さない年度（keep。年度名は MANUAL- で始まる）と、
// 確かめる人ごとのユーザー（manual- で始まる @example.test。db-setup は消さない）を作り、ログインの情報を出す。
// パスワードは seed と同じローカル専用の値（秘密ではない）。本番の Supabase には向けない（DB_URL はローカルだけ。D-36）。
//
// 作るもの（MANUAL_KIND で選ぶ。既定は両方）：
// - input：受付中の年度（合成データ r8like）。部員 MANUAL_STAFF 人（既定 1）と、団体代表 MANUAL_REPS 人（既定 2）。団体代表は
//   それぞれ未提出の団体（確認用模擬店1〜）の代表。部員の在庫入力（QR から 60 秒）と、団体代表の提出（説明なし）に使う。
// - allocation：振り分け中の年度（第一セミナーは使用可）。管理者 1 人。模擬店01 の了承（机(木) → キャスター机）に合わせて、
//   第一セミナーからのキャスター机の固定の置き換えの行を1つ入れる（「了承で固定した行がその部屋にある」状態。MANUAL_PINNED=0 で入れない）。
//   計る前に、管理者が「自動振り分け」→ 保存 →「確定」まで済ませておく（計る区間はダッシュボードの「確定を解除」から）。
// 片付け：MANUAL_CLEANUP=1 pnpm e2e:manual で、MANUAL- の年度と manual- のユーザーを消す（ほかは作らない）。
import { randomUUID } from 'node:crypto';
import { mkdirSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { test } from '@playwright/test';
import { createScenario, deleteYears, sql, withTx, type AppRole } from '../support/db';
import { likePrefix } from '../support/like';
import { TEST_PASSWORD } from '../support/users';

interface ManualUser {
  id: string;
  email: string;
  label: string;
}

/** 手での確かめのユーザー（createUser と同じ形。メールは manual-<用途>-<id の先頭>@example.test。db-setup は消さない） */
async function createManualUser(purpose: string, displayName: string): Promise<ManualUser> {
  const id = randomUUID();
  const email = `manual-${purpose.replace(/[^a-z0-9-]/g, '')}-${id.slice(0, 8)}@example.test`;
  await withTx(async (c) => {
    await c.query(
      `insert into auth.users (instance_id, id, aud, role, email, encrypted_password, email_confirmed_at,
                               raw_app_meta_data, raw_user_meta_data, created_at, updated_at,
                               confirmation_token, recovery_token, email_change_token_new, email_change)
       values ('00000000-0000-0000-0000-000000000000', $1, 'authenticated', 'authenticated', $2,
               extensions.crypt($3, extensions.gen_salt('bf')), now(),
               '{"provider":"email","providers":["email"]}', jsonb_build_object('full_name', $4::text), now(), now(),
               '', '', '', '')`,
      [id, email, TEST_PASSWORD, displayName],
    );
    await c.query(
      `insert into auth.identities (provider_id, user_id, identity_data, provider, last_sign_in_at, created_at, updated_at)
       values ($1::text, $2::uuid, $3::jsonb, 'email', now(), now(), now())`,
      [id, id, JSON.stringify({ sub: id, email, email_verified: true })],
    );
  });
  return { id, email, label: displayName };
}

const count = (name: string, fallback: number) => {
  const n = Number(process.env[name] ?? fallback);
  if (!Number.isInteger(n) || n < 0 || n > 20) throw new Error(`${name} は 0〜20 の整数にしてください`);
  return n;
};

const kinds = () => {
  const k = process.env.MANUAL_KIND ?? 'input,allocation';
  const list = k.split(',').map((s) => s.trim());
  for (const x of list) if (x !== 'input' && x !== 'allocation') throw new Error(`MANUAL_KIND は input・allocation（カンマ区切り）です：${x}`);
  return list;
};

test('T14 手での確かめのデータを作る（画面の受け入れ 7.6）', async ({ baseURL }, testInfo) => {
  test.setTimeout(5 * 60_000);
  const lines: string[] = [];
  const log = (s: string) => {
    lines.push(s);
    console.log(s);
  };

  if (process.env.MANUAL_CLEANUP) {
    const years = (await sql<{ id: string }>(`select id from public.years where label like $1 escape '\\'`, [likePrefix('MANUAL-')])).map((r) => r.id);
    await deleteYears(years);
    const users = await sql<{ id: string }>(`delete from auth.users where email like $1 escape '\\' returning id`, [likePrefix('manual-', '@example.test')]);
    log(`片付けました：MANUAL- の年度 ${years.length} 件（つながる年度を含めて消した）、manual- のユーザー ${users.length} 人`);
    return;
  }

  const base = baseURL ?? 'http://localhost:3100';
  log(`アプリ：${base}/login/（テスト用ログイン。パスワードはどのユーザーも ${TEST_PASSWORD}。ローカル専用）`);

  if (kinds().includes('input')) {
    const reps = count('MANUAL_REPS', 2);
    const staffN = count('MANUAL_STAFF', 1);
    const staff: ManualUser[] = [];
    for (let i = 1; i <= staffN; i++) staff.push(await createManualUser(`staff${i}`, `確認用 部員${i}`));
    const repUsers: ManualUser[] = [];
    for (let i = 1; i <= reps; i++) repUsers.push(await createManualUser(`rep${i}`, `確認用 団体代表${i}`));
    const groupNames = repUsers.map((_, i) => `確認用模擬店${i + 1}`);
    const s = await createScenario({
      keep: true,
      dataset: 'synthetic',
      status: 'requesting',
      extraGroups: groupNames.map((name) => ({ name, category: 'stall' as const })),
      grants: staff.map((u) => ({ userId: u.id, role: 'staff' as AppRole })),
    });
    for (const [i, u] of repUsers.entries()) {
      await sql('insert into public.group_members (group_id, user_id) values ($1, $2)', [s.ids.groups[groupNames[i]!], u.id]);
    }
    log('');
    log(`■ 在庫入力・申請の年度：${s.label}（受付中。合成データ r8like）`);
    log(`  QR のカード：管理者（seed の admin など）で ${base}/stocks/qr/ を印刷し、3部屋分を使う（URL は年度によらない）`);
    for (const u of staff) log(`  部員：${u.email}（${u.label}）`);
    for (const [i, u] of repUsers.entries()) log(`  団体代表：${u.email}（${u.label}。団体「${groupNames[i]}」、未提出）`);
  }

  if (kinds().includes('allocation')) {
    const admin = await createManualUser('admin1', '確認用 管理者1');
    const pinned = process.env.MANUAL_PINNED !== '0';
    const s = await createScenario({
      keep: true,
      dataset: 'synthetic',
      status: 'allocating',
      usable: { 第一セミナー: true },
      grants: [{ userId: admin.id, role: 'admin' }],
    });
    if (pinned) {
      // 模擬店01 は r8like で机(木) → キャスター机を了承している。その置き換えを第一セミナーから1台、固定の自動の行で入れる
      const group = s.ids.groups['模擬店01']!;
      const consent = await sql<{ status: string }>(
        'select status from public.substitution_consents where group_id = $1 and from_item_id = $2 and to_item_id = $3',
        [group, s.ids.items['desk'], s.ids.items['caster_desk']],
      );
      if (consent[0]?.status !== 'accepted') throw new Error('模擬店01 の了承（机(木) → キャスター机）がありません');
      await sql(
        `insert into public.allocations (id, year_id, source_room_id, group_id, item_id, requested_item_id, count, is_keep, pinned, origin, note)
         values ($1, $2, $3, $4, $5, $6, 1, false, true, 'auto', '確認用：了承で固定した置き換え')`,
        [randomUUID(), s.yearId, s.ids.rooms['第一セミナー'], group, s.ids.items['caster_desk'], s.ids.items['desk']],
      );
    }
    log('');
    log(`■ 振り分けの年度：${s.label}（振り分け中。第一セミナーは使用可${pinned ? '。模擬店01 に第一セミナーからの了承で固定した行が1つ' : ''}）`);
    log(`  管理者：${admin.email}（${admin.label}）`);
    log('  計る前に：振り分け画面で「自動振り分け」→ 保存 →「確定」まで済ませる（計る区間はダッシュボードの「確定を解除」から）');
  }

  log('');
  log('片付け：MANUAL_CLEANUP=1 pnpm e2e:manual（MANUAL- の年度と manual- のユーザーを消す）');
  const out = path.join(testInfo.project.outputDir, 'manual-logins.txt');
  mkdirSync(path.dirname(out), { recursive: true });
  writeFileSync(out, lines.join('\n') + '\n');
  await testInfo.attach('manual-logins.txt', { body: lines.join('\n'), contentType: 'text/plain' });
});
