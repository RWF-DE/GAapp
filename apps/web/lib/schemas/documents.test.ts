// 提出物の入力（04「提出状況」の提出物の設定の送る前の確かめ・セルのシートのダイアログ。T19）：題名（trim の 25 文字・1〜100 字・
// コードポイント）、説明（空なら null・2000 字）、締切（日付の範囲・時刻・`+09:00`）、区分（1つ以上・列挙の順）、編集で開く値、
// 差し戻しの理由・承認のメモ・紙での承認のメモ。
import { describe, expect, it } from 'vitest';
import {
  approveNoteSchema,
  checkDocumentForm,
  checkReturnNote,
  DOCUMENT_FORM_MESSAGES,
  documentFormSchema,
  documentFormValuesOf,
  EMPTY_DOCUMENT_FORM,
  noteLength,
  normalizeReviewNote,
  paperNoteSchema,
  REVIEW_NOTE_MESSAGES,
  reviewNoteSchema,
  toDocumentWrite,
  type DocumentFormValues,
} from './documents';

const form = (over: Partial<DocumentFormValues> = {}): DocumentFormValues => ({
  ...EMPTY_DOCUMENT_FORM,
  title: '出店計画',
  deadlineDate: '2026-10-05',
  categories: ['stall'],
  ...over,
});
/** JavaScript の trim が除く 25 文字（DB の c_space と同じ）の一部：タブ・改行・全角の空白・NBSP・BOM */
const SPACES = '\t\n　 \uFEFF ';

describe('T19 提出物の設定のダイアログ（checkDocumentForm）', () => {
  it('新しく登録するときの既定：時刻 17:00、飲食の団体だけは外す、区分は選ばない、提出先の URL は空（T24。ファイルが要るはやめた）', () => {
    expect(EMPTY_DOCUMENT_FORM).toEqual({ title: '', description: '', deadlineDate: '', deadlineTime: '17:00', categories: [], foodOnly: false, submitUrl: '' });
  });

  it('通れば送る値：題名と説明は前後の空白を除く、説明が空なら null、締切は `YYYY-MM-DDTHH:mm:00+09:00`、区分は列挙の順', () => {
    const r = checkDocumentForm(form({ title: `${SPACES}出店計画${SPACES}`, description: `${SPACES}`, categories: ['rest_area', 'stall', 'stall'], foodOnly: true, submitUrl: ' https://drive.google.com/drive/folders/abc \n' }));
    expect(r).toEqual({
      ok: true,
      write: {
        title: '出店計画',
        description: null,
        deadline: '2026-10-05T17:00:00+09:00',
        target_categories: ['stall', 'rest_area'],
        food_only: true,
        submit_url: 'https://drive.google.com/drive/folders/abc',
      },
    });
    expect(toDocumentWrite(form({ description: ' 様式は共有フォルダにあります \n' }))?.description).toBe('様式は共有フォルダにあります');
  });

  it('誤りは欄ごと（04 の文言）', () => {
    const r = checkDocumentForm({ ...EMPTY_DOCUMENT_FORM, title: SPACES, deadlineTime: '' });
    expect(r).toEqual({
      ok: false,
      errors: {
        title: DOCUMENT_FORM_MESSAGES.titleRequired,
        deadlineDate: DOCUMENT_FORM_MESSAGES.dateRequired,
        deadlineTime: DOCUMENT_FORM_MESSAGES.timeRequired,
        categories: DOCUMENT_FORM_MESSAGES.categoryRequired,
      },
    });
    expect(DOCUMENT_FORM_MESSAGES).toEqual({
      titleRequired: '題名を入れてください',
      titleTooLong: '題名は 100 字までです',
      descriptionTooLong: '説明は 2000 字までです',
      dateRequired: '締切の日付を入れてください',
      timeRequired: '締切の時刻を入れてください',
      outOfRange: '2000年1月1日〜2200年12月31日の日付にしてください',
      categoryRequired: '出す団体の区分を1つ以上選んでください',
      submitUrlInvalid: '提出先の URL は https:// で始まる形で入れてください（空白は入れられません）',
      submitUrlTooLong: '提出先の URL は 500 字までです',
    });
    expect(toDocumentWrite(form({ title: '' }))).toBeNull();
  });

  it('題名は 100 字・説明は 2000 字まで（文字はコードポイントで数える。絵文字も1字）', () => {
    expect(checkDocumentForm(form({ title: 'あ'.repeat(100) })).ok).toBe(true);
    expect(checkDocumentForm(form({ title: '😀'.repeat(100) })).ok).toBe(true);
    expect(checkDocumentForm(form({ title: 'あ'.repeat(101) }))).toEqual({ ok: false, errors: { title: DOCUMENT_FORM_MESSAGES.titleTooLong } });
    expect(checkDocumentForm(form({ description: '😀'.repeat(2000) })).ok).toBe(true);
    expect(checkDocumentForm(form({ description: 'あ'.repeat(2001) }))).toEqual({ ok: false, errors: { description: DOCUMENT_FORM_MESSAGES.descriptionTooLong } });
  });

  it('締切の日付は暦にある 2000-01-01〜2200-12-31、時刻は 00:00〜23:59', () => {
    expect(checkDocumentForm(form({ deadlineDate: '2000-01-01', deadlineTime: '00:00' })).ok).toBe(true);
    expect(checkDocumentForm(form({ deadlineDate: '2200-12-31', deadlineTime: '23:59' })).ok).toBe(true);
    for (const d of ['1999-12-31', '2201-01-01', '2026-02-30', '2026/10/05']) {
      expect(checkDocumentForm(form({ deadlineDate: d })), d).toEqual({ ok: false, errors: { deadlineDate: DOCUMENT_FORM_MESSAGES.outOfRange } });
    }
    for (const t of ['24:00', '9:00', '17:60', 'x']) {
      expect(checkDocumentForm(form({ deadlineTime: t })), t).toEqual({ ok: false, errors: { deadlineTime: DOCUMENT_FORM_MESSAGES.timeRequired } });
    }
  });

  it('編集で開く値：締切は Asia/Tokyo の日付と時刻、説明が null なら空。送る値に戻すと同じ締切', () => {
    const row = {
      title: '食品の届け',
      description: null,
      deadline: '2026-10-05T15:30:00+00:00',
      target_categories: ['stall' as const],
      food_only: true,
      submit_url: null,
    };
    const v = documentFormValuesOf(row);
    expect(v).toEqual({ title: '食品の届け', description: '', deadlineDate: '2026-10-06', deadlineTime: '00:30', categories: ['stall'], foodOnly: true, submitUrl: '' });
    expect(documentFormValuesOf({ ...row, submit_url: 'https://forms.gle/x' }).submitUrl).toBe('https://forms.gle/x');
    expect(Date.parse(toDocumentWrite(v)!.deadline)).toBe(Date.parse(row.deadline));
  });
});

describe('T24 提出先の URL（documents.submit_url。DB の documents_submit_url_check と同じ形）', () => {
  it('空（前後の空白だけを含む）なら null。https で始まり、空白・制御文字を含まない 500 字までなら通る', () => {
    expect(toDocumentWrite(form({ submitUrl: '' }))?.submit_url).toBeNull();
    expect(toDocumentWrite(form({ submitUrl: `${SPACES}` }))?.submit_url).toBeNull();
    expect(toDocumentWrite(form({ submitUrl: 'https://forms.gle/abc' }))?.submit_url).toBe('https://forms.gle/abc');
    expect(toDocumentWrite(form({ submitUrl: `https://${'a'.repeat(492)}` }))?.submit_url).toHaveLength(500);
  });

  it('https でない・空白や制御文字を含む・501 字は欄の誤り（04 の文言）', () => {
    for (const url of ['http://example.com', 'HTTPS://example.com', 'javascript:alert(1)', 'https://', 'drive.google.com/x', 'https://a b', 'https://a\u3000b', 'https://a\u0007b']) {
      expect(checkDocumentForm(form({ submitUrl: url })), url).toEqual({ ok: false, errors: { submitUrl: DOCUMENT_FORM_MESSAGES.submitUrlInvalid } });
    }
    expect(checkDocumentForm(form({ submitUrl: `https://${'a'.repeat(493)}` }))).toEqual({ ok: false, errors: { submitUrl: DOCUMENT_FORM_MESSAGES.submitUrlTooLong } });
    expect(DOCUMENT_FORM_MESSAGES.submitUrlInvalid).toBe('提出先の URL は https:// で始まる形で入れてください（空白は入れられません）');
    expect(DOCUMENT_FORM_MESSAGES.submitUrlTooLong).toBe('提出先の URL は 500 字までです');
  });
});

describe('T19 documentFormSchema（resolver に渡す形）', () => {
  it('通れば送る値（checkDocumentForm と同じ）、通らなければ欄の名前の path と同じ文言', () => {
    const ok = form({ title: ' 出店計画 ', categories: ['department', 'stall'] });
    expect(documentFormSchema.parse(ok)).toEqual((checkDocumentForm(ok) as { write: unknown }).write);
    const bad = documentFormSchema.safeParse({ ...EMPTY_DOCUMENT_FORM, deadlineDate: '2026-02-30' });
    expect(bad.success).toBe(false);
    expect(Object.fromEntries(bad.error!.issues.map((i) => [i.path.join('.'), i.message]))).toEqual({
      title: DOCUMENT_FORM_MESSAGES.titleRequired,
      deadlineDate: DOCUMENT_FORM_MESSAGES.outOfRange,
      categories: DOCUMENT_FORM_MESSAGES.categoryRequired,
    });
  });
});

describe('T19 差し戻しの理由・承認のメモ・紙での承認のメモ', () => {
  it('差し戻しの理由は必須（前後の空白を除いて 1〜1000 字）', () => {
    expect(checkReturnNote(`${SPACES}印鑑がありません${SPACES}`)).toEqual({ ok: true, note: '印鑑がありません' });
    expect(checkReturnNote(SPACES)).toEqual({ ok: false, message: '差し戻しの理由を入れてください' });
    expect(checkReturnNote('あ'.repeat(1001))).toEqual({ ok: false, message: '理由は 1000 字までです' });
    expect(reviewNoteSchema.safeParse('😀'.repeat(1000)).success).toBe(true);
  });

  it('承認のメモは任意（空なら null。1000 字まで）、紙での承認のメモは必須', () => {
    expect(approveNoteSchema.parse('  ')).toBeNull();
    expect(approveNoteSchema.parse(' 確認しました ')).toBe('確認しました');
    expect(approveNoteSchema.safeParse('あ'.repeat(1001)).error?.issues[0]?.message).toBe('メモは 1000 字までです');
    expect(paperNoteSchema.safeParse('').error?.issues[0]?.message).toBe('紙などで受け取ったときは、メモを入れてください');
    expect(paperNoteSchema.parse('10/3 に紙で受け取りました')).toBe('10/3 に紙で受け取りました');
    expect(REVIEW_NOTE_MESSAGES.paperRequired).toBe('紙などで受け取ったときは、メモを入れてください');
  });

  it('normalizeReviewNote は前後の空白を除いて空なら null。noteLength はコードポイント', () => {
    expect(normalizeReviewNote(`${SPACES}`)).toBeNull();
    expect(normalizeReviewNote(null)).toBeNull();
    expect(normalizeReviewNote(' a\nb ')).toBe('a\nb');
    expect(noteLength('😀a')).toBe(2);
  });
});
