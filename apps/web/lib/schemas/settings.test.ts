import { describe, expect, it } from 'vitest';
import { inviteKindsFor } from '@/lib/auth/roles';
import {
  distanceFormSchema,
  groupFormSchema,
  INVITE_KINDS,
  inviteFormSchema,
  itemFormSchema,
  joinAliases,
  parseGroupsCsv,
  roomFormSchema,
  splitAliases,
  yearCreateSchema,
  yearEditSchema,
} from './settings';

const R1 = '00000000-0000-4000-8000-0000000000a1';
const R2 = '00000000-0000-4000-8000-0000000000a2';
const rooms = [
  { id: R1, name: '1-1', aliases: ['一の一'] },
  { id: R2, name: '体育館', aliases: ['Gym'] },
];
const BOM = String.fromCharCode(0xfeff);
const HEADER = '団体名,表示名,区分,飲食,使用場所,別名,並び順';

describe('parseGroupsCsv（団体の CSV）', () => {
  it('見出しと行を読み、区分・飲食・使用場所（名前・別名）・別名・並び順を groups の列にする', () => {
    const csv = [
      HEADER,
      '模擬店A,たこ焼き屋,模擬店,はい,1-1,A|えー,5',
      '"部門B, 展示",,部門,いいえ,gym,,',
      '企業C,,企業,,,,',
      '',
    ].join('\r\n');
    const r = parseGroupsCsv(`${BOM}${csv}`, rooms);
    expect(r.errors).toEqual([]);
    expect(r.rows).toEqual([
      { line: 2, name: '模擬店A', display_name: 'たこ焼き屋', category: 'stall', is_food: true, location_room_id: R1, aliases: ['A', 'えー'], sort_order: 5 },
      { line: 3, name: '部門B, 展示', display_name: null, category: 'department', is_food: false, location_room_id: R2, aliases: [], sort_order: 20 },
      { line: 4, name: '企業C', display_name: null, category: 'company', is_food: false, location_room_id: null, aliases: [], sort_order: 30 },
    ]);
  });

  it('使えない団体名（SUMIF のワイルドカード・予約語）・知らない区分・場所・重複は、行番号と理由だけを返す', () => {
    const csv = [
      HEADER,
      '模擬*店,,模擬店,,,,',
      '余り,,模擬店,,,,',
      '模擬店D,,屋台,,,,',
      '模擬店E,,模擬店,たぶん,,,',
      '模擬店F,,模擬店,,2-9,,',
      '模擬店G,,模擬店,,,,abc',
      '模擬店H,,模擬店,,,,',
      '模擬店Ｈ,,模擬店,,,,',
      '模擬店I,,模擬店,,,,,余分',
      '模擬店J,,模擬店,,,,',
    ].join('\n');
    const r = parseGroupsCsv(csv, rooms);
    expect(r.rows.map((x) => x.name)).toEqual(['模擬店H', '模擬店J']);
    expect(r.errors).toEqual([
      { line: 2, message: '団体名に半角の * ? ~ は使えません' },
      { line: 3, message: '団体名に「(計)」「使用不可」「余り」「残す」は使えません' },
      { line: 4, message: '区分は「模擬店」「部門」「企業」「休憩所」のどれかにしてください' },
      { line: 5, message: '飲食は「はい」か「いいえ」にしてください' },
      { line: 6, message: '使用場所が場所の名前・別名にありません' },
      { line: 7, message: '並び順は整数で入れてください' },
      { line: 9, message: '団体名が 8 行目と同じです' },
      { line: 10, message: '見出しのない列に値があります' },
    ]);
    // 誤りの文に CSV の中身（団体名）を入れない
    expect(JSON.stringify(r.errors)).not.toContain('模擬店D');
  });

  it('見出しが違う・空・行がないときはファイルの誤り', () => {
    expect(parseGroupsCsv('団体名,区分\n模擬店A,模擬店', rooms)).toEqual({
      rows: [],
      errors: [{ line: 1, message: `見出しは「${HEADER}」にしてください` }],
    });
    expect(parseGroupsCsv('', rooms).errors).toEqual([{ line: 0, message: '空のファイルです' }]);
    expect(parseGroupsCsv(`${HEADER}\n\n`, rooms).errors).toEqual([{ line: 0, message: '団体の行がありません' }]);
    // 見出しの後ろの空の列は許す
    expect(parseGroupsCsv(`${HEADER},,\n模擬店A,,模擬店,,,,`, rooms).rows).toHaveLength(1);
  });

  it('2つの場所に同じ別名があれば、その別名では決めない', () => {
    const dup = [...rooms, { id: '00000000-0000-4000-8000-0000000000a3', name: '1-2', aliases: ['一の一'] }];
    const r = parseGroupsCsv(`${HEADER}\n模擬店A,,模擬店,,一の一,,`, dup);
    expect(r.errors).toEqual([{ line: 2, message: '使用場所が場所の名前・別名にありません' }]);
  });
});

describe('別名の入力欄', () => {
  it('| と全角の ｜ で分け、空を捨てる', () => {
    expect(splitAliases(' A |B｜ |C ')).toEqual(['A', 'B', 'C']);
    expect(splitAliases('')).toEqual([]);
    expect(joinAliases(['A', 'B'])).toBe('A|B');
  });
});

describe('年度', () => {
  it('変更：受付開始 < 締切、受付中は締切を空にできない、1日目の範囲', () => {
    const ok = yearEditSchema('preparing').safeParse({
      label: ' R9 ',
      festival_start: '2027-10-16',
      request_open_at: '2027-07-01T09:00',
      request_close_at: '2027-07-10T18:00',
    });
    expect(ok.success && ok.data).toEqual({
      label: 'R9',
      festival_start: '2027-10-16',
      request_open_at: '2027-07-01T09:00:00+09:00',
      request_close_at: '2027-07-10T18:00:00+09:00',
    });
    const reversed = yearEditSchema('preparing').safeParse({
      label: 'R9',
      festival_start: '2027-10-16',
      request_open_at: '2027-07-10T18:00',
      request_close_at: '2027-07-01T09:00',
    });
    expect(reversed.error?.issues.map((i) => [i.path.join('.'), i.message])).toEqual([['request_close_at', '締切は受付開始より後にしてください']]);
    const noClose = yearEditSchema('requesting').safeParse({ label: 'R9', festival_start: '2027-10-16', request_open_at: '', request_close_at: '' });
    expect(noClose.error?.issues[0]?.message).toBe('申請の受付中は締切を空にできません');
    expect(yearEditSchema('preparing').safeParse({ label: 'R9', festival_start: '2027-10-16', request_open_at: '', request_close_at: '' }).data).toMatchObject({
      request_open_at: null,
      request_close_at: null,
    });
    // 欄ごとの誤りはまとめて出す（1日目の誤りがあっても締切の誤りも出る）
    const both = yearEditSchema('preparing').safeParse({
      label: '',
      festival_start: '2201-01-01',
      request_open_at: '2027-07-10T18:00',
      request_close_at: '2027-07-01T09:00',
    });
    expect(both.error?.issues.map((i) => i.path.join('.'))).toEqual(['label', 'festival_start', 'request_close_at']);
    const range = yearEditSchema('preparing').safeParse({ label: 'R9', festival_start: '2201-01-01', request_open_at: '', request_close_at: '' });
    expect(range.error?.issues[0]).toMatchObject({ path: ['festival_start'], message: '2000年1月1日〜2200年12月31日の日付にしてください' });
  });

  it('作成：年度名が空、1日目が複製元と同じか前、範囲の外は欄のエラー', () => {
    const s = yearCreateSchema('2199-01-01');
    expect(s.safeParse({ label: 'R10', festival_start: '2200-01-01' }).success).toBe(true);
    expect(s.safeParse({ label: '  ', festival_start: '2200-01-01' }).error?.issues[0]).toMatchObject({ path: ['label'], message: '入力してください' });
    expect(s.safeParse({ label: 'R10', festival_start: '2199-01-01' }).error?.issues[0]).toMatchObject({
      path: ['festival_start'],
      message: '1日目は今の年度（2199-01-01）より後の日付にしてください',
    });
    expect(s.safeParse({ label: 'R10', festival_start: '2201-01-01' }).error?.issues[0]?.path).toEqual(['festival_start']);
  });
});

describe('場所・品目・団体・距離・招待の入力', () => {
  it('場所：建物の空欄は null、階の空欄は null、追加コストは 0〜20', () => {
    const base = { name: ' 1-1 ', aliases: '一の一|', kind: 'room', building: '  ', floor: '', is_storage: false, extra_cost: '3', sort_order: '10' } as const;
    expect(roomFormSchema.parse(base)).toEqual({
      name: '1-1',
      aliases: ['一の一'],
      kind: 'room',
      building: null,
      floor: null,
      is_storage: false,
      extra_cost: 3,
      sort_order: 10,
    });
    expect(roomFormSchema.safeParse({ ...base, extra_cost: '21' }).error?.issues[0]?.message).toBe('追加コストは 20 以下にしてください');
    expect(roomFormSchema.safeParse({ ...base, floor: '2.5' }).error?.issues[0]?.message).toBe('階は整数で入れてください');
  });

  it('品目：コードの形', () => {
    const base = { code: 'desk_2', name: '机', aliases: '', requestable_categories: ['stall'], sort_order: '1' } as const;
    expect(itemFormSchema.parse(base).code).toBe('desk_2');
    expect(itemFormSchema.safeParse({ ...base, code: 'Desk' }).success).toBe(false);
    expect(itemFormSchema.safeParse({ ...base, code: '2desk' }).success).toBe(false);
  });

  it('団体：表示名の空欄は null、使用場所の空は null、団体名は D-27', () => {
    const base = { name: '模擬店A', display_name: ' ', aliases: '', category: 'stall', is_food: true, location_room_id: '', sort_order: '0' } as const;
    expect(groupFormSchema.parse(base)).toMatchObject({ display_name: null, location_room_id: null, is_food: true });
    expect(groupFormSchema.parse({ ...base, location_room_id: R1 }).location_room_id).toBe(R1);
    expect(groupFormSchema.safeParse({ ...base, name: '=A' }).error?.issues[0]?.message).toBe('団体名の先頭に半角の = < > は使えません');
    expect(groupFormSchema.safeParse({ ...base, name: 'あ'.repeat(101) }).error?.issues[0]?.message).toBe('100 字までです');
  });

  it('距離：同じ建物どうしは入れられない、0〜20', () => {
    expect(distanceFormSchema.parse({ building_a: ' 教室棟A ', building_b: '体育館', cost: '3' })).toEqual({ building_a: '教室棟A', building_b: '体育館', cost: 3 });
    expect(distanceFormSchema.safeParse({ building_a: 'A', building_b: 'A', cost: '1' }).error?.issues[0]?.message).toBe('同じ建物どうしの距離は入れられません');
    expect(distanceFormSchema.safeParse({ building_a: 'A', building_b: 'B', cost: '-1' }).success).toBe(false);
  });

  it('招待：メールは小文字にし、ロールは団体なし、店長・副店長は団体が要る（ロールと団体を一度に送らない）', () => {
    const admin = inviteFormSchema(inviteKindsFor('admin'));
    expect(admin.parse({ email: ' Staff@Example.Test ', kind: 'staff', group_id: '' })).toEqual({
      email: 'staff@example.test',
      role: 'staff',
      group_id: null,
      group_role: null,
    });
    // ロールを選んだときは、前に選んだ団体が残っていても送らない
    expect(admin.parse({ email: 'head@example.test', kind: 'head', group_id: R1 })).toEqual({
      email: 'head@example.test',
      role: 'head',
      group_id: null,
      group_role: null,
    });
    expect(admin.parse({ email: 'rep@example.test', kind: 'manager', group_id: R1 })).toEqual({
      email: 'rep@example.test',
      role: null,
      group_id: R1,
      group_role: 'manager',
    });
    expect(admin.parse({ email: 'rep@example.test', kind: 'deputy_manager', group_id: R1 })).toEqual({
      email: 'rep@example.test',
      role: null,
      group_id: R1,
      group_role: 'deputy_manager',
    });
    expect(admin.safeParse({ email: 'rep@example.test', kind: 'deputy_manager', group_id: '' }).error?.issues[0]).toMatchObject({
      path: ['group_id'],
      message: '団体を選んでください',
    });
    expect(admin.safeParse({ email: 'not-mail', kind: 'staff', group_id: '' }).error?.issues[0]?.message).toBe('メールアドレスの形が違います');
  });

  it('招待：選べる立場（段。inviteKindsFor）の外は立場の欄の誤り。INVITE_KINDS はロールと店長・副店長の7つ', () => {
    expect(INVITE_KINDS).toEqual(['admin', 'head', 'deputy_head', 'staff', 'viewer', 'manager', 'deputy_manager']);
    const head = inviteFormSchema(inviteKindsFor('head'));
    expect(head.parse({ email: 'staff@example.test', kind: 'staff', group_id: '' })).toMatchObject({ role: 'staff', group_id: null });
    expect(head.parse({ email: 'rep@example.test', kind: 'deputy_manager', group_id: R1 })).toMatchObject({ role: null, group_role: 'deputy_manager' });
    for (const kind of ['admin', 'head', 'deputy_head', 'viewer', 'rep', '']) {
      expect(head.safeParse({ email: 'x@example.test', kind, group_id: R1 }).error?.issues).toEqual([
        expect.objectContaining({ path: ['kind'], message: '立場を選び直してください' }),
      ]);
    }
    // 管理者は7つすべてを選べる
    const admin = inviteFormSchema(inviteKindsFor('admin'));
    for (const kind of INVITE_KINDS) expect(admin.safeParse({ email: 'x@example.test', kind, group_id: R1 }).success).toBe(true);
    // メールと立場の誤りは一緒に出る
    expect(head.safeParse({ email: 'bad', kind: 'admin', group_id: '' }).error?.issues.map((i) => i.path)).toEqual([['email'], ['kind']]);
  });
});
