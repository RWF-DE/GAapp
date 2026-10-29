// @vitest-environment jsdom
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { INITIAL_ITEMS } from '@gaapp/shared';
import { repoRoot } from '@gaapp/shared/testing';
import { cleanup, render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import type { GroupRow, ItemRow, RequestDbRow, SubmissionRow } from '@/lib/db/types';
import type { RequestsTables } from '@/lib/data/requests';

vi.mock('@/lib/rpc', () => ({ callRpc: vi.fn() }));
vi.mock('@/components/common/app-link', () => ({
  AppLink: ({ href, children }: { href: string; children: React.ReactNode }) => <a href={href}>{children}</a>,
}));
vi.mock('sonner', () => ({ toast: { success: vi.fn(), error: vi.fn() } }));

const { callRpc } = await import('@/lib/rpc');
const { ImportDialog } = await import('./import-dialog');

// jsdom にないもの（Radix の Popover・Dialog と cmdk が使う）
beforeAll(() => {
  globalThis.ResizeObserver ??= class {
    observe() {}
    unobserve() {}
    disconnect() {}
  };
  Element.prototype.scrollIntoView ??= function scrollIntoView() {};
  Element.prototype.hasPointerCapture ??= () => false;
});
afterEach(() => cleanup());

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
const codeOf = (id: string) => ITEMS.find((i) => i.id === id)!.code;
const group = (n: number, name: string): GroupRow => ({
  id: uuid(n),
  year_id: uuid(1),
  name,
  display_name: null,
  aliases: [],
  category: 'stall',
  is_food: false,
  location_room_id: null,
  sort_order: n,
  updated_at: T0,
});
const KOU = group(11, '模擬店甲');
const OTSU = group(12, '模擬店乙');
const HEI = group(13, '模擬店丙');

const csvText = readFileSync(path.join(repoRoot(), 'fixtures', 'importer-samples', 'stall.csv'), 'utf8');
/** 画面の HTML（属性も含む）に出てはいけない、メールアドレスの形の文字列 */
const EMAIL = /[\w.+-]+@[\w-]+(\.[\w-]+)+/;

function renderDialog(t: Partial<RequestsTables> = {}) {
  const onImported = vi.fn();
  const onError = vi.fn(async () => 'エラー');
  const tables: RequestsTables = { groups: [KOU, OTSU, HEI], items: ITEMS, requests: [], submissions: [], ...t };
  render(<ImportDialog open onOpenChange={vi.fn()} tables={tables} onImported={onImported} onError={onError} />);
  return { onImported, onError };
}

async function upload(user: ReturnType<typeof userEvent.setup>) {
  const input = screen.getByLabelText('CSV ファイル');
  await user.upload(input, new File([csvText], 'stall.csv', { type: 'text/csv' }));
  await screen.findByTestId('import-counts');
}

// 戻り値を返さない（beforeEach が返す関数は後始末として呼ばれ、mockReset の戻り値＝callRpc そのものが呼ばれてしまう）
beforeEach(() => {
  vi.mocked(callRpc).mockReset();
});

describe('取り込みのダイアログ（stall.csv）', () => {
  it('対応しない行・古い回答・取り込まない行が出て、画面のどこにもメールアドレスの文字列が出ない', async () => {
    const user = userEvent.setup();
    renderDialog();
    await upload(user);
    expect(screen.getByTestId('import-counts').textContent).toContain('回答 5・対応した 3・対応しない 2・取り込まない 4');
    const unmatched = screen.getByTestId('import-unmatched');
    expect(within(unmatched).getByTestId('unmatched-row-8').textContent).toContain('存在しない団体');
    expect(within(unmatched).getByTestId('unmatched-row-9').textContent).toContain('（なし）');
    expect(screen.getByTestId('import-superseded').textContent).toContain('模擬店甲：行4（2026/10/06 09:00）を使い、行2（2026/10/05 18:01）は使いません');
    const rejected = screen.getByTestId('import-rejected').textContent;
    for (const t of ['行5：列のずれ', '行6：数が読めない', '行7：列のずれ', '行10：空の行']) expect(rejected).toContain(t);
    expect(screen.getByTestId('plan-模擬店甲')).toBeTruthy();
    // CSV には予約ドメインのメールが団体名・数・備考・見出しのない列に入っている
    expect(csvText).toMatch(EMAIL);
    expect(document.body.innerHTML).not.toMatch(EMAIL);
  });

  it('手で団体を選ぶと取り込む団体に入り、CSV にない品目は 0、申請できない品目は送らず、提出日時はフォームのタイムスタンプ', async () => {
    const user = userEvent.setup();
    const requests: RequestDbRow[] = [{ group_id: OTSU.id, item_id: itemId('lectern'), count: 5, updated_at: T0 }];
    const { onImported } = renderDialog({ requests });
    vi.mocked(callRpc).mockResolvedValue(undefined as never);
    await upload(user);

    await user.click(screen.getByRole('combobox', { name: '行8の団体' }));
    await user.click(await screen.findByRole('option', { name: '模擬店丙' }));
    await waitFor(() => expect(screen.getByTestId('import-counts').textContent).toContain('対応した 4・対応しない 1'));
    expect(screen.getByTestId('plan-模擬店丙')).toBeTruthy();
    expect(document.body.innerHTML).not.toMatch(EMAIL);

    await user.click(screen.getByRole('button', { name: '取り込む（3 団体）' }));
    await screen.findByTestId('import-results');
    expect(onImported).toHaveBeenCalledTimes(1);

    const calls = vi.mocked(callRpc).mock.calls;
    expect(calls.map((c) => c[0])).toEqual(Array(3).fill('update_requests_after_deadline'));
    const args = calls.map((c) => c[1] as unknown as {
      p_group_id: string;
      p_rows: { itemId: string; count: number; updatedAt?: string }[];
      p_reason: string;
      p_submission: { submittedAt: string; note: string | null };
    });
    expect(args.map((a) => a.p_group_id)).toEqual([KOU.id, OTSU.id, HEI.id]);
    // 理由の既定にファイル名を入れない（audit_logs に残り続けるため）
    expect(args[0]!.p_reason).toBe('Googleフォームの回答の取り込み（模擬店）');
    expect(args[0]!.p_reason).not.toContain('stall.csv');
    expect(args.map((a) => a.p_submission.submittedAt)).toEqual([
      '2026-10-06T09:00:00+09:00',
      '2026-10-05T19:30:00+09:00',
      '2026-10-06T11:00:00+09:00',
    ]);
    const otsu = Object.fromEntries(args[1]!.p_rows.map((r) => [codeOf(r.itemId), r]));
    expect(otsu.desk!.count).toBe(2);
    expect(otsu.lectern).toEqual({ itemId: itemId('lectern'), count: 0, updatedAt: T0 });
    expect(otsu.long_desk_2!.count).toBe(0);
    for (const a of args) {
      const codes = a.p_rows.map((r) => codeOf(r.itemId));
      // 申請できない品目（不可机・不可椅子、模擬店の長机(3人掛)）は送らない
      expect(codes).not.toContain('desk_ng');
      expect(codes).not.toContain('chair_ng');
      expect(codes).not.toContain('long_desk_3');
    }
    // 送る値にもメールを入れない（備考のメールは importer が除いた）
    expect(JSON.stringify(args)).not.toMatch(EMAIL);
    expect(document.body.innerHTML).not.toMatch(EMAIL);
  });

  it('Q2：アプリの提出の方が新しい団体は既定で上書きしない（選び直せる）', async () => {
    const user = userEvent.setup();
    const submissions: SubmissionRow[] = [{ group_id: KOU.id, submitted_at: '2026-10-07T00:00:00+09:00', note: null, updated_at: T0 }];
    renderDialog({ submissions });
    vi.mocked(callRpc).mockResolvedValue(undefined as never);
    await upload(user);
    const box = screen.getByRole('checkbox', { name: '模擬店甲を上書きする' });
    expect(box.getAttribute('data-state')).toBe('unchecked');
    expect(screen.getByTestId('plan-模擬店甲').textContent).toContain('アプリの提出の方が新しい');
    expect(screen.getByRole('button', { name: '取り込む（1 団体）' })).toBeTruthy();
    await user.click(box);
    await user.click(screen.getByRole('button', { name: '取り込む（2 団体）' }));
    await screen.findByTestId('import-results');
    expect(vi.mocked(callRpc).mock.calls.length).toBe(2);
  });

  it('団体ごとに成否を出す（conflict は取り込みの前に変わった旨）', async () => {
    const user = userEvent.setup();
    const { appError } = await import('@/lib/errors');
    renderDialog();
    vi.mocked(callRpc)
      .mockResolvedValueOnce(undefined as never)
      .mockRejectedValueOnce(appError('conflict', 'P0001', { item_id: itemId('desk') }));
    await upload(user);
    await user.click(screen.getByRole('button', { name: '取り込む（2 団体）' }));
    const results = await screen.findByTestId('import-results');
    expect(results.textContent).toContain('模擬店甲：取り込みました');
    expect(results.textContent).toContain('模擬店乙：取り込みの前に、ほかの人がこの団体の申請を変えました');
  });

  it('送った団体がすべて conflict でも申請一覧を読み直す（古い updatedAt で同じ conflict を繰り返さない）', async () => {
    const user = userEvent.setup();
    const { appError } = await import('@/lib/errors');
    const { onImported, onError } = renderDialog();
    vi.mocked(callRpc).mockImplementation(async () => {
      throw appError('conflict', 'P0001', { item_id: itemId('desk') });
    });
    await upload(user);
    await user.click(screen.getByRole('button', { name: '取り込む（2 団体）' }));
    const results = await screen.findByTestId('import-results');
    expect(results.textContent).toContain('模擬店甲：取り込みの前に、ほかの人がこの団体の申請を変えました');
    expect(results.textContent).toContain('模擬店乙：取り込みの前に、ほかの人がこの団体の申請を変えました');
    expect(onImported).toHaveBeenCalledTimes(1);
    // conflict の文言は取り込みのもの（onError の文言で置き換えない）
    expect(onError).not.toHaveBeenCalled();
  });

  it('送った団体がすべて通信の失敗でも申請一覧を読み直す（保存されたか分からないため）', async () => {
    const user = userEvent.setup();
    const { appError } = await import('@/lib/errors');
    const { onImported } = renderDialog();
    vi.mocked(callRpc).mockImplementation(async () => {
      throw appError('network', 'fetch_failed');
    });
    await upload(user);
    await user.click(screen.getByRole('button', { name: '取り込む（2 団体）' }));
    await screen.findByTestId('import-results');
    expect(onImported).toHaveBeenCalledTimes(1);
  });

  it('見出しが合わない CSV はその旨だけを出す', async () => {
    const user = userEvent.setup();
    renderDialog();
    await user.upload(screen.getByLabelText('CSV ファイル'), new File(['a,b\nx@example.test,1\n'], 'x.csv', { type: 'text/csv' }));
    expect((await screen.findByRole('alert')).textContent).toContain('タイムスタンプの列が見つかりません');
    expect(document.body.innerHTML).not.toMatch(EMAIL);
  });

  it('プレビューは取り込んだ後の数を出す：申請できない品目（blocked）は今の DB の数のまま。同じ時刻は「取り込み済み」。長い備考は印をつけ、2000 字に切って送る', async () => {
    const user = userEvent.setup();
    const items = ITEMS.map((i) => (i.code === 'desk_ng' ? { ...i, aliases: ['不可机'] } : i));
    const dept: GroupRow = { ...group(21, '部門甲'), category: 'department' };
    const requests: RequestDbRow[] = [{ group_id: dept.id, item_id: itemId('desk_ng'), count: 3, updated_at: T0 }];
    const submissions: SubmissionRow[] = [{ group_id: dept.id, submitted_at: '2026-10-05T01:00:00+00:00', note: null, updated_at: T0 }];
    renderDialog({ groups: [dept], items, requests, submissions });
    vi.mocked(callRpc).mockResolvedValue(undefined as never);
    await user.click(screen.getByRole('radio', { name: '部門' }));
    const csv = `タイムスタンプ,団体名,机(木),不可机,備考\n2026/10/05 10:00:00,部門甲,1,4,${'あ'.repeat(2001)}\n`;
    await user.upload(screen.getByLabelText('CSV ファイル'), new File([csv], '部門.csv', { type: 'text/csv' }));
    const plan = await screen.findByTestId('plan-部門甲');
    expect(plan.textContent).toContain('同じ時刻（取り込み済み）');
    expect(plan.textContent).not.toContain('アプリの提出の方が新しい');
    const ng = screen.getByTestId('plan-cell-部門甲-desk_ng');
    expect(ng.textContent).toContain('3');
    expect(ng.textContent).toContain('変えない');
    expect(ng.textContent).not.toContain('今');
    expect(screen.getByTestId('note-too-long-部門甲').textContent).toContain('2001 字');

    await user.click(screen.getByRole('checkbox', { name: '部門甲を上書きする' }));
    await user.click(screen.getByRole('button', { name: '取り込む（1 団体）' }));
    const results = await screen.findByTestId('import-results');
    expect(results.textContent).toContain('部門甲：取り込みました（備考は 2000 字に切りました）');
    const sent = vi.mocked(callRpc).mock.calls[0]![1] as unknown as { p_submission: { note: string }; p_reason: string };
    expect(sent.p_submission.note).toHaveLength(2000);
    expect(sent.p_reason).toBe('Googleフォームの回答の取り込み（部門）');
  });
});
