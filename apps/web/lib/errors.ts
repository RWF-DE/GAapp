// エラーの分類と日本語（画面の設計 2.5・2.6、D-33。T09a）。
// supabase-js のエラー（{ code, message, details, hint }）と通信の失敗を種類に分け、文言と「読み直すか・入力を残すか」を決める。
// E2E（Node。e2e/errors.spec.ts）からも読むので、`@/` の別名を使わず、相対の import とパッケージの import だけにする。
//
// 守ること：
// - 文言にメールアドレス・CSV の中身を入れない。P0001 以外の details（23505 の「Key (email)=(…)」など、DB の値を含みうる）は持たない。
// - details の団体・部屋・品目の id は、画面が渡す名前に置き換える（名前がなければ id は出さない）。
// - 表にない field・reason は「入力の形が違います」「この操作はできません」にする（新しい RPC が増えても落ちない）。
import { FIELD_LABELS, labelOf, ROLE_LABELS, YEAR_STATUS_LABELS, type YearStatus } from './labels';

export type ErrorKind =
  | 'forbidden'
  | 'not_found'
  | 'state'
  | 'conflict'
  | 'input'
  | 'reason'
  | 'issue'
  | 'blocked'
  | 'deadlock'
  | 'auth'
  | 'network'
  | 'unknown';

export type IssueCode = 'E001' | 'E002' | 'E005' | 'E006';
const ISSUE_CODES: readonly string[] = ['E001', 'E002', 'E005', 'E006'];

/** E001・E002・E005・E006 の details を1件ずつにそろえたもの（1件の object も配列も、この配列にする） */
export interface IssueDetail {
  code: IssueCode;
  roomId?: string;
  itemId?: string;
  groupId?: string;
  allocationId?: string;
  /** 振り分けの合計（E001） */
  allocated?: number;
  /** 在庫（E001） */
  stock?: number;
  /** save_auto_allocations の送った行の番号（1 から） */
  ord?: number;
}

export interface ClassifiedError {
  kind: ErrorKind;
  /** SQLSTATE か PostgREST のコード（P0001・42501・23505・PGRST303 など）。通信の失敗やコードのないものは null */
  code: string | null;
  /** P0001 の message（forbidden・invalid_state・E001 など）。画面が作るエラーは lock_conflict などの印 */
  reason: string | null;
  /** P0001 の details を JSON として読んだもの（読めなければ null）。P0001 以外は持たない */
  details: unknown;
  /** kind が issue のときの details の一覧 */
  issues: IssueDetail[];
  /** HTTP の status（分かるときだけ） */
  status: number | null;
}

/** 画面の層（lib/db・lib/rpc・lib/data）が投げるエラー。classifyError はそのまま中身を返す */
export class AppError extends Error {
  override name = 'AppError';
  readonly info: ClassifiedError;
  constructor(info: ClassifiedError) {
    // message には種類とコードだけを入れる（ログに出ても中身が漏れない）
    super(`${info.kind}${info.code ? `:${info.code}` : ''}${info.reason ? `:${info.reason}` : ''}`);
    this.info = info;
  }
}

/** 画面の層で作るエラー（DB の応答ではないもの） */
export function appError(kind: ErrorKind, reason: string, details: unknown = null): AppError {
  return new AppError({ kind, code: null, reason, details, issues: [], status: null });
}

/** supabase-js の応答の error（と status）を AppError にする */
export function toAppError(e: unknown, status?: number | null): AppError {
  return e instanceof AppError ? e : new AppError(classifyError(e, status));
}

const isRecord = (v: unknown): v is Record<string, unknown> => typeof v === 'object' && v !== null && !Array.isArray(v);
const str = (v: unknown): string | undefined => (typeof v === 'string' && v !== '' ? v : undefined);
const num = (v: unknown): number | undefined => (typeof v === 'number' && Number.isFinite(v) ? v : undefined);

/** details は JSON の文字列か空文字（PostgREST によっては null・object）。読めなければ null */
export function parseDetails(d: unknown): unknown {
  if (d === null || d === undefined) return null;
  if (typeof d !== 'string') return d;
  const t = d.trim();
  if (t === '') return null;
  try {
    return JSON.parse(t) as unknown;
  } catch {
    return null;
  }
}

function toIssue(v: unknown, fallback: string): IssueDetail | null {
  if (!isRecord(v)) return null;
  const code = str(v.code) ?? fallback;
  if (!ISSUE_CODES.includes(code)) return null;
  const out: IssueDetail = { code: code as IssueCode };
  const roomId = str(v.room_id) ?? str(v.source_room_id);
  if (roomId) out.roomId = roomId;
  const itemId = str(v.item_id);
  if (itemId) out.itemId = itemId;
  const groupId = str(v.group_id);
  if (groupId) out.groupId = groupId;
  const allocationId = str(v.allocation_id);
  if (allocationId) out.allocationId = allocationId;
  const allocated = num(v.allocated);
  if (allocated !== undefined) out.allocated = allocated;
  const stock = num(v.stock);
  if (stock !== undefined) out.stock = stock;
  const ord = num(v.ord);
  if (ord !== undefined) out.ord = ord;
  return out;
}

/** E00x の details（1件の object か配列）を配列にそろえる */
export function normalizeIssues(reason: string, details: unknown): IssueDetail[] {
  const list = Array.isArray(details) ? details : details === null ? [] : [details];
  const out = list.map((d) => toIssue(d, reason)).filter((d): d is IssueDetail => d !== null);
  // details がない・読めないときも、コードだけの1件にする（文言を出せるように）
  return out.length > 0 ? out : ISSUE_CODES.includes(reason) ? [{ code: reason as IssueCode }] : [];
}

const P0001_KINDS: Readonly<Record<string, ErrorKind>> = {
  forbidden: 'forbidden',
  not_found: 'not_found',
  invalid_state: 'state',
  conflict: 'conflict',
  invalid_input: 'input',
  reason_required: 'reason',
};

const looksLikeFetchFailure = (message: unknown) =>
  typeof message === 'string' && /^(TypeError|FetchError|AbortError)\b/.test(message);

/**
 * supabase-js のエラーと通信の失敗を分ける（2.5 の表）。status は supabase-js の応答の status（401 を見分けるため）。
 * 通信の失敗は supabase-js が `{ code: '', message: 'TypeError: …' }` と status 0 で返す。fetch の TypeError もそのまま受ける。
 */
export function classifyError(e: unknown, status?: number | null): ClassifiedError {
  if (e instanceof AppError) return e.info;
  const st = status ?? (isRecord(e) ? num(e.status) : undefined) ?? null;
  const base = (kind: ErrorKind, code: string | null, reason: string | null = null, details: unknown = null): ClassifiedError => ({
    kind,
    code,
    reason,
    details,
    issues: [],
    status: st,
  });

  if (e instanceof TypeError || (e instanceof Error && e.name === 'AbortError')) return base('network', null);
  if (!isRecord(e)) return base('unknown', null);

  const code = str(e.code) ?? null;
  if (code === 'PGRST301' || code === 'PGRST302' || code === 'PGRST303' || st === 401) return base('auth', code);
  if (code === null) {
    if (st === 0 || looksLikeFetchFailure(e.message)) return base('network', null);
    return base('unknown', null);
  }
  if (code === 'P0001') {
    const reason = typeof e.message === 'string' ? e.message : '';
    const details = parseDetails(e.details);
    if (ISSUE_CODES.includes(reason)) return { ...base('issue', code, reason, details), issues: normalizeIssues(reason, details) };
    const kind = P0001_KINDS[reason];
    return base(kind ?? 'unknown', code, reason || null, details);
  }
  if (code === '42501') return base('forbidden', code);
  if (code === '23505') return base('conflict', code);
  if (code === '23503') return base('blocked', code);
  if (code === '23514') return base('input', code);
  if (code === '40P01') return base('deadlock', code);
  if (code.startsWith('22')) return base('input', code);
  return base('unknown', code);
}

/** エラーの後の画面の動き（2.5 の「画面の動き」・2.6） */
export interface ErrorEffect {
  /** none：読み直さない、data：その画面のデータを読み直す、year：年度の行と立場を読み直す（読み取り専用・権限なしに切り替える） */
  reload: 'none' | 'data' | 'year';
  /** 入力中の値を残すか */
  keepInput: boolean;
  /** セッションの更新を1回試し、だめなら下書きを残して signOut（local）してから /login へ */
  reauth: boolean;
  /** 読み取りなら1回だけ再試行してよい（書き込みは自動で再送しない） */
  retryRead: boolean;
}

export function effectOf(e: ClassifiedError): ErrorEffect {
  const r = (reload: ErrorEffect['reload'], extra: Partial<ErrorEffect> = {}): ErrorEffect => ({
    reload,
    keepInput: true,
    reauth: false,
    retryRead: false,
    ...extra,
  });
  switch (e.kind) {
    case 'forbidden':
    case 'state':
      return r('year');
    case 'not_found':
    case 'conflict':
    case 'issue':
      return r('data');
    case 'auth':
      return r('none', { reauth: true });
    case 'network':
      return r('none', { retryRead: true });
    case 'unknown':
      return r(e.reason === 'unexpected_response' ? 'data' : 'none');
    default:
      // input・reason・blocked・deadlock：読み直さず、入力を残す
      return r('none');
  }
}

/** details の id を名前にする（画面が持っている名前。なければ undefined を返し、id は出さない） */
export interface NameLookup {
  room?: (id: string) => string | undefined;
  item?: (id: string) => string | undefined;
  group?: (id: string) => string | undefined;
}

export interface MessageContext {
  /** 呼んだ RPC の名前（details のないエラーの文言を分ける） */
  rpc?: string;
  names?: NameLookup;
  /** submit_requests の invalid_state（status: requesting）の後に読み直した年度の状態 */
  reloadedStatus?: YearStatus;
  /** create_year_from の details のない invalid_input に添える、複製元の1日目（YYYY-MM-DD） */
  prevFestivalStart?: string;
  /** 申請一覧・取り込みで対象の団体（conflict の item_id・invalid_input の submittedAt に名前を添える） */
  groupId?: string;
}

const statusLabel = (s: unknown): string | undefined =>
  typeof s === 'string' && Object.hasOwn(YEAR_STATUS_LABELS, s) ? YEAR_STATUS_LABELS[s as YearStatus] : undefined;

function nameOf(names: NameLookup | undefined, what: keyof NameLookup, id: string | undefined): string | undefined {
  if (!id) return undefined;
  return names?.[what]?.(id);
}

/** E001・E002・E005・E006 の1件の文言 */
export function issueMessage(d: IssueDetail, names?: NameLookup): string {
  const room = nameOf(names, 'room', d.roomId);
  const item = nameOf(names, 'item', d.itemId);
  const group = nameOf(names, 'group', d.groupId);
  switch (d.code) {
    case 'E001': {
      const where = room && item ? `${room}の${item}` : (room ?? item);
      const nums = d.allocated !== undefined && d.stock !== undefined ? `振り分け${d.allocated}、在庫${d.stock}` : undefined;
      const inner = [where, nums].filter(Boolean).join('：');
      return inner ? `在庫を超えます（${inner}）` : '在庫を超えます';
    }
    case 'E002':
      return room ? `使用不可の部屋（${room}）からは振り分けられません` : '使用不可の部屋からは振り分けられません';
    case 'E005':
      return group ? `残すと使用場所が合いません（${group}）` : '残すと使用場所が合いません';
    case 'E006':
      return group && item ? `${group}は${item}を申請できません` : '申請できない品目があります';
  }
}

/** kind が issue のときの一覧（画面は details の一覧として出す。allocation_id は振り分けの行へのリンクにする） */
export function issueMessages(e: ClassifiedError, ctx: MessageContext = {}): string[] {
  return e.issues.map((d) => issueMessage(d, ctx.names));
}

const GUARD_MESSAGE =
  '確定中は、在庫超過や使用不可の部屋からの振り分けになる変更はできません。確定を解除してから直してください';

function stateMessage(d: unknown, ctx: MessageContext): string {
  const generic = 'この操作はできません';
  if (!isRecord(d)) {
    if (ctx.rpc === 'set_consent') return 'まだ依頼されていないので回答できません。読み直しました';
    return generic;
  }
  if ('from' in d && 'to' in d) {
    const from = statusLabel(d.from);
    const to = statusLabel(d.to);
    return from && to ? `${from}から${to}には進められません。読み直しました` : '年度の状態を進められません。読み直しました';
  }
  if (d.status === 'closed' && d.reason === 'memo_only') return '終了した年度のルールは、メモだけ直せます';
  switch (d.reason) {
    case 'confirmed':
      return '確定中は振り分けを変えられません。確定を解除してから';
    case 'last_admin':
      return '最後の管理者は外せません';
    case 'not_latest':
      return '最新の年度からだけ新しい年度を作れます';
    case 'used':
      return '使用済みの招待は取り消せません';
    case 'no_rows':
      return '置き換えの行がないので依頼できません';
  }
  if (d.field === 'request_close_at') return '受付開始の前に、締切を未来の日時で入れてください';
  if (d.code === 'E001' || d.code === 'E002') {
    const room = nameOf(ctx.names, 'room', str(d.room_id));
    const item = nameOf(ctx.names, 'item', str(d.item_id));
    const where = d.code === 'E001' && room && item ? `${room}の${item}` : room;
    return where ? `${GUARD_MESSAGE}（${where}）` : GUARD_MESSAGE;
  }
  if ('group_id' in d && 'status' in d) return '確定中は団体の削除・使用場所・区分の変更はできません';
  if ('status' in d) {
    if (ctx.rpc === 'submit_requests' && d.status === 'requesting' && (ctx.reloadedStatus ?? 'requesting') === 'requesting') {
      return '締切を過ぎました（または受付の前です）。端末の時計がずれている可能性があります';
    }
    const label = statusLabel(ctx.rpc === 'submit_requests' && ctx.reloadedStatus ? ctx.reloadedStatus : d.status);
    return label ? `年度が「${label}」のため、この操作はできません` : generic;
  }
  return generic;
}

function conflictMessage(e: ClassifiedError, ctx: MessageContext): string {
  const generic = '他の人が先に変更しました。読み直しました';
  if (e.code === '23505') return '同じものがすでにあります（ほかの人が先に足した可能性があります）';
  const d = e.details;
  if (!isRecord(d)) return generic;
  if (d.field === 'label') return '同じ年度名があります';
  if (d.field === 'role') {
    const role = typeof d.current === 'string' ? labelOf(ROLE_LABELS, d.current) : '';
    return role ? `この人はすでに「${role}」です。ロールの変更はメンバーの一覧から` : 'この人にはすでに別のロールがあります。ロールの変更はメンバーの一覧から';
  }
  if ('asked' in d && 'current' in d) {
    const asked = num(d.asked);
    const current = num(d.current);
    return asked !== undefined && current !== undefined
      ? `依頼した台数（${asked}）より置き換えが増えています（${current}）。依頼し直してください`
      : '依頼した台数より置き換えが増えています。依頼し直してください';
  }
  if ('item_id' in d) {
    const group = nameOf(ctx.names, 'group', ctx.groupId);
    const item = nameOf(ctx.names, 'item', str(d.item_id));
    const what = group && item ? `${group}の${item}` : (item ?? group);
    return what ? `${what}は、ほかの人が先に変えました。読み直しました` : generic;
  }
  if ('allocation_version' in d) {
    if (ctx.rpc === 'set_year_status') {
      return '確定の前に入力が変わったので、検証をやり直しました。結果を確かめてから、もう一度『確定』を押してください';
    }
    if (ctx.rpc === 'save_auto_allocations') {
      return '計算している間に、ほかの人が振り分け・了承・在庫・申請・ルールなどを変えました。読み直しました。もう一度実行してください';
    }
    return '振り分けの入力がほかの人に変えられました。読み直しました';
  }
  if ('id' in d) return 'ほかの人が同じ振り分けの行を先に変えました。読み直しました';
  return generic;
}

function inputMessage(e: ClassifiedError, ctx: MessageContext): string {
  const generic = '入力の形が違います';
  if (e.code === '23514') return '入力が範囲を超えています';
  // 22xxx などの SQLSTATE は details を持たない。code が null は画面の層が送る前に止めたもの（lib/rpc の zod）
  if (e.code !== null && e.code !== 'P0001') return generic;
  const d = e.details;
  if (!isRecord(d)) {
    if (ctx.rpc === 'create_year_from') {
      return ctx.prevFestivalStart
        ? `年度名を入れ、1日目は今の年度（${ctx.prevFestivalStart}）より後の日付にしてください`
        : '年度名を入れ、1日目は今の年度より後の日付にしてください';
    }
    return generic;
  }
  if (Array.isArray(d.rows) || Array.isArray(d.duplicates)) {
    const n = ((d.rows ?? d.duplicates) as unknown[]).length;
    return `計算結果の行に誤りがあります（${n}行）。ページを再読み込みしてもう一度実行してください`;
  }
  if (d.reason === 'duplicate_id') return '同じ行への変更が重なっています';
  if (d.reason === 'immutable') {
    const col = typeof d.column === 'string' ? labelOf(FIELD_LABELS, d.column, d.column) : '';
    return col ? `この項目は変えられません（${col}）` : 'この項目は変えられません';
  }
  if ('op' in d) return '入力の形が違います（数は 1〜10000、運び元・品目を選んでください）';
  switch (d.field) {
    case 'festival_start':
      return '1日目は、前の年度より後・次の年度より前で、2000年1月1日〜2200年12月31日の日付にしてください';
    case 'request_close_at':
      return '申請の受付中は締切を空にできません';
    case 'email':
      return 'メールアドレスの形が違います';
    case 'reason':
      return '理由は 500 字までです';
    case 'submittedAt': {
      const group = nameOf(ctx.names, 'group', ctx.groupId);
      return group
        ? `フォームのタイムスタンプが読めないか、未来の日時です（${group}）`
        : 'フォームのタイムスタンプが読めないか、未来の日時です';
    }
  }
  const label = typeof d.field === 'string' ? labelOf(FIELD_LABELS, d.field) : '';
  return label ? `入力の形が違います（${label}）` : generic;
}

/** 分類したエラーの文言（2.5 の表と details の表）。MessageContext で RPC の名前・名前の引き方を渡す */
export function messageFor(e: ClassifiedError, ctx: MessageContext = {}): string {
  switch (e.kind) {
    case 'forbidden':
      return ctx.rpc === 'revoke_invitation'
        ? '取り消せませんでした。読み直しました'
        : '権限がありません。立場が変わった可能性があります';
    case 'not_found':
      if (e.reason === 'lock_missing') return 'すでに消えていました（ほかの人が消した可能性があります）。読み直しました';
      return isRecord(e.details) && e.details.field === 'user_id'
        ? 'この人のアカウントが見つかりません'
        : '対象が見つかりません（ほかの人が消した可能性があります）';
    case 'state':
      return stateMessage(e.details, ctx);
    case 'conflict':
      return conflictMessage(e, ctx);
    case 'input':
      return inputMessage(e, ctx);
    case 'reason':
      return '理由を入力してください';
    case 'issue': {
      const list = issueMessages(e, ctx);
      if (list.length === 0) return '振り分けに誤りがあります';
      return list.length === 1 ? list[0]! : `${list[0]}（ほか ${list.length - 1} 件）`;
    }
    case 'blocked':
      return 'ほかのデータから使われているので削除できません';
    case 'deadlock':
      return 'ほかの人の保存と重なりました。もう一度保存してください';
    case 'auth':
      return 'ログインし直してください';
    case 'network':
      return '通信できませんでした。電波の良い所でもう一度';
    case 'unknown':
      if (e.reason === 'unexpected_response') return '予期しない応答を受け取りました。読み直してください';
      return e.code ? `予期しないエラーが起きました（コード：${e.code}）` : '予期しないエラーが起きました';
  }
}
