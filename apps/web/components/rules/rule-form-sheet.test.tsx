// @vitest-environment jsdom
import { fixturePath, readFixtureDir } from '@gaapp/shared/testing';
import { cleanup, render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, beforeAll, describe, expect, it, vi } from 'vitest';
import { ruleToForm, type RulesData } from '@/lib/data/rules';
import type { RuleDbRow, YearRow } from '@/lib/db/types';
import { appError } from '@/lib/errors';
import { FIXTURE_UPDATED_AT, fixtureToTables } from '@/lib/testing/fixture-rows';
import { RuleFormSheet, type RuleFormSheetProps, type RuleSheetTarget, type SaveOutcome } from './rule-form-sheet';

// ルールのシートの「変更がなければ送らずに閉じる」分かれ道（T12）。保存は onInsert・onUpdate の差し替えで見る。
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
