// 提出物のファイルの決まり（04「提出物」のファイルの扱い、notes/T19.md「パート B・C の約束」5。T19・D-55）。純粋な関数と定数。
// - 形は先頭のバイトで決める（PDF は `%PDF-`、JPEG は `FF D8 FF`、PNG は `89 50 4E 47 0D 0A 1A 0A`）。ファイルの名前とブラウザが付けた
//   形は見ない（Q1。元のファイル名は持たない。Q16）。
// - 1つ 10 MiB まで（JPEG は作り直した後の大きさ）、1つの提出に 5 つまで（Q2）。
// - path は DB が作る（reserve_document_file の返り値の object_path）。objectPathFor は DB の CHECK と同じ形（テストで比べる）。
// - 1件の名前は「ファイル 1（PDF・1.2 MB・10/5 17:00）」（created_at → id の順に番号）。保存の名前は「{提出物}_{団体}_{n}.{拡張子}」。
// 選んだファイルの確かめの文言もここに置く（04「ファイルの扱い」）。画像の作り直しは image.ts（ファイルを選んだときに動的 import）。
import { formatShortDateTime } from '@/lib/datetime';
import { CONTENT_TYPE_EXT, CONTENT_TYPE_LABELS, isDocumentContentType, type DocumentContentType } from './labels';

/** bucket の名前（0016 が作る非公開の bucket） */
export const DOCUMENTS_BUCKET = 'documents';
/** 1つの提出のファイルの数の上限（Q2。reserve_document_file の too_many_files） */
export const MAX_FILES = 5;
/** 1つのファイルの大きさの上限（10 MiB。document_files_size_check と bucket の file_size_limit） */
export const MAX_FILE_BYTES = 10 * 1024 * 1024;
/** bucket 全体の上限（900 MiB。reserve_document_file の storage_full と document_storage_usage の limit_bytes） */
export const STORAGE_LIMIT_BYTES = 900 * 1024 * 1024;
/** 署名つき URL の有効な秒数（押したときに作り、残さない） */
export const SIGNED_URL_SECONDS = 60;
/** ファイルの選びの accept */
export const FILE_ACCEPT = 'application/pdf,image/jpeg,image/png';
/** 先頭のバイトを見る数（PNG の 8 バイトがいちばん長い） */
export const SNIFF_BYTES = 8;

/** 「ファイルを追加」の横の説明（04「自団体の提出物」） */
export const FILE_HINT = 'PDF・JPEG・PNG。1つ 10 MB まで、5 つまで。写真は送る前に縮めます';
/** 5 つあるとき（「ファイルを追加」を押せなくする） */
export const FILES_FULL_MESSAGE = 'ファイルは 5 つまでです';
/** 形が3つのどれでもない */
export const FILE_TYPE_MESSAGE = 'PDF・JPEG・PNG 以外のファイルがあります。PDF・JPEG・PNG を選んでください';
/** 10 MiB を超える（JPEG は作り直した後） */
export const FILE_SIZE_MESSAGE = '10 MB を超えるファイルがあります（1つ 10 MB まで）';
/** 0 バイト */
export const FILE_EMPTY_MESSAGE = '中身のないファイルがあります';
/** 写真を作り直せなかった（image.ts） */
export const IMAGE_DECODE_MESSAGE = '写真を読み込めませんでした。別の写真を選んでください';

/** 数を超える（あと n つ足せる。0 も出す） */
export function tooManyFilesMessage(remaining: number): string {
  return `選んだファイルが多すぎます。この提出物には、あと ${Math.max(0, remaining)} つ足せます（1つの提出物に ${MAX_FILES} つまで）`;
}

const PDF = [0x25, 0x50, 0x44, 0x46, 0x2d];
const JPEG = [0xff, 0xd8, 0xff];
const PNG = [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a];

const startsWith = (bytes: Uint8Array, magic: readonly number[]) => bytes.length >= magic.length && magic.every((b, k) => bytes[k] === b);

/**
 * 先頭のバイトから形を決める（3つのどれでもなければ null）。
 *
 * @example
 * sniffContentType(new TextEncoder().encode('%PDF-1.7')) // 'application/pdf'
 */
export function sniffContentType(bytes: Uint8Array): DocumentContentType | null {
  if (startsWith(bytes, PDF)) return 'application/pdf';
  if (startsWith(bytes, JPEG)) return 'image/jpeg';
  if (startsWith(bytes, PNG)) return 'image/png';
  return null;
}

/** 選んだファイルの確かめの結果（合わなければ理由の文言。どれも送らない） */
export type SelectionCheck = { ok: true } | { ok: false; message: string };

/** 選んだファイル（作り直す前）：大きさと、先頭のバイトで決めた形 */
export interface PickedFile {
  size: number;
  type: DocumentContentType | null;
}

/**
 * 選んだファイルの確かめ（作り直す前。04「ファイルの扱い」）：中身がある（0 バイトは形を決められないので先に見る）→ 形 → 数
 * （その提出のファイル〔届いていないものを含む〕と合わせて 5 つまで）。大きさは作り直した後に checkPrepared で見る。
 */
export function checkPicked(picked: readonly PickedFile[], existing: number): SelectionCheck {
  if (picked.some((f) => f.size <= 0)) return { ok: false, message: FILE_EMPTY_MESSAGE };
  if (picked.some((f) => f.type === null)) return { ok: false, message: FILE_TYPE_MESSAGE };
  if (existing + picked.length > MAX_FILES) return { ok: false, message: tooManyFilesMessage(MAX_FILES - existing) };
  return { ok: true };
}

/** 送る物の大きさの確かめ（JPEG は作り直した後、PDF・PNG はそのまま）：1 バイト以上 10 MiB まで */
export function checkPrepared(sizes: readonly number[]): SelectionCheck {
  if (sizes.some((s) => s <= 0)) return { ok: false, message: FILE_EMPTY_MESSAGE };
  if (sizes.some((s) => s > MAX_FILE_BYTES)) return { ok: false, message: FILE_SIZE_MESSAGE };
  return { ok: true };
}

/**
 * 選んだファイルを全部確かめる（作り直さない形だけのときと、作り直した後の大きさがあるとき）：中身・形・数・大きさの順。
 * prepared を省くと、選んだときの大きさで見る。
 */
export function checkSelection(picked: readonly PickedFile[], existing: number, prepared?: readonly number[]): SelectionCheck {
  const first = checkPicked(picked, existing);
  if (!first.ok) return first;
  return checkPrepared(prepared ?? picked.map((f) => f.size));
}

/** ファイルの行のうち、番号と名前に使う列 */
export interface FileLike {
  id: string;
  created_at: string;
}

/** 番号つきのファイル（1 から） */
export interface NumberedFile<T extends FileLike> {
  n: number;
  file: T;
}

const timeOrInf = (iso: string) => {
  const t = Date.parse(iso);
  return Number.isNaN(t) ? Number.POSITIVE_INFINITY : t;
};

/** 1つの提出のファイルに番号を付ける（created_at → id の順に 1, 2, …。元の配列は変えない） */
export function numberFiles<T extends FileLike>(files: readonly T[]): NumberedFile<T>[] {
  return [...files]
    .sort((a, b) => timeOrInf(a.created_at) - timeOrInf(b.created_at) || (a.id < b.id ? -1 : a.id > b.id ? 1 : 0))
    .map((file, k) => ({ n: k + 1, file }));
}

const KIB = 1024;
const MIB = 1024 * 1024;

/**
 * 大きさの表示（04「ファイルの扱い」）：1 MB 未満は「{n} KB」（切り上げ）、10 MB 未満は小数1桁の「{x.x} MB」、ほかは整数の「{n} MB」
 * （1 KB は 1,024 バイト、1 MB は 1,048,576 バイト。上限の 10 MB・900 MB と同じ数え方）。負・数でないものは 0 として出す。
 *
 * @example
 * formatFileSize(1_258_291) // '1.2 MB'
 * formatFileSize(943_718_400) // '900 MB'
 */
export function formatFileSize(bytes: number): string {
  const b = Number.isFinite(bytes) && bytes > 0 ? bytes : 0;
  if (b < MIB) return `${Math.ceil(b / KIB)} KB`;
  const mb = b / MIB;
  if (mb < 10) {
    const r = Math.round(mb * 10) / 10;
    return r >= 10 ? '10 MB' : `${r.toFixed(1)} MB`;
  }
  return `${Math.round(mb)} MB`;
}

/** 名前に使う列（v_document_files） */
export interface LabelFile {
  content_type: string;
  size: number;
  stored_size: number | null;
  uploaded: boolean | null;
  created_at: string;
}

/** 表示する大きさ（届いたものは実際の大きさ stored_size、届いていないものは申告の size） */
export function displaySize(f: Pick<LabelFile, 'size' | 'stored_size' | 'uploaded'>): number {
  return f.uploaded && f.stored_size !== null ? f.stored_size : f.size;
}

/**
 * 1件の名前：「ファイル 1（PDF・1.2 MB・10/5 17:00）」（形・大きさ・予約した日時。元のファイル名は出さない。Q16）。
 */
export function fileLabel(n: number, f: LabelFile): string {
  const type = isDocumentContentType(f.content_type) ? CONTENT_TYPE_LABELS[f.content_type] : 'ファイル';
  const at = formatShortDateTime(f.created_at);
  return `ファイル ${n}（${[type, formatFileSize(displaySize(f)), at].filter((s) => s !== '').join('・')}）`;
}

/** 保存の名前のそれぞれの部分の上限（文字） */
export const DOWNLOAD_PART_MAX = 40;

const UNSAFE_NAME_CHARS = new Set(['\\', '/', ':', '*', '?', '"', '<', '>', '|']);

/** ファイル名に使えない文字か（`\ / : * ? " < > |` と制御文字〔C0・DEL・C1〕） */
function unsafeNameChar(ch: string): boolean {
  const c = ch.codePointAt(0) ?? 0;
  return UNSAFE_NAME_CHARS.has(ch) || c < 0x20 || (c >= 0x7f && c <= 0x9f);
}

/** ファイル名に使えない文字を `_` にし、前後の空白を除いて max 文字（コードポイント）までにする */
function safePart(s: string, max: number): string {
  const cleaned = [...s].map((ch) => (unsafeNameChar(ch) ? '_' : ch)).join('').trim();
  return [...cleaned].slice(0, max).join('').trim();
}

/**
 * 保存の名前：「{提出物}_{団体}_{n}.{拡張子}」（題名と団体の名前はそれぞれ 40 字まで。個人の名前は足さない）。
 *
 * @example
 * downloadNameFor('出店計画書', '模擬店01', 2, 'application/pdf') // '出店計画書_模擬店01_2.pdf'
 */
export function downloadNameFor(title: string, groupName: string, n: number, contentType: string): string {
  const ext = isDocumentContentType(contentType) ? CONTENT_TYPE_EXT[contentType] : 'bin';
  const t = safePart(title, DOWNLOAD_PART_MAX) || '提出物';
  const g = safePart(groupName, DOWNLOAD_PART_MAX) || '団体';
  return `${t}_${g}_${n}.${ext}`;
}

/**
 * Storage の path（DB の document_files_object_path_check と同じ形：`{year_id}/{group_id}/{document_id}/{file_id}.{pdf|jpg|png}`。uuid は
 * 小文字）。画面は予約の返り値の object_path を使い、これは比べるため（テスト）にだけ使う。
 */
export function objectPathFor(yearId: string, groupId: string, documentId: string, fileId: string, contentType: DocumentContentType): string {
  return `${yearId.toLowerCase()}/${groupId.toLowerCase()}/${documentId.toLowerCase()}/${fileId.toLowerCase()}.${CONTENT_TYPE_EXT[contentType]}`;
}

/** 1件の状態（data-state）：届いた・そのタブで上げている・そのタブで失敗した・届いていない（ほかの人・ほかのタブの予約や、開き直した） */
export type FileState = 'uploaded' | 'uploading' | 'failed' | 'missing';

/** そのタブの上げている・失敗したファイルの id */
export interface LocalUploads {
  uploading?: ReadonlySet<string>;
  failed?: ReadonlySet<string>;
}

/** 1件の状態（届いたかは v_document_files の uploaded、届いていないものはそのタブの状態で分ける） */
export function fileStateOf(f: { id: string; uploaded: boolean | null }, local: LocalUploads = {}): FileState {
  if (f.uploaded) return 'uploaded';
  if (local.uploading?.has(f.id)) return 'uploading';
  if (local.failed?.has(f.id)) return 'failed';
  return 'missing';
}

/** 「提出した」を押せない理由（04「自団体の提出物」。押せるなら null） */
export const SUBMIT_BLOCKERS = {
  noFile: 'ファイルを1つ以上足してください',
  notUploaded: '届いていないファイルがあります。外すか、もう一度送ってください',
  uploading: 'アップロードが終わるまでお待ちください',
} as const;

/**
 * 「提出した」（代わりに提出するも同じ）を押せない理由：アップロード中 → 届いていないファイルがある → ファイルが要る提出物でファイルが
 * 0（DB の not_uploaded・no_file と同じ条件。アップロード中は終わった後の読み直しを待つ）。押せるなら null。
 */
export function submitBlocker(requiresFile: boolean, files: readonly { uploaded: boolean | null }[], uploading: boolean): string | null {
  if (uploading) return SUBMIT_BLOCKERS.uploading;
  if (files.some((f) => !f.uploaded)) return SUBMIT_BLOCKERS.notUploaded;
  if (requiresFile && files.length === 0) return SUBMIT_BLOCKERS.noFile;
  return null;
}
