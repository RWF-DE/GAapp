// @vitest-environment jsdom
import type { AllocateResult, Issue } from '@gaapp/shared';
import { fixturePath, readFixtureDir } from '@gaapp/shared/testing';
import { act, cleanup, fireEvent, render, screen, within } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { MembershipState } from '@/lib/auth/auth-provider';
import { createAllocatorEngine, type WorkerLike } from '@/lib/allocation/engine';
import { issueTarget } from '@/lib/allocation/issue-target';
import type { WorkerRequest, WorkerResponse } from '@/lib/allocation/protocol';
import { buildViewModel } from '@/lib/allocation/view-model';
import type { Snapshot } from '@/lib/data/snapshot';
import { runValidation } from '@/lib/data/validation';
import { toYearData } from '@/lib/data/year-data';
import type { SaveAutoAllocationsResult } from '@/lib/rpc/payloads';
import { fixtureSnapshot } from '@/lib/testing/fixture-rows';
import { AutoResult } from './auto-result';
import { autoBlockOf, AutoRunLock, CANCEL_AFTER_MS, useAutoAllocation, type AutoRunDeps } from './auto-run';
import { IssuesPanel } from './issues-panel';

const auth = vi.hoisted(() => ({ membership: { status: 'idle' } as MembershipState }));
vi.mock('@/lib/auth/auth-provider', () => ({ useAuth: () => ({ membership: auth.membership }) }));
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

const as = (role: 'admin' | 'staff'): MembershipState => ({
  status: 'ready',
  membership: {
    displayName: null,
    year: { id: 'y1', label: 'R8', status: 'allocating', festival_start: '2026-10-17' },
    role,
    groups: [],
    years: [],
    latestYear: null,
    adminOfOpenYear: false,
  },
});

const fx = readFixtureDir(fixturePath('synthetic', 'r8like'));
const snapshot = fixtureSnapshot(fx, { version: 5 });
const vm = buildViewModel(snapshot);
const item = (code: string) => snapshot.items.find((i) => i.code === code)!;
const groupNamed = (name: string) => snapshot.groups.find((g) => g.name === name)!;
const roomNamed = (name: string) => snapshot.rooms.find((r) => r.name === name)!;

type Failure = Extract<AllocateResult, { ok: false }>;
const failure = (p: Partial<Failure> & Pick<Failure, 'reason'>): Failure => ({
  ok: false,
  message: '',
  inputErrors: [],
  issues: [],
  shortages: [],
  causes: [],
  elapsedMs: 10,
  ...p,
});
const renderFailure = (result: Failure) =>
  render(
    <AutoResult
      outcome={{ kind: 'failure', mode: 'full', result }}
      vm={vm}
      errorsAfter={0}
      onIssue={vi.fn()}
      onRecheck={vi.fn()}
      onReload={vi.fn()}
    />,
  );

beforeEach(() => {
  auth.membership = as('admin');
});
afterEach(() => {
  cleanup();
  vi.useRealTimers();
});

describe('ok: false のパネル（reason ごとの見出し）', () => {
  it('invalid_input：「入力に誤りがあります」と inputErrors（ルールのコードはルール画面へ）', () => {
    renderFailure(failure({ reason: 'invalid_input', inputErrors: [{ path: 'rules.S05', message: '団体がありません', ruleCode: 'S05' }] }));
    const panel = screen.getByTestId('allocate-failure');
    expect(panel.getAttribute('data-reason')).toBe('invalid_input');
    expect(within(panel).getByRole('heading', { name: '入力に誤りがあります' })).toBeTruthy();
    expect(panel.textContent).toContain('ルール S05：団体がありません');
    expect(within(panel).getByRole('link', { name: 'ルール S05' }).getAttribute('href')).toBe('/rules?code=S05');
  });

  it('precheck：「振り分けの前に直すものがあります」と issues。押すと該当の行・ルールへ', () => {
    const issue: Issue = { code: 'E002', severity: 'error', message: '第一セミナーは今年使えません', refs: { roomId: 'r', rowIds: ['row'] } };
    const onIssue = vi.fn();
    render(
      <AutoResult
        outcome={{ kind: 'failure', mode: 'minimal_change', result: failure({ reason: 'precheck', issues: [issue] }) }}
        vm={vm}
        errorsAfter={0}
        onIssue={onIssue}
        onRecheck={vi.fn()}
        onReload={vi.fn()}
      />,
    );
    const panel = screen.getByTestId('allocate-failure');
    expect(within(panel).getByRole('heading', { name: '振り分けの前に直すものがあります' })).toBeTruthy();
    fireEvent.click(within(panel).getByRole('button', { name: 'E002 第一セミナーは今年使えません' }));
    expect(onIssue).toHaveBeenCalledWith(issue);
  });

  it('infeasible：品目全体の不足 → 団体ごとの不足 → 原因のルールと details → 締めの文', () => {
    const desk = item('desk');
    const g = groupNamed('設営');
    const rooms = ['1-1', '1-2'].map(roomNamed);
    renderFailure(
      failure({
        reason: 'infeasible',
        shortages: [
          { requestedItemId: desk.id, groupId: g.id, demand: 241, supply: 235 },
          { requestedItemId: item('chair').id, groupId: null, demand: 500, supply: 488 },
        ],
        causes: [
          { ruleCode: 'S05', message: '運び元の制限を外すと解けます', details: [{ groupId: g.id, itemIds: [desk.id], roomIds: rooms.map((r) => r.id), demand: 241, supply: 235 }] },
          { ruleCode: null, message: '代替を含めても在庫が足りません', details: [{ itemIds: [desk.id, item('desk_ng').id], demand: 300, supply: 290 }] },
        ],
      }),
    );
    const panel = screen.getByTestId('allocate-failure');
    expect(within(panel).getByRole('heading', { name: '解けません' })).toBeTruthy();
    const lines = within(panel)
      .getAllByRole('listitem')
      .map((li) => li.firstChild?.textContent);
    // 品目全体（groupId が null）が先、団体つきが後
    expect(lines.slice(0, 2)).toEqual([
      `${item('chair').name}が 12 台足りません（需要 500、使える在庫 488）`,
      `設営の${desk.name}：需要 241、使える在庫 235`,
    ]);
    expect(panel.textContent).toContain('原因のルール S05：運び元の制限を外すと解けます');
    expect(panel.textContent).toContain(`設営の${desk.name}：需要 241、1-1・1-2 の在庫合計 235`);
    // 代替を含めても在庫が足りない cause は品目名をつないで、品目ごとの不足の行には混ぜない
    expect(panel.textContent).toContain(`${desk.name}・${item('desk_ng').name}：需要 300、在庫 290`);
    expect(panel.textContent).toContain('ルールを変えるか、申請や固定行を直すかを決めてください');
  });

  it('solver_error：「計算できませんでした」と message', () => {
    renderFailure(failure({ reason: 'solver_error', message: '計算エンジン（highs）を読み込めませんでした。' }));
    const panel = screen.getByTestId('allocate-failure');
    expect(within(panel).getByRole('heading', { name: '計算できませんでした' })).toBeTruthy();
    expect(panel.textContent).toContain('計算エンジン（highs）を読み込めませんでした。');
  });

  it('部員にはルール画面へのリンクにしない（文字だけ）', () => {
    auth.membership = as('staff');
    renderFailure(failure({ reason: 'invalid_input', inputErrors: [{ path: 'rules.S05', message: 'x', ruleCode: 'S05' }] }));
    expect(screen.queryByRole('link')).toBeNull();
  });

  it('保存した：件数・計算の時間（data-testid allocate-elapsed）・除いた申請・保存の後の error', () => {
    render(
      <AutoResult
        outcome={{
          kind: 'saved',
          mode: 'full',
          counts: { allocation_version: 6, inserted: 10, updated: 2, deleted: 1 },
          elapsedMs: 284.4,
          loadMs: 180,
          wallMs: 300,
          excludedRequests: 2,
        }}
        vm={vm}
        errorsAfter={3}
        onRecheck={vi.fn()}
        onReload={vi.fn()}
      />,
    );
    expect(screen.getByTestId('allocate-saved').textContent).toContain('追加 10・変更 2・削除 1');
    const el = screen.getByTestId('allocate-elapsed');
    expect(el.getAttribute('data-elapsed-ms')).toBe('284');
    expect(el.textContent).toContain('計算 0.28 秒');
    expect(screen.getByTestId('allocate-excluded').textContent).toContain('申請できない品目の申請 2 件を除いて計算しました');
    expect(screen.getByTestId('allocate-errors-after').textContent).toContain('error が 3 件');
  });

  it('保存されたか確かめられない：「確かめる」を出す', () => {
    const onRecheck = vi.fn();
    render(
      <AutoResult
        outcome={{
          kind: 'unverified',
          mode: 'full',
          rows: [],
          baseVersion: 5,
          result: { ok: true, rows: [], objective: 0, elapsedMs: 1, stats: { excludedRequests: 0 } as never },
          loadMs: 0,
          wallMs: 1,
        }}
        vm={vm}
        errorsAfter={0}
        onRecheck={onRecheck}
        onReload={vi.fn()}
      />,
    );
    fireEvent.click(screen.getByRole('button', { name: '確かめる' }));
    expect(onRecheck).toHaveBeenCalled();
  });
});

// ---- 計算中のロックと「中止」 ----

class SilentWorker implements WorkerLike {
  onmessage: ((e: MessageEvent<WorkerResponse>) => void) | null = null;
  onerror: ((e: Event) => void) | null = null;
  sent: WorkerRequest[] = [];
  terminated = false;
  postMessage(m: WorkerRequest) {
    this.sent.push(m);
    // 読み込みは返すが、計算の結果は返さない（計算が終わらない）
    if (m.type === 'warmup') queueMicrotask(() => this.onmessage?.({ data: { id: m.id, type: 'ready', loadMs: 1 } } as MessageEvent<WorkerResponse>));
    if (m.type === 'allocate') {
      queueMicrotask(() => this.onmessage?.({ data: { id: m.id, type: 'progress', phase: 'solving' } } as MessageEvent<WorkerResponse>));
      if (this.answer) {
        const answer = this.answer;
        queueMicrotask(() => this.onmessage?.({ data: { id: m.id, type: 'result', loadMs: 0, result: answer } } as MessageEvent<WorkerResponse>));
      }
    }
  }
  terminate() {
    this.terminated = true;
  }
  constructor(private answer: AllocateResult | null = null) {}
}

function Harness({ deps }: { deps: AutoRunDeps }) {
  const a = useAutoAllocation(deps);
  return (
    <>
      <button type="button" onClick={() => void a.start('full')}>
        go
      </button>
      {a.state.outcome ? <span data-testid="outcome">{a.state.outcome.kind}</span> : null}
      <AutoRunLock state={a.state} onCancel={a.cancel} />
    </>
  );
}

function makeDeps(opts: { answer?: AllocateResult | null; save?: () => Promise<SaveAutoAllocationsResult>; loadFresh?: () => Promise<Snapshot> } = {}) {
  const workers: SilentWorker[] = [];
  const engine = createAllocatorEngine(() => {
    const w = new SilentWorker(opts.answer ?? null);
    workers.push(w);
    return w;
  });
  const deps: AutoRunDeps = {
    engine,
    loadFresh: opts.loadFresh ?? (() => Promise.resolve(snapshot)),
    publish: vi.fn(),
    save: opts.save ?? (() => new Promise(() => {})),
    readVersion: vi.fn(() => Promise.resolve(5)),
    reload: vi.fn(() => Promise.resolve()),
    heldVersion: () => 5,
  };
  return { deps, workers, engine };
}

const flush = () => act(async () => {
  await Promise.resolve();
  await Promise.resolve();
});

describe('計算中のロック（engine を偽物にして fake timers）', () => {
  it('計算の段階：10 秒までは「中止」を出さず、過ぎたら出す。押すと Worker を止め、版を読み直す', async () => {
    vi.useFakeTimers();
    const { deps, workers, engine } = makeDeps();
    await act(async () => {
      await engine.warmup();
    });
    render(<Harness deps={deps} />);
    fireEvent.click(screen.getByRole('button', { name: 'go' }));
    await flush();
    await flush();
    const lock = screen.getByTestId('allocate-lock');
    expect(lock.getAttribute('data-phase')).toBe('solving');
    act(() => vi.advanceTimersByTime(CANCEL_AFTER_MS - 1000));
    expect(screen.queryByRole('button', { name: '中止' })).toBeNull();
    act(() => vi.advanceTimersByTime(1500));
    fireEvent.click(screen.getByRole('button', { name: '中止' }));
    await flush();
    await flush();
    expect(workers[0]!.terminated).toBe(true);
    expect(screen.queryByTestId('allocate-lock')).toBeNull();
    expect(screen.getByTestId('outcome').textContent).toBe('cancelled');
    expect(deps.readVersion).toHaveBeenCalled();
  });

  it('中止の後：engine は idle に戻り、ボタンは押せる。もう一度押すと Worker を作り直して計算する', async () => {
    vi.useFakeTimers();
    const { deps, workers, engine } = makeDeps();
    await act(async () => {
      await engine.warmup();
    });
    render(<Harness deps={deps} />);
    fireEvent.click(screen.getByRole('button', { name: 'go' }));
    await flush();
    await flush();
    act(() => vi.advanceTimersByTime(CANCEL_AFTER_MS + 500));
    fireEvent.click(screen.getByRole('button', { name: '中止' }));
    await flush();
    await flush();
    expect(screen.getByTestId('outcome').textContent).toBe('cancelled');
    expect(engine.state()).toBe('idle');
    // 画面のボタン：中止の後（engine が idle）も押せる（読み込み中とは出さない）
    const block = autoBlockOf({ allocating: true, running: false, dirty: false, problemCount: 0, unverified: false, engineState: engine.state() });
    expect(block).toEqual({ disabled: false, reason: null });
    // もう一度押す：Worker を作り直し、読み込み → 計算へ進む
    fireEvent.click(screen.getByRole('button', { name: 'go' }));
    for (let k = 0; k < 4; k += 1) await flush();
    expect(workers).toHaveLength(2);
    expect(workers[1]!.sent.map((m) => m.type)).toContain('allocate');
    expect(screen.getByTestId('allocate-lock').getAttribute('data-phase')).toBe('solving');
  });

  it('読み直しの段階でも 10 秒を過ぎたら「中止」を出す（DB は変わらない）', async () => {
    vi.useFakeTimers();
    const { deps, engine } = makeDeps({ loadFresh: () => new Promise(() => {}) });
    await act(async () => {
      await engine.warmup();
    });
    render(<Harness deps={deps} />);
    fireEvent.click(screen.getByRole('button', { name: 'go' }));
    await flush();
    expect(screen.getByTestId('allocate-lock').getAttribute('data-phase')).toBe('preparing');
    act(() => vi.advanceTimersByTime(CANCEL_AFTER_MS + 500));
    fireEvent.click(screen.getByRole('button', { name: '中止' }));
    await flush();
    expect(screen.getByTestId('outcome').textContent).toBe('cancelled');
  });

  it('保存の段階（保存を送った後）は 10 秒を過ぎても「中止」を出さず「保存中…」で待つ', async () => {
    vi.useFakeTimers();
    const ok: AllocateResult = { ok: true, rows: [], objective: 0, elapsedMs: 5, stats: { excludedRequests: 0 } as never };
    const save = vi.fn(() => new Promise<SaveAutoAllocationsResult>(() => {}));
    const { deps, engine } = makeDeps({ answer: ok, save });
    await act(async () => {
      await engine.warmup();
    });
    render(<Harness deps={deps} />);
    fireEvent.click(screen.getByRole('button', { name: 'go' }));
    for (let k = 0; k < 4; k += 1) await flush();
    const lock = screen.getByTestId('allocate-lock');
    expect(lock.getAttribute('data-phase')).toBe('saving');
    expect(save).toHaveBeenCalledWith({ rows: [], mode: 'full', baseVersion: 5 });
    act(() => vi.advanceTimersByTime(CANCEL_AFTER_MS * 3));
    expect(screen.queryByRole('button', { name: '中止' })).toBeNull();
    expect(lock.textContent).toContain('（保存中…）');
    expect(lock.textContent).toContain('経過 30 秒');
  });
});

describe('自動振り分けを押せない理由（autoBlockOf）', () => {
  const base = { allocating: true, running: false, dirty: false, problemCount: 0, unverified: false } as const;
  it('読み込み中だけ「読み込み中」で押せない。idle（開いた直後・中止の後）と ready・failed は押せる', () => {
    expect(autoBlockOf({ ...base, engineState: 'loading' })).toEqual({ disabled: true, reason: '計算エンジンを読み込み中（初回だけ。約 1.2 MB）' });
    expect(autoBlockOf({ ...base, engineState: 'idle' })).toEqual({ disabled: false, reason: null });
    expect(autoBlockOf({ ...base, engineState: 'ready' })).toEqual({ disabled: false, reason: null });
    expect(autoBlockOf({ ...base, engineState: 'failed' })).toEqual({ disabled: false, reason: null });
  });
  it('振り分け中でない・計算中は理由なしで押せない。未保存・入力の誤り・未確認は理由つき', () => {
    expect(autoBlockOf({ ...base, allocating: false, engineState: 'ready' })).toEqual({ disabled: true, reason: null });
    expect(autoBlockOf({ ...base, running: true, engineState: 'ready' })).toEqual({ disabled: true, reason: null });
    expect(autoBlockOf({ ...base, dirty: true, engineState: 'ready' }).reason).toContain('保存していない変更');
    expect(autoBlockOf({ ...base, problemCount: 1, engineState: 'ready' }).reason).toContain('入力に誤り');
    expect(autoBlockOf({ ...base, unverified: true, engineState: 'ready' }).reason).toContain('確かめるまで');
  });
});

// ---- 検証の一覧（立場ごと） ----

describe('検証の一覧', () => {
  const y = toYearData(snapshot);
  const v = runValidation(y, [], 5);
  const issue: Issue = { code: 'W106', severity: 'warning', message: 'ルールの固定の数と申請が違います', refs: { groupId: groupNamed('設営').id, ruleCode: 'S06' } };
  const validation = { ...v, issues: [issue] };
  const index = { rowItem: new Map<string, string>(), tabByItem: new Map<string, string>() };

  it('管理者：ルール画面へのリンク（同じタブで移動）', () => {
    render(
      <IssuesPanel
        validation={validation}
        targetOf={(i) => issueTarget(i, index, ['admin'], 'allocating')}
        onSelect={vi.fn()}
        ruleText={() => 'S06 固定の申請'}
      />,
    );
    expect(screen.getByRole('link', { name: 'ルール S06 を開く' }).getAttribute('href')).toBe('/rules?code=S06');
  });

  it('部員（Q1）：リンクにせず、押すとコードと内容の文を出す。項目を押すと行き先へ', () => {
    auth.membership = as('staff');
    const onSelect = vi.fn();
    render(
      <IssuesPanel
        validation={validation}
        targetOf={(i) => issueTarget(i, index, ['staff'], 'allocating')}
        onSelect={onSelect}
        ruleText={() => 'S06 固定の申請：設営が未提出なら 机(木) を 241 台'}
      />,
    );
    expect(screen.queryByRole('link')).toBeNull();
    fireEvent.click(screen.getByRole('button', { name: 'ルール S06 の内容' }));
    expect(screen.getByTestId('rule-text').textContent).toBe('S06 固定の申請：設営が未提出なら 机(木) を 241 台');
    fireEvent.click(screen.getByRole('button', { name: 'ルールの固定の数と申請が違います' }));
    expect(onSelect).toHaveBeenCalledWith(issue, expect.objectContaining({ destination: { kind: 'group', groupId: groupNamed('設営').id } }));
  });

  it('コードで絞る', () => {
    const issues: Issue[] = [
      { code: 'E003', severity: 'error', message: 'a', refs: {} },
      { code: 'W101', severity: 'warning', message: 'b', refs: {} },
    ];
    render(<IssuesPanel validation={{ ...v, issues }} targetOf={(i) => issueTarget(i, index, ['admin'])} onSelect={vi.fn()} ruleText={() => undefined} />);
    expect(screen.getByTestId('issue-counts').textContent).toContain('error 1 件');
    fireEvent.click(screen.getByRole('button', { name: 'W101 1' }));
    expect(screen.queryByText('a')).toBeNull();
    expect(screen.getByText('b')).toBeTruthy();
  });
});
