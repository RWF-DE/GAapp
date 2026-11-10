// 提出物の登録・変更・削除の (B1) の決め方（doc-write.ts。04「提出物」の書き込みの決まり・エラーの文言、notes/T19.md「パート B・C の約束」3。
// T19）：応答が届かなかったとき・止められたとき（主キーと題名の 23505・0 行の conflict・not_found・forbidden）に、読み直して決める。
import { describe, expect, it, vi } from 'vitest';
import { DOCUMENT_TITLE_TAKEN_REASON, type DocumentRow, type DocumentWrite } from '@/lib/data/documents';
import { AppError, appError } from '@/lib/errors';
import { rereadRejectedDocSave, runDocDelete, runDocSave } from './doc-write';

const ID = '00000000-0000-4000-8000-000000000101';
const V1 = '2026-10-01T00:00:00.123456+00:00';
const V2 = '2026-10-02T00:00:00.123456+00:00';
const W: DocumentWrite = {
  title: '出店計画書',
  description: null,
  deadline: '2026-10-05T17:00:00+09:00',
  target_categories: ['stall'],
  food_only: false,
  submit_url: null,
};
const row = (over: Partial<DocumentRow> = {}): DocumentRow => ({
  id: ID,
  title: W.title,
  description: null,
  deadline: '2026-10-05T08:00:00+00:00',
  target_categories: ['stall'],
  food_only: false,
  submit_url: null,
  files_deleted_at: null,
  updated_at: V1,
  ...over,
});
const NETWORK = new TypeError('Failed to fetch');
const PKEY = { code: '23505', message: 'duplicate key value violates unique constraint "documents_pkey"' };
const TITLE = new AppError({ ...appError('conflict', '', null).info, code: '23505', reason: DOCUMENT_TITLE_TAKEN_REASON, details: { field: 'title' } });
const noAuth = async () => 'other' as const;

describe('T19 提出物の登録（runDocSave の登録）', () => {
  it('送れた → saved（before でない）', async () => {
    const r = await runDocSave({ baseVersion: null, write: W, send: async () => row(), reread: vi.fn() }, noAuth);
    expect(r).toEqual({ type: 'saved', row: row(), before: false });
  });

  it('主キーの 23505（送り直し）で、読み直すと入力と同じ → 登録されていた（before）', async () => {
    const r = await runDocSave({ baseVersion: null, write: W, send: () => Promise.reject(PKEY), reread: async () => row() }, noAuth);
    expect(r).toEqual({ type: 'saved', row: row(), before: true });
  });

  it('主キーの 23505 で、同じ id の提出物が入力と違う → conflict（その提出物の編集に切り替える）', async () => {
    const other = row({ title: '別の題名', updated_at: V2 });
    const r = await runDocSave({ baseVersion: null, write: W, send: () => Promise.reject(PKEY), reread: async () => other }, noAuth);
    expect(r).toEqual({ type: 'conflict', row: other });
  });

  it('同じ題名の 23505 で、同じ id の提出物がない → title_taken（読み直せなくても title_taken）', async () => {
    const reread = vi.fn(async () => null);
    expect(await runDocSave({ baseVersion: null, write: W, send: () => Promise.reject(TITLE), reread }, noAuth)).toEqual({ type: 'title_taken' });
    expect(reread).toHaveBeenCalledTimes(1);
    const failing = vi.fn(async () => Promise.reject(NETWORK));
    expect(await runDocSave({ baseVersion: null, write: W, send: () => Promise.reject(TITLE), reread: failing }, noAuth)).toEqual({ type: 'title_taken' });
  });

  it('応答が届かず、読み直すとない・読めない → unknown（もう一度押すと同じ id で送る）', async () => {
    expect(await runDocSave({ baseVersion: null, write: W, send: () => Promise.reject(NETWORK), reread: async () => null }, noAuth)).toEqual({
      type: 'unknown',
    });
    expect(
      await runDocSave({ baseVersion: null, write: W, send: () => Promise.reject(NETWORK), reread: () => Promise.reject(NETWORK) }, noAuth),
    ).toEqual({ type: 'unknown' });
  });

  it('権限（42501）は読み直さずに failed', async () => {
    const reread = vi.fn();
    const e = { code: '42501', message: 'new row violates row-level security policy' };
    const r = await runDocSave({ baseVersion: null, write: W, send: () => Promise.reject(e), reread }, noAuth);
    expect(r).toEqual({ type: 'failed', error: e });
    expect(reread).not.toHaveBeenCalled();
  });
});

describe('T19 提出物の変更（runDocSave の保存）', () => {
  it('同じ題名の 23505 → 読み直さずに title_taken', async () => {
    const reread = vi.fn();
    const r = await runDocSave({ baseVersion: V1, write: W, send: () => Promise.reject(TITLE), reread }, noAuth);
    expect(r).toEqual({ type: 'title_taken' });
    expect(reread).not.toHaveBeenCalled();
  });

  it('0 行の conflict → 読み直した行で conflict。消えていれば missing。止められた後に読めなければ unread', async () => {
    const conflict = appError('conflict', 'lock_conflict', null);
    const fresh = row({ updated_at: V2, title: 'ほかの人の題名' });
    expect(await runDocSave({ baseVersion: V1, write: W, send: () => Promise.reject(conflict), reread: async () => fresh }, noAuth)).toEqual({
      type: 'conflict',
      row: fresh,
    });
    const missing = appError('not_found', 'lock_missing', null);
    expect(await runDocSave({ baseVersion: V1, write: W, send: () => Promise.reject(missing), reread: async () => null }, noAuth)).toEqual({
      type: 'missing',
    });
    expect(
      await runDocSave({ baseVersion: V1, write: W, send: () => Promise.reject(conflict), reread: () => Promise.reject(NETWORK) }, noAuth),
    ).toEqual({ type: 'unread' });
  });

  it('応答が届かず、読み直すと入力と同じ → 保存されていた。版が同じで違う → unknown', async () => {
    expect(await runDocSave({ baseVersion: V1, write: W, send: () => Promise.reject(NETWORK), reread: async () => row({ updated_at: V2 }) }, noAuth)).toEqual({
      type: 'saved',
      row: row({ updated_at: V2 }),
      before: true,
    });
    expect(
      await runDocSave({ baseVersion: V1, write: W, send: () => Promise.reject(NETWORK), reread: async () => row({ title: '前の題名' }) }, noAuth),
    ).toEqual({ type: 'unknown' });
  });

  it('rereadRejectedDocSave：入力と同じなら saved、行があれば conflict、なければ missing、読めなければ unread', async () => {
    expect(await rereadRejectedDocSave({ baseVersion: V1, write: W, reread: async () => row({ updated_at: V2 }) })).toEqual({
      type: 'saved',
      row: row({ updated_at: V2 }),
      before: true,
    });
    const other = row({ title: 'x', updated_at: V2 });
    expect(await rereadRejectedDocSave({ baseVersion: V1, write: W, reread: async () => other })).toEqual({ type: 'conflict', row: other });
    expect(await rereadRejectedDocSave({ baseVersion: V1, write: W, reread: async () => null })).toEqual({ type: 'missing' });
    expect(await rereadRejectedDocSave({ baseVersion: V1, write: W, reread: () => Promise.reject(NETWORK) })).toEqual({ type: 'unread' });
  });
});

describe('T19 提出物の削除（runDocDelete）', () => {
  it('消えた・もうなかった（not_found）・版が違う（conflict）・権限（forbidden）', async () => {
    const reread = vi.fn();
    expect(await runDocDelete({ send: async () => row(), reread, baseVersion: V1 }, noAuth)).toEqual({ type: 'deleted', before: false });
    expect(await runDocDelete({ send: () => Promise.reject(appError('not_found', 'lock_missing', null)), reread, baseVersion: V1 }, noAuth)).toEqual({
      type: 'deleted',
      before: true,
    });
    expect(await runDocDelete({ send: () => Promise.reject(appError('conflict', 'lock_conflict', null)), reread, baseVersion: V1 }, noAuth)).toEqual({
      type: 'changed',
    });
    const forbidden = appError('forbidden', 'lock_unchanged', null);
    expect(await runDocDelete({ send: () => Promise.reject(forbidden), reread, baseVersion: V1 }, noAuth)).toEqual({ type: 'failed', error: forbidden });
    expect(reread).not.toHaveBeenCalled();
  });

  it('応答が届かなかった：ない → 消えた、版が違う → changed、版が同じ・読めない → unknown', async () => {
    const send = () => Promise.reject(NETWORK);
    expect(await runDocDelete({ send, reread: async () => null, baseVersion: V1 }, noAuth)).toEqual({ type: 'deleted', before: false });
    expect(await runDocDelete({ send, reread: async () => row({ updated_at: V2 }), baseVersion: V1 }, noAuth)).toEqual({ type: 'changed' });
    expect(await runDocDelete({ send, reread: async () => row(), baseVersion: V1 }, noAuth)).toEqual({ type: 'unknown' });
    expect(await runDocDelete({ send, reread: () => Promise.reject(NETWORK), baseVersion: V1 }, noAuth)).toEqual({ type: 'unknown' });
  });
});
