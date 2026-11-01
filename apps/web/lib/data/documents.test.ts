// 提出物の読み書き（04「提出物」の書き込みの決まり・ファイルの扱い・エラーの文言、notes/T19.md「パート B・C の約束」2・3。T19）。
// Supabase は偽のクライアント（lib/testing/fake-supabase.ts の from・rpc に、rpc の3つ目の引数と storage.from('documents') を足したもの）。
// - 提出状況の読み取り（部門長以上はファイルも、総務部門員は読まない）と、読み取りの RPC を GET で送ること（POST にしない）
// - 予約 → 上げる（upsert: false。本文の statusCode "409" はもう届いていた）→ 失敗と「もう一度」（同じ file_id）、too_many_orphans の片付けと
//   1回だけの予約し直し、外す（すぐ remove・応答が届かなかったときの読み直し）、Storage のエラーの分け方（HTTP の status は見ない）
// - 提出物の直接の書き込み（題名の 23505・主キーの 23505・0 行）、提出・取り消し・承認・差し戻しの引数（版と理由・メモ）と送る前の確かめ
import type { QueryClient } from '@tanstack/react-query';
import { describe, expect, it, vi } from 'vitest';
import { AppError, classifyError, isUnknownOutcome, messageFor } from '@/lib/errors';
import { queryKeys } from '@/lib/query';
import type { AppSupabaseClient } from '@/lib/supabase/client';
import { createFakeSupabase, opArgs, type FakeCall, type FakeResult } from '@/lib/testing/fake-supabase';
import {
  approveDocument,
  BOARD_GROUP_SELECT,
  BOARD_STATUS_SELECT,
  cleanupDocumentOrphans,
  copyPreviousDocuments,
  deleteDocument,
  deleteYearDocumentFiles,
  discardDocumentFile,
  DOCUMENT_COLUMNS,
  DOCUMENT_FILE_SELECT,
  DOCUMENT_TITLE_TAKEN_REASON,
  documentsBoardOptions,
  documentsInvalidateKeys,
  documentStorageUsageOptions,
  insertDocument,
  invalidateDocuments,
  isAlreadyUploaded,
  isDocumentTitleTaken,
  loadDocumentsBoard,
  newDocumentUuid,
  normalizeCategories,
  previousYearDocumentsOptions,
  readDocument,
  readDocumentFile,
  readRpc,
  readSubmission,
  removeDocumentObjects,
  reserveDocumentFile,
  returnDocument,
  sameDocumentWrite,
  signDocumentFile,
  submitDocument,
  toStorageAppError,
  updateDocument,
  uploadDocumentFile,
  withdrawDocument,
  type DocumentWrite,
} from './documents';

const Y = '11111111-1111-4111-8111-111111111111';
const G = '22222222-2222-4222-8222-222222222222';
const D = '33333333-3333-4333-8333-333333333333';
const F = '44444444-4444-4444-8444-444444444444';
const PATH = `${Y}/${G}/${D}/${F}.pdf`;
const V = '2026-10-01T00:00:00.123456+00:00';

/** storage-js の StorageApiError の形（本文の statusCode・code。HTTP の status は Storage API ではいつも 400） */
const storageApiError = (statusCode: string, code: string) => ({
  __isStorageError: true,
  name: 'StorageApiError',
  message: code,
  status: 400,
  statusCode,
  code,
});
/** storage-js の StorageUnknownError（fetch の失敗を包んだもの） */
const storageUnknown = (original: unknown) => ({ __isStorageError: true, name: 'StorageUnknownError', message: 'x', originalError: original });
const NETWORK: FakeResult = { error: { code: '', message: 'TypeError: Failed to fetch' }, status: 0 };

interface StorageCall {
  op: 'upload' | 'remove' | 'createSignedUrl';
  args: unknown[];
}

/** 偽の Supabase：from・rpc は fake-supabase（rpc の3つ目の引数も記録）、storage.from('documents') は storage の関数 */
function fake(handler: (call: FakeCall) => FakeResult | Promise<FakeResult>, storage: Partial<Record<StorageCall['op'], (...args: unknown[]) => unknown>> = {}) {
  const f = createFakeSupabase(handler);
  const rpcOptions: { name: string; options: unknown }[] = [];
  const storageCalls: StorageCall[] = [];
  const buckets: string[] = [];
  const inner = f.client as unknown as { from(t: string): unknown; rpc(n: string, a: unknown): unknown };
  const op =
    (name: StorageCall['op']) =>
    async (...args: unknown[]) => {
      storageCalls.push({ op: name, args });
      const fn = storage[name];
      return fn ? fn(...args) : { data: name === 'remove' ? [] : name === 'createSignedUrl' ? { signedUrl: 'https://x/sign?token=t' } : {}, error: null };
    };
  const client = {
    from: (t: string) => inner.from(t),
    rpc: (name: string, args: unknown, options?: unknown) => {
      rpcOptions.push({ name, options });
      return inner.rpc(name, args);
    },
    storage: {
      from: (bucket: string) => {
        buckets.push(bucket);
        return { upload: op('upload'), remove: op('remove'), createSignedUrl: op('createSignedUrl') };
      },
    },
  } as unknown as AppSupabaseClient;
  return { client, issued: f.issued, rpcOptions, storageCalls, buckets };
}

const caught = async (p: Promise<unknown>) => {
  try {
    await p;
  } catch (e) {
    if (e instanceof AppError) return e.info;
    throw e;
  }
  throw new Error('投げなかった');
};
const rpcArgs = (c: FakeCall) => c.ops[0]!.args[0];

const WRITE: DocumentWrite = {
  title: '出店計画',
  description: null,
  deadline: '2026-10-05T17:00:00+09:00',
  target_categories: ['stall', 'department'],
  food_only: false,
  requires_file: true,
};
const DOC_ROW = { id: D, ...WRITE, deadline: '2026-10-05T08:00:00+00:00', files_deleted_at: null, updated_at: V };

// ---------------------------------------------------------------- 読む

describe('T19 提出状況の読み取り（loadDocumentsBoard）', () => {
  const rows: Record<string, unknown[]> = {
    documents: [DOC_ROW],
    v_document_status: [{ document_id: D, group_id: G, status: 'submitted' }],
    groups: [{ id: G, name: '模擬店01' }],
    profiles: [{ user_id: 'u1', display_name: '部門長A' }],
    v_document_files: [{ id: F, document_id: D, group_id: G }],
  };

  it('部門長以上：提出物・提出の状況・団体・表示名・ファイルを並行に（版は読まない）', async () => {
    const { client, issued } = fake((call) => ({ data: rows[call.table] ?? [] }));
    const data = await loadDocumentsBoard(Y, 'lead', client);
    expect(issued.map((c) => c.table).sort()).toEqual(['documents', 'groups', 'profiles', 'v_document_files', 'v_document_status']);
    const by = (t: string) => issued.find((c) => c.table === t)!;
    expect(opArgs(by('documents'), 'select')[0]![0]).toBe(DOCUMENT_COLUMNS);
    expect(opArgs(by('documents'), 'order').map((a) => a[0])).toEqual(['deadline', 'title', 'id']);
    expect(opArgs(by('v_document_status'), 'select')[0]![0]).toBe(BOARD_STATUS_SELECT);
    expect(opArgs(by('groups'), 'select')[0]![0]).toBe(BOARD_GROUP_SELECT);
    expect(opArgs(by('groups'), 'eq')).toEqual([['year_id', Y]]);
    expect(opArgs(by('v_document_files'), 'select')[0]![0]).toBe(DOCUMENT_FILE_SELECT);
    expect(opArgs(by('v_document_files'), 'eq')).toEqual([['year_id', Y]]);
    expect(data.names.get('u1')).toBe('部門長A');
    expect(data.files).toEqual(rows.v_document_files);
    expect(data.docs).toEqual([DOC_ROW]);
  });

  it('総務部門員：ファイルを読まない（Q4。files は null）。キーは段ごと', async () => {
    const { client, issued } = fake((call) => ({ data: rows[call.table] ?? [] }));
    const data = await loadDocumentsBoard(Y, 'staff', client);
    expect(issued.map((c) => c.table)).not.toContain('v_document_files');
    expect(data.files).toBeNull();
    expect(documentsBoardOptions(Y, 'staff').queryKey).toEqual(queryKeys.yearPart(Y, 'documents', 'board', 'staff'));
    expect(documentsBoardOptions(Y, 'lead').queryKey).toEqual(queryKeys.yearPart(Y, 'documents', 'board', 'lead'));
    expect(documentsBoardOptions(null, 'lead').enabled).toBe(false);
  });

  it('使った量・前年度の提出物のキー（前年度は開くたびに読む）', () => {
    expect(documentStorageUsageOptions(Y).queryKey).toEqual(queryKeys.yearPart(Y, 'documents', 'usage'));
    const prev = previousYearDocumentsOptions(Y);
    expect(prev.queryKey).toEqual(queryKeys.yearPart(Y, 'documents', 'previous'));
    expect(prev.staleTime).toBe(0);
    expect(prev.gcTime).toBe(0);
  });
});

describe('T19 読み取りの RPC は GET（readRpc）', () => {
  it('rpc(名前, 引数, { get: true }) で送り、データを返す', async () => {
    const { client, rpcOptions, issued } = fake(() => ({ data: ['a/b/c/d.pdf'] }));
    expect(await readRpc('document_orphan_paths', { p_year_id: Y }, client)).toEqual(['a/b/c/d.pdf']);
    expect(rpcOptions).toEqual([{ name: 'document_orphan_paths', options: { get: true } }]);
    expect(rpcArgs(issued[0]!)).toEqual({ p_year_id: Y });
  });

  it('引数が形に合わなければ送らない（field は p_ を除いた名前）。失敗は AppError', async () => {
    const { client, issued } = fake(() => ({ data: [] }));
    const info = await caught(readRpc('previous_year_documents', { p_year_id: 'nope' }, client));
    expect(info).toMatchObject({ kind: 'input', details: { field: 'year_id' } });
    expect(issued).toHaveLength(0);
    const failed = fake(() => ({ error: { code: 'P0001', message: 'forbidden' }, status: 400 }));
    expect((await caught(readRpc('document_storage_usage', { p_year_id: Y }, failed.client))).kind).toBe('forbidden');
  });
});

// ---------------------------------------------------------------- Storage

describe('T19 Storage のエラーの分け方（toStorageAppError。本文の statusCode と code。HTTP の status は見ない）', () => {
  it('403・AccessDenied → forbidden（storage_denied）、404・not_found → not_found（storage_missing）、413 → input（size）、415 → input（content_type）', () => {
    expect(toStorageAppError(storageApiError('403', 'AccessDenied')).info).toMatchObject({ kind: 'forbidden', reason: 'storage_denied', status: 403 });
    expect(toStorageAppError(storageApiError('403', 'forbidden')).info.reason).toBe('storage_denied');
    expect(toStorageAppError(storageApiError('400', 'AccessDenied')).info.reason).toBe('storage_denied');
    expect(toStorageAppError(storageApiError('404', 'not_found')).info).toMatchObject({ kind: 'not_found', reason: 'storage_missing' });
    expect(toStorageAppError(storageApiError('413', 'EntityTooLarge')).info).toMatchObject({ kind: 'input', reason: 'storage_too_large', details: { field: 'size' } });
    expect(toStorageAppError(storageApiError('415', 'InvalidMimeType')).info).toMatchObject({ kind: 'input', reason: 'storage_mime', details: { field: 'content_type' } });
  });

  it('ほか（5xx など）は unknown（storage_failed）。5xx は応答が分からない失敗。通信の失敗は network。AppError はそのまま', () => {
    const e500 = toStorageAppError(storageApiError('500', 'InternalError'));
    expect(e500.info).toMatchObject({ kind: 'unknown', reason: 'storage_failed', status: 500 });
    expect(isUnknownOutcome(e500)).toBe(true);
    expect(toStorageAppError(storageApiError('400', 'InvalidKey')).info).toMatchObject({ kind: 'unknown', reason: 'storage_failed' });
    expect(toStorageAppError(storageUnknown(new TypeError('Failed to fetch'))).info.kind).toBe('network');
    expect(toStorageAppError(storageUnknown(new Error('weird'))).info).toMatchObject({ kind: 'unknown', reason: 'storage_failed' });
    expect(toStorageAppError(new TypeError('Failed to fetch')).info.kind).toBe('network');
    const app = new AppError(classifyError({ code: '42501' }));
    expect(toStorageAppError(app)).toBe(app);
  });

  it('文言（04「エラーの文言」の Storage の行）', () => {
    const m = (e: unknown) => messageFor(toStorageAppError(e).info);
    expect(m(storageApiError('403', 'AccessDenied'))).toBe('アップロードできませんでした。提出の状態か立場が変わった可能性があります。読み直しました');
    expect(m(storageApiError('404', 'not_found'))).toBe('ファイルを開けませんでした（消された可能性があります）。読み直しました');
    expect(m(storageApiError('413', 'EntityTooLarge'))).toBe('ファイルは1つ 10 MB までです');
    expect(m(storageApiError('415', 'InvalidMimeType'))).toBe('PDF・JPEG・PNG のファイルを選んでください');
    expect(m(storageApiError('500', 'x'))).toBe('ファイルの置き場で問題が起きました。少し待ってから、もう一度');
    expect(m(storageUnknown(new TypeError('x')))).toBe('通信できませんでした。電波の良い所でもう一度');
  });

  it('isAlreadyUploaded：本文の statusCode が "409" か code が KeyAlreadyExists（HTTP の status 400 ではない）', () => {
    expect(isAlreadyUploaded(storageApiError('409', 'Duplicate'))).toBe(true);
    expect(isAlreadyUploaded(storageApiError('400', 'KeyAlreadyExists'))).toBe(true);
    expect(isAlreadyUploaded({ status: 409, message: 'x' })).toBe(false);
    expect(isAlreadyUploaded(storageApiError('403', 'AccessDenied'))).toBe(false);
  });
});

describe('T19 上げる・消す・署名つき URL', () => {
  const blob = new Blob(['%PDF-1.7'], { type: 'application/pdf' });

  it('upload(path, blob, { contentType, upsert: false })（bucket documents）。届いたら uploaded、409 は already', async () => {
    const ok = fake(() => ({ data: null }));
    expect(await uploadDocumentFile(PATH, blob, 'application/pdf', ok.client)).toBe('uploaded');
    expect(ok.buckets).toEqual(['documents']);
    expect(ok.storageCalls).toEqual([{ op: 'upload', args: [PATH, blob, { contentType: 'application/pdf', upsert: false }] }]);
    const dup = fake(() => ({ data: null }), { upload: () => ({ data: null, error: storageApiError('409', 'Duplicate') }) });
    expect(await uploadDocumentFile(PATH, blob, 'application/pdf', dup.client)).toBe('already');
  });

  it('403（ポリシー・トリガー）・413・415・通信の失敗・投げられた例外は AppError（storage_* と network）', async () => {
    for (const [error, kind, reason] of [
      [storageApiError('403', 'AccessDenied'), 'forbidden', 'storage_denied'],
      [storageApiError('413', 'EntityTooLarge'), 'input', 'storage_too_large'],
      [storageApiError('415', 'InvalidMimeType'), 'input', 'storage_mime'],
      [storageUnknown(new TypeError('Failed to fetch')), 'network', null],
    ] as const) {
      const f = fake(() => ({ data: null }), { upload: () => ({ data: null, error }) });
      expect(await caught(uploadDocumentFile(PATH, blob, 'application/pdf', f.client))).toMatchObject({ kind, reason });
    }
    const thrown = fake(() => ({ data: null }), {
      upload: () => {
        throw new TypeError('Failed to fetch');
      },
    });
    expect((await caught(uploadDocumentFile(PATH, blob, 'application/pdf', thrown.client))).kind).toBe('network');
  });

  it('remove は消せた数を返す。失敗は AppError。空なら送らない', async () => {
    const f = fake(() => ({ data: null }), { remove: (paths) => ({ data: (paths as string[]).slice(0, 1).map((name) => ({ name })), error: null }) });
    expect(await removeDocumentObjects([PATH, 'b'], f.client)).toBe(1);
    expect(f.storageCalls[0]).toEqual({ op: 'remove', args: [[PATH, 'b']] });
    expect(await removeDocumentObjects([], f.client)).toBe(0);
    expect(f.storageCalls).toHaveLength(1);
    const bad = fake(() => ({ data: null }), { remove: () => ({ data: null, error: storageApiError('500', 'x') }) });
    expect((await caught(removeDocumentObjects([PATH], bad.client))).reason).toBe('storage_failed');
  });

  it('片付け：document_orphan_paths（GET）の path を 100 ずつ remove。消せなかったまとまりは数えずに続ける', async () => {
    const paths = Array.from({ length: 250 }, (_, k) => `${Y}/${G}/${D}/${k}.pdf`);
    let n = 0;
    const f = fake(() => ({ data: paths }), {
      remove: (chunk) => {
        n++;
        return n === 2 ? { data: null, error: storageApiError('500', 'x') } : { data: chunk, error: null };
      },
    });
    expect(await cleanupDocumentOrphans(Y, f.client)).toEqual({ found: 250, removed: 150 });
    expect(f.storageCalls.map((c) => (c.args[0] as string[]).length)).toEqual([100, 100, 50]);
    expect(f.rpcOptions).toEqual([{ name: 'document_orphan_paths', options: { get: true } }]);
    const none = fake(() => ({ data: [] }));
    expect(await cleanupDocumentOrphans(Y, none.client)).toEqual({ found: 0, removed: 0 });
    expect(none.storageCalls).toHaveLength(0);
    const failed = fake(() => ({ error: { code: 'P0001', message: 'forbidden' }, status: 400 }));
    expect((await caught(cleanupDocumentOrphans(Y, failed.client))).kind).toBe('forbidden');
  });

  it('署名つき URL：押したときに 60 秒で作る。保存は download に名前。404 は not_found（storage_missing）', async () => {
    const f = fake(() => ({ data: null }));
    expect(await signDocumentFile(PATH, undefined, f.client)).toBe('https://x/sign?token=t');
    expect(await signDocumentFile(PATH, '出店計画_模擬店01_1.pdf', f.client)).toBe('https://x/sign?token=t');
    expect(f.storageCalls).toEqual([
      { op: 'createSignedUrl', args: [PATH, 60, undefined] },
      { op: 'createSignedUrl', args: [PATH, 60, { download: '出店計画_模擬店01_1.pdf' }] },
    ]);
    const missing = fake(() => ({ data: null }), { createSignedUrl: () => ({ data: null, error: storageApiError('404', 'not_found') }) });
    expect(await caught(signDocumentFile(PATH, undefined, missing.client))).toMatchObject({ kind: 'not_found', reason: 'storage_missing' });
  });
});

// ---------------------------------------------------------------- 提出物（直接）

describe('T19 提出物の登録・変更・削除（直接。RLS の can_lead。(B1)）', () => {
  it('登録：画面が作った id と年度で insert し、行を返させる', async () => {
    const { client, issued } = fake(() => ({ data: DOC_ROW }));
    expect(await insertDocument(Y, D, WRITE, client)).toEqual(DOC_ROW);
    expect(issued[0]!.table).toBe('documents');
    expect(opArgs(issued[0]!, 'insert')).toEqual([[{ id: D, year_id: Y, ...WRITE }]]);
    expect(opArgs(issued[0]!, 'select')).toEqual([[DOCUMENT_COLUMNS]]);
    expect(opArgs(issued[0]!, 'single')).toEqual([[]]);
  });

  it('23505 は制約で分ける：題名（documents_year_id_title_key）は document_title_taken、主キー（送り直し）は今の conflict', async () => {
    const title = fake(() => ({
      error: { code: '23505', message: 'duplicate key value violates unique constraint "documents_year_id_title_key"', details: 'Key (year_id, title)=(…) already exists.' },
      status: 409,
    }));
    const t = await caught(insertDocument(Y, D, WRITE, title.client));
    expect(t).toMatchObject({ kind: 'conflict', code: '23505', reason: DOCUMENT_TITLE_TAKEN_REASON, details: { field: 'title' } });
    const pkey = fake(() => ({ error: { code: '23505', message: 'duplicate key value violates unique constraint "documents_pkey"' }, status: 409 }));
    const p = await caught(insertDocument(Y, D, WRITE, pkey.client));
    expect(p).toMatchObject({ kind: 'conflict', code: '23505', reason: null });
    expect(isDocumentTitleTaken(new AppError(t))).toBe(true);
    expect(isDocumentTitleTaken(new AppError(p))).toBe(false);
    const forbidden = fake(() => ({ error: { code: '42501', message: 'new row violates row-level security policy' }, status: 403 }));
    expect((await caught(insertDocument(Y, D, WRITE, forbidden.client))).kind).toBe('forbidden');
  });

  it('変更：読んだときの updated_at の文字列のまま条件にして全部の欄を置き換える。23505 は同じ題名。0 行は読み直して分ける', async () => {
    const { client, issued } = fake(() => ({ data: { ...DOC_ROW, created_by: 'u', year_id: Y } }));
    expect(await updateDocument({ id: D, updated_at: V }, WRITE, client)).toEqual(DOC_ROW);
    expect(opArgs(issued[0]!, 'update')).toEqual([[WRITE]]);
    expect(opArgs(issued[0]!, 'eq')).toEqual([['updated_at', V]]);
    expect(opArgs(issued[0]!, 'match')).toEqual([[{ id: D }]]);
    const dup = fake(() => ({ error: { code: '23505', message: 'duplicate key value violates unique constraint "documents_year_id_title_key"' }, status: 409 }));
    expect((await caught(updateDocument({ id: D, updated_at: V }, WRITE, dup.client))).reason).toBe(DOCUMENT_TITLE_TAKEN_REASON);
    // 0 行で、読み直すと版が違う → conflict（lock_conflict）
    const zero = fake((call) => (opArgs(call, 'update').length > 0 ? { data: null } : { data: { updated_at: 'other' } }));
    expect(await caught(updateDocument({ id: D, updated_at: V }, WRITE, zero.client))).toMatchObject({ kind: 'conflict', reason: 'lock_conflict' });
  });

  it('削除：updated_at を条件に delete し、消えた行を受け取る。0 行で読み直すとない → not_found（lock_missing）', async () => {
    const { client, issued } = fake(() => ({ data: [DOC_ROW] }));
    expect(await deleteDocument({ id: D, updated_at: V }, client)).toEqual(DOC_ROW);
    expect(opArgs(issued[0]!, 'delete')).toEqual([[]]);
    expect(opArgs(issued[0]!, 'eq')).toEqual([['updated_at', V]]);
    const gone = fake((call) => (opArgs(call, 'delete').length > 0 ? { data: [] } : { data: null }));
    expect(await caught(deleteDocument({ id: D, updated_at: V }, gone.client))).toMatchObject({ kind: 'not_found', reason: 'lock_missing' });
  });

  it('読み直し（readDocument・readSubmission・readDocumentFile）：1行（maybeSingle）。なければ null', async () => {
    const { client, issued } = fake(() => ({ data: null }));
    expect(await readDocument(D, client)).toBeNull();
    expect(await readSubmission(D, G, client)).toBeNull();
    expect(await readDocumentFile(F, client)).toBeNull();
    expect(issued.map((c) => c.table)).toEqual(['documents', 'v_document_status', 'v_document_files']);
    expect(opArgs(issued[1]!, 'eq')).toEqual([
      ['document_id', D],
      ['group_id', G],
    ]);
    expect(opArgs(issued[1]!, 'select')).toEqual([[BOARD_STATUS_SELECT]]);
    expect(opArgs(issued[2]!, 'eq')).toEqual([['id', F]]);
    for (const c of issued) expect(opArgs(c, 'maybeSingle')).toEqual([[]]);
  });

  it('sameDocumentWrite：締切は同じ時刻、区分は重なりを除いた同じ組、説明は null と空をそろえる', () => {
    expect(sameDocumentWrite(DOC_ROW, WRITE)).toBe(true);
    expect(sameDocumentWrite({ ...DOC_ROW, description: '' }, WRITE)).toBe(true);
    expect(sameDocumentWrite({ ...DOC_ROW, target_categories: ['department', 'stall'] }, WRITE)).toBe(true);
    expect(sameDocumentWrite({ ...DOC_ROW, target_categories: ['stall'] }, WRITE)).toBe(false);
    expect(sameDocumentWrite({ ...DOC_ROW, deadline: '2026-10-05T08:01:00Z' }, WRITE)).toBe(false);
    expect(sameDocumentWrite({ ...DOC_ROW, requires_file: false }, WRITE)).toBe(false);
    expect(normalizeCategories(['rest_area', 'stall', 'rest_area'])).toEqual(['stall', 'rest_area']);
  });
});

// ---------------------------------------------------------------- ファイルの予約・外す

describe('T19 予約（reserveDocumentFile）', () => {
  const input = { yearId: Y, documentId: D, groupId: G, fileId: F, contentType: 'application/pdf' as const, size: 1234 };
  const reserved = { id: F, year_id: Y, document_id: D, group_id: G, object_path: PATH, content_type: 'application/pdf', size: 1234 };
  const tooManyOrphans: FakeResult = { error: { code: 'P0001', message: 'invalid_state', details: JSON.stringify({ status: 'not_submitted', reason: 'too_many_orphans' }) }, status: 400 };

  it('reserve_document_file に file_id・形・大きさ（送る Blob の大きさ）を送り、ファイルの行（object_path）を返す', async () => {
    const { client, issued } = fake(() => ({ data: reserved }));
    expect(await reserveDocumentFile(input, client)).toEqual(reserved);
    expect(issued[0]!.table).toBe('rpc:reserve_document_file');
    expect(rpcArgs(issued[0]!)).toEqual({ p_document_id: D, p_group_id: G, p_file_id: F, p_content_type: 'application/pdf', p_size: 1234 });
  });

  it('too_many_orphans なら片付け（document_orphan_paths → remove）をしてから、同じ file_id で1回だけ予約し直す', async () => {
    let reserves = 0;
    const f = fake((call) => {
      if (call.table === 'rpc:reserve_document_file') return ++reserves === 1 ? tooManyOrphans : { data: reserved };
      return { data: ['o1', 'o2'] };
    });
    expect(await reserveDocumentFile(input, f.client)).toEqual(reserved);
    expect(f.issued.map((c) => c.table)).toEqual(['rpc:reserve_document_file', 'rpc:document_orphan_paths', 'rpc:reserve_document_file']);
    expect(rpcArgs(f.issued[2]!)).toEqual(rpcArgs(f.issued[0]!));
    expect(f.storageCalls).toEqual([{ op: 'remove', args: [['o1', 'o2']] }]);
  });

  it('予約し直しても too_many_orphans なら文言、片付けを読めなくても予約し直す。ほかの失敗は片付けない', async () => {
    const again = fake((call) => (call.table === 'rpc:reserve_document_file' ? tooManyOrphans : { data: [] }));
    const info = await caught(reserveDocumentFile(input, again.client));
    expect(messageFor(info, { rpc: 'reserve_document_file' })).toBe('前に外したファイルを片付けられませんでした。通信を確かめてから、もう一度足してください');
    expect(again.issued.filter((c) => c.table === 'rpc:reserve_document_file')).toHaveLength(2);
    let reserves = 0;
    const noCleanup = fake((call) =>
      call.table === 'rpc:reserve_document_file' ? (++reserves === 1 ? tooManyOrphans : { data: reserved }) : { error: { code: 'P0001', message: 'forbidden' }, status: 400 },
    );
    expect(await reserveDocumentFile(input, noCleanup.client)).toEqual(reserved);
    const full = fake(() => ({ error: { code: 'P0001', message: 'invalid_state', details: JSON.stringify({ status: 'not_submitted', reason: 'storage_full' }) }, status: 400 }));
    expect((await caught(reserveDocumentFile(input, full.client))).kind).toBe('state');
    expect(full.issued).toHaveLength(1);
  });

  it('送る前の確かめ：形は3つ、大きさは 1〜10485760（送らない）', async () => {
    const { client, issued } = fake(() => ({ data: reserved }));
    expect((await caught(reserveDocumentFile({ ...input, size: 10485761 }, client))).details).toEqual({ field: 'size' });
    expect((await caught(reserveDocumentFile({ ...input, size: 0 }, client))).details).toEqual({ field: 'size' });
    expect((await caught(reserveDocumentFile({ ...input, contentType: 'image/heic' as never }, client))).details).toEqual({ field: 'content_type' });
    expect(issued).toHaveLength(0);
  });
});

describe('T19 外す（discardDocumentFile）', () => {
  const file = { id: F, object_path: PATH };

  it('discard_document_file → 返った object_path をすぐ remove（失敗しても知らせない）', async () => {
    const f = fake(() => ({ data: PATH }), { remove: () => ({ data: null, error: storageApiError('500', 'x') }) });
    expect(await discardDocumentFile(file, f.client)).toEqual({ type: 'removed', before: false });
    expect(rpcArgs(f.issued[0]!)).toEqual({ p_file_id: F });
    expect(f.storageCalls).toEqual([{ op: 'remove', args: [[PATH]] }]);
  });

  it('応答が届かなかったとき：読み直してなければ外せたと同じ（読んだ行の path を remove）。あれば・読み直せなければ unknown', async () => {
    const gone = fake((call) => (call.table === 'rpc:discard_document_file' ? NETWORK : { data: null }));
    expect(await discardDocumentFile(file, gone.client)).toEqual({ type: 'removed', before: true });
    expect(gone.storageCalls).toEqual([{ op: 'remove', args: [[PATH]] }]);
    const still = fake((call) => (call.table === 'rpc:discard_document_file' ? NETWORK : { data: { id: F } }));
    expect(await discardDocumentFile(file, still.client)).toEqual({ type: 'unknown' });
    expect(still.storageCalls).toEqual([]);
    const unread = fake(() => NETWORK);
    expect(await discardDocumentFile(file, unread.client)).toEqual({ type: 'unknown' });
  });

  it('止められた（forbidden・not_editable・not_found）ときは AppError（文言は rpc で分ける）', async () => {
    const locked = fake(() => ({ error: { code: 'P0001', message: 'invalid_state', details: JSON.stringify({ status: 'submitted', reason: 'not_editable' }) }, status: 400 }));
    const info = await caught(discardDocumentFile(file, locked.client));
    expect(messageFor(info, { rpc: 'discard_document_file' })).toBe(
      '提出済みなので、ファイルを変えられません（変えるときは、先に「提出を取り消す」を押してください）。読み直しました',
    );
    const missing = fake(() => ({ error: { code: 'P0001', message: 'not_found' }, status: 400 }));
    expect(messageFor(await caught(discardDocumentFile(file, missing.client)), { rpc: 'discard_document_file' })).toBe(
      'このファイルはもうありません（ほかの人が外した可能性があります）。読み直しました',
    );
    expect(missing.storageCalls).toEqual([]);
  });
});

// ---------------------------------------------------------------- 提出・取り消し・承認・差し戻し

describe('T19 提出・取り消し・承認・差し戻し（RPC の引数）', () => {
  const sub = { document_id: D, group_id: G, status: 'submitted', updated_at: V };

  it('提出：版は読んだときの文字列のまま、行がなければ null を名前つきで送る', async () => {
    const { client, issued } = fake(() => ({ data: sub }));
    await submitDocument(D, G, null, client);
    await submitDocument(D, G, V, client);
    expect(issued.map(rpcArgs)).toEqual([
      { p_document_id: D, p_group_id: G, p_base_updated_at: null },
      { p_document_id: D, p_group_id: G, p_base_updated_at: V },
    ]);
  });

  it('取り消し：版は null にしない（送る前に止め、文言は「提出の版を読めませんでした…」）', async () => {
    const { client, issued } = fake(() => ({ data: sub }));
    await withdrawDocument(D, G, V, client);
    expect(rpcArgs(issued[0]!)).toEqual({ p_document_id: D, p_group_id: G, p_base_updated_at: V });
    const info = await caught(withdrawDocument(D, G, null as unknown as string, client));
    expect(info.details).toEqual({ field: 'base_updated_at' });
    expect(messageFor(info, { rpc: 'withdraw_document' })).toBe('提出の版を読めませんでした。読み直してから、もう一度押してください');
    expect(issued).toHaveLength(1);
  });

  it('承認：メモは前後の空白を除き、空なら null（版も null にできる）。1000 字を超えれば送らない', async () => {
    const { client, issued } = fake(() => ({ data: sub }));
    await approveDocument(D, G, '  ', null, client);
    await approveDocument(D, G, ' 10/3 に紙で受け取りました\n', V, client);
    expect(issued.map(rpcArgs)).toEqual([
      { p_document_id: D, p_group_id: G, p_note: null, p_base_updated_at: null },
      { p_document_id: D, p_group_id: G, p_note: '10/3 に紙で受け取りました', p_base_updated_at: V },
    ]);
    const info = await caught(approveDocument(D, G, 'あ'.repeat(1001), V, client));
    expect(info.details).toEqual({ field: 'note', reason: 'too_long' });
    expect(messageFor(info, { rpc: 'approve_document' })).toBe('メモは 1000 字までです');
    expect(issued).toHaveLength(2);
  });

  it('差し戻し：理由は必須（前後の空白を除いて 1〜1000 字）。空・長すぎは送らない（文言は差し戻しのもの）', async () => {
    const { client, issued } = fake(() => ({ data: sub }));
    await returnDocument(D, G, '　印鑑がありません ', V, client);
    expect(rpcArgs(issued[0]!)).toEqual({ p_document_id: D, p_group_id: G, p_note: '印鑑がありません', p_base_updated_at: V });
    const empty = await caught(returnDocument(D, G, ' \n', V, client));
    expect(messageFor(empty, { rpc: 'return_document' })).toBe('差し戻しの理由を入れてください');
    const long = await caught(returnDocument(D, G, '😀'.repeat(1001), V, client));
    expect(messageFor(long, { rpc: 'return_document' })).toBe('理由は 1000 字までです');
    // 1000 字（補助面の文字も1字）は送れる
    await returnDocument(D, G, '😀'.repeat(1000), V, client);
    expect(issued).toHaveLength(2);
  });

  it('DB の止め方の文言：同じ操作の重なり（not_editable と今の状態）・conflict・not_found', async () => {
    const state = (status: string) =>
      fake(() => ({ error: { code: 'P0001', message: 'invalid_state', details: JSON.stringify({ status, reason: 'not_editable' }) }, status: 400 }));
    expect(messageFor(await caught(submitDocument(D, G, V, state('submitted').client)), { rpc: 'submit_document' })).toBe('すでに提出されています。読み直しました');
    expect(messageFor(await caught(approveDocument(D, G, null, V, state('approved').client)), { rpc: 'approve_document' })).toBe('すでに承認されています。読み直しました');
    const conflict = fake(() => ({ error: { code: 'P0001', message: 'conflict', details: JSON.stringify({ document_id: D, group_id: G }) }, status: 400 }));
    expect(messageFor(await caught(submitDocument(D, G, V, conflict.client)), { rpc: 'submit_document' })).toBe(
      'ほかの人がこの提出を先に変えました（ファイルを足す・外すなど）。読み直しました。確かめてから、もう一度押してください',
    );
    const notFound = fake(() => ({ error: { code: 'P0001', message: 'not_found' }, status: 400 }));
    expect(messageFor(await caught(withdrawDocument(D, G, V, notFound.client)), { rpc: 'withdraw_document' })).toBe(
      'この提出物は見つかりません（削除されたか、この団体が対象から外れた可能性があります）。読み直しました',
    );
  });
});

// ---------------------------------------------------------------- 写す・年度のファイルの削除・読み直し

describe('T19 前年度から写す・年度のファイルの削除', () => {
  it('copy_previous_documents：年度と選んだ id を送り、写した行を返す', async () => {
    const { client, issued } = fake(() => ({ data: [{ ...DOC_ROW, created_by: 'u', year_id: Y }] }));
    expect(await copyPreviousDocuments(Y, [D], client)).toEqual([DOC_ROW]);
    expect(rpcArgs(issued[0]!)).toEqual({ p_year_id: Y, p_document_ids: [D] });
    const info = await caught(copyPreviousDocuments(Y, [], client));
    expect(info.details).toEqual({ field: 'document_ids' });
    expect(issued).toHaveLength(1);
  });

  it('delete_year_document_files → 片付け（何度でもよい。2回目は 0）。理由は省ける。片付けを読めなければ cleanup は null', async () => {
    const f = fake((call) => (call.table === 'rpc:delete_year_document_files' ? { data: 3 } : { data: ['a', 'b'] }), {
      remove: (paths) => ({ data: paths, error: null }),
    });
    expect(await deleteYearDocumentFiles(Y, undefined, f.client)).toEqual({ deleted: 3, cleanup: { found: 2, removed: 2 } });
    expect(rpcArgs(f.issued[0]!)).toEqual({ p_year_id: Y, p_reason: null });
    await deleteYearDocumentFiles(Y, ' 年度末の削除 ', f.client);
    expect(rpcArgs(f.issued[2]!)).toEqual({ p_year_id: Y, p_reason: '年度末の削除' });
    const noCleanup = fake((call) => (call.table === 'rpc:delete_year_document_files' ? { data: 0 } : { error: { code: 'P0001', message: 'forbidden' }, status: 400 }));
    expect(await deleteYearDocumentFiles(Y, null, noCleanup.client)).toEqual({ deleted: 0, cleanup: null });
    const notClosed = fake(() => ({
      error: { code: 'P0001', message: 'invalid_state', details: JSON.stringify({ status: 'confirmed', reason: 'not_closed' }) },
      status: 400,
    }));
    expect(messageFor(await caught(deleteYearDocumentFiles(Y, null, notClosed.client)), { rpc: 'delete_year_document_files' })).toBe(
      '年度が終了していないので、ファイルを削除できません',
    );
  });
});

describe('T19 読み直しと id', () => {
  it('書いた後に読み直すキー：提出状況（documents）・自団体の提出物（document）・ダッシュボードの提出物', () => {
    expect(documentsInvalidateKeys(Y)).toEqual([
      queryKeys.yearPart(Y, 'documents'),
      queryKeys.yearPart(Y, 'document'),
      queryKeys.yearPart(Y, 'portal', 'documents'),
    ]);
    const invalidateQueries = vi.fn(async () => undefined);
    invalidateDocuments({ invalidateQueries } as unknown as QueryClient, Y);
    expect(invalidateQueries.mock.calls.map((c) => (c as unknown as [{ queryKey: unknown }])[0].queryKey)).toEqual(documentsInvalidateKeys(Y));
  });

  it('newDocumentUuid は uuid v4（呼ぶたびに違う。randomUUID のない環境では getRandomValues で作る）', () => {
    const v4 = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;
    const a = newDocumentUuid();
    expect(a).toMatch(v4);
    expect(newDocumentUuid()).not.toBe(a);
    const getRandomValues = <T extends ArrayBufferView>(b: T) => {
      new Uint8Array(b.buffer).fill(0xff);
      return b;
    };
    vi.stubGlobal('crypto', { getRandomValues });
    try {
      expect(newDocumentUuid()).toBe('ffffffff-ffff-4fff-bfff-ffffffffffff');
    } finally {
      vi.unstubAllGlobals();
    }
  });
});
