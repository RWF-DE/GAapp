// 提出物（T19。D-55）の E2E・スクリーンショット・4G の計測が使う補助：提出物と提出を SQL で入れる、Asia/Tokyo の締切を作る、
// テストの中でファイル（PDF・JPEG）を作る、API（publishable キーとアクセストークン）で予約・Storage へ上げる・提出する、DB と
// Storage の物を読む、2つの画面とダッシュボードを開いて読み終わるのを待つ、1件を探す。e2e/t19-documents.spec.ts・
// e2e/serial/t19-documents.spec.ts・e2e/shots/T19.shots.ts・e2e/perf.spec.ts。
// SQL はシナリオの年度の提出物の3表にだけ書く（年度をまたぐ表には書かない。D-36）。書いた人（created_by・updated_by）は入れた値のまま
// 残る（auth.uid() のない書き込みでは、set_actor のトリガーが入れた値を変えない。D-10）。
// Storage の物（storage.objects の行）は SQL では消さない（`storage.allow_delete_query` を立てない）。消すのは Storage API の remove で、
// removeDocumentObjects が、その年度のファイルの行を消して「どの提出にも属さないファイル」にしてから、その年度の管理者のロールを付けた
// 使い捨てのユーザーで消す（Storage の物の中身も消える。年度を先に消すと、誰の範囲にも入らない物が残るため、年度より先に消す）。
// テストのファイルはテストの中で作る（個人名なし。fixtures に実物を置かない）。publishable キー以外の Supabase の鍵は使わない。
// 期待値の文言は画面の仕様（04「提出物」「自団体の提出物」「提出状況」）のとおりに書く（アプリの定数から引かない）。
import { randomUUID } from 'node:crypto';
import { expect, type Locator, type Page } from '@playwright/test';
import { SUPABASE_PUBLISHABLE_KEY, SUPABASE_URL } from '../helpers';
import { addDays, tokyoToday } from './calendar';
import { createUser, sql, withTx, type Scenario } from './db';
import { likePrefix } from './like';
import { TEST_PASSWORD, USERS, type SeedUser } from './users';

/** 団体の区分（group_category。02 の列挙の並び） */
export type DocumentCategory = 'stall' | 'department' | 'company' | 'rest_area';
/** 提出の状態（document_status。02 の列挙の並び） */
export type DocumentStatus = 'not_submitted' | 'submitted' | 'returned' | 'approved';
/** ファイルの形（bucket documents の allowed_mime_types） */
export type DocumentContentType = 'application/pdf' | 'image/jpeg' | 'image/png';

/** bucket の名前（0016 が作る非公開の bucket） */
export const DOCUMENTS_BUCKET = 'documents';

// ---------------------------------------------------------------- 締切（Asia/Tokyo）

/** 今日（Asia/Tokyo）から days 日後の time（HH:mm）の締切（`YYYY-MM-DDTHH:mm:00+09:00`。負の日数は過去） */
export function tokyoDeadline(days: number, time = '17:00'): string {
  return `${addDays(tokyoToday(), days)}T${time}:00+09:00`;
}

// ---------------------------------------------------------------- 提出物・提出（SQL）

export interface DocumentInput {
  title: string;
  description?: string | null;
  /** timestamptz の文字列（tokyoDeadline など） */
  deadline: string;
  categories: readonly DocumentCategory[];
  foodOnly?: boolean;
  /** 提出先の URL（T24。D-62。既定は null〔提出先なし〕）。requires_file は 0023 のトリガーでいつも false なので入れない */
  submitUrl?: string | null;
  /** 書いた人の user_id（null は、アカウントが消えた・アプリの外で入れた提出物） */
  createdBy: string | null;
}

/**
 * 提出物を入れ、id を入れた順に返す（渡した配列と同じ長さの組。分割代入で受け取れる）。
 *
 * @example
 * const [plan, food] = await insertDocuments(s.yearId, [
 *   { title: 'E2E 出店計画書', deadline: tokyoDeadline(7), categories: ['stall', 'department'], createdBy: SEED_USER_IDS.head },
 *   { title: 'E2E 食品の届け', deadline: tokyoDeadline(3), categories: ['stall'], foodOnly: true, createdBy: SEED_USER_IDS.head },
 * ]);
 */
export async function insertDocuments<const T extends readonly DocumentInput[]>(yearId: string, docs: T): Promise<{ -readonly [K in keyof T]: string }> {
  const ids = await withTx(async (c) => {
    const out: string[] = [];
    for (const d of docs) {
      const r = await c.query<{ id: string }>(
        `insert into public.documents (year_id, title, description, deadline, target_categories, food_only, submit_url, created_by, updated_by)
         values ($1, $2, $3, $4::timestamptz, $5::public.group_category[], $6, $7, $8, $8) returning id`,
        [yearId, d.title, d.description ?? null, d.deadline, d.categories, d.foodOnly ?? false, d.submitUrl ?? null, d.createdBy],
      );
      out.push(r.rows[0]!.id);
    }
    return out;
  });
  return ids as { -readonly [K in keyof T]: string };
}

/** 提出の行（状態ごとに DB の CHECK〔document_submissions_status_check〕を満たす列を入れる） */
export interface SubmissionInput {
  documentId: string;
  groupId: string;
  status: DocumentStatus;
  /** 提出した日時（提出済み・差し戻し・承認。紙での承認は null） */
  submittedAt?: string | null;
  submittedBy?: string | null;
  proxy?: boolean;
  /** 承認・差し戻しの日時 */
  reviewedAt?: string | null;
  reviewedBy?: string | null;
  /** 差し戻しの理由・承認のメモ */
  reviewNote?: string | null;
}

/** 提出を入れる（ファイルの要る提出物でも、ファイルなしで入る。画面の見た目と 4G の計測の準備用。RPC の確かめは通らない） */
export async function insertSubmissions(yearId: string, rows: readonly SubmissionInput[]): Promise<void> {
  await withTx(async (c) => {
    for (const r of rows) {
      await c.query(
        `insert into public.document_submissions (document_id, group_id, year_id, status, submitted_at, submitted_by, proxy,
                                                  reviewed_at, reviewed_by, review_note)
         values ($1, $2, $3, $4::public.document_status, $5::timestamptz, $6, $7, $8::timestamptz, $9, $10)`,
        [
          r.documentId,
          r.groupId,
          yearId,
          r.status,
          r.submittedAt ?? null,
          r.submittedBy ?? null,
          r.proxy ?? false,
          r.reviewedAt ?? null,
          r.reviewedBy ?? null,
          r.reviewNote ?? null,
        ],
      );
    }
  });
}

/** DB の提出の行（日時は ISO の文字列。行がなければ null） */
export interface SubmissionDbRow {
  status: DocumentStatus;
  submitted_at: string | null;
  submitted_by: string | null;
  proxy: boolean;
  reviewed_at: string | null;
  reviewed_by: string | null;
  review_note: string | null;
}

/** その提出（提出物 × 団体）の行 */
export async function submissionOf(documentId: string, groupId: string): Promise<SubmissionDbRow | null> {
  const [r] = await sql<SubmissionDbRow>(
    `select status::text as status, submitted_at::text as submitted_at, submitted_by, proxy, reviewed_at::text as reviewed_at,
            reviewed_by, review_note
       from public.document_submissions where document_id = $1 and group_id = $2`,
    [documentId, groupId],
  );
  return r ?? null;
}

/** DB のファイルの行と、Storage に届いたか（storage.objects の行があるか）と、届いた物の metadata */
export interface FileDbRow {
  id: string;
  object_path: string;
  content_type: string;
  size: number;
  created_by: string | null;
  uploaded: boolean;
  /** 届いた物の metadata（storage.objects。届いていなければ null） */
  metadata: Record<string, unknown> | null;
  /** 届いた物の user_metadata（storage.objects。元のファイル名が入っていないことを確かめる） */
  user_metadata: Record<string, unknown> | null;
}

/** その提出のファイル（予約した日時 → id の順。画面の「ファイル 1」「ファイル 2」の順） */
export async function filesOf(documentId: string, groupId: string): Promise<FileDbRow[]> {
  return sql<FileDbRow>(
    `select f.id, f.object_path, f.content_type, f.size, f.created_by, o.id is not null as uploaded, o.metadata, o.user_metadata
       from public.document_files f
       left join storage.objects o on o.bucket_id = 'documents' and o.name = f.object_path
      where f.document_id = $1 and f.group_id = $2
      order by f.created_at, f.id`,
    [documentId, groupId],
  );
}

/** ファイルの名前の日時（「ファイル 1（PDF・1 KB・11/8 17:00）」の日時。予約した日時を Asia/Tokyo の `M/D HH:mm` で） */
export async function fileTimeLabel(fileId: string): Promise<string> {
  const [r] = await sql<{ t: string }>(
    `select to_char(created_at at time zone 'Asia/Tokyo', 'FMMM/FMDD HH24:MI') as t from public.document_files where id = $1`,
    [fileId],
  );
  if (!r) throw new Error(`ファイル ${fileId} がありません`);
  return r.t;
}

/** 日時の短い表示（「11/8 17:00」。Asia/Tokyo。提出・承認・差し戻しの日時と締切の要対応の期日の形）を DB で作る */
export async function shortTimeOf(ts: string): Promise<string> {
  const [r] = await sql<{ t: string }>(`select to_char($1::timestamptz at time zone 'Asia/Tokyo', 'FMMM/FMDD HH24:MI') as t`, [ts]);
  return r!.t;
}

/** bucket documents の物のうち、その年度のフォルダ（path の1つ目）の物の name（SQL で読むだけ） */
export async function objectsOfYears(yearIds: readonly string[]): Promise<string[]> {
  if (yearIds.length === 0) return [];
  const rows = await sql<{ name: string }>(
    `select name from storage.objects where bucket_id = 'documents' and split_part(name, '/', 1) = any($1::text[]) order by name`,
    [yearIds.map((y) => y.toLowerCase())],
  );
  return rows.map((r) => r.name);
}

/** その path の物があるか */
export async function objectExists(objectPath: string): Promise<boolean> {
  const [r] = await sql<{ n: number }>(`select count(*)::int as n from storage.objects where bucket_id = 'documents' and name = $1`, [objectPath]);
  return (r?.n ?? 0) > 0;
}

// ---------------------------------------------------------------- テストの中で作るファイル

/**
 * 小さな PDF（1 ページ。label は ASCII の英数字と空白。個人名を入れない）。先頭は `%PDF-`（画面は先頭のバイトで形を決める）。
 * xref の位置まで正しく書く（PDF を開く道具がそのまま読める形）。
 */
export function makePdf(label: string): Buffer {
  if (!/^[A-Za-z0-9 ._-]+$/.test(label)) throw new Error('makePdf の label は ASCII の英数字にしてください');
  const content = `BT /F1 18 Tf 36 96 Td (${label}) Tj ET`;
  const objects = [
    '<< /Type /Catalog /Pages 2 0 R >>',
    '<< /Type /Pages /Kids [3 0 R] /Count 1 >>',
    '<< /Type /Page /Parent 2 0 R /MediaBox [0 0 420 200] /Contents 4 0 R /Resources << /Font << /F1 5 0 R >> >> >>',
    `<< /Length ${content.length} >>\nstream\n${content}\nendstream`,
    '<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>',
  ];
  let out = '%PDF-1.4\n';
  const offsets: number[] = [];
  objects.forEach((o, k) => {
    offsets.push(Buffer.byteLength(out, 'latin1'));
    out += `${k + 1} 0 obj\n${o}\nendobj\n`;
  });
  const xref = Buffer.byteLength(out, 'latin1');
  out += `xref\n0 ${objects.length + 1}\n0000000000 65535 f \n${offsets.map((o) => `${String(o).padStart(10, '0')} 00000 n \n`).join('')}`;
  out += `trailer\n<< /Size ${objects.length + 1} /Root 1 0 R >>\nstartxref\n${xref}\n%%EOF\n`;
  return Buffer.from(out, 'latin1');
}

/**
 * 写真の代わりの JPEG（ブラウザの canvas で描く。width × height の色の帯と文字。EXIF なし）。ページは何の画面でもよい
 * （canvas を使うだけ）。ルートの tsconfig は DOM の型を持たないので、式は文字列で渡す（文字列の式は引数を受け取らないので、
 * 大きさは数として式に入れる）。
 */
export async function makeJpeg(page: Page, width = 640, height = 480): Promise<Buffer> {
  const w = Math.round(width);
  const h = Math.round(height);
  const dataUrl = await page.evaluate<string>(
    `(() => {
      const c = document.createElement('canvas');
      c.width = ${w};
      c.height = ${h};
      const g = c.getContext('2d');
      g.fillStyle = '#f5f5f4';
      g.fillRect(0, 0, ${w}, ${h});
      g.fillStyle = '#0f766e';
      g.fillRect(0, 0, ${w}, ${Math.round(h / 4)});
      g.fillStyle = '#111827';
      g.font = '32px sans-serif';
      g.fillText('E2E T19 photo', 24, ${Math.round(h / 2)});
      return c.toDataURL('image/jpeg', 0.9);
    })()`,
  );
  return Buffer.from(dataUrl.replace(/^data:image\/jpeg;base64,/, ''), 'base64');
}

// ---------------------------------------------------------------- API（publishable キーとアクセストークン。画面と同じ道）

/** seed のユーザーか、createUser のユーザー */
export type ApiUser = SeedUser | { email: string; password: string };

/** パスワードでログインしてアクセストークンを得る（Node の fetch。テストの外〔db-setup・片付け〕でも使える） */
export async function apiToken(user: ApiUser): Promise<string> {
  const cred = typeof user === 'string' ? { email: USERS[user], password: TEST_PASSWORD } : user;
  const res = await fetch(`${SUPABASE_URL}/auth/v1/token?grant_type=password`, {
    method: 'POST',
    headers: { apikey: SUPABASE_PUBLISHABLE_KEY, 'Content-Type': 'application/json' },
    body: JSON.stringify(cred),
  });
  if (!res.ok) throw new Error(`ログインできません（${res.status}）`);
  return ((await res.json()) as { access_token: string }).access_token;
}

const authHeaders = (token: string | null): Record<string, string> => ({
  apikey: SUPABASE_PUBLISHABLE_KEY,
  ...(token ? { Authorization: `Bearer ${token}` } : {}),
});

/** PostgREST の応答（失敗のときは本文の { code, message, details }） */
export interface ApiResult<T> {
  status: number;
  data: T | null;
  error: { code?: string; message?: string; details?: string | null } | null;
}

async function toApiResult<T>(res: Response): Promise<ApiResult<T>> {
  const text = await res.text();
  const body: unknown = text ? JSON.parse(text) : null;
  return res.ok ? { status: res.status, data: body as T, error: null } : { status: res.status, data: null, error: body as ApiResult<T>['error'] };
}

/** POST /rest/v1/rpc/<name>（supabase.rpc と同じ。名前つきの引数） */
export async function apiRpc<T = unknown>(token: string | null, name: string, args: Record<string, unknown>): Promise<ApiResult<T>> {
  const res = await fetch(`${SUPABASE_URL}/rest/v1/rpc/${name}`, {
    method: 'POST',
    headers: { ...authHeaders(token), 'Content-Type': 'application/json' },
    body: JSON.stringify(args),
  });
  return toApiResult<T>(res);
}

/** GET /rest/v1/<query>（例：`v_document_files?select=id&year_id=eq.<id>`） */
export async function apiGet<T = unknown[]>(token: string | null, query: string): Promise<ApiResult<T>> {
  return toApiResult<T>(await fetch(`${SUPABASE_URL}/rest/v1/${query}`, { headers: authHeaders(token) }));
}

/**
 * Storage API の応答。Storage API はエラーを HTTP 400 で返し、本文の statusCode（"403"・"409"・"413"・"415" など）に中身を入れる
 * （notes/T19.md「ローカルで確かめた Storage の事実」）。画面と同じく本文の statusCode で分ける（HTTP の status は見ない）。
 */
export interface StorageResult {
  ok: boolean;
  /** HTTP の status */
  httpStatus: number;
  /** 本文の statusCode（成功なら null） */
  statusCode: string | null;
  body: unknown;
}

async function toStorageResult(res: Response): Promise<StorageResult> {
  const text = await res.text();
  let body: unknown = text;
  try {
    body = text ? JSON.parse(text) : null;
  } catch {
    // JSON でない本文（そのまま残す）
  }
  const code = typeof body === 'object' && body !== null && 'statusCode' in body ? String((body as { statusCode: unknown }).statusCode) : null;
  return { ok: res.ok, httpStatus: res.status, statusCode: res.ok ? null : code, body };
}

/**
 * Storage API で bucket documents の path へ上げる（POST /storage/v1/object/documents/<path>。上書きしない〔x-upsert: false〕）。
 * 本文はそのまま送り、形は Content-Type（bucket の allowed_mime_types はこれを見る）。画面の upload と同じ insert のポリシーとトリガーが効く。
 */
export async function storageUpload(token: string | null, objectPath: string, body: Buffer, contentType: string): Promise<StorageResult> {
  const res = await fetch(`${SUPABASE_URL}/storage/v1/object/${DOCUMENTS_BUCKET}/${objectPath}`, {
    method: 'POST',
    headers: { ...authHeaders(token), 'Content-Type': contentType, 'x-upsert': 'false', 'cache-control': 'max-age=3600' },
    body: new Uint8Array(body),
  });
  return toStorageResult(res);
}

/** Storage API で読む（GET /storage/v1/object/authenticated/documents/<path>）。読めれば中身、読めなければ本文の statusCode */
export async function storageDownload(token: string | null, objectPath: string): Promise<{ statusCode: string | null; bytes: Buffer | null }> {
  const res = await fetch(`${SUPABASE_URL}/storage/v1/object/authenticated/${DOCUMENTS_BUCKET}/${objectPath}`, { headers: authHeaders(token) });
  if (res.ok) return { statusCode: null, bytes: Buffer.from(await res.arrayBuffer()) };
  return { statusCode: (await toStorageResult(res)).statusCode, bytes: null };
}

/** Storage API で消す（DELETE /storage/v1/object/documents。消せた物の name を返す。消せるのはどの提出にも属さない物だけ） */
export async function storageRemove(token: string, paths: readonly string[]): Promise<string[]> {
  const removed: string[] = [];
  for (let k = 0; k < paths.length; k += 100) {
    const res = await fetch(`${SUPABASE_URL}/storage/v1/object/${DOCUMENTS_BUCKET}`, {
      method: 'DELETE',
      headers: { ...authHeaders(token), 'Content-Type': 'application/json' },
      body: JSON.stringify({ prefixes: paths.slice(k, k + 100) }),
    });
    const r = await toStorageResult(res);
    if (!r.ok) throw new Error(`Storage の物を消せません（${r.httpStatus}・${r.statusCode ?? '?'}）`);
    for (const o of (r.body as { name: string }[]) ?? []) removed.push(o.name);
  }
  return removed;
}

/** 予約の返り値（document_files の行のうち使うもの） */
export interface ReservedFile {
  id: string;
  object_path: string;
}

/**
 * reserve_document_file を API で呼ぶ（T24 から、呼べる人にはいつも invalid_state〔reason: uploads_disabled〕が返る。D-62）。
 * 止まっていることの確かめに使う。T24 の前のファイルを作るときは legacyReserve・uploadFileAs を使う。
 */
export function reserveFile(
  token: string,
  r: { documentId: string; groupId: string; contentType: DocumentContentType; size: number; fileId?: string },
): Promise<ApiResult<ReservedFile>> {
  return apiRpc<ReservedFile>(token, 'reserve_document_file', {
    p_document_id: r.documentId,
    p_group_id: r.groupId,
    p_file_id: r.fileId ?? randomUUID(),
    p_content_type: r.contentType,
    p_size: r.size,
  });
}

/** token（JWT）の利用者の id（sub） */
function userIdOf(token: string): string {
  const payload = token.split('.')[1];
  if (!payload) throw new Error('token の形が違います');
  return (JSON.parse(Buffer.from(payload, 'base64url').toString('utf8')) as { sub: string }).sub;
}

/**
 * T24 の前の予約を SQL で作る（0016 の reserve_document_file が書いていた行と同じ：提出の行がなければ作り、document_files に
 * 予約の行を入れ、提出の版〔updated_at〕を進める）。T24 から予約の RPC は止めたが、すでに上がったファイルは見る・外す・片付ける
 * ことができる（D-62）ので、その確かめのために作る。予約した人（token の利用者）だけがその path に上げられる（insert のポリシーと
 * トリガーは 0016 のまま）。
 */
export async function legacyReserve(
  token: string,
  r: { documentId: string; groupId: string; contentType: DocumentContentType; size: number; fileId?: string },
): Promise<ReservedFile> {
  const userId = userIdOf(token);
  const fileId = r.fileId ?? randomUUID();
  const ext = r.contentType === 'application/pdf' ? 'pdf' : r.contentType === 'image/jpeg' ? 'jpg' : 'png';
  return withTx(async (c) => {
    const y = await c.query<{ year_id: string }>('select year_id from public.groups where id = $1', [r.groupId]);
    const yearId = y.rows[0]!.year_id;
    await c.query(
      `insert into public.document_submissions (document_id, group_id, year_id) values ($1, $2, $3)
       on conflict (document_id, group_id) do nothing`,
      [r.documentId, r.groupId, yearId],
    );
    const objectPath = `${yearId}/${r.groupId}/${r.documentId}/${fileId}.${ext}`;
    await c.query(
      `insert into public.document_files (id, year_id, document_id, group_id, object_path, content_type, size, created_by)
       values ($1, $2, $3, $4, $5, $6, $7, $8)`,
      [fileId, yearId, r.documentId, r.groupId, objectPath, r.contentType, r.size, userId],
    );
    await c.query('update public.document_submissions set updated_at = now() where document_id = $1 and group_id = $2', [r.documentId, r.groupId]);
    return { id: fileId, object_path: objectPath };
  });
}

/**
 * T24 の前のファイルを1つ作る（legacyReserve で予約し、返った path へ token の利用者が Storage API で upload）。上げた物の file_id と
 * path を返す（失敗なら例外）。
 */
export async function uploadFileAs(
  token: string,
  f: { documentId: string; groupId: string; body: Buffer; contentType?: DocumentContentType },
): Promise<ReservedFile> {
  const contentType = f.contentType ?? 'application/pdf';
  const reserved = await legacyReserve(token, { documentId: f.documentId, groupId: f.groupId, contentType, size: f.body.length });
  const up = await storageUpload(token, reserved.object_path, f.body, contentType);
  if (!up.ok) throw new Error(`上げられません：${up.httpStatus}・${up.statusCode ?? '?'}`);
  return reserved;
}

/** 提出を取り消す（API。画面の「提出を取り消す」と同じ RPC。読んだ版で） */
export async function withdrawAs(token: string, documentId: string, groupId: string): Promise<void> {
  const base = await submissionVersion(token, documentId, groupId);
  const r = await apiRpc(token, 'withdraw_document', { p_document_id: documentId, p_group_id: groupId, p_base_updated_at: base });
  if (r.error) throw new Error(`取り消せません：${JSON.stringify(r.error)}`);
}

/** その提出の今の版（v_document_status の updated_at。行がなければ null）を、その人の読める形で読む */
export async function submissionVersion(token: string, documentId: string, groupId: string): Promise<string | null> {
  const r = await apiGet<{ updated_at: string | null }[]>(token, `v_document_status?select=updated_at&document_id=eq.${documentId}&group_id=eq.${groupId}`);
  if (r.error || !r.data?.[0]) throw new Error(`提出の版を読めません：${JSON.stringify(r.error)}`);
  return r.data[0].updated_at;
}

/** API で「提出した」を送る（読んだ版で。画面の「提出した」と同じ RPC） */
export async function submitAs(token: string, documentId: string, groupId: string): Promise<void> {
  const base = await submissionVersion(token, documentId, groupId);
  const r = await apiRpc(token, 'submit_document', { p_document_id: documentId, p_group_id: groupId, p_base_updated_at: base });
  if (r.error) throw new Error(`提出できません：${JSON.stringify(r.error)}`);
}

// ---------------------------------------------------------------- 片付け（Storage API。SQL で物を消さない）

/**
 * その年度のフォルダの Storage の物を、Storage API の remove で消し、消した数を返す（物がなければ何もしない）：
 * 1. その年度のファイルの行（document_files。DB の行）を消す。物は「どの提出にも属さないファイル」になる（delete のポリシーで消せる物）。
 * 2. 使い捨てのユーザー（e2e-storage-cleanup-…@example.test）にその年度の管理者のロールを付け、publishable キーでログインして remove
 *    （画面の片付けと同じ道。Storage の物の中身も消える）。ユーザーは最後に消す（ロールも連鎖で消える）。
 * 3. 残っていれば例外（年度は消さない。次の db-setup の掃除がもう一度消す）。
 * 年度を消す前に呼ぶ（年度を先に消すと、その年度のフォルダは誰の範囲にも入らず、Storage API で消せない）。
 */
export async function removeDocumentObjects(yearIds: readonly string[]): Promise<number> {
  const names = await objectsOfYears(yearIds);
  if (names.length === 0) return 0;
  await sql('delete from public.document_files where year_id = any($1::uuid[])', [yearIds]);
  const u = await createUser({ purpose: 'storage-cleanup', name: 'E2E 片付け' });
  try {
    await sql(
      `insert into public.year_roles (year_id, user_id, role)
       select y.id, $2, 'admin' from public.years y where y.id = any($1::uuid[])
       on conflict (year_id, user_id) do nothing`,
      [yearIds, u.id],
    );
    const token = await apiToken({ email: u.email, password: u.password });
    await storageRemove(token, names);
  } finally {
    await u.cleanup();
  }
  const left = await objectsOfYears(yearIds);
  if (left.length > 0) throw new Error(`Storage の物を ${left.length} 個消せませんでした（年度 ${yearIds.join('・')}）`);
  return names.length;
}

/** シナリオの年度（と前年度）の Storage の物を Storage API で消してから、年度を消す（提出物の E2E の後片付け） */
export async function cleanupDocumentsScenario(s: Scenario): Promise<void> {
  await removeDocumentObjects([s.yearId, ...(s.prevYearId ? [s.prevYearId] : [])]);
  await s.cleanup();
}

/**
 * db-setup の掃除（前の実行の残り物）：年度名が E2E- で始まる年度のフォルダの Storage の物を Storage API で消す（年度を消す
 * cleanupLeftovers の前に呼ぶ）。どの年度にも属さないフォルダの物（年度が先に消えた物。ふつうは起きない）は Storage API では
 * 誰も消せないので、数だけを返す（db-setup が知らせる）。
 */
export async function removeLeftoverDocumentObjects(): Promise<{ removed: number; stray: number }> {
  const years = (await sql<{ id: string }>(`select id from public.years where label like $1 escape '\\'`, [likePrefix('E2E-')])).map((r) => r.id);
  const removed = await removeDocumentObjects(years);
  const [stray] = await sql<{ n: number }>(
    `select count(*)::int as n from storage.objects o
      where o.bucket_id = 'documents' and not exists (select 1 from public.years y where y.id::text = split_part(o.name, '/', 1))`,
  );
  return { removed, stray: stray?.n ?? 0 };
}

// ---------------------------------------------------------------- 画面

/** 最新でない年度の確かめに「この年度に{動詞}する」で答える（シナリオの年度は seed の利用者の最新の年度〔R8〕より前。D-31） */
export async function confirmNotLatest(page: Page, verb: '変更' | '提出' | '取り消し'): Promise<void> {
  const dialog = page.getByRole('alertdialog').filter({ hasText: '最新でない年度' });
  // ファイルを足すときは、選んだファイルの確かめ（写真は縮める）の後に出るので、少し長く待つ
  await expect(dialog).toContainText(`に${verb}します。よろしいですか`, { timeout: 20_000 });
  await dialog.getByRole('button', { name: `この年度に${verb}する` }).click();
  await expect(dialog).toHaveCount(0);
}

/** 自団体の提出物（/document/）を開き、読み終わるのを待つ（h1 と、カードか空の表示）。query は `?group=…` など */
export async function openDocument(page: Page, query = ''): Promise<void> {
  await page.goto(`/document/${query}`);
  await expect(page.getByRole('heading', { level: 1, name: '自団体の提出物' })).toBeVisible();
  await expect(page.getByTestId('document-card').first().or(page.getByTestId('document-empty'))).toBeVisible();
}

/** 提出状況（/documents/）を開き、読み終わるのを待つ（h1 と、表・一覧・空の表示か設定のタブ）。query は `?tab=settings` など */
export async function openDocuments(page: Page, query = ''): Promise<void> {
  await page.goto(`/documents/${query}`);
  await expect(page.getByRole('heading', { level: 1, name: '提出状況' })).toBeVisible();
  await expect(
    page
      .getByTestId('documents-table')
      .or(page.getByTestId('documents-list'))
      .or(page.getByTestId('documents-empty'))
      .or(page.getByTestId('documents-no-targets'))
      .or(page.getByTestId('documents-filter-empty'))
      .or(page.getByTestId('documents-settings')),
  ).toBeVisible();
}

/** /document のカード（data-document-id） */
export const documentCard = (page: Page, documentId: string): Locator => page.locator(`[data-testid="document-card"][data-document-id="${documentId}"]`);

/** /documents の表のセル（data-document-id・data-group-id） */
export const documentsCell = (page: Page, documentId: string, groupId: string): Locator =>
  page.locator(`[data-testid="documents-cell"][data-document-id="${documentId}"][data-group-id="${groupId}"]`);

/** ダッシュボードの要対応の1件（data-id） */
export const portalTodo = (page: Page, id: string): Locator => page.locator(`[data-testid="portal-todo"][data-id="${id}"]`);

/** ダッシュボードの締切と予定の1件（data-id） */
export const portalDated = (page: Page, id: string): Locator => page.locator(`[data-testid="portal-dated-item"][data-id="${id}"]`);

/** ダッシュボードの提出物のカード */
export const documentsModuleCard = (page: Page): Locator => page.locator('[data-testid="module-card"][data-module="documents"]');

/** ページが横にはみ出していない（スマホの幅 390px） */
export async function expectNoOverflow(page: Page, width = 390): Promise<void> {
  expect(await page.evaluate<number>('document.documentElement.scrollWidth')).toBeLessThanOrEqual(width);
}

/** ブラウザの保存（localStorage・sessionStorage）に、署名つき URL（`/object/sign/`）や token が残っていない */
export async function expectNoSignedUrlStored(page: Page): Promise<void> {
  const stored = await page.evaluate<string>('JSON.stringify([Object.entries(localStorage), Object.entries(sessionStorage)])');
  expect(stored).not.toContain('/object/sign/');
  expect(stored).not.toContain('token=');
}
