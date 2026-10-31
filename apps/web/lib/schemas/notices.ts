// お知らせの入力の zod（04「お知らせ一覧」の書く、notes/T17.md「後半（画面）の約束」4。T17・D-53）。
// DB（0014 の save_notice と notices の CHECK）と同じ形にしてから送る：
// - 題名は前後の空白を除いて 1〜100 字。除く空白は zod の trim（JavaScript の String.prototype.trim）で、DB の c_space と同じ 25 文字。
// - 本文は 4000 字まで。前後の空白・改行は残し、空白だけなら null（DB も同じ空白だけを null にする）。
// - 字数は文字（Unicode のコードポイント。`[...s].length`）で数え、DB の length と同じにする（JavaScript の length は
//   絵文字などを 2 と数え、DB より狭くなる。後半の判断したことの 10）。
// - 宛先が指定の団体なら、宛先の団体は 1〜1000 で重なりなし。ほかの宛先では確かめず、送るときに空にする。
import { Constants } from '@gaapp/shared';
import { z } from 'zod';
import type { RpcArgs } from '@/lib/rpc';
import { charCount, NOTICE_BODY_MAX, NOTICE_GROUPS_MAX, noticeTitleSchema } from './notice-fields';

// 上限・字数の数え方・題名の zod は notice-fields.ts（RPC_ARGS からも使う小さなモジュール）。ここから同じ名前で出し直す
export { charCount, NOTICE_BODY_MAX, NOTICE_GROUPS_MAX, NOTICE_TITLE_MAX, noticeTitleSchema } from './notice-fields';

/** 本文（任意。空白だけなら null にした後で 4000 字まで。前後の空白・改行は残す） */
export const noticeBodySchema = z
  .string()
  .transform((s) => (s.trim() === '' ? null : s))
  .refine((s) => s === null || charCount(s) <= NOTICE_BODY_MAX, { message: `本文は ${NOTICE_BODY_MAX} 字までです` });

/** ダイアログの入力（宛先・題名・本文・ピン留め・宛先の団体） */
export const noticeFormSchema = z
  .object({
    audience: z.enum(Constants.public.Enums.notice_audience),
    title: noticeTitleSchema,
    body: noticeBodySchema,
    pinned: z.boolean(),
    groupIds: z.array(z.string()),
  })
  .superRefine((v, ctx) => {
    // 指定の団体のときだけ確かめる（ほかの宛先では選んだ団体をフォームが覚えておき、送るときに空にする）
    if (v.audience !== 'groups') return;
    const message =
      v.groupIds.length === 0
        ? '宛先の団体を1つ以上選んでください'
        : v.groupIds.length > NOTICE_GROUPS_MAX
          ? `宛先の団体は ${NOTICE_GROUPS_MAX} までです`
          : new Set(v.groupIds).size !== v.groupIds.length
            ? '同じ団体が重なっています'
            : null;
    if (message) ctx.addIssue({ code: 'custom', path: ['groupIds'], message });
  });

/** ダイアログの入力の値（zod の入力。本文は入力のままの文字列） */
export type NoticeFormValues = z.input<typeof noticeFormSchema>;
/** 確かめた入力（送る形。題名は除いた形、本文は string | null） */
export type NoticeWrite = z.output<typeof noticeFormSchema>;
/** 欄ごとのエラー（title・body・groupIds と、宛先・ピン留め） */
export type NoticeFieldErrors = Partial<Record<keyof NoticeFormValues, string>>;

/** 新しく書くときの入力（宛先の既定は総務内。ピン留めは外す） */
export function emptyNoticeForm(): NoticeFormValues {
  return { audience: 'soumu', title: '', body: '', pinned: false, groupIds: [] };
}

/**
 * 入力を確かめる。通れば write、通らなければ欄ごとの最初のエラー（errors）。
 *
 * @example
 * const r = checkNoticeForm(values);
 * if (!r.write) setErrors(r.errors);
 */
export function checkNoticeForm(values: NoticeFormValues): { write: NoticeWrite | null; errors: NoticeFieldErrors } {
  const r = noticeFormSchema.safeParse(values);
  if (r.success) return { write: r.data, errors: {} };
  const errors: NoticeFieldErrors = {};
  for (const issue of r.error.issues) {
    const key = issue.path[0];
    if (typeof key === 'string' && key in values && !(key in errors)) errors[key as keyof NoticeFormValues] = issue.message;
  }
  return { write: null, errors };
}

/**
 * save_notice の引数を作る（04「お知らせ一覧」の編集：全部の欄を送る）。
 * - 宛先の団体は、指定の団体なら groupIds（呼ぶ側が団体の並びにしたもの）、ほかの宛先なら空。
 * - 本文が null なら p_body を入れない（生成した型は null を書けない。DB の既定値 null で、本文を空にできる）。
 * - base（直すとき）があれば p_notice_id と p_base_updated_at（読んだときの updated_at の文字列のまま）。
 *
 * @example
 * callRpc('save_notice', toSaveNoticeArgs(yearId, write, { id: n.id, updatedAt: n.updated_at }));
 */
export function toSaveNoticeArgs(yearId: string, w: NoticeWrite, base: { id: string; updatedAt: string } | null): RpcArgs<'save_notice'> {
  return {
    p_year_id: yearId,
    p_audience: w.audience,
    p_title: w.title,
    ...(w.body !== null ? { p_body: w.body } : {}),
    p_pinned: w.pinned,
    p_group_ids: w.audience === 'groups' ? [...w.groupIds] : [],
    ...(base ? { p_notice_id: base.id, p_base_updated_at: base.updatedAt } : {}),
  };
}
