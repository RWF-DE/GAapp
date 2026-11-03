// 提出の書き込みの決め方（04「提出物」の書き込みの決まり、画面の設計 2.6 の (B1)。T19）：送れた・応答が届かなかった（読み直して
// 提出されていました・分からない・ほかの人が変えた）・止められた（not_editable・conflict・not_found を読み直す。前の「分からない」の
// もう一度なら提出されていました）・読み直せなかった・そのほか・401 の送り直し。
import { describe, expect, it, vi } from 'vitest';
import type { DocumentSubmissionRow } from '@/lib/data/documents';
import { appError, classifyError, messageFor } from '@/lib/errors';
import type { ReadSubmission } from '@/lib/modules/documents/outcome';
import {
  isNotEditable,
  runSubmissionWrite,
  sendWithAuth,
  SUBMISSION_DONE_BEFORE,
  SUBMISSION_RPCS,
  SUBMISSION_UNKNOWN,
  type SubmissionWriteRequest,
} from './submission-write';

const V1 = '2026-10-01T00:00:00.123456+00:00';
const V2 = '2026-10-02T00:00:00.000000+00:00';
const ROW = { document_id: 'd', group_id: 'g', status: 'submitted' } as DocumentSubmissionRow;
const NETWORK = { code: '', message: 'TypeError: Failed to fetch', status: 0 };
const p0001 = (message: string, details: unknown) => appError(classifyError({ code: 'P0001', message }).kind, message, details);
const notEditable = (status: string) => p0001('invalid_state', { status, reason: 'not_editable' });
const other = async () => 'other' as const;

function req(over: Partial<SubmissionWriteRequest> & { reread?: () => Promise<ReadSubmission | null> }): SubmissionWriteRequest {
  return {
    action: 'submit',
    base: V1,
    afterUnknown: false,
    send: async () => ROW,
    reread: async () => ({ status: 'returned', updated_at: V1, review_note: null }),
    ...over,
  };
}

describe('T19 runSubmissionWrite', () => {
  it('送れた：done（RPC の返り値）。読み直さない', async () => {
    const reread = vi.fn();
    expect(await runSubmissionWrite(req({ reread }), other)).toEqual({ type: 'done', row: ROW, before: false });
    expect(reread).not.toHaveBeenCalled();
  });

  it('応答が届かなかった：押した操作の後なら done（before）、版が同じなら unknown、違えば rejected（conflict の文言）、読み直せなければ unknown', async () => {
    const send = async () => Promise.reject(NETWORK);
    expect(await runSubmissionWrite(req({ send, reread: async () => ({ status: 'submitted', updated_at: V2, review_note: null }) }), other)).toEqual({
      type: 'done',
      row: null,
      before: true,
    });
    expect(await runSubmissionWrite(req({ send }), other)).toEqual({ type: 'unknown' });
    const changed = await runSubmissionWrite(req({ send, reread: async () => ({ status: 'returned', updated_at: V2, review_note: null }) }), other);
    expect(changed.type).toBe('rejected');
    expect(messageFor(classifyError((changed as { error: unknown }).error), { rpc: SUBMISSION_RPCS.submit })).toBe(
      'ほかの人がこの提出を先に変えました（ファイルを足す・外すなど）。読み直しました。確かめてから、もう一度押してください',
    );
    expect(await runSubmissionWrite(req({ send, reread: async () => Promise.reject(NETWORK) }), other)).toEqual({ type: 'unknown' });
  });

  it('差し戻しは理由も比べる（同じ理由の差し戻しなら done、違えば版で決める）', async () => {
    const send = async () => Promise.reject(NETWORK);
    const reread = async () => ({ status: 'returned' as const, updated_at: V2, review_note: '印鑑がありません' });
    expect((await runSubmissionWrite(req({ action: 'return', note: ' 印鑑がありません ', send, reread }), other)).type).toBe('done');
    expect((await runSubmissionWrite(req({ action: 'return', note: '別の理由', send, reread }), other)).type).toBe('rejected');
  });

  it('止められた（not_editable・conflict・not_found）：読み直して rejected（エラーはそのまま）。読み直せなければ unread', async () => {
    for (const error of [notEditable('submitted'), p0001('conflict', { document_id: 'd', group_id: 'g' }), p0001('not_found', null)]) {
      const reread = vi.fn(async () => ({ status: 'submitted' as const, updated_at: V2, review_note: null }));
      const r = await runSubmissionWrite(req({ send: async () => Promise.reject(error), reread }), other);
      expect(r).toEqual({ type: 'rejected', error });
      expect(reread).toHaveBeenCalledTimes(1);
      expect(await runSubmissionWrite(req({ send: async () => Promise.reject(error), reread: async () => Promise.reject(NETWORK) }), other)).toEqual({
        type: 'unread',
        error,
      });
    }
    expect(messageFor(classifyError(notEditable('submitted')), { rpc: 'submit_document' })).toBe('すでに提出されています。読み直しました');
  });

  it('前の「分からない」のもう一度が not_editable・conflict で止まり、今は押した操作の後：done（before。ほかの人とは言わない）', async () => {
    const reread = async () => ({ status: 'submitted' as const, updated_at: V2, review_note: null });
    expect(await runSubmissionWrite(req({ afterUnknown: true, send: async () => Promise.reject(notEditable('submitted')), reread }), other)).toEqual({
      type: 'done',
      row: null,
      before: true,
    });
    // 前の「分からない」がなければ、同じ操作が重なった（副店長が先に提出した）ので文言を出す
    expect((await runSubmissionWrite(req({ send: async () => Promise.reject(notEditable('submitted')), reread }), other)).type).toBe('rejected');
    // 取り消しの後の状態でなければ done にしない
    const withdrawn = async () => ({ status: 'approved' as const, updated_at: V2, review_note: null });
    expect(
      (await runSubmissionWrite(req({ action: 'withdraw', afterUnknown: true, send: async () => Promise.reject(notEditable('approved')), reread: withdrawn }), other)).type,
    ).toBe('rejected');
  });

  it('そのほか（forbidden・status: closed・no_file・入力の誤り）：failed（読み直さない）', async () => {
    for (const error of [
      p0001('forbidden', null),
      p0001('invalid_state', { status: 'closed' }),
      p0001('invalid_state', { status: 'returned', reason: 'no_file' }),
      appError('input', 'client_validation', { field: 'base_updated_at' }),
    ]) {
      const reread = vi.fn();
      expect(await runSubmissionWrite(req({ send: async () => Promise.reject(error), reread }), other)).toEqual({ type: 'failed', error });
      expect(reread).not.toHaveBeenCalled();
    }
  });

  it('401 は1回だけセッションを更新して送り直す（だめならそのまま）', async () => {
    const auth = { code: 'PGRST303', message: 'JWT expired' };
    let n = 0;
    const send = vi.fn(async () => (n++ === 0 ? Promise.reject(auth) : ROW));
    expect(await runSubmissionWrite(req({ send }), async () => 'retry')).toEqual({ type: 'done', row: ROW, before: false });
    expect(send).toHaveBeenCalledTimes(2);
    const signedOut = await sendWithAuth(async () => Promise.reject(auth), async () => 'signedOut');
    expect(signedOut).toEqual({ ok: false, error: auth });
  });

  it('文言：操作ごとの「…されていました」「…分かりません」と RPC の名前', () => {
    expect(SUBMISSION_DONE_BEFORE).toEqual({
      submit: '提出されていました',
      withdraw: '取り消されていました',
      approve: '承認されていました',
      paper: '承認されていました',
      return: '差し戻されていました',
    });
    expect(SUBMISSION_UNKNOWN.submit).toBe('提出できたか分かりません。もう一度「提出した」を押すと、確かめてから送ります');
    expect(SUBMISSION_UNKNOWN.withdraw).toBe('取り消せたか分かりません。もう一度「提出を取り消す」を押すと、確かめてから送ります');
    expect(SUBMISSION_UNKNOWN.approve).toBe('承認できたか分かりません。もう一度「承認する」を押すと、確かめてから送ります');
    expect(SUBMISSION_UNKNOWN.return).toBe('差し戻せたか分かりません。もう一度「差し戻す」を押すと、確かめてから送ります');
    expect(SUBMISSION_RPCS).toMatchObject({ submit: 'submit_document', withdraw: 'withdraw_document', paper: 'approve_document' });
    expect(isNotEditable(notEditable('approved'))).toBe(true);
    expect(isNotEditable(p0001('invalid_state', { status: 'closed' }))).toBe(false);
  });
});
