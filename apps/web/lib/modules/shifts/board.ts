// シフト表（/shifts）と印刷（/shifts/print）の組み立て（04「シフト表」「シフト表の印刷」、notes/T20.md「画面の約束」4・6。T20・D-56）。
// 純粋な関数（時計は now だけ）。読んだ時間枠（ますと割り当てを埋め込む）と持ち場から、日のタブ・表（行は時間枠、列は持ち場）・
// ます・合計・人を選ぶ一覧・人ごとのまとめを作る。ダッシュボード（/）はこのファイルを読まない（portal.ts は time.ts だけを使う）。
import { isSoumu, type AppRole } from '@/lib/auth/roles';
import { addDays, tokyoToday } from '@/lib/datetime';
import { compareByName } from './names';
import { isSlotUpcoming, shiftDayLabel, slotDayOf, slotTimeLabel, timeOf } from './time';

// ---------------------------------------------------------------- 読んだ行の形

/** ますの割り当て（shift_assignments） */
export interface BoardAssignment {
  user_id: string;
  updated_at: string;
}

/** ます（shift_needs。行がなければ、その時間枠にその持ち場はない） */
export interface BoardNeed {
  duty_id: string;
  required_count: number;
  updated_at: string;
  shift_assignments: BoardAssignment[];
}

/** 時間枠（shift_slots。ますと割り当てを埋め込む） */
export interface BoardSlot {
  id: string;
  starts_at: string;
  ends_at: string;
  updated_at: string;
  shift_needs: BoardNeed[];
}

/** 持ち場（shift_duties） */
export interface BoardDuty {
  id: string;
  name: string;
  place: string | null;
  note: string | null;
  sort_order: number;
  updated_at: string;
}

/** シフト表の読み取り（lib/data/shifts.ts の shiftBoardOptions） */
export interface ShiftBoard {
  /** 開始の早い順・id の順 */
  slots: BoardSlot[];
  duties: BoardDuty[];
}

const cmp = (a: string, b: string) => (a < b ? -1 : a > b ? 1 : 0);

// ---------------------------------------------------------------- 並び

/** 持ち場の並び（sort_order → 名前 → id。CLAUDE.md の約束） */
export function compareDuties(a: Pick<BoardDuty, 'sort_order' | 'name' | 'id'>, b: Pick<BoardDuty, 'sort_order' | 'name' | 'id'>): number {
  return a.sort_order - b.sort_order || a.name.localeCompare(b.name, 'ja') || cmp(a.id, b.id);
}

/** 持ち場を並べる（元の配列は変えない） */
export function sortDuties<T extends Pick<BoardDuty, 'sort_order' | 'name' | 'id'>>(duties: readonly T[]): T[] {
  return [...duties].sort(compareDuties);
}

/** 時間枠の並び（開始の早い順、同じなら id の順。読めない日時は後） */
export function compareSlots(a: Pick<BoardSlot, 'id' | 'starts_at'>, b: Pick<BoardSlot, 'id' | 'starts_at'>): number {
  const ta = timeOf(a.starts_at);
  const tb = timeOf(b.starts_at);
  const x = Number.isNaN(ta) ? Number.POSITIVE_INFINITY : ta;
  const y = Number.isNaN(tb) ? Number.POSITIVE_INFINITY : tb;
  return x - y || cmp(a.id, b.id);
}

// ---------------------------------------------------------------- 日

/** 日のタブの1つ */
export interface ShiftDay {
  /** Asia/Tokyo の `YYYY-MM-DD` */
  date: string;
  /** 「前日（10/15）」「10/18（土）」 */
  label: string;
}

/** 時間枠のある日（開始の Asia/Tokyo の日付。早い順）と名前 */
export function shiftDays(slots: readonly Pick<BoardSlot, 'starts_at'>[], festivalStart: string | null | undefined, now: number): ShiftDay[] {
  const dates = [...new Set(slots.map(slotDayOf).filter((d) => d !== ''))].sort();
  return dates.map((date) => ({ date, label: shiftDayLabel(date, festivalStart, now) }));
}

/**
 * 既定の日（04「シフト表」）：今日に時間枠があれば今日、なければ今日より後で最初に時間枠のある日、それもなければ最後の日。
 * 日がなければ null。
 */
export function defaultShiftDay(days: readonly Pick<ShiftDay, 'date'>[], now: number): string | null {
  if (days.length === 0) return null;
  const today = tokyoToday(new Date(now));
  return (days.find((d) => d.date === today) ?? days.find((d) => d.date > today) ?? days[days.length - 1]!).date;
}

/** `?day=` の日（時間枠のある日ならそれ、ない日・形の違う値・なしなら既定の日） */
export function pickShiftDay(days: readonly Pick<ShiftDay, 'date'>[], param: string | null | undefined, now: number): string | null {
  const v = param?.trim() ?? '';
  return days.some((d) => d.date === v) ? v : defaultShiftDay(days, now);
}

/** その日の時間枠（開始の早い順・id の順） */
export function slotsOfDay<T extends Pick<BoardSlot, 'id' | 'starts_at'>>(slots: readonly T[], day: string): T[] {
  return slots.filter((s) => slotDayOf(s) === day).sort(compareSlots);
}

// ---------------------------------------------------------------- 表

/** ますの状態：none（ますがない「—」）・ok（そろっている。必要人数 0 も）・short（足りない）・over（多い） */
export type CellState = 'none' | 'ok' | 'short' | 'over';

/** ますの人 */
export interface CellMember {
  userId: string;
  /** 表示名（読めなければ null。「名前を表示できません」） */
  name: string | null;
  /** 総務か（ロールが分からない〔総務部門員の表・ロールの読み込み前〕ときは真として数える） */
  soumu: boolean;
  /** 自分か */
  me: boolean;
  /** 割り当ての updated_at（外す・移すの楽観ロック） */
  updatedAt: string;
}

/** 合計（「{数}/{必要人数}」。必要人数 0 のますは数だけを足す） */
export interface CellTotal {
  count: number;
  required: number;
}

/** ます（時間枠 × 持ち場） */
export interface ShiftCell {
  slot: BoardSlot;
  duty: BoardDuty;
  /** ますの行（なければ null＝「—」） */
  need: BoardNeed | null;
  /** 割り当てた人（表示名の順） */
  members: CellMember[];
  /** 数（総務の割り当てだけ。ロールが分からなければ全部） */
  count: number;
  /** 必要人数（ますがなければ 0） */
  required: number;
  state: CellState;
}

/** 表の1行（時間枠） */
export interface ShiftRow {
  slot: BoardSlot;
  /** 「09:00〜10:00」 */
  label: string;
  cells: ShiftCell[];
  total: CellTotal;
}

/** 1日の表 */
export interface ShiftTable {
  day: string;
  /** 列（持ち場。sort_order → 名前 → id） */
  columns: BoardDuty[];
  rows: ShiftRow[];
  /** 列の合計（columns と同じ並び） */
  columnTotals: CellTotal[];
}

export interface ShiftTableOptions {
  /** 列にその年度の持ち場を全部出すか（部門長以上）。偽ならその日にますのある持ち場だけ（総務部門員） */
  allDuties: boolean;
  /** 人のロール（部門長以上。総務でない人を数えない）。null なら分けずに全部を数える（総務部門員・読み込み前） */
  roles: ReadonlyMap<string, AppRole> | null;
  /** 表示名 */
  names: ReadonlyMap<string, string>;
  /** 自分の user_id（目立たせる） */
  userId: string | null;
}

/** ますの状態（必要人数 0 は数によらず ok） */
export function cellStateOf(need: Pick<BoardNeed, 'required_count'> | null, count: number): CellState {
  if (!need) return 'none';
  if (need.required_count === 0) return 'ok';
  if (count < need.required_count) return 'short';
  return count > need.required_count ? 'over' : 'ok';
}

/** ますの人（表示名の順）と数 */
export function cellMembers(
  need: BoardNeed | null,
  opts: Pick<ShiftTableOptions, 'roles' | 'names' | 'userId'>,
): { members: CellMember[]; count: number } {
  if (!need) return { members: [], count: 0 };
  const members = need.shift_assignments
    .map((a) => {
      const role = opts.roles?.get(a.user_id);
      return {
        userId: a.user_id,
        name: opts.names.get(a.user_id) ?? null,
        // ロールが分からない（総務部門員の表・読み込み前）ときは総務として数える。部門長以上の表で行がない人も同じ（外部キーで消える）
        soumu: opts.roles === null || role === undefined || isSoumu(role),
        me: a.user_id === opts.userId,
        updatedAt: a.updated_at,
      };
    })
    .sort(compareByName);
  return { members, count: members.filter((m) => m.soumu).length };
}

/**
 * 1日の表（04「シフト表」の表）：行はその日の時間枠（開始の早い順）、列は持ち場（allDuties なら全部、でなければその日にますのある
 * 持ち場だけ。sort_order → 名前 → id）。ますは割り当てた人・数・状態、行の終わりと列の下に合計。
 */
export function buildShiftTable(board: ShiftBoard, day: string, opts: ShiftTableOptions): ShiftTable {
  const slots = slotsOfDay(board.slots, day);
  const used = new Set(slots.flatMap((s) => s.shift_needs.map((n) => n.duty_id)));
  const columns = sortDuties(opts.allDuties ? board.duties : board.duties.filter((d) => used.has(d.id)));
  const columnTotals: CellTotal[] = columns.map(() => ({ count: 0, required: 0 }));
  const rows = slots.map((slot) => {
    const total: CellTotal = { count: 0, required: 0 };
    const cells = columns.map((duty, k) => {
      const need = slot.shift_needs.find((n) => n.duty_id === duty.id) ?? null;
      const { members, count } = cellMembers(need, opts);
      const required = need?.required_count ?? 0;
      if (need) {
        total.count += count;
        total.required += required;
        columnTotals[k]!.count += count;
        columnTotals[k]!.required += required;
      }
      return { slot, duty, need, members, count, required, state: cellStateOf(need, count) };
    });
    return { slot, label: slotTimeLabel(slot), cells, total };
  });
  return { day, columns, rows, columnTotals };
}

/** 合計の文（「2/3」。必要人数が 0 なら「2人」） */
export function totalText(t: CellTotal): string {
  return t.required === 0 ? `${t.count}人` : `${t.count}/${t.required}`;
}

/** ますの数の文（「2/3」・必要人数 0 は「2人」・ますがなければ「—」） */
export function cellCountText(cell: Pick<ShiftCell, 'need' | 'count' | 'required'>): string {
  if (!cell.need) return '—';
  return cell.required === 0 ? `${cell.count}人` : `${cell.count}/${cell.required}`;
}

/** 足りない・多いの文（「あと1人」「+1」。どちらでもなければ空文字） */
export function cellDiffText(cell: Pick<ShiftCell, 'state' | 'count' | 'required'>): string {
  if (cell.state === 'short') return `あと${cell.required - cell.count}人`;
  if (cell.state === 'over') return `+${cell.count - cell.required}`;
  return '';
}

/** ますのボタンの読み上げの名前（「09:00〜10:00 受付 2/3 人、あと1人」） */
export function cellAriaLabel(cell: ShiftCell, rowLabel: string): string {
  const head = `${rowLabel} ${cell.duty.name}`;
  if (!cell.need) return `${head} ますなし`;
  if (cell.required === 0) return `${head} ${cell.count}人`;
  const diff = cellDiffText(cell);
  return `${head} ${cell.count}/${cell.required} 人${diff ? `、${diff}` : ''}`;
}

/** これからの時間枠（終わりが今より後）の、足りないます（必要人数が 1 以上で数がそれより少ない）か（`?filter=short`） */
export function isShortCell(cell: Pick<ShiftCell, 'slot' | 'need' | 'required' | 'count'>, now: number): boolean {
  return !!cell.need && cell.required >= 1 && cell.count < cell.required && isSlotUpcoming(cell.slot, now);
}

// ---------------------------------------------------------------- 人を選ぶ一覧

/** 人を選ぶ一覧の状態：in（このますに入っている）・busy（同じ時間枠のほかのますに入っている）・free（入れられる） */
export type MemberChoiceState = 'in' | 'busy' | 'free';

/** 人を選ぶ一覧の1人 */
export interface MemberChoice {
  userId: string;
  name: string | null;
  /** ロール（分からなければ null） */
  role: AppRole | null;
  /** 総務か（「総務でない人」は外すだけ） */
  soumu: boolean;
  state: MemberChoiceState;
  /** busy・in のときの持ち場（busy は「{持ち場}に入っています」） */
  dutyId: string | null;
  dutyName: string | null;
  /** in・busy のときの割り当ての updated_at（外す・移すの楽観ロック） */
  updatedAt: string | null;
  /** その日の割り当ての数（「この日 2 枠」） */
  dayCount: number;
}

/**
 * ますのダイアログの人を選ぶ一覧（04「シフト表」のますのダイアログ）：その年度の総務（ロールが総務の人）と、このますに入っている
 * 総務でない人（閲覧のみに変わった人）を、表示名の順に並べる。このますに入っている人は in、その時間枠のほかのますに入っている人は
 * busy（持ち場の名前つき）、ほかは free。この日の枠の数は、その時間枠と同じ日（開始の Asia/Tokyo の日付）の時間枠の割り当ての数。
 */
export function memberChoices(
  board: ShiftBoard,
  members: readonly { user_id: string; role: AppRole }[],
  names: ReadonlyMap<string, string>,
  slotId: string,
  dutyId: string,
): MemberChoice[] {
  const slot = board.slots.find((s) => s.id === slotId);
  if (!slot) return [];
  const day = slotDayOf(slot);
  const dutyNames = new Map(board.duties.map((d) => [d.id, d.name]));
  const roles = new Map(members.map((m) => [m.user_id, m.role]));
  /** この時間枠の人 → 持ち場と updated_at */
  const inSlot = new Map<string, { dutyId: string; updatedAt: string }>();
  for (const n of slot.shift_needs) for (const a of n.shift_assignments) inSlot.set(a.user_id, { dutyId: n.duty_id, updatedAt: a.updated_at });
  const dayCount = new Map<string, number>();
  for (const s of board.slots) {
    if (slotDayOf(s) !== day) continue;
    const seen = new Set<string>();
    for (const n of s.shift_needs) for (const a of n.shift_assignments) seen.add(a.user_id);
    for (const u of seen) dayCount.set(u, (dayCount.get(u) ?? 0) + 1);
  }
  const ids = new Set(members.filter((m) => isSoumu(m.role)).map((m) => m.user_id));
  for (const [u, at] of inSlot) if (at.dutyId === dutyId) ids.add(u);
  return [...ids]
    .map((userId): MemberChoice => {
      const role = roles.get(userId) ?? null;
      const at = inSlot.get(userId);
      const state: MemberChoiceState = !at ? 'free' : at.dutyId === dutyId ? 'in' : 'busy';
      return {
        userId,
        name: names.get(userId) ?? null,
        role,
        soumu: role !== null && isSoumu(role),
        state,
        dutyId: at?.dutyId ?? null,
        dutyName: at ? (dutyNames.get(at.dutyId) ?? null) : null,
        updatedAt: at?.updatedAt ?? null,
        dayCount: dayCount.get(userId) ?? 0,
      };
    })
    .sort(compareByName);
}

/** 同じ時間枠のほかのます（移す先。持ち場の並び） */
export function otherCellsOfSlot(board: ShiftBoard, slotId: string, dutyId: string): BoardDuty[] {
  const slot = board.slots.find((s) => s.id === slotId);
  if (!slot) return [];
  const ids = new Set(slot.shift_needs.map((n) => n.duty_id).filter((d) => d !== dutyId));
  return sortDuties(board.duties.filter((d) => ids.has(d.id)));
}

// ---------------------------------------------------------------- 印刷（人ごと）

/** 人ごとのカードの1件 */
export interface PersonShift {
  slot: BoardSlot;
  label: string;
  duty: BoardDuty | null;
}

/** 人ごとのカード（その日に割り当てのある人） */
export interface PersonDay {
  userId: string;
  name: string | null;
  /** 開始の順 */
  items: PersonShift[];
}

/** その日に割り当てのある人ごとのまとめ（表示名の順。人の中は開始の順） */
export function peopleOfDay(board: ShiftBoard, day: string, names: ReadonlyMap<string, string>): PersonDay[] {
  const duties = new Map(board.duties.map((d) => [d.id, d]));
  const byUser = new Map<string, PersonShift[]>();
  for (const slot of slotsOfDay(board.slots, day)) {
    for (const n of slot.shift_needs) {
      for (const a of n.shift_assignments) {
        const list = byUser.get(a.user_id) ?? [];
        list.push({ slot, label: slotTimeLabel(slot), duty: duties.get(n.duty_id) ?? null });
        byUser.set(a.user_id, list);
      }
    }
  }
  return [...byUser]
    .map(([userId, items]) => ({ userId, name: names.get(userId) ?? null, items: items.sort((a, b) => compareSlots(a.slot, b.slot)) }))
    .sort(compareByName);
}

/** 配列を n ずつに分ける（印刷の表は持ち場を 8 ずつ） */
export function chunk<T>(list: readonly T[], n: number): T[][] {
  const size = Math.max(1, Math.floor(n));
  const out: T[][] = [];
  for (let k = 0; k < list.length; k += size) out.push(list.slice(k, k + size));
  return out;
}

// ---------------------------------------------------------------- 1日分をまとめて作る

/** 区切りの選択肢（分） */
export const SLOT_STEPS = [15, 30, 60, 90, 120] as const;
export type SlotStep = (typeof SLOT_STEPS)[number];
/** 1回に作れる時間枠の数（add_shift_slots の上限） */
export const DAY_PLAN_MAX = 96;

/** 1日分の時間枠の計画の1つ（送る値。`+09:00` の ISO 文字列） */
export interface PlannedSlot {
  starts_at: string;
  ends_at: string;
}

const HHMM = /^([01]\d|2[0-3]):([0-5]\d)$/;

/** `HH:mm` を 0 時からの分にする（24:00 は 1440。end のときだけ許す）。形が違えば null */
export function minutesOf(hhmm: string, allow24 = false): number | null {
  if (allow24 && hhmm === '24:00') return 1440;
  const m = HHMM.exec(hhmm);
  return m ? Number(m[1]) * 60 + Number(m[2]) : null;
}

const pad2 = (n: number) => String(n).padStart(2, '0');

/** 日付と 0 時からの分（0〜1440）を `YYYY-MM-DDTHH:mm:00+09:00` にする（1440 は次の日の 0 時）。日付が読めなければ空文字 */
export function tokyoIsoAt(date: string, minutes: number): string {
  const days = Math.floor(minutes / 1440);
  const rest = minutes - days * 1440;
  // addDays は暦にない日付（2027-02-30 など）と形の違う値を空文字にする（0 日でも確かめる）
  const d = addDays(date, days);
  if (!d) return '';
  return `${d}T${pad2(Math.floor(rest / 60))}:${pad2(rest % 60)}:00+09:00`;
}

/** 1日分の計画の結果 */
export type DayPlan =
  | { ok: true; slots: PlannedSlot[] }
  /** order：終わりが始まり以前、too_many：97 以上、invalid：形が違う */
  | { ok: false; reason: 'order' | 'too_many' | 'invalid' };

/**
 * 1日分の時間枠（04「シフト表」の「1日分をまとめて作る」）：始まりから区切りごとに作り、最後の枠は終わりで切る（同じ日の中。終わりは
 * 24:00 まで）。1〜96 個。
 *
 * @example
 * slotsOfDayPlan({ date: '2027-10-15', start: '09:00', end: '11:30', stepMinutes: 60 })
 * // 09:00〜10:00・10:00〜11:00・11:00〜11:30
 */
export function slotsOfDayPlan(p: { date: string; start: string; end: string; stepMinutes: number }): DayPlan {
  const s = minutesOf(p.start);
  const e = minutesOf(p.end, true);
  if (s === null || e === null || !Number.isInteger(p.stepMinutes) || p.stepMinutes <= 0 || !tokyoIsoAt(p.date, 0)) {
    return { ok: false, reason: 'invalid' };
  }
  if (e <= s) return { ok: false, reason: 'order' };
  const count = Math.ceil((e - s) / p.stepMinutes);
  if (count > DAY_PLAN_MAX) return { ok: false, reason: 'too_many' };
  const slots: PlannedSlot[] = [];
  for (let t = s; t < e; t += p.stepMinutes) {
    slots.push({ starts_at: tokyoIsoAt(p.date, t), ends_at: tokyoIsoAt(p.date, Math.min(t + p.stepMinutes, e)) });
  }
  return { ok: true, slots };
}

/** 2つの時間枠が重なるか（[開始, 終わり) の重なり。隣り合う枠は重ならない） */
export function slotsOverlap(a: PlannedSlot, b: PlannedSlot): boolean {
  return timeOf(a.starts_at) < timeOf(b.ends_at) && timeOf(b.starts_at) < timeOf(a.ends_at);
}

/** 計画のどれかと重なる今ある時間枠（開始の順。exceptId の時間枠は除く〔時刻を直すとき〕） */
export function overlappingSlots<T extends Pick<BoardSlot, 'id' | 'starts_at' | 'ends_at'>>(
  plan: readonly PlannedSlot[],
  slots: readonly T[],
  exceptId?: string,
): T[] {
  return slots.filter((s) => s.id !== exceptId && plan.some((p) => slotsOverlap(p, s))).sort(compareSlots);
}

// ---------------------------------------------------------------- 書いた後のキャッシュ（読み直しの前に表に出す）

/** 割り当てを入れる・移す（同じ時間枠のほかのますにいれば外してから、そのますに入れる）。元の表は変えない */
export function boardWithAssignment(board: ShiftBoard, a: { slot_id: string; duty_id: string; user_id: string; updated_at: string }): ShiftBoard {
  return {
    ...board,
    slots: board.slots.map((s) =>
      s.id !== a.slot_id
        ? s
        : {
            ...s,
            shift_needs: s.shift_needs.map((n) => {
              const rest = n.shift_assignments.filter((x) => x.user_id !== a.user_id);
              return n.duty_id === a.duty_id ? { ...n, shift_assignments: [...rest, { user_id: a.user_id, updated_at: a.updated_at }] } : { ...n, shift_assignments: rest };
            }),
          },
    ),
  };
}

/** 割り当てを外す。元の表は変えない */
export function boardWithoutAssignment(board: ShiftBoard, slotId: string, userId: string): ShiftBoard {
  return {
    ...board,
    slots: board.slots.map((s) =>
      s.id !== slotId ? s : { ...s, shift_needs: s.shift_needs.map((n) => ({ ...n, shift_assignments: n.shift_assignments.filter((x) => x.user_id !== userId) })) },
    ),
  };
}

/** ますを作る・必要人数を変える（割り当てはそのまま）。元の表は変えない */
export function boardWithNeed(board: ShiftBoard, need: { slot_id: string; duty_id: string; required_count: number; updated_at: string }): ShiftBoard {
  return {
    ...board,
    slots: board.slots.map((s) => {
      if (s.id !== need.slot_id) return s;
      const found = s.shift_needs.some((n) => n.duty_id === need.duty_id);
      const shift_needs = found
        ? s.shift_needs.map((n) => (n.duty_id === need.duty_id ? { ...n, required_count: need.required_count, updated_at: need.updated_at } : n))
        : [...s.shift_needs, { duty_id: need.duty_id, required_count: need.required_count, updated_at: need.updated_at, shift_assignments: [] }];
      return { ...s, shift_needs };
    }),
  };
}

/** ますを外す（割り当ても消える）。元の表は変えない */
export function boardWithoutNeed(board: ShiftBoard, slotId: string, dutyId: string): ShiftBoard {
  return {
    ...board,
    slots: board.slots.map((s) => (s.id !== slotId ? s : { ...s, shift_needs: s.shift_needs.filter((n) => n.duty_id !== dutyId) })),
  };
}

/** 時間枠の数と割り当ての人数（削除の確かめ「この時間枠の {N} 人の割り当ても消えます。」） */
export function slotAssignmentCount(slot: Pick<BoardSlot, 'shift_needs'>): number {
  return slot.shift_needs.reduce((n, x) => n + x.shift_assignments.length, 0);
}

/** 持ち場のますの数と割り当ての人数（削除の確かめ「この持ち場の {N} のますと {M} 人の割り当ても消えます。」） */
export function dutyUsage(board: ShiftBoard, dutyId: string): { needs: number; assignments: number } {
  let needs = 0;
  let assignments = 0;
  for (const s of board.slots) {
    for (const n of s.shift_needs) {
      if (n.duty_id !== dutyId) continue;
      needs++;
      assignments += n.shift_assignments.length;
    }
  }
  return { needs, assignments };
}

/** 時間枠の時刻を名前にする表（overlap の文言の括弧。lib/errors.ts の NameLookup.slot） */
export function slotLabelLookup(board: ShiftBoard | undefined): (id: string) => string | undefined {
  const map = new Map((board?.slots ?? []).map((s) => [s.id, slotTimeLabel(s)]));
  return (id) => map.get(id) || undefined;
}
