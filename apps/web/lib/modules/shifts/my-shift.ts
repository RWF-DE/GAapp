// 自分のシフト（/shift）の組み立て（04「自分のシフト」、notes/T20.md「画面の約束」5。T20・D-56）。純粋な関数（時計は now だけ）。
// 自分の割り当て（時間枠・持ち場・同じますの人を埋め込んだもの）を日ごとにまとめ、今日 → これからの日 → 終わった日に並べる。
// シフト表の組み立て（board.ts）と書き込みの部品を読まない（部門員がスマホで開く画面の JS を軽くする）。
import { addDays, tokyoToday } from '@/lib/datetime';
import { formatDayHeading } from '@/lib/datetime-weekday';
import { compareByName } from './names';
import type { MyShiftRow } from './reads';
import { festivalDayName, isSlotNow, slotDayOf, slotTimeLabel, timeOf } from './time';

/** 自分のシフトの1件 */
export interface MyShiftItem {
  slotId: string;
  dutyId: string;
  startsAt: string;
  endsAt: string;
  /** 「09:00〜10:00」 */
  time: string;
  dutyName: string;
  place: string | null;
  note: string | null;
  /** 同じますの人（自分を除く。表示名の順。読めない人は null） */
  mates: { userId: string; name: string | null }[];
  /** 今の枠（始まり ≤ 今 < 終わり） */
  isNow: boolean;
  /** これからの枠のうち最初のもの（始まりが今より後） */
  isNext: boolean;
}

/** 自分のシフトの1日 */
export interface MyShiftDay {
  /** Asia/Tokyo の `YYYY-MM-DD` */
  date: string;
  /** 見出し（「11月5日（木）」） */
  heading: string;
  /** 祭の日の名前（「前日」など。なければ null） */
  festival: string | null;
  /** 「今日」「明日」（ほかは null） */
  relative: '今日' | '明日' | null;
  /** 今日より前の日（畳む） */
  past: boolean;
  /** 開始の早い順 */
  items: MyShiftItem[];
}

const cmp = (a: string, b: string) => (a < b ? -1 : a > b ? 1 : 0);

/**
 * 自分の割り当てを日ごとにまとめる（04「自分のシフト」の並び）：今日 → これからの日（早い順）→ 終わった日（今日より前。新しい順）。
 * 日の中は開始の早い順。今の枠に isNow、これからの枠（始まりが今より後）のうち最初のものに isNext。時間枠・持ち場が読めない行は出さない。
 */
export function buildMyShiftDays(
  rows: readonly MyShiftRow[],
  names: ReadonlyMap<string, string>,
  userId: string | null,
  now: number,
  festivalStart: string | null | undefined,
): MyShiftDay[] {
  const items: MyShiftItem[] = [];
  for (const r of rows) {
    const need = r.shift_needs;
    const slot = need?.shift_slots;
    const duty = need?.shift_duties;
    if (!need || !slot || !duty || Number.isNaN(timeOf(slot.starts_at)) || Number.isNaN(timeOf(slot.ends_at))) continue;
    const mates = need.shift_assignments
      .filter((a) => a.user_id !== userId)
      .map((a) => ({ userId: a.user_id, name: names.get(a.user_id) ?? null }))
      .sort(compareByName);
    items.push({
      slotId: slot.id,
      dutyId: duty.id,
      startsAt: slot.starts_at,
      endsAt: slot.ends_at,
      time: slotTimeLabel(slot),
      dutyName: duty.name,
      place: duty.place,
      note: duty.note,
      mates,
      isNow: isSlotNow(slot, now),
      isNext: false,
    });
  }
  items.sort((a, b) => timeOf(a.startsAt) - timeOf(b.startsAt) || cmp(a.slotId, b.slotId));
  const next = items.find((i) => timeOf(i.startsAt) > now);
  if (next) next.isNext = true;

  const today = tokyoToday(new Date(now));
  const tomorrow = addDays(today, 1);
  const thisYear = Number(today.slice(0, 4));
  const byDay = new Map<string, MyShiftItem[]>();
  for (const i of items) {
    const day = slotDayOf({ starts_at: i.startsAt });
    const list = byDay.get(day) ?? [];
    list.push(i);
    byDay.set(day, list);
  }
  const days = [...byDay].map(([date, list]): MyShiftDay => ({
    date,
    heading: formatDayHeading(date, thisYear),
    festival: festivalDayName(date, festivalStart),
    relative: date === today ? '今日' : date === tomorrow ? '明日' : null,
    past: date < today,
    items: list,
  }));
  const upcoming = days.filter((d) => !d.past).sort((a, b) => cmp(a.date, b.date));
  const past = days.filter((d) => d.past).sort((a, b) => cmp(b.date, a.date));
  return [...upcoming, ...past];
}
