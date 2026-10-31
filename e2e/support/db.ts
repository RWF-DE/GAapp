// E2E のためのローカル専用の DB の補助（画面の設計 7.2、D-36。T09a）。アプリとビルドには入らない。
// ローカルの DB（DB_URL。127.0.0.1・localhost 以外なら例外）に pg で postgres としてつなぎ、テストごとに年度を作る。
// 年度の表だけに書く（rooms・items・distance_overrides は db-setup が1回だけ入れる。シナリオは名前で id を引く）。
// publishable キー以外の Supabase の鍵は使わない。
import { randomUUID } from 'node:crypto';
import { test } from '@playwright/test';
import pg from 'pg';
import { localDbUrl } from '../../scripts/local-supabase-env.mjs';
import {
  dataset,
  datasetItemCodes,
  globalDistanceOverrides,
  globalRooms,
  roomAttributeDiff,
  syntheticReference,
  type DatasetName,
} from './datasets';
import { likePrefix } from './like';
import { buildScenarioRows, type DbItem, type DbRoom, type ExtraGroup, type ScenarioRows } from './scenario-rows';
import { SEED_USER_IDS, TEST_PASSWORD } from './users';

export type YearStatus = 'preparing' | 'requesting' | 'allocating' | 'confirmed' | 'closed';
/** ロール（app_role。02「列挙型」の順。head・deputy_head は T15） */
export type AppRole = 'admin' | 'head' | 'deputy_head' | 'staff' | 'viewer';
/** 団体代表の立場（group_role。店長・副店長。T15） */
export type GroupRole = 'manager' | 'deputy_manager';

let pool: pg.Pool | null = null;

/** ローカルの DB の接続（プロセスに1つ。使っていなければプロセスの終わりを止めない） */
export function db(): pg.Pool {
  pool ??= new pg.Pool({ connectionString: localDbUrl(), max: 4, allowExitOnIdle: true });
  return pool;
}

/** 1回の SQL（テストの中で受付期間を過去にするなど） */
export async function sql<T extends pg.QueryResultRow = pg.QueryResultRow>(text: string, params: unknown[] = []): Promise<T[]> {
  const r = await db().query<T>(text, params);
  return r.rows;
}

/** トランザクションの中で fn を流す（失敗したら rollback） */
export async function withTx<T>(fn: (c: pg.PoolClient) => Promise<T>): Promise<T> {
  const c = await db().connect();
  try {
    await c.query('begin');
    const out = await fn(c);
    await c.query('commit');
    return out;
  } catch (e) {
    await c.query('rollback').catch(() => undefined);
    throw e;
  } finally {
    c.release();
  }
}

/** JSON の配列を jsonb_to_recordset で入れる（行が多くても引数の数の上限に当たらない） */
async function insertRows(c: pg.PoolClient, table: string, columns: Record<string, string>, rows: readonly object[]): Promise<void> {
  if (rows.length === 0) return;
  const cols = Object.keys(columns);
  const def = cols.map((k) => `${k} ${columns[k]}`).join(', ');
  await c.query(
    `insert into public.${table} (${cols.join(', ')}) select ${cols.join(', ')} from jsonb_to_recordset($1::jsonb) as x(${def})`,
    [JSON.stringify(rows)],
  );
}

/** いま流れている Playwright のプロジェクトの名前（テストの外なら null） */
function currentProject(): string | null {
  try {
    return test.info().project.name;
  } catch {
    return null;
  }
}

function shortId(): string {
  let base = '';
  try {
    base = test.info().testId.replace(/[^a-zA-Z0-9]/g, '').slice(0, 8);
  } catch {
    // テストの外（setup など）
  }
  return `${base || randomUUID().slice(0, 8)}-${randomUUID().slice(0, 4)}`;
}

/** 年度をまたぐ表（場所・品目）の今の行 */
export async function globalTables(c: Pick<pg.PoolClient, 'query'> = db()): Promise<{ rooms: DbRoom[]; items: DbItem[] }> {
  const rooms = (await c.query<DbRoom>('select id, name from public.rooms order by sort_order, name, id')).rows;
  const items = (await c.query<DbItem>('select id, code from public.items order by sort_order, code')).rows;
  return { rooms, items };
}

export interface CreateScenarioOptions {
  /** 既定 requesting（受付期間は開いている） */
  status?: YearStatus;
  requestWindow?: 'open' | 'closed' | 'not-yet';
  /** 既定 small */
  dataset?: DatasetName;
  /** 既定 dataset。none はルールを入れない */
  rules?: 'dataset' | 'none';
  /** reference は r8like の reference/allocations.csv を auto の行として入れる（synthetic だけ） */
  allocations?: 'none' | 'reference';
  extraGroups?: ExtraGroup[];
  /** 前年度を作って prev_year_id でつなぐ */
  prevYear?: { dataset: 'small' | 'synthetic'; status?: YearStatus };
  /** 場所の名前 → 今年の使用 */
  usable?: Record<string, boolean>;
  /** seed のテストユーザーに、この年度のロールを付ける（head は seed の総務部門長。T15b） */
  roles?: { admin?: boolean; head?: boolean; staff?: boolean; viewer?: boolean };
  /** seed の団体代表（rep）を、この年度のこの団体の代表（店長）にする */
  repGroup?: string;
  /** createUser のユーザーに、この年度のロールを付ける */
  grants?: { userId: string; role: AppRole }[];
  /**
   * createUser のユーザーを、この年度の団体（名前）の店長・副店長にする（既定は店長。T15b）。部門のロール（head・deputy_head・staff）を
   * grants で付けた人は、同じ年度の団体代表にできない（兼任の禁止のトリガーが role_overlap で止める。D-49）
   */
  groupMembers?: { userId: string; group: string; role?: GroupRole }[];
  /** 既定 before-seed（2001 年。前年度は 2000 年）。latest は seed の R8 より後（2199 年。serial でだけ） */
  festivalStart?: 'before-seed' | 'latest';
  /** cleanup しない（手での確かめの年度。年度名は MANUAL- で始める） */
  keep?: boolean;
}

export interface Scenario {
  yearId: string;
  label: string;
  /** 1日目（YYYY-MM-DD） */
  festivalStart: string;
  prevYearId?: string;
  prevLabel?: string;
  /** 名前 → id（groups・rooms・items・rules。前年度の id は prevIds） */
  ids: ScenarioRows['ids'];
  prevIds?: ScenarioRows['ids'];
  cleanup(): Promise<void>;
}

function requestWindow(w: CreateScenarioOptions['requestWindow']): [string, string] {
  switch (w ?? 'open') {
    case 'open':
      return ["now() - interval '1 day'", "now() + interval '30 days'"];
    case 'closed':
      return ["now() - interval '30 days'", "now() - interval '1 day'"];
    case 'not-yet':
      return ["now() + interval '1 day'", "now() + interval '30 days'"];
  }
}

/** latest の1日目：2199 年の中で、今ある年度より後の日（2199-01-01 から） */
async function latestFestivalStart(c: pg.PoolClient, year: 2198 | 2199): Promise<string> {
  const r = await c.query<{ d: string }>(
    `select to_char(coalesce(max(festival_start) + 1, make_date($1, 1, 1)), 'YYYY-MM-DD') as d
     from public.years where festival_start between make_date($1, 1, 1) and make_date($1, 12, 31)`,
    [year],
  );
  return r.rows[0]!.d;
}

async function insertYear(
  c: pg.PoolClient,
  o: { label: string; festivalStart: string; window: CreateScenarioOptions['requestWindow']; prevYearId: string | null },
): Promise<string> {
  const [open, close] = requestWindow(o.window);
  const r = await c.query<{ id: string }>(
    `insert into public.years (label, festival_start, status, request_open_at, request_close_at, prev_year_id)
     values ($1, $2::date, 'allocating', ${open}, ${close}, $3) returning id`,
    [o.label, o.festivalStart, o.prevYearId],
  );
  return r.rows[0]!.id;
}

async function insertScenarioRows(c: pg.PoolClient, rows: ScenarioRows): Promise<void> {
  await insertRows(c, 'room_years', { year_id: 'uuid', room_id: 'uuid', usable: 'boolean', note: 'text' }, rows.roomYears);
  await insertRows(
    c,
    'groups',
    {
      id: 'uuid',
      year_id: 'uuid',
      name: 'text',
      display_name: 'text',
      aliases: 'text[]',
      category: 'public.group_category',
      is_food: 'boolean',
      location_room_id: 'uuid',
      sort_order: 'integer',
    },
    rows.groups,
  );
  await insertRows(c, 'request_submissions', { group_id: 'uuid', submitted_at: 'timestamptz', note: 'text' }, rows.submissions);
  await insertRows(c, 'requests', { group_id: 'uuid', item_id: 'uuid', count: 'integer' }, rows.requests);
  await insertRows(
    c,
    'stocks',
    { year_id: 'uuid', room_id: 'uuid', item_id: 'uuid', count: 'integer', counted_at: 'timestamptz' },
    rows.stocks,
  );
  await insertRows(
    c,
    'rules',
    { id: 'uuid', year_id: 'uuid', code: 'text', kind: 'public.rule_kind', params: 'jsonb', enabled: 'boolean', memo: 'text' },
    rows.rules,
  );
  await insertRows(
    c,
    'substitution_consents',
    { group_id: 'uuid', from_item_id: 'uuid', to_item_id: 'uuid', status: 'public.consent_status', count: 'integer' },
    rows.consents,
  );
  await insertRows(
    c,
    'allocations',
    {
      id: 'uuid',
      year_id: 'uuid',
      source_room_id: 'uuid',
      group_id: 'uuid',
      item_id: 'uuid',
      requested_item_id: 'uuid',
      count: 'integer',
      is_keep: 'boolean',
      pinned: 'boolean',
      origin: 'public.alloc_origin',
      note: 'text',
    },
    rows.allocations,
  );
}

/**
 * テストごとの年度（シナリオの年度）を作る。年度を allocating（受付期間つき）で作ってデータと振り分けの行を入れてから、
 * 最後に status を目的の状態にする（確定中の守りのトリガーが書き込みを止めるため）。
 *
 * @example
 * const s = await createScenario({ status: 'allocating', roles: { admin: true } });
 * try { await pinYear(page, SEED_USER_IDS.admin, s.yearId); … } finally { await s.cleanup(); }
 */
export async function createScenario(opts: CreateScenarioOptions = {}): Promise<Scenario> {
  const latest = opts.festivalStart === 'latest';
  if (latest) {
    if (currentProject() !== 'serial') {
      throw new Error("festivalStart: 'latest' は serial のプロジェクトでだけ使えます（ほかのテストの最新の年度が変わるため）");
    }
    if (opts.roles || opts.repGroup) {
      throw new Error("festivalStart: 'latest' では seed のユーザーにロールを付けません。grants で createUser のユーザーに付けてください");
    }
  }
  const ds = opts.dataset ?? 'small';
  if ((opts.allocations ?? 'none') === 'reference' && ds !== 'synthetic') {
    throw new Error("allocations: 'reference' は dataset: 'synthetic' のときだけ使えます");
  }
  const status = opts.status ?? 'requesting';
  const label = `${opts.keep ? 'MANUAL' : 'E2E'}-${shortId()}`;

  const made = await withTx(async (c) => {
    const { rooms, items } = await globalTables(c);
    const countedAt = new Date().toISOString();
    let prev: { id: string; label: string; rows: ScenarioRows; status: YearStatus } | undefined;
    if (opts.prevYear) {
      const prevLabel = `${label}-prev`;
      const prevStart = latest ? await latestFestivalStart(c, 2198) : '2000-10-14';
      const id = await insertYear(c, { label: prevLabel, festivalStart: prevStart, window: 'closed', prevYearId: null });
      const rows = buildScenarioRows({
        yearId: id,
        fx: dataset(opts.prevYear.dataset),
        rooms,
        items,
        newId: randomUUID,
        countedAt,
      });
      await insertScenarioRows(c, rows);
      prev = { id, label: prevLabel, rows, status: opts.prevYear.status ?? 'closed' };
    }
    const festivalStart = latest ? await latestFestivalStart(c, 2199) : '2001-10-13';
    const yearId = await insertYear(c, { label, festivalStart, window: opts.requestWindow, prevYearId: prev?.id ?? null });
    const rows = buildScenarioRows({
      yearId,
      fx: dataset(ds),
      rooms,
      items,
      rules: opts.rules,
      allocations: opts.allocations,
      reference: opts.allocations === 'reference' ? syntheticReference() : undefined,
      extraGroups: opts.extraGroups,
      usable: opts.usable,
      newId: randomUUID,
      countedAt,
    });
    await insertScenarioRows(c, rows);

    const roles: { user_id: string; role: AppRole }[] = [];
    for (const r of ['admin', 'head', 'staff', 'viewer'] as const) if (opts.roles?.[r]) roles.push({ user_id: SEED_USER_IDS[r], role: r });
    for (const g of opts.grants ?? []) roles.push({ user_id: g.userId, role: g.role });
    await insertRows(
      c,
      'year_roles',
      { year_id: 'uuid', user_id: 'uuid', role: 'public.app_role' },
      roles.map((r) => ({ year_id: yearId, ...r })),
    );
    if (opts.repGroup) {
      const gid = rows.ids.groups[opts.repGroup];
      if (!gid) throw new Error(`repGroup の団体「${opts.repGroup}」がシナリオにありません`);
      await c.query('insert into public.group_members (group_id, user_id) values ($1, $2)', [gid, SEED_USER_IDS.rep]);
    }
    for (const m of opts.groupMembers ?? []) {
      const gid = rows.ids.groups[m.group];
      if (!gid) throw new Error(`groupMembers の団体「${m.group}」がシナリオにありません`);
      await c.query('insert into public.group_members (group_id, user_id, role) values ($1, $2, $3::public.group_role)', [
        gid,
        m.userId,
        m.role ?? 'manager',
      ]);
    }

    if (prev && prev.status !== 'allocating') await c.query('update public.years set status = $2 where id = $1', [prev.id, prev.status]);
    if (status !== 'allocating') await c.query('update public.years set status = $2 where id = $1', [yearId, status]);
    return { yearId, festivalStart, rows, prev };
  });

  const ids = [made.yearId, ...(made.prev ? [made.prev.id] : [])];
  return {
    yearId: made.yearId,
    label,
    festivalStart: made.festivalStart,
    ...(made.prev ? { prevYearId: made.prev.id, prevLabel: made.prev.label, prevIds: made.prev.rows.ids } : {}),
    ids: made.rows.ids,
    cleanup: async () => {
      if (!opts.keep) await deleteYears(ids);
    },
  };
}

/**
 * 年度を消す（prev_year_id でその年度につながる年度〔create_year_from で作った年度〕も消す）。
 * 確定中の守りが連鎖削除を止めないように、先に allocating に戻す。
 */
export async function deleteYears(yearIds: readonly string[]): Promise<void> {
  if (yearIds.length === 0) return;
  await withTx(async (c) => {
    const chain = `with recursive chain as (
        select id from public.years where id = any($1::uuid[])
        union select y.id from public.years y join chain on y.prev_year_id = chain.id)
      select id from chain`;
    const ids = (await c.query<{ id: string }>(chain, [yearIds])).rows.map((r) => r.id);
    await c.query(`update public.years set status = 'allocating' where id = any($1::uuid[]) and status <> 'allocating'`, [ids]);
    await c.query('delete from public.years where id = any($1::uuid[])', [ids]);
  });
}

export interface TestUser {
  id: string;
  email: string;
  password: string;
  cleanup(): Promise<void>;
}

/**
 * 使い捨てのユーザー（seed と同じ形。メールは `e2e-<用途>-<id の先頭>@example.test`）。
 * verified: false なら email の identity に email_verified を付けない（招待が付かない。D-17a）。
 */
export async function createUser(opts: { purpose?: string; verified?: boolean; name?: string } = {}): Promise<TestUser> {
  const id = randomUUID();
  const purpose = (opts.purpose ?? 'user').replace(/[^a-z0-9-]/g, '');
  const email = `e2e-${purpose}-${id.slice(0, 8)}@example.test`;
  const verified = opts.verified ?? true;
  await withTx(async (c) => {
    await c.query(
      `insert into auth.users (instance_id, id, aud, role, email, encrypted_password, email_confirmed_at,
                               raw_app_meta_data, raw_user_meta_data, created_at, updated_at,
                               confirmation_token, recovery_token, email_change_token_new, email_change)
       values ('00000000-0000-0000-0000-000000000000', $1, 'authenticated', 'authenticated', $2,
               extensions.crypt($3, extensions.gen_salt('bf')), now(),
               '{"provider":"email","providers":["email"]}', jsonb_build_object('full_name', $4::text), now(), now(),
               '', '', '', '')`,
      [id, email, TEST_PASSWORD, opts.name ?? 'E2E 利用者'],
    );
    const identity: Record<string, unknown> = { sub: id, email };
    if (verified) identity.email_verified = true;
    await c.query(
      `insert into auth.identities (provider_id, user_id, identity_data, provider, last_sign_in_at, created_at, updated_at)
       values ($1::text, $2::uuid, $3::jsonb, 'email', now(), now(), now())`,
      [id, id, JSON.stringify(identity)],
    );
  });
  return {
    id,
    email,
    password: TEST_PASSWORD,
    cleanup: async () => {
      await sql('delete from auth.users where id = $1', [id]);
    },
  };
}

// ---------------------------------------------------------------- db-setup（e2e/setup/global.setup.ts）が使うもの

/** serial のテストが年度をまたぐ表に作る行の名前（場所・建物・品目の code。設計 7.2） */
export const SERIAL_NAMES = {
  roomPrefix: 'E2E-serial-',
  buildingPrefix: 'E2E-serial-棟',
  itemCodePrefix: 'e2e_serial_',
} as const;

/**
 * 前の実行の残り物を消す（ローカルの DB だけ）：年度名が E2E- で始まる年度とそれにつながる年度、serial のテスト用の名前の
 * 場所・品目・距離の上書き、createUser のユーザー（e2e- で始まる @example.test）。手での確かめの MANUAL-・manual- は残す。
 */
export async function cleanupLeftovers(): Promise<{ years: number; rooms: number; items: number; users: number }> {
  const years = (await sql<{ id: string }>(`select id from public.years where label like $1 escape '\\'`, [likePrefix('E2E-')])).map((r) => r.id);
  await deleteYears(years);
  return withTx(async (c) => {
    const roomLike = likePrefix(SERIAL_NAMES.roomPrefix);
    const itemLike = likePrefix(SERIAL_NAMES.itemCodePrefix);
    const roomIds = (await c.query<{ id: string }>(`select id from public.rooms where name like $1 escape '\\'`, [roomLike])).rows.map((r) => r.id);
    const itemIds = (await c.query<{ id: string }>(`select id from public.items where code like $1 escape '\\'`, [itemLike])).rows.map((r) => r.id);
    if (roomIds.length > 0) {
      await c.query('delete from public.allocations where source_room_id = any($1::uuid[])', [roomIds]);
      await c.query('delete from public.stocks where room_id = any($1::uuid[])', [roomIds]);
      await c.query('delete from public.room_years where room_id = any($1::uuid[])', [roomIds]);
      await c.query('update public.groups set location_room_id = null where location_room_id = any($1::uuid[])', [roomIds]);
      await c.query('delete from public.rooms where id = any($1::uuid[])', [roomIds]);
    }
    if (itemIds.length > 0) {
      await c.query('delete from public.allocations where item_id = any($1::uuid[]) or requested_item_id = any($1::uuid[])', [itemIds]);
      await c.query('delete from public.substitution_consents where from_item_id = any($1::uuid[]) or to_item_id = any($1::uuid[])', [itemIds]);
      await c.query('delete from public.requests where item_id = any($1::uuid[])', [itemIds]);
      await c.query('delete from public.stocks where item_id = any($1::uuid[])', [itemIds]);
      await c.query('delete from public.items where id = any($1::uuid[])', [itemIds]);
    }
    const buildingLike = likePrefix(SERIAL_NAMES.buildingPrefix);
    await c.query(
      `delete from public.distance_overrides
        where building_a like $1 escape '\\' or building_b like $1 escape '\\' or building_a like $2 escape '\\' or building_b like $2 escape '\\'`,
      [buildingLike, roomLike],
    );
    const users = await c.query(`delete from auth.users where email like $1 escape '\\'`, [likePrefix('e2e-', '@example.test')]);
    return { years: years.length, rooms: roomIds.length, items: itemIds.length, users: users.rowCount ?? 0 };
  });
}

/** 年度をまたぐ表の場所（global-rooms.json の1件） */
export interface GlobalRoom {
  id: string;
  name: string;
  kind: string;
  building: string | null;
  floor: number | null;
  isStorage: boolean;
  extraCost: number;
  sortOrder: number;
}

/**
 * 全データセットの場所と距離の上書きを、名前で1回だけ入れる（on conflict do nothing）。
 * 読み直して、属性がデータセットと違えば、どの場所のどの属性かを出して例外にする（黙って進めない）。
 * データセットが使う品目の code が seed になければ例外。入れた後の場所の一覧を返す。
 */
export async function ensureGlobalTables(): Promise<GlobalRoom[]> {
  return withTx(async (c) => {
    const want = globalRooms();
    await insertRowsOnConflict(
      c,
      'rooms',
      {
        name: 'text',
        kind: 'public.room_kind',
        building: 'text',
        floor: 'smallint',
        is_storage: 'boolean',
        extra_cost: 'smallint',
        sort_order: 'integer',
        aliases: 'text[]',
      },
      want.map((r) => ({
        name: r.name,
        kind: r.kind,
        building: r.building,
        floor: r.floor,
        is_storage: r.isStorage,
        extra_cost: r.extraCost,
        sort_order: r.sortOrder,
        aliases: r.aliases,
      })),
      'name',
    );
    const rooms = (
      await c.query<GlobalRoom>(
        `select id, name, kind::text as kind, building, floor, is_storage as "isStorage", extra_cost as "extraCost",
                sort_order as "sortOrder"
         from public.rooms order by sort_order, name, id`,
      )
    ).rows;
    const byName = new Map(rooms.map((r) => [r.name, r]));
    const diffs = want.flatMap((w) => {
      const got = byName.get(w.name);
      if (!got) return [`場所「${w.name}」が入っていません`];
      const d = roomAttributeDiff(w, got);
      return d.length ? [`場所「${w.name}」（データセット ≠ DB）：${d.join('、')}`] : [];
    });

    const overrides = globalDistanceOverrides();
    await insertRowsOnConflict(
      c,
      'distance_overrides',
      { building_a: 'text', building_b: 'text', cost: 'smallint' },
      overrides.map((o) => ({ building_a: o.buildingA, building_b: o.buildingB, cost: o.cost })),
      'building_a, building_b',
    );
    const dist = (await c.query<{ a: string; b: string; cost: number }>('select building_a as a, building_b as b, cost from public.distance_overrides')).rows;
    for (const o of overrides) {
      const got = dist.find((d) => (d.a === o.buildingA && d.b === o.buildingB) || (d.a === o.buildingB && d.b === o.buildingA));
      if (!got) diffs.push(`距離の上書き「${o.buildingA}・${o.buildingB}」が入っていません`);
      else if (got.cost !== o.cost) diffs.push(`距離の上書き「${o.buildingA}・${o.buildingB}」のコストが違います（データセット ${o.cost} ≠ DB ${got.cost}）`);
    }

    const codes = new Set((await c.query<{ code: string }>('select code from public.items')).rows.map((r) => r.code));
    for (const code of datasetItemCodes()) if (!codes.has(code)) diffs.push(`品目 ${code} が seed にありません`);

    if (diffs.length > 0) {
      throw new Error(
        `年度をまたぐ表がデータセットと食い違っています。次の場所の名前・属性（または距離の上書き・品目）が、DB（seed か前の実行の残り）とデータセット（e2e/support/datasets.ts の small・fixtures/synthetic/r8like）で違います。どちらかをそろえてください：\n- ${diffs.join('\n- ')}`,
      );
    }
    return rooms;
  });
}

async function insertRowsOnConflict(
  c: pg.PoolClient,
  table: string,
  columns: Record<string, string>,
  rows: readonly object[],
  conflict: string,
): Promise<void> {
  if (rows.length === 0) return;
  const cols = Object.keys(columns);
  const def = cols.map((k) => `${k} ${columns[k]}`).join(', ');
  await c.query(
    `insert into public.${table} (${cols.join(', ')}) select ${cols.join(', ')} from jsonb_to_recordset($1::jsonb) as x(${def})
     on conflict (${conflict}) do nothing`,
    [JSON.stringify(rows)],
  );
}
