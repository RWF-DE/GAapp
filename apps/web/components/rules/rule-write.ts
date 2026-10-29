// ルールの書き込み（シートの追加・更新と、一覧の有効・無効の切り替え）の送信とエラーの分け方（画面の設計 2.5・2.6 の (B1)。T12）。
// rules への insert は (year_id, code) が一意、update は updated_at の楽観ロック（updateWithLock）なので、送り直しても DB が二重の書き込みを止める。
// 確かめるためだけの状態（「確かめる」のボタン・押せなくした保存のボタン・送った値の控え）は持たず、
// 応答が届かなかったとき（isUnknownOutcome）と、conflict・not_found・23505 で止められたとき（isLockRejection）に、
// 対象の行（insert は (year_id, code)、update は id）を1回読み直して settleLockedWrite で決める。
import { toast } from 'sonner';
import { isLockRejection, settleLockedWrite } from '@/lib/data/locked-save';
import { sameRuleWrite, type RuleFieldErrors, type RuleWrite } from '@/lib/data/rules';
import type { RuleDbRow } from '@/lib/db/types';
import { appError, classifyError, effectOf, isUnknownOutcome, unknownOutcomeMessage } from '@/lib/errors';

/**
 * 保存の結果。失敗は入力を残す。
 * - fieldErrors：欄の下に出すもの（コードの重複など）。
 * - notice：ErrorBanner の代わりに出す文言（保存できたか分からない・止められた後に読み直せなかった）。showReload なら「読み直す」も出す。
 * - rebase：止められた後（と、応答が届かず版が進んでいたとき）に読み直した行。シートはこの行の版を入力の元にする
 *   （null は行がなくなっていた。undefined は読み直していない・読み直せなかった）。
 */
export type SaveOutcome =
  | { ok: true }
  | { ok: false; error: unknown; fieldErrors?: RuleFieldErrors; notice?: string; showReload?: boolean; rebase?: RuleDbRow | null };

/** 1つの書き込み */
export interface RuleWriteRequest {
  /** insert は一意のキー (year_id, code)、update は id で読み直す（reread に渡す読み方を決めるのは呼ぶ側） */
  mode: 'insert' | 'update';
  /** 送る。失敗したら投げる */
  send: () => Promise<unknown>;
  /** 対象の行を1行読む（なければ null。失敗したら投げる） */
  reread: () => Promise<RuleDbRow | null>;
  /** 書く列と値（読み直した行と sameRuleWrite で比べる） */
  input: Partial<RuleWrite>;
  /** 入力の元の版（update は送る版の updated_at、insert は null） */
  baseVersion: string | null;
  /** 成功したときの toast */
  okMessage: string;
}

export interface RuleWriteDeps {
  /** 成功の後に関係するクエリを読み直す */
  afterSaved: () => Promise<void>;
  /** 401 なら1回だけセッションを更新する（'retry' なら送り直す） */
  onAuthError: (e: unknown) => Promise<'retry' | 'signedOut' | 'other'>;
  /** 一覧（その画面のデータ）を読み直す */
  onReload: () => void;
  /** 年度の行と立場を読み直す */
  reloadMembership: () => void;
}

/** 応答が届かなかった・止められた書き込みが、読み直すと保存されていたとき */
export const SAVED_BEFORE_MESSAGE = '保存されていました';
/** insert の 23505（と、応答が届かず同じコードの違う行ができていたとき） */
export const DUPLICATE_CODE_MESSAGE = '同じコードのルールがあります';
/** conflict・not_found・23505 で止められた後に、対象の行を読み直せなかったとき（「読み直しました」とは言わない） */
export const REREAD_FAILED_MESSAGE = 'ほかの人が先に変えた可能性がありますが、読み直せませんでした。「読み直す」を押してから、もう一度保存してください';

/**
 * 書き込みを送り、エラーを分ける（2.5・2.6 の (B1)）。401 は1回だけセッションを更新して送り直す。
 * - 応答が届かなかった（isUnknownOutcome）・conflict・not_found・23505（isLockRejection）：対象の行を読み直して settleLockedWrite で決める。
 *   saved → 「保存されていました」（成功と同じ）。
 *   応答が届かなかった後の not-saved・unread → unknownOutcomeMessage()（保存のボタンは押せるまま。次の保存はふつうに送る）。
 *   止められた後の unread → REREAD_FAILED_MESSAGE と「読み直す」。
 *   changed（と、止められた後の not-saved）→ 一覧を読み直し、insert と 23505 は DUPLICATE_CODE_MESSAGE、
 *   update は conflict（応答が届かなかった後は conflict・not_found の AppError を作る）と読み直した行（rebase）。
 * - それ以外：effectOf のとおり読み直し、入力を残す。
 */
export async function runRuleWrite(w: RuleWriteRequest, deps: RuleWriteDeps): Promise<SaveOutcome> {
  const succeed = async (message: string): Promise<SaveOutcome> => {
    await deps.afterSaved();
    toast.success(message);
    return { ok: true };
  };
  let error: unknown;
  try {
    await w.send();
    return await succeed(w.okMessage);
  } catch (e) {
    error = e;
  }
  if ((await deps.onAuthError(error)) === 'retry') {
    try {
      await w.send();
      return await succeed(w.okMessage);
    } catch (e) {
      error = e;
    }
  }

  const unknown = isUnknownOutcome(error);
  if (unknown || isLockRejection(error)) {
    // 読み直した行（settleLockedWrite の中で読む。changed のときに入力の元にする）
    const read: { row: RuleDbRow | null } = { row: null };
    const outcome = await settleLockedWrite<RuleDbRow>({
      reread: async () => {
        read.row = await w.reread();
        return read.row;
      },
      matches: (row) => sameRuleWrite(row, w.input),
      baseVersion: w.baseVersion,
      versionOf: (row) => row.updated_at,
    });
    if (outcome === 'saved') return succeed(SAVED_BEFORE_MESSAGE);
    if (unknown && (outcome === 'not-saved' || outcome === 'unread')) return { ok: false, error, notice: unknownOutcomeMessage() };
    if (outcome === 'unread') return { ok: false, error, notice: REREAD_FAILED_MESSAGE, showReload: true };
    // changed（と、止められた後の not-saved）：今までの conflict の扱い。一覧を読み直し、入力を残す
    deps.onReload();
    if (w.mode === 'insert' || classifyError(error).code === '23505') {
      return { ok: false, error, fieldErrors: { code: [DUPLICATE_CODE_MESSAGE] } };
    }
    const shown = unknown
      ? read.row
        ? appError('conflict', 'lock_conflict', { table: 'rules' })
        : appError('not_found', 'lock_missing', { table: 'rules' })
      : error;
    return { ok: false, error: shown, rebase: read.row };
  }

  const effect = effectOf(classifyError(error));
  if (effect.reload === 'data') deps.onReload();
  if (effect.reload === 'year') {
    deps.onReload();
    deps.reloadMembership();
  }
  return { ok: false, error };
}

/** 有効・無効の切り替え（一覧の toast で知らせる）の失敗の文言 */
export function toggleFailureMessage(out: Extract<SaveOutcome, { ok: false }>, message: (e: unknown) => string): string {
  if (out.notice) return out.notice;
  if (out.fieldErrors?.code?.[0]) return out.fieldErrors.code[0];
  return message(out.error);
}
