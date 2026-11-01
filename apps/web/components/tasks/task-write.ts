// 作業の書き込みの送信と、応答が届かなかったとき・止められたときの決め方（画面の設計 2.6 の (B1)。04「作業一覧」のエラーと読み直し、
// notes/T20.md「画面の約束」3・7。T20）。画面（ダイアログ・削除の確かめ・状態のボタン）は結果の種類で出し方を決める。
// - 作るのは画面が作った id で insert するので一意のキーのある insert、直す・消すは updated_at の楽観ロック、状態は楽観ロックの RPC
//   （set_task_status。ミリ秒までで比べる）。どれも (B1)：応答が届かなかったその場と、DB に止められたとき（作るときの 23505、直すときの
//   conflict・not_found、状態の conflict）に、その作業を1回読み直して決める。確かめるためだけの状態は持たない（もう一度の送信は同じ id・
//   同じ updated_at でふつうに送り、前の送信が通っていれば DB が止める）。
// - 権限か年度の状態が変わった（42501・lock_unchanged・forbidden・invalid_state）は読み直さない（failed。画面が年度の行と立場を読み直す）。
// 401 は1回だけセッションを更新して送り直す（ほかの画面と同じ）。締切と予定の event-write.ts と同じ決め方。
import type { TaskStatus } from '@/lib/modules/shifts/labels';
import { isLockRejection, settleLockedWrite } from '@/lib/data/locked-save';
import type { TaskRow } from '@/lib/data/tasks';
import { classifyError, isUnknownOutcome } from '@/lib/errors';

/** 401 の扱い（lib/auth/guarded.ts の useAuthErrorHandler） */
export type AuthErrorHandler = (e: unknown) => Promise<'retry' | 'signedOut' | 'other'>;

/** 作る・直すの結果 */
export type TaskSaveResult =
  /** 保存できた。before は、応答が届かなかった・止められたが、読み直すと送った値になっていた（作られていた・保存されていた） */
  | { type: 'saved'; row: TaskRow; before: boolean }
  /** ほかの人が先に変えた（直すときの conflict、作るときの 23505 で読み直すと入力と違う）。row を入力の元にして入力を残す */
  | { type: 'conflict'; row: TaskRow }
  /** 直す：作業が消えていた（読み直してもない） */
  | { type: 'missing' }
  /** 応答が届かず保存できたか分からない（作るときは、止められた後に行がない・読み直せないときも）。入力を残し、もう一度押せる */
  | { type: 'unknown' }
  /** 直す：止められた後に読み直せなかった（「読み直しました」とは言わない。ダイアログの「読み直す」は rereadRejectedTaskSave） */
  | { type: 'unread' }
  /** そのほかの失敗（forbidden・not_soumu・CHECK・deadlock・認証など。effectOf のとおり） */
  | { type: 'failed'; error: unknown };

export interface TaskSaveRequest {
  /** 直すときの入力の元の版（読んだときの updated_at の文字列）。作るときは null */
  baseVersion: string | null;
  /**
   * 読み直した行が送った値と同じか（ダイアログが lib/schemas/tasks.ts の sameTaskWrite で渡す。この部品は状態のボタンと一緒に総務部門員の
   * /tasks の JS に入るので、入力の zod を読まない）
   */
  matches: (row: TaskRow) => boolean;
  send: () => Promise<TaskRow>;
  /** その作業（作るときはダイアログで作った id）を1行読む（なければ null。失敗したら投げる） */
  reread: () => Promise<TaskRow | null>;
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
 * 作る・直す（2.6 の (B1)）。応答が届かなかった（isUnknownOutcome）か、止められた（isLockRejection：作るときの 23505、直すときの
 * conflict・not_found）なら、その作業を読み直して settleLockedWrite で決める（締切と予定の runEventSave と同じ）。
 */
export async function runTaskSave(req: TaskSaveRequest, onAuthError: AuthErrorHandler): Promise<TaskSaveResult> {
  const sent = await sendWithAuth(req.send, onAuthError);
  if (sent.ok) return { type: 'saved', row: sent.value, before: false };
  const error = sent.error;
  const unknown = isUnknownOutcome(error);
  if (!unknown && !isLockRejection(error)) return { type: 'failed', error };

  const read: { row: TaskRow | null } = { row: null };
  const outcome = await settleLockedWrite<TaskRow>({
    reread: async () => {
      read.row = await req.reread();
      return read.row;
    },
    matches: req.matches,
    baseVersion: req.baseVersion,
    versionOf: (row) => row.updated_at,
  });
  if (outcome === 'saved' && read.row) return { type: 'saved', row: read.row, before: true };
  if (req.baseVersion === null) {
    return outcome === 'changed' && read.row ? { type: 'conflict', row: read.row } : { type: 'unknown' };
  }
  if (unknown && (outcome === 'not-saved' || outcome === 'unread')) return { type: 'unknown' };
  if (outcome === 'unread') return { type: 'unread' };
  return read.row ? { type: 'conflict', row: read.row } : { type: 'missing' };
}

/**
 * 直すのが止められた後に読み直せなかった（unread）ときの「読み直す」：その作業を1回読み直し、止められたときの道と同じに決める
 * （締切と予定の rereadRejectedSave と同じ。一覧の読み直しでは入力の元の版を進めない）。
 */
export async function rereadRejectedTaskSave(req: {
  baseVersion: string;
  /** 今の入力と同じか（確かめを通らない入力は null で、同じとは見ない） */
  matches: ((row: TaskRow) => boolean) | null;
  reread: () => Promise<TaskRow | null>;
}): Promise<TaskSaveResult> {
  const read: { row: TaskRow | null } = { row: null };
  const outcome = await settleLockedWrite<TaskRow>({
    reread: async () => {
      read.row = await req.reread();
      return read.row;
    },
    matches: (row) => req.matches !== null && req.matches(row),
    baseVersion: req.baseVersion,
    versionOf: (row) => row.updated_at,
  });
  if (outcome === 'unread') return { type: 'unread' };
  if (outcome === 'saved' && read.row) return { type: 'saved', row: read.row, before: true };
  return read.row ? { type: 'conflict', row: read.row } : { type: 'missing' };
}

/** 消すの結果 */
export type TaskDeleteResult =
  /** 消えた。before は、止められた（not_found）が読み直すともうなかった */
  | { type: 'deleted'; before: boolean }
  /** 版が違った（ほかの人が先に変えた） */
  | { type: 'changed' }
  /** 応答が届かず、消せたか分からない */
  | { type: 'unknown' }
  | { type: 'failed'; error: unknown };

/** 消す（2.6 の (B1)。締切と予定の runEventDelete と同じ） */
export async function runTaskDelete(
  req: { send: () => Promise<unknown>; reread: () => Promise<TaskRow | null>; baseVersion: string },
  onAuthError: AuthErrorHandler,
): Promise<TaskDeleteResult> {
  const sent = await sendWithAuth(req.send, onAuthError);
  if (sent.ok) return { type: 'deleted', before: false };
  const error = sent.error;
  if (!isUnknownOutcome(error)) {
    const kind = classifyError(error).kind;
    if (kind === 'not_found') return { type: 'deleted', before: true };
    if (kind === 'conflict') return { type: 'changed' };
    return { type: 'failed', error };
  }
  let row: TaskRow | null;
  try {
    row = await req.reread();
  } catch {
    return { type: 'unknown' };
  }
  if (!row) return { type: 'deleted', before: false };
  return row.updated_at !== req.baseVersion ? { type: 'changed' } : { type: 'unknown' };
}

/** 状態のボタンの結果 */
export type TaskStatusResult =
  /** 変えた。before は、止められた・応答が届かなかったが、読み直すと押した状態になっていた（保存されていました） */
  | { type: 'saved'; row: TaskRow; before: boolean }
  /** ほかの人が先に変えた（読み直した今の行。読み直せなければ null） */
  | { type: 'conflict'; row: TaskRow | null }
  /** 作業が消えていた */
  | { type: 'missing' }
  /** 応答が届かず、版が読んだときのまま・読み直せない（もう一度押すと確かめてから送る） */
  | { type: 'unknown' }
  | { type: 'failed'; error: unknown };

/**
 * 状態を変える（set_task_status。2.6 の (B1)。04「作業一覧」の状態のボタン）：
 * - conflict：読み直し、状態が押したものなら saved（before）、違えば conflict（今の行）。
 * - 応答が届かない：読み直し、状態が押したものなら saved（before）、版が同じなら unknown、違えば conflict。読み直せなければ unknown。
 * - not_found：missing。ほか（forbidden・invalid_state など）は failed。
 */
export async function runTaskStatus(
  req: { status: TaskStatus; baseVersion: string; send: () => Promise<TaskRow>; reread: () => Promise<TaskRow | null> },
  onAuthError: AuthErrorHandler,
): Promise<TaskStatusResult> {
  const sent = await sendWithAuth(req.send, onAuthError);
  if (sent.ok) return { type: 'saved', row: sent.value, before: false };
  const error = sent.error;
  const unknown = isUnknownOutcome(error);
  const kind = classifyError(error).kind;
  if (!unknown && kind === 'not_found') return { type: 'missing' };
  if (!unknown && kind !== 'conflict') return { type: 'failed', error };
  let row: TaskRow | null;
  try {
    row = await req.reread();
  } catch {
    return unknown ? { type: 'unknown' } : { type: 'conflict', row: null };
  }
  if (!row) return { type: 'missing' };
  if (row.status === req.status) return { type: 'saved', row, before: true };
  if (unknown && row.updated_at === req.baseVersion) return { type: 'unknown' };
  return { type: 'conflict', row };
}
