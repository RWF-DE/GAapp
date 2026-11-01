// 提出物の軽い読み取り（自団体の提出物〔/document〕とダッシュボード〔/〕。04「自団体の提出物」「ダッシュボードに出すもの（提出物）」。T19）：
// 読む表・列・絞り込み・並び（2本を並行に1往復）、部門長以上の使った量は GET の RPC（POST にしない）、総務部門員は使った量を読まない、
// 団体がなければ読まない、キー、失敗は AppError。
import { describe, expect, it } from 'vitest';
import { AppError } from '@/lib/errors';
import { portalQueryKey } from '@/lib/modules/portal';
import { queryKeys } from '@/lib/query';
import type { AppSupabaseClient } from '@/lib/supabase/client';
import { createFakeSupabase, opArgs, type FakeCall, type FakeResult } from '@/lib/testing/fake-supabase';
import {
  DOCUMENT_FILE_SELECT,
  DOCUMENTS_PORTAL_DOC_SELECT,
  DOCUMENTS_PORTAL_STATUS_SELECT,
  DOCUMENTS_REP_PORTAL_SELECT,
  documentsRepPortalOptions,
  documentsSoumuPortalOptions,
  loadDocumentStorageUsage,
  loadDocumentsRepPortal,
  loadDocumentsSoumuPortal,
  loadRepDocuments,
  REP_DOCUMENT_STATUS_SELECT,
  repDocumentsOptions,
} from './reads';

const Y = '11111111-1111-4111-8111-111111111111';
const G1 = '22222222-2222-4222-8222-222222222222';
const G2 = '33333333-3333-4333-8333-333333333333';

/** 偽の Supabase（rpc の3つ目の引数〔{ get: true }〕も記録する） */
function fake(handler: (call: FakeCall) => FakeResult) {
  const f = createFakeSupabase(handler);
  const rpcOptions: { name: string; options: unknown }[] = [];
  const inner = f.client as unknown as { from(t: string): unknown; rpc(n: string, a: unknown): unknown };
  const client = {
    from: (t: string) => inner.from(t),
    rpc: (name: string, args: unknown, options?: unknown) => {
      rpcOptions.push({ name, options });
      return inner.rpc(name, args);
    },
  } as unknown as AppSupabaseClient;
  return { client, issued: f.issued, rpcOptions };
}

const selectOf = (c: FakeCall) => opArgs(c, 'select')[0]?.[0];
const orders = (c: FakeCall) => opArgs(c, 'order').map((a) => a[0]);

describe('T19 自団体の提出物（loadRepDocuments・repDocumentsOptions）', () => {
  it('その団体の v_document_status と v_document_files を並行に読む（列・年度と団体の絞り込み・並び）', async () => {
    const { client, issued } = fake((call) => ({ data: call.table === 'v_document_status' ? [{ document_id: 'd' }] : [{ id: 'f' }] }));
    const data = await loadRepDocuments(Y, G1, client);
    expect(issued.map((c) => c.table)).toEqual(['v_document_status', 'v_document_files']);
    const [s, f] = issued;
    expect(selectOf(s!)).toBe(REP_DOCUMENT_STATUS_SELECT);
    expect(REP_DOCUMENT_STATUS_SELECT).toBe(
      'document_id, group_id, title, description, deadline, requires_file, status, submitted_at, proxy, late, reviewed_at, review_note, updated_at',
    );
    expect(opArgs(s!, 'eq')).toEqual([
      ['year_id', Y],
      ['group_id', G1],
    ]);
    expect(orders(s!)).toEqual(['deadline', 'title', 'document_id']);
    expect(selectOf(f!)).toBe(DOCUMENT_FILE_SELECT);
    expect(DOCUMENT_FILE_SELECT).not.toContain('created_by');
    expect(opArgs(f!, 'eq')).toEqual([
      ['year_id', Y],
      ['group_id', G1],
    ]);
    expect(orders(f!)).toEqual(['document_id', 'created_at', 'id']);
    expect(data.statuses).toEqual([{ document_id: 'd' }]);
    expect(data.files).toEqual([{ id: 'f' }]);
    expect(Number.isNaN(Date.parse(data.loadedAt))).toBe(false);
  });

  it('キーは ["year", 年度, "document", 団体]。年度か団体がなければ読まない', () => {
    expect(repDocumentsOptions(Y, G1).queryKey).toEqual(queryKeys.yearPart(Y, 'document', G1));
    expect(repDocumentsOptions(Y, null).enabled).toBe(false);
    expect(repDocumentsOptions(null, G1).enabled).toBe(false);
  });

  it('読めなければ AppError', async () => {
    const { client } = fake(() => ({ error: { code: '42501', message: 'no' }, status: 403 }));
    await expect(loadRepDocuments(Y, G1, client)).rejects.toBeInstanceOf(AppError);
  });
});

describe('T19 ダッシュボード（総務）', () => {
  it('部門長以上：提出物（id・題名・締切）と提出の状況（document_id・status）と、使った量（GET の RPC）の3本', async () => {
    const usage = { bucket_bytes: 1, limit_bytes: 943718400, file_count: 2, file_bytes: 3, orphan_count: 4 };
    const { client, issued, rpcOptions } = fake((call) =>
      call.table === 'rpc:document_storage_usage' ? { data: [usage] } : { data: call.table === 'documents' ? [{ id: 'd' }] : [{ document_id: 'd', status: 'submitted' }] },
    );
    const raw = await loadDocumentsSoumuPortal(Y, 'lead', client);
    expect(issued.map((c) => c.table).sort()).toEqual(['documents', 'rpc:document_storage_usage', 'v_document_status']);
    const docs = issued.find((c) => c.table === 'documents')!;
    expect(selectOf(docs)).toBe(DOCUMENTS_PORTAL_DOC_SELECT);
    expect(DOCUMENTS_PORTAL_DOC_SELECT).toBe('id, title, deadline');
    expect(orders(docs)).toEqual(['deadline', 'title', 'id']);
    const st = issued.find((c) => c.table === 'v_document_status')!;
    expect(selectOf(st)).toBe(DOCUMENTS_PORTAL_STATUS_SELECT);
    expect(DOCUMENTS_PORTAL_STATUS_SELECT).toBe('document_id, status');
    expect(opArgs(st, 'eq')).toEqual([['year_id', Y]]);
    expect(opArgs(st, 'range')).toEqual([[0, 999]]);
    // 読み取りの RPC は GET（POST は記録・先送りの残りの応答を捨てるため）
    expect(rpcOptions).toEqual([{ name: 'document_storage_usage', options: { get: true } }]);
    expect(issued.find((c) => c.table === 'rpc:document_storage_usage')!.ops[0]!.args[0]).toEqual({ p_year_id: Y });
    expect(raw).toEqual({ docs: [{ id: 'd' }], statuses: [{ document_id: 'd', status: 'submitted' }], usage });
  });

  it('総務部門員：使った量を読まない（2本）。キーは段ごと', async () => {
    const { client, issued, rpcOptions } = fake(() => ({ data: [] }));
    const raw = await loadDocumentsSoumuPortal(Y, 'staff', client);
    expect(issued.map((c) => c.table).sort()).toEqual(['documents', 'v_document_status']);
    expect(rpcOptions).toEqual([]);
    expect(raw.usage).toBeNull();
    expect(documentsSoumuPortalOptions(Y, 'staff').queryKey).toEqual(portalQueryKey(Y, 'documents', 'soumu', 'staff'));
    expect(documentsSoumuPortalOptions(Y, 'lead').queryKey).toEqual(portalQueryKey(Y, 'documents', 'soumu', 'lead'));
  });

  it('使った量：数の文字列も数にし、行がなければ 0（失敗は AppError）', async () => {
    const { client } = fake(() => ({ data: [{ bucket_bytes: '1048576', limit_bytes: 943718400, file_count: 1, file_bytes: '10', orphan_count: null }] }));
    expect(await loadDocumentStorageUsage(Y, client)).toEqual({ bucket_bytes: 1048576, limit_bytes: 943718400, file_count: 1, file_bytes: 10, orphan_count: 0 });
    const empty = fake(() => ({ data: [] }));
    expect(await loadDocumentStorageUsage(Y, empty.client)).toEqual({ bucket_bytes: 0, limit_bytes: 0, file_count: 0, file_bytes: 0, orphan_count: 0 });
    const failed = fake(() => ({ error: { code: 'P0001', message: 'forbidden' }, status: 400 }));
    await expect(loadDocumentStorageUsage(Y, failed.client)).rejects.toBeInstanceOf(AppError);
  });
});

describe('T19 ダッシュボード（店長・副店長）', () => {
  it('代表する団体の行（document_id・group_id・status・題名・締切・review_note）を締切 → 提出物 → 団体の順に1本。キーは団体の id つき', async () => {
    const { client, issued } = fake(() => ({ data: [{ document_id: 'd' }] }));
    expect(await loadDocumentsRepPortal(Y, [G1, G2], client)).toEqual([{ document_id: 'd' }]);
    expect(issued).toHaveLength(1);
    expect(selectOf(issued[0]!)).toBe(DOCUMENTS_REP_PORTAL_SELECT);
    expect(DOCUMENTS_REP_PORTAL_SELECT).toBe('document_id, group_id, status, title, deadline, review_note');
    expect(opArgs(issued[0]!, 'eq')).toEqual([['year_id', Y]]);
    expect(opArgs(issued[0]!, 'in')).toEqual([['group_id', [G1, G2]]]);
    expect(orders(issued[0]!)).toEqual(['deadline', 'document_id', 'group_id']);
    expect(documentsRepPortalOptions(Y, [G1, G2]).queryKey).toEqual(portalQueryKey(Y, 'documents', 'rep', G1, G2));
  });

  it('団体がなければ読まない', async () => {
    const { client, issued } = fake(() => ({ data: [] }));
    expect(await loadDocumentsRepPortal(Y, [], client)).toEqual([]);
    expect(issued).toHaveLength(0);
  });
});
