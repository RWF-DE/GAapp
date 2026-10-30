// 通しの流れ（SPEC「E2E の検証手順」、画面の設計 7.3。T14）のデータの決め事。DB にも Playwright にも依存しない。
// e2e/full-flow/data.test.ts（Vitest。E2E の前にこの入力で解けることを確かめる）と e2e/serial/full-flow.spec.ts が使う。
//
// 需要を増やさない（7.3）：
// - 団体代表は団体 A の申請を今の数のまま再提出する（提出日時だけが変わる）。
// - 取り込みの CSV（e2e/fixtures/full-flow-stall.csv）は団体 B・C の回答だけ。数はどの品目もその団体の今の申請以下で、
//   少なくとも1品目は減らす。団体 A は入れない（団体代表の提出を上書きしない）。
// 団体 A・B・C は r8like の模擬店のうち、ルール S05・S06・S08 と了承（consents.csv）の行のない団体（模擬店26〜39）から選ぶ。
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { INITIAL_ITEMS, ITEM_CODES, type AllocateInput } from '@gaapp/shared';
import { fixtureIndex, fixtureItems, toAllocateInput, type FixtureData, type ItemCounts } from '@gaapp/shared/testing';
// @gaapp/importer はルートの依存にないので相対で読む（アプリの取り込みと同じ関数で CSV を読む）
import { parseFormCsv, resolveResponses, type ParsedForm, type ResolvedForm } from '../../packages/importer/src/index';

/** 団体代表（seed の rep）が代表する団体。今の数のまま再提出する */
export const GROUP_A = '模擬店30';
/** CSV の対応しない行（マスタにない名前）を手で対応させる団体 */
export const GROUP_B = '模擬店31';
/** CSV に古い回答と新しい回答がある団体 */
export const GROUP_C = '模擬店32';
/** CSV の、マスタにない名前の行（団体 B の回答より新しい。手で団体 B に対応させる） */
export const UNMATCHED_NAME = '模擬店31（旧）';
/** その行の CSV の行番号（見出し＝1） */
export const UNMATCHED_ROW = 5;
/** 使用不可にして最小変更で再実行する部屋 */
export const ROOM_M = 'MER';

export const STALL_CSV_PATH = fileURLToPath(new URL('../fixtures/full-flow-stall.csv', import.meta.url));

export function readStallCsv(): string {
  return readFileSync(STALL_CSV_PATH, 'utf8');
}

/** CSV を読む（アプリの取り込みと同じ parseFormCsv。品目の列は items の aliases で対応） */
export function parseStallCsv(): ParsedForm {
  return parseFormCsv('stall', readStallCsv(), INITIAL_ITEMS);
}

/**
 * CSV を r8like の団体に対応させる（UNMATCHED_ROW は手で団体 B に対応させる）。
 * `manual: false` なら手で対応させる前（対応しない行が残る）。
 */
export function resolveStallCsv(fx: FixtureData, opts: { manual?: boolean } = {}): ResolvedForm {
  const ix = fixtureIndex(fx);
  const groups = fx.groups.map((g) => ({ id: ix.groupId(g.name), name: g.name, aliases: g.aliases, category: g.category }));
  const manual: Record<number, string> = (opts.manual ?? true) ? { [UNMATCHED_ROW]: ix.groupId(GROUP_B) } : {};
  return resolveResponses(parseStallCsv(), groups, fixtureItems(), manual);
}

/** 取り込んだ後の、団体ごとの申請の数（品目コード → 数。0 の品目は持たない） */
export function importedCounts(fx: FixtureData): Map<string, Record<string, number>> {
  const ix = fixtureIndex(fx);
  const resolved = resolveStallCsv(fx);
  const out = new Map<string, Record<string, number>>();
  for (const r of resolved.requests) {
    const name = ix.groupName.get(r.groupId)!;
    const code = ix.itemCode.get(r.itemId)!;
    out.set(name, { ...(out.get(name) ?? {}), [code]: r.count });
  }
  return out;
}

const nonZero = (c: ItemCounts): Record<string, number> => Object.fromEntries(ITEM_CODES.filter((k) => c[k] > 0).map((k) => [k, c[k]]));

/** 団体の今の申請（0 の品目を除く） */
export function requestOf(fx: FixtureData, group: string): Record<string, number> {
  const r = fx.requests.find((x) => x.group === group);
  if (!r) throw new Error(`r8like に ${group} の申請がありません`);
  return nonZero(r.counts);
}

/**
 * 手順 3・4 の後の FixtureData：団体 A の提出日時を submittedAtA にし、団体 B・C の申請と提出日時を取り込みの結果にする。
 * 在庫は変えない（同じ数のまま数え直した）。
 */
export function afterSteps3and4(fx: FixtureData, submittedAtA: string): FixtureData {
  const ix = fixtureIndex(fx);
  const resolved = resolveStallCsv(fx);
  const out = structuredClone(fx);
  const byGroup = new Map<string, Partial<ItemCounts>>();
  for (const r of resolved.requests) {
    const name = ix.groupName.get(r.groupId)!;
    byGroup.set(name, { ...(byGroup.get(name) ?? {}), [ix.itemCode.get(r.itemId)!]: r.count });
  }
  for (const [name, counts] of byGroup) {
    const req = out.requests.find((x) => x.group === name);
    if (!req) throw new Error(`r8like に ${name} の申請がありません`);
    for (const k of ITEM_CODES) req.counts[k] = counts[k] ?? 0;
  }
  const submitted = new Map(resolved.submissions.map((s) => [ix.groupName.get(s.groupId)!, s.submittedAt]));
  for (const g of out.groups) {
    if (g.name === GROUP_A) g.submittedAt = submittedAtA;
    const s = submitted.get(g.name);
    if (s !== undefined) g.submittedAt = s;
  }
  return out;
}

/** 手順 3・4 の後の入力（full。MER は使用可） */
export function flowInput(fx: FixtureData, submittedAtA = '2026-10-29T12:00:00+09:00'): AllocateInput {
  return toAllocateInput(afterSteps3and4(fx, submittedAtA));
}
