// 検証を主スレッドで回す（画面の設計 1.5・2.7・3.9。T09a）。R8 規模で validate は数十 ms なので Worker に入れない。
import { validate } from '@gaapp/allocator';
import type { InputError, Issue, StoredAllocationRow } from '@gaapp/shared';
import { useEffect, useMemo, useState } from 'react';
import type { Snapshot } from './snapshot';
import { toStoredRows, toYearData, type ToYearDataResult } from './year-data';

export interface ValidationResult {
  /** ok：検証した。unavailable：入力の誤りで検証できない（problems を出す）。skipped：viewer（part = public）なので検証しない */
  status: 'ok' | 'unavailable' | 'skipped';
  /** validate の結果（error → warning → info の順のまま） */
  issues: Issue[];
  /** toYearData の problems（壊れたルール・参照の切れたルール・空の建物など） */
  problems: InputError[];
  /** 検証したスナップショットの版（確定の流れで「検証した版が v」を確かめる。3.1） */
  version: number | null;
}

export const UNVALIDATABLE_PROBLEM: InputError = { path: 'validate', message: '検証できません（入力に誤りがあります）' };

/**
 * 純粋関数の本体：validatable が偽なら validate を呼ばない。validate が例外を投げても problems を出す
 * （problems が空なら「検証できません」を1件足す）。
 */
export function runValidation(y: ToYearDataResult, rows: readonly StoredAllocationRow[], version: number | null = null): ValidationResult {
  if (!y.validatable) {
    return { status: 'unavailable', issues: [], problems: y.problems.length > 0 ? y.problems : [UNVALIDATABLE_PROBLEM], version };
  }
  try {
    return { status: 'ok', issues: validate(y.data, rows), problems: y.problems, version };
  } catch {
    return { status: 'unavailable', issues: [], problems: y.problems.length > 0 ? y.problems : [UNVALIDATABLE_PROBLEM], version };
  }
}

function useDebounced<T>(value: T, delayMs: number, enabled: boolean): T {
  const [v, setV] = useState(value);
  useEffect(() => {
    if (!enabled) return;
    const t = setTimeout(() => setV(value), delayMs);
    return () => clearTimeout(t);
  }, [value, delayMs, enabled]);
  return enabled ? v : value;
}

/**
 * スナップショットの行（または未保存の変更を当てた行 extraRows）で検証する。extraRows があるときは
 * 150 ms まとめてから回す（入力のたびに回さない）。extraRows は同じ配列を渡し続ける（useMemo で作る）。
 *
 * @example
 * const rows = useMemo(() => applyPending(stored.rows, pending), [stored, pending]);
 * const v = useValidation(snapshot, pending.length > 0 ? rows : undefined);
 */
export function useValidation(snapshot: Snapshot | undefined, extraRows?: readonly StoredAllocationRow[]): ValidationResult & { yearData: ToYearDataResult | null } {
  const yearData = useMemo(() => (snapshot && snapshot.part === 'full' ? toYearData(snapshot) : null), [snapshot]);
  const stored = useMemo(() => (snapshot ? toStoredRows(snapshot).rows : []), [snapshot]);
  const rows = useDebounced(extraRows ?? stored, 150, extraRows !== undefined);
  return useMemo(() => {
    if (!snapshot) return { status: 'skipped', issues: [], problems: [], version: null, yearData: null };
    if (!yearData) return { status: 'skipped', issues: [], problems: [], version: snapshot.version, yearData: null };
    return { ...runValidation(yearData, rows, snapshot.version), yearData };
  }, [snapshot, yearData, rows]);
}
