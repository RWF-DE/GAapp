// SQL の LIKE のパターンを組み立てる（e2e/support/db.ts の cleanupLeftovers が使う。DB につながない）。
// LIKE では _ が任意の1文字、% が任意の文字列なので、名前の一部として使うときはエスケープする。
// パターンは必ず `like $1 escape '\'` と、エスケープの文字を明示して使う（standard_conforming_strings に頼らない）。

/** LIKE の特別な文字（\・%・_）を \ でエスケープする */
export function escapeLike(s: string): string {
  return s.replace(/[\\%_]/g, (c) => `\\${c}`);
}

/**
 * 「prefix で始まり suffix で終わる」の LIKE のパターン（prefix と suffix はそのままの文字として扱う）。
 *
 * @example
 * await c.query(`select id from public.items where code like $1 escape '\\'`, [likePrefix('e2e_serial_')]);
 */
export function likePrefix(prefix: string, suffix = ''): string {
  return `${escapeLike(prefix)}%${escapeLike(suffix)}`;
}
