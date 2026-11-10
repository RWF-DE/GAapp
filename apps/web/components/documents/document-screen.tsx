'use client';

// 自団体の提出物（/document。スマホ。04「自団体の提出物 /document（スマホ）」「提出物」、notes/T19.md「パート B・C の約束」6。T19・D-55）。
// - 団体：`?group=<id>`（代表する団体にない・形の違う値は最初の団体。/request と同じ）。2つ以上なら上に団体の選択（変えると URL を
//   置き換える。上げている間は離れる前に確かめる）。`?document=<id>`（ダッシュボードから来る）はそのカードを目立たせて見える所に送る。
// - 読む：その団体の v_document_status と v_document_files を並行に（1往復。版は使わない。lib/modules/documents/reads.ts。開いたときは
//   先読み〔planDocumentPrefetch〕と同じキャッシュ）。最後に読み込んだ日時と「読み直す」（締切を過ぎたかを決める時刻も押した時刻にする）。
// - カード（document-card.tsx）を締切の早い順に。出す操作は店長・副店長の決まり（repDocumentActions。管理者が兼ねていても同じ。
//   部門長以上の操作は提出状況で行う）。終了した年度は書くためのものを出さず、帯を出す（開く・保存はできる）。
// - 提出先（T24。D-62）：ファイルは提出先（ドライブ・フォーム）に出す。カードに「提出先を開く」（新しいタブ）を出し、ファイルを上げる欄は
//   出さない。T24 の前に上がったファイル（use-document-uploader.ts の外す・状態）は一覧に出し、届いたファイルを外すときは確かめる。
//   開く・保存は押したときに署名つき URL（60 秒）を作る（file-open.ts。URL は残さない）。上げている間は、どのカードの「保存」も押せない
//   （保存はこのページを URL へ移すので、ページを離れる確かめが出るため。レビューの F2）。開く・保存の 403 は開く・保存の文言（UX-4）。
// - 「提出した」・「提出を取り消す」は確かめてから送る（submission-write.ts の (B1)。版はカードの updated_at）。止められたら読み直して今の
//   状態とエラーの文言を出し、読み直せなければ「読み直す」を出す。forbidden・invalid_state は年度の行と立場も読み直す。成功したら押した
//   ボタンが消えるので、確かめが閉じた後にフォーカスをそのカードの題名へ移す（focus-after-dialog.ts。レビューの F4）。
// - 最新でない年度：上に「最新の年度に切り替える」を出し、書き込みの前に確かめる（D-31。ファイルを足す・外すは「変更」、「提出した」は
//   「提出」、取り消すは「取り消し」）。
// - 書き込み（提出・取り消し・ファイル）と開く・保存の JS は、初めて使うときに読む（document-writes.ts。読めなければ送らずに、その操作の
//   エラーを出す所に通信の失敗の文言。FU3 の PR B の案 5）。読み取りは軽いモジュール（lib/modules/documents/reads.ts）から読む。
// 変数名は doc・docs（ブラウザの document を隠さない）。/documents の部品（表・シート・設定・ダイアログ）は import しない。
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { useSearchParams } from 'next/navigation';
import { useMemo, useState } from 'react';
import { toast } from 'sonner';
import { ConfirmDialog } from '@/components/common/confirm-dialog';
import { LatestYearSwitch, useNotLatestYearConfirm } from '@/components/common/latest-year';
import { PageHeader } from '@/components/common/page-header';
import { EmptyState, QueryState, ReadOnlyNotice } from '@/components/states';
import { useAuth } from '@/lib/auth/auth-provider';
import { useAuthErrorHandler } from '@/lib/auth/guarded';
import type { GroupSummary, YearStatus } from '@/lib/auth/membership';
import { useYearRow } from '@/lib/data/year';
import { classifyError, effectOf, messageFor } from '@/lib/errors';
import { downloadNameFor, submitBlocker } from '@/lib/modules/documents/files';
import { repDocumentActions } from '@/lib/modules/documents/permissions';
import { repDocumentsOptions, type RepDocumentsData } from '@/lib/modules/documents/reads';
import { buildRepDocumentCards, highlightedCard, pickDocumentGroup, type RepDocumentCard } from '@/lib/modules/documents/rep';
import { useGuardedRouter } from '@/lib/navigation/guarded-router';
import { queryKeys } from '@/lib/query';
import { cardTitleId, DocumentCard, type CardNote } from './document-card';
import { fileEntriesOf, REMOVE_CONFIRM_TEXT, type FileEntry } from './document-file-list';
import { loadDocumentWrites, preloadDocumentWrites, type DocumentWrites } from './document-writes';
import { openDocumentFile, POPUP_BLOCKED_MESSAGE, saveDocumentFile, type FileOpenResult } from './file-open';
import { focusAfterDialogs } from './focus-after-dialog';
import {
  REREAD_AGAIN_FAILED_MESSAGE,
  REREAD_FAILED_NOTICE,
  runSubmissionWrite,
  SUBMISSION_DONE_BEFORE,
  SUBMISSION_RPCS,
  SUBMISSION_UNKNOWN,
  type SubmissionAction,
} from './submission-write';
import { DISCARD_UNKNOWN_MESSAGE, uploadSlot, useDocumentUploader, type DocumentFileTarget } from './use-document-uploader';

/** 終了した年度の帯（04「自団体の提出物」） */
export const CLOSED_DOCUMENT_REP = '終了した年度のため、提出物は読むだけです（ファイルは、総務が年度の終わりに削除します）';
/** 空の表示 */
export const EMPTY_DOCUMENT_REP = 'この団体が出す提出物はまだありません';
/** 代表する団体がない（RequireAudience を通った後に立場が変わったとき） */
export const NO_GROUP_TITLE = '店長・副店長を務める団体がありません';
/** 「提出した」の確かめの説明 */
export const SUBMIT_CONFIRM_TEXT = '提出先（ドライブやフォーム）に出してから押してください。総務が確かめる前なら「提出を取り消す」で戻せます。';
/** 「提出を取り消す」の確かめの説明（2つの文） */
export const WITHDRAW_CONFIRM_TEXTS = ['未提出に戻ります。', '直してから、もう一度「提出した」を押してください。'] as const;
// 届いたファイルを外す確かめの説明（/documents のシートと同じ。document-file-list.tsx に置き、ここから同じ名前で出し直す）
export { REMOVE_CONFIRM_TEXT } from './document-file-list';

/** T24 の前のファイルがあるときの文（なければ空。T24 からファイルは提出先〔ドライブ・フォーム〕に出す） */
export function submitFilesText(n: number): string {
  return n > 0 ? `ファイル ${n} つも一緒に提出します。` : '';
}

/** 「提出した」の成功の知らせ（締切の後なら「（締切の後）」を添える） */
export function submittedMessage(title: string, submittedAt: string | null | undefined, deadline: string): string {
  const s = submittedAt ? Date.parse(submittedAt) : Number.NaN;
  const d = Date.parse(deadline);
  const late = !Number.isNaN(s) && !Number.isNaN(d) && s > d;
  return `「${title}」を提出しました${late ? '（締切の後）' : ''}`;
}

export function DocumentScreen() {
  const { membership } = useAuth();
  const params = useSearchParams();
  if (membership.status !== 'ready') return null; // AppShell と RequireAudience が読み込み中・権限なしを出す
  const m = membership.membership;
  if (!m.year) return null;
  const group = pickDocumentGroup(m.groups, params.get('group'));
  if (!group) {
    return (
      <div className="mx-auto max-w-xl" data-testid="document-screen">
        <PageHeader title="自団体の提出物" />
        <EmptyState title={NO_GROUP_TITLE} description="団体の店長・副店長として招待されると、ここで提出物を出せます。" />
      </div>
    );
  }
  return (
    <DocumentBoard
      key={`${m.year.id}:${group.id}`}
      yearId={m.year.id}
      yearStatus={m.year.status}
      group={group}
      groups={m.groups}
      documentParam={params.get('document')}
    />
  );
}

/** カードの知らせ（unknownAction は「分からない」で終わった操作。同じ操作のもう一度で、前の送信が通っていたかを見る） */
interface NoteState {
  note: CardNote;
  unknownAction?: SubmissionAction;
}

function DocumentBoard({
  yearId,
  yearStatus,
  group,
  groups,
  documentParam,
}: {
  yearId: string;
  yearStatus: YearStatus;
  group: GroupSummary;
  groups: readonly GroupSummary[];
  documentParam: string | null;
}) {
  const queryClient = useQueryClient();
  const { reloadMembership } = useAuth();
  const onAuthError = useAuthErrorHandler();
  const router = useGuardedRouter();
  const yearQ = useYearRow(yearId);
  const q = useQuery(repDocumentsOptions(yearId, group.id));
  // 画面を開いた時刻（締切を過ぎたか・相対の言い方）。「読み直す」で押した時刻にする
  const [now, setNow] = useState(() => Date.now());
  // 書けるかは年度の行の状態で決める（立場と一緒に読んだキャッシュ。forbidden・invalid_state の後は読み直す）
  const status = yearQ.data?.status ?? yearStatus;
  const notLatestChange = useNotLatestYearConfirm({ verb: '変更' });
  const notLatestSubmit = useNotLatestYearConfirm({ verb: '提出' });
  const notLatestWithdraw = useNotLatestYearConfirm({ verb: '取り消し' });

  const [notes, setNotes] = useState<ReadonlyMap<string, NoteState>>(() => new Map());
  const [pendingDoc, setPendingDoc] = useState<string | null>(null);
  const [rereading, setRereading] = useState(false);
  const [submitTarget, setSubmitTarget] = useState<RepDocumentCard | null>(null);
  const [withdrawTarget, setWithdrawTarget] = useState<RepDocumentCard | null>(null);
  const [removeTarget, setRemoveTarget] = useState<{ card: RepDocumentCard; entry: FileEntry } | null>(null);
  const [removeError, setRemoveError] = useState<string | null>(null);

  const setNote = (documentId: string, next: NoteState | null) =>
    setNotes((prev) => {
      if (!next && !prev.has(documentId)) return prev;
      const m = new Map(prev);
      if (next) m.set(documentId, next);
      else m.delete(documentId);
      return m;
    });

  /** forbidden・invalid_state の後：年度の行と立場を読み直す（書けない形にする。「共通レイアウト」） */
  const reloadYear = (error: unknown) => {
    if (effectOf(classifyError(error)).reload !== 'year') return;
    reloadMembership();
    void yearQ.refetch();
  };

  /**
   * 書いた後・止められた後の読み直し：この団体の提出物（届くまで待つ）と、提出状況・ダッシュボードの提出物（/calendar の機能の日付も同じ
   * キー）。読み直した提出物を返す（読めなければ null）。
   */
  const rereadList = async (): Promise<RepDocumentsData | null> => {
    void queryClient.invalidateQueries({ queryKey: queryKeys.yearPart(yearId, 'documents') });
    void queryClient.invalidateQueries({ queryKey: queryKeys.yearPart(yearId, 'portal', 'documents') });
    const r = await q.refetch();
    return r.isError || !r.data ? null : r.data;
  };

  const uploader = useDocumentUploader({
    yearId,
    confirmWrite: () => notLatestChange.confirmBeforeWrite(),
    reread: rereadList,
    onYearEffect: reloadYear,
    onAuthError,
  });

  // 「読み直す」：提出物・年度の行を読み直し、締切を過ぎたかを押した時刻で決め直す。読み直せたら「読み直せませんでした」の知らせは消す
  const reload = () => {
    setNow(Date.now());
    void yearQ.refetch();
    void q.refetch().then((r) => {
      if (r.isError) return;
      setNotes((prev) => {
        const kept = [...prev].filter(([, n]) => n.note.kind !== 'unread');
        return kept.length === prev.size ? prev : new Map(kept);
      });
    });
  };

  const data = q.data;
  const cards = useMemo(() => (data ? buildRepDocumentCards(data, now) : []), [data, now]);
  const highlight = highlightedCard(cards, documentParam);
  const target = (card: RepDocumentCard): DocumentFileTarget => ({ documentId: card.doc.document_id, groupId: group.id });
  /** そのカードのタブの状態の鍵（提出物 × この団体） */
  const slotOf = (card: RepDocumentCard) => uploadSlot(target(card));

  // ---------------------------------------------------------------- 提出した・取り消す

  const runWrite = async (card: RepDocumentCard, action: 'submit' | 'withdraw') => {
    const documentId = card.doc.document_id;
    const afterUnknown = notes.get(documentId)?.unknownAction === action;
    setNote(documentId, null);
    setPendingDoc(documentId);
    try {
      // 書き込みの JS（初めてなら読む）。読めなければ送らずに、通信の失敗の文言を出す（もう一度押すと読み直す）
      let w: DocumentWrites;
      try {
        w = await loadDocumentWrites();
      } catch (e) {
        setNote(documentId, { note: { kind: 'error', message: messageFor(classifyError(e)) } });
        return;
      }
      const r = await runSubmissionWrite(
        {
          action,
          base: card.baseVersion,
          afterUnknown,
          send: () =>
            action === 'submit'
              ? w.submitDocument(documentId, group.id, card.baseVersion)
              : w.withdrawDocument(documentId, group.id, card.baseVersion ?? ''),
          reread: async () => {
            const fresh = await rereadList();
            if (!fresh) throw new Error('reread');
            const row = fresh.statuses.find((s) => s.document_id === documentId);
            return row ? { status: row.status, updated_at: row.updated_at, review_note: row.review_note } : null;
          },
        },
        onAuthError,
      );
      const ctx = { rpc: SUBMISSION_RPCS[action] };
      switch (r.type) {
        case 'done':
          // 届くまで待ってから知らせる（カードを新しい状態にしてから。止められた後の読み直しはもう済んでいる）
          if (!r.before) await rereadList();
          if (r.before) toast.success(SUBMISSION_DONE_BEFORE[action]);
          else if (action === 'submit') toast.success(submittedMessage(card.doc.title, r.row?.submitted_at, card.doc.deadline));
          else toast.success(`「${card.doc.title}」の提出を取り消しました`);
          // 押したボタンは消えた。確かめが閉じた後に、フォーカスをそのカードの題名へ（レビューの F4）
          focusAfterDialogs(() => window.document.getElementById(cardTitleId(documentId)));
          return;
        case 'unknown':
          setNote(documentId, { note: { kind: 'error', message: SUBMISSION_UNKNOWN[action] }, unknownAction: action });
          return;
        case 'rejected':
          setNote(documentId, { note: { kind: 'error', message: messageFor(classifyError(r.error), ctx) } });
          reloadYear(r.error);
          return;
        case 'unread':
          setNote(documentId, { note: { kind: 'unread', message: REREAD_FAILED_NOTICE } });
          reloadYear(r.error);
          return;
        case 'failed': {
          const c = classifyError(r.error);
          setNote(documentId, { note: { kind: 'error', message: messageFor(c, ctx) } });
          reloadYear(r.error);
          if (effectOf(c).reload !== 'none') void rereadList();
          return;
        }
      }
    } finally {
      setPendingDoc(null);
    }
  };

  /** 止められた後に読み直せなかったときの「読み直す」：一覧を読み直し、また読めなければ知らせを変える */
  const rereadUnread = async (documentId: string) => {
    setRereading(true);
    try {
      const fresh = await rereadList();
      setNote(documentId, fresh ? null : { note: { kind: 'unread', message: REREAD_AGAIN_FAILED_MESSAGE } });
    } finally {
      setRereading(false);
    }
  };

  // ---------------------------------------------------------------- ファイル

  const showOpenResult = (card: RepDocumentCard, r: FileOpenResult) => {
    const slot = slotOf(card);
    if (r.type === 'opened') return;
    if (r.type === 'blocked') {
      uploader.setError(slot, POPUP_BLOCKED_MESSAGE);
      return;
    }
    const c = classifyError(r.error);
    // 開く・保存（署名つき URL）の 403 はアップロードの文言にしない（レビューの UX-4）
    uploader.setError(slot, messageFor(c, { storage: 'sign' }));
    reloadYear(r.error);
    if (c.kind === 'not_found') void rereadList();
  };

  const onOpen = async (card: RepDocumentCard, entry: FileEntry) => {
    if (!entry.row) return;
    uploader.setError(slotOf(card), null);
    showOpenResult(card, await openDocumentFile(entry.row.object_path));
  };

  const onSave = async (card: RepDocumentCard, entry: FileEntry) => {
    // 上げている間は押せない（このページを移すと、ページを離れる確かめが出る。レビューの F2）
    if (!entry.row || uploader.active) return;
    uploader.setError(slotOf(card), null);
    const name = downloadNameFor(card.doc.title, group.name, entry.n, entry.row.content_type);
    showOpenResult(card, await saveDocumentFile(entry.row.object_path, name));
  };

  const onRemove = async (card: RepDocumentCard, entry: FileEntry) => {
    // DB の行のない失敗（そのタブだけ）は書き込みでないので、確かめずに消す
    if (!entry.row) {
      await uploader.remove(target(card), entry.id, null);
      return;
    }
    if (!(await notLatestChange.confirmBeforeWrite())) return;
    if (entry.state === 'uploaded') {
      preloadDocumentWrites();
      setRemoveError(null);
      setRemoveTarget({ card, entry });
      return;
    }
    // 届いていないファイルは確かめずに外す（提出の状態によらない）
    const r = await uploader.remove(target(card), entry.id, entry.row);
    if (r.type === 'unknown') uploader.setError(slotOf(card), DISCARD_UNKNOWN_MESSAGE);
  };

  const confirmRemove = async () => {
    const t = removeTarget;
    if (!t) return;
    setRemoveError(null);
    const r = await uploader.remove(target(t.card), t.entry.id, t.entry.row);
    if (r.type === 'unknown') {
      // 外せたか分からない：確かめのダイアログを開いたまま知らせる（もう一度押すと、読み直してから決める）
      setRemoveError(DISCARD_UNKNOWN_MESSAGE);
      throw new Error('keep-open');
    }
    if (r.type === 'removed') toast.success(`ファイル ${t.entry.n} を外しました`);
  };

  return (
    <div className="mx-auto max-w-xl pb-16" data-testid="document-screen">
      <LatestYearSwitch />
      <PageHeader
        title="自団体の提出物"
        description={<span data-testid="document-group-name">{group.name}</span>}
        loadedAt={data?.loadedAt ?? null}
        onReload={reload}
        reloading={q.isFetching || yearQ.isFetching}
      />
      {groups.length > 1 ? (
        <label className="mb-4 flex items-center gap-2 text-sm">
          <span className="shrink-0">団体</span>
          <select
            data-testid="document-group-select"
            className="h-10 min-w-0 flex-1 rounded-md border bg-background px-2 text-base"
            value={group.id}
            onChange={(e) => void router.replace(`/document?group=${encodeURIComponent(e.target.value)}`)}
          >
            {groups.map((g) => (
              <option key={g.id} value={g.id}>
                {g.name}
              </option>
            ))}
          </select>
        </label>
      ) : null}
      {status === 'closed' ? (
        <div data-testid="document-closed" className="mb-4">
          <ReadOnlyNotice>{CLOSED_DOCUMENT_REP}</ReadOnlyNotice>
        </div>
      ) : null}
      <QueryState query={q}>
        {() =>
          cards.length === 0 ? (
            <div data-testid="document-empty">
              <EmptyState title={EMPTY_DOCUMENT_REP} />
            </div>
          ) : (
            <div className="space-y-4">
              {cards.map((card) => {
                const documentId = card.doc.document_id;
                const slot = slotOf(card);
                const rowIds = new Set(card.files.map((f) => f.file.id));
                const localOnly = uploader.localOnly(slot, rowIds);
                const entries = fileEntriesOf(card.files, localOnly, uploader.uploading, uploader.failed, uploader.sent);
                const uploadBusy = uploader.busy(slot);
                const blocker = submitBlocker([...card.files.map((f) => f.file), ...localOnly.map(() => ({ uploaded: false }))], uploadBusy);
                return (
                  <DocumentCard
                    key={documentId}
                    card={card}
                    now={now}
                    actions={repDocumentActions(card.status, status)}
                    highlighted={highlight?.doc.document_id === documentId}
                    entries={entries}
                    busy={uploadBusy || pendingDoc === documentId}
                    saveBlocked={uploader.active}
                    fileError={uploader.error(slot)}
                    note={notes.get(documentId)?.note ?? null}
                    submitBlocker={blocker}
                    rereading={rereading}
                    onOpen={(e) => void onOpen(card, e)}
                    onSave={(e) => void onSave(card, e)}
                    onRemove={(e) => void onRemove(card, e)}
                    onSubmit={() =>
                      void notLatestSubmit.confirmBeforeWrite().then((ok) => {
                        if (!ok) return;
                        preloadDocumentWrites();
                        setSubmitTarget(card);
                      })
                    }
                    onWithdraw={() =>
                      void notLatestWithdraw.confirmBeforeWrite().then((ok) => {
                        if (!ok) return;
                        preloadDocumentWrites();
                        setWithdrawTarget(card);
                      })
                    }
                    onReread={() => void rereadUnread(documentId)}
                  />
                );
              })}
            </div>
          )
        }
      </QueryState>
      <ConfirmDialog
        open={submitTarget !== null}
        onOpenChange={(open) => {
          if (!open) setSubmitTarget(null);
        }}
        title={submitTarget ? `「${submitTarget.doc.title}」を提出しますか` : ''}
        description={SUBMIT_CONFIRM_TEXT}
        confirmLabel="提出する"
        pendingLabel="送信中…"
        onConfirm={async () => {
          if (submitTarget) await runWrite(submitTarget, 'submit');
        }}
      >
        <div data-testid="document-submit-confirm" className="text-sm">
          {submitTarget && submitTarget.files.length > 0 ? <p>{submitFilesText(submitTarget.files.length)}</p> : null}
        </div>
      </ConfirmDialog>
      <ConfirmDialog
        open={withdrawTarget !== null}
        onOpenChange={(open) => {
          if (!open) setWithdrawTarget(null);
        }}
        title={withdrawTarget ? `「${withdrawTarget.doc.title}」の提出を取り消しますか` : ''}
        description={WITHDRAW_CONFIRM_TEXTS[0]}
        confirmLabel="取り消す"
        pendingLabel="送信中…"
        onConfirm={async () => {
          if (withdrawTarget) await runWrite(withdrawTarget, 'withdraw');
        }}
      >
        <div data-testid="document-withdraw-confirm" className="text-sm text-muted-foreground">
          <p>{WITHDRAW_CONFIRM_TEXTS[1]}</p>
        </div>
      </ConfirmDialog>
      <ConfirmDialog
        open={removeTarget !== null}
        onOpenChange={(open) => {
          if (!open) {
            setRemoveTarget(null);
            setRemoveError(null);
          }
        }}
        title={removeTarget ? `ファイル ${removeTarget.entry.n} を外しますか` : ''}
        description={REMOVE_CONFIRM_TEXT}
        confirmLabel="外す"
        pendingLabel="外しています…"
        destructive
        onConfirm={confirmRemove}
      >
        <div data-testid="document-remove-confirm">
          {removeError ? (
            <p role="alert" className="rounded-md border border-destructive/40 bg-destructive/5 px-3 py-2 text-sm text-destructive">
              {removeError}
            </p>
          ) : null}
        </div>
      </ConfirmDialog>
      {notLatestChange.dialog}
      {notLatestSubmit.dialog}
      {notLatestWithdraw.dialog}
    </div>
  );
}
