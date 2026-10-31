// 机椅子がダッシュボード（/）に出すもの（D-52。04「机椅子の状況」の「ダッシュボードに出すもの」、notes/T16.md「固めた約束」4）。
// - 総務（soumu）：軽い読み取りだけ（loadFurnitureSoumu。6つの表を並行に）。版（years）・振り分けの行・ルール・申請の行・検証・
//   スナップショットは読まない（机椅子の重い読み込みは机椅子の状況〔/furniture〕だけ）。数え方は counts.ts（summarizeDashboard と同じ）。
// - 団体代表（rep）：自団体の提出と了承（rep.ts の furnitureRepOptions。代表する団体の欄と同じキャッシュ）。
// - 閲覧のみ（viewer）：読まない（年度の行だけ）。
// furniturePortal(raw, ctx) は純粋関数：raw が null なら年度の行だけで決まる分（fromYear）を、raw があればその種類の全部
// （fromYear の分を含む）を返す。時計を読まない（ctx.now だけ）。リンクはどれも canOpen で確かめ、開けない要対応は作らない。
// lib/data を import しない（/ の JS にスナップショット・検証・swaps.ts を入れない）。
import { queryOptions } from '@tanstack/react-query';
import { YEAR_STATUS_LABELS, type YearStatus } from '@/lib/auth/membership';
import { isAdmin, isLead, isSoumu } from '@/lib/auth/roles';
import { addDays, formatShortDateTime, tokyoStartOfDay } from '@/lib/datetime';
import { fetchAll } from '@/lib/db/fetch-all';
import type { ConsentDbRow, GroupRow, RoomRow, RoomYearRow, SubmissionRow, YearRow } from '@/lib/db/types';
import { toAppError } from '@/lib/errors';
import { canOpen } from '@/lib/navigation';
import { getSupabase, type AppSupabaseClient } from '@/lib/supabase/client';
import {
  moduleLabel,
  portalQueryKey,
  portalQueryOptions,
  type DatedItem,
  type ModuleCardModel,
  type PortalContext,
  type PortalProvider,
  type PortalSection,
  type TodoItem,
} from '../portal';
import type { ModuleId } from '../registry';
import {
  consentGroupCounts,
  storageCounts,
  submissionCounts,
  type ConsentGroupCounts,
  type StorageCounts,
  type SubmissionCounts,
} from './counts';
import { furnitureRepOptions, repGroupCards, requestWindowOpen, type RepGroupCard, type RepHomeRows } from './rep';

const MODULE_ID: ModuleId = 'furniture';

// ---------------------------------------------------------------- 総務の読み取り

/** 総務の読み取りの結果（04「ダッシュボードに出すもの」の6つの表。join の列は外してある） */
export interface FurnitureSoumuRaw {
  groups: Pick<GroupRow, 'id' | 'name' | 'category' | 'sort_order'>[];
  submissions: Pick<SubmissionRow, 'group_id' | 'submitted_at'>[];
  rooms: Pick<RoomRow, 'id' | 'name' | 'is_storage' | 'sort_order'>[];
  roomYears: Pick<RoomYearRow, 'room_id' | 'usable'>[];
  /** 在庫の行の room_id（重なりを除いたもの。行は場所×品目） */
  stockRoomIds: string[];
  consents: Pick<ConsentDbRow, 'group_id' | 'status'>[];
}

/** 総務の読み取りの select（版・振り分けの行・ルール・申請の行・品目・距離は読まない） */
export const FURNITURE_SOUMU_SELECT = {
  groups: 'id, name, category, sort_order',
  request_submissions: 'group_id, submitted_at, groups!inner(year_id)',
  rooms: 'id, name, is_storage, sort_order',
  room_years: 'room_id, usable',
  stocks: 'room_id',
  substitution_consents: 'group_id, status, groups!inner(year_id)',
} as const;

function rowsOf<T>(res: { data: T[] | null; error: unknown; status?: number }): T[] {
  if (res.error) throw toAppError(res.error, res.status);
  return res.data ?? [];
}

/**
 * 総務の机椅子のダッシュボードの行を読む（どれも今の RLS で総務が読めるもの）。6つを並行に読み、年度の行（版）を待たない。
 * 提出と了承は `groups!inner(year_id)` で年度に絞る。在庫の行（場所×品目）は fetchAll で読む。
 */
export async function loadFurnitureSoumu(yearId: string, client: AppSupabaseClient = getSupabase()): Promise<FurnitureSoumuRaw> {
  const S = FURNITURE_SOUMU_SELECT;
  const [groups, submissions, rooms, roomYears, stocks, consents] = await Promise.all([
    client.from('groups').select(S.groups).eq('year_id', yearId).order('sort_order').order('id'),
    client.from('request_submissions').select(S.request_submissions).eq('groups.year_id', yearId).order('group_id'),
    client.from('rooms').select(S.rooms).order('sort_order').order('id'),
    client.from('room_years').select(S.room_years).eq('year_id', yearId).order('room_id'),
    fetchAll((from, to) => client.from('stocks').select(S.stocks).eq('year_id', yearId).order('room_id').order('item_id').range(from, to)),
    fetchAll((from, to) =>
      client
        .from('substitution_consents')
        .select(S.substitution_consents)
        .eq('groups.year_id', yearId)
        .order('group_id')
        .order('from_item_id')
        .order('to_item_id')
        .range(from, to),
    ),
  ]);
  return {
    groups: rowsOf(groups).map(({ id, name, category, sort_order }) => ({ id, name, category, sort_order })),
    submissions: rowsOf(submissions).map(({ group_id, submitted_at }) => ({ group_id, submitted_at })),
    rooms: rowsOf(rooms).map(({ id, name, is_storage, sort_order }) => ({ id, name, is_storage, sort_order })),
    roomYears: rowsOf(roomYears).map(({ room_id, usable }) => ({ room_id, usable })),
    stockRoomIds: [...new Set(stocks.map((s) => s.room_id))],
    consents: consents.map(({ group_id, status }) => ({ group_id, status })),
  };
}

/** 総務の机椅子のクエリ（キーは `['year', yearId, 'portal', 'furniture', 'soumu']`） */
export function furnitureSoumuOptions(yearId: string) {
  return queryOptions({
    queryKey: portalQueryKey(yearId, 'furniture', 'soumu'),
    queryFn: () => loadFurnitureSoumu(yearId),
  });
}

export interface FurnitureSoumuCounts {
  submissions: SubmissionCounts<FurnitureSoumuRaw['groups'][number]>;
  storages: StorageCounts<FurnitureSoumuRaw['rooms'][number]>;
  /** 了承の行の状況ごとの団体の数（振り分けの行を読まないので、今の置き換えがない組も数える。机椅子の状況と違う） */
  consents: ConsentGroupCounts;
}

/** 総務の読み取りの数（counts.ts。机椅子の状況の summarizeDashboard と同じ関数） */
export function furnitureSoumuCounts(raw: FurnitureSoumuRaw): FurnitureSoumuCounts {
  return {
    submissions: submissionCounts(raw.groups, raw.submissions),
    storages: storageCounts(raw.rooms, raw.roomYears, raw.stockRoomIds),
    consents: consentGroupCounts(raw.consents.map((c) => ({ groupId: c.group_id, status: c.status }))),
  };
}

// ---------------------------------------------------------------- ダッシュボードに出すもの

/** 読んだ行（種類つき）。総務は loadFurnitureSoumu、団体代表は loadRepHome の結果。閲覧のみは読まない */
export type FurnitureRaw = ({ kind: 'soumu' } & FurnitureSoumuRaw) | ({ kind: 'rep' } & RepHomeRows);

const DAY_MS = 24 * 60 * 60 * 1000;

/** 1日目からの日（02 の festival_day の4つ。前々日・前日・1日目・2日目） */
const FESTIVAL_DAYS = [
  { id: 'furniture:day-minus2', title: '前々日（机椅子の仕分け・配布）', offset: -2 },
  { id: 'furniture:day-minus1', title: '前日（机椅子の配布）', offset: -1 },
  { id: 'furniture:day1', title: '電波祭 1日目', offset: 0 },
  { id: 'furniture:day2', title: '電波祭 2日目', offset: 1 },
] as const;

const isFinal = (s: YearStatus) => s === 'confirmed' || s === 'closed';

const timeOf = (iso: string | null): number | null => {
  if (!iso) return null;
  const t = Date.parse(iso);
  return Number.isNaN(t) ? null : t;
};

/** 今の立場で開ける行き先か（開けなければ null） */
const linkFor = (ctx: PortalContext, href: string): string | null => (canOpen(href, ctx.audiences, ctx.year.status) ? href : null);

/** 祭が終わった（2日目の翌日の 0 時〔Asia/Tokyo〕を過ぎた）か。1日目が読めなければ偽 */
function festivalOver(year: Pick<YearRow, 'festival_start'>, now: number): boolean {
  const next = addDays(year.festival_start, 2);
  return next !== '' && now >= Date.parse(tokyoStartOfDay(next));
}

/** 要対応を作る。行き先を今の立場で開けなければ作らない（04「ダッシュボード」） */
function todoBuilder(ctx: PortalContext) {
  const todos: TodoItem[] = [];
  const add = (t: Omit<TodoItem, 'moduleId'>) => {
    if (canOpen(t.href, ctx.audiences, ctx.year.status)) todos.push({ ...t, moduleId: MODULE_ID });
  };
  return { todos, add };
}

/**
 * 締切と予定（年度の行だけから作る。空の日時の項目は作らない）。申請の受付開始と締切は、申請一覧を開ければ申請一覧、
 * 開けなければ申請（団体代表）へのリンク（閲覧のみはリンクなし）。種類ではなく立場全体で決めるので、兼ねた人でも同じ中身。
 */
function datedItems(ctx: PortalContext): DatedItem[] {
  const y = ctx.year;
  const href = linkFor(ctx, '/requests') ?? linkFor(ctx, '/request');
  const withHref = href ? { href } : {};
  const out: DatedItem[] = [];
  if (y.request_open_at) {
    out.push({ id: 'furniture:request-open', moduleId: MODULE_ID, title: '机椅子の申請の受付開始', at: y.request_open_at, kind: 'event', ...withHref });
  }
  if (y.request_close_at) {
    out.push({ id: 'furniture:request-close', moduleId: MODULE_ID, title: '机椅子の申請の締切', at: y.request_close_at, kind: 'deadline', ...withHref });
  }
  if (addDays(y.festival_start, 0) !== '') {
    for (const d of FESTIVAL_DAYS) {
      out.push({ id: d.id, moduleId: MODULE_ID, title: d.title, at: addDays(y.festival_start, d.offset), kind: 'event' });
    }
  }
  return out;
}

/** 総務の要対応（段は roles.ts。counts が null〔読み込み前〕なら年度の行だけで決まるもの） */
function soumuTodos(counts: FurnitureSoumuCounts | null, ctx: PortalContext): TodoItem[] {
  const { todos, add } = todoBuilder(ctx);
  const y = ctx.year;
  const close = timeOf(y.request_close_at);
  const due = y.request_close_at ? { due: y.request_close_at } : {};

  if (isLead(ctx.role)) {
    if (y.status === 'preparing' && (close === null || close <= ctx.now)) {
      add({
        id: 'furniture:lead:request-window',
        title: '申請の受付期間を入れてください（受付開始には未来の締切が要ります）',
        severity: 'normal',
        href: '/settings?tab=years',
      });
    }
    if (y.status === 'requesting' && close !== null && ctx.now >= close) {
      add({
        id: 'furniture:lead:close-requests',
        title: '申請の締切を過ぎました。「締切（振り分けを始める）」を押してください',
        severity: 'urgent',
        ...due,
        href: '/furniture',
      });
    }
    if (y.status === 'allocating' && !y.auto_allocated_at) {
      add({ id: 'furniture:lead:auto-allocate', title: '自動振り分けをしてください', severity: 'normal', href: '/allocation' });
    }
    const asked = counts?.consents.asked ?? 0;
    if (y.status === 'allocating' && asked > 0) {
      add({
        id: 'furniture:lead:consents-asked',
        title: `キャスター机交換の了承の依頼中 ${asked} 団体`,
        count: asked,
        severity: 'normal',
        href: '/swaps',
      });
    }
  }

  if (isSoumu(ctx.role) && counts) {
    const unsubmitted = counts.submissions.unsubmitted.length;
    if (y.status === 'requesting' && unsubmitted > 0) {
      add({
        id: 'furniture:soumu:unsubmitted',
        title: `未提出 ${unsubmitted} 団体`,
        count: unsubmitted,
        severity: 'normal',
        ...due,
        href: '/requests?filter=unsubmitted',
      });
    }
    const uncounted = counts.storages.uncounted.length;
    if ((y.status === 'preparing' || y.status === 'requesting') && uncounted > 0) {
      add({
        id: 'furniture:soumu:uncounted',
        title: `在庫を数えていない保管場所 ${uncounted} か所`,
        count: uncounted,
        severity: 'normal',
        href: '/stocks',
      });
    }
  }

  if (isAdmin(ctx.role) && y.status === 'confirmed' && festivalOver(y, ctx.now)) {
    add({
      id: 'furniture:admin:close-year',
      title: '祭が終わりました。年度データと振り分け表を書き出して、年度を終了してください',
      severity: 'normal',
      href: '/furniture',
    });
  }
  return todos;
}

/** 総務のカード（年度の状態・提出・在庫・了承の依頼中） */
function soumuCard(counts: FurnitureSoumuCounts, ctx: PortalContext): ModuleCardModel {
  const y = ctx.year;
  const { submissions: s, storages: st, consents: c } = counts;
  const lines = [
    y.status === 'requesting' && y.request_close_at
      ? `${YEAR_STATUS_LABELS.requesting}（締切 ${formatShortDateTime(y.request_close_at)}）`
      : YEAR_STATUS_LABELS[y.status],
    `申請 ${s.submitted}／${s.total} 団体が提出`,
    `在庫 ${st.counted}／${st.total} か所を数えた`,
  ];
  if (y.status === 'allocating' && c.asked > 0) lines.push(`了承の依頼中 ${c.asked} 団体`);
  return { moduleId: MODULE_ID, title: moduleLabel(MODULE_ID), lines, href: linkFor(ctx, '/furniture'), linkLabel: '机椅子の状況へ' };
}

/** 閲覧のみのカード（確定・終了なら振り分け表へ） */
function viewerCard(ctx: PortalContext): ModuleCardModel {
  const final = isFinal(ctx.year.status);
  return {
    moduleId: MODULE_ID,
    title: moduleLabel(MODULE_ID),
    lines: [final ? '振り分けが決まりました' : '振り分けが確定すると、ここから見られます。'],
    href: final ? linkFor(ctx, '/allocation') : null,
    linkLabel: '振り分け表を見る',
  };
}

/** 団体代表の要対応（代表する団体ごとに、立場の一覧の順。rows が null〔読み込み前〕なら年度の行だけで決まるもの） */
function repTodos(rows: RepHomeRows | null, ctx: PortalContext): TodoItem[] {
  const { todos, add } = todoBuilder(ctx);
  const y = ctx.year;
  const cards = new Map<string, RepGroupCard>(rows ? repGroupCards({ groups: ctx.groups, ...rows }, y.status).map((c) => [c.groupId, c]) : []);
  const open = requestWindowOpen(y, ctx.now);
  const close = timeOf(y.request_close_at);
  for (const g of ctx.groups) {
    const c = cards.get(g.id);
    if (c && open && !c.submittedAt && y.request_close_at && close !== null) {
      add({
        id: `furniture:rep:${g.id}:unsubmitted`,
        title: `${g.name}：申請が未提出です`,
        severity: close - ctx.now < DAY_MS ? 'urgent' : 'normal',
        due: y.request_close_at,
        href: `/request?group=${g.id}`,
      });
    }
    if (c && !isFinal(y.status) && c.consentAsked) {
      add({
        id: `furniture:rep:${g.id}:consent`,
        title: `${g.name}：キャスター机への交換の依頼に答えてください`,
        severity: 'normal',
        href: `/my?group=${g.id}`,
      });
    }
    if (y.status === 'confirmed') {
      add({ id: `furniture:rep:${g.id}:final`, title: `${g.name}：振り分けが決まりました`, severity: 'info', href: `/my?group=${g.id}` });
    }
  }
  return todos;
}

/**
 * 机椅子がその種類（ctx.kind）に出すもの。raw が null なら年度の行だけで決まる分（fromYear）、raw があればその種類の全部
 * （fromYear の分を含む）。raw の種類は ctx.kind と同じにする（違えば例外）。純粋関数（時計は ctx.now だけ）。
 *
 * @example
 * furniturePortal(null, ctx)                              // 年度の行だけ（読み込み前）
 * furniturePortal({ kind: 'soumu', ...raw }, ctx)          // 総務の読み取りの後
 */
export function furniturePortal(raw: FurnitureRaw | null, ctx: PortalContext): PortalSection {
  if (raw && raw.kind !== ctx.kind) throw new Error(`furniturePortal：読んだ行（${raw.kind}）と立場の種類（${ctx.kind}）が違います`);
  const dated = datedItems(ctx);
  switch (ctx.kind) {
    case 'soumu': {
      const counts = raw?.kind === 'soumu' ? furnitureSoumuCounts(raw) : null;
      return { card: counts ? soumuCard(counts, ctx) : null, todos: soumuTodos(counts, ctx), dated };
    }
    case 'viewer':
      return { card: viewerCard(ctx), todos: [], dated };
    case 'rep':
      return { card: null, todos: repTodos(raw?.kind === 'rep' ? raw : null, ctx), dated };
  }
}

/**
 * 机椅子のプロバイダ（providers.ts の PORTAL_PROVIDERS に並べる）。総務は furnitureSoumuOptions、団体代表は
 * furnitureRepOptions（代表する団体の欄と同じキー）に select を足して読む。閲覧のみは読まない（query は null）。
 */
export const furniturePortalProvider: PortalProvider = {
  moduleId: MODULE_ID,
  kinds: ['soumu', 'viewer', 'rep'],
  fromYear: (ctx) => furniturePortal(null, ctx),
  query: (ctx) => {
    switch (ctx.kind) {
      case 'soumu':
        return portalQueryOptions(furnitureSoumuOptions(ctx.year.id), (raw) => furniturePortal({ kind: 'soumu', ...raw }, ctx));
      case 'rep':
        return portalQueryOptions(
          furnitureRepOptions(
            ctx.year.id,
            ctx.groups.map((g) => g.id),
          ),
          (raw) => furniturePortal({ kind: 'rep', ...raw }, ctx),
        );
      case 'viewer':
        return null;
    }
  },
};
