// @vitest-environment jsdom
import { fixturePath, readFixtureDir } from '@gaapp/shared/testing';
import { cleanup, render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, beforeAll, describe, expect, it, vi } from 'vitest';
import { ruleToForm, type RulesData } from '@/lib/data/rules';
import type { RuleDbRow, YearRow } from '@/lib/db/types';
import { appError, unknownOutcomeMessage } from '@/lib/errors';
import { NOTE_MAX } from '@/lib/schemas/common';
import { FIXTURE_UPDATED_AT, fixtureToTables } from '@/lib/testing/fixture-rows';
import { RuleFormSheet, type RuleFormSheetProps, type RuleSheetTarget, type SaveOutcome } from './rule-form-sheet';

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

function setup(opts: { editMode?: RuleFormSheetProps['editMode']; onUpdate?: UpdateMock } = {}) {
  const onUpdate: UpdateMock = opts.onUpdate ?? vi.fn<RuleFormSheetProps['onUpdate']>(async () => ({ ok: true }) satisfies SaveOutcome);
  const onClose = vi.fn();
  const props: RuleFormSheetProps = {
    target: editS05,
    onClose,
    data: base,
    editMode: opts.editMode ?? 'full',
    onInsert: vi.fn(async () => ({ ok: true }) satisfies SaveOutcome),
    onUpdate,
    onReload: vi.fn(),
  };
  const view = render(<RuleFormSheet {...props} />);
  return { onUpdate, onClose, view, props };
}

const memoBox = () => screen.getByLabelText(/^メモ/);
const saveButton = () => screen.getByRole('button', { name: '保存' });

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
    // 1回目：メモを変えて保存すると conflict（ほかの人がメモを直していた）
    const onUpdate = vi
      .fn<RuleFormSheetProps['onUpdate']>()
      .mockResolvedValueOnce({ ok: false, error: appError('conflict', 'lock_conflict', { table: 'rules' }) })
      .mockResolvedValue({ ok: true });
    const { view, props } = setup({ onUpdate });
    await user.clear(memoBox());
    await user.type(memoBox(), 'わたしのメモ');
    await user.click(saveButton());
    await waitFor(() => expect(screen.getByTestId('error-banner')).toBeTruthy());
    expect(onUpdate).toHaveBeenCalledTimes(1);

    // 読み直した一覧が来る：ほかの人のメモと新しい版
    const reloadedAt = '2026-10-29T01:00:00.000000+00:00';
    const reloaded = data(base.rules.map((r) => (r.id === s05.id ? { ...r, memo: 'ほかの人のメモ', updated_at: reloadedAt } : r)));
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

  it('conflict の後、読み直した行がまだ来ない（読み直しの失敗も）間は、開いたときの値に戻した入力も送る（黙って閉じない）', async () => {
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
    const onUpdate = vi
      .fn<RuleFormSheetProps['onUpdate']>()
      .mockResolvedValueOnce({ ok: false, error: appError('conflict', 'lock_conflict', { table: 'rules' }) })
      .mockResolvedValue({ ok: true });
    const { view, props, onClose } = setup({ onUpdate });
    await user.clear(memoBox());
    await user.type(memoBox(), 'ほかの人のメモ');
    await user.click(saveButton());
    await waitFor(() => expect(screen.getByTestId('error-banner')).toBeTruthy());

    const reloadedAt = '2026-10-29T01:00:00.000000+00:00';
    const reloaded = data(base.rules.map((r) => (r.id === s05.id ? { ...r, memo: 'ほかの人のメモ', updated_at: reloadedAt } : r)));
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

  it('止められた後に読み直せなかった：「読み直しました」と言わず、読み直すボタンを出す。開いたときの値に戻しても送る', async () => {
    const user = userEvent.setup();
    const onUpdate = vi
      .fn<RuleFormSheetProps['onUpdate']>()
      .mockResolvedValueOnce({
        ok: false,
        error: appError('conflict', 'lock_conflict', { table: 'rules' }),
        notice: 'ほかの人が先に変えた可能性がありますが、読み直せませんでした',
        showReload: true,
      })
      .mockResolvedValue({ ok: true });
    const { props } = setup({ onUpdate });
    const original = (memoBox() as HTMLTextAreaElement).value;
    await user.type(memoBox(), '。');
    await user.click(saveButton());
    const notice = await screen.findByTestId('unknown-outcome');
    expect(notice.textContent).not.toContain('読み直しました');
    await user.click(screen.getByRole('button', { name: '読み直す' }));
    expect(props.onReload).toHaveBeenCalledTimes(1);

    await user.clear(memoBox());
    if (original) await user.type(memoBox(), original);
    await user.click(saveButton());
    await waitFor(() => expect(onUpdate).toHaveBeenCalledTimes(2));
    expect(toast.info).not.toHaveBeenCalled();
  });
});
