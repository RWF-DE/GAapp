// 備品（数えるだけ。T22・D-60）の名前の zod。count_items の CHECK（前後の空白なしの 1〜50 字。0021）と同じ上限。
// 前後の空白は除いてから確かめる（DB は除かずに拒むので、送る前に除く）。
import { z } from 'zod';

/** count_items.name の上限（`length(name) <= 50`。0021） */
export const COUNT_ITEM_NAME_MAX = 50;

/** 名前（前後の空白を除いて 1〜50 字） */
export const countItemNameSchema = z
  .string()
  .trim()
  .min(1, { message: '名前を入れてください' })
  .max(COUNT_ITEM_NAME_MAX, { message: `名前は ${COUNT_ITEM_NAME_MAX} 字までです` });
