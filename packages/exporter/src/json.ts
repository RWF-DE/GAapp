// 年度データ（JSON）：年度末のバックアップ。DB の行に近い形で、項目を決めて書く（知らない項目は書かない）。
// メールアドレスは含めない：項目の許可リストで落とし、自由記述の文字列に混じったものも伏せる。
import type { YearExport } from './types';

export const EXPORT_SCHEMA_VERSION = 1;
const EMAIL = /[A-Za-z0-9._%+-]+@[A-Za-z0-9-]+(?:\.[A-Za-z0-9-]+)*\.[A-Za-z]{2,}/g;
export const EMAIL_REDACTED = '(メールアドレス削除)';

const pick = <T extends object>(o: T, keys: readonly (keyof T)[]) => {
  const out: Record<string, unknown> = {};
  for (const k of keys) out[k as string] = o[k] ?? null;
  return out;
};

export function exportYearJson(input: YearExport): string {
  const d = input.data;
  const doc = {
    schemaVersion: EXPORT_SCHEMA_VERSION,
    yearLabel: input.yearLabel,
    ...(input.exportedAt ? { exportedAt: input.exportedAt } : {}),
    items: d.items.map((i) => pick(i, ['id', 'code', 'name', 'requestableCategories', 'sortOrder'])),
    rooms: d.rooms.map((r) => pick(r, ['id', 'name', 'kind', 'building', 'floor', 'extraCost', 'isStorage', 'usable', 'sortOrder'])),
    groups: d.groups.map((g) => pick(g, ['id', 'name', 'displayName', 'category', 'locationRoomId', 'sortOrder', 'submittedAt'])),
    stocks: d.stocks.map((s) => pick(s, ['roomId', 'itemId', 'count'])),
    requests: d.requests.map((s) => pick(s, ['groupId', 'itemId', 'count'])),
    rules: d.rules.map((r) => ({ id: r.id, code: r.code, kind: r.kind, params: r.params })),
    consents: d.consents.map((c) => pick(c, ['groupId', 'fromItemId', 'toItemId', 'status', 'count'])),
    distanceOverrides: d.distanceOverrides.map((o) => pick(o, ['buildingA', 'buildingB', 'cost'])),
    allocations: input.rows.map((r) => ({
      ...(r.id !== undefined ? { id: r.id } : {}),
      ...pick(r, ['sourceRoomId', 'groupId', 'itemId', 'requestedItemId', 'count', 'isKeep']),
      ...(r.origin !== undefined ? { origin: r.origin } : {}),
      ...(r.pinned !== undefined ? { pinned: r.pinned } : {}),
      note: r.note ?? null,
    })),
  };
  // 文字列にしてから置換すると、\n などのエスケープの途中から一致して不正な JSON になる。値ごとに先に伏せる。
  return JSON.stringify(doc, (_k, v: unknown) => (typeof v === 'string' ? v.replace(EMAIL, EMAIL_REDACTED) : v), 2);
}
