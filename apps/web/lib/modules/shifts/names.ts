// シフト・作業の画面の表示名（04「シフト表」「自分のシフト」「作業一覧」、notes/T20.md「画面の約束」4・5・7。T20・D-56）。
// 表示名（profiles）は RLS が返すもの全部を読み、user_id で引く。読めない・記録がない人は「名前を表示できません」。
// 純粋な関数だけ（シフト表・自分のシフト・作業一覧・印刷が共有する）。

/** 表示名が読めない・記録がないとき */
export const NAME_UNKNOWN = '名前を表示できません';

/** 表示名の行から user_id → 表示名 */
export function nameMapOf(rows: readonly { user_id: string; display_name: string }[] | undefined): Map<string, string> {
  return new Map((rows ?? []).map((r) => [r.user_id, r.display_name]));
}

const cmp = (a: string, b: string) => (a < b ? -1 : a > b ? 1 : 0);

/** 表示名の並び（表示名の順。名前のない人は後、同じなら user_id の順） */
export function compareByName(a: { userId: string; name: string | null }, b: { userId: string; name: string | null }): number {
  if (a.name === null || b.name === null) return a.name === b.name ? cmp(a.userId, b.userId) : a.name === null ? 1 : -1;
  return a.name.localeCompare(b.name, 'ja') || cmp(a.userId, b.userId);
}
