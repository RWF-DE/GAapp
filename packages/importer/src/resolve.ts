// 読み取った回答を団体に対応させ、申請と提出を作る（04「CSV取り込み」、設計 3.7）。
import { rewriteRequestedItem, type GroupCategory, type Item, type RequestRow } from '@gaapp/shared';
import type { ParsedForm, RejectReason } from './parse';
import { normalizeText } from './sanitize';

export type ImportGroup = { id: string; name: string; aliases: readonly string[]; category: GroupCategory };

export type ResolvedForm = {
  /** 読み替え（S03）の後、(団体, 品目) ごとに合計して1行にしたもの。0 の行は持たない */
  requests: RequestRow[];
  /** 団体ごとの提出：フォームのタイムスタンプ（同じ団体の最後の回答）と備考 */
  submissions: { groupId: string; submittedAt: string; note: string | null }[];
  /** 団体に対応しなかった回答（手で対応させる） */
  unmatched: { rowNumber: number; groupName: string | null }[];
  /** 同じ団体の古い回答（keptRow を使い、droppedRows は画面で確認させる）。newerRejected の団体は含めない */
  superseded: { groupId: string; keptRow: number; droppedRows: number[] }[];
  /**
   * 使う回答（keptRow。読めた回答のうち一番新しいもの）より新しい取り込まない行が同じ団体にある団体。
   * 一番新しい回答が読めないので、requests・submissions には入れない（自動では取り込まない）。
   * submission と requests は keptRow で取り込むときの値（呼ぶ側が人に確かめてから使う）。
   * 取り込まない行は、タイムスタンプと団体名が読め、団体名がちょうど1つの団体に当たるものだけを見る。
   */
  newerRejected: {
    groupId: string;
    keptRow: number;
    droppedRows: number[];
    rejectedRows: { rowNumber: number; reason: RejectReason; submittedAt: string }[];
    submission: { groupId: string; submittedAt: string; note: string | null };
    requests: RequestRow[];
  }[];
};

const key = (s: string) => normalizeText(s).replace(/\s+/gu, '').toLowerCase();

/**
 * @param manual 行番号 → 団体 id（企業フォームなど、手で選んだ対応。団体名より優先する）
 */
export function resolveResponses(
  parsed: ParsedForm,
  groups: readonly ImportGroup[],
  items: readonly Item[],
  manual: Readonly<Record<number, string>> = {},
): ResolvedForm {
  const byId = new Map(groups.map((g) => [g.id, g]));
  // 名前・別名 → 団体。2つ以上の団体に当たる表記は対応させない（unmatched にして手で選ぶ）
  const byName = new Map<string, string[]>();
  for (const g of groups) {
    for (const n of new Set([g.name, ...g.aliases].map(key))) {
      if (n === '') continue;
      byName.set(n, [...(byName.get(n) ?? []), g.id]);
    }
  }

  const unmatched: ResolvedForm['unmatched'] = [];
  const perGroup = new Map<string, typeof parsed.responses>();
  for (const r of parsed.responses) {
    let gid: string | undefined;
    const picked = manual[r.rowNumber];
    if (picked !== undefined) gid = byId.has(picked) ? picked : undefined;
    else if (r.groupName !== null) {
      const hit = byName.get(key(r.groupName));
      if (hit && hit.length === 1) gid = hit[0];
    }
    if (gid === undefined) {
      unmatched.push({ rowNumber: r.rowNumber, groupName: r.groupName });
      continue;
    }
    perGroup.set(gid, [...(perGroup.get(gid) ?? []), r]);
  }

  // 取り込まない行のうち、タイムスタンプと団体名が読めて、団体名がちょうど1つの団体に当たるもの（手で選ぶ対応は回答の行にしかない）
  const rejectedPerGroup = new Map<string, { rowNumber: number; reason: RejectReason; submittedAt: string }[]>();
  for (const r of parsed.rejected) {
    if (r.submittedAt === null || r.groupName === null) continue;
    const hit = byName.get(key(r.groupName));
    if (!hit || hit.length !== 1) continue;
    const list = rejectedPerGroup.get(hit[0]!) ?? [];
    list.push({ rowNumber: r.rowNumber, reason: r.reason, submittedAt: r.submittedAt });
    rejectedPerGroup.set(hit[0]!, list);
  }
  /** a が b より新しい（タイムスタンプが新しい。同時刻なら後の行） */
  const newer = (a: { submittedAt: string; rowNumber: number }, b: { submittedAt: string; rowNumber: number }) => {
    const ta = Date.parse(a.submittedAt);
    const tb = Date.parse(b.submittedAt);
    return ta > tb || (ta === tb && a.rowNumber > b.rowNumber);
  };

  const itemByCode = new Map(items.map((i) => [i.code, i]));
  const superseded: ResolvedForm['superseded'] = [];
  const submissions: ResolvedForm['submissions'] = [];
  const requests: RequestRow[] = [];
  const newerRejected: ResolvedForm['newerRejected'] = [];
  for (const g of groups) {
    const rs = perGroup.get(g.id);
    if (!rs) continue;
    // 一番新しいタイムスタンプ。同時刻なら後の行
    const kept = rs.reduce((a, b) => (Date.parse(b.submittedAt) >= Date.parse(a.submittedAt) ? b : a));
    const dropped = rs.filter((r) => r !== kept).map((r) => r.rowNumber).sort((a, b) => a - b);
    const submission = { groupId: g.id, submittedAt: kept.submittedAt, note: kept.note };
    const groupRequests: RequestRow[] = [];

    const sum = new Map<string, number>();
    for (const [code, n] of Object.entries(kept.counts)) {
      if (n <= 0 || !itemByCode.has(code)) continue;
      // 申請できない品目で読み替え先もなければ、そのまま残す（E006 で人が直す）
      const to = rewriteRequestedItem(code, g.category, items) ?? code;
      sum.set(to, (sum.get(to) ?? 0) + n);
    }
    for (const it of items.slice().sort((a, b) => a.sortOrder - b.sortOrder || (a.code < b.code ? -1 : 1))) {
      const n = sum.get(it.code);
      if (n) groupRequests.push({ groupId: g.id, itemId: it.id, count: n });
    }

    const newerRows = (rejectedPerGroup.get(g.id) ?? []).filter((r) => newer(r, kept)).sort((a, b) => a.rowNumber - b.rowNumber);
    if (newerRows.length > 0) {
      newerRejected.push({ groupId: g.id, keptRow: kept.rowNumber, droppedRows: dropped, rejectedRows: newerRows, submission, requests: groupRequests });
      continue;
    }
    if (dropped.length) superseded.push({ groupId: g.id, keptRow: kept.rowNumber, droppedRows: dropped });
    submissions.push(submission);
    requests.push(...groupRequests);
  }
  unmatched.sort((a, b) => a.rowNumber - b.rowNumber);
  return { requests, submissions, unmatched, superseded, newerRejected };
}
