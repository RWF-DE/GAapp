// 在庫入力・在庫一覧・QR の印刷の入力とクエリの zod（画面の設計 1.6・3.3・3.4。T10）。
// クエリの値は確かめ、合わない値は無視して既定にする（例外にしない。設計 1.1）。
import { MAX_COUNT } from '@gaapp/shared';
import { z } from 'zod';
import { uuidSchema } from './common';

/** 在庫の数（stocks.count の CHECK `count between 0 and 10000`。0001。上限は shared の MAX_COUNT） */
export const stockCountSchema = z
  .number({ message: '数を入れてください' })
  .int({ message: '整数で入れてください' })
  .min(0, { message: '0 以上にしてください' })
  .max(MAX_COUNT, { message: `${MAX_COUNT} までです` });

/**
 * 在庫入力の1行のキー。9 品目は品目の id、備品（数えるだけ。T22・D-60）は `c:` に count_items の id を付けたもの
 * （同じ部屋の在庫と数をまとめて1つの入力として扱うため。04「在庫入力」の備品（数えるだけ））
 */
export const COUNT_KEY_PREFIX = 'c:';
/** 備品（数えるだけ）の行のキー */
export function countKey(countItemId: string): string {
  return `${COUNT_KEY_PREFIX}${countItemId}`;
}
/** 備品（数えるだけ）の行のキーなら count_items の id、品目のキーなら null */
export function countItemIdOf(key: string): string | null {
  return key.startsWith(COUNT_KEY_PREFIX) ? key.slice(COUNT_KEY_PREFIX.length) : null;
}
/** 行のキー（品目の id か `c:` と count_items の id。どちらも uuid の形） */
export const stockLineKeySchema = z.string().refine((k) => uuidSchema.safeParse(countItemIdOf(k) ?? k).success, { message: '行の形が違います' });

/** 部屋の全品目の数（行のキー → 数。品目と備品〔数えるだけ〕） */
export const stockCountsSchema = z.record(stockLineKeySchema, stockCountSchema);
export type StockCounts = z.output<typeof stockCountsSchema>;

/**
 * 入力の元にした部屋の行の updated_at（品目の id → updated_at。行のない品目は入れない）。
 * 下書きを戻して保存するとき、下書きを作った後にほかの人が保存したかをこれと比べて確かめる。
 */
export const stockBaseStampsSchema = z.record(stockLineKeySchema, z.string());
export type StockBaseStamps = z.output<typeof stockBaseStampsSchema>;

/**
 * 下書き（lib/drafts.ts）に置く値。入力中の数と、その元にした行の updated_at。壊れた下書きは捨てる。
 * 送信の記録は置かない（設計 2.6 の (A) の 5。前の形の下書きの sent は読むときに落とす）。
 */
export const stockDraftSchema = z.object({ counts: stockCountsSchema, base: stockBaseStampsSchema });
export type StockDraft = z.output<typeof stockDraftSchema>;

/**
 * `/stock?room=<id>` の room。uuid でなければ null（場所を選ぶ一覧を出す）。
 * QR を読んだ URL・手で打った URL のどちらでも、前後の空白と大文字は許す。
 */
export function parseRoomParam(value: string | null | undefined): string | null {
  if (!value) return null;
  const r = uuidSchema.safeParse(value.trim().toLowerCase());
  return r.success ? r.data : null;
}

/**
 * `/stocks/qr?rooms=<id>,<id>` の rooms。uuid の形のものだけを、重複を除いて先の順で返す。
 * 1つもなければ null（既定の「保管場所すべて」）。
 */
export function parseRoomsParam(value: string | null | undefined): string[] | null {
  if (!value) return null;
  const out: string[] = [];
  for (const part of value.split(',')) {
    const id = parseRoomParam(part);
    if (id && !out.includes(id)) out.push(id);
  }
  return out.length > 0 ? out : null;
}
