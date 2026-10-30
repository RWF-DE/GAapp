// 画面の入力の共通の zod（画面の設計 1.6。T09a）。DB の CHECK・RPC と同じ上限を1回だけ書く。
// 数・距離・代替の重さの上限は shared の MAX_COUNT・MAX_DISTANCE_COST・MAX_SUBSTITUTE_COST を使い、ここに書き直さない。
import { z } from 'zod';

/** years.label の CHECK（`btrim(label) <> '' and length(label) <= 50`。0001） */
export const YEAR_LABEL_MAX = 50;
/** years_festival_start_check（`festival_start between '2000-01-01' and '2200-12-31'`。0005、D-18） */
export const FESTIVAL_START_MIN = '2000-01-01';
export const FESTIVAL_START_MAX = '2200-12-31';
/** private.set_reason（`length(p_reason) > 500` は invalid_input の reason。0003） */
export const REASON_MAX = 500;
/** invitations.email の CHECK と invite（`length <= 254`、`^[^@[:space:]]+@[^@[:space:]]+$`。0001・0005） */
export const EMAIL_MAX = 254;
/** rooms・items・groups の name、groups.display_name の CHECK（`length <= 100`。0001） */
export const NAME_MAX = 100;
/** rooms.building・distance_overrides.building_a/b の CHECK（`length <= 50`。0001） */
export const BUILDING_MAX = 50;
/** 備考・メモ（room_years・request_submissions・rules.memo・allocations・substitution_consents の note。`length <= 2000`。0001） */
export const NOTE_MAX = 2000;
/** aliases の CHECK（`cardinality(aliases) <= 20 and length(array_to_string(aliases, '')) <= 1000`。0001） */
export const ALIASES_MAX_COUNT = 20;
export const ALIASES_MAX_CHARS = 1000;

export const uuidSchema = z.uuid({ message: '形が正しくありません' });

/** 前後の空白を除いて1字以上（場所名・団体名・品目名などの必須の名前） */
export const requiredText = (max: number) =>
  z
    .string()
    .trim()
    .min(1, { message: '入力してください' })
    .max(max, { message: `${max} 字までです` });

/**
 * 任意の文字列：前後の空白を除き、空（と null・undefined）なら null にする（D-33）。
 * 場所の建物・団体の表示名・各表の備考とメモ・使用不可の理由に使う。DB は空文字を許すが、shared の
 * roomSchema.building・groupSchema.displayName は空文字を許さないので、空文字を保存しない。
 */
export const optionalText = (max: number) =>
  z
    .union([z.string(), z.null(), z.undefined()])
    .transform((v) => {
      const t = (v ?? '').trim();
      return t === '' ? null : t;
    })
    .pipe(z.string().max(max, { message: `${max} 字までです` }).nullable());

export const yearLabelSchema = requiredText(YEAR_LABEL_MAX);

/** 1日目（date。`YYYY-MM-DD`）。範囲は DB の CHECK と同じ */
export const festivalStartSchema = z.iso
  .date({ message: '日付を入れてください' })
  .refine((d) => d >= FESTIVAL_START_MIN && d <= FESTIVAL_START_MAX, {
    message: '2000年1月1日〜2200年12月31日の日付にしてください',
  });

/** 理由（必須。確定・確定の解除・振り分けの手での変更・締切後の申請の修正） */
export const reasonSchema = z
  .string()
  .trim()
  .min(1, { message: '理由を入力してください' })
  .max(REASON_MAX, { message: `理由は ${REASON_MAX} 字までです` });

/** 理由（任意。空なら null） */
export const optionalReasonSchema = optionalText(REASON_MAX);

/** メールアドレス（招待）。DB と同じく前後の空白を除いて小文字にする */
export const emailSchema = z
  .string()
  .trim()
  .toLowerCase()
  .min(1, { message: 'メールアドレスを入れてください' })
  .max(EMAIL_MAX, { message: `${EMAIL_MAX} 字までです` })
  .regex(/^[^@\s]+@[^@\s]+$/, { message: 'メールアドレスの形が違います' });

/** 日時（オフセットつきの ISO 8601。受付期間・取り込みの提出日時。update_requests_after_deadline と同じ） */
export const isoDateTimeSchema = z.iso.datetime({ offset: true, message: '日時の形が正しくありません' });

/** 別名（フォームでの表記）。前後の空白を除き、空のものを捨てる */
export const aliasesSchema = z
  .array(z.string())
  .transform((a) => a.map((s) => s.trim()).filter((s) => s !== ''))
  .pipe(
    z
      .array(z.string())
      .max(ALIASES_MAX_COUNT, { message: `別名は ${ALIASES_MAX_COUNT} 個までです` })
      .refine((a) => a.join('').length <= ALIASES_MAX_CHARS, { message: `別名は合わせて ${ALIASES_MAX_CHARS} 字までです` }),
  );
