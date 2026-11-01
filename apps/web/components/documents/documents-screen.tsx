'use client';

// 提出状況（/documents。PC。04「提出状況 /documents（PC）」「提出物」、notes/T19.md「パート B・C の約束」1・2・6。T19・D-55）。
// - 開ける人は総務（管理者・総務部門長・総務副部門長・総務部門員）。閲覧のみ・店長・副店長はページの守り（RequireAudience）が権限なしにする
//   （Q5。ナビにも出ない）。段（documentsTier）で出し分ける：部門長以上は全部（ファイル・操作・設定・CSV）、総務部門員は状況だけ（Q4）。
// - タブ（`?tab=status|settings`）：提出状況（既定）と提出物の設定（部門長以上だけ）。URL のパラメータは lib/modules/documents/board.ts の
//   parseDocumentsParams・documentsHref（`?status=`・`?document=`・`?group=`。知らない値は既定）。
// - 読む（並行）：提出物・v_document_status・団体・表示名と、部門長以上は v_document_files と使った量（lib/data/documents.ts）。最後に読み込んだ
//   日時と「読み直す」（全部と、締切を過ぎたかを決める時刻を読み直す）。版は使わない。ポーリングはしない。
// - 片付け：部門長以上が開いたとき（その年度で1回。そのタブの QueryClient ごと。終了した年度も）、どの提出にも属さないファイルを裏で消す
//   （知らせない。消したらダッシュボードの提出物と使った量を読み直す）。
// - 提出状況：表（狭い幅では提出物ごとの一覧）・絞り込み・目立たせ（documents-board.tsx）、セルのシート（documents-sheet.tsx。`?document=` と
//   `?group=` の両方があれば開き、閉じると2つを外す）、「CSV で保存」（部門長以上。押したときに csv.ts を読み込む）。
// - 終了した年度：「終了した年度のため、提出物は読むだけです」の帯を出し、書くためのもの（設定の登録・編集・削除・写す、シートの操作）を出さない。
//   開く・保存・CSV はできる。管理者には年度のファイルの削除（delete-year-files.tsx）。
// 変数名は doc・docs（ブラウザの document を隠さない）。/document（店長・副店長）の画面の部品は import しない。
import { useQuery, useQueryClient, type QueryClient } from '@tanstack/react-query';
import { FileDown } from 'lucide-react';
import { useSearchParams } from 'next/navigation';
import { useEffect, useMemo, useState } from 'react';
import { toast } from 'sonner';
import { ErrorBanner } from '@/components/common/error-banner';
import { PageHeader } from '@/components/common/page-header';
import { EmptyState, ForbiddenState, QueryState, ReadOnlyNotice } from '@/components/states';
import { Button } from '@/components/ui/button';
import { Tabs, TabsContent, TabsList, TabsTrigger } from '@/components/ui/tabs';
import { useAuth } from '@/lib/auth/auth-provider';
import { useAuthErrorHandler } from '@/lib/auth/guarded';
import type { Membership } from '@/lib/auth/membership';
import {
  cleanupDocumentOrphans,
  documentsBoardOptions,
  documentStorageUsageOptions,
  type DocumentsBoardData,
} from '@/lib/data/documents';
import { useYearRow } from '@/lib/data/year';
import { downloadFile, MIME } from '@/lib/download';
import { classifyError, effectOf, messageFor } from '@/lib/errors';
import {
  boardCell,
  buildDocumentsBoard,
  documentsHref,
  parseDocumentsParams,
  resolveDocumentsFocus,
  type DocumentsTab,
} from '@/lib/modules/documents/board';
import type { DocumentFilter } from '@/lib/modules/documents/labels';
import { canDeleteYearFiles, canManageDocuments, documentsTier, type DocumentsTier } from '@/lib/modules/documents/permissions';
import { useGuardedRouter } from '@/lib/navigation/guarded-router';
import { queryKeys } from '@/lib/query';
import { DeleteYearFiles } from './delete-year-files';
import { DocumentsBoardView, DocumentsFilter, useWideLayout } from './documents-board';
import { DocumentsSettings } from './documents-settings';
import { DocumentsSheet, type OpenCell } from './documents-sheet';
import { useDocumentUploader } from './use-document-uploader';

/** 終了した年度の帯（04「提出状況」） */
export const CLOSED_DOCUMENTS = '終了した年度のため、提出物は読むだけです';
/** 提出物がない */
export const EMPTY_DOCUMENTS = '提出物はまだありません';
/** 提出物がないときの添え書き（書ける部門長以上） */
export const EMPTY_DOCUMENTS_HINT = '「提出物の設定」から登録できます。';
/** 提出物はあるが、対象の団体がない */
export const NO_TARGETS_TEXT = '対象の団体がありません（団体の区分と、提出物の対象を確かめてください）';
/** 絞り込みに合う提出がない */
export const FILTER_EMPTY_TEXT = '条件に合う提出はありません';

/** 開いたときの片付けを済ませた年度（そのタブの QueryClient ごと。アプリには1つ。テストは毎回新しい QueryClient を作る） */
const cleanedYears = new WeakMap<QueryClient, Set<string>>();
function cleanedYearsOf(qc: QueryClient): Set<string> {
  let set = cleanedYears.get(qc);
  if (!set) {
    set = new Set();
    cleanedYears.set(qc, set);
  }
  return set;
}

export function DocumentsScreen() {
  const { membership, session } = useAuth();
  if (membership.status !== 'ready') return null; // AppShell と RequireAudience が読み込み中・権限なしを出す
  const m = membership.membership;
  if (!m.year) return null;
  const tier = documentsTier(m.role);
  // ページの守り（RequireAudience）を通った後に立場が変わったとき（総務でなくなった）
  if (!tier) return <ForbiddenState />;
  const userId = session.status === 'signedIn' ? session.session.user.id : null;
  return <DocumentsBoardScreen key={`${m.year.id}:${tier}`} membership={m} yearId={m.year.id} tier={tier} userId={userId} />;
}

function DocumentsBoardScreen({ membership: m, yearId, tier, userId }: { membership: Membership; yearId: string; tier: DocumentsTier; userId: string | null }) {
  const queryClient = useQueryClient();
  const { reloadMembership } = useAuth();
  const onAuthError = useAuthErrorHandler();
  const router = useGuardedRouter();
  const params = useSearchParams();
  const yearQ = useYearRow(yearId);
  const lead = tier === 'lead';
  const boardQ = useQuery(documentsBoardOptions(yearId, tier));
  const usageQ = useQuery({ ...documentStorageUsageOptions(yearId), enabled: lead });
  // 画面を開いた時刻（締切を過ぎたか）。「読み直す」で押した時刻にする
  const [now, setNow] = useState(() => Date.now());
  const wide = useWideLayout();
  // 書けるかは年度の行の状態で決める（立場と一緒に読んだキャッシュ。forbidden・invalid_state の後は読み直す）
  const status = yearQ.data?.status ?? m.year?.status ?? null;
  const closed = status === 'closed';
  const writable = canManageDocuments(m.role, status);
  const repGroupIds = useMemo(() => new Set(m.groups.map((g) => g.id)), [m.groups]);
  const view = useMemo(() => parseDocumentsParams(params, tier), [params, tier]);

  // 開いたときの片付け（部門長以上。その年度で1回）。終わるまでは「消せなかったファイル」の知らせを出さない
  const [cleaning, setCleaning] = useState(() => lead && !cleanedYearsOf(queryClient).has(yearId));
  useEffect(() => {
    if (!lead) return;
    const done = cleanedYearsOf(queryClient);
    if (done.has(yearId)) return;
    done.add(yearId);
    void cleanupDocumentOrphans(yearId)
      .then((r) => {
        if (r.removed > 0) {
          void queryClient.invalidateQueries({ queryKey: queryKeys.yearPart(yearId, 'portal', 'documents') });
          void queryClient.invalidateQueries({ queryKey: queryKeys.yearPart(yearId, 'documents', 'usage') });
        }
      })
      .catch(() => undefined)
      .finally(() => setCleaning(false));
  }, [lead, yearId, queryClient]);

  /** forbidden・invalid_state の後：年度の行と立場を読み直す（書けない形にする。「共通レイアウト」） */
  const reloadYear = (error: unknown) => {
    if (effectOf(classifyError(error)).reload !== 'year') return;
    reloadMembership();
    void yearQ.refetch();
  };

  /**
   * 書いた後・止められた後の読み直し：提出状況（届くまで待つ）と、使った量・自団体の提出物・ダッシュボードの提出物（/calendar の機能の日付も
   * 同じキー）。読み直した提出状況を返す（読めなければ null）。
   */
  const rereadBoard = async (): Promise<DocumentsBoardData | null> => {
    void queryClient.invalidateQueries({ queryKey: queryKeys.yearPart(yearId, 'document') });
    void queryClient.invalidateQueries({ queryKey: queryKeys.yearPart(yearId, 'portal', 'documents') });
    if (lead) void usageQ.refetch();
    const r = await boardQ.refetch();
    return r.isError || !r.data ? null : r.data;
  };

  // 代理のファイル（部門長以上のシート）。最新でない年度の確かめはしない（PC の部門長以上の画面。締切と予定・申請一覧と同じ）
  const uploader = useDocumentUploader({
    yearId,
    confirmWrite: async () => true,
    reread: () => rereadBoard(),
    onYearEffect: reloadYear,
    onAuthError,
  });

  // 「読み直す」：全部と、締切を過ぎたかを決める時刻を読み直す
  const reload = () => {
    setNow(Date.now());
    void yearQ.refetch();
    void boardQ.refetch();
    if (lead) void usageQ.refetch();
  };

  const data = boardQ.data;
  const focus = useMemo(() => (data ? resolveDocumentsFocus(view, data, now) : null), [data, now, view]);
  const filter: DocumentFilter = focus?.filter ?? view.filter;
  const board = useMemo(() => (data ? buildDocumentsBoard(data, filter, now) : null), [data, filter, now]);

  // 開いているセル（提出状況のタブで、URL の2つが読めるセルを指すとき）
  let openCell: OpenCell | null = null;
  if (view.tab === 'status' && data && board && focus?.sheet && focus.documentId && focus.groupId) {
    const cell = boardCell(board, focus.documentId, focus.groupId);
    const doc = data.docs.find((d) => d.id === focus.documentId);
    const group = data.groups.find((g) => g.id === focus.groupId);
    if (cell && doc && group) openCell = { cell, doc, group };
  }
  const openFiles = openCell && data?.files ? data.files.filter((f) => f.document_id === openCell.cell.documentId && f.group_id === openCell.cell.groupId) : null;

  const go = (href: string) => router.forceReplace(href);
  const setTab = (tab: DocumentsTab) => go(documentsHref({ tab }));
  const setFilter = (next: DocumentFilter) => go(documentsHref({ tab: 'status', filter: next }));
  const openSheet = (documentId: string, groupId: string) => go(documentsHref({ tab: 'status', filter, documentId, groupId }));
  const closeSheet = () => go(documentsHref({ tab: 'status', filter }));

  const exportCsv = async () => {
    if (!data || !m.year) return;
    try {
      const { buildDocumentsCsv, documentsCsvFileName } = await import('@/lib/modules/documents/csv');
      downloadFile(buildDocumentsCsv({ docs: data.docs, groups: data.groups, statuses: data.statuses }), documentsCsvFileName(m.year.label), MIME.csv);
    } catch (e) {
      // 部品を読み込めなかった（通信の失敗）
      toast.error(messageFor(classifyError(e instanceof TypeError ? e : new TypeError('chunk'))));
    }
  };

  return (
    <div className="mx-auto max-w-7xl space-y-4 pb-16" data-testid="documents-screen">
      <PageHeader
        title="提出状況"
        loadedAt={data?.loadedAt ?? null}
        onReload={reload}
        reloading={boardQ.isFetching || yearQ.isFetching || (lead && usageQ.isFetching)}
        actions={
          lead && view.tab === 'status' ? (
            <Button data-testid="documents-csv" variant="outline" disabled={!data} onClick={() => void exportCsv()}>
              <FileDown aria-hidden />
              CSV で保存
            </Button>
          ) : undefined
        }
      />
      {closed ? (
        <div data-testid="documents-closed">
          <ReadOnlyNotice>{CLOSED_DOCUMENTS}</ReadOnlyNotice>
        </div>
      ) : null}
      {yearQ.isError && !yearQ.data ? <ErrorBanner error={yearQ.error} onRetry={() => void yearQ.refetch()} /> : null}
      <Tabs value={view.tab} onValueChange={(v) => setTab(v === 'settings' ? 'settings' : 'status')} className="gap-4">
        <TabsList aria-label="提出物の表示">
          <TabsTrigger value="status" data-testid="documents-tab-status">
            提出状況
          </TabsTrigger>
          {lead ? (
            <TabsTrigger value="settings" data-testid="documents-tab-settings">
              提出物の設定
            </TabsTrigger>
          ) : null}
        </TabsList>
        <TabsContent value={view.tab}>
          <QueryState query={boardQ}>
            {(d) =>
              view.tab === 'settings' ? (
                <DocumentsSettings
                  data={d}
                  yearId={yearId}
                  userId={userId}
                  writable={writable}
                  hasPrevYear={!!yearQ.data?.prev_year_id}
                  now={now}
                  onReload={() => void rereadBoard()}
                  onReloadMembership={() => {
                    reloadMembership();
                    void yearQ.refetch();
                  }}
                />
              ) : (
                <div className="space-y-4">
                  {closed && lead ? (
                    <DeleteYearFiles
                      yearId={yearId}
                      admin={canDeleteYearFiles(m.role, status)}
                      usage={usageQ.data}
                      docs={d.docs}
                      showLeftover={!cleaning}
                      onChanged={() => void rereadBoard()}
                      onReloadMembership={() => {
                        reloadMembership();
                        void yearQ.refetch();
                      }}
                    />
                  ) : null}
                  {board ? (
                    <StatusPanel
                      board={board}
                      lead={lead}
                      writable={writable}
                      now={now}
                      wide={wide}
                      highlightDocumentId={focus?.documentId ?? null}
                      highlightGroupId={focus?.groupId ?? null}
                      onFilter={setFilter}
                      onOpenCell={openSheet}
                    />
                  ) : null}
                </div>
              )
            }
          </QueryState>
        </TabsContent>
      </Tabs>
      {data ? (
        <DocumentsSheet
          open={openCell}
          files={openFiles}
          names={data.names}
          writable={writable}
          yearStatus={status}
          yearId={yearId}
          userId={userId}
          now={now}
          repGroupIds={repGroupIds}
          uploader={uploader}
          onClose={closeSheet}
          rereadBoard={rereadBoard}
          onYearEffect={reloadYear}
          onAuthError={onAuthError}
        />
      ) : null}
    </div>
  );
}

/** 提出状況のタブの中身（空の表示・絞り込み・表か一覧） */
function StatusPanel({
  board,
  lead,
  writable,
  now,
  wide,
  highlightDocumentId,
  highlightGroupId,
  onFilter,
  onOpenCell,
}: {
  board: ReturnType<typeof buildDocumentsBoard>;
  lead: boolean;
  writable: boolean;
  now: number;
  wide: boolean;
  highlightDocumentId: string | null;
  highlightGroupId: string | null;
  onFilter: (next: DocumentFilter) => void;
  onOpenCell: (documentId: string, groupId: string) => void;
}) {
  if (board.empty === 'no_documents') {
    return (
      <div data-testid="documents-empty">
        <EmptyState title={EMPTY_DOCUMENTS} description={lead && writable ? EMPTY_DOCUMENTS_HINT : undefined} />
      </div>
    );
  }
  if (board.empty === 'no_targets') {
    return (
      <div data-testid="documents-no-targets">
        <EmptyState title={NO_TARGETS_TEXT} />
      </div>
    );
  }
  return (
    <div className="space-y-4">
      <DocumentsFilter filter={board.filter} counts={board.counts} onChange={onFilter} />
      {board.empty === 'filtered' ? (
        <div data-testid="documents-filter-empty">
          <EmptyState title={FILTER_EMPTY_TEXT} />
        </div>
      ) : (
        <DocumentsBoardView
          board={board}
          showFiles={lead}
          now={now}
          highlightDocumentId={highlightDocumentId}
          highlightGroupId={highlightGroupId}
          wide={wide}
          onOpenCell={onOpenCell}
        />
      )}
    </div>
  );
}
