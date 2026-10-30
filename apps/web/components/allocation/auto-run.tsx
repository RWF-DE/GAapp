'use client';

// 自動振り分け・最小変更で再実行の流れと、計算中のロック（画面の設計 3.9 の「自動振り分け・最小変更で再実行」・4.3、D-34。T13）。
// 段階：①計算エンジンの読み込み（初回だけ）②読み直しと入力の組み立て ③計算 ④保存 ⑤読み直しと検証。
// 「中止」は①②③で 10 秒を過ぎたときだけ出す。④（save_auto_allocations を送った後）は送った RPC を止められずコミットされうるので
// 中止を出さず「保存中…」で待つ。⑤も出さない。中止の後は年度の版を読み直し、進んでいればスナップショットを読み直す。
import type { AllocateMode, AllocateResult, AllocationRow, InputError } from '@gaapp/shared';
import { Loader2 } from 'lucide-react';
import { useCallback, useEffect, useLayoutEffect, useRef, useState } from 'react';
import { Button } from '@/components/ui/button';
import type { Snapshot } from '@/lib/data/snapshot';
import { classifyError } from '@/lib/errors';
import type { SaveAutoAllocationsResult } from '@/lib/rpc/payloads';
import { EngineCancelledError, solverErrorResult, type AllocatorEngine, type EngineState } from '@/lib/allocation/engine';
import { buildAllocateInput } from '@/lib/allocation/input';
import { autoRowsMatch } from '@/lib/data/allocation';
import { useUnsavedChanges } from '@/lib/unsaved-changes';

export type AutoPhase = 'loading' | 'preparing' | 'solving' | 'saving' | 'reloading';

export const PHASES: readonly { phase: AutoPhase; label: string }[] = [
  { phase: 'loading', label: '計算エンジンの読み込み（初回だけ）' },
  { phase: 'preparing', label: '読み直しと入力の組み立て' },
  { phase: 'solving', label: '計算' },
  { phase: 'saving', label: '保存' },
  { phase: 'reloading', label: '読み直しと検証' },
];

/** 中止を出せる段階（DB に何も書いていない段階）と、出すまでの秒数 */
export const CANCELLABLE_PHASES: readonly AutoPhase[] = ['loading', 'preparing', 'solving'];
export const CANCEL_AFTER_MS = 10_000;

export const MODE_LABELS: Record<AllocateMode, string> = { full: '自動振り分け', minimal_change: '最小変更で再実行' };

export type AutoOutcome =
  /** 計算の結果が ok: false（振り分けは書き換えていない） */
  | { kind: 'failure'; mode: AllocateMode; result: Extract<AllocateResult, { ok: false }> }
  /** 入力の誤り（toYearData の problems）で計算しなかった */
  | { kind: 'problems'; mode: AllocateMode; problems: InputError[] }
  /** 保存した */
  | {
      kind: 'saved';
      mode: AllocateMode;
      counts: SaveAutoAllocationsResult;
      elapsedMs: number;
      loadMs: number;
      wallMs: number;
      excludedRequests: number;
      /** 保存の応答が届かず、読み直して保存されていたと分かった */
      verified?: boolean;
    }
  /** 保存が拒まれた（conflict・E001 など・state・input）。スナップショットは読み直した */
  | { kind: 'save-error'; mode: AllocateMode; error: unknown }
  /** 保存の応答が届かず、保存されていなかった（版が同じ）か、ほかの人の変更で版が進んでいた */
  | { kind: 'not-saved'; mode: AllocateMode; otherChange: boolean }
  /** 保存されたか確かめられない（版を読めない）。確かめるまで送り直させない */
  | { kind: 'unverified'; mode: AllocateMode; rows: AllocationRow[]; baseVersion: number; result: Extract<AllocateResult, { ok: true }>; loadMs: number; wallMs: number }
  | { kind: 'cancelled'; mode: AllocateMode }
  /** 読み直しなどの失敗 */
  | { kind: 'error'; mode: AllocateMode; error: unknown };

/** 自動振り分け・最小変更で再実行を押せない理由（押せるなら null）。disabled はボタンを押せないこと */
export function autoBlockOf(p: {
  allocating: boolean;
  running: boolean;
  dirty: boolean;
  problemCount: number;
  unverified: boolean;
  engineState: EngineState;
}): { disabled: boolean; reason: string | null } {
  if (!p.allocating) return { disabled: true, reason: null };
  if (p.running) return { disabled: true, reason: null };
  if (p.dirty) return { disabled: true, reason: '保存していない変更があります。先に保存するか取り消してください' };
  if (p.problemCount > 0) return { disabled: true, reason: '入力に誤りがあるので、自動振り分けはできません（下の一覧を直してください）' };
  if (p.unverified) return { disabled: true, reason: '前の保存が保存されたか確かめるまで、もう一度実行できません' };
  // idle（開いた直後で warmup の前・「中止」で Worker を止めた後）は押せる：start が engine を読み込んでから計算する（次の run で作り直す）
  if (p.engineState === 'loading') return { disabled: true, reason: '計算エンジンを読み込み中（初回だけ。約 1.2 MB）' };
  return { disabled: false, reason: null };
}

export interface AutoRunDeps {
  engine: AllocatorEngine | null;
  /** スナップショットを版から読み直す（loadSnapshot(yearId, 'full')） */
  loadFresh: () => Promise<Snapshot>;
  /** 読み直したスナップショットを画面に出す（React Query のキャッシュに入れる） */
  publish: (s: Snapshot) => void;
  save: (args: { rows: AllocationRow[]; mode: AllocateMode; baseVersion: number }) => Promise<SaveAutoAllocationsResult>;
  readVersion: () => Promise<number>;
  /** 保存が拒まれたときなどの読み直し（スナップショットと、state なら年度の行と立場） */
  reload: (error: unknown) => Promise<void>;
  /** 今持っているスナップショットの版（中止の後に進んだかを見る） */
  heldVersion: () => number | null;
}

export interface AutoRunState {
  running: boolean;
  mode: AllocateMode | null;
  phase: AutoPhase | null;
  startedAt: number | null;
  outcome: AutoOutcome | null;
}

const isUnknownSave = (e: unknown) => {
  const c = classifyError(e);
  return c.kind === 'network' || (c.kind === 'unknown' && c.reason !== 'unexpected_response');
};

/**
 * 自動振り分けの流れ（純粋な部分は lib/allocation。ここは段階・中止・保存されたか分からないときの確かめ）。
 */
export function useAutoAllocation(deps: AutoRunDeps) {
  const [state, setState] = useState<AutoRunState>({ running: false, mode: null, phase: null, startedAt: null, outcome: null });
  const cancelRef = useRef<(() => void) | null>(null);
  const depsRef = useRef(deps);
  useLayoutEffect(() => {
    depsRef.current = deps;
  });

  // 計算中・保存中は画面を離れるときに確かめる（送った保存は止まらない）
  useUnsavedChanges(state.running);

  const finish = useCallback((outcome: AutoOutcome) => {
    cancelRef.current = null;
    setState({ running: false, mode: outcome.mode, phase: null, startedAt: null, outcome });
  }, []);

  /** 保存の応答が届かなかったとき：版を読み直し、進んでいれば読み直した行と突き合わせる（2.6・3.9） */
  const verify = useCallback(
    async (o: Extract<AutoOutcome, { kind: 'unverified' }>) => {
      const d = depsRef.current;
      let v: number;
      try {
        v = await d.readVersion();
      } catch {
        finish(o);
        return;
      }
      if (v === o.baseVersion) {
        finish({ kind: 'not-saved', mode: o.mode, otherChange: false });
        return;
      }
      try {
        const s = await d.loadFresh();
        d.publish(s);
        if (autoRowsMatch(s.allocations, o.rows)) {
          finish({
            kind: 'saved',
            mode: o.mode,
            counts: { allocation_version: s.version, deleted: 0, updated: 0, inserted: 0 },
            elapsedMs: o.result.elapsedMs,
            loadMs: o.loadMs,
            wallMs: o.wallMs,
            excludedRequests: o.result.stats.excludedRequests,
            verified: true,
          });
        } else {
          finish({ kind: 'not-saved', mode: o.mode, otherChange: true });
        }
      } catch {
        finish(o);
      }
    },
    [finish],
  );

  const start = useCallback(
    async (mode: AllocateMode) => {
      const d = depsRef.current;
      const engine = d.engine;
      const startedAt = Date.now();
      let phase: AutoPhase = 'preparing';
      const setPhase = (p: AutoPhase) => {
        phase = p;
        setState({ running: true, mode, phase: p, startedAt, outcome: null });
      };
      let rejectCancel: (e: unknown) => void = () => {};
      const cancelled = new Promise<never>((_, reject) => {
        rejectCancel = reject;
      });
      cancelled.catch(() => {});
      cancelRef.current = () => {
        if (!CANCELLABLE_PHASES.includes(phase)) return;
        if (phase === 'loading' || phase === 'solving') engine?.cancel();
        rejectCancel(new EngineCancelledError());
      };
      const heldBefore = d.heldVersion();

      try {
        if (!engine) {
          finish({ kind: 'failure', mode, result: solverErrorResult('計算エンジンを使えません。ページを再読み込みしてください') as Extract<AllocateResult, { ok: false }> });
          return;
        }
        if (engine.state() !== 'ready') {
          setPhase('loading');
          const w = await Promise.race([engine.warmup(), cancelled]);
          if (!w.ok) {
            finish({ kind: 'failure', mode, result: solverErrorResult(w.message) as Extract<AllocateResult, { ok: false }> });
            return;
          }
        }
        setPhase('preparing');
        const snap = await Promise.race([d.loadFresh(), cancelled]);
        d.publish(snap);
        const { input, problems } = buildAllocateInput(snap, mode);
        if (problems.length > 0) {
          finish({ kind: 'problems', mode, problems });
          return;
        }
        setPhase('solving');
        const out = await Promise.race([
          engine.run(input, { onPhase: (p) => setPhase(p === 'loading' ? 'loading' : 'solving') }),
          cancelled,
        ]);
        try {
          performance.measure('allocate', { start: performance.now() - out.wallMs, duration: out.wallMs, detail: { elapsedMs: out.result.elapsedMs, loadMs: out.loadMs } });
        } catch {
          // performance.measure の detail を持たない環境では残さない
        }
        if (!out.result.ok) {
          finish({ kind: 'failure', mode, result: out.result });
          return;
        }
        // ここから先は中止しない（保存を送った後は止められない）
        cancelRef.current = null;
        setPhase('saving');
        let counts: SaveAutoAllocationsResult;
        try {
          counts = await d.save({ rows: out.result.rows, mode, baseVersion: snap.version });
        } catch (e) {
          if (isUnknownSave(e)) {
            await verify({ kind: 'unverified', mode, rows: out.result.rows, baseVersion: snap.version, result: out.result, loadMs: out.loadMs, wallMs: out.wallMs });
            return;
          }
          await d.reload(e).catch(() => {});
          finish({ kind: 'save-error', mode, error: e });
          return;
        }
        setPhase('reloading');
        const saved: AutoOutcome = {
          kind: 'saved',
          mode,
          counts,
          elapsedMs: out.result.elapsedMs,
          loadMs: out.loadMs,
          wallMs: out.wallMs,
          excludedRequests: out.result.stats.excludedRequests,
        };
        try {
          d.publish(await d.loadFresh());
        } catch (e) {
          finish({ kind: 'error', mode, error: e });
          return;
        }
        finish(saved);
      } catch (e) {
        if (e instanceof EngineCancelledError) {
          finish({ kind: 'cancelled', mode });
          // 中止の後は版を読み直し、進んでいればスナップショットを読み直す
          try {
            const v = await d.readVersion();
            if (heldBefore === null || v > heldBefore) d.publish(await d.loadFresh());
          } catch {
            // 読めなければ版の見張り（StaleBanner）に任せる
          }
          return;
        }
        finish({ kind: 'error', mode, error: e });
      }
    },
    [finish, verify],
  );

  const cancel = useCallback(() => cancelRef.current?.(), []);
  const recheck = useCallback(() => {
    const o = state.outcome;
    if (o?.kind !== 'unverified') return;
    setState((s) => ({ ...s, running: true, phase: 'saving', startedAt: Date.now() }));
    void verify(o);
  }, [state.outcome, verify]);
  const dismiss = useCallback(() => setState((s) => (s.running ? s : { ...s, outcome: null })), []);

  return { state, start, cancel, recheck, dismiss };
}

/** 経過時間（ミリ秒）。動いている間だけ 250 ms ごとに進める */
function useElapsed(startedAt: number | null): number {
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    if (startedAt === null) return;
    const t = setInterval(() => setNow(Date.now()), 250);
    return () => clearInterval(t);
  }, [startedAt]);
  return startedAt === null ? 0 : Math.max(0, now - startedAt);
}

/**
 * 計算中は押せなくする画面の本体（ツールバー・表・検証の一覧・未保存の変更のバーなど）を包む。
 * running の間は inert（クリックもフォーカスも届かない。Tab で背景の確定・行の操作に届かない）と aria-busy。
 */
export function RunInert({ running, children, className }: { running: boolean; children: React.ReactNode; className?: string }) {
  return (
    <div data-testid="run-inert" inert={running} aria-busy={running || undefined} className={className}>
      {children}
    </div>
  );
}

const FOCUSABLE = 'button:not([disabled]), a[href], input:not([disabled]), select:not([disabled]), textarea:not([disabled]), [tabindex]:not([tabindex="-1"])';

/**
 * ロックを出している間、フォーカスをロックの中に留める：出したときにロック（tabIndex=-1）へ移し、
 * Tab・Shift+Tab はロックの中の押せるもの（「中止」）を回る（なければロックに留まる）。フォーカスがロックの外にあっても
 * Tab でロックへ戻す（アプリのヘッダーなど RunInert の外も含む）。
 */
function useLockFocus(ref: React.RefObject<HTMLDivElement | null>, shown: boolean): void {
  useEffect(() => {
    if (!shown) return;
    const lock = ref.current;
    if (lock && !lock.contains(document.activeElement)) lock.focus();
    const onKey = (e: KeyboardEvent) => {
      if (e.key !== 'Tab') return;
      const el = ref.current;
      if (!el) return;
      e.preventDefault();
      const items = [...el.querySelectorAll<HTMLElement>(FOCUSABLE)];
      if (items.length === 0) {
        el.focus();
        return;
      }
      const k = items.indexOf(document.activeElement as HTMLElement);
      const next = e.shiftKey ? (k <= 0 ? items[items.length - 1] : items[k - 1]) : k === -1 || k === items.length - 1 ? items[0] : items[k + 1];
      next?.focus();
    };
    document.addEventListener('keydown', onKey, true);
    return () => document.removeEventListener('keydown', onKey, true);
  }, [ref, shown]);
}

/**
 * ロックを出している間、ロックの外のすべて（アプリのヘッダー・ナビゲーション・通知を含む）を inert にする。
 * ロックから body までの祖先をたどり、各段の兄弟の要素に inert を付ける（aria-modal だけではスクリーンリーダーの
 * ブラウズモードから届くため）。出している間に body へ足された要素（ポータル）にも付ける。
 * 付けたものだけを外す（RunInert など、もとから inert のものはそのまま）。
 */
function useInertOutside(ref: React.RefObject<HTMLDivElement | null>, shown: boolean): void {
  useEffect(() => {
    if (!shown) return;
    const lock = ref.current;
    if (!lock) return;
    const added: Element[] = [];
    const path = new Set<Element>();
    const mark = (el: Element) => {
      if (path.has(el) || el.hasAttribute('inert') || el instanceof HTMLScriptElement) return;
      el.setAttribute('inert', '');
      added.push(el);
    };
    for (let node: Element = lock; node.parentElement && node !== document.body; node = node.parentElement) {
      path.add(node);
      for (const sib of node.parentElement.children) if (sib !== node) mark(sib);
    }
    const observer = new MutationObserver((records) => {
      for (const r of records) for (const n of r.addedNodes) if (n instanceof Element) mark(n);
    });
    observer.observe(document.body, { childList: true });
    return () => {
      observer.disconnect();
      for (const el of added) el.removeAttribute('inert');
    };
  }, [ref, shown]);
}

/**
 * 計算中のロック（全面のオーバーレイ）。段階と経過秒数を出し、中止できる段階で 10 秒を過ぎたら「中止」を出す。
 * 出したときにフォーカスをロックへ移し、Tab でロックの外へ出さない。ロックの外（本体の RunInert に加えて、
 * アプリのヘッダー・ナビゲーションなど）は inert にし、スクリーンリーダーからも届かなくする（useInertOutside）。
 */
export function AutoRunLock({ state, onCancel }: { state: AutoRunState; onCancel: () => void }) {
  const elapsed = useElapsed(state.running ? state.startedAt : null);
  const ref = useRef<HTMLDivElement>(null);
  const shown = state.running && state.phase !== null;
  useLockFocus(ref, shown);
  useInertOutside(ref, shown);
  if (!state.running || !state.phase) return null;
  const current = PHASES.findIndex((p) => p.phase === state.phase);
  const canCancel = CANCELLABLE_PHASES.includes(state.phase) && elapsed >= CANCEL_AFTER_MS;
  return (
    <div
      ref={ref}
      role="alertdialog"
      aria-modal="true"
      aria-busy="true"
      aria-labelledby="allocate-lock-title"
      aria-describedby="allocate-lock-elapsed"
      tabIndex={-1}
      data-testid="allocate-lock"
      data-phase={state.phase}
      className="fixed inset-0 z-50 flex items-center justify-center bg-background/80 p-4 outline-none backdrop-blur-sm"
    >
      <div className="w-full max-w-md space-y-4 rounded-lg border bg-card p-6 shadow-lg">
        <div className="flex items-center gap-2">
          <Loader2 aria-hidden className="size-5 animate-spin" />
          <h2 id="allocate-lock-title" className="text-lg font-bold">
            {state.mode ? MODE_LABELS[state.mode] : '振り分け'}中…
          </h2>
        </div>
        <ol className="space-y-1 text-sm">
          {PHASES.map((p, k) => (
            <li
              key={p.phase}
              aria-current={k === current ? 'step' : undefined}
              className={k === current ? 'font-bold text-foreground' : k < current ? 'text-muted-foreground line-through' : 'text-muted-foreground'}
            >
              {'①②③④⑤'[k]} {p.label}
              {k === current && p.phase === 'saving' ? '（保存中…）' : ''}
            </li>
          ))}
        </ol>
        <p id="allocate-lock-elapsed" className="text-sm text-muted-foreground" data-testid="allocate-lock-elapsed">
          経過 {Math.floor(elapsed / 1000)} 秒
        </p>
        {state.phase === 'saving' ? (
          <p className="text-sm">保存を送りました。結果を待っています（この段階では中止できません）。</p>
        ) : null}
        {canCancel ? (
          <Button variant="outline" onClick={onCancel}>
            中止
          </Button>
        ) : null}
      </div>
    </div>
  );
}
