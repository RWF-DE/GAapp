// 年度データ（JSON）の書き出し（画面の設計 2.7・3.2・6。T09）。年度末のバックアップに使う。
// 年度の全データ（無効なルール・メモ・別名・飲食か・提出の note・了承の note・振り分けの id・origin・pinned）を、exporter の
// YearExport の形にする。メールアドレスは型に持たない（exporter の exportYearJson が自由記述の中のものも伏せる）。
// @gaapp/exporter は書き出すときに動的 import する（静的 import は ESLint で止める）。
import { ruleSchema, type Json } from '@gaapp/shared';
import type { ExportRule, YearExport } from '@gaapp/exporter';
import { downloadFile, MIME } from '@/lib/download';
import type { AppSupabaseClient } from '@/lib/supabase/client';
import { getSupabase } from '@/lib/supabase/client';
import { loadSnapshot, type Snapshot } from './snapshot';
import { blankToNull } from './year-data';

export interface ToYearExportResult {
  data: YearExport;
  /** ruleSchema に合わない（設定の壊れた）ルールのコード。省かずに DB の params のまま書き出したもの */
  brokenRuleCodes: string[];
}

/** ルールの params が shared の ruleSchema に合うか（合わなくても書き出しは止めない） */
function isValidRule(r: { id: string; code: string; kind: string; params: Json }): boolean {
  return ruleSchema.safeParse({ id: r.id, code: r.code, kind: r.kind, params: r.params }).success;
}

/**
 * スナップショット（part = full）→ exporter の YearExport（2.7）。純粋関数。
 * - ルールは無効なものも含め、memo つきで全部。params が壊れていても（ruleSchema に合わなくても）省かず、DB の params を
 *   そのまま入れる（年度末のバックアップから黙ってルールが欠けないように、壊れたルール1件でバックアップができなくならないように）。
 * - 場所の usable は room_years の行（なければ使用可）。任意の文字列の空文字は null にそろえる。
 * - 並べ替えはしない（スナップショットは主キー・並び順で読んでいる）。
 */
export function toYearExport(snapshot: Snapshot, exportedAt?: string): ToYearExportResult {
  const usable = new Map(snapshot.roomYears.map((r) => [r.room_id, r.usable] as const));
  const brokenRuleCodes: string[] = [];
  const rules: ExportRule[] = snapshot.rules.map((r) => {
    if (!isValidRule(r)) brokenRuleCodes.push(r.code);
    // 壊れた params も DB の値のまま書く。exportYearJson は params を検証せずにそのまま書くので、型は unknown を通して合わせる
    return { id: r.id, code: r.code, kind: r.kind, params: r.params, enabled: r.enabled, memo: r.memo } as unknown as ExportRule;
  });
  const data: YearExport = {
    yearLabel: snapshot.year.label,
    items: snapshot.items.map((i) => ({
      id: i.id,
      code: i.code,
      name: i.name,
      aliases: [...i.aliases],
      requestableCategories: [...i.requestable_categories],
      sortOrder: i.sort_order,
    })),
    rooms: snapshot.rooms.map((r) => ({
      id: r.id,
      name: r.name,
      aliases: [...r.aliases],
      kind: r.kind,
      building: blankToNull(r.building),
      floor: r.floor,
      extraCost: r.extra_cost,
      isStorage: r.is_storage,
      usable: usable.get(r.id) ?? true,
      sortOrder: r.sort_order,
    })),
    groups: snapshot.groups.map((g) => ({
      id: g.id,
      name: g.name,
      displayName: blankToNull(g.display_name),
      aliases: [...g.aliases],
      category: g.category,
      isFood: g.is_food,
      locationRoomId: g.location_room_id,
      sortOrder: g.sort_order,
    })),
    stocks: snapshot.stocks.map((s) => ({ roomId: s.room_id, itemId: s.item_id, count: s.count })),
    requests: snapshot.requests.map((r) => ({ groupId: r.group_id, itemId: r.item_id, count: r.count })),
    submissions: snapshot.submissions.map((s) => ({ groupId: s.group_id, submittedAt: s.submitted_at, note: blankToNull(s.note) })),
    rules,
    consents: snapshot.consents.map((c) => ({
      groupId: c.group_id,
      fromItemId: c.from_item_id,
      toItemId: c.to_item_id,
      status: c.status,
      count: c.count,
      note: blankToNull(c.note),
    })),
    distanceOverrides: snapshot.distanceOverrides.map((o) => ({ buildingA: o.building_a, buildingB: o.building_b, cost: o.cost })),
    rows: snapshot.allocations.map((a) => ({
      id: a.id,
      sourceRoomId: a.source_room_id,
      groupId: a.group_id,
      itemId: a.item_id,
      requestedItemId: a.requested_item_id,
      count: a.count,
      isKeep: a.is_keep,
      origin: a.origin,
      pinned: a.pinned,
      note: blankToNull(a.note),
    })),
    ...(exportedAt ? { exportedAt } : {}),
  };
  return { data, brokenRuleCodes };
}

/** 書き出した後に出す文（壊れたルールがあれば件数とコード） */
export function brokenRulesNotice(codes: readonly string[]): string | null {
  if (codes.length === 0) return null;
  return `設定の壊れたルール ${codes.length} 件（${codes.join('、')}）をそのまま書き出しました。ルール画面で直してください`;
}

/**
 * 年度の全データを読み直して（版を先に読むスナップショット）、`{年度}_年度データ.json` として保存させる。
 * ボタンを押したときだけ呼ぶ（プリレンダーの間は document がない）。
 */
export async function downloadYearJson(
  yearId: string,
  client: AppSupabaseClient = getSupabase(),
): Promise<{ fileName: string; brokenRuleCodes: string[] }> {
  const snapshot = await loadSnapshot(yearId, 'full', client);
  const { data, brokenRuleCodes } = toYearExport(snapshot, new Date().toISOString());
  const ex = await import('@gaapp/exporter');
  const fileName = ex.yearJsonFileName(snapshot.year.label);
  downloadFile(ex.exportYearJson(data), fileName, MIME.json);
  return { fileName, brokenRuleCodes };
}
