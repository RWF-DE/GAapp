// シフト・作業がダッシュボードに出すもの（04「ダッシュボードに出すもの（シフト・作業）」、notes/T20.md「画面の約束」10。T20）：
// 立場ごとのカード・要対応・締切と予定（約束の表の全部の行）、時刻の境目（枠の始まり・終わりちょうど、締切ちょうど〔過ぎた側〕、24・72 時間、
// Asia/Tokyo の日付の境目）、開けない行き先を作らない、id、kinds と widgets、キー（lead・staff）、portal-read.ts が lib/modules/portal.ts を
// 実行時に import しない（import のグラフ）、loadShiftsPortal が偽のクライアントに送る select・絞り込み（部門員は1本、部門長以上は3本）。
import { describe, expect, it } from 'vitest';
import type { Audience } from '@/lib/auth/membership';
import type { AppRole } from '@/lib/auth/roles';
import type { YearRow } from '@/lib/db/types';
import { createFakeSupabase, opArgs } from '@/lib/testing/fake-supabase';
import { staticImportGraph } from '@/lib/testing/import-graph';
import { portalQueryKey, portalWidgetQuery, type PortalContext } from '../portal';
import { shiftsPortal, shiftsPortalProvider } from './portal';
import {
  loadShiftsPortal,
  SHIFTS_PORTAL_MINE_SELECT,
  SHIFTS_PORTAL_SLOTS_SELECT,
  SHIFTS_PORTAL_TASKS_SELECT,
  shiftsPortalOptions,
  type PortalMyAssignment,
  type PortalSlot,
  type PortalTask,
  type ShiftsPortalRaw,
} from './portal-read';

const uuid = (n: number) => `00000000-0000-4000-8000-${String(n).padStart(12, '0')}`;
const Y = uuid(1);
const ME = uuid(2);
const OTHER = uuid(3);
const VIEWER = uuid(4);
const H = 60 * 60 * 1000;
/** 今：2027-10-15（金）10:30 Asia/Tokyo */
const NOW = Date.parse('2027-10-15T01:30:00Z');
const at = (ms: number) => new Date(ms).toISOString();

const yearRow = { id: Y, label: 'R9', status: 'requesting', allocation_version: 1, festival_start: '2027-10-16' } as unknown as YearRow;
const ctxOf = (role: AppRole, now = NOW, audiences: Audience[] = [role]): PortalContext => ({
  kind: 'soumu',
  year: yearRow,
  role,
  groups: [],
  audiences,
  now,
});

const mineSlot = (starts: string, ends: string, duty: string): PortalMyAssignment => ({
  slot_id: uuid(Math.floor(Math.random() * 1e6) + 100),
  duty_id: uuid(5),
  shift_needs: { shift_slots: { starts_at: starts, ends_at: ends }, shift_duties: { name: duty } },
});

const raw = (over: Partial<ShiftsPortalRaw> = {}): ShiftsPortalRaw => ({
  tier: 'staff',
  userId: ME,
  mine: { assignments: [], tasks: [] },
  slots: null,
  tasks: null,
  ...over,
});

/** 今日（10/15）の3枠：09:00〜10:00（終わった）・10:00〜11:00（今）・13:00〜14:00（次）と、明日（10/16）の1枠 */
const todaySlots = () => [
  mineSlot('2027-10-15T00:00:00Z', '2027-10-15T01:00:00Z', '受付'),
  mineSlot('2027-10-15T01:00:00Z', '2027-10-15T02:00:00Z', '運搬'),
  mineSlot('2027-10-15T04:00:00Z', '2027-10-15T05:00:00Z', '見回り'),
  mineSlot('2027-10-16T00:00:00Z', '2027-10-16T01:00:00Z', '受付'),
];

describe('T20 shiftsPortal：総務の全員（自分のシフトと自分の作業）', () => {
  it('カード：今日の自分の枠があれば「今日のあなたのシフト N 枠（今 HH:MM〜 持ち場）」、今がなければ次、終わっていれば「今日の分は終わりました」', () => {
    const r = raw({ mine: { assignments: todaySlots(), tasks: [] } });
    expect(shiftsPortal(r, ctxOf('staff')).card!.lines[0]).toBe('今日のあなたのシフト 3 枠（今 10:00〜 運搬）');
    expect(shiftsPortal(r, ctxOf('staff', Date.parse('2027-10-15T02:30:00Z'))).card!.lines[0]).toBe('今日のあなたのシフト 3 枠（次 13:00〜 見回り）');
    expect(shiftsPortal(r, ctxOf('staff', Date.parse('2027-10-15T05:00:00Z'))).card!.lines[0]).toBe('今日のあなたのシフト 3 枠（今日の分は終わりました）');
  });

  it('カード：今日の枠がなければ次のシフト（曜日つき）、過去だけなら「これからの…ありません」、1つもなければ「まだありません」', () => {
    const r = raw({ mine: { assignments: todaySlots(), tasks: [] } });
    expect(shiftsPortal(r, ctxOf('staff', Date.parse('2027-10-14T03:00:00Z'))).card!.lines[0]).toBe('次のシフト 10/15（金）09:00〜 受付');
    expect(shiftsPortal(r, ctxOf('staff', Date.parse('2027-10-20T03:00:00Z'))).card!.lines[0]).toBe('あなたのこれからのシフトはありません');
    expect(shiftsPortal(raw(), ctxOf('staff')).card!.lines[0]).toBe('あなたのシフトはまだありません');
  });

  it('カード（部門員）：自分の作業の件数（作業中・未着手）とリンク「自分のシフトへ」', () => {
    const tasks = [
      { id: uuid(31), title: '名札を作る', status: 'doing' as const, due_at: null },
      { id: uuid(32), title: '備品の確認', status: 'todo' as const, due_at: null },
      { id: uuid(33), title: '机の数', status: 'todo' as const, due_at: null },
    ];
    const card = shiftsPortal(raw({ mine: { assignments: [], tasks } }), ctxOf('staff')).card!;
    expect(card.lines).toEqual(['あなたのシフトはまだありません', '自分の作業 3 件（作業中 1・未着手 2）']);
    expect([card.title, card.href, card.linkLabel]).toEqual(['シフト・作業', '/shift', '自分のシフトへ']);
    expect(shiftsPortal(raw(), ctxOf('staff')).card!.lines[1]).toBe('自分の作業はありません');
  });

  it('要対応：今日のシフト（今の枠か今日の次の枠と、今日あと N 枠）。ふつう・期日なし・/shift。今日の枠が全部終わったら出さない', () => {
    const r = raw({ mine: { assignments: todaySlots(), tasks: [] } });
    expect(shiftsPortal(r, ctxOf('staff')).todos).toEqual([
      { id: 'shifts:today', moduleId: 'shifts', title: '今日のシフト：今 10:00〜11:00 運搬（今日あと 1 枠）', severity: 'normal', href: '/shift' },
    ]);
    expect(shiftsPortal(r, ctxOf('staff', Date.parse('2027-10-15T02:30:00Z'))).todos[0]!.title).toBe('今日のシフト：次 13:00〜14:00 見回り');
    expect(shiftsPortal(r, ctxOf('staff', Date.parse('2027-10-15T05:00:00Z'))).todos).toEqual([]);
  });

  it('要対応：自分が担当の完了でない作業を1件ずつ（締切の度合い。締切ちょうどは過ぎた側で急ぎ）。締切と予定に作業の締切', () => {
    const tasks = [
      { id: uuid(31), title: '名札を作る', status: 'todo' as const, due_at: at(NOW) },
      { id: uuid(32), title: '備品の確認', status: 'doing' as const, due_at: at(NOW + 48 * H) },
      { id: uuid(33), title: '机の数', status: 'todo' as const, due_at: null },
    ];
    const s = shiftsPortal(raw({ mine: { assignments: [], tasks } }), ctxOf('staff'));
    expect(s.todos.map((t) => [t.id, t.title, t.severity, t.due ?? null, t.href])).toEqual([
      [`shifts:task:${uuid(31)}`, '作業「名札を作る」（未着手）', 'urgent', at(NOW), `/tasks?task=${uuid(31)}`],
      [`shifts:task:${uuid(32)}`, '作業「備品の確認」（作業中）', 'normal', at(NOW + 48 * H), `/tasks?task=${uuid(32)}`],
      [`shifts:task:${uuid(33)}`, '作業「机の数」（未着手）', 'info', null, `/tasks?task=${uuid(33)}`],
    ]);
    expect(s.dated.filter((d) => d.kind === 'deadline')).toEqual([
      { id: `shifts:task-due:${uuid(31)}`, moduleId: 'shifts', title: '作業の締切：名札を作る', at: at(NOW), kind: 'deadline', href: `/tasks?task=${uuid(31)}` },
      { id: `shifts:task-due:${uuid(32)}`, moduleId: 'shifts', title: '作業の締切：備品の確認', at: at(NOW + 48 * H), kind: 'deadline', href: `/tasks?task=${uuid(32)}` },
    ]);
  });

  it('締切と予定：自分の枠のある日ごと（日付だけ・予定・/shift?day=）。1 枠なら「ほか」を付けない', () => {
    const s = shiftsPortal(raw({ mine: { assignments: todaySlots(), tasks: [] } }), ctxOf('staff'));
    expect(s.dated).toEqual([
      { id: 'shifts:day:2027-10-15', moduleId: 'shifts', title: '自分のシフト（3 枠。09:00〜 受付 ほか）', at: '2027-10-15', kind: 'event', href: '/shift?day=2027-10-15' },
      { id: 'shifts:day:2027-10-16', moduleId: 'shifts', title: '自分のシフト（1 枠。09:00〜 受付）', at: '2027-10-16', kind: 'event', href: '/shift?day=2027-10-16' },
    ]);
  });

  it('Asia/Tokyo の日付の境目（UTC 15:00）で今日が変わる', () => {
    const late = [mineSlot('2027-10-15T14:30:00Z', '2027-10-15T15:30:00Z', '夜警')];
    const r = raw({ mine: { assignments: late, tasks: [] } });
    // 10/15 23:59 は今日（10/15）に 23:30 の枠
    expect(shiftsPortal(r, ctxOf('staff', Date.parse('2027-10-15T14:59:00Z'))).card!.lines[0]).toBe('今日のあなたのシフト 1 枠（今 23:30〜 夜警）');
    // 10/16 00:00 は今日（10/16）の枠はない（0 時をまたぐ枠の日は開始の日）
    expect(shiftsPortal(r, ctxOf('staff', Date.parse('2027-10-15T15:00:00Z'))).card!.lines[0]).toBe('あなたのこれからのシフトはありません');
  });

  it('開けない立場（総務でない audiences）では要対応・締切と予定のリンク・カードのリンクを作らない', () => {
    const tasks = [{ id: uuid(31), title: '名札', status: 'todo' as const, due_at: at(NOW + H) }];
    const s = shiftsPortal(raw({ mine: { assignments: todaySlots(), tasks } }), ctxOf('staff', NOW, ['viewer']));
    expect(s.todos).toEqual([]);
    expect(s.card!.href).toBeNull();
    expect(s.dated.every((d) => d.href === undefined)).toBe(true);
  });
});

describe('T20 shiftsPortal：部門長以上（足りない枠と作業の全部）', () => {
  const slots = (): PortalSlot[] => [
    // 終わった枠（足りなくても数えない）
    { id: uuid(41), starts_at: '2027-10-15T00:00:00Z', ends_at: '2027-10-15T01:00:00Z', shift_needs: [{ duty_id: uuid(5), required_count: 2, shift_assignments: [] }] },
    // 今の枠：2 人要るのに総務 1 人（閲覧のみに変わった人は数えない）→ 足りない（今の枠は 24 時間以内なので急ぎ）
    {
      id: uuid(42),
      starts_at: '2027-10-15T01:00:00Z',
      ends_at: '2027-10-15T02:00:00Z',
      shift_needs: [
        { duty_id: uuid(5), required_count: 2, shift_assignments: [{ user_id: ME, year_roles: { role: 'staff' } }, { user_id: VIEWER, year_roles: { role: 'viewer' } }] },
        { duty_id: uuid(6), required_count: 0, shift_assignments: [] },
      ],
    },
    // 明後日：足りない・そろっている
    {
      id: uuid(43),
      starts_at: '2027-10-17T00:00:00Z',
      ends_at: '2027-10-17T01:00:00Z',
      shift_needs: [
        { duty_id: uuid(5), required_count: 1, shift_assignments: [] },
        { duty_id: uuid(6), required_count: 1, shift_assignments: [{ user_id: OTHER, year_roles: { role: 'head' } }] },
      ],
    },
  ];
  const tasks = (): PortalTask[] => [
    { id: uuid(51), title: 'a', status: 'done', due_at: at(NOW - H), assignee_id: ME, year_roles: { role: 'staff' } },
    { id: uuid(52), title: 'b', status: 'todo', due_at: at(NOW - H), assignee_id: null, year_roles: null },
    { id: uuid(53), title: 'c', status: 'doing', due_at: at(NOW + 30 * H), assignee_id: OTHER, year_roles: { role: 'head' } },
    { id: uuid(54), title: 'd', status: 'todo', due_at: at(NOW + 10 * H), assignee_id: VIEWER, year_roles: { role: 'viewer' } },
  ];
  const leadRaw = (over: Partial<ShiftsPortalRaw> = {}) => raw({ tier: 'lead', slots: slots(), tasks: tasks(), ...over });

  it('カード：自分のシフト・人数が足りない枠（これからの枠）・作業の完了数と締切を過ぎた件数。リンクは「シフト表へ」', () => {
    const card = shiftsPortal(leadRaw(), ctxOf('head')).card!;
    expect(card.lines).toEqual(['あなたのシフトはまだありません', '人数が足りない枠 2（これからの枠）', '作業 1／4 件が完了（締切を過ぎた 1 件）']);
    expect([card.href, card.linkLabel]).toEqual(['/shifts', 'シフト表へ']);
  });

  it('カードの足りない枠の場合分け：そろっている・これからの時間枠がない・時間枠がない。作業がない・全部完了', () => {
    const full: PortalSlot[] = [
      { id: uuid(43), starts_at: '2027-10-17T00:00:00Z', ends_at: '2027-10-17T01:00:00Z', shift_needs: [{ duty_id: uuid(5), required_count: 1, shift_assignments: [{ user_id: ME, year_roles: { role: 'staff' } }] }] },
    ];
    expect(shiftsPortal(leadRaw({ slots: full }), ctxOf('admin')).card!.lines[1]).toBe('これからの枠はすべてそろっています');
    expect(shiftsPortal(leadRaw({ slots: full }), ctxOf('admin', Date.parse('2027-10-18T00:00:00Z'))).card!.lines[1]).toBe('これからの時間枠はありません');
    expect(shiftsPortal(leadRaw({ slots: [], tasks: [] }), ctxOf('admin')).card!.lines.slice(1)).toEqual(['シフトの時間枠はまだありません', '作業はまだありません']);
    const allDone = tasks().map((t) => ({ ...t, status: 'done' as const }));
    expect(shiftsPortal(leadRaw({ tasks: allDone }), ctxOf('admin')).card!.lines[2]).toBe('作業 4／4 件が完了');
  });

  it('要対応：人数が足りない枠（日ごとの数。24 時間以内の枠があれば急ぎ）・締切を過ぎた作業・締切が近い作業（期日はいちばん早い締切）・担当者のいない作業', () => {
    const todos = shiftsPortal(leadRaw(), ctxOf('deputy_head')).todos;
    expect(todos.map((t) => [t.id, t.title, t.severity, t.due ?? null, t.href])).toEqual([
      ['shifts:short', '人数が足りない枠 2（10/15 1・10/17 1）', 'urgent', null, '/shifts?day=2027-10-15&filter=short'],
      ['shifts:overdue', '締切を過ぎた作業 1 件', 'urgent', null, '/tasks?filter=overdue'],
      ['shifts:due-soon', '締切が近い作業 2 件（3日以内）', 'normal', at(NOW + 10 * H), '/tasks?filter=due-soon'],
      ['shifts:unassigned', '担当者のいない作業 1 件', 'normal', null, '/tasks?filter=unassigned'],
    ]);
    // 足りない枠が 24 時間より先だけならふつう
    const later = slots().slice(2);
    expect(shiftsPortal(leadRaw({ slots: later }), ctxOf('admin')).todos.find((t) => t.id === 'shifts:short')!.severity).toBe('normal');
  });

  it('部門長以上にも、作業全体の締切は締切と予定に出さない（自分が担当の作業と自分の枠のある日だけ）', () => {
    const s = shiftsPortal(leadRaw(), ctxOf('admin'));
    expect(s.dated).toEqual([]);
  });

  it('id は立場によらずそろう（同じ自分の作業・同じ日）', () => {
    const mine = { assignments: todaySlots(), tasks: [{ id: uuid(31), title: 'x', status: 'todo' as const, due_at: at(NOW + H) }] };
    const staff = shiftsPortal(raw({ mine }), ctxOf('staff'));
    const lead = shiftsPortal(leadRaw({ mine }), ctxOf('head'));
    expect(lead.dated.map((d) => d.id)).toEqual(staff.dated.map((d) => d.id));
    expect(lead.todos.filter((t) => !['shifts:short', 'shifts:overdue', 'shifts:due-soon', 'shifts:unassigned'].includes(t.id)).map((t) => t.id)).toEqual(
      staff.todos.map((t) => t.id),
    );
  });
});

describe('T20 shiftsPortalProvider と読み取り', () => {
  it('総務だけ（kinds は soumu）。読み取りの結果を使う欄は要対応・締切と予定・カード（お知らせの欄に並べない）。fromYear はない', () => {
    expect(shiftsPortalProvider.moduleId).toBe('shifts');
    expect(shiftsPortalProvider.kinds).toEqual(['soumu']);
    expect(shiftsPortalProvider.query!.widgets).toEqual(['todos', 'dated', 'cards']);
    expect(shiftsPortalProvider.fromYear).toBeUndefined();
    for (const w of ['soumuNotices', 'notices'] as const) expect(portalWidgetQuery(shiftsPortalProvider, ctxOf('staff'), w)).toBeNull();
  });

  it('キー：部門長以上は lead、総務部門員は staff（portalQueryKey(年度, shifts, soumu, 段)）。総務でないロールでは読まない', () => {
    expect(shiftsPortalProvider.query!.options(ctxOf('head'))!.queryKey).toEqual(portalQueryKey(Y, 'shifts', 'soumu', 'lead'));
    expect(shiftsPortalProvider.query!.options(ctxOf('staff'))!.queryKey).toEqual(portalQueryKey(Y, 'shifts', 'soumu', 'staff'));
    expect(shiftsPortalOptions(Y, 'staff').queryKey).toEqual(['year', Y, 'portal', 'shifts', 'soumu', 'staff']);
    expect(shiftsPortalProvider.query!.options({ ...ctxOf('staff'), role: 'viewer' })).toBeNull();
  });

  it('loadShiftsPortal（部門員）：year_roles の自分の行に割り当てと完了でない作業を埋め込んで1本', async () => {
    const { client, issued } = createFakeSupabase((call) =>
      call.table === 'year_roles' ? { data: { user_id: ME, shift_assignments: todaySlots(), tasks: [{ id: uuid(31), title: 'x', status: 'todo', due_at: null }] } } : { data: [] },
    );
    const r = await loadShiftsPortal(Y, 'staff', client, ME);
    expect(issued).toHaveLength(1);
    expect(issued[0]!.table).toBe('year_roles');
    expect(opArgs(issued[0]!, 'select')[0]![0]).toBe(SHIFTS_PORTAL_MINE_SELECT);
    expect(opArgs(issued[0]!, 'eq')).toEqual([
      ['year_id', Y],
      ['user_id', ME],
    ]);
    expect(opArgs(issued[0]!, 'neq')).toEqual([['tasks.status', 'done']]);
    expect([r.tier, r.userId, r.mine.assignments.length, r.mine.tasks.length, r.slots, r.tasks]).toEqual(['staff', ME, 4, 1, null, null]);
  });

  it('loadShiftsPortal（部門長以上）：3本を並行（時間枠のます・作業の全部はロールを埋め込む）。自分の行がなければ空', async () => {
    const { client, issued } = createFakeSupabase((call) => (call.table === 'year_roles' ? { data: null } : { data: [] }));
    const r = await loadShiftsPortal(Y, 'lead', client, ME);
    expect(issued.map((c) => c.table).sort()).toEqual(['shift_slots', 'tasks', 'year_roles']);
    const slots = issued.find((c) => c.table === 'shift_slots')!;
    expect(opArgs(slots, 'select')[0]![0]).toBe(SHIFTS_PORTAL_SLOTS_SELECT);
    expect(opArgs(slots, 'order').map((a) => a[0])).toEqual(['starts_at', 'id']);
    expect(opArgs(issued.find((c) => c.table === 'tasks')!, 'select')[0]![0]).toBe(SHIFTS_PORTAL_TASKS_SELECT);
    expect([r.mine, r.slots, r.tasks]).toEqual([{ assignments: [], tasks: [] }, [], []]);
  });

  it('読めなければ AppError を投げる', async () => {
    const { client } = createFakeSupabase(() => ({ error: { code: '42501', message: 'x' }, status: 403 }));
    await expect(loadShiftsPortal(Y, 'staff', client, ME)).rejects.toMatchObject({ info: { kind: 'forbidden' } });
  });

  it('portal-read.ts は軽い（/ の先読みから読む）：ダッシュボードの型と関数・組み立て・シフト表・lib/data・画面の部品・zod を実行時に読まない', () => {
    const g = staticImportGraph('lib/modules/shifts/portal-read.ts');
    for (const f of ['lib/modules/portal.ts', 'lib/modules/shifts/portal.ts', 'lib/modules/shifts/board.ts', 'lib/navigation.ts', 'lib/datetime.ts']) {
      expect(g.files).not.toContain(f);
    }
    expect(g.files.filter((f) => f.startsWith('lib/data/') || f.startsWith('components/') || f.startsWith('app/'))).toEqual([]);
    expect(g.files).toContain('lib/modules/query-key.ts');
    expect(g.packages.filter((p) => p.startsWith('@gaapp/') || p === 'zod')).toEqual([]);
  });

  it('reads.ts（/shift・/tasks の先読み）も軽い：書き込み・組み立て・zod・画面の部品を読まない', () => {
    const g = staticImportGraph('lib/modules/shifts/reads.ts');
    for (const f of ['lib/modules/shifts/board.ts', 'lib/modules/shifts/my-shift.ts', 'lib/db/update-with-lock.ts', 'lib/rpc/index.ts', 'lib/modules/portal.ts']) {
      expect(g.files).not.toContain(f);
    }
    expect(g.files.filter((f) => f.startsWith('lib/data/') || f.startsWith('components/') || f.startsWith('app/') || f.startsWith('lib/schemas/'))).toEqual([]);
    expect(g.packages.filter((p) => p.startsWith('@gaapp/') || p === 'zod')).toEqual([]);
  });

  it('プロバイダ（/ が読む）はシフト表の組み立て・書き込み・画面の部品を読まない', () => {
    const g = staticImportGraph('lib/modules/shifts/portal.ts');
    for (const f of ['lib/modules/shifts/board.ts', 'lib/modules/shifts/my-shift.ts', 'lib/data/shifts.ts', 'lib/data/tasks.ts', 'lib/schemas/shifts.ts', 'lib/schemas/tasks.ts']) {
      expect(g.files).not.toContain(f);
    }
    expect(g.files.filter((f) => f.startsWith('components/'))).toEqual([]);
  });
});
