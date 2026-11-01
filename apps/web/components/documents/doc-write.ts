// 提出物の登録・変更・削除（部門長以上。画面から直接。RLS の can_lead）の送信と、応答が届かなかったとき・止められたときの決め方（画面の設計
// 2.6 の (B1)。04「提出物」の提出物の登録・変更・削除と書き込みの決まり・エラーの文言、notes/T19.md「パート B・C の約束」3・6。T19・D-55）。
// 締切と予定の event-write.ts と同じ形（確かめるためだけの状態は持たない。もう一度の送信は同じ id・同じ updated_at でふつうに送り、前の送信が
// 通っていれば DB が止める）。違いは同じ題名（unique (year_id, title)）：
// - 登録の 23505：その提出物（画面が作った id）を1回読み直し、あれば入力と比べる（同じなら登録されていた、違えば conflict。その提出物の編集に
//   切り替える）、なければ同じ題名（title_taken。04「同じ題名の提出物がこの年度にあります」）。
// - 変更の 23505：主キーは変えないので同じ題名（読み直さずに title_taken）。
// 権限か年度の状態が変わった（42501・lock_unchanged）は読み直さない（failed。画面が年度の行と立場を読み直す）。
// 401 は1回だけセッションを更新して送り直す（ほかの画面と同じ）。
import { isDocumentTitleTaken, sameDocumentWrite, type DocumentRow, type DocumentWrite } from '@/lib/data/documents';
import { isLockRejection, settleLockedWrite } from '@/lib/data/locked-save';
import { classifyError, isUnknownOutcome } from '@/lib/errors';
import { sendWithAuth, type AuthErrorHandler } from './submission-write';

/** 同じ年度に同じ題名の提出物がある（04 のエラーの文言） */
export const DOCUMENT_TITLE_TAKEN_MESSAGE = '同じ題名の提出物がこの年度にあります';

/** 登録・保存の結果 */
export type DocSaveResult =
  /** 保存できた。before は、応答が届かなかった・止められたが、読み直すと送った値になっていた（登録されていた・保存されていた） */
  | { type: 'saved'; row: DocumentRow; before: boolean }
  /**
   * ほかの人が先に変えた（保存の conflict、登録の 23505 で読み直すと同じ id の提出物が入力と違う）。row（読み直した今の行）を入力の元にして
   * 入力を残す（登録は、その提出物の編集に切り替える）
   */
  | { type: 'conflict'; row: DocumentRow }
  /** 保存：提出物が消えていた（読み直してもない） */
  | { type: 'missing' }
  /** 同じ題名の提出物がこの年度にある（23505・documents_year_id_title_key。入力を残し、題名の欄に出す） */
  | { type: 'title_taken' }
  /** 応答が届かず保存できたか分からない（登録は、止められた後に行がない・読み直せないときも）。入力を残し、もう一度押せる */
  | { type: 'unknown' }
  /** 保存：止められた後に読み直せなかった（「読み直しました」とは言わない。ダイアログの「読み直す」は rereadRejectedDocSave） */
  | { type: 'unread' }
  /** そのほかの失敗（forbidden・CHECK・deadlock・認証など。effectOf のとおり） */
  | { type: 'failed'; error: unknown };

export interface DocSaveRequest {
  /** 保存のときの入力の元の版（読んだときの updated_at の文字列）。登録は null */
  baseVersion: string | null;
  /** 送る値（読み直した行と sameDocumentWrite で比べる） */
  write: DocumentWrite;
  /** 送る（失敗したら投げる） */
  send: () => Promise<DocumentRow>;
  /** その提出物（登録はダイアログで作った id）を1行読む（なければ null。失敗したら投げる） */
  reread: () => Promise<DocumentRow | null>;
}

/**
 * 登録・保存（2.6 の (B1)）。応答が届かなかった（isUnknownOutcome）か、止められた（登録の 23505、保存の conflict・not_found）なら、その
 * 提出物を読み直して settleLockedWrite で決める：
 * - saved → saved（before）
 * - 登録：changed（同じ id の行があり入力と違う）→ conflict。同じ id の行がない・読み直せない → 23505 が同じ題名の制約なら title_taken、
 *   ほか（応答が届かなかった・主キーの 23505 の後に行が消えた）は unknown（もう一度押すと同じ id で送る）
 * - 保存：同じ題名の 23505 は読み直さずに title_taken。応答が届かなかった後の not-saved・unread → unknown、止められた後の unread → unread、
 *   ほか（changed と、止められた後の not-saved）→ 行があれば conflict、なければ missing
 * ほかの失敗（forbidden など）は failed。
 */
export async function runDocSave(req: DocSaveRequest, onAuthError: AuthErrorHandler): Promise<DocSaveResult> {
  const sent = await sendWithAuth(req.send, onAuthError);
  if (sent.ok) return { type: 'saved', row: sent.value, before: false };
  const error = sent.error;
  const unknown = isUnknownOutcome(error);
  const titleTaken = !unknown && isDocumentTitleTaken(error);
  // 変更の 23505 は同じ題名だけ（主キーは変えない）。読み直しても決められないので、そのまま返す
  if (req.baseVersion !== null && titleTaken) return { type: 'title_taken' };
  if (!unknown && !isLockRejection(error)) return { type: 'failed', error };

  const read: { row: DocumentRow | null } = { row: null };
  const outcome = await settleLockedWrite<DocumentRow>({
    reread: async () => {
      read.row = await req.reread();
      return read.row;
    },
    matches: (row) => sameDocumentWrite(row, req.write),
    baseVersion: req.baseVersion,
    versionOf: (row) => row.updated_at,
  });
  if (outcome === 'saved' && read.row) return { type: 'saved', row: read.row, before: true };
  if (req.baseVersion === null) {
    if (outcome === 'changed' && read.row) return { type: 'conflict', row: read.row };
    // 同じ id の提出物がない・読み直せない：題名の制約で止まったなら同じ題名（主キーは題名より先に確かめられるので、重なっていない）
    if (titleTaken) return { type: 'title_taken' };
    return { type: 'unknown' };
  }
  if (unknown && (outcome === 'not-saved' || outcome === 'unread')) return { type: 'unknown' };
  if (outcome === 'unread') return { type: 'unread' };
  return read.row ? { type: 'conflict', row: read.row } : { type: 'missing' };
}

export interface DocRereadRequest {
  /** 止められた保存の入力の元の版（読んだときの updated_at の文字列） */
  baseVersion: string;
  /** 今の入力（読み直した行と sameDocumentWrite で比べる）。確かめを通らなければ null（入力と同じとは見ない） */
  write: DocumentWrite | null;
  /** その提出物を1行読む（なければ null。失敗したら投げる） */
  reread: () => Promise<DocumentRow | null>;
}

/**
 * 保存が止められた後に読み直せなかった（unread）ときの「読み直す」（2.6 の (B1) の 3。締切と予定の rereadRejectedSave と同じ）：その提出物を
 * 1回読み直し、runDocSave の止められたときの道と同じに決める。入力と同じなら saved（before）、行があれば conflict（読み直した行を入力の元にする）、
 * なければ missing、また読み直せなければ unread。一覧の読み直しでは入力の元の版を進めない（利用者が見ていない版で上書きしない）。
 */
export async function rereadRejectedDocSave(req: DocRereadRequest): Promise<DocSaveResult> {
  const read: { row: DocumentRow | null } = { row: null };
  const outcome = await settleLockedWrite<DocumentRow>({
    reread: async () => {
      read.row = await req.reread();
      return read.row;
    },
    matches: (row) => req.write !== null && sameDocumentWrite(row, req.write),
    baseVersion: req.baseVersion,
    versionOf: (row) => row.updated_at,
  });
  if (outcome === 'unread') return { type: 'unread' };
  if (outcome === 'saved' && read.row) return { type: 'saved', row: read.row, before: true };
  return read.row ? { type: 'conflict', row: read.row } : { type: 'missing' };
}

/** 削除の結果 */
export type DocDeleteResult =
  /** 消えた。before は、止められた（not_found）が読み直すともうなかった（すでに削除されていた） */
  | { type: 'deleted'; before: boolean }
  /** 版が違った（ほかの人が先に変えた）。内容を確かめてから、もう一度削除してもらう */
  | { type: 'changed' }
  /** 応答が届かず、消せたか分からない（版は読んだときのまま・読み直せなかった） */
  | { type: 'unknown' }
  /** そのほかの失敗（forbidden〔版が同じ。権限か年度の状態が変わった〕・deadlock など。effectOf のとおり） */
  | { type: 'failed'; error: unknown };

export interface DocDeleteRequest {
  send: () => Promise<unknown>;
  /** その提出物を1行読む（なければ null。失敗したら投げる） */
  reread: () => Promise<DocumentRow | null>;
  /** 読んだときの updated_at（送った版） */
  baseVersion: string;
}

/**
 * 削除（2.6 の (B1)。締切と予定の runEventDelete と同じ）。deleteChecked は 0 行を読み直して分けるので、not_found（もうない）は
 * deleted（before）、conflict（版が違う）は changed、forbidden（版が同じ）は failed。応答が届かなかったときは読み直す：ない → deleted、
 * 版が違う → changed、版が同じ・読み直せない → unknown（もう一度押すと同じ updated_at で送る）。
 */
export async function runDocDelete(req: DocDeleteRequest, onAuthError: AuthErrorHandler): Promise<DocDeleteResult> {
  const sent = await sendWithAuth(req.send, onAuthError);
  if (sent.ok) return { type: 'deleted', before: false };
  const error = sent.error;
  if (!isUnknownOutcome(error)) {
    const kind = classifyError(error).kind;
    if (kind === 'not_found') return { type: 'deleted', before: true };
    if (kind === 'conflict') return { type: 'changed' };
    return { type: 'failed', error };
  }
  let row: DocumentRow | null;
  try {
    row = await req.reread();
  } catch {
    return { type: 'unknown' };
  }
  if (!row) return { type: 'deleted', before: false };
  return row.updated_at !== req.baseVersion ? { type: 'changed' } : { type: 'unknown' };
}
