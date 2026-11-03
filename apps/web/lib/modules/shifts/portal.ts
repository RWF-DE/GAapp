// シフト・作業がダッシュボード（/）に出すもの（D-52・D-56。04「ダッシュボードに出すもの（シフト・作業）」、notes/T20.md「画面の約束」10。
// T20）。
// - 欄：総務にだけ、要対応・締切と予定・機能ごとのカード（専用の欄は作らない。お知らせの欄には出さない）。閲覧のみ・店長・副店長には
//   何も出さない（kinds は soumu だけ。読まない）。年度の行だけで決まる項目はない（fromYear なし）。
// - 読む：portal-read.ts（総務の全員は自分の割り当てと自分が担当の完了でない作業を1本、部門長以上は加えて時間枠のますと作業の全部）。
//   読み取りの結果を使う欄は3つ（query.widgets）なので、読み込み中・失敗はこの3つの欄にシフト・作業の分だけ出る（「シフト・作業：…」と
//   「もう一度」）。
// shiftsPortal(raw, ctx) は純粋関数（時計は ctx.now だけ）。リンクはどれも canOpen で確かめ、開けない要対応・締切と予定は作らない。
// シフト表の組み立て（board.ts）・lib/data・画面の部品を読まない（/ の JS を軽くする）。
import { isLead, isSoumu } from '@/lib/auth/roles';
import { formatShortDate, formatTime, tokyoToday } from '@/lib/datetime';
import { formatShortDateTimeWeekday } from '@/lib/datetime-weekday';
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
import { TASK_STATUS_LABELS } from './labels';
import { shiftsPortalOptions, type ShiftsPortalRaw } from './portal-read';
import { isTaskDueSoon, isTaskOverdue, TASK_URGENT_MS, taskSeverity } from './tasks';
import { isSlotNow, isSlotUpcoming, slotDayOf, slotTimeLabel, timeOf } from './time';

const MODULE_ID: ModuleId = 'shifts';

/** 自分の枠（読めたものだけ。開始の早い順） */
interface MySlot {
  startsAt: string;
  endsAt: string;
  dutyName: string;
  day: string;
}

const cmp = (a: string, b: string) => (a < b ? -1 : a > b ? 1 : 0);

function mySlotsOf(raw: ShiftsPortalRaw): MySlot[] {
  const out: MySlot[] = [];
  for (const a of raw.mine.assignments) {
    const slot = a.shift_needs?.shift_slots;
    const duty = a.shift_needs?.shift_duties;
    if (!slot || !duty || Number.isNaN(timeOf(slot.starts_at)) || Number.isNaN(timeOf(slot.ends_at))) continue;
    out.push({ startsAt: slot.starts_at, endsAt: slot.ends_at, dutyName: duty.name, day: slotDayOf(slot) });
  }
  return out.sort((a, b) => timeOf(a.startsAt) - timeOf(b.startsAt) || cmp(a.day, b.day));
}

const times = (s: MySlot) => ({ starts_at: s.startsAt, ends_at: s.endsAt });
const startTime = (s: MySlot) => formatTime(s.startsAt);

/** 今の立場で開ける行き先か（開けなければ null） */
const linkFor = (ctx: PortalContext, href: string): string | null => (canOpen(href, ctx.audiences, ctx.year.status) ? href : null);

/** カードの総務の行（今日のあなたのシフト・次のシフト・これからのシフトはない・まだない） */
function myShiftCardLine(slots: readonly MySlot[], now: number): string {
  const today = tokyoToday(new Date(now));
  const todays = slots.filter((s) => s.day === today);
  if (todays.length > 0) {
    const cur = todays.find((s) => isSlotNow(times(s), now));
    if (cur) return `今日のあなたのシフト ${todays.length} 枠（今 ${startTime(cur)}〜 ${cur.dutyName}）`;
    const next = todays.find((s) => timeOf(s.startsAt) > now);
    if (next) return `今日のあなたのシフト ${todays.length} 枠（次 ${startTime(next)}〜 ${next.dutyName}）`;
    return `今日のあなたのシフト ${todays.length} 枠（今日の分は終わりました）`;
  }
  const next = slots.find((s) => timeOf(s.startsAt) > now);
  if (next) return `次のシフト ${formatShortDateTimeWeekday(next.startsAt, Number(today.slice(0, 4)))}〜 ${next.dutyName}`;
  return slots.length > 0 ? 'あなたのこれからのシフトはありません' : 'あなたのシフトはまだありません';
}

/** 足りないます（これからの時間枠のますのうち、必要人数が 1 以上で総務の割り当てがそれより少ないもの） */
interface ShortCell {
  day: string;
  startsAt: string;
}

function shortCellsOf(raw: ShiftsPortalRaw, now: number): ShortCell[] {
  const out: ShortCell[] = [];
  for (const slot of raw.slots ?? []) {
    if (Number.isNaN(timeOf(slot.starts_at)) || !isSlotUpcoming(slot, now)) continue;
    for (const n of slot.shift_needs) {
      if (n.required_count < 1) continue;
      // ロールが総務の割り当てだけを数える（閲覧のみに変わった人は数えない。ロールが読めない行は総務として数える）
      const count = n.shift_assignments.filter((a) => a.year_roles === null || isSoumu(a.year_roles.role)).length;
      if (count < n.required_count) out.push({ day: slotDayOf(slot), startsAt: slot.starts_at });
    }
  }
  return out;
}

/**
 * シフト・作業がダッシュボードに出すもの（04「ダッシュボードに出すもの（シフト・作業）」）。総務の全員：カードの自分のシフトの行、
 * 要対応の今日のシフトと自分が担当の作業、締切と予定の自分の作業の締切と自分のシフトの日。部門長以上は加えて、カードの足りない枠と
 * 作業の進み具合、要対応の足りない枠・締切を過ぎた作業・締切が近い作業・担当者のいない作業。総務部門員はカードに自分の作業。
 */
export function shiftsPortal(raw: ShiftsPortalRaw, ctx: PortalContext): PortalSection {
  const now = ctx.now;
  const lead = isLead(ctx.role) && raw.slots !== null && raw.tasks !== null;
  const mine = mySlotsOf(raw);
  const todos: TodoItem[] = [];
  const add = (t: Omit<TodoItem, 'moduleId'>) => {
    if (canOpen(t.href, ctx.audiences, ctx.year.status)) todos.push({ ...t, moduleId: MODULE_ID });
  };
  const today = tokyoToday(new Date(now));

  // ---- 要対応（総務）：今日のシフト
  const unfinishedToday = mine.filter((s) => s.day === today && isSlotUpcoming(times(s), now));
  if (unfinishedToday.length > 0) {
    const shown = unfinishedToday.find((s) => isSlotNow(times(s), now)) ?? unfinishedToday[0]!;
    const prefix = isSlotNow(times(shown), now) ? '今' : '次';
    const rest = unfinishedToday.length - 1;
    add({
      id: 'shifts:today',
      title: `今日のシフト：${prefix} ${slotTimeLabel(times(shown))} ${shown.dutyName}${rest > 0 ? `（今日あと ${rest} 枠）` : ''}`,
      severity: 'normal',
      href: '/shift',
    });
  }
  // ---- 要対応（総務）：自分が担当の完了でない作業（1件ずつ）
  for (const t of raw.mine.tasks) {
    if (t.status === 'done') continue;
    add({
      id: `shifts:task:${t.id}`,
      title: `作業「${t.title}」（${TASK_STATUS_LABELS[t.status] ?? t.status}）`,
      severity: taskSeverity(t.due_at, now),
      ...(t.due_at ? { due: t.due_at } : {}),
      href: `/tasks?task=${t.id}`,
    });
  }

  // ---- カード
  const lines: string[] = [myShiftCardLine(mine, now)];
  if (lead) {
    const slots = raw.slots!;
    const tasks = raw.tasks!;
    const short = shortCellsOf(raw, now);
    if (slots.length === 0) lines.push('シフトの時間枠はまだありません');
    else if (!slots.some((s) => isSlotUpcoming(s, now))) lines.push('これからの時間枠はありません');
    else lines.push(short.length > 0 ? `人数が足りない枠 ${short.length}（これからの枠）` : 'これからの枠はすべてそろっています');
    const done = tasks.filter((t) => t.status === 'done').length;
    const overdue = tasks.filter((t) => isTaskOverdue(t, now));
    lines.push(tasks.length === 0 ? '作業はまだありません' : `作業 ${done}／${tasks.length} 件が完了${overdue.length > 0 ? `（締切を過ぎた ${overdue.length} 件）` : ''}`);

    // ---- 要対応（部門長以上）
    if (short.length > 0) {
      const byDay = new Map<string, number>();
      for (const c of short) byDay.set(c.day, (byDay.get(c.day) ?? 0) + 1);
      const days = [...byDay].sort((a, b) => cmp(a[0], b[0]));
      const soon = short.some((c) => timeOf(c.startsAt) - now < TASK_URGENT_MS);
      add({
        id: 'shifts:short',
        title: `人数が足りない枠 ${short.length}（${days.map(([d, n]) => `${formatShortDate(d)} ${n}`).join('・')}）`,
        count: short.length,
        severity: soon ? 'urgent' : 'normal',
        href: `/shifts?day=${days[0]![0]}&filter=short`,
      });
    }
    if (overdue.length > 0) {
      add({ id: 'shifts:overdue', title: `締切を過ぎた作業 ${overdue.length} 件`, count: overdue.length, severity: 'urgent', href: '/tasks?filter=overdue' });
    }
    const soonTasks = tasks.filter((t) => isTaskDueSoon(t, now));
    if (soonTasks.length > 0) {
      const earliest = soonTasks.map((t) => t.due_at!).sort((a, b) => timeOf(a) - timeOf(b))[0]!;
      add({
        id: 'shifts:due-soon',
        title: `締切が近い作業 ${soonTasks.length} 件（3日以内）`,
        count: soonTasks.length,
        severity: 'normal',
        due: earliest,
        href: '/tasks?filter=due-soon',
      });
    }
    const unassigned = tasks.filter((t) => t.status !== 'done' && t.assignee_id === null).length;
    if (unassigned > 0) {
      add({ id: 'shifts:unassigned', title: `担当者のいない作業 ${unassigned} 件`, count: unassigned, severity: 'normal', href: '/tasks?filter=unassigned' });
    }
  } else {
    const open = raw.mine.tasks.filter((t) => t.status !== 'done');
    const doing = open.filter((t) => t.status === 'doing').length;
    lines.push(open.length > 0 ? `自分の作業 ${open.length} 件（作業中 ${doing}・未着手 ${open.length - doing}）` : '自分の作業はありません');
  }
  const cardHref = lead ? '/shifts' : '/shift';
  const card: ModuleCardModel = {
    moduleId: MODULE_ID,
    title: moduleLabel(MODULE_ID),
    lines,
    href: linkFor(ctx, cardHref),
    linkLabel: lead ? 'シフト表へ' : '自分のシフトへ',
  };

  // ---- 締切と予定：自分が担当の完了でない作業の締切と、自分のシフトのある日
  const dated: DatedItem[] = [];
  for (const t of raw.mine.tasks) {
    if (t.status === 'done' || !t.due_at || Number.isNaN(timeOf(t.due_at))) continue;
    const href = linkFor(ctx, `/tasks?task=${t.id}`);
    dated.push({ id: `shifts:task-due:${t.id}`, moduleId: MODULE_ID, title: `作業の締切：${t.title}`, at: t.due_at, kind: 'deadline', ...(href ? { href } : {}) });
  }
  const byDay = new Map<string, MySlot[]>();
  for (const s of mine) byDay.set(s.day, [...(byDay.get(s.day) ?? []), s]);
  for (const [day, list] of [...byDay].sort((a, b) => cmp(a[0], b[0]))) {
    const first = list[0]!;
    const href = linkFor(ctx, `/shift?day=${day}`);
    dated.push({
      id: `shifts:day:${day}`,
      moduleId: MODULE_ID,
      title: `自分のシフト（${list.length} 枠。${startTime(first)}〜 ${first.dutyName}${list.length > 1 ? ' ほか' : ''}）`,
      at: day,
      kind: 'event',
      ...(href ? { href } : {}),
    });
  }

  return { card, todos, dated };
}

/**
 * シフト・作業のプロバイダ（providers.ts の PORTAL_PROVIDERS の最後）。総務だけ（kinds は soumu）。部門長以上は 'lead'、総務部門員は
 * 'staff' のキーで読む（select で欄の中身にする）。
 */
export const shiftsPortalProvider: PortalProvider = {
  moduleId: MODULE_ID,
  kinds: ['soumu'],
  query: {
    widgets: ['todos', 'dated', 'cards'],
    options: (ctx) =>
      isSoumu(ctx.role)
        ? portalQueryOptions(shiftsPortalOptions(ctx.year.id, isLead(ctx.role) ? 'lead' : 'staff'), (raw) => shiftsPortal(raw, ctx))
        : null,
  },
};
