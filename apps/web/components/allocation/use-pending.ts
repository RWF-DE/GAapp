'use client';

// 振り分けの行の未保存の変更を持つ（画面の設計 3.9 の「行の操作」、D-33・D-34。T13 の段 2）。
// - スナップショットが変わったら（読み直し・ほかの人の変更・保存の後）、rebasePending で当て直す。外れた変更は一覧で知らせる。
// - 下書き（lib/drafts.ts）：変更のたびに 500 ms まとめて写す。開いたときに下書きがあれば DraftNotice（戻すと当て直す）。
// - 保存：lib/allocation/row-save.ts の saveRows（応答が届かなければ版で確かめる。確かめるまで送り直させず、未保存の変更も変えさせない）。
import { useQueryClient } from '@tanstack/react-query';
import { useCallback, useEffect, useMemo, useState } from 'react';
import { toast } from 'sonner';
import { useAuth } from '@/lib/auth/auth-provider';
import { saveAllocationRows } from '@/lib/data/allocation';
import { loadSnapshot, type Snapshot } from '@/lib/data/snapshot';
import { fetchYearVersion } from '@/lib/data/year';
import { toStoredRows, type StoredRows } from '@/lib/data/year-data';
import { createDraftWriter, loadDraft, removeDraft, type Draft, type DraftKey } from '@/lib/drafts';
import { classifyError, effectOf } from '@/lib/errors';
import { queryKeys } from '@/lib/query';
import { useUnsavedChanges } from '@/lib/unsaved-changes';
import {
  applyPending,
  editPending,
  MAX_CHANGES,
  pendingListSchema,
  pendingSummary,
  rebasePending,
  removeChanges,
  revertRow,
  type DroppedChange,
  type PendingChange,
  type PendingEdit,
} from '@/lib/allocation/pending';
import { applySaveResult, checkAfterUnknown, saveRows, type RowSaveDeps } from '@/lib/allocation/row-save';

/**
 * 保存されたか確かめられない（unverified）間は、未保存の変更を変える操作（行の編集・追加・元に戻す・取り消す・下書きを戻す）を
 * 受け付けない理由（設計 2.6 の (B2)・3.9）。「確かめる」は送った時点の変更で判定して未保存の変更を置き換えるので、
 * 待っている間の編集が知らせなく消えたり、取り消した変更が戻ったりしないように
 */
export const EDIT_BLOCKED_UNVERIFIED = '保存されたかを確かめるまで、編集できません。「確かめる」を押してください';

/** 行の保存が conflict で拒まれ、読み直して当て直したとき */
export const CONFLICT_REAPPLIED = '他の人が変更しました。読み直して、ぶつからない変更を当て直しました';
/** 行の保存が conflict で拒まれたが、読み直せなかったとき（当て直したとは言わない。変更は残す） */
export const CONFLICT_UNREAD = '他の人が変更しました。読み直せませんでした。「読み直す」を押してください';

/** refetch して、読み直せたか（isError でなく、投げなかった） */
async function refetchOk(refetch: () => Promise<{ isError?: boolean } | undefined>): Promise<boolean> {
  try {
    const r = await refetch();
    return !r?.isError;
  } catch {
    return false;
  }
}

/** スナップショットの見分け（同じ版・同じ読み込みなら当て直さない） */
const snapKey = (s: Snapshot) => `${s.version}|${s.loadedAt}`;

export type PendingNotice =
  /** 応答が届かず、版が同じだった（保存されていない）。もう一度保存してよい */
  | { kind: 'not-saved' }
  /** 版を読めない。「確かめる」まで保存を押せない */
  | { kind: 'unverified'; pending: PendingChange[]; heldVersion: number; before: StoredRows }
  /** 一部だけが反映済みに見える。選んでもらうまで保存を押せない */
  | { kind: 'partial'; applied: PendingChange[]; remaining: PendingChange[] }
  /** ほかの人の変更で版が進んでいた（保存されていない）。当て直したので、もう一度保存してもらう */
  | { kind: 'other-change' }
  /** 拒まれた（文言は ErrorBanner） */
  | { kind: 'rejected'; error: unknown };

interface State {
  baseKey: string;
  pending: PendingChange[];
}

export interface PendingApi {
  pending: PendingChange[];
  /** 未保存の変更を当てた行（画面と検証に使う） */
  rows: ReturnType<typeof applyPending>;
  /** 今の DB の行（updated_at つき） */
  stored: StoredRows;
  /** 未保存の変更を変える（editBlock があれば何もしない） */
  edit: (e: PendingEdit) => void;
  revert: (rowId: string) => void;
  discardAll: () => void;
  /** 未保存の変更を変える操作（編集・追加・元に戻す・取り消す）を押せないときの理由（null なら押せる） */
  editBlock: string | null;
  /** 保存する（理由は必須）。理由の誤りのときは例外（ReasonDialog を開いたままにする） */
  save: (reason: string) => Promise<void>;
  saving: boolean;
  /** 保存を押せないときの理由（null なら押せる） */
  saveBlock: string | null;
  notice: PendingNotice | null;
  dismissNotice: () => void;
  /** 読み直しで外した変更（「ほかの人の変更とぶつかったので外しました」） */
  dropped: DroppedChange[];
  dismissDropped: () => void;
  recheck: () => Promise<void>;
  /** 部分的に反映済みのときの選択：残りを残す・残りも取り消す（知らせの残りだけを外し、知らせの後の編集は残す） */
  resolvePartial: (keepRemaining: boolean) => void;
  draft: { savedAt: number; restore: () => void; discard: () => void } | null;
}

export function usePendingRows({
  snapshot,
  refetch,
  editable,
}: {
  snapshot: Snapshot;
  /** 読み直す（react-query の refetch。結果の isError で読み直せたかを見る） */
  refetch: () => Promise<{ isError?: boolean } | undefined>;
  editable: boolean;
}): PendingApi {
  const yearId = snapshot.year.id;
  const queryClient = useQueryClient();
  const { session, reloadMembership } = useAuth();
  const userId = session.status === 'signedIn' ? session.session.user.id : null;

  const stored = useMemo(() => toStoredRows(snapshot), [snapshot]);
  const locationOf = useMemo(() => {
    const loc = new Map(snapshot.groups.map((g) => [g.id, g.location_room_id]));
    return (groupId: string) => loc.get(groupId);
  }, [snapshot.groups]);

  // ---- 変更とスナップショットの組（スナップショットが変われば当て直す） ----
  const [state, setState] = useState<State>(() => ({ baseKey: snapKey(snapshot), pending: [] }));
  const [dropped, setDropped] = useState<DroppedChange[]>([]);
  const key = snapKey(snapshot);
  if (state.baseKey !== key) {
    // 描画の中で前の値から決め直す（React の「前の props を state に持つ」形）
    const r = state.pending.length > 0 ? rebasePending(state.pending, stored) : { pending: [], dropped: [] };
    setState({ baseKey: key, pending: r.pending });
    if (r.dropped.length > 0) setDropped((d) => [...d, ...r.dropped]);
  }
  const pending = state.pending;
  const setPending = useCallback((f: (p: PendingChange[]) => PendingChange[]) => setState((s) => ({ ...s, pending: f(s.pending) })), []);

  const rows = useMemo(() => applyPending(stored.rows, pending, locationOf), [stored, pending, locationOf]);
  useUnsavedChanges(pending.length > 0);

  // ---- 下書き ----
  const draftKey = useMemo<DraftKey | null>(() => (userId ? { userId, yearId, screen: 'allocation' } : null), [userId, yearId]);
  const writer = useMemo(() => (draftKey ? createDraftWriter<{ pending: PendingChange[] }>(draftKey) : null), [draftKey]);
  // 開いたときの下書き（あれば DraftNotice。戻すか捨てるかを決めるまで、下書きを上書きしない）
  const [draftState, setDraftState] = useState<{ draft: Draft<{ pending: PendingChange[] }> | null; decided: boolean }>(() => {
    if (!draftKey || !editable) return { draft: null, decided: true };
    const d = loadDraft<{ pending: PendingChange[] }>(draftKey);
    if (d && pendingListSchema.safeParse(d.value?.pending).success && d.value.pending.length > 0) return { draft: d, decided: false };
    if (d) removeDraft(draftKey);
    return { draft: null, decided: true };
  });
  const draft = draftState.draft;
  const draftDecided = draftState.decided;
  useEffect(() => {
    if (!writer || !draftDecided) return;
    if (pending.length > 0) writer.write({ pending });
    else writer.clear();
  }, [writer, pending, draftDecided]);
  useEffect(() => () => writer?.flush(), [writer]);

  const restoreDraft = useCallback(() => {
    if (!draft) return;
    const parsed = pendingListSchema.safeParse(draft.value.pending);
    const list = parsed.success ? (parsed.data as PendingChange[]) : [];
    const r = rebasePending(list, stored);
    setState({ baseKey: snapKey(snapshot), pending: r.pending });
    setDraftState({ draft: null, decided: true });
    toast.info(`保存していない変更 ${r.pending.length} 件を戻しました（当て直せなかったもの ${r.dropped.length} 件）`);
    if (r.dropped.length > 0) setDropped(r.dropped);
  }, [draft, stored, snapshot]);
  const discardDraft = useCallback(() => {
    if (draftKey) removeDraft(draftKey);
    setDraftState({ draft: null, decided: true });
  }, [draftKey]);

  // ---- 編集 ----
  const [notice, setNotice] = useState<PendingNotice | null>(null);
  // 確かめられない間は、未保存の変更を変えない（画面のボタンも押せなくするが、ここでも止める）
  const editBlock = notice?.kind === 'unverified' ? EDIT_BLOCKED_UNVERIFIED : null;
  const blocked = editBlock !== null;
  const edit = useCallback(
    (e: PendingEdit) => {
      if (blocked) return;
      setPending((p) => editPending(p, e, stored));
    },
    [blocked, setPending, stored],
  );
  const revert = useCallback(
    (rowId: string) => {
      if (blocked) return;
      setPending((p) => revertRow(p, rowId));
    },
    [blocked, setPending],
  );
  const discardAll = useCallback(() => {
    if (blocked) return;
    setPending(() => []);
    setDropped([]);
    setNotice(null);
  }, [blocked, setPending]);

  // ---- 保存 ----
  const [saving, setSaving] = useState(false);
  const deps: RowSaveDeps = useMemo(
    () => ({
      save: (changes, reason) => saveAllocationRows({ yearId, changes, reason }),
      readVersion: () => fetchYearVersion(yearId),
      loadFresh: () => loadSnapshot(yearId, 'full'),
    }),
    [yearId],
  );
  const publish = useCallback((s: Snapshot) => queryClient.setQueryData(queryKeys.snapshot(yearId, 'full'), s), [queryClient, yearId]);

  const afterReject = useCallback(
    async (error: unknown) => {
      const c = classifyError(error);
      const eff = effectOf(c);
      // 読み直せたか（読み直さなかったときは true）。読み直せなければ、当て直したとは言わない
      let reloaded = true;
      if (eff.reload === 'year') {
        await queryClient.invalidateQueries({ queryKey: queryKeys.year(yearId) });
        reloadMembership();
      } else if (eff.reload === 'data') {
        reloaded = await refetchOk(refetch);
      }
      if (c.kind === 'conflict') {
        if (reloaded) toast.warning(CONFLICT_REAPPLIED);
        else toast.error(CONFLICT_UNREAD);
        setNotice(null);
        return;
      }
      setNotice({ kind: 'rejected', error });
    },
    [queryClient, yearId, reloadMembership, refetch],
  );

  /** 確かめた結果を画面に当てる（保存の後と「確かめる」の後で共通） */
  const applyCheck = useCallback(
    (out: Awaited<ReturnType<typeof checkAfterUnknown>>, sent: PendingChange[], heldVersion: number, before: StoredRows) => {
      switch (out.kind) {
        case 'not-saved':
          setNotice({ kind: 'not-saved' });
          return;
        case 'unverified':
          setNotice({ kind: 'unverified', pending: sent, heldVersion, before });
          return;
        case 'was-saved':
          setState({ baseKey: snapKey(out.snapshot), pending: [] });
          publish(out.snapshot);
          setNotice(null);
          toast.success('保存されていました（応答が届かなかったので、読み直して確かめました）');
          return;
        case 'other-change': {
          const r = rebasePending(sent, toStoredRows(out.snapshot));
          setState({ baseKey: snapKey(out.snapshot), pending: r.pending });
          if (r.dropped.length > 0) setDropped((d) => [...d, ...r.dropped]);
          publish(out.snapshot);
          setNotice({ kind: 'other-change' });
          return;
        }
        case 'partial': {
          const r = rebasePending(out.remaining, toStoredRows(out.snapshot));
          setState({ baseKey: snapKey(out.snapshot), pending: r.pending });
          if (r.dropped.length > 0) setDropped((d) => [...d, ...r.dropped]);
          publish(out.snapshot);
          setNotice({ kind: 'partial', applied: out.applied, remaining: r.pending });
          return;
        }
      }
    },
    [publish],
  );

  const save = useCallback(
    async (reason: string) => {
      if (pending.length === 0 || saving) return;
      const sent = pending;
      const heldVersion = snapshot.version;
      const before = stored;
      setSaving(true);
      setNotice(null);
      try {
        const out = await saveRows(deps, { pending: sent, reason, heldVersion, before });
        if (out.kind === 'saved') {
          const s = toastCounts(sent);
          const next = applySaveResult(snapshot, out.result);
          setState((st) => ({ baseKey: next ? snapKey(next) : st.baseKey, pending: [] }));
          setDropped([]);
          if (next) publish(next);
          else await refetch();
          toast.success(`保存しました（${s}）`);
          return;
        }
        if (out.kind === 'rejected') {
          if (classifyError(out.error).kind === 'reason') {
            setNotice({ kind: 'rejected', error: out.error });
            throw out.error; // 理由の欄に戻す（ReasonDialog を開いたまま）
          }
          await afterReject(out.error);
          return;
        }
        applyCheck(out, sent, heldVersion, before);
      } finally {
        setSaving(false);
      }
    },
    [pending, saving, snapshot, stored, deps, publish, refetch, afterReject, applyCheck],
  );

  const recheck = useCallback(async () => {
    if (notice?.kind !== 'unverified') return;
    setSaving(true);
    try {
      const out = await checkAfterUnknown(deps, notice.pending, notice.heldVersion, notice.before);
      applyCheck(out, notice.pending, notice.heldVersion, notice.before);
    } finally {
      setSaving(false);
    }
  }, [notice, deps, applyCheck]);

  // 「残りも取り消す」は、知らせの残り（notice.remaining）だけを外す。知らせの後にした編集（足した・直した変更）は残す
  const resolvePartial = useCallback(
    (keepRemaining: boolean) => {
      if (notice?.kind !== 'partial') return;
      if (!keepRemaining) {
        const remaining = notice.remaining;
        setPending((p) => removeChanges(p, remaining));
      }
      setNotice(null);
    },
    [notice, setPending],
  );

  const saveBlock =
    notice?.kind === 'unverified'
      ? '保存できたか確かめるまで、もう一度保存できません'
      : notice?.kind === 'partial'
        ? '反映済みに見える変更があります。残りをどうするか選んでください'
        : pending.length > MAX_CHANGES
          ? '変更が多すぎます。保存してから続けてください（1000 件まで）'
          : null;

  return {
    pending,
    rows,
    stored,
    edit,
    revert,
    discardAll,
    editBlock,
    save,
    saving,
    saveBlock,
    notice,
    dismissNotice: () => setNotice(null),
    dropped,
    dismissDropped: () => setDropped([]),
    recheck,
    resolvePartial,
    // 確かめられない間は下書きを戻させない（戻すと未保存の変更が置き換わる）
    draft: draft && !draftDecided && !blocked ? { savedAt: draft.savedAt, restore: restoreDraft, discard: discardDraft } : null,
  };
}

function toastCounts(p: readonly PendingChange[]): string {
  const s = pendingSummary(p);
  return `追加 ${s.inserts}・変更 ${s.updates}・削除 ${s.deletes}`;
}
