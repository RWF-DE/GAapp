// @vitest-environment jsdom
// 振り分けの部屋の見出しの「現状復帰の写真」へのリンク（04「振り分け」。T25・D-63）：総務（スナップショットの全部を読む人）だけ。
// 閲覧のみ（行の一覧だけ）には出さない（画面を通した出し分けは allocation-screen.test.tsx）。リンクだけで、写真の部品・読み取りは振り分けの画面の JS に入れない。
import { fixturePath, readFixtureDir } from '@gaapp/shared/testing';
import { cleanup, render, screen } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { itemTabs } from '@/lib/allocation/tabs';
import { buildViewModel } from '@/lib/allocation/view-model';
import { toStoredRows } from '@/lib/data/year-data';
import { fixtureSnapshot } from '@/lib/testing/fixture-rows';
import { staticImportGraph } from '@/lib/testing/import-graph';
import { ItemTabView } from './item-tab-view';

const auth = vi.hoisted(() => ({ role: 'staff' as string }));
vi.mock('@/lib/auth/auth-provider', () => ({
  useAuth: () => ({
    membership: {
      status: 'ready',
      membership: { role: auth.role, groups: [], year: { id: 'y', label: 'R9', status: 'allocating', festival_start: '2027-10-16' } },
    },
  }),
}));
vi.mock('next/navigation', () => ({ useRouter: () => ({ push: vi.fn(), replace: vi.fn(), refresh: vi.fn() }) }));
vi.mock('next/link', () => ({
  default: (props: Record<string, unknown> & { href: string; children: React.ReactNode }) => {
    const { href, children, onNavigate, prefetch, ...rest } = props;
    void onNavigate;
    void prefetch;
    return (
      <a href={href} {...rest}>
        {children}
      </a>
    );
  },
}));

afterEach(cleanup);

const fx = readFixtureDir(fixturePath('synthetic', 'r8like'));
const snap = fixtureSnapshot(fx);
const vm = buildViewModel(snap);
const rows = toStoredRows(snap).rows;
const tab = itemTabs(vm.items).find((t) => t.key === 'desk')!;

describe('T25 振り分けの部屋の見出しの「現状復帰の写真」', () => {
  it('総務（photoLinks）には部屋ごとにリンク（/room-photos?room={場所の id}）', () => {
    render(<ItemTabView vm={vm} rows={rows} tab={tab} photoLinks />);
    const links = screen.getAllByTestId('room-photos-link');
    expect(links.length).toBeGreaterThan(0);
    const block = links[0]!.closest('[data-room-block]')!;
    expect(links[0]!.getAttribute('href')).toBe(`/room-photos?room=${block.getAttribute('data-room-block')}`);
    expect(links[0]!.textContent).toBe('現状復帰の写真');
  });

  // 立場による出し分け（閲覧のみには出さない。photoLinks={full}）は allocation-screen.test.tsx が画面を通して確かめる（T25 のレビュー）
  it('photoLinks が偽（既定）なら出さない（リンクも文字も）', () => {
    render(<ItemTabView vm={vm} rows={rows} tab={tab} readOnlyList />);
    expect(screen.queryByTestId('room-photos-link')).toBeNull();
    expect(screen.queryByText('現状復帰の写真')).toBeNull();
  });

  it('振り分けと在庫入力の画面は写真の部品・読み取りを静的に読まない（リンクのパスだけ）', () => {
    for (const entry of ['components/allocation/allocation-screen.tsx', 'components/stock/stock-screen.tsx']) {
      const { files } = staticImportGraph(entry);
      expect(files).toContain('lib/room-photos/path.ts');
      // lib/schemas/room-photos.ts は RPC の引数の確かめ（lib/rpc/payloads.ts。どの画面も読む）の小さな zod だけ
      const allowed = ['lib/room-photos/path.ts', 'lib/schemas/room-photos.ts'];
      expect(files.filter((f) => f.includes('room-photo') && !allowed.includes(f))).toEqual([]);
    }
  });
});
