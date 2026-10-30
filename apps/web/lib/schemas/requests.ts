// 申請（/request）・申請一覧（/requests）の入力とクエリの zod（画面の設計 1.6・3.5・3.6。T11）。
// 数の上限は shared の MAX_COUNT、備考の上限は lib/schemas/common.ts の NOTE_MAX を使い、ここに数を書き直さない。
import { GROUP_CATEGORIES, MAX_COUNT, type GroupCategory } from '@gaapp/shared';
import { z } from 'zod';
import { NOTE_MAX, optionalText, uuidSchema } from './common';

/** 申請の数（0〜10000 の整数。requests.count の CHECK と同じ） */
export const requestCountSchema = z
  .number({ message: '数を入れてください' })
  .int({ message: '整数にしてください' })
  .min(0, { message: '0 以上にしてください' })
  .max(MAX_COUNT, { message: `${MAX_COUNT} までです` });

/** 提出の備考（任意。2000 字まで。空なら null） */
export const requestNoteSchema = optionalText(NOTE_MAX);

/**
 * 申請の入力（/request と代理入力のシート）。counts は「表示した入力欄の品目 → 数」。
 * 送る前に確かめ、送る値（備考の前後の空白を除き、空なら null）を作る。
 */
export const requestFormSchema = z.object({
  counts: z.record(uuidSchema, requestCountSchema),
  note: requestNoteSchema,
});
export type RequestFormInput = z.input<typeof requestFormSchema>;
export type RequestFormValue = z.output<typeof requestFormSchema>;

// ---- クエリ（合わない値は無視して既定にする。例外にしない。画面の設計 1.1） ----

/** /request の `?group=`（uuid でなければ null） */
export function parseGroupParam(v: string | null | undefined): string | null {
  const r = uuidSchema.safeParse(v ?? '');
  return r.success ? r.data : null;
}

/** /requests の `?category=`（区分でなければ null＝すべて） */
export function parseCategoryParam(v: string | null | undefined): GroupCategory | null {
  const r = z.enum(GROUP_CATEGORIES).safeParse(v ?? '');
  return r.success ? r.data : null;
}

export const REQUESTS_FILTERS = ['unsubmitted', 'noted'] as const;
export type RequestsFilter = (typeof REQUESTS_FILTERS)[number];

/** /requests の `?filter=`（unsubmitted・noted でなければ null＝すべて） */
export function parseFilterParam(v: string | null | undefined): RequestsFilter | null {
  const r = z.enum(REQUESTS_FILTERS).safeParse(v ?? '');
  return r.success ? r.data : null;
}
