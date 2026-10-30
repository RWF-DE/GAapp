// Googleフォームの回答 CSV の取り込み（申請一覧の「Googleフォームの回答を取り込む」。画面の設計 5 章。T11）。
// importer（T05）の parseFormCsv・resolveResponses を呼ぶだけで、取り込みのロジック（列の対応・団体名の対応・古い回答・
// 長机の読み替え・メールの除去）は変えない。ここは、プレビューに出す形の組み立てと、団体ごとの保存の rows を作る。
// ファイルの中身はログに出さず、どこにも保存しない（呼ぶ側の画面の状態にだけ持ち、ダイアログを閉じたら消す）。
import {
  ImportFormatError,
  parseFormCsv,
  resolveResponses,
  type FormKind,
  type ImportGroup,
  type ParsedForm,
  type ParsedFormResponse,
  type RejectReason,
  type ResolvedForm,
} from '@gaapp/importer';
import { rewriteRequestedItem, type GroupCategory, type Item } from '@gaapp/shared';
import type { GroupRow, ItemRow, SubmissionRow } from '@/lib/db/types';
import { AppError, appError, toAppError } from '@/lib/errors';
import { callRpc } from '@/lib/rpc';
import { NOTE_MAX } from '@/lib/schemas/common';
import { fetchSubmission, isRequestable, sortGroups, sortItems, type RequestsTables } from './requests';

export type { FormKind, RejectReason };

/** 取り込めるフォームの種類（並び順） */
export const IMPORT_KINDS: readonly FormKind[] = ['stall', 'department', 'company'];

/** フォームの種類 → 対応させる団体の区分（模擬店のフォーム → stall、部門 → department、企業 → company） */
export const KIND_CATEGORY: Record<FormKind, GroupCategory> = { stall: 'stall', department: 'department', company: 'company' };

export const KIND_LABELS: Record<FormKind, string> = { stall: '模擬店', department: '部門', company: '企業' };

/** 取り込まない行の理由（中身は持たない） */
export const REJECT_LABELS: Record<RejectReason, string> = {
  misaligned: '列のずれ',
  invalid_number: '数が読めない',
  invalid_timestamp: '日時が読めない',
  empty: '空の行',
};

// ---------------------------------------------------------------- 読み取りと対応

/** importer に渡す品目（parseFormCsv は code と aliases、resolveResponses は shared の Item） */
export function toImportItems(items: readonly ItemRow[]): (Item & { aliases: string[] })[] {
  return sortItems(items).map((i) => ({
    id: i.id,
    code: i.code,
    name: i.name,
    aliases: [...i.aliases],
    requestableCategories: [...i.requestable_categories],
    sortOrder: i.sort_order,
  }));
}

/** その種類の区分の団体だけ（並び順。resolveResponses と、手で選ぶ欄の選択肢） */
export function groupsForKind(groups: readonly GroupRow[], kind: FormKind): GroupRow[] {
  return sortGroups(groups).filter((g) => g.category === KIND_CATEGORY[kind]);
}

function toImportGroups(groups: readonly GroupRow[]): ImportGroup[] {
  return groups.map((g) => ({ id: g.id, name: g.name, aliases: [...g.aliases], category: g.category }));
}

export type ReadResult = { ok: true; parsed: ParsedForm } | { ok: false; message: string };

/**
 * CSV の文字列を読む（parseFormCsv）。見出しが合わない・引用符が閉じていないなどの ImportFormatError は、その message を返す
 * （元の値を含まない）。ほかの例外は中身を出さずに決まった文言にする。
 */
export function readForm(kind: FormKind, text: string, items: readonly ItemRow[]): ReadResult {
  try {
    return { ok: true, parsed: parseFormCsv(kind, text, toImportItems(items)) };
  } catch (e) {
    if (e instanceof ImportFormatError) return { ok: false, message: e.message };
    return { ok: false, message: 'CSV を読めませんでした（Googleフォームの回答の CSV か確かめてください）' };
  }
}

/** 団体に対応させる（resolveResponses。manual は行番号 → 団体 id。選び直すたびに呼び直す） */
export function resolveForm(
  parsed: ParsedForm,
  kind: FormKind,
  t: Pick<RequestsTables, 'groups' | 'items'>,
  manual: Readonly<Record<number, string>> = {},
): ResolvedForm {
  return resolveResponses(parsed, toImportGroups(groupsForKind(t.groups, kind)), toImportItems(t.items), manual);
}

// ---------------------------------------------------------------- プレビュー

/**
 * 団体 → 対応した行の行番号（resolveResponses は行番号を返さないので、回答を1件ずつ resolveResponses に通して引く。
 * 対応のしかたは importer と同じになる）。古い回答のない団体の「使う行」に使う。
 */
export function rowsByGroup(
  parsed: ParsedForm,
  kind: FormKind,
  t: Pick<RequestsTables, 'groups' | 'items'>,
  manual: Readonly<Record<number, string>> = {},
): Map<string, number[]> {
  const groups = toImportGroups(groupsForKind(t.groups, kind));
  const items = toImportItems(t.items);
  const out = new Map<string, number[]>();
  for (const r of parsed.responses) {
    const one = resolveResponses({ ...parsed, responses: [r], rejected: [] }, groups, items, manual);
    const gid = one.submissions[0]?.groupId;
    if (gid) out.set(gid, [...(out.get(gid) ?? []), r.rowNumber]);
  }
  return out;
}

/** 数の要約（「机(木)4・椅子(木)8」。0 の品目は出さない。並びは品目の並び順） */
export function countsSummary(counts: Readonly<Record<string, number>>, items: readonly ItemRow[]): string {
  const parts = sortItems(items)
    .filter((i) => (counts[i.code] ?? 0) > 0)
    .map((i) => `${i.name}${counts[i.code]}`);
  return parts.length ? parts.join('・') : 'すべて 0';
}

/** 対応しない行（手で団体を選ぶ。手で選ぶ前の resolveResponses の unmatched から作る） */
export interface UnmatchedRow {
  rowNumber: number;
  /** フォームの団体名（企業・空・メールだけの名前は null） */
  groupName: string | null;
  submittedAt: string;
  summary: string;
}

export function unmatchedRows(parsed: ParsedForm, base: ResolvedForm, items: readonly ItemRow[]): UnmatchedRow[] {
  const byRow = new Map(parsed.responses.map((r) => [r.rowNumber, r]));
  return base.unmatched.map((u) => {
    const r = byRow.get(u.rowNumber)!;
    return { rowNumber: u.rowNumber, groupName: u.groupName, submittedAt: r.submittedAt, summary: countsSummary(r.counts, items) };
  });
}

/** 古い回答（団体ごとに、使う行と使わない行） */
export interface SupersededGroup {
  group: GroupRow;
  kept: { rowNumber: number; submittedAt: string };
  dropped: { rowNumber: number; submittedAt: string }[];
}

/** 新しい回答が読めない団体（同じ団体の、使う回答より新しい行が取り込まない行になった。importer の newerRejected） */
export interface NewerRejectedGroup {
  group: GroupRow;
  /** 使う候補の回答（読めた回答のうち一番新しいもの） */
  kept: { rowNumber: number; submittedAt: string };
  /** それより古い回答 */
  dropped: { rowNumber: number; submittedAt: string }[];
  /** 使う候補より新しい、取り込まない行（行番号・理由・タイムスタンプだけ。中身は出さない） */
  rows: { rowNumber: number; reason: RejectReason; submittedAt: string }[];
}

/** プレビューの1セル（品目ごとの CSV の数と今の DB の数） */
export interface PlanCell {
  item: ItemRow;
  /** CSV の数（読み替えの後。申請できない品目は 0） */
  csv: number;
  /**
   * 取り込んだ後の DB の数（プレビューに出す数）。申請できる品目は CSV の数、申請できない品目は 0（DB に行があれば 0 を送る）。
   * ただし blocked の品目は送らないので、今の DB の数のまま。
   */
  after: number;
  /** 申請できない品目（読み替え先なし）に CSV の 0 でない数がある（送らない。DB の数は変えない） */
  blocked: boolean;
  /** 今の DB の数（行がなければ 0） */
  db: number;
  /** DB の行の updated_at（行がなければ null） */
  updatedAt: string | null;
  /** その団体の区分で申請できる品目か */
  requestable: boolean;
}

/** 団体ごとの結果（プレビューと保存） */
export interface ImportPlan {
  group: GroupRow;
  /** フォームのタイムスタンプ（+09:00 の ISO。提出日時として保存する） */
  submittedAt: string;
  /** フォームの備考（メールは importer が除いた後。2000 字を超えていても切る前の値。送るときは toImportArgs が切る） */
  note: string | null;
  /** 備考の文字の数（コードポイントで数える。DB の length と同じ）。備考がなければ 0 */
  noteLength: number;
  /** 備考が 2000 字（NOTE_MAX）を超えている（送るときは 2000 字に切る。超えたまま送ると DB がその団体全体を invalid_input で拒否する） */
  noteTruncated: boolean;
  /** 使う行（CSV の行番号） */
  rowNumber: number;
  cells: PlanCell[];
  /** CSV と今の DB で数が違う品目がある */
  changed: boolean;
  /** 企業以外の長机(3人掛)を長机(2人掛)に読み替えた */
  rewritten: boolean;
  /** 申請できない品目（読み替え先なし）の申請。送らない（送ると DB が E006 でその団体の全部を拒否するため） */
  blocked: { item: ItemRow; count: number }[];
  /** 今の DB の提出日時（未提出は null） */
  dbSubmittedAt: string | null;
  /**
   * プレビューを作ったときの提出の記録（記録がなければ null）。保存の直前に読み直して比べ、変わっていればその団体は送らない
   * （p_rows の楽観ロックは requests の行にしかかからず、数を変えない出し直し・備考だけの変更・「提出済みにする」はすり抜けるため。2.3・Q2）
   */
  dbSubmission: SubmissionRow | null;
  /** 今の DB に備考があるか */
  dbHasNote: boolean;
  /** 上書きの既定（Q2：CSV のタイムスタンプが DB の提出日時より新しい、または未提出なら上書き。newerRejected があれば上書きしない） */
  defaultOverwrite: boolean;
  /**
   * 同じ団体の、使う回答（rowNumber）より新しい取り込まない行。あれば一番新しい回答が読めないので、既定では上書きしない
   * （管理者が選べば rowNumber の回答で上書きする）
   */
  newerRejected: NewerRejectedGroup['rows'];
  /** CSV のタイムスタンプと DB の提出日時が同じ時刻（同じ CSV を取り込み直した。既定では上書きしない） */
  sameTimestamp: boolean;
}

export interface ImportPreview {
  /** 回答の数（取り込まない行を除く） */
  responseCount: number;
  /** 対応した回答の数 */
  matchedCount: number;
  unmatched: UnmatchedRow[];
  rejected: ParsedForm['rejected'];
  /** 取り込まない行の理由ごとの数 */
  rejectedByReason: Partial<Record<RejectReason, number>>;
  superseded: SupersededGroup[];
  /** 古い回答の数（使わない行の数） */
  supersededCount: number;
  /** 新しい回答が読めない団体（団体ごとの結果にも出し、既定では上書きしない） */
  newerRejected: NewerRejectedGroup[];
  ignoredColumns: string[];
  plans: ImportPlan[];
}

/** 長机などの読み替え（S03）が kept の回答で起きたか */
function hasRewrite(response: ParsedFormResponse, category: GroupCategory, items: readonly Item[]): boolean {
  return Object.entries(response.counts).some(([code, n]) => {
    if (n <= 0) return false;
    const to = rewriteRequestedItem(code, category, items);
    return to !== null && to !== code;
  });
}

/** Q2 の既定：DB が未提出か、CSV のタイムスタンプが DB の提出日時より新しいときだけ上書きする */
export function defaultOverwriteOf(csvSubmittedAt: string, dbSubmittedAt: string | null): boolean {
  if (!dbSubmittedAt) return true;
  return Date.parse(csvSubmittedAt) > Date.parse(dbSubmittedAt);
}

/** CSV のタイムスタンプと DB の提出日時が同じ時刻か（取り込み済み。書き方の違いは同じ時刻として扱う） */
export function sameTimestampOf(csvSubmittedAt: string, dbSubmittedAt: string | null): boolean {
  return dbSubmittedAt !== null && Date.parse(csvSubmittedAt) === Date.parse(dbSubmittedAt);
}

/** 文字の数（コードポイント。DB の length と同じ数え方。サロゲートペアを2字と数えない） */
const charLength = (s: string): number => Array.from(s).length;

/** 備考を 2000 字（NOTE_MAX）に切る（コードポイントで切る。サロゲートペアを割らない） */
export function truncateNote(note: string | null): string | null {
  if (note === null || charLength(note) <= NOTE_MAX) return note;
  return Array.from(note).slice(0, NOTE_MAX).join('');
}

/**
 * プレビューを作る（manual は手で選んだ対応。選び直すたびに呼び直す。純粋関数で速い）。
 * 対応しない行の一覧は手で選ぶ前の結果から作る（選んだ後も行は一覧に残し、選び直せる）。古い回答と団体ごとの結果は、選んだ後の結果から作る。
 */
export function buildImportPreview(
  parsed: ParsedForm,
  kind: FormKind,
  t: RequestsTables,
  manual: Readonly<Record<number, string>> = {},
): ImportPreview {
  const base = resolveForm(parsed, kind, t);
  const resolved = resolveForm(parsed, kind, t, manual);
  const category = KIND_CATEGORY[kind];
  const items = sortItems(t.items);
  const importItems = toImportItems(t.items);
  const byRow = new Map(parsed.responses.map((r) => [r.rowNumber, r]));
  const groupById = new Map(t.groups.map((g) => [g.id, g]));
  const subs = new Map(t.submissions.map((s) => [s.group_id, s]));
  const dbReq = new Map(t.requests.map((r) => [`${r.group_id}:${r.item_id}`, r]));
  // 新しい回答が読めない団体も、団体ごとの結果には出す（使う候補の回答の数で。既定では上書きしない）
  const csvReq = new Map(
    [...resolved.requests, ...resolved.newerRejected.flatMap((n) => n.requests)].map((r) => [`${r.groupId}:${r.itemId}`, r.count]),
  );
  const supersededByGroup = new Map(resolved.superseded.map((s) => [s.groupId, s]));
  const newerByGroup = new Map(resolved.newerRejected.map((n) => [n.groupId, n]));
  const rowsOf = rowsByGroup(parsed, kind, t, manual);
  // 団体の順（resolveResponses に渡した団体の並び＝sort_order → 名前 → id）
  const order = new Map(groupsForKind(t.groups, kind).map((g, i) => [g.id, i]));
  const submissions = [...resolved.submissions, ...resolved.newerRejected.map((n) => n.submission)].sort(
    (a, b) => (order.get(a.groupId) ?? 0) - (order.get(b.groupId) ?? 0),
  );

  const plans: ImportPlan[] = [];
  for (const s of submissions) {
    const group = groupById.get(s.groupId);
    if (!group) continue;
    const sup = supersededByGroup.get(s.groupId);
    const newer = newerByGroup.get(s.groupId);
    const rowNumber = newer?.keptRow ?? sup?.keptRow ?? rowsOf.get(s.groupId)?.[0] ?? 0;
    const kept = byRow.get(rowNumber);
    const cells: PlanCell[] = [];
    const blocked: ImportPlan['blocked'] = [];
    for (const item of items) {
      const requestable = isRequestable(item, category);
      const key = `${group.id}:${item.id}`;
      const csv = csvReq.get(key) ?? 0;
      const db = dbReq.get(key);
      const isBlocked = !requestable && csv > 0;
      if (isBlocked) blocked.push({ item, count: csv });
      const dbCount = db?.count ?? 0;
      cells.push({
        item,
        csv: requestable ? csv : 0,
        // blocked は送らないので DB の数のまま。申請できない品目は 0 を送る（行がなければ 0 のまま）
        after: requestable ? csv : isBlocked ? dbCount : 0,
        blocked: isBlocked,
        db: dbCount,
        updatedAt: db?.updated_at ?? null,
        requestable,
      });
    }
    const sub = subs.get(group.id) ?? null;
    const dbSubmittedAt = sub?.submitted_at ?? null;
    const noteLength = s.note ? charLength(s.note) : 0;
    plans.push({
      group,
      submittedAt: s.submittedAt,
      note: s.note,
      noteLength,
      noteTruncated: noteLength > NOTE_MAX,
      rowNumber,
      cells,
      changed: cells.some((c) => c.after !== c.db),
      rewritten: kept ? hasRewrite(kept, category, importItems) : false,
      blocked,
      dbSubmittedAt,
      dbSubmission: sub,
      dbHasNote: !!sub?.note?.trim(),
      defaultOverwrite: !newer && defaultOverwriteOf(s.submittedAt, dbSubmittedAt),
      sameTimestamp: sameTimestampOf(s.submittedAt, dbSubmittedAt),
      newerRejected: newer?.rejectedRows ?? [],
    });
  }

  const superseded: SupersededGroup[] = resolved.superseded.flatMap((s) => {
    const group = groupById.get(s.groupId);
    if (!group) return [];
    const at = (n: number) => byRow.get(n)?.submittedAt ?? '';
    return [{ group, kept: { rowNumber: s.keptRow, submittedAt: at(s.keptRow) }, dropped: s.droppedRows.map((n) => ({ rowNumber: n, submittedAt: at(n) })) }];
  });
  const newerRejected: NewerRejectedGroup[] = resolved.newerRejected.flatMap((n) => {
    const group = groupById.get(n.groupId);
    if (!group) return [];
    const at = (r: number) => byRow.get(r)?.submittedAt ?? '';
    return [
      {
        group,
        kept: { rowNumber: n.keptRow, submittedAt: at(n.keptRow) },
        dropped: n.droppedRows.map((r) => ({ rowNumber: r, submittedAt: at(r) })),
        rows: n.rejectedRows,
      },
    ];
  });
  const rejectedByReason: Partial<Record<RejectReason, number>> = {};
  for (const r of parsed.rejected) rejectedByReason[r.reason] = (rejectedByReason[r.reason] ?? 0) + 1;

  return {
    responseCount: parsed.responses.length,
    matchedCount: parsed.responses.length - resolved.unmatched.length,
    unmatched: unmatchedRows(parsed, base, items),
    rejected: parsed.rejected,
    rejectedByReason,
    superseded,
    supersededCount: superseded.reduce((n, s) => n + s.dropped.length, 0),
    newerRejected,
    ignoredColumns: parsed.ignoredColumns,
    plans,
  };
}

// ---------------------------------------------------------------- 保存

/** 保存に送る p_rows（その団体の区分で申請できる品目と、DB に行がある品目のすべて。CSV になければ 0。申請できない品目の CSV の数は送らない） */
export function toImportRows(plan: Pick<ImportPlan, 'cells'>): { itemId: string; count: number; updatedAt?: string }[] {
  return plan.cells
    .filter((c) => !c.blocked && (c.requestable || c.updatedAt !== null))
    .map((c) => ({ itemId: c.item.id, count: c.after, ...(c.updatedAt ? { updatedAt: c.updatedAt } : {}) }));
}

/** update_requests_after_deadline の引数（p_submission にフォームのタイムスタンプと備考。備考は 2000 字に切る） */
export function toImportArgs(plan: ImportPlan, reason: string) {
  return {
    p_group_id: plan.group.id,
    p_rows: toImportRows(plan),
    p_reason: reason,
    p_submission: { submittedAt: plan.submittedAt, note: truncateNote(plan.note) },
  };
}

/**
 * 理由の既定（「Googleフォームの回答の取り込み（模擬店）」）。理由は audit_logs に残り続けるので、ファイル名（人の名前が入りうる）は
 * 入れない。
 */
export function defaultImportReason(kind: FormKind): string {
  return `Googleフォームの回答の取り込み（${KIND_LABELS[kind]}）`;
}

export type ImportResult = { groupId: string; ok: true } | { groupId: string; ok: false; error: AppError };

const msOf = (iso: string | null | undefined): number | null => {
  if (!iso) return null;
  const t = Date.parse(iso);
  return Number.isNaN(t) ? null : t;
};

/** 提出の記録が変わったか（記録ができた・消えた、updated_at・提出日時・備考のどれかが違う。時刻の書き方の違いは同じとみなす） */
export function submissionChanged(
  base: Pick<SubmissionRow, 'submitted_at' | 'note' | 'updated_at'> | null,
  fresh: Pick<SubmissionRow, 'submitted_at' | 'note' | 'updated_at'> | null,
): boolean {
  if (!base || !fresh) return base !== fresh;
  return (
    msOf(base.updated_at) !== msOf(fresh.updated_at) ||
    msOf(base.submitted_at) !== msOf(fresh.submitted_at) ||
    (base.note ?? null) !== (fresh.note ?? null)
  );
}

export interface SaveImportDeps {
  /** 提出の記録を読み直す（テストで差し替える） */
  fetchSubmission?: (groupId: string) => Promise<SubmissionRow | null>;
}

/**
 * 団体ごとに順に update_requests_after_deadline を呼ぶ（締切の前後によらない。提出日時を残すため。D-29）。
 * 各団体を送る直前に提出の記録を読み直し、プレビューを作ったときから変わっていれば送らずに conflict とする（2.3・Q2。
 * p_submission には楽観ロックがないので、数を変えない出し直しや「提出済みにする」を黙って CSV の値に戻さないため。
 * 読み直した表でプレビューを作り直すと、Q2 の既定がその記録で決め直される）。
 * forbidden・state（権限・年度の状態が変わった）が出たら、残りは送らずに止める（止めた団体は結果に入らない）。
 */
export async function saveImport(plans: readonly ImportPlan[], reason: string, deps: SaveImportDeps = {}): Promise<ImportResult[]> {
  const readSubmission = deps.fetchSubmission ?? ((groupId: string) => fetchSubmission(groupId));
  const out: ImportResult[] = [];
  for (const plan of plans) {
    try {
      const fresh = await readSubmission(plan.group.id);
      if (submissionChanged(plan.dbSubmission, fresh)) {
        out.push({ groupId: plan.group.id, ok: false, error: appError('conflict', 'submission_changed') });
        continue;
      }
      await callRpc('update_requests_after_deadline', toImportArgs(plan, reason));
      out.push({ groupId: plan.group.id, ok: true });
    } catch (e) {
      const error = toAppError(e);
      out.push({ groupId: plan.group.id, ok: false, error });
      if (error.info.kind === 'forbidden' || error.info.kind === 'state') break;
    }
  }
  return out;
}
