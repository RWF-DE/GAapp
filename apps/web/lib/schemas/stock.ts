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

/** 部屋の全品目の数（品目の id → 数） */
export const stockCountsSchema = z.record(uuidSchema, stockCountSchema);
export type StockCounts = z.output<typeof stockCountsSchema>;

/** 下書き（lib/drafts.ts）に置く値。壊れた下書きは捨てる */
export const stockDraftSchema = z.object({ counts: stockCountsSchema });
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
