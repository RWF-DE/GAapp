import type { Database } from '@gaapp/shared';

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

/** ログインしている人の、今の年度での立場 */
export interface Membership {
  displayName: string | null;
  /** 今の年度。招待されていなければ null */
  year: YearSummary | null;
  /** 今の年度のロール（なければ null） */
  role: AppRole | null;
  /** 今の年度で代表を務める団体 */
  groups: GroupSummary[];
}

export interface MembershipSource {
  displayName: string | null;
  years: YearSummary[];
  roles: { year_id: string; role: AppRole }[];
  groups: GroupSummary[];
}

/**
 * 今の年度を決める：ロールか団体代表の行がある年度のうち、1日目が最も遅いもの（同じなら年度名・id の順）。
 * 年度の選び方（K-19）は T09 で見直す。ここでは、ロールのある最新の年度を開く。
 */
export function pickCurrentYear(source: MembershipSource): YearSummary | null {
  const mine = new Set<string>([...source.roles.map((r) => r.year_id), ...source.groups.map((g) => g.year_id)]);
  const candidates = source.years.filter((y) => mine.has(y.id));
  candidates.sort(
    (a, b) =>
      b.festival_start.localeCompare(a.festival_start) || b.label.localeCompare(a.label) || b.id.localeCompare(a.id),
  );
  return candidates[0] ?? null;
}

export function buildMembership(source: MembershipSource): Membership {
  const year = pickCurrentYear(source);
  if (!year) return { displayName: source.displayName, year: null, role: null, groups: [] };
  return {
    displayName: source.displayName,
    year,
    role: source.roles.find((r) => r.year_id === year.id)?.role ?? null,
    groups: source.groups
      .filter((g) => g.year_id === year.id)
      .sort((a, b) => a.name.localeCompare(b.name, 'ja') || a.id.localeCompare(b.id)),
  };
}

/** 招待されているか（どこかの年度にロールか団体代表の行がある） */
export function isInvited(m: Membership): boolean {
  return m.year !== null;
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
