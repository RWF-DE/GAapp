// 提出物がダッシュボード（/）に出すもの（D-52・D-55。04「提出状況」の節の後の「ダッシュボードに出すもの（提出物）」、notes/T19.md
// 「パート B・C の約束」9。T19）。
// - 欄：総務に要対応・締切と予定・機能ごとのカード、店長・副店長に要対応・締切と予定。お知らせの欄には出さない。閲覧のみには何も出さず、
//   何も読まない（Q5。kinds に viewer を入れない）。年度の行だけで決まる項目はない（fromYear なし）。
// - 読む：reads.ts の軽い読み取り（総務は提出物の id・題名・締切と提出の状況〔document_id・status〕、部門長以上は加えて使った量、
//   店長・副店長は代表する団体の提出の状況〔題名・締切・理由つき〕）。版・振り分けの行は読まない。
// - 時刻は ctx.now（ダッシュボードを開いた時刻）。締切ちょうどは過ぎた側（deadline ≤ now）。24 時間は 86,400,000 ms。
// - 終了した年度：要対応は片付けていないファイルと年度のファイルの2つだけ、締切と予定は締切が今より後のものだけ。カードは出す。
// - 行き先はどれも canOpen で確かめる（開けない要対応は作らない。締切と予定は開けなければリンクにしない）。締切と予定の行き先は人の立場
//   （audiences）で決めるので、兼ねた人の総務と店長・副店長の分は同じ id・同じ中身になる（mergePortalSections が1つにする）。
// 読み取りの結果を使う欄は要対応・締切と予定・カード（query.widgets）なので、提出物の読み込み中・失敗はこの3つの欄に提出物の分だけ出る
// （「提出物：{文言}」と「もう一度」は今の部品）。締切と予定の一覧（/calendar）の機能の日付にも同じ締切が出る（moduleDateProviders）。
import { isAdmin, isLead } from '@/lib/auth/roles';
import { formatShortDateTime } from '@/lib/datetime';
import { canOpen } from '@/lib/navigation';
import {
  moduleLabel,
  portalQueryOptions,
  type DatedItem,
  type ModuleCardModel,
  type PortalContext,
  type PortalProvider,
  type PortalSection,
  type TodoItem,
} from '../portal';
import type { ModuleId } from '../registry';
import { formatFileSize } from './files';
import { statusOf, type DocumentStatus } from './labels';
import { documentsRepPortalOptions, documentsSoumuPortalOptions, type DocumentsRepPortalRow, type DocumentsSoumuPortalRaw } from './reads';

const MODULE_ID: ModuleId = 'documents';
const DAY_MS = 24 * 60 * 60 * 1000;

/** 読んだ行（種類つき）。総務は loadDocumentsSoumuPortal、店長・副店長は loadDocumentsRepPortal の結果 */
export type DocumentsPortalRaw = ({ kind: 'soumu' } & DocumentsSoumuPortalRaw) | { kind: 'rep'; rows: readonly DocumentsRepPortalRow[] };

const timeOf = (iso: string): number | null => {
  const t = Date.parse(iso);
  return Number.isNaN(t) ? null : t;
};

/** 締切を過ぎたか（締切ちょうどは過ぎた側。読めない締切は偽） */
const passed = (deadline: string, now: number) => {
  const t = timeOf(deadline);
  return t !== null && t <= now;
};

const isOpen = (s: DocumentStatus) => s === 'not_submitted' || s === 'returned';

/** 要対応を作る（行き先を今の立場で開けなければ作らない） */
function todoBuilder(ctx: PortalContext) {
  const todos: TodoItem[] = [];
  const add = (t: Omit<TodoItem, 'moduleId'>) => {
    if (canOpen(t.href, ctx.audiences, ctx.year.status)) todos.push({ ...t, moduleId: MODULE_ID });
  };
  return { todos, add };
}

/** 締切と予定の1件の材料（提出物と、締切を過ぎてもまだ出すか） */
interface DeadlineSource {
  id: string;
  title: string;
  deadline: string;
  /** 未提出・差し戻しの団体が残っている（総務は全部の団体、店長・副店長は自団体で数える） */
  pending: boolean;
  /** 開けないときの行き先の団体（その提出物の対象の、代表する団体のうち最初のもの） */
  groupId: string | null;
}

/**
 * 締切と予定（提出物ごとに「提出物「{題名}」の締切」）。出すのは、締切が今より後のものと、締切を過ぎて未提出・差し戻しの団体が残っている
 * もの（終了した年度では締切が今より後のものだけ）。行き先は提出状況を開ける立場なら `/documents?document=`、開けなければ
 * `/document?group=&document=`（どちらも開けなければリンクにしない）。
 */
function deadlineItems(sources: readonly DeadlineSource[], ctx: PortalContext): DatedItem[] {
  const closed = ctx.year.status === 'closed';
  const soumuHref = (id: string) => `/documents?document=${id}`;
  const out: DatedItem[] = [];
  for (const s of sources) {
    if (timeOf(s.deadline) === null) continue;
    const over = passed(s.deadline, ctx.now);
    if (over && (closed || !s.pending)) continue;
    const toSoumu = soumuHref(s.id);
    const toRep = s.groupId ? `/document?group=${s.groupId}&document=${s.id}` : null;
    const href = canOpen(toSoumu, ctx.audiences, ctx.year.status)
      ? toSoumu
      : toRep && canOpen(toRep, ctx.audiences, ctx.year.status)
        ? toRep
        : null;
    out.push({
      id: `documents:deadline:${s.id}`,
      moduleId: MODULE_ID,
      title: `提出物「${s.title}」の締切`,
      at: s.deadline,
      kind: 'deadline',
      ...(href ? { href } : {}),
    });
  }
  return out;
}

/** 総務の数（団体 × その団体が対象の提出物で数える） */
interface SoumuCounts {
  total: number;
  approved: number;
  submitted: number;
  returned: number;
  notSubmitted: number;
  /** 未提出・差し戻しのまま締切を過ぎた */
  overdue: number;
  /** 提出物ごとの、未提出・差し戻しの団体があるか */
  pendingDocs: Set<string>;
}

function soumuCounts(raw: DocumentsSoumuPortalRaw, now: number): SoumuCounts {
  const deadlines = new Map(raw.docs.map((d) => [d.id, d.deadline]));
  const c: SoumuCounts = { total: 0, approved: 0, submitted: 0, returned: 0, notSubmitted: 0, overdue: 0, pendingDocs: new Set() };
  for (const row of raw.statuses) {
    const status = statusOf(row.status);
    c.total++;
    if (status === 'approved') c.approved++;
    else if (status === 'submitted') c.submitted++;
    else if (status === 'returned') c.returned++;
    else c.notSubmitted++;
    if (isOpen(status)) {
      c.pendingDocs.add(row.document_id);
      const deadline = deadlines.get(row.document_id);
      if (deadline !== undefined && passed(deadline, now)) c.overdue++;
    }
  }
  return c;
}

/** 総務の要対応（終了した年度では、片付けていないファイルと年度のファイルだけ） */
function soumuTodos(raw: DocumentsSoumuPortalRaw, counts: SoumuCounts, ctx: PortalContext): TodoItem[] {
  const { todos, add } = todoBuilder(ctx);
  const closed = ctx.year.status === 'closed';
  const lead = isLead(ctx.role);
  if (!closed && lead && counts.submitted > 0) {
    add({
      id: 'documents:lead:submitted',
      title: `承認待ち ${counts.submitted} 件`,
      count: counts.submitted,
      severity: 'normal',
      href: '/documents?status=submitted',
    });
  }
  if (!closed && counts.overdue > 0) {
    add({
      id: 'documents:soumu:overdue',
      title: `締切を過ぎた未提出 ${counts.overdue} 件（差し戻しを含む）`,
      count: counts.overdue,
      severity: lead ? 'normal' : 'info',
      href: '/documents?status=overdue',
    });
  }
  const usage = raw.usage;
  if (lead && usage && usage.orphan_count > 0) {
    add({
      id: 'documents:lead:orphans',
      title: `片付けていないファイル ${usage.orphan_count} 件（提出状況を開くと消します）`,
      count: usage.orphan_count,
      severity: 'info',
      href: '/documents',
    });
  }
  if (closed && isAdmin(ctx.role) && usage && usage.file_count > 0) {
    add({
      id: 'documents:admin:closed-files',
      title: `提出物のファイル ${usage.file_count} 件（${formatFileSize(usage.file_bytes)}）が残っています。要るものを保存してから削除してください`,
      count: usage.file_count,
      severity: 'normal',
      href: '/documents',
    });
  }
  return todos;
}

/** 総務のカード「提出物」 */
function soumuCard(raw: DocumentsSoumuPortalRaw, counts: SoumuCounts, ctx: PortalContext): ModuleCardModel {
  const lines: string[] = [];
  if (raw.docs.length === 0) {
    lines.push('提出物はまだありません');
  } else {
    const next = raw.docs
      .map((d) => ({ deadline: d.deadline, t: timeOf(d.deadline) }))
      .filter((x): x is { deadline: string; t: number } => x.t !== null && x.t > ctx.now)
      .sort((a, b) => a.t - b.t)[0];
    lines.push(`提出物 ${raw.docs.length} 件（${next ? `次の締切 ${formatShortDateTime(next.deadline)}` : '締切はすべて過ぎました'}）`);
    lines.push(
      counts.total === 0
        ? '対象の団体がありません'
        : `承認 ${counts.approved}／${counts.total}・承認待ち ${counts.submitted}・差し戻し ${counts.returned}・未提出 ${counts.notSubmitted}`,
    );
  }
  if (isAdmin(ctx.role) && raw.usage) {
    lines.push(`ファイル ${formatFileSize(raw.usage.bucket_bytes)}（上限 ${formatFileSize(raw.usage.limit_bytes)}）`);
  }
  const href = canOpen('/documents', ctx.audiences, ctx.year.status) ? '/documents' : null;
  return { moduleId: MODULE_ID, title: moduleLabel(MODULE_ID), lines, href, linkLabel: '提出状況へ' };
}

/** 店長・副店長の要対応（代表する団体ごとに、立場の一覧の順。差し戻しは提出物ごとに1件、未提出は団体ごとに1件。終了した年度は作らない） */
function repTodos(rows: readonly DocumentsRepPortalRow[], ctx: PortalContext): TodoItem[] {
  const { todos, add } = todoBuilder(ctx);
  if (ctx.year.status === 'closed') return todos;
  for (const g of ctx.groups) {
    const mine = rows.filter((r) => r.group_id === g.id);
    for (const r of mine) {
      if (statusOf(r.status) !== 'returned') continue;
      add({
        id: `documents:rep:${g.id}:returned:${r.document_id}`,
        title: `${g.name}：提出物「${r.title}」が差し戻されました`,
        ...(r.review_note ? { detail: `理由：${r.review_note}` } : {}),
        severity: 'urgent',
        due: r.deadline,
        href: `/document?group=${g.id}&document=${r.document_id}`,
      });
    }
    const pending = mine.filter((r) => statusOf(r.status) === 'not_submitted');
    if (pending.length > 0) {
      const earliest = pending
        .map((r) => ({ r, t: timeOf(r.deadline) }))
        .filter((x): x is { r: DocumentsRepPortalRow; t: number } => x.t !== null)
        .sort((a, b) => a.t - b.t)[0];
      add({
        id: `documents:rep:${g.id}:pending`,
        title: `${g.name}：未提出の提出物 ${pending.length} 件`,
        count: pending.length,
        severity: earliest && earliest.t - ctx.now < DAY_MS ? 'urgent' : 'normal',
        ...(earliest ? { due: earliest.r.deadline } : {}),
        href: `/document?group=${g.id}`,
      });
    }
  }
  return todos;
}

/** 店長・副店長の締切と予定の材料（自団体が対象の提出物。代表する団体の順で、その提出物の行がある最初の団体を行き先にする） */
function repDeadlineSources(rows: readonly DocumentsRepPortalRow[], ctx: PortalContext): DeadlineSource[] {
  const order = new Map(ctx.groups.map((g, k) => [g.id, k]));
  const rankOf = (groupId: string | null) => (groupId === null ? Number.POSITIVE_INFINITY : (order.get(groupId) ?? Number.POSITIVE_INFINITY));
  const byDoc = new Map<string, DeadlineSource>();
  for (const r of rows) {
    const cur = byDoc.get(r.document_id);
    const pending = isOpen(statusOf(r.status));
    if (!cur) {
      byDoc.set(r.document_id, { id: r.document_id, title: r.title, deadline: r.deadline, pending, groupId: r.group_id });
      continue;
    }
    cur.pending ||= pending;
    if (rankOf(r.group_id) < rankOf(cur.groupId)) cur.groupId = r.group_id;
  }
  return [...byDoc.values()];
}

/**
 * 提出物がその種類（ctx.kind）に出すもの。raw の種類は ctx.kind と同じにする（違えば例外。閲覧のみは読まないので呼ばない）。
 * 純粋関数（時計は ctx.now だけ）。
 *
 * @example
 * documentsPortal({ kind: 'soumu', ...raw }, ctx)
 * documentsPortal({ kind: 'rep', rows }, ctx)
 */
export function documentsPortal(raw: DocumentsPortalRaw, ctx: PortalContext): PortalSection {
  if (raw.kind !== ctx.kind) throw new Error(`documentsPortal：読んだ行（${raw.kind}）と立場の種類（${ctx.kind}）が違います`);
  if (raw.kind === 'soumu') {
    const counts = soumuCounts(raw, ctx.now);
    const sources: DeadlineSource[] = raw.docs.map((d) => ({ id: d.id, title: d.title, deadline: d.deadline, pending: counts.pendingDocs.has(d.id), groupId: null }));
    return { card: soumuCard(raw, counts, ctx), todos: soumuTodos(raw, counts, ctx), dated: deadlineItems(sources, ctx) };
  }
  return { card: null, todos: repTodos(raw.rows, ctx), dated: deadlineItems(repDeadlineSources(raw.rows, ctx), ctx) };
}

/**
 * 提出物のプロバイダ（providers.ts の PORTAL_PROVIDERS の最後）。総務は documentsSoumuPortalOptions（部門長以上と総務部門員で別のキー）、
 * 店長・副店長は documentsRepPortalOptions（団体の id つきのキー。代表する団体がなければ読まない）に select を足して読む。
 */
export const documentsPortalProvider: PortalProvider = {
  moduleId: MODULE_ID,
  kinds: ['soumu', 'rep'],
  query: {
    widgets: ['todos', 'dated', 'cards'],
    options: (ctx) =>
      ctx.kind === 'soumu'
        ? portalQueryOptions(documentsSoumuPortalOptions(ctx.year.id, isLead(ctx.role) ? 'lead' : 'staff'), (raw) =>
            documentsPortal({ kind: 'soumu', ...raw }, ctx),
          )
        : ctx.groups.length > 0
          ? portalQueryOptions(
              documentsRepPortalOptions(
                ctx.year.id,
                ctx.groups.map((g) => g.id),
              ),
              (rows) => documentsPortal({ kind: 'rep', rows }, ctx),
            )
          : null,
  },
};
