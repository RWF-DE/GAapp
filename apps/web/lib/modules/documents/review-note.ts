// 差し戻しの理由・承認のメモの前後の空白を除く（T19・D-55）。zod を読まない小さなモジュール：自団体の提出物（/document）の最初に読む JS
// （lib/modules/documents/outcome.ts の (B1) の比べ方）が使うので、lib/schemas/document-fields.ts（zod）から出した（FU3 の PR B の案 5。
// document-fields.ts は同じ名前で出し直す）。
// 前後の空白は JavaScript の String.prototype.trim で除く（zod の trim・DB の RPC が除く 25 文字と同じ）。

/** 前後の空白を除いた理由・メモ（空なら null）。DB の RPC と同じ形にそろえる（送る前と、(B1) の比べ方） */
export function normalizeReviewNote(note: string | null | undefined): string | null {
  const t = (note ?? '').trim();
  return t === '' ? null : t;
}
