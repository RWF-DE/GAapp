// 検証（03「検証コード一覧」、設計 13.1）。YearData と、その年度の全行（固定・手動・自動・残す）から Issue を作る
import { buildDemand, giKey, type AllocationRow, type Issue, type StoredAllocationRow, type YearData } from '@gaapp/shared';
import { consentKey, rewriteRowRequestedItem, rjKey, type Ctx } from './context';
import { allowedSources } from './rules';
import { contextFor, findW107 } from './w107';

type AnyRow = AllocationRow | StoredAllocationRow;

const SEVERITY_ORDER = { error: 0, warning: 1, info: 2 } as const;
export const W103_MIN_SOURCES = 4;

const idOf = (r: AnyRow): string | undefined => ('id' in r && typeof r.id === 'string' ? r.id : undefined);
const rowIds = (rs: readonly AnyRow[]): { rowIds?: string[] } => {
  const ids = rs.map(idOf).filter((x): x is string => x !== undefined);
  return ids.length > 0 ? { rowIds: ids } : {};
};
const add = (m: Map<string, number>, k: string, n: number) => m.set(k, (m.get(k) ?? 0) + n);

/**
 * @param data allocate の入力と同じ年度のデータ（AllocateInput をそのまま渡してよい）。入力が不正なら例外
 * @param rows その年度の全行。申請品目は前処理1と同じ読み替えを当ててから比べる
 */
export function validate(data: YearData, rows: readonly AnyRow[]): Issue[] {
  const ctx = contextFor(data);
  for (const r of rows) {
    if (!ctx.roomById.has(r.sourceRoomId) || !ctx.groupById.has(r.groupId) || !ctx.itemById.has(r.itemId) || !ctx.itemById.has(r.requestedItemId)) {
      throw new Error('行が、年度のデータにない場所・団体・品目を参照しています');
    }
  }
  const rs = rows.map((r) => rewriteRowRequestedItem(r, ctx));
  const issues: Issue[] = [];
  const room = (id: string) => ctx.roomById.get(id)!;
  const group = (id: string) => ctx.groupById.get(id)!;
  const item = (id: string) => ctx.itemById.get(id)!;

  const used = new Map<string, number>();
  const got = new Map<string, number>();
  for (const r of rs) {
    add(used, rjKey(r.sourceRoomId, r.itemId), r.count);
    add(got, giKey(r.groupId, r.requestedItemId), r.count);
  }

  // E001：保管場所・品目ごとの合計が在庫を超える
  for (const rm of ctx.rooms) {
    for (const it of ctx.items) {
      const k = rjKey(rm.id, it.id);
      const n = used.get(k) ?? 0;
      const s = ctx.stock.get(k) ?? 0;
      if (n > s) {
        issues.push({
          code: 'E001',
          severity: 'error',
          message: `${rm.name}の${it.name}が ${n - s} 台在庫超過です（在庫 ${s}、振り分け ${n}）`,
          refs: { roomId: rm.id, itemId: it.id, ...rowIds(rs.filter((r) => r.sourceRoomId === rm.id && r.itemId === it.id)) },
        });
      }
    }
  }

  // E002：使用不可の部屋からの振り分け
  for (const rm of ctx.rooms) {
    if (rm.usable) continue;
    const mine = rs.filter((r) => r.sourceRoomId === rm.id);
    if (mine.length > 0) {
      issues.push({ code: 'E002', severity: 'error', message: `${rm.name}は今年使えません`, refs: { roomId: rm.id, ...rowIds(mine) } });
    }
  }

  // E003・W101：団体・申請品目ごとの合計と需要
  const { demand, excluded } = buildDemand(ctx);
  for (const g of ctx.groups) {
    for (const it of ctx.items) {
      const k = giKey(g.id, it.id);
      const need = demand.get(k) ?? 0;
      const have = got.get(k) ?? 0;
      const refs = { groupId: g.id, requestedItemId: it.id, ...rowIds(rs.filter((r) => r.groupId === g.id && r.requestedItemId === it.id)) };
      if (have < need) {
        issues.push({ code: 'E003', severity: 'error', message: `${g.name}の${it.name}が ${need - have} 台不足しています（需要 ${need}、振り分け ${have}）`, refs });
      } else if (have > need) {
        issues.push({ code: 'W101', severity: 'warning', message: `${g.name}の${it.name}が申請より ${have - need} 台多いです（需要 ${need}、振り分け ${have}）`, refs });
      }
    }
  }

  // E004：ルール違反
  for (const r of rs) {
    const g = group(r.groupId);
    const i = item(r.requestedItemId);
    const j = item(r.itemId);
    const refsBase = { groupId: g.id, requestedItemId: i.id, itemId: j.id, roomId: r.sourceRoomId, ...rowIds([r]) };
    if (!i.requestableCategories.includes(g.category)) {
      issues.push({ code: 'E004', severity: 'error', message: `${g.name}は${i.name}を申請できない区分です`, refs: refsBase });
    }
    if (j.id !== i.id) {
      const rules = ctx.rules.filter((x) => x.kind === 'substitute' && x.params.from === i.code && x.params.to === j.code);
      const loc = g.locationRoomId === null ? null : room(g.locationRoomId);
      const declined = ctx.consentStatus.get(consentKey(g.id, i.id, j.id)) === 'declined';
      const okRules = rules.filter(
        (x) =>
          x.kind === 'substitute' &&
          x.params.categories.includes(g.category) &&
          (!x.params.indoorOnly || loc?.kind === 'room') &&
          !(x.params.needsConsent && declined),
      );
      if (okRules.length === 0) {
        const consentRule = rules.find((x) => x.kind === 'substitute' && x.params.needsConsent && x.params.categories.includes(g.category) && declined);
        const why = consentRule
          ? `了承しなかった団体への置き換えです（${consentRule.code}）`
          : rules.length === 0
            ? '置き換えのルールがありません'
            : `ルールの条件（区分・屋内）を満たしません（${rules.map((x) => x.code).join('、')}）`;
        issues.push({
          code: 'E004',
          severity: 'error',
          message: `${g.name}の${i.name}を${j.name}で置き換えられません：${why}`,
          refs: { ...refsBase, ...(consentRule ? { ruleCode: consentRule.code } : rules[0] ? { ruleCode: rules[0].code } : {}) },
        });
      }
    }
    const allowed = allowedSources(ctx, g, i);
    if (allowed !== null && !allowed.has(r.sourceRoomId)) {
      const codes = ctx.rules
        .filter((x) => x.kind === 'source_restrict' && x.params.group === g.id && x.params.items.includes(i.code) && !x.params.rooms.includes(r.sourceRoomId))
        .map((x) => x.code);
      issues.push({
        code: 'E004',
        severity: 'error',
        message: `${g.name}の${i.name}を${room(r.sourceRoomId).name}から運べません（${codes.join('、')}）`,
        refs: { ...refsBase, ruleCode: codes[0]! },
      });
    }
  }

  // E005：isKeep と「運び元 = 使用場所」の不一致
  for (const r of rs) {
    const g = group(r.groupId);
    const own = g.locationRoomId === r.sourceRoomId;
    if (r.isKeep === own) continue;
    issues.push({
      code: 'E005',
      severity: 'error',
      message: r.isKeep
        ? `「残す」は使用場所の部屋だけです（${g.name}、${room(r.sourceRoomId).name}）`
        : `${g.name}の使用場所からの行が「残す」になっていません（${room(r.sourceRoomId).name}）`,
      refs: { groupId: g.id, roomId: r.sourceRoomId, itemId: r.itemId, ...rowIds([r]) },
    });
  }

  // E006：申請できない区分の申請
  for (const e of excluded) {
    issues.push({
      code: 'E006',
      severity: 'error',
      message: `${group(e.groupId).name}は${item(e.itemId).name}を申請できません（${e.count} 台は計算から除きます）`,
      refs: { groupId: e.groupId, requestedItemId: e.itemId },
    });
  }

  // W102：了承が要る置き換え
  for (const rule of ctx.rules) {
    if (rule.kind !== 'substitute' || !rule.params.needsConsent) continue;
    const from = ctx.itemIdByCode.get(rule.params.from)!;
    const to = ctx.itemIdByCode.get(rule.params.to)!;
    for (const g of ctx.groups) {
      const mine = rs.filter((r) => r.groupId === g.id && r.requestedItemId === from && r.itemId === to);
      const n = mine.reduce((a, r) => a + r.count, 0);
      if (n === 0) continue;
      const status = ctx.consentStatus.get(consentKey(g.id, from, to));
      const c = data.consents.find((x) => x.groupId === g.id && x.fromItemId === from && x.toItemId === to);
      if (status === 'declined') continue; // E004
      const refs = { groupId: g.id, requestedItemId: from, itemId: to, ruleCode: rule.code, ...rowIds(mine) };
      const label = `${g.name}：${item(from).name}${n} → ${item(to).name}`;
      if (status !== 'accepted') {
        issues.push({ code: 'W102', severity: 'warning', message: `${label}（了承待ち）`, refs });
      } else if (c?.count != null && n > c.count) {
        issues.push({ code: 'W102', severity: 'warning', message: `${label}（了承は ${c.count} 台、今は ${n} 台。依頼し直し）`, refs });
      }
    }
  }

  // W103：1団体・1品目の運び元が4か所以上
  for (const g of ctx.groups) {
    for (const it of ctx.items) {
      const mine = rs.filter((r) => r.groupId === g.id && r.itemId === it.id);
      const n = new Set(mine.map((r) => r.sourceRoomId)).size;
      if (n >= W103_MIN_SOURCES) {
        issues.push({ code: 'W103', severity: 'warning', message: `${g.name}の${it.name}が ${n} か所に分かれています`, refs: { groupId: g.id, itemId: it.id, ...rowIds(mine) } });
      }
    }
  }

  // W104：在庫がひとつも数えられていない保管場所（使用不可の部屋は除く）
  const counted = new Set(data.stocks.map((s) => s.roomId));
  for (const rm of ctx.rooms) {
    if (rm.isStorage && rm.usable && !counted.has(rm.id)) {
      issues.push({ code: 'W104', severity: 'warning', message: `${rm.name}の在庫がまだ数えられていません`, refs: { roomId: rm.id } });
    }
  }

  // W105：未提出の団体（まとめて1件）
  const unsubmitted = ctx.groups.filter((g) => g.submittedAt === null);
  if (unsubmitted.length > 0) {
    const names = unsubmitted.slice(0, 5).map((g) => g.name).join('、');
    issues.push({
      code: 'W105',
      severity: 'warning',
      message: `${unsubmitted.length}団体が未提出です（${names}${unsubmitted.length > 5 ? ' ほか' : ''}）`,
      refs: unsubmitted.length === 1 ? { groupId: unsubmitted[0]!.id } : {},
    });
  }

  // W106：提出済みの団体で fixed_request と申請の数が違う
  const fixedCodes = ctx.rules.filter((x) => x.kind === 'fixed_request').map((x) => x.code);
  if (fixedCodes.length > 0) {
    const { demand: requested } = buildDemand(ctx, { disabledRuleCodes: fixedCodes });
    for (const rule of ctx.rules) {
      if (rule.kind !== 'fixed_request') continue;
      const g = group(rule.params.group);
      if (g.submittedAt === null) continue;
      const it = item(ctx.itemIdByCode.get(rule.params.item)!);
      const asked = requested.get(giKey(g.id, it.id)) ?? 0;
      if (asked !== rule.params.count) {
        issues.push({
          code: 'W106',
          severity: 'warning',
          message: `${g.name}：固定${rule.params.count}、申請${asked}（${it.name}）`,
          refs: { groupId: g.id, requestedItemId: it.id, ruleCode: rule.code },
        });
      }
    }
  }

  // W107：入れ替えられるのに外へ出している（D-20）
  for (const f of findW107(data, rs, ctx)) {
    if (!f.swappable) continue;
    const g = group(f.groupId);
    const involved = rs.filter(
      (r) =>
        r.itemId === f.itemId &&
        ((r.groupId === f.groupId && r.sourceRoomId !== f.roomId) || (r.sourceRoomId === f.roomId && f.sentTo.includes(r.groupId))),
    );
    issues.push({
      code: 'W107',
      severity: 'warning',
      message: `${room(f.roomId).name}の${item(f.itemId).name}が${f.sentTo.map((h) => group(h).name).join('、')}へ出ているのに、${g.name}が他の部屋（${f.receivedFrom.map((x) => room(x).name).join('、')}）から受け取っています`,
      refs: { groupId: g.id, roomId: f.roomId, itemId: f.itemId, ...rowIds(involved) },
    });
  }

  // I201：品目ごとの余り（使用不可の部屋を除く）
  for (const it of ctx.items) {
    const parts: string[] = [];
    let total = 0;
    for (const rm of ctx.rooms) {
      if (!rm.usable) continue;
      const left = (ctx.stock.get(rjKey(rm.id, it.id)) ?? 0) - (used.get(rjKey(rm.id, it.id)) ?? 0);
      if (left > 0) {
        total += left;
        parts.push(`${rm.name}：${left}`);
      }
    }
    if (total > 0) issues.push({ code: 'I201', severity: 'info', message: `${it.name} 余り${total}（${parts.join('、')}）`, refs: { itemId: it.id } });
  }

  return sortIssues(ctx, issues);
}

function sortIssues(ctx: Ctx, issues: Issue[]): Issue[] {
  const at = (m: Map<string, number>, id?: string) => (id === undefined ? -1 : (m.get(id) ?? -1));
  return issues
    .map((x, n) => ({ x, n }))
    .sort(
      (a, b) =>
        SEVERITY_ORDER[a.x.severity] - SEVERITY_ORDER[b.x.severity] ||
        (a.x.code < b.x.code ? -1 : a.x.code > b.x.code ? 1 : 0) ||
        at(ctx.roomIndex, a.x.refs.roomId) - at(ctx.roomIndex, b.x.refs.roomId) ||
        at(ctx.groupIndex, a.x.refs.groupId) - at(ctx.groupIndex, b.x.refs.groupId) ||
        at(ctx.itemIndex, a.x.refs.itemId ?? a.x.refs.requestedItemId) - at(ctx.itemIndex, b.x.refs.itemId ?? b.x.refs.requestedItemId) ||
        a.n - b.n,
    )
    .map((e) => e.x);
}
