// ダッシュボード（/）の型と小さな純粋関数（D-52。04「ダッシュボード」、notes/T16.md「固めた約束」3）。
// 機能は PortalProvider を1つ作り（lib/modules/<機能>/portal.ts）、providers.ts の PORTAL_PROVIDERS に並べる。
// 欄（components/portal）は次のように使う：
// 1. 立場の種類（PortalKind）ごとに PortalContext を作る（portalContextsOf。年度の行は立場と一緒に読んだキャッシュ）。
// 2. プロバイダ × 種類（provider.kinds に入るもの）ごとに、その欄が読み取りの結果を使う欄（query.widgets）なら、
//    query.options(ctx) が null でなければ useQueries に並べる（同じキーは1回だけ読む）。
// 3. 欄に出すのは portalSectionOf(provider, ctx, data)：query の data（select の後。fromYear の分を含む）があればそれ、
//    なければ fromYear(ctx)（リクエストを送らない）。読み込み中・失敗は、並べた query の分だけ欄がプロバイダ × 種類ごとに出す
//    （query.widgets にない欄には出さない。年度の行だけで決まる欄に、使わない読み取りの読み込み中・失敗を出さない）。
// 4. mergePortalSections で機能ごとにまとめ（兼ねた人の重なりを消す）、要対応は sortTodos、締切と予定は upcomingDated、
//    お知らせの欄（T17）は latestNotices で並べる。
// React・Supabase・lib/data を import しない（型と、membership・roles・datetime・registry の小さな関数だけ）。
import type { Database } from '@gaapp/shared';
import type { UseQueryOptions } from '@tanstack/react-query';
import { audiencesOf, type Audience, type GroupSummary, type Membership } from '@/lib/auth/membership';
import { isSoumu, type AppRole } from '@/lib/auth/roles';
import { tokyoStartOfDay, tokyoToday } from '@/lib/datetime';
import type { YearRow } from '@/lib/db/types';
import type { PortalQueryKey } from './query-key';
import { MODULES, type ModuleId } from './registry';

/** 立場の種類：総務（管理者・総務部門長・総務副部門長・総務部門員）・閲覧のみ・団体代表（店長・副店長） */
export type PortalKind = 'soumu' | 'viewer' | 'rep';

/**
 * ダッシュボードの欄（読み込みを分けるもの）：要対応・締切と予定・総務内のお知らせ（T17。総務）・お知らせ（T17。閲覧のみ・
 * 店長・副店長）・機能ごとのカード
 */
export type PortalWidgetId = 'todos' | 'dated' | 'soumuNotices' | 'notices' | 'cards';

/** 欄の一覧（04「ダッシュボード」の欄の順） */
export const PORTAL_WIDGETS: readonly PortalWidgetId[] = ['todos', 'dated', 'soumuNotices', 'notices', 'cards'];

/** 種類の順（兼ねた人の欄の中の並びと、カードを選ぶ順） */
export const PORTAL_KINDS: readonly PortalKind[] = ['soumu', 'viewer', 'rep'];

/** 急ぎの度合い：急ぎ・ふつう・参考（画面の印。機能の「お知らせ」〔T17〕と取り違えないよう、info を「お知らせ」と呼ばない） */
export type TodoSeverity = 'urgent' | 'normal' | 'info';

/** 要対応の1件（01 の用語集の todo） */
export interface TodoItem {
  /** 機能の中で一意（`${moduleId}:…`）。兼ねた人の重なりを消すのに使う */
  id: string;
  moduleId: ModuleId;
  /** 画面に出す文。数を含む（「未提出 3 団体」） */
  title: string;
  /** 文の中の数（テスト・読み上げ用） */
  count?: number;
  severity: TodoSeverity;
  /** 期日（timestamptz の ISO 文字列）。「締切 10/5 17:00」と出す */
  due?: string;
  /** 行き先。canOpen が真のものだけ（開けない要対応は作らない） */
  href: string;
}

/** 締切と予定の種類：締切・予定（01 の用語集の deadline・event） */
export type DatedKind = 'deadline' | 'event';

/** 締切と予定の1件 */
export interface DatedItem {
  /** 機能の中で一意。立場の種類によらず、同じ項目は同じ id・同じ中身 */
  id: string;
  moduleId: ModuleId;
  title: string;
  /** ISO 8601。時刻のあるものは timestamptz の文字列、日付だけのものは YYYY-MM-DD（Asia/Tokyo の日付） */
  at: string;
  kind: DatedKind;
  /** 行き先（開けるときだけ） */
  href?: string;
}

/** 機能ごとのカード */
export interface ModuleCardModel {
  moduleId: ModuleId;
  /** 機能の名前（MODULES の label） */
  title: string;
  /** 要約（1〜4 行） */
  lines: readonly string[];
  /** 入口（開けなければ null。リンクを出さない） */
  href: string | null;
  /** リンクの文字 */
  linkLabel: string;
}

/** お知らせの欄の1件（T17。D-52 の T17 の直し） */
export interface NoticeDigest {
  /** お知らせの id（兼ねた人の重なりを消す） */
  id: string;
  /** 'notices' */
  moduleId: ModuleId;
  title: string;
  /** 出した日時（created_at。timestamptz の ISO） */
  at: string;
  pinned: boolean;
  audience: Database['public']['Enums']['notice_audience'];
  /** `/notices?notice=${id}`（一覧でそのお知らせを目立たせる） */
  href: string;
}

/** 1つの機能が1つの種類に出すもの */
export interface PortalSection {
  card: ModuleCardModel | null;
  todos: readonly TodoItem[];
  dated: readonly DatedItem[];
  /** お知らせの欄に出すもの（T17。お知らせの機能だけが持つ。省略は空） */
  notices?: readonly NoticeDigest[];
}

/** 機能が出すものを決める材料（立場の種類ごとに1つ） */
export interface PortalContext {
  kind: PortalKind;
  /** 開いている年度の行（立場と一緒に読んでキャッシュにあるもの。useYearRow） */
  year: YearRow;
  role: AppRole | null;
  /** 今の年度で代表する団体（立場の一覧と同じ名前の順） */
  groups: readonly GroupSummary[];
  /** 今の立場（canOpen に渡す。種類ではなく人の立場全体） */
  audiences: readonly Audience[];
  /** 画面を開いた時刻（ms。描画のたびに時計を読まない） */
  now: number;
}

// ダッシュボードのクエリのキー（portalQueryKey・PortalQueryKey）は query-key.ts（/ の先読みがルートのレイアウトから使うので、
// このファイルを読ませないために分けた）。ここから同じ名前で出し直す
export { portalQueryKey, type PortalQueryKey } from './query-key';

/**
 * 機能の読み取りのクエリ（useQueries に並べて渡す。data は select の後の PortalSection）。queryFn は生の行を返し、
 * select はその種類の PortalSection の全部（fromYear の分を含む）を返す。作るときは portalQueryOptions を使う。
 */
export type PortalQueryOptions = UseQueryOptions<unknown, Error, PortalSection, PortalQueryKey>;

/**
 * 生の行のクエリ（queryOptions の結果）に select を足し、useQueries に並べられる形（PortalQueryOptions）にする。
 * 生の行の型は select の引数で確かめてから消す（並べるクエリごとに生の行の型が違うため）。
 *
 * @example
 * portalQueryOptions(furnitureSoumuOptions(ctx.year.id), (raw) => furniturePortal({ kind: 'soumu', ...raw }, ctx))
 */
export function portalQueryOptions<TRaw>(
  base: UseQueryOptions<TRaw, Error, TRaw, PortalQueryKey>,
  select: (raw: TRaw) => PortalSection,
): PortalQueryOptions {
  return { ...base, select } as unknown as PortalQueryOptions;
}

/**
 * 機能の読み取り（D-52）。読んだ行で中身が変わる欄（widgets）だけがこの読み取りを並べ、その読み込み中・失敗を出す。
 * ほかの欄は fromYear だけを出す（その欄の項目は年度の行だけで決まる約束。読み取りの select の結果のその欄の分は fromYear と
 * 同じにする）。例：机椅子の締切と予定は年度の行だけで決まるので、机椅子の読み取りの widgets は要対応とカード。
 */
export interface PortalQuery {
  /** この読み取りの結果を使う欄（1つ以上） */
  widgets: readonly PortalWidgetId[];
  /** 読む分（select の結果は fromYear の分を含む）。その種類で読まないときは null */
  options: (ctx: PortalContext) => PortalQueryOptions | null;
}

/** ダッシュボードに出す機能（lib/modules/<機能>/portal.ts が1つ作る） */
export interface PortalProvider {
  moduleId: ModuleId;
  /** 出す種類 */
  kinds: readonly PortalKind[];
  /** 年度の行だけから同期で作る（リクエストを送らない。読み込みを待たずに出す） */
  fromYear?: (ctx: PortalContext) => PortalSection;
  /** 読む分と、その結果を使う欄 */
  query?: PortalQuery;
}

/**
 * その欄で、そのプロバイダ × 種類の読み取りを並べるか（並べるならその query の設定、並べないなら null）。
 * 欄が query.widgets に入っていて、その種類で読むとき（options が null でない）だけ。
 *
 * @example
 * portalWidgetQuery(furniturePortalProvider, ctx, 'dated') // null（机椅子の締切と予定は年度の行だけ）
 */
export function portalWidgetQuery(provider: Pick<PortalProvider, 'query'>, ctx: PortalContext, widget: PortalWidgetId): PortalQueryOptions | null {
  const q = provider.query;
  return q && q.widgets.includes(widget) ? q.options(ctx) : null;
}

/** 読むものも年度の行だけで決まるものもないときの PortalSection */
export const EMPTY_PORTAL_SECTION: PortalSection = Object.freeze({ card: null, todos: Object.freeze([]), dated: Object.freeze([]) });

/** 機能の名前（MODULES の label。要対応の印・カード・失敗の文言） */
export function moduleLabel(id: ModuleId): string {
  return MODULES.find((m) => m.id === id)?.label ?? id;
}

/** 機能の登録の順（登録にない id は最後） */
function moduleIndex(id: ModuleId): number {
  const k = MODULES.findIndex((m) => m.id === id);
  return k < 0 ? MODULES.length : k;
}

/**
 * その人の立場の種類：総務（isSoumu）→ 閲覧のみ → 団体代表（今の年度の団体が1つ以上）の順。
 * 1人に2つまで（管理者・閲覧のみで店長・副店長も務める人。部門のロールは同じ年度の団体代表を兼ねられない。D-49）。
 */
export function portalKindsOf(m: Pick<Membership, 'role' | 'groups'>): PortalKind[] {
  const kinds: PortalKind[] = [];
  if (isSoumu(m.role)) kinds.push('soumu');
  if (m.role === 'viewer') kinds.push('viewer');
  if (m.groups.length > 0) kinds.push('rep');
  return kinds;
}

/**
 * 種類ごとの PortalContext（portalKindsOf の順）。year は開いている年度の行（useYearRow の data）、now は画面を開いた時刻。
 *
 * @example
 * const [now] = useState(() => Date.now());
 * const ctxs = year.data ? portalContextsOf(m, year.data, now) : [];
 */
export function portalContextsOf(m: Membership, year: YearRow, now: number): PortalContext[] {
  const audiences = audiencesOf(m);
  return portalKindsOf(m).map((kind) => ({ kind, year, role: m.role, groups: m.groups, audiences, now }));
}

/**
 * 欄に出す PortalSection：query の data（select の後）があればそれ、なければ fromYear(ctx)、どちらもなければ空。
 * query の結果は fromYear の分を含む約束なので、両方を足し合わせない。
 */
export function portalSectionOf(provider: Pick<PortalProvider, 'fromYear'>, ctx: PortalContext, data?: PortalSection): PortalSection {
  return data ?? provider.fromYear?.(ctx) ?? EMPTY_PORTAL_SECTION;
}

const SEVERITY_ORDER: Record<TodoSeverity, number> = { urgent: 0, normal: 1, info: 2 };

const timeOf = (iso: string | undefined): number | null => {
  if (!iso) return null;
  const t = Date.parse(iso);
  return Number.isNaN(t) ? null : t;
};

/** 期日の早い順（期日のないものは後） */
const compareDue = (a: number | null, b: number | null): number => (a === null ? (b === null ? 0 : 1) : b === null ? -1 : a - b);

/**
 * 要対応の並び（04「ダッシュボード」）：急ぎ → ふつう → 参考、同じなら期日の早い順（期日のないものは後）、
 * 機能の登録の順、元の順（機能が作った順）。元の配列は変えない。
 */
export function sortTodos(todos: readonly TodoItem[]): TodoItem[] {
  return todos
    .map((t, k) => ({ t, k, due: timeOf(t.due) }))
    .sort(
      (a, b) =>
        SEVERITY_ORDER[a.t.severity] - SEVERITY_ORDER[b.t.severity] ||
        compareDue(a.due, b.due) ||
        moduleIndex(a.t.moduleId) - moduleIndex(b.t.moduleId) ||
        a.k - b.k,
    )
    .map((x) => x.t);
}

/** 締切と予定に出す数（続きは「ほか N 件」） */
export const PORTAL_DATED_LIMIT = 8;

const DATE_ONLY = /^\d{4}-\d{2}-\d{2}$/;

/** 日付だけの項目か（at が YYYY-MM-DD。表示では時刻を出さない） */
export function isDateOnly(at: string): boolean {
  return DATE_ONLY.test(at);
}

/** 締切と予定の項目の時刻（ms）。日付だけのものは Asia/Tokyo の 0 時。読めなければ null */
export function datedTime(at: string): number | null {
  const t = Date.parse(isDateOnly(at) ? tokyoStartOfDay(at) : at);
  return Number.isNaN(t) ? null : t;
}

/**
 * これからの締切と予定（04「ダッシュボード」）：時刻のあるものは now より後、日付だけのものは日付が今日（Asia/Tokyo）以降の
 * ものを、早い順（日付だけは Asia/Tokyo の 0 時として比べる。同じ時刻は機能の登録の順、元の順）に limit 件まで。
 * 残りの数を more に返す（「ほか N 件」）。読めない日時の項目は出さない。
 */
export function upcomingDated(items: readonly DatedItem[], now: number, limit = PORTAL_DATED_LIMIT): { items: DatedItem[]; more: number } {
  const today = tokyoToday(new Date(now));
  const upcoming = items
    .map((d, k) => ({ d, k, t: datedTime(d.at) }))
    .filter((x): x is { d: DatedItem; k: number; t: number } => x.t !== null && (isDateOnly(x.d.at) ? x.d.at >= today : x.t > now))
    .sort((a, b) => a.t - b.t || moduleIndex(a.d.moduleId) - moduleIndex(b.d.moduleId) || a.k - b.k)
    .map((x) => x.d);
  const n = Math.max(0, Math.floor(limit));
  return { items: upcoming.slice(0, n), more: Math.max(0, upcoming.length - n) };
}

/** お知らせの欄に出す数（04「ダッシュボード」。lib/modules/notices/latest.ts の NOTICES_LATEST_LIMIT と同じ） */
export const PORTAL_NOTICE_LIMIT = 5;

/**
 * お知らせの欄の並び（04「ダッシュボード」）：ピン留めのものを先に、その中と残りはそれぞれ出した日時の新しい順（読めない日時は後）、
 * 同じなら id の順に limit 件。元の配列は変えない。
 */
export function latestNotices(items: readonly NoticeDigest[], limit = PORTAL_NOTICE_LIMIT): NoticeDigest[] {
  const at = (iso: string) => {
    const t = Date.parse(iso);
    return Number.isNaN(t) ? Number.NEGATIVE_INFINITY : t;
  };
  const sorted = [...items].sort(
    (a, b) => Number(b.pinned) - Number(a.pinned) || at(b.at) - at(a.at) || (a.id < b.id ? -1 : a.id > b.id ? 1 : 0),
  );
  return sorted.slice(0, Math.max(0, Math.floor(limit)));
}

/** 1つの機能の1つの種類の PortalSection（mergePortalSections の入力） */
export interface PortalPart {
  moduleId: ModuleId;
  kind: PortalKind;
  section: PortalSection;
}

/** 機能ごとにまとめた PortalSection */
export interface ModulePortalSection extends PortalSection {
  moduleId: ModuleId;
}

const KIND_INDEX: Record<PortalKind, number> = { soumu: 0, viewer: 1, rep: 2 };

/**
 * 種類ごとの PortalSection を機能ごとにまとめる（兼ねた人。04「ダッシュボード」）。並びは機能の登録の順（parts にある機能だけ）。
 * 要対応と締切と予定とお知らせ（T17）は種類の順（総務 → 閲覧のみ → 団体代表）につなぎ、同じ id は最初の1件だけにする。
 * お知らせは、どの部分も notices を持たなければ付けない。カードは、種類の順で最初の null でないもの。
 */
export function mergePortalSections(parts: readonly PortalPart[]): ModulePortalSection[] {
  const sorted = parts
    .map((p, k) => ({ p, k }))
    .sort((a, b) => moduleIndex(a.p.moduleId) - moduleIndex(b.p.moduleId) || KIND_INDEX[a.p.kind] - KIND_INDEX[b.p.kind] || a.k - b.k)
    .map((x) => x.p);
  const out = new Map<
    ModuleId,
    { card: ModuleCardModel | null; todos: Map<string, TodoItem>; dated: Map<string, DatedItem>; notices: Map<string, NoticeDigest> | null }
  >();
  for (const p of sorted) {
    let m = out.get(p.moduleId);
    if (!m) {
      m = { card: null, todos: new Map(), dated: new Map(), notices: null };
      out.set(p.moduleId, m);
    }
    m.card ??= p.section.card;
    for (const t of p.section.todos) if (!m.todos.has(t.id)) m.todos.set(t.id, t);
    for (const d of p.section.dated) if (!m.dated.has(d.id)) m.dated.set(d.id, d);
    if (p.section.notices) {
      m.notices ??= new Map();
      for (const n of p.section.notices) if (!m.notices.has(n.id)) m.notices.set(n.id, n);
    }
  }
  return [...out].map(([moduleId, m]) => ({
    moduleId,
    card: m.card,
    todos: [...m.todos.values()],
    dated: [...m.dated.values()],
    ...(m.notices ? { notices: [...m.notices.values()] } : {}),
  }));
}
