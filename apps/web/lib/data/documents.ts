// 提出物（/documents・/document）の読み取りと書き込み（04「提出物」「自団体の提出物」「提出状況」、notes/T19.md「パート B・C の約束」
// 2・3。T19・D-55）。
// - 読む：提出状況（documents・v_document_status・groups・profiles と、部門長以上は v_document_files。並行に）、使った量・前年度の提出物・
//   片付ける path（読み取りの RPC。GET で送る。POST は記録・先送りの残りの応答を捨てるため。04「ファイルの扱い」）。自団体の提出物と
//   ダッシュボードの読み取りは軽いモジュール lib/modules/documents/reads.ts（ルートのレイアウトの先読みが使う）にあり、ここから同じ名前で
//   出し直す（画面はこのファイルから読む）。キーはどれも `['year', yearId, 'documents' | 'document', …]`（年度の invalidate で消える）。
// - 書く：提出物の登録・変更・削除は画面から直接（RLS の can_lead。登録は画面が作った id で insert、変更・削除は読んだときの updated_at の
//   文字列のまま条件に入れる。(B1)。締切と予定と同じ）。提出とファイルは RPC（callRpc。引数は lib/rpc/payloads.ts の RPC_ARGS の zod で
//   確かめる）。ファイルは Supabase Storage の非公開の bucket documents（予約した path へ upload〔upsert: false〕・remove・押したときの
//   署名つき URL〔60 秒〕）。
// - Storage API のエラーは、本文の statusCode（"403"・"404"・"409"・"413"・"415"）と code で分けて AppError にする（toStorageAppError。
//   HTTP の status〔400〕は見ない）。upload の 409（もう届いていた）は成功と同じ。
// - 署名つき URL はキャッシュ・下書き・ログ・画面の URL に入れない（作って返すだけ）。元のファイル名はどこにも持たない（Q16）。
// 版（allocation_version）は使わない（提出物は振り分けの入力でない。D-55）。
import { Constants, type Database, type GroupCategory, type Tables } from '@gaapp/shared';
import { queryOptions, type QueryClient, type QueryKey } from '@tanstack/react-query';
import type { z } from 'zod';
import { deleteChecked } from '@/lib/db/delete-checked';
import { fetchAll, type PageResult } from '@/lib/db/fetch-all';
import { updateWithLock } from '@/lib/db/update-with-lock';
import { AppError, appError, classifyError, isUnknownOutcome, toAppError } from '@/lib/errors';
import { DOCUMENTS_BUCKET, SIGNED_URL_SECONDS } from '@/lib/modules/documents/files';
import type { DocumentContentType } from '@/lib/modules/documents/labels';
import {
  DOCUMENT_FILE_SELECT,
  loadDocumentStorageUsage,
  type DocumentFileRow,
  type DocumentStorageUsage,
} from '@/lib/modules/documents/reads';
import { queryKeys } from '@/lib/query';
import { callRpc } from '@/lib/rpc';
import { RPC_ARGS } from '@/lib/rpc/payloads';
import { normalizeReviewNote, REVIEW_NOTE_MAX } from '@/lib/schemas/document-fields';
import { charCount } from '@/lib/schemas/notice-fields';
import { getSupabase, type AppSupabaseClient } from '@/lib/supabase/client';

// 自団体の提出物とダッシュボードの読み取り（軽いモジュール）を、画面のために同じ名前で出し直す
export {
  DOCUMENT_FILE_SELECT,
  REP_DOCUMENT_STATUS_SELECT,
  documentsRepPortalOptions,
  documentsSoumuPortalOptions,
  loadDocumentStorageUsage,
  loadRepDocuments,
  pickDocumentGroup,
  repDocumentsOptions,
  type DocumentFileRow,
  type DocumentStorageUsage,
  type RepDocumentStatusRow,
  type RepDocumentsData,
} from '@/lib/modules/documents/reads';

// ---------------------------------------------------------------- 読む（提出状況）

/** 提出物の列（設定と提出状況の列の見出し。書いた人・直した人は読まない） */
export const DOCUMENT_COLUMNS = 'id, title, description, deadline, target_categories, food_only, requires_file, files_deleted_at, updated_at';

/** 提出物の1行 */
export type DocumentRow = Pick<
  Tables<'documents'>,
  'id' | 'title' | 'description' | 'deadline' | 'target_categories' | 'food_only' | 'requires_file' | 'files_deleted_at' | 'updated_at'
>;

/** 提出状況の提出の列（v_document_status。団体 × 提出物。題名・締切は提出物の行から引く） */
export const BOARD_STATUS_SELECT =
  'document_id, group_id, status, submitted_at, submitted_by, proxy, late, reviewed_at, reviewed_by, review_note, updated_at';

/** 提出状況の提出の1行（行のない提出は status が not_submitted、updated_at が null） */
export type BoardStatusRow = Pick<
  Tables<'v_document_status'>,
  | 'document_id'
  | 'group_id'
  | 'status'
  | 'submitted_at'
  | 'submitted_by'
  | 'proxy'
  | 'late'
  | 'reviewed_at'
  | 'reviewed_by'
  | 'review_note'
  | 'updated_at'
>;

/** 提出状況の団体の列 */
export const BOARD_GROUP_SELECT = 'id, name, display_name, category, is_food, sort_order';

/** 提出状況の団体の1行 */
export type BoardGroupRow = Pick<Tables<'groups'>, 'id' | 'name' | 'display_name' | 'category' | 'is_food' | 'sort_order'>;

/** 提出状況の段（部門長以上はファイルも読む。総務部門員は読まない。Q4） */
export type DocumentsBoardTier = 'lead' | 'staff';

/** 提出状況の画面のデータ */
export interface DocumentsBoardData {
  /** 締切 → 題名 → id の順 */
  docs: DocumentRow[];
  /** その年度の全部の団体の行（v_document_status。対象の団体だけ） */
  statuses: BoardStatusRow[];
  /** その年度の団体（並べ方は lib/modules/documents/board.ts） */
  groups: BoardGroupRow[];
  /** 表示名（user_id → 表示名。読めない人は入らない） */
  names: ReadonlyMap<string, string>;
  /** その年度のファイル（部門長以上だけ。総務部門員は null） */
  files: DocumentFileRow[] | null;
  /** 読み込んだ時刻（ISO） */
  loadedAt: string;
}

type Res = { data: unknown; error: unknown; status?: number };

function rowsOf<T>(res: Res): T[] {
  if (res.error) throw toAppError(res.error, res.status);
  return (res.data ?? []) as T[];
}

/**
 * 提出状況を読む（並行に）：提出物（締切 → 題名 → id）、v_document_status（その年度の全部。fetchAll）、団体、表示名（profiles。その人が
 * 読めるもの全部）。部門長以上は加えて v_document_files（その年度の全部。fetchAll）。読めなければ AppError を投げる。
 */
export async function loadDocumentsBoard(
  yearId: string,
  tier: DocumentsBoardTier,
  client: AppSupabaseClient = getSupabase(),
): Promise<DocumentsBoardData> {
  const [docs, statuses, groups, profiles, files] = await Promise.all([
    client
      .from('documents')
      .select(DOCUMENT_COLUMNS)
      .eq('year_id', yearId)
      .order('deadline')
      .order('title')
      .order('id')
      .then((res) => rowsOf<DocumentRow>(res as Res)),
    fetchAll<BoardStatusRow>(
      (from, to) =>
        client
          .from('v_document_status')
          .select(BOARD_STATUS_SELECT)
          .eq('year_id', yearId)
          .order('document_id')
          .order('group_id')
          .range(from, to) as unknown as PromiseLike<PageResult<BoardStatusRow>>,
    ),
    client
      .from('groups')
      .select(BOARD_GROUP_SELECT)
      .eq('year_id', yearId)
      .then((res) => rowsOf<BoardGroupRow>(res as Res)),
    fetchAll<{ user_id: string; display_name: string }>(
      (from, to) =>
        client.from('profiles').select('user_id, display_name').order('user_id').range(from, to) as unknown as PromiseLike<
          PageResult<{ user_id: string; display_name: string }>
        >,
    ),
    tier === 'lead'
      ? fetchAll<DocumentFileRow>(
          (from, to) =>
            client
              .from('v_document_files')
              .select(DOCUMENT_FILE_SELECT)
              .eq('year_id', yearId)
              .order('document_id')
              .order('group_id')
              .order('created_at')
              .order('id')
              .range(from, to) as unknown as PromiseLike<PageResult<DocumentFileRow>>,
        )
      : Promise.resolve(null),
  ]);
  return {
    docs,
    statuses,
    groups,
    names: new Map(profiles.map((p) => [p.user_id, p.display_name])),
    files,
    loadedAt: new Date().toISOString(),
  };
}

/** 提出状況のクエリ（キーは `['year', yearId, 'documents', 'board', tier]`。部門長以上と総務部門員で読むものが違うので別のキー） */
export function documentsBoardOptions(yearId: string | null | undefined, tier: DocumentsBoardTier) {
  return queryOptions({
    queryKey: queryKeys.yearPart(yearId ?? '', 'documents', 'board', tier),
    queryFn: () => loadDocumentsBoard(yearId!, tier),
    enabled: !!yearId,
  });
}

/**
 * 提出物の削除の確かめに出す提出の数（未提出でない提出。今の対象から外れた団体の分も数える。消すと cascade で一緒に消えるため。2026-11-03。
 * レビューの UX-5。04「提出状況」の提出物の設定の削除）。表 document_submissions をその提出物で読む（部門長以上は RLS でその年度の全部を読める。
 * v_document_status は今の対象の団体だけなので使わない）。読めなければ AppError を投げる。
 */
export async function countDocumentSubmissions(documentId: string, client: AppSupabaseClient = getSupabase()): Promise<number> {
  const rows = await fetchAll<{ group_id: string }>(
    (from, to) =>
      client
        .from('document_submissions')
        .select('group_id')
        .eq('document_id', documentId)
        .neq('status', 'not_submitted')
        .order('group_id')
        .range(from, to) as unknown as PromiseLike<PageResult<{ group_id: string }>>,
  );
  return rows.length;
}

/**
 * 削除の確かめの提出の数のクエリ（キーは `['year', yearId, 'documents', 'delete-count', documentId]`。確かめのダイアログを開いている間だけ使い、
 * 開くたびに読む〔古い数を出さない〕ので、読んだものをすぐ古いとし、閉じたら残さない）
 */
export function documentSubmissionCountOptions(yearId: string, documentId: string | null) {
  return queryOptions({
    queryKey: queryKeys.yearPart(yearId, 'documents', 'delete-count', documentId ?? ''),
    queryFn: () => countDocumentSubmissions(documentId!),
    enabled: !!documentId,
    staleTime: 0,
    gcTime: 0,
  });
}

/** 使った量のクエリ（キーは `['year', yearId, 'documents', 'usage']`。部門長以上。GET の document_storage_usage） */
export function documentStorageUsageOptions(yearId: string | null | undefined) {
  return queryOptions({
    queryKey: queryKeys.yearPart(yearId ?? '', 'documents', 'usage'),
    queryFn: (): Promise<DocumentStorageUsage> => loadDocumentStorageUsage(yearId!),
    enabled: !!yearId,
  });
}

// ---------------------------------------------------------------- 読み取りの RPC（GET）

/** 読み取りだけの RPC（GET で送る。STABLE） */
export type DocumentReadRpc = 'previous_year_documents' | 'document_orphan_paths' | 'document_storage_usage';

type Functions = Database['public']['Functions'];

interface LooseRpcGet {
  rpc(name: string, args: unknown, options: { get: true }): PromiseLike<Res>;
}

/**
 * 読み取りの RPC を GET で呼ぶ（`rpc(name, args, { get: true })`。POST で送ると、/ と /document の記録・先送りの残りの応答を、書き込みを
 * 送ったものとして捨ててしまうため。04「ファイルの扱い」）。引数は RPC_ARGS の zod で確かめてから送る（落ちたら input の AppError。
 * field は p_ を除いた引数の名前）。失敗したら AppError を投げる。lib/rpc の callRpc（POST）は変えない。
 */
export async function readRpc<N extends DocumentReadRpc>(
  name: N,
  args: z.input<(typeof RPC_ARGS)[N]>,
  client: AppSupabaseClient = getSupabase(),
): Promise<Functions[N]['Returns']> {
  const parsed = (RPC_ARGS[name] as z.ZodType).safeParse(args);
  if (!parsed.success) {
    const arg = parsed.error.issues[0]?.path[0];
    const field = typeof arg === 'string' ? arg.replace(/^p_/, '') : '';
    throw appError('input', 'client_validation', field ? { field } : null);
  }
  const res = await (client as unknown as LooseRpcGet).rpc(name, parsed.data, { get: true });
  if (res.error) throw toAppError(res.error, res.status);
  return res.data as Functions[N]['Returns'];
}

/** 前年度の提出物の1行（previous_year_documents。new_deadline は1日目の差の日数だけずらした締切、exists_in_year は同じ題名がこの年度にある） */
export interface PreviousYearDocument {
  document_id: string;
  title: string;
  description: string | null;
  deadline: string;
  new_deadline: string;
  target_categories: GroupCategory[];
  food_only: boolean;
  requires_file: boolean;
  exists_in_year: boolean;
}

/** 前年度の提出物を読む（複製元がなければ空。締切 → 題名 → id の順） */
export async function loadPreviousYearDocuments(yearId: string, client: AppSupabaseClient = getSupabase()): Promise<PreviousYearDocument[]> {
  const rows = await readRpc('previous_year_documents', { p_year_id: yearId }, client);
  return (rows ?? []) as unknown as PreviousYearDocument[];
}

/**
 * 前年度の提出物のクエリ（キーは `['year', yearId, 'documents', 'previous']`。「前年度から写す」のダイアログを開いている間だけ使い、開くたびに
 * 読む〔古いものを使わない〕ので、読んだものをすぐ古いとし、閉じたら残さない）
 */
export function previousYearDocumentsOptions(yearId: string | null | undefined) {
  return queryOptions({
    queryKey: queryKeys.yearPart(yearId ?? '', 'documents', 'previous'),
    queryFn: () => loadPreviousYearDocuments(yearId!),
    enabled: !!yearId,
    staleTime: 0,
    gcTime: 0,
  });
}

// ---------------------------------------------------------------- Storage

/** Storage の操作で使う最小の形（supabase-js の storage.from(bucket)。テストの偽物もこの形を満たす） */
interface StorageBucketApi {
  upload(path: string, body: Blob, options: { contentType: string; upsert: boolean }): Promise<{ data: unknown; error: unknown }>;
  remove(paths: string[]): Promise<{ data: unknown[] | null; error: unknown }>;
  createSignedUrl(path: string, expiresIn: number, options?: { download: string }): Promise<{ data: { signedUrl: string } | null; error: unknown }>;
}

function bucket(client: AppSupabaseClient): StorageBucketApi {
  return (client as unknown as { storage: { from(id: string): StorageBucketApi } }).storage.from(DOCUMENTS_BUCKET);
}

const isRecord = (v: unknown): v is Record<string, unknown> => typeof v === 'object' && v !== null && !Array.isArray(v);

/** Storage の AppError の reason（lib/errors.ts の STORAGE_ERROR_MESSAGES） */
export type StorageErrorReason = 'storage_denied' | 'storage_missing' | 'storage_too_large' | 'storage_mime' | 'storage_failed';

function storageError(kind: 'forbidden' | 'not_found' | 'input' | 'unknown', reason: StorageErrorReason, details: unknown, status: number | null): AppError {
  return new AppError({ kind, code: null, reason, details, issues: [], status });
}

/** Storage の本文の statusCode（"409" など）と code（KeyAlreadyExists など）。Storage のエラーでなければ null */
function storageCodes(e: unknown): { statusCode: string; code: string } | null {
  if (!isRecord(e) || !('__isStorageError' in e)) return null;
  return { statusCode: typeof e.statusCode === 'string' || typeof e.statusCode === 'number' ? String(e.statusCode) : '', code: typeof e.code === 'string' ? e.code : '' };
}

/** upload の「もう届いていた」（本文の statusCode が "409" か、code が KeyAlreadyExists・Duplicate。HTTP の status〔400〕ではない） */
export function isAlreadyUploaded(e: unknown): boolean {
  const c = storageCodes(e);
  return !!c && (c.statusCode === '409' || c.code === 'KeyAlreadyExists' || c.code === 'Duplicate');
}

/**
 * Storage API のエラーを AppError にする（本文の statusCode と code で分ける。HTTP の status〔Storage API はどれも 400 で返す〕は見ない）：
 * - "403"・AccessDenied → forbidden（storage_denied。ポリシーとトリガーが止めた。読み直す）
 * - "404"・not_found・NoSuchKey → not_found（storage_missing。読めない・ない）
 * - "413"・EntityTooLarge → input（storage_too_large。field: size）
 * - "415"・InvalidMimeType → input（storage_mime。field: content_type）
 * - 通信の失敗（fetch の TypeError・中止。storage-js の StorageUnknownError に包まれたものも）→ 今の network
 * - ほか → unknown（storage_failed。5xx なら status を持つ）
 * AppError はそのまま返す。
 */
export function toStorageAppError(e: unknown): AppError {
  if (e instanceof AppError) return e;
  const c = storageCodes(e);
  if (!c) return toAppError(e);
  if (isRecord(e) && e.name === 'StorageUnknownError') {
    const original = e.originalError;
    if (original instanceof TypeError || (original instanceof Error && original.name === 'AbortError')) return toAppError(original);
    return storageError('unknown', 'storage_failed', null, null);
  }
  const numeric = Number(c.statusCode);
  const status = Number.isInteger(numeric) && numeric >= 100 && numeric <= 599 ? numeric : null;
  if (c.statusCode === '403' || c.code === 'AccessDenied') return storageError('forbidden', 'storage_denied', null, status);
  if (c.statusCode === '404' || c.code === 'not_found' || c.code === 'NoSuchKey') return storageError('not_found', 'storage_missing', null, status);
  if (c.statusCode === '413' || c.code === 'EntityTooLarge') return storageError('input', 'storage_too_large', { field: 'size' }, status);
  if (c.statusCode === '415' || c.code === 'InvalidMimeType') return storageError('input', 'storage_mime', { field: 'content_type' }, status);
  return storageError('unknown', 'storage_failed', null, status);
}

/**
 * 予約した path へ上げる（`upload(objectPath, blob, { contentType, upsert: false })`。上書きしない）。届いたら 'uploaded'、409
 * （もう届いていた。通信が切れた後の送り直し）なら 'already'。ほかの失敗は toStorageAppError の AppError を投げる。
 * 送る物は contentType（先頭のバイトで決めた形）の新しい Blob にする：storage-js（2.118）は Blob を multipart で送り、contentType を
 * 使わず、part の形は Blob の type、名前は File の name になる。選んだ File のままだと、ブラウザが付けた形（空・別名の形なら bucket の
 * 形の制限で 415）と元のファイル名（Q16）が Storage へ届くため（中身は同じ。写しは作らない）。
 */
export async function uploadDocumentFile(
  objectPath: string,
  blob: Blob,
  contentType: DocumentContentType,
  client: AppSupabaseClient = getSupabase(),
): Promise<'uploaded' | 'already'> {
  const body = new Blob([blob], { type: contentType });
  let res: { data: unknown; error: unknown };
  try {
    res = await bucket(client).upload(objectPath, body, { contentType, upsert: false });
  } catch (e) {
    throw toStorageAppError(e);
  }
  if (!res.error) return 'uploaded';
  if (isAlreadyUploaded(res.error)) return 'already';
  throw toStorageAppError(res.error);
}

/** Storage の物を消す（どの提出にも属さないものだけ消える。消せた数。失敗したら toStorageAppError の AppError を投げる） */
export async function removeDocumentObjects(paths: readonly string[], client: AppSupabaseClient = getSupabase()): Promise<number> {
  if (paths.length === 0) return 0;
  let res: { data: unknown[] | null; error: unknown };
  try {
    res = await bucket(client).remove([...paths]);
  } catch (e) {
    throw toStorageAppError(e);
  }
  if (res.error) throw toStorageAppError(res.error);
  return res.data?.length ?? 0;
}

/** 片付けで1回に消す数 */
export const CLEANUP_CHUNK = 100;

/**
 * どの提出にも属さないファイルを片付ける：document_orphan_paths（GET）の path を 100 ずつ remove する。found は見つけた数、removed は消せた数
 * （消せなかった 100 件のまとまりは数えずに続ける。画面は知らせない。管理者の年度のファイルの削除だけが found − removed を出す）。
 * path を読めなければ AppError を投げる（呼ぶ側は飲み込む）。何度呼んでもよい（残った物だけを消す）。
 */
export async function cleanupDocumentOrphans(yearId: string, client: AppSupabaseClient = getSupabase()): Promise<{ found: number; removed: number }> {
  const paths = ((await readRpc('document_orphan_paths', { p_year_id: yearId }, client)) ?? []) as string[];
  let removed = 0;
  for (let k = 0; k < paths.length; k += CLEANUP_CHUNK) {
    try {
      removed += await removeDocumentObjects(paths.slice(k, k + CLEANUP_CHUNK), client);
    } catch {
      // 消せなかった分は残る（次の片付けで消す）
    }
  }
  return { found: paths.length, removed };
}

/**
 * 署名つき URL に保存の名前（Storage の download。Content-Disposition: attachment の名前になる）を、一度だけ符号化して足す。
 * storage-js 2.118 の createSignedUrl に download を渡すと、URLSearchParams で符号化した後に URL 全体を encodeURI するので名前が二重に
 * 符号化され、Storage は「E2E %E5%87%BA…」のような名前で返す（日本語の名前が読めなくなる。E2E で見つけた）。そのため download は
 * storage-js に渡さず、返った URL に足す（Storage はクエリを1回だけ戻す）。
 *
 * @example
 * withDownloadName('https://x/storage/v1/object/sign/documents/a.pdf?token=t', '出店計画書_模擬店01_1.pdf')
 * // 'https://x/storage/v1/object/sign/documents/a.pdf?token=t&download=%E5%87%BA…'
 */
export function withDownloadName(signedUrl: string, download: string): string {
  return `${signedUrl}${signedUrl.includes('?') ? '&' : '?'}download=${encodeURIComponent(download)}`;
}

/**
 * 開く・保存の署名つき URL（押したときに作る。60 秒だけ使える。download を渡すと保存の名前つき〔Content-Disposition: attachment〕。
 * 名前は withDownloadName で足す）。URL はキャッシュ・下書き・ログ・画面の URL に入れない（返すだけ）。失敗したら toStorageAppError の
 * AppError（読めない・ないは not_found の storage_missing）を投げる。
 */
export async function signDocumentFile(objectPath: string, download?: string, client: AppSupabaseClient = getSupabase()): Promise<string> {
  let res: { data: { signedUrl: string } | null; error: unknown };
  try {
    res = await bucket(client).createSignedUrl(objectPath, SIGNED_URL_SECONDS);
  } catch (e) {
    throw toStorageAppError(e);
  }
  if (res.error) throw toStorageAppError(res.error);
  if (!res.data?.signedUrl) throw storageError('unknown', 'storage_failed', null, null);
  return download ? withDownloadName(res.data.signedUrl, download) : res.data.signedUrl;
}

// ---------------------------------------------------------------- 提出物（直接の書き込み）

/** 提出物の送る値（lib/schemas/documents.ts の toDocumentWrite が作る）。書いた人・直した人・日時・files_deleted_at は送らない（DB が入れる） */
export interface DocumentWrite {
  /** 前後の空白を除いた 1〜100 字 */
  title: string;
  /** 前後の空白を除いた説明（空なら null。2000 字まで） */
  description: string | null;
  /** Asia/Tokyo の締切（`YYYY-MM-DDTHH:mm:00+09:00`） */
  deadline: string;
  /** 出す団体の区分（1つ以上。DB が重なりを除いて並べる） */
  target_categories: GroupCategory[];
  food_only: boolean;
  requires_file: boolean;
}

/** 同じ年度に同じ題名がある（23505・documents_year_id_title_key）ときの AppError の reason */
export const DOCUMENT_TITLE_TAKEN_REASON = 'document_title_taken';

/** 同じ題名で止められたか（登録・変更の 23505 のうち、documents_year_id_title_key のもの） */
export function isDocumentTitleTaken(e: unknown): boolean {
  return classifyError(e).reason === DOCUMENT_TITLE_TAKEN_REASON;
}

/** 23505 を制約で分ける（題名なら reason を DOCUMENT_TITLE_TAKEN_REASON に。主キー〔documents_pkey。送り直し〕はそのまま） */
function insertError(e: unknown, status?: number): AppError {
  const err = toAppError(e, status);
  if (err.info.code === '23505' && isRecord(e) && typeof e.message === 'string' && e.message.includes('documents_year_id_title_key')) {
    return new AppError({ ...err.info, reason: DOCUMENT_TITLE_TAKEN_REASON, details: { field: 'title' } });
  }
  return err;
}

/** 行の列を DocumentRow にそろえる（updateWithLock・deleteChecked は全部の列を返すので、キャッシュに余分な列を入れない） */
export function toDocumentRow(row: DocumentRow): DocumentRow {
  return {
    id: row.id,
    title: row.title,
    description: row.description,
    deadline: row.deadline,
    target_categories: row.target_categories,
    food_only: row.food_only,
    requires_file: row.requires_file,
    files_deleted_at: row.files_deleted_at,
    updated_at: row.updated_at,
  };
}

// 登録とファイルの id（uuid v4）は、書き込みの JS を読む前にも使うので小さなモジュールに置き、同じ名前で出し直す（FU3 の PR B の案 5）
export { newDocumentUuid } from '@/lib/modules/documents/uuid';

/**
 * 登録：画面が作った id で insert し、行を返させる。送り直しは主キーの重複（23505。conflict）で止まる（画面は readDocument で読み直して
 * 入力と比べる）。同じ題名は 23505 で reason が DOCUMENT_TITLE_TAKEN_REASON。書けなければ 42501（forbidden）。失敗したら AppError を投げる。
 */
export async function insertDocument(yearId: string, id: string, w: DocumentWrite, client: AppSupabaseClient = getSupabase()): Promise<DocumentRow> {
  const res = await client
    .from('documents')
    .insert({ id, year_id: yearId, ...w })
    .select(DOCUMENT_COLUMNS)
    .single();
  if (res.error) throw insertError(res.error, res.status);
  return res.data as DocumentRow;
}

/**
 * 変更：読んだときの updated_at（受け取った文字列のまま）を条件に入れて、全部の欄を置き換える（updateWithLock）。0 行なら explainZeroRows の
 * AppError（not_found＝lock_missing・conflict＝lock_conflict・forbidden＝lock_unchanged）を投げる。23505 は同じ題名（主キーは変えないので、
 * reason を DOCUMENT_TITLE_TAKEN_REASON にする）。
 */
export async function updateDocument(
  row: Pick<DocumentRow, 'id' | 'updated_at'>,
  w: DocumentWrite,
  client: AppSupabaseClient = getSupabase(),
): Promise<DocumentRow> {
  try {
    const saved = await updateWithLock(client, 'documents', { id: row.id }, row.updated_at, { ...w });
    return toDocumentRow(saved);
  } catch (e) {
    const err = toAppError(e);
    if (err.info.code === '23505') throw new AppError({ ...err.info, reason: DOCUMENT_TITLE_TAKEN_REASON, details: { field: 'title' } });
    throw err;
  }
}

/**
 * 削除：読んだときの updated_at を条件に入れて delete し、消えた行を受け取る（deleteChecked）。提出とファイルの行も cascade で消える
 * （Storage の物は残るので、画面は続けて cleanupDocumentOrphans）。0 行なら explainZeroRows の AppError を投げる。
 */
export async function deleteDocument(row: Pick<DocumentRow, 'id' | 'updated_at'>, client: AppSupabaseClient = getSupabase()): Promise<DocumentRow> {
  const deleted = await deleteChecked(client, 'documents', { id: row.id }, row.updated_at);
  return toDocumentRow(deleted);
}

/** その提出物を1行読む（(B1) の読み直し）。なければ（消えた・読めない）null。読めなければ AppError を投げる */
export async function readDocument(id: string, client: AppSupabaseClient = getSupabase()): Promise<DocumentRow | null> {
  const res = await client.from('documents').select(DOCUMENT_COLUMNS).eq('id', id).maybeSingle();
  if (res.error) throw toAppError(res.error, res.status);
  return (res.data as DocumentRow | null) ?? null;
}

const CATEGORY_ORDER: readonly GroupCategory[] = Constants.public.Enums.group_category;

/** 区分を DB と同じ形にそろえる（重なりを除き、列挙の順に並べる。documents の normalize_target_categories と同じ） */
export function normalizeCategories(categories: readonly GroupCategory[]): GroupCategory[] {
  const set = new Set(categories);
  return CATEGORY_ORDER.filter((c) => set.has(c));
}

/** 同じ時刻か（DB は UTC で返すので、文字列でなく Date.parse で比べる） */
function sameInstant(a: string, b: string): boolean {
  const ta = Date.parse(a);
  return !Number.isNaN(ta) && ta === Date.parse(b);
}

/**
 * 読み直した提出物が送った値と同じか（題名・説明〔null と空をそろえる〕・飲食の団体だけ・ファイルが要るは同じ値、締切は同じ時刻、区分は
 * 重なりを除いた同じ組）。(B1) の「保存されていました」「登録されていました」と、編集で何も変えていないかの判定に使う。
 */
export function sameDocumentWrite(row: Pick<DocumentRow, keyof DocumentWrite>, w: DocumentWrite): boolean {
  const a = normalizeCategories(row.target_categories);
  const b = normalizeCategories(w.target_categories);
  return (
    row.title === w.title &&
    (row.description || null) === (w.description || null) &&
    row.food_only === w.food_only &&
    row.requires_file === w.requires_file &&
    sameInstant(row.deadline, w.deadline) &&
    a.length === b.length &&
    a.every((c, k) => c === b[k])
  );
}

// ---------------------------------------------------------------- ファイル（RPC と Storage）

/** 予約の返り値（document_files の行） */
export type ReservedDocumentFile = Tables<'document_files'>;

/** 予約に送るもの（file_id は画面が作る uuid。送り直しも同じ id。content_type は先頭のバイトで決めた形、size は送る Blob の大きさそのまま） */
export interface ReserveDocumentFileInput {
  /** too_many_orphans のときの片付け（document_orphan_paths）に使う年度 */
  yearId: string;
  documentId: string;
  groupId: string;
  fileId: string;
  contentType: DocumentContentType;
  size: number;
}

/** invalid_state の reason が too_many_orphans か */
function isTooManyOrphans(e: unknown): boolean {
  const c = classifyError(e);
  return c.kind === 'state' && isRecord(c.details) && c.details.reason === 'too_many_orphans';
}

/**
 * ファイルを予約する（reserve_document_file。返り値の object_path へ upload する）。同じ file_id で送り直すと同じ行が返る（(B1)）。
 * invalid_state の too_many_orphans（その団体のフォルダのどの提出にも属さない物が 5 つ以上）なら、cleanupDocumentOrphans をしてから
 * 同じ file_id で1回だけ予約し直す（それでも返ればその AppError）。ほかの失敗は AppError を投げる。
 */
export async function reserveDocumentFile(input: ReserveDocumentFileInput, client: AppSupabaseClient = getSupabase()): Promise<ReservedDocumentFile> {
  const args = {
    p_document_id: input.documentId,
    p_group_id: input.groupId,
    p_file_id: input.fileId,
    p_content_type: input.contentType,
    p_size: input.size,
  };
  try {
    return await callRpc('reserve_document_file', args, client);
  } catch (e) {
    if (!isTooManyOrphans(e)) throw e;
  }
  try {
    await cleanupDocumentOrphans(input.yearId, client);
  } catch {
    // 片付けられなくても予約し直す（まだ多ければ too_many_orphans が返り、画面がその文言を出す）
  }
  return callRpc('reserve_document_file', args, client);
}

/** その1つのファイルを読む（v_document_files。(B1) の読み直し）。なければ（外された・読めない）null。読めなければ AppError を投げる */
export async function readDocumentFile(fileId: string, client: AppSupabaseClient = getSupabase()): Promise<DocumentFileRow | null> {
  const res = await client.from('v_document_files').select(DOCUMENT_FILE_SELECT).eq('id', fileId).maybeSingle();
  if (res.error) throw toAppError(res.error, res.status);
  return (res.data as DocumentFileRow | null) ?? null;
}

/** 外すの結果：外れた（before は、応答が届かなかったが読み直すともうなかった）か、外せたか分からない（入力を残し、もう一度押せる） */
export type DiscardDocumentFileResult = { type: 'removed'; before: boolean } | { type: 'unknown' };

async function removeQuietly(path: string, client: AppSupabaseClient): Promise<void> {
  try {
    await removeDocumentObjects([path], client);
  } catch {
    // 消せなかった物はどの提出にも属さないファイルとして残り、片付けで消える（知らせない）
  }
}

/**
 * ファイルを外す（discard_document_file → 返った object_path をすぐ remove。remove の失敗は飲み込む）。応答が届かなかったとき（(B1)）は
 * そのファイルを読み直し、なければ外せたと同じに扱う（読んだ行の object_path を remove する）、あれば・読み直せなければ 'unknown'
 * （「外せたか分かりません。もう一度「外す」を押すと…」）。ほかの失敗（forbidden・invalid_state・not_found）は AppError を投げる。
 */
export async function discardDocumentFile(
  file: Pick<DocumentFileRow, 'id' | 'object_path'>,
  client: AppSupabaseClient = getSupabase(),
): Promise<DiscardDocumentFileResult> {
  let path: string;
  try {
    path = await callRpc('discard_document_file', { p_file_id: file.id }, client);
  } catch (e) {
    if (!isUnknownOutcome(e)) throw e;
    let row: DocumentFileRow | null;
    try {
      row = await readDocumentFile(file.id, client);
    } catch {
      return { type: 'unknown' };
    }
    if (row) return { type: 'unknown' };
    await removeQuietly(file.object_path, client);
    return { type: 'removed', before: true };
  }
  await removeQuietly(path || file.object_path, client);
  return { type: 'removed', before: false };
}

// ---------------------------------------------------------------- 提出・取り消し・承認・差し戻し（RPC）

/** 提出の行（RPC の返り値） */
export type DocumentSubmissionRow = Tables<'document_submissions'>;

/**
 * 「提出した」（店長・副店長、部門長以上の代理）。base は読んだときの提出の updated_at（行がなければ null）。失敗したら AppError を投げる
 * （応答が届かなかった・止められたときの決め方は画面〔読み直して lib/modules/documents/outcome.ts の settleSubmissionOutcome〕）。
 */
export function submitDocument(documentId: string, groupId: string, base: string | null, client: AppSupabaseClient = getSupabase()): Promise<DocumentSubmissionRow> {
  return callRpc('submit_document', { p_document_id: documentId, p_group_id: groupId, p_base_updated_at: base }, client);
}

/** 「提出を取り消す」（提出済み → 未提出。base は null にしない） */
export function withdrawDocument(documentId: string, groupId: string, base: string, client: AppSupabaseClient = getSupabase()): Promise<DocumentSubmissionRow> {
  return callRpc('withdraw_document', { p_document_id: documentId, p_group_id: groupId, p_base_updated_at: base }, client);
}

/** 理由・メモの長さの確かめ（送る前。DB と同じ数え方。reason を付けて、DB の invalid_input と同じ文言にする） */
function noteTooLong(note: string): boolean {
  return charCount(note) > REVIEW_NOTE_MAX;
}

/**
 * 承認（提出済み → 承認。メモは任意）と、紙などで受け取った承認（未提出・差し戻し → 承認。メモが必須〔DB が状態を見て
 * invalid_input の note・required〕）。メモは前後の空白を除き、空なら null。1000 字を超えれば送らずに input（note・too_long）。
 */
export function approveDocument(
  documentId: string,
  groupId: string,
  note: string | null,
  base: string | null,
  client: AppSupabaseClient = getSupabase(),
): Promise<DocumentSubmissionRow> {
  const n = normalizeReviewNote(note);
  if (n !== null && noteTooLong(n)) return Promise.reject(appError('input', 'client_validation', { field: 'note', reason: 'too_long' }));
  return callRpc('approve_document', { p_document_id: documentId, p_group_id: groupId, p_note: n, p_base_updated_at: base }, client);
}

/**
 * 差し戻し（提出済み・承認・差し戻し → 差し戻し。承認の取り消しと理由の書き直しも兼ねる）。理由は必須（前後の空白を除いて 1〜1000 字。
 * 空なら送らずに input〔note・required〕、長ければ input〔note・too_long〕）。base は null にしない。
 */
export function returnDocument(
  documentId: string,
  groupId: string,
  note: string,
  base: string,
  client: AppSupabaseClient = getSupabase(),
): Promise<DocumentSubmissionRow> {
  const n = normalizeReviewNote(note);
  if (n === null) return Promise.reject(appError('input', 'client_validation', { field: 'note', reason: 'required' }));
  if (noteTooLong(n)) return Promise.reject(appError('input', 'client_validation', { field: 'note', reason: 'too_long' }));
  return callRpc('return_document', { p_document_id: documentId, p_group_id: groupId, p_note: n, p_base_updated_at: base }, client);
}

/**
 * その提出を1行読む（v_document_status。(B1) の読み直し）。行のない提出も未提出として返る（updated_at は null）。対象でない・消えた・読めない
 * なら null。読めなければ AppError を投げる。
 */
export async function readSubmission(documentId: string, groupId: string, client: AppSupabaseClient = getSupabase()): Promise<BoardStatusRow | null> {
  const res = await client
    .from('v_document_status')
    .select(BOARD_STATUS_SELECT)
    .eq('document_id', documentId)
    .eq('group_id', groupId)
    .maybeSingle();
  if (res.error) throw toAppError(res.error, res.status);
  return (res.data as BoardStatusRow | null) ?? null;
}

// ---------------------------------------------------------------- 前年度から写す・年度のファイルの削除（RPC）

/** 前年度から写す（同じ題名は飛ばす。写した行を返す。何度呼んでも同じ結果） */
export async function copyPreviousDocuments(yearId: string, documentIds: readonly string[], client: AppSupabaseClient = getSupabase()): Promise<DocumentRow[]> {
  const rows = await callRpc('copy_previous_documents', { p_year_id: yearId, p_document_ids: [...documentIds] }, client);
  return ((rows ?? []) as DocumentRow[]).map(toDocumentRow);
}

/** 年度のファイルの削除の結果：消した行の数と、続けた片付けの結果（片付けを読めなければ null） */
export interface DeleteYearFilesResult {
  deleted: number;
  cleanup: { found: number; removed: number } | null;
}

/**
 * 終了した年度のファイルをすべて削除する（管理者。delete_year_document_files → cleanupDocumentOrphans）。理由は省ける（空なら DB が
 * 「提出物のファイルの削除」にする）。2回目は deleted が 0（片付けは残った物だけを消す）。RPC の失敗は AppError を投げる。
 */
export async function deleteYearDocumentFiles(
  yearId: string,
  reason: string | null | undefined,
  client: AppSupabaseClient = getSupabase(),
): Promise<DeleteYearFilesResult> {
  const deleted = await callRpc('delete_year_document_files', { p_year_id: yearId, p_reason: reason ?? null }, client);
  // 片付けを読めなくても削除はできている（片付けは「片付ける」でもう一度できる）
  const cleanup = await cleanupDocumentOrphans(yearId, client).catch(() => null);
  return { deleted: deleted ?? 0, cleanup };
}

// ---------------------------------------------------------------- 読み直し

/**
 * 書いた後に読み直すキー：提出状況・使った量・前年度（`['year', y, 'documents']`）、自団体の提出物（`['year', y, 'document']`）、
 * ダッシュボードの提出物（`['year', y, 'portal', 'documents']`。/calendar の機能の日付も同じプロバイダのキー）
 */
export function documentsInvalidateKeys(yearId: string): QueryKey[] {
  return [queryKeys.yearPart(yearId, 'documents'), queryKeys.yearPart(yearId, 'document'), queryKeys.yearPart(yearId, 'portal', 'documents')];
}

/** 書いた後・止められた後に、提出物の読み取りを全部読み直す（待たない） */
export function invalidateDocuments(queryClient: QueryClient, yearId: string): void {
  for (const queryKey of documentsInvalidateKeys(yearId)) void queryClient.invalidateQueries({ queryKey });
}
