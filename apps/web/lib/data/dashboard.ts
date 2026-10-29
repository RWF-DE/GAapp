// ダッシュボードの集計とホームのカード（画面の設計 3.1・6。T09）。summarizeDashboard は純粋関数で、3.1 の数をすべて返す。
// 了承の集計は /swaps（T13）と同じ swapRows を使う（同じ数え方を2か所に書かない）。リンクは今の立場で開ける画面だけを返す
// （開けなければ href を null にする。部員にキャスター机交換・ルール・マスタ設定へのリンクを出さない。1.1 の canOpen）。
import { compareBySortOrder, type GroupCategory, type InputError, type Issue } from '@gaapp/shared';
import type { Audience, YearStatus } from '@/lib/auth/membership';
import { fetchAll } from '@/lib/db/fetch-all';
import { COLUMNS, type ConsentDbRow, type SubmissionRow, type YearTables } from '@/lib/db/types';
import { toAppError } from '@/lib/errors';
import { CATEGORY_LABELS } from '@/lib/labels';
import { canOpen } from '@/lib/navigation';
import { getSupabase, type AppSupabaseClient } from '@/lib/supabase/client';
import type { Snapshot } from './snapshot';
import { swapRows } from './swaps';
import type { ValidationResult } from './validation';

/** 一覧に名前を出す数（続きはリンクの先で見る） */
export const DASHBOARD_LIST_LIMIT = 5;
/** 多いコードの上位の数 */
export const DASHBOARD_TOP_CODES = 5;

export interface NamedLink {
  id: string;
  name: string;
  /** 今の立場で開けなければ null（文字だけを出す） */
  href: string | null;
}

export interface CategoryCount {
  category: GroupCategory;
  label: string;
  submitted: number;
  total: number;
}

export interface CodeCount {
  code: string;
  severity: Issue['severity'];
  count: number;
}

export interface ProblemLine {
  message: string;
  ruleCode: string | null;
  /** ルールなら /rules?code=…、ほかはマスタ設定。開けなければ null */
  href: string | null;
}

export type ValidationPhase =
  /** 準備中・受付中：振り分け前（行がないと E003 がすべての申請に出て意味がないため検証しない） */
  | 'before'
  /** 振り分け中・確定中：検証した */
  | 'ok'
  /** 入力の誤りで検証できない */
  | 'unavailable'
  /** 終了した年度：検証の数は出さない */
  | 'closed';

export interface DashboardSummary {
  status: YearStatus;
  requestOpenAt: string | null;
  requestCloseAt: string | null;
  autoAllocatedAt: string | null;
  submissions: {
    submitted: number;
    total: number;
    /** 区分の並び（模擬店・部門・企業・休憩所）。団体のない区分は出さない */
    byCategory: CategoryCount[];
    /** 未提出の団体（団体の並びで DASHBOARD_LIST_LIMIT 件まで。名前だけ。続きは unsubmittedHref） */
    unsubmitted: { id: string; name: string }[];
    unsubmittedCount: number;
    /** 未提出だけの申請一覧（開けなければ null） */
    unsubmittedHref: string | null;
  };
  stocks: {
    /** 在庫を数えた保管場所の数（その年度の stocks の行が1つ以上ある。使用不可は除く） */
    counted: number;
    total: number;
    /** まだ数えていない保管場所（W104 と同じ。場所の並びで DASHBOARD_LIST_LIMIT 件まで。リンクは在庫入力） */
    uncounted: NamedLink[];
    uncountedCount: number;
  };
  validation: {
    phase: ValidationPhase;
    errors: number;
    warnings: number;
    infos: number;
    /** 件数の多い順（同じならコードの順）に DASHBOARD_TOP_CODES 件 */
    topCodes: CodeCount[];
    /** 振り分け画面（開けなければ null） */
    href: string | null;
  };
  /** 入力の誤り（toYearData の problems） */
  problems: ProblemLine[];
  consents: {
    /** 了承が要る代替の置き換えがある団体の数（今の置き換え台数が1以上） */
    groups: number;
    notAsked: number;
    asked: number;
    accepted: number;
    declined: number;
    /** 依頼し直しが要る団体（依頼・了承の後に増えた。W102 を含む） */
    reask: number;
    /** 拒否したので最小変更での再実行が要る団体 */
    rerun: number;
    /** キャスター机交換の画面（admin だけ。開けなければ null） */
    href: string | null;
  };
}

const SEVERITY_ORDER: Record<Issue['severity'], number> = { error: 0, warning: 1, info: 2 };
const CATEGORY_ORDER = Object.keys(CATEGORY_LABELS) as GroupCategory[];

/** validate の結果を件数の多いコードにまとめる（同じ数なら error → warning → info、コードの順） */
export function topIssueCodes(issues: readonly Pick<Issue, 'code' | 'severity'>[], limit = DASHBOARD_TOP_CODES): CodeCount[] {
  const m = new Map<string, CodeCount>();
  for (const i of issues) {
    const c = m.get(i.code) ?? { code: i.code, severity: i.severity, count: 0 };
    c.count += 1;
    m.set(i.code, c);
  }
  return [...m.values()]
    .sort((a, b) => b.count - a.count || SEVERITY_ORDER[a.severity] - SEVERITY_ORDER[b.severity] || a.code.localeCompare(b.code))
    .slice(0, limit);
}

export interface SummarizeOptions {
  /** 今の立場（リンクの出し分け） */
  audiences: readonly Audience[];
}

type DashboardSource = Pick<Snapshot, 'year'> & Pick<YearTables, 'items' | 'rooms' | 'roomYears' | 'groups' | 'submissions' | 'stocks' | 'rules' | 'consents' | 'allocations'>;

/**
 * ダッシュボードの数（3.1）。snapshot は part = full（admin・staff）。validation は useValidation の結果。
 *
 * @example
 * const v = useValidation(snap.data);
 * const s = summarizeDashboard(snap.data, v, { audiences: audiencesOf(m) });
 */
export function summarizeDashboard(
  snapshot: DashboardSource,
  validation: Pick<ValidationResult, 'status' | 'issues' | 'problems'>,
  opts: SummarizeOptions,
): DashboardSummary {
  const status = snapshot.year.status;
  const link = (href: string): string | null => (canOpen(href, opts.audiences, status) ? href : null);

  // 申請
  const groups = snapshot.groups
    .map((g) => ({ id: g.id, name: g.name, sortOrder: g.sort_order, category: g.category }))
    .sort(compareBySortOrder);
  const submitted = new Set(snapshot.submissions.filter((s) => s.submitted_at !== null).map((s) => s.group_id));
  const byCategory: CategoryCount[] = CATEGORY_ORDER.flatMap((category) => {
    const gs = groups.filter((g) => g.category === category);
    if (gs.length === 0) return [];
    return [{ category, label: CATEGORY_LABELS[category], submitted: gs.filter((g) => submitted.has(g.id)).length, total: gs.length }];
  });
  const unsubmitted = groups.filter((g) => !submitted.has(g.id));

  // 在庫（使用不可の部屋を除く保管場所）
  const unusable = new Set(snapshot.roomYears.filter((r) => !r.usable).map((r) => r.room_id));
  const storages = snapshot.rooms
    .filter((r) => r.is_storage && !unusable.has(r.id))
    .map((r) => ({ id: r.id, name: r.name, sortOrder: r.sort_order }))
    .sort(compareBySortOrder);
  const countedRooms = new Set(snapshot.stocks.map((s) => s.room_id));
  const uncounted = storages.filter((r) => !countedRooms.has(r.id));

  // 検証
  const phase: ValidationPhase =
    status === 'preparing' || status === 'requesting'
      ? 'before'
      : status === 'closed'
        ? 'closed'
        : validation.status === 'ok'
          ? 'ok'
          : 'unavailable';
  const issues = phase === 'ok' ? validation.issues : [];
  const count = (s: Issue['severity']) => issues.filter((i) => i.severity === s).length;

  // 了承（/swaps と同じ swapRows。今の置き換えがある行だけ。団体の数は状況ごとに数える〔1つの団体に複数の品目の組があれば、それぞれの状況に入る〕）
  const swaps = swapRows(snapshot).filter((r) => r.current > 0);
  const groupsWhere = (pred: (r: (typeof swaps)[number]) => boolean) => new Set(swaps.filter(pred).map((r) => r.groupId)).size;

  return {
    status,
    requestOpenAt: snapshot.year.request_open_at,
    requestCloseAt: snapshot.year.request_close_at,
    autoAllocatedAt: snapshot.year.auto_allocated_at,
    submissions: {
      submitted: groups.filter((g) => submitted.has(g.id)).length,
      total: groups.length,
      byCategory,
      unsubmitted: unsubmitted.slice(0, DASHBOARD_LIST_LIMIT).map((g) => ({ id: g.id, name: g.name })),
      unsubmittedCount: unsubmitted.length,
      unsubmittedHref: link('/requests?filter=unsubmitted'),
    },
    stocks: {
      counted: storages.length - uncounted.length,
      total: storages.length,
      uncounted: uncounted.slice(0, DASHBOARD_LIST_LIMIT).map((r) => ({ id: r.id, name: r.name, href: link(`/stock?room=${r.id}`) })),
      uncountedCount: uncounted.length,
    },
    validation: {
      phase,
      errors: count('error'),
      warnings: count('warning'),
      infos: count('info'),
      topCodes: topIssueCodes(issues),
      href: link('/allocation'),
    },
    problems: problemLines(validation.problems, link),
    consents: {
      groups: groupsWhere(() => true),
      notAsked: groupsWhere((r) => r.status === 'not_asked'),
      asked: groupsWhere((r) => r.status === 'asked'),
      accepted: groupsWhere((r) => r.status === 'accepted'),
      declined: groupsWhere((r) => r.status === 'declined'),
      reask: groupsWhere((r) => r.attention === 'reask' || r.attention === 'w102'),
      rerun: groupsWhere((r) => r.attention === 'rerun'),
      href: link('/swaps'),
    },
  };
}

/** 入力の誤りの行（ルールならコードとルールの画面、ほかはマスタ設定へ） */
function problemLines(problems: readonly InputError[], link: (href: string) => string | null): ProblemLine[] {
  return problems.map((p) => ({
    message: p.message,
    ruleCode: p.ruleCode ?? null,
    href: p.ruleCode ? link(`/rules?code=${encodeURIComponent(p.ruleCode)}`) : link('/settings'),
  }));
}

// ---- 団体代表・閲覧のみのホーム ----

export interface RepGroupCard {
  groupId: string;
  name: string;
  /** 提出した日時（なければ未提出） */
  submittedAt: string | null;
  /** キャスター机への交換の依頼（status = asked）があるか */
  consentAsked: boolean;
  /** 振り分けが決まった（確定・終了） */
  final: boolean;
}

export interface RepHomeSource {
  groups: readonly { id: string; name: string }[];
  submissions: readonly Pick<SubmissionRow, 'group_id' | 'submitted_at'>[];
  consents: readonly Pick<ConsentDbRow, 'group_id' | 'status'>[];
}

/** 団体代表のカード（代表する団体ごと。並びは立場の一覧と同じ名前の順） */
export function repGroupCards(src: RepHomeSource, status: YearStatus): RepGroupCard[] {
  const submittedAt = new Map(src.submissions.map((s) => [s.group_id, s.submitted_at]));
  const asked = new Set(src.consents.filter((c) => c.status === 'asked').map((c) => c.group_id));
  return src.groups.map((g) => ({
    groupId: g.id,
    name: g.name,
    submittedAt: submittedAt.get(g.id) ?? null,
    consentAsked: asked.has(g.id),
    final: status === 'confirmed' || status === 'closed',
  }));
}

/** 団体代表が申請を書けるか（02 の「締切前」と同じ：requesting・受付開始が null か過ぎた・締切の前） */
export function requestWindowOpen(year: Pick<Snapshot['year'], 'status' | 'request_open_at' | 'request_close_at'>, now: number): boolean {
  if (year.status !== 'requesting' || !year.request_close_at) return false;
  if (year.request_open_at && new Date(year.request_open_at).getTime() > now) return false;
  return new Date(year.request_close_at).getTime() > now;
}

/**
 * 団体代表のホームに要る行（自団体の提出と了承。RLS で自団体の行だけが返る）。
 * 年度の行（締切）は useYearRow で読む。
 */
export async function loadRepHome(
  groupIds: readonly string[],
  client: AppSupabaseClient = getSupabase(),
): Promise<Pick<RepHomeSource, 'submissions' | 'consents'>> {
  if (groupIds.length === 0) return { submissions: [], consents: [] };
  const [sub, con] = await Promise.all([
    client.from('request_submissions').select(COLUMNS.request_submissions).in('group_id', [...groupIds]).order('group_id'),
    fetchAll((from, to) =>
      client
        .from('substitution_consents')
        .select(COLUMNS.substitution_consents)
        .in('group_id', [...groupIds])
        .order('group_id')
        .order('from_item_id')
        .order('to_item_id')
        .range(from, to),
    ),
  ]);
  if (sub.error) throw toAppError(sub.error, sub.status);
  return {
    submissions: (sub.data ?? []) as unknown as SubmissionRow[],
    consents: con as unknown as ConsentDbRow[],
  };
}
