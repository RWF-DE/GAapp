import type { Database } from '@gaapp/shared';
import type { YearRow } from '../db/types';

export type AppRole = Database['public']['Enums']['app_role'];
export type YearStatus = Database['public']['Enums']['year_status'];

/** 画面の出し分けに使う立場。ロール（admin・staff・viewer）と団体代表（rep） */
export type Audience = AppRole | 'rep';

export interface YearSummary {
  id: string;
  label: string;
  status: YearStatus;
  festival_start: string;
}

export interface GroupSummary {
  id: string;
  name: string;
  year_id: string;
}

/** ログインしている人の、今の年度（開いている年度）での立場 */
export interface Membership {
  displayName: string | null;
  /** 今の年度（そのタブで選んだ年度か、既定の最新の年度）。招待されていなければ null */
  year: YearSummary | null;
  /** 今の年度のロール（なければ null） */
  role: AppRole | null;
  /** 今の年度で代表を務める団体 */
  groups: GroupSummary[];
  /** 自分の年度（ロールか団体代表の行がある年度。1日目の新しい順）。2つ以上ならヘッダーに年度の選択を出す（D-31） */
  years: YearSummary[];
  /** 最新の年度（自分の年度のうち1日目が最も遅いもの。既定で開く年度） */
  latestYear: YearSummary | null;
  /** 状態が closed でない年度のどれかで admin か（年度をまたぐ表〔場所・品目・距離〕を書ける。D-01） */
  adminOfOpenYear: boolean;
}

export interface MembershipSource {
  displayName: string | null;
  years: YearSummary[];
  /** 立場と一緒に読んだ年度の行（年度の行のキャッシュに入れる。D-45）と、その読み取りを送った時刻 */
  yearRows?: { rows: YearRow[]; readStartedAt: number };
  roles: { year_id: string; role: AppRole }[];
  groups: GroupSummary[];
}

const byFestivalDesc = (a: YearSummary, b: YearSummary) =>
  b.festival_start.localeCompare(a.festival_start) || b.label.localeCompare(a.label) || b.id.localeCompare(a.id);

/** 自分の年度（ロールか団体代表の行がある年度）を1日目の新しい順に（同じなら年度名・id の逆順） */
export function myYears(source: MembershipSource): YearSummary[] {
  const mine = new Set<string>([...source.roles.map((r) => r.year_id), ...source.groups.map((g) => g.year_id)]);
  return source.years.filter((y) => mine.has(y.id)).sort(byFestivalDesc);
}

/** 既定の年度（最新の年度）：ロールか団体代表の行がある年度のうち、1日目が最も遅いもの（同じなら年度名・id の順） */
export function pickCurrentYear(source: MembershipSource): YearSummary | null {
  return myYears(source)[0] ?? null;
}

/**
 * 立場を組み立てる。selectedYearId（そのタブで選んだ年度。sessionStorage）が自分の年度にあればその年度を開き、
 * なければ（選んでいない・ロールも団体代表もなくなった・消えた年度）既定の最新の年度を開く（D-31）。
 */
export function buildMembership(source: MembershipSource, selectedYearId?: string | null): Membership {
  const years = myYears(source);
  const latestYear = years[0] ?? null;
  const adminOfOpenYear = source.roles.some(
    (r) => r.role === 'admin' && source.years.some((y) => y.id === r.year_id && y.status !== 'closed'),
  );
  const year = (selectedYearId ? years.find((y) => y.id === selectedYearId) : undefined) ?? latestYear;
  if (!year) return { displayName: source.displayName, year: null, role: null, groups: [], years, latestYear, adminOfOpenYear };
  return {
    displayName: source.displayName,
    year,
    role: source.roles.find((r) => r.year_id === year.id)?.role ?? null,
    groups: source.groups
      .filter((g) => g.year_id === year.id)
      .sort((a, b) => a.name.localeCompare(b.name, 'ja') || a.id.localeCompare(b.id)),
    years,
    latestYear,
    adminOfOpenYear,
  };
}

/** 招待されているか（どこかの年度にロールか団体代表の行がある） */
export function isInvited(m: Membership): boolean {
  return m.year !== null;
}

/** 開いている年度が最新の年度か（招待されていなければ真） */
export function isLatestYear(m: Membership): boolean {
  return !m.year || !m.latestYear || m.year.id === m.latestYear.id;
}

/**
 * 書き込む画面（在庫入力・申請・了承の回答）の「最新の年度に切り替える」の行き先。
 * 最新の年度が終了していれば、切り替えても書けないので null。
 */
export function latestWritableYear(m: Membership): YearSummary | null {
  return m.latestYear && m.latestYear.status !== 'closed' ? m.latestYear : null;
}

/** 今の年度での立場の一覧（ロールと団体代表は兼ねられる） */
export function audiencesOf(m: Membership): Audience[] {
  const a: Audience[] = [];
  if (m.role) a.push(m.role);
  if (m.groups.length > 0) a.push('rep');
  return a;
}

export function hasAudience(m: Membership, allowed: readonly Audience[]): boolean {
  return audiencesOf(m).some((a) => allowed.includes(a));
}

export const ROLE_LABELS: Record<AppRole, string> = {
  admin: '総務管理者',
  staff: '総務部員',
  viewer: '閲覧のみ',
};

export const YEAR_STATUS_LABELS: Record<YearStatus, string> = {
  preparing: '準備中',
  requesting: '申請受付中',
  allocating: '振り分け中',
  confirmed: '確定',
  closed: '終了',
};

/** 年度の選択肢の文字（「R9（準備中）」） */
export function yearOptionLabel(y: Pick<YearSummary, 'label' | 'status'>): string {
  return `${y.label}（${YEAR_STATUS_LABELS[y.status]}）`;
}
