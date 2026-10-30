// db-setup（画面の設計 7.2。T09a）：並行のテストを始める前に1回だけ流す。
// 1. 前の実行の残り物（E2E- の年度、serial のテスト用の行、e2e- のユーザー）を消す。
// 2. 年度をまたぐ表（全データセットの場所と距離の上書き）を名前で入れ、属性がデータセットと同じかを確かめる（違えば止まる）。
// 3. この時点の場所の一覧を e2e/.cache/global-rooms.json に書く（数を確かめるテストの期待値の元。並行のテストの間は変わらない）。
import { mkdirSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { test as setup } from '@playwright/test';
import { cleanupLeftovers, ensureGlobalTables } from '../support/db';
import { GLOBAL_ROOMS_FILE } from '../support/global-rooms';

setup('年度をまたぐ表を入れる', async () => {
  const removed = await cleanupLeftovers();
  if (removed.years + removed.rooms + removed.items + removed.users > 0) {
    console.warn(
      `[db-setup] 前の実行の残り物を消しました：年度 ${removed.years}・場所 ${removed.rooms}・品目 ${removed.items}・ユーザー ${removed.users}`,
    );
  }
  const rooms = await ensureGlobalTables();
  mkdirSync(path.dirname(GLOBAL_ROOMS_FILE), { recursive: true });
  writeFileSync(GLOBAL_ROOMS_FILE, JSON.stringify({ writtenAt: new Date().toISOString(), rooms }, null, 2) + '\n');
});
