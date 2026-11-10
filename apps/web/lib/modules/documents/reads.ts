// 提出物の軽い読み取り（自団体の提出物〔/document〕とダッシュボード〔/〕の提出物の欄。04「自団体の提出物」「ダッシュボードに出すもの
// （提出物）」、notes/T19.md「パート B・C の約束」2。T19・D-52・D-55）。読み取りとキーだけの軽いモジュール：ルートのレイアウトの
// 先読み（lib/data/screen-queries.ts の planDocumentPrefetch・planHomePrefetch）が import するので、zod・Storage・RPC の引数の表・
// 並べ方・組み立て（board.ts・rep.ts・portal.ts）・ダッシュボードの型と関数（lib/modules/portal.ts）・React を実行時に import しない
// （お知らせの notices/latest.ts・締切と予定の calendar/dated.ts と同じ形。型だけの import はよい）。
// - 自団体の提出物：その団体の v_document_status と v_document_files を並行に（1往復。版は使わない。D-45）。
// - ダッシュボード（総務）：提出物の id・題名・締切と、v_document_status の document_id・status（全部の団体の行）。部門長以上は加えて
//   document_storage_usage（GET。POST は記録・先送りの残りを捨てるため。04「ファイルの扱い」）。部門長以上と総務部門員で別のキー。
// - ダッシュボード（店長・副店長）：代表する団体の v_document_status の document_id・group_id・status・題名・締切・review_note。
// 読める範囲は RLS が決める（総務はその年度の全部、店長・副店長は自団体が対象の提出物と自団体の行。閲覧のみは何も読まない。Q5）。
import type { Tables } from '@gaapp/shared';
import { queryOptions } from '@tanstack/react-query';
import { fetchAll, type PageResult } from '@/lib/db/fetch-all';
import { toAppError } from '@/lib/errors';
import { queryKeys } from '@/lib/query';
import { getSupabase, type AppSupabaseClient } from '@/lib/supabase/client';
import { portalQueryKey } from '../query-key';

/** 自団体の提出物の select（v_document_status。書いた人・確かめた人は読まない） */
export const REP_DOCUMENT_STATUS_SELECT =
  'document_id, group_id, title, description, deadline, submit_url, status, submitted_at, proxy, late, reviewed_at, review_note, updated_at';
/** ファイルの select（v_document_files。予約した人は読まない） */
export const DOCUMENT_FILE_SELECT = 'id, document_id, group_id, object_path, content_type, size, created_at, uploaded, stored_size';
/** ダッシュボード（総務）の提出物の select */
export const DOCUMENTS_PORTAL_DOC_SELECT = 'id, title, deadline';
/** ダッシュボード（総務）の提出の状況の select */
export const DOCUMENTS_PORTAL_STATUS_SELECT = 'document_id, status';
/** ダッシュボード（店長・副店長）の select */
export const DOCUMENTS_REP_PORTAL_SELECT = 'document_id, group_id, status, title, deadline, review_note';

type StatusView = Tables<'v_document_status'>;

/** 自団体の提出物の1行（v_document_status。行のない提出は status が not_submitted、updated_at が null） */
export type RepDocumentStatusRow = Pick<
  StatusView,
  | 'document_id'
  | 'group_id'
  | 'title'
  | 'description'
  | 'deadline'
  | 'submit_url'
  | 'status'
  | 'submitted_at'
  | 'proxy'
  | 'late'
  | 'reviewed_at'
  | 'review_note'
  | 'updated_at'
>;

/** ファイルの1行（v_document_files。uploaded は Storage に届いたか、stored_size は届いた物の大きさ） */
export type DocumentFileRow = Pick<
  Tables<'v_document_files'>,
  'id' | 'document_id' | 'group_id' | 'object_path' | 'content_type' | 'size' | 'created_at' | 'uploaded' | 'stored_size'
>;

/** 自団体の提出物の画面のデータ */
export interface RepDocumentsData {
  /** 締切 → 題名 → 提出物の id の順 */
  statuses: RepDocumentStatusRow[];
  /** 提出物 → 予約した日時 → id の順 */
  files: DocumentFileRow[];
  /** 読み込んだ時刻（ISO） */
  loadedAt: string;
}

type Res = { data: unknown; error: unknown; status?: number };

function rowsOf<T>(res: Res): T[] {
  if (res.error) throw toAppError(res.error, res.status);
  return (res.data ?? []) as T[];
}

/**
 * 自団体の提出物を読む（その団体の v_document_status と v_document_files を並行に。1往復）。団体の提出物は数十件・ファイルは 1 件の提出に
 * 5 つまでなので、ページに分けない。読めなければ AppError を投げる。
 */
export async function loadRepDocuments(yearId: string, groupId: string, client: AppSupabaseClient = getSupabase()): Promise<RepDocumentsData> {
  const [s, f] = await Promise.all([
    client
      .from('v_document_status')
      .select(REP_DOCUMENT_STATUS_SELECT)
      .eq('year_id', yearId)
      .eq('group_id', groupId)
      .order('deadline')
      .order('title')
      .order('document_id'),
    client
      .from('v_document_files')
      .select(DOCUMENT_FILE_SELECT)
      .eq('year_id', yearId)
      .eq('group_id', groupId)
      .order('document_id')
      .order('created_at')
      .order('id'),
  ]);
  return {
    statuses: rowsOf<RepDocumentStatusRow>(s as Res),
    files: rowsOf<DocumentFileRow>(f as Res),
    loadedAt: new Date().toISOString(),
  };
}

/**
 * 自団体の提出物のクエリ（キーは `['year', yearId, 'document', groupId]`。/document の画面と先読み〔planDocumentPrefetch〕が同じキャッシュを
 * 読む）。
 */
export function repDocumentsOptions(yearId: string | null | undefined, groupId: string | null | undefined) {
  return queryOptions({
    queryKey: queryKeys.yearPart(yearId ?? '', 'document', groupId ?? ''),
    queryFn: () => loadRepDocuments(yearId!, groupId!),
    enabled: !!yearId && !!groupId,
  });
}

/**
 * 団体の選び方（`?group=` が自分の団体ならそれ、なければ最初の団体。申請〔/request〕と同じ）。団体がなければ null。
 * /document の画面と先読みが同じ決め方にするため、軽いモジュールに置く。
 */
export function pickDocumentGroup<T extends { id: string }>(groups: readonly T[], param: string | null | undefined): T | null {
  return groups.find((g) => g.id === param) ?? groups[0] ?? null;
}

// ---------------------------------------------------------------- 使った量（部門長以上）

/** document_storage_usage の1行（bucket の合計と上限、その年度のファイルの数と大きさ、片付けていない物の数） */
export interface DocumentStorageUsage {
  bucket_bytes: number;
  limit_bytes: number;
  file_count: number;
  file_bytes: number;
  orphan_count: number;
}

interface LooseRpcGet {
  rpc(name: string, args: Record<string, unknown>, options: { get: true }): PromiseLike<Res>;
}

const numOr0 = (v: unknown) => (typeof v === 'number' && Number.isFinite(v) ? v : typeof v === 'string' && v.trim() !== '' && Number.isFinite(Number(v)) ? Number(v) : 0);

/** 使った量を読む（GET。読み取りだけの RPC。1行。行がなければ全部 0）。読めなければ AppError を投げる */
export async function loadDocumentStorageUsage(yearId: string, client: AppSupabaseClient = getSupabase()): Promise<DocumentStorageUsage> {
  const res = await (client as unknown as LooseRpcGet).rpc('document_storage_usage', { p_year_id: yearId }, { get: true });
  const row = (rowsOf<Record<string, unknown>>(res)[0] ?? {}) as Record<string, unknown>;
  return {
    bucket_bytes: numOr0(row.bucket_bytes),
    limit_bytes: numOr0(row.limit_bytes),
    file_count: numOr0(row.file_count),
    file_bytes: numOr0(row.file_bytes),
    orphan_count: numOr0(row.orphan_count),
  };
}

// ---------------------------------------------------------------- ダッシュボード（/）

/** ダッシュボード（総務）の提出物の1行 */
export type DocumentsPortalDocRow = Pick<Tables<'documents'>, 'id' | 'title' | 'deadline'>;
/** ダッシュボード（総務）の提出の状況の1行（団体 × 提出物。行のない提出は not_submitted） */
export type DocumentsPortalStatusRow = Pick<StatusView, 'document_id' | 'status'>;

/** ダッシュボード（総務）の読み取り。usage は部門長以上だけ（総務部門員は null） */
export interface DocumentsSoumuPortalRaw {
  docs: DocumentsPortalDocRow[];
  statuses: DocumentsPortalStatusRow[];
  usage: DocumentStorageUsage | null;
}

/** ダッシュボード（店長・副店長）の1行 */
export type DocumentsRepPortalRow = Pick<StatusView, 'document_id' | 'group_id' | 'status' | 'title' | 'deadline' | 'review_note'>;

/**
 * ダッシュボード（総務）の読み取り：提出物（締切 → 題名 → id）と提出の状況（全部の団体の行。fetchAll）を並行に、部門長以上
 * （tier が 'lead'）は加えて使った量（GET）。
 */
export async function loadDocumentsSoumuPortal(
  yearId: string,
  tier: 'lead' | 'staff',
  client: AppSupabaseClient = getSupabase(),
): Promise<DocumentsSoumuPortalRaw> {
  const [docs, statuses, usage] = await Promise.all([
    client
      .from('documents')
      .select(DOCUMENTS_PORTAL_DOC_SELECT)
      .eq('year_id', yearId)
      .order('deadline')
      .order('title')
      .order('id')
      .then((res) => rowsOf<DocumentsPortalDocRow>(res as Res)),
    fetchAll<DocumentsPortalStatusRow>(
      (from, to) =>
        client
          .from('v_document_status')
          .select(DOCUMENTS_PORTAL_STATUS_SELECT)
          .eq('year_id', yearId)
          .order('document_id')
          .order('group_id')
          .range(from, to) as unknown as PromiseLike<PageResult<DocumentsPortalStatusRow>>,
    ),
    tier === 'lead' ? loadDocumentStorageUsage(yearId, client) : Promise.resolve(null),
  ]);
  return { docs, statuses, usage };
}

/**
 * ダッシュボード（総務）のクエリ。キーは `portalQueryKey(yearId, 'documents', 'soumu', tier)`（部門長以上と総務部門員で読むものが違うので
 * 別のキー。/ の先読みも同じキャッシュ）。
 */
export function documentsSoumuPortalOptions(yearId: string, tier: 'lead' | 'staff') {
  return queryOptions({
    queryKey: portalQueryKey(yearId, 'documents', 'soumu', tier),
    queryFn: () => loadDocumentsSoumuPortal(yearId, tier),
  });
}

/** ダッシュボード（店長・副店長）の読み取り：代表する団体の行（締切 → 提出物 → 団体の順）。団体が 0 なら読まない */
export async function loadDocumentsRepPortal(
  yearId: string,
  groupIds: readonly string[],
  client: AppSupabaseClient = getSupabase(),
): Promise<DocumentsRepPortalRow[]> {
  if (groupIds.length === 0) return [];
  const res = await client
    .from('v_document_status')
    .select(DOCUMENTS_REP_PORTAL_SELECT)
    .eq('year_id', yearId)
    .in('group_id', [...groupIds])
    .order('deadline')
    .order('document_id')
    .order('group_id');
  return rowsOf<DocumentsRepPortalRow>(res as Res);
}

/**
 * ダッシュボード（店長・副店長）のクエリ。キーは `portalQueryKey(yearId, 'documents', 'rep', ...groupIds)`（団体の id は立場の一覧の順。
 * 代表する団体が変われば別のキャッシュ）。
 */
export function documentsRepPortalOptions(yearId: string, groupIds: readonly string[]) {
  return queryOptions({
    queryKey: portalQueryKey(yearId, 'documents', 'rep', ...groupIds),
    queryFn: () => loadDocumentsRepPortal(yearId, groupIds),
  });
}
