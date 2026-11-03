// 提出物の段・状態ごとの操作・表示名・印（04「提出物」の段ごとの出し分けと状態の印、02「提出物の権限」。T19）。
// 画面は DB より広く出さず、段ができることを隠さない：店長・副店長は未提出・差し戻しでファイルと「提出した」、提出済みで取り消しだけ、
// 部門長以上は承認でなければ代理でファイル、状態ごとに承認・差し戻し（3種）・紙での承認・代わりに提出・取り消し。終了した年度は何も出さない。
import { Constants } from '@gaapp/shared';
import { describe, expect, it } from 'vitest';
import type { YearStatus } from '@/lib/auth/membership';
import { APP_ROLES } from '@/lib/auth/roles';
import {
  CONTENT_TYPE_EXT,
  CONTENT_TYPE_LABELS,
  DOCUMENT_CONTENT_TYPES,
  DOCUMENT_FILTER_LABELS,
  DOCUMENT_FILTERS,
  DOCUMENT_MARK_LABELS,
  DOCUMENT_STATUS_LABELS,
  DOCUMENT_STATUSES,
  isDocumentContentType,
  REP_MARK_TEXTS,
  REP_STATUS_LABELS,
  SOUMU_STATUS_LABELS,
  statusOf,
  type DocumentStatus,
} from './labels';
import { deadlinePassed, documentMarks, isOpenStatus } from './marks';
import {
  canDeleteYearFiles,
  canManageDocuments,
  documentsTier,
  leadDocumentActions,
  repDocumentActions,
  RETURN_KIND_LABELS,
  seesDocumentFiles,
} from './permissions';

const OPEN_YEARS: readonly YearStatus[] = ['preparing', 'requesting', 'allocating', 'confirmed'];

describe('T19 表示名（02 の列挙型 document_status の表示名と画面ごとの言い方）', () => {
  it('状態の並びは列挙と同じ。02 の表示名・総務の「承認待ち」・店長・副店長の「提出済み（総務の確認待ち）」', () => {
    expect(DOCUMENT_STATUSES).toEqual(Constants.public.Enums.document_status);
    expect(DOCUMENT_STATUS_LABELS).toEqual({ not_submitted: '未提出', submitted: '提出済み', returned: '差し戻し', approved: '承認' });
    expect(SOUMU_STATUS_LABELS.submitted).toBe('承認待ち');
    expect(REP_STATUS_LABELS.submitted).toBe('提出済み（総務の確認待ち）');
    expect(SOUMU_STATUS_LABELS.approved).toBe('承認');
  });

  it('絞り込み：すべて・未提出・承認待ち・差し戻し・承認・締切を過ぎた', () => {
    expect(DOCUMENT_FILTERS).toEqual(['all', 'not_submitted', 'submitted', 'returned', 'approved', 'overdue']);
    expect(DOCUMENT_FILTERS.map((f) => DOCUMENT_FILTER_LABELS[f])).toEqual(['すべて', '未提出', '承認待ち', '差し戻し', '承認', '締切を過ぎた']);
  });

  it('印の文字（色だけで表さない）と、店長・副店長の画面の言い方', () => {
    expect(DOCUMENT_MARK_LABELS).toEqual({ late: '締切の後', proxy: '代理', paper: '紙', overdue: '締切を過ぎた' });
    expect(REP_MARK_TEXTS).toEqual({ proxy: '総務が代わりに提出しました', paper: '紙などで受け取りました' });
  });

  it('ファイルの形：PDF・JPEG・PNG と拡張子 pdf・jpg・png。ほかの形は違う', () => {
    expect(DOCUMENT_CONTENT_TYPES.map((t) => [CONTENT_TYPE_LABELS[t], CONTENT_TYPE_EXT[t]])).toEqual([
      ['PDF', 'pdf'],
      ['JPEG', 'jpg'],
      ['PNG', 'png'],
    ]);
    expect(isDocumentContentType('image/heic')).toBe(false);
    expect(isDocumentContentType('image/png')).toBe(true);
  });

  it('statusOf：null・知らない値は未提出（v_document_status は行のない提出を未提出として出す）', () => {
    expect(statusOf(null)).toBe('not_submitted');
    expect(statusOf('x')).toBe('not_submitted');
    expect(statusOf('returned')).toBe('returned');
  });
});

describe('T19 段（documentsTier・canManageDocuments・seesDocumentFiles・canDeleteYearFiles）', () => {
  it('提出状況の段：部門長以上は lead、総務部門員は staff、閲覧のみ・ロールなしは null（Q5）', () => {
    expect(['admin', 'head', 'deputy_head'].map((r) => documentsTier(r as never))).toEqual(['lead', 'lead', 'lead']);
    expect(documentsTier('staff')).toBe('staff');
    expect(documentsTier('viewer')).toBeNull();
    expect(documentsTier(null)).toBeNull();
  });

  it('設定・承認・差し戻し・代理・写す：部門長以上で、年度が終了でない（DB の can_lead と同じ）。年度の状態が分からなければ出さない', () => {
    for (const role of APP_ROLES) {
      for (const st of OPEN_YEARS) expect(canManageDocuments(role, st), `${role}・${st}`).toBe(['admin', 'head', 'deputy_head'].includes(role));
      expect(canManageDocuments(role, 'closed')).toBe(false);
    }
    expect(canManageDocuments('admin', null)).toBe(false);
    expect(canManageDocuments(null, 'requesting')).toBe(false);
  });

  it('ファイルを開けるのは部門長以上だけ（総務部門員は状況だけ。Q4）。終了した年度も開ける', () => {
    expect(APP_ROLES.filter((r) => seesDocumentFiles(r))).toEqual(['admin', 'head', 'deputy_head']);
  });

  it('年度のファイルの削除は管理者で、終了した年度だけ（Q3）', () => {
    expect(canDeleteYearFiles('admin', 'closed')).toBe(true);
    expect(canDeleteYearFiles('head', 'closed')).toBe(false);
    for (const st of OPEN_YEARS) expect(canDeleteYearFiles('admin', st)).toBe(false);
  });
});

describe('T19 状態 × 段の操作（repDocumentActions・leadDocumentActions）', () => {
  it('店長・副店長：未提出・差し戻しはファイルと「提出した」、提出済みは取り消しだけ、承認は何も（届いていない予約は外せる）', () => {
    const table: Record<DocumentStatus, ReturnType<typeof repDocumentActions>> = {
      not_submitted: { addFile: true, removeFile: true, removePending: true, submit: true, withdraw: false },
      returned: { addFile: true, removeFile: true, removePending: true, submit: true, withdraw: false },
      submitted: { addFile: false, removeFile: false, removePending: true, submit: false, withdraw: true },
      approved: { addFile: false, removeFile: false, removePending: true, submit: false, withdraw: false },
    };
    for (const st of OPEN_YEARS) for (const s of DOCUMENT_STATUSES) expect(repDocumentActions(s, st), `${s}・${st}`).toEqual(table[s]);
  });

  it('部門長以上：承認でなければ代理のファイル、提出済みは承認・差し戻す・取り消し、承認は承認を取り消して差し戻す、差し戻しは理由を書き直す・紙での承認・代わりに提出', () => {
    const table: Record<DocumentStatus, ReturnType<typeof leadDocumentActions>> = {
      not_submitted: { addFile: true, removeFile: true, removePending: true, approve: false, returnKind: null, paper: true, submit: true, withdraw: false },
      submitted: { addFile: true, removeFile: true, removePending: true, approve: true, returnKind: 'return', paper: false, submit: false, withdraw: true },
      returned: { addFile: true, removeFile: true, removePending: true, approve: false, returnKind: 'rewrite', paper: true, submit: true, withdraw: false },
      approved: { addFile: false, removeFile: false, removePending: true, approve: false, returnKind: 'unapprove', paper: false, submit: false, withdraw: false },
    };
    for (const st of OPEN_YEARS) for (const s of DOCUMENT_STATUSES) expect(leadDocumentActions(s, st), `${s}・${st}`).toEqual(table[s]);
    expect(RETURN_KIND_LABELS).toEqual({ return: '差し戻す', unapprove: '承認を取り消して差し戻す', rewrite: '理由を書き直す' });
  });

  it('終了した年度・年度の状態が分からないときは、どの状態でも何も出さない（読むだけ）', () => {
    for (const s of DOCUMENT_STATUSES) {
      for (const st of ['closed', null, undefined] as const) {
        expect(Object.values(repDocumentActions(s, st)).every((v) => v === false)).toBe(true);
        expect(Object.values(leadDocumentActions(s, st)).every((v) => v === false || v === null)).toBe(true);
      }
    }
  });
});

describe('T19 状態の印（documentMarks）', () => {
  const deadline = '2026-10-05T08:00:00Z';
  const at = Date.parse(deadline);
  const base = { status: 'not_submitted' as DocumentStatus | null, deadline, submitted_at: null as string | null, late: false, proxy: false };

  it('締切を過ぎた：未提出・差し戻しのまま締切を過ぎた（ちょうどは過ぎた側）。提出済み・承認には付けない', () => {
    expect(documentMarks(base, at - 1).overdue).toBe(false);
    expect(documentMarks(base, at).overdue).toBe(true);
    expect(documentMarks({ ...base, status: 'returned' }, at + 1).overdue).toBe(true);
    expect(documentMarks({ ...base, status: 'submitted', submitted_at: deadline }, at + 1).overdue).toBe(false);
    expect(documentMarks({ ...base, status: 'approved', submitted_at: deadline }, at + 1).overdue).toBe(false);
    expect(documentMarks({ ...base, status: null }, at).status).toBe('not_submitted');
    expect(deadlinePassed('oops', at)).toBe(false);
    expect(isOpenStatus('returned')).toBe(true);
    expect(isOpenStatus('submitted')).toBe(false);
  });

  it('締切の後・代理は v_document_status の late・proxy のまま。紙は承認で提出の日時がないもの', () => {
    const m = documentMarks({ ...base, status: 'submitted', submitted_at: '2026-10-06T00:00:00Z', late: true, proxy: true }, at);
    expect(m).toEqual({ status: 'submitted', late: true, proxy: true, paper: false, overdue: false });
    expect(documentMarks({ ...base, status: 'approved', submitted_at: null }, at).paper).toBe(true);
    expect(documentMarks({ ...base, status: 'approved', submitted_at: deadline }, at).paper).toBe(false);
    expect(documentMarks({ ...base, late: null, proxy: null }, at)).toMatchObject({ late: false, proxy: false });
  });
});
