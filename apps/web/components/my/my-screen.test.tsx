// @vitest-environment jsdom
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { act, cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { MembershipState } from '@/lib/auth/auth-provider';
import type { MyConsent, MyData } from '@/lib/data/my';
import { appError } from '@/lib/errors';
import { ConsentCard, WAIT_REASK } from './my-screen';

const h = vi.hoisted(() => ({
  membership: { status: 'idle' } as MembershipState,
  answerConsent: vi.fn(),
}));
vi.mock('@/lib/auth/auth-provider', () => ({ useAuth: () => ({ membership: h.membership, reloadMembership: vi.fn() }) }));
vi.mock('@/lib/data/my', async (orig) => ({ ...(await orig<typeof import('@/lib/data/my')>()), answerConsent: h.answerConsent }));
vi.mock('sonner', () => ({ toast: { success: vi.fn(), error: vi.fn() } }));

afterEach(cleanup);

const year = { id: 'y1', label: 'R8', status: 'allocating' as const, festival_start: '2026-10-17' };
beforeEach(() => {
  h.answerConsent.mockReset();
  h.membership = {
    status: 'ready',
    membership: {
      displayName: null,
      year,
      role: null,
      groups: [{ id: 'g1', name: '模擬店10', year_id: 'y1' }],
      years: [year],
      latestYear: year,
      adminOfOpenYear: false,
    },
  };
});

const data = (status: MyData['year']['status']): MyData => ({
  year: {
    id: 'y1',
    label: 'R8',
    status,
    allocation_version: 1,
    auto_allocated_at: null,
    festival_start: '2026-10-17',
    request_open_at: null,
    request_close_at: null,
    prev_year_id: null,
    updated_at: '2026-10-29T00:00:00Z',
  },
  group: {
    id: 'g1',
    year_id: 'y1',
    name: '模擬店10',
    display_name: null,
    aliases: [],
    category: 'stall',
    is_food: false,
    location_room_id: null,
    sort_order: 1,
    updated_at: '2026-10-29T00:00:00Z',
  },
  items: [],
  rooms: [],
  requests: [],
  submission: null,
  consents: [],
  allocations: null,
  loadedAt: '2026-10-29T00:00:00Z',
});
const consent = (status: MyConsent['status']): MyConsent => ({
  fromItemId: 'desk',
  toItemId: 'caster',
  fromName: '机(木)',
  toName: 'キャスター机',
  status,
  count: 5,
  note: null,
  updatedAt: '2026-10-29T03:04:00Z',
});

function renderCard(c: MyConsent, d: MyData, refetch = vi.fn(() => Promise.resolve())) {
  const qc = new QueryClient();
  render(
    <QueryClientProvider client={qc}>
      <ConsentCard consent={c} data={d} refetch={refetch} />
    </QueryClientProvider>,
  );
  return { refetch };
}

describe('ConsentCard（交換の依頼への回答。Q4）', () => {
  it('依頼済み：依頼の台数と、了承する・了承しない。押すと set_consent（accepted）を送って読み直す', async () => {
    h.answerConsent.mockResolvedValue({});
    const { refetch } = renderCard(consent('asked'), data('allocating'));
    expect(screen.getByText('机(木) 5 台をキャスター机に交換してほしいという依頼があります')).toBeTruthy();
    fireEvent.change(screen.getByLabelText('コメント（任意）'), { target: { value: '入口が狭いので' } });
    await act(async () => {
      fireEvent.click(screen.getByRole('button', { name: '了承する' }));
    });
    expect(h.answerConsent).toHaveBeenCalledWith({
      groupId: 'g1',
      fromItemId: 'desk',
      toItemId: 'caster',
      status: 'accepted',
      note: '入口が狭いので',
    });
    expect(refetch).toHaveBeenCalled();
  });

  it('送信中は了承する・了承しないを押せない', async () => {
    let resolve: (v: unknown) => void = () => undefined;
    h.answerConsent.mockReturnValue(new Promise((r) => (resolve = r)));
    renderCard(consent('asked'), data('allocating'));
    await act(async () => {
      fireEvent.click(screen.getByRole('button', { name: '了承しない' }));
    });
    expect((screen.getByRole('button', { name: '了承する' }) as HTMLButtonElement).disabled).toBe(true);
    expect((screen.getByRole('button', { name: '送信中…' }) as HTMLButtonElement).disabled).toBe(true);
    await act(async () => resolve({}));
  });

  it('答えた後は答えと日時、確定までは「回答を変える」で回答のボタンが出る', async () => {
    h.answerConsent.mockResolvedValue({});
    renderCard(consent('accepted'), data('allocating'));
    expect(screen.getByText('了承しました')).toBeTruthy();
    expect(screen.queryByRole('button', { name: '了承しない' })).toBeNull();
    fireEvent.click(screen.getByRole('button', { name: '回答を変える' }));
    await act(async () => {
      fireEvent.click(screen.getByRole('button', { name: '了承しない' }));
    });
    expect(h.answerConsent).toHaveBeenCalledWith(expect.objectContaining({ status: 'declined' }));
  });

  it('依頼の後に置き換えが増えていて記録できない（conflict）：総務が依頼し直すのを待ってください', async () => {
    h.answerConsent.mockRejectedValue(appError('conflict', 'test', { asked: 5, current: 7 }));
    renderCard(consent('declined'), data('allocating'));
    fireEvent.click(screen.getByRole('button', { name: '回答を変える' }));
    await act(async () => {
      fireEvent.click(screen.getByRole('button', { name: '了承する' }));
    });
    await waitFor(() => expect(screen.getByTestId('my-consent-wait').textContent).toBe(WAIT_REASK));
  });

  it('振り分け中でなければ回答のボタンも「回答を変える」も出さない', () => {
    renderCard(consent('asked'), data('requesting'));
    expect(screen.queryByRole('button', { name: '了承する' })).toBeNull();
    cleanup();
    renderCard(consent('accepted'), data('confirmed'));
    expect(screen.queryByRole('button', { name: '回答を変える' })).toBeNull();
  });
});
