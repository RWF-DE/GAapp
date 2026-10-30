// 団体名の確認と、Excel の団体別集計の並び（03「Excel出力仕様」、D-27・K-27、設計 13.2）
import { z } from 'zod';
import { GROUP_CATEGORIES, type GroupCategory } from './constants';
import type { InputError } from './model';
import { compareStrings } from './order';

/** 品目シートの B・C 列に書く語（SUMIF のキーと重なる） */
export const RESERVED_GROUP_NAMES = ['(計)', '使用不可', '余り', '残す'] as const;

/** 大文字・小文字と全角・半角を区別しない比較のための正規化 */
export function normalizeGroupName(name: string): string {
  return name.normalize('NFKC').trim().toLowerCase();
}

const RESERVED = new Set(RESERVED_GROUP_NAMES.map(normalizeGroupName));

/** 団体名1つで決まる禁止（SUMIF のワイルドカード・比較演算子・予約語） */
export const groupNameSchema = z
  .string()
  .trim()
  .min(1, { message: '団体名を入れてください' })
  .refine((s) => !/[*?~]/.test(s), { message: '団体名に半角の * ? ~ は使えません' })
  .refine((s) => !/^[=<>]/.test(s), { message: '団体名の先頭に半角の = < > は使えません' })
  .refine((s) => !RESERVED.has(normalizeGroupName(s)), {
    message: '団体名に「(計)」「使用不可」「余り」「残す」は使えません',
  });

/**
 * 年度の団体名をまとめて確かめる：1つずつの禁止と、NFKC で正規化して小文字にした名前の重複
 * （SUMIF は大文字・小文字を区別しないので、同じ団体として足される）。path は `groups.<添字>.name`。
 */
export function checkGroupNames(groups: readonly { name: string }[]): InputError[] {
  const errors: InputError[] = [];
  const seen = new Map<string, number>();
  groups.forEach((g, k) => {
    const r = groupNameSchema.safeParse(g.name);
    if (!r.success) {
      for (const issue of r.error.issues) errors.push({ path: `groups.${k}.name`, message: issue.message });
    }
    const key = normalizeGroupName(g.name);
    const first = seen.get(key);
    if (first === undefined) seen.set(key, k);
    else
      errors.push({
        path: `groups.${k}.name`,
        message: `団体名「${g.name}」は「${groups[first]!.name}」と大文字・小文字（全角・半角）だけが違います`,
      });
  });
  return errors;
}

/**
 * 団体別集計の並び（K-27）：区分（模擬店 → 部門 → 企業 → 休憩所）→ 提出日時（未提出は最後）→ sort_order → 名前 → id。
 * submittedAt は ISO 文字列。オフセットが違っても正しく比べるため時刻に直して比べる。
 */
export function compareGroupsForReport(
  a: { id: string; name: string; category: GroupCategory; sortOrder: number; submittedAt: string | null },
  b: { id: string; name: string; category: GroupCategory; sortOrder: number; submittedAt: string | null },
): number {
  const ca = GROUP_CATEGORIES.indexOf(a.category);
  const cb = GROUP_CATEGORIES.indexOf(b.category);
  if (ca !== cb) return ca - cb;
  if (a.submittedAt !== b.submittedAt) {
    if (a.submittedAt === null) return 1;
    if (b.submittedAt === null) return -1;
    const ta = Date.parse(a.submittedAt);
    const tb = Date.parse(b.submittedAt);
    if (ta !== tb) return ta - tb;
  }
  return a.sortOrder - b.sortOrder || compareStrings(a.name, b.name) || compareStrings(a.id, b.id);
}
