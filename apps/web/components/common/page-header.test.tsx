// @vitest-environment jsdom
import { cleanup, render, screen } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { MembershipState } from '@/lib/auth/auth-provider';
import { PageHeader } from './page-header';

const auth = vi.hoisted(() => ({ membership: { status: 'idle' } as MembershipState }));
vi.mock('@/lib/auth/auth-provider', () => ({ useAuth: () => ({ membership: auth.membership }) }));

const year = { id: 'y1', label: 'テスト年度', status: 'allocating', festival_start: '2026-10-17' } as const;
auth.membership = {
  status: 'ready',
  membership: { displayName: null, year, role: 'admin', groups: [], years: [year], latestYear: year, adminOfOpenYear: false },
};

afterEach(() => cleanup());

/** 題名の段（h1 を含む、header の直下の div） */
const titleBlock = () => screen.getByRole('heading', { level: 1 }).closest('header > div') as HTMLElement;
const classesOf = (el: Element) => el.className.split(/\s+/);

describe('PageHeader の段の並び（スマホの 390px で題名が細くならないように）', () => {
  it('md 未満は題名の段を全幅（basis-full）にし、最終読み込み・読み直すは次の行に送る。md 以上は今までどおり横に並べる', () => {
    render(
      <PageHeader
        title="ダッシュボード"
        description="受付の状況と在庫の数え方"
        loadedAt={new Date('2026-10-29T03:00:00Z')}
        onReload={() => {}}
        actions={<button type="button">QR を印刷</button>}
      />,
    );
    const classes = classesOf(titleBlock());
    expect(classes).toEqual(expect.arrayContaining(['min-w-0', 'grow', 'basis-full', 'md:basis-0']));
    // flex-1（flex: 1 1 0%）は basis-full と同じ性質（flex-basis）を書きかえるので、使わない
    expect(classes).not.toContain('flex-1');
    // header の直下の段は 題名・最終読み込み・操作 の3つ（題名の段だけが全幅になる）
    const header = screen.getByRole('banner');
    expect(header.children).toHaveLength(3);
    expect(header.children[1]?.textContent).toContain('最終読み込み');
    expect(classesOf(header.children[1]!)).not.toContain('basis-full');
    expect(classesOf(header.children[2]!)).not.toContain('basis-full');
  });

  it('題名だけでも同じ段の形（年度と状態は題名の段に出る）', () => {
    render(<PageHeader title="マスタ設定" />);
    expect(classesOf(titleBlock())).toEqual(expect.arrayContaining(['basis-full', 'md:basis-0']));
    expect(titleBlock().textContent).toContain('テスト年度');
    expect(screen.getByRole('banner').children).toHaveLength(1);
  });
});
