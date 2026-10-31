// 机椅子の数え方（D-52。04「机椅子の状況」の「ダッシュボードに出すもの」）。机椅子の状況（lib/data/dashboard.ts の
// summarizeDashboard）とダッシュボードの机椅子（portal.ts）が同じ関数で数える（提出した団体・数えた保管場所・了承の状況ごとの
// 団体の数が、2つの画面で食い違わないように）。純粋関数。import は型と packages/shared の並べ方だけ。
import { compareBySortOrder, type ConsentStatus } from '@gaapp/shared';

/** 団体・場所の並べ方に要る列（sort_order → 名前 → id。CLAUDE.md の約束） */
interface Ordered {
  id: string;
  name: string;
  sort_order: number;
}

const byOrder = (a: Ordered, b: Ordered): number =>
  compareBySortOrder({ id: a.id, name: a.name, sortOrder: a.sort_order }, { id: b.id, name: b.name, sortOrder: b.sort_order });

export interface SubmissionCounts<G> {
  /** 提出した団体（submitted_at が空でない提出の記録がある団体）の数 */
  submitted: number;
  /** 団体の数 */
  total: number;
  /** 提出した団体の id（groups にある団体だけ） */
  submittedGroupIds: ReadonlySet<string>;
  /** 提出していない団体（sort_order → 名前 → id の順） */
  unsubmitted: G[];
}

/**
 * 申請の提出（団体ごと）。submitted_at が null の記録は未提出、groups にない団体の記録は数えない。
 *
 * @example
 * const s = submissionCounts(groups, submissions); // s.submitted／s.total 団体が提出
 */
export function submissionCounts<G extends Ordered>(
  groups: readonly G[],
  submissions: readonly { group_id: string; submitted_at: string | null }[],
): SubmissionCounts<G> {
  const done = new Set(submissions.filter((s) => s.submitted_at !== null).map((s) => s.group_id));
  const submitted = groups.filter((g) => done.has(g.id));
  return {
    submitted: submitted.length,
    total: groups.length,
    submittedGroupIds: new Set(submitted.map((g) => g.id)),
    unsubmitted: groups.filter((g) => !done.has(g.id)).sort(byOrder),
  };
}

export interface StorageCounts<R> {
  /** 在庫を数えた保管場所（その年度の在庫の行が1つ以上ある）の数 */
  counted: number;
  /** 保管場所の数（使用不可の部屋を除く） */
  total: number;
  /** まだ数えていない保管場所（validate の W104 と同じ。場所の並び） */
  uncounted: R[];
}

/**
 * 在庫を数えた保管場所。保管場所（is_storage）のうち、今年の使用（room_years）で usable が false でない場所を数える
 * （行がなければ使用可）。stockRoomIds は在庫の行の room_id（重なってよい）。
 */
export function storageCounts<R extends Ordered & { is_storage: boolean }>(
  rooms: readonly R[],
  roomYears: readonly { room_id: string; usable: boolean }[],
  stockRoomIds: Iterable<string>,
): StorageCounts<R> {
  const unusable = new Set(roomYears.filter((r) => !r.usable).map((r) => r.room_id));
  const storages = rooms.filter((r) => r.is_storage && !unusable.has(r.id)).sort(byOrder);
  const counted = new Set(stockRoomIds);
  const uncounted = storages.filter((r) => !counted.has(r.id));
  return { counted: storages.length - uncounted.length, total: storages.length, uncounted };
}

export interface ConsentGroupCounts {
  /** 行のある団体の数 */
  groups: number;
  /** その状況の行がある団体の数（1つの団体に品目の組が複数あれば、それぞれの状況に入る） */
  notAsked: number;
  asked: number;
  accepted: number;
  declined: number;
}

/**
 * キャスター机交換の了承の状況ごとの団体の数。机椅子の状況はキャスター机交換の一覧の行（swapRows）のうち今の置き換えがある
 * ものを、ダッシュボードは了承の行（substitution_consents）をそのまま渡す（振り分けの行を読まないため。D-52）。
 */
export function consentGroupCounts(rows: readonly { groupId: string; status: ConsentStatus }[]): ConsentGroupCounts {
  const groupsWhere = (pred: (r: { status: ConsentStatus }) => boolean) => new Set(rows.filter(pred).map((r) => r.groupId)).size;
  return {
    groups: groupsWhere(() => true),
    notAsked: groupsWhere((r) => r.status === 'not_asked'),
    asked: groupsWhere((r) => r.status === 'asked'),
    accepted: groupsWhere((r) => r.status === 'accepted'),
    declined: groupsWhere((r) => r.status === 'declined'),
  };
}
