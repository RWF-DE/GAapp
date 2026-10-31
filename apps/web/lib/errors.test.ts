import { describe, expect, it } from 'vitest';
import {
  AppError,
  appError,
  classifyError,
  effectOf,
  isUnknownOutcome,
  issueMessages,
  messageFor,
  normalizeIssues,
  parseDetails,
  toAppError,
  unknownOutcomeMessage,
  type MessageContext,
} from './errors';

// supabase-js の error の形（PostgREST の応答の本文）。details は JSON の文字列か空文字
const pg = (code: string, message = '', details: unknown = '') => ({ code, message, details, hint: null });
const p0001 = (message: string, details?: unknown) =>
  pg('P0001', message, details === undefined ? '' : JSON.stringify(details));

const ROOM = '11111111-1111-4111-8111-111111111111';
const ITEM = '22222222-2222-4222-8222-222222222222';
const GROUP = '33333333-3333-4333-8333-333333333333';
const ALLOC = '44444444-4444-4444-8444-444444444444';
const names: MessageContext['names'] = {
  room: (id) => (id === ROOM ? '1-1' : undefined),
  item: (id) => (id === ITEM ? '机(木)' : undefined),
  group: (id) => (id === GROUP ? '模擬店甲' : undefined),
};

const msg = (e: unknown, ctx: MessageContext = {}, status?: number) => messageFor(classifyError(e, status), { names, ...ctx });
const kind = (e: unknown, status?: number) => classifyError(e, status).kind;

describe('classifyError と messageFor：2.5 の表の行', () => {
  it('P0001 forbidden と 42501 → forbidden。立場と年度を読み直す', () => {
    expect(kind(p0001('forbidden'))).toBe('forbidden');
    expect(kind(pg('42501', 'permission denied for table years'))).toBe('forbidden');
    expect(msg(p0001('forbidden'))).toBe('権限がありません。立場が変わった可能性があります');
    expect(effectOf(classifyError(p0001('forbidden'))).reload).toBe('year');
  });

  it('招待の forbidden：部門長・副部門長（canChangeRoles: false）には、管理者の未使用の招待があるメールかもしれないと添える（D-48）', () => {
    expect(msg(p0001('forbidden'), { rpc: 'invite', canChangeRoles: false })).toBe(
      '権限がありません。このメールアドレスに管理者が出した招待があるか、立場が変わった可能性があります（管理者に頼んでください）',
    );
    expect(msg(p0001('forbidden'), { rpc: 'invite', canChangeRoles: true })).toBe('権限がありません。立場が変わった可能性があります');
    expect(msg(p0001('forbidden'), { rpc: 'invite' })).toBe('権限がありません。立場が変わった可能性があります');
    // 招待のほかの RPC には添えない
    expect(msg(p0001('forbidden'), { rpc: 'set_group_member_role', canChangeRoles: false })).toBe('権限がありません。立場が変わった可能性があります');
  });

  it('P0001 not_found → not_found。読み直す', () => {
    expect(kind(p0001('not_found'))).toBe('not_found');
    expect(msg(p0001('not_found'))).toBe('対象が見つかりません（ほかの人が消した可能性があります）');
    expect(effectOf(classifyError(p0001('not_found'))).reload).toBe('data');
  });

  it('P0001 invalid_state → state（details で文言を分ける）。年度を読み直す', () => {
    expect(kind(p0001('invalid_state', { status: 'allocating' }))).toBe('state');
    expect(effectOf(classifyError(p0001('invalid_state'))).reload).toBe('year');
    expect(msg(p0001('invalid_state', { status: 'confirmed' }))).toBe('年度が「確定」のため、この操作はできません');
    expect(msg(p0001('invalid_state', { reason: 'last_admin' }))).toBe('最後の管理者は外せません');
    expect(msg(p0001('invalid_state', { reason: 'not_latest' }))).toBe('最新の年度からだけ新しい年度を作れます');
    expect(msg(p0001('invalid_state', { reason: 'used' }))).toBe('使用済みの招待は取り消せません');
    expect(msg(p0001('invalid_state', { reason: 'no_rows' }))).toBe('置き換えの行がないので依頼できません');
    expect(msg(p0001('invalid_state', { field: 'request_close_at' }))).toBe('受付開始の前に、締切を未来の日時で入れてください');
  });

  it('invalid_state の確定中の守り（E001・E002）は部屋と品目の名前を添える', () => {
    const guard = '確定中は、在庫超過や使用不可の部屋からの振り分けになる変更はできません。確定を解除してから直してください';
    expect(
      msg(p0001('invalid_state', { status: 'confirmed', code: 'E001', room_id: ROOM, item_id: ITEM, allocated: 5, stock: 3 })),
    ).toBe(`${guard}（1-1の机(木)）`);
    expect(msg(p0001('invalid_state', { status: 'confirmed', code: 'E002', room_id: ROOM }))).toBe(`${guard}（1-1）`);
    // 名前が分からなければ id を出さない
    expect(msg(p0001('invalid_state', { status: 'confirmed', code: 'E002', room_id: 'x' }))).toBe(guard);
  });

  it('P0001 conflict → conflict（details で文言を分ける）。読み直して入力を残す', () => {
    expect(kind(p0001('conflict'))).toBe('conflict');
    const eff = effectOf(classifyError(p0001('conflict')));
    expect(eff).toMatchObject({ reload: 'data', keepInput: true });
    expect(msg(p0001('conflict'))).toBe('他の人が先に変更しました。読み直しました');
    expect(msg(p0001('conflict', { field: 'label' }))).toBe('同じ年度名があります');
    expect(msg(p0001('conflict', { field: 'role', current: 'staff' }))).toBe(
      'この人はすでに「総務部門員」です。ロールの変更はメンバーの一覧から',
    );
    expect(msg(p0001('conflict', { asked: 6, current: 8 }))).toBe(
      '依頼した台数（6）より置き換えが増えています（8）。依頼し直してください',
    );
  });

  it('招待の conflict（field: role）の後ろの文は、ロールを変えられる人かで変わる（管理者はメンバーの一覧、部門長・副部門長は管理者に頼む。D-50）', () => {
    const e = p0001('conflict', { field: 'role', current: 'viewer' });
    expect(msg(e, { rpc: 'invite', canChangeRoles: true })).toBe('この人はすでに「閲覧のみ」です。ロールの変更はメンバーの一覧から');
    expect(msg(e, { rpc: 'invite', canChangeRoles: false })).toBe('この人はすでに「閲覧のみ」です。ロールの変更は管理者に頼んでください');
    expect(msg(p0001('conflict', { field: 'role', current: 'head' }), { canChangeRoles: false })).toBe(
      'この人はすでに「総務部門長」です。ロールの変更は管理者に頼んでください',
    );
    // 今のロールが分からない（表にない値・ない）ときは名前を出さない
    expect(msg(p0001('conflict', { field: 'role', current: 'other' }), { canChangeRoles: false })).toBe(
      'この人にはすでに別のロールがあります。ロールの変更は管理者に頼んでください',
    );
    expect(msg(p0001('conflict', { field: 'role' }))).toBe('この人にはすでに別のロールがあります。ロールの変更はメンバーの一覧から');
  });

  it('招待の conflict（field: group_role。同じ団体に別の立場でいる。T15）→ 今の立場と、切り替えはメンバーの一覧から', () => {
    const e = p0001('conflict', { field: 'group_role', current: 'deputy_manager' });
    expect(classifyError(e)).toMatchObject({ kind: 'conflict', reason: 'conflict' });
    expect(effectOf(classifyError(e))).toMatchObject({ reload: 'data', keepInput: true });
    expect(msg(e, { rpc: 'invite' })).toBe('この人はすでにこの団体の副店長です。店長・副店長の切り替えはメンバーの一覧から');
    expect(msg(p0001('conflict', { field: 'group_role', current: 'manager' }), { canChangeRoles: false })).toBe(
      'この人はすでにこの団体の店長です。店長・副店長の切り替えはメンバーの一覧から',
    );
    expect(msg(p0001('conflict', { field: 'group_role' }))).toBe(
      'この人はすでにこの団体の店長・副店長です。店長・副店長の切り替えはメンバーの一覧から',
    );
  });

  it('P0001 role_overlap（兼任の禁止。T15）→ conflict。details によらず同じ文言で、読み直して入力を残す', () => {
    const overlap = '総務の部門員・部門長・副部門長は、同じ年度の団体の店長・副店長を兼ねられません（管理者と閲覧のみは兼ねられます）';
    const Y = '55555555-5555-4555-8555-555555555555';
    const U = '66666666-6666-4666-8666-666666666666';
    // トリガーの details は {year_id, user_id}（メールは入れない）
    const e = p0001('role_overlap', { year_id: Y, user_id: U });
    expect(classifyError(e)).toMatchObject({ kind: 'conflict', code: 'P0001', reason: 'role_overlap', details: { year_id: Y, user_id: U } });
    expect(effectOf(classifyError(e))).toMatchObject({ reload: 'data', keepInput: true });
    expect(msg(e)).toBe(overlap);
    // invite の早めのエラー（reason つき）と details のないものも同じ
    expect(msg(p0001('role_overlap', { year_id: Y, reason: 'pending_invitation' }), { rpc: 'invite' })).toBe(overlap);
    expect(msg(p0001('role_overlap'))).toBe(overlap);
    // 部門長・副部門長の招待（canChangeRoles: false）でも同じ
    expect(msg(p0001('role_overlap', { year_id: Y, user_id: U, reason: 'current_membership' }), { rpc: 'invite', canChangeRoles: false })).toBe(overlap);
  });

  it('P0001 invalid_input → input（欄の日本語名を添える）。入力を残す', () => {
    expect(kind(p0001('invalid_input', { field: 'note' }))).toBe('input');
    expect(effectOf(classifyError(p0001('invalid_input')))).toMatchObject({ reload: 'none', keepInput: true });
    expect(msg(p0001('invalid_input', { field: 'note' }))).toBe('入力の形が違います（備考）');
    expect(msg(p0001('invalid_input', { field: 'unknown_field_x' }))).toBe('入力の形が違います');
  });

  it('P0001 reason_required → reason', () => {
    expect(kind(p0001('reason_required'))).toBe('reason');
    expect(msg(p0001('reason_required'))).toBe('理由を入力してください');
  });

  it('P0001 E001・E002・E005・E006 → issue。1件の object も配列も一覧にそろえる', () => {
    expect(kind(p0001('E002', { room_id: ROOM }))).toBe('issue');
    expect(msg(p0001('E002', { room_id: ROOM }))).toBe('使用不可の部屋（1-1）からは振り分けられません');
    expect(msg(p0001('E005', { group_id: GROUP, source_room_id: ROOM }))).toBe('残すと使用場所が合いません（模擬店甲）');
    expect(msg(p0001('E006', { group_id: GROUP, item_id: ITEM }))).toBe('模擬店甲は机(木)を申請できません');
    // set_year_status の確定と save_auto_allocations の保存後：confirm_issues の配列
    const arr = p0001('E001', [
      { code: 'E001', room_id: ROOM, item_id: ITEM, allocated: 12, stock: 10 },
      { code: 'E001', room_id: 'other', item_id: ITEM, allocated: 3, stock: 1 },
    ]);
    const c = classifyError(arr);
    expect(c.issues).toHaveLength(2);
    expect(issueMessages(c, { names })).toEqual(['在庫を超えます（1-1の机(木)：振り分け12、在庫10）', '在庫を超えます（机(木)：振り分け3、在庫1）']);
    expect(messageFor(c, { names })).toBe('在庫を超えます（1-1の机(木)：振り分け12、在庫10）（ほか 1 件）');
    expect(effectOf(c).reload).toBe('data');
    // 確定の E002・E005 は allocation_id を持つ（振り分けの行へのリンクに使う）
    const conf = classifyError(p0001('E002', [{ code: 'E002', allocation_id: ALLOC, room_id: ROOM }]));
    expect(conf.issues).toEqual([{ code: 'E002', allocationId: ALLOC, roomId: ROOM }]);
    // save_auto_allocations の保存前：{ code, ord, room_id | group_id }
    const pre = classifyError(p0001('E005', [{ code: 'E005', ord: 3, group_id: GROUP }]));
    expect(pre.issues).toEqual([{ code: 'E005', ord: 3, groupId: GROUP }]);
  });

  it('code が 22 で始まる → input', () => {
    expect(kind(pg('22P02', 'invalid input syntax for type uuid: "x"'))).toBe('input');
    expect(kind(pg('22007', 'invalid input syntax for type date'))).toBe('input');
    expect(msg(pg('22P02'))).toBe('入力の形が違います');
  });

  it('23505 → conflict、23503 → blocked、23514 → input', () => {
    expect(kind(pg('23505', 'duplicate key value'))).toBe('conflict');
    expect(msg(pg('23505'))).toBe('同じものがすでにあります（ほかの人が先に足した可能性があります）');
    expect(kind(pg('23503'))).toBe('blocked');
    expect(msg(pg('23503'))).toBe('ほかのデータから使われているので削除できません');
    expect(effectOf(classifyError(pg('23503'))).reload).toBe('none');
    expect(kind(pg('23514'))).toBe('input');
    expect(msg(pg('23514'))).toBe('入力が範囲を超えています');
  });

  it('P0001 以外の details（DB の値を含みうる）は持たない', () => {
    const c = classifyError(pg('23505', 'duplicate key', 'Key (email)=(someone@example.test) already exists.'));
    expect(c.details).toBeNull();
    expect(messageFor(c)).not.toContain('@');
  });

  it('40P01 → deadlock（HTTP 500 で来ても code で分ける）。読み直さない', () => {
    expect(kind(pg('40P01', 'deadlock detected'), 500)).toBe('deadlock');
    expect(msg(pg('40P01'))).toBe('ほかの人の保存と重なりました。もう一度保存してください');
    expect(effectOf(classifyError(pg('40P01')))).toMatchObject({ reload: 'none', keepInput: true });
  });

  it('PGRST301・302・303 と status 401 → auth。セッションを更新し直す', () => {
    for (const code of ['PGRST301', 'PGRST302', 'PGRST303']) expect(kind(pg(code, 'JWT'), 401)).toBe('auth');
    // PostgREST v16.5 の期限切れ：401 {"code":"PGRST303","message":"JWT expired"}
    const expired = { code: 'PGRST303', details: null, hint: null, message: 'JWT expired' };
    expect(kind(expired, 401)).toBe('auth');
    expect(kind(expired)).toBe('auth');
    // code がなくても status 401 なら auth
    expect(kind({ code: '', message: 'Unauthorized', details: '', hint: '' }, 401)).toBe('auth');
    expect(msg(expired)).toBe('ログインし直してください');
    expect(effectOf(classifyError(expired))).toMatchObject({ reauth: true, keepInput: true });
  });

  it('fetch の失敗 → network（supabase-js の status 0 の応答と、TypeError そのもの）', () => {
    const sb = { code: '', message: 'TypeError: Failed to fetch', details: 'TypeError: Failed to fetch', hint: '' };
    expect(kind(sb, 0)).toBe('network');
    expect(kind(sb)).toBe('network');
    expect(kind(new TypeError('fetch failed'))).toBe('network');
    expect(msg(new TypeError('x'))).toBe('通信できませんでした。電波の良い所でもう一度');
    expect(effectOf(classifyError(new TypeError('x')))).toMatchObject({ reload: 'none', retryRead: true, keepInput: true });
  });

  it('それ以外 → unknown（コードを添える）', () => {
    expect(kind(pg('XX000', 'internal'))).toBe('unknown');
    expect(msg(pg('XX000'))).toBe('予期しないエラーが起きました（コード：XX000）');
    expect(kind(new Error('boom'))).toBe('unknown');
    expect(msg('boom')).toBe('予期しないエラーが起きました');
    expect(kind(p0001('something_new'))).toBe('unknown');
  });
});

describe('details の形と文言（T03 の private.fail の呼び出し）', () => {
  it('invalid_state {from, to}：図にない遷移', () => {
    expect(msg(p0001('invalid_state', { from: 'preparing', to: 'confirmed' }))).toBe('準備中から確定には進められません。読み直しました');
  });
  it('invalid_state {status: closed, reason: memo_only}：終了した年度のルール', () => {
    expect(msg(p0001('invalid_state', { status: 'closed', reason: 'memo_only' }))).toBe('終了した年度のルールは、メモだけ直せます');
  });
  it('invalid_state {reason: confirmed}：確定中の振り分けの行', () => {
    expect(msg(p0001('invalid_state', { reason: 'confirmed' }))).toBe('確定中は振り分けを変えられません。確定を解除してから');
  });
  it('invalid_state {status, group_id}：確定中の団体の変更', () => {
    expect(msg(p0001('invalid_state', { status: 'confirmed', group_id: GROUP }))).toBe(
      '確定中は団体の削除・使用場所・区分の変更はできません',
    );
  });
  it('invalid_state {status: requesting}（submit_requests）：読み直しても受付中なら時計の文言', () => {
    const e = p0001('invalid_state', { status: 'requesting' });
    const clock = '締切を過ぎました（または受付の前です）。端末の時計がずれている可能性があります';
    expect(msg(e, { rpc: 'submit_requests' })).toBe(clock);
    expect(msg(e, { rpc: 'submit_requests', reloadedStatus: 'requesting' })).toBe(clock);
    expect(msg(e, { rpc: 'submit_requests', reloadedStatus: 'allocating' })).toBe('年度が「振り分け中」のため、この操作はできません');
  });
  it('invalid_state（details なし）：set_consent の依頼の前の回答', () => {
    expect(msg(p0001('invalid_state'), { rpc: 'set_consent' })).toBe('まだ依頼されていないので回答できません。読み直しました');
    expect(msg(p0001('invalid_state'))).toBe('この操作はできません');
    expect(msg(p0001('invalid_state', { reason: 'brand_new' }))).toBe('この操作はできません');
  });
  it('invalid_input（details なし）：create_year_from', () => {
    expect(msg(p0001('invalid_input'), { rpc: 'create_year_from', prevFestivalStart: '2026-10-17' })).toBe(
      '年度名を入れ、1日目は今の年度（2026-10-17）より後の日付にしてください',
    );
    expect(msg(p0001('invalid_input'), { rpc: 'create_year_from' })).toBe('年度名を入れ、1日目は今の年度より後の日付にしてください');
  });
  it('invalid_input（details なし）：set_consent', () => {
    expect(msg(p0001('invalid_input'), { rpc: 'set_consent' })).toBe('入力の形が違います');
  });
  it('invalid_input {field: festival_start}・{field: request_close_at}', () => {
    expect(msg(p0001('invalid_input', { field: 'festival_start' }))).toBe(
      '1日目は、前の年度より後・次の年度より前で、2000年1月1日〜2200年12月31日の日付にしてください',
    );
    expect(msg(p0001('invalid_input', { field: 'request_close_at' }))).toBe('申請の受付中は締切を空にできません');
  });
  it('invalid_input {field: …}：各 RPC の欄', () => {
    const cases: [string, string][] = [
      ['label', '入力の形が違います（年度名）'],
      ['patch', '入力の形が違います（年度の項目）'],
      ['role', '入力の形が違います（ロール）'],
      ['email', 'メールアドレスの形が違います'],
      ['note', '入力の形が違います（備考）'],
      ['reason', '理由は 500 字までです'],
      ['mode', '入力の形が違います（実行の種類）'],
      ['group_id', '入力の形が違います（団体）'],
      ['groupId', '入力の形が違います（団体）'],
      ['op', '入力の形が違います（変更の種類）'],
      ['changes', '入力の形が違います（振り分けの変更）'],
      ['rows', '入力の形が違います（行）'],
      ['submission', '入力の形が違います（提出）'],
      ['request_open_at', '入力の形が違います（受付開始）'],
    ];
    for (const [field, text] of cases) expect(msg(p0001('invalid_input', { field }))).toBe(text);
  });
  it('invalid_input {field: submittedAt}：取り込みの団体の名前を添える', () => {
    expect(msg(p0001('invalid_input', { field: 'submittedAt' }), { groupId: GROUP })).toBe(
      'フォームのタイムスタンプが読めないか、未来の日時です（模擬店甲）',
    );
  });
  it('invalid_input {rows}・{duplicates}：save_auto_allocations', () => {
    expect(msg(p0001('invalid_input', { rows: [1, 4] }))).toBe(
      '計算結果の行に誤りがあります（2行）。ページを再読み込みしてもう一度実行してください',
    );
    expect(msg(p0001('invalid_input', { duplicates: [{ group_id: GROUP }] }))).toBe(
      '計算結果の行に誤りがあります（1行）。ページを再読み込みしてもう一度実行してください',
    );
  });
  it('invalid_input {reason: duplicate_id}・{column, reason: immutable}', () => {
    expect(msg(p0001('invalid_input', { reason: 'duplicate_id' }))).toBe('同じ行への変更が重なっています');
    expect(msg(p0001('invalid_input', { column: 'year_id', reason: 'immutable' }))).toBe('この項目は変えられません（年度）');
    expect(msg(p0001('invalid_input', { column: 'brand_new', reason: 'immutable' }))).toBe('この項目は変えられません（brand_new）');
  });
  it('invalid_input（送った change そのもの）：save_allocation_rows の共通の検査', () => {
    expect(msg(p0001('invalid_input', { op: 'update', id: ALLOC, updatedAt: 'x', count: 0 }))).toBe(
      '入力の形が違います（数は 1〜10000、運び元・品目を選んでください）',
    );
  });
  it('not_found {field: user_id}：set_role', () => {
    expect(msg(p0001('not_found', { field: 'user_id' }))).toBe('この人のアカウントが見つかりません');
  });
  it('conflict {item_id}：update_requests_after_deadline', () => {
    expect(msg(p0001('conflict', { item_id: ITEM }), { groupId: GROUP })).toBe('模擬店甲の机(木)は、ほかの人が先に変えました。読み直しました');
  });
  it('conflict {id}：save_allocation_rows', () => {
    expect(msg(p0001('conflict', { id: ALLOC }))).toBe('ほかの人が同じ振り分けの行を先に変えました。読み直しました');
  });
  it('conflict {allocation_version}：save_auto_allocations と set_year_status（確定）', () => {
    const e = p0001('conflict', { allocation_version: 7 });
    expect(msg(e, { rpc: 'save_auto_allocations' })).toBe(
      '計算している間に、ほかの人が振り分け・了承・在庫・申請・ルールなどを変えました。読み直しました。もう一度実行してください',
    );
    expect(msg(e, { rpc: 'set_year_status' })).toBe(
      '確定の前に入力が変わったので、検証をやり直しました。結果を確かめてから、もう一度『確定』を押してください',
    );
  });
  it('forbidden（details なし）：revoke_invitation は有無を漏らさない', () => {
    expect(msg(p0001('forbidden'), { rpc: 'revoke_invitation' })).toBe('取り消せませんでした。読み直しました');
  });
});

describe('補助', () => {
  it('parseDetails：JSON の文字列・空文字・壊れた文字列・object', () => {
    expect(parseDetails('{"a":1}')).toEqual({ a: 1 });
    expect(parseDetails('')).toBeNull();
    expect(parseDetails('  ')).toBeNull();
    expect(parseDetails('{oops')).toBeNull();
    expect(parseDetails(null)).toBeNull();
    expect(parseDetails({ a: 1 })).toEqual({ a: 1 });
  });
  it('normalizeIssues：details がなくてもコードだけの1件', () => {
    expect(normalizeIssues('E002', null)).toEqual([{ code: 'E002' }]);
    expect(normalizeIssues('E001', [{ code: 'E999' }])).toEqual([{ code: 'E001' }]);
  });
  it('AppError：classifyError はそのまま中身を返し、message に中身を入れない', () => {
    const a = appError('conflict', 'lock_conflict', { table: 'groups' });
    expect(classifyError(a)).toBe(a.info);
    expect(a.message).toBe('conflict:lock_conflict');
    const b = toAppError(p0001('invalid_input', { field: 'email' }), 400);
    expect(b).toBeInstanceOf(AppError);
    expect(b.info).toMatchObject({ kind: 'input', status: 400 });
    expect(toAppError(a)).toBe(a);
  });
  it('予期しない応答（zod に合わない返り値）は読み直す', () => {
    const e = appError('unknown', 'unexpected_response');
    expect(messageFor(e.info)).toBe('予期しない応答を受け取りました。読み直してください');
    expect(effectOf(e.info).reload).toBe('data');
  });
  it('isUnknownOutcome：保存できたか分からないのは通信の失敗とタイムアウトだけ（2.6）', () => {
    // 通信の失敗：fetch の TypeError・中止・supabase-js の status 0
    expect(isUnknownOutcome(new TypeError('Failed to fetch'))).toBe(true);
    expect(isUnknownOutcome(Object.assign(new Error('aborted'), { name: 'AbortError' }))).toBe(true);
    expect(isUnknownOutcome({ code: '', message: 'TypeError: Failed to fetch' }, 0)).toBe(true);
    // コードのない応答：status が null・408・5xx（ゲートウェイのタイムアウトなど）、lib/rpc の予期しない応答
    expect(isUnknownOutcome({ message: 'oops' })).toBe(true);
    expect(isUnknownOutcome({ message: '' }, 408)).toBe(true);
    expect(isUnknownOutcome({ message: 'Bad gateway' }, 502)).toBe(true);
    expect(isUnknownOutcome({ message: 'Gateway Timeout', status: 504 })).toBe(true);
    expect(isUnknownOutcome(appError('unknown', 'unexpected_response'))).toBe(true);
    // 届いた失敗：コードつき（kind が unknown でも）、コードのない 4xx（408 を除く）、ほかの種類
    expect(isUnknownOutcome(pg('57014', 'canceling statement due to statement timeout'), 500)).toBe(false);
    expect(isUnknownOutcome(pg('XX000'), 500)).toBe(false);
    expect(isUnknownOutcome(pg('PGRST000'), 503)).toBe(false);
    expect(isUnknownOutcome(p0001('something_new'), 400)).toBe(false);
    expect(isUnknownOutcome({ message: 'Payload Too Large' }, 413)).toBe(false);
    expect(isUnknownOutcome(p0001('conflict'), 400)).toBe(false);
    expect(isUnknownOutcome(pg('40P01'), 500)).toBe(false);
    expect(isUnknownOutcome(pg('PGRST303'), 401)).toBe(false);
  });
  it('unknownOutcomeMessage：既定は「保存」、ボタンの名前を渡せる', () => {
    expect(unknownOutcomeMessage()).toBe('保存できたか分かりません。もう一度「保存」を押すと、確かめてから送ります');
    expect(unknownOutcomeMessage('提出')).toBe('提出できたか分かりません。もう一度「提出」を押すと、確かめてから送ります');
    expect(unknownOutcomeMessage('  ')).toBe(unknownOutcomeMessage());
  });
  it('楽観ロックの 0 行（lib/db）：消えていた', () => {
    expect(messageFor(appError('not_found', 'lock_missing').info)).toBe(
      'すでに消えていました（ほかの人が消した可能性があります）。読み直しました',
    );
  });
});

describe('T17 お知らせ（save_notice・delete_notice）の文言（04「お知らせ一覧」のエラー、notes/T17.md「後半（画面）の約束」5）', () => {
  const save: MessageContext = { rpc: 'save_notice' };
  const del: MessageContext = { rpc: 'delete_notice' };

  it('invalid_input の title・body は欄の下に出す文言', () => {
    expect(msg(p0001('invalid_input', { field: 'title' }), save)).toBe('題名は、前後の空白を除いて 1〜100 字にしてください');
    expect(msg(p0001('invalid_input', { field: 'body' }), save)).toBe('本文は 4000 字までです');
    expect(effectOf(classifyError(p0001('invalid_input', { field: 'title' }))).reload).toBe('none');
  });

  it('invalid_input の group_ids は reason ごと', () => {
    const cases: [string, string][] = [
      ['required', '宛先の団体を1つ以上選んでください'],
      ['too_many', '宛先の団体は 1000 までです'],
      ['invalid', '同じ団体が重なっています'],
      ['not_in_year', '選んだ団体の中に、この年度にない団体があります（消された可能性があります）。団体を読み直しました'],
      ['not_allowed', '総務内・全団体のお知らせには団体を選べません'],
    ];
    for (const [reason, text] of cases) expect(msg(p0001('invalid_input', { field: 'group_ids', reason }), save), reason).toBe(text);
    // 知らない reason・reason なしは「入力の形が違います（宛先の団体）」
    expect(msg(p0001('invalid_input', { field: 'group_ids', reason: 'x' }), save)).toBe('入力の形が違います（宛先の団体）');
    expect(msg(p0001('invalid_input', { field: 'group_ids' }), save)).toBe('入力の形が違います（宛先の団体）');
    expect(msg(p0001('invalid_input', { field: 'group_ids', reason: '__proto__' }), save)).toBe('入力の形が違います（宛先の団体）');
  });

  it('invalid_input のほかの field は「入力の形が違います（{欄の日本語名}）」', () => {
    const cases: [string, string][] = [
      ['audience', '宛先'],
      ['pinned', 'ピン留め'],
      ['base_updated_at', 'お知らせの版'],
      ['notice', 'お知らせ'],
    ];
    for (const [field, label] of cases) expect(msg(p0001('invalid_input', { field }), save), field).toBe(`入力の形が違います（${label}）`);
  });

  it('conflict（details は id）は「ほかの人がこのお知らせを先に変えました。読み直しました」。振り分けの行の id の文言と分ける', () => {
    const N = '55555555-5555-4555-8555-555555555555';
    expect(msg(p0001('conflict', { id: N }), save)).toBe('ほかの人がこのお知らせを先に変えました。読み直しました');
    expect(msg(p0001('conflict', { id: N }), del)).toBe('ほかの人がこのお知らせを先に変えました。読み直しました');
    expect(msg(p0001('conflict', { id: N }), { rpc: 'save_allocation_rows' })).toBe('ほかの人が同じ振り分けの行を先に変えました。読み直しました');
    // 応答が届かなかった後に画面が作る conflict（id つき）も同じ文言
    expect(messageFor(appError('conflict', 'lock_conflict', { id: N }).info, save)).toBe('ほかの人がこのお知らせを先に変えました。読み直しました');
    expect(effectOf(classifyError(p0001('conflict', { id: N }))).reload).toBe('data');
  });

  it('not_found は「このお知らせは見つかりません（ほかの人が削除した可能性があります）」', () => {
    expect(msg(p0001('not_found'), save)).toBe('このお知らせは見つかりません（ほかの人が削除した可能性があります）');
    expect(msg(p0001('not_found'), del)).toBe('このお知らせは見つかりません（ほかの人が削除した可能性があります）');
    expect(messageFor(appError('not_found', 'notice_missing', { id: 'n' }).info, save)).toBe('このお知らせは見つかりません（ほかの人が削除した可能性があります）');
    // ほかの RPC は今のまま
    expect(msg(p0001('not_found'))).toBe('対象が見つかりません（ほかの人が消した可能性があります）');
  });

  it('forbidden・invalid_state は今の文言のまま（年度の行と立場を読み直す）', () => {
    expect(msg(p0001('forbidden'), save)).toBe('権限がありません。立場が変わった可能性があります');
    expect(msg(p0001('invalid_state', { status: 'closed' }), save)).toBe('年度が「終了」のため、この操作はできません');
    expect(effectOf(classifyError(p0001('invalid_state', { status: 'closed' }))).reload).toBe('year');
    expect(msg(pg('40P01'), save)).toBe('ほかの人の保存と重なりました。もう一度保存してください');
  });
});
