// @vitest-environment jsdom
import type { StoredAllocationRow } from '@gaapp/shared';
import { fixturePath, readFixtureDir } from '@gaapp/shared/testing';
import { cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { PendingChange } from '@/lib/allocation/pending';
import { itemTabs } from '@/lib/allocation/tabs';
import { unusableChecklist } from '@/lib/allocation/unusable';
import { buildViewModel, type ViewModel } from '@/lib/allocation/view-model';
import { toStoredRows } from '@/lib/data/year-data';
import { fixtureSnapshot } from '@/lib/testing/fixture-rows';
import { ItemTabView } from './item-tab-view';
import { PendingBar, PendingNotices } from './pending-bar';
import { UnusableDialog } from './row-dialogs';
import { RowEditProvider, type RowEditApi } from './row-edit';
import type { PendingApi } from './use-pending';

afterEach(cleanup);

const fx = readFixtureDir(fixturePath('synthetic', 'r8like'));
const snap = fixtureSnapshot(fx);
const base = buildViewModel(snap);
const desk = base.items.find((i) => i.code === 'desk')!;
const rooms = base.rooms.filter((r) => r.isStorage && (base.stock.get(`${r.id}|${desk.id}`) ?? 0) > 0);
const usableRoom = rooms[0]!;
const unusableRoom = rooms[1]!;
// 2つ目の部屋を使用不可にした見え方
const vm: ViewModel = {
  ...base,
  rooms: base.rooms.map((r) => (r.id === unusableRoom.id ? { ...r, usable: false } : r)),
  roomById: new Map(base.rooms.map((r) => [r.id, r.id === unusableRoom.id ? { ...r, usable: false } : r])),
};
const group = base.groups.find((g) => g.category === 'stall')!;
const tab = itemTabs(base.items).find((t) => t.key === 'desk')!;

const row = (id: string, p: Partial<StoredAllocationRow>): StoredAllocationRow => ({
  id,
  sourceRoomId: usableRoom.id,
  groupId: group.id,
  itemId: desk.id,
  requestedItemId: desk.id,
  count: 3,
  isKeep: false,
  origin: 'auto',
  pinned: false,
  note: null,
  ...p,
});
const rows = [
  row('00000000-0000-4000-8000-000000000001', { pinned: true }),
  row('00000000-0000-4000-8000-000000000002', { sourceRoomId: unusableRoom.id, pinned: true }),
  row('00000000-0000-4000-8000-000000000003', { sourceRoomId: unusableRoom.id, origin: 'manual' }),
];

function editApi(p: Partial<RowEditApi> = {}): RowEditApi {
  return {
    vm,
    rows,
    pendingIds: new Set(),
    isUsable: (id) => vm.roomById.get(id)?.usable ?? true,
    edit: vi.fn(),
    revert: vi.fn(),
    openSource: vi.fn(),
    requestDelete: vi.fn(),
    openUnusable: vi.fn(),
    openUsable: vi.fn(),
    ...p,
  };
}

describe('品目タブの行の操作（管理者・振り分け中）', () => {
  it('使用可の部屋の行は数・備考・固定・運び元・削除。使用不可の部屋の行は運び元の変更と削除だけ（「固定を外す」は出さない）', () => {
    const api = editApi();
    render(
      <RowEditProvider value={api}>
        <ItemTabView vm={vm} rows={rows} tab={tab} />
      </RowEditProvider>,
    );
    const ok = document.querySelector<HTMLElement>(`[data-row-id="${rows[0]!.id}"]`)!;
    expect(within(ok).getByRole('button', { name: '固定を外す' })).toBeTruthy();
    expect(within(ok).getByRole('button', { name: /を1増やす$/ })).toBeTruthy();
    expect(within(ok).getByRole('button', { name: '備考' })).toBeTruthy();
    fireEvent.click(within(ok).getByRole('button', { name: /を1増やす$/ }));
    expect(api.edit).toHaveBeenCalledWith({ op: 'update', id: rows[0]!.id, patch: { count: 4 } });
    fireEvent.click(within(ok).getByRole('button', { name: '固定を外す' }));
    expect(api.edit).toHaveBeenCalledWith({ op: 'update', id: rows[0]!.id, patch: { pinned: false } });

    for (const r of rows.slice(1)) {
      const el = document.querySelector<HTMLElement>(`[data-row-id="${r.id}"]`)!;
      expect(within(el).queryByRole('button', { name: '固定を外す' })).toBeNull();
      expect(within(el).queryByRole('button', { name: '固定する' })).toBeNull();
      expect(within(el).queryByRole('button', { name: /を1増やす$/ })).toBeNull();
      expect(within(el).queryByRole('button', { name: '備考' })).toBeNull();
      fireEvent.click(within(el).getByRole('button', { name: /運び元を変える$/ }));
      expect(api.openSource).toHaveBeenLastCalledWith(r.id);
      fireEvent.click(within(el).getByRole('button', { name: /を削除$/ }));
      expect(api.requestDelete).toHaveBeenLastCalledWith(r.id);
    }
    expect(screen.getAllByTestId('unusable-row-note')[0]!.textContent).toMatch(/固定を外すには、先に部屋を使用可に戻します/);
  });

  it('読み取り（編集の context がない）では操作を出さない', () => {
    render(<ItemTabView vm={vm} rows={rows} tab={tab} />);
    expect(screen.queryByRole('button', { name: /運び元を変える$/ })).toBeNull();
    expect(screen.queryByRole('button', { name: /のメニュー$/ })).toBeNull();
  });
});

function pendingApi(p: Partial<PendingApi> = {}): PendingApi {
  const change: PendingChange = { op: 'update', id: rows[0]!.id, updatedAt: 'x', patch: { count: 5 } };
  return {
    pending: [change, { op: 'delete', id: rows[1]!.id, updatedAt: 'x' }],
    rows,
    stored: toStoredRows({ allocations: [] }),
    edit: vi.fn(),
    revert: vi.fn(),
    discardAll: vi.fn(),
    save: vi.fn(async () => {}),
    saving: false,
    saveBlock: null,
    notice: null,
    dismissNotice: vi.fn(),
    dropped: [],
    dismissDropped: vi.fn(),
    recheck: vi.fn(async () => {}),
    resolvePartial: vi.fn(),
    draft: null,
    ...p,
  };
}

describe('未保存の変更のバー', () => {
  it('件数と内訳を出し、保存は理由（必須）を入れてから送る', async () => {
    const api = pendingApi();
    render(<PendingBar api={api} vm={vm} />);
    const bar = screen.getByTestId('pending-bar');
    expect(bar.textContent).toContain('未保存の変更 2 件');
    expect(bar.textContent).toContain('追加 0・変更 1・削除 1');
    fireEvent.click(within(bar).getByRole('button', { name: '保存…' }));
    const dialog = await screen.findByRole('dialog');
    fireEvent.click(within(dialog).getByRole('button', { name: '保存する' }));
    expect(await within(dialog).findByText('理由を入れてください')).toBeTruthy();
    expect(api.save).not.toHaveBeenCalled();
    fireEvent.click(within(dialog).getByRole('button', { name: '団体の希望' }));
    fireEvent.click(within(dialog).getByRole('button', { name: '保存する' }));
    await waitFor(() => expect(api.save).toHaveBeenCalledWith('団体の希望'));
  });

  it('確かめるまで（saveBlock）保存を押せない。送信中も押せない', () => {
    const { rerender } = render(<PendingBar api={pendingApi({ saveBlock: '保存できたか確かめるまで、もう一度保存できません' })} vm={vm} />);
    expect((screen.getByRole('button', { name: '保存…' }) as HTMLButtonElement).disabled).toBe(true);
    rerender(<PendingBar api={pendingApi({ saving: true })} vm={vm} />);
    expect((screen.getByRole('button', { name: '保存中…' }) as HTMLButtonElement).disabled).toBe(true);
  });

  it('変更がなければ出さない', () => {
    render(<PendingBar api={pendingApi({ pending: [] })} vm={vm} />);
    expect(screen.queryByTestId('pending-bar')).toBeNull();
  });

  it('確かめられないときは「確かめる」、外した変更は一覧で出す', () => {
    const api = pendingApi({
      notice: { kind: 'unverified', pending: [], heldVersion: 1, before: toStoredRows({ allocations: [] }) },
      dropped: [{ change: { op: 'delete', id: rows[2]!.id, updatedAt: 'x' }, reason: 'gone' }],
    });
    render(<PendingNotices api={api} vm={vm} onReload={() => {}} />);
    fireEvent.click(within(screen.getByTestId('rows-unverified')).getByRole('button', { name: '確かめる' }));
    expect(api.recheck).toHaveBeenCalled();
    const dropped = screen.getByTestId('rows-dropped');
    expect(dropped.textContent).toContain('ほかの人の変更とぶつかったので外しました');
    expect(dropped.textContent).toContain('（行が消えていました）');
  });
});

describe('使用不可にする前の一覧のダイアログ', () => {
  const inRoom = [row('00000000-0000-4000-8000-000000000011', { pinned: true }), row('00000000-0000-4000-8000-000000000012', { origin: 'manual' })];

  it('固定の自動の行は「固定を外す」も、手動の行は運び元の変更と削除だけ。一覧が空で未保存の変更がないまで押せない', () => {
    const onOp = vi.fn();
    const props = { roomId: usableRoom.id, vm, busy: false, onOpenChange: () => {}, onOp, onConfirm: vi.fn(async () => {}) };
    const { rerender } = render(<UnusableDialog {...props} checklist={unusableChecklist(inRoom, usableRoom.id)} pendingCount={0} />);
    const dialog = screen.getByRole('dialog');
    const auto = dialog.querySelector<HTMLElement>(`[data-row-id="${inRoom[0]!.id}"]`)!;
    const manual = dialog.querySelector<HTMLElement>(`[data-row-id="${inRoom[1]!.id}"]`)!;
    expect(within(auto).getAllByRole('button').map((b) => b.textContent)).toEqual(['固定を外す', '運び元を変える', '削除']);
    expect(within(manual).getAllByRole('button').map((b) => b.textContent)).toEqual(['運び元を変える', '削除']);
    fireEvent.click(within(auto).getByRole('button', { name: '固定を外す' }));
    expect(onOp).toHaveBeenCalledWith('unpin', inRoom[0]!.id);
    expect((within(dialog).getByRole('button', { name: '使用不可にする' }) as HTMLButtonElement).disabled).toBe(true);
    expect(screen.getByTestId('unusable-blocker').textContent).toBe('先に一覧の行を直して保存してください');

    rerender(<UnusableDialog {...props} checklist={[]} pendingCount={2} />);
    expect((screen.getByRole('button', { name: '使用不可にする' }) as HTMLButtonElement).disabled).toBe(true);
    rerender(<UnusableDialog {...props} checklist={[]} pendingCount={0} />);
    const go = screen.getByRole('button', { name: '使用不可にする' }) as HTMLButtonElement;
    expect(go.disabled).toBe(false);
    fireEvent.click(go);
    expect(props.onConfirm).toHaveBeenCalledWith(null);
  });
  it('保存できたか確かめられない間は、知らせと「確かめる」を出し、理由のメモを残したまま「使用不可にする」を押せない', () => {
    const onCheck = vi.fn();
    const props = { roomId: usableRoom.id, vm, busy: false, onOpenChange: () => {}, onOp: vi.fn(), onConfirm: vi.fn(async () => {}), checklist: [], pendingCount: 0 };
    const { rerender } = render(<UnusableDialog {...props} />);
    const note = screen.getByLabelText('理由のメモ（任意）');
    fireEvent.change(note, { target: { value: '工事' } });
    const message = '保存できたか確かめられません。通信が戻ったら『確かめる』を押してください';
    rerender(<UnusableDialog {...props} check={{ message, onCheck }} />);
    const notice = screen.getByTestId('room-usable-check');
    expect(notice.textContent).toContain(message);
    expect((screen.getByRole('button', { name: '使用不可にする' }) as HTMLButtonElement).disabled).toBe(true);
    expect((screen.getByLabelText('理由のメモ（任意）') as HTMLTextAreaElement).value).toBe('工事');
    fireEvent.click(within(notice).getByRole('button', { name: '確かめる' }));
    expect(onCheck).toHaveBeenCalled();
    // 確かめ終われば押せる（メモはそのまま）
    rerender(<UnusableDialog {...props} check={null} />);
    expect(screen.queryByTestId('room-usable-check')).toBeNull();
    fireEvent.click(screen.getByRole('button', { name: '使用不可にする' }));
    expect(props.onConfirm).toHaveBeenCalledWith('工事');
  });
});
