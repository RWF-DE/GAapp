// ルールの書き込み（シートの追加・更新と、一覧の有効・無効の切り替え）の送信とエラーの分け方（画面の設計 2.5・2.6 の (B1)。T12）。
// rules への insert は (year_id, code) が一意、update は updated_at の楽観ロック（updateWithLock）なので、送り直しても DB が二重の書き込みを止める。
// 確かめるためだけの状態（「確かめる」のボタン・押せなくした保存のボタン・送った値の控え）は持たず、
// 応答が届かなかったとき（isUnknownOutcome）と、conflict・not_found・23505 で止められたとき（isLockRejection）に、
// 対象の行（insert は (year_id, code)、update は id）を1回読み直して settleLockedWrite で決める。
// 止められた後に読み直せなかった（unread）ときの「読み直す」は、押したときの入力が書く行（更新は id、追加は押したときのコード）を
// 読み直して止められた後と同じに決める（SaveOutcome の reread。締切と予定〔T18〕の rereadRejectedSave と同じ形。マージの後の直し）。
// 読み直した行から止めるものが分からないとき（追加でそのコードの行がない、更新で版が入力の元のまま）は、重複・衝突とは言わない
// （'not-saved'。知らせはマスタ設定〔T09〕の「読み直す」の not-saved と同じ文。FU2 のレビューの F1）。
import { toast } from 'sonner';
import { isLockRejection, settleLockedWrite } from '@/lib/data/locked-save';
import { sameRuleWrite, type RuleFieldErrors, type RuleWrite } from '@/lib/data/rules';
import type { RuleDbRow } from '@/lib/db/types';
import { appError, classifyError, effectOf, isUnknownOutcome, unknownOutcomeMessage } from '@/lib/errors';

/**
 * 保存の結果。失敗は入力を残す。
 * - fieldErrors：欄の下に出すもの（コードの重複など）。
 * - notice：ErrorBanner の代わりに出す文言（保存できたか分からない・止められた後に読み直せなかった）。showReload なら「読み直す」も出す。
 * - reread：止められた後に読み直せなかった（showReload）ときの「読み直す」。押したときの入力が書く行を読み直して決める（RuleReread）。
 * - rebase：止められた後（と、応答が届かず版が進んでいたとき）に読み直した行。シートはこの行の版を入力の元にする
 *   （null は行がなくなっていた。undefined は読み直していない・読み直せなかった）。
 */
export type SaveOutcome =
  | { ok: true }
  | {
      ok: false;
      error: unknown;
      fieldErrors?: RuleFieldErrors;
      notice?: string;
      showReload?: boolean;
      reread?: RuleReread;
      rebase?: RuleDbRow | null;
    };

/**
 * 止められた後に読み直せなかった（unread）ときの「読み直す」：押したときの入力が書く行を1回読み直し、止められた後の読み直しと
 * 同じに決める（rereadRejectedRuleWrite）。input は押したときの入力（読み直した行と sameRuleWrite で比べる。確かめを通らなければ
 * null で、入力と同じとは見ない）。
 */
export type RuleReread = (input: Partial<RuleWrite> | null) => Promise<RuleRereadOutcome>;

/**
 * 「読み直す」（RuleReread）の結果。
 * - SaveOutcome：{ ok: true } は「保存されていました」（閉じる）。失敗は止められた後と同じ出し方（コードの重複・conflict と読み直した行・not_found）。
 * - 'not-saved'：読み直した行からは、押したときの入力を止めるものが分からない（追加でそのコードの行がない・入力が確かめを通らない、
 *   更新で版が入力の元のまま〔ほかのルールのコードに変えて 23505 で止められたときなど〕）。重複・衝突とは言わず、知らせを消して
 *   REREAD_NOT_SAVED_MESSAGE を toast で出す（入力の元の版は進めない。次の保存はふつうに送り、また止められればそのときに決める）。
 * - null：また読み直せなかった（知らせて、版を進めない）。
 */
export type RuleRereadOutcome = SaveOutcome | 'not-saved' | null;

/**
 * 対象の行を1行読む（なければ null。失敗したら投げる）。insert は code の (year_id, code)〔code を省くと送ったコード〕、update は id で読む
 * （code は使わない）。code を渡すのは、止められた後に読み直せなかったときの「読み直す」が、押したときの入力のコードの行を読むとき
 */
export type RuleRowReader = (code?: string) => Promise<RuleDbRow | null>;

/** 1つの書き込み */
export interface RuleWriteRequest {
  /** insert は一意のキー (year_id, code)、update は id で読み直す（reread に渡す読み方を決めるのは呼ぶ側） */
  mode: 'insert' | 'update';
  /** 送る。失敗したら投げる */
  send: () => Promise<unknown>;
  /** 対象の行を1行読む（insert は code〔省くと送ったコード〕の行、update は id の行。なければ null。失敗したら投げる） */
  reread: RuleRowReader;
  /** 書く列と値（読み直した行と sameRuleWrite で比べる） */
  input: Partial<RuleWrite>;
  /** 入力の元の版（update は送る版の updated_at、insert は null） */
  baseVersion: string | null;
  /** 成功したときの toast */
  okMessage: string;
  /** 保存できたか分からない・止められた後に読み直せなかったときの文言（操作に合わせる。省くとシートの「保存」の文言） */
  notices?: RuleWriteNotices;
}

/** 保存できたか分からない（unknownOutcome）・止められた後に読み直せなかった（rereadFailed）ときの文言 */
export interface RuleWriteNotices {
  unknownOutcome: string;
  rereadFailed: string;
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
/** 「読み直す」でもまた読み直せなかった（知らせと「読み直す」は残す。締切と予定〔T18〕と同じ文） */
export const REREAD_AGAIN_FAILED_MESSAGE = 'まだ読み直せませんでした。通信を確かめてから、もう一度「読み直す」を押してください（入力は残してあります）';
/**
 * 「読み直す」で、押したときの入力を止めるものが読み直した行から分からなかった（RuleRereadOutcome の 'not-saved'）。toast で出す
 * （マスタ設定〔T09〕の「読み直す」と同じ文）
 */
export const REREAD_NOT_SAVED_MESSAGE = '読み直しました。まだ保存されていません（もう一度「保存」を押してください）';

/** シートの「保存」（既定） */
export const SAVE_NOTICES: RuleWriteNotices = { unknownOutcome: unknownOutcomeMessage(), rereadFailed: REREAD_FAILED_MESSAGE };
/**
 * 一覧の有効・無効の切り替え（Switch）。「保存」のボタンはないので、切り替えの操作に合わせる
 * （lib/errors.ts の unknownOutcomeMessage は動詞が「〜できたか」「「〜」を押すと」の形なので、ここで作る）
 */
export const TOGGLE_NOTICES: RuleWriteNotices = {
  unknownOutcome: '切り替えられたか分かりません。もう一度切り替えると、確かめてから送ります',
  rereadFailed: 'ほかの人が先に変えた可能性がありますが、読み直せませんでした。「読み直す」を押してから、もう一度切り替えてください',
};
/**
 * 「無効にする」のダイアログ。止められた後に読み直せなかったとき（unread）、ダイアログの入力の元（版）は開いたときのまま
 * （一覧の「読み直す」では変えない）。押し直すと開いたときの版で送り、版が進んでいれば DB が conflict で止め、読み直して決める
 */
export const DISABLE_NOTICES: RuleWriteNotices = {
  unknownOutcome: '無効にできたか分かりません。もう一度「無効にする」を押すと、確かめてから送ります',
  rereadFailed: 'ほかの人が先に変えた可能性がありますが、読み直せませんでした。もう一度「無効にする」を押すと、ほかの人の変更を確かめます',
};

/** 無効にするダイアログを開いたままにするときの知らせ（showReload なら「読み直す」も出す） */
export interface DisableFailure {
  message: string;
  showReload?: boolean;
}

/**
 * 「無効にする」のダイアログが、runRuleWrite の失敗をどう扱うか（2.6 の (B1)）。判定の結果（SaveOutcome の rebase）だけで決める。
 * - rebase：changed（読み直した行がある）。閉じずに、読み直した行を入力の元にし（版を進める）、メモの入力を残して、今の行をダイアログの中に知らせる
 *   （シートと同じ。もう一度押すと、ほかの人の変更を見た後の、その版での意図した上書き）。
 * - close：行がなくなっていた（rebase が null）。閉じて toast で知らせる。
 * - keep：それ以外（保存できたか分からない・止められた後に読み直せなかった・forbidden など）。入力の元を変えずに開いたまま知らせる。
 */
export type DisableFailureAction =
  | { type: 'rebase'; row: RuleDbRow; failure: DisableFailure }
  | { type: 'close'; message: string }
  | { type: 'keep'; failure: DisableFailure };

/** 知らせに出す今のメモの長さ（メモは 2000 字まで書けるので、知らせでは縮める） */
const MEMO_PREVIEW = 60;

export function disableFailureAction(out: Extract<SaveOutcome, { ok: false }>, message: (e: unknown) => string): DisableFailureAction {
  if (out.rebase === null) return { type: 'close', message: message(out.error) };
  if (out.rebase) {
    const row = out.rebase;
    const memo = row.memo ? `「${row.memo.length > MEMO_PREVIEW ? `${row.memo.slice(0, MEMO_PREVIEW)}…` : row.memo}」` : 'なし';
    return {
      type: 'rebase',
      row,
      failure: {
        message: `${message(out.error)}（今は${row.enabled ? '有効' : '無効'}、メモ：${memo}）。もう一度「無効にする」を押すと、入力したメモで上書きします`,
      },
    };
  }
  return { type: 'keep', failure: { message: toggleFailureMessage(out, message), showReload: out.showReload } };
}

/**
 * 書き込みを送り、エラーを分ける（2.5・2.6 の (B1)）。401 は1回だけセッションを更新して送り直す。
 * - 応答が届かなかった（isUnknownOutcome）・conflict・not_found・23505（isLockRejection）：対象の行を読み直して settleLockedWrite で決める。
 *   saved → 「保存されていました」（成功と同じ）。
 *   応答が届かなかった後の not-saved・unread → notices.unknownOutcome（既定は unknownOutcomeMessage()。保存のボタンは押せるまま。次の保存はふつうに送る）。
 *   止められた後の unread → notices.rereadFailed（既定は REREAD_FAILED_MESSAGE）と「読み直す」。
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
    const notices = w.notices ?? SAVE_NOTICES;
    if (unknown && (outcome === 'not-saved' || outcome === 'unread')) return { ok: false, error, notice: notices.unknownOutcome };
    if (outcome === 'unread') {
      return {
        ok: false,
        error,
        notice: notices.rereadFailed,
        showReload: true,
        reread: (input) => rereadRejectedRuleWrite({ mode: w.mode, reread: w.reread, input, baseVersion: w.baseVersion }, deps),
      };
    }
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

export interface RuleRereadRequest {
  /** insert は (year_id, code)、update は id で読み直す（止められた書き込みと同じ reread） */
  mode: 'insert' | 'update';
  /** 対象の行を1行読む（insert は code〔省くと止められた追加のコード〕の行、update は id の行。なければ null。失敗したら投げる） */
  reread: RuleRowReader;
  /** 押したときの入力（読み直した行と sameRuleWrite で比べる）。確かめを通らなければ null（入力と同じとは見ない） */
  input: Partial<RuleWrite> | null;
  /** 入力の元の版（update は止められた保存の版、insert は null） */
  baseVersion: string | null;
}

/**
 * 止められた後に読み直せなかった（unread）ときの「読み直す」（2.6 の (B1) の 3。締切と予定〔T18〕の rereadRejectedSave と同じ形）：
 * 押したときの入力が書く行を1回読み直し、runRuleWrite の止められたときの道と同じに決める（settleLockedWrite）。
 * insert が読むのは押したときの入力のコードの行（コードを変えていれば、止められた結果〔23505〕は前のコードの行のもので、いまの入力には
 * 当たらない。マスタ設定〔T09〕の「読み直す」の target と同じ考え。入力が確かめを通らなければ、止められた追加のコードの行）。
 * - 入力と同じ → 「保存されていました」（成功と同じ。関係するクエリを読み直す）。
 * - insert：押したときの入力のコードに入力と違うルールがある → コードの重複（本当にある重複）。その行がない（コードは空いている）・
 *   入力が確かめを通らない（いまのコードが分からない）→ 'not-saved'（重複とは言わない。FU2 のレビューの F1）。
 * - update：版が進んでいれば conflict と読み直した行（rebase。シートはこの版を入力の元にし、次の1回の保存で上書きできる）、
 *   行がなければ not_found（rebase は null。シートは「保存」を押せなくする）。版が入力の元のまま（誰も変えていない。ほかのルールの
 *   コードに変えて 23505 で止められたときなど）→ 'not-saved'（衝突とは言わず、版も進めない）。
 * - 入力と同じでなければ、どれも一覧を読み直す（コードの重複は、次の保存の前の確かめでも見つかる）。
 * - また読み直せなければ null（一覧も読み直さない。シートは知らせて、版を進めない）。
 * 一覧の読み直しでは入力の元の版を進めない（利用者が見ていない版で上書きしない）ので、シートの「読み直す」はここを通す。
 */
export async function rereadRejectedRuleWrite(w: RuleRereadRequest, deps: Pick<RuleWriteDeps, 'afterSaved' | 'onReload'>): Promise<RuleRereadOutcome> {
  // insert は押したときの入力のコード（確かめを通らなければ undefined で、止められた追加のコード）の行を読む。update は id で読む
  const code = w.mode === 'insert' ? w.input?.code : undefined;
  const read: { row: RuleDbRow | null } = { row: null };
  const outcome = await settleLockedWrite<RuleDbRow>({
    reread: async () => {
      read.row = await w.reread(code);
      return read.row;
    },
    matches: (row) => w.input !== null && sameRuleWrite(row, w.input),
    baseVersion: w.baseVersion,
    versionOf: (row) => row.updated_at,
  });
  if (outcome === 'unread') return null;
  if (outcome === 'saved') {
    await deps.afterSaved();
    toast.success(SAVED_BEFORE_MESSAGE);
    return { ok: true };
  }
  // 入力と違う：一覧を読み直し、入力を残す
  deps.onReload();
  if (w.mode === 'insert') {
    return read.row && code !== undefined
      ? { ok: false, error: appError('conflict', 'lock_conflict', { table: 'rules' }), fieldErrors: { code: [DUPLICATE_CODE_MESSAGE] } }
      : 'not-saved';
  }
  if (outcome === 'not-saved') return 'not-saved';
  return read.row
    ? { ok: false, error: appError('conflict', 'lock_conflict', { table: 'rules' }), rebase: read.row }
    : { ok: false, error: appError('not_found', 'lock_missing', { table: 'rules' }), rebase: null };
}

/** 有効・無効の切り替え（一覧の toast で知らせる）の失敗の文言 */
export function toggleFailureMessage(out: Extract<SaveOutcome, { ok: false }>, message: (e: unknown) => string): string {
  if (out.notice) return out.notice;
  if (out.fieldErrors?.code?.[0]) return out.fieldErrors.code[0];
  return message(out.error);
}
