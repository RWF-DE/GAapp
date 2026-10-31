// 机椅子の状況（/furniture）の集計（画面の設計 3.1・6。T09。T16 より前は / のダッシュボード。D-51）。summarizeDashboard は
// 純粋関数で、3.1 の数をすべて返す。提出・在庫・了承の状況ごとの団体の数は lib/modules/furniture/counts.ts の関数で数える
// （ダッシュボード〔/〕の机椅子と同じ数え方。D-52）。了承の集計は /swaps（T13）と同じ swapRows を使う（同じ数え方を2か所に
// 書かない）。リンクは今の立場で開ける画面だけを返す（開けなければ href を null にする。総務部門員にキャスター机交換・ルール・
// マスタ設定へのリンクを、部門長・副部門長に管理者だけのマスタ設定のタブ〔団体など〕へのリンクを出さない。1.1 の canOpen。D-50）。
// マスタ（場所・品目・団体・距離）を直す案内のリンク（入力の誤りのマスタ設定・保管場所の登録）は管理者だけに出す（部門長・
// 副部門長が開ける場所のタブでも、保管場所や場所の中身はマスタなので直せない。D-50。ほかの人には管理者に頼むよう文で出す）。
// 団体代表のカード（repGroupCards・requestWindowOpen・loadRepHome）は T16 で lib/modules/furniture/rep.ts に移した（/ の JS に
// このファイル〔swaps.ts の ruleSchema〕を入れないため）。今の import のために、ここから同じ名前で出し直す。
import type { GroupCategory, InputError, Issue } from '@gaapp/shared';
import type { Audience, YearStatus } from '@/lib/auth/membership';
import { isAdmin } from '@/lib/auth/roles';
import type { YearTables } from '@/lib/db/types';
import { CATEGORY_LABELS } from '@/lib/labels';
import { consentGroupCounts, storageCounts, submissionCounts } from '@/lib/modules/furniture/counts';
import { canOpen, type SettingsTab } from '@/lib/navigation';
import type { Snapshot } from './snapshot';
import { swapRows } from './swaps';
import type { ValidationResult } from './validation';

export {
  loadRepHome,
  repGroupCards,
  requestWindowOpen,
  type RepGroupCard,
  type RepHomeRows,
  type RepHomeSource,
} from '@/lib/modules/furniture/rep';

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
  /**
   * ルールなら /rules?code=…（開けなければ null）。ほかはマスタの誤りで、管理者にだけ直すマスタ設定のタブ
   * （`/settings?tab=items` など。直すタブが決まらなければ /settings）。管理者でなければ null
   */
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
    /** 団体がないときの「マスタ設定の団体へ」（開けなければ null。ほかの人には管理者に頼む文を出す） */
    emptyHref: string | null;
  };
  stocks: {
    /** 在庫を数えた保管場所の数（その年度の stocks の行が1つ以上ある。使用不可は除く） */
    counted: number;
    total: number;
    /** まだ数えていない保管場所（W104 と同じ。場所の並びで DASHBOARD_LIST_LIMIT 件まで。リンクは在庫入力） */
    uncounted: NamedLink[];
    uncountedCount: number;
    /** 保管場所がないときの「マスタ設定の場所へ」（管理者だけ。保管場所はマスタなので、部門長・副部門長には null。D-50） */
    emptyHref: string | null;
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
  /** 入力の誤りのカードの説明（直す人が段で違う：ルールは部門長以上、マスタは管理者。D-50） */
  problemsNote: string;
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
    /** キャスター机交換の画面（部門長以上だけ。開けなければ null） */
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
 * 机椅子の状況（/furniture）の数（3.1）。snapshot は part = full（総務）。validation は useValidation の結果。
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
  // マスタを直す案内のリンクは管理者だけ（D-50）。管理者で店長も務める人は audiences に admin と rep がある
  const admin = opts.audiences.some((a) => a !== 'rep' && isAdmin(a));
  const masterLink = (href: string): string | null => (admin ? link(href) : null);

  // 申請（counts.ts。団体の並びは sort_order → 名前 → id）
  const sub = submissionCounts(snapshot.groups, snapshot.submissions);
  const byCategory: CategoryCount[] = CATEGORY_ORDER.flatMap((category) => {
    const gs = snapshot.groups.filter((g) => g.category === category);
    if (gs.length === 0) return [];
    return [{ category, label: CATEGORY_LABELS[category], submitted: gs.filter((g) => sub.submittedGroupIds.has(g.id)).length, total: gs.length }];
  });
  const unsubmitted = sub.unsubmitted;

  // 在庫（使用不可の部屋を除く保管場所。counts.ts）
  const stock = storageCounts(snapshot.rooms, snapshot.roomYears, snapshot.stocks.map((s) => s.room_id));
  const uncounted = stock.uncounted;

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

  // 了承（/swaps と同じ swapRows。今の置き換えがある行だけ。団体の数は状況ごとに数える〔1つの団体に複数の品目の組があれば、
  // それぞれの状況に入る〕。状況ごとの数は counts.ts。ダッシュボードの机椅子は振り分けの行を読まないので、了承の行をそのまま数える）
  const swaps = swapRows(snapshot).filter((r) => r.current > 0);
  const consents = consentGroupCounts(swaps);
  const groupsWhere = (pred: (r: (typeof swaps)[number]) => boolean) => new Set(swaps.filter(pred).map((r) => r.groupId)).size;

  return {
    status,
    requestOpenAt: snapshot.year.request_open_at,
    requestCloseAt: snapshot.year.request_close_at,
    autoAllocatedAt: snapshot.year.auto_allocated_at,
    submissions: {
      submitted: sub.submitted,
      total: sub.total,
      byCategory,
      unsubmitted: unsubmitted.slice(0, DASHBOARD_LIST_LIMIT).map((g) => ({ id: g.id, name: g.name })),
      unsubmittedCount: unsubmitted.length,
      unsubmittedHref: link('/requests?filter=unsubmitted'),
      emptyHref: masterLink('/settings?tab=groups'),
    },
    stocks: {
      counted: stock.counted,
      total: stock.total,
      uncounted: uncounted.slice(0, DASHBOARD_LIST_LIMIT).map((r) => ({ id: r.id, name: r.name, href: link(`/stock?room=${r.id}`) })),
      uncountedCount: uncounted.length,
      emptyHref: masterLink('/settings?tab=rooms'),
    },
    validation: {
      phase,
      errors: count('error'),
      warnings: count('warning'),
      infos: count('info'),
      topCodes: topIssueCodes(issues),
      href: link('/allocation'),
    },
    problems: problemLines(validation.problems, link, masterLink),
    problemsNote: admin
      ? '直すまで確定できません。ルールの設定やマスタ設定を確かめてください。'
      : link('/rules')
        ? '直すまで確定できません。ルールを確かめるか、管理者にマスタの修正を頼んでください。'
        : '直すまで確定できません。ルールは管理者・総務部門長・総務副部門長が、マスタは管理者が直します。',
    consents: {
      groups: consents.groups,
      notAsked: consents.notAsked,
      asked: consents.asked,
      accepted: consents.accepted,
      declined: consents.declined,
      reask: groupsWhere((r) => r.attention === 'reask' || r.attention === 'w102'),
      rerun: groupsWhere((r) => r.attention === 'rerun'),
      href: link('/swaps'),
    },
  };
}

/** 入力の誤りの path の頭 → 直すマスタ設定のタブ */
const MASTER_TABS: ReadonlyMap<string, SettingsTab> = new Map<string, SettingsTab>([
  ['items', 'items'],
  ['rooms', 'rooms'],
  ['groups', 'groups'],
  ['distanceOverrides', 'distance'],
]);

/**
 * 入力の誤り（ルールでないもの）の path の頭から、直すマスタ設定のタブ（toYearData と allocator の createContext の path。
 * 在庫・申請・了承・振り分けの行の誤り〔消えた場所・団体の参照など〕はマスタ設定では直せないので null）。
 *
 * @example
 * masterTabOf('distanceOverrides.0') // 'distance'
 */
export function masterTabOf(path: string): SettingsTab | null {
  return MASTER_TABS.get(path.split('.', 1)[0] ?? '') ?? null;
}

/**
 * 入力の誤りの行：ルールならコードとルールの画面（開ければ）、ほかはマスタの誤りで、管理者にだけ直すタブへのリンク
 * （masterLink。直すタブが決まらなければタブのない /settings）
 */
function problemLines(
  problems: readonly InputError[],
  link: (href: string) => string | null,
  masterLink: (href: string) => string | null,
): ProblemLine[] {
  return problems.map((p) => {
    if (p.ruleCode) return { message: p.message, ruleCode: p.ruleCode, href: link(`/rules?code=${encodeURIComponent(p.ruleCode)}`) };
    const tab = masterTabOf(p.path);
    return { message: p.message, ruleCode: null, href: masterLink(tab ? `/settings?tab=${tab}` : '/settings') };
  });
}
