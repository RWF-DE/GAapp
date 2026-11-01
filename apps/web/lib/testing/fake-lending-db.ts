// テスト専用：テント等の貸し出しの表を小さくまねる偽の DB（T21。components/lending の部品のテストだけが使う。アプリのコードから import しない）。
// lib/testing/fake-supabase.ts の問い合わせ（from(表)…・rpc）を受け、eq・in・gt で絞った行を返す（団体・備品への埋め込みは select にある
// 表だけで、`表.列` の絞りは埋め込みの行だけを絞る）。読み取りの RLS は割り当て（店長・副店長は確定後だけ。FakeActor.seesAssignments）
// だけをまねる。書き込みは RLS の段（部門長以上・総務・店長・副店長の受付期間）と楽観ロック（updated_at）・一意のキー（23505）・
// 外部キー（23503）と、RPC（save_lending_assignments・set_lending_confirmed・previous_year_lending_items）の決め方を小さくまねる。
import { opArgs, type FakeCall, type FakeResult } from './fake-supabase';

export interface FakeItem {
  id: string;
  year_id: string;
  name: string;
  unit: string;
  stock: number;
  requestable_categories: string[];
  sort_order: number;
  updated_at: string;
}
export interface FakePair {
  group_id: string;
  lending_item_id: string;
  year_id: string;
  count: number;
  updated_by: string | null;
  updated_at: string;
}
export interface FakeRecord {
  group_id: string;
  lending_item_id: string;
  year_id: string;
  lent_count: number;
  returned_count: number;
  damaged_count: number;
  note: string | null;
  updated_by: string | null;
  updated_at: string;
}
export interface FakeGroup {
  id: string;
  year_id: string;
  name: string;
  display_name: string | null;
  aliases: string[];
  category: string;
  sort_order: number;
  location_room_id: string | null;
  location_room: { name: string; kind: string } | null;
}

export interface FakeLendingDb {
  items: FakeItem[];
  groups: FakeGroup[];
  requests: FakePair[];
  assignments: FakePair[];
  records: FakeRecord[];
  confirmedAt: string | null;
  prevItems: Omit<FakeItem, 'id' | 'year_id' | 'updated_at'>[];
}

/** 偽の DB の書き込みの段（呼んだ人） */
export interface FakeActor {
  userId: string;
  /** 部門長以上で終了でない（備品・割り当て・確定） */
  canLead: () => boolean;
  /** 総務で終了でない（記録） */
  canRecord: () => boolean;
  /** その団体の申請を書ける（受付期間内の店長・副店長） */
  canRequest: (groupId: string) => boolean;
  /** 年度が終了か（RPC の invalid_state） */
  closed: () => boolean;
  /**
   * 割り当てを読めるか（RLS。店長・副店長は確定後だけ読める。既定はいつも読める〔総務〕）。割り当ての読み取りと、団体・備品への
   * 埋め込みに効く
   */
  seesAssignments?: () => boolean;
}

export const NETWORK: FakeResult = { error: { code: '', message: 'TypeError: Failed to fetch' }, status: 0 };
export const pgError = (code: string, status: number, message = `pg ${code}`, details: unknown = null): FakeResult => ({
  error: { code, message, details: details === null ? null : JSON.stringify(details), hint: null },
  status,
});

let clock = 0;
/** 新しい updated_at（呼ぶたびに進む。マイクロ秒つき） */
export const nextAt = () => `2026-10-20T00:00:00.${String(++clock).padStart(6, '0')}+00:00`;

const has = (call: FakeCall, op: string) => call.ops.some((o) => o.op === op);

/**
 * eq・in・gt で絞る。embedded を渡すと、その埋め込みの表の絞り（`表.列`）だけを使い、渡さなければ `.` のない列（上の表）だけを使う
 * （PostgREST と同じく、埋め込みの絞りは埋め込みの行だけを絞り、上の行は減らさない）
 */
function filterRows<T extends object>(call: FakeCall, rows: readonly T[], embedded?: string): T[] {
  const colOf = (col: unknown): string | null => {
    const c = col as string;
    if (embedded) return c.startsWith(`${embedded}.`) ? c.slice(embedded.length + 1) : null;
    return c.includes('.') ? null : c;
  };
  const val = (r: T, c: string) => (r as Record<string, unknown>)[c];
  let out = [...rows];
  for (const [col, v] of opArgs(call, 'eq')) {
    const c = colOf(col);
    if (c) out = out.filter((r) => val(r, c) === v);
  }
  for (const [col, vs] of opArgs(call, 'in')) {
    const c = colOf(col);
    if (c) out = out.filter((r) => (vs as unknown[]).includes(val(r, c)));
  }
  for (const [col, v] of opArgs(call, 'gt')) {
    const c = colOf(col);
    if (c) out = out.filter((r) => (val(r, c) as number) > (v as number));
  }
  return out;
}

/** select の中の埋め込みの列（`表(列, 列)`。その表を埋め込んでいなければ null） */
function embeddedColumns(call: FakeCall, table: string): string[] | null {
  const select = String(opArgs(call, 'select')[0]?.[0] ?? '');
  const m = new RegExp(`(?:^|[\\s,])${table}\\(([^()]*)\\)`).exec(select);
  return m ? m[1]!.split(',').map((c) => c.trim()) : null;
}

/** 行から選んだ列だけを残す */
const pickColumns = (row: object, cols: readonly string[]): Record<string, unknown> =>
  Object.fromEntries(cols.map((c) => [c, (row as Record<string, unknown>)[c]]));

const single = (call: FakeCall, rows: unknown[]): FakeResult => (has(call, 'maybeSingle') || has(call, 'single') ? { data: rows[0] ?? null } : { data: rows });

/** 偽の DB の問い合わせの受け手 */
export function lendingHandler(db: FakeLendingDb, actor: FakeActor) {
  /** 呼んだ人が読める割り当て（RLS） */
  const visibleAssignments = (): FakePair[] => ((actor.seesAssignments?.() ?? true) ? db.assignments : []);
  return (call: FakeCall): FakeResult | undefined => {
    switch (call.table) {
      case 'groups':
        return single(call, filterRows(call, db.groups).map((g) => embedInGroup(call, g)));
      case 'lending_years':
        return single(call, db.confirmedAt ? [{ year_id: db.groups[0]?.year_id ?? '', confirmed_at: db.confirmedAt }] : []);
      case 'lending_items':
        return items(call);
      case 'lending_requests':
        return pairs(call, db.requests, 'request');
      case 'lending_assignments':
        return single(call, filterRows(call, visibleAssignments()).map((a) => ({ ...a, lending_items: itemEmbed(a.lending_item_id) })));
      case 'lending_records':
        return records(call);
      case 'rpc:save_lending_assignments':
        return saveAssignments(call);
      case 'rpc:set_lending_confirmed':
        return setConfirmed(call);
      case 'rpc:previous_year_lending_items':
        return actor.canLead() ? { data: db.prevItems } : pgError('P0001', 400, 'forbidden');
    }
    return undefined;
  };

  /** 団体に埋め込む表（select にあるものだけ。申請のテント等のタブ・店長・副店長のダッシュボードの読み取り） */
  function embedInGroup(call: FakeCall, g: FakeGroup): object {
    const select = String(opArgs(call, 'select')[0]?.[0] ?? '');
    const mine = <T extends { group_id: string }>(rows: readonly T[]) => rows.filter((r) => r.group_id === g.id);
    const withItem = <T extends { lending_item_id: string }>(rows: readonly T[]) => rows.map((r) => ({ ...r, lending_items: itemEmbed(r.lending_item_id) }));
    return {
      ...g,
      ...(select.includes('lending_requests(') ? { lending_requests: mine(db.requests) } : {}),
      ...(select.includes('lending_assignments(') ? { lending_assignments: withItem(mine(visibleAssignments())) } : {}),
      ...(select.includes('lending_records(') ? { lending_records: withItem(mine(db.records)) } : {}),
      ...(select.includes('years(lending_years(') ? { years: { lending_years: db.confirmedAt ? { confirmed_at: db.confirmedAt } : null } } : {}),
    };
  }

  function itemEmbed(id: string) {
    const it = db.items.find((i) => i.id === id);
    return it ? { name: it.name, unit: it.unit, sort_order: it.sort_order } : null;
  }

  /**
   * 備品に埋め込む表（select にあるものだけ。選んだ列だけを返す）。`表.列` の eq・gt で埋め込みの行を絞る（申請のテント等のタブを
   * 出すかの読み取り：その団体の割り当て〔数が1以上〕と記録〔渡した数が1以上〕）。割り当ては呼んだ人が読める行だけ（RLS）
   */
  function embedInItem(call: FakeCall, it: FakeItem): object {
    const embed = (table: 'lending_assignments' | 'lending_records', rows: readonly (FakePair | FakeRecord)[]) => {
      const cols = embeddedColumns(call, table);
      if (!cols) return {};
      const mine = filterRows(call, rows.filter((r) => r.lending_item_id === it.id), table);
      return { [table]: mine.map((r) => pickColumns(r, cols)) };
    };
    return { ...it, ...embed('lending_assignments', visibleAssignments()), ...embed('lending_records', db.records) };
  }

  function items(call: FakeCall): FakeResult {
    if (has(call, 'insert')) {
      if (!actor.canLead()) return pgError('42501', 403);
      const vs = opArgs(call, 'insert')[0]![0] as Omit<FakeItem, 'updated_at'>[];
      for (const v of vs) {
        if (db.items.some((i) => i.id === v.id || (i.year_id === v.year_id && i.name === v.name))) return pgError('23505', 409);
      }
      const at = nextAt();
      const added = vs.map((v) => ({ ...v, updated_at: at }) as FakeItem);
      db.items.push(...added);
      return { data: added };
    }
    const id = (opArgs(call, 'match')[0]?.[0] as { id?: string } | undefined)?.id;
    const version = opArgs(call, 'eq').find(([c]) => c === 'updated_at')?.[1];
    if (has(call, 'update')) {
      const k = db.items.findIndex((i) => i.id === id);
      if (k < 0 || !actor.canLead() || db.items[k]!.updated_at !== version) return { data: null };
      const patch = opArgs(call, 'update')[0]![0] as Partial<FakeItem>;
      db.items[k] = { ...db.items[k]!, ...patch, updated_at: nextAt() };
      return { data: db.items[k] };
    }
    if (has(call, 'delete')) {
      const k = db.items.findIndex((i) => i.id === id);
      if (k < 0 || !actor.canLead() || db.items[k]!.updated_at !== version) return { data: [] };
      if ([...db.requests, ...db.assignments, ...db.records].some((r) => r.lending_item_id === id)) return pgError('23503', 409);
      const [gone] = db.items.splice(k, 1);
      return { data: [gone] };
    }
    if (opArgs(call, 'select')[0]?.[0] === 'updated_at') {
      return single(call, db.items.filter((i) => i.id === id).map((i) => ({ updated_at: i.updated_at })));
    }
    return single(call, filterRows(call, db.items).map((i) => embedInItem(call, i)));
  }

  function pairs(call: FakeCall, list: FakePair[], kind: 'request'): FakeResult {
    if (has(call, 'upsert')) {
      const vs = opArgs(call, 'upsert')[0]![0] as Omit<FakePair, 'updated_at' | 'updated_by'>[];
      if (kind === 'request' && vs.some((v) => !actor.canRequest(v.group_id))) return pgError('42501', 403);
      const at = nextAt();
      const out: FakePair[] = [];
      for (const v of vs) {
        const k = list.findIndex((r) => r.group_id === v.group_id && r.lending_item_id === v.lending_item_id);
        const row: FakePair = { ...v, updated_by: actor.userId, updated_at: at };
        if (k < 0) list.push(row);
        else list[k] = row;
        out.push(row);
      }
      return { data: out };
    }
    return single(call, filterRows(call, list));
  }

  function records(call: FakeCall): FakeResult {
    if (has(call, 'upsert')) {
      if (!actor.canRecord()) return pgError('42501', 403);
      const vs = opArgs(call, 'upsert')[0]![0] as Omit<FakeRecord, 'updated_at' | 'updated_by'>[];
      if (vs.some((v) => !(v.damaged_count <= v.returned_count && v.returned_count <= v.lent_count))) return pgError('23514', 400);
      const at = nextAt();
      const out: FakeRecord[] = [];
      for (const v of vs) {
        const k = db.records.findIndex((r) => r.group_id === v.group_id && r.lending_item_id === v.lending_item_id);
        const row: FakeRecord = { ...v, updated_by: actor.userId, updated_at: at };
        if (k < 0) db.records.push(row);
        else db.records[k] = row;
        out.push(row);
      }
      return { data: out };
    }
    return single(call, filterRows(call, db.records).map((r) => ({ ...r, lending_items: itemEmbed(r.lending_item_id) })));
  }

  function saveAssignments(call: FakeCall): FakeResult {
    const args = opArgs(call, 'rpc')[0]![0] as { p_year_id: string; p_changes: { groupId: string; itemId: string; count: number | null; updatedAt: string | null }[] };
    if (!actor.canLead() && !actor.closed()) return pgError('P0001', 400, 'forbidden');
    if (actor.closed()) return pgError('P0001', 400, 'invalid_state', { status: 'closed' });
    if (db.confirmedAt) return pgError('P0001', 400, 'invalid_state', { reason: 'confirmed' });
    for (const c of args.p_changes) {
      const row = db.assignments.find((a) => a.group_id === c.groupId && a.lending_item_id === c.itemId);
      const same = row && c.updatedAt !== null && Date.parse(row.updated_at) === Date.parse(c.updatedAt);
      if ((row && !same) || (!row && c.updatedAt !== null)) {
        return pgError('P0001', 400, 'conflict', { group_id: c.groupId, lending_item_id: c.itemId });
      }
    }
    const at = nextAt();
    const out = args.p_changes.map((c) => {
      const k = db.assignments.findIndex((a) => a.group_id === c.groupId && a.lending_item_id === c.itemId);
      if (c.count === null) {
        if (k >= 0) db.assignments.splice(k, 1);
        return { groupId: c.groupId, itemId: c.itemId, count: null, updatedAt: null };
      }
      const row: FakePair = { group_id: c.groupId, lending_item_id: c.itemId, year_id: args.p_year_id, count: c.count, updated_by: actor.userId, updated_at: at };
      if (k < 0) db.assignments.push(row);
      else db.assignments[k] = row;
      return { groupId: c.groupId, itemId: c.itemId, count: c.count, updatedAt: at };
    });
    return { data: out };
  }

  function setConfirmed(call: FakeCall): FakeResult {
    const args = opArgs(call, 'rpc')[0]![0] as { p_year_id: string; p_confirmed: boolean; p_reason?: string };
    if (!actor.canLead() && !actor.closed()) return pgError('P0001', 400, 'forbidden');
    if (actor.closed()) return pgError('P0001', 400, 'invalid_state', { status: 'closed' });
    if (!!db.confirmedAt === args.p_confirmed) return pgError('P0001', 400, 'invalid_state', { reason: 'unchanged', confirmed: !!db.confirmedAt });
    if (!args.p_confirmed && !args.p_reason?.trim()) return pgError('P0001', 400, 'reason_required');
    db.confirmedAt = args.p_confirmed ? nextAt() : null;
    return { data: { year_id: args.p_year_id, confirmed_at: db.confirmedAt, confirmed_by: args.p_confirmed ? actor.userId : null } };
  }
}
