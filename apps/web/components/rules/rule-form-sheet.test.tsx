// @vitest-environment jsdom
import { fixturePath, readFixtureDir } from '@gaapp/shared/testing';
import { cleanup, render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, beforeAll, describe, expect, it, vi } from 'vitest';
import { ruleToForm, type RulesData, type RuleWrite } from '@/lib/data/rules';
import type { RuleDbRow, YearRow } from '@/lib/db/types';
import { appError, unknownOutcomeMessage } from '@/lib/errors';
import { NOTE_MAX } from '@/lib/schemas/common';
import { FIXTURE_UPDATED_AT, fixtureToTables } from '@/lib/testing/fixture-rows';
import { RuleFormSheet, type RuleFormSheetProps, type RuleSheetTarget, type SaveOutcome } from './rule-form-sheet';
import {
  DUPLICATE_CODE_MESSAGE,
  REREAD_AGAIN_FAILED_MESSAGE,
  REREAD_FAILED_MESSAGE,
  REREAD_NOT_SAVED_MESSAGE,
  runRuleWrite,
  type RuleReread,
  type RuleWriteDeps,
} from './rule-write';

// ルールのシートの「変更がなければ送らずに閉じる」分かれ道と、保存の失敗の後（conflict・2.6 の (B1)）の扱い（T12）。保存は onInsert・onUpdate の差し替えで見る。
const toast = vi.hoisted(() => ({ info: vi.fn(), error: vi.fn(), success: vi.fn() }));
vi.mock('sonner', () => ({ toast }));

// jsdom にないもの（Radix の Sheet・Popover と cmdk が使う）
beforeAll(() => {
  globalThis.ResizeObserver ??= class {
    observe() {}
    unobserve() {}
    disconnect() {}
  };
  Element.prototype.scrollIntoView ??= function scrollIntoView() {};
});

afterEach(() => {
  cleanup();
  vi.clearAllMocks();
});

const r8like = readFixtureDir(fixturePath('synthetic', 'r8like'));

function data(rules?: RuleDbRow[]): RulesData {
  const t = structuredClone(fixtureToTables(r8like));
  const year: YearRow = {
    id: t.groups[0]!.year_id,
    label: 'R8',
    status: 'allocating',
    allocation_version: 1,
    auto_allocated_at: null,
    festival_start: '2026-10-17',
    request_open_at: null,
    request_close_at: null,
    prev_year_id: null,
    updated_at: FIXTURE_UPDATED_AT,
  };
  return { year, rules: rules ?? t.rules, items: t.items, rooms: t.rooms, groups: t.groups, roomYears: t.roomYears };
}

const base = data();
const s05 = base.rules.find((r) => r.code === 'S05')!;
const editS05: RuleSheetTarget = { type: 'edit', ruleId: s05.id, initial: ruleToForm(s05), baseUpdatedAt: s05.updated_at };

type UpdateMock = ReturnType<typeof vi.fn<RuleFormSheetProps['onUpdate']>>;
type InsertMock = ReturnType<typeof vi.fn<RuleFormSheetProps['onInsert']>>;

function setup(
  opts: {
    editMode?: RuleFormSheetProps['editMode'];
    onUpdate?: UpdateMock;
    onInsert?: InsertMock;
    target?: RuleSheetTarget;
    canEditGroups?: boolean;
  } = {},
) {
  const onUpdate: UpdateMock = opts.onUpdate ?? vi.fn<RuleFormSheetProps['onUpdate']>(async () => ({ ok: true }) satisfies SaveOutcome);
  const onClose = vi.fn();
  const props: RuleFormSheetProps = {
    target: opts.target ?? editS05,
    onClose,
    data: base,
    editMode: opts.editMode ?? 'full',
    onInsert: opts.onInsert ?? vi.fn(async () => ({ ok: true }) satisfies SaveOutcome),
    onUpdate,
    onReload: vi.fn(),
    canEditGroups: opts.canEditGroups ?? true,
  };
  const view = render(<RuleFormSheet {...props} />);
  return { onUpdate, onClose, view, props };
}

const memoBox = () => screen.getByLabelText(/^メモ/);
const saveButton = () => screen.getByRole('button', { name: '保存' });
/** 止められた後に読み直せなかった結果（runRuleWrite の unread）。reread はその後の「読み直す」 */
const unreadOutcome = (reread: RuleReread): SaveOutcome => ({
  ok: false,
  error: appError('conflict', 'lock_conflict', { table: 'rules' }),
  notice: REREAD_FAILED_MESSAGE,
  showReload: true,
  reread,
});

describe('RuleFormSheet：メモだけ（確定中・終了）', () => {
  it('何も変えずに保存すると update を送らず、「変更はありません」で閉じる', async () => {
    const user = userEvent.setup();
    const { onUpdate, onClose } = setup({ editMode: 'memo' });
    expect(screen.getByRole('heading', { name: 'ルール S05 のメモを直す' })).toBeTruthy();
    await user.click(saveButton());
    expect(onUpdate).not.toHaveBeenCalled();
    expect(toast.info).toHaveBeenCalledWith('変更はありません');
    expect(onClose).toHaveBeenCalledTimes(1);
  });

  it('メモを変えて戻したときも送らない。変えたままなら memo だけを開いたときの版で送る', async () => {
    const user = userEvent.setup();
    const { onUpdate, onClose, view } = setup({ editMode: 'memo' });
    const before = (memoBox() as HTMLTextAreaElement).value;
    await user.type(memoBox(), '。');
    await user.clear(memoBox());
    if (before) await user.type(memoBox(), before);
    await user.click(saveButton());
    expect(onUpdate).not.toHaveBeenCalled();
    expect(onClose).toHaveBeenCalledTimes(1);

    // 開き直して変えると、memo だけを送る
    view.unmount();
    const again = setup({ editMode: 'memo' });
    await user.clear(memoBox());
    await user.type(memoBox(), '来年は 3-1 も候補');
    await user.click(saveButton());
    expect(again.onUpdate).toHaveBeenCalledTimes(1);
    const [rule, patch] = again.onUpdate.mock.calls[0]!;
    expect(rule.updated_at).toBe(s05.updated_at);
    expect(patch).toEqual({ memo: '来年は 3-1 も候補' });
  });
});

describe('RuleFormSheet：conflict の後', () => {
  it('読み直した行と違う入力は、開いたときの値と同じでも、読み直した行の版で送る', async () => {
    const user = userEvent.setup();
    const original = s05.memo ?? '';
    const reloadedAt = '2026-10-29T01:00:00.000000+00:00';
    const other: RuleDbRow = { ...s05, memo: 'ほかの人のメモ', updated_at: reloadedAt };
    // 1回目：メモを変えて保存すると conflict（ほかの人がメモを直していた。runRuleWrite が読み直した行は rebase）
    const onUpdate = vi
      .fn<RuleFormSheetProps['onUpdate']>()
      .mockResolvedValueOnce({ ok: false, error: appError('conflict', 'lock_conflict', { table: 'rules' }), rebase: other })
      .mockResolvedValue({ ok: true });
    const { view, props } = setup({ onUpdate });
    await user.clear(memoBox());
    await user.type(memoBox(), 'わたしのメモ');
    await user.click(saveButton());
    await waitFor(() => expect(screen.getByTestId('error-banner')).toBeTruthy());
    expect(onUpdate).toHaveBeenCalledTimes(1);

    // 読み直した一覧も来る：ほかの人のメモと新しい版
    const reloaded = data(base.rules.map((r) => (r.id === s05.id ? other : r)));
    view.rerender(<RuleFormSheet {...props} data={reloaded} />);

    // 入力を開いたときの値に戻す（読み直した行の「ほかの人のメモ」とは違う）→ 送る（黙って閉じない）
    await user.clear(memoBox());
    if (original) await user.type(memoBox(), original);
    await user.click(saveButton());
    await waitFor(() => expect(onUpdate).toHaveBeenCalledTimes(2));
    const [rule, patch] = onUpdate.mock.calls[1]!;
    expect(rule.updated_at).toBe(reloadedAt);
    expect(patch.memo).toBe(original === '' ? null : original);
    expect(toast.info).not.toHaveBeenCalled();
  });

  it('conflict の後、読み直した行を入力の元にしていない（rebase がない）間は、一覧が読み直されなくても、開いたときの値に戻した入力を送る（黙って閉じない）', async () => {
    const user = userEvent.setup();
    const original = s05.memo ?? '';
    const onUpdate = vi
      .fn<RuleFormSheetProps['onUpdate']>()
      .mockResolvedValueOnce({ ok: false, error: appError('conflict', 'lock_conflict', { table: 'rules' }) })
      .mockResolvedValue({ ok: true });
    const { onClose } = setup({ onUpdate });
    await user.clear(memoBox());
    await user.type(memoBox(), 'わたしのメモ');
    await user.click(saveButton());
    await waitFor(() => expect(screen.getByTestId('error-banner')).toBeTruthy());

    // 一覧の読み直しは届かない（data は開いたときのまま）。入力を開いたときの値に戻して保存する
    await user.clear(memoBox());
    if (original) await user.type(memoBox(), original);
    await user.click(saveButton());
    // 送る（今の版で conflict がもう一度返れば、そのときに読み直す）。「変更はありません」で閉じない
    await waitFor(() => expect(onUpdate).toHaveBeenCalledTimes(2));
    const [rule, patch] = onUpdate.mock.calls[1]!;
    expect(rule.updated_at).toBe(s05.updated_at);
    expect(patch.memo).toBe(original === '' ? null : original);
    expect(toast.info).not.toHaveBeenCalled();
    expect(onClose).toHaveBeenCalledTimes(1);
  });

  it('conflict の後、入力が読み直した行と同じなら送らずに閉じる', async () => {
    const user = userEvent.setup();
    const reloadedAt = '2026-10-29T01:00:00.000000+00:00';
    const other: RuleDbRow = { ...s05, memo: 'ほかの人のメモ', updated_at: reloadedAt };
    const onUpdate = vi
      .fn<RuleFormSheetProps['onUpdate']>()
      .mockResolvedValueOnce({ ok: false, error: appError('conflict', 'lock_conflict', { table: 'rules' }), rebase: other })
      .mockResolvedValue({ ok: true });
    const { view, props, onClose } = setup({ onUpdate });
    await user.clear(memoBox());
    await user.type(memoBox(), 'ほかの人のメモ');
    await user.click(saveButton());
    await waitFor(() => expect(screen.getByTestId('error-banner')).toBeTruthy());

    const reloaded = data(base.rules.map((r) => (r.id === s05.id ? other : r)));
    view.rerender(<RuleFormSheet {...props} data={reloaded} />);
    await user.click(saveButton());
    expect(onUpdate).toHaveBeenCalledTimes(1);
    expect(toast.info).toHaveBeenCalledWith('変更はありません');
    expect(onClose).toHaveBeenCalledTimes(1);
  });
});

describe('RuleFormSheet：応答が届かなかった・止められた後（2.6 の (B1)）', () => {
  it('止められた後に読み直した行（rebase）があれば、一覧の読み直しを待たずにその版で次の保存を送る', async () => {
    const user = userEvent.setup();
    const reloadedAt = '2026-10-29T01:00:00.000000+00:00';
    const other: RuleDbRow = { ...s05, memo: 'ほかの人のメモ', updated_at: reloadedAt };
    const onUpdate = vi
      .fn<RuleFormSheetProps['onUpdate']>()
      .mockResolvedValueOnce({ ok: false, error: appError('conflict', 'lock_conflict', { table: 'rules' }), rebase: other })
      .mockResolvedValue({ ok: true });
    setup({ onUpdate });
    await user.clear(memoBox());
    await user.type(memoBox(), 'わたしのメモ');
    await user.click(saveButton());
    await waitFor(() => expect(screen.getByTestId('error-banner')).toBeTruthy());
    await user.click(saveButton());
    await waitFor(() => expect(onUpdate).toHaveBeenCalledTimes(2));
    expect(onUpdate.mock.calls[1]![0].updated_at).toBe(reloadedAt);
    expect(onUpdate.mock.calls[1]![1].memo).toBe('わたしのメモ');
  });

  it('保存できたか分からない：文言だけを出し（確かめる・読み直すのボタンはない）、保存は押せるまま。次の保存は同じ版でふつうに送る', async () => {
    const user = userEvent.setup();
    const onUpdate = vi
      .fn<RuleFormSheetProps['onUpdate']>()
      .mockResolvedValueOnce({ ok: false, error: new TypeError('Failed to fetch'), notice: unknownOutcomeMessage() })
      .mockResolvedValue({ ok: true });
    const { onClose } = setup({ onUpdate });
    await user.clear(memoBox());
    await user.type(memoBox(), 'わたしのメモ');
    await user.click(saveButton());
    const notice = await screen.findByTestId('unknown-outcome');
    expect(notice.textContent).toContain('保存できたか分かりません。もう一度「保存」を押すと、確かめてから送ります');
    expect(screen.queryByRole('button', { name: '読み直す' })).toBeNull();
    expect(screen.queryByRole('button', { name: '確かめる' })).toBeNull();
    expect((saveButton() as HTMLButtonElement).disabled).toBe(false);
    expect((memoBox() as HTMLTextAreaElement).value).toBe('わたしのメモ');

    await user.click(saveButton());
    await waitFor(() => expect(onUpdate).toHaveBeenCalledTimes(2));
    expect(onUpdate.mock.calls[1]![0].updated_at).toBe(s05.updated_at);
    expect(onClose).toHaveBeenCalledTimes(1);
  });

  it('保存できたか分からない後、開いたときの値に戻して保存しても送る（前の送信が通っていれば DB が conflict で止める。「変更はありません」で閉じない）', async () => {
    const user = userEvent.setup();
    const original = s05.memo ?? '';
    const onUpdate = vi
      .fn<RuleFormSheetProps['onUpdate']>()
      .mockResolvedValueOnce({ ok: false, error: new TypeError('Failed to fetch'), notice: unknownOutcomeMessage() })
      .mockResolvedValue({ ok: true });
    const { onClose } = setup({ onUpdate });
    await user.clear(memoBox());
    await user.type(memoBox(), 'わたしのメモ');
    await user.click(saveButton());
    await screen.findByTestId('unknown-outcome');

    await user.clear(memoBox());
    if (original) await user.type(memoBox(), original);
    await user.click(saveButton());
    await waitFor(() => expect(onUpdate).toHaveBeenCalledTimes(2));
    const [rule, patch] = onUpdate.mock.calls[1]!;
    expect(rule.updated_at).toBe(s05.updated_at);
    expect(patch.memo).toBe(original === '' ? null : original);
    expect(toast.info).not.toHaveBeenCalled();
    expect(onClose).toHaveBeenCalledTimes(1);
  });

  it('保存できたか分からない後、メモの長さ超えで一度止まっても、開いたときの値に戻した保存は送る（メモだけ）', async () => {
    const user = userEvent.setup();
    const original = s05.memo ?? '';
    const onUpdate = vi
      .fn<RuleFormSheetProps['onUpdate']>()
      .mockResolvedValueOnce({ ok: false, error: new TypeError('Failed to fetch'), notice: unknownOutcomeMessage() })
      .mockResolvedValue({ ok: true });
    const { onClose } = setup({ editMode: 'memo', onUpdate });
    await user.clear(memoBox());
    await user.type(memoBox(), 'わたしのメモ');
    await user.click(saveButton());
    await screen.findByTestId('unknown-outcome');

    await user.clear(memoBox());
    await user.click(memoBox());
    await user.paste('あ'.repeat(NOTE_MAX + 1));
    await user.click(saveButton());
    await screen.findByText(`メモは ${NOTE_MAX} 字までです`);
    expect(onUpdate).toHaveBeenCalledTimes(1);

    await user.clear(memoBox());
    if (original) await user.type(memoBox(), original);
    await user.click(saveButton());
    await waitFor(() => expect(onUpdate).toHaveBeenCalledTimes(2));
    expect(onUpdate.mock.calls[1]![1].memo).toBe(original === '' ? null : original);
    expect(toast.info).not.toHaveBeenCalled();
    expect(onClose).toHaveBeenCalledTimes(1);
  });

  it('保存できたか分からない後、コードを空にして欄のエラーで一度止まっても、開いたときの値に戻した保存は送る', async () => {
    const user = userEvent.setup();
    const original = s05.memo ?? '';
    const onUpdate = vi
      .fn<RuleFormSheetProps['onUpdate']>()
      .mockResolvedValueOnce({ ok: false, error: new TypeError('Failed to fetch'), notice: unknownOutcomeMessage() })
      .mockResolvedValue({ ok: true });
    const { onClose } = setup({ onUpdate });
    await user.clear(memoBox());
    await user.type(memoBox(), 'わたしのメモ');
    await user.click(saveButton());
    await screen.findByTestId('unknown-outcome');

    const codeBox = screen.getByLabelText('コード');
    await user.clear(codeBox);
    await user.click(saveButton());
    await waitFor(() => expect(codeBox.getAttribute('aria-invalid')).toBe('true'));
    expect(onUpdate).toHaveBeenCalledTimes(1);

    await user.type(codeBox, s05.code);
    await user.clear(memoBox());
    if (original) await user.type(memoBox(), original);
    await user.click(saveButton());
    await waitFor(() => expect(onUpdate).toHaveBeenCalledTimes(2));
    const [rule, patch] = onUpdate.mock.calls[1]!;
    expect(rule.updated_at).toBe(s05.updated_at);
    expect(patch.code).toBe(s05.code);
    expect(patch.memo).toBe(original === '' ? null : original);
    expect(toast.info).not.toHaveBeenCalled();
    expect(onClose).toHaveBeenCalledTimes(1);
  });

  it('止められた後に読み直せなかった：「読み直しました」と言わず、読み直すボタンを出す。「読み直す」はその行を読み直し（押したときの入力を渡す）、まだ読めなければ知らせて知らせと「読み直す」を残す（一覧の読み直しではない）。開いたときの値に戻しても送る', async () => {
    const user = userEvent.setup();
    const reread = vi.fn<RuleReread>(async () => null);
    const onUpdate = vi
      .fn<RuleFormSheetProps['onUpdate']>()
      .mockResolvedValueOnce(unreadOutcome(reread))
      .mockResolvedValue({ ok: true });
    const { props } = setup({ onUpdate });
    const original = (memoBox() as HTMLTextAreaElement).value;
    await user.type(memoBox(), '。');
    await user.click(saveButton());
    const notice = await screen.findByTestId('unknown-outcome');
    expect(notice.textContent).toContain(REREAD_FAILED_MESSAGE);
    expect(notice.textContent).not.toContain('読み直しました');
    await user.click(screen.getByRole('button', { name: '読み直す' }));
    await waitFor(() => expect(toast.error).toHaveBeenCalledWith(REREAD_AGAIN_FAILED_MESSAGE));
    expect(reread).toHaveBeenCalledTimes(1);
    expect(reread.mock.calls[0]![0]).toMatchObject({ code: s05.code, memo: `${original}。` });
    expect(props.onReload).not.toHaveBeenCalled();
    expect(screen.getByTestId('unknown-outcome').textContent).toContain(REREAD_FAILED_MESSAGE);
    expect(screen.getByRole('button', { name: '読み直す' })).toBeTruthy();

    await user.clear(memoBox());
    if (original) await user.type(memoBox(), original);
    await user.click(saveButton());
    await waitFor(() => expect(onUpdate).toHaveBeenCalledTimes(2));
    expect(onUpdate.mock.calls[1]![0].updated_at).toBe(s05.updated_at);
    expect(toast.info).not.toHaveBeenCalled();
  });

  it('止められた後に読み直せなかった後の「読み直す」：読めて変わっていれば conflict の知らせにして版を進め（読み直した行を入力の元に）、次の1回の保存で上書きできる', async () => {
    const user = userEvent.setup();
    const reloadedAt = '2026-10-29T01:00:00.000000+00:00';
    const other: RuleDbRow = { ...s05, memo: 'ほかの人のメモ', updated_at: reloadedAt };
    const reread = vi.fn<RuleReread>(async () => ({ ok: false, error: appError('conflict', 'lock_conflict', { table: 'rules' }), rebase: other }));
    const onUpdate = vi
      .fn<RuleFormSheetProps['onUpdate']>()
      .mockResolvedValueOnce(unreadOutcome(reread))
      .mockResolvedValue({ ok: true });
    const { onClose } = setup({ onUpdate });
    await user.clear(memoBox());
    await user.type(memoBox(), 'わたしのメモ');
    await user.click(saveButton());
    await screen.findByTestId('unknown-outcome');
    await user.click(screen.getByRole('button', { name: '読み直す' }));
    await waitFor(() => expect(screen.getByTestId('error-banner')).toBeTruthy());
    expect(screen.queryByTestId('unknown-outcome')).toBeNull();
    expect((memoBox() as HTMLTextAreaElement).value).toBe('わたしのメモ');
    expect(onUpdate).toHaveBeenCalledTimes(1);
    await user.click(saveButton());
    await waitFor(() => expect(onUpdate).toHaveBeenCalledTimes(2));
    expect(onUpdate.mock.calls[1]![0].updated_at).toBe(reloadedAt);
    expect(onUpdate.mock.calls[1]![1].memo).toBe('わたしのメモ');
    expect(onClose).toHaveBeenCalledTimes(1);
  });

  it('止められた後に読み直せなかった後の「読み直す」：行がなくなっていれば「このルールは見つかりません」で「保存」を押せなくし、入力と同じなら（保存されていました）閉じる', async () => {
    const user = userEvent.setup();
    const gone = vi.fn<RuleReread>(async () => ({ ok: false, error: appError('not_found', 'lock_missing', { table: 'rules' }), rebase: null }));
    const onUpdate = vi.fn<RuleFormSheetProps['onUpdate']>().mockResolvedValueOnce(unreadOutcome(gone));
    const first = setup({ onUpdate });
    await user.type(memoBox(), '。');
    await user.click(saveButton());
    await screen.findByTestId('unknown-outcome');
    await user.click(screen.getByRole('button', { name: '読み直す' }));
    expect(await screen.findByText('このルールは見つかりません（ほかの人が消した可能性があります）。閉じて読み直してください。')).toBeTruthy();
    expect((saveButton() as HTMLButtonElement).disabled).toBe(true);
    await user.click(saveButton());
    expect(onUpdate).toHaveBeenCalledTimes(1);
    first.view.unmount();

    const saved = vi.fn<RuleReread>(async () => ({ ok: true }));
    const second = setup({ onUpdate: vi.fn<RuleFormSheetProps['onUpdate']>().mockResolvedValueOnce(unreadOutcome(saved)) });
    await user.type(memoBox(), '。');
    await user.click(saveButton());
    await screen.findByTestId('unknown-outcome');
    await user.click(screen.getByRole('button', { name: '読み直す' }));
    await waitFor(() => expect(second.onClose).toHaveBeenCalledTimes(1));
    expect(second.onUpdate).toHaveBeenCalledTimes(1);
  });

  it('「読み直す」で読んでいる間は、欄・「保存」「閉じる」・「読み直す」を押せない（届いた行を、押したときの入力と比べる）', async () => {
    const user = userEvent.setup();
    let release!: (out: SaveOutcome | null) => void;
    const reread = vi.fn<RuleReread>(
      () =>
        new Promise<SaveOutcome | null>((resolve) => {
          release = resolve;
        }),
    );
    const onUpdate = vi.fn<RuleFormSheetProps['onUpdate']>().mockResolvedValueOnce(unreadOutcome(reread));
    setup({ onUpdate });
    await user.type(memoBox(), '。');
    await user.click(saveButton());
    await screen.findByTestId('unknown-outcome');
    await user.click(screen.getByRole('button', { name: '読み直す' }));
    const busyButton = await screen.findByRole('button', { name: '読み直しています…' });
    expect((busyButton as HTMLButtonElement).disabled).toBe(true);
    expect((memoBox() as HTMLTextAreaElement).disabled).toBe(true);
    expect((screen.getByLabelText('コード') as HTMLInputElement).disabled).toBe(true);
    expect((saveButton() as HTMLButtonElement).disabled).toBe(true);
    expect((screen.getByRole('button', { name: '閉じる' }) as HTMLButtonElement).disabled).toBe(true);
    release(null);
    expect(await screen.findByRole('button', { name: '読み直す' })).toBeTruthy();
    expect((memoBox() as HTMLTextAreaElement).disabled).toBe(false);
    expect((saveButton() as HTMLButtonElement).disabled).toBe(false);
  });

  // 次の2件は本物の runRuleWrite を通し、「読み直す」の判定（rule-write.ts の rereadRejectedRuleWrite）からシートの出し方までを見る
  // （FU2 のレビューの F1：押したときの入力に当たらない重複・衝突を出さない）
  const writeDeps = (): RuleWriteDeps => ({
    afterSaved: vi.fn(async () => undefined),
    onAuthError: vi.fn(async () => 'other' as const),
    onReload: vi.fn(),
    reloadMembership: vi.fn(),
  });
  /** 一意のキーの重複（supabase-js の error の形） */
  const duplicateKey = () => ({ code: '23505', message: 'duplicate key value violates unique constraint', details: '', hint: null });
  /** 応答が届かなかった（fetch の失敗） */
  const offline = () => new TypeError('Failed to fetch');

  it('追加：止められた（23505）後に読み直せず、コードを変えてから「読み直す」：押したときのコードで読み直し、その行がなければ重複とは言わず、知らせを消して「まだ保存されていません」と知らせる。次の保存は新しいコードで送る', async () => {
    const user = userEvent.setup();
    // 1回目は止められた後の読み直し（S09。通信で失敗）、2回目は「読み直す」（S10 の行はない）
    const reread = vi.fn<(code: string) => Promise<RuleDbRow | null>>().mockRejectedValueOnce(offline()).mockResolvedValueOnce(null);
    const send = vi.fn<(row: RuleWrite) => Promise<unknown>>().mockRejectedValueOnce(duplicateKey()).mockResolvedValue(undefined);
    const deps = writeDeps();
    const onInsert = vi.fn<RuleFormSheetProps['onInsert']>((row) =>
      runRuleWrite(
        {
          mode: 'insert',
          send: () => send(row),
          reread: (code = row.code) => reread(code),
          input: row,
          baseVersion: null,
          okMessage: `ルール ${row.code} を追加しました`,
        },
        deps,
      ),
    );
    // 無効のまま追加する（ほかの有効なルールとの重なりを見ない）
    const { onClose } = setup({ target: { type: 'new', initial: { ...ruleToForm(s05), code: 'S09', enabled: false } }, onInsert });
    await user.click(saveButton());
    expect((await screen.findByTestId('unknown-outcome')).textContent).toContain(REREAD_FAILED_MESSAGE);
    expect(reread).toHaveBeenLastCalledWith('S09');

    const codeBox = screen.getByLabelText('コード');
    await user.clear(codeBox);
    await user.type(codeBox, 'S10');
    await user.click(screen.getByRole('button', { name: '読み直す' }));
    await waitFor(() => expect(toast.info).toHaveBeenCalledWith(REREAD_NOT_SAVED_MESSAGE));
    expect(REREAD_NOT_SAVED_MESSAGE).toBe('読み直しました。まだ保存されていません（もう一度「保存」を押してください）');
    expect(reread).toHaveBeenLastCalledWith('S10');
    expect(screen.queryByTestId('unknown-outcome')).toBeNull();
    expect(screen.queryByText(DUPLICATE_CODE_MESSAGE)).toBeNull();
    expect(codeBox.getAttribute('aria-invalid')).toBeNull();
    expect(deps.onReload).toHaveBeenCalledTimes(1);

    await user.click(saveButton());
    await waitFor(() => expect(onClose).toHaveBeenCalledTimes(1));
    expect(send).toHaveBeenCalledTimes(2);
    expect(send.mock.calls[1]![0].code).toBe('S10');
  });

  it('更新：ほかのルールのコードに変えて止められ（23505）、読み直せなかった後の「読み直す」：その行の版が入力の元のまま（誰も変えていない）なら、衝突とは言わず知らせを消して「まだ保存されていません」と知らせ、版は進めない', async () => {
    const user = userEvent.setup();
    // 1回目は止められた後の読み直し（通信で失敗）、2回目は「読み直す」（開いたときのままの行）
    const reread = vi.fn<() => Promise<RuleDbRow | null>>().mockRejectedValueOnce(offline()).mockResolvedValueOnce(s05);
    const send = vi
      .fn<(rule: RuleDbRow, patch: Partial<RuleWrite>) => Promise<unknown>>()
      .mockRejectedValueOnce(duplicateKey())
      .mockResolvedValue(undefined);
    const onUpdate = vi.fn<RuleFormSheetProps['onUpdate']>((rule, patch) =>
      runRuleWrite(
        {
          mode: 'update',
          send: () => send(rule, patch),
          reread: () => reread(),
          input: patch,
          baseVersion: rule.updated_at,
          okMessage: `ルール ${patch.code ?? rule.code} を保存しました`,
        },
        writeDeps(),
      ),
    );
    const { onClose } = setup({ onUpdate });
    // 一覧を読んだ後に、ほかの人が S99 のルールを足した（一覧にはないので、画面の確かめは通る）
    const codeBox = screen.getByLabelText('コード');
    await user.clear(codeBox);
    await user.type(codeBox, 'S99');
    await user.click(saveButton());
    expect((await screen.findByTestId('unknown-outcome')).textContent).toContain(REREAD_FAILED_MESSAGE);
    await user.click(screen.getByRole('button', { name: '読み直す' }));
    await waitFor(() => expect(toast.info).toHaveBeenCalledWith(REREAD_NOT_SAVED_MESSAGE));
    expect(screen.queryByTestId('unknown-outcome')).toBeNull();
    expect(screen.queryByTestId('error-banner')).toBeNull();

    await user.click(saveButton());
    await waitFor(() => expect(onClose).toHaveBeenCalledTimes(1));
    expect(send).toHaveBeenCalledTimes(2);
    // 版は進めていない（開いたときの版で送る）
    expect(send.mock.calls[1]![0].updated_at).toBe(s05.updated_at);
    expect(send.mock.calls[1]![1].code).toBe('S99');
  });

  it('止められた後に読み直せなかった（unread）ときは、一覧が新しい版を持っていても版を進めない。次の保存も開いたときの版で送る（DB が conflict で止め、読み直して決める）', async () => {
    const user = userEvent.setup();
    const reloadedAt = '2026-10-29T01:00:00.000000+00:00';
    const other: RuleDbRow = { ...s05, memo: 'ほかの人のメモ', updated_at: reloadedAt };
    const reloaded = data(base.rules.map((r) => (r.id === s05.id ? other : r)));
    // 「読み直す」でもまだ読めない（その行の読み直しが通信で失敗する）
    const unread: SaveOutcome = unreadOutcome(async () => null);
    const onUpdate = vi
      .fn<RuleFormSheetProps['onUpdate']>()
      .mockResolvedValueOnce(unread)
      .mockResolvedValueOnce(unread)
      .mockResolvedValueOnce({ ok: false, error: appError('conflict', 'lock_conflict', { table: 'rules' }), rebase: other })
      .mockResolvedValue({ ok: true });
    const { view, props } = setup({ onUpdate });
    // シートを開いた後に、裏の読み直しで一覧がほかの人の変更（新しい版）を持った（入力の元は開いたときの版のまま）
    view.rerender(<RuleFormSheet {...props} data={reloaded} />);
    await user.clear(memoBox());
    await user.type(memoBox(), 'わたしのメモ');
    await user.click(saveButton());
    await screen.findByTestId('unknown-outcome');

    // unread の後：一覧の行（利用者が見ていない版）に進めず、開いたときの版で送る
    await user.click(saveButton());
    await waitFor(() => expect(onUpdate).toHaveBeenCalledTimes(2));
    expect(onUpdate.mock.calls[1]![0].updated_at).toBe(s05.updated_at);

    // 「読み直す」でまだ読めないときも、一覧が来ても同じ（版を進めるのは、その行を読み直した結果〔保存か「読み直す」〕が changed のときだけ）
    await screen.findByTestId('unknown-outcome');
    await user.click(screen.getByRole('button', { name: '読み直す' }));
    await waitFor(() => expect(toast.error).toHaveBeenCalledWith(REREAD_AGAIN_FAILED_MESSAGE));
    view.rerender(<RuleFormSheet {...props} data={data(base.rules.map((r) => (r.id === s05.id ? other : r)))} />);
    await user.click(saveButton());
    await waitFor(() => expect(onUpdate).toHaveBeenCalledTimes(3));
    expect(onUpdate.mock.calls[2]![0].updated_at).toBe(s05.updated_at);

    // changed（読み直した行あり）の後は、その行の版で送る（ほかの人の変更を見た後の意図した上書き）
    await waitFor(() => expect(screen.getByTestId('error-banner')).toBeTruthy());
    await user.click(saveButton());
    await waitFor(() => expect(onUpdate).toHaveBeenCalledTimes(4));
    expect(onUpdate.mock.calls[3]![0].updated_at).toBe(reloadedAt);
    expect(onUpdate.mock.calls[3]![1].memo).toBe('わたしのメモ');
  });

  it('止められた後に読み直せなかった後、欄のエラーで一度止まっても、開いたときの値に戻した保存は送る', async () => {
    const user = userEvent.setup();
    const original = s05.memo ?? '';
    const onUpdate = vi
      .fn<RuleFormSheetProps['onUpdate']>()
      .mockResolvedValueOnce(unreadOutcome(async () => null))
      .mockResolvedValue({ ok: true });
    const { onClose } = setup({ onUpdate });
    await user.clear(memoBox());
    await user.type(memoBox(), 'わたしのメモ');
    await user.click(saveButton());
    await screen.findByTestId('unknown-outcome');

    const codeBox = screen.getByLabelText('コード');
    await user.clear(codeBox);
    await user.click(saveButton());
    await waitFor(() => expect(codeBox.getAttribute('aria-invalid')).toBe('true'));
    expect(onUpdate).toHaveBeenCalledTimes(1);

    await user.type(codeBox, s05.code);
    await user.clear(memoBox());
    if (original) await user.type(memoBox(), original);
    await user.click(saveButton());
    await waitFor(() => expect(onUpdate).toHaveBeenCalledTimes(2));
    expect(onUpdate.mock.calls[1]![0].updated_at).toBe(s05.updated_at);
    expect(toast.info).not.toHaveBeenCalled();
    expect(onClose).toHaveBeenCalledTimes(1);
  });

  it('conflict（読み直した行あり）の後、欄のエラーで一度止まっても、開いたときの値に戻した保存は読み直した行の版で送る', async () => {
    const user = userEvent.setup();
    const original = s05.memo ?? '';
    const reloadedAt = '2026-10-29T01:00:00.000000+00:00';
    const other: RuleDbRow = { ...s05, memo: 'ほかの人のメモ', updated_at: reloadedAt };
    const onUpdate = vi
      .fn<RuleFormSheetProps['onUpdate']>()
      .mockResolvedValueOnce({ ok: false, error: appError('conflict', 'lock_conflict', { table: 'rules' }), rebase: other })
      .mockResolvedValue({ ok: true });
    const { onClose } = setup({ onUpdate });
    await user.clear(memoBox());
    await user.type(memoBox(), 'わたしのメモ');
    await user.click(saveButton());
    await waitFor(() => expect(screen.getByTestId('error-banner')).toBeTruthy());

    const codeBox = screen.getByLabelText('コード');
    await user.clear(codeBox);
    await user.click(saveButton());
    await waitFor(() => expect(codeBox.getAttribute('aria-invalid')).toBe('true'));
    expect(onUpdate).toHaveBeenCalledTimes(1);

    await user.type(codeBox, s05.code);
    await user.clear(memoBox());
    if (original) await user.type(memoBox(), original);
    await user.click(saveButton());
    await waitFor(() => expect(onUpdate).toHaveBeenCalledTimes(2));
    expect(onUpdate.mock.calls[1]![0].updated_at).toBe(reloadedAt);
    expect(onUpdate.mock.calls[1]![1].memo).toBe(original === '' ? null : original);
    expect(toast.info).not.toHaveBeenCalled();
    expect(onClose).toHaveBeenCalledTimes(1);
  });
});

describe('RuleFormSheet：「残す」の団体に使用場所がないときの案内（団体はマスタ。T15b・D-50）', () => {
  const s08 = base.rules.find((r) => r.code === 'S08')!;
  // 使用場所のない団体（校内に分散）を選んだ「残す」のルール
  const scattered = base.groups.find((g) => g.location_room_id === null)!;
  const form = ruleToForm(s08);
  const target: RuleSheetTarget = { type: 'edit', ruleId: s08.id, initial: { ...form, keep: { ...form.keep, group: scattered.id } }, baseUpdatedAt: s08.updated_at };
  const notice = () => document.querySelector('[data-field-notice="params.room"]')?.textContent;

  it('管理者：マスタ設定で団体の使用場所を決める', () => {
    setup({ target, canEditGroups: true });
    expect(notice()).toBe('この団体には使用場所がありません。「残す」は団体の使用場所にしか使えないので、マスタ設定で団体の使用場所を決めてください');
  });

  it('総務部門長・総務副部門長（団体を直せない）：管理者に団体の使用場所の登録を頼む', () => {
    setup({ target, canEditGroups: false });
    expect(notice()).toBe(
      'この団体には使用場所がありません。「残す」は団体の使用場所にしか使えないので、管理者に団体の使用場所の登録を頼んでください',
    );
  });
});
