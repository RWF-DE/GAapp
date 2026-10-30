// LP と独立に書いた検算（E001〜E006・W101 相当）。T00 の analyze.ts の check を移し、残すの行の二重の加算を直したもの。
// 入力の rows は「固定行＋allocate の rows（残すの行を含む）」。残すの行を足し直さない。
// allocator の前処理・rules.ts・shared の buildDemand を使わずに、ルールを直接読んで判定する。
import type { AllocationRow, YearData } from '@gaapp/shared';

export type InvariantIssue = { code: 'E001' | 'E002' | 'E003' | 'E004' | 'E005' | 'E006' | 'W101'; message: string };

/** 申請品目の読み替え（テスト側で独立に書く。企業以外の長机(3人掛) → 長机(2人掛)） */
export function independentRewrite(code: string, category: string): string {
  return code === 'long_desk_3' && category !== 'company' ? 'long_desk_2' : code;
}

/**
 * @param expectedDemand 団体・申請品目（読み替えの後）→ 需要。キーは `${groupId}|${itemId}`。テスト側で CSV から作る
 */
export function checkInvariants(
  data: YearData,
  rows: readonly AllocationRow[],
  expectedDemand: ReadonlyMap<string, number>,
): InvariantIssue[] {
  const issues: InvariantIssue[] = [];
  const item = new Map(data.items.map((i) => [i.id, i]));
  const idOf = new Map(data.items.map((i) => [i.code, i.id]));
  const group = new Map(data.groups.map((g) => [g.id, g]));
  const room = new Map(data.rooms.map((r) => [r.id, r]));
  const used = new Map<string, number>();
  const got = new Map<string, number>();
  const add = (m: Map<string, number>, k: string, n: number) => m.set(k, (m.get(k) ?? 0) + n);

  for (const r of rows) {
    const g = group.get(r.groupId)!;
    const src = room.get(r.sourceRoomId)!;
    const loc = g.locationRoomId === null ? null : room.get(g.locationRoomId)!;
    const rawI = item.get(r.requestedItemId)!;
    const iCode = independentRewrite(rawI.code, g.category);
    const iId = idOf.get(iCode)!;
    const j = item.get(r.itemId)!;
    add(used, `${r.sourceRoomId}|${r.itemId}`, r.count);
    add(got, `${r.groupId}|${iId}`, r.count);
    if (!src.usable) issues.push({ code: 'E002', message: `${src.name} から ${g.name}` });
    if (r.isKeep !== (loc !== null && loc.id === src.id)) issues.push({ code: 'E005', message: `${g.name} ${src.name} isKeep=${r.isKeep}` });
    if (!item.get(iId)!.requestableCategories.includes(g.category)) {
      issues.push({ code: 'E004', message: `${g.name} は ${iCode} を申請できない` });
    }
    if (j.code !== iCode) {
      const ok = data.rules.some((rule) => {
        if (rule.kind !== 'substitute') return false;
        const p = rule.params;
        if (p.from !== iCode || p.to !== j.code || !p.categories.includes(g.category)) return false;
        if (p.indoorOnly && loc?.kind !== 'room') return false;
        if (p.needsConsent) {
          const c = data.consents.find((x) => x.groupId === g.id && x.fromItemId === iId && x.toItemId === j.id);
          if (c?.status === 'declined') return false;
        }
        return true;
      });
      if (!ok) issues.push({ code: 'E004', message: `${g.name} ${iCode}→${j.code}` });
    }
    for (const rule of data.rules) {
      if (rule.kind !== 'source_restrict') continue;
      if (rule.params.group === g.id && rule.params.items.includes(iCode) && !rule.params.rooms.includes(src.id)) {
        issues.push({ code: 'E004', message: `${rule.code}：${g.name} ${iCode} を ${src.name} から` });
      }
    }
  }
  const stock = new Map<string, number>();
  for (const s of data.stocks) add(stock, `${s.roomId}|${s.itemId}`, s.count);
  for (const [k, n] of used) if (n > (stock.get(k) ?? 0)) issues.push({ code: 'E001', message: `${k} ${n} > ${stock.get(k) ?? 0}` });
  for (const [k, n] of expectedDemand) {
    const v = got.get(k) ?? 0;
    if (v < n) issues.push({ code: 'E003', message: `${k} 需要 ${n}、振り分け ${v}` });
  }
  for (const [k, v] of got) {
    const n = expectedDemand.get(k) ?? 0;
    if (v > n) issues.push({ code: 'W101', message: `${k} 需要 ${n}、振り分け ${v}` });
  }
  for (const rq of data.requests) {
    const g = group.get(rq.groupId)!;
    const it = item.get(rq.itemId)!;
    if (rq.count > 0 && !item.get(idOf.get(independentRewrite(it.code, g.category))!)!.requestableCategories.includes(g.category)) {
      issues.push({ code: 'E006', message: `${g.name} ${it.code}` });
    }
  }
  return issues;
}
