import { fixturePath, readFixtureDir } from '@gaapp/shared/testing';
import { describe, expect, it } from 'vitest';
import type { RuleDbRow, YearRow } from '@/lib/db/types';
import { FIXTURE_UPDATED_AT, fixtureToTables } from '@/lib/testing/fixture-rows';
import {
  canonicalJson,
  checkEnable,
  checkRuleForm,
  describeRule,
  emptyRuleForm,
  errorsUnder,
  keepRoomAfterGroupChange,
  keepUnusableMessage,
  missingTemplates,
  parseCodeParam,
  R8_RULE_TEMPLATES,
  ruleEditMode,
  ruleNamesOf,
  ruleProblems,
  ruleRefMessage,
  ruleToForm,
  sameRuleWrite,
  templateToForm,
  toRuleWrite,
  type RuleFormValues,
  type RulesData,
} from './rules';

const r8like = readFixtureDir(fixturePath('synthetic', 'r8like'));
const MISSING = '99999999-9999-4999-8999-999999999999';

function data(opts: { rules?: RuleDbRow[]; status?: YearRow['status']; unusable?: string[] } = {}): RulesData {
  const t = structuredClone(fixtureToTables(r8like));
  const year: YearRow = {
    id: t.groups[0]!.year_id,
    label: 'R8',
    status: opts.status ?? 'requesting',
    allocation_version: 1,
    auto_allocated_at: null,
    festival_start: '2026-10-17',
    request_open_at: null,
    request_close_at: null,
    prev_year_id: null,
    updated_at: FIXTURE_UPDATED_AT,
  };
  const roomYears = [
    ...t.roomYears,
    ...(opts.unusable ?? []).map((name) => ({
      year_id: year.id,
      room_id: t.rooms.find((r) => r.name === name)!.id,
      usable: false,
      note: null,
      updated_at: FIXTURE_UPDATED_AT,
    })),
  ];
  return { year, rules: opts.rules ?? t.rules, items: t.items, rooms: t.rooms, groups: t.groups, roomYears };
}

const d = data();
const names = ruleNamesOf(d);
const rule = (code: string) => d.rules.find((r) => r.code === code)!;
const groupId = (name: string) => d.groups.find((g) => g.name === name)!.id;
const roomId = (name: string) => d.rooms.find((r) => r.name === name)!.id;

describe('describeRule', () => {
  it('4種類の内容の文（団体・場所・品目は名前）', () => {
    // 重さ 0 の代替（S01・S02）は、その区分では元の品目と同じに扱う（01 の規則4）
    expect(describeRule(rule('S01'), names)).toBe('不可机は机(木)と同じに扱う（模擬店）');
    expect(describeRule(rule('S02'), names)).toBe('不可椅子は椅子(木)と同じに扱う（休憩所・模擬店、同じ距離なら休憩所を先に）');
    expect(describeRule(rule('S04'), names)).toBe('企業の長机(3人掛)が足りなければ長机(2人掛)で代える（重さ 1）');
    expect(describeRule(rule('S07'), names)).toBe(
      '模擬店の机(木)が足りなければキャスター机で代える（重さ 3、屋内の団体だけ、了承が要る）',
    );
    expect(describeRule(rule('S05'), names)).toBe('設営の机(木)は 1-1・1-2・1-3・2-1・2-2・2-3 からだけ出す');
    expect(describeRule(rule('S06'), names)).toBe('設営が未提出なら、机(木)を 241 台申請したものとする');
    expect(describeRule(rule('S08'), names)).toBe('学科展示は第一多目的室の 机(木) 12・椅子(木) 4 を残す');
  });

  it('見つからない団体・場所は印、知らない品目はコードのまま', () => {
    const p = { group: MISSING, items: ['desk', 'unknown_item'], rooms: [roomId('1-1'), MISSING] };
    expect(describeRule({ kind: 'source_restrict', params: p }, names)).toBe(
      '（見つからない団体）の机(木)・unknown_itemは 1-1・（見つからない場所） からだけ出す',
    );
    expect(describeRule({ kind: 'keep', params: { group: groupId('設営'), room: MISSING, items: { chair: 2 } } }, names)).toBe(
      '設営は（見つからない場所）の 椅子(木) 2 を残す',
    );
  });

  it('params の形が合わなければ「設定が壊れています」', () => {
    expect(describeRule({ kind: 'substitute', params: { from: 'desk' } }, names)).toBe('設定が壊れています');
    expect(describeRule({ kind: 'fixed_request', params: { group: groupId('設営'), item: 'desk', count: 0 } }, names)).toBe('設定が壊れています');
    expect(describeRule({ kind: 'keep', params: null }, names)).toBe('設定が壊れています');
    expect(describeRule({ kind: 'other', params: {} }, names)).toBe('設定が壊れています');
  });
});

/** 合成データの rules.json のルール（id を付け替えたもの）を、フォームの値から作り直す */
function formOf(code: string): RuleFormValues {
  return ruleToForm(rule(code));
}

describe('checkRuleForm（保存の前の確かめ）', () => {
  const empty = data({ rules: [] });

  it('ルールがない年度で、S01〜S08 を1つずつ足すと、保存する行が rules.json（id 付け替え）と同じ', () => {
    let rules: RuleDbRow[] = [];
    for (const r of d.rules) {
      const res = checkRuleForm(ruleToForm(r), { ...empty, rules }, null);
      expect(res.errors).toEqual({});
      const w = toRuleWrite(res.row!);
      expect(canonicalJson(w.params)).toBe(canonicalJson(r.params));
      expect(w).toEqual({ code: r.code, kind: r.kind, params: r.params, enabled: r.enabled, memo: r.memo });
      rules = [...rules, { ...r }];
    }
  });

  it('ひな形に団体・場所を入れると、rules.json と同じ行になる', () => {
    let rules: RuleDbRow[] = [];
    for (const t of R8_RULE_TEMPLATES) {
      const f = templateToForm(t);
      if (t.code === 'S05') f.sourceRestrict = { ...f.sourceRestrict, group: groupId('設営'), rooms: ['1-1', '1-2', '1-3', '2-1', '2-2', '2-3'].map(roomId) };
      if (t.code === 'S06') f.fixedRequest = { ...f.fixedRequest, group: groupId('設営') };
      if (t.code === 'S08') f.keep = { ...f.keep, group: groupId('学科展示'), room: roomId('第一多目的室') };
      const res = checkRuleForm(f, { ...empty, rules }, null);
      expect(res.errors).toEqual({});
      const r = rule(t.code);
      expect(toRuleWrite(res.row!)).toEqual({ code: r.code, kind: r.kind, params: r.params, enabled: true, memo: r.memo });
      rules = [...rules, r];
    }
  });

  it('ひな形の S05・S06・S08 は団体・場所を選ばないと保存できない（欄の下のエラー）', () => {
    const s05 = checkRuleForm(templateToForm(R8_RULE_TEMPLATES.find((t) => t.code === 'S05')!), empty, null);
    expect(s05.row).toBeNull();
    expect(errorsUnder(s05.errors, 'params.group')).toEqual(['団体を選んでください']);
    expect(errorsUnder(s05.errors, 'params.rooms')).toEqual(['場所を1つ以上選んでください']);
    const s08 = checkRuleForm(templateToForm(R8_RULE_TEMPLATES.find((t) => t.code === 'S08')!), empty, null);
    expect(errorsUnder(s08.errors, 'params.room')).toEqual(['場所を選んでください']);
  });

  it('形の誤りを欄ごとの日本語にする', () => {
    const f = emptyRuleForm('substitute');
    f.code = ' ';
    f.substitute = { ...f.substitute, from: 'desk', to: 'desk', cost: '11', preferCategory: 'stall' };
    const res = checkRuleForm(f, empty, null);
    expect(res.row).toBeNull();
    expect(res.errors['code']).toEqual(['コードを入れてください（50 字まで）']);
    expect(res.errors['params.categories']).toEqual(['区分を1つ以上選んでください']);
    expect(res.errors['params.cost']).toEqual(['重さは 0〜10 の整数にしてください']);

    const g = emptyRuleForm('substitute');
    g.code = 'X1';
    g.substitute = { ...g.substitute, from: 'desk', to: 'desk', categories: ['company'], preferCategory: 'stall' };
    const res2 = checkRuleForm(g, empty, null);
    expect(res2.errors['params.to']).toEqual(['代替先が代替元と同じです']);
    expect(res2.errors['params.preferCategory']).toEqual(['優先する区分は、選んだ区分の中から選んでください']);

    const k = emptyRuleForm('keep');
    k.code = 'K1';
    k.keep = { group: groupId('学科展示'), room: roomId('第一多目的室'), items: { desk: '0', chair: '' } };
    expect(checkRuleForm(k, empty, null).errors['params.items.desk']).toEqual(['数は 1〜10000 の整数にしてください']);
    k.keep.items = { desk: '' };
    expect(checkRuleForm(k, empty, null).errors['params.items']).toEqual(['残す品目と数を入れてください']);

    const c = emptyRuleForm('fixed_request');
    c.code = 'F1';
    c.fixedRequest = { group: groupId('設営'), item: 'desk', count: '1.5' };
    expect(checkRuleForm(c, empty, null).errors['params.count']).toEqual(['数は 1〜10000 の整数にしてください']);

    const m = formOf('S01');
    m.memo = 'あ'.repeat(2001);
    expect(checkRuleForm(m, empty, null).errors['memo']).toEqual(['メモは 2000 字までです']);
  });

  it('ほかの有効なルールと重なるものは止める（自分自身は除く・無効のルールとは重ならない）', () => {
    const dup = formOf('S01');
    dup.code = 'S01b';
    const res = checkRuleForm(dup, d, null);
    expect(res.row).toBeNull();
    expect(errorsUnder(res.errors, 'params.categories')).toEqual(['同じ代替（机(木)→不可机）で区分が重なるルール S01 があります']);

    // 編集中の S01 自身とは重ならない
    expect(checkRuleForm(formOf('S01'), d, rule('S01').id).errors).toEqual({});

    // S01 が無効なら重ならない
    const disabled = data({ rules: d.rules.map((r) => (r.code === 'S01' ? { ...r, enabled: false } : r)) });
    expect(checkRuleForm(dup, disabled, null).errors).toEqual({});

    // 無効のまま保存するルールは重なりを見ない（参照だけ）
    const off = { ...dup, enabled: false };
    expect(checkRuleForm(off, d, null).errors).toEqual({});
  });

  it('コードの重複は無効のルールとも比べる', () => {
    const disabled = data({ rules: d.rules.map((r) => (r.code === 'S01' ? { ...r, enabled: false } : r)) });
    const f = formOf('S04');
    f.code = 'S01';
    expect(checkRuleForm(f, disabled, null).errors['code']).toEqual(['同じコードのルールがあります']);
    expect(checkRuleForm(f, d, null).errors['code']).toEqual(['同じコードのルールがあります']);
  });

  it('参照の切れ・残すの場所が使用場所でない（E005）・申請できない品目を欄の下に出す', () => {
    const s05 = formOf('S05');
    s05.sourceRestrict.rooms = [...s05.sourceRestrict.rooms, MISSING];
    s05.code = 'S05x';
    expect(errorsUnder(checkRuleForm(s05, data({ rules: [] }), null).errors, 'params.rooms')).toEqual(['場所がありません']);

    const s08 = formOf('S08');
    s08.keep.room = roomId('1-1');
    const r = checkRuleForm(s08, d, rule('S08').id);
    expect(r.errors['params.room']).toContain('「残す」は団体の使用場所の部屋だけです');

    const fr = emptyRuleForm('fixed_request');
    fr.code = 'F1';
    fr.fixedRequest = { group: groupId('設営'), item: 'long_desk_3', count: '3' };
    expect(checkRuleForm(fr, d, null).errors['params.item']).toEqual([
      'この団体の区分は「長机(3人掛)」を申請できません。読み替え先の「長机(2人掛)」を選んでください',
    ]);
  });

  it('「残す」の場所が今年使用不可なら、場所の欄に知らせる（保存は止めない）', () => {
    const off = data({ unusable: ['第一多目的室'] });
    const res = checkRuleForm(formOf('S08'), off, rule('S08').id);
    expect(res.errors).toEqual({});
    expect(res.row).not.toBeNull();
    expect(res.warnings).toEqual({ 'params.room': [keepUnusableMessage('第一多目的室')] });
    // 使用可なら知らせない。ほかの種別も見ない
    expect(checkRuleForm(formOf('S08'), d, rule('S08').id).warnings).toEqual({});
    expect(checkRuleForm(formOf('S05'), data({ unusable: ['1-1'] }), rule('S05').id).warnings).toEqual({});
  });

  it('source_restrict の品目と場所は、選んだ順でなく品目・場所の並びで保存する', () => {
    const f = formOf('S05');
    f.code = 'S05';
    f.sourceRestrict.rooms = [...f.sourceRestrict.rooms].reverse();
    const res = checkRuleForm(f, d, rule('S05').id);
    expect(res.row?.params).toEqual(rule('S05').params);
  });
});

describe('checkEnable・ruleProblems', () => {
  it('有効にする前に、ほかの有効なルールとの重なりを確かめる', () => {
    const extra: RuleDbRow = { ...rule('S01'), id: MISSING, code: 'S01b', enabled: false };
    const withExtra = data({ rules: [...d.rules, extra] });
    expect(checkEnable(extra, withExtra)).toEqual(['同じ代替（机(木)→不可机）で区分が重なるルール S01 があります']);
    expect(checkEnable(rule('S04'), d)).toEqual([]);
  });

  it('参照の切れた有効なルールに印を出す（無効のルールと問題のないルールには出さない）', () => {
    const t = data();
    t.groups = t.groups.filter((g) => g.name !== '設営');
    const p = ruleProblems(t);
    expect([...p.keys()].map((id) => t.rules.find((r) => r.id === id)!.code).sort()).toEqual(['S05', 'S06']);
    expect(p.get(rule('S05').id)!.label).toBe('参照が切れています（団体が見つかりません）');

    const off = data({ rules: d.rules.map((r) => (r.code === 'S05' ? { ...r, enabled: false } : r)) });
    off.groups = off.groups.filter((g) => g.name !== '設営');
    expect([...ruleProblems(off).keys()].length).toBe(1);

    const broken = data({ rules: d.rules.map((r) => (r.code === 'S01' ? { ...r, params: { from: 'desk' } } : r)) });
    expect(ruleProblems(broken).get(rule('S01').id)!.label).toBe('設定が壊れています');
    expect(ruleProblems(d).size).toBe(0);
  });

  it('「残す」の場所が今年使用不可の有効なルールに印を出す（無効のルールには出さない）', () => {
    const off = data({ unusable: ['第一多目的室'] });
    const p = ruleProblems(off);
    expect([...p.keys()]).toEqual([rule('S08').id]);
    expect(p.get(rule('S08').id)).toEqual({ label: '使用不可の場所です', messages: [keepUnusableMessage('第一多目的室')] });

    const disabled = data({ unusable: ['第一多目的室'], rules: d.rules.map((r) => (r.code === 'S08' ? { ...r, enabled: false } : r)) });
    expect(ruleProblems(disabled).size).toBe(0);
  });
});

describe('ruleRefMessage（checkRuleRefs の文言の品目のコードを名前に）', () => {
  it('「」・（→）・（・）の中の品目のコードを名前にし、知らないコードとルールのコードはそのまま', () => {
    expect(ruleRefMessage({ path: 'params.categories', message: '同じ代替（desk→desk_ng）で区分が重なるルール S01 があります' }, names)).toBe(
      '同じ代替（机(木)→不可机）で区分が重なるルール S01 があります',
    );
    expect(
      ruleRefMessage({ path: 'params.rooms', message: '「残す」のルール S08 の部屋が、この制限の場所に入っていません（desk・chair）' }, names),
    ).toBe('「残す」のルール S08 の部屋が、この制限の場所に入っていません（机(木)・椅子(木)）');
    expect(ruleRefMessage({ path: 'params.items.desk', message: '同じ団体・部屋・品目（desk）の「残す」のルール S08 があります' }, names)).toBe(
      '同じ団体・部屋・品目（机(木)）の「残す」のルール S08 があります',
    );
    expect(ruleRefMessage({ path: 'params.items.0', message: '品目「unknown_item」がありません' }, names)).toBe('品目「unknown_item」がありません');
    // コードの重複の文言はルールのコード（品目と同じ文字でも直さない）
    expect(ruleRefMessage({ path: 'code', message: 'コード「desk」は他のルールで使われています' }, names)).toBe('コード「desk」は他のルールで使われています');
  });
});

describe('keepRoomAfterGroupChange（「残す」で団体を選び直したときの場所）', () => {
  const groups = d.groups;
  it('場所が空か前の団体の使用場所なら新しい団体の使用場所に、手で選んだ場所はそのまま', () => {
    const a = groupId('模擬店01');
    const b = groupId('模擬店02');
    const exhibit = groupId('学科展示');
    expect(keepRoomAfterGroupChange({ group: null, room: null }, a, groups)).toBe(roomId('1-1'));
    expect(keepRoomAfterGroupChange({ group: a, room: roomId('1-1') }, b, groups)).toBe(roomId('1-2'));
    expect(keepRoomAfterGroupChange({ group: b, room: roomId('1-2') }, exhibit, groups)).toBe(roomId('第一多目的室'));
    // 手で選んだ場所（前の団体の使用場所でない）は替えない
    expect(keepRoomAfterGroupChange({ group: a, room: roomId('2-1') }, b, groups)).toBe(roomId('2-1'));
    // 団体を外すと、使用場所のままだった場所は空に
    expect(keepRoomAfterGroupChange({ group: a, room: roomId('1-1') }, null, groups)).toBeNull();
  });
});

describe('そのほか', () => {
  it('確定中と終了はメモだけ', () => {
    expect(ruleEditMode('preparing')).toBe('full');
    expect(ruleEditMode('requesting')).toBe('full');
    expect(ruleEditMode('allocating')).toBe('full');
    expect(ruleEditMode('confirmed')).toBe('memo');
    expect(ruleEditMode('closed')).toBe('memo');
  });

  it('まだないコードのひな形だけ（無効のルールもあるとみなす）', () => {
    expect(missingTemplates([]).map((t) => t.code)).toEqual(['S01', 'S02', 'S04', 'S05', 'S06', 'S07', 'S08']);
    expect(missingTemplates([{ code: 'S01' }, { code: ' S05 ' }]).map((t) => t.code)).toEqual(['S02', 'S04', 'S06', 'S07', 'S08']);
  });

  it('?code= の値', () => {
    expect(parseCodeParam('S05')).toBe('S05');
    expect(parseCodeParam(' S05 ')).toBe('S05');
    expect(parseCodeParam('')).toBeNull();
    expect(parseCodeParam(null)).toBeNull();
    expect(parseCodeParam('x'.repeat(51))).toBeNull();
  });

  it('保存されていたかの比べ方（jsonb のキーの順によらない）', () => {
    expect(canonicalJson({ b: 1, a: [2, { d: 1, c: 2 }] })).toBe(canonicalJson({ a: [2, { c: 2, d: 1 }], b: 1 }));
    const r = rule('S08');
    expect(sameRuleWrite(r, { memo: r.memo, params: { items: { chair: 4, desk: 12 }, room: roomId('第一多目的室'), group: groupId('学科展示') } })).toBe(true);
    expect(sameRuleWrite(r, { memo: 'ちがう' })).toBe(false);
  });

  it('壊れた params もフォームに読める所だけ読む', () => {
    const f = ruleToForm({ code: 'X', kind: 'keep', params: { group: 1, items: { desk: 'a', chair: 3 } }, enabled: false, memo: null });
    expect(f.keep).toEqual({ group: null, room: null, items: { desk: '', chair: '3' } });
    expect(f.enabled).toBe(false);
    expect(f.memo).toBe('');
  });
});
