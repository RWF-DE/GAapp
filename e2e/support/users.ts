// seed のテストユーザー（supabase/seed.sql。ローカル専用。パスワードは秘密ではない）の id とメール（T09a）。
// メールとパスワードは T04 の e2e/helpers.ts と同じものを使う。
import { TEST_PASSWORD, USERS } from '../helpers';

export { TEST_PASSWORD, USERS };
export type SeedUser = keyof typeof USERS;

/** seed のユーザーの id（seed.sql の固定の id） */
export const SEED_USER_IDS = {
  admin: '00000000-0000-4000-8000-000000000001',
  staff: '00000000-0000-4000-8000-000000000002',
  rep: '00000000-0000-4000-8000-000000000003',
  viewer: '00000000-0000-4000-8000-000000000004',
  outsider: '00000000-0000-4000-8000-000000000005',
} as const satisfies Record<SeedUser, string>;

/** seed の R8 の年度と団体（固定の id） */
export const SEED_R8 = {
  yearId: '00000000-0000-4000-8000-0000000000a1',
  label: 'R8',
  groupId: '00000000-0000-4000-8000-0000000000b1',
  groupName: 'テスト団体',
} as const;
