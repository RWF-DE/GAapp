// @vitest-environment jsdom
import { cleanup, render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { EmptyState, QueryState, type QueryLike } from './states';

afterEach(() => cleanup());

const query = <T,>(q: Partial<QueryLike<T>>): QueryLike<T> => ({
  data: undefined,
  isPending: false,
  isError: false,
  error: null,
  refetch: vi.fn(),
  ...q,
});

const networkError = new TypeError('Failed to fetch');

function Form({ rows }: { rows: string[] }) {
  return (
    <form>
      <label htmlFor="memo">備考</label>
      <input id="memo" defaultValue="" />
      <ul>
        {rows.map((r) => (
          <li key={r}>{r}</li>
        ))}
      </ul>
    </form>
  );
}

describe('QueryState', () => {
  it('data がなく読み込み中なら LoadingState', () => {
    render(<QueryState query={query<string[]>({ isPending: true })}>{(rows) => <Form rows={rows} />}</QueryState>);
    expect(screen.getByRole('status').textContent).toContain('読み込み中');
    expect(screen.queryByLabelText('備考')).toBeNull();
  });

  it('data がなく失敗したら ErrorState（「もう一度読み込む」で refetch）', async () => {
    const q = query<string[]>({ isError: true, error: networkError });
    render(<QueryState query={q}>{(rows) => <Form rows={rows} />}</QueryState>);
    expect(screen.getByRole('alert')).toBeTruthy();
    expect(screen.queryByLabelText('備考')).toBeNull();
    await userEvent.setup().click(screen.getByRole('button', { name: 'もう一度読み込む' }));
    expect(q.refetch).toHaveBeenCalledTimes(1);
  });

  it('data があれば中身を出し、空なら empty', () => {
    const { rerender } = render(
      <QueryState query={query({ data: ['1-1'] })}>{(rows) => <Form rows={rows} />}</QueryState>,
    );
    expect(screen.getByText('1-1')).toBeTruthy();
    rerender(
      <QueryState query={query<string[]>({ data: [] })} isEmpty={(r) => r.length === 0} empty={<EmptyState title="場所がありません" />}>
        {(rows) => <Form rows={rows} />}
      </QueryState>,
    );
    expect(screen.getByText('場所がありません')).toBeTruthy();
  });

  it('data があるのに読み直しが失敗したら、中身（入力したもの）を残したまま帯で知らせる', async () => {
    const user = userEvent.setup();
    const ok = query({ data: ['1-1', '1-2'] });
    const { rerender } = render(<QueryState query={ok}>{(rows) => <Form rows={rows} />}</QueryState>);
    const memo = screen.getByLabelText('備考') as HTMLInputElement;
    await user.type(memo, '机を2つ多めに');

    const failed = query({ data: ['1-1', '1-2'], isError: true, error: networkError });
    rerender(<QueryState query={failed}>{(rows) => <Form rows={rows} />}</QueryState>);

    // 中身は外さない（同じ入力欄で、入れた文字が残る）
    expect(screen.getByLabelText('備考')).toBe(memo);
    expect(memo.value).toBe('机を2つ多めに');
    expect(screen.getByText('1-2')).toBeTruthy();
    // 失敗は帯（ErrorBanner）で知らせ、「もう一度」で読み直せる。ErrorState（「もう一度読み込む」）は出さない
    const banner = screen.getByTestId('error-banner');
    expect(banner.getAttribute('role')).toBe('alert');
    expect(screen.queryByRole('button', { name: 'もう一度読み込む' })).toBeNull();
    await user.click(screen.getByRole('button', { name: 'もう一度' }));
    expect(failed.refetch).toHaveBeenCalledTimes(1);

    // 読み直しが通れば帯は消える
    rerender(<QueryState query={ok}>{(rows) => <Form rows={rows} />}</QueryState>);
    expect(screen.queryByTestId('error-banner')).toBeNull();
    expect(memo.value).toBe('机を2つ多めに');
  });

  it('data が空で読み直しが失敗したら、empty と帯の両方を出す', () => {
    render(
      <QueryState
        query={query<string[]>({ data: [], isError: true, error: networkError })}
        isEmpty={(r) => r.length === 0}
        empty={<EmptyState title="場所がありません" />}
      >
        {(rows) => <Form rows={rows} />}
      </QueryState>,
    );
    expect(screen.getByText('場所がありません')).toBeTruthy();
    expect(screen.getByTestId('error-banner')).toBeTruthy();
  });
});
