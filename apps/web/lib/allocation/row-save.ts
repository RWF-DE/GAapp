// 未保存の変更の保存（save_allocation_rows）と、応答が届かなかったときの確かめ（画面の設計 3.9・2.6、D-34。T13 の段 2）。
// 画面に依存しない流れ（読み書きは deps で受ける。Vitest で偽物を渡す）。
// - 送る：save_allocation_rows(p_year_id, p_changes, p_reason)。理由は必須、楽観ロック（update・delete に updatedAt）、数は 1 以上。
// - 拒まれた（conflict・E002・invalid_input・invalid_state など）：そのまま返す（画面が読み直し・当て直し・文言を決める）。
// - 応答が届かなかった（network・unknown・unexpected_response）：insert に冪等の鍵がないので、そのまま送り直すと行が二重にできる。
//   (1) 年度の版を読み直す（読めなければ unverified：「確かめる」まで送り直させない）。
//   (2) 持っている版と同じなら保存されていない（save_allocation_rows は通れば必ず版を上げる）→ not-saved（同じ変更を送り直してよい）。
//   (3) 進んでいればスナップショットを読み直し、reconcileAfterUnknown で突き合わせる（all：保存されていた、none：ほかの人の変更、
//       partial：一部だけが当たって見える。決めきれないので管理者に選んでもらう）。
import type { Snapshot } from '@/lib/data/snapshot';
import { toStoredRows, type StoredRows } from '@/lib/data/year-data';
import { classifyError } from '@/lib/errors';
import type { AllocationChange, SaveAllocationRowsResult } from '@/lib/rpc/payloads';
import { reconcileAfterUnknown, toRpcChanges, type PendingChange } from './pending';

export interface RowSaveDeps {
  save: (changes: AllocationChange[], reason: string) => Promise<SaveAllocationRowsResult>;
  /** years.allocation_version を読む */
  readVersion: () => Promise<number>;
  /** スナップショットを版から読み直す（loadSnapshot(yearId, 'full')） */
  loadFresh: () => Promise<Snapshot>;
}

export type UnknownCheck =
  /** 版が同じ：保存されていない。同じ変更をそのまま送り直してよい */
  | { kind: 'not-saved' }
  /** 版が進んでいて、すべて反映済み：保存されていた */
  | { kind: 'was-saved'; snapshot: Snapshot }
  /** 版が進んでいたが、どれも反映されていない：ほかの人の変更。読み直した行に当て直して送り直してもらう */
  | { kind: 'other-change'; snapshot: Snapshot }
  /** 一部だけが反映済みに見える：決めきれないので、反映済みに見えるものと残りを並べて選んでもらう */
  | { kind: 'partial'; snapshot: Snapshot; applied: PendingChange[]; remaining: PendingChange[] }
  /** 版を読めない（通信が戻ったら「確かめる」） */
  | { kind: 'unverified' };

export type RowSaveOutcome =
  | { kind: 'saved'; result: SaveAllocationRowsResult }
  | { kind: 'rejected'; error: unknown }
  | UnknownCheck;

/** 応答が届かず、保存されたか分からないエラーか（network・unknown。unexpected_response は通った応答の形が違うだけなので、確かめれば分かる） */
export function isUnknownOutcome(e: unknown): boolean {
  const c = classifyError(e);
  return c.kind === 'network' || c.kind === 'unknown';
}

/**
 * 保存されたか分からないときの確かめ（「確かめる」もこれを呼ぶ）。
 * @param before 送ったときに持っていたスナップショットの行（突き合わせの「前」）
 */
export async function checkAfterUnknown(
  deps: Pick<RowSaveDeps, 'readVersion' | 'loadFresh'>,
  pending: readonly PendingChange[],
  heldVersion: number,
  before: StoredRows,
): Promise<UnknownCheck> {
  let version: number;
  try {
    version = await deps.readVersion();
  } catch {
    return { kind: 'unverified' };
  }
  if (version === heldVersion) return { kind: 'not-saved' };
  let snapshot: Snapshot;
  try {
    snapshot = await deps.loadFresh();
  } catch {
    return { kind: 'unverified' };
  }
  const r = reconcileAfterUnknown(pending, before, toStoredRows(snapshot));
  if (r.status === 'all') return { kind: 'was-saved', snapshot };
  if (r.status === 'none') return { kind: 'other-change', snapshot };
  return { kind: 'partial', snapshot, applied: r.applied, remaining: r.remaining };
}

/** 送って、応答が届かなければ確かめる */
export async function saveRows(
  deps: RowSaveDeps,
  args: { pending: readonly PendingChange[]; reason: string; heldVersion: number; before: StoredRows },
): Promise<RowSaveOutcome> {
  try {
    const result = await deps.save(toRpcChanges(args.pending), args.reason);
    return { kind: 'saved', result };
  } catch (e) {
    if (!isUnknownOutcome(e)) return { kind: 'rejected', error: e };
    return checkAfterUnknown(deps, args.pending, args.heldVersion, args.before);
  }
}

/**
 * 保存の返り値をスナップショットに当てる（allocation_version_before が持っている版と同じとき）。
 * 返った行で置き換え（insert は足す、delete は消す）、版を allocation_version にする。違えば null（読み直す）。
 */
export function applySaveResult(snapshot: Snapshot, result: SaveAllocationRowsResult): Snapshot | null {
  if (result.allocation_version_before !== snapshot.version) return null;
  const rows = new Map(snapshot.allocations.map((a) => [a.id, a]));
  for (const r of result.rows) {
    if (r.op === 'delete') rows.delete(r.id);
    else rows.set(r.row.id, r.row);
  }
  return {
    ...snapshot,
    allocations: [...rows.values()],
    version: result.allocation_version,
    year: { ...snapshot.year, allocation_version: result.allocation_version },
  };
}
