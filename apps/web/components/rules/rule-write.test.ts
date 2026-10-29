import { fixturePath, readFixtureDir } from '@gaapp/shared/testing';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { RuleWrite } from '@/lib/data/rules';
import type { RuleDbRow } from '@/lib/db/types';
import { appError, classifyError, messageFor, unknownOutcomeMessage } from '@/lib/errors';
import { fixtureToTables } from '@/lib/testing/fixture-rows';
import {
  DISABLE_NOTICES,
  DUPLICATE_CODE_MESSAGE,
  REREAD_FAILED_MESSAGE,
  SAVED_BEFORE_MESSAGE,
  runRuleWrite,
  TOGGLE_NOTICES,
  toggleFailureMessage,
  type RuleWriteRequest,
  type SaveOutcome,
} from './rule-write';

// ルールの書き込みの分かれ道（画面の設計 2.6 の (B1)。T12）。送信・読み直し・後始末は差し替えて見る。
const toast = vi.hoisted(() => ({ info: vi.fn(), error: vi.fn(), success: vi.fn() }));
vi.mock('sonner', () => ({ toast }));

afterEach(() => {
  vi.clearAllMocks();
});

const r8like = readFixtureDir(fixturePath('synthetic', 'r8like'));
const s05: RuleDbRow = fixtureToTables(r8like).rules.find((r) => r.code === 'S05')!;
const T0 = s05.updated_at;
const T1 = '2026-10-29T01:00:00.000000+00:00';

// supabase-js の error の形
const pg = (code: string, message = '') => ({ code, message, details: '', hint: null });
/** 応答が届かなかった（fetch の失敗） */
const network = () => new TypeError('Failed to fetch');

function deps() {
  return {
    afterSaved: vi.fn(async () => undefined),
    onAuthError: vi.fn(async (e: unknown) => (classifyError(e).kind === 'auth' ? ('retry' as const) : ('other' as const))),
    onReload: vi.fn(),
    reloadMembership: vi.fn(),
  };
}

const memoPatch: Partial<RuleWrite> = { memo: 'わたしのメモ' };
const row = (patch: Partial<RuleDbRow>): RuleDbRow => ({ ...s05, ...patch });

function update(send: () => Promise<unknown>, reread: () => Promise<RuleDbRow | null>): RuleWriteRequest {
  return { mode: 'update', send, reread, input: memoPatch, baseVersion: T0, okMessage: 'ルール S05 を保存しました' };
}

const insertInput: RuleWrite = { code: 'S09', kind: s05.kind, params: s05.params, enabled: true, memo: null } as RuleWrite;
function insert(send: () => Promise<unknown>, reread: () => Promise<RuleDbRow | null>): RuleWriteRequest {
  return { mode: 'insert', send, reread, input: insertInput, baseVersion: null, okMessage: 'ルール S09 を追加しました' };
}

const failed = (out: SaveOutcome) => {
  if (out.ok) throw new Error('成功した');
  return out;
};

describe('runRuleWrite：成功と 401', () => {
  it('成功：読み直さず、関係するクエリを読み直して okMessage', async () => {
    const d = deps();
    const reread = vi.fn(async () => null);
    const out = await runRuleWrite(update(async () => undefined, reread), d);
    expect(out).toEqual({ ok: true });
    expect(reread).not.toHaveBeenCalled();
    expect(d.afterSaved).toHaveBeenCalledTimes(1);
    expect(toast.success).toHaveBeenCalledWith('ルール S05 を保存しました');
  });

  it('401：セッションを更新して1回だけ送り直す', async () => {
    const d = deps();
    const send = vi.fn().mockRejectedValueOnce({ code: 'PGRST303', message: 'JWT expired', status: 401 }).mockResolvedValue(undefined);
    const out = await runRuleWrite(update(send, async () => null), d);
    expect(out.ok).toBe(true);
    expect(send).toHaveBeenCalledTimes(2);
  });
});

describe('runRuleWrite：応答が届かなかった（isUnknownOutcome）', () => {
  it('読み直した行が入力と同じ → 「保存されていました」（成功と同じ）', async () => {
    const d = deps();
    const out = await runRuleWrite(
      update(
        () => Promise.reject(network()),
        async () => row({ memo: 'わたしのメモ', updated_at: T1 }),
      ),
      d,
    );
    expect(out).toEqual({ ok: true });
    expect(d.afterSaved).toHaveBeenCalledTimes(1);
    expect(toast.success).toHaveBeenCalledWith(SAVED_BEFORE_MESSAGE);
  });

  it('版が入力の元のまま（not-saved）→ unknownOutcomeMessage()。読み直すボタンも一覧の読み直しもない', async () => {
    const d = deps();
    const out = failed(await runRuleWrite(update(() => Promise.reject(network()), async () => row({})), d));
    expect(out.notice).toBe(unknownOutcomeMessage());
    expect(out.notice).toBe('保存できたか分かりません。もう一度「保存」を押すと、確かめてから送ります');
    expect(out.showReload).toBeUndefined();
    expect(out.rebase).toBeUndefined();
    expect(d.onReload).not.toHaveBeenCalled();
  });

  it('読み直せない（unread）→ unknownOutcomeMessage()', async () => {
    const d = deps();
    const out = failed(await runRuleWrite(update(() => Promise.reject(network()), () => Promise.reject(network())), d));
    expect(out.notice).toBe(unknownOutcomeMessage());
    expect(out.showReload).toBeUndefined();
  });

  it('更新：版が進み入力と違う（changed）→ conflict の扱い（一覧を読み直し、読み直した行を入力の元にする）', async () => {
    const d = deps();
    const other = row({ memo: 'ほかの人のメモ', updated_at: T1 });
    const out = failed(await runRuleWrite(update(() => Promise.reject(network()), async () => other), d));
    expect(classifyError(out.error).kind).toBe('conflict');
    expect(messageFor(classifyError(out.error))).toBe('他の人が先に変更しました。読み直しました');
    expect(out.rebase).toBe(other);
    expect(out.notice).toBeUndefined();
    expect(d.onReload).toHaveBeenCalledTimes(1);
  });

  it('更新：行がなくなっていた → not_found（すでに消えていました）', async () => {
    const d = deps();
    const out = failed(await runRuleWrite(update(() => Promise.reject(network()), async () => null), d));
    expect(classifyError(out.error)).toMatchObject({ kind: 'not_found', reason: 'lock_missing' });
    expect(out.rebase).toBeNull();
    expect(d.onReload).toHaveBeenCalledTimes(1);
  });

  it('追加：同じコードの行がない（not-saved）→ unknownOutcomeMessage()', async () => {
    const d = deps();
    const out = failed(await runRuleWrite(insert(() => Promise.reject(network()), async () => null), d));
    expect(out.notice).toBe(unknownOutcomeMessage());
  });

  it('追加：同じコードの違う行ができていた（changed）→ コードの欄に「同じコードのルールがあります」', async () => {
    const d = deps();
    const out = failed(
      await runRuleWrite(
        insert(
          () => Promise.reject(network()),
          async () => row({ code: 'S09', memo: 'ほかの人', updated_at: T1 }),
        ),
        d,
      ),
    );
    expect(out.fieldErrors).toEqual({ code: [DUPLICATE_CODE_MESSAGE] });
    expect(d.onReload).toHaveBeenCalledTimes(1);
  });

  it('追加：同じ値の行ができていた → 「保存されていました」', async () => {
    const d = deps();
    const out = await runRuleWrite(
      insert(
        () => Promise.reject(network()),
        async () => row({ ...insertInput, updated_at: T1 }),
      ),
      d,
    );
    expect(out.ok).toBe(true);
    expect(toast.success).toHaveBeenCalledWith(SAVED_BEFORE_MESSAGE);
  });

  it('コードつきで返った失敗（57014）は届いた失敗：読み直さない', async () => {
    const d = deps();
    const reread = vi.fn(async () => null);
    const out = failed(await runRuleWrite(update(() => Promise.reject(pg('57014', 'canceling statement')), reread), d));
    expect(reread).not.toHaveBeenCalled();
    expect(out.notice).toBeUndefined();
  });
});

describe('runRuleWrite：conflict・not_found・23505 で止められた（isLockRejection）', () => {
  const conflict = () => appError('conflict', 'lock_conflict', { table: 'rules' });

  it('読み直した行が入力と同じ → 「保存されていました」（自分の前の送信が後から通っていた）', async () => {
    const d = deps();
    const out = await runRuleWrite(
      update(
        () => Promise.reject(conflict()),
        async () => row({ memo: 'わたしのメモ', updated_at: T1 }),
      ),
      d,
    );
    expect(out.ok).toBe(true);
    expect(toast.success).toHaveBeenCalledWith(SAVED_BEFORE_MESSAGE);
  });

  it('入力と違う（changed）→ 今の conflict の文言と、読み直した行', async () => {
    const d = deps();
    const err = conflict();
    const other = row({ memo: 'ほかの人のメモ', updated_at: T1 });
    const out = failed(await runRuleWrite(update(() => Promise.reject(err), async () => other), d));
    expect(out.error).toBe(err);
    expect(out.rebase).toBe(other);
    expect(d.onReload).toHaveBeenCalledTimes(1);
  });

  it('読み直せない（unread）→ 入力を残し、「読み直しました」とは言わず、読み直すボタン', async () => {
    const d = deps();
    const out = failed(await runRuleWrite(update(() => Promise.reject(conflict()), () => Promise.reject(network())), d));
    expect(out.notice).toBe(REREAD_FAILED_MESSAGE);
    expect(out.notice).not.toContain('読み直しました');
    expect(out.showReload).toBe(true);
    expect(out.rebase).toBeUndefined();
    expect(toggleFailureMessage(out, () => '使わない')).toBe(REREAD_FAILED_MESSAGE);
  });

  it('追加の 23505：同じ値なら「保存されていました」、違えばコードの欄に「同じコードのルールがあります」', async () => {
    const d = deps();
    const same = await runRuleWrite(insert(() => Promise.reject(pg('23505', 'duplicate key')), async () => row({ ...insertInput, updated_at: T1 })), d);
    expect(same.ok).toBe(true);
    const diff = failed(
      await runRuleWrite(
        insert(
          () => Promise.reject(pg('23505', 'duplicate key')),
          async () => row({ code: 'S09', memo: 'ほかの人', updated_at: T1 }),
        ),
        d,
      ),
    );
    expect(diff.fieldErrors).toEqual({ code: [DUPLICATE_CODE_MESSAGE] });
  });

  it('更新の 23505（ほかのルールのコードに変えた）→ コードの欄。入力の元は進めない', async () => {
    const d = deps();
    const out = failed(
      await runRuleWrite(
        {
          mode: 'update',
          send: () => Promise.reject(pg('23505', 'duplicate key')),
          reread: async () => row({}),
          input: { code: 'S06' },
          baseVersion: T0,
          okMessage: '',
        },
        d,
      ),
    );
    expect(out.fieldErrors).toEqual({ code: [DUPLICATE_CODE_MESSAGE] });
    expect(out.rebase).toBeUndefined();
  });
});

describe('runRuleWrite：ほかの失敗', () => {
  it('forbidden（lock_unchanged）は読み直さず、年度の行と立場を読み直す', async () => {
    const d = deps();
    const reread = vi.fn(async () => null);
    const out = failed(await runRuleWrite(update(() => Promise.reject(appError('forbidden', 'lock_unchanged', { table: 'rules' })), reread), d));
    expect(reread).not.toHaveBeenCalled();
    expect(d.onReload).toHaveBeenCalledTimes(1);
    expect(d.reloadMembership).toHaveBeenCalledTimes(1);
    expect(classifyError(out.error).kind).toBe('forbidden');
  });
});

describe('runRuleWrite：一覧の切り替えと「無効にする」のダイアログの文言（「保存」のボタンはない）', () => {
  const lockConflict = () => appError('conflict', 'lock_conflict', { table: 'rules' });
  const toggle = (send: () => Promise<unknown>, reread: () => Promise<RuleDbRow | null>, notices = TOGGLE_NOTICES): RuleWriteRequest => ({
    mode: 'update',
    send,
    reread,
    // 切り替えは有効にする（Switch）。無効にする（ダイアログ）は enabled: false とメモ
    input: notices === DISABLE_NOTICES ? { enabled: false, memo: '使わなくなった' } : { enabled: true },
    baseVersion: T0,
    okMessage: 'ルール S05 を有効にしました',
    notices,
  });

  it('切り替え：保存できたか分からない（not-saved・unread）→「切り替えられたか分かりません…」（「保存」と言わない）', async () => {
    for (const reread of [async () => row({ enabled: false }), () => Promise.reject(network())]) {
      const out = failed(await runRuleWrite(toggle(() => Promise.reject(network()), reread), deps()));
      expect(out.notice).toBe('切り替えられたか分かりません。もう一度切り替えると、確かめてから送ります');
      expect(toggleFailureMessage(out, () => '使わない')).toBe(out.notice);
      expect(out.notice).not.toContain('保存');
    }
  });

  it('切り替え：止められた後に読み直せなかった → 「もう一度切り替えてください」と読み直す', async () => {
    const out = failed(await runRuleWrite(toggle(() => Promise.reject(lockConflict()), () => Promise.reject(network())), deps()));
    expect(out.notice).toBe(TOGGLE_NOTICES.rereadFailed);
    expect(out.notice).not.toContain('保存');
    expect(out.showReload).toBe(true);
  });

  it('無効にする：保存できたか分からない →「無効にできたか分かりません。もう一度「無効にする」を押すと…」。読み直せなかった →「無効にする」を押して', async () => {
    const unknown = failed(await runRuleWrite(toggle(() => Promise.reject(network()), async () => row({}), DISABLE_NOTICES), deps()));
    expect(unknown.notice).toBe('無効にできたか分かりません。もう一度「無効にする」を押すと、確かめてから送ります');
    const unread = failed(
      await runRuleWrite(toggle(() => Promise.reject(lockConflict()), () => Promise.reject(network()), DISABLE_NOTICES), deps()),
    );
    expect(unread.notice).toBe(DISABLE_NOTICES.rereadFailed);
    expect(unread.notice).toContain('「無効にする」');
    expect(unread.notice).not.toContain('保存');
    expect(unread.showReload).toBe(true);
  });
});
