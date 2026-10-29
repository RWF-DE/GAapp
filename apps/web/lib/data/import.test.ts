import { readFileSync } from 'node:fs';
import path from 'node:path';
import { INITIAL_ITEMS } from '@gaapp/shared';
import { repoRoot } from '@gaapp/shared/testing';
import { describe, expect, it, vi } from 'vitest';
import type { GroupRow, ItemRow, RequestDbRow, SubmissionRow } from '@/lib/db/types';
import { appError } from '@/lib/errors';
import {
  buildImportPreview,
  countsSummary,
  defaultImportReason,
  defaultOverwriteOf,
  groupsForKind,
  readForm,
  rowsByGroup,
  saveImport,
  toImportArgs,
  toImportRows,
} from './import';
import type { RequestsTables } from './requests';

vi.mock('@/lib/rpc', () => ({ callRpc: vi.fn() }));
const { callRpc } = await import('@/lib/rpc');

const T0 = '2026-10-29T01:02:03.123456+00:00';
const uuid = (n: number) => `00000000-0000-4000-8000-${String(n).padStart(12, '0')}`;
const ITEMS: ItemRow[] = INITIAL_ITEMS.map((i, n) => ({
  id: uuid(100 + n),
  code: i.code,
  name: i.name,
  aliases: [...i.aliases],
  requestable_categories: [...i.requestableCategories],
  sort_order: i.sortOrder,
  updated_at: T0,
}));
const itemId = (code: string) => ITEMS.find((i) => i.code === code)!.id;
const group = (n: number, name: string, category: GroupRow['category'], aliases: string[] = []): GroupRow => ({
  id: uuid(n),
  year_id: uuid(1),
  name,
  display_name: null,
  aliases,
  category,
  is_food: false,
  location_room_id: null,
  sort_order: n,
  updated_at: T0,
});
const KOU = group(11, '模擬店甲', 'stall');
const OTSU = group(12, '模擬店乙', 'stall');
const HEI = group(13, '模擬店丙', 'stall');
const DEPT = group(21, '部門甲', 'department');
const COMPANY_A = group(31, '企業A', 'company');
const COMPANY_B = group(32, '企業B', 'company');

const SAMPLES = path.join(repoRoot(), 'fixtures', 'importer-samples');
const sample = (name: string) => readFileSync(path.join(SAMPLES, `${name}.csv`), 'utf8');

const tables = (over: Partial<RequestsTables> = {}): RequestsTables => ({
  groups: [KOU, OTSU, HEI, DEPT, COMPANY_A, COMPANY_B],
  items: ITEMS,
  requests: [],
  submissions: [],
  ...over,
});

const parsedStall = () => {
  const r = readForm('stall', sample('stall'), ITEMS);
  if (!r.ok) throw new Error(r.message);
  return r.parsed;
};

describe('readForm', () => {
  it('見出しが合わない CSV は ImportFormatError の文言を返す（元の値を含まない）', () => {
    const r = readForm('stall', 'a,b\n1,2\n', ITEMS);
    expect(r).toEqual({ ok: false, message: expect.stringContaining('タイムスタンプ') });
  });
  it('fixtures の stall.csv を読む', () => {
    const p = parsedStall();
    expect(p.responses.map((r) => r.rowNumber)).toEqual([2, 3, 4, 8, 9]);
    expect(p.rejected).toEqual([
      { rowNumber: 5, reason: 'misaligned' },
      { rowNumber: 6, reason: 'invalid_number' },
      { rowNumber: 7, reason: 'misaligned' },
      { rowNumber: 10, reason: 'empty' },
    ]);
  });
});

describe('buildImportPreview（stall.csv）', () => {
  it('件数・対応しない行・古い回答・取り込まない行・団体ごとの結果を作る', () => {
    const p = buildImportPreview(parsedStall(), 'stall', tables());
    expect(p.responseCount).toBe(5);
    expect(p.matchedCount).toBe(3);
    expect(p.unmatched.map((u) => [u.rowNumber, u.groupName])).toEqual([
      [8, '存在しない団体'],
      [9, null],
    ]);
    expect(p.unmatched[0]!.summary).toBe('机(木)1・椅子(木)1');
    expect(p.rejectedByReason).toEqual({ misaligned: 2, invalid_number: 1, empty: 1 });
    expect(p.superseded).toEqual([
      {
        group: KOU,
        kept: { rowNumber: 4, submittedAt: '2026-10-06T09:00:00+09:00' },
        dropped: [{ rowNumber: 2, submittedAt: '2026-10-05T18:01:02+09:00' }],
      },
    ]);
    expect(p.supersededCount).toBe(1);
    expect(p.plans.map((x) => [x.group.name, x.rowNumber, x.submittedAt])).toEqual([
      ['模擬店甲', 4, '2026-10-06T09:00:00+09:00'],
      ['模擬店乙', 3, '2026-10-05T19:30:00+09:00'],
    ]);
    const kou = p.plans[0]!;
    const csv = Object.fromEntries(kou.cells.filter((c) => c.csv > 0).map((c) => [c.item.code, c.csv]));
    expect(csv).toEqual({ desk: 6, chair: 10, blue_chair: 2, long_desk_2: 1 });
    expect(kou.defaultOverwrite).toBe(true);
    expect(kou.changed).toBe(true);
    // 備考のメールは importer が除く
    expect(kou.note).not.toMatch(/@/);
  });

  it('手で選んだ行はその団体に入り、対応しない行の一覧には残る（選び直せる）', () => {
    const p = buildImportPreview(parsedStall(), 'stall', tables(), { 8: HEI.id });
    expect(p.matchedCount).toBe(4);
    expect(p.unmatched.map((u) => u.rowNumber)).toEqual([8, 9]);
    const hei = p.plans.find((x) => x.group.id === HEI.id)!;
    expect(hei.rowNumber).toBe(8);
    expect(hei.submittedAt).toBe('2026-10-06T11:00:00+09:00');
  });

  it('ほかの区分の団体には対応させない（模擬店のフォームは stall だけ）', () => {
    expect(groupsForKind(tables().groups, 'stall').map((g) => g.name)).toEqual(['模擬店甲', '模擬店乙', '模擬店丙']);
    const p = buildImportPreview(parsedStall(), 'stall', tables(), { 8: DEPT.id });
    expect(p.plans.some((x) => x.group.id === DEPT.id)).toBe(false);
  });

  it('Q2：DB の提出日時より新しい回答だけを既定で上書きする', () => {
    const subs: SubmissionRow[] = [
      { group_id: KOU.id, submitted_at: '2026-10-07T00:00:00+09:00', note: 'あり', updated_at: T0 },
      { group_id: OTSU.id, submitted_at: '2026-10-05T10:00:00+09:00', note: null, updated_at: T0 },
    ];
    const p = buildImportPreview(parsedStall(), 'stall', tables({ submissions: subs }));
    const by = Object.fromEntries(p.plans.map((x) => [x.group.name, x]));
    expect(by['模擬店甲']!.defaultOverwrite).toBe(false);
    expect(by['模擬店甲']!.dbHasNote).toBe(true);
    expect(by['模擬店乙']!.defaultOverwrite).toBe(true);
    expect(defaultOverwriteOf('2026-10-06T09:00:00+09:00', null)).toBe(true);
    expect(defaultOverwriteOf('2026-10-06T09:00:00+09:00', '2026-10-06T00:00:00Z')).toBe(false);
  });

  it('rowsByGroup は importer と同じ対応で行番号を返す', () => {
    const m = rowsByGroup(parsedStall(), 'stall', tables(), { 9: OTSU.id });
    expect(m.get(KOU.id)).toEqual([2, 4]);
    expect(m.get(OTSU.id)).toEqual([3, 9]);
  });
});

describe('toImportRows（送る p_rows）', () => {
  it('申請できる品目すべてと DB に行がある品目を送り、CSV にない品目は 0、行があれば updatedAt を付ける', () => {
    const requests: RequestDbRow[] = [
      { group_id: OTSU.id, item_id: itemId('lectern'), count: 5, updated_at: T0 },
      // 企業以外の長机(3人掛)が DB に残っている（読み替えた後なので 0 にする）
      { group_id: OTSU.id, item_id: itemId('long_desk_3'), count: 2, updated_at: T0 },
    ];
    const p = buildImportPreview(parsedStall(), 'stall', tables({ requests }));
    const otsu = p.plans.find((x) => x.group.id === OTSU.id)!;
    const rows = toImportRows(otsu);
    const byCode = Object.fromEntries(rows.map((r) => [ITEMS.find((i) => i.id === r.itemId)!.code, r]));
    expect(Object.keys(byCode).sort()).toEqual(['blue_chair', 'caster_desk', 'chair', 'desk', 'lectern', 'long_desk_2', 'long_desk_3'].sort());
    expect(byCode.desk).toEqual({ itemId: itemId('desk'), count: 2 });
    expect(byCode.chair!.count).toBe(4);
    expect(byCode.caster_desk!.count).toBe(1);
    expect(byCode.lectern).toEqual({ itemId: itemId('lectern'), count: 0, updatedAt: T0 });
    expect(byCode.long_desk_3).toEqual({ itemId: itemId('long_desk_3'), count: 0, updatedAt: T0 });
    // 申請できない品目（不可机・不可椅子）は送らない
    expect(byCode.desk_ng).toBeUndefined();
    expect(byCode.chair_ng).toBeUndefined();
    expect(otsu.changed).toBe(true);
  });

  it('企業以外の長机(3人掛)は長机(2人掛)に読み替え、印をつける', () => {
    const csv = 'タイムスタンプ,団体名,長机(二席用),長机(三席用)\n2026/10/05 10:00:00,部門甲,1,2\n';
    const r = readForm('department', csv, ITEMS);
    if (!r.ok) throw new Error(r.message);
    const p = buildImportPreview(r.parsed, 'department', tables());
    const plan = p.plans[0]!;
    expect(plan.rewritten).toBe(true);
    expect(plan.blocked).toEqual([]);
    const rows = toImportRows(plan);
    expect(rows.find((x) => x.itemId === itemId('long_desk_2'))!.count).toBe(3);
    expect(rows.find((x) => x.itemId === itemId('long_desk_3'))).toBeUndefined();
  });

  it('申請できない品目（読み替え先なし）は送らず、blocked に出す', () => {
    const noDeskItems = ITEMS.map((i) => (i.code === 'desk_ng' ? { ...i, aliases: ['不可机'] } : i));
    const csv = 'タイムスタンプ,団体名,机(木),不可机\n2026/10/05 10:00:00,部門甲,1,4\n';
    const r = readForm('department', csv, noDeskItems);
    if (!r.ok) throw new Error(r.message);
    const p = buildImportPreview(r.parsed, 'department', tables({ items: noDeskItems }));
    const plan = p.plans[0]!;
    expect(plan.blocked.map((b) => [b.item.code, b.count])).toEqual([['desk_ng', 4]]);
    expect(toImportRows(plan).some((x) => x.itemId === itemId('desk_ng'))).toBe(false);
  });

  it('p_submission にフォームのタイムスタンプと備考を付ける', () => {
    const p = buildImportPreview(parsedStall(), 'stall', tables());
    const args = toImportArgs(p.plans[1]!, '理由');
    expect(args).toMatchObject({
      p_group_id: OTSU.id,
      p_reason: '理由',
      p_submission: { submittedAt: '2026-10-05T19:30:00+09:00', note: null },
    });
  });
});

describe('レビューの指摘（プレビューを保存後の数に合わせる）', () => {
  const noDeskItems = ITEMS.map((i) => (i.code === 'desk_ng' ? { ...i, aliases: ['不可机'] } : i));
  const deptPlan = (csv: string, over: Partial<RequestsTables> = {}) => {
    const r = readForm('department', csv, noDeskItems);
    if (!r.ok) throw new Error(r.message);
    return buildImportPreview(r.parsed, 'department', tables({ items: noDeskItems, ...over })).plans[0]!;
  };

  it('申請できない品目（blocked）に DB の 0 でない行があれば、保存後の数（今の DB の数のまま）を出し、変えたことにしない', () => {
    const requests: RequestDbRow[] = [
      { group_id: DEPT.id, item_id: itemId('desk'), count: 1, updated_at: T0 },
      { group_id: DEPT.id, item_id: itemId('desk_ng'), count: 3, updated_at: T0 },
    ];
    const plan = deptPlan('タイムスタンプ,団体名,机(木),不可机\n2026/10/05 10:00:00,部門甲,1,4\n', { requests });
    const ng = plan.cells.find((c) => c.item.code === 'desk_ng')!;
    expect(ng.blocked).toBe(true);
    expect(ng.after).toBe(3);
    expect(toImportRows(plan).some((x) => x.itemId === itemId('desk_ng'))).toBe(false);
    // 机(木) も今と同じなので「数は今と同じ」
    expect(plan.changed).toBe(false);
  });

  it('申請できない品目で CSV にない（0 の）品目に DB の行があれば、保存後は 0（送る）', () => {
    const requests: RequestDbRow[] = [{ group_id: DEPT.id, item_id: itemId('desk_ng'), count: 3, updated_at: T0 }];
    const plan = deptPlan('タイムスタンプ,団体名,机(木)\n2026/10/05 10:00:00,部門甲,1\n', { requests });
    const ng = plan.cells.find((c) => c.item.code === 'desk_ng')!;
    expect(ng.blocked).toBe(false);
    expect(ng.after).toBe(0);
    expect(toImportRows(plan).find((x) => x.itemId === itemId('desk_ng'))).toEqual({ itemId: itemId('desk_ng'), count: 0, updatedAt: T0 });
    expect(plan.changed).toBe(true);
  });

  it('Q2：CSV のタイムスタンプと DB の提出日時が同じ（取り込み済み）なら sameTimestamp。上書きしないのは同じ', () => {
    const subs: SubmissionRow[] = [{ group_id: KOU.id, submitted_at: '2026-10-06T00:00:00+00:00', note: null, updated_at: T0 }];
    const p = buildImportPreview(parsedStall(), 'stall', tables({ submissions: subs }));
    const kou = p.plans.find((x) => x.group.id === KOU.id)!;
    expect(kou.defaultOverwrite).toBe(false);
    expect(kou.sameTimestamp).toBe(true);
    const otsu = p.plans.find((x) => x.group.id === OTSU.id)!;
    expect(otsu.sameTimestamp).toBe(false);
  });

  it('備考が 2000 字を超えたら印をつけ、送るときは 2000 字（文字の数）に切る', () => {
    const long = '備'.repeat(1990) + '😀'.repeat(20);
    const plan = deptPlan(`タイムスタンプ,団体名,机(木),備考\n2026/10/05 10:00:00,部門甲,1,${long}\n`);
    expect(plan.noteLength).toBe(2010);
    expect(plan.noteTruncated).toBe(true);
    const sent = toImportArgs(plan, '理由').p_submission.note!;
    expect(Array.from(sent)).toHaveLength(2000);
    expect(sent.endsWith('😀')).toBe(true);
    const short = deptPlan('タイムスタンプ,団体名,机(木),備考\n2026/10/05 10:00:00,部門甲,1,短い\n');
    expect(short.noteTruncated).toBe(false);
    expect(toImportArgs(short, '理由').p_submission.note).toBe('短い');
  });
});

describe('企業のフォーム', () => {
  it('全部の行が対応しない行になり、手で選ぶと長机(3人掛)はそのまま', () => {
    const r = readForm('company', sample('company'), ITEMS);
    if (!r.ok) throw new Error(r.message);
    const p0 = buildImportPreview(r.parsed, 'company', tables());
    expect(p0.unmatched.map((u) => u.rowNumber)).toEqual([2, 3, 4]);
    expect(p0.plans).toEqual([]);
    const p = buildImportPreview(r.parsed, 'company', tables(), { 2: COMPANY_A.id, 3: COMPANY_B.id });
    const a = p.plans.find((x) => x.group.id === COMPANY_A.id)!;
    expect(a.rewritten).toBe(false);
    expect(a.cells.find((c) => c.item.code === 'long_desk_3')!.csv).toBe(4);
    expect(p.plans.find((x) => x.group.id === COMPANY_B.id)!.note).not.toMatch(/@/);
  });
});

describe('そのほか', () => {
  it('countsSummary', () => {
    expect(countsSummary({ chair: 8, desk: 4 }, ITEMS)).toBe('机(木)4・椅子(木)8');
    expect(countsSummary({}, ITEMS)).toBe('すべて 0');
  });
  it('defaultImportReason はファイル名を入れない（理由は audit_logs に残り続け、ファイル名には人の名前が入りうる）', () => {
    expect(defaultImportReason('stall')).toBe('Googleフォームの回答の取り込み（模擬店）');
    expect(defaultImportReason('company')).toBe('Googleフォームの回答の取り込み（企業）');
  });
});

describe('saveImport', () => {
  it('団体ごとに update_requests_after_deadline を順に呼び、forbidden で止める', async () => {
    const mock = vi.mocked(callRpc);
    mock.mockReset();
    mock.mockResolvedValueOnce(undefined as never).mockRejectedValueOnce(appError('forbidden', '42501'));
    const p = buildImportPreview(parsedStall(), 'stall', tables(), { 8: HEI.id });
    const res = await saveImport(p.plans, '理由');
    expect(mock).toHaveBeenCalledTimes(2);
    expect(mock.mock.calls[0]![0]).toBe('update_requests_after_deadline');
    expect(res.map((r) => [r.groupId, r.ok])).toEqual([
      [KOU.id, true],
      [OTSU.id, false],
    ]);
  });
});
