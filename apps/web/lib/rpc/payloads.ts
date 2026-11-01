// RPC の引数（jsonb を含む）と jsonb の返り値の zod（画面の設計 1.5・1.6・2.4。T09a）。
// トップレベルの型つきの引数（uuid・enum・date・integer）も送る前に確かめる（形が違うと PostgREST が関数の前に
// 22P02 などを返し、どの欄が悪いか分からないため）。jsonb の中身は DB の関数と同じ名前（camelCase）・上限にする。
import { ALLOCATE_MODES, allocationRowSchema, Constants, MAX_COUNT } from '@gaapp/shared';
import { z } from 'zod';
import {
  emailSchema,
  festivalStartSchema,
  isoDateTimeSchema,
  NOTE_MAX,
  optionalReasonSchema,
  reasonSchema,
  uuidSchema,
  yearLabelSchema,
} from '@/lib/schemas/common';
import { charCount, NOTICE_BODY_MAX, NOTICE_GROUPS_MAX, noticeTitleSchema } from '@/lib/schemas/notice-fields';

const E = Constants.public.Enums;
const uuid = uuidSchema;
const count1 = z.number().int().min(1).max(MAX_COUNT);
const count0 = z.number().int().min(0).max(MAX_COUNT);
/** 備考（任意。2000 字まで。空は null） */
const note = z.string().max(NOTE_MAX, { message: `${NOTE_MAX} 字までです` }).nullable();
const updatedAt = z.string().min(1);

// ---- 振り分け ----

/** save_auto_allocations の p_rows（allocate の結果の行のまま。10000 行まで） */
export const autoRowsPayload = z.array(allocationRowSchema).max(10000, { message: '行が多すぎます（10000 行まで）' });

const insertChange = z.strictObject({
  op: z.literal('insert'),
  sourceRoomId: uuid,
  groupId: uuid,
  itemId: uuid,
  requestedItemId: uuid,
  count: count1,
  pinned: z.boolean(),
  note,
});
const updateChange = z.strictObject({
  op: z.literal('update'),
  id: uuid,
  updatedAt,
  sourceRoomId: uuid.optional(),
  itemId: uuid.optional(),
  requestedItemId: uuid.optional(),
  count: count1.optional(),
  note: note.optional(),
  pinned: z.boolean().optional(),
});
const deleteChange = z.strictObject({ op: z.literal('delete'), id: uuid, updatedAt });

export const allocationChangeSchema = z.discriminatedUnion('op', [insertChange, updateChange, deleteChange]);
export type AllocationChange = z.output<typeof allocationChangeSchema>;

/** save_allocation_rows の p_changes（1〜1000 件。同じ行への変更は1つだけ） */
export const allocationChangesPayload = z
  .array(allocationChangeSchema)
  .min(1, { message: '変更がありません' })
  .max(1000, { message: '変更が多すぎます。保存してから続けてください' })
  .refine((cs) => {
    const ids = cs.flatMap((c) => (c.op === 'insert' ? [] : [c.id]));
    return new Set(ids).size === ids.length;
  }, { message: '同じ行への変更が重なっています' });

// ---- 申請 ----

/** submit_requests の p_rows（100 行まで。品目は重ねない） */
export const submitRowsPayload = z
  .array(z.strictObject({ itemId: uuid, count: count0 }))
  .max(100)
  .refine((rs) => new Set(rs.map((r) => r.itemId)).size === rs.length, { message: '同じ品目の行が重なっています' });

/** update_requests_after_deadline の p_rows（DB に行がある品目は updatedAt を付ける。新しい品目の行は付けない） */
export const deadlineRowsPayload = z
  .array(z.strictObject({ itemId: uuid, count: count0, updatedAt: updatedAt.optional() }))
  .max(100)
  .refine((rs) => new Set(rs.map((r) => r.itemId)).size === rs.length, { message: '同じ品目の行が重なっています' });

/** update_requests_after_deadline の p_submission（どのキーも省略できる。submitted は true だけ） */
export const submissionPayload = z.strictObject({
  submitted: z.literal(true).optional(),
  submittedAt: isoDateTimeSchema.optional(),
  note: note.optional(),
});

// ---- 年度 ----

/** update_year の p_patch（入れたキーだけ変える） */
export const yearPatchPayload = z
  .strictObject({
    label: yearLabelSchema.optional(),
    festival_start: festivalStartSchema.optional(),
    request_open_at: isoDateTimeSchema.nullable().optional(),
    request_close_at: isoDateTimeSchema.nullable().optional(),
  })
  .refine((p) => Object.keys(p).length > 0, { message: '変える項目がありません' });

// ---- RPC ごとの引数 ----

export const RPC_ARGS = {
  accept_my_invitations: z.object({}),
  set_year_status: z.object({
    p_year_id: uuid,
    p_to: z.enum(E.year_status),
    p_reason: optionalReasonSchema.optional(),
    p_base_version: z.number().int().optional(),
  }),
  update_year: z.object({ p_year_id: uuid, p_patch: yearPatchPayload, p_reason: optionalReasonSchema.optional() }),
  create_year_from: z.object({ p_prev_year_id: uuid, p_label: yearLabelSchema, p_festival_start: festivalStartSchema }),
  invite: z.object({
    p_year_id: uuid,
    p_email: emailSchema,
    p_role: z.enum(E.app_role).optional(),
    p_group_id: uuid.optional(),
    // 団体の招待の立場（T15。省くと店長。group_id なしで渡すと invalid_input）
    p_group_role: z.enum(E.group_role).optional(),
  }),
  set_role: z.object({ p_year_id: uuid, p_user_id: uuid, p_role: z.enum(E.app_role), p_reason: optionalReasonSchema.optional() }),
  remove_role: z.object({ p_year_id: uuid, p_user_id: uuid, p_reason: optionalReasonSchema.optional() }),
  revoke_invitation: z.object({ p_invitation_id: uuid }),
  remove_group_member: z.object({ p_group_id: uuid, p_user_id: uuid, p_reason: optionalReasonSchema.optional() }),
  // 店長⇄副店長（T15。画面から呼ぶのは T15b）
  set_group_member_role: z.object({
    p_group_id: uuid,
    p_user_id: uuid,
    p_group_role: z.enum(E.group_role),
    p_reason: optionalReasonSchema.optional(),
  }),
  save_auto_allocations: z.object({
    p_year_id: uuid,
    p_rows: autoRowsPayload,
    p_mode: z.enum(ALLOCATE_MODES),
    p_base_version: z.number().int(),
  }),
  save_allocation_rows: z.object({ p_year_id: uuid, p_changes: allocationChangesPayload, p_reason: reasonSchema }),
  set_consent: z.object({
    p_group_id: uuid,
    p_from_item: uuid,
    p_to_item: uuid,
    p_status: z.enum(E.consent_status),
    p_note: note.optional(),
  }),
  submit_requests: z.object({ p_group_id: uuid, p_rows: submitRowsPayload, p_note: note.optional() }),
  update_requests_after_deadline: z.object({
    p_group_id: uuid,
    p_rows: deadlineRowsPayload,
    p_reason: reasonSchema,
    p_submission: submissionPayload.optional(),
  }),
  previous_year_stocks: z.object({ p_year_id: uuid }),
  previous_year_requests: z.object({ p_year_id: uuid }),
  check_delivery: z.object({
    p_delivery_id: uuid,
    p_status: z.enum(E.delivery_status),
    p_problem_note: note.optional(),
    p_returned: z.boolean().optional(),
  }),
  // お知らせ（T17・D-53）。題名は前後の空白を除いて 1〜100 字（DB と同じ 25 文字の空白）、本文は 4000 字まで（null にせず、
  // 空にするときは送らない。lib/schemas/notices.ts の toSaveNoticeArgs）。送る前の確かめに落ちたときの field は p_ を除いた
  // 引数の名前（title・body・group_ids。DB の invalid_input の field と同じ）なので、欄の下に同じ文言を出せる
  save_notice: z.object({
    p_year_id: uuid,
    p_audience: z.enum(E.notice_audience),
    p_title: noticeTitleSchema,
    p_body: z
      .string()
      .refine((s) => charCount(s) <= NOTICE_BODY_MAX)
      .optional(),
    p_pinned: z.boolean().optional(),
    p_group_ids: z.array(uuid).max(NOTICE_GROUPS_MAX).optional(),
    p_notice_id: uuid.optional(),
    p_base_updated_at: updatedAt.optional(),
  }),
  delete_notice: z.object({ p_notice_id: uuid, p_base_updated_at: updatedAt }),
  // シフト・作業（T20・D-56）。作業の状態は担当者と部門長以上（楽観ロックは読んだときの updated_at の文字列のまま）。1日分は時間枠 1〜96 と、
  // そのすべてに同じ持ち場のます（0〜100 個。必要人数 0〜100）。日時はオフセットつきの ISO 8601（画面は `+09:00` で送る）
  set_task_status: z.object({ p_task_id: uuid, p_status: z.enum(E.task_status), p_base_updated_at: updatedAt }),
  add_shift_slots: z.object({
    p_year_id: uuid,
    p_slots: z.array(z.object({ starts_at: isoDateTimeSchema, ends_at: isoDateTimeSchema })).min(1).max(96),
    p_needs: z.array(z.object({ duty_id: uuid, required_count: z.number().int().min(0).max(100) })).max(100),
  }),
} as const;

// ---- jsonb の返り値 ----

/** allocations の行（save_allocation_rows の返り値の row。to_jsonb の全列から画面が使う列だけを取る） */
export const allocationDbRowSchema = z.object({
  id: uuid,
  year_id: uuid,
  source_room_id: uuid,
  group_id: uuid,
  item_id: uuid,
  requested_item_id: uuid,
  count: count1,
  is_keep: z.boolean(),
  origin: z.enum(E.alloc_origin),
  pinned: z.boolean(),
  note: z.string().nullable(),
  updated_at: z.string(),
});

export const RPC_RESULTS = {
  save_auto_allocations: z.object({
    allocation_version: z.number().int(),
    deleted: z.number().int(),
    updated: z.number().int(),
    inserted: z.number().int(),
  }),
  save_allocation_rows: z.object({
    allocation_version_before: z.number().int(),
    allocation_version: z.number().int(),
    rows: z.array(
      z.union([
        z.object({ op: z.enum(['insert', 'update']), row: allocationDbRowSchema }),
        z.object({ op: z.literal('delete'), id: uuid }),
      ]),
    ),
  }),
  invite: z.object({ invitation_ids: z.array(uuid), applied: z.boolean() }),
} as const;

export type SaveAutoAllocationsResult = z.output<(typeof RPC_RESULTS)['save_auto_allocations']>;
export type SaveAllocationRowsResult = z.output<(typeof RPC_RESULTS)['save_allocation_rows']>;
export type InviteResult = z.output<(typeof RPC_RESULTS)['invite']>;
