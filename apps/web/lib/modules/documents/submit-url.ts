// 提出先の URL（T24。D-62。04「提出物」の提出先）。提出物のファイルは学校の Google Workspace のドライブ・フォームに出し、アプリはそのリンク
// だけを持つ（documents.submit_url）。DB の documents_submit_url_check と同じ形（`https://` で始まり、その後に1字以上、空白〔JavaScript の
// \s。trim が除く 25 文字を含む〕と制御文字を含まない、500 字まで）だけをリンク（href）にする。/document の最初に読む JS に入るので、zod・
// React を import しない小さなモジュールにする（入力の確かめの zod は lib/schemas/documents.ts がこれを使う）。
/** 提出先の URL の上限（documents_submit_url_check の `length(submit_url) <= 500`。文字はコードポイントで数える） */
export const SUBMIT_URL_MAX = 500;

const SUBMIT_URL = /^https:\/\/[^\s\p{Cc}]+$/u;

/** 提出先の URL の形か（https・空白と制御文字なし・500 字まで） */
export function isSubmitUrl(url: string): boolean {
  return SUBMIT_URL.test(url) && [...url].length <= SUBMIT_URL_MAX;
}

/**
 * リンクにする URL（形が合えばそのまま、ほかは null。null・空も null）。画面は null ならリンクを出さない。
 *
 * @example
 * submitUrlHref('https://forms.gle/abc') // 'https://forms.gle/abc'
 * submitUrlHref('javascript:alert(1)')   // null
 */
export function submitUrlHref(url: string | null | undefined): string | null {
  return typeof url === 'string' && isSubmitUrl(url) ? url : null;
}
