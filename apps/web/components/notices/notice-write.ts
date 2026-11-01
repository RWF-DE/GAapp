// お知らせの書き込みの送信と、応答が届かなかったとき・止められたときの決め方（画面の設計 2.6 の (B1)・(B2)。04「お知らせ一覧」の
// エラー、notes/T17.md「後半（画面）の約束」5。T17）。画面（ダイアログ・削除の確かめ）は結果の種類で出し方を決める。
// - 直す（save_notice の notice_id あり）と消す（delete_notice）は楽観ロック（updated_at）なので (B1)：応答が届かなかったその場と、
//   conflict・not_found（消すは forbidden も。delete_notice は、ないお知らせにも forbidden を返す）で止められたときに、そのお知らせを
//   1回読み直して決める。確かめるためだけの状態は持たない。直すの forbidden も読み直す（save_notice はピン留めを変える確かめを
//   楽観ロックより先に行うので、ほかの人がピン留めを付け外しした後の総務部門員の保存は forbidden になる。レビューの T17-R1）。
// - 出す（save_notice の notice_id なし）は冪等の鍵がないので (B2)：応答が届かなかったら、自分が出した最近のお知らせを読み直して
//   確かめる。読み直せなければ「確かめる」まで送り直させない（(B2) だけが持つ状態。ダイアログが持つ）。
// 401 は1回だけセッションを更新して送り直す（ほかの画面と同じ）。
import { isLockRejection, settleLockedWrite } from '@/lib/data/locked-save';
import { sameNoticeWrite, type NoticeRow, type SavedNotice } from '@/lib/data/notices';
import { appError, classifyError, isUnknownOutcome } from '@/lib/errors';
import type { NoticeWrite } from '@/lib/schemas/notices';

/** 401 の扱い（lib/auth/guarded.ts の useAuthErrorHandler） */
export type AuthErrorHandler = (e: unknown) => Promise<'retry' | 'signedOut' | 'other'>;

/** 出す・直すの結果 */
export type NoticeSaveResult =
  /** 保存できた。before は、応答が届かなかった・止められたが、読み直すと保存されていた（出されていた） */
  | { type: 'saved'; row: SavedNotice | NoticeRow; before: boolean }
  /** 直す：ほかの人が先に変えた。row（読み直した今の行）を入力の元にして入力を残す */
  | { type: 'conflict'; row: NoticeRow; error: unknown }
  /** 直す：お知らせが消えていた（読み直してもない） */
  | { type: 'missing'; error: unknown }
  /** 直す：応答が届かず、保存できたか分からない（版は読んだときのまま・読み直せなかった） */
  | { type: 'unknown'; error: unknown }
  /** 直す：止められた後に読み直せなかった（「読み直しました」とは言わない） */
  | { type: 'unread'; error: unknown }
  /** 出す：応答が届かなかったが、読み直すと出されていなかった（入力を残し、もう一度「出す」を押せる） */
  | { type: 'not-created'; error: unknown }
  /** 出す：応答が届かず、読み直せなかった（「確かめる」まで送り直さない） */
  | { type: 'unconfirmed'; error: unknown }
  /** そのほかの失敗（入力の誤り・forbidden・invalid_state・deadlock・認証など。effectOf のとおり） */
  | { type: 'failed'; error: unknown };

export interface NoticeSaveRequest {
  /** 直すときの入力の元（id と読んだときの updated_at）。出すときは null */
  base: { id: string; updatedAt: string } | null;
  /** 送る入力（読み直した行と sameNoticeWrite で比べる） */
  write: NoticeWrite;
  /** 送る（失敗したら投げる） */
  send: () => Promise<SavedNotice>;
  /** 直す：そのお知らせを1行読む（なければ null。失敗したら投げる） */
  reread: () => Promise<NoticeRow | null>;
  /** 出す：自分が出した最近のお知らせから、入力と同じで、開いたときの一覧になかったものを探す（なければ null。失敗したら投げる） */
  findCreated: () => Promise<NoticeRow | null>;
}

async function sendWithAuth<T>(send: () => Promise<T>, onAuthError: AuthErrorHandler): Promise<{ ok: true; value: T } | { ok: false; error: unknown }> {
  try {
    return { ok: true, value: await send() };
  } catch (e) {
    if ((await onAuthError(e)) !== 'retry') return { ok: false, error: e };
  }
  try {
    return { ok: true, value: await send() };
  } catch (e) {
    return { ok: false, error: e };
  }
}

/**
 * 出したお知らせの応答が届かなかったときの確かめ（(B2)）。見つかれば出されていた（saved・before）、なければ not-created、
 * 読めなければ unconfirmed。「確かめる」のボタンからも呼ぶ。
 */
export async function confirmCreated(findCreated: () => Promise<NoticeRow | null>, error: unknown): Promise<NoticeSaveResult> {
  try {
    const row = await findCreated();
    return row ? { type: 'saved', row, before: true } : { type: 'not-created', error };
  } catch {
    return { type: 'unconfirmed', error };
  }
}

/**
 * 直すときの forbidden（レビューの T17-R1）。save_notice の確かめの順は「書いた人 → ピン留めを変える → 楽観ロック」なので、部門長以上が
 * 間にピン留めを付け外ししたお知らせを、総務部門員が開いたときのピン留めのまま保存すると、版が古くても conflict でなく forbidden になる。
 * そのお知らせを1回読み直し、行があって版が読んだときと違えば（ほかの人が先に変えた）、中身が入力と同じなら saved（before）、違えば
 * conflict（読み直した行を入力の元にする）。版が同じ・行がない・読み直せないときは、立場が変わった forbidden（failed。今までの扱い）。
 * 行がないのを missing にしないのは、総務のまま消えたお知らせなら save_notice は not_found を返す（forbidden で行がないのは、
 * 総務でなくなって読めないとき）ため。
 */
async function settleForbiddenEdit(req: NoticeSaveRequest, base: { id: string; updatedAt: string }, error: unknown): Promise<NoticeSaveResult> {
  let row: NoticeRow | null;
  try {
    row = await req.reread();
  } catch {
    return { type: 'failed', error };
  }
  if (!row || row.updated_at === base.updatedAt) return { type: 'failed', error };
  if (sameNoticeWrite(row, req.write)) return { type: 'saved', row, before: true };
  return { type: 'conflict', row, error: appError('conflict', 'lock_conflict', { id: base.id }) };
}

/**
 * お知らせを出す・直す（2.6 の (B1)・(B2)）。
 * - 出す：応答が届かなければ confirmCreated。ほかの失敗は failed。
 * - 直す：forbidden なら settleForbiddenEdit（読み直して、版が進んでいれば conflict と同じ。レビューの T17-R1）。
 *   応答が届かなかった・conflict・not_found なら読み直して settleLockedWrite で決める：saved → saved（before）、
 *   応答が届かなかった後の not-saved・unread → unknown、止められた後の unread → unread、changed（と止められた後の not-saved）→
 *   行があれば conflict（読み直した行）、なければ missing。応答が届かなかった後の conflict・missing の error は、画面が文言を出せるよう
 *   conflict・not_found の AppError にする（rpc の文言は save_notice）。ほかの失敗は failed。
 */
export async function runNoticeSave(req: NoticeSaveRequest, onAuthError: AuthErrorHandler): Promise<NoticeSaveResult> {
  const sent = await sendWithAuth(req.send, onAuthError);
  if (sent.ok) return { type: 'saved', row: sent.value, before: false };
  const error = sent.error;
  const unknown = isUnknownOutcome(error);
  const base = req.base;
  if (!base) return unknown ? confirmCreated(req.findCreated, error) : { type: 'failed', error };
  if (classifyError(error).kind === 'forbidden') return settleForbiddenEdit(req, base, error);
  if (!unknown && !isLockRejection(error)) return { type: 'failed', error };

  const read: { row: NoticeRow | null } = { row: null };
  const outcome = await settleLockedWrite<NoticeRow>({
    reread: async () => {
      read.row = await req.reread();
      return read.row;
    },
    matches: (row) => sameNoticeWrite(row, req.write),
    baseVersion: base.updatedAt,
    versionOf: (row) => row.updated_at,
  });
  if (outcome === 'saved' && read.row) return { type: 'saved', row: read.row, before: true };
  if (unknown && (outcome === 'not-saved' || outcome === 'unread')) return { type: 'unknown', error };
  if (outcome === 'unread') return { type: 'unread', error };
  if (read.row) return { type: 'conflict', row: read.row, error: unknown ? appError('conflict', 'lock_conflict', { id: base.id }) : error };
  return { type: 'missing', error: unknown ? appError('not_found', 'notice_missing', { id: base.id }) : error };
}

export interface NoticeRereadRequest {
  /** 止められた保存の入力の元（id と読んだときの updated_at の文字列） */
  base: { id: string; updatedAt: string };
  /** 今の入力（読み直した行と sameNoticeWrite で比べる）。確かめを通らなければ null（入力と同じとは見ない） */
  write: NoticeWrite | null;
  /** そのお知らせを1行読む（なければ null。失敗したら投げる） */
  reread: () => Promise<NoticeRow | null>;
}

/**
 * 直すのが止められた後に読み直せなかった（unread）ときの「読み直す」（2.6 の (B1) の 3。04「お知らせ一覧」のエラー。締切と予定の
 * rereadRejectedSave〔T18〕と同じ形。マージの後の直し）：そのお知らせを1回読み直し、runNoticeSave の止められたときの道と同じに決める
 * （settleLockedWrite）。入力（write）と同じなら saved（before）、行があれば conflict（読み直した行を入力の元にする。次の保存はその版で
 * 送る）、なければ missing、また読み直せなければ unread（版は進めない）。
 * 一覧の読み直しでは入力の元の版を進めない（利用者が見ていない版で上書きしない）ので、ダイアログの「読み直す」はここを通す。
 */
export async function rereadRejectedNoticeSave(req: NoticeRereadRequest): Promise<NoticeSaveResult> {
  const read: { row: NoticeRow | null } = { row: null };
  const outcome = await settleLockedWrite<NoticeRow>({
    reread: async () => {
      read.row = await req.reread();
      return read.row;
    },
    matches: (row) => req.write !== null && sameNoticeWrite(row, req.write),
    baseVersion: req.base.updatedAt,
    versionOf: (row) => row.updated_at,
  });
  const id = req.base.id;
  if (outcome === 'unread') return { type: 'unread', error: appError('conflict', 'lock_conflict', { id }) };
  if (outcome === 'saved' && read.row) return { type: 'saved', row: read.row, before: true };
  return read.row
    ? { type: 'conflict', row: read.row, error: appError('conflict', 'lock_conflict', { id }) }
    : { type: 'missing', error: appError('not_found', 'notice_missing', { id }) };
}

/** 消すの結果 */
export type NoticeDeleteResult =
  /** 消えた。before は、止められた（forbidden・conflict・not_found）が読み直すともうなかった（すでに削除されていた） */
  | { type: 'deleted'; before: boolean }
  /** 読み直すと版が違った（ほかの人が先に変えた）。内容を確かめてから、もう一度削除してもらう */
  | { type: 'changed'; row: NoticeRow; error: unknown }
  /** 応答が届かず、消せたか分からない（版は読んだときのまま・読み直せなかった） */
  | { type: 'unknown'; error: unknown }
  /** そのほかの失敗（forbidden で行があり版も同じ・invalid_state・deadlock など。effectOf のとおり） */
  | { type: 'failed'; error: unknown };

export interface NoticeDeleteRequest {
  send: () => Promise<void>;
  /** そのお知らせを1行読む（なければ null。失敗したら投げる） */
  reread: () => Promise<NoticeRow | null>;
  /** 読んだときの updated_at（送った版） */
  baseVersion: string;
}

/**
 * お知らせを消す（2.6 の (B1)）。応答が届かなかった・forbidden・conflict・not_found なら、そのお知らせを読み直す：
 * なければ deleted（応答が届かなかったときは消せた、止められたときはすでに削除されていた）、あって版が違えば changed、
 * 版が同じなら、応答が届かなかったときは unknown、止められたときは failed（今の forbidden などの扱い）。
 * 読み直せなければ、応答が届かなかったときは unknown、止められたときは failed。
 */
export async function runNoticeDelete(req: NoticeDeleteRequest, onAuthError: AuthErrorHandler): Promise<NoticeDeleteResult> {
  const sent = await sendWithAuth(req.send, onAuthError);
  if (sent.ok) return { type: 'deleted', before: false };
  const error = sent.error;
  const unknown = isUnknownOutcome(error);
  const kind = classifyError(error).kind;
  if (!unknown && kind !== 'forbidden' && kind !== 'conflict' && kind !== 'not_found') return { type: 'failed', error };
  let row: NoticeRow | null;
  try {
    row = await req.reread();
  } catch {
    return unknown ? { type: 'unknown', error } : { type: 'failed', error };
  }
  if (!row) return { type: 'deleted', before: !unknown };
  if (row.updated_at !== req.baseVersion) return { type: 'changed', row, error };
  return unknown ? { type: 'unknown', error } : { type: 'failed', error };
}
